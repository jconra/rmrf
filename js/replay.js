// replay.js — WATCH THE FAILURE.  (paired with lab/replay.html)
//
// Reading "69% of stuck ticks have zero commanded throttle" tells you what happened. It does not
// let you SEE a Jotun roll to a stop in an open field and sit there. This drives the REAL game —
// same main.js, same map, same AI — so what you watch is what ships. It is deliberately NOT a
// fork: a debugging tool that can silently disagree with the code it is debugging is worse than
// no tool, because it will faithfully reproduce a bug you already fixed.
//
// No recording format is needed, because matches are bit-identical from a seed:
//   · "show me t=340s"  = run the sim with the render loop frozen until t=340s, then watch
//   · "replay that"     = do it again from the same seed
//   · "rewind"          = re-simulate. There is no rewind and there does not need to be one.
//
// The game itself contributes exactly one thing to all of this: RR.setTimeScale.

const SEEK_CHUNK = 120;     // sim ticks between yields, so the page can paint a progress line
const LEAD_IN = 8;          // s of run-up to show before the moment a unit stops making progress

export function initReplay(RR, QS, host) {
  const ui = host || document.body;
  // The lab page installed a controlled clock before the game loaded (see lab/replay.html).
  // Seeking drives it by hand at the harness's 50ms/tick; playing hands it back to real time,
  // scaled, so the game's wall-clock timers stay in step with simulated time at any speed.
  const clk = window.__labClock || { t: 0, rate: 1 };
  const setRate = (r) => { clk.rate = r; };
  // A debugging lab does not need audio, and seeking would otherwise fire every gun in the match
  // through the mixer at once. Muted outright rather than suppressed per-seek.
  // Not exactly 0: the mixer ramps gain with setTargetAtTime and a zero target goes non-finite
  // through its log scaling, which throws on every ramp.
  try { if (RR.sound) RR.sound.setMasterVolume(0.0001); } catch (e) {}
  let watched = null;
  let seeking = false;
  let paused = false;
  let playSpeed = 1;        // the speed to return to when un-pausing

  // ── THE BUG THIS FILE WAS BORN WITH ────────────────────────────────────────
  // Seeking steps the sim in a tight loop. The render loop ALSO steps the sim, every frame. Run
  // both and they compound: the first version tore through a whole match in about two seconds and
  // landed on the victory screen. The headless test never caught it because that harness kills
  // requestAnimationFrame, so only one of the two was ever running. Freeze the world clock for the
  // duration of any seek and the sim advances exactly once per loop, under our control.
  async function seek(seconds, say) {
    if (seeking) return;
    seeking = true;
    RR.setTimeScale(0); setRate(0);
    const ticks = Math.round(seconds / 0.05);
    try {
      for (let done = 0; done < ticks; done += SEEK_CHUNK) {
        const n = Math.min(SEEK_CHUNK, ticks - done);
        for (let i = 0; i < n; i++) {
          if (RR.matchOver) return;                      // match ended — stop, don't run past it
          clk.t += 50;                                   // 50ms per tick — exactly what the harness does
          RR.stepField(0.05, 1); RR.tickFlags && RR.tickFlags(0.05);
        }
        if (say) say(`seeking… ${Math.round((done + n) * 0.05)}s of ${Math.round(seconds)}s`);
        await new Promise(r => setTimeout(r, 0));
      }
    } finally { seeking = false; RR.setTimeScale(paused ? 0 : 1); setRate(paused ? 0 : playSpeed); }
  }

  // Roll forward until a unit stops making progress toward a goal it is still far from — exactly
  // the condition the tournament counts as TRANSIT-stuck. Returns { v, startT }: the offender AND
  // the moment it stopped, which is 20s earlier than where this lands. You want to watch the
  // approach, not arrive in the middle of the stall — and since there is no rewind, getting there
  // means re-running from the seed, which the caller does with one reload.
  async function seekToStuck(say, { minSecs = 20, maxSecs = 1200 } = {}) {
    if (seeking) return null;
    seeking = true;
    RR.setTimeScale(0); setRate(0);
    const mark = new Map();
    try {
      for (let t = 0; t < maxSecs; t++) {
        if (RR.matchOver) { if (say) say('the match ended before anything got stuck'); return null; }
        for (let i = 0; i < 20; i++) { clk.t += 50; RR.stepField(0.05, 1); RR.tickFlags && RR.tickFlags(0.05); }
        for (const c of RR.commanders) for (const sl of (c._slots || [])) {
          const v = sl.unit;
          if (!v || v.dead) { mark.delete(sl); continue; }
          const p = v.holder.position, d = sl._dbg || {};
          const gd = d.gx != null ? Math.hypot(d.gx - p.x, d.gz - p.z) : 0;
          let m = mark.get(sl);
          if (!m || m.v !== v || Math.hypot(p.x - m.x, p.z - m.z) > 20) { mark.set(sl, { v, x: p.x, z: p.z, run: 0, startT: RR.matchTime() }); continue; }
          m.run++;
          if (gd > 15 && m.run >= minSecs) return { v, startT: m.startT, x: p.x, z: p.z };
        }
        if (t % 10 === 0) { if (say) say(`scanning for a stuck unit… t=${Math.round(RR.matchTime())}s`); await new Promise(r => setTimeout(r, 0)); }
      }
      return null;
    } finally { seeking = false; RR.setTimeScale(paused ? 0 : 1); setRate(paused ? 0 : playSpeed); }
  }

  // ── controls ───────────────────────────────────────────────────────────────
  const bar = document.createElement('div');
  bar.id = 'replay-bar';
  const status = document.createElement('span');
  status.id = 'replay-status';

  const btn = (label, title, fn) => {
    const b = document.createElement('button');
    b.textContent = label; b.title = title; b.onclick = fn;
    bar.appendChild(b); return b;
  };
  const setPaused = (on) => {
    paused = on;
    if (!seeking) { RR.setTimeScale(on ? 0 : 1); setRate(on ? 0 : playSpeed); }
    playBtn.textContent = on ? '▶' : '❚❚';
  };
  const oneTick = () => { setPaused(true); clk.t += 50; RR.stepField(0.05, 1); RR.tickFlags && RR.tickFlags(0.05); };

  const playBtn = btn('❚❚', 'play / pause  (space)', () => setPaused(!paused));
  btn('▸|', 'advance one physics tick  (.)', oneTick);
  const speeds = [];
  for (const sp of [0.1, 0.25, 0.5, 1, 2]) {
    const b = btn(sp + '×', `run at ${sp}× speed`, () => {
      playSpeed = sp; if (!paused && !seeking) { RR.setTimeScale(1); setRate(sp); }
      speeds.forEach(o => o.classList.toggle('on', o === b));
    });
    speeds.push(b); if (sp === 1) b.classList.add('on');
  }
  btn('⇥ next stuck', 'roll forward to the next unit that stops making progress', async () => {
    const hit = await seekToStuck(s => status.textContent = s);
    if (hit) pin(hit.v);
  });
  btn('⟲ restart', 're-run this seed from the beginning', () => location.reload());
  bar.appendChild(status);
  ui.appendChild(bar);

  // ── the panel: WHY is this unit not moving? ────────────────────────────────
  const panel = document.createElement('div');
  panel.id = 'replay-panel';
  ui.appendChild(panel);

  function pin(v) {
    watched = v; RR.watch(v);
    status.textContent = `watching ${v.team} ${v.type}`;
  }

  addEventListener('keydown', e => {
    if (e.target && /INPUT|TEXTAREA/.test(e.target.tagName)) return;
    if (e.key === ' ') { setPaused(!paused); e.preventDefault(); }
    if (e.key === '.') oneTick();
  });

  const findSlot = (v) => {
    for (const c of RR.commanders) for (const sl of (c._slots || [])) if (sl.unit === v) return sl;
    return null;
  };

  setInterval(() => {
    const v = watched;
    if (!v || v.dead) { panel.style.display = 'none'; return; }
    const sl = findSlot(v);
    if (!sl) { panel.style.display = 'none'; return; }
    const d = sl._dbg || {}, p = v.holder.position;
    const gd = d.gx != null ? Math.hypot(d.gx - p.x, d.gz - p.z) : null;
    const path = sl._nav && sl._nav.path;
    const end = path && path.length ? path[path.length - 1] : null;
    const endShort = end && d.gx != null ? Math.hypot(end.x - d.gx, end.z - d.gz) : null;
    const ped = sl._driver && sl._driver._lastPed;
    const ord = sl._driver && sl._driver.o;
    let reach = '?'; try { if (d.gx != null) reach = String(RR.cellReach(v, d.gx, d.gz)); } catch (e) {}
    const stopped = ped && Math.abs(ped.fwd || 0) < 0.05 && Math.abs(ped.strafe || 0) < 0.05;
    // Not "it is stuck" — WHICH of the handful of things that can take a throttle away has it.
    const why = v._yielding ? 'yielding to a friendly'
      : !path ? 'NO ROUTE cached'
      : (stopped && endShort > 15 && end && Math.hypot(end.x - p.x, end.z - p.z) < 6)
        ? `parked at the end of a route that stops ${Math.round(endShort)}u short`
      : stopped ? 'throttle commanded to ZERO'
      : 'pedals down';
    panel.style.display = 'block';
    panel.textContent =
      `${v.team} ${v.type}    t=${Math.round(RR.matchTime())}s    ${paused ? 'PAUSED' : playSpeed + '×'}\n` +
      `state ${v._aiState || '-'} · mission ${d.step || '-'}\n` +
      `order ${ord ? ord.type + (ord.by ? ` (${ord.by})` : '') : 'NONE — nobody is driving'}\n` +
      `\ngoal      ${gd == null ? '—' : Math.round(gd) + 'u away'}   reachable: ${reach}\n` +
      `route     ${path ? `${path.length} waypoints, on #${sl._nav.idx}` : '—'}` +
      `${path && path.budgetHit ? '  (search hit its budget)' : ''}\n` +
      `route end ${endShort == null ? '—' : Math.round(endShort) + 'u short of the goal'}\n` +
      `pedals    ${ped ? `fwd ${(ped.fwd || 0).toFixed(2)}  turn ${(ped.turn || 0).toFixed(2)}  strafe ${(ped.strafe || 0).toFixed(2)}` : '—'}\n` +
      `\n▸ ${why}`;
  }, 120);

  // ── CLICK A UNIT TO WATCH IT ───────────────────────────────────────────────
  // Until now the only way to pin a unit was a URL parameter, which means you cannot follow a
  // hunch: you see something odd happen on the far side of the field and there is no way to say
  // "that one". Projects every live hull to screen space and takes the nearest to the click,
  // rather than raycasting meshes — a hull is a group of parts and half of them are moving.
  const clickPin = (ev) => {
    if (!RR.camera || !RR.THREE) return;
    const r = renderer3d().getBoundingClientRect();
    const mx = ev.clientX - r.left, my = ev.clientY - r.top;
    const v3 = new RR.THREE.Vector3();
    let best = null, bestD = Infinity;
    for (const c of RR.commanders) for (const sl of (c._slots || [])) {
      const u = sl.unit; if (!u || u.dead) continue;
      v3.copy(u.holder.position); v3.y += 3; v3.project(RR.camera);
      if (v3.z > 1) continue;                                   // behind the camera
      const sx = (v3.x * 0.5 + 0.5) * r.width, sy = (-v3.y * 0.5 + 0.5) * r.height;
      const d = Math.hypot(sx - mx, sy - my);
      if (d < bestD) { bestD = d; best = u; }
    }
    if (best && bestD < 90) {                                   // a generous grab radius, not pixel-perfect
      pin(best);
      scope.t.length = scope.d.length = scope.ped.length = scope.spd.length = scope.flip.length = 0;
    }
  };
  const renderer3d = () => (RR.renderer && RR.renderer.domElement) || document.body;
  addEventListener('pointerdown', (e) => {
    if (e.target && e.target.closest && e.target.closest('#lab-ui, #replay-bar, #replay-panel, #replay-scope, #replay-cell')) return;
    clickPin(e);
  });

  // ── NAV SCOPE: does the hull actually FOLLOW its route? ────────────────────
  //
  // The panel above answers "why is it stopped". It cannot answer the question that cost a whole
  // day: a hull at full throttle, nothing blocking it, a stable route, and it never arrives.
  //
  // Seed 214 is the case. A Lurcher orbited its next waypoint for twenty-five seconds, distance
  // to that waypoint cycling 2.60 → 2.87 → 2.60 and never once reaching the acceptance radius, so
  // the route never advanced. Every still frame of that looks healthy — pedals down, route valid,
  // nothing in the way. It is only visible AS A SHAPE OVER TIME, and every tool we had sampled too
  // slowly to see it: at 0.3s I read the oscillation as a position "snap" and went looking for a
  // second writer that does not exist.
  //
  // So this samples PER SIM TICK (deduped on match time, so a seek records every tick and playback
  // records each one once) and draws three series against each other:
  //   · distance to the waypoint being chased — a flat floor here is a limit cycle, full stop
  //   · commanded forward pedal
  //   · actual ground speed
  // plus a count of how often the velocity REVERSES, because a controller fighting itself shows up
  // as a sign flip per tick long before it shows up in any average.
  const scope = { on: QS.has('nav') || QS.has('scope'), n: 900, t: [], d: [], ped: [], spd: [], flip: [], lastT: -1, lastVx: 0, lastVz: 0 };
  const scopeWrap = document.createElement('div');
  scopeWrap.id = 'replay-scope';
  scopeWrap.style.cssText = `position:fixed; right:10px; bottom:64px; z-index:160; display:none;
    background:rgba(8,12,18,0.86); border:1px solid rgba(255,255,255,0.18); border-radius:6px;
    padding:6px 8px 4px; font-family:'Courier New',monospace; color:#dfe8ef; font-size:11px;`;
  const scopeCv = document.createElement('canvas');
  scopeCv.width = 420; scopeCv.height = 120;
  scopeCv.style.cssText = 'display:block; width:420px; height:120px;';
  const scopeRead = document.createElement('div');
  scopeRead.style.cssText = 'padding-top:3px; letter-spacing:.5px; white-space:pre;';
  scopeWrap.appendChild(scopeCv); scopeWrap.appendChild(scopeRead);
  ui.appendChild(scopeWrap);

  const scopeSample = () => {
    const v = watched; if (!v || v.dead) return;
    const t = RR.matchTime();
    if (t === scope.lastT) return;                 // one sample per sim tick, however fast we run
    scope.lastT = t;
    const sl = findSlot(v); if (!sl) return;
    const path = sl._nav && sl._nav.path;
    const wp = path && path.length ? path[Math.min(sl._nav.idx || 0, path.length - 1)] : null;
    const p = v.holder.position;
    const d = wp ? Math.hypot(wp.x - p.x, wp.z - p.z) : null;
    const ped = (sl._driver && sl._driver._lastPed) || null;
    const vx = v._vx || 0, vz = v._vz || 0;
    // A REVERSAL, not a turn: the velocity vector pointing back the way it came within one tick.
    const dot = vx * scope.lastVx + vz * scope.lastVz;
    const mag = Math.hypot(vx, vz) * Math.hypot(scope.lastVx, scope.lastVz);
    const flipped = mag > 0.5 && dot / mag < -0.3 ? 1 : 0;
    scope.lastVx = vx; scope.lastVz = vz;
    scope.t.push(t); scope.d.push(d); scope.ped.push(ped ? Math.abs(ped.fwd || 0) + Math.abs(ped.strafe || 0) : 0);
    scope.spd.push(Math.hypot(vx, vz)); scope.flip.push(flipped);
    for (const a of [scope.t, scope.d, scope.ped, scope.spd, scope.flip]) if (a.length > scope.n) a.shift();
  };

  const scopeDraw = () => {
    scopeWrap.style.display = (scope.on && watched && !watched.dead) ? 'block' : 'none';
    if (!scope.on || !watched || watched.dead || !scope.t.length) return;
    const c = scopeCv.getContext('2d'), W = scopeCv.width, H = scopeCv.height;
    c.clearRect(0, 0, W, H);
    c.fillStyle = 'rgba(0,0,0,0.25)'; c.fillRect(0, 0, W, H);
    const n = scope.t.length, x = i => (i / Math.max(1, scope.n - 1)) * W;
    // distance to the chased waypoint — autoscaled, with its own floor drawn as the tell
    const ds = scope.d.filter(v => v != null);
    const dMax = Math.max(4, ...ds), dMin = Math.min(...ds);
    const dy = v => H - 6 - (v / dMax) * (H - 14);
    c.strokeStyle = '#7dd3fc'; c.lineWidth = 1.2; c.beginPath();
    let started = false;
    for (let i = 0; i < n; i++) { const v = scope.d[i]; if (v == null) { started = false; continue; }
      const px = x(i), py = dy(v); started ? c.lineTo(px, py) : c.moveTo(px, py); started = true; }
    c.stroke();
    if (ds.length > 20) {   // the floor: if this never touches the bottom, the route never advances
      c.strokeStyle = 'rgba(224,154,65,0.8)'; c.setLineDash([3, 3]); c.beginPath();
      c.moveTo(0, dy(dMin)); c.lineTo(W, dy(dMin)); c.stroke(); c.setLineDash([]);
    }
    // pedal (green) and actual speed (grey), both on a 0..1 normalised band at the bottom
    const nom = (watched.def && watched.def.speed) || 14;
    c.strokeStyle = '#63b5a3'; c.beginPath();
    for (let i = 0; i < n; i++) { const py = H - 4 - Math.min(1, scope.ped[i] / 1) * 26; i ? c.lineTo(x(i), py) : c.moveTo(x(i), py); }
    c.stroke();
    c.strokeStyle = 'rgba(200,210,220,0.55)'; c.beginPath();
    for (let i = 0; i < n; i++) { const py = H - 4 - Math.min(1, scope.spd[i] / nom) * 26; i ? c.lineTo(x(i), py) : c.moveTo(x(i), py); }
    c.stroke();
    // reversals as ticks along the top
    c.fillStyle = '#e0983c';
    for (let i = 0; i < n; i++) if (scope.flip[i]) c.fillRect(x(i), 0, 1.5, 6);
    const flips = scope.flip.reduce((a, b) => a + b, 0);
    const span = scope.t[n - 1] - scope.t[0] || 1;
    const dNow = scope.d[n - 1];
    scopeRead.textContent =
      `waypoint  ${dNow == null ? '  —' : dNow.toFixed(2) + 'u'}   floor ${ds.length ? dMin.toFixed(2) + 'u' : '—'}   ` +
      `reversals ${(flips / span).toFixed(1)}/s\n` +
      `${ds.length > 40 && dMin > 1.5 && flips / span > 2
        ? '\u25b8 LIMIT CYCLE — orbiting the waypoint, route cannot advance'
        : '\u25b8 blue = distance to waypoint · green = pedal · grey = speed · orange = reversal'}`;
  };

  btn('nav scope', 'plot distance-to-waypoint, pedal and speed per tick', () => {
    scope.on = !scope.on;
    scope.t.length = scope.d.length = scope.ped.length = scope.spd.length = scope.flip.length = 0;
  });

  // ── the cell under the hull: what does A* think of the ground it is on? ────
  // The depth-scaled water cost and the island ring are both invisible on screen, and both have
  // put a unit somewhere it could not leave. This asks the real functions, for THIS hull.
  const cellRead = document.createElement('div');
  cellRead.id = 'replay-cell';
  cellRead.style.cssText = `position:fixed; right:10px; bottom:194px; z-index:160; display:none;
    background:rgba(8,12,18,0.86); border:1px solid rgba(255,255,255,0.18); border-radius:6px;
    padding:6px 8px; font-family:'Courier New',monospace; color:#dfe8ef; font-size:11px; white-space:pre;`;
  ui.appendChild(cellRead);
  const cellProbe = () => {
    const v = watched;
    if (!scope.on || !v || v.dead) { cellRead.style.display = 'none'; return; }
    const p = v.holder.position;
    let blocked = '?', reach = '?', deep = '?', land = '?', terr = '?';
    try { blocked = String(!!v._blocked(p.x, p.z)); } catch (e) {}
    try { reach = String(RR.cellReach(v, p.x, p.z)); } catch (e) {}
    try { terr = RR.terrainAt(p.x, p.z).toFixed(2); } catch (e) {}
    try { deep = String(RR.isDeepWater ? RR.isDeepWater(p.x, p.z) : '—'); } catch (e) {}
    try { land = String(RR.isLand ? RR.isLand(p.x, p.z) : '—'); } catch (e) {}
    cellRead.style.display = 'block';
    cellRead.textContent =
      `cell (${p.x.toFixed(0)}, ${p.z.toFixed(0)})   terrain ${terr}\n` +
      `blocked ${blocked}   land ${land}   deep ${deep}   can-reach-here ${reach}`;
  };

  (function scopeLoop() { scopeSample(); scopeDraw(); cellProbe(); requestAnimationFrame(scopeLoop); })();

  // ── opening move ───────────────────────────────────────────────────────────
  (async () => {
    const at = Number(QS.get('at') || 0);
    if (at > 0) { await seek(at, s => status.textContent = s); status.textContent = `at t=${Math.round(RR.matchTime())}s`; }

    const wantWatch = QS.get('watch');
    if (wantWatch) {
      const [team, type] = wantWatch.split(':');
      const wx = QS.get('wx') != null ? Number(QS.get('wx')) : null;
      const wz = QS.get('wz') != null ? Number(QS.get('wz')) : null;
      const look = () => {
        let best = null, bestD = Infinity;
        for (const c of RR.commanders) for (const sl of (c._slots || [])) {
          const v = sl.unit;
          if (!v || v.dead || (team && v.team !== team) || (type && v.type !== type)) continue;
          const dd = wx == null ? 0 : Math.hypot(v.holder.position.x - wx, v.holder.position.z - wz);
          if (dd < bestD) { bestD = dd; best = v; }
        }
        return { best, bestD };
      };
      // wx/wz say WHICH unit, not WHEN. Rolling forward until the unit reached that spot ate the
      // whole lead-in — a link aimed at t=37 landed at t=95, already deep into the stall it was
      // supposed to show the run-up to. So only roll forward when there is no matching unit on the
      // field at all (it died and its slot has yet to redeploy); once one exists, that is the one.
      let { best, bestD } = look();
      for (let extra = 0; extra < 120 && !best; extra += 2) {
        await seek(2);
        ({ best, bestD } = look());
      }
      if (best) { pin(best); status.textContent = `watching ${best.team} ${best.type}` + (wx != null ? ` · ${Math.round(bestD)}u from the reported spot` : ''); }
      else status.textContent = `${wantWatch} never appeared near that spot`;
    }

    if (QS.get('find') === 'stuck') {
      const hit = await seekToStuck(s => status.textContent = s);
      if (!hit) return;
      // Land a few seconds BEFORE it stalls, so the approach is visible rather than the aftermath.
      // seekToStuck has to watch 20s of no progress before it can call it, so by the time it knows,
      // the interesting part is already behind us — and there is no rewind, only re-simulation.
      // One reload with `at` set does it, and the URL that comes out is shareable.
      const back = Math.max(0, Math.round(hit.startT - LEAD_IN));
      const u = new URL(location.href);
      u.searchParams.delete('find');
      u.searchParams.set('at', back);
      u.searchParams.set('watch', `${hit.v.team}:${hit.v.type}`);
      u.searchParams.set('wx', Math.round(hit.x));
      u.searchParams.set('wz', Math.round(hit.z));
      status.textContent = `found it at t=${Math.round(hit.startT)}s — rewinding to ${back}s…`;
      location.href = u.toString();
      return;
    }
    // Arrive PAUSED. The moment a link points at is the thing worth looking at; starting stopped
    // means it is still on screen when you get there instead of already played out.
    setPaused(true);
  })();

  return { pin, seek, seekToStuck };
}
