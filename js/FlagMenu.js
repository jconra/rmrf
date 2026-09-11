// FlagMenu.js — the debug flags, as a menu instead of as things you have to remember.
//
// Every switch in this game is a query-string flag, which is fine for a script and useless for a
// person: Jacob, 2026-09-10 — "it is really difficult to remember the names for all the url
// parameters". So this is one button that lists them with plain labels and checkboxes.
//
// THE FLAGS ARE READ AT BOOT, so ticking one has to reload. That is not a limitation worth hiding
// behind a fake live toggle: the panel shows the URL it will load, applies on a button rather than
// on every click (so you can set several at once), and keeps the seed and every other value
// parameter exactly as they are. Nothing here changes game behaviour — it only writes the address
// bar you would otherwise have typed.
//
// Adding a flag: put it in GROUPS below with a label a person would recognise. That is the whole
// maintenance burden, and a flag missing from here still works by hand.

// value = the query parameter, label = what it does in the words you would use out loud.
// A `no…` flag keeps its own name and says OFF in the label. An inverted checkbox was the other
// option and it reads worse: ticking a box labelled "Lights" to turn lights OFF is a puzzle.
//
// A third entry, `live`, names an RR setter that applies the flag WITHOUT a reload — for the
// overlays you switch on and off while a match is running, where losing the match to a page load
// is the whole cost of asking. It takes the FEATURE's state, so a `no…` flag passes the inverse.
// Everything else is read at boot and needs APPLY & RELOAD; the panel says which is which.
const GROUPS = [
  ['Watching a match', [
    ['aivsai', 'AI vs AI — sit back and watch'],
    ['spectate', 'Spectator view (free camera, both teams)'],
    ['field', 'Field report panel'],
  ]],
  ['Seeing what the AI sees', [
    ['cones', 'Sight lobes — flash pink when an enemy is inside', { live: 'setConeViz' }],
    ['noise', 'Engine noise rings', { live: 'setNoiseViz' }],
    ['nav', 'Draw the routes units are driving  (or press G)', { live: 'nav' }],
    ['nolights', 'Mission status lamps on each hull OFF', { live: 'setStatusLights', invert: true }],
    ['nolegend', 'The status-lamp colour key OFF', { live: 'setStatusLegend', invert: true }],
    ['navlines', 'Route lines only (no waypoint dots)'],
    ['navprobe', 'Pathfinder probe readout'],
  ]],
  ['AI logs', [
    ['ailog', 'Commander radio chatter', { live: (RR, on) => RR.setLogMode(on ? 'brief' : 'hidden') }],
    ['msnlog', 'Every mission score, with the term maths', { live: 'setMsnLog' }],
    ['deeplog', 'Deep decision log (verbose)', { live: 'setDeepLog' }],
  ]],
  ['World', [
    ['fol', 'Foliage debug'],
    ['nopoi', 'Points of interest OFF'],
    ['noscrap', 'Salvage piles OFF'],
    ['noveh', 'Vehicles OFF'],
    ['fobwalls', 'Forward-base walls'],
    ['garage', 'Garage sandbox'],
  ]],
  ['Performance', [
    ['perf', 'Performance HUD'],
    ['flatterrain', 'Flat terrain (shader-cost test — looks wrong on purpose)'],
    ['noprewarm', 'Skip shader pre-warm'],
    ['noscan', 'Scan-on-transition OFF', { live: 'setScan', invert: true }],
  ]],
  ['AI experiments (A/B flags)', [
    ['nodefendshape', 'Home-defence shaping OFF', { live: (RR, on) => RR.setDefendW({ on }), invert: true }],
    ['nofleescore', 'Flee as a scored mission OFF', { live: 'setFleeScore', invert: true }],
    ['nohomescore', 'Home-defence scoring OFF', { live: 'setHomeScore', invert: true }],
    ['noswapyield', 'Swap yields to a rival OFF'],
    ['noswapcommit', 'Swap commitment OFF'],
    ['nocapcarry', 'Carrier capture bonus OFF'],
    ['nostatuefix', 'Dry-tank mobility term OFF'],
    ['scoreclock', 'Re-score on a clock, not on triggers'],
    ['trigfix', 'Refresh trigger memories every tick'],
    ['swapsupply', 'A running swap suppresses top-ups'],
    ['aiwaterwall', 'Deep water physically blocks vehicles', { live: 'setAiWaterWall' }],
    ['noambush', 'Ambush (close with guns cold on a rival facing away) OFF', { live: 'setAmbush', invert: true }],
    ['nolastgasp', 'Last gasp (both sides wiped → spend the bank on runners) OFF', { live: 'setLastGasp', invert: true }],
    ['noai', 'No AI at all'],
  ]],
];

