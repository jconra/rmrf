// AI Lab — Phase 1: render the game's REAL unit-brain decision graph as a 2D
// flowchart. Imports DEFAULT_BRAIN straight from the game so this is always the
// actual AI, not a copy. Read-only for now (editing + step-through come next).
import { DEFAULT_BRAIN } from '../js/AI.js';

// --- presentation metadata (lab-side, so the game graph stays lean data) -----
// Human labels for condition keys; falls back to the raw key if unlisted.
const COND_LABEL = {
  mustGo:       'Still inside\nthe gate?',
  hurtLatched:  'Hurt — pulling\nout to repair?',
  resupLatched: 'Out of ammo\nor fuel?',
  engaging:     'Enemy in\nsight?',
  threatened:   'Tower shelling\nme (have ammo)?',
  pursuing:     'Chasing a\nrecent sighting?',
  shootGoal:    'Goal is a\nfortress?',
  always:       'Otherwise',
};
const STATE_DESC = {
  exit:     'Pivot to the gate,\nthen drive out',
  retreat:  'Fall back to base,\nrepair',
  resupply: 'Head home to\nrearm + refuel',
  engage:   'Hold at range,\nduel the rival',
  suppress: 'Flank + silence\nthe turret',
  pursue:   'Hunt the last\nsighting',
  assault:  'Shell the fortress\nfrom reach',
  advance:  'Push toward\nthe objective',
  unstick:  'Reverse + pivot\nto break free',
};
// Behavior-group colours.
const STATE_COLOR = {
  exit: '#2e6fc0', advance: '#2e6fc0', pursue: '#3a8f6f',
  engage: '#c0392b', suppress: '#c0392b', assault: '#cf6f3a',
  retreat: '#caa23a', resupply: '#caa23a', unstick: '#8e44ad',
};
const COND_TEXT = {
  resupNeeded: 'ammo empty, or fuel < fuelLow',
  resupDone:   'ammo > ammoFull and fuel > fuelFull',
  hurtNeeded:  'hp < bail  (bailBase - aggression*bailAggr)',
  hurtDone:    'hp > hurtClear',
};
// Plain-language help for the cryptic config knobs (click-to-reveal in the panel).
const CONFIG_HELP = {
  stillEps:     'Movement below this (world units/tick) counts as "not moving" — feeds the anti-wedge reflex.',
  stillLimit:   'Seconds of trying-but-not-moving before the unstick jolt fires.',
  unstickDur:   'How long the reverse + pivot jolt lasts (seconds).',
  unstickRev:   'Reverse throttle (0..1) during the jolt.',
  exitAlign:    'Heading error (radians) under which EXIT stops pivoting and drives straight out the gate.',
  exitTurnGain: 'Steering gain while lining up on the gate (higher = snappier turn).',
  bailBase:     'Base of the retreat threshold:  bail = bailBase − aggression·bailAggr.',
  bailAggr:     'How much aggression lowers the retreat threshold (braver brains hold on longer).',
  hurtClear:    'HP fraction that clears the retreat latch (repaired enough to re-commit).',
  fuelLow:      'Fuel fraction that trips the resupply latch.',
  fuelFull:     'Fuel fraction that clears the resupply latch.',
  ammoFull:     'Ammo fraction that clears the resupply latch.',
};
// Tooltip (hover) text for the chart's condition diamonds + state boxes.
const COND_DESC = {
  mustGo:       'view.mustGo — still inside the FOB gate; must clear it first.',
  hurtLatched:  '_hurt latch set (hp dropped below bail) — forces retreat until repaired.',
  resupLatched: '_resup latch set (out of ammo, or fuel below fuelLow).',
  engaging:     'A rival is visible AND (aggression > 0.35 OR hp > 0.4).',
  threatened:   'A wall-turret is shelling us, we have ammo, and hp is above bail.',
  pursuing:     'Saw a rival recently (within 3 + aggression·5 s) AND aggression > 0.6.',
  shootGoal:    'The current goal is a fortification to assault.',
  always:       'Fallback when nothing above matched.',
};
// Which state each latch flag forces (derived from the transition table).
function latchTarget(flag, g) {
  const condByFlag = { _hurt: 'hurtLatched', _resup: 'resupLatched' };
  const t = g.transitions.find(tr => tr.when === condByFlag[flag]);
  return t ? t.mode : '?';
}

