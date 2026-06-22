// Vehicles.js — brings the four designer vehicles into the game. The classes
// live in ../vehicle-designer/js/ and stay the single source of truth, so edits
// made in the designer flow straight into the game. They only depend on `three` (resolved via
// this page's importmap) + CamoTexture.js + GunFX.js, which sit beside them.
//
// A vehicle class owns ONLY its local animation: update(dt, forward, turn)
// plays the gait/tracks, body bob (writes group.position.y) and turret sweep —
// it does NOT move through the world. So we wrap each in a holder: the holder
// carries world position / heading / terrain height; the inner vehicle.group
// does its own bob & roll inside it.

import * as THREE from 'three';
import { Lurcher } from '../../vehicle-designer/js/Lurcher.js';
import { Firebrat } from '../../vehicle-designer/js/Firebrat.js';
import { Valkyrie } from '../../vehicle-designer/js/Valkyrie.js';
import { Jotun } from '../../vehicle-designer/js/Jotun.js';
import { getCamoTextures } from '../../vehicle-designer/js/CamoTexture.js';

// scale tuned so models read right against the 5-unit grid (native lengths are
// ~2.2-4.0): Firebrat smallest, Jotun biggest; all widths clear the ~12u gate.
// stat = the 1-5 dot ratings shown on the hangar HUD (ported from the designer);
// role = the one-line blurb. (speed/turn below are the gameplay movement values.)
// soundIndex = the SoundManager engine-patch index (designer vehicle order).
export const VEHICLE_TYPES = {
  lurcher:  { Class: Lurcher,  label: 'Lurcher',  scale: 3.6,  speed: 14, turn: 2.2, soundIndex: 0,
    stat: { speed: 2, armor: 4, firepower: 4 }, role: 'Six-leg spider chassis. Brutal firepower, all-terrain footing.' },
  firebrat: { Class: Firebrat, label: 'Firebrat', scale: 3.4,  speed: 20, turn: 3.0, soundIndex: 1,
    stat: { speed: 5, armor: 1, firepower: 2 }, role: 'Lightning-fast scout. Built to capture the flag and run.' },
  valkyrie: { Class: Valkyrie, label: 'Valkyrie', scale: 3.4,  speed: 16, turn: 2.0, soundIndex: 2,
    stat: { speed: 4, armor: 2, firepower: 3 }, role: 'Ducted-rotor assault craft. Ignores all terrain.' },
  jotun:    { Class: Jotun,    label: 'Jotun',    scale: 4.1,  speed: 8,  turn: 1.2, soundIndex: 3,
    stat: { speed: 1, armor: 5, firepower: 5 }, role: 'Rolling fortress. Devastating at long range. Nearly indestructible.' },
};

// Sideways (strafe) speed as a fraction of forward speed — slower, so driving forward
// is still the quick way around and strafing is for fine repositioning.
const STRAFE_FRAC = 0.7;

// A drivable instance: outer holder (world transform) + inner animated model.
export class Vehicle {
  constructor(typeKey) {
    const def = VEHICLE_TYPES[typeKey];
    if (!def) throw new Error('unknown vehicle type: ' + typeKey);
    this.type = typeKey;
    this.def = def;
    this.model = new def.Class();
    this.holder = new THREE.Group();
    // The model writes its OWN group.position.y for the idle bob, so we can't put
    // the ground-seat offset there (it'd be clobbered each frame). Carry it on an
    // intermediate seat group: holder (world) → seat (ground offset) → model (bob).
    this.seatGroup = new THREE.Group();
    this.model.group.scale.setScalar(def.scale);
    this.seatGroup.add(this.model.group);
    this.holder.add(this.seatGroup);
    this.heading = 0;        // yaw (radians)
    this.speed = def.speed;
    this.turnRate = def.turn;
    this.scaleMult = 1;
    this.seat();             // drop the model so its lowest point rests on the floor
  }

  get group() { return this.holder; }

  // Measure the model's lowest point (in its CURRENT pose) and offset the seat
  // group so that point rests exactly on the holder's ground plane. Models centre
  // their geometry differently; this seats them all without per-type magic numbers.
  // Call it again after changing the pose/scale.
  seat() {
    this.seatGroup.position.y = 0;
    this.model.group.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(this.model.group);
    if (isFinite(box.min.y)) this.seatGroup.position.y = this.holder.position.y - box.min.y;
  }

  // Resize off the per-type base scale, keeping the model seated on the floor.
  setScale(mult) {
    this.scaleMult = mult;
    this.model.group.scale.setScalar(this.def.scale * mult);
    this.seat();
  }

  setPose(x, y, z, heading = 0) {
    this.holder.position.set(x, y, z);
    this.heading = heading;
    this.holder.rotation.y = heading;
  }

