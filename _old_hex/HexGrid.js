import * as THREE from 'three';

const SQRT3 = Math.sqrt(3);

export const TileType = {
    OCEAN:    'ocean',
    BEACH:    'beach',
    SAND:     'sand',
    GRASS:    'grass',
    ROCK:     'rock',
    MOUNTAIN: 'mountain',
    BASE:     'base',
};

const IMPASSABLE = new Set([TileType.OCEAN, TileType.ROCK, TileType.MOUNTAIN]);

// All traversable land tiles share the same height — this is what makes the surface seamless
const TILE_HEIGHT = {
    [TileType.BEACH]:    0.12,
    [TileType.SAND]:     0.12,
    [TileType.GRASS]:    0.12,
    [TileType.ROCK]:     0.72,
    [TileType.MOUNTAIN]: 1.35,
    [TileType.BASE]:     0.17,
};

const HEX_DIRS = [[1,0],[-1,0],[0,1],[0,-1],[1,-1],[-1,1]];

// --- Procedural sandy canvas texture ---
function createSandTexture() {
    const size = 512;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#ba9852';
    ctx.fillRect(0, 0, size, size);

    for (let i = 0; i < 9000; i++) {
        const x = Math.random() * size;
        const y = Math.random() * size;
        const v = 0.58 + Math.random() * 0.58;
        ctx.globalAlpha = 0.35 + Math.random() * 0.55;
        ctx.fillStyle = `rgb(${Math.min(255,Math.floor(186*v))},${Math.min(255,Math.floor(148*v))},${Math.min(255,Math.floor(68*v))})`;
        ctx.fillRect(x, y, 1 + Math.random() * 2, 1);
    }
    ctx.globalAlpha = 1;

    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    return tex;
}

// Project UVs using world XZ so the texture is continuous across adjacent tiles
function applyWorldUVs(geo, worldX, worldZ, scale) {
    const pos = geo.attributes.position;
    const uv  = geo.attributes.uv;
    for (let i = 0; i < pos.count; i++) {
        uv.setXY(i, (pos.getX(i) + worldX) / scale, (pos.getZ(i) + worldZ) / scale);
    }
    uv.needsUpdate = true;
}

// --- Value noise + fBm ---
function hash2(x, y) {
    const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
    return n - Math.floor(n);
}
function smoothstep(t) { return t * t * (3 - 2 * t); }
function valueNoise(x, y) {
    const ix = Math.floor(x), iy = Math.floor(y);
    const fx = x - ix, fy = y - iy;
    const ux = smoothstep(fx), uy = smoothstep(fy);
    return hash2(ix,   iy  ) * (1-ux) * (1-uy)
         + hash2(ix+1, iy  ) * ux     * (1-uy)
         + hash2(ix,   iy+1) * (1-ux) * uy
         + hash2(ix+1, iy+1) * ux     * uy;
}
function fbm(x, y) {
    return valueNoise(x,   y  ) * 0.500
         + valueNoise(x*2, y*2) * 0.250
         + valueNoise(x*4, y*4) * 0.125;
}

function getElevation(q, r, radius) {
    const dist    = Math.max(Math.abs(q), Math.abs(r), Math.abs(-q-r)) / radius;
    const falloff = Math.max(0, 1 - Math.pow(dist * 1.2, 2));
    return falloff * 0.65 + fbm(q / radius * 2.5, r / radius * 2.5) * 0.35;
}

function tileTypeFromElevation(elev, secondary) {
    if (elev < 0.15) return TileType.OCEAN;
    if (elev < 0.24) return TileType.BEACH;
    if (elev < 0.72) return secondary > 0.58 ? TileType.GRASS : TileType.SAND;
    if (elev < 0.85) return TileType.ROCK;
    return TileType.MOUNTAIN;
}

// Merge an array of BufferGeometries (all indexed, all with position/normal/uv) into one
function mergeGeos(geos) {
    let totalVerts = 0, totalIdx = 0;
    for (const g of geos) { totalVerts += g.attributes.position.count; totalIdx += g.index.count; }
    const pos = new Float32Array(totalVerts * 3);
    const nor = new Float32Array(totalVerts * 3);
    const uv  = new Float32Array(totalVerts * 2);
    const idx = new Uint32Array(totalIdx);
    let vOff = 0, iOff = 0;
    for (const g of geos) {
        const vc = g.attributes.position.count;
        pos.set(g.attributes.position.array, vOff * 3);
        nor.set(g.attributes.normal.array,   vOff * 3);
        if (g.attributes.uv) uv.set(g.attributes.uv.array, vOff * 2);
        for (let j = 0; j < g.index.count; j++) idx[iOff + j] = g.index.array[j] + vOff;
        vOff += vc;
        iOff += g.index.count;
    }
    const merged = new THREE.BufferGeometry();
    merged.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    merged.setAttribute('normal',   new THREE.BufferAttribute(nor, 3));
    merged.setAttribute('uv',       new THREE.BufferAttribute(uv,  2));
    merged.setIndex(new THREE.BufferAttribute(idx, 1));
    return merged;
}