// --- tiny SVG string helpers -------------------------------------------------
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
function lines(text, x, y, cls, lh = 15) {
  return esc(text).split('\n').map((ln, i) =>
    `<tspan x="${x}" dy="${i === 0 ? 0 : lh}">${ln}</tspan>`).join('');
}

// Layout constants.
const DIA_CX = 200, DIA_W = 210, DIA_H = 70;
const ST_X = 430, ST_W = 250, ST_H = 60;
const Y0 = 120, ROW_H = 100, ENTRY_Y = 24;

function renderChart(g) {
  const tr = g.transitions;
  const n = tr.length;
  const W = ST_X + ST_W + 40;
  const H = Y0 + n * ROW_H + 30;
  const parts = [];

  // arrowhead markers
  parts.push(`<defs>
    <marker id="ah" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto">
      <path d="M0,0 L7,3 L0,6 Z" fill="#8aa0b4"/></marker>
    <marker id="ahY" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto">
      <path d="M0,0 L7,3 L0,6 Z" fill="#5fd08a"/></marker>
  </defs>`);

  // entry node
  parts.push(`<rect x="${DIA_CX - 75}" y="${ENTRY_Y}" width="150" height="38" rx="19"
    fill="#1b2a3a" stroke="#4a6580"/>
    <text x="${DIA_CX}" y="${ENTRY_Y + 24}" text-anchor="middle" font-size="12"
      fill="#cfe0ee" letter-spacing="2">TICK START</text>`);

  // entry -> first diamond
  const firstTop = Y0 - DIA_H / 2;
  parts.push(`<path d="M${DIA_CX},${ENTRY_Y + 38} L${DIA_CX},${firstTop}"
    stroke="#8aa0b4" fill="none" marker-end="url(#ah)"/>`);

  tr.forEach((t, i) => {
    const cy = Y0 + i * ROW_H;
    const isLast = i === n - 1;
    // diamond
    const top = `${DIA_CX},${cy - DIA_H / 2}`, right = `${DIA_CX + DIA_W / 2},${cy}`;
    const bot = `${DIA_CX},${cy + DIA_H / 2}`, left = `${DIA_CX - DIA_W / 2},${cy}`;
    parts.push(`<polygon points="${top} ${right} ${bot} ${left}"
      fill="#15212e" stroke="#3d566e"><title>${esc(t.when)}: ${esc(COND_DESC[t.when] || '')}</title></polygon>
      <text x="${DIA_CX}" y="${cy - 4}" text-anchor="middle" font-size="11.5" fill="#dfe8ef"
        style="pointer-events:none">
        ${lines(COND_LABEL[t.when] || t.when, DIA_CX, cy - 4)}</text>`);

    // YES branch -> state box (right)
    const col = STATE_COLOR[t.mode] || '#556';
    const by = cy - ST_H / 2;
    parts.push(`<path d="M${DIA_CX + DIA_W / 2},${cy} L${ST_X},${cy}"
      stroke="#5fd08a" fill="none" marker-end="url(#ahY)"/>
      <text x="${(DIA_CX + DIA_W / 2 + ST_X) / 2}" y="${cy - 6}" text-anchor="middle"
        font-size="9" fill="#5fd08a">yes</text>`);
    const beh = (g.states[t.mode] || {}).behavior || '?';
    parts.push(`<rect x="${ST_X}" y="${by}" width="${ST_W}" height="${ST_H}" rx="6"
      fill="${col}22" stroke="${col}"><title>${esc(t.mode)} — runs behavior "${esc(beh)}", aims at ${esc(t.target)}</title></rect>
      <rect x="${ST_X}" y="${by}" width="6" height="${ST_H}" rx="3" fill="${col}" style="pointer-events:none"/>
      <text x="${ST_X + 16}" y="${by + 22}" font-size="13" font-weight="bold" fill="#fff"
        letter-spacing="1">${esc(t.mode.toUpperCase())}</text>
      <text x="${ST_X + 16}" y="${by + 38}" font-size="9.5" fill="#cdd8e2">
        ${lines(STATE_DESC[t.mode] || '', ST_X + 16, by + 38, '', 12)}</text>
      <text x="${ST_X + ST_W - 8}" y="${by + 14}" text-anchor="end" font-size="8.5"
        fill="#9fb2c4" opacity="0.8">aim: ${esc(t.target)}</text>`);

    // NO branch -> next diamond
    if (!isLast) {
      const nextTop = Y0 + (i + 1) * ROW_H - DIA_H / 2;
      parts.push(`<path d="M${DIA_CX},${cy + DIA_H / 2} L${DIA_CX},${nextTop}"
        stroke="#8aa0b4" fill="none" marker-end="url(#ah)"/>
        <text x="${DIA_CX + 12}" y="${cy + DIA_H / 2 + 16}" font-size="9" fill="#8aa0b4">no</text>`);
    }
  });

  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"
    font-family="'Courier New',monospace">${parts.join('')}</svg>`;
}

function renderSide(g) {
  const h = [];
  // Events / interrupts
  h.push(`<div class="panel-title">INTERRUPTS</div>`);
  h.push(`<div class="card">
    <div class="hd">Anti-wedge <span class="tag">reflex</span></div>
    <div class="row">If it keeps trying to move but is stuck for &gt; <b>${g.config.stillLimit}s</b>,
      jolt free: reverse + hard pivot for <b>${g.config.unstickDur}s</b>.
      <span class="to">Preempts everything.</span></div></div>`);
  for (const L of g.latches) {
    const mode = latchTarget(L.flag, g);
    h.push(`<div class="card">
      <div class="hd">${esc(L.flag)} <span class="tag">latch -&gt; ${esc(mode)}</span></div>
      <div class="row"><b>trip:</b> ${esc(COND_TEXT[L.trip] || L.trip)}</div>
      <div class="row"><b>clear:</b> ${esc(COND_TEXT[L.clear] || L.clear)}</div>
      <div class="row">Holds (hysteresis) until cleared, forcing
        <span class="to">${esc(mode)}</span>.</div></div>`);
  }

  // Config drawer — each row is click-to-reveal a plain-language description.
  h.push(`<details open><summary>CONFIG <span style="opacity:.45;font-size:9px">(click a row)</span></summary><div style="margin-top:6px">`);
  for (const [k, v] of Object.entries(g.config)) {
    h.push(`<div class="cfg" data-cfg="${k}"><span>${esc(k)}</span><span class="v">${esc(v)}</span></div>
      <div class="cfgdesc" id="d_${k}">${esc(CONFIG_HELP[k] || 'no description yet')}</div>`);
  }
  h.push(`</div></details>`);

  // Legend
  h.push(`<div class="panel-title">LEGEND</div><div class="legend">
    <div><i style="background:#2e6fc0"></i> move / navigate</div>
    <div><i style="background:#c0392b"></i> fight a unit / turret</div>
    <div><i style="background:#cf6f3a"></i> assault a fortress</div>
    <div><i style="background:#caa23a"></i> survive (retreat / resupply)</div>
    <div><i style="background:#8e44ad"></i> reflex (unstick)</div>
    <div style="margin-top:6px">Conditions are checked <b>top-to-bottom</b>; first match wins.</div>
  </div>`);
  return h.join('');
}

const g = DEFAULT_BRAIN;
document.getElementById('chart').innerHTML = renderChart(g);
document.getElementById('side').innerHTML = renderSide(g);

// Config rows: click to reveal/hide their plain-language description.
document.getElementById('side').addEventListener('click', e => {
  const row = e.target.closest('.cfg'); if (!row) return;
  const d = document.getElementById('d_' + row.dataset.cfg);
  if (d) d.classList.toggle('open');
});
