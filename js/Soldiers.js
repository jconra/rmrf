// Soldiers.js — tiny infantry minifigs that populate the bases (Return Fire homage).
// Purely decorative in this first slice: they patrol the base interior, SCATTER out of a
// building as it collapses, and pop with a flat squash if a vehicle rolls over them.
// They never shoot and take no shots (too small to target).
//
// ARTICULATED, still cheap: bodies, arms and legs are three InstancedMeshes — every limb
// is an instance posed per-frame with a walk-cycle swing about its shoulder/hip joint, so
// the whole population (arms and all) is 3 draw calls and a few hundred matrix composes.
//
// TEAM COLOUR: fatigues tint from the camp accent, tracked by team tag — retintTeam() is
// called on the colour-lock (camps recolour, soldiers follow). Never a hard-coded palette.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const MAX = 64;            // hard population cap (recycle oldest runner when full)
const RUN_SPEED = 3.2;     // u/s — a panicked scurry
const WALK_SPEED = 1.5;    // u/s — the patrol march
const LIFE_RUNNER = 40;    // s a scattered soldier hangs around before slipping away
const SQUASH_R = 1.3;      // vehicle centre within this = squish

// Joints (figure space, feet at y=0, facing +z):
const HIP_Y = 0.44, SHOULDER_Y = 0.86;
const HIP_X = 0.1, SHOULDER_X = 0.27;
const LEG_LEN = 0.44, ARM_LEN = 0.4;

function bodyGeometry() {          // torso + helmeted head (limbs are separate instances)
  const parts = [];
  const add = (w, h, d, x, y, z) => { const g = new THREE.BoxGeometry(w, h, d); g.translate(x, y, z); parts.push(g); };
  add(0.4, 0.44, 0.24, 0, 0.66, 0);
  add(0.24, 0.22, 0.26, 0, 0.99, 0);
  return mergeGeometries(parts);
}
// Limb geometry hangs DOWN from its joint (origin at the joint → rotate to swing).
function limbGeometry(w, len, d) { const g = new THREE.BoxGeometry(w, len, d); g.translate(0, -len / 2, 0); return g; }

