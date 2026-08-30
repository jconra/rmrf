// AI.js — opponent "brains". Deliberately knows nothing about THREE or the scene:
// main.js builds a fog-of-war `view` each tick (only what this unit is allowed to
// perceive) and applies the returned intentions. That keeps the AI honest — it
// can't read the player's position unless it actually sees the player or stumbles
// on a freshly damaged wall.
//
// Each brain has a randomised PERSONALITY (aggression / defensiveness / wanderlust
// / a preferred vehicle / reaction jitter) so no two opponents play the same, and
// a little stochastic noise on top so they stay unpredictable.
//
// DATA-DRIVEN DECISION GRAPH: the tactical logic is split into three parts so it
// can be inspected and edited as a flowchart (and round-tripped through an external
// editor) without touching this file:
//   * CONDITIONS — named predicates over the `view` + latched memory.
//   * BEHAVIORS  — named steering routines that produce {fwd,turn,fire}. The trig
//                  lives here; the graph only chooses WHICH one runs and WHEN.
//   * DEFAULT_BRAIN — the graph itself: config knobs, latched interrupts, and an
//                  ordered transition table. `runBrain(graph, view, mem)` walks it.
// `Brain.think()` is now a thin wrapper around runBrain(DEFAULT_BRAIN, …); assign a
// different graph to a brain's `.graph` to change its behavior.

import { COUNTER } from './AIStrategies.js?v=114';   // rock-paper-scissors web for fight-or-flight matchups
import { locomote } from './Locomotion.js?v=1';     // the ONE steering primitive (behaviors emit orders, not motor math)

const TYPES = ['lurcher', 'firebrat', 'valkyrie', 'jotun'];

// Rough ground-speed rank for the "can I outrun what's shooting me?" survivability check
// in fightScore. Flyers (valkyrie) escape via altitude regardless — handled by view.flyer.
const SPEED = { firebrat: 4, valkyrie: 3, lurcher: 2, jotun: 1 };

// AI combat handicap — the single knob for "how hard does the AI hit". A human on a
// touchscreen can't out-aim a perfect bot, so the opponents are deliberately reined in:
//   aimSpread > 1 sprays their shots wider (more clean misses)
//   fireProb  < 1 makes them shoot less often (longer gaps to react / flee)
// Set both to 1.0 for the old, ruthless behavior. Tune to taste.
const AI_HANDICAP = { aimSpread: 1.7, fireProb: 0.7 };

export function randomPersonality(rng = Math.random) {
  // Bias toward a "lead trait" so personalities feel distinct, not all-average.
  const aggression = clamp01(0.25 + rng() * 0.75);
  return {
    aggression,
    defensiveness: clamp01(0.15 + rng() * 0.7),
    wanderlust: 0.35 + rng() * 0.65,
    reaction: 0.15 + rng() * 0.5,        // decision lag (seconds)
    jitter: 0.1 + rng() * 0.4,           // aim/steer noise
    // How readily this brain shoots a destructible obstacle out of its way instead of
    // driving around it. High = trigger-happy: blasts trees/walls on contact and burns
    // ammo (then has to peel off and reload); low = patient: tries to skirt first.
    triggerHappy: clamp01(0.15 + rng() * 0.85),
    // FOCUS (discipline / "mood"): how tunnel-visioned this brain is on its mission vs how
    // readily it breaks off to brawl. High = leaves a DISTANT enemy be and pushes the
    // objective, only fighting threats that come close; low = engages on sight (a scrapper).
    focus: clamp01(0.15 + rng() * 0.7),
    pref: TYPES[(rng() * TYPES.length) | 0],
  };
}

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function wrapPi(a) { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; }

// Fraction of ammo remaining (treat "unknown" as full, matching the old behaviour).
function ammoFrac(view) { return view.self.ammoFrac != null ? view.self.ammoFrac : 1; }
// Ammo hysteresis for the fight conditions: STAYING in a fight only needs a round in the gun,
// but ENTERING one needs a usable burst (~12% of the magazine). Without the asymmetry a unit
// topping up at base flipped resupply↔engage on every refill tick — off to fight with one
// round, fire it, dry, back to resupply, repeat (the deterministic ×38 strobe, seed 11 t=201).
// A USABLE BURST IS A NUMBER OF ROUNDS, NOT A FRACTION (task #47 — "It's dumb if you can't fire your
// last rocket"). The flat 0.12 was tuned on the Firebrat and is absurd at the extremes, because the
// magazines and the damage per round are nothing like each other:
//     chassis    dmg/shot   mag   12% is   damage withheld
//     lurcher       35       68     8.2       286
//     firebrat      14       90    10.8       151   <- where 0.12 was tuned
//     valkyrie      90       12      1.4       130
//     jotun        180       16      1.9       346   <- two shells, and ONE kills a Firebrat outright
// So a Jotun sitting on its last rocket would not enter a fight it could win with that rocket.
// Restated as the thing the rule is actually about: enough rounds to be worth starting a fight,
// ~150 damage (roughly one kill), floored at one round so a loaded gun is never unusable.
//   rounds = max(1, ceil(150 / dmgPerShot))  ->  lurcher 5/68, firebrat 11/90, valkyrie 2/12, jotun 1/16
// The Firebrat's value is unchanged at 0.122, so the strobe fix that produced 0.12 keeps its tuning.
const BURST_FRAC = { lurcher: 5 / 68, firebrat: 11 / 90, valkyrie: 2 / 12, jotun: 1 / 16 };
// ?oldburst restores the flat 0.12 so the gate has a control arm inside this same build.
let BURST_FIX = true;
export function setBurstFix(on) { BURST_FIX = !!on; return BURST_FIX; }
// The asymmetry stays: STAYING in a fight needs only a round in the gun, ENTERING one needs the
// burst. Without it a unit topping up at base flipped resupply<->engage on every refill tick (the
// deterministic x38 strobe, seed 11 t=201).
function ammoBurst(view, mem) {
  if (mem && mem.state === 'engage') return ammoFrac(view) > 0;
  return ammoFrac(view) > (BURST_FIX ? (BURST_FRAC[view.self && view.self.type] ?? 0.12) : 0.12);
}
// Pull-out HP threshold: brave brains hold longer (0.27–0.45 across aggression). The
// Jotun is the exception — it's far too slow to flee (a crawling retreat just gets it
// shot in the back), so it holds and keeps firing down to nearly dead.
function bailOf(p, cfg, type) {
  if (type === 'jotun') return 0.12;
  return cfg.bailBase - p.aggression * cfg.bailAggr;
}

// FIGHT-OR-FLIGHT WEIGHTS — the tunable coefficients of the fightScore sum below. Pulled
// out of the code into a named table so the auto-tuning gym can sweep/optimise them (and
// A/B one weight-set against another) WITHOUT editing this file. Defaults reproduce the
// original hand-tuned behaviour exactly. main.js hands each unit its team's set via
// view.fofW (falls back to these), so the two sides can run different weights in self-play.
export const FOF_DEFAULT = {
  hpPivot: 0.45, hpGain: 3,          // healthy → fight, low → flee
  ammoHi: 1, ammoLow: -0.5, ammoDry: -4,   // dry guns can't win
  shield: 1,                         // we have shield to spend
  aggrPivot: 0.45, aggr: 2,          // brave brains press
  defvPivot: 0.4, defv: 1.2,         // cautious brains hold back
  fragile: 1.2,                      // firebrat dies in a hit or two
  numbers: 1.5,                      // local headcount edge
  crossfire: 3,                      // pinned by a turret AND a rival
  enemyShield: 1,                    // they're harder to crack
  counterUs: 1.6,                    // we counter them → press
  counteredBy: 1.8,                  // they counter us → avoid
  weaker: 2.2,                       // rival weaker / already running → finish it (chase a fleer, don't let it reset)
  escape: 1.6,                       // can't outrun them → stand and trade
  facing: 1.0,                       // positional advantage (who has whose back)
  jotunFloor: 1,                     // a Jotun with ammo always fights (can't run)
  // THE HEROIC DASH. A runner on its way to the flag has to be braver than its hull deserves, or
  // it never gets there: a Firebrat is 90 hull and a light gun, so its honest answer to "would I
  // lose this fight" is always yes, and that is not the question its mission is asking. Without
  // this, being shot at on the approach reads as a lost exchange and the whole run is abandoned.
  // Scaled by how close the prize is (see runnerNerve) rather than switched on — far out it stays
  // sensible and avoids trouble; on the doorstep it goes through whatever is in the way.
  nerve: 4,
};

// FIGHT-OR-FLIGHT WEIGHT — should this unit pick a fight with the rival it sees, or keep
// moving and avoid it? A signed score: > 0 = fight, <= 0 = don't engage. Coefficients come
// from v.fofW (this team's weight set) or FOF_DEFAULT.
function fightScore(v, p) {
  const s = v.self, W = v.fofW || FOF_DEFAULT;
  let w = (s.hpFrac - W.hpPivot) * W.hpGain;
  w += s.ammoFrac > 0.5 ? W.ammoHi : (s.ammoFrac <= 0 ? W.ammoDry : W.ammoLow);
  if (s.shield > 0) w += W.shield;
  w += (p.aggression - W.aggrPivot) * W.aggr;
  w -= (p.defensiveness - W.defvPivot) * W.defv;
  if (s.type === 'firebrat') w -= W.fragile;
  // ...but a runner closing on the flag presses on anyway — the nearer the prize, the braver.
  if (v.runnerNerve) w += v.runnerNerve * W.nerve;
  // NUMBERS: our local headcount (this unit + nearby friendlies) vs nearby rivals. Even
  // odds is neutral; outnumbered tilts toward breaking off, having the numbers toward ganging
  // up. Only weighed when rivals are actually close (a far sighting isn't a brawl).
  if (v.enemiesNear > 0) w += (((v.alliesNear || 0) + 1) - v.enemiesNear) * W.numbers;
  // CROSSFIRE: pinned by a wall-turret AND a rival at once is a losing trade.
  if (v.threat && v.enemy) w -= W.crossfire;
  if (v.enemy) {
    if (v.enemy.shield > 0) w -= W.enemyShield;
    const et = v.enemy.type;
    if (et && COUNTER[et] === s.type) w += W.counterUs;
    if (et && COUNTER[s.type] === et) w -= W.counteredBy;
    // ENEMY RELATIVE HP: a rival weaker than us (or already running) is worth finishing even
    // when we're hurt — don't both limp away. (Subsumes the old finishHim.)
    if (v.enemy.retreating || (v.enemy.hpFrac != null && v.enemy.hpFrac <= s.hpFrac)) w += W.weaker;
    // ESCAPE SURVIVABILITY: can't outrun what's on us (not a flyer, slower than the rival) →
    // fleeing gets us shot in the back, so stand and trade. Generalises the Jotun's can't-run.
    if (!v.flyer && (SPEED[s.type] || 2) < (SPEED[et] || 2)) w += W.escape;
    // FACING / POSITIONAL ADVANTAGE: who has whose back? A rival turned away must swing around
    // before it can shoot back (free hits → press); if WE'RE caught facing away, they shoot
    // first (disengage). Symmetric, so whoever's exposed reads a flee bias.
    if (v.enemy.heading != null) {
      const dx = v.enemy.x - s.x, dz = v.enemy.z - s.z, d = Math.hypot(dx, dz) || 1;
      const nx = dx / d, nz = dz / d;
      const iFace = (-Math.sin(s.heading)) * nx + (-Math.cos(s.heading)) * nz;               // +1 = we're pointed at them
      const theyFace = (-Math.sin(v.enemy.heading)) * (-nx) + (-Math.cos(v.enemy.heading)) * (-nz);  // +1 = they're pointed at us
      if (iFace > 0.4 && theyFace < 0) w += W.facing;            // we have their back → press
      if (theyFace > 0.4 && iFace < 0) w -= W.facing;            // they have ours → disengage
    }
  }
  // The Jotun can't run, so as long as it has ammo it stands and fights regardless of odds.
  if (s.type === 'jotun' && s.ammoFrac > 0) return Math.max(w, W.jotunFloor);
  return w;
}

