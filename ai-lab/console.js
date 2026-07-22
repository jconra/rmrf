// AI LAB · DECISION SPINE — the live decision as a downward stack of rows. Each layer is a
// horizontally draggable row of sibling options; the one that fired animates to CENTER under its
// parent, so reading straight down the middle gives the path:
//   PERSONA → DOCTRINE rung → MISSION sub-behavior → UNIT BRAIN transition.
// Reads localStorage 'rmrf-ai-live' (game publishes ~2.5 Hz). No game import, no per-frame cost.
// Backgrounding the game tab stops the writes = the spine freezes on the last snapshot (pause &
// read). Rows are built once; only the active card + centering change, so a manual drag holds
// until the next real decision.
//
// KEEP IN SYNC with rmrf/js: AIStrategies.js (doctrine rungs + persona choose), the mission
// sub-behaviours (objective()/label()), and AI.js DEFAULT_BRAIN.transitions.

// ---- palettes ---------------------------------------------------------------
const MCOLOR = { intercept:'#c0392b', attack:'#c0392b', harass:'#cf6f3a', siege:'#cf6f3a',
  defend:'#caa23a', scavenge:'#caa23a', capture:'#3a8f6f', scout:'#2e8fb0', sap:'#8e44ad', trap:'#8e44ad' };
const STATE_COLOR = { engage:'#e0645a', suppress:'#e0645a', assault:'#e0645a', pursue:'#e0975a',
  advance:'#5a9fe0', exit:'#5a9fe0', flee:'#e0c65a', retreat:'#e0c65a', resupply:'#e0c65a' };
