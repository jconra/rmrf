// assets.manifest.js — the shared asset INDEX for RMRF.
//
// This is the single source of truth that both the GAME and the standalone
// asset/map designers read. It does NOT store geometry — each asset is still a
// procedural maker function (in Buildings.js / Resupply.js etc.). The manifest
// is an index over those makers plus the metadata everything downstream needs:
//   - footprint : grid cells the asset occupies (for snap, overlap checks, and
//                 feeding the foliage `avoid` test so trees skip built cells).
//                 Verified against the asset-designer's measured bounding box.
//   - destructible : { type, hp } the game wraps each placed asset in
//   - accent : does the maker take a team-colour accent argument?
//   - category : 'structure' (free-placeable building)
//              | 'supply'    (neutral resupply POI — fuel/ammo/shield)
//              | 'special'   (functional, placed by base logic — shown in the
//                             designer but handled specially)
//   - desc : one-line player-facing blurb (drives the in-game help page +
//            the designer/map palette tooltips)
//
// Dependency direction is ONE WAY: the designers import this; the shipped game
// imports this; the manifest never imports anything from the designer tools.

import {
  makeFlagHQ, makeBarracks, makeDepot, makeAdmin,
  makeQuonset, makeTent, makeElevator, makeLookout,
} from './Buildings.js?v=9';
import { makeFuelTank, makeAmmoDepot, makeShieldGenerator } from './Resupply.js';   // no ?v: match main.js so the module dedupes
import { makeWall, makeTower, makeGate } from './Walls.js?v=65';   // perimeter kit (visual makers; Wall/Camp classes do the combat)
import { makeSubmarine } from './Submarine.js?v=4';   // deep-water hazard sub (code-built mesh; ?v matches main.js so the module dedupes)
import CORNER_TOWER_CFG from './corner_tower.config.js?v=1';   // the designed corner tower, as shared data (designer + game read this one file)
import LOOKOUT_CFG from './lookout.config.js?v=1';   // the designed lookout tower, same shared-data pattern
import FLAGHQ_CFG from './flaghq.config.js?v=2';     // config refs let the asset-designer OPEN these for editing
import ADMIN_CFG from './admin.config.js?v=1';       // former flag-HQ tower, now a decorative structure
import TENT_CFG from './tent.config.js?v=2';
import BARRACKS_CFG from './barracks.config.js?v=2';
import QUONSET_CFG from './quonset.config.js?v=2';
// Base-flavour prop set (shipping containers, water tower, motor pool, range, defences…):
// each is a designer-format config built by the generic AssetBuilder — no bespoke maker code.
import { buildAssetGroup } from './AssetBuilder.js?v=1';
import CONTAINERS_CFG from './containers.config.js?v=2';
import WATERTOWER_CFG from './watertower.config.js?v=1';
import JEEP_CFG from './jeep.config.js?v=1';
import RANGE_CFG from './range.config.js?v=2';
import GENERATOR_CFG from './generator.config.js?v=1';
import HEDGEHOGS_CFG from './hedgehogs.config.js?v=3';
import DRUMS_CFG from './drums.config.js?v=1';
import SANDBAGS_CFG from './sandbags.config.js?v=1';
import CHECKPOINT_CFG from './checkpoint.config.js?v=1';
import BASTION_CFG from './bastion.config.js?v=1';
const cfgMake = (CFG) => (cell, accent) => buildAssetGroup(CFG, accent, { cell });
export const PROP_CONFIGS = { containers: CONTAINERS_CFG, watertower: WATERTOWER_CFG, jeep: JEEP_CFG, range: RANGE_CFG, generator: GENERATOR_CFG, hedgehogs: HEDGEHOGS_CFG, drums: DRUMS_CFG, sandbags: SANDBAGS_CFG, checkpoint: CHECKPOINT_CFG };

