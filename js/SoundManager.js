// SoundManager.js — procedural engine-sound synthesis for the Vehicle Designer.
//
// Pure Web Audio synthesis (no samples). One shared AudioContext, created lazily
// and resumed on a user gesture (the SOUND toggle click). Each vehicle has ONE
// persistent "engine voice" that is started when its tab is active and then
// MODULATED every frame off throttle — never retriggered. Drive with WASD and
// pitch/brightness/volume track the input.
//
// TWO synthesis paths (config field `synth`):
//
//   'osc'  — tonal core: 2 detuned oscs (saw=combustion, square=electric) + a
//            resonant noise band, through a throttle-tracking lowpass, optional
//            vibrato (pitch quiver) and AM (blade-pass / lug tremolo).
//
//   'noise' — PURE NOISE engine (no oscillators). White noise → a low "body"
//            lowpass + a mid resonant bandpass (both sweep with throttle) → a
//            FIRING-RATE pulse (sawtooth LFO on the gain) whose rate climbs with
//            throttle. Idle = discrete chugs; rev = the chugs blur into a buzz.
//            This is the "revving from white noise" trick — see the Jotun.
//
// The JOTUN's railgun shot is NOT the gunsynth makeShot path — it plays the Sound Lab's modular
// "RAIL D" patch via playPatch. patch.js is a VENDORED COPY of sound-lab/patch.js so this app
// stands alone. The Sound Lab is still where these patches are authored — after tuning a preset
// there, re-sync with:  cp ../sound-lab/patch.js js/patch.js  (run from the Sound Lab's parent).

import { playPatch, PATCH_PRESETS } from './patch.js?v=9';

// Each vehicle's engine + gun plays a Sound Lab modular patch (authored in the Sound Lab) by index:
// 0 Lurcher, 1 Firebrat, 2 Valkyrie, 3 Jotun. RPM_RANGE = [idle, max] the driving throttle maps to.
const ENGINE_PATCH = ['LURCHER — ENGINE', 'FIREBRAT — ENGINE', 'VALKYRIE — ENGINE', 'JOTUN — ENGINE'];
const GUN_PATCH    = ['LURCHER — GUN A',  'FIREBRAT — GUN',    'VALKYRIE — ROCKET A', 'JOTUN — RAIL D'];
const RPM_RANGE    = [[0, 1], [0.25, 2], [0, 1], [0, 1]];

// Spatial carry per vehicle SIZE (by soundIndex): bigger engines are louder and
// audible from farther away. refDistance = full-volume radius, maxDistance = the
// range past which it's effectively inaudible, gain = source loudness. ENGINE_ROLLOFF
// (raised 2026-06-23) governs the actual fade — bumped so engines don't carry as far
// (the inverse model keeps them faintly audible out to maxDistance otherwise).
//   0 Lurcher (mid)   1 Firebrat (small)   2 Valkyrie (mid-air)   3 Jotun (huge)
const ENGINE_SPATIAL = [
  { ref: 18, max: 125, gain: 0.95 },
  { ref: 12, max: 78,  gain: 0.60 },
  { ref: 16, max: 112, gain: 0.85 },
  { ref: 26, max: 175, gain: 1.15 },
];
const ENGINE_ROLLOFF = 1.7;       // was 1.3 — steeper so engine drone fades sooner

// Distance muffling (air absorption): a sound loses its highs the farther off it is, so a
// distant Jotun reads as a muffled rumble, not a crisp close-up. Maps 0..1 "farness" to a
// lowpass cutoff, exponential so it sweeps musically. farness 0 = wide open (no muffle).
const MUFFLE_NEAR_HZ = 20000;
function muffleHz(farness, farHz) {
  const t = farness < 0 ? 0 : farness > 1 ? 1 : farness;
  return MUFFLE_NEAR_HZ * Math.pow(farHz / MUFFLE_NEAR_HZ, t);
}
const ENGINE_FAR_HZ = 700;        // a far engine is muffled down to ~700 Hz
const GUN_FAR_HZ    = 850;        // a far gunshot dulls to a thump (~850 Hz), but still carries
const GUN_MUFFLE_DIST = 360;      // gunfire is fully muffled by this range (separate from the 700u carry)