// --- CONDITIONS ---------------------------------------------------------
// Each returns a bool from (view, mem, p, cfg). Used both to update latches and to
// pick the active state in the transition table.
const CONDITIONS = {
  always:       () => true,
  // ON THE WAY HOME. The commander's Flee mission is running: the decision to break off has
  // already been taken and the route is fixed, so this just drives it.
  //
  // What used to be here: `runnerFlee` (a Firebrat within 60u of an enemy flips to evade),
  // `fleeLatched`/`fleeClear` (hysteresis so it committed instead of dancing on the 60u line),
  // and `hurtLatched` (hull below bail → limp home). All three were per-tick tests on what the
  // unit could SEE, and every one of them had to grow a latch to stop it flapping. The latch was
  // the tell: a decision that needs hysteresis to survive is a decision being re-taken far too
  // often. It is taken once now, by the mission layer, and it sticks until the unit is home.
  fleeing:      (v) => !!v.fleeing,
  // (finishHim removed: "hurt but the rival's weaker → turn and finish" is now a term in
  // fightScore, so it needs no special condition.)
  resupLatched: (v, m) => m._resup,                        // heading home to rearm/refuel
  shootGoal:    (v) => !!v.shootGoal && v.self.type !== 'firebrat',   // the goal is a fortification — but a Firebrat NEVER assaults one (weak gun; it's the flag runner, not a sieger)

  // Fight-or-flight: only duel a spotted rival when the weighted odds favour it (good
  // hp/ammo/matchup), otherwise keep moving instead of trading into a loss.
  // EXECUTOR, NOT DECIDER. `fight` is a scored mission, so the board has already answered "is this
  // a duel" — this rung never re-opens it. It asks only whether we are close enough for engage
  // footwork or should keep driving in; the Fight mission's goal IS the foe, so falling through
  // advances on it. The stalemate gambit still suppresses (that flyer is deliberately not trading).
  //
  // The ammo BURST threshold that used to live here is gone with the decision. It was hysteresis
  // standing in for a latch the ladder could not express — a unit topping up flipped
  // resupply<->engage on every refill tick — and a mission that holds itself does not need it. The
  // DRY check stays: engage footwork with an empty gun is the two-Jotun stare-down.
  engaging: (v, m, p) => {
    if (!v.fighting || !v.seesEnemy || v.rushBase) return false;
    if (!(ammoFrac(v) > 0)) return false;
    if (v.enemy && p.focus && v.self.type !== 'jotun') {
      const dx = v.enemy.x - v.self.x, dz = v.enemy.z - v.self.z;
      // Hold a wider ring once already fighting, so a kited enemy sitting exactly on the boundary
      // cannot flip engage<->advance every tick (the two pull opposite ways and the unit lurches).
      const brawlR = (v.engageRange || 36) * (1.25 - 0.75 * p.focus) * (m.state === 'engage' ? 1.4 : 1);
      if (dx * dx + dz * dz > brawlR * brawlR) return false;   // still closing — advance on the foe
    }
    return true;
  },
  // IMMEDIATE VEHICLE THREAT — an enemy vehicle is right on top of us and we CANNOT cleanly
  // get away (we're no flyer and no faster than it). Turning our back to keep sieging, to grab
  // a shield, or to limp home just gets us shot in the spine — so we stand and fight. This sits
  // at the TOP of the ladder (above the objective AND the hurt-retreat): spotting a rival vehicle
  // and answering it outranks any siege/advance goal. Escapable units (flyers / faster) fall
  // through to the normal weighted fight-or-flight. Gated by cfg.mustFight so it's A/B-toggleable.
  underAttack: (v, m, p, cfg) => {
    if (!cfg.mustFight || !v.seesEnemy || !v.enemy || !ammoBurst(v, m)) return false;
    const s = v.self, et = v.enemy.type;
    if (v.flyer || (SPEED[s.type] || 2) > (SPEED[et] || 2)) return false;   // can outrun it → let normal fof/flee decide
    // A FIGHT WE HAVE ALREADY JUDGED LOST. This rung sits above `engaging`, so it forces engage
    // WITHOUT consulting fightScore — which is right for "an inescapable rival is on us, answer
    // it" but wrong once the score is decisively against us. A mirror match (identical speed, so
    // the outrun test above can never save us) pinned two hurt Lurchers in engage at -1.8 and
    // +0.4 for minutes: neither could disengage, because this rung kept re-forcing engage, and
    // neither could commit, because the kite footwork below kept retreating. Let a decisively
    // negative score fall through to flee/retreat, which is what it is asking for.
    const fof = m._fof != null ? m._fof : fightScore(v, p);
    if (fof < (cfg.fofBail ?? -1.2)) return false;
    // Trigger on an ACTUAL immediate threat, not mere nearness: either the rival is shooting us
    // (underFire) or it's already inside our own weapon range (adjacent → we'd trade anyway). A
    // rival merely loitering at mid-range does NOT pull us off a siege — we fight it once it
    // actually engages/closes. This keeps sieges progressing while still never fleeing/ignoring a
    // real attacker we can't outrun.
    if (v.underFire) return true;
    const dx = v.enemy.x - s.x, dz = v.enemy.z - s.z;
    const reach = (v.engageRange || 36) * 1.05;
    return dx * dx + dz * dz <= reach * reach;
  },
  // A wall-turret is shelling us and we still have teeth → silence it first. A FIREBRAT never does
  // this: it's the flag runner, its pop-gun can't kill a turret, and stopping to trade just gets it
  // shot to pieces (the "worked an angle on their turret and spun in circles" bug). It keeps running.
  threatened: (v, m, p, cfg) => !!v.threat && ammoFrac(v) > 0 && v.self.hpFrac > bailOf(p, cfg, v.self.type) && v.self.type !== 'firebrat',
  // AMBUSHED: rounds are landing on us from something we cannot see. Unlike 'pursuing' this is
  // NOT a bravery check — every brain turns to face an attacker it never spotted, because the
  // alternative is dying to one it never looked at. A runner still runs (a Firebrat's job is the
  // flag, not the fight) and a hull too hurt to trade falls through to the retreat below.
  ambushed: (v, m, p, cfg) => !!cfg.shotAware && !!v.incomingFire && !v.seesEnemy
    && ammoFrac(v) > 0 && v.self.hpFrac > bailOf(p, cfg, v.self.type)
    && !(v.runnerMode && v.self.type === 'firebrat'),
  // Chase a recent sighting, but only brave brains bother — and never chase a ghost once
  // the enemy fleet is gone (the commander redirects to the base instead of wasting time).
  pursuing: (v, m, p) => {
    if (v.enemyGone) return false;
    // NEVER CHASE ON THE WAY TO THE DOOR. The carrier is faster than anything that could catch
    // it, so a pursuit started from behind is a foot race we lose while it walks the flag in —
    // and it was the biggest single source of wasted driving measured: an interceptor covered
    // 100.3u in ten seconds for 1.0u of net progress, seven times in one match, because "the last
    // place I saw them" moves every tick. Get to the door instead (interceptCampSpot).
    //
    // ONCE WE ARE STANDING IN IT, PURSUE. On the camp we are between the runner and the only
    // place it can score, so closing is geometry rather than a race — and refusing there is pure
    // waste: seed 669's camped Valkyrie saw the carrier on 16.4% of ticks across a whole match and
    // acted on none of them. Chase from behind, never; close from in front, always.
    // (A rival in weapons range is a separate case — `engaging` sits above this rung.)
    if (v.intercepting && !v.atCamp) return false;
    // DON'T RE-CHASE A CONTACT WE ALREADY KNOW WE CANNOT REACH. When the driver refuses a pursue
    // goal the issuer clears lastSeen — but if we can still SEE the enemy (across water, across a
    // wall), perception rewrites lastSeen on the very next tick, pursue re-triggers, the driver
    // refuses again, and the unit burns EVERY TICK writing the same contact off instead of firing
    // or moving. Two units doing this at each other across the same water mirror each other
    // perfectly: the "dancing lurchers" (seed 1851068760 — 20 write-offs per second, i.e. every
    // tick). Remembering the refusal is what breaks the loop; sight alone never could.
    if (m.noReach && (m.t - m.noReach.t) < 12 && m.lastSeen) {
      const ndx = m.lastSeen.x - m.noReach.x, ndz = m.lastSeen.z - m.noReach.z;
      if (ndx * ndx + ndz * ndz < 20 * 20) return false;   // same contact, still unreachable → get on with the mission
    }
    // A RUNNER never chases a sighting — pursue drove the fleeing firebrat straight back at
    // the enemy it had just escaped (flee to 100u → clear → pursue to 60u → flee …, the
    // panic flap). Runners resume the mission; the flee latch handles real chasers.
    if (v.runnerMode && v.self.type === 'firebrat') return false;
    const seenRecently = m.lastSeen && (m.t - m.lastSeen.t) < (3 + p.aggression * 5);
    return seenRecently && p.aggression > 0.6;
  },

  // --- latch triggers ---
  resupNeeded: (v, m, p, cfg) => {
    // THE MISSION LAYER ANSWERS THIS NOW when it is running (AIStrategies.js's Refuel/Rearm).
    // Those missions are scored from the same thresholds this rung used to test directly, and
    // they end when the tank is FULL rather than when it stops being empty — which is the fix
    // for the two-depot shuttle. Where the mission layer is present, this rung only executes.
    if (v.supplyRun !== undefined) return !!v.supplyRun;
    // low fuel / truly dry → rearm. EXCEPT a runner (flag-grabber/scout) doesn't need ammo to do
    // its job — don't let an empty magazine pull a Firebrat off a flag it's standing next to to go
    // rearm (Jacob: "ran out of ammo and drove right by the flag to get more"). Still rearms for fuel.
    if (v.self.fuelFrac < cfg.fuelLow || (ammoFrac(v) <= 0 && !v.runnerMode)) return true;
    // AMMO RESERVE (a CAUTIOUS commander's trait): while shelling STRUCTURES with no enemy in
    // sight, a careful commander won't burn the last of the magazine on walls — it heads home to
    // rearm early, banking a reserve so an interceptor can't catch it defenseless (that reserve is
    // still spent freely on enemy VEHICLES via the combat states). Only LOW-aggression personalities
    // do this — an aggressive commander spends it all; the reserve fades to 0 as aggression rises to
    // reserveMaxAggr. And nobody holds back when FINISHING the base (turrets down / enemy wiped), or
    // while an enemy is in sight (then we fight, not run).
    if (v.shootGoal && !v.seesEnemy && !v.finishing) {
      const aggr = p.aggression || 0, cap = cfg.reserveMaxAggr || 0.5;
      if (aggr < cap) {
        const reserve = (cfg.siegeAmmoReserve || 0) * (1 - aggr / cap);
        if (ammoFrac(v) <= reserve) return true;
      }
    }
    return false;
  },
  // At an OWN BASE (which also patches the hull) hold until ammo, fuel AND hp are ALL
  // topped off — don't roll back out half-healed. At a single-resource depot, clear once
  // the resource it fills is topped AND the OTHER one is merely "OK to carry on" (not full
  // — the depot can't fill it, so requiring full would camp it forever). This is the match
  // to the routing: a unit only diverts to the ammo depot when fuel is already ≥ fuelOK.
  // hp targets respect view.healCap — base repair may CAP below full (a trap bait holds a
  // killable 55%), and demanding more hp than the base will ever give deadlocks the unit
  // at its own FOB "topping up" forever.
  resupDone:   (v, m, p, cfg) => v.supplyRun !== undefined ? !v.supplyRun : v.supplyHeals
    ? (ammoFrac(v) >= cfg.topFull && v.self.fuelFrac >= cfg.topFull
       && v.self.hpFrac >= Math.min(cfg.topFull, (v.healCap ?? 1) - 0.01))
    : ((ammoFrac(v) >= cfg.ammoFull && v.self.fuelFrac >= cfg.fuelOK) ||
       (v.self.fuelFrac >= cfg.fuelFull && ammoFrac(v) >= cfg.ammoOK)),
};

