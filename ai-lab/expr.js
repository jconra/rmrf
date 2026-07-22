// AI Lab — nested-box CONDITION editor (prototype). A condition is an expression
// TREE (the same data the runtime evaluates), rendered as nested boxes instead of
// nodes-and-wires: a Compare box contains an abs box contains (self.x) [−] (base.x).
// Every box collapses to a plain-language title; empty slots offer a dropdown of only
// the VALID box types for that slot; the whole thing validates live. Pure divs.
import { EXAMPLE_GRAPH, FIELDS, ENUMS } from '../js/BrainGraph.js';

const OPS = ['sub', 'add', 'mul', 'abs', 'min', 'max'];
const CMPS = ['lt', 'gt', 'le', 'ge', 'eq', 'ne'];
const OPSYM = { sub: '-', add: '+', mul: '*', min: 'min', max: 'max', abs: 'abs' };
const CMPSYM = { lt: '<', gt: '>', le: '<=', ge: '>=', eq: '==', ne: '!=' };
const CHIP = { field: 'VALUE', const: 'CONST', op: 'MATH', cmp: 'COMPARE', logic: 'LOGIC', match: 'MATCH' };
const fieldsOfType = t => Object.keys(FIELDS).filter(k => FIELDS[k].type === t);
const enumFields = () => Object.keys(FIELDS).filter(k => FIELDS[k].enum);

// Build a nested tree from the EXAMPLE graph's gate condition (root node id 'inGate').
function toTree(id) {
  const n = EXAMPLE_GRAPH.nodes[id]; if (!n) return null;
  if (n.type === 'field') return { k: 'field', path: n.path };
  if (n.type === 'const') return { k: 'const', value: n.value };
  if (n.type === 'op') return { k: 'op', op: n.op, args: n.op === 'abs' ? [toTree(n.a)] : [toTree(n.a), toTree(n.b)] };
  if (n.type === 'cmp') return { k: 'cmp', op: n.op, args: [toTree(n.a), toTree(n.b)] };
  if (n.type === 'logic') return { k: 'logic', op: n.op, args: (n.inputs || []).map(toTree) };
  if (n.type === 'match') return { k: 'match', field: n.field, value: n.value };
  return null;
}
let root = toTree('inGate');

// --- type + validation --------------------------------------------------
function typeOf(n) {
  if (!n) return '?';
  if (n.k === 'field') return (FIELDS[n.path] || {}).type || '?';
  if (n.k === 'const') return 'number';
  if (n.k === 'op') return 'number';
  return 'bool';   // cmp / logic / match
}
function valid(n) {
  if (!n) return false;
  if (n.k === 'field') return !!FIELDS[n.path];
  if (n.k === 'const') return typeof n.value === 'number';
  if (n.k === 'match') { const f = FIELDS[n.field]; return !!(f && f.enum && ENUMS[f.enum].includes(n.value)); }
  if (n.k === 'op') { const ar = n.op === 'abs' ? 1 : 2; return n.args.length >= ar && n.args.slice(0, ar).every(a => a && typeOf(a) === 'number' && valid(a)); }
  if (n.k === 'cmp') return n.args.length === 2 && n.args.every(a => a && typeOf(a) === 'number' && valid(a));
  if (n.k === 'logic') { const need = n.op === 'not' ? 1 : 2; return n.args.length >= need && n.args.every(a => a && typeOf(a) === 'bool' && valid(a)); }
  return false;
}

// --- human summary (the collapsed title) --------------------------------
function summ(n) {
  if (!n) return '∅';
  if (n.k === 'field') return n.path;
  if (n.k === 'const') return String(n.value);
  if (n.k === 'match') return `${n.field} == ${n.value}`;
  if (n.k === 'op') return n.op === 'abs' ? `abs(${summ(n.args[0])})` : `${summ(n.args[0])} ${OPSYM[n.op]} ${summ(n.args[1])}`;
  if (n.k === 'cmp') return `${summ(n.args[0])} ${CMPSYM[n.op]} ${summ(n.args[1])}`;
  if (n.k === 'logic') return n.op === 'not' ? `NOT ${summ(n.args[0])}` : '(' + n.args.map(summ).join(` ${n.op.toUpperCase()} `) + ')';
  return '?';
}

// --- spawning -----------------------------------------------------------
function spawnOptions(expected) {
  return expected === 'bool'
    ? [['cmp', 'Compare'], ['logic', 'Logic'], ['match', 'Match'], ['field', 'Value (bool)']]
    : [['field', 'Value'], ['const', 'Const'], ['op', 'Math']];
}
function makeNode(kind, expected) {
  if (kind === 'field') return { k: 'field', path: fieldsOfType(expected === 'bool' ? 'bool' : 'number')[0] };
  if (kind === 'const') return { k: 'const', value: 0 };
  if (kind === 'op') return { k: 'op', op: 'sub', args: [null, null] };
  if (kind === 'cmp') return { k: 'cmp', op: 'lt', args: [null, null] };
  if (kind === 'logic') return { k: 'logic', op: 'and', args: [null, null] };
  if (kind === 'match') return { k: 'match', field: enumFields()[0], value: ENUMS[FIELDS[enumFields()[0]].enum][0] };
}

