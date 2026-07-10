// main.js — RMRF bootstrap (fresh build).
// Bright Return Fire look: light sky, warm sun, tone mapping. Procedural islands
// with a live controls panel. Garage + vehicles land in later milestones.

import * as THREE from 'three';
import { IslandMap, DEFAULTS } from './IslandMap.js?v=68';
import { Controls } from './Controls.js';
import { DestructibleManager, Destructible } from './Destructible.js?v=7';
import { applyStaging } from './AssetStaging.js?v=1';
import { BuildGrid } from './BuildGrid.js';
import { Camp, Wall } from './Walls.js?v=66';
import { SoldierCorps } from './Soldiers.js?v=4';
import { RepairJob, makeJeepMesh } from './RepairCrew.js?v=7';
import { Minefield, SensorNet, MINE, POD } from './Gadgets.js?v=4';
import { makeFlagHQ } from './Buildings.js?v=9';   // decoy HQ buildings on designed maps
import { recolorCamo } from './AssetBuilder.js?v=1';   // re-skin designed-map props' baked camo on the colour-lock
import { CAMPAIGN, isUnlocked, isCompleted, markCompleted } from './campaign.js?v=1';
import { RoadNetwork } from './Roads.js?v=85';
import { Foliage } from './Foliage.js?v=5';
import { makeVehicleShadow, vehicleSilhouette, makeBlobShadow } from './BlobShadow.js?v=1';
import { Vehicle, VEHICLE_TYPES } from './Vehicles.js?v=68';
import { Elevator } from './Elevator.js?v=3';
import { Sub } from './Submarine.js?v=5';
import { Garage, GARAGE_COUNTS } from './Garage.js?v=8';
import { TEAM_COLORS, updateCamo, camoParams } from './CamoTexture.js';
import { SoundManager } from './SoundManager.js?v=9';
import { Projectiles } from './Projectiles.js';
import { Brain, randomPersonality, recStart, recStop, recDump, setBrainConfig, getBrainConfig, FOF_DEFAULT } from './AI.js?v=109';

// Per-team fight-or-flight weight sets (Phase 2 auto-tuning / A/B self-play). Lazily cloned
// from FOF_DEFAULT; RR.setFof(team, {...}) overrides individual weights live, so red and blue
// can run DIFFERENT weights in the same match to see which set actually wins.
const teamFof = {};
function fofFor(team) { return teamFof[team] || (teamFof[team] = { ...FOF_DEFAULT }); }
import { makeDoctrine, pickArchetype, assignArchetypes, COUNTER, setRunnerMode, setRogueRearSiege, setHqFinisher, setRearSneakGate } from './AIStrategies.js?v=88';
import { ExploreMemory, setSweepMode } from './ExploreMemory.js?v=58';
import { astarGrid } from './astar.js?v=6';
import { AstarViz } from './AstarViz.js?v=4';
import { makeFuelTank, makeAmmoDepot, makeShieldGenerator, makeShieldBubble, RESUPPLY_TINT } from './Resupply.js';
import { makeShieldMaterial, pushShieldHit, stepShield } from './ShieldShader.js?v=4';
import { makePartsPallet, makeWreckage } from './Scrap.js?v=3';
import { SUPPLY_ASSETS, ASSETS_BY_ID } from './assets.manifest.js?v=8';

// --- Renderer ----------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true });
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
sun.position.set(0, 202, -25);   // bro's chosen specular angle (overridden per-map by scaleScene)
scene.add(sun);
const hemi = new THREE.HemisphereLight('#dff1ff', '#c2a86a', 0.95);
scene.add(hemi);

