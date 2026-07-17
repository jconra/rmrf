// astar.js — direction-aware A* over a grid. No THREE dependency, so it can be
// unit-tested in Node. The turn penalty rewards long straight runs; the per-cell
// cost lets callers make land cheap and water expensive (so roads bridge only
// when forced).

// opts: { start:{i,j}, goal:{i,j}, cost(i,j)->number|Infinity,
//         inBounds(i,j)->bool, turnPenalty, onStep }. Returns [{i,j}...] or null.
// onStep (optional) is a visualizer hook: it fires once per node popped off the
// heap, with { cur:{i,j}, open:[{i,j}...] (the live frontier), path:[{i,j}...]
// (best route to cur so far) }. It's guarded so normal pathfinding pays nothing.
export function astarGrid({ start, goal, cost, inBounds, turnPenalty = 4, allowDiagonal = false, onStep = null, maxNodes = Infinity, partial = false, hScale = 1 }) {
  // Default is 4-connected (orthogonal) — road LAYOUT needs clean right-angle, connected
  // grids. allowDiagonal adds the 4 diagonals so UNIT NAV can cut straight across open
  // ground instead of staircasing. A diagonal step travels √2 as far, so it costs √2× the
  // cell — otherwise A* would over-prefer diagonals.
  const CARD = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const DIRS = allowDiagonal ? CARD.concat([[1, 1], [1, -1], [-1, 1], [-1, -1]]) : CARD;
  const SQRT2 = Math.SQRT2;
  const key = (i, j, d) => i + ',' + j + ',' + d;
  // hScale: the heuristic assumes every cell costs ≥1, but callers with DISCOUNTED cells
  // (road reuse at 0.1) make that an OVERESTIMATE along the cheap corridor — inadmissible,
  // so A* would settle the goal via a full-price direct route without ever exploring the
  // discounted one (why new roads ran parallel to existing roads instead of merging).
  // Pass hScale = the minimum possible cell cost to restore admissibility (more node
  // expansions, exact results) — worth it for one-shot layout work like roads; unit nav
  // keeps 1 (speed over exactness: its discounts are mild and per-frame budget is tight).
  const h = (i, j) => Math.hypot(i - goal.i, j - goal.j) * hScale;

  // Tiny binary min-heap keyed on f.
  const heap = [];
  const push = (n) => {
    heap.push(n); let c = heap.length - 1;
    while (c > 0) { const p = (c - 1) >> 1; if (heap[p].f <= heap[c].f) break; [heap[p], heap[c]] = [heap[c], heap[p]]; c = p; }
  };
  const pop = () => {
    const top = heap[0], last = heap.pop();
    if (heap.length) {
      heap[0] = last; let c = 0;
      for (;;) { let s = c; const l = 2 * c + 1, r = l + 1; if (l < heap.length && heap[l].f < heap[s].f) s = l; if (r < heap.length && heap[r].f < heap[s].f) s = r; if (s === c) break; [heap[s], heap[c]] = [heap[c], heap[s]]; c = s; }
    }
    return top;
  };

  const g = new Map();
  const from = new Map();
  g.set(key(start.i, start.j, -1), 0);
  push({ i: start.i, j: start.j, d: -1, g: 0, f: h(start.i, start.j) });

  const buildPath = (node) => { const path = []; while (node) { path.push({ i: node.i, j: node.j }); node = from.get(key(node.i, node.j, node.d)) || null; } return path.reverse(); };
  // PARTIAL fallback: remember the settled node CLOSEST to the goal, so an unreachable / past-bound
  // search can still hand back a valid route that makes real progress toward the goal instead of null
  // (the caller then walks toward it along passable cells rather than beelining straight into terrain).
  let best = null, bestH = Infinity;
  let popped = 0, budgetHit = false;
  while (heap.length) {
    const cur = pop();
    // SEARCH BOUND: an UNREACHABLE goal would otherwise expand the entire reachable grid
    // (tens of thousands of cellBlocked calls) — and unit nav re-runs that constantly, which
    // was the perf sawtooth. Give up past the bound and return the best partial (below) / back off.
    if (++popped > maxNodes) { budgetHit = true; break; }
    const curK = key(cur.i, cur.j, cur.d);
    if (cur.g > (g.get(curK) ?? Infinity)) continue;
    const ch = h(cur.i, cur.j);
    if (ch < bestH) { bestH = ch; best = cur; }
    if (onStep) {
      // Reconstruct the best-known route to the node we just settled, so the
      // visualizer can draw the path firming up as the frontier sweeps outward.
      const pth = []; let node = cur;
      while (node) { pth.push({ i: node.i, j: node.j }); node = from.get(key(node.i, node.j, node.d)) || null; }
      pth.reverse();
      onStep({ cur: { i: cur.i, j: cur.j }, open: heap.map(n => ({ i: n.i, j: n.j })), path: pth });
    }
    if (cur.i === goal.i && cur.j === goal.j) return buildPath(cur);
    for (let di = 0; di < DIRS.length; di++) {
      const ddi = DIRS[di][0], ddj = DIRS[di][1];
      const ni = cur.i + ddi, nj = cur.j + ddj;
      if (!inBounds(ni, nj)) continue;
      const tc = cost(ni, nj);
      if (!isFinite(tc)) continue;
      const diag = ddi !== 0 && ddj !== 0;
      // No corner-cutting: a diagonal step is only allowed if both orthogonally-adjacent
      // cells are passable, so units don't clip the corner of a wall/building.
      if (diag && (!isFinite(cost(cur.i, nj)) || !isFinite(cost(ni, cur.j)))) continue;
      const step = (diag ? tc * SQRT2 : tc) + (cur.d !== -1 && di !== cur.d ? turnPenalty : 0);
      const ng = cur.g + step;
      const nk = key(ni, nj, di);
      if (ng < (g.get(nk) ?? Infinity)) {
        g.set(nk, ng);
        from.set(nk, cur);
        push({ i: ni, j: nj, d: di, g: ng, f: ng + h(ni, nj) });
      }
    }
  }
  // Goal unreachable (or past the node bound): hand back the closest partial route, but only if it
  // actually gets NEARER the goal than the start — otherwise there's no progress to be had (null).
  // The path carries WHY it's partial: budgetHit=true means the search ran out of NODES (the goal
  // may be perfectly reachable, just far — a long trek on a big map); budgetHit=false means the
  // open set EMPTIED — every reachable cell was settled and the goal wasn't among them: genuinely
  // unreachable. Callers judging a "contract violation" must only trust the second kind.
  if (partial && best && bestH < h(start.i, start.j) - 0.5) { const p = buildPath(best); p.budgetHit = budgetHit; return p; }
  return null;
}