const ENGINE_CONFIGS = [
  // 0 LURCHER — electric SERVO walker. Square wave reads "motor/robot" (hollow,
  // not combustion). Mid register, crisp actuator pulse, faint whine vibrato.
  { synth: 'osc', oscType: 'square', idleFreq: 70, revFreq: 150, detune: 6,
    vibrato: { rate: 5, cents: 9 },
    noiseLevel: 0.10, noiseFreqIdle: 1200, noiseFreqRev: 2200, noiseQ: 1.2,
    filterIdle: 300, filterRev: 600, filterQ: 1.0,
    am: { rateIdle: 20.5, rateRev: 47, depth: 0.61 },   // tuned 2026-06-11: tremolo → firing-pulse "engine" feel
    idleGain: 0.10, revGain: 0.40 },

  // 1 FIREBRAT — turbine / insect WHINE. Air-DOMINANT: noise (0.55) is the main
  // event, shaped by a sharp bandpass (Q 7) sweeping ~1.8→5.2kHz = the whistle.
  // Thin high saw with fast vibrato rides on top for the insect quiver. No tremolo.
  { synth: 'osc', oscType: 'sawtooth', idleFreq: 20, revFreq: 40, detune: 0,
    vibrato: { rate: 7, cents: 26 },
    noiseLevel: 0.9, noiseFreqIdle: 6000, noiseFreqRev: 8000, noiseQ: 4.2,
    filterIdle: 2380, filterRev: 4380, filterQ: 9.9,
    am: { rateIdle: 0, rateRev: 0, depth: 0 },   // tuned 2026-06-11: airy high whistle, resonant lowpass (Q 9.9)
    idleGain: 0.04, revGain: 0.195 },

  // 2 VALKYRIE — ducted-fan THRUM. Strong blade-pass AM (the "wop-wop") over
  // broadband air; AM rate + pitch rise on spool-up.
  { synth: 'osc', oscType: 'sawtooth', idleFreq: 333, revFreq: 1200, detune: 20,
    vibrato: null,
    noiseLevel: 0.85, noiseFreqIdle: 700, noiseFreqRev: 830, noiseQ: 0.1,
    filterIdle: 1090, filterRev: 2070, filterQ: 0.7,
    am: { rateIdle: 11, rateRev: 26, depth: 0.5 },   // tuned 2026-06-11: osc back in under 0.85 noise, AM wop-wop kept
    idleGain: 0.22, revGain: 0.185 },

  // 3 JOTUN — PURE-NOISE diesel. Low "body" lowpass for the rumble + a mid
  // resonant band for grit, gated by a firing-rate sawtooth pulse that sweeps
  // 11→58 Hz. At idle you hear the individual chugs; revving blurs them into a
  // diesel buzz. Zero oscillators — this is all white noise.
  { synth: 'noise',   // tuned 2026-06-11
    bodyFreqIdle: 490, bodyFreqRev: 995, bodyLevel: 1,
    noiseFreqIdle: 3000, noiseFreqRev: 6000, noiseQ: 14, midLevel: 1,
    pulseRateIdle: 20.5, pulseRateRev: 35, pulseDepth: 0.97,
    filterIdle: 2320, filterRev: 6000,
    idleGain: 0.255, revGain: 0.6 },
];

const lerp = (a, b, t) => a + (b - a) * t;

// ── Oscillator-core engine ─────────────────────────────────────────────────────
function makeOscEngine(ctx, noiseBuffer, cfg) {
  let lastT = 0;

  const out = ctx.createGain();
  out.gain.value = cfg.idleGain;

  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = cfg.filterIdle;
  filter.Q.value = cfg.filterQ;

  // Amplitude modulation (blade-pass / lug). am.gain rides a sine LFO.
  const am = ctx.createGain();
  let amLfo = null, amDepth = null;
  if (cfg.am.depth > 0) {
    amLfo = ctx.createOscillator();
    amLfo.type = 'sine';
    amLfo.frequency.value = cfg.am.rateIdle;
    amDepth = ctx.createGain();
    amDepth.gain.value = cfg.am.depth;
    amLfo.connect(amDepth).connect(am.gain);
    amLfo.start();
  }
  am.gain.value = cfg.am.depth > 0 ? 1 - cfg.am.depth : 1;

  // Optional vibrato — LFO on osc detune (cents) for the turbine/insect quiver.
  let vibLfo = null, vibDepth = null;
  if (cfg.vibrato) {
    vibLfo = ctx.createOscillator();
    vibLfo.type = 'sine';
    vibLfo.frequency.value = cfg.vibrato.rate;
    vibDepth = ctx.createGain();
    vibDepth.gain.value = cfg.vibrato.cents;
    vibLfo.connect(vibDepth);
    vibLfo.start();
  }

  // Detuned osc core.
  const oscGain = ctx.createGain();
  const oscs = [];
  for (const sign of [-1, 1]) {
    const o = ctx.createOscillator();
    o.type = cfg.oscType;
    o.frequency.value = cfg.idleFreq;
    o.detune.value = sign * cfg.detune;
    o._sign = sign;
    if (vibDepth) vibDepth.connect(o.detune);
    o.connect(oscGain);
    o.start();
    oscs.push(o);
  }

  // White noise → resonant bandpass (the "air" / grit), centre sweeps w/ throttle.
  const noiseGain = ctx.createGain();
  const noiseBP = ctx.createBiquadFilter();
  noiseBP.type = 'bandpass';
  noiseBP.frequency.value = cfg.noiseFreqIdle;
  noiseBP.Q.value = cfg.noiseQ;
  const noise = ctx.createBufferSource();
  noise.buffer = noiseBuffer;
  noise.loop = true;
  noise.connect(noiseBP).connect(noiseGain);
  noise.start();

  oscGain.connect(filter);
  noiseGain.connect(filter);
  filter.connect(am);
  am.connect(out);

  function apply(t) {
    const now = ctx.currentTime, k = 0.08;
    const f = lerp(cfg.idleFreq, cfg.revFreq, t);
    for (const o of oscs) {
      o.frequency.setTargetAtTime(f, now, k);
      o.detune.setTargetAtTime(o._sign * cfg.detune, now, k);
    }
    oscGain.gain.setTargetAtTime(1 - cfg.noiseLevel, now, k);
    noiseGain.gain.setTargetAtTime(cfg.noiseLevel, now, k);
    noiseBP.frequency.setTargetAtTime(lerp(cfg.noiseFreqIdle, cfg.noiseFreqRev, t), now, k);
    noiseBP.Q.setTargetAtTime(cfg.noiseQ, now, k);
    filter.frequency.setTargetAtTime(lerp(cfg.filterIdle, cfg.filterRev, t), now, k);
    filter.Q.setTargetAtTime(cfg.filterQ, now, k);
    out.gain.setTargetAtTime(lerp(cfg.idleGain, cfg.revGain, t), now, k);
    if (amLfo) {
      amLfo.frequency.setTargetAtTime(lerp(cfg.am.rateIdle, cfg.am.rateRev, t), now, k);
      am.gain.setTargetAtTime(1 - cfg.am.depth, now, k);
      amDepth.gain.setTargetAtTime(cfg.am.depth, now, k);
    }
  }

  function dispose() {
    for (const o of oscs) { try { o.stop(); } catch (e) {} }
    if (amLfo) { try { amLfo.stop(); } catch (e) {} }
    if (vibLfo) { try { vibLfo.stop(); } catch (e) {} }
    try { noise.stop(); } catch (e) {}
    try { out.disconnect(); } catch (e) {}
  }

  return {
    out,
    setThrottle(t) { lastT = t; apply(t); },
    tune() { apply(lastT); },
    dispose,
  };
}