// Parameters that carry a VALUE rather than being on/off. They are never touched by the
// checkboxes — a menu that quietly dropped your seed would be worse than no menu.
const KEEP_VALUES = ['seed', 'dseed', 'rngseed', 'size', 'units', 'arch', 'difficulty', 'win',
  'losses', 'dodge', 'navbudget', 'mapcfg', 'maplocal', 'campaign', 'shadernonce', 'at', 'watch',
  'wx', 'wz', 'gunonus', 'gunonusr', 'hulleyes'];

const CSS = `
/* LEFT, not right: the AI log and the LAB button own the top-right corner, and a flags panel
   landing on top of the commander chatter is worse than no panel. The left edge is map. */
#flagmenu-btn {
  position: fixed; top: 52px; left: 10px; z-index: 300;
  font: 11px 'Courier New', monospace; letter-spacing: 1px;
  padding: 6px 10px; border-radius: 4px; cursor: pointer;
  background: rgba(8, 16, 24, 0.72); color: #cfe3ef;
  border: 1px solid rgba(255,255,255,0.28);
  box-shadow: 0 1px 6px rgba(0,0,0,0.3);
  user-select: none; -webkit-user-select: none;
}
#flagmenu-btn:hover { background: rgba(8, 16, 24, 0.9); color: #fff; }
#flagmenu {
  position: fixed; top: 82px; left: 10px; z-index: 300;
  width: 330px; max-height: 78vh; overflow-y: auto;
  font: 11px 'Courier New', monospace; letter-spacing: 0.5px; line-height: 1.5;
  background: rgba(8, 16, 24, 0.94); color: #cfe3ef;
  border: 1px solid rgba(255,255,255,0.28); border-radius: 5px;
  box-shadow: 0 4px 18px rgba(0,0,0,0.45);
  padding: 10px 12px 12px;
}
#flagmenu[hidden] { display: none; }
#flagmenu h4 {
  margin: 12px 0 4px; font-size: 10px; font-weight: bold;
  color: #7fb4cc; letter-spacing: 2px; text-transform: uppercase;
  border-bottom: 1px solid rgba(127,180,204,0.25); padding-bottom: 3px;
}
#flagmenu h4:first-of-type { margin-top: 2px; }
#flagmenu label {
  display: flex; align-items: flex-start; gap: 7px;
  padding: 2px 3px; border-radius: 3px; cursor: pointer;
}
#flagmenu label:hover { background: rgba(127,180,204,0.12); }
#flagmenu input { margin: 2px 0 0; flex: none; cursor: pointer; }
#flagmenu .flag-key { color: #6f8ea1; }
#flagmenu .fm-live {
  color: #86d29a; border: 1px solid rgba(134,210,154,0.4); border-radius: 2px;
  font-size: 9px; padding: 0 3px; letter-spacing: 1px;
}
#flagmenu .fm-note { margin-top: 9px; color: #7f95a3; font-size: 10px; line-height: 1.45; }
#flagmenu .fm-url {
  margin-top: 10px; padding: 6px; border-radius: 3px;
  background: rgba(0,0,0,0.35); color: #9ec6d8;
  word-break: break-all; font-size: 10px; max-height: 70px; overflow-y: auto;
}
#flagmenu .fm-row { display: flex; gap: 6px; margin-top: 8px; }
#flagmenu button {
  flex: 1; font: 11px 'Courier New', monospace; letter-spacing: 1px;
  padding: 6px; border-radius: 3px; cursor: pointer;
  background: rgba(127,180,204,0.18); color: #cfe3ef;
  border: 1px solid rgba(255,255,255,0.25);
}
#flagmenu button:hover { background: rgba(127,180,204,0.34); color: #fff; }
#flagmenu button.fm-go { background: rgba(120,190,120,0.22); }
`;

