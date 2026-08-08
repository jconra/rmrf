// Fire.js — short-lived fires on things that blow up.
//
// Jacob's brief: "It would just be cool when a vehicle or fuel supply or diesel supply blows up",
// and one kind for now — "we could just make it simple and keep it all the same". Fuel lasting
// longer than a vehicle is a later refinement, not a launch requirement.
//
// The effect is yomotsu's volumetric fire (see VolumetricFire.js), which is a draw call and a
// buffer upload PER FIRE PER FRAME and cannot be instanced. That is affordable here only because
// the fires are brief, so the count at any moment is small. Measured in lab/fire.html on an
// S24 Ultra — the weakest device in play — at under 0.03ms a fire, so a pool of 8 costs about
// 0.2ms of a 16.7ms frame.
//
// THE POOL IS THE BUDGET. Eight instances, built once, reused forever. Constructing a
// VolumetricFire allocates slice buffers and builds geometry, which is not something to do in the
// middle of a firefight, and a fixed pool means a chain reaction cannot open an unbounded number
// of them. When they are all busy the ninth explosion simply does not get a fire, which is far
// better than a frame spike.
import * as THREE from 'three';
import VolumetricFire from './VolumetricFire.js';

const POOL = 8;
const LIFE = 3.2;          // seconds, whole burn
const GROW = 0.18;         // seconds to reach full size
const HOLD = 0.42;         // fraction of life at full size before it sags away

let pool = [], live = [], scene = null, camera = null, ready = false;

// ── EVERY FIRE ITS OWN ───────────────────────────────────────────────────────
// Out of the box every fire is the SAME fire. VolumetricFire memoises one material in a closure
// and hands it to every instance, so they all share a single `time` uniform — and since the noise
// field scrolls with time, every flame samples the same noise at the same phase, from an
// identically sized box, through an identical profile. Not merely similar: mathematically
// identical, differing only in where it stands. Eight of them read as eight copies of one flame.
//
// Three variations, none touching the shader and none costing anything per frame. Every fire
// already owns its draw call and re-uploads three buffers each frame; this adds uniform VALUES on
// top of that, and three still compiles ONE program because it caches by shader source.
//   PHASE  its own material, so its own clock, then an offset — a different phase into the
//          scrolling noise is a different flame shape at any instant. This is the big one.
//   YAW    the noise is read in the box's own space and the slicing runs against mesh.matrixWorld,
//          so turning the box turns the noise field AND changes which cross-section is cut. Safe
//          at any angle: the profile is already black outside radius 1, so the corners never
//          showed flame.
//   GIRTH  jitter on width and height — some burn tall and thin, others squat.
//
// Seeded rather than Math.random. Fire is drawn, never simulated (the headless harness has no
// document and stands the whole system down), so this cannot reach a match result — but a
// screenshot should still reproduce, and the house rule is that nothing rolls dice unseeded.
let _fseed = 0x9e3779b9;
const frnd = () => ((_fseed = (_fseed * 1664525 + 1013904223) >>> 0) / 4294967296);

// ── textures, generated rather than shipped ──────────────────────────────────
// RMRF has no image files anywhere and it would be a poor trade to start for a gradient and some
// noise. Both are derived from what the shader actually asks for — see lab/fire.html, where the
// two can be compared against the originals side by side.

// A hash table, not a picture: the shader reads .xy as a value and a slope and interpolates
// between them, so only uniform randomness matters. Seeded, so fires look the same every run.
function makeNZW() {
  const N = 128, data = new Uint8Array(N * N * 4);
  let s = 0x2f6e2b1;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < N * N; i++) {
    data[i * 4] = rnd() * 255; data[i * 4 + 1] = rnd() * 255;
    data[i * 4 + 2] = rnd() * 255; data[i * 4 + 3] = 255;
  }
  const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = t.minFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

