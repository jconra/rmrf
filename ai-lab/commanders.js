// AI Lab — Commander decision flows. Hand-authored from the REAL logic in
// rmrf/js/AIStrategies.js (Doctrine.tick + each persona's choose()), rendered as a
// per-commander priority ladder. The shared "universal" rungs run for every persona and
// PREEMPT its playbook; the persona rungs are that archetype's own choose().
//
// KEEP IN SYNC: if AIStrategies.js changes, update UNIVERSAL / PERSONA below. Each rung's
// `why` is copied from the code's own decision string so the chart reads like the log.
//
// LIVE OVERLAY: polls localStorage 'rmrf-ai-live' (published cheaply by the game on each
// mission switch — no per-frame cost) and highlights the rung the active commander is on.

// Mission palette (by intent) — matches the unit-brain chart's colour language.
const MCOLOR = {
  intercept: '#c0392b', attack: '#c0392b', harass: '#cf6f3a', siege: '#cf6f3a',
  defend: '#caa23a', scavenge: '#caa23a', capture: '#3a8f6f', scout: '#2e8fb0',
  sap: '#8e44ad', trap: '#8e44ad',
};

// The shared ladder every commander runs FIRST (Doctrine.tick), top = highest priority.
const UNIVERSAL = [
  { cond: 'Our flag stolen\n(and we’re not carrying theirs)?', mission: 'intercept', why: 'run the thief down' },
  { cond: 'Losing the attrition war\n(and flag not grabbable)?', mission: 'defend', why: 'preserve what we have left' },
  { cond: 'Home under fire?\n(persona dice: turtle 1.0 → rogue 0.25)', mission: 'defend', why: 'get back and stop them' },
  { cond: 'Can win by capture but\nno runner and no parts?', mission: 'scavenge', why: 'go collect salvage to build one' },
  { cond: 'Their towers down,\nflag not yet exposed?', mission: 'siege', why: 'crack the HQ while it’s open' },
  { cond: 'Stalemate gambit armed\n(and flag not grabbable)?', mission: 'siege', why: 'the rear-door Valkyrie gambit' },
  { cond: 'Runner’s killer still alive?\n(clear-path timer)', mission: 'attack', why: 'clear the interceptor first' },
  { cond: 'Towers keep killing runners?\n(soften timer)', mission: 'siege', why: 'silence the guns before retry' },
  { cond: 'Opening sapper rolled\n(and not done)?', mission: 'sap', why: 'flank recon + mines' },
  { cond: 'Hunter trap armed\n(and not sprung)?', mission: 'trap', why: 'tend the bait trap' },
];

// Each persona's own choose() (runs only if NOTHING above fired).
const PERSONA = {
  warrior: {
    blurb: 'Ride out, rack up kills, then break the base.',
    opening: 'attack',
    roles: { scout: 'lurcher', attack: 'lurcher', siege: 'jotun', defend: 'lurcher', capture: 'firebrat' },
    choose: [
      { cond: 'Flag grabbable?', mission: 'capture', why: 'go take it' },
      { cond: 'Killed 2+ OR enemy eliminated?', mission: 'siege', why: 'proved it — break the base' },
      { cond: 'Otherwise', mission: 'attack', why: 'ride out and fight' },
    ],
  },
  rogue: {
    blurb: 'Snatch before they know you’re there — Valkyrie softens from range, Firebrat races in. Avoids brawls.',
    opening: 'siege',
    roles: { scout: 'firebrat', attack: 'valkyrie', siege: 'valkyrie', defend: 'valkyrie', capture: 'firebrat' },
    choose: [
      { cond: 'Flag grabbable?', mission: 'capture', why: 'race in — it’s open' },
      { cond: 'Otherwise', mission: 'siege', why: 'quietly crack the HQ from range' },
    ],
  },
  hunter: {
    blurb: 'Own the field, ambush the weak, then snatch. Reserves Firebrats for the grab.',
    opening: 'scout',
    roles: { scout: 'valkyrie', attack: 'lurcher', siege: 'valkyrie', defend: 'lurcher', capture: 'firebrat' },
    choose: [
      { cond: 'Flag grabbable?', mission: 'capture', why: 'go take it' },
      { cond: 'Enemy eliminated?', mission: 'siege', why: 'no one to hunt — press the base' },
      { cond: 'Enemy unknown AND\nmap < 80% explored?', mission: 'scout', why: 'recon with the Valkyrie' },
      { cond: 'No contact, OR contact\nhugging their base? (harass on)', mission: 'harass', why: 'make their half loud, flush reveals' },
      { cond: 'Otherwise', mission: 'attack', why: 'hunt what roams the field' },
    ],
  },
  turtle: {
    blurb: 'Hold the wall, bleed them, then sortie. Only pushes once it’s beaten attackers back.',
    opening: 'defend',
    roles: { scout: 'lurcher', attack: 'lurcher', siege: 'valkyrie', defend: 'lurcher', capture: 'firebrat' },
    choose: [
      { cond: 'Flag grabbable?', mission: 'capture', why: 'go take it' },
      { cond: 'This guard has 2+ kills AND\nenemy fleet is weaker?', mission: 'siege', why: 'proved from strength — sortie' },
      { cond: 'Otherwise', mission: 'defend', why: 'hold under tower cover' },
    ],
  },
};

