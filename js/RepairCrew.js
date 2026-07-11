// RepairCrew.js — the "construction crew" repair job. When a base wants to patch a wounded
// tower, a JEEP rolls out of the motor pool, drives to the tower, drops a crew of soldiers who
// work for ~a minute, and the tower heals a tier. The jeep is a soft, killable target the whole
// time it's out — shoot it (or squish the crew) and the repair is cancelled. The economy/AI that
// DECIDES to order a repair lives in main.js; this file just runs one job end-to-end.
//
// Deliberately no A* nav for the slice: the drive is a straight steer inside the base (open
// ground between the motor pool and the corner towers). Real routing can come later.

import * as THREE from 'three';
import { buildAssetGroup } from './AssetBuilder.js?v=1';
import JEEP_CFG from './jeep.config.js?v=1';
import { Destructible } from './Destructible.js?v=7';

const DRIVE_SPEED = 8;      // jeep ground speed (u/s)
const HEAL_RATE   = 0.01;   // fraction of maxHp healed per SECOND (so a scratch is quick, a
                            // half-wrecked tower takes ~a minute — and the crew stays until it's
                            // full, so damage taken mid-repair just extends the job).
const GUN_INSTALL_T = 20;   // seconds of crew work to mount a purchased gun (after the body's full)
const UPGRADE_T   = 5;      // seconds of crew work to pin one upgrade star on a healthy tower (fast, by design)
const CREW_N      = 3;      // soldiers dismounted per job
const STANDOFF    = 5;      // jeep parks this far short of the tower
const JEEP_HP     = 40;     // matches jeep.config.js — fragile, "not built to take a shell"
const BAR_W       = 6;      // progress-bar width (world units)
const REPLAN_T    = 1.5;    // seconds between A* replans while the jeep drives

function makeBar() {
  const g = new THREE.Group();
  const bg = new THREE.Mesh(new THREE.BoxGeometry(BAR_W + 0.4, 0.9, 0.2),
    new THREE.MeshBasicMaterial({ color: '#10151c' }));
  g.add(bg);
  const fillGeo = new THREE.BoxGeometry(BAR_W, 0.6, 0.3); fillGeo.translate(BAR_W / 2, 0, 0.05);
  const fill = new THREE.Mesh(fillGeo, new THREE.MeshBasicMaterial({ color: '#5fd66a' }));
  const pivot = new THREE.Group(); pivot.position.x = -BAR_W / 2; pivot.add(fill);
  g.add(pivot); g.userData.fill = fill;
  return g;
}

// A team-coloured jeep mesh (also used for the jeeps parked in the base motor pool).
// The asset model noses along +X, but every consumer drives/orients it with the game's
// +Z-forward convention (rotation.y = yaw, forward = (sin yaw, cos yaw)). Reorient the model
// once here — inside a wrapper group so the caller's rotation.y still means heading — so the
// jeep faces the way it travels instead of sliding sideways.
export function makeJeepMesh(accent) {
  const inner = buildAssetGroup(JEEP_CFG, new THREE.Color(accent), { cell: 5 });
  inner.rotation.y = -Math.PI / 2;
  const g = new THREE.Group();
  g.add(inner);
  return g;
}