// Indexed by (radius, height) — a flame cone in cylindrical coordinates. Two things about it are
// not obvious and both were learned by rendering it against the original:
//   it is a HOLLOW SHELL, because the shader accumulates through every slice, so a filled
//     white-hot profile sums to an over-bright blob;
//   it must reach ZERO at the outer edge, because the sampler is ClampToEdge — any alpha left in
//     the last column is what every sample beyond the flame returns, and the fire renders as long
//     horizontal streaks trailing off whatever is burning.
function makeFireProfile() {
  const W = 64, H = 128;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const ctx = c.getContext('2d'), img = ctx.createImageData(W, H);
  const radiusAt = v => Math.sin(Math.PI * Math.pow(Math.min(1, Math.max(0, v)), 0.62)) * 0.94;
  const ramp = (k) => {                       // dim on purpose; additive blending does the rest
    k = Math.min(1, Math.max(0, k));
    if (k > 0.80) return [178, 150, 96];
    if (k > 0.52) { const f = (k - 0.52) / 0.28; return [172, 104 + f * 46, 26 + f * 70]; }
    if (k > 0.24) { const f = (k - 0.24) / 0.28; return [138 + f * 34, 48 + f * 56, 8 + f * 18]; }
    const f = k / 0.24; return [40 + f * 98, 8 + f * 40, 2 + f * 6];
  };
  for (let y = 0; y < H; y++) {
    const v = y / (H - 1), rad = radiusAt(v);
    for (let x = 0; x < W; x++) {
      const u = x / (W - 1), d = rad > 0.001 ? u / rad : 99;
      let a = Math.exp(-Math.pow((d - 0.80) / 0.46, 2));
      a *= 1 - Math.min(1, Math.max(0, (d - 0.95) / 0.45));   // reach zero before the edge
      if (x === W - 1) a = 0;
      a *= 1 - Math.pow(v, 2.3);
      if (v < 0.04) a *= v / 0.04;
      if (v > 0.985) a = 0;
      const col = ramp(a * (1.05 - v * 0.4)), i = (y * W + x) * 4;
      img.data[i] = col[0] * a; img.data[i + 1] = col[1] * a; img.data[i + 2] = col[2] * a;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.magFilter = t.minFilter = THREE.LinearFilter;
  t.colorSpace = THREE.SRGBColorSpace;
  t.flipY = false;                            // v=0 must be the BASE of the flame
  return t;
}

// Headless runs (the tournament harness) have no document and never draw, so the whole thing
// stands down rather than throwing on a canvas that isn't there.
export function initFire(sc, cam) {
  scene = sc; camera = cam; pool = []; live = []; ready = false;
  if (typeof document === 'undefined' || !sc || !cam) return false;
  try {
    VolumetricFire.textures = { nzw: makeNZW(), fireProfile: makeFireProfile() };
    for (let i = 0; i < POOL; i++) {
      const fire = new VolumetricFire(3, 6, 3, 0.5, cam);
      fire.mesh.visible = false;
      fire.mesh.renderOrder = 20;             // additive, drawn after the solid world
      fire.mesh.frustumCulled = false;        // the slice geometry's bounds are rebuilt every frame
      fire.mesh.material = fire.mesh.material.clone();   // its own uniforms; textures stay shared by reference
      scene.add(fire.mesh);
      pool.push({ fire, busy: false, t: 0, scale: 1, phase: 0, jw: 1, jh: 1 });
    }
    ready = true;
  } catch (e) { ready = false; }              // no WebGL / no canvas → fires are simply off
  return ready;
}

// Light something up. `scale` sizes it against a vehicle (1 = a vehicle-sized fire).
export function fireBurst(x, y, z, scale = 1) {
  if (!ready) return false;
  const slot = pool.find(s => !s.busy);
  if (!slot) return false;                    // pool exhausted — deliberately, see the note above
  slot.busy = true; slot.t = 0; slot.scale = scale;
  // RE-ROLLED ON EVERY LIGHT, not once per slot: a pool of eight reused all match would otherwise
  // become the same eight recurring flames, which is the clone problem again wearing a hat.
  slot.phase = frnd() * 40; slot.jw = 0.82 + frnd() * 0.36; slot.jh = 0.85 + frnd() * 0.3;
  // KEEP THE GROUND, NOT THE OFFSET. The volume is a box CENTRED on the mesh, so its base sits
  // half its height below the origin — and the height is animated (grow in, sag out) while this
  // offset was computed once at spawn. Small flame, fixed offset, so during the whole grow and
  // the whole sag it floats above the wreck instead of sitting on it: Jacob's "small and it seems
  // like it is hovering". Remember the ground and re-seat it every frame in drawFire.
  slot.baseY = y;
  slot.fire.mesh.position.set(x, y, z);
  slot.fire.mesh.rotation.set(0, frnd() * Math.PI * 2, 0);
  slot.fire.mesh.visible = true;
  live.push(slot);
  return true;
}

// THE LIFECYCLE TICKS EVEN WHEN NOTHING IS DRAWN. The headless harness steps the world without
// rendering, and if the clock only advanced during a render the pool would fill on the first eight
// explosions of a tournament match and never release. (The same trap the blood marks and crushable
// tents hit — they have to be ticked from both the render loop and stepField.)
export function tickFire(dt) {
  if (!live.length) return;
  for (let i = live.length - 1; i >= 0; i--) {
    const s = live[i];
    s.t += dt;
    if (s.t >= LIFE) { s.busy = false; s.fire.mesh.visible = false; live.splice(i, 1); }
  }
}

// The expensive half — slicing the volume against the camera — only when there is a frame to draw.
export function drawFire(elapsed) {
  if (!ready || !live.length) return;
  for (const s of live) {
    const u = s.t / LIFE;
    const grow = Math.min(1, s.t / GROW);
    const fall = u < HOLD ? 1 : 1 - (u - HOLD) / (1 - HOLD);
    const k = s.scale * grow * Math.pow(Math.max(0, fall), 0.7);
    s.fire.mesh.scale.set(k * s.jw, k * s.jh, k * s.jw);
    // half of the 6-tall box, at THIS frame's size — the base then stays planted at every size
    s.fire.mesh.position.y = s.baseY + 3 * k * s.jh;
    s.fire.update(elapsed + s.phase);   // its own clock — see the note on PHASE above
  }
}

export function fireStatus() {
  return {
    ready, live: live.length, pool: POOL,
    mats: new Set(pool.map(s => s.fire && s.fire.mesh.material.uuid)).size,   // 1 = they are all the same fire
    looks: live.map(s => ({ phase: +s.phase.toFixed(1), yaw: +s.fire.mesh.rotation.y.toFixed(2),
                            jw: +s.jw.toFixed(2), jh: +s.jh.toFixed(2) })),
  };
}