export function installFlagMenu() {
  if (typeof document === 'undefined' || document.getElementById('flagmenu-btn')) return;

  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  const btn = document.createElement('div');
  btn.id = 'flagmenu-btn';
  btn.textContent = '⚙ FLAGS';
  btn.title = 'Debug flags (the ?query switches), with names';

  const panel = document.createElement('div');
  panel.id = 'flagmenu';
  panel.hidden = true;

  const params = new URLSearchParams(location.search);
  const boxes = [];

  for (const [heading, flags] of GROUPS) {
    const h = document.createElement('h4');
    h.textContent = heading;
    panel.appendChild(h);
    for (const [key, label, opts] of flags) {
      const row = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = params.has(key);
      const live = opts && opts.live;
      const txt = document.createElement('span');
      txt.innerHTML = `${label} <span class="flag-key">&amp;${key}</span>`
        + (live ? ' <span class="fm-live">live</span>' : '');
      row.append(cb, txt);
      panel.appendChild(row);
      // A live flag takes effect the moment it is ticked. It still goes into the URL, so the link
      // you copy reproduces what you are looking at.
      // `live` is either the name of an RR setter that takes a boolean, or a function for the few
      // that want a shaped argument (a log MODE, an options object). Either way it is handed the
      // FEATURE's state, so a `no…` flag passes the inverse and the call reads the right way round.
      if (live) cb.addEventListener('change', () => {
        const RR = window.RR; if (!RR) return;
        const on = opts.invert ? !cb.checked : cb.checked;
        try {
          if (typeof live === 'function') live(RR, on);
          else if (typeof RR[live] === 'function') RR[live](on);
        } catch (e) { /* a setter that is not in this build must not break the menu */ }
      });
      boxes.push({ key, cb });
    }
  }

  const url = document.createElement('div');
  url.className = 'fm-url';

  const build = () => {
    const p = new URLSearchParams();
    for (const k of KEEP_VALUES) if (params.has(k)) p.set(k, params.get(k));
    for (const { key, cb } of boxes) if (cb.checked && !p.has(key)) p.set(key, '');
    // URLSearchParams renders a valueless flag as "key=", which works but is not what anyone
    // types. Print it the way the game's own docs and every rig write it.
    const q = [...p].map(([k, v]) => (v === '' ? k : `${k}=${encodeURIComponent(v)}`)).join('&');
    return location.pathname + (q ? '?' + q : '');
  };
  const refresh = () => { url.textContent = build(); };
  for (const { cb } of boxes) cb.addEventListener('change', refresh);
  refresh();

  const row = document.createElement('div');
  row.className = 'fm-row';
  const go = document.createElement('button');
  go.className = 'fm-go';
  go.textContent = 'APPLY & RELOAD';
  go.onclick = () => { location.href = build(); };
  const copy = document.createElement('button');
  copy.textContent = 'COPY LINK';
  copy.onclick = async () => {
    const full = location.origin + build();
    try { await navigator.clipboard.writeText(full); copy.textContent = 'COPIED'; }
    catch (e) { copy.textContent = 'COPY FAILED'; }
    setTimeout(() => { copy.textContent = 'COPY LINK'; }, 1200);
  };
  const clear = document.createElement('button');
  clear.textContent = 'CLEAR ALL';
  clear.onclick = () => { for (const { cb } of boxes) cb.checked = false; refresh(); };
  row.append(go, copy, clear);

  const note = document.createElement('div');
  note.className = 'fm-note';
  note.innerHTML = 'Boxes marked <span class="fm-live">live</span> take effect at once. '
    + 'Everything else is read when the page loads, so it needs APPLY & RELOAD.';
  panel.append(note, url, row);
  document.body.append(btn, panel);

  btn.onclick = () => { panel.hidden = !panel.hidden; };
  // Escape closes it — it sits over the game and a mouse-only dismiss is annoying mid-match.
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') panel.hidden = true; });
}