// ── Pure-noise engine (the "revving from white noise" trick) ────────────────────
function makeNoiseEngine(ctx, noiseBuffer, cfg) {
  let lastT = 0;

  const out = ctx.createGain();
  out.gain.value = cfg.idleGain;

  // Master brightness lowpass.
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = cfg.filterIdle;
  filter.Q.value = 0.7;

  // FIRING-RATE pulse: a sawtooth LFO on the gain. Rate sweeps with throttle, so
  // idle = slow discrete chugs, rev = fast chugs that fuse into a buzz.
  const pulse = ctx.createGain();
  pulse.gain.value = 1 - cfg.pulseDepth;
  const pulseLfo = ctx.createOscillator();
  pulseLfo.type = 'sawtooth';
  pulseLfo.frequency.value = cfg.pulseRateIdle;
  const pulseDepth = ctx.createGain();
  pulseDepth.gain.value = cfg.pulseDepth;
  pulseLfo.connect(pulseDepth).connect(pulse.gain);
  pulseLfo.start();

  // One noise source feeding two bands: low "body" rumble + mid resonant grit.
  const noise = ctx.createBufferSource();
  noise.buffer = noiseBuffer;
  noise.loop = true;

  const bodyLP = ctx.createBiquadFilter();
  bodyLP.type = 'lowpass';
  bodyLP.frequency.value = cfg.bodyFreqIdle;
  bodyLP.Q.value = 0.9;
  const bodyGain = ctx.createGain();
  bodyGain.gain.value = cfg.bodyLevel;

  const midBP = ctx.createBiquadFilter();
  midBP.type = 'bandpass';
  midBP.frequency.value = cfg.noiseFreqIdle;
  midBP.Q.value = cfg.noiseQ;
  const midGain = ctx.createGain();
  midGain.gain.value = cfg.midLevel;

  noise.connect(bodyLP).connect(bodyGain).connect(filter);
  noise.connect(midBP).connect(midGain).connect(filter);
  noise.start();

  filter.connect(pulse);
  pulse.connect(out);

  function apply(t) {
    const now = ctx.currentTime, k = 0.08;
    bodyLP.frequency.setTargetAtTime(lerp(cfg.bodyFreqIdle, cfg.bodyFreqRev, t), now, k);
    bodyGain.gain.setTargetAtTime(cfg.bodyLevel, now, k);
    midBP.frequency.setTargetAtTime(lerp(cfg.noiseFreqIdle, cfg.noiseFreqRev, t), now, k);
    midBP.Q.setTargetAtTime(cfg.noiseQ, now, k);
    midGain.gain.setTargetAtTime(cfg.midLevel, now, k);
    pulseLfo.frequency.setTargetAtTime(lerp(cfg.pulseRateIdle, cfg.pulseRateRev, t), now, k);
    pulse.gain.setTargetAtTime(1 - cfg.pulseDepth, now, k);
    pulseDepth.gain.setTargetAtTime(cfg.pulseDepth, now, k);
    filter.frequency.setTargetAtTime(lerp(cfg.filterIdle, cfg.filterRev, t), now, k);
    out.gain.setTargetAtTime(lerp(cfg.idleGain, cfg.revGain, t), now, k);
  }

  function dispose() {
    try { pulseLfo.stop(); } catch (e) {}
    try { noise.stop(); } catch (e) {}
    try { out.disconnect(); } catch (e) {}
  }

  return {
    out,
    setThrottle(t) { lastT = t; apply(t); },
    tune() { apply(lastT); },
    dispose,
  };
}