// Resolve a transition's `target` key to a world point the behavior aims at.
function resolveTarget(key, view, mem) {
  switch (key) {
    case 'enemy': return view.enemy;
    case 'threat': return view.threat;
    case 'lastSeen': return mem.lastSeen;
    case 'home': return view.home || view.resupply || view.goal;   // where HP actually heals (own base)
    case 'resupplyOrGoal': return view.resupply || view.goal;
    default: return view.goal;
  }
}

// Per-duel FOOTWORK, the ai_behavior matchup table distilled into three intents:
//   strafe — lateral orbit intensity 0..1 to stay out of the enemy's kill arc (facing the
//            enemy + strafing = orbiting toward its flank/rear).
//   press  — 0..1 desire to CLOSE the distance / cut off a fleeing target (we have the edge).
//   kite   — 0..1 desire to fall back toward our own TOWER COVER when out-matched/pursued.
// Read straight off the doc's per-pair notes (Lurcher vs Jotun = flank to the rear; Lurcher
// vs Valkyrie = strafe but retreat to towers; Valkyrie vs Jotun = circle-strafe; etc.).
function duelTactic(selfType, enemyType) {
  if (selfType === 'valkyrie') {
    if (enemyType === 'jotun')    return { strafe: 1.0, press: 0.2, kite: 0 };    // circle-strafe; the Jotun can't track it
    if (enemyType === 'firebrat') return { strafe: 0.3, press: 0.7, kite: 0 };    // run it down, lead if it flees
    if (enemyType === 'valkyrie') return { strafe: 1.0, press: 0.2, kite: 0.5 };  // no fleeing — back toward our turrets
    return { strafe: 1.0, press: 0.1, kite: 0.4 };                                // vs Lurcher: strafe-and-go, then heal/return
  }
  if (selfType === 'lurcher') {
    if (enemyType === 'jotun')    return { strafe: 1.0, press: 0.6, kite: 0 };     // flank out of the 30° front arc, get behind
    if (enemyType === 'valkyrie') return { strafe: 0.85, press: 0.1, kite: 0.7 }; // jink, and fall back to tower support
    if (enemyType === 'firebrat') return { strafe: 0.5, press: 0.8, kite: 0 };    // close in; cut it off if it runs
    return { strafe: 0.2, press: 0.4, kite: 0.4 };                                // Lurcher mirror: trade close, near our towers
  }
  return { strafe: 0, press: 0, kite: 0 };           // Jotun plants (it WANTS them in its arc); Firebrat runs, doesn't duel
}

