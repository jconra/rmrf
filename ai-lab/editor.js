// AI Lab — the brain SKETCHPAD. This is a note-taking / spec tool, not a rigid logic
// builder: every node is just a TITLE + a free-text box where Jacob writes, in plain
// English, what he wants the AI to do at that point. Nodes connect with LABELLED arrows
// to show the flow / decisions. Hit "export JSON" and hand it to Claude, who reads the
// structure + the words and implements it into the real Riposte Run brain (AI.js).
// Pan = drag empty space, zoom = scroll wheel, grid is infinite.

const canvas = document.getElementById('canvas');
const svg = document.getElementById('cables');
const scroll = document.getElementById('scroll');
let pending = null;   // first plug clicked while drawing an arrow
let plugDragged = false;   // set when a plug was dragged, so the trailing click won't wire
let uidN = 0;

const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = s => esc(s).replace(/"/g, '&quot;');

// --- starter sketch (Jacob's exported AI notes — ~/ai-editor.txt) -------
function starter() {
  return {
    type: 'riposte-run-ai-notes', version: 1,
    nodes: {
      n1: { title: 'START — every tick', text: 'Re-decide from scratch each frame (no in-tick loops).', x: 87, y: 62,
        outs: [{ label: 'start', to: 'n4', pos: { side: 'bottom', t: 0.51 } }], inPos: { side: 'top', t: 0.47 } },
      n2: { title: 'Still inside the elevator base?', text: 'If we just spawned and are still inside the FOB gate, get out before anything else.', x: -24, y: 454,
        outs: [{ label: 'Yes', to: 'n3', pos: { side: 'bottom', t: 0.99 } }, { label: 'No', to: 'n6', pos: { side: 'bottom', t: 0 } }] },
      n3: { title: 'Leave the gate', text: 'Pivot toward the exit, then drive straight out.', x: 92, y: 644, outs: [] },
      n4: { title: 'Enemy in sight?', text: 'If a rival vehicle or tower is in sight. Since the rival can be near the elevator, evaluating it is the top priority.', x: 90, y: 248,
        outs: [{ label: 'yes', to: 'n5', pos: { side: 'bottom', t: 1 } }, { label: 'no', to: 'n2', pos: { side: 'bottom', t: 0.02 } }] },
      n5: { title: 'Determine Chances of Success', text: 'Do we choose fight or flight? This depends on several factors. Do we have a shield? Is our vehicle strong against the enemy or are they strong against us? Is our health full? Is the enemies health full? Instead of going through 100 if statements maybe a weight can be derived. If we have a shield, +1. If they have a shield, -1. Do we have more than 50% ammo? +1. Are we a Firebrat and can die in one hit? -2. Do we have an aggressive personality? +1. ', x: 427, y: 461, outs: [] },
      n6: { title: 'Determine Objective', text: 'What is your self.personality_type?', x: -140, y: 820, outs: [] },
    },
  };
}
let graph;

// --- viewport (CSS-transform pan/zoom; infinite grid) -------------------
const view = { tx: 40, ty: 40, scale: 1 };
function applyView() {
  canvas.style.transform = `translate(${view.tx}px,${view.ty}px) scale(${view.scale})`;
  const minor = 26 * view.scale, major = 130 * view.scale;
  scroll.style.backgroundSize = `${major}px ${major}px, ${major}px ${major}px, ${minor}px ${minor}px`;
  scroll.style.backgroundPosition = `${view.tx}px ${view.ty}px`;
  const z = document.getElementById('zoomind'); if (z) z.textContent = Math.round(view.scale * 100) + '%';
}
function toWorld(clientX, clientY) {
  const r = scroll.getBoundingClientRect();
  return { x: (clientX - r.left - view.tx) / view.scale, y: (clientY - r.top - view.ty) / view.scale };
}
function frameContent() {
  const xs = [], ys = [];
  for (const id in graph.nodes) { const n = graph.nodes[id]; if (n.x != null) { xs.push(n.x); ys.push(n.y); } }
  view.scale = 1;
  view.tx = 40 - (xs.length ? Math.min(...xs) : 0);
  view.ty = 40 - (ys.length ? Math.min(...ys) : 0);
  applyView();
}
function autoLayout() {   // only for nodes that arrive without coords (e.g. pasted-in)
  let i = 0;
  for (const id in graph.nodes) { const n = graph.nodes[id]; if (n.x == null) { n.x = 80 + (i % 4) * 320; n.y = 80 + Math.floor(i / 4) * 220; i++; } }
}

// --- graph helpers ------------------------------------------------------
function clearRefsTo(id) {
  for (const k in graph.nodes) for (const o of (graph.nodes[k].outs || [])) if (o.to === id) o.to = null;
}

// --- local persistence --------------------------------------------------
// render() auto-saves on every structural change; text edits + drags save too (debounced
// / on drop). There's also a manual "save" button since browser autosave can be flaky.
const SAVE_KEY = 'ai-lab-sketch-v2';   // bumped when the starter sketch is replaced, so it isn't masked by a stale local save
function save() { try { localStorage.setItem(SAVE_KEY, JSON.stringify(graph)); flashSaved(); } catch (e) { } }
function load() { try { const s = localStorage.getItem(SAVE_KEY); if (s) { const g = JSON.parse(s); if (g && g.nodes) return g; } } catch (e) { } return starter(); }
let _saveT; function scheduleSave() { clearTimeout(_saveT); _saveT = setTimeout(save, 600); }
function flashSaved() { const b = document.getElementById('btnSave'); if (!b) return; b.textContent = 'saved ✓'; clearTimeout(b._t); b._t = setTimeout(() => { b.textContent = 'save'; }, 900); }

// --- rendering ----------------------------------------------------------
function render() {
  [...canvas.querySelectorAll('.node')].forEach(el => el.remove());
  for (const id in graph.nodes) {
    const n = graph.nodes[id];
    const div = document.createElement('div');
    div.className = 'node'; div.dataset.id = id;
    div.style.left = (n.x || 20) + 'px'; div.style.top = (n.y || 20) + 'px';
    // Plugs are node-level children (not inside the body) so they can be dragged anywhere
    // around the border; each out-plug carries its short label, sitting just outside the
    // node on the plug's side. positionPlugs() places them from their stored pos (or default).
    let plugsH = `<div class="plug" data-node="${id}" data-dir="in" title="drag to reposition · click to wire"></div>`;
    (n.outs || []).forEach((o, i) => {
      plugsH += `<div class="plug" data-node="${id}" data-out="${i}" data-dir="out" title="drag to reposition · click to wire"></div>`;
      plugsH += `<div class="plabel" data-out="${i}"><input class="plabel-in" data-node="${id}" data-field="label" data-out="${i}" value="${escAttr(o.label)}" placeholder="…" maxlength="16">` +
        `<span class="rmarrow" data-node="${id}" data-out="${i}" title="remove arrow">&times;</span></div>`;
    });
    div.innerHTML =
      `<div class="nhead"><span class="grip">&#8801;</span><span class="ntitle">${esc(n.title) || 'untitled'}</span>` +
      `<span class="ndel" data-del="${id}">&times;</span></div>` +
      `<div class="nbody">` +
        `<input class="ntitle-in" data-node="${id}" data-field="title" value="${escAttr(n.title)}" placeholder="title…">` +
        `<textarea class="nnotes" data-node="${id}" data-field="text" placeholder="describe what the AI should do here…">${esc(n.text)}</textarea>` +
        `<button class="addarrow" data-node="${id}">+ arrow</button>` +
      `</div>` +
      plugsH;
    canvas.appendChild(div);
    positionPlugs(div, n);
  }
  drawCables();
  save();
}

// Place a plug on the node border from a {side,t} position (t = 0..1 along that side).
function positionPlug(el, pos) {
  let l, t;
  if (pos.side === 'top') { l = pos.t * 100 + '%'; t = '0%'; }
  else if (pos.side === 'bottom') { l = pos.t * 100 + '%'; t = '100%'; }
  else if (pos.side === 'left') { l = '0%'; t = pos.t * 100 + '%'; }
  else { l = '100%'; t = pos.t * 100 + '%'; }       // right
  el.style.left = l; el.style.top = t; el.style.right = 'auto'; el.style.bottom = 'auto';
  el.style.margin = '0'; el.style.transform = 'translate(-50%,-50%)';
}
// Position the short label just outside the node on the plug's side, aligned so the word
// reads away from the box (right→to the right, left→to the left, top/bottom→centered).
function positionLabel(el, pos) {
  let l, t, tf, align;
  if (pos.side === 'top') { l = pos.t * 100 + '%'; t = '0%'; tf = 'translate(-50%, calc(-100% - 8px))'; align = 'center'; }
  else if (pos.side === 'bottom') { l = pos.t * 100 + '%'; t = '100%'; tf = 'translate(-50%, 8px)'; align = 'center'; }
  else if (pos.side === 'left') { l = '0%'; t = pos.t * 100 + '%'; tf = 'translate(calc(-100% - 10px), -50%)'; align = 'right'; }
  else { l = '100%'; t = pos.t * 100 + '%'; tf = 'translate(10px, -50%)'; align = 'left'; }   // right
  el.style.left = l; el.style.top = t; el.style.right = 'auto'; el.style.bottom = 'auto';
  el.style.margin = '0'; el.style.transform = tf;
  const inp = el.querySelector('input'); if (inp) inp.style.textAlign = align;
}
function positionPlugs(div, n) {
  const inEl = div.querySelector('.plug[data-dir="in"]');
  if (inEl) positionPlug(inEl, n.inPos || { side: 'top', t: 0.5 });
  const m = (n.outs || []).length;
  div.querySelectorAll('.plug[data-dir="out"]').forEach(el => {
    const i = +el.dataset.out, o = n.outs[i];
    const pos = (o && o.pos) || { side: 'right', t: (i + 1) / (m + 1) };   // default: spaced down the right edge
    positionPlug(el, pos);
    const lab = div.querySelector(`.plabel[data-out="${i}"]`);
    if (lab) positionLabel(lab, pos);
  });
}
// Nearest border side + fractional offset for a pointer over a node.
function borderPos(nodeEl, cx, cy) {
  const r = nodeEl.getBoundingClientRect();
  const fx = (cx - r.left) / r.width, fy = (cy - r.top) / r.height;
  const d = { top: fy, bottom: 1 - fy, left: fx, right: 1 - fx };
  let side = 'top', best = Infinity; for (const k in d) if (d[k] < best) { best = d[k]; side = k; }
  return { side, t: Math.max(0, Math.min(1, (side === 'top' || side === 'bottom') ? fx : fy)) };
}

function plugCenter(sel) {
  const el = canvas.querySelector(sel); if (!el) return null;
  const cr = canvas.getBoundingClientRect(), r = el.getBoundingClientRect();
  return { x: (r.left + r.width / 2 - cr.left) / view.scale, y: (r.top + r.height / 2 - cr.top) / view.scale };
}
function drawCables() {
  let paths = '';
  for (const id in graph.nodes) {
    const n = graph.nodes[id];
    (n.outs || []).forEach((o, i) => {
      if (!o.to || !graph.nodes[o.to]) return;
      const a = plugCenter(`.plug[data-node="${id}"][data-out="${i}"][data-dir="out"]`);
      const b = plugCenter(`.plug[data-node="${o.to}"][data-dir="in"]`);
      if (!a || !b) return;
      const srcSide = (o.pos && o.pos.side) || 'right';                  // default out edge
      const dstSide = (graph.nodes[o.to].inPos && graph.nodes[o.to].inPos.side) || 'top';
      paths += cable(a, b, '#6f9fd0', { node: id, out: i }, srcSide, dstSide);
    });
  }
  svg.innerHTML = paths;
}
// Outward unit vector for each border side, so a cable leaves/enters perpendicular to the
// edge its plug sits on (left plug → curves out the left, top → out the top, etc.).
const DIRV = { top: [0, -1], bottom: [0, 1], left: [-1, 0], right: [1, 0] };
function cable(a, b, color, cut, srcSide = 'right', dstSide = 'left') {
  const k = Math.max(45, Math.hypot(b.x - a.x, b.y - a.y) * 0.4);
  const s = DIRV[srcSide] || DIRV.right, d = DIRV[dstSide] || DIRV.left;
  const path = `M${a.x},${a.y} C${a.x + s[0] * k},${a.y + s[1] * k} ${b.x + d[0] * k},${b.y + d[1] * k} ${b.x},${b.y}`;
  return `<path d="${path}" fill="none" stroke="${color}" stroke-width="2.5" opacity="0.85" data-cut='${JSON.stringify(cut)}'/>`;
}

// --- interactions -------------------------------------------------------
canvas.addEventListener('click', e => {
  const plug = e.target.closest('.plug'); if (plug) { if (plugDragged) { plugDragged = false; return; } handlePlug(plug); return; }
  const del = e.target.closest('[data-del]'); if (del) { delete graph.nodes[del.dataset.del]; clearRefsTo(del.dataset.del); clearPending(); render(); return; }
  const rm = e.target.closest('.rmarrow'); if (rm) { graph.nodes[rm.dataset.node].outs.splice(+rm.dataset.out, 1); render(); return; }
  const add = e.target.closest('.addarrow'); if (add) { const n = graph.nodes[add.dataset.node]; (n.outs = n.outs || []).push({ label: '', to: null }); render(); return; }
});
svg.addEventListener('click', e => {
  const p = e.target.closest('path'); if (!p || !p.dataset.cut) return;
  const c = JSON.parse(p.dataset.cut); graph.nodes[c.node].outs[c.out].to = null; render();
});
function handlePlug(plug) {
  const info = { node: plug.dataset.node, out: plug.dataset.out, dir: plug.dataset.dir, el: plug };
  if (!pending) { pending = info; plug.classList.add('pend'); return; }
  if (pending.el === plug) { clearPending(); return; }
  const out = pending.dir === 'out' ? pending : info, inn = pending.dir === 'in' ? pending : info;
  if (out.dir === 'out' && inn.dir === 'in') graph.nodes[out.node].outs[+out.out].to = inn.node;
  clearPending(); render();
}
function clearPending() { if (pending && pending.el) pending.el.classList.remove('pend'); pending = null; }

// text edits — update the model WITHOUT a re-render (keeps the caret/focus). Cables get
// a light redraw so arrow labels stay live.
canvas.addEventListener('input', e => {
  const el = e.target, id = el.dataset.node, field = el.dataset.field;
  if (!id || !field || !graph.nodes[id]) return;
  const n = graph.nodes[id];
  if (field === 'title') { n.title = el.value; const t = canvas.querySelector(`.node[data-id="${id}"] .ntitle`); if (t) t.textContent = el.value || 'untitled'; }
  else if (field === 'text') { n.text = el.value; }
  else if (field === 'label') { n.outs[+el.dataset.out].label = el.value; drawCables(); }
  scheduleSave();
});

// drag a plug around the node's border (snaps to the nearest edge). A move past a small
// threshold counts as a reposition; a plain click falls through to wiring.
canvas.addEventListener('pointerdown', e => {
  const plug = e.target.closest('.plug'); if (!plug) return;
  const nodeEl = plug.closest('.node'); const n = graph.nodes[nodeEl.dataset.id];
  const isOut = plug.dataset.dir === 'out', oi = isOut ? +plug.dataset.out : -1;
  const sx = e.clientX, sy = e.clientY; let moved = false;
  const move = ev => {
    if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return;
    moved = true;
    const pos = borderPos(nodeEl, ev.clientX, ev.clientY);
    if (isOut) n.outs[oi].pos = pos; else n.inPos = pos;
    positionPlug(plug, pos);
    if (isOut) { const lab = nodeEl.querySelector(`.plabel[data-out="${oi}"]`); if (lab) positionLabel(lab, pos); }
    drawCables();
  };
  const up = () => {
    document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up);
    if (moved) { plugDragged = true; save(); }
  };
  document.addEventListener('pointermove', move); document.addEventListener('pointerup', up);
  e.preventDefault();
});