function makeEngine(ctx, noiseBuffer, cfg) {
  return cfg.synth === 'noise'
    ? makeNoiseEngine(ctx, noiseBuffer, cfg)
    : makeOscEngine(ctx, noiseBuffer, cfg);
}

// ── Gun shots — one-shot synth (per vehicle) ────────────────────────────────────
// Each shot = a fast noise burst (the crack) + an optional pitched tone (the body /
// discharge), both with a near-instant attack and an exponential-ish decay. Built
// fresh per trigger and self-disposed; routed to the SFX bus (independent of the
// engine master, so guns sound whether or not the engine is on).
// Each shot = an instant CRACK (highpassed noise click, the sonic-boom snap) + a
// noise BODY (the report) + a pitched TONE (discharge/body), each with its own fast
// envelope, plus a per-gun REVERB send. crack/tone are always present objects; a
// section with level 0 is simply skipped. This is the gun tuning surface.
const GUN_CONFIGS = [
  // 0 LURCHER — twin autocannon: hard supersonic crack + mid report + low thump.
  { level: 0.95, reverb: 0.25,
    crack: { freq: 3800, Q: 0.6, decay: 0.013, level: 1.2 },
    noise: { type: 'lowpass',  freq: 1500,              Q: 1.0, decay: 0.11, level: 0.7 },
    tone:  { wave: 'square',   f0: 120,  f1: 55,                decay: 0.10, level: 0.45 } },
  // 1 FIREBRAT — light rapid pulse-laser: short bright zap, tiny tick.
  { level: 0.5, reverb: 0.1,
    crack: { freq: 5200, Q: 0.5, decay: 0.006, level: 0.45 },
    noise: { type: 'bandpass', freq: 2800,              Q: 1.6, decay: 0.05, level: 0.55 },
    tone:  { wave: 'sawtooth', f0: 1700, f1: 700,               decay: 0.05, level: 0.30 } },
  // 2 VALKYRIE — missile launch: soft crack + a whoosh that opens up + low thud.
  { level: 0.85, reverb: 0.32,
    crack: { freq: 2400, Q: 0.5, decay: 0.02,  level: 0.5 },
    noise: { type: 'bandpass', freq: 500, freqEnd: 2600, Q: 0.7, decay: 0.4,  level: 1.0 },
    tone:  { wave: 'sine',     f0: 80,   f1: 42,                decay: 0.18, level: 0.5 } },
  // 3 JOTUN — railgun: HUGE supersonic crack + electric discharge collapsing into a
  // booming low tail, drowned in reverb.
  { level: 1.0, reverb: 0.9,
    crack: { freq: 3200, Q: 0.5, decay: 0.022, level: 1.5 },
    noise: { type: 'lowpass',  freq: 2400, freqEnd: 280, Q: 0.9, decay: 0.6,  level: 1.0 },
    tone:  { wave: 'sawtooth', f0: 260,  f1: 36,                decay: 0.5,  level: 0.7 } },
];



// Synthesised reverb impulse: exponentially-decaying stereo noise.
function makeImpulse(ctx, dur, decay) {
  const len = Math.floor(ctx.sampleRate * dur);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
  }
  return buf;
}

