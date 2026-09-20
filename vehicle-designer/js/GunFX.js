// GunFX.js — shared muzzle-flash + recoil helpers for vehicle firing animations.
//
// A muzzle flash is a single billboarded additive Sprite parented at a barrel tip.
// It pops bright + small on a shot and expands as it fades over ~70ms. Build one per
// barrel in the vehicle's constructor, call flashMuzzle() on each shot, and
// updateMuzzle() every frame.
//
// Recoil is just a scalar impulse you store on the vehicle: set it to 1 on a shot and
// decay it toward 0 each frame (decayRecoil). The vehicle maps that 1→0 onto a barrel
// slide / nose kick however suits its rig. No allocation in the per-frame path.

import * as THREE from 'three';

export function makeMuzzleFlash(color = 0xfff0c4, size = 0.5) {
  const mat = new THREE.SpriteMaterial({
    color, transparent: true, opacity: 0,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const sp = new THREE.Sprite(mat);
  sp.scale.setScalar(0.0001);
  sp.userData = { size, life: 0 };
  sp.renderOrder = 999;
  return sp;
}

export function flashMuzzle(sp) { sp.userData.life = 1; }

export function updateMuzzle(sp, delta) {
  const ud = sp.userData;
  if (ud.life <= 0) { if (sp.material.opacity !== 0) sp.material.opacity = 0; return; }
  ud.life = Math.max(0, ud.life - delta / 0.07);   // ~70 ms flash
  const e = ud.life;                                // 1 → 0
  sp.material.opacity = e;
  sp.scale.setScalar(ud.size * (0.55 + (1 - e) * 0.9));   // bright+small → faint+big
}

// Ease a recoil impulse (1 → 0) toward rest. `time` = full settle time in seconds.
export const decayRecoil = (r, delta, time = 0.18) => Math.max(0, r - delta / time);