// drag a node by its header
canvas.addEventListener('pointerdown', e => {
  const head = e.target.closest('.nhead'); if (!head || e.target.closest('input,textarea,button,.ndel')) return;
  const div = head.closest('.node'); const n = graph.nodes[div.dataset.id];
  const sx = e.clientX, sy = e.clientY, ox = n.x, oy = n.y;
  const move = ev => { n.x = ox + (ev.clientX - sx) / view.scale; n.y = oy + (ev.clientY - sy) / view.scale; div.style.left = n.x + 'px'; div.style.top = n.y + 'px'; drawCables(); };
  const up = () => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); save(); };
  document.addEventListener('pointermove', move); document.addEventListener('pointerup', up);
  e.preventDefault();
});

// pan by dragging empty background
canvas.addEventListener('pointerdown', e => {
  if (e.target !== canvas) return;
  clearPending();
  const sx = e.clientX, sy = e.clientY, tx0 = view.tx, ty0 = view.ty;
  const move = ev => { view.tx = tx0 + (ev.clientX - sx); view.ty = ty0 + (ev.clientY - sy); applyView(); };
  const up = () => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); scroll.style.cursor = 'grab'; };
  document.addEventListener('pointermove', move); document.addEventListener('pointerup', up);
  scroll.style.cursor = 'grabbing';
});

