// Roads.js — 1-cell-wide roads on the SHARED build grid (same grid as walls).
// Rendered as one tile per cell (no overlapping strips -> no z-fighting), with
// real corners. A 1-wide road threads the centre cell of a 3-wide gate. The
// network is generated with A* (turn penalty rewards straights; terrain cost
// keeps it on land and bridges only when forced).

import * as THREE from 'three';
import { astarGrid } from './astar.js';
import { TILE } from './IslandMap.js';

const ASPHALT = new THREE.MeshStandardMaterial({ color: '#5b5e63', roughness: 0.92, flatShading: true });
const DECK = new THREE.MeshStandardMaterial({ color: '#7a6e57', roughness: 0.9, flatShading: true });
const RAIL = new THREE.MeshStandardMaterial({ color: '#544c3b', roughness: 0.9, flatShading: true });

// Straight road-tile texture: white side stripes + one dashed centre mark.
function makeTileTexture() {
  const s = 64;
  const cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#5b5e63'; ctx.fillRect(0, 0, s, s);
  for (let i = 0; i < 400; i++) { const v = 70 + Math.random() * 36 | 0; ctx.fillStyle = `rgb(${v},${v},${v + 4})`; ctx.fillRect(Math.random() * s, Math.random() * s, 1, 1); }
  ctx.fillStyle = '#e8e8e8';
  ctx.fillRect(0, 0, s * 0.07, s);
  ctx.fillRect(s * 0.93, 0, s * 0.07, s);
  ctx.fillRect(s * 0.46, s * 0.28, s * 0.08, s * 0.44);   // one centre dash
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

class RoadTiles {
  constructor(cell, heightFn) {
    this.group = new THREE.Group();
    this.width = cell;
    this.heightFn = heightFn;   // (x,z) -> terrain height, for draping
    this.straightMat = new THREE.MeshStandardMaterial({ map: makeTileTexture(), roughness: 0.92 });
  }

  clear() {
    this.group.traverse(o => { if (o.isMesh) o.geometry.dispose(); });
    this.group.clear();
  }

  // One road tile DRAPED onto the terrain: a subdivided quad whose vertices are
  // pulled down to the ground height, so the road hugs slopes instead of a flat
  // plane clipping through. orient: 'ns' | 'ew' (textured) or null (plain).
  tile(x, z, orient) {
    const SUB = 4;
    const geo = new THREE.PlaneGeometry(this.width, this.width, SUB, SUB);
    geo.rotateX(-Math.PI / 2);                          // lie flat in XZ (default => 'ns')
    if (orient === 'ew') geo.rotateY(Math.PI / 2);      // turn stripes across X
    const p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      p.setY(i, this.heightFn(x + p.getX(i), z + p.getZ(i)) + 0.07);   // drape + tiny lift
    }
    p.needsUpdate = true;
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, orient ? this.straightMat : ASPHALT);
    mesh.position.set(x, 0, z);
    mesh.receiveShadow = true;
    this.group.add(mesh);
  }

  // Raised plank bridge deck tile (over water), with rails on the across sides.
  deck(x, z, y, orient) {
    const grp = new THREE.Group();
    const d = new THREE.Mesh(new THREE.BoxGeometry(this.width, 0.16, this.width), DECK);
    grp.add(d);
    for (const s of [-1, 1]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.45, this.width), RAIL);
      rail.position.set(s * this.width / 2, 0.3, 0);
      grp.add(rail);
    }
    if (orient === 'ew') grp.rotation.y = Math.PI / 2;
    grp.position.set(x, y + 0.35, z);
    this.group.add(grp);
  }
}

// Generates the road network with A* on the shared grid.
export class RoadNetwork {
  constructor(map, grid) {
    this.map = map;
    this.grid = grid;
    this.cell = grid.cell;
    this.tiles = new RoadTiles(grid.cell, (x, z) => this.map.heightAt(x, z));
    this.group = this.tiles.group;
    this._blocked = new Set();
    this._open = new Set();
    this._buffer = new Set();
  }