export class RepairJob {
  // opts: { start:{x,z}, tower:{x,y,z}, wall, team, accent, soldiers }
  constructor(scene, map, opts) {
    this.scene = scene; this.map = map;
    this.wall = opts.wall; this.team = opts.team; this.accent = opts.accent;
    this.soldiers = opts.soldiers; this.tower = opts.tower;
    this.nav = opts.nav || null;         // { plan(fromX,fromZ,toX,toZ) -> [{x,z}]|null } — A* on roads
    this.groundY = opts.groundY || null; // road-aware ground sampler (the game's roadDeckY-or-terrain)
    this.gun = !!opts.gun;               // paid job: the jeep carries a replacement gun to mount
    this.upgrade = !!opts.upgrade;       // paid job: pin an upgrade star on a HEALTHY tower (no heal)
    this.onUpgrade = opts.onUpgrade || null;   // called once the ~5s install completes
    this.state = 'driving';              // driving → building/upgrading → (installing) → returning → done | cancelled
    this.crew = [];
    this.home = { x: opts.start.x, z: opts.start.z };
    this.startHp = null;                 // tower HP when the crew starts work (for the progress bar)
    this.progress = 0;                   // 0..1 current-phase fraction (heal, then gun install) for HUD/debug
    this.installT = 0;                   // seconds of gun-mount work done
    this.healed = 0;                     // telemetry: real HP restored by this crew
    this.rebuilt = false;                // telemetry: raised the tower from full rubble
    this.gunMounted = false;             // telemetry: the purchased gun actually made it onto the tower
    this.path = null; this._pIdx = 0; this._replanT = 0;   // cached A* route to the current goal

    // Park spot: STANDOFF short of the tower, back along the line toward the motor pool.
    const tx = this.tower.x, tz = this.tower.z;
    let vx = this.home.x - tx, vz = this.home.z - tz; const vl = Math.hypot(vx, vz) || 1;
    this.park = { x: tx + (vx / vl) * STANDOFF, z: tz + (vz / vl) * STANDOFF };

    // The jeep, in the team's colour, starting at the motor pool facing the tower.
    this.jeep = makeJeepMesh(this.accent);
    this.jx = this.home.x; this.jz = this.home.z;
    this.jyaw = Math.atan2(tx - this.jx, tz - this.jz);
    this._placeJeep();
    scene.add(this.jeep);
    // Shootable while it's out — main.js registers this with the live damage manager.
    this.jeepDest = new Destructible(this.jeep, { type: 'building', hp: JEEP_HP });

    // Floating progress bar above the tower (billboarded toward the camera in the live loop).
    this.bar = makeBar();
    this.bar.position.set(tx, this.tower.y + 7, tz);
    this._setBar(0); this.bar.visible = false;
    scene.add(this.bar);
  }

  _placeJeep() {
    // Same ground rule as the driven vehicles: on a road cell sit on the SLAB TOP (the game's
    // roadDeckY), else the terrain — otherwise the jeep drives half-sunk through the asphalt.
    const y = this.groundY ? this.groundY(this.jx, this.jz)
      : (this.map ? this.map.heightAt(this.jx, this.jz) : 0);
    this.jeep.position.set(this.jx, y, this.jz);
    this.jeep.rotation.y = this.jyaw;
  }

  _setBar(f) {
    const fill = this.bar.userData.fill;
    fill.scale.x = Math.max(0.0001, f);
    fill.material.color.set(f >= 1 ? '#8ef58e' : '#5fd66a');
  }

  // Steer toward (tx,tz) at DRIVE_SPEED; returns true once within `arrive`.
  _driveTo(tx, tz, dt, arrive) {
    const dx = tx - this.jx, dz = tz - this.jz, d = Math.hypot(dx, dz);
    if (d < arrive) return true;
    const want = Math.atan2(dx, dz);
    let dy = want - this.jyaw; while (dy > Math.PI) dy -= 2 * Math.PI; while (dy < -Math.PI) dy += 2 * Math.PI;
    this.jyaw += Math.max(-3 * dt, Math.min(3 * dt, dy));
    const step = Math.min(d, DRIVE_SPEED * dt);
    this.jx += Math.sin(this.jyaw) * step; this.jz += Math.cos(this.jyaw) * step;
    this._placeJeep();
    this.jeepDest.refresh();               // keep its hit-bounds tracking the moving jeep
    return false;
  }

  // Drive toward (destX,destZ) FOLLOWING an A* route (roads-preferred, wall-avoiding) supplied by
  // the game. Replans on a timer / when the route runs out; falls back to a straight steer if the
  // planner returns no route. Returns true once the final goal is reached within `arriveFinal`.
  _navTo(destX, destZ, dt, arriveFinal) {
    this._replanT -= dt;
    if (this.nav && (!this.path || this._pIdx >= this.path.length || this._replanT <= 0)) {
      const p = this.nav.plan(this.jx, this.jz, destX, destZ);
      this.path = (p && p.length) ? p : null;
      this._pIdx = 0; this._replanT = REPLAN_T;
    }
    if (!this.path) return this._driveTo(destX, destZ, dt, arriveFinal);   // no route → beeline
    const last = this.path.length - 1;
    const w = this.path[this._pIdx];
    const arrive = this._pIdx >= last ? arriveFinal : 2.5;
    if (this._driveTo(w.x, w.z, dt, arrive)) {
      if (this._pIdx >= last) return true;
      this._pIdx++;
    }
    return false;
  }

  _spawnCrew() {
    for (let i = 0; i < CREW_N; i++) {
      const a = (i / CREW_N) * Math.PI * 2;
      const wx = this.tower.x + Math.cos(a) * 2.4, wz = this.tower.z + Math.sin(a) * 2.4;
      const u = this.soldiers.addWorker(this.jx, this.jz, wx, wz, this.team, this.accent);
      if (u) this.crew.push(u);
    }
  }

