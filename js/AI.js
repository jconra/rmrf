// AI.js — opponent "brains". Deliberately knows nothing about THREE or the scene:
// main.js builds a fog-of-war `view` each tick (only what this unit is allowed to
// perceive) and applies the returned intentions. That keeps the AI honest — it
// can't read the player's position unless it actually sees the player or stumbles
// on a freshly damaged wall.
//
// Each brain has a randomised PERSONALITY (aggression / defensiveness / wanderlust
// / a preferred vehicle / reaction jitter) so no two opponents play the same, and
// a little stochastic noise on top so they stay unpredictable.

const TYPES = ['lurcher', 'firebrat', 'valkyrie', 'jotun'];
const CALLSIGNS = ['Viper', 'Rook', 'Ghost', 'Talon', 'Hammer', 'Wraith', 'Jackal',
                   'Cinder', 'Bolt', 'Reaver', 'Specter', 'Mauler', 'Onyx', 'Karn'];

export function randomPersonality(rng = Math.random) {
  // Bias toward a "lead trait" so personalities feel distinct, not all-average.
  const aggression = clamp01(0.25 + rng() * 0.75);
  return {
    aggression,
    defensiveness: clamp01(0.15 + rng() * 0.7),
    wanderlust: 0.35 + rng() * 0.65,
    reaction: 0.15 + rng() * 0.5,        // decision lag (seconds)
    jitter: 0.1 + rng() * 0.4,           // aim/steer noise
    pref: TYPES[(rng() * TYPES.length) | 0],
    name: CALLSIGNS[(rng() * CALLSIGNS.length) | 0],
  };
}

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function wrapPi(a) { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; }

export class Brain {
  constructor(personality, rng = Math.random) {
    this.p = personality;
    this.rng = rng;
    this.state = 'patrol';
    this.t = 0;
    this.decideT = 0;
    this.lastSeen = null;     // { x, z, t } — last confirmed player sighting
    this.wp = null;           // current patrol waypoint
    this.wpUntil = 0;
    this.avoidBias = 0;       // remembered turn direction while squeezing past a wall
    this._resup = false;      // latched: heading home to rearm/refuel (don't dry-chase)
    this._hurt = false;       // latched: badly damaged → fall back to base to patch up
    this._lx = null; this._lz = null;   // last position (anti-wedge movement check)
    this._stillT = 0;         // time spent trying to move but not moving
    this._unstick = 0;        // remaining time of a reverse-and-pivot jolt
    this._unstickTurn = 1;
    this._wantMove = false;   // did last tick intend to drive forward?
  }

