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
import { Destructible } from './Destructible.js?v=6';

const DRIVE_SPEED = 8;      // jeep ground speed (u/s)
const BUILD_TIME  = 60;     // seconds of work to finish a repair
const CREW_N      = 3;      // soldiers dismounted per job
const STANDOFF    = 5;      // jeep parks this far short of the tower
const HEAL_FRAC   = 0.5;    // fraction of maxHp the tower recovers per completed job
const JEEP_HP     = 40;     // matches jeep.config.js — fragile, "not built to take a shell"
const BAR_W       = 6;      // progress-bar width (world units)

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
export function makeJeepMesh(accent) {
  return buildAssetGroup(JEEP_CFG, new THREE.Color(accent), { cell: 5 });
}

export class RepairJob {
  // opts: { start:{x,z}, tower:{x,y,z}, wall, team, accent, soldiers }
  constructor(scene, map, opts) {
    this.scene = scene; this.map = map;
    this.wall = opts.wall; this.team = opts.team; this.accent = opts.accent;
    this.soldiers = opts.soldiers; this.tower = opts.tower;
    this.state = 'driving';              // driving → building → returning → done | cancelled
    this.progress = 0;
    this.crew = [];
    this.home = { x: opts.start.x, z: opts.start.z };

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
    const y = this.map ? this.map.heightAt(this.jx, this.jz) : 0;
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

  // dt seconds; optional camera to billboard the bar. Returns the state (caller reacts to
  // 'done'/'cancelled' by dropping the job + freeing the jeep slot).
  update(dt, camera) {
    if (this.state === 'done' || this.state === 'cancelled') return this.state;
    if (this.jeepDest.dead) return this._end('cancelled');   // jeep shot out from under the crew

    if (this.state === 'driving') {
      if (this._driveTo(this.park.x, this.park.z, dt, 1.2)) { this._spawnCrew(); this.state = 'building'; this.bar.visible = true; }
    } else if (this.state === 'building') {
      if (this._crewWipedOut()) return this._end('cancelled');
      this.progress += dt;
      this._setBar(Math.min(1, this.progress / BUILD_TIME));
      if (this.progress >= BUILD_TIME) {
        if (this.wall && this.wall.body && !this.wall.body.dead) this.wall.body.heal(this.wall.maxHp * HEAL_FRAC);
        for (const u of this.crew) this.soldiers.remove(u); this.crew.length = 0;
        this.bar.visible = false; this.state = 'returning';
      }
    } else if (this.state === 'returning') {
      if (this._driveTo(this.home.x, this.home.z, dt, 2)) return this._end('done');
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