// --- BEHAVIORS ----------------------------------------------------------
// Each takes a ctx { view, mem, p, cfg, mode, target, dist, err } and returns the
// motor command. ctx.err is the (jittered) heading error toward the target; the
// behaviors own all the steering geometry.
const BEHAVIORS = {
  // Leaving the FOB: rotate IN PLACE until lined up on the gate, then drive straight
  // out. No dodge overlay here (the graph marks this state skipWhiskers).
  exit(ctx) {
    const { err, mem, cfg } = ctx;
    const turn = clamp(err * cfg.exitTurnGain, -1, 1);
    const fwd = Math.abs(err) < cfg.exitAlign ? 1 : 0;
    mem._wantMove = fwd > 0.3;
    return { fwd, turn, fire: false, state: ctx.mode };
  },

  // Hold at effective range and shoot rather than charging the kill zone. Shared by
  // 'engage' (mobile duel — aggressive brains press closer) and 'suppress' (keep a
  // wall-turret at arm's length and arc around its flank to find a clean line).
  combat(ctx) {
    const { view, mem, p, err, dist, mode, self, cfg } = ctx;
    const aimGate = 0.18 + p.aggression * 0.12;
    const want = view.engageRange || 36;
    const range = mode === 'suppress' ? want : want * (1 - p.aggression * 0.45);
    // Hard fire-distance cap: a round physically dies past its reach, so NEVER pull the
    // trigger beyond it — otherwise a short-reach unit (the Lurcher, ~42u) plinks a tower
    // that's 46u away, all shots land short, and it's stuck reloading forever. Clamps the
    // per-gate `*1.3` aim-tolerance so it can't authorise an out-of-range shot.
    const fireCap = view.shotReach || 999;
    // SIEGE DOCTRINE: silence a turret from a spot where only IT can hit back. If we
    // already have a clean line on the tower, PLANT and pour fire (don't wander off a
    // good shot). Otherwise drive to the radial standoff — outside the base through
    // the turret, away from the other towers' arcs — which also squares us onto it.
    if (mode === 'suppress' && view.threatStand) {
      // SIEGE DOCTRINE: silence the towers ONE AT A TIME from the radial standoff —
      // the spot OUTSIDE the base, through the target turret, where only THAT gun can
      // hit back. The old code planted and fired the instant its NOSE lined up on a
      // tower, so a Valkyrie sat out front hammering one gun while every OTHER tower
      // chewed it. The fix turns on two facts: (1) the turret has an ARC (Valkyrie
      // 90°, Lurcher 360°), so the weapon can keep BEARING on the tower while the hull
      // points elsewhere; (2) so we can steer the hull toward the standoff to SKIRT
      // around the base AND fire the whole way. err here is the hull→tower angle.
      const dsx = view.threatStand.x - self.x, dsz = view.threatStand.z - self.z;
      const dStand = Math.hypot(dsx, dsz);
      const atStand = dStand < 9;                          // arrived at the one-gun spot
      // Fire whenever the turret can bear on the tower (target inside the arc) and it's
      // in range with a clear line — independent of where the hull is pointed.
      const arc = Math.min(view.shotArc || 0.26, Math.PI * 0.55);
      // FIRE AT THE GUN'S REACH, NOT AT DUELLING RANGE. `want` is ENGAGE_RANGE — how close a unit
      // likes to be in a moving fight — and capping siege fire at want*1.3 meant the standoff
      // solver and the shooter disagreed about the same distance. The solver deliberately picks a
      // spot as far out as the gun allows, to stay clear of the other towers' arcs; the shooter
      // then refused to use it. Seed 655, the only stalemate in 240: a Valkyrie sat at its
      // assigned stand 76u from the enemy keep, clear line, 80u gun, two thirds of a magazine, and
      // did not fire for twenty minutes. 6,652 of 6,946 arrived siege decisions read "out of
      // range" at a range the gun covers. SHOT_REACH is the real limit — a round physically dies
      // past it — so that is the only limit worth having here.
      const aimed = Math.abs(err) < arc && dist < fireCap;
      const canBear = view.threatLOS && aimed;
      // SIEGE FLATTEN: a ground unit with NO clean line on the tower (a wall/HQ blocks
      // it) doesn't circle forever hunting an angle — it PLANTS, squares onto the nearest
      // WALL in the way, and blasts a path through, so it levels the far side too.
      // Gate on the WALL's range, not the (possibly far) turret's — the obstruction is
      // right in front even when the tower behind it is way out of reach. (Flyers skip
      // this: a Valkyrie clears walls and shoots over them.)
      let demolish = false, demoErr = 0, demoAimed = false;
      if (!view.flyer && !view.threatLOS && view.demolishTarget) {
        const ddx = view.demolishTarget.x - self.x, ddz = view.demolishTarget.z - self.z;
        if (Math.hypot(ddx, ddz) < fireCap) {   // same rule for the wall we are breaking through
          demolish = true;
          demoErr = wrapPi(Math.atan2(-ddx, -ddz) - self.heading);   // hull-relative bearing to the wall
          demoAimed = Math.abs(demoErr) < arc;
        }
      }
      const fire = (canBear || (demolish && demoAimed)) ? mem.rng() < (0.7 + p.aggression * 0.3) * AI_HANDICAP.fireProb : false;
      // A ground unit can be physically barred from the standoff (water / coast / a
      // wall it must blow through first). If it's wedged on the way, stop trying to
      // skirt — square up and pour fire into whatever it can see (this fallback is
      // what the earlier "march to the standoff cold" attempt lacked). Trips on the
      // WEDGE timer too, not just still-time: a unit GRINDING along the base wall is
      // technically moving (so _stillT never accrues) and used to loop suppress↔unstick
      // jolts forever instead of planting and blasting the wall in front of it.
      // …but ONLY when there's actually something to shoot from here (a bearing line on the
      // tower, or a wall in range to flatten). Planting with NOTHING shootable just parks the
      // sieger mid-route — richwatch caught jotuns doing exactly that for entire matches
      // (a brief wedge → plant → timers reset → skirt → wedge again: a two-spot shuttle).
      const barred = !view.flyer && (mem._stillT > 0.5 || mem._wedgeT > 0.5) && (canBear || demolish);
      // RE-EVALUATE ON THE WAY IN: don't march to the fixed close-in hold once a shot's
      // already live — the instant ANYTHING (tower or demolish wall) is in range with a
      // clear line, plant right here and pour fire. Only keeps closing when truly nothing
      // is shootable yet, so most approaches never actually reach the tight hold at all.
      if (atStand || barred || demolish || canBear) {
        const turn = clamp((demolish ? demoErr : err) * 2.2, -1, 1);   // square onto the wall (demolish) or tower
        const fwd = dist > want ? 0.4 : 0;                 // ease into range, then plant
        mem._wantMove = fwd > 0.3;
        return { fwd, turn, fire, state: mode };
      }
      // Skirt: drive the hull toward the standoff (arcing around the base) while the
      // turret keeps firing on the tower whenever it bears. The point is to REACH the
      // flank, not dance out front. Movement via locomote — the old raw "fwd 1 + full
      // turn" was the binary-throttle orbit bug living on in suppress (tournament: 34s
      // orbits at siege standoffs); the eased square-up cures it here like everywhere.
      const lo = locomote({ x: self.x, z: self.z, heading: self.heading, omni: view.omni },
        { goto: view.threatStand, arrive: 2 });
      mem._wantMove = true;
      return { fwd: lo.fwd, turn: lo.turn, strafe: lo.strafe || 0, fire, state: mode };
    }
    const los = mode !== 'suppress' || view.threatLOS;   // duel target is always visible
    let steer = err;
    if (mode === 'suppress' && view.flankSide) {
      const k = clamp((dist - range) / range, 0, 1);     // 1 far out → 0 at range
      steer = view.threatLOS ? err + view.flankSide * 0.85 * k
                             : err + view.flankSide * 1.5;
    }
    let turn = clamp(steer * 2.0, -1, 1);
    let fwd;
    if (!los) fwd = 0.6;                          // no clean shot → circle in to find one
    else if (dist < range * 0.6) fwd = -0.5;      // inside the danger band → back out
    else if (dist < range * 0.95) fwd = 0;        // hold and pour fire
    else fwd = 1;                                  // close to range
    let fire = false;
    const gate = mode === 'suppress' ? aimGate + 0.05 : aimGate;
    if (los && Math.abs(err) < gate && dist < Math.min(range * 1.3, fireCap)) fire = mem.rng() < (0.65 + p.aggression * 0.35) * AI_HANDICAP.fireProb;
    // DUEL FOOTWORK (the ai_behavior matchup table) — engage only; suppress keeps its
    // planted siege standoff above. Picks kite / press / strafe from the pairing.
    let strafe = 0;
    if (mode === 'engage' && view.enemy && los) {
      const tac = duelTactic(self.type, view.enemy.type);
      const arc = Math.min(view.shotArc || 0.26, Math.PI);   // how far off-hull the turret can still bear
      // TRAP LURE (hunter's bait): kite the chaser ACROSS OUR OWN MINEFIELD — steer the hull
      // for the lure point (the commander keeps it on the far side of the mines, skirting the
      // cluster), fire whenever the gun bears. Replaces normal duel footwork entirely: press
      // closes the gap we're trying to stretch, and strafe side-steps blind — mines don't show
      // up in the whisker/nudge checks a strafe makes, which is how a bait blew its own trap.
      if (view.lure) {
        const lx = view.lure.x - self.x, lz = view.lure.z - self.z;
        const ld = Math.hypot(lx, lz);
        turn = clamp(wrapPi(Math.atan2(-lx, -lz) - self.heading) * 2.0, -1, 1);
        fwd = ld > 4 ? 1 : 0;   // settle at the shield spot — the mines sit between us and them
        fire = (Math.abs(err) < arc && dist < Math.min(range * 1.4, fireCap)) ? mem.rng() < 0.6 * AI_HANDICAP.fireProb : false;
        mem._wantMove = fwd > 0;
        // KITE order: bait for the lure point with eyes (and gun) ON the chaser the whole way.
        return { fwd, turn, fire, strafe: 0, state: mode,
          mnv: { type: 'KITE', tx: view.enemy.x, tz: view.enemy.z, toward: { x: view.lure.x, z: view.lure.z }, arrive: 4 } };
      }
      // SIEGE BREAK-OFF: dueling a vehicle while a tower is ACTIVELY HITTING us — that
      // crossfire is a losing trade, so slip the tower's guns while the nose tracks the
      // rival: locomote's goto/face split does both at once, and for a Jotun whose
      // attacker is astern, "away is behind me" makes fwd go negative on its own (the
      // reverse-arc). Trigger = TAKING TOWER FIRE (view.towerFire, last ~2.5s), per the
      // doctrine "the maneuver depends on being fired on" — the first version triggered
      // on mere tower PROXIMITY, which interrupted every siege of a defended base into
      // an endless field duel (exact-gate: 8 seeds flipped stalemate, towers untouched
      // for 1000s while kills tripled). Time-boxed so the unit fights once clear.
      if (view.towerFire) {
        if (mem._breakoffT == null) mem._breakoffT = 3.5;
        if (mem._breakoffT > 0) {
          mem._breakoffT -= view.dt;
          const tdx = self.x - view.towerFire.x, tdz = self.z - view.towerFire.z;
          const td = Math.hypot(tdx, tdz) || 1;
          const away = { x: self.x + (tdx / td) * 24, z: self.z + (tdz / td) * 24 };
          const bfire = (Math.abs(err) < arc && dist < Math.min(range * 1.4, fireCap))
            ? mem.rng() < 0.6 * AI_HANDICAP.fireProb : false;
          mem._wantMove = true;
          // KITE order: slip the firing tower's guns, nose on the rival (a Jotun's "away is
          // behind me" reverse-arc falls out of the goto/face split in the driver).
          return { fwd: 0, turn: 0, strafe: 0, fire: bfire, state: mode,
            mnv: { type: 'KITE', tx: view.enemy.x, tz: view.enemy.z, toward: away, arrive: 2 } };
        }
      } else mem._breakoffT = null;   // guns quiet — re-arm for the next crossfire
      // KITE URGE — GRADUAL, not a cliff. `hpFrac < 0.55` was a hard step, so a unit hovering at
      // the pivot flipped kite on and off, and the distance half (dist < range*0.6) had no
      // hysteresis at all, so the pair pumped as the gap breathed. Both now scale with how true
      // they are, and the engage state widens the distance trigger so it latches instead of
      // chattering (measured: siege<->engage flipping ~10x/second in a mirror match).
      const kitePivot = cfg.kitePivot ?? 0.55;
      const hurtUrge = Math.max(0, (kitePivot - self.hpFrac) / Math.max(0.05, kitePivot));
      const closeR = range * 0.6 * (mem.state === 'engage' ? 1.15 : 1);
      const crowdUrge = Math.max(0, (closeR - dist) / Math.max(1, closeR)) * 0.8;
      // DON'T RETREAT FROM A FIGHT WE ARE WINNING. This branch never consulted fightScore, so it
      // overrode a positive score: a Lurcher at +0.4 against a weaker rival still backed away,
      // and since the doctrine is symmetric BOTH did it — the mid-field "dance". fightScore
      // already weighs the enemy's relative hp (the `weaker` term), so trust it here.
      const fofNow = mem._fof;
      const kiteUrge = (fofNow != null && fofNow > 0) ? 0 : tac.kite * Math.max(hurtUrge, crowdUrge);
      if (kiteUrge > (cfg.kiteMin ?? 0.18) && view.support) {
        // KITE order: retreat INTO our tower cover with the nose (and the gun) held on the
        // chaser — the driver reverses a tank at the doctrine cap, backpedals an omni hull.
        // (The old inline version drove nose-first at the support point: it out-ran the
        // chaser but gave it our BACK the whole way.)
        // FALL BACK A SHORT WAY, NOT ACROSS THE MAP. `view.support` is the home base, which can
        // be 200u+ off — kiting to it literally ordered two duelling units to march to opposite
        // corners of the island while facing each other. Cap the fallback so this is a
        // reposition into cover, not an evacuation.
        let sx = view.support.x - self.x, sz = view.support.z - self.z;
        const sLen = Math.hypot(sx, sz) || 1, cap = Math.min(sLen, cfg.kiteFallback ?? 34);
        const back = { x: self.x + (sx / sLen) * cap, z: self.z + (sz / sLen) * cap };
        sx = back.x - self.x; sz = back.z - self.z;
        turn = clamp(wrapPi(Math.atan2(-sx, -sz) - self.heading) * 2.0, -1, 1);
        fwd = 1;
        fire = (Math.abs(err) < arc && dist < Math.min(range * 1.4, fireCap)) ? mem.rng() < 0.6 * AI_HANDICAP.fireProb : false;
        mem._wantMove = true;
        return { fwd, turn, fire, strafe: 0, state: mode,
          mnv: { type: 'KITE', tx: view.enemy.x, tz: view.enemy.z, toward: back, arrive: 6 } };
      }
      // BLOCKED LINE (shot-feedback): our last rounds kept detonating on the terrain/cover
      // between us and the target instead of on the enemy. Grinding the same shot is the
      // "two units fire at the hill between them forever" stalemate — so commit to a hard
      // sidestep (held ~1.5s so it actually clears the hump) while still test-firing the new
      // lane; the instant a shot connects the feedback resets and normal footwork resumes.
      // FUTILITY ESCALATION: a 1.5s random-direction hop clears a rock but not a RIDGE — two
      // jotuns random-walked the same crest for 300s, burning full magazines with zero damage
      // (richwatch seed 25). After a few failed hops, COMMIT: hold one direction for a long
      // leg (~5s) so the firing line genuinely moves off the blocking feature.
      if (view.shotBlocked) {
        mem._blockSeenT = mem.t;
        if (mem._unblockT == null || (mem.t - mem._unblockT) > (mem._unblockLong ? 5 : 1.5)) {
          mem._unblockN = (mem._unblockN || 0) + 1;
          mem._unblockLong = mem._unblockN >= 3;
          if (!mem._unblockLong || mem._unblockDir == null) mem._unblockDir = mem.rng() < 0.5 ? -1 : 1;
          mem._unblockT = mem.t;
        }
        mem._wantMove = true;
        // Clear the lane with the tools THIS chassis has: sliders sidestep; a tank (Jotun —
        // treads, no strafe pedal) REVERSE-ARCS onto a new firing line instead. Its old
        // "escape" was an illegal tread-slide; once the chassis gate zeroed that, blocked
        // Jotuns just stood there grinding (engage-stuck +118% in the tournament).
        if (!view.canStrafe) {
          return { fwd: mem._unblockLong ? -0.6 : -0.5, turn: mem._unblockDir, fire, strafe: 0, state: mode };
        }
        return { fwd: mem._unblockLong ? 0.4 : 0.35, turn, fire, strafe: mem._unblockDir * 0.95, state: mode };
      }
      // Lane cleared (a shot landed, or the fight moved) for a few seconds → forget the futility.
      if (mem._unblockN && mem.t - (mem._blockSeenT ?? -99) > 4) { mem._unblockN = 0; mem._unblockLong = false; }
      // AMBUSH A JOTUN (ai_behavior Hunter): its 30° front arc is a guaranteed hit, so
      // never trade there — if we're in front of a MOVING Jotun, let it roll by: hold fire,
      // ease out of the kill zone, and orbit hard toward its blind rear. Once we're off its
      // nose the normal press/strafe below takes over and we hit it from behind.
      let holdOff = false, mnv = null;
      if (view.enemy.type === 'jotun' && Math.hypot(view.enemy.vx || 0, view.enemy.vz || 0) > 1.5) {
        const rel = wrapPi(Math.atan2(self.x - view.enemy.x, self.z - view.enemy.z)
                         - Math.atan2(view.enemy.vx, view.enemy.vz));   // 0 = on its nose, ±π = behind it
        if (Math.abs(rel) < 1.0) {
          holdOff = true;
          mem._strafeDir = rel >= 0 ? 1 : -1;            // orbit the short way to the rear
          strafe = mem._strafeDir * Math.max(tac.strafe, 0.9);
          fire = false;
          if (dist < range * 0.9) fwd = -0.3;            // back out of the front arc
          // ORBIT order: circle at range toward its blind rear, nose held on it — the driver
          // keeps the radius honest (the old inline version drifted into the front arc).
          if (view.canStrafe) mnv = { type: 'ORBIT', cx: view.enemy.x, cz: view.enemy.z,
            radius: range * 0.95, dir: mem._strafeDir, face: { x: view.enemy.x, z: view.enemy.z } };
        }
      }
      // PRESS the advantage — close in, and CUT OFF a fleeing target by steering AHEAD of its
      // travel. Trigger on the matchup press (normal duelling) OR — regardless of matchup —
      // whenever the rival is RUNNING or clearly WEAKER: the healthier unit runs the loser down
      // instead of letting it stroll home, heal to full, and come back (the reset that stalemates
      // AI-vs-AI). This OVERRIDES the Jotun's press=0, so a winning heavy actually chases and rakes
      // the fleer's exposed back the whole way — and when it stops at base to heal, it takes a beating.
      // JOUST — the Valkyrie's signature vs GROUND targets: no hovering duel (a hovering
      // aligner is a sitting duck) — a full-speed pass with the target abeam, missiles
      // through the broadside window, extend, and REASSESS. The driver plans each pass and
      // alternates sides (serpentine); the brain re-deciding engage every tick IS the
      // between-passes fight-or-flight check — the moment the score flips, no more passes.
      if (!holdOff && AI_JOUST && self.type === 'valkyrie' && view.enemy.type !== 'valkyrie' && los) {
        const jfire = (Math.abs(err) < Math.PI * 0.65 && dist < Math.min(range * 1.3, fireCap))
          ? mem.rng() < 0.6 * AI_HANDICAP.fireProb : false;   // wide broadside gate — the rack homes
        mem._wantMove = true;
        return { fwd: 1, turn, fire: jfire, strafe: 0, state: mode,
          mnv: { type: 'JOUST', tx: view.enemy.x, tz: view.enemy.z, side: 1 } };
      }
      const winning = view.enemy.retreating || (view.enemy.hpFrac != null && view.enemy.hpFrac < self.hpFrac - 0.15);
      const pressing = !holdOff && (winning || tac.press >= 0.7);
      if (pressing) {
        if (dist > range * 0.5) fwd = 1;
        if (view.enemy.retreating) {
          const tx = view.enemy.x + (view.enemy.vx || 0) * 0.9, tz = view.enemy.z + (view.enemy.vz || 0) * 0.9;
          turn = clamp(wrapPi(Math.atan2(-(tx - self.x), -(tz - self.z)) - self.heading) * 2.0, -1, 1);
        }
      }
      // STRAFE — orbit out of the kill arc; direction flips on a jittered timer (≈ the
      // "switch directions to dodge the rocket" reflex). Skipped while holding off a Jotun
      // (that sets its own rear-ward orbit just above).
      if (!holdOff && tac.strafe > 0 && dist < range * 1.6) {
        // Juke far more often against a Valkyrie — frequent direction changes throw its
        // homing rockets off (the doc's "switch directions when they fire" reflex, without
        // needing to know the exact moment it shoots).
        const flip = view.enemy.type === 'valkyrie' ? (1.0 + mem.rng() * 1.2) : (2.2 + mem.rng() * 2.2);
        if (mem._strafeT == null || (mem.t - mem._strafeT) > flip) {
          mem._strafeDir = mem.rng() < 0.5 ? -1 : 1; mem._strafeT = mem.t;
        }
        strafe = mem._strafeDir * tac.strafe;
        // ORBIT order — the strafe duel with the radius kept honest by the driver: circle
        // the rival at the range band (pressing pulls the ring tight to run a fleer down),
        // dir on the jittered flip, nose on the enemy — or on the LEAD point of a runner,
        // so pressing cuts the corner instead of tail-chasing. LOS required: with no shot
        // to keep, the DIRECT circle-in-to-find-one behavior stands.
        if (view.canStrafe && los) {
          const f = (pressing && view.enemy.retreating)
            ? { x: view.enemy.x + (view.enemy.vx || 0) * 0.9, z: view.enemy.z + (view.enemy.vz || 0) * 0.9 }
            : { x: view.enemy.x, z: view.enemy.z };
          mnv = { type: 'ORBIT', cx: view.enemy.x, cz: view.enemy.z,
            radius: pressing ? range * 0.55 : range * 0.85, dir: mem._strafeDir, face: f };
        }
      }
      if (mnv) {
        mem._wantMove = true;
        return { fwd, turn, fire, strafe, state: mode, mnv };
      }
    }
    mem._wantMove = Math.abs(fwd) > 0.3 || Math.abs(strafe) > 0.3;
    // ALIGN — the plain nose-on-the-target footwork, as an ORDER. This is what every fight falls
    // back on when there is no orbit / kite / joust to run: a chassis that cannot strafe, or
    // anyone still hunting for a clean shot. It was the last motion in the game steering itself.
    // The pedals above are kept as the fallback, so if the driver declines the order nothing
    // changes; what the driver adds is a blocked clock, which this footwork never had.
    // `!strafe` alone was wrong here: a Jotun DOES get a strafe value (the duel table sets one
    // before anything checks the chassis) — it is zeroed downstream at the drive boundary because
    // treads cannot sidestep. So the hull that actually moves on fwd/turn alone, and therefore the
    // one that most needs this order, would have been the one excluded. Ask the chassis, not the number.
    // ENGAGE ONLY. This return is shared with `suppress`, where the target is the THREAT and `err`
    // is measured to it — so aiming an ALIGN at view.enemy there would point the hull at the wrong
    // thing. Worse, a maneuver order outranks the arrival HOLD, so it would take the siege
    // footwork off its solved firing position. Duel footwork is duel footwork; sieges have their own.
    if (AI_ALIGN && mode === 'engage' && view.enemy && !view.lure && (!strafe || !view.canStrafe)) {
      return { fwd, turn, fire, strafe, state: mode,
        mnv: { type: 'ALIGN', tx: view.enemy.x, tz: view.enemy.z, range, los, faceOff: wrapPi(steer - err) } };
    }
    return { fwd, turn, fire, strafe, state: mode };
  },

  // Pound a fortification from the type's reach — heavies shell it from outside the
  // turrets' best range instead of nosing up to the wall. Movement = locomote order
  // (goto the target, FACE it — it's also the aim); the fire gate stays here.
  assault(ctx) {
    const { view, mem, p, err, dist, mode, self, target } = ctx;
    const aimGate = 0.18 + p.aggression * 0.12;
    const want = view.engageRange || 36;
    const standoff = want * 0.7;
    const lo = locomote({ x: self.x, z: self.z, heading: self.heading, omni: view.omni },
      { goto: target ? { x: target.x, z: target.z } : null, face: target, arrive: standoff });
    let fire = false;
    if (Math.abs(err) < aimGate + 0.06 && dist < standoff * 1.4) fire = mem.rng() < 0.75 * AI_HANDICAP.fireProb;
    mem._wantMove = Math.abs(lo.fwd) > 0.3 || Math.abs(lo.strafe || 0) > 0.3;
    return { fwd: lo.fwd, turn: lo.turn, strafe: lo.strafe || 0, fire, state: mode };
  },

  // advance / pursue / resupply / retreat — just get to the target. Movement comes from the
  // ONE locomotion primitive (Locomotion.js): eased square-up for tank chassis, immediate
  // any-direction translation for an omni chassis. This behavior only decides WHERE and
  // whether we've ARRIVED.
  seek(ctx) {
    const { view, mem, self, target, dist, mode } = ctx;
    // Heading HOME to heal/rearm must actually REACH the base (its heal radius is
    // ~12u), so use a tight arrival here — NOT the card's objective standoff, which
    // can be large (e.g. ScoutSnatch parks 30u out to scout) and would otherwise
    // leave a wounded unit frozen just outside its own supply, never healing.
    const homeward = mode === 'resupply';   // ('retreat' is gone — the Flee mission owns going home)
    const arrive = homeward ? 5 : (view.arriveDist || 8);
    // Heading home: the instant we're actually IN the base's heal/rearm zone, STOP — don't chase
    // the exact centre. A wide-turning unit (Lurcher) can't land on a 5u pinpoint and just orbits
    // it, which parks it circling on top of its own FOB elevator. atHome (the real supply radius)
    // lets it settle anywhere in the zone and top up.
    const lo = locomote({ x: self.x, z: self.z, heading: self.heading, omni: view.omni },
      { goto: target ? { x: target.x, z: target.z } : null, arrive });
    const arrived = (homeward && view.atHome) || lo.arrived;
    const turn = lo.turn, fwd = arrived ? 0 : lo.fwd, strafe = arrived ? 0 : (lo.strafe || 0);
    // PARKED IS NOT BLIND. Two places a unit holds a position instead of driving, and it has to
    // keep watching from both:
    //   FIGHT FROM THE PAD — topping up at base used to sit facing the base, so a chaser (a
    //     Lurcher on a healing Valkyrie) out-damaged the heal and the unit died waiting. Healing
    //     doesn't disarm the gun: pivot to the pursuer and return fire while the base tops us up.
    //   WATCH THE LANE — an interceptor standing in the door held whatever heading it arrived on,
    //     which is the heading it drove OUT on: pointing at the enemy base, away from the lane the
    //     runner must come up. Measured on seed 669: 84 degrees off, constant, for a whole match.
    //     That costs it most of its eyes — a Valkyrie spots a Firebrat at 71u dead ahead but only
    //     35u out to the side — and it saw the carrier on just 16.4% of ticks.
    // Both stay parked: leaving the spot to duel loses the heal, or opens the door. Gated on
    // ARRIVED (not fwd===0) so a unit merely pivoting en route doesn't stop.
    const camped = view.atCamp && mode === 'advance';   // holding the door, not off pursuing from it
    if (arrived && (homeward || camped)) {
      const foe = view.enemy;                      // visible + LOS → can actually shoot it
      // A rival in sight wins; otherwise face the lane we are here to watch.
      const face = foe || (camped ? view.watch : null);
      if (face) {
        const derr = wrapPi(Math.atan2(-(face.x - self.x), -(face.z - self.z)) - self.heading);
        let fire = false;
        if (foe) {
          const range = view.engageRange || 36, fireCap = view.shotReach || 999;
          const fd = Math.hypot(foe.x - self.x, foe.z - self.z);
          if (Math.abs(derr) < 0.22 && fd < Math.min(range * 1.3, fireCap)) fire = mem.rng() < 0.7 * AI_HANDICAP.fireProb;
        }
        mem._wantMove = false;
        return { fwd: 0, turn: clamp(derr * 2.2, -1, 1), fire, state: ctx.mode };
      }
    }
    mem._wantMove = Math.abs(fwd) > 0.3 || Math.abs(strafe) > 0.3;
    return { fwd, turn, strafe, fire: false, state: ctx.mode };
  },

  // Obstacle avoidance OVERLAY (not a standalone state): takes the behavior's intended
  // command and, when the path ahead is blocked, steers around the obstacle while
  // KEEPING the behavior's fire decision. The old version re-decided which way to go
  // EVERY frame and reset the choice the instant the nose cleared — so on anything but
  // a flat wall (a water inlet, a peninsula, a tree clump) it rocked back and forth
  // across the edge making no progress, with its guns switched off: the "dance".
  //
  // The fix is COMMITMENT. Pick a way around ONCE and hold it (so the nose clearing
  // mid-turn doesn't snap us back into the obstacle), keep holding it for `dodgeClear`
  // seconds AFTER the path opens (so we actually get past, not re-block), and only
  // forget the choice once we've been clear a while. If we circle one way for
  // `dodgeFlip` seconds and stay blocked, flip — that breaks a concave trap. And we
  // never gag the weapons: a blocked unit can still fire at whatever's in front of it.
  // True wedges (driving but not moving) are still caught by the unstick reflex.
  avoid(ctx, cmd) {
    const { view, mem, cfg, p } = ctx;
    // SHOOT-THROUGH: a destructible (wall or tree) is dead ahead on the way to the goal.
    // Rather than always circling it, a brain can square the nose onto it and blast a
    // path clear — a Firebrat that can't crush a palm just shoots it down; a heavy
    // levels a wall. How eagerly is the triggerHappy knob: a trigger-happy brain fires
    // almost on contact (and spends ammo, so it has to reload later), a patient one
    // tries to skirt for a beat first and only shoots if it's still wedged. Combat
    // states keep their own targeting (the siege-flatten in `combat`), so skip those.
    const hasAmmo = view.self.ammoFrac == null || view.self.ammoFrac > 0;
    // Who may shoot a blocker out of the way:
    //  • A FIREBRAT only breaks a TREE that's got it stuck (it can't crush trees like a heavy, so
    //    fire is its only way out) — NEVER a structure (its pop-gun can't dent a wall, and trading
    //    with a turret gets it killed). Fixes both "stuck in the trees forever" AND "shot the gate".
    //  • Other ground units break either, unless they're on a flee-contact runner mission (a runner
    //    noses the wall and ignores the gap beside it — let A* route it AROUND instead).
    // breakAim disables A* routing (navOverride bails), so only commit when genuinely blocked ahead.
    const isFirebrat = view.self.type === 'firebrat';
    const canBreak = hasAmmo && view.breakTarget && view.blockedAhead && cmd.state !== 'engage' && cmd.state !== 'suppress'
      && (isFirebrat ? view.breakTarget.tree : !view.runnerMode);
    if (canBreak) {
      mem._breakT = (mem._breakT || 0) + view.dt;
      // A Firebrat stuck on a tree shoots NOW — patience up to 2.4s outlasted the 1.8s still-timer,
      // so unstick fired first and it never got the shot off. Others keep the personality dial.
      const patience = isFirebrat ? 0.15
        : (1 - (p.triggerHappy ?? 0.5)) * cfg.breakPatience;   // eager → ~0s, patient → full
      if (mem._breakT > patience) {
        const bt = view.breakTarget, s = view.self;
        const berr = wrapPi(Math.atan2(-(bt.x - s.x), -(bt.z - s.z)) - s.heading);
        mem._wantMove = true;
        return { fwd: 0.3, turn: clamp(berr * 2.4, -1, 1), fire: true, state: cmd.state, breakAim: bt };
      }
    } else {
      mem._breakT = 0;
    }
    if (view.blockedAhead) {
      mem._dodgeClearT = 0;
      if (!mem._dodgeTurn) {                       // choose a way around ONCE, then commit
        mem._dodgeTurn = view.blockedLeft && !view.blockedRight ? 1
                       : view.blockedRight && !view.blockedLeft ? -1
                       : (mem.rng() < 0.5 ? -1 : 1);
        mem._dodgeEpisodeT = 0;
      }
      mem._dodgeEpisodeT += view.dt;
      if (mem._dodgeEpisodeT > cfg.dodgeFlip) { mem._dodgeTurn = -mem._dodgeTurn; mem._dodgeEpisodeT = 0; }
    } else if (mem._dodgeTurn) {
      mem._dodgeClearT += view.dt;                 // path clear — hold the turn a moment, then forget it
      if (mem._dodgeClearT > cfg.dodgeClear) { mem._dodgeTurn = 0; mem._dodgeEpisodeT = 0; }
    }
    if (!mem._dodgeTurn) return cmd;               // no obstacle to round → behavior steers itself
    const boxed = view.blockedLeft && view.blockedRight;   // walled on both feelers → back out, still turning
    mem._wantMove = true;
    return { fwd: boxed ? -0.6 : 0.35, turn: mem._dodgeTurn, fire: cmd.fire, state: cmd.state };
  },
};

