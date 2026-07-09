// Buildings.js — procedural low-poly interior structures placed inside camps.
// Flag/HQ + barracks + depot for a MAIN base; an elevator for a FORWARD base.
// Each maker returns a THREE.Group with its base at y=0. Team accent passed in.

import * as THREE from 'three';
import { concreteTexture, ribbedMetalTexture, fabricTexture, crateTexture, roofTexture, accentPlateTexture } from './Textures.js?v=2';
import { buildAssetGroup } from './AssetBuilder.js?v=1';
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
  return buildAssetGroup(FLAGHQ_CFG, accent, { cell });
}

// Barracks (js/barracks.config.js): twin green fabric quonset huts with dark end
// walls, redesigned in the asset-designer (replaces the old hand-coded box hut).
export function makeBarracks(cell, accent) {
  return buildAssetGroup(BARRACKS_CFG, accent, { cell });
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
  return buildAssetGroup(ADMIN_CFG, accent, { cell });
}

// Clamshell / quonset hut: a FULL cylinder lying on its side, sunk halfway so
// Quonset hut (js/quonset.config.js): a half-buried ribbed-steel barrel vault with a
// dark end wall, redesigned in the asset-designer (replaces the hand-coded arch).
export function makeQuonset(cell, accent) {
  return buildAssetGroup(QUONSET_CFG, accent, { cell });
}

// Canvas ridge tent (Return Fire style): a green triangular-prism A-frame.
export function makeTent(cell, accent) {
  return buildAssetGroup(TENT_CFG, accent, { cell });
}

// Lookout tower (js/lookout.config.js): a raised observation deck on cross-braced
// legs, camo skirt panels in the team colour, spotlight rig on the roof.
export function makeLookout(cell, accent) {
  return buildAssetGroup(LOOKOUT_CFG, accent, { cell });
}

// Surface elevator: a framed platform that vehicles rise onto (the underground
// garage rise animation hooks in later). Recessed dark lift pad + corner posts.
// Flat elevator pad (posts intentionally dropped): a stone apron with a recessed dark
// lift pad and accent edge stripes. The rise animation hooks in with the garage.
export function makeElevator(cell, accent) {
  const g = new THREE.Group();
  const am = accentMat(accent);
  const apron = box(cell * 1.35, cell * 0.18, cell * 1.35, STONE);
  apron.position.y = cell * 0.09; g.add(apron);
  const pad = box(cell * 0.95, cell * 0.12, cell * 0.95, LIFT);
  pad.position.y = cell * 0.2; g.add(pad);
  for (const sx of [-1, 1]) {
    const stripe = box(cell * 0.1, cell * 0.13, cell * 0.95, am);
    stripe.position.set(sx * cell * 0.48, cell * 0.2, 0); g.add(stripe);
  }
  return g;
}
