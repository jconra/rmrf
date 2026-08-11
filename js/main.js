// main.js — RMRF bootstrap (fresh build).
// Bright Return Fire look: light sky, warm sun, tone mapping. Procedural islands
// with a live controls panel. Garage + vehicles land in later milestones.

import * as THREE from 'three';
import { IslandMap, DEFAULTS } from './IslandMap.js?v=75';
// Same specifier IslandMap uses — a different one would load a second copy of the module and
// RR.setSurf would then be tuning a material nobody is rendering.
import { SURF, setSurf } from './TerrainMaterial.js?v=21';   // shoreline surf tunables (lab/surf.html)
import { Controls } from './Controls.js';
import { DestructibleManager, Destructible } from './Destructible.js?v=7';
import { applyStaging } from './AssetStaging.js?v=1';
import { BuildGrid } from './BuildGrid.js';
import { Camp, Wall, resetWallInstances, wallInstancesGroup } from './Walls.js?v=68';
import { SoldierCorps } from './Soldiers.js?v=4';
import { RepairJob, makeJeepMesh } from './RepairCrew.js?v=8';
import { Minefield, SensorNet, MINE, POD } from './Gadgets.js?v=4';
import { makeFlagHQ } from './Buildings.js?v=9';   // decoy HQ buildings on designed maps
import { recolorCamo } from './AssetBuilder.js?v=1';   // re-skin designed-map props' baked camo on the colour-lock
import { CAMPAIGN, isUnlocked, isCompleted, markCompleted } from './campaign.js?v=1';
import { RoadNetwork } from './Roads.js?v=85';
import { Foliage } from './Foliage.js?v=5';
import { setWindTime } from './Plants.js?v=1';   // same specifier as Foliage's import → shared wind clock
import { makeVehicleShadow, vehicleSilhouette, makeBlobShadow } from './BlobShadow.js?v=1';
import { Vehicle, VEHICLE_TYPES } from './Vehicles.js?v=69';
import { Elevator } from './Elevator.js?v=3';
import { Sub } from './Submarine.js?v=5';
import { Garage, GARAGE_COUNTS } from './Garage.js?v=8';
import { TEAM_COLORS, updateCamo, camoParams } from './CamoTexture.js';
import { SoundManager } from './SoundManager.js?v=12';
import { Projectiles } from './Projectiles.js';
import { Brain, randomPersonality, recStart, recStop, recDump, setBrainConfig, getBrainConfig, setJoust, setAlign, FOF_DEFAULT } from './AI.js?v=109';
import { locomote } from './Locomotion.js?v=1';
import { Driver } from './Driver.js?v=1';

// Per-team fight-or-flight weight sets (Phase 2 auto-tuning / A/B self-play). Lazily cloned
// from FOF_DEFAULT; RR.setFof(team, {...}) overrides individual weights live, so red and blue
// can run DIFFERENT weights in the same match to see which set actually wins.
const teamFof = {};
function fofFor(team) { return teamFof[team] || (teamFof[team] = { ...FOF_DEFAULT }); }
import { initFire, fireBurst, fireWreck, tickFire, drawFire, fireStatus } from './Fire.js?v=2';
import { setSupplyW, makeDoctrine, missionWants, pickArchetype, assignArchetypes, COUNTER, setRunnerMode, setRogueRearSiege, setHqFinisher, setRearSneakGate, setTurtleGuard, setHunterHarass, setCapRoutes, setSaveRunner as setSaveRunnerScore, setReqVehicle, requiredVehicle, setFightMission, setFleeScore, setMsnKeyFix, setTrigFix, setScoreClock, setDeepLog as setDeepLogStrategies } from './AIStrategies.js?v=97';
import { ExploreMemory, setSweepMode } from './ExploreMemory.js?v=58';
import { astarGrid } from './astar.js?v=6';
import { AstarViz } from './AstarViz.js?v=4';
import { makeFuelTank, makeAmmoDepot, makeShieldGenerator, makeShieldBubble, RESUPPLY_TINT } from './Resupply.js';
import { makeShieldMaterial, pushShieldHit, stepShield } from './ShieldShader.js?v=4';
import { makePartsPallet, makeWreckage } from './Scrap.js?v=3';
import { SUPPLY_ASSETS, ASSETS_BY_ID } from './assets.manifest.js?v=8';

// --- Renderer ----------------------------------------------------------
// powerPreference: on a hybrid-graphics laptop (Optimus: integrated Intel + discrete NVIDIA)
// the browser defaults to the LOW-POWER GPU, so the game renders on the iGPU while the discrete
// card idles — fill-rate bound at ~40fps with trivial draw counts. This asks for the fast one.
// It is a HINT: the OS/browser per-app graphics preference can still override it.
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
// Skip the post-link getProgramInfoLog/getShaderInfoLog check — that call synchronously stalls
// until each shader finishes compiling (a big chunk of the shader-compile jank). Shaders are
// stable in this build; re-enable with ?shaderdebug if you're debugging a broken material.
renderer.debug.checkShaderErrors = new URLSearchParams(location.search).has('shaderdebug');
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.outputColorSpace = THREE.SRGBColorSpace;
// Shadows: enabled globally but only lights/meshes that opt in cast them. Right
// now that's just the garage selection spotlight (the field sun doesn't cast yet).
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

// --- Scene + sky -------------------------------------------------------
const scene = new THREE.Scene();
const SKY = new THREE.Color('#bfe4f5');     // bright daytime sky
scene.background = SKY;
scene.fog = new THREE.Fog(SKY, 220, 460);   // soft horizon haze

// Environment map = what shiny/metal surfaces REFLECT. A directional light gives a
// specular highlight, but a true reflection needs something to sample — without an
// env map, metals reflect nothing and render dark. We build a small procedural sky
// (gradient + warm sun disc), PMREM-filter it, and hang it on the scene so every
// MeshStandardMaterial picks it up: the metallic vehicles brighten and gain a moving
// sky sheen, and glossy water reflects the sky + sun.
function makeSkyEnv() {
  const W = 512, H = 256;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0.00, '#4f93c8');   // zenith (deeper blue)
  g.addColorStop(0.45, '#bfe4f5');   // sky
  g.addColorStop(0.50, '#eaf5fb');   // horizon glow
  g.addColorStop(0.56, '#cdd9d0');   // just below horizon
  g.addColorStop(1.00, '#8fa39a');   // ground/sea bounce
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  const sx = W * 0.62, sy = H * 0.30, sr = H * 0.18;   // warm sun disc up in the sky
  const rg = ctx.createRadialGradient(sx, sy, 0, sx, sy, sr);
  rg.addColorStop(0.0, 'rgba(255,251,238,1)');
  rg.addColorStop(0.3, 'rgba(255,244,214,0.85)');
  rg.addColorStop(1.0, 'rgba(255,244,214,0)');
  ctx.fillStyle = rg; ctx.fillRect(0, 0, W, H);
  const tex = new THREE.CanvasTexture(cv);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
const _pmrem = new THREE.PMREMGenerator(renderer);
const _skySrc = makeSkyEnv();
scene.environment = _pmrem.fromEquirectangular(_skySrc).texture;
_skySrc.dispose(); _pmrem.dispose();

// Warm key sun + cool sky-ground ambient = sunny beach. A mid-low sun angle
// (~40° up, afternoon) so light rakes across the vehicles' sides and catches
// highlights — a high midday sun just lit their tops and left the flanks dark.
const sun = new THREE.DirectionalLight('#fff3d6', 2.1);
sun.position.set(0, 202, -25);   // hand-picked specular angle (overridden per-map by scaleScene)
scene.add(sun);
const hemi = new THREE.HemisphereLight('#dff1ff', '#c2a86a', 0.95);
scene.add(hemi);

// --- Camera + minimal orbit control -----------------------------------
const BASE_FOV = 55;   // landscape vertical fov
// near=3 (not 0.5): the orbit cam never gets closer than ~8u to the action, so a tiny
// near plane just threw away depth-buffer precision (far/near went from 2500 to ~415),
// which is what made the terrain/waterline z-fight so badly when zoomed out.
const camera = new THREE.PerspectiveCamera(BASE_FOV, window.innerWidth / window.innerHeight, 3, 1200);
// Build the fire pool once, here, where the scene and camera both exist. Eight instances, reused
// for the whole match — see Fire.js for why the pool is the budget.
initFire(scene, camera);

// Perspective fov is VERTICAL, so a tall portrait window (a phone) collapses the
// horizontal view and feels zoomed in. In portrait, widen the vertical fov so the
// HORIZONTAL coverage holds at roughly its square-aspect amount; landscape keeps
// BASE_FOV. Clamped so very tall screens don't go fisheye.
function applyCameraFov() {
  const a = window.innerWidth / window.innerHeight;
  if (a >= 1) {
    camera.fov = BASE_FOV;
  } else {
    const baseTan = Math.tan(THREE.MathUtils.degToRad(BASE_FOV) / 2);   // horizontal target (at a=1)
    const fov = THREE.MathUtils.radToDeg(2 * Math.atan(baseTan / a));
    camera.fov = Math.min(82, fov);
  }
  camera.aspect = a;
  camera.updateProjectionMatrix();
}
applyCameraFov();
// yaw 0 = looking straight down the Z axis (North), squared to the grid.
const orbit = { target: new THREE.Vector3(0, 0, 0), dist: 150, yaw: 0, pitch: 1.2 };
let zoomMax = 420;
// Single-finger virtual joystick: pan toward the finger's offset from screen centre.
const touchPan = { active: false, x: 0, y: 0, sx: 0, sy: 0, t: 0 };
// Touch driving: hold a finger on the field and the vehicle heads toward that point
// (point-to-steer, set in the canvas touch handlers, consumed by driveInput). A quick
// tap fires instead of steering. null = no finger steering this frame.
let touchSteer = null;            // { x, y } screen point the vehicle should drive toward
// A second finger HELD to one side (while the first steers) slides the hull straight
// sideways toward it, aim unchanged — { id, x, y, t(down-time) }. A quick second tap
// still fires; only a held finger strafes (see the dwell gate in driveInput).
let touchStrafe = null;
const TOUCH_STOP_R = 7;           // world radius around the vehicle that reads as "stop"
// Touch NAV stick (right thumb): "go in this direction" — the knob's offset is a
// camera-relative compass heading; the vehicle drives that world direction (tank types
// turn to face it, the omni Lurcher slides there). { nx, ny, mag } in stick space.
let touchNav = null;
// Touch AIM stick (left thumb): tilt sets the desired turret offset from the hull
// forward (clamped to the vehicle's arc), push to the rim FIRES. { nx, ny, mag } in
// stick space (nx right, ny down, mag 0..>1). touchAiming = a finger is on it now.
let touchAim = null;
let touchAiming = false;
const RIM_FIRE = 0.92;            // knob pushed this far toward the edge = pull the trigger
const ASSIST_CONE = 0.30;         // rad; an enemy within this of where you point gets auto-aimed
const ASSIST_RANGE = 150;         // u; aim-assist only reaches this far

function updateCamera() {
  const cp = Math.max(0.15, Math.min(1.45, orbit.pitch));
  orbit.pitch = cp;
  const x = orbit.target.x + orbit.dist * Math.cos(cp) * Math.sin(orbit.yaw);
  const y = orbit.target.y + orbit.dist * Math.sin(cp);
  const z = orbit.target.z + orbit.dist * Math.cos(cp) * Math.cos(orbit.yaw);
  camera.position.set(x, y, z);
  camera.lookAt(orbit.target);
}

(function bindOrbit() {
  // LEFT mouse = fire (hold to keep firing at the crosshair); RIGHT mouse drag =
  // orbit/look. (No SPACE-to-fire; touch fires on tap — see the touch handlers.)
  let dragging = false, lx = 0, ly = 0;
  const el = renderer.domElement;
  const move = (x, y) => {
    if (!dragging) return;
    orbit.yaw -= (x - lx) * 0.005;
    orbit.pitch -= (y - ly) * 0.005;
    lx = x; ly = y;
    updateCamera();
  };
  // FOG-OF-WAR camera lock: in a HUMAN (PvAI) game the field camera is FIXED at the deploy
  // angle — no orbit, no zoom, no pan. Free look would let the player drop the camera low and
  // scout the far side of the map for free, which defeats the recon layer (sensor pods, sound
  // HUD, sight ranges). Spectator games (AI-vs-AI) keep full camera control.
  const camLocked = () => onField && TEAM_CTRL[PLAYER_TEAM] === 'human';
  el.addEventListener('mousedown', e => {
    if (e.button === 2 || e.button === 1) { if (camLocked()) return; dragging = true; lx = e.clientX; ly = e.clientY; return; }   // right/middle = look (spectator only)
    if (e.button !== 0) return;
    if (onField && player && !player.dead) {            // LEFT = fire
      if (playerIsValkyrie()) acquireLock(e.clientX, e.clientY);   // lock the box; held missiles home onto it
      fireHeld = true;
    } else if (QS.has('tap')) damageTapAt(e.clientX, e.clientY);   // legacy debug damage tap
  });
  // pointermove with a pointerType gate, NOT mousemove: on phones the browser synthesizes
  // compatibility mouse events from taps (the field canvas listeners are passive), which set
  // _cursor to the tap point — then releasing the aim stick fell into the desktop-cursor aim
  // path and swung the turret to that stale spot instead of holding its bearing.
  window.addEventListener('pointermove', e => { if (e.pointerType !== 'mouse') return; move(e.clientX, e.clientY); _cursor = { x: e.clientX, y: e.clientY }; });
  window.addEventListener('mouseup', e => { if (e.button === 0) fireHeld = false; else dragging = false; });
  el.addEventListener('contextmenu', e => e.preventDefault());   // right-drag look, no menu popup
  el.addEventListener('wheel', e => {
    if (humanDriving() || camLocked()) return;   // zoom is a SPECTATOR control — locked in a human game (even between lives)
    orbit.dist = Math.max(8, Math.min(zoomMax, orbit.dist + e.deltaY * 0.12));
    updateCamera();
  }, { passive: true });
  // Touch model:
  //   DRIVING — the FIRST finger steers (the vehicle heads toward it); release it as a
  //     quick tap and it fires instead. Any EXTRA finger is a tap-to-fire, so you can
  //     shoot without lifting the steering thumb. (No pinch-zoom while driving.)
  //   SPECTATING (AI-vs-AI) — one finger pans the camera, two fingers pinch-zoom.
  //   PvA — pinch-zoom is OFF (two thumbs on the sticks would trip a global 2-touch
  //     zoom); it's gated to spectator games where there are no sticks to conflict.
  let steerId = null, steerStart = null;   // the steering finger's id + its down pos/time
  const taps = {};                         // extra fingers being watched for a tap (by identifier)
  const humanDriving = () => onField && player && !player.dead;
  const spectatorGame = () => TEAM_CTRL[PLAYER_TEAM] !== 'human';   // true AI-vs-AI watch (no human sticks)
  let pinchD = 0;
  const touchDist = (e) => Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
  const fireAt = (x, y) => { if (playerIsValkyrie()) acquireLock(x, y); else fireAtPoint(x, y); };
  const isTap = s => Math.hypot(s.x - s.sx, s.y - s.sy) < 12 && performance.now() - s.t < 300;

  el.addEventListener('touchstart', e => {
    // While driving, the two on-screen sticks own control (left = drive, right = aim);
    // the open field is inert (the camera auto-follows). Touches on the sticks hit their
    // own pointer handlers, not this canvas listener. camLocked also swallows the
    // one-finger PAN between lives in a human game (no free map scouting while dead).
    if (humanDriving() || camLocked()) return;
    if (e.touches.length === 1) {
      const t = e.touches[0];
      touchPan.active = true; touchPan.x = touchPan.sx = t.clientX; touchPan.y = touchPan.sy = t.clientY;
      touchPan.t = performance.now();
    } else if (e.touches.length === 2 && spectatorGame()) {
      touchPan.active = false; pinchD = touchDist(e);   // spectator pinch-zoom
    }
  }, { passive: true });

  el.addEventListener('touchmove', e => {
    if (steerId !== null || Object.keys(taps).length) {
      for (const t of e.changedTouches) {
        if (t.identifier === steerId) { touchSteer.x = steerStart.x = t.clientX; touchSteer.y = steerStart.y = t.clientY; }
        else if (taps[t.identifier]) {
          taps[t.identifier].x = t.clientX; taps[t.identifier].y = t.clientY;
          if (touchStrafe && touchStrafe.id === t.identifier) { touchStrafe.x = t.clientX; touchStrafe.y = t.clientY; }
        }
      }
      return;
    }
    if (e.touches.length === 1 && touchPan.active) {
      touchPan.x = e.touches[0].clientX; touchPan.y = e.touches[0].clientY;
    } else if (e.touches.length === 2 && spectatorGame()) {
      const d = touchDist(e);
      if (pinchD) { orbit.dist = Math.max(8, Math.min(zoomMax, orbit.dist + (pinchD - d) * 0.5)); updateCamera(); }
      pinchD = d;
    }
  }, { passive: true });

  el.addEventListener('touchend', e => {
    for (const t of e.changedTouches) {
      if (t.identifier === steerId) {
        if (isTap(steerStart) && onField && player && !player.dead) fireAt(steerStart.x, steerStart.y);   // a flick of the steer finger = a shot
        steerId = null; steerStart = null; touchSteer = null;
      } else if (taps[t.identifier]) {
        const s = taps[t.identifier]; delete taps[t.identifier];
        if (touchStrafe && touchStrafe.id === t.identifier) touchStrafe = null;
        if (isTap(s) && onField && player && !player.dead) fireAt(s.x, s.y);
      }
    }
    if (!humanDriving() && touchPan.active && e.touches.length === 0) {
      if (isTap(touchPan) && QS.has('tap')) damageTapAt(touchPan.x, touchPan.y);
      touchPan.active = false;
    }
  });
})();

// --- WASD pan (stands in for the future vehicle-follow camera) ---------
// For now this slides the camera target across the map. Once vehicles exist,
// WASD will drive the vehicle and the camera will track it the same way.
const keys = {};
window.addEventListener('keydown', e => {
  keys[e.key.toLowerCase()] = true;   // firing is on the LEFT mouse / tap, not SPACE
  if (e.key.toLowerCase() === 'v' && !e.repeat) toggleAstarViz();   // A* search visualizer overlay
  if (e.key.toLowerCase() === 'm' && !e.repeat) deployMine();       // Firebrat: lay a land mine
  if (e.key.toLowerCase() === 'n' && !e.repeat) deployPod();        // Firebrat: drop a sensor pod
});
window.addEventListener('keyup', e => { keys[e.key.toLowerCase()] = false; });

function panUpdate(dt) {
  let fwd = 0, strafe = 0;
  if (keys['w'] || keys['arrowup']) fwd += 1;
  if (keys['s'] || keys['arrowdown']) fwd -= 1;
  if (keys['d'] || keys['arrowright']) strafe += 1;
  if (keys['a'] || keys['arrowleft']) strafe -= 1;
  // Touch joystick: offset from screen centre (after a brief hold, with deadzone).
  if (touchPan.active && performance.now() - touchPan.t > 120) {
    const scale = window.innerHeight * 0.32;
    const dx = (touchPan.x - window.innerWidth / 2) / scale;
    const dy = (touchPan.y - window.innerHeight / 2) / scale;
    if (Math.hypot(dx, dy) > 0.14) { strafe += dx; fwd += -dy; }
  }
  if (!fwd && !strafe) return;
  const sin = Math.sin(orbit.yaw), cos = Math.cos(orbit.yaw);
  // forward (into the scene) = (-sin,-cos); right = (cos,-sin)
  let mx = -sin * fwd + cos * strafe;
  let mz = -cos * fwd - sin * strafe;
  const len = Math.hypot(mx, mz) || 1;
  const speed = orbit.dist * 0.7 * dt;
  orbit.target.x += (mx / len) * speed;
  orbit.target.z += (mz / len) * speed;
  updateCamera();
}

// When no human is playing (AI-vs-AI), drift the camera to follow the action —
// a flag carrier if there is one, otherwise the nearest pair of rivals. Returns
// true if it took the camera (so the free-pan is skipped).
const _spec = new THREE.Vector3();
let _specFocus = null;          // the unit the spectate camera is currently following (the sound HUD's "ears")
// Spectator focus: null = auto (track a flag carrier, else the first living unit);
// otherwise a unit the viewer pinned with Tab/[/] (see the keydown handler).
let spectateTarget = null;
let spectateFree = false;      // viewer is roaming the island freely; don't chase units until FOLLOW
function cycleSpectate(dir) {
  spectateFree = false;        // picking a unit means follow it again
  const list = combatants.filter(v => !v.dead);
  if (!list.length) { spectateTarget = null; return; }
  let i = list.indexOf(spectateTarget);
  if (i < 0) i = dir > 0 ? -1 : 0;     // land on the first (fwd) / last (back) unit
  spectateTarget = list[(i + dir + list.length) % list.length];
}
// Watch a specific team: each tap advances to the next living unit of that team (so the
// two spectate buttons each flip through their own side's units).
function cycleSpectateTeam(team) {
  spectateFree = false;
  const list = combatants.filter(v => !v.dead && v.team === team);
  if (!list.length) { spectateTarget = null; return; }
  const i = list.indexOf(spectateTarget);   // not on this team → i = -1 → starts at 0
  spectateTarget = list[(i + 1) % list.length];
}
// Is the viewer actively panning the camera (WASD, or a touch-drag past the deadzone)?
// Mirrors panUpdate's own movement test so a stray tap doesn't trip free-look.
function spectatePanning() {
  if (keys['w'] || keys['a'] || keys['s'] || keys['d'] ||
      keys['arrowup'] || keys['arrowdown'] || keys['arrowleft'] || keys['arrowright']) return true;
  if (touchPan.active && performance.now() - touchPan.t > 120) {
    const scale = window.innerHeight * 0.32;
    const dx = (touchPan.x - window.innerWidth / 2) / scale;
    const dy = (touchPan.y - window.innerHeight / 2) / scale;
    if (Math.hypot(dx, dy) > 0.14) return true;
  }
  return false;
}
function spectateUpdate(dt) {
  if (TEAM_CTRL[PLAYER_TEAM] === 'human') return false;
  ensureSpectateControls();   // on-screen team1 / follow / team2 / log buttons (touch + click)
  updateSpectateTeamButtons();   // keep the side buttons coloured + labelled per team
  if (spectateTarget && spectateTarget.dead) spectateTarget = null;   // pinned unit died → back to auto
  // Free-look: once the viewer starts panning, let them roam the island — stop yanking
  // the camera back to a unit until they hit FOLLOW. Returning false hands the camera to
  // panUpdate (which moves orbit.target from the same WASD / touch-pan input).
  if (spectatePanning()) spectateFree = true;
  if (spectateFree) { _specFocus = null; if (spectateTagEl) spectateTagEl.style.display = 'none'; return false; }
  let focus = spectateTarget;
  if (!focus) for (const f of flags) if (f.carried && f.carrier && !f.carrier.dead) { focus = f.carrier; break; }
  if (!focus) for (const cmd of commanders) { const u = cmd.liveUnits()[0]; if (u) { focus = u; break; } }
  _specFocus = focus || null;     // the watched unit = the sound HUD's listener in spectate
  if (!focus) { if (spectateTagEl) spectateTagEl.style.display = 'none'; return false; }
  _spec.set(focus.holder.position.x, 0, focus.holder.position.z);
  orbit.target.lerp(_spec, 0.04);
  updateCamera();
  return true;
}
// The old top-centre "now watching" banner is gone — the bottom spectate buttons
// already show which team you're following, so it was redundant. spectateTagEl stays
// null; the style.display guards above are now no-ops.
let spectateTagEl = null;
// Touch-friendly spectator controls (phone has no keyboard): prev / auto-follow /
// next unit, plus a LOG toggle. Built once on the first spectate frame; the buttons
// take pointer events so a tap doesn't fall through to the orbit camera.
let spectateControlsEl = null;
function ensureSpectateControls() {
  if (spectateControlsEl) return;
  const bar = document.createElement('div');
  bar.id = 'spectate-ctrl';
  bar.style.cssText = 'position:fixed;bottom:22px;left:50%;transform:translateX(-50%);z-index:160;' +
    'display:flex;gap:10px;pointer-events:auto;';
  const BASE = 'font-family:"Courier New",monospace;font-size:15px;font-weight:bold;letter-spacing:1px;' +
    'border:1px solid rgba(255,255,255,0.35);border-radius:9px;' +
    'padding:13px 17px;min-width:52px;text-align:center;user-select:none;-webkit-user-select:none;' +
    'box-shadow:0 2px 8px rgba(0,0,0,0.3);touch-action:manipulation;cursor:pointer;';
  // A side button: tap to flip through that TEAM's units. Its colour/label track the
  // live team colour (updateSpectateTeamButtons); _team is set there too.
  const mkTeam = () => {
    const btn = document.createElement('div');
    btn.style.cssText = BASE + 'color:#eef4f8;background:rgba(8,12,18,0.7);';
    btn._team = null;
    btn.addEventListener('pointerdown', (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      if (btn._team) cycleSpectateTeam(btn._team);
    });
    bar.appendChild(btn);
    return btn;
  };
  // Two side buttons, one per team: tap to follow that team (cycle its units). There's
  // no FOLLOW button — selecting a team IS following; panning (WASD / drag) drops to
  // free-look. The LOG lives top-right now (see ensureLogToggle), not down here.
  const tA = mkTeam();
  const tB = mkTeam();
  spectateTeamBtns = [tA, tB];
  document.body.appendChild(bar);
  spectateControlsEl = bar;
}
// Keep the two side buttons coloured + labelled by the live team colours, and light up
// whichever team is currently being watched.
let spectateTeamBtns = [];
let _specBtnT = 0;
function updateSpectateTeamButtons() {
  if (!spectateTeamBtns.length) return;
  const nowMs = performance.now();   // 4Hz — per-frame style/text writes showed up hot in the phone trace
  if (nowMs - _specBtnT < 250) return;
  _specBtnT = nowMs;
  const teams = [...new Set(commanders.map(c => c.team))];
  for (let i = 0; i < spectateTeamBtns.length; i++) {
    const btn = spectateTeamBtns[i], team = teams[i];
    if (!team) { btn.style.display = 'none'; continue; }
    btn.style.display = '';
    btn._team = team;
    const hex = teamColor(team);
    btn.textContent = colorName(hex);
    const on = !spectateFree && spectateTarget && spectateTarget.team === team;
    btn.style.background = on ? hex : 'rgba(8,12,18,0.7)';
    btn.style.borderColor = hex;
    btn.style.color = on ? '#0a0e14' : '#eef4f8';   // dark text on the lit swatch
  }
}

// --- Shot mode ---------------------------------------------------------
// `?shot` builds a small map (and skips foliage unless `&fol`) so the headless
// render rig stays fast on the software-GL box. Gameplay defaults are untouched.
const QS = new URLSearchParams(location.search);
const SHOT = QS.has('shot');
// ?units=N (1-3): procedural maps build N elevator pads per team — the main lift inside the
// FOB plus satellite pads flanking it — and the unit cap (one fielded vehicle per lift, see
// AICommander.unitCap) follows. Designed maps instead count the elevators placed in the editor.
const UNITS_PER_TEAM = Math.max(1, Math.min(3, (+QS.get('units') || 1)));
// FOB wall ring / gates / corner towers around the elevator. DEFAULT by mode: ON for a 1v1
// (a single unit wants a fortified home) and OFF for multi-unit, where the elevator anti-camp
// shield already covers a rising vehicle and open FOBs resolve faster (A/B in VERDICT-multiunit:
// same win rate, ~20% faster, less idle). ?fobwalls=0/1 forces it either way.
const FOB_WALLS = QS.has('fobwalls') ? QS.get('fobwalls') !== '0' : UNITS_PER_TEAM === 1;
// ?dseed=N seeds the DOCTRINE SETUP (which archetypes + personalities each side gets) with a
// deterministic PRNG, so two builds/variants can play the EXACT same matchup for a paired A/B
// — otherwise Math.random gives every run a different Warrior-vs-Turtle-etc game and the noise
// buries any real difference. Only the setup is seeded; in-match randomness stays live.
function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
// ?rngseed=N (TEST-RIG ONLY) — makes an ENTIRE headless match deterministic by reseeding the global
// RNG, so a behavior tweak can be A/B'd on TRULY identical matches (same combat rolls; only the change
// differs). Non-determinism otherwise buries subtle fixes in run-to-run noise. The LIVE GAME never
// passes this param, so real play keeps native Math.random untouched. Set before anything reads it.
let _rngReseed = null;   // RR.reseed(n): rigs re-pin the stream AFTER load — async asset callbacks
// consume a load-order-dependent amount of the stream, and under IO contention that order
// occasionally swaps: ~1-in-N boots silently played a DIFFERENT match from the same seed
// (the "ghost run" that sent a whole bisection chasing phantom causes). Re-seeding at
// drive-start makes the match independent of everything the boot consumed.
if (QS.has('rngseed')) {
  let _seedRng = mulberry32((+QS.get('rngseed') >>> 0) || 1);
  Math.random = () => _seedRng();
  _rngReseed = n => { _seedRng = mulberry32((n >>> 0) || 1); };
}
const doctrineRng = QS.has('dseed') ? mulberry32((+QS.get('dseed') >>> 0) || 1) : Math.random;

// ?perf — on-device profiler: per-frame CPU time BROKEN DOWN by system, so a stutter's cause
// is visible without DevTools (esp. on the phone, where there's no console). Off unless enabled.
// Accepts common spellings/typos (perf / pref / performance / preformance) so it just works.
//
// TWO FLAGS, because there are two questions. PERF is "are the section timers RUNNING" — _pfT is
// a no-op without it, so the per-system split is not merely hidden when it's off, it is never
// measured, which is why the corner readout's [+] has to be able to switch it on rather than just
// reveal something. PERF_PANEL is "draw the full top-right firehose", and stays query-string-only
// so ?perf behaves exactly as it always has.
//
// Turning collection on at runtime is safe: _pfT costs two performance.now() calls per section per
// frame, a few dozen a frame all told, well under the resolution of what it's measuring.
let PERF = ['perf', 'pref', 'performance', 'preformance'].some(k => QS.has(k));
const PERF_PANEL = PERF;
let perfExpanded = false;      // the corner readout's [+] tier (replans / fx / scene / top sections)
const _pfAcc = {};                                     // section → ms accumulated over the window
const _pfFrameAcc = {};                                // section → ms for THIS frame alone (feeds the hitch log)
let _pfFrames = 0, _pfWork = 0, _planCount = 0, _pfShownAt = 0;
function _pfT(k, fn) {
  if (!PERF) return fn();
  const t = performance.now(); fn(); const d = performance.now() - t;
  _pfAcc[k] = (_pfAcc[k] || 0) + d;
  _pfFrameAcc[k] = (_pfFrameAcc[k] || 0) + d;
}
// ── HITCH LOG (?perf) ─────────────────────────────────────────────────────────
// A stutter is over before you can open DevTools, and on a phone there IS no DevTools — so the
// game keeps its own evidence. Any frame that overruns PF_HITCH_MS is recorded with what it was
// doing (its section split), how many paths it planned and why, and how much was on the field.
// The worst few survive, so you can play, feel a hitch, and read the cause off the panel after.
const _pfWhy = {};                                     // "trigger/state" → replans over the window
const _pfWhyAll = {};                                  // same, but for the WHOLE match — RR.replanWhy()
// WHO is calling A*. The replans/s counter counts every planPath; the cause tags only cover the
// nav layer — and that DISCREPANCY is what exposed the siege re-solve storm (40 replans/s with 3
// tagged). Attributing by caller makes it visible directly instead of by arithmetic.
const _planBy = {};
const _planByAll = {};   // cumulative for the whole match (the panel's copy is cleared each window) — RR.planByAll()
const _pfHitch = [];                                   // worst frames seen this session
const PF_HITCH_MS = 25;                                // ~1.5 frames at 60Hz: by here a frame was certainly dropped
const PF_HITCH_KEEP = 5;
let _planFrame = 0;   // A* searches issued in THIS frame — feeds the hitch log and the storm alarm
function _pfNoteHitch(ms, whenS) {
  const secs = Object.entries(_pfFrameAcc).filter(([, v]) => v >= 0.5).sort((a, b) => b[1] - a[1]).slice(0, 3);
  _pfHitch.push({ ms, at: whenS, plans: _planFrame, units: combatants.length, fx: fx.length,
    secs: secs.map(([k, v]) => `${k} ${v.toFixed(0)}`).join(' ') });
  _pfHitch.sort((a, b) => b.ms - a.ms);
  if (_pfHitch.length > PF_HITCH_KEEP) _pfHitch.length = PF_HITCH_KEEP;
}
// ── DRAW-CALL BREAKDOWN (?perf) ───────────────────────────────────────────────
// `renderer.info.render.calls` is the TRUE per-frame total (it includes the shadow
// pass). The per-category lines are an ESTIMATE of the main pass: visible, frustum-
// passing mesh×material units under each category's scene roots — one Mesh with 3
// materials = 3 draws; an InstancedMesh = 1 whatever its count (that's its point).
// NOTE the game has NO shadow-map pass: shadows are BlobShadow decals (instanced), and
// although renderer.shadowMap.enabled is on, no LIGHT casts — so no shadow render runs
// and the meshes' castShadow flags are inert. `shadow off` in the readout confirms it;
// if a casting light is ever added, the line flips to `shadow~ N` (casters in view, a
// ballpark of the extra pass). Recomputed at 1Hz; the walk is a fraction of a ms.
const _dcFrus = new THREE.Frustum(), _dcMat4 = new THREE.Matrix4();
let _dcAt = 0, _dcLines = '';
function _dcUnits(root, seen, tally) {
  const walk = (o) => {
    if (!o.visible) return;
    if (o.isMesh && !seen.has(o)) {
      seen.add(o);
      if (!o.frustumCulled || _dcFrus.intersectsObject(o)) {
        tally.n += Array.isArray(o.material) ? o.material.length : 1;
        if (o.castShadow) tally.sh++;
      }
    }
    for (const c of o.children) walk(c);
  };
  if (root) walk(root);
}
function _dcBreakdown() {
  _dcMat4.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  _dcFrus.setFromProjectionMatrix(_dcMat4);
  const seen = new Set();
  const cats = [
    ['terrain', [map.group]],
    ['foliage', [foliage && foliage.group]],
    ['bases', [...camps.map(c => c.group), ...placedWalls.map(w => w.group), ...placedProps, ...elevators.map(e => e.group), wallInstancesGroup()]],
    ['vehicles', [...combatants, ...vehicles].map(v => v.holder)],   // combatants = live field units; vehicles = ambient
  ];
  let shadow = 0;
  const rows = [];
  for (const [name, roots] of cats) {
    const t = { n: 0, sh: 0 };
    for (const r of roots) _dcUnits(r, seen, t);
    shadow += t.sh; rows.push([name, t.n]);
  }
  // everything not under a tracked root (projectiles, soldiers, gadgets, flags, fx —
  // they add straight to the scene) lands in 'other'.
  const t = { n: 0, sh: 0 }; _dcUnits(scene, seen, t);
  shadow += t.sh; rows.push(['other', t.n]);
  // A shadow pass only exists if a LIGHT casts (mesh flags alone do nothing).
  let shadowsLive = false;
  if (renderer.shadowMap.enabled) scene.traverse(o => { if (o.isLight && o.castShadow) shadowsLive = true; });
  const gpu = renderer.info.render.calls;
  _dcLines = `draws ${gpu} (frame)\n`
    + rows.filter(([, n]) => n).map(([k, n]) => ` ${k.padEnd(9)}${n}`).join('\n')
    + (shadowsLive ? `\n shadow~  ${shadow}` : '\n shadow   off (blob decals)');
}
function _pfRender() {
  const now = performance.now(); const win = now - _pfShownAt;
  if (win < 300 || !_pfFrames) return;
  _pfShownAt = now;
  const fps = _pfFrames / (win / 1000), work = _pfWork / _pfFrames, rep = _planCount / (win / 1000);
  const secs = Object.entries(_pfAcc).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k.padEnd(11)}${(v / _pfFrames).toFixed(1)}ms`);

  // THE CORNER TIER — what the [+] opens. Deliberately the short list (the four numbers that say
  // whether the field or the frame is the problem, plus the three systems eating the most of it)
  // rather than the panel below, which is a firehose you want when hunting and not while playing.
  const more = document.getElementById('perf-more');
  if (more) {
    more.innerHTML = perfExpanded
      ? `REPLANS/S: ${rep.toFixed(0)}<br>UNITS: ${combatants.length}&nbsp; FX: ${fx.length}<br>SCENE: ${scene.children.length}<br>`
        + (secs.length ? secs.slice(0, 3).map(s => s.replace(/\s+/g, ' ').toUpperCase()).join('<br>') : 'SECTIONS: (warming up)')
      : '';
  }
  if (!PERF_PANEL) { for (const k in _pfAcc) _pfAcc[k] = 0; for (const k in _pfWhy) delete _pfWhy[k]; for (const k in _planBy) delete _planBy[k]; _pfFrames = 0; _pfWork = 0; _planCount = 0; return; }

  let el = document.getElementById('perfhud');
  if (!el) { el = document.createElement('div'); el.id = 'perfhud'; el.style.cssText = 'position:fixed;top:46px;right:8px;z-index:99;font:11px/1.35 monospace;color:#7fffb8;background:rgba(0,0,0,0.72);padding:6px 9px;border-radius:6px;white-space:pre;pointer-events:none'; document.body.appendChild(el); }
  if (now - _dcAt > 1000) { _dcAt = now; try { _dcBreakdown(); } catch (e) { _dcLines = ''; } }
  // WHY those replans happened — the aggregate count alone never said which subsystem was moving
  // a goal. Top triggers, each tagged with the AI state that asked for it.
  const why = Object.entries(_pfWhy).sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([k, v]) => ` ${k.padEnd(22)}${v}`).join('\n');
  // WHO called A*. replans/s counts every search; the cause tags only cover the nav layer, so a
  // gap between them means something else is searching. That gap is how the siege re-solve storm
  // was found — 40/s with 3 tagged. Print it rather than leaving it to arithmetic.
  const byCaller = Object.entries(_planBy).sort((a, b) => b[1] - a[1])
    .map(([k, v]) => ` ${k.padEnd(22)}${(v / (win / 1000)).toFixed(0)}/s`).join('\n');
  const hitch = _pfHitch.length
    ? '\nworst frames (this session)\n' + _pfHitch.map(h =>
        ` ${h.ms.toFixed(0).padStart(4)}ms @${h.at.toFixed(0)}s  plans ${h.plans} u${h.units} fx${h.fx}\n   ${h.secs || '(no section over 0.5ms)'}`).join('\n')
    : '';
  el.textContent = `fps ${fps.toFixed(0)}  work ${work.toFixed(1)}ms\nreplans/s ${rep.toFixed(0)}  units ${combatants.length}  fx ${fx.length}\nscene ${scene.children.length}\n` + secs.join('\n')
    + (byCaller ? '\nA* by caller\n' + byCaller : '')
    + (why ? '\nreplan cause\n' + why : '')
    + (_dcLines ? '\n' + _dcLines : '') + hitch;
  for (const k in _pfAcc) _pfAcc[k] = 0;
  for (const k in _pfWhy) delete _pfWhy[k];
  for (const k in _planBy) delete _planBy[k];
  _pfFrames = 0; _pfWork = 0; _planCount = 0;
}
const SHOT_SIZE = parseInt(QS.get('size')) || 96;
const SHOT_FOL = QS.has('fol');
const SHOT_SEED = QS.has('seed') ? parseInt(QS.get('seed')) : null;
// (Deterministic matches: use `?rngseed=N` + `?dseed=N` — both below — plus a test rig
// that freezes performance.now and disables rAF before load. `?seed` alone pins ONLY the
// map: normal play stays fresh, and the RNG stream is left native unless a rig asks.)
// Seed policy: normal play gets a FRESH RANDOM map every load (each game is different).
// `?seed=N` pins it for reproducibility, and `?shot` keeps the fixed default seed so the
// headless render/test rigs stay deterministic. `?seed` always wins.
const wantSize = SHOT || QS.has('size');
const MAP_SEED = SHOT_SEED != null ? SHOT_SEED : SHOT ? null : (Math.random() * 2147483647) | 0;
// ?mapcfg=<base64 JSON> — a map authored in the Map Designer (terrain params + AI
// rules; placed assets/roads are authored but not yet honoured here). Decoded once;
// drives the terrain (below) and the AI commanders (applyMapCfgRules).
const MAP_CFG = (() => {
  // ?maplocal=<storage key> — same-origin handoff from the map-designer (a real map's
  // JSON blows past the server's URL length limit as a ?mapcfg= query, HTTP 414).
  if (QS.has('maplocal')) {
    try { const j = JSON.parse(localStorage.getItem(QS.get('maplocal'))); if (j) return j; }
    catch (e) { console.warn('maplocal: could not read —', e && e.message); }
  }
  if (!QS.has('mapcfg')) return null;
  try { return JSON.parse(decodeURIComponent(escape(atob(QS.get('mapcfg'))))); }
  catch (e) { console.warn('mapcfg: could not decode —', e && e.message); return null; }
})();
// A designed map can set the player's (team A / red) fleet — mutate the shared garage
// counts so the deploy roster reflects it. (Each AI team's fleet is set per-commander.)
if (MAP_CFG?.rules?.teams?.a?.roster) {
  for (const [k, v] of Object.entries(MAP_CFG.rules.teams.a.roster))
    if (k in GARAGE_COUNTS && Number.isFinite(v)) GARAGE_COUNTS[k] = Math.max(0, v | 0);
}
// Map generation options, honoured in ANY field mode (so ?aivsai&size&seed is
// reproducible, not just ?shot). undefined → the map's own fixed default. A designed
// map's `base` params win outright (deterministic: its own seed + shape).
const GEN_OPTS = (MAP_CFG && MAP_CFG.base) ? { ...MAP_CFG.base }
  : (wantSize || MAP_SEED != null) ? {
    ...(wantSize ? { cols: SHOT_SIZE, rows: SHOT_SIZE } : {}),
    ...(MAP_SEED != null ? { seed: MAP_SEED } : {}),
  } : undefined;
// Normal play STARTS IN THE GARAGE (pick team colour + vehicle, then deploy). Only
// the headless test/spectate paths drop straight onto the field.
const SPECTATE = QS.has('aivsai') || QS.has('spectate') || QS.has('ai');
const FIELD_DIRECT = SHOT || QS.has('field') || SPECTATE;
const GARAGE = QS.has('garage') || !FIELD_DIRECT;   // render the hangar as the entry view
// Start screen: the default interactive entry opens a game menu over the hangar
// (pick PLAYER VS AI / AI VS AI). ?play jumps straight to the deploy garage (the menu
// navigates here), and the headless/dev/spectate query flags bypass it entirely.
const START_MENU = !FIELD_DIRECT && !SHOT && !QS.has('play') && !QS.has('garage');
// ?campaign=<level id> — this match is a campaign level; a player win marks it complete
// (unlocking the next). ?campaign with no id just reopens the menu on the campaign list.
const CAMPAIGN_ID = QS.get('campaign') || null;
// Attrition preview: ?losses=firebrat:3,jotun:1 — until match results feed this.
const LOSSES = (() => {
  const raw = QS.get('losses');
  if (!raw) return null;
  const o = {};
  for (const part of raw.split(',')) { const [t, n] = part.split(':'); if (t) o[t.trim()] = parseInt(n) || 0; }
  return o;
})();
// Running attrition of the PLAYER's fleet — each death removes one of that type
// from the garage roster (seeded by the ?losses preview). Fed to garage.applyRoster.
const playerLosses = LOSSES ? { ...LOSSES } : {};

// On-screen NAV stick (touch) — a "go in this direction" pad: the knob's offset is a
// camera-relative compass heading, consumed by driveInput (which turns the hull to face
// it and throttles by how far the knob is pushed). Field only; revealed on touch devices
// (window.showJoystick() forces it on for desktop tests).
(function setupJoystick() {
  const joystick = document.getElementById('touch-joystick');
  const knob = document.getElementById('touch-knob');
  // Wire it unconditionally (incl. ?garage flow): it only sets touchNav, which is
  // read while driving, and the widget itself is hidden until setFieldUI(true).
  if (!joystick || !knob) return;
  const MAX_TRAVEL = 42;
  let joyId = null;
  // Visibility is driven by setFieldUI (gated on a real touch — see touchUsed);
  // reveal() stays only as a manual override for desktop testing.
  const reveal = () => joystick.classList.add('visible');
  window.showJoystick = reveal;

  const applyVector = (cx, cy) => {
    const r = joystick.getBoundingClientRect();
    let dx = cx - (r.left + r.width / 2), dy = cy - (r.top + r.height / 2);
    const d = Math.hypot(dx, dy);
    const mag = d / MAX_TRAVEL;                          // 0..>1 push toward the rim = throttle
    let kx = dx, ky = dy;
    if (d > MAX_TRAVEL) { kx *= MAX_TRAVEL / d; ky *= MAX_TRAVEL / d; }
    knob.style.transform = `translate(${kx}px, ${ky}px)`;
    touchNav = { nx: dx / MAX_TRAVEL, ny: dy / MAX_TRAVEL, mag };   // ny screen-down positive
  };
  const release = () => {
    joyId = null;
    knob.style.transform = 'translate(0px, 0px)';
    touchNav = null;
  };
  joystick.addEventListener('pointerdown', e => {
    if (joyId !== null) return;
    joyId = e.pointerId;
    joystick.setPointerCapture(e.pointerId);
    applyVector(e.clientX, e.clientY);
    e.preventDefault();
  });
  joystick.addEventListener('pointermove', e => {
    if (e.pointerId !== joyId) return;
    applyVector(e.clientX, e.clientY);
    e.preventDefault();
  });
  const end = e => { if (e.pointerId === joyId) release(); };
  joystick.addEventListener('pointerup', end);
  joystick.addEventListener('pointercancel', end);
})();

// On-screen fire button (touch) — holds fireHeld, the same flag SPACE sets.
// Revealed by setFieldUI on touch devices; field-only.
(function setupFireButton() {
  // A FIRE button in each bottom corner (left + right) so either thumb can fire while the
  // other steers on the field. Press holds fireHeld (same flag SPACE / mouse uses); the
  // driveUpdate cadence loop turns that into repeat shots.
  for (const id of ['fire-btn', 'fire-btn-l']) {
    const btn = document.getElementById(id);
    if (!btn) continue;
    const press = e => { fireHeld = true; btn.classList.add('pressed'); e.preventDefault(); };
    const lift  = () => { fireHeld = false; btn.classList.remove('pressed'); };
    btn.addEventListener('pointerdown', press);
    btn.addEventListener('pointerup', lift);
    btn.addEventListener('pointercancel', lift);
    btn.addEventListener('pointerleave', lift);
  }
})();

// On-screen AIM stick (touch, right thumb). Tilt to point the gun (knob angle =
// desired turret offset from the hull forward, clamped to the type's arc); push the
// knob to the rim to FIRE. The actual aiming + aim-assist runs per-frame in
// updateTouchAim — this handler only records the stick vector and draws the knob.
(function setupAimStick() {
  const stick = document.getElementById('touch-aim');
  const knob = document.getElementById('aim-knob');
  if (!stick || !knob) return;
  const MAX_TRAVEL = 46;
  let aimId = null;
  const apply = (cx, cy) => {
    const r = stick.getBoundingClientRect();
    let dx = cx - (r.left + r.width / 2), dy = cy - (r.top + r.height / 2);
    const d = Math.hypot(dx, dy);
    const mag = d / MAX_TRAVEL;                 // raw, can exceed 1 when pushed past the rim
    let kx = dx, ky = dy;
    if (d > MAX_TRAVEL) { kx *= MAX_TRAVEL / d; ky *= MAX_TRAVEL / d; }
    knob.style.transform = `translate(${kx}px, ${ky}px)`;
    touchAim = { nx: dx / MAX_TRAVEL, ny: dy / MAX_TRAVEL, mag };
    stick.classList.toggle('firing', mag >= RIM_FIRE);
  };
  const release = () => {
    aimId = null; touchAim = null; touchAiming = false; fireHeld = false;
    knob.style.transform = 'translate(0px, 0px)';
    stick.classList.remove('firing');
  };
  stick.addEventListener('pointerdown', e => {
    if (aimId !== null) return;
    aimId = e.pointerId; stick.setPointerCapture(e.pointerId);
    apply(e.clientX, e.clientY); e.preventDefault();
  });
  stick.addEventListener('pointermove', e => {
    if (e.pointerId !== aimId) return;
    apply(e.clientX, e.clientY); e.preventDefault();
  });
  const end = e => { if (e.pointerId === aimId) release(); };
  stick.addEventListener('pointerup', end);
  stick.addEventListener('pointercancel', end);
})();

// Paint the aim stick's lit wedge to match the live vehicle's firing arc (forward =
// up). Full ring for the Lurcher (any direction); a narrow sector for the Jotun; a
// half for the Valkyrie. Tiny fixed-gun arcs (Firebrat) get a readable minimum.
function refreshAimArc() {
  const el = document.getElementById('aim-arc');
  if (!el || !player) return;
  const arc = SHOT_ARC[player.type] ?? Math.PI / 5;
  const hi = 'rgba(120,210,150,0.30)';
  if (arc >= Math.PI - 1e-3) { el.style.background = 'rgba(120,210,150,0.18)'; return; }   // 360°
  const deg = Math.max(16, arc * 180 / Math.PI);   // min 16°/side so a fixed gun still shows
  el.style.background = `conic-gradient(${hi} 0 ${deg}deg, transparent ${deg}deg ${360 - deg}deg, ${hi} ${360 - deg}deg 360deg)`;
}
// Rotate the lit wedge so its CENTRE points where the vehicle's nose appears ON SCREEN
// (θ = camera yaw − hull heading). With the input now screen-relative, this keeps the arc
// pointing the way the vehicle's headed, so pushing the knob toward an on-screen target
// aims at it. Cheap per-frame DOM write; a full-ring (Lurcher) arc looks the same rotated.
function orientAimArc() {
  const el = document.getElementById('aim-arc');
  if (!el || !player || player.dead) return;
  el.style.transform = `rotate(${(orbit.yaw - player.heading) * 180 / Math.PI}deg)`;
}

// Per-frame: turn the aim stick's tilt into a world aim point (with aim-assist) so the
// existing turret-tracking + fire pipeline (aimPlayerTurret / firePlayer) just works on
// touch — no cursor needed. Sets _aimPoint/_aimTargetVeh/_aimValid and fireHeld.
const _aimStickV = new THREE.Vector3();
function updateTouchAim() {
  touchAiming = false;
  if (!onField || !player || player.dead || !touchAim) return;
  touchAiming = true;
  const hp = player.holder.position;
  const arc = SHOT_ARC[player.type] ?? Math.PI / 5;
  // SCREEN-RELATIVE aim: push the knob toward where the target sits ON SCREEN and the gun
  // aims that way (your instinct is screen space, not hull space — pushing "down" when the
  // vehicle faces down should fire down, not backward). Convert the knob offset to a
  // camera-relative world direction (same basis as the drive pad), then express it as an
  // offset from the hull so the arc clamp + aim-assist stay hull-relative.
  const sy = Math.sin(orbit.yaw), cy = Math.cos(orbit.yaw);
  const wx = (-sy) * (-touchAim.ny) + cy * touchAim.nx;        // camForward·(up) + camRight·(right)
  const wz = (-cy) * (-touchAim.ny) + (-sy) * touchAim.nx;
  const rawWorld = Math.atan2(-wx, -wz);                       // world heading the thumb points at
  const desired = Math.max(-arc, Math.min(arc, wrapPi(rawWorld - player.heading)));
  // Aim-assist (the touch "handicap"): snap to the nearest enemy within a cone of where
  // you point AND inside the vehicle's arc, so a human doesn't have to nail the angle.
  let best = null, bestErr = ASSIST_CONE;
  for (const v of combatants) {
    if (v.dead || v === player || v.team === player.team) continue;
    const dx = v.holder.position.x - hp.x, dz = v.holder.position.z - hp.z;
    if (Math.hypot(dx, dz) > ASSIST_RANGE) continue;
    const ang = Math.atan2(-dx, -dz);
    if (Math.abs(wrapPi(ang - player.heading)) > arc + 1e-3) continue;   // outside the arc
    const err = Math.abs(wrapPi(ang - rawWorld));
    if (err < bestErr) { bestErr = err; best = v; }
  }
  const fire = touchAim.mag >= RIM_FIRE;
  if (player.type === 'valkyrie') {
    // Missile lock toward the assisted enemy, or the ground point you're pointing at.
    if (best) setLock(best, best.holder.position);
    else {
      const ang = player.heading + desired;
      _aimStickV.set(hp.x - Math.sin(ang) * 60, 0, hp.z - Math.cos(ang) * 60);
      _aimStickV.y = map.heightAt(_aimStickV.x, _aimStickV.z) + 0.5;
      setLock(null, _aimStickV);
    }
    fireHeld = fire;
    return;
  }
  if (best) { _aimPoint = best.holder.position.clone(); _aimTargetVeh = best; }
  else {
    const ang = player.heading + desired;
    _aimStickV.set(hp.x - Math.sin(ang) * 60, 0, hp.z - Math.cos(ang) * 60);
    _aimStickV.y = map.heightAt(_aimStickV.x, _aimStickV.z) + 1.0;
    _aimPoint = _aimStickV.clone(); _aimTargetVeh = null;
  }
  _aimValid = true;
  fireHeld = fire;
}

// Reveal the on-screen touch controls only AFTER a real touch — capability flags
// (maxTouchPoints / ontouchstart) are true on touchscreen laptops and many desktop
// browsers, so they'd wrongly show the drive stick + fire button on a mouse rig.
let touchUsed = false;
function onFirstTouch() {
  if (touchUsed) return;
  touchUsed = true;
  if (onField) setFieldUI(true);   // already on the island → show them now
}
window.addEventListener('pointerdown', e => { if (e.pointerType === 'touch') onFirstTouch(); });
window.addEventListener('touchstart', onFirstTouch, { passive: true });   // Safari fallback

// --- Map + camps -------------------------------------------------------
const map = new IslandMap();
const grid = new BuildGrid(map, 5);   // shared build grid (5-unit cells)
const roadNet = new RoadNetwork(map, grid);
let destructibles = new DestructibleManager();
let camps = [];
let configBases = false;   // true when bases came from a DESIGNED map (no procgen walls/roads)
let placedWalls = [];      // designer-placed wall/tower/gate combat pieces (custom maps)
let placedProps = [];        // designer-placed generic structures (cleanup on rebuild)
let elevators = [];   // animated FOB surface lifts (one per forward base)
let resupplies = [];  // neutral fuel/ammo/shield points of interest
let scrapPiles = [];  // salvage piles — drive over one to collect it for your team (a gib-wreck is worth SCRAP_DROP[type])
let gibChunks = [];   // vehicle part-meshes currently flying apart on death (see gibVehicle/updateGibs)
const teamScrap = { red: 0, blue: 0 };   // scrap banked per team; spent in the garage to build vehicles
const scrapBuilds = { red: 0, blue: 0 };  // count of vehicles built from salvage (debug/telemetry)
let _hqSwapCount = 0;   // debug/telemetry: HQ-finisher recall-swaps (Jotun→Valkyrie once the fort's down)
let aiScrapBuild = true;   // AI commanders spend scrap to rebuild + run scavenge missions (A/B knob via RR.setAiScrap)
let aiScrapTightArrive = true;   // salvage-detouring units close to within the pickup radius instead of halting at mission arriveDist (A/B via RR.setScrapTightArrive)
let aiSwapBuild = QS.has('swapbuild');   // let a recall proceed when the roster is empty but the bank can BUILD the wanted chassis (A/B knob — see swapWanted)
// SHIPPED 2026-08-10 (?nomsnattrib reverts). Grade a unit's death against the PRIMARY mission (the
// job) instead of strategy.step (the errand it died on). Without it a runner that takes
// capture-front, gets shot up, correctly breaks off to FLEE and dies on the way out files its loss
// against `flee` — so capture-front is never punished and the commander feeds runner after runner
// down the same lane. Jacob watched exactly that: 12 in reserve, then 11, then 10.
// 240 seeds x2: resolved +2 and +1, stalemates 3->1 and 3->2. The sign holds.
// IT COSTS SOMETHING AND THAT IS ACCEPTED: matches ~13s longer on fresh seeds, nav alarms +42%,
// inland stuck +44%. Jacob's call — "sometimes we just have to eat the numbers and then work on
// them", and the new alarms are the work queue, not grounds to revert.
// (An earlier gate on 2026-08-09 rejected this for being slower. That run was on a different build
// and leaned on stuck columns since shown to be dominated by a couple of pathological maps. No
// verdict file was written then, which is why it had to be re-derived — see
// VERDICT_2026-08-10_msnattrib.txt.)
let aiMsnAttrib = !QS.has('nomsnattrib');
let aiReqVehicle = QS.has('reqveh');     // MissionScore prices whether the fleet can actually CREW each plan (A/B knob — see requiredVehicle)
let aiFleeScore = QS.has('fleescore');   // flee becomes a SCORED candidate instead of a hard preempt (A/B knob — selection only, the terminal commitment stays)
let aiFightMission = QS.has('fightmsn'); // a vehicle-vs-vehicle duel becomes a MISSION that starts and ends (A/B knob — see the Fight class)
let aiPostKillMoveOn = true;   // on a kill, drop the killer's engage-afterglow ghost so it doesn't linger "searching" the corpse (A/B via RR.setPostKillMoveOn)
const SCRAP_DROP = { jotun: 3, valkyrie: 2, lurcher: 2, firebrat: 1 };   // scrap a destroyed vehicle's wreck is worth
const SCRAP_GRAB_RANGE = 45;   // max detour a mobile unit takes to grab a spotted pile on its way
const SCRAP_SIEGE_RANGE = 14;  // a SIEGER only bends for a pile basically on its path (no real detours off the firing line)
const LOOT_RANGE = 28;         // after a KILL, how far the killer will swing over to grab the wreck it just made
const LOOT_MS = 6000;          // give up the loot order after this long (don't let it stall the advance)
let aiKillLoot = true;         // killers collect the wreck of what they just destroyed (A/B knob via RR.setKillLoot)
const GIB_GRAV = 42;           // gravity on flying debris pieces (world units/s^2)
const GIB_HOT_MS = 1500;       // debris is airborne/uncollectable this long after death
const MAX_WRECKS = 10;         // cap persistent wreck piles on the field; oldest fades when exceeded
// How many pieces of an INSTANCED part survive being blown apart (see gibVehicle). Every survivor
// is its own draw call on a wreck that persists, and MAX_WRECKS of them can be on the field, so
// this is a budget and not a fidelity dial — a track that came apart does not need every link.
const GIB_INSTANCE_KEEP = 8;
const _gibM4 = new THREE.Matrix4();
const BUILD_COST = { jotun: 5, valkyrie: 5, lurcher: 3, firebrat: 2 };   // scrap to build one (garage, slice 2)
let onField = false;  // true while the island is on screen (false = hangar view)
let fieldBuilt = false; // the island is generated once, then reused across deploys
let matchOver = false;  // a flag was captured — freeze the action, show the result
let lastWinner = null;     // team key of the last decided match (endMatch)
let matchWon = false;   // last match's result for the PLAYER team (VICTORY vs DEFEAT on the end menu)
let flagsCaptured = 0;  // enemy flags the player has extracted into the garage (score)
let deploy = null;    // { type, colorIndex } captured when a deploy is confirmed
let fieldFadeT = 0;   // counts up after handoff to fade the black deploy overlay out
let garageFadeT = null; // when set, fades the garage in from black (on return)
let _garageElevSnd = null; // handle for the garage deploy-lift servo whir (started on rise)
let waterT = 0;         // elapsed seconds driving the animated water ripples (pauses with the game)
let victoryReturn = false; // the current lift descent is a winning flag extraction (run the cinematic)
let victoryHoldT = 0;      // beat held at the bottom of a victory descent before fading out
const VICT_HOLD = 1.9;     // seconds to linger on the celebration at the bottom
const WIN_CINEMATIC_MS = 5200;   // how long the in-hangar victory cinematic plays before the menu pops

// Team accent colours (match Camp's wall accents) + camo palette slot per team
// (indices into TEAM_COLORS: 4 = RED, 5 = BLUE).
const TEAM_ACCENT = { red: '#c0392b', blue: '#2e6fc0' };
const TEAM_CAMO   = { red: 4, blue: 5 };
// Designer maps tag teams 'a'/'b'/'neutral'; the game runs on 'red'/'blue'/null.
const gameTeamOf = (dt) => dt === 'a' ? 'red' : dt === 'b' ? 'blue' : null;
// Build-time accent for a designer team code: its side's accent, or neutral grey.
const accentForCode = (dt) => { const g = gameTeamOf(dt); return g ? TEAM_ACCENT[g] : '#8a8f8a'; };
// Default vehicle each team fields (used for the plain-field player until a real
// garage deploy chooses one).
const FOB_RIDER = { red: 'jotun', blue: 'firebrat' };
const PLAYER_TEAM = 'red';   // the garage / player's side
// Who runs each team: 'human' (player drive/garage) or 'ai' (an AICommander).
// Flexible by design — flip any team to 'ai' for AI-vs-AI, or extend for more
// teams. ?aivsai (or ?spectate) makes everyone AI; ?ai also makes the player AI.
const TEAM_CTRL = { red: 'human', blue: 'ai' };
if (QS.has('aivsai') || QS.has('spectate') || QS.has('ai')) { TEAM_CTRL.red = 'ai'; TEAM_CTRL.blue = 'ai'; }

// Nearest gate (object) of a camp to a world point. A BARE camp (?fobwalls=0 — no ring,
// no gates) still gets a road: synthesize an endpoint just off the lift pad's edge,
// facing the point, so the road runs up to the pad instead of crashing the builder.
function nearestGate(camp, point) {
  if (!camp.gates.length) {
    const out = point.clone().sub(camp.center).setY(0).normalize();
    return { pos: camp.center.clone().addScaledVector(out, 8), outward: out };
  }
  let best = camp.gates[0], bd = Infinity;
  for (const g of camp.gates) { const d = g.pos.distanceToSquared(point); if (d < bd) { bd = d; best = g; } }
  return best;
}

// Build the road network: each main base -> its FOB, and the two FOBs across.
// Render the designer's PAINTED roads (MAP_CFG.overrides.roads) with the game's own
// RoadTiles at the flat grade — same tiles/textures the map designer previews. Populates
// roadNet.cells so vehicles ride the road tops (roadDeckY), A* treats them as drivable,
// and foliage avoids them. No A* auto-routing on custom maps (the author drew the roads).
function buildConfigRoads() {
  const cells = (MAP_CFG && MAP_CFG.overrides && MAP_CFG.overrides.roads) || [];
  roadNet.tiles.clear();
  const p = map.params, beach = p.beachHeight || 1;
  const grade = p.flatLand ? beach + 0.8 : null;        // RoadTiles.tile() lifts the surface 0.06 above this
  const bridgeY = p.flatLand ? beach + 0.8 : beach + 0.5;
  const set = new Set(cells.map(([cx, cz]) => cx + ',' + cz));
  const has = (cx, cz) => set.has(cx + ',' + cz);
  const cellMap = new Map();
  for (const [cx, cz] of cells) {
    const wx = cx * grid.cell, wz = cz * grid.cell;
    const n = has(cx, cz - 1), s = has(cx, cz + 1), e = has(cx + 1, cz), w = has(cx - 1, cz);
    const y = grade != null ? grade : map.heightAt(wx, wz);
    if (!map.isLand(wx, wz)) roadNet.tiles.deck(wx, wz, Math.max(y, bridgeY), n, s, e, w);
    else roadNet.tiles.tile(wx, wz, y, n, s, e, w);
    cellMap.set(cx + ',' + cz, { i: cx, j: cz, y });
  }
  roadNet.cells = cellMap;
  if (!roadNet.group.parent) scene.add(roadNet.group);
}
function buildRoads() {
  if (configBases) { buildConfigRoads(); placeResupplies(); return; }   // custom map → the painted roads, not A* auto-routing
  const byTeam = {};
  for (const c of camps) (byTeam[c.team] ??= {})[c.role] = c;
  const conns = [];
  // Each connection uses its own nearest gate — a gate that gets a road KEEPS a road (gates
  // without one look wrong). The two roads leaving one camp then MERGE just outside because
  // ground costs 2 while an existing road costs 0.1 (see Roads._cost): the ~1.9/cell saving
  // beats the join overhead (turns + a couple of lateral cells) within a few cells, so A*
  // rides the shared trunk instead of laying a parallel twin (Jacob's design, seed 513445024).
  for (const t of ['red', 'blue']) {
    const m = byTeam[t] && byTeam[t].main, f = byTeam[t] && byTeam[t].fob;
    if (m && f) conns.push({ a: m.gates[0], b: nearestGate(f, m.center), y: m.center.y });
  }
  const rf = byTeam.red && byTeam.red.fob, bf = byTeam.blue && byTeam.blue.fob;
  if (rf && bf) conns.push({ a: nearestGate(rf, bf.center), b: nearestGate(bf, rf.center), y: rf.center.y });
  roadNet.setObstacles(camps);
  roadNet.build(conns);
  if (!roadNet.group.parent) scene.add(roadNet.group);
  placeResupplies();   // AFTER roads exist so supply sites can actually see + avoid them (was placed during placeCamps, before any road)
}

const CAMP_SIZE = 9;   // main base: ODD cells per side (3-cell gate centres on a cell)
const FOB_SIZE = 5;    // forward operating base: smaller, holds the elevator

// Pad descriptor (flat dry foundation) for a camp of `size` cells at a site.
function padFor(site, size) {
  const rInner = (size / 2) * grid.cell + grid.cell * 0.6;
  const rOuter = rInner + grid.cell * 2.5;
  return { x: site.x, z: site.z, rInner, rOuter, height: Math.max(site.y, map.params.beachHeight + 0.8) };
}

function placeCamps() {
  configBases = false;   // procedural map → full procgen forts + roads
  for (const w of placedWalls) scene.remove(w.group);
  placedWalls = [];
  resetWallInstances();   // hand every instanced-segment slot back for the new layout
  for (const c of camps) scene.remove(c.group);
  for (const e of elevators) { if (e._snd) { e._snd.stop(); e._snd = null; } scene.remove(e.group); if (e.rider) scene.remove(e.rider.group); e.dispose(); }
  camps = [];
  elevators = [];
  destructibles = new DestructibleManager();

  const origin = new THREE.Vector3();
  const teams = ['red', 'blue'];
  const items = [];   // { site, size, role, team }
  const pads = [];

  const mainSites = map.findCampSites(2);
  mainSites.forEach((mainSite, i) => {
    const mainPad = padFor(mainSite, CAMP_SIZE);
    items.push({ site: mainSite, size: CAMP_SIZE, role: 'main', team: teams[i] });
    pads.push(mainPad);

    // FOB sits forward of the main base (slightly toward centre) and offset well to
    // the SIDE (perpendicular) — opposite teams' perpendiculars point opposite ways,
    // so the two FOBs diverge instead of converging on the map centre. Sidestep is
    // pulled in until it lands on dry ground.
    const toCenter = origin.clone().sub(mainSite).setY(0);
    if (toCenter.lengthSq() < 1e-3) toCenter.set(1, 0, 0);
    toCenter.normalize();
    const perp = new THREE.Vector3(-toCenter.z, 0, toCenter.x);   // +90° about Y (flips per opposite team)
    const fobPadR = (FOB_SIZE / 2) * grid.cell + grid.cell * 0.6 + grid.cell * 2.5;
    const forward = mainPad.rOuter + fobPadR + 8;
    const span = Math.min(map.worldW, map.worldH);
    let fobSite = mainSite.clone().addScaledVector(toCenter, forward);   // fallback: inline
    for (const side of [span * 0.24, span * 0.18, span * 0.12]) {
      const cand = mainSite.clone().addScaledVector(toCenter, forward).addScaledVector(perp, side);
      if (map.isLand(cand.x, cand.z)) { fobSite = cand; break; }
    }
    fobSite.y = map.heightAt(fobSite.x, fobSite.z);
    const fobItem = { site: fobSite, size: FOB_SIZE, role: 'fob', team: teams[i] };
    items.push(fobItem);
    pads.push(padFor(fobSite, FOB_SIZE));
    // ?units=N: SATELLITE deploy pads just outside the FOB ring (the 25u courtyard only
    // fits the one lift) — each extra elevator fields one more simultaneous unit
    // (AICommander.unitCap counts them). Flank the compound perpendicular to its facing,
    // rear as the fallback; a direction in the water is skipped, so a cramped shoreline
    // FOB just supports fewer lifts (the cap follows what actually got built).
    if (UNITS_PER_TEAM > 1) {
      // SATELLITE PADS spread across the team's SIDE of the island — separate forward
      // spawn points, not lifts squished against the FOB (Jacob: "smart places on that
      // side of the map"). Candidates ring the FOB at 45-90u; each must be dry (pad
      // corners too), solidly on OUR side (closer to our main than theirs), and clear of
      // both bases. Greedy pick maximizes the spread (min distance to everything already
      // placed), so two pads cover different flanks instead of stacking.
      const enemyMain = mainSites[1 - i] || origin;
      const anchors = [fobSite, mainSite];                    // keep-clear + spread anchors
      fobItem.satSites = [];
      for (let k = UNITS_PER_TEAM - 1; k > 0; k--) {
        let best = null, bestScore = -Infinity;
        for (let r = 45; r <= 90; r += 15) {
          for (let a = 0; a < 24; a++) {
            const th = a * Math.PI / 12;
            const x = fobSite.x + Math.sin(th) * r, z = fobSite.z + Math.cos(th) * r;
            if (!map.isLand(x, z)) continue;
            let dry = true;                                    // whole pad on land, not a beach lip
            for (const [ox, oz] of [[7, 7], [7, -7], [-7, 7], [-7, -7]]) if (!map.isLand(x + ox, z + oz)) { dry = false; break; }
            if (!dry) continue;
            const dOwn = (x - mainSite.x) ** 2 + (z - mainSite.z) ** 2;
            const dEnemy = (x - enemyMain.x) ** 2 + (z - enemyMain.z) ** 2;
            if (dOwn > dEnemy * 0.64) continue;                // our side of the map, with margin (0.8²)
            if (dOwn < 40 * 40) continue;                      // outside the main base's footprint
            let spread = Infinity;                             // min distance to bases + already-picked pads
            for (const s of [...anchors, ...fobItem.satSites]) spread = Math.min(spread, (x - s.x) ** 2 + (z - s.z) ** 2);
            if (spread < 34 * 34) continue;                    // never crowd anything
            if (spread > bestScore) { bestScore = spread; best = { x, z }; }
          }
        }
        if (!best) break;                                      // cramped island — fewer pads, cap follows
        const c = grid.worldToCell(best.x, best.z);            // snap to the build grid like the camps
        const sv = grid.cellToWorld(c.cx, c.cz);
        fobItem.satSites.push(sv);
        pads.push(padFor(sv, 3));                              // flatten a small pad of its own
      }
    }
  });

  map.flattenPads(pads);

  for (const it of items) {
    const cell = grid.worldToCell(it.site.x, it.site.z);
    const groundY = map.heightAt(it.site.x, it.site.z);   // flattened pad height
    // ?fobwalls=0 → FOBs go up BARE (no ring/gates/towers; the lift shield is the anti-camp)
    const c = new Camp(grid, cell, it.size, it.team, destructibles, groundY, it.role, { bare: it.role === 'fob' && !FOB_WALLS });
    scene.add(c.group);
    camps.push(c);
  }
  wireSoldiers();
  scene.updateMatrixWorld(true);   // place groups in world space BEFORE measuring bounds
  destructibles.refreshAll();      // (else every worldCenter collapses near the origin)
  buildObstacles();

  // Animated surface lift at each FOB. Empty by default and parked flush at the
  // surface (so an idle FOB just reads as a pad); the PLAYER's lift gets a rider +
  // rise via deployToFOB. Centred on the camp's grid-SNAPPED centre, not the raw
  // site — the walls/gates snap to a cell, so the lift must too or it sits off to
  // one side and clips a gate road.
  items.forEach((it, i) => {
    if (it.role !== 'fob') return;
    const camp = camps[i];   // camps were pushed in items order
    const accent = TEAM_ACCENT[it.team] || '#c0392b';
    // Main lift in the courtyard first (slot 0 / the player ride), then any ?units=N
    // satellite pads outside the ring — per-team ORDER matters: slot i deploys on the
    // team's i-th elevator (see AICommander.deploy).
    const sites = [{ x: camp.center.x, z: camp.center.z }, ...(it.satSites || [])];
    for (const sc of sites) {
      const elev = new Elevator(map, { x: sc.x, z: sc.z }, accent);
      elev.team = it.team;     // so deploy can find the player's lift
      elev.phase = 'top';      // idle FOBs sit flush
      elev.lift.position.y = elev.groundY;
      scene.add(elev.group);
      elevators.push(elev);
    }
  });

  buildFlags();        // capturable flag at each main base
  // placeResupplies() moved to the END of buildRoads() — it must run AFTER roads exist so depot
  // sites can avoid them (they were landing on roads because roadNet was empty here).
  scatterScrap();      // salvage piles out toward the map rim (scouting reward)
  configureSubZone();   // arm the deep-water sub zone (the sub itself spawns on demand)
  resetRepairs();       // clear any repair crews + refill the jeep pools for the new match
}

// World site (with ground height) of a build cell.
function siteOfCell(cx, cz) {
  const w = grid.cellToWorld(cx, cz);
  const s = new THREE.Vector3(w.x, 0, w.z); s.y = map.heightAt(w.x, w.z); return s;
}
// PHASE 2 — build the bases from a DESIGNED map (MAP_CFG.overrides.assets) instead of
// procedural sites: each team's MAIN camp centres on its REAL flag HQ, its FOB on its
// placed elevator; the team's OTHER flag HQs (and any neutral ones) become identical-
// looking DECOY buildings with no capturable flag inside (a flagless HQ keeps which one
// is real a mystery). Reuses Camp/Elevator/buildFlags so the AI, capture, deploy, and
// win conditions work unchanged. Walls/towers/gates/roads placements are NOT consumed
// yet (the camp brings its own walls) — a later slice. Gated: only runs when a map has
// placed assets, so normal procedural play is untouched. Falls back if a base is missing.
function placeCampsFromConfig(assets) {
  const TEAMS = [['a', 'red'], ['b', 'blue']];
  const hqs = assets.filter(a => a.id === 'flagHQ');
  const elevs = assets.filter(a => a.id === 'elevator');
  const ok = TEAMS.every(([dt]) =>
    hqs.some(h => (h.team || 'neutral') === dt) && elevs.some(e => (e.team || 'neutral') === dt));
  if (!ok) { console.warn('mapcfg: each team needs a flag HQ + an elevator — falling back to procedural bases'); placeCamps(); return; }
  configBases = true;   // designed map → bare bases (no procgen wall ring / extra buildings / auto roads)

  for (const w of placedWalls) scene.remove(w.group);
  for (const c of camps) scene.remove(c.group);
  for (const e of elevators) { if (e._snd) { e._snd.stop(); e._snd = null; } scene.remove(e.group); if (e.rider) scene.remove(e.rider.group); e.dispose(); }
  for (const g of placedProps) scene.remove(g);
  for (const m of bloodMarks) scene.remove(m); bloodMarks = [];
  crushables = []; _crushBuilt = false;
  camps = []; elevators = []; placedWalls = []; placedProps = []; destructibles = new DestructibleManager();
  resetWallInstances();   // hand every instanced-segment slot back for the new layout

  const items = [];   // { cell, site, size, role, team }  (parallel to camps[])
  const pads = [];
  const decoys = [];  // { cx, cz, team }  (gameTeam or null)

  for (const [dt, gt] of TEAMS) {
    const teamHQs = hqs.filter(h => (h.team || 'neutral') === dt);
    const realHQ = teamHQs.find(h => h.real) || teamHQs[0];
    const site = siteOfCell(realHQ.cx, realHQ.cz);
    items.push({ cell: { cx: realHQ.cx, cz: realHQ.cz }, site, size: CAMP_SIZE, role: 'main', team: gt });
    pads.push(padFor(site, CAMP_SIZE));
    for (const h of teamHQs) if (h !== realHQ) decoys.push({ cx: h.cx, cz: h.cz, team: gt });

    const elev = elevs.find(e => (e.team || 'neutral') === dt);
    const fobSite = siteOfCell(elev.cx, elev.cz);
    items.push({ cell: { cx: elev.cx, cz: elev.cz }, site: fobSite, size: FOB_SIZE, role: 'fob', team: gt });
    pads.push(padFor(fobSite, FOB_SIZE));
  }
  for (const h of hqs.filter(h => (h.team || 'neutral') === 'neutral')) decoys.push({ cx: h.cx, cz: h.cz, team: null });

  map.flattenPads(pads);

  for (const it of items) {
    const groundY = map.heightAt(it.site.x, it.site.z);
    const c = new Camp(grid, it.cell, it.size, it.team, destructibles, groundY, it.role, { bare: true });
    scene.add(c.group); camps.push(c);
    wireSoldiers();
  }
  // Decoy HQs — same maker as the real one, registered as plain destructibles (no flag).
  for (const d of decoys) {
    const accentHex = d.team ? (TEAM_ACCENT[d.team] || '#8a8f8a') : '#8a8f8a';
    const g = makeFlagHQ(grid.cell, new THREE.Color(accentHex));
    const s = siteOfCell(d.cx, d.cz);
    g.position.set(s.x, map.heightAt(s.x, s.z), s.z);
    scene.add(g);
    applyStaging(g, 'flagHQ');
    destructibles.add(new Destructible(g, { type: 'structure', hp: 600, blocks: true, staged: true }));
  }
  // Placed fortifications: build the designer's wall/tower/gate placements as REAL combat
  // Wall pieces (HP + staged crumble + firing corner turrets), so you can fortify the real
  // base AND arm the decoys. id+rot → Wall type: tower=CORNER (turret), gate=GATE (span 3),
  // wall=NS/EW by rotation. (Orientation convention: rot 0/2 = EW run / drive-through Z;
  // rot 1/3 = NS run / drive-through X — flip here if a placement reads turned 90°.)
  const wallType = (id, rot) => {
    if (id === 'tower') return 'CORNER';
    const horiz = ((rot || 0) % 2) === 0;
    if (id === 'gate') return horiz ? 'GATE_EW' : 'GATE_NS';
    return horiz ? 'EW' : 'NS';
  };
  for (const a of assets) {
    if (a.id !== 'wall' && a.id !== 'tower' && a.id !== 'gate') continue;
    const s = siteOfCell(a.cx, a.cz);
    const dtm = a.team || 'neutral';
    const gameTeam = gameTeamOf(dtm);
    const w = new Wall({
      type: wallType(a.id, a.rot), world: new THREE.Vector3(s.x, map.heightAt(s.x, s.z), s.z),
      cell: grid.cell, team: gameTeam, accent: new THREE.Color(accentForCode(dtm)),
      manager: destructibles, span: a.id === 'gate' ? 3 : 1,
    });
    w._team = gameTeam;   // turret targeting (null = neutral, fires on everyone)
    scene.add(w.group); placedWalls.push(w);
  }
  // GENERIC STRUCTURES: everything else the designer placed (barracks, lookout, water
  // tower, containers, hedgehogs, …) — built from the shared manifest, exactly like the
  // decoy HQs: positioned, accent-tinted, staged, and registered as blocking destructibles.
  // Without this pass, only forts and supplies survived the trip from designer to game —
  // a map's whole interior silently vanished when played.
  for (const a of assets) {
    const entry = ASSETS_BY_ID[a.id];
    if (!entry || entry.category !== 'structure') continue;                      // specials/supplies handled above
    if (a.id === 'wall' || a.id === 'tower' || a.id === 'gate') continue;        // real combat Wall pieces, placed above
    if (a.id === 'jeep') {                                                        // team jeeps designate the functional motor pool (see buildMotorPool)
      const jt = gameTeamOf(a.team);
      if (jt) { const js = siteOfCell(a.cx, a.cz); placedJeeps[jt].push({ x: js.x, z: js.z, yaw: (a.rot || 0) * Math.PI / 2 }); continue; }
    }                                                                            // neutral jeeps fall through to a decorative prop
    const dtm = a.team || 'neutral';
    const g = entry.make(grid.cell, new THREE.Color(accentForCode(dtm)));
    g.userData.team = gameTeamOf(dtm);   // so the colour-lock can recolour its accent/camo mats
    const s2 = siteOfCell(a.cx, a.cz);
    g.position.set(s2.x, map.heightAt(s2.x, s2.z), s2.z);
    g.rotation.y = (a.rot || 0) * Math.PI / 2;
    scene.add(g);
    applyStaging(g, a.id);
    const pdest = new Destructible(g, { type: entry.destructible ? entry.destructible.type : 'building',
      hp: entry.destructible ? entry.destructible.hp : 100, blocks: true, staged: true });
    destructibles.add(pdest);
    if (a.id === 'tent') { g.userData.crushable = true; g.userData.crushDest = pdest; }   // squishable (see updateCrushables)
    placedProps.push(g);
  }
  scene.updateMatrixWorld(true);
  destructibles.refreshAll();
  buildObstacles();

  items.forEach((it, i) => {
    if (it.role !== 'fob') return;
    const camp = camps[i];
    const accent = TEAM_ACCENT[it.team] || '#c0392b';
    const elev = new Elevator(map, { x: camp.center.x, z: camp.center.z }, accent);
    elev.team = it.team; elev.phase = 'top'; elev.lift.position.y = elev.groundY;
    scene.add(elev.group); elevators.push(elev);
  });

  buildFlags();
  // placeResupplies() moved to the END of buildRoads() (runs after roads exist — see there).
  scatterScrap();
  configureSubZone();
  resetRepairs();
}
// Use the designed bases when a map carries placed assets; else procedural placement.
function placeCampsAuto() {
  placedJeeps = { red: [], blue: [] };   // cleared each build; refilled from the map's placed jeeps (if any)
  if (minefield) minefield.reset();   // clear any mines/pods from a prior match
  if (sensorNet) sensorNet.reset();
  resetGadgetStats();
  const assets = MAP_CFG && MAP_CFG.overrides && MAP_CFG.overrides.assets;
  if (assets && assets.length) placeCampsFromConfig(assets);
  else placeCamps();
}

// Foliage (procedural low-poly props; scattered on load and on every rebuild).
const foliage = new Foliage();
foliage.build();
let grassDensityMul = 1;   // RR.setGrassDensity — in-game tuning of how thick the grass scatters
function scatterFoliage() {
  if (!foliage.props) return;
  const sites = camps.map(c => ({ x: c.center.x, z: c.center.z }));
  // Keep trees off the roads (and one cell either side) so units aren't blocked on
  // their own lanes — the A* navigator treats roads as the cheap path.
  const c = grid.cell;
  const onRoad = (x, z) => {
    if (!roadNet.cells) return false;
    const ci = Math.round(x / c), cj = Math.round(z / c);
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++)
      if (roadNet.cells.has((ci + di) + ',' + (cj + dj))) return true;
    return false;
  };
  foliage.scatter(map, sites, { density: 1, avoid: onRoad, bladeMask: !QS.has('noblademask'), grassDensity: grassDensityMul });
  if (!foliage.group.parent) scene.add(foliage.group);
}

// (The ?grasstune in-game colour panel lived here. The grass look it was built to find is
// chosen and baked into Plants.js, so the panel and its live colour setters are gone. Density
// tuning stays on RR.setGrassDensity — that's a scatter knob, not a colour one.)

// --- Vehicles ----------------------------------------------------------
// The FOB elevator deck is a solid drivable surface at the FOB's ground height,
// even though the terrain underneath is a carved pit (or off-map ocean). Returns
// the elevator whose flush deck covers (x,z), else null.
function elevatorPadAt(x, z) {
  for (const e of elevators) {
    if (e.phase !== 'top') continue;   // only a flush deck is a surface
    const reach = e.padHalf + 1.2;
    if (Math.abs(x - e.center.x) <= reach && Math.abs(z - e.center.z) <= reach) return e;
  }
  return null;
}

// Road speed modifier for a vehicle at its CURRENT cell: ground units get ROAD_SPEED_MUL on a
// road tile (the highway is genuinely faster, not just cheaper to path), 1 elsewhere. Flyers
// don't ride roads, so they never get it. Fed to Vehicle.speedMul each frame before it drives.
function roadSpeedMul(v) {
  if (v._move && v._move.ignoreWalls) return 1;
  if (!roadNet.cells) return 1;
  const c = grid.cell;
  const cx = Math.round(v.holder.position.x / c), cz = Math.round(v.holder.position.z / c);
  return roadNet.cells.has(cx + ',' + cz) ? ROAD_SPEED_MUL : 1;
}

// A vehicle still riding a FOB lift UP the shaft hasn't surfaced yet — down in the pit
// it's out of sight, so it can't be SEEN, targeted or shot until its lift tops out. This
// stops a unit camping the enemy's elevator mouth and shelling riders before they rise.
function vehicleHidden(v) {
  for (const e of elevators) if (e.rider === v && e.phase !== 'top') return true;
  return false;
}

// ── SHADER-STUTTER FIX: hold the scene's point-light COUNT constant ────────────────
// Three.js bakes numPointLights into every lit material's shader — when the count
// changes, every lit material in view needs a brand-new program, compiled synchronously
// at first use (getProgramInfoLog). Vehicle glow lights come and go with every spawn/
// death/lift-ride, so early match walks through many counts = a compile storm (a phone
// trace showed 33% of a window blocked in getProgramInfoLog, with one 3.7s frame).
// PAD LIGHTS fill the gap to a fixed budget: intensity-0 lights parked under the map,
// toggled so (live vehicle lights + visible pads) === LIGHT_BUDGET, so the shader
// variant is compiled once and reused forever.
const LIGHT_BUDGET = 16;
let padLights = null;
function updatePadLights() {
  if (!padLights) {
    padLights = [];
    for (let i = 0; i < LIGHT_BUDGET; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 0.001);
      l.position.set(0, -500, 0);
      scene.add(l); padLights.push(l);
    }
  }
  let live = 0;
  for (const v of combatants) {
    if (v.dead || !v.group.visible || vehicleHidden(v)) continue;   // hidden subtree lights don't render
    v.group.traverse(o => { if (o.isPointLight && o.visible) live++; });
  }
  const pads = Math.max(0, LIGHT_BUDGET - live);
  for (let i = 0; i < padLights.length; i++) padLights[i].visible = i < pads;
}

// Ground height a vehicle should rest at (terrain + a small clearance; or the deck).
function vehicleGroundY(x, z) {
  const e = elevatorPadAt(x, z);
  return (e ? e.groundY : map.heightAt(x, z)) + 0.05;
}
const vehicles = [];          // ambient (non-player) vehicles, if any

// --- Combat: shooting, damage, movement traits, HP / fuel -------------
// Ported from the Vehicle Designer (muzzle flash + recoil + projectiles) and
// extended for the game: projectiles deal damage to walls, buildings, trees and
// vehicles; each vehicle type moves differently and carries HP + fuel.
const projectiles = new Projectiles(scene);
projectiles.missileScale = 3.4;   // Valkyrie missiles read tiny against the big world vehicles
const FIRE_INTERVALS = [0.32, 0.11, 1.05, 1.7];   // by soundIndex: Lurcher, Firebrat, Valkyrie, Jotun
const SHOT_DMG       = [35, 14, 90, 180];          // damage per hit
const SHOT_BLAST     = [1.2, 0.6, 4.5, 5.5];       // splash radius (laser/tracer tiny, missile/rail big)
// Effective projectile speed (u/s) for AI aim-leading, by soundIndex. Firebrat (1) is
// hitscan (0 = no lead). The Jotun (3) slug is a real 115 u/s round — its complication
// is the railgun CHARGE delay (below), not its speed. The missile (2) accelerates; ~32
// is roughly its average speed over a typical flight.
const PROJ_SPEED     = [85, 0, 32, 115];
// Extra fixed delay (s) between the AI deciding to fire and the round actually leaving the
// muzzle, by soundIndex — only the Jotun's railgun charges (setTimeout 900ms in fireVehicle).
// leadAim folds this into the flight time so the slug is aimed where the target WILL be when
// it finally discharges + flies there, not where it was when the gun started winding up.
const CHARGE_DELAY   = [0, 0, 0, 0.9];
// AI aim-leading strength: fraction of the predicted lead actually applied. Kept BELOW
// 1 on purpose — a perfect intercept gives a fleeing target no way out; this leads
// enough to connect on a straight runner but leaves room to juke (Jacob: "better, not
// perfect"). Per-shot personality jitter loosens it further.
const AIM_LEAD       = 0.7;
// How far off the hull's forward a vehicle can aim a shot — the half-angle of the
// firing cone. A reticle only appears (and a shot is valid) inside it. Per the
// design: the Firebrat is a fixed forward gun (tiny 5° cone), the Jotun's heavy
// turret covers 30°, the Lurcher's turret reaches ANY direction (but slews there
// over ~1s), and the Valkyrie locks anywhere in its front hemisphere.
const SHOT_ARC = {
  lurcher:  Math.PI,          // 360° — turret reaches all the way around (slew-limited)
  firebrat: Math.PI / 36,     // 5° — basically a fixed forward gun
  valkyrie: Math.PI / 2,      // front hemisphere for missile lock acquisition
  jotun:    Math.PI / 6,      // 30° — heavy turret; steer the hull for the rest
};
// Turret slew speed (rad/s) for player aim tracking. The Lurcher takes ~1s to
// swing to the opposite side (π rad ÷ π/s); the Jotun's small arc snaps quicker.
const TURRET_SLEW = { lurcher: Math.PI, jotun: Math.PI * 2.0 };
const JOTUN_AIR_MIN = 30;     // Jotun can only reach AIR targets beyond this range (or straight overhead)
// The Lurcher's guns lose punch at range; the Jotun's don't. Scales shot damage by
// distance to the target: full inside NEAR, falling to FAR_MULT past FAR.
const LURCHER_FALLOFF = { near: 22, far: 72, farMult: 0.42 };
// Per-type collision/target radius. The Firebrat is deliberately small so it slips
// between trees and is a harder target; the heavies are bulky.
const VEH_HIT_R = { lurcher: 3.2, firebrat: 2.0, valkyrie: 3.0, jotun: 3.6 };
// Preferred AI stand-off distance per type — how far out a unit holds while shooting
// so it fights from its strength instead of charging into a base's kill zone. The
// Jotun (no range falloff) snipes from beyond most of the wall-turrets' reach; the
// Firebrat has to close to use its short forward gun. Drives both duels and the
// turret-suppression standoff (see AI.js engage/suppress).
// How far a round ACTUALLY reaches (u) = tracer speed × life from Projectiles.js (idx L/F/V/J).
// The Lurcher slug dies at 85·0.5 ≈ 42, so firing from its old 50u engage range dropped every
// shot SHORT of the target — the "stuck plinking a shore tower just out of reach, reload, repeat"
// bug. A unit must be inside THIS to land a hit; the AI fire gate is capped by it (see AI.js
// combat). Firebrat = 40u hitscan laser; Jotun slug 115·0.7 ≈ 80; the Valkyrie's homing missile
// curves in so distance isn't its limiter (kept generous).
const SHOT_REACH = { lurcher: 42, firebrat: 40, valkyrie: 80, jotun: 80 };
// SIEGE TARGET PRIORITY (Jacob's design). Every enemy structure is a valid target and carries a
// score; the keep is the win condition so it sits highest by DEFAULT, and a tower that is
// actually shooting at us outranks it for as long as that is true. The old rule was a queue with
// the keep as a fallback — it could only ever be reached by running out of towers, which is how a
// Lurcher spent 650s grinding two turrets while an untouched 600hp HQ decided the match.
const PRIO = {
  hq: 10,        // the win condition: crack it and the flag is exposed
  tower: 6,      // dangerous, but only worth it when it is the thing hurting us
  wall: 2,       // low on its own — rises when it stands between us and something better
  inReach: 5,    // …and a gun we can shoot FROM HERE also outranks it (6+5 > 10) — see below
};
// WHY "IN REACH" AND NOT JUST "SHOOTING AT US" (Jacob: "shouldn't the keep have higher priority
// unless the tower is in range?"). The keep is the win condition so it stays the default pick —
// but a tower only outranked it while actively firing, which meant a quiet tower scored 6 against
// the keep's 10 and lost, forever. Seed 1095: a Lurcher spent 261 seconds on station with its gun
// aimed at a keep 170u away, behind a wall, with a 42u reach and its reload counter sitting at
// MINUS 22 SECONDS — ready, aimed at something it could never hit — while towers it kills in 3.2
// seconds each (35 damage a shell, 340hp, 0.32s reload) stood untouched 8u away.
// A target we can physically shoot right now beats one we cannot, whatever the win condition says;
// for a ground hull the keep is not a target at all until the fort comes down. "Can I hit it from
// here" is a fact rather than a spectrum, which is why this is a step and not a curve.
const INTERCEPT_GUN_CLEAR = 8;      // u of daylight past a tower's reach when picking the ambush spot
const INTERCEPT_PUSH_MAX = 140;     // u — furthest we walk outward looking for cover-free ground
const INTERCEPT_GATE_STANDOFF = 14; // u in front of the gate mouth once the front guns are down
// The Flee mission's route home (Commander.planFleeRoute). Wide enough that leg 1 genuinely
// breaks contact rather than brushing past — a Valkyrie spots a Firebrat out to 71u.
const FLEE_BREAK = 90;     // u square off the enemy→home line before turning for home
const FLEE_STAGE = 25;     // u beyond our own wall ring for the staging point behind the base
const FLEE_GATE_OUT = 8;   // u outside the gate mouth we aim at, so A* threads the throat
const FLEE_CORRIDOR = 45;  // u — a remembered contact has no chassis, so assume this much reach
const NERVE_FAR = 160;     // u from the flag at which a runner's nerve is 0; it rises to 1 on the flag
// Lurcher engage/hold pulled INSIDE its 42u reach (was 50/46) so it plants close enough to
// actually connect instead of raining rounds down short of the tower.
const ENGAGE_RANGE = { lurcher: 40, firebrat: 24, valkyrie: 50, jotun: 70 };
// Where a unit SITS to silence a wall-turret — the standoff is placed radially
// OUTSIDE the base through the target turret, so only that one turret bears on it
// (no crossfire from the others). The Jotun parks beyond TURRET_RANGE (54) so it
// out-snipes the tower untouched; the Valkyrie flies its arc in; the Lurcher (no
// fly, sinks in water) sits at the corner and busts that tower/wall the hard way.
const TURRET_HOLD = { jotun: 64, valkyrie: 46, lurcher: 38, firebrat: 26 };
let ROAD_SPEED_MUL = 1.25;   // ground vehicles drive this much faster on a road cell (RR.setRoadSpeed to tune)
let FLAG_GRAB_TURRETS = 2;   // max enemy turrets still standing when a runner may commit to the grab (A/B via RR.setFlagGrab)
const INTERCEPT_HOLD_R = 16;   // u — inside this of the camp we are STANDING IN THE DOOR: watch the lane home, and pursue is back on
const INTERCEPT_SWAP_R = 60;   // flag stolen: only recall home for a Valkyrie if a ground unit is within this of our FOB — else chase with what we've got
// ONE radius for "a rival is too close to go and change vehicles". The recall had two — 52u to
// refuse to start and 46u to give up once started — and the band between them was a place where a
// unit could arm a trip it would then abandon. Deferring now costs nothing (we simply carry on
// with the current mission and get asked again next change), so there is no second number.
const SWAP_DEFER_R = 52;
// Clearing a contact off a kill: matched to _noteContact's own 15u merge radius, because that is
// the distance at which the notebook already considers two sightings to be the same vehicle.
const CONTACT_CLEAR_R = 15;
let aiContactClear = !QS.has('nocontactclear');   // a destroyed vehicle stops blocking lanes (A/B: ?nocontactclear)
let GAMBIT_AFTER = 240;   // seconds of a stalemate (base untouched) before a commander abandons the mid-field grind and sends a Valkyrie around the back to crack the HQ (RR.setGambitAfter)
let aiKeepBreach = true;     // flatten the HQ early + let the runner grab with back towers up (A/B via RR.setKeepBreach); off = old all-towers-first siege
let aiTargetPrio = !QS.has('noprio');   // score siege targets (keep highest, a firing tower jumps) instead of walking a queue — RR.setTargetPrio
// A/B gates for this session's nav changes — default to the new behavior; ?no… reverts one for isolation.
let aiFobRearm = !QS.has('nofobrearm');    // re-arm the deterministic gate-exit for a grounder tangled at its own FOB
let aiFordHalo = !QS.has('nofordhalo');   // judge WATER clearance by the hull's own footing (1u) instead of its wall-clearance radius (3u)
let aiMineAvoid = !QS.has('nomineavoid'); // soft-steer AI ground units around mines their team has spotted
let aiSoftFord = QS.has('softford');       // revert A* ford check to the old loose 4-dir/0.85 margin

// ── DEEP LOG (RR.setDeepLog / ?deeplog) ──────────────────────────────────────────
// Raw console.log tracing for the decision points that turned out hardest to see from
// the outside tonight (the standoff picker, the HQ-promotion fallback, Defend's raw-
// coordinate objective) — every one of them silently swapped to older/unchecked logic
// with zero signal that it happened. Off by default (console spam nobody wants
// permanently); flip on with RR.setDeepLog(true) or load with ?deeplog when actually
// chasing something. dlog() logs on CHANGE or every ~3s heartbeat (so a value that's
// silently stuck — the actual bug shape tonight — still prints periodically instead of
// going quiet), keyed per call-site so different units/teams don't stomp each other.
let aiDeepLog = QS.has('deeplog');
if (aiDeepLog) setDeepLogStrategies(true);   // sync AIStrategies.js's copy of the flag when set via ?deeplog at load
const _dlogState = new Map();
function dlog(key, value, msg) {
  if (!aiDeepLog) return;
  const now = performance.now();
  const s = _dlogState.get(key);
  const snap = JSON.stringify(value);
  if (!s || s.snap !== snap || now - s.t > 3000) {
    console.log(`[DEEPLOG ${key}] ${msg}`, value);
    _dlogState.set(key, { snap, t: now });
  }
}
const CAPTURE_COMMIT = 85;   // within this of a grabbable flag, the runner beelines it and ignores turrets/fire (final-dash commit).
                             // MUST exceed the runnerFlee trip radius (60): a defender camping the exposed flag projects a 60u
                             // fear-ring, and with the commit at 55 the ring ENCLOSED the dash zone — the runner ping-ponged in
                             // the 60..100u shell forever, aborting the grab each lap ("Taking fire — breaking off toward
                             // snatching the flag" ×10+, seed 25's endless endgame). Commit outside the fear ring: grab or die
                             // trying — either resolves the match, and the defender/intercept play is the counter, not the dance.

// Movement personality per type. cruise = rest altitude above the surface;
// ignoreWalls = flies over base walls; water = 'cross' (hover/fly) or 'sink'
// (land vehicle floods + drowns); tree = 'crush' | 'bump' (collide+chip) | 'fly'.
const VEH_MOVE = {
  // strafe: chassis can slide sideways at all; omni: full any-direction translation (nav
  // uses it too — locomote decomposes motion instead of nose-first steering).
  lurcher:  { cruise: 0,   ignoreWalls: false, water: 'sink',  tree: 'crush', strafe: true,  omni: true  },   // six legs step ANY direction
  firebrat: { cruise: 2.4, ignoreWalls: false, water: 'cross', tree: 'bump',  strafe: true,  omni: false },   // hover — can slide
  valkyrie: { cruise: 7.5, ignoreWalls: true,  water: 'cross', tree: 'fly',   strafe: true,  omni: false },   // flies
  jotun:    { cruise: 0,   ignoreWalls: false, water: 'sink',  tree: 'crush', strafe: false, omni: false },   // TREADS — nose-first only (it was sidestepping in combat: the unblock reflex never checked the chassis)
};
// A "sinker" proxy for snapping an AI route point onto reachable LAND (water + walls both
// count as blocked). Used where a route must stay on the ground even for a unit that can
// itself cross water — e.g. a Firebrat's sap flank, which has to be MINABLE ground, not
// open ocean (else the sortie drives out over the water and idles there). `.team` is set
// per-use so the gate check reads right.
const LAND_SNAP = { _move: { water: 'sink', ignoreWalls: false, tree: 'bump' }, team: null, holder: { position: { x: 0, z: 0 } } };
// Durability + thirst. burn = fuel/sec at full throttle (idle sips 25%).
// ammo = shots carried (fast guns carry more, heavy hitters few); shield = the
// MAX armour pool a shield-generator pickup can give this vehicle (starts at 0).
const VEH_STATS = {
  lurcher:  { hp: 220, fuel: 200, burn: 2.4, ammo: 68, shield: 110 },
  firebrat: { hp: 90,  fuel: 200, burn: 3.0, ammo: 90, shield: 45  },
  valkyrie: { hp: 190, fuel: 260, burn: 4.2, ammo: 12, shield: 75  },   // 190 (was 140) so it survives ONE Jotun slug (flat 180 to vehicles)
  jotun:    { hp: 320, fuel: 200, burn: 2.0, ammo: 16, shield: 160 },
};
const SINK_RATE = 1.2;     // units/sec a land vehicle floods when over water
const SINK_KILL = 2.5;     // depth at which it's fully submerged → destroyed
const WADE_MIN = 0.25;     // fording draft below the waterline AT the shore (just dips in)
const WADE_MAX = 1.6;      // draft in the deepest fordable water (mostly under, top still shows);
                           // the opaque water-coloured terrain hides the submerged hull
const TREE_BUMP_DMG = 12;  // HP a light vehicle loses ramming a palm

let fireCooldown = 0;
let fireHeld = false;          // SPACE / on-screen fire button held
let playerColorIndex = 4;      // team colour index for the player's projectile tint
const combatants = [];         // every live, damageable Vehicle (player + AI)
const vehShadows = new THREE.Group(); scene.add(vehShadows);   // ground-projected vehicle silhouette shadows
// Drape each vehicle's baked silhouette shadow flat on the terrain beneath it, turned to
// its heading and faded/shrunk a little with altitude (flyers cast a fainter, lower shadow).
// Types that WALK (the Lurcher's striding legs): a frozen leg-shaped silhouette looks
// wrong dragged along, so these get a soft round blob instead — reads as a shadow
// without pinning a static leg pose under a moving vehicle.
const WALKER_SHADOW = new Set(['lurcher']);
// Per-vehicle shadow tweaks: hide (Jotun rides the ground + its turret shadow can't rotate),
// scale (footprint multiplier), dark (opacity multiplier).
const SHADOW_CFG = { jotun: { hide: true }, lurcher: { scale: 0.5, dark: 1.5 } };
// How far into its own footprint a shadow looks for the ground it has to clear. Deliberately not
// the full half-width: the decal is a SQUARE of the model's LONGEST side, so a long hull leaves
// the corners fully transparent, and hunting for high ground out there would lift the shadow clear
// of terrain that nothing is actually drawn over.
const SHADOW_REACH = 0.6;
// …and the ceiling on that lift. A flat quad on a steep enough slope cannot both clear the uphill
// side and stay in contact with the downhill one; past this, floating reads worse than clipping.
const SHADOW_LIFT_MAX = 1.0;
function updateShadows() {
  for (const v of combatants) {
    if (!v.model) continue;
    const cfg = SHADOW_CFG[v.type];
    if (cfg && cfg.hide) { if (v._shadow) v._shadow.visible = false; continue; }   // e.g. Jotun: no ground shadow
    if (!v._shadow) {
      if (WALKER_SHADOW.has(v.type)) {
        const rec = vehicleSilhouette(renderer, v.type, v.model.group);   // cached; used only for footprint size
        v._shadowR = rec.size * 0.5;                                       // blob radius ≈ footprint
        v._shadow = makeBlobShadow(v._shadowR, true);                      // clone material so we can fade per-frame
      } else {
        const rec = vehicleSilhouette(renderer, v.type, v.model.group);
        v._shadowSize = rec.size;                                          // world side of the decal at scale 1
        v._shadow = makeVehicleShadow(rec);
      }
      vehShadows.add(v._shadow);
    }
    const s = v._shadow;
    if (v.dead || vehicleHidden(v)) { s.visible = false; continue; }   // no shadow while dead OR still rising up the lift shaft
    const x = v.holder.position.x, z = v.holder.position.z;
    const roadY = roadDeckY(x, z);                       // on a raised road slab? drape on its top, not the terrain below it
    const gy = roadY != null ? roadY : map.heightAt(x, z);
    const alt = Math.max(0, v.holder.position.y - gy);
    const f = 1 / (1 + alt * 0.14);   // 1 on the ground → fainter/smaller as it climbs
    s.visible = true;
    s.rotation.y = v.holder.rotation.y;
    const scl = cfg && cfg.scale ? cfg.scale : 1;
    let ext;                                             // world half-width of the decal THIS frame
    if (v._shadowR) { const d = v._shadowR * 2 * (0.7 + 0.3 * f) * scl; s.scale.set(d, 1, d); ext = d * 0.5; }
    else { const k = (0.7 + 0.3 * f) * scl; s.scale.setScalar(k); ext = (v._shadowSize || 0) * k * 0.5; }
    // SIT ON THE HIGHEST GROUND THE DECAL COVERS, not on the ground under its centre. A fixed nudge
    // off the centre (what this used to do) can't work: the gap the uphill half has to clear scales
    // with the decal's own width, which is why the two WIDEST silhouettes — Valkyrie and Firebrat —
    // were the two that kept sinking into slopes. A road slab is flat, so there it's just the deck.
    const lift = roadY != null ? 0
      : Math.min(SHADOW_LIFT_MAX, Math.max(0, map.surfaceTopAt(x, z, ext * SHADOW_REACH) - gy));
    s.position.set(x, gy + lift + 0.12, z);
    s.material.opacity = Math.min(1, 0.5 * f * (cfg && cfg.dark ? cfg.dark : 1));
  }
}
const fx = [];                 // transient hit sparks / explosions ({obj,life,update})
const _muzzleWorld = new THREE.Vector3();
const _fireDir = new THREE.Vector3();
const _aimDir = new THREE.Vector3();
const _gunQuat = new THREE.Quaternion();
const wrapPi = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };

// Aim a vehicle at a world point: swing its turret (Jotun/Lurcher) toward the
// target, clamped to the type's SHOT_ARC off the hull forward, and return the
// horizontal fire direction at that (clamped) yaw. Non-turret types just get the
// clamped direction (the body doesn't turn). Holds the aim briefly (decayAim).
function aimDir(veh, targetPoint) {
  const hp = veh.holder.position;
  const aimAng = Math.atan2(-(targetPoint.x - hp.x), -(targetPoint.z - hp.z));   // world yaw of the target dir
  const arc = SHOT_ARC[veh.type] ?? Math.PI / 5;
  const rel = Math.max(-arc, Math.min(arc, wrapPi(aimAng - veh.heading)));
  // Hold the bearing well past the fire cadence (~2s) so the turret STAYS trained on the
  // threat between shots — at 1.4s it started easing home after every round and then had
  // to swing back out for the next one, which read as an erratic flick (the model slews
  // the visual turret at a fixed rate; this only sets where it's heading).
  if (veh.model && veh.model.turretGroup) { veh.model.autoScan = false; veh.model.aimYaw = rel; veh._aimHold = 4.0; }
  const ang = veh.heading + rel;
  return _aimDir.set(-Math.sin(ang), 0, -Math.cos(ang)).normalize();
}
// The actual 3D fire direction toward a target: horizontal yaw clamped to the
// vehicle's arc (off the hull forward), but the VERTICAL pitch aimed straight at
// the target — so a Firebrat/AI can hit a flying Valkyrie instead of shooting flat
// underneath it. Swings the turret for AI turreted shooters (the player's turret
// is already tracked by aimPlayerTurret, so leave it alone).
function aimFireDir(veh, targetPoint, mpos) {
  const to = _vtmp.copy(targetPoint).sub(mpos);
  const horiz = Math.hypot(to.x, to.z) || 1e-3;
  const pitch = Math.atan2(to.y, horiz);                       // vertical aim, kept as-is
  const arc = SHOT_ARC[veh.type] ?? Math.PI / 5;
  const rel = Math.max(-arc, Math.min(arc, wrapPi(Math.atan2(-to.x, -to.z) - veh.heading)));
  if (veh !== player && veh.model && veh.model.turretGroup) { veh.model.autoScan = false; veh.model.aimYaw = rel; veh._aimHold = 4.0; }   // long hold — stay trained between shots (see aimDir)
  const yaw = veh.heading + rel, cy = Math.cos(pitch);
  return _aimDir.set(-Math.sin(yaw) * cy, Math.sin(pitch), -Math.cos(yaw) * cy).normalize();
}
// Let a held turret aim ease back to forward once the shot's hold has elapsed.
// (AI uses this; the player turret is driven continuously by aimPlayerTurret.)
function decayAim(veh, dt) {
  if (veh._aimHold > 0) { veh._aimHold -= dt; if (veh._aimHold <= 0 && veh.model) veh.model.aimYaw = 0; }
}

// Continuously swing the player's turret toward the aim cursor while driving — the
// gun FOLLOWS the mouse instead of snapping on-fire then drifting back (which read
// as idle sway). Clamped to the type's arc; slewed at TURRET_SLEW so the Lurcher
// takes ~1s to cross. Sets veh._turretRel (current yaw off hull) + veh._aligned
// (turret is on-target, so a shot connects). No turret (Firebrat/Valkyrie) = no-op.
function aimPlayerTurret(veh, dt) {
  if (!veh || !veh.model || !veh.model.turretGroup) return;
  const slew = (TURRET_SLEW[veh.type] ?? Math.PI) * dt;
  let desired;
  if (_aimPoint) {
    const hp = veh.holder.position;
    const ang = Math.atan2(-(_aimPoint.x - hp.x), -(_aimPoint.z - hp.z));
    const arc = SHOT_ARC[veh.type] ?? Math.PI;
    desired = Math.max(-arc, Math.min(arc, wrapPi(ang - veh.heading)));
  } else {
    desired = veh.model.aimYaw || 0;   // no active aim (touch thumb lifted / cursor off-field) → HOLD the last-pointed direction, don't drift back to forward
  }
  const cur = veh.model.aimYaw || 0;
  let d = wrapPi(desired - cur);
  d = Math.max(-slew, Math.min(slew, d));
  // Keep the accumulated aim WRAPPED: circling the cursor used to wind aimYaw up past ±π
  // (…2π, 3π…), and anything comparing/easing against it numerically then unwound with a
  // full-circle spin — the "turret prefers one side" look. Wrapped + the models' own
  // shortest-path slew, there's no winding to unwind.
  veh.model.aimYaw = wrapPi(cur + d);
  veh.model.autoScan = false;
  veh._turretRel = veh.model.aimYaw;
  veh._aligned = Math.abs(wrapPi(desired - veh.model.aimYaw)) < 0.06;
}
const _vtmp = new THREE.Vector3();

// Outfit a freshly-built Vehicle for combat: team, HP, fuel, movement traits, a
// floating health bar (enemies) and registration for damage. Returns the vehicle.
function initCombatant(veh, team, colorIndex, isPlayer) {
  const st = VEH_STATS[veh.type] || VEH_STATS.lurcher;
  veh.team = team;
  veh.colorIndex = colorIndex;
  veh.maxHp = st.hp; veh.hp = st.hp;
  veh.maxFuel = st.fuel; veh.fuel = st.fuel;
  veh.burn = st.burn;
  veh.maxAmmo = st.ammo; veh.ammo = st.ammo;
  veh._ammoAcc = 0;                 // fractional rearm accumulator
  veh.maxShield = st.shield; veh.shield = 0;   // armour pool, picked up at a generator
  veh._shieldFx = null;             // force-field bubble, created on first pickup
  veh._move = VEH_MOVE[veh.type] || VEH_MOVE.lurcher;
  veh._blocked = blockedFor(veh._move, !isPlayer, veh.team);   // AI paths around water; player may dive in
  veh._sink = 0;
  veh.hitR = VEH_HIT_R[veh.type] ?? 3.2;   // Firebrat is small + nimble; heavies are big targets
  veh.dead = false;
  veh.cooldown = 0;
  veh.isPlayer = !!isPlayer;
  veh._throttle = 0;
  veh._aimHold = 0;
  if (veh.model) { veh.model.autoScan = false; veh.model.aimYaw = 0; }   // controlled → face forward, not idle-sweep
  veh._engineId = null;   // assigned lazily by updateEngineSounds (non-player)
  if (!isPlayer) veh.bar = makeHealthBar(veh);   // enemies show a floating bar; player uses the HUD
  // PROMOTIONS: this type's individual keeps its rank through the garage — restore banked stars.
  const bank = rankBankFor(veh);
  veh.rankKills = (bank && bank[veh.type]) || 0;
  if (veh.rankKills) { applyRankHp(veh); updateRankStars(veh); if (veh.bar) updateHealthBar(veh); }
  combatants.push(veh);
  return veh;
}

function removeCombatant(veh) {
  const i = combatants.indexOf(veh);
  if (i >= 0) combatants.splice(i, 1);
  if (veh.bar) { scene.remove(veh.bar.group); veh.bar = null; }
  if (veh._rankGrp) { scene.remove(veh._rankGrp); veh._rankGrp = null; veh._rankSpr = null; }
  if (veh._engineId != null && sound) { sound.dropSpatialEngine(veh._engineId); veh._engineId = null; }
  if (veh._shieldFx) { releaseFancyShield(veh); veh.holder.remove(veh._shieldFx); veh._shieldFx.geometry.dispose(); if (veh._shieldFx.userData.cheapMat) veh._shieldFx.userData.cheapMat.dispose(); veh._shieldFx = null; }
  if (veh._shadow) { vehShadows.remove(veh._shadow); veh._shadow.geometry.dispose(); veh._shadow.material.dispose(); veh._shadow = null; }
  if (veh._statusLight) {
    const L = veh._statusLight; veh.holder.remove(L.grp);
    L.bulb.geometry.dispose(); L.mat.dispose(); L.halomat.dispose();   // the halo TEXTURE is shared — never disposed here
    veh._statusLight = null;
  }
}

// Fire a vehicle's gun: sound (player only), muzzle flash + recoil, and a damaging
// projectile aimed down the gun/turret. cause-checked discharge for the railgun.
// Stamp each combatant's planar velocity (u/s) once per frame from its movement, so
// AI gunners can lead a moving target. Lightly smoothed so one jittery frame doesn't
// throw the aim off; the values are read a frame later, which is plenty fresh.
function trackVelocities(dt) {
  if (dt <= 0) return;
  for (const v of combatants) {
    const x = v.holder.position.x, z = v.holder.position.z;
    if (v._velPx != null) {
      const ax = (x - v._velPx) / dt, az = (z - v._velPz) / dt;
      v._vx = (v._vx || 0) * 0.6 + ax * 0.4;
      v._vz = (v._vz || 0) * 0.6 + az * 0.4;
    }
    v._velPx = x; v._velPz = z;
  }
}

// Predict where to aim so a shot meets a moving target. Solves the intercept time from
// the projectile's speed (a couple of iterations), then applies only AIM_LEAD of the
// predicted offset (plus the gunner's aim jitter) — good enough to punish a straight
// runner, loose enough to dodge. Hitscan / charge weapons (PROJ_SPEED 0) and stationary
// targets just aim at the current position. Returns a shared Vector3 — clone if kept.
const _leadV = new THREE.Vector3();
function leadAim(shooterPos, enemy, soundIndex, jitter = 0) {
  const sp = PROJ_SPEED[soundIndex] || 0;
  const vx = enemy.vx || 0, vz = enemy.vz || 0;
  if (sp <= 0 || (vx === 0 && vz === 0)) return _leadV.set(enemy.x, enemy.y, enemy.z);
  // Total time to impact = the gun's charge delay (Jotun railgun) + the round's flight time.
  // Seed the solve with the charge so the first flight-distance estimate already looks ahead.
  const charge = CHARGE_DELAY[soundIndex] || 0;
  let t = charge;
  for (let i = 0; i < 4; i++) {
    const ex = enemy.x + vx * t, ez = enemy.z + vz * t;
    t = charge + Math.hypot(ex - shooterPos.x, ez - shooterPos.z) / sp;
  }
  const lead = AIM_LEAD * (1 + (Math.random() - 0.5) * jitter);
  return _leadV.set(enemy.x + vx * t * lead, enemy.y, enemy.z + vz * t * lead);
}

function fireVehicle(veh, playSound, targetPoint = null, targetVeh = null, aimedAtEnemy = false) {
  if (!veh || veh.dead) return;
  if (veh.ammo <= 0) { if (veh.isPlayer) updatePlayerHud(); return; }   // dry — rearm at a depot/base
  veh.ammo -= 1;
  veh._shots = (veh._shots || 0) + 1;   // whole-life shot count — the DRY-TRIP alarm asks whether this unit ever fired
  veh._lastFireT = performance.now();   // Driver's nav-alarm watchdog: a real shot means "fighting", not "stuck"
  if (veh.isPlayer) updatePlayerHud();
  const idx = veh.def.soundIndex;
  if (playSound) { try { if (sound) sound.fireGun(); } catch (e) { /* best-effort */ } }
  // The player's turret is already tracking the cursor (aimPlayerTurret); only the
  // AI / non-turret shooters need aimDir to swing toward the target on trigger.
  const playerTurret = veh === player && veh.model && veh.model.turretGroup;
  if (targetPoint && !playerTurret) aimDir(veh, targetPoint);
  // A held green reticle on an enemy vehicle = a guaranteed hit for the turreted
  // guns (Lurcher fades with range, Jotun doesn't). The projectile becomes cosmetic.
  const guaranteed = veh === player && targetVeh && !targetVeh.dead && (idx === 0 || idx === 3);
  const discharge = () => {
    if (veh.dead) return;
    const muzzle = veh.fire ? veh.fire() : null;
    if (!muzzle) return;
    veh.group.updateMatrixWorld(true);
    const mpos = muzzle.getWorldPosition(_muzzleWorld);
    // Remote/AI shot → a positioned report so you HEAR enemies fire (player matches +
    // AI-vs-AI observation). The player's own gun already sounded via fireGun() above.
    if (!playSound && sound && sound.spatialReady) {
      try { sound.fireGunAt(idx, mpos.x, mpos.y, mpos.z); } catch (e) { /* best-effort */ }
    }
    emitSoundPing(mpos.x, mpos.y, mpos.z, idx, veh.team, veh.colorIndex);   // sound-awareness HUD: a loud, far-carrying gun report
    const aim = muzzle.parent || veh.group;
    const dir = _fireDir.set(0, 0, -1).applyQuaternion(aim.getWorldQuaternion(_gunQuat)).normalize();
    const hex = TEAM_COLORS[veh.colorIndex] ? TEAM_COLORS[veh.colorIndex].hex : 0xffffff;
    // Player Valkyrie with a lock: launch toward the locked point and home onto it.
    const guided = idx === 2 && veh === player && lock;
    if (guided) dir.copy(lock.point).sub(mpos).normalize();
    else if (targetPoint) dir.copy(aimFireDir(veh, targetPoint, mpos));   // 3D aim: clamp yaw to arc, keep pitch toward target
    if (guaranteed) {
      // Land the damage directly on the locked target; the slug is just a visual.
      const dist = targetVeh.holder.position.distanceTo(mpos);
      damageVehicle(targetVeh, SHOT_DMG[idx] * rangeFalloff(veh.type, dist) * rankDmgMul(veh), 'vehicle', veh);
      projectiles.spawn(idx, mpos, dir, hex);   // no dmg payload → updateProjectileHits ignores it
    } else if (idx === 1) {
      // Firebrat laser = hitscan: damage the first thing along the beam now.
      raycastDamage(mpos, dir, 40, SHOT_DMG[idx] * rankDmgMul(veh), SHOT_BLAST[idx], veh.team, veh);
      projectiles.spawn(idx, mpos, dir, hex);
    } else {
      projectiles.spawn(idx, mpos, dir, hex);
      const shot = projectiles.items[projectiles.items.length - 1];
      if (shot) {
        shot.dmg = SHOT_DMG[idx] * rankDmgMul(veh); shot.blast = SHOT_BLAST[idx]; shot.team = veh.team; shot.shooter = veh;   // gold stars sharpen the round
        shot.atVehicle = aimedAtEnemy;   // shot-feedback: was this round aimed at an enemy vehicle?
        // Home onto the locked target (live position) — but only if it's holdable;
        // a too-fast mover (red box) dumb-fires straight.
        if (guided && shot.setHoming && (lock.static || lock.locked)) {
          const fixed = lock.static ? lock.point.clone() : null;
          const tgt = lock.target;
          shot.setHoming(() => fixed || (tgt && !tgt.dead ? tgt.holder.position : null), MISSILE_TURN);
        }
      }
    }
  };
  // RAILGUN CHARGE — on the GAME clock, not setTimeout. A real timer never fires inside a
  // blocked headless-sim loop (the whole match runs in one evaluate), so every sim jotun shot
  // spent ammo, made the report sound, and discharged NOTHING: zero damage, zero shot-feedback,
  // whole matches of railgun blanks (the seed-25 "staring contest" and silently-nerfed jotuns
  // in every tournament). performance.now is the sim clock headless, real time live — one path.
  if (idx === 3) _chargedShots.push({ at: performance.now() + 900, fn: discharge });
  else discharge();
  veh.cooldown = FIRE_INTERVALS[idx] || 0.3;
}
// Pending charged discharges (see above) — ticked from updateProjectileHits so every loop
// (live animate, RR.stepField, tickCombat) fires them at the right game time.
const _chargedShots = [];
function tickChargedShots() {
  if (!_chargedShots.length) return;
  const now = performance.now();
  for (let i = _chargedShots.length - 1; i >= 0; i--) {
    if (now >= _chargedShots[i].at) { const c = _chargedShots.splice(i, 1)[0]; c.fn(); }
  }
}

// Nearest enemy inside the player's forward gun arc (+ range). Gives the fixed-gun Firebrat
// a way to hit ELEVATED targets: firing AT the vehicle's position pitches the beam up, so a
// player who points the nose at a swooping Valkyrie auto-elevates onto it (no manual pitch).
function acquireForwardTarget() {
  if (!player || player.dead) return null;
  const hp = player.holder.position;
  const arc = SHOT_ARC[player.type] ?? Math.PI / 5;
  let best = null, bestErr = arc + 1e-3;
  for (const v of combatants) {
    if (v.dead || v === player || v.team === player.team || vehicleHidden(v)) continue;
    const dx = v.holder.position.x - hp.x, dz = v.holder.position.z - hp.z;
    if (dx * dx + dz * dz > ASSIST_RANGE * ASSIST_RANGE) continue;
    const err = Math.abs(wrapPi(Math.atan2(-dx, -dz) - player.heading));   // off the gun centreline
    if (err < bestErr) { bestErr = err; best = v; }                         // most-centred target wins
  }
  return best;
}

// Player convenience wrapper (cadence handled by driveUpdate's fireHeld loop).
// Fires at the aim crosshair if the cursor's over the field, else straight ahead.
function firePlayer() {
  if (!player || player.dead) return;
  if (playerIsValkyrie()) { fireVehicle(player, true, null); fireCooldown = player.cooldown; return; }
  // Firebrat has a fixed forward gun — clicking fires straight ahead (no crosshair gating).
  // But if an enemy sits in the forward arc, fire AT it so the beam auto-pitches onto it —
  // the only way to hit a Valkyrie overhead. Touch routes through the aim stick (touchAiming).
  if (player.type === 'firebrat' && !touchAiming) {
    const tgt = acquireForwardTarget();
    if (tgt) fireVehicle(player, true, tgt.holder.position.clone(), tgt, true);
    else fireVehicle(player, true, null);
    fireCooldown = player.cooldown;
    return;
  }
  if (_cursor || touchAiming) {
    // Mouse / aim-stick: only spend a shot when there's a valid firing solution. On touch
    // updateTouchAim sets _aimPoint (+ _aimTargetVeh from aim-assist) and _aimValid.
    if (!_aimValid) return;
    fireVehicle(player, true, _aimPoint, _aimTargetVeh, !!_aimTargetVeh);
  } else {
    fireVehicle(player, true, null);   // no cursor / no aim → fire straight forward
  }
  fireCooldown = player.cooldown;
}

// Lurcher guns fade with range; the Jotun's railgun doesn't. dist = muzzle→target.
function rangeFalloff(type, dist) {
  if (type !== 'lurcher') return 1;
  const { near, far, farMult } = LURCHER_FALLOFF;
  if (dist <= near) return 1;
  if (dist >= far) return farMult;
  return 1 - (1 - farMult) * (dist - near) / (far - near);
}

// --- Valkyrie missile lock-on -------------------------------------------------
// The Valkyrie fires STEERABLE missiles, so the player clicks/taps a target to
// lock it; missiles then home onto the locked point. A target moving faster than
// LOCK_MAX_SPEED (a Firebrat at full tilt) can't be held — the box goes red and
// the shot dumb-fires. Walls/ground are static so they always lock.
const LOCK_MAX_SPEED = 17;        // u/s; above this the lock won't hold (Firebrat tops ~20)
const MISSILE_TURN = 2.6;         // rad/s the missile can curve while homing
const _gp = new THREE.Vector3();
const _groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
let lock = null;                  // { target, point, static, locked, lastPos, speed }
let reticle = null;

function playerIsValkyrie() { return player && !player.dead && player.type === 'valkyrie'; }

function ensureReticle() {
  if (reticle) return reticle;
  const g = new THREE.Group();
  // four L-shaped corner brackets around a unit square (billboarded, scaled by range)
  const mat = new THREE.LineBasicMaterial({ color: 0x66ff88, transparent: true, opacity: 0.95, depthTest: false });
  const arm = 0.42, half = 1.0;
  const corners = [[-1, 1], [1, 1], [1, -1], [-1, -1]];
  for (const [sx, sy] of corners) {
    const pts = [
      new THREE.Vector3(sx * half - sx * arm, sy * half, 0),
      new THREE.Vector3(sx * half, sy * half, 0),
      new THREE.Vector3(sx * half, sy * half - sy * arm, 0),
    ];
    g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat));
  }
  g.renderOrder = 999;
  g.visible = false;
  reticle = g; reticle._mat = mat;
  scene.add(g);
  return g;
}

function setLock(target, point) {
  ensureReticle();
  if (!lock) lock = { target: null, point: new THREE.Vector3(), static: false, locked: true, lastPos: new THREE.Vector3(), speed: 0 };
  lock.target = target;
  lock.static = !target;
  if (target) { lock.point.copy(target.holder.position); lock.lastPos.copy(target.holder.position); lock.speed = 0; }
  else lock.point.copy(point);
  lock.locked = true;
  reticle.visible = true;
}

function clearLock() { lock = null; if (reticle) reticle.visible = false; }

// Raycast a screen point to a world target: prefer an enemy vehicle (returns the
// Vehicle), then a wall/building hit point, then the ground. Returns { veh, point }.
function pickWorldPoint(px, py) {
  const ndc = new THREE.Vector2((px / window.innerWidth) * 2 - 1, -(py / window.innerHeight) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  let best = null, bestAlong = Infinity;
  for (const v of combatants) {
    if (v.dead || v === player || (player && v.team === player.team) || vehicleHidden(v)) continue;
    const c = v.holder.position;
    if (ray.ray.distanceToPoint(c) < v.hitR + 2.5) {
      const along = ray.ray.origin.distanceToSquared(c);
      if (along < bestAlong) { bestAlong = along; best = v; }
    }
  }
  if (best) return { veh: best, point: best.holder.position.clone() };
  const hit = destructibles.pick(ray);
  if (hit) return { veh: null, point: hit.point.clone() };
  if (ray.ray.intersectPlane(_groundPlane, _gp)) {
    _gp.y = map.heightAt(_gp.x, _gp.z) + 0.5;
    return { veh: null, point: _gp.clone() };
  }
  return null;
}

// Valkyrie: a click LOCKS the target box (missiles then home). Prefer a vehicle.
function acquireLock(px, py) {
  if (!playerIsValkyrie()) return;
  const t = pickWorldPoint(px, py);
  if (!t) return;
  // Front-hemisphere only: the launcher can't lock something behind the hull.
  const hp = player.holder.position;
  const ang = Math.atan2(-(t.point.x - hp.x), -(t.point.z - hp.z));
  if (Math.abs(wrapPi(ang - player.heading)) > SHOT_ARC.valkyrie + 1e-3) return;
  setLock(t.veh, t.point);
}

// Every other vehicle: a click FIRES at that point (turret swings within its arc).
function fireAtPoint(px, py) {
  if (!player || player.dead || player.cooldown > 0) return;
  const t = pickWorldPoint(px, py);
  if (!t) return;
  fireVehicle(player, true, t.point);
  fireCooldown = player.cooldown;
}

// Cursor crosshair (desktop): follows the mouse over the field and shows where the
// shot will go — GREEN when the point is inside the vehicle's firing arc, AMBER
// when it's outside (the turret will clamp). Its world point feeds SPACE / the
// fire button too, so firing is reliable even if a click reads as an orbit drag.
let aimReticle = null, _cursor = null, _aimPoint = null, _aimValid = false, _aimTargetVeh = null;
function ensureAimReticle() {
  if (aimReticle) return aimReticle;
  const g = new THREE.Group();
  const mat = new THREE.LineBasicMaterial({ color: 0x66ff88, transparent: true, opacity: 0.9, depthTest: false });
  const ring = [];
  for (let i = 0; i <= 28; i++) { const a = i / 28 * Math.PI * 2; ring.push(new THREE.Vector3(Math.cos(a), Math.sin(a), 0)); }
  g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(ring), mat));
  const ticks = [[-1.5, 0, -0.6, 0], [0.6, 0, 1.5, 0], [0, -1.5, 0, -0.6], [0, 0.6, 0, 1.5]];
  for (const [x1, y1, x2, y2] of ticks)
    g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(x1, y1, 0), new THREE.Vector3(x2, y2, 0)]), mat));
  g.renderOrder = 998; g.visible = false;
  aimReticle = g; aimReticle._mat = mat;
  scene.add(g);
  return g;
}
function updateAimReticle() {
  // On touch the aim stick owns _aimPoint (set in updateTouchAim, earlier this frame) —
  // leave it be and hide the desktop crosshair.
  if (touchAiming) { if (aimReticle) aimReticle.visible = false; return; }
  _aimPoint = null; _aimValid = false; _aimTargetVeh = null;
  // Firebrat fires straight forward and just clicks to shoot, so it gets no crosshair
  // helper — having it follow the mouse all the time was more clutter than aid.
  if (!onField || !player || player.dead || playerIsValkyrie() || player.type === 'firebrat' || !_cursor) { if (aimReticle) aimReticle.visible = false; return; }
  const t = pickWorldPoint(_cursor.x, _cursor.y);
  if (!t) { if (aimReticle) aimReticle.visible = false; return; }
  ensureAimReticle();
  _aimPoint = t.point; _aimTargetVeh = t.veh;
  const hp = player.holder.position;
  const aimAng = Math.atan2(-(t.point.x - hp.x), -(t.point.z - hp.z));
  const rel = Math.abs(wrapPi(aimAng - player.heading));
  const arc = SHOT_ARC[player.type] ?? Math.PI / 5;
  const horiz = Math.hypot(t.point.x - hp.x, t.point.z - hp.z);
  const isAir = t.point.y > map.heightAt(t.point.x, t.point.z) + 4;   // elevated target (flyer)

  // Per-type rules for when a shot is VALID (reticle shows green / fire connects).
  let valid = false, slewing = false;
  if (player.type === 'firebrat') {
    valid = rel <= arc + 1e-3;                          // fixed 5° forward gun
  } else if (player.type === 'jotun') {
    const inArc = rel <= arc + 1e-3;                    // 30° heavy turret
    valid = inArc && (!isAir || horiz >= JOTUN_AIR_MIN); // air targets only beyond min range / overhead
  } else { // lurcher — reaches any direction, but only HITS once the turret catches up
    valid = !!player._aligned;
    slewing = !valid;                                  // gun still swinging toward the point
  }
  _aimValid = valid;

  // Firebrat/Jotun: hide the reticle entirely when there's no solution. Lurcher:
  // keep it visible while the turret slews (amber), green once it's on-target.
  if (!valid && !slewing) { aimReticle.visible = false; return; }
  aimReticle.visible = true;
  aimReticle.position.copy(t.point);
  aimReticle.quaternion.copy(camera.quaternion);
  aimReticle.scale.setScalar(Math.max(0.8, camera.position.distanceTo(t.point) * 0.03));
  aimReticle._mat.color.setHex(valid ? 0x66ff88 : 0xffb030);   // green = will hit, amber = turret turning
}

// Track the locked target, measure its speed, and position/colour the box.
function updateLock(dt) {
  if (!lock) return;
  if (!playerIsValkyrie()) { clearLock(); return; }
  if (lock.target) {
    if (lock.target.dead) { clearLock(); return; }
    const pos = lock.target.holder.position;
    lock.speed = pos.distanceTo(lock.lastPos) / Math.max(dt, 1e-3);
    lock.lastPos.copy(pos);
    lock.point.copy(pos);
    lock.locked = lock.speed <= LOCK_MAX_SPEED;
  } else {
    lock.locked = true;        // static point — always holdable
  }
  reticle.position.copy(lock.point);
  reticle.quaternion.copy(camera.quaternion);
  reticle.scale.setScalar(Math.max(0.7, camera.position.distanceTo(lock.point) * 0.05));
  reticle._mat.color.setHex(lock.locked ? 0x66ff88 : 0xff5a5a);
  reticle.visible = lock.locked || (Math.floor(performance.now() / 130) % 2 === 0);   // blink when no-lock
}

// Apply blast damage at a world point to walls/buildings, trees, and vehicles.
// Returns true if the blast actually damaged an enemy vehicle (direct or splash) — the
// caller uses this to tell a clean hit from a shot that detonated on terrain/cover.
// Our shot landed near a wall — if that wall's gun is now down, the team that fired KNOWS it.
// Updates only the firing team's memory (the other side still has to observe it), so the
// fog-of-war rule holds: you learn what you did, not what happened.
function noteTowerKillsNear(point, blast, team) {
  const cm = commanders.find(c => c.team === team);
  if (!cm || !cm.knownTowers) return;
  const r = blast + 6;
  for (const [wall, rec] of cm.knownTowers) {
    if (!rec.armed || !wall.turret) continue;
    const dx = wall.group.position.x - point.x, dz = wall.group.position.z - point.z;
    if (dx * dx + dz * dz > r * r) continue;
    if (wall.turret.dead || wall.turret.falling) {
      rec.armed = false; rec.seenT = cm._matchT;
      if (cm._siegePlan) { cm._siegePlan.spots.delete(wall); cm._siegePlan.spotReach.delete(wall); }
      aiLog(team, `${cm.cname}: That's its gun off — tower at (${Math.round(rec.x)}, ${Math.round(rec.z)}) is done.`);
    }
  }
}
function explodeAt(point, blast, dmg, team, shooter) {
  destructibles.damageAt(point, blast, dmg);
  // KILL REPORT (Jacob: "shouldn't the unit that destroyed it report it as being destroyed?").
  // A tower we shot the gun off is a thing WE know about — no sighting needed, we did it. Without
  // this the only route to learning was a clear line of sight to a gun sitting inside its own
  // fort, which a besieger standing at its standoff often never gets.
  if (team) noteTowerKillsNear(point, blast, team);
  if (foliage) foliage.hitTreesAt(point, blast, dmg);
  const tagged = damageVehiclesAt(point, blast, dmg, team, shooter);
  // Area damage clears mines + sensor pods in the blast. A Valkyrie rocket that dives to a
  // ground hit takes a mine out directly; flat tracers never detonate at the mine, so they
  // sail over it. (Mine self-detonations route through here too → adjacent mines chain-clear.)
  if (minefield) minefield.damageAt(point, blast);
  if (sensorNet) sensorNet.damageAt(point, blast);
  spawnImpact(point, blast);
  return tagged;
}

// Damage enemy vehicles within blast of a point (never the shooter or its team).
// Returns true if it hit at least one enemy vehicle.
function damageVehiclesAt(point, blast, dmg, team, shooter) {
  let hitAny = false;
  for (const v of combatants) {
    if (v.dead || v === shooter) continue;
    if (team != null && v.team === team) continue;
    const reach = blast + v.hitR;
    if (v.holder.position.distanceToSquared(point) <= reach * reach) { damageVehicle(v, dmg, 'vehicle', shooter); hitAny = true; }
  }
  return hitAny;
}

// Running tally of damage dealt to vehicles, by source — powers siege diagnostics
// (are attackers dying to towers or to enemy vehicles?) and a future kill feed.
const dmgTally = { turret: 0, vehicle: 0, tree: 0, other: 0 };
// Spawn a hit-ring on a fancy shield bubble, toward `worldPos` if known (shooter or turret),
// else a random spot — so EVERY shield hit reads, including turret fire (which has no shooter).
const _ringTmp = new THREE.Vector3();
function shieldRingAt(b, worldPos) {
  if (!b || !isFancyMat(b.material)) return;
  b.updateWorldMatrix(true, false);
  const dir = worldPos ? b.worldToLocal(_ringTmp.copy(worldPos)).normalize()
                       : _ringTmp.set(Math.random() - 0.5, Math.random() - 0.3, Math.random() - 0.5).normalize();
  pushShieldHit(b.material, dir, performance.now() / 1000);
}
function damageVehicle(veh, amount, cause = 'other', shooter = null, srcPos = null) {
  if (veh.dead) return;
  // ELEVATOR ANTI-CAMP: while surfacing on the pad, nothing gets through — just flare the bubble
  // (and a hit-ring toward the shooter) so the block reads. Drops the moment it drives off (or times out).
  if (elevShieldOn(veh)) {
    ensureShieldFx(veh);
    const b = veh._shieldFx;
    if (b) { b.userData.hit = 1; shieldRingAt(b, (shooter && shooter.holder) ? shooter.holder.position : srcPos); }
    return;
  }
  const _hp0 = veh.hp;   // hull before, for the combat log
  dmgTally[cause] = (dmgTally[cause] || 0) + amount;
  if (veh.ai) veh._dmgBy = veh._dmgBy || { turret: 0, vehicle: 0, tree: 0, other: 0 }, veh._dmgBy[cause] += amount;
  // The shield pool soaks damage before the hull (body-armour style).
  if (veh.shield > 0) {
    const absorbed = Math.min(veh.shield, amount);
    veh.shield -= absorbed;
    amount -= absorbed;
    if (veh._shieldFx) {
      veh._shieldFx.userData.hit = 1;   // cheap-bubble flare
      shieldRingAt(veh._shieldFx, (shooter && shooter.holder) ? shooter.holder.position : srcPos);
    }
    if (veh.shield <= 0 && veh._shieldFx) veh._shieldFx.visible = false;
  }
  if (amount > 0) veh.hp -= amount;
  // Stamp when an ENEMY VEHICLE last hit us (shield hits count — we're still under fire). The
  // AI uses this to answer an attacker it can't outrun instead of sieging on / fleeing (underFire).
  // BEING SHOT IS A CONTACT REPORT, not just a clock. We also remember WHERE the round came
  // from — the same courtesy a tower hit already got (_hitByTurret below). Without it a unit
  // shot in the back knew only THAT it was being hit, never by whom or from which side, so it
  // drove on none the wiser; since sight became a forward cone, its only other route to noticing
  // a rear attacker is hearing, and hearing is exactly what fails here (a unit under throttle
  // masks 60% of what it would otherwise hear — SND.selfMask — so the moving target that most
  // needs the warning is the one least able to hear it). Intel only: this sets the last-known
  // position so the unit TURNS AND LOOKS. Sight still has to confirm before it can shoot back.
  if (cause === 'vehicle' && shooter && shooter !== veh && shooter.team !== veh.team) {
    veh._hitByVehT = performance.now();
    const sp = (shooter.holder && shooter.holder.position) || srcPos;
    if (sp) veh._hitByVeh = { x: sp.x, z: sp.z, t: veh._hitByVehT };
  }
  // A TURRET landed a hit — remember which gun (by head position) so the AI can SHOOT
  // BACK at the tower actually hurting it, instead of grinding whatever target its
  // mission math picked (nearest turret / a healing sponge / a wall).
  if (cause === 'turret' && srcPos) veh._hitByTurret = { x: srcPos.x, y: srcPos.y, z: srcPos.z, t: performance.now() };
  if (veh.bar) updateHealthBar(veh);
  if (veh.isPlayer) updatePlayerHud();
  // COMBAT LOG (deep view): vehicle-vs-vehicle hits only, and only when the hull actually
  // took damage (shots fully soaked by shield are skipped). "PURPLE hits TEAL 150 dmg (200→50)".
  if (cause === 'vehicle' && shooter && shooter.type && shooter !== veh) {
    const dealt = Math.round(_hp0 - veh.hp);
    if (dealt > 0) logCombat(shooter.team,
      `${teamLabel(shooter.colorIndex)} ${shooter.type} hits ${teamLabel(veh.colorIndex)} ${veh.type} ${dealt} dmg (${Math.round(_hp0)}→${Math.max(0, Math.round(veh.hp))})`);
  }
  if (veh.hp <= 0) destroyVehicle(veh, 'killed', shooter);
}

// March a hitscan beam; damage the first solid/tree/vehicle it meets.
function raycastDamage(origin, dir, maxDist, dmg, blast, team, shooter) {
  const STEP = 1.2;
  // Forgiving beam: a fat detection pad so the Firebrat's laser connects even when the
  // shot is a touch off — aiming it precisely with a fixed forward gun is the hard part.
  const PAD = 4.0;
  for (let d = 1.0; d <= maxDist; d += STEP) {
    _vtmp.copy(dir).multiplyScalar(d).add(origin);
    const hv = nearestEnemyVehicle(_vtmp, PAD, team, shooter);
    if (hv) {
      // Hit the DETECTED vehicle directly — the detection pad (2.5) is wider than
      // the tiny splash reach, so a point-blast here would miss what the beam met.
      damageVehicle(hv, dmg, 'vehicle', shooter);
      spawnImpact(hv.holder.position, blast);
      return;
    }
    if (destructibles.queryHit(_vtmp, 0.4) || (foliage && foliage.treeAt(_vtmp.x, _vtmp.z, 0.4))) {
      explodeAt(_vtmp, blast, dmg, team, shooter);
      return;
    }
  }
}

// --- Wall turrets ----------------------------------------------------------
// Corner turrets defend their camp: they track the nearest enemy vehicle in range
// with line of sight and fire on a cadence, damage falling off with distance — so
// you can't just waltz into a base. Destroying the turret head silences it.
const TURRET_RANGE = 54, TURRET_CD = 1.6, TURRET_DMG = 18;   // shorter reach — don't shred units from across the map
const TURRET_FALLOFF = { near: 16, far: 54, farMult: 0.45 };
// How far an AI unit can SENSE an enemy turret to suppress/snipe it — wider than the
// turret's own fire range so heavies (Jotun) can pick towers off from safely outside.
const TURRET_SENSE = 96;
const _tHead = new THREE.Vector3(), _tDir = new THREE.Vector3(), _threatV = new THREE.Vector3();
function turretFalloff(dist, far = TURRET_FALLOFF.far) {
  const { near, farMult } = TURRET_FALLOFF;
  if (dist <= near) return 1;
  if (dist >= far) return farMult;
  return 1 - (1 - farMult) * (dist - near) / (far - near);
}
// One corner turret's aim + fire. `team` = the owner (a base camp's team, or a placed
// piece's _team); a null team (neutral placed tower) has no friendlies, so it fires on all.
function tickWallTurret(w, team, dt) {
  const t = w.turret;
  if (!t || t.dead || t.falling) return;
  const st = towerStats(t.upg || 0);   // per-turret combat stats (scaled by its upgrade stars)
  t._cd = (t._cd || 0) - dt;
  t.group.updateWorldMatrix(true, false);
  t.head.getWorldPosition(_tHead);
  // nearest enemy vehicle in range (turrets sit above the parapet → no wall-LOS check)
  let target = null, bestD = st.range * st.range;
  for (const v of combatants) {
    if (v.dead || (team && v.team === team) || vehicleHidden(v)) continue;   // can't shoot a unit still down its lift shaft
    const dx = v.holder.position.x - _tHead.x, dz = v.holder.position.z - _tHead.z;
    const d2 = dx * dx + dz * dz;
    if (d2 < bestD) { bestD = d2; target = v; }
  }
  if (!target) { t.aimYaw = null; return; }   // nothing in range → idle sweep
  const tp = target.holder.position;
  t.aimYaw = Math.atan2(tp.x - _tHead.x, tp.z - _tHead.z);   // barrels point +Z local; swing the head onto it
  if (t._cd <= 0) {
    t._cd = st.cd;
    // Damage the locked target directly (with range falloff) + a cosmetic tracer.
    // Direct, so the slug can't clip the turret's OWN walls on the way out.
    damageVehicle(target, st.dmg * turretFalloff(Math.sqrt(bestD), st.range), 'turret', null, _tHead);   // srcPos → hit-ring faces the turret
    _tDir.copy(tp).sub(_tHead).normalize();
    const hex = TEAM_ACCENT[team] ? new THREE.Color(TEAM_ACCENT[team]).getHex() : 0xffd0a0;
    projectiles.spawn(0, _tHead.clone(), _tDir.clone(), hex);   // cosmetic tracer toward the target
  }
}
// Raise a base gate for its own side: open when a friendly unit is within range, else shut.
// Neutral (ownerless) gates stay open. The door slide itself animates in WallPiece.update.
const GATE_OPEN_R2 = () => (grid.cell * 2.4) * (grid.cell * 2.4);
function updateGates(dt) {
  if (!gates.length) return;
  const r2 = GATE_OPEN_R2();
  for (const g of gates) {
    if (g.team == null) { g.w.setGateTarget(true); continue; }   // no owner → held open
    let near = false;
    for (const v of combatants) {
      if (v.dead || v.team !== g.team || vehicleHidden(v)) continue;
      const dx = v.holder.position.x - g.gx, dz = v.holder.position.z - g.gz;
      if (dx * dx + dz * dz < r2) { near = true; break; }
    }
    g.w.setGateTarget(near);
  }
}
function updateWallTurrets(dt) {
  if (matchOver) return;
  for (const c of camps) for (const w of c.walls) tickWallTurret(w, c.team, dt);
  for (const w of placedWalls) tickWallTurret(w, w._team, dt);   // placed tower turrets fire too
}

function nearestEnemyVehicle(point, pad, team, shooter) {
  for (const v of combatants) {
    if (v.dead || v === shooter) continue;
    if (team != null && v.team === team) continue;
    const reach = pad + v.hitR;
    if (v.holder.position.distanceToSquared(point) <= reach * reach) return v;
  }
  return null;
}

// Advance travelling projectiles' damage: detonate on first solid/tree/vehicle/
// ground contact. (Projectiles.js already flies + fades them visually.)
function updateProjectileHits() {
  tickChargedShots();   // fire any railgun whose charge completed (game-clock, see fireVehicle)
  for (let i = projectiles.items.length - 1; i >= 0; i--) {
    const p = projectiles.items[i];
    if (p.dmg == null) continue;            // laser shots carry no travel damage
    const pos = p.obj.position;
    const hitSolid = destructibles.queryHit(pos, 0.3);
    const hitTree = foliage && p.team != null && foliage.treeAt(pos.x, pos.z, 0.3);
    const hitVeh = nearestEnemyVehicle(pos, 0.5, p.team, p.shooter);
    const hitGround = pos.y <= map.heightAt(pos.x, pos.z) + 0.2 && map.isLand(pos.x, pos.z);
    const hitPod = sensorNet ? sensorNet.queryHit(pos, 2.0) : null;   // sensor pods are shootable (horizontal, any height); radius > projectile step so a fast shell can't skip over it
    if (hitSolid || hitTree || hitVeh || hitGround || hitPod) {
      if (hitPod) sensorNet.takeHit(hitPod);   // a direct round kills the pod outright (splash still clears neighbours)
      if (hitSolid) {
        hitSolid.damage(p.dmg, pos);   // direct hit = full damage (splash adds a little more)
        // BASE UNDER ATTACK radio: an enemy round striking a structure near a team's flag HQ or
        // elevator stamps that team's commander, so its defender breaks patrol and responds even
        // from beyond hearing range (Defend.objective reads homeAttack()).
        if (p.team != null) for (const c of commanders) {
          if (c.team === p.team) continue;
          const hb = c.homeBasePos(), hf = c.homePos();
          const nearHome = (pos.x - hb.x) ** 2 + (pos.z - hb.z) ** 2 < 70 * 70
                        || (pos.x - hf.x) ** 2 + (pos.z - hf.z) ** 2 < 70 * 70;
          if (!nearHome) continue;
          c._homeAttack = { x: pos.x, z: pos.z, t: performance.now() };
          // This raw (x,z) is what Defend.objective() sends a responder straight at, with no
          // reachability check anywhere downstream — see AIStrategies.js's dlog2 on that function.
          dlog(`homeAttackRecorded:${c.team}`, { x: +pos.x.toFixed(0), z: +pos.z.toFixed(0) },
            `${c.cname}: home-attack position recorded (defenders will be sent straight here, unchecked).`);
          if (c._slots.some(s => s.strategy && s.strategy.step === 'defend') && (!c._homeAttackLogT || performance.now() - c._homeAttackLogT > 15000)) {
            c._homeAttackLogT = performance.now();
            aiLog(c.team, `${c.cname}: They're hitting our towers — get back there and jump them!`);
          }
        }
      }
      const tagged = explodeAt(pos, p.blast, p.dmg, p.team, p.shooter);
      // SHOT FEEDBACK: for a round AIMED at an enemy vehicle, tell a clean hit (it tagged
      // someone, direct or splash) from one that detonated on terrain/cover short of the
      // target. A run of blocked shots flags the shooter so its combat brain can sidestep
      // to open a clear lane (the "two units shoot the hill between them forever" stalemate).
      const sh = p.shooter;
      if (p.atVehicle && sh && !sh.dead) {
        if (tagged) { sh._blockedShots = 0; }
        else { sh._blockedShots = (sh._blockedShots || 0) + 1; sh._lastBlockT = performance.now(); }
      }
      projectiles.scene.remove(p.obj); p.dispose(); projectiles.items.splice(i, 1);
    }
  }
}

// A short additive flash + a few sparks where something was hit.
function spawnImpact(point, size) {
  const r = Math.max(0.5, size);
  const geo = new THREE.SphereGeometry(r, 8, 8);
  const mat = new THREE.MeshBasicMaterial({ color: 0xffd27f, transparent: true, opacity: 0.9,
    blending: THREE.AdditiveBlending, depthWrite: false });
  const m = new THREE.Mesh(geo, mat); m.position.copy(point); scene.add(m);
  fx.push({ obj: m, life: 0.22, max: 0.22, update(dt, k) { m.scale.setScalar(1 + (1 - k) * 2.5); mat.opacity = 0.9 * k; },
    dispose() { geo.dispose(); mat.dispose(); } });
}

function spawnExplosion(point, big) {
  const r = big ? 5 : 3;
  const geo = new THREE.SphereGeometry(r, 12, 12);
  const mat = new THREE.MeshBasicMaterial({ color: 0xff7a2a, transparent: true, opacity: 1,
    blending: THREE.AdditiveBlending, depthWrite: false });
  const m = new THREE.Mesh(geo, mat); m.position.copy(point); scene.add(m);
  fx.push({ obj: m, life: 0.5, max: 0.5, update(dt, k) { m.scale.setScalar(0.3 + (1 - k) * 1.8); mat.opacity = k; },
    dispose() { geo.dispose(); mat.dispose(); } });
}

// A small gold sparkle when a scrap pile is collected — reads as "picked up".
function spawnScrapPop(point) {
  const geo = new THREE.SphereGeometry(2.2, 10, 10);
  const mat = new THREE.MeshBasicMaterial({ color: 0xffcf4a, transparent: true, opacity: 0.9,
    blending: THREE.AdditiveBlending, depthWrite: false });
  const m = new THREE.Mesh(geo, mat); m.position.copy(point); m.position.y += 1.2; scene.add(m);
  fx.push({ obj: m, life: 0.4, max: 0.4, update(dt, k) { m.scale.setScalar(0.4 + (1 - k) * 1.6); mat.opacity = 0.9 * k; },
    dispose() { geo.dispose(); mat.dispose(); } });
}

// Soft white radial alpha (foam core → clear edge) for wake puffs, baked once.
let _foamTex = null;
function foamTex() {
  if (_foamTex) return _foamTex;
  const s = 64, cv = document.createElement('canvas'); cv.width = cv.height = s;
  const g = cv.getContext('2d');
  const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grd.addColorStop(0, '#ffffff'); grd.addColorStop(0.5, '#9a9a9a'); grd.addColorStop(1, '#000000');
  g.fillStyle = grd; g.fillRect(0, 0, s, s);
  _foamTex = new THREE.CanvasTexture(cv);
  return _foamTex;
}
// One flat white foam puff on the water surface; it expands and fades like turbulence.
function spawnWake(x, y, z, r0) {
  const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5,
    alphaMap: foamTex(), depthWrite: false });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
  m.rotation.x = -Math.PI / 2;
  m.position.set(x, y, z);
  scene.add(m);
  fx.push({ obj: m, life: 1.0, max: 1.0,
    update(dt, k) { m.scale.setScalar(r0 * (0.8 + (1 - k) * 2.6)); mat.opacity = 0.55 * k; },
    dispose() { m.geometry.dispose(); mat.dispose(); } });
}

function updateFx(dt) {
  for (let i = fx.length - 1; i >= 0; i--) {
    const f = fx[i]; f.life -= dt;
    f.update(dt, Math.max(0, f.life / f.max));
    if (f.life <= 0) { scene.remove(f.obj); f.dispose(); fx.splice(i, 1); }
  }
}

// NOTE: the old separate "where's it going" goal-line overlay (?navlines / updateNavLines)
// is now FOLDED INTO updateNavOverlay (?nav) — one toggle draws the A* route for grounders and
// a straight goal-line for flyers/skirters. See updateNavOverlay further down.

// Destroy a vehicle: explosion, then remove it (or send the player to the garage).
// Credit a kill to the firing unit's commander (ignores self/team kills, environment
// deaths where there's no killer, and the player who has no commander). Powers the
// "after a couple kills" doctrine transitions and a short kill-feed line.
// --- UNIT PROMOTIONS ---------------------------------------------------------
// Kills promote the INDIVIDUAL vehicle (Jacob's design): kills 1-3 pin bronze stars
// (+3% speed each), 4-6 silver (+5% max hull each, the increase healed on pin-on),
// 7-9 gold (+5% damage each) — three gold stars is max rank. Rank rides the roster
// individual: a recalled ace keeps its stars for the next deploy of that TYPE (the
// per-team rank bank below); death resets that type's rank — attrition keeps teeth.
const RANK_MAX = 9;
const playerRankBank = {};   // the player's per-type rank memory (garage swaps keep stars)
function rankBankFor(v) {
  if (!v || v.team == null) return null;
  if (v.isPlayer) return playerRankBank;
  const cmd = commanders.find(c => c.team === v.team);
  return cmd ? (cmd._rankBank ??= {}) : null;
}
function rankSpeedMul(v) { return 1 + 0.03 * Math.min(v.rankKills || 0, 3); }
function rankDmgMul(v) { return 1 + 0.05 * Math.max(0, Math.min(v.rankKills || 0, RANK_MAX) - 6); }
function applyRankHp(v) {
  const silver = Math.max(0, Math.min(v.rankKills || 0, 6) - 3);
  const base = v._baseMaxHp || (v._baseMaxHp = v.maxHp);
  const newMax = Math.round(base * (1 + 0.05 * silver));
  if (newMax !== v.maxHp) { const gain = newMax - v.maxHp; v.maxHp = newMax; if (gain > 0) v.hp = Math.min(newMax, v.hp + gain); }
}
function rankLabel(k) {
  if (!k) return '';
  const t = k >= 7 ? 'GOLD' : k >= 4 ? 'SILVER' : 'BRONZE';
  const n = k >= 7 ? k - 6 : k >= 4 ? k - 3 : k;
  return t + ' ' + '\u2605'.repeat(n);
}
// Star billboard above the hull — rides the health-bar group (AI) or its own group (player).
function updateRankStars(v) {
  const k = Math.min(v.rankKills || 0, RANK_MAX);
  if (!k) { if (v._rankSpr) v._rankSpr.visible = false; return; }
  if (!v._rankSpr) {
    const cv = document.createElement('canvas'); cv.width = 96; cv.height = 26;
    const tex = new THREE.CanvasTexture(cv);
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
    sp.scale.set(4.5, 1.2, 1);
    sp.userData.cv = cv; sp.userData.tex = tex;
    v._rankSpr = sp;
    if (v.bar) { sp.position.set(0, 1.15, 0); v.bar.group.add(sp); }
    else { const g = new THREE.Group(); g.add(sp); scene.add(g); v._rankGrp = g; }   // the player has no bar
  }
  const cv = v._rankSpr.userData.cv, ctx = cv.getContext('2d');
  const col = k >= 7 ? '#ffd24a' : k >= 4 ? '#d7dee5' : '#8a5a30';   // bronze reads BROWN, not gold-adjacent (was #d08a4a — too close to gold at billboard size)
  const n = k >= 7 ? k - 6 : k >= 4 ? k - 3 : k;
  ctx.clearRect(0, 0, 96, 26);
  // Vector stars (not a text glyph — headless/odd fonts render \u2605 as tofu boxes).
  for (let i = 0; i < n; i++) {
    const cx = 48 + (i - (n - 1) / 2) * 24, cy = 13, r = 11;
    ctx.beginPath();
    for (let j = 0; j < 10; j++) {
      const ang = -Math.PI / 2 + j * Math.PI / 5;
      const rr = j % 2 === 0 ? r : r * 0.45;
      const x = cx + Math.cos(ang) * rr, y = cy + Math.sin(ang) * rr;
      j ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.closePath();
    ctx.fillStyle = col; ctx.strokeStyle = 'rgba(10,14,20,0.85)'; ctx.lineWidth = 2;
    ctx.fill(); ctx.stroke();
  }
  v._rankSpr.userData.tex.needsUpdate = true;
  v._rankSpr.visible = true;
}

// --- TOWER UPGRADES (Jacob's design) -----------------------------------------
// A single linear STAR path per corner tower, bought from the garage scrap shop (a jeep crew
// rolls out to install it). Four colour bands, three stars each = 12 total, and each band
// improves ONE stat — you grind toward the payoff (damage last):
//   bronze 1-3 → +HP        silver 4-6 → +range
//   gold   7-9 → +fire rate  black 10-12 → +damage
// Reuses the promotion star billboard; stats are read per-turret in tickWallTurret via towerStats.
const TOWER_UPG_MAX = 12;
const TOWER_UPG_COST = 1;   // scrap per star (12 to fully max one tower); tune with balance
const UPG_HP_PER = 0.20, UPG_RANGE_PER = 0.12, UPG_SPEED_PER = 0.11, UPG_DMG_PER = 0.18;   // per star, within a band
const upgBand = (u, b) => Math.max(0, Math.min(3, (u || 0) - b * 3));   // stars lit in band b (0 bronze .. 3 black)
function towerStats(u) {
  return {
    range: TURRET_RANGE * (1 + UPG_RANGE_PER * upgBand(u, 1)),
    cd:    TURRET_CD    * (1 - UPG_SPEED_PER * upgBand(u, 2)),
    dmg:   TURRET_DMG   * (1 + UPG_DMG_PER   * upgBand(u, 3)),
    hpMul: 1 + UPG_HP_PER * upgBand(u, 0),
  };
}
// Apply the HP band to the tower body (heal the gain, like a promotion pin-on).
function applyTowerHp(w) {
  const u = (w.turret && w.turret.upg) || 0;
  const base = w._baseMaxHp ?? (w._baseMaxHp = w.maxHp);
  const newMax = Math.round(base * (1 + UPG_HP_PER * upgBand(u, 0)));
  const gain = newMax - w.maxHp;
  w.maxHp = newMax;
  if (w.body) { w.body.maxHp = newMax; if (gain > 0) w.body.heal(gain); }
}
// Install one (or n) upgrade star on a tower. Returns the new level, or -1 if maxed / no turret.
function upgradeTower(w, n = 1) {
  const t = w && w.turret; if (!t || t.dead) return -1;
  const before = t.upg || 0;
  if (before >= TOWER_UPG_MAX) return -1;
  t.upg = Math.min(TOWER_UPG_MAX, before + n);
  applyTowerHp(w);
  updateTowerStars(w);
  return t.upg;
}
// Star billboard above a tower — the CURRENT band's stars, coloured by band (bronze→black).
const UPG_BAND_COL = ['#8a5a30', '#d7dee5', '#ffd24a', '#1a1a1e'];
function updateTowerStars(w) {
  const t = w && w.turret; if (!t) return;
  const u = Math.min(t.upg || 0, TOWER_UPG_MAX);
  if (!u) { if (t._upgSpr) t._upgSpr.visible = false; return; }
  if (!t._upgSpr) {
    const cv = document.createElement('canvas'); cv.width = 96; cv.height = 26;
    const tex = new THREE.CanvasTexture(cv);
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
    sp.scale.set(5.5, 1.5, 1); sp.position.set(0, 2.4, 0);
    sp.userData.cv = cv; sp.userData.tex = tex;
    t.group.add(sp); t._upgSpr = sp;
  }
  const band = Math.min(3, Math.floor((u - 1) / 3));
  const n = u - band * 3;                       // 1..3 stars lit in the current band
  const col = UPG_BAND_COL[band];
  const cv = t._upgSpr.userData.cv, ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, 96, 26);
  for (let i = 0; i < n; i++) {
    const cx = 48 + (i - (n - 1) / 2) * 24, cy = 13, r = 11;
    ctx.beginPath();
    for (let j = 0; j < 10; j++) {
      const ang = -Math.PI / 2 + j * Math.PI / 5, rr = j % 2 === 0 ? r : r * 0.45;
      const x = cx + Math.cos(ang) * rr, y = cy + Math.sin(ang) * rr;
      j ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.closePath();
    ctx.fillStyle = col;
    ctx.strokeStyle = band === 3 ? 'rgba(235,205,95,0.95)' : 'rgba(10,14,20,0.85)';   // black stars get a gold rim to read
    ctx.lineWidth = 2; ctx.fill(); ctx.stroke();
  }
  t._upgSpr.userData.tex.needsUpdate = true;
  t._upgSpr.visible = true;
}

// Scatter salvage around a destroyed upgraded tower — the "treasure box": the more you invested,
// the more scrap spills when it falls (roughly half the stars come back as loose piles, worth 1
// each). Whoever's standing there (usually the attacker) collects it.
function dropTowerScrap(w, upg) {
  const n = Math.min(6, Math.ceil(upg / 2));
  const p = w.group.position;
  for (let i = 0; i < n; i++) {
    // A GUN TOWER STANDS ON THE WALL RING. Throwing a pallet blindly around one lands it ON the
    // wall, INSIDE the compound, or in the pinch between the ring and the shoreline: visible,
    // counted as salvage, and impossible for any hull to collect. Every other scrap spawn tests
    // blockedAt; this path tested only isLand, and it is the one that fires most often — six
    // pallets per tower death, and a contested base loses every tower it has.
    // Walk outward for ground a hull could actually stand on, and DROP the pallet rather than
    // leave a prize nobody can reach. One fewer pallet costs a point of scrap; an unreachable
    // one costs a unit that drives at it and grinds.
    for (let t = 0; t < 8; t++) {
      const a = (i / n) * Math.PI * 2 + Math.random() * 0.6 + t * 0.9;
      const r = grid.cell * (0.9 + Math.random() * 0.8) + t * grid.cell * 0.5;
      const x = p.x + Math.cos(a) * r, z = p.z + Math.sin(a) * r;
      if (!map.isLand(x, z) || blockedAt(x, z)) continue;
      addScrapPile(x, z, 'parts');
      break;
    }
  }
}
// Watch every gun tower for the death→rebuild cycle: on DESTRUCTION, spill the treasure box and
// drop its stars; on REBUILD (the repair crew's revive), restore a RANDOM slice of what it had
// (Jacob's design — a 3-gold tower might come back ~2 silver, so the loss isn't total).
function updateTowerUpgrades() {
  const visit = (w) => {
    const t = w.turret; if (!t) return;
    const dead = !!(w.body && w.body.dead);
    if (dead && !t._wasDead) {
      if ((t.upg || 0) > 0) { t._upgWas = t.upg; dropTowerScrap(w, t.upg); t.upg = 0; updateTowerStars(w); }
      t._wasDead = true;
    } else if (!dead && t._wasDead) {
      if (t._upgWas) {
        t.upg = Math.max(0, Math.floor(t._upgWas * (0.4 + Math.random() * 0.35)));   // keep ~40–75%
        t._upgWas = 0; applyTowerHp(w); updateTowerStars(w);
      }
      t._wasDead = false;
    }
  };
  for (const c of camps) for (const w of c.walls) visit(w);
  for (const w of placedWalls) visit(w);
}

// Shared commander-side bookkeeping for a confirmed kill: team tally + the DEFENSIVE
// tallies the mission scorecard reads (kills on OUR half = interception/guard work;
// carrier kills = downing the flag thief). Victim position vs the two main camps
// decides the half — same test Defend uses.
// An enemy repair crew actively HEALING near a point we're about to shell: the tower
// out-heals the chew while covering towers do the killing (a live-watched damage-sponge
// standoff). The designed counterplay is the killable JEEP — kill it and the job
// cancels — so shooters swap their aim to the jeep. Returns the jeep aim point or null.
function enemyRepairJeepNear(myTeam, x, z, r = 20) {
  for (const j of repairJobs) {
    if (j.team === myTeam || j.jeepDest.dead) continue;
    if (j.state !== 'building' && j.state !== 'installing') continue;   // crew on site, actively working
    if ((j.jx - x) ** 2 + (j.jz - z) ** 2 < r * r) return { x: j.jx, y: j.jeep.position.y + 1.0, z: j.jz };
  }
  return null;
}

function creditKillToTeam(team, victim) {
  const cmd = commanders.find(c => c.team === team);
  if (!cmd) return null;
  cmd.kills = (cmd.kills || 0) + 1;
  const vp = victim.holder ? victim.holder.position : null;
  if (vp) {
    let dMine = Infinity, dTheirs = Infinity;
    for (const c of camps) {
      if (c.role !== 'main') continue;
      const d = (vp.x - c.center.x) ** 2 + (vp.z - c.center.z) ** 2;
      if (c.team === team) dMine = Math.min(dMine, d); else dTheirs = Math.min(dTheirs, d);
    }
    if (dMine < dTheirs) cmd.homeKills = (cmd.homeKills || 0) + 1;
  }
  if (flags.some(f => f.carried && f.carrier === victim)) cmd.carrierKills = (cmd.carrierKills || 0) + 1;
  return cmd;
}
function creditKill(killer, victim) {
  if (!killer || killer.team == null || killer.team === victim.team) return;
  const cmd = creditKillToTeam(killer.team, victim);
  if (!cmd) { promoteUnit(killer); return; }   // player/no-commander team: stars still pin on
  const sl = cmd._slotFor && cmd._slotFor(killer);   // per-slot tally too (turtle's siege gate counts its OWN kills)
  if (sl) sl._kills = (sl._kills || 0) + 1;
  aiLog(killer.team, `${cmd.cname}: Splash! ${killer.type} just dropped their ${victim.type} — that's ${cmd.kills} confirmed!`);
  promoteUnit(killer);
}
// Pin a star on the firing UNIT (player included — its commander credit is a no-op above).
function promoteUnit(killer) {
  if (!killer || killer.dead || killer.team == null) return;
  if ((killer.rankKills || 0) >= RANK_MAX) return;
  killer.rankKills = (killer.rankKills || 0) + 1;
  applyRankHp(killer); updateRankStars(killer);
  if (killer.bar) updateHealthBar(killer);
  if (killer.isPlayer) updatePlayerHud();
  const bank = rankBankFor(killer); if (bank) bank[killer.type] = killer.rankKills;
  aiLog(killer.team, `${teamLabel(killer.colorIndex)} ${killer.type} promoted — ${rankLabel(killer.rankKills)}!`);
}
function destroyVehicle(veh, cause, killer = null) {
  if (veh.dead) return;
  veh.dead = true;
  spawnExplosion(veh.holder.position, veh.type === 'jotun');
  // …and it burns for a few seconds afterwards. A Jotun is a bigger machine and gets a bigger
  // fire; everything else is one size for now (Jacob: "keep it all the same for now").
  if (cause !== 'sank') fireWreck(veh.holder.position.x, veh.holder.position.y, veh.holder.position.z,
                                  veh.type === 'jotun' ? 1.35 : 1,
                                  (gx, gz) => { const r = roadDeckY(gx, gz); return r != null ? r : map.heightAt(gx, gz); });
  creditKill(killer, veh);   // credit the firing unit's commander (drives Warrior/Hunter doctrine + kill feed)
  // A CORPSE IS NOT A ROADBLOCK. The contact notebook (_noteContact) is fed by sightings, sounds
  // and shot-from stamps, and until now nothing ever removed an entry — laneIntel only skipped
  // them once they aged out at 25s, and the timestamp is REFRESHED every tick the enemy is
  // visible, so the clock started at the moment of the kill. Seed 3362: a blue Firebrat won a
  // duel at t474 and its own lane still scored `lane blocked -2` for the next 25 seconds, which
  // is a 3-point swing against the capture it had just cleared the way for. It died at t484,
  // fifteen seconds inside a block posted by a unit it had already destroyed.
  if (aiContactClear) for (const c of commanders) {
    if (!c._contacts || c.team === veh.team) continue;   // only the ENEMY's notebook held this contact
    const p = veh.holder.position;
    c._contacts = c._contacts.filter(k => (k.x - p.x) ** 2 + (k.z - p.z) ** 2 >= CONTACT_CLEAR_R * CONTACT_CLEAR_R);
  }
  { const bank = rankBankFor(veh); if (bank) bank[veh.type] = 0; }   // the decorated individual is gone — rank dies with it
  if (veh._rankGrp) { scene.remove(veh._rankGrp); veh._rankGrp = null; veh._rankSpr = null; }
  if (cause !== 'sank') {     // units lost at sea sink whole — no wreckage
    let impact = null;
    if (killer && killer.holder) { impact = veh.holder.position.clone().sub(killer.holder.position); impact.y = 0; }
    const wreck = gibVehicle(veh, impact);   // blow the model apart; the settled debris becomes the scrap pile
    // FRESH KILL loot: hand the wreck to the KILLER'S commander so it swings over and grabs what
    // it just dropped — it's close and the fight's (locally) over. Whether it bothers is a mood +
    // dice roll with mission exceptions (see wantsLoot). Only its OWN commander's current unit.
    if (wreck && killer && killer.team && killer.team !== veh.team) {
      const cmd = commanders.find(c => c.team === killer.team && c.ownsUnit(killer));
      const slot = cmd && cmd._slotFor(killer);   // the loot order goes to the KILLER's slot, not whichever was bound last
      if (cmd && slot && !wreck.overWater && cmd.wantsLoot(killer)) { slot._lootPile = wreck; slot._lootUntil = performance.now() + LOOT_MS; }
    }
    // Drop the killer's engage-afterglow ghost: that hysteresis holds a target at its last-seen
    // spot through LOS blinks, but a KILLED enemy shouldn't be "searched for" — it made the killer
    // stand and stare at the corpse (and its fresh wreck) for a beat instead of moving on/looting.
    if (aiPostKillMoveOn && killer && killer.ai) killer.ai._lastEnemyView = null;
  }
  if (veh.isPlayer) { killPlayer(); return; }
  // Surface what happened to the AI unit — drowned/destroyed units used to just vanish.
  if (veh.ai && veh.team) {
    const how = cause === 'sank' ? 'DROWNED' : 'destroyed';
    aiLog(veh.team, `${teamLabel(veh.colorIndex)} ${veh.type} ${how}`);
    // DEATH-CAUSE breakdown (deep combat log): where did the damage come from (turret vs
    // vehicle vs terrain), plus where it died and what mission it was on — so we can see, e.g.,
    // whether a capture-run firebrat is being killed by the enemy's FOB turrets.
    const by = veh._dmgBy;
    if (by) {
      const parts = Object.entries(by).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${Math.round(n)}`);
      const cmdr = commanders.find(c => c.team === veh.team);
      const sl = cmdr && cmdr._slotFor ? cmdr._slotFor(veh) : null;   // the DEAD unit's own card, not whichever slot ran last
      const mis = sl && sl.strategy ? sl.strategy.step : (cmdr && cmdr.strategy ? cmdr.strategy.step : '');
      const pp = veh.holder.position;
      logCombat(veh.team, `${teamLabel(veh.colorIndex)} ${veh.type} DOWN${mis ? ` (${mis})` : ''} @(${Math.round(pp.x)},${Math.round(pp.z)}) — ${parts.join(', ') || 'unknown'}`);
    }
  }
  removeCombatant(veh);
  if (veh.ai) veh.ai.dead = true;
  scene.remove(veh.group);
}

let playerDead = false;
function killPlayer() {
  if (playerDead) return;
  playerDead = true;
  driving = false;
  clearLock();
  if (player) playerLosses[player.type] = (playerLosses[player.type] || 0) + 1;   // attrition: one fewer in the garage
  try { if (sound && sound.enabled) sound.toggle(); } catch (e) { /* engine winds down on death */ }
  removeCombatant(player);
  scene.remove(player.group);
  player = null;
  const fade = document.getElementById('deployfade');
  if (fade) fade.style.opacity = 1;
  setTimeout(() => { playerDead = false; returnToGarage(); }, 1400);
}

// Per-vehicle blocked(x,z): map bounds, walls (unless it flies), and bump-trees.
// avoidWater makes a land vehicle treat open sea as solid — used for the AI so it
// paths around the coast; the player keeps avoidWater=false so it CAN drive in
// (and flood/sink, see applyAltitude).
function blockedFor(move, avoidWater, team) {
  return (x, z) => {
    const halfW = map.worldW / 2 + 24, halfH = map.worldH / 2 + 24;
    if (x < -halfW || x > halfW || z < -halfH || z > halfH) return true;
    if (islandBound && (x * x + z * z) > islandBound * islandBound) return true;   // off the island → walled off
    // A shut gate is a solid door across its opening — checked BEFORE the road pass-through
    // (the opening IS a road) so a closed enemy gate actually stops the enemy on the lane.
    // Flyers clear it. Its cells reopen the instant it's breached or a friendly holds it.
    if (!move.ignoreWalls) for (const g of gates) {
      if (!gateBlocks(g.w, team)) continue;
      const ax = x - g.gx, az = z - g.gz;
      if (Math.abs(ax * g.nx + az * g.nz) < g.halfNorm + VEH_R && Math.abs(ax * g.px + az * g.pz) < g.halfRun) return true;
    }
    const cx = Math.round(x / grid.cell), cz = Math.round(z / grid.cell);
    if (roadNet.cells && roadNet.cells.has(cx + ',' + cz)) return false;
    if (elevatorPadAt(x, z)) return false;
    if (avoidWater && move.water === 'sink' && map.isDeepWater(x, z)) return true;   // shallow is fordable
    if (move.ignoreWalls) return false;              // Valkyrie clears walls
    for (const o of obstacles) {
      if (o.body && o.body.dead) continue;           // a blown-up wall/tower no longer blocks — drive over the rubble
      const dx = x - o.x, dz = z - o.z, rr = o.r + VEH_R;
      if (dx * dx + dz * dz < rr * rr) return true;
    }
    if (move.tree === 'bump' && foliage && foliage.treeAt(x, z, VEH_R * 0.5)) return true;
    return false;
  };
}

// Top surface height of a ROAD cell at a world point, or null if (x,z) isn't on one.
// A road is a raised surface — a flat asphalt slab on land, a plank deck over water —
// so vehicles ride its top instead of sinking into the slab / wading under the planks.
// Must match the grade Roads.js builds each tile at (see tile()/deck() there).
function roadDeckY(x, z) {
  if (!roadNet || !roadNet.cells) return null;
  const cx = Math.round(x / grid.cell), cz = Math.round(z / grid.cell);
  const cell = roadNet.cells.get(cx + ',' + cz);
  if (!cell) return null;
  const p = map.params;
  if (!map.isLand(x, z)) {
    // Over-water span: a plank deck seated at Math.max(cell grade, bridgeY) with its top
    // ~0.08 above the centre. The old flat bridgeY ignored the per-cell grade, so where the
    // road sat higher the deck was built above the vehicle's target and it sank through.
    const bridgeY = p.flatLand ? p.beachHeight + 0.8 : p.beachHeight + 0.5;
    return Math.max(cell.y, bridgeY) + 0.08;
  }
  // Land tile: a flat asphalt slab whose top sits 0.06 above its grade (tile(): topY =
  // gradeY + 0.06). Flat-land roads share ONE grade (the plateau); the legacy hilly map
  // falls back to each cell's own terrain height — same choice Roads.build() makes.
  const roadGrade = p.flatLand ? p.beachHeight + 0.8 : cell.y;
  return roadGrade + 0.06;
}

// Resolve altitude + water flooding for a vehicle, and crush/bump trees it touches.
function applyAltitude(veh, dt) {
  const m = veh._move; if (!m) return;
  const x = veh.holder.position.x, z = veh.holder.position.z;
  const deck = elevatorPadAt(x, z);
  const terrain = deck ? deck.groundY : map.heightAt(x, z);
  const overWater = !deck && !map.isLand(x, z);
  const deepWater = !deck && map.isDeepWater(x, z);   // only the deep part drowns a sinker
  // A road cell (land slab or over-water plank) is a raised surface — ride its top instead
  // of the terrain/water beneath it. Elevator decks and true flyers (ignoreWalls) opt out.
  const roadY = (deck || m.ignoreWalls) ? null : roadDeckY(x, z);
  let target;
  if (m.water === 'sink') {
    if (roadY != null) {
      veh._sink = Math.max(0, veh._sink - dt * SINK_RATE * 1.6);
      target = roadY - veh._sink;
    } else if (deepWater) {
      veh._sink += dt * SINK_RATE;
      target = -veh._sink;
      if (veh._sink >= SINK_KILL) { destroyVehicle(veh, 'sank'); return; }
    } else {
      // land OR shallow water. On land, sit just above the ground. FORDING, sink below the
      // waterline — DEEPER the bluer (deeper) the water — so it reads as riding the surface and
      // wading in, the opaque water-coloured terrain hiding the submerged hull (no water plane
      // exists to do it). Capped short of the drown depth so the top always shows.
      veh._sink = Math.max(0, veh._sink - dt * SINK_RATE * 1.6);
      const floor = deck ? deck.groundY : map.floorAt(x, z);
      if (overWater) {
        const f = Math.min(1, Math.max(0, -floor) / 0.8);   // 0 at shore → 1 at the ford limit (FORD_DEPTH = -0.8)
        target = -(WADE_MIN + f * (WADE_MAX - WADE_MIN)) - veh._sink;
      } else {
        target = floor + 0.05 - veh._sink;
      }
    }
  } else {
    // A hover craft (firebrat) on a road rides above its surface, not the terrain/water
    // beneath it; a true flyer (valkyrie, ignoreWalls) just cruises over everything.
    const base = roadY != null ? roadY : (overWater ? 0 : terrain);
    target = base + m.cruise;
  }
  // Flyers (the Valkyrie) ease to altitude GENTLY so they float up off the lift instead of
  // popping to cruise height; ground craft snap to the grade so they don't sink visibly.
  const altRate = m.ignoreWalls ? 1.8 : 5;
  veh.holder.position.y += (target - veh.holder.position.y) * Math.min(1, dt * altRate);

  // Wake: while a ground (sinker) vehicle fords open water and is actually moving, trail
  // expanding white foam puffs behind it on the water surface.
  if (m.water === 'sink' && overWater && roadY == null) {
    const sp = Math.hypot(veh._vx || 0, veh._vz || 0);
    if (sp > 2) {
      veh._wakeT = (veh._wakeT || 0) - dt;
      if (veh._wakeT <= 0) {
        veh._wakeT = 0.06;   // ~16 puffs/sec while moving
        const inv = veh.hitR / sp, bx = x - veh._vx * inv, bz = z - veh._vz * inv;   // one hull-radius behind
        if (!map.isLand(bx, bz)) spawnWake(bx, map.floorAt(bx, bz) + 0.1, bz, veh.hitR * 0.95);
      }
    }
  }

  // Trees in contact: heavy vehicles flatten them; light ones chip themselves.
  if (m.tree !== 'fly' && foliage) {
    const t = foliage.treeAt(x, z, veh.hitR * 0.5);
    if (t) {
      if (m.tree === 'crush') { foliage.fellTree(t); }
      else if (m.tree === 'bump' && veh._touchTree !== t) { veh._touchTree = t; damageVehicle(veh, TREE_BUMP_DMG, 'tree'); }
    } else { veh._touchTree = null; }
  }
}

// Burn fuel against throttle. An empty tank doesn't strand you — the engine
// "limps" at reduced power (LIMP). Idle sips a quarter of the full-throttle rate.
const LIMP = 0.35;
function burnFuel(veh, inp, dt) {
  const st = inp.strafe || 0;
  if (veh.fuel <= 0) return { fwd: inp.fwd * LIMP, turn: inp.turn * (LIMP + 0.25), strafe: st * LIMP };
  const load = (Math.abs(inp.fwd) + Math.abs(inp.turn) * 0.5 + Math.abs(st) * 0.6);
  veh.fuel = Math.max(0, veh.fuel - veh.burn * (0.25 + 0.75 * Math.min(1, load)) * dt);
  if (veh.isPlayer) updatePlayerHud();
  if (veh.fuel <= 0) return { fwd: inp.fwd * LIMP, turn: inp.turn * (LIMP + 0.25), strafe: st * LIMP };
  return inp;
}

// --- Health bars + player HUD -----------------------------------------
// A floating canvas-textured bar above a vehicle (enemies). Cheap: one sprite.
function makeHealthBar(veh) {
  const cv = document.createElement('canvas'); cv.width = 64; cv.height = 10;
  const tex = new THREE.CanvasTexture(cv);
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true });
  const sp = new THREE.Sprite(mat); sp.scale.set(6, 0.95, 1);
  const group = new THREE.Group(); group.add(sp);
  scene.add(group);
  const bar = { group, sprite: sp, tex, cv, ctx: cv.getContext('2d') };
  veh.bar = bar; updateHealthBar(veh); return bar;
}
function updateHealthBar(veh) {
  const b = veh.bar; if (!b) return;
  const f = Math.max(0, veh.hp / veh.maxHp);
  const c = b.ctx; c.clearRect(0, 0, 64, 10);
  c.fillStyle = 'rgba(0,0,0,0.6)'; c.fillRect(0, 0, 64, 10);
  c.fillStyle = f > 0.5 ? '#4fd14f' : f > 0.25 ? '#e0c020' : '#e04020';
  c.fillRect(1, 1, 62 * f, 8);
  b.tex.needsUpdate = true;
}
// Keep bars above their vehicle and facing the camera (sprites already billboard).
function updateHealthBars() {
  for (const v of combatants) {
    if (v._rankGrp) v._rankGrp.position.set(v.holder.position.x, v.holder.position.y + 8, v.holder.position.z);   // player stars (no bar group)
    if (!v.bar) continue;
    v.bar.group.position.set(v.holder.position.x, v.holder.position.y + 7, v.holder.position.z);
  }
  updateStatusLights();
}

// ── STATUS LIGHT ─────────────────────────────────────────────────────────────
// A lamp on the hull that says what this unit is DOING, so the field can be read without
// the ai-lab open in another window.
//
// TWO CHANNELS, because "does it see the enemy" is a different question from "what is it up to":
//   COLOUR  = the job (attacking / shelling / running / resupplying / carrying / travelling)
//   PULSING = it has an enemy in LIVE line of sight right now
// That split is the whole point. A unit can be nose-on to a rival with the contact remembered
// but no line of sight — behind a tree, or outside its sight cone — and that is exactly the
// "it's looking right at it and not shooting" case. Steady red = attacking from memory;
// pulsing red = it can actually see the thing. Nothing else distinguishes those two at a glance.
//
// The lamp rides in v.holder (unscaled, so it inherits hull position AND heading) and is UNLIT
// (MeshBasicMaterial) so it reads the same in shadow, at night, and against a bright sea.
const STATUS_COLORS = {
  attack:   0xff3b30,   // red    — fighting another vehicle
  siege:    0xff9500,   // orange — shelling a tower or the keep
  flee:     0x2f7bff,   // blue   — broken off, heading home
  supply:   0x34c759,   // green  — refuelling / rearming / repairing / shielding
  carry:    0xffffff,   // white  — carrying the flag (the only thing that wins)
  travel:   0x8899a6,   // grey   — driving, nothing tactical
};
// The mission steps that mean "I am at/heading to a depot". Kept as a set because the mission
// layer names four separate errands that all read the same from outside the vehicle.
const SUPPLY_STEPS = new Set(['refuel', 'rearm', 'repair', 'armour', 'resupply']);
const aiStatusLights = !QS.has('nolights');
let _haloTex = null;
function haloTexture() {
  if (_haloTex) return _haloTex;
  const cv = document.createElement('canvas'); cv.width = cv.height = 64;
  const c = cv.getContext('2d');
  const g = c.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25, 'rgba(255,255,255,0.55)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  c.fillStyle = g; c.fillRect(0, 0, 64, 64);
  _haloTex = new THREE.CanvasTexture(cv);
  return _haloTex;
}
// Which of the six a unit is in. Read in priority order: carrying the flag outranks everything
// (it is the win condition), then running, then what it is shooting at, then errands.
function statusKeyFor(v) {
  for (const f of flags) if (f.carried && f.carrier === v) return 'carry';
  if (v._fleeing) return 'flee';
  const step = v._msnStep;
  if (step === 'flee') return 'flee';
  const st = v._aiState;
  if (st === 'engage') return 'attack';
  if (st === 'suppress' || st === 'assault') return 'siege';
  if (st === 'resupply' || SUPPLY_STEPS.has(step)) return 'supply';
  return 'travel';
}
function ensureStatusLight(v) {
  if (v._statusLight) return v._statusLight;
  // Sit the lamp just clear of the tallest point of THIS hull rather than at a guessed height —
  // the four chassis differ by ~3u and a fixed offset either buries it in a Jotun's turret or
  // floats it over a Firebrat. Measured once, at attach time, the same way Vehicle.seat() does it:
  // setFromObject gives a WORLD box, and seatGroup has already been shifted so the model's feet
  // rest on the holder's ground plane — so the hull's height above that plane is max.y - min.y,
  // NOT max.y (which carries the vehicle's world elevation and would put the lamp in the sky).
  let top = 3.2;
  if (v.model && v.model.group) {
    v.model.group.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(v.model.group);
    if (isFinite(box.max.y) && isFinite(box.min.y)) top = box.max.y - box.min.y;
  }
  const grp = new THREE.Group();
  const bulb = new THREE.Mesh(
    new THREE.SphereGeometry(0.6, 10, 8),
    new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }));
  // depthTest off on the HALO only: the glow should still be findable when the hull is behind a
  // dune or a wall (that is the moment you most want to know what it is doing), while the bulb
  // stays properly occluded so the lamp still reads as a thing bolted to the vehicle.
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({
    map: haloTexture(), color: 0xffffff, transparent: true, depthWrite: false, depthTest: false,
    blending: THREE.AdditiveBlending, toneMapped: false }));
  halo.scale.set(5, 5, 1);
  grp.add(bulb); grp.add(halo);
  // Slightly BEHIND the hull centre so it never hides inside a turret or gun mantlet, and high
  // enough to clear the deck. Local -Z is the model's front, so +Z is aft.
  grp.position.set(0, top + 0.7, v.hitR * 0.35);
  v.holder.add(grp);
  v._statusLight = { grp, bulb, halo, mat: bulb.material, halomat: halo.material };
  return v._statusLight;
}
// A key for the six colours, small and bottom-left, only while watching AI-vs-AI. Six colours is
// past the point where you can hold them in your head on day one, and the whole feature exists so
// nothing has to be looked up in another window.
let _lightKey = null;
function ensureLightKey() {
  if (_lightKey) return;
  _lightKey = document.createElement('div');
  _lightKey.id = 'light-key';
  _lightKey.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:57;pointer-events:none;'
    + 'font:11px "Courier New",monospace;letter-spacing:0.5px;color:#cfdae4;'
    + 'background:rgba(12,18,24,0.55);border:1px solid rgba(120,150,180,0.25);border-radius:8px;'
    + 'padding:7px 9px;line-height:1.55;text-shadow:0 1px 2px rgba(0,0,0,0.7);';
  const rows = [
    ['#ff3b30', 'fighting a vehicle'],
    ['#ff9500', 'shelling a tower / keep'],
    ['#2f7bff', 'broken off, heading home'],
    ['#34c759', 'fuel / ammo / repair'],
    ['#ffffff', 'carrying the flag'],
    ['#8899a6', 'on the move'],
  ].map(([c, t]) => `<div><span style="display:inline-block;width:8px;height:8px;border-radius:50%;`
    + `background:${c};box-shadow:0 0 6px ${c};margin-right:7px;vertical-align:middle"></span>${t}</div>`).join('');
  _lightKey.innerHTML = rows + '<div style="margin-top:4px;opacity:0.65">pulsing = enemy in sight</div>';
  document.body.appendChild(_lightKey);
}
function updateStatusLights() {
  if (!aiStatusLights) return;
  if (onField && TEAM_CTRL[PLAYER_TEAM] !== 'human') { ensureLightKey(); _lightKey.style.display = ''; }
  else if (_lightKey) _lightKey.style.display = 'none';
  const now = performance.now();
  for (const v of combatants) {
    if (v.dead || v.isPlayer) continue;       // the human already knows what they are doing
    if (vehicleHidden(v)) { if (v._statusLight) v._statusLight.grp.visible = false; continue; }
    const L = ensureStatusLight(v);
    L.grp.visible = true;
    const col = STATUS_COLORS[statusKeyFor(v)] || STATUS_COLORS.travel;
    L.mat.color.setHex(col);
    L.halomat.color.setHex(col);
    // PULSE = live line of sight. _seesEnemy is the sight test that gates firing, NOT the 12s
    // contact memory (which hearing and incoming fire also write) — so a pulsing lamp means the
    // unit can shoot at something right now, and a steady one means it is working from memory.
    const seen = !!v._seesEnemy;
    const k = seen ? 0.55 + 0.45 * Math.abs(Math.sin(now * 0.006)) : 0.7;
    L.halomat.opacity = k;
    const s = seen ? 5.4 + k * 2.6 : 4.4;
    L.halo.scale.set(s, s, 1);
  }
}

function updatePlayerHud() {
  const hp = document.getElementById('hp-fill'), fu = document.getElementById('fuel-fill');
  const wrap = document.getElementById('player-bars');
  if (!wrap) return;
  if (!player || player.dead) { wrap.style.display = 'none'; return; }
  wrap.style.display = '';
  if (hp) { const f = Math.max(0, player.hp / player.maxHp); hp.style.width = (f * 100) + '%';
    hp.style.background = f > 0.5 ? '#4fd14f' : f > 0.25 ? '#e0c020' : '#e04020'; }
  if (fu) fu.style.width = (Math.max(0, player.fuel / player.maxFuel) * 100) + '%';
  const am = document.getElementById('ammo-fill'), amTxt = document.getElementById('ammo-txt');
  if (am) { const f = Math.max(0, player.ammo / player.maxAmmo); am.style.width = (f * 100) + '%';
    am.style.background = player.ammo > 0 ? '#cf6f3a' : '#7a2a2a'; }
  if (amTxt) amTxt.textContent = `${player.ammo}`;
  const shRow = document.getElementById('shield-row'), sh = document.getElementById('shield-fill');
  if (shRow) shRow.style.display = player.shield > 0 ? 'flex' : 'none';
  if (sh) sh.style.width = (Math.max(0, player.shield / player.maxShield) * 100) + '%';
  updateGadgetButtons();
}

// ── Firebrat gadget deploy: LAND MINE + SENSOR POD ───────────────────────────
// Two buttons appear at the bottom while you drive a Firebrat. Mines are limited (2 per
// trip, 12 per team); pods are FIFO-capped at 3 per team. Also bound to M (mine) / N (pod).
function playerIsFirebrat() { return onField && player && !player.dead && player.type === 'firebrat'; }
let gadgetBar = null;
function ensureGadgetButtons() {
  if (gadgetBar) return;
  const st = document.createElement('style');
  st.textContent =
    '#gadget-bar{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);z-index:58;display:none;gap:14px;}' +
    '#gadget-bar.show{display:flex;}' +
    '#gadget-bar button{font-family:inherit;min-width:96px;padding:10px 12px;border-radius:12px;cursor:pointer;' +
    'background:rgba(18,26,34,0.82);border:1px solid rgba(120,150,180,0.4);color:#dfeaf2;box-shadow:0 2px 8px rgba(0,0,0,0.45);' +
    'font-size:12px;letter-spacing:1px;line-height:1.3;transition:background .1s,transform .06s;}' +
    '#gadget-bar button:active{transform:scale(0.95);}' +
    '#gadget-bar button:disabled{opacity:0.4;cursor:default;}' +
    '#gadget-bar button .g-n{display:block;font-size:16px;font-weight:bold;color:#8fd3ff;}' +
    '#gadget-bar button.ok{background:rgba(40,90,60,0.9);} #gadget-bar button.no{background:rgba(96,36,32,0.9);}';
  document.head.appendChild(st);
  gadgetBar = document.createElement('div');
  gadgetBar.id = 'gadget-bar';
  gadgetBar.innerHTML =
    '<button id="mine-btn" title="Lay a land mine (M)">MINE<span class="g-n" id="mine-n">2</span></button>' +
    '<button id="pod-btn" title="Drop a sensor pod (N)">SENSOR<span class="g-n" id="pod-n">0/3</span></button>';
  document.body.appendChild(gadgetBar);
  document.getElementById('mine-btn').addEventListener('pointerdown', e => { e.preventDefault(); deployMine(); });
  document.getElementById('pod-btn').addEventListener('pointerdown', e => { e.preventDefault(); deployPod(); });
}
// Master volume knob, top-left. Persists to localStorage('rmrf-volume') and pushes the value
// into the SoundManager (which also seeds itself from the same key if audio starts later). A
// speaker glyph toggles a slider so it stays out of the way until you want it.
let volCtl = null;
function ensureVolumeControl() {
  if (volCtl) return;
  const saved = parseFloat(localStorage.getItem('rmrf-volume'));
  const v0 = isFinite(saved) ? Math.max(0, Math.min(1, saved)) : 1;
  const st = document.createElement('style');
  st.textContent =
    '#vol-ctl{position:fixed;top:12px;left:12px;z-index:120;display:flex;align-items:center;gap:8px;' +
    'background:rgba(18,26,34,0.72);border:1px solid rgba(120,150,180,0.35);border-radius:10px;padding:6px 9px;' +
    'box-shadow:0 2px 8px rgba(0,0,0,0.4);font-family:inherit;}' +
    '#vol-ctl .vico{cursor:pointer;font-size:16px;line-height:1;color:#cfe0ee;user-select:none;}' +
    '#vol-ctl input[type=range]{width:96px;accent-color:#8fd3ff;cursor:pointer;}' +
    '#vol-ctl.mini input{display:none;}';
  document.head.appendChild(st);
  volCtl = document.createElement('div');
  volCtl.id = 'vol-ctl';
  volCtl.innerHTML = '<span class="vico" title="Volume">' + (v0 <= 0 ? '🔇' : '🔊') + '</span>' +
    '<input type="range" min="0" max="1" step="0.02" value="' + v0 + '">';
  document.body.appendChild(volCtl);
  const ico = volCtl.querySelector('.vico'), slider = volCtl.querySelector('input');
  const apply = v => { localStorage.setItem('rmrf-volume', String(v)); if (sound) sound.setMasterVolume(v); ico.textContent = v <= 0 ? '🔇' : '🔊'; };
  slider.addEventListener('input', () => apply(parseFloat(slider.value)));
  ico.addEventListener('click', () => volCtl.classList.toggle('mini'));
}
function flashGadget(id, ok) {
  const b = document.getElementById(id); if (!b) return;
  b.classList.remove('ok', 'no'); void b.offsetWidth; b.classList.add(ok ? 'ok' : 'no');
  setTimeout(() => b.classList.remove('ok', 'no'), 260);
}
function updateGadgetButtons() {
  ensureGadgetButtons();
  const show = playerIsFirebrat();
  gadgetBar.classList.toggle('show', show);
  if (!show) return;
  const charges = player._mineCharges || 0;
  const teamMines = minefield ? minefield.count(PLAYER_TEAM) : 0;
  const mineBtn = document.getElementById('mine-btn'), mineN = document.getElementById('mine-n');
  if (mineN) mineN.textContent = String(charges);
  if (mineBtn) mineBtn.disabled = charges <= 0 || teamMines >= MINE.teamCap;
  const podN = document.getElementById('pod-n');
  if (podN) podN.textContent = (sensorNet ? sensorNet.count(PLAYER_TEAM) : 0) + '/' + POD.teamCap;
}
function deployMine() {
  if (!playerIsFirebrat() || (player._mineCharges || 0) <= 0) { flashGadget('mine-btn', false); return; }
  const p = player.holder.position;
  const m = minefield.place(p.x, p.z, PLAYER_TEAM, teamColor(PLAYER_TEAM), player);
  if (m) bumpNavEpoch();   // AI teammates route around the player's fresh mine too
  if (m) { player._mineCharges--; gadgetStats.minesLaid++; flashGadget('mine-btn', true); } else flashGadget('mine-btn', false);
  updateGadgetButtons();
}
function deployPod() {
  if (!playerIsFirebrat()) return;
  const p = player.holder.position;
  if (sensorNet.place(p.x, p.z, PLAYER_TEAM, teamColor(PLAYER_TEAM))) gadgetStats.podsLaid++;
  flashGadget('pod-btn', true);
  updateGadgetButtons();
}

// --- Teams, flags, and AI commanders -----------------------------------
// A "commander" runs one team: a single active vehicle at a time, deployed from
// its base, pursuing the CTF objective (scout → smash the enemy's fortifications
// → send a Firebrat to steal their flag). It's one class per team, so any team
// can be AI — enabling AI-vs-AI and (with more bases) N independent sides. A
// HUMAN team is run by the player drive/deploy code instead. Perception is
// team-relative (a unit only knows rivals it actually sees), so nothing cheats.
let AI_VISION = 66;   // base sight range (tunable via RR.setVision)
// Per-vehicle VISION: SIGHT = how far this type SEES; VIS = how far it's SEEN. Effective visual
// detection of a target = AI_VISION × (SIGHT[observer] + VIS[target]) / 2. So the Valkyrie
// (airborne) both sees and is seen from range; the Firebrat (small, hugs terrain) is spotted up
// close; the Jotun is a big obvious target. Tunable via RR.setSight / RR.setVis.
const SIGHT = { valkyrie: 1.5, lurcher: 1.0, firebrat: 1.0, jotun: 0.85 };
const VIS   = { valkyrie: 1.5, jotun: 1.3, lurcher: 1.0, firebrat: 0.65 };
// SIGHT CONE: a unit sees best where it LOOKS, not all around. Full visual range in the
// forward ~90°-wide arc (±45°), tapering to HALF range at the flanks (90° off), then to
// BLIND behind (135°+). A turreted unit aims the cone by its TURRET (the Lurcher watches
// wherever its gun points — idle-sweeping ±34° when parked, snapping onto a target when it
// engages); the Firebrat/Valkyrie have no turret, so they watch straight ahead by hull. The
// falloff is gradual (no hard step), and it ONLY gates enemy visual detection — sound stays
// a full 360° (soundSources), so a unit still HEARS whatever flanks it and turns to look.
// Supply/scrap discovery stays 360° for now (this slice is about combat stealth). Tunable/
// toggleable via RR.setSightCone + RR.setConeAngles for the A/B tournament.
let sightCone = !QS.has('nocone');
const CONE = { full: Math.PI / 4, half: Math.PI / 2, blind: Math.PI * 0.75 };   // ±45° full, 90° half, 135° blind
// SCAN-ON-TRANSITION ("check the surroundings"): a unit that just finished something LOUD — it
// dropped a tower it was sieging, or killed the enemy it was fighting — pauses, before rolling
// off to its next objective, to sweep its surroundings once. The noise it made draws defenders,
// so this is the visible "is the coast clear?" beat: a sneaking player sees the barrel come
// around and aborts. A visible enemy ALWAYS wins (never scan with a target in sight). Only the
// Lurcher (sweeps its turret) and Jotun (turns its heavy body — 30° turret can't scan); the
// Firebrat/Valkyrie sit this out. Needs the cone to mean anything (a 360° unit already sees all
// around). Toggle RR.setScan / tune RR.setScanParams.
let aiScan = !QS.has('noscan');
const SCAN = { arc: 5.76, max: 3.0, rate: 3.4, cool: 6000 };   // sweep ~330°, hard-cap 3s, Lurcher turret 3.4 rad/s, 6s per-unit cooldown
function coneFactor(offAbs) {
  if (offAbs <= CONE.full)  return 1;
  if (offAbs <= CONE.half)  return 1 - 0.5 * (offAbs - CONE.full) / (CONE.half - CONE.full);    // 1 → 0.5
  if (offAbs <= CONE.blind) return 0.5 * (1 - (offAbs - CONE.half) / (CONE.blind - CONE.half)); // 0.5 → 0
  return 0;                                                                                      // behind → blind
}
// AI HEARING: how loud (same 0..1 audibility scale as the sound HUD) an unseen rival must
// be before a unit investigates the noise. A heard contact only steers navigation — it is
// NEVER a firing solution (enemy/seesEnemy stay line-of-sight). Gunfire easily clears this;
// a moving Jotun's drone clears it at range; an idling unit barely makes a whisper.
const AI_HEARD_MIN = 0.18;
const SHIELD_GRAB_RANGE = 130;  // max detour a Lurcher/Valkyrie will take to top up at a known shield generator
const GUARD_GEN_DWELL = 25000;  // ms a patrolling guard holds ON the shield generator each lap (turtle v2)
let turtleGuardOn = true;       // A/B: turtle v2 (slot-kill gate + gen guarding + maintenance) — RR.setTurtleGuard
const SHIELD_COMMIT = 60;       // once this close to the wanted gen, COMMIT — grab the armour before fighting
// THE GAP. A single number can't be both "start wanting armour" and "stop wanting armour": a
// shield sitting on one line flips the decision every time it wobbles across, and under fire at a
// generator it wobbles every second. Want it below 60%, done at 95% — so topping up ENDS the job
// instead of instantly un-justifying it. Same shape as SUPPLY_FULL below.
const SHIELD_WANT = 0.6;        // below this fraction of max armour, go top up
const SHIELD_FULL = 0.95;       // …and stay until this full (not merely back over the want line)
const SHIELD_CAMP_R = 40;       // "on the generator" radius — hold here and fight from the armour top-up
let SHIELD_SIGHT_MULT = 1.4;    // shield beacon spotted at this × base vision. Tall & glowing so it carries
                                // past a crate, but NOT half the map — a shield is a reason to SCOUT, not a
                                // freebie. Runtime-tunable via RR.setShieldSight for A/B.
// Shield-doctrine narration: the commander calls the play in plain English (like the Rogue bark). One
// pool per tactic; a per-commander counter cycles them (no RNG → deterministic).
const SHIELD_BARKS = {
  grab:    ['armour up first — then we fight', 'grabbing the shield before this gets ugly', 'topping off on the way in', 'not charging in bare — shield first'],
  camp:    ['holding the generator — come and get it', 'digging in on the armour', 'this shield is mine — hold here', 'let them come to me, I\'ll be armoured'],
  contest: ['they\'re turtling on the shield — push them off it', 'go break up their armour party', 'they don\'t get to sit on that generator', 'deny them the shield — move in'],
  deny:    ['wreck that generator — no armour for them', 'take out the shield, then take the base', 'smash the generator so they stop leaning on it', 'no more free armour — level the shield'],
};
function shieldBark(cmd, v, kind) {
  const pool = SHIELD_BARKS[kind]; cmd._sbN = (cmd._sbN || 0) + 1;
  aiLog(cmd.team, `${cmd.cname} ${v.type}: “${pool[cmd._sbN % pool.length]}”`);
}
const commanders = [];          // one AICommander per AI-controlled team

function teamCamp(team, role) { return camps.find(c => c.team === team && c.role === role); }
function teamCenter(team, role) { const c = teamCamp(team, role); return c ? c.center : { x: 0, z: 0 }; }
// Total standing wall HP of a team's bases (what an attacker must grind down).
function fortHpOf(team) {
  let s = 0;
  for (const c of camps) if (c.team === team) for (const w of c.walls) if (w.body && !w.body.dead) s += w.body.hp;
  return s;
}
// Live defensive turrets a team still has — the towers that actually shoot attackers.
// The commander uses this for tower-first ordering (don't send a runner into live towers).
// Pass role='main' to count ONLY the flag-HQ camp's turrets (the ones that gate a flag
// steal); the FOB/elevator turrets are optional and shouldn't hold back the win logic.
function turretCountOf(team, role = null) {
  let n = 0;
  for (const c of camps) if (c.team === team && (!role || c.role === role)) for (const w of c.walls) {
    const t = w.turret; if (t && !t.dead && !t.falling) n++;
  }
  return n;
}

// Capturable flag at every main base. Stolen by any rival unit touching it;
// captured when carried home to the thief's own main base.
const flags = [];
// Woven-fabric texture for the flag cloth — a near-white weave (tinted by the team colour via
// the material's `color`) with a darker vertical HOIST band at the pole edge (UV u=0).
let _flagTex = null;
function flagFabricTexture() {
  if (_flagTex) return _flagTex;
  const S = 64, cv = document.createElement('canvas'); cv.width = cv.height = S;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#ededed'; ctx.fillRect(0, 0, S, S);
  ctx.globalAlpha = 0.10;                                   // subtle woven cross-hatch
  for (let i = 0; i < S; i += 3) { ctx.fillStyle = (i / 3) % 2 ? '#ffffff' : '#9a9a9a'; ctx.fillRect(i, 0, 1.5, S); ctx.fillRect(0, i, S, 1.5); }
  ctx.globalAlpha = 0.5; ctx.fillStyle = '#3a3a3a'; ctx.fillRect(0, 0, 4, S);   // hoist band
  _flagTex = new THREE.CanvasTexture(cv);
  return _flagTex;
}
// Ripple a segmented cloth with a travelling sine wave — amplitude grows toward the free (fly)
// end so it's pinned at the pole and flaps at the tip. z is the out-of-plane axis (the cloth
// faces +z), so this reads as fabric waving; the carried orientation aims that wave rearward.
function flapCloth(cloth, t, amp) {
  const g = cloth.geometry, pos = g.attributes.position;
  if (!g.userData.base) g.userData.base = pos.array.slice();
  const base = g.userData.base;
  for (let i = 0; i < pos.count; i++) {
    const x = base[i * 3], y = base[i * 3 + 1];
    const hoist = (x + 1.4) / 2.8;                          // 0 at the pole, 1 at the fly end
    pos.setZ(i, (Math.sin(x * 3 + t * 7) * amp + Math.sin(y * 4 + t * 5) * amp * 0.3) * hoist);
  }
  pos.needsUpdate = true; g.computeVertexNormals();
}

function buildFlags() {
  for (const f of flags) scene.remove(f.group);
  flags.length = 0;
  for (const c of camps) {
    if (c.role !== 'main') continue;
    // Match the camp's live accent (team colour), so a player-chosen colour shows
    // on the flag too — not a hard-coded red/blue. Recoloured on team-colour lock.
    const hex = '#' + c.accent.getHexString();
    const g = new THREE.Group();
    const tilt = new THREE.Group(); g.add(tilt);   // inner group: leans back when carried, so the outer yaw + this lean don't fight in one Euler
    const H = 8;
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, H, 6),
      new THREE.MeshStandardMaterial({ color: 0x9a9a9a, metalness: 0.6, roughness: 0.4 }));
    pole.position.y = H / 2; tilt.add(pole);
    const cloth = new THREE.Mesh(new THREE.PlaneGeometry(2.8, 1.6, 14, 5),
      new THREE.MeshStandardMaterial({ color: hex, map: flagFabricTexture(), emissive: hex, emissiveIntensity: 0.16, roughness: 0.85, metalness: 0, side: THREE.DoubleSide }));
    cloth.position.set(1.4, H - 1.1, 0); tilt.add(cloth);
    const gx = c.center.x, gz = c.center.z, gy = map.heightAt(gx, gz);
    g.position.set(gx, gy, gz);
    // The HQ wears the flag on its roof; this capturable pole stays HIDDEN inside
    // until the building is levelled — then it's revealed in the rubble and drops
    // to the ground (see updateFlags) for a Firebrat to grab.
    g.visible = false;
    scene.add(g);
    flags.push({ team: c.team, group: g, tilt, cloth, hqBody: c.flagHQ || null, revealed: false, dropT: 0,
      home: { x: gx, y: gy, z: gz }, carried: false, carrier: null, returnT: 0 });
  }
}
// Tint a team's capturable flag to a chosen colour (player team-colour lock).
function recolorFlag(team, hex) {
  for (const f of flags) if (f.team === team) { f.cloth.material.color.set(hex); f.cloth.material.emissive.set(hex); }
}
// Recolour one mesh group to a team colour, the same way Camp.setAccent does for base
// structures: tint accent-flagged bands, and re-skin any baked camo (towers/lookouts).
function recolorGroup(group, hex, accent) {
  group.traverse(o => {
    if (!o.isMesh || !o.material) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (m.userData && m.userData.accent) m.color.set(hex);
      if (m.userData && m.userData.camo) recolorCamo(m, accent);
    }
  });
}
// A team locked its colour → make its designed-map props AND standalone fort pieces
// (walls/towers/bastions, which aren't part of a Camp) follow the exact chosen colour.
function recolorPlaced(team, hex) {
  const accent = new THREE.Color(hex);
  for (const g of placedProps) if (g.userData.team === team) recolorGroup(g, hex, accent);
  for (const w of placedWalls) if (w._team === team && w.group) {
    recolorGroup(w.group, hex, accent);
    if (w.accent) w.accent.set(hex);
    w._syncAccentInstance && w._syncAccentInstance();   // instanced segments tint via instanceColor
  }
}
// Nearest rival flag to `team`'s base (its steal target).
function enemyFlagOf(team) {
  const home = teamCenter(team, 'fob');
  let best = Infinity, f = null;
  for (const fl of flags) {
    if (fl.team === team) continue;
    const d = (fl.group.position.x - home.x) ** 2 + (fl.group.position.z - home.z) ** 2;
    if (d < best) { best = d; f = fl; }
  }
  return f;
}
function updateFlags(dt) {
  if (matchOver) return;
  const GRAB = 6, CAP = 12, CAP_FOB = 16;   // FOB capture zone a touch wider (the deck)
  const DROP_FROM = 12, DROP_DUR = 1.1;     // flag falls ~12u from the roofline over ~1.1s
  for (const f of flags) {
    // The flag is sealed inside its HQ until the building is rubble. On the kill,
    // reveal it and let it FALL from the roofline to the ground at the rubble.
    if (!f.revealed) {
      if (f.hqBody && f.hqBody.dead) {
        f.revealed = true; f.group.visible = true; f.dropT = DROP_DUR;
        showBanner(`${flagColorName(f)} HQ DOWN — FLAG EXPOSED`, { color: '#ffd0a0' });
      } else if (!f.carried) { continue; }   // still entombed and not in play — skip
    }
    // Ripple the cloth every frame it's in play (bigger amplitude when carried — it's
    // streaming through the air); a standing flag stays upright.
    flapCloth(f.cloth, performance.now() / 1000, f.carried ? 0.42 : 0.14);
    if (!f.carried) { f.group.rotation.y = 0; f.tilt.rotation.z = 0; }
    if (f.dropT > 0 && !f.carried) {          // gravity-ish drop into the rubble
      f.dropT = Math.max(0, f.dropT - dt);
      const e = 1 - f.dropT / DROP_DUR;       // 0 (top) -> 1 (ground)
      f.group.position.y = f.home.y + DROP_FROM * (1 - e * e);
    }
    if (f.carried && f.carrier) {
      // …and did the run get abandoned for fuel? Latched per carrier, so a refuel that lasts a
      // hundred ticks counts once. This is the failure the alarm exists for: a working flag run
      // goes home FIRST, and the tank is a timer, not a range.
      { const oc = commanders.find(c => c.ownsUnit && c.ownsUnit(f.carrier));
        const step = oc && oc.strategy ? oc.strategy.step : null;
        if (step === 'refuel') { if (!f.carrier._refuelCounted) { f.carrier._refuelCounted = 1; carrierRefuelsTotal++; } }
        else if (f.carrier._refuelCounted) f.carrier._refuelCounted = 0;
        // THE RUN LEDGER. Distance is measured to homePos() — the FOB — because that is what
        // Capture.objective actually hands the driver, and it is a scoring point (CAP_FOB). The
        // flag STAND is not the target and measuring to it reports a winning run as finishing
        // 143u short, which is how that mistake announces itself.
        if (oc && !f.carrier.dead) {
          const p = f.carrier.holder.position, h = oc.homePos();
          const d = Math.hypot(p.x - h.x, p.z - h.z), now = oc._matchT || 0;
          const run = f.carrier._carryRun || (f.carrier._carryRun = { t0: now, d0: d, best: d, bestT: now, alarmed: false });
          // Only real ground counts as progress, so a runner jittering on the spot cannot keep
          // resetting the clock by shaving a tenth of a unit off its best.
          if (d < run.best - CARRY_STALL_D) { run.best = d; run.bestT = now; }
          if (!run.alarmed && now - run.bestT > CARRY_STALL_S) {
            run.alarmed = true; flagRunStalls++;
            const o = oc._driver && oc._driver.o;
            const ord = o ? `${o.by || '?'}:${o.type}${o.x != null ? ` → (${Math.round(o.x)},${Math.round(o.z)})` : ''}${o.violated ? ' [ORDER VIOLATED]' : ''} — ${o.why || 'no reason given'}` : 'NO ORDER AT ALL';
            flagRunStallList.push({ t: Math.round(now), team: f.carrier.team, type: f.carrier.type,
              px: Math.round(p.x), pz: Math.round(p.z), toFob: Math.round(d), d0: Math.round(run.d0),
              held: Math.round(now - run.t0), state: oc._dbg ? oc._dbg.state : null,
              mission: oc.strategy ? oc.strategy.step : null, primary: oc._primaryKey || null, ord });
            aiLog(f.carrier.team, `[FLAG RUN STALLED] ${oc.cname}: carrying for ${Math.round(now - run.t0)}s and no closer to home — `
              + `${Math.round(d)}u out (grabbed at ${Math.round(run.d0)}u, best ${Math.round(run.best)}u). Order: ${ord}`);
          }
        } }
      if (f.carrier.dead) {
        // Carrier killed (anywhere — including on the lift) → the flag drops where
        // it fell and STAYS there until a Firebrat re-grabs it (no auto-return).
        const c = f.carrier.holder.position;
        f.group.position.set(c.x, map.heightAt(c.x, c.z) + 0.2, c.z);
        flagRunsRunnerDied++; f.carrier._carryRun = null;
        f.carried = false; f.carrier = null;
      } else {
        const c = f.carrier.holder.position, hd = f.carrier.heading || 0;
        // Trail the flag BEHIND the carrier, yaw it so the fly streams to the REAR, and lean
        // the pole back — a captured banner planted on the tail. (Forward is (-sin,-cos)hd,
        // so BEHIND is +sin/+cos — the old minus signs hung the flag off the NOSE, floating
        // ahead of the Firebrat; and the fabric streamed forward. Both flipped.)
        f.group.position.set(c.x + Math.sin(hd) * 2.0, c.y + 1.5, c.z + Math.cos(hd) * 2.0);
        f.group.rotation.y = hd - Math.PI / 2;   // fabric spun 180° about the pole: fly points AFT
        f.tilt.rotation.z = -0.9;                // pole still leans BACKWARD (lean flips with the yaw flip)
        // AI carriers score by reaching their own base. The PLAYER must EXTRACT it —
        // ride the flag down the FOB lift into the secure garage (see returnToGarage).
        if (f.carrier !== player) {
          const main = teamCamp(f.carrier.team, 'main'), fob = teamCamp(f.carrier.team, 'fob');
          const atMain = main && Math.hypot(c.x - main.center.x, c.z - main.center.z) < CAP;
          const atFob = fob && Math.hypot(c.x - fob.center.x, c.z - fob.center.z) < CAP_FOB;
          if (atMain || atFob) onCapture(f.carrier.team, f);
        }
        continue;
      }
    }
    if (!f.carried) {                                  // a dropped/displaced flag on the ground
      const fx = f.group.position.x, fz = f.group.position.z;
      const displaced = Math.hypot(fx - f.home.x, fz - f.home.z) > GRAB;
      for (const v of combatants) {
        if (v.dead) continue;
        if (Math.hypot(v.holder.position.x - fx, v.holder.position.z - fz) >= GRAB) continue;
        if (v.team === f.team) {
          // Classic CTF return: ANY teammate reaching its DISPLACED flag recovers it —
          // snaps straight home (you can't carry your own flag; denies the thief a re-grab).
          // An AT-HOME flag is untouched — a teammate parked on it doesn't shield the steal.
          if (!displaced) continue;
          f.group.position.set(f.home.x, f.home.y, f.home.z); showBanner(`${flagColorName(f)} FLAG RECOVERED`, { color: '#9bd6ff' });
        } else {
          // Stealing (carrying it off) stays FIREBRAT-only — it's the runner class.
          if (v.type !== 'firebrat') continue;
          f.carried = true; f.carrier = v; flagCarriesTotal++;
          showBanner(`${flagColorName(f)} FLAG TAKEN`, { color: '#' + f.cloth.material.color.getHexString() });
          const oc = commanders.find(c => c.team === f.team);   // scorecard: the owners lost their flag on somebody's watch
          if (oc) { oc.flagsLost = (oc.flagsLost || 0) + 1; oc._lastFlagLostT = oc._matchT; }
        }
        break;
      }
    }
  }
}
// Carrying a rival flag home to your main base WINS the match.
function onCapture(team, f) {
  flagRunsScored++;
  if (f.carrier) f.carrier._carryRun = null;
  f.carried = false; f.carrier = null; f.returnT = 0;
  f.group.position.set(f.home.x, f.home.y, f.home.z);
  endMatch(team);
}

// --- Resupply points of interest (neutral, contested, destructible) -----------
// Fuel tanks / ammo depots / shield generators dotted around the open map. Any
// vehicle of either team that lingers nearby gets topped up (fuel/ammo/shield);
// destroying one denies it to everyone. A vehicle also resupplies (fuel + ammo)
// at its OWN base/FOB.
const FUEL_RATE = 28, AMMO_RATE = 6, SHIELD_RATE = 55, REPAIR_RATE = 13;   // per second

// Find an open land point ~targetR from map centre, clear of bases and each other.
// A supply depot has a real footprint (radius ~2.2 cells), so a road-free CENTRE cell isn't
// enough — a road running under its body still poked through (the ammo-depot-on-the-road bug).
// Check every cell within the footprint (+ a little margin), not just the centre.
function roadUnderFootprint(x, z, worldR) {
  if (!roadNet.cells) return false;
  const c = grid.cell, ci = Math.round(x / c), cj = Math.round(z / c), n = Math.ceil(worldR / c);
  for (let di = -n; di <= n; di++) for (let dj = -n; dj <= n; dj++)
    if (di * di + dj * dj <= (n + 0.35) * (n + 0.35) && roadNet.cells.has((ci + di) + ',' + (cj + dj))) return true;
  return false;
}

const DEPOT_BODY_R = grid.cell * 2.6;   // the depot's own footprint — the radius the road test uses
const SCRAP_HQ_CLEAR = 100;             // u — beached salvage stays this far off a FLAG HQ (Jacob)
// HOW FAR A DEPOT MUST SIT FROM A BASE, and this used to be a flat 28u measured CENTRE TO CENTRE,
// which is the same mistake `roadUnderFootprint` above exists to fix: it ignores the depot's own
// body. A main camp is CAMP_SIZE(9) x 5u = 45u across, so its wall ring is 22.5u out; a depot
// centred at the old legal minimum of 28u has a 13u body running from 15u to 41u — straight
// THROUGH the wall. The result is a supply stack half-buried in the ring, pinched between the wall
// and whatever is behind it, that no hull can reach: it looks placed, it is scored as a known
// supply, and units route to it and grind. Measure both footprints and leave driving room.
function campClearance(c) {
  const half = ((c.role === 'main' ? CAMP_SIZE : FOB_SIZE) / 2) * grid.cell;
  return half + DEPOT_BODY_R + grid.cell * 2;   // camp footprint + depot body + a lane to drive round it
}
function neutralSite(targetR) {
  for (let t = 0; t < 240; t++) {
    const ang = Math.random() * Math.PI * 2;
    const r = targetR * (0.78 + Math.random() * 0.44);
    const x = Math.cos(ang) * r, z = Math.sin(ang) * r;
    if (!map.isLand(x, z) || blockedAt(x, z)) continue;
    if (roadUnderFootprint(x, z, DEPOT_BODY_R)) continue;   // keep the whole depot BODY off roads/bridges, not just its centre cell
    let ok = true;
    for (const c of camps) if (Math.hypot(x - c.center.x, z - c.center.z) < campClearance(c)) { ok = false; break; }
    if (ok) for (const rp of resupplies) if (Math.hypot(x - rp.pos.x, z - rp.pos.z) < 24) { ok = false; break; }
    if (ok) return { x, z };
  }
  return null;
}

// A neutral site on the PERPENDICULAR BISECTOR of the two FOBs: every point on it is
// equidistant from both elevators (fair — favours neither team), and we push out along
// it to a flank so the shield is a contested, hard-to-reach prize rather than sitting in
// one team's lap. Sweeps from far-flank inward, alternating sides, until it hits clear
// land; falls back to the radial neutralSite if the geometry doesn't cooperate.
function bisectorSite(reach) {
  const fobs = camps.filter(c => c.role === 'fob');
  if (fobs.length < 2) return neutralSite(reach);
  const a = fobs[0].center, b = fobs[1].center;
  const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
  let dx = b.x - a.x, dz = b.z - a.z; const d = Math.hypot(dx, dz) || 1; dx /= d; dz /= d;
  const px = -dz, pz = dx;                          // perpendicular to the base-to-base line
  const baseOff = Math.min(d * 0.45, reach * 1.4);  // how far out to the flank to try first
  for (let t = 0; t < 80; t++) {
    const sign = (t % 2 === 0) ? 1 : -1;            // try both flanks
    const off = baseOff * (1 - (t / 80) * 0.75) * (0.9 + Math.random() * 0.2);
    const x = mx + px * off * sign, z = mz + pz * off * sign;
    if (!map.isLand(x, z) || blockedAt(x, z)) continue;
    if (roadUnderFootprint(x, z, DEPOT_BODY_R)) continue;   // keep the whole depot BODY off roads/bridges, not just its centre cell
    let ok = true;
    for (const c of camps) if (Math.hypot(x - c.center.x, z - c.center.z) < campClearance(c)) { ok = false; break; }
    if (ok) for (const rp of resupplies) if (Math.hypot(x - rp.pos.x, z - rp.pos.z) < 24) { ok = false; break; }
    if (ok) return { x, z };
  }
  return neutralSite(reach);
}

const RESUPPLY_MAKE = { fuel: makeFuelTank, ammo: makeAmmoDepot, shield: makeShieldGenerator };
// WHAT HAPPENS WHEN A DUMP GOES UP — shared, because there are TWO places that build resupply
// points (authored map assets and the procedural placement) and only one of them had the fire.
// On a generated map — every normal game — a fuel dump blew up in silence. Two builders of the
// same thing, one of them quietly missing a behaviour, is the same defect shape as everything
// else: give them one callback and it cannot drift again.
function resupplyDestroyed(rp, kind) {
  rp.dead = true;
  // A fuel or diesel dump is the one that should really go up. Same fire for now, just a bigger
  // one; giving fuel a longer burn than a vehicle is the obvious next refinement.
  fireBurst(rp.pos.x, rp.pos.y, rp.pos.z, kind === 'fuel' ? 1.9 : 1.5);
}
const RESUPPLY_HP = { fuel: 130, ammo: 150, shield: 110 };
// Build one resupply POI at a world site and register it (shared by auto + placed).
function addResupply(kind, site) {
  const g = RESUPPLY_MAKE[kind](grid.cell);
  const gy = map.heightAt(site.x, site.z);
  g.position.set(site.x, gy + 0.06, site.z);   // tiny lift so the base doesn't z-fight the terrain
  scene.add(g);
  const rp = { kind, group: g, pos: new THREE.Vector3(site.x, gy, site.z), radius: grid.cell * 2.2, dead: false };
  applyStaging(g, kind);   // authored fallAt/dmgStyle (if any) before the Destructible reads them
  destructibles.add(new Destructible(g, { type: 'structure', hp: RESUPPLY_HP[kind] || 130, blocks: true, staged: true,
    onDestroyed: () => resupplyDestroyed(rp, kind) }));
  resupplies.push(rp);
  return rp;
}
function placeResupplies() {
  for (const r of resupplies) scene.remove(r.group);
  resupplies = [];
  if (QS.has('nopoi')) return;
  // Custom map: use the DESIGNER-placed fuel/ammo/shield points (not auto-scatter). A map
  // that places none simply has no resupply — the author's call.
  if (configBases) {
    const assets = (MAP_CFG && MAP_CFG.overrides && MAP_CFG.overrides.assets) || [];
    for (const a of assets) {
      if (!RESUPPLY_MAKE[a.id]) continue;
      addResupply(a.id, siteOfCell(a.cx, a.cz));
    }
    scene.updateMatrixWorld(true);
    destructibles.refreshAll();
    return;
  }
  const span = Math.min(map.worldW, map.worldH) / 2;
  const cell = grid.cell;
  // fuel + ammo near the contested middle; the shield generator sits out on the FLANK,
  // on the bisector between the two elevators — equidistant + hard to grab (see bisectorSite).
  const specs = [
    { kind: 'fuel',   r: span * 0.26, make: makeFuelTank,        hp: 130 },
    { kind: 'ammo',   r: span * 0.32, make: makeAmmoDepot,       hp: 150 },
    { kind: 'shield', r: span * 0.52, make: makeShieldGenerator, hp: 110, bisect: true },
  ];
  for (const sp of specs) {
    const site = sp.bisect ? bisectorSite(sp.r) : neutralSite(sp.r);
    if (!site) continue;
    const g = sp.make(cell);
    const gy = map.heightAt(site.x, site.z);
    g.position.set(site.x, gy + 0.06, site.z);   // tiny lift so the base doesn't z-fight the terrain
    scene.add(g);
    const rp = { kind: sp.kind, group: g, pos: new THREE.Vector3(site.x, gy, site.z), radius: cell * 2.2, dead: false };
    applyStaging(g, sp.kind);   // authored fallAt/dmgStyle (if any) before the Destructible reads them
    destructibles.add(new Destructible(g, { type: 'structure', hp: sp.hp, blocks: true, staged: true,
      onDestroyed: () => resupplyDestroyed(rp, sp.kind) }));
    resupplies.push(rp);
  }
  scene.updateMatrixWorld(true);   // position before measuring bounds (worldCenter trap)
  destructibles.refreshAll();
}

function refuel(v, dt) {
  if (v.fuel >= v.maxFuel) return;
  v.fuel = Math.min(v.maxFuel, v.fuel + FUEL_RATE * dt);
  if (v.isPlayer) updatePlayerHud();
}
function rearm(v, dt) {
  if (v.ammo >= v.maxAmmo) return;
  v._ammoAcc += AMMO_RATE * dt;
  if (v._ammoAcc >= 1) {
    const n = Math.floor(v._ammoAcc); v._ammoAcc -= n;
    v.ammo = Math.min(v.maxAmmo, v.ammo + n);
    if (v.isPlayer) updatePlayerHud();
  }
}
// A hunter tending a live mine trap doesn't top all the way up — it holds a killable mid-health so
// it keeps luring pursuers onto the mines (the provoke phase does the actual wounding via tower fire).
function repairCap(v) {
  const cmd = commanders.find(c => c.ownsUnit(v));
  const sl = cmd && cmd._slotFor(v);
  const strat = (sl && sl.strategy) || (cmd && cmd.strategy);
  if (cmd && cmd._trapMode && !cmd._trapDone && strat && strat.step === 'trap') return v.maxHp * 0.55;
  return v.maxHp;
}
function repair(v, dt) {
  const cap = repairCap(v);
  if (v.hp >= cap) return;
  v.hp = Math.min(cap, v.hp + REPAIR_RATE * dt);
  if (v.bar) updateHealthBar(v);
  if (v.isPlayer) updatePlayerHud();
}
function reshield(v, dt) {
  if (v.shield >= v.maxShield) return;
  v.shield = Math.min(v.maxShield, v.shield + SHIELD_RATE * dt);
  ensureShieldFx(v);
  if (v.isPlayer) updatePlayerHud();
}
// A flag base resupplies only while its HQ still stands — once the building is rubble
// (flag exposed) the wreckage can't rearm/refuel/heal anyone. The FOB (elevator) is a
// separate structure and keeps working.
function flagBaseAlive(team) {
  const f = flags.find(fl => fl.team === team);
  return !(f && f.hqBody && f.hqBody.dead);
}
function nearOwnSupply(v, vx, vz) {
  const main = teamCamp(v.team, 'main'), fob = teamCamp(v.team, 'fob');
  if (main && flagBaseAlive(v.team) && Math.hypot(vx - main.center.x, vz - main.center.z) < 16) return true;
  if (fob && Math.hypot(vx - fob.center.x, vz - fob.center.z) < 12) return true;
  return false;
}

// ELEVATOR ANTI-CAMP shield: a vehicle surfacing on its FOB lift is fully protected so an enemy
// can't sit at the elevator mouth and farm it. Active while it's ON the pad AND within the time
// cap after surfacing (whichever ends first) — so it can't park behind the shield to camp.
const ELEV_SHIELD_MS = 5000;
// Is an enemy close enough that the elevator shield is worth standing in? Measured against OUR
// OWN reach: if we can shoot it, it can very likely shoot us, and the doorway is the right place
// to trade from. Vehicles only — the pad sits inside our own base, so an enemy gun is not what
// keeps a unit on the lift.
function padThreatNear(v) {
  const reach = SHOT_REACH[v.type] || 42;
  const p = v.holder.position;
  for (const o of combatants) {
    if (o.dead || o.team === v.team || vehicleHidden(o)) continue;
    const dx = o.holder.position.x - p.x, dz = o.holder.position.z - p.z;
    if (dx * dx + dz * dz < reach * reach) return true;
  }
  return false;
}
function elevShieldOn(v) {
  return !!(v && v._elevShieldUntil && performance.now() < v._elevShieldUntil
    && elevatorPadAt(v.holder.position.x, v.holder.position.z));
}
function shieldUp(v) { return v.shield > 0 || elevShieldOn(v); }
function ensureShieldFx(v) {
  if (v._shieldFx) { v._shieldFx.visible = true; return; }
  // Build on a UNIT sphere (radius 1) scaled to the hull, so the force-field shader reads the
  // same at any size (its object-space is normalised). The cheap wireframe stays the default.
  const b = makeShieldBubble(1);
  const s = v.hitR * 1.5;
  b.scale.set(s, s * 0.7, s);
  b.position.y = 2.0;
  b.userData.cheapMat = b.material;
  v.holder.add(b);            // rides with the hull (holder is unscaled)
  v._shieldFx = b;
}
// --- FANCY force-field: only a few run the full shader at once (perf cap). Most shields keep
// the cheap wireframe bubble; the player's, the spectated unit's, and the nearest AI shields
// (up to RR_shieldCap) get the hex + fresnel + hit-ring shader. Pooled so materials (compiled
// shaders) are reused, never created/disposed per assignment.
let RR_shieldCap = 3;
const fancyPool = [];   // { mat, owner }
function isFancyMat(m) { return !!(m && m.userData && m.userData.hitCursor != null); }
function shieldTeamHex(v) { return (TEAM_COLORS[v.colorIndex] && TEAM_COLORS[v.colorIndex].hex) || '#26aeff'; }
function shieldPriority(v) {
  if (v === player) return -2;                       // the player's own shield always gets it
  if (v === spectateTarget || v === _specFocus) return -1;   // then whoever we're watching
  return camera.position.distanceToSquared(v.holder.position);   // then nearest to the camera
}
function releaseFancyShield(v) {   // hand a vehicle's fancy material back to the pool
  const b = v._shieldFx; if (!b) return;
  const slot = fancyPool.find(s => s.owner === v);
  if (slot) slot.owner = null;
  if (isFancyMat(b.material) && b.userData.cheapMat) b.material = b.userData.cheapMat;
}
function assignFancyShields() {
  const cap = Math.max(0, RR_shieldCap | 0);
  while (fancyPool.length < cap) fancyPool.push({ mat: makeShieldMaterial('#26aeff'), owner: null });
  const list = [];
  if (player && !player.dead && shieldUp(player)) { ensureShieldFx(player); list.push(player); }
  for (const v of combatants) if (!v.dead && v !== player && shieldUp(v)) { ensureShieldFx(v); list.push(v); }
  list.sort((a, b) => shieldPriority(a) - shieldPriority(b));
  const chosen = new Set(list.slice(0, cap));
  for (const slot of fancyPool) {   // free slots whose owner dropped out
    if (slot.owner && (!chosen.has(slot.owner) || slot.owner.dead || !shieldUp(slot.owner))) releaseFancyShield(slot.owner);
  }
  for (const v of chosen) {          // assign a free slot to any chosen vehicle not yet fancy
    const b = v._shieldFx;
    if (!b || isFancyMat(b.material)) continue;
    const slot = fancyPool.find(s => !s.owner);
    if (!slot) break;
    slot.owner = v;
    b.userData.cheapMat = b.material;
    slot.mat.userData.hitCursor = 0;
    for (let i = 0; i < slot.mat.uniforms.uHitTime.value.length; i++) slot.mat.uniforms.uHitTime.value[i] = -1e3;
    slot.mat.uniforms.uColor.value.set(shieldTeamHex(v));
    b.material = slot.mat;
  }
}
function updateShieldFx(v, dt) {
  if (!shieldUp(v)) { if (v._shieldFx) v._shieldFx.visible = false; return; }
  ensureShieldFx(v);   // the elevator shield has no pickup, so make the bubble on demand
  const b = v._shieldFx;
  b.visible = true;
  const life = (v.maxShield > 0 && v.shield > 0) ? v.shield / v.maxShield : 1;   // elevator shield reads full
  if (isFancyMat(b.material)) {
    stepShield(b.material, performance.now() / 1000, life, shieldTeamHex(v));
    return;   // the shader owns opacity/animation + hit rings
  }
  const hit = b.userData.hit || 0;
  b.material.opacity = 0.12 + 0.16 * life + hit * 0.6;
  if (hit > 0) b.userData.hit = Math.max(0, hit - dt * 3);
  b.rotation.y += dt * 0.6;
}

function updateResupplies(dt) {
  assignFancyShields();   // pick which few shields run the full force-field shader this frame
  for (const rp of resupplies) {
    if (!rp.dead && rp.kind === 'shield' && rp.group.userData.spin) rp.group.userData.spin.rotation.z += dt * 1.5;
  }
  for (const v of combatants) {
    if (v.dead) continue;
    const vx = v.holder.position.x, vz = v.holder.position.z;
    for (const rp of resupplies) {
      if (rp.dead || Math.hypot(vx - rp.pos.x, vz - rp.pos.z) > rp.radius) continue;
      if (rp.kind === 'fuel') refuel(v, dt);
      else if (rp.kind === 'ammo') rearm(v, dt);
      else if (rp.kind === 'shield') reshield(v, dt);
    }
    if (nearOwnSupply(v, vx, vz)) { refuel(v, dt); rearm(v, dt); repair(v, dt); }   // home base tops fuel + ammo + patches the hull
    updateShieldFx(v, dt);
  }
}

// --- SCRAP / SALVAGE ----------------------------------------------------
// ── Blood marks — a small dark splat left on the ground where a soldier is squished under a
// tread (and where a crushed tent's occupants were). Persistent + capped, cleared on rebuild.
// Reuses BlobShadow's flat-plane-on-ground decal trick (one canvas texture, shared material).
let _bloodTex = null;
function bloodTexture() {
  if (_bloodTex) return _bloodTex;
  const S = 256, cv = document.createElement('canvas'); cv.width = cv.height = S;
  const ctx = cv.getContext('2d');
  // SOLID splat — no soft gradients (they read as fuzzy). A hard-edged irregular main pool
  // (a wobbly polygon) + a few solid droplets. Only the shapes' own antialiased rims are soft.
  // DARK on purpose, and darker than the value you'd pick off a colour picker: the material is
  // unlit (MeshBasicMaterial), so this exact value is what draws, while the terrain around it is
  // lit and lands well below its own albedo. A "correct" blood red rendered flat-out read as
  // bright paint sitting on top of the ground rather than soaking into it.
  ctx.fillStyle = '#560a0a';
  ctx.beginPath();
  const lobes = 11;
  for (let i = 0; i <= lobes; i++) {
    const a = (i / lobes) * Math.PI * 2, rr = S * (0.24 + Math.random() * 0.13);
    const x = S / 2 + Math.cos(a) * rr, y = S / 2 + Math.sin(a) * rr;
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  }
  ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#380606';
  for (let i = 0; i < 9; i++) {                             // solid scattered droplets
    const a = Math.random() * 7, d = S * (0.28 + Math.random() * 0.18), r = S * (0.02 + Math.random() * 0.05);
    ctx.beginPath(); ctx.arc(S / 2 + Math.cos(a) * d, S / 2 + Math.sin(a) * d, r, 0, 7); ctx.fill();
  }
  _bloodTex = new THREE.CanvasTexture(cv);
  return _bloodTex;
}
const _bloodGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
let _bloodMat = null;
const bloodMat = () => _bloodMat || (_bloodMat = new THREE.MeshBasicMaterial({ map: bloodTexture(), transparent: true, opacity: 0.9, depthWrite: false }));
let bloodMarks = [];
const MAX_BLOOD = 40;
function addBloodMark(x, z, radius = 1.5) {
  const m = new THREE.Mesh(_bloodGeo, bloodMat());
  const r = radius * (0.8 + Math.random() * 0.5);
  m.scale.set(r * 2, 1, r * 2);
  const gy = roadDeckY(x, z); m.position.set(x, (gy != null ? gy : map.heightAt(x, z)) + 0.05, z);   // sit on the road slab if there's one under it
  m.rotation.y = Math.random() * Math.PI * 2;
  m.renderOrder = 1;                                        // draw over terrain, blend onto it
  scene.add(m); bloodMarks.push(m);
  while (bloodMarks.length > MAX_BLOOD) scene.remove(bloodMarks.shift());   // cap (shared geo/mat, nothing to dispose)
}

// Squishable tents: a ground vehicle that rolls over a tent flattens it (they're drive-through
// decoration, not nav obstacles) and leaves a blood mark — the occupants didn't make it out.
// Tents are tagged (userData.crushable) at build in Walls.js + the designed-map loader; the list
// is gathered lazily on the first field tick (positions are only final once the camp is placed).
let crushables = [], _crushBuilt = false;
const _crushWP = new THREE.Vector3();
function updateCrushables() {
  if (!_crushBuilt) {
    _crushBuilt = true; crushables = [];
    const consider = (obj) => {
      if (obj.userData && obj.userData.crushable && obj.userData.crushDest) {
        obj.getWorldPosition(_crushWP);
        crushables.push({ dest: obj.userData.crushDest, x: _crushWP.x, z: _crushWP.z, r: 3.6, crushed: false });
      }
    };
    for (const c of camps) if (c.buildings) for (const o of c.buildings) consider(o);
    for (const g of placedProps) consider(g);
  }
  if (!crushables.length) return;
  for (const t of crushables) {
    if (t.crushed || t.dest.dead) continue;
    for (const v of combatants) {
      if (v.dead || isFlyer(v) || vehicleHidden(v)) continue;   // flyers pass over; a unit down its lift shaft can't crush
      const dx = v.holder.position.x - t.x, dz = v.holder.position.z - t.z;
      if (dx * dx + dz * dz < t.r * t.r) {
        t.crushed = true;
        t.dest.damage(t.dest.hp + 1);           // flatten the tent (its own staged collapse plays)
        addBloodMark(t.x, t.z, 2.2);
        if (sound) sound.squishAt(t.x, 0, t.z);
        break;
      }
    }
  }
}

// One pile = 1 scrap. Piles drop where vehicles die and are scattered in remote
// corners at map build; a vehicle driving over one collects it for its team. Spend
// scrap in the garage to build more vehicles (BUILD_COST). Neutral: either team grabs.
const SCRAP_PICKUP_R = 8;   // how close a vehicle must get to snag a pile (a little margin so a unit halting at the kill site still collects)
const SCRAP_FLOAT_MS = 10000;   // debris in water floats COLLECTABLE this long before it slides under (shallow-water kills stay grabbable)

// kind 'parts' = organized delivery pallet (world scatter); 'wreck' = blown-up vehicle
// debris (death drop) — its armor plates wear the dead vehicle's team camo.
function addScrapPile(x, z, kind = 'parts', colorIndex = null) {
  const g = (kind === 'wreck' ? makeWreckage : makePartsPallet)(grid.cell);
  if (colorIndex != null) {
    if (kind === 'wreck' && g.userData.setCamo) g.userData.setCamo(colorIndex);           // camo the plates
    else if (g.userData.setTeamColor && TEAM_COLORS[colorIndex]) g.userData.setTeamColor(TEAM_COLORS[colorIndex].hex);
  }
  const gy = map.heightAt(x, z);
  g.position.set(x, gy + 0.04, z);
  g.rotation.y = Math.random() * Math.PI * 2;
  scene.add(g);
  const pile = { group: g, pos: new THREE.Vector3(x, gy, z), kind, bob: Math.random() * Math.PI * 2,
    overWater: !map.isLand(x, z) };
  scrapPiles.push(pile);
  return pile;
}

// Blow a vehicle APART on death: detach every part-mesh of its model into world space and
// fling it outward — away from the killing shot and radially from the hull centre — with an
// upward pop and a tumble, then let gravity settle it into a scattered pile. That settled
// debris IS the wreckage: it registers as one scrap pile worth SCRAP_DROP[type]. `impact` is
// the shot's travel direction on the ground (killer → victim); null for environment deaths.
function gibVehicle(veh, impact) {
  const model = veh.model && veh.model.group;
  if (!model) { scene.remove(veh.group); return; }
  veh.group.updateMatrixWorld(true);
  const center = veh.holder.position.clone();
  let ix = impact ? impact.x : 0, iz = impact ? impact.z : 0;
  const il = Math.hypot(ix, iz);
  if (il > 1e-3) { ix /= il; iz /= il; } else { const a = Math.random() * Math.PI * 2; ix = Math.cos(a); iz = Math.sin(a); }

  // Hold the settled debris in a world-space group (identity transform → child positions ARE
  // world coords), so the physics can write mesh.position directly and pickup can drop it whole.
  const wreck = new THREE.Group();
  scene.add(wreck);
  const meshes = [];
  model.traverse(o => { if (o.isMesh) meshes.push(o); });

  // AN INSTANCED MESH IS ONE OBJECT, and death is where that stops being a bargain. The Jotun's
  // track belt is a single InstancedMesh holding every link of BOTH tracks, so it satisfied
  // `isMesh`, went into the list as one chunk, and tumbled away as an intact rigid ring — the most
  // solid-looking thing in a pile of wreckage that was supposed to read as shredded.
  // Scatter a few real links instead and drop the rest. A track that came apart doesn't need every
  // link present, and each survivor costs a draw call for as long as the wreck stands (hence
  // GIB_INSTANCE_KEEP). The links share the source geometry and material, so this allocates no
  // buffers — it spends draws, not memory.
  for (let i = meshes.length - 1; i >= 0; i--) {
    const im = meshes[i];
    if (!im.isInstancedMesh || !im.parent) continue;
    meshes.splice(i, 1);
    const keep = Math.min(GIB_INSTANCE_KEEP, im.count);
    for (let k = 0; k < keep; k++) {
      const link = new THREE.Mesh(im.geometry, im.material);
      im.getMatrixAt(Math.floor(k * (im.count / keep)), _gibM4);
      // Spread across the belt rather than taking the first N, which would all come off one spot.
      // Local transform = the instance's place within the part, times the part's own — added to
      // the SAME parent, so the world position it lands on is the link's real one.
      _gibM4.premultiply(im.matrix);
      _gibM4.decompose(link.position, link.quaternion, link.scale);
      im.parent.add(link);
      meshes.push(link);
    }
    im.parent.remove(im);
  }

  const now = performance.now();
  for (const m of meshes) {
    wreck.attach(m);                         // reparent, preserving world position/rotation/scale
    const rx = m.position.x - center.x, rz = m.position.z - center.z;
    let dx = rx, dz = rz; const rl = Math.hypot(dx, dz);
    if (rl > 0.01) { dx /= rl; dz /= rl; } else { dx = ix; dz = iz; }
    dx = dx * 0.5 + ix * 0.9; dz = dz * 0.5 + iz * 0.9;   // blend "outward" with "away from the shot"
    const spd = 5 + Math.random() * 11;
    gibChunks.push({
      mesh: m,
      vx: dx * spd + (Math.random() - 0.5) * 4,
      vy: 7 + Math.random() * 9,             // pop up
      vz: dz * spd + (Math.random() - 0.5) * 4,
      ax: (Math.random() - 0.5) * 13, ay: (Math.random() - 0.5) * 13, az: (Math.random() - 0.5) * 13,
    });
  }
  scene.remove(veh.group);   // the model is now empty (all meshes reparented to `wreck`)

  // Register the settled pile as scrap. `hotUntil` keeps it uncollectable while it's still
  // airborne; noBob keeps scattered debris from bobbing like a tidy pickup.
  const value = SCRAP_DROP[veh.type] || 1;
  // A wreck that landed over water is UNREACHABLE for ground units — flag it so nobody paths
  // to it and gets stuck at the shoreline (it still shows as debris; a passing flyer could grab it).
  const overWater = !map.isLand(center.x, center.z);
  const pile = { group: wreck, pos: center.clone(), kind: 'wreck', value, overWater,
    bob: 0, noBob: true, hotUntil: now + GIB_HOT_MS };
  scrapPiles.push(pile);

  // Cap persistent wrecks so a long match doesn't pile up hundreds of static meshes.
  let wrecks = scrapPiles.filter(p => p.kind === 'wreck');
  while (wrecks.length > MAX_WRECKS) {
    const old = wrecks.shift();
    scene.remove(old.group);
    const i = scrapPiles.indexOf(old); if (i >= 0) scrapPiles.splice(i, 1);
    old._gone = true;   // let commanders prune it from known-scrap intel
  }
  return pile;
}

// Fly the detached debris pieces: gravity, tumble, and a small bounce, then settle on the
// ground. Settled pieces are removed from the sim (they stay parented in their wreck group).
function updateGibs(dt) {
  for (let i = gibChunks.length - 1; i >= 0; i--) {
    const g = gibChunks[i], m = g.mesh;
    if (!m.parent) { gibChunks.splice(i, 1); continue; }   // wreck was collected mid-flight
    g.vy -= GIB_GRAV * dt;
    m.position.x += g.vx * dt; m.position.y += g.vy * dt; m.position.z += g.vz * dt;
    m.rotation.x += g.ax * dt; m.rotation.y += g.ay * dt; m.rotation.z += g.az * dt;
    const groundY = map.heightAt(m.position.x, m.position.z) + 0.12;
    if (m.position.y <= groundY) {
      m.position.y = groundY;
      g.vx *= 0.42; g.vz *= 0.42;                          // ground friction
      g.ax *= 0.3; g.ay *= 0.3; g.az *= 0.3;               // spin bleeds off on impact
      if (g.vy < -2.5) { g.vy = -g.vy * 0.35; }            // one small bounce
      else { gibChunks.splice(i, 1); }                     // come to rest → stop simulating
    }
  }
}

// Scatter neutral salvage in remote/shore corners so scouting the map's edges pays off.
function scatterScrap() {
  for (const p of scrapPiles) scene.remove(p.group);
  scrapPiles = [];
  gibChunks = [];   // drop any debris still mid-flight from the previous map
  if (QS.has('noscrap') || configBases) return;   // custom maps place their own (slice 2)
  const span = Math.min(map.worldW, map.worldH) / 2;
  let placed = 0, tries = 0;
  // TRY HARDER, because the flag-HQ exclusion below shrinks the legal rim considerably and this
  // loop used to give up at 400 and leave the map short (measured: 8.0 pallets/map -> 5.9, with
  // seeds landing 2 and 3). This runs ONCE at map creation, so the budget is free.
  while (placed < 8 && tries++ < 4000) {
    const ang = Math.random() * Math.PI * 2, r = span * (0.6 + Math.random() * 0.34);   // out toward the rim
    const x = Math.cos(ang) * r, z = Math.sin(ang) * r;
    if (!map.isLand(x, z) || blockedAt(x, z)) continue;
    let ok = true;
    // KEEP THE BEACHED SALVAGE WELL CLEAR OF THE FLAG BASES. These are meant to read as cargo
    // washed ashore, so they are scattered out toward the RIM — which is also where the bases
    // are, so the two collide by construction. The old guard was a flat 26u from a camp CENTRE,
    // and a main camp's wall ring is already 22.5u out: that permitted a pallet ~3.5u off the
    // wall, wedged between the ring and the shore where no hull can get at it. Salvage is a
    // SCORED objective, so units route to one and grind rather than simply ignoring it.
    // A flag HQ gets a wide berth; a FOB only needs its own footprint plus room to drive round.
    for (const c of camps) {
      const clear = c.role === 'main' ? SCRAP_HQ_CLEAR : campClearance(c);
      if (Math.hypot(x - c.center.x, z - c.center.z) < clear) { ok = false; break; }
    }
    if (ok) for (const p of scrapPiles) if (Math.hypot(x - p.pos.x, z - p.pos.z) < 14) { ok = false; break; }
    if (ok) { addScrapPile(x, z, 'parts'); placed++; }
  }
}

function collectScrap(team, value = 1) {
  const t = team === 'red' || team === 'blue' ? team : null;
  if (t) teamScrap[t] += value;
  updateScrapHud();
}

// Spend the player's scrap to BUILD one vehicle of `type` — replaces a lost reserve (the
// garage has finite bays, so building refills attrition). Returns true if it went through.
function buildVehicle(type) {
  const cost = BUILD_COST[type] || 99;
  if ((playerLosses[type] || 0) <= 0) return false;          // roster already full for this type
  if ((teamScrap[PLAYER_TEAM] || 0) < cost) return false;    // can't afford it
  teamScrap[PLAYER_TEAM] -= cost;
  playerLosses[type] = Math.max(0, (playerLosses[type] || 0) - 1);
  if (garage) garage.applyRoster(playerLosses);              // the rebuilt vehicle reappears in its bay
  return true;
}

// Whose scrap the HUD shows: the spectated unit's team, else the player's side.
function viewerTeam() { return (spectateTarget && spectateTarget.team) || PLAYER_TEAM; }

function updateScrapHud() {
  let el = document.getElementById('scrap-hud');
  if (!el) {
    el = document.createElement('div');
    el.id = 'scrap-hud';
    el.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:60;'
      + 'pointer-events:none;font:bold 15px "Courier New",monospace;letter-spacing:2px;'
      + 'color:#ffcf4a;text-shadow:0 1px 3px rgba(0,0,0,0.6);';
    document.body.appendChild(el);
  }
  el.style.display = onField ? '' : 'none';
  if (!onField) return;
  // Watching AI-vs-AI: show BOTH sides so it's unambiguous whose scrap is whose (the single
  // spectated-team number was easy to misread as "the" scrap). A human game shows just yours.
  if (TEAM_CTRL[PLAYER_TEAM] !== 'human') {
    el.textContent = `⚙ A ${teamScrap.red || 0}   B ${teamScrap.blue || 0}`;
  } else {
    el.textContent = `⚙ SCRAP ${teamScrap[viewerTeam()] || 0}`;
  }
}

// ── Base infantry (Soldiers.js): decorative minifigs — garrison patrols, and a squad
// scattering out of an OCCUPIED building that collapses. One InstancedMesh, no gameplay stats.
// Troops spill only from structures people work/live in — not equipment or storage.
const SOLDIER_SPILL_IDS = new Set(['admin', 'lookout', 'barracks', 'flagHQ', 'quonset']);
let soldiers = null;
// Firebrat deployables (mines + sensor pods). Bound to the live scene/map; reset per match.
let minefield = new Minefield(scene, map);
let sensorNet = new SensorNet(scene, map);
// Per-match gadget telemetry (headless analysis / devblog): does the minefield earn its keep?
let gadgetStats = { minesLaid: 0, podsLaid: 0, detonations: 0, kills: 0, enemyKills: 0, friendlyKills: 0, damage: 0 };
function resetGadgetStats() { gadgetStats = { minesLaid: 0, podsLaid: 0, detonations: 0, kills: 0, enemyKills: 0, friendlyKills: 0, damage: 0 }; }
function wireSoldiers() {
  if (!soldiers) { soldiers = new SoldierCorps(scene, map); soldiers.onSquish = (x, y, z) => { if (sound) sound.squishAt(x, y, z); addBloodMark(x, z); }; }
  for (const c of camps) {
    if (c._soldiersWired) continue;
    c._soldiersWired = true;
    // Only OCCUPIED structures garrison troops — a shelled barracks/HQ/hut spills soldiers, but
    // diesel barrels, sandbags and generators shouldn't (looked odd — Jacob). Whitelist by id.
    c.onBuildingDown = (obj) => {
      if (!SOLDIER_SPILL_IDS.has(obj.userData && obj.userData.buildId)) return;
      soldiers.scatterFrom(obj.position.x, obj.position.z, c.team, c.accent, 3 + (Math.random() * 3 | 0));
    };
    if (c.role === 'main') {
      // a small garrison marching a rectangle inside the walls (clear of the road ring)
      const r = 12, cx = c.center.x, cz = c.center.z;
      soldiers.addPatrol([
        { x: cx - r, z: cz - r }, { x: cx + r, z: cz - r },
        { x: cx + r, z: cz + r }, { x: cx - r, z: cz + r },
      ], c.team, c.accent, 3);
    }
  }
}
// Flyers (Valkyrie) hover over mines; only ground vehicles trip them.
function isFlyer(v) { return !!(v._move && v._move.ignoreWalls); }
// SOFT mine avoidance: a turn bias (never an A* block — that boxes units in) that curves an AI
// ground unit around the nearest ARMED mine its team has spotted and that lies close AHEAD. Fades
// with distance/bearing so it doesn't fight the brain's steering; head-on mines get a fixed side.
const MINE_LOOK = MINE.R * 3.5;
function mineAvoidNudge(v) {
  if (!aiMineAvoid || isFlyer(v) || !minefield.items.length) return 0;
  const px = v.holder.position.x, pz = v.holder.position.z, h = v.heading;
  let best = null, bestD = Infinity;
  for (const m of minefield.items) {
    if (m.safe || !m.spottedBy.has(v.team)) continue;
    const dx = m.group.position.x - px, dz = m.group.position.z - pz, d = Math.hypot(dx, dz);
    if (d > MINE_LOOK || d < 0.01) continue;
    const err = wrapPi(Math.atan2(-dx, -dz) - h);   // bearing to the mine, relative to our nose
    if (Math.abs(err) > 1.0) continue;              // >~57° off our heading → we pass it clear
    if (d < bestD) { bestD = d; best = { err, w: (1 - d / MINE_LOOK) * (1 - Math.abs(err)) }; }
  }
  if (!best || best.w <= 0) return 0;
  const side = Math.abs(best.err) < 0.12 ? 1 : -Math.sign(best.err);   // steer AWAY (head-on → pick a side)
  return side * best.w * 0.9;
}
const MINE_DETECT = MINE.R * 4;      // how close a ground unit must get to roll for spotting a mine
const AI_MINE_COOLDOWN = 2.2;        // s between an AI Firebrat's mine drops (lay fast, hand off quick)
function aiHandleGadgets(dt) {
  if (matchOver) return;
  for (const cmd of commanders) {
    if (!cmd.team) continue;
    for (const v of cmd.liveUnits()) {
    // (a) DETECTION: each ground unit gets ONE 50% roll per mine as it comes near — spot it and
    // its whole team then routes around it (blockedFor); miss and the team may drive right in.
    if (!isFlyer(v)) {
      for (const m of minefield.items) {
        if (m.spottedBy.has(v.team) || m.rolled.has(v)) continue;
        const p = m.group.position, dx = v.holder.position.x - p.x, dz = v.holder.position.z - p.z;
        if (dx * dx + dz * dz > MINE_DETECT * MINE_DETECT) continue;
        m.rolled.add(v);
        // TARGET FIXATION: a unit locked on a chase (pursue) is tunnel-visioned — slimmer chance to
        // notice the mine it's barrelling toward, so a hunter's bait can lure it right onto the trap.
        const chance = v._aiState === 'pursue' ? 0.3 : MINE.spotChance;
        if (Math.random() < chance) { m.spottedBy.add(v.team); bumpNavEpoch(); }   // a newly-known mine reroutes this team's paths
      }
    }
    // (b) MISSION: an AI Firebrat seeds the contested ground with mines + one sensor pod per trip.
    if (v.type === 'firebrat') aiLayGadgets(cmd, v, dt);
    }
  }
}
// Out-and-back flank sortie: drive to the FAR flank point, then lay mines on the way BACK toward
// base (so the Firebrat never re-crosses a mine it just dropped), drop a sensor pod on the lane
// front, and finish — the brain then recalls it for the real opening. Also scouts that flank as a
// side effect (the drive paints the recon memory), so it may turn up a shield generator out there.
function aiLayGadgets(cmd, v, dt) {
  if (v._mineCharges == null) v._mineCharges = MINE.perTrip;
  if (!v._sapPhase) v._sapPhase = 'out';
  v._layCd = (v._layCd || 0) - dt;
  const p = v.holder.position, g = cmd._sapGeo();
  const near = (t, r) => (p.x - t.x) ** 2 + (p.z - t.z) ** 2 < r * r;
  if (v._sapPhase === 'out') {
    if (near(g.far, 12)) v._sapPhase = 'back';            // reached the deep flank → turn back, laying as we go
  } else if (v._sapPhase === 'back') {
    if (v._mineCharges > 0 && v._layCd <= 0 && map.isLand(p.x, p.z)) {
      if (minefield.place(p.x, p.z, cmd.team, teamColor(cmd.team), v)) {
        v._mineCharges--; v._layCd = AI_MINE_COOLDOWN; gadgetStats.minesLaid++;
        bumpNavEpoch();   // the laying team knows this mine instantly — its paths route around it
      }
    }
    if (v._mineCharges <= 0) v._sapPhase = 'pod';
  } else if (v._sapPhase === 'pod') {
    if (!v._laidPod && near(g.podW, 15) && sensorNet.count(cmd.team) < POD.teamCap && map.isLand(p.x, p.z)) {
      if (sensorNet.place(p.x, p.z, cmd.team, teamColor(cmd.team))) {
        v._laidPod = true; gadgetStats.podsLaid++;
        aiLog(cmd.team, `${cmd.cname}: Sensor pod down — eyes on the approach.`);
      }
    }
    if (v._laidPod) v._sapPhase = 'done';
  } else {
    cmd._sapDone = true;   // sortie complete → recall for the real mission
  }
}
// Servo whir while a lift is moving. Watches each elevator's phase: on entering rising/
// lowering it starts the positioned ELEVATOR patch and follows the deck up/down; on arrival
// (top/down) it stops. Guarded so the headless sim (no audio) skips it.
function updateElevatorSound(e) {
  if (!sound) return;
  const moving = (e.phase === 'rising' || e.phase === 'lowering');
  if (moving) {
    const y = e.lift ? e.lift.position.y : 0;
    if (!e._snd) e._snd = sound.elevatorAt(e.center.x, y, e.center.z);
    else e._snd.move(e.center.x, y, e.center.z);
  } else if (e._snd) {
    e._snd.stop(); e._snd = null;
  }
}
// ── Deep-water submarine (Submarine.js) ─────────────────────────────────────
// A single sub, spawned ON DEMAND: when a Valkyrie/Firebrat strays past the deep-water rim, a
// sub surfaces right beside them (seaward, herding them back to land) and shells them with guided
// missiles. Flee back inshore and it dives and is removed from the scene — it doesn't exist the
// rest of the time. A player deterrent (the AI mostly stays inshore; rogue over-water routing is
// nudged off the deep zone in vehCellCost). Team-neutral: the missile hits whoever wandered out.
let activeSub = null;    // the on-demand sub while one is up, else null
let subsOn = true;       // A/B knob (RR.setSubs): gate the whole hazard so a tournament can measure AI impact
let DEEP_DANGER_R = 0;   // radius past which deep water is sub territory (set at map build)
const SUB_MISSILE_DMG = 55, SUB_MISSILE_BLAST = 4.0;
function subDanger(x, z) {   // is (x,z) inside the deep zone the sub patrols? (cheap gate for nav cost)
  return subsOn && DEEP_DANGER_R > 0 && (x * x + z * z) > DEEP_DANGER_R * DEEP_DANGER_R && map.isDeepWater(x, z);
}
function configureSubZone() {   // called at map build; the sub itself spawns on demand
  if (activeSub) { activeSub.dispose(); activeSub = null; }
  // Danger ring sits clearly OUTSIDE the bases (outermost camp ≈ islandBound-70), so the hazard
  // is the far rim — a player deterrent, not something the AI runs into during normal base play.
  DEEP_DANGER_R = islandBound ? Math.max(70, islandBound - 50) : 0;
}
// NO-SUB ZONE: a bubble around every flag base. A coastal base sits near the deep rim, so a
// Valkyrie/Firebrat orbiting it to assault the flag would otherwise stray into sub water and get
// blasted (Jacob — hits the player AND the AI). Inside this radius the sub won't target you, so
// an already-surfaced sub also dives once you swing back toward the base.
const NO_SUB_R2 = 95 * 95;
function inNoSubZone(x, z) {
  for (const c of camps) {
    if (c.role !== 'main') continue;
    const dx = x - c.center.x, dz = z - c.center.z;
    if (dx * dx + dz * dz < NO_SUB_R2) return true;
  }
  return false;
}
// A deep-water spot to surface at: a touch SEAWARD of the intruder (between them and open water),
// so the sub cuts off the escape further out and herds them back toward land.
function subSurfaceSpot(tx, tz) {
  const rl = Math.hypot(tx, tz) || 1, ox = tx / rl, oz = tz / rl;   // outward from map centre
  for (const [dx, dz] of [[ox * 26, oz * 26], [oz * 24, -ox * 24], [-oz * 24, ox * 24], [0, 0]]) {
    if (map.isDeepWater(tx + dx, tz + dz)) return { x: tx + dx, z: tz + dz };
  }
  return { x: tx, z: tz };
}
function subFire(sub, target) {
  const m = sub.muzzle(), tp = target.holder.position;
  const dir = new THREE.Vector3(tp.x - m.x, (tp.y + 1) - m.y, tp.z - m.z).normalize();
  projectiles.spawn(2, m, dir, '#ff3a2a');   // missile visual (index 2), hot red
  const shot = projectiles.items[projectiles.items.length - 1];
  if (shot) {
    shot.dmg = SUB_MISSILE_DMG; shot.blast = SUB_MISSILE_BLAST; shot.team = null; shot.shooter = null; shot.atVehicle = true;
    if (shot.setHoming) shot.setHoming(() => (target && !target.dead) ? target.holder.position : null, MISSILE_TURN);
  }
  if (sound && sound.fireGunAt) sound.fireGunAt(2, m.x, m.y, m.z);   // reuse the Valkyrie missile launch report
}
function updateSubmarines(dt) {
  if (!subsOn) { if (activeSub) { activeSub.dispose(); activeSub = null; } return; }
  // Nearest intruder out past the deep rim (only the sea-crossers are exposed).
  let tgt = null, bd = Infinity;
  for (const v of combatants) {
    if (v.dead) continue;
    if (!isFlyer(v) && v.type !== 'firebrat') continue;
    const x = v.holder.position.x, z = v.holder.position.z;
    if ((x * x + z * z) < DEEP_DANGER_R * DEEP_DANGER_R) continue;   // still inshore → safe
    if (!map.isDeepWater(x, z)) continue;
    if (inNoSubZone(x, z)) continue;                                 // assaulting a flag base → the sub leaves you be
    const d = x * x + z * z;
    if (d < bd) { bd = d; tgt = v; }
  }
  // Surface a sub beside a fresh intruder; update the one that's up; remove it once it's dived.
  if (tgt && !activeSub) {
    const s = subSurfaceSpot(tgt.holder.position.x, tgt.holder.position.z);
    const yaw = Math.atan2(tgt.holder.position.x - s.x, tgt.holder.position.z - s.z);
    activeSub = new Sub(scene, s.x, s.z, yaw);
  }
  if (activeSub && activeSub.update(dt, tgt, { fire: subFire })) { activeSub.dispose(); activeSub = null; }
}
// ── Tower repair crews (RepairCrew.js) ──────────────────────────────────────
// A base sends a JEEP + soldier crew to patch a wounded corner tower — it heals a tier over
// ~60s. The jeep is a killable target the whole time it's out: destroy it (or squish the crew)
// and the repair is cancelled AND that jeep is lost. A team can only repair while it has jeeps in
// its pool, so hunting the enemy's jeeps denies their fortification. PROTOTYPE ("feel it" slice):
// auto-ordered so it shows up in AI-vs-AI without input; economy + AI targeting come next. The
// knob defaults ON for visibility — flip it OFF for A/B tournaments so it can't skew resolution.
let repairsOn = true;
let repairJobs = [];                              // active RepairJob instances
const MOTOR_JEEPS = 3;                            // jeeps parked in each main base's motor pool
const JEEP_HP = 40;                               // a jeep is fragile — a couple of shells
let motorPool = { red: [], blue: [] };            // parked jeeps: [{ mesh, dest, state, x, z, y, yaw, accent }]
let placedJeeps = { red: [], blue: [] };           // designer-placed motor-pool spots per team (empty = auto-place)
let _repairCd = { red: 0, blue: 0 };              // per-team auto-order cooldown
const REPAIR_WOUND = 0.7;                         // order a repair once a tower dips below this HP frac
// The AI waits a RANDOM spell between repair sorties, so its cadence is unpredictable — you can't
// park on a tower and pick off each crew on a fixed clock (and you won't just sit there when the
// next crew might be 5s or 45s away). Set when a sortie ENDS (crew home or lost).
const REPAIR_CD_MIN = 5, REPAIR_CD_MAX = 45;
const randRepairCd = () => REPAIR_CD_MIN + Math.random() * (REPAIR_CD_MAX - REPAIR_CD_MIN);
// Body work (masonry) is FREE — the crew's exposed minutes are the cost. The GUN is hardware:
// a replacement costs scrap, rides out on the jeep, and is LOST WITH THE JEEP if it's shot en
// route (no refund — cargo goes down with the truck). The AI only shops for a gun when it's
// comfortable: a healthy fleet and a scrap buffer, so gun purchases never starve vehicle rebuilds.
const GUN_COST = 3;         // scrap for a replacement tower gun
const AI_GUN_SCRAP = 10;    // AI buys a gun only with at least this much banked
const AI_GUN_FLEET = 5;     // ...and at least this many vehicles left in its fleet
const AI_UPG_SCRAP = 6;     // AI upgrades a tower on a MODEST surplus — scrap is scarce (teams rarely bank
                            // much), and repairs/guns still come first in orderRepair, so this stays a luxury
const AI_UPG_FLEET = 4;     // ...and fleet-healthy
let aiUpgradesOn = true;    // A/B: AI spends surplus scrap on tower star-upgrades (RR.setAiUpgrades)

// Cumulative repair telemetry (per match — reset with the pools). Answers "what did the
// crews actually DO all game": sorties, HP healed, rubble rebuilds, guns bought vs actually
// mounted (a jeep can die carrying one), and how the jeeps fared (hits taken, losses).
const mkRepairStats = () => ({ jobs: 0, done: 0, cancelled: 0, gunsBought: 0, gunsMounted: 0,
  scrapSpent: 0, hpHealed: 0, rebuilds: 0, jeepHits: 0, jeepsLostField: 0, jeepsLostLot: 0 });
let repairStats = { red: mkRepairStats(), blue: mkRepairStats() };

// (Re)park a jeep in its lot slot: build the mesh + a shootable Destructible at the stored spot.
function parkSlot(s) {
  const mesh = makeJeepMesh(s.accent);
  mesh.position.set(s.x, s.y, s.z); mesh.rotation.y = s.yaw;
  scene.add(mesh);
  s.mesh = mesh;
  s.dest = new Destructible(mesh, { type: 'building', hp: JEEP_HP });
  s.dest.onDamage = () => { repairStats[s.team].jeepHits++; };   // telemetry: hits on the parked lot
  destructibles.add(s.dest);                      // parked jeeps are raidable
  s.state = 'parked';
}

function clearMotorPool() {
  for (const team of ['red', 'blue']) {
    for (const s of motorPool[team]) {
      if (s.dest) destructibles.remove(s.dest);
      if (s.mesh && s.mesh.parent) s.mesh.parent.remove(s.mesh);
    }
    motorPool[team] = [];
  }
}

// Build each main base's motor pool. If the MAP placed team-tagged 'jeep' assets in the base,
// those exact spots become the functional pool (the designer controls count + layout); otherwise
// auto-park MOTOR_JEEPS in a row toward the BACK of the base (away from the gate). Either way it's
// the visible, raidable pool the repair crews draw from.
function buildMotorPool() {
  clearMotorPool();
  for (const c of camps) {
    if (c.role !== 'main') continue;
    const placed = placedJeeps[c.team];
    if (placed && placed.length) {                // designer-placed pool: honour their spots
      for (const p of placed) {
        const s = { x: p.x, z: p.z, y: map ? jeepGroundY(p.x, p.z) : 0, yaw: p.yaw, accent: c.accent, team: c.team, mesh: null, dest: null, state: '' };
        parkSlot(s);
        motorPool[c.team].push(s);
      }
      continue;
    }
    const out = (c.gates && c.gates[0] && c.gates[0].outward) || new THREE.Vector3(0, 0, 1);
    const bx = -out.x, bz = -out.z;               // back direction (unit)
    const px = -bz, pz = bx;                      // perpendicular = the row axis
    const ax = c.center.x + bx * 12, az = c.center.z + bz * 12;
    const yaw = Math.atan2(out.x, out.z);         // nose the parked jeeps out the gate toward the field
    for (let i = 0; i < MOTOR_JEEPS; i++) {
      const off = (i - (MOTOR_JEEPS - 1) / 2) * 4;
      const x = ax + px * off, z = az + pz * off;
      const s = { x, z, y: map ? jeepGroundY(x, z) : 0, yaw, accent: c.accent, team: c.team, mesh: null, dest: null, state: '' };   // road-aware, in case the lot overlaps a road
      parkSlot(s);
      motorPool[c.team].push(s);
    }
  }
}

function parkedCount(team) { return motorPool[team].filter(s => s.state === 'parked').length; }

function resetRepairs() {
  for (const j of repairJobs) j.dispose();
  repairJobs = [];
  _repairCd = { red: 0, blue: 0 };
  repairStats = { red: mkRepairStats(), blue: mkRepairStats() };
  buildMotorPool();
}

// The most-wounded STILL-STANDING corner tower for a team (gun up = worth defending, and healing
// the body while the gun stands restores it cleanly). Null if nothing needs work.
function findWoundedTower(team) {
  let best = null, bestFrac = REPAIR_WOUND;
  for (const { camp, wall: w } of fortWallsOf(team)) {
    if (!w.turret || w.turret.dead || !w.body || w.body.dead) continue;
    const frac = w.body.hp / w.maxHp;
    if (frac < bestFrac) { bestFrac = frac; best = { camp, wall: w }; }
  }
  return best;
}

// Debug: any STANDING corner tower for a team (regardless of HP), so a test can bang one up.
function findWoundedTowerAny(team) {
  for (const c of camps) {
    if (c.team !== team) continue;
    for (const w of c.walls) if (w.turret && !w.turret.dead && w.body && !w.body.dead) return { camp: c, wall: w };
  }
  return null;
}

// Roll a crew out to a team's most-wounded tower — if one's worth fixing, a jeep is free, and no
// crew is already out for that team. Returns true if a job started.
// Deploy a crew to a SPECIFIC tower (a player's click, or the AI's auto-pick). Guards: repairs
// enabled, no crew already out for this team, a jeep parked, and the target needs the work:
// a FREE job wants a damaged-or-collapsed body; a GUN job wants a downed gun + GUN_COST scrap
// (deducted here — the gun rides the jeep, so shooting the jeep destroys the cargo too).
// Returns true if a crew rolled out.
function deployRepair(team, camp, wall, wantGun = false) {
  if (!repairsOn || !soldiers) return false;
  if (repairJobs.some(j => j.team === team)) return false;   // one crew out per team at a time (slice)
  if (!wall || !wall.body) return false;
  if (wantGun) {
    if (!wall.turret || !wall.turret.dead) return false;     // gun's fine (or this wall never had one)
    if ((teamScrap[team] || 0) < GUN_COST) return false;     // can't afford the hardware
  } else if (!wall.body.dead && wall.body.hp >= wall.maxHp) return false;   // nothing to fix for free
  const slot = motorPool[team].find(s => s.state === 'parked');
  if (!slot) return false;                                   // no jeeps left in the lot
  if (wantGun) { teamScrap[team] -= GUN_COST; updateScrapHud(); }
  // Pull this jeep OUT of the lot; the mobile RepairJob jeep takes over from its slot.
  slot.state = 'deployed';
  destructibles.remove(slot.dest);
  if (slot.mesh && slot.mesh.parent) slot.mesh.parent.remove(slot.mesh);
  const job = new RepairJob(scene, map, {
    start: { x: slot.x, z: slot.z },
    tower: { x: wall.group.position.x, y: wall.group.position.y, z: wall.group.position.z },
    wall, team, accent: (camp && camp.accent) || wall.accent, soldiers, nav: makeJeepNav(team), gun: wantGun,
    groundY: jeepGroundY,
  });
  job.slot = slot;                                           // remember where to re-park on return
  destructibles.add(job.jeepDest);
  job.jeepDest.onDamage = () => { repairStats[team].jeepHits++; };   // telemetry: rounds that found the truck
  repairJobs.push(job);
  const st = repairStats[team];
  st.jobs++;
  if (wantGun) { st.gunsBought++; st.scrapSpent += GUN_COST; }
  return true;
}

// Dispatch a jeep crew to pin ONE upgrade star on a healthy tower (the garage scrap-shop flow).
// Mirrors deployRepair, but the job runs the fast ~5s 'upgrading' path and calls upgradeTower on
// completion. Returns false (with no charge) if it can't roll.
function deployUpgrade(team, camp, wall) {
  if (!repairsOn || !soldiers) return false;
  if (repairJobs.some(j => j.team === team)) return false;      // one crew out per team (slice)
  if (!wall || !wall.turret || wall.turret.dead) return false;  // need a live gun to upgrade
  if (((wall.turret.upg) || 0) >= TOWER_UPG_MAX) return false;  // already maxed
  if ((teamScrap[team] || 0) < TOWER_UPG_COST) return false;
  const slot = motorPool[team].find(s => s.state === 'parked');
  if (!slot) return false;                                      // no jeeps in the lot
  teamScrap[team] -= TOWER_UPG_COST; updateScrapHud();
  slot.state = 'deployed';
  destructibles.remove(slot.dest);
  if (slot.mesh && slot.mesh.parent) slot.mesh.parent.remove(slot.mesh);
  const job = new RepairJob(scene, map, {
    start: { x: slot.x, z: slot.z },
    tower: { x: wall.group.position.x, y: wall.group.position.y, z: wall.group.position.z },
    wall, team, accent: (camp && camp.accent) || wall.accent, soldiers, nav: makeJeepNav(team),
    groundY: jeepGroundY, upgrade: true, onUpgrade: () => upgradeTower(wall),
  });
  job.slot = slot;
  destructibles.add(job.jeepDest);
  job.jeepDest.onDamage = () => { repairStats[team].jeepHits++; };
  repairJobs.push(job);
  repairStats[team].jobs++;
  return true;
}

// Road-aware ground height for the jeeps — the SAME rule the driven vehicles use (drape on the
// road slab's top where there is one, else the terrain), so a jeep rides ON a road, not in it.
const jeepGroundY = (x, z) => { const r = roadDeckY(x, z); return r != null ? r : map.heightAt(x, z); };

// An enemy repair jeep in THIS unit's gun reach — a target of OPPORTUNITY only (Jacob's rule:
// no hunting mission, no chasing — a unit that happens to have a jeep in range, in its firing
// arc, with a clear line, kills it in passing; commanders never get distracted from the win).
// Covers both a crew's jeep out on a job and the jeeps parked in the enemy motor pool.
// Flyers are skipped: a homing missile on a 40hp truck is a waste of the Valkyrie's magazine.
function jeepShotTarget(v) {
  if (!repairsOn) return null;
  const flyer = isFlyer(v);   // a Valkyrie pot-shots jeeps too — it lobs OVER walls, so no ground-LOS gate
  const range = ENGAGE_RANGE[v.type] || 36, arc = SHOT_ARC[v.type] ?? Math.PI / 5;
  const px = v.holder.position.x, pz = v.holder.position.z;
  let best = null, bestD = range * range;
  const consider = (x, y, z) => {
    const d = (x - px) ** 2 + (z - pz) ** 2;
    if (d >= bestD) return;
    if (Math.abs(wrapPi(Math.atan2(-(x - px), -(z - pz)) - v.heading)) > arc + 0.02) return;   // outside the gun's swing
    if (!flyer && !hasLOS(px, pz, x, z)) return;          // a wall would just soak a GROUND shell
    best = { x, y, z }; bestD = d;
  };
  for (const team of ['red', 'blue']) {
    if (team === v.team) continue;
    for (const j of repairJobs) if (j.team === team && !j.jeepDest.dead) consider(j.jx, j.jeep.position.y + 1.0, j.jz);
    for (const s of motorPool[team]) if (s.state === 'parked' && s.dest && !s.dest.dead) consider(s.x, s.y + 1.0, s.z);
  }
  return best;
}

// A nav adapter that lets a repair jeep route with the game's A* (roads-preferred, wall-avoiding)
// without RepairCrew.js depending on main.js internals. It plans as a ground vehicle that keeps to
// roads and skirts water, so the jeep drives the roads instead of phasing through walls.
function makeJeepNav(team) {
  const c = () => grid.cell;
  const stub = {
    team, type: 'jeep',
    _move: { water: 'sink', ignoreWalls: false, tree: 'bump' },   // ground unit: avoids walls + deep water
    _archetype: 'warrior',                                        // prefers roads in vehCellCost
    holder: { position: { x: 0, y: 0, z: 0 } },
    _blocked: (x, z) => cellBlocked(stub, Math.round(x / c()), Math.round(z / c())),
  };
  return {
    plan: (fx, fz, tx, tz) => {
      stub.holder.position.x = fx; stub.holder.position.z = fz;
      return planPath(stub, { x: tx, z: tz }, { by: 'stub' });
    },
  };
}

// Every repairable fortification a team owns: its camps' wall ring PLUS any placed forts
// (designer maps and player construction both land in placedWalls, carrying _team). Placed
// pieces have no camp — callers take the accent off the wall itself.
function* fortWallsOf(team) {
  for (const c of camps) { if (c.team !== team) continue; for (const w of c.walls) yield { camp: c, wall: w }; }
  for (const w of placedWalls) if (w._team === team) yield { camp: null, wall: w };
}

// A corner tower whose gun is down (toppled, shot off, or never bought) — the gun-purchase
// target. The body may be standing, wounded, or rubble; the job rebuilds, then mounts.
function findGunDeadTower(team) {
  for (const { camp, wall } of fortWallsOf(team))
    if (wall.type === 'CORNER' && wall.turret && wall.turret.dead) return { camp, wall };
  return null;
}

// ── Player fort CONSTRUCTION (build-a-tower) ────────────────────────────────────────────
// Placement is an ORDER, construction is a jeep run: accepting a site takes the scrap and
// sends a crew; the fort GROWS bottom-up as the crew works (the rebuild machinery pointed
// at a brand-new 1hp Wall whose courses start hidden). Shoot the jeep and the site stays
// a foundation — the risk lives on the truck, same as repairs and gun deliveries.
const FORT_COST = { wall: 2, bastion: 3 };   // 'armed' = bastion + GUN_COST (one jeep carries both)
function fortCostOf(kind) { return (FORT_COST[kind === 'armed' ? 'bastion' : kind] || 99) + (kind === 'armed' ? GUN_COST : 0); }
// Can `team` build at cell (cx,cz)? Land, off-road, clear of standing obstacles + vehicles.
function fortSiteOk(cx, cz) {
  const x = cx * grid.cell, z = cz * grid.cell;
  if (!map.isLand(x, z)) return { ok: false, why: 'not on land' };
  if (roadNet.cells && roadNet.cells.has(cx + ',' + cz)) return { ok: false, why: 'blocks the road' };
  if (gateCells.has(cx + ',' + cz)) return { ok: false, why: 'blocks a gate' };
  for (const o of obstacles) {
    if (o.body && o.body.dead) continue;
    const dx = x - o.x, dz = z - o.z, rr = o.r + grid.cell * 0.5;
    if (dx * dx + dz * dz < rr * rr) return { ok: false, why: 'occupied' };
  }
  for (const v of combatants) if (!v.dead && Math.hypot(v.holder.position.x - x, v.holder.position.z - z) < grid.cell) return { ok: false, why: 'vehicle in the way' };
  return { ok: true };
}
// kind: 'wall' (rot 0/2 = EW run, 1/3 = NS) | 'bastion' (gunless tower) | 'armed' (bastion+gun).
function constructFort(team, kind, cx, cz, rot = 0) {
  if (!repairsOn || !soldiers) return { ok: false, why: 'no crews' };
  const cost = fortCostOf(kind);
  if ((teamScrap[team] || 0) < cost) return { ok: false, why: `need ${cost} scrap` };
  if (repairJobs.some(j => j.team === team)) return { ok: false, why: 'crew already out' };
  if (!motorPool[team].some(s => s.state === 'parked')) return { ok: false, why: 'no jeeps left' };
  const site = fortSiteOk(cx, cz);
  if (!site.ok) return site;
  const base = kind === 'armed' ? 'bastion' : kind;
  const type = base === 'bastion' ? 'CORNER' : (((rot || 0) % 2) === 0 ? 'EW' : 'NS');
  const x = cx * grid.cell, z = cz * grid.cell;
  const mainCamp = camps.find(c => c.team === team && c.role === 'main');
  const accent = (mainCamp && mainCamp.accent) ? mainCamp.accent.clone() : new THREE.Color(teamColor(team));
  const w = new Wall({ type, world: new THREE.Vector3(x, map.heightAt(x, z), z), cell: grid.cell, team, accent, manager: destructibles });
  w._team = team;
  if (type === 'CORNER') w.removeGun();     // hardware is a separate purchase (or rides along on 'armed')
  w.beginConstruction();
  scene.add(w.group); placedWalls.push(w);
  // Direct obstacle registration — the one live list nav/collision/LOS all consult.
  obstacles.push({ x, z, team, body: w.body, r: grid.cell * (type === 'CORNER' ? 0.7 : 0.5) });
  bumpNavEpoch();   // a new wall just closed routes — cached paths through it must replan
  if (!deployRepair(team, null, w, kind === 'armed')) {
    // No crew could roll (shouldn't happen past the guards) — tear the site back down, no charge.
    destructibles.remove(w.body); if (w.turretDest) destructibles.remove(w.turretDest);
    scene.remove(w.group);
    placedWalls.splice(placedWalls.indexOf(w), 1);
    obstacles.splice(obstacles.findIndex(o => o.body === w.body), 1);
    return { ok: false, why: 'no crew available' };
  }
  teamScrap[team] -= FORT_COST[base];       // the gun's share was deducted by deployRepair
  updateScrapHud();
  return { ok: true, wall: w };
}

// ── Fort PLACEMENT mode (the Scrap Shop's build flow) ──────────────────────────────────
// Entered from the garage shop: the view swaps to a locked aerial over the player's own
// base (fog-of-war safe — you can't scout with it), a translucent hologram follows the
// pointer snapped to the build grid, and ✓ BUILD / ✕ CANCEL commit or bail. The garage
// already freezes the field sim, so placing is calm; the RISK is the construction run
// that follows on the field. Build radius is capped around the main base.
const FORT_BUILD_RADIUS = 80;            // u from the main camp centre
let fortPlace = null;                    // { kind, rot, cx, cz, ghost, ring, ok, why }
const FORT_GHOST_ASSET = { wall: 'wall', bastion: 'bastion', armed: 'tower' };
const _fpRay = new THREE.Raycaster(); const _fpNdc = new THREE.Vector2();

function fortHomeCamp() { return camps.find(c => c.team === PLAYER_TEAM && c.role === 'main'); }

function makeFortGhost(kind) {
  const camp = fortHomeCamp();
  const accent = (camp && camp.accent) ? camp.accent : new THREE.Color(teamColor(PLAYER_TEAM));
  const entry = ASSETS_BY_ID[FORT_GHOST_ASSET[kind]];
  const g = entry.make(grid.cell, accent);
  g.traverse(o => {
    if (o.material) {
      o.material = Array.isArray(o.material) ? o.material.map(m => m.clone()) : o.material.clone();
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) { m.transparent = true; m.opacity = 0.55; m.depthWrite = false; }
    }
  });
  return g;
}

// Save/restore the camera pose around the build aerial: the aerial can be PANNED across the map,
// so on exit we put the fixed field camera back exactly where it was (else the panned view leaks
// into the fog-of-war-locked game).
function saveCam() { return { tx: orbit.target.x, tz: orbit.target.z, dist: orbit.dist, pitch: orbit.pitch, yaw: orbit.yaw }; }
function restoreCam(s) { if (!s) return; orbit.target.set(s.tx, 0, s.tz); orbit.dist = s.dist; orbit.pitch = s.pitch; orbit.yaw = s.yaw; updateCamera(); }

// In the build/upgrade aerial, WASD/arrows PAN the view across the map (like driving), keeping the
// fixed overhead angle + height — so you can aim a tower anywhere, not just near your base.
const AERIAL_PAN_SPEED = 65;   // world-u per second
function updateAerialPan(dt) {
  if (!fortPlace && !towerPick) return;
  const fwd = (keys['w'] || keys['arrowup'] ? 1 : 0) - (keys['s'] || keys['arrowdown'] ? 1 : 0);
  const rt  = (keys['d'] ? 1 : 0) - (keys['a'] ? 1 : 0);   // arrow L/R stay reserved (towerPick cycles with them)
  if (!fwd && !rt) return;
  const sp = AERIAL_PAN_SPEED * dt, sy = Math.sin(orbit.yaw), cy = Math.cos(orbit.yaw);
  const lim = map.worldW / 2 + 40;
  orbit.target.x = Math.max(-lim, Math.min(lim, orbit.target.x + (rt * cy - fwd * sy) * sp));
  orbit.target.z = Math.max(-lim, Math.min(lim, orbit.target.z + (-rt * sy - fwd * cy) * sp));
  updateCamera();
}

function enterFortPlace(kind) {
  const camp = fortHomeCamp();
  if (!camp) return false;
  const ghost = makeFortGhost(kind);
  // validity ring under the hologram: green = buildable, red = not here
  const ring = new THREE.Mesh(new THREE.RingGeometry(grid.cell * 0.55, grid.cell * 0.75, 28),
    new THREE.MeshBasicMaterial({ color: '#58d17a', transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false }));
  ring.rotation.x = -Math.PI / 2;
  scene.add(ghost); scene.add(ring);
  fortPlace = { kind, rot: 0, cx: Math.round(camp.center.x / grid.cell) + 3, cz: Math.round(camp.center.z / grid.cell), ghost, ring, ok: false, why: '', hidden: [], locked: false, _cam: saveCam() };
  // FOG OF WAR: the aerial is a frozen frame — hide every enemy unit (vehicles' health bars
  // ride their holder; enemy repair jeeps too) so pausing to place can't be used to spy.
  // Prior visibility is saved per-object (a unit hidden down a lift shaft must STAY hidden).
  for (const v of combatants) if (v.team !== PLAYER_TEAM) { fortPlace.hidden.push([v.holder, v.holder.visible]); v.holder.visible = false; }
  for (const j of repairJobs) if (j.team !== PLAYER_TEAM) { fortPlace.hidden.push([j.jeep, j.jeep.visible]); j.jeep.visible = false; }
  // locked aerial over the player's own base
  orbit.target.set(camp.center.x, 0, camp.center.z);
  orbit.dist = 120; orbit.pitch = 1.25; orbit.yaw = 0;
  updateCamera();
  setGarageOverlays(false);
  ensureFortPlaceUI();
  document.getElementById('fortplace-ui').style.display = '';
  refreshFortPlace();
  return true;
}

function exitFortPlace() {
  const ui = document.getElementById('fortplace-ui');
  if (ui) ui.style.display = 'none';   // ALWAYS hide the overlay — even if state is already gone, so it can't dangle into the garage/field
  if (!fortPlace) return;
  scene.remove(fortPlace.ghost); scene.remove(fortPlace.ring);
  for (const [obj, vis] of fortPlace.hidden) obj.visible = vis;   // reveal the enemy again, exactly as they were
  restoreCam(fortPlace._cam);
  fortPlace = null;
  setGarageOverlays(true);   // also refreshes the shop panel (scrap changed)
}

// ── TOWER UPGRADE PICKER (garage scrap-shop flow) ────────────────────────────────
// The same aerial "from the outside" view as fort placement, but you SELECT one of your standing
// gun towers (tap it, or ◀ ▶) to read its stats/stars, then UPGRADE pins the next star: a jeep
// crew rolls out and installs it (~5s of work). The field stays paused while you browse.
let towerPick = null;   // { camp, walls:[wall], idx, ring, hidden:[] }
function playerTowers() {
  const out = [];
  for (const { wall } of fortWallsOf(PLAYER_TEAM))
    if (wall.turret && !wall.turret.dead && wall.body && !wall.body.dead) out.push(wall);
  return out;
}
function enterTowerPick() {
  const camp = fortHomeCamp(); if (!camp) return false;
  const walls = playerTowers(); if (!walls.length) return false;
  const ring = new THREE.Mesh(new THREE.RingGeometry(grid.cell * 0.55, grid.cell * 0.82, 32),
    new THREE.MeshBasicMaterial({ color: '#ffcf4a', transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false }));
  ring.rotation.x = -Math.PI / 2;
  scene.add(ring);
  towerPick = { camp, walls, idx: 0, ring, hidden: [], _cam: saveCam() };
  // fog of war: hide enemy units + their jeeps while the aerial is up (same as fort placement)
  for (const v of combatants) if (v.team !== PLAYER_TEAM) { towerPick.hidden.push([v.holder, v.holder.visible]); v.holder.visible = false; }
  for (const j of repairJobs) if (j.team !== PLAYER_TEAM) { towerPick.hidden.push([j.jeep, j.jeep.visible]); j.jeep.visible = false; }
  orbit.target.set(camp.center.x, 0, camp.center.z);
  orbit.dist = 120; orbit.pitch = 1.25; orbit.yaw = 0;
  updateCamera();
  setGarageOverlays(false);
  ensureTowerPickUI();
  document.getElementById('towerpick-ui').style.display = '';
  refreshTowerPick();
  return true;
}
function exitTowerPick() {
  const ui = document.getElementById('towerpick-ui');
  if (ui) ui.style.display = 'none';   // ALWAYS hide, so it can't dangle into the garage/field
  if (!towerPick) return;
  scene.remove(towerPick.ring);
  for (const [obj, vis] of towerPick.hidden) obj.visible = vis;
  restoreCam(towerPick._cam);
  towerPick = null;
  setGarageOverlays(true);
}
const _TP_BAND = ['BRONZE', 'SILVER', 'GOLD', 'BLACK'], _TP_NEXT = ['+HULL', '+RANGE', '+FIRE RATE', '+DAMAGE'];
function refreshTowerPick() {
  const tp = towerPick; if (!tp) return;
  if (tp.idx >= tp.walls.length) tp.idx = 0;
  const wall = tp.walls[tp.idx];
  const p = wall.group.position;
  tp.ring.position.set(p.x, map.heightAt(p.x, p.z) + 0.3, p.z);
  const u = (wall.turret.upg) || 0, st = towerStats(u);
  const band = u === 0 ? -1 : Math.min(3, Math.floor((u - 1) / 3));
  const inBand = u === 0 ? 0 : u - band * 3;
  const starTxt = u === 0 ? '— none —' : `${_TP_BAND[band]} ${'★'.repeat(inBand)}`;
  const maxed = u >= TOWER_UPG_MAX;
  const canAfford = (teamScrap[PLAYER_TEAM] || 0) >= TOWER_UPG_COST;
  document.getElementById('tp-count').textContent = `TOWER ${tp.idx + 1}/${tp.walls.length}`;
  document.getElementById('tp-stars').textContent = starTxt;
  document.getElementById('tp-stats').innerHTML =
    `HULL <b>${Math.round(wall.maxHp)}</b> · RANGE <b>${st.range.toFixed(0)}</b> · RATE <b>${(1 / st.cd).toFixed(2)}</b>/s · DMG <b>${st.dmg.toFixed(0)}</b>`;
  document.getElementById('tp-next').textContent = maxed ? 'FULLY UPGRADED' : `NEXT: ${_TP_NEXT[Math.floor(u / 3)]}  (${TOWER_UPG_COST}⚙)`;
  const btn = document.getElementById('tp-upg');
  btn.disabled = maxed || !canAfford;
  btn.textContent = maxed ? 'MAXED' : `✓ UPGRADE ${TOWER_UPG_COST}⚙`;
  document.getElementById('tp-hint').textContent = '';
}
function towerPickPointer(ev) {
  const tp = towerPick; if (!tp) return;
  const r = renderer.domElement.getBoundingClientRect();
  _fpNdc.x = ((ev.clientX - r.left) / r.width) * 2 - 1;
  _fpNdc.y = -((ev.clientY - r.top) / r.height) * 2 + 1;
  _fpRay.setFromCamera(_fpNdc, camera);
  let bestI = -1, bestD = Infinity;                    // pick the CLOSEST tower the ray hits
  for (let i = 0; i < tp.walls.length; i++) {
    const h = _fpRay.intersectObject(tp.walls[i].group, true)[0];
    if (h && h.distance < bestD) { bestD = h.distance; bestI = i; }
  }
  if (bestI >= 0) { tp.idx = bestI; refreshTowerPick(); }
}
function ensureTowerPickUI() {
  if (document.getElementById('towerpick-ui')) return;
  const ui = document.createElement('div');
  ui.id = 'towerpick-ui';
  ui.innerHTML = `
    <div id="tp-title">UPGRADE TOWER — tap a tower or use &#9664; &#9654; &nbsp;·&nbsp; PAUSED</div>
    <div id="tp-info"><span id="tp-count">TOWER 1/1</span><span id="tp-stars">— none —</span></div>
    <div id="tp-stats"></div>
    <div id="tp-next"></div>
    <div id="tp-row">
      <button id="tp-prev">&#9664;</button>
      <button id="tp-upg">&#10003; UPGRADE</button>
      <button id="tp-next-btn">&#9654;</button>
      <button id="tp-cancel">&#10005; DONE</button>
    </div>
    <div id="tp-hint"></div>`;
  ui.style.cssText = 'position:fixed;left:50%;bottom:26px;transform:translateX(-50%);z-index:140;text-align:center;' +
    'font:12px ui-monospace,monospace;color:#dfe8ef;background:rgba(5,12,20,0.82);border:1px solid #0e2030;padding:12px 16px;border-radius:8px;min-width:300px;';
  const st = document.createElement('style');
  st.textContent = `
    #towerpick-ui #tp-title { letter-spacing:0.12em; color:#8fa3b3; margin-bottom:8px; font-size:11px; }
    #towerpick-ui #tp-info { display:flex; justify-content:space-between; color:#ffcf4a; letter-spacing:0.08em; margin-bottom:5px; }
    #towerpick-ui #tp-stats { color:#9fd; letter-spacing:0.04em; font-size:11px; margin-bottom:4px; }
    #towerpick-ui #tp-stats b { color:#cfffff; }
    #towerpick-ui #tp-next { color:#8ff0b0; letter-spacing:0.1em; font-size:11px; margin-bottom:9px; }
    #towerpick-ui #tp-row { display:flex; gap:7px; justify-content:center; }
    #towerpick-ui #tp-row button { font:bold 12px ui-monospace,monospace; letter-spacing:0.08em; padding:7px 12px; cursor:pointer;
      background:rgba(0,238,255,0.08); border:1px solid #1f6b8f; color:#cfffff; border-radius:5px; }
    #towerpick-ui #tp-row button:disabled { opacity:0.4; cursor:default; }
    #towerpick-ui #tp-upg { border-color:#1f6b3f; color:#8ff0b0; background:rgba(0,255,120,0.08); }
    #towerpick-ui #tp-cancel { border-color:#6b1f1f; color:#f0a08f; background:rgba(255,80,80,0.06); }
    #towerpick-ui #tp-hint { margin-top:7px; min-height:14px; color:#ffcf6a; letter-spacing:0.08em; }`;
  document.head.appendChild(st);
  document.body.appendChild(ui);
  const cyc = (d) => { const tp = towerPick; if (!tp) return; tp.idx = (tp.idx + d + tp.walls.length) % tp.walls.length; refreshTowerPick(); };
  document.getElementById('tp-prev').addEventListener('click', () => cyc(-1));
  document.getElementById('tp-next-btn').addEventListener('click', () => cyc(1));
  document.getElementById('tp-cancel').addEventListener('click', () => exitTowerPick());
  document.getElementById('tp-upg').addEventListener('click', () => {
    const tp = towerPick; if (!tp) return;
    const wall = tp.walls[tp.idx];
    if (deployUpgrade(PLAYER_TEAM, tp.camp, wall)) { exitTowerPick(); }
    else {
      const have = teamScrap[PLAYER_TEAM] || 0;
      document.getElementById('tp-hint').textContent =
        ((wall.turret.upg) || 0) >= TOWER_UPG_MAX ? 'already maxed'
          : have < TOWER_UPG_COST ? `need ${TOWER_UPG_COST} scrap`
            : repairJobs.some(j => j.team === PLAYER_TEAM) ? 'a crew is already out'
              : !motorPool[PLAYER_TEAM].some(s => s.state === 'parked') ? 'no jeeps left in the pool'
                : 'cannot upgrade right now';
    }
  });
  renderer.domElement.addEventListener('pointerdown', e => { if (towerPick && e.button === 0) towerPickPointer(e); });
  window.addEventListener('keydown', e => {
    if (!towerPick) return;
    if (e.key === 'Escape') exitTowerPick();
    else if (e.key === 'ArrowLeft') cyc(-1);
    else if (e.key === 'ArrowRight') cyc(1);
  });
}

// Recompute ghost pose + validity (and the UI hint) for the current cell.
function refreshFortPlace() {
  const fp = fortPlace; if (!fp) return;
  const x = fp.cx * grid.cell, z = fp.cz * grid.cell;
  // No build radius — place anywhere buildable; the jeep crew just has farther (and riskier) to drive.
  const site = fortSiteOk(fp.cx, fp.cz);
  const cost = fortCostOf(fp.kind);
  const afford = (teamScrap[PLAYER_TEAM] || 0) >= cost;
  const jeep = motorPool[PLAYER_TEAM] && motorPool[PLAYER_TEAM].some(s => s.state === 'parked');
  const busy = repairJobs.some(j => j.team === PLAYER_TEAM);
  fp.ok = site.ok && afford && jeep && !busy;
  fp.why = !site.ok ? site.why : !afford ? `need ${cost} scrap` : !jeep ? 'no jeeps left' : busy ? 'crew already out' : '';
  fp.ghost.position.set(x, map.heightAt(x, z), z);
  fp.ghost.rotation.y = fp.rot * Math.PI / 2;
  fp.ring.position.set(x, map.heightAt(x, z) + 0.25, z);
  fp.ring.material.color.set(fp.ok ? '#58d17a' : '#ff6a5a');
  const hint = document.getElementById('fp-hint');
  if (hint) hint.textContent = fp.ok ? 'crew will drive out and build it' : fp.why;
  const btn = document.getElementById('fp-build');
  if (btn) btn.disabled = !fp.ok;
}

function fortPlacePointer(ev) {
  const fp = fortPlace; if (!fp) return;
  const r = renderer.domElement.getBoundingClientRect();
  _fpNdc.x = ((ev.clientX - r.left) / r.width) * 2 - 1;
  _fpNdc.y = -((ev.clientY - r.top) / r.height) * 2 + 1;
  _fpRay.setFromCamera(_fpNdc, camera);
  const hit = _fpRay.intersectObjects(map.chunks, false)[0];
  if (!hit) return;
  fp.cx = Math.round(hit.point.x / grid.cell); fp.cz = Math.round(hit.point.z / grid.cell);
  refreshFortPlace();
}

function ensureFortPlaceUI() {
  if (document.getElementById('fortplace-ui')) return;
  const ui = document.createElement('div');
  ui.id = 'fortplace-ui';
  ui.innerHTML = `
    <div id="fp-title">PLACE FORTIFICATION — click the ground to lock the spot, then BUILD &nbsp;·&nbsp; PAUSED</div>
    <div id="fp-row">
      <button id="fp-rot">&#8635; ROTATE</button>
      <button id="fp-build">&#10003; BUILD</button>
      <button id="fp-cancel">&#10005; CANCEL</button>
    </div>
    <div id="fp-hint"></div>`;
  ui.style.cssText = 'position:fixed;left:50%;bottom:26px;transform:translateX(-50%);z-index:140;text-align:center;' +
    'font:12px ui-monospace,monospace;color:#dfe8ef;';
  const st = document.createElement('style');
  st.textContent = `
    #fp-title { letter-spacing:0.14em; color:#8fa3b3; margin-bottom:8px; text-shadow:0 1px 3px rgba(0,0,0,0.7); }
    #fp-row button { padding:10px 16px; margin:0 5px; cursor:pointer; border-radius:6px;
      font:bold 13px ui-monospace,monospace; letter-spacing:0.1em;
      background:rgba(8,16,11,0.85); border:1px solid #1f6b3f; color:#8ff0b0; }
    #fp-row button:disabled { opacity:0.4; border-color:#444; color:#789; }
    #fp-row #fp-cancel { border-color:#6b1f1f; color:#f0a08f; }
    #fp-hint { margin-top:7px; min-height:14px; color:#ffcf6a; letter-spacing:0.08em; text-shadow:0 1px 3px rgba(0,0,0,0.7); }`;
  document.head.appendChild(st);
  document.body.appendChild(ui);
  document.getElementById('fp-rot').addEventListener('click', () => { if (fortPlace) { fortPlace.rot = (fortPlace.rot + 1) % 4; refreshFortPlace(); } });
  document.getElementById('fp-cancel').addEventListener('click', () => exitFortPlace());
  document.getElementById('fp-build').addEventListener('click', () => {
    const fp = fortPlace; if (!fp || !fp.ok) return;
    const res = constructFort(PLAYER_TEAM, fp.kind, fp.cx, fp.cz, fp.rot);
    if (res.ok) exitFortPlace();
    else { const hint = document.getElementById('fp-hint'); if (hint) hint.textContent = res.why; }
  });
  // pointer: move the hologram to the cell under the cursor / finger
  // Hover only re-aims the ghost UNTIL the first left-click locks it in place — otherwise a
  // mouse user could never travel to the BUILD button without dragging the ghost off-target
  // (touch was fine because the finger lifts). A further click re-aims + re-locks.
  renderer.domElement.addEventListener('pointermove', e => { if (fortPlace && !fortPlace.locked) fortPlacePointer(e); });
  renderer.domElement.addEventListener('pointerdown', e => { if (fortPlace && e.button === 0) { fortPlacePointer(e); fortPlace.locked = true; } });
  window.addEventListener('keydown', e => {
    if (!fortPlace) return;
    if (e.key === 'r' || e.key === 'R') { fortPlace.rot = (fortPlace.rot + 1) % 4; refreshFortPlace(); }
    else if (e.key === 'Escape') exitFortPlace();
  });
}

// AI gun-purchase appetite: only shop for tower hardware from a position of strength — a
// healthy fleet (vehicles are always the first claim on scrap) and a comfortable bank.
function aiWantsGun(team) {
  if ((teamScrap[team] || 0) < AI_GUN_SCRAP) return false;
  const cmd = commanders.find(c => c.team === team);
  return !!cmd && cmd.fleetLeft() >= AI_GUN_FLEET;
}

// AI tower-upgrade appetite — the same "from strength" gate as guns, just a higher bank (upgrades
// are a luxury, never at the expense of vehicles/gun repairs which come first in orderRepair).
function aiWantsUpgrade(team) {
  if (!aiUpgradesOn) return false;
  if ((teamScrap[team] || 0) < AI_UPG_SCRAP) return false;
  const cmd = commanders.find(c => c.team === team);
  return !!cmd && cmd.fleetLeft() >= AI_UPG_FLEET;
}
// The least-upgraded HEALTHY standing tower not yet maxed — spread the stars across the ring so
// the whole base climbs together (and no single tower becomes a giant treasure box).
function findUpgradeTower(team) {
  let best = null, bestU = TOWER_UPG_MAX;
  for (const { camp, wall: w } of fortWallsOf(team)) {
    if (!w.turret || w.turret.dead || !w.body || w.body.dead) continue;
    if (w.body.hp < w.maxHp * 0.9) continue;          // don't upgrade a tower that's under fire
    const u = w.turret.upg || 0;
    if (u < bestU && u < TOWER_UPG_MAX) { bestU = u; best = { camp, wall: w }; }
  }
  return best;
}

// AI auto-order (human teams repair by CLICK). Priorities: patch a wounded LIVE gun first
// (free, keeps the defense shooting), then — if fleet-healthy and scrap-rich — buy a
// replacement gun for a downed tower (rebuilding its body on the way, all in one job).
function orderRepair(team) {
  const hit = findWoundedTower(team);
  if (hit) return deployRepair(team, hit.camp, hit.wall, false);
  if (aiWantsGun(team)) {
    const g = findGunDeadTower(team);
    if (g) return deployRepair(team, g.camp, g.wall, true);
  }
  if (aiWantsUpgrade(team)) {
    const up = findUpgradeTower(team);
    if (up) return deployUpgrade(team, up.camp, up.wall);
  }
  return false;
}

function updateRepairs(dt, camera) {
  // Raid check: a jeep destroyed while parked in the lot is lost for good.
  for (const team of ['red', 'blue']) {
    for (const s of motorPool[team]) {
      if (s.state === 'parked' && s.dest && s.dest.dead) {
        s.state = 'lost';
        repairStats[team].jeepsLostLot++;
        destructibles.remove(s.dest);
        if (s.mesh && s.mesh.parent) s.mesh.parent.remove(s.mesh);
      }
    }
  }
  for (let i = repairJobs.length - 1; i >= 0; i--) {
    const j = repairJobs[i];
    const st = j.update(dt, camera);
    if (st === 'done' || st === 'cancelled') {
      destructibles.remove(j.jeepDest);
      if (j.slot) { if (j.survived()) parkSlot(j.slot); else j.slot.state = 'lost'; }   // home safe → re-park; shot out → gone
      if (TEAM_CTRL[j.team] === 'ai') _repairCd[j.team] = randRepairCd();   // AI: random gap before the NEXT sortie (unpredictable → uncampable)
      const ts = repairStats[j.team];                                       // telemetry: book the finished sortie
      ts.hpHealed += j.healed;
      if (j.rebuilt) ts.rebuilds++;
      if (j.gunMounted) ts.gunsMounted++;
      // A crew that ABANDONED a tower being shelled to rubble under it drove home intact — that
      // is neither a completed job nor a jeep lost in the field. Booking it as either hid the
      // sponge (see RepairCrew: the revive-at-1hp loop) behind a healthy-looking counter.
      if (j.abandoned) ts.abandoned = (ts.abandoned || 0) + 1;
      else if (st === 'done') ts.done++; else { ts.cancelled++; ts.jeepsLostField++; }
      repairJobs.splice(i, 1);
    }
  }
  if (!repairsOn || matchOver) return;
  for (const team of ['red', 'blue']) {
    if (TEAM_CTRL[team] !== 'ai') continue;   // a HUMAN team repairs by CLICKING a tower — never auto (don't send jeeps into a crossfire)
    if (repairJobs.some(j => j.team === team)) continue;   // a crew is already out — one at a time
    _repairCd[team] = (_repairCd[team] || 0) - dt;
    if (_repairCd[team] > 0) continue;                     // still inside the randomised gap between sorties
    if (!orderRepair(team)) _repairCd[team] = 1.0;         // nothing to fix / no jeep → re-check soon (a sortie's gap is set when it ENDS)
  }
}

// ── Player repair control: a clickable 🔧 icon floats over each damaged friendly tower ─────────
// It's a DOM button projected to the tower's screen position (not a world-space click), so it
// captures its own tap and works while driving on phone (where the open field is inert). Tapping
// it sends a repair crew to THAT tower. Only for a HUMAN player's own towers, and only when a jeep
// is available and no crew is already out.
const _projV = new THREE.Vector3();
let repairIconWrap = null;
const repairIcons = new Map();   // wall -> { el, camp }

// Player-team towers worth an icon, with what the click buys:
//   kind 'repair' — free body work: a damaged gun-up tower, a gunless-but-damaged body, or a
//                   fully collapsed tower (rebuilt from rubble, layer by layer).
//   kind 'gun'    — the gun is down and the team can afford a replacement (GUN_COST scrap):
//                   one job rebuilds the body if needed, then mounts the new gun.
// Hidden entirely while a crew is out (only one per team) or the jeep pool is empty.
function repairEligible(team) {
  if (repairJobs.some(j => j.team === team)) return [];
  if (parkedCount(team) <= 0) return [];
  const out = [];
  for (const { camp, wall: w } of fortWallsOf(team)) {
    if (!w.turret || !w.body) continue;             // corner towers only (the only walls with guns)
    if (w.turret.dead) {
      // Downed gun: offer the purchase if affordable; otherwise offer free body work if needed.
      if ((teamScrap[team] || 0) >= GUN_COST) out.push({ camp, wall: w, kind: 'gun' });
      else if (w.body.dead || w.body.hp < w.maxHp) out.push({ camp, wall: w, kind: 'repair' });
      continue;
    }
    if (w.body.dead) { out.push({ camp, wall: w, kind: 'repair' }); continue; }
    if (w.body.hp >= w.maxHp * 0.85) continue;      // barely scratched → not worth a jeep run
    out.push({ camp, wall: w, kind: 'repair' });
  }
  return out;
}

function clearRepairIcons() {
  for (const [, rec] of repairIcons) rec.el.remove();
  repairIcons.clear();
}

function updateRepairIcons() {
  const human = TEAM_CTRL[PLAYER_TEAM] === 'human';
  const list = (human && onField && !matchOver && repairsOn) ? repairEligible(PLAYER_TEAM) : [];
  if (!repairIconWrap) {
    repairIconWrap = document.createElement('div');
    repairIconWrap.id = 'repair-icons';
    repairIconWrap.style.cssText = 'position:fixed;inset:0;z-index:70;pointer-events:none';
    document.body.appendChild(repairIconWrap);
  }
  const live = new Set(list.map(e => e.wall));
  for (const [w, rec] of repairIcons) if (!live.has(w)) { rec.el.remove(); repairIcons.delete(w); }
  const W = window.innerWidth, H = window.innerHeight;
  for (const { camp, wall, kind } of list) {
    let rec = repairIcons.get(wall);
    if (!rec) {
      const el = document.createElement('button');
      el.style.cssText = 'position:absolute;pointer-events:auto;transform:translate(-50%,-50%);min-width:42px;height:42px;border-radius:21px;border:2px solid #5fd66a;background:rgba(8,16,10,0.82);color:#bff5c0;font-size:20px;line-height:1;cursor:pointer;display:none;padding:0 6px;box-shadow:0 0 10px rgba(95,214,106,0.4)';
      const fire = (ev) => { ev.preventDefault(); ev.stopPropagation(); deployRepair(PLAYER_TEAM, rec.camp, wall, rec.kind === 'gun'); };
      el.addEventListener('pointerdown', fire);   // one handler for mouse + touch, before any canvas listener
      repairIconWrap.appendChild(el);
      rec = { el, camp, kind: null }; repairIcons.set(wall, rec);
    } else { rec.camp = camp; }
    if (rec.kind !== kind) {   // free wrench vs priced gun purchase (kind flips as scrap comes and goes)
      rec.kind = kind;
      if (kind === 'gun') {
        rec.el.textContent = `🔧${GUN_COST}⛭`; rec.el.title = `Rebuild + new gun (${GUN_COST} scrap)`;
        rec.el.style.borderColor = '#e8c35a'; rec.el.style.boxShadow = '0 0 10px rgba(232,195,90,0.4)'; rec.el.style.color = '#f5e3b0';
      } else {
        rec.el.textContent = '🔧'; rec.el.title = 'Send a repair crew (free)';
        rec.el.style.borderColor = '#5fd66a'; rec.el.style.boxShadow = '0 0 10px rgba(95,214,106,0.4)'; rec.el.style.color = '#bff5c0';
      }
    }
    const p = wall.group.position;
    _projV.set(p.x, (p.y || 0) + 6, p.z).project(camera);
    if (_projV.z > 1) { rec.el.style.display = 'none'; continue; }   // behind the camera
    rec.el.style.left = ((_projV.x * 0.5 + 0.5) * W) + 'px';
    rec.el.style.top = ((-_projV.y * 0.5 + 0.5) * H) + 'px';
    rec.el.style.display = '';
  }
}

function updateGadgets(dt) {
  if (sensorNet) sensorNet.update(dt);
  if (!minefield) return;
  aiHandleGadgets(dt);
  const booms = minefield.update(dt, combatants, isFlyer);
  // NO EPOCH BUMP HERE. A detonated mine only ever OPENS ground, so every cached path is still
  // drivable — it is merely taking a detour it no longer needs, which the 7s NAV_TTL will clear on
  // its own. Bumping invalidated EVERY unit's path across both teams to relax a detour, and
  // map_changed was 21.6% of all replans (464 of 2150 over 12 matches, 222 of them mid-suppress).
  // Jacob's rule: "when towers fall that opens the pathfinding options, but that doesn't warrant a
  // new route immediately. Only closing the route would warrant that." The bumps that remain are
  // all closures — a wall built, a mine laid, a mine becoming known to a team.
  for (const b of booms) {
    const p = new THREE.Vector3(b.x, b.y + 0.4, b.z);
    // Snapshot the living so we can attribute this mine's damage/kills (friendly vs enemy).
    const snap = combatants.filter(v => !v.dead).map(v => ({ v, hp: v.hp, team: v.team }));
    explodeAt(p, MINE.blast, MINE.dmg, null, null);   // both teams (never a flyer); explodeAt chain-clears nearby mines/pods
    if (sound) sound.explosionAt(b.x, b.y, b.z);
    gadgetStats.detonations++;
    for (const s of snap) {
      const dealt = s.hp - s.v.hp;
      if (dealt > 0) gadgetStats.damage += dealt;
      if (s.v.dead && s.hp > 0) {   // this blast finished it
        gadgetStats.kills++;
        if (s.team === b.mine.team) gadgetStats.friendlyKills++;
        else {
          gadgetStats.enemyKills++;
          // A mine kill IS a kill — credit the laying team (kills/homeKills/carrierKills),
          // so mine plays stop grading as failures. (No unit to promote — the placer may
          // be long gone; explodeAt fired with a null shooter, which skipped creditKill.)
          const mc = creditKillToTeam(b.mine.team, s.v);
          if (mc) mc.mineKills = (mc.mineKills || 0) + 1;
        }
      }
    }
  }
}
function updateScrap(dt) {
  const now = performance.now();
  for (let i = scrapPiles.length - 1; i >= 0; i--) {
    const p = scrapPiles[i];
    // Debris that landed in water floats COLLECTABLE for a grace window (a wader in the
    // shallows or a passing flyer can still snag it), then slides under and despawns.
    // Wait out the hot (airborne) window first so a mid-air wreck finishes its arc.
    if (p.overWater && (!p.hotUntil || now >= p.hotUntil)) {
      if (p.sinkAt == null) p.sinkAt = now + SCRAP_FLOAT_MS;   // grace clock starts once it has settled
      if (now >= p.sinkAt) {
        // Sink from where the debris actually SITS — using the death position's y made a
        // wreck from a downed flyer jump back up to its death altitude on the first frame.
        if (p.sinkBase == null) p.sinkBase = p.group.position.y;
        p.sink = (p.sink || 0) + dt;
        p.group.position.y = p.sinkBase - p.sink * 3;   // ~3 u/s under
        if (p.sink > 1.6) { scene.remove(p.group); p._gone = true; scrapPiles.splice(i, 1); }
        continue;   // not collectable while sinking
      }
    }
    if (!p.noBob) {   // parts pallets bob gently as a pickup; scattered gib-wrecks sit still
      p.bob += dt * 2;
      p.group.position.y = p.pos.y + 0.04 + Math.sin(p.bob) * 0.05;   // no spin — a heavy wreck/pallet shouldn't rotate
    }
    if (p.hotUntil && now < p.hotUntil) continue;   // debris still flying → not collectable yet
    for (const v of combatants) {
      if (v.dead) continue;
      if (Math.hypot(v.holder.position.x - p.pos.x, v.holder.position.z - p.pos.z) <= SCRAP_PICKUP_R) {
        spawnScrapPop(p.pos);
        p._gone = true;                 // let commanders prune it from their known-scrap intel
        scene.remove(p.group);
        scrapPiles.splice(i, 1);
        collectScrap(v.team, p.value || 1);
        break;
      }
    }
  }
  updateScrapHud();   // refresh each frame so the counter tracks the spectated team (Tab / side buttons)
}

// --- Ground-unit navigation (A*) ---------------------------------------
// Units used to greedy-steer at their objective and only dodge walls locally, so a
// water inlet or a tree clump was a dead end (the Lurcher drowned at the shore, the
// Firebrat wedged in trees). Now ground units route with A* over the build grid,
// reusing each vehicle's OWN `_blocked` oracle as the passability test — so walls,
// the coast (for sinkers) and bump-trees (for the Firebrat) are all impassable, while
// crushers plough through trees and roads are preferred. Flyers skip this entirely.
// A* passability for a grid cell. It mirrors the player's collision `_blocked` so a
// planned path is one the full-radius hull can actually drive: walls keep nearly the
// collision margin (a path that hugs a fat CORNER tower the nav once thought passable
// but collision didn't sent units grinding into the corner). Gate corridors, roads
// and elevator pads are explicitly open (so the tighter margin can't seal a gate), and
// sinkers still avoid open water. drive()'s full-radius slide handles the final sliver.
// Behaviour here is UNCHANGED from the version this replaced — proved cell-by-cell over the whole
// grid for every live vehicle (~/pw/_navequiv.cjs, 18818 checks per function, zero mismatches),
// then confirmed end to end: the 20-seed tournament came back byte-identical, same winners and
// same tick counts. That exact test is why this needed no statistical gate.
// Two things were costing the time (Jacob's trace: 42.5% of CPU here, vs 6.4% in A* itself):
//   1. the same string key `i+','+j` was rebuilt FOUR times per call, one per lookup
//   2. all 80 obstacles were scanned linearly for every cell tested
function cellBlocked(v, i, j) {
  const c = grid.cell, x = i * c, z = j * c;
  if (!navStatic) buildNavStatic();                     // lazy: roads/gates/pads must exist first
  const si = navIdx(i, j);
  const f = si < 0 ? NAVF.OOB : navStatic[si];          // off the baked grid is further out than the bounds test
  if (f & NAVF.OOB) return true;                        // world edge + island ring, precomputed
  const key = i + ',' + j;                              // built ONCE, reused by every live lookup
  const m = v._move;
  const gw = gateCells.get(key);
  if (gw) return m.ignoreWalls ? false : gateBlocks(gw, v.team);
  if (aiGateBand && !m.ignoreWalls) for (const g of gates) {
    const ax = x - g.gx, az = z - g.gz;
    if (ax * ax + az * az > 400) continue;
    if (!gateBlocks(g.w, v.team)) continue;
    if (Math.abs(ax * g.nx + az * g.nz) < g.halfNorm + VEH_R + VEH_R * 0.9 &&
        Math.abs(ax * g.px + az * g.pz) < g.halfRun + VEH_R * 0.9) return true;
  }
  if (f & NAVF.ROAD) return false;
  // NOT baked: an elevator pad is only a surface while its deck is flush at the top
  // (elevatorPadAt: `if (e.phase !== 'top') continue`), and the phase changes as it rides up and
  // down. Baking it passed a cell-by-cell equivalence check — which samples ONE instant — and
  // still diverged four seeds in the tournament, two of them wildly. Anything that moves stays
  // live; the bitmap is only for things the map fixes forever.
  if (elevatorPadAt(x, z)) return false;
  if (f & NAVF.FLANK) return true;
  if (navAvoid.size) {
    const e = navAvoid.get(key);
    if (e !== undefined) { if (e > performance.now()) return true; navAvoid.delete(key); }
  }
  // Nine isDeepWater calls became one bit test. Both ford settings are baked because neither
  // implies the other, so the knob still works without touching the terrain at run time.
  if (m.water === 'sink' && (f & (aiSoftFord ? NAVF.SINKSOFT : NAVF.SINKHARD))) return true;
  if (!m.ignoreWalls) {
    const near = obsBuckets.get(key);                   // only obstacles that can reach this cell
    if (near) {
      const margin = VEH_R * 0.9;
      for (const o of near) {
        if (o.body && o.body.dead) continue;
        const dx = x - o.x, dz = z - o.z, rr = o.r + margin;
        if (dx * dx + dz * dz < rr * rr) return true;
      }
    }
  }
  return false;
}
// Nearest open cell to (gi,gj) within `R` rings — lets us aim at a goal that sits
// inside a wall/water (snap to the closest spot the unit can actually stand).
function nearestOpenCell(v, gi, gj, R, minR = 0) {
  if (minR === 0 && !cellBlocked(v, gi, gj)) return { i: gi, j: gj };
  for (let r = Math.max(1, minR); r <= R; r++)
    for (let di = -r; di <= r; di++) for (let dj = -r; dj <= r; dj++) {
      if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
      if (!cellBlocked(v, gi + di, gj + dj)) return { i: gi + di, j: gj + dj };
    }
  return null;
}
// Plan a cell path from the unit to `dest`; returns world waypoints [{x,z}] or null.
// Grid cells that contain a tree — the "forest" the Hunter likes to travel through. Built
// once from the foliage scatter (rebuilt on a new match via page reload), looked up cheaply
// in the A* cost. Stays null until foliage exists so we don't cache an empty set early.
// Grid cells containing a tree, built once from the foliage scatter. The cost function asks
// this up to four times per cell (the tree-adjacency test), so it was four string allocations on
// the hottest path in the game. CELL_K packs i,j into one integer; the offset keeps it positive
// for cells left of / behind the origin, and 8192 is far wider than any grid we generate.
let forestCellsN = null;
const CELL_K = (i, j) => (i + 4096) * 8192 + (j + 4096);
function forestHasN(i, j) {
  if (forestCellsN === null) {
    if (!foliage || !foliage.trees) return false;
    forestCellsN = new Set();
    const fc = grid.cell;
    for (const t of foliage.trees) forestCellsN.add(CELL_K(Math.round(t.x / fc), Math.round(t.z / fc)));
  }
  return forestCellsN.has(CELL_K(i, j));
}
// Per-vehicle A* cell cost. Infinity = impassable (blocked). SHARED by the live navigator
// (planPath) AND the A* visualizer (buildAstarGrid) so the picture you inspect is EXACTLY the
// cost the unit navigates on — the viz used to fall back to a generic representative unit, so a
// Firebrat's tree-avoidance / a sinker's water penalty were invisible and the viz showed a route
// the real unit's cost couldn't take ("no A* route" while the path tool looked fine).
function vehCellCost(v, i, j) {
  if (cellBlocked(v, i, j)) return Infinity;
  const c = grid.cell, roads = roadNet.cells;
  const key = i + ',' + j;                              // built once, both lookups share it
  const onRoad = roads && (roads.has(key) || gateCells.has(key));
  // SINK vehicles wade shallow water but bog there — make off-road shallows EXPENSIVE so A* keeps
  // them on land/roads and only fords when there's genuinely no dry route (overrides archetype).
  if (v._move.water === 'sink' && !onRoad && !map.isLand(i * c, j * c)) return 35;
  // FIREBRAT (the flag runner) BUMPS trees but SKIMS water: route it AROUND the forest (tree-
  // adjacent land is dear), over open water if that's clearer, instead of threading a tight gap.
  if (v.type === 'firebrat') {
    // A tree IN the cell is dear but PASSABLE — the Firebrat shoots trees clear now, so A* only
    // threads a forest when there's no reasonable way around, and never returns "no route" for
    // woods it could blast through.
    if (foliage && foliage.treeAt(i * c, j * c, VEH_R * 0.5)) return 30;
    if (onRoad) return 0.5;
    const treeNear = forestHasN(i + 1, j) || forestHasN(i - 1, j) || forestHasN(i, j + 1) || forestHasN(i, j - 1);
    return treeNear ? 6 : 1;   // water == clean land (1); don't PREFER water, just skirt trees
  }
  // Personality terrain preference: Rogue sneaks over OCEAN, Hunter moves under FOREST cover,
  // Warrior/default uses ROADS (only bites where the unit can traverse it — see cellBlocked).
  const arch = v._archetype;
  if (arch === 'rogue') {
    const water = !map.isLand(i * c, j * c);
    if (water && subDanger(i * c, j * c)) return 8;   // sub territory — sneak along the coast, not out to sea
    return water ? 0.45 : (onRoad ? 0.8 : 1);
  }
  if (arch === 'hunter') return forestHasN(i, j) ? 0.45 : (onRoad ? 0.8 : 1);
  return onRoad ? 0.5 : 1;
}
// Closest point on segment A→B to point P (clamped to the segment).
function _closestOnSeg(ax, az, bx, bz, px, pz) {
  const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1;
  let t = ((px - ax) * dx + (pz - az) * dz) / L2; t = Math.max(0, Math.min(1, t));
  return { x: ax + dx * t, z: az + dz * t };
}
// Post-process an A* route so it steps AROUND any mine this team knows about: where a leg passes
// too close to a known mine, splice in a side waypoint (the leg becomes two clean legs around it).
// A* itself never treats a mine as blocked (that boxed units in), so the route always exists — this
// only bends it. There's no excuse for a ROUTED unit hitting its own mine; only combat maneuvering
// (not on a route) can, which is the intended "heat of battle" exception. Flyers ignore mines.
function detourMines(v, pts) {
  if (!pts || pts.length < 2 || isFlyer(v) || !minefield.items.length) return pts;
  const known = minefield.items.filter(m => !m.safe && m.spottedBy.has(v.team));
  if (!known.length) return pts;
  const clr = MINE.R + VEH_R + 2.5;                 // keep the route at least this far from a mine centre
  const out = pts.slice();
  let s = 0, inserted = 0;
  while (s < out.length - 1 && inserted < 8) {
    const A = out[s], B = out[s + 1];
    let hit = null, hitP = null, best = clr;
    for (const m of known) {
      const M = m.group.position;
      const P = _closestOnSeg(A.x, A.z, B.x, B.z, M.x, M.z);
      const d = Math.hypot(P.x - M.x, P.z - M.z);
      if (d < best) { best = d; hit = M; hitP = P; }
    }
    if (!hit) { s++; continue; }
    let sx = B.x - A.x, sz = B.z - A.z; const sl = Math.hypot(sx, sz) || 1; sx /= sl; sz /= sl;
    const perpx = -sz, perpz = sx;
    const sd = (hit.x - A.x) * perpx + (hit.z - A.z) * perpz;   // which side of the leg the mine sits on
    const sign = Math.abs(sd) < 1 ? 1 : -Math.sign(sd);        // push the detour to the far side (head-on → pick one)
    const off = clr + 1.5;
    let D = { x: hitP.x + perpx * sign * off, z: hitP.z + perpz * sign * off };
    if (v._blocked(D.x, D.z)) {                                // that side's blocked (wall/water) → try the other
      D = { x: hitP.x - perpx * sign * off, z: hitP.z - perpz * sign * off };
      if (v._blocked(D.x, D.z)) { s++; continue; }             // both blocked → accept the risk, don't wedge
    }
    out.splice(s + 1, 0, D);                                    // re-check A→D next (may pass another mine)
    inserted++;
  }
  return out;
}
// A* tuning knobs (tunable live via RR.setNavHScale / RR.setNavBudget).
// NAV_HSCALE = heuristic weight: 1.0 is admissible/thorough; ~1.5 is the measured sweet spot
// (~2x fewer node expansions on detour routes, paths still optimal); above ~1.6 the search
// over-commits at obstacles and thrashes, so keep it clamped. NAV_FRAME_BUDGET_MS caps the A*
// time spent per AI pass — once blown, a unit that still has a usable route defers its refresh
// replan to a later frame (spreads the replan spikes that caused the sawtooth); units with no
// route are never deferred, so movement is never starved.
let NAV_HSCALE = 1.5;
let NAV_FRAME_BUDGET_MS = 3;
// "The flag is exposed" requires a ROUTE to it, not just a revealed flag — see flagExposed().
// PULLED BACK TO OPT-IN, 2026-08-10, hours after shipping it. On its own it looked fine (resolution
// flat, near-water transit-stuck -55%). But the FULL configuration — breach + flagreach + msnattrib
// together, which is what actually ships — measured WORSE than its parts: resolved -1 on seeds 11+,
// inland stuck +184%, and on fresh seeds +10s per match with nav alarms +67%. The parts were
// 0/+1, +2/+1 and 0; together they were -1/0.
// LIKELY MECHANISM: flagreach and msnattrib are both "stop capturing" pressures — one withholds
// capture when the flag is unreachable, the other benches capture lanes after losses. Stacked, the
// commander gives up on capture too readily, and capture is the ONLY way to win.
// KEPT ON ANYWAY — Jacob's call, 2026-08-10: "let's keep them. we will figure it out."
// Same standing rule as msnattrib: a change that makes the AI reason correctly is worth keeping
// while the cost gets worked on, rather than reverted for a number. ?noflagreach reverts.
// THE THING TO FIX (do not lose this): the two pressures must stop stacking. flagreach should
// withhold capture only when NO lane is reachable, not whenever the chosen one is not — that is
// the all-or-nothing that combines badly with msnattrib's per-lane bench.
const aiFlagReach = !QS.has('noflagreach');
// BREACH: shoot the breakable thing standing between us and an objective we cannot reach.
// Lowest-priority target, below towers and the keep — see the breach block in the target picker.
// SHIPPED 2026-08-10 (?nobreach reverts). 240 seeds x2: resolution 0 then +1 (never negative),
// near-water transit-stuck -81%, advance-stuck -69%, matches 10s faster. Proven on the case first:
// seed 1572 goes from a 1500s stalemate to a 580s win with 2 wall segments destroyed.
const aiBreach = !QS.has('nobreach');
const _breachDbg = { seen:0, noThreat:0, hasCap:0, both:0, fired:0 };   // why the breach target does/doesn't fire (RR.breachDbg)
// Base A* node budget multiplier for ORDINARY navigation (see planPath). 1 = shipped behaviour.
// ?navbudget=2 / =4 for the A/B. Left at 1 until a 240 says otherwise: the last time budgets were
// touched here (a per-frame NODE budget) it pushed unreachable-GOTO violations up 56%.
const aiNavBudgetX = Math.max(1, Math.min(8, +QS.get('navbudget') || 1));
let _astarFrameMs = 0;            // ms spent in planPath this AI pass; reset in updateCommanders
// A* nodes expanded during ONE AI pass. Reported by astarGrid, accumulated here, surfaced on the
// ?perf panel — the honest measure of how much work nav is doing, where the ms figure beside it
// reads zero under the test rig's stubbed clock.
let _astarFrameNodes = 0;

// opts.nodeMul scales the node budget for callers that would rather spend ONE thorough search
// than several cheap inconclusive ones (the siege standoff solver — see _standoffFor). A search
// that runs out of nodes proves nothing either way, so a caller that must get a real answer is
// better off paying for it once.
// ── ROUTE SMOOTHING (string-pull) ────────────────────────────────────────────
// A* returns one waypoint PER GRID CELL, so every route is a staircase: to cross an empty
// field a unit is handed forty waypoints describing a diagonal it could have driven in one
// straight line. That staircase is what makes routes look robotic, and it is what pins a hull
// on corners — each waypoint is a small course correction the chassis has to square up to.
//
// The fix is Jacob's: walk the route and, whenever the straight line from waypoint i to
// waypoint i+2 is clear, delete the middle one. Generalised here to reach as far ahead as the
// straight line stays clear, which collapses a whole diagonal run to its two endpoints.
//
// THE RULE THAT KEEPS IT HONEST: a shortcut is taken only if it COSTS NO MORE than the stretch
// it replaces, priced with the same cost function A* used. A* does not merely avoid impassable
// ground — it prices terrain (deep-ish water is 35 to a sinker, forest is 30 to a Firebrat, a
// road is 0.5), and a naive "is the line blocked?" test would happily straighten a Jotun's
// careful dry route into a bog, or cut a road-follower off its road.
//
// Comparing TOTALS rather than per-cell worsts matters: a per-cell rule lets one expensive
// waypoint at the far end raise the ceiling for the whole shortcut, which is exactly how a route
// that forded one cell of water would get straightened into a twenty-cell wade. Since a straight
// line is the shortest distance between two points, on uniform ground the shortcut always wins
// and the staircase collapses completely; where the pathfinder paid for something — a road, dry
// land — the detour it bought is cheaper than the line, and the corner stays.
// Walk EVERY grid cell a segment passes through, in order, handing back the length of segment
// spent inside each (grid traversal, Amanatides–Woo). Exact where sampling is approximate: a line
// that clips the corner of one cell visits that cell here and can be missed by any fixed sample
// spacing. Cells are centred on multiples of `cell`, so cell i spans [(i-0.5)c, (i+0.5)c) — the
// +0.5 shift below moves that onto integer boundaries where the traversal maths is standard.
// The callback returning false stops the walk early (used to bail on the first blocked cell).
function walkCells(ax, az, bx, bz, cb) {
  const c = grid.cell;
  let ux = ax / c + 0.5, uz = az / c + 0.5;
  const vx = bx / c + 0.5, vz = bz / c + 0.5;
  const dx = vx - ux, dz = vz - uz;
  const total = Math.hypot(bx - ax, bz - az);
  let i = Math.floor(ux), j = Math.floor(uz);
  const stepI = dx > 0 ? 1 : dx < 0 ? -1 : 0, stepJ = dz > 0 ? 1 : dz < 0 ? -1 : 0;
  const tDX = dx !== 0 ? 1 / Math.abs(dx) : Infinity, tDZ = dz !== 0 ? 1 / Math.abs(dz) : Infinity;
  let tMX = dx !== 0 ? (stepI > 0 ? i + 1 - ux : ux - i) / Math.abs(dx) : Infinity;
  let tMZ = dz !== 0 ? (stepJ > 0 ? j + 1 - uz : uz - j) / Math.abs(dz) : Infinity;
  let t = 0;
  for (let guard = 0; guard < 4096; guard++) {
    const tNext = Math.min(tMX, tMZ, 1);
    if (cb(i, j, (tNext - t) * total) === false) return false;
    if (tNext >= 1) return true;
    t = tNext;
    if (tMX < tMZ) { i += stepI; tMX += tDX; } else { j += stepJ; tMZ += tDZ; }
  }
  return true;
}

const SMOOTH_LOOKAHEAD = 24;   // cells to try to reach ahead — bounds the pass at O(n·k)
let aiSmoothPath = !QS.has('nosmooth');   // string-pull A* routes (RR.setSmooth) — A/B knob
let smoothClear = !QS.has('nosmoothclear');  // a shortcut must keep a clear ring around it (RR.setSmoothClear)
let smoothCut = 0, smoothKept = 0;        // waypoints removed / kept, so the pass can prove it works
const _smooth = (v, pts) => {
  if (!aiSmoothPath) return pts;
  const out = smoothPath(v, pts);
  smoothCut += pts.length - out.length; smoothKept += out.length;
  return out;
};
function smoothPath(v, pts) {
  if (!pts || pts.length < 3) return pts;
  const c = grid.cell;
  const costAt = (x, z) => vehCellCost(v, Math.round(x / c), Math.round(z / c));
  // What the straight line a→b costs, priced the way A* prices ground. Infinity if it is blocked
  // anywhere along the way, so an impassable line can never win the comparison.
  //
  // This walks the EXACT cells the segment passes through (grid traversal) rather than sampling
  // points along it. Sampling — even twice per cell — steps over a cell the line only clips at a
  // corner, and the first version of this pass did exactly that: it produced one route straight
  // through blocked ground out of 35. A shortcut test that is merely usually right is worse than
  // none, because every route it waves through is one the pathfinder already declined.
  const lineCost = (a, b) => {
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    if (len < 1e-6) return 0;
    let sum = 0;
    const ok = walkCells(a.x, a.z, b.x, b.z, (i, j, seg) => {
      const cc = vehCellCost(v, i, j);
      if (!isFinite(cc)) return false;                   // blocked: stop the walk, reject the line
      sum += cc * seg;
      return true;
    });
    return ok ? sum : Infinity;
  };
  // CLEARANCE, asked SEPARATELY from cost — and the separation is the whole point. "Is every cell
  // passable?" is a question about CELLS; driving is a question about a HULL, and this one is 3u
  // wide. A line can thread legally between two blocked cells and scrape both: measured, the
  // first version cut the margin to blocked ground from a full cell down to 0.5u. In the open
  // that is harmless (transit-stuck in `advance` went DOWN, 940 -> 857); in the tight ground
  // around a base it is not (`suppress` 93 -> 307, scuttles 8 -> 18, nav alarms 49 -> 89).
  //
  // The first attempt at this fix folded the check INTO lineCost, which was much worse and worth
  // recording: lineCost also prices the ORIGINAL legs, A* legitimately routes through gaps with
  // no clearance, so those legs became Infinity too — and `Infinity <= Infinity` is true, so
  // every shortcut passed. A test that returns "impossible" for both sides of a comparison
  // silently approves everything.
  //
  // Note this does not change what A* may route through: a one-cell corridor stays navigable, it
  // just keeps its staircase. Only the SHORTCUT has to earn the room.
  const hasRoom = (a, b) => smoothClear ? walkCells(a.x, a.z, b.x, b.z, (i, j) => {
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++)
      if ((di || dj) && cellBlocked(v, i + di, j + dj)) return false;
    return true;
  }) : true;
  const out = [pts[0]];
  let i = 0;
  while (i < pts.length - 1) {
    let best = i + 1, walked = 0;
    const far = Math.min(pts.length - 1, i + SMOOTH_LOOKAHEAD);
    for (let j = i + 1; j <= far; j++) {
      // Price the original stretch one leg at a time, with the same function used on the
      // shortcut, so the comparison is like for like rather than two approximations.
      walked += lineCost(pts[j - 1], pts[j]);
      if (j <= i + 1 || !isFinite(walked)) continue;
      const cand = lineCost(pts[i], pts[j]);
      // Finite AND no dearer AND with room for the hull. isFinite is not redundant: without it an
      // unreachable candidate compared against an unreachable original would compare equal.
      if (isFinite(cand) && cand <= walked + 1e-6 && hasRoom(pts[i], pts[j])) best = j;
    }
    out.push(pts[best]);
    i = best;
  }
  return out;
}

function planPath(v, dest, opts = {}) {
  // A FLYER'S ROUTE IS THE STRAIGHT LINE. The Valkyrie ignores walls, crosses water and flies
  // over trees, so nothing on the map can block it and the smoothing pass above would collapse
  // any route it found back to exactly this. Skipping the search is not a special case sneaking
  // navigation back out — it is the answer the search would return, for free.
  if (v._move && v._move.ignoreWalls) return [{ x: dest.x, z: dest.z }];
  _planFrame++; const _byK = opts.by || 'nav';
  _planBy[_byK] = (_planBy[_byK] || 0) + 1;
  _planByAll[_byK] = (_planByAll[_byK] || 0) + 1;   // unconditional: the panel's copy resets, this one does not
  if (PERF) _planCount++;
  const c = grid.cell;
  const start = { i: Math.round(v.holder.position.x / c), j: Math.round(v.holder.position.z / c) };
  let goal = { i: Math.round(dest.x / c), j: Math.round(dest.z / c) };
  goal = nearestOpenCell(v, goal.i, goal.j, 7) || goal;
  const iMax = Math.ceil(map.worldW / 2 / c) + 10, jMax = Math.ceil(map.worldH / 2 / c) + 10;
  const inBounds = (i, j) => i >= -iMax && i <= iMax && j >= -jMax && j <= jMax;
  const cost = (i, j) => vehCellCost(v, i, j);
  // Node budget scales with the grid: 9000 was tuned on smaller maps and left units on the big
  // default (480) map with NO route to a far goal (they then beelined into terrain and wedged).
  // Capped so a genuinely-unreachable search still bails cheaply. partial:true → on failure A*
  // returns a valid route to the closest reachable cell, so the unit still makes real progress.
  const gridArea = (2 * iMax + 1) * (2 * jMax + 1);
  // ORDINARY NAVIGATION ONLY. Callers that pass their own nodeMul (the standoff solver asks for
  // ~22500) have tuned budgets of their own and must not be scaled underneath them — the note
  // below records what happened last time this number was touched globally.
  // WHY THIS KNOB EXISTS: measured 2026-08-10, 5-12% of sampled routes come back budgetHit, and
  // the comment below says searches already hit their cap HALF the time. Meanwhile the replan
  // cadence has collapsed since this was tuned — NAV_TTL used to be 1.1s and is now 7s, and the
  // measured rate is 0.32-0.49 replans/sec against a 2/s ceiling. A budget sized for a
  // high-frequency regime is being paid in a low-frequency one, where the design is explicitly
  // "one expensive search per route, then follow it".
  const _navMul = opts.nodeMul || aiNavBudgetX;
  let maxNodes = Math.round(Math.min(16000, Math.max(9000, Math.round(gridArea * 0.4))) * _navMul);
  // NOTE: a per-frame NODE budget was tried here and backed out. Measured over 4 seeds, a pass
  // expands 9001 nodes at the median — searches already run to their own maxNodes cap half the
  // time — so a 12000 budget clipped only 0.7% of passes yet cost the standoff solver (which asks
  // for 22500) enough to push unreachable-GOTO violations up 56%. Capping a cost that is already
  // capped buys nothing; making each cell cheaper is what pays. See the static nav bitmap.
  const path = astarGrid({ start, goal, cost, inBounds, turnPenalty: 3, allowDiagonal: true, maxNodes, partial: true, hScale: NAV_HSCALE });
  if (path) _astarFrameNodes += path.nodes || 0;
  if (!path || path.length < 2) {
    // BOXED-IN START: parked hard against a wall/shoreline, every neighbouring cell can be
    // blocked, so the search dies on the spot and the unit used to drop to a DIRECT beeline
    // (sometimes straight at open water). Restart from the nearest open cell — the unit makes
    // one short direct hop to that first waypoint, then follows a real A* route.
    const s2 = nearestOpenCell(v, start.i, start.j, 4, 1);
    if (s2) {
      const p2 = astarGrid({ start: s2, goal, cost, inBounds, turnPenalty: 3, allowDiagonal: true, maxNodes, partial: true, hScale: NAV_HSCALE });
      if (p2 && p2.length >= 1) { _astarFrameNodes += p2.nodes || 0; const o2 = detourMines(v, _smooth(v, p2.map(n => ({ x: n.i * c, z: n.j * c })))); o2.budgetHit = !!p2.budgetHit; return o2; }
    }
    return null;
  }
  // Smooth BEFORE the mine detour: detourMines bends the route around spotted mines, and that
  // avoidance must survive into the final shape rather than be straightened back out of it.
  const out = detourMines(v, _smooth(v, path.map(n => ({ x: n.i * c, z: n.j * c }))));
  out.budgetHit = !!path.budgetHit;   // carried through the transforms: "partial because FAR" ≠ "partial because UNREACHABLE"
  return out;
}


// --- A* search visualizer (debug overlay) ------------------------------------
// Toggle with the `v` key (or RR.astar()). It records the real A* search and lets
// you step/scrub through the frontier expansion. buildGrid(name) hands the viz the
// SAME cost field the game uses, so what you watch is exactly what units/roads see.
let _astarViz = null;
let _astarVizVeh = null;   // when set (e.g. auto-probe on a Firebrat), the viz uses THIS unit's real cost
function buildAstarGrid(name) {
  const c = grid.cell;
  if (name === 'road layout') {
    const iMax = Math.floor(map.worldW / 2 / c), jMax = Math.floor(map.worldH / 2 / c);
    return {
      cost: (i, j) => roadNet._cost(i, j),
      inBounds: (i, j) => roadNet._inBounds(i, j),
      bounds: { iMin: -iMax, iMax, jMin: -jMax, jMax },
      allowDiagonal: false, turnPenalty: 6,
    };
  }
  // unit nav: use the REAL per-vehicle cost (shared vehCellCost) so the viz matches the actual
  // navigator exactly. Prefer the unit under inspection (_astarVizVeh), else the player, else a
  // live combatant, else a plain ground stand-in.
  const rep = _astarVizVeh || player || combatants[0] ||
    { _move: { water: 'sink', ignoreWalls: false, tree: 'bump' }, _archetype: 'warrior', type: 'lurcher', holder: { position: { x: 0, z: 0 } } };
  const cost = (i, j) => vehCellCost(rep, i, j);
  const iMax = Math.ceil(map.worldW / 2 / c) + 2, jMax = Math.ceil(map.worldH / 2 / c) + 2;
  return { cost, inBounds: (i, j) => i >= -iMax && i <= iMax && j >= -jMax && j <= jMax,
    bounds: { iMin: -iMax, iMax, jMin: -jMax, jMax }, allowDiagonal: true, turnPenalty: 3 };
}
// Hover height for the overlay plane: just above the tallest terrain in the grid
// (coarse sample) so the sheet floats over the island, bases poking through.
function astarHoverY() {
  const c = grid.cell, iMax = Math.ceil(map.worldW / 2 / c), jMax = Math.ceil(map.worldH / 2 / c);
  let mx = -Infinity;
  for (let i = -iMax; i <= iMax; i += 4) for (let j = -jMax; j <= jMax; j += 4) {
    const h = map.heightAt(i * c, j * c); if (isFinite(h) && h > mx) mx = h;
  }
  return (isFinite(mx) ? mx : 0) + 8;
}
function toggleAstarViz() {
  if (!_astarViz) _astarViz = new AstarViz();
  if (_astarViz.isOpen) { _astarViz.close(); paused = false; return; }   // resume the sim
  _astarViz.open({
    buildGrid: buildAstarGrid, gridNames: ['unit nav', 'road layout'], defaultGrid: 'unit nav',
    three: THREE, scene, camera, domElement: renderer.domElement, cell: grid.cell, hoverY: astarHoverY(),
  });
  paused = true;   // freeze the sim while inspecting paths, like the full-screen log
}
// Stuck-escalation: after this many seconds genuinely stuck, a unit marks the spot it's
// grinding impassable (avoidCell) and replans AROUND it, instead of repeating forever.
const NAV_BLOCK_AFTER = 6.0;        // seconds stuck before we blacklist the trouble spot + replan
const NAV_AVOID_MS = 5000;          // how long a blacklisted cell stays no-go (then it reopens)
const navAvoid = new Map();         // cellKey "i,j" -> expiry timestamp (ms); temporary A* no-go zones
function avoidCell(x, z) {
  const c = grid.cell, i = Math.round(x / c), j = Math.round(z / c);
  navAvoid.set(i + ',' + j, performance.now() + NAV_AVOID_MS);
}
// Maintain a unit's cached path toward `dest` and return the next waypoint to steer
// at (skips waypoints already reached). Replans on a timer, when the goal moves, or
// when the path runs out. Returns a world {x,z}, or null to fall back to direct seek.
// ── EVENT-DRIVEN PATH INVALIDATION ─────────────────────────────────────────────
// A planned path stays valid until the WORLD it was planned in changes — and the world
// only changes at a handful of known events: a blocking structure dies or gets rebuilt
// (Destructible hooks below), a player fort goes up, the obstacle set rebuilds, a mine
// is laid / spotted / detonated. Each bumps this epoch; navWaypoint replans a cached
// path only when its epoch is stale (or its goal moved, or it ran out). Before this,
// every path silently expired after 1.1s — a unit crossing the island to a STATIC goal
// re-ran a full A* search ~once a second for the whole trip, "just in case". A long
// TTL remains as a safety net for anything unmodeled.
const NAV_TTL = 7;   // s — safety-net expiry (was the 1.1s "just in case" cadence)
// How long a cached "can I still reach my stand?" answer is trusted. 2s cuts that test from ~20
// searches/sec per sieging unit to at most one every two seconds — a ~40x reduction — while
// keeping the staleness window short enough that a unit which has just been boxed in finds out
// quickly. Deliberately not longer: the call exists BECAUSE a wrong "no path" stranded a unit.
const REACH_TTL = 2;
// Grade a mission tour in proportion to what it achieved, instead of pass/fail at 3% fort damage.
// A/B via RR.setGradedTour / ?nograded — off restores the old binary test exactly.
let aiGradedTour = !QS.has('nograded');
// File the report card under the DIRECTIONAL mission key the scorer reads, not the base name.
// A/B via RR.setMsnDirKey / ?nodirkey — off restores the old (mis-filing) behaviour.
let aiMsnDirKey = !QS.has('nodirkey');
// Protect the LAST firebrat: it is the only unit that can carry a flag, so don't spend it on
// errands and don't bet it on a still-armed fort. A/B via RR.setSaveRunner / ?nosaverunner.
let aiSaveRunner = !QS.has('nosaverunner');
// Treat the closest reachable point as arrival when the driver proves a goal unreachable, instead
// of re-issuing the impossible order until the unit is scuttled. A/B via RR.setReachArrive.
let aiReachArrive = !QS.has('noreacharrive');
const REACHCAP_TTL = 25;   // s a cap is honoured before the real goal is retried
setSaveRunnerScore(aiSaveRunner);   // keep the scorer's copy in step with the deploy guard
setReqVehicle(aiReqVehicle);        // ditto for the can-we-crew-it term (module flag, same pattern)
setFightMission(aiFightMission);    // …and for the Fight mission joining the candidate list
// MEASURED 2026-08-10, three independent 240-seed sets each. See
// VERDICT_2026-08-10_overnight_summary.txt.
// SHIPPED: resolution 237 -> 237 exactly, every stuck column within 7 samples, against a baseline
// measured as deterministic. Kept for CORRECTNESS (incumbentBonus was pricing the abandoned plan),
// and the tournament's only job was to prove it free. ?nomsnkeyfix restores the old behaviour.
setMsnKeyFix(!QS.has('nomsnkeyfix'));
// NOT SHIPPED. Looked like the best result of the night on one seed set and did not replicate:
// resolved +2 / -1 / +1 across seeds 11+, 5011+, 9011+. The SIGN FLIPS, so there is no reliable
// effect — the frozen level-memories are real (see setTrigFix) but do not cost enough matches to
// measure. Left opt-in rather than deleted: the diagnosis is sound and may matter once something
// else raises its exposure.
setTrigFix(QS.has('trigfix'));
// NOT SHIPPED. Every movement column improved and matches ran 7s faster, but resolution 237 -> 236
// — and a -1 is REAL here, not noise. No reason to buy it while trigfix, its only partner, is dead.
setScoreClock(QS.has('scoreclock'));
setFleeScore(aiFleeScore);          // …and for Flee joining it too
let _navEpoch = 0;
function bumpNavEpoch() { _navEpoch++; }
Destructible.onBlocksChanged = bumpNavEpoch;   // structure died/rebuilt → routes opened/closed

// A route cut short by the SEARCH BUDGET is not a finished journey — it is a job to pick back up.
// Retries are spaced and escalate the node budget, then stop: an impossible goal must not re-search
// every frame (that was the perf sawtooth failT exists to stop), and it must not retry forever
// either. After the last try the route is handed on with budgetHit CLEARED, which lets the driver's
// contract convict the order and the mission re-score — a loud failure instead of a silent park.
const NAV_PARTIAL_RETRY = 0.5;   // s between retries of a budget-truncated route
const NAV_PARTIAL_TRIES = 3;     // …then give up and let the contract alarm
// HOW HARD TO ASK ON A RETRY. nodeMul by retry number: the first search runs the base budget, and
// each retry doubles it. The old ladder was `1 + retryN` — 2x, 3x, 4x — which MEASURED AS NOT
// ENOUGH: seed 1572's lurcher at (57,125) held a 3-point budget-truncated route to a goal 39u away
// with retryN already at 1, and asking the SAME query at nodeMul 8 returned a complete 13-point
// route that reached it. A route existed; the search was never allowed to find it.
// Doubling rather than incrementing because search cost grows with area, not with attempt number.
// SAFE BY CONSTRUCTION: NAV_FRAME_BUDGET_MS still caps A* per AI pass, so a bigger search cannot
// add replans — it spends the frame's budget sooner and the other units defer to the next frame.
// Measured headroom before the change: 0.32-0.49 replans/sec across 4 seeds, against Jacob's 2/s
// ceiling, and this ladder only ever runs on the retry path.
// MEASURED AND NOT SHIPPED. 240 seeds: resolution EXACTLY flat, and the movement columns drifted
// the wrong way (inland transit-stuck +35%). The reason is exposure — retryN reaches 2 or more on
// about 0.1% of samples, so the ladder almost never differs from the old `1 + retryN`. The one
// case that motivated it is real; it is simply too rare to pay for. ?navescalate to try it.
// I shipped this default-ON before measuring it, which is exactly the habit this file's other
// comments keep warning about. Measured, then switched off.
const NAV_RETRY_MUL = [1, 2, 4, 8];
const aiNavEscalate = QS.has('navescalate');
// Default ON: this closes a SILENT deadlock (no alarm, no stuck sample, no re-score), and a silent
// failure that the harness cannot see is the worst kind to leave switched off. ?nonavretry for the A/B.
const aiNavRetry = !QS.has('nonavretry');
function navWaypoint(nav, v, dest, dt) {
  nav.t -= dt;
  if (nav.failT > 0) nav.failT -= dt;
  if (nav.retryT > 0) nav.retryT -= dt;
  const moved2 = nav.dx == null ? Infinity : (dest.x - nav.dx) ** 2 + (dest.z - nav.dz) ** 2;
  const c = grid.cell;
  // A FAILED plan (no route — unreachable/blocked goal) used to leave nav.path null, so the
  // trigger below re-ran a full-grid A* search EVERY FRAME while a unit was stuck — ~80% of
  // CPU in cellBlocked (the perf sawtooth). failT gates retries after a failure so we search
  // at most a few times a second instead of 60×; a valid path (or a forced null) replans as before.
  if ((!nav.path || nav.idx >= nav.path.length || nav.t <= 0 || nav.epoch !== _navEpoch || moved2 > (c * 2) ** 2) && !(nav.failT > 0)) {
    const hasUsablePath = nav.path && nav.idx < nav.path.length;
    if (hasUsablePath && _astarFrameMs >= NAV_FRAME_BUDGET_MS) {
      // Per-frame A* budget spent: keep following the current route and retry the refresh next
      // frame, so a crowd of simultaneous replans spreads across frames instead of spiking.
      nav.t = 0.03;
    } else {
      // Tag WHY this search is happening, against the state that asked for it — an aggregate
      // replans/s never said which subsystem was moving a goal, which is the only thing worth
      // knowing when the number is high.
      // The cause tally is now UNCONDITIONAL (two integer bumps per replan). It used to be ?perf
      // only, which meant the headless rig could not see it and the question "why does nav replan
      // so often" could only be answered from a hand-held recording — and the recording we had
      // turned out to carry no call tree, so it could not answer it either. _pfWhy still feeds the
      // on-screen panel and is cleared each window; _pfWhyAll accumulates for the whole match and
      // is what RR.replanWhy() reports.
      const w = !nav.path ? 'no_path' : nav.idx >= nav.path.length ? 'consumed'
        : nav.t <= 0 ? 'timer' : nav.epoch !== _navEpoch ? 'map_changed' : 'goal_moved';
      const k = `${w}/${(v && v._aiState) || '-'}`;
      if (PERF) _pfWhy[k] = (_pfWhy[k] || 0) + 1;
      _pfWhyAll[w] = (_pfWhyAll[w] || 0) + 1;
      _pfWhyAll[k] = (_pfWhyAll[k] || 0) + 1;
      const _s = performance.now();
      // Escalate the search on a retry: the previous attempt ran out of nodes, so repeating it with
      // the same budget would return the same truncated route. On the LAST try, clear budgetHit so
      // "we don't know" becomes "we could not get there" and the contract is allowed to speak.
      const _mul = !nav.retryN ? 1
        : aiNavEscalate ? NAV_RETRY_MUL[Math.min(nav.retryN, NAV_RETRY_MUL.length - 1)]
        : 1 + nav.retryN;
      nav.path = planPath(v, dest, _mul > 1 ? { nodeMul: _mul } : undefined);
      if (nav.path && nav.retryN > NAV_PARTIAL_TRIES) nav.path.budgetHit = false;
      nav.idx = 0; nav.t = NAV_TTL; nav.dx = dest.x; nav.dz = dest.z;
      nav.epoch = _navEpoch;
      _astarFrameMs += performance.now() - _s;
      nav.failT = nav.path ? 0 : 0.6;   // no route → don't re-run the search for 0.6s
      if (!nav.path) return null;
    }
  }
  if (!nav.path) return null;
  // Follow the path LOCALLY: consume the current waypoint only once the unit reaches it
  // (capture radius) or has clearly driven PAST it (it's nearer the NEXT node). Both
  // tests compare just idx vs idx+1, so the index marches forward one step at a time and
  // can NEVER leap to a far waypoint that merely sits near the unit. (Scanning the whole
  // remaining path for the global nearest did exactly that on a curving/staircase road —
  // a later node passes close, idx jumps to it, waypoints vanish off the front and the
  // unit veers off-road chasing it, until the next replan resets it. That was the jitter.)
  const px = v.holder.position.x, pz = v.holder.position.z;
  while (nav.idx < nav.path.length - 1) {
    const w = nav.path[nav.idx], nx = nav.path[nav.idx + 1];
    const dCur = (w.x - px) ** 2 + (w.z - pz) ** 2;
    if (dCur < (c * 1.2) ** 2) { nav.idx++; continue; }    // reached this waypoint
    if ((nx.x - px) ** 2 + (nx.z - pz) ** 2 < dCur) { nav.idx++; continue; }   // driven past it (nearer the next)
    break;
  }
  // PARKED ON THE END OF A TRUNCATED ROUTE — the deadlock this whole block exists to break.
  // The loop above stops at length-1, so the FINAL waypoint is never consumed and nav.idx never
  // reaches nav.path.length: the 'consumed' replan never fires. The unit is not stuck either (it
  // is sitting on its waypoint, so every stuck clock reads zero), and the driver's contract stays
  // quiet because budgetHit means "the search ran out of nodes", which proves nothing. Net result,
  // observed live on 2026-08-09: a lurcher at full hp/ammo/fuel parked in its own base for
  // thousands of seconds with its order still reading GOTO 20u away, and not one alarm anywhere.
  // Silent, so it contributes NOTHING to any tournament number — which is why the harness could
  // never find it.
  if (aiNavRetry && nav.path.budgetHit && nav.idx >= nav.path.length - 1) {
    const slack = Math.max(grid.cell * 1.2, 9);
    if ((dest.x - px) ** 2 + (dest.z - pz) ** 2 > slack * slack && !(nav.retryT > 0)) {
      nav.retryN = (nav.retryN || 0) + 1;
      nav.retryT = NAV_PARTIAL_RETRY;   // spaced: an impossible goal must not re-search every frame
      nav.path = null; nav.t = 0;       // …and pick it back up on the next call, with more budget
      return null;
    }
  } else if (nav.retryN) { nav.retryN = 0; }   // got somewhere real — the escalation resets
  return nav.path[nav.idx];
}
// Steer a vehicle toward a world point — now a thin wrapper over the ONE locomotion
// primitive (js/Locomotion.js), so every nav follower shares the same square-up easing,
// deadzone, and chassis capabilities. An omni chassis (the Lurcher's six legs) additionally
// gets an immediate strafe component: it starts translating toward the point while the
// nose is still swinging, so there is no turning circle to orbit.
function steerToward(v, wx, wz) {
  return locomote({ x: v.holder.position.x, z: v.holder.position.z, heading: v.heading, omni: !!v._move.omni },
    { goto: { x: wx, z: wz }, arrive: 0.001 });
}

// Drive the hull with the pedals THE CHASSIS-CORRECT WAY — the one drive boundary every
// AI motion funnels through. omniTravel: an omni chassis (the Lurcher) folds fwd+strafe
// into a world vector and takes driveOmni (independent nose, no turning circle). Everything
// else — tank chassis always, and the omni hull during COMBAT footwork (whose fire gates
// key off hull bearing, so drive() must own the heading) — takes classic drive().
// _driveHome once fed omni pedals (fwd+strafe from locomote) through classic drive(): the
// hull turned WHILE strafing and the recall orbited its own goal for minutes (tournament
// seeds 95/109/116, 182s worst). One helper, one contract, both call sites.
// ── FRIENDLY RIGHT-OF-WAY (path reservation) ─────────────────────────────────
// The last stuck class on the original catalog: friendlies converging on a contested
// pocket shove each other (the elevated congestion alarms after slice 3). This is
// cooperative pathfinding, the CHEAP way Jacob framed it — no A* replan. Each tick the
// table is rebuilt from scratch: every field unit stamps the cell it holds plus a short
// lookahead along its route, tagged with a deterministic PRIORITY (a flag carrier
// outranks everyone; a stable per-unit ordinal breaks ties — no RNG, so the exact
// instrument stays exact). At drive time a unit eases off when an ONCOMING/CROSSING
// higher-priority friendly has claimed the ground just ahead — so two units never both
// pile into a throat and then have to back out. A same-heading leader is NOT a conflict
// (no convoy crawl). Rebuilt clean each tick → order-independent, no cross-tick state,
// bit-deterministic.
let aiRightOfWay = true;              // RR.setRightOfWay(false) to A/B the whole system
const RESV = new Map();               // cellKey -> { prio, owner, vx, vz, x, z }
let _resvSeq = 0;                     // monotonic per-unit ordinal source (stable tiebreak)
const RESV_LOOKAHEAD = 6;             // cells of route stamped ahead (~ the next few seconds)
function resvKey(i, j) { return (i + 4096) * 100000 + (j + 4096); }
function unitPriority(v) {
  // strict, deterministic total order. Flag carrier dominates (Jacob's explicit rule);
  // otherwise the stable ordinal — an older unit (lower ordinal) has right of way, so
  // the assignment never oscillates between two friendlies.
  let p = -(v._resvOrd || 0);
  for (const f of flags) if (f.carried && f.carrier === v) { p += 1e6; break; }
  return p;
}
function _resvClaim(i, j, prio, v) {
  const k = resvKey(i, j), cur = RESV.get(k);
  if (!cur || prio > cur.prio) RESV.set(k, { prio, owner: v, vx: v._vx || 0, vz: v._vz || 0,
    x: v.holder.position.x, z: v.holder.position.z });
}
function stampReservation(v) {
  // Flyers never touch the ground reservation grid — same convention as blockedFor/
  // _navOverride (both already skip ignoreWalls entirely). A flyer occupies different
  // airspace than a grounder; it has no cell to claim and nothing to yield for. Leaving
  // _resvOrd unset also makes reservationYield's own null-check exempt it below, for free.
  if (v._move.ignoreWalls) return;
  if (v._resvOrd == null) v._resvOrd = ++_resvSeq;
  const prio = unitPriority(v), c = grid.cell;
  const px = v.holder.position.x, pz = v.holder.position.z;
  _resvClaim(Math.round(px / c), Math.round(pz / c), prio, v);      // the cell it holds
  const nav = v._resvNav;
  if (nav && nav.path && nav.idx < nav.path.length) {
    // stamp the route ahead: sample points every ~one cell along the remaining waypoints
    let lx = px, lz = pz, budget = RESV_LOOKAHEAD * c, idx = nav.idx;
    while (budget > 0 && idx < nav.path.length) {
      const w = nav.path[idx]; let dx = w.x - lx, dz = w.z - lz, d = Math.hypot(dx, dz);
      if (d < 0.01) { idx++; continue; }
      const stepN = Math.min(budget, d), ux = dx / d, uz = dz / d;
      for (let s = c; s <= stepN; s += c) _resvClaim(Math.round((lx + ux * s) / c), Math.round((lz + uz * s) / c), prio, v);
      budget -= stepN; lx += ux * stepN; lz += uz * stepN;
      if (stepN >= d) idx++; else break;
    }
  } else {
    // no route (combat maneuver, or first tick) — project along velocity, else heading
    let dx = v._vx || 0, dz = v._vz || 0, sp = Math.hypot(dx, dz);
    if (sp < 0.5) { dx = -Math.sin(v.heading); dz = -Math.cos(v.heading); sp = 1; }
    dx /= sp; dz /= sp;
    for (let k = 1; k <= RESV_LOOKAHEAD; k++) _resvClaim(Math.round((px + dx * c * k) / c), Math.round((pz + dz * c * k) / c), prio, v);
  }
}
function updateReservations() {
  if (!aiRightOfWay) return;
  RESV.clear();
  for (const v of combatants) if (!v.dead && !vehicleHidden(v)) stampReservation(v);
}
// Returns 1 (drive normally) or 0 (yield: hold forward, let the higher-priority friendly
// clear). Only an ONCOMING/CROSSING claimant that's actually close counts — a same-heading
// leader ahead is just someone to follow, not a conflict.
function reservationYield(v) {
  if (!aiRightOfWay || v._resvOrd == null) return 1;
  const myPrio = unitPriority(v), c = grid.cell;
  let dx = v._vx || 0, dz = v._vz || 0, sp = Math.hypot(dx, dz);
  if (sp < 0.5) { dx = -Math.sin(v.heading); dz = -Math.cos(v.heading); sp = 1; }
  dx /= sp; dz /= sp;
  const px = v.holder.position.x, pz = v.holder.position.z;
  for (let k = 1; k <= 2; k++) {
    const cell = RESV.get(resvKey(Math.round((px + dx * c * k * 0.85) / c), Math.round((pz + dz * c * k * 0.85) / c)));
    if (!cell || cell.owner === v || cell.prio <= myPrio) continue;
    // FRIENDLY right-of-way ONLY — the name always said so, the code never checked it. An
    // enemy occupying our path is a fight, not a traffic conflict: it has no reason to ever
    // clear the cell for us, so deferring to it is a permanent, silent stand-off (traced:
    // seed 32's valkyrie froze 44s+ yielding to a red lurcher 9u away that was never going
    // to move). Enemies get resolved by the fight-or-flight/engage ladder, not by yielding.
    if (cell.owner.team !== v.team) continue;
    const od = Math.hypot(cell.x - px, cell.z - pz);
    if (od > 14) continue;                                   // the claimant isn't near enough to conflict
    const theirSp = Math.hypot(cell.vx, cell.vz);
    if (theirSp > 0.5 && (dx * cell.vx + dz * cell.vz) / theirSp > 0.6) continue;   // same-direction leader → follow, don't yield
    return 0;                                                // conflict — yield the ground
    // (A tighter trigger — 11u / require head-on — was measured: it halved the yields and
    // returned alarms to baseline, but gave back most of the congestion win AND a resolution.
    // The anti-shove yields and the occasional grind-relocation are coupled; this trigger
    // keeps the full congestion relief at the cost of ~14 more grind alarms across 30 matches.)
  }
  return 1;
}

// COMMANDED TO MOVE, NOT MOVING. The bluntest possible stuck detector, and the only one that
// caught seed 74: a healthy firebrat sat motionless for 270 SECONDS at full throttle, alone on
// clear ground with a valid 4-node route — while the driver's stall clock, the brain's
// _stillT/_wedgeT unstick reflex and the tournament's stuck classifier ALL reported normal (it
// was even filed as "idle-at-goal — not wedged"). Every one of those reasons about goals,
// arrival radii or intent, and each can be laundered by order churn or by a brain that believes
// it has arrived. This asks only: are the pedals down, and did we move? Nothing can launder that.
// It also reports the unit's height above terrain, which is what actually explained seed 74 —
// the runner was stranded 2.5u UP on a wall/elevator lip while the nav grid read clear below.
const NOMOVE_ALARM_S = 12;      // seconds of "wants to move, gets nowhere" before we shout
const NOMOVE_NET = 6;           // world units of NET progress in that window that counts as moving
function _noMoveWatch(v, dt) {
  // Key on the BRAIN'S INTENT (_wantMove), not the pedals that reach the chassis: the nav layer
  // overwrites the brain's fwd/turn, so a unit whose brain is driving but whose nav yields nothing
  // presents as "not commanded" at the drive boundary — exactly the case worth catching.
  // And measure NET progress over a WINDOW, never per-tick displacement: the seed-74 runner was
  // not frozen, it was VIBRATING — jittering ~0.4u every tick, which reset a per-tick check
  // forever while covering no ground at all. Same reason the tournament measures net move over 10s.
  const wants = !!(v.ai && v.ai._wantMove);
  const p = v.holder.position;
  // Intent FLICKER must not launder a wedge either. A unit bouncing between "arrived" and "not
  // arrived" drops _wantMove for single ticks; resetting on the first false tick let seed 74's
  // runner reset the window forever. Only forgive after a sustained idle.
  if (!wants) {
    v._nmIdle = (v._nmIdle || 0) + dt;
    if (v._nmIdle > 2) { v._nmT = 0; v._nmX = p.x; v._nmZ = p.z; v._nmSaid = false; }
    return;
  }
  v._nmIdle = 0;
  if (v._nmX == null) { v._nmX = p.x; v._nmZ = p.z; v._nmT = 0; return; }
  v._nmT = (v._nmT || 0) + dt;
  if (v._nmT < NOMOVE_ALARM_S) return;
  const net = Math.hypot(p.x - v._nmX, p.z - v._nmZ);
  if (net > NOMOVE_NET) { v._nmX = p.x; v._nmZ = p.z; v._nmT = 0; v._nmSaid = false; return; }
  if (!v._nmSaid) {
    v._nmSaid = true;
    const cm = commanders.find(c => c.team === v.team);
    const air = +(p.y - map.heightAt(p.x, p.z)).toFixed(1);
    const d = (cm && cm._slotFor && cm._slotFor(v) && cm._slotFor(v)._dbg) || {};
    aiLog(v.team, `[STUCK ALARM] ${(cm && cm.cname) || v.team}: ${v.type} has wanted to move for `
      + `${NOMOVE_ALARM_S}s and covered ${net.toFixed(1)}u — @(${Math.round(p.x)},${Math.round(p.z)}) `
      + `hp ${Math.round(100 * v.hp / v.maxHp)}%, state=${d.state || v._aiState || '-'}, `
      + `goal=(${d.gx},${d.gz}) ${d.gd}u out, path=${d.navPath}, blk=${d.blk}, mnv=${d.mnv || '-'}. `
      + `It is being driven and going nowhere — this is a BUG, not a decision.`);
  }
  v._nmX = p.x; v._nmZ = p.z; v._nmT = 0;   // re-anchor so a persistent wedge can report again
}
function driveChassis(v, out, dt, omniTravel) {
  // HOLD THE PAD WHILE THE SHIELD IS UP. The elevator shield blocks damage completely, but only
  // while the unit stands on the pad — so a unit that has chosen to fight from cover must not
  // then drive out of it. The combat behaviours press, orbit and strafe toward their target; here
  // we keep the turn (aim) and drop the translation, so it fights from the doorway for the few
  // seconds the shield lasts and leaves under its own power afterwards.
  // ...BUT ONLY IF THERE IS SOMETHING TO FIGHT. The rule above says a unit that has "chosen to
  // fight from cover" must not drive out of it — except nothing ever checked that it chose to
  // fight. Every vehicle rolled off the lift and stood still for the whole shield timer, and
  // because the hold zeroes the throttle it cannot drive off the pad to end it early: it waited
  // out all five seconds even on an empty map. MEASURED: 5.77s of sitting after the lift tops, on
  // 65 of 82 deploys with no enemy within 80u. Cover is worth standing in when a rival can shoot
  // you and worth nothing when one cannot, so ask.
  if (aiPadFight && v.ammo > 0 && elevShieldOn(v) && padThreatNear(v)) { out.fwd = 0; out.strafe = 0; }
  // REVERSE CAP (doctrine): every chassis backs up at HALF throttle — reverse is a
  // maneuver tool (kite, reverse-arc, backing out of a notch), never a fast way to
  // travel; a unit that wants to go the other way turns around. The omni Lurcher is
  // exempt: its six legs give it full speed in ANY direction by design.
  if (aiReverseCap && out.fwd < -0.5 && !v._move.omni) out.fwd = -0.5;
  if (omniTravel) {
    const h = v.heading, st = out.strafe || 0;
    const mx = out.fwd * -Math.sin(h) + st * Math.cos(h);
    const mz = out.fwd * -Math.cos(h) + st * -Math.sin(h);
    const mag = Math.hypot(mx, mz);
    v._throttle = Math.min(1, mag + Math.abs(out.turn) * 0.3);
    v.speedMul = roadSpeedMul(v) * rankSpeedMul(v);
    if (mag > 0.02) v.driveOmni(dt, mx / Math.max(1, mag), mz / Math.max(1, mag), null, v._blocked);
    else v.drive(dt, 0, out.turn, null, v._blocked);
  } else {
    v._throttle = Math.min(1, Math.abs(out.fwd) + Math.abs(out.turn) * 0.6 + Math.abs(out.strafe || 0) * 0.6);   // for spatial engine RPM
    v.speedMul = roadSpeedMul(v) * rankSpeedMul(v);   // road boost × promotion (bronze stars)
    v.drive(dt, out.fwd, out.turn, null, v._blocked, out.strafe || 0);
  }
}

// (The rotating siege-stand search lived here — bearings walked around the ideal radial whenever
// the driver refused a spot. It was a search implemented as one full-grid A* per bearing, with the
// goal jumping tens of units per step. Replaced by the siege plan, which vets reachability BEFORE
// committing and relaxes the range band instead of rotating: see _buildSiegePlan/_standoffFor.)
let aiReverseCap = true;    // doctrine: reverse at half throttle (RR.setReverseCap toggles for A/B bisection)
// Fight from under the elevator shield instead of driving out of it (RR.setPadFight for A/B).
// The shield is 5s of TOTAL invulnerability and it only holds ON the pad — leaving is what wastes it.
let aiPadFight = true;
// Vehicle-aware mission failure: swap chassis when one keeps failing a mission (RR.setVehSwap for A/B).
let aiVehSwap = true;
let aiGateBand = !QS.has('nogateband');   // mirror the shut-gate physics slab in nav (RR.setGateBand) — stops the gate-band hug
let aiStandHold = !QS.has('nostandhold');   // hysteretic siege sense: hold a committed stand past the enter ring (RR.setStandHold) — stops the suppress/advance strobe
let aiDefendInPlace = !QS.has('nodefendinplace');   // defend under live fire responds in the CURRENT vehicle, no home-swap (RR.setDefendInPlace)
let aiStand2 = !QS.has('nostand2');   // lab-validated standoff: nearest REACHABLE in-range crossfire-free LOS spot (vs the old radial + _standRot). RR.setStand2
// Drop cached routing state when a SUPPORT mission hands back to the primary — see
// replanOnResume(). THREE forms, because the combined one was measured and REJECTED (240 seeds:
// inland transit-stuck +276%, stuck/resupply 7 -> 88). It fired after every top-up, which is the
// frequent transition that barely moves a unit, rather than the rare one that moves it a long way.
//   'all'   — every support mission, route AND standoff commitment. The rejected form; kept only
//             so the failure can be reproduced.
//   'fight' — duels only. The transition the FIGHT5 evidence actually named.
//   'route' — every support mission, but clears the ROUTE ONLY and never _stand2. Isolates the
//             prime suspect: _stand2 is the field main.js:6140 already carries a scar about
//             ("two siege slots shared one commit and ping-ponged goals every tick").
const REPLAN_MODE = QS.has('replanfight') ? 'fight'
  : QS.has('replanroute') ? 'route'
  : QS.has('replanresume') ? 'all' : '';
let aiLandmass = !QS.has('nolandmass');   // reject destinations on ground the unit can't drive to (see buildNavComp). RR.setLandmass
let aiStandRelease = !QS.has('nostandrelease'); // give up a firing position we're sitting outside our own weapon range of (RR.setStandRelease)
let aiStandRoute = !QS.has('nostandroute');    // route the WHOLE way to a firing position instead of handing the last 26u back to direct steer (RR.setStandRoute)
let aiFlyerRoute = !QS.has('noflyerroute');    // give the Valkyrie a real GOTO (a straight line) instead of no order at all (RR.setFlyerRoute)
// DRIVE ONTO THE SOLVED FIRING POSITION rather than stopping 14u short. The reasoning was sound —
// the standoff solver vets the spot (in range, not too close, on land, out of crossfire, path
// checked), so throwing that away 14u out wastes it — but the 240-seed gate says no, decisively:
//   with it:     239/240 resolved, 1 stalemate, transit-stuck in suppress 254
//   without it:  240/240 resolved, 0 stalemates, transit-stuck in suppress 4
// Everything else in the batch held constant. So the spot is fine and the APPROACH to it is not:
// the last 14u into a firing position is tight, contested ground, and hulls grind there. That is a
// real finding the change earned — it is left in, defaulted OFF, and `?standarrive` turns it back
// on for whoever fixes the approach. Not deleted: the argument for it is still right.
// RE-MEASURED 2026-08-10, three independent 240-seed sets, and the picture INVERTED from the
// 2026-08-08 verdict that turned it off. Resolution is now consistently BETTER — +2 / +1 / +1,
// sign never flips, 711 -> 715 over 720 matches — and suppress-stuck IMPROVED (36 -> 32) where it
// used to be the whole regression (254 vs 4). The nav retry and the parked-unit fix both landed in
// between and both act on exactly the ground that was blamed.
// STILL OFF, deliberately, and this is a judgement call rather than a number: the resolution gain
// is bought with 2-3x the transit-stuck (near-water +190% and +206% on the two fresh sets,
// stuck/advance +97% and +239%) and matches 18-26s slower. More units standing around is worse to
// WATCH, and that is what this game is for. Jacob's call if he wants the trade — ?standarrive.
let aiStandArrive = QS.has('standarrive');
const STAND_ARRIVE = 5;                        // u — close enough to be standing on the spot the solver vetted
const STAND_RELEASE_S = 12;   // seconds held out of our own reach, not shooting, before we re-pick
// How many times ONE tower's firing spot may be re-solved before we stop trying and move down the
// kill order. Without this the escape hatches re-solved forever: each solve returns a slightly
// different spot, which is a new GOTO order, which resets the driver's once-per-order guard.
const SIEGE_RESOLVE_MAX = 2;
// A re-solve rate above this in one match is not a hiccup, it is a loop — shout about it.
const SIEGE_RESOLVE_ALARM = 6;
// Minimum world separation between two firing spots we spend a reachability search on. With few
// searches available, diversity matters more than picking the very nearest — 5 probes around the
// ring beat 5 probes clustered on one side of it.
const SIEGE_SPOT_SPREAD = 26;
// Units of ONE type lost on ONE mission with nothing to show before the commander tries a
// different chassis for it. 2 = "fool me twice". See _vehicleForMission — the mission-level
// success memory benches the PLAN, this benches the PAIRING, so a good plan attempted with the
// wrong vehicle changes tool instead of being abandoned.
const VEH_FAIL_SWAP = 2;
const SCUTTLE_ALARM_N = 4;      // units lost in a row on one mission before we shout about it
const ASTAR_FRAME_ALARM = 12;   // A* searches in ONE frame that mean something is looping, not working
let _astarAlarmed = false;      // fire once per match — an alarm that repeats every frame IS the storm
setCapRoutes(!QS.has('noroute'));     // multi-waypoint capture routes on unless ?noroute (isolation gate)
const STAND = { band: 0.65 };   // stand-off band: min fraction of range to hold out at (0.55 close/fast … 0.85 far/safe). RR.setStandBand

// ── THE DRIVER (js/Driver.js) ────────────────────────────────────────────────
// Each slot seats a Driver: behaviors issue ORDERS (GOTO/DIRECT for now), the driver
// route-follows and drives, and everything is observed — order log, flight recorder,
// a net-progress watchdog whose ALARM dumps an autopsy (and, pinned long enough past
// the grace, scuttles the unit — a stuck vehicle is a bug, not a situation).
const tgtEvents = [];                       // TARGET-DECISION TRACE: one entry per change, written where the decision is made
// Is there still a LIVE gun at this point? A target that stopped existing is a target you are
// SUPPOSED to leave — so without this, a correct switch and a thrashing switch look identical.
const _liveV = new THREE.Vector3();   // own scratch: _threatV is live during threat selection
function liveTurretNear(x, z, r = 8) {
  for (const c of camps) for (const w of (c.walls || [])) {
    const t = w.turret; if (!t || t.dead || t.falling) continue;
    // WORLD position, matching how the target key was built (getWorldPosition on the head).
    // `group.position` is the LOCAL transform — using it made every comparison miss, so every
    // switch reported "the old target is gone" and 6 matches showed 397 tower kills against a
    // board that only has about eight a side. A test that can only return one answer is worse
    // than no test: it turned every case into the answer I was hoping for.
    t.group.updateWorldMatrix(true, false);
    (t.head || t.group).getWorldPosition(_liveV);
    if ((_liveV.x - x) ** 2 + (_liveV.z - z) ** 2 < r * r) return true;
  }
  return false;
}
const navAlarms = [];                       // alarm autopsies this match (flight recordings)
// COUNT TARGETS, NOT CALLS. This was a raw per-call counter, so one hopeless target asked a
// hundred times read the same as a hundred hopeless targets — it measured persistence, not
// breadth. That is not a nitpick: it moved the OPPOSITE way to a fix that plainly worked
// (relaxing the crossfire veto took the default set 69 -> 4 while the fresh set went 202 -> 265,
// and the entire fresh figure turned out to be one target on one seed asked 98 times). A number
// that rises when the thing it names gets better is worse than no number.
const standFailSeen = new Set();            // team|target|chassis — one count per genuinely stuck solve
let standFails = 0;                         // RR.decisionAlarms() — DISTINCT targets with no firing position at all
// Not a failure — a deliberate ugly trade. Counted anyway, because "how often is the only
// firing position under two guns" is a fact about the MAPS we should be able to see, and
// because if this number is large the standoff doctrine is not buying what it costs.
let standCrossfire = 0;                     // RR.decisionAlarms() — stands taken inside another gun's arc
const navScuttles = [];                     // units the driver destroyed for being unable to move
const navScuttlesByTeam = {};               // per-team scuttle tally — RR.navScuttles()
// TWO FAILURE CLASSES THAT HID IN PLAIN SIGHT FOR TWENTY MINUTES (seed 1151), so they get to be
// loud now. Both are silent by nature: nothing crashes, no unit gets stuck, the commander picks
// the right mission the whole time — the units just never accomplish anything, and only a metric
// that counts the non-event can see it.
// THE RECALL FIGHTS THE MISSION LAYER. `_driveHome` sets the destination directly, so a recall
// bypasses whatever mission is running — and when the abort branch below fires (an enemy is near
// and the recall is not forced) it re-arms on the very next tick. Two owners of one steering
// wheel, swapping about once a second. Seed 305: a firebrat covered 128u in 40 seconds and ended
// 0.8u from where it started, burning a whole tank, while its two destinations pointed opposite
// ways. Counted so we know whether that is one unlucky seed or a whole class.
let recallAbortsTotal = 0;    // recalls that armed and then gave up (the re-arm loop's fuel)
let recallVsFleeTotal = 0;    // ...of those, ones that interrupted a unit already driving home on Flee
const DRY_TRIP_ALARM = 3;     // trips to the enemy base without firing a shot, per commander, before it screams
const DRY_TRIP_R = 110;       // u — inside this of the enemy base counts as "it got there"
const SWAP_LOOP_ALARM = 8;    // CONSECUTIVE recalls answered by re-fielding the very type we recalled (a run, not a tally — see deploy)
let dryTripsTotal = 0;        // RR.decisionAlarms() — tournament summary
// FLAG RUNS. The tournament harness has printed "FLAG RUNS: 0 started · 0 STOPPED FOR FUEL" on
// every run for weeks, because it reads two keys off decisionAlarms() that were specified when the
// carrier-fuel alarm was written and never survived its revert. A line that always reads zero is
// worse than no line: it says the failure never happens, and the win condition is CAPTURE ONLY, so
// a flag run is the single most important thing in the game to be able to count.
let flagCarriesTotal = 0;     // flags picked up (a run STARTED)
let carrierRefuelsTotal = 0;  // …and the carrier broke off to go and refuel
// …AND HOW THE RUN ENDED. Counting starts and never endings is how "the FB got the flag and then
// just sat there" stayed invisible through weeks of tournaments: 366 runs started across 240 seeds
// said nothing at all about whether any of them converted. The win condition is CAPTURE ONLY, so
// these four numbers have to add up — a run either scores, or the runner dies, or it is still
// holding the flag when the clock stops, and the fourth is the interesting one.
let flagRunsScored = 0;       // …reached the base and won it
let flagRunsRunnerDied = 0;   // …carrier killed en route (a normal, honest way to lose a run)
// (…still carrying when the clock stopped is read live off the flags — see decisionAlarms.)
let flagRunStalls = 0;        // …held the flag CARRY_STALL_S with no ground gained toward home
const flagRunStallList = [];  // the autopsies, like the scuttle list: seed-level detail for the summary
// A run that makes no ground is the failure. Not "stopped" — a runner legitimately holds still to
// fight, to wait out a tower sweep, to let a shield recharge — but a runner that has not beaten its
// own best distance home in three quarters of a minute is not doing any of those things.
const CARRY_STALL_S = 45;     // seconds without closing on the delivery point
const CARRY_STALL_D = 10;     // …and "closing" means beating our own best by this much (u)
let swapLoopsTotal = 0;
const navAlarmsByTeam = {};                 // running per-team alarm tally (navAlarms is capped; this isn't) — RR.navAlarmsByTeam()
let aiNavScuttle = true;                    // RR.setNavScuttle(false) to keep pinned units alive
// WHAT WAS THIS UNIT DOING? Shared by the alarm and the scuttle records — both are autopsies,
// and both are useless as bare counts. The commander knows the behavior state; the SLOT knows
// the mission (each slot runs its own, so reading the commander-level card would credit the
// failure to whichever slot happened to be bound last).
function unitDoing(v) {
  const own = commanders.find(c => c.ownsUnit(v));
  const dbg = own ? own.dbgFor(v) : null;
  const slot = own ? own._slotFor(v) : null;
  const card = slot && slot.strategy ? slot.strategy : (own ? own.strategy : null);
  return {
    t: Math.round(own ? own._matchT || 0 : 0),
    arch: own ? own.archetype || null : null,
    mission: card ? card.step : null,
    state: dbg ? dbg.state : null,
    gd: dbg ? dbg.gd : null,       // how far off its goal it was
  };
}
const driverHooks = {
  navWaypoint,
  log: aiLog,
  alarm: (d, v) => {
    if (d && d.team) navAlarmsByTeam[d.team] = (navAlarmsByTeam[d.team] || 0) + 1;
    if (v) Object.assign(d, unitDoing(v));
    navAlarms.push(d); if (navAlarms.length > 40) navAlarms.shift();
    // trimmed copy for the live ai-lab console (full recordings stay in-memory via RR.navAlarms)
    try {
      localStorage.setItem('rmrf-nav-alarms',
        JSON.stringify(navAlarms.slice(-6).map(a => ({ ...a, rec: a.rec.slice(-50) }))));
    } catch (e) { /* storage full/blocked — the in-memory copy still has everything */ }
  },
  selfDestruct: (v, why) => {
    if (!aiNavScuttle || v.dead) return;
    // A SCUTTLE is its own failure class and deserves its own count: a unit the driver had to
    // destroy because it could not move, not a unit that died fighting. It was only ever a log
    // line, so the tournament could not report it — and the counter that DID appear in the summary
    // as "repeated-scuttle" was neither repeats nor scuttles (see failStreak).
    // Record WHAT IT WAS DOING, not just that it died. "7 scuttled" is a number you can't act
    // on; "7 scuttled, 5 of them lurchers stuck in `advance` on `defend`" names the defect. The
    // owning commander's live snapshot has the state and the goal it never reached.
    navScuttles.push({
      // t comes from the owning commander's clock (see unitDoing). This used to read
      // `v._cmdMatchT`, which nothing writes, so every scuttle in every report was stamped
      // t0s — a whole match's worth of them looked like they happened at kickoff.
      ...unitDoing(v),
      team: v.team, type: v.type, why: why || 'nav-alarm',
      px: Math.round(v.holder.position.x), pz: Math.round(v.holder.position.z),
    });
    navScuttlesByTeam[v.team] = (navScuttlesByTeam[v.team] || 0) + 1;
    damageVehicle(v, 1e6, 'other', null);
  },
};

// ── MULTI-UNIT SLOTS ─────────────────────────────────────────────────────────
// A commander fields one vehicle per SLOT; the slot count ("unit cap") is the number of
// elevators its team owns on the map (each lift supports one unit in the field), min 1 —
// so a designed/3v3 map with three lifts per side fields three simultaneous units.
// Everything about ONE fielded vehicle (its nav cache, elevator ride, gate exit, recall
// trip, detour latches, stuck tracking, report card, debug snapshot) lives in a slot
// record. The commander's per-unit methods were written against `this._nav`-style fields,
// so update() BINDS a slot (copies its record onto `this`), runs the existing logic
// unchanged, then UNBINDS (copies back). Team-level state — roster, scrap, doctrine,
// intel (seen types / known POIs / explore memory), kills, the gambit — stays plain on
// the commander and is shared by every slot. freshSlot() is the single source of truth
// for what is per-unit: add any new per-unit field HERE, not in the constructor, or it
// will bleed between units.
// PER-SLOT DOCTRINE — each slot fields its own mission card, so a 3-lift army splits into
// ROLES instead of blobbing on one shared objective (the 3v3 tournament's idle-at-goal
// tripled with a shared card). Slot 0 runs the commander's own archetype; extra slots draw
// from the persona's role deck below — every persona splits its army differently, so the
// commander identities survive multi-unit. (Cycled if the cap ever exceeds the deck.)
const ROLE_DECK = {
  warrior: ['hunter', 'turtle'],   // main fist + an interceptor hunting their units + a home guard
  turtle:  ['turtle', 'warrior'],  // two guards walking the corridor + one counter-puncher
  hunter:  ['warrior', 'turtle'],  // the hunt + siege pressure + a home guard
  rogue:   ['hunter', 'turtle'],   // the sneak + an interceptor + a home guard
};

// ── NN MISSION ASSIGNER — slice 1: the data pipeline ──────────────────────────────────
// The static ROLE_DECK above is the placeholder a LEARNED mission assigner replaces:
// instead of a fixed per-persona table, a policy looks at the battlefield each time a
// support slot redeploys and picks the role that tour should field. This slice only
// COLLECTS training tours — (feature snapshot at deploy, role fielded, the mission
// report card's outcome) — so a small net can be trained OFFLINE from headless matches;
function freshSlot() {
  return {
    unit: null, respawnT: 0,
    strategy: null,                                    // this slot's OWN doctrine card (set at slot creation)
    _role: null,                                       // the role name that card fields (deck default; a mission policy may re-pick per tour)
    _failStep: null, _failN: 0, _failT: 0, _failSnap: null,   // per-mission total-failure bans (per slot — each card banks its own lessons)
    _rising: false, _elev: null,                       // FOB-lift deploy state
    _nav: { path: null, idx: 0, t: 0, dx: null, dz: null, epoch: 0 },   // A* path cache (epoch: world state it was planned under)
    _supply: null, _supplyHeals: false, _home: null,   // resolved resupply/heal points (set per tick in _view)
    _mrec: null,                                       // mission report card for the unit in the field
    _flankPt: null, _flankDone: false, _flanking: false,   // runner "sneak round the side" approach
    _intercepting: false, _shielding: false, _shieldRun: false, _shieldGen: null, _shieldRunOn: false,
    _scrapDetour: false, _scrapDetourOn: false, _scrapTargetPile: null,
    _lootPile: null, _lootUntil: 0,                    // fresh-kill wreck grab
    _exploreWp: null,                                  // current recon waypoint (per unit → scouts spread out)
    _driver: null,                                     // this seat's Driver (orders in, pedals out — js/Driver.js)
    _tgtKey: null, _tgtT: 0, _tgtWhy: null,
    _tgtLock: null,                                    // the target we are COMMITTED to (see _tgtStillValid)                          // the target we are COMMITTED to, and how long we have held it
    _stand2: null,                                     // standoff v2 commitment — PER SLOT (left off the record once: two siege slots shared one commit and ping-ponged goals every tick — the DIRECT(suppress) pin class)
    _dbg: null, _lpx: null, _lpz: null, _stuckT: 0,    // log snapshot + movement-health tracking
    _netT: 0, _netX: null, _netZ: null, _netStuck: false, _wantT: 0,   // net-progress wedge watchdog
    _joltT: 0, _joltSide: 1, _joltN: 0,                // reverse-pivot unwedge
    _navBail: null, _bailWhy: null, _bailT: 0, _bailX: null, _bailZ: null, _bailV: null,   // nav ledger: why this slot got no order, for how long, and from where
    _lastFlip: null,                                   // log anti-bounce
    _patrolI: 0,                                       // position on the (shared) patrol route
    _patrolHoldT: 0,                                   // guard-the-shield dwell timer (gen patrol node)
    _harassTgt: null, _harassT0: 0, _harassHp0: 0,     // harass rotation: current stop + engagement budget
    _healHuntOn: false,                                // latch: announced the "kill the repair jeep" swap once
    _kills: 0,                                         // kills by THIS slot's units (cmd.kills is the team total)
  };
}
const SLOT_FIELDS = Object.keys(freshSlot());
let aiUnitCap = null;   // debug override (RR.setUnitCap): force the per-team unit cap regardless of elevators

// Forward pass for the trained mission net (1 hidden ReLU layer, tiny — weights are a
// ── L2 MISSION NET — the doctrine-level head (1v1's learned layer) ────────────────
// Where the L1 net assigns support-slot ROLES (useless in 1v1 — no support slots), L2
// picks the MISSION itself in place of the persona playbook's choose(): consulted by
// Doctrine.tick AFTER the urgent/universal rungs (flag emergencies, preservation, timers
// all stay hand-authored) and still subject to dwell + the report-card mission bans.
// Same 26 features, same tiny-MLP shape — only the output head differs (6 missions).
const L2_MISSIONS = ['attack', 'siege', 'capture', 'defend', 'scout', 'harass'];

// How erratic this commander's dealing is — a PERSONALITY trait (wanderlust: the same
// appetite that wanders the map wanders the deck; rogues add a twist), overridable for
// A/B via RR.setMissionTemp.

// Close out every OPEN tour (units alive when the match ends) into the training log —

class AICommander {
  constructor(team, archetype = null) {
    this.team = team;
    this.personality = randomPersonality(doctrineRng);
    this.archetype = archetype || pickArchetype(doctrineRng);   // named doctrine (Warrior/Turtle/...) — drives the whole plan
    // The doctrine shapes disposition: both archetypes FIGHT and finish a routed enemy
    // (pursue needs aggression > 0.6). A Warrior presses hardest; a Turtle is still
    // willing to chase a repelled attacker — it just holds a defensive post to do it.
    const aggMin = this.archetype === 'warrior' ? 0.75 : this.archetype === 'turtle' ? 0.66 : 0;
    if (this.personality.aggression < aggMin) this.personality.aggression = aggMin;
    this.colorIndex = null;
    this.started = false;
    this._matchT = 0;          // seconds this commander has been fighting (drives the stalemate gambit)
    this._gambit = false;      // latched: gave up on the mid-field grind → send a Valkyrie around to crack the HQ
    this.deaths = 0;
    this.kills = 0;                                   // enemy vehicles this commander's units have downed
    this.homeKills = 0;                               // ...of which, killed on OUR half (guard/intercept work)
    this.carrierKills = 0;                            // ...of which, flag carriers (downing the thief)
    this.mineKills = 0;                               // enemy kills by our mines (credited into kills too)
    this.flagsLost = 0;                               // times OUR flag was lifted (scorecard: lost on watch)
    // HISTORY state (gives the memoryless net motion + memory). Fresh each match.
    this._histBuf = [];                               // rolling {t,fortFrac,tilt} samples for the derivatives
    this._histT = 0;                                  // next sample time (_matchT)
    this._recentTours = [];                           // last few support-tour outcomes {died,progress}
    this._lastFlagLostT = -1e9;                       // _matchT when our flag was last lifted
    this.strategy = makeDoctrine(this.archetype, this.personality, Math.random, null, m => aiLog(this.team, `${this.cname}: ${m}`));   // the archetype's mission doctrine
    this.fortHp0 = null;                              // enemy fort HP when this card started
    this.seenTypes = {};                              // rival vehicle types this team has spotted
    this.knownSupplies = new Set();                   // fog-of-war: resupply POIs this team has SCOUTED
    this.knownScrap = new Set();                       // fog-of-war: salvage piles this team has SPOTTED
    this._scrapNoReach = new Map();                     // pile → expiry(ms): salvage A* couldn't route to (walled-off spit) — don't re-commit
    this._scrapTargetPile = null;                       // the pile the current salvage detour is committed to (for the unreachable-bail check)
    this.knownElev = false;                           // scouted the enemy FOB/elevator yet?
    this.knownFlag = false;                           // scouted the enemy flag HQ yet?
    // FOG-OF-WAR for enemy TOWERS. A unit rises into an unknown world: it knows a flag exists and
    // that a rival is out there, nothing more. Towers are DISCOVERED by being seen, and once seen
    // the team keeps the intel (it lives here, not on the unit, so it survives the unit dying).
    // Everything else already worked this way (knownSupplies/knownScrap/knownElev/knownFlag);
    // tower TARGETING was the one thing still re-perceiving the world every tick by raw distance,
    // which is what made a sieger's target — and therefore its goal — flip as it drove.
    // Map: wall -> { camp, wall, x, z, seenT, armed } as of the last time we actually LOOKED.
    this.knownTowers = new Map();
    // The standing siege plan (kill order + firing spots), drawn up ONCE per siege from the intel
    // above. Commander-level on purpose: every sieging slot works the same list, so they focus
    // fire instead of each picking whatever tower is nearest to itself. See _buildSiegePlan.
    this._siegePlan = null;
    this._knownSig = '';                              // last logged known-POI signature (log only on change)
    this.explore = new ExploreMemory(map.worldW, map.worldH, 30, (x, z) => map.isLand(x, z));   // coarse "where have we looked" grid (land-only)
    this._exploreWp = null;                           // current recon waypoint (held until reached)
    this.roster = { ...GARAGE_COUNTS };               // finite fleet, same numbers as the player's garage; a death removes one
    this._eliminated = false;                         // true once the roster is empty (no more vehicles to field)
    this.failStreak = 0;                              // consecutive unit losses on the current plan (drives adaptive redraws)
    // Per-unit state lives in slot records (see freshSlot); mirror slot 0 onto `this`
    // so pre-start external reads (debug hooks) see sane defaults.
    this._slots = [freshSlot()];
    this._slots[0].strategy = this.strategy;          // slot 0 fields the archetype's own doctrine
    this._slots[0]._role = this.archetype;
    Object.assign(this, this._slots[0]);
    this._slotI = 0; this._lead = true;
  }

  // The doctrine a given slot fields: slot 0 = the archetype itself, extras from its
  // ROLE_DECK (see above). Legacy no-archetype commanders draw random cards as ever.
  _slotRole(i) {
    const deck = ROLE_DECK[this.archetype] || [];
    return i === 0 || !deck.length ? this.archetype : deck[(i - 1) % deck.length];
  }
  _makeCard(role) { return makeDoctrine(role, this.personality, Math.random, null, m => aiLog(this.team, `${this.cname}: ${m}`)); }
  _slotDoctrine(i) { return this._makeCard(this._slotRole(i)); }

  // ── slot plumbing (multi-unit) ─────────────────────────────────────────
  // The team's unit cap: one fielded vehicle per elevator it owns (min 1), or the
  // RR.setUnitCap debug override. Losing an elevator (future maps) shrinks the army.
  unitCap() {
    if (aiUnitCap != null) return aiUnitCap;
    let n = 0; for (const e of elevators) if (e.team === this.team) n++;
    return Math.max(1, n);
  }
  _bind(i) { const s = this._slots[i]; for (const k of SLOT_FIELDS) this[k] = s[k]; this._slotI = i; this._lead = i === 0; }
  _unbind(i) { const s = this._slots[i]; for (const k of SLOT_FIELDS) s[k] = this[k]; }
  // Grow to the cap (staggered respawn timers so fresh slots don't fight over a lift);
  // shrink by dropping EMPTY slots only — a live overflow unit keeps fighting and its
  // slot retires when it dies (see the respawn gate in _updateSlot).
  _syncSlots() {
    const cap = this.unitCap();
    while (this._slots.length < cap) {
      const s = freshSlot();
      s.respawnT = 2 + this._slots.length * 2.5;
      s.strategy = this._slotDoctrine(this._slots.length);   // its own role card (see ROLE_DECK)
      s._role = this._slotRole(this._slots.length);
      this._slots.push(s);
    }
    if (this._slots.length > cap)
      for (let i = this._slots.length - 1; i >= 0 && this._slots.length > cap; i--)
        if (!this._slots[i].unit || this._slots[i].unit.dead) this._slots.splice(i, 1);
  }
  // Does any of this commander's slots own vehicle v? (External code — kill credit,
  // repair caps — used to test `c.unit === v`, which only saw the last-bound slot.)
  ownsUnit(v) { return this._slots.some(s => s.unit === v) || this.unit === v; }
  _slotFor(v) { return this._slots.find(s => s.unit === v) || null; }
  dbgFor(v) { const s = this._slotFor(v); return s ? s._dbg : (this.unit === v ? this._dbg : null); }   // per-unit log snapshot (tourney/probe attribution)
  liveUnits() { const out = []; for (const s of this._slots) if (s.unit && !s.unit.dead) out.push(s.unit); return out; }

  start(colorIndex) {
    if (this.started) return;
    this.started = true;
    this.colorIndex = colorIndex;
    const accent = TEAM_COLORS[colorIndex].hex;
    for (const c of camps) if (c.team === this.team) c.setAccent(accent);
    recolorFlag(this.team, accent);
    recolorPlaced(this.team, accent);   // designed-map props + standalone forts follow the locked colour
    if (soldiers) soldiers.retintTeam(this.team, accent);   // base infantry fatigues follow the locked colour
    for (const e of elevators) if (e.team === this.team) e.setAccent(accent);   // ALL the team's lifts (satellite pads too)
    this.fortHp0 = fortHpOf(this.targetTeam()) || 1;
    this._bind(0); this.deploy(); this._unbind(0);   // slot 0 rolls out first; extra slots stagger in via update()
  }

  // --- intel the strategy cards read (all fog-of-war honest) -------------
  homePos() { return teamCenter(this.team, 'fob'); }
  targetTeam() {
    const home = teamCenter(this.team, 'fob'); let best = Infinity, t = null;
    for (const c of camps) {
      if (c.role !== 'main' || c.team === this.team) continue;
      const d = (c.center.x - home.x) ** 2 + (c.center.z - home.z) ** 2;
      if (d < best) { best = d; t = c.team; }
    }
    return t;
  }
  enemyBasePos() { return teamCenter(this.targetTeam(), 'main'); }
  enemyFobPos() { return teamCenter(this.targetTeam(), 'fob'); }   // where the enemy's units rise — the Warrior hunts here
  // A REACHABLE hold point outside the enemy's forward base — the fob CENTRE sits inside the
  // enemy wall ring (and its gate is shut to us), so a ground unit's A* finds NO route there;
  // aiming ATTACK at the centre made a wide-turning Lurcher orbit the wall ring forever (the
  // "spinning at the staging point" bug). Pull the target back onto our approach side, just
  // outside the ring, then snap it to reachable ground. Flyers hunt the centre directly.
  enemyStagingHold() {
    const fob = this.enemyFobPos();
    if (!this.unit || this.unit._move.ignoreWalls) return fob;
    const from = this.homePos();
    let dx = fob.x - from.x, dz = fob.z - from.z; const d = Math.hypot(dx, dz) || 1; dx /= d; dz /= d;
    const standoff = FOB_SIZE * grid.cell * 0.6;   // ~15u — clears the wall ring on the near side
    const hx = fob.x - dx * standoff, hz = fob.z - dz * standoff;
    const c = grid.cell;
    const oc = nearestOpenCell(this.unit, Math.round(hx / c), Math.round(hz / c), 5);
    return oc ? { x: oc.i * c, z: oc.j * c } : { x: hx, z: hz };
  }
  homeBasePos() { return teamCenter(this.team, 'main'); }           // our own flag base
  // Comma-list of the points this team has SCOUTED (for the known-POI log readout):
  // discovered supply depots by kind + the enemy elevator/flag once seen.
  _knownSummary() {
    const kinds = new Set();
    for (const rp of this.knownSupplies) if (!rp.dead) kinds.add(rp.kind);
    const parts = [];
    if (kinds.has('ammo')) parts.push('AMO');
    if (kinds.has('fuel')) parts.push('FUL');
    if (kinds.has('shield')) parts.push('SHD');
    if (this.knownFlag) parts.push('FLG');     // enemy flag HQ
    if (this.knownElev) parts.push('ELV');     // enemy elevator/FOB
    return parts.length ? parts.join(' ') : 'none';
  }
  // "Sneak round the side" waypoint for a flag RUNNER. Take the perpendicular bisector of the line
  // between the two flag bases and walk out along it to the last LAND cell before open water — the
  // SIDE BEACH. Coming at the enemy flag via this point swings the runner WIDE around the defended
  // middle/road (and the enemy FOB) instead of driving straight up it into the guns. Picks the side
  // the runner is already on (shorter swing) and caches it for the approach (cleared on deploy).
  _flankPoint(v) {
    if (this._flankPt) return this._flankPt;
    const home = this.homeBasePos(), enemy = this.enemyBasePos();
    const mx = (home.x + enemy.x) / 2, mz = (home.z + enemy.z) / 2;
    let dx = enemy.x - home.x, dz = enemy.z - home.z; const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
    let px = -dz, pz = dx;   // unit vector perpendicular to the base-to-base line
    if ((v.holder.position.x - mx) * px + (v.holder.position.z - mz) * pz < 0) { px = -px; pz = -pz; }   // the side we're already on
    let best = { x: mx + px * 20, z: mz + pz * 20 };
    // March out to the beach — but no further than ~55% of the base separation. The flank only
    // needs to clear the defended middle; "last land" along a diagonal could be a far MAP CORNER,
    // and runners drove hundreds of units out to park next to one (richwatch: 77s stagnant).
    const maxD = Math.min(340, L * 0.55);
    for (let d = 20; d <= maxD; d += 6) {
      const x = mx + px * d, z = mz + pz * d;
      if (!map.isLand(x, z)) break;
      best = { x, z };
    }
    // Snap to a cell the runner can actually OCCUPY — the raw beach lip can be an unenterable
    // sliver against water/rocks, leaving the unit circling 20u out with the arrival check
    // (which needs it INSIDE the radius) never tripping.
    const c = grid.cell;
    const oc = nearestOpenCell(v, Math.round(best.x / c), Math.round(best.z / c), 6);
    if (oc) best = { x: oc.i * c, z: oc.j * c };
    this._flankPt = best;
    return best;
  }
  // Have we ever laid eyes on an enemy vehicle? (drives Hunter scout → attack)
  // "Found them" = seen an enemy VEHICLE or scouted their base (FOB/HQ). The base check matters:
  // a scout that reaches the enemy FOB but never happens to spot a unit used to count as still-
  // searching, so a Hunter sat in 'scout' forever with its Valkyrie parked at the enemy elevator.
  knowsEnemy() { return Object.keys(this.seenTypes).length > 0 || this.knownElev || this.knownFlag; }
  // The towers this team can actually PLAN against: ones we've seen, that still had a gun the last
  // time we looked. A destroyed tower stays remembered (we know the rubble is there) but is not a
  // threat and not a target — it only re-enters the plan when a crew mounts a new gun and we
  // re-observe it. Intel is as of last sighting, never live-polled: that is what keeps a siege
  // target stable instead of re-electing itself every tick.
  plannableTowers() {
    const out = [];
    for (const k of this.knownTowers.values()) if (k.armed) out.push(k);
    return out;
  }
  // The enemy's last-known position, if seen recently (else null → fall back to the
  // elevator). Lets the Attack mission "recall the last known location" (ai_behavior).
  lastEnemyPos() {
    const s = this._lastEnemyPos;
    return s && (performance.now() - s.t) < 12000 ? { x: s.x, z: s.z } : null;
  }
  // THE OPPONENT, as a unit. Returned only while it is ALIVE, so a duel can never be opened
  // against a wreck; once a mission has snapshotted it, the mission holds its own reference and
  // watches `.dead` itself. Read for IDENTITY and for that one flag — never for its position,
  // which would be seeing through the fog. Where it is comes from lastEnemySeen() below.
  lastEnemyVeh() { const u = this._lastEnemyVeh; return u && !u.dead ? u : null; }
  // Where we last actually SAW a vehicle (as opposed to heard one, or got shot from somewhere).
  // No staleness window: the caller knows which unit this belongs to and decides what an old fix
  // is worth — a frozen last-known position is exactly what "they got away" is measured against.
  lastEnemySeen() { const s = this._lastEnemySeen; return s ? { x: s.x, z: s.z, t: s.t } : null; }
  // "Our towers are being SHOT" — stamped by updateProjectileHits when an enemy round hits
  // one of our structures near home. Unlike hearing this has no range limit (the tower
  // radios for help), so a defender out on the mid-field lane responds immediately
  // (ai_behavior Defend: ambush the attacker as it engages our towers).
  homeAttack() {
    const s = this._homeAttack;
    return s && (performance.now() - s.t) < 15000 ? { x: s.x, z: s.z } : null;
  }
  // Report card verdict: this mission key lost two units in a row with ZERO progress —
  // the doctrine should run its FAIL_ALT unblocker instead. Time-boxed: after 90s the
  // field has usually changed enough that the plan deserves another look.
  missionBanned(key) {
    if (this._failStep !== key || this._failN < 2) return false;
    if (performance.now() - this._failT > 240000) return false;   // hard cap: if the FIXER is failing too, let the doctrine reconsider
    // BENCH-UNTIL-FIXED (Jacob's model: "send a stronger unit to deal with the problem and
    // don't worry how long it takes, as long as there's progress"): the ban lifts the moment
    // the unblocker has genuinely broken something — a tower down, real base damage, or a
    // kill — NOT on a timer. The old 90s window was shorter than a jotun's round trip, so
    // capture resumed before the tower fell and the next runner died to the same gun.
    const s = this._failSnap;
    if (s && (this.turretsLive() < s.twr || fortHpOf(this.targetTeam()) < s.fort - 120 || this.kills > s.k)) return false;
    return true;
  }
  // Is the target team out of the fight for good — no live unit AND its commander is
  // eliminated? (A human team has no commander and can always redeploy, so never "out".)
  // Lets a mission like the Hunter's hunt END instead of firing at an empty elevator.
  enemyEliminated() {
    const tt = this.targetTeam();
    for (const o of combatants) if (!o.dead && o.team === tt) return false;
    const ec = commanders.find(c => c.team === tt);
    return !!(ec && ec._eliminated);
  }
  // Am I losing the war of attrition — few units left AND clearly behind the enemy? A
  // commander that keeps feeding its last units out into the open just trades its army
  // away 1-for-1 (the mutual-annihilation the audit found). When behind, pull back to
  // DEFEND under tower cover and let the winning side overextend into our guns, preserving
  // what's left for a counter-punch. (A human enemy has no roster, so we never read them
  // as "ahead" and never turtle against a human on this basis.)
  // The enemy fleet is decisively beaten down vs ours — the turtle's licence to leave the
  // wall and press (same read losingBadly makes from the other side).
  enemyWeaker() {
    const ec = commanders.find(c => c.team === this.targetTeam());
    return !ec || ec.fleetLeft() <= this.fleetLeft() - 2;
  }
  losingBadly() {
    const ec = commanders.find(c => c.team === this.targetTeam());
    if (!ec) return false;
    const mine = this.fleetLeft(), theirs = ec.fleetLeft();
    return mine <= 5 && mine <= theirs - 3;
  }
  // How many units we're DOWN in the attrition war (0 if even or ahead) — MissionScore's
  // gradual 'losing' term scales with this instead of stepping at losingBadly's threshold.
  fleetDeficit() {
    const ec = commanders.find(c => c.team === this.targetTeam());
    return ec ? Math.max(0, ec.fleetLeft() - this.fleetLeft()) : 0;
  }
  // Battlefield snapshot for the mission assigner, from THIS commander's view (own state
  // + the same reads the doctrines already make — nothing new is revealed). Normalized
  // HISTORY sampling — one light sample every ~4s so the mission features can carry
  // Record a finished SUPPORT tour's outcome so the next deploy can react to how the last went.
  _noteTour(r) {
    if (!r || r.slot === 0) return;                                    // slot 0 = persona, not a learned pick
    const progress = r.flag ? 1 : (r.fortDmg > 60 ? 1 : (r.kills > 0 ? 0.6 : 0));
    this._recentTours.push({ died: r.died ? 1 : 0, progress });
    if (this._recentTours.length > 4) this._recentTours.shift();       // remember the last 4
  }
  // One finished tour → one graded record for the report card. NOTE kills/fortDmg are the
  // COMMANDER'S deltas
  // over the tour window (kills are credited at team level), so with multiple slots the
  // credit is noisy — the trainer sees it in expectation. Refine attribution later if the
  // signal proves too dilute.
  _tourRecord(rec, died, slotI) {
    return { team: this.team, arch: this.archetype, slot: slotI, veh: rec.veh, role: rec.role,
      kills: this.kills - rec.kills0, fortDmg: Math.max(0, Math.round(rec.fort0 - fortHpOf(this.targetTeam()))),
      flag: rec.flagTouched ? 1 : 0, died, dur: Math.round((performance.now() - rec.t0) / 1000) };
  }
  // STALEMATE GAMBIT: the match has dragged on and we've made ZERO progress on the enemy base
  // (their towers still nearly all up) — we're just trading + healing in mid-field. Give up on
  // the grind and send a Valkyrie the ROGUE way: flank AROUND the field fight to the rear of the
  // base and rocket the HQ down while the enemy's tied up out front. Latched once tripped. Needs a
  // Valkyrie available; skips once we're already winning (flag exposed / enemy wiped → normal siege).
  gambitOn() {
    if (this._gambit) return true;
    // ANY valkyrie arms it — not _pickAvailableType, whose save-the-last rule substitutes a
    // lurcher whenever only ONE valkyrie remains, holding this escape hatch shut in exactly
    // the endgame it exists for (seed 221: a full fleet + 14 scrap camped a stale contact for
    // 40 minutes, gambit locked). A stalemate is THE moment to spend the last flyer.
    if (this._matchT > GAMBIT_AFTER && this.turretsLive() >= 3 && !this.flagExposed()
        && !this.enemyEliminated() && (this.roster.valkyrie || 0) > 0) {
      this._gambit = true;
      aiLog(this.team, `${this.cname}: This slugfest's going nowhere — Valkyrie, swing around the back and crack their HQ! Don't stop to fight.`);
    }
    return this._gambit;
  }
  // A holding spot to the SIDE of our flag base — on the enemy-facing edge but offset
  // off the approach lane, inside tower cover. The Turtle ambushes from here and flanks
  // an attacker, instead of huddling on the flag HQ (which is what looked too passive).
  ambushSpot() {
    const base = this.homeBasePos(), enemy = this.enemyBasePos();
    let dx = enemy.x - base.x, dz = enemy.z - base.z;
    const d = Math.hypot(dx, dz) || 1; dx /= d; dz /= d;            // unit vector toward the threat
    const px = -dz, pz = dx;                                        // perpendicular = "to the side"
    const side = this.team === 'red' ? 1 : -1;                      // each team commits to one flank
    const FWD = 18, SIDE = 26;                                      // forward a touch, well to the side, still in tower range
    return { x: base.x + dx * FWD + px * SIDE * side, z: base.z + dz * FWD + pz * SIDE * side };
  }
  // Sapper geometry (mine placement): a FLANK approach line just outside our own base, off the
  // lane our own units travel — where an attacker swings wide to angle on our towers. The sapper
  // drives to the FAR point, then lays on the way BACK toward `ret` (so it never re-crosses a mine
  // it just dropped — Jacob's rule). `podW` = a forward spot on the lane that watches the approach.
  _sapGeo() {
    if (this._sapGeoC) return this._sapGeoC;
    const base = this.homeBasePos(), enemy = this.enemyBasePos();
    let dx = enemy.x - base.x, dz = enemy.z - base.z; const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
    // Flank side is rolled per-match (Doctrine.tick sets _sapSide off the seeded rng), so a
    // team saps its LEFT or RIGHT flank at random across games instead of always the same one.
    const px = -dz, pz = dx, side = this._sapSide != null ? this._sapSide : (this.team === 'red' ? 1 : -1);
    // Snap onto LAND (LAND_SNAP is a sinker), not merely "open for a Firebrat" — a Firebrat
    // crosses water, so the old nearestOpenCell(this.unit,…) happily left a flank point out in
    // the ocean and the sortie idled there. Wider ring (8) so a point that lands offshore pulls
    // back to the nearest reachable shore.
    LAND_SNAP.team = this.team;
    const snap = (x, z) => { const c = grid.cell;
      const oc = this.unit ? nearestOpenCell(LAND_SNAP, Math.round(x / c), Math.round(z / c), 8) : null;
      if (oc) return { x: oc.i * c, z: oc.j * c };
      // No land within reach (the flank point is well out in the ocean on a small island) —
      // slide it back toward `base`, which is always ground, until it hits land. Guarantees a
      // land point on the flank line so the sortie never drives out over open water.
      for (let t = 0.2; t <= 1.0001; t += 0.2) {
        const ix = x + (base.x - x) * t, iz = z + (base.z - z) * t;
        if (map.isLand(ix, iz)) return { x: ix, z: iz };
      }
      return { x: base.x, z: base.z }; };
    let g;
    if (this._trapMode) {
      // TRAP (Hunter): a tight cluster ON the lane at ~35% out — a kill-zone the enemy crosses.
      // Approach from just past it and lay on the way back so both land at the spot; our own units
      // route around it (path detour). Remember the centroid for the trap behaviour.
      const spot = { x: base.x + dx * L * 0.35, z: base.z + dz * L * 0.35 };
      g = { far: snap(spot.x + dx * 8, spot.z + dz * 8), ret: snap(spot.x - dx * 8, spot.z - dz * 8),
            podW: snap(spot.x - dx * 22, spot.z - dz * 22) };
      this._trap = snap(spot.x, spot.z);
    } else {
      // Mode A (defensive): a flank approach just outside our base, off our own lane.
      const FWD = 18;
      g = { far: snap(base.x + dx * FWD + px * side * 46, base.z + dz * FWD + pz * side * 46),
            ret: snap(base.x + dx * FWD + px * side * 10, base.z + dz * FWD + pz * side * 10),
            podW: snap(base.x + dx * 34, base.z + dz * 34) };
    }
    if (this.unit) this._sapGeoC = g;   // base geometry is constant for the match; cache once we can snap
    return g;
  }
  // Where the opening sapper should drive right now, by its route phase (out → back → pod → home).
  sapTarget(v) {
    const g = this._sapGeo();
    if (v._sapPhase === 'back') return g.ret;
    if (v._sapPhase === 'pod') return g.podW;
    if (v._sapPhase === 'done') return this.homePos();
    return g.far;   // 'out' (default): head to the deep flank / just past the trap first
  }
  // ── Hunter trap (Mode B) — the Lurcher tends a mine kill-zone (cmd._trap) ──
  // Ambush anchor: just home-side of the trap, where the bait Lurcher waits.
  // MIDFIELD IS THE FALLBACK, NOT HOME. Both of these used to answer "we have no trap" with
  // homePos(), so a hunter that reached the trap mission before the sap had laid its mines set its
  // ambush inside its own FOB — and then, since a signal shot is aimed 30u toward the enemy base
  // from wherever the unit stands, it spent the signal phase shooting its own gate. An ambush with
  // no mines is still an ambush: stand where the lanes cross and wait. Measured on HEAD: 234 of
  // 234 signal-phase ticks were fired from inside the unit's own base.
  trapMidfield() {
    const h = this.homeBasePos(), e = this.enemyBasePos();
    return { x: (h.x + e.x) / 2, z: (h.z + e.z) / 2 };
  }
  trapAnchor() {
    const t = this._trap; if (!t) return this.trapMidfield();
    const home = this.homeBasePos();
    let dx = home.x - t.x, dz = home.z - t.z; const d = Math.hypot(dx, dz) || 1; dx /= d; dz /= d;
    return { x: t.x + dx * 15, z: t.z + dz * 15 };
  }
  // Fall-back spot that puts the trap BETWEEN us and the enemy — a chaser must cross the mines.
  // If the STRAIGHT line from our bait to that spot would cut through the mine cluster itself
  // (enemy came in on our side, so "opposite them" is across the kill-zone), detour via a flank
  // waypoint on our own side — the bait circles AROUND its mines, never over them.
  trapShield() {
    const t = this._trap; if (!t) return this.trapMidfield();
    const e = this.lastEnemyPos() || this.enemyBasePos();
    let dx = t.x - e.x, dz = t.z - e.z; const d = Math.hypot(dx, dz) || 1; dx /= d; dz /= d;
    const spot = { x: t.x + dx * 16, z: t.z + dz * 16 };
    const u = this.unit && this.unit.holder.position;
    if (u) {
      // Distance from the trap centroid to the segment unit→spot; under ~11u means the drive
      // would roll the cluster (mines land within a few units of the centroid, +3.2u trigger).
      const sx = spot.x - u.x, sz = spot.z - u.z, L2 = sx * sx + sz * sz || 1;
      const k = Math.max(0, Math.min(1, ((t.x - u.x) * sx + (t.z - u.z) * sz) / L2));
      const cx = u.x + sx * k - t.x, cz = u.z + sz * k - t.z;
      if (cx * cx + cz * cz < 11 * 11) {
        // Flank waypoint: perpendicular to the enemy axis, on OUR side of the cluster.
        const px = -dz, pz = dx;
        const side = ((u.x - t.x) * px + (u.z - t.z) * pz) >= 0 ? 1 : -1;
        return { x: t.x + px * side * 16, z: t.z + pz * side * 16 };
      }
    }
    return spot;
  }
  // Trap spent = no live team mine remains near the kill-zone (blew or got cleared) → resume play.
  trapSpent() {
    const t = this._trap; if (!t) return true;
    for (const m of minefield.items)
      if (m.team === this.team && (m.group.position.x - t.x) ** 2 + (m.group.position.z - t.z) ** 2 < 30 * 30) return false;
    return true;
  }
  // A patrol that holds the APPROACH LANE — from the home front (between the flag HQ and
  // the elevator, on the enemy-facing side) out to MID-FIELD — so a defender meets an
  // incoming attack before it picks a target, instead of pacing flag↔elevator in the rear
  // (where sitting at one base left the other undefended). The two mid-field waypoints are
  // offset to opposite flanks so the sweep covers the lane's width, and the route returns
  // through the home front between them so it never strays far from tower cover for long.
  // The brain still drops into engage on sight — this only fills the idle time; a heard
  // shot or a hit on our towers pre-empts the whole patrol (see Defend.objective).
  patrolSpot() {
    const flag = this.homeBasePos(), fob = this.homePos(), enemy = this.enemyBasePos();
    // GUARD THE SHIELD (turtle v2): the nearest KNOWN shield generator on OUR half joins
    // the patrol — armour decides lurcher duels, so the guard re-tops its own shield and
    // DENIES the enemy's re-armour by standing on the spawner. The route rebuilds if the
    // qualifying gen changes (they get scouted mid-match). Guarding never outranks a real
    // threat: Defend.objective checks homeAttack + our-half contacts BEFORE the patrol.
    let genPt = null;
    if (turtleGuardOn) {
      const fr = { x: (flag.x + fob.x) / 2, z: (flag.z + fob.z) / 2 };
      const gen = this.nearestKnownShield(fr.x, fr.z);
      if (gen) {
        const dh = (gen.pos.x - fr.x) ** 2 + (gen.pos.z - fr.z) ** 2;
        const de = (gen.pos.x - enemy.x) ** 2 + (gen.pos.z - enemy.z) ** 2;
        if (dh < de) genPt = { x: gen.pos.x, z: gen.pos.z, gen: true };   // ours-half only — never lured deep
      }
    }
    const genKey = genPt ? ((genPt.x | 0) + ',' + (genPt.z | 0)) : '';
    if (!this._patrol || this._patrolGenKey !== genKey) {
      const front = { x: (flag.x + fob.x) / 2, z: (flag.z + fob.z) / 2 };
      let tx = enemy.x - front.x, tz = enemy.z - front.z;
      const td = Math.hypot(tx, tz) || 1; tx /= td; tz /= td;       // unit vector toward the threat
      const px = -tz, pz = tx;                                      // perpendicular — the lane's width
      const mid = { x: (front.x + enemy.x) / 2, z: (front.z + enemy.z) / 2 };   // mid-field
      const home = { x: front.x + tx * 14, z: front.z + tz * 14 };  // home front, still in tower reach
      const SIDE = 30;
      this._patrol = [
        home,
        ...(genPt ? [genPt] : []),                                  // hold the shield spawner (dwell below)
        { x: mid.x + px * SIDE, z: mid.z + pz * SIDE },             // mid-field, one flank
        home,
        { x: mid.x - px * SIDE, z: mid.z - pz * SIDE },             // mid-field, other flank
      ];
      this._patrolGenKey = genKey;
      this._patrolI = 0;
    }
    const wp = this._patrol[this._patrolI % this._patrol.length];
    if (this.unit) {
      const u = this.unit.holder.position;
      if (Math.hypot(u.x - wp.x, u.z - wp.z) < 12) {
        // DWELL on the generator node — long enough to top up and deny a pass, short
        // enough that the lane still gets walked (a guard camping the gen forever is
        // exploitable: siege the far side of the base and the response comes late).
        if (wp.gen) {
          if (!this._patrolHoldT) { this._patrolHoldT = performance.now(); aiLog(this.team, `${this.cname} ${this.unit.type}: “Holding the shield generator — nobody re-arms on our watch.”`); }
          if (performance.now() - this._patrolHoldT < GUARD_GEN_DWELL) return wp;
        }
        this._patrolHoldT = 0;
        this._patrolI = (this._patrolI + 1) % this._patrol.length;
      }
    }
    return this._patrol[this._patrolI % this._patrol.length];
  }
  // HARASS rotation (hunter): pick a stop from the enemy-half menu, spend a short
  // engagement budget on it, then rotate to the FARTHEST other stop (spread the alarms).
  harassSpot() {
    const now = performance.now();
    const u = this.unit ? this.unit.holder.position : null;
    const t = this._harassTgt;
    if (t && u) {
      const d = Math.hypot(u.x - t.x, u.z - t.z);
      if (d < 32 && !this._harassT0) { this._harassT0 = now; this._harassHp0 = this.unit.hp; }   // on station — start the clock
      const overstay = this._harassT0 && now - this._harassT0 > 9000;
      const mauled = this._harassT0 && this.unit.hp < this._harassHp0 - this.unit.maxHp * 0.2;   // they answered — fade
      const done = (t.gen && t.gen.dead) || (t.wall && (!t.wall.turret || t.wall.turret.dead));
      if (overstay || mauled || done) this._harassTgt = null;
    }
    if (!this._harassTgt) {
      const menu = this._harassMenu();
      if (!menu.length) return this.enemyFobPos();     // nothing scouted yet — lean on their fob
      const from = u || this.homePos();
      let best = menu[0], bd = -1;
      for (const m of menu) { const d = (m.x - from.x) ** 2 + (m.z - from.z) ** 2; if (d > bd) { bd = d; best = m; } }
      this._harassTgt = best; this._harassT0 = 0; this._harassHp0 = 0;
      const say = best.gen ? 'Taking out their shield generator — no more armour for them!'
        : best.wall ? 'Sniping that tower — make ’em flinch, then gone.'
        : 'Lifting their salvage — bleed the economy.';
      if (this.unit) aiLog(this.team, `${this.cname} ${this.unit.type}: “${say}”`);
    }
    return this._harassTgt;
  }
  // The menu: enemy-half shield generator (destroy it — their lurchers fight unshielded
  // after), a live corner tower to snipe, their salvage to steal. Known intel only.
  _harassMenu() {
    const menu = [];
    const home = this.homeBasePos(), tt = this.targetTeam();
    const theirHalf = (x, z) => {
      const en = this.enemyBasePos();
      return (x - en.x) ** 2 + (z - en.z) ** 2 < (x - home.x) ** 2 + (z - home.z) ** 2;
    };
    for (const rp of this.knownSupplies) {
      if (rp.dead || rp.kind !== 'shield') continue;
      if (theirHalf(rp.pos.x, rp.pos.z)) menu.push({ x: rp.pos.x, z: rp.pos.z, kind: 'their shield generator', gen: rp });
    }
    let towers = 0;
    for (const c of camps) {
      if (c.team !== tt || c.role !== 'main') continue;
      for (const w of (c.walls || [])) {
        if (towers >= 2 || !w.turret || w.turret.dead || !w.body || w.body.dead) continue;
        menu.push({ x: w.group.position.x, z: w.group.position.z, kind: 'sniping a tower', wall: w });
        towers++;
      }
    }
    let piles = 0;
    for (const p of this.knownScrap) {
      if (piles >= 2 || p._gone || p.overWater) continue;
      if (theirHalf(p.pos.x, p.pos.z)) { menu.push({ x: p.pos.x, z: p.pos.z, kind: 'stealing their salvage' }); piles++; }
    }
    return menu;
  }
  flag() { return enemyFlagOf(this.team); }
  // Our OWN flag (the one a rival steals). ourFlagStolen → a live enemy is carrying it.
  ourFlag() { return flags.find(f => f.team === this.team) || null; }
  ourFlagStolen() { const f = this.ourFlag(); return !!(f && f.carried && f.carrier && !f.carrier.dead && f.carrier.team !== this.team); }
  // Our flag is LOOSE: the thief dropped it (killed mid-run) and it's lying in the field —
  // any teammate touching it snaps it home (updateFlags), and until then the enemy's next
  // runner can re-grab it far from our guns. 8u > the 6u GRAB radius, so a recovered/at-home
  // flag never reads as loose.
  ourFlagLoose() {
    const f = this.ourFlag();
    return !!(f && f.revealed && !f.carried
      && Math.hypot(f.group.position.x - f.home.x, f.group.position.z - f.home.z) > 8);
  }
  // Our flag base has lost all its turrets → a defender can't lean on tower cover and
  // should switch to a Valkyrie's mobility (ai_behavior Defend).
  ownTowersDown() { return turretCountOf(this.team) === 0; }
  // DEFEND intercept point (ai_behavior): chase the carrier directly; thief down and the
  // flag lying loose → drive to the FLAG (touching it snaps it home); if it's somehow
  // out of play fall back to the enemy's elevator — where they must take it to score.
  // WHERE TO WAIT FOR A FLAG RUNNER. Nothing on the field outruns a Firebrat, so a chase the
  // carrier has already started is a chase we lose — and this used to return the carrier's LIVE
  // position, which is a goal that relocates every tick. Seed 158: an interceptor drove 100.3u
  // over ten seconds for 1.0u of net progress while its goal moved 106.4u, throttle averaging
  // 0.53, and did it seven times in one match. It also means the leg never completes, so the only
  // thing that could ever re-open the plan was the 15-second backstop.
  //
  // The carrier has exactly ONE place it can turn the flag in, so stop racing and hold the door.
  // Jacob's spec: wait directly between the two towers in front of their FOB, just outside their
  // range; if those towers are down, stand in front of the gate instead, clear of the ones at the
  // back. (A heavy that would rather remove the problem than wait behind it can still siege — that
  // is a different mission and it scores on its own merits.)
  interceptCampSpot() {
    const tt = this.targetTeam();
    const camp = camps.find(c => c.team === tt && c.role === 'fob') || camps.find(c => c.team === tt);
    if (!camp || !camp.center) return null;
    const cx = camp.center.x, cz = camp.center.z, home = this.homePos();
    // The face they will approach from is the one pointing at US — that is the side a runner
    // crosses, and the side whose guns we have to stay off.
    let ax = home.x - cx, az = home.z - cz; const am = Math.hypot(ax, az) || 1; ax /= am; az /= am;
    const live = [];
    for (const w of (camp.walls || [])) {
      if (!w.turret || w.turret.dead || w.turret.falling || !w.body || w.body.dead) continue;
      const p = w.group.position;
      live.push({ x: p.x, z: p.z, r: towerStats((w.turret && w.turret.upg) || 0).range,
        front: (p.x - cx) * ax + (p.z - cz) * az });
    }
    const covered = (x, z) => live.some(t => (t.x - x) ** 2 + (t.z - z) ** 2 < (t.r + INTERCEPT_GUN_CLEAR) ** 2);
    // Walk outward along the approach until no live gun reaches the spot. Starting inside their
    // arcs and stepping out is what makes "just outside" fall out of the geometry rather than
    // being a number someone picked.
    const pushOut = (x, z) => {
      for (let d = 0; d <= INTERCEPT_PUSH_MAX; d += 4) {
        const qx = x + ax * d, qz = z + az * d;
        if (!covered(qx, qz)) return { x: qx, z: qz };
      }
      return { x: x + ax * INTERCEPT_PUSH_MAX, z: z + az * INTERCEPT_PUSH_MAX };
    };
    const frontT = live.filter(t => t.front > 0).sort((a, b) => b.front - a.front).slice(0, 2);
    if (frontT.length === 2) return pushOut((frontT[0].x + frontT[1].x) / 2, (frontT[0].z + frontT[1].z) / 2);
    if (frontT.length === 1) return pushOut(frontT[0].x + ax * 6, frontT[0].z + az * 6);
    // Front guns are down: hold the doorway itself. The gate record carries its outward normal.
    const g = gates.find(q => q.team === tt && (camp.walls || []).includes(q.w));
    if (g) return pushOut(g.gx + g.nx * INTERCEPT_GATE_STANDOFF, g.gz + g.nz * INTERCEPT_GATE_STANDOFF);
    return pushOut(cx + ax * (INTERCEPT_PUSH_MAX * 0.5), cz + az * (INTERCEPT_PUSH_MAX * 0.5));
  }
  interceptSpot() {
    const f = this.ourFlag();
    if (f && f.carried && f.carrier && !f.carrier.dead) {
      const c = f.carrier.holder.position;
      // CUT THEM OFF, don't tail them. If we can reach the door before the runner does, go and
      // stand in it — closing then is geometry rather than a foot race nothing in the game wins.
      // Only when the runner is already past us is tailing it worth anything, and then only
      // because it may be killed or forced to drop on the way.
      const camp = this.interceptCampSpot();
      if (camp) {
        const v = this.unit;
        const runnerToDoor = Math.hypot(c.x - camp.x, c.z - camp.z);
        const usToDoor = v && !v.dead ? Math.hypot(v.holder.position.x - camp.x, v.holder.position.z - camp.z) : Infinity;
        if (usToDoor < runnerToDoor) return camp;   // we can get there first — go hold the door
      }
      return { x: c.x, z: c.z };
    }
    if (this.ourFlagLoose()) { const p = f.group.position; return { x: p.x, z: p.z }; }
    return this.interceptCampSpot() || this.enemyFobPos();
  }
  // ── GOING HOME ────────────────────────────────────────────────────────────────────────────
  // Has this unit decided it is done fighting? The BRAIN answers that (AI.js publishes `_bail`),
  // because that is where the personality and its tuned thresholds live and asking the same
  // question twice in two places is what produced every flap this week. This only reads it.
  // The heroic dash, as a fraction: 0 beyond NERVE_FAR from the flag, 1 standing on it. A curve
  // rather than a switch, so the runner is cautious on the long approach and committed at the end
  // — the same shape as the old 85u capture commit, but weighed in the fight-or-flight sum with
  // everything else instead of overriding it.
  runnerNerve(v) {
    if (!v || v.type !== 'firebrat' || !this.strategy || this.strategy.step !== 'capture') return 0;
    const f = this.flag(); if (!f || f.carrier === v) return 0;      // carrying → the job is the trip home
    const p = v.holder.position;
    const d = Math.hypot(p.x - f.group.position.x, p.z - f.group.position.z);
    return Math.max(0, Math.min(1, 1 - d / NERVE_FAR));
  }
  shouldFlee() {
    const v = this.unit;
    if (!v || v.dead) return false;
    // TWO REASONS TO BREAK OFF, and they are different decisions:
    //   1. this unit is done — badly hurt with no fight worth having (the brain's verdict)
    //   2. we are CARRYING and the main road home is blocked — nothing to do with health; the
    //      direct route simply is not available, so take the back way. This is the case the whole
    //      investigation started from: a Valkyrie parked on the lane home for a whole match.
    const carrying = (() => { const f = this.flag(); return !!(f && f.carrier === v); })();
    const reason = (v.ai && v.ai._bail) || (carrying && this.mainRouteBlocked(v));
    if (!reason) return false;
    // YOU DO NOT FLEE HOME WHEN YOU ARE HOME. Without this a unit that limped back still wanted to
    // flee (its hull is low until it has healed), so the mission ended on arrival and re-armed on
    // the same tick — flee episodes of zero seconds, forever. Being at base is the state the
    // decision was reaching for; once there it is spent, and healing is the repair mission's job.
    return !this.atHomeBase();
  }
  // ── CHANGING VEHICLE ──────────────────────────────────────────────────────────────────────
  // Does switching to `key` need a different chassis than the one we are driving? Returns the type
  // to fetch, or null to carry on. Called from Doctrine._switch — the single funnel every mission
  // change passes through, which is why the old recall could be deleted rather than repaired.
  //
  // The guards that survived from `_maybeRecall`, and the one that did not:
  //   KEPT  don't turn your back on a live rival to go and change vehicles. A recalled unit drives
  //         home defenceless; a slow hull dies doing it.
  //   KEPT  on INTERCEPT, only a slow ground unit already near our own FOB is worth swapping —
  //         otherwise retreating just gifts the runner a clean escape; chase with what we have.
  //   GONE  the stock substitution. `_wouldField` swaps in an available chassis when the wanted
  //         one is out of stock, so a fleeing Firebrat with none left in the garage "wanted" to be
  //         a Lurcher and was recalled mid-escape to become one. A mission that names the vehicle
  //         it wants is now simply believed: 212 of 237 aborted recalls were this.
  swapWanted(key) {
    const v = this.unit; if (!v || v.dead) return null;
    const want = missionWants(key, this);
    if (!want || want === v.type) return null;                     // the job is happy with what we drive
    // COMPARE AGAINST WHAT WE WOULD ACTUALLY FIELD, not the raw want. `_pickAvailableType`
    // substitutes ("save the last of a type"), so asking for a Valkyrie can hand back a Lurcher —
    // and a Lurcher that drives home to become a Valkyrie rolls out as a Lurcher. The recall had
    // learned this and said so in a comment; I deleted the logic with it and put the bug straight
    // back: swap loops went 282 -> 731 across 240 seeds.
    const got = this._pickAvailableType(want);
    if (!got || got === v.type) {
      // ...UNLESS WE COULD BUILD THE REAL WANT. _pickAvailableType only reads the roster, so when
      // the roster is out of the type the job needs it substitutes back to what we already drive
      // and this bails as a wasted trip. That makes the whole thing circular, and seed 3362 is
      // what the circle looks like: capture wants a firebrat, blue has none, so the swap is
      // cancelled — which means no deploy, which means the scrap-rebuild in deploy() (which
      // exists, and is written for exactly this) never runs, which means still no firebrat.
      // Blue sat on 12 scrap and 6 piles on the ground for 885 seconds running `capture` with a
      // Lurcher, against an opponent it had already eliminated, and the match timed out.
      // Only when the bank can actually field the want — deploy() builds it — so this cannot
      // become a recall loop on a broke commander, which matters given `swap` can already absorb
      // a whole match.
      if (!(aiSwapBuild && aiScrapBuild && (this.roster[want] || 0) === 0 && this.canAfford(want))) return null;
    }
    const up = v.holder.position;
    for (const o of combatants) {                                  // a rival close enough to shoot us in the back
      if (o.dead || o.team === this.team || vehicleHidden(o)) continue;
      if ((o.holder.position.x - up.x) ** 2 + (o.holder.position.z - up.z) ** 2 < SWAP_DEFER_R * SWAP_DEFER_R) return null;
    }
    if (key === 'intercept') {
      const ground = v.type === 'jotun' || v.type === 'lurcher';
      const home = teamCenter(this.team, 'fob');
      const near = (up.x - home.x) ** 2 + (up.z - home.z) ** 2 < INTERCEPT_SWAP_R * INTERCEPT_SWAP_R;
      if (!(ground && near)) return null;                          // chase with what we have
    }
    return want;
  }
  // At the pad: retire the hull we brought home so deploy() rolls out the one the job asked for.
  // ONE EVENT, ONE MESSAGE, AND IT HAS TO BE TRUE. This always announced "is home" — including
  // when the mission had just given up on the trip — so the log carried both "can't get home,
  // ditching it" and "is home" in the same second for the same vehicle.
  completeSwap(want, ditched) {
    const v = this.unit; if (!v) return;
    aiLog(this.team, ditched
      ? `${this.cname}: ${v.type} couldn't get home to swap — ditching it and rolling out a ${want}.`
      : `${this.cname}: ${v.type} is home — swapping it out for a ${want}.`);
    this._swapFrom = v.type; this._swapWant = want;   // SWAP-LOOP alarm reads these at the next deploy
    this._endTour(v);
    removeCombatant(v); scene.remove(v.group); this.unit = null; this.respawnT = 1.0;
  }

  // IS THE MAIN ROAD HOME BLOCKED? Asked ONCE, when deciding — never as a running condition.
  // A known enemy counts as blocking only if it sits ALONG the line home (not behind us, not past
  // the base) and inside a corridor about as wide as its own gun, i.e. it can actually shoot us
  // on the way past.
  mainRouteBlocked(v) {
    const e = this.lastEnemyPos && this.lastEnemyPos();
    if (!e) return false;
    const p = v.holder.position, g = this.homePos();
    const dx = g.x - p.x, dz = g.z - p.z, len2 = dx * dx + dz * dz;
    if (len2 < 1) return false;
    const s = ((e.x - p.x) * dx + (e.z - p.z) * dz) / len2;
    if (s <= 0 || s >= 1) return false;
    const ox = p.x + dx * s - e.x, oz = p.z + dz * s - e.z;
    const reach = SHOT_REACH[e.type] || FLEE_CORRIDOR;
    return ox * ox + oz * oz < reach * reach;
  }
  // ONE definition of "home", used by BOTH the decision to flee and the mission's finish line.
  // They started as two radii — "near own supply" (12u) to start, 18u from the FOB to end — which
  // left a ring where a unit was simultaneously home enough to finish and far enough to start:
  // flee, done, flee, done, on every tick. Exactly the two-rulebooks defect this whole change is
  // about, written by me, twenty minutes after writing the note about it.
  atHomeBase() {
    const v = this.unit; if (!v) return false;
    const p = v.holder.position;
    return nearOwnSupply(v, p.x, p.z);
  }
  // THE ROUTE HOME, PLANNED ONCE. `from` is where the enemy was AT THE MOMENT WE DECIDED — a
  // snapshot, never re-read. With no known threat there is nothing to route around and the direct
  // way home is right.
  //   1 BREAK AWAY   — square off the line between us and them, on the side we are already on
  //   2 STAGE BEHIND — out the far side of our own FOB from them
  //   3 IN THE BACK  — the gate nearest that staging point, then home
  // Pull a waypoint onto ground THIS hull can actually reach, searching outward in rings.
  //
  // WHY A ROUTE NEEDS THIS AT ALL. A* runs partial, so an unreachable goal comes back as a route
  // to the closest reachable cell — which is the sane behaviour and exactly what you want while
  // travelling. But a LEG is only ever finished by getting within FLEE_REACH (14u) of the waypoint
  // itself, and the partial route only ever promises to deliver you to the closest point it could
  // find. Those two facts are reconciled nowhere: a waypoint 43u out in the sea leaves the unit
  // standing on the shore at the end of a perfectly good partial path, still 43u short, with the
  // leg counter refusing to advance. Flee is terminal by design, so nothing rescues it.
  // MEASURED on seed 3355: a Lurcher spent 1453s — the entire match — walking south into open
  // water toward waypoint 1 of 4, while its base sat 190u north.
  // Reachability, not just land: the Lurcher sinks, the Valkyrie flies, and they do not agree on
  // what counts as ground.
  _reachableWp(v, x, z) {
    const c = grid.cell, F = reachFrom(v);
    const ok = (px, pz) => { const k = navIdx(Math.round(px / c), Math.round(pz / c)); return k >= 0 && !!F[k]; };
    if (ok(x, z)) return { x, z };
    for (let r = c; r <= 80; r += c) {
      let best = null, bd = Infinity;
      for (let a = 0; a < 16; a++) {
        const th = a * Math.PI / 8, px = x + Math.cos(th) * r, pz = z + Math.sin(th) * r;
        if (!ok(px, pz)) continue;
        // Prefer the candidate nearest the ORIGINAL point, so the leg keeps the shape it was
        // drawn for — a break-contact leg pulled back to the beach is still a break-contact leg.
        const d = (px - x) ** 2 + (pz - z) ** 2;
        if (d < bd) { bd = d; best = { x: px, z: pz }; }
      }
      if (best) return best;
    }
    return null;   // nowhere within 80u this hull can stand — caller drops the leg
  }

  planFleeRoute(from) {
    const v = this.unit; if (!v) return null;
    const p = v.holder.position, g = this.homePos();
    if (!from) return [{ x: g.x, z: g.z }];
    let ax = g.x - from.x, az = g.z - from.z;
    const al = Math.hypot(ax, az) || 1; ax /= al; az /= al;      // the lane they are sitting on
    let qx = -az, qz = ax;                                        // square off it, our side
    if ((p.x - from.x) * qx + (p.z - from.z) * qz < 0) { qx = -qx; qz = -qz; }
    const wp = [{ x: p.x + qx * FLEE_BREAK, z: p.z + qz * FLEE_BREAK }];
    const camp = camps.find(c => c.center && (c.center.x - g.x) ** 2 + (c.center.z - g.z) ** 2 < 400);
    let ring = 0;
    if (camp) for (const q of gates) {
      if (!(camp.walls || []).includes(q.w)) continue;
      ring = Math.max(ring, Math.hypot(q.gx - camp.center.x, q.gz - camp.center.z));
    }
    const stage = { x: g.x + ax * (ring + FLEE_STAGE), z: g.z + az * (ring + FLEE_STAGE) };
    wp.push(stage);
    if (camp) {                                                   // a walled base is entered by a gate
      let best = null, bd = Infinity;
      for (const q of gates) {
        if (!(camp.walls || []).includes(q.w)) continue;
        const d = (q.gx - stage.x) ** 2 + (q.gz - stage.z) ** 2;
        if (d < bd) { bd = d; best = q; }
      }
      if (best) wp.push({ x: best.gx + best.nx * FLEE_GATE_OUT, z: best.gz + best.nz * FLEE_GATE_OUT });
    }
    wp.push({ x: g.x, z: g.z });
    // Snap the whole route, not just leg 1. The staging point behind the base and the gate mouth
    // are built the same geometric way and can land in the same kind of nowhere; the home point is
    // left as authored because a base you cannot reach is a different problem entirely.
    const out = [];
    for (let i = 0; i < wp.length; i++) {
      if (i === wp.length - 1) { out.push(wp[i]); break; }
      const fixed = this._reachableWp(v, wp[i].x, wp[i].z);
      if (fixed) out.push(fixed);                       // dropped entirely if nowhere near works
    }
    return out.length ? out : [{ x: g.x, z: g.z }];
  }

  // Nearest KNOWN, live shield generator to (x,z) — only POIs this team has discovered
  // (fog-of-war), so a commander won't beeline to a generator it's never seen.
  nearestKnownShield(x, z) {
    let best = null, bd = Infinity;
    for (const rp of this.knownSupplies) {
      if (rp.dead || rp.kind !== 'shield') continue;
      const d = (rp.pos.x - x) ** 2 + (rp.pos.z - z) ** 2;
      if (d < bd) { bd = d; best = rp; }
    }
    return best;
  }
  fortFrac() { return this.fortHp0 ? fortHpOf(this.targetTeam()) / this.fortHp0 : 1; }
  // Only the FLAG-HQ (main camp) turrets gate the win — they guard the flag. The
  // FOB/elevator turrets are optional (a unit still suppresses one that's shooting it,
  // but they no longer hold back the runner or inflate the "towers left" readout).
  turretsLive() { return turretCountOf(this.targetTeam(), 'main'); }
  // Tower-first: the flag-HQ is "breached" (safe to send a Firebrat runner) only once
  // ALL its turrets are down. A single live tower over the flag will shred the runner on
  // the grab, so we don't commit one until the defenses are fully silenced.
  fortDown() { return this.turretsLive() === 0; }
  // Send the runner once the flag is EXPOSED (HQ is rubble) and the defenses are mostly
  // silenced — all four turrets down is IDEAL but not required. A Firebrat is fast enough to
  // dash in past the couple of BACK towers, snatch the flag and get out, so we commit once the
  // near defenses are cleared (<= FLAG_GRAB_TURRETS still standing) rather than waiting for a
  // full sweep that often never finishes (the stalemate). A fully-down fort is still preferred
  // by the doctrine (it'll keep sieging while it can), this just stops hoarding the win.
  flagGrabbable() {
    if (!this.flagExposed()) return false;
    // A LOOSE flag lying far from its home (a downed carrier dropped it mid-field) is out
    // from under the base towers entirely — the turret gate below guards the grab AT the
    // base, so it shouldn't hold the runner back from a free pickup in the open. 60u >
    // TURRET_RANGE (54) even with an upgrade band or two of reach.
    const f = this.flag();
    if (f && !f.carried && Math.hypot(f.group.position.x - f.home.x, f.group.position.z - f.home.z) > 60) return true;
    return aiKeepBreach ? this.turretsLive() <= FLAG_GRAB_TURRETS : this.fortDown();
  }
  // L2 mission pick: when this team's policy is 'l2' and weights are loaded, the net
  // The enemy flag is sealed inside its HQ until that building is rubble. The
  // runner can't grab it before then, so the heavy must finish the HQ first —
  // strategy cards gate the open→grab handoff on this.
  // EXPOSED MEANS REACHABLE, not merely visible (Jacob's ruling). Killing the keep reveals the
  // flag, but the keep can be shelled from OUTSIDE the wall ring — seed 1572 ends with the HQ at
  // -68hp, all 30 walls intact, one shut gate, and a runner parked 30u from a flag it can never
  // touch for the rest of the match. `revealed` said yes; the board said no, and the whole
  // mission layer believed `revealed`.
  // Reading reachability here is what makes the SCORER pick a siege instead of a capture it cannot
  // finish — the fix belongs in the definition, not in a guard bolted onto Capture.
  // Cheap: reachFrom() memoises per vehicle per cell with its own TTL, so this is a flood fill
  // only when the unit has actually moved cells or the map changed.
  flagExposed() {
    const f = this.flag();
    if (!(f && f.revealed)) return false;
    if (!aiFlagReach) return true;
    const v = this.unit;
    if (!v || v.dead || !f.home) return true;   // nothing fielded → don't claim the flag is shut
    const F = reachFrom(v);
    const k = navIdx(Math.round(f.home.x / grid.cell), Math.round(f.home.z / grid.cell));
    return k >= 0 && !!F[k];
  }
  // A staging point on the FAR (back) side of the enemy flag base — past its centre,
  // away from the lane our units approach on. A Rogue runner curls around to here to slip
  // in the BACK instead of the hot front (ai_behavior Capture).
  enemyRearApproach() {
    const base = this.enemyBasePos(), from = this.homePos();
    let dx = base.x - from.x, dz = base.z - from.z;
    const d = Math.hypot(dx, dz) || 1; dx /= d; dz /= d;
    return { x: base.x + dx * 30, z: base.z + dz * 30 };
  }
  // Live turrets on the FAR (rear) side of the enemy flag base — the guns a back-door runner
  // must drive past. A Firebrat should only sneak around the back when this is 0; if only the
  // FRONT towers are down it's suicide to loop into live rear guns, so it takes the front (Capture).
  // ── DIRECTIONAL CAPTURE GEOMETRY (MissionScore A2) ─────────────────────────
  // Four approach directions to the enemy flag base, defined off the axis from OUR home to
  // THEIR base: front = the side we naturally arrive on, rear = the far side, left/right =
  // the flanks. Used by the per-direction capture scores + the directional runner routing.
  _dirBasis() {
    const base = this.enemyBasePos(), from = this.homePos();
    let fx = base.x - from.x, fz = base.z - from.z;
    const d = Math.hypot(fx, fz) || 1; fx /= d; fz /= d;
    return { base, fx, fz, lx: -fz, lz: fx };   // (lx,lz) = left-hand perpendicular
  }
  // Staging point 30u out on the given side of the enemy base (front/rear/left/right).
  enemyApproach(dir) {
    const b = this._dirBasis();
    const s = dir === 'rear' ? { x: b.fx, z: b.fz } : dir === 'left' ? { x: b.lx, z: b.lz }
      : dir === 'right' ? { x: -b.lx, z: -b.lz } : { x: -b.fx, z: -b.fz };
    return { x: b.base.x + s.x * 30, z: b.base.z + s.z * 30 };
  }
  // DIRECTIONAL CAPTURE ROUTE (Jacob's spec): an ORDERED list of waypoints the runner latches
  // through, so each direction is a genuinely DIFFERENT PATH — not just a different endpoint.
  //   front — direct: one near-front stage, then the flag (shortest).
  //   left/right — a wide DOGLEG: a mid-point ~100u off the home→base centerline, then a point
  //                off that side of the base, then the flag.
  //   rear  — a WATER ARC swung to the side AWAY from the enemy FOB (so it never blunders into
  //           the FOB guns), curving around behind the base. The Firebrat crosses water, so this
  //           loops wide of the defended interior. Radius stays inside the ~95u no-sub bubble so
  //           it can't aggro the submarine, and A* already hugs the coast (sub-water is costed).
  enemyRoute(dir) {
    const b = this._dirBasis(), E = b.base, H = this.homePos();
    const mx = (H.x + E.x) / 2, mz = (H.z + E.z) / 2;
    if (dir === 'left' || dir === 'right') {
      const s = dir === 'left' ? 1 : -1;
      return [{ x: mx + b.lx * 100 * s, z: mz + b.lz * 100 * s },   // 100u off the centerline, midfield
              { x: E.x + b.lx * 45 * s, z: E.z + b.lz * 45 * s }];   // off that side of the base
    }
    if (dir === 'rear') {
      const fob = this.enemyFobPos();
      const s = ((fob.x - E.x) * b.lx + (fob.z - E.z) * b.lz) > 0 ? -1 : 1;   // OPPOSITE side from the FOB
      const R = 85;                                                            // inside the no-sub bubble
      const ux = b.lx * s, uz = b.lz * s;                                      // away-from-FOB perpendicular (arc start)
      const arc = t => ({ x: E.x + R * (Math.cos(t) * ux + Math.sin(t) * b.fx), z: E.z + R * (Math.cos(t) * uz + Math.sin(t) * b.fz) });
      return [arc(0), arc(Math.PI / 4), arc(Math.PI / 2)];                     // side → diagonal → behind the base
    }
    return [{ x: E.x - b.fx * 35, z: E.z - b.fz * 35 }];                       // front: one near stage, then the flag
  }
  // WHAT WILL SHOOT AT THE RUNNER ON THE WAY IN.
  //
  // A capture direction is a ROUTE (see enemyRoute), so the honest question is not "are the guns
  // on that side of their keep dead" but "which guns that we know about can reach the path this
  // runner is actually going to drive". Those are different questions and they give different
  // answers. The side-count that used to live here (towersDownDir) missed the enemy FOB entirely
  // — its guns sit nowhere near the keep, belong to no side of it, and shoot runners all the same
  // — and it only ever paid a BONUS for a cleared side, so a lane with both guns alive scored
  // exactly the same as a lane with no guns at all. (Watched live: capture-rear +15.7 with two
  // live rear towers, and not one term in the breakdown mentioning them.)
  //
  // Walking the route also drops the last thing that had to be true about a map's shape. Nothing
  // here knows what "rear" means, and a designed map can put towers anywhere; every gun is scored
  // by whether it geometrically covers the path, so custom maps need no new bookkeeping.
  //
  // Fog-honest by construction: plannableTowers() is the intel notebook, not the board, so a gun
  // we have never seen costs nothing until we find it.
  //
  // Returns { n, exposure, worst }:
  //   n        — how many known guns cover any part of the route
  //   exposure — route-units driven inside a gun's range, SUMMED over guns (so a stretch covered
  //              by two guns costs twice, which is what being caught in it is like)
  //   worst    — deepest single penetration, 0..1 (grazing the edge of one arc is not the same
  //              as driving under the muzzle, and the weights should be able to tell)
  routeGuns(dir) {
    const guns = this.plannableTowers();
    // The route itself is fixed by the two base positions, so the ONLY things that can change
    // this answer are which guns we know about, where they are, and how upgraded they are.
    // Fingerprint exactly that and the cache can stand until one of them moves.
    let fp = dir + '|';
    for (const g of guns) fp += `${Math.round(g.x)},${Math.round(g.z)},${(g.wall && g.wall.turret && g.wall.turret.upg) || 0};`;
    const memo = this._routeGunMemo || (this._routeGunMemo = {});
    if (memo[dir] && memo[dir].fp === fp) return memo[dir].v;
    const pts = [this.homePos(), ...this.enemyRoute(dir), this.enemyBasePos()];
    const STEP = 6;                                   // sample stride along the path, in world units
    let n = 0, exposure = 0, worst = 0;
    for (const g of guns) {
      const R = towerStats((g.wall && g.wall.turret && g.wall.turret.upg) || 0).range;
      let cov = 0, deep = 0;
      for (let i = 0; i + 1 < pts.length; i++) {
        const ax = pts[i].x, az = pts[i].z, bx = pts[i + 1].x, bz = pts[i + 1].z;
        const len = Math.hypot(bx - ax, bz - az);
        const steps = Math.max(1, Math.ceil(len / STEP));
        for (let s = 0; s <= steps; s++) {
          const t = s / steps, x = ax + (bx - ax) * t, z = az + (bz - az) * t;
          const d = Math.hypot(x - g.x, z - g.z);
          if (d >= R) continue;
          cov += len / steps;
          const pen = (R - d) / R; if (pen > deep) deep = pen;
        }
      }
      if (cov > 0) { n++; exposure += cov; if (deep > worst) worst = deep; }
    }
    const v = { n, exposure: Math.round(exposure), worst: +worst.toFixed(2) };
    memo[dir] = { fp, v };
    return v;
  }
  // The least fire any approach has to eat right now. Every route converges on the keep, so the
  // keep's own guns cover the final run-in whichever side you come from — that floor is the price
  // of capturing AT ALL, and it is the same for all four directions. Subtracting it is what lets
  // the direction scores actually differ: what distinguishes a lane is the fire it takes ON TOP of
  // the unavoidable minimum. (Charging the floor to each direction instead suppressed capture
  // globally — average match time +10% with resolution unchanged — while leaving the four
  // directions within a point of each other.)
  safestRouteExposure() {
    let best = Infinity;
    for (const d of ['front', 'left', 'right', 'rear']) best = Math.min(best, this.routeGuns(d).exposure);
    return best === Infinity ? 0 : best;
  }
  // FOG-HONEST lane intel for a capture direction: reads only what the team has actually
  // SEEN or HEARD (the contact notebook below + whether any of our units has had eyes on
  // that approach recently). Never global truth — an unscouted lane is UNKNOWN, not clear.
  //   'blocked' — a known enemy contact sits on that approach corridor
  //   'clear'   — we had eyes on the corridor recently and know of nothing there
  //   'unknown' — nobody's looked lately (neutral: confidence must be earned by scouting)
  laneIntel(dir) {
    const a = this.enemyApproach(dir), b = this.enemyBasePos();
    const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;          // corridor midpoint
    if (!this._laneSeenT) this._laneSeenT = {};
    for (const u of this.liveUnits())
      if ((u.holder.position.x - mx) ** 2 + (u.holder.position.z - mz) ** 2 < 45 * 45) { this._laneSeenT[dir] = this._matchT; break; }
    const now = performance.now();
    if (this._contacts) for (const c of this._contacts) {
      if (now - c.t > 25000) continue;                          // stale sighting — no longer trusted
      // distance from the contact to the corridor segment a→b
      const dx = b.x - a.x, dz = b.z - a.z, len2 = dx * dx + dz * dz || 1;
      let t = ((c.x - a.x) * dx + (c.z - a.z) * dz) / len2; t = Math.max(0, Math.min(1, t));
      const px2 = a.x + dx * t, pz2 = a.z + dz * t;
      if ((c.x - px2) ** 2 + (c.z - pz2) ** 2 < 25 * 25) return 'blocked';
    }
    return (this._matchT - (this._laneSeenT[dir] || -1e9)) < 25 ? 'clear' : 'unknown';
  }
  // Contact notebook: every sight/sound detection any of our units makes lands here (capped,
  // pruned by age in laneIntel) — the team's honest picture of where enemies have been.
  _noteContact(x, z) {
    if (!this._contacts) this._contacts = [];
    const now = performance.now();
    for (const c of this._contacts) if ((c.x - x) ** 2 + (c.z - z) ** 2 < 15 * 15) { c.x = x; c.z = z; c.t = now; return; }
    this._contacts.push({ x, z, t: now });
    if (this._contacts.length > 8) this._contacts.shift();
  }
  rearTowersLive() {
    const tt = this.targetTeam(), base = this.enemyBasePos(), from = this.homePos();
    let dx = base.x - from.x, dz = base.z - from.z;
    const d = Math.hypot(dx, dz) || 1; dx /= d; dz /= d;
    let n = 0;
    for (const c of camps) {
      if (c.team !== tt || c.role !== 'main') continue;
      for (const w of c.walls) {
        const t = w.turret; if (!t || t.dead || t.falling) continue;
        const p = w.group.position;
        if ((p.x - base.x) * dx + (p.z - base.z) * dz > 2) n++;   // beyond base centre on the approach axis = rear side
      }
    }
    return n;
  }
  // A point just outside the enemy base's lowest-HP wall — where to punch through.
  weakestApproach() {
    const tt = this.targetTeam(), base = this.enemyBasePos();
    let best = Infinity, wx = base.x, wz = base.z;
    for (const c of camps) {
      if (c.team !== tt) continue;
      for (const w of c.walls) {
        if (!w.body || w.body.dead || (w.type && w.type.startsWith('GATE'))) continue;
        if (w.body.hp < best) { best = w.body.hp; wx = w.group.position.x; wz = w.group.position.z; }
      }
    }
    // step ~14u outward from base centre so the unit approaches the wall from outside
    const dx = wx - base.x, dz = wz - base.z, d = Math.hypot(dx, dz) || 1;
    return { x: wx + (dx / d) * 14, z: wz + (dz / d) * 14 };
  }
  counterVehicle() {
    let topType = null, topN = 0;
    for (const k in this.seenTypes) if (this.seenTypes[k] > topN) { topN = this.seenTypes[k]; topType = k; }
    // Don't ask for a counter we've run out of — fall back to one we still have.
    const c = (topType && COUNTER[topType]) || 'lurcher';
    return (this.roster[c] || 0) > 0 ? c : (this._pickAvailableType(c) || c);
  }
  // Total vehicles this commander has left to field (the fielded unit still counts).
  fleetLeft() { let n = 0; for (const k in this.roster) n += this.roster[k]; return n; }
  // --- SALVAGE: this team's scrap bank + building from it ---
  // THE FIGHT-OR-FLIGHT NUMBER, READ NOT RECOMPUTED. AI.js works this out once per tick for the
  // rival in sight (hull, ammo, shields, persona, local numbers, crossfire, the counter-web,
  // whether we could outrun it) and every other consumer reads that same value. The Fight mission
  // scores off this so the mission layer and the reflex layer cannot disagree about a duel.
  fightOdds() {
    const v = this.unit;
    if (!v || v.dead || !v.ai || v.ai._fof == null) return null;
    // IN RANGE, NOT MERELY IN SIGHT (Jacob: "now there is an enemy in-range"). Fight is the
    // decision you make when a rival is ON you — its opposite number is Flee, not Siege. Scoring
    // it off a sighting made it compete with the whole board from 66u away, and units broke off
    // real work to close 24u on contacts they could not yet shoot: across 240 seeds, pursue-stuck
    // 1->11, assault-stuck 26->43, four matches ended with cracked keeps, six runners in reserve
    // and nobody capturing. Same rule the flee side already learned (AI.js ~1109).
    // Symmetric with Fight.done, which ends the mission at 1.25x this reach — so the mission
    // covers exactly the window where a duel is actually possible.
    const d = v.ai._fofD;
    return (d != null && d <= (SHOT_REACH[v.type] || 42)) ? v.ai._fof : null;
  }
  shotReach(type) { return SHOT_REACH[type] || 42; }   // how far this chassis can actually shoot (Fight.done)
  scrap() { return teamScrap[this.team] || 0; }
  canAfford(type) { return this.scrap() >= (BUILD_COST[type] || 99); }
  // Build one of `type` from salvage — capped at the base garage count (same finite fleet
  // as the player). Returns true if it went through; adds it to the deployable roster.
  buildUnit(type) {
    const cost = BUILD_COST[type] || 99;
    if (this.scrap() < cost) return false;
    if ((this.roster[type] || 0) >= (GARAGE_COUNTS[type] || 0)) return false;   // already at base cap
    teamScrap[this.team] -= cost;
    this.roster[type] = (this.roster[type] || 0) + 1;
    scrapBuilds[this.team] = (scrapBuilds[this.team] || 0) + 1;
    if (viewerTeam() === this.team) updateScrapHud();
    aiLog(this.team, `${this.cname}: We've got the parts — building a fresh ${type}! (${this.scrap()} scrap left)`);
    return true;
  }
  // Nearest salvage pile this team has SPOTTED and that's still on the field (prunes collected
  // ones). Drives the Scavenge mission + the opportunistic pickup detour.
  // Nearest salvage pile this team knows about and can plausibly reach — skips debris in the
  // water AND piles A* recently failed to route to (walled off on a spit of land), so a unit
  // doesn't lock onto one it can never get to. Returns the PILE (use .pos), or null.
  nearestKnownScrap(x, z) {
    const now = performance.now();
    let best = null, bd = Infinity;
    for (const p of this.knownScrap) {
      if (p._gone || p.overWater) continue;   // skip debris in the water — ground units can't reach it
      const noReach = this._scrapNoReach.get(p);
      if (noReach != null) { if (noReach > now) continue; else this._scrapNoReach.delete(p); }   // recently unreachable → skip (expire the mark)
      const d = (p.pos.x - x) ** 2 + (p.pos.z - z) ** 2;
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  }
  // After a KILL, should the killer grab the wreck? The unit ALREADY pushes to the enemy's
  // last-known spot (= the kill site) and pauses to investigate, so the wreck is a few units
  // further on its existing path — grabbing it is basically free, so we just do it. The only
  // hard skips are decisive flag moments, where nothing should pull focus:
  //  • carrying the enemy flag, or on a CAPTURE run → stay on the objective
  //  • ANY flag in play (either side being carried) → don't wander at the deciding moment
  //  • our flag stolen → go contest it, not loot
  // (The longer OUT-OF-THE-WAY detours for distant scrap keep their mood/RNG gating; this is
  // only the free grab at a fresh kill.)
  wantsLoot(v = this.unit) {   // v: the unit that made the kill (multi-unit: not necessarily the bound slot's)
    if (!aiKillLoot) return false;
    if (!v || v.dead) return false;
    if (this.flag() && this.flag().carrier === v) return false;
    const sl = this._slotFor(v), strat = (sl && sl.strategy) || this.strategy;   // the KILLER's own card
    if (strat.step === 'capture' || strat.key === 'capture') return false;
    if (this.ourFlagStolen()) return false;
    if (this.ourFlagLoose()) return false;   // the thief we just killed DROPPED it — recover, don't loot
    for (const f of flags) if (f.carried) return false;
    return true;
  }
  // Should the team break off to SCAVENGE for parts? Two cases (both need scrap to actually be
  // findable — a known pile, or unexplored map left to scout):
  //   (A) defenses are cracking but we've no firebrat to run the flag and can't buy one, OR
  //   (B) we're down to ONLY firebrats (2+) with nothing heavier — poor at sieging, so go build
  //       up scrap for a real sieger instead of throwing runners at walls (Jacob's idea).
  needsPartsRun() {
    if (!aiScrapBuild) return false;
    const r = this.roster || {};
    const uType = this.unit && !this.unit.dead ? this.unit.type : null;
    const heavies = (r.jotun || 0) + (r.valkyrie || 0) + (r.lurcher || 0) + (uType && uType !== 'firebrat' ? 1 : 0);
    const firebrats = (r.firebrat || 0) + (uType === 'firebrat' ? 1 : 0);
    const needRunner = firebrats === 0 && !this.canAfford('firebrat') && (this.fortDown() || this.flagExposed());
    const onlyRunners = heavies === 0 && firebrats >= 2
      && !this.canAfford('jotun') && !this.canAfford('valkyrie') && !this.canAfford('lurcher');
    if (!needRunner && !onlyRunners) return false;
    const px = this.unit ? this.unit.holder.position.x : 0, pz = this.unit ? this.unit.holder.position.z : 0;
    return !!this.nearestKnownScrap(px, pz) || this.explore.fraction() < 0.8;
  }
  // THE KEY THE SCORER ACTUALLY READS. missionScore() scores DIRECTIONAL keys — MSN_CANDS holds
  // both 'siege' and 'siege-back', and the four 'capture-*' lanes — but strategy.step carries the
  // BASE name, because AIStrategies collapses 'siege-back' to 'siege' and 'capture-rear' to
  // 'capture' on the way in. Writing the report card under `step` therefore filed a failed REAR
  // siege against the FRONTAL one, benching the plan that did not fail while the one that did kept
  // a clean record and stayed top of the list. Measured with _msnkeys.cjs: siege-back lost 3 units
  // across four seeds and never took a single point; capture-front lost 2 and likewise.
  // This is the same runningKey idiom AIStrategies.js:853 already uses to pick a mission, in one
  // place so the write site and the vehicle swapper can never drift apart again.
  _msnKeyFor(step) {
    return (this._msnKey && this._msnKey.split('-')[0] === step) ? this._msnKey : step;
  }
  // The type to actually field: the wanted one if any remain, else a same-class
  // substitute, else whatever we have most of, else null (roster empty → eliminated).
  // THE PLAN MIGHT BE RIGHT AND THE VEHICLE WRONG. If this mission has already eaten
  // VEH_FAIL_SWAP units of the wanted type with nothing to show, field a different chassis that
  // has NOT failed here rather than sending an identical unit to die identically. This is what
  // stops the "Lurcher scuttles on siege forever" loop; the commander swaps to the Jotun that
  // clears the towers in one tour instead of eventually abandoning siege altogether.
  _vehicleForMission(step, want) {
    if (!aiVehSwap || !want || !this._msnVehFail) return want;
    // The rear-door gambit is a DIFFERENT plan from the grind we're abandoning, so the chassis
    // blame this layer keeps ("valkyries keep losing this siege") is about a mission we're no
    // longer running. Letting it veto the flyer kills the only play that can break the deadlock —
    // and it can't substitute anyway, since no ground unit flies the flank. _pickAvailableType
    // already carves the same exception out of its save-the-last reserve.
    if (want === 'valkyrie' && this._gambit) return want;
    const failed = t => this._msnVehFail[`${step}|${t}`] || 0;
    // Jacob's framing: "if the siege is getting negative points for LURCHER siege, roll out a new
    // vehicle." So the trigger is the two facts together — the MISSION is carrying a negative
    // score AND this CHASSIS is the one that has been failing it. A pure count of 2 also trips it
    // on its own, but that needs a long match to accumulate (his was 4907s); the paired test
    // catches it inside a normal one, which is where the swap is worth anything.
    const msnNeg = (this._missionSuccess && this._missionSuccess[this._msnKeyFor(step)]) || 0;
    const trip = failed(want) >= VEH_FAIL_SWAP || (failed(want) >= 1 && msnNeg < 0);
    if (!trip) return want;
    // Same-role stand-ins only (a runner has none) — reuse the substitution pool's intent.
    const alts = (want === 'firebrat' ? [] : ['jotun', 'lurcher', 'valkyrie'])
      .filter(t => t !== want && (this.roster[t] || 0) > 0)
      .sort((a, b) => failed(a) - failed(b));
    const alt = alts[0];
    if (!alt || failed(alt) >= failed(want)) return want;   // nothing cleaner available — carry on
    if (this._vehSwapLogged !== `${step}|${want}`) {
      this._vehSwapLogged = `${step}|${want}`;
      const n = failed(want);
      aiLog(this.team, `${this.cname}: ${n} ${want}${n === 1 ? '' : 's'} lost on this ${step} plan with nothing to show — the plan's fine, the vehicle isn't. Sending a ${alt}.`);
    }
    return alt;
  }
  _pickAvailableType(want) {
    const have = t => this.roster[t] || 0;
    // Substitute by ROLE, not raw speed. The Valkyrie is a base-ATTACKER (like the
    // heavies); the Firebrat is the fragile flag RUNNER. The old by-speed grouping fell a
    // dead-Valkyrie siege role back to a Firebrat (both "fast") and shoved a paper-thin
    // runner into a tower duel — it got shredded. A wanted SIEGER substitutes another
    // sieger (Jotun first, then Lurcher); a wanted runner has no real stand-in.
    const pool = want === 'firebrat' ? [] : ['jotun', 'lurcher', 'valkyrie'];
    // SAVE THE LAST OF A TYPE: don't burn a type's FINAL vehicle while another type still
    // has 2+ to spare — hold each type's last unit in reserve for the endgame. So a brain
    // that wants a type it's down to one of (or out of) fields an abundant same-role
    // substitute first. (Firebrats are the only runner, so they have no stand-in and skip
    // this — the Hunter's own firebrat reserve handles saving those for the capture.)
    if (have(want) >= 2) return want;                      // plenty of the wanted type — use it
    // GAMBIT OVERRIDE: the rear-door play IS the endgame the reserve was being saved for —
    // a substituted lurcher can't fly the flank, so holding the last valkyrie back here
    // just re-locks the stalemate the gambit exists to break (seed 221).
    if (want === 'valkyrie' && this._gambit && have('valkyrie') > 0) return 'valkyrie';
    // Among abundant substitutes, POOL ORDER wins (it encodes role suitability — jotun first
    // for siege work). Sorting by count here sent a reach-42 lurcher to do a reach-80 jotun's
    // siege because the team happened to own one more lurcher (seed 11's pop-gun sieger,
    // plinking a base for six minutes while two jotuns sat in the garage).
    const richSub = pool.filter(t => t !== want && have(t) >= 2);
    if (richSub.length) return richSub[0];
    // Nothing abundant left to spare — everything's down to its last, so it's now fine to
    // spend a final unit: the wanted type if any remain, else a same-role sub, else
    // whatever we have most of (e.g. a firebrat-only fleet).
    if (have(want) > 0) return want;
    const sub = pool.filter(t => t !== want && have(t) > 0);
    if (sub.length) return sub[0];
    const any = Object.keys(this.roster).filter(t => have(t) > 0);
    if (!any.length) return null;
    any.sort((a, b) => have(b) - have(a));   // last resort (e.g. a firebrat-only fleet) — most numerous
    return any[0];
  }
  // A recon waypoint into unexplored map, held until the unit reaches it, then advanced
  // to the next — so a scout sweeps the island outward instead of beelining the base.
  // Returns null once the map is mostly known (the card then falls back to its real goal).
  exploreTarget() {
    const v = this.unit; if (!v) return null;
    if (this.explore.fraction() > 0.8) return null;        // map's mostly mapped — stop wandering
    const px = v.holder.position.x, pz = v.holder.position.z;
    if (this._exploreWp) {
      // Clear (and repick a farther) waypoint BEFORE the unit gets close enough that the
      // seek behavior parks on it (it stops within arriveDist). If the clear-radius were
      // smaller than arriveDist, a waypoint landing in that dead zone would freeze the
      // scout: arrived (so it stops) but not cleared (so it never picks a new target).
      const reach = this.strategy.arriveDist(this) + 8;
      if ((this._exploreWp.x - px) ** 2 + (this._exploreWp.z - pz) ** 2 < reach * reach) this._exploreWp = null;
    }
    // minR beyond the clear radius so a fresh waypoint is always something to actually TRAVEL to
    // (never one that's cleared next tick → the scout keeps moving instead of freezing).
    // …and never send a ground unit to a patch of land it can't drive to (see drivableTo): the
    // recon grid knows what is LAND, which is not the same question. When every unexplored patch
    // left is across water, this returns null and the Scout card falls back to its real goal.
    if (!this._exploreWp) { const home = this.homePos(), enemy = this.enemyBasePos(); this._exploreWp = this.explore.pickTarget(px, pz, home.x, home.z, this.strategy.arriveDist(this) + 12, enemy.x, enemy.z, (x, z) => drivableTo(v, x, z)); }
    return this._exploreWp;
  }

  // Log label = this team's palette colour name (PURPLE, CYAN…), so a log line reads
  // as the colour the team actually wears on the field — clearer than a flavour name.
  get cname() { return teamLabel(this.colorIndex); }

  // Draw a fresh card (on repeated losses / stalls) — keeps the AI unpredictable.
  redraw() { this.strategy = makeDoctrine(this.archetype, this.personality, Math.random, this.strategy.constructor, m => aiLog(this.team, `${this.cname}: ${m}`)); this.fortHp0 = fortHpOf(this.targetTeam()) || this.fortHp0; this.failStreak = 0; aiLog(this.team, `${this.cname}: That's not working — new plan, listen up!`); }

  // WHAT WOULD WE ACTUALLY ROLL OUT for the plan we're running? Every substitution deploy applies,
  // in deploy's order, and nothing that spends scrap — so it is safe to ask at any time.
  //
  // This exists because deploy and _maybeRecall used to work it out separately, and a recall that
  // demands a vehicle deploy will never field is a deadlock with no way out. Seed 1151: the
  // stalemate gambit armed, _pickAvailableType's gambit override answered "valkyrie", the recall
  // saw a valkyrie coming and pulled the Jotun off the pad — then deploy ran the FULL chain, where
  // the chassis-blame layer substituted the valkyrie straight back to a Jotun. Neither side ever
  // changed its mind: 285 swaps, a fresh Jotun every 3.5 seconds for twenty minutes, hull never
  // scratched, never more than 170u from home. One question, one answer, and the loop can't form.
  //
  //   rawWant — what the doctrine ASKED for, before any substitution. A rescue that reasons "the
  //             plan needs X and we own no X" has to read this one, since `want` has already been
  //             through _pickAvailableType and can never name a type we're out of.
  //   want    — the plan's ask after the save-the-last reserve and the chassis-blame layer.
  //   type    — what the roster can actually put on the pad right now.
  _wouldField(announce = false) {
    let rawWant = this.strategy.wantVehicle(this);
    // DON'T SPEND THE LAST RUNNER ON ERRANDS. "SAVE THE LAST OF A TYPE" in _pickAvailableType
    // holds each type's final vehicle back while another type has spares — but its pool is empty
    // for the firebrat, so the ONE irreplaceable unit is the only one it does not protect. The
    // comment there says the Hunter's firebrat reserve covers it; no such reserve exists. And the
    // Rogue's role table asks for a FIREBRAT to scout (AIStrategies.js), so a commander will send
    // its last flag carrier out sightseeing.
    // A capture has no substitute and must still go. Everything else does have one, so when the
    // runner pool is down to its last and the mission is not a capture, field something else.
    if (aiSaveRunner && rawWant === 'firebrat' && this.strategy.step !== 'capture'
        && (this.roster.firebrat || 0) <= 1) {
      const sub = ['lurcher', 'valkyrie', 'jotun'].find(t => (this.roster[t] || 0) > 0);
      if (sub) {
        if (announce && this._saveRunnerLogged !== this.strategy.step) {
          this._saveRunnerLogged = this.strategy.step;
          aiLog(this.team, `${this.cname}: That's our last Firebrat — it's the only thing that can carry a flag. Sending a ${sub} on ${this.strategy.step} instead.`);
        }
        rawWant = sub;
      }
    }
    const want = this._vehicleForMission(this.strategy.step,
      this._pickAvailableType(rawWant) || rawWant);
    // The scrap-funded builds in deploy are deliberately NOT modelled here: they spend, and this
    // has to stay free to call. They only ever fire when the roster is short, and their effect is
    // to field MORE than this predicts — so a caller comparing against the current unit errs
    // toward leaving it alone, which is the safe direction for a swap.
    return { rawWant, want, type: this._pickAvailableType(want) };
  }

  deploy() {
    // PICK THE MISSION BEFORE THE LIFT MOVES. Everything below chooses a chassis for
    // `this.strategy.step`, so a stale step buys the wrong vehicle: slot 0's very first
    // roll-out happened before the doctrine had ticked even once, and each respawn deploys
    // from a dead slot (which returns before its tick). Deciding here is what makes the
    // garage choice and the mission the same decision.
    if (this.strategy.garagePick) this.strategy.garagePick(this);
    // (The learned mission assigner lived here: a net re-picked a support slot's role card each
    // tour from a 26-feature snapshot of the battlefield. It never beat the deck it was meant to
    // replace and was abandoned; the whole apparatus — two nets, the feature vector, the history
    // sampler, the training log and the policy switches — is gone. Slots take their role from
    // ROLE_DECK, which is what every match has actually been doing.)
    const { rawWant, want } = this._wouldField(true);
    // REINFORCEMENT SPENDING (Jacob's rule: "if I had the scrap, I'd spend it"): a rich bank
    // plus running LOW on the wanted type builds a fresh one before picking — not just at
    // zero. A commander sat on 15 scrap feeding lone runners into a defended base; a rich
    // team converts parts into pressure. buildUnit still respects the garage cap.
    // THE FLOAT IS THERE TO PROTECT THE RUNNER, so it only applies when the runner is at risk.
    // A Firebrat costs 2, and the float exists so a build can't leave the team unable to field
    // one. With two or more already in the pool that worry is answered and the float is pure
    // drag — measured on seed 1151: red held 7 scrap for 650 seconds needing 8 to build the
    // Jotun that would have ended the match, while sitting on SIX Firebrats. It ground two
    // towers with a Lurcher and stalemated. (Jacob: "+3 or >1 FB — if they have 2 FB then they
    // don't need reserve scrap.")
    const float = (this.roster.firebrat || 0) > 1 ? 0 : 3;
    if (aiScrapBuild && (this.roster[want] || 0) <= 1 && this.scrap() >= (BUILD_COST[want] || 99) + float) this.buildUnit(want);
    let type = this._pickAvailableType(want);
    // SALVAGE REINFORCEMENT: build the flag RUNNER when the plan needs one and we're out. The
    // firebrat has no substitute, so a commander that's lost them all can't win by capture — so
    // it spends the scrap bank to field a fresh one. Deliberately NOT a full resurrection: a
    // wholly-wiped team (type === null) still gets eliminated, or matches would never end (a
    // resurrecting team can't be beaten by elimination — measured -3/16 resolved). The build
    // only applies while the team is otherwise still alive.
    // THIS TESTED `want`, WHICH MADE IT UNREACHABLE. `want` comes out of _pickAvailableType,
    // which substitutes to something we actually own — so it can only equal 'firebrat' when we
    // HAVE a firebrat, while the next clause demands we have none. The two could never both
    // hold, and this rescue had never run once. Seed 116 is what it looks like: red cracked the
    // keep, exposed the flag, spent all six runners, then sat on 3 scrap (a firebrat costs 2)
    // running capture after capture with a LURCHER, which cannot carry a flag. Read the plan's
    // intent instead.
    if (aiScrapBuild && rawWant === 'firebrat' && (this.roster.firebrat || 0) === 0 && type !== null && type !== 'firebrat' && this.buildUnit('firebrat')) {
      type = 'firebrat';
    }
    // SALVAGE REINFORCEMENT (heavy): the plan wants a SIEGER but we're down to only runners
    // (type fell back to 'firebrat' with no heavy in the roster). Spend the scrap we scavenged to
    // field the best heavy we can afford, so a firebrat-only team isn't stuck battering walls with
    // runners. Team still alive (has firebrats), so this is no wiped-team resurrection.
    if (aiScrapBuild && want !== 'firebrat' && type === 'firebrat'
        && !(this.roster.jotun || 0) && !(this.roster.valkyrie || 0) && !(this.roster.lurcher || 0)) {
      for (const heavy of ['jotun', 'valkyrie', 'lurcher']) { if (this.buildUnit(heavy)) { type = heavy; break; } }
    }
    if (!type) {                               // roster empty AND can't afford a rebuild — out of the fight
      this.unit = null;
      if (!this._eliminated) { this._eliminated = true; aiLog(this.team, `${this.cname}: We're combat ineffective — no vehicles left! We're out!`); }
      return;
    }
    // SWAP-LOOP ALARM: we pulled a unit off the field to trade it for something better, and the
    // lift just brought the same type back up. That is a recall placed against a vehicle deploy
    // will not field, and nothing about it looks broken from outside — no crash, no stuck unit, a
    // sensible mission throughout. Seed 1151 ran this 285 times in twenty minutes: a fresh Jotun
    // every 3.5 seconds, hull never scratched, never more than 170u from home, while the recall
    // held out for a Valkyrie the chassis-blame layer substituted away every single time.
    // A swap that actually changed the chassis proves the machinery works, so it clears the run.
    // What this alarm is for is the case where EVERY swap comes back the same — 285 of them in
    // twenty minutes on seed 1151 — not the occasional wasted one. Measured across 30 matches, a
    // couple per match are normal: a recall placed on a perishable plan (intercept) whose reason
    // expires in the one second between despawn and deploy. That costs a second of unit time.
    // Preventing it outright was tried and cost three stalemates and triple the nav alarms, so it
    // is TOLERATED — and an alarm that fires on the tolerated case is noise, which is why this
    // counts consecutive repeats rather than a total. The total still goes to the summary.
    if (this._swapFrom && type !== this._swapFrom) this._swapLoops = 0;
    if (this._swapFrom && type === this._swapFrom && type !== this._swapWant) {
      swapLoopsTotal++;
      this._swapLoops = (this._swapLoops || 0) + 1;
      if (this._swapLoops === SWAP_LOOP_ALARM) {
        aiLog(this.team, `[SWAP-LOOP ALARM] ${this.cname}: ${SWAP_LOOP_ALARM}x now we've brought a ${type} home to swap it `
          + `for a ${this._swapWant} and rolled out another ${type}. The swap wants something the garage won't build.`);
      }
    }
    this._swapFrom = null; this._swapWant = null;
    const sub = type !== want ? ` (${want}s are gone)` : '';
    aiLog(this.team, `${this.cname}: Rolling out a fresh ${type}${sub} — ${this.fleetLeft()} in reserve!`);
    // FLAVOUR: narrate the Rogue's signature play — sending the Valkyrie around the back to rocket the
    // HQ over the walls. Reads like the commander calling the shot (Brandon-approved log theatre). A
    // cycling pool (no RNG so it stays deterministic) keeps it varied without repeating the same line.
    if (this.archetype === 'rogue' && type === 'valkyrie' && this.strategy.step === 'siege') {
      const barks = [
        'front door\'s a meatgrinder — Valkyrie, take the back way',
        'send the Valkyrie around the back',
        'over the walls and onto the keep from behind',
        'flank wide, hit the HQ where they aren\'t looking',
        'the walls are their problem — Valkyrie goes over the top',
        'quiet route round the back, rockets on the flag base',
      ];
      this._barkN = (this._barkN || 0) + 1;
      aiLog(this.team, `${this.cname}: “${barks[this._barkN % barks.length]}”`);
    }
    const home = this.homePos();
    const v = new Vehicle(type); v.setScale(0.72);
    v.setCamo(this.colorIndex); v.setTeamColor(TEAM_COLORS[this.colorIndex].hex);
    scene.add(v.group);
    initCombatant(v, this.team, this.colorIndex, false);
    v.ai = new Brain(this.personality);
    v._archetype = this.archetype;   // drives the nav terrain preference (Rogue ocean / Hunter forest)
    this.unit = v;
    this._flankPt = null; this._flankDone = false;   // fresh "sneak round the side" approach for this unit
    // MISSION REPORT CARD: snapshot the war state as this unit rolls out. If it dies having
    // achieved NOTHING (no kills, no damage to their base, never touched the flag), that's a
    // TOTAL failure — two in a row on the same mission bans it (missionBanned) so the doctrine
    // tries something else instead of feeding identical units into the same guns.
    this._mrec = { veh: type, kills0: this.kills, fort0: fortHpOf(this.targetTeam()), flagTouched: false,
      role: this._role || this.archetype, t0: performance.now() };
    // Ride up the FOB elevator like the player does — it can't leave (or shoot)
    // until the lift tops out, so neither side gets a head start (see update()).
    // Each slot prefers its OWN lift (slot i → the team's i-th elevator); if that
    // one's carrying someone (cap > lifts under the debug override), take any free
    // lift, else fall through to the ground spawn below.
    const teamElevs = elevators.filter(e => e.team === this.team);
    let elev = teamElevs.length ? teamElevs[this._slotI % teamElevs.length] : null;
    if (elev && this._elevBusy(elev)) elev = teamElevs.find(e => !this._elevBusy(e)) || null;
    if (elev && !this._elevBusy(elev)) {
      // Face the gate it will drive out of (not just map centre) so heavies roll
      // straight through the opening instead of grinding into a corner wall.
      const ex = this._computeExit();
      const heading = ex ? Math.atan2(elev.center.x - ex.x, elev.center.z - ex.z)
                         : Math.atan2(elev.center.x, elev.center.z);
      elev.loop = false; elev.phase = 'down'; elev.t = 0;
      elev.lift.position.y = elev.bottomY;
      elev.setRider(v, heading);
      elev.start();
      this._elev = elev; this._rising = true;
      return;
    }
    // Fallback (no lift / lift busy): spawn on clear land outside the FOB.
    const obj = this.strategy.objective(this);
    const toward = Math.atan2(obj.x - home.x, obj.z - home.z);
    let sx = home.x, sz = home.z;
    for (let t = 0; t < 40; t++) {
      const a = toward + (Math.random() - 0.5) * 1.8, r = 26 + Math.random() * 20;
      const tx = home.x + Math.sin(a) * r, tz = home.z + Math.cos(a) * r;
      if (map.isLand(tx, tz) && !v._blocked(tx, tz)) { sx = tx; sz = tz; break; }
    }
    v.setPose(sx, vehicleGroundY(sx, sz), sz, toward);
  }
  _elevBusy(elev) { return elev.rider && elev.rider !== this.unit; }

  // A GROUND unit is boxed in by the FOB walls — the only way out is a gate. Pick the
  // gate nearest the objective and return a waypoint ~16u beyond it. Flyers (Valkyrie)
  // clear walls, so no exit plan. Used to FACE the unit at the gate on deploy AND as
  // the drive-out waypoint after it tops — so heavies stop "dancing on the elevator".
  _computeExit() {
    const v = this.unit; if (!v || v._move.ignoreWalls) return null;
    const fob = teamCamp(this.team, 'fob'); if (!fob) return null;
    const gates = fob.walls.filter(w => w.type && w.type.startsWith('GATE'));
    if (!gates.length) return null;
    const obj = this.strategy.objective(this);
    let best = null, bestD = Infinity;
    for (const g of gates) {
      const gx = g.group.position.x, gz = g.group.position.z;
      const d = (gx - obj.x) ** 2 + (gz - obj.z) ** 2;
      if (d < bestD) { bestD = d; best = { x: gx, z: gz }; }
    }
    const dx = best.x - fob.center.x, dz = best.z - fob.center.z, m = Math.hypot(dx, dz) || 1;
    return { x: best.x + dx / m * 16, z: best.z + dz / m * 16 };
  }
  _logTick(v, view, cmd) {
    const fob = teamCenter(this.team, 'fob');
    const prev = this._dbg && this._dbg.state;
    // Visible siege progress: shout when an enemy tower falls, and when the last one
    // does (defenses clear → time to crack the HQ). Tracked on the commander so it
    // survives unit deaths/swaps mid-siege.
    const liveTowers = this.turretsLive();
    if (this._lastTowers == null) this._lastTowers = liveTowers;
    if (liveTowers < this._lastTowers) {
      aiLog(this.team, liveTowers === 0
        ? `${this.cname}: That's the last turret — defenses are DOWN! Breach the HQ!`
        : `${this.cname}: Turret down! ${liveTowers} to go — keep pounding!`);
      this._lastTowers = liveTowers;
    } else if (liveTowers > this._lastTowers) { this._lastTowers = liveTowers; }   // match reset
    // MOVEMENT HEALTH — the half the log was missing: it showed INTENT ("assault turret")
    // but not whether the unit is actually getting there. Compare real ground covered vs
    // intent; when it wants to move but isn't, rack up stuck-time and name a likely cause.
    const pX = v.holder.position.x, pZ = v.holder.position.z;
    const step = this._lpx != null ? Math.hypot(pX - this._lpx, pZ - this._lpz) : 1;
    this._lpx = pX; this._lpz = pZ;
    const wantsMove = Math.abs(cmd.fwd) > 0.2 || Math.abs(cmd.turn) > 0.5 || cmd.state === 'engage';
    if (wantsMove && step < view.dt * 0.8) this._stuckT = (this._stuckT || 0) + view.dt; else this._stuckT = 0;
    // NET-PROGRESS watchdog — the wedge class every timer above is blind to: a unit sliding
    // on shore terrain with NO feeler contact (blk=···) resets _stuckT (it moves each tick),
    // never accrues the brain's _wedgeT (not pressed on anything), and never goes still. The
    // tournament caught a runner ground against a shore slope for 802s with every reflex
    // silent (seed 137). Sample NET displacement on a 10s window: wanting to move for most
    // of it while covering under 4u of real ground is a wedge, whatever the feelers say —
    // navOverride answers with a reverse-pivot jolt + spot blacklist + fresh replan.
    this._netT = (this._netT || 0) + view.dt;
    if (wantsMove) this._wantT = (this._wantT || 0) + view.dt;
    if (this._netT >= 10) {
      this._netStuck = this._netX != null && (this._wantT || 0) > 6
        && Math.hypot(pX - this._netX, pZ - this._netZ) < 4;
      this._netX = pX; this._netZ = pZ; this._netT = 0; this._wantT = 0;
    }
    let stuckWhy = '';
    if (this._stuckT > 0.6) {
      stuckWhy = !map.isLand(pX, pZ) ? 'in water'
        : view.blockedAhead ? 'wall/obstacle ahead'
        : (view.blockedLeft && view.blockedRight) ? 'boxed in'
        : 'wedged on terrain';
    }
    // The RESOLVED destination the unit is actually driving to THIS tick — depends on the brain
    // state, not just the mission goal (a resupplying unit heads to fuel, not its objective). This
    // is what makes the log honest about "where is it trying to get to" (Jacob's ask).
    let dest = view.goal;
    if (cmd.state === 'resupply') dest = this._supply || view.goal;
    else if (cmd.state === 'pursue') dest = (v.ai && v.ai.lastSeen) || view.goal;
    else if (cmd.state === 'engage') dest = view.enemy || view.goal;
    else if (cmd.state === 'suppress') dest = view.threatStand || view.threat || view.goal;
    const destDist = dest ? Math.round(Math.hypot(v.holder.position.x - dest.x, v.holder.position.z - dest.z)) : null;
    this._dbg = {
      name: this.cname, type: v.type, state: cmd.state,
      stuck: this._stuckT > 0.8 ? +this._stuckT.toFixed(1) : 0, stuckWhy,
      card: (this.strategy.constructor.name || 'Card').replace('Strategy', ''),
      fwd: +cmd.fwd.toFixed(2), turn: +cmd.turn.toFixed(2),
      blk: (view.blockedLeft ? 'L' : '·') + (view.blockedAhead ? 'A' : '·') + (view.blockedRight ? 'R' : '·'),
      hp: Math.round(v.hp / v.maxHp * 100), ammo: v.ammo, fuel: Math.round(v.fuel), maxFuel: Math.round(v.maxFuel), shield: Math.round(v.shield),
      fof: v.ai && v.ai._fof != null ? +v.ai._fof.toFixed(1) : null,   // live fight-or-flight score vs the rival in sight
      // WHAT IS IT SHOOTING AT, and is that the keep or a gun? Re-selecting a target is fine once
      // — it is re-selecting REPEATEDLY that shuttles a unit, because the firing position moves
      // with the target. Without this the switch was invisible: only its consequence (the goal
      // jumping) showed up, which is why it read as nav churn for so long.
      tgt: view.threat ? { x: Math.round(view.threat.x), z: Math.round(view.threat.z), kind: this._prioTarget || 'tower', why: this._tgtWhy || '?' } : null,
      // CHAIN OF COMMAND (driver architecture): the standing maneuver order + the pedals
      // actually driven — the two bottom rows of the console's layer display.
      mnv: this._driver ? this._driver.label() : null,
      drv: this._driver ? this._driver.pedals() : null,
      alarms: this._driver ? this._driver.alarms : 0,
      distFob: Math.round(Math.hypot(v.holder.position.x - fob.x, v.holder.position.z - fob.z)),
      px: Math.round(v.holder.position.x), pz: Math.round(v.holder.position.z),
      gx: dest ? Math.round(dest.x) : null, gz: dest ? Math.round(dest.z) : null, gd: destDist,   // where it's ACTUALLY headed + distance
      atHome: !!view.atHome, navPath: this._nav && this._nav.path ? this._nav.path.length : 0,   // in a supply/heal zone? has an A* route?
      towers: this.turretsLive(),   // enemy turrets still standing (tower-first ordering)
      // Live detection (feeds the ?nav label's contact line): a rival vehicle in sight, an
      // enemy turret sensed in range, or a heard-but-unseen contact.
      foeT: view.enemy ? view.enemy.type : null,
      foeD: view.enemy ? Math.round(Math.hypot(view.enemy.x - pX, view.enemy.z - pZ)) : null,
      turD: view.threat ? Math.round(Math.hypot(view.threat.x - pX, view.threat.z - pZ)) : null,
      hq: !!view.hqThreat,   // the suppress target is the enemy KEEP, not a tower (labels)
      sap: v._sapPhase || null,   // sap sortie leg (out/back/pod/done) — names the advance target in the logs
      heard: !!view.heard,
    };
    if (cmd.state !== prev) {
      // Plain-language state line: WHAT the unit is doing and WHERE/AT-WHAT, plus the
      // active strategy card in [brackets]. The wording deliberately distinguishes the
      // two combat states the bare names conflate — `engage` is duelling a moving enemy
      // VEHICLE, `suppress` is shelling a static enemy TOWER.
      const card = (this.strategy.constructor.name || 'Card').replace('Strategy', '');
      const dest = this._intercepting ? 'the flag runner'
        : this._shielding ? 'the shield generator'
        : (this.strategy.objectiveLabel ? this.strategy.objectiveLabel(this) : 'the objective');
      const hpPct = Math.round(v.hp / v.maxHp * 100);
      // Radio-chatter phrasing — reads like the unit calling it in over the net, but still
      // carries every number the old lines did (hp %, fuel %, turrets left, enemy type). The
      // "— ${dest}" dash pattern joins cleanly whether the mission label is a noun ("the enemy
      // base") or a gerund ("levelling the undefended base"), so no "sieging hunting" collisions.
      let line;
      switch (cmd.state) {
        case 'advance':  line = `Moving up — ${dest}!`; break;
        case 'flee':     line = `Taking fire — breaking off toward ${dest}!`; break;
        case 'pursue':   line = 'Lost visual — pushing to their last-known spot!'; break;
        case 'resupply': line = v.ammo <= 0 ? 'Winchester — outta ammo! Heading back to rearm!' : `Running low, fuel ${Math.round(v.fuel / v.maxFuel * 100)}% — RTB to refuel!`; break;
        case 'engage':   line = `Contact! Enemy ${view.enemy ? view.enemy.type : 'vehicle'} in sight — engaging!`; break;
        case 'suppress': {
          const inPos = view.threatStand && Math.hypot(view.threatStand.x - v.holder.position.x, view.threatStand.z - v.holder.position.z) <= 6;
          // With every turret down the suppress target is promoted to the flag HQ (hqThreat) —
          // "their turret — 0 left" read like nonsense in the log, so name the real target.
          line = view.hqThreat ? (inPos ? 'On target — pounding their HQ!' : 'Lining up on their HQ — crack it open!')
                               : (inPos ? `On target — hammering their turret! ${this.turretsLive()} left!` : `Working an angle on their turret — ${this.turretsLive()} left!`);
          break;
        }
        case 'assault':  { const n = this.turretsLive(); line = `Danger close — on ${dest}! ${n} turret${n === 1 ? '' : 's'} left, pour it on!`; break; }
        default:         line = cmd.state;
      }
      // Anti-bounce filter: a state flickering A↔B (LOS blinking at the engage-range edge) used
      // to re-log the same two lines several times a second and flood the feed. A bounce (going
      // straight back to where we just came from within 8s) logs quietly — archive-only.
      const nowS = (performance.now() - _t0) / 1000;
      const bounce = this._lastFlip && this._lastFlip.from === cmd.state && this._lastFlip.to === prev
        && nowS - this._lastFlip.t < 8;
      this._lastFlip = { from: prev, to: cmd.state, t: nowS };
      aiLog(this.team, `${this.cname} ${v.type}: ${line} [${card}]`, {
        // structured ride-along for headless analysis (RR.aiEvents): what changed, where, how far to go
        unit: v.type, from: prev, to: cmd.state, step: this.strategy.step,
        x: this._dbg.px, z: this._dbg.pz, gd: this._dbg.gd, hp: this._dbg.hp, ammo: this._dbg.ammo,
        quiet: bounce || undefined,
      });
    }
  }

  // Path-follow the long-haul TRAVEL states with A* (advance to the objective, run
  // home to resupply/retreat, close to siege standoff). Combat (engage/suppress),
  // the gate exit, and the unstick reflex keep their own tuned steering. Flyers go
  // straight. Falls back to the brain's seek when there's no route.
  // Stand here on purpose. Issues a real HOLD order so the driver owns the tick and the nav
  // ledger stays honest — the behaviour still supplies the pedals, exactly as it did under DIRECT.
  _hold(cmd, why) {
    // A maneuver outranks standing still: if the brain picked ORBIT/KITE/JOUST this tick, let the
    // caller issue it rather than pinning the unit here. Returning false hands the tick back
    // unchanged, so this can never take motion away from a behaviour that wanted it.
    if (cmd.mnv) return false;
    this._navBail = null;
    this._driver.order({ type: 'HOLD', by: cmd.state, why });
    // No tick() — a HOLD produces no pedals by design; the behaviour's own output stands.
    return true;
  }

  // The reverse-pivot, as an order. The pedals are the ones the reflex already computed — this
  // only puts a name on the tick so the ledger's remaining entries are all genuine defects.
  _jolt(cmd, by) {
    this._navBail = null;
    this._driver.order({ type: 'JOLT', by, side: (cmd.turn || 1) > 0 ? 1 : -1 });
    return true;
  }

  _navOverride(v, view, cmd, dt) {
    this._destIsStand = false;   // set by the suppress branch below; reset every tick so it can't leak across states
    // WHY DID THIS TICK NOT GET A ROUTE? Every bail below names itself. 40% of all driving was
    // running under DIRECT — "the behavior steers itself" — and two thirds of that was a unit
    // travelling to something 40u+ away with no route at all. "It fell through to DIRECT" is not
    // a diagnosis, so each exit is tagged and the tally is reported with the nav alarms.
    this._navBail = null;
    // A FLYER NAVIGATES TOO — it just navigates in straight lines. This used to return here, which
    // left the Valkyrie permanently order-less: half of all order-less driving, and the one class
    // of unit the driver's stall watchdog, flight recorder and unreachable-goal contract never
    // covered. Nothing on the map blocks it, so planPath hands back the straight line without
    // searching; the point of coming through here is that the result is a real GOTO somebody owns.
    const flyer = v._move.ignoreWalls;
    if (flyer && !aiFlyerRoute) { this._navBail = 'flyer'; return; }
    if (cmd.breakAim) return this._hold(cmd, 'lining up a shot on a blocker');
    const st = cmd.state;
    // RELEASE VALVE: a sieger holding a target it is sitting OUTSIDE its own weapon range of
    // is doing nothing but waiting to be shot — it cannot fire from here, so no amount of
    // patience helps. Nothing else in the loop ever revisits that stand, so a unit could hold
    // one for a whole match at full ammo (survey: 48 of 74 such stretches never fired a shot).
    // Give the position up and re-pick: try the next bearing, or start the geometry fresh.
    if (aiStandRelease && st === 'suppress' && view.threat) {
      const reach = SHOT_REACH[v.type] || 42;
      const tD = Math.hypot(view.threat.x - v.holder.position.x, view.threat.z - v.holder.position.z);
      // Trading fire means it IS working — only an idle gun counts as held-out-of-reach.
      const firing = (performance.now() - (v._lastFireT || -1e9)) < 2000;
      // …and a unit still MARCHING in is out of range for the whole approach — releasing it
      // then just drops a good stand mid-trek and churns (seed 200 tripled, seed 25 +55%).
      // Only a unit that is out of range AND no longer CLOSING is genuinely stuck: latch the
      // range when the clock starts, and zero it the moment the unit makes real progress in.
      const closing = v._oorRefD != null && tD < v._oorRefD - 8;
      if (tD > reach && !firing && !closing) {
        if (!v._oorT) v._oorRefD = tD;
        v._oorT = (v._oorT || 0) + dt;
      } else { v._oorT = 0; v._oorRefD = tD; }
      if (v._oorT > STAND_RELEASE_S) {
        v._oorT = 0;
        this._stand2 = null;
        this._nav.path = null;
        // Held a position outside our own weapon reach: the spot is wrong for this chassis. Drop
        // the plan's cached spot for THIS tower and re-solve it once (the ladder will try a closer
        // radius); if nothing works, the kill order moves on. No bearing-walk, no per-tick search.
        this._resolveStand(v, 'sat outside our own reach');
        aiLog(this.team, `${this.cname}: Been sat outside my own range of that target — picking a new firing position.`);
      }
    } else if (v._oorT) v._oorT = 0;
    let dest = null, slack = 9;
    // Use the RESOLVED goal the brain is acting on (view.goal already folds in the shield-grab
    // and intercept detours), not the raw mission objective — else a ground unit's A* steers it
    // to the patrol/objective spot while it claims to be "grabbing a shield" and never gets there.
    if (st === 'advance') dest = view.goal || this.strategy.objective(this);
    else if (st === 'pursue') dest = v.ai.lastSeen || this.strategy.objective(this);
    else if (st === 'resupply') dest = this._supply;       // nearest fuel/ammo (own base or a depot)
    else if (st === 'assault') { dest = this.strategy.objective(this); slack = (view.engageRange || 36) * 0.7 * 1.25; }
    // SUPPRESS far-travel: the trek TO a siege standoff can be 100u+ around terrain, and pure
    // direct-steer + dodge feelers left jotuns shuttling between two spots for whole matches
    // (richwatch: stagnant 30s+ at gd 75-185 in suppress). Path-follow with A* until close,
    // then hand the final approach + the fire ladder back to the behavior. NAV_ASTAR_STATES
    // stays without 'suppress' — the nav overlay treats the close-in fight as combat-steered.
    // THE 26u HANDBACK IS GONE (aiStandRoute). The route used to stop 26u short and hand the last
    // leg to direct steer + dodge feelers — and that last leg is the whole point of a firing
    // position. Measured over six seeds, 7425 driving ticks fell through here with no order at
    // all, 52% of them still 14u+ out; it is the single biggest hole in the nav ledger after the
    // Valkyrie (which needs no route). It is also the same bug as the 70u split deleted from this
    // very branch: a bare distance test that swaps WHO IS DRIVING mid-journey. The fire ladder
    // never needed this — the brain keeps cmd.fire regardless of who owns the pedals.
    else if (st === 'suppress' && view.threatStand
             && (aiStandRoute
                 || (view.threatStand.x - v.holder.position.x) ** 2 + (view.threatStand.z - v.holder.position.z) ** 2 > 26 * 26)) {
      // ONE DESTINATION, ONE ROUTE. There used to be a 70u split here: beyond it the unit drove
      // to the MISSION OBJECTIVE, inside it to the firing spot. Two stable destinations far apart,
      // chosen by a bare distance test recomputed every tick — so a unit hovering at the boundary
      // committed to a 60u journey, was told one step later it was on the wrong journey, and
      // committed to the opposite one. The routes could leave in opposite directions around an
      // inlet. Measured: 77% of all goal movement in suppress was these swaps, median 68u, one at
      // 285u; the code's own comment recorded a unit frozen at the boundary for 400s.
      //
      // The split existed because the firing spot would not hold still at long range — it was a
      // formula off the unit's own position, so it slid as the unit moved. That is fixed at
      // source now (the keep gets a real committed stand like a tower's), so there is nothing
      // left for the boundary to protect against and it is DELETED rather than tuned. Widening it
      // would only have made a unit flip less often toward a destination still sliding out from
      // under it. The destination changes on new INFORMATION — a tower seen, a tower shooting at
      // us, the target re-scored — never on how far we have driven.
      const d2s = (view.threatStand.x - v.holder.position.x) ** 2 + (view.threatStand.z - v.holder.position.z) ** 2;
      // ARRIVE ON THE SPOT, NOT NEAR IT (Jacob). The standoff solver does real work to pick this
      // point — in range but not needlessly close, on land, out of crossfire, and vetted with an
      // actual path check. Handing back 14u short throws that away: 14u is a third of a Jotun's
      // reach, enough to sit outside the range the spot was chosen for, or inside the danger band
      // it was chosen to avoid. If the position is worth solving for, it is worth driving to.
      //
      // This costs nothing in settling behaviour, which was the original reason for a wide radius:
      // the driver already clamps its final leg to 2u regardless of what the order asks for, so
      // the hull eases in the same way it always did. All this number decides is how close the
      // unit gets before navigation hands the pedals back to the firing footwork.
      dest = view.threatStand; slack = aiStandArrive ? STAND_ARRIVE : 14;
      this._destIsStand = true;
      dlog(`suppressStand:${this.team}`, { unit: v.type, distU: +Math.sqrt(d2s).toFixed(0) },
        `${this.cname} ${v.type}: routing to its firing position, ${Math.round(Math.sqrt(d2s))}u out.`);
    }
    else {
      if (st === 'unstick') {
        this._nav.path = null;   // drop the route so it replans fresh after the jolt (not straight back into the wall)
        // JOLT ESCALATION: the reverse-pivot used to loop forever (reverse, drive back into
        // the same snag, reverse…) because the backward hop counts as movement and resets
        // _stuckT — so the 6s blacklist below never fired. Second jolt in one episode means
        // the reflex isn't working: blacklist the snag NOW and let A* route around it.
        if ((v.ai._unstickN || 0) >= 2) {
          const hx = -Math.sin(v.heading), hz = -Math.cos(v.heading);
          avoidCell(v.holder.position.x + hx * VEH_R, v.holder.position.z + hz * VEH_R);
          v.ai._unstickN = 0;
        }
      }
      // Suppress is the biggest hole in the ledger, so name WHICH of its two ways of falling
      // through happened: no firing position to drive to at all, or one we're already near.
      if (st === 'suppress') {
        const ts = view.threatStand;
        const dS = ts ? Math.hypot(ts.x - v.holder.position.x, ts.z - v.holder.position.z) : -1;
        this._navBail = !ts ? 'suppress:nostand'
          : dS < 6 ? 'suppress:d<6' : dS < 14 ? 'suppress:d6-14' : dS < 20 ? 'suppress:d14-20' : 'suppress:d20-26';
      } else if (st === 'unstick') return this._jolt(cmd, st);   // the reverse-pivot IS the order
      else this._navBail = 'nobranch:' + st;
      return;   // engage/suppress: steer as-is
    }
    if (!dest) { this._navBail = 'nodest:' + st; return; }
    // Every dest above is a raw coordinate out of a mission or a memory, and none of that code
    // ever asked whether this hull could stand there. Snap it onto ground the unit can actually
    // reach (nearestDrivable). One place rather than per-mission: the missions all have the same
    // blind spot, and the last time a fix like this lived in one branch, the other branch kept
    // the bug for months. A no-op on a single connected landmass — which is the normal case —
    // it earns its keep on the goal over open water or on an islet, where the unit used to drive
    // at the sea and grind on the beach until the watchdog scuttled it.
    // …but NOT for a flyer. Both of these snap a goal onto ground a hull can stand on, which is
    // exactly wrong for a unit that hovers: it would drag a Valkyrie's goal ashore off the water
    // or off the wall it is perfectly entitled to sit above. "Reachable" for a flyer is anywhere.
    if (!flyer) {
      dest = nearestDrivable(v, dest.x, dest.z);
      // …then off any cell this hull could never occupy. Landmass first (which island), structures
      // second (where on it), so the answer that comes out is standable.
      dest = standableGoal(v, dest.x, dest.z);
    }
    const d2 = (dest.x - v.holder.position.x) ** 2 + (dest.z - v.holder.position.z) ** 2;
    // ARRIVED. Not a fall-through: the unit is where the order sent it, and standing there is
    // the point. An explicit hold says so, and keeps 'no order' meaning 'bug'.
    if (d2 < slack * slack) return this._hold(cmd, 'arrived — ' + st);
    // ESCALATION: when a unit has been genuinely stuck a long time (the local jolt + the
    // routine replan didn't break it), the PATH itself is the problem — it keeps routing
    // back into the same spot. So mark that spot impassable for a few seconds and replan
    // a REAL way around it. This preserves a valid, obstacle-avoiding route (the old "skip
    // ahead N nodes" just aimed at a far waypoint in a straight line, cutting across
    // everything the path was avoiding — turning a good path into a bad one).
    if (this._stuckT > NAV_BLOCK_AFTER || this._netStuck) {
      const hx = -Math.sin(v.heading), hz = -Math.cos(v.heading);
      avoidCell(v.holder.position.x + hx * VEH_R, v.holder.position.z + hz * VEH_R);   // the obstacle right at the nose
      this._nav.path = null;                         // force a replan that routes around it
      this._stuckT = Math.min(this._stuckT, NAV_BLOCK_AFTER * 0.4);   // back off the timer (don't re-fire every tick; re-escalate if still stuck)
      if (this._netStuck) {
        // Terrain wedge the feelers can't see (see the net-progress watchdog): a replan
        // alone won't free a hull that's physically ground on a slope — back it off with a
        // reverse-pivot first (alternating sides each episode), THEN drive the fresh route.
        this._netStuck = false;
        this._joltT = 1.4;
        this._joltSide = ((this._joltN = (this._joltN || 0) + 1) % 2) ? 1 : -1;
      }
    }
    if (this._joltT > 0) {   // reverse-pivot out of the wedge, then hand back to the route
      this._joltT -= dt;
      cmd.fwd = -0.8; cmd.turn = this._joltSide || 1;
      if (v.ai) v.ai._wantMove = true;
      return this._jolt(cmd, st);
    }
    // The DRIVER takes it from here: the state's resolved destination becomes a standing
    // GOTO order; the driver route-follows it (same A* cache) and reports the contract
    // violation if the goal turns out unreachable. Returns true = the driver owns motion.
    // A GOAL THE DRIVER ALREADY PROVED UNREACHABLE stays unreachable until the map changes, so
    // re-issuing it is exactly how a unit ends up parked at the end of a partial route until the
    // driver scuttles it. If this state's goal was capped earlier, steer to the capped point — the
    // closest ground the unit can actually stand on — instead of the impossible one. The cap is
    // tied to _navEpoch, so a wall coming down or a gate opening clears it and the real goal is
    // tried again; it also ages out on its own.
    const rcap = this._reachCap;
    if (rcap && aiReachArrive && rcap.by === st && rcap.epoch === _navEpoch
        && this._matchT - rcap.t < REACHCAP_TTL) { dest = { x: rcap.x, z: rcap.z }; }
    else if (rcap && (rcap.epoch !== _navEpoch || this._matchT - rcap.t >= REACHCAP_TTL)) this._reachCap = null;
    const isStand = this._destIsStand; this._destIsStand = false;
    const ord = this._driver.order({ type: 'GOTO', x: dest.x, z: dest.z, arrive: slack, by: st });
    const s = this._driver.tick(dt);
    // HANDLE "NO" — the driver reported this goal unreachable; the ISSUER reacts instead of
    // letting the unit walk a partial route into a soft-lock (the top violation issuers from
    // the tournament breakdown, handled at their source):
    if (ord.violated && !ord._handled) {
      ord._handled = true;
      if (st === 'pursue' && v.ai && v.ai.lastSeen) {
        // The ghost is across water/walls — no route will ever get there. Write the contact
        // off; the state collapses back to the mission next think instead of chasing forever.
        // Record WHERE we couldn't get to as well: clearing lastSeen alone is futile while we
        // can still SEE the target, because perception rewrites it next tick and we end up
        // re-deciding this every single frame (see `pursuing` in AI.js — the dancing lurchers).
        v.ai.noReach = { x: v.ai.lastSeen.x, z: v.ai.lastSeen.z, t: v.ai.t };
        v.ai.lastSeen = null;
        aiLog(this.team, `${this.cname}: Can't reach that last contact — writing it off, back to the plan.`);
        this._navBail = 'unreach:pursue';
        return;
      }
      if (isStand && this._siegePlan) {
        // The driver refused the planned firing spot. The plan vetted it with a real path check,
        // so this means the world changed under us (a wall went up, a route closed). Don't walk
        // the bearing and re-plan per tick like the old _standRot search — drop THIS tower's
        // cached spot, re-solve it once through the relaxation ladder, and if it still can't be
        // reached, move down the kill order.
        this._resolveStand(v, 'the driver refused the spot');
        this._nav.path = null;
      }
      // EVERY OTHER ISSUER — chiefly `advance`, which produced 69 of the violations in a 40-match
      // run and had no listener at all. The driver latched the violation, logged "the ORDER is the
      // bug", and nobody revised anything: the unit walked its partial route to the end, stood
      // there re-issuing the same impossible GOTO, and the driver scuttled it 15s later. That is
      // most of the 17 scuttles per 40 matches, 96% of them Lurchers stopped at a shoreline.
      // An objective is not optional the way a pursuit contact is, and it has no alternative spot
      // the way a firing position does — so the answer is neither "write it off" nor "re-solve".
      // The unit is already standing at the closest reachable point to it; treat THAT as arrival
      // so the mission proceeds from there, instead of failing to reach something forever.
      else if (aiReachArrive && !isStand && st !== 'pursue') {
        const p = this._nav && this._nav.path;
        const end = p && p.length ? p[p.length - 1] : null;
        if (end) {
          this._reachCap = { x: end.x, z: end.z, t: this._matchT, by: st, epoch: _navEpoch };
          aiLog(this.team, `${this.cname}: ${v.type} can't reach (${Math.round(dest.x)},${Math.round(dest.z)}) on ${st} — `
            + `holding at the closest ground we can actually stand on and carrying on from there.`);
        }
      }
    }
    if (!s) { this._navBail = 'noroute:' + st; return; }   // no route — keep the brain's command
    cmd.fwd = s.fwd; cmd.turn = s.turn; cmd.strafe = s.strafe || 0;   // nav owns the motion (omni chassis translate immediately)
    v.ai._wantMove = s.fwd > 0.3 || Math.abs(s.strafe || 0) > 0.3;    // keep the anti-wedge motion check honest
    return true;
  }

  _runnerlessWatch(dt) {
    const open = this.fortDown() || this.flagExposed();          // their base is cracked
    const runners = (this.roster.firebrat || 0) + (this.unit && !this.unit.dead && this.unit.type === 'firebrat' ? 1 : 0);
    const stuck = open && runners === 0 && !this.canAfford('firebrat')
      && !this.nearestKnownScrap(0, 0) && this.explore.fraction() >= 0.8;
    if (!stuck) { this._runnerlessT = 0; return; }
    this._runnerlessT = (this._runnerlessT || 0) + dt;
    if (this._runnerlessT > 45 && !this._runnerlessAlarmed) {
      this._runnerlessAlarmed = true;
      aiLog(this.team, `[NO-RUNNER ALARM] ${this.cname}: their base is open and we have no Firebrat, `
        + `${this.scrap()} scrap (need ${BUILD_COST.firebrat}), no salvage in sight. `
        + `Nothing we can do can win this match.`);
    }
  }

  update(dt) {
    this._matchT += dt;
    this._runnerlessWatch(dt);
    // Notify once the moment the enemy fleet is wiped — instead of a unit silently
    // wandering off to "chase the last seen enemy" that no longer exists.
    if (!this._enemyGoneAnnounced && this.enemyEliminated()) {
      this._enemyGoneAnnounced = true;
      aiLog(this.team, `${this.cname}: Their whole fleet's down — the field is OURS! All units, press the base!`);
    }
    // SCAN-ON-TRANSITION trigger (once per tick, team-wide): a tower we're sieging just fell, or
    // we just scored a kill. Flag a pending sweep for ONE eligible idle unit to pick up in
    // _scanUpdate — one loud event, one scan, not the whole team freezing in place.
    if (aiScan && sightCone) {
      const twr = this.turretsLive();
      if (this._scanPrevTwr != null && (twr < this._scanPrevTwr || this.kills > (this._scanPrevKills || 0))) this._scanPending = performance.now();
      this._scanPrevTwr = twr; this._scanPrevKills = this.kills;
    }
    this._syncSlots();
    for (let i = 0; i < this._slots.length; i++) { this._bind(i); this._updateSlot(dt); this._unbind(i); }
  }

  // One slot's tick — the pre-multi-unit update() body, run with the slot's record
  // BOUND onto `this` (see _bind). Only the LEAD slot advances the shared doctrine.
  _updateSlot(dt) {
    if (!this.unit || this.unit.dead) {
      if (this.unit && this.unit.dead) {
        this.deaths++;
        this.failStreak = (this.failStreak || 0) + 1;
        // REPEATED-SCUTTLE ALARM (Jacob: "better a loud alarm than a rare bug to diagnose").
        // Losing unit after unit on the same plan is the signature of a decision loop, and it is
        // exactly what he sat and watched for 4907s. Say so, once, with the numbers.
        // This counts CONSECUTIVE LOSSES WITH NOTHING TO SHOW — it is reset by any tour that makes
        // progress (below). It previously claimed "N units lost in a row on <mission>", which it
        // never measured: failStreak counts every death regardless of mission, and its only reset
        // lived in redraw(), which is gated on !this.archetype and so never runs for the archetype
        // commanders all teams use now. It was a monotonic death counter that fired once per team
        // per match in any match with four losses — ~27 per 30 — and could not respond to any
        // anti-repeat fix, while sitting in the tournament summary labelled "repeated-scuttle".
        if (this.failStreak === SCUTTLE_ALARM_N) {
          aiLog(this.team, `[LOSS ALARM] ${this.cname}: ${SCUTTLE_ALARM_N} units lost in a row with nothing to show`
            + ` (latest a ${this.unit.type}, on ${this.strategy.step}). The plans are not working and the losses are adding up.`);
        }
        this._lostRecentT = this._matchT;            // MissionScore: recent-death boosts Attack for a bit
        const lost = this.unit.type;                 // attrition: that vehicle is gone from the roster
        if (this.roster[lost] != null) this.roster[lost] = Math.max(0, this.roster[lost] - 1);
        // MISSION REPORT CARD: grade the tour that just ended. Progress = any kill, any real
        // damage to their base, or a hand on the flag. A total failure counts against the
        // mission that was RUNNING AT DEATH; two straight total failures ban it for a while
        // (missionBanned → the doctrine's FAIL_ALT unblocker) so the commander stops making
        // the same bad decision over and over.
        const rec = this._mrec; this._mrec = null;
        if (rec) this._noteTour(this._tourRecord(rec, 1, this._slotI));
        if (rec) {
          // WHICH MISSION IS THIS DEATH ABOUT? `strategy.step` is what the unit was DOING at the
          // instant it died, and for a unit that died badly that is almost never the plan that
          // got it killed — it is the errand it switched to in reaction (Flee, a top-up, a swap
          // trip). Grade the PRIMARY mission instead: the last real job it was out doing.
          // A re-task mid-flight moves the blame with it, deliberately — a decision replaces the
          // plan and is then committed to, so a runner re-tasked from capture onto siege and
          // killed there is a failure of the siege, not of the capture it was pulled off.
          const step = this.strategy.step;
          const primary = (aiMsnAttrib && this._primaryKey) || step;   // full directional key
          const bstep = primary.split('-')[0];                          // 'capture-left' → 'capture'
          // GRADE THE TOUR, DON'T PASS/FAIL IT. The old test forgave any tour that took 60hp off a
          // fort of roughly 1960 (four 340hp towers plus a 600hp keep) — about 3% — so siege was
          // very nearly incapable of failing its own report card, and the anti-repeat never bit it.
          // Measured: on seed 1025 NINE units died on siege and the success memory stayed
          // completely empty; across four seeds siege took 32 of 39 deaths while the worst any key
          // reached was −4. That is why "[LOSS ALARM] 4 units lost in a row on siege" fires in
          // nearly every match.
          // Now the tour is worth what it achieved, in TOWER-EQUIVALENTS: a 340hp tower is 1.0, a
          // kill is worth half of one, a hand on the flag is 2. The −4 for losing the unit is
          // bought back in proportion, so a scratch recovers almost nothing and flattening a tower
          // recovers all of it. Gradual, per the house rule, instead of a cliff at 3%.
          const tourDmg = Math.max(0, rec.fort0 - fortHpOf(this.targetTeam()));
          const tourKills = Math.max(0, this.kills - rec.kills0);
          const ach = tourDmg / 340 + tourKills * 0.5 + (rec.flagTouched ? 2 : 0);
          const progress = aiGradedTour ? ach >= 0.5           // half a tower, or one kill
            : (this.kills > rec.kills0 || rec.flagTouched || tourDmg > 60);
          if (!this._missionSuccess) this._missionSuccess = {};
          // A tour that ACHIEVED something clears the streak — that is what makes the counter mean
          // "consecutive losses with nothing to show" instead of a running death toll. Its only
          // reset used to be redraw(), which never runs for archetype commanders.
          if (progress) this.failStreak = 0;
          const msnKey = aiMsnAttrib ? primary : (aiMsnDirKey ? this._msnKeyFor(step) : step);
          if (aiGradedTour) {
            const pen = Math.min(0, -4 + ach * 4);
            if (pen < -0.05) this._missionSuccess[msnKey] = pen; else delete this._missionSuccess[msnKey];
          } else if (!progress) this._missionSuccess[msnKey] = -4; else delete this._missionSuccess[msnKey];
          // BLAME THE CHASSIS, NOT JUST THE PLAN (Jacob, watching a 4907s match: a Lurcher
          // scuttled on siege over and over, then one Jotun cleared the towers in a single
          // mission). The memory above keys on the MISSION alone, so a plan that is right but
          // being attempted with the wrong vehicle gets benched wholesale — losing a good plan
          // instead of changing the tool. Track the PAIRING as well; _vehicleForMission reads
          // this and substitutes a different chassis before the mission itself is abandoned.
          if (!this._msnVehFail) this._msnVehFail = {};
          const vk = `${aiMsnAttrib ? bstep : step}|${lost}`;
          if (!progress) this._msnVehFail[vk] = (this._msnVehFail[vk] || 0) + 1;
          // A tour that DID make progress earns the chassis credit back — but only one tour's
          // worth. Deleting the whole record let a single good outing erase a run of failures,
          // so a chassis that fails this mission four times out of five never accumulated.
          else if (this._msnVehFail[vk]) this._msnVehFail[vk] = Math.max(0, this._msnVehFail[vk] - 1);
          if (!progress) {
            const fstep = aiMsnAttrib ? bstep : step;
            if (this._failStep === fstep) this._failN++; else { this._failStep = fstep; this._failN = 1; }
            this._failT = performance.now();
            if (this._failN === 2) {
              // Snapshot the battlefield the bench is supposed to change — the ban lifts on
              // PROGRESS against these, not on a timer (see missionBanned).
              this._failSnap = { twr: this.turretsLive(), fort: fortHpOf(this.targetTeam()), k: this.kills };
              aiLog(this.team, `${this.cname}: That's two units lost on this ${fstep} plan with NOTHING to show — we're trying something else!`);
            }
          } else if (this._failStep === (aiMsnAttrib ? bstep : step)) { this._failStep = null; this._failN = 0; }
        }
        // A runner died storming the base → don't just feed another firebrat in. If the enemy
        // still has DEFENDING VEHICLES, they'll intercept the fragile runner — send a combat
        // unit to CLEAR THEM FIRST (better signal than the death's damage-split, which mislabels
        // a mixed tower+vehicle kill). Only a pure tower gauntlet (no enemy vehicles) → sneak wide.
        // THE GATE THAT NEVER OPENED. This read strategy.step, which at a runner's death is
        // 'flee' far more often than 'capture' — the runner is chewed down on the approach, turns
        // for home, and dies on the way. Measured over 8 seeds: 13 of 15 runner deaths slipped
        // past this (step was 'flee' 12x, 'swap' 1x), so the escalating lane penalty, the
        // interceptor boost and the tower boost below have essentially never run. Ask the primary
        // mission instead — the job it was out doing, not the errand it died on.
        // (computed again rather than reused: the report card above lives inside `if (rec)`, and a
        // runner can die on a tour with no record — the gate still has to be right for those.)
        const runStep = (aiMsnAttrib && this._primaryKey) ? this._primaryKey.split('-')[0] : this.strategy.step;
        if (this.unit.type === 'firebrat' && runStep === 'capture') {
          const tt = this.targetTeam();
          const enemyHasUnits = combatants.some(o => !o.dead && o.team === tt && !vehicleHidden(o));
          this.strategy.onRunnerLost(this, enemyHasUnits);
          aiLog(this.team, enemyHasUnits ? `${this.cname}: Runner's down — they've got defenders! Clear them out first!` : `${this.cname}: Lost the runner — go quiet, we're sneaking the next one in wide!`);
        }
        // Keep losing the same way? Each repeat raises the odds of a brand-new plan — but
        // only for legacy deck commanders. An archetype keeps its doctrine (losing a unit
        // mid-siege shouldn't restart the whole plan from scratch); it just redeploys.
        if (!this.archetype && Math.random() < Math.min(0.85, 0.25 + this.failStreak * 0.2)) this.redraw();
      }
      this._endTour(this.unit);
      this.unit = null;
      this._rising = false;
      this.respawnT -= dt;
      // Respawn only while this slot is inside the cap — an overflow slot (cap shrank
      // under it) retires here instead of redeploying (_syncSlots prunes it once empty).
      if (this.started && !this._eliminated && this.respawnT <= 0 && this._slotI < this.unitCap()) { this.respawnT = 4 + Math.random() * 3; this.deploy(); }
      return;
    }
    // Did this unit ever actually GET there? The DRY-TRIP alarm only cares about units that
    // completed the drive — a unit killed in mid-field never had the chance to shoot a base.
    if (!this.unit._reachedEnemy) {
      const eb = this.enemyBasePos(), up = this.unit.holder.position;
      if ((up.x - eb.x) ** 2 + (up.z - eb.z) ** 2 < DRY_TRIP_R * DRY_TRIP_R) this.unit._reachedEnemy = true;
    }
    // Report card: a hand on the enemy flag at ANY point counts as progress (even if the
    // runner is later gunned down, the plan produced something — don't ban it).
    if (this._mrec && !this._mrec.flagTouched) {
      const f = this.flag();
      if (f && f.carrier === this.unit) { this._mrec.flagTouched = true; this._runnerLosses = 0; this._runnerInterceptT = null; }   // a runner reached the flag → the approach works, clear the escalating penalty
    }
    // Still riding the FOB lift up? Hold (no driving/firing) until it tops, then
    // detach so the brain takes the wheel — mirrors the player's deploy handover.
    if (this._rising) {
      if (this._elev && this._elev.rider === this.unit && this._elev.phase === 'top') {
        this._elev.rider = null; this._rising = false;
        this.unit._elevShieldUntil = performance.now() + ELEV_SHIELD_MS;   // anti-camp cover while it clears the mouth
        // POINT IT AT THE GATE AS IT ARRIVES (Jacob). The original problem was heavies "dancing on
        // the elevator" — topping out facing a wall, then grinding through a turn inside a walled
        // ring barely wider than their turning circle. The answer to that is to arrive already
        // lined up, not to bolt a forced exit waypoint onto the top of the priority ladder above
        // combat. Aligned, the unit just follows its A* route out like any other leg, and an enemy
        // camping the pad is answered by `engaging` like any other enemy.
        // ...but only when there IS a gate to thread. A unit that rose on a SATELLITE pad is
        // already outside the wall ring, so aiming it at a gate turns it back INTO the base.
        // `_planExit` carried this check and I dropped it when I deleted the forced exit.
        const fobC = teamCamp(this.team, 'fob');
        let ringed = true;
        if (fobC && this._elev) {
          const wallR = (FOB_SIZE / 2) * grid.cell + 2;
          const dd = (this._elev.center.x - fobC.center.x) ** 2 + (this._elev.center.z - fobC.center.z) ** 2;
          ringed = dd <= wallR * wallR;
        }
        const ex = ringed ? this._computeExit() : null;
        if (ex) {
          const v0 = this.unit, p0 = v0.holder.position;
          v0.heading = Math.atan2(-(ex.x - p0.x), -(ex.z - p0.z));   // model front is local -Z
          v0.holder.rotation.y = v0.heading;
        }
      } else { return; }
    }
    this.strategy.tick(this, dt);   // per-slot doctrine — this card is nobody else's to tick
    const v = this.unit;
    if (!v) return;
    const view = this._view(v, dt);
    // TRAP LURE: while baiting a chaser near our own mine cluster, the engage footwork kites
    // for this point (mines between us and them) instead of duel-strafing — strafe is blind
    // to mines, which is how a bait Lurcher once side-stepped onto its own trap.
    if (this.strategy.lurePoint) { const lp = this.strategy.lurePoint(this); if (lp) view.lure = lp; }
    const cmd = v.ai.think(view);
    const scanning = this._scanUpdate(v, view, cmd, dt);   // scan-on-transition: hold + sweep the surroundings before advancing
    v._aiState = cmd.state;                 // exposed so a rival's _view can tell this unit is retreating ("finish him")
    v._fleeing = this.strategy.step === 'flee';   // ...and that it has broken off for home (a rival reads this to press)
    v._msnStep = this.strategy.step;        // the mission behind the state — the status lamp needs the errand, not just the mode
    v._seesEnemy = !!view.seesEnemy;        // LIVE line of sight (the firing gate), not the 12s contact memory — the lamp pulses on this
    if (!this._driver) this._driver = new Driver(driverHooks);
    this._driver.bind(v, this._nav, this.team, this.cname);
    v._resvNav = this._nav;   // next tick's reservation stamp reads this unit's current route
    // Scanning is a DELIBERATE stop — hold position and sweep before advancing — so it gets a real
    // HOLD order rather than being skipped past the nav entirely and landing in the DIRECT bucket.
    const routed = scanning ? this._hold(cmd, 'holding to scan the surroundings')
                            : this._navOverride(v, view, cmd, dt);
    if (scanning && !routed) this._navBail = 'scan';
    const bailWhy = (!routed && !cmd.mnv) ? (this._navBail || '?') : null;
    if (bailWhy) navBail[bailWhy] = (navBail[bailWhy] || 0) + 1;
    // Episode clock: how long has this unit been driving with no order for THIS reason, unbroken?
    // AN EPISODE BELONGS TO A VEHICLE, not to a slot. The clock lives in the slot record, so
    // without this check a Valkyrie's episode stayed open across its own death and was closed out
    // stamped with the firebrat that replaced it — "186s, 0u net, firebrat, flyer", a duration and
    // a distance measured between two different vehicles. Same reset the Driver does on bind().
    if (v !== this._bailV) { this._bailV = v; this._bailWhy = null; this._bailT = 0; this._bailX = null; }
    if (bailWhy && bailWhy === this._bailWhy) this._bailT = (this._bailT || 0) + dt;
    else {
      noteBailEpisode(this._bailWhy, this._bailT || 0, v, this._bailX, this._bailZ);
      this._bailWhy = bailWhy; this._bailT = 0;
      this._bailX = v.holder.position.x; this._bailZ = v.holder.position.z;
    }
    if (!routed) {
      if (cmd.mnv) {
        // The brain picked a COMBAT MANEUVER (ORBIT/KITE — slice 3): hand the order to the
        // driver and let it drive; the brain keeps the fire decision (cmd.fire) and the
        // fallback pedals it computed (kept when the driver has nothing better).
        this._driver.order({ ...cmd.mnv, by: cmd.state });
        const ms = this._driver.tick(dt);
        if (ms) { cmd.fwd = ms.fwd; cmd.turn = ms.turn; cmd.strafe = ms.strafe || 0; }
      } else {
        // No order at all (close-in siege / lane-clear / jolt): the brain's own motor output
        // stands — the driver just observes it (recorder + watchdog stay hot under DIRECT).
        this._driver.order({ type: 'DIRECT', by: cmd.state });
      }
    }
    // UNREACHABLE SALVAGE bail: we committed to a scrap pile but A* found NO route to it (walled
    // off on a spit next to the base). Without this the brain just steers straight at it — nosing
    // into the wall forever (the nav line points through the wall). Blocklist the pile for a bit
    // and drop the detour so the unit goes back to its real job instead of grinding on the wall.
    if (this._scrapDetour && this._scrapTargetPile && !this._nav.path && this._nav.failT > 0
        && this._nav.dx === this._scrapTargetPile.pos.x && this._nav.dz === this._scrapTargetPile.pos.z) {   // the failed plan was to THIS pile (not a stale failT from another goal)
      this._scrapNoReach.set(this._scrapTargetPile, performance.now() + 8000);
      if (this._lootPile === this._scrapTargetPile) this._lootPile = null;
      this._scrapDetour = false; this._scrapTargetPile = null;
    }
    this._logTick(v, view, cmd);
    const out = burnFuel(v, { fwd: cmd.fwd, turn: cmd.turn, strafe: cmd.strafe || 0 }, dt);
    // (The anti-shore-grind reflex lived here and is gone. It cut a sinker's forward throttle when
    // it was pointed at deep water it could not cross — a guard against grinding the waterline,
    // written before the nav could be trusted to stop issuing goals across water. Jacob called it
    // a band-aid: "the solution isn't how to stop it from grinding, the solution is how to stop it
    // from being commanded into deep water." Gated over 240 seeds and he was right — removing it
    // is free: 240/240 resolved and 0 stalemates either way, nav alarms 46 both, scuttles 13 -> 12,
    // and transit-stuck 822 -> 559. It also fought the water-clearance halo, which deliberately
    // routes sinkers along the shallow fringe: exactly the condition it watched for.)
    const mineTurn = mineAvoidNudge(v);   // soft-steer around a spotted mine dead ahead (no A* block)
    if (mineTurn) out.turn = Math.max(-1, Math.min(1, out.turn + mineTurn));
    // CHASSIS GATE: treads don't sidestep. The Jotun was strafing in combat (the blocked-shot
    // sidestep never checked the chassis) — clamp here at the drive boundary so NO behavior,
    // present or future, can slide a vehicle its chassis can't slide.
    if (out.strafe && !v._move.strafe) out.strafe = 0;
    // FRIENDLY RIGHT-OF-WAY: an oncoming/crossing higher-priority friendly holds the ground
    // ahead → hold forward and let it clear (turn is kept, so it can still aim/rotate).
    // Zeroing fwd means the driver's watchdog reads "not trying to move" — a deliberate
    // yield never trips a pin/grind alarm.
    if (reservationYield(v) === 0) { out.fwd = 0; out.strafe = 0; v.ai._wantMove = false; v._yielding = true; Driver.yieldSamples++; }
    else v._yielding = false;
    // Flight recorder + net-progress watchdog: the driver observes the pedals that are
    // ACTUALLY about to drive the hull (post fuel-burn, post chassis gate, post yield),
    // whoever produced them. This is the alarm's data feed — one call per tick, at drive time.
    // "recently" (not just "this exact tick") since note() runs BEFORE this tick's own
    // fire decision below — last tick's shot (or this tick's, once it lands) both count.
    const firingNow = (performance.now() - (v._lastFireT || -1e9)) < 250;
    this._driver.note(dt, out,
      (view.blockedLeft ? 'L' : '·') + (view.blockedAhead ? 'A' : '·') + (view.blockedRight ? 'R' : '·'), firingNow);
    // AI OMNI (the Lurcher): fold the hull-relative motor output into a world vector and take
    // the player's driveOmni path — full-speed in ANY direction (no 0.7 strafe penalty, no
    // turning circle), hull cosmetically eases to face its travel, gyro-stabilized turret
    // holds its aim through the swing. A stationary pivot (aiming) stays on drive()'s turn.
    // TRAVEL STATES ONLY: driveOmni owns the heading (faces travel), which breaks combat's
    // contract — duel footwork strafes WHILE its `turn` keeps the nose (and fire gates) on
    // the enemy. Routing combat through omni made engage orbit without shooting (tournament:
    // engage-stuck ×2.4). Combat keeps classic drive() until the footwork becomes explicit
    // ORBIT/KITE maneuvers that manage facing themselves (the Driver design).
    const OMNI_STATES = { advance: 1, pursue: 1, retreat: 1, resupply: 1 };
    driveChassis(v, out, dt, v._move.omni && OMNI_STATES[cmd.state]);
    applyAltitude(v, dt);
    decayAim(v, dt);
    if (v.dead) { this._endTour(v); this.unit = null; this.respawnT = 4; this._rising = false; return; }
    v.cooldown -= dt;
    // Fire at the current target: a suppressed wall-turret (aimed at its raised head so
    // the slug arcs up). With NO clean line to it (a wall/HQ blocks the shot) a siege
    // unit aims LOW instead — at the obstruction — so the shell demolishes a path through
    // rather than arcing uselessly over the wall at a turret it can't reach.
    if (cmd.fire && v.cooldown <= 0) {
      let tp = null, atEnemy = false;
      if (cmd.state === 'suppress' && view.threat) {
        // REPAIR RACE: the tower we're shelling has a live repair crew ON it, healing it right
        // back up — a Valkyrie once emptied its whole magazine into that race and lost. Shoot
        // THE JEEP first: it's soft, it carries the spare-gun cargo, and with the medic dead
        // the tower stays down. Flyers lob over walls, so only ground shooters gate on LOS.
        let jeepTp = null;
        if (repairsOn) {
          for (const j of repairJobs) {
            if (j.team === v.team || j.jeepDest.dead) continue;
            if (Math.hypot(j.jx - view.threat.x, j.jz - view.threat.z) > 14) continue;   // crew not at THIS tower
            if (!isFlyer(v) && !hasLOS(v.holder.position.x, v.holder.position.z, j.jx, j.jz)) continue;
            jeepTp = _aimDir.set(j.jx, j.jeep.position.y + 1.0, j.jz).clone();
            break;
          }
        }
        tp = jeepTp || ((!view.threatLOS && view.demolishTarget)
          ? _aimDir.set(view.demolishTarget.x, view.demolishTarget.y, view.demolishTarget.z).clone()
          : _aimDir.set(view.threat.x, view.threat.y, view.threat.z).clone());
      }
      else if (view.enemy) { tp = leadAim(v.holder.position, view.enemy, v.def.soundIndex, v.ai.p.jitter).clone(); atEnemy = true; }   // lead a moving target (Lurcher/Valkyrie/Jotun; charge-compensated for the railgun)
      else if (cmd.breakAim) tp = _aimDir.set(cmd.breakAim.x, cmd.breakAim.y, cmd.breakAim.z).clone();   // blasting a blocker out of the way
      fireVehicle(v, false, tp, null, atEnemy);
    } else if (v.cooldown <= 0 && !view.enemy && v.ammo > 1) {
      // No fight on and the gun's idle: pot-shot any enemy REPAIR JEEP that happens to be in
      // range/arc/line — a target of opportunity, never a mission (the unit doesn't steer at
      // it, so it can't be lured off its actual job). Keeps the last round for real trouble.
      const jt = jeepShotTarget(v);
      if (jt) fireVehicle(v, false, _aimDir.set(jt.x, jt.y, jt.z).clone(), null, false);
      // TRAP SIGNAL SHOTS: the tender fires a spaced round down the lane — pure noise-bait
      // (gunfire carries; the sound-awareness layer draws listeners toward it). Throttled well
      // below the gun's rate so a whole magazine never goes into signalling.
      else if (this.strategy.signalShot && (this._signalCd = (this._signalCd || 0) - dt) <= 0) {
        const sp = this.strategy.signalShot(this);
        if (sp) {
          fireVehicle(v, false, _aimDir.set(sp.x, map.heightAt(sp.x, sp.z) + 1.2, sp.z).clone(), null, false);
          this._signalCd = 4.5;   // one bang every few seconds — a couple over the whole signal window
        }
      }
    }
  }

  // SCAN-ON-TRANSITION executor (see the SCAN comment): holds the unit still and sweeps its
  // look around once, before it commits to the next objective. Returns true while sweeping (the
  // caller then skips A* routing so the unit doesn't drive off mid-look). A visible enemy always
  // cancels it — the target is the priority. Lurcher spins its turret (cone = hull+turret angle
  // follows); the Jotun turns its whole hull (its 30° turret can't scan). Mutates `cmd` to hold.
  _scanUpdate(v, view, cmd, dt) {
    if (!aiScan || !sightCone) return false;
    if (v.type !== 'lurcher' && v.type !== 'jotun') return false;   // FB/Valk sit this out (no turret)
    const now = performance.now();
    if (view.seesEnemy) { v._scanT = 0; return false; }             // a target in sight is always priority
    const hold = () => { cmd.fwd = 0; cmd.strafe = 0; cmd.mnv = null; cmd.fire = false; cmd.state = 'scan'; v.ai._wantMove = false; v._aimHold = 0; };
    if (v._scanT > 0) {                                             // mid-sweep: advance it
      if (v.type === 'lurcher') {
        v.model.autoScan = false;
        v._scanYaw += v._scanDir * SCAN.rate * dt; v.model.aimYaw = wrapPi(v._scanYaw);
        v._scanSwept += SCAN.rate * dt;
        hold(); cmd.turn = 0;                                       // body stays put; only the turret sweeps
      } else {
        v._scanSwept += Math.abs(wrapPi(v.heading - (v._scanLastH ?? v.heading))); v._scanLastH = v.heading;
        hold(); cmd.turn = v._scanDir;                             // spin the heavy hull in place
      }
      if (v._scanSwept >= SCAN.arc || now - v._scanStart > SCAN.max * 1000) {
        v._scanT = 0; this._scanCd = now + SCAN.cool;
        if (v.type === 'lurcher' && v.model) { v.model.autoScan = true; v.model.aimYaw = 0; }   // hand the turret back to its idle sweep
      }
      return true;
    }
    // Start one? a pending loud-finish event, this unit's off cooldown, and it's a travel lull
    // (not carrying the flag / fleeing / resupplying — those never dawdle).
    const runner = this.flag && this.flag() && this.flag().carrier === v;
    const busy = cmd.state === 'capture' || cmd.state === 'resupply' || v._fleeing;
    if (this._scanPending && now - this._scanPending < 1000 && now > (this._scanCd || 0) && !runner && !busy) {
      this._scanPending = 0;
      v._scanT = 1; v._scanStart = now; v._scanSwept = 0; v._scanDir = 1;
      v._scanYaw = (v.model && v.model.aimYaw) || 0; v._scanLastH = v.heading;
      hold(); if (v.type === 'jotun') cmd.turn = v._scanDir;
      return true;
    }
    return false;
  }

  // STANDOFF (lab-validated): pick where to shell a tower FROM — the nearest spot the unit can
  // actually DRIVE to that's within firing range (falloff ok), has a line to the tower, and isn't
  // in any OTHER tower's range (no crossfire). Nearest live tower first; first tower with a valid
  // reachable spot wins. Commits lightly (holds while the tower lives + the spot stays valid) so
  // it isn't an A* every tick. Returns { threat, threatCamp, stand, w } or null (→ old keep/breach).
  // ── SIEGE PLAN ────────────────────────────────────────────────────────────────────────
  // Built ONCE when the siege mission is picked, from what the team KNOWS (knownTowers), not from
  // what a unit can see right now. A commander thinks: do I send a flyer around the back, or go in
  // the front? If frontal, which tower first? Then it plots the kill order and the firing spots.
  // Everything downstream reads this plan, so a sieger's target — and therefore its A* goal —
  // stays put instead of being re-elected every tick by whoever happens to be nearest (which is
  // what made the goal jump tens of units and burn a full-grid A* on every jump).
  //
  // Target choice (Jacob's doctrine): attack the front tower FURTHEST FROM THE ENEMY FOB. The FOB
  // is where their units spawn, so the far tower keeps us out of the crossfire between tower and
  // reinforcements, and gives us the longest look at anyone driving out to meet us.
  _buildSiegePlan() {
    // THE KEEP IS THE WIN CONDITION — the enemy FOB is a sideshow. plannableTowers() spans EVERY
    // enemy camp, so once the main fort's guns were down the plan simply advanced to the next
    // tower on its list, which sat at the FOB in the opposite direction. Measured on seed 74: red
    // flattened the main fort at t600, walked to the FOB, and shelled it until t900+ while the
    // keep it needed to crack sat at 594hp, undefended and ignored. Restrict the kill order to
    // the target camp; FOB guns are somebody else's problem (and `threatened` still answers one
    // that actually shoots at us).
    const towers = this.plannableTowers();
    if (!towers.length) return null;                       // nothing discovered yet — scout first
    const b = this._dirBasis(), fob = this.enemyFobPos();
    const side = k => (k.x - b.base.x) * b.fx + (k.z - b.base.z) * b.fz;   // >0 = rear, <0 = front
    const dFob = k => Math.hypot(k.x - fob.x, k.z - fob.z);
    const front = towers.filter(k => side(k) <= 2), rear = towers.filter(k => side(k) > 2);
    // Is the FOB sitting on our frontal approach? If it is, a front assault drives through their
    // spawn — that's a reason to favour the rear plan (the Valkyrie flank the deck already runs).
    const fobOnApproach = (fob.x - b.base.x) * b.fx + (fob.z - b.base.z) * b.fz < 0
      && Math.abs((fob.x - b.base.x) * b.lx + (fob.z - b.base.z) * b.lz) < 45;
    const mode = (this._siegeBack || (fobOnApproach && rear.length)) ? 'rear' : 'front';
    // Kill order: within the chosen face, furthest-from-FOB first; the other face follows so a
    // finished plan keeps going instead of stalling once its preferred side is flat.
    const pref = mode === 'rear' ? rear : front, rest = mode === 'rear' ? front : rear;
    // Within the chosen face, take the CLOSEST first (Jacob: "just kill whatever is closest").
    // The old order was furthest-from-FOB throughout, which is the right idea for picking WHICH
    // face to attack — it is still what `mode` decides — but a poor reason to walk past a nearer
    // gun once you are committed to that face.
    const order = [...pref.sort((A, C) => dFob(C) - dFob(A)), ...rest.sort((A, C) => dFob(C) - dFob(A))];
    // tries: how many times each tower's firing spot has been RE-SOLVED. The two escape hatches
    // below (held-out-of-reach, driver-refused) each said "re-solve it once" in a comment but
    // counted nothing, and a re-solve moves the answer enough to mint a fresh order, which resets
    // the per-order guard and lets it fire again next tick. Counting per TOWER is what makes
    // "once" true. See SIEGE_RESOLVE_MAX.
    // spotReach: the gun REACH each cached firing spot was solved for. A standoff is a property of
    // the gun, not just the tower — the ring is sized from SHOT_REACH/TURRET_HOLD — so a spot is
    // only reusable by a chassis whose gun is at least as long. See the read sites below.
    this._siegePlan = { order, idx: 0, mode, fobOnApproach, builtT: this._matchT, spots: new Map(), spotReach: new Map(), tries: new Map() };
    aiLog(this.team, `${this.cname}: Siege plan — ${mode === 'rear' ? 'flank and take the BACK towers' : 'frontal assault'}, ${order.length} tower(s) on the list${fobOnApproach ? ' (their FOB is on the front approach)' : ''}.`);
    return this._siegePlan;
  }
  // The tower this team is currently sieging, per the plan. Advances past towers we now know are
  // down. Rebuilds if the plan is empty//exhausted or new intel has arrived since it was drawn up.
  _planTarget() {
    // ENOUGH TOWERS — GO FOR THE KEEP. A runner can take the flag with FLAG_GRAB_TURRETS still
    // standing (Jacob: "a firebrat CAN easily grab a flag even if the two back towers are still
    // up"), so clearing the last two buys nothing and costs the whole midgame. Once the main
    // fort is down to that many, stop naming towers: returning null promotes the enemy KEEP to
    // the suppress target (see hqThreat), which is the actual win condition — crack it, the flag
    // is exposed, and the grab is on. Answering a gun that actually shoots at us still works;
    // that is `threatened`, not the siege plan.
    // …but the tolerance SHRINKS each time a runner dies to those guns (Jacob: "if siege goes out
    // again because the capture failed, it should go after another tower, not turn around because
    // two are already down"). First pass: leave two, crack the keep, send the runner. If towers
    // killed that runner, they have earned removal — leave one. Kill another, and we clear the
    // fort. So the shortcut is taken once on optimism and paid for in evidence, rather than being
    // a permanent refusal to finish the job.
    // (Once the keep IS cracked this guard lapses anyway — flagExposed() short-circuits it — so a
    // capture that fails AFTER the breach already sends siege back to the towers.)
    let p = this._siegePlan;
    const stale = p && this._matchT - p.builtT > 30 && p.order.length < this.plannableTowers().length;
    if (!p || p.idx >= p.order.length || stale) p = this._buildSiegePlan();
    if (!p) return null;
    while (p.idx < p.order.length) {
      const k = p.order[p.idx];
      const known = this.knownTowers.get(k.wall);
      if (known && known.armed) return known;              // still a live gun as far as we know
      p.idx++;                                             // we've seen it die — next on the list
    }
    return null;
  }
  // RE-PLAN ON RESUME. A support mission MOVES the unit: a duel drags it off its line, a refuel
  // trip sends it across the map. The primary mission it hands back to is unchanged and correct —
  // but the route and the firing-position commitment it left behind were both solved for a spot
  // the unit is no longer standing on, and they survive the mission switch because they live on
  // the slot rather than on the mission object.
  //
  // This is the FIGHT5 finding stated as code. Fight's cost was never its duration; five gates
  // measured it and the damage was displacement — assault-stuck 271 vs 26, and the worst offender
  // was a lurcher resuming a siege it had walked away from. Nothing was wrong with the plan; it
  // was being resumed with stale directions.
  //
  // Clearing _stand2 does NOT re-solve the tower (no _resolveStand call, so no attempt counted
  // against SIEGE_RESOLVE_MAX): the plan's solved spot stays in plan.spots, and the slot simply
  // re-commits to it and routes there from where it actually is.
  replanOnResume(from) {
    if (!REPLAN_MODE) return;
    if (REPLAN_MODE === 'fight' && from !== 'fight') return;
    if (this._nav) { this._nav.path = null; this._nav.t = 0; }
    if (REPLAN_MODE !== 'route') this._stand2 = null;
  }
  // A firing spot for ONE specific tower, with Jacob's relaxation ladder: try the ideal band, then
  // accept a longer shot (damage falloff, still inside shotReach), then a closer one (eat more
  // tower fire). CROSSFIRE IS NEVER RELAXED — standing where two guns reach you defeats the whole
  // point of a standoff. Returns {x,z} or null (and null is worth logging: see the caller).
  // ONE guarded way to re-solve a tower's firing spot, shared by both escape hatches (held out of
  // our own reach; driver refused the spot). Escalates instead of repeating: re-solve at most
  // SIEGE_RESOLVE_MAX times for a given tower, then move down the kill order. `why` names the
  // hatch so the alarm can say which one is looping.
  _resolveStand(v, why) {
    const plan = this._siegePlan; if (!plan) return;
    const k = this._planTarget(); if (!k) return;
    const n = (plan.tries.get(k.wall) || 0) + 1;
    plan.tries.set(k.wall, n);
    this._resolveN = (this._resolveN || 0) + 1;
    if (this._resolveN === SIEGE_RESOLVE_ALARM) {
      aiLog(this.team, `[SIEGE ALARM] ${this.cname}: firing positions re-solved ${SIEGE_RESOLVE_ALARM}x this match `
        + `(latest: tower at ${Math.round(k.x)},${Math.round(k.z)} — ${why}). The plan is thrashing, not adapting.`);
    }
    if (n > SIEGE_RESOLVE_MAX) {
      aiLog(this.team, `${this.cname}: That tower at (${Math.round(k.x)}, ${Math.round(k.z)}) has beaten ${SIEGE_RESOLVE_MAX} firing positions — leaving it and moving down the list.`);
      plan.idx++;
      return;
    }
    const again = this._standoffFor(v, k);
    plan.spots.set(k.wall, again);
    plan.spotReach.set(k.wall, SHOT_REACH[v.type] || 42);   // stamp the gun this answer was drawn for
    // A failed SOLVE is not the same as a failed TOWER. Advancing the kill order on the first
    // null threw away towers whose far side was reachable, and a siege that skips its list stops
    // being a siege (measured: resolution 19/20 -> 16/20). Let the attempt counter above decide
    // when to give up; a null just means "no spot yet" and the next attempt probes elsewhere.
    if (!again && n >= SIEGE_RESOLVE_MAX) {
      aiLog(this.team, `${this.cname}: There's not a good spot to shoot the tower at (${Math.round(k.x)}, ${Math.round(k.z)}) — moving to the next one.`);
      plan.idx++;
    }
  }
  // budget = how many REAL reachability searches this solve may run (was 40 cheap ones; now a
  // handful of thorough ones — see `reaches` below).
  // IS THE COMMITTED TARGET STILL WORTH HOLDING? Deliberately a short list — the point of
  // committing is that ordinary events do NOT release it. A target ends when it is destroyed,
  // when the mission that wanted it is over, or when the driver has proven we cannot get to the
  // firing spot. Being shot by something else, driving out of sensing range, or a nearer tower
  // appearing are all reasons to KEEP GOING, and each of them used to silently re-point the unit.
  // END OF A TOUR — the unit is leaving the field, whichever way. If it got all the way to the
  // enemy base and never pulled the trigger, that is a delivery route, not an attack, and nothing
  // else in the gate can see it: the unit isn't stuck, isn't lost, and its commander is picking a
  // perfectly sensible mission the whole time. Seed 1151's Lurcher ran that route ten times over
  // twenty minutes — 180u out, chewed to a quarter health by towers it never fired at, 180u home,
  // heal on the pad, go again, ammo 68/68 throughout.
  // Only missions whose job is to SHOOT something. A Firebrat on capture is supposed to drive in,
  // take the flag and run — it has no business trading shots, so counting it here measured
  // correct-by-design behaviour and drowned the signal: 12 of the first 19 dry trips were runners
  // on capture, and not one of them had touched the flag. That is a capture that failed on the
  // approach, which the mission report card already grades (no flag, no damage -> no progress ->
  // the mission takes its penalty). This alarm asks one question only: did a unit sent to FIGHT
  // arrive and not fight?
  static DRY_TRIP_MISSIONS = { siege: 1, 'siege-back': 1, attack: 1, defend: 1 };
  _endTour(v) {
    if (!v || !v._reachedEnemy || (v._shots || 0) > 0) return;
    if (!AICommander.DRY_TRIP_MISSIONS[(this.strategy && this.strategy.step) || '']) return;
    dryTripsTotal++;
    this._dryTrips = (this._dryTrips || 0) + 1;
    if (this._dryTrips === DRY_TRIP_ALARM) {
      aiLog(this.team, `[DRY-TRIP ALARM] ${this.cname}: ${DRY_TRIP_ALARM} ${v.type}s have now driven all the way to their base `
        + `and come back without firing a shot. We're running a bus route, not a war.`);
    }
  }
  // DOES THE KEEP STILL OUTRANK THIS GUN? Asked in two places — when the committed keep lock is
  // tested for release, and when target selection decides whether to promote back to the keep —
  // and it used to be two separate pieces of arithmetic that DISAGREED BY HALF A POINT.
  //
  // _tgtStillValid released the keep the moment any gun came within our reach. Selection then
  // re-promoted the keep, because the keep carried an incumbency bonus the tower did not:
  // (10 + 1.5) > (6 + 0 + 5). Release, re-promote, release — every tick. Watched live: twenty-nine
  // "Tower in reach — forget the keep, put it down first!" lines inside one second, while the
  // valkyrie shuffled between firing positions eight units apart and accomplished nothing. It is
  // also why seed 116's keeps died but its TOWERS never did, and nine runners then fed into guns
  // a committed sieger would have removed.
  //
  // ONE RULE, AND IT IS THE WHOLE SIEGE TARGETING POLICY (Jacob's, and it is much simpler than
  // what it replaces):
  //
  //   a gun inside our own reach outranks the keep — and if it is in our reach we may as well
  //   assume it is shooting at us, so there is nothing to remember about who fired last
  //
  // What that deletes: turretThreatBonus and its fade timer, PRIO.shooting, PRIO.recent, the
  // whole _hitByTurret targeting memory, and the keep-release clause in the target lock. Four
  // mechanisms whose only job was to answer a question this asks directly.
  //
  // The objection to it was mine and it was WRONG. I argued a sieger always has some gun in reach,
  // so the keep would never be shot and the flag never exposed — and an earlier attempt did
  // stalemate seed 116. But the geometry says otherwise: the tower ring sits ~28u from the keep,
  // so from a keep standoff a 42u gun reaches ONE tower and the survivors sit at 53-68u. Measured
  // across seeds 116/179/25: 1-2 towers in reach, never all four. The phase ends by itself —
  // kill the near guns, the far ones are out of range, the keep is what is left. Which is exactly
  // how Jacob described approaching a base, and the reason no extra clause is needed to end it.
  _keepOutranks(v, gx, gz, px, pz) {
    const d = Math.hypot(gx - px, gz - pz);
    return d > (SHOT_REACH[v.type] || 42);   // out of our reach → it is not our problem yet
  }
  _tgtStillValid(lock) {
    if (!lock || !this.unit || this.unit.dead) return false;
    if (lock.msn !== (this.strategy && this.strategy.step)) return false;   // the mission moved on
    // A LOCK CARRIES A FIRING SPOT, AND A FIRING SPOT BELONGS TO A GUN. The chassis changes under
    // a commander while the lock survives — recall, re-field, different vehicle — so a spot solved
    // for a Jotun's 80u gun gets handed to the Lurcher that replaced it. The siege plan's cache has
    // stamped the gun each spot was drawn for since 02f644e; the lock never did, and it is the same
    // bug wearing a different hat. Measured on seed 655: 307 decisions with a Lurcher parked 58u
    // from its target holding a 42u gun. A commitment we cannot act on is not a commitment.
    if (lock.spot) {
      const reach = SHOT_REACH[this.unit.type] || 42;
      if ((lock.spot.x - lock.x) ** 2 + (lock.spot.z - lock.z) ** 2 > reach * reach) {
        aiLog(this.team, `${this.cname}: That firing spot was picked for a longer gun — find one this ${this.unit.type} can shoot from.`);
        return false;
      }
    }
    // …with one exception, and it is the siege rule PRIO already encodes: "the keep is the top
    // priority, but a tower that is actually shooting at us outranks it" (tower 6 + shooting 10 >
    // hq 10). A GROUND unit cannot shoot a walled keep, so an HQ lock has no natural end, and the
    // gun grinding the unit down never becomes its target. Measured: a Valkyrie died on siege with
    // a live tower 48u away, clear line of sight, an 80u gun, a full magazine, and a turret hit
    // 0.3 SECONDS earlier — still pointed at the keep. The scorer would have picked the tower; the
    // lock never let it be asked.
    //
    // THE RELEASE IS DELIBERATELY NARROW, because a wider one was built, measured and thrown away.
    // The first version released on any turret hit and then went looking for a firing position,
    // which meant a fresh journey: fresh-set scuttles 1 -> 18 and nav alarms 7 -> 28, because a
    // new destination is a new chance to get stranded. This version only yields to a gun we can
    // shoot from EXACTLY WHERE WE STAND — no new route, no travel, nothing for the driver to fail
    // at. If it is out of reach we keep the keep and keep driving, which is the same answer the
    // old code gave and cost nothing to reach.
    // THE LOCK HOLDS FACTS, NOT OPINIONS. It used to carry a whole keep policy — release when a
    // gun is in reach, release when one has hit us recently and we can hit back — which is a
    // PRIORITY judgement, the exact thing the weights above decide, written a second time in
    // different words. Two hand-written copies of one judgement drift, and these drifted half a
    // point apart: the lock let go, the scorer put the keep straight back, twenty-nine times in a
    // second. (Jacob, from the symptom: "I don't really understand why there is a keep release. I
    // thought we had a system that used priority weights.")
    //
    // So the lock now only answers "is this target still a thing" — the keep is gone when the keep
    // is rubble — and _keepOutranks decides every tick what to shoot. The stickiness the lock was
    // invented for is not lost: the target is still committed between ticks, it is simply the
    // scorer that ends the commitment rather than a private rulebook.
    // THE KEEP IS NEVER LOCKED. A lock exists to stop a committed target being dropped on a
    // hair's-breadth change, and the keep needs no such protection: under the rule above it is
    // simply what we shoot whenever no gun is inside our reach, which is a fact about geometry and
    // does not flicker. Locking it was what required a release clause, and the release clause was
    // what disagreed with the scorer. No lock, no release, no disagreement.
    //
    // TOWERS still lock (below), and that is what "one at a time" means — a gun we have started
    // on stays the target until it is rubble, rather than swapping to whichever is nearest as we
    // drift around the ring.
    if (lock.hq) return false;
    if (lock.wall) { const t = lock.wall.turret; return !!(t && !t.dead && !t.falling); }
    return liveTurretNear(lock.x, lock.z);   // no object handle (a jeep, a raw point) — ask the board
  }
  _standoffFor(v, k, budget = 5) {
    const px = v.holder.position.x, pz = v.holder.position.z, flyer = v._move.ignoreWalls;
    const T = { x: k.x, z: k.z };
    const reach = SHOT_REACH[v.type] || 42, unitR = TURRET_HOLD[v.type] || 40;
    const minR = Math.max(24, unitR * STAND.band);
    // Other KNOWN live towers whose arcs we must stay out of (fog-honest: planned from intel).
    const others = this.plannableTowers().filter(o => o.wall !== k.wall)
      .map(o => ({ x: o.x, z: o.z, r: towerStats((o.wall.turret && o.wall.turret.upg) || 0).range }));
    const crossfire = (x, z) => others.some(o => (o.x - x) ** 2 + (o.z - z) ** 2 < o.r * o.r);
    // The per-spot tests that the flood fill does NOT answer: can the round get there, and is
    // some other tower covering the spot. (drivableTo is left in as a cheap early-out, but the
    // flood below subsumes it — it knows about walls and gates, not merely which island.)
    // Why a cell FAILS, not merely that it did. With the geometric fallback gone this is the only
    // answer there is, so when it comes back empty the alarm has to be able to say what ruled every
    // candidate out. (Jacob: "I don't want backup algorithms, I just want one that works" — and if
    // it doesn't work, a loud alarm and logs that show why.)
    const why = { scanned: 0, offIsland: 0, blocked: 0, noLOS: 0, crossfire: 0, unreachable: 0 };
    const spotOK = (x, z, needLOS, takeFire) => {
      if (flyer) return true;
      if (!drivableTo(v, x, z)) { why.offIsland++; return false; }
      if (v._blocked(x, z)) { why.blocked++; return false; }
      if (needLOS && !hasLOS(x, z, T.x, T.z)) { why.noLOS++; return false; }
      if (!takeFire && crossfire(x, z)) { why.crossfire++; return false; }
      return true;
    };
    // ARE WE ALREADY STANDING IN ONE? Every candidate below is a point on a ring around the
    // TARGET, so the unit's own position was never among them — a unit sitting in a perfectly
    // good firing position would still be sent on a journey to an equivalent one, and the journey
    // is where units get shot, wedged and re-decided. A decent spot you are already on beats a
    // better spot you have to travel to, and emphatically so under fire. It also needs no A*
    // probe: we are demonstrably able to be here, because we are here.
    const dHere = Math.hypot(px - T.x, pz - T.z);
    if (dHere >= minR && dHere <= Math.min(reach * 0.95, unitR * 1.25) && spotOK(px, pz)) return { x: px, z: pz };
    // SCAN THE WHOLE REACHABLE REGION, don't sample a ring. One flood fill (reachFrom) answers
    // "can this hull get there" for every cell at once, so the search can afford to look at all of
    // them and take the nearest good one — which is exactly what lab/standoff-lab.html does, and
    // why the lab reliably finds a spot where this used to abandon the tower. What it replaces:
    // 24 points on each of three or four fixed radii, of which only ~5 could be checked for
    // reachability at all (a full A* each, spread-filtered so they didn't all probe one arc), and
    // a 'unsure' fallback that accepted budget-truncated searches the driver then refused.
    //
    // The band is capped at reach*0.99 in EVERY tier: a firing position out of the gun's range is
    // not a relaxed answer, it is a wrong one (see the spotReach fix — a Lurcher parked 54u from a
    // tower with a 42u gun, arrived, in line of sight, unable to fire, scuttled for standing still).
    const R = flyer ? null : reachFrom(v);
    const cell = grid.cell, top = Math.min(reach * 0.99, unitR * 1.5);
    // A CLEAN LINE IS A PREFERENCE, NOT A REQUIREMENT. Demanding line of sight before accepting a
    // position rules out every cell behind a wall — which, for a tower inside a wall ring, is all
    // of them. Seed 1193 drew that exactly: the whole 25-38u band around a corner tower is inside
    // the compound or on ground the hull cannot reach, so the solver returned nothing and the unit
    // had no firing position at all. But the shooter already knows what to do without a line;
    // AI.js has carried this since long before today:
    //   "SIEGE FLATTEN: a ground unit with NO clean line on the tower doesn't circle forever
    //    hunting an angle — it PLANTS, squares onto the nearest WALL in the way, and blasts a path
    //    through, so it levels the far side too."
    // That code could essentially never run, because the solver refused to hand it a position from
    // which it would be needed. The solver demanded a line; the shooter is built to make its own.
    // (Jacob: "it should just shoot through a wall. Maybe having LOS shouldn't even be a
    // requirement. Make your own LOS.") So it becomes the last rung of the ladder that is already
    // here, not a second algorithm.
    //
    // AND NEITHER IS CROSSFIRE, for the same reason. Refusing every cell a second gun can reach
    // is the right DEFAULT — that is what a standoff is for, and the first three tiers still hold
    // it absolutely. But held as a veto it was answering "is this comfortable" when the question
    // is "can I shoot from anywhere at all", and the honest answer to the second is worth having
    // even when it is ugly. Measured once the tournament finally printed the alarm: 69 empty
    // solves per 30 seeds on the default set and 202 on the fresh one. Seed 25 is the shape of
    // all of them — 508 candidate cells, 203 thrown out for crossfire alone, no spot returned,
    // and a Lurcher that sat for a thousand seconds while its commander re-picked siege forever.
    // A Lurcher kills a tower in 3.2 seconds. Standing under two guns for 3.2 seconds to remove
    // one of them is a trade a person makes without thinking about it; sitting still for a
    // thousand seconds is not a trade at all.
    //
    // So it is the LAST rung and nothing above it changes: a spot out of the crossfire is always
    // preferred, including one with no line at all, because chewing through a wall is slow but
    // survivable while two arcs are neither. This tier only ever runs where the alternative was
    // returning null.
    const bands = [
      ['ideal', Math.max(minR, 12), Math.min(unitR, reach * 0.99), true, false],   // the comfortable one-gun spot
      ['relaxed', 12, top, true, false],                                  // anywhere with a line we can still shoot from
      ['through the wall', 12, top, false, false],                        // no line — bring the wall down and make one
      ['under their crossfire', 12, top, false, true],                    // nowhere safe — take the trade and shoot
    ];
    for (const [tier, lo, hi, needLOS, takeFire] of bands) {
      if (hi <= lo) continue;
      let best = null, bestD = Infinity;
      const iA = Math.floor((T.x - hi) / cell), iB = Math.ceil((T.x + hi) / cell);
      const jA = Math.floor((T.z - hi) / cell), jB = Math.ceil((T.z + hi) / cell);
      for (let i = iA; i <= iB; i++) for (let j = jA; j <= jB; j++) {
        const x = i * cell, z = j * cell;
        const dT = Math.hypot(x - T.x, z - T.z);
        if (dT < lo || dT > hi) continue;
        why.scanned++;
        if (R) { const k = navIdx(i, j); if (k < 0 || !R[k]) { why.unreachable++; continue; } }   // proven undrivable-to
        if (!spotOK(x, z, needLOS, takeFire)) continue;
        const dU = (x - px) ** 2 + (z - pz) ** 2;                          // nearest = least travel
        if (dU < bestD) { bestD = dU; best = { x, z }; }
      }
      if (best) {
        if (tier === 'relaxed') aiLog(this.team, `${this.cname}: No clean firing spot on the tower at (${Math.round(T.x)}, ${Math.round(T.z)}) — taking a less comfortable one.`);
        else if (tier === 'through the wall') aiLog(this.team, `${this.cname}: No line to the tower at (${Math.round(T.x)}, ${Math.round(T.z)}) from anywhere we can stand — planting anyway and blasting through the wall.`);
        else if (tier === 'under their crossfire') { standCrossfire++; aiLog(this.team, `${this.cname}: Every firing spot on the tower at (${Math.round(T.x)}, ${Math.round(T.z)}) is covered by another gun — taking the trade, get in and put it down fast.`); }
        return best;
      }
    }
    // NO SPOT — and now that means something much stronger than it used to. Every preference has
    // already been given up: line of sight, and then standing clear of the other guns. So this is
    // no longer "nowhere comfortable", it is "nowhere at all", and the only tests left that can
    // have rejected everything are physical ones — the cells cannot be driven to, are across
    // water, or are solid. If crossfire still dominates the tally below, the band itself is wrong.
    // Keyed by chassis as well as target: "no spot for a 42u gun here" and "no spot for an 80u gun
    // here" are different findings, and collapsing them would hide a real one.
    const _sfKey = `${this.team}|${Math.round(T.x)},${Math.round(T.z)}|${v.type}`;
    if (!standFailSeen.has(_sfKey)) { standFailSeen.add(_sfKey); standFails++; }
    this._standFail = { x: Math.round(T.x), z: Math.round(T.z), type: v.type, reach: Math.round(reach), ...why };
    if (!this._standFailAlarmed) {
      this._standFailAlarmed = true;
      aiLog(this.team, `[STANDOFF ALARM] ${this.cname}: no firing position on the target at `
        + `(${Math.round(T.x)}, ${Math.round(T.z)}) for a ${v.type} (reach ${Math.round(reach)}) — `
        + `not even one under their crossfire. `
        + `Of ${why.scanned} cells in the band: ${why.unreachable} can't be driven to, ${why.offIsland} across water, `
        + `${why.blocked} solid, ${why.noLOS} have no line to it, ${why.crossfire} sit under another gun.`);
    }
    return null;
  }
  // (_pickStandoff lived here: the per-tick standoff picker. Its target choice is now made once
  // per siege by _buildSiegePlan, and its spot search by _standoffFor. It also ran its own
  // budget of full-grid A* reachability checks OUTSIDE the frame budget, which is what turned a
  // re-pick into a 288ms frame. Both jobs now happen once per siege, not once per tick.)

  _view(v, dt) {
    const px = v.holder.position.x, pz = v.holder.position.z, h = v.heading;
    const flyer = v._move.ignoreWalls;
    this.explore.mark(px, pz, AI_VISION * 0.7);   // paint this patch of map "known" for the team's recon memory
    let seesEnemy = false, enemy = null, seen = null, nearestD = Infinity;
    const mySight = SIGHT[v.type] ?? 1;
    // Local-brawl headcount for the fight-or-flight weight: how many rivals vs friendlies
    // are within striking distance of THIS unit (so it breaks off a losing gang-fight and
    // presses when it has the numbers). Counted by proximity (LOS-independent — being
    // surrounded matters even if one foe ducks behind cover for a beat).
    let enemiesNear = 0, alliesNear = 0;
    const FIGHT_R2 = 48 * 48;
    // Where this unit is LOOKING for the sight cone: the turret's actual world bearing for a
    // turreted type (Lurcher/Jotun — reads the live mount angle, sweep and all), else the hull.
    const lookAng = (sightCone && v.model && v.model.turretGroup) ? h + (v.model.turretGroup.rotation.y || 0) : h;
    for (const o of combatants) {                       // nearest VISIBLE rival of any other team
      if (o.dead || vehicleHidden(o)) continue;          // a unit still down the lift shaft isn't on the field yet
      const d = (o.holder.position.x - px) ** 2 + (o.holder.position.z - pz) ** 2;
      if (o.team === this.team) { if (o !== v && d < FIGHT_R2) alliesNear++; continue; }
      if (d < FIGHT_R2) enemiesNear++;
      // Per-vehicle visual range: how far WE see + how far THEY show, averaged (see the SIGHT/VIS tables).
      let effR = AI_VISION * (mySight + (VIS[o.type] ?? 1)) * 0.5;
      // Sight cone: shrink the range by how far off our look direction the target sits (full
      // ahead, half at the flank, blind behind). Sound (below) still catches a rear flanker.
      if (sightCone) {
        const bearing = Math.atan2(-(o.holder.position.x - px), -(o.holder.position.z - pz));
        effR *= coneFactor(Math.abs(wrapPi(bearing - lookAng)));
      }
      // WHICH ONE DO WE POINT THE GUNS AT: nearest visible, and deliberately nothing cleverer.
      // Target priority (a flag carrier outranking a nearer hull) was built and removed — it can
      // only ever fire when two enemies are visible at once, and with one unit per team that
      // never happens, so it could not be gated and would have sat here untested. Revisit it if
      // multi-unit stops being the exception.
      if (effR > 0 && d < effR * effR && d < nearestD && (flyer || hasLOS(px, pz, o.holder.position.x, o.holder.position.z))) {
        nearestD = d; enemy = { x: o.holder.position.x, y: o.holder.position.y, z: o.holder.position.z, type: o.type, shield: o.shield, vx: o._vx || 0, vz: o._vz || 0,
          heading: o.heading, hpFrac: o.maxHp ? o.hp / o.maxHp : 1, retreating: !!o._fleeing || o._aiState === 'resupply' }; seen = o; seesEnemy = true;
      }
    }
    // Remember WHERE the enemy was last seen (team-shared) so the Attack mission can recall
    // their last-known position instead of only marching to the fixed elevator (ai_behavior).
    if (seen) {
      this._lastEnemyPos = { x: enemy.x, z: enemy.z, t: performance.now() }; this._noteContact(enemy.x, enemy.z);
      // …AND WHO IT WAS. _lastEnemyPos is a place, shared by three different senses (see below:
      // hearing and being shot at write to it too), so it can never answer "is my opponent dead" —
      // it does not know there was an opponent. The Fight mission needs that answer and nothing
      // else in the codebase could give it: view.enemy and ai._lastEnemyView are both flat COPIES
      // of the sighting, not the vehicle. This is the only live handle, and it is deliberately
      // written ONLY on a real sighting — never on a noise or an incoming round — so "the unit I
      // am duelling" cannot be reassigned by something the unit never saw.
      this._lastEnemyVeh = seen;
      this._lastEnemySeen = { x: enemy.x, z: enemy.z, t: performance.now() };
    }
    // HEARING: if it can't SEE a rival, it may still HEAR one — engine drone from movers +
    // gunfire reports, damped by its own engine noise (same model as the player's sound HUD).
    // A heard contact is intel, NOT a firing solution — it only updates the team's last-known
    // enemy position so the unit investigates the noise instead of staying blind. enemy/
    // seesEnemy stay line-of-sight, so it still has to round the corner to actually shoot.
    let heard = null;
    if (!seesEnemy) {
      let loudest = null;
      for (const s of soundSources(v)) if (!loudest || s.loud > loudest.loud) loudest = s;
      if (loudest && loudest.loud > AI_HEARD_MIN) {
        heard = { x: loudest.pos.x, z: loudest.pos.z, loud: loudest.loud };
        this._lastEnemyPos = { x: heard.x, z: heard.z, t: performance.now(), heard: true };
        this._noteContact(heard.x, heard.z);
      }
    }
    // SHOT AT: the third way to notice an enemy, and the only one that works from behind.
    // Sight is a forward cone and hearing is masked by our own engine, so a unit taking rounds
    // in the back could stay oblivious to a fight it was losing. A hit is the hardest contact
    // evidence there is — it outranks a heard contact (an engine drone is a guess about where
    // someone IS; a hit is proof of where someone SHOT FROM), so this is stamped after hearing
    // and overwrites it. Still intel, not a firing solution: seesEnemy stays false, so the unit
    // turns to look and must actually SEE the attacker before it can return fire.
    let shotFrom = null;
    if (!seesEnemy && v._hitByVeh && performance.now() - v._hitByVeh.t < 2500) {
      shotFrom = { x: v._hitByVeh.x, z: v._hitByVeh.z };
      this._lastEnemyPos = { x: shotFrom.x, z: shotFrom.z, t: v._hitByVeh.t, shot: true };
      this._noteContact(shotFrom.x, shotFrom.z);
    }
    // GHOST CLEARED: we reached the last-known spot and there's nobody here to see OR hear —
    // so the intel is spent. Drop it now instead of loitering over an empty spot for the full
    // 12s stale window (the "Valkyrie hovering over where a teammate died" idle). With it gone,
    // the Attack objective falls back to the enemy base and the unit pushes on.
    // A live shot contact is NOT spent — rounds are still landing on us, so keep it.
    if (!seesEnemy && !heard && !shotFrom && this._lastEnemyPos) {
      const dx = this._lastEnemyPos.x - px, dz = this._lastEnemyPos.z - pz;
      if (dx * dx + dz * dz < 12 * 12) this._lastEnemyPos = null;
    }
    // Same for the base-under-attack radio: the responder reached the spot and there's nobody
    // to see or hear → the raid's over (or the raider moved on); resume the patrol now instead
    // of standing on the crater for the full stale window.
    if (!seesEnemy && !heard && this._homeAttack) {
      const dx = this._homeAttack.x - px, dz = this._homeAttack.z - pz;
      if (dx * dx + dz * dz < 12 * 12) this._homeAttack = null;
    }
    // Fog-of-war intel: remember what the enemy keeps fielding so counterVehicle() works.
    if (seen) this.seenTypes[seen.type] = (this.seenTypes[seen.type] || 0) + 1;
    // DISCOVER nearby supply points — the team only "knows" a depot once one of its
    // units has come within sight of it (LOS for ground units; flyers see over walls).
    // Discoveries are remembered on the commander, so the team keeps the intel even
    // after this unit dies and a new one deploys. The shield generator is a TALL glowing
    // beacon, so it's spotted from much further off than a low fuel/ammo crate — a unit
    // out on the field sees it across the map (still needs LOS, so it's earned, not given).
    // That's what makes the flank generator actually get discovered + used.
    for (const rp of resupplies) {
      if (rp.dead || this.knownSupplies.has(rp)) continue;
      const sight = rp.kind === 'shield' ? AI_VISION * SHIELD_SIGHT_MULT : AI_VISION;
      const d2 = (rp.pos.x - px) ** 2 + (rp.pos.z - pz) ** 2;
      if (d2 < sight * sight && (flyer || hasLOS(px, pz, rp.pos.x, rp.pos.z))) this.knownSupplies.add(rp);
    }
    // Same fog-of-war for SALVAGE piles — a unit only "knows" a pile once it's seen it (so
    // scavenging is a scouting reward, not omniscient). Low debris → normal sight, LOS for ground.
    for (const p of scrapPiles) {
      if (p._gone || this.knownScrap.has(p)) continue;
      const d2 = (p.pos.x - px) ** 2 + (p.pos.z - pz) ** 2;
      if (d2 < AI_VISION * AI_VISION && (flyer || hasLOS(px, pz, p.pos.x, p.pos.z))) this.knownScrap.add(p);
    }
    // Same fog-of-war for the enemy's key STRUCTURES (its FOB/elevator + flag HQ): the
    // team only "knows" one once a unit has come within sight of it (tall towers carry, so
    // a wider sight than a crate; LOS for ground). Tracked for the known-POI log readout.
    {
      const bSight = AI_VISION * 2.0;
      if (!this.knownElev) { const e = this.enemyFobPos(); const d2 = (e.x - px) ** 2 + (e.z - pz) ** 2; if (d2 < bSight * bSight && (flyer || hasLOS(px, pz, e.x, e.z))) this.knownElev = true; }
      if (!this.knownFlag) { const e = this.enemyBasePos(); const d2 = (e.x - px) ** 2 + (e.z - pz) ** 2; if (d2 < bSight * bSight && (flyer || hasLOS(px, pz, e.x, e.z))) this.knownFlag = true; }
      // TOWERS: same earned-intel rule, same wide sight (a tower is a tall landmark). Re-seeing a
      // known tower REFRESHES it — that is how a rebuilt/re-gunned tower becomes news again, and
      // how a tower we watched die is recorded as rubble. A tower we haven't looked at since is
      // remembered exactly as we last saw it (stale intel is the point of fog-of-war).
      for (const c of camps) {
        if (c.team === this.team) continue;
        for (const w of c.walls) {
          if (w.type !== 'CORNER' || !w.turret) continue;
          const wx = w.group.position.x, wz = w.group.position.z;
          const d2 = (wx - px) ** 2 + (wz - pz) ** 2;
          if (d2 >= bSight * bSight || !(flyer || hasLOS(px, pz, wx, wz))) continue;
          const t = w.turret;
          this.knownTowers.set(w, { camp: c, wall: w, x: wx, z: wz, seenT: this._matchT,
            armed: !t.dead && !t.falling });   // "armed" = has a live gun; rubble/gunless is remembered but not planned against
        }
      }
    }
    // The set of points this team is aware of is read live into the log's per-team box
    // (a persistent status line), so it's no longer logged as a rolling event.
    let goal = this.strategy.objective(this);
    // DEFEND override (ai_behavior): if a rival is running off with OUR flag, abandon the
    // plan and chase the carrier toward its delivery point — so a stolen flag is always
    // contested. Skip it if WE'RE carrying the enemy flag (don't blow a winning run).
    this._intercepting = false;
    if (this.ourFlagStolen() && !(this.flag() && this.flag().carrier === v)) {
      const ip = this.interceptSpot();
      if (ip) { goal = ip; this._intercepting = true; }
    }
    // ATTACK prep (ai_behavior): a Lurcher/Valkyrie rolling out with little shield swings
    // by a KNOWN, nearby shield generator to armour up first. (Firebrats run — speed is
    // their armour; Jotuns siege — too slow to detour. Intercept always outranks this.)
    this._shielding = false; this._shieldGen = null;
    // ARMOUR UP IS A JOB, NOT A TICK-BY-TICK OPINION. `_shieldRun` used to be wiped to false here
    // and rebuilt from a bare `shield < 60%` test, so a unit at a generator UNDER FIRE — where the
    // recharge and the incoming rounds very nearly cancel — flipped its mind once a second: at 62%
    // "I'm fine" handed the unit to the next rule down (out of fuel), a round landed, and at 58%
    // armour outranked fuel again. Seed 1123: 145.8 shield gained against 138.9 lost over thirty
    // seconds, the fraction balanced on the 60% line, seventeen seconds of shuttling, tank run dry,
    // scuttled having got neither the armour nor the fuel. Trip on LOW, clear on FULL — the same
    // shape as the resupply latch next door, which never had this problem because it clears on
    // `resupDone`. See devblog/2026-08-05-one-mission-layer.md.
    const shieldable = !this._intercepting && (v.type === 'lurcher' || v.type === 'valkyrie')
      && v.maxShield > 0 && !(this.flag() && this.flag().carrier === v);
    const shFrac = v.maxShield > 0 ? v.shield / v.maxShield : 1;
    const gen = shieldable ? this.nearestKnownShield(px, pz) : null;
    const gd = gen ? Math.hypot(gen.pos.x - px, gen.pos.z - pz) : Infinity;
    // Detour distance scales with how EMPTY the shield is: a fresh unit (0 armour) will
    // go well out of its way to top up (×1.6), one already half-full barely diverts (×1).
    // So armour-capable units reliably swing by the generator on the way out, instead of
    // only grabbing it when it happens to be right next to them.
    const reach = SHIELD_GRAB_RANGE * (1.6 - shFrac);
    // Clear first, and clear on distance too: the latch outlives the vehicle in the slot record,
    // and a generator that was close to the LAST unit is not a commitment for this one.
    if (!shieldable || !gen || shFrac >= SHIELD_FULL || gd > SHIELD_GRAB_RANGE) this._shieldRun = false;
    // SECURE IT: once we're CLOSE, grabbing the armour beats shelling a fort — beeline the gen and
    // top up. Fixes the "went for the shield, then wandered off to a turret and never got it" bail.
    // shootGoal is already off while detouring, so it won't gun down its own generator on the way in.
    else if (!this._shieldRun && shFrac < SHIELD_WANT && gd < SHIELD_COMMIT) this._shieldRun = true;
    // The soft swing-by keeps its own gradual reach test, but a COMMITTED run holds the goal even
    // once the shield rises past the want line — otherwise the goal flickers even when the brain's
    // rung doesn't, which is the same bug one layer down.
    if (gen && (this._shieldRun || (shFrac < SHIELD_WANT && gd < reach))) {
      goal = { x: gen.pos.x, z: gen.pos.z }; this._shielding = true; this._shieldGen = gen;
    }
    if (this._shieldRun && !this._shieldRunOn) shieldBark(this, v, 'grab');   // announce the commit once
    this._shieldRunOn = this._shieldRun;
    // SALVAGE PICKUP — two ways a unit diverts to grab scrap. Shield/intercept always win.
    this._scrapDetour = false;
    this._scrapTargetPile = null;   // reset; set below to whichever pile we commit to (drives the unreachable-bail check)
    // 1) FRESH KILL loot (top scrap priority): grab the wreck we just made. It's right here and
    //    the local fight's over — but BAIL the moment another live enemy is close (back to the
    //    fight) or if it somehow drifted out of reach. wantsLoot() already applied the mood/RNG/
    //    mission gate when the pile was assigned; here we just honour a live loot order.
    if (this._lootPile && !this._shielding && !this._intercepting
        && !(this.flag() && this.flag().carrier === v)) {
      const lp = this._lootPile;
      const enemyNear = lp._gone ? false : combatants.some(o => !o.dead && o.team !== this.team
        && !vehicleHidden(o) && (o.holder.position.x - px) ** 2 + (o.holder.position.z - pz) ** 2 < 46 * 46);
      const d = Math.hypot(lp.pos.x - px, lp.pos.z - pz);
      if (lp._gone || lp.overWater || enemyNear || d > LOOT_RANGE || performance.now() > this._lootUntil) this._lootPile = null;   // collected / unreachable / re-engaged / too far / timed out → drop it
      else { goal = { x: lp.pos.x, z: lp.pos.z }; this._scrapDetour = true; this._scrapTargetPile = lp; }
    }
    // 2) OPPORTUNISTIC SALVAGE: swing over to a spotted scrap pile that's nearly on our path (free
    //    parts for the build bank). Short-range so it never drags a unit far off its real objective;
    //    skipped for the slow Jotun, capturers (a runner never stops), scavengers (their mission IS
    //    scrap), flag carriers, and while already detouring. A SIEGER used to be fully excluded —
    //    a Lurcher walked right past its dead teammate's pile mid-siege — but a pile a stone's
    //    throw from the path is free: it bends (tight SCRAP_SIEGE_RANGE), it doesn't detour.
    if (!this._scrapDetour && !this._shielding && !this._intercepting && v.type !== 'jotun'
        && this.strategy.step !== 'capture' && this.strategy.step !== 'scavenge'
        && !(this.flag() && this.flag().carrier === v)) {
      const reach = this.strategy.step === 'siege' ? SCRAP_SIEGE_RANGE : SCRAP_GRAB_RANGE;
      const sp = this.nearestKnownScrap(px, pz);
      if (sp && Math.hypot(sp.pos.x - px, sp.pos.z - pz) < reach) { goal = { x: sp.pos.x, z: sp.pos.z }; this._scrapDetour = true; this._scrapTargetPile = sp; }
    }
    if (this._scrapDetour && !this._scrapDetourOn) {   // announce the commit ONCE (false→true), like the shield grab
      aiLog(this.team, `${this.cname} ${v.type}: “Salvage on our line — grabbing it.”`);
    }
    this._scrapDetourOn = this._scrapDetour;
    // SNEAK ROUND THE SIDE (flag runner): a Firebrat headed for the enemy base swings WIDE to the
    // side-beach flank point first, then comes at the flag from the flank/back — instead of driving
    // up the middle road into the FOB's guns. Releases to the real objective once it's rounded the
    // flank (reached the point) or is already close (commit the grab). Never overrides the detours above.
    this._flanking = false;
    if (v.type === 'firebrat' && !this._intercepting && !this._shielding && !this._scrapDetour
        && !(this.flag() && this.flag().carrier === v)) {
      const enemyB = this.enemyBasePos();
      const goalToEnemy = Math.hypot(goal.x - enemyB.x, goal.z - enemyB.z);   // is its real goal the enemy base?
      const dEnemy = Math.hypot(enemyB.x - px, enemyB.z - pz);
      if (goalToEnemy < 70 && dEnemy > 70 && !this._flankDone) {
        const fp = this._flankPoint(v);
        if (Math.hypot(fp.x - px, fp.z - pz) < 22) this._flankDone = true;   // rounded the flank → now go for the flag (loose radius: the point sits on a beach lip)
        else { goal = fp; this._flanking = true; }
      }
    }
    // Where to rearm/refuel: the NEAREST valid source for what we need — own base
    // (always restocks fuel + ammo) OR a DISCOVERED neutral depot. A neutral depot gives
    // just ONE resource, so we only divert to one when topping it gets the unit combat-
    // ready (the OTHER resource is still OK enough to fight/move on — config fuelOK 0.25 /
    // ammoOK 0.5, matching the depot latch-clear). Only when BOTH are genuinely low does it
    // trek to base for the full top-off + heal — otherwise it tops the one thing the depot
    // offers, the latch (which still wants the other) stays stuck, and it camps the tank
    // forever (the "Jotun parked at a fuel supply" bug). NOTE: a unit that ran dry on AMMO
    // with HALF a tank used to be dragged all the way to base, because "low fuel" was set
    // at <0.5 — far above the point fuel actually needs topping. Now it grabs ammo at the
    // nearest depot and gets back in the fight, refuelling separately only if fuel gets low.
    const fob = teamCamp(this.team, 'fob'), home = teamCamp(this.team, 'main');
    const needAmmo = v.ammo < v.maxAmmo * 0.6;      // want to top ammo (config.ammoFull)
    const needFuel = v.fuel < v.maxFuel * 0.5;      // want to top fuel (config.fuelFull)
    const fuelOk = v.fuel >= v.maxFuel * 0.25;      // still enough gas to keep going (config.fuelOK)
    const ammoOk = v.ammo >= v.maxAmmo * 0.5;       // still enough rounds to keep fighting (config.ammoOK)
    let supply = null, bestD = Infinity, supplyHeals = false;
    // isBase = an OWN base (restocks fuel + ammo AND patches the hull); a depot does not.
    const consider = (x, z, isBase) => { const d = (px - x) ** 2 + (pz - z) ** 2; if (d < bestD) { bestD = d; supply = { center: { x, z } }; supplyHeals = isBase; } };
    if (fob) consider(fob.center.x, fob.center.z, true);
    if (home && flagBaseAlive(this.team)) consider(home.center.x, home.center.z, true);   // a levelled flag base resupplies no one
    // WHICH KIND OF SOURCE — the RUNNING MISSION says so. This used to be re-derived every tick
    // from raw levels, and because a depot raises the very level that chose it, arriving flipped
    // the choice to the other depot: seed 1193's lurcher shuttled 90u between the fuel dump and
    // the ammo dump for the rest of its life and was scuttled for making no net ground. Now
    // `refuel` routes to fuel and `rearm` routes to ammo, and the choice holds until the mission
    // ends — because the mission ends when the tank is FULL, not when it stops being empty.
    // With no supply mission running this is only a hint (it is read while the state is
    // resupply), so the old nearest-source derivation stays as the fallback.
    const want = (this.strategy && this.strategy.mission && this.strategy.mission.supplyWant) || null;
    const depotKind = (want === 'fuel' || want === 'ammo') ? want
      : want ? null                                     // 'base'/'shield' — a neutral depot can't help
      : ((needAmmo && fuelOk) ? 'ammo' : (needFuel && ammoOk) ? 'fuel' : null);
    if (depotKind) for (const rp of resupplies) if (!rp.dead && rp.kind === depotKind && this.knownSupplies.has(rp)) consider(rp.pos.x, rp.pos.z, false);
    this._supply = supply ? { x: supply.center.x, z: supply.center.z } : null;   // nav target while resupplying
    this._supplyHeals = supplyHeals;   // chosen supply is an own base → hold for a FULL top-off (ammo+fuel+hp)
    // HEAL home: HP only regenerates at an OWN base (a neutral fuel/ammo depot can't
    // patch the hull) — so a hurt unit must fall back HERE, not to the nearest depot,
    // or it camps a fuel tank forever waiting for health that never comes.
    let healHome = null, healD = Infinity;
    const considerHome = (x, z) => { const d = (px - x) ** 2 + (pz - z) ** 2; if (d < healD) { healD = d; healHome = { x, z }; } };
    if (fob) considerHome(fob.center.x, fob.center.z);
    if (home && flagBaseAlive(this.team)) considerHome(home.center.x, home.center.z);   // can't heal at a destroyed flag base
    this._home = healHome;
    // The nearest LIVE enemy wall-turret this unit can actually SHOOT — sensed wide
    // (TURRET_SENSE) so heavies snipe from outside the towers' own range, but ONLY
    // counted if there's a clear line to it. That LOS gate is the key: a unit no
    // longer wastes shots hammering the front wall trying to hit a tower behind it —
    // it picks the tower it can see (a near/flank corner), and as that one dies the
    // line to the next opens up. `flankSide` nudges the approach around to the side
    // instead of charging straight into the gap between two towers (see AI.js).
    let threat = null, threatCamp = null;
    // The SIEGE PLAN picks the target tower and its firing spot (see _buildSiegePlan): drawn up
    // once from the team's own intel, ordered furthest-from-their-FOB first, rear-face first when
    // the plan is a flank. SIEGE-BACK is folded into the plan's `mode`, so the old per-tick
    // rear-only filter is gone along with the raw nearest-turret scan it used to feed.
    let _tgtWhy = 'none';   // WHICH code path chose the target — for the re-selection autopsy
    const _br = { plan: false, inSense: false, promote: false };   // which branches were LIVE this tick
    let stand2 = null, stand2Ref = null;
    let hqThreat = false;
    let _tgtWall = null;   // the live wall/turret this target IS, for the are-you-still-there test
    // ── THE TARGET IS STATE, NOT A DERIVATION ────────────────────────────────────────────
    // Everything below used to run EVERY TICK from `threat = null`, so the target was whatever
    // the last branch to fire happened to write. Nothing carried a choice forward, which meant
    // nothing could re-select — and nothing could KEEP a selection either. Traced on seed 1011:
    // "shoot back" overwrote the plan's tower whenever a round had landed in the last 4s, so with
    // several guns firing the target changed with the incoming rounds (median hold 2s; 161 of 496
    // switches were gun-to-gun with neither gun destroyed). And a target 111u away vanished
    // outright because the sensing ring was 110u — one unit of driving deleted the intent.
    //
    // Now: SEE a tower, commit to it, execute; only release when it is genuinely over. The
    // machinery that existed to stabilise the per-tick rebuild (the sensing ring's 1.15 strobe
    // hysteresis, the 70u objective/standoff split, the sliding radial spot, the shoot-back
    // override) is all answering a question that is no longer asked.
    const _lock = this._tgtLock;
    const _locked = this._tgtStillValid(_lock);
    if (_locked) {
      threat = { x: _lock.x, y: _lock.y, z: _lock.z };
      threatCamp = _lock.camp; hqThreat = !!_lock.hq; _tgtWhy = _lock.why;
      if (_lock.spot) { stand2 = _lock.spot; stand2Ref = threat; }
      _br.locked = true;
    }
    if (aiStand2 && !_locked) {
      // THE PLAN owns the target. Not gated on the siege mission any more: `suppress` is entered
      // from ANY mission (the threatened transition — a tower is shelling us), and the old gate
      // meant every non-siege case fell through to a raw global nearest-turret scan with no
      // hysteresis, so the target flipped as the unit drove and the goal jumped with it.
      // NO KILL ORDER. The plan used to name WHICH tower to attack, and every ordering tried made
      // things worse: furthest-from-FOB first walked a Lurcher 94u past three live guns to a
      // corner tower with no solvable firing position (seed 1193), and nearest-to-us first pulled
      // sieges sideways onto flank guns — 30 seeds x2: nav alarms 33 -> 59, GOTO violations
      // 70 -> 136, transit-stuck 250 -> 543, for no resolution gain.
      //
      // Jacob's model, and it needs no ordering at all: head for the flag HQ, and kill whatever
      // threatens you on the way. The keep is the default target (PRIO.hq); a gun within our reach
      // outranks it (PRIO.inReach), which under the current rule is the whole of it: a gun inside
      // our reach is assumed to be shooting at us, so there is nothing else to weigh. The FOB's towers are our problem only when they are in the
      // way — which is exactly what "near enough to matter" means here.
      //
      // So the candidate is simply the nearest live gun we know about. The plan survives as the
      // firing-spot cache (spots/spotReach) and the front/rear face choice; it no longer steers.
      this._planTarget();   // side effect only: keeps _siegePlan built/fresh for its spot cache + face
      let k = null, _kd = Infinity;
      for (const q of this.plannableTowers()) {
        const d2 = (q.x - px) ** 2 + (q.z - pz) ** 2;
        if (d2 < _kd) { _kd = d2; k = q; }
      }
      // PROXIMITY GATE (do not remove): the plan says WHICH tower we intend to kill — it does NOT
      // say we are currently under threat. `threat` feeds AI.js's `threatened` transition, which
      // has no distance test of its own, so an ungated plan target put units into `suppress` over
      // towers on the far side of the map: a first cut of this change dropped resolution 20/20 →
      // 18/20 and TRIPLED suppress transit-stuck (units on intercept missions driving at a goal
      // 279u away). A tower can only threaten us from within sensing range; approach is the
      // mission's job, not suppression's. Hysteretic (1.15x hold) so a unit sitting near the ring
      // boundary doesn't strobe suppress/advance on its own jitter.
      const senseR = TURRET_SENSE * (this._suppressing ? 1.15 : 1);
      const inSense = k && (k.x - px) ** 2 + (k.z - pz) ** 2 <= senseR * senseR;
      this._suppressing = !!inSense; _br.plan = !!k; _br.inSense = !!inSense;
      // WHAT the plan names, and how far outside the sensing ring it is — recorded here, inside
      // _view, because `_planTarget()` reads the BOUND slot's plan. Asking the slot object for it
      // from outside an update returns undefined and reads as 'no plan at all'.
      if (k) { _br.planD = Math.round(Math.hypot(k.x - px, k.z - pz)); _br.senseR = Math.round(senseR); }
      if (k && inSense) {
        // CONFIRM THE TARGET YOU ARE SHOOTING AT (Jacob: "units should be able to see the target
        // they are shooting at — 80u doesn't sound that far to see a tower"). The general sight
        // sweep above only refreshes a tower when the unit happens to hold LOS to it during its
        // pass; a corner tower sits inside a fort ringed by its own walls, so from a standoff the
        // fort blocks the view of its own gun and the record never updates. A commander could
        // therefore shell a tower that died minutes ago — measured on seed 74: believedArmed=1
        // with actualTowers=0 for 400s, burning 40 rounds and never touching the HQ, because
        // `crack the keep` only applies once the plan is EMPTY and the ghost kept it occupied.
        // So: whenever the target is in sensing range AND we have a clear line to it — the same
        // line the firing spot was chosen for — believe our own eyes about whether it still has
        // a gun. No omniscience: this is exactly what the unit can see from where it stands.
        const kt = k.wall && k.wall.turret;
        if (kt && hasLOS(px, pz, k.x, k.z)) {
          const armedNow = !kt.dead && !kt.falling;
          const rec = this.knownTowers.get(k.wall);
          if (rec && rec.armed !== armedNow) {
            rec.armed = armedNow; rec.seenT = this._matchT;
            if (!armedNow) {
              aiLog(this.team, `${this.cname}: That tower at (${Math.round(k.x)}, ${Math.round(k.z)}) is already wrecked — scratch it, next target.`);
              this._siegePlan.spots.delete(k.wall); this._siegePlan.spotReach.delete(k.wall);
            }
          }
        }
        // The firing spot is computed ONCE per tower and cached on the plan — the expensive part
        // (A* reachability over candidate spots) now happens per SIEGE, not per tick. That is what
        // makes the relaxation ladder affordable and kills the replan storm at the same time.
        let spot = this._siegePlan.spots.get(k.wall);
        // …BUT A FIRING SPOT BELONGS TO A GUN, NOT JUST A TOWER. The ring _standoffFor searches is
        // sized from this chassis's SHOT_REACH and TURRET_HOLD, so a spot solved for a long gun can
        // sit outside a short one's reach entirely. The cache is keyed by wall alone, and the
        // commander re-fields whatever the roster has — so a Valkyrie's standoff was being handed
        // to the Lurcher that replaced it. Seed 1053: the plan cached a spot 54u from the tower
        // (a Valkyrie reaches 80u); six consecutive Lurchers, 42u guns, drove out to it, arrived
        // with a clean line and full ammo, could not fire a single round, and were scuttled for
        // standing still — six identical 58-second lives, hull never scratched. Re-solve when our
        // gun is SHORTER than the one this spot was drawn for; a longer gun inheriting a close
        // spot still reaches, so that direction costs nothing and keeps the search rare.
        const myReach = SHOT_REACH[v.type] || 42;
        const forReach = this._siegePlan.spotReach.get(k.wall);
        if (spot !== undefined && forReach != null && forReach > myReach) spot = undefined;
        if (spot === undefined) {
          spot = this._standoffFor(v, k);
          this._siegePlan.spots.set(k.wall, spot);   // null is cached too: don't re-search a hopeless tower every tick
          this._siegePlan.spotReach.set(k.wall, myReach);
          // …AND THE CACHE ONLY HOLDS IF THE PLAN DOES. This used to advance the kill order on the
          // first null, which looked harmless and was the opposite: idx runs past order.length,
          // _planTarget rebuilds, _buildSiegePlan allocates a fresh `spots` Map, and the null we
          // just cached is gone. Same tower, re-solved, forever. Measured on seed 1053: 98 failed
          // solves against ONE distinct target, which is most of a whole seed set's standFails.
          //
          // _resolveStand already learned this and says so in its own comment — "a failed SOLVE is
          // not the same as a failed TOWER", measured at resolution 19/20 -> 16/20 when it skipped
          // on the first null. It waits for its attempt counter. This path did not, and the two
          // have disagreed ever since. Now neither advances on a null: the cached null is what
          // stops the re-search, and _resolveStand's counter is what eventually gives up on the
          // tower. One rule, in one place.
          if (!spot) aiLog(this.team, `${this.cname}: There's not a good spot to shoot the tower at (${Math.round(k.x)}, ${Math.round(k.z)}) — leaving it cached as hopeless for now.`);
        }
        if (spot) {
          const ty = map.heightAt(k.x, k.z) + 5;
          threat = { x: k.x, y: ty, z: k.z }; _tgtWhy = 'siege-plan tower'; _tgtWall = k.wall; threatCamp = k.camp; stand2 = spot; stand2Ref = threat;
        }
      }
    }
    // KILL THE KEEP: the flag HQ is a first-class siege target, not a last resort. The flag only
    // exposes when the HQ building falls, so hoarding it until all four turrets are dead is what
    // stalls a siege forever. Whenever a siege unit has a CLEAN LINE to the enemy HQ, prefer
    // flattening it when the HQ is the better shot — no live turret at all, no clear line to the
    // nearest turret (it's walled behind the keep), or the HQ is simply closer. Dropping the HQ
    // reveals the flag AND opens angles on the back towers. LOS-gated, so units still grind the
    // walls/near towers until a line to the keep actually opens (they don't charge blind).
    if (this.strategy.step === 'siege' && !_locked) {   // (was this.strategy.key — always undefined, so this HQ-targeting block never ran: siegers only ever shelled turrets, never the keep)
      let bestH = Infinity, ec = null, hqPt = null;
      for (const c of camps) {
        if (c.team === this.team || !c.flagHQ || c.flagHQ.dead) continue;
        const hx = c.center.x, hz = c.center.z;
        const d = (hx - px) ** 2 + (hz - pz) ** 2;   // no LOS gate — if it's walled, we break a path to it
        if (d < bestH) { bestH = d; ec = c; hqPt = { x: hx, y: map.heightAt(hx, hz) + 5, z: hz }; }
      }
      if (ec) {
        // Target the keep whenever there's no turret we can actually SHOOT right now — none left,
        // OR the nearest one is walled behind the keep (no clean line). With no line to the keep
        // either, the demolish/break-through logic below chews a wall path straight to it, so it
        // gets flattened WHILE the back towers still stand (revealing the flag). We do NOT pull off
        // a turret that's out in the open shooting at us. OFF = old rule (only once all turrets die).
        // WHAT MATTERS is whether the unit can actually GET somewhere useful, not whether it
        // currently sees the tower — LOS from the current position is a bad proxy while still
        // mid-transit to an already-picked, already-reachable stand (of course there's no LOS
        // yet, it hasn't arrived). Check a real path instead: to the picked STAND if _pickStandoff
        // gave us one (that's what the unit is actually walking toward), else to the raw
        // fallback threat itself. Traced: this false-"no path" via LOS is exactly what stranded
        // a lurcher across open water for 164s (seed 130) — _pickStandoff had a good, reachable
        // stand every tick, and the old !turretLOS check discarded it anyway.
        const navTarget = stand2 || threat;
        // CACHED. This test — "can I still get to the stand I'm walking toward?" — ran a full-grid
        // A* per sieging unit per TICK and threw the path away. Measured over 12 matches it was
        // 11670 of 14383 searches (81%), against 2150 for actual navigation. It also carried no
        // caller tag, so it counted as 'nav' and the ?perf panel read "by caller: nav" — which is
        // what pointed the whole investigation at navWaypoint, where only 15% of the work was.
        // The ANSWER barely changes: it depends on the map (hence _navEpoch) and on which stand we
        // are heading for (hence the target cell). A short TTL on top bounds staleness, because
        // reachability also depends on where the unit is standing, and a boxed-in unit must not be
        // told "still fine" for long — that is the failure this call was added to prevent.
        // Timed on _matchT, not performance.now(), so it stays deterministic in the test rig.
        let hasPathNow = false;
        if (threat && navTarget) {
          if (flyer) hasPathNow = true;
          else {
            const gc = grid.cell;
            const rk = `${Math.round(navTarget.x / gc)},${Math.round(navTarget.z / gc)}|${_navEpoch}`;
            const rc = v._reachC;
            if (rc && rc.k === rk && this._matchT - rc.t < REACH_TTL) hasPathNow = rc.ok;
            else {
              const p = planPath(v, { x: navTarget.x, z: navTarget.z }, { by: 'hqreach' });
              let ok = false;
              if (p && p.length) {
                const e = p[p.length - 1];
                ok = (e.x - navTarget.x) ** 2 + (e.z - navTarget.z) ** 2 <= (gc * 2) ** 2;
              }
              v._reachC = { k: rk, t: this._matchT, ok };
              hasPathNow = ok;
            }
          }
        }
        // The stalemate GAMBIT goes straight for the KEEP (that's the whole point — crack the HQ,
        // expose the flag, win — not trade tower-for-tower while the enemy's tied up mid-field).
        // SCORE THE TARGETS INSTEAD OF QUEUEING THEM (Jacob). The keep is the win condition, so it
        // is the default pick; a tower outranks it only while it is actually shooting at us, and
        // that bonus fades instead of switching off. Everything else here — reachability, the
        // crossfire-free stand — is unchanged, it just now applies to whichever target scored
        // highest rather than to whatever the queue happened to name.
        let promote = this._gambit || !threat || !hasPathNow;
        if (aiTargetPrio && !promote && threat) {
          promote = this._keepOutranks(v, threat.x, threat.z, px, pz);
        }
        this._prioTarget = promote ? 'hq' : 'tower'; _br.promote = !!promote;
        if (promote) {
          // This silently THROWS AWAY whatever `threat` already was (including a validated,
          // reachable _pickStandoff pick — stand2 truthy) in favor of the HQ's raw center point,
          // which has NO reachability check at all ("no LOS gate — if it's walled, we break a
          // path to it" above).
          dlog(`hqPromotion:${this.team}`, {
            unit: v.type, reason: this._gambit ? 'gambit' : !threat ? 'no-threat-at-all' : 'no-path-to-stand',
            hadStand2: !!stand2, discardedThreat: threat ? { x: +threat.x.toFixed(0), z: +threat.z.toFixed(0) } : null,
            hqX: +hqPt.x.toFixed(0), hqZ: +hqPt.z.toFixed(0)
          }, `${this.cname} ${v.type}: promoting to HQ${stand2 ? ' — DISCARDING an already-validated reachable stand' : ''} (reason: ${this._gambit ? 'gambit' : !threat ? 'no threat at all' : 'no path to the picked stand right now'}).`);
          threat = hqPt; _tgtWhy = 'promoted to the keep'; threatCamp = ec; hqThreat = true;
          // GIVE THE KEEP A REAL FIRING POSITION. Without this the HQ fell through to the radial
          // fallback further down, which computes "a point `hold` out from the target, along the
          // line from the target to wherever I am standing right now" — that is not a place. It
          // moves whenever the unit moves, so no single route can ever arrive at it, and the 70u
          // objective/stand split exists purely to hide that. _standoffFor picks an ACTUAL spot
          // (in range, line of sight, clear of other towers' arcs, proven reachable by a real A*)
          // and it is cached per siege exactly like a tower's, so the unit gets one destination
          // and one route. See devblog/2026-08-05-one-mission-layer.md.
          const hqKey = ec.flagHQ || ec;
          let hqSpot = this._siegePlan ? this._siegePlan.spots.get(hqKey) : undefined;
          const hqReach = SHOT_REACH[v.type] || 42;                       // same gun-length rule as a tower's spot
          const hqFor = this._siegePlan ? this._siegePlan.spotReach.get(hqKey) : undefined;
          if (hqSpot !== undefined && hqFor != null && hqFor > hqReach) hqSpot = undefined;
          if (hqSpot === undefined) {
            hqSpot = this._standoffFor(v, { x: hqPt.x, z: hqPt.z, camp: ec, wall: hqKey });
            if (this._siegePlan) { this._siegePlan.spots.set(hqKey, hqSpot); this._siegePlan.spotReach.set(hqKey, hqReach); }   // null cached too — don't re-search a hopeless keep every tick
          }
          if (hqSpot) { stand2 = hqSpot; stand2Ref = threat; }
        }
      }
    }
    // BREACH THE THING IN THE WAY. Lowest priority in the whole picker — it only runs when there
    // is nothing else worth shooting at all. Condition: the nav has ALREADY proved our objective
    // unreachable (that is what _reachCap means — "holding at the closest ground we can stand on")
    // and a live enemy wall or gate sits inside our own gun's reach.
    // WHY THIS EXISTS (Jacob): "it blasts trees that get in its way, it should definitely also
    // blast walls that get in its way." Seed 1572 ends with the enemy keep at -68hp, ALL 30 walls
    // intact, one shut gate, the enemy eliminated, and a full-health Firebrat with 80 rounds
    // parked 30u from the flag for 750 seconds — because no code path ever considered a wall a
    // target. The guns were always able to kill it: every projectile already calls
    // hitSolid.damage(), which is how a stray round chips a wall today.
    // Deliberately NOT gated on `siege`: a runner that cannot reach the flag is exactly the unit
    // that should be making its own door.
    // PRIORITY, not last resort. Gating this on "no other target" made it fire ZERO times in a
    // 900s match (measured: conditions aligned on 724 ticks, fired 0) — because a parked unit
    // almost always still has a target assigned: the far tower it cannot reach. Being aimed at
    // something out of range is not a reason to ignore the wall an arm's length away.
    // So: a live enemy wall inside our OWN gun's reach outranks any target that is FARTHER than
    // it, whenever the nav has already proved our objective unreachable. Nothing closer is ever
    // displaced, so a gun actually shooting at us still wins.
    if (aiBreach) { _breachDbg.seen++; if (!threat) _breachDbg.noThreat++; if (this._reachCap) _breachDbg.hasCap++; }
    if (aiBreach && this._reachCap) {
      _breachDbg.both++;
      const reach = SHOT_REACH[v.type] || 42;
      let bestW = null, bestC = null, bestD = reach * reach;
      for (const c of camps) {
        if (c.team === this.team) continue;
        for (const w of c.walls) {
          // A camp wall carries NO x/z of its own — its position lives on w.group.position. (I
          // guarded on w.x first and silently skipped all 30 walls, which is why this block read
          // as "measured, does nothing" until the wall record was actually inspected.)
          const g = w.group && w.group.position;
          if (!w.body || w.body.dead || !g) continue;
          const dx = g.x - px, dz = g.z - pz, d2 = dx * dx + dz * dz;
          if (d2 < bestD) { bestD = d2; bestW = g; bestC = c; }
        }
      }
      // Only displace a target that is FARTHER than the wall. A gun shooting at us from closer in
      // keeps priority; a tower 200u away that we are parked short of does not.
      const curD2 = threat ? (threat.x - px) ** 2 + (threat.z - pz) ** 2 : Infinity;
      if (bestW && bestD < curD2) {
        threat = { x: bestW.x, y: map.heightAt(bestW.x, bestW.z) + 3, z: bestW.z };
        _tgtWhy = 'breaching the wall in our way'; threatCamp = bestC; _breachDbg.fired++;
      }
    }
    // SHOOT BACK: a turret that LANDED A HIT on us in the last 4s IS the threat — not the
    // nearest gun, not the keep, and not the healing sponge next door. (Watched live: a
    // lurcher ground away at a gunless tower under repair while the far corner's live
    // gun killed it.) Match the remembered head position back to a live turret.
    // SHOOT BACK — DELETED as a target override (2026-08-05). A turret that had landed a hit in
    // the last 4s used to be assigned as the target directly, reaching past the plan and past the
    // priority score. It was the single biggest source of churn: 161 of 496 switches were
    // gun-to-gun with neither gun destroyed, because against several firing towers the "most
    // recent hit" changes with every incoming round, and the firing position moves with the
    // target. The symptom it was added for — grinding a gunless tower under repair while a live
    // gun kills you — is now covered by the target being COMMITTED to a chosen tower and by
    // the target being COMMITTED to a chosen tower until that tower is rubble.
    // Being shot is a reason to re-examine the plan (the brain's `threatened`/`ambushed` rungs
    // still respond, and taking fire is a re-score trigger); it is not a reason to silently
    // rewrite what we are shooting at.
    // (A REPAIR JEEP NEVER STEALS THE TARGET FROM A GUN. This used to swap onto the crew whenever
    // one was servicing the tower we were shooting, on the theory that killing the fix beats
    // out-damaging it. But by the time this runs the target is always a LIVE GUN — plannableTowers
    // only returns armed ones — so the swap traded the thing that is shooting us for a soft-skin
    // support vehicle, and walked the unit deeper into the base to chase it. Jacob: "I wouldn't
    // want a unit moving into a flagbase trying to get a jeep and taking fire from 3 guns... even
    // if the jeep is repairing a tower we can ignore it and take on the real danger."
    //
    // The distinction that makes this safe already exists: a TOWER is a structure and harmless, a
    // GUN is the danger, and only guns are ever planned against. A crew rebuilding bare rubble is
    // rebuilding something we were never going to shoot. And a gun being repaired while we shell
    // it is not a race we lose — RepairCrew abandons the job the moment the body hits zero again.)
    // COMMIT. Whatever the selection above landed on becomes the standing target, together with
    // the firing spot and the live object we can ask "are you still there?".
    if (!_locked) {
      this._tgtLock = threat ? {
        x: threat.x, y: threat.y != null ? threat.y : 0, z: threat.z,
        camp: threatCamp, hq: hqThreat, spot: stand2, why: _tgtWhy,
        wall: _tgtWall, msn: this.strategy && this.strategy.step,
      } : null;
    }
    // HOW LONG HAVE WE HELD THIS TARGET? Read next tick by the shoot-back guard above. Keyed on
    // the rounded position rather than object identity: the threat is rebuilt as a fresh object
    // every tick, so identity would report "changed" every single time.
    const _tk = threat ? Math.round(threat.x) + ',' + Math.round(threat.z) : null;
    if (_tk && _tk === this._tgtKey) this._tgtT = (this._tgtT || 0) + dt;
    else {
      if (this._tgtKey) {
        const [fx, fz] = this._tgtKey.split(',').map(Number);
        const wasHq = this._tgtWhy === 'promoted to the keep';
        tgtEvents.push({
          t: Math.round(this._matchT || 0), team: this.team, type: v.type,
          msn: this.strategy && this.strategy.step, state: this.state,
          from: this._tgtKey, fromWhy: this._tgtWhy || '?', to: _tk, toWhy: _tgtWhy,
          held: +(this._tgtT || 0).toFixed(1), br: { ..._br },
          // did the OLD target stop existing? that makes the switch correct, not churn
          fromGone: wasHq ? false : !liveTurretNear(fx, fz),
          wasHq,
        });
        if (tgtEvents.length > 6000) tgtEvents.shift();
      }
      this._tgtKey = _tk; this._tgtT = 0; this._tgtWhy = _tgtWhy;
    }
    // Is there a CLEAR shot at the nearest tower, and which way to peel around it?
    // `threatLOS` lets the brain hold + fire when it can see the tower, or swing wide
    // to the flank (rather than hammer the wall in front of it) when it can't. The
    // cross product of (base→tower) × (tower→unit) picks the nearer side to arc to.
    let flankSide = 0, threatLOS = false, threatStand = null;
    if (threat) threatLOS = flyer || hasLOS(px, pz, threat.x, threat.z);
    // (BREACH COMMIT lived here: latch the nearest live wall in the target's camp and hammer it
    // to rubble. It was added because the sieger used to re-pick the nearest wall every tick and
    // spread its fire around the whole ring, and the latch did cure that. But "nearest to me" was
    // never the right question — it names a wall wherever we happen to stand relative to the
    // ring, not the wall that is stopping our shot. Measured on the stalemates: 11,580 of 12,043
    // arrived siege decisions on seed 179 had a latched wall a median 49u away with a 42u gun, so
    // the sieger stood at a perfectly good firing position with nothing it could legally shoot
    // and blue's keep finished the match on a full 600hp. losBlocker answers the real question,
    // and its answer is stable for the same reason the latch was — it is a property of the line,
    // not of where we drifted to.)
    if (threat) {
      // CLOSE IN to finish. A heavy planted at its full 64u sniper hold often has NO line through
      // the base walls, so it sprays the wall face and idles (the audit's "lone jotun frozen at
      // the wall for 640s"). Drive to a short hold — when we can actually finish (enemy wiped, OR
      // turrets down, OR we've already punched a hole) — to get a real line on the breach / keep.
      // (The hold-distance ladder lived here — finisher / closeIn / breachWall / sniper radii for
      // the geometric fallbacks. Those fallbacks are gone, and the distance question belongs to
      // _standoffFor now: its band is sized from SHOT_REACH and TURRET_HOLD and every tier is
      // capped at reach*0.99, so a spot it returns is one the gun can actually shoot from.)
      // ONE ALGORITHM. _standoffFor picks the firing position the way lab/standoff-lab.html does —
      // flood the reachable ground, keep the cells in range with a line to the target and clear of
      // other guns, take the nearest. If it finds nothing there is NO SECOND METHOD: it raises a
      // STANDOFF ALARM naming the test that rejected every candidate, and the unit gets no stand.
      //
      // What used to be here were three geometric fallbacks — radial from the base centre through
      // the tower, or straight back along our approach line — and none of them checked LINE OF
      // SIGHT. They looked like they worked, which is worse than failing. Seed 1193: red's last
      // Lurcher spent the final ten minutes driving 200u to a firing position it had been handed
      // 100% of the time, and could see its target from it on 3 ticks out of 6459. It never fired a
      // shot. Its reload counter read MINUS FOUR MINUTES — loaded, ready, aiming at a wall — while
      // one tower stood between it and the win, and it kills a tower in 3.2 seconds.
      // (Jacob: "I hate silent fallbacks… I don't want backup algorithms, I just want one that
      // works.")
      if (stand2 && threat === stand2Ref) {
        threatStand = { x: stand2.x, z: stand2.z };
        if (threatCamp && !hqThreat) {   // flank side still informs the approach arc
          const bx = threat.x - threatCamp.center.x, bz = threat.z - threatCamp.center.z;
          const ux = px - threat.x, uz = pz - threat.z;
          flankSide = (bx * uz - bz * ux) >= 0 ? 1 : -1;
        }
      }
      // (The old _standRot bearing-walk lived here: when the driver refused a geometric standoff
      // as unreachable, the stand was rotated around the tower and re-planned, one bearing at a
      // time. That was a SEARCH implemented as repeated full-grid A*, with the goal jumping tens
      // of units per step. The plan now vets reachability before committing, so there is nothing
      // to walk away from — see _standoffFor's relaxation ladder.)
    }
    // SIEGE FLATTEN: with no clean line on the target, shell WHATEVER IS BLOCKING THE SHOT to
    // blow a path through — aimed rounds at the hidden turret just arc over. One rule, and it
    // needs no camp bookkeeping, no latch and no special cases: walk the line to the target and
    // shoot the first thing on it.
    //
    // It subsumes the three separate answers that used to live here. The latched breach wall and
    // the nearest-wall scan both asked "which wall am I closest to", which is a different question
    // and frequently a wall out of gun range while the real obstruction sat right in front of the
    // hull. And the keep needed its own clause, because a LOS ray to the HQ's centre dies inside
    // the building's own obstacle circle so threatLOS can never come true against it — but that is
    // not a special case at all, it is the general rule working: with every wall down the first
    // thing on the line to the keep IS the keep, so we square onto it and shell it open (seed 207,
    // a lurcher staring at a 297hp keep for 400s while the flag stayed sealed).
    let demolishTarget = null;
    if (!flyer && threat && !threatLOS) {
      const b = losBlocker(px, pz, threat.x, threat.z, this.team);
      if (b) demolishTarget = { x: b.x, y: map.heightAt(b.x, b.z) + 2.5, z: b.z };
    }
    // Same sponge rule as the turret threat above: chewing a wall a crew is actively
    // re-raising is a losing race — put the rounds into the JEEP and cancel the heal.
    if (demolishTarget) {
      const jp = enemyRepairJeepNear(this.team, demolishTarget.x, demolishTarget.z);
      if (jp) { demolishTarget = jp; if (!this._healHuntOn) { this._healHuntOn = true; aiLog(this.team, `${this.cname} ${this.unit.type}: “Crew's patching that wall — take out their jeep!”`); } }
      else if (!threat) this._healHuntOn = false;
    }
    const fx = -Math.sin(h), fz = -Math.cos(h), lx = -Math.sin(h + 0.6), lz = -Math.cos(h + 0.6),
          rx = -Math.sin(h - 0.6), rz = -Math.cos(h - 0.6), P = 9;
    // Sweep each feeler from the hull edge out to P, not just the far point — a single
    // 9u sample sailed PAST a tree/wall the unit was already nosed into (so it never
    // registered as blocked and the break-through never fired). Near + far catches both
    // "about to hit it" and "already touching it".
    const feeler = (ax, az) => v._blocked(px + ax * VEH_R, pz + az * VEH_R) || v._blocked(px + ax * P, pz + az * P);
    const blockedAhead = feeler(fx, fz);
    // BREAK-THROUGH: when the nose is blocked, find the destructible dead ahead (the
    // nearest enemy/neutral WALL in front, else a TREE on the path) so a stuck ground
    // unit can shoot it out of the way instead of circling. Only the obstacles that
    // actually block are walls and trees — both take fire — so anything found here is a
    // valid target; water / world-edge leave it null and the unit dodges as before.
    let breakTarget = null;
    if (!flyer && blockedAhead) {
      const reach = 16;
      let best = null, bestD = reach * reach, ty = 2.0;
      for (const o of obstacles) {
        if (o.team === this.team) continue;            // never shoot our OWN base walls (the trigger-happy own-flag-shredding bug)
        if (o.body && o.body.dead) continue;           // already rubble — nothing to shoot
        const ox = o.x - px, oz = o.z - pz;
        if (ox * fx + oz * fz <= 0) continue;          // behind the nose
        const d = ox * ox + oz * oz;
        if (d < bestD) { bestD = d; best = o; ty = 2.0; }
      }
      if (foliage) {
        for (let s = VEH_R; s <= reach; s += 2.5) {     // walk the forward ray for a palm
          const t = foliage.treeAt(px + fx * s, pz + fz * s, VEH_R);
          if (t) { const d = (t.x - px) ** 2 + (t.z - pz) ** 2; if (!best || d < bestD) { best = t; ty = 3.0; } break; }
        }
      }
      if (best) breakTarget = { x: best.x, y: map.heightAt(best.x, best.z) + ty, z: best.z, tree: ty === 3.0 };   // tree vs wall — a Firebrat may blast a tree but never a structure
    }
    // Standing in the door on an intercept, and the lane to watch from it (see the view fields).
    let atCamp = false, watch = null;
    if (this.strategy.step === 'intercept') {
      const icamp = this.interceptCampSpot();
      atCamp = !!(icamp && (icamp.x - px) ** 2 + (icamp.z - pz) ** 2 < INTERCEPT_HOLD_R * INTERCEPT_HOLD_R);
      const of = this.ourFlag();
      watch = of ? { x: of.home.x, z: of.home.z } : this.homeBasePos();
    }
    return {
      dt,
      self: { x: px, z: pz, heading: h, type: v.type, shield: v.shield, hpFrac: v.hp / v.maxHp, fuelFrac: v.fuel / v.maxFuel, ammoFrac: v.ammo / v.maxAmmo },
      seesEnemy, enemy, heard, enemiesNear, alliesNear, flyer, shotArc: SHOT_ARC[v.type] ?? Math.PI / 5,
      omni: !!v._move.omni,   // chassis translates any direction (Lurcher) — locomote decomposes motion
      canStrafe: !!v._move.strafe,   // the driver knows his pedals — reflexes pick chassis-legal maneuvers
      worldR: islandBound || 0,   // hard travel rim (map centre radius) — flee bends along it instead of pinning
      underFire: (performance.now() - (v._hitByVehT || -1e9)) < 1600,   // an enemy vehicle shot us in the last ~1.6s
      // WHERE those rounds came from (last ~2.5s) — the vehicle twin of towerFire below. underFire
      // says we're being shot; this says by whom, so a unit hit from outside its sight cone can
      // turn toward the shooter instead of only knowing it is losing hull.
      incomingFire: v._hitByVeh && performance.now() - v._hitByVeh.t < 2500
        ? { x: v._hitByVeh.x, z: v._hitByVeh.z } : null,

      // shot-feedback: ≥2 of our recent rounds (last ~2s) detonated on terrain/cover, not on
      // the enemy → the firing lane is blocked; the combat brain sidesteps to clear it.
      shotBlocked: (v._blockedShots || 0) >= 2 && (performance.now() - (v._lastBlockT || 0)) < 2000,
      enemyGone: this.enemyEliminated(),   // target fleet wiped → don't waste time ghost-chasing a dead sighting
      support: turretCountOf(this.team) > 0 ? this.homeBasePos() : null,   // rally toward own tower cover (ai_behavior duels)
      threat, threatLOS, flankSide, threatStand, demolishTarget, breakTarget, engageRange: ENGAGE_RANGE[v.type] || 36,
      // ACTIVE tower fire on this hull (last ~2.5s): the siege break-off's trigger. The doctrine
      // is "the maneuver depends on being FIRED ON" — proximity alone interrupted every siege of
      // a defended base into an endless field duel (exact-gate: 8 seeds flipped to stalemate).
      towerFire: v._hitByTurret && performance.now() - v._hitByTurret.t < 2500
        ? { x: v._hitByTurret.x, z: v._hitByTurret.z } : null,
      shotReach: SHOT_REACH[v.type] || 999,   // hard cap on firing distance — a round physically dies past this (see SHOT_REACH)
      fofW: fofFor(this.team),   // this team's fight-or-flight weight set (tunable / A/B)
      hqThreat,   // the suppress target is the enemy KEEP (not a tower) — for logs/recorder
      goal,
      resupply: supply ? { x: supply.center.x, z: supply.center.z } : goal,
      supplyHeals,   // the chosen resupply point is an own base → hold until ammo+fuel+hp are all maxed
      home: healHome || goal,
      atHome: nearOwnSupply(v, px, pz),   // already in the base's heal/rearm zone → stop and top up (don't orbit the exact centre)
      // The most hp base repair will actually give THIS unit (fraction). A trap-tending bait
      // deliberately holds 55% (repairCap) — without this the hurt/resup latches demand 80/99%
      // hp that can never come, parking the unit at its FOB "topping up" forever (deadlock).
      healCap: v.maxHp ? repairCap(v) / v.maxHp : 1,
      // While DETOURING (grabbing a shield / intercepting), the goal is a place to GO, not a
      // thing to shell — so suppress shootGoal or the unit would "assault" (and gun down) the
      // shield generator / intercept spot it's heading for. It still engages real enemies via
      // the combat transitions; this only stops it firing at the detour waypoint.
      shootGoal: this.strategy.shoot(this) && !this._shielding && !this._intercepting && !this._scrapDetour,
      finishing: this.fortDown() || this.enemyEliminated(),   // decisive phase (cracking the HQ / mopping up) → spend the ammo reserve, don't hold back
      rushBase: this._gambit && !this.flagExposed(),   // stalemate gambit: IGNORE the enemy, slip around and crack the HQ (suppresses engaging)
      // CAPTURE COMMIT: on a capture run, once the flag is grabbable AND we're on the final approach
      // (within CAPTURE_COMMIT), beeline it and ignore turrets (brain: 'capturing' near the top). Not
      // set once we're carrying it (then the objective is home). Fixes "worked the turret, never grabbed".
      capturing: this.strategy.step === 'capture' && this.flagGrabbable() && (() => {   // (was strategy.key — always undefined, so the final flag-grab commit never fired)
        const f = this.flag(); if (!f || f.carrier === v) return false;
        return (px - f.group.position.x) ** 2 + (pz - f.group.position.z) ** 2 < CAPTURE_COMMIT * CAPTURE_COMMIT;
      })(),

      shieldRun: this._shieldRun,   // committed to a close shield → grab it before fighting (brain: above 'engaging')
      // THE MISSION DECIDES whether we are on a supply run. Two layers each answering "do I need
      // fuel" is what produced the 90u depot shuttle; the brain's resupply rung now just executes
      // what the mission layer picked (AIStrategies.js's Refuel/Rearm, in MSN_CANDS).
      supplyRun: this.strategy ? (this.strategy.step === 'refuel' || this.strategy.step === 'rearm') : undefined,
      // Salvage detour: drive ONTO the pile (within SCRAP_PICKUP_R) instead of stopping at the
      // mission's arriveDist — Scout(12)/Attack(10) exceed the 8u pickup, so the unit used to halt
      // just short and idle for seconds before drifting into range. Tight like the shield/intercept grabs.
      arriveDist: this._intercepting ? 4 : this._shielding ? 6 : (this._scrapDetour && aiScrapTightArrive) ? 4 : this.strategy.arriveDist(this),
      // Is this unit on a flee-contact RUNNER mission (grab the flag / scout — avoid fights)
      // vs one the commander sent it out to FIGHT on (attack/siege/defend/intercept)? Gates
      // the Firebrat's runnerFlee reflex so an ordered-to-engage Firebrat actually closes +
      // shoots instead of dodging the instant an enemy is near.
      runnerMode: this.strategy.step === 'capture' || this.strategy.step === 'scout',
      // The Flee mission is running: drive the route, don't stop to fight. The decision to break
      // off has already been taken; re-opening it on every sighting is the flap this replaced.
      fleeing: this.strategy.step === 'flee',
      // HOW BRAVE IS THIS RUNNER RIGHT NOW? 0 far from the flag, 1 on top of it — the heroic dash,
      // weighted into fightScore rather than bolted on as an exception. Only on the way TO the
      // flag: once carrying, the job is the trip home and picking fights is never right.
      runnerNerve: this.runnerNerve(v),
      // ON INTERCEPT, GET TO THE DOOR — don't get drawn into a chase on the way. Nothing on the
      // field outruns a flag runner, so a pursuit is a race we lose while the carrier scores.
      intercepting: this.strategy.step === 'intercept',
      // ...BUT ONCE WE ARE STANDING IN IT, a chase stops being a foot race: we are the thing
      // between the runner and the only place it can score, so closing is geometry.
      atCamp,
      // WHERE THE RUNNER WILL COME FROM: our own flag's home. A unit that drove out to the camp
      // arrives pointing at the enemy base — away from the only lane it is there to watch.
      watch,
      flagGrabbable: this.strategy.step === 'capture' && this.flagGrabbable(),   // endgame: sightings alone don't turn the runner around (runnerFlee)
      blockedAhead,
      blockedLeft: feeler(lx, lz),
      blockedRight: feeler(rx, rz),
    };
  }
}

// Designer teams are identity-only ('a'/'b'); the game's internals are 'red'/'blue'.
// 'a' is the first/player side → red. (Players still pick their colour in-game.)
const CFG_TEAM_OF = { red: 'a', blue: 'b' };
function cfgRulesFor(team) {
  const R = MAP_CFG && MAP_CFG.rules; const t = R && R.teams && R.teams[CFG_TEAM_OF[team]];
  return t ? { rules: R, team: t } : null;
}
// A designed map's difficulty becomes an AI handicap by scaling aim/steer noise
// (jitter) and decision lag (reaction): easy = sloppier + slower, hard = sharper.
const DIFF_HANDICAP = { easy: { j: 1.7, r: 1.5 }, normal: { j: 1, r: 1 }, hard: { j: 0.5, r: 0.6 } };
// Push the designer's per-team rules onto a freshly-built commander: personality
// knobs, fleet roster, and the difficulty handicap. Archetype is set at construction.
function applyCfgRules(cmd) {
  const c = cfgRulesFor(cmd.team); if (!c) return;
  const T = c.team, p = cmd.personality;
  if (T.aggression != null) p.aggression = T.aggression;
  if (T.defensiveness != null) p.defensiveness = T.defensiveness;
  if (T.triggerHappy != null) p.triggerHappy = T.triggerHappy;
  const aggMin = cmd.archetype === 'warrior' ? 0.75 : cmd.archetype === 'turtle' ? 0.66 : 0;   // mirror the constructor's floor
  if (p.aggression < aggMin) p.aggression = aggMin;
  const k = DIFF_HANDICAP[c.rules.difficulty] || DIFF_HANDICAP.normal;
  p.jitter = Math.min(1, (p.jitter ?? 0.25) * k.j);
  p.reaction = (p.reaction ?? 0.3) * k.r;
  if (T.roster) cmd.roster = { ...cmd.roster, ...T.roster };
}

// Create an AICommander for every AI-controlled team (called at field build).
function setupCommanders() {
  commanders.length = 0;
  if (QS.has('noai')) return;
  const teamIds = [...new Set(camps.filter(c => c.role === 'main').map(c => c.team))];
  const aiTeams = teamIds.filter(t => TEAM_CTRL[t] === 'ai');
  // ?arch=warrior,turtle forces each AI side's doctrine (in aiTeams order) for round-robin
  // persona-vs-persona testing; absent, deal distinct doctrines seeded by ?dseed as normal.
  const forcedArch = QS.get('arch') ? QS.get('arch').split(',').map(s => s.trim()) : null;
  const archs = forcedArch || assignArchetypes(aiTeams.length, doctrineRng);   // distinct doctrines → a real contrast each match (seedable via ?dseed)
  aiTeams.forEach((t, i) => {
    const designed = cfgRulesFor(t);   // a designed map fixes each side's doctrine
    const cmd = new AICommander(t, (designed && designed.team.archetype) || archs[i]);
    applyCfgRules(cmd);
    commanders.push(cmd);
  });
  // If no human is playing (e.g. AI-vs-AI spectate), kick everyone off immediately.
  if (!teamIds.some(t => TEAM_CTRL[t] === 'human')) startCommanders(null);
}
// Assign each un-started AI commander a colour distinct from those already taken
// (the human's pick is reserved), then deploy it.
function startCommanders(reservedColorIndex) {
  const used = new Set(); if (reservedColorIndex != null) used.add(reservedColorIndex);
  for (const cmd of commanders) {
    if (cmd.started) continue;
    let idx = pickFreeColor(used); used.add(idx);
    cmd.start(idx);
  }
}
function pickFreeColor(used) {
  const free = [];
  for (let i = 0; i < TEAM_COLORS.length; i++) if (!used.has(i)) free.push(i);
  const pool = free.length ? free : [...TEAM_COLORS.keys()];
  return pool[(Math.random() * pool.length) | 0];
}
// "Advance"… advance to WHAT? Compose the brain state's OBJECT from a slot's _dbg readout
// (resolved destination, foe type/dist, tower dist) so the logs read as decisions, not verbs.
// Shared by the in-game brief log and the ai-lab publish (Jacob: "Suppress what? Where?").
function stateDetail(d, st) {
  if (!d) return '';
  const go = d.gd != null ? `(${d.gx},${d.gz}) ${d.gd}u out` : '';
  switch (st) {
    case 'engage':   return d.foeT ? `duelling the ${d.foeT} ${d.foeD}u out` : 'duelling';
    case 'suppress': return d.hq ? `shelling their HQ${d.turD != null ? ` ${d.turD}u out` : ''}`
                                 : `shelling a turret${d.turD != null ? ` ${d.turD}u out` : ''} · ${d.towers} left`;
    case 'advance':  {
      // Sap sortie legs get named — "to the objective" told Jacob nothing while a Firebrat
      // ran its flank route (out → mine the way back → drop the pod → home).
      const SAP_LEG = { out: 'to the flank point', back: 'mining the run home', pod: 'to the sensor-pod drop', done: 'flank run done — heading home' };
      return `${d.sap && SAP_LEG[d.sap] ? SAP_LEG[d.sap] : 'to the objective'} ${go}`;
    }
    case 'assault':  return `storming the objective ${go}`;
    case 'pursue':   return `to their last-known spot ${go}`;
    case 'resupply': return `to top up ${go}`;
    case 'flee':     return d.foeT ? `from the ${d.foeT} ${d.foeD}u back` : `breaking contact ${go}`;
    case 'unstick':  return d.stuckWhy || 'jolting free';
    default:         return '';
  }
}
function updateCommanders(dt) {
  _astarFrameMs = 0; _astarFrameNodes = 0; _planFrame = 0;
  updateReservations();
  for (const cmd of commanders) cmd.update(dt);
  // Run the no-move watch ONCE per unit per tick, here rather than at the drive boundary, so it
  // catches units whose brain wants to move but which never reach a drive call at all.
  for (const v of combatants) if (!v.dead && v.ai) _noMoveWatch(v, dt);
  updateFlags(dt); publishAILive(dt);
  // A* STORM ALARM. The siege re-solve loop ran ~40 searches a FRAME and was only noticed
  // because ?perf's replans/s disagreed with its own cause tags. A number that high is never
  // legitimate work — it is something re-deciding instead of deciding. Shout once, naming the
  // callers, so the next loop of this kind announces itself instead of waiting to be spotted.
  if (_planFrame >= ASTAR_FRAME_ALARM && !_astarAlarmed) {
    _astarAlarmed = true;
    const by = Object.entries(_planBy).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ');
    aiLog('red', `[A* ALARM] ${_planFrame} pathfinding searches in ONE frame (${by || 'callers untracked — needs ?perf'}). `
      + `That is a loop, not a plan. Frames like this are what caused the 16fps stutter.`);
  }
}

// AI LAB LIVE OVERLAY: publish each commander's current mission to localStorage on a light
// throttle (~2.5 Hz). The standalone ai-lab/commanders.html (same origin) reads this key and
// highlights the live decision — no game import, no per-frame cost, just one tiny JSON write a
// few times a second. Absent that page, this is inert.
let _aiLiveT = 0;
const _AI_LIVE_TEAM = { red: 'Team A', blue: 'Team B' };
function publishAILive(dt) {
  _aiLiveT += dt;
  if (_aiLiveT < 0.4) return;
  _aiLiveT = 0;
  try {
    const teams = {};
    for (const cmd of commanders) {
      const s = cmd.strategy;
      if (!s) continue;
      const label = _AI_LIVE_TEAM[cmd.team] || cmd.team;
      // lower tactical layer: each live unit's current unit-brain mode (engage/pursue/flee/…),
      // plus `when` = the EXACT brain transition that won (mem._when), so the lab lights the one
      // rung that fired, not every rung that shares the mode.
      const units = [];
      for (const u of cmd.liveUnits()) {
        // ctrl = who's actually driving this tick. During a recall/lift-rise the game drives the
        // unit directly and skips the brain, so its state/when are STALE — flag that so the lab
        // doesn't show a frozen decision. (A routine recall aborts back to the brain if a foe
        // closes within ~46u; a forced swap commits home regardless — either way _recalling tracks it.)
        const sl = cmd._slots.find(s => s.unit === u);
        const ctrl = sl && sl.strategy && sl.strategy.step === 'swap' ? 'swap' : (sl && sl._rising ? 'rising' : 'brain');
        units.push({
          type: u.type, state: u._aiState || '—',
          detail: stateDetail(sl && sl._dbg, u._aiState),   // the state's OBJECT — "advance to WHAT" (Jacob's ask)
          // chain of command, bottom two layers: the driver's standing maneuver order and
          // the pedals actually driven this tick (+ alarm count — a live unit with alarms
          // has been failing to move; the lab flags it).
          mnv: (sl && sl._dbg && sl._dbg.mnv) || null,
          drv: (sl && sl._dbg && sl._dbg.drv) || null,
          alarms: (sl && sl._dbg && sl._dbg.alarms) || 0,
          when: (u.ai && u.ai._when) || '', ctrl,
          hp: u.maxHp ? Math.round(100 * u.hp / u.maxHp) : null,
          ammo: u.maxAmmo ? Math.round(100 * u.ammo / u.maxAmmo) : null,
          fuel: u.maxFuel ? Math.round(100 * u.fuel / u.maxFuel) : null,
          shield: u.maxShield ? Math.round(100 * u.shield / u.maxShield) : null,
          heading: typeof u.heading === 'number' ? +u.heading.toFixed(2) : null });
      }
      let sub = ''; try { sub = s.objectiveLabel ? s.objectiveLabel(cmd) : ''; } catch (e) { sub = ''; }   // current sub-behavior within the mission (Defend → "patrolling the lane")
      // METRICS — the live number behind each decision (rendered on the spine cards); DBG — the
      // full brief-log readout for the top panel. Everything here is already computed each tick.
      const ec = commanders.find(c => c !== cmd);
      const num = f => { try { const v = f(); return v == null ? null : v; } catch (e) { return null; } };
      const mine = num(() => cmd.fleetLeft()), theirs = ec ? num(() => ec.fleetLeft()) : null;
      const primSlot = cmd._slots.find(sl => sl.unit && !sl.unit.dead);
      const d = primSlot ? primSlot._dbg : null, pu = units[0];
      const M = {};
      if (mine != null && theirs != null) M.losing_attrition = `our fleet ${mine} vs ${theirs}`;
      const twr = num(() => cmd.turretsLive()); if (twr != null) M.towers_down = `enemy towers ${twr}`;
      if (cmd._clearPathT > 0) M.clear_path = `${cmd._clearPathT.toFixed(0)}s left`;
      if (cmd._softenT > 0) M.soften = `${cmd._softenT.toFixed(0)}s left`;
      const scrap = num(() => cmd.scrap()); if (scrap != null) M.need_parts = `${scrap} scrap`;
      M['choose:capture'] = num(() => cmd.flagGrabbable()) ? 'flag is OPEN' : 'flag not grabbable';
      if (cmd.kills != null) M['choose:siege'] = `${cmd.kills} kills · ${cmd.deaths || 0} lost`;
      if (num(() => cmd.gambitOn())) M.gambit = 'gambit armed';
      if (num(() => cmd.ourFlagStolen())) M.flag_stolen = 'our flag STOLEN';
      if (num(() => cmd.ourFlagLoose())) {   // dropped in the field — how far the recovery drive is
        const fl = cmd.ourFlag(), uu = units[0] && primSlot ? primSlot.unit.holder.position : null;
        M.flag_loose = fl && uu ? `flag ${Math.hypot(uu.x - fl.group.position.x, uu.z - fl.group.position.z).toFixed(0)}u away` : 'flag on the ground';
      }
      if (d) {
        if (d.fof != null) { const f = `fightScore ${d.fof > 0 ? '+' : ''}${d.fof}`; M.engaging = f; M.underAttack = f; }
        if (pu && pu.fuel != null) M.resupLatched = `fuel ${pu.fuel}% · ammo ${pu.ammo}%`;
        if (d.turD != null) M.threatened = `tower ${d.turD}u out`;
        if (d.foeD != null) M.pursuing = `contact ${d.foeD}u out`;
      }
      const dbg = d ? { gd: d.gd, gx: d.gx, gz: d.gz, px: d.px, pz: d.pz, blk: d.blk, fwd: d.fwd, turn: d.turn,
        distFob: d.distFob, towers: d.towers, foeT: d.foeT, foeD: d.foeD, turD: d.turD, heard: !!d.heard,
        atHome: !!d.atHome, navPath: d.navPath, stuck: d.stuck, stuckWhy: d.stuckWhy, card: d.card, fof: d.fof } : null;
      // Fleet COMPOSITION (garage reserves by type), tourney-style: F2 L1 V2 J1.
      const comp = [['firebrat', 'F'], ['lurcher', 'L'], ['valkyrie', 'V'], ['jotun', 'J']]
        .map(([k, c]) => (cmd.roster && cmd.roster[k] > 0) ? c + cmd.roster[k] : '')
        .filter(Boolean).join(' ');
      // MISSIONSCORE BREAKDOWN — every candidate mission with its score and the terms behind it,
      // already sorted best-first. This is what the doctrine layer actually decides on now, so the
      // lab charts THIS rather than the old rung cascade (MissionScore gates most of those rungs
      // off, which is why the spine had nothing lit). Absent = weights off = the old ladder still
      // applies. ~13 entries, published on the same 2.5Hz throttle as everything else here.
      const scores = cmd._missionScores
        ? cmd._missionScores.map(([k, v, terms]) => [k, v, (terms || []).slice(0, 5)]) : null;
      // THE RE-THINK TRIGGERS, live. `_msnTrig` already holds each edge's current on/off state and
      // `_lastTrig` the one that last fired — the commander uses them every tick to decide whether
      // the plan is even worth re-examining. Publishing them is what lets the console show WHY a
      // re-score happened (or why one hasn't) instead of only its result.
      const trig = cmd._msnTrig ? { ...cmd._msnTrig } : null;
      // Where the driver is in its current order — the bottom of the console's stack.
      const drv = cmd._driver && cmd._driver.o
        ? { type: cmd._driver.o.type, x: Math.round(cmd._driver.o.x ?? 0), z: Math.round(cmd._driver.o.z ?? 0),
            arrive: cmd._driver.o.arrive || null, violated: !!cmd._driver.o.violated } : null;
      teams[label] = { archetype: cmd.archetype, mission: s.step, rung: s._firedRung || '', sub, why: s._lastWhy || '', scores,
        trig, lastTrig: s._lastTrig || '', sinceScore: +(s._scoreT || 0).toFixed(1), msnKey: cmd._msnKey || s.step, drv,
        fleet: mine, comp, color: teamColor(cmd.team),   // the ACTUAL in-game colour (the commander's pick), not a team-slot guess
        known: cmd._knownSummary ? cmd._knownSummary() : '', metrics: M, dbg, units };
    }
    // recent decision log tail, mapped to team labels (the on-screen feed, relocated to the console)
    const log = [];
    for (let i = Math.max(0, aiEvents.length - 60); i < aiEvents.length; i++) {
      const e = aiEvents[i];
      log.push({ t: e.t, team: _AI_LIVE_TEAM[e.team] || e.team, msg: e.msg });
    }
    localStorage.setItem('rmrf-ai-live', JSON.stringify({ t: Date.now(), over: matchOver, seed: AI_LOG_SEED, teams, log }));
  } catch (e) { /* no storage (private mode) — overlay just stays idle */ }
}

// Brief on-screen toast (flag captures, etc.).
function showBanner(text, opts = {}) {
  let el = document.getElementById('banner');
  if (!el) {
    el = document.createElement('div'); el.id = 'banner';
    el.style.cssText = 'position:fixed;top:18%;left:50%;transform:translateX(-50%);z-index:200;' +
      'font-family:"Courier New",monospace;font-weight:bold;letter-spacing:3px;' +
      'color:#fff;background:rgba(10,14,20,0.78);padding:14px 26px;border:1px solid rgba(255,255,255,0.35);' +
      'border-radius:6px;text-shadow:0 2px 4px rgba(0,0,0,0.6);pointer-events:none;transition:opacity 0.4s;text-align:center;';
    document.body.appendChild(el);
  }
  el.textContent = text; el.style.opacity = '1';
  el.style.fontSize = opts.big ? '46px' : '22px';
  el.style.color = opts.color || '#fff';
  clearTimeout(showBanner._t);
  if (!opts.persist) showBanner._t = setTimeout(() => { el.style.opacity = '0'; }, opts.ms || 2600);
}

// --- Victory / Defeat cinematic ----------------------------------------
// The win is the player Firebrat riding the stolen flag down the FOB lift. Over
// that live descent we rain team-colour confetti and pop a big VICTORY! title;
// a rival capture pops DEFEAT instead. Pure DOM overlay — no extra render passes.
// TEAM_COLORS[i].hex is already a CSS string ('#rrggbb').
function teamColor(team) {
  // An AI commander wears the colour IT picked — only the human's team reads
  // playerColorIndex. (Without the ctrl check, an AI 'red' team always showed RED,
  // since PLAYER_TEAM === 'red' and playerColorIndex defaults to the red slot.)
  const cmd = commanders.find(c => c.team === team && c.colorIndex != null);
  if (TEAM_CTRL[team] === 'human') return TEAM_COLORS[playerColorIndex] ? TEAM_COLORS[playerColorIndex].hex : '#ffffff';
  if (cmd && TEAM_COLORS[cmd.colorIndex]) return TEAM_COLORS[cmd.colorIndex].hex;
  return team === PLAYER_TEAM && TEAM_COLORS[playerColorIndex] ? TEAM_COLORS[playerColorIndex].hex : '#ffffff';
}
// Name flag messages after the flag's ACTUAL colour, not its internal team id —
// a team painted SNOW shouldn't read "RED FLAG TAKEN". Nearest palette swatch by
// RGB distance (tolerates emissive/recolour drift).
function colorName(hex) {
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  let best = 'FLAG', bestD = Infinity;
  for (const c of TEAM_COLORS) {
    const cr = parseInt(c.hex.slice(1, 3), 16), cg = parseInt(c.hex.slice(3, 5), 16), cb = parseInt(c.hex.slice(5, 7), 16);
    const d = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2;
    if (d < bestD) { bestD = d; best = c.name; }
  }
  return best;
}
function flagColorName(f) { return colorName('#' + f.cloth.material.color.getHexString()); }
// The palette NAME of a colour index (CYAN, PURPLE, GREY…) — the unambiguous team
// label in the log, so a line's identity matches the team's actual on-field colour.
function teamLabel(colorIndex) { const c = TEAM_COLORS[colorIndex]; return c ? c.name : '—'; }
// Lighten a team colour so it stays legible on the dark log panel while keeping its hue
// (the darker palette slots — RED, BLUE, PURPLE, GREY — are nearly black otherwise).
function logTint(hex) {
  let r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  if (lum < 150) { const k = 150 / Math.max(lum, 1); r = Math.min(255, r * k); g = Math.min(255, g * k); b = Math.min(255, b * k); }
  const f = v => Math.round(v).toString(16).padStart(2, '0');
  return '#' + f(r) + f(g) + f(b);
}
// A team's log colour: its real on-field tint, brightened for the panel.
function teamLogColor(team) { return logTint(teamColor(team)); }
// A team's PALETTE COLOUR NAME (GREY, PURPLE, CYAN…) for banners/menus — so a win
// message names the colour the team actually wears, never the internal red/blue id.
function teamColorName(team) { return colorName(teamColor(team)); }
// Remaining fleet as a glyph string, one letter per ALIVE vehicle (the fielded one
// counts until it dies), grouped by type: e.g. FFFFFF-LLL-VV-JJ → 6 Firebrats, 3
// Lurchers, 2 Valkyries, 2 Jotuns. Empty groups drop out; a wiped fleet shows "—".
function fleetStr(cmd) {
  const GLYPH = { firebrat: 'F', lurcher: 'L', valkyrie: 'V', jotun: 'J' };
  const parts = [];
  for (const t of ['firebrat', 'lurcher', 'valkyrie', 'jotun']) {
    const n = cmd.roster ? (cmd.roster[t] || 0) : 0;
    if (n > 0) parts.push(GLYPH[t].repeat(n));
  }
  return parts.length ? parts.join('-') : '—';
}
function ensureCelebStyle() {
  if (document.getElementById('celeb-style')) return;
  const s = document.createElement('style'); s.id = 'celeb-style';
  s.textContent = `
    #celeb-title { position:fixed; top:30%; left:50%; transform:translate(-50%,-50%) scale(0.4);
      z-index:300; font-family:"Courier New",monospace; font-weight:bold; letter-spacing:8px;
      font-size:84px; opacity:0; pointer-events:none; white-space:nowrap; text-align:center;
      text-shadow:0 4px 20px rgba(0,0,0,0.85); transition:opacity .45s ease, transform .6s cubic-bezier(.2,1.35,.4,1); }
    #celeb-title.in { opacity:1; transform:translate(-50%,-50%) scale(1); }
    #celeb-title .sub { display:block; margin-top:16px; font-size:21px; letter-spacing:5px; opacity:.85; color:#dfe8ef; }
    .confetti { position:fixed; top:-24px; width:10px; height:16px; z-index:290; pointer-events:none; will-change:transform; }
    @keyframes confetti-fall { to { transform:translateY(115vh) rotateZ(720deg); } }`;
  document.head.appendChild(s);
}
function showCelebTitle(text, color, sub) {
  ensureCelebStyle();
  let t = document.getElementById('celeb-title');
  if (!t) { t = document.createElement('div'); t.id = 'celeb-title'; document.body.appendChild(t); }
  t.style.color = color;
  t.innerHTML = text + (sub ? `<span class="sub">${sub}</span>` : '');
  t.classList.remove('in'); void t.offsetWidth;   // restart the pop-in transition
  requestAnimationFrame(() => t.classList.add('in'));
}
function hideCelebTitle() { const t = document.getElementById('celeb-title'); if (t) t.classList.remove('in'); }
// Rain confetti in (mostly) the team colour with a couple of bright accents. One
// staggered burst (per-piece CSS animation-delay) rather than a timer, so the rain
// can't be throttled away when the tab/render loop is busy.
function rainConfetti(color, durationMs = 5000) {
  ensureCelebStyle();
  const palette = [color, color, color, '#ffffff', '#ffd24a'];
  const secs = durationMs / 1000, N = Math.round(durationMs / 60);
  for (let i = 0; i < N; i++) {
    const c = document.createElement('div'); c.className = 'confetti';
    c.style.left = (Math.random() * 100) + 'vw';
    c.style.background = palette[(Math.random() * palette.length) | 0];
    if (Math.random() < 0.5) c.style.borderRadius = '50%';
    c.style.opacity = (0.75 + Math.random() * 0.25).toFixed(2);
    const dur = 2.4 + Math.random() * 1.9, delay = Math.random() * secs;
    c.style.animation = `confetti-fall ${dur.toFixed(2)}s linear ${delay.toFixed(2)}s forwards`;
    document.body.appendChild(c);
    setTimeout(() => c.remove(), (delay + dur) * 1000 + 80);
  }
}
function clearCeleb() {
  hideCelebTitle();
  document.querySelectorAll('.confetti').forEach(c => c.remove());
}
function playVictory(team) { const c = teamColor(team); rainConfetti(c, 6000); showCelebTitle('VICTORY!', c, 'FLAG SECURED'); }
function playDefeat() { clearCeleb(); showCelebTitle('DEFEAT', '#ff6a6a', 'FLAG LOST'); }

// --- AI decision log (debug overlay) --------------------------------------
// An on-screen window into what each AI commander is THINKING — live per-unit
// status + a rolling event feed. Built for phone debugging (no console). Toggle
// with the 'L' key or ?ailog; on by default while spectating AI-vs-AI.
// Three states: 'hidden' (just the top-right LOG button), 'brief' (top info + the
// single latest event — small, phone-friendly) and 'full' (whole window, scrollable
// through every event, with the game PAUSED). The box's own – / + header switches
// between them; – collapses (full→brief→hidden), + expands to full.
let aiLogMode = (QS.has('ailog') || SPECTATE) ? 'brief' : 'hidden';
let paused = false;    // game frozen while the log is expanded full-screen
const aiEvents = [];   // rolling [{t, team, msg}] — low-frequency DECISION events
// Build tag shown in the AI LOG header — pulled from THIS script's own ?v= cache-bust so it
// always reflects the build actually loaded (handy for confirming a phone got the new version).
const AI_LOG_BUILD = (() => { try { return 'v' + (new URL(import.meta.url).searchParams.get('v') || '?'); } catch (e) { return ''; } })();
// Seed tag in the header so a logged/screenshotted match is reproducible. Shows ?seed (the map
// seed); if ?dseed/?rngseed differ they're spelled out as s/d/r, else just the one shared seed.
const AI_LOG_SEED = (() => {
  const s = QS.get('seed'), d = QS.get('dseed'), r = QS.get('rngseed');
  if (s == null && d == null && r == null) return MAP_SEED != null ? `seed ${MAP_SEED}` : '';
  if (s != null && s === d && d === r) return `seed ${s}`;
  const parts = [];
  if (s != null) parts.push('s' + s);
  if (d != null) parts.push('d' + d);
  if (r != null) parts.push('r' + r);
  return 'seed ' + parts.join('/');
})();
const AI_LOG_TAG = AI_LOG_BUILD + (AI_LOG_SEED ? ' · ' + AI_LOG_SEED : '');
const _t0 = performance.now();
// Full-match structured archive of every decision event — the display buffer above trims to 80
// for the phone overlay, but headless analysis (RR.aiEvents()) needs the whole story. Callers
// may attach a `data` object (unit/state/pos/goal…) that rides along invisibly: the overlay
// only reads t/team/msg, while the archive keeps the structure for machine digestion.
const aiArchive = [];
function aiLog(team, msg, data = null) {
  const e = { t: +((performance.now() - _t0) / 1000).toFixed(1), team, msg };
  if (data) Object.assign(e, data);
  // data.quiet → archive-only: keeps rapid-fire flicker (state A↔B bounces) out of the visible
  // feed while the machine-readable archive still records every transition for analysis.
  if (!(data && data.quiet)) {
    aiEvents.push(e);
    while (aiEvents.length > 80) aiEvents.shift();   // deep enough to scroll back in full view
  }
  if (aiArchive.length < 30000) aiArchive.push(e);
}
// Vehicle-vs-vehicle hits are HIGH-frequency, so they get their own buffer (kept out of the
// decision feed so they don't flush the mission events) — shown only in the full/deep view.
const combatEvents = [];
function logCombat(team, msg) {
  combatEvents.push({ t: (performance.now() - _t0) / 1000, team, msg });
  while (combatEvents.length > 60) combatEvents.shift();
}
function setLogMode(mode) {
  aiLogMode = mode;
  paused = (mode === 'full');
  updateLogToggle();
  updateAstarToggle();
  updateAiLog();
}
function ensureLogStyle() {
  if (document.getElementById('ai-log-style')) return;
  const s = document.createElement('style'); s.id = 'ai-log-style';
  s.textContent = `
    #ai-log { position:fixed; z-index:150; pointer-events:none; font-family:"Courier New",monospace;
      color:#dfe8ef; background:rgba(8,12,18,0.8); border:1px solid rgba(255,255,255,0.18);
      border-radius:6px; text-shadow:0 1px 2px rgba(0,0,0,0.8); font-variant-numeric:tabular-nums; }
    #ai-log.brief { top:12px; right:12px; width:360px; max-width:90vw; }
    #ai-log.full  { inset:10px; pointer-events:auto; display:flex; flex-direction:column; }
    #ai-log-head { display:flex; align-items:center; justify-content:space-between; pointer-events:auto;
      padding:6px 6px 6px 9px; border-bottom:1px solid rgba(255,255,255,0.14); }
    #ai-log-title { font-weight:bold; font-size:12px; letter-spacing:2px; }
    #ai-log-btns { display:flex; gap:6px; }
    #ai-log .lg-btn { width:26px; height:26px; line-height:24px; text-align:center; cursor:pointer;
      border:1px solid rgba(255,255,255,0.3); border-radius:5px; background:rgba(255,255,255,0.07);
      font-weight:bold; font-size:16px; user-select:none; -webkit-user-select:none; touch-action:manipulation; }
    #ai-log .lg-btn:active { background:rgba(255,255,255,0.22); }
    #ai-log .lg-link { display:inline-flex; align-items:center; height:26px; padding:0 9px;
      font-size:10px; letter-spacing:1px; color:#7dd3fc; text-decoration:none; border-radius:4px;
      background:rgba(125,211,252,0.12); }
    #ai-log .lg-link:active { background:rgba(125,211,252,0.26); }
    #ai-log-body { padding:7px 8px; font-size:11px; line-height:1.4; letter-spacing:0.2px; white-space:pre-wrap; }
    #ai-log.brief #ai-log-body { overflow:hidden; }
    #ai-log.full  #ai-log-body { overflow-y:auto; flex:1; -webkit-overflow-scrolling:touch; }
    /* One box per team: status (mission/known/fleet) + that team's latest event. */
    #ai-log .tbox { border-left:3px solid #888; border-radius:4px; background:rgba(255,255,255,0.035);
      padding:4px 8px; margin:0 0 6px; }
    #ai-log .tbox:last-child { margin-bottom:0; }
    #ai-log .tb-h { font-weight:bold; letter-spacing:0.6px; font-size:12px; }
    #ai-log .tb-l { opacity:0.82; }
    #ai-log .tb-ev { margin-top:3px; opacity:0.95; }
    #ai-log .tb-t { opacity:0.6; }
    #ai-log .tb-feed { margin-top:4px; border-top:1px solid rgba(255,255,255,0.14); padding-top:6px; opacity:0.92; }`;
  document.head.appendChild(s);
}
function ensureAiLogEl() {
  let el = document.getElementById('ai-log');
  if (el) return el;
  ensureLogStyle();
  el = document.createElement('div'); el.id = 'ai-log';
  el.innerHTML =
    `<div id="ai-log-head"><span id="ai-log-title">AI LOG · ${AI_LOG_TAG}</span>` +
    '<span id="ai-log-btns"><a class="lg-link" href="ai-lab/" target="_blank" rel="noopener" title="Open the AI Lab live console (split A|B + full log)">LAB ↗</a>' +
    '<span class="lg-btn" data-act="export" title="Copy a snapshot to share">⧉</span>' +
    '<span class="lg-btn" data-act="minus">–</span>' +
    '<span class="lg-btn" data-act="plus">+</span></span></div>' +
    '<div id="ai-log-body"></div>';
  el.addEventListener('pointerdown', e => {
    const b = e.target.closest('.lg-btn'); if (!b) return;
    e.preventDefault(); e.stopPropagation();
    if (b.dataset.act === 'export') exportLog();
    else if (b.dataset.act === 'minus') setLogMode(aiLogMode === 'full' ? 'brief' : 'hidden');
    else setLogMode('full');
  });
  document.body.appendChild(el);
  return el;
}
// Trim a log event down to just its CHANGING part for a team's brief box: the box
// already shows the team colour, vehicle and personality, so drop a leading "COLOUR"
// (and a following vehicle-type word) and a trailing "[card]".
const _VTYPES = ['firebrat', 'lurcher', 'valkyrie', 'jotun'];
function briefEvent(cmd, msg) {
  let m = msg;
  if (cmd.cname && m.toUpperCase().startsWith(cmd.cname.toUpperCase())) m = m.slice(cmd.cname.length);
  m = m.replace(/^[\s:·—-]+/, '');                                   // leading separators
  for (const t of _VTYPES) if (m.toLowerCase().startsWith(t)) { m = m.slice(t.length).replace(/^[\s:·—-]+/, ''); break; }
  m = m.replace(/\s*\[[^\]]*\]\s*$/, '');                            // trailing [card]
  return m.trim();
}
let _aiLogPaintT = 0;
function updateAiLog() {
  const el = document.getElementById('ai-log');
  if (aiLogMode === 'hidden') { if (el) el.style.display = 'none'; return; }
  // 5Hz repaint — this rebuilds the whole panel's HTML, which at 60fps was one of the
  // biggest CPU lines in the phone trace (~4% of all samples). Nothing here changes
  // faster than a few times a second.
  const nowMs = performance.now();
  if (nowMs - _aiLogPaintT < 200) return;
  _aiLogPaintT = nowMs;
  const box = ensureAiLogEl(); box.style.display = '';
  box.className = aiLogMode;
  document.getElementById('ai-log-title').textContent = aiLogMode === 'full' ? `AI LOG · ${AI_LOG_TAG} · PAUSED` : `AI LOG · ${AI_LOG_TAG}`;
  // The most-recent event for a team (its "running" line), or null.
  const latestFor = team => { for (let i = aiEvents.length - 1; i >= 0; i--) if (aiEvents[i].team === team) return aiEvents[i]; return null; };
  let html = '';
  // ONE BOX PER TEAM. Each box = that team's persistent status (the mission, the known
  // POIs, fleet) PLUS its single latest event — so a team's whole picture sits together,
  // identified by its colour, instead of all status then a shared event feed.
  for (const cmd of commanders) {
    const col = teamLogColor(cmd.team);
    const known = cmd._knownSummary ? cmd._knownSummary() : 'none';
    html += `<div class="tbox" style="border-color:${col}">`;
    // One status block PER SLOT (multi-unit: each fielded unit runs its own role card).
    // Single-slot teams render exactly the old one-unit box.
    const multi = cmd._slots.length > 1;
    cmd._slots.forEach((sl, i) => {
      const d = sl._dbg && sl.unit ? sl._dbg : null;   // a dead/respawning slot shows DEPLOYING, not its ghost's last stats
      const strat = sl.strategy;
      const mission = (strat && strat.step ? strat.step : '—').toUpperCase();
      const type = d ? d.type.toUpperCase() : 'DEPLOYING';
      const card = d ? d.card : (strat ? (strat.constructor.name || '').replace('Strategy', '') : '');
      // Header: COLOUR · VEHICLE · MISSION · PERSONALITY (slot rows after the first drop the colour name).
      html += `<div class="tb-h" style="color:${col}">${i === 0 ? cmd.cname + ' · ' : ''}${multi ? (i + 1) + '· ' : ''}${type} · ${mission}${card ? ` · ${card.toUpperCase()}` : ''}</div>`;
      if (d) {
        const fof = d.fof != null ? ` · <span style="color:${d.fof > 0 ? '#7fffb8' : '#ff9d7f'}">fof ${d.fof > 0 ? '+' : ''}${d.fof}</span>` : '';
        const det = stateDetail(d, d.state);   // the state's object — "suppress" alone says nothing
        html += `<div class="tb-l">${d.state}${det ? ` <span style="opacity:0.75">${det}</span>` : ''}</div>`;
        html += `<div class="tb-l">hp ${d.hp}% · ammo ${d.ammo} · fuel ${d.fuel}/${d.maxFuel}${fof} · fob ${d.distFob}</div>`;
        // WHERE it's headed (stable line) then, on its OWN line, the per-tick DRIVE readout —
        // blk first, then fwd/turn. Both are kept off the position line and fixed-width so the
        // rapidly-changing numbers can't wrap/resize the box and scramble everything above.
        const to = d.gx != null ? `(${d.gx},${d.gz}) ${d.gd}u` : '—';
        const flags = (d.atHome ? ' · atBase' : '') + (d.navPath ? ` · path ${d.navPath}` : '');
        const sgn = n => (Number(n) >= 0 ? ' ' : '') + Number(n).toFixed(2);   // fixed 5-char width (leading space for +)
        html += `<div class="tb-l">@(${d.px},${d.pz}) → ${to}${flags}</div>`;
        html += `<div class="tb-l" style="opacity:0.6">blk ${d.blk} · drive ${sgn(d.fwd)}/${sgn(d.turn)}</div>`;
        if (d.stuck) html += `<div class="tb-l" style="color:#ffb030">⚠ STUCK ${d.stuck}s — ${d.stuckWhy}</div>`;
      }
    });
    const dAny = cmd._slots.map(s => s._dbg).find(Boolean);
    html += `<div class="tb-l">twrs ${dAny ? dAny.towers : '?'} · knows ${known}</div>`;
    html += `<div class="tb-l">fleet ${fleetStr(cmd)}</div>`;
    const ev = latestFor(cmd.team);
    // The box already names the team/vehicle/personality, so the event shows only the
    // changing part (front "COLOUR vehicle:" + trailing "[card]" stripped).
    if (ev) html += `<div class="tb-ev" style="color:${col}"><span class="tb-t">${ev.t.toFixed(0)}s</span> ${briefEvent(cmd, ev.msg)}</div>`;
    html += `</div>`;
  }
  // Full view also gets the whole chronological feed below the boxes (scrollable).
  if (aiLogMode === 'full') {
    html += `<div class="tb-feed">`;
    for (let i = aiEvents.length - 1; i >= 0; i--) {
      const e = aiEvents[i];
      html += `<div><span class="tb-t">${e.t.toFixed(0)}s</span> <span style="color:${teamLogColor(e.team)}">${e.msg}</span></div>`;
    }
    html += `</div>`;
    // Separate COMBAT feed (vehicle-vs-vehicle hits), dimmed so it reads as a sub-log.
    if (combatEvents.length) {
      html += `<div class="tb-feed" style="opacity:0.72;border-top:1px solid #2c4a3a;margin-top:4px">`;
      html += `<div style="color:#8fae9c;letter-spacing:1px;font-size:9px">— COMBAT —</div>`;
      for (let i = combatEvents.length - 1; i >= 0; i--) {
        const e = combatEvents[i];
        html += `<div><span class="tb-t">${e.t.toFixed(0)}s</span> <span style="color:${teamLogColor(e.team)}">${e.msg}</span></div>`;
      }
      html += `</div>`;
    }
  }
  document.getElementById('ai-log-body').innerHTML = html;
}

// Build a plain-text snapshot of the whole AI state — per-team status (mission, goal,
// hp/ammo/fuel, position) + the full recent event feed — for the player to copy and paste
// when they spot odd behaviour (saves typing it all out). Read-only; safe to call anytime.
function buildLogExport() {
  const ver = (((document.querySelector('script[src*="main.js"]') || {}).src || '').match(/v=(\d+)/) || [])[1] || '?';
  const human = TEAM_CTRL[PLAYER_TEAM] === 'human';
  const t = ((performance.now() - _t0) / 1000).toFixed(0);
  // The seed rides in the header so a pasted deep log is reproducible — the brief-log title shows
  // it too but that text isn't selectable on a phone; this copyable overlay is where it's grabbable.
  let s = `=== RMRF LOG (v${ver}${AI_LOG_SEED ? ' · ' + AI_LOG_SEED : ''}) ===\nmode: ${human ? 'Player vs AI' : 'AI vs AI'}   t: ${t}s\n`;
  if (player && !player.dead) {
    const pp = player.holder.position;
    s += `player: ${player.type} hp ${Math.round(player.hp / player.maxHp * 100)}% ammo ${player.ammo} @ (${Math.round(pp.x)},${Math.round(pp.z)})\n`;
  }
  for (const cmd of commanders) {
    const known = cmd._knownSummary ? cmd._knownSummary() : 'none';
    // One block per SLOT (multi-unit: each fielded unit runs its own role card). The slot
    // is BOUND while its lines build so objectiveLabel reads the right unit's context.
    cmd._slots.forEach((sl, i) => {
      cmd._bind(i);
      const d = cmd._dbg && cmd.unit ? cmd._dbg : null;
      const mission = ((cmd.strategy && cmd.strategy.step) || '—').toUpperCase();
      const goalLbl = cmd._intercepting ? 'intercept runner' : cmd._shielding ? 'grab shield'
        : (cmd.strategy && cmd.strategy.objectiveLabel ? cmd.strategy.objectiveLabel(cmd) : '—');
      s += `\n[${cmd.cname}${cmd._slots.length > 1 ? ' ' + (i + 1) : ''}] ${d ? d.type : 'deploying'} · ${mission}${d ? ` [${d.card}]` : ''}\n`;
      if (d) {
        s += `  ${d.state} → ${goalLbl}\n`;
        s += `  hp ${d.hp}% ammo ${d.ammo} fuel ${d.fuel} shld ${d.shield}\n`;
        s += `  pos (${d.px},${d.pz}) goal (${d.gx},${d.gz}) fob ${d.distFob}u blk ${d.blk} f/t ${d.fwd}/${d.turn}\n`;
        if (d.stuck) s += `  STUCK ${d.stuck}s — ${d.stuckWhy}\n`;
      }
      cmd._unbind(i);
    });
    const dAny = cmd._slots.map(sl => sl._dbg).find(Boolean);
    s += `  enemy twrs ${dAny ? dAny.towers : '?'} · knows ${known} · fleet ${fleetStr(cmd)}\n`;
  }
  s += `\n--- events (newest first) ---\n`;
  for (let i = aiEvents.length - 1; i >= 0; i--) s += `${aiEvents[i].t.toFixed(0)}s ${aiEvents[i].msg}\n`;
  if (combatEvents.length) {
    s += `\n--- combat (newest first) ---\n`;
    for (let i = combatEvents.length - 1; i >= 0; i--) s += `${combatEvents[i].t.toFixed(0)}s ${combatEvents[i].msg}\n`;
  }
  return s;
}
// Copy the snapshot to the clipboard; always also pop a selectable overlay (the secure
// clipboard API is blocked on plain http, e.g. the phone over duckdns, so the overlay is
// the reliable fallback — pre-selected text + a Copy button using the legacy execCommand).
function exportLog() {
  const txt = buildLogExport();
  let copied = false;
  try { if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(txt); copied = true; } } catch (e) { /* http → fall back to overlay */ }
  showExportOverlay(txt, copied);
}
function showExportOverlay(txt, copied) {
  let ov = document.getElementById('log-export');
  if (!ov) {
    ov = document.createElement('div'); ov.id = 'log-export';
    ov.style.cssText = 'position:fixed;inset:0;z-index:400;background:rgba(0,0,0,0.85);display:flex;flex-direction:column;padding:14px;gap:10px;';
    ov.innerHTML = '<div style="display:flex;gap:8px;align-items:center;font-family:\'Courier New\',monospace">'
      + '<span id="lx-status" style="color:#dfe8ef;font-size:13px;flex:1"></span>'
      + '<span id="lx-copy" class="lx-b">Copy</span><span id="lx-close" class="lx-b">Close</span></div>'
      + '<textarea id="lx-text" readonly></textarea>';
    document.body.appendChild(ov);
    const style = document.createElement('style');
    style.textContent = '#log-export .lx-b{padding:9px 16px;border:1px solid #567;border-radius:6px;color:#dfe8ef;'
      + 'background:rgba(255,255,255,0.1);font:bold 13px "Courier New",monospace;cursor:pointer;'
      + 'user-select:none;-webkit-user-select:none;touch-action:manipulation}'
      + '#log-export .lx-b:active{background:rgba(255,255,255,0.25)}'
      + '#lx-text{flex:1;width:100%;background:#0b0f14;color:#cfe3ef;border:1px solid #2c3a47;border-radius:6px;'
      + 'padding:8px;font:11px/1.4 "Courier New",monospace;white-space:pre;-webkit-user-select:text;user-select:text}';
    document.head.appendChild(style);
    ov.addEventListener('pointerdown', e => {
      if (e.target.id === 'lx-close') { e.preventDefault(); ov.style.display = 'none'; }
      else if (e.target.id === 'lx-copy') {
        e.preventDefault();
        const ta = document.getElementById('lx-text');
        ta.focus(); ta.select(); try { ta.setSelectionRange(0, ta.value.length); } catch (e2) {}
        let ok = false;
        try { ok = document.execCommand('copy'); } catch (e3) {}
        if (!ok) { try { navigator.clipboard.writeText(ta.value); ok = true; } catch (e4) {} }
        document.getElementById('lx-status').textContent = ok ? '✓ Copied — paste it to Claude' : 'Select the text above, then copy';
      }
    });
  }
  ov.style.display = 'flex';
  const ta = document.getElementById('lx-text');
  ta.value = txt;
  document.getElementById('lx-status').textContent = copied ? '✓ Copied — paste it to Claude' : 'Tap Copy, then paste it to Claude';
  setTimeout(() => { try { ta.focus(); ta.select(); } catch (e) {} }, 30);
}

// A flag was carried home → that team wins. Freeze the field, announce, then reset
// (human → back to the garage for a fresh run; AI-vs-AI → re-arm the flags + play on).
function endMatch(winner) {
  if (matchOver) return;
  matchOver = true;
  publishAILive(1);   // one final ai-lab snapshot, flagged over — updateCommanders (the usual publisher) stops now
  lastWinner = winner;   // team key, for harnesses (RR.matchWinner) — the celeb title only carries the colour name
  const human = TEAM_CTRL[PLAYER_TEAM] === 'human';
  const won = winner === PLAYER_TEAM;
  matchWon = won;
  if (!human) { playVictory(winner); showCelebTitle(`${teamColorName(winner)} WINS`, teamColor(winner)); }
  else if (won) playVictory(PLAYER_TEAM);   // a non-extraction win (e.g. AI ally caps) still celebrates
  else playDefeat();
  try { if (sound && sound.enabled) sound.toggle(); } catch (e) { /* quiet the engine */ }
  setTimeout(() => {
    const el = document.getElementById('banner'); if (el) el.style.opacity = '0';
    if (human) { if (player && playerElev) { leftPad = true; beginReturn(); } else returnToGarage(); }
    // AI-vs-AI: the match is decided — open the play-again menu over the frozen field
    // (reload starts a fresh game; nothing rebuilds in place).
    else showGameMenu({ header: `${teamColorName(winner)} WINS`, sub: 'MATCH OVER', reload: true });
  }, 5000);
}

// WHAT IS IN THE WAY — the first obstacle straddling the segment a→b, walking out from a, or
// null for a clear line. This test always knew which piece blocked the shot; it just threw the
// answer away and returned a bare false, so every caller that needed to DO something about the
// obstruction had to go looking for it again with a guess ("the nearest wall in their camp").
// The guess and the answer are different things: the nearest wall is wherever we happen to be
// standing relative to the ring, while the blocker is on the line by construction — so if the
// target is inside our reach, the blocker is too, and breaking it MAKES the line. That is the
// whole of the siege-flatten rule, and it needs no second algorithm to state it.
// skipTeam: never nominate our OWN wall as something to shoot through.
function losBlocker(ax, az, bx, bz, skipTeam) {
  const dx = bx - ax, dz = bz - az;
  const len = Math.hypot(dx, dz) || 1;
  const steps = Math.ceil(len / 4);
  for (let s = 1; s < steps; s++) {
    const t = s / steps, x = ax + dx * t, z = az + dz * t;
    for (const o of obstacles) {
      if (o.body && o.body.dead) continue;           // a downed wall no longer blocks line of sight
      if (skipTeam && o.team === skipTeam) continue;
      const ox = x - o.x, oz = z - o.z;
      if (ox * ox + oz * oz < o.r * o.r) return o;
    }
  }
  return null;
}
// Line of sight: blocked if any wall obstacle straddles the segment a→b. Own walls block the
// eye exactly as they always did — only the demolish pick skips them.
function hasLOS(ax, az, bx, bz) { return !losBlocker(ax, az, bx, bz); }

// --- Collision ---------------------------------------------------------
// Solid wall pieces the player can't drive through (gates excluded — drive-through).
let obstacles = [];           // { x, z, r }
let gates = [];               // { w, team, gx, gz, isEW, halfRun, halfNorm } — doored openings that block enemies when closed
const gateCells = new Map();  // grid cell "i,j" → the gate WallPiece controlling that lane (open for allies, closed = blocked for enemies)
const gateSideCells = new Set();  // the gate's flanking cells — open to the eye but a full-radius vehicle scrapes the jamb there, so A* must NOT use them
let islandBound = 0;          // radius (from map centre) past which no vehicle may go
// Does gate `w` currently block a vehicle of `team`? Breached, ownerless, held-open, or
// friendly all pass; otherwise a shut gate stops the enemy (who must destroy it to breach).
function gateBlocks(w, team) {
  if (!w || (w.body && w.body.dead)) return false;
  if (w._gateTeam == null) return false;
  if (team === w._gateTeam) return false;
  return !w.gateOpen;
}
function buildObstacles() {
  bumpNavEpoch();   // the whole obstacle set is being rebuilt — every cached path is suspect
  obstacles = [];
  gates = [];
  gateCells.clear();
  gateSideCells.clear();
  const c0 = grid.cell;
  for (const c of camps) for (const w of c.walls) {
    if (w.type && w.type.startsWith('GATE')) {
      // The gate opening is 3 cells wide, but a full-radius vehicle can only clear
      // it dead-centre (the flanking lanes scrape the wall the inflated obstacles
      // don't quite reach with the gentle nav margin). So carve a SINGLE-FILE centre
      // throat: open + road-cheap down the middle, and explicitly block the side
      // lanes through the gate plane so A* threads the centre instead of the jamb.
      const gx = w.group.position.x, gz = w.group.position.z;
      const gi = Math.round(gx / c0), gj = Math.round(gz / c0);
      const dx = gx - c.center.x, dz = gz - c.center.z;
      const sx = Math.abs(dx) >= Math.abs(dz) ? Math.sign(dx) : 0;
      const sz = Math.abs(dx) >= Math.abs(dz) ? 0 : Math.sign(dz);
      const px = sx !== 0 ? 0 : 1, pz = sx !== 0 ? 1 : 0;   // along-the-wall (perpendicular to the normal)
      for (let k = -2; k <= 2; k++) {
        gateCells.set((gi + sx * k) + ',' + (gj + sz * k), w);
        if (k >= -1 && k <= 1)
          for (const s of [-1, 1]) gateSideCells.add((gi + sx * k + px * s) + ',' + (gj + sz * k + pz * s));
      }
      w._gateTeam = c.team;
      gates.push({ w, team: c.team, gx, gz, nx: sx, nz: sz, px, pz, halfRun: (w.span || 3) * c0 * 0.45, halfNorm: c0 * 0.32 });
      continue;
    }
    obstacles.push({ x: w.group.position.x, z: w.group.position.z, team: c.team, body: w.body,
                     r: w.type === 'CORNER' ? grid.cell * 0.7 : grid.cell * 0.5 });
  }
  // Designer-placed forts: walls/towers block as circles; gates block their two posts
  // and leave the centre cell drivable (so a placed gate is a real opening in a wall line).
  for (const w of placedWalls) {
    if (w.type && w.type.startsWith('GATE')) {
      const isEW = w.type === 'GATE_EW';
      const off = (w.span * c0) / 2 - c0 * 0.15;   // posts near the span's ends
      for (const s of [-1, 1]) {
        const px = isEW ? w.group.position.x + s * off : w.group.position.x;
        const pz = isEW ? w.group.position.z : w.group.position.z + s * off;
        obstacles.push({ x: px, z: pz, team: w._team, body: w.body, r: c0 * 0.35 });
      }
      w._gateTeam = w._team;   // may be null (neutral placed gate → stays open, see updateGates)
      gates.push({ w, team: w._team ?? null, gx: w.group.position.x, gz: w.group.position.z,
                   nx: isEW ? 0 : 1, nz: isEW ? 1 : 0, px: isEW ? 1 : 0, pz: isEW ? 0 : 1,
                   halfRun: (w.span || 3) * c0 * 0.45, halfNorm: c0 * 0.32 });
      continue;
    }
    obstacles.push({ x: w.group.position.x, z: w.group.position.z, team: w._team, body: w.body,
                     r: w.type === 'CORNER' ? c0 * 0.7 : c0 * 0.5 });
  }
  // The flag HQ is a SOLID building, not a drive-through. Add it as an obstacle so vehicles
  // STOP at it (and a sieger nosed against it shoots it down — that's the breach path that
  // actually cracks the HQ + exposes the flag) and A* routes around it instead of plowing
  // through. The surrounding ring is road (handled first in blockedFor/cellBlocked) so the
  // approach lanes stay open; once the HQ is rubble the dead-body skip below lets the flag
  // runner roll over the wreck to the flag. Radius ≈ the cell*1.7 footprint half.
  for (const c of camps) {
    if (!c.flagHQ || c.flagHQ.dead) continue;
    obstacles.push({ x: c.center.x, z: c.center.z, team: c.team, body: c.flagHQ, r: grid.cell * 0.85 });
  }
  // Soft world edge: a ring ~70u beyond the outermost base. Keeps flyers (which
  // cross water) from wandering off the island into open ocean / the void. Land
  // craft already drown in the sea well before this. (See the ocean-submarine TODO.)
  let maxCamp = 0;
  for (const c of camps) maxCamp = Math.max(maxCamp, Math.hypot(c.center.x, c.center.z));
  islandBound = maxCamp + 70;
  buildObsBuckets();
}
// OBSTACLE BUCKETS — cellBlocked used to scan all 80 obstacles for EVERY cell A* touched, which
// on a 9216-cell grid is the single most-executed loop in the game (42.5% of sampled CPU in
// Jacob's laptop trace). Each obstacle only blocks the handful of cells within its radius, so
// register it into those cells once and the per-cell check reads a list that is almost always
// empty. Rebuilt with the obstacle array; the body-dead test stays per-query so a destroyed wall
// opens its gap immediately without a rebuild.
// STATIC NAV BITMAP — everything cellBlocked asks that cannot change during a match, answered
// once when the map is built instead of on every cell of every search (Jacob: "can we just do it
// before the game starts?"). The terrain never moves, so the deep-water footprint test — up to
// EIGHT map.isDeepWater calls per cell for a sinking hull — is pure repeated work. Roads, gate
// flanks, pads and the world/island bounds are laid down at build time and equally fixed.
// What stays live: gates (open per team), navAvoid (expiring), and obstacles (walls die).
// One byte per cell over a 96×96 grid is ~9KB.
const NAVF = { OOB: 1, ROAD: 2, FLANK: 4, SINKSOFT: 16, SINKHARD: 32 };   // NO PAD — see cellBlocked
let navStatic = null, navStaticN = 0, navStaticHalf = 0;
const navIdx = (i, j) => {
  const a = i + navStaticHalf, b = j + navStaticHalf;
  return (a < 0 || b < 0 || a >= navStaticN || b >= navStaticN) ? -1 : b * navStaticN + a;
};
// REACHABILITY AS A FIELD, NOT AS A QUESTION ASKED N TIMES. One breadth-first flood from the
// unit's own cell over the same blocked test A* uses, 8-connected, ~96x96 cells. Every cell it
// reaches is somewhere this hull can actually drive to; every cell it doesn't, isn't.
//
// This is how the standoff playground (lab/standoff-lab.html) has always worked, and why it finds
// good firing positions when the game struggles to: the lab floods once and then judges EVERY
// reachable cell, while _standoffFor used to sample 24 points on three or four fixed radii and
// could afford about five real A* searches before giving up and abandoning the tower. The flood is
// both more thorough and far cheaper — one pass over 9k cells instead of five full-grid searches —
// so the search stops being rationed.
//
// Cached per unit for a beat: a siege solves a spot for several towers in the same breath, and the
// hull has not moved between them.
const FLOOD_TTL = 400;   // ms a reachability flood stays good for (the unit has barely moved)
function reachFrom(v) {
  if (!navStatic) buildNavStatic();
  const c = grid.cell;
  const i0 = Math.round(v.holder.position.x / c), j0 = Math.round(v.holder.position.z / c);
  const memo = v.__reach;
  if (memo && memo.i === i0 && memo.j === j0 && performance.now() - memo.t < FLOOD_TTL) return memo.R;
  const R = new Uint8Array(navStaticN * navStaticN);
  const start = navIdx(i0, j0);
  if (start < 0) return R;
  // Start cell blocked (parked against a wall, mid-gate) would flood nothing at all, so seed it
  // regardless — we are demonstrably able to be here.
  R[start] = 1;
  const qi = new Int16Array(R.length), qj = new Int16Array(R.length);
  qi[0] = i0; qj[0] = j0;
  let head = 0, tail = 1;
  while (head < tail) {
    const i = qi[head], j = qj[head]; head++;
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
      if (!di && !dj) continue;
      const ni = i + di, nj = j + dj, k = navIdx(ni, nj);
      if (k < 0 || R[k]) continue;
      if (cellBlocked(v, ni, nj)) continue;
      // MIRROR A*'s CORNER RULE (astar.js: "a diagonal step is only allowed if both
      // orthogonally-adjacent cells are passable, so units don't clip the corner of a
      // wall/building"). A flood that squeezes through diagonal gaps the router will not take
      // marks ground as reachable that no route can deliver — the unit is then sent to a firing
      // position, gets no path, and stands there until the watchdog destroys it. A reachability
      // field is only worth having if it answers the same question the router answers.
      if (di !== 0 && dj !== 0 && (cellBlocked(v, i, nj) || cellBlocked(v, ni, j))) continue;
      R[k] = 1; qi[tail] = ni; qj[tail] = nj; tail++;
    }
  }
  v.__reach = { i: i0, j: j0, t: performance.now(), R };
  return R;
}
function buildNavStatic() {
  const c = grid.cell;
  const iMax = Math.ceil(map.worldW / 2 / c) + 12;
  navStaticHalf = iMax; navStaticN = iMax * 2 + 1;
  navStatic = new Uint8Array(navStaticN * navStaticN);
  const halfW = map.worldW / 2 + 24, halfH = map.worldH / 2 + 24;
  // WATER CLEARANCE IS NOT COLLISION CLEARANCE. This used VEH_R, the radius a hull needs to keep
  // clear of walls and trees — and borrowing it for water asks the wrong question. You cannot clip
  // the corner of a wall; you absolutely can carry a tread over slightly deeper water, which is
  // most of what giant treads and six legs are FOR.
  //
  // At 3.0 the effect was to delete the shallow fringe from the map wholesale: on a natural
  // shoreline shallow grades into deep over a few units, so nearly every fordable cell had deep
  // water within 3u of one of its eight samples, diagonals included. The cell a unit would stand
  // in was never the thing being tested. Jotuns and Lurchers routed the long way around water they
  // would have waded straight through — and they are the only two chassis this can affect, since
  // the Firebrat hovers and the Valkyrie flies (VEH_MOVE water: 'cross').
  //
  // 1.0 keeps the honest part of the test — the body's own footing has to be sound — and drops the
  // rest. Depth itself is unchanged: FORD_DEPTH still says what a hull can wade.
  //
  // GATED AND KEPT. Wadeable-and-navigable shoreline goes 71.8% -> 87.8% across four maps, and
  // units use it: shoreline traffic +45%. The near-water stuck count rises with it, which read as
  // a regression for a while and is not one — it is the DENOMINATOR moving. Measured as a rate,
  // a unit near water is stuck 9.61% of its time there before and 9.60% after: identical. It is
  // not coping worse, it is simply wading instead of walking around. Totals improve — transit
  // stuck 822 -> 718, inland 627 -> 439 — with nav alarms and scuttles unchanged.
  //
  // The anti-shore-grind reflex was removed alongside this: it cut a sinker's throttle near deep
  // water, which is exactly the ground this halo opens up, and leaving the two together cost
  // alarms 46 -> 65 and scuttles 13 -> 16 for nothing.
  const FORD_CLEAR = 1.0;
  const rSoft = VEH_R * 0.85, rHard = aiFordHalo ? FORD_CLEAR : VEH_R;
  for (let i = -iMax; i <= iMax; i++) for (let j = -iMax; j <= iMax; j++) {
    const x = i * c, z = j * c;
    let f = 0;
    if (x < -halfW || x > halfW || z < -halfH || z > halfH) f |= NAVF.OOB;
    else if (islandBound && x * x + z * z > islandBound * islandBound) f |= NAVF.OOB;
    if (roadNet.cells && roadNet.cells.has(i + ',' + j)) f |= NAVF.ROAD;
    if (gateSideCells.has(i + ',' + j)) f |= NAVF.FLANK;
    // The sinker footprint, baked for BOTH ford settings. Neither implies the other — the soft
    // test uses a smaller radius and skips the diagonals — so they get a bit each and the live
    // path just picks one. aiSoftFord defaults OFF, so HARD is the hot one: nine isDeepWater
    // calls per cell, on every cell of every search, for terrain that never changes.
    if (!map.isLand(x, z)) {
      const deep = map.isDeepWater.bind(map);
      if (deep(x, z)) { f |= NAVF.SINKSOFT | NAVF.SINKHARD; }
      else {
        if (deep(x + rSoft, z) || deep(x - rSoft, z) || deep(x, z + rSoft) || deep(x, z - rSoft)) f |= NAVF.SINKSOFT;
        if (deep(x + rHard, z) || deep(x - rHard, z) || deep(x, z + rHard) || deep(x, z - rHard)
          || deep(x + rHard, z + rHard) || deep(x + rHard, z - rHard)
          || deep(x - rHard, z + rHard) || deep(x - rHard, z - rHard)) f |= NAVF.SINKHARD;
      }
    }
    const k = navIdx(i, j); if (k >= 0) navStatic[k] = f;
  }
}
// LANDMASS LABELS — which cells a ground vehicle can reach from which. Flood-filled over the
// static bitmap using TERRAIN alone (world edge + water), so like the rest of the bitmap it is
// baked once and never changes during a match.
//
// Buildings, walls and gates are deliberately left OUT, which makes this a one-way test: two
// cells in DIFFERENT components definitely cannot be driven between, while two in the SAME
// component merely might be. That direction is the useful one — a cheap, certain no.
//
// It exists because several systems pick a destination off the terrain and never ask whether
// the unit can get there: the scout's recon waypoints come from "unexplored land", the siege
// standoff spot from "somewhere with a shot". A target across a channel sends a ground unit to
// the shoreline, where it grinds until the stuck watchdog scuttles it — a vehicle lost, an
// alarm raised, and a mission marked failed at something it was never able to attempt.
//
// Uses the SOFT sinker footprint on purpose (the smaller radius, no diagonals): it blocks
// fewer cells, so the components come out as generous as possible and "different landmass"
// stays a claim worth acting on.
let navComp = null;
function buildNavComp() {
  const N = navStaticN, WET = NAVF.OOB | NAVF.SINKSOFT;
  navComp = new Int32Array(N * N);   // 0 = water/off-map, ≥1 = landmass id
  const stack = []; let next = 0;
  for (let s = 0; s < navComp.length; s++) {
    if (navComp[s] || (navStatic[s] & WET)) continue;
    const id = ++next;
    navComp[s] = id; stack.push(s);
    while (stack.length) {
      const k = stack.pop(), a = k % N, b = (k / N) | 0;
      for (let db = -1; db <= 1; db++) for (let da = -1; da <= 1; da++) {
        const na = a + da, nb = b + db;
        if (na < 0 || nb < 0 || na >= N || nb >= N) continue;
        const nk = nb * N + na;
        if (navComp[nk] || (navStatic[nk] & WET)) continue;
        navComp[nk] = id; stack.push(nk);
      }
    }
  }
}
// Landmass id at a world point. 0 means water, off the baked grid, or a coastal cell the
// sinker footprint clips — i.e. "don't know", never "unreachable".
function landmassAt(x, z) {
  if (!navStatic) buildNavStatic();
  if (!navComp) buildNavComp();
  const k = navIdx(Math.round(x / grid.cell), Math.round(z / grid.cell));
  return k < 0 ? 0 : navComp[k];
}
// Could this vehicle DRIVE from where it stands to (x,z)? Anything that flies or fords always
// can. A 0 on either end is an unknown, and an unknown answers YES — this test is here to rule
// destinations out with certainty, never to rule them in.
// GO AS CLOSE AS THE GROUND ALLOWS. Missions hand out RAW remembered coordinates — a tower's
// radio call, a sighting, a heard contact — and nothing in that path ever asked whether a ground
// unit could stand there. The thing that shot our base may have been a Valkyrie over open water;
// the contact we heard may be across a channel. Defend.objective even carries a comment about
// it: a unit sent at homeAttack()'s raw position was stranded for 164 seconds.
// Refusing the order would be wrong (the threat is real and the direction is right), so instead
// snap the goal to the nearest cell on the unit's OWN landmass. That turns "drive at the sea and
// grind on the beach" into "get as close to it as you can" — which is what the order meant.
// No A* involved: it's a ring search over the baked component labels, a few array reads.
// Returns the point unchanged when it's already drivable, or when nothing better is within maxR.
function nearestDrivable(v, x, z, maxR = 60) {
  if (!aiLandmass || !v || !v._move || v._move.water !== 'sink') return { x, z };
  const here = landmassAt(v.holder.position.x, v.holder.position.z);
  if (!here) return { x, z };
  // A 0 here means water, off-grid, or a coastal cell the sinker footprint clips — "don't know",
  // NOT "unreachable", same rule as drivableTo. Getting this wrong is expensive: treating 0 as a
  // mismatch fired the snap on every goal near a shoreline (a normal, fine goal) and dragged it
  // inland. Worse, the moved goal often sat inside a wall — which the component labels ignore by
  // design — so the driver ACCEPTED an order it still couldn't fulfil, and the unreachable-GOTO
  // report that the recovery path keys off never came. Measured: goal snapping on coastal cells
  // cut contract violations 235 -> 145 while RAISING scuttles 7 -> 10 and nav alarms 14 -> 23.
  // Suppressing the alarm is not the same as fixing the problem.
  const there = landmassAt(x, z);
  if (!there || there === here) return { x, z };
  const c = grid.cell, i0 = Math.round(x / c), j0 = Math.round(z / c), R = Math.ceil(maxR / c);
  for (let r = 1; r <= R; r++) {
    let best = null, bd = Infinity;
    for (let di = -r; di <= r; di++) for (let dj = -r; dj <= r; dj++) {
      if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;   // walk the ring, not the disc
      const k = navIdx(i0 + di, j0 + dj);
      if (k < 0 || navComp[k] !== here) continue;
      const d = di * di + dj * dj;
      if (d < bd) { bd = d; best = { x: (i0 + di) * c, z: (j0 + dj) * c }; }
    }
    if (best) return best;
  }
  return { x, z };
}
// A GOAL INSIDE A WALL IS AN ORDER NOBODY CAN OBEY. Several missions hand out raw coordinates
// that are, by construction, points no hull can ever stand on: `_supply` and `_home` are base
// CENTRES (measured blocked 25-33% of the time, seed-dependent) and `homeAttack()` is the impact
// point of a shell ON A STRUCTURE (48-75%). A* then settles the whole island without ever
// reaching the goal cell, the contract fires, and the unit walks a partial route and stands
// short of an order it was never able to obey.
//
// This is NOT the goal-snapping that failed on 2026-08-04. That one moved goals using the
// LANDMASS labels, which ignore buildings by design — so it fired on innocent coastal goals and
// often moved them INTO a wall: contract violations 235 -> 145, but scuttles 7 -> 10 and nav
// alarms 14 -> 23. Suppressing the report is not fixing the problem. This one uses `v._blocked`,
// the exact test A* itself uses, and only fires when the goal cell genuinely cannot be occupied.
//
// It deliberately does NOT hide unreachability: a snapped cell that is still walled off from the
// unit is still proven unreachable by A* and still reports. The only thing being fixed here is
// the goal sitting ON the wall, which is impossible by construction rather than by situation.
const GOAL_SNAP_R = 26;      // u — beyond this the goal isn't "on a structure", it's somewhere else
const GOAL_SNAP_TTL = 500;   // ms to trust a cached snap (gates and lift decks change what's blocked)
let goalSnaps = 0;           // how often an impossible goal had to be rescued — RR.navAlarmStats
// Every driving tick that ends up with NO order — neither a route nor a maneuver — filed under the
// reason it fell through. This is the DIRECT ledger: the list of places navigation still isn't.
const navBail = {};
// …and the same thing measured in TIME, which is the measure that can tell a bug from a pause.
// A tick count cannot: settling into a firing position for half a second and standing at an
// objective for three minutes both read as "arrived". Only sustained EPISODES are evidence, so
// count runs longer than BAIL_EPISODE and keep the worst one.
const BAIL_EPISODE = 5;   // s — below this a no-order run is a settle, not a stall
const navBailEp = {};     // reason -> { n, totalS, maxS, movedS (episodes that covered real ground) }
const navBailWorst = [];  // the longest few, with enough detail to tell flying from parked
function noteBailEpisode(why, secs, v, x0, z0) {
  if (!why || secs < BAIL_EPISODE) return;
  const e = navBailEp[why] || (navBailEp[why] = { n: 0, totalS: 0, maxS: 0, moving: 0 });
  e.n++; e.totalS += secs; e.maxS = Math.max(e.maxS, secs);
  // GROUND COVERED IS THE WHOLE VERDICT. A unit with no order that flew 200u was travelling and
  // never needed a route; one that sat still had nobody driving it. Same ledger line, opposite bugs.
  const net = (v && x0 != null) ? Math.hypot(v.holder.position.x - x0, v.holder.position.z - z0) : 0;
  if (net > secs * 1.5) e.moving++;
  navBailWorst.push({ why, secs: +secs.toFixed(1), net: Math.round(net),
                      type: v && v.type, state: v && v._aiState });
  navBailWorst.sort((a, b) => b.secs - a.secs);
  if (navBailWorst.length > 20) navBailWorst.length = 20;
}
function standableGoal(v, x, z) {
  if (!v || !v._blocked) return { x, z };
  const memo = v.__goalSnap;
  if (memo && Math.abs(memo.rx - x) < 1 && Math.abs(memo.rz - z) < 1 && performance.now() - memo.t < GOAL_SNAP_TTL) return memo.out;
  let out = { x, z };
  if (v._blocked(x, z)) {
    const c = grid.cell, i0 = Math.round(x / c), j0 = Math.round(z / c), R = Math.ceil(GOAL_SNAP_R / c);
    const here = aiLandmass && navComp ? landmassAt(v.holder.position.x, v.holder.position.z) : 0;
    ring: for (let r = 1; r <= R; r++) {
      let best = null, bd = Infinity;
      for (let di = -r; di <= r; di++) for (let dj = -r; dj <= r; dj++) {
        if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;   // walk the ring, not the disc
        const gx = (i0 + di) * c, gz = (j0 + dj) * c;
        if (v._blocked(gx, gz)) continue;
        // don't rescue the goal onto a DIFFERENT island on the way out (0 = don't know, allowed)
        if (here) { const k = navIdx(i0 + di, j0 + dj); if (k >= 0 && navComp[k] && navComp[k] !== here) continue; }
        const d = di * di + dj * dj;
        if (d < bd) { bd = d; best = { x: gx, z: gz }; }
      }
      if (best) { out = best; goalSnaps++; break ring; }
    }
    // ringed all the way out and found nothing standable — leave the goal alone and let the
    // driver's contract report it, rather than inventing a destination.
  }
  v.__goalSnap = { rx: x, rz: z, out, t: performance.now() };
  return out;
}
function drivableTo(v, x, z) {
  if (!aiLandmass) return true;
  if (!v || !v._move || v._move.water !== 'sink') return true;
  const here = landmassAt(v.holder.position.x, v.holder.position.z);
  if (!here) return true;
  const there = landmassAt(x, z);
  return !there || there === here;
}
const obsBuckets = new Map();   // cell key "i,j" → obstacles overlapping that cell
function buildObsBuckets() {
  obsBuckets.clear();
  const c = grid.cell, margin = VEH_R * 0.9;
  for (const o of obstacles) {
    const rr = o.r + margin;
    const i0 = Math.floor((o.x - rr) / c), i1 = Math.ceil((o.x + rr) / c);
    const j0 = Math.floor((o.z - rr) / c), j1 = Math.ceil((o.z + rr) / c);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const k = i + ',' + j;
      const list = obsBuckets.get(k);
      if (list) list.push(o); else obsBuckets.set(k, [o]);
    }
  }
}

const VEH_R = 3.0;            // vehicle collision radius (vs walls/trees)
// Water no longer hard-blocks: hover/fly craft cross it, land craft enter and sink
// (see applyAltitude). blockedFor(move) builds a per-vehicle predicate; this is a
// land-vehicle default kept for the debug API.
const _landBlocked = blockedFor({ cruise: 0, ignoreWalls: false, water: 'sink', tree: 'crush' });
function blockedAt(x, z) { return _landBlocked(x, z); }

// The single player-controlled vehicle, driven with WASD / the touch joystick
// (migrated from the Vehicle Designer; Vehicle.drive() does the integration).
let player = null;
let playerElev = null;        // the lift it deploys from
let driving = false;          // true once control is handed to the player
let returning = false;        // true while the parked vehicle lowers back to base
let parkT = 0;                // dwell timer for "parked on own pad" detection
let leftPad = false;          // must drive OFF the pad before parking can return it
const _follow = new THREE.Vector3();

// Put the player's vehicle on their FOB. rise=true → starts in the pit and rides
// up, with control handed over when it tops; rise=false → already on the surface,
// drive immediately. The chosen colour becomes the whole player team's colour.
function deployToFOB(type, colorIndex, rise) {
  matchOver = false;               // fresh run
  playerColorIndex = colorIndex;   // tints this vehicle's projectiles
  const accent = TEAM_COLORS[colorIndex].hex;
  for (const c of camps) if (c.team === PLAYER_TEAM) c.setAccent(accent);
  recolorFlag(PLAYER_TEAM, accent);
  recolorPlaced(PLAYER_TEAM, accent);   // designed-map props + standalone forts follow the locked colour
  if (soldiers) soldiers.retintTeam(PLAYER_TEAM, accent);   // base infantry fatigues follow the locked colour
  playerElev = elevators.find(e => e.team === PLAYER_TEAM) || null;
  const cx = playerElev ? playerElev.center.x : 0;
  const cz = playerElev ? playerElev.center.z : 0;
  const heading = Math.atan2(cx, cz);   // face the map centre (model front = -Z)

  const v = new Vehicle(type);
  v.setScale(0.72);
  v.setCamo(colorIndex);
  v.setTeamColor(accent);
  if (type === 'firebrat') v._mineCharges = MINE.perTrip;   // 2 mines to lay this trip

  for (const e of elevators) if (e.team === PLAYER_TEAM) e.setAccent(accent);   // ALL the team's lifts (satellite pads too)
  if (rise && playerElev) {
    playerElev.loop = false;
    playerElev.phase = 'down';
    playerElev.t = 0;
    playerElev.lift.position.y = playerElev.bottomY;
    playerElev.setRider(v, heading);
    playerElev.start();
    driving = false;            // control hands over at the top (see driveUpdate)
  } else {
    v.setPose(cx, vehicleGroundY(cx, cz), cz, heading);
    driving = true;
  }
  scene.add(v.group);
  player = v;
  initCombatant(v, PLAYER_TEAM, colorIndex, true);
  updatePlayerHud();
  refreshAimArc();            // aim-stick wedge matches the deployed vehicle's arc
  startCommanders(colorIndex);   // AI teams pick remaining colours + deploy in response
  leftPad = false;            // must drive off the pad before a park can return it
  parkT = 0;

  orbit.target.set(cx, 0, cz);
  orbit.dist = 64; orbit.pitch = 0.9; orbit.yaw = 0;   // the locked PvAI angle — always deploy at the same view
  updateCamera();
}

// Forward/turn in [-1, 1]. Touch: the left on-screen stick sets the same WASD keys.
// Keyboard (desktop): WASD/arrows, the classic tank turn + throttle.
function driveInput() {
  // The Lurcher has NO front (omni-directional): it moves along whatever world vector you
  // push, and the hull auto-faces its travel. The other three keep their tank steering.
  const omni = !!(player && player.type === 'lurcher');
  // Touch NAV stick: "go in this direction." The stick offset is a camera-relative
  // compass point — up = into the screen, right = screen-right — so the vehicle heads
  // that WORLD direction regardless of which way the hull faces. Tank types turn to face
  // it then drive; the omni Lurcher just slides there. Push distance = throttle.
  if (touchNav && player && !player.dead) {
    const sy = Math.sin(orbit.yaw), cy = Math.cos(orbit.yaw);
    const fX = -sy, fZ = -cy;            // camera forward on the ground (into the screen)
    const rX = cy,  rZ = -sy;            // camera right on the ground
    let mx = fX * (-touchNav.ny) + rX * touchNav.nx;
    let mz = fZ * (-touchNav.ny) + rZ * touchNav.nx;
    const len = Math.hypot(mx, mz);
    let mag = (touchNav.mag - 0.20) / 0.80;             // deadzone, then linear 0..1 throttle
    mag = Math.max(0, Math.min(1, mag));
    if (len < 1e-4 || mag <= 0) return omni ? { omni: true, mx: 0, mz: 0 } : { fwd: 0, turn: 0 };
    mx /= len; mz /= len;                                // unit world heading
    if (omni) return { omni: true, mx: mx * mag, mz: mz * mag };
    const aim = Math.atan2(-mx, -mz);                   // heading whose front (-Z) faces the push
    const err = wrapPi(aim - player.heading);
    const turn = Math.max(-1, Math.min(1, err * 2.4));
    const fwd = Math.abs(err) > 1.3 ? 0 : mag;          // pivot in place if badly mis-aimed, else throttle
    return { fwd, turn };
  }
  if (touchSteer && player && !player.dead) {
    const t = pickWorldPoint(touchSteer.x, touchSteer.y);
    if (t) {
      const hp = player.holder.position;
      const dx = t.point.x - hp.x, dz = t.point.z - hp.z;
      const distXZ = Math.hypot(dx, dz);
      if (omni) {
        // Move straight toward the finger — no turn-then-drive — easing to a stop on arrival.
        if (distXZ < TOUCH_STOP_R) return { omni: true, mx: 0, mz: 0 };
        const inv = 1 / distXZ;
        return { omni: true, mx: dx * inv, mz: dz * inv };
      }
      const aim = Math.atan2(-dx, -dz);                 // heading whose front (-Z) points at the finger
      const err = wrapPi(aim - player.heading);
      const turn = Math.max(-1, Math.min(1, err * 2.4));
      // Two-finger strafe: a second finger HELD to one side slides the hull straight
      // sideways toward that finger while the first keeps aiming — no forward drive. The
      // strafe sign is the second finger's offset projected onto the hull's right axis,
      // so "finger on the right" = strafe right regardless of camera angle. Jotun can't.
      if (touchStrafe && player.type !== 'jotun' && performance.now() - touchStrafe.t > 140) {
        const b = pickWorldPoint(touchStrafe.x, touchStrafe.y);
        if (b) {
          const h = player.heading, rx = Math.cos(h), rz = -Math.sin(h);   // hull right axis
          let bx = b.point.x - hp.x, bz = b.point.z - hp.z;
          const bl = Math.hypot(bx, bz) || 1;
          const strafe = Math.max(-1, Math.min(1, ((bx / bl) * rx + (bz / bl) * rz) * 1.5));
          return { fwd: 0, turn, strafe };
        }
      }
      // Pivot in place when badly mis-aimed (>~75°) so we don't arc wide; otherwise
      // drive forward, easing to a stop once the finger sits on the vehicle.
      const fwd = Math.abs(err) > 1.3 ? 0 : (distXZ < TOUCH_STOP_R ? 0 : 1);
      return { fwd, turn };
    }
  }
  if (omni) {
    // Camera-relative 8-way: W/S move into/out of the screen, A/D move screen-left/right,
    // independent of which way the hull happens to be facing.
    const sy = Math.sin(orbit.yaw), cy = Math.cos(orbit.yaw);
    const fX = -sy, fZ = -cy;        // camera forward on the ground (into the screen)
    const rX = cy,  rZ = -sy;        // camera right on the ground
    const wv = (keys['w'] || keys['arrowup']   ? 1 : 0) - (keys['s'] || keys['arrowdown']  ? 1 : 0);
    const rv = (keys['d'] || keys['arrowright'] ? 1 : 0) - (keys['a'] || keys['arrowleft'] ? 1 : 0);
    let mx = fX * wv + rX * rv, mz = fZ * wv + rZ * rv;
    const m = Math.hypot(mx, mz);
    if (m > 1) { mx /= m; mz /= m; }
    return { omni: true, mx, mz };
  }
  const fwd    = (keys['w'] || keys['arrowup']   ? 1 : 0) - (keys['s'] || keys['arrowdown']  ? 1 : 0);
  const turn   = (keys['a'] || keys['arrowleft'] ? 1 : 0) - (keys['d'] || keys['arrowright'] ? 1 : 0);
  const strafe = (keys['e'] ? 1 : 0) - (keys['q'] ? 1 : 0);   // Q/E slide sideways (no turn)
  return { fwd, turn, strafe };
}

// Drive the player vehicle and track the camera on it. Returns true if it drove
// (so the caller skips the free-camera pan). Hands control over once the deploy
// lift tops out.
function driveUpdate(dt) {
  if (playerElev && player && playerElev.rider === player && playerElev.phase === 'top') {
    playerElev.rider = null;   // detach so drive() owns the transform
    player._elevShieldUntil = performance.now() + ELEV_SHIELD_MS;   // anti-camp cover while it clears the mouth
    driving = true;
    refreshAimArc();           // tint the aim wedge to this vehicle's arc, now that it's live
  }
  if (!driving || !player || player.dead) return false;
  const inp = matchOver ? { fwd: 0, turn: 0, strafe: 0 } : driveInput();   // controls freeze on win
  player.speedMul = roadSpeedMul(player) * rankSpeedMul(player);   // road boost × promotion (bronze stars)
  let revFwd, revTurn, stopped;
  if (inp.omni) {
    // Omni Lurcher: burnFuel for the accounting (+ LIMP scaling when dry), then drive the
    // world vector. The fuel call's fwd-out / fwd-in ratio gives the LIMP factor (1 fueled).
    const mag = Math.hypot(inp.mx, inp.mz);
    const fuelOut = burnFuel(player, { fwd: mag, turn: 0, strafe: 0 }, dt);
    const k = mag > 0.0001 ? fuelOut.fwd / mag : 1;
    player.driveOmni(dt, inp.mx * k, inp.mz * k, null, player._blocked);
    revFwd = mag; revTurn = 0; stopped = mag < 0.01;
  } else {
    const out = burnFuel(player, inp, dt);  // no fuel → engine dead, can't move
    const strafe = player.type === 'jotun' ? 0 : (out.strafe || 0);   // the Jotun is a fortress — no sidestep
    player.drive(dt, out.fwd, out.turn, null, player._blocked, strafe);
    revFwd = out.fwd; revTurn = out.turn; stopped = inp.fwd === 0 && inp.turn === 0;
  }
  applyAltitude(player, dt);                // altitude / water flooding / tree crush
  if (!player || player.dead) return true;  // sank/destroyed this frame → bail before touching it
  aimPlayerTurret(player, dt);              // turret continuously follows the aim cursor
  player._throttle = Math.min(1, Math.abs(revFwd) + Math.abs(revTurn) * 0.6);   // own-noise floor for the sound HUD's masking
  if (sound) sound.update(revFwd, revTurn);   // rev the engine RPM with throttle (idle ↔ max)
  fireCooldown -= dt;
  if (!matchOver && fireHeld && fireCooldown <= 0) firePlayer();   // hold to auto-fire at the crosshair
  _follow.set(player.holder.position.x, 0, player.holder.position.z);
  orbit.target.lerp(_follow, 0.12);
  updateCamera();

  // Park on your own FOB pad (centred + stopped for a moment) → lower it / return.
  // Must drive OFF the pad first, so the deploy spawn point doesn't instantly return.
  if (playerElev && !returning) {
    const dist = Math.hypot(player.holder.position.x - playerElev.center.x,
                            player.holder.position.z - playerElev.center.z);
    if (dist > playerElev.padHalf * 1.3) leftPad = true;
    if (leftPad && dist < playerElev.padHalf * 0.7 && stopped) {
      parkT += dt;
      if (parkT > 0.5) beginReturn();
    } else {
      parkT = 0;
    }
  }
  return true;
}

function rebuild(patch) {
  map.generate(patch);
  placeCampsAuto();
  buildRoads();
  scatterFoliage();
  scaleScene();      // keep fog/far in sync, but DON'T move the camera
  updateCamera();
}

// Scale fog + far plane + sun to the map size so big maps don't fog out.
// Does NOT touch the camera distance/target — your view stays put on rebuild.
function scaleScene() {
  const span = Math.max(map.worldW, map.worldH);
  zoomMax = span * 1.6;
  scene.fog.near = span * 0.7;
  scene.fog.far = span * 1.6;
  camera.far = span * 3 + 200;
  camera.updateProjectionMatrix();
  // Sun nearly overhead, tilted slightly toward -Z — the specular look this was tuned for
  // (x:0, z:-25 on the default 480 map). Kept proportional to span so any map size gets
  // the same light DIRECTION, not just the default one.
  sun.position.set(0, span * 0.42, -span * 0.052);
}

// Initial camera framing — only used once, on load (the spectator start view).
function frameMap() {
  scaleScene();
  orbit.dist = Math.max(map.worldW, map.worldH) * 0.425;   // closer start (was 0.85 — felt very far)
  updateCamera();
}

let sound = null;   // procedural engine/gun synth; declared before the field-init block below uses it

if (!GARAGE) {
  map.generate(GEN_OPTS);
  scene.add(map.group);
  placeCampsAuto();
  buildRoads();
  if (!SHOT || SHOT_FOL) scatterFoliage();
  frameMap();
  fieldBuilt = true;
  onField = true;
  ensureDeployFade();   // needed for the lower→garage fade on the first return
  setFieldUI(true);     // reveal the touch drive stick + fire button
  setupCommanders();    // stand up AI teams (deploys now if there's no human)
  // No garage flow here, so drop the human's vehicle straight onto their FOB,
  // already on the surface and driveable (WASD / touch). ?noveh / all-AI skip it.
  if (TEAM_CTRL[PLAYER_TEAM] === 'human' && !QS.has('noveh')) {
    deployToFOB(FOB_RIDER[PLAYER_TEAM], TEAM_CAMO[PLAYER_TEAM], false);
  }
  // Stand up the spatial engine bus now; it stays silent until a tap arms the
  // AudioContext (armFieldAudio) — covers AI-vs-AI spectating with no deploy.
  ensureSound().setSpatialActive(true);
}

// Underground garage (Phase A + sandbox). Lives in its own scene/camera, rendered
// instead of the field when ?garage is set. Tab cycles the selected vehicle;
// rendered instead of the field when ?garage is set. Phase B: pick a vehicle TYPE
// — ←/→ (or A/D) cycle the four types, 1-4 jump straight to one, or click a
// vehicle to select its type. Each highlights that type's deploy vehicle.
let garage = null;

function ensureSound() { if (!sound) sound = new SoundManager(); return sound; }

// Spatial engines need the AudioContext running, which browsers only allow from a
// user gesture. The garage deploy click covers human play; for AI-vs-AI spectating
// (no deploy) the first tap/click anywhere on the field arms it.
let _audioArmed = false;
function armFieldAudio() {
  if (_audioArmed || !onField) return;
  _audioArmed = true;
  ensureSound().setSpatialActive(true);
}
window.addEventListener('pointerdown', armFieldAudio, { passive: true });

// Reconcile the spatial engine voices against the live combatants each frame:
// listener follows the camera, every non-player vehicle gets a positioned engine
// that attenuates with distance (so you hear enemies coming, and AI-vs-AI hums).
const _camDir = new THREE.Vector3();
let _engineSeq = 0;
function updateEngineSounds() {
  if (!sound || !sound.spatialReady) return;
  camera.getWorldDirection(_camDir);
  sound.setListener(camera.position.x, camera.position.y, camera.position.z,
                    _camDir.x, _camDir.y, _camDir.z);
  for (const v of combatants) {
    if (v.isPlayer) continue;                 // the player hears its own engine centred
    const p = v.holder.position;
    if (v._engineId == null) {
      v._engineId = ++_engineSeq;
      sound.addSpatialEngine(v._engineId, v.def.soundIndex, p.x, p.y, p.z);
    }
    sound.updateSpatialEngine(v._engineId, p.x, p.y, p.z, v._throttle || 0);
  }
}

// Team colour is global and locks the instant the first vehicle deploys — after that
// the garage's colour swatches stay gone for the rest of the match (you've committed).
let teamColorLocked = false;
// Toggle the garage overlays (CCTV / HUD / team selector) and the field UI (title +
// touch joystick) when switching between the hangar view and the island.
function setGarageOverlays(show) {
  for (const id of ['cctv', 'hud-name', 'hud-stats', 'teamsel', 'build-panel', 'garage-paused']) {
    const el = document.getElementById(id);
    if (!el) continue;
    // Once locked, never re-reveal the colour swatches on later garage visits.
    const vis = show && !(id === 'teamsel' && teamColorLocked);
    el.style.display = vis ? '' : 'none';
  }
  if (show && _refreshBuildPanel) _refreshBuildPanel();   // reflect scrap earned this run + this match's losses
}
let _refreshBuildPanel = null;   // set by mountHangarHud; refreshes the BUILD panel when the garage reopens
function setFieldUI(show) {
  const hud = document.getElementById('hud');
  if (hud) hud.style.display = show ? '' : 'none';
  // Touch controls: two fixed sticks — RIGHT is the directional NAV pad ("go this way"),
  // LEFT aims+fires within the vehicle's arc with aim-assist. The old corner FIRE buttons +
  // field point-to-steer are retired (firing-by-cursor was unreliable; thumb angles too hard).
  // Only when a human actually drives — in AI-vs-AI / spectate the sticks do nothing.
  const onTouch = show && touchUsed && TEAM_CTRL[PLAYER_TEAM] === 'human';
  document.getElementById('touch-joystick')?.classList.toggle('visible', onTouch);
  document.getElementById('touch-aim')?.classList.toggle('visible', onTouch);
  for (const id of ['fire-btn', 'fire-btn-l']) {
    document.getElementById(id)?.classList.remove('visible');
  }
  if (show) refreshAimArc();   // tint the aim wedge to the deployed vehicle's arc
  updateScrapHud();            // team scrap counter (top-center) — show on field, hide in garage
  ensureLogToggle(); updateLogToggle();   // phone-friendly AI-log button (top-right)
  ensureAstarToggle(); updateAstarToggle();   // PATH button (left of LOG) — opens the A* visualizer
  if (!show) { fireHeld = false; touchAim = null; touchAiming = false; }   // drop a held shot at the garage
}
// Top-right LOG button (where the old map ⚙ sat) — reveals the log from hidden. It
// only shows while the field is up and the log is hidden; once open, the box's own
// – button re-hides it.
function ensureLogToggle() {
  let b = document.getElementById('ailog-toggle');
  if (b) return b;
  b = document.createElement('div'); b.id = 'ailog-toggle'; b.textContent = 'LOG';
  b.style.cssText = 'position:fixed;top:12px;right:12px;z-index:151;padding:7px 12px;border-radius:7px;' +
    'font-family:"Courier New",monospace;font-weight:bold;font-size:13px;letter-spacing:2px;color:#dfe8ef;' +
    'background:rgba(8,12,18,0.7);border:1px solid rgba(255,255,255,0.3);box-shadow:0 2px 8px rgba(0,0,0,0.3);' +
    'user-select:none;-webkit-user-select:none;touch-action:manipulation;cursor:pointer;';
  b.addEventListener('pointerdown', e => { e.preventDefault(); e.stopPropagation(); setLogMode('brief'); });
  document.body.appendChild(b);
  return b;
}
function updateLogToggle() {
  const b = document.getElementById('ailog-toggle');
  if (b) b.style.display = (onField && aiLogMode === 'hidden') ? 'block' : 'none';
}
// PATH button — sits just left of LOG (phones have no keyboard, so the `v` hotkey
// is useless on mobile). Opens the A* search visualizer. Same visibility rule as
// LOG so it never collides with the brief log box.
function ensureAstarToggle() {
  let b = document.getElementById('astar-toggle');
  if (b) return b;
  b = document.createElement('div'); b.id = 'astar-toggle'; b.textContent = 'PATH';
  b.style.cssText = 'position:fixed;top:12px;right:76px;z-index:151;padding:7px 12px;border-radius:7px;' +
    'font-family:"Courier New",monospace;font-weight:bold;font-size:13px;letter-spacing:2px;color:#dfe8ef;' +
    'background:rgba(8,12,18,0.7);border:1px solid rgba(255,255,255,0.3);box-shadow:0 2px 8px rgba(0,0,0,0.3);' +
    'user-select:none;-webkit-user-select:none;touch-action:manipulation;cursor:pointer;';
  b.addEventListener('pointerdown', e => { e.preventDefault(); e.stopPropagation(); toggleAstarViz(); });
  document.body.appendChild(b);
  return b;
}
function updateAstarToggle() {
  const b = document.getElementById('astar-toggle');
  if (b) b.style.display = (onField && aiLogMode === 'hidden') ? 'block' : 'none';
}

// Build the garage scene + its UI/handlers. Called once via ensureGarage() — at
// load in ?garage mode, or lazily the first time a vehicle returns to base.
function setupGarageUI() {
  setupGarageUI._done = true;
  setFieldUI(false);
  mountCCTV();
  mountHangarHud(garage);
  mountTeamSelector();

  // Engine sound (procedural, from the designer's SoundManager) + team-colour lock,
  // both fired when a deploy is confirmed. AudioContext starts on the gesture.
  if (!sound) sound = new SoundManager();
  garage.onDeploy((type) => {
    try {
      sound.setVehicle(VEHICLE_TYPES[type].soundIndex);
      if (!sound.enabled) sound.toggle();
    } catch (e) { /* audio is best-effort */ }
    teamColorLocked = true;              // team colour locked at first deploy — swatches gone for good
    const ts = document.getElementById('teamsel');
    if (ts) ts.style.display = 'none';
    deploy = { type, colorIndex: camoParams.colorIndex };   // carried over to the island
  });

  // Garage controls only act while the hangar is on screen (not while driving).
  window.addEventListener('keydown', (e) => {
    if (onField) return;
    const k = e.key.toLowerCase();
    if (k === ' ' || k === 'spacebar') { garage.confirm(); e.preventDefault(); }
    else if (k === 'arrowright' || k === 'd') { garage.cycleType(1); e.preventDefault(); }
    else if (k === 'arrowleft' || k === 'a') { garage.cycleType(-1); e.preventDefault(); }
    else if (k >= '1' && k <= '4') { garage.selectType(garage.types[+k - 1]); }
    else if (k === 'b') { const s = garage.selected(); if (s && buildVehicle(s.type) && _refreshBuildPanel) _refreshBuildPanel(); e.preventDefault(); }
  });

  // Field hotkeys. The AI log is toggled by the on-screen LOG button (no keyboard on a
  // phone). Camera-cycle keys (Tab/]/[ to pin next/prev unit) are spectate-only.
  window.addEventListener('keydown', (e) => {
    if (!onField) return;
    if (TEAM_CTRL[PLAYER_TEAM] === 'human') return;
    if (e.key === 'Tab' || e.key === ']') { cycleSpectate(e.shiftKey ? -1 : 1); e.preventDefault(); }
    else if (e.key === '[') { cycleSpectate(-1); e.preventDefault(); }
    else if (e.key === '`') { spectateTarget = null; }
  });
  // NAV DEBUG overlay toggle — works in spectate AND player mode (g key / RR.nav()).
  window.addEventListener('keydown', (e) => {
    if (onField && (e.key === 'g' || e.key === 'G')) navDebug = !navDebug;
  });

  // Click a vehicle to select its type; click the already-selected type again to
  // confirm/deploy it. (Ignore real drags / orbit.)
  let downXY = null;
  renderer.domElement.addEventListener('mousedown', (e) => { if (!onField) downXY = [e.clientX, e.clientY]; });
  renderer.domElement.addEventListener('mouseup', (e) => {
    if (onField || !downXY) return;
    const moved = Math.hypot(e.clientX - downXY[0], e.clientY - downXY[1]);
    downXY = null;
    if (moved > 6) return;
    const ndc = new THREE.Vector2(
      (e.clientX / window.innerWidth) * 2 - 1,
      -(e.clientY / window.innerHeight) * 2 + 1,
    );
    const prev = garage.selType;
    const t = garage.pickType(ndc);
    if (t && t === prev) garage.confirm();   // clicked the already-selected type → deploy
  });

  ensureDeployFade();
  garage.applyRoster(playerLosses);   // attrition: hide reserves lost so far (incl. ?losses preview)
}

// Full-screen black overlay shared by deploy (fade out → field) and return (fade
// to black as the lift lowers, then fade the garage in).
function ensureDeployFade() {
  if (document.getElementById('deployfade')) return;
  const fade = document.createElement('div');
  fade.id = 'deployfade';
  fade.style.cssText = 'position:fixed;inset:0;background:#000;opacity:0;pointer-events:none;z-index:80;transition:none;';
  document.body.appendChild(fade);
}

function ensureGarage() {
  if (garage) return;
  garage = new Garage(PLAYER_TEAM);
  setupGarageUI();
}

// --- Game menu (start screen + play-again) ------------------------------
// A win/loss can't just keep playing the same world — towers, walls and foliage are
// gone for good. The clean reset is a full page RELOAD: a fresh load regenerates the
// map (new random seed) and every bit of state. So the menu's mode buttons just
// navigate (PLAYER VS AI -> ?play, AI VS AI -> ?aivsai), which reloads into a brand
// new game. The one exception is PLAYER VS AI on the very first screen (nothing's
// dirty yet): it just reveals the deploy hangar in place, no reload needed.
const MENU_BASE = location.pathname;
function ensureMenuStyle() {
  if (document.getElementById('menu-style')) return;
  const s = document.createElement('style'); s.id = 'menu-style';
  s.textContent = `
    #gamemenu { position:fixed; inset:0; z-index:400; display:none;
      flex-direction:column; align-items:center; justify-content:center; gap:12px;
      overflow:auto; padding:24px 0;
      background:radial-gradient(ellipse at center, rgba(6,10,16,0.55), rgba(4,7,12,0.85));
      font-family:"Courier New",monospace; -webkit-user-select:none; user-select:none; }
    #gamemenu.show { display:flex; }
    #gamemenu .gm-title { color:#e9fff1; font-size:clamp(40px,12vw,56px); font-weight:bold; letter-spacing:18px;
      text-shadow:0 0 22px rgba(80,255,150,0.55), 0 3px 16px rgba(0,0,0,0.85);
      text-align:center; padding-left:18px; }
    /* the joke as a live shell line — persistent brand mark, never overridden */
    #gamemenu .gm-cmd { color:#7fe7a3; font-size:15px; letter-spacing:1px; margin-top:4px;
      text-shadow:0 0 8px rgba(80,255,150,0.35); white-space:nowrap; }
    #gamemenu .gm-cmd .pr { color:#4ad968; font-weight:bold; }
    #gamemenu .gm-cmd .fl { color:#e9fff1; }
    #gamemenu .gm-cmd .ct { color:#9bffc4; animation:gm-blink 1.05s steps(1) infinite; }
    @keyframes gm-blink { 0%,50% { opacity:1; } 50.01%,100% { opacity:0; } }
    #gamemenu .gm-sub { color:#7f9a8b; font-size:11px; letter-spacing:5px; margin:6px 0 20px; }
    #gamemenu button { width:262px; padding:15px 0; font-family:inherit; font-size:15px;
      letter-spacing:3px; font-weight:bold; color:#dfe8ef; cursor:pointer;
      background:rgba(20,30,42,0.88); border:1px solid rgba(255,255,255,0.28); border-radius:6px;
      box-shadow:0 2px 10px rgba(0,0,0,0.4); transition:background .12s, transform .06s; }
    #gamemenu button:hover { background:rgba(40,58,80,0.96); }
    #gamemenu button:active { transform:scale(0.97); }
    #gamemenu .gm-group { display:flex; flex-direction:column; align-items:center; gap:12px; }
    /* Locked / upcoming buttons (campaign levels not yet unlocked, or with no map) */
    #gamemenu .gm-soon { position:relative; opacity:0.5; cursor:default; }
    #gamemenu .gm-soon:hover { background:rgba(20,30,42,0.88); }
    #gamemenu .gm-badge { position:absolute; top:-9px; right:-10px; background:#caa64a; color:#1a1208;
      font-size:8px; font-weight:bold; letter-spacing:1px; padding:2px 7px; border-radius:10px;
      transform:rotate(6deg); box-shadow:0 1px 4px rgba(0,0,0,0.5); }
    #gamemenu .gm-badge.gm-done { background:#4ad968; }        /* CLEARED */
    #gamemenu .gm-badge.gm-lock { background:#5a6674; color:#dfe8ef; }  /* LOCKED */
    /* CAMPAIGN level list */
    #gamemenu #gm-campaign-list { display:flex; flex-direction:column; align-items:center; gap:12px; }
    #gamemenu .gm-lvl { position:relative; text-align:left; padding-left:20px; }
    #gamemenu .gm-lvl-n { color:#7fe7a3; font-weight:bold; margin-right:6px; }
    #gamemenu .gm-lvl.gm-soon .gm-lvl-n { color:#5a6674; }
    /* DEV TOOLS submenu */
    #gamemenu .gm-devhdr { color:#7fe7a3; font-size:13px; letter-spacing:6px; font-weight:bold;
      margin-bottom:2px; text-shadow:0 0 8px rgba(80,255,150,0.35); }
    #gamemenu .gm-toollbl { color:#5f7a6b; font-size:9px; letter-spacing:4px; margin:8px 0 -2px; }
    #gamemenu a.gm-tool { width:262px; padding:13px 0; font-family:inherit; font-size:13px; letter-spacing:2px;
      font-weight:bold; color:#9fc7e0; text-align:center; text-decoration:none; box-sizing:border-box;
      background:rgba(14,22,32,0.88); border:1px solid rgba(120,180,220,0.28); border-radius:6px;
      box-shadow:0 2px 10px rgba(0,0,0,0.4); transition:background .12s, transform .06s; }
    #gamemenu a.gm-tool:hover { background:rgba(28,44,62,0.96); }
    #gamemenu a.gm-tool:active { transform:scale(0.97); }
    #gamemenu .gm-help { width:min(86vw,340px); color:#aebecd; font-size:11px; line-height:1.6; letter-spacing:0.5px;
      background:rgba(8,12,18,0.72); border:1px solid rgba(255,255,255,0.15); border-radius:6px;
      padding:12px 16px; white-space:normal; text-align:left; margin-top:6px;
      max-height:40vh; overflow-y:auto; }
    #gamemenu .gm-help h4 { color:#e6eef5; font-size:10px; letter-spacing:2px; margin:10px 0 3px; font-weight:bold; }
    #gamemenu .gm-help h4:first-child { margin-top:0; }
    #gamemenu .gm-help b { color:#dfe8ef; }
    #gamemenu .gm-help .supply-row { display:flex; align-items:center; gap:10px; margin:7px 0; }
    #gamemenu .gm-help .supply-row img { width:48px; height:48px; flex-shrink:0; object-fit:contain;
      background:rgba(120,210,150,0.06); border:1px solid #1d3850; border-radius:5px; }
    #gamemenu .gm-help .supply-row span { color:#9fb2c2; }`;
  document.head.appendChild(s);
}
// Fetch a campaign level's map JSON, stash it for the same-origin loader, and boot straight
// into that level's deploy garage. `?campaign=<id>` rides along so a win marks it complete.
async function startCampaignLevel(idx) {
  const lvl = CAMPAIGN[idx];
  if (!lvl || !lvl.file || !isUnlocked(idx)) return;
  try {
    const res = await fetch(lvl.file, { cache: 'no-cache' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const txt = await res.text();
    JSON.parse(txt);   // validate before we commit to a navigation
    localStorage.setItem('rmrf-playmap', txt);
    location.href = MENU_BASE + '?play&maplocal=rmrf-playmap&campaign=' + encodeURIComponent(lvl.id);
  } catch (e) {
    console.warn('campaign: could not load level', lvl.id, '—', e && e.message);
  }
}
function ensureGameMenu() {
  let m = document.getElementById('gamemenu');
  if (m) return m;
  ensureMenuStyle();
  m = document.createElement('div'); m.id = 'gamemenu';
  m.innerHTML =
    '<div class="gm-title" id="gm-title">RMRF</div>' +
    '<div class="gm-cmd"><span class="pr">$</span> rm <span class="fl">-rf</span> /their/base | grep flag<span class="ct">&#9608;</span></div>' +
    '<div class="gm-sub" id="gm-sub">ISLAND CTF</div>' +
    '<div class="gm-group" id="gm-main">' +
      '<button data-act="pva">PLAYER VS AI</button>' +
      '<button data-act="campaign">CAMPAIGN &#9656;</button>' +
      '<button data-act="dev">DEV TOOLS &#9656;</button>' +
    '</div>' +
    '<div class="gm-group" id="gm-campaign" style="display:none">' +
      '<div class="gm-devhdr">CAMPAIGN</div>' +
      '<div id="gm-campaign-list"></div>' +
      '<button data-act="back">&#9666; BACK</button>' +
    '</div>' +
    '<div class="gm-group" id="gm-dev" style="display:none">' +
      '<div class="gm-devhdr">DEV TOOLS</div>' +
      '<button data-act="ava">AI VS AI</button>' +
      '<button data-act="ava3">AI VS AI &middot; 3 UNITS EACH</button>' +
      '<button data-act="pva3">PLAYER VS AI &middot; 3 UNITS EACH</button>' +
      '<div class="gm-toollbl">EDITORS &amp; LABS</div>' +
      '<a class="gm-tool" href="https://asset-designer.rmrfbase.com" target="_blank" rel="noopener">ASSET DESIGNER &#8599;</a>' +
      '<a class="gm-tool" href="https://map-designer.rmrfbase.com" target="_blank" rel="noopener">MAP DESIGNER &#8599;</a>' +
      '<a class="gm-tool" href="https://vehicle-designer.rmrfbase.com" target="_blank" rel="noopener">VEHICLE DESIGNER &#8599;</a>' +
      '<a class="gm-tool" href="https://sound-lab.rmrfbase.com" target="_blank" rel="noopener">SOUND LAB &#8599;</a>' +
      '<button data-act="back">&#9666; BACK</button>' +
    '</div>' +
    '<div class="gm-help" id="gm-help">' +
      '<h4>GOAL</h4>' +
      'Destroy the enemy flag HQ, then send a <b>Firebrat</b> to grab the exposed flag and ride it down your own lift to win.' +
      '<h4>CONTROLS</h4>' +
      '<b>Move</b> WASD / drag toward a point &nbsp; <b>Fire</b> click / FIRE button &nbsp; <b>Strafe</b> Q E / two fingers &nbsp; <b>Aim</b> toward the cursor' +
      '<h4>VEHICLES</h4>' +
      '<b>Lurcher</b> — fast omni scout, 360° turret.<br>' +
      '<b>Firebrat</b> — fragile flag runner, fixed gun.<br>' +
      '<b>Valkyrie</b> — flying missile gunship.<br>' +
      '<b>Jotun</b> — slow railgun siege tank.' +
      '<h4>SUPPLIES</h4>' +
      'Neutral points — either team can use them, or blow one up to deny it.' +
      SUPPLY_ASSETS.map(a =>
        `<div class="supply-row"><img src="thumbnails/${a.id}.png" alt="${a.name}" loading="lazy"><div><b>${a.name}</b><br><span>${a.desc}</span></div></div>`
      ).join('') +
    '</div>';
  document.body.appendChild(m);
  // Swap between the main buttons, the CAMPAIGN list, and the DEV TOOLS submenu
  // (the help panel only shows on the main view).
  function showView(v) {
    m.querySelector('#gm-main').style.display = v === 'main' ? '' : 'none';
    m.querySelector('#gm-dev').style.display = v === 'dev' ? '' : 'none';
    m.querySelector('#gm-campaign').style.display = v === 'campaign' ? '' : 'none';
    const help = m.querySelector('#gm-help'); if (help) help.style.display = v === 'main' ? '' : 'none';
    if (v === 'campaign') renderCampaign();
  }
  // Build the level list fresh each open so unlocks/cleared badges reflect saved progress.
  function renderCampaign() {
    const list = m.querySelector('#gm-campaign-list');
    list.innerHTML = CAMPAIGN.map((lvl, i) => {
      const playable = isUnlocked(i) && !!lvl.file;
      const badge = isCompleted(lvl.id) ? '<span class="gm-badge gm-done">CLEARED</span>'
        : !lvl.file ? '<span class="gm-badge">SOON</span>'
        : !playable ? '<span class="gm-badge gm-lock">LOCKED</span>' : '';
      return `<button class="gm-lvl${playable ? '' : ' gm-soon'}" data-lvl="${i}"${playable ? '' : ' disabled'}>` +
        `<span class="gm-lvl-n">${i + 1}.</span> ${lvl.name}${badge}</button>`;
    }).join('');
  }
  m._showView = showView;
  m._setDevView = (on) => showView(on ? 'dev' : 'main');   // back-compat with showGameMenu
  m.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b || b.disabled) return;   // locked levels are disabled
    if (b.dataset.lvl != null) { startCampaignLevel(+b.dataset.lvl); return; }
    const act = b.dataset.act;
    if (act === 'campaign') { showView('campaign'); return; }
    if (act === 'dev') { showView('dev'); return; }
    if (act === 'back') { showView('main'); return; }
    if (act === 'ava') { location.href = MENU_BASE + '?aivsai'; return; }
    // Multi-unit (?units=3): each side gets 3 elevators = 3 simultaneous units. Dev-menu
    // only while it bakes; PvAI 3v3 is currently YOU vs three of them — no wingmen yet.
    if (act === 'ava3') { location.href = MENU_BASE + '?aivsai&units=3'; return; }
    if (act === 'pva3') { location.href = MENU_BASE + '?play&units=3'; return; }
    // PLAYER VS AI: reload into a fresh game after a match; on the first screen just open the hangar.
    if (m.dataset.reload === '1') { location.href = MENU_BASE + '?play'; return; }
    hideGameMenu();
    setGarageOverlays(true);
  });
  return m;
}
function showGameMenu(opts = {}) {
  const m = ensureGameMenu();
  document.getElementById('gm-title').textContent = opts.header || 'RMRF';
  document.getElementById('gm-sub').textContent = opts.sub || 'ISLAND CTF';
  m.dataset.reload = opts.reload ? '1' : '0';
  if (m._showView) m._showView(opts.campaign ? 'campaign' : 'main');   // campaign win → reopen the level list
  m.classList.add('show');
  setGarageOverlays(false);   // hide the deploy HUD behind the menu
}
function hideGameMenu() { const m = document.getElementById('gamemenu'); if (m) m.classList.remove('show'); }

if (GARAGE) ensureGarage();
if (QS.has('win')) {
  // Preview the in-hangar victory cinematic without playing a match: ?win or ?win=jotun.
  setGarageOverlays(false);
  const c = teamColor(PLAYER_TEAM);
  // Flag cloth = the stolen enemy colour (matches the real win path). No commanders exist
  // in this preview so teamColor(enemy) would fall through to white — fake a rival colour
  // by picking the first palette entry that isn't the player's.
  const rival = (TEAM_COLORS.find(tc => tc.hex !== c) || { hex: '#46d6ff' }).hex;
  garage.playWin(QS.get('win') || 'firebrat', c, rival);
  showCelebTitle('VICTORY!', c, 'FLAG SECURED');
} else if (START_MENU) showGameMenu({ campaign: QS.has('campaign') });   // open the start screen (or campaign list) over the hangar

// Garage → island handoff. Fired once the garage rise has fully faded to black
// (garage.phase === 'done'). Builds the island ONCE (behind the black overlay), then
// drops the deployed vehicle (in the colour locked at deploy) onto the player's FOB
// lift and rides it up — control hands to the player at the top, under the fade-in.
function enterField() {
  onField = true;
  fieldFadeT = 0;
  exitFortPlace(); exitTowerPick();   // never carry a garage aerial overlay onto the field (it would dangle back into the garage on return)

  if (!fieldBuilt) {
    map.generate(GEN_OPTS);
    scene.add(map.group);
    placeCampsAuto();
    buildRoads();
    if (!SHOT || SHOT_FOL) scatterFoliage();
    scaleScene();
    fieldBuilt = true;
    setupCommanders();
  }

  deployToFOB(deploy.type, deploy.colorIndex, true);   // rise out of the pit, then drive
  setGarageOverlays(false);
  setFieldUI(true);
  ensureSound().setSpatialActive(true);   // hear enemy/AI engines (ctx already live from the deploy click)
}

// Vehicle drives back onto its own FOB and parks → lower it (the visible bit) and,
// once it bottoms out, return to the garage (no inside-garage animation needed).
function beginReturn() {
  returning = true;
  driving = false;
  // Riding a stolen enemy flag down the lift IS the win — kick off the cinematic.
  victoryReturn = !!flags.find(f => f.carried && f.carrier === player);
  victoryHoldT = 0;
  // Title only on the field descent — the confetti celebration now plays in 3D
  // inside the hangar once the lift lands (see returnToGarage → garage.playWin).
  if (victoryReturn) showCelebTitle('VICTORY!', teamColor(PLAYER_TEAM), 'FLAG SECURED');
  clearLock();
  try { if (sound && sound.enabled) sound.toggle(); } catch (e) { /* audio is best-effort */ }   // engine winds down as it parks + lowers
  const h = Math.atan2(playerElev.center.x, playerElev.center.z);
  player.setPose(playerElev.center.x, playerElev.groundY, playerElev.center.z, h);   // re-centre on the pad
  playerElev.loop = false;
  playerElev.phase = 'lowering';
  playerElev.t = 0;
  playerElev.lift.position.y = playerElev.groundY;
  playerElev.setRider(player, h);
}

function returnToGarage() {
  returning = false;
  exitFortPlace(); exitTowerPick();   // belt-and-suspenders: kill any lingering garage aerial overlay before the hangar shows
  clearRepairIcons();                 // the field loop stops ticking updateRepairIcons, so live 🔧 icons would orphan over the hangar
  // Did the player ride an enemy flag all the way down into the garage? That's the capture.
  const captured = flags.find(f => f.carried && f.carrier === player);
  if (player) { removeCombatant(player); scene.remove(player.group); player = null; }
  updatePlayerHud();
  ensureGarage();
  garage.reset();
  garage.applyRoster(playerLosses);   // reflect this match's losses in the roster
  onField = false;
  if (sound) sound.setSpatialActive(false);   // mute remote engines while in the hangar
  setGarageOverlays(true);
  setFieldUI(false);
  garageFadeT = 0;   // fade the garage in from black
  if (captured) {
    captured.carried = false; captured.carrier = null; captured.returnT = 0;
    captured.group.position.set(captured.home.x, captured.home.y, captured.home.z);   // flag back on its post
    flagsCaptured++;   // the VICTORY cinematic already played over the descent (playVictory)
    // The player extraction is the WIN, but it never routes through endMatch (that
    // path only handles AI captures). Mark the match decided here so the block below
    // runs the victory cinematic + play-again menu instead of dropping back into a
    // live garage and letting the match continue.
    matchOver = true; matchWon = true; publishAILive(1);   // final ai-lab snapshot, flagged over
  }
  clearCeleb();        // tidy any field confetti/title before the hangar shows
  // Match decided (not a mid-match death/redeploy) → celebrate, then open the
  // play-again menu (a pick reloads into a brand new world).
  if (matchOver) {
    if (matchWon) {
      if (CAMPAIGN_ID) markCompleted(CAMPAIGN_ID);   // beat a campaign level → unlock the next
      // In-hangar victory cinematic: the winner presented on the lift with the flag
      // and 3D confetti, VICTORY title, then the menu pops over it after a beat.
      const c = teamColor(PLAYER_TEAM);
      // The presented flag is the TROPHY — the enemy's flag we just carried home — so the
      // cloth flies THEIR colour (confetti/title still celebrate in ours).
      const stolen = teamColor(PLAYER_TEAM === 'red' ? 'blue' : 'red');
      garage.playWin('firebrat', c, stolen);   // the Firebrat is the only flag-carrier, so it's always the winner on the lift
      showCelebTitle('VICTORY!', c, 'FLAG SECURED');
      setTimeout(() => { hideCelebTitle(); showGameMenu({ header: 'VICTORY', sub: 'MATCH OVER', reload: true, campaign: !!CAMPAIGN_ID }); }, WIN_CINEMATIC_MS);
    } else {
      showGameMenu({ header: 'DEFEAT', sub: 'MATCH OVER', reload: true });
    }
  }
}

// Security-camera overlay for the garage: vignette + scanlines + REC + clock.
function mountCCTV() {
  const style = document.createElement('style');
  style.textContent = `
    #cctv { position:fixed; inset:0; pointer-events:none; z-index:50;
      background:
        repeating-linear-gradient(0deg, rgba(0,0,0,0.13) 0px, rgba(0,0,0,0) 2px, rgba(0,0,0,0) 3px),
        radial-gradient(ellipse at center, rgba(0,0,0,0) 42%, rgba(0,0,0,0.6) 100%);
      font:13px ui-monospace, monospace; color:#cfe6cf; text-shadow:0 0 4px rgba(0,0,0,0.9); letter-spacing:1px; }
    #cctv .rec { position:absolute; bottom:40px; left:18px; color:#ff5a5a; display:flex; align-items:center; gap:7px; }
    #cctv .dot { width:9px; height:9px; border-radius:50%; background:#ff3b3b; box-shadow:0 0 7px #ff3b3b; animation:cctvb 1.4s steps(1) infinite; }
    #cctv .cam { position:absolute; bottom:16px; right:18px; opacity:0.85; }
    #cctv .clk { position:absolute; bottom:16px; left:18px; opacity:0.85; }
    @keyframes cctvb { 50% { opacity:0.1; } }`;
  document.head.appendChild(style);
  const o = document.createElement('div');
  o.id = 'cctv';
  o.innerHTML = '<div class="rec"><span class="dot"></span>REC</div><div class="cam">CAM 04 · HANGAR</div><div class="clk"></div>';
  document.body.appendChild(o);
  const clk = o.querySelector('.clk');
  const tick = () => { clk.textContent = new Date().toISOString().replace('T', '  ').replace(/\..+/, ''); };
  tick(); setInterval(tick, 1000);
}

// Hangar HUD — ported from the Vehicle Designer's stat card. The selected
// vehicle's NAME + role sit in the upper-left; its SPEED/ARMOR/FIREPOWER dot bars
// in the upper-right. Updates on every selection.
function mountHangarHud(garage) {
  const style = document.createElement('style');
  style.textContent = `
    #hud-name { position:fixed; top:64px; left:20px; z-index:58; pointer-events:none;
      font:13px ui-monospace, monospace; color:#00eeff; text-shadow:0 0 6px rgba(0,238,255,0.4); }
    #hud-name .nm { font-size:24px; font-weight:bold; letter-spacing:0.22em; }
    #hud-name .cnt { font-size:14px; font-weight:bold; margin-left:10px; color:#e8c84a; text-shadow:0 0 6px rgba(232,200,74,0.4); }
    #hud-name .role { display:block; margin-top:6px; max-width:340px; font-size:11px; line-height:1.5;
      letter-spacing:0.06em; color:#5fbfd0; text-shadow:none; }
    #hud-stats { position:fixed; top:18px; right:20px; z-index:58; pointer-events:none;
      background:rgba(5,12,20,0.78); border:1px solid #0e2030; padding:12px 16px; min-width:190px;
      font:11px ui-monospace, monospace; }
    #hud-stats .row { display:flex; align-items:center; justify-content:space-between; gap:14px; margin:5px 0; }
    #hud-stats .lab { letter-spacing:0.15em; color:#5a7a8a; }
    #hud-stats .bar { font-size:14px; letter-spacing:0.08em; color:#00eeff; }
    #garage-paused { position:fixed; top:14px; left:50%; transform:translateX(-50%); z-index:58;
      pointer-events:none; font:bold 13px ui-monospace,monospace; letter-spacing:0.45em; text-indent:0.45em;
      color:#ffcf4a; text-shadow:0 0 8px rgba(255,207,74,0.35); padding:6px 14px;
      border:1px solid rgba(255,207,74,0.35); border-radius:6px; background:rgba(5,12,20,0.6); }
    #build-panel { position:fixed; top:132px; right:20px; z-index:59;
      background:rgba(5,12,20,0.78); border:1px solid #0e2030; padding:10px 12px; width:216px;
      font:11px ui-monospace, monospace; }
    #build-panel.collapsed { width:auto; padding:7px 12px; }
    #build-panel.collapsed .bp-body { display:none; }
    #build-panel .scrap { color:#ffcf4a; letter-spacing:0.12em; margin-bottom:8px; cursor:pointer; user-select:none; -webkit-user-select:none; white-space:nowrap; }
    #build-panel.collapsed .scrap { margin-bottom:0; }
    #build-panel .bp-caret { display:inline-block; margin-left:8px; color:#7fa8bf; transition:transform 0.15s; }
    #build-panel:not(.collapsed) .bp-caret { transform:rotate(90deg); }
    #build-panel .scrap b { font-size:15px; }
    #build-panel .shop-sec { color:#5a7a8a; letter-spacing:0.18em; font-size:9px; margin:7px 0 4px; }
    #build-panel .shop-grid { display:grid; grid-template-columns:1fr 1fr; gap:6px; }
    #build-panel .shop-tile { position:relative; cursor:pointer; border:1px solid #1f6b3f; border-radius:5px;
      background:#0b1c12; padding:4px 4px 3px; text-align:center; }
    #build-panel .shop-tile:hover:not(.off) { background:#143524; }
    #build-panel .shop-tile.off { opacity:0.38; cursor:default; border-color:#333; }
    #build-panel .shop-tile img { width:100%; height:56px; object-fit:contain; display:block; }
    #build-panel .shop-tile .tl { display:block; font-size:9px; letter-spacing:0.08em; color:#8ff0b0; margin-top:2px; }
    #build-panel .shop-tile .upg-arrow { position:absolute; top:46%; left:50%; transform:translate(-50%,-50%); font-size:30px; line-height:1; color:#5fd66a; pointer-events:none; text-shadow:0 0 5px rgba(0,0,0,0.85), 0 2px 4px rgba(0,0,0,0.95); }
    #build-panel .shop-tile .pr { position:absolute; top:3px; right:5px; color:#ffcf4a; font-weight:bold; font-size:11px; }
    #build-panel .shop-tile .ct { position:absolute; top:3px; left:5px; color:#6fa9c9; font-size:10px; }
    #build-panel .bp-hint { margin-top:6px; min-height:13px; color:#7089; letter-spacing:0.08em; }`;
  document.head.appendChild(style);

  // The garage freezes the field sim — say so, so nobody wonders if the war rages on unseen.
  const paused = document.createElement('div');
  paused.id = 'garage-paused';
  paused.textContent = 'PAUSED';
  document.body.appendChild(paused);

  const name = document.createElement('div');
  name.id = 'hud-name';
  name.innerHTML = `<span class="nm"></span><span class="cnt"></span><span class="role"></span>`;
  document.body.appendChild(name);

  const stats = document.createElement('div');
  stats.id = 'hud-stats';
  const ROWS = ['speed', 'armor', 'firepower'];
  stats.innerHTML = ROWS.map(k =>
    `<div class="row"><span class="lab">${k.toUpperCase()}</span><span class="bar" id="hud-${k}"></span></div>`).join('');
  document.body.appendChild(stats);

  // SCRAP SHOP — spend collected scrap: replace lost vehicles, or order fortifications
  // (wall / bastion / armed bastion) placed via the hologram flow (enterFortPlace).
  const panel = document.createElement('div');
  panel.id = 'build-panel';
  const vehTile = t => `<div class="shop-tile" data-veh="${t}"><span class="ct" id="shop-ct-${t}"></span>` +
    `<span class="pr">${BUILD_COST[t]}⚙</span><img src="thumbnails/${t}.png" alt=""><span class="tl">${VEHICLE_TYPES[t].label.toUpperCase()}</span></div>`;
  const fortTile = (kind, thumb, label) => `<div class="shop-tile" data-fort="${kind}">` +
    `<span class="pr">${fortCostOf(kind)}⚙</span><img src="thumbnails/${thumb}.png" alt=""><span class="tl">${label}</span></div>`;
  // Collapsible: starts as just the header BUTTON (mobile — the open panel covers the vehicles).
  // Tap the header to expand/collapse; the scrap count stays visible either way.
  panel.classList.add('collapsed');
  panel.innerHTML = `<div class="scrap" id="bp-toggle">⚙ SCRAP SHOP <b id="bp-scrap">0</b><span class="bp-caret">▸</span></div>`
    + `<div class="bp-body">`
    + `<div class="shop-sec">VEHICLES</div>`
    + `<div class="shop-grid">${['firebrat', 'lurcher', 'valkyrie', 'jotun'].map(vehTile).join('')}</div>`
    + `<div class="shop-sec">FORTIFICATIONS</div>`
    + `<div class="shop-grid">${fortTile('wall', 'wall', 'WALL')}${fortTile('bastion', 'bastion', 'BASTION')}${fortTile('armed', 'tower', 'GUN TOWER')}</div>`
    + `<div class="shop-sec">TOWER UPGRADES</div>`
    + `<div class="shop-grid"><div class="shop-tile" data-upg="1"><span class="upg-arrow">&#9650;</span><img src="thumbnails/tower.png" alt=""><span class="tl">UPGRADE</span></div></div>`
    + `<div class="bp-hint" id="bp-hint"></div>`
    + `</div>`;
  document.body.appendChild(panel);
  panel.querySelector('#bp-toggle').addEventListener('click', () => panel.classList.toggle('collapsed'));

  const bar = (v, max = 5) => '▪'.repeat(v) + '▫'.repeat(max - v);
  const update = () => {
    const s = garage.selected();
    if (!s) return;
    const def = VEHICLE_TYPES[s.type];
    name.querySelector('.nm').textContent = def.label.toUpperCase();
    name.querySelector('.cnt').textContent = '×' + garage.remaining(s.type);
    name.querySelector('.role').textContent = def.role;
    for (const k of ROWS) document.getElementById('hud-' + k).textContent = bar(def.stat[k]);
    updateBuild();
  };
  const hint = msg => { document.getElementById('bp-hint').textContent = msg; };
  const updateBuild = () => {
    const have = teamScrap[PLAYER_TEAM] || 0;
    document.getElementById('bp-scrap').textContent = have;
    for (const tile of panel.querySelectorAll('[data-veh]')) {
      const t = tile.dataset.veh;
      const lost = (playerLosses[t] || 0) > 0, afford = have >= (BUILD_COST[t] || 0);
      tile.classList.toggle('off', !(lost && afford));
      document.getElementById('shop-ct-' + t).textContent = '×' + garage.remaining(t);
    }
    const crewFree = !repairJobs.some(j => j.team === PLAYER_TEAM)
      && motorPool[PLAYER_TEAM] && motorPool[PLAYER_TEAM].some(sl => sl.state === 'parked');
    for (const tile of panel.querySelectorAll('[data-fort]')) {
      tile.classList.toggle('off', have < fortCostOf(tile.dataset.fort) || !crewFree);
    }
    const upgTile = panel.querySelector('[data-upg]');
    if (upgTile) upgTile.classList.toggle('off', !fortHomeCamp() || playerTowers().length === 0);
  };
  panel.addEventListener('click', e => {
    const tile = e.target.closest('.shop-tile');
    if (!tile) return;
    const have = teamScrap[PLAYER_TEAM] || 0;
    if (tile.dataset.veh) {
      const t = tile.dataset.veh;
      if ((playerLosses[t] || 0) <= 0) { hint('no lost ' + VEHICLE_TYPES[t].label.toUpperCase() + ' to replace'); return; }
      if (have < (BUILD_COST[t] || 0)) { hint(`need ${(BUILD_COST[t] || 0) - have} more scrap`); return; }
      if (buildVehicle(t)) { hint(VEHICLE_TYPES[t].label.toUpperCase() + ' rebuilt from salvage'); update(); }
      return;
    }
    if (tile.dataset.upg) {   // open the outside picker to choose a tower to upgrade
      if (!fortHomeCamp()) { hint('deploy once first — the island is not built yet'); return; }
      if (!enterTowerPick()) hint('no standing towers to upgrade');
      return;
    }
    const kind = tile.dataset.fort;
    if (!fortHomeCamp()) { hint('deploy once first — the island is not built yet'); return; }
    if (have < fortCostOf(kind)) { hint(`need ${fortCostOf(kind) - have} more scrap`); return; }
    if (repairJobs.some(j => j.team === PLAYER_TEAM)) { hint('construction crew already out'); return; }
    if (!motorPool[PLAYER_TEAM].some(sl => sl.state === 'parked')) { hint('no jeeps left in the pool'); return; }
    enterFortPlace(kind);
  });
  _refreshBuildPanel = updateBuild;
  garage.onSelect(update);
  // Relay clack when the player switches to a different vehicle (the selection light moves).
  // Deduped by slot index so it doesn't fire on the initial pick or on roster rebuilds that
  // keep the same selection.
  let _lastSelIdx = garage.selIndex;
  garage.onSelect(idx => {
    if (idx === _lastSelIdx) return;
    _lastSelIdx = idx;
    if (sound) sound.vehicleSelectUI();
  });
  update();
}

// Team-color selection — a row of swatches along the bottom. Picking one redraws
// the shared camo canvas, recolouring every vehicle at once. Free to change while
// in the garage; the choice gets LOCKED + recorded the moment the first vehicle is
// deployed up the elevator (Phase C), after which this row is no longer offered.
function mountTeamSelector() {
  const style = document.createElement('style');
  style.textContent = `
    #teamsel { position:fixed; bottom:16px; left:50%; transform:translateX(-50%); z-index:61;
      display:flex; gap:10px; align-items:center; padding:9px 14px; border-radius:11px;
      background:rgba(16,20,26,0.9); border:1px solid #2b333d; box-shadow:0 6px 20px rgba(0,0,0,0.5);
      font:11px ui-monospace, monospace; color:#9aa4b0; }
    #teamsel .lab { letter-spacing:1px; margin-right:2px; }
    #teamsel .sw { width:30px; height:30px; border-radius:7px; cursor:pointer; border:2px solid transparent;
      box-shadow:inset 0 0 0 1px rgba(0,0,0,0.4); position:relative; }
    #teamsel .sw.active { border-color:#fff; box-shadow:0 0 10px rgba(255,255,255,0.6); }
    #teamsel .name { min-width:54px; text-align:center; color:#dfe6ee; letter-spacing:1px; }`;
  document.head.appendChild(style);

  const row = document.createElement('div');
  row.id = 'teamsel';
  row.innerHTML = `<span class="lab">TEAM</span>`
    + TEAM_COLORS.map((c, i) =>
        `<div class="sw${i === camoParams.colorIndex ? ' active' : ''}" data-i="${i}" style="background:${c.hex}" title="${c.name}"></div>`).join('')
    + `<span class="name" id="teamname">${TEAM_COLORS[camoParams.colorIndex].name}</span>`;
  document.body.appendChild(row);

  row.querySelectorAll('.sw').forEach(sw => {
    sw.addEventListener('click', () => {
      const i = parseInt(sw.dataset.i);
      updateCamo({ colorIndex: i });                       // camo body (shared texture)
      const hex = TEAM_COLORS[i].hex;
      if (garage) for (const s of garage.slots) s.vehicle.setTeamColor(hex);   // glow/accent bits
      row.querySelectorAll('.sw').forEach(s => s.classList.toggle('active', s === sw));
      row.querySelector('#teamname').textContent = TEAM_COLORS[i].name;
    });
  });
}

// Help: a small "?" button (bottom-right) that toggles a controls panel, so the
// instructions aren't pinned on screen the whole time. Content depends on mode.
mountHelp();
function mountHelp() {
  const style = document.createElement('style');
  style.textContent = `
    #helpbtn { position:fixed; bottom:44px; right:14px; z-index:70; width:30px; height:30px;
      border-radius:50%; border:1px solid #2b333d; background:rgba(16,20,26,0.9); color:#cdd3da;
      font:bold 15px ui-monospace, monospace; cursor:pointer; }
    #helpbtn:hover { color:#fff; border-color:#3a4654; }
    #helppanel { position:fixed; bottom:82px; right:14px; z-index:70; width:250px; display:none;
      background:rgba(16,20,26,0.94); color:#cdd3da; border:1px solid #2b333d; border-radius:8px;
      padding:12px 14px; font:12px/1.5 ui-monospace, monospace; box-shadow:0 6px 20px rgba(0,0,0,0.5); }
    #helppanel.open { display:block; }
    #helppanel h3 { margin:0 0 8px; font-size:11px; letter-spacing:1px; color:#e8c84a; }
    #helppanel .k { color:#7fd0ff; }
    #helppanel div { margin:4px 0; }`;
  document.head.appendChild(style);

  const rows = GARAGE ? [
    ['◀ ▶ / A D', 'change vehicle type'],
    ['1 – 4', 'pick a type directly'],
    ['Click', 'select a vehicle’s type'],
    ['Space / click again', 'deploy'],
    ['Swatches', 'choose team color'],
  ] : [
    ['W A S D', 'drive'],
    ['Q E', 'strafe'],
    ['Click / tap', 'fire'],
    ['Scroll', 'zoom (spectate)'],
    ['LOG', 'AI decision log'],
  ];
  const btn = document.createElement('button');
  btn.id = 'helpbtn'; btn.textContent = '?';
  const panel = document.createElement('div');
  panel.id = 'helppanel';
  panel.innerHTML = `<h3>${GARAGE ? 'HANGAR CONTROLS' : 'CONTROLS'}</h3>`
    + rows.map(([k, d]) => `<div><span class="k">${k}</span> — ${d}</div>`).join('');
  btn.addEventListener('click', () => panel.classList.toggle('open'));
  document.body.appendChild(btn);
  document.body.appendChild(panel);
}

// Live controls -> regenerate.
// Map-gen tuning panel (the ⚙ MAP button + sliders) is dialled in — keep it out of
// normal play, available on demand with ?mapgen for tuning sessions.
if (!GARAGE && QS.has('mapgen')) new Controls(DEFAULTS, rebuild);

// --- Tap-to-damage test (temporary, until vehicles can shoot) ----------
// A quick tap (not an orbit drag) fires a damage burst at whatever it hits,
// so destructibility is verifiable on a phone with no console.
const ray = new THREE.Raycaster();
// Debug handle (headless verification / console poking).
window.RR = {
  THREE, scene, camera, map,
  planPath: (v, dest, opts) => planPath(v, dest, opts),          // nav benchmark / path probes
  cellBlocked: (v, i, j) => cellBlocked(v, i, j),
  // What a route costs priced the way A* prices ground — so a probe can check that smoothing
  // never made a route dearer, rather than taking the pass's word for it.
  pathCost: (v, pts) => {
    let sum = 0;
    for (let i = 1; i < pts.length; i++)
      walkCells(pts[i-1].x, pts[i-1].z, pts[i].x, pts[i].z, (ci, cj, seg) => { sum += vehCellCost(v, ci, cj) * seg; });
    return sum;
  },
  walkCells: (ax, az, bx, bz, cb) => walkCells(ax, az, bx, bz, cb),   // exact cell traversal, for probes
  vehCellCost: (v, i, j) => vehCellCost(v, i, j),                // nav benchmark: equivalence checking
  navStats: () => ({ obstacles: obstacles.length, gates: gates.length, cell: grid.cell,
    cells: Math.ceil(map.worldW / grid.cell) * Math.ceil(map.worldH / grid.cell) }),
  mapCfg: () => MAP_CFG,                                       // debug: the decoded ?mapcfg (designed map), or null
  get destructibles() { return destructibles; },
  get soldiers() { return soldiers; },                          // debug: the base-infantry corps (counts/behavior probes)
  get minefield() { return minefield; },                        // debug: Firebrat land mines
  get sensorNet() { return sensorNet; },                        // debug: Firebrat sensor pods
  get gadgetStats() { return gadgetStats; },                    // debug: per-match mine/pod telemetry
  liveMines: () => minefield.items.length,
  livePods: () => sensorNet.items.length,
  layMine: (x, z, team = PLAYER_TEAM) => minefield.place(x, z, team, teamColor(team)),
  dropPod: (x, z, team = PLAYER_TEAM) => sensorNet.place(x, z, team, teamColor(team)),
  get camps() { return camps; },
  // Tower repair crews (prototype)
  setRepairs: (v) => { repairsOn = !!v; return repairsOn; },   // A/B: enable/disable jeep repair crews
  setAiUpgrades: (v) => { aiUpgradesOn = !!v; return aiUpgradesOn; },   // A/B: AI spends surplus scrap on tower upgrades
  setTurtleGuard: (v) => { turtleGuardOn = !!v; setTurtleGuard(!!v); return turtleGuardOn; },   // A/B: turtle v2 defender pack
  setHunterHarass: (v) => { setHunterHarass(!!v); return !!v; },   // A/B: hunter disruption tours
  get matchWinner() { return lastWinner; },
  aiUpgradeStatus: () => { const per = {}; for (const c of camps) { let n = 0, m = 0; for (const w of c.walls) if (w.turret) { n += w.turret.upg || 0; m++; } (per[c.team] ??= []).push(n); } return { on: aiUpgradesOn, byCamp: per }; },   // total stars per camp
  orderRepair: (team = PLAYER_TEAM) => orderRepair(team),      // force a repair for a team (debug/testing)
  repairStatus: () => { const pool = (t) => ({ parked: motorPool[t].filter(s => s.state === 'parked').length, deployed: motorPool[t].filter(s => s.state === 'deployed').length, lost: motorPool[t].filter(s => s.state === 'lost').length }); return { on: repairsOn, jobs: repairJobs.map(j => ({ team: j.team, state: j.state, gun: j.gun, progress: +j.progress.toFixed(1), pathLen: j.path ? j.path.length : 0, jeepDead: j.jeepDest.dead, jx: +j.jx.toFixed(1), jz: +j.jz.toFixed(1), jy: +j.jeep.position.y.toFixed(2) })), jeeps: { red: pool('red'), blue: pool('blue') }, scrap: { ...teamScrap }, cd: { red: +(_repairCd.red || 0).toFixed(1), blue: +(_repairCd.blue || 0).toFixed(1) } }; },
  woundTower: (team, frac = 0.4) => { const h = findWoundedTowerAny(team); if (h) h.wall.body.damage(h.wall.maxHp * (1 - frac)); return !!h; },  // debug: bang up a tower to test repair
  // Tower upgrades (star path): install n stars on a team's towers. all=true hits every standing
  // tower; otherwise just the first found. Returns the levels applied + resulting stats.
  upgradeTower: (team = PLAYER_TEAM, n = 1, all = false) => {
    const tm = team === 'a' ? 'red' : team === 'b' ? 'blue' : team;
    const out = [];
    for (const c of camps) {
      if (c.team !== tm) continue;
      for (const w of c.walls) {
        if (!w.turret || w.turret.dead || !w.body || w.body.dead) continue;
        const lvl = upgradeTower(w, n);
        if (lvl >= 0) { out.push({ lvl, maxHp: w.maxHp, ...towerStats(lvl) }); if (!all) return out; }
      }
    }
    return out;
  },
  upgradeJeep: (team = PLAYER_TEAM) => { const h = findWoundedTowerAny(team); return h ? deployUpgrade(team, h.camp, h.wall) : false; },   // debug: roll an upgrade jeep to the first tower
  enterTowerPick: () => enterTowerPick(), exitTowerPick: () => exitTowerPick(),   // debug: drive the tower-upgrade picker
  fireStatus: () => fireStatus(),   // debug: pool occupancy — the count is the budget
  // Light one on demand, in front of the camera by default — for eyeballing the effect without
  // waiting for something to actually blow up.
  testFire: (x, z, scale = 1) => {
    const p = (x == null) ? camera.position.clone().add(camera.getWorldDirection(new THREE.Vector3()).multiplyScalar(60))
                          : new THREE.Vector3(x, 0, z);
    return fireBurst(p.x, map ? map.heightAt(p.x, p.z) : 0, p.z, scale);
  },
  // A whole wreck's worth (main + spot fires), so the pool budget can be exercised without
  // having to stage the kills. Returns how many actually lit.
  testWreck: (x, z, scale = 1) => fireWreck(x, map ? map.heightAt(x, z) : 0, z, scale,
                                            (gx, gz) => (map ? map.heightAt(gx, gz) : 0)),
  fxCounts: () => ({ blood: bloodMarks.length, tents: crushables.length, crushed: crushables.filter(c => c.crushed).length, bloodPos: bloodMarks.slice(0, 5).map(m => ({ x: +m.position.x.toFixed(0), y: +m.position.y.toFixed(2), z: +m.position.z.toFixed(0), vis: m.visible, scl: +m.scale.x.toFixed(1) })) }),   // debug: blood marks + squishable-tent state
  killTowerGun: (team) => { const h = findWoundedTowerAny(team); if (h) h.wall.turretDest.damage(1e9); return !!h; },   // debug: shoot a tower's gun off (test gun purchase)
  destroyTower: (team) => { const h = findWoundedTowerAny(team); if (h) h.wall.body.damage(1e9); return !!h; },         // debug: flatten a tower (test rubble rebuild)
  grantScrap: (team, n = 10) => { teamScrap[team] = (teamScrap[team] || 0) + n; updateScrapHud(); return teamScrap[team]; },   // debug: bank scrap for a team
  repairStats: () => JSON.parse(JSON.stringify(repairStats)),   // cumulative per-match repair telemetry (sorties/heals/guns/jeep fates)
  // Multi-unit slots (elevator = one fielded unit)
  setSupplyW: (team, w) => setSupplyW(team, w),   // A/B: per-team repair weights (hpUrge, nearMax, nearFar)
  setUnitCap: (n) => { aiUnitCap = n == null ? null : Math.max(1, n | 0); return aiUnitCap; },   // A/B: force the per-team unit cap (null = back to counting elevators)
  unitCap: (i = 0) => { const c = commanders[i]; return c ? c.unitCap() : null; },
  slots: (i = 0) => { const c = commanders[i]; return c ? c._slots.map(s => ({ type: s.unit ? s.unit.type : null, dead: s.unit ? !!s.unit.dead : null, respawnT: +s.respawnT.toFixed(1), rising: s._rising, swapping: s.strategy ? s.strategy.step === 'swap' : false, state: s._dbg ? s._dbg.state : null, px: s._dbg ? s._dbg.px : null, pz: s._dbg ? s._dbg.pz : null, card: s.strategy ? (s.strategy.constructor.name || '') : null, step: s.strategy ? s.strategy.step : null })) : null; },   // debug: per-slot fielded unit + its role card
  jeepShotTarget: (v) => jeepShotTarget(v),                     // debug: the enemy jeep this unit would pot-shot (null = none in reach)
  constructFort: (kind, cx, cz, rot = 0, team = PLAYER_TEAM) => constructFort(team, kind, cx, cz, rot),   // build-a-tower: order a wall/bastion/armed build
  enterFortPlace: (kind) => enterFortPlace(kind), exitFortPlace: () => exitFortPlace(),   // debug: drive the hologram flow
  fortPlaceInfo: () => fortPlace && { kind: fortPlace.kind, cx: fortPlace.cx, cz: fortPlace.cz, ok: fortPlace.ok, why: fortPlace.why },
  fortCost: (kind) => fortCostOf(kind),
  fortSiteOk: (cx, cz) => fortSiteOk(cx, cz),
  get placedWalls() { return placedWalls; },                    // debug: player/designer-built forts
  killRepairJeep: (team = PLAYER_TEAM) => { const j = repairJobs.find(x => x.team === team); if (!j) return false; j.jeepDest.damage(1e9); return true; },  // debug: blow the crew's jeep (test cancel)
  raidJeep: (team = PLAYER_TEAM) => { const s = motorPool[team].find(x => x.state === 'parked'); if (!s) return false; s.dest.damage(1e9); return true; },  // debug: destroy a jeep parked in the lot (test raid)
  refillJeeps: (team = PLAYER_TEAM) => { let n = 0; for (const s of motorPool[team]) if (s.state === 'lost') { parkSlot(s); n++; } return n; },   // debug: restore lost jeeps to the lot
  get motorPool() { return motorPool; },                        // debug: parked-jeep slots per team
  setTeamHuman: (team) => { TEAM_CTRL[team] = 'human'; return { ...TEAM_CTRL }; },   // debug: test the player click path
  repairIconInfo: () => ({ icons: repairIcons.size, eligible: TEAM_CTRL[PLAYER_TEAM] === 'human' ? repairEligible(PLAYER_TEAM).length : 0 }),
  clickRepairIcon: (i = 0) => { const els = repairIconWrap ? [...repairIconWrap.children] : []; if (!els[i]) return false; els[i].dispatchEvent(new PointerEvent('pointerdown')); return true; },   // debug: fire an icon's click path
  get placedWalls() { return placedWalls; },                   // debug: designer-placed fort pieces (custom maps)
  get placedProps() { return placedProps; },                   // debug: designer-placed generic structures (custom maps)
  damageTapAt: (x, y) => damageTapAt(x, y),
  rebuild: (patch) => rebuild(patch),
  frame: () => frameMap(),
  look: (x, z, dist, pitch, yaw) => { orbit.target.set(x, 0, z); orbit.dist = dist; if (pitch != null) orbit.pitch = pitch; if (yaw != null) orbit.yaw = yaw; updateCamera(); },
  freeCam: () => { spectateFree = true; },   // debug/shot: stop the spectate follow so a rig can pin the camera
  // Match clock in seconds — what a replay link's `at=` is measured in. Taken from a commander's
  // own match timer rather than wall clock, so it means the same thing headless and on screen.
  matchTime: () => (commanders[0] && commanders[0]._matchT) || 0,
  // Hooks the replay lab drives the game through (lab/replay.html). Deliberately tiny and
  // general — a time scale and "point the camera at this unit" are things a game may as well
  // have; none of the lab's own logic lives in here.
  setTimeScale: (x) => { timeScale = Math.max(0, Math.min(8, x)); return timeScale; },
  watch: (v) => { spectateTarget = v || null; spectateFree = !v; },
  watched: () => spectateTarget,
  scatterFoliage: () => scatterFoliage(),    // debug/shot: re-scatter foliage on demand
  setGrassDensity: (m) => { grassDensityMul = Math.max(0, +m); scatterFoliage(); return grassDensityMul; },   // re-scatters
  setSurf: (patch) => setSurf(patch),   // shoreline surf/wave tuning, live — the knobs lab/surf.html drives
  get surf() { return SURF; },
  get foliage() { return foliage; },
  get camera() { return camera; },   // debug: headless shot rigs position the camera for close-ups
  get roadNet() { return roadNet; },
  get vehicles() { return vehicles; },
  get elevators() { return elevators; },
  get submarines() { return activeSub ? [activeSub] : []; },        // debug: the on-demand sub (0 or 1)
  get flags() { return flags; },   // debug: capturable flags
  bloodAt: (x, z, r = 1.6) => addBloodMark(x, z, r),   // debug: drop a blood mark (screenshots)
  deepDangerR: () => DEEP_DANGER_R,                             // debug: radius past which subs patrol
  setSubs: (v) => { subsOn = !!v; return subsOn; },            // A/B: enable/disable the deep-water sub hazard
  get player() { return player; },
  setNavHScale: (h) => { NAV_HSCALE = Math.max(0.1, +h || 1); return NAV_HSCALE; },      // A* greediness; 1.0 reverts to admissible
  saveRunner: () => aiSaveRunner,
  setReachArrive: (v) => { aiReachArrive = !!v; return aiReachArrive; },   // A/B: cap an unreachable goal at the closest reachable point
  setSaveRunner: (v) => { aiSaveRunner = !!v; setSaveRunnerScore(aiSaveRunner); return aiSaveRunner; },   // A/B: protect the last flag carrier (both halves)
  setMsnDirKey: (v) => { aiMsnDirKey = !!v; return aiMsnDirKey; },   // A/B: file tour results under the directional mission key
  setGradedTour: (v) => { aiGradedTour = !!v; return aiGradedTour; },   // A/B: graded tour report card vs the old 3% pass/fail
  setNavBudget: (ms) => { NAV_FRAME_BUDGET_MS = Math.max(0, +ms || 0); return NAV_FRAME_BUDGET_MS; },  // per-AI-pass A* ms budget; 1e9 = effectively off
  navNodes: () => _astarFrameNodes,
  resetNavNodes: () => { _astarFrameNodes = 0; },   // benchmark hook: start a fresh 'frame'
  spawnPlayer: (type = 'firebrat', colorIndex = 4, rise = false) => deployToFOB(type, colorIndex, rise),
  get garage() { return garage; },
  winDemo: (type = 'firebrat', hex = '#46d6ff') => { ensureGarage(); garage.playWin(type, hex); },   // headless: stage the victory cinematic
  get onField() { return onField; },
  get returning() { return returning; },
  forceReturn: () => { if (player && playerElev) { leftPad = true; beginReturn(); } },
  // Preview the end-of-match cinematic without playing a whole round.
  celebrate: (kind = 'victory', team = PLAYER_TEAM) => kind === 'defeat' ? playDefeat() : playVictory(team),
  teamColorName: (t) => teamColorName(t),                     // debug: a team's palette colour name (win banner)
  roadDeckY: (x, z) => roadDeckY(x, z),                       // debug: road/bridge surface height, or null
  bridgeDeckY: (x, z) => roadDeckY(x, z),                     // alias (kept for older verification scripts)
  navPlan: (v, x, z) => planPath(v, { x, z }),                 // debug: A* path for a unit
  tgtEvents: () => tgtEvents,                                  // target-decision trace (was the old target still alive when we left it?)
  navAlarms: () => navAlarms,                                  // driver ALARM autopsies this match (flight recordings)
  navAlarmsByTeam: () => ({ ...navAlarmsByTeam }),             // running per-team alarm count (uncapped) — for per-commander analysis
  navAlarmStats: () => ({ alarms: Driver.alarmsTotal, violations: Driver.violationsTotal, violationsBy: { ...Driver.violationsBy }, yields: Driver.yieldSamples, goalSnaps, navBail: { ...navBail }, navBailEp: JSON.parse(JSON.stringify(navBailEp)), navBailWorst: navBailWorst.slice() }),   // match-wide driver counters (goalSnaps = impossible goals rescued, navBail = ticks that got no order at all, navBailEp = the sustained ones)
  navScuttles: () => ({ total: navScuttles.length, byTeam: { ...navScuttlesByTeam }, list: navScuttles.slice(-12) }),   // stuck units the driver destroyed
  decisionAlarms: () => ({ dryTrips: dryTripsTotal, swapLoops: swapLoopsTotal, standFails, standCrossfire, recallAborts: recallAbortsTotal, recallVsFlee: recallVsFleeTotal, flagCarries: flagCarriesTotal, carrierRefuels: carrierRefuelsTotal,
    // How every flag run ENDED. scored + runnerDied + heldAtEnd should account for flagCarries;
    // a shortfall means a run ended some way none of these three describes, which is itself worth
    // knowing. `stalls` overlaps the others on purpose — a stalled run can still be killed later.
    flagScored: flagRunsScored, flagRunnerDied: flagRunsRunnerDied,
    flagHeldAtEnd: flags.filter(f => f.carried && f.carrier && !f.carrier.dead).length,
    flagStalls: flagRunStalls, flagStallList: flagRunStallList.slice(-8) }),
  cellReach: (v, x, z) => { const F = reachFrom(v), k = navIdx(Math.round(x / grid.cell), Math.round(z / grid.cell)); return k >= 0 && !!F[k]; },   // debug: can THIS hull drive to (x,z)?
  hasLOSAt: (ax, az, bx, bz) => hasLOS(ax, az, bx, bz),   // debug: is there a clean line between two points?
  standFailOf: (i = 0) => { const c = commanders[i]; return c ? (c._standFail || null) : null; },   // debug: the last [STANDOFF ALARM] breakdown   // units that reached the enemy base and never fired; recalls answered by the same chassis
  setNavScuttle: on => { aiNavScuttle = !!on; return aiNavScuttle; },   // pinned-past-grace self-destruct on/off
  setVehSwap: on => { aiVehSwap = !!on; return aiVehSwap; },   // A/B: blame the chassis for a failing mission, or only the mission
  setPadFight: on => { aiPadFight = !!on; return aiPadFight; },   // A/B: fight from under the elevator shield vs always drive out first
  setReverseCap: on => { aiReverseCap = !!on; return aiReverseCap; },   // half-throttle reverse doctrine (bisection knob)
  setRightOfWay: on => { aiRightOfWay = !!on; if (!aiRightOfWay) RESV.clear(); return aiRightOfWay; },   // friendly path-reservation yielding (A/B knob)
  missionScores: () => commanders.map(c => ({ team: c.team, arch: c.archetype, step: c.strategy && c.strategy.step, scores: c._missionScores || [] })),   // live weight breakdown per team
  setJoust: on => setJoust(on),                                         // Valkyrie jousting runs vs legacy hover-duel (A/B knob)
  setAlign: on => setAlign(on),                                         // duel footwork as an ALIGN order vs steering itself (A/B knob)
  reseed: n => { if (_rngReseed) { _rngReseed(n); return true; } return false; },   // re-pin the ?rngseed stream at drive-start (kills load-order ghosts)
  setGateBand: on => { aiGateBand = !!on; return aiGateBand; },         // nav mirrors the shut-gate physics slab (A/B the gate-band-hug fix)
  setStandHold: on => { aiStandHold = !!on; return aiStandHold; },      // hysteretic siege sense — hold a committed stand past the enter ring (A/B the suppress/advance strobe fix)
  setSightCone: on => { sightCone = !!on; return sightCone; },          // forward vision cone on/off (stealth A/B tournament)
  getSightCone: () => sightCone,
  setConeAngles: (full, half, blind) => { if (full != null) CONE.full = full; if (half != null) CONE.half = half; if (blind != null) CONE.blind = blind; return { ...CONE }; },
  setScan: on => { aiScan = !!on; return aiScan; },                      // scan-sweep at objective transitions on/off (stealth follow-on)
  getScan: () => aiScan,
  setScanParams: p => { Object.assign(SCAN, p || {}); return { ...SCAN }; }, // { arc, max, rate, cool } — tune the sweep
  setDefendInPlace: on => { aiDefendInPlace = !!on; return aiDefendInPlace; }, // defend-under-fire responds in the current vehicle vs home-swap (A/B)
  getDefendInPlace: () => aiDefendInPlace,
  setStand2: on => { aiStand2 = !!on; return aiStand2; },                  // lab-logic standoff vs old radial+_standRot (A/B)
  setLandmass: on => { aiLandmass = !!on; return aiLandmass; },            // refuse goals on ground we can't drive to (A/B)
  // Landmass census: how many components the map actually has and how big they are. The point
  // is to know whether the "target across water" idea describes this map at all before trusting
  // a test built on it — a single-component island means it can never fire.
  lmDebug: () => {
    if (!navStatic) buildNavStatic();
    if (!navComp) buildNavComp();
    const size = new Map();
    for (const id of navComp) if (id) size.set(id, (size.get(id) || 0) + 1);
    const cells = navComp.length, water = cells - [...size.values()].reduce((a, b) => a + b, 0);
    return { components: size.size, cells, water, biggest: [...size.values()].sort((a, b) => b - a).slice(0, 6) };
  },
  setStandRelease: on => { aiStandRelease = !!on; return aiStandRelease; },// give up a firing position held outside our own weapon range (A/B)
  setStandRoute: on => { aiStandRoute = !!on; return aiStandRoute; },      // route the whole way to a firing position (A/B)
  setFlyerRoute: on => { aiFlyerRoute = !!on; return aiFlyerRoute; },      // route flyers as GOTO straight lines (A/B)
  setStandArrive: on => { aiStandArrive = !!on; return aiStandArrive; },   // arrive ON the firing position vs 14u short (A/B)
  setSmooth: on => { aiSmoothPath = !!on; return aiSmoothPath; },          // string-pull A* routes (A/B)
  setMsnAttrib: on => { aiMsnAttrib = !!on; return aiMsnAttrib; },         // grade a death against the primary mission, not the errand it died on (A/B)
  setFleeScore: on => { aiFleeScore = !!on; setFleeScore(aiFleeScore); return aiFleeScore; },   // flee scored rather than preempting (A/B)
  setFightMission: on => { aiFightMission = !!on; setFightMission(aiFightMission); return aiFightMission; },   // a duel becomes a mission (A/B)
  setReqVehicle: on => { aiReqVehicle = !!on; setReqVehicle(aiReqVehicle); return aiReqVehicle; },   // price whether the fleet can crew each plan (A/B)
  crewFor: key => commanders.map(c => ({ team: c.team, key, ...requiredVehicle(c, key) })),          // what would roll out for `key`, and what it costs — probe/ai-lab readout
  primaryKey: () => commanders.map(c => ({ team: c.team, step: c.strategy && c.strategy.step, msnKey: c._msnKey, primary: c._primaryKey })),   // attribution readout for probes/ai-lab
  setSmoothClear: on => { smoothClear = !!on; return smoothClear; },        // require hull clearance on a shortcut (A/B)
  smoothStats: () => ({ cut: smoothCut, kept: smoothKept }),               // waypoints the smoothing pass removed vs kept
  setDeepLog: on => { aiDeepLog = !!on; setDeepLogStrategies(!!on); return aiDeepLog; },   // raw console.log tracing at the silent-fallback decision points
  getDeepLog: () => aiDeepLog,
  setCapRoutes: on => { setCapRoutes(!!on); return !!on; },                // multi-waypoint capture routes vs single staging (A/B)
  setStandBand: b => { STAND.band = Math.max(0, Math.min(0.98, +b || 0.6)); return STAND.band; },   // how far out to stand (0.55 close/fast … 0.85 far/safe)
  getStandBand: () => STAND.band,
  navCellBlocked: (v, i, j) => cellBlocked(v, i, j),          // debug: nav passability of a cell
  astar: () => toggleAstarViz(),                              // open/close the A* search visualizer overlay
  get paused() { return paused; },                            // debug: is the sim frozen (full log or A* viz open)

  get astarViz() { if (!_astarViz) _astarViz = new AstarViz(); return _astarViz; },   // debug: the viz instance
  astarBuildGrid: (name) => buildAstarGrid(name),            // debug: the cost/inBounds/bounds for a grid
  avoidCell: (x, z) => avoidCell(x, z),                       // debug: blacklist a cell (stuck-escalation)
  get gateCells() { return [...gateCells]; },
  get gateSideCells() { return [...gateSideCells]; },
  get aiEvents() { return aiEvents.slice(); },                 // debug: the rolling AI decision log (headless can't read the DOM overlay)
  get combatEvents() { return combatEvents.slice(); },         // debug: vehicle-vs-vehicle hit feed
  planCount: () => _planCount,                                 // debug: cumulative A* planPath calls (needs ?perf to increment)
  planByAll: () => ({ ..._planByAll }),                        // whole-match planPath calls by CALLER
  breachDbg: () => ({ ..._breachDbg }),
  replanWhy: () => ({ ..._pfWhyAll }),                         // whole-match replan causes: trigger, and trigger/state
  planBy: () => ({ ..._planBy }),                              // debug: those calls attributed to their CALLER (nav vs standoff) — needs ?perf
  setVision: (v) => { AI_VISION = v; return AI_VISION; },      // base sight range (A/B the "less distraction" idea)
  getVision: () => AI_VISION,
  setShieldSight: (m) => { SHIELD_SIGHT_MULT = m; return SHIELD_SIGHT_MULT; },   // shield beacon sight = m × base (A/B scouting-for-shields)
  setSight: (type, m) => { SIGHT[type] = m; return { ...SIGHT }; },   // per-vehicle: how far this type SEES
  setVis: (type, m) => { VIS[type] = m; return { ...VIS }; },         // per-vehicle: how far this type is SEEN
  visionTables: () => ({ base: AI_VISION, SIGHT: { ...SIGHT }, VIS: { ...VIS } }),
  recStart: (mode) => recStart(mode),                          // FLIGHT RECORDER: capture per-unit decision changes (mode 'changes'|'all')
  recStop: () => recStop(),
  recDump: () => recDump(),                                    // → [{t,ty,reason,state,hp,am,fu,threat,threatLOS,enemyD,out,…}]
  aiConfig: (k, v) => v === undefined ? getBrainConfig(k) : setBrainConfig(k, v),   // read/set a brain knob at runtime (auto-tuning sweeps)
  aiEvents: () => aiArchive,                                   // full structured decision-event archive (headless analysis)
  roadCells: () => roadNet.cells,                              // road layout cells (headless parallel-road checks)
  setPaused: (v) => { paused = !!v; },                         // debug: freeze the sim (screenshots)
  setLogMode: (m) => setLogMode(m),                            // debug: drive the log overlay ('hidden'|'brief'|'full')
  drawSonar: (sources) => {                                    // debug: render synthetic sources through the real sonar-arc pipeline (HUD geometry tests)
    ensureSoundHud();
    _sonarDebug = true;                                        // keep updateSoundHud from hiding/clearing the debug frame (no listener on the menu screen)
    soundHudCanvas.style.display = '';
    const W = window.innerWidth, H = window.innerHeight;
    soundHudCanvas.width = W; soundHudCanvas.height = H;
    const g = soundHudCtx; g.clearRect(0, 0, W, H);
    return sources.map(s => drawSonarArcs(g, W, H, s));
  },
  setRank: (i, k) => {                                         // debug: pin a rank on combatants[i] (promotion screenshots/tuning)
    const v = combatants[i]; if (!v || v.dead) return null;
    v.rankKills = Math.max(0, Math.min(RANK_MAX, k));
    applyRankHp(v); updateRankStars(v); if (v.bar) updateHealthBar(v);
    const bank = rankBankFor(v); if (bank) bank[v.type] = v.rankKills;
    return rankLabel(v.rankKills);
  },
  get roadNet() { return roadNet; },                           // full network incl. per-connection paths (debug)
  setFof: (team, patch) => Object.assign(fofFor(team), patch || {}),                // override this team's fight-or-flight weights (A/B self-play)
  getFof: (team) => ({ ...fofFor(team) }),
  fofDefault: () => ({ ...FOF_DEFAULT }),
  setRunnerMode: (m) => setRunnerMode(m),   // 'old' | 'new' — A/B the runner-lost response on paired matchups
  setRogueRearSiege: (v) => setRogueRearSiege(v),   // true|false — A/B the Rogue Valkyrie rear-siege (HQ from behind)
  setRearSneakGate: (v) => setRearSneakGate(v),   // true|false — A/B: gate the Firebrat back-door sneak on the rear towers being dead
  exploreFrac: (i = 0) => { const c = commanders[i]; return c && c.explore ? c.explore.fraction() : null; },   // debug: fraction of map this team has scouted
  exploreWp: (i = 0) => { const c = commanders[i]; return c ? c._exploreWp : null; },                          // debug: current recon waypoint
  aiRoster: (i = 0) => { const c = commanders[i]; return c ? { roster: { ...c.roster }, left: c.fleetLeft(), eliminated: c._eliminated } : null; },   // debug: remaining fleet
  // Fast-forward the field sim by fixed steps (headless verification runs ~0.2x
  // real-time, so this advances GAME time without waiting on the slow renderer).
  stepField: (dt = 0.05, n = 1) => {
    for (let k = 0; k < n; k++) {
      if (matchOver) break;
      updateCommanders(dt);
      for (const e of elevators) e.update(dt);
      for (const v of vehicles) v.idle(dt);
      projectiles.update(dt); updateProjectileHits();
      destructibles.update(dt);
      updateResupplies(dt); updateScrap(dt); updateGibs(dt); updateWallTurrets(dt); updateTowerUpgrades(); updateCrushables(); updateLock(dt);
      tickFire(dt);   // lifecycle only — nothing is drawn here, but the pool must still recycle
      // FX LIFECYCLE belongs here too. updateFx only ages, removes and disposes — nothing about
      // it needs a frame. Without it, every spark and explosion raised while the renderer is idle
      // piled up forever: a headless tournament accumulated them for a whole 30,000-tick match,
      // and the replay lab's seek made it visible — a hundred queued shots all flushing on the
      // first drawn frame, which looked like a unit firing ten rounds at once.
      updateFx(dt);
      if (soldiers) soldiers.update(dt, combatants);
      updateGadgets(dt);
      updateRepairs(dt);
      updateSubmarines(dt);
      decaySoundPings(dt);   // AI hearing reads these; render-only decay left them stuck in headless
    }
  },
  blockedAt: (x, z) => blockedAt(x, z),
  planPathTo: (v, x, z) => planPath(v, { x, z }),   // debug: A* path a unit would take to (x,z), or null
  get obstacles() { return obstacles; },
  get grid() { return grid; },
  fire: () => firePlayer(),
  acquireForwardTarget: () => { const t = acquireForwardTarget(); return t ? t.type : null; },
  // --- sound-awareness HUD hooks ---
  soundListenerType: () => { const l = soundListener(); return l ? l.type : null; },
  soundSources: () => { const l = soundListener(); return soundSources(l).map(s => ({ type: s.type, loud: +s.loud.toFixed(3) })); },
  emitSoundPing: (x, y, z, idx, team) => emitSoundPing(x, y, z, idx, team),
  get projectiles() { return projectiles; },
  get combatants() { return combatants; },
  get elevators() { return elevators; },
  lookAt: (x, z, dist = 90, pitch = 1.0, yaw = 0) => { orbit.target.set(x, 0, z); orbit.dist = dist; orbit.pitch = pitch; orbit.yaw = yaw; updateCamera(); },   // debug: frame a spot (headless screenshots)
  terrainAt: (x, z) => map.heightAt(x, z),   // debug/tools: world surface height (<=0 = underwater) for shore-stuck analysis
  get commanders() { return commanders; },
  get flags() { return flags; },
  get teamCtrl() { return TEAM_CTRL; },
  damageVehicle: (v, amt, shooter = null) => damageVehicle(v || player, amt, 'vehicle', shooter),
  get damageTally() { return { ...dmgTally }; },
  explodeAt: (x, y, z, blast = 4, dmg = 100) => explodeAt(new THREE.Vector3(x, y, z), blast, dmg, null, null),
  // Headless test hook: run one combat sim step (projectile flight + hits + fx).
  tickCombat: (dt = 0.05) => { projectiles.update(dt); updateProjectileHits(); if (foliage) foliage.update(dt); updateFx(dt); updateGibs(dt); },
  tickAI: (dt = 0.1) => updateCommanders(dt),
  get sound() { return sound; },
  tickEngines: () => updateEngineSounds(),
  armAudio: () => { ensureSound().setSpatialActive(true); },
  applyAltitude: (v, dt = 0.1) => applyAltitude(v || player, dt),
  startCommanders: (reserved) => startCommanders(reserved),
  get lock() { return lock; },
  get resupplies() { return resupplies; },
  get scrapPiles() { return scrapPiles; },   // debug: salvage on the ground — probes ask if a hull can actually reach each one
  get scrapPiles() { return scrapPiles; },       // live salvage piles on the field
  get gibCount() { return gibChunks.length; },   // debug: debris pieces currently mid-flight
  get teamScrap() { return { ...teamScrap }; },   // scrap banked per team
  get scrapBuilds() { return { ...scrapBuilds }; },   // vehicles built from salvage this match
  setTeamScrap: (team, n) => { if (team in teamScrap) teamScrap[team] = n | 0; return teamScrap[team]; },
  buildVehicle: (type) => buildVehicle(type),     // spend scrap → replace a lost vehicle (garage)
  setAiScrap: (v) => { aiScrapBuild = !!v; return aiScrapBuild; },   // A/B: AI rebuild-from-scrap on/off
  setScrapTightArrive: (v) => { aiScrapTightArrive = !!v; return aiScrapTightArrive; },   // A/B: salvage detour closes to pickup range vs mission arriveDist
  setPostKillMoveOn: (v) => { aiPostKillMoveOn = !!v; return aiPostKillMoveOn; },   // A/B: drop engage-afterglow ghost on a kill (no post-kill linger)
  setKillLoot: (v) => { aiKillLoot = !!v; return aiKillLoot; },   // A/B: killers grab the wreck they just made on/off
  setKeepBreach: (v) => { aiKeepBreach = !!v; return aiKeepBreach; },   // A/B: flatten-HQ-early + grab-with-back-towers on/off
  setTargetPrio: (v) => { aiTargetPrio = !!v; return aiTargetPrio; },   // A/B: scored siege targets vs the old tower queue
  setGambitAfter: (v) => { GAMBIT_AFTER = +v; return GAMBIT_AFTER; },   // A/B: seconds of stalemate before the "Valkyrie around the back" gambit (Infinity = off)
  setHqFinisher: (v) => setHqFinisher(v),   // A/B: field a Valkyrie to crack the HQ once the fort is down
  get hqSwaps() { return _hqSwapCount; },   // debug: how many finisher swaps have fired
  setFlagGrab: (n) => { FLAG_GRAB_TURRETS = Math.max(0, n | 0); return FLAG_GRAB_TURRETS; },   // max turrets standing for a grab
  setRoadSpeed: (m) => { ROAD_SPEED_MUL = m; return ROAD_SPEED_MUL; },   // tune the on-road speed boost (1 = off)
  setShieldCap: (n) => { RR_shieldCap = Math.max(0, n | 0); return RR_shieldCap; },   // how many shields run the fancy shader (0 = all cheap)
  testShield: (i = 0) => { const u = commanders[i] && commanders[i].unit; if (!u) return false; if (u.maxShield <= 0) u.maxShield = 100; u.shield = u.maxShield; ensureShieldFx(u); return true; },   // debug: force a shield bubble
  get playerLosses() { return playerLosses; },
  get matchOver() { return matchOver; },
  get matchWon() { return matchWon; },
  tickFlags: (dt = 0.1) => updateFlags(dt),
  tickResupply: (dt = 0.1) => updateResupplies(dt),
  fireUnit: (v) => fireVehicle(v, false),
  fireAtWorld: (x, y, z, v, atEnemy = false) => fireVehicle(v || player, false, new THREE.Vector3(x, y, z), null, atEnemy),
  tickLock: (dt = 0.1) => updateLock(dt),
  lockOnVehicle: (v) => setLock(v, null),
  lockPoint: (x, y, z) => setLock(null, new THREE.Vector3(x, y, z)),
  clearLock: () => clearLock(),
  acquireLock: (px, py) => acquireLock(px, py),
  tickDrive: (dt = 0.1) => driveUpdate(dt),
  refreshHud: () => updatePlayerHud(),
  // --- touch aim-stick test hooks ---
  setAimStick: (nx, ny, mag) => { touchAim = { nx, ny, mag: mag == null ? Math.hypot(nx, ny) : mag }; },
  clearAimStick: () => { touchAim = null; touchAiming = false; fireHeld = false; },
  tickTouchAim: () => updateTouchAim(),
  // --- touch nav-stick test hooks ---
  setNav: (nx, ny, mag) => { touchNav = nx == null ? null : { nx, ny, mag: mag == null ? Math.hypot(nx, ny) : mag }; },
  navInput: () => (player && !player.dead ? driveInput() : null),
  orbitYaw: () => orbit.yaw,
  get touchAimState() { return { aiming: touchAiming, fireHeld, aimPoint: _aimPoint ? { x: _aimPoint.x, y: _aimPoint.y, z: _aimPoint.z } : null, target: _aimTargetVeh ? _aimTargetVeh.type : null, valid: _aimValid }; },
  showTouchControls: () => { touchUsed = true; if (onField) setFieldUI(true); },
  // --- targeting test hooks ---
  setCursor: (px, py) => { _cursor = { x: px, y: py }; },
  refreshReticle: () => updateAimReticle(),
  aimPlayerTurret: (dt = 0.1) => aimPlayerTurret(player, dt),
  aimInfo: () => ({
    valid: _aimValid,
    point: _aimPoint ? { x: _aimPoint.x, y: _aimPoint.y, z: _aimPoint.z } : null,
    targetVeh: _aimTargetVeh ? _aimTargetVeh.type : null,
    reticleVisible: aimReticle ? aimReticle.visible : false,
    reticleColor: aimReticle ? aimReticle._mat.color.getHex() : 0,
    turretYaw: player && player.model ? (player.model.aimYaw || 0) : null,
    aligned: player ? !!player._aligned : null,
  }),
  spawnEnemy: (type, x, z, y) => {
    const v = new Vehicle(type); v.setScale(0.72);
    const gy = y != null ? y : vehicleGroundY(x, z);
    v.setPose(x, gy, z, 0);
    scene.add(v.group);
    initCombatant(v, PLAYER_TEAM === 'red' ? 'blue' : 'red', 5, false);
    return v.hp;
  },
  enemyHp: () => { const e = combatants.find(c => !c.isPlayer && !c.dead); return e ? e.hp : null; },
  cycleSpectate: (dir = 1) => { cycleSpectate(dir); return spectateTarget ? spectateTarget.type : null; },
  nav: (on) => { navDebug = on == null ? !navDebug : !!on; return navDebug; },   // debug: combined nav overlay (A* route for grounders, goal-line for flyers)
  navLines: (on) => { navDebug = on == null ? !navDebug : !!on; return navDebug; },   // legacy alias for RR.nav()
  setScoutSweep: (m) => setSweepMode(m),   // A/B: 'near' (new forward sweep) vs 'far' (old ping-pong)
  tickSpectate: (dt = 0.1) => spectateUpdate(dt),
  refreshAiLog: () => updateAiLog(),
  get spectateFocus() { return spectateTarget; },
  aiView: (i = 0) => { const c = commanders[i]; return c && c.unit ? c._view(c.unit, 0.1) : null; },
  aiKnownSupplyCount: (i = 0) => { const c = commanders[i]; return c ? c.knownSupplies.size : null; },
  aiKnownTowers: (i = 0) => {   // debug: this team's DISCOVERED towers (fog-of-war intel, as last seen)
    const c = commanders[i]; if (!c) return null;
    return { known: c.knownTowers.size, plannable: c.plannableTowers().length,
      towers: [...c.knownTowers.values()].map(k => ({ x: Math.round(k.x), z: Math.round(k.z), armed: k.armed, seenT: Math.round(k.seenT) })) };
  },
  // Headless targeting hook: where would the AI aim to lead this moving enemy? (jitter 0 → deterministic)
  leadAim: (sx, sy, sz, ex, ez, vx, vz, soundIndex) => { const p = leadAim({ x: sx, y: sy, z: sz }, { x: ex, y: 0, z: ez, vx, vz }, soundIndex, 0); return { x: p.x, y: p.y, z: p.z }; },
  returnToGarage: () => returnToGarage(),
  get flagsCaptured() { return flagsCaptured; },
  tickTurrets: (dt = 0.1) => updateWallTurrets(dt),
  get islandBound() { return islandBound; },
  get renderer() { return renderer; },   // debug: program cache / draw stats (renderer.info)
};
function damageTapAt(px, py) {
  const ndc = new THREE.Vector2(
    (px / window.innerWidth) * 2 - 1,
    -(py / window.innerHeight) * 2 + 1,
  );
  ray.setFromCamera(ndc, camera);
  const hit = destructibles.pick(ray);
  if (hit) destructibles.damageAt(hit.point, 2.5, 90);
}

// --- Resize + loop -----------------------------------------------------
window.addEventListener('resize', () => {
  applyCameraFov();
  renderer.setSize(window.innerWidth, window.innerHeight);
  if (garage) garage.onResize();
});

// Perf readout (bottom-right). DRAW = draw calls — drops as chunks cull.
const perfEl = document.getElementById('perf');
let fpsEma = 60, perfTick = 0;
// The corner readout, in three pieces so the [+] survives the 3Hz innerHTML rewrite of the stats
// (one blob would wipe the button every update). #perf is pinned by its BOTTOM edge, so the panel
// grows upward and the button stays put in the corner where your thumb already is.
const perfBaseEl = document.createElement('div');
{
  const more = document.createElement('div'); more.id = 'perf-more';
  const btn = document.createElement('button'); btn.id = 'perf-more-btn'; btn.textContent = '+';
  // #perf is pointer-events:none so the readout never eats a tap meant for the world; the button
  // opts back in for itself. 30px so it's a real touch target on a phone.
  btn.style.cssText = 'pointer-events:auto;margin-top:3px;width:30px;height:30px;line-height:1;'
    + 'font:16px/1 "Courier New",monospace;color:#1d2b33;background:rgba(255,255,255,0.45);'
    + 'border:1px solid rgba(29,43,51,0.45);border-radius:6px;cursor:pointer;padding:0;';
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    perfExpanded = !perfExpanded;
    btn.textContent = perfExpanded ? '–' : '+';
    // Collection follows the panel — but never switch it OFF under ?perf, which owns it.
    PERF = PERF_PANEL || perfExpanded;
    // Start a fresh window. Without this the first sample divides a handful of frames by however
    // many minutes have passed since the last render, and opens on an invented 0 fps.
    _pfShownAt = performance.now();
    for (const k in _pfAcc) _pfAcc[k] = 0;
    _pfFrames = 0; _pfWork = 0; _planCount = 0;
    if (!perfExpanded) more.innerHTML = '';
  });
  if (perfEl) { perfEl.appendChild(more); perfEl.appendChild(perfBaseEl); perfEl.appendChild(btn); }
}

const clock = new THREE.Clock();
// --- A* path overlay (?nav) -------------------------------------------
// Draws each AI unit's CACHED route (commander._nav.path) as a ground line in the team
// colour, a bright dot on the current target waypoint, and a cone on the destination.
// Pure visualisation of data the navigator already stores — no extra pathfinding. Runs
// live and KEEPS drawing while the sim is paused (full-screen log), so you can freeze a
// wedged unit and read exactly where its path is sending it (e.g. a line into the sea).
// ?nav (or the legacy ?navlines) turns on ONE combined overlay: it draws whichever nav method
// the unit is actually using — the full A* route for a ground unit that has one, or a straight
// line to its live brain-goal for a flyer / a unit skirting without a path. Toggle: g / RR.nav().
let navDebug = QS.has('nav') || QS.has('navlines');
// The routeless-Firebrat AUTO-FREEZE (below) is now its own opt-in (?navprobe), decoupled from the
// ?nav overlay — the overlay draws routes without ever pausing; the freeze-and-inspect only arms
// when you explicitly ask for it, so watching nav no longer slams a pause the instant a Firebrat is
// momentarily routeless.
const navProbe = QS.has('navprobe');
let navLines = null;   // Map<commander, {line, posAttr, wp, dest, label, cells}>
// The states where _navOverride actually STEERS the unit along its cached A* route. In any other
// state (combat engage/suppress, unstick) the unit ignores nav.path and steers by the behavior —
// so the overlay must NOT draw the stale path (it points wherever the unit last navigated, e.g.
// back to base) and must NOT label it "A* route". Keep this in sync with _navOverride's switch.
const NAV_ASTAR_STATES = new Set(['advance', 'pursue', 'resupply', 'assault']);
// ?nav auto-probe: the first time a FIREBRAT is trying to navigate but its A* came back empty,
// freeze the sim and open the A* visualizer ON THAT FIREBRAT'S OWN COST from its cell to its goal
// — so you can see whether a route actually exists and why the nav didn't take it. Fires once per
// episode (re-arms once the unit gets a route again) and only while ?navprobe is set (opt-in).
const _fbNavProbed = new WeakSet();
function _maybeProbeFirebratNav(cmd, v, d, nav) {
  if (!navProbe) return;                 // opt-in only (?navprobe) — never auto-pauses under plain ?nav
  if (v.type !== 'firebrat') return;
  const wantsNav = d && NAV_ASTAR_STATES.has(d.state) && d.gx != null;
  const noRoute = !nav.path || !nav.path.length;
  if (!wantsNav || !noRoute) { _fbNavProbed.delete(v); return; }   // it has a route now → re-arm the probe
  if (_fbNavProbed.has(v) || (_astarViz && _astarViz.isOpen)) return;
  _fbNavProbed.add(v);
  _astarVizVeh = v;                                     // viz uses THIS firebrat's real cost
  if (!_astarViz) _astarViz = new AstarViz();
  _astarViz.open({ buildGrid: buildAstarGrid, gridNames: ['unit nav', 'road layout'], defaultGrid: 'unit nav',
    three: THREE, scene, camera, domElement: renderer.domElement, cell: grid.cell, hoverY: astarHoverY() });
  paused = true;
  const cc = grid.cell;
  const start = { i: Math.round(v.holder.position.x / cc), j: Math.round(v.holder.position.z / cc) };
  let goal = { i: Math.round(d.gx / cc), j: Math.round(d.gz / cc) };
  goal = nearestOpenCell(v, goal.i, goal.j, 7) || goal;   // snap to the same reachable cell planPath targets
  const dbg = _astarViz.runFor(start, goal);
  aiLog(cmd.team, `${cmd.cname} firebrat: ?nav A* PROBE — ${dbg.pathLen ? 'route EXISTS (' + dbg.pathLen + ' cells, ' + dbg.steps + ' nodes searched)' : 'genuinely NO route (' + dbg.steps + ' nodes searched)'} → goal (${Math.round(d.gx)},${Math.round(d.gz)})`);
}
// Most recent AI-log line for a team (shown on the floating nav label so you can read a
// unit's latest "thinking" right over its head).
function lastAiMsg(team) {
  for (let i = aiEvents.length - 1; i >= 0; i--) if (aiEvents[i].team === team) return aiEvents[i].msg;
  return null;
}
// A camera-facing text label (canvas texture) that floats over a unit. Redrawn only when the
// text actually changes (cached key) so it costs nothing while a unit holds a decision.
function _makeNavLabel() {
  const cv = document.createElement('canvas'); cv.width = 512; cv.height = 320;
  const tex = new THREE.CanvasTexture(cv); tex.minFilter = THREE.LinearFilter;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  sp.renderOrder = 1001; sp.scale.set(20, 12.5, 1);   // world units, aspect 512:320
  sp.center.set(0.5, 1);   // anchor at the TOP: the pill is sized to its content, so unused canvas hangs below transparently
  scene.add(sp);
  return { sprite: sp, canvas: cv, ctx: cv.getContext('2d'), tex, last: '' };
}
// lines: [{ text, color, size, bold, wrap }] — top-to-bottom on a dark pill. The old renderer
// divided a FIXED canvas height evenly between lines and clipped anything wide, so a long
// bottom line simply vanished. This one word-wraps `wrap` lines to the pill width, lays the
// rows out top-down at their natural heights, and sizes the pill to what's actually drawn.
function _drawNavLabel(lbl, lines) {
  const key = lines.map(l => l.text + l.color).join('|');
  if (lbl.last === key) return;   // unchanged → skip the canvas upload
  lbl.last = key;
  const ctx = lbl.ctx, W = lbl.canvas.width, H = lbl.canvas.height, PAD = 22;
  // Expand wrapped lines FIRST so the pill height matches the real row count.
  const rows = [];
  for (const ln of lines) {
    ctx.font = `${ln.bold ? 'bold ' : ''}${ln.size || 32}px "Courier New",monospace`;
    if (!ln.wrap || ctx.measureText(ln.text).width <= W - PAD * 2) { rows.push(ln); continue; }
    const words = ln.text.split(' ');
    let cur = '', n = 0;
    for (const w of words) {
      const t = cur ? cur + ' ' + w : w;
      if (ctx.measureText(t).width > W - PAD * 2 && cur) {
        rows.push({ ...ln, text: cur }); cur = w;
        if (++n >= 3) { cur += '…'; break; }   // cap runaway messages at 3 wrapped rows
      } else cur = t;
    }
    if (cur) rows.push({ ...ln, text: cur });
  }
  const rowH = (l) => Math.round((l.size || 32) * 1.18);
  let total = 14;
  const fit = [];
  for (const r of rows) { const h = rowH(r); if (total + h > H - 10) break; fit.push(r); total += h; }
  total += 8;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = 'rgba(8,12,18,0.74)';
  ctx.fillRect(6, 6, W - 12, total - 6);
  ctx.fillStyle = 'rgba(255,255,255,0.12)'; ctx.fillRect(6, 6, W - 12, 3);   // top hairline
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  let y = 14;
  for (const ln of fit) {
    const h = rowH(ln);
    ctx.fillStyle = ln.color || '#dfe8ef';
    ctx.font = `${ln.bold ? 'bold ' : ''}${ln.size || 32}px "Courier New",monospace`;
    ctx.fillText(ln.text, W / 2, y + h / 2);
    y += h;
  }
  lbl.tex.needsUpdate = true;
}
// The grid cells a unit is actually CONFLICTING with — the ones lit red. Its blocked feelers
// (what it's grinding right now) plus, for a unit beelining with no A* route, the blocked cells
// its straight line runs through (e.g. the deep-water inlet it can't cross). v._blocked is the
// same oracle the collision + A* use, so a red cell is a cell this unit truly can't enter.
function _navConflictCells(v, d, onAstar) {
  const c = grid.cell, out = [], seen = new Set();
  const px = v.holder.position.x, pz = v.holder.position.z, h = v.heading;
  const push = (x, z) => {
    const ci = Math.round(x / c), cj = Math.round(z / c), k = ci + ',' + cj;
    if (seen.has(k)) return; seen.add(k);
    if (v._blocked(ci * c, cj * c)) out.push({ x: ci * c, z: cj * c });
  };
  for (const a of [0, 0.6, -0.6]) {   // forward / left / right feelers at the hull edge and 9u out
    const ax = -Math.sin(h + a), az = -Math.cos(h + a);
    push(px + ax * (VEH_R + 1), pz + az * (VEH_R + 1));
    push(px + ax * 9, pz + az * 9);
  }
  if (!onAstar && d && d.gx != null) {                 // not on a route (combat/beeline) — flag the wall/water on the line to the target
    const dx = d.gx - px, dz = d.gz - pz, len = Math.hypot(dx, dz) || 1, steps = Math.min(40, Math.ceil(len / c));
    for (let i = 1; i <= steps && out.length < 26; i++) { const t = i / steps; push(px + dx * t, pz + dz * t); }
  }
  return out;
}
function _makeNavObj() {
  const geo = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(new Float32Array(256 * 3), 3);
  posAttr.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', posAttr);
  const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ depthTest: false, transparent: true, opacity: 0.95 }));
  line.frustumCulled = false; line.renderOrder = 998;
  const wp = new THREE.Mesh(new THREE.SphereGeometry(0.9, 10, 10), new THREE.MeshBasicMaterial({ color: '#ffe24a', depthTest: false }));
  wp.renderOrder = 999;
  const dest = new THREE.Mesh(new THREE.ConeGeometry(1.5, 4.5, 10), new THREE.MeshBasicMaterial({ depthTest: false, transparent: true, opacity: 0.85 }));
  dest.rotation.x = Math.PI;   // apex points DOWN at the destination cell
  dest.renderOrder = 999;
  scene.add(line); scene.add(wp); scene.add(dest);
  return { line, posAttr, wp, dest, label: _makeNavLabel(), cells: [] };
}
// Lazily grow/reuse a pool of flat red squares marking conflict cells for one unit.
function _navCell(o, i) {
  if (!o.cells[i]) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(grid.cell * 0.9, grid.cell * 0.9),
      new THREE.MeshBasicMaterial({ color: '#ff3222', transparent: true, opacity: 0.42, depthTest: false, side: THREE.DoubleSide }));
    m.rotation.x = -Math.PI / 2; m.renderOrder = 997; scene.add(m); o.cells[i] = m;
  }
  return o.cells[i];
}
function updateNavOverlay() {
  if (!navDebug) return;
  if (!navLines) navLines = new Map();
  for (const o of navLines.values()) {
    o.line.visible = false; o.wp.visible = false; o.dest.visible = false; o.label.sprite.visible = false;
    for (const cm of o.cells) cm.visible = false;
  }
  if (!onField) return;
  const watched = spectateTarget || _specFocus || player;   // the watched unit draws bright, the rest dim
  for (const cmd of commanders) {
   for (const slot of cmd._slots) {   // one nav line per fielded unit (multi-unit slots)
    const v = slot.unit, nav = slot._nav;
    if (!v || v.dead) continue;
    const d = slot._dbg;
    // Draw the A* route ONLY when the unit is in a state that actually follows it — else the path
    // is stale (combat/unstick steer by behavior, not nav.path). A combat/no-route unit draws a
    // straight line to what it's genuinely steering at (d.gx/gz), so the line points the right way.
    // suppress FAR-TRAVEL path-follows A* too (navOverride, >26u to the stand) — show its real
    // route instead of a misleading "COMBAT · direct" line; close-in suppress stays combat-drawn.
    const usingAstar = nav && nav.path && nav.path.length && d
      && (NAV_ASTAR_STATES.has(d.state) || (d.state === 'suppress' && d.gd != null && d.gd > 30));
    _maybeProbeFirebratNav(cmd, v, d, nav);                  // ?nav: freeze + show A* when a firebrat has no route
    if (!usingAstar && (!d || d.gx == null)) continue;       // nothing meaningful to draw for this unit
    let o = navLines.get(slot);   // keyed per SLOT so each fielded unit gets its own line
    if (!o) { o = _makeNavObj(); navLines.set(slot, o); }
    const col = new THREE.Color(teamColor(cmd.team));
    const hot = v === watched;
    o.line.material.color.copy(col); o.dest.material.color.copy(col);
    o.line.material.opacity = hot ? 0.95 : 0.32;
    o.dest.material.opacity = hot ? 0.85 : 0.3;
    o.wp.material.opacity = hot ? 1 : 0.35; o.wp.material.transparent = true;
    // Floating per-unit text label removed (Jacob: that info now lives in the AI Lab Decision
    // Spine) — o.label.sprite stays hidden (set false at the top of this function each frame).
    // (Red conflict-cell squares removed — they cluttered the view sitting right on the units.
    // The blocked feelers are still in the flight recorder / STUCK label if needed for debugging.)
    if (usingAstar) {
      // GROUND unit on an A* route — trace the remaining path, bend marker + destination cone.
      const pts = nav.path, arr = o.posAttr.array;
      let n = 0;
      const add = (x, z) => { if (n >= 256) return; arr[n * 3] = x; arr[n * 3 + 1] = map.heightAt(x, z) + 1.3; arr[n * 3 + 2] = z; n++; };
      add(v.holder.position.x, v.holder.position.z);          // start the line at the unit itself
      // …then only the REMAINING route (from the current target onward). Drawing from
      // index 0 looped back to the path's original start — already behind the unit — which
      // read as the line "going backwards" before heading for the dot.
      for (let i = Math.min(nav.idx, pts.length - 1); i < pts.length; i++) add(pts[i].x, pts[i].z);
      o.posAttr.needsUpdate = true;
      o.line.geometry.setDrawRange(0, n);
      o.line.visible = true;
      // Dot = the next BEND in the route (or the destination), not the per-tick look-ahead
      // cell. The look-ahead point slides ~1 cell ahead of the unit every frame and looked
      // frantic; a bend is a stable landmark — it holds while the unit drives the straight
      // toward it, then hops to the next corner once passed.
      let bi = pts.length - 1;
      const start = Math.min(nav.idx, pts.length - 2);
      if (start >= 0) {
        const seg = i => Math.sign(pts[i + 1].x - pts[i].x) + ',' + Math.sign(pts[i + 1].z - pts[i].z);
        const d0 = seg(start);
        for (let i = start + 1; i <= pts.length - 2; i++) { if (seg(i) !== d0) { bi = i; break; } }
      }
      const w = pts[Math.min(bi, pts.length - 1)];             // the next turn the unit is driving toward
      o.wp.position.set(w.x, map.heightAt(w.x, w.z) + 1.6, w.z); o.wp.visible = true;
      const dp = pts[pts.length - 1];                          // the route's end (its destination)
      o.dest.position.set(dp.x, map.heightAt(dp.x, dp.z) + 3.2, dp.z); o.dest.visible = true;
    } else {
      // FLYER (ignoreWalls, no A*) or a unit skirting without a path — draw a straight line to
      // the live brain-goal from _dbg. This is what the old ?navlines tool did; folding it in
      // here means one ?nav toggle shows every unit's real intent, Valkyries included.
      const arr = o.posAttr.array;
      const gy = map.heightAt(d.gx, d.gz);
      arr[0] = v.holder.position.x; arr[1] = map.heightAt(v.holder.position.x, v.holder.position.z) + 1.3; arr[2] = v.holder.position.z;
      arr[3] = d.gx; arr[4] = gy + 1.3; arr[5] = d.gz;
      o.posAttr.needsUpdate = true;
      o.line.geometry.setDrawRange(0, 2);
      o.line.visible = true;
      o.wp.visible = false;                                    // no route bends on a direct line
      o.dest.position.set(d.gx, gy + 3.2, d.gz); o.dest.visible = true;
    }
   }
  }
}

// --- Sound-awareness HUD ----------------------------------------------------
// Lets the player HEAR opponents they can't see: a soft glow on the screen edge points
// toward an off-screen enemy's noise. Loudness = the enemy's engine (louder while moving)
// or a gunfire burst, scaled by distance + engine SIZE, and DAMPED by the player's own
// engine noise (you hear less while driving hard). Works with the volume muted — it's the
// visual twin of the spatial audio (mirrors SoundManager's ENGINE_SPATIAL tuning).
const ACOUSTIC = [
  { ref: 18, max: 125, gain: 0.95 },   // 0 Lurcher
  { ref: 12, max: 78,  gain: 0.60 },   // 1 Firebrat
  { ref: 16, max: 112, gain: 0.85 },   // 2 Valkyrie
  { ref: 26, max: 175, gain: 1.15 },   // 3 Jotun
];
const GUN_RANGE = 700;                 // gunfire carries far (matches SoundManager.fireGunAt)
const SND = { idleEmit: 0.30, gunLoud: 1.6, gunDecay: 1.2, selfMask: 0.6, minAudible: 0.10 };
const soundPings = [];                 // recent gun reports: { x, y, z, idx, team, life }
function emitSoundPing(x, y, z, idx, team, colorIndex) {
  soundPings.push({ x, y, z, idx, team, colorIndex, life: 1 });
  if (soundPings.length > 48) soundPings.shift();
}
// Fade out gun reports (~<1s). MUST run in the sim step, not just the render loop — the AI's
// hearing reads soundPings, so if they never decay a unit "hears" gunfire from a shot fired
// minutes ago and camps on the ghost forever. This lived only in updateSoundHud() (render-only),
// so headless stepField runs piled up 48 stale pings and froze units on phantom fire — a rig
// artifact that polluted every AI-vs-AI tournament. Ticked in BOTH stepField and updateSoundHud
// (the two are parallel loops; the real game runs animate→updateSoundHud, headless runs stepField).
function decaySoundPings(dt) {
  for (let i = soundPings.length - 1; i >= 0; i--) {
    soundPings[i].life -= dt * SND.gunDecay;
    if (soundPings[i].life <= 0) soundPings.splice(i, 1);
  }
}
function acFall(dist, ref, max) {
  if (dist <= ref) return 1;
  if (dist >= max) return 0;
  return (max - dist) / (max - ref);
}
// The source's IN-GAME team colour as an "r,g,b" string (the sonar HUD draws in the enemy's colour).
function teamRGB(colorIndex) {
  const hex = (TEAM_COLORS[colorIndex] && TEAM_COLORS[colorIndex].hex != null) ? TEAM_COLORS[colorIndex].hex : 0xffffff;
  return ((hex >> 16) & 255) + ',' + ((hex >> 8) & 255) + ',' + (hex & 255);
}
// Sonar edge-HUD tuning (see drawSonarArcs). Distances are WORLD units; radii/lengths are px.
const SONAR = {
  distNear: 25, distFar: 160,    // world distance → curvature: near=tight arc, far=flat
  Rmin: 44, Rmax: 360,           // screen curvature radius (px) at near / far — capped LOW so even a far source stays a visibly curved "signal icon", never a flat streak
  maxArcLen: 100,                // cap the drawn arc length — tight icon-sized arcs that don't run off the screen or stack across each other
  ringGap: 9, ringSpan: 3.2,     // louder → more concentric rings (loud*ringSpan), spaced ringGap px
  maxRings: 4, pad: 40,          // inset from the screen edge
};
let soundHudCanvas = null, soundHudCtx = null;
let _sonarDebug = false;   // RR.drawSonar latch — freeze the HUD for geometry screenshots
function ensureSoundHud() {
  if (soundHudCanvas) return;
  const c = document.createElement('canvas');
  c.id = 'sound-hud';
  c.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:55;';
  document.body.appendChild(c);
  soundHudCanvas = c; soundHudCtx = c.getContext('2d');
}
// Whose "ears" the HUD uses: the human player while driving, else the unit being spectated
// (so AvA / spectate shows what the watched unit hears). null = nobody to listen for.
function soundListener() {
  if (onField && player && !player.dead && TEAM_CTRL[PLAYER_TEAM] === 'human') return player;
  if (onField && _specFocus && !_specFocus.dead) return _specFocus;
  return null;
}
// Enemy sound sources currently audible to `listener` (for drawing + headless test).
function soundSources(listener) {
  const out = [];
  if (!listener || listener.dead) return out;
  const hp = listener.holder.position;
  const pa = ACOUSTIC[listener.def.soundIndex] || ACOUSTIC[0];
  const selfNoise = pa.gain * (SND.idleEmit + (1 - SND.idleEmit) * (listener._throttle || 0)) * SND.selfMask;
  for (const v of combatants) {
    if (v.dead || v === listener || v.team === listener.team || vehicleHidden(v)) continue;
    const a = ACOUSTIC[v.def.soundIndex] || ACOUSTIC[0];
    const dist = Math.hypot(v.holder.position.x - hp.x, v.holder.position.z - hp.z);
    const emit = a.gain * (SND.idleEmit + (1 - SND.idleEmit) * (v._throttle || 0));
    const loud = emit * acFall(dist, a.ref, a.max) - selfNoise;
    if (loud > SND.minAudible) out.push({ pos: v.holder.position, loud, dist, type: 'engine', color: teamRGB(v.colorIndex) });
  }
  for (const p of soundPings) {
    if (p.team === listener.team) continue;
    const a = ACOUSTIC[p.idx] || ACOUSTIC[0];
    const dist = Math.hypot(p.x - hp.x, p.z - hp.z);
    const loud = SND.gunLoud * a.gain * acFall(dist, a.ref, GUN_RANGE) * p.life - selfNoise;
    if (loud > SND.minAudible) out.push({ pos: { x: p.x, y: p.y, z: p.z }, loud, dist, type: 'gun', color: teamRGB(p.colorIndex) });
  }
  return out;
}
const _shv = new THREE.Vector3();
// SONAR edge-HUD: an off-screen enemy noise draws as concentric arcs at the screen edge, curved as
// if they were rings radiating FROM the source (centre of curvature sits off-screen toward it).
//   • curvature = DISTANCE — a near source curves tight (up to ~90° of arc); a far one flattens to
//     a near-straight streak (radius grows with distance).
//   • ring count = LOUDNESS — faint shows one thin arc, loud shows several concentric rings.
//   • colour = the enemy's in-game team colour. Arc length is capped so a flat far arc stays short.
// Returns true if it drew (source is off-screen / behind).
function drawSonarArcs(g, W, H, s) {
  _shv.set(s.pos.x, s.pos.y, s.pos.z).project(camera);
  let nx = _shv.x, ny = _shv.y;
  const behind = _shv.z > 1;
  if (behind) { nx = -nx; ny = -ny; }
  if (!behind && nx >= -0.96 && nx <= 0.96 && ny >= -0.96 && ny <= 0.96) return false;   // on-screen → you can see it
  let dx = nx, dy = -ny;                                   // NDC → screen space (y down); points OUTWARD toward the source
  const len = Math.hypot(dx, dy) || 1; dx /= len; dy /= len;
  const cx = W / 2, cy = H / 2, pad = SONAR.pad;
  const sc = Math.min(dx !== 0 ? (W / 2 - pad) / Math.abs(dx) : Infinity,
                      dy !== 0 ? (H / 2 - pad) / Math.abs(dy) : Infinity);
  const ex = cx + dx * sc, ey = cy + dy * sc;             // where the source direction meets the screen edge
  const loud = Math.max(0, Math.min(1.2, s.loud));
  // CENTRE OF CURVATURE = the source's ACTUAL projected screen position (off-screen), so the arc is a
  // true slice of a ring centred on the enemy — as it moves, the arc curves around where it really is.
  // The radius is just how far off-screen it projects (clamped so a very distant/behind source stays a
  // sensible gentle curve rather than an infinite straight line). When in range, the centre IS the
  // source exactly; when clamped, it stays on the true edge→source line.
  const sx = cx + nx * (W / 2), sy = cy - ny * (H / 2);       // source's projected screen position (raw NDC → px)
  let vX = sx - ex, vY = sy - ey; const vlen = Math.hypot(vX, vY) || 1; vX /= vlen; vY /= vlen;   // edge→source dir
  // HALF the edge→source distance: the centre of curvature sits at the MIDPOINT of the
  // edge→source line instead of on the source itself — same bearing (the arc still points
  // straight at the noise), but twice the curvature, so the glyph reads as a tight
  // signal-strength icon rather than a long sweeping ring.
  const R = Math.min(SONAR.Rmax, Math.max(SONAR.Rmin, vlen * 0.5));
  const theta = Math.min(SONAR.maxArcLen / R, Math.PI / 2);   // arc angular extent: capped length AND ≤ 90°
  const Cx = ex + vX * R, Cy = ey + vY * R;                   // = the source itself when its off-screen dist is in range
  const base = Math.atan2(ey - Cy, ex - Cx);                  // centre→edge angle (arc centred here, curving around source)
  const nRings = 1 + Math.min(SONAR.maxRings - 1, Math.floor(loud * SONAR.ringSpan));
  const baseAlpha = Math.max(0.16, Math.min(0.92, 0.22 + loud * 0.72));
  g.save();
  g.lineCap = 'round';
  g.shadowColor = `rgba(${s.color},${(baseAlpha * 0.5).toFixed(3)})`;
  g.shadowBlur = 7;
  for (let i = 0; i < nRings; i++) {
    const r = R + i * SONAR.ringGap;                          // successive rings march inward from the edge
    const a = baseAlpha * (1 - i / (nRings + 1));
    g.beginPath();
    g.arc(Cx, Cy, r, base - theta / 2, base + theta / 2);
    g.strokeStyle = `rgba(${s.color},${a.toFixed(3)})`;
    g.lineWidth = Math.max(1.4, 3 - i * 0.45);
    g.stroke();
  }
  g.restore();
  return true;
}
function updateSoundHud(dt) {
  decaySoundPings(dt);       // gun-report fade (also ticked in stepField for headless faithfulness)
  if (_sonarDebug) return;   // a debug frame is up (RR.drawSonar) — don't hide or clear it
  const listener = soundListener();
  if (!listener) { if (soundHudCanvas) soundHudCanvas.style.display = 'none'; return; }
  ensureSoundHud();
  soundHudCanvas.style.display = '';
  const W = window.innerWidth, H = window.innerHeight;
  if (soundHudCanvas.width !== W) soundHudCanvas.width = W;
  if (soundHudCanvas.height !== H) soundHudCanvas.height = H;
  const g = soundHudCtx; g.clearRect(0, 0, W, H);
  // DE-CLUTTER: sources within ~18° of the same screen bearing draw on the same edge spot
  // and used to stack into an unreadable pile — keep only the LOUDEST of each cluster
  // (loudest-first pass; quieter arrivals inside an occupied bearing window are skipped).
  const srcs = soundSources(listener).sort((a, b) => b.loud - a.loud);
  const taken = [];
  for (const s of srcs) {
    _shv.set(s.pos.x, s.pos.y, s.pos.z).project(camera);
    let bx = _shv.x, by = -_shv.y; if (_shv.z > 1) { bx = -bx; by = -by; }
    const bear = Math.atan2(by, bx);
    if (taken.some(t => Math.abs(Math.atan2(Math.sin(bear - t), Math.cos(bear - t))) < 0.32)) continue;
    if (drawSonarArcs(g, W, H, s)) taken.push(bear);
  }
  drawSensorContacts(g, W, H);
}

function roundRect(g, x, y, w, h, r) {
  if (g.roundRect) { g.beginPath(); g.roundRect(x, y, w, h, r); return; }
  g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}
const _scv = new THREE.Vector3();
// SENSOR POD contacts: any enemy within range of the player team's pods shows as a chip on
// the screen edge — vehicle TYPE + distance, in the enemy's colour, a chevron pointing its way.
function drawSensorContacts(g, W, H) {
  if (!onField || TEAM_CTRL[PLAYER_TEAM] !== 'human' || !sensorNet) return;
  const cons = sensorNet.contacts(PLAYER_TEAM, combatants).sort((a, b) => a.dist - b.dist);
  if (!cons.length) return;
  const cx = W / 2, cy = H / 2, pad = 56, taken = [];
  for (const c of cons) {
    _scv.set(c.pos.x, c.pos.y, c.pos.z).project(camera);
    let nx = _scv.x, ny = _scv.y; if (_scv.z > 1) { nx = -nx; ny = -ny; }
    let dx = nx, dy = -ny; const len = Math.hypot(dx, dy) || 1; dx /= len; dy /= len;
    const bear = Math.atan2(dy, dx);
    if (taken.some(t => Math.abs(Math.atan2(Math.sin(bear - t), Math.cos(bear - t))) < 0.28)) continue;
    taken.push(bear);
    const sc = Math.min(dx !== 0 ? (W / 2 - pad) / Math.abs(dx) : Infinity,
                        dy !== 0 ? (H / 2 - pad) / Math.abs(dy) : Infinity);
    const ex = cx + dx * sc, ey = cy + dy * sc;
    const rgb = teamRGB(c.colorIndex);
    const label = c.type.toUpperCase() + '  ' + Math.round(c.dist);
    g.save();
    g.translate(ex, ey);
    g.font = 'bold 12px monospace';
    const bw = g.measureText(label).width + 24, bh = 20;
    g.fillStyle = 'rgba(10,16,22,0.82)'; g.strokeStyle = `rgba(${rgb},0.95)`; g.lineWidth = 1.5;
    roundRect(g, -bw / 2, -bh / 2, bw, bh, 6); g.fill(); g.stroke();
    g.fillStyle = `rgb(${rgb})`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(label, 0, 1);
    const px = dx * (bw / 2 + 7), py = dy * (bh / 2 + 7), perpx = -dy, perpy = dx;   // chevron outward
    g.beginPath(); g.moveTo(px, py);
    g.lineTo(px - dx * 9 + perpx * 5, py - dy * 9 + perpy * 5);
    g.lineTo(px - dx * 9 - perpx * 5, py - dy * 9 - perpy * 5);
    g.closePath(); g.fill();
    g.restore();
  }
}

// WORLD CLOCK SCALE. 1 in a normal game. The replay lab (lab/replay.html + js/replay.js) turns it
// down for slow motion and to 0 to freeze, then steps the sim itself. Everything downstream takes
// dt, so scaling here slows the whole world together — fire, water and treads, not just the hulls.
// This is the ONLY thing the replay lab needs from the game; all of its logic lives in its own files.
let timeScale = 1;
let _splashHidden = false;
function animate() {
  requestAnimationFrame(animate);
  // Physics dt is CLAMPED (a long stall must not tunnel vehicles through walls), but the FPS
  // readout must not inherit that clamp — reading 1/dt off it floors the display at 20fps and
  // over-reports exactly when the frame rate is worst. Keep the raw delta for the meter.
  const rawDt = clock.getDelta();
  const dt = Math.min(0.05, rawDt) * timeScale;   // timeScale is 1 unless the replay lab is driving
  updateAerialPan(dt);   // WASD pans the build/upgrade aerial across the map (fixed angle/height)
  const _pfStart = PERF ? performance.now() : 0;
  const fade = document.getElementById('deployfade');
  if (garage && !onField) {
    // FORT PLACEMENT (Scrap Shop): swap to the locked aerial over the player's base and
    // show the hologram instead of the hangar. The field sim stays frozen, same as the
    // garage always is — placing is calm; the construction run after deploy is the risk.
    if (fortPlace || towerPick) {
      waterT += dt; map.tickWater(waterT); setWindTime(waterT);   // keep the water + grass alive so the aerial doesn't read as a freeze-frame
      renderer.render(scene, camera);
      return;   // rAF is already queued at the top of animate()
    }
    garage.update(dt);
    // Elevator servo whir the moment the deploy lift starts climbing inside the garage,
    // stopped once it reaches the top (phase leaves 'rising'). Non-spatial (garage scene).
    if (sound) {
      if (garage.phase === 'rising') { if (!_garageElevSnd) _garageElevSnd = sound.elevatorUI(); }
      else if (_garageElevSnd) { _garageElevSnd.stop(); _garageElevSnd = null; }
    }
    if (fade) {
      if (garageFadeT != null) {           // returned to base → fade the garage in from black
        garageFadeT += dt;
        const o = Math.max(0, 1 - garageFadeT / 1.0);
        fade.style.opacity = o;
        if (o <= 0) garageFadeT = null;
      } else {
        fade.style.opacity = garage.riseProgress;   // deploy rise → fade out to black
      }
    }
    renderer.render(garage.scene, garage.camera);
    // Rise finished + screen fully black → build the island and switch to it.
    if (garage.phase === 'done') enterField();
  } else {
    if (!paused) {                         // full-screen log freezes the whole sim
      updateTouchAim();                      // aim stick → _aimPoint/fireHeld (before drive reads them)
      if (!driveUpdate(dt)) spectateUpdate(dt) || panUpdate(dt);   // player, else follow the action / free cam
      trackVelocities(dt);                 // per-vehicle velocity for AI aim-leading
      _pfT('ai', () => { if (!matchOver) updateCommanders(dt); });  // AI teams (fog-of-war) + A* nav + flag carry
      _pfT('structs', () => { for (const c of camps) c.update(dt); for (const w of placedWalls) w.update(dt); for (const e of elevators) { e.update(dt); updateElevatorSound(e); } for (const v of vehicles) v.idle(dt); updateSubmarines(dt); });
      _pfT('shadows', () => updateShadows());  // ground-projected vehicle silhouette shadows
      _pfT('projectiles', () => { projectiles.update(dt); updateProjectileHits(); });
      if (foliage) foliage.update(dt);       // tree topple animations
      waterT += dt; map.tickWater(waterT); setWindTime(waterT);   // animate the water ripples + grass sway
      _pfT('destruct', () => destructibles.update(dt));
      updateFx(dt);
      updateHealthBars();
      updateLock(dt);                        // Valkyrie target box: track + colour the lock
      updateAimReticle();                    // cursor crosshair (other vehicles) + aim point
      _pfT('sound', () => { updateSoundHud(dt); updateEngineSounds(); });  // sound HUD + spatial engine noise
      if (touchUsed) orientAimArc();         // keep the touch aim wedge pointing the way the vehicle faces (screen-relative)
      updateResupplies(dt);                  // fuel/ammo/shield POIs + base resupply + shield FX
      updateScrap(dt);                       // salvage piles: bob + proximity pickup → team scrap
      updateGibs(dt);                        // fly the debris from just-destroyed vehicles until it settles
      if (soldiers) soldiers.update(dt, combatants);   // base infantry: patrol march, wreck scatter, tread squish
      updateGadgets(dt);                     // mines (proximity detonate) + sensor pods (blink)
      updateRepairs(dt, camera);             // tower repair crews: jeep drives out, crew builds, tower heals
      updateRepairIcons();                   // player: clickable 🔧 over each damaged friendly tower
      updatePadLights();                     // hold point-light count constant (shader-compile stutter fix)
      _pfT('turrets', () => updateWallTurrets(dt));  // base corner turrets fire on intruders in range
      updateTowerUpgrades();                         // treasure-box drop + partial rebuild on tower death/revive
      updateCrushables();                            // flatten a tent + blood mark when a tread rolls over it
      tickFire(dt);                                  // burn down (the other half runs in stepField)
      updateGates(dt);                       // raise/lower base gates for friendly units in range
      updatePlayerHud();                     // live HUD: fuel drains every frame, not just on events
    }
    updateAiLog();                         // AI decision overlay (renders even while paused)
    updateNavOverlay();                    // ?nav: A* route (grounders) + goal-line (flyers), also while paused
    // Slice the fire volumes against the camera. Only here: this is the part that costs, and a
    // headless step has no camera worth slicing against and nothing to show for it.
    _pfT('fire', () => drawFire(clock.elapsedTime));
    _pfT('render', () => renderer.render(scene, camera));
    if (fade) {
      if (returning && victoryReturn) {
        // Victory: stay clear so the confetti + descending Firebrat are visible,
        // hold a beat at the bottom on the celebration, then fade to the garage.
        if (playerElev && playerElev.phase === 'down') {
          victoryHoldT += dt;
          fade.style.opacity = Math.max(0, (victoryHoldT - VICT_HOLD) / 0.6);
          if (victoryHoldT > VICT_HOLD + 0.6) { victoryReturn = false; returnToGarage(); }
        } else {
          fade.style.opacity = 0;
        }
      } else if (returning) {
        // Fade to black as the lift nears the bottom; hand back to the garage at the floor.
        const k = playerElev ? (playerElev.lift.position.y - playerElev.bottomY) / playerElev.depth : 0;
        fade.style.opacity = Math.max(0, Math.min(1, 1 - k * 2.5));   // black over the last ~40%
        if (playerElev && playerElev.phase === 'down') returnToGarage();
      } else if (onField) {
        // After the deploy handoff, fade the black overlay back out as the lift rises.
        fieldFadeT += dt;
        fade.style.opacity = Math.max(0, 1 - fieldFadeT / 1.3);
      }
    }
  }

  if (!_splashHidden) {                    // first frame rendered → drop the loading splash
    _splashHidden = true;
    if (window.__rmrfHideSplash) window.__rmrfHideSplash();
  }

  if (PERF) {
    // _pfStart is 0 on a frame that began with collection off (the [+] can switch it on between
    // frames) — measuring from 0 would bank the whole page uptime as one colossal fake hitch.
    const _fms = _pfStart ? performance.now() - _pfStart : 0;
    _pfWork += _fms; _pfFrames++;
    if (_fms >= PF_HITCH_MS) _pfNoteHitch(_fms, clock.elapsedTime);
    for (const k in _pfFrameAcc) delete _pfFrameAcc[k];
    _planFrame = 0;
    _pfRender();
  }
  perfTick++;
  fpsEma += (1 / Math.max(rawDt, 0.0001) - fpsEma) * 0.08;   // RAW delta: the clamped dt floors this at 20
  if (perfEl && perfTick % 20 === 0) {
    perfBaseEl.innerHTML =
      `FPS: ${Math.round(fpsEma)}<br>` +
      `MS: ${(rawDt * 1000).toFixed(1)}<br>` +
      `DRAW: ${renderer.info.render.calls}<br>` +
      `TRIS: ${(renderer.info.render.triangles / 1000).toFixed(1)}K`;
  }
}
updateCamera();
ensureVolumeControl();
animate();