function makeShot(ctx, noiseBuffer, dest, reverbInput, cfg) {
  const t0 = ctx.currentTime;
  const bus = ctx.createGain();
  bus.gain.value = cfg.level;
  bus.connect(dest);

  // Reverb send (dry stays on `bus`; a copy feeds the shared convolver).
  if (cfg.reverb > 0 && reverbInput) {
    const send = ctx.createGain();
    send.gain.value = cfg.reverb;
    bus.connect(send);
    send.connect(reverbInput);
  }

  let endT = 0.05;

  // CRACK — instant attack, highpassed noise, near-zero decay (the snap).
  const c = cfg.crack;
  if (c && c.level > 0) {
    const cs = ctx.createBufferSource();
    cs.buffer = noiseBuffer; cs.loop = true;
    cs.playbackRate.value = 1 + Math.random() * 0.12;
    const cf = ctx.createBiquadFilter();
    cf.type = 'highpass'; cf.frequency.value = c.freq; cf.Q.value = c.Q;
    const cg = ctx.createGain();
    cg.gain.setValueAtTime(c.level, t0);
    cg.gain.exponentialRampToValueAtTime(0.0005, t0 + c.decay);
    cs.connect(cf).connect(cg).connect(bus);
    cs.start(t0); cs.stop(t0 + c.decay + 0.05);
    endT = Math.max(endT, c.decay);
  }

  // BODY — the noise report, filter optionally sweeping freq → freqEnd.
  const n = cfg.noise;
  if (n && n.level > 0) {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer; src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = n.type;
    f.frequency.setValueAtTime(n.freq, t0);
    if (n.freqEnd) f.frequency.exponentialRampToValueAtTime(Math.max(40, n.freqEnd), t0 + n.decay);
    f.Q.value = n.Q;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0, t0);
    ng.gain.linearRampToValueAtTime(n.level, t0 + 0.002);
    ng.gain.setTargetAtTime(0, t0 + 0.004, n.decay / 3);
    src.connect(f).connect(ng).connect(bus);
    src.start(t0); src.stop(t0 + n.decay + 0.1);
    endT = Math.max(endT, n.decay);
  }

  // TONE — pitched body/discharge, sweeping f0 → f1.
  const tn = cfg.tone;
  if (tn && tn.level > 0) {
    const osc = ctx.createOscillator();
    osc.type = tn.wave;
    osc.frequency.setValueAtTime(tn.f0, t0);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, tn.f1), t0 + tn.decay);
    const tg = ctx.createGain();
    tg.gain.setValueAtTime(0, t0);
    tg.gain.linearRampToValueAtTime(tn.level, t0 + 0.003);
    tg.gain.setTargetAtTime(0, t0 + 0.005, tn.decay / 3);
    osc.connect(tg).connect(bus);
    osc.start(t0); osc.stop(t0 + tn.decay + 0.1);
    endT = Math.max(endT, tn.decay);
  }

  // Disconnect the dry bus once silent; the reverb tail lives on the shared
  // convolver path and decays independently.
  setTimeout(() => { try { bus.disconnect(); } catch (e) {} }, (endT + 0.3) * 1000);
}

