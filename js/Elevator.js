// Elevator.js — animated FOB surface lift. Carves a square shaft into the island
// at the FOB centre and rides a vehicle up out of it onto the surface, mirroring
// the underground garage's rise. Self-contained rig: shaft liner + lift pad +
// hazard collar + telescoping ram, plus an optional rider Vehicle whose Y we drive.

import * as THREE from 'three';
import { concreteTexture, accentPlateTexture, hazardTexture } from './Textures.js?v=2';

// Shared neutral plate map tinted by the team accent (matches Walls.js / Buildings.js).
const ACCENT_TEX = accentPlateTexture();

const RISE_TIME = 3.2;    // seconds for a full bottom→top travel
const HOLD_TOP  = 2.2;    // pause at the surface before lowering (loop mode)
const HOLD_BOT  = 1.2;    // pause in the pit before rising again (loop mode)
const easeInOut = (k) => k * k * (3 - 2 * k);

// Diagonal yellow/black caution stripes for the hazard collar (shared — also used
// by the supply points; see Textures.js).
const HAZARD_TEX = hazardTexture();

const PAD_MAT   = new THREE.MeshStandardMaterial({ color: '#ffffff', map: concreteTexture('#9a948a'), roughness: 0.95 });
const LINER_MAT = new THREE.MeshStandardMaterial({ color: '#1d2024', roughness: 0.95, metalness: 0.1 });
const RAM_MAT   = new THREE.MeshStandardMaterial({ color: '#6b7077', roughness: 0.32, metalness: 0.85 });

function box(w, h, d, mat) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.castShadow = true; m.receiveShadow = true;
  return m;
}

export class Elevator {
  // map: IslandMap (carves the shaft). center: {x,z}. accent: THREE.Color (team).
  // opts.padHalf: lift half-width (world units). opts.loop: cycle for eyeballing.
  constructor(map, center, accent, opts = {}) {
    this.center = center;
    // Sized so the collar's outer edge just MEETS the gate roads, which thread the
    // FOB edge ~7.5 units out from centre (no grass sliver, no road poking in).
    this.padHalf = opts.padHalf ?? 6.0;       // 12-wide deck
    this.depth = opts.depth ?? 18;
    this.loop = opts.loop ?? false;
    const shaftHalf = this.padHalf + 0.4;     // a little clearance around the pad

    // Carve the pit; carveShaft reports the flattened surface + pit-floor heights.
    const r = map.carveShaft(center.x, center.z, shaftHalf, this.depth);
    this.groundY = r.groundY;
    this.bottomY = r.bottomY;

    this.group = new THREE.Group();

    // Shaft liner: four inward walls + a dark floor, so you don't see through the
    // carved terrain seams. Wall TOPS sit flush with the surface (groundY) — any
    // higher and the dark lip buries the hazard collar that rings the mouth.
    const wallH = this.depth + 0.4;
    const cy = this.groundY - wallH / 2;
    const span = shaftHalf * 2;
    const t = 0.8;
    for (const [sx, sz] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
      const horiz = sz !== 0;
      const w = horiz ? span + t * 2 : t;
      const d = horiz ? t : span + t * 2;
      const wall = box(w, wallH, d, LINER_MAT);
      wall.position.set(center.x + sx * (shaftHalf + t / 2), cy, center.z + sz * (shaftHalf + t / 2));
      this.group.add(wall);
    }
    const floor = box(span, 0.6, span, LINER_MAT);
    floor.position.set(center.x, this.bottomY - 0.1, center.z);
    this.group.add(floor);

    // Hazard collar: a striped frame ringing the shaft mouth. Its INNER edge tucks
    // slightly OVER the deck edge (no gap between pad and border); its OUTER edge
    // reaches ~7.6 to meet the gate roads.
    this.group.add(this._collar(this.padHalf - 0.25, 7.6));

    // Cut the ocean out of the pit: the global sea surface sits at y=0 and the
    // shaft floor is below it, so without this the sea floods the hole. A stencil
    // mask over the mouth makes the water + sea-floor planes skip this footprint.
    this._maskWater(map, shaftHalf);

    // The lift platform — a metal plate whose TOP sits at the lift group's origin,
    // so driving lift.position.y from bottomY→groundY brings the deck flush with the
    // ground. Starts in the pit.
    this.lift = new THREE.Group();
    const pad = box(this.padHalf * 2, 1.0, this.padHalf * 2, PAD_MAT);
    pad.position.y = -0.5;                    // top face at lift origin (y=0)
    this.lift.add(pad);
    // Team-colour border framing the deck on ALL FOUR edges.
    const am = new THREE.MeshStandardMaterial({ color: accent, map: ACCENT_TEX, roughness: 0.6, metalness: 0.2 });
    am.userData.accent = true;   // recoloured by setAccent on team-colour lock (map rides along)
    const bw = 0.7;                              // border bar width
    const inset = this.padHalf - bw / 2 - 0.15;  // sit just inside the deck edge
    const len = this.padHalf * 2 - 0.3;
    for (const s of [-1, 1]) {
      const front = box(len, 0.12, bw, am);      // front/back edges (run along X)
      front.position.set(0, 0.06, s * inset);
      this.lift.add(front);
      const side = box(bw, 0.12, len, am);       // left/right edges (run along Z)
      side.position.set(s * inset, 0.06, 0);
      this.lift.add(side);
    }
    this.lift.position.set(center.x, this.bottomY, center.z);
    this.group.add(this.lift);

    // Telescoping hydraulic ram beneath the deck (hidden while flush in the pit).
    this.ram = new THREE.Mesh(new THREE.CylinderGeometry(this.padHalf * 0.32, this.padHalf * 0.32, 1, 24), RAM_MAT);
    this.ram.visible = false;
    this.group.add(this.ram);

    this.rider = null;        // optional Vehicle riding the deck
    this.phase = 'down';      // down | rising | top | lowering
    this.t = 0;
    this._seatRider();
  }

