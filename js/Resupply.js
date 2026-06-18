// Resupply.js — neutral, contested points of interest scattered on the map:
//   FUEL TANK     — drive near it to refill fuel
//   AMMO DEPOT    — drive near it to rearm
//   SHIELD GENERATOR — drive near it to pick up a SHIELD (an HP pool that absorbs
//                      damage before the hull, GoldenEye body-armour style)
// Any vehicle of either team can use them; each is destructible, so a side can
// blow one up to DENY it to the enemy. Pure mesh factories here — the gameplay
// (proximity refill, destruction bookkeeping) lives in main.js, same split as
// Buildings.js. `s` is the build-grid cell size, so props scale with the map.

import * as THREE from 'three';

// kind → the colour that reads its function (tank bands, depot trim, emitter glow)
export const RESUPPLY_TINT = { fuel: 0xff8a3d, ammo: 0x7fd44b, shield: 0x46d6ff };

const STEEL = () => new THREE.MeshStandardMaterial({ color: 0x6c7178, roughness: 0.7, metalness: 0.6 });
const DARK  = () => new THREE.MeshStandardMaterial({ color: 0x3a3f45, roughness: 0.8, metalness: 0.4 });

// Horizontal pressure tank on short legs, with painted hazard bands.
export function makeFuelTank(s = 5) {
  const g = new THREE.Group();
  const r = s * 0.28, len = s * 0.95;
  const tank = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 16), STEEL());
  tank.rotation.z = Math.PI / 2;
  tank.position.y = r + s * 0.18;
  g.add(tank);
  // end caps
  for (const sx of [-1, 1]) {
    const cap = new THREE.Mesh(new THREE.SphereGeometry(r, 14, 10), STEEL());
    cap.position.set(sx * len / 2, tank.position.y, 0);
    g.add(cap);
  }
  // hazard bands
  const bandMat = new THREE.MeshStandardMaterial({ color: RESUPPLY_TINT.fuel, roughness: 0.6, emissive: RESUPPLY_TINT.fuel, emissiveIntensity: 0.18 });
  for (const bx of [-0.22, 0.22]) {
    const band = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.02, r * 1.02, len * 0.12, 16), bandMat);
    band.rotation.z = Math.PI / 2;
    band.position.set(bx * len, tank.position.y, 0);
    g.add(band);
  }
  // legs + a feed pipe
  for (const lx of [-1, 1]) for (const lz of [-1, 1]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(s * 0.07, s * 0.4, s * 0.07), DARK());
    leg.position.set(lx * len * 0.32, s * 0.2, lz * r * 0.6);
    g.add(leg);
  }
  const pipe = new THREE.Mesh(new THREE.CylinderGeometry(s * 0.05, s * 0.05, s * 0.5, 8), DARK());
  pipe.position.set(len * 0.5, s * 0.45, 0);
  g.add(pipe);
  return g;
}

// Low concrete bunker with a stack of shell crates on top.
export function makeAmmoDepot(s = 5) {
  const g = new THREE.Group();
  const bunker = new THREE.Mesh(new THREE.BoxGeometry(s * 0.95, s * 0.5, s * 0.7),
    new THREE.MeshStandardMaterial({ color: 0x5a5e52, roughness: 0.95, metalness: 0.1 }));
  bunker.position.y = s * 0.25;
  g.add(bunker);
  // sloped roof slab
  const roof = new THREE.Mesh(new THREE.BoxGeometry(s * 1.0, s * 0.08, s * 0.78), DARK());
  roof.position.y = s * 0.5;
  g.add(roof);
  const crateMat = new THREE.MeshStandardMaterial({ color: RESUPPLY_TINT.ammo, roughness: 0.85, emissive: RESUPPLY_TINT.ammo, emissiveIntensity: 0.12 });
  const crate = (x, y, z, w) => {
    const c = new THREE.Mesh(new THREE.BoxGeometry(w, w * 0.7, w), crateMat);
    c.position.set(x, y, z); g.add(c);
  };
  const cw = s * 0.26;
  crate(-cw * 0.6, s * 0.5 + cw * 0.35, -cw * 0.3, cw);
  crate(cw * 0.6, s * 0.5 + cw * 0.35, -cw * 0.1, cw);
  crate(0, s * 0.5 + cw * 0.35, cw * 0.5, cw);
  crate(0, s * 0.5 + cw * 1.05, cw * 0.1, cw * 0.9);
  return g;
}

// A squat machine with a glowing emitter orb on a pylon + spinning collar.
export function makeShieldGenerator(s = 5) {
  const g = new THREE.Group();
  const base = new THREE.Mesh(new THREE.CylinderGeometry(s * 0.45, s * 0.55, s * 0.3, 12), STEEL());
  base.position.y = s * 0.15;
  g.add(base);
  const pylon = new THREE.Mesh(new THREE.CylinderGeometry(s * 0.12, s * 0.16, s * 0.55, 8), DARK());
  pylon.position.y = s * 0.55;
  g.add(pylon);
  const coreMat = new THREE.MeshBasicMaterial({ color: RESUPPLY_TINT.shield, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending });
  const core = new THREE.Mesh(new THREE.IcosahedronGeometry(s * 0.22, 1), coreMat);
  core.position.y = s * 0.95;
  g.add(core);
  // a torus collar that the gameplay code spins for an "active" read
  const ringMat = new THREE.MeshBasicMaterial({ color: RESUPPLY_TINT.shield, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending });
  const ring = new THREE.Mesh(new THREE.TorusGeometry(s * 0.33, s * 0.03, 8, 24), ringMat);
  ring.rotation.x = Math.PI / 2;
  ring.position.y = s * 0.95;
  g.add(ring);
  g.userData.spin = ring;      // main.js rotates this each frame while alive
  g.userData.core = core;
  return g;
}

// The force-field shell drawn around a shielded vehicle. `r` ≈ the vehicle's
// bounding radius. Returns a mesh whose opacity the caller pulses on hit.
export function makeShieldBubble(r = 4) {
  const mat = new THREE.MeshBasicMaterial({
    color: RESUPPLY_TINT.shield, transparent: true, opacity: 0.22,
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    wireframe: true,
  });
  const mesh = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 2), mat);
  mesh.scale.set(1, 0.7, 1);   // squashed dome over the hull
  mesh.renderOrder = 5;
  return mesh;
}
