// ExploreMemory.js — a commander's coarse memory of WHERE its team has already looked.
// The unit-level brain has fog-of-war senses (it sees rivals/depots within AI_VISION);
// this is the COMMANDER-level complement: a low-res grid of the whole map that fills in
// as the team's units drive around, so a scout can be told "go somewhere we haven't been
// yet" instead of beelining the enemy base into the towers.
//
// One grid per commander (team-shared intel that outlives any single unit). Cells are
// coarse (~40u) — far bigger than a nav cell — because all we need is a sense of which
// broad regions are known. World is centred on the origin: x,z run [-worldW/2, +worldW/2].

// A/B knob: 'near' = new nearest-unexplored forward sweep; 'far' = old "far from me, near home"
// score (which ping-ponged). Toggled globally via RR.setScoutSweep for paired self-play tests.
let SWEEP_MODE = 'near';
export function setSweepMode(m) { SWEEP_MODE = m === 'far' ? 'far' : 'near'; return SWEEP_MODE; }

export class ExploreMemory {
  constructor(worldW, worldH, cell = 30) {
    this.cell = cell;
    this.halfW = worldW / 2;
    this.halfH = worldH / 2;
    this.gw = Math.max(1, Math.ceil(worldW / cell));
    this.gh = Math.max(1, Math.ceil(worldH / cell));
    this.seen = new Uint8Array(this.gw * this.gh);
    this.seenCount = 0;
  }

  // World point → cell centre (used to score candidates back in world space).
  _cellCentre(i, j) { return { x: (i + 0.5) * this.cell - this.halfW, z: (j + 0.5) * this.cell - this.halfH }; }

  // Mark every cell whose centre lies within `radius` of (x,z) as explored. Called each
  // tick from the live unit's position, so a moving unit paints a swathe of the map known.
  mark(x, z, radius) {
    const r = Math.ceil(radius / this.cell), r2 = radius * radius;
    const cx = Math.floor((x + this.halfW) / this.cell), cz = Math.floor((z + this.halfH) / this.cell);
    for (let j = cz - r; j <= cz + r; j++) {
      if (j < 0 || j >= this.gh) continue;
      for (let i = cx - r; i <= cx + r; i++) {
        if (i < 0 || i >= this.gw) continue;
        const c = this._cellCentre(i, j);
        if ((c.x - x) ** 2 + (c.z - z) ** 2 > r2) continue;
        const k = j * this.gw + i;
        if (!this.seen[k]) { this.seen[k] = 1; this.seenCount++; }
      }
    }
  }

  fraction() { return this.seenCount / this.seen.length; }

  // Pick an unexplored cell to head for next. Sweep the NEAREST unexplored ground — since the
  // cells behind the unit are already painted seen, "nearest unexplored" naturally sits ahead/
  // to the side, so the scout makes steady FORWARD progress filling the map contiguously (the
  // old "far from me, near home" score yanked an out-on-the-field scout back toward home every
  // repick, so it ping-ponged and barely advanced). A mild home term still breaks ties toward
  // safer ground so it doesn't dive at the enemy base. `minR` skips cells so close the caller
  // would clear them on the next tick (which froze the scout: arrived → stops, never repicks).
  // Returns a world point {x,z} at the cell centre, or null when everything's explored.
  pickTarget(selfX, selfZ, homeX, homeZ, minR = 0) {
    let best = -Infinity, target = null, nearBest = Infinity, near = null;
    const minR2 = minR * minR;
    for (let j = 0; j < this.gh; j++) {
      for (let i = 0; i < this.gw; i++) {
        if (this.seen[j * this.gw + i]) continue;
        const c = this._cellCentre(i, j);
        const d2 = (c.x - selfX) ** 2 + (c.z - selfZ) ** 2;
        if (d2 < nearBest) { nearBest = d2; near = c; }   // absolute nearest (fallback if all are inside minR)
        if (d2 < minR2) continue;
        const dSelf = Math.sqrt(d2);
        const dHome = Math.hypot(c.x - homeX, c.z - homeZ);
        const score = SWEEP_MODE === 'far'
          ? dSelf - 1.35 * dHome        // OLD: far from me, near home (ping-ponged)
          : -dSelf - 0.3 * dHome;       // NEW: nearest unexplored (forward sweep), mild pull toward safe ground
        if (score > best) { best = score; target = c; }
      }
    }
    return target || near;   // everything unexplored was within minR → just take the nearest so the scout keeps going
  }
}
