// Plants.js — all procedural low-poly flora makers in one catalog: trees,
// bushes, grasses, rocks, dead trees, and the signature beach palm. Flat-shaded
// to match the Return Fire look. Each maker returns a THREE.Group with its base
// at y=0; variants come from internal randomness, so calling a maker repeatedly
// yields a varied set. Foliage.js instances these across the map.
//
// (Merged from the former FoliageModels.js + Palm.js — one home for plants.)

import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

// ── Shared materials ────────────────────────────────────────────────────────
const BARK    = new THREE.MeshStandardMaterial({ color: '#8a6a42', roughness: 1.0, flatShading: true });
const DRYBARK = new THREE.MeshStandardMaterial({ color: '#9c8460', roughness: 1.0, flatShading: true });
const LEAF    = new THREE.MeshStandardMaterial({ color: '#416125', roughness: 0.95, flatShading: true });
const LEAF2   = new THREE.MeshStandardMaterial({ color: '#4c6d29', roughness: 0.95, flatShading: true });
const ROCK    = new THREE.MeshStandardMaterial({ color: '#9a948a', roughness: 1.0, flatShading: true });
ROCK.userData.rock = true;   // lets headless rigs find rock instances
const PALM_TRUNK = new THREE.MeshStandardMaterial({ color: '#9a7b4f', roughness: 1.0, flatShading: true });
const PALM_FROND = new THREE.MeshStandardMaterial({ color: '#416125', roughness: 0.95, flatShading: true, side: THREE.DoubleSide });
const PALM_COCO  = new THREE.MeshStandardMaterial({ color: '#5a4326', roughness: 1.0, flatShading: true });

const rand = (a, b) => a + Math.random() * (b - a);

// ── Wind sway (GPU) ─────────────────────────────────────────────────────────
// One shared clock drives a vertex-shader sway on grass + leaves. The offset scales with a
// baked per-vertex weight (aWind: 0 at the anchored base, 1 at the free tip) and its PHASE
// comes from the instance's WORLD position, so the sway travels across the map as a wave
// instead of the whole field shifting in lockstep. Cost is one uniform per frame; the GPU
// does the rest — negligible even at full foliage count.
const windUniform = { value: 0 };
export function setWindTime(t) { windUniform.value = t; }

