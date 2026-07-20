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
  // Close arrive distance: a scout must actually FLY TO each recon waypoint. At the old 30u the
  // seek behaviour stopped 30u short — and since a unit paints ~46u of map "seen" around itself,
  // it marked the waypoint from afar, stopped, and never travelled: parked at its own FOB all match.
  arriveDist(cmd) { return 10; }
  label(cmd) { return 'sweeping for recon'; }
  cry(cmd) { return pickCry(cmd, [
    'Where are they hiding? Fan out and find them.',
    'No sign of the enemy yet — go take a look around.',
    'Eyes on the field. Let’s see what they’re up to.',
  ]); }
}

// SAP — the opening sortie: send a Firebrat out to a forward point to seed the contested
// ground with mines and drop a sensor pod (the actual laying is in the game's aiLayGadgets,
// which fires for any Firebrat; this mission just gets one out EARLY and keeps it out of
// fights until the loadout's down). Completes via cmd._sapDone (set when it's laid its kit,
// or on the sap budget timeout in Doctrine.tick).
class Sap extends Mission {
  get key() { return 'sap'; }
  wantVehicle(cmd) { return 'firebrat'; }
  shoot(cmd) { return false; }               // it's laying + scouting, not brawling
  arriveDist(cmd) { return 8; }
  // Drive to the far end of a home-side FLANK, then lay mines on the way back (main.js sapTarget/
  // aiLayGadgets run the out→back→pod route). Off our own lane, so we don't mine our own advance.
  objective(cmd) { return cmd.unit ? cmd.sapTarget(cmd.unit) : cmd.homeBasePos(); }
  label(cmd) { return 'a flank recon-and-mine run'; }
  cry(cmd) { return pickCry(cmd, [
    'Send a Firebrat wide — scout the flank and mine it on the way back.',
    'Recon the flank and seed it with mines before they probe it.',
    'Firebrat out to the side — eyes on that approach, mines on the return.',
  ]); }
}

// TRAP (Hunter, Mode B) — after the sapper mines the lane, field a Lurcher as BAIT and lure the
// enemy across the kill-zone. Sub-phases (main.js sets the geometry via cmd._trap):
//   anchor — hold just behind the mines, quiet, ~10s.
//   signal — still nobody → stay put and fire a few SIGNAL shots toward their base (gunfire
//            carries — the sound-awareness system baits listeners in). If nobody shows in the
//            signal window either, the trap tender moves on (_trapDone → the persona playbook:
//            attack/siege), leaving the mines armed behind it.
//   lure   — enemy in sight near the trap → fall back so the MINES sit between us and them and
//            KITE: circle the cluster (trapShield skirts it, never crosses), firing whenever the
//            gun bears, so a tunnel-visioned pursuer (target-fixation: slimmer mine-spot roll)
//            chases us straight across the kill-zone.
const TRAP_QUIET = 10;    // s parked silent in ambush before signalling
const TRAP_SIGNAL = 14;   // s of signal shots before giving up on a no-show
const TRAP_LURE_R = 55;   // u from the trap centroid within which the bait kites (beyond it: normal engage)
class Trap extends Mission {
  get key() { return 'trap'; }
  wantVehicle(cmd) { return 'lurcher'; }
  enter(cmd, doc) { super.enter(cmd, doc); this._phase = 'anchor'; }
  tick(cmd, dt) {
    super.tick(cmd, dt);
    const sees = cmd.lastEnemyPos && cmd.lastEnemyPos();
    // The no-show clock lives on the COMMANDER (cmd._trapIdleT), not this mission instance —
    // an emergency (defend) can preempt the trap and re-enter it, and a per-instance timer
    // would restart the whole wait each time (the tender then never times out).
    if (sees) { cmd._trapIdleT = 0; this._phase = 'lure'; }
    else {
      cmd._trapIdleT = (cmd._trapIdleT || 0) + dt;
      this._phase = cmd._trapIdleT > TRAP_QUIET ? 'signal' : 'anchor';
      // Signalled long enough with no takers → stop tending; the doctrine falls through to
      // the persona playbook (a hunter goes attack/siege). The mines stay armed either way.
      if (cmd._trapIdleT > TRAP_QUIET + TRAP_SIGNAL) cmd._trapDone = true;
    }
  }
  objective(cmd) { return this._phase === 'lure' ? cmd.trapShield() : cmd.trapAnchor(); }
  shoot(cmd) { return false; }   // never blind-shell the objective; signal shots are their own hook
  // SIGNAL SHOTS: a few spaced rounds toward the enemy base — pure noise-bait, consumed by
  // the firing block in main.js (fires only when idle: no visible enemy, gun off cooldown).
  signalShot(cmd) {
    if (this._phase !== 'signal' || !cmd.unit) return null;
    const e = cmd.enemyBasePos(), u = cmd.unit.holder.position;
    const dx = e.x - u.x, dz = e.z - u.z, d = Math.hypot(dx, dz) || 1;
    return { x: u.x + dx / d * 30, z: u.z + dz / d * 30 };   // lob one ~30u down the lane
  }
  // KITE ANCHOR: while luring with the enemy close to the kill-zone, the brain's engage
  // footwork steers for THIS point (mines between us and them) instead of duelling footwork —
  // that duel strafing is blind to mines and is how the bait blew up its own trap.
  lurePoint(cmd) {
    if (this._phase !== 'lure' || !cmd.unit || !cmd._trap) return null;
    const u = cmd.unit.holder.position, t = cmd._trap;
    if ((u.x - t.x) ** 2 + (u.z - t.z) ** 2 > TRAP_LURE_R * TRAP_LURE_R) return null;   // too far out — fight normally
    return cmd.trapShield();
  }
  arriveDist(cmd) { return this._phase === 'anchor' ? 6 : 10; }
  label(cmd) { return this._phase === 'lure' ? 'luring them onto the mines'
    : this._phase === 'signal' ? 'firing signal shots to bait them in' : 'set in ambush behind the trap'; }
  cry(cmd) { return pickCry(cmd, [
    'Set the trap — get behind the mines and draw them onto it.',
    'Bait them across the minefield.',
    'Hunter\'s game — lure them onto the mines.',
  ]); }
}

