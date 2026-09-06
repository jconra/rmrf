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
import VolumetricFire from './VolumetricFire.js?v=5';

const POOL = 12;
let LIFE = 7.0;            // seconds, whole burn
const GROW = 0.25;         // seconds to reach full size
let HOLD = 0.10;           // fraction of life at full size before it starts going out
// WHEN THE SPOT FIRES GO OUT, against the main flame (Jacob: "is there a control for the timing of
// when the side fires fade versus the middle fire?"). They always died first — a wreck should
// gutter down to one flame rather than all three ending together — but 0.5 + a 0.25 spread was
// hardcoded at the call site with no way to feel a different answer.
let SAT_LIFE = 0.85, SAT_LIFE_VAR = 0.30;   // spot fires outlast most of the main flame, and vary
let OUT_MODE = 'burn';   // 'burn' | 'sink' | 'shrink' — how a flame ends; see drawFire
// HOW A WRECK LIGHTS (Jacob: "it would be awesome if they expanded and the side flames shot out
// from the center ... some explosion effects"). Three parts, all on the birth side of the burn:
//   BIRTH  seconds the expansion takes. The flame punches past full size and settles back, so it
//          arrives with weight instead of easing up from nothing.
//   SHOOT  how much of the way the spot fires TRAVEL from the wreck's centre to their spot. At 1
//          they are thrown out of the explosion; at 0 they simply appear where they belong.
//   FLASH  a brightness punch on the first moments, which is what reads as a detonation.
let BIRTH = 0.40, SHOOT = 1, FLASH = 0;
// A spot fire travels as a small FIREBALL and only opens up once it lands (Jacob). Without this
// it flew out at full size, which reads as three flames sliding apart rather than one wreck
// throwing burning debris. SEED is its size in transit; BLOOM is how long it takes to reach full
// size after arriving.
let SAT_SEED = 0.15, SAT_BLOOM = 2.0;
// DEBRIS — a handful of chunks thrown clear of the blast, which fall and wink out. Geometry, not a
// sprite: they tumble, and the silhouette against the flame is the point.
let DEB_N = 20, DEB_SPEED = 27, DEB_LIFE = 0.25, DEB_GRAV = 26;
// DEB_COLD biases how many chunks are cold plate rather than molten (higher = more black ones).
// DEB_GLOW is the distance over which the fire's light falls off. DEB_HEAT is overall brightness.
let DEB_COLD = 6.0, DEB_GLOW = 9.5, DEB_HEAT = 4.0;
let DISSOLVE = 1;        // fully noise-driven: licks go out at their own pace, never an even dim
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
// ── SMOKE ─────────────────────────────────────────────────────────────────────────────────────
// Instanced camera-facing puffs: ONE draw call for the lot, which is why this is affordable on a
// phone where a second volumetric fire would not be. Billboards are wrong for fire — it has
// churning internal motion and a silhouette a flat card cannot fake, which is why the volumetric
// effect won — but they are right for smoke, which is soft, diffuse, and almost entirely
// silhouette. Nothing here is a picture: the puff texture is generated, like everything else.
//
// Drawn BEFORE the flames (renderOrder 18 against the fire's 20) so the additive fire glows
// through the smoke rather than being greyed out by it, and with depthWrite off so puffs never
// cut each other or the flame — the mistake that made the fire show boxes.
const SMOKE_MAX = 220;
const smoke = [];
let smkMesh = null, smkGeo = null, smkMat = null, smkTex = null, smkAcc = 0, smkAlpha = null;
const _sq = new THREE.Quaternion(), _sv = new THREE.Vector3(), _sm = new THREE.Matrix4(), _sc2 = new THREE.Color();
const _srq = new THREE.Quaternion(), _sax = new THREE.Vector3(0, 0, 1);
const _sd = new THREE.Vector3(), _sright = new THREE.Vector3(), _sup = new THREE.Vector3(), _sdir = new THREE.Vector3();
let SMK_RATE = 24, SMK_RISE = 8.5, SMK_SPREAD = 0.30, SMK_LIFE = 4.2;
let SMK_SIZE = 2.8, SMK_GROW = 1.9, SMK_OPACITY = 0.79, SMK_DARK = 1.0;
// SOOT is the black end of the fire-smoke mix; DARK is its grey end, and the pale trail's base.
// The TRAIL knobs scale a chunk's smoke against the fire's, so the two balance separately.
let SMK_SOOT = 0.99, SMK_TRAIL = 1, SMK_TRAIL_OP = 0.75, SMK_TRAIL_SIZE = 0.70, SMK_TRAIL_LIFE = 3.0;
// Slots kept back for the FIRE's own smoke. Trails are per chunk, so their rate multiplies by
// twenty and they will happily eat the whole pool: measured at 26/chunk there were 121 pale puffs
// and ZERO black ones, because the fire could never get a slot. The wreck's own smoke is the point
// of the effect, so it gets a reserve the trails cannot touch — the same shape as WRECK_RESERVE.
const SMOKE_RESERVE = 70;
// HOW MUCH PUFFS DIFFER FROM EACH OTHER, and how fast one arrives. Both were wrong and together
// they made the black smoke flicker: every puff rolled its own place on a soot(0.06)-to-grey(0.72)
// mix INDEPENDENTLY, so neighbours could be near-black or mid-grey at random, and each reached full
// strength in a tenth of its life. Jacob: "the black smoke rapidly appears and disappears, but it
// is a puffy smoke shape" — the shape was never the problem, the popping was.
// A shared drift (slow, common to all puffs) carries most of the variation now, with only a small
// per-puff jitter on top, so neighbours look related. FADE_IN is a real fraction of the life.
let SMK_MIXVAR = 1.0, SMK_FADEIN = 0.90, SMK_WARMTH = 0;
// How far into a flame's life it keeps making smoke, and how sharply that tails off. At 0.45 a
// flame smokes hard early and is done well before it goes out.
let SMK_STOP = 0.70, SMK_TAPER = 1.4;
// A trail instance is drawn LONG and NARROW along the direction of travel, so a handful of them
// makes a streak instead of a string of circles.
let SMK_TRAIL_WID = 0.45;
// How fast each source loses its climb. Low = keeps rising; high = stalls almost at once.
let SMK_DRAG = 0.18, SMK_TRAIL_DRAG = 2.2;
let _smkDrift = 0;
const perfNow = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
function makeSmokeTex() {
  const N = 64, c = document.createElement('canvas'); c.width = c.height = N;
  const x = c.getContext('2d'), img = x.createImageData(N, N);
  // A soft blob with a little low-frequency wobble on the edge, so a hundred of them do not read
  // as a hundred identical circles. Alpha only; the colour comes from the instance.
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const u = (i / (N - 1)) * 2 - 1, v = (j / (N - 1)) * 2 - 1;
    const r = Math.hypot(u, v), th = Math.atan2(v, u);
    const wob = 1 + 0.16 * Math.sin(th * 3 + 1.1) + 0.10 * Math.sin(th * 5 - 0.4);
    let a = Math.max(0, 1 - Math.pow(r / (0.92 * wob), 1.9));
    a = a * a * (3 - 2 * a);                       // smoothstep — no hard rim
    const k = (j * N + i) * 4;
    img.data[k] = img.data[k + 1] = img.data[k + 2] = 255;
    img.data[k + 3] = Math.round(a * 255);
  }
  x.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.magFilter = t.minFilter = THREE.LinearFilter;
  return t;
}
function initSmoke() {
  if (smkMesh) return;
  smkTex = makeSmokeTex();
  smkGeo = new THREE.PlaneGeometry(1, 1);
  smkMat = new THREE.MeshBasicMaterial({ map: smkTex, transparent: true, depthWrite: false,
                                         opacity: 1, color: 0xffffff });
  smkMat.blending = THREE.NormalBlending;
  // PER-PUFF ALPHA, as a real attribute. The first version folded the fade into the instance COLOUR
  // and let a dying puff go to black — but the texture's alpha is identical for every instance, so
  // a "faded" puff was not transparent at all, it was an opaque BLACK disc painted over the scene.
  // Jacob saw it exactly: the pale smoke rises and looks right, "then it seems like the black smoke
  // starts flashing around it". Colour and opacity are different things and smoke needs both.
  smkMat.onBeforeCompile = (sh) => {
    sh.vertexShader = 'attribute float aAlpha;\nvarying float vAlpha;\n' +
      sh.vertexShader.replace('void main() {', 'void main() {\n  vAlpha = aAlpha;');
    sh.fragmentShader = 'varying float vAlpha;\n' +
      sh.fragmentShader.replace('#include <opaque_fragment>',
        'gl_FragColor = vec4( outgoingLight, diffuseColor.a * vAlpha );');
  };
  smkMesh = new THREE.InstancedMesh(smkGeo, smkMat, SMOKE_MAX);
  smkMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  smkMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(SMOKE_MAX * 3), 3);
  smkMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  smkAlpha = new THREE.InstancedBufferAttribute(new Float32Array(SMOKE_MAX), 1);
  smkAlpha.setUsage(THREE.DynamicDrawUsage);
  smkGeo.setAttribute('aAlpha', smkAlpha);
  smkMesh.frustumCulled = false;
  smkMesh.renderOrder = 18;
  scene.add(smkMesh);
  for (let i = 0; i < SMOKE_MAX; i++) smoke.push({ live: false });
  writeSmoke();
}
function writeSmoke() {
  if (!smkMesh) return;
  for (let i = 0; i < SMOKE_MAX; i++) {
    const q = smoke[i];
    if (!q.live) { _sm.makeScale(0, 0, 0); smkMesh.setMatrixAt(i, _sm); smkAlpha.setX(i, 0); continue; }
    // FACE THE CAMERA, with its own roll so the puffs are not all the same way up.
    if (q.stretch > 0) {
      // A STREAK. Face the camera, but roll so the quad's local Y lies along the direction of
      // travel as seen on screen, then scale it long and narrow. That is what turns a handful of
      // instances into the long thick trails a blast actually throws — a round puff cannot, however
      // many of them you spend.
      _sd.set(q.dx, q.dy, q.dz);
      _sright.set(1, 0, 0).applyQuaternion(camera.quaternion);
      _sup.set(0, 1, 0).applyQuaternion(camera.quaternion);
      const ax = _sd.dot(_sright), ay = _sd.dot(_sup);
      const roll = Math.atan2(ax, ay);                 // screen-space angle of the travel direction
      _sq.copy(camera.quaternion).multiply(_srq.setFromAxisAngle(_sax, -roll));
      _sv.set(q.s * SMK_TRAIL_WID, q.ray ? q.rayLen : q.s * q.stretch, q.s);
      _sm.compose({ x: q.x, y: q.y, z: q.z }, _sq, _sv);
    } else {
      // Camera rotation, then the puff's own roll about the view axis — composed into the
      // quaternion rather than multiplied after, so this allocates nothing per puff per frame.
      _sq.copy(camera.quaternion).multiply(_srq.setFromAxisAngle(_sax, q.roll));
      _sv.set(q.s, q.s, q.s);
      _sm.compose({ x: q.x, y: q.y, z: q.z }, _sq, _sv);
    }
    smkMesh.setMatrixAt(i, _sm);
    smkMesh.instanceColor.setXYZ(i, q.cr, q.cg, q.cb);
    smkAlpha.setX(i, q.a);
  }
  smkMesh.instanceMatrix.needsUpdate = true;
  smkMesh.instanceColor.needsUpdate = true;
  smkAlpha.needsUpdate = true;
}
// TWO SOURCES, ONE POOL (Jacob's design). `tone` 0 = the pale trail a thrown chunk leaves behind,
// 1 = the sooty smoke that boils off a burning fire. Everything else about a puff is identical, so
// they share the pool and the single draw call.
// `dir` (a unit vector) turns a puff into a STREAK stretched along it — how a trail is drawn. A
// round billboard cannot make a long thick trail at any count; it just makes more circles.
function puff(x, y, z, scale, tone = 1, rise = 1, dir = null) {
  // A trail may only use the pool down to the reserve; the fire always has room.
  if (tone < 0.5) {
    let free = 0;
    for (const q2 of smoke) if (!q2.live && ++free >= SMOKE_RESERVE) break;
    if (free < SMOKE_RESERVE) return;
  }
  for (const q of smoke) {
    if (q.live) continue;
    q.live = true; q.t = 0; q.tone = tone;
    // A TRAIL'S LIFE IS ITS OWN, in seconds, not a fraction of the fire smoke's. It was a
    // multiplier, which capped a streak below the fire's own puffs and made "stay for a few
    // seconds" unreachable — the streak is the slowest thing in the effect and needs to outlast
    // the flame's smoke, not be bounded by it.
    q.life = (tone < 0.5 ? SMK_TRAIL_LIFE : SMK_LIFE) * (0.7 + frnd() * 0.6);
    const a = frnd() * Math.PI * 2, r = frnd() * SMK_SPREAD * scale;
    q.x = x + Math.cos(a) * r; q.y = y + 0.5 + frnd() * 0.8; q.z = z + Math.sin(a) * r;
    q.vx = Math.cos(a) * SMK_SPREAD * 0.35 + (frnd() - 0.5) * 0.5;
    q.vz = Math.sin(a) * SMK_SPREAD * 0.35 + (frnd() - 0.5) * 0.5;
    q.vy = SMK_RISE * (0.7 + frnd() * 0.6) * rise;
    q.s0 = SMK_SIZE * scale * (0.6 + frnd() * 0.7) * (tone < 0.5 ? SMK_TRAIL_SIZE : 1);
    q.s = q.s0; q.roll = frnd() * Math.PI * 2; q.spin = (frnd() - 0.5) * 0.7;
    // Mostly the shared drift, plus a little of its own — related to its neighbours, not random.
    q.mix = Math.max(0, Math.min(1, _smkDrift + (frnd() - 0.5) * 2 * SMK_MIXVAR));
    if (dir) { q.dx = dir.x; q.dy = dir.y; q.dz = dir.z; q.stretch = 1; }
    else q.stretch = 0;
    q.ray = false; q.owner = null;
    q.a = 0;
    return;
  }
}
// A RAY: a trail bound to one chunk. It does not rise, drift or grow — the chunk's flight is the
// only thing that changes it, and once the chunk is gone it simply fades where it lies.
function rayPuff(x, y, z, scale) {
  let free = 0;
  for (const q2 of smoke) if (!q2.live && ++free >= SMOKE_RESERVE) break;
  if (free < SMOKE_RESERVE) return null;
  for (let i = 0; i < SMOKE_MAX; i++) {
    const q = smoke[i];
    if (q.live) continue;
    q.live = true; q.t = 0; q.tone = 0; q.ray = true; q.owner = null;
    q.life = SMK_TRAIL_LIFE * (0.7 + frnd() * 0.6);
    q.x = x; q.y = y; q.z = z;
    q.vx = q.vy = q.vz = 0;
    q.s0 = SMK_SIZE * scale * SMK_TRAIL_SIZE; q.s = q.s0;
    q.roll = 0; q.spin = 0; q.stretch = 1; q.rayLen = 0.01;
    q.mix = Math.max(0, Math.min(1, _smkDrift + (frnd() - 0.5) * 2 * SMK_MIXVAR));
    q.a = 0;
    return i;
  }
  return null;
}
function tickSmoke(dt) {
  if (!smkMesh) return;
  // The shared soot/grey drift, wandering slowly. This is what makes a WREATH of smoke read as one
  // column that darkens and lightens over seconds, instead of a swarm of unrelated puffs.
  _smkDrift = 0.5 + 0.5 * Math.sin(perfNow() * 0.00042) * 0.9;
  for (const q of smoke) {
    if (!q.live) continue;
    q.t += dt;
    if (q.t >= q.life) { q.live = false; continue; }
    const k = q.t / q.life;
    // Fire smoke climbs hard and keeps climbing; a trail hangs where it was laid. Separate drag
    // per source, because "rise rapidly" and "stay for a few seconds" are opposite requirements
    // and one constant cannot serve both.
    if (!q.ray) {
      q.vy *= 1 - (q.tone >= 0.5 ? SMK_DRAG : SMK_TRAIL_DRAG) * dt;
      q.x += q.vx * dt; q.y += q.vy * dt; q.z += q.vz * dt;
      q.roll += q.spin * dt;
    }
    // A ray holds its width and lets the chunk decide its length; only fire smoke expands.
    if (!q.ray) q.s = q.s0 * (1 + SMK_GROW * k);
    // Bright and fire-lit at the base, cooling to a flat grey, then fading to nothing. The fade
    // rides in the colour because one shared material cannot hold a per-puff opacity.
    const lit = Math.pow(1 - k, 2.2);
    // ALPHA fades it out; COLOUR only says what shade it is. Keeping those apart IS the fix —
    // folding the fade into the colour is what produced opaque black discs.
    q.a = SMK_OPACITY * Math.sin(Math.min(1, k / SMK_FADEIN) * Math.PI / 2) * Math.pow(1 - k, 1.4)
        * (q.tone < 0.5 ? SMK_TRAIL_OP : 1);
    // A wreck's smoke is not one grey. Fire smoke is a nasty black shot through with medium grey —
    // each puff rolls its own place on that mix and keeps it — while a debris trail is pale. Both
    // pick up the fire's warmth while they are young.
    // SOOT IS "HOW SOOTY", not "the value of the dark end". It read the other way round and the
    // slider therefore worked backwards: Jacob turned it to full expecting black and got pale,
    // because 1.0 meant "dark end sits at white". Now 0 = no soot at all (uniformly pale) and
    // 1 = fully sooty, where a puff's own mix takes it all the way down to black. That is the only
    // arrangement in which the control can actually reach the colour its name promises.
    // THE SHADE IS CHOSEN IN SCREEN TERMS, THEN CONVERTED. The renderer outputs sRGB
    // (main.js sets outputColorSpace), so a value written straight into the instance colour is
    // LINEAR and comes out far lighter than it reads in the source: 0.36 linear displays as 0.63,
    // which is light grey. That is the whole reason soot could sit at full and the column still
    // looked white — the slider was never able to reach a dark colour, whatever it said.
    // So: pick the shade as the value wanted ON SCREEN, then square it into linear (2.2 gamma) on
    // the way out. At full soot a mid-mix puff now lands near 0.10 linear, which displays dark.
    // Soot has to span the WHOLE range or the control still cannot reach the colour it names:
    // with the old curve a mid-mix puff bottomed out around 0.36 on screen, which is dark grey and
    // not black. At full soot the pale level is scaled away entirely and the mix rides what is
    // left, so most puffs land near black and a few stay smoky grey.
    const pale = q.tone >= 0.5 ? SMK_DARK : SMK_DARK * 1.15;   // a trail is the paler of the two
    const shade = pale * (1 - SMK_SOOT) + pale * SMK_SOOT * (1 - q.mix) * 0.5;
    const base = Math.pow(Math.max(0, shade), 2.2);
    // WARMTH IS A GARNISH, NOT THE COLOUR. It used to add up to +0.45 to a young puff, and since
    // puffs are born constantly the smoke you actually see was dominated by fresh bright ones — so
    // soot could sit at full and the column still read white. Jacob, twice: "I have it on full soot
    // and it all looks white." Scaled right down and given its own control.
    const w = Math.pow(SMK_WARMTH, 2.2) * lit * q.tone;
    _sc2.setRGB(base + w, base + w * 0.53, base + w * 0.24);
    q.cr = _sc2.r; q.cg = _sc2.g; q.cb = _sc2.b;
  }
  writeSmoke();
}
// ── DEBRIS ────────────────────────────────────────────────────────────────────────────────────
// Pooled like the flames are, for the same reason: a kill happens mid-fight and must not allocate.
// One shared geometry and one shared material — they differ only by transform, so they cost a draw
// call each and nothing else. Chunks shrink to nothing at the end of their life rather than fading,
// which avoids transparency sorting against the additive flames entirely.
// Sized against SIMULTANEOUS wrecks, not one. At 20 chunks a burst, a 40-slot pool left the second
// kill inside a half-second with half a burst and a third with none — and a 3v3 exchange kills
// several units at once, which is exactly when the effect matters. Three full bursts fit here.
// It costs nothing to raise: this is one InstancedMesh, so the draw call count does not move and
// the only growth is the transform buffer.
const DEB_MAX = 60;
const deb = [];                 // plain state; the mesh is instanced, so nothing here is a THREE object
let debMesh = null, debGeo = null, debMat = null;
const _dq = new THREE.Quaternion(), _de = new THREE.Euler(), _dv = new THREE.Vector3(), _dm = new THREE.Matrix4();
const _dc = new THREE.Color();
function initDebris() {
  if (debMesh) return;
  debGeo = new THREE.TetrahedronGeometry(0.42);            // angular, reads as a fragment
  debMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0.1,
                                            emissive: 0xffffff, emissiveIntensity: 1 });
  // LIT BY THE FIRE, without a light. A real PointLight per wreck is out of the question — the
  // point-light COUNT is pinned for the whole match because three.js bakes it into every lit
  // shader, and moving it recompiles the world (see updatePadLights in main.js). So the glow is
  // carried in the per-instance colour instead: emissive is multiplied by it, which three does not
  // do out of the box, hence the one-line patch. A chunk that is hot and close to the flame comes
  // out bright; one that has cooled or flown clear goes black and is then lit only by the world.
  debMat.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace(
      'vec3 totalEmissiveRadiance = emissive;',
      'vec3 totalEmissiveRadiance = emissive * vColor;');
  };
  // ONE DRAW CALL for every chunk, instead of one each. This is why per-chunk colour costs nothing:
  // instancing makes the whole effect cheaper than the dozen separate meshes it replaces.
  debMesh = new THREE.InstancedMesh(debGeo, debMat, DEB_MAX);
  debMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  debMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(DEB_MAX * 3), 3);
  debMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  debMesh.frustumCulled = false;                          // they fly further than their origin bounds
  debMesh.renderOrder = 19;                               // solid, just before the additive flames
  scene.add(debMesh);
  for (let i = 0; i < DEB_MAX; i++) deb.push({ live: false });
  writeDebris();
}
// Compose every instance's matrix and colour. Dead ones are scaled to zero rather than removed —
// an InstancedMesh draws a fixed count, so a zero-scale instance is the way to hide one.
function writeDebris() {
  if (!debMesh) return;
  for (let i = 0; i < DEB_MAX; i++) {
    const d = deb[i];
    if (!d.live) { _dm.makeScale(0, 0, 0); debMesh.setMatrixAt(i, _dm); continue; }
    _de.set(d.rx, d.ry, d.rz); _dq.setFromEuler(_de);
    _dv.set(d.s, d.s, d.s);
    _dm.compose({ x: d.x, y: d.y, z: d.z }, _dq, _dv);
    debMesh.setMatrixAt(i, _dm);
    debMesh.instanceColor.setXYZ(i, d.cr, d.cg, d.cb);
  }
  debMesh.instanceMatrix.needsUpdate = true;
  debMesh.instanceColor.needsUpdate = true;
}
function throwDebris(x, y, z, scale) {
  if (!debMesh) return;
  let n = 0;
  for (const d of deb) {
    if (n >= DEB_N) break;
    if (d.live) continue;
    n++;
    const a = frnd() * Math.PI * 2, up = 0.55 + frnd() * 0.85;
    const sp = DEB_SPEED * (0.55 + frnd() * 0.9) * scale;
    d.live = true; d.t = 0; d.life = DEB_LIFE * (0.7 + frnd() * 0.6);
    d.x = x + (frnd() - 0.5) * 0.6; d.y = y + 0.4; d.z = z + (frnd() - 0.5) * 0.6;
    d.ox = x; d.oy = y; d.oz = z;                          // the fire it was thrown from
    d.vx = Math.cos(a) * sp; d.vy = up * sp; d.vz = Math.sin(a) * sp;
    d.rx = frnd() * 6.28; d.ry = frnd() * 6.28; d.rz = frnd() * 6.28;
    d.sx = (frnd() - 0.5) * 14; d.sy = (frnd() - 0.5) * 14; d.sz = (frnd() - 0.5) * 14;
    d.s0 = scale * (0.5 + frnd() * 0.9); d.s = d.s0; d.trail = null; d.puffAcc = 0;
    // HOW MOLTEN THIS ONE IS. Most chunks are cold hull plate and stay dark; a few came out of the
    // fire itself and glow. Mixing the two is what stops a burst reading as uniform confetti.
    d.hot = Math.pow(frnd(), DEB_COLD);
    d.cr = d.cg = d.cb = 0;
  }
}
function tickDebris(dt) {
  if (!debMesh) return;
  let any = false;
  for (const d of deb) {
    if (!d.live) continue;
    any = true;
    d.t += dt;
    // The ray is CUT LOOSE when its chunk dies — it stops growing and just fades where it is.
    if (d.t >= d.life) { d.live = false;
      if (d.trail != null) { const q = smoke[d.trail]; if (q) q.owner = null; d.trail = null; }
      continue; }
    d.vy -= DEB_GRAV * dt;
    d.x += d.vx * dt; d.y += d.vy * dt; d.z += d.vz * dt;
    d.rx += d.sx * dt; d.ry += d.sy * dt; d.rz += d.sz * dt;
    const k = d.t / d.life;
    // IT LEAVES A TRAIL. The chunks thrown by the blast draw pale smoke behind them which rises and
    // fades, while the fires underneath boil off the black. Emitted along the FLIGHT rather than at
    // the launch point so the trail follows the arc, and thinned over the chunk's life so it reads
    // as a streak behind a fast chunk rather than a cloud around a dying one.
    // ONE RAY PER CHUNK, anchored at the blast. Jacob: "each one should have one end of the shape
    // at the center of the explosion and the other end directly away from it." Emitting a stream of
    // little streaks along the flight gave the opposite — a scatter of unrelated marks drifting
    // above the wreck. A ray instead: it lives at the MIDPOINT between the origin and the chunk,
    // points along that line, and is exactly as long as the chunk has travelled. It grows only
    // because the chunk is still flying, never on its own, and it does not drift.
    // BIND IT TO THE CHUNK. rayPuff cannot set the owner itself (it does not know which chunk asked)
    // and the check below is `q.owner === d`, so without this every chunk dropped its ray on the
    // very next line and allocated a fresh one EVERY FRAME: 149 rays instead of 20, all of them
    // pale, which also drowned the fire's own dark smoke in the pool.
    if (d.trail == null && SMK_TRAIL > 0) {
      d.trail = rayPuff(d.ox, d.oy, d.oz, d.s0);
      if (d.trail != null) smoke[d.trail].owner = d;
    }
    if (d.trail != null) {
      const q = smoke[d.trail];
      if (q && q.live && q.owner === d) {
        const ex = d.x - d.ox, ey = d.y - d.oy, ez = d.z - d.oz;
        const len = Math.hypot(ex, ey, ez) || 0.001;
        q.x = d.ox + ex * 0.5; q.y = d.oy + ey * 0.5; q.z = d.oz + ez * 0.5;
        q.dx = ex / len; q.dy = ey / len; q.dz = ez / len;
        q.rayLen = len;
      } else d.trail = null;
    }
    // GONE, not faded: shrink over the last third so a chunk winks out without needing to sort
    // against the additive flames.
    d.s = d.s0 * (k < 0.66 ? 1 : 1 - (k - 0.66) / 0.34);
    // COOL DOWN, AND DIM WITH DISTANCE FROM THE FIRE. Both terms matter: a chunk fades from
    // white-hot through ember to black over its own life, and separately loses the flame's light
    // as it flies clear. Together they read as debris genuinely lit by the fire it came out of.
    const cool = Math.pow(1 - k, 1.7) * d.hot;
    const dist = Math.hypot(d.x - d.ox, d.y - d.oy, d.z - d.oz);
    const near = 1 / (1 + Math.pow(dist / Math.max(0.001, DEB_GLOW), 2));
    const g = cool * (0.35 + 0.65 * near) * DEB_HEAT;
    _dc.setRGB(1, 0.42, 0.13).multiplyScalar(g);           // ember, scaled by how hot it still is
    d.cr = Math.min(4, _dc.r); d.cg = Math.min(4, _dc.g); d.cb = Math.min(4, _dc.b);
  }
  if (any || debMesh.userData.dirty !== false) { writeDebris(); debMesh.userData.dirty = any; }
}
export function initFire(sc, cam) {
  scene = sc; camera = cam; pool = []; live = []; ready = false;
  if (typeof document === 'undefined' || !sc || !cam) return false;
  try {
    VolumetricFire.textures = { nzw: makeNZW(), fireProfile: makeFireProfile() };
  initDebris();
  initSmoke();
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
export function fireBurst(x, y, z, scale = 1, lifeMul = 1, from = null) {
  if (!ready) return false;
  const slot = pool.find(s => !s.busy);
  if (!slot) return false;                    // pool exhausted — deliberately, see the note above
  slot.busy = true; slot.t = 0; slot.scale = scale; slot.life = LIFE * lifeMul; slot.smkAcc = 0;
  // Where it flies out FROM, if anywhere. Held with the destination so drawFire can walk between
  // them during the birth window; null means it is lit where it stands.
  slot.from = from ? { x: from.x, z: from.z } : null;
  slot.to = { x, z };
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
  throwDebris(x, y, z, scale);                // chunks off the blast, before anything else moves
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
    const sc = scale * SAT_SCALE;
    // Space against the VISIBLE girth, not the true one. A buried flame only shows its upper
    // part, so charging the full radius here would fling the satellites out to arm's length and
    // the wreck would read as three separate fires instead of one burning machine.
    const d = r0 + fireRadius(sc, JW_MAX) * SAT_SPREAD + WRECK_GAP;
    const a = base + i * Math.PI + (frnd() - 0.5) * 0.9;        // opposite sides, loosely
    const sx = x + Math.cos(a) * d, sz = z + Math.sin(a) * d;
    let sy = groundAt ? groundAt(sx, sz) : y;
    // An AIR kill (a Valkyrie shot down before it falls) leaves the terrain far below the wreck;
    // seating the spot fires on the ground there would strand them under a fire hanging in the sky.
    if (Math.abs(sy - y) > 4) sy = y;
    // …thrown from the wreck's own centre, so the pair burst outward as it lights.
    if (fireBurst(sx, sy, sz, sc, SAT_LIFE + frnd() * SAT_LIFE_VAR, { x, z })) n++;
  }
  return n;
}

// THE LIFECYCLE TICKS EVEN WHEN NOTHING IS DRAWN. The headless harness steps the world without
// rendering, and if the clock only advanced during a render the pool would fill on the first eight
// explosions of a tournament match and never release. (The same trap the blood marks and crushable
// tents hit — they have to be ticked from both the render loop and stepField.)
export function tickFire(dt) {
  tickDebris(dt);            // runs even with no flames left — chunks outlive a short burn
  tickSmoke(dt);             // …and so does smoke, which drifts on after the flame is out
  // SMOKE COMES OFF A BURNING FIRE, continuously, not once at ignition. Rate is per second across
  // the whole wreck, so it does not triple just because a wreck has three flames.
  // A DYING FIRE STOPS SMOKING (Jacob: "the smoke is still being generated too heavily when the
  // fires are going out — they need to stop generating the smoke sooner"). Emission used to be a
  // flat rate for as long as ANY flame was alive, which with HOLD at 0.10 means a wreck spends
  // ninety percent of its burn guttering out while still pumping smoke at full strength. Now each
  // flame carries its own budget, weighted by how much life it has left, and cuts out entirely
  // past SMK_STOP — so the column thins and stops while the embers finish, instead of ending on a
  // cliff when the last flame expires.
  if (SMK_RATE > 0) {
    for (const s2 of live) {
      if (!s2.fire || !s2.fire.mesh) continue;
      const u = s2.t / s2.life;
      if (u >= SMK_STOP) continue;                       // past its smoking phase — embers only
      const w = Math.pow(1 - u / SMK_STOP, SMK_TAPER);   // full early, easing to nothing at STOP
      s2.smkAcc = (s2.smkAcc || 0) + (SMK_RATE / live.length) * w * dt;
      while (s2.smkAcc >= 1) {
        s2.smkAcc -= 1;
        const p2 = s2.fire.mesh.position;
        puff(p2.x, s2.baseY, p2.z, s2.scale || 1);
      }
    }
  }
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
  return q == null ? -0.76 : Math.max(-1.2, Math.min(1.2, +q || 0)); })();

