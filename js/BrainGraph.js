// BrainGraph.js — an experimental NODE-GRAPH brain runtime: build AI behavior from
// low-level wired nodes (value accessors, operators, branches, switches, waits, and
// parameterized actions) instead of the hand-written ladder in AI.js. This is purely
// ADDITIVE — the shipped AI still uses AI.js/DEFAULT_BRAIN. A graph brain is run by
// runGraph(graph, view, mem) and produces the same { fwd, turn, fire, state } command.
//
// EXECUTION MODEL: the graph is re-walked from `entry` EVERY tick. There are no
// in-tick loops — a "while X" is a branch that re-checks each tick, and a "wait" node
// parks on a timer in `mem`. Flow walks entry → branch/switch → … until it reaches an
// ACTION node, which emits the tick's command. DATA nodes (field/op/cmp/logic/const)
// are pure and evaluated on demand, memoised per tick.

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function wrapPi(a) { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; }

// --- NODE_CATALOG -------------------------------------------------------
// Describes every node type for the editor (palette + which plugs/params it has) and
// documents the vocabulary. kind 'data' = produces a value; kind 'flow' = execution.
export const NODE_CATALOG = {
  // --- data nodes (produce a value) ---
  field: { kind: 'data', out: 'any', label: 'Value', desc: 'Read a value from the world',
           params: [{ key: 'path', type: 'path' }] },
  const: { kind: 'data', out: 'number', label: 'Const', params: [{ key: 'value', type: 'number' }] },
  op:    { kind: 'data', out: 'number', label: 'Math', desc: 'sub / add / mul / abs / min / max',
           params: [{ key: 'op', type: 'enum', of: ['sub', 'add', 'mul', 'abs', 'min', 'max'] }], in: ['a', 'b'] },
  cmp:   { kind: 'data', out: 'bool', label: 'Compare', desc: 'a (op) b',
           params: [{ key: 'op', type: 'enum', of: ['lt', 'gt', 'le', 'ge', 'eq', 'ne'] }], in: ['a', 'b'] },
  logic: { kind: 'data', out: 'bool', label: 'Logic', desc: 'and / or / not',
           params: [{ key: 'op', type: 'enum', of: ['and', 'or', 'not'] }], in: ['inputs'] },
  inList:{ kind: 'data', out: 'bool', label: 'In list?', desc: 'item is in a world list (e.g. known_locations)',
           params: [{ key: 'list', type: 'path' }, { key: 'item', type: 'enumValue' }] },
  match: { kind: 'data', out: 'bool', label: 'Match', desc: 'field equals a value (two dropdowns, no loose ends)',
           params: [{ key: 'field', type: 'field' }, { key: 'value', type: 'enumValue' }] },

  // --- flow nodes (drive execution) ---
  entry:  { kind: 'flow', label: 'Tick start', flowOut: ['next'] },
  branch: { kind: 'flow', label: 'Branch', desc: 'route on a bool', in: ['cond'], flowOut: ['then', 'else'] },
  switch: { kind: 'flow', label: 'Switch', desc: 'route on a value (case plugs)', in: ['value'], flowOut: ['cases', 'default'] },
  wait:   { kind: 'flow', label: 'Wait', desc: 'idle for N seconds, then continue',
            params: [{ key: 'seconds', type: 'number' }], flowOut: ['next'] },
  action: { kind: 'flow', terminal: true, label: 'Action', desc: 'emit this tick’s command',
            params: [{ key: 'action', type: 'enum', of: ['driveOut', 'rotateToward', 'advance', 'engage', 'retreat', 'idle', 'explore'] },
                     { key: 'target', type: 'path' }] },
};

