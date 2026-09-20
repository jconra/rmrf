import * as THREE from 'three';
import { Lurcher }      from './Lurcher.js';
import { Firebrat }     from './Firebrat.js';
import { Valkyrie }     from './Valkyrie.js';
import { Jotun }        from './Jotun.js';
import { SoundManager } from './SoundManager.js';
import { Projectiles }  from './Projectiles.js';
import { updateCamo, camoParams, TEAM_COLORS, getCamoShades } from './CamoTexture.js';

// ── Vehicle metadata ────────────────────────────────────────────────────────

const VEHICLE_DATA = [
  {
    name: 'LURCHER',
    speed: 2, armor: 4, firepower: 4,
    role: 'Six-leg spider chassis. Brutal firepower, all-terrain footing.'
  },
  {
    name: 'FIREBRAT',
    speed: 5, armor: 1, firepower: 2,
    role: 'Lightning-fast scout. Built to capture the flag and run.'
  },
  {
    name: 'VALKYRIE',
    speed: 4, armor: 2, firepower: 3,
    role: 'Ducted-rotor assault craft. Ignores all terrain.'
  },
  {
    name: 'JOTUN',
    speed: 1, armor: 5, firepower: 5,
    role: 'Rolling fortress. Devastating at long range. Nearly indestructible.'
  }
];

function makeBar(value, max = 5) {
  return '▪'.repeat(value) + '▫'.repeat(max - value);
}

// ── Scene setup ──────────────────────────────────────────────────────────────

const container = document.getElementById('canvas-container');

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(container.clientWidth, container.clientHeight);
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a1520);
const projectiles = new Projectiles(scene);
scene.fog = new THREE.FogExp2(0x0a1520, 0.018);

// Lighting — much brighter
const sunLight = new THREE.DirectionalLight(0xffeebb, 4.5);
sunLight.position.set(15, 20, 10);
scene.add(sunLight);

const fillLight = new THREE.DirectionalLight(0x88bbee, 2.2);
fillLight.position.set(-10, 8, -12);
scene.add(fillLight);

const rimLight = new THREE.DirectionalLight(0xaaccff, 1.4);
rimLight.position.set(-4, 6, -14);
scene.add(rimLight);

const ambientLight = new THREE.AmbientLight(0x7a9aaa, 3.8);
scene.add(ambientLight);

const baseLights = [
  { light: sunLight,     base: 4.5 },
  { light: fillLight,    base: 2.2 },
  { light: rimLight,     base: 1.4 },
  { light: ambientLight, base: 3.8 },
];

// Brightness slider
document.getElementById('brightness-slider').addEventListener('input', e => {
  const mul = e.target.value / 100;
  baseLights.forEach(({ light, base }) => { light.intensity = base * mul; });
});

// Ground grid
const grid = new THREE.GridHelper(20, 20, 0x0e2030, 0x0e2030);
grid.position.y = -0.5;
scene.add(grid);

// Vehicle movement state (declared here so updateCamera can reference them)
let vehiclePos   = new THREE.Vector3();
let vehicleAngle = 0;

// Camera
const camera = new THREE.PerspectiveCamera(50, container.clientWidth / container.clientHeight, 0.1, 200);
let camTheta  = 0.4;
let camPhi    = 1.0;
let camRadius = 6.0;

function updateCamera() {
  camera.position.x = vehiclePos.x + Math.sin(camTheta) * Math.sin(camPhi) * camRadius;
  camera.position.y = vehiclePos.y + Math.cos(camPhi) * camRadius;
  camera.position.z = vehiclePos.z + Math.cos(camTheta) * Math.sin(camPhi) * camRadius;
  camera.lookAt(vehiclePos);
}

updateCamera();

// Debug/tooling hook: lets the headless screenshot tool set a fixed camera angle
// (e.g. top-down) so part alignment can be inspected from orthographic-ish views.
window.setCameraView = ({ theta, phi, radius } = {}) => {
  if (theta  != null) camTheta  = theta;
  if (phi    != null) camPhi    = phi;
  if (radius != null) camRadius = radius;
  updateCamera();
};

// ── Vehicles ─────────────────────────────────────────────────────────────────

const VehicleClasses = [Lurcher, Firebrat, Valkyrie, Jotun];
let activeVehicleIndex = 0;
let currentVehicle     = new Lurcher();
scene.add(currentVehicle.group);

// ── Engine sound (procedural synth) ────────────────────────────────────────────
const sound = new SoundManager();
sound.setVehicle(0);
const soundToggle = document.getElementById('sound-toggle');
soundToggle.addEventListener('click', () => {
  const on = sound.toggle();   // first click is the user gesture that unlocks audio
  soundToggle.classList.toggle('active', on);
  soundToggle.textContent = on ? '♪ ENGINE: ON' : '♪ ENGINE: OFF';
});