  // Seat a vehicle on the deck. Its holder.position.y is driven each frame; x/z
  // and heading are fixed to the shaft centre here.
  setRider(vehicle, heading = 0) {
    this.rider = vehicle;
    vehicle.setPose(this.center.x, this.lift.position.y, this.center.z, heading);
    this._seatRider();
  }

  _seatRider() {
    if (this.rider) this.rider.holder.position.y = this.lift.position.y;
  }

  // Kick off a single rise from the pit.
  start() { if (this.phase === 'down') { this.phase = 'rising'; this.t = 0; } }

  // Recolour the deck's team-colour border (on a team-colour lock).
  setAccent(hex) {
    this.group.traverse(o => {
      if (!o.isMesh || !o.material) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) if (m.userData && m.userData.accent) m.color.set(hex);
    });
  }

  // Span the ram from just under the floor up to the deck's underside as it climbs.
  _updateRam() {
    const top = this.lift.position.y - 1.0;       // pad underside
    const base = this.bottomY - 0.4;
    if (top <= base + 0.4) { this.ram.visible = false; return; }
    this.ram.visible = true;
    this.ram.scale.y = top - base;
    this.ram.position.set(this.center.x, (base + top) / 2, this.center.z);
  }

  update(dt) {
    if (this.phase === 'rising' || this.phase === 'lowering') {
      this.t += dt;
      const k = Math.min(1, this.t / RISE_TIME);
      const e = easeInOut(this.phase === 'rising' ? k : 1 - k);
      this.lift.position.y = this.bottomY + e * this.depth;
      this._updateRam();
      this._seatRider();
      if (this.rider) this.rider.model.update(dt, 0, 0);   // idle gait on the way up
      if (k >= 1) { this.phase = this.phase === 'rising' ? 'top' : 'down'; this.t = 0; }
    } else {
      // Parked at top/bottom. Keep the rider seated on the deck, idle it; in loop
      // mode, cycle after a hold.
      this._seatRider();
      if (this.rider) this.rider.model.update(dt, 0, 0);
      if (this.loop) {
        this.t += dt;
        if (this.phase === 'top' && this.t >= HOLD_TOP) { this.phase = 'lowering'; this.t = 0; }
        else if (this.phase === 'down' && this.t >= HOLD_BOT) { this.phase = 'rising'; this.t = 0; }
      }
    }
  }

  // Striped collar ring at the shaft mouth (flat, world-UV'd so stripes stay even).
  // inner = hole radius, outer = outer edge radius.
  _collar(inner, outer) {
    const shape = new THREE.Shape();
    shape.moveTo(-outer, -outer); shape.lineTo(outer, -outer);
    shape.lineTo(outer, outer); shape.lineTo(-outer, outer); shape.closePath();
    const hole = new THREE.Path();
    hole.moveTo(-inner, -inner); hole.lineTo(-inner, inner);
    hole.lineTo(inner, inner); hole.lineTo(inner, -inner); hole.closePath();
    shape.holes.push(hole);
    const geo = new THREE.ShapeGeometry(shape);
    const pos = geo.attributes.position;
    const uv = new Float32Array(pos.count * 2);
    const period = 2.2;
    for (let i = 0; i < pos.count; i++) {
      uv[i * 2] = pos.getX(i) / period;
      uv[i * 2 + 1] = pos.getY(i) / period;
    }
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    const mat = new THREE.MeshStandardMaterial({ map: HAZARD_TEX.clone(), roughness: 0.7 });
    mat.map.needsUpdate = true;
    const frame = new THREE.Mesh(geo, mat);
    frame.rotation.x = -Math.PI / 2;
    // Lifted a touch above the surface so the flush liner lip + the gate road tiles
    // (which overlap its outer edge) don't bury or z-fight it.
    frame.position.set(this.center.x, this.groundY + 0.15, this.center.z);
    frame.receiveShadow = true;
    return frame;
  }

  // Punch a stencil hole in the ocean over the shaft footprint. A flat marker quad
  // at the mouth writes stencil ref 1 (depth-test off, drawn first); the global
  // water + sea-floor materials are told to skip wherever stencil == 1, so neither
  // draws inside the pit. The dark liner shows through instead of the sea.
  _maskWater(map, shaftHalf) {
    const mat = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, depthTest: false });
    mat.stencilWrite = true;
    mat.stencilRef = 1;
    mat.stencilFunc = THREE.AlwaysStencilFunc;
    mat.stencilZPass = THREE.ReplaceStencilOp;
    const q = new THREE.Mesh(new THREE.PlaneGeometry(shaftHalf * 2, shaftHalf * 2), mat);
    q.rotation.x = -Math.PI / 2;
    q.position.set(this.center.x, this.groundY + 0.02, this.center.z);
    q.renderOrder = -10;            // mark the stencil before anything reads it
    this.group.add(q);

    for (const plane of [map.water, map.seaFloor]) {
      if (!plane) continue;
      const m = plane.material;
      m.stencilWrite = true;
      m.stencilFunc = THREE.NotEqualStencilFunc;
      m.stencilRef = 1;
      m.needsUpdate = true;
    }
  }

  dispose() {
    this.group.traverse(o => { if (o.geometry) o.geometry.dispose(); });
  }
}
