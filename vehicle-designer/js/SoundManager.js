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

import { playPatch, PATCH_PRESETS } from './patch.js';

// Each vehicle's engine + gun plays a Sound Lab modular patch (authored in the Sound Lab) by index:
// 0 Lurcher, 1 Firebrat, 2 Valkyrie, 3 Jotun. RPM_RANGE = [idle, max] the driving throttle maps to.
const ENGINE_PATCH = ['LURCHER — ENGINE', 'FIREBRAT — ENGINE', 'VALKYRIE — ENGINE', 'JOTUN — ENGINE'];
const GUN_PATCH    = ['LURCHER — GUN A',  'FIREBRAT — GUN',    'VALKYRIE — ROCKET A', 'JOTUN — RAIL D'];
const RPM_RANGE    = [[0, 1], [0.25, 2], [0, 1], [0, 1]];

const ENGINE_CONFIGS = [
  // 0 LURCHER — electric SERVO walker. Square wave reads "motor/robot" (hollow,
  // not combustion). Mid register, crisp actuator pulse, faint whine vibrato.
  { synth: 'osc', oscType: 'square', idleFreq: 70, revFreq: 150, detune: 6,
    vibrato: { rate: 5, cents: 9 },
    noiseLevel: 0.10, noiseFreqIdle: 1200, noiseFreqRev: 2200, noiseQ: 1.2,
    filterIdle: 300, filterRev: 600, filterQ: 1.0,
    am: { rateIdle: 20.5, rateRev: 47, depth: 0.61 },   // bro's tune 2026-06-11: tremolo → firing-pulse "engine" feel
    idleGain: 0.10, revGain: 0.40 },

  // 1 FIREBRAT — turbine / insect WHINE. Air-DOMINANT: noise (0.55) is the main
  // event, shaped by a sharp bandpass (Q 7) sweeping ~1.8→5.2kHz = the whistle.
  // Thin high saw with fast vibrato rides on top for the insect quiver. No tremolo.
  { synth: 'osc', oscType: 'sawtooth', idleFreq: 20, revFreq: 40, detune: 0,
    vibrato: { rate: 7, cents: 26 },
    noiseLevel: 0.9, noiseFreqIdle: 6000, noiseFreqRev: 8000, noiseQ: 4.2,
    filterIdle: 2380, filterRev: 4380, filterQ: 9.9,
    am: { rateIdle: 0, rateRev: 0, depth: 0 },   // bro's tune 2026-06-11: airy high whistle, resonant lowpass (Q 9.9)
    idleGain: 0.04, revGain: 0.195 },

  // 2 VALKYRIE — ducted-fan THRUM. Strong blade-pass AM (the "wop-wop") over
  // broadband air; AM rate + pitch rise on spool-up.
  { synth: 'osc', oscType: 'sawtooth', idleFreq: 333, revFreq: 1200, detune: 20,
    vibrato: null,
    noiseLevel: 0.85, noiseFreqIdle: 700, noiseFreqRev: 830, noiseQ: 0.1,
    filterIdle: 1090, filterRev: 2070, filterQ: 0.7,
    am: { rateIdle: 11, rateRev: 26, depth: 0.5 },   // bro's tune 2026-06-11: osc back in under 0.85 noise, AM wop-wop kept
    idleGain: 0.22, revGain: 0.185 },

  // 3 JOTUN — PURE-NOISE diesel. Low "body" lowpass for the rumble + a mid
  // resonant band for grit, gated by a firing-rate sawtooth pulse that sweeps
  // 11→58 Hz. At idle you hear the individual chugs; revving blurs them into a
  // diesel buzz. Zero oscillators — this is all white noise.
  { synth: 'noise',   // bro's tune 2026-06-11
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
    this.master.connect(limiter).connect(this.ctx.destination);

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
    // engine = the Sound Lab modular patch for this vehicle (continuous). Driving throttle revs the
    // "RPMs" VALUE node over the vehicle's idle→max range. Single source of truth with the Sound Lab.
    const patch = PATCH_PRESETS[ENGINE_PATCH[this.index]];
    if (patch) {
      const h = playPatch(this.ctx, this.noiseBuffer, this.master, this.reverbInput, patch);
      const [lo, hi] = RPM_RANGE[this.index] || [0, 1];
      this.voice = {
        setThrottle: (t) => h.setValue('rpm', lo + Math.min(1, Math.max(0, t)) * (hi - lo)),
        tune: () => {},
        dispose: () => h.stop(0.05),
      };
      this.voice.setThrottle(0);   // start at idle
      return;
    }
    const cfg = ENGINE_CONFIGS[this.index] || ENGINE_CONFIGS[0];   // fallback (no patch mapped)
    this.voice = makeEngine(this.ctx, this.noiseBuffer, cfg);
    this.voice.out.connect(this.master);
  }

  update(fwd, turn) {
    if (!this.enabled || !this.voice) return;
    const drive = Math.min(1, Math.abs(fwd) + Math.abs(turn) * 0.6);
    this.voice.setThrottle(Math.max(drive, this.audition));
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

}