// ── HUD update ────────────────────────────────────────────────────────────────

function updateHUD(index) {
  const data = VEHICLE_DATA[index];
  document.getElementById('hud-name').textContent       = data.name;
  document.getElementById('stat-speed').textContent     = makeBar(data.speed);
  document.getElementById('stat-armor').textContent     = makeBar(data.armor);
  document.getElementById('stat-firepower').textContent = makeBar(data.firepower);
  document.getElementById('hud-role').textContent       = data.role;
}

// ── Tab switching ─────────────────────────────────────────────────────────────

function switchVehicle(index) {
  if (index === activeVehicleIndex) return;
  scene.remove(currentVehicle.group);
  activeVehicleIndex = index;
  currentVehicle = new VehicleClasses[activeVehicleIndex]();
  scene.add(currentVehicle.group);
  updateHUD(index);
  sound.setVehicle(index);
  projectiles.clear();
  vehiclePos.set(0, 0, 0);
  vehicleAngle = 0;

  // Update tab button states
  document.querySelectorAll('.tab-btn').forEach((btn, i) => {
    btn.classList.toggle('active', i === index);
  });
}

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    switchVehicle(parseInt(btn.dataset.index, 10));
  });
});

// ── Orbit controls ────────────────────────────────────────────────────────────

let isDragging  = false;
let lastMouseX  = 0;
let lastMouseY  = 0;

const canvas = renderer.domElement;

// Tap-to-fire: a press/release that doesn't wander past TAP_SLOP px is a tap (fire);
// anything that moves further was a drag-to-orbit and must NOT fire.
let fireRequested = false;        // consumed once by the render loop
const TAP_SLOP = 10;              // px of allowed wander for it to still count as a tap
let pressX = 0, pressY = 0;       // where the current press began

canvas.addEventListener('mousedown', e => {
  isDragging = true;
  lastMouseX = e.clientX;
  lastMouseY = e.clientY;
  if (e.button === 0) { pressX = e.clientX; pressY = e.clientY; }
});

window.addEventListener('mouseup', e => {
  isDragging = false;
  if (e.button === 0 && Math.hypot(e.clientX - pressX, e.clientY - pressY) <= TAP_SLOP) {
    fireRequested = true;   // left click without a drag = fire
  }
});

window.addEventListener('mousemove', e => {
  if (!isDragging) return;
  const dx = e.clientX - lastMouseX;
  const dy = e.clientY - lastMouseY;
  lastMouseX = e.clientX;
  lastMouseY = e.clientY;

  camTheta -= dx * 0.008;
  camPhi   -= dy * 0.008;
  camPhi    = Math.max(0.15, Math.min(1.45, camPhi));
});

canvas.addEventListener('wheel', e => {
  e.preventDefault();
  camRadius += e.deltaY * 0.01;
  camRadius  = Math.max(2.5, Math.min(12, camRadius));
}, { passive: false });

// Touch support
let lastTouchX = 0;
let lastTouchY = 0;

canvas.addEventListener('touchstart', e => {
  if (e.touches.length === 1) {
    isDragging = true;
    lastTouchX = e.touches[0].clientX;
    lastTouchY = e.touches[0].clientY;
    pressX = e.touches[0].clientX;
    pressY = e.touches[0].clientY;
  }
}, { passive: true });

canvas.addEventListener('touchend', e => {
  isDragging = false;
  // Fire only if the finger lifted near where it landed (a tap, not an orbit drag).
  if (e.touches.length === 0) {
    const t = e.changedTouches[0];
    if (t && Math.hypot(t.clientX - pressX, t.clientY - pressY) <= TAP_SLOP) {
      fireRequested = true;
    }
  }
}, { passive: true });

canvas.addEventListener('touchmove', e => {
  if (!isDragging || e.touches.length !== 1) return;
  const dx = e.touches[0].clientX - lastTouchX;
  const dy = e.touches[0].clientY - lastTouchY;
  lastTouchX = e.touches[0].clientX;
  lastTouchY = e.touches[0].clientY;

  camTheta -= dx * 0.008;
  camPhi   -= dy * 0.008;
  camPhi    = Math.max(0.15, Math.min(1.45, camPhi));
}, { passive: true });

// ── Resize ────────────────────────────────────────────────────────────────────

window.addEventListener('resize', () => {
  const w = container.clientWidth;
  const h = container.clientHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
});

// ── Render loop ───────────────────────────────────────────────────────────────

// ── WASD controls ─────────────────────────────────────────────────────────────