const ACOLOR = { warrior:'#c0392b', rogue:'#8e44ad', hunter:'#2e8fb0', turtle:'#caa23a' };
const mcol = m => MCOLOR[m] || '#7a8a99';
const scol = s => STATE_COLOR[s] || '#7a8a99';
const acol = a => ACOLOR[a] || '#7a8a99';
const esc = s => String(s).replace(/[&<>]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;' }[c]));

// ---- vehicle silhouettes (top-down, nose UP; rotated to the live heading) ----
const VEH_SHAPE = {
  lurcher:  '<line x1="7" y1="20" x2="33" y2="20"/><line x1="13.5" y1="8.7" x2="26.5" y2="31.3"/><line x1="13.5" y1="31.3" x2="26.5" y2="8.7"/><circle cx="20" cy="20" r="5.5"/><rect x="18.5" y="6" width="3" height="10" rx="1"/>',
  firebrat: '<path d="M20 5 L27 30 L20 25 L13 30 Z"/>',
  valkyrie: '<rect x="19" y="8" width="2" height="20"/><path d="M20 9 L34 27 L20 21 L6 27 Z"/>',
  jotun:    '<rect x="10" y="15" width="20" height="16" rx="2"/><rect x="17.5" y="3" width="5" height="14" rx="1"/><circle cx="20" cy="23" r="4"/>',
};
function vehicleSVG(type, headingRad, color) {
  const deg = typeof headingRad === 'number' ? -headingRad * 180 / Math.PI : 0;   // world forward → screen
  const shape = VEH_SHAPE[type] || '<circle cx="20" cy="20" r="9"/>';
  return `<svg viewBox="0 0 40 40" style="filter:drop-shadow(0 0 4px ${color})">
    <g transform="rotate(${deg} 20 20)" fill="${color}55" stroke="${color}" stroke-width="1.5" stroke-linejoin="round">${shape}
      <line x1="20" y1="14" x2="20" y2="1" stroke="${color}" stroke-width="1" opacity="0.7"/></g></svg>`;
}
const hpColor = p => p == null ? '#888' : p > 50 ? '#5ae08a' : p > 25 ? '#e0c65a' : '#e0645a';
function bar(label, pct, col) {
  const p = pct == null ? 0 : pct;
  return `<div class="bar"><span class="blab">${label}</span>
    <div class="btrack"><div class="bfill" style="width:${p}%;background:${col};box-shadow:0 0 7px ${col}"></div></div>
    <span class="bval">${pct == null ? '—' : p + '%'}</span></div>`;
}
function topPanel(data) {
  const u = (data.units || [])[0];
  if (!u) return '<div class="none">no unit fielded — deploying…</div>';
  const acc = data.color || acol(data.archetype);   // real in-game team colour (v405+); archetype palette as fallback
  const g = data.dbg || {};
  const hdg = typeof u.heading === 'number' ? Math.round(((-u.heading * 180 / Math.PI) % 360 + 360) % 360) : null;
  const more = (data.units.length > 1) ? ` +${data.units.length - 1}` : '';
  const st = u.ctrl === 'recall' ? 'RECALLED → base' : u.ctrl === 'rising' ? 'DEPLOYING ↑' : u.state;
  const stCol = u.ctrl === 'recall' ? '#e0b45a' : u.ctrl === 'rising' ? '#5ad0e0' : scol(u.state);
  // the state's OBJECT — what it's acting on (duelling whom, shelling what, headed where)
  const det = (u.ctrl !== 'recall' && u.ctrl !== 'rising' && u.detail) ? u.detail : '';
  return `<div class="veh">
      <div class="silhouette">${vehicleSVG(u.type, u.heading, acc)}</div>
      <div class="vlabel">${esc(u.type)}${more}<span style="color:${stCol}">${esc(st)}</span></div>
    </div>
    <div class="bars">
      ${bar('HP', u.hp, hpColor(u.hp))}
      ${bar('FUEL', u.fuel, '#5ad0e0')}
      ${bar('AMMO', u.ammo, '#e0b45a')}
      ${u.shield != null ? bar('SHLD', u.shield, '#7da0ff') : ''}
    </div>
    <div class="tstats">
      ${det ? `<div class="stdet" style="color:${stCol}">${esc(st)} — ${esc(det)}</div>` : ''}
      <div>fleet <b>${data.fleet != null ? data.fleet : '—'}</b>${data.comp ? ` <span style="opacity:.8">(${esc(data.comp)})</span>` : ''} · fob <b>${g.distFob != null ? g.distFob + 'u' : '—'}</b></div>
      <div>heading <b>${hdg != null ? hdg + '°' : '—'}</b> · goal <b>${g.gd != null ? g.gd + 'u' : '—'}</b>${g.navPath ? ` · path ${g.navPath}` : ''}</div>
      <div>fof <b style="color:${g.fof == null ? '#888' : g.fof > 0 ? '#7fffb8' : '#ff9d7f'}">${g.fof != null ? (g.fof > 0 ? '+' : '') + g.fof : '—'}</b> · blk ${esc(g.blk || '···')} · drive ${g.fwd != null ? g.fwd + '/' + g.turn : '—'}</div>
      <div>${g.foeT ? `foe <b>${esc(g.foeT)}</b> ${g.foeD}u` : (g.heard ? 'heard a contact' : 'no contact')}${g.turD != null ? ` · tower ${g.turD}u` : ''}</div>
      ${g.stuck ? `<div style="color:#ffb030">⚠ STUCK ${g.stuck}s — ${esc(g.stuckWhy || '')}</div>` : ''}
      <div>knows: ${esc(data.known || 'none')}${g.atHome ? ' · at base' : ''}</div>
    </div>`;
}

// ---- L1 PERSONA -------------------------------------------------------------
const PERSONA_CARDS = [
  { a:'warrior', blurb:'ride out, rack up kills, then break the base' },
  { a:'rogue',   blurb:'snatch before they know you’re there; avoids brawls' },
  { a:'hunter',  blurb:'own the field, ambush the weak, then snatch' },
  { a:'turtle',  blurb:'hold the wall, bleed them, then sortie' },
];

// ---- L2 DOCTRINE — shared universal rungs (keyed to AIStrategies fk) + persona choose --------
const UNIVERSAL = [
  { key:'flag_stolen',     cond:'Our flag stolen?', mission:'intercept', why:'run the thief down' },
  { key:'flag_loose',      cond:'Our flag dropped\nin the field?', mission:'intercept', why:'touch it to snap it home' },
  { key:'losing_attrition',cond:'Losing the attrition war?', mission:'defend', why:'preserve what we have left' },
  { key:'home_under_fire', cond:'Home under fire?\n(persona dice)', mission:'defend', why:'get back and stop them' },
  { key:'need_parts',      cond:'Can win by capture but\nno runner + no parts?', mission:'scavenge', why:'collect salvage to build one' },
  { key:'towers_down',     cond:'Their towers down,\nflag not exposed?', mission:'siege', why:'crack the HQ while it’s open' },
  { key:'gambit',          cond:'Stalemate gambit armed?', mission:'siege', why:'the rear-door Valkyrie gambit' },
  { key:'clear_path',      cond:'Runner’s killer still alive?', mission:'attack', why:'clear the interceptor first' },
  { key:'soften',          cond:'Towers keep killing runners?', mission:'siege', why:'silence the guns before retry' },
  { key:'sapper',          cond:'Opening sapper rolled?', mission:'sap', why:'flank recon + mines' },
  { key:'trap',            cond:'Hunter trap armed?', mission:'trap', why:'tend the bait trap' },
];
const PERSONA_CHOOSE = {
  warrior: [ { cond:'Flag grabbable?', mission:'capture', why:'go take it' },
    { cond:'Killed 2+ / enemy gone?', mission:'siege', why:'proved it — break the base' },
    { cond:'Otherwise', mission:'attack', why:'ride out and fight' } ],
  rogue: [ { cond:'Flag grabbable?', mission:'capture', why:'race in — it’s open' },
    { cond:'Otherwise', mission:'siege', why:'quietly crack the HQ from range' } ],
  hunter: [ { cond:'Flag grabbable?', mission:'capture', why:'go take it' },
    { cond:'Enemy eliminated?', mission:'siege', why:'press the base' },
    { cond:'Enemy unknown AND\nmap < 80% explored?', mission:'scout', why:'recon with the Valkyrie' },
    { cond:'No contact / hugging base?', mission:'harass', why:'flush reveals' },
    { cond:'Otherwise', mission:'attack', why:'hunt what roams' } ],
  turtle: [ { cond:'Flag grabbable?', mission:'capture', why:'go take it' },
    { cond:'2+ kills AND enemy weaker?', mission:'siege', why:'sortie from strength' },
    { cond:'Otherwise', mission:'defend', why:'hold under tower cover' } ],
};

// ---- L3 MISSION SUB-BEHAVIOUR (branches inside objective()/label(); `m` matches the live label) --
const CATCH = /.*/;
const SUB = {
  defend: [ { label:'Respond — towers under fire', m:/tower|under fire|responding/i, why:'run down the attacker' },
    { label:'Run down a contact', m:/contact|running down/i, why:'chase it off our half' },
    { label:'Patch up at home', m:/patch|patching/i, why:'heal between fights' },
    { label:'Patrol lane / guard gen', m:CATCH, why:'hold base↔mid, deny re-armour' } ],
  siege: [ { label:'Rear-flank gambit', m:/flank|behind|rear/i, why:'Valkyrie around the back' },
    { label:'Shell the HQ', m:CATCH, why:'crack the keep from range' } ],
  capture: [ { label:'Carry it home', m:/home with the flag/i, why:'run it to our lift' },
    { label:'Race for the loose flag', m:/loose flag/i, why:'it’s in the open — beeline it' },
    { label:'Sneak round the back', m:/sneaking/i, why:'slip in behind the base' },
    { label:'Grab the flag', m:CATCH, why:'dash in and lift it' } ],
  scavenge: [ { label:'Run down salvage', m:/running down|for parts/i, why:'grab known scrap' },
    { label:'Scout for salvage', m:CATCH, why:'find scrap to grab' } ],
  trap: [ { label:'Kite them onto the mines', m:/luring|onto the mines/i, why:'circle the cluster; they cross it' },
    { label:'Signal shots', m:/signal/i, why:'noise-bait — draw a listener in' },
    { label:'Set in ambush', m:CATCH, why:'quiet hold behind the mines' } ],
  attack:    [ { label:'Push the field', m:CATCH, why:'fight what roams / press the base' } ],
  scout:     [ { label:'Sweep recon waypoints', m:CATCH, why:'find enemy + supply' } ],
  harass:    [ { label:'Poke & fade', m:CATCH, why:'hit backfield gear, vanish' } ],
  intercept: [ { label:'Recover the dropped flag', m:/recovering/i, why:'touch it to snap it home' },
    { label:'Chase the carrier', m:CATCH, why:'run the thief down' } ],
  sap:       [ { label:'Flank recon + mines', m:CATCH, why:'seed mines, drop a pod' } ],
};

// ---- L4 UNIT BRAIN (DEFAULT_BRAIN.transitions; keyed by the CONDITIONS name the game reports) --
const BRAIN = [
  { when:'mustGo',       cond:'At the gate, not out?', mode:'exit', why:'drive out the gate' },
  { when:'capturing',    cond:'Final approach to a grabbable flag?', mode:'advance', why:'commit — ignore turrets' },
  { when:'fleeLatched',  cond:'Runner escaping?\n(flee latch)', mode:'flee', why:'run the flag home' },
  { when:'underAttack',  cond:'Inescapable enemy on top of us?', mode:'engage', why:'answer it now' },
  { when:'shieldRun',    cond:'Committed to a close shield gen?', mode:'advance', why:'grab the armour first' },
  { when:'engaging',     cond:'Enemy in range and worth it?\n(fightScore>0)', mode:'engage', why:'fight-or-flight says fight' },
  { when:'hurtLatched',  cond:'Hurt and no fight to be had?', mode:'retreat', why:'limp home to heal' },
  { when:'resupLatched', cond:'Low on fuel / ammo?', mode:'resupply', why:'top up at a depot' },
  { when:'threatened',   cond:'A turret threatening us?', mode:'suppress', why:'suppress the tower' },
  { when:'pursuing',     cond:'Lost sight of an enemy?', mode:'pursue', why:'chase its last-seen spot' },
  { when:'shootGoal',    cond:'Something blocking the objective?', mode:'assault', why:'shoot through to the goal' },
  { when:'always',       cond:'Otherwise', mode:'advance', why:'advance to the objective' },
];

// ---- card builders ----------------------------------------------------------
function personaCard(c) {
  const col = acol(c.a);
  return `<div class="card" data-persona="${c.a}"><div class="big" style="color:${col}">${c.a}</div>
    <span class="rwhy">${esc(c.blurb)}</span></div>`;
}
function doctrineCard(r, dkey) {
  const c = mcol(r.mission);
  return `<div class="card" data-dkey="${dkey}"><div class="cond">${esc(r.cond)}</div>
    <div class="arrow"></div><span class="badge" style="background:${c}22;color:${c};border:1px solid ${c}">${esc(r.mission)}</span>
    <span class="rwhy">${esc(r.why)}</span><span class="metric"></span></div>`;
}
function subCard(s, i) {
  return `<div class="card" data-sub="${i}"><div class="big" style="font-size:12px">${esc(s.label)}</div>
    <span class="rwhy">${esc(s.why)}</span></div>`;
}
function brainCard(r) {
  const c = scol(r.mode);
  return `<div class="card" data-when="${r.when}"><div class="cond">${esc(r.cond)}</div>
    <div class="arrow"></div><span class="badge" style="background:${c}22;color:${c};border:1px solid ${c}">${esc(r.mode)}</span>
    <span class="rwhy">${esc(r.why)}</span><span class="metric"></span></div>`;
}

// ---- drag-to-scroll on a track ---------------------------------------------
function addDrag(track) {
  let down = false, sx = 0, sl = 0, moved = false;
  track.addEventListener('pointerdown', e => { down = true; moved = false; sx = e.clientX; sl = track.scrollLeft; track.classList.add('grabbing'); });
  track.addEventListener('pointermove', e => { if (!down) return; const dx = e.clientX - sx; if (Math.abs(dx) > 3) moved = true; track.scrollLeft = sl - dx; });
  const up = () => { down = false; track.classList.remove('grabbing'); };
  track.addEventListener('pointerup', up); track.addEventListener('pointerleave', up);
}
function centerCard(track, card) {
  if (!card) return;
  track.scrollTo({ left: card.offsetLeft - track.clientWidth / 2 + card.offsetWidth / 2, behavior: 'smooth' });
}

// ---- per-column build + live update ----------------------------------------
const built = [null, null];            // {archetype, mission}
const lastActive = [{}, {}];           // per layer: last active card key (to recenter only on change)
const logSig = ['', ''];

function trackHTML(cardsHTML) { return `<div class="track">${cardsHTML}</div>`; }

function buildColumn(i, label, archetype, mission) {
  const col = document.getElementById('col-' + i);
  const persona = PERSONA_CARDS.map(personaCard).join('');
  const doctrine = UNIVERSAL.map(r => doctrineCard(r, r.key)).join('')
    + (PERSONA_CHOOSE[archetype] || PERSONA_CHOOSE.warrior).map(r => doctrineCard(r, 'choose:' + r.mission)).join('');
  const subs = (SUB[mission] || [{ label: mission, m: CATCH, why: '' }]).map(subCard).join('');
  const brain = BRAIN.map(brainCard).join('');
  col.innerHTML = `
    <div class="col-head"><span class="team-name">${esc(label)}</span>
      <span class="arch" style="color:${acol(archetype)}">${esc(archetype)}</span>
      <span class="miss"></span></div>
    <div class="top"></div>
    <div class="spine">
      <div class="layer"><div class="lname">PERSONA</div>${trackHTML(persona)}</div>
      <div class="layer"><div class="lname">DOCTRINE &middot; which rung fired</div>${trackHTML(doctrine)}</div>
      <div class="layer"><div class="lname">MISSION &middot; sub-behaviour</div>${trackHTML(subs)}</div>
      <div class="layer"><div class="lname">UNIT BRAIN &middot; tactical mode</div>${trackHTML(brain)}</div>
      <div class="layer"><div class="lname">THE DRIVER &middot; standing order &rarr; pedals</div>
        <div class="coc">
          <div class="cl"><span class="ck">maneuver:</span><span class="mnv-v">&mdash;</span></div>
          <div class="cl"><span class="ck">driver:</span><span class="drv-v">&mdash;</span></div>
        </div></div>
    </div>
    <div class="log-wrap"><div class="sect-t">DECISION LOG &middot; most recent first</div><div class="log"></div></div>`;
  col.querySelectorAll('.track').forEach(addDrag);
  built[i] = { archetype, mission }; lastActive[i] = {}; logSig[i] = '';
}

function emptyColumn(i) {
  const col = document.getElementById('col-' + i);
  col.innerHTML = '<div class="col-head"><span class="team-name">—</span><span class="arch" style="opacity:.3">no commander</span></div>';
  built[i] = null; lastActive[i] = {};
}

function activeSubIndex(mission, subLabel) {
  const list = SUB[mission]; if (!list) return 0;
  const idx = list.findIndex(s => s.m.test(subLabel || ''));
  return idx < 0 ? list.length - 1 : idx;
}

function updateColumn(i, label, data, log) {
  if (!built[i] || built[i].archetype !== data.archetype) buildColumn(i, label, data.archetype, data.mission);
  else if (built[i].mission !== data.mission) {   // mission changed → the sub-behaviour row's cards change
    const col = document.getElementById('col-' + i);
    const track = col.querySelectorAll('.layer')[2].querySelector('.track');
    track.innerHTML = (SUB[data.mission] || [{ label: data.mission, m: CATCH, why: '' }]).map(subCard).join('');
    addDrag(track); built[i].mission = data.mission; lastActive[i].sub = null;
  }
  const col = document.getElementById('col-' + i);
  const tracks = [...col.querySelectorAll('.track')];   // [persona, doctrine, sub, brain]
  const tn = col.querySelector('.team-name');
  if (data.color) { tn.style.color = data.color; tn.style.textShadow = `0 0 8px ${data.color}`; tn.style.opacity = 1; }
  col.querySelector('.miss').innerHTML = `<b style="color:${mcol(data.mission)}">${esc(data.mission)}</b>`
    + (data.sub ? ` &rsaquo; ${esc(data.sub)}` : '');
  col.querySelector('.top').innerHTML = topPanel(data);

  // resolve the active card of each layer
  const primary = (data.units || [])[0];
  // During a recall / lift-rise the game bypasses the brain, so its state is stale — don't
  // highlight a frozen rung; label the layer instead.
  const recalled = primary && primary.ctrl && primary.ctrl !== 'brain';
  const brainLname = col.querySelectorAll('.layer')[3].querySelector('.lname');
  if (brainLname) brainLname.innerHTML = !recalled ? 'UNIT BRAIN &middot; tactical mode'
    : primary.ctrl === 'recall' ? 'UNIT BRAIN &middot; <span style="color:#e0b45a">paused — recalled to swap unit</span>'
    : 'UNIT BRAIN &middot; <span style="color:#5ad0e0">deploying (riding the lift up)</span>';
  const active = {
    persona: `[data-persona="${data.archetype}"]`,
    doctrine: data.rung && data.rung !== 'benched'
      ? `[data-dkey="${data.rung === 'choose' ? 'choose:' + data.mission : data.rung}"]` : null,
    sub: `[data-sub="${activeSubIndex(data.mission, data.sub)}"]`,
    brain: (primary && !recalled && primary.when) ? `[data-when="${primary.when}"]` : null,
  };
  const keys = ['persona', 'doctrine', 'sub', 'brain'];
  keys.forEach((k, li) => {
    const track = tracks[li];
    track.querySelectorAll('.card').forEach(c => c.classList.remove('on'));
    const sel = active[k]; if (!sel) return;
    const card = track.querySelector('.card' + sel);
    if (card) {
      card.classList.add('on');
      if (lastActive[i][k] !== sel) { centerCard(track, card); lastActive[i][k] = sel; }
    }
  });

  // chain-of-command tail: the primary unit's standing driver order + this tick's pedals.
  // An alarm count means the driver has failed to move this unit — flag it loud.
  const coc = col.querySelector('.coc');
  if (coc) {
    coc.querySelector('.mnv-v').innerHTML = esc((primary && primary.mnv) || '—')
      + (primary && primary.alarms ? ` <span class="alarm">· ${primary.alarms} ALARM${primary.alarms > 1 ? 'S' : ''}</span>` : '');
    coc.querySelector('.drv-v').textContent = (primary && primary.drv) || '—';
  }

  // live metric on each card (the number behind the condition)
  const met = data.metrics || {};
  col.querySelectorAll('.card[data-dkey]').forEach(c => { const el = c.querySelector('.metric'); if (el) el.textContent = met[c.dataset.dkey] || ''; });
  col.querySelectorAll('.card[data-when]').forEach(c => { const el = c.querySelector('.metric'); if (el) el.textContent = met[c.dataset.when] || ''; });

  // log (most recent first) — only rebuild when it changed, to keep its scroll steady
  const sig = log.length + '|' + (log.length ? log[log.length - 1].msg : '');
  if (sig !== logSig[i]) {
    logSig[i] = sig;
    const logEl = col.querySelector('.log');
    logEl.innerHTML = log.length ? log.slice().reverse().map(e => {
      const sw = /\[.*→.*\]/.test(e.msg);
      return `<div class="ln${sw ? ' sw' : ''}"><span class="tm">${e.t.toFixed(1)}s</span><span class="mg">${esc(e.msg)}</span></div>`;
    }).join('') : '<div class="none">—</div>';
    logEl.scrollTop = 0;
  }
}

// ---- poll + render ----------------------------------------------------------
let last = null, lastSig = '';
function render() {
  const statusEl = document.getElementById('status');
  if (!last || !last.teams) {
    statusEl.textContent = 'no live game yet — open a match at /rmrf-dev/ (spectate) in another tab';
    statusEl.className = 'status';
    if (lastSig !== 'empty') { emptyColumn(0); emptyColumn(1); lastSig = 'empty'; }
    return;
  }
  if (last.over) {
    statusEl.textContent = 'MATCH OVER · final decision state';
    statusEl.className = 'status live';
  } else {
    const fresh = Date.now() - (last.t || 0) < 8000;
    statusEl.textContent = fresh ? 'LIVE' : 'PAUSED · showing last snapshot (game tab is in the background)';
    statusEl.className = fresh ? 'status live' : 'status';
  }

  const labels = Object.keys(last.teams).sort();
  const logAll = last.log || [];
  const sig = labels.map(l => { const d = last.teams[l]; const g = d.dbg || {};
    return l + ':' + d.archetype + ':' + d.rung + ':' + d.mission + ':' + d.sub + ':' + d.fleet + ':'
      + (d.units || []).map(u => [u.type, u.state, u.detail, u.when, u.ctrl, u.hp, u.fuel, u.ammo, u.shield, u.heading].join('_')).join(',')
      + ':' + [g.gd, g.blk, g.fof, g.foeD, g.stuck, g.fwd].join('_') + ':' + Object.values(d.metrics || {}).join('~');
  }).join('|') + '|log' + logAll.length + (logAll.length ? logAll[logAll.length - 1].msg : '');
  if (sig === lastSig) return;
  lastSig = sig;

  for (let i = 0; i < 2; i++) {
    const label = labels[i];
    if (!label) { emptyColumn(i); continue; }
    updateColumn(i, label, last.teams[label], logAll.filter(e => e.team === label));
  }
}
function poll() {
  try { const raw = localStorage.getItem('rmrf-ai-live'); const parsed = raw ? JSON.parse(raw) : null; if (parsed) last = parsed; }
  catch (e) { /* keep last snapshot */ }
  render();
}
poll();
setInterval(poll, 400);
window.addEventListener('storage', poll);

// ── COPY: the current decision state as paste-able text ─────────────────────────
// Everything worth sharing from the last snapshot — both teams' spine (persona/rung/
// mission/sub/why), the primary unit line (state + its object + fired brain rung),
// vitals, the brief-log dbg, live metrics, and the last few log lines.
function snapshotText() {
  if (!last) return 'RMRF AI SNAPSHOT — no live game data yet';
  const L = [];
  L.push(`RMRF AI SNAPSHOT · ${last.over ? 'MATCH OVER' : new Date(last.t).toLocaleTimeString()}${last.seed ? ' · ' + last.seed : ''}`);
  for (const [team, d] of Object.entries(last.teams || {})) {
    L.push(`== ${team} · ${(d.archetype || '?').toUpperCase()} ==`);
    L.push(`mission: ${d.mission}${d.rung ? ` [rung: ${d.rung}]` : ''}${d.sub ? ` · ${d.sub}` : ''}`);
    if (d.why) L.push(`why: ${d.why}`);
    L.push(`fleet ${d.fleet != null ? d.fleet : '—'}${d.comp ? ` (${d.comp})` : ''} · knows: ${d.known || 'none'}`);
    for (const u of d.units || []) {
      const st = u.ctrl && u.ctrl !== 'brain' ? u.ctrl.toUpperCase() : u.state;
      const hdg = typeof u.heading === 'number' ? ` · hdg ${Math.round(((-u.heading * 180 / Math.PI) % 360 + 360) % 360)}°` : '';
      L.push(`unit: ${u.type} · ${st}${u.detail ? ' — ' + u.detail : ''}${u.when ? ` · brain: ${u.when}` : ''}`);
      if (u.mnv) L.push(`  maneuver: ${u.mnv}${u.alarms ? ` · ${u.alarms} ALARM${u.alarms > 1 ? 'S' : ''}` : ''}`);
      if (u.drv) L.push(`  driver:   ${u.drv}`);
      L.push(`  hp ${u.hp}% · fuel ${u.fuel}% · ammo ${u.ammo}%${u.shield != null ? ` · shield ${u.shield}%` : ''}${hdg}`);
    }
    const g = d.dbg;
    if (g) L.push(`dbg: goal (${g.gx},${g.gz}) ${g.gd}u out · fob ${g.distFob}u · fof ${g.fof != null ? g.fof : '—'} · blk ${g.blk || '···'}${g.navPath ? ` · path ${g.navPath}` : ''}${g.stuck ? ` · STUCK ${g.stuck}s (${g.stuckWhy || '?'})` : ''}`);
    const M = d.metrics || {}, mk = Object.keys(M);
    if (mk.length) L.push('metrics: ' + mk.map(k => `${k}=${M[k]}`).join(' · '));
  }
  const lg = (last.log || []).slice(-6);
  if (lg.length) { L.push('log (latest last):'); for (const e of lg) L.push(`  [${e.team}] ${e.msg}`); }
  return L.join('\n');
}
document.getElementById('copybtn').addEventListener('click', async () => {
  const txt = snapshotText();
  try { await navigator.clipboard.writeText(txt); }
  catch (e) {   // clipboard API needs a secure context — textarea fallback covers plain http
    const ta = document.createElement('textarea');
    ta.value = txt; document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); ta.remove();
  }
  const b = document.getElementById('copybtn');
  b.textContent = 'COPIED ✓';
  setTimeout(() => { b.textContent = 'COPY'; }, 1200);
});