// --- DEFAULT_BRAIN — the graph the game ships with ----------------------
// Pure data (no functions): config knobs, latched interrupts, and an ordered
// transition table. This reproduces the hand-written brain exactly and is what the
// flowchart editor loads/exports. States name a BEHAVIOR + whether they skip the
// dodge overlay (skipWhiskers); transitions are evaluated top-to-bottom, first match wins.
export const DEFAULT_BRAIN = {
  version: 1,
  type: 'unit-brain',
  config: {
    stillEps: 0.05,      // movement under this (units/tick) counts as "not moving"
    engageGlow: 0.9,     // seconds a lost duel target stays "visible" (anti engage↔pursue flap)
    threatGlow: 2.5,     // seconds a lost TURRET target is held — turrets don't move, so a blink isn't a disappearance (anti suppress↔assault flap)
    fofStick: 0.25,      // fight-or-flight commitment bias while already engaging (anti boundary-strobe)
    // --- KITE (falling back to tower cover mid-duel) ---
    fofBail: -1.2,       // fight score at/below which `underAttack` stops FORCING engage on an inescapable rival — it has judged this lost, let it flee (0 = old behaviour: always pinned)
    kitePivot: 0.55,     // hull fraction the kite urge scales from (was a hard `hpFrac < 0.55` step)
    kiteMin: 0.18,       // kite urge needed to actually fall back — below this, hold and fight
    kiteFallback: 34,    // MAX world units to fall back per kite order. view.support is the home base, which can be 200u+ away; uncapped it marched duelling units off the map
    stillLimit: 1.8,     // seconds wedged before the unstick jolt fires
    wedgeLimit: 1.6,     // seconds PRESSED on an obstacle with no gain on the goal before the jolt (a unit sliding along a wall/turret is "moving" but going nowhere)
    wedgeGain: 0.4,      // goal distance must shrink by at least this to count as progress
    unstickDur: 0.7,     // jolt duration (seconds)
    unstickRev: 0.7,     // reverse throttle during the jolt
    dodgeClear: 0.6,     // seconds the path must stay clear before forgetting which way we were going round
    dodgeFlip: 3.0,      // seconds stuck circling one way before flipping to the other (escape a trap)
    breakPatience: 2.4,  // max seconds a PATIENT brain skirts a destructible before it gives up and shoots it (triggerHappy scales this down toward 0)
    exitAlign: 0.30,     // |heading error| under which the exit state drives straight
    exitTurnGain: 2.2,   // steer gain while lining up on the gate
    bailBase: 0.30,      // hp pull-out threshold = bailBase - aggression*bailAggr. 0.45 sent a
                         // 90-hull Firebrat home after one or two tower hits: 115/120 -> 118/120,
                         // nav alarms 71 -> 33, swap loops 201 -> 152. Still one number for four
                         // chassis, which is the real wrongness — see the per-chassis note in bailOf.
    bailAggr: 0.18,
    hurtClear: 0.8,      // hp fraction that clears the "hurt" retreat latch
    fuelLow: 0.18,       // fuel fraction that trips the resupply latch
    fuelFull: 0.5,       // fuel fraction that marks "fuel topped" (the resource a fuel depot fills)
    ammoFull: 0.6,       // ammo fraction that marks "ammo topped" (the resource an ammo depot fills)
    fuelOK: 0.25,        // fuel that's "enough to carry on" — the bar the OTHER resource must clear at a depot
    ammoOK: 0.5,         // ammo that's "enough to carry on"
    topFull: 0.99,       // at an OWN BASE (heals too) don't leave until ammo, fuel AND hp are ALL maxed
    mustFight: 1,        // 1 = an inescapable enemy vehicle on top of us pre-empts the objective (see `underAttack`); 0 = old behaviour (A/B knob)
    shotAware: 1,        // 1 = being hit by an unseen vehicle turns us to face it (see `ambushed`); 0 = old behaviour, only sight/hearing notice an attacker (A/B knob)
    siegeAmmoReserve: 0.2, // a CAUTIOUS commander sieging with no enemy in sight heads home to rearm at this ammo frac instead of 0 — banks a reserve for self-defense on the trip (0 = old spend-it-all; A/B knob). Fades to 0 as aggression rises to reserveMaxAggr; ignored when finishing the base off.
    reserveMaxAggr: 0.5,   // aggression at/above which a commander banks NO ammo reserve (spends it all) — the reserve is a low-aggression trait
  },
  // Latched interrupts: once tripped they hold (hysteresis) until their clear
  // condition, and force the matching state via the transition table below.
  // GOING HOME IS NOT THE BRAIN'S DECISION ANY MORE. `_hurt` (limp home to heal) and `_flee` (the
  // Firebrat's escape reflex) both used to live here, and together with fofBail that made three
  // separate mechanisms answering one question — "should I go home?" — which is the defect shape
  // behind every flap this week. The Flee MISSION owns it now: one decision, taken once, that
  // replaces the route and is then committed to. See AIStrategies' Flee.
  latches: [
    { flag: '_resup', trip: 'resupNeeded', clear: 'resupDone' },
  ],
  states: {
    resupply: { behavior: 'seek' },
    engage:   { behavior: 'combat' },
    suppress: { behavior: 'combat' },
    pursue:   { behavior: 'seek' },
    assault:  { behavior: 'assault' },
    advance:  { behavior: 'seek' },
    unstick:  { behavior: 'unstick' },   // entered only via the anti-wedge reflex
  },
  // Priority ladder: clear the gate first, then self-preservation, then fighting,
  // then the objective. `target` says what the chosen behavior aims at.
  transitions: [
    // TAKE THE FLAG: on the final approach to a grabbable flag, the runner COMMITS — beeline it and
    // ignore the turrets. A runner that stops to trade with the last tower next to the flag just
    // dies without the grab (the "worked an angle on the turret and shot the wall" bug). It's a
    // short, distance-gated dash (the flag's right there), so it's a commit, not a suicide charge.
    // ON THE WAY HOME, GO HOME. While the Flee mission is running the unit drives its route and
    // does not stop to fight — the decision to disengage has already been taken, and a unit that
    // re-opens it every time something comes into view is the flapping this replaced. It sits
    // above underAttack deliberately: being shot at is WHY we are leaving, not a reason to stop.
    { when: 'fleeing',      mode: 'advance',  target: 'goal' },
    // IMMEDIATE VEHICLE THREAT leads everything below the gate/runner: an inescapable rival on
    // top of us gets answered NOW — never keep sieging or flee-to-heal with our back to it.
    { when: 'underAttack',  mode: 'engage',   target: 'enemy' },
    // FIGHT-OR-FLIGHT LEADS when a rival is in range: fightScore already weighs hp, ammo,
    // matchup, numbers AND (now) escape-survivability, so let IT decide fight-vs-flee before
    // the blunt hurt-retreat. `fightScore>0` → engage (even if hurt, when the odds justify
    // it); `<=0` → fall through to the retreat below (that's the flight). This replaces the
    // old ordering where a flat "I'm hurt" latch pre-empted the weighted decision (and the
    // finishHim patch that existed only to poke a hole in that override).
    { when: 'engaging',     mode: 'engage',   target: 'enemy' },
    { when: 'resupLatched', mode: 'resupply', target: 'resupplyOrGoal' },
    { when: 'threatened',   mode: 'suppress', target: 'threat' },
    // SHOT BY SOMETHING WE CAN'T SEE — turn and find it. Sits below every state that already
    // has a target (engage/suppress/retreat all outrank it) and above the mission goal, so it
    // only fires when the alternative is driving on oblivious.
    { when: 'ambushed',     mode: 'pursue',   target: 'lastSeen' },
    { when: 'pursuing',     mode: 'pursue',   target: 'lastSeen' },
    // SECURE THE SHIELD: committed to a close generator → grab the shield before picking a fight.
    // The commit is a real latch now (SHIELD_WANT trip / SHIELD_FULL clear, in _view) rather than
    // a value rebuilt every tick. DEMOTING this rung below engage/hurt/resupply was tried on
    // 2026-08-05 and measured badly on its own (attack thrash 9.66 -> 31.07, scuttles 4 -> 20,
    // two stalemates): a long-lived latch sitting under rules that flicker is worse than a
    // short-lived one sitting on top. The demotion is right once fight/shield-up are missions
    // that cannot both be running — see devblog/2026-08-05-one-mission-layer.md.
    { when: 'shootGoal',    mode: 'assault',  target: 'goal' },
    { when: 'always',       mode: 'advance',  target: 'goal' },
  ],
};