// --- Camera + minimal orbit control -----------------------------------
const BASE_FOV = 55;   // landscape vertical fov
// near=3 (not 0.5): the orbit cam never gets closer than ~8u to the action, so a tiny
// near plane just threw away depth-buffer precision (far/near went from 2500 to ~415),
// which is what made the terrain/waterline z-fight so badly when zoomed out.
const camera = new THREE.PerspectiveCamera(BASE_FOV, window.innerWidth / window.innerHeight, 3, 1200);

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
  window.addEventListener('mousemove', e => { move(e.clientX, e.clientY); _cursor = { x: e.clientX, y: e.clientY }; });
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
function updateSpectateTeamButtons() {
  if (!spectateTeamBtns.length) return;
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
if (QS.has('rngseed')) { const _seedRng = mulberry32((+QS.get('rngseed') >>> 0) || 1); Math.random = () => _seedRng(); }
const doctrineRng = QS.has('dseed') ? mulberry32((+QS.get('dseed') >>> 0) || 1) : Math.random;

// ?perf — on-device profiler: per-frame CPU time BROKEN DOWN by system, so a stutter's cause
// is visible without DevTools (esp. on the phone, where there's no console). Off unless ?perf.
const PERF = QS.has('perf');
const _pfAcc = {};                                     // section → ms accumulated over the window
let _pfFrames = 0, _pfWork = 0, _planCount = 0, _pfShownAt = 0;
function _pfT(k, fn) { if (!PERF) return fn(); const t = performance.now(); fn(); _pfAcc[k] = (_pfAcc[k] || 0) + (performance.now() - t); }
function _pfRender() {
  const now = performance.now(); const win = now - _pfShownAt;
  if (win < 300 || !_pfFrames) return;
  _pfShownAt = now;
  const fps = _pfFrames / (win / 1000), work = _pfWork / _pfFrames, rep = _planCount / (win / 1000);
  let el = document.getElementById('perfhud');
  if (!el) { el = document.createElement('div'); el.id = 'perfhud'; el.style.cssText = 'position:fixed;top:46px;right:8px;z-index:99;font:11px/1.35 monospace;color:#7fffb8;background:rgba(0,0,0,0.72);padding:6px 9px;border-radius:6px;white-space:pre;pointer-events:none'; document.body.appendChild(el); }
  const secs = Object.entries(_pfAcc).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k.padEnd(11)}${(v / _pfFrames).toFixed(1)}ms`);
  el.textContent = `fps ${fps.toFixed(0)}  work ${work.toFixed(1)}ms\nreplans/s ${rep.toFixed(0)}  units ${combatants.length}  fx ${fx.length}\nscene ${scene.children.length}\n` + secs.join('\n');
  for (const k in _pfAcc) _pfAcc[k] = 0;
  _pfFrames = 0; _pfWork = 0; _planCount = 0;
}
const SHOT_SIZE = parseInt(QS.get('size')) || 96;
const SHOT_FOL = QS.has('fol');
const SHOT_SEED = QS.has('seed') ? parseInt(QS.get('seed')) : null;
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
let aiPostKillMoveOn = true;   // on a kill, drop the killer's engage-afterglow ghost so it doesn't linger "searching" the corpse (A/B via RR.setPostKillMoveOn)
const SCRAP_DROP = { jotun: 3, valkyrie: 2, lurcher: 2, firebrat: 1 };   // scrap a destroyed vehicle's wreck is worth
const SCRAP_GRAB_RANGE = 45;   // max detour a mobile unit takes to grab a spotted pile on its way
const LOOT_RANGE = 28;         // after a KILL, how far the killer will swing over to grab the wreck it just made
const LOOT_MS = 6000;          // give up the loot order after this long (don't let it stall the advance)
let aiKillLoot = true;         // killers collect the wreck of what they just destroyed (A/B knob via RR.setKillLoot)
const GIB_GRAV = 42;           // gravity on flying debris pieces (world units/s^2)
const GIB_HOT_MS = 1500;       // debris is airborne/uncollectable this long after death
const MAX_WRECKS = 10;         // cap persistent wreck piles on the field; oldest fades when exceeded
const BUILD_COST = { jotun: 5, valkyrie: 5, lurcher: 3, firebrat: 2 };   // scrap to build one (garage, slice 2)
let onField = false;  // true while the island is on screen (false = hangar view)
let fieldBuilt = false; // the island is generated once, then reused across deploys
let matchOver = false;  // a flag was captured — freeze the action, show the result
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
  if (configBases) { buildConfigRoads(); return; }   // custom map → the painted roads, not A* auto-routing
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
  placeResupplies();   // neutral fuel/ammo/shield points of interest
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
  camps = []; elevators = []; placedWalls = []; placedProps = []; destructibles = new DestructibleManager();

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
    const dtm = a.team || 'neutral';
    const g = entry.make(grid.cell, new THREE.Color(accentForCode(dtm)));
    g.userData.team = gameTeamOf(dtm);   // so the colour-lock can recolour its accent/camo mats
    const s2 = siteOfCell(a.cx, a.cz);
    g.position.set(s2.x, map.heightAt(s2.x, s2.z), s2.z);
    g.rotation.y = (a.rot || 0) * Math.PI / 2;
    scene.add(g);
    applyStaging(g, a.id);
    destructibles.add(new Destructible(g, { type: entry.destructible ? entry.destructible.type : 'building',
      hp: entry.destructible ? entry.destructible.hp : 100, blocks: true, staged: true }));
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
  placeResupplies();
  scatterScrap();
  configureSubZone();
  resetRepairs();
}
// Use the designed bases when a map carries placed assets; else procedural placement.
function placeCampsAuto() {
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
  foliage.scatter(map, sites, { density: 1, avoid: onRoad });
  if (!foliage.group.parent) scene.add(foliage.group);
}

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
const INTERCEPT_SWAP_R = 60;   // flag stolen: only recall home for a Valkyrie if a ground unit is within this of our FOB — else chase with what we've got
let GAMBIT_AFTER = 240;   // seconds of a stalemate (base untouched) before a commander abandons the mid-field grind and sends a Valkyrie around the back to crack the HQ (RR.setGambitAfter)
let aiKeepBreach = true;     // flatten the HQ early + let the runner grab with back towers up (A/B via RR.setKeepBreach); off = old all-towers-first siege
let aiBreachCommit = true;   // siegers latch ONE wall + push in through the hole (A/B via RR.setBreachCommit); off = old orbit-and-spray standoff
// A/B gates for this session's nav changes — default to the new behavior; ?no… reverts one for isolation.
let aiFobRearm = !QS.has('nofobrearm');    // re-arm the deterministic gate-exit for a grounder tangled at its own FOB
let aiAntiGrind = !QS.has('noantigrind');  // cut a sinker's throttle when it'd grind deep water it can't cross
let aiMineAvoid = !QS.has('nomineavoid'); // soft-steer AI ground units around mines their team has spotted
let aiSoftFord = QS.has('softford');       // revert A* ford check to the old loose 4-dir/0.85 margin
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
  lurcher:  { cruise: 0,   ignoreWalls: false, water: 'sink',  tree: 'crush' },
  firebrat: { cruise: 2.4, ignoreWalls: false, water: 'cross', tree: 'bump'  },
  valkyrie: { cruise: 7.5, ignoreWalls: true,  water: 'cross', tree: 'fly'   },
  jotun:    { cruise: 0,   ignoreWalls: false, water: 'sink',  tree: 'crush' },
};
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
        v._shadow = makeVehicleShadow(vehicleSilhouette(renderer, v.type, v.model.group));
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
    s.position.set(x, gy + 0.2, z);   // lifted so the flat decal doesn't cut into sloped shore terrain
    s.rotation.y = v.holder.rotation.y;
    const scl = cfg && cfg.scale ? cfg.scale : 1;
    if (v._shadowR) { const d = v._shadowR * 2 * (0.7 + 0.3 * f) * scl; s.scale.set(d, 1, d); }
    else s.scale.setScalar((0.7 + 0.3 * f) * scl);
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
    desired = 0;   // no cursor (e.g. touch) → ease back to forward
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
function explodeAt(point, blast, dmg, team, shooter) {
  destructibles.damageAt(point, blast, dmg);
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
  if (cause === 'vehicle' && shooter && shooter !== veh && shooter.team !== veh.team) veh._hitByVehT = performance.now();
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
function turretFalloff(dist) {
  const { near, far, farMult } = TURRET_FALLOFF;
  if (dist <= near) return 1;
  if (dist >= far) return farMult;
  return 1 - (1 - farMult) * (dist - near) / (far - near);
}
// One corner turret's aim + fire. `team` = the owner (a base camp's team, or a placed
// piece's _team); a null team (neutral placed tower) has no friendlies, so it fires on all.
function tickWallTurret(w, team, dt) {
  const t = w.turret;
  if (!t || t.dead || t.falling) return;
  t._cd = (t._cd || 0) - dt;
  t.group.updateWorldMatrix(true, false);
  t.head.getWorldPosition(_tHead);
  // nearest enemy vehicle in range (turrets sit above the parapet → no wall-LOS check)
  let target = null, bestD = TURRET_RANGE * TURRET_RANGE;
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
    t._cd = TURRET_CD;
    // Damage the locked target directly (with range falloff) + a cosmetic tracer.
    // Direct, so the slug can't clip the turret's OWN walls on the way out.
    damageVehicle(target, TURRET_DMG * turretFalloff(Math.sqrt(bestD)), 'turret', null, _tHead);   // srcPos → hit-ring faces the turret
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

function creditKill(killer, victim) {
  if (!killer || killer.team == null || killer.team === victim.team) return;
  const cmd = commanders.find(c => c.team === killer.team);
  if (!cmd) { promoteUnit(killer); return; }   // player/no-commander team: stars still pin on
  cmd.kills = (cmd.kills || 0) + 1;
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
  creditKill(killer, veh);   // credit the firing unit's commander (drives Warrior/Hunter doctrine + kill feed)
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
// AI HEARING: how loud (same 0..1 audibility scale as the sound HUD) an unseen rival must
// be before a unit investigates the noise. A heard contact only steers navigation — it is
// NEVER a firing solution (enemy/seesEnemy stay line-of-sight). Gunfire easily clears this;
// a moving Jotun's drone clears it at range; an idling unit barely makes a whisper.
const AI_HEARD_MIN = 0.18;
const SHIELD_GRAB_RANGE = 130;  // max detour a Lurcher/Valkyrie will take to top up at a known shield generator
const SHIELD_COMMIT = 60;       // once this close to the wanted gen, COMMIT — grab the armour before fighting
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
function buildFlags() {
  for (const f of flags) scene.remove(f.group);
  flags.length = 0;
  for (const c of camps) {
    if (c.role !== 'main') continue;
    // Match the camp's live accent (team colour), so a player-chosen colour shows
    // on the flag too — not a hard-coded red/blue. Recoloured on team-colour lock.
    const hex = '#' + c.accent.getHexString();
    const g = new THREE.Group();
    const H = 8;
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, H, 6),
      new THREE.MeshStandardMaterial({ color: 0x9a9a9a, metalness: 0.6, roughness: 0.4 }));
    pole.position.y = H / 2; g.add(pole);
    const cloth = new THREE.Mesh(new THREE.PlaneGeometry(2.8, 1.6),
      new THREE.MeshStandardMaterial({ color: hex, emissive: hex, emissiveIntensity: 0.3, side: THREE.DoubleSide }));
    cloth.position.set(1.4, H - 1.1, 0); g.add(cloth);
    const gx = c.center.x, gz = c.center.z, gy = map.heightAt(gx, gz);
    g.position.set(gx, gy, gz);
    // The HQ wears the flag on its roof; this capturable pole stays HIDDEN inside
    // until the building is levelled — then it's revealed in the rubble and drops
    // to the ground (see updateFlags) for a Firebrat to grab.
    g.visible = false;
    scene.add(g);
    flags.push({ team: c.team, group: g, cloth, hqBody: c.flagHQ || null, revealed: false, dropT: 0,
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
  for (const w of placedWalls) if (w._team === team && w.group) recolorGroup(w.group, hex, accent);
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
    if (f.dropT > 0 && !f.carried) {          // gravity-ish drop into the rubble
      f.dropT = Math.max(0, f.dropT - dt);
      const e = 1 - f.dropT / DROP_DUR;       // 0 (top) -> 1 (ground)
      f.group.position.y = f.home.y + DROP_FROM * (1 - e * e);
    }
    if (f.carried && f.carrier) {
      if (f.carrier.dead) {
        // Carrier killed (anywhere — including on the lift) → the flag drops where
        // it fell and STAYS there until a Firebrat re-grabs it (no auto-return).
        const c = f.carrier.holder.position;
        f.group.position.set(c.x, map.heightAt(c.x, c.z) + 0.2, c.z);
        f.carried = false; f.carrier = null;
      } else {
        const c = f.carrier.holder.position;
        f.group.position.set(c.x, c.y + 4.5, c.z);
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
    if (!f.carried) {                                  // a dropped/displaced flag — only a FIREBRAT can lift it
      const fx = f.group.position.x, fz = f.group.position.z;
      const displaced = Math.hypot(fx - f.home.x, fz - f.home.z) > GRAB;
      for (const v of combatants) {
        if (v.dead || v.type !== 'firebrat') continue;
        if (Math.hypot(v.holder.position.x - fx, v.holder.position.z - fz) >= GRAB) continue;
        if (v.team === f.team) {
          // Own team reaching its DISPLACED flag recovers it — snaps straight home
          // (you can't carry your own flag; this denies the thief a re-grab).
          if (displaced) { f.group.position.set(f.home.x, f.home.y, f.home.z); showBanner(`${flagColorName(f)} FLAG RECOVERED`, { color: '#9bd6ff' }); }
        } else {
          f.carried = true; f.carrier = v; showBanner(`${flagColorName(f)} FLAG TAKEN`, { color: '#' + f.cloth.material.color.getHexString() });
        }
        break;
      }
    }
  }
}
// Carrying a rival flag home to your main base WINS the match.
function onCapture(team, f) {
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
function neutralSite(targetR) {
  for (let t = 0; t < 240; t++) {
    const ang = Math.random() * Math.PI * 2;
    const r = targetR * (0.78 + Math.random() * 0.44);
    const x = Math.cos(ang) * r, z = Math.sin(ang) * r;
    if (!map.isLand(x, z) || blockedAt(x, z)) continue;
    const ci = Math.round(x / grid.cell), cj = Math.round(z / grid.cell);   // don't drop a supply on a road/bridge
    if (roadNet.cells && roadNet.cells.has(ci + ',' + cj)) continue;
    let ok = true;
    for (const c of camps) if (Math.hypot(x - c.center.x, z - c.center.z) < 28) { ok = false; break; }
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
    const ci = Math.round(x / grid.cell), cj = Math.round(z / grid.cell);   // don't drop a supply on a road/bridge
    if (roadNet.cells && roadNet.cells.has(ci + ',' + cj)) continue;
    let ok = true;
    for (const c of camps) if (Math.hypot(x - c.center.x, z - c.center.z) < 28) { ok = false; break; }
    if (ok) for (const rp of resupplies) if (Math.hypot(x - rp.pos.x, z - rp.pos.z) < 24) { ok = false; break; }
    if (ok) return { x, z };
  }
  return neutralSite(reach);
}

const RESUPPLY_MAKE = { fuel: makeFuelTank, ammo: makeAmmoDepot, shield: makeShieldGenerator };
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
    onDestroyed: () => { rp.dead = true; } }));
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
      onDestroyed: () => { rp.dead = true; } }));
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
// One pile = 1 scrap. Piles drop where vehicles die and are scattered in remote
// corners at map build; a vehicle driving over one collects it for its team. Spend
// scrap in the garage to build more vehicles (BUILD_COST). Neutral: either team grabs.
const SCRAP_PICKUP_R = 8;   // how close a vehicle must get to snag a pile (a little margin so a unit halting at the kill site still collects)

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
  while (placed < 8 && tries++ < 400) {
    const ang = Math.random() * Math.PI * 2, r = span * (0.6 + Math.random() * 0.34);   // out toward the rim
    const x = Math.cos(ang) * r, z = Math.sin(ang) * r;
    if (!map.isLand(x, z) || blockedAt(x, z)) continue;
    let ok = true;
    for (const c of camps) if (Math.hypot(x - c.center.x, z - c.center.z) < 26) { ok = false; break; }
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
// scattering out of every building that collapses. One InstancedMesh, no gameplay stats.
let soldiers = null;
// Firebrat deployables (mines + sensor pods). Bound to the live scene/map; reset per match.
let minefield = new Minefield(scene, map);
let sensorNet = new SensorNet(scene, map);
// Per-match gadget telemetry (headless analysis / devblog): does the minefield earn its keep?
let gadgetStats = { minesLaid: 0, podsLaid: 0, detonations: 0, kills: 0, enemyKills: 0, friendlyKills: 0, damage: 0 };
function resetGadgetStats() { gadgetStats = { minesLaid: 0, podsLaid: 0, detonations: 0, kills: 0, enemyKills: 0, friendlyKills: 0, damage: 0 }; }
function wireSoldiers() {
  if (!soldiers) { soldiers = new SoldierCorps(scene, map); soldiers.onSquish = (x, y, z) => { if (sound) sound.squishAt(x, y, z); }; }
  for (const c of camps) {
    if (c._soldiersWired) continue;
    c._soldiersWired = true;
    c.onBuildingDown = (obj) => soldiers.scatterFrom(obj.position.x, obj.position.z, c.team, c.accent, 3 + (Math.random() * 3 | 0));
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
        if (Math.random() < chance) m.spottedBy.add(v.team);
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

// Park MOTOR_JEEPS jeeps in a row toward the BACK of each main base (away from the gate) — a
// visible, raidable motor pool the repair crews draw from.
function buildMotorPool() {
  clearMotorPool();
  for (const c of camps) {
    if (c.role !== 'main') continue;
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

// Road-aware ground height for the jeeps — the SAME rule the driven vehicles use (drape on the
// road slab's top where there is one, else the terrain), so a jeep rides ON a road, not in it.
const jeepGroundY = (x, z) => { const r = roadDeckY(x, z); return r != null ? r : map.heightAt(x, z); };

// An enemy repair jeep in THIS unit's gun reach — a target of OPPORTUNITY only (Jacob's rule:
// no hunting mission, no chasing — a unit that happens to have a jeep in range, in its firing
// arc, with a clear line, kills it in passing; commanders never get distracted from the win).
// Covers both a crew's jeep out on a job and the jeeps parked in the enemy motor pool.
// Flyers are skipped: a homing missile on a 40hp truck is a waste of the Valkyrie's magazine.
function jeepShotTarget(v) {
  if (!repairsOn || isFlyer(v)) return null;
  const range = ENGAGE_RANGE[v.type] || 36, arc = SHOT_ARC[v.type] ?? Math.PI / 5;
  const px = v.holder.position.x, pz = v.holder.position.z;
  let best = null, bestD = range * range;
  const consider = (x, y, z) => {
    const d = (x - px) ** 2 + (z - pz) ** 2;
    if (d >= bestD) return;
    if (Math.abs(wrapPi(Math.atan2(-(x - px), -(z - pz)) - v.heading)) > arc + 0.02) return;   // outside the gun's swing
    if (!hasLOS(px, pz, x, z)) return;                    // a wall would just soak the shell
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
      return planPath(stub, { x: tx, z: tz });
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

function enterFortPlace(kind) {
  const camp = fortHomeCamp();
  if (!camp) return false;
  const ghost = makeFortGhost(kind);
  // validity ring under the hologram: green = buildable, red = not here
  const ring = new THREE.Mesh(new THREE.RingGeometry(grid.cell * 0.55, grid.cell * 0.75, 28),
    new THREE.MeshBasicMaterial({ color: '#58d17a', transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false }));
  ring.rotation.x = -Math.PI / 2;
  scene.add(ghost); scene.add(ring);
  fortPlace = { kind, rot: 0, cx: Math.round(camp.center.x / grid.cell) + 3, cz: Math.round(camp.center.z / grid.cell), ghost, ring, ok: false, why: '', hidden: [] };
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
  if (!fortPlace) return;
  scene.remove(fortPlace.ghost); scene.remove(fortPlace.ring);
  for (const [obj, vis] of fortPlace.hidden) obj.visible = vis;   // reveal the enemy again, exactly as they were
  fortPlace = null;
  const ui = document.getElementById('fortplace-ui');
  if (ui) ui.style.display = 'none';
  setGarageOverlays(true);   // also refreshes the shop panel (scrap changed)
}

// Recompute ghost pose + validity (and the UI hint) for the current cell.
function refreshFortPlace() {
  const fp = fortPlace; if (!fp) return;
  const camp = fortHomeCamp();
  const x = fp.cx * grid.cell, z = fp.cz * grid.cell;
  const inRange = camp && Math.hypot(x - camp.center.x, z - camp.center.z) <= FORT_BUILD_RADIUS;
  const site = inRange ? fortSiteOk(fp.cx, fp.cz) : { ok: false, why: 'too far from base' };
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
    <div id="fp-title">PLACE FORTIFICATION — drag / tap the ground &nbsp;·&nbsp; PAUSED</div>
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
  renderer.domElement.addEventListener('pointermove', e => { if (fortPlace) fortPlacePointer(e); });
  renderer.domElement.addEventListener('pointerdown', e => { if (fortPlace && e.button === 0) fortPlacePointer(e); });
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
      if (st === 'done') ts.done++; else { ts.cancelled++; ts.jeepsLostField++; }
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
        if (s.team === b.mine.team) gadgetStats.friendlyKills++; else gadgetStats.enemyKills++;
      }
    }
  }
}
function updateScrap(dt) {
  const now = performance.now();
  for (let i = scrapPiles.length - 1; i >= 0; i--) {
    const p = scrapPiles[i];
    // Debris that landed over water sinks below the surface and despawns instead of floating —
    // it's unreachable for ground units anyway. Wait out the hot (airborne) window first so a
    // mid-air wreck finishes its arc, then slide it under and remove it.
    if (p.overWater && (!p.hotUntil || now >= p.hotUntil)) {
      p.sink = (p.sink || 0) + dt;
      p.group.position.y = p.pos.y + 0.04 - p.sink * 3;   // ~3 u/s under
      if (p.sink > 1.6) { scene.remove(p.group); p._gone = true; scrapPiles.splice(i, 1); }
      continue;   // not collectable while sinking
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
function cellBlocked(v, i, j) {
  const c = grid.cell, x = i * c, z = j * c;
  const halfW = map.worldW / 2 + 24, halfH = map.worldH / 2 + 24;
  if (x < -halfW || x > halfW || z < -halfH || z > halfH) return true;
  if (islandBound && x * x + z * z > islandBound * islandBound) return true;
  const gw = gateCells.get(i + ',' + j);
  if (gw) return v._move.ignoreWalls ? false : gateBlocks(gw, v.team);   // shut enemy gate blocks; ally/open/breached/flyer → passable
  if (roadNet.cells && roadNet.cells.has(i + ',' + j)) return false;
  if (elevatorPadAt(x, z)) return false;
  if (gateSideCells.has(i + ',' + j)) return true;   // a gate flank — force the centre throat
  if (navAvoid.size) {                               // temporary no-go (a spot a unit kept grinding) — NEVER over a gate/road/pad (handled above) so it can't strand
    const e = navAvoid.get(i + ',' + j);
    if (e !== undefined) { if (e > performance.now()) return true; navAvoid.delete(i + ',' + j); }
  }
  const m = v._move;
  if (m.water === 'sink' && !map.isLand(x, z)) {
    // A sinker fords only SHALLOW water, and only where the whole HULL clears deep water. A*
    // plans on cell centres but the hull has radius VEH_R and can move DIAGONALLY, so check the
    // full footprint (8 neighbours at full radius, matching the collision layer) — otherwise A*
    // threads a sliver of shallows the hull can't actually follow: the collision stops it at the
    // first deep lip and it grinds the shoreline, following a nav line out over water it can't
    // cross ("dancing on the shore"). Tighter here = A* prefers a real land/bridge route.
    if (map.isDeepWater(x, z)) return true;
    const r = aiSoftFord ? VEH_R * 0.85 : VEH_R;
    if (map.isDeepWater(x + r, z) || map.isDeepWater(x - r, z) || map.isDeepWater(x, z + r) || map.isDeepWater(x, z - r)) return true;
    if (!aiSoftFord && (map.isDeepWater(x + r, z + r) || map.isDeepWater(x + r, z - r) || map.isDeepWater(x - r, z + r) || map.isDeepWater(x - r, z - r))) return true;
  }
  if (!m.ignoreWalls) {
    const margin = VEH_R * 0.9;   // ≈ collision's full VEH_R, so A* won't route into a corner the hull can't enter
    for (const o of obstacles) {
      if (o.body && o.body.dead) continue;           // destroyed wall/tower → A* may route through the gap
      const dx = x - o.x, dz = z - o.z, rr = o.r + margin;
      if (dx * dx + dz * dz < rr * rr) return true;
    }
  }
  // NOTE: trees do NOT hard-block here even for tree:'bump' vehicles — the Firebrat can shoot a
  // tree clear, so a treed cell is merely EXPENSIVE (see vehCellCost). Hard-blocking meant that in
  // dense woods every neighbouring cell was blocked, A* died instantly, and the unit fell back to
  // a DIRECT beeline ("no A* route" while the forest was plainly routable-by-fire).
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
let forestCells = null;
function forestHas(k) {
  if (forestCells === null) {
    if (!foliage || !foliage.trees) return false;
    forestCells = new Set();
    const fc = grid.cell;
    for (const t of foliage.trees) forestCells.add(Math.round(t.x / fc) + ',' + Math.round(t.z / fc));
  }
  return forestCells.has(k);
}
// Per-vehicle A* cell cost. Infinity = impassable (blocked). SHARED by the live navigator
// (planPath) AND the A* visualizer (buildAstarGrid) so the picture you inspect is EXACTLY the
// cost the unit navigates on — the viz used to fall back to a generic representative unit, so a
// Firebrat's tree-avoidance / a sinker's water penalty were invisible and the viz showed a route
// the real unit's cost couldn't take ("no A* route" while the path tool looked fine).
function vehCellCost(v, i, j) {
  if (cellBlocked(v, i, j)) return Infinity;
  const c = grid.cell, roads = roadNet.cells;
  const onRoad = roads && (roads.has(i + ',' + j) || gateCells.has(i + ',' + j));
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
    const treeNear = forestHas((i + 1) + ',' + j) || forestHas((i - 1) + ',' + j) || forestHas(i + ',' + (j + 1)) || forestHas(i + ',' + (j - 1));
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
  if (arch === 'hunter') return forestHas(i + ',' + j) ? 0.45 : (onRoad ? 0.8 : 1);
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
function planPath(v, dest) {
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
  const maxNodes = Math.min(16000, Math.max(9000, Math.round(gridArea * 0.4)));
  const path = astarGrid({ start, goal, cost, inBounds, turnPenalty: 3, allowDiagonal: true, maxNodes, partial: true });
  if (!path || path.length < 2) {
    // BOXED-IN START: parked hard against a wall/shoreline, every neighbouring cell can be
    // blocked, so the search dies on the spot and the unit used to drop to a DIRECT beeline
    // (sometimes straight at open water). Restart from the nearest open cell — the unit makes
    // one short direct hop to that first waypoint, then follows a real A* route.
    const s2 = nearestOpenCell(v, start.i, start.j, 4, 1);
    if (s2) {
      const p2 = astarGrid({ start: s2, goal, cost, inBounds, turnPenalty: 3, allowDiagonal: true, maxNodes, partial: true });
      if (p2 && p2.length >= 1) return detourMines(v, p2.map(n => ({ x: n.i * c, z: n.j * c })));
    }
    return null;
  }
  return detourMines(v, path.map(n => ({ x: n.i * c, z: n.j * c })));
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
function navWaypoint(nav, v, dest, dt) {
  nav.t -= dt;
  if (nav.failT > 0) nav.failT -= dt;
  const moved2 = nav.dx == null ? Infinity : (dest.x - nav.dx) ** 2 + (dest.z - nav.dz) ** 2;
  const c = grid.cell;
  // A FAILED plan (no route — unreachable/blocked goal) used to leave nav.path null, so the
  // trigger below re-ran a full-grid A* search EVERY FRAME while a unit was stuck — ~80% of
  // CPU in cellBlocked (the perf sawtooth). failT gates retries after a failure so we search
  // at most a few times a second instead of 60×; a valid path (or a forced null) replans as before.
  if ((!nav.path || nav.idx >= nav.path.length || nav.t <= 0 || moved2 > (c * 2) ** 2) && !(nav.failT > 0)) {
    nav.path = planPath(v, dest); nav.idx = 0; nav.t = 1.1; nav.dx = dest.x; nav.dz = dest.z;
    nav.failT = nav.path ? 0 : 0.6;   // no route → don't re-run the search for 0.6s
    if (!nav.path) return null;
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
  return nav.path[nav.idx];
}
// Steer a vehicle toward a world point. SQUARE UP before committing forward: pivot in
// place when badly mis-aimed, ease in at part-throttle while lining up, and only run at
// full speed once roughly on heading. The old 69° gate let a slow tank charge forward
// at up to 69° off and arc straight into a gate jamb / wall corner instead of turning to
// face the gap first. drive() still slides on the fine bit.
function steerToward(v, wx, wz) {
  const dx = wx - v.holder.position.x, dz = wz - v.holder.position.z;
  const err = wrapPi(Math.atan2(-dx, -dz) - v.heading);
  const a = Math.abs(err);
  const fwd = a > 0.6 ? 0 : a > 0.25 ? 0.45 : 1;   // >34° pivot in place; 14–34° crawl + turn; <14° full
  // Small deadzone near zero so a unit that's basically on-heading drives STRAIGHT
  // instead of micro-correcting left/right every frame (the "shaking its head" wobble).
  const turn = a < 0.06 ? 0 : Math.max(-1, Math.min(1, err * 2.2));
  return { fwd, turn };
}

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
function freshSlot() {
  return {
    unit: null, respawnT: 0,
    strategy: null,                                    // this slot's OWN doctrine card (set at slot creation)
    _failStep: null, _failN: 0, _failT: 0, _failSnap: null,   // per-mission total-failure bans (per slot — each card banks its own lessons)
    _rising: false, _elev: null,                       // FOB-lift deploy state
    _exit: null, _exitT: 0, _exitCoolT: 0,             // post-deploy gate-exit waypoint
    _nav: { path: null, idx: 0, t: 0, dx: null, dz: null },   // A* path cache
    _supply: null, _supplyHeals: false, _home: null,   // resolved resupply/heal points (set per tick in _view)
    _stepAtDeploy: null,                               // strategy step when this unit deployed
    _recalling: false, _recallForce: false, _recallBestD: Infinity, _recallStallT: 0,
    _mrec: null,                                       // mission report card for the unit in the field
    _flankPt: null, _flankDone: false, _flanking: false,   // runner "sneak round the side" approach
    _intercepting: false, _shielding: false, _shieldRun: false, _shieldGen: null, _shieldRunOn: false,
    _scrapDetour: false, _scrapDetourOn: false, _scrapTargetPile: null,
    _lootPile: null, _lootUntil: 0,                    // fresh-kill wreck grab
    _exploreWp: null,                                  // current recon waypoint (per unit → scouts spread out)
    _dbg: null, _lpx: null, _lpz: null, _stuckT: 0,    // log snapshot + movement-health tracking
    _netT: 0, _netX: null, _netZ: null, _netStuck: false, _wantT: 0,   // net-progress wedge watchdog
    _joltT: 0, _joltSide: 1, _joltN: 0,                // reverse-pivot unwedge
    _lastFlip: null,                                   // log anti-bounce
    _patrolI: 0,                                       // position on the (shared) patrol route
  };
}
const SLOT_FIELDS = Object.keys(freshSlot());
let aiUnitCap = null;   // debug override (RR.setUnitCap): force the per-team unit cap regardless of elevators

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
    this.strategy = makeDoctrine(this.archetype, this.personality, Math.random, null, m => aiLog(this.team, `${this.cname}: ${m}`));   // the archetype's mission doctrine
    this.fortHp0 = null;                              // enemy fort HP when this card started
    this.seenTypes = {};                              // rival vehicle types this team has spotted
    this.knownSupplies = new Set();                   // fog-of-war: resupply POIs this team has SCOUTED
    this.knownScrap = new Set();                       // fog-of-war: salvage piles this team has SPOTTED
    this._scrapNoReach = new Map();                     // pile → expiry(ms): salvage A* couldn't route to (walled-off spit) — don't re-commit
    this._scrapTargetPile = null;                       // the pile the current salvage detour is committed to (for the unreachable-bail check)
    this.knownElev = false;                           // scouted the enemy FOB/elevator yet?
    this.knownFlag = false;                           // scouted the enemy flag HQ yet?
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
    Object.assign(this, this._slots[0]);
    this._slotI = 0; this._lead = true;
  }

  // The doctrine a given slot fields: slot 0 = the archetype itself, extras from its
  // ROLE_DECK (see above). Legacy no-archetype commanders draw random cards as ever.
  _slotDoctrine(i) {
    const deck = ROLE_DECK[this.archetype] || [];
    const role = i === 0 || !deck.length ? this.archetype : deck[(i - 1) % deck.length];
    return makeDoctrine(role, this.personality, Math.random, null, m => aiLog(this.team, `${this.cname}: ${m}`));
  }

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
  // The enemy's last-known position, if seen recently (else null → fall back to the
  // elevator). Lets the Attack mission "recall the last known location" (ai_behavior).
  lastEnemyPos() {
    const s = this._lastEnemyPos;
    return s && (performance.now() - s.t) < 12000 ? { x: s.x, z: s.z } : null;
  }
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
  losingBadly() {
    const ec = commanders.find(c => c.team === this.targetTeam());
    if (!ec) return false;
    const mine = this.fleetLeft(), theirs = ec.fleetLeft();
    return mine <= 5 && mine <= theirs - 3;
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
    const px = -dz, pz = dx, side = this.team === 'red' ? 1 : -1;
    const snap = (x, z) => { const c = grid.cell;
      const oc = this.unit ? nearestOpenCell(this.unit, Math.round(x / c), Math.round(z / c), 5) : null;
      return oc ? { x: oc.i * c, z: oc.j * c } : { x, z }; };
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
  trapAnchor() {
    const t = this._trap; if (!t) return this.homePos();
    const home = this.homeBasePos();
    let dx = home.x - t.x, dz = home.z - t.z; const d = Math.hypot(dx, dz) || 1; dx /= d; dz /= d;
    return { x: t.x + dx * 15, z: t.z + dz * 15 };
  }
  // Fall-back spot that puts the trap BETWEEN us and the enemy — a chaser must cross the mines.
  trapShield() {
    const t = this._trap; if (!t) return this.homePos();
    const e = this.lastEnemyPos() || this.enemyBasePos();
    let dx = t.x - e.x, dz = t.z - e.z; const d = Math.hypot(dx, dz) || 1; dx /= d; dz /= d;
    return { x: t.x + dx * 16, z: t.z + dz * 16 };
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
    if (!this._patrol) {
      const front = { x: (flag.x + fob.x) / 2, z: (flag.z + fob.z) / 2 };
      let tx = enemy.x - front.x, tz = enemy.z - front.z;
      const td = Math.hypot(tx, tz) || 1; tx /= td; tz /= td;       // unit vector toward the threat
      const px = -tz, pz = tx;                                      // perpendicular — the lane's width
      const mid = { x: (front.x + enemy.x) / 2, z: (front.z + enemy.z) / 2 };   // mid-field
      const home = { x: front.x + tx * 14, z: front.z + tz * 14 };  // home front, still in tower reach
      const SIDE = 30;
      this._patrol = [
        home,
        { x: mid.x + px * SIDE, z: mid.z + pz * SIDE },             // mid-field, one flank
        home,
        { x: mid.x - px * SIDE, z: mid.z - pz * SIDE },             // mid-field, other flank
      ];
      this._patrolI = 0;
    }
    const wp = this._patrol[this._patrolI];
    if (this.unit) {
      const u = this.unit.holder.position;
      if (Math.hypot(u.x - wp.x, u.z - wp.z) < 12) this._patrolI = (this._patrolI + 1) % this._patrol.length;
    }
    return this._patrol[this._patrolI];
  }
  flag() { return enemyFlagOf(this.team); }
  // Our OWN flag (the one a rival steals). ourFlagStolen → a live enemy is carrying it.
  ourFlag() { return flags.find(f => f.team === this.team) || null; }
  ourFlagStolen() { const f = this.ourFlag(); return !!(f && f.carried && f.carrier && !f.carrier.dead && f.carrier.team !== this.team); }
  // Our flag base has lost all its turrets → a defender can't lean on tower cover and
  // should switch to a Valkyrie's mobility (ai_behavior Defend).
  ownTowersDown() { return turretCountOf(this.team) === 0; }
  // DEFEND intercept point (ai_behavior): chase the carrier directly; if it's somehow
  // out of play fall back to the enemy's elevator — where they must take it to score.
  interceptSpot() {
    const f = this.ourFlag();
    if (f && f.carried && f.carrier && !f.carrier.dead) { const c = f.carrier.holder.position; return { x: c.x, z: c.z }; }
    return this.enemyFobPos();
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
  flagGrabbable() { return this.flagExposed() && (aiKeepBreach ? this.turretsLive() <= FLAG_GRAB_TURRETS : this.fortDown()); }
  // The enemy flag is sealed inside its HQ until that building is rubble. The
  // runner can't grab it before then, so the heavy must finish the HQ first —
  // strategy cards gate the open→grab handoff on this.
  flagExposed() { const f = this.flag(); return !!(f && f.revealed); }
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
  // The type to actually field: the wanted one if any remain, else a same-class
  // substitute, else whatever we have most of, else null (roster empty → eliminated).
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
    if (!this._exploreWp) { const home = this.homePos(), enemy = this.enemyBasePos(); this._exploreWp = this.explore.pickTarget(px, pz, home.x, home.z, this.strategy.arriveDist(this) + 12, enemy.x, enemy.z); }
    return this._exploreWp;
  }

  // Log label = this team's palette colour name (PURPLE, CYAN…), so a log line reads
  // as the colour the team actually wears on the field — clearer than a flavour name.
  get cname() { return teamLabel(this.colorIndex); }

  // Draw a fresh card (on repeated losses / stalls) — keeps the AI unpredictable.
  redraw() { this.strategy = makeDoctrine(this.archetype, this.personality, Math.random, this.strategy.constructor, m => aiLog(this.team, `${this.cname}: ${m}`)); this.fortHp0 = fortHpOf(this.targetTeam()) || this.fortHp0; this.failStreak = 0; aiLog(this.team, `${this.cname}: That's not working — new plan, listen up!`); }

  deploy() {
    const want = this.strategy.wantVehicle(this);
    // REINFORCEMENT SPENDING (Jacob's rule: "if I had the scrap, I'd spend it"): a rich bank
    // plus running LOW on the wanted type builds a fresh one before picking — not just at
    // zero. A commander sat on 15 scrap feeding lone runners into a defended base; a rich
    // team converts parts into pressure. Keeps a small float (+3) so it can't bankrupt
    // itself on one build; buildUnit still respects the garage cap.
    if (aiScrapBuild && (this.roster[want] || 0) <= 1 && this.scrap() >= (BUILD_COST[want] || 99) + 3) this.buildUnit(want);
    let type = this._pickAvailableType(want);
    // SALVAGE REINFORCEMENT: build the flag RUNNER when the plan needs one and we're out. The
    // firebrat has no substitute, so a commander that's lost them all can't win by capture — so
    // it spends the scrap bank to field a fresh one. Deliberately NOT a full resurrection: a
    // wholly-wiped team (type === null) still gets eliminated, or matches would never end (a
    // resurrecting team can't be beaten by elimination — measured -3/16 resolved). The build
    // only applies while the team is otherwise still alive.
    if (aiScrapBuild && want === 'firebrat' && (this.roster.firebrat || 0) === 0 && type !== null && type !== 'firebrat' && this.buildUnit('firebrat')) {
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
    this._stepAtDeploy = this.strategy.step;   // lock the type for this step — no mid-step churn
    this._recalling = false;
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
    this._mrec = { veh: type, kills0: this.kills, fort0: fortHpOf(this.targetTeam()), flagTouched: false };
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
  _planExit() {
    // A unit that rose on a SATELLITE pad (outside the FOB wall ring) has no gate to
    // thread — driving to a gate waypoint from out there would loop it back INTO the base.
    const fob = teamCamp(this.team, 'fob');
    if (fob && this._elev) {
      const wallR = (FOB_SIZE / 2) * grid.cell + 2;
      const d2 = (this._elev.center.x - fob.center.x) ** 2 + (this._elev.center.z - fob.center.z) ** 2;
      if (d2 > wallR * wallR) { this._exit = null; this._exitT = 0; return; }
    }
    this._exit = this._computeExit(); this._exitT = this._exit ? 8 : 0;
  }

  // Snapshot for the AI log overlay + an event when the unit changes its mind.
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
    if (cmd.state === 'exit') dest = this._exit || view.goal;
    else if (cmd.state === 'retreat') dest = this._home || view.goal;
    else if (cmd.state === 'resupply') dest = this._supply || view.goal;
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
        case 'exit':     line = `Rolling out the gate — ${dest}!`; break;
        case 'advance':  line = `Moving up — ${dest}!`; break;
        case 'flee':     line = `Taking fire — breaking off toward ${dest}!`; break;
        case 'pursue':   line = 'Lost visual — pushing to their last-known spot!'; break;
        case 'retreat':  line = `I'm hit! Hull at ${hpPct}% — pulling back to patch up, cover me!`; break;
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
  _navOverride(v, view, cmd, dt) {
    if (v._move.ignoreWalls) return;
    if (cmd.breakAim) return;     // brain is squaring up to shoot a blocker — don't steer it around
    const st = cmd.state;
    let dest = null, slack = 9;
    if (st === 'exit') { dest = this._exit || this.strategy.objective(this); slack = 5; }   // thread the gate via A*
    // Use the RESOLVED goal the brain is acting on (view.goal already folds in the shield-grab
    // and intercept detours), not the raw mission objective — else a ground unit's A* steers it
    // to the patrol/objective spot while it claims to be "grabbing a shield" and never gets there.
    else if (st === 'advance') dest = view.goal || this.strategy.objective(this);
    else if (st === 'pursue') dest = v.ai.lastSeen || this.strategy.objective(this);
    else if (st === 'retreat') dest = this._home;          // heal at own base (only place HP regens)
    else if (st === 'resupply') dest = this._supply;       // nearest fuel/ammo (own base or a depot)
    else if (st === 'assault') { dest = this.strategy.objective(this); slack = (view.engageRange || 36) * 0.7 * 1.25; }
    // SUPPRESS far-travel: the trek TO a siege standoff can be 100u+ around terrain, and pure
    // direct-steer + dodge feelers left jotuns shuttling between two spots for whole matches
    // (richwatch: stagnant 30s+ at gd 75-185 in suppress). Path-follow with A* until close,
    // then hand the final approach + the fire ladder back to the behavior. NAV_ASTAR_STATES
    // stays without 'suppress' — the nav overlay treats the close-in fight as combat-steered.
    else if (st === 'suppress' && view.threatStand
             && (view.threatStand.x - v.holder.position.x) ** 2 + (view.threatStand.z - v.holder.position.z) ** 2 > 26 * 26) {
      // While the stand is a LONG march away, travel on the MISSION OBJECTIVE's route — the
      // same dest assault uses. The threat line flickers at long range, and suppress↔assault
      // flips used to alternate two DIVERGENT A* routes (they left opposite ways around an
      // inlet): 20u out, flip, 20u back — six minutes of zero-net triangle jiggle at one spot
      // (seed 11). The radial standoff owns only the final ~70u approach.
      const d2s = (view.threatStand.x - v.holder.position.x) ** 2 + (view.threatStand.z - v.holder.position.z) ** 2;
      const obj = d2s > 70 * 70 ? this.strategy.objective(this) : null;
      dest = obj || view.threatStand; slack = 14;
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
      return;   // engage/suppress: steer as-is
    }
    if (!dest) return;
    const d2 = (dest.x - v.holder.position.x) ** 2 + (dest.z - v.holder.position.z) ** 2;
    if (d2 < slack * slack) return;                 // close enough — hand back to the behavior
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
      return;
    }
    const wp = navWaypoint(this._nav, v, dest, dt);
    if (!wp) return;                                // no route — keep the brain's command
    const s = steerToward(v, wp.x, wp.z);
    cmd.fwd = s.fwd; cmd.turn = s.turn;
    v.ai._wantMove = s.fwd > 0.3;                   // keep the anti-wedge motion check honest
  }

  // Decide whether to change the deployed vehicle. We only do this on a DELIBERATE
  // strategy beat — when the card advances to a new step (e.g. open -> grab = "the
  // fort's down, send the runner"). Per-tick counter-pick wobble no longer triggers a
  // swap, which was the churn that made units blink out. And instead of vanishing the
  // unit, we flag it to DRIVE HOME and get swapped at base (see _driveHome).
  _maybeRecall() {
    if (!this.unit || this._recalling) return;
    // HQ-FINISHER swap: the fort's down mid-siege but the walled HQ still stands and our sieger is
    // a GROUND unit that can't reach the keep — pull it back and roll out the flyer the doctrine now
    // wants (a Valkyrie). Normally we only re-pick on a STEP change; this fires within the siege step.
    // Force a Valkyrie swap WITHIN the siege step (not just on a step change) for either the
    // HQ-finisher (towers down, walled HQ) OR the stalemate gambit (base untouched, we're bailing
    // on the mid-field grind to fly one around the back). Both want the flyer that a ground sieger
    // can't be.
    const hqSwap = this.strategy.step === 'siege' && (this.fortDown() || this._gambit) && !this.flagExposed()
      && this.unit.type !== 'valkyrie' && !this.unit._move.ignoreWalls
      && this._pickAvailableType(this.strategy.wantVehicle(this)) === 'valkyrie';
    // RUNNER SWAP: we're on CAPTURE with a grabbable flag, but the fielded unit is a stand-in
    // heavy (all firebrats died earlier, so the type fell back to "most numerous"). deploy()
    // knows how to build a fresh firebrat from scrap — but deploy only runs on death/recall,
    // and with the enemy eliminated this unit never dies and capture never changes step, so
    // the build was unreachable (seed 193: a lurcher looped fuel-RTB "sneak" runs for 800s
    // with 15 scrap banked). If a real runner is in the garage or affordable, swap for it.
    const runnerSwap = this.strategy.step === 'capture' && this.flagGrabbable()
      && this.unit.type !== 'firebrat'
      && ((this.roster.firebrat || 0) > 0 || (aiScrapBuild && this.canAfford('firebrat')));
    if (this.strategy.step === this._stepAtDeploy && !hqSwap && !runnerSwap) return;   // same beat → keep the current unit (unless we need the flyer/runner)
    if (runnerSwap) {
      this._stepAtDeploy = this.strategy.step; this._recalling = true;
      this._recallForce = true;   // committed — same deadlock-proofing as the hqSwap recall
      this._recallBestD = Infinity; this._recallStallT = 0; this._nav.path = null;
      aiLog(this.team, `${this.cname}: The flag's sitting right there — pull the ${this.unit.type} back, we're sending a real runner!`);
      return;
    }
    if (hqSwap) {   // commit the swap even with defenders near — a unit lost en route just respawns as the Valkyrie
      _hqSwapCount++;
      this._stepAtDeploy = this.strategy.step; this._recalling = true;
      this._recallForce = true;   // COMMITTED: the threat-abort must not cancel this recall — aborting re-armed it same tick (log ×11k, Valkyrie never launched, stalemate stayed deadlocked)
      this._recallBestD = Infinity; this._recallStallT = 0; this._nav.path = null;
      aiLog(this.team, this.fortDown()
        ? `${this.cname}: Turrets are down — pull the ${this.unit.type} back, roll out a Valkyrie to crack that keep!`
        : `${this.cname}: Break off the grind — pull the ${this.unit.type} back, Valkyrie's going around the back!`);
      return;
    }
    // Don't turn our back on a live rival to go swap vehicles: a recalled unit drives home
    // defenceless and gets shot in the back (a slow Jotun especially). Defer the swap while a
    // rival is close — and DON'T consume the step change, so it re-attempts once the coast is
    // clear. (Fixes: "jotun recalled to swap for a capture firebrat, turned its back, died".)
    const up = this.unit.holder.position;
    for (const o of combatants) {
      if (o.dead || o.team === this.team || vehicleHidden(o)) continue;
      if ((o.holder.position.x - up.x) ** 2 + (o.holder.position.z - up.z) ** 2 < 52 * 52) return;
    }
    // Compare against the type we'd ACTUALLY field (after save-last / role substitution),
    // not the raw role want — otherwise a unit that's already the best available substitute
    // gets recalled to "swap" for a wanted type we'd only re-substitute right back to it.
    const want = this._pickAvailableType(this.strategy.wantVehicle(this));
    this._stepAtDeploy = this.strategy.step;                        // consume the step change either way
    if (!want || this.unit.type === want) return;                  // new beat wants the same vehicle → carry on
    // INTERCEPT (our flag was just lifted): only worth driving HOME to fetch a Valkyrie if it's a
    // QUICK swap — a slow GROUND unit (Jotun/Lurcher) that's already near our own FOB. Otherwise
    // retreating to swap just gifts the runner a clean escape; keep whatever we've got and RUN THE
    // THIEF DOWN (interceptSpot already tracks the carrier, and engage kills it on sight). A Firebrat
    // is fast enough to chase; a distant heavy still does more cutting the lane than turning its back.
    if (this.strategy.step === 'intercept') {
      const ground = this.unit.type === 'jotun' || this.unit.type === 'lurcher';
      const home = teamCenter(this.team, 'fob');
      const nearElev = (up.x - home.x) ** 2 + (up.z - home.z) ** 2 < INTERCEPT_SWAP_R * INTERCEPT_SWAP_R;
      if (!(ground && nearElev)) return;   // chase with the current unit — no recall home
    }
    this._recalling = true;
    this._recallForce = false;                                     // a routine swap still defers to the threat-abort
    this._recallBestD = Infinity;                                  // closest we've gotten to home so far
    this._recallStallT = 0;                                        // time since we last made headway toward home
    this._nav.path = null;                                          // replan toward home
    aiLog(this.team, `${this.cname}: Pull that ${this.unit.type} back — park it and roll out the ${want}!`);
  }

  // Drive a recalled unit back to its FOB, then despawn it quietly (no explosion) so
  // the next deploy rolls out the wanted vehicle — a clean role change, not a suicide.
  _driveHome(dt) {
    const v = this.unit;
    this.strategy.tick(this, dt);   // per-slot doctrine — this card is nobody else's to tick
    applyAltitude(v, dt); decayAim(v, dt); v.cooldown -= dt;
    if (v.dead) { this.unit = null; this._recalling = false; this._recallForce = false; this.respawnT = 3; return; }
    const home = teamCenter(this.team, 'fob');
    const d = Math.hypot(v.holder.position.x - home.x, v.holder.position.z - home.z);
    const reach = (this._elev ? this._elev.padHalf : 8) + 5;
    // PROGRESS-based recall: a unit gets as long as it needs to crawl home (a slow Jotun
    // from across the map is fine — that's the game). We only give up if it makes NO
    // headway toward home for a while = TRULY wedged (the nav stuck-escalation couldn't
    // free it). Any new closest-to-home distance resets the stall clock.
    const RECALL_STALL = 10;                                       // s of zero progress = stuck
    if (d < this._recallBestD - 0.5) { this._recallBestD = d; this._recallStallT = 0; }
    else this._recallStallT += dt;
    const stuck = this._recallStallT > RECALL_STALL;
    if (d < reach || stuck) {
      aiLog(this.team, d < reach ? `${this.cname}: ${v.type} is home — swapping it out now!` : `${this.cname}: ${v.type} can't get home, it's hung up — ditch it and swap!`);
      removeCombatant(v); scene.remove(v.group); this.unit = null; this._recalling = false; this._recallForce = false; this.respawnT = 1.0;
      return;
    }
    const wp = navWaypoint(this._nav, v, home, dt) || home;
    const s = steerToward(v, wp.x, wp.z);
    const out = burnFuel(v, { fwd: s.fwd, turn: s.turn }, dt);
    v._throttle = Math.min(1, Math.abs(out.fwd) + Math.abs(out.turn) * 0.6);
    v.speedMul = roadSpeedMul(v) * rankSpeedMul(v);   // road boost × promotion (bronze stars)
    v.drive(dt, out.fwd, out.turn, null, v._blocked);
    v.ai._wantMove = s.fwd > 0.3;
    this._dbg = {
      name: this.cname, type: v.type, state: 'return-to-base',
      card: (this.strategy.constructor.name || 'Card').replace('Strategy', ''),
      fwd: +s.fwd.toFixed(2), turn: +s.turn.toFixed(2), blk: '···',
      hp: Math.round(v.hp / v.maxHp * 100), ammo: v.ammo, fuel: Math.round(v.fuel), distFob: Math.round(d),
      towers: this.turretsLive(),
    };
  }

  update(dt) {
    this._matchT += dt;
    // Notify once the moment the enemy fleet is wiped — instead of a unit silently
    // wandering off to "chase the last seen enemy" that no longer exists.
    if (!this._enemyGoneAnnounced && this.enemyEliminated()) {
      this._enemyGoneAnnounced = true;
      aiLog(this.team, `${this.cname}: Their whole fleet's down — the field is OURS! All units, press the base!`);
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
        const lost = this.unit.type;                 // attrition: that vehicle is gone from the roster
        if (this.roster[lost] != null) this.roster[lost] = Math.max(0, this.roster[lost] - 1);
        // MISSION REPORT CARD: grade the tour that just ended. Progress = any kill, any real
        // damage to their base, or a hand on the flag. A total failure counts against the
        // mission that was RUNNING AT DEATH; two straight total failures ban it for a while
        // (missionBanned → the doctrine's FAIL_ALT unblocker) so the commander stops making
        // the same bad decision over and over.
        const rec = this._mrec; this._mrec = null;
        if (rec) {
          const step = this.strategy.step;
          const progress = this.kills > rec.kills0 || rec.flagTouched
            || rec.fort0 - fortHpOf(this.targetTeam()) > 60;   // more than a stray chip of base damage
          if (!progress) {
            if (this._failStep === step) this._failN++; else { this._failStep = step; this._failN = 1; }
            this._failT = performance.now();
            if (this._failN === 2) {
              // Snapshot the battlefield the bench is supposed to change — the ban lifts on
              // PROGRESS against these, not on a timer (see missionBanned).
              this._failSnap = { twr: this.turretsLive(), fort: fortHpOf(this.targetTeam()), k: this.kills };
              aiLog(this.team, `${this.cname}: That's two units lost on this ${step} plan with NOTHING to show — we're trying something else!`);
            }
          } else if (this._failStep === step) { this._failStep = null; this._failN = 0; }
        }
        // A runner died storming the base → don't just feed another firebrat in. If the enemy
        // still has DEFENDING VEHICLES, they'll intercept the fragile runner — send a combat
        // unit to CLEAR THEM FIRST (better signal than the death's damage-split, which mislabels
        // a mixed tower+vehicle kill). Only a pure tower gauntlet (no enemy vehicles) → sneak wide.
        if (this.unit.type === 'firebrat' && this.strategy.step === 'capture') {
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
      this.unit = null;
      this._rising = false; this._recalling = false; this._recallForce = false;
      this.respawnT -= dt;
      // Respawn only while this slot is inside the cap — an overflow slot (cap shrank
      // under it) retires here instead of redeploying (_syncSlots prunes it once empty).
      if (this.started && !this._eliminated && this.respawnT <= 0 && this._slotI < this.unitCap()) { this.respawnT = 4 + Math.random() * 3; this.deploy(); }
      return;
    }
    // Report card: a hand on the enemy flag at ANY point counts as progress (even if the
    // runner is later gunned down, the plan produced something — don't ban it).
    if (this._mrec && !this._mrec.flagTouched) {
      const f = this.flag();
      if (f && f.carrier === this.unit) this._mrec.flagTouched = true;
    }
    // Still riding the FOB lift up? Hold (no driving/firing) until it tops, then
    // detach so the brain takes the wheel — mirrors the player's deploy handover.
    if (this._rising) {
      if (this._elev && this._elev.rider === this.unit && this._elev.phase === 'top') {
        this._elev.rider = null; this._rising = false;
        this.unit._elevShieldUntil = performance.now() + ELEV_SHIELD_MS;   // anti-camp cover while it clears the mouth
        this._planExit();   // ground units must aim at a GATE and drive out before pursuing
      } else { return; }
    }
    if (this._recalling) {
      // Jumped on the way home? ABORT the swap and hand back to the normal brain, which runs
      // enemy detection + fight-or-flight (facing/focus) — don't crawl home defenceless and
      // get shot in the back. _maybeRecall re-defers the swap (its own combat guard) until the
      // rival is dealt with. Coast clear → keep driving home to swap as before.
      const up = this.unit.holder.position; let threatened = false;
      for (const o of combatants) {
        if (o.dead || o.team === this.team || vehicleHidden(o)) continue;
        if ((o.holder.position.x - up.x) ** 2 + (o.holder.position.z - up.z) ** 2 < 46 * 46) { threatened = true; break; }
      }
      // A FORCED recall (gambit / HQ-finisher swap) drives home even under fire — that's what
      // "commit" means. Aborting here re-armed the swap on the very next tick (_maybeRecall's
      // hqSwap ignores defenders), producing an abort↔re-arm deadlock: thousands of log lines,
      // a unit commanded only every other tick, and the stalemate-breaking Valkyrie never fielded.
      if (!threatened || this._recallForce) { this._driveHome(dt); return; }
      this._recalling = false; this._stepAtDeploy = null;   // fall through to the brain to fight/flee
    }
    this.strategy.tick(this, dt);   // per-slot doctrine — this card is nobody else's to tick
    this._maybeRecall();
    if (this._recalling) return;   // just started the trip home
    const v = this.unit;
    if (!v) return;
    const view = this._view(v, dt);
    const cmd = v.ai.think(view);
    v._aiState = cmd.state;                 // exposed so a rival's _view can tell this unit is retreating ("finish him")
    this._navOverride(v, view, cmd, dt);   // route travel states with A* (around water/trees, through gates)
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
    // ANTI-SHORE-GRIND: a sinker commanded FORWARD into DEEP water it can't cross (a last leg past
    // an inlet with no A* route) otherwise grinds the waterline forever — and the anti-wedge reflex
    // spins it in place: the "dancing on the shore". Deep water is a hard wall for a sinker, so cut
    // the forward throttle — it PLANTS at the shore instead of grinding. Turn is preserved, so it
    // can still rotate to aim/fire from there, and as it turns to a clear heading forward returns
    // (it skirts). Only OFF-ROAD deep water triggers this: shallow fords and bridges are unaffected
    // (isDeepWater reads the floor even under a bridge, so the road-cell check must come first).
    if (aiAntiGrind && v._move.water === 'sink' && out.fwd > 0.05) {
      const ahx = v.holder.position.x - Math.sin(v.heading) * (VEH_R + 2);
      const ahz = v.holder.position.z - Math.cos(v.heading) * (VEH_R + 2);
      if (map.isDeepWater(ahx, ahz) && roadDeckY(ahx, ahz) == null) { out.fwd = 0; v.ai._wantMove = false; }
    }
    const mineTurn = mineAvoidNudge(v);   // soft-steer around a spotted mine dead ahead (no A* block)
    if (mineTurn) out.turn = Math.max(-1, Math.min(1, out.turn + mineTurn));
    v._throttle = Math.min(1, Math.abs(out.fwd) + Math.abs(out.turn) * 0.6 + Math.abs(out.strafe || 0) * 0.6);   // for spatial engine RPM
    v.speedMul = roadSpeedMul(v) * rankSpeedMul(v);   // road boost × promotion (bronze stars)
    v.drive(dt, out.fwd, out.turn, null, v._blocked, out.strafe || 0);
    applyAltitude(v, dt);
    decayAim(v, dt);
    if (v.dead) { this.unit = null; this.respawnT = 4; this._rising = false; return; }
    v.cooldown -= dt;
    // Fire at the current target: a suppressed wall-turret (aimed at its raised head so
    // the slug arcs up). With NO clean line to it (a wall/HQ blocks the shot) a siege
    // unit aims LOW instead — at the obstruction — so the shell demolishes a path through
    // rather than arcing uselessly over the wall at a turret it can't reach.
    if (cmd.fire && v.cooldown <= 0) {
      let tp = null, atEnemy = false;
      if (cmd.state === 'suppress' && view.threat) {
        tp = (!view.threatLOS && view.demolishTarget)
          ? _aimDir.set(view.demolishTarget.x, view.demolishTarget.y, view.demolishTarget.z).clone()
          : _aimDir.set(view.threat.x, view.threat.y, view.threat.z).clone();
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
    }
  }

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
    for (const o of combatants) {                       // nearest VISIBLE rival of any other team
      if (o.dead || vehicleHidden(o)) continue;          // a unit still down the lift shaft isn't on the field yet
      const d = (o.holder.position.x - px) ** 2 + (o.holder.position.z - pz) ** 2;
      if (o.team === this.team) { if (o !== v && d < FIGHT_R2) alliesNear++; continue; }
      if (d < FIGHT_R2) enemiesNear++;
      // Per-vehicle visual range: how far WE see + how far THEY show, averaged (see the SIGHT/VIS tables).
      const effR = AI_VISION * (mySight + (VIS[o.type] ?? 1)) * 0.5;
      if (d < effR * effR && d < nearestD && (flyer || hasLOS(px, pz, o.holder.position.x, o.holder.position.z))) {
        nearestD = d; enemy = { x: o.holder.position.x, y: o.holder.position.y, z: o.holder.position.z, type: o.type, shield: o.shield, vx: o._vx || 0, vz: o._vz || 0,
          heading: o.heading, hpFrac: o.maxHp ? o.hp / o.maxHp : 1, retreating: o._aiState === 'retreat' || o._aiState === 'resupply' }; seen = o; seesEnemy = true;
      }
    }
    // Remember WHERE the enemy was last seen (team-shared) so the Attack mission can recall
    // their last-known position instead of only marching to the fixed elevator (ai_behavior).
    if (seen) this._lastEnemyPos = { x: enemy.x, z: enemy.z, t: performance.now() };
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
      }
    }
    // GHOST CLEARED: we reached the last-known spot and there's nobody here to see OR hear —
    // so the intel is spent. Drop it now instead of loitering over an empty spot for the full
    // 12s stale window (the "Valkyrie hovering over where a teammate died" idle). With it gone,
    // the Attack objective falls back to the enemy base and the unit pushes on.
    if (!seesEnemy && !heard && this._lastEnemyPos) {
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
    this._shielding = false; this._shieldRun = false; this._shieldGen = null;
    if (!this._intercepting && (v.type === 'lurcher' || v.type === 'valkyrie')
        && v.maxShield > 0 && v.shield < v.maxShield * 0.6
        && !(this.flag() && this.flag().carrier === v)) {
      const gen = this.nearestKnownShield(px, pz);
      // Detour distance scales with how EMPTY the shield is: a fresh unit (0 armour) will
      // go well out of its way to top up (×1.6), one already half-full barely diverts (×1).
      // So armour-capable units reliably swing by the generator on the way out, instead of
      // only grabbing it when it happens to be right next to them.
      const reach = SHIELD_GRAB_RANGE * (1.6 - v.shield / v.maxShield);
      const gd = gen ? Math.hypot(gen.pos.x - px, gen.pos.z - pz) : Infinity;
      if (gen && gd < reach) {
        goal = { x: gen.pos.x, z: gen.pos.z }; this._shielding = true; this._shieldGen = gen;
        // SECURE IT: once we're CLOSE, grabbing the armour beats picking a fight — beeline the gen,
        // top up, THEN fight (shieldRun outranks combat in the brain). Fixes the "went for the shield,
        // then wandered off to a turret and never got it" bail. shootGoal is already off while
        // detouring, so it won't gun down its own generator on the way in.
        if (gd < SHIELD_COMMIT) this._shieldRun = true;
      }
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
    //    skipped for the slow Jotun, active siegers/capturers, flag carriers, and while already detouring.
    if (!this._scrapDetour && !this._shielding && !this._intercepting && v.type !== 'jotun'
        && this.strategy.step !== 'siege' && this.strategy.step !== 'capture' && this.strategy.step !== 'scavenge'
        && !(this.flag() && this.flag().carrier === v)) {
      const sp = this.nearestKnownScrap(px, pz);
      if (sp && Math.hypot(sp.pos.x - px, sp.pos.z - pz) < SCRAP_GRAB_RANGE) { goal = { x: sp.pos.x, z: sp.pos.z }; this._scrapDetour = true; this._scrapTargetPile = sp; }
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
    // Divert to a single-resource depot when it fixes the actual need AND the other
    // resource is still OK (so the latch will clear there). Both genuinely low → base only.
    const depotKind = (needAmmo && fuelOk) ? 'ammo' : (needFuel && ammoOk) ? 'fuel' : null;
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
    // RE-ARM THE GATE EXIT (anti-elevator-circle). A ground unit that's drifted back inside its
    // own FOB and can't thread the gate on its own ends up circling on the elevator (the unstick
    // reflex spins it in place — the "dancing on the elevator" bug). Hand it the same DETERMINISTIC
    // gate-exit it gets on deploy: rotate to the throat, drive straight out.
    //   Fires ONLY when the unit truly wants to be OUT and heading to the FIELD. Critically it must
    // NOT fire while the brain is latched to resupply/heal (`_resup`/`_hurt`): forcing the exit
    // ejects it mid-top-off, so `_resup` (which only clears at a FULL 99% base top-off) never
    // clears — it turns around, gets ejected again, and yo-yos in/out the gate forever (RTB-to-
    // refuel↔roll-out at 85% fuel). And the objective must be OFFENSIVE (far from BOTH friendly
    // bases), so a DEFEND/Turtle whose whole job is the rear flag↔elevator corridor isn't ejected.
    if (this._exitCoolT > 0) this._exitCoolT -= dt;
    // …and ONLY when the unit is actually FAILING to leave (grinding, no headway). The re-arm
    // exists for a unit that can't thread the gate on its own — but it used to hijack a HEALTHY
    // traveler too: a sieger path-following out through the fob ring got yanked to the gate
    // waypoint, released, re-yanked every cooldown — the exit↔suppress two-master flap ("Rolling
    // out the gate" ↔ "Lining up on their HQ") that pinned a Lurcher at its own base.
    const exitFailing = this._stuckT > 1.2 || !(this._nav && this._nav.path && this._nav.path.length);
    if (aiFobRearm && !this._exit && this._exitCoolT <= 0 && exitFailing && !v._move.ignoreWalls && fob && !v.ai._resup && !v.ai._hurt) {
      const dFob2 = (px - fob.center.x) ** 2 + (pz - fob.center.z) ** 2;
      const obj = this.strategy.objective(this), homeB = this.homeBasePos();
      const objOffensive = (obj.x - fob.center.x) ** 2 + (obj.z - fob.center.z) ** 2 > 30 * 30
        && (obj.x - homeB.x) ** 2 + (obj.z - homeB.z) ** 2 > 40 * 40;   // out on the field, not a rear/home patrol
      const wantsOut = !needAmmo && !needFuel && v.hp > v.maxHp * 0.9;
      if (dFob2 < 18 * 18 && wantsOut && objOffensive) {
        // Two-goal spin guard: a unit standing 8-9u from the gate waypoint but still <18u of the
        // fob used to flap — re-arm rotates it TO the gate point, the 8u clear fires instantly,
        // advance rotates it BACK to the objective, re-arm fires again (the ~150° back-and-forth
        // between two paths). Only arm an exit that's genuinely somewhere to GO, and cool down
        // between evaluations either way so a cleared exit gets a free run at the field.
        const e = this._computeExit();
        if (e && (px - e.x) ** 2 + (pz - e.z) ** 2 > 10 * 10) { this._exit = e; this._exitT = 20; }
        this._exitCoolT = 6;
      }
    }
    // Post-deploy: drive OUT through the gate first. mustGo forces the brain to head
    // straight for the exit waypoint (no engaging/firing) until it clears the gate.
    let mustGo = false;
    if (this._exit) {
      this._exitT -= dt;
      const dd = (px - this._exit.x) ** 2 + (pz - this._exit.z) ** 2;
      if (dd < 8 * 8 || this._exitT <= 0) { this._exit = null; this._exitCoolT = 6; }   // cleared the gate (or timed out) — cool the re-arm so advance gets a clean run
      else mustGo = true;
    }
    // The nearest LIVE enemy wall-turret this unit can actually SHOOT — sensed wide
    // (TURRET_SENSE) so heavies snipe from outside the towers' own range, but ONLY
    // counted if there's a clear line to it. That LOS gate is the key: a unit no
    // longer wastes shots hammering the front wall trying to hit a tower behind it —
    // it picks the tower it can see (a near/flank corner), and as that one dies the
    // line to the next opens up. `flankSide` nudges the approach around to the side
    // instead of charging straight into the gap between two towers (see AI.js).
    let threat = null, threatD = TURRET_SENSE * TURRET_SENSE, threatCamp = null;
    for (const c of camps) {
      if (c.team === this.team) continue;
      for (const w of c.walls) {
        const t = w.turret;
        if (!t || t.dead || t.falling) continue;
        t.group.updateWorldMatrix(true, false);
        t.head.getWorldPosition(_threatV);
        const d = (_threatV.x - px) ** 2 + (_threatV.z - pz) ** 2;
        if (d < threatD) { threatD = d; threat = { x: _threatV.x, y: _threatV.y, z: _threatV.z }; threatCamp = c; }
      }
    }
    // KILL THE KEEP: the flag HQ is a first-class siege target, not a last resort. The flag only
    // exposes when the HQ building falls, so hoarding it until all four turrets are dead is what
    // stalls a siege forever. Whenever a siege unit has a CLEAN LINE to the enemy HQ, prefer
    // flattening it when the HQ is the better shot — no live turret at all, no clear line to the
    // nearest turret (it's walled behind the keep), or the HQ is simply closer. Dropping the HQ
    // reveals the flag AND opens angles on the back towers. LOS-gated, so units still grind the
    // walls/near towers until a line to the keep actually opens (they don't charge blind).
    let hqThreat = false;
    if (this.strategy.step === 'siege') {   // (was this.strategy.key — always undefined, so this HQ-targeting block never ran: siegers only ever shelled turrets, never the keep)
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
        const turretLOS = threat && (flyer || hasLOS(px, pz, threat.x, threat.z));
        // The stalemate GAMBIT goes straight for the KEEP (that's the whole point — crack the HQ,
        // expose the flag, win — not trade tower-for-tower while the enemy's tied up mid-field).
        const promote = this._gambit || (aiKeepBreach ? (!threat || !turretLOS) : !threat);
        if (promote) { threat = hqPt; threatCamp = ec; hqThreat = true; }
      }
    }
    // Is there a CLEAR shot at the nearest tower, and which way to peel around it?
    // `threatLOS` lets the brain hold + fire when it can see the tower, or swing wide
    // to the flank (rather than hammer the wall in front of it) when it can't. The
    // cross product of (base→tower) × (tower→unit) picks the nearer side to arc to.
    let flankSide = 0, threatLOS = false, threatStand = null;
    if (threat) threatLOS = flyer || hasLOS(px, pz, threat.x, threat.z);
    // BREACH COMMIT: the siege stall was the sieger ORBITING the base at sniper range,
    // re-picking the nearest wall every tick — so fire spread across the whole ring and no
    // gap ever opened (measured: walls stuck at 23/30, HQ never lost a point over 8000 ticks).
    // Instead LATCH one wall and hammer it to rubble, then the next nearest — punching a single
    // breach we can push through, exactly how a human cracks a base.
    let breachWall = null, breached = false;
    if (aiBreachCommit && threat && !threatLOS && threatCamp && !flyer) {
      breached = threatCamp.walls.some(w => w.body && w.body.dead);   // a hole already exists?
      let w = this._breachW;                                          // keep the latched wall while it stands
      if (!(w && w.body && !w.body.dead && threatCamp.walls.includes(w))) {
        w = null; let bestW = Infinity;
        for (const cand of threatCamp.walls) {
          if (!cand.body || cand.body.dead) continue;
          const d = (cand.group.position.x - px) ** 2 + (cand.group.position.z - pz) ** 2;
          if (d < bestW) { bestW = d; w = cand; }
        }
        this._breachW = w;
      }
      breachWall = w;
    } else { this._breachW = null; }
    if (threat) {
      // CLOSE IN to finish. A heavy planted at its full 64u sniper hold often has NO line through
      // the base walls, so it sprays the wall face and idles (the audit's "lone jotun frozen at
      // the wall for 640s"). Drive to a short hold — when we can actually finish (enemy wiped, OR
      // turrets down, OR we've already punched a hole) — to get a real line on the breach / keep.
      const finisher = this.enemyEliminated();
      const closeIn = aiBreachCommit ? (finisher || this.fortDown() || breached) : finisher;
      const sniper = TURRET_HOLD[v.type] || (ENGAGE_RANGE[v.type] || 36) * 0.9;
      const hold = !aiBreachCommit ? (finisher ? Math.min(22, TURRET_HOLD[v.type] || 22) : sniper)
                 : closeIn ? Math.min(24, TURRET_HOLD[v.type] || 24)
                 : breachWall ? Math.min(34, TURRET_HOLD[v.type] || 34)
                 : sniper;
      if (breachWall) {
        // Plant OUTSIDE the latched breach wall (radial from base centre) and HOLD — hammer this
        // one wall down instead of circling and smearing fire across the ring.
        const cx = threatCamp.center.x, cz = threatCamp.center.z;
        const wx = breachWall.group.position.x, wz = breachWall.group.position.z;
        let dx = wx - cx, dz = wz - cz; const dm = Math.hypot(dx, dz) || 1;
        threatStand = { x: wx + (dx / dm) * hold, z: wz + (dz / dm) * hold };
      } else if (hqThreat) {
        // The keep IS the base centre, so there's no "radial through a corner tower" to
        // stand off along — and no other guns left to dodge. Just hold at range on our
        // current approach line and pour fire in.
        const ux = px - threat.x, uz = pz - threat.z, um = Math.hypot(ux, uz) || 1;
        threatStand = { x: threat.x + (ux / um) * hold, z: threat.z + (uz / um) * hold };
      } else if (threatCamp) {
        const bx = threat.x - threatCamp.center.x, bz = threat.z - threatCamp.center.z;
        const ux = px - threat.x, uz = pz - threat.z;
        flankSide = (bx * uz - bz * ux) >= 0 ? 1 : -1;
        // The one-gun-at-a-time spot: radially OUTSIDE the base through this turret,
        // at the type's hold range — far from the OTHER corner turrets' fire arcs.
        const om = Math.hypot(bx, bz) || 1;
        threatStand = { x: threat.x + (bx / om) * hold, z: threat.z + (bz / om) * hold };
      }
    }
    // SIEGE FLATTEN: with no clean line on the tower, shell the latched breach wall (a real,
    // solidly-hittable target at its true position) to blow a path through — aimed shots at the
    // hidden turret just arc over. Falls back to the nearest wall if no breach wall is latched.
    let demolishTarget = null;
    if (breachWall) {
      const wx = breachWall.group.position.x, wz = breachWall.group.position.z;
      demolishTarget = { x: wx, y: map.heightAt(wx, wz) + 2.5, z: wz };
    } else if (threat && !threatLOS && threatCamp) {   // knob-OFF fallback: nearest wall, re-picked each tick
      let bestW = Infinity;
      for (const w of threatCamp.walls) {
        if (!w.body || w.body.dead) continue;
        const wx = w.group.position.x, wz = w.group.position.z;
        const d = (wx - px) ** 2 + (wz - pz) ** 2;
        if (d < bestW) { bestW = d; demolishTarget = { x: wx, y: map.heightAt(wx, wz) + 2.5, z: wz }; }
      }
      // FINISH THE KEEP: every wall is rubble and the "threat" is the solid HQ itself.
      // A LOS ray to the HQ's CENTRE dies inside the building's own obstacle circle, so
      // threatLOS can never come true for a ground unit — the sieger used to park at its
      // standoff and never fire (seed 207: a lurcher staring at a 297hp keep for 400s
      // while the flag stayed sealed). With nothing else left to shoot through, the keep
      // is a demolish target like any wall: square onto the hull and shell it open.
      if (!demolishTarget && hqThreat) demolishTarget = { x: threat.x, y: map.heightAt(threat.x, threat.z) + 2.5, z: threat.z };
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
    return {
      dt,
      self: { x: px, z: pz, heading: h, type: v.type, shield: v.shield, hpFrac: v.hp / v.maxHp, fuelFrac: v.fuel / v.maxFuel, ammoFrac: v.ammo / v.maxAmmo },
      seesEnemy, enemy, heard, enemiesNear, alliesNear, flyer, shotArc: SHOT_ARC[v.type] ?? Math.PI / 5,
      worldR: islandBound || 0,   // hard travel rim (map centre radius) — flee bends along it instead of pinning
      underFire: (performance.now() - (v._hitByVehT || -1e9)) < 1600,   // an enemy vehicle shot us in the last ~1.6s

      // shot-feedback: ≥2 of our recent rounds (last ~2s) detonated on terrain/cover, not on
      // the enemy → the firing lane is blocked; the combat brain sidesteps to clear it.
      shotBlocked: (v._blockedShots || 0) >= 2 && (performance.now() - (v._lastBlockT || 0)) < 2000,
      enemyGone: this.enemyEliminated(),   // target fleet wiped → don't waste time ghost-chasing a dead sighting
      support: turretCountOf(this.team) > 0 ? this.homeBasePos() : null,   // rally toward own tower cover (ai_behavior duels)
      threat, threatLOS, flankSide, threatStand, demolishTarget, breakTarget, engageRange: ENGAGE_RANGE[v.type] || 36,
      shotReach: SHOT_REACH[v.type] || 999,   // hard cap on firing distance — a round physically dies past this (see SHOT_REACH)
      fofW: fofFor(this.team),   // this team's fight-or-flight weight set (tunable / A/B)
      hqThreat,   // the suppress target is the enemy KEEP (not a tower) — for logs/recorder
      goal: mustGo ? this._exit : goal,
      mustGo,
      resupply: supply ? { x: supply.center.x, z: supply.center.z } : goal,
      supplyHeals,   // the chosen resupply point is an own base → hold until ammo+fuel+hp are all maxed
      home: healHome || goal,
      atHome: nearOwnSupply(v, px, pz),   // already in the base's heal/rearm zone → stop and top up (don't orbit the exact centre)
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
      // Salvage detour: drive ONTO the pile (within SCRAP_PICKUP_R) instead of stopping at the
      // mission's arriveDist — Scout(12)/Attack(10) exceed the 8u pickup, so the unit used to halt
      // just short and idle for seconds before drifting into range. Tight like the shield/intercept grabs.
      arriveDist: this._intercepting ? 4 : this._shielding ? 6 : (this._scrapDetour && aiScrapTightArrive) ? 4 : this.strategy.arriveDist(this),
      // Is this unit on a flee-contact RUNNER mission (grab the flag / scout — avoid fights)
      // vs one the commander sent it out to FIGHT on (attack/siege/defend/intercept)? Gates
      // the Firebrat's runnerFlee reflex so an ordered-to-engage Firebrat actually closes +
      // shoots instead of dodging the instant an enemy is near.
      runnerMode: this.strategy.step === 'capture' || this.strategy.step === 'scout',
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
  const archs = assignArchetypes(aiTeams.length, doctrineRng);   // distinct doctrines → a real contrast each match (seedable via ?dseed)
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
function updateCommanders(dt) { for (const cmd of commanders) cmd.update(dt); updateFlags(dt); }

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
    '<span id="ai-log-btns"><span class="lg-btn" data-act="export" title="Copy a snapshot to share">⧉</span>' +
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
function updateAiLog() {
  const el = document.getElementById('ai-log');
  if (aiLogMode === 'hidden') { if (el) el.style.display = 'none'; return; }
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
        html += `<div class="tb-l">${d.state} · hp ${d.hp}% · ammo ${d.ammo} · fuel ${d.fuel}/${d.maxFuel}${fof} · fob ${d.distFob}</div>`;
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

// Line of sight: blocked if any wall obstacle straddles the segment a→b.
function hasLOS(ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const len = Math.hypot(dx, dz) || 1;
  const steps = Math.ceil(len / 4);
  for (let s = 1; s < steps; s++) {
    const t = s / steps, x = ax + dx * t, z = az + dz * t;
    for (const o of obstacles) {
      if (o.body && o.body.dead) continue;           // a downed wall no longer blocks line of sight
      const ox = x - o.x, oz = z - o.z;
      if (ox * ox + oz * oz < o.r * o.r) return false;
    }
  }
  return true;
}

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
  // Sun nearly overhead, tilted slightly toward -Z — the specular look bro dialled in
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
    matchOver = true; matchWon = true;
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
    #build-panel .scrap { color:#ffcf4a; letter-spacing:0.12em; margin-bottom:8px; }
    #build-panel .scrap b { font-size:15px; }
    #build-panel .shop-sec { color:#5a7a8a; letter-spacing:0.18em; font-size:9px; margin:7px 0 4px; }
    #build-panel .shop-grid { display:grid; grid-template-columns:1fr 1fr; gap:6px; }
    #build-panel .shop-tile { position:relative; cursor:pointer; border:1px solid #1f6b3f; border-radius:5px;
      background:#0b1c12; padding:4px 4px 3px; text-align:center; }
    #build-panel .shop-tile:hover:not(.off) { background:#143524; }
    #build-panel .shop-tile.off { opacity:0.38; cursor:default; border-color:#333; }
    #build-panel .shop-tile img { width:100%; height:56px; object-fit:contain; display:block; }
    #build-panel .shop-tile .tl { display:block; font-size:9px; letter-spacing:0.08em; color:#8ff0b0; margin-top:2px; }
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
  panel.innerHTML = `<div class="scrap">⚙ SCRAP SHOP <b id="bp-scrap">0</b></div>`
    + `<div class="shop-sec">VEHICLES</div>`
    + `<div class="shop-grid">${['firebrat', 'lurcher', 'valkyrie', 'jotun'].map(vehTile).join('')}</div>`
    + `<div class="shop-sec">FORTIFICATIONS</div>`
    + `<div class="shop-grid">${fortTile('wall', 'wall', 'WALL')}${fortTile('bastion', 'bastion', 'BASTION')}${fortTile('armed', 'tower', 'GUN TOWER')}</div>`
    + `<div class="bp-hint" id="bp-hint"></div>`;
  document.body.appendChild(panel);

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
  orderRepair: (team = PLAYER_TEAM) => orderRepair(team),      // force a repair for a team (debug/testing)
  repairStatus: () => { const pool = (t) => ({ parked: motorPool[t].filter(s => s.state === 'parked').length, deployed: motorPool[t].filter(s => s.state === 'deployed').length, lost: motorPool[t].filter(s => s.state === 'lost').length }); return { on: repairsOn, jobs: repairJobs.map(j => ({ team: j.team, state: j.state, gun: j.gun, progress: +j.progress.toFixed(1), pathLen: j.path ? j.path.length : 0, jeepDead: j.jeepDest.dead, jx: +j.jx.toFixed(1), jz: +j.jz.toFixed(1), jy: +j.jeep.position.y.toFixed(2) })), jeeps: { red: pool('red'), blue: pool('blue') }, scrap: { ...teamScrap }, cd: { red: +(_repairCd.red || 0).toFixed(1), blue: +(_repairCd.blue || 0).toFixed(1) } }; },
  woundTower: (team, frac = 0.4) => { const h = findWoundedTowerAny(team); if (h) h.wall.body.damage(h.wall.maxHp * (1 - frac)); return !!h; },  // debug: bang up a tower to test repair
  killTowerGun: (team) => { const h = findWoundedTowerAny(team); if (h) h.wall.turretDest.damage(1e9); return !!h; },   // debug: shoot a tower's gun off (test gun purchase)
  destroyTower: (team) => { const h = findWoundedTowerAny(team); if (h) h.wall.body.damage(1e9); return !!h; },         // debug: flatten a tower (test rubble rebuild)
  grantScrap: (team, n = 10) => { teamScrap[team] = (teamScrap[team] || 0) + n; updateScrapHud(); return teamScrap[team]; },   // debug: bank scrap for a team
  repairStats: () => JSON.parse(JSON.stringify(repairStats)),   // cumulative per-match repair telemetry (sorties/heals/guns/jeep fates)
  // Multi-unit slots (elevator = one fielded unit)
  setUnitCap: (n) => { aiUnitCap = n == null ? null : Math.max(1, n | 0); return aiUnitCap; },   // A/B: force the per-team unit cap (null = back to counting elevators)
  unitCap: (i = 0) => { const c = commanders[i]; return c ? c.unitCap() : null; },
  slots: (i = 0) => { const c = commanders[i]; return c ? c._slots.map(s => ({ type: s.unit ? s.unit.type : null, dead: s.unit ? !!s.unit.dead : null, respawnT: +s.respawnT.toFixed(1), rising: s._rising, recalling: s._recalling, state: s._dbg ? s._dbg.state : null, px: s._dbg ? s._dbg.px : null, pz: s._dbg ? s._dbg.pz : null, card: s.strategy ? (s.strategy.constructor.name || '') : null, step: s.strategy ? s.strategy.step : null })) : null; },   // debug: per-slot fielded unit + its role card
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
  look: (x, z, dist, pitch) => { orbit.target.set(x, 0, z); orbit.dist = dist; if (pitch != null) orbit.pitch = pitch; updateCamera(); },
  get foliage() { return foliage; },
  get roadNet() { return roadNet; },
  get vehicles() { return vehicles; },
  get elevators() { return elevators; },
  get submarines() { return activeSub ? [activeSub] : []; },        // debug: the on-demand sub (0 or 1)
  deepDangerR: () => DEEP_DANGER_R,                             // debug: radius past which subs patrol
  setSubs: (v) => { subsOn = !!v; return subsOn; },            // A/B: enable/disable the deep-water sub hazard
  get player() { return player; },
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
      updateResupplies(dt); updateScrap(dt); updateGibs(dt); updateWallTurrets(dt); updateLock(dt);
      if (soldiers) soldiers.update(dt, combatants);
      updateGadgets(dt);
      updateRepairs(dt);
      updateSubmarines(dt);
    }
  },
  blockedAt: (x, z) => blockedAt(x, z),
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
  setBreachCommit: (v) => { aiBreachCommit = !!v; return aiBreachCommit; },   // A/B: siegers latch one wall + push in vs orbit-and-spray
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
  // Headless targeting hook: where would the AI aim to lead this moving enemy? (jitter 0 → deterministic)
  leadAim: (sx, sy, sz, ex, ez, vx, vz, soundIndex) => { const p = leadAim({ x: sx, y: sy, z: sz }, { x: ex, y: 0, z: ez, vx, vz }, soundIndex, 0); return { x: p.x, y: p.y, z: p.z }; },
  returnToGarage: () => returnToGarage(),
  get flagsCaptured() { return flagsCaptured; },
  tickTurrets: (dt = 0.1) => updateWallTurrets(dt),
  get islandBound() { return islandBound; },
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
const NAV_ASTAR_STATES = new Set(['exit', 'advance', 'pursue', 'retreat', 'resupply', 'assault']);
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
    // FLOATING LABEL: nav method (A* vs direct), state, stuck reason, latest log line.
    const px = v.holder.position.x, pz = v.holder.position.z, flyer = v._move.ignoreWalls;
    const combat = d && (d.state === 'engage' || d.state === 'suppress');
    let method, mColor;
    if (usingAstar) { method = `A* route · ${Math.max(0, nav.path.length - Math.min(nav.idx, nav.path.length))} wp left`; mColor = '#8fffa8'; }
    else if (combat) { method = `COMBAT · ${d.state === 'suppress' ? 'holding range' : 'engaging'}`; mColor = '#ff9d6a'; }   // steering at the enemy/turret, not navigating
    else if (flyer) { method = 'DIRECT · flies over'; mColor = '#8fd0ff'; }
    else { method = 'DIRECT · no A* route'; mColor = '#ffcf6a'; }   // amber: grounder beelining, A* gave nothing
    const lines = [{ text: `${v.type.toUpperCase()} · ${d ? d.state : '?'}${d && d.gd != null ? ' · ' + d.gd + 'u to go' : ''}`, color: col.getStyle(), size: 34, bold: true },
                   { text: method, color: mColor, size: 30 }];
    // CONTACT LINE — what the unit is DETECTING right now: ⚠ a rival vehicle in sight (with
    // type + distance), ◎ an enemy turret sensed in range, ♪ a heard-but-unseen contact.
    if (d && (d.foeD != null || d.turD != null || d.heard)) {
      const parts = [];
      if (d.foeD != null) parts.push(`⚠ ${d.foeT} ${d.foeD}u`);
      if (d.turD != null) parts.push(`◎ turret ${d.turD}u`);
      if (d.heard && d.foeD == null) parts.push('♪ hears trouble');
      lines.push({ text: parts.join(' · '), color: d.foeD != null ? '#ff5f4a' : '#ffd24a', size: 28, bold: d.foeD != null });
    }
    if (d && d.stuck) lines.push({ text: `STUCK ${d.stuck}s${d.stuckWhy ? ' · ' + d.stuckWhy : ''}`, color: '#ff6a5a', size: 28 });
    let msg = lastAiMsg(cmd.team);
    if (msg) { const c = msg.indexOf(': '); if (c >= 0) msg = msg.slice(c + 2); lines.push({ text: msg, color: 'rgba(210,225,235,0.72)', size: 24, wrap: true }); }
    _drawNavLabel(o.label, lines);
    o.label.sprite.material.opacity = hot ? 1 : 0.5;
    o.label.sprite.position.set(px, map.heightAt(px, pz) + (hot ? 17.5 : 15.5), pz);   // top-anchored sprite: position marks the label's TOP edge
    o.label.sprite.visible = true;
    // RED CONFLICT CELLS: the squares this unit truly can't enter that its heading/beeline hits.
    const conflicts = _navConflictCells(v, d, usingAstar);
    for (let i = 0; i < conflicts.length; i++) {
      const cm = _navCell(o, i), cc = conflicts[i];
      cm.position.set(cc.x, map.heightAt(cc.x, cc.z) + 0.4, cc.z);
      cm.material.opacity = hot ? 0.5 : 0.22;
      cm.visible = true;
    }
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
  for (let i = soundPings.length - 1; i >= 0; i--) {          // decay gun reports (always, so they don't pile up)
    soundPings[i].life -= dt * SND.gunDecay;
    if (soundPings[i].life <= 0) soundPings.splice(i, 1);
  }
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

let _splashHidden = false;
function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(0.05, clock.getDelta());
  const _pfStart = PERF ? performance.now() : 0;
  const fade = document.getElementById('deployfade');
  if (garage && !onField) {
    // FORT PLACEMENT (Scrap Shop): swap to the locked aerial over the player's base and
    // show the hologram instead of the hangar. The field sim stays frozen, same as the
    // garage always is — placing is calm; the construction run after deploy is the risk.
    if (fortPlace) {
      waterT += dt; map.tickWater(waterT);   // keep the water alive so the aerial doesn't read as a freeze-frame
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
      waterT += dt; map.tickWater(waterT);   // animate the water-surface ripples
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
      _pfT('turrets', () => updateWallTurrets(dt));  // base corner turrets fire on intruders in range
      updateGates(dt);                       // raise/lower base gates for friendly units in range
      updatePlayerHud();                     // live HUD: fuel drains every frame, not just on events
    }
    updateAiLog();                         // AI decision overlay (renders even while paused)
    updateNavOverlay();                    // ?nav: A* route (grounders) + goal-line (flyers), also while paused
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

  if (PERF) { _pfWork += performance.now() - _pfStart; _pfFrames++; _pfRender(); }
  perfTick++;
  fpsEma += (1 / Math.max(dt, 0.0001) - fpsEma) * 0.08;
  if (perfEl && perfTick % 20 === 0) {
    perfEl.innerHTML =
      `FPS: ${Math.round(fpsEma)}<br>` +
      `MS: ${(dt * 1000).toFixed(1)}<br>` +
      `DRAW: ${renderer.info.render.calls}<br>` +
      `TRIS: ${(renderer.info.render.triangles / 1000).toFixed(1)}K`;
  }
}
updateCamera();
ensureVolumeControl();
animate();
