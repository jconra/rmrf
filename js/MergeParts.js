// MergeParts.js — collapse a rigid frame's many little Meshes into ONE Mesh per material.
// A vehicle is ~70 tiny box/cylinder Meshes but only 3-4 materials, so the renderer pays
// ~70 draw calls where a handful would do. Everything that never moves RELATIVE TO its
// frame (the hull plates on the group, the barrels on the turret, the claws on a foot
// pad) can be baked into one geometry per material with zero visual or animation change.
// The caller names each rigid frame and the dynamic nodes to leave alone; anything the
// animation code repositions per-frame (IK legs, rotors) must be skipped or merged only
// within its own moving group.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const _inv = new THREE.Matrix4(), _rel = new THREE.Matrix4();

// Merge all Mesh descendants of `root` into one Mesh per material, baking each mesh's
// transform RELATIVE TO ROOT into the geometry. `skip`: nodes (and their subtrees) to
// leave untouched — animated groups, muzzle flashes, anything referenced for per-frame
// mutation. Original meshes are removed; merged meshes are added directly under root.
// Returns the merged meshes (mostly for debugging).
export function mergeStatic(root, skip = []) {
  const skipSet = new Set(skip);
  root.updateMatrixWorld(true);
  _inv.copy(root.matrixWorld).invert();
  const buckets = new Map();   // material -> [geometry]
  const doomed = [];
  (function walk(o) {
    if (o !== root && skipSet.has(o)) return;          // dynamic subtree — leave whole
    if (o.isMesh && !o.isInstancedMesh) {   // an InstancedMesh IS the optimization — never bake it
      // Multi-material meshes and non-indexed exotics are rare here; skip them safely.
      if (!Array.isArray(o.material)) {
        _rel.copy(_inv).multiply(o.matrixWorld);
        const c = o.geometry.clone().applyMatrix4(_rel);
        // Normalize to NON-indexed: primitives (box/cylinder/sphere) are indexed but
        // ExtrudeGeometry isn't, and mergeGeometries refuses a mixed bucket outright.
        const g = c.index ? c.toNonIndexed() : c;
        if (g !== c) c.dispose();
        if (!buckets.has(o.material)) buckets.set(o.material, []);
        buckets.get(o.material).push(g);
        doomed.push(o);
      }
    }
    for (const c of [...o.children]) walk(c);
  })(root);
  for (const m of doomed) m.parent.remove(m);
  // Empty groups left behind (e.g. a foot pad whose 5 claws merged) are pruned so the
  // scene graph doesn't accumulate husks — EXCEPT skipped nodes, which the animation
  // code still owns even when childless.
  (function prune(o) {
    for (const c of [...o.children]) prune(c);
    if (o !== root && o.isGroup && !o.children.length && !skipSet.has(o)) o.parent.remove(o);
  })(root);
  const out = [];
  for (const [mat, geos] of buckets) {
    const merged = new THREE.Mesh(mergeGeometries(geos, false), mat);
    for (const g of geos) g.dispose();                 // the clones served their purpose
    root.add(merged);
    out.push(merged);
  }
  return out;
}
