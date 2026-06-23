import * as THREE from 'three';

export const TEAM_COLORS = [
  { name: 'CYAN',   hex: '#2cc0d4' },   // was RED's slot (swapped with CYAN)
  { name: 'GREEN',  hex: '#3aa848' },   // was ORANGE's slot (swapped with GREEN)
  { name: 'YELLOW', hex: '#d4c038' },
  { name: 'SNOW',   hex: '#dce4ec' },   // was GREEN's slot; orange → snow camo (near-white)
  { name: 'RED',    hex: '#9e2e2e' },   // was CYAN's slot; darker red
  { name: 'BLUE',   hex: '#284a9c' },
  { name: 'PURPLE', hex: '#6a2896' },
  { name: 'GREY',   hex: '#46464a' },
];

// Camo composition: 4 shades derived from team color, weighted.
// dl = lightness offset from base; weight = chance the shade is picked per block.
const SHADE_RECIPE = [
  { dl: -0.05, weight: 0.30 },  // mid (slightly darker than base)
  { dl: +0.12, weight: 0.35 },  // light (brightest highlight)
  { dl: -0.22, weight: 0.20 },  // dark
  { dl: -0.36, weight: 0.15 },  // very dark
];

// Pattern parameters. SCALE = base block size; bigger → coarser blotches.
// SIZE = source-canvas resolution; bigger → more unique blocks per tile, so the
// pattern looks less identical each time it repeats.
const SCALE  = 14;
const DETAIL = 3;
const SIZE   = 512;

function _makeCanvas() {
  const c = document.createElement('canvas');
  c.width = c.height = SIZE;
  return c;
}

const _canvas       = _makeCanvas();
const _roughCanvas  = _makeCanvas();
const _bumpCanvas   = _makeCanvas();
const _normalCanvas = _makeCanvas();
const _ctx          = _canvas.getContext('2d');
const _roughCtx     = _roughCanvas.getContext('2d');
const _bumpCtx      = _bumpCanvas.getContext('2d');
const _normalCtx    = _normalCanvas.getContext('2d');

export const camoTexture = new THREE.CanvasTexture(_canvas);
camoTexture.wrapS       = camoTexture.wrapT = THREE.RepeatWrapping;
camoTexture.repeat.set(1, 1);   // tile once → bigger blocks, far fewer repeats
camoTexture.colorSpace  = THREE.SRGBColorSpace;

// Roughness map — derived from camo luminance: brighter pixels are shinier.
// Non-color data, so linear color space.
export const roughnessTexture = new THREE.CanvasTexture(_roughCanvas);
roughnessTexture.wrapS = roughnessTexture.wrapT = THREE.RepeatWrapping;
roughnessTexture.repeat.set(1, 1);

// Bump map — derived from camo luminance: brighter pixels are slightly raised.
export const bumpTexture = new THREE.CanvasTexture(_bumpCanvas);
bumpTexture.wrapS = bumpTexture.wrapT = THREE.RepeatWrapping;
bumpTexture.repeat.set(1, 1);

// Normal map — derived from the SAME luminance height field via a Sobel gradient, encoded
// as a tangent-space normal (XYZ → RGB). Lights more accurately than the bump map and holds
// up at grazing angles. Must stay in LINEAR colour space (do NOT mark it sRGB).
export const normalTexture = new THREE.CanvasTexture(_normalCanvas);
normalTexture.wrapS = normalTexture.wrapT = THREE.RepeatWrapping;
normalTexture.repeat.set(1, 1);

export const camoParams = {
  colorIndex: 0,                                  // default RED
  seed:       Math.floor(Math.random() * 65536),
};

export function getTeamColor() {
  return TEAM_COLORS[camoParams.colorIndex].hex;
}

export function getCamoShades() {
  return _deriveShades(getTeamColor());
}

export function updateCamo(overrides = {}) {
  Object.assign(camoParams, overrides);
  _draw();
}

function _deriveShades(baseHex) {
  const c = new THREE.Color(baseHex);
  const hsl = {};
  c.getHSL(hsl);
  return SHADE_RECIPE.map(({ dl, weight }) => {
    const l = Math.max(0.03, Math.min(0.97, hsl.l + dl));
    const out = new THREE.Color().setHSL(hsl.h, hsl.s, l);
    return {
      rgb:    [Math.round(out.r * 255), Math.round(out.g * 255), Math.round(out.b * 255)],
      hex:    '#' + out.getHexString(),
      weight,
    };
  });
}

