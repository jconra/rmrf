// Ammo supply depot — baked from Jacob's asset-designer export (ammo_supply.json).
// The repeated shells (2 cylinders each) and crate boxes are factored into helpers
// so the file is a readable list of positions, not 24 raw transforms.
const METAL = { color: '#3b3f44', mapKind: 'metal' };
const GREEN = { color: '#3aa848', mapKind: 'fabric' };
const DARKF = { color: '#3b3f44', mapKind: 'fabric' };

// A standing shell: tapered body + pointed cone tip 1.4 above it.
const shell = (x, y, z) => [
  { kind: 'cylinder', pos: [x, y, z], params: { rt: 0.2, rb: 0.2, h: 2, seg: 6 }, mat: METAL },
  { kind: 'cylinder', pos: [x, y + 1.4, z], params: { rt: 0, rb: 0.2, h: 0.8, seg: 6 }, mat: METAL },
];
// A shell lying on its side (axis along -x): body + cone tip (nose toward -x), plus a
// 4-fin tail cross at the +x end, matching the Valkyrie's underslung missiles.
const FR = 0.28, FW = 0.16, FT = 0.035, FAX = 0.45, FX = 0.5;   // fin radial/width/thickness/length/tail-offset
const shellLying = (x, y, z) => [
  { kind: 'cylinder', pos: [x, y, z], rot: [0, 0, 1.571], params: { rt: 0.2, rb: 0.2, h: 1.5, seg: 6 }, mat: METAL },
  { kind: 'cylinder', pos: [x - 1.1, y, z], rot: [0, 0, 1.571], params: { rt: 0, rb: 0.2, h: 0.8, seg: 6 }, mat: METAL },
  { kind: 'box', pos: [x + FX, y + FR, z], params: { w: FAX, h: FW, d: FT }, mat: METAL },
  { kind: 'box', pos: [x + FX, y - FR, z], params: { w: FAX, h: FW, d: FT }, mat: METAL },
  { kind: 'box', pos: [x + FX, y, z + FR], params: { w: FAX, h: FT, d: FW }, mat: METAL },
  { kind: 'box', pos: [x + FX, y, z - FR], params: { w: FAX, h: FT, d: FW }, mat: METAL },
];
// A green ammo case and a dark crate cube.
const gcase = (x, y, z) => ({ kind: 'box', pos: [x, y, z], params: { w: 1.5, h: 0.3, d: 0.5 }, mat: GREEN });
const dcube = (x, y, z) => ({ kind: 'box', pos: [x, y, z], scale: [0.316, 0.316, 0.316], params: { w: 2, h: 2, d: 2 }, mat: DARKF });

