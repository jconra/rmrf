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

export function initReplay(RR, QS, host) {
  const ui = host || document.body;
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
    RR.setTimeScale(0);
    const ticks = Math.round(seconds / 0.05);
    try {
      for (let done = 0; done < ticks; done += SEEK_CHUNK) {
        const n = Math.min(SEEK_CHUNK, ticks - done);
        for (let i = 0; i < n; i++) {
          if (RR.matchOver) return;                      // match ended — stop, don't run past it
          RR.stepField(0.05, 1); RR.tickFlags && RR.tickFlags(0.05);
        }
        if (say) say(`seeking… ${Math.round((done + n) * 0.05)}s of ${Math.round(seconds)}s`);
        await new Promise(r => setTimeout(r, 0));
      }
    } finally { seeking = false; RR.setTimeScale(paused ? 0 : playSpeed); }
  }

  // Roll forward until a unit stops making progress toward a goal it is still far from — exactly
  // the condition the tournament counts as TRANSIT-stuck. Returns the offender, or null.
  async function seekToStuck(say, { minSecs = 20, maxSecs = 1200 } = {}) {
    if (seeking) return null;
    seeking = true;
    RR.setTimeScale(0);
    const mark = new Map();
    try {
      for (let t = 0; t < maxSecs; t++) {
        if (RR.matchOver) { if (say) say('the match ended before anything got stuck'); return null; }
        for (let i = 0; i < 20; i++) { RR.stepField(0.05, 1); RR.tickFlags && RR.tickFlags(0.05); }
        for (const c of RR.commanders) for (const sl of (c._slots || [])) {
          const v = sl.unit;
          if (!v || v.dead) { mark.delete(sl); continue; }
          const p = v.holder.position, d = sl._dbg || {};
          const gd = d.gx != null ? Math.hypot(d.gx - p.x, d.gz - p.z) : 0;
          let m = mark.get(sl);
          if (!m || m.v !== v || Math.hypot(p.x - m.x, p.z - m.z) > 20) { mark.set(sl, { v, x: p.x, z: p.z, run: 0 }); continue; }
          m.run++;
          if (gd > 15 && m.run >= minSecs) return v;
        }
        if (t % 10 === 0) { if (say) say(`scanning for a stuck unit… t=${Math.round(RR.matchTime())}s`); await new Promise(r => setTimeout(r, 0)); }
      }
      return null;
    } finally { seeking = false; RR.setTimeScale(paused ? 0 : playSpeed); }
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
    if (!seeking) RR.setTimeScale(on ? 0 : playSpeed);
    playBtn.textContent = on ? '▶' : '❚❚';
  };
  const oneTick = () => { setPaused(true); RR.stepField(0.05, 1); RR.tickFlags && RR.tickFlags(0.05); };

  const playBtn = btn('❚❚', 'play / pause  (space)', () => setPaused(!paused));
  btn('▸|', 'advance one physics tick  (.)', oneTick);
  const speeds = [];
  for (const sp of [0.1, 0.25, 0.5, 1, 2]) {
    const b = btn(sp + '×', `run at ${sp}× speed`, () => {
      playSpeed = sp; if (!paused && !seeking) RR.setTimeScale(sp);
      speeds.forEach(o => o.classList.toggle('on', o === b));
    });
    speeds.push(b); if (sp === 1) b.classList.add('on');
  }
  btn('⇥ next stuck', 'roll forward to the next unit that stops making progress', async () => {
    const v = await seekToStuck(s => status.textContent = s);
    if (v) pin(v);
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
      // A link's timestamp is where the episode BEGAN; units die and redeploy, so the named unit
      // may not be fielded at that exact second. Roll forward until it turns up near the spot the
      // report recorded — otherwise the link is only as good as the clock.
      let { best, bestD } = look();
      for (let extra = 0; extra < 120 && (!best || (wx != null && bestD > 40)); extra += 2) {
        await seek(2);
        ({ best, bestD } = look());
      }
      if (best) { pin(best); status.textContent = `watching ${best.team} ${best.type}` + (wx != null ? ` · ${Math.round(bestD)}u from the reported spot` : ''); }
      else status.textContent = `${wantWatch} never appeared near that spot`;
    }

    if (QS.get('find') === 'stuck') {
      const v = await seekToStuck(s => status.textContent = s);
      if (v) pin(v);
    }
  })();

  return { pin, seek, seekToStuck };
}