// --- FLIGHT RECORDER (debug, off by default) -----------------------------
// Captures each unit's DECISION whenever it CHANGES: the causal `view` fields, WHICH
// transition fired (rule.when = the reason), and the resulting action. This is the
// ground-truth "why did it do that" trace that state-sampling could only infer. Zero
// cost when off (one boolean check per tick). The sim harness / RR toggles it.
let REC_ON = false, REC_MODE = 'changes';   // 'changes' = log on decision change; 'all' = every tick
const REC = []; const REC_CAP = 40000;
export function recStart(mode = 'changes') { REC_ON = true; REC_MODE = mode; REC.length = 0; }
export function recStop() { REC_ON = false; }
export function recDump() { return REC.slice(); }
export function recActive() { return REC_ON; }

// --- runtime-tunable brain config (the auto-tuning gym) ----------------------
// Mutates DEFAULT_BRAIN.config in place so a sweep can try different knob values
// (bailBase, hurtClear, unstickDur, …) across matches WITHOUT a rebuild — every unit on
// the default brain reads the new value next tick. getBrainConfig() with no key returns
// a copy of the whole config so the harness can snapshot/restore it.
export function setBrainConfig(k, v) { if (k in DEFAULT_BRAIN.config) DEFAULT_BRAIN.config[k] = v; return DEFAULT_BRAIN.config[k]; }
let AI_JOUST = true;   // the Valkyrie's jousting attack runs (off → legacy hover-strafe duel; A/B knob)
let AI_ALIGN = true;   // plain duel footwork issued as an ALIGN order instead of steering itself (A/B knob)
let NO_PURSUE = false;   // pursue comes off the reflex ladder; Fight and Attack own the chase (A/B knob)
export function setAlign(on) { AI_ALIGN = !!on; return AI_ALIGN; }
export function setJoust(on) { AI_JOUST = !!on; return AI_JOUST; }
export function setNoPursue(on) { NO_PURSUE = !!on; return NO_PURSUE; }
export function getBrainConfig(k) { return k ? DEFAULT_BRAIN.config[k] : { ...DEFAULT_BRAIN.config }; }
function maybeRecord(view, mem, reason, state, out) {
  if (!REC_ON) return;
  const key = state + '|' + reason;
  if (REC_MODE !== 'all' && key === mem._recKey) return;   // only when the decision changes
  mem._recKey = key;
  const s = view.self, e = view.enemy;
  REC.push({
    t: +mem.t.toFixed(2), ty: s.type, reason, state,
    hp: +s.hpFrac.toFixed(2), am: +s.ammoFrac.toFixed(2), fu: +s.fuelFrac.toFixed(2),
    sees: !!view.seesEnemy, enemyD: e ? Math.round(Math.hypot(e.x - s.x, e.z - s.z)) : null,
    threat: !!view.threat, threatLOS: !!view.threatLOS, hqT: !!view.hqThreat, demolish: !!view.demolishTarget, breakT: !!view.breakTarget,
    near: (view.enemiesNear | 0) + 'v' + (view.alliesNear | 0), shotBlk: !!view.shotBlocked, enemyGone: !!view.enemyGone,
    fof: mem._fof != null ? +mem._fof.toFixed(2) : null,
    out: { f: +(out.fwd || 0).toFixed(2), t: +(out.turn || 0).toFixed(2), fire: !!out.fire, s: +(out.strafe || 0).toFixed(2) },
  });
  if (REC.length > REC_CAP) REC.shift();
}

