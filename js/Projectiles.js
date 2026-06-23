// Projectiles.js — visible shots fired from the muzzles. One manager owns all live
// projectiles, updates them each frame, and disposes them when spent.
//
// Types by vehicle index:
//   0 LURCHER  — fast kinetic tracer (thin bright streak)
//   1 FIREBRAT — hitscan LASER beam (instant full-length flash that fades)
//   2 VALKYRIE — a real MISSILE that accelerates away with an exhaust trail
//   3 JOTUN    — heavy railgun SLUG (longer/fatter/faster tracer, team-coloured)
//
// spawn(index, pos, dir, teamHex): pos = muzzle world position (Vector3),
// dir = unit world forward (Vector3). Geometry is built pointing +Z (or -Z for the
// missile nose) then oriented onto `dir`.

import * as THREE from 'three';

const FWD_Z = new THREE.Vector3(0, 0, 1);
const FWD_NEG_Z = new THREE.Vector3(0, 0, -1);
const _steer = new THREE.Vector3();

export class Projectiles {
  constructor(scene) {
    this.scene = scene;
    this.items = [];
    this.missileScale = 1;   // game bumps this (missiles read tiny against big world vehicles)
  }

  spawn(index, pos, dir, teamHex) {
    const d = dir.clone().normalize();
    let p;
    if      (index === 1) p = this._laser(pos, d, teamHex);
    else if (index === 2) p = this._missile(pos, d, teamHex);
    else if (index === 3) p = this._slug(pos, d, teamHex, true);
    else                  p = this._slug(pos, d, 0xfff0a0, false);
    if (p) { this.scene.add(p.obj); this.items.push(p); }
  }

  update(delta) {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const p = this.items[i];
      p.life -= delta;
      p.update(delta);
      if (p.life <= 0) {
        this.scene.remove(p.obj);
        p.dispose();
        this.items.splice(i, 1);
      }
    }
  }

  clear() {
    for (const p of this.items) { this.scene.remove(p.obj); p.dispose(); }
    this.items.length = 0;
  }

  // Kinetic tracer / railgun slug — a stretched additive streak that flies fast.
  _slug(pos, dir, color, heavy) {
    const len = heavy ? 3.2 : 1.8;
    const r   = heavy ? 0.085 : 0.045;
    const geo = new THREE.CylinderGeometry(r, r, len, 6);
    geo.rotateX(Math.PI / 2);                      // axis → +Z
    const mat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.95,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(pos);
    mesh.quaternion.setFromUnitVectors(FWD_Z, dir);
    const vel = dir.clone().multiplyScalar(heavy ? 115 : 85);
    return {
      obj: mesh, life: heavy ? 0.7 : 0.5,
      update(delta) {
        mesh.position.addScaledVector(vel, delta);
        mat.opacity = Math.max(0, mat.opacity - delta * 0.5);
      },
      dispose() { geo.dispose(); mat.dispose(); },
    };
  }

  // Hitscan laser — appears full-length instantly and fades + thins fast.
  _laser(pos, dir, color) {
    const len = 40;
    const geo = new THREE.CylinderGeometry(0.022, 0.022, len, 6);
    geo.rotateX(Math.PI / 2);
    geo.translate(0, 0, len / 2);                  // extend forward from the muzzle
    const mat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.9,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(pos);
    mesh.quaternion.setFromUnitVectors(FWD_Z, dir);
    return {
      obj: mesh, life: 0.13,
      update(delta) {
        mat.opacity = Math.max(0, mat.opacity - delta * 7);
        const s = Math.max(0.15, mesh.scale.x - delta * 6);
        mesh.scale.x = mesh.scale.y = s;           // thins as it fades
      },
      dispose() { geo.dispose(); mat.dispose(); },
    };
  }

  // Real missile — body + nose + a flickering additive exhaust, accelerating away.
  _missile(pos, dir, color) {
    const g = new THREE.Group();
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x9a9aa2, roughness: 0.5, metalness: 0.5 });
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.36, 8), bodyMat);
    body.rotation.x = Math.PI / 2;
    g.add(body);
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.12, 8), bodyMat);
    nose.rotation.x = -Math.PI / 2;
    nose.position.z = -0.24;                        // nose forward (−Z local)
    g.add(nose);
    const flameMat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.9,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const flame = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.34, 8), flameMat);
    flame.rotation.x = -Math.PI / 2;
    flame.position.z = 0.34;                        // trails behind (+Z local)
    g.add(flame);

    g.scale.setScalar(this.missileScale);              // larger + readable in the game world
    g.position.copy(pos);
    g.quaternion.setFromUnitVectors(FWD_NEG_Z, dir);   // missile nose (−Z) → dir
    const vel = dir.clone();                           // unit heading; speed is separate
    let speed = 6;
    // Optional guidance: `homingFn()` returns the live target point (Vector3) or
    // null. The heading turns toward it, but only up to `turnRate` rad/s — so a
    // target moving faster than the missile can curve will outrun it.
    let homingFn = null, turnRate = 0;
    return {
      obj: g, life: 2.2,
      setHoming(fn, turn) { homingFn = fn; turnRate = turn; },
      update(delta) {
        speed += 26 * delta;                        // ignites and accelerates
        if (homingFn) {
          const tp = homingFn();
          if (tp) {
            _steer.copy(tp).sub(g.position);
            if (_steer.lengthSq() > 1e-4) {
              _steer.normalize();
              const ang = vel.angleTo(_steer);
              if (ang > 1e-3) {
                vel.lerp(_steer, Math.min(1, (turnRate * delta) / ang)).normalize();
                g.quaternion.setFromUnitVectors(FWD_NEG_Z, vel);   // nose follows the turn
              }
            }
          }
        }
        g.position.addScaledVector(vel, speed * delta);
        flame.scale.z = 0.6 + Math.random() * 0.7;
        flameMat.opacity = 0.7 + Math.random() * 0.3;
      },
      dispose() {
        body.geometry.dispose(); bodyMat.dispose();
        nose.geometry.dispose(); flame.geometry.dispose(); flameMat.dispose();
      },
    };
  }
}
