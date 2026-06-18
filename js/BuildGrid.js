// BuildGrid.js — the single placement grid everything snaps to: walls,
// corner-turrets, buildings, roads, gates. Aligned to the island, centred at
// world origin. Cell size is tunable; we'll dial it in once walls exist.

import * as THREE from 'three';

export class BuildGrid {
  // map: IslandMap (for ground height). cell: world units per build square.
  constructor(map, cell = 5) {
    this.map = map;
    this.cell = cell;
  }

  // Build-cell (integer cx,cz, centred on origin) -> world centre point,
  // sampling terrain height so pieces sit on the ground.
  cellToWorld(cx, cz) {
    const x = cx * this.cell;
    const z = cz * this.cell;
    return new THREE.Vector3(x, this.map ? this.map.heightAt(x, z) : 0, z);
  }

  // World point -> nearest build-cell coords.
  worldToCell(x, z) {
    return { cx: Math.round(x / this.cell), cz: Math.round(z / this.cell) };
  }
}
