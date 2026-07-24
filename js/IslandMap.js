// IslandMap.js — procedural archipelago on a square grid, Return Fire palette.
// Terrain is split into CHUNKS (separate meshes) so large maps stay cheap: each
// chunk frustum-culls independently. Normals are computed by finite difference
// from a shared global height field, so chunk seams stay invisible.
// Exposes sampling helpers so vehicles can ask "land or water?" at a world point.

import * as THREE from 'three';
import { Noise2D } from './noise.js';
import { makeTerrainMaterial } from './TerrainMaterial.js?v=20';

const CHUNK = 48;   // cells per chunk edge
const EDGE_APRON = 8;   // outer cells deepened to open sea so the map border reads as deep blue (no shallow water at the boundary) and the mesh edge blends into the ocean plane

// Default generation params. Every one of these is exposed to the controls panel.
export const DEFAULTS = {
  seed: 1337,
  cols: 480,         // grid cells across X (bigger island → bases/FOBs spread out)
  rows: 480,         // grid cells across Z
  tile: 1.0,         // world units per cell
  noiseScale: 3.6,   // higher = more, smaller islands
  octaves: 8,
  seaLevel: 0.4,     // height threshold for land; higher = less land
  edgeFalloff: 0.5,  // pull map borders down into ocean (archipelago framing)
  heightScale: 6.0,  // vertical exaggeration of terrain (Return Fire reads fairly flat)
  beachHeight: 1.0,  // world-height band (above water) that stays sand
  grassAmount: 0.6,  // 0 = no grass blobs, 1 = grass everywhere on land
  flatLand: true,    // level ALL land to one flat plateau (no hills) — keeps roads flush, no dirt poking through
  shoreSteep: 1.0,   // underwater beach-face steepening (×depth). Was 1.6 to narrow a z-fighting shallow band vs the old water plane; the plane is gone, so 1.0 (off) gives a gentler shore + a wider, prettier shallow→deep gradient and softer coastline corners
};

// Return Fire-ish bright beach palette.
const C = {
  deep:    new THREE.Color('#0e4f78'),   // dark open-sea blue (reached at the sea floor now)
  shallow: new THREE.Color('#3bb2ba'),   // green-leaning turquoise coastal water (halfway off the old bright #3fb4d8)
  wetdark: new THREE.Color('#8a784a'),   // dark wet sand right at the waterline
  wetsand: new THREE.Color('#c9b884'),
  sand:    new THREE.Color('#dcc88c'),
  grass:   new THREE.Color('#6f8f3a'),
  grassHi: new THREE.Color('#86a64a'),
  rock:    new THREE.Color('#8d8678'),
};

// Tile type codes used by gameplay sampling.
export const TILE = { DEEP: 0, SHALLOW: 1, SAND: 2, GRASS: 3, ROCK: 4 };
// Water-floor depth at/above which a land vehicle can WADE (ford) rather than
// drown. Floors run roughly -2.4 (sea bed) to 0 (shoreline); -0.8 leaves the
// shallow coastal fringe + puddles passable while the open sea (~85%) stays deep.
// Lower (more negative) = less wadeable water; raise toward 0 to ford less.
const FORD_DEPTH = -0.8;