// ATTACK — recall the enemy's last-known position and hunt them down; with no recent
// sighting, fall back to where they emerge (the elevator).
class Attack extends Mission {
  get key() { return 'attack'; }
  objective(cmd) { return cmd.lastEnemyPos() || cmd.enemyStagingHold(); }   // a REACHABLE standoff, not the walled fob centre (see enemyStagingHold)
  // The objective is a place to HOLD/HUNT (a last-seen spot or the enemy's deploy pad), NOT a
  // fortification to shell — so don't blind-fire the goal (base Mission defaults shoot=true, which
  // had a Warrior dumping rounds over a flattened, empty staging point). Real targets are still
  // engaged: seen enemies via engage, live turrets via the threatened→suppress transition.
  shoot(cmd) { return false; }
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
  // HQ FINISHER: turrets are down but the walled HQ still stands. A GROUND unit (a Warrior's
  // Jotun) can't hit the keep through the surrounding walls — it clears every turret and then
  // stalls at 85 dmg on a 600hp HQ (measured). Only a FLYER lifts over the walls for a clean
  // shot, so once the fort is down we field a Valkyrie to actually crack it (data: the HQ only
  // ever dies with sustained Valkyrie presence). Toggle via RR.setHqFinisher for A/B.
  wantVehicle(cmd) {
    if (cmd.enemyEliminated()) return 'jotun';                                  // unopposed → railgun closes in + demolishes fast
    if (cmd._gambit && !cmd.flagExposed()) return 'valkyrie';                   // stalemate gambit → send the flyer around the back
    if (HQ_FINISHER && cmd.fortDown() && !cmd.flagExposed()) return 'valkyrie';  // turrets down, HQ walled → send the flyer
    return this.doc.role(this.key);
  }
  // ROGUE SIEGE (from behind): a Rogue's Valkyrie doesn't slug it out at the front — it curls AROUND
  // to the REAR of the enemy base and rockets the flag HQ from behind. Flight is the whole point: a
  // ground unit sent to stop it gets hung up on the base walls, while the flyer just lifts over them
  // and repositions — so it survives to keep chipping the HQ down instead of trading into the
  // defender out front. Loop to the rear staging point first (latched, like the capture sneak), then
  // settle into the shell; the hqThreat standoff then holds on that rear line.
  objective(cmd) {
    if (ROGUE_REAR_SIEGE && (cmd.archetype === 'rogue' || cmd._gambit) && cmd.unit && cmd.unit.type === 'valkyrie' && !cmd.flagExposed()) {
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
      if (ROGUE_REAR_SIEGE && (cmd.archetype === 'rogue' || cmd._gambit) && cmd.unit._siegeRearReached && !cmd.flagExposed()) return 10;
      return 26;
    }
    return 12;
  }
  label(cmd) {
    if (cmd.enemyEliminated()) return 'levelling the undefended base';
    if (ROGUE_REAR_SIEGE && (cmd.archetype === 'rogue' || cmd._gambit) && cmd.unit && cmd.unit.type === 'valkyrie' && !(cmd.unit && cmd.unit._siegeRearReached) && !cmd.flagExposed()) return 'flanking to shell the HQ from behind';
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
  // Should THIS runner sneak in the back? Only a Rogue / post-death stealth run AND only when the
  // REAR is clear of live towers — otherwise looping around drives it straight into fresh guns (the
  // "feed Firebrats to the back-door death" bug). Latched per unit so the count dropping mid-run
  // can't flip a committed front approach into a back one (or vice-versa).
  _sneak(cmd) {
    if (!cmd.unit) return false;
    if (cmd.unit._sneakBack === undefined)
      cmd.unit._sneakBack = (cmd.archetype === 'rogue' || cmd._stealthCapture)
        && (!REAR_SNEAK_GATE || cmd.rearTowersLive() === 0);
    return cmd.unit._sneakBack;
  }
  // The flag's been knocked loose from its base (a downed carrier dropped it mid-field):
  // it's out from under the base guns, so the whole sneak-in-the-back choreography is
  // pointless — a fresh runner should beeline the flag itself, not stage behind an empty base.
  _displaced(f) {
    return !!(f && !f.carried && Math.hypot(f.group.position.x - f.home.x, f.group.position.z - f.home.z) > 8);
  }
  objective(cmd) {
    const f = cmd.flag();
    if (f && f.carrier === cmd.unit) return cmd.homePos();            // carrying → run it home
    const flagPt = f ? { x: f.group.position.x, z: f.group.position.z } : cmd.enemyBasePos();
    if (this._displaced(f)) return flagPt;                            // loose in the field → straight at it
    // MISSIONSCORE directional run: stage via the scored side's approach point, then grab —
    // same reach-latch as the rogue sneak (goals must not flip while the runner commits).
    // The 'front' direction stages on our own approach lane, so it latches almost instantly.
    if (missionWeightsOn(cmd) && cmd._capDir && cmd.unit && cmd.enemyRoute) {
      const u = cmd.unit.holder.position;
      if (CAP_ROUTES) {
        // Multi-waypoint route (front direct / left-right doglegs / rear water arc). Latch the whole
        // route on the unit at first read, so a mid-run _capDir change doesn't flip this runner's
        // path (the NEXT deploy picks the new direction). Then step waypoint→waypoint.
        const route = cmd.unit._capRoute || (cmd.unit._capRoute = cmd.enemyRoute(cmd._capDir));
        let idx = cmd.unit._capIdx || 0;
        const now = cmd._matchT || 0;
        let reached = false;
        while (idx < route.length && Math.hypot(u.x - route[idx].x, u.z - route[idx].z) < 14) { idx++; reached = true; }   // consume reached waypoints
        // BAIL-OUT: never grind ONE waypoint forever. If it can't be reached within CAP_WP_SKIP sec
        // (unreachable/off-map/behind a wall), skip it — the 500s permanent-stuck becomes an 8s blip.
        if (reached || cmd.unit._capWpT == null) cmd.unit._capWpT = now;                     // fresh waypoint → reset the clock
        else if (idx < route.length && now - cmd.unit._capWpT > CAP_WP_SKIP) { idx++; cmd.unit._capWpT = now; }
        cmd.unit._capIdx = idx;
        const nearFlag = Math.hypot(u.x - flagPt.x, u.z - flagPt.z) < 22;
        if (!nearFlag && idx < route.length) return route[idx];   // still staging → head for the next waypoint
        return flagPt;                                            // route done (or on the doorstep) → grab it
      }
      // ROUTES OFF (?noroute): the pre-route single staging point — stage at the scored side, then grab.
      const ap = cmd.enemyApproach(cmd._capDir);
      if (!cmd.unit._dirReached) {
        const nearAp = Math.hypot(u.x - ap.x, u.z - ap.z) < 10;
        const nearFlag = Math.hypot(u.x - flagPt.x, u.z - flagPt.z) < 22;
        if (nearAp || nearFlag) cmd.unit._dirReached = true;
        else return ap;
      }
      return flagPt;
    }
    // Stealth run: sneak the runner in the back — but only when the rear is undefended (_sneak).
    // If the back towers are still up (only the front fell), go straight in the front instead.
    if (this._sneak(cmd) && cmd.unit) {   // loop to the rear, THEN grab
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
    if (this._displaced(f)) return 'racing for the loose flag';
    if (this._sneak(cmd) && !(cmd.unit && cmd.unit._rearReached)) return 'sneaking round the back';
    return 'snatching the flag';
  }
  cry(cmd) { return this._sneak(cmd)
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

// DEFEND — patrol the approach lane (home front ↔ mid-field) and RESPOND: a hit on our
// towers (homeAttack radio) or a seen/heard contact on our half pre-empts the patrol and
// the defender runs it down — the ai_behavior ambush (catch the attacker while it's busy
// engaging the towers, come in behind it). The brain still engages on sight. Once the
// towers are gone there's no cover to hold, so switch to a Valkyrie's mobility.
class Defend extends Mission {
  get key() { return 'defend'; }
  wantVehicle(cmd) { return cmd.ownTowersDown() ? 'valkyrie' : this.doc.role('defend'); }
  objective(cmd) {
    const atk = cmd.homeAttack();                 // our structures are being SHOT — beats hearing range
    if (atk) return atk;
    const p = cmd.lastEnemyPos();                 // seen OR heard contact (team intel, ~12s fresh)
    if (p) {
      const home = cmd.homeBasePos(), en = cmd.enemyBasePos();
      const dh = (p.x - home.x) ** 2 + (p.z - home.z) ** 2, de = (p.x - en.x) ** 2 + (p.z - en.z) ** 2;
      if (dh < de) return p;                      // on OUR half → run it down; their half = bait, hold the lane
    }
    // QUIET WATCH = MAINTENANCE TIME: nothing shooting us, nothing on our half → top the
    // hull at home before resuming the lane (guards fight at whatever they carry in; a
    // fresh guard wins the duels a worn one loses). Any contact above pre-empts this.
    if (TURTLE_GUARD && cmd.unit && cmd._home && cmd.unit.hp < cmd.unit.maxHp * 0.85) return cmd._home;
    return cmd.patrolSpot();
  }
  shoot(cmd) { return false; }
  arriveDist(cmd) { return 8; }
  label(cmd) {
    if (cmd.homeAttack()) return 'responding — our towers are under fire!';
    const p = cmd.lastEnemyPos();
    if (p) {   // same our-half test as objective (patrolSpot() advances its route — don't re-call it here)
      const home = cmd.homeBasePos(), en = cmd.enemyBasePos();
      if ((p.x - home.x) ** 2 + (p.z - home.z) ** 2 < (p.x - en.x) ** 2 + (p.z - en.z) ** 2) return 'running down a contact on our ground';
    }
    if (TURTLE_GUARD && cmd.unit && cmd._home && cmd.unit.hp < cmd.unit.maxHp * 0.85) return 'patching up at home between contacts';
    return 'patrolling the lane (base↔mid-field)';
  }
  cry(cmd) { return pickCry(cmd, [
    'Pull back and hold the line — protect the flag!',
    'They’re pushing hard — dig in under the towers and hold!',
    'Everybody home — turtle up and guard our flag!',
  ]); }
}

// HARASS — the hunter's disruption tour, run when there's no live contact to hunt:
// rotate cheap-to-hit, expensive-to-ignore stops on THEIR half — the enemy-half shield
// generator above all (kill it and their lurchers fight the rest of the match without
// armour), a corner tower to snipe, their salvage to steal. Fire briefly, then FADE to
// the farthest next stop before the response lands: every poke writes a false alarm
// into their radio and drags guards to where we WERE, opening the field for the rest
// of the army. Never commits — this is disruption, not a siege (harassSpot rotates on
// an engagement budget: ~9s on station or real return damage).
class Harass extends Mission {
  get key() { return 'harass'; }
  wantVehicle(cmd) { return this.doc.role('attack'); }
  objective(cmd) { return cmd.harassSpot(); }
  shoot(cmd) { return true; }                   // the structure at the stop IS the point
  arriveDist(cmd) { return 22; }                // stand off and snipe, don't park on it
  label(cmd) { return cmd._harassTgt ? `harassing: ${cmd._harassTgt.kind}` : 'harassing their backfield'; }
  cry(cmd) { return pickCry(cmd, [
    'Poke and fade — keep ’em jumping at shadows!',
    'Hit their gear and get out — don’t let them pin you!',
    'Make some noise out there, then vanish!',
  ]); }
}

// INTERCEPT — our flag's been lifted: only a Valkyrie is mobile enough to run the thief
// down before it reaches their elevator. Drop everything and chase (ai_behavior Defend).
class Intercept extends Mission {
  get key() { return 'intercept'; }
  wantVehicle(cmd) { return 'valkyrie'; }
  objective(cmd) { return cmd.interceptSpot(); }
  // Chase the carrier (interceptSpot tracks it), but don't blind-fire the chase point — kill the
  // thief when we actually SEE it (the engage transition, with lead-aim). Stops shooting at the
  // empty spot where the runner was / at their elevator.
  shoot(cmd) { return false; }
  arriveDist(cmd) { return 4; }
  // Phase 2: the thief's dead and the flag's lying loose — same mission, new objective
  // (interceptSpot returns the flag once no live carrier); touching it snaps it home.
  label(cmd) { return cmd.ourFlagStolen() ? 'intercepting the flag runner!' : 'recovering our dropped flag'; }
  cry(cmd) { return cmd.ourFlagStolen()
    ? pickCry(cmd, [
        'They’ve got our flag! Scramble the Valkyrie — chase ’em down!',
        'Flag runner! Cut them off before they reach their elevator!',
        'Stop that thief! Run the carrier down NOW!',
      ])
    : pickCry(cmd, [
        'The thief is down! Get to our flag and bring it home!',
        'Our flag’s lying out there — grab it back before they do!',
        'Flag’s on the ground — somebody touch it home, NOW!',
      ]); }
}

// SCAVENGE — "find parts": we need a flag RUNNER to win but have none and can't afford to
// build one, so send a unit to collect salvage (known piles first, else scout for more) until
// the bank can fund a firebrat. Don't pick fights — this is a supply run.
class Scavenge extends Mission {
  get key() { return 'scavenge'; }
  wantVehicle(cmd) { return cmd._pickAvailableType('lurcher') || cmd._pickAvailableType('firebrat') || 'lurcher'; }   // any mobile collector we've got
  objective(cmd) {
    const u = cmd.unit ? cmd.unit.holder.position : { x: 0, z: 0 };
    const sp = cmd.nearestKnownScrap(u.x, u.z);   // returns the PILE now (renamed) — take its point
    return (sp ? sp.pos : null) || cmd.exploreTarget() || cmd.enemyFobPos();
  }
  shoot(cmd) { return false; }
  arriveDist(cmd) { return 4; }
  label(cmd) { return cmd.nearestKnownScrap(cmd.unit ? cmd.unit.holder.position.x : 0, cmd.unit ? cmd.unit.holder.position.z : 0) ? 'running down salvage for parts' : 'scouting for salvage'; }
  cry(cmd) { return pickCry(cmd, [
    'We’re out of runners — scrounge the wrecks for parts, we need to build one!',
    'No firebrat, no flag. Go collect every scrap of salvage you can find!',
    'Comb the field for parts — we can’t win without a runner!',
  ]); }
}

const MISSIONS = { sap: Sap, trap: Trap, scout: Scout, attack: Attack, siege: Siege, capture: Capture, defend: Defend, intercept: Intercept, scavenge: Scavenge, harass: Harass };
function makeMission(key) { return new (MISSIONS[key] || Attack)(); }

// ---- DOCTRINE — a persona running one mission at a time ------------------------------
// Re-evaluates choose() every tick. A change only takes effect once the current mission
// has run a short dwell (anti-thrash) — except URGENT transitions (grab the flag now),
// which fire immediately. This is what makes missions complete/abort cleanly instead of
// the old linear step machine that could never let go of a finished objective.
const URGENT = new Set(['capture', 'intercept', 'sap']);   // sap fires once at the start — switch immediately, no wrong-unit deploy first
const DWELL = 1.5;   // seconds a mission must run before a non-urgent switch
const SAP_BUDGET = 40;   // s the opening sapper gets to lay its kit before we move on regardless
const TRAP_BUDGET = 120; // s a hunter tends its mine trap (bait/lure) before resuming normal play
// Chance a commander opens with a recon-and-mine sapper sortie, by persona (rolled once at start).
// Not every match pays the opening tax — hunters/turtles favour it, warriors mostly just push.
const SAP_CHANCE = { hunter: 0.7, turtle: 0.6, rogue: 0.4, warrior: 0.2 };
// Odds a persona breaks off its field plan when its own base is being shelled (rolled once
// per 25s raid window in tick()). Identity, not balance: the turtle is a homebody, the
// rogue's whole doctrine is "their base falls before ours does" — it plays the race.
const HOME_RESPONSE = { turtle: 1.0, warrior: 0.7, hunter: 0.55, rogue: 0.25 };

// REPORT-CARD UNBLOCKERS — what to run instead when a mission is banned (two straight
// total-failure deaths: no kills, no base damage, flag untouched — see cmd.missionBanned).
// Each alternative REMOVES what was killing the units rather than re-rolling blindly:
// runners fed into live towers → SIEGE the towers first; siegers dying with no damage
// dealt → the enemy fleet is on them, ATTACK it; attackers dying without kills → stop
// brawling and hit structures from range. defend/intercept are reactive — never banned.
const FAIL_ALT = { capture: 'siege', siege: 'attack', attack: 'siege', scout: 'attack', scavenge: 'attack' };

// Cycle a battle-cry pool deterministically (per-commander counter, no RNG) so the log reads
// like a commander giving orders instead of "scout → attack". Bumped once per mission switch.
function pickCry(cmd, pool) { cmd._cryN = (cmd._cryN || 0) + 1; return pool[cmd._cryN % pool.length]; }

// Runner-lost response mode — 'new' = cause-based (attack the interceptor / stealth retry),
// 'old' = the previous blind re-siege. Runtime-toggleable so a single build can A/B the two
// on identical (dseed-paired) matchups. Set via RR.setRunnerMode.
let RUNNER_MODE = 'new';
export function setRunnerMode(m) { RUNNER_MODE = m; }

// Once the enemy fort is down but its HQ still stands, field a Valkyrie to shell the keep over
// the walls (a ground siege can't reach it). Default OFF: the swap FIRES correctly but a lone
// Valkyrie can't out-DPS the 600hp HQ before dying, so it's resolution-neutral and just adds
// recall churn — it needs pairing with a balance change (lower HQ hp / higher structure DPS).
// A/B via RR.setHqFinisher.
let HQ_FINISHER = false;
export function setHqFinisher(v) { HQ_FINISHER = !!v; return HQ_FINISHER; }

// Rogue rear-siege — Valkyrie flanks to the back of the enemy base to shell the HQ from behind,
// staying out of the defender's reach (walls block a chasing ground unit; the flyer lifts over).
// Runtime-toggleable so a single build can A/B it on deterministic (rngseed) paired matches.
let ROGUE_REAR_SIEGE = true;
// TURTLE GUARD v2 (A/B knob): per-slot kill gate + shield-generator guarding + quiet-time
// maintenance. Off = the legacy turtle (team-kill siege flip, plain lane patrol).
let TURTLE_GUARD = true;
export function setTurtleGuard(v) { TURTLE_GUARD = !!v; }
// HUNTER HARASS (A/B knob): with no live contact to hunt, the hunter runs disruption
// tours on the enemy half instead of a generic attack push. Off = legacy hunter.
let HUNTER_HARASS = true;
export function setHunterHarass(v) { HUNTER_HARASS = !!v; }
export function setRogueRearSiege(v) { ROGUE_REAR_SIEGE = !!v; }
// CAPTURE ROUTES (A/B knob): multi-waypoint directional runner paths (doglegs + rear water arc)
// vs the pre-route single staging point. Isolates whether the routes are the nav regression.
let CAP_ROUTES = true;
export function setCapRoutes(v) { CAP_ROUTES = !!v; }
const CAP_WP_SKIP = 8;   // sec a runner may chase one route waypoint before skipping it (anti permanent-stuck)

// A back-door runner only sneaks around the rear when the REAR towers are dead; if the back is
// still defended it takes the front instead (stops feeding Firebrats to live back-door guns).
// A/B knob: off = old behaviour (always sneak on a stealth run, rear towers or not).
let REAR_SNEAK_GATE = true;
export function setRearSneakGate(v) { REAR_SNEAK_GATE = !!v; }

// ── MISSIONSCORE — a fight-or-flight for STRATEGY (blueprint: devblog/post19.html) ────────
// Every candidate mission gets a signed weight from the board state; the commander runs the
// top one. This is the same idea as fightScore() (combat), pointed at strategy — and the
// hand-authored version of what the L2 mission net tried to learn. It REPLACES the persona
// choose() cascade + the 2-strike report-card ban (the decaying `success` memory below is the
// smooth anti-repeat: "never repeat a failing mission"). Behind RR.setMissionWeights — OFF by
// default, so the classic playbook and this scorer both live in the build, knob-selectable.
// Slice A1: scores the existing mission set (capture undirected). Directional capture,
// Siege-back, and the fog-honest lane-clear land in A2.
let MISSION_WEIGHTS = true;   // the DEFAULT brain since 2026-07-18 (verdict: equal-or-better on
                              // every axis, better by design on finish/reroute; the classic
                              // cascade stays selectable below as the A/B baseline)
export function setMissionWeights(on) { MISSION_WEIGHTS = !!on; return MISSION_WEIGHTS; }
// Per-team override (head-to-head A/B: scorer vs classic in ONE match, like the L2 net's
// missionPolicyTeam). undefined = follow the global knob.
const MISSION_WEIGHTS_TEAM = {};
export function setMissionWeightsTeam(team, on) {
  if (on == null) delete MISSION_WEIGHTS_TEAM[team]; else MISSION_WEIGHTS_TEAM[team] = !!on;
  return MISSION_WEIGHTS_TEAM[team];
}
export function missionWeightsOn(cmd) {
  const t = cmd && cmd.team;
  if (t != null && t in MISSION_WEIGHTS_TEAM) return MISSION_WEIGHTS_TEAM[t];
  return MISSION_WEIGHTS;
}

// fleet-comp: (a type's share of our remaining fleet − threshold) × 10, bonus-only. Play to
// what we have — a Firebrat-heavy fleet leans capture, a Jotun-heavy one leans the front
// siege, a Valkyrie-heavy one the rear siege (the flyer clears the walls to get there).
const FLEET_FAV = { firebrat: ['capture', 0.40], lurcher: ['attack', 0.23], valkyrie: ['siege-back', 0.15], jotun: ['siege', 0.15] };
// archetype nudges per mission (the personalities survive, like v.fofW biases the fight
// score). A bare base key ('capture') applies to every direction of it.
const PERSONA_BIAS = {
  warrior: { attack: 2, siege: 1 },
  turtle:  { defend: 2, scout: -1 },
  hunter:  { attack: 1, siege: 1, trap: 3, scout: 1 },
  rogue:   { capture: 1, 'capture-rear': 1, scout: 1, sap: 1, siege: 1, 'siege-back': 1 },
};
// A2: capture is DIRECTIONAL (front/left/right/rear — a stonewalled lane has three other
// angles, and each direction remembers its own failures) and the rear siege is its own plan.
const MSN_CANDS = ['scout', 'attack', 'siege', 'siege-back',
  'capture-front', 'capture-left', 'capture-right', 'capture-rear',
  'defend', 'intercept', 'scavenge', 'sap', 'trap'];

// Score one mission → { total, terms:[[label,val],…] } (terms drive the troubleshooting log).
export function missionScore(cmd, key) {
  const T = []; let w = 0;
  const add = (label, v) => { if (v) { T.push([label, Math.round(v * 10) / 10]); w += v; } return v; };
  const roster = cmd.roster || {}, fleet = cmd.fleetLeft() || 1, arch = cmd.archetype;
  const exposed = cmd.flagExposed(), towers = cmd.turretsLive(), matchT = cmd._matchT || 0;
  // GRADUAL terms (the house rule: a weight scales with how TRUE its condition is — no
  // cliff-edges at arbitrary thresholds; only genuine facts stay binary):
  const earlyB = Math.max(0, (120 - matchT) / 60);              // +2 at kickoff → 0 by 2min
  const spareFB = Math.min(1.5, Math.max(0, (roster.firebrat || 0) - 1) * 0.75);  // per spare runner (re-anchored: 1 spare ≈ the proven binary's +1)
  const lostAge = cmd._lostRecentT != null ? matchT - cmd._lostRecentT : 1e9;
  const justLost = lostAge < 20 ? 2 * (1 - lostAge / 20) : 0;   // sting fades over 20s

  const base = key.split('-')[0];   // 'capture-rear' → 'capture'; 'siege-back' → 'siege'
  // CLOCK PRESSURE (Jacob's rule): the longer the match runs, the hungrier the WIN missions
  // get — siege (opens the flag) and capture (takes it) ramp +1 per 5 minutes, capped at +3.
  // Early game it's ~nothing; by late game somebody always forces a decision instead of two
  // careful commanders trading patrols until the clock dies. Defense keeps its full emergency
  // spikes — it just stops winning ties against offense in a long game.
  if (base === 'siege' || base === 'capture') { const cp = Math.min(3, matchT / 300); if (cp >= 0.5) add('clock', Math.round(cp * 10) / 10); }
  switch (base) {
    case 'scout':
      add('base', 1); if (earlyB >= 0.1) add('early', earlyB); break;
    case 'attack': {
      add('base', 1);
      const fk2 = Math.max(0, 3 - cmd.kills) * 0.7;             // hungriest at zero kills, gone by three
      if (fk2 >= 0.1) add('few kills', fk2);
      if (justLost >= 0.1) add('just lost a unit', justLost);
      // CLEAR THE INTERCEPTORS: our runners keep dying to enemy DEFENDERS (not towers) — go hunt
      // them down first. Escalates with each lost runner, fades ~30s after the last interception.
      const rInt = (cmd._runnerInterceptT != null && matchT - cmd._runnerInterceptT < 30) ? Math.min(8, 3 * (cmd._runnerLosses || 0)) : 0;
      if (rInt) add('clear interceptors', rInt); break;
    }
    case 'siege':
      if (key === 'siege-back') {
        // the rear-lane opener: worth running while REAR towers stand (1.5 each), extra when
        // dropping them would open a rear capture the front can't offer
        const rearUp = cmd.rearTowersLive ? cmd.rearTowersLive() : 0;
        add('rear towers standing', rearUp * 1.5);
        if (rearUp > 0 && exposed) add('opens rear capture', 1);
      } else {
        add('towers standing', towers * 1); if (!exposed) add('flag sealed', 2);
        // CRACK THE KEEP: towers down but the HQ still seals the flag → siege is the ONLY
        // way to open the win. The old cascade had a dedicated rung for this; without this
        // term a dominant turtle sat home forever with the enemy base defenceless (seed 88:
        // k11, towers flattened, defend 3.5 > siege 2 for 900 straight seconds).
        if (cmd.fortDown && cmd.fortDown() && !exposed) add('crack the keep', 4);
      }
      break;
    case 'capture': {
      if (!exposed) add('flag sealed', -10);
      else add('flag OPEN', 4);   // the win condition is on the table — outweigh routine fighting
      if (cmd.flagGrabbable()) add('grabbable', 2);
      const dir = key.includes('-') ? key.split('-')[1] : 'front';
      add('towers down ' + dir, (cmd.towersDownDir ? cmd.towersDownDir(dir) : Math.min(2, 4 - towers)) * 1);
      // fog-honest lane intel: +1 only for a lane we've had eyes on and know is empty; a lane
      // with a KNOWN contact on it is actively repelling; unscouted = neutral (earn it by scouting)
      if (cmd.laneIntel) { const li = cmd.laneIntel(dir); if (li === 'clear') add('lane clear', 1); else if (li === 'blocked') add('lane blocked', -2); }
      if (spareFB >= 0.1) add('spare FB', spareFB); break;
    }
    case 'defend': {
      if (cmd.homeAttack && cmd.homeAttack()) add('base under fire', 4);
      // gradual, but RE-ANCHORED to the proven operating point: the old rule only turtled at
      // a deficit of 3 — starting the lean at 1 made every slightly-behind team cagey and gave
      // back five head-to-head wins. Now: down 2 → +1, down 3 → +2, down 4+ → +3 (capped).
      const deficit = cmd.fleetDeficit ? cmd.fleetDeficit() : 0;
      if (deficit >= 2) add('losing', Math.min(3, (deficit - 1) * 1)); break;
    }
    case 'intercept':
      add('base', -5);
      if (cmd.ourFlagStolen()) add('flag STOLEN', 12);
      else if (cmd.ourFlagLoose && cmd.ourFlagLoose()) add('flag loose', 10); break;
    case 'scavenge':
      if (cmd.needsPartsRun && cmd.needsPartsRun()) add('need parts', 4); break;
    case 'sap':
      if (earlyB >= 0.1 && spareFB >= 0.5) add('opening sap', earlyB); break;
    case 'trap':
      if (arch === 'hunter' && cmd._trapMode && !cmd._trapDone) add('trap ready', 2); break;
  }
  // fleet-comp (play to strength) — a bare fav ('capture') covers all its directions
  for (const t in FLEET_FAV) {
    const [fav, thr] = FLEET_FAV[t];
    if (fav === key || (fav === base && key !== 'siege-back')) { const b = ((roster[t] || 0) / fleet - thr) * 10; if (b > 0) add('fleet ' + t[0].toUpperCase(), b); }
  }
  // persona bias: the exact key's nudge plus the base key's (so rogue's capture +1 applies to
  // every direction, and its capture-rear +1 stacks on top of that for the back door)
  const PB = PERSONA_BIAS[arch] || {};
  if (PB[base] && base !== key) add(arch, PB[base]);
  if (PB[key]) add(arch, PB[key]);
  // success memory (the anti-repeat): a just-failed mission sits at −4, drifts back to 0.
  // Directional captures each carry their OWN memory — "front failed" leaves rear untouched.
  const s = cmd._missionSuccess && cmd._missionSuccess[key]; if (s) add('success', s);
  // affordability: a capture with no runner and no scrap to build one can't execute
  if (base === 'capture' && (roster.firebrat || 0) === 0 && !cmd.canAfford('firebrat')) add('no runner', -6);
  return { total: Math.round(w * 10) / 10, terms: T };
}

// Pick the top-scoring mission. The success memory decays +1 every 8 SECONDS (not per call —
// missionPick runs every tick, so a per-call decay let a −4 recover in a fifth of a second
// and the anti-repeat barely bit; a failed plan should stay benched for ~half a minute).
export function missionPick(cmd, incumbent = null) {
  const S = cmd._missionSuccess || (cmd._missionSuccess = {});
  // success memory forgives CONTINUOUSLY (+1 per 8s, smooth — the gradual-weights rule),
  // so a benched plan eases back into contention instead of stepping.
  const t = cmd._matchT || 0;
  if (cmd._msnDecayT == null) cmd._msnDecayT = t;
  const el = Math.max(0, t - cmd._msnDecayT); cmd._msnDecayT = t;
  // Decay is SLOW on purpose (Jacob: a failed mission shouldn't be repeated over and over) — a
  // benched plan eases back over ~half a minute per point, so a deep −14 stays out most of the
  // match unless the board genuinely changes. (Was +1/8s, which recovered before the next runner
  // even died — the anti-repeat barely bit.)
  if (el > 0) for (const k in S) { S[k] = Math.min(0, Math.round((S[k] + el * 0.033) * 100) / 100); if (S[k] > -0.05) delete S[k]; }
  let best = null, bestV = -1e9; const all = [];
  for (const key of MSN_CANDS) {
    const r = missionScore(cmd, key);
    // INCUMBENT BONUS: the running plan is worth +1.5 just for being underway — near-tied
    // scores must not flap the commander between missions every few seconds (autopsy: a
    // siege↔scavenge↔attack cycle at 4-6s). A challenger has to genuinely beat the plan.
    if (incumbent && key === incumbent) { r.total = Math.round((r.total + 1.5) * 10) / 10; r.terms.push(['running', 1.5]); }
    all.push([key, r.total, r.terms]);
    if (r.total > bestV) { bestV = r.total; best = key; }
  }
  all.sort((a, b) => b[1] - a[1]);
  cmd._missionScores = all;   // exposed for the ai-lab console breakdown
  cmd._missionTop = bestV;
  return best;
}
// One-line troubleshooting breakdown of the current decision (top 3 with their term math).
export function missionScoreLog(cmd) {
  const a = cmd._missionScores; if (!a) return '';
  return a.slice(0, 3).map(([k, v, terms]) =>
    `${k} ${v >= 0 ? '+' : ''}${v}${terms.length ? ' (' + terms.map(([l, x]) => `${l} ${x >= 0 ? '+' : ''}${x}`).join(', ') + ')' : ''}`).join('  >  ');
}

class Doctrine {
  constructor(rng = Math.random, log = null) {
    this.rng = rng; this.log = log; this.t = 0;
    this.mission = makeMission(this.opening);   // persona opening; a sapper sortie may preempt it (see tick, _sapOn)
    this.mission.enter(null, this);
    this.step = this.mission.key;
  }
  role(key) { return this.roles[key] || this.roles.attack || 'lurcher'; }
  tick(cmd, dt) {
    this.t += dt;
    this.mission.tick(cmd, dt);
    if (cmd._sapOn === undefined) {   // one-time roll: does this commander open with a sapper sortie?
      cmd._sapOn = this.rng() < (SAP_CHANCE[cmd.archetype] ?? 0.35);
      cmd._sapSide = this.rng() < 0.5 ? 1 : -1;   // which flank to sap — rolled per match (was hardcoded per team)
      // A HUNTER that saps may turn it into a baited TRAP: mines on the lane + a Lurcher that lures.
      cmd._trapMode = cmd.archetype === 'hunter' && cmd._sapOn && this.rng() < 0.7;
      if (!cmd._sapOn) cmd._sapDone = true;
    }
    if (this.step === 'sap' && this.mission.t > SAP_BUDGET) cmd._sapDone = true;   // sortie ran long — move on
    // The trap ends when its mines are spent (blew/cleared) or after a budget → resume normal play.
    if (this.step === 'trap' && ((cmd.trapSpent() && this.mission.t > 8) || this.mission.t > TRAP_BUDGET)) cmd._trapDone = true;
    if (cmd._clearPathT > 0) cmd._clearPathT -= dt;   // countdown: clearing a downed runner's interceptor
    if (cmd._softenT > 0) cmd._softenT -= dt;         // countdown: silencing the towers that keep killing runners
    if (cmd._softenT > 0 && cmd.fortDown && cmd.fortDown()) cmd._softenT = 0;   // towers are down — job done, go grab
    // Every forced transition carries a WHY — it's appended to the switch log so a mission
    // change always reads as decision + reason, not just a new battle cry out of nowhere.
    let next = this._urgent(cmd);
    // Two flavours of the same emergency: a live thief carrying it (chase) vs the thief died
    // and the flag's lying loose in the field (drive over and touch it home before their next
    // runner re-grabs it mid-field — far closer than our base).
    const loose = next && !cmd.ourFlagStolen();
    let why = next ? (loose ? 'our flag is lying in the field — recover it before they re-grab' : 'our flag is on the move — run the thief down') : null;
    let fk = next ? (loose ? 'flag_loose' : 'flag_stolen') : null;   // which doctrine rung justified the decision (ai-lab decision-path)
    // PRESERVATION (any persona): losing the attrition war → hold under tower cover instead
    // of trading the last of the army out in the open — UNLESS we can win right now by
    // grabbing an exposed flag. Sits above the persona's own plan so every archetype turtles
    // up when it's getting wiped, then resumes its doctrine once it's back on even footing.
    if (!missionWeightsOn(cmd) && !next && cmd.losingBadly && cmd.losingBadly() && !cmd.flagGrabbable()) { next = 'defend'; why = 'losing the attrition war — preserving what we have left'; fk = 'losing_attrition'; }   // (weights: the 'losing +2' defend term carries this — a hard lock stalemated mirror matches)
    // HOME UNDER ATTACK (persona-weighted): enemy rounds are hitting our structures. The
    // tower's radio call used to be consumed only by a commander ALREADY in defend, so any
    // offense-minded persona simply never heard it: a Hunter idled at a stale mid-field goal
    // for 141s while a lone valkyrie levelled its whole main base (census seeds 151/123 —
    // 187s/234s zero-kill stomps). But an ALWAYS-enforced retreat would be its own exploit
    // (poke a tower every few seconds and the enemy commander yo-yos home forever) and it
    // outlaws the base RACE — a legitimate play. So it's a dice roll per raid window,
    // weighted by who the commander IS: a turtle always turns back, a rogue almost never
    // breaks off its own attack. And a commander whose assault is about to pay off (their
    // towers down / keep cracked / flag grabbable) stays committed regardless of the dice —
    // winning the race beats saving towers.
    if (!next && cmd.homeAttack && cmd.homeAttack()
        && !cmd.flagGrabbable() && !(cmd.fortDown && cmd.fortDown()) && !cmd.flagExposed()) {
      const now = performance.now();
      if (!cmd._homeRollAt || now - cmd._homeRollAt > 25000) {   // one decision per raid window, not per tick (mood can shift on the next window)
        cmd._homeRollAt = now;
        cmd._homeRollGo = this.rng() < (HOME_RESPONSE[cmd.archetype] ?? 0.6);
        if (!cmd._homeRollGo && this.log) this.log(`They're shelling our base — let them! We finish THEIRS first.`);
      }
      if (cmd._homeRollGo) { next = 'defend'; why = 'our base is under fire — get back there and stop them'; fk = 'home_under_fire'; }
    }
    // FIND PARTS: we can win by capture but have no runner and can't afford to build one →
    // go collect salvage until we can. Beats the siege press below (cracking the HQ is moot
    // without a firebrat to actually grab the exposed flag).
    if (!missionWeightsOn(cmd) && !next && cmd.needsPartsRun && cmd.needsPartsRun()) { next = 'scavenge'; why = 'no runner left and no parts to build one'; fk = 'need_parts'; }
    // DEFENSES BREACHED: the enemy's towers are down but their keep still stands → COMMIT to
    // siege and finish the HQ (which exposes the flag), instead of orbiting a defenceless base
    // dueling their leftover units. Without this, Hunter-type doctrines only siege on full
    // elimination, so a flyer circled a defenceless base for 150s with the HQ at full HP (trace).
    if (!missionWeightsOn(cmd) && !next && cmd.fortDown && cmd.fortDown() && !cmd.flagExposed()) { next = 'siege'; why = 'their towers are down — crack the HQ while it is open'; fk = 'towers_down'; }
    // STALEMATE GAMBIT: the match dragged on with the enemy base untouched — stop grinding the
    // mid-field duel and commit to the "Valkyrie around the back" siege (the Siege mission reads
    // cmd._gambit to force the flyer + rear flank, and rushBase suppresses engaging en route).
    if (!missionWeightsOn(cmd) && !next && cmd.gambitOn && cmd.gambitOn() && !cmd.flagGrabbable()) { next = 'siege'; why = 'stalemate — committing to the rear-door gambit'; fk = 'gambit'; }   // …but the instant the HQ's cracked and the flag's grabbable, let choose() send the runner to CAPTURE it
    // A capture runner was gunned down by an enemy VEHICLE → hunt the interceptor down before
    // feeding another firebrat into it (timed, so it doesn't chase forever).
    if (!missionWeightsOn(cmd) && !next && cmd._clearPathT > 0) { next = 'attack'; why = 'clearing the runner’s killer before the next attempt'; fk = 'clear_path'; }
    // Tower-soften window (see onRunnerLost): the towers keep shredding runners → hold SIEGE
    // until they're silenced, instead of rebuilding a firebrat into the same guns each lap.
    if (!missionWeightsOn(cmd) && !next && cmd._softenT > 0) { next = 'siege'; why = 'towers keep killing the runner — silencing them before the next attempt'; fk = 'soften'; }
    // OPENING SAPPER (persona-rolled): a Firebrat out to a home flank — lay mines on the way back,
    // drop a pod, scout that side — then fall through to the persona's real playbook.
    if (!missionWeightsOn(cmd) && !next && cmd._sapOn && !cmd._sapDone) { next = 'sap'; why = 'opening sapper — flank recon + mines'; fk = 'sapper'; }
    // HUNTER TRAP: once the trap's mined, tend it with a bait Lurcher until it's sprung/spent.
    if (!missionWeightsOn(cmd) && !next && cmd._trapMode && cmd._sapDone && !cmd._trapDone) { next = 'trap'; why = 'tending the mine trap — luring them in'; fk = 'trap'; }
    if (!next) {
      if (missionWeightsOn(cmd)) {
        // MISSIONSCORE: the weighted picker owns the whole offensive/economy plan (the
        // fortDown/gambit/soften/clearPath/scavenge/sap/trap rungs above are gated off when
        // weights are on — the success memory + siege/scavenge terms subsume them, and killing
        // the soften/clearPath loop is the seed-116 fix). Only the flag emergency (_urgent) and
        // home-defense still hard-preempt.
        const runningKey = (cmd._msnKey && cmd._msnKey.split('-')[0] === this.step) ? cmd._msnKey : this.step;
        next = missionPick(cmd, runningKey); why = 'mission weights'; fk = 'weights';
        // Directional keys map onto the base missions: 'capture-rear' runs the Capture mission
        // approaching from the rear (cmd._capDir routes the runner); 'siege-back' runs Siege
        // with the rear-tower bias (cmd._siegeBack gates the tower hunt).
        cmd._msnKey = next;
        if (next.startsWith('capture-')) { cmd._capDir = next.slice(8); next = 'capture'; }
        else cmd._capDir = null;
        cmd._siegeBack = next === 'siege-back';
        if (next === 'siege-back') next = 'siege';
      } else {
        // L2 mission net (opt-in policy): stands in for the persona playbook's choose() —
        // the urgent/universal rungs above and the dwell + report-card bans below still apply.
        const l2 = cmd.l2Pick ? cmd.l2Pick() : null;
        if (l2) { next = l2; why = 'the L2 mission net'; }
        else { next = this.choose(cmd); why = `the ${this.constructor.name} playbook`; }
        fk = 'choose';
      }
    }
    // REPORT CARD: the picked mission just cost two units in a row with nothing to show —
    // don't repeat the bad decision; run its unblocker. Superseded by the success memory when
    // MissionScore is on, so skip it there.
    if (!missionWeightsOn(cmd) && next && cmd.missionBanned && cmd.missionBanned(next)) {
      const alt = FAIL_ALT[next];
      if (alt && !cmd.missionBanned(alt)) { why = `${next} is benched — two units lost on it for nothing`; next = alt; fk = 'benched'; }
    }
    this._firedRung = fk;   // ai-lab decision-path: which rung justified the current decision this tick
    // Switch on dwell, on an urgent mission, OR (weights) when a fresh event has spiked the
    // pick decisively past the running mission — so an exposed flag / lost unit re-decides now
    // instead of waiting out the dwell.
    const curKey = (cmd._msnKey && cmd._msnKey.split('-')[0] === this.step) ? cmd._msnKey : this.step;   // the RUNNING plan's full scored key
    const decisive = missionWeightsOn(cmd) && next !== this.step && (cmd._missionTop != null) && (cmd._missionTop - (missionScore(cmd, curKey).total) >= 4);
    // Weights re-think on a calmer clock (8s) than the classic cascade's 1.5s — the incumbent
    // bonus + this dwell kill the flapping; a DECISIVE score jump (an event spike: flag opened,
    // runner died) still switches immediately.
    const dwell = missionWeightsOn(cmd) ? 8 : DWELL;
    if (next && next !== this.step && (this.t > dwell || URGENT.has(next) || decisive)) this._switch(next, cmd, why);
  }
  // Emergencies that preempt any persona's plan: our flag's been lifted → run it down;
  // the thief died and dropped it in the field → go RECOVER it (any teammate's touch snaps
  // it home). Both waived when WE'RE carrying the enemy flag home — don't blow a winning run.
  _urgent(cmd) {
    if (cmd.flag() && cmd.flag().carrier === cmd.unit) return null;
    if (cmd.ourFlagStolen()) return 'intercept';
    if (cmd.ourFlagLoose && cmd.ourFlagLoose()) return 'intercept';
    return null;
  }
  _switch(key, cmd, why = null) {
    if (!key || key === this.step) { this.t = 0; return; }
    const from = this.step;
    this.mission = makeMission(key);
    this.mission.enter(cmd, this);
    this.step = key; this.t = 0;
    if (why) this._lastWhy = why;   // keep the last meaningful reason (for the ai-lab live overlay)
    // Radio-chatter order + a machine-readable decision trail: the cry() supplies the
    // characterful line, the bracket names the transition and WHY it happened, so every
    // mission change in the log is auditable (from → to — reason).
    if (this.log) this.log(`${this.mission.cry(cmd)}   [${from} → ${key}${why ? ' — ' + why : ''}]`);
    if (this.log && missionWeightsOn(cmd)) { const bd = missionScoreLog(cmd); if (bd) this.log(`  ↳ ${bd}`); }   // MissionScore troubleshooting breakdown
  }
  // Runner died storming the base → respond to WHY, instead of feeding another firebrat down
  // the same lane. Shot by an enemy VEHICLE → send an ATTACK to clear the interceptor first
  // (timed window). Shot by TOWERS on the approach → retry as a STEALTH capture: a wide rear
  // route around the hot zone (the flag's still grabbable, just not head-on).
  onRunnerLost(cmd, enemyHasUnits) {
    if (missionWeightsOn(cmd)) {
      // MISSIONSCORE: a dead runner is a FAILED capture. The penalty ESCALATES with each loss so
      // the commander can't feed six runners into the same guns (Jacob: don't repeat a mistake).
      if (!cmd._missionSuccess) cmd._missionSuccess = {};
      const n = cmd._runnerLosses = (cmd._runnerLosses || 0) + 1;
      const pen = -Math.min(16, 4 + 5 * n);   // −9, −14, −16… escalating (enough to unseat an OPEN-flag capture at +13.9)
      const failedKey = (cmd._msnKey && cmd._msnKey.startsWith('capture-')) ? cmd._msnKey : 'capture-front';
      if (enemyHasUnits) {
        // DEFENDERS are the problem, not the lane — bench ALL capture directions and flag a window
        // that boosts ATTACK (go clear the interceptors), then resume the grab once they're gone.
        for (const k of ['capture', 'capture-front', 'capture-left', 'capture-right', 'capture-rear']) cmd._missionSuccess[k] = pen;
        cmd._runnerInterceptT = cmd._matchT;
      } else {
        // Pure tower gauntlet → bench just THIS lane so the next runner tries a different route
        // (the wide/rear arc), the other lanes keep their own records.
        cmd._missionSuccess[failedKey] = pen;
      }
      // VISIBILITY (Jacob): show the re-evaluation after EVERY runner death — the switch-log only
      // fires on a mission CHANGE, so a commander re-deciding "capture again" was silent. Now the
      // penalized scores print each death, so you can watch capture drop and attack climb.
      if (cmd.strategy && cmd.strategy.log) { const bd = missionScoreLog(cmd); if (bd) cmd.strategy.log(`  ↳ runner lost (×${n}) — ${bd}`); }
      this.t = DWELL + 1;   // let the very next tick re-decide (event: our runner just died)
      return;
    }
    if (RUNNER_MODE === 'old') { this._switch(this.softenKey, cmd); return; }   // A/B baseline: blind re-siege
    // Defenders still alive → switch to ATTACK NOW (so the NEXT deploy is a fighter, not
    // another firebrat) and hold it there for a window to clear them, then resume the grab.
    // No defenders left (pure tower gauntlet) → sneak in on a wide route instead.
    cmd._runnerLosses = (cmd._runnerLosses || 0) + 1;
    if (enemyHasUnits) {
      // Escalating clear-window: 18s was never enough to actually hunt the interceptor down, so
      // capture↔attack cycled every ~100s, feeding a runner into the same guns each lap
      // (richwatch MISSION-FLAP). Each lost runner buys a LONGER clearing phase before the next
      // attempt — the retry rate decays instead of hammering.
      cmd._clearPathT = Math.min(60, 18 * cmd._runnerLosses);
      this._switch('attack', cmd, `runner intercepted — clear the defenders first (${cmd._clearPathT | 0}s sweep)`);
    }
    // Pure tower gauntlet (no enemy vehicles left): stealth ONCE — a wide route sometimes
    // slips the back towers for free. But if the towers keep killing runners, stop feeding
    // them (seed 137: a fresh firebrat rebuilt and shredded every ~30s for 800s while two
    // jotuns idled in the garage) and ESCALATE: force a timed SIEGE window so a real sieger
    // silences the remaining towers before the next grab attempt.
    else if (cmd._runnerLosses >= 2 && cmd.turretsLive() > 0) {
      cmd._softenT = Math.min(90, 30 * cmd._runnerLosses);
      this._switch('siege', cmd, `the towers keep shredding our runners — silencing them first (${cmd._softenT | 0}s)`);
    }
    else cmd._stealthCapture = true;
  }
  get softenKey() { return 'siege'; }
  // --- interface the commander consumes (delegated to the running mission) ---
  wantVehicle(cmd) { return this.mission.wantVehicle(cmd); }
  objective(cmd) { return this.mission.objective(cmd); }
  shoot(cmd) { return this.mission.shoot(cmd); }
  arriveDist(cmd) { return this.mission.arriveDist(cmd); }
  lurePoint(cmd) { return this.mission.lurePoint ? this.mission.lurePoint(cmd) : null; }     // trap kite anchor (view.lure)
  signalShot(cmd) { return this.mission.signalShot ? this.mission.signalShot(cmd) : null; }  // trap noise-bait aim point
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
    // Recon UNTIL we've found them OR the field is mostly mapped — the fraction backstop stops a
    // Hunter idling in 'scout' with its Valkyrie parked once there's nothing left to reveal.
    if (!cmd.knowsEnemy() && cmd.explore.fraction() < 0.8) return 'scout';
    // HUNT what roams; HARASS what hides. A fresh contact out in the FIELD is prey —
    // chase it. No contact at all, or a contact hugging their own base (dug in behind
    // the guns — chasing it is a siege we didn't sign up for), means the open field is
    // ours: go make their half loud instead. Every poke drags defenders to where we
    // WERE, and flushes the reveals the hunt feeds on.
    if (HUNTER_HARASS) {
      const p = cmd.lastEnemyPos();
      if (!p) return 'harass';
      const en = cmd.enemyBasePos();
      if ((p.x - en.x) ** 2 + (p.z - en.z) ** 2 < 70 * 70) return 'harass';
    }
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
    // The "proved ourselves -> push" gate counts THIS GUARD's kills (cmd._kills, per slot),
    // not the team total — under multi-unit the team's 2nd kill lands inside the first
    // minute, which flipped every turtle to siege almost immediately (the dataset's
    // "turtles" were mostly siegers in a defense-spec hull). And guards WIN their duels
    // (tower cover), so personal kills alone still flipped them fast — the push also
    // requires the enemy fleet to actually be beaten down (press from strength; a guard
    // holding an even fight keeps holding).
    const proved = TURTLE_GUARD
      ? (cmd._kills || 0) >= 2 && cmd.enemyWeaker && cmd.enemyWeaker()
      : cmd.kills >= 2;
    if (proved || cmd.enemyEliminated()) return 'siege';
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
