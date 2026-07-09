// Submarine.js — a lurking deep-water hazard. It sits submerged out past the islands and
// SURFACES when a flyer (Valkyrie) or the hovering Firebrat strays too far into open sea,
// then fires guided missiles to punish them back toward land. Angular stealth look: a dark
// faceted hull, a swept blade sail, and a single red sensor eye — meant to read as "do not
// come out here". Team-neutral: it hits whoever wandered into its water.
//
// The mesh maker (makeSubmarine) and the Sub class are self-contained; main.js spawns a few
// in the deep-water ring, feeds them the combatant list each tick, and provides a fireMissile
// callback (so the projectile/damage rules stay in one place).

import * as THREE from 'three';

const HULL  = () => new THREE.MeshStandardMaterial({ color: '#14171b', roughness: 0.55, metalness: 0.4, flatShading: true });
const KEEL  = () => new THREE.MeshStandardMaterial({ color: '#0c0e11', roughness: 0.7, metalness: 0.3, flatShading: true });
const TRIM  = () => new THREE.MeshStandardMaterial({ color: '#23262b', roughness: 0.5, metalness: 0.55, flatShading: true });
const EYE   = () => new THREE.MeshStandardMaterial({ color: '#ff2a1c', emissive: '#ff2a1c', emissiveIntensity: 1.2, roughness: 0.4 });
const REDLN = () => new THREE.MeshStandardMaterial({ color: '#7a1610', emissive: '#c01810', emissiveIntensity: 0.5, roughness: 0.6 });

// Forward = +Z, length along Z. Origin near the waterline deck (keel below, sail above).
export function makeSubmarine() {
  const g = new THREE.Group();

  // Main hull: a long hexagonal prism (flat deck + keel faces) — faceted, not round.
  const hull = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.5, 11, 6), HULL());
  hull.rotation.x = Math.PI / 2;          // lie along Z
  hull.rotation.z = Math.PI / 6;          // flat face up (deck) / down (keel)
  g.add(hull);
  // Sharp angular bow (6-sided cone) and a stubbier stern cone.
  const bow = new THREE.Mesh(new THREE.ConeGeometry(1.5, 5, 6), HULL());
  bow.rotation.x = Math.PI / 2; bow.rotation.z = Math.PI / 6; bow.position.z = 8; g.add(bow);
  const stern = new THREE.Mesh(new THREE.ConeGeometry(1.5, 2.6, 6), HULL());
  stern.rotation.x = -Math.PI / 2; stern.rotation.z = Math.PI / 6; stern.position.z = -6.3; g.add(stern);
  // Dark keel belly to ground the silhouette.
  const keel = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.8, 12), KEEL());
  keel.position.y = -1.15; g.add(keel);
  // A thin red waterline strip down each flank — the menacing accent.
  for (const s of [1, -1]) {
    const ln = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.16, 10.5), REDLN());
    ln.position.set(s * 1.32, 0.15, 0); g.add(ln);
  }

  // Swept blade SAIL (conning tower): an extruded stealth profile, thin across the beam.
  const p = new THREE.Shape();
  p.moveTo(-1.7, 0); p.lineTo(1.7, 0); p.lineTo(0.65, 1.55); p.lineTo(-1.15, 2.75); p.closePath();
  const sailGeo = new THREE.ExtrudeGeometry(p, { depth: 0.95, bevelEnabled: false });
  sailGeo.translate(0, 0, -0.475);
  const sail = new THREE.Mesh(sailGeo, HULL());
  sail.rotation.y = -Math.PI / 2;         // fore/aft profile → along Z, thickness → across X
  sail.position.set(0, 1.35, 0.8); g.add(sail);
  // A trim edge along the sail's leading spine.
  const spine = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.16, 2.0), TRIM());
  spine.position.set(0, 2.4, 0.35); spine.rotation.x = -0.5; g.add(spine);
  // Sail dive planes — small swept fins either side.
  for (const s of [1, -1]) {
    const fin = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.12, 0.7), TRIM());
    fin.position.set(s * 0.7, 1.9, 0.7); fin.rotation.y = s * 0.25; g.add(fin);
  }
  // The single red SENSOR EYE on the sail's forward face.
  const eye = new THREE.Mesh(new THREE.OctahedronGeometry(0.3), EYE());
  eye.position.set(0, 2.15, 1.55); g.add(eye);
  g.userData.eyeMat = eye.material;

  // Stern control surfaces: a tall rudder + horizontal planes.
  const rudder = new THREE.Mesh(new THREE.BoxGeometry(0.16, 2.0, 1.6), TRIM());
  rudder.position.set(0, 0.7, -5.6); g.add(rudder);
  for (const s of [1, -1]) {
    const pln = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.14, 1.2), TRIM());
    pln.position.set(s * 1.0, 0, -5.4); pln.rotation.y = s * 0.18; g.add(pln);
  }
  // Two dark missile hatches flush on the deck.
  for (const dz of [2.2, 3.6]) {
    const hatch = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.14, 6), KEEL());
    hatch.position.set(0, 1.32, dz); g.add(hatch);
  }
  return g;
}