const keys = { w: false, a: false, s: false, d: false };
window.addEventListener('keydown', e => { const k = e.key.toLowerCase(); if (k in keys) keys[k] = true; });
window.addEventListener('keyup',   e => { const k = e.key.toLowerCase(); if (k in keys) keys[k] = false; });

// Fire = a tap/click on the canvas (wired in the mouse + touch handlers above);
// one shot per tap, capped at each vehicle's cadence. (Lurcher, Firebrat, Valkyrie, Jotun.)
const FIRE_INTERVALS = [0.32, 0.11, 1.05, 1.7];   // min seconds between shots
let fireCooldown = 0;
const _muzzleWorld = new THREE.Vector3();   // scratch — muzzle world position at fire
const _fireDir     = new THREE.Vector3();   // scratch — world forward direction
const _gunQuat     = new THREE.Quaternion();// scratch — gun/turret world orientation at fire

// ── Touch joystick → WASD ──────────────────────────────────────────────────────
// On-screen stick that drives the very same `keys` the keyboard does, so all the
// movement logic downstream is unchanged. Uses Pointer Events so it works for touch,
// pen, and (for testing) mouse alike.
const joystick = document.getElementById('touch-joystick');
const knob     = document.getElementById('touch-knob');

if (joystick && knob) {
  const DEADZONE   = 0.32;   // fraction of travel before an axis engages
  const MAX_TRAVEL = 42;     // px the knob can move from centre
  let joyId = null;          // pointerId currently driving the stick

  // Show the stick on any touch-capable device right away; also reveal it the first
  // time a touch-type pointer is seen (covers devices that under-report capability).
  // `window.showJoystick()` forces it on for desktop/mouse testing.
  const reveal = () => joystick.classList.add('visible');
  if (('ontouchstart' in window) || navigator.maxTouchPoints > 0) reveal();
  window.addEventListener('pointerdown', e => { if (e.pointerType === 'touch') reveal(); }, { once: true });
  window.showJoystick = reveal;

  const applyVector = (clientX, clientY) => {
    const rect = joystick.getBoundingClientRect();
    let dx = clientX - (rect.left + rect.width  / 2);
    let dy = clientY - (rect.top  + rect.height / 2);
    const dist = Math.hypot(dx, dy);
    if (dist > MAX_TRAVEL) { dx *= MAX_TRAVEL / dist; dy *= MAX_TRAVEL / dist; }
    knob.style.transform = `translate(${dx}px, ${dy}px)`;

    const nx = dx / MAX_TRAVEL, ny = dy / MAX_TRAVEL;   // -1..1; ny is screen-down positive
    keys.w = ny < -DEADZONE;    // up = forward
    keys.s = ny >  DEADZONE;
    keys.a = nx < -DEADZONE;
    keys.d = nx >  DEADZONE;
  };

  const release = () => {
    joyId = null;
    knob.style.transform = 'translate(0px, 0px)';
    keys.w = keys.a = keys.s = keys.d = false;
  };

  joystick.addEventListener('pointerdown', e => {
    if (joyId !== null) return;
    joyId = e.pointerId;
    joystick.setPointerCapture(e.pointerId);   // keep tracking even if the finger slides off the ring
    applyVector(e.clientX, e.clientY);
    e.preventDefault();
  });
  joystick.addEventListener('pointermove', e => {
    if (e.pointerId !== joyId) return;
    applyVector(e.clientX, e.clientY);
    e.preventDefault();
  });
  const end = e => { if (e.pointerId === joyId) release(); };
  joystick.addEventListener('pointerup',     end);
  joystick.addEventListener('pointercancel', end);
}

// Speed/turn rates per vehicle index: Lurcher, Firebrat, Valkyrie, Jotun
const SPEEDS     = [3.5, 6.0, 5.0, 2.0];
const TURN_RATES = [1.8, 2.5, 2.2, 1.2];

// ── Render loop ───────────────────────────────────────────────────────────────

const clock    = new THREE.Clock();
const perfEl   = document.getElementById('perf');
let   fpsEma   = 60;
let   perfTick = 0;