  _crewWipedOut() {
    // every dismounted soldier is gone (retired) or squished under a tread
    return this.crew.length > 0 && this.crew.every(u => !this.soldiers.units.includes(u) || u.squash > 0);
  }

  // Pack the crew into the jeep and head home (job over, jeep survives — only enemy fire on the
  // jeep itself loses a jeep).
  _packUp() {
    for (const u of this.crew) this.soldiers.remove(u); this.crew.length = 0;
    this.bar.visible = false;
    this.path = null; this._pIdx = 0; this._replanT = 0;   // fresh route for the return leg
    this.state = 'returning';
  }

  // dt seconds; optional camera to billboard the bar. Returns the state (caller reacts to
  // 'done'/'cancelled' by dropping the job + freeing the jeep slot).
  update(dt, camera) {
    if (this.state === 'done' || this.state === 'cancelled') return this.state;
    if (this.jeepDest.dead) return this._end('cancelled');   // jeep shot out from under the crew

    if (this.state === 'driving') {
      if (this._navTo(this.park.x, this.park.z, dt, 1.2)) {
        this._spawnCrew(); this.bar.visible = true;
        this.state = this.upgrade ? 'upgrading' : 'building';   // healthy-tower upgrade skips the heal
        this.path = null; this._pIdx = 0;   // fresh route for the return leg
      }
    } else if (this.state === 'upgrading') {
      // Fixed ~5s of crew work on a healthy tower, then pin the star (no HP heal involved).
      if (this._crewWipedOut()) return this._end('cancelled');
      this.installT += dt;
      this.progress = Math.min(1, this.installT / UPGRADE_T);
      this._setBar(this.progress);
      if (this.installT >= UPGRADE_T) { if (this.onUpgrade) this.onUpgrade(); this._packUp(); }
    } else if (this.state === 'building') {
      if (this._crewWipedOut()) return this._end('cancelled');
      const body = this.wall.body;
      // A fully-destroyed tower is a valid worksite: raise it from the rubble and rebuild.
      // (Also covers the tower being shot down MID-repair — the crew just starts over.)
      if (body.dead) { body.revive(1); this.startHp = 1; this.rebuilt = true; }
      if (this.startHp == null) this.startHp = body.hp;
      const full = this.wall.maxHp;
      // Heal a flat 1%/s toward full. The crew keeps working until the tower is topped off, so any
      // hits it takes mid-repair simply extend the job (the bar can even slide back). The Wall's
      // own staging re-seats crumbled layers bottom-up as the HP climbs — destruction in reverse.
      if (body.hp < full) { const pre = body.hp; body.heal(full * HEAL_RATE * dt); this.healed += body.hp - pre; }
      this.progress = Math.min(1, (body.hp - this.startHp) / Math.max(1, full - this.startHp));
      this._setBar(this.progress);
      if (body.hp >= full - 0.5) {
        if (this.gun && this.wall.turret && this.wall.turret.dead) {
          this.state = 'installing'; this.progress = 0;   // body's solid → mount the new gun on top
        } else this._packUp();
      }
    } else if (this.state === 'installing') {
      if (this._crewWipedOut()) return this._end('cancelled');
      const body = this.wall.body;
      if (body.dead || body.hp < this.wall.maxHp - 0.5) { this.state = 'building'; this.startHp = null; }   // knocked back down mid-install → repair first
      else {
        this.installT += dt;
        this.progress = Math.min(1, this.installT / GUN_INSTALL_T);
        this._setBar(this.progress);
        if (this.installT >= GUN_INSTALL_T) { this.gunMounted = this.wall.mountGun(); this._packUp(); }
      }
    } else if (this.state === 'returning') {
      if (this._navTo(this.home.x, this.home.z, dt, 2)) return this._end('done');
    }
    if (camera && this.bar.visible) this.bar.lookAt(camera.position);
    return this.state;
  }

  // completed (jeep survives → slot freed) vs cancelled (jeep lost). Tears down scene objects.
  _end(state) { this._teardown(); this.state = state; return state; }
  survived() { return this.state === 'done'; }   // completed jobs return the jeep to the pool

  _teardown() {
    for (const u of this.crew) this.soldiers.remove(u); this.crew.length = 0;
    if (this.jeep.parent) this.jeep.parent.remove(this.jeep);
    if (this.bar.parent) this.bar.parent.remove(this.bar);
  }
  dispose() { this._teardown(); this.state = 'cancelled'; }   // match reset
}