// --- HexGrid ---
export class HexGrid {
    constructor(scene, radius, hexSize) {
        this.scene   = scene;
        this.radius  = radius;
        this.hexSize = hexSize;
        this.tiles   = new Map();
        this.baseLights    = [];
        this.basePositions = [];
        this._blades = []; // individual blade data, collected during generate

        const sandTex = createSandTexture();
        this._mats = {
            sand: new THREE.MeshStandardMaterial({ map: sandTex, roughness: 0.88, metalness: 0.0 }),
            rock: new THREE.MeshStandardMaterial({ color: 0x5c4c3a, emissive: 0x120e08, emissiveIntensity: 0.2, roughness: 0.92, metalness: 0.04 }),
            mountain: new THREE.MeshStandardMaterial({ color: 0x423830, emissive: 0x0c0a08, emissiveIntensity: 0.15, roughness: 0.96, metalness: 0.02 }),
            base: new THREE.MeshStandardMaterial({ color: 0x8a6820, emissive: 0x5a3808, emissiveIntensity: 2.2, roughness: 0.3, metalness: 0.8 }),
            baseEdge: new THREE.LineBasicMaterial({ color: 0xffaa00, transparent: true, opacity: 1.0 }),
        };

        this._generate();
        this._placeBases();
        this._buildGrass();
        this._mergeTileGeos();
    }

    hexToWorld(q, r) {
        return { x: this.hexSize * 1.5 * q, z: this.hexSize * SQRT3 * (r + q * 0.5) };
    }

    worldToHex(x, z) {
        const q = (2/3 * x) / this.hexSize;
        const r = (-x/3 + SQRT3/3 * z) / this.hexSize;
        return this._round(q, r);
    }

    _round(q, r) {
        const s = -q - r;
        let rq = Math.round(q), rr = Math.round(r), rs = Math.round(s);
        const dq = Math.abs(rq-q), dr = Math.abs(rr-r), ds = Math.abs(rs-s);
        if (dq > dr && dq > ds) rq = -rr - rs;
        else if (dr > ds) rr = -rq - rs;
        return { q: rq, r: rr };
    }

    _generate() {
        for (let q = -this.radius; q <= this.radius; q++) {
            const r1 = Math.max(-this.radius, -q - this.radius);
            const r2 = Math.min(this.radius,  -q + this.radius);
            for (let r = r1; r <= r2; r++) {
                const elev = getElevation(q, r, this.radius);
                const sec  = valueNoise(q * 0.7 + 50, r * 0.7 + 50);
                const type = tileTypeFromElevation(elev, sec);
                // Ocean: register for collision but skip mesh (water plane handles visuals)
                this.tiles.set(`${q},${r}`, { q, r, type, mesh: null });
                if (type !== TileType.OCEAN) this._createTile(q, r, type);
            }
        }
    }

    _placeBases() {
        const centers = [
            { q: Math.round(this.radius * 0.45), r: Math.round(-this.radius * 0.22) },
            { q: Math.round(-this.radius * 0.45), r: Math.round(this.radius * 0.22) },
        ];
        centers.forEach(c => {
            this.basePositions.push(c);
            [c, ...HEX_DIRS.map(([dq,dr]) => ({ q: c.q+dq, r: c.r+dr }))].forEach(({ q, r }) => {
                const old = this.tiles.get(`${q},${r}`);
                if (old?.mesh) { this.scene.remove(old.mesh); if (old.edges) this.scene.remove(old.edges); }
                this.tiles.delete(`${q},${r}`);
                this._createTile(q, r, TileType.BASE);
            });
            // One glow light per cluster instead of per tile
            const { x, z } = this.hexToWorld(c.q, c.r);
            const light = new THREE.PointLight(0xffaa00, 2.8, 10);
            light.position.set(x, TILE_HEIGHT[TileType.BASE] + 0.5, z);
            this.scene.add(light);
            this.baseLights.push(light);
        });
    }

    _createTile(q, r, type) {
        const { x, z } = this.hexToWorld(q, r);
        const h = TILE_HEIGHT[type];

        // +0.005 slight overlap ensures no render gap from floating-point at shared edges
        const geo = new THREE.CylinderGeometry(this.hexSize + 0.005, this.hexSize + 0.005, h, 6);
        geo.rotateY(Math.PI / 6);

        let mat, edges = null;

        if (type === TileType.ROCK) {
            mat = this._mats.rock;
        } else if (type === TileType.MOUNTAIN) {
            mat = this._mats.mountain;
        } else if (type === TileType.BASE) {
            mat = this._mats.base;
            const edgeGeo = new THREE.EdgesGeometry(geo);
            edges = new THREE.LineSegments(edgeGeo, this._mats.baseEdge);
            edges.position.set(x, h / 2, z);
            this.scene.add(edges);
        } else {
            // Sandy tiles — world-space UVs make texture seamless across all adjacent tiles
            applyWorldUVs(geo, x, z, 3.5);
            mat = this._mats.sand;
        }

        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(x, h / 2, z);
        mesh.receiveShadow = true;
        if (type === TileType.ROCK || type === TileType.MOUNTAIN) mesh.castShadow = true;
        this.scene.add(mesh);

        if (type === TileType.GRASS) {
            this._spreadBlades(x, h, z, 6 + Math.floor(Math.random() * 4));
        }

        this.tiles.set(`${q},${r}`, { q, r, type, mesh, edges });
    }