// --- DOM helpers --------------------------------------------------------
function el(tag, cls, txt) { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
function sel(options, value, onchange) {
  const s = el('select');
  for (const o of options) { const [v, label] = Array.isArray(o) ? o : [o, o]; const op = el('option', null, label); op.value = v; if (v === value) op.selected = true; s.appendChild(op); }
  s.addEventListener('change', () => onchange(s.value));
  return s;
}

// --- rendering ----------------------------------------------------------
function renderSlot(parent, index, expected) {
  const child = parent.args[index];
  const wrap = el('span', 'slot');
  if (!child) {
    const s = sel([['', '+ box']].concat(spawnOptions(expected)), '', v => { if (v) { parent.args[index] = makeNode(v, expected); draw(); } });
    s.classList.add('spawn');
    wrap.appendChild(s);
  } else {
    wrap.appendChild(renderBox(child, expected));
    const x = el('span', 'clr', '×'); x.title = 'remove';
    x.addEventListener('click', () => { parent.args[index] = null; draw(); });
    wrap.appendChild(x);
  }
  return wrap;
}

function renderBox(n, expected) {
  const box = el('div', 'box k-' + n.k + (valid(n) ? '' : ' invalid'));
  const hasKids = n.k === 'op' || n.k === 'cmp' || n.k === 'logic';
  const bh = el('div', 'bh');
  if (hasKids) {
    const c = el('span', 'caret', n._collapsed ? '+' : '-');
    c.addEventListener('click', () => { n._collapsed = !n._collapsed; draw(); });
    bh.appendChild(c);
  }
  bh.appendChild(el('span', 'chip', CHIP[n.k]));
  if (!valid(n)) bh.title = 'incomplete / wrong type';
  box.appendChild(bh);

  if (n._collapsed) { bh.appendChild(el('span', 'sum', summ(n))); return box; }

  const body = el('div', 'children');
  if (n.k === 'field') {
    const opts = (expected === 'bool' || expected === 'number') ? fieldsOfType(expected) : Object.keys(FIELDS);
    body.appendChild(sel(opts.length ? opts : Object.keys(FIELDS), n.path, v => { n.path = v; draw(); }));
  } else if (n.k === 'const') {
    const i = el('input'); i.type = 'number'; i.step = 'any'; i.value = n.value;
    i.addEventListener('change', () => { n.value = parseFloat(i.value) || 0; draw(); });
    body.appendChild(i);
  } else if (n.k === 'match') {
    body.appendChild(sel(enumFields(), n.field, v => { n.field = v; n.value = ENUMS[FIELDS[v].enum][0]; draw(); }));
    body.appendChild(el('span', 'op', '=='));
    body.appendChild(sel(ENUMS[FIELDS[n.field].enum], n.value, v => { n.value = v; draw(); }));
  } else if (n.k === 'op') {
    const opS = sel(OPS, n.op, v => { n.op = v; if (v === 'abs') n.args = [n.args[0] || null]; else if (n.args.length < 2) n.args = [n.args[0] || null, null]; draw(); });
    if (n.op === 'abs') { body.appendChild(opS); body.appendChild(el('span', null, '(')); body.appendChild(renderSlot(n, 0, 'number')); body.appendChild(el('span', null, ')')); }
    else { body.appendChild(renderSlot(n, 0, 'number')); body.appendChild(opS); body.appendChild(renderSlot(n, 1, 'number')); }
  } else if (n.k === 'cmp') {
    body.appendChild(renderSlot(n, 0, 'number'));
    body.appendChild(sel(CMPS, n.op, v => { n.op = v; draw(); }));
    body.appendChild(renderSlot(n, 1, 'number'));
  } else if (n.k === 'logic') {
    const row = el('div', 'slot');
    row.appendChild(sel(['and', 'or', 'not'], n.op, v => { n.op = v; draw(); }));
    body.appendChild(row);
    n.args.forEach((_, i) => { const r = el('div', 'slot'); r.appendChild(el('span', 'lab', n.op === 'not' ? '' : (i ? n.op : ''))); r.appendChild(renderSlot(n, i, 'bool')); body.appendChild(r); });
    if (n.op !== 'not') { const add = el('button', 'addin', '+ input'); add.addEventListener('click', () => { n.args.push(null); draw(); }); body.appendChild(add); }
  }
  box.appendChild(body);
  return box;
}

function draw() {
  const t = document.getElementById('tree'); t.innerHTML = '';
  t.appendChild(renderBox(root, 'bool'));
  document.getElementById('sumtext').textContent = summ(root);
  const b = document.getElementById('sumbadge');
  const ok = valid(root);
  b.textContent = ok ? 'valid' : 'incomplete'; b.className = 'badge ' + (ok ? 'ok' : 'bad');
}
draw();