function applyWind(mat, amp, freq, speed) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uWindTime = windUniform;
    shader.vertexShader = 'uniform float uWindTime;\nattribute float aWind;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `
      #include <begin_vertex>
      #ifdef USE_INSTANCING
        vec3 wPos = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
      #else
        vec3 wPos = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
      #endif
      float wPh  = wPos.x * ${freq.toFixed(4)} + wPos.z * ${(freq * 0.85).toFixed(4)} + uWindTime * ${speed.toFixed(4)};
      float wPh2 = wPos.x * ${(freq * 0.42).toFixed(4)} - wPos.z * ${(freq * 0.55).toFixed(4)} + uWindTime * ${(speed * 0.6).toFixed(4)};
      transformed.x += aWind * ${amp.toFixed(4)} * (sin(wPh) + 0.5 * sin(wPh2));
      transformed.z += aWind * ${(amp * 0.8).toFixed(4)} * (cos(wPh * 0.9) + 0.5 * cos(wPh2));
    `);
  };
  mat.customProgramCacheKey = () => `wind_${amp}_${freq}_${speed}`;
}

// Bake the sway weight (aWind) onto a geometry. mode 'tip' = 0 at the lowest vertex → 1 at the
// highest (a blade bends, root planted); mode 'radial' = 0 at the crown axis → 1 at the frond
// tips; a number = a flat constant (whole canopy sways as one). A geometry without aWind just
// gets 0 → no sway, so anything unbaked is safely rigid.
function bakeWind(geo, mode, cx = 0, cz = 0) {
  const pos = geo.attributes.position, n = pos.count, w = new Float32Array(n);
  if (typeof mode === 'number') { w.fill(mode); }
  else if (mode === 'radial') {
    let dmax = 1e-4;
    for (let i = 0; i < n; i++) dmax = Math.max(dmax, Math.hypot(pos.getX(i) - cx, pos.getZ(i) - cz));
    for (let i = 0; i < n; i++) w[i] = Math.hypot(pos.getX(i) - cx, pos.getZ(i) - cz) / dmax;
  } else {   // 'tip' — along local Y
    let y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < n; i++) { const y = pos.getY(i); if (y < y0) y0 = y; if (y > y1) y1 = y; }
    const span = (y1 - y0) || 1;
    for (let i = 0; i < n; i++) w[i] = (pos.getY(i) - y0) / span;
  }
  geo.setAttribute('aWind', new THREE.BufferAttribute(w, 1));
}

// Bake a bottom→top colour gradient into a blade geometry: the root blends into the grass
// ground it meets, the tip goes darker green — so a patch reads as a real field of grass.
// Zero runtime cost (just vertex data). White material base makes this gradient the albedo.
function bakeGradient(geo, root, tip) {
  const pos = geo.attributes.position, n = pos.count, col = new Float32Array(n * 3), c = new THREE.Color();
  let y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < n; i++) { const y = pos.getY(i); if (y < y0) y0 = y; if (y > y1) y1 = y; }
  const span = (y1 - y0) || 1;
  for (let i = 0; i < n; i++) {
    c.copy(root).lerp(tip, (pos.getY(i) - y0) / span);
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
}

// Grass blades: UNLIT (the gradient carries the depth, not per-face lighting — no light/dark
// speckle from random orientation, and a stable base colour), double-sided so a flat blade shows
// from both faces. The gradient colour is driven by LIVE uniforms (root / tip / root-band) so it
// can be tuned in-game against the REAL terrain — RR.setGrass* / the ?grasstune panel — instead
// of guessing against the playground's flat ground. aWind (0 root → 1 tip) drives BOTH the sway
// weight and the gradient position.
const grassColor = {
  uRoot:     { value: new THREE.Color('#8caf46') },   // tuned in-game against the real terrain (?grasstune)
  uTip:      { value: new THREE.Color('#3f9108') },
  uRootBand: { value: 0.0 },
};
export function setGrassRoot(hex)     { grassColor.uRoot.value.set(hex); }
export function setGrassTip(hex)      { grassColor.uTip.value.set(hex); }
export function setGrassRootBand(v)   { grassColor.uRootBand.value = +v; }
export function getGrassColors()      { return { root: '#' + grassColor.uRoot.value.getHexString(), tip: '#' + grassColor.uTip.value.getHexString(), band: grassColor.uRootBand.value }; }

const GRASS_BLADE = new THREE.MeshBasicMaterial({ color: '#ffffff', side: THREE.DoubleSide });
GRASS_BLADE.onBeforeCompile = (shader) => {
  shader.uniforms.uWindTime = windUniform;
  shader.uniforms.uRoot = grassColor.uRoot;
  shader.uniforms.uTip = grassColor.uTip;
  shader.uniforms.uRootBand = grassColor.uRootBand;
  shader.vertexShader = 'uniform float uWindTime;\nattribute float aWind;\nvarying float vGH;\n' + shader.vertexShader;
  shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n  vGH = aWind;');
  // Apply the sway in WORLD space (after the instance rotation), so EVERY blade leans the same
  // way regardless of its random yaw — coherent wind, not a random jitter. Phase from world XZ
  // makes the gust travel across the field as a wave; a tiny cross-flutter keeps it from looking
  // like one rigid shove.
  shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', `
    vec4 mvPosition = vec4( transformed, 1.0 );
    #ifdef USE_INSTANCING
      mvPosition = instanceMatrix * mvPosition;
    #endif
    vec4 worldPos = modelMatrix * mvPosition;
    float wPh  = worldPos.x * 0.11 + worldPos.z * 0.09 + uWindTime * 1.4;
    float gust = 0.55 + 0.45 * sin(wPh);                 // always leans INTO the wind, gusting stronger/weaker
    worldPos.x += aWind * 0.20 * gust;                   // wind blows toward +x (with a little +z)
    worldPos.z += aWind * 0.08 * gust;
    worldPos.x += aWind * 0.03 * sin(uWindTime * 4.5 + worldPos.z * 0.5);   // small flutter
    mvPosition = viewMatrix * worldPos;
    gl_Position = projectionMatrix * mvPosition;
  `);
  shader.fragmentShader = 'uniform vec3 uRoot;\nuniform vec3 uTip;\nuniform float uRootBand;\nvarying float vGH;\n' + shader.fragmentShader;
  shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `
    #include <color_fragment>
    float gg = clamp((vGH - uRootBand) / max(0.001, 1.0 - uRootBand), 0.0, 1.0);
    diffuseColor.rgb = mix(uRoot, uTip, gg);
  `);
};
GRASS_BLADE.customProgramCacheKey = () => 'grassblade_v1';
GRASS_BLADE.userData.grass = true;   // lets headless rigs identify grass instances
applyWind(LEAF, 0.03, 0.13, 1.0);                // tree + bush canopies breathe gently
applyWind(LEAF2, 0.03, 0.13, 1.0);
applyWind(PALM_FROND, 0.05, 0.13, 1.0);          // palm fronds wave at the tips

// Jitter an icosphere's vertices a little so blobs/rocks aren't perfectly round. IcosahedronGeometry
// is NON-indexed (each face has its own copy of every corner), so jittering in place pulls adjacent
// faces apart — the shape breaks into loose triangles (very visible on the grey rocks). Weld the
// duplicate corners first so each SHARED vertex moves once → the surface stays connected; then go
// back to non-indexed for flat shading.
function lumpy(geo, amt) {
  const welded = mergeVertices(geo);
  const p = welded.attributes.position;
  for (let i = 0; i < p.count; i++) {
    p.setXYZ(i,
      p.getX(i) * (1 + rand(-amt, amt)),
      p.getY(i) * (1 + rand(-amt, amt)),
      p.getZ(i) * (1 + rand(-amt, amt)));
  }
  const out = welded.toNonIndexed();
  out.computeVertexNormals();
  geo.dispose();
  return out;
}

// ── Inland flora ────────────────────────────────────────────────────────────

// Rounded leafy tree: tapered trunk + a clustered blobby canopy.
export function makeTree() {
  const g = new THREE.Group();
  const h = rand(1.3, 1.9);
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.2, h, 6), BARK);
  trunk.position.y = h / 2;
  g.add(trunk);
  const mat = Math.random() < 0.5 ? LEAF : LEAF2;
  const blobs = 2 + (Math.random() * 2 | 0);
  for (let i = 0; i < blobs; i++) {
    const r = rand(0.55, 0.85);
    const geo = lumpy(new THREE.IcosahedronGeometry(r, 0), 0.18);
    bakeWind(geo, 1);                     // whole canopy sways as one; the trunk (BARK) stays put
    const blob = new THREE.Mesh(geo, mat);
    blob.position.set(rand(-0.4, 0.4), h + rand(0.1, 0.8), rand(-0.4, 0.4));
    g.add(blob);
  }
  return g;
}

// Bare, spiky dead tree: thin trunk + a few angled branches.
export function makeDeadTree() {
  const g = new THREE.Group();
  const h = rand(1.8, 2.6);
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.16, h, 5), DRYBARK);
  trunk.position.y = h / 2;
  g.add(trunk);
  const branches = 3 + (Math.random() * 3 | 0);
  for (let i = 0; i < branches; i++) {
    const bl = rand(0.4, 0.9);
    const br = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.06, bl, 4), DRYBARK);
    br.position.y = bl / 2;
    const pivot = new THREE.Group();
    pivot.add(br);
    pivot.position.y = rand(h * 0.5, h * 0.95);
    pivot.rotation.z = rand(0.5, 1.1) * (Math.random() < 0.5 ? 1 : -1);
    pivot.rotation.y = Math.random() * Math.PI * 2;
    g.add(pivot);
  }
  return g;
}

// Low leafy bush: a couple of clustered blobs near the ground.
export function makeBush() {
  const g = new THREE.Group();
  const mat = Math.random() < 0.5 ? LEAF : LEAF2;
  const blobs = 2 + (Math.random() * 2 | 0);
  for (let i = 0; i < blobs; i++) {
    const r = rand(0.35, 0.55);
    const geo = lumpy(new THREE.IcosahedronGeometry(r, 0), 0.22);
    bakeWind(geo, 1);                     // bushes breathe with the same gentle canopy wind
    const blob = new THREE.Mesh(geo, mat);
    blob.position.set(rand(-0.35, 0.35), r * rand(0.7, 1.0), rand(-0.35, 0.35));
    g.add(blob);
  }
  return g;
}

// Small grass tuft: a few upright SPIKE blades (one flat triangle each — 1 tri, 12x leaner than
// the old 4-sided cone, and reads just as grassy at field density). All blades merge into ONE
// geometry so a whole tuft is a single instanced draw. The tuned look (lab): spike, unlit, a
// lighter-than-ground root gradient, ~1u tall, gentle lean.
export function makePlant() {
  const blades = [];
  const n = 3;
  for (let i = 0; i < n; i++) {
    const bl = rand(0.9, 1.05);                 // ~1u tall
    const w = 0.085;                            // half-width of the blade base
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-w, 0, 0, w, 0, 0, 0, bl, 0], 3));
    bakeWind(geo, 'tip');                        // aWind: base planted (0) → tip sways (1); also the gradient position
    // orient within the tuft: random spin + slight lean, jittered off the tuft centre
    const m = new THREE.Matrix4()
      .makeTranslation(rand(-0.14, 0.14), 0, rand(-0.14, 0.14))
      .multiply(new THREE.Matrix4().makeRotationY(Math.random() * Math.PI * 2))
      .multiply(new THREE.Matrix4().makeRotationZ(rand(-0.4, 0.4)));
    geo.applyMatrix4(m);
    blades.push(geo);
  }
  const g = new THREE.Group();
  g.add(new THREE.Mesh(mergeGeometries(blades), GRASS_BLADE));
  return g;
}

// Rock: a flattened lumpy icosphere.
export function makeRock() {
  const g = new THREE.Group();
  const r = rand(0.35, 0.6);
  // detail-1 icosphere + GENTLE lump = a rounded, faceted boulder (not a spiky crystal)
  const rock = new THREE.Mesh(lumpy(new THREE.IcosahedronGeometry(r, 1), 0.13), ROCK);
  rock.scale.y = rand(0.55, 0.8);          // squashed so it sits like a stone
  rock.position.y = r * 0.25;
  rock.rotation.set(rand(-0.2, 0.2), Math.random() * Math.PI * 2, rand(-0.2, 0.2));
  g.add(rock);
  return g;
}

// ── Beach palm ──────────────────────────────────────────────────────────────

// A single drooping frond blade along +X, tapering to a point, sagging in -Y.
function frondGeometry() {
  // Cross-sections along the blade: [x, yDroop, halfWidth]
  const sec = [
    [0.0, 0.00, 0.10],
    [0.7, 0.02, 0.26],
    [1.5, -0.10, 0.20],
    [2.3, -0.40, 0.11],
    [2.9, -0.85, 0.00],
  ];
  const pos = [];
  for (let i = 0; i < sec.length - 1; i++) {
    const [x0, y0, w0] = sec[i];
    const [x1, y1, w1] = sec[i + 1];
    // Two triangles forming the quad between section i and i+1.
    pos.push(x0, y0, -w0,  x1, y1, -w1,  x1, y1, w1);
    pos.push(x0, y0, -w0,  x1, y1, w1,   x0, y0, w0);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.scale(0.8, 1, 1);   // fronds at 80% length (deliberate choice)
  g.computeVertexNormals();
  return g;
}

export function makePalm() {
  const group = new THREE.Group();

  // Trunk: tapered, slightly curved (lean) cylinder.
  const H = 4.2;
  const trunk = new THREE.CylinderGeometry(0.12, 0.24, H, 6, 6, true);
  trunk.translate(0, H / 2, 0);
  const tp = trunk.attributes.position;
  for (let i = 0; i < tp.count; i++) {
    const y = tp.getY(i);
    const t = y / H;
    tp.setX(i, tp.getX(i) + Math.sin(t * 1.3) * 0.55);   // gentle curve
    tp.setZ(i, tp.getZ(i) + t * 0.12);
  }
  trunk.computeVertexNormals();
  const trunkTopX = Math.sin(1.3) * 0.55, trunkTopZ = 0.12;
  group.add(new THREE.Mesh(trunk, PALM_TRUNK));

  // Crown: a ring of fronds at the trunk top.
  const fronds = [];
  const N = 9;
  for (let i = 0; i < N; i++) {
    const f = frondGeometry();
    const yaw = (i / N) * Math.PI * 2 + Math.random() * 0.2;
    const tilt = -0.35 - Math.random() * 0.25;            // droop outward/down
    const m = new THREE.Matrix4()
      .makeTranslation(trunkTopX, H, trunkTopZ)
      .multiply(new THREE.Matrix4().makeRotationY(yaw))
      .multiply(new THREE.Matrix4().makeRotationZ(tilt));
    f.applyMatrix4(m);
    fronds.push(f);
  }
  const frondGeo = mergeGeometries(fronds);
  bakeWind(frondGeo, 'radial', trunkTopX, trunkTopZ);   // planted at the crown axis, tips wave
  group.add(new THREE.Mesh(frondGeo, PALM_FROND));

  // A couple of coconuts under the crown.
  const cocos = [];
  for (let i = 0; i < 3; i++) {
    const c = new THREE.IcosahedronGeometry(0.13, 0);
    const a = Math.random() * Math.PI * 2;
    c.translate(trunkTopX + Math.cos(a) * 0.18, H - 0.2, trunkTopZ + Math.sin(a) * 0.18);
    cocos.push(c);
  }
  group.add(new THREE.Mesh(mergeGeometries(cocos), PALM_COCO));

  return group;
}
