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
import { buildAssetGroup } from './AssetBuilder.js?v=1';
import SUBMARINE_CFG from './submarine.config.js?v=1';

const EYE    = () => new THREE.MeshStandardMaterial({ color: '#ff2a1c', emissive: '#ff2a1c', emissiveIntensity: 1.2, roughness: 0.4 });
const SOCKET = () => new THREE.MeshStandardMaterial({ color: '#14171b', roughness: 0.6, metalness: 0.45, flatShading: true });

// Forward = +Z, length along Z. Origin near the waterline deck (keel below, sail above).
// The hull is the asset-designer export (submarine.config.js), rendered through the shared
// buildAssetGroup path so a designer re-export updates the in-game hazard automatically.
// Team-neutral, so no accent. We graft the one gameplay part the export omits: a single red
// SENSOR EYE on the front of the conning tower. It glows steady while hunting and the Sub
// class dims it (group.userData.eyeMat) as the boat dives — a "still watching / going dark"
// tell. The tower's cross-section is a diamond, so its FRONT is a vertical edge, not a face:
// we mount a short dark cylinder as an eye SOCKET (a flat seat facing +Z) and set the glowing
// octahedron into it.
export function makeSubmarine() {
  const g = buildAssetGroup(SUBMARINE_CFG, null);
  const socket = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.24, 14), SOCKET());
  socket.rotation.x = Math.PI / 2;          // flat circular face points forward (+Z)
  socket.position.set(0, 2.45, 2.46);       // seated on the tower's forward edge (~z2.5)
  g.add(socket);
  const eye = new THREE.Mesh(new THREE.OctahedronGeometry(0.26), EYE());
  eye.position.set(0, 2.45, 2.62);          // proud of the socket face
  g.add(eye);
  g.userData.eyeMat = eye.material;
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
