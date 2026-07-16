// Destructible.js — shared HP/damage system. Anything shootable (walls, base
// buildings, defensive guns, bridges, palms, grass) registers here. Keeps the
// damage model in ONE place so every prop behaves consistently.

import * as THREE from 'three';

let _id = 0;

// Progressive battle-damage look. Scorch = the colour a battered surface fades toward.
const SCORCH = new THREE.Color('#241f1b');
const CRACK_STAGES = 4;
// Draw an IMPACT FRACTURE onto a texture canvas: cracks radiate out from a single
// point (a hit), zigzagging and forking like a shattered panel — not scattered loose
// segments. Called cumulatively (each stage = a new impact star as HP falls). One-off
// canvas draw per stage (≤4 over a prop's life), so no per-frame cost.
function drawCracks(ctx, w, h, frac) {
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // Impact origin — somewhere on the face, biased away from the very edges.
  const ox = w * (0.2 + Math.random() * 0.6), oy = h * (0.2 + Math.random() * 0.6);
  const rays = 5 + Math.floor(frac * 6);          // more fractures the more battered it is
  const reach = Math.min(w, h) * (0.22 + frac * 0.32);
  // A small dark impact blotch at the centre, so the star reads as a HIT.
  ctx.fillStyle = 'rgba(15,12,9,0.5)';
  ctx.beginPath(); ctx.arc(ox, oy, 1.5 + frac * 2.5, 0, Math.PI * 2); ctx.fill();

  const drawRay = (sx, sy, ang0, len, width) => {
    let x = sx, y = sy, ang = ang0;
    const steps = 3 + (Math.random() * 3 | 0), step = len / steps;
    for (let s = 0; s < steps; s++) {
      ang += (Math.random() - 0.5) * 0.9;         // zigzag wobble along the crack
      const nx = x + Math.cos(ang) * step, ny = y + Math.sin(ang) * step;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(nx, ny);
      const wd = width * (1 - s / steps) + 0.4;   // taper from thick at the origin to a hairline
      ctx.strokeStyle = 'rgba(15,12,9,0.9)'; ctx.lineWidth = wd; ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.05)'; ctx.lineWidth = Math.max(0.5, wd * 0.5); ctx.stroke();
      // occasional fork partway out (one level deep — keeps it cheap)
      if (width > 1 && s > 0 && Math.random() < 0.28)
        drawRay(nx, ny, ang + (Math.random() - 0.5) * 1.7, step * (1 + Math.random()), wd * 0.7);
      x = nx; y = ny;
    }
  };
  for (let i = 0; i < rays; i++) {
    const ang = (i / rays) * Math.PI * 2 + (Math.random() - 0.5) * 0.7;
    drawRay(ox, oy, ang, reach * (0.5 + Math.random() * 0.7), 1.8 + Math.random() * 0.8);
  }
}

// Nearest authored staging entry to a piece's local position (for fallStages overrides).
function _nearestStage(stages, pos) {
  let best = null, bd = Infinity;
  for (const s of stages) {
    const dx = s.pos[0] - pos.x, dy = s.pos[1] - pos.y, dz = s.pos[2] - pos.z;
    const d = dx * dx + dy * dy + dz * dz;
    if (d < bd) { bd = d; best = s; }
  }
  return best;
}

export class Destructible {
  // mesh: the intact THREE.Object3D (already positioned in its parent).
  // opts.hp        — hit points
  // opts.type      — 'wall' | 'building' | 'gun' | 'bridge' | 'plant' ...
  // opts.makeRubble() -> Object3D to drop in place when destroyed (optional)
  // opts.blocks    — does it block movement/projectiles while alive (default true)
  // opts.onDestroyed(d) — callback
  constructor(mesh, opts = {}) {
    this.id = ++_id;
    this.mesh = mesh;
    this.type = opts.type || 'structure';
    this.maxHp = opts.hp ?? 100;
    this.hp = this.maxHp;
    this.makeRubble = opts.makeRubble || null;
    this.blocks = opts.blocks !== false;
    this.onDestroyed = opts.onDestroyed || null;
    this.onDamage = opts.onDamage || null;   // called after each hit (for staged crumble)
    this.dead = false;
    this.rubble = null;

    // Generic STAGED CRUMBLE (opt-in): each child piece lets go as HP falls and tumbles
    // or squishes to rubble — top-down by default, or per-piece if its userData carries
    // fallAt / dmgStyle (authored in the asset designer). Walls keep their own system.
    this.staged = !!opts.staged;
    if (this.staged) this._initStaged();

    // Damage feedback state. Materials are cloned per-object on first hit so scarring
    // THIS prop never bleeds onto others sharing the same material/texture.
    this._flash = 0;
    this._unique = null;
    this._stage = 0;       // highest crack stage drawn so far

    this._worldCenter = new THREE.Vector3();
    this._radius = 1;
    this.refresh();
  }