    // Place count individual blades on a tile at (cx, groundY, cz) with minimum separation
    _spreadBlades(cx, groundY, cz, count) {
        const MIN_DIST = 0.25;
        const placed = [];
        let tries = 0;
        while (placed.length < count && tries < count * 20) {
            tries++;
            const angle = Math.random() * Math.PI * 2;
            const dist  = Math.sqrt(Math.random()) * this.hexSize * 0.72;
            const bx = cx + Math.cos(angle) * dist;
            const bz = cz + Math.sin(angle) * dist;
            const clear = placed.every(p => {
                const dx = p.x - bx, dz = p.z - bz;
                return dx*dx + dz*dz >= MIN_DIST * MIN_DIST;
            });
            if (clear) {
                placed.push({
                    x: bx, y: groundY, z: bz,
                    ry:    Math.random() * Math.PI * 2,
                    tiltX: (Math.random() - 0.5) * 0.38,
                    h:     0.20 + Math.random() * 0.20,
                });
            }
        }
        this._blades.push(...placed);
    }

    _buildGrass() {
        if (!this._blades.length) return;

        // Triangle blade: wide at base, pointed at top
        const HW = 0.045; // half-width
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
            -HW, 0, 0,
             HW, 0, 0,
             0,  1, 0,  // unit height — scaled per instance
        ]), 3));
        geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array([
            0, 0, 1,  0, 0, 1,  0, 0, 1,
        ]), 3));
        geo.setIndex([0, 1, 2]);

        const mat = new THREE.MeshLambertMaterial({ color: 0x5a8820, side: THREE.DoubleSide });
        const mesh = new THREE.InstancedMesh(geo, mat, this._blades.length);
        const dummy = new THREE.Object3D();

        this._blades.forEach((b, i) => {
            dummy.position.set(b.x, b.y, b.z);
            dummy.rotation.order = 'YXZ';
            dummy.rotation.set(b.tiltX, b.ry, 0);
            dummy.scale.set(1, b.h, 1);
            dummy.updateMatrix();
            mesh.setMatrixAt(i, dummy.matrix);
        });

        mesh.instanceMatrix.needsUpdate = true;
        this.scene.add(mesh);
    }

    _mergeTileGeos() {
        const sandGeos = [], rockGeos = [], mountGeos = [];

        for (const tile of this.tiles.values()) {
            if (!tile.mesh || tile.type === TileType.BASE) continue;
            const geo = tile.mesh.geometry.clone();
            const { x, y, z } = tile.mesh.position;
            geo.translate(x, y, z);
            if      (tile.type === TileType.ROCK)     rockGeos.push(geo);
            else if (tile.type === TileType.MOUNTAIN) mountGeos.push(geo);
            else                                      sandGeos.push(geo);
            this.scene.remove(tile.mesh);
            tile.mesh.geometry.dispose();
            tile.mesh = null;
        }

        const addMerged = (geos, mat, castShadow) => {
            if (!geos.length) return;
            const mesh = new THREE.Mesh(mergeGeos(geos), mat);
            mesh.receiveShadow = true;
            mesh.castShadow    = castShadow;
            this.scene.add(mesh);
        };

        addMerged(sandGeos,  this._mats.sand,     false);
        addMerged(rockGeos,  this._mats.rock,      true);
        addMerged(mountGeos, this._mats.mountain,  true);
    }

    isPassable(q, r) {
        const t = this.tiles.get(`${q},${r}`);
        return t !== undefined && !IMPASSABLE.has(t.type);
    }

    // Projectiles are only stopped by solid terrain, not water
    blocksProjectile(q, r) {
        const t = this.tiles.get(`${q},${r}`);
        return !t || t.type === TileType.ROCK || t.type === TileType.MOUNTAIN;
    }

    getTile(q, r) { return this.tiles.get(`${q},${r}`); }

    getBaseWorldPositions() {
        return this.basePositions.map(({ q, r }) => {
            const { x, z } = this.hexToWorld(q, r);
            return new THREE.Vector3(x, 0, z);
        });
    }

    update(time) {
        this.baseLights.forEach((l, i) => {
            l.intensity = 1.2 + Math.sin(time * 2.4 + i * Math.PI) * 0.35;
        });
    }
}