  // Tactical layer: drive toward the commander's strategic GOAL, but break off to
  // fight the player if it's actually seen (fog of war). The commander (main.js)
  // decides the goal + whether to shoot it; this just executes with personality.
  //
  // view: {
  //   dt, self:{x,z,heading,hpFrac,fuelFrac},
  //   seesEnemy:bool, enemy:{x,z}|null,        // nearest VISIBLE rival unit (any team)
  //   goal:{x,z}, shootGoal:bool, arriveDist:number,
  //   blockedAhead:bool, blockedLeft:bool, blockedRight:bool
  // }
  // returns { fwd:-1..1, turn:-1..1, fire:bool, state }
  think(view) {
    const p = this.p, self = view.self;
    this.t += view.dt;

    // --- anti-wedge -------------------------------------------------------
    // If the unit keeps trying to drive but isn't actually moving (jammed on the
    // elevator lip, a gate post, a wall corner), it racks up "still" time and then
    // jolts free with a reverse + hard pivot. This is what breaks the "dancing on
    // the elevator" lock — wall-following alone can loop forever in a tight spot.
    const moved = this._lx != null ? Math.hypot(self.x - this._lx, self.z - this._lz) : 1;
    this._lx = self.x; this._lz = self.z;
    if (this._unstick > 0) {
      this._unstick -= view.dt;
      return { fwd: -0.7, turn: this._unstickTurn, fire: false, state: 'unstick' };
    }
    if (this._wantMove && moved < 0.05) this._stillT += view.dt; else this._stillT = 0;
    if (this._stillT > 1.8) { this._unstick = 0.7; this._unstickTurn = this.rng() < 0.5 ? -1 : 1; this._stillT = 0; }

    if (view.seesEnemy && view.enemy) this.lastSeen = { x: view.enemy.x, z: view.enemy.z, t: this.t };
    const seenRecently = this.lastSeen && (this.t - this.lastSeen.t) < (3 + p.aggression * 5);
    // Aggressive brains peel off to duel a spotted rival; cautious ones stick to
    // the objective unless directly threatened.
    const engaging = view.seesEnemy && (p.aggression > 0.35 || self.hpFrac > 0.4);

    // Out of ammo (or nearly dry on fuel) → break off and go home to resupply
    // instead of uselessly chasing. Latched with hysteresis so it tops up before
    // returning to the fight rather than yo-yoing at the first round.
    const ammoF = self.ammoFrac != null ? self.ammoFrac : 1;
    if (!this._resup && (ammoF <= 0 || self.fuelFrac < 0.18)) this._resup = true;
    else if (this._resup && ammoF > 0.6 && self.fuelFrac > 0.5) this._resup = false;

    // Self-preservation: when chewed down, break off and fall back to base to patch
    // up instead of feeding itself to the defences. Latched with hysteresis (a brave
    // brain holds a little longer) so it doesn't yo-yo at the threshold, and it
    // repairs to a healthy margin before committing again.
    const bail = 0.45 - p.aggression * 0.18;       // 0.27–0.45: pull out EARLY, not at death's door
    if (!this._hurt && self.hpFrac < bail) this._hurt = true;
    else if (this._hurt && self.hpFrac > 0.8) this._hurt = false;

    // A wall-turret is shelling us and we still have teeth → silence it before pushing
    // the fort. Cautious brains suppress sooner; brave ones tolerate more incoming.
    const threatened = view.threat && ammoF > 0 && self.hpFrac > bail;

    let target, mode;
    if (view.mustGo) { target = view.goal; mode = 'exit'; }   // clear the gate before anything else
    else if (this._hurt) { target = view.resupply || view.goal; mode = 'retreat'; }   // fall back, minimize exposure
    else if (this._resup) { target = view.resupply || view.goal; mode = 'resupply'; }
    else if (engaging) { target = view.enemy; mode = 'engage'; }
    else if (threatened) { target = view.threat; mode = 'suppress'; }   // kill the tower that's hurting us
    else if (seenRecently && p.aggression > 0.6) { target = this.lastSeen; mode = 'pursue'; }
    else { target = view.goal; mode = view.shootGoal ? 'assault' : 'advance'; }
    this.state = mode;

    const dx = target.x - self.x, dz = target.z - self.z;
    const dist = Math.hypot(dx, dz) || 0.0001;
    // Vehicle front is local -Z → forward = (-sin h, -cos h), so aim = atan2(-dx,-dz).
    const aim = Math.atan2(-dx, -dz);
    let err = wrapPi(aim - self.heading) + (this.rng() - 0.5) * p.jitter * 0.6;
    let turn = clamp(err * 2.0, -1, 1);
    let fwd = 1;
    let fire = false;

    // --- leaving the FOB: face the gate, THEN drive out --------------------
    // A unit that tops the lift off-angle (or whose exit gate changed on detach)
    // pivots IN PLACE until it's lined up on the exit waypoint, then drives
    // straight through. The old behaviour crept forward while turning, arcing it
    // into the shaft/gate wall — and because it kept inching, the anti-wedge jolt
    // never tripped (the "stuck on the elevator" dance). No whisker wall-follow
    // here; if it's truly nose-on a wall the anti-wedge above is the backstop.
    if (mode === 'exit') {
      turn = clamp(err * 2.2, -1, 1);
      fwd = Math.abs(err) < 0.30 ? 1 : 0;   // aligned → straight out; else turn in place
      this._wantMove = fwd > 0.3;
      return { fwd, turn, fire: false, state: mode };
    }

    // --- obstacle avoidance (whiskers) -------------------------------------
    if (view.blockedAhead) {
      if (!this.avoidBias) this.avoidBias = view.blockedLeft && !view.blockedRight ? 1
                                          : view.blockedRight && !view.blockedLeft ? -1
                                          : (this.rng() < 0.5 ? -1 : 1);
      turn = this.avoidBias;
      fwd = (view.blockedLeft && view.blockedRight) ? -0.6 : 0.3;
      this._wantMove = true;
      return { fwd, turn, fire, state: mode };
    }
    this.avoidBias = 0;

    const aimGate = 0.18 + p.aggression * 0.12;
    const want = view.engageRange || 36;        // this type's preferred stand-off
    if (mode === 'engage' || mode === 'suppress') {
      // Hold at effective range and shoot rather than charging the kill zone. A
      // suppressing unit keeps the turret at arm's length (full stand-off); a mobile
      // duel lets aggressive brains press in closer.
      const range = mode === 'suppress' ? want : want * (1 - p.aggression * 0.45);
      const los = mode !== 'suppress' || view.threatLOS;   // duel target is always visible
      // Flank approach: arc around the tower's side instead of driving dead at it
      // through the wall-gap crossfire. With a clean shot the bias fades to zero as
      // we reach range (heading settles onto the tower to fire); with NO shot yet we
      // swing hard and keep circling the perimeter until a line opens up — that's the
      // "go around the side and hit the corner from the flank" move.
      let steer = err;
      if (mode === 'suppress' && view.flankSide) {
        const k = clamp((dist - range) / range, 0, 1);     // 1 far out → 0 at range
        steer = view.threatLOS ? err + view.flankSide * 0.85 * k
                               : err + view.flankSide * 1.5;
      }
      turn = clamp(steer * 2.0, -1, 1);
      if (!los) fwd = 0.6;                          // no clean shot → circle in to find one
      else if (dist < range * 0.6) fwd = -0.5;      // inside the danger band → back out
      else if (dist < range * 0.95) fwd = 0;        // hold and pour fire
      else fwd = 1;                                  // close to range
      const gate = mode === 'suppress' ? aimGate + 0.05 : aimGate;
      if (los && Math.abs(err) < gate && dist < range * 1.3) fire = this.rng() < (0.65 + p.aggression * 0.35);
    } else if (mode === 'assault') {
      // Pound the fortification, but from the type's reach — heavies shell it from
      // outside the turrets' best range instead of nosing up to the wall.
      const standoff = want * 0.7;
      if (dist < standoff) fwd = 0.1; else fwd = 1;
      if (Math.abs(err) < aimGate + 0.06 && dist < standoff * 1.4) fire = this.rng() < 0.75;
    } else { // advance / pursue / resupply / retreat — just get there
      fwd = (dist < (view.arriveDist || 8)) ? 0 : 1;
    }

    this._wantMove = Math.abs(fwd) > 0.3;
    return { fwd, turn, fire, state: mode };
  }
}
