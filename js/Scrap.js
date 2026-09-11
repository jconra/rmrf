// Scrap.js — SALVAGE pickups: 1 unit each. TWO looks:
//   PARTS   (makePartsPallet) — an ORGANIZED delivery: a pallet of crates strapped down,
//            like a parachute/shore drop. Scattered in remote corners of the map.
//   WRECKAGE (makeWreckage)   — a BLOWN-UP vehicle: bent camo armor plates, cones, black
//            cylinders, charred debris. Left behind where a vehicle dies.
// Both give the same scrap. Pure mesh factories (chunky/faceted/dark, like the vehicles);
// gameplay (drop, pickup, counter) lives in main.js. `s` is the build-grid cell size.
// Jacob refines these in the asset-designer — keep them simple.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { getCamoTextures } from './CamoTexture.js';

// ONE MESH PER MATERIAL, AND THE MATERIALS ARE SHARED. Both piles used to be built as a Group of
// little Meshes, each calling a material FACTORY — so a pallet was 24 meshes and 24 unique
// MeshStandardMaterials. That is affordable for the dozen scattered at map build and badly wrong
// for the path that fires most: dropTowerScrap throws up to SIX pallets per upgraded tower, and a
// contested base loses every tower it has. Four towers falling was ~576 meshes and ~576 materials.
//
// Nothing here is animated and nothing moves relative to the pile, so every part in a given
// material can be baked into one geometry — the same trick MergeParts.js does for the vehicles,
// which are ~70 meshes over 3-4 materials. Pallet: 24 -> 4. Wreckage: 8 -> 5.
//
// The TINTED parts stay on their own mesh with their own material, because setTeamColor/setCamo
// replace it per pile — sharing those would repaint every pile on the map.
const WOOD  = new THREE.MeshStandardMaterial({ color: 0x6b4a2b, roughness: 0.9, metalness: 0.05, flatShading: true });
const CRATE = new THREE.MeshStandardMaterial({ color: 0x7a6033, roughness: 0.85, metalness: 0.08, flatShading: true });
const STRAP = new THREE.MeshStandardMaterial({ color: 0x4a4b2c, roughness: 0.95, metalness: 0.05, flatShading: true });   // olive cargo strap
const CHAR  = new THREE.MeshStandardMaterial({ color: 0x1d1a16, roughness: 1.0,  metalness: 0.1,  flatShading: true });
const DARKM = new THREE.MeshStandardMaterial({ color: 0x24262a, roughness: 0.7,  metalness: 0.6,  flatShading: true });
const SCARM = new THREE.MeshStandardMaterial({ color: 0x342a20, roughness: 1.0, metalness: 0.0, flatShading: true });
const EMBER = new THREE.MeshStandardMaterial({ color: 0xff5a1e, emissive: 0xff5a1e, emissiveIntensity: 0.7, roughness: 1 });
// Per-pile because setTeamColor swaps it: the neutral look before a team owns the drop.
const metalMat = () => new THREE.MeshStandardMaterial({ color: 0x50565c, roughness: 0.6, metalness: 0.7, flatShading: true });
const plateMat = () => new THREE.MeshStandardMaterial({ color: 0x5b6150, roughness: 0.75, metalness: 0.4, flatShading: true });

// A bucket collects { geo, x,y,z, rx,ry,rz } and bakes them into a single geometry. The transform
// goes INTO the vertices, so the merged mesh sits at the group origin and looks identical.
const _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _v = new THREE.Vector3(), _one = new THREE.Vector3(1, 1, 1);
function bucket() { return []; }
function put(b, geo, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) { b.push({ geo, x, y, z, rx, ry, rz }); return b[b.length - 1]; }
function bake(b, mat) {
  if (!b.length) return null;
  const parts = b.map(p => {
    _m4.compose(_v.set(p.x, p.y, p.z), _q.setFromEuler(_e.set(p.rx, p.ry, p.rz)), _one);
    return p.geo.clone().applyMatrix4(_m4);
  });
  const merged = mergeGeometries(parts, false);
  for (const g of parts) g.dispose();
  for (const p of b) p.geo.dispose();
  return new THREE.Mesh(merged, mat);
}

