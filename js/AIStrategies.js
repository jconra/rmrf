// AIStrategies.js — the commander's brain at the MISSION level (the ai_behavior doc).
//
// Two layers, cleanly split:
//   MISSIONS  — reusable "high-level commands" (Scout, Attack, Siege, Capture, Defend).
//               Each only says HOW to execute: which vehicle, where to go, whether to
//               shoot, how close to get, and a log phrase. Missions hold no opinion about
//               WHEN to switch — that keeps them shareable across every personality.
//   PERSONAS  — the four commander identities (Warrior, Rogue, Hunter, Turtle). Each owns
//               an opening mission, a vehicle-role table, and a choose() that — re-checked
//               every tick — decides which mission to be running RIGHT NOW. A mission that
//               has nothing left to do (e.g. Hunter with no enemy to hunt) is simply not
//               chosen again, so a commander can never get stuck shelling an empty field.
//
// The commander (main.js) consumes the same interface it always did: a `strategy` object
// with .step (current mission key), .t, tick(), wantVehicle(), objective(), shoot(),
// arriveDist(), objectiveLabel(). onRunnerLost() replaces the old softenStep poke.

// Rough rock-paper-scissors for counter-picking what's been seen (tunable):
// firebrat ← lurcher (firepower) ← valkyrie (mobility) ← jotun (range) ← firebrat.
export const COUNTER = { firebrat: 'lurcher', lurcher: 'valkyrie', valkyrie: 'jotun', jotun: 'firebrat' };

const cap = s => s ? s[0].toUpperCase() + s.slice(1) : s;

// ---- MISSIONS — reusable high-level commands ---------------------------------------
// A mission reads the running doctrine (this.doc) for its persona's vehicle-role table,
// so the SAME Siege means "Jotun" for a Warrior and "Valkyrie" for a Rogue.
class Mission {
  constructor() { this.t = 0; }
  enter(cmd, doc) { this.doc = doc; this.t = 0; }
  tick(cmd, dt) { this.t += dt; }
  wantVehicle(cmd) { return this.doc.role(this.key); }
  objective(cmd) { return cmd.enemyBasePos(); }
  shoot(cmd) { return true; }
  arriveDist(cmd) { return 12; }
  label(cmd) { return 'the objective'; }
  // A short, characterful announcement the commander barks when it SWITCHES to this mission
  // (logged in place of the old terse "scout → attack"). Fun but still informative — it names
  // the intent. Deterministic: cycled by a per-commander counter, no RNG. Override per mission.
  cry(cmd) { return `switching to ${this.key}`; }
  // Once carrying the flag, everyone just runs it home.
  _flagOrHome(cmd) {
    const f = cmd.flag();
    if (f && f.carrier === cmd.unit) return cmd.homePos();
    if (f) return { x: f.group.position.x, z: f.group.position.z };
    return cmd.enemyBasePos();
  }
}

// SCOUT — sweep unexplored map to find the enemy + supply points; don't pick fights.
class Scout extends Mission {
  get key() { return 'scout'; }
  objective(cmd) { return cmd.exploreTarget() || cmd.enemyFobPos(); }
  shoot(cmd) { return false; }
  arriveDist(cmd) { return 30; }
  label(cmd) { return 'sweeping for recon'; }
  cry(cmd) { return pickCry(cmd, [
    'Where are they hiding? Fan out and find them.',
    'No sign of the enemy yet — go take a look around.',
    'Eyes on the field. Let’s see what they’re up to.',
  ]); }
}

// ATTACK — recall the enemy's last-known position and hunt them down; with no recent
// sighting, fall back to where they emerge (the elevator).
class Attack extends Mission {
  get key() { return 'attack'; }
  objective(cmd) { return cmd.lastEnemyPos() || cmd.enemyFobPos(); }
  arriveDist(cmd) { return 12; }
  // A NOUN phrase, not a verb — the state line prepends the brain's own verb
  // ("advancing → …", "sieging …"), so a verb here reads as nonsense ("sieging hunting …").
  label(cmd) { return cmd.lastEnemyPos() ? 'their last-known position' : 'the enemy staging point'; }
  cry(cmd) { return cmd.lastEnemyPos()
    ? pickCry(cmd, [
        'We’ve got eyes on ’em — move in and take them out!',
        'Enemy located! All units, run them down!',
        'Got a fix on their position — go hunt them down!',
      ])
    : pickCry(cmd, [
        'They’re out there somewhere — go flush them out!',
        'No visual, but they’re close. Track them down and engage!',
      ]); }
}