// scroll wheel = zoom toward the cursor
scroll.addEventListener('wheel', e => {
  e.preventDefault();
  const r = scroll.getBoundingClientRect();
  const cx = e.clientX - r.left, cy = e.clientY - r.top;
  const wx = (cx - view.tx) / view.scale, wy = (cy - view.ty) / view.scale;
  view.scale = Math.min(2.5, Math.max(0.25, view.scale * Math.exp(-e.deltaY * 0.0015)));
  view.tx = cx - wx * view.scale; view.ty = cy - wy * view.scale;
  applyView();
}, { passive: false });

// --- toolbar ------------------------------------------------------------
function addNode() {
  const id = 'n' + (++uidN < 10 ? '0' + uidN : uidN);
  const c = toWorld(scroll.getBoundingClientRect().left + scroll.clientWidth / 2,
                    scroll.getBoundingClientRect().top + scroll.clientHeight / 2);
  graph.nodes[id] = { title: '', text: '', x: c.x - 115, y: c.y - 50, outs: [] };
  render();
}
function freshUid() { uidN = 0; for (const id in graph.nodes) { const m = /^n(\d+)$/.exec(id); if (m) uidN = Math.max(uidN, +m[1]); } }

document.getElementById('btnExport').addEventListener('click', () => {
  // Round the noisy floats on export: node coords to whole numbers, plug offsets to 2dp.
  const tidy = (key, val) => typeof val !== 'number' ? val
    : (key === 'x' || key === 'y') ? Math.round(val)
    : key === 't' ? Math.round(val * 100) / 100 : val;
  document.getElementById('exportta').value = JSON.stringify(graph, tidy, 2);
  const st = document.getElementById('exportstatus'); st.textContent = ''; st.className = '';
  document.getElementById('exportbox').classList.add('show');
});
document.getElementById('exportbox').addEventListener('click', e => { if (e.target.id === 'exportbox') e.currentTarget.classList.remove('show'); });
document.getElementById('btnCloseExport').addEventListener('click', () => document.getElementById('exportbox').classList.remove('show'));
document.getElementById('btnImport').addEventListener('click', () => {
  const st = document.getElementById('exportstatus');
  let g; try { g = JSON.parse(document.getElementById('exportta').value); } catch (e) { st.textContent = 'invalid JSON: ' + e.message; st.className = 'bad'; return; }
  if (!g || typeof g !== 'object' || !g.nodes || typeof g.nodes !== 'object') { st.textContent = 'no "nodes" object found'; st.className = 'bad'; return; }
  graph = g; freshUid(); autoLayout(); frameContent(); render();   // render() also saves
  st.textContent = 'loaded ✓'; st.className = 'ok';
  setTimeout(() => document.getElementById('exportbox').classList.remove('show'), 500);
});
document.getElementById('btnSave').addEventListener('click', save);
document.getElementById('btnAddNode').addEventListener('click', addNode);

graph = load();
freshUid();
autoLayout();
frameContent();
render();