  setObstacles(camps) {
    this._blocked = new Set();
    this._open = new Set();
    this._buffer = new Set();
    const corridor = new Set();
    for (const c of camps) {
      for (const k of c.blockedCells) this._blocked.add(k);
      for (const k of c.openCells) this._open.add(k);
      // Keep the forced gate-exit corridor traversable (the one gap in the moat).
      for (const g of c.gates) {
        const gc = this._rc(g.pos.x, g.pos.z);
        const di = Math.round(g.outward.x), dj = Math.round(g.outward.z);
        for (let k = 0; k <= 3; k++) corridor.add((gc.i + k * di) + ',' + (gc.j + k * dj));
      }
    }
    // Moat: the ring of cells just outside any footprint (8-neighbourhood), minus
    // footprint and corridor. Roads can't hug a wall or dive back toward a gate.
    const NB = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
    for (const key of this._blocked) {
      const p = key.split(','), i = +p[0], j = +p[1];
      for (const [di, dj] of NB) {
        const nk = (i + di) + ',' + (j + dj);
        if (!this._blocked.has(nk) && !corridor.has(nk)) this._buffer.add(nk);
      }
    }
  }

  _rc(x, z) { const c = this.grid.worldToCell(x, z); return { i: c.cx, j: c.cz }; }   // map grid {cx,cz} -> A*/line {i,j}
  _inBounds(i, j) {
    const w = this.grid.cellToWorld(i, j);
    return Math.abs(w.x) <= this.map.worldW / 2 && Math.abs(w.z) <= this.map.worldH / 2;
  }
  _tileAt(i, j) { const w = this.grid.cellToWorld(i, j); return this.map.tileAt(w.x, w.z); }
  _isWater(i, j) { const t = this._tileAt(i, j); return t === TILE.SHALLOW || t === TILE.DEEP; }
  _cost(i, j) {
    const k = i + ',' + j;
    if (!this._open.has(k)) {
      if (this._blocked.has(k)) return Infinity;   // wall / interior — impassable
      if (this._buffer.has(k)) return 5000;        // moat ring — avoid unless truly forced
    }
    const t = this._tileAt(i, j);
    if (t === TILE.SAND || t === TILE.GRASS || t === TILE.ROCK) return 1;
    if (t === TILE.SHALLOW) return 8;
    return 22;   // deep water — only bridged when forced
  }

  // connections: [{ a:gate, b:gate, y }], gate = { pos:Vector3, outward:Vector3 }.
  build(connections) {
    this.tiles.clear();
    const cells = new Map();   // key -> { i, j, y }
    const add = (i, j, y) => { const k = i + ',' + j; if (!cells.has(k)) cells.set(k, { i, j, y }); };

    // Each gate gets a forced STRAIGHT exit: the road runs out from the gate's
    // centre cell along its outward normal for 2 cells before A* takes over. This
    // guarantees a clean perpendicular exit (A* can't immediately turn sideways
    // into the gate post), then pathfinding connects the two approach points
    // while steering around every wall (cost 500).
    const APPROACH = 2;
    const exit = (gate, y) => {
      const gc = this._rc(gate.pos.x, gate.pos.z);
      const di = Math.round(gate.outward.x), dj = Math.round(gate.outward.z);
      for (let k = 0; k <= APPROACH; k++) {
        const ci = gc.i + k * di, cj = gc.j + k * dj, key = ci + ',' + cj;
        if (this._open.has(key) || !this._blocked.has(key)) add(ci, cj, y);   // don't paint onto a foreign wall
      }
      return { i: gc.i + APPROACH * di, j: gc.j + APPROACH * dj };
    };
    for (const c of connections) {
      const sA = exit(c.a, c.y);
      const sB = exit(c.b, c.y);
      const path = astarGrid({
        start: sA, goal: sB,
        cost: (i, j) => this._cost(i, j),
        inBounds: (i, j) => this._inBounds(i, j),
        turnPenalty: 6,
      });
      // Safety net: never paint a tile onto a wall cell (guards the rare case
      // where an approach endpoint lands in a tightly-packed neighbour's footprint).
      if (path) for (const p of path) {
        const key = p.i + ',' + p.j;
        if (this._open.has(key) || !this._blocked.has(key)) add(p.i, p.j, c.y);
      }
    }
    this.cells = cells;   // exposed for verification (road-through-wall checks)

    // Render: classify each cell by its road neighbours -> straight/corner/etc.
    // Land tiles follow the terrain; bridge decks ride a level grade over water.
    const has = (i, j) => cells.has(i + ',' + j);
    const bridgeY = this.map.params.beachHeight + 0.5;
    for (const { i, j, y } of cells.values()) {
      const wx = i * this.cell, wz = j * this.cell;
      const n = has(i, j - 1), s = has(i, j + 1), e = has(i + 1, j), w = has(i - 1, j);
      const orient = (n && s && !e && !w) ? 'ns' : (e && w && !n && !s) ? 'ew' : null;
      if (this._isWater(i, j)) this.tiles.deck(wx, wz, Math.max(y, bridgeY), orient || 'ns');
      else this.tiles.tile(wx, wz, orient);
    }
  }
}