export default { parts: [
  // ── base pads + wood pallets/crate (explicit) ──
  { kind: 'plane', rot: [1.571], params: { w: 7, h: 7 }, mat: { color: '#ffffff', mapKind: 'hazard', tile: [4, 4] } },
  { kind: 'plane', pos: [0.04, 0.2], rot: [1.571], params: { w: 6, h: 6 }, mat: { color: '#3b3f44', mapKind: 'concrete', tile: [4, 4] } },
  { kind: 'box', pos: [-2.338, 0.287, -1.47], scale: [0.2, 0.05], params: { w: 2, h: 2, d: 2 }, mat: { color: '#ffffff', mapKind: 'wood', tile: [0.1, 0.1] } },
  { kind: 'box', pos: [-0.692, 0.287, -1.47], scale: [0.2, 0.05], params: { w: 2, h: 2, d: 2 }, mat: { color: '#ffffff', mapKind: 'wood', tile: [0.1, 0.1] } },
  { kind: 'box', pos: [0.795, 0.287, 1.726], scale: [0.2, 0.05], params: { w: 2, h: 2, d: 2 }, mat: { color: '#ffffff', mapKind: 'wood', tile: [0.1, 0.1] } },
  { kind: 'box', pos: [2.393, 0.287, 1.726], scale: [0.2, 0.05], params: { w: 2, h: 2, d: 2 }, mat: { color: '#ffffff', mapKind: 'wood', tile: [0.1, 0.1] } },
  { kind: 'box', pos: [1.77, 0.287, -2.231], rot: [0, 1.571], scale: [0.2, 0.05], params: { w: 2, h: 2, d: 2 }, mat: { color: '#ffffff', mapKind: 'wood', tile: [0.1, 0.1] } },
  { kind: 'box', pos: [1.77, 0.287, -0.565], rot: [0, 1.571], scale: [0.2, 0.05], params: { w: 2, h: 2, d: 2 }, mat: { color: '#ffffff', mapKind: 'wood', tile: [0.1, 0.1] } },
  { kind: 'box', pos: [-1.183, 0.287, 0.635], rot: [0, 1.571], scale: [0.2, 0.05], params: { w: 2, h: 2, d: 2 }, mat: { color: '#ffffff', mapKind: 'wood', tile: [0.1, 0.1] } },
  { kind: 'box', pos: [-1.183, 0.287, 2.324], rot: [0, 1.571], scale: [0.2, 0.05], params: { w: 2, h: 2, d: 2 }, mat: { color: '#ffffff', mapKind: 'wood', tile: [0.1, 0.1] } },
  { kind: 'box', pos: [1.915, 0.528, -1.47], scale: [0.746, 0.05], params: { w: 2, h: 2, d: 2 }, mat: { color: '#ffffff', mapKind: 'wood', tile: [0.3, 0.1] } },
  { kind: 'box', pos: [1.127, 1.325, -1.47], rot: [0, 0, 1.571], scale: [0.746, 0.05], params: { w: 2, h: 2, d: 2 }, mat: { color: '#ffffff', mapKind: 'wood', tile: [0.3, 0.1] } },
  { kind: 'box', pos: [2.593, 1.325, -1.47], rot: [0, 0, 1.571], scale: [0.746, 0.05], params: { w: 2, h: 2, d: 2 }, mat: { color: '#ffffff', mapKind: 'wood', tile: [0.3, 0.1] } },
  { kind: 'box', pos: [1.921, 1.331, -0.474], rot: [1.571], scale: [0.721, 0.052, 0.804], params: { w: 2, h: 2, d: 2 }, mat: { color: '#ffffff', mapKind: 'wood', tile: [0.3, 0.1] } },
  { kind: 'box', pos: [1.921, 1.331, -2.456], rot: [1.571], scale: [0.721, 0.052, 0.804], params: { w: 2, h: 2, d: 2 }, mat: { color: '#ffffff', mapKind: 'wood', tile: [0.3, 0.1] } },
  { kind: 'box', pos: [-1.159, 0.528, 1.391], scale: [0.746, 0.05], params: { w: 2, h: 2, d: 2 }, mat: { color: '#ffffff', mapKind: 'wood', tile: [0.3, 0.1] } },
  { kind: 'box', pos: [1.342, 0.697, 1.866], scale: [0.2, 0.05], params: { w: 2, h: 2, d: 2 }, mat: { color: '#ffffff', mapKind: 'wood', tile: [0.1, 0.1] } },
  { kind: 'box', pos: [1.993, 0.697, 1.866], scale: [0.2, 0.05], params: { w: 2, h: 2, d: 2 }, mat: { color: '#ffffff', mapKind: 'wood', tile: [0.1, 0.1] } },
  { kind: 'box', pos: [-0.875, 1.029, 1.591], scale: [0.2, 0.05], params: { w: 2, h: 2, d: 2 }, mat: { color: '#ffffff', mapKind: 'wood', tile: [0.1, 0.1] } },
  { kind: 'box', pos: [-1.526, 1.029, 1.591], scale: [0.2, 0.05], params: { w: 2, h: 2, d: 2 }, mat: { color: '#ffffff', mapKind: 'wood', tile: [0.1, 0.1] } },
  { kind: 'box', pos: [1.342, 1.19, 1.866], scale: [0.2, 0.05], params: { w: 2, h: 2, d: 2 }, mat: { color: '#ffffff', mapKind: 'wood', tile: [0.1, 0.1] } },
  { kind: 'box', pos: [1.993, 1.19, 1.866], scale: [0.2, 0.05], params: { w: 2, h: 2, d: 2 }, mat: { color: '#ffffff', mapKind: 'wood', tile: [0.1, 0.1] } },
  { kind: 'box', pos: [-1.308, 0.316, -1.47], rot: [0, 1.571], scale: [0.746, 0.05], params: { w: 2, h: 2, d: 2 }, mat: { color: '#ffffff', mapKind: 'wood', tile: [0.3, 0.1] } },
  { kind: 'box', pos: [-1.377, 1.048, -1.47], scale: [0.437, 0.05], params: { w: 2, h: 2, d: 2 }, mat: { color: '#ffffff', mapKind: 'wood', tile: [0.2, 0.1] } },
  // ── standing shells ──
  ...shell(1.52, 1.42, -0.978),
  ...shell(1.56, 1.42, -1.568),
  ...shell(1.52, 1.42, -2.158),
  ...shell(2.082, 1.42, -2.158),
  ...shell(2.082, 1.42, -1.526),
  ...shell(2.082, 1.42, -0.94),
  // ── lying shells ──
  ...shellLying(-1.172, 0.781, 2.2),
  ...shellLying(-1.172, 0.781, 1.605),
  ...shellLying(-1.172, 0.781, 1.011),
  ...shellLying(-1.252, 1.301, 1.373),
  ...shellLying(-1.172, 1.301, 1.851),
  ...shellLying(-1.252, 1.301, 0.812),
  // ── green ammo cases ──
  gcase(1.673, 0.502, 1.089),
  gcase(1.673, 0.502, 1.811),
  gcase(1.673, 0.502, 2.492),
  gcase(1.673, 0.987, 1.228),
  gcase(1.673, 0.987, 1.951),
  gcase(1.673, 0.987, 2.631),
  gcase(1.673, 1.455, 0.952),
  gcase(1.673, 1.455, 1.674),
  gcase(1.673, 1.455, 2.355),
  // ── dark crates ──
  dcube(-0.855, 0.701, -1.009),
  dcube(-0.855, 0.701, -1.791),
  dcube(-1.92, 0.701, -1.791),
  dcube(-1.92, 0.701, -0.951),
  dcube(-1.365, 1.424, -0.951),
  dcube(-1.365, 1.424, -1.824),
] };