// --- vocabulary schema (drives the editor's dropdowns: no free-text / loose ends) ---
// Enumerated value sets.
export const ENUMS = {
  vehicleType: ['turret', 'jotun', 'lurcher', 'firebrat', 'valkyrie'],
  location:    ['enemyFlag', 'enemyElevator', 'ammoSupply', 'fuelSupply', 'shieldGen'],
  personality: ['turtle', 'pacifist', 'balanced', 'aggressive', 'berserker'],
};
// Selectable world values + their type. enum-typed fields offer ENUMS[enum] downstream;
// list-typed fields feed the inList node. desc shows in a tooltip.
export const FIELDS = {
  'self.x':           { type: 'number', desc: "this unit's world X" },
  'self.z':           { type: 'number', desc: "this unit's world Z" },
  'self.heading':     { type: 'number', desc: "facing (radians)" },
  'self.type':        { type: 'enum', enum: 'vehicleType', desc: "this unit's vehicle type" },
  'self.personality': { type: 'enum', enum: 'personality', desc: "this brain's personality archetype" },
  'self.hpFrac':      { type: 'number', range: [0, 1], desc: "hull remaining (0..1)" },
  'self.fuelFrac':    { type: 'number', range: [0, 1], desc: "fuel remaining (0..1)" },
  'self.ammoFrac':    { type: 'number', range: [0, 1], desc: "ammo remaining (0..1)" },
  'base.x':           { type: 'number', desc: "own base/FOB X" },
  'base.z':           { type: 'number', desc: "own base/FOB Z" },
  'enemy.x':          { type: 'number', desc: "nearest seen rival X" },
  'enemy.z':          { type: 'number', desc: "nearest seen rival Z" },
  'enemy.type':       { type: 'enum', enum: 'vehicleType', desc: "nearest seen rival's type" },
  'seesEnemy':        { type: 'bool', desc: "is a rival currently visible?" },
  'mustGo':           { type: 'bool', desc: "still inside the FOB gate?" },
  'shootGoal':        { type: 'bool', desc: "is the goal a fortification?" },
  'known_locations':  { type: 'list', enum: 'location', desc: "POIs this team has discovered" },
};

// --- world-value resolver -----------------------------------------------
// Reads a dotted path off the view (or latched memory). Unknown → undefined.
function getVal(path, view, mem) {
  if (path == null) return undefined;
  const parts = String(path).split('.');
  if (parts.length === 1) {
    const k = parts[0];
    if (k in view) return view[k];
    if (mem && k in mem) return mem[k];
    return undefined;
  }
  const root = parts[0];
  const obj = root === 'self' ? view.self
            : root === 'mem' ? mem
            : view[root];               // enemy / goal / threat / resupply / base / …
  return obj ? obj[parts[1]] : undefined;
}

// --- data-node evaluation (memoised per tick) ---------------------------
function evalData(id, graph, view, mem, cache) {
  if (id == null) return undefined;
  if (id in cache) return cache[id];
  cache[id] = undefined;                 // cycle guard
  const n = graph.nodes[id];
  let v;
  if (!n) v = undefined;
  else switch (n.type) {
    case 'const': v = n.value; break;
    case 'field': v = getVal(n.path, view, mem); break;
    case 'op': {
      const a = evalData(n.a, graph, view, mem, cache);
      const b = evalData(n.b, graph, view, mem, cache);
      v = n.op === 'abs' ? Math.abs(a) : n.op === 'add' ? a + b : n.op === 'mul' ? a * b
        : n.op === 'min' ? Math.min(a, b) : n.op === 'max' ? Math.max(a, b) : a - b;   // sub default
      break;
    }
    case 'cmp': {
      const a = evalData(n.a, graph, view, mem, cache);
      const b = evalData(n.b, graph, view, mem, cache);
      v = n.op === 'gt' ? a > b : n.op === 'le' ? a <= b : n.op === 'ge' ? a >= b
        : n.op === 'eq' ? a === b : n.op === 'ne' ? a !== b : a < b;                    // lt default
      break;
    }
    case 'logic': {
      const ins = (n.inputs || []).map(i => evalData(i, graph, view, mem, cache));
      v = n.op === 'or' ? ins.some(Boolean) : n.op === 'not' ? !ins[0] : ins.every(Boolean);  // and default
      break;
    }
    case 'inList': {
      const list = getVal(n.list, view, mem);
      v = !!(list && (typeof list.has === 'function' ? list.has(n.item) : list.indexOf(n.item) >= 0));
      break;
    }
    case 'match': v = getVal(n.field, view, mem) === n.value; break;
    default: v = undefined;
  }
  cache[id] = v;
  return v;
}

