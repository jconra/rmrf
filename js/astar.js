// astar.js — direction-aware A* over a grid. No THREE dependency, so it can be
// unit-tested in Node. The turn penalty rewards long straight runs; the per-cell
// cost lets callers make land cheap and water expensive (so roads bridge only
// when forced).

// opts: { start:{i,j}, goal:{i,j}, cost(i,j)->number|Infinity,
//         inBounds(i,j)->bool, turnPenalty }. Returns [{i,j}...] or null.
export function astarGrid({ start, goal, cost, inBounds, turnPenalty = 4 }) {
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const key = (i, j, d) => i + ',' + j + ',' + d;
  const h = (i, j) => Math.hypot(i - goal.i, j - goal.j);

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

  while (heap.length) {
    const cur = pop();
    const curK = key(cur.i, cur.j, cur.d);
    if (cur.g > (g.get(curK) ?? Infinity)) continue;
    if (cur.i === goal.i && cur.j === goal.j) {
      const path = [];
      let node = cur;
      while (node) { path.push({ i: node.i, j: node.j }); node = from.get(key(node.i, node.j, node.d)) || null; }
      return path.reverse();
    }
    for (let di = 0; di < 4; di++) {
      const ni = cur.i + DIRS[di][0], nj = cur.j + DIRS[di][1];
      if (!inBounds(ni, nj)) continue;
      const tc = cost(ni, nj);
      if (!isFinite(tc)) continue;
      const step = tc + (cur.d !== -1 && di !== cur.d ? turnPenalty : 0);
      const ng = cur.g + step;
      const nk = key(ni, nj, di);
      if (ng < (g.get(nk) ?? Infinity)) {
        g.set(nk, ng);
        from.set(nk, cur);
        push({ i: ni, j: nj, d: di, g: ng, f: ng + h(ni, nj) });
      }
    }
  }
  return null;
}