function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export class IslandMap {
  constructor() {
    this.group = new THREE.Group();
    this.params = { ...DEFAULTS };

    this.chunks = [];       // terrain chunk meshes
    this.water = null;

    // Shared global vertex fields (size = (cols+1)*(rows+1)).
    this._H = null;         // Float32Array world Y per vertex
    this._col = null;       // Float32Array rgb per vertex (water palette + land tint)
    this._grass = null;     // Float32Array macro grassiness 0..1 per vertex
    this._land = null;      // Float32Array 1 = land, 0 = water, per vertex
    this._grassNoise = null;
    this._terrainMat = null;

    // Per-cell classification grid (cols x rows).
    this.tileType = null;   // Uint8Array
    this.tileH = null;      // Float32Array, world Y of land surface (<=0 = underwater)

    // Flatten pads applied to terrain (filled by levelPads()).
    this.pads = [];
  }

  get worldW() { return this.params.cols * this.params.tile; }
  get worldH() { return this.params.rows * this.params.tile; }

  _clear() {
    for (const m of this.chunks) {
      this.group.remove(m);
      m.geometry.dispose();
      m.material.dispose();
    }
    this.chunks = [];
    if (this.water) {
      this.group.remove(this.water);
      this.water.geometry.dispose();
      this.water.material.dispose();
      this.water = null;
    }
    if (this.seaFloor) {
      this.group.remove(this.seaFloor);
      this.seaFloor.geometry.dispose();
      this.seaFloor.material.dispose();
      this.seaFloor = null;
    }
    if (this._terrainMat) {
      for (const t of (this._terrainMat.userData.maps || [])) t.dispose();
      this._terrainMat.dispose();
      this._terrainMat = null;
    }
  }

  // Derive a vertex's colour, land flag, and grass field from its current
  // height (this._H[vi]). Used by pass 1 and by the flatten pass.
  // yColor keys the colour + grass-splat fields; it defaults to the FINAL height, so the
  // sand/grass/water bands follow the smoothed terrain (the beach ramp), not the raw
  // noise — which kept the splat banding from making angular "steep" corners on the coast.
  _setAttribs(vi, u, v, yColor = this._H[vi]) {
    const p = this.params;
    const y = this._H[vi];                       // real (geometry) height drives the land flag
    const col = this._colorFor(yColor, u, v);
    this._col[vi * 3] = col.r;
    this._col[vi * 3 + 1] = col.g;
    this._col[vi * 3 + 2] = col.b;
    this._land[vi] = y > 0 ? 1 : 0;
    // Raw macro grassiness only — the beach height-gate (sand low / grass high) and the
    // wet-sand band are applied PER-PIXEL in the shader now, so the coast isn't faceted.
    this._grass[vi] = this._grassNoise.fbm(u * p.noiseScale * 1.5, v * p.noiseScale * 1.5, 3);
  }

  // Colour for a vertex given its world height + grass-noise sample.
  _colorFor(y, u, v) {
    if (y <= 0) {
      // Smooth depth gradient over the REAL underwater range [0 .. floor]: dark wet
      // sand at the waterline → turquoise shallows → dark blue at the sea floor. (The
      // old discrete bands gated 'deep' behind y<-2.5, which the -2.4 floor never hit,
      // so the whole sea read as flat 'shallow'.)
      const depth = -y, floor = this.params.seaLevel * this.params.heightScale;
      if (depth < 0.55) return C.wetdark.clone().lerp(C.shallow, smoothstep(0, 0.55, depth));
      return C.shallow.clone().lerp(C.deep, smoothstep(0.55, floor, depth));
    }
    if (y < this.params.beachHeight) return C.sand;
    const g = this._grassNoise.fbm(u * this.params.noiseScale * 2.0, v * this.params.noiseScale * 2.0, 4);
    if (g < 1 - this.params.grassAmount) return C.sand;
    if (y > this.params.beachHeight + 4.0) return C.rock;
    return g > 0.78 ? C.grassHi : C.grass;
  }

  // (Re)build everything from the current params (optionally patched).
  generate(patch = {}) {
    Object.assign(this.params, patch);
    const p = this.params;
    this.pads = [];
    this._clear();

    const noise = new Noise2D(p.seed);
    this._grassNoise = new Noise2D(p.seed ^ 0x9e3779b9);

    const VX = p.cols + 1, VZ = p.rows + 1;
    this._H = new Float32Array(VX * VZ);
    this._col = new Float32Array(VX * VZ * 3);
    this._grass = new Float32Array(VX * VZ);
    this._land = new Float32Array(VX * VZ);
    this._shore = new Float32Array(VX * VZ);   // wave strength 0..1: 1 at the shore, 0 far out to sea
    this._terrainMat = makeTerrainMaterial(p.seed, p.grassAmount, 7,
      { wetdark: C.wetdark, shallow: C.shallow, deep: C.deep, floor: p.seaLevel * p.heightScale });

    // Pass 1: per-vertex world height, water/land colour, and a SMOOTH macro
    // grassiness field. The crisp grass/sand edge is carved later in the shader
    // from a noise mask — keeping this field smooth is what makes that work.
    const flatLevel = p.beachHeight + 0.8;          // matches the camp pad height (padFor) → land sits flush with bases
    const floor = -p.seaLevel * p.heightScale;      // deepest terrain; the ocean match depends on water never going past this
    let vi = 0;
    for (let gz = 0; gz < VZ; gz++) {
      for (let gx = 0; gx < VX; gx++, vi++) {
        const u = gx / p.cols, v = gz / p.rows;
        let nh = noise.fbm(u * p.noiseScale, v * p.noiseScale, p.octaves);
        const dx = (u - 0.5) * 2, dz = (v - 0.5) * 2;
        const edge = smoothstep(0.35, 1.0, Math.min(1, Math.sqrt(dx * dx + dz * dz)));
        nh = Math.max(0, nh - p.edgeFalloff * edge);
        let h = (nh - p.seaLevel) * p.heightScale;
        if (h > 0) {
          // LAND → one flat plateau inland (no hills: roads stay flush), but RAMP up to
          // it from the waterline across the natural beach band instead of snapping flat
          // — so the coast is a sloped beach, not a cliff ringing the whole island.
          if (p.flatLand) h = flatLevel * smoothstep(0, p.beachHeight, h);
        } else if (p.shoreSteep > 1) {
          h = Math.max(floor, h * p.shoreSteep);    // steepen the underwater shore (narrows the z-fighting shallow band), capped at the floor
        }
        // Border apron: deepen + sink the outermost cells below the ocean plane so the
        // terrain-mesh edge hides under it and the map border reads as deep open sea.
        const bd = Math.min(gx, gz, p.cols - gx, p.rows - gz);
        if (bd < EDGE_APRON) {
          const t = Math.max(0, (bd - 2) / (EDGE_APRON - 2)), sink = floor - 0.25;
          h = sink + (h - sink) * t;
        }
        this._H[vi] = h;
        // Splat keys off the FINAL (smoothed) height, so the sand/grass/water bands
        // follow the gentle beach — not the steep raw noise, which made angular corners.
        this._setAttribs(vi, u, v);
      }
    }

    this._buildShoreField(VX, VZ);
    this._buildChunks(VX, VZ);
    this._buildWater();
    this._classify(VX, VZ);
    return this;
  }

  // Wave-strength field: 1 at the shoreline, fading to 0 far out to sea. The water
  // ripple in TerrainMaterial scales by this, so the animated waves hug the islands
  // and calm with distance from land — meeting the flat open-ocean plane seamlessly
  // (no rippled "square" at the mesh edge). Distance to the nearest land vertex comes
  // from a cheap 2-pass chamfer distance transform over the land/water mask.
  _buildShoreField(VX, VZ) {
    const n = VX * VZ, L = this._land, d = this._shore;
    const INF = 1e9, D1 = 1, D2 = Math.SQRT2;
    for (let i = 0; i < n; i++) d[i] = L[i] > 0 ? 0 : INF;
    // forward pass (top-left → bottom-right)
    for (let z = 0; z < VZ; z++) {
      for (let x = 0; x < VX; x++) {
        const i = z * VX + x; let v = d[i];
        if (x > 0)            v = Math.min(v, d[i - 1] + D1);
        if (z > 0)            v = Math.min(v, d[i - VX] + D1);
        if (x > 0 && z > 0)   v = Math.min(v, d[i - VX - 1] + D2);
        if (x < VX - 1 && z > 0) v = Math.min(v, d[i - VX + 1] + D2);
        d[i] = v;
      }
    }
    // backward pass (bottom-right → top-left)
    for (let z = VZ - 1; z >= 0; z--) {
      for (let x = VX - 1; x >= 0; x--) {
        const i = z * VX + x; let v = d[i];
        if (x < VX - 1)              v = Math.min(v, d[i + 1] + D1);
        if (z < VZ - 1)              v = Math.min(v, d[i + VX] + D1);
        if (x < VX - 1 && z < VZ - 1) v = Math.min(v, d[i + VX + 1] + D2);
        if (x > 0 && z < VZ - 1)     v = Math.min(v, d[i + VX - 1] + D2);
        d[i] = v;
      }
    }
    // Convert distance (in cells) → wave strength: full at the shore, fading to 0 by FAR
    // units out. Then multiply by an edge fade that calms the outer band of the mesh, so
    // waves are guaranteed flat by the time they reach the open-ocean plane — even where
    // an island sits near the map border (distance-from-land alone wouldn't calm those).
    const tile = this.params.tile, FAR = 40, EDGE_FADE = 36;   // FAR = how far waves reach from land; EDGE_FADE in cells
    const cols = this.params.cols, rows = this.params.rows;
    for (let z = 0; z < VZ; z++) {
      for (let x = 0; x < VX; x++) {
        const i = z * VX + x;
        const shoreF = 1 - smoothstep(0, FAR, d[i] * tile);
        const bd = Math.min(x, z, cols - x, rows - z);          // cells to the nearest mesh edge
        d[i] = shoreF * smoothstep(0, EDGE_FADE, bd);
      }
    }
  }

  // Build one mesh per CHUNK×CHUNK block of cells.
  _buildChunks(VX, VZ) {
    const p = this.params;
    for (let cz0 = 0; cz0 < p.rows; cz0 += CHUNK) {
      for (let cx0 = 0; cx0 < p.cols; cx0 += CHUNK) {
        const mesh = this._makeChunk(cx0, cz0, VX, VZ);
        this.group.add(mesh);
        this.chunks.push(mesh);
      }
    }
  }

  // Build one chunk mesh from the current global fields, tagged with its origin.
  _makeChunk(cx0, cz0, VX, VZ) {
    const p = this.params;
    const halfW = this.worldW / 2, halfH = this.worldH / 2;
    const H = this._H, COL = this._col, GRA = this._grass, LND = this._land, SHO = this._shore;
    const invTile2 = 1 / (2 * p.tile);
    const cw = Math.min(CHUNK, p.cols - cx0);
    const ch = Math.min(CHUNK, p.rows - cz0);
    const cvx = cw + 1, cvz = ch + 1;
    const pos = new Float32Array(cvx * cvz * 3);
    const col = new Float32Array(cvx * cvz * 3);
    const nor = new Float32Array(cvx * cvz * 3);
    const gra = new Float32Array(cvx * cvz);
    const lnd = new Float32Array(cvx * cvz);
    const sho = new Float32Array(cvx * cvz);

    for (let lz = 0; lz < cvz; lz++) {
      for (let lx = 0; lx < cvx; lx++) {
        const gx = cx0 + lx, gz = cz0 + lz;
        const gi = gz * VX + gx;
        const li = lz * cvx + lx;
        pos[li * 3] = gx * p.tile - halfW;
        pos[li * 3 + 1] = H[gi];
        pos[li * 3 + 2] = gz * p.tile - halfH;
        col[li * 3] = COL[gi * 3];
        col[li * 3 + 1] = COL[gi * 3 + 1];
        col[li * 3 + 2] = COL[gi * 3 + 2];
        gra[li] = GRA[gi];
        lnd[li] = LND[gi];
        sho[li] = SHO[gi];
        const xl = gx > 0 ? H[gi - 1] : H[gi];
        const xr = gx < VX - 1 ? H[gi + 1] : H[gi];
        const zl = gz > 0 ? H[gi - VX] : H[gi];
        const zr = gz < VZ - 1 ? H[gi + VX] : H[gi];
        const nx = -(xr - xl) * invTile2, nz = -(zr - zl) * invTile2;
        const inv = 1 / Math.hypot(nx, 1, nz);
        nor[li * 3] = nx * inv; nor[li * 3 + 1] = inv; nor[li * 3 + 2] = nz * inv;
      }
    }

    const idx = [];
    for (let lz = 0; lz < ch; lz++) {
      for (let lx = 0; lx < cw; lx++) {
        const a = lz * cvx + lx, b = a + 1, c = a + cvx, d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setAttribute('aGrass', new THREE.BufferAttribute(gra, 1));
    geo.setAttribute('aLand', new THREE.BufferAttribute(lnd, 1));
    geo.setAttribute('aShore', new THREE.BufferAttribute(sho, 1));
    geo.setIndex(idx);
    const mesh = new THREE.Mesh(geo, this._terrainMat);
    mesh.receiveShadow = true;
    mesh.userData.cx0 = cx0;
    mesh.userData.cz0 = cz0;
    return mesh;
  }

  // Advance the animated water ripples — call each frame with elapsed seconds.
  tickWater(t) {
    const sh = this._terrainMat && this._terrainMat.userData.shader;
    if (sh) sh.uniforms.uTime.value = t;
  }

  _buildWater() {
    // The sea is now the terrain surface itself (texture-splatting): underwater
    // vertices carry the depth gradient (wet sand → turquoise → deep blue), so there's
    // no separate water plane — which also removes the shoreline z-fight it caused.
    // All that remains is ONE opaque floor that fills the open ocean to the horizon
    // beyond the terrain square. It sits just under the deepest terrain and wears the
    // SAME deep blue the sea floor reaches in-island, so the mesh boundary vanishes.
    const size = Math.max(this.worldW, this.worldH) * 12 + 6000;
    const deepY = -this.params.seaLevel * this.params.heightScale - 0.1;   // below the deepest in-island water, above the sunk apron edge (-floor-0.25)
    const floorGeo = new THREE.PlaneGeometry(size, size);
    // Same deep blue + same gloss (0.12 / metal 0.15) as the now-uniformly-glossy
    // in-island water, so the two reflect the sky env identically and the mesh-edge
    // boundary stays invisible (the apron sinks under this plane to hide the seam).
    const floorMat = new THREE.MeshStandardMaterial({ color: '#' + C.deep.getHexString(), roughness: 0.12, metalness: 0.15 });
    this.seaFloor = new THREE.Mesh(floorGeo, floorMat);
    this.seaFloor.rotation.x = -Math.PI / 2;
    this.seaFloor.position.y = deepY;
    this.group.add(this.seaFloor);
  }

  // FINISHING PASS: level a flat, dry pad under each camp so walls share one
  // foundation height and no base sits in the ocean. pads: [{x,z,rInner,rOuter,height}].
  // LOCAL only: touches the pad's vertex region + rebuilds just the chunks it
  // overlaps (keeps init cheap even on big maps / phones).
  flattenPads(pads) {
    const p = this.params, VX = p.cols + 1, VZ = p.rows + 1;
    const halfW = this.worldW / 2, halfH = this.worldH / 2;
    const dirty = new Set();   // chunk keys "cx0,cz0" that changed

    for (const pad of pads) {
      const wobAmp = pad.rOuter * 0.22;   // how irregular the pad edge is
      const reach = pad.rOuter + wobAmp;
      const gx0 = Math.max(0, Math.floor((pad.x - reach + halfW) / p.tile));
      const gx1 = Math.min(VX - 1, Math.ceil((pad.x + reach + halfW) / p.tile));
      const gz0 = Math.max(0, Math.floor((pad.z - reach + halfH) / p.tile));
      const gz1 = Math.min(VZ - 1, Math.ceil((pad.z + reach + halfH) / p.tile));
      for (let gz = gz0; gz <= gz1; gz++) {
        const wz = gz * p.tile - halfH;
        for (let gx = gx0; gx <= gx1; gx++) {
          const wx = gx * p.tile - halfW;
          const dist = Math.hypot(wx - pad.x, wz - pad.z);
          if (dist > pad.rOuter + wobAmp) continue;
          const vi = gz * VX + gx;
          // Perturb the ramp distance with noise so the edge isn't a perfect
          // circle — but the inner disc (walls) stays exactly flat.
          const wob = (this._grassNoise.fbm(wx * 0.06, wz * 0.06, 2) - 0.5) * 2 * wobAmp;
          const distP = dist + wob;
          const tBlend = dist <= pad.rInner ? 1 : smoothstep(pad.rOuter, pad.rInner, distP);
          if (tBlend <= 0) continue;
          this._H[vi] = this._H[vi] * (1 - tBlend) + pad.height * tBlend;
          this._setAttribs(vi, gx / p.cols, gz / p.rows);
        }
      }
      // Mark overlapping chunks dirty (pad edges can touch neighbours, so pad ±1).
      for (let cz0 = 0; cz0 < p.rows; cz0 += CHUNK) {
        for (let cx0 = 0; cx0 < p.cols; cx0 += CHUNK) {
          if (cx0 + CHUNK < gx0 - 1 || cx0 > gx1 + 1 || cz0 + CHUNK < gz0 - 1 || cz0 > gz1 + 1) continue;
          dirty.add(cx0 + ',' + cz0);
        }
      }
    }

    // Rebuild only the dirty chunks.
    for (let i = this.chunks.length - 1; i >= 0; i--) {
      const m = this.chunks[i];
      if (!dirty.has(m.userData.cx0 + ',' + m.userData.cz0)) continue;
      this.group.remove(m); m.geometry.dispose();
      const fresh = this._makeChunk(m.userData.cx0, m.userData.cz0, VX, VZ);
      this.group.add(fresh);
      this.chunks[i] = fresh;
    }

    this._classifyRegion(pads);
    this.pads = pads;
  }

  // Carve a square elevator SHAFT: drop the vertices inside a square straight
  // down to `bottomY` so the one-tile-wide boundary quads become near-vertical
  // walls (a clean square pit). Returns {groundY, bottomY} for the elevator rig.
  // Vertices are tinted dark and flagged non-land; a liner mesh covers them.
  carveShaft(x, z, half, depth) {
    const p = this.params, VX = p.cols + 1, VZ = p.rows + 1;
    const halfW = this.worldW / 2, halfH = this.worldH / 2;
    const cgx = Math.round((x + halfW) / p.tile), cgz = Math.round((z + halfH) / p.tile);
    const groundY = this._H[cgz * VX + cgx];
    const bottomY = groundY - depth;
    const gx0 = Math.max(0, Math.floor((x - half + halfW) / p.tile));
    const gx1 = Math.min(VX - 1, Math.ceil((x + half + halfW) / p.tile));
    const gz0 = Math.max(0, Math.floor((z - half + halfH) / p.tile));
    const gz1 = Math.min(VZ - 1, Math.ceil((z + half + halfH) / p.tile));
    for (let gz = gz0; gz <= gz1; gz++) {
      const wz = gz * p.tile - halfH;
      for (let gx = gx0; gx <= gx1; gx++) {
        const wx = gx * p.tile - halfW;
        if (Math.abs(wx - x) > half || Math.abs(wz - z) > half) continue;
        const vi = gz * VX + gx;
        this._H[vi] = bottomY;
        this._setAttribs(vi, gx / p.cols, gz / p.rows);
        this._col[vi * 3] = 0.14; this._col[vi * 3 + 1] = 0.15; this._col[vi * 3 + 2] = 0.17;
        this._land[vi] = 0;
      }
    }
    const dirty = new Set();
    for (let cz0 = 0; cz0 < p.rows; cz0 += CHUNK) {
      for (let cx0 = 0; cx0 < p.cols; cx0 += CHUNK) {
        if (cx0 + CHUNK < gx0 - 1 || cx0 > gx1 + 1 || cz0 + CHUNK < gz0 - 1 || cz0 > gz1 + 1) continue;
        dirty.add(cx0 + ',' + cz0);
      }
    }
    for (let i = this.chunks.length - 1; i >= 0; i--) {
      const m = this.chunks[i];
      if (!dirty.has(m.userData.cx0 + ',' + m.userData.cz0)) continue;
      this.group.remove(m); m.geometry.dispose();
      const fresh = this._makeChunk(m.userData.cx0, m.userData.cz0, VX, VZ);
      this.group.add(fresh); this.chunks[i] = fresh;
    }
    return { x, z, half, groundY, bottomY };
  }

  // Reclassify only the cells under the pads (cheap, after a local flatten).
  _classifyRegion(pads) {
    const p = this.params, VX = p.cols + 1;
    const halfW = this.worldW / 2, halfH = this.worldH / 2;
    for (const pad of pads) {
      const reach = pad.rOuter * 1.25;
      const cx0 = Math.max(0, Math.floor((pad.x - reach + halfW) / p.tile));
      const cx1 = Math.min(p.cols - 1, Math.ceil((pad.x + reach + halfW) / p.tile));
      const cz0 = Math.max(0, Math.floor((pad.z - reach + halfH) / p.tile));
      const cz1 = Math.min(p.rows - 1, Math.ceil((pad.z + reach + halfH) / p.tile));
      for (let cz = cz0; cz <= cz1; cz++) {
        for (let cx = cx0; cx <= cx1; cx++) {
          const i0 = cz * VX + cx;
          const y = (this._H[i0] + this._H[i0 + 1] + this._H[i0 + VX] + this._H[i0 + VX + 1]) / 4;
          let t;
          if (y <= 0) t = y < -2.5 ? TILE.DEEP : TILE.SHALLOW;
          else if (y < p.beachHeight) t = TILE.SAND;
          else if (y > p.beachHeight + 4.0) t = TILE.ROCK;
          else t = TILE.GRASS;
          const ci = cz * p.cols + cx;
          this.tileType[ci] = t;
          this.tileH[ci] = y;
        }
      }
    }
  }

  // Two camp sites ~2/3 of the way out from centre (not extreme opposites),
  // each nudged onto the best nearby land (the flatten pass dries it out anyway).
  findCampSites(count = 2) {
    const p = this.params;
    const cc = p.cols / 2, cr = p.rows / 2;
    const Rcells = Math.min(p.cols, p.rows) * 0.33;   // ~2/3 from centre to edge
    const base = ((p.seed * 9301 + 49297) % 233280) / 233280 * Math.PI * 2;
    const sites = [];
    for (let i = 0; i < count; i++) {
      const ang = base + i * (Math.PI * 2 / count);
      const tcx = Math.max(10, Math.min(p.cols - 10, Math.round(cc + Math.cos(ang) * Rcells)));
      const tcz = Math.max(10, Math.min(p.rows - 10, Math.round(cr + Math.sin(ang) * Rcells)));
      const best = this._bestLandCell(tcx, tcz, 12);
      sites.push(this.cellCenter(best.cx, best.cz));
    }
    return sites;
  }

  // Search a window around (tcx,tcz) for the cell whose surrounding footprint is
  // the most land (sand/grass).
  _bestLandCell(tcx, tcz, win) {
    const p = this.params;
    const frT = Math.min(24, Math.max(4, Math.round(14 / p.tile)));
    let best = { cx: tcx, cz: tcz }, bestScore = -1;
    for (let dz = -win; dz <= win; dz += 2) {
      for (let dx = -win; dx <= win; dx += 2) {
        const cx = tcx + dx, cz = tcz + dz;
        if (cx < frT || cz < frT || cx >= p.cols - frT || cz >= p.rows - frT) continue;
        let land = 0, total = 0;
        for (let zz = -frT; zz <= frT; zz += 3) {
          for (let xx = -frT; xx <= frT; xx += 3) {
            const t = this.tileType[(cz + zz) * p.cols + (cx + xx)];
            total++;
            if (t === TILE.SAND || t === TILE.GRASS) land++;
          }
        }
        const score = land / total;
        if (score > bestScore) { bestScore = score; best = { cx, cz }; }
      }
    }
    return best;
  }

  _classify(VX) {
    const p = this.params;
    this.tileType = new Uint8Array(p.cols * p.rows);
    this.tileH = new Float32Array(p.cols * p.rows);
    for (let cz = 0; cz < p.rows; cz++) {
      for (let cx = 0; cx < p.cols; cx++) {
        const i0 = cz * VX + cx;
        const y = (this._H[i0] + this._H[i0 + 1] + this._H[i0 + VX] + this._H[i0 + VX + 1]) / 4;
        let t;
        if (y <= 0) t = y < -2.5 ? TILE.DEEP : TILE.SHALLOW;
        else if (y < p.beachHeight) t = TILE.SAND;
        else if (y > p.beachHeight + 4.0) t = TILE.ROCK;
        else t = TILE.GRASS;
        const ci = cz * p.cols + cx;
        this.tileType[ci] = t;
        this.tileH[ci] = y;
      }
    }
  }

  // --- Gameplay sampling -------------------------------------------------

  _cellAt(x, z) {
    const p = this.params;
    const cx = Math.floor((x + this.worldW / 2) / p.tile);
    const cz = Math.floor((z + this.worldH / 2) / p.tile);
    if (cx < 0 || cz < 0 || cx >= p.cols || cz >= p.rows) return null;
    return cz * p.cols + cx;
  }

  tileAt(x, z) {
    const ci = this._cellAt(x, z);
    return ci == null ? TILE.DEEP : this.tileType[ci];
  }

  isLand(x, z) {
    const t = this.tileAt(x, z);
    return t === TILE.SAND || t === TILE.GRASS || t === TILE.ROCK;
  }

  // Raw terrain height, NOT clamped to the waterline like heightAt — so it reads
  // negative under water (used to sit a wading vehicle at the actual floor depth).
  floorAt(x, z) {
    const ci = this._cellAt(x, z);
    return ci == null ? FORD_DEPTH - 1 : this.tileH[ci];
  }

  // DEEP water = floor deeper than the ford limit; ground vehicles can't cross it
  // (and sink in it). The shallow fringe above FORD_DEPTH — shorelines, puddles,
  // narrow inlets — is fordable: land vehicles WADE through instead of treating
  // every splash of water as a wall. Off-map reads as deep (the world's ocean
  // wall). Tuned against the map's depth spread (floors run ~-2.4..0).
  isDeepWater(x, z) {
    const ci = this._cellAt(x, z);
    if (ci == null) return true;
    return this.tileH[ci] < FORD_DEPTH;
  }

  heightAt(x, z) {
    const ci = this._cellAt(x, z);
    if (ci == null) return 0;
    return Math.max(0, this.tileH[ci]);
  }

  // Grass-texture splat mask at a world point (0..1) — reproduces TerrainMaterial's fragment
  // shader so callers can place grass tufts EXACTLY where the grass texture shows, not by the
  // coarser tile class. Same inputs as the shader: the macro grassiness stored in the aGrass
  // vertex attribute (this._grass), height-gated, thresholded by grassAmount. The per-pixel
  // noise jitter the shader adds (±0.08) is fine detail and omitted here.
  grassSplatAt(x, z) {
    const G = this._grass;
    if (!G) return 0;
    const y = this.heightAt(x, z);
    if (y <= 0) return 0;                          // water
    const p = this.params, VX = p.cols + 1, VZ = p.rows + 1;
    // world -> fractional vertex-grid coords (matches pos = g*tile - halfWorld in _buildMesh)
    const gxf = (x + this.worldW / 2) / p.tile, gzf = (z + this.worldH / 2) / p.tile;
    const gx = Math.max(0, Math.min(VX - 2, Math.floor(gxf))), gz = Math.max(0, Math.min(VZ - 2, Math.floor(gzf)));
    const fx = gxf - gx, fz = gzf - gz;
    const g0 = G[gz * VX + gx] * (1 - fx) + G[gz * VX + gx + 1] * fx;         // bilinear sample of aGrass
    const g1 = G[(gz + 1) * VX + gx] * (1 - fx) + G[(gz + 1) * VX + gx + 1] * fx;
    const vGrass = g0 * (1 - fz) + g1 * fz;
    const field = vGrass * smoothstep(0.05, 0.7, y);   // hgate: sand low on the beach, grass higher
    const thr = 1 - p.grassAmount;
    return smoothstep(thr - 0.05, thr + 0.05, field);
  }

  // World point for a cell centre.
  cellCenter(cx, cz) {
    return new THREE.Vector3(
      (cx + 0.5) * this.params.tile - this.worldW / 2,
      this.tileH[cz * this.params.cols + cx],
      (cz + 0.5) * this.params.tile - this.worldH / 2,
    );
  }

  // Find up to `count` flat-ish land sites with clearance, spread far apart.
  findBaseSites(count = 2, clearTiles = 6) {
    const p = this.params;
    const cands = [];
    for (let cz = clearTiles; cz < p.rows - clearTiles; cz++) {
      for (let cx = clearTiles; cx < p.cols - clearTiles; cx++) {
        const t = this.tileType[cz * p.cols + cx];
        if (t !== TILE.SAND && t !== TILE.GRASS) continue;
        let land = 0, total = 0;
        const r = clearTiles;
        for (let dz = -r; dz <= r; dz += 2) {
          for (let dx = -r; dx <= r; dx += 2) {
            const tt = this.tileType[(cz + dz) * p.cols + (cx + dx)];
            total++;
            if (tt === TILE.SAND || tt === TILE.GRASS) land++;
          }
        }
        if (land / total > 0.82) cands.push(this.cellCenter(cx, cz));
      }
    }
    if (cands.length === 0) return [this.findLandSpawn()];

    const sites = [cands[0]];
    while (sites.length < count && sites.length < cands.length) {
      let best = null, bestD = -1;
      for (const c of cands) {
        let nearest = Infinity;
        for (const s of sites) nearest = Math.min(nearest, c.distanceToSquared(s));
        if (nearest > bestD) { bestD = nearest; best = c; }
      }
      sites.push(best);
    }
    return sites;
  }

  findLandSpawn() {
    const p = this.params;
    const c = Math.floor(p.cols / 2), r = Math.floor(p.rows / 2);
    for (let radius = 0; radius < Math.max(p.cols, p.rows); radius++) {
      for (let dz = -radius; dz <= radius; dz++) {
        for (let dx = -radius; dx <= radius; dx++) {
          if (Math.abs(dx) !== radius && Math.abs(dz) !== radius) continue;
          const cx = c + dx, cz = r + dz;
          if (cx < 0 || cz < 0 || cx >= p.cols || cz >= p.rows) continue;
          const t = this.tileType[cz * p.cols + cx];
          if (t === TILE.SAND || t === TILE.GRASS) return this.cellCenter(cx, cz);
        }
      }
    }
    return new THREE.Vector3(0, 0, 0);
  }
}