// The shade-index map (which of the 4 shades each pixel uses) depends only on the
// SEED, not the team colour — so cache it and reuse across colour swaps. Only the
// cheap RGB mapping in _draw re-runs when the colour changes; the cells stay put.
let _pixCache = null, _pixSeed = -1;
function _getPix(seed) {
  if (_pixCache && _pixSeed === seed) return _pixCache;
  _pixCache = _buildPix(seed);
  _pixSeed  = seed;
  return _pixCache;
}

// Irregular CELLULAR (Worley/Voronoi) camo — replaces the old square-grid blocks.
// Each layer scatters one feature point per grid cell at a random in-cell offset, then
// every pixel takes the shade of its NEAREST feature point. Distances are tested across
// the 3×3 neighbouring cells with WRAP-AROUND, so the tile stays seamless. The coarse
// layer paints everything; finer layers overpaint a fraction for grain. The organic,
// non-axis-aligned cell edges are what kill the gridded "repetitive digital" look.
function _buildPix(seed) {
  let r = (seed ^ 0x5a5a5a5a) | 1;
  const rand = () => { r ^= r << 13; r ^= r >> 17; r ^= r << 5; return (r >>> 0) / 0x100000000; };
  const weights = SHADE_RECIPE.map(s => s.weight);
  const pick = () => {
    const v = rand(); let s = 0;
    for (let i = 0; i < weights.length; i++) { s += weights[i]; if (v < s) return i; }
    return weights.length - 1;
  };

  const pix      = new Uint8Array(SIZE * SIZE);
  const cellPx   = [SCALE * 5, SCALE * 2.6, SCALE * 1.4];   // coarse → fine cell size (px)
  const coverage = [1.0, 0.5, 0.34];                         // fraction of cells each layer paints

  for (let layer = 0; layer < Math.min(DETAIL, 3); layer++) {
    const G    = Math.max(2, Math.round(SIZE / cellPx[layer]));   // cells per axis
    const cell = SIZE / G;
    const cov  = coverage[layer];
    const fx = new Float32Array(G * G), fy = new Float32Array(G * G);
    const sh = new Uint8Array(G * G),   act = new Uint8Array(G * G);
    for (let i = 0; i < G * G; i++) {
      fx[i]  = (i % G + rand()) * cell;            // feature point, jittered within its cell
      fy[i]  = ((i / G | 0) + rand()) * cell;
      sh[i]  = pick();                             // this cell's shade
      act[i] = rand() < cov ? 1 : 0;               // does this layer paint this cell?
    }
    for (let y = 0; y < SIZE; y++) {
      const gy0 = (y / cell) | 0;
      for (let x = 0; x < SIZE; x++) {
        const gx0 = (x / cell) | 0;
        let best = Infinity, bk = 0;
        for (let oy = -1; oy <= 1; oy++) {
          const uy = gy0 + oy, gy = ((uy % G) + G) % G, sY = (uy - gy) * cell;
          for (let ox = -1; ox <= 1; ox++) {
            const ux = gx0 + ox, gx = ((ux % G) + G) % G, sX = (ux - gx) * cell;
            const k  = gy * G + gx;
            const dx = x - (fx[k] + sX), dy = y - (fy[k] + sY);
            const d  = dx * dx + dy * dy;
            if (d < best) { best = d; bk = k; }
          }
        }
        if (act[bk]) pix[y * SIZE + x] = sh[bk];
      }
    }
  }
  return pix;
}

function _draw() {
  _renderCamo({ ctx: _ctx, rough: _roughCtx, bump: _bumpCtx, normal: _normalCtx },
              getTeamColor(), camoParams.seed);
  camoTexture.needsUpdate    = true;
  roughnessTexture.needsUpdate = true;
  bumpTexture.needsUpdate    = true;
  normalTexture.needsUpdate  = true;
}

