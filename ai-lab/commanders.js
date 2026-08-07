// AI Lab — what a PERSONA actually does.
//
// This page used to chart each archetype's choose() ladder as though that were the decision.
// It hasn't been since MissionScore became the default brain on 2026-07-18, and the drift went
// unnoticed because the ladder was HAND-COPIED from AIStrategies.js. Measured over four full
// matches (4,444 samples), what _firedRung actually reads:
//
//     weights          86.7%      <- MissionScore picks
//     home_under_fire   6.6%
//     flag_stolen       3.5%
//     flag_loose        2.5%
//     (none)            0.7%
//
// Every other rung — losing_attrition, need_parts, towers_down, gambit, clear_path, soften,
// sapper, trap, choose, benched — fired ZERO times. They sit behind !missionWeightsOn(cmd),
// and so does every persona choose().
//
// So the personas are not dead; their PLAYBOOKS are. A rogue still shapes every match, through
// PERSONA_BIAS in the scorer. That is what this page charts now.
//
// AND IT IMPORTS THE REAL VALUES. flowchart.html never rotted because it pulls DEFAULT_BRAIN
// straight from the game; this page rotted because it held a copy. Same fix: PERSONA_BIAS,
// personaWeight and each persona's own opening/roles come from AIStrategies.js, so the chart
// cannot disagree with the game again.
import { PERSONA_BIAS, personaWeight, makeDoctrine } from '../js/AIStrategies.js';

const ORDER = ['warrior', 'rogue', 'hunter', 'turtle'];
const BLURB = {
  warrior: 'Ride out, rack up kills, then break the base.',
  rogue: 'Snatch before they know you’re there. Leans on the back door and avoids brawls.',
  hunter: 'Own the field, ambush the weak, then snatch.',
  turtle: 'Hold the wall, bleed them, then sortie.',
};
const MCOLOR = {
  scout: '#7dd3fc', attack: '#ff8a6a', siege: '#ffcf6a', capture: '#9fe6b0', defend: '#b88df0',
  intercept: '#ff6a9a', scavenge: '#d9a441', harass: '#f0a0d0', sap: '#8fd3ff', trap: '#c0e070',
  refuel: '#8fa3b3', rearm: '#8fa3b3', repair: '#8fa3b3', armour: '#8fa3b3',
};
const mcol = k => MCOLOR[String(k).split('-')[0]] || '#667';
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

// The rungs that STILL pre-empt the score, with their measured share. Everything else that used
// to live on this page is gone because it never fires.
const PREEMPT = [
  { k: 'flag_stolen', pct: 3.5, cond: 'Our flag is being carried', to: 'intercept', why: 'run the thief down' },
  { k: 'flag_loose', pct: 2.5, cond: 'Our flag is lying in the field', to: 'intercept', why: 'touch it to snap it home' },
  { k: 'home_under_fire', pct: 6.6, cond: 'Our base is taking rounds (persona dice)', to: 'defend', why: 'get back and stop them' },
  { k: 'weights', pct: 86.7, cond: 'MISSIONSCORE — score all 13, take the best', to: '', why: 'the persona tilts these scores, it does not bypass them' },
];

let active = 'warrior';
let liveData = null;
let tSim = 0;              // the match clock the bias chart is drawn for

// Each persona's real opening + role table, read off a throwaway instance rather than copied.
const DOC = {};
for (const a of ORDER) {
  try { const d = makeDoctrine(a, null, () => 0.5); DOC[a] = { opening: d.opening, roles: d.roles }; }
  catch (e) { DOC[a] = { opening: '?', roles: {} }; }
}

// ---- the bias chart ---------------------------------------------------------
// For the selected archetype: every mission key it nudges, at the current match clock. A
// DIRECTIONAL key (capture-rear) collects two rows of the table — its base key AND itself — so
// the bar is drawn in two stacked parts, which is the thing that is easy to miss in a log line.
function biasRows(arch, t) {
  const PB = PERSONA_BIAS[arch] || {}, pw = personaWeight(t);
  const keys = Object.keys(PB);
  const seen = new Set(keys);
  // directional keys whose base is also biased → show the stack
  const rows = keys.map(k => {
    const base = k.split('-')[0];
    const stacked = base !== k && PB[base] != null;
    return { key: k, own: PB[k] * pw, base: stacked ? PB[base] * pw : 0, stacked };
  });
  // a base key that ONLY exists to feed directional variants still applies to all of them
  rows.sort((a, b) => (b.own + b.base) - (a.own + a.base));
  return { rows, pw, seen };
}