// SIEGE — level the enemy base, turret-first, until the flag is exposed.
class Siege extends Mission {
  get key() { return 'siege'; }
  // CLOSER: once the enemy is ELIMINATED (out for good — no units, roster empty) there's
  // no return fire to fear, so mobility/stealth stop mattering and raw demolition wins.
  // Field a JOTUN — its railgun levels turrets + the HQ far faster than a Valkyrie's
  // long-range chip fire (which the audit showed barely dents a structure, so a decided
  // match just stalled with a lone flyer idling at the wall). _pickAvailableType falls
  // back (jotun → lurcher → valkyrie) if we're out of railguns.
  wantVehicle(cmd) { return cmd.enemyEliminated() ? 'jotun' : this.doc.role(this.key); }
  // ROGUE SIEGE (from behind): a Rogue's Valkyrie doesn't slug it out at the front — it curls AROUND
  // to the REAR of the enemy base and rockets the flag HQ from behind. Flight is the whole point: a
  // ground unit sent to stop it gets hung up on the base walls, while the flyer just lifts over them
  // and repositions — so it survives to keep chipping the HQ down instead of trading into the
  // defender out front. Loop to the rear staging point first (latched, like the capture sneak), then
  // settle into the shell; the hqThreat standoff then holds on that rear line.
  objective(cmd) {
    if (ROGUE_REAR_SIEGE && cmd.archetype === 'rogue' && cmd.unit && cmd.unit.type === 'valkyrie' && !cmd.flagExposed()) {
      const u = cmd.unit.holder.position, rear = cmd.enemyRearApproach(), base = cmd.enemyBasePos(), home = cmd.homePos();
      if (!cmd.unit._siegeRearReached) {
        // Latch once we've actually gotten AROUND to the far side. A flyer holds ~26u off, so the
        // old "within 12u of the rear point" test never tripped — use "past the base centre on the
        // home→base axis" (i.e. behind it) OR loosely near the rear point.
        let dx = base.x - home.x, dz = base.z - home.z; const d = Math.hypot(dx, dz) || 1;
        const behind = ((u.x - base.x) * dx + (u.z - base.z) * dz) / d;   // +ve = on the rear side of the base
        if (behind > 6 || Math.hypot(u.x - rear.x, u.z - rear.z) < 30) cmd.unit._siegeRearReached = true;
        else return rear;                                                 // still curling around — head for the rear
      }
    }
    return cmd.enemyBasePos();                                            // behind now → shell the HQ from the rear
  }
  arriveDist(cmd) {
    if (cmd.unit && cmd.unit.type === 'valkyrie') {
      // Rogue rear-siege: once behind the base, close to ~10u of the HQ (point-blank for a flyer at
      // 7.5u cruise → rockets dive in at a natural ~37° instead of a hard 90° kink) so EVERY rocket
      // lands on the keep — not spread across wall pieces or wasted from a 26u standoff. The flyer
      // crosses over the walls to get there (ignoreWalls). Normal valkyrie siege still holds at 26u.
      if (ROGUE_REAR_SIEGE && cmd.archetype === 'rogue' && cmd.unit._siegeRearReached && !cmd.flagExposed()) return 10;
      return 26;
    }
    return 12;
  }
  label(cmd) {
    if (cmd.enemyEliminated()) return 'levelling the undefended base';
    if (ROGUE_REAR_SIEGE && cmd.archetype === 'rogue' && cmd.unit && cmd.unit.type === 'valkyrie' && !(cmd.unit && cmd.unit._siegeRearReached) && !cmd.flagExposed()) return 'flanking to shell the HQ from behind';
    return 'the enemy base';
  }
  cry(cmd) { return cmd.enemyEliminated()
    ? pickCry(cmd, [
        'Field’s clear — nothing left to stop us. Raze their base!',
        'They’re wiped out! Tear that base down to the dirt!',
      ])
    : pickCry(cmd, [
        'They’re hiding behind their walls — let’s flatten their base!',
        'Time to bring those walls down. Pour it on!',
        'Punch through their defenses and level ’em!',
      ]); }
}