// Render the full camo/roughness/bump/normal set for a given base colour + seed
// into the four supplied canvas contexts. Factored out of _draw so per-team
// texture sets (getCamoTextures) can render into their own canvases.
function _renderCamo(t, baseHex, seed) {
  const _ctx = t.ctx, _roughCtx = t.rough, _bumpCtx = t.bump, _normalCtx = t.normal;
  const shades = _deriveShades(baseHex);
  const rgbs   = shades.map(s => s.rgb);
  const pix    = _getPix(seed);

  const img       = _ctx.createImageData(SIZE, SIZE);
  const roughImg  = _roughCtx.createImageData(SIZE, SIZE);
  const bumpImg   = _bumpCtx.createImageData(SIZE, SIZE);
  const data      = img.data;
  const roughData = roughImg.data;
  const bumpData  = bumpImg.data;

  for (let i = 0; i < SIZE * SIZE; i++) {
    const [ri, gi, bi] = rgbs[pix[i]];
    data[i*4]   = ri;
    data[i*4+1] = gi;
    data[i*4+2] = bi;
    data[i*4+3] = 255;

    // Perceptual luminance in [0, 1]
    const lum = (0.299 * ri + 0.587 * gi + 0.114 * bi) / 255;

    // Roughness: bright → 0 (mirror), dark → 1 (fully matte). Contrast-boosted around the
    // midpoint so the dark camo (and black) flattens right out to dead-matte while the
    // bright highlights get a touch shinier.
    const r01   = Math.max(0, Math.min(1, (1.0 - lum - 0.5) * 1.7 + 0.5));
    const rough = Math.round(r01 * 255);
    roughData[i*4]   = rough;
    roughData[i*4+1] = rough;
    roughData[i*4+2] = rough;
    roughData[i*4+3] = 255;

    // Bump: bright → 255 (fully raised), dark → 0 (fully recessed)
    const bump = Math.round(lum * 255);
    bumpData[i*4]   = bump;
    bumpData[i*4+1] = bump;
    bumpData[i*4+2] = bump;
    bumpData[i*4+3] = 255;
  }

  // Normal map: Sobel-style gradient of the bump (height) field, wrapped at the edges so the
  // tile stays seamless. STRENGTH sets the baked slope; fine-tune per material via normalScale.
  const normalImg  = _normalCtx.createImageData(SIZE, SIZE);
  const normalData = normalImg.data;
  const STRENGTH   = 2.0;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i  = y * SIZE + x;
      const xl = (x - 1 + SIZE) % SIZE, xr = (x + 1) % SIZE;
      const yt = (y - 1 + SIZE) % SIZE, yb = (y + 1) % SIZE;
      const hL = bumpData[(y  * SIZE + xl) * 4] / 255;
      const hR = bumpData[(y  * SIZE + xr) * 4] / 255;
      const hT = bumpData[(yt * SIZE + x ) * 4] / 255;
      const hB = bumpData[(yb * SIZE + x ) * 4] / 255;
      const nx = (hL - hR) * STRENGTH;
      const ny = (hB - hT) * STRENGTH;            // +Y up in tangent space
      const inv = 1 / Math.hypot(nx, ny, 1);
      normalData[i*4]   = Math.round((nx * inv * 0.5 + 0.5) * 255);
      normalData[i*4+1] = Math.round((ny * inv * 0.5 + 0.5) * 255);
      normalData[i*4+2] = Math.round((1  * inv * 0.5 + 0.5) * 255);
      normalData[i*4+3] = 255;
    }
  }

  _ctx.putImageData(img, 0, 0);
  _roughCtx.putImageData(roughImg, 0, 0);
  _bumpCtx.putImageData(bumpImg, 0, 0);
  _normalCtx.putImageData(normalImg, 0, 0);
}

// Build (and cache) a dedicated camo texture SET for a team colour index, so two
// teams can wear different camo at once (the global camoTexture only holds one).
// Returns { map, roughnessMap, normalMap } ready to drop onto a body material.
const _texSetCache = new Map();
export function getCamoTextures(colorIndex) {
  if (_texSetCache.has(colorIndex)) return _texSetCache.get(colorIndex);
  const cc = _makeCanvas(), rc = _makeCanvas(), bc = _makeCanvas(), nc = _makeCanvas();
  _renderCamo({ ctx: cc.getContext('2d'), rough: rc.getContext('2d'),
                bump: bc.getContext('2d'), normal: nc.getContext('2d') },
              TEAM_COLORS[colorIndex].hex, camoParams.seed);
  const tex = (canvas, srgb) => {
    const t = new THREE.CanvasTexture(canvas);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };
  const set = { map: tex(cc, true), roughnessMap: tex(rc, false), normalMap: tex(nc, false) };
  _texSetCache.set(colorIndex, set);
  return set;
}