// ---- PARTS: a strapped pallet of crates (organized delivery) ----------------
export function makePartsPallet(s = 5) {
  const g = new THREE.Group();
  const W = s * 0.9;
  const wood = bucket(), crates = bucket(), straps = bucket();

  // wooden pallet: runners + slats
  const runnerY = s * 0.05;
  for (const rx of [-0.34, 0.34]) put(wood, new THREE.BoxGeometry(s * 0.1, s * 0.1, W), rx * W, runnerY, 0);
  for (let i = -2; i <= 2; i++) put(wood, new THREE.BoxGeometry(W, s * 0.05, s * 0.12), 0, runnerY + s * 0.07, i * W * 0.22);
  const deckY = runnerY + s * 0.1;

  // crate stack (a couple big crates + a metal case + a small box)
  const spec = [
    { w: 0.5,  h: 0.34, d: 0.5,  x: -0.16, z: -0.12, y: 0,    metal: false },
    { w: 0.42, h: 0.3,  d: 0.44, x: 0.22,  z: 0.16,  y: 0,    metal: false },
    { w: 0.36, h: 0.24, d: 0.4,  x: -0.02, z: -0.02, y: 0.34, metal: true  },   // team-stripe case
    { w: 0.24, h: 0.2,  d: 0.24, x: 0.24,  z: -0.2,  y: 0.3,  metal: false },
  ];
  let topCrate = null, topY = deckY;
  for (const c of spec) {
    const cy = deckY + (c.y + c.h / 2) * s, ry = (c.x + c.z) * 0.25;
    if (c.metal) {
      // The one tinted part keeps its own mesh — setTeamColor replaces this material per pile.
      topCrate = new THREE.Mesh(new THREE.BoxGeometry(c.w * s, c.h * s, c.d * s), metalMat());
      topCrate.position.set(c.x * s, cy, c.z * s); topCrate.rotation.y = ry; g.add(topCrate);
    } else {
      put(crates, new THREE.BoxGeometry(c.w * s, c.h * s, c.d * s), c.x * s, cy, c.z * s, 0, ry, 0);
      if (c.w > 0.4) put(wood, new THREE.BoxGeometry(c.w * s * 1.02, s * 0.04, s * 0.05), c.x * s, cy, c.z * s, 0, ry, 0);   // batten boards
    }
    topY = Math.max(topY, deckY + (c.y + c.h) * s);
  }

  // two clean olive cargo straps OVER the top and down the sides (no black net)
  const strapT = 0.035 * s, strapW = 0.12 * s, half = W * 0.5;
  for (const offX of [-W * 0.22, W * 0.22]) {
    put(straps, new THREE.BoxGeometry(strapW, strapT, W * 1.04), offX, topY + strapT * 0.5, 0);
    for (const sz of [-1, 1]) put(straps, new THREE.BoxGeometry(strapW, topY - deckY, strapT), offX, deckY + (topY - deckY) * 0.5, sz * half);
  }

  for (const [b, m] of [[wood, WOOD], [crates, CRATE], [straps, STRAP]]) { const mesh = bake(b, m); if (mesh) g.add(mesh); }

  g.userData.setTeamColor = (hex) => {
    if (!topCrate) return;
    topCrate.material = new THREE.MeshStandardMaterial({ color: hex, roughness: 0.5, metalness: 0.5,
      emissive: hex, emissiveIntensity: 0.15, flatShading: true });
  };
  return g;
}