// CAPTURE — run a Firebrat for the flag; do NOT engage (the runner flees contact). A Rogue
// sneaks in the BACK: it curls around to a staging point behind the base while it's still
// in front, then dives for the flag (the firebrat shoots a hole in any wall in its way).
class Capture extends Mission {
  get key() { return 'capture'; }
  wantVehicle(cmd) { return 'firebrat'; }
  objective(cmd) {
    const f = cmd.flag();
    if (f && f.carrier === cmd.unit) return cmd.homePos();            // carrying → run it home
    const flagPt = f ? { x: f.group.position.x, z: f.group.position.z } : cmd.enemyBasePos();
    // Stealth run: a Rogue always sneaks in the back; ANY commander does after a runner was
    // shot on the direct approach (cmd._stealthCapture), to take a wide route around the hot zone.
    if ((cmd.archetype === 'rogue' || cmd._stealthCapture) && cmd.unit) {   // loop to the rear, THEN grab
      const u = cmd.unit.holder.position, rear = cmd.enemyRearApproach();
      // Head for the rear staging point first, but LATCH the handoff to the flag once we
      // reach the rear OR we're already on the doorstep — otherwise the two far-apart goals
      // flip every tick and the runner just pivots in place outside the base (the spin bug).
      // The latch lives on the unit, so a fresh runner re-does the loop; a carrier ignores it.
      if (!cmd.unit._rearReached) {
        const nearRear = Math.hypot(u.x - rear.x, u.z - rear.z) < 10;
        const nearFlag = Math.hypot(u.x - flagPt.x, u.z - flagPt.z) < 22;
        if (nearRear || nearFlag) cmd.unit._rearReached = true;
        else return rear;
      }
    }
    return flagPt;
  }
  shoot(cmd) { return false; }
  arriveDist(cmd) { return 3; }
  label(cmd) {
    const f = cmd.flag();
    if (f && f.carrier === cmd.unit) return 'home with the flag';
    if ((cmd.archetype === 'rogue' || cmd._stealthCapture) && !(cmd.unit && cmd.unit._rearReached)) return 'sneaking round the back';
    return 'snatching the flag';
  }
  cry(cmd) { return (cmd.archetype === 'rogue' || cmd._stealthCapture)
    ? pickCry(cmd, [
        'Flag’s open — sneaking a runner in the back door. Quiet now!',
        'Go, go — slip round the back and grab that flag!',
      ])
    : pickCry(cmd, [
        'The flag’s wide open — send the runner, grab it and RUN!',
        'This is our shot — go for the flag, don’t stop for anything!',
        'Flag’s exposed! Snatch it and haul it home!',
      ]); }
}

// DEFEND — hold the home base under tower cover; the brain still engages on sight. Once
// the towers are gone there's no cover to hold, so switch to a Valkyrie's mobility.
class Defend extends Mission {
  get key() { return 'defend'; }
  wantVehicle(cmd) { return cmd.ownTowersDown() ? 'valkyrie' : this.doc.role('defend'); }
  objective(cmd) { return cmd.patrolSpot(); }
  shoot(cmd) { return false; }
  arriveDist(cmd) { return 8; }
  label(cmd) { return 'patrolling the rear (flag↔elevator)'; }
  cry(cmd) { return pickCry(cmd, [
    'Pull back and hold the line — protect the flag!',
    'They’re pushing hard — dig in under the towers and hold!',
    'Everybody home — turtle up and guard our flag!',
  ]); }
}

// INTERCEPT — our flag's been lifted: only a Valkyrie is mobile enough to run the thief
// down before it reaches their elevator. Drop everything and chase (ai_behavior Defend).
class Intercept extends Mission {
  get key() { return 'intercept'; }
  wantVehicle(cmd) { return 'valkyrie'; }
  objective(cmd) { return cmd.interceptSpot(); }
  arriveDist(cmd) { return 4; }
  label(cmd) { return 'intercepting the flag runner!'; }
  cry(cmd) { return pickCry(cmd, [
    'They’ve got our flag! Scramble the Valkyrie — chase ’em down!',
    'Flag runner! Cut them off before they reach their elevator!',
    'Stop that thief! Run the carrier down NOW!',
  ]); }
}

const MISSIONS = { scout: Scout, attack: Attack, siege: Siege, capture: Capture, defend: Defend, intercept: Intercept };
function makeMission(key) { return new (MISSIONS[key] || Attack)(); }

// ---- DOCTRINE — a persona running one mission at a time ------------------------------
// Re-evaluates choose() every tick. A change only takes effect once the current mission
// has run a short dwell (anti-thrash) — except URGENT transitions (grab the flag now),
// which fire immediately. This is what makes missions complete/abort cleanly instead of
// the old linear step machine that could never let go of a finished objective.
const URGENT = new Set(['capture', 'intercept']);
const DWELL = 1.5;   // seconds a mission must run before a non-urgent switch

// Cycle a battle-cry pool deterministically (per-commander counter, no RNG) so the log reads
// like a commander giving orders instead of "scout → attack". Bumped once per mission switch.
function pickCry(cmd, pool) { cmd._cryN = (cmd._cryN || 0) + 1; return pool[cmd._cryN % pool.length]; }