function animate() {
  requestAnimationFrame(animate);
  const delta = Math.min(Math.max(clock.getDelta(), 0.001), 0.05);

  // WASD movement
  const fwd  = (keys.w ? 1 : 0) - (keys.s ? 1 : 0);
  const turn = (keys.a ? 1 : 0) - (keys.d ? 1 : 0);
  vehicleAngle += turn * TURN_RATES[activeVehicleIndex] * delta;
  vehiclePos.x -= Math.sin(vehicleAngle) * SPEEDS[activeVehicleIndex] * fwd * delta;
  vehiclePos.z -= Math.cos(vehicleAngle) * SPEEDS[activeVehicleIndex] * fwd * delta;

  // Apply position/rotation (vehicle update() handles Y itself)
  currentVehicle.group.position.x = vehiclePos.x;
  currentVehicle.group.position.z = vehiclePos.z;
  currentVehicle.group.rotation.y = vehicleAngle;

  currentVehicle.update(delta, fwd, turn);
  sound.update(fwd, turn);

  // Firing — one shot per tap/click, but no faster than the vehicle's cadence.
  fireCooldown -= delta;
  if (fireRequested) {
    fireRequested = false;            // consume the tap; a shot too soon is simply dropped
    if (fireCooldown <= 0) {
      sound.fireGun();                       // sound starts now (railgun: the ~0.9 s charge plays first)
      const veh = currentVehicle, idx = activeVehicleIndex;
      const discharge = () => {              // the visual "shot": muzzle flash + recoil + projectile
        if (currentVehicle !== veh) return;  // switched vehicles mid-charge → skip
        const muzzle = veh.fire ? veh.fire() : null;
        if (muzzle) {
          veh.group.updateMatrixWorld(true);   // fresh world matrix for the muzzle
          const mpos = muzzle.getWorldPosition(_muzzleWorld);
          // Aim down the gun, not the chassis: take the muzzle's parent (the turret/
          // barrel) world orientation and shoot along its local forward (-Z), so the
          // turret sweep (and any elevation) steers the shot. Fall back to body forward.
          const aim = muzzle.parent || veh.group;
          const dir = _fireDir.set(0, 0, -1).applyQuaternion(aim.getWorldQuaternion(_gunQuat));
          projectiles.spawn(idx, mpos, dir, TEAM_COLORS[camoParams.colorIndex].hex);
        }
      };
      // JOTUN railgun: flash/recoil/projectile fire AFTER the 0.9 s charge, to land on the sound's discharge
      if (idx === 3) setTimeout(discharge, 900);
      else discharge();
      fireCooldown = FIRE_INTERVALS[activeVehicleIndex];
    }
  }
  projectiles.update(delta);

  updateCamera();
  renderer.render(scene, camera);

  perfTick++;
  fpsEma += (1 / delta - fpsEma) * 0.08;
  if (perfTick % 20 === 0) {
    const calls = renderer.info.render.calls;
    const tris  = renderer.info.render.triangles;
    perfEl.innerHTML =
      `FPS: ${Math.round(fpsEma)}<br>` +
      `MS: &nbsp;${(delta * 1000).toFixed(1)}<br>` +
      `DRAW: ${calls}<br>` +
      `TRIS: ${(tris / 1000).toFixed(1)}K`;
  }
}

animate();

// ── Team color controls ───────────────────────────────────────────────────────

function rebuildCurrentVehicle() {
  scene.remove(currentVehicle.group);
  currentVehicle = new VehicleClasses[activeVehicleIndex]();
  scene.add(currentVehicle.group);
  // Keep the vehicle where it is — a color change shouldn't re-center/re-orient it.
  currentVehicle.group.position.x = vehiclePos.x;
  currentVehicle.group.position.z = vehiclePos.z;
  currentVehicle.group.rotation.y = vehicleAngle;
}

function updateSwatches() {
  const shades = getCamoShades();
  document.getElementById('camo-swatches').innerHTML =
    shades.map(s => `<div class="camo-swatch" style="background:${s.hex}"></div>`).join('');
}

function updateCamoCurrent() {
  document.getElementById('camo-current').style.background =
    TEAM_COLORS[camoParams.colorIndex].hex;
}

function buildTeamColorGrid() {
  const grid = document.getElementById('team-color-grid');
  grid.innerHTML = TEAM_COLORS.map((c, i) =>
    `<button class="team-color${i === camoParams.colorIndex ? ' active' : ''}" data-index="${i}" style="background:${c.hex}" title="${c.name}"></button>`
  ).join('');
  grid.querySelectorAll('.team-color').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.index, 10);
      grid.querySelectorAll('.team-color').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      updateCamo({ colorIndex: idx });
      updateCamoCurrent();
      updateSwatches();
      rebuildCurrentVehicle();
    });
  });
}

buildTeamColorGrid();
updateCamoCurrent();
updateSwatches();

// Collapse the team-color palette into a dropdown so it's not always on screen.
const camoPanel = document.getElementById('camo-panel');
document.getElementById('camo-toggle').addEventListener('click', () => {
  camoPanel.classList.toggle('collapsed');
  camoPanel.querySelector('.caret').textContent =
    camoPanel.classList.contains('collapsed') ? '▸' : '▾';
});

document.getElementById('camo-randomize').addEventListener('click', () => {
  updateCamo({ seed: Math.floor(Math.random() * 65536) });
});
