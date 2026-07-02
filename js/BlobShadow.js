// BlobShadow.js — cheap fake shadows: a soft dark radial-gradient decal laid flat on
// the ground under an object (vehicles + trees), instead of real (costly) shadow maps.
// One shared texture/geometry/material, so a whole tree field is a single draw call and
// each vehicle blob is a tiny per-frame position update.
import * as THREE from 'three';

let _tex = null;
export function blobTexture() {
  if (_tex) return _tex;
  const S = 128, cv = document.createElement('canvas'); cv.width = cv.height = S;
  const ctx = cv.getContext('2d');
  const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0.0, 'rgba(0,0,0,0.85)');
  g.addColorStop(0.55, 'rgba(0,0,0,0.45)');
  g.addColorStop(1.0, 'rgba(0,0,0,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, S, S);
  _tex = new THREE.CanvasTexture(cv);
  return _tex;
}
// One flat unit shadow geometry (1×1 in the XZ plane), shared by every blob.
let _geo = null;
export function blobGeo() { return _geo || (_geo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2)); }
// Shared base material — pure black, soft alpha from the texture, never writes depth so
// it can't occlude (a vehicle body still hides the blob it sits on via normal depth test).
let _mat = null;
function baseMat() {
  return _mat || (_mat = new THREE.MeshBasicMaterial({ map: blobTexture(), color: 0x000000, transparent: true, opacity: 0.5, depthWrite: false }));
}
// A single shadow plane of world `radius`. clone=true gives it its own material so the
// caller can fade it per-frame (vehicles); trees share the base material (static).
export function makeBlobShadow(radius = 2, clone = false) {
  const m = new THREE.Mesh(blobGeo(), clone ? baseMat().clone() : baseMat());
  m.scale.set(radius * 2, 1, radius * 2);
  m.renderOrder = 1;   // draw after the opaque terrain so it blends onto it
  return m;
}
// An InstancedMesh of `count` shadows sharing the base material (one draw call for a
// whole tree field). Caller fills the per-instance matrices (position + flat scale).
export function makeBlobShadowInstanced(count) {
  const inst = new THREE.InstancedMesh(blobGeo(), baseMat(), count);
  inst.renderOrder = 1; inst.frustumCulled = true;
  return inst;
}

// ── Vehicle-shaped shadows ───────────────────────────────────────────────────
// A round blob reads wrong under a vehicle, so bake a top-down SILHOUETTE of the model
// to a texture ONCE per type (flat-black render onto a transparent target), then drape
// it on a ground plane that rotates with the vehicle's heading. Still one textured quad
// per vehicle — as cheap as a blob, but shaped like the thing. Cached by type key.
const _sil = new Map();   // typeKey -> { texture, size }
const _black = new THREE.MeshBasicMaterial({ color: 0x000000 });
export function vehicleSilhouette(renderer, typeKey, modelGroup) {
  if (_sil.has(typeKey)) return _sil.get(typeKey);
  const S = 128;
  const rt = new THREE.WebGLRenderTarget(S, S);
  const sscene = new THREE.Scene();
  const clone = modelGroup.clone(true);
  // Meshes/groups tagged userData.noShadow are left OUT of the silhouette (e.g. the Valkyrie's
  // fan rotors — a static shadow filling the ducts reads as odd; excluding them leaves a clean
  // ring shadow with the duct hole).
  clone.traverse(o => { if (o.userData && o.userData.noShadow) o.visible = false; if (o.isMesh) o.material = _black; });
  sscene.add(clone);
  clone.updateWorldMatrix(true, true);
  const box = new THREE.Box3().setFromObject(clone);
  const cx = (box.min.x + box.max.x) / 2, cz = (box.min.z + box.max.z) / 2;
  const half = Math.max(box.max.x - box.min.x, box.max.z - box.min.z) / 2 * 1.08;
  const cam = new THREE.OrthographicCamera(-half, half, half, -half, 0.1, 1000);
  cam.up.set(0, 0, -1);                       // image "up" = world -Z = vehicle forward
  cam.position.set(cx, box.max.y + 50, cz);
  cam.lookAt(cx, 0, cz);
  const prevRT = renderer.getRenderTarget();
  const prevClear = new THREE.Color(); renderer.getClearColor(prevClear); const prevA = renderer.getClearAlpha();
  renderer.setRenderTarget(rt);
  renderer.setClearColor(0x000000, 0); renderer.clear();
  renderer.render(sscene, cam);
  renderer.setRenderTarget(prevRT);
  renderer.setClearColor(prevClear, prevA);
  const rec = { texture: rt.texture, size: half * 2 };   // square plane of this side keeps proportions
  _sil.set(typeKey, rec);
  return rec;
}
// A ground plane carrying the baked silhouette; caller sets position + rotation.y(heading).
export function makeVehicleShadow(rec) {
  const geo = new THREE.PlaneGeometry(rec.size, rec.size).rotateX(-Math.PI / 2);
  const mat = new THREE.MeshBasicMaterial({ map: rec.texture, color: 0x000000, transparent: true, opacity: 0.5, depthWrite: false });
  const m = new THREE.Mesh(geo, mat); m.renderOrder = 1;
  return m;
}