export const ASSETS = [
  // ── Structures ─────────────────────────────────────────────────────────────
  {
    id: 'flagHQ', name: 'Flag HQ', make: makeFlagHQ, config: FLAGHQ_CFG,
    footprint: { w: 2, d: 2 }, accent: true,
    destructible: { type: 'building', hp: 600 },
    category: 'special',   // the capturable flag hides inside until it falls
    desc: 'Command HQ flying the team flag. Destroy it to expose the capturable flag inside.',
  },
  {
    id: 'admin', name: 'Admin Block', make: makeAdmin, config: ADMIN_CFG,
    footprint: { w: 2, d: 2 }, accent: true,
    destructible: { type: 'building', hp: 160 },
    category: 'structure',
    desc: 'A tall command tower with team banners — decorative interior structure.',
  },
  {
    id: 'quonset', name: 'Quonset Hut', make: makeQuonset, config: QUONSET_CFG,
    footprint: { w: 1, d: 2 }, accent: true,
    destructible: { type: 'building', hp: 140 },
    category: 'structure',
    desc: 'A curved-roof storage shed.',
  },
  {
    id: 'barracks', name: 'Barracks', make: makeBarracks, config: BARRACKS_CFG,
    footprint: { w: 1, d: 1 }, accent: true,
    destructible: { type: 'building', hp: 120 },
    category: 'structure',
    desc: 'Troop housing with a team-colour door.',
  },
  {
    id: 'depot', name: 'Supply Depot', make: makeDepot,
    footprint: { w: 2, d: 2 }, accent: false,   // makeDepot(cell) takes no accent; 2x2 measured in asset-designer
    destructible: { type: 'building', hp: 80 },
    category: 'structure',
    desc: 'A cluster of stacked crates.',
  },
  {
    id: 'tent', name: 'Ridge Tent', make: makeTent, config: TENT_CFG,
    footprint: { w: 1, d: 1 }, accent: true,
    destructible: { type: 'building', hp: 50 },
    category: 'structure',
    desc: 'A canvas A-frame shelter.',
  },
  {
    id: 'lookout', name: 'Lookout Tower', make: makeLookout, config: LOOKOUT_CFG,
    footprint: { w: 1, d: 1 }, accent: true,
    destructible: { type: 'building', hp: 200 },
    category: 'structure',
    desc: 'A raised observation deck on braced legs, skirted in team camo.',
  },
  {
    id: 'elevator', name: 'Surface Elevator', make: makeElevator,
    footprint: { w: 2, d: 2 }, accent: true,
    destructible: null,    // functional rig, not shot to rubble
    category: 'special',
    desc: 'Vehicles rise onto the island here from the garage below.',
  },

  // ── Perimeter kit (the Camp class auto-rings a base with these) ──────────────
  {
    id: 'wall', name: 'Wall', make: makeWall,
    footprint: { w: 1, d: 1 }, accent: true,
    destructible: { type: 'wall', hp: 200 },
    category: 'structure',
    desc: 'A stone perimeter wall segment; the top course wears the team colour.',
  },
  {
    id: 'tower', name: 'Corner Tower', make: makeTower, config: CORNER_TOWER_CFG,
    footprint: { w: 1, d: 1 }, accent: true,
    destructible: { type: 'wall', hp: 340 },
    category: 'structure',
    desc: 'A corner bastion that mounts an auto-turret (guns live only on corners).',
  },
  {
    id: 'gate', name: 'Gate', make: makeGate,
    footprint: { w: 3, d: 1 }, accent: true,   // 3-wide: a 1-cell road threads its centre (matches the in-game wall gate)
    destructible: { type: 'wall', hp: 300 },
    category: 'structure',
    desc: 'A drive-through gateway: two posts under a team-colour lintel.',
  },

  // ── Base-flavour props (designer-config assets; the map palette + base dressing) ──
  { id: 'containers', name: 'Container Stack', make: cfgMake(CONTAINERS_CFG), config: CONTAINERS_CFG,
    footprint: { w: 2, d: 1 }, accent: true, destructible: { type: 'building', hp: 90 },
    category: 'structure', desc: 'Stacked shipping containers; the top one wears a team-colour door.' },
  { id: 'watertower', name: 'Water Tower', make: cfgMake(WATERTOWER_CFG), config: WATERTOWER_CFG,
    footprint: { w: 1, d: 1 }, accent: true, destructible: { type: 'building', hp: 150 },
    category: 'structure', desc: 'A tall four-leg water tower with a team-colour tank band — a landmark.' },
  { id: 'jeep', name: 'Utility Jeep', make: cfgMake(JEEP_CFG), config: JEEP_CFG,
    footprint: { w: 1, d: 1 }, accent: false, destructible: { type: 'building', hp: 40 },
    category: 'structure', desc: 'A parked olive jeep. Decorative, and not built to take a shell.' },
  { id: 'range', name: 'Firing Range', make: cfgMake(RANGE_CFG), config: RANGE_CFG,
    footprint: { w: 2, d: 1 }, accent: false, destructible: { type: 'building', hp: 30 },
    category: 'structure', desc: 'Sandbag firing line and three silhouette targets downrange.' },
  { id: 'generator', name: 'Power Generator', make: cfgMake(GENERATOR_CFG), config: GENERATOR_CFG,
    footprint: { w: 1, d: 1 }, accent: true, destructible: { type: 'building', hp: 60 },
    category: 'structure', desc: 'A skid-mounted diesel genset with an exhaust stack and fuel tank.' },
  { id: 'hedgehogs', name: 'Czech Hedgehogs', make: cfgMake(HEDGEHOGS_CFG), config: HEDGEHOGS_CFG,
    footprint: { w: 1, d: 1 }, accent: false, destructible: { type: 'wall', hp: 80 },
    category: 'structure', desc: 'Crossed-beam anti-tank obstacles. Slow to chew through; blocks a lane.' },
  { id: 'drums', name: 'Fuel Drums', make: cfgMake(DRUMS_CFG), config: DRUMS_CFG,
    footprint: { w: 1, d: 1 }, accent: false, destructible: { type: 'building', hp: 30 },
    category: 'structure', desc: 'A cluster of fuel drums — one tipped, one stacked, one hazard-striped.' },
  { id: 'sandbags', name: 'Sandbag Nest', make: cfgMake(SANDBAGS_CFG), config: SANDBAGS_CFG,
    footprint: { w: 1, d: 1 }, accent: false, destructible: { type: 'wall', hp: 60 },
    category: 'structure', desc: 'An L-shaped two-course sandbag position.' },
  { id: 'checkpoint', name: 'Checkpoint', make: cfgMake(CHECKPOINT_CFG), config: CHECKPOINT_CFG,
    footprint: { w: 1, d: 1 }, accent: true, destructible: { type: 'building', hp: 50 },
    category: 'structure', desc: 'A guard booth with a hazard barrier arm (it snaps off first).' },

  { id: 'bastion', name: 'Bastion (No Gun)', make: cfgMake(BASTION_CFG), config: BASTION_CFG,
    footprint: { w: 1, d: 1 }, accent: true, destructible: { type: 'wall', hp: 340 },
    category: 'structure', desc: 'The corner tower without its gun — hard cover for easier maps.' },

  // Code-built (no config): the deep-water hazard sub. Spawned by the game on demand, not
  // grid-placed — this entry is so the asset designer can view/measure the model. make() ignores
  // the (cell, accent) args; the sub owns its own dark palette + red sensor eye (team-neutral).
  { id: 'submarine', name: 'Hazard Submarine', make: makeSubmarine,
    footprint: { w: 1, d: 4 }, accent: false,
    category: 'special', desc: 'Deep-water deterrent: surfaces to shell anyone who strays too far to sea.' },

  // ── Supply POIs (neutral; either team can use them, or blow one to deny it) ──
  {
    id: 'fuel', name: 'Fuel Tank', make: makeFuelTank,
    footprint: { w: 2, d: 1 }, accent: false,   // 2x1 measured (tank lies lengthwise)
    destructible: { type: 'building', hp: 60 },
    category: 'supply',
    desc: 'Drive near it to refill fuel.',
  },
  {
    id: 'ammo', name: 'Ammo Depot', make: makeAmmoDepot,
    footprint: { w: 1, d: 1 }, accent: false,
    destructible: { type: 'building', hp: 60 },
    category: 'supply',
    desc: 'Drive near it to rearm.',
  },
  {
    id: 'shield', name: 'Shield Generator', make: makeShieldGenerator,
    footprint: { w: 2, d: 2 }, accent: false,   // 2x2 measured (emitter ~5.5u spills past one cell)
    destructible: { type: 'building', hp: 60 },
    category: 'supply',
    desc: 'Drive near it to pick up a shield that absorbs damage before your hull.',
  },
];

// Convenience lookups (both designers and the game key off these).
export const ASSETS_BY_ID = Object.fromEntries(ASSETS.map(a => [a.id, a]));
export const SUPPLY_ASSETS = ASSETS.filter(a => a.category === 'supply');
