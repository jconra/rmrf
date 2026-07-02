// Scrap.js — SALVAGE pickups: 1 unit each. TWO looks:
//   PARTS   (makePartsPallet) — an ORGANIZED delivery: a pallet of crates strapped down,
//            like a parachute/shore drop. Scattered in remote corners of the map.
//   WRECKAGE (makeWreckage)   — a BLOWN-UP vehicle: bent camo armor plates, cones, black
//            cylinders, charred debris. Left behind where a vehicle dies.
// Both give the same scrap. Pure mesh factories (chunky/faceted/dark, like the vehicles);
// gameplay (drop, pickup, counter) lives in main.js. `s` is the build-grid cell size.
// Jacob refines these in the asset-designer — keep them simple.

import * as THREE from 'three';

const WOOD   = () => new THREE.MeshStandardMaterial({ color: 0x6b4a2b, roughness: 0.9, metalness: 0.05, flatShading: true });
const CRATE  = () => new THREE.MeshStandardMaterial({ color: 0x7a6033, roughness: 0.85, metalness: 0.08, flatShading: true });
const METAL  = () => new THREE.MeshStandardMaterial({ color: 0x50565c, roughness: 0.6,  metalness: 0.7,  flatShading: true });
const STRAP  = () => new THREE.MeshStandardMaterial({ color: 0x4a4b2c, roughness: 0.95, metalness: 0.05, flatShading: true });   // olive cargo strap
const CHAR   = () => new THREE.MeshStandardMaterial({ color: 0x1d1a16, roughness: 1.0,  metalness: 0.1,  flatShading: true });
const DARKM  = () => new THREE.MeshStandardMaterial({ color: 0x24262a, roughness: 0.7,  metalness: 0.6,  flatShading: true });

