// Gadgets.js — Firebrat deployables. Gives the fragile flag-runner a reason to go out early.
//   LAND MINE  — mostly-buried charge; detonates under ANY ground vehicle (either team),
//                flyers (Valkyrie) pass over. 2 per Firebrat trip, 12 max per team.
//   SENSOR POD — a visible cylinder-with-antenna; reveals enemy type + distance on the
//                screen edge for its team. 3 max per team (oldest is removed when a 4th drops).
// Both are destroyed by a nearby blast (damageAt). The game owns detonation damage + the
// contact HUD; this module owns the entities, meshes, caps, and proximity/range logic.

import * as THREE from 'three';

export const MINE = {
  R: 3.2,            // trigger radius (world units)
  blast: 5.5,        // explosion radius handed to explodeAt
  dmg: 60,           // explosion damage
  armDelay: 0.7,     // seconds before a freshly-placed mine can trigger
  perTrip: 2,        // mines a single Firebrat deploy may lay
  teamCap: 12,       // live mines per team
  spotChance: 0.5,   // AI chance to notice a mine it approaches (used by the game's nav layer)
};
export const POD = {
  range: 85,         // detection radius (world units)
  teamCap: 3,        // live pods per team (FIFO beyond this)
  blink: 1.4,        // antenna tip pulse period (s)
};

// A mine: a shallow earth-toned disc sunk almost flush, reading as a patch of turned soil
// rather than hardware. No team accent / no glow (a mine hits either team anyway, so the
// colour carried no info and just gave it away). Muted dirt tones + slight transparency let
// it blend into sand or grass — you can still spot it if you look, but not at a glance.
function makeMineMesh(accent) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(0.85, 1.0, 0.3, 10),
    new THREE.MeshStandardMaterial({ color: '#cbb37a', roughness: 0.98, metalness: 0.0, flatShading: true, transparent: true, opacity: 0.9 }));
  body.position.y = 0.02; g.add(body);   // sunk almost flush, tinted to the beach sand (#dcc88c) so it blends
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.5, 0.08, 6, 14),
    new THREE.MeshStandardMaterial({ color: '#b39a5f', roughness: 0.95, metalness: 0.05, flatShading: true, transparent: true, opacity: 0.9 }));
  ring.rotation.x = Math.PI / 2; ring.position.y = 0.14; g.add(ring);
  const nub = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.14, 6),
    new THREE.MeshStandardMaterial({ color: '#9c8550', roughness: 0.9, metalness: 0.1 }));
  nub.position.y = 0.2; g.add(nub);
  return g;
}

// A sensor pod: squat body + thin antenna with a team-colour tip light (blinks in update()).
function makePodMesh(accent) {
  const g = new THREE.Group();
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.85, 0.3, 12),
    new THREE.MeshStandardMaterial({ color: '#3b3f44', roughness: 0.9, metalness: 0.2, flatShading: true }));
  base.position.y = 0.15; g.add(base);
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.62, 1.1, 12),
    new THREE.MeshStandardMaterial({ color: '#6f7378', roughness: 0.6, metalness: 0.4, flatShading: true }));
  body.position.y = 0.85; g.add(body);
  const band = new THREE.Mesh(new THREE.CylinderGeometry(0.53, 0.53, 0.22, 12),
    new THREE.MeshStandardMaterial({ color: accent, roughness: 0.5, metalness: 0.3 }));
  band.position.y = 1.15; band.userData.accent = true; g.add(band);
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 1.5, 6),
    new THREE.MeshStandardMaterial({ color: '#26282b', roughness: 0.7, metalness: 0.5 }));
  mast.position.y = 2.1; g.add(mast);
  const tipMat = new THREE.MeshStandardMaterial({ color: accent, emissive: accent, emissiveIntensity: 1.0, roughness: 0.4 });
  const tip = new THREE.Mesh(new THREE.SphereGeometry(0.14, 8, 8), tipMat);
  tip.position.y = 2.9; g.add(tip);
  g.userData.tipMat = tipMat;
  return g;
}