// SPOT-FIRE SHAPE. Query-string overridable like LEAN, though the sliders in lab/fire.html are the
// real way in now — these values came from there.
//   ?firesat=    spot fire size against the main flame
//   ?firespread= how far out to place it, against its own radius
const _fq_num = (k, dflt, lo, hi) => {
  const q = new URLSearchParams(location.search).get(k);
  return q == null ? dflt : Math.max(lo, Math.min(hi, +q || 0));
};
let SAT_SCALE  = _fq_num('firesat', 0.55, 0.2, 1.5);
let SAT_SPREAD = _fq_num('firespread', 1.0, 0.2, 1.5);
let LEAN_LIVE = null;   // set by setFireLook; null = use the LEAN constant from the query string
const ENV = new THREE.Vector2(0.99, 0.12);   // radial / bottom fade starts — see setFireLook

// LIVE TUNING (Jacob, 2026-09-05: "adjust the fires in the fire lab with range inputs — it's too
// difficult to do with url parameters"). Every one of these was query-string only, which meant a
// reload per guess and no way to feel the difference between two nearby values. Sliders need to
// move them on a running scene, so they are `let` and this is the one door in. Partial objects are
// fine — pass only what you are changing.
export function setFireLook(o = {}) {
  const c = (v, lo, hi, cur) => (v == null ? cur : Math.max(lo, Math.min(hi, +v || 0)));
  // EDGE ENVELOPE — where each slice starts fading to nothing, so its clipped polygon edge cannot
  // show as a brightness step (Jacob: "making the fire fade out in the bottom might reduce some of
  // the lines at the bottom of each slice" — it does, and the same argument applies to the rim and
  // the top). Lives on every pooled material because each fire owns its uniforms after cloning.
  if (o.envR != null || o.envBot != null) {
    ENV.set(c(o.envR, 0.3, 1, ENV.x), c(o.envBot, 0, 0.6, ENV.y));
    for (const s2 of pool) {
      const u = s2.fire && s2.fire.mesh && s2.fire.mesh.material && s2.fire.mesh.material.uniforms;
      if (u && u.envFade) u.envFade.value.copy(ENV);
    }
  }
  SAT_SCALE  = c(o.sat,      0.2, 1.5, SAT_SCALE);
  SAT_SPREAD = c(o.spread,   0.2, 1.5, SAT_SPREAD);
  // NEGATIVE IS ALLOWED (Jacob asked for below zero): a positive lean tips the top toward the
  // camera, so a negative one tips it away — worth being able to try, even though the core fill
  // below is the honest fix for the ring.
  if (o.lean != null) LEAN_LIVE = c(o.lean, -1.2, 1.2, LEAN_LIVE == null ? LEAN : LEAN_LIVE);
  LIFE     = c(o.life,    1.5, 16,  LIFE);
  HOLD     = c(o.hold,    0.1, 0.95, HOLD);
  SAT_LIFE = c(o.satLife, 0.15, 1.3, SAT_LIFE);
  SAT_LIFE_VAR = c(o.satLifeVar, 0, 0.6, SAT_LIFE_VAR);
  if (o.outMode && ['burn','sink','shrink'].includes(o.outMode)) OUT_MODE = o.outMode;
  DISSOLVE = c(o.dissolve, 0, 1, DISSOLVE);
  BIRTH = c(o.birth, 0, 1.5, BIRTH);
  SAT_SEED  = c(o.satSeed,  0.05, 1, SAT_SEED);
  SAT_BLOOM = c(o.satBloom, 0,    2, SAT_BLOOM);
  DEB_N     = Math.round(c(o.debN,     0, 40, DEB_N));
  DEB_SPEED = c(o.debSpeed, 0, 40, DEB_SPEED);
  DEB_LIFE  = c(o.debLife,  0.2, 4, DEB_LIFE);
  DEB_COLD  = c(o.debCold,  0.2, 6, DEB_COLD);
  DEB_GLOW  = c(o.debGlow,  0.5, 30, DEB_GLOW);
  DEB_HEAT  = c(o.debHeat,  0, 4, DEB_HEAT);
  SMK_RATE    = c(o.smkRate,    0, 60, SMK_RATE);
  SMK_RISE    = c(o.smkRise,    0, 12, SMK_RISE);
  SMK_SPREAD  = c(o.smkSpread,  0, 8,  SMK_SPREAD);
  SMK_LIFE    = c(o.smkLife,    0.3, 8, SMK_LIFE);
  SMK_SIZE    = c(o.smkSize,    0.3, 10, SMK_SIZE);
  SMK_GROW    = c(o.smkGrow,    0, 6,  SMK_GROW);
  SMK_OPACITY = c(o.smkOpacity, 0, 1,  SMK_OPACITY);
  SMK_DARK    = c(o.smkDark,    0, 1,  SMK_DARK);
  SMK_SOOT       = c(o.smkSoot,      0, 1,   SMK_SOOT);
  SMK_TRAIL      = c(o.smkTrail,     0, 80,  SMK_TRAIL);
  SMK_TRAIL_OP   = c(o.smkTrailOp,   0, 2,   SMK_TRAIL_OP);
  SMK_TRAIL_SIZE = c(o.smkTrailSize, 0.1, 2, SMK_TRAIL_SIZE);
  SMK_TRAIL_LIFE = c(o.smkTrailLife, 0.3, 8, SMK_TRAIL_LIFE);   // SECONDS, not a multiplier
  SMK_MIXVAR     = c(o.smkMixVar,    0, 1,   SMK_MIXVAR);
  SMK_FADEIN     = c(o.smkFadeIn,    0.02, 0.9, SMK_FADEIN);
  SMK_WARMTH     = c(o.smkWarmth,    0, 1,   SMK_WARMTH);
  SMK_STOP       = c(o.smkStop,      0.05, 1, SMK_STOP);
  SMK_TAPER      = c(o.smkTaper,     0.2, 4,  SMK_TAPER);
  SMK_TRAIL_WID  = c(o.smkTrailWid,  0.1, 2, SMK_TRAIL_WID);
  SMK_DRAG       = c(o.smkDrag,      0, 4,   SMK_DRAG);
  SMK_TRAIL_DRAG = c(o.smkTrailDrag, 0, 8,   SMK_TRAIL_DRAG);
  SHOOT = c(o.shoot, 0, 1, SHOOT);
  FLASH = c(o.flash, 0, 5, FLASH);
  return getFireLook();
}
// THE EXPORT'S SOURCE OF TRUTH. The lab writes pasteable defaults from this map rather than from
// a hand-written template — the template had already shipped a look with half its values missing
// twice, because every new parameter has to be remembered in two places and eventually is not.
// Anything added to getFireLook and listed here is exported automatically.
export const FIRE_KEYS = [
  ['sat','SAT_SCALE'], ['spread','SAT_SPREAD'], ['life','LIFE'], ['hold','HOLD'],
  ['satLife','SAT_LIFE'], ['satLifeVar','SAT_LIFE_VAR'], ['dissolve','DISSOLVE'],
  ['birth','BIRTH'], ['shoot','SHOOT'], ['flash','FLASH'],
  ['satSeed','SAT_SEED'], ['satBloom','SAT_BLOOM'],
  ['debN','DEB_N'], ['debSpeed','DEB_SPEED'], ['debLife','DEB_LIFE'],
  ['debCold','DEB_COLD'], ['debGlow','DEB_GLOW'], ['debHeat','DEB_HEAT'],
  ['smkRate','SMK_RATE'], ['smkRise','SMK_RISE'], ['smkDrag','SMK_DRAG'],
  ['smkSpread','SMK_SPREAD'], ['smkLife','SMK_LIFE'], ['smkSize','SMK_SIZE'],
  ['smkGrow','SMK_GROW'], ['smkOpacity','SMK_OPACITY'], ['smkDark','SMK_DARK'],
  ['smkSoot','SMK_SOOT'], ['smkWarmth','SMK_WARMTH'], ['smkMixVar','SMK_MIXVAR'],
  ['smkFadeIn','SMK_FADEIN'], ['smkStop','SMK_STOP'], ['smkTaper','SMK_TAPER'],
  ['smkTrail','SMK_TRAIL'], ['smkTrailOp','SMK_TRAIL_OP'], ['smkTrailSize','SMK_TRAIL_SIZE'],
  ['smkTrailLife','SMK_TRAIL_LIFE'],
  ['smkTrailWid','SMK_TRAIL_WID'], ['smkTrailDrag','SMK_TRAIL_DRAG'],
];
export function getFireLook() {
  return { sat: SAT_SCALE, spread: SAT_SPREAD,
           lean: LEAN_LIVE == null ? LEAN : LEAN_LIVE,
           envR: ENV.x, envBot: ENV.y,
           life: LIFE, hold: HOLD, satLife: SAT_LIFE, satLifeVar: SAT_LIFE_VAR, outMode: OUT_MODE, dissolve: DISSOLVE,
           birth: BIRTH, shoot: SHOOT, flash: FLASH,
           satSeed: SAT_SEED, satBloom: SAT_BLOOM,
           debN: DEB_N, debSpeed: DEB_SPEED, debLife: DEB_LIFE,
           debCold: DEB_COLD, debGlow: DEB_GLOW, debHeat: DEB_HEAT,
           smkRate: SMK_RATE, smkRise: SMK_RISE, smkSpread: SMK_SPREAD, smkLife: SMK_LIFE,
           smkSize: SMK_SIZE, smkGrow: SMK_GROW, smkOpacity: SMK_OPACITY, smkDark: SMK_DARK,
           smkSoot: SMK_SOOT, smkTrail: SMK_TRAIL, smkTrailOp: SMK_TRAIL_OP,
           smkTrailSize: SMK_TRAIL_SIZE, smkTrailLife: SMK_TRAIL_LIFE,
           smkMixVar: SMK_MIXVAR, smkFadeIn: SMK_FADEIN, smkWarmth: SMK_WARMTH,
           smkStop: SMK_STOP, smkTaper: SMK_TAPER,
           smkTrailWid: SMK_TRAIL_WID,
           smkDrag: SMK_DRAG, smkTrailDrag: SMK_TRAIL_DRAG };
}

