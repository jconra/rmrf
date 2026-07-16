// Buildings.js — procedural low-poly interior structures placed inside camps.
// Flag/HQ + barracks + depot for a MAIN base; an elevator for a FORWARD base.
// Each maker returns a THREE.Group with its base at y=0. Team accent passed in.

import * as THREE from 'three';
import { concreteTexture, ribbedMetalTexture, fabricTexture, crateTexture, roofTexture, accentPlateTexture, hazardTexture } from './Textures.js?v=2';
import { buildAssetGroup } from './AssetBuilder.js?v=1';
import { mergeByFallBand } from './MergeParts.js?v=1';
import FLAGHQ_CFG from './flaghq.config.js?v=2';
import ADMIN_CFG from './admin.config.js?v=1';
import TENT_CFG from './tent.config.js?v=2';
import LOOKOUT_CFG from './lookout.config.js?v=1';
import BARRACKS_CFG from './barracks.config.js?v=2';
import QUONSET_CFG from './quonset.config.js?v=2';

// Shared neutral plate map tinted per-material by the team accent (matches Walls.js).
const ACCENT_TEX = accentPlateTexture();

// Textured materials (white base so the canvas texture reads at true value).
const STONE = new THREE.MeshStandardMaterial({ color: '#ffffff', map: concreteTexture('#9a948a'), roughness: 0.95 });
const ROOF  = new THREE.MeshStandardMaterial({ color: '#ffffff', map: roofTexture('#6f6a61'), roughness: 0.95 });
const CRATE = new THREE.MeshStandardMaterial({ color: '#ffffff', map: crateTexture('#7a6f52'), roughness: 0.95 });
const METAL = new THREE.MeshStandardMaterial({ color: '#3b3f44', roughness: 0.5, metalness: 0.6, flatShading: true });
const LIFT  = new THREE.MeshStandardMaterial({ color: '#26282b', roughness: 0.8, metalness: 0.3, flatShading: true });
const QHUT  = new THREE.MeshStandardMaterial({ color: '#ffffff', map: ribbedMetalTexture('#b9bdc0'), roughness: 0.7, metalness: 0.3 });
const TENT  = new THREE.MeshStandardMaterial({ color: '#ffffff', map: fabricTexture('#5f7a37'), roughness: 1.0 });

function box(w, h, d, mat) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.castShadow = true; m.receiveShadow = true;
  return m;
}
function accentMat(accent) {
  const m = new THREE.MeshStandardMaterial({ color: accent, map: ACCENT_TEX, roughness: 0.6, metalness: 0.2, flatShading: true });
  m.userData.accent = true;   // so Camp.setAccent can recolour building bands too (map rides along)
  return m;
}

// Command HQ — the heart of a main base, and the decoy buildings on designed maps.
// The geometry is Jacob's asset-designer creation (js/flaghq.config.js), assembled by
// the generic AssetBuilder; team-flagged parts take the accent and stay setAccent-able.
// (The capturable flag itself is a separate system — Camp/buildFlags — not this mesh.)
export function makeFlagHQ(cell, accent) {
  return mergeByFallBand(buildAssetGroup(FLAGHQ_CFG, accent, { cell }));
}

// Barracks (js/barracks.config.js): twin green fabric quonset huts with dark end
// walls, redesigned in the asset-designer (replaces the old hand-coded box hut).
export function makeBarracks(cell, accent) {
  return mergeByFallBand(buildAssetGroup(BARRACKS_CFG, accent, { cell }));
}

// Supply depot: a cluster of crates.
export function makeDepot(cell) {
  const g = new THREE.Group();
  const spots = [[-0.35, -0.2, 0.5], [0.3, -0.3, 0.45], [0.0, 0.35, 0.55], [0.45, 0.3, 0.4]];
  for (const [x, z, s] of spots) {
    const crate = box(cell * s, cell * s, cell * s, CRATE);
    crate.position.set(x * cell, cell * s * 0.5, z * cell);
    crate.rotation.y = Math.random() * 0.4;
    g.add(crate);
  }
  return g;
}