// ---- SVG ladder renderer ----------------------------------------------------
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const tspans = (text, x, dy0 = 0, lh = 13) => esc(text).split('\n')
  .map((ln, i) => `<tspan x="${x}" dy="${i === 0 ? dy0 : lh}">${ln}</tspan>`).join('');

const DIA_CX = 210, DIA_W = 300, DIA_H = 74, ST_X = 470, ST_W = 220, ST_H = 54;
const Y0 = 96, ROW_H = 104, ENTRY_Y = 20;

function renderLadder(archetype) {
  const p = PERSONA[archetype];
  // rungs = shared universal ladder + this persona's choose(), tagged by source.
  const rungs = [
    ...UNIVERSAL.map(r => ({ ...r, src: 'shared' })),
    ...p.choose.map(r => ({ ...r, src: 'persona' })),
  ];
  const n = rungs.length;
  const W = ST_X + ST_W + 30, H = Y0 + n * ROW_H + 20;
  const out = [`<defs>
    <marker id="ah" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#8aa0b4"/></marker>
    </defs>`];

  out.push(`<rect x="${DIA_CX - 90}" y="${ENTRY_Y}" width="180" height="34" rx="17" fill="#1b2a3a" stroke="#4a6580"/>
    <text x="${DIA_CX}" y="${ENTRY_Y + 22}" text-anchor="middle" font-size="12" fill="#cfe0ee" letter-spacing="2">EACH TICK</text>`);
  out.push(`<path d="M${DIA_CX},${ENTRY_Y + 34} L${DIA_CX},${Y0 - DIA_H / 2}" stroke="#8aa0b4" fill="none" marker-end="url(#ah)"/>`);

  rungs.forEach((r, i) => {
    const cy = Y0 + i * ROW_H, last = i === n - 1;
    const isPersona = r.src === 'persona';
    const dFill = isPersona ? '#1a2733' : '#15212e';
    const dStroke = isPersona ? '#5a7fa0' : '#3d566e';
    // diamond (condition)
    out.push(`<polygon data-mission="${r.mission}" points="${DIA_CX},${cy - DIA_H / 2} ${DIA_CX + DIA_W / 2},${cy} ${DIA_CX},${cy + DIA_H / 2} ${DIA_CX - DIA_W / 2},${cy}" fill="${dFill}" stroke="${dStroke}"/>
      <text x="${DIA_CX}" y="${cy}" text-anchor="middle" font-size="11" fill="#dfe8ef">${tspans(r.cond, DIA_CX, -((r.cond.split('\n').length - 1) * 6.5))}</text>`);
    // YES -> mission box
    const c = MCOLOR[r.mission] || '#556';
    out.push(`<path d="M${DIA_CX + DIA_W / 2},${cy} L${ST_X},${cy}" stroke="#8aa0b4" fill="none" marker-end="url(#ah)"/>
      <text x="${(DIA_CX + DIA_W / 2 + ST_X) / 2}" y="${cy - 6}" text-anchor="middle" font-size="10" fill="#7fd08a">yes</text>`);
    out.push(`<rect data-mission="${r.mission}" x="${ST_X}" y="${cy - ST_H / 2}" width="${ST_W}" height="${ST_H}" rx="6" fill="${c}22" stroke="${c}"/>
      <text x="${ST_X + ST_W / 2}" y="${cy - 4}" text-anchor="middle" font-size="13" fill="#fff" font-weight="bold" letter-spacing="1">${esc(r.mission.toUpperCase())}</text>
      <text x="${ST_X + ST_W / 2}" y="${cy + 13}" text-anchor="middle" font-size="9.5" fill="#cfe0ee">${esc(r.why || '')}</text>`);
    // NO -> next rung
    if (!last) out.push(`<path d="M${DIA_CX},${cy + DIA_H / 2} L${DIA_CX},${cy + ROW_H - DIA_H / 2}" stroke="#8aa0b4" fill="none" marker-end="url(#ah)"/>
      <text x="${DIA_CX + 14}" y="${cy + ROW_H / 2}" font-size="10" fill="#c98">no</text>`);
  });

  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${out.join('')}</svg>`;
}

// ---- tabs + side panel ------------------------------------------------------
const ORDER = ['warrior', 'rogue', 'hunter', 'turtle'];
let active = 'warrior';

function sidePanel(archetype) {
  const p = PERSONA[archetype];
  const roles = Object.entries(p.roles).map(([k, v]) => `<div class="cfg"><span>${k}</span><span class="v">${v}</span></div>`).join('');
  return `<div class="panel-title">${archetype.toUpperCase()}</div>
    <div class="card"><div class="row">${esc(p.blurb)}</div>
      <div class="row" style="margin-top:6px">opening mission: <span class="to">${p.opening}</span></div></div>
    <div class="panel-title">Vehicle role table</div>${roles}
    <div class="panel-title">Live</div>
    <div class="card" id="live-card"><div class="row" id="live-row">no live game detected — open a match to follow decisions.</div></div>
    <div class="legend"><i style="background:#5a7fa0"></i>persona rungs (this archetype)&nbsp;
      <i style="background:#3d566e"></i>shared rungs (every commander)</div>`;
}

function draw() {
  document.getElementById('tabs').querySelectorAll('button').forEach(b =>
    b.classList.toggle('on', b.dataset.a === active));
  document.getElementById('chart').innerHTML = renderLadder(active);
  document.getElementById('side').innerHTML = sidePanel(active);
  applyLive();
}

// ---- live overlay (cheap: reads localStorage the game writes on mission switch)
let liveData = null;
function applyLive() {
  const row = document.getElementById('live-row');
  if (!row) return;
  const mine = liveData && liveData.teams
    ? Object.entries(liveData.teams).filter(([, v]) => v.archetype === active) : [];
  // dim all mission boxes, then light the active ones
  document.querySelectorAll('#chart [data-mission]').forEach(el => el.style.filter = '');
  if (!mine.length) { row.textContent = 'no live game detected — open a match to follow decisions.'; return; }
  row.innerHTML = mine.map(([team, v]) =>
    `<b style="color:#7dd3fc">${team}</b> → <b>${esc(v.mission)}</b><br><span style="opacity:.75">${esc(v.why || '')}</span>`).join('<hr style="border:none;border-top:1px dashed rgba(255,255,255,.12);margin:5px 0">');
  const on = new Set(mine.map(([, v]) => v.mission));
  document.querySelectorAll('#chart rect[data-mission]').forEach(el => {
    if (on.has(el.dataset.mission)) el.style.filter = 'drop-shadow(0 0 7px #fff) brightness(1.5)';
  });
}
function pollLive() {
  try {
    const raw = localStorage.getItem('rmrf-ai-live');
    liveData = raw ? JSON.parse(raw) : null;
    // stale after 8s (game closed) → treat as gone
    if (liveData && Date.now() - (liveData.t || 0) > 8000) liveData = null;
  } catch (e) { liveData = null; }
  applyLive();
}

// ---- boot -------------------------------------------------------------------
const tabsEl = document.getElementById('tabs');
tabsEl.innerHTML = ORDER.map(a => `<button data-a="${a}">${a.toUpperCase()}</button>`).join('');
tabsEl.addEventListener('click', e => { const b = e.target.closest('button'); if (b) { active = b.dataset.a; draw(); } });
draw();
setInterval(pollLive, 400);
window.addEventListener('storage', pollLive);   // instant cross-tab update