// Common lifecycle for a set of placed ground gadgets bound to a ground-height map.
class GadgetSet {
  constructor(scene, map) { this.scene = scene; this.map = map; this.items = []; }
  count(team) { let n = 0; for (const it of this.items) if (it.team === team) n++; return n; }
  _drop(it) { this.scene.remove(it.group); const i = this.items.indexOf(it); if (i >= 0) this.items.splice(i, 1); }
  reset() { for (const it of this.items.slice()) this.scene.remove(it.group); this.items = []; }
  // Remove any gadget whose centre is within `r` of a blast point (returns how many cleared).
  damageAt(point, r) {
    let n = 0;
    for (const it of this.items.slice()) {
      const p = it.group.position;
      if ((p.x - point.x) ** 2 + (p.z - point.z) ** 2 <= r * r) { this._drop(it); n++; }
    }
    return n;
  }
  // First gadget within `r` of a point HORIZONTALLY (height-agnostic — a flat tank round at any
  // height still connects, so you can't shoot clean over a short pod), else null. Direct hits.
  queryHit(point, r) {
    for (const it of this.items) {
      const p = it.group.position;
      if ((p.x - point.x) ** 2 + (p.z - point.z) ** 2 <= r * r) return it;
    }
    return null;
  }
  takeHit(it) { this._drop(it); }   // destroy one gadget outright (a direct projectile hit)
}

export class Minefield extends GadgetSet {
  // Lay a mine at (x,z) owned by `team`; `placer` won't trigger it until it drives clear once.
  // Returns the mine, or null if the team is at its cap.
  place(x, z, team, accent, placer = null) {
    if (this.count(team) >= MINE.teamCap) return null;
    const group = makeMineMesh(accent);
    group.position.set(x, this.map ? this.map.heightAt(x, z) : 0, z);
    this.scene.add(group);
    // spottedBy = teams that KNOW this mine (and so route around it). The owner always knows
    // its own field; enemies must spot it (per-unit roll, tracked in `rolled`).
    const mine = { group, team, t: 0, safe: placer, spottedBy: new Set([team]), rolled: new Set() };
    this.items.push(mine);
    return mine;
  }
  // Detonations this frame → [{x,y,z, mine}]. `isFlyer(v)` true = passes over (never triggers).
  // The caller applies the explosion (damage/fx) and should NOT re-add the mine.
  update(dt, combatants, isFlyer) {
    const boom = [];
    for (const m of this.items.slice()) {
      m.t += dt;
      const p = m.group.position;
      // spin the pressure ring's nub a hair so an alert eye can catch a glint
      if (m.group.children[2]) m.group.children[2].rotation.y += dt * 0.6;
      let trigger = null, safeStillNear = false;
      for (const v of combatants) {
        if (v.dead || isFlyer(v)) continue;
        const d2 = (v.holder.position.x - p.x) ** 2 + (v.holder.position.z - p.z) ** 2;
        if (v === m.safe) { if (d2 <= MINE.R * MINE.R) safeStillNear = true; continue; }
        if (m.t >= MINE.armDelay && d2 <= MINE.R * MINE.R) { trigger = v; break; }
      }
      if (m.safe && !safeStillNear) m.safe = null;   // placer drove clear → mine now live for everyone
      if (trigger) { boom.push({ x: p.x, y: p.y, z: p.z, mine: m }); this._drop(m); }
    }
    return boom;
  }
}

export class SensorNet extends GadgetSet {
  // Drop a pod for `team`; if that would exceed the cap, the team's OLDEST pod is removed first.
  place(x, z, team, accent) {
    while (this.count(team) >= POD.teamCap) {
      const oldest = this.items.find(it => it.team === team);
      if (!oldest) break; this._drop(oldest);
    }
    const group = makePodMesh(accent);
    group.position.set(x, this.map ? this.map.heightAt(x, z) : 0, z);
    this.scene.add(group);
    const pod = { group, team, t: 0, tipMat: group.userData.tipMat };
    this.items.push(pod);
    return pod;
  }
  update(dt) {
    for (const pod of this.items) {
      pod.t += dt;
      if (pod.tipMat) pod.tipMat.emissiveIntensity = 0.35 + 0.85 * (0.5 + 0.5 * Math.sin(pod.t * 2 * Math.PI / POD.blink));
    }
  }
  // Enemy contacts visible to `team` (any enemy vehicle within range of any of the team's pods).
  // → [{ pos, type, dist, colorIndex }]  (dist = to the nearest of that team's pods).
  contacts(team, combatants) {
    const pods = this.items.filter(it => it.team === team);
    if (!pods.length) return [];
    const out = [];
    for (const v of combatants) {
      if (v.dead || v.team === team) continue;
      let best = Infinity;
      for (const pod of pods) {
        const d = Math.hypot(v.holder.position.x - pod.group.position.x, v.holder.position.z - pod.group.position.z);
        if (d < best) best = d;
      }
      if (best <= POD.range) out.push({ pos: v.holder.position, type: v.type, dist: best, colorIndex: v.colorIndex });
    }
    return out;
  }
}