// Runner-lost response mode — 'new' = cause-based (attack the interceptor / stealth retry),
// 'old' = the previous blind re-siege. Runtime-toggleable so a single build can A/B the two
// on identical (dseed-paired) matchups. Set via RR.setRunnerMode.
let RUNNER_MODE = 'new';
export function setRunnerMode(m) { RUNNER_MODE = m; }

// Rogue rear-siege — Valkyrie flanks to the back of the enemy base to shell the HQ from behind,
// staying out of the defender's reach (walls block a chasing ground unit; the flyer lifts over).
// Runtime-toggleable so a single build can A/B it on deterministic (rngseed) paired matches.
let ROGUE_REAR_SIEGE = true;
export function setRogueRearSiege(v) { ROGUE_REAR_SIEGE = !!v; }

class Doctrine {
  constructor(rng = Math.random, log = null) {
    this.rng = rng; this.log = log; this.t = 0;
    this.mission = makeMission(this.opening);
    this.mission.enter(null, this);
    this.step = this.mission.key;
  }
  role(key) { return this.roles[key] || this.roles.attack || 'lurcher'; }
  tick(cmd, dt) {
    this.t += dt;
    this.mission.tick(cmd, dt);
    if (cmd._clearPathT > 0) cmd._clearPathT -= dt;   // countdown: clearing a downed runner's interceptor
    let next = this._urgent(cmd);
    // PRESERVATION (any persona): losing the attrition war → hold under tower cover instead
    // of trading the last of the army out in the open — UNLESS we can win right now by
    // grabbing an exposed flag. Sits above the persona's own plan so every archetype turtles
    // up when it's getting wiped, then resumes its doctrine once it's back on even footing.
    if (!next && cmd.losingBadly && cmd.losingBadly() && !cmd.flagGrabbable()) next = 'defend';
    // DEFENSES BREACHED: the enemy's towers are down but their keep still stands → COMMIT to
    // siege and finish the HQ (which exposes the flag), instead of orbiting a defenceless base
    // dueling their leftover units. Without this, Hunter-type doctrines only siege on full
    // elimination, so a flyer circled a defenceless base for 150s with the HQ at full HP (trace).
    if (!next && cmd.fortDown && cmd.fortDown() && !cmd.flagExposed()) next = 'siege';
    // A capture runner was gunned down by an enemy VEHICLE → hunt the interceptor down before
    // feeding another firebrat into it (timed, so it doesn't chase forever).
    if (!next && cmd._clearPathT > 0) next = 'attack';
    if (!next) next = this.choose(cmd);
    if (next && next !== this.step && (this.t > DWELL || URGENT.has(next))) this._switch(next, cmd);
  }
  // Emergencies that preempt any persona's plan: our flag's been lifted → run it down
  // (unless WE'RE the one carrying the enemy flag home — don't blow a winning run).
  _urgent(cmd) {
    if (cmd.ourFlagStolen() && !(cmd.flag() && cmd.flag().carrier === cmd.unit)) return 'intercept';
    return null;
  }
  _switch(key, cmd) {
    if (!key || key === this.step) { this.t = 0; return; }
    const from = this.step;
    this.mission = makeMission(key);
    this.mission.enter(cmd, this);
    this.step = key; this.t = 0;
    // Radio-chatter order instead of the terse "scout → attack". The mission's own cry()
    // supplies a characterful line; it still names the intent, and the unit STATE lines
    // carry the hard numbers (hp %, turrets left, ammo/fuel).
    if (this.log) this.log(this.mission.cry(cmd));
  }
  // Runner died storming the base → respond to WHY, instead of feeding another firebrat down
  // the same lane. Shot by an enemy VEHICLE → send an ATTACK to clear the interceptor first
  // (timed window). Shot by TOWERS on the approach → retry as a STEALTH capture: a wide rear
  // route around the hot zone (the flag's still grabbable, just not head-on).
  onRunnerLost(cmd, enemyHasUnits) {
    if (RUNNER_MODE === 'old') { this._switch(this.softenKey, cmd); return; }   // A/B baseline: blind re-siege
    // Defenders still alive → switch to ATTACK NOW (so the NEXT deploy is a fighter, not
    // another firebrat) and hold it there for a window to clear them, then resume the grab.
    // No defenders left (pure tower gauntlet) → sneak in on a wide route instead.
    if (enemyHasUnits) { cmd._clearPathT = 18; this._switch('attack', cmd); }
    else cmd._stealthCapture = true;
  }
  get softenKey() { return 'siege'; }
  // --- interface the commander consumes (delegated to the running mission) ---
  wantVehicle(cmd) { return this.mission.wantVehicle(cmd); }
  objective(cmd) { return this.mission.objective(cmd); }
  shoot(cmd) { return this.mission.shoot(cmd); }
  arriveDist(cmd) { return this.mission.arriveDist(cmd); }
  objectiveLabel(cmd) {
    const f = cmd.flag();
    if (f && f.carrier === cmd.unit) return 'home with the flag';
    return this.mission.label(cmd);
  }
  softenStep() { return this.softenKey; }   // back-compat (no longer poked directly)
}