function drawChart() {
  const host = document.getElementById('chart');
  const { rows, pw } = biasRows(active, tSim);
  const max = Math.max(1, ...rows.map(r => Math.abs(r.own + r.base)));
  const bar = r => {
    const total = r.own + r.base;
    const neg = total < 0;
    const w = Math.abs(total) / max * 100;
    const basePct = total !== 0 ? Math.abs(r.base) / Math.abs(total) * w : 0;
    const ownPct = w - basePct;
    const c = mcol(r.key);
    return `<div class="brow">
      <div class="bk">${esc(r.key)}${r.stacked ? ' <em>×2 rows</em>' : ''}</div>
      <div class="btrack">
        <i style="width:${basePct}%;background:${c};opacity:.45"></i><i style="width:${ownPct}%;background:${c}"></i>
      </div>
      <div class="bv" style="color:${neg ? '#ff6a5a' : '#7fe0b8'}">${total >= 0 ? '+' : ''}${total.toFixed(1)}</div>
    </div>`;
  };
  const d = DOC[active] || {};
  host.innerHTML = `
    <div class="hd">WHAT STILL PRE-EMPTS THE SCORE
      <span>measured over 4 matches · 4,444 samples</span></div>
    <div class="pre">${PREEMPT.map(p => `
      <div class="prow${p.k === 'weights' ? ' w' : ''}">
        <div class="pbarwrap"><i style="width:${p.pct}%"></i></div>
        <div class="pk">${esc(p.k)}</div>
        <div class="pc">${esc(p.cond)}</div>
        <div class="pt">${p.to ? `→ <b style="color:${mcol(p.to)}">${esc(p.to)}</b>` : ''}</div>
        <div class="pp">${p.pct}%</div>
      </div>`).join('')}</div>
    <p class="note">Every other rung this page used to draw — the persona playbooks, and
      <code>towers_down</code>, <code>gambit</code>, <code>soften</code>, <code>clear_path</code>,
      <code>need_parts</code>, <code>sapper</code>, <code>trap</code>, <code>benched</code> —
      fired <b>zero</b> times. They are gated behind <code>!missionWeightsOn(cmd)</code>.</p>

    <div class="hd">${active.toUpperCase()} — HOW IT TILTS THE SCORES
      <span>PERSONA_BIAS × personaWeight(t), imported live from AIStrategies.js</span></div>
    <div class="clockrow">
      <label>match clock <b>${tSim}s</b></label>
      <input id="clock" type="range" min="0" max="400" step="5" value="${tSim}">
      <span class="pw">weight ×${pw.toFixed(2)}</span>
    </div>
    <div class="bars">${rows.map(bar).join('')}</div>
    <p class="note">The bias is multiplied by up to <b>4×</b> at kickoff and eases to plain by
      <b>240s</b> — who a commander <em>is</em> decides the opening, what the board says decides the
      rest. A directional key such as <code>capture-rear</code> matches <b>two</b> rows of the
      table (its base <code>capture</code> and itself) and collects both; the paler segment is the
      base. That stacking is why a rogue's back door can carry ~12 points before the board has
      said anything at all.</p>`;

  const slider = document.getElementById('clock');
  if (slider) slider.addEventListener('input', e => { tSim = +e.target.value; drawChart(); applyLive(); });
  drawSide();
}

// ---- side panel: the persona's own kit, then the live board -----------------
function drawSide() {
  const side = document.getElementById('side');
  const d = DOC[active] || { roles: {} };
  side.innerHTML = `
    <div class="panel-title">${active.toUpperCase()}</div>
    <div class="card"><div class="row">${esc(BLURB[active] || '')}</div></div>
    <div class="panel-title">OPENING</div>
    <div class="card"><div class="row">first mission of the match:
      <b class="to">${esc(d.opening || '?')}</b></div></div>
    <div class="panel-title">ROLE TABLE <span style="opacity:.5">which chassis for which job</span></div>
    <div class="card">${Object.entries(d.roles || {}).map(([m, v]) =>
      `<div class="cfg"><span>${esc(m)}</span><span class="v">${esc(v)}</span></div>`).join('') || '<div class="row">—</div>'}</div>
    <div class="panel-title">LIVE</div>
    <div class="card"><div class="row" id="live-row">no live game detected.</div></div>
    <div class="panel-title">THE BOARD <span style="opacity:.5">scored every re-think</span></div>
    <div id="weights-row" class="card"><div class="row">no live game detected.</div></div>`;
  applyLive();
}