// One sub is spawned ON DEMAND right where an intruder strayed (see main.js) — it doesn't exist
// otherwise. It rises through the surface, shells the target, and once the target is gone it
// dives and asks to be removed from the scene. No movement/nav: it emerges, attacks, submerges.
const SUBMERGED_Y = -6.5;    // deck well under the surface (fully hidden before it emerges)
const SURFACED_Y  = -0.4;    // deck just breaks the waterline, sail well clear
const RISE_SPEED  = 4.5;     // u/s emerge/submerge speed
const FIRE_EVERY  = 2.2;     // s between missiles while surfaced
const LOSE_AFTER  = 3.0;     // s with no target → dive and despawn

export class Sub {
  constructor(scene, x, z, yaw = 0) {
    this.group = makeSubmarine();
    this.x = x; this.z = z;
    this.y = SUBMERGED_Y;      // starts hidden, rises on first update
    this.yaw = yaw;
    this.state = 'surfacing';  // surfacing | surfaced | diving
    this.fireT = 0.7;          // brief beat after breaching before the first shot
    this.loseT = 0;
    this.eyeMat = this.group.userData.eyeMat;
    scene.add(this.group);
    this._apply();
  }
  _apply() {
    this.group.position.set(this.x, this.y, this.z);
    this.group.rotation.y = this.yaw;
    if (this.eyeMat) this.eyeMat.emissiveIntensity = this.state === 'diving' ? 0.3 : 1.2;
  }

  // tgt: the intruder to fire on (or null once it fled). ctx.fire(sub, tgt) launches a missile.
  // Returns TRUE when it has fully submerged again → main.js removes it from the scene.
  update(dt, tgt, ctx) {
    if (tgt) {
      this.loseT = 0;
      if (this.state === 'diving') this.state = 'surfacing';   // it came back — rise again
      const want = Math.atan2(tgt.holder.position.x - this.x, tgt.holder.position.z - this.z);
      let dy = want - this.yaw; while (dy > Math.PI) dy -= 2 * Math.PI; while (dy < -Math.PI) dy += 2 * Math.PI;
      this.yaw += Math.max(-1.6 * dt, Math.min(1.6 * dt, dy));   // keep the bow on the target
    } else {
      this.loseT += dt;
      if (this.state !== 'diving' && this.loseT > LOSE_AFTER) this.state = 'diving';
    }

    if (this.state === 'surfacing') {
      this.y = Math.min(SURFACED_Y, this.y + RISE_SPEED * dt);
      if (this.y >= SURFACED_Y - 0.01) this.state = 'surfaced';
    } else if (this.state === 'diving') {
      this.y = Math.max(SUBMERGED_Y, this.y - RISE_SPEED * dt);
      if (this.y <= SUBMERGED_Y + 0.01) { this._apply(); return true; }   // gone under → despawn
    }
    if (this.state === 'surfaced') this.y = SURFACED_Y + Math.sin(performance.now() / 600 + this.x) * 0.12;

    if (this.state === 'surfaced' && tgt) {
      this.fireT -= dt;
      if (this.fireT <= 0) { this.fireT = FIRE_EVERY; ctx.fire(this, tgt); }
    }
    this._apply();
    return false;
  }

  // World muzzle point: top of the sail, a touch forward.
  muzzle() {
    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
    return new THREE.Vector3(this.x + fx * 1.2, this.y + 2.6, this.z + fz * 1.2);
  }
  dispose() { this.group.parent && this.group.parent.remove(this.group); }
}