// Factory for the camo body material — color, roughness, and bump maps all
// derived from the shared camo canvas. Pass overrides to tweak per-vehicle feel.
export function makeCamoMaterial({ roughness = 0.7, metalness = 0.6, normalScale = 1.0 } = {}) {
  const m = new THREE.MeshStandardMaterial({
    map:          camoTexture,
    roughnessMap: roughnessTexture,
    normalMap:    normalTexture,
    normalScale:  new THREE.Vector2(normalScale, normalScale),
    roughness,
    metalness,
  });
  m.userData.camo = true;   // tag so a vehicle can swap in a per-team camo set
  return m;
}

// Rewrite a geometry's UVs as world-space dominant-axis projection so the
// camo tiles at a uniform density regardless of face orientation or aspect.
// tileSize = world-space distance per UV unit (smaller = denser pattern).
export function applyCamoUVs(geometry, tileSize = 1.0) {
  if (!geometry.attributes.normal) geometry.computeVertexNormals();
  const pos  = geometry.attributes.position;
  const norm = geometry.attributes.normal;
  const uvs  = new Float32Array(pos.count * 2);

  for (let i = 0; i < pos.count; i++) {
    const x  = pos.getX(i),  y  = pos.getY(i),  z  = pos.getZ(i);
    const nx = Math.abs(norm.getX(i));
    const ny = Math.abs(norm.getY(i));
    const nz = Math.abs(norm.getZ(i));

    let u, v;
    if (ny >= nx && ny >= nz)       { u = x; v = z; }   // top/bottom → XZ
    else if (nx >= nz)              { u = z; v = y; }   // side, X-dominant → YZ
    else                            { u = x; v = y; }   // side, Z-dominant → XY

    uvs[i * 2]     = u / tileSize;
    uvs[i * 2 + 1] = v / tileSize;
  }

  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  return geometry;
}

// Per-face planar camo UVs. Unlike applyCamoUVs (which flattens each facet onto a
// single world plane and therefore stretches any facet that isn't axis-aligned —
// e.g. the 45° bevels of a faceted cone), this projects every triangle onto its OWN
// plane, so the camo density is 1:1 with world distance on EVERY facet, whatever its
// angle. The trade-off is a hard seam between facets, which the random camo masks.
// Use this on strongly-tapered/sheared faceted hulls where bevel stretch shows.
// Returns a NON-INDEXED geometry (each face gets its own verts) — use the return value.
export function applyFacetedCamoUVs(geometry, tileSize = 1.0) {
  const geo = geometry.index ? geometry.toNonIndexed() : geometry;
  const pos = geo.attributes.position;
  const uvs = new Float32Array(pos.count * 2);

  const pA = new THREE.Vector3(), pB = new THREE.Vector3(), pC = new THREE.Vector3();
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), n = new THREE.Vector3();
  const uAxis = new THREE.Vector3(), vAxis = new THREE.Vector3(), ref = new THREE.Vector3();
  const worldUp = new THREE.Vector3(0, 1, 0), worldZ = new THREE.Vector3(0, 0, 1);

  for (let i = 0; i < pos.count; i += 3) {
    pA.fromBufferAttribute(pos, i);
    pB.fromBufferAttribute(pos, i + 1);
    pC.fromBufferAttribute(pos, i + 2);
    n.crossVectors(e1.subVectors(pB, pA), e2.subVectors(pC, pA)).normalize();

    // Build a stable in-plane basis from the face normal so neighbouring facets
    // pick consistent axes (keeps the pattern from scrambling facet to facet).
    ref.copy(Math.abs(n.y) > 0.9 ? worldZ : worldUp);
    uAxis.crossVectors(ref, n).normalize();
    vAxis.crossVectors(n, uAxis).normalize();

    for (let k = 0; k < 3; k++) {
      const p = k === 0 ? pA : k === 1 ? pB : pC;
      uvs[(i + k) * 2]     = p.dot(uAxis) / tileSize;
      uvs[(i + k) * 2 + 1] = p.dot(vAxis) / tileSize;
    }
  }

  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  return geo;
}

_draw();
