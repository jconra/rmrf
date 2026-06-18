// Destructible.js — shared HP/damage system. Anything shootable (walls, base
// buildings, defensive guns, bridges, palms, grass) registers here. Keeps the
// damage model in ONE place so every prop behaves consistently.

import * as THREE from 'three';

let _id = 0;

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

    // Damage feedback state.
    this._flash = 0;
    this._origEmissive = [];

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
    this._flash = 1; // brief white-hot flash on hit
    if (this.onDamage) this.onDamage(this);
    if (this.hp <= 0) this._destroy();
  }

  _destroy() {
    this.dead = true;
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

  // Per-frame: decay the hit flash. (Cheap; only touches materials when flashing.)
  update(dt) {
    if (this._flash > 0 && !this.dead) {
      this._flash = Math.max(0, this._flash - dt * 4);
      const k = this._flash;
      this.mesh.traverse(o => {
        if (o.isMesh && o.material && o.material.emissive) {
          o.material.emissive.setRGB(k, k, k);
        }
      });
    }
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

  // Recompute all bounds (after bases/props are placed in the scene).
  refreshAll() { for (const d of this.items) d.refresh(); }

  // Radial/splash damage at a world point.
  damageAt(point, radius, amount) {
    for (const d of this.items) {
      if (d.dead) continue;
      const dist = d.worldCenter.distanceTo(point);
      const reach = radius + d.radius;
      if (dist <= reach) {
        const falloff = 1 - Math.min(1, dist / reach);
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
