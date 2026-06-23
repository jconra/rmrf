// Plants.js — all procedural low-poly flora makers in one catalog: trees,
// bushes, grasses, rocks, dead trees, and the signature beach palm. Flat-shaded
// to match the Return Fire look. Each maker returns a THREE.Group with its base
// at y=0; variants come from internal randomness, so calling a maker repeatedly
// yields a varied set. Foliage.js instances these across the map.
//
// (Merged from the former FoliageModels.js + Palm.js — one home for plants.)

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// ── Shared materials ────────────────────────────────────────────────────────
const BARK    = new THREE.MeshStandardMaterial({ color: '#8a6a42', roughness: 1.0, flatShading: true });
const DRYBARK = new THREE.MeshStandardMaterial({ color: '#9c8460', roughness: 1.0, flatShading: true });
const LEAF    = new THREE.MeshStandardMaterial({ color: '#416125', roughness: 0.95, flatShading: true });
const LEAF2   = new THREE.MeshStandardMaterial({ color: '#4c6d29', roughness: 0.95, flatShading: true });
const ROCK    = new THREE.MeshStandardMaterial({ color: '#9a948a', roughness: 1.0, flatShading: true });
const PALM_TRUNK = new THREE.MeshStandardMaterial({ color: '#9a7b4f', roughness: 1.0, flatShading: true });
const PALM_FROND = new THREE.MeshStandardMaterial({ color: '#416125', roughness: 0.95, flatShading: true, side: THREE.DoubleSide });
const PALM_COCO  = new THREE.MeshStandardMaterial({ color: '#5a4326', roughness: 1.0, flatShading: true });

const rand = (a, b) => a + Math.random() * (b - a);

// Jitter an icosphere's vertices a little so blobs/rocks aren't perfectly round.
function lumpy(geo, amt) {
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    p.setXYZ(i,
      p.getX(i) * (1 + rand(-amt, amt)),
      p.getY(i) * (1 + rand(-amt, amt)),
      p.getZ(i) * (1 + rand(-amt, amt)));
  }
  geo.computeVertexNormals();
  return geo;
}

// ── Inland flora ────────────────────────────────────────────────────────────

// Rounded leafy tree: tapered trunk + a clustered blobby canopy.
export function makeTree() {
  const g = new THREE.Group();
  const h = rand(1.3, 1.9);
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.2, h, 6), BARK);
  trunk.position.y = h / 2;
  g.add(trunk);
  const mat = Math.random() < 0.5 ? LEAF : LEAF2;
  const blobs = 2 + (Math.random() * 2 | 0);
  for (let i = 0; i < blobs; i++) {
    const r = rand(0.55, 0.85);
    const blob = new THREE.Mesh(lumpy(new THREE.IcosahedronGeometry(r, 0), 0.18), mat);
    blob.position.set(rand(-0.4, 0.4), h + rand(0.1, 0.8), rand(-0.4, 0.4));
    g.add(blob);
  }
  return g;
}

// Bare, spiky dead tree: thin trunk + a few angled branches.
export function makeDeadTree() {
  const g = new THREE.Group();
  const h = rand(1.8, 2.6);
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.16, h, 5), DRYBARK);
  trunk.position.y = h / 2;
  g.add(trunk);
  const branches = 3 + (Math.random() * 3 | 0);
  for (let i = 0; i < branches; i++) {
    const bl = rand(0.4, 0.9);
    const br = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.06, bl, 4), DRYBARK);
    br.position.y = bl / 2;
    const pivot = new THREE.Group();
    pivot.add(br);
    pivot.position.y = rand(h * 0.5, h * 0.95);
    pivot.rotation.z = rand(0.5, 1.1) * (Math.random() < 0.5 ? 1 : -1);
    pivot.rotation.y = Math.random() * Math.PI * 2;
    g.add(pivot);
  }
  return g;
}

// Low leafy bush: a couple of clustered blobs near the ground.
export function makeBush() {
  const g = new THREE.Group();
  const mat = Math.random() < 0.5 ? LEAF : LEAF2;
  const blobs = 2 + (Math.random() * 2 | 0);
  for (let i = 0; i < blobs; i++) {
    const r = rand(0.35, 0.55);
    const blob = new THREE.Mesh(lumpy(new THREE.IcosahedronGeometry(r, 0), 0.22), mat);
    blob.position.set(rand(-0.35, 0.35), r * rand(0.7, 1.0), rand(-0.35, 0.35));
    g.add(blob);
  }
  return g;
}