// WARRIOR — "ride out, rack up kills, then break the base" (uses Lurcher → Jotun → runner).
class Warrior extends Doctrine {
  get opening() { return 'attack'; }
  get roles() { return { scout: 'lurcher', attack: 'lurcher', siege: 'jotun', defend: 'lurcher', capture: 'firebrat' }; }
  choose(cmd) {
    if (cmd.flagGrabbable()) return 'capture';
    if (cmd.kills >= 2 || cmd.enemyEliminated()) return 'siege';
    return 'attack';
  }
}

// ROGUE — "snatch before they know you're there": a Valkyrie quietly softens the flag
// base from range, then a Firebrat races in the instant it's open. Avoids brawls.
class Rogue extends Doctrine {
  get opening() { return 'siege'; }
  get roles() { return { scout: 'firebrat', attack: 'valkyrie', siege: 'valkyrie', defend: 'valkyrie', capture: 'firebrat' }; }
  choose(cmd) {
    // Race in the instant it's safe — but only once the flag is exposed AND its turrets
    // are down (a Valkyrie can crack the HQ from range while towers still stand; sending
    // the Firebrat then just feeds it to the guns).
    if (cmd.flagGrabbable()) return 'capture';
    return 'siege';
  }
}

// HUNTER — "own the field, ambush the weak, then snatch". Scouts with a Valkyrie to find
// the enemy (RESERVING its Firebrats for the capture), hunts with a Lurcher, and — the
// key fix — when there's nothing left to hunt, cracks the base instead of firing at air.
class Hunter extends Doctrine {
  get opening() { return 'scout'; }
  get roles() { return { scout: 'valkyrie', attack: 'lurcher', siege: 'valkyrie', defend: 'lurcher', capture: 'firebrat' }; }
  choose(cmd) {
    if (cmd.flagGrabbable()) return 'capture';
    if (cmd.enemyEliminated()) return 'siege';                 // no one to hunt → press the base
    if (!cmd.knowsEnemy()) return 'scout';                     // haven't found them yet → recon
    return 'attack';
  }
}

// TURTLE — "hold the wall, bleed them, then sortie". Defends under tower cover and only
// goes on the offensive once it's beaten attackers back.
class Turtle extends Doctrine {
  get opening() { return 'defend'; }
  get roles() { return { scout: 'lurcher', attack: 'lurcher', siege: 'valkyrie', defend: 'lurcher', capture: 'firebrat' }; }
  choose(cmd) {
    if (cmd.flagGrabbable()) return 'capture';
    if (cmd.kills >= 2 || cmd.enemyEliminated()) return 'siege';
    return 'defend';
  }
}

const DOCTRINE_CLASS = { warrior: Warrior, turtle: Turtle, rogue: Rogue, hunter: Hunter };
const ARCHETYPES = Object.keys(DOCTRINE_CLASS);

// One commander's archetype (random). Used for the lone AI in a human match.
export function pickArchetype(rng = Math.random) { return ARCHETYPES[(rng() * ARCHETYPES.length) | 0]; }

// Deal DISTINCT archetypes across N commanders so an AI-vs-AI match is a CONTRAST
// (a Warrior vs a Turtle will actually fight). Shuffles the roster, cycles if N is bigger.
export function assignArchetypes(n, rng = Math.random) {
  const pool = [...ARCHETYPES];
  for (let i = pool.length - 1; i > 0; i--) { const j = (rng() * (i + 1)) | 0; const t = pool[i]; pool[i] = pool[j]; pool[j] = t; }
  return Array.from({ length: n }, (_, i) => pool[i % pool.length]);
}

// Build the doctrine a commander runs from its archetype name. `log` (optional) is a
// per-commander logger so mission switches surface in the AI overlay.
export function makeDoctrine(archetype, personality, rng = Math.random, avoid = null, log = null) {
  const C = DOCTRINE_CLASS[archetype] || Warrior;
  return new C(rng, log);
}