// Admin block (js/admin.config.js): the former flag-HQ tower, now a plain interior
// structure — concrete stack with team-colour trim banners and a rooftop pennant.
export function makeAdmin(cell, accent) {
  return mergeByFallBand(buildAssetGroup(ADMIN_CFG, accent, { cell }));
}

// Clamshell / quonset hut: a FULL cylinder lying on its side, sunk halfway so
// Quonset hut (js/quonset.config.js): a half-buried ribbed-steel barrel vault with a
// dark end wall, redesigned in the asset-designer (replaces the hand-coded arch).
export function makeQuonset(cell, accent) {
  return mergeByFallBand(buildAssetGroup(QUONSET_CFG, accent, { cell }));
}

// Canvas ridge tent (Return Fire style): a green triangular-prism A-frame.
export function makeTent(cell, accent) {
  return mergeByFallBand(buildAssetGroup(TENT_CFG, accent, { cell }));
}

// Lookout tower (js/lookout.config.js): a raised observation deck on cross-braced
// legs, camo skirt panels in the team colour, spotlight rig on the roof.
export function makeLookout(cell, accent) {
  return mergeByFallBand(buildAssetGroup(LOOKOUT_CFG, accent, { cell }));
}

// Surface elevator: the deck vehicles rise onto, ringed by a yellow/black hazard
// collar. This is the DESIGNER asset — in game the placed elevator is consumed to
// build the functional Elevator.js rig (carved shaft + rising lift). The two share a
// footprint (padHalf 6 deck, collar inner 5.75 / outer 7.6, world units) so what you
// place in the designer matches what appears on the island — the collar included, so
// its stripes visibly meet the gate roads here just as they do in play.
const ELEV_PAD_HALF = 6.0;          // deck half-width (matches Elevator.js)
const ELEV_COLLAR_IN = ELEV_PAD_HALF - 0.25;   // collar hole (tucks over the deck edge)
const ELEV_COLLAR_OUT = 7.6;        // collar outer edge (meets the gate roads)
const ELEV_HAZARD_PERIOD = 2.2;     // world-UV stripe period (matches Elevator._collar)

// The striped collar frame: a flat ring, world-UV'd so the diagonal stripes stay even
// regardless of size. Mirrors Elevator.prototype._collar.
function elevatorCollar() {
  const inner = ELEV_COLLAR_IN, outer = ELEV_COLLAR_OUT;
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
  for (let i = 0; i < pos.count; i++) {
    uv[i * 2] = pos.getX(i) / ELEV_HAZARD_PERIOD;
    uv[i * 2 + 1] = pos.getY(i) / ELEV_HAZARD_PERIOD;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  const mat = new THREE.MeshStandardMaterial({ map: hazardTexture().clone(), roughness: 0.7 });
  mat.map.needsUpdate = true;
  const frame = new THREE.Mesh(geo, mat);
  frame.rotation.x = -Math.PI / 2;
  frame.receiveShadow = true;
  return frame;
}

export function makeElevator(cell, accent) {
  void cell;   // sized in absolute world units to match the functional rig, not cells
  const g = new THREE.Group();
  const half = ELEV_PAD_HALF;
  // Concrete deck.
  const pad = box(half * 2, 0.5, half * 2, STONE);
  pad.position.y = 0.25; g.add(pad);
  // Team-colour border framing the deck on all four edges (mirrors Elevator.js).
  const am = accentMat(accent);
  const bw = 0.7;
  const inset = half - bw / 2 - 0.15;
  const len = half * 2 - 0.3;
  for (const s of [-1, 1]) {
    const front = box(len, 0.12, bw, am);
    front.position.set(0, 0.56, s * inset); g.add(front);
    const side = box(bw, 0.12, len, am);
    side.position.set(s * inset, 0.56, 0); g.add(side);
  }
  // Yellow/black hazard collar ringing the deck, just above the surface.
  const collar = elevatorCollar();
  collar.position.y = 0.55; g.add(collar);
  return g;
}