// --- action leaves ------------------------------------------------------
// Parameterized motor outputs. The geometry stays in code; the graph picks the
// action + its target/params. Each returns { fwd, turn, fire, state }.
function resolveTarget(name, view) {
  switch (name) {
    case 'enemy': return view.enemy;
    case 'threat': return view.threat;
    case 'resupply': return view.resupply || view.goal;
    case 'lastSeen': return view.self && view.self.lastSeen;
    default: return view.goal;
  }
}
function errTo(target, self, jitter = 0, rng = Math.random) {
  if (!target) return { dist: 0, err: 0 };
  const dx = target.x - self.x, dz = target.z - self.z;
  const dist = Math.hypot(dx, dz) || 0.0001;
  const aim = Math.atan2(-dx, -dz);
  return { dist, err: wrapPi(aim - self.heading) + (rng() - 0.5) * jitter };
}
const ACTIONS = {
  driveOut(view, mem, p) {                       // pivot to the gate, then drive straight out
    const { err } = errTo(view.goal, view.self, 0);
    const fwd = Math.abs(err) < 0.30 ? 1 : 0;
    mem._wantMove = fwd > 0.3;
    return { fwd, turn: clamp(err * 2.2, -1, 1), fire: false, state: 'exit' };
  },
  rotateToward(view, mem, p, params) {           // pure pivot onto a target (no drive)
    const { err } = errTo(resolveTarget(params.target, view), view.self, 0);
    mem._wantMove = false;
    return { fwd: 0, turn: clamp(err * 2.5, -1, 1), fire: false, state: 'rotate' };
  },
  advance(view, mem, p) {
    const t = errTo(view.goal, view.self, 0);
    const fwd = t.dist < (view.arriveDist || 8) ? 0 : 1;
    mem._wantMove = fwd > 0.3;
    return { fwd, turn: clamp(t.err * 2.0, -1, 1), fire: false, state: 'advance' };
  },
  engage(view, mem, p) {
    const t = errTo(view.enemy, view.self, 0);
    const range = view.engageRange || 36;
    const fwd = t.dist > range ? 1 : (t.dist < range * 0.6 ? -0.5 : 0);
    const fire = Math.abs(t.err) < 0.2 && view.enemy != null;
    mem._wantMove = Math.abs(fwd) > 0.3;
    return { fwd, turn: clamp(t.err * 2.0, -1, 1), fire, state: 'engage' };
  },
  retreat(view, mem, p) {
    const t = errTo(view.resupply || view.goal, view.self, 0);
    mem._wantMove = true;
    return { fwd: t.dist < 6 ? 0 : 1, turn: clamp(t.err * 2.0, -1, 1), fire: false, state: 'retreat' };
  },
  explore(view, mem, p) {                        // wander to discover new locations (placeholder)
    mem._exploreTurn = (mem._exploreTurn || 0) * 0.96 + (Math.random() - 0.5) * 0.3;
    mem._wantMove = true;
    return { fwd: 1, turn: clamp(mem._exploreTurn, -1, 1), fire: false, state: 'explore' };
  },
  idle(view, mem) { mem._wantMove = false; return { fwd: 0, turn: 0, fire: false, state: 'idle' }; },
};