  // Recompute world-space bounds (call after the mesh is added to the scene
  // graph and positioned, or after anything that moves it).
  refresh() {
    const box = new THREE.Box3().setFromObject(this.mesh);
    box.getCenter(this._worldCenter);
    const sph = new THREE.Sphere();
    box.getBoundingSphere(sph);
    this._radius = sph.radius;
  }

  get worldCenter() { return this._worldCenter; }
  get radius() { return this._radius; }

  damage(amount, point) {
    if (this.dead || amount <= 0) return;
    this.hp -= amount;
    this._flash = 1;        // white-hot flash on hit
    this._applyWear();      // deepen scorch + cracks for the new HP level
    if (this.staged) this._restageFall();   // shed any pieces whose threshold the hit crossed
    if (this.onDamage) this.onDamage(this);
    if (this.hp <= 0) this._destroy();
  }

  // Restore HP (a repair). Walks the visible battle-damage BACK toward the new, healthier
  // level: relights the scorched colour and, if the heal crosses a crack stage, redraws the
  // texture with fewer fractures. onDamage re-runs the owner's staging (a Wall at high HP frac
  // sheds nothing, so this just settles it at the repaired look). No-op on a dead object —
  // rubble doesn't un-break; only a still-standing structure can be patched.
  heal(amount) {
    if (this.dead || amount <= 0) return;
    this.hp = Math.min(this.maxHp, this.hp + amount);
    const sev = this.maxHp ? 1 - Math.max(0, this.hp) / this.maxHp : 0;
    if (this._unique) {
      for (const u of this._unique) if (u.base) u.mat.color.copy(u.base).lerp(SCORCH, sev * 0.65);
      const stage = Math.min(CRACK_STAGES, Math.ceil(sev * CRACK_STAGES));
      if (stage < this._stage && this._unique.some(u => u.ctx)) {
        this._stage = stage;
        for (const u of this._unique) if (u.ctx && u.srcImg) {
          u.ctx.drawImage(u.srcImg, 0, 0, u.w, u.h);               // repaint the pristine surface from the source texture
          if (stage > 0) drawCracks(u.ctx, u.w, u.h, stage / CRACK_STAGES);   // then only the remaining cracks
          u.tex.needsUpdate = true;
        }
      }
    }
    if (this.onDamage) this.onDamage(this);
  }

  // ── Staged crumble ──────────────────────────────────────────────────────────
  _initStaged() {
    this._pieces = [];
    const kids = this.mesh.children.filter(o => o.isMesh || o.isGroup);
    let minY = Infinity, maxY = -Infinity;
    for (const k of kids) { minY = Math.min(minY, k.position.y); maxY = Math.max(maxY, k.position.y); }
    const span = Math.max(1e-3, maxY - minY);
    const stages = this.mesh.userData.fallStages || null;   // authored overrides (applyStaging)
    for (const k of kids) {
      const u = k.userData || {};
      const hNorm = (k.position.y - minY) / span;                        // 0 bottom .. 1 top
      const def = 0.15 + hNorm * 0.65;                                   // height default: taller lets go first
      const a = stages ? _nearestStage(stages, k.position) : null;       // authored, matched by position
      const fallAt = a && a.fallAt != null ? a.fallAt : (u.fallAt != null ? u.fallAt : def);
      const style = (a && a.dmgStyle) || u.dmgStyle || 'tumble';
      this._pieces.push({ obj: k, fallAt, style, turret: !!u.turret, sweep: Math.random() * 6.283,
        falling: false, settled: false, t: 0,
        vel: new THREE.Vector3(), ang: new THREE.Vector3(), y0: k.position.y, s0: k.scale.clone() });
    }
    this._hasTurret = this._pieces.some(p => p.turret);
  }
  _restageFall() {
    const frac = Math.max(0, this.hp / this.maxHp);
    if (this._hasTurret) {
      // Gravity coherence: a turret/keystone piece sits on top, so while one still stands
      // it holds everything below up — nothing else sheds. The keystone falls at its OWN
      // threshold; once it's down, the rest crumble to catch up to the damage.
      for (const p of this._pieces) if (p.turret && !p.falling && !p.settled && p.fallAt >= frac) this._kickPiece(p);
      if (this._pieces.some(p => p.turret && !p.falling && !p.settled)) return;
    }
    for (const p of this._pieces) if (!p.falling && !p.settled && p.fallAt >= frac) this._kickPiece(p);
  }
  _kickPiece(p) {
    p.falling = true;
    if (p.style === 'squish') return;        // squish = a flatten lerp (see _tickStaged)
    const a = Math.random() * Math.PI * 2;
    p.vel.set(Math.cos(a) * 2.2, 2.6, Math.sin(a) * 2.2);
    p.ang.set((Math.random() - 0.5) * 6, (Math.random() - 0.5) * 4, (Math.random() - 0.5) * 6);
  }
  _tickStaged(dt) {
    for (const p of this._pieces) {
      if (p.turret && !p.falling && !p.settled) {   // idle scan-sweep while the gun still stands
        p.sweep += dt * 0.6; p.obj.rotation.y = Math.sin(p.sweep) * 0.8; continue;
      }
      if (!p.falling || p.settled) continue;
      const o = p.obj;
      if (p.style === 'squish') {
        p.t = Math.min(1, p.t + dt * 2.4);
        o.scale.set(p.s0.x * (1 + 0.3 * p.t), p.s0.y * (1 - 0.9 * p.t), p.s0.z * (1 + 0.3 * p.t));
        o.position.y = p.y0 * (1 - 0.92 * p.t);
        if (p.t >= 1) p.settled = true;
      } else {
        p.vel.y -= 14 * dt;
        o.position.x += p.vel.x * dt; o.position.y += p.vel.y * dt; o.position.z += p.vel.z * dt;
        o.rotation.x += p.ang.x * dt; o.rotation.y += p.ang.y * dt; o.rotation.z += p.ang.z * dt;
        if (o.position.y <= 0.25) { o.position.y = 0.25; p.settled = true; }
      }
    }
  }