// --- the interpreter ----------------------------------------------------
// Walks `graph` against `view`, mutating `mem` (the per-unit latched memory =
// the Brain instance). Reproduces the original think() order of operations exactly,
// including the order of rng() draws, so behavior is identical to the hand-written
// version when run with DEFAULT_BRAIN.
export function runBrain(graph, view, mem) {
  const cfg = graph.config, p = mem.p, self = view.self;
  mem.t += view.dt;

  // --- anti-wedge reflex ---
  // Track motion; if the unit keeps TRYING to drive but isn't moving (jammed on a
  // gate post / wall corner / lift lip) it racks up "still" time and jolts free with
  // a reverse + hard pivot — the backstop that breaks any wedge a behavior can't.
  const moved = mem._lx != null ? Math.hypot(self.x - mem._lx, self.z - mem._lz) : 1;
  mem._lx = self.x; mem._lz = self.z;
  if (mem._unstick > 0) {
    mem._unstick -= view.dt;
    const r = { fwd: -cfg.unstickRev, turn: mem._unstickTurn, fire: false, state: 'unstick' };
    maybeRecord(view, mem, 'unstick', 'unstick', r);
    return r;
  }
  // A unit deliberately squared up shooting a wall/tree clear (a breach) is intentionally
  // pressed AND still — gate BOTH stall timers on it, or the reverse-pivot yanks the unit off
  // the tree it was about to shoot (the Firebrat's endless pirouette in the woods). Mirrors the
  // canBreak eligibility gates: no ammo / runner-on-a-wall / firebrat-on-a-structure is NOT a
  // breach, so those still unstick normally.
  const breaching = view.breakTarget && view.blockedAhead
    && (view.self.ammoFrac == null || view.self.ammoFrac > 0)
    && mem.state !== 'engage' && mem.state !== 'suppress'
    && (view.self.type === 'firebrat' ? !!view.breakTarget.tree : !view.runnerMode);
  if (mem._wantMove && moved < cfg.stillEps && !breaching) mem._stillT += view.dt; else mem._stillT = 0;
  // Progress wedge: a unit can SLIDE along a wall/turret at full speed (so the motion
  // check above never trips) yet make no headway toward its goal — it just grinds the
  // obstacle. If it's pressed against something AND its distance to the goal stops
  // shrinking, count that as a wedge too and fire the same reverse-pivot to spin free.
  const pressed = view.blockedAhead || view.blockedLeft || view.blockedRight;
  const gd = view.goal ? Math.hypot(view.goal.x - self.x, view.goal.z - self.z) : 0;
  if (mem._wantMove && pressed && !breaching) {
    if (mem._bestGoalD == null || gd < mem._bestGoalD - cfg.wedgeGain) { mem._bestGoalD = gd; mem._wedgeT = 0; }
    else mem._wedgeT += view.dt;
  } else { mem._bestGoalD = gd; mem._wedgeT = 0; }
  // ANTI-WEDGE REFLEX. This used to stand down while the forced gate-exit was driving, because
  // that exit outranked everything and a jolt would have fought it. The exit is gone — a unit now
  // leaves through the gate on its A* route like any other leg — so the reflex applies everywhere,
  // including at its own doorway, which is where it was most often needed and least often allowed.
  if (mem._stillT > cfg.stillLimit || mem._wedgeT > cfg.wedgeLimit) {
    mem._unstick = cfg.unstickDur; mem._unstickTurn = mem.rng() < 0.5 ? -1 : 1;
    mem._stillT = 0; mem._wedgeT = 0; mem._bestGoalD = null;
    // Escalation counter: jolts within ~8s of each other are the SAME stuck episode. The
    // navigator watches this — a second jolt means the reflex isn't freeing the unit, so it
    // blacklists the snag and A*-replans around it instead of letting the dance loop forever.
    if (mem.t - (mem._unstickAt ?? -99) > 8) mem._unstickN = 0;
    mem._unstickN = (mem._unstickN || 0) + 1; mem._unstickAt = mem.t;
  }

  // Remember the last confirmed sighting (fuels the 'pursuing' condition).
  if (view.seesEnemy && view.enemy) mem.lastSeen = { x: view.enemy.x, z: view.enemy.z, t: mem.t };
  // BEING SHOT IS ALSO A CONTACT. Sight is a forward cone, so an attacker sitting behind us
  // never reaches the line above — and every combat trigger below keys off seesEnemy, so a unit
  // hit in the back fell through the entire ladder and drove on losing hull to something it had
  // never looked at. A hit tells us where the shooter fired from; record it like a sighting so
  // there is somewhere to turn. It is NOT a sighting: seesEnemy stays false, so this can only
  // make the unit LOOK — it still has to see the attacker before it can shoot back.
  else if (view.incomingFire) mem.lastSeen = { x: view.incomingFire.x, z: view.incomingFire.z, t: mem.t };

  // ENGAGE AFTERGLOW (anti-flap hysteresis): in a real duel both hulls weave through cover, so
  // line-of-sight blinks off for a tick or two constantly — and every blink used to bounce the
  // state engage↔pursue/advance/suppress (richwatch: ×50 flips in 36s). If we were FIGHTING and
  // the rival vanished less than engageGlow ago, keep treating it as visible at its last seen
  // spot: the ladder stays in engage, steering stays on target, and the state only really
  // changes once the target has been gone a beat. Entry into engage stays instant.
  if (view.seesEnemy && view.enemy) { mem._lastEnemyView = { ...view.enemy }; mem._lastSeenT = mem.t; }
  else if ((mem.state === 'engage' || mem.state === 'suppress') && mem._lastEnemyView
           && mem.t - (mem._lastSeenT ?? -99) < cfg.engageGlow) {
    view.seesEnemy = true; view.enemy = mem._lastEnemyView; view.enemyGhost = true;
  }
  // THREAT AFTERGLOW — the same trick for wall-turret targets, held LONGER because turrets
  // don't move: the threat is only reported with a clear line to it, so a sieger strafing
  // past wall edges had it blinking every tick, flipping suppress↔assault once a second for
  // minutes (richwatch: ×98 in 101s). Hold the last turret as the target through blinks;
  // threatLOS stays false for the ghost, so FIRING still requires a genuine line.
  if (view.threat) {
    mem._lastThreatView = { threat: { ...view.threat }, stand: view.threatStand ? { ...view.threatStand } : null, hq: !!view.hqThreat };
    mem._lastThreatT = mem.t;
  } else if ((mem.state === 'suppress' || mem.state === 'assault') && mem._lastThreatView
             && mem.t - (mem._lastThreatT ?? -99) < cfg.threatGlow) {
    view.threat = mem._lastThreatView.threat;
    view.threatStand = mem._lastThreatView.stand;
    view.hqThreat = mem._lastThreatView.hq;
    view.threatLOS = false;
  }

  // Update latched interrupts (hysteresis).
  for (const L of graph.latches) {
    if (!mem[L.flag] && CONDITIONS[L.trip](view, mem, p, cfg)) mem[L.flag] = true;
    else if (mem[L.flag] && CONDITIONS[L.clear](view, mem, p, cfg)) mem[L.flag] = false;
  }

  // Fight-or-flight score for the rival in sight (null if none) — computed ONCE here so the
  // `engaging` condition, the log overlay and the flight recorder all read the same number.
  mem._fof = (view.seesEnemy && view.enemy) ? fightScore(view, p) : null;
  // …and HOW FAR that rival is, stamped here for the same reason the score is: one number, one
  // place, read by everyone. The Fight mission needs it because sight is not a firing solution —
  // AI_VISION is 66u while a Firebrat's gun reaches 40 and a Lurcher's 42, so "there is an enemy"
  // and "there is an enemy we can shoot" are two different facts for the two commonest chassis.
  mem._fofD = (view.seesEnemy && view.enemy && view.self)
    ? Math.hypot(view.enemy.x - view.self.x, view.enemy.z - view.self.z) : null;
  // COMMITMENT BIAS (anti-flap): a score hovering AT the fight/flee boundary used to strobe the
  // state every tick or two (richwatch: resupply↔engage ×38, pursue↔engage ×26 in 6s) — each
  // tiny hp/distance change flipped the sign. Once fighting, it takes a clearly BAD score to
  // disengage, not a marginal one; the decision to break off stays with the latches (hurt/flee)
  // and a genuinely lost matchup, where it belongs.
  if (mem._fof != null && mem.state === 'engage') mem._fof += cfg.fofStick;

  // "I AM DONE FIGHTING" — decided HERE, acted on by the mission layer (AIStrategies' Flee).
  // It lives here because this is where the personality and its thresholds are; computing the
  // same test again on the commander is exactly how two rulebooks for one judgement start, and
  // that has been the defect behind every flap this week.
  //
  // Both halves are thresholds that were already tuned and are reused unchanged: the hull is
  // below this chassis+persona's bail fraction, or the weighted fight-or-flight call has gone
  // clearly against us. A JOTUN NEVER BAILS — it is far too slow to run and would only die with
  // its back turned, so it stands and trades (bailOf already floors it at 0.12; this makes the
  // rule explicit rather than emergent).
  //
  // ONE-WAY. Once the mission layer picks this up it commits, and nothing here can call it back:
  // a flag that flips with perception is a plan that evaporates and returns, which is what turned
  // a 15-second run home into 64 seconds of spinning on the spot.
  // "Hurt" alone is NOT enough, and getting that wrong cost 43.7% of all unit-ticks to fleeing on
  // the first run of this. The old transition table put `engaging` ABOVE `hurtLatched` precisely
  // so a damaged unit with good odds finished its fight instead of turning its back; expressing
  // the bail as bare hp threw that ordering away. Hurt AND no fight worth having — same rule the
  // ladder used to encode by position, now stated once.
  //
  // AND THE FIGHT HAS TO BE REAL. Reading the fight-or-flight score off a mere SIGHTING sent
  // every Firebrat home the moment it laid eyes on anything: a Firebrat's score against any
  // other chassis is deeply negative by design — 90 hull and a light gun — so "would I lose this
  // fight" is a question it always answers yes to, and it is not the question its mission asks.
  // Seed 25 turned into 17 flee episodes out of 19 being runners abandoning the flag. Losing an
  // exchange we are ACTUALLY IN is the event worth leaving over; seeing someone is not.
  mem._bail = self.type !== 'jotun'
    && ((self.hpFrac < bailOf(p, cfg, self.type) && !(mem._fof > 0))
        || (view.underFire && mem._fof != null && mem._fof < (cfg.fofBail ?? -1.2)));

  // Pick the active state: first transition whose condition holds.
  // PURSUE IS NOT A REFLEX (Jacob, 2026-08-11). Both rungs that produce it — `pursuing` (chase a
  // sighting) and `ambushed` (turn toward whatever just hit us) — are skipped when NO_PURSUE is on,
  // which removes the mode from this ladder entirely. Nothing is lost:
  //   · the CHASE already exists as a mission, twice over and built better. Fight refreshes its
  //     objective while we have eyes on so a chase keeps closing, holds a foe VEHICLE so the duel
  //     ends on a kill, and freezes at the last known spot when eyes are lost. Attack's objective
  //     IS the enemy's last-known position, with a staging-point fallback and a real arrive
  //     distance. This rung was a third implementation with no way to end.
  //   · the INFORMATION ambushed was acting on is recorded by perception regardless — incoming fire
  //     writes mem.lastSeen, and the commander's `sees` trigger counts a contact "seen, heard, or
  //     shot at". So being ambushed still wakes MissionScore; it just no longer steers the hull.
  // Why it had to go rather than be guarded: a ladder rung re-decides every tick and never consults
  // the commander, so `pursue` could sit on top of a mission that had already correctly decided
  // something else — a swap, in the case that found this. It is the only aggressive rung with no
  // ammo check, so a dry hull fell past every other rung and landed here permanently.
  let rule = graph.transitions[graph.transitions.length - 1];
  for (const t of graph.transitions) {
    if (NO_PURSUE && t.mode === 'pursue') continue;
    if (CONDITIONS[t.when](view, mem, p, cfg)) { rule = t; break; }
  }
  const mode = rule.mode;
  mem.state = mode;
  mem._when = rule.when;   // the exact transition that won (for the ai-lab decision-path view)
  const target = resolveTarget(rule.target, view, mem);

  // Common steering bag: heading error toward the target (with personality jitter).
  const dx = target.x - self.x, dz = target.z - self.z;
  const dist = Math.hypot(dx, dz) || 0.0001;
  // Vehicle front is local -Z → forward = (-sin h, -cos h), so aim = atan2(-dx,-dz).
  const aim = Math.atan2(-dx, -dz);
  const err = wrapPi(aim - self.heading) + (mem.rng() - 0.5) * p.jitter * 0.6 * AI_HANDICAP.aimSpread;
  const ctx = { view, mem, p, cfg, mode, target, dist, err, self };

  const stateDef = graph.states[mode];
  const out = BEHAVIORS[stateDef.behavior](ctx);
  // Overlay obstacle avoidance on the behavior's steering (commit to one way around,
  // keep firing) for any state that doesn't opt out — exit drives itself through the
  // gate, so it skips this.
  const result = stateDef.skipWhiskers ? out : BEHAVIORS.avoid(ctx, out);
  maybeRecord(view, mem, rule.when, mode, result);
  return result;
}