// ---- live overlay ----------------------------------------------------------
function applyLive() {
  const row = document.getElementById('live-row');
  if (!row) return;
  const teams = (liveData && liveData.teams) || {};
  const mine = Object.entries(teams);
  if (!mine.length) { row.textContent = 'no live game detected — open a match to follow decisions.'; renderWeights([]); return; }
  row.innerHTML = mine.map(([team, v]) => {
    const isThis = v.archetype === active;
    return `<div style="${isThis ? '' : 'opacity:.6'}">
      <b style="color:#7dd3fc">${esc(team)}</b>
      <span style="opacity:.7">${esc(v.archetype || '?')}</span>${isThis ? ' <b style="color:#ffcf6a">◀ shown</b>' : ''}
      → <b>${esc(v.mission)}</b><br>
      <span style="opacity:.75;font-size:10.5px">${esc(v.why || '')}</span>
      <span style="opacity:.5;font-size:10px"> · rung ${esc(v.rung || '—')}</span></div>`;
  }).join('<hr style="border:none;border-top:1px dashed rgba(255,255,255,.12);margin:5px 0">');
  renderWeights(mine);
}

// The full ranked board — this IS the doctrine layer now, so it gets the space.
function renderWeights(mine) {
  const row = document.getElementById('weights-row');
  if (!row) return;
  const scored = mine.filter(([, v]) => v.scores && v.scores.length);
  if (!scored.length) {
    row.innerHTML = mine.length
      ? '<div class="row" style="opacity:.7">weights off for this commander — it is walking the legacy cascade.</div>'
      : '<div class="row">no live game detected.</div>';
    return;
  }
  row.innerHTML = scored.map(([team, v]) => {
    const top = v.scores[0][1], lo = v.scores[v.scores.length - 1][1];
    const span = Math.max(0.001, top - lo);
    const rows = v.scores.map(([k, val, terms], i) => {
      const running = k === v.mission || k.split('-')[0] === v.mission;
      const w = Math.max(2, Math.round(100 * (val - lo) / span));
      const gap = i === 1 ? ` <span style="opacity:.5">(gap ${(top - val).toFixed(1)})</span>` : '';
      // highlight the persona's own contribution inside the term list
      const tms = terms.map(([l, x]) => {
        const isBias = String(l).startsWith(v.archetype + ':') || l === v.archetype;
        return `<span style="${isBias ? 'color:#ffcf6a' : ''}">${esc(l)} ${x >= 0 ? '+' : ''}${x}</span>`;
      }).join(', ');
      return `<div style="margin:3px 0;${running ? '' : 'opacity:.72'}">
        <div style="display:flex;justify-content:space-between;font-size:11px">
          <span style="color:${running ? '#fff' : '#cfe0ee'};font-weight:${running ? 700 : 400}">
            ${running ? '▶ ' : ''}${esc(k)}</span>
          <span style="color:#7fe0b8;font-variant-numeric:tabular-nums">${val >= 0 ? '+' : ''}${val}${gap}</span>
        </div>
        <div style="height:4px;background:#0d141c;border-radius:2px;overflow:hidden;margin:2px 0">
          <div style="height:100%;width:${w}%;background:${mcol(k)}"></div></div>
        ${terms.length ? `<div style="font-size:9.5px;opacity:.62;line-height:1.35">${tms}</div>` : ''}
      </div>`;
    }).join('');
    return `<div style="margin-bottom:8px"><b style="color:#7dd3fc">${esc(team)}</b>
      <span style="opacity:.6;font-size:10px">— ${esc(v.archetype || '')}, yellow terms are its persona</span>${rows}</div>`;
  }).join('<hr style="border:none;border-top:1px dashed rgba(255,255,255,.12);margin:6px 0">');
}

function pollLive() {
  try {
    const raw = localStorage.getItem('rmrf-ai-live');
    liveData = raw ? JSON.parse(raw) : null;
    if (liveData && Date.now() - (liveData.t || 0) > 8000) liveData = null;   // stale → game closed
  } catch (e) { liveData = null; }
  applyLive();
}

// ---- boot -------------------------------------------------------------------
const tabsEl = document.getElementById('tabs');
tabsEl.innerHTML = ORDER.map(a => `<button data-a="${a}">${a.toUpperCase()}</button>`).join('');
function syncTabs() { tabsEl.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.a === active)); }
tabsEl.addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  active = b.dataset.a; syncTabs(); drawChart();
});
syncTabs();
drawChart();
setInterval(pollLive, 400);
window.addEventListener('storage', pollLive);