  // Clone this object's materials (and any texture maps) so progressive damage marks
  // only THIS prop, not everything sharing the original material/texture.
  _makeUnique() {
    this._unique = [];
    this.mesh.traverse(o => {
      if (!o.isMesh || !o.material) return;
      const arr = Array.isArray(o.material) ? o.material : [o.material];
      const cloned = arr.map(m => {
        const c = m.clone();
        const u = { mat: c, base: c.color ? c.color.clone() : null };
        if (c.map && c.map.image) {
          const img = c.map.image, w = img.width || 128, h = img.height || 128;
          const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
          const ctx = cv.getContext('2d'); ctx.drawImage(img, 0, 0, w, h);
          const tex = new THREE.CanvasTexture(cv);
          tex.colorSpace = c.map.colorSpace; tex.wrapS = c.map.wrapS; tex.wrapT = c.map.wrapT;
          tex.repeat.copy(c.map.repeat); tex.anisotropy = c.map.anisotropy;
          // keep the SOURCE image; heal() redraws it to restore the pristine surface. (Was a
          // getImageData snapshot — that synchronous canvas readback was the getImageData stutter.)
          c.map = tex; u.ctx = ctx; u.tex = tex; u.w = w; u.h = h; u.srcImg = img;
        }
        this._unique.push(u);
        return c;
      });
      o.material = Array.isArray(o.material) ? cloned : cloned[0];
    });
  }

  // Darken toward scorch + scratch in new cracks as HP falls.
  _applyWear() {
    const sev = this.maxHp ? 1 - Math.max(0, this.hp) / this.maxHp : 0;
    if (sev <= 0) return;
    if (!this._unique) this._makeUnique();
    for (const u of this._unique) if (u.base) u.mat.color.copy(u.base).lerp(SCORCH, sev * 0.65);
    const stage = Math.min(CRACK_STAGES, Math.ceil(sev * CRACK_STAGES));
    while (this._stage < stage) {
      this._stage++;
      for (const u of this._unique) if (u.ctx) { drawCracks(u.ctx, u.w, u.h, this._stage / CRACK_STAGES); u.tex.needsUpdate = true; }
    }
  }

  // Bring a destroyed object back at `hp` (a rebuild). Re-attaches the intact mesh where it was
  // and clears any dropped rubble; the caller then heal()s it up (heal no-ops while dead, so a
  // rebuild is always revive-then-heal). The owner is responsible for restoring its own staging
  // (e.g. a Wall snaps crumbled layers back as its HP climbs — see Wall._restage's rebuild branch).
  revive(hp = 1) {
    // A rebuilt structure BLOCKS again — cached paths routed through the gap must replan.
    if (this.blocks && Destructible.onBlocksChanged) Destructible.onBlocksChanged();
    if (!this.dead) return;
    this.dead = false;
    this.hp = Math.min(this.maxHp, Math.max(1, hp));
    if (!this.mesh.parent && this._parent) this._parent.add(this.mesh);
    if (this.rubble && this.rubble.parent) { this.rubble.parent.remove(this.rubble); this.rubble = null; }
    this._flash = 0;
    this._applyWear();     // battered look for the (low) revived HP; heal() relights it from here
    this.refresh();
    if (this.onDamage) this.onDamage(this);   // let the owner re-run its staging at the new HP
  }