// Small grass/plant tuft: a few splayed blades.
export function makePlant() {
  const g = new THREE.Group();
  const mat = Math.random() < 0.5 ? LEAF : LEAF2;
  const blades = 4 + (Math.random() * 3 | 0);
  for (let i = 0; i < blades; i++) {
    const bl = rand(0.35, 0.6);
    const blade = new THREE.Mesh(new THREE.CylinderGeometry(0.0, 0.05, bl, 4), mat);
    blade.position.y = bl / 2;
    const pivot = new THREE.Group();
    pivot.add(blade);
    pivot.rotation.z = rand(-0.4, 0.4);
    pivot.rotation.y = Math.random() * Math.PI * 2;
    pivot.position.set(rand(-0.12, 0.12), 0, rand(-0.12, 0.12));
    g.add(pivot);
  }
  return g;
}

// Rock: a flattened lumpy icosphere.
export function makeRock() {
  const g = new THREE.Group();
  const r = rand(0.35, 0.6);
  const rock = new THREE.Mesh(lumpy(new THREE.IcosahedronGeometry(r, 0), 0.28), ROCK);
  rock.scale.y = rand(0.5, 0.8);
  rock.position.y = r * 0.3;
  rock.rotation.y = Math.random() * Math.PI * 2;
  g.add(rock);
  return g;
}

// ── Beach palm ──────────────────────────────────────────────────────────────

// A single drooping frond blade along +X, tapering to a point, sagging in -Y.
function frondGeometry() {
  // Cross-sections along the blade: [x, yDroop, halfWidth]
  const sec = [
    [0.0, 0.00, 0.10],
    [0.7, 0.02, 0.26],
    [1.5, -0.10, 0.20],
    [2.3, -0.40, 0.11],
    [2.9, -0.85, 0.00],
  ];
  const pos = [];
  for (let i = 0; i < sec.length - 1; i++) {
    const [x0, y0, w0] = sec[i];
    const [x1, y1, w1] = sec[i + 1];
    // Two triangles forming the quad between section i and i+1.
    pos.push(x0, y0, -w0,  x1, y1, -w1,  x1, y1, w1);
    pos.push(x0, y0, -w0,  x1, y1, w1,   x0, y0, w0);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.scale(0.8, 1, 1);   // fronds at 80% length (deliberate choice)
  g.computeVertexNormals();
  return g;
}

export function makePalm() {
  const group = new THREE.Group();

  // Trunk: tapered, slightly curved (lean) cylinder.
  const H = 4.2;
  const trunk = new THREE.CylinderGeometry(0.12, 0.24, H, 6, 6, true);
  trunk.translate(0, H / 2, 0);
  const tp = trunk.attributes.position;
  for (let i = 0; i < tp.count; i++) {
    const y = tp.getY(i);
    const t = y / H;
    tp.setX(i, tp.getX(i) + Math.sin(t * 1.3) * 0.55);   // gentle curve
    tp.setZ(i, tp.getZ(i) + t * 0.12);
  }
  trunk.computeVertexNormals();
  const trunkTopX = Math.sin(1.3) * 0.55, trunkTopZ = 0.12;
  group.add(new THREE.Mesh(trunk, PALM_TRUNK));

  // Crown: a ring of fronds at the trunk top.
  const fronds = [];
  const N = 9;
  for (let i = 0; i < N; i++) {
    const f = frondGeometry();
    const yaw = (i / N) * Math.PI * 2 + Math.random() * 0.2;
    const tilt = -0.35 - Math.random() * 0.25;            // droop outward/down
    const m = new THREE.Matrix4()
      .makeTranslation(trunkTopX, H, trunkTopZ)
      .multiply(new THREE.Matrix4().makeRotationY(yaw))
      .multiply(new THREE.Matrix4().makeRotationZ(tilt));
    f.applyMatrix4(m);
    fronds.push(f);
  }
  group.add(new THREE.Mesh(mergeGeometries(fronds), PALM_FROND));

  // A couple of coconuts under the crown.
  const cocos = [];
  for (let i = 0; i < 3; i++) {
    const c = new THREE.IcosahedronGeometry(0.13, 0);
    const a = Math.random() * Math.PI * 2;
    c.translate(trunkTopX + Math.cos(a) * 0.18, H - 0.2, trunkTopZ + Math.sin(a) * 0.18);
    cocos.push(c);
  }
  group.add(new THREE.Mesh(mergeGeometries(cocos), PALM_COCO));

  return group;
}