// ---- PARTS: a strapped pallet of crates (organized delivery) ----------------
export function makePartsPallet(s = 5) {
  const g = new THREE.Group();
  const W = s * 0.9;

  // wooden pallet: runners + slats
  const runnerY = s * 0.05;
  for (const rx of [-0.34, 0.34]) {
    const runner = new THREE.Mesh(new THREE.BoxGeometry(s * 0.1, s * 0.1, W), WOOD());
    runner.position.set(rx * W, runnerY, 0); g.add(runner);
  }
  for (let i = -2; i <= 2; i++) {
    const slat = new THREE.Mesh(new THREE.BoxGeometry(W, s * 0.05, s * 0.12), WOOD());
    slat.position.set(0, runnerY + s * 0.07, i * W * 0.22); g.add(slat);
  }
  const deckY = runnerY + s * 0.1;

  // crate stack (a couple big crates + a metal case + a small box)
  const crates = [
    { w: 0.5,  h: 0.34, d: 0.5,  x: -0.16, z: -0.12, y: 0,    mat: CRATE },
    { w: 0.42, h: 0.3,  d: 0.44, x: 0.22,  z: 0.16,  y: 0,    mat: CRATE },
    { w: 0.36, h: 0.24, d: 0.4,  x: -0.02, z: -0.02, y: 0.34, mat: METAL },   // team-stripe case
    { w: 0.24, h: 0.2,  d: 0.24, x: 0.24,  z: -0.2,  y: 0.3,  mat: CRATE },
  ];
  let topCrate = null, topY = deckY;
  for (const c of crates) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(c.w * s, c.h * s, c.d * s), c.mat());
    m.position.set(c.x * s, deckY + (c.y + c.h / 2) * s, c.z * s);
    m.rotation.y = (c.x + c.z) * 0.25;
    g.add(m);
    topY = Math.max(topY, deckY + (c.y + c.h) * s);
    if (c.mat === METAL) topCrate = m;
    if (c.mat === CRATE && c.w > 0.4) {   // batten boards on the big crates
      const bat = new THREE.Mesh(new THREE.BoxGeometry(c.w * s * 1.02, s * 0.04, s * 0.05), WOOD());
      bat.position.copy(m.position); bat.rotation.y = m.rotation.y; g.add(bat);
    }
  }

  // two clean olive cargo straps OVER the top and down the sides (no black net)
  const strapT = 0.035 * s, strapW = 0.12 * s, half = W * 0.5;
  const strap = (offX) => {
    const top = new THREE.Mesh(new THREE.BoxGeometry(strapW, strapT, W * 1.04), STRAP());
    top.position.set(offX, topY + strapT * 0.5, 0); g.add(top);
    for (const sz of [-1, 1]) {   // down the front & back faces
      const side = new THREE.Mesh(new THREE.BoxGeometry(strapW, topY - deckY, strapT), STRAP());
      side.position.set(offX, deckY + (topY - deckY) * 0.5, sz * half); g.add(side);
    }
  };
  strap(-W * 0.22); strap(W * 0.22);

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

  // charred scorch patch on the ground
  const scar = new THREE.Mesh(new THREE.CylinderGeometry(s * 0.75, s * 0.8, s * 0.03, 12), CHAR());
  scar.position.y = s * 0.015; g.add(scar);

  // bent CAMO armor plates (tinted to the destroyed vehicle's team via setTeamColor)
  const plates = [];
  const plateSpec = [
    { w: 0.6, h: 0.04, d: 0.45, x: -0.1, y: 0.16, z: 0.05, rx: 0.5, ry: 0.3, rz: -0.25 },
    { w: 0.5, h: 0.04, d: 0.4,  x: 0.22, y: 0.1,  z: -0.1, rx: -0.35, ry: -0.6, rz: 0.4 },
    { w: 0.34, h: 0.035, d: 0.3, x: 0.02, y: 0.28, z: 0.18, rx: 0.9, ry: 0.2, rz: 0.15 },
  ];
  for (const p of plateSpec) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(p.w * s, p.h * s, p.d * s),
      new THREE.MeshStandardMaterial({ color: 0x545a49, roughness: 0.75, metalness: 0.4, flatShading: true }));
    m.position.set(p.x * s, p.y * s, p.z * s);
    m.rotation.set(p.rx, p.ry, p.rz);
    g.add(m); plates.push(m);
  }

  // black cylinders — a barrel on its side + a bent pipe/exhaust jutting up
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(s * 0.14, s * 0.14, s * 0.5, 10), DARKM());
  barrel.rotation.z = Math.PI / 2; barrel.rotation.y = 0.4;
  barrel.position.set(-s * 0.28, s * 0.14, -s * 0.2); g.add(barrel);
  const pipe = new THREE.Mesh(new THREE.CylinderGeometry(s * 0.05, s * 0.06, s * 0.5, 8), DARKM());
  pipe.rotation.set(0.5, 0, 0.6); pipe.position.set(s * 0.26, s * 0.24, s * 0.16); g.add(pipe);

  // dark cones — nose/tip debris, tipped over
  const cone1 = new THREE.Mesh(new THREE.ConeGeometry(s * 0.17, s * 0.34, 8), DARKM());
  cone1.rotation.z = Math.PI * 0.62; cone1.position.set(s * 0.32, s * 0.13, -s * 0.24); g.add(cone1);
  const cone2 = new THREE.Mesh(new THREE.ConeGeometry(s * 0.12, s * 0.26, 7), DARKM());
  cone2.rotation.x = 0.4; cone2.position.set(-s * 0.05, s * 0.14, s * 0.3); g.add(cone2);

  // a few small charred chunks
  for (let i = 0; i < 4; i++) {
    const c = new THREE.Mesh(new THREE.BoxGeometry(s * 0.1, s * 0.1, s * 0.12), CHAR());
    const a = Math.random() * Math.PI * 2, r = s * (0.15 + Math.random() * 0.4);
    c.position.set(Math.cos(a) * r, s * 0.05, Math.sin(a) * r);
    c.rotation.set(Math.random(), Math.random(), Math.random()); g.add(c);
  }

  // faint ember so it reads as "just destroyed"
  const ember = new THREE.Mesh(new THREE.BoxGeometry(s * 0.08, s * 0.05, s * 0.08),
    new THREE.MeshStandardMaterial({ color: 0xff5a1e, emissive: 0xff5a1e, emissiveIntensity: 0.7, roughness: 1 }));
  ember.position.set(0, s * 0.08, 0); g.add(ember);

  g.userData.setTeamColor = (hex) => {
    for (const m of plates) m.material = new THREE.MeshStandardMaterial({ color: hex, roughness: 0.75, metalness: 0.45, flatShading: true });
  };
  return g;
}

// Back-compat alias (main.js may still import makeScrapPile).
export const makeScrapPile = makePartsPallet;
