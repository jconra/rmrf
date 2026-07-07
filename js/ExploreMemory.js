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
  constructor(worldW, worldH, cell = 30, isLand = null) {
    this.cell = cell;
    this.halfW = worldW / 2;
    this.halfH = worldH / 2;
    this.gw = Math.max(1, Math.ceil(worldW / cell));
    this.gh = Math.max(1, Math.ceil(worldH / cell));
    this.seen = new Uint8Array(this.gw * this.gh);
    this.seenCount = 0;
    // Mark which cells are LAND. Ocean cells are never worth scouting AND can never be reached/
    // marked-seen — so a scout that targeted one froze against the coast forever, and the sea
    // (~85% of the map) kept fraction() near 0 so "mostly explored" never triggered. Excluding
    // ocean from BOTH pickTarget and fraction fixes both. isLand(worldX,worldZ)->bool; null = all land.
    this.land = new Uint8Array(this.gw * this.gh);
    this.landTotal = 0; this.landSeen = 0;
    // A cell counts as LAND only if MOST of it is land — sample the centre plus four
    // quarter-offset points and require a majority. Sampling the centre alone marked a
    // mostly-water cell "land" whenever a sliver of coast happened to sit dead-centre, so a
    // scout would beeline out over open ocean toward that water-fringe speck and look stuck.
    const q = cell / 4;
    for (let j = 0; j < this.gh; j++) for (let i = 0; i < this.gw; i++) {
      const c = this._cellCentre(i, j);
      let hits = 0;
      if (!isLand) { hits = 5; }
      else for (const [dx, dz] of [[0, 0], [-q, -q], [q, -q], [-q, q], [q, q]]) {
        if (isLand(c.x + dx, c.z + dz)) hits++;
      }
      if (hits >= 3) { this.land[j * this.gw + i] = 1; this.landTotal++; }
    }
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
        if (!this.seen[k]) { this.seen[k] = 1; this.seenCount++; if (this.land[k]) this.landSeen++; }
      }
    }
  }

  // Fraction of the LAND explored (ocean is excluded — it can't be scouted and never gets marked).
  fraction() { return this.landTotal ? this.landSeen / this.landTotal : 1; }

  // Pick an unexplored cell to head for next. Sweep the NEAREST unexplored ground — since the
  // cells behind the unit are already painted seen, "nearest unexplored" naturally sits ahead/
  // to the side, so the scout makes steady FORWARD progress filling the map contiguously (the
  // old "far from me, near home" score yanked an out-on-the-field scout back toward home every
  // repick, so it ping-ponged and barely advanced). A mild home term still breaks ties toward
  // safer ground so it doesn't dive at the enemy base. `minR` skips cells so close the caller
  // would clear them on the next tick (which froze the scout: arrived → stops, never repicks).
  // Returns a world point {x,z} at the cell centre, or null when everything's explored.
  // enemyX/enemyZ (optional): the enemy base — scouting should sweep TOWARD it (that's where
  // the intel worth having is), not back toward home. When omitted, falls back to a mild
  // pull toward home (safer ground) so callers without an enemy anchor still don't ping-pong.
  pickTarget(selfX, selfZ, homeX, homeZ, minR = 0, enemyX = null, enemyZ = null) {
    let best = -Infinity, target = null, nearBest = Infinity, near = null;
    const minR2 = minR * minR;
    const toEnemy = enemyX != null && enemyZ != null;
    for (let j = 0; j < this.gh; j++) {
      for (let i = 0; i < this.gw; i++) {
        const k = j * this.gw + i;
        if (this.seen[k] || !this.land[k]) continue;   // skip already-seen AND ocean (unreachable, nothing to scout)
        const c = this._cellCentre(i, j);
        const d2 = (c.x - selfX) ** 2 + (c.z - selfZ) ** 2;
        if (d2 < nearBest) { nearBest = d2; near = c; }   // absolute nearest (fallback if all are inside minR)
        if (d2 < minR2) continue;
        const dSelf = Math.sqrt(d2);
        let score;
        if (SWEEP_MODE === 'far') {
          score = dSelf - 1.35 * Math.hypot(c.x - homeX, c.z - homeZ);   // OLD: far from me, near home (ping-ponged)
        } else if (toEnemy) {
          // nearest unexplored (forward sweep) but tilt the sweep toward the enemy base so the
          // scout advances into enemy ground instead of loitering near home over the water.
          score = -dSelf - 0.5 * Math.hypot(c.x - enemyX, c.z - enemyZ);
        } else {
          score = -dSelf - 0.3 * Math.hypot(c.x - homeX, c.z - homeZ);   // no enemy anchor: mild pull toward safe ground
        }
        if (score > best) { best = score; target = c; }
      }
    }
    return target || near;   // everything unexplored was within minR → just take the nearest so the scout keeps going
  }
}
