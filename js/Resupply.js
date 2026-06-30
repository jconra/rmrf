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
import { hazardTexture } from './Textures.js?v=2';
import { buildAssetGroup } from './AssetBuilder.js?v=1';
import AMMO_SUPPLY_CFG from './ammo_supply.config.js?v=1';

// kind → the colour that reads its function (tank bands, depot trim, emitter glow)
export const RESUPPLY_TINT = { fuel: 0xff8a3d, ammo: 0x7fd44b, shield: 0x46d6ff };

const STEEL = () => new THREE.MeshStandardMaterial({ color: 0x6c7178, roughness: 0.7, metalness: 0.6 });
const DARK  = () => new THREE.MeshStandardMaterial({ color: 0x3a3f45, roughness: 0.8, metalness: 0.4 });

// Shared yellow/black caution map for the "drive up here" floor strips.
const HAZARD_TEX = hazardTexture();

// A flat hazard-striped ground strip — a "pull up here to use me" cue laid on the
// ground flanking each supply point. `len` runs along local Z; the texture tiles
// along the length so the stripe size stays consistent whatever the strip's size.
function hazardStrip(s, len) {
  const w = s * 0.22;
  const tex = HAZARD_TEX.clone();
  tex.repeat.set(1, Math.max(2, Math.round(len / (s * 0.4))));   // even stripes down the length
  tex.needsUpdate = true;
  const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.8, metalness: 0.05 });
  const strip = new THREE.Mesh(new THREE.BoxGeometry(w, s * 0.04, len), mat);
  strip.position.y = s * 0.02;   // just above the ground so it doesn't z-fight terrain
  return strip;
}

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
  // "drive up here" hazard strips flanking the tank
  for (const sx of [-1, 1]) {
    const strip = hazardStrip(s, s * 0.8);
    strip.position.set(sx * (len * 0.5 + s * 0.2), s * 0.02, 0);
    g.add(strip);
  }
  return g;
}

// Ammo supply depot — Jacob's asset-designer build (js/ammo_supply.config.js): a
// hazard-striped pad of shell crates, lying/standing shells (finned like the Valkyrie
// missiles), green ammo cases and dark crates. Assembled by the shared AssetBuilder.
export function makeAmmoDepot(s = 5) {
  return buildAssetGroup(AMMO_SUPPLY_CFG, RESUPPLY_TINT.ammo, { cell: s });
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
  // "drive up here" hazard strips flanking the generator
  for (const sx of [-1, 1]) {
    const strip = hazardStrip(s, s * 0.9);
    strip.position.set(sx * (s * 0.55 + s * 0.2), s * 0.02, 0);
    g.add(strip);
  }
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