export class SoundManager {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.noiseBuffer = null;
    this.enabled = false;
    this.index = 0;
    this.voice = null;
    this.audition = 0;      // throttle floor (kept at 0 now the tune panel is gone)
  }

  _ensureCtx() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC();

    const len = Math.floor(this.ctx.sampleRate * 2);
    this.noiseBuffer = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = this.noiseBuffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    this.master = this.ctx.createGain();
    this.master.gain.value = 0;
    const limiter = this.ctx.createDynamicsCompressor();
    limiter.threshold.value = -6;
    limiter.ratio.value = 12;
    this.limiter = limiter;
    // MASTER VOLUME — one knob after the limiter that scales the whole mix (engines, guns,
    // spatial SFX, explosions, everything). The top-left UI slider drives setMasterVolume().
    this.masterVol = this.ctx.createGain();
    if (this._volPref == null) {   // seed from the saved slider setting (top-left UI) if the game set one before audio started
      const saved = (typeof localStorage !== 'undefined') ? parseFloat(localStorage.getItem('rmrf-volume')) : NaN;
      if (isFinite(saved)) this._volPref = Math.max(0, Math.min(1, saved));
    }
    this.masterVol.gain.value = (this._volPref != null ? this._volPref : 1);
    this.master.connect(limiter);
    limiter.connect(this.masterVol);
    this.masterVol.connect(this.ctx.destination);

    // Separate SFX bus for gun shots — independent of the engine master, so guns
    // sound whether or not the engine toggle is on.
    this.sfx = this.ctx.createGain();
    this.sfx.gain.value = 0.9;
    this.sfx.connect(limiter);

    // Shared convolver reverb for gun shots (synth impulse). Shots send into
    // `reverbInput`; the wet return mixes back at the limiter.
    this.reverb = this.ctx.createConvolver();
    this.reverb.buffer = makeImpulse(this.ctx, 2.4, 2.2);
    const revReturn = this.ctx.createGain();
    revReturn.gain.value = 1.0;
    this.reverb.connect(revReturn).connect(limiter);
    this.reverbInput = this.ctx.createGain();
    this.reverbInput.connect(this.reverb);
  }

  toggle() {
    this._ensureCtx();
    this.enabled = !this.enabled;
    if (this.enabled) {
      this.ctx.resume();
      this._buildVoice();
      this.master.gain.setTargetAtTime(0.85, this.ctx.currentTime, 0.12);
    } else {
      this.master.gain.setTargetAtTime(0, this.ctx.currentTime, 0.12);
      const v = this.voice;
      this.voice = null;
      if (v) setTimeout(() => v.dispose(), 350);
    }
    return this.enabled;
  }

  setVehicle(index) {
    this.index = index;
    if (this.enabled) this._buildVoice();
  }

  _buildVoice() {
    if (this.voice) { this.voice.dispose(); this.voice = null; }
    this.voice = this._makeVoice(this.index, this.master);
  }

  // Build ONE engine voice for `index` routed to `dest` (the player master, or a
  // spatial panner for a remote vehicle). Returns { setThrottle, tune, dispose }.
  // Prefers the Sound Lab modular patch; falls back to the built-in osc/noise cfg.
  _makeVoice(index, dest) {
    const patch = PATCH_PRESETS[ENGINE_PATCH[index]];
    if (patch) {
      const h = playPatch(this.ctx, this.noiseBuffer, dest, this.reverbInput, patch);
      const [lo, hi] = RPM_RANGE[index] || [0, 1];
      const v = {
        setThrottle: (t) => h.setValue('rpm', lo + Math.min(1, Math.max(0, t)) * (hi - lo)),
        tune: () => {},
        dispose: () => h.stop(0.05),
      };
      v.setThrottle(0);   // start at idle
      return v;
    }
    const cfg = ENGINE_CONFIGS[index] || ENGINE_CONFIGS[0];   // fallback (no patch mapped)
    const v = makeEngine(this.ctx, this.noiseBuffer, cfg);
    v.out.connect(dest);
    return v;
  }

  update(fwd, turn) {
    if (!this.enabled || !this.voice) return;
    const drive = Math.min(1, Math.abs(fwd) + Math.abs(turn) * 0.6);
    this.voice.setThrottle(Math.max(drive, this.audition));
  }

  // ── Spatial (3D) engines ──────────────────────────────────────────────────
  // A separate bus of positioned engine voices, one per remote vehicle, so the
  // game can hear enemies by their engine noise — attenuating with distance and
  // panning with direction. Independent of the player's engine toggle/master, so
  // it works while spectating AI-vs-AI (no player engine at all).

  _ensureSpatial() {
    this._ensureCtx();
    if (this.engineBus) return;
    this.engineBus = this.ctx.createGain();
    this.engineBus.gain.value = 0;            // raised by setSpatialActive(true)
    this.engineBus.connect(this.limiter);
    // Positioned gun-shot bus — one-shot reports from remote/AI vehicles, panned by
    // location so you hear enemies fire. Gated with the engine bus (silent in the
    // hangar, live on the field + while spectating AI-vs-AI).
    this.spatialSfxBus = this.ctx.createGain();
    this.spatialSfxBus.gain.value = 0;
    this.spatialSfxBus.connect(this.limiter);
    this._spatial = new Map();                // id -> { panner, gain, voice }
  }

  // Resume/activate (or mute) the spatial engine bus. Must be called from a user
  // gesture the first time so the browser lets the AudioContext start.
  setSpatialActive(on) {
    this._ensureSpatial();
    if (on) this.ctx.resume();
    this.engineBus.gain.setTargetAtTime(on ? 0.9 : 0, this.ctx.currentTime, 0.15);
    this.spatialSfxBus.gain.setTargetAtTime(on ? 0.9 : 0, this.ctx.currentTime, 0.15);
  }

  get spatialReady() { return !!this.engineBus; }

  // Move the listener (the "ears") — call every frame with the camera transform.
  setListener(px, py, pz, fx, fy, fz) {
    if (!this.ctx) return;
    this._lis = { x: px, y: py, z: pz };       // cached for distance-based muffling
    const L = this.ctx.listener, t = this.ctx.currentTime;
    if (L.positionX) {
      L.positionX.setTargetAtTime(px, t, 0.02);
      L.positionY.setTargetAtTime(py, t, 0.02);
      L.positionZ.setTargetAtTime(pz, t, 0.02);
      L.forwardX.setTargetAtTime(fx, t, 0.02);
      L.forwardY.setTargetAtTime(fy, t, 0.02);
      L.forwardZ.setTargetAtTime(fz, t, 0.02);
      L.upX.value = 0; L.upY.value = 1; L.upZ.value = 0;
    } else {                                   // legacy Safari/Firefox API
      L.setPosition(px, py, pz);
      L.setOrientation(fx, fy, fz, 0, 1, 0);
    }
  }

  // Straight-line distance from a source to the cached listener (0 if no listener yet).
  _distToListener(x, y, z) {
    const L = this._lis;
    if (!L) return 0;
    const dx = x - L.x, dy = y - L.y, dz = z - L.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  _setPannerPos(p, x, y, z) {
    const t = this.ctx.currentTime;
    if (p.positionX) {
      p.positionX.setTargetAtTime(x, t, 0.02);
      p.positionY.setTargetAtTime(y, t, 0.02);
      p.positionZ.setTargetAtTime(z, t, 0.02);
    } else { p.setPosition(x, y, z); }
  }

  // Create a positioned engine voice for `id` (a remote vehicle). soundIndex picks
  // the engine timbre + size-based carry profile. Idempotent per id.
  addSpatialEngine(id, soundIndex, x, y, z) {
    this._ensureSpatial();
    if (this._spatial.has(id)) return;
    const prof = ENGINE_SPATIAL[soundIndex] || ENGINE_SPATIAL[0];
    const panner = this.ctx.createPanner();
    panner.panningModel = 'equalpower';        // cheap; HRTF is overkill for engines
    panner.distanceModel = 'inverse';
    panner.refDistance = prof.ref;
    panner.maxDistance = prof.max;
    panner.rolloffFactor = ENGINE_ROLLOFF;
    const gain = this.ctx.createGain();
    gain.gain.value = prof.gain;
    // Distance muffle: voice → gain → lowpass → panner. Cutoff closes with distance
    // (set each frame in updateSpatialEngine), so a far engine reads as a dull rumble.
    const lpf = this.ctx.createBiquadFilter();
    lpf.type = 'lowpass';
    lpf.frequency.value = MUFFLE_NEAR_HZ;
    const voice = this._makeVoice(soundIndex, gain);
    gain.connect(lpf);
    lpf.connect(panner);
    panner.connect(this.engineBus);
    this._setPannerPos(panner, x, y, z);
    this._spatial.set(id, { panner, gain, voice, lpf, prof });
  }

  updateSpatialEngine(id, x, y, z, throttle) {
    const e = this._spatial && this._spatial.get(id);
    if (!e) return;
    this._setPannerPos(e.panner, x, y, z);
    e.voice.setThrottle(throttle);
    if (e.lpf) {                                // muffle by distance past the full-volume radius
      const dist = this._distToListener(x, y, z);
      const farness = (dist - e.prof.ref) / Math.max(1, e.prof.max - e.prof.ref);
      e.lpf.frequency.setTargetAtTime(muffleHz(farness, ENGINE_FAR_HZ), this.ctx.currentTime, 0.06);
    }
  }

  dropSpatialEngine(id) {
    const e = this._spatial && this._spatial.get(id);
    if (!e) return;
    try { e.voice.dispose(); } catch (err) {}
    try { e.gain.disconnect(); } catch (err) {}
    try { e.panner.disconnect(); } catch (err) {}
    this._spatial.delete(id);
  }

  // Fire the current vehicle's gun (one-shot). Works even with the engine off —
  // the triggering keypress is the gesture that unlocks/resumes the context.
  fireGun() {
    this._ensureCtx();
    if (this.ctx.state === 'suspended') this.ctx.resume();
    const patch = PATCH_PRESETS[GUN_PATCH[this.index]];   // this vehicle's modular gun patch (auto-stops)
    if (patch) playPatch(this.ctx, this.noiseBuffer, this.sfx, this.reverbInput, patch);
    else makeShot(this.ctx, this.noiseBuffer, this.sfx, this.reverbInput, GUN_CONFIGS[this.index] || GUN_CONFIGS[0]);
  }

  // Fire a POSITIONED gun shot for a remote/AI vehicle: the same per-vehicle gun
  // patch as fireGun(), but routed through a one-shot panner at (x,y,z) so it pans +
  // attenuates with distance from the listener. soundIndex picks the timbre. Gated by
  // the spatial bus (setSpatialActive) so it's silent in the hangar.
  fireGunAt(soundIndex, x, y, z) {
    this._ensureSpatial();
    if (this.ctx.state === 'suspended') this.ctx.resume();
    const panner = this.ctx.createPanner();
    panner.panningModel = 'equalpower';
    panner.distanceModel = 'inverse';
    panner.refDistance = 40;          // gunfire carries much farther than the engine drone
    panner.maxDistance = 700;
    panner.rolloffFactor = 1.0;
    this._setPannerPos(panner, x, y, z);
    // Distance muffle (one-shot, so set the cutoff once for THIS shot's range): a far
    // gunshot loses its crack and reads as a thump. Chain: voice → lowpass → panner.
    const lpf = this.ctx.createBiquadFilter();
    lpf.type = 'lowpass';
    const farness = this._distToListener(x, y, z) / GUN_MUFFLE_DIST;
    lpf.frequency.value = muffleHz(farness, GUN_FAR_HZ);
    lpf.connect(panner);
    panner.connect(this.spatialSfxBus);
    const patch = PATCH_PRESETS[GUN_PATCH[soundIndex]];
    if (patch) playPatch(this.ctx, this.noiseBuffer, lpf, this.reverbInput, patch);
    else makeShot(this.ctx, this.noiseBuffer, lpf, this.reverbInput, GUN_CONFIGS[soundIndex] || GUN_CONFIGS[0]);
    // The shot's voice auto-stops (~1-1.5s); free the nodes after the tail.
    setTimeout(() => { try { panner.disconnect(); lpf.disconnect(); } catch (e) {} }, 4000);
  }

  // ── Master volume (top-left UI slider) ─────────────────────────────────────
  // 0..1, applied after the limiter so it scales the entire mix. Remembered even
  // before the context exists (the UI can set it on load; _ensureCtx picks it up).
  setMasterVolume(v) {
    this._volPref = Math.max(0, Math.min(1, v));
    if (this.masterVol) this.masterVol.gain.setTargetAtTime(this._volPref, this.ctx.currentTime, 0.03);
  }
  getMasterVolume() { return this._volPref != null ? this._volPref : 1; }

  // ── World SFX: mine explosion, elevator rise, soldier squish ────────────────

  // A positioned MINE detonation (one-shot). Same panner/distance-muffle chain as a gun shot,
  // but with the WORLD "MINE — EXPLOSION" patch. The limiter tames its hot/clipped peaks.
  explosionAt(x, y, z) {
    this._ensureSpatial();
    if (this.ctx.state === 'suspended') this.ctx.resume();
    const patch = PATCH_PRESETS['MINE — EXPLOSION']; if (!patch) return;
    const panner = this.ctx.createPanner();
    panner.panningModel = 'equalpower'; panner.distanceModel = 'inverse';
    panner.refDistance = 45; panner.maxDistance = 650; panner.rolloffFactor = 1.0;
    this._setPannerPos(panner, x, y, z);
    const lpf = this.ctx.createBiquadFilter(); lpf.type = 'lowpass';
    lpf.frequency.value = muffleHz(this._distToListener(x, y, z) / GUN_MUFFLE_DIST, GUN_FAR_HZ);
    lpf.connect(panner); panner.connect(this.spatialSfxBus);
    playPatch(this.ctx, this.noiseBuffer, lpf, this.reverbInput, patch);
    setTimeout(() => { try { panner.disconnect(); lpf.disconnect(); } catch (e) {} }, 5000);
  }

  // Start the ELEVATOR servo whir at a base's lift. Returns a handle: move(x,y,z) to follow the
  // rising platform, stop() when it arrives. The lift owns the timing, so it runs exactly the
  // length of the animation (the patch also self-stops at its dur as a fallback).
  elevatorAt(x, y, z) {
    this._ensureSpatial();
    if (this.ctx.state === 'suspended') this.ctx.resume();
    const patch = PATCH_PRESETS['ELEVATOR — SERVO']; if (!patch) return { move() {}, stop() {} };
    const panner = this.ctx.createPanner();
    panner.panningModel = 'equalpower'; panner.distanceModel = 'inverse';
    panner.refDistance = 28; panner.maxDistance = 420; panner.rolloffFactor = 1.0;
    this._setPannerPos(panner, x, y, z);
    panner.connect(this.spatialSfxBus);
    const h = playPatch(this.ctx, this.noiseBuffer, panner, this.reverbInput, patch);
    return {
      move: (nx, ny, nz) => this._setPannerPos(panner, nx, ny, nz),
      stop: () => { try { h.stop(0.2); } catch (e) {} setTimeout(() => { try { panner.disconnect(); } catch (e) {} }, 1800); },
    };
  }

  // NON-SPATIAL elevator whir for the GARAGE deploy rise. The garage is its own scene/camera,
  // so the spatial listener position is stale there — this routes the same ELEVATOR patch through
  // the flat sfx bus (full volume, camera-independent). Returns a stop() handle.
  elevatorUI() {
    this._ensureCtx();
    if (this.ctx.state === 'suspended') this.ctx.resume();
    const patch = PATCH_PRESETS['ELEVATOR — SERVO']; if (!patch) return { stop() {} };
    const h = playPatch(this.ctx, this.noiseBuffer, this.sfx, this.reverbInput, patch);
    return { stop: () => { try { h.stop(0.2); } catch (e) {} } };
  }

  // One-shot relay clack when the player switches vehicle in the garage (the selection light
  // moves). The patch is hot on purpose (Jacob's tuning peaks ~6x full scale), so route it
  // through a trim gain so it sits UNDER the engines rather than slamming the limiter.
  vehicleSelectUI() {
    this._ensureCtx();
    if (this.ctx.state === 'suspended') this.ctx.resume();
    const patch = PATCH_PRESETS['WORLD — RELAY CLANK']; if (!patch) return;
    const trim = this.ctx.createGain(); trim.gain.value = 0.16; trim.connect(this.sfx);
    playPatch(this.ctx, this.noiseBuffer, trim, this.reverbInput, patch);
    setTimeout(() => { try { trim.disconnect(); } catch (e) {} }, 700);
  }

  // Soldier SQUISH — a SYNTH patch ('WORLD — SQUISH (synth)', Jacob's design), played positioned.
  // (The old rmrf/sounds/squish.mp3 sample was retired 2026-07-11 once the synth won on his ear.)
  squishAt(x, y, z) {
    this._ensureSpatial();
    if (this.ctx.state === 'suspended') this.ctx.resume();
    const patch = PATCH_PRESETS['WORLD — SQUISH (synth)']; if (!patch) return;
    const panner = this.ctx.createPanner();
    panner.panningModel = 'equalpower'; panner.distanceModel = 'inverse';
    panner.refDistance = 24; panner.maxDistance = 300; panner.rolloffFactor = 1.2;
    this._setPannerPos(panner, x, y, z);
    const g = this.ctx.createGain(); g.gain.value = 5.5;   // makeup: the resonant patch peaks ~0.14
    g.connect(panner); panner.connect(this.spatialSfxBus);
    playPatch(this.ctx, this.noiseBuffer, g, this.reverbInput, patch);
    setTimeout(() => { try { g.disconnect(); panner.disconnect(); } catch (e) {} }, 1200);
  }

}