// --- the evaluator ------------------------------------------------------
export function runGraph(graph, view, mem) {
  mem.t = (mem.t || 0) + view.dt;
  if (!mem.timers) mem.timers = {};
  const cache = {}, visited = new Set(), logs = [];
  let id = graph.entry, guard = 0, cmd = null;
  while (id != null && guard++ < 256) {
    const n = graph.nodes[id];
    if (!n) break;
    if (n.log) logs.push(n.log);          // collect logs along the taken path
    if (n.type === 'entry') { id = n.next; }
    else if (n.type === 'branch') { id = evalData(n.cond, graph, view, mem, cache) ? n.then : n.else; }
    else if (n.type === 'switch') {
      const val = evalData(n.value, graph, view, mem, cache);
      id = (n.cases && n.cases[val] != null) ? n.cases[val] : n.default;
    } else if (n.type === 'wait') {
      visited.add(id);
      if (mem.timers[id] == null) mem.timers[id] = mem.t + (n.seconds || 0);   // arm
      if (mem.t < mem.timers[id]) { mem._wantMove = false; cmd = { fwd: 0, turn: 0, fire: false, state: 'wait' }; break; }
      id = n.next;                       // elapsed: stay "done" (timer left set) and continue
    } else if (n.type === 'action') {
      const fn = ACTIONS[n.action] || ACTIONS.idle;
      cmd = fn(view, mem, mem.p, n.params || {});
      break;
    } else break;
  }
  if (!cmd) cmd = ACTIONS.idle(view, mem);   // no action reached → hold
  // Re-arm any wait node NOT on this tick's path, so leaving and returning waits again
  // (otherwise an elapsed wait would never wait a second time).
  for (const k in mem.timers) { if (!visited.has(k)) mem.timers[k] = null; }
  // Node logs: emit the taken path's logs ONLY when they change, so a log fires on a
  // decision change rather than 60x/second. A different log re-arms it.
  const sig = logs.join(' | ');
  if (sig && sig !== mem.lastLog) {
    if (!mem.logOut) mem.logOut = [];
    mem.logOut.push({ t: +mem.t.toFixed(2), msg: sig });
    if (mem.logOut.length > 60) mem.logOut.shift();
    mem.lastLog = sig;
  }
  cmd.log = sig || null;                      // also expose this tick's active log line
  return cmd;
}

// --- EXAMPLE_GRAPH ------------------------------------------------------
// A small hand-authored graph showing the format the editor will produce. Reproduces
// a slice of behavior: leave the gate, else fight (branch on enemy.type, then on
// self.type — Firebrat flees a Jotun), else advance. "Still in gate?" is the
// low-level decomposition abs(self.x-base.x)<10 && abs(self.z-base.z)<10.
export const EXAMPLE_GRAPH = {
  version: 2,
  type: 'unit-brain-graph',
  entry: 'start',
  nodes: {
    // "Still in gate?" = abs(self.x - base.x) < 10 && abs(self.z - base.z) < 10
    sx: { type: 'field', path: 'self.x' }, bx: { type: 'field', path: 'base.x' },
    sz: { type: 'field', path: 'self.z' }, bz: { type: 'field', path: 'base.z' },
    k10: { type: 'const', value: 10 },
    dX: { type: 'op', op: 'sub', a: 'sx', b: 'bx' }, aX: { type: 'op', op: 'abs', a: 'dX' },
    dZ: { type: 'op', op: 'sub', a: 'sz', b: 'bz' }, aZ: { type: 'op', op: 'abs', a: 'dZ' },
    cX: { type: 'cmp', op: 'lt', a: 'aX', b: 'k10' }, cZ: { type: 'cmp', op: 'lt', a: 'aZ', b: 'k10' },
    inGate: { type: 'logic', op: 'and', inputs: ['cX', 'cZ'] },
    sees: { type: 'field', path: 'seesEnemy' },
    enemyType: { type: 'field', path: 'enemy.type' },
    selfType: { type: 'field', path: 'self.type' },

    start: { type: 'entry', next: 'brGate' },
    brGate: { type: 'branch', cond: 'inGate', then: 'actExit', else: 'brEnemy' },
    actExit: { type: 'action', action: 'driveOut', params: { target: 'goal' }, log: 'leaving the gate' },
    brEnemy: { type: 'branch', cond: 'sees', then: 'swEnemy', else: 'actAdvance' },
    // Firebrat flees a Jotun (one-shot risk); everyone else engages.
    swEnemy: { type: 'switch', value: 'enemyType', cases: { jotun: 'swSelf' }, default: 'actEngage' },
    swSelf: { type: 'switch', value: 'selfType', cases: { firebrat: 'actRetreat' }, default: 'actEngage' },
    actEngage: { type: 'action', action: 'engage', log: 'engaging a rival' },
    actRetreat: { type: 'action', action: 'retreat', params: { target: 'resupply' }, log: 'firebrat fleeing a jotun' },
    actAdvance: { type: 'action', action: 'advance', params: { target: 'goal' }, log: 'advancing to the objective' },
  },
};