export class SoldierCorps {
  constructor(scene, map) {
    this.map = map;
    const mat = () => new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0.05, flatShading: true });
    this.bodies = new THREE.InstancedMesh(bodyGeometry(), mat(), MAX);
    this.legs = new THREE.InstancedMesh(limbGeometry(0.13, LEG_LEN, 0.16), mat(), MAX * 2);
    this.arms = new THREE.InstancedMesh(limbGeometry(0.09, ARM_LEN, 0.12), mat(), MAX * 2);
    for (const m of [this.bodies, this.legs, this.arms]) {
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.frustumCulled = false;   // instances span the whole island; skip the (wrong) shared-sphere cull
      scene.add(m);
    }
    this.units = [];
    this._free = Array.from({ length: MAX }, (_, i) => MAX - 1 - i);
    this._m = new THREE.Matrix4(); this._m2 = new THREE.Matrix4();
    this._q = new THREE.Quaternion(); this._s = new THREE.Vector3(1, 1, 1);
    this._e = new THREE.Euler(); this._v = new THREE.Vector3();
    this._zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < MAX; i++) {
      this.bodies.setMatrixAt(i, this._zero);
      this.legs.setMatrixAt(i * 2, this._zero); this.legs.setMatrixAt(i * 2 + 1, this._zero);
      this.arms.setMatrixAt(i * 2, this._zero); this.arms.setMatrixAt(i * 2 + 1, this._zero);
    }
  }

  // muted team-tinted fatigues — recognisable at a glance, not neon
  _fatigue(accent) { return new THREE.Color(accent).lerp(new THREE.Color('#4c4a40'), 0.5); }

  _paint(u) {
    this.bodies.setColorAt(u.slot, u.color);
    this.legs.setColorAt(u.slot * 2, u.color); this.legs.setColorAt(u.slot * 2 + 1, u.color);
    this.arms.setColorAt(u.slot * 2, u.color); this.arms.setColorAt(u.slot * 2 + 1, u.color);
    for (const m of [this.bodies, this.legs, this.arms]) if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }

  // The team locked/changed its colour (Camp.setAccent path) — re-tint that team's figures.
  retintTeam(team, accent) {
    const color = this._fatigue(accent);
    for (const u of this.units) if (u.team === team) { u.color = color; this._paint(u); }
  }

  _spawn(u) {
    if (!this._free.length) {
      // full: retire the oldest non-patrol runner to make room (patrols are the fixtures)
      const idx = this.units.findIndex(s => s.mode !== 'patrol');
      if (idx < 0) return null;
      this._retire(this.units[idx]);
    }
    u.slot = this._free.pop();
    u.phase = Math.random() * 6.28;
    this._paint(u);
    this.units.push(u);
    return u;
  }

  _retire(u) {
    this.bodies.setMatrixAt(u.slot, this._zero);
    this.legs.setMatrixAt(u.slot * 2, this._zero); this.legs.setMatrixAt(u.slot * 2 + 1, this._zero);
    this.arms.setMatrixAt(u.slot * 2, this._zero); this.arms.setMatrixAt(u.slot * 2 + 1, this._zero);
    this._free.push(u.slot);
    this.units.splice(this.units.indexOf(u), 1);
  }

  // A building just collapsed — soldiers bail out of the wreck and sprint for open ground.
  scatterFrom(x, z, team, accent, n = 4) {
    const color = this._fatigue(accent);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, run = 8 + Math.random() * 8;
      this._spawn({
        mode: 'flee', team, x: x + Math.cos(a) * 0.8, z: z + Math.sin(a) * 0.8,
        tx: x + Math.cos(a) * run, tz: z + Math.sin(a) * run,
        speed: RUN_SPEED * (0.85 + Math.random() * 0.3), color,
        life: LIFE_RUNNER * (0.7 + Math.random() * 0.6), t: 0, squash: 0,
      });
    }
  }

  // Ambient garrison: a few figures marching a loop of waypoints inside the base.
  addPatrol(waypoints, team, accent, n = 3) {
    const color = this._fatigue(accent);
    for (let i = 0; i < n; i++) {
      const wpI = (i * 2) % waypoints.length;
      this._spawn({
        mode: 'patrol', team, x: waypoints[wpI].x, z: waypoints[wpI].z,
        wps: waypoints, wpI: (wpI + 1) % waypoints.length,
        speed: WALK_SPEED * (0.9 + Math.random() * 0.2), color,
        life: Infinity, t: i * 1.7, squash: 0,
      });
    }
  }

  update(dt, vehicles) {
    const dead = [];
    for (const u of this.units) {
      u.t += dt;
      if (u.squash > 0) { u.squash += dt; if (u.squash > 2.5) dead.push(u); continue; }
      // --- steering ---
      let dx = 0, dz = 0, moving = false;
      if (u.mode === 'flee') {
        dx = u.tx - u.x; dz = u.tz - u.z;
        const d = Math.hypot(dx, dz);
        if (d > 0.4) { dx /= d; dz /= d; moving = true; }
        else if (Math.random() < dt * 0.4) {         // milling: pick a new short stroll nearby
          const a = Math.random() * Math.PI * 2;
          u.tx = u.x + Math.cos(a) * 4; u.tz = u.z + Math.sin(a) * 4;
        }
        u.life -= dt;
        if (u.life <= 0) { dead.push(u); continue; }
      } else {                                        // patrol loop
        const wp = u.wps[u.wpI];
        dx = wp.x - u.x; dz = wp.z - u.z;
        const d = Math.hypot(dx, dz);
        if (d < 0.5) { u.wpI = (u.wpI + 1) % u.wps.length; }
        else { dx /= d; dz /= d; moving = true; }
      }
      u.moving = moving;
      if (moving) {
        u.x += dx * u.speed * dt; u.z += dz * u.speed * dt;
        u.dir = Math.atan2(dx, dz);
        // never walk into the sea
        if (this.map && !this.map.isLand(u.x, u.z)) { u.x -= dx * u.speed * dt * 2; u.z -= dz * u.speed * dt * 2; }
      }
      // --- squish check (any live ground vehicle overhead; flyers pass over) ---
      for (const v of vehicles) {
        if (v.dead || (v._move && v._move.ignoreWalls)) continue;
        const p = v.holder.position;
        if ((p.x - u.x) ** 2 + (p.z - u.z) ** 2 < SQUASH_R * SQUASH_R) { u.squash = 0.001; break; }
      }
    }
    for (const u of dead) this._retire(u);

    // --- pose every live instance: body + 4 swinging limbs ---
    const M = this._m, M2 = this._m2, Q = this._q, E = this._e, V = this._v, S = this._s;
    for (const u of this.units) {
      const y = this.map ? this.map.heightAt(u.x, u.z) : 0;
      const i2 = u.slot * 2;
      if (u.squash > 0) {   // flattened under a tread — everything squashes into one plate
        E.set(0, u.dir || 0, 0); Q.setFromEuler(E);
        M.compose(V.set(u.x, y + 0.03, u.z), Q, S.set(1.5, 0.05, 1.5));
        this.bodies.setMatrixAt(u.slot, M);
        this.legs.setMatrixAt(i2, this._zero); this.legs.setMatrixAt(i2 + 1, this._zero);
        this.arms.setMatrixAt(i2, this._zero); this.arms.setMatrixAt(i2 + 1, this._zero);
        continue;
      }
      const w = u.speed * 6;                                       // step frequency scales with pace
      const stride = u.moving ? 1 : 0.12;                          // idle = tiny shuffle, not a freeze
      const swing = Math.sin(u.t * w + u.phase) * 0.7 * stride;    // leg swing angle (rad)
      const bob = Math.abs(Math.sin(u.t * w + u.phase)) * 0.05 * stride;
      const lean = u.moving ? 0.1 : 0;                             // forward lean while marching
      // body (torso+head)
      E.set(lean, u.dir || 0, 0); Q.setFromEuler(E);
      M.compose(V.set(u.x, y + bob, u.z), Q, S.set(1, 1, 1));
      this.bodies.setMatrixAt(u.slot, M);
      // limbs: joint offset in BODY space, then swing about the joint's x-axis.
      // legs swing in opposition; arms counter-swing against their side's leg.
      const limb = (mesh, idx, jx, jy, ang) => {
        E.set(ang, 0, 0); Q.setFromEuler(E);
        M2.compose(V.set(jx, jy, 0), Q, S.set(1, 1, 1));   // joint-local: offset + swing
        M2.premultiply(M);                                  // into the body's frame (pos+facing+lean+bob)
        mesh.setMatrixAt(idx, M2);
      };
      limb(this.legs, i2, -HIP_X, HIP_Y, swing);
      limb(this.legs, i2 + 1, HIP_X, HIP_Y, -swing);
      limb(this.arms, i2, -SHOULDER_X, SHOULDER_Y, -swing * 0.8);
      limb(this.arms, i2 + 1, SHOULDER_X, SHOULDER_Y, swing * 0.8);
    }
    this.bodies.instanceMatrix.needsUpdate = true;
    this.legs.instanceMatrix.needsUpdate = true;
    this.arms.instanceMatrix.needsUpdate = true;
  }
}