  _destroy() {
    this.dead = true;
    // The pathing world just changed (a blocking structure fell → routes THROUGH it opened):
    // wake the nav caches (event-driven invalidation — see bumpNavEpoch in main.js).
    if (this.blocks && Destructible.onBlocksChanged) Destructible.onBlocksChanged();
    this._parent = this.mesh.parent;   // remembered so revive() can re-attach the mesh
    if (this.staged) {           // pieces ARE the rubble — drop whatever's still standing, keep them in place
      this._restageFall();
      if (this.onDestroyed) this.onDestroyed(this);
      return;
    }
    const parent = this.mesh.parent;
    if (this.makeRubble && parent) {
      const r = this.makeRubble();
      r.position.copy(this.mesh.position);
      r.quaternion.copy(this.mesh.quaternion);
      r.scale.copy(this.mesh.scale);
      parent.add(r);
      this.rubble = r;
    }
    if (parent) parent.remove(this.mesh);
    if (this.onDestroyed) this.onDestroyed(this);
  }

  // Per-frame: the white hit-flash decays to nothing. Sustained battle damage is read
  // from the DARKENED surface (the scorch lerp in _applyWear) + the crack fractures —
  // no coloured ember glow (a damaged prop should just look charred, not lit red). Only
  // touches materials while the flash is live (by then they've been cloned).
  update(dt) {
    if (this.staged) this._tickStaged(dt);   // keep tumbling/squishing even after death
    if (this.dead || this._flash <= 0) return;
    this._flash = Math.max(0, this._flash - dt * 3.2);
    const k = this._flash;
    this.mesh.traverse(o => {
      if (!o.isMesh || !o.material) return;
      const arr = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of arr) if (m.emissive) m.emissive.setRGB(k, k, k);   // neutral white flash → dark
    });
  }
}

export class DestructibleManager {
  constructor() {
    this.items = [];
    this._byMesh = new Map();   // child-mesh uuid -> Destructible (for raycasts)
    this._meshes = [];          // flat list of raycastable meshes
  }

  add(d) {
    this.items.push(d);
    d.mesh.traverse(o => {
      if (o.isMesh) {
        this._byMesh.set(o.uuid, d);
        this._meshes.push(o);
      }
    });
    return d;
  }

  // Drop a Destructible from tracking (a transient like a repair-crew jeep that has left
  // the field). Prunes it from the item list and the raycast maps so it stops being a target.
  remove(d) {
    const i = this.items.indexOf(d); if (i >= 0) this.items.splice(i, 1);
    d.mesh.traverse(o => {
      if (!o.isMesh) return;
      this._byMesh.delete(o.uuid);
      const j = this._meshes.indexOf(o); if (j >= 0) this._meshes.splice(j, 1);
    });
  }

  // Recompute all bounds (after bases/props are placed in the scene).
  refreshAll() { for (const d of this.items) d.refresh(); }

  // Radial/splash damage at a world point. Splash caps at SPLASH_MAX of the round's damage
  // even at point-blank: a round that lands a DIRECT hit (full damage, applied separately by
  // the caller) can't also splash itself for a near-full second hit. So a Valkyrie missile
  // does 90 direct + ≤72 splash = ≤162 to a 180hp turret — two missiles to kill, not one.
  damageAt(point, radius, amount) {
    const SPLASH_MAX = 0.8;
    for (const d of this.items) {
      if (d.dead) continue;
      const dist = d.worldCenter.distanceTo(point);
      const reach = radius + d.radius;
      if (dist <= reach) {
        const falloff = Math.min(SPLASH_MAX, 1 - Math.min(1, dist / reach));
        d.damage(amount * falloff, point);
      }
    }
  }

  // First live, blocking destructible near `point` (horizontal distance, since
  // walls/buildings are tall and projectiles fly low), else null. Impact tests.
  queryHit(point, pad = 0) {
    for (const d of this.items) {
      if (d.dead || !d.blocks) continue;
      const dx = point.x - d._worldCenter.x, dz = point.z - d._worldCenter.z;
      const reach = d._radius + pad;
      if (dx * dx + dz * dz <= reach * reach) return d;
    }
    return null;
  }

  // Resolve a raycast to the Destructible that was hit (or null).
  pick(raycaster) {
    const hits = raycaster.intersectObjects(this._meshes, false);
    for (const h of hits) {
      const d = this._byMesh.get(h.object.uuid);
      if (d && !d.dead) return { d, point: h.point };
    }
    return null;
  }

  update(dt) { for (const d of this.items) d.update(dt); }
}
