// Fire.js — short-lived fires on things that blow up.
//
// Jacob's brief: "It would just be cool when a vehicle or fuel supply or diesel supply blows up",
// and one kind for now — "we could just make it simple and keep it all the same". Fuel lasting
// longer than a vehicle is a later refinement, not a launch requirement.
//
// The effect is yomotsu's volumetric fire (see VolumetricFire.js), which is a draw call and a
// buffer upload PER FIRE PER FRAME and cannot be instanced. That is affordable here only because
// the fires are brief, so the count at any moment is small. Measured in lab/fire.html on an
// S24 Ultra — the weakest device in play — at under 0.03ms a fire, so a pool of 12 costs about
// 0.35ms of a 16.7ms frame.
//
// THE POOL IS THE BUDGET. Twelve instances, built once, reused forever. Constructing a
// VolumetricFire allocates slice buffers and builds geometry, which is not something to do in the
// middle of a firefight, and a fixed pool means a chain reaction cannot open an unbounded number
// of them. When they are all busy the thirteenth explosion simply does not get a fire, which is
// far better than a frame spike.
//
// The pool grew from 8 with LIFE, and for that reason: at a given kill rate, doubling how long a
// fire burns doubles how many are alight at once, and a pool that no longer covers a busy minute
// shows up as wrecks that inexplicably don't burn. Twelve is the only number here that costs
// anything, so it is the first knob to turn back if a phone ever hitches — SIZE is the second,
// since bigger flames are more transparent overdraw even though they are not more draw calls.
import * as THREE from 'three';
import VolumetricFire from './VolumetricFire.js';

const POOL = 12;
const LIFE = 7.0;          // seconds, whole burn
const GROW = 0.25;         // seconds to reach full size
const HOLD = 0.55;         // fraction of life at full size before it sags away
// World scale of a `scale:1` (vehicle-sized) fire. The box is built 3×6×3, and the profile fades
// out toward its top, so the FLAME you see is roughly two-thirds of the box — at 1.0 a burning
// wreck read as a campfire sitting on it. Multiplied into `k` in drawFire so the base-planting
// maths below stays in terms of the mesh's actual current scale.
const SIZE = 1.6;
// Half-width of a fire's box on the ground, in world units, at full growth. The box is 3 wide at
// mesh scale 1, so half of it is 1.5. Slightly generous — the flame profile fades before the box
// edge — which is what you want when it is being used to keep two fires apart.
const fireRadius = (scale, jw) => 1.5 * SIZE * scale * jw;
const JW_MAX = 1.18;   // the widest girth fireBurst can roll; plan spacing against the worst case

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
// `lifeMul` shortens or lengthens this one's burn against LIFE — a spot fire in the debris should
// gutter out well before the main blaze does, rather than the two ending in lockstep.
export function fireBurst(x, y, z, scale = 1, lifeMul = 1) {
  if (!ready) return false;
  const slot = pool.find(s => !s.busy);
  if (!slot) return false;                    // pool exhausted — deliberately, see the note above
  slot.busy = true; slot.t = 0; slot.scale = scale; slot.life = LIFE * lifeMul;
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
  // Keep the per-instance spin ON THE SLOT: drawFire rebuilds the mesh's quaternion every frame to
  // lean the column at the camera, and writing .quaternion discards .rotation — so a yaw that lived
  // only on the mesh would be wiped on the first frame and every fire would face the same way.
  slot.yaw = frnd() * Math.PI * 2;
  slot.fire.mesh.rotation.set(0, slot.yaw, 0);
  slot.fire.mesh.visible = true;
  live.push(slot);
  // Hand back the footprint rather than a bare true: whoever lights the NEXT one needs to know how
  // much room this one takes up (see fireWreck). Still truthy, so existing callers are unaffected.
  return fireRadius(scale, slot.jw);
}

// ── A WRECK IS NOT A CAMPFIRE ─────────────────────────────────────────────────
// One flame on a destroyed vehicle reads as a candle standing on it. A kill gets a main fire plus
// a couple of smaller ones scattered across the debris, which is what a burning machine looks like.
//
// THE MAIN ONE IS GUARANTEED; THE SMALL ONES ARE OPPORTUNISTIC. This is the whole design. The pool
// is fixed and small (see POOL), so a wreck that greedily claimed three slots every time would let
// the first two kills of a 3v3 exchange drain it and leave every later wreck with NOTHING burning
// — far more noticeable than a wreck with fewer spot fires. So a satellite is only lit while
// enough slots remain for somebody else's kill. At a quiet 1v1 that reserve is never in play and
// every wreck gets all three; in a melee the extras quietly stop and each wreck still burns.
const WRECK_SATS = 2;       // extra small fires on a wreck, budget permitting
const WRECK_RESERVE = 4;    // slots kept free for OTHER wrecks before a satellite may be lit
// Breathing space between two flames that are not supposed to be touching.
const WRECK_GAP = 0.7;