export class Brain {
  constructor(personality, rng = Math.random) {
    this.p = personality;
    this.rng = rng;
    this.graph = DEFAULT_BRAIN;   // swap for a custom decision graph (e.g. from the editor)
    this.state = 'patrol';
    this.t = 0;
    this.decideT = 0;
    this.lastSeen = null;     // { x, z, t } — last confirmed enemy sighting
    this.noReach = null;      // { x, z, t } — a contact the driver said it cannot route to (see `pursuing`)
    this.wp = null;           // current patrol waypoint
    this.wpUntil = 0;
    this._dodgeTurn = 0;      // committed way around an obstacle (±1, 0 = none) — held, not re-picked each frame
    this._dodgeClearT = 0;    // seconds the path ahead has been clear (forget the dodge after dodgeClear)
    this._dodgeEpisodeT = 0;  // seconds circling one way while still blocked (flip after dodgeFlip to escape a trap)
    this._resup = false;      // latched: heading home to rearm/refuel (don't dry-chase)
    this._lx = null; this._lz = null;   // last position (anti-wedge movement check)
    this._stillT = 0;         // time spent trying to move but not moving
    this._wedgeT = 0;         // time PRESSED on an obstacle with no gain on the goal (sliding-along-a-wall wedge)
    this._bestGoalD = null;   // closest the unit has gotten to the goal during the current press
    this._unstick = 0;        // remaining time of a reverse-and-pivot jolt
    this._unstickTurn = 1;
    this._wantMove = false;   // did last tick intend to drive forward?
  }

  // Tactical layer: drive toward the commander's strategic GOAL, but break off to
  // fight a rival that's actually seen (fog of war). The commander (main.js) decides
  // the goal + whether to shoot it; this executes it with personality + reflexes.
  //
  // view: {
  //   dt, self:{x,z,heading,hpFrac,fuelFrac,ammoFrac},
  //   seesEnemy:bool, enemy:{x,z}|null, threat:{x,z}|null, threatLOS:bool, flankSide:±1,
  //   goal:{x,z}, resupply:{x,z}|null, shootGoal:bool,
  //   arriveDist:number, engageRange:number,
  //   blockedAhead:bool, blockedLeft:bool, blockedRight:bool
  // }
  // returns { fwd:-1..1, turn:-1..1, fire:bool, state }
  think(view) {
    return runBrain(this.graph || DEFAULT_BRAIN, view, this);
  }
}