// ---- WRECKAGE: a blown-up vehicle (debris) ----------------------------------
export function makeWreckage(s = 5) {
  const g = new THREE.Group();
  const dark = bucket(), char = bucket();

  // small, subtle scorch under the debris (not a big black disc) — dark charred earth
  const scar = new THREE.Mesh(new THREE.CylinderGeometry(s * 0.44, s * 0.5, s * 0.02, 12), SCARM);
  scar.position.y = s * 0.01; g.add(scar);

  // two bent CAMO armor plates — the actual team camo goes on these via setCamo(). They share ONE
  // material (setCamo always assigned the same one to both), so they merge into a single mesh.
  const pb = bucket();
  for (const p of [
    { w: 0.58, h: 0.05, d: 0.44, x: -0.08, y: 0.15, z: 0.04, rx: 0.5, ry: 0.3, rz: -0.22 },
    { w: 0.48, h: 0.05, d: 0.38, x: 0.2,  y: 0.1,  z: -0.1, rx: -0.32, ry: -0.6, rz: 0.4 },
  ]) put(pb, new THREE.BoxGeometry(p.w * s, p.h * s, p.d * s), p.x * s, p.y * s, p.z * s, p.rx, p.ry, p.rz);
  const plate = bake(pb, plateMat());
  g.add(plate);

  // one black cylinder (barrel on its side) + a dark cone (nose debris) — the "cones + black
  // cylinders" of a blown-up vehicle, kept sparse so it doesn't read as a heap.
  put(dark, new THREE.CylinderGeometry(s * 0.13, s * 0.13, s * 0.46, 10), -s * 0.26, s * 0.13, -s * 0.16, 0, 0.4, Math.PI / 2);
  put(dark, new THREE.ConeGeometry(s * 0.16, s * 0.32, 8), s * 0.3, s * 0.12, -s * 0.2, 0, 0, Math.PI * 0.6);

  // a couple of small charred chunks (deterministic offsets so it's stable across renders)
  for (const ch of [{ x: 0.24, z: 0.22 }, { x: -0.12, z: 0.28 }])
    put(char, new THREE.BoxGeometry(s * 0.1, s * 0.09, s * 0.12), ch.x * s, s * 0.05, ch.z * s, 0.4, ch.x * 3, 0.3);

  for (const [b, m] of [[dark, DARKM], [char, CHAR]]) { const mesh = bake(b, m); if (mesh) g.add(mesh); }

  // faint ember so it reads as "just destroyed"
  const ember = new THREE.Mesh(new THREE.BoxGeometry(s * 0.07, s * 0.045, s * 0.07), EMBER);
  ember.position.set(0, s * 0.08, 0); g.add(ember);

  // Apply the destroyed vehicle's TEAM CAMO to the armor plates (per-team camo canvas,
  // tiled up so the pattern reads at plate scale). Falls back to a flat tint if unavailable.
  g.userData.setCamo = (colorIndex) => {
    try {
      const map = getCamoTextures(colorIndex).map.clone();
      map.needsUpdate = true; map.repeat.set(2.4, 2.4);
      plate.material = new THREE.MeshStandardMaterial({ map, roughness: 0.75, metalness: 0.4, flatShading: true });
    } catch (e) { /* keep the neutral plate colour */ }
  };
  g.userData.setTeamColor = (hex) => {
    plate.material = new THREE.MeshStandardMaterial({ color: hex, roughness: 0.75, metalness: 0.4, flatShading: true });
  };
  return g;
}

// ---- SALVAGE HEAP: the cheap one -------------------------------------------
// A third look, for the sources that produce a LOT of piles — a destroyed tower spills one per
// upgrade star, and a scrap generator would emit them continuously. Jacob: "scrap doesn't need to
// look great." So it is four boxes of bent plate and broken casing in ONE shared material, merged
// into ONE mesh: 48 triangles, 1 draw call, no per-pile tint. The pallet and the wreck keep their
// detail because they carry meaning — an organised delivery, and somewhere a vehicle died. This
// carries none: it is the debris a structure sheds, and it should cost accordingly.
//
// Deliberately identical every time. addScrapPile spins each one on Y, which is enough to stop a
// scattering reading as copies, and staying identical is what would let a high-volume emitter draw
// all of them as a single InstancedMesh later without changing the look.
const SALVAGE = new THREE.MeshStandardMaterial({ color: 0x4a4238, roughness: 0.92, metalness: 0.35, flatShading: true });
// SHARED — one instance behind every pile of that kind. Marked so freeing a collected pile disposes
// its geometry without destroying a material the rest of the map is still drawing with.
for (const m of [WOOD, CRATE, STRAP, CHAR, DARKM, SCARM, EMBER, SALVAGE]) m.userData.shared = true;
export function makeSalvageHeap(s = 5) {
  const g = new THREE.Group();
  const b = bucket();
  // one big bent plate lying over the rest, then broken casing around it
  // Sized to be FINDABLE, not to be pretty. At half a pallet's footprint it read as a pebble on
  // grass from the game camera; roughly three quarters is enough to spot without pretending to be
  // a delivery. (The pickup radius is 8 either way — this is about the player's eyes, not the rules.)
  put(b, new THREE.BoxGeometry(s * 0.58, s * 0.07, s * 0.46), 0,          s * 0.15, 0,          0.22, 0.4,  -0.15);
  put(b, new THREE.BoxGeometry(s * 0.28, s * 0.19, s * 0.25), -s * 0.22,  s * 0.10, s * 0.14,   0,    0.7,   0);
  put(b, new THREE.BoxGeometry(s * 0.22, s * 0.15, s * 0.30), s * 0.25,   s * 0.07, -s * 0.11,  0,   -0.5,   0.12);
  put(b, new THREE.BoxGeometry(s * 0.17, s * 0.12, s * 0.17), s * 0.08,   s * 0.06, s * 0.26,   0.3,  1.1,   0);
  g.add(bake(b, SALVAGE));
  return g;
}

// Back-compat alias (main.js may still import makeScrapPile).
export const makeScrapPile = makePartsPallet;