  // forward/turn in [-1,1]. groundFn: terrain height under the new position.
  // blockedFn(x,z) (optional): true where the vehicle can't go — the move is tried
  // whole, then per-axis, so it slides along walls/shoreline instead of stopping dead.
  // forward/turn/strafe in [-1,1]. strafe slides the hull along its own right axis
  // (Q/E for the player) WITHOUT changing heading — handy to peek around a wall or
  // line up a shot; a touch slower than driving forward (STRAFE_FRAC).
  drive(dt, forward, turn, groundFn, blockedFn, strafe = 0) {
    this.heading += turn * this.turnRate * dt;
    this.holder.rotation.y = this.heading;
    const h = this.heading;
    const fx = -Math.sin(h), fz = -Math.cos(h);   // forward (local -Z)
    const rx =  Math.cos(h), rz = -Math.sin(h);   // right   (local +X)
    const d = forward * this.speed * dt;
    const s = strafe * this.speed * STRAFE_FRAC * dt;
    const dx = fx * d + rx * s;
    const dz = fz * d + rz * s;
    const px = this.holder.position.x, pz = this.holder.position.z;
    let nx = px + dx, nz = pz + dz;
    if (blockedFn && blockedFn(nx, nz)) {
      nx = blockedFn(px + dx, pz) ? px : px + dx;   // slide on whichever axis is clear
      nz = blockedFn(px, pz + dz) ? pz : pz + dz;
    }
    this.holder.position.x = nx;
    this.holder.position.z = nz;
    if (groundFn) this.holder.position.y = groundFn(nx, nz);
    this.model.update(dt, forward, turn);
  }

  // OMNI-directional drive (the Lurcher under player control): move along an arbitrary
  // world vector (mx, mz) ∈ unit disc, no input-driven turning — the hull has no "front"
  // to manage, it just goes where you push. The body eases to FACE its travel direction
  // (purely cosmetic; the turret aims independently via its full 360° arc). Same blocked-
  // slide as drive(). Used only for the player Lurcher; the AI still uses drive().
  driveOmni(dt, mx, mz, groundFn, blockedFn) {
    const mag = Math.hypot(mx, mz);
    if (mag > 0.001) {
      const want = Math.atan2(-mx, -mz);                 // heading whose forward (-Z) points at (mx,mz)
      const turn = ((want - this.heading + Math.PI * 3) % (Math.PI * 2)) - Math.PI;   // wrap to [-π,π]
      const slew = 6 * dt;                               // cosmetic catch-up; tight enough to read as "facing where it goes"
      this.heading += Math.max(-slew, Math.min(slew, turn));
      this.holder.rotation.y = this.heading;
    }
    const d = this.speed * dt;
    const dx = mx * d, dz = mz * d;
    const px = this.holder.position.x, pz = this.holder.position.z;
    let nx = px + dx, nz = pz + dz;
    if (blockedFn && blockedFn(nx, nz)) {
      nx = blockedFn(px + dx, pz) ? px : px + dx;        // slide on whichever axis is clear
      nz = blockedFn(px, pz + dz) ? pz : pz + dz;
    }
    this.holder.position.x = nx;
    this.holder.position.z = nz;
    if (groundFn) this.holder.position.y = groundFn(nx, nz);
    this.model.update(dt, mag, 0);                       // animate as forward motion at this magnitude
  }

  // Idle tick (animation only, no movement) — for parked/garage vehicles.
  idle(dt) { this.model.update(dt, 0, 0); }

  fire() { return this.model.fire ? this.model.fire() : null; }

  // Recolour the team-accent bits (glowing missile heads, railgun core, lit
  // strakes, hub/thruster glow lights) to a new team colour. The camo body is
  // driven separately by the shared camo texture (updateCamo); this catches the
  // per-vehicle emissive materials + glow point-lights that camo doesn't reach.
  // Heuristic: within a vehicle, any non-black emissive material is team-accent.
  setTeamColor(hex) {
    const c = new THREE.Color(hex);
    this.model.group.traverse(o => {
      if (o.isPointLight) { o.color.copy(c); return; }
      if (!o.isMesh || !o.material) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (m.emissive && m.emissive.getHex() !== 0) {
          m.emissive.copy(c);
          if (m.color) m.color.copy(c);
        }
      }
    });
  }

  // Swap the camo body to a team's colour. The shared camoTexture only holds one
  // colour at a time, so each vehicle wears its own per-team texture set (cached).
  // Camo materials are tagged userData.camo by makeCamoMaterial.
  setCamo(colorIndex) {
    const tex = getCamoTextures(colorIndex);
    this.model.group.traverse(o => {
      if (!o.isMesh || !o.material) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (m.userData && m.userData.camo) {
          m.map = tex.map;
          m.roughnessMap = tex.roughnessMap;
          m.normalMap = tex.normalMap;
          m.needsUpdate = true;
        }
      }
    });
  }
}