export function drawFire(elapsed) {
  if (!ready || !live.length) return;
  for (const s of live) {
    const u = s.t / s.life;
    // EXPAND, don't ease in. A back-eased overshoot pushes past full size and settles, which reads
    // as the flame being thrown outward rather than inflated. BIRTH is the whole expansion window;
    // GROW stays the floor so a zero birth is still the old behaviour.
    const bw = Math.max(GROW, BIRTH);
    const b0 = Math.min(1, s.t / bw);
    const back = 1 + 2.2 * Math.pow(1 - b0, 3) - 2.2 * Math.pow(1 - b0, 4);   // ease-out-back, peaks ~1.15
    let grow = BIRTH > GROW ? Math.min(1.35, back) : Math.min(1, s.t / GROW);
    // A THROWN spot fire is a small fireball in transit and only opens up once it lands. Held
    // small for the whole flight, then eased to full over SAT_BLOOM — so the wreck reads as
    // burning debris arriving and catching, rather than three flames sliding apart.
    if (s.from) {
      const bloom = SAT_BLOOM > 0 ? Math.min(1, Math.max(0, (s.t - bw) / SAT_BLOOM)) : 1;
      const e2 = 1 - Math.pow(1 - bloom, 3);
      grow = Math.min(1, s.t / GROW) * (SAT_SEED + (1 - SAT_SEED) * e2);
    }
    // THROWN OUT OF THE CENTRE. A spot fire walks from the wreck's middle to its own spot over the
    // birth window, so the wreck blooms outward instead of three flames appearing at once.
    if (s.from && s.to) {
      const e = 1 - Math.pow(1 - b0, 3);                       // ease-out: fast off the mark
      const k2 = SHOOT * e + (1 - SHOOT);                      // SHOOT 0 = already there
      s.fire.mesh.position.x = s.from.x + (s.to.x - s.from.x) * k2;
      s.fire.mesh.position.z = s.from.z + (s.to.z - s.from.z) * k2;
    }
    // SINK, DON'T SHRINK (Jacob). The tail used to multiply the SCALE by `fall` while pinning the
    // base to baseY, so a dying fire collapsed to a point in mid-air. Now it keeps its size and
    // slides DOWN through the ground instead. depthTest is on for this material, so the terrain
    // clips whatever has dropped below it and it reads as sinking rather than vanishing.
    const fall = u < HOLD ? 0 : (u - HOLD) / (1 - HOLD);   // 0..1 across the tail
    const sink = Math.pow(fall, 0.8);                       // ease, so the last moments linger
    // HOW A FIRE GOES OUT (Jacob, 2026-09-05). Three ways have now been tried on screen:
    //   shrink — the original. The whole flame scales down, width included, and reads as a fire
    //            being sucked into a point. He disliked it.
    //   sink   — slide it under the terrain. Looked right while burning, but the ground clips the
    //            volume, so a hard horizontal line sits where the flame crosses it and TRAVELS UP
    //            through the fire as it descends: "I can easily see lines traveling up through
    //            them". The clip is the artefact, and sinking is what drags it across the flame.
    //   burn   — the default now. Nothing moves and nothing scales: the crown comes down and the
    //            whole thing dims, in the shader. A fire burning down to nothing, and with no
    //            geometry crossing the ground there is no edge to sweep.
    const k = SIZE * s.scale * (OUT_MODE === 'shrink' ? grow * (1 - 0.85 * fall) : grow);
    s.fire.mesh.scale.set(k * s.jw, k * s.jh, k * s.jw);
    const half = 3 * k * s.jh;                              // half of the 6-tall box at this size
    { const u2 = s.fire.mesh.material && s.fire.mesh.material.uniforms;
      if (u2 && u2.dying) u2.dying.value = OUT_MODE === 'burn' ? Math.pow(fall, 0.85) : 0;
      if (u2 && u2.dissolve) u2.dissolve.value = DISSOLVE;
      // The detonation punch: brightest on the first frame, gone by the end of the expansion.
      if (u2 && u2.flash) u2.flash.value = FLASH * Math.pow(1 - b0, 2.2); }
    // BURY, DON'T SHRINK (Jacob, 2026-09-02: "maybe the smaller ones are actually the same size,
    // but just lower — the flames look good when they are sinking into the ground"). A small
    // flame reads as a donut because the camera looks down the column's axis and the volume's
    // radial profile is hollow there; the tail already looks right for exactly the opposite
    // reason — once it slides under the terrain you see only the tapering tip, which reads as
    // flame rather than as a ring. So a satellite keeps its full girth and simply starts part
    // way underground, and the terrain clips the annulus away for its whole life.
    s.fire.mesh.position.y = s.baseY + half - (OUT_MODE === 'sink' ? sink * (half * 2 + 0.5) : 0);
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
      _fq.setFromAxisAngle(_fax, LEAN_LIVE == null ? LEAN : LEAN_LIVE);
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

// Put every burning fire out at once. The lab needs it when switching away from the wreck view —
// otherwise flames from the old view keep burning over the new one and neither can be judged.
export function clearFires() {
  for (const s2 of live) { s2.busy = false; if (s2.fire && s2.fire.mesh) s2.fire.mesh.visible = false; }
  live.length = 0;
  for (const d of deb) d.live = false;
  writeDebris();
  for (const q of smoke) q.live = false;
  writeSmoke();
}
if (typeof window !== 'undefined') window.__FIRE_DBG = () => {
  let live=0, rays=0, trailTone=0, fireTone=0, free=0;
  for (const q of smoke) { if(!q.live){free++;continue;} live++; if(q.ray)rays++; if(q.tone<0.5)trailTone++; else fireTone++; }
  let debLive=0, withTrail=0;
  for (const d of deb) { if(d.live){debLive++; if(d.trail!=null)withTrail++;} }
  return { live, free, rays, trailTone, fireTone, debLive, withTrail, RESERVE: SMOKE_RESERVE, MAX: SMOKE_MAX };
};
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