export function fireWreck(x, y, z, scale = 1, groundAt = null) {
  const r0 = fireBurst(x, y, z, scale);       // …and how wide it turned out to be
  if (!r0) return 0;                          // no slot at all — nothing else to try
  let n = 1;
  // SPOT FIRES STAND CLEAR OF THE MAIN ONE. Scattering them 1.7-3.4u from the centre put every
  // one of them INSIDE a main fire whose own radius is about 2.4u, and two volumetric flames
  // occupying the same space do not read as a bigger fire — they read as one smeared one, because
  // the slices interleave and the additive blend doubles up through the middle.
  // Place each at (main radius + its own radius + a gap) instead, on alternating sides so the
  // satellites clear each OTHER too. Spacing is computed against the widest girth fireBurst can
  // roll, so the gap holds whatever this particular flame turns out to be.
  const base = frnd() * Math.PI * 2;
  for (let i = 0; i < WRECK_SATS; i++) {
    if (pool.length - live.length - 1 < WRECK_RESERVE) break;   // leave the reserve alone
    const sc = scale * (0.36 + frnd() * 0.22);
    const d = r0 + fireRadius(sc, JW_MAX) + WRECK_GAP;
    const a = base + i * Math.PI + (frnd() - 0.5) * 0.9;        // opposite sides, loosely
    const sx = x + Math.cos(a) * d, sz = z + Math.sin(a) * d;
    let sy = groundAt ? groundAt(sx, sz) : y;
    // An AIR kill (a Valkyrie shot down before it falls) leaves the terrain far below the wreck;
    // seating the spot fires on the ground there would strand them under a fire hanging in the sky.
    if (Math.abs(sy - y) > 4) sy = y;
    if (fireBurst(sx, sy, sz, sc, 0.5 + frnd() * 0.25)) n++;
  }
  return n;
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
    if (s.t >= s.life) { s.busy = false; s.fire.mesh.visible = false; live.splice(i, 1); }
  }
}

// The expensive half — slicing the volume against the camera — only when there is a frame to draw.
// Scratch objects, reused — a Quaternion/Euler/Vector3 per fire per frame would be garbage for
// nothing at 12 fires x 60fps.
const _fq = new THREE.Quaternion();
const _fe = new THREE.Euler();
const _fax = new THREE.Vector3();
// How far the column tips toward the viewer, in radians. 0.30 is ~17deg and is a GUESS — the
// headless rig cannot really judge it, and the person who sees the donut in play is the one who
// should pick it. ?firelean=0.5 to dial it live; ?firelean=0 turns the lean off entirely.
const LEAN = (() => { const q = new URLSearchParams(location.search).get('firelean');
  return q == null ? 0.30 : Math.max(0, Math.min(1.2, +q || 0)); })();

export function drawFire(elapsed) {
  if (!ready || !live.length) return;
  for (const s of live) {
    const u = s.t / s.life;
    const grow = Math.min(1, s.t / GROW);
    // SINK, DON'T SHRINK (Jacob). The tail used to multiply the SCALE by `fall` while pinning the
    // base to baseY, so a dying fire collapsed to a point in mid-air. Now it keeps its size and
    // slides DOWN through the ground instead. depthTest is on for this material, so the terrain
    // clips whatever has dropped below it and it reads as sinking rather than vanishing.
    const fall = u < HOLD ? 0 : (u - HOLD) / (1 - HOLD);   // 0..1 across the tail
    const sink = Math.pow(fall, 0.8);                       // ease, so the last moments linger
    const k = SIZE * s.scale * grow;                        // full size for the whole burn
    s.fire.mesh.scale.set(k * s.jw, k * s.jh, k * s.jw);
    const half = 3 * k * s.jh;                              // half of the 6-tall box at this size
    s.fire.mesh.position.y = s.baseY + half - sink * (half * 2 + 0.5);   // fully under by the end
    // LEAN TOWARD THE VIEWER (Jacob: "they kind of look like a donut"). The volume is a box sliced
    // against the view direction, so a camera looking down the column's axis sees the annulus
    // instead of the side of the flame. Tipping the top toward the camera restores a side-on read.
    // Leaning at where the camera ACTUALLY is — rather than a fixed world tilt — stays correct as
    // the view orbits, and costs nothing: this loop already runs per frame.
    const dx = camera.position.x - s.fire.mesh.position.x;
    const dz = camera.position.z - s.fire.mesh.position.z;
    const len = Math.hypot(dx, dz);
    if (len > 0.001) {
      // Horizontal axis perpendicular to the camera bearing, so the tip goes toward the viewer
      // rather than sideways.
      _fax.set(dz / len, 0, -dx / len);
      _fq.setFromAxisAngle(_fax, LEAN);
      s.fire.mesh.quaternion.setFromEuler(_fe.set(0, s.yaw || 0, 0));
      s.fire.mesh.quaternion.premultiply(_fq);              // lean in WORLD space, after the yaw
    }
    // updateViewVector() derives the slice direction from mesh.matrixWorld, which is otherwise only
    // built at construction — without this refresh the slicing uses last frame's orientation and
    // the lean simply never appears.
    s.fire.mesh.updateMatrixWorld();
    s.fire.update(elapsed + s.phase);   // its own clock — see the note on PHASE above
  }
}

export function fireStatus() {
  return {
    ready, live: live.length, pool: POOL,
    mats: new Set(pool.map(s => s.fire && s.fire.mesh.material.uuid)).size,   // 1 = they are all the same fire
    looks: live.map(s => ({ phase: +s.phase.toFixed(1), yaw: +(s.yaw || 0).toFixed(2),
                            x: +s.fire.mesh.position.x.toFixed(1), z: +s.fire.mesh.position.z.toFixed(1),
                            age: +(s.t / s.life).toFixed(2), y: +s.fire.mesh.position.y.toFixed(2), baseY: +s.baseY.toFixed(2),
                            jw: +s.jw.toFixed(2), jh: +s.jh.toFixed(2) })),
  };
}
