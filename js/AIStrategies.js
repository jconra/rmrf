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
const TRAP_SET_R = 20;    // u from the anchor that counts as ACTUALLY in ambush — the clock and the
                          // signal shots both wait for this, so neither runs from inside our own base
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
      // THE NO-SHOW CLOCK ONLY RUNS ONCE THE AMBUSH EXISTS. It used to start with the mission, so
      // a hunter still inside its own FOB reached the `signal` phase without ever taking up
      // position — and a signal shot is aimed 30u toward the enemy base from wherever the unit
      // happens to stand, which from inside your own walls is your own gate. Jacob watched one do
      // exactly that: "Rolling out the gate — set in ambush behind the trap!" and then shooting
      // its own wall. "Nobody came" is a statement about a trap that is SET, not about time
      // passing, and the signal is bait that only means anything from the kill zone.
      const v = cmd.unit, a = cmd.trapAnchor && cmd.trapAnchor();
      const set = !!(v && !v.dead && a
        && (v.holder.position.x - a.x) ** 2 + (v.holder.position.z - a.z) ** 2 < TRAP_SET_R * TRAP_SET_R);
      if (!set) { this._phase = 'anchor'; return; }   // still on our way — go and set it first
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
    if (cmd._capDir && cmd.unit && cmd.enemyRoute) {
      const u = cmd.unit.holder.position;
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
    // Both `atk` and `p` are raw remembered coordinates (a tower's radio call, a sighting) with
    // NO reachability guarantee anywhere in this function — traced tonight (seed 130) to a unit
    // sent straight at homeAttack()'s raw position across open water, stranded for 164s with no
    // error/log anywhere in this path. Logging every branch so that's visible if it happens again.
    const atk = cmd.homeAttack();                 // our structures are being SHOT — beats hearing range
    if (atk) {
      dlog2(`defendObjective:${cmd.team}`, { unit: cmd.unit ? cmd.unit.type : null, x: +atk.x.toFixed(0), z: +atk.z.toFixed(0) },
        `${cmd.cname}: Defend objective = homeAttack() raw position (no reachability check).`);
      return atk;
    }
    const p = cmd.lastEnemyPos();                 // seen OR heard contact (team intel, ~12s fresh)
    if (p) {
      const home = cmd.homeBasePos(), en = cmd.enemyBasePos();
      const dh = (p.x - home.x) ** 2 + (p.z - home.z) ** 2, de = (p.x - en.x) ** 2 + (p.z - en.z) ** 2;
      if (dh < de) {
        dlog2(`defendObjective:${cmd.team}`, { unit: cmd.unit ? cmd.unit.type : null, x: +p.x.toFixed(0), z: +p.z.toFixed(0) },
          `${cmd.cname}: Defend objective = lastEnemyPos() on our half (no reachability check).`);
        return p;                      // on OUR half → run it down; their half = bait, hold the lane
      }
    }
    // QUIET WATCH = MAINTENANCE TIME: nothing shooting us, nothing on our half → top the
    // hull at home before resuming the lane (guards fight at whatever they carry in; a
    // fresh guard wins the duels a worn one loses). Any contact above pre-empts this.
    if (TURTLE_GUARD && cmd.unit && cmd._home && cmd.unit.hp < cmd.unit.maxHp * 0.85) {
      dlog2(`defendObjective:${cmd.team}`, { unit: cmd.unit.type, hpFrac: +(cmd.unit.hp / cmd.unit.maxHp).toFixed(2) },
        `${cmd.cname}: Defend objective = home (quiet watch, topping off — hp below 85%).`);
      return cmd._home;
    }
    dlog2(`defendObjective:${cmd.team}`, { unit: cmd.unit ? cmd.unit.type : null },
      `${cmd.cname}: Defend objective = patrolSpot() (nothing shooting us, nothing on our half).`);
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

// ---- SUPPLY MISSIONS — the first slice of the flattened decision stack ----------------
// Topping up used to live one layer down, as rungs on the brain's priority ladder in AI.js,
// each with its own trip condition rebuilt every tick. That is where the thrash lived: the
// number deciding "do I want fuel" was the number the pump pushed past, so a unit stopped
// wanting the thing the moment it started getting it, walked away, and un-got it. See
// devblog/2026-08-05-one-mission-layer.md.
//
// As MISSIONS they get an ending for free: a mission runs until it is done, and `done()` here
// means FULL — not "no longer starving". Their scores (in missionScore) hold up while they are
// the running mission, which is the latch expressed as a weight rather than a boolean, so a
// real emergency can still outbid them instead of being locked out.
//
// `supplyWant` tells main.js's _view WHICH kind of source to route to, so the depot choice is a
// consequence of the mission we are on rather than a per-tick re-derivation off raw levels
// (which is what made a unit shuttle between the fuel dump and the ammo dump forever).
// RE-ANCHORED to the operating points the brain's own latches already used, so this slice moves
// WHERE the decision is made without also moving WHEN it fires: fuelLow 0.18 and bailBase 0.45
// are lifted straight from AI.js's config. Guessing new numbers here would have confounded the
// refactor with a balance change and made the measurement unreadable.
// HOW MUCH OF THE RUNNING PLAN IS ALREADY PAID FOR — the incumbent bonus, weighted by travel.
// A unit on the pad has invested nothing and should change its mind freely; a unit at the enemy
// fort has spent most of a sortie getting there and a near-tie should not throw that away.
const INCUMBENT_BASE = 1.0;   // just for being underway, anywhere
const INCUMBENT_MAX = 3.0;    // …rising to this at the objective
// Supply missions are exempt from the SCALING (they keep the base): a unit is on refuel BECAUSE
// it is nearly dry, and rewarding it for having driven a long way to the pump would make the
// worst case — out of fuel, far from home — the hardest one to interrupt.
const INCUMBENT_FLAT = { refuel: 1, rearm: 1, repair: 1, armour: 1 };
// HOW FAR OUT THE UNIT IS — 0 at the pad, 1 at the enemy base. Shared by BOTH distance terms so
// they can never drift onto different scales: the incumbent bonus (what the running plan has
// already spent getting here) and requiredVehicle's recall cost (what a chassis change would
// spend driving home and back out). They are opposite halves of the same question.
export function travelFraction(cmd) {
  const v = cmd.unit;
  if (!v || v.dead || !v.holder) return 0;
  let home, away;
  try { home = cmd.homePos(); away = cmd.enemyBasePos(); } catch (e) { return 0; }
  if (!home || !away) return 0;
  const span = Math.hypot(away.x - home.x, away.z - home.z);
  if (!(span > 1)) return 0;
  const p = v.holder.position;
  return Math.max(0, Math.min(1, Math.hypot(p.x - home.x, p.z - home.z) / span));
}
// INBOUND MISSIONS RUN THE OTHER WAY. travelFraction is distance from HOME, so for an outbound job
// (siege, capture, attack) it rises as the sortie is spent — which is what incumbency wants. Swap
// and Flee are trips TO the pad, so the same number FALLS as they near completion, and a swap that
// is 90% home ends up cheaper to interrupt than one that just set off. Exactly backwards, and it is
// why a third of swaps were abandoned once the terminal guards came off: the closer a unit got to
// solving everything at once (fresh hull = full fuel, ammo and armour), the easier it was to steal.
// Measured under ?flat: 26 swaps lost to the home-defence recall and ~30 more to rearm/repair —
// missions that interrupted a trip home in order to go home.
// For these, invested fraction is 1 - travelFraction. Same weight, correct in both directions.
const INCUMBENT_INBOUND = { swap: 1, flee: 1 };
export function incumbentBonus(cmd) {
  const key = (cmd._msnKey || '').split('-')[0];
  if (INCUMBENT_FLAT[key]) return INCUMBENT_BASE;
  const v = cmd.unit;
  if (!v || v.dead || !v.holder) return INCUMBENT_BASE;
  let f = travelFraction(cmd);
  // TEST THE RUNNING MISSION, NOT _msnKey. Swap and Flee are SUPPORT missions, and _applyKey only
  // moves _primaryKey for non-support ones — so mid-swap _msnKey can still read `capture-right`,
  // the job underneath. Keying the inbound test off it meant the lookup never matched and the flag
  // was completely inert: its 240-seed arm came back byte-identical to base on every metric,
  // including the swap counters it was supposed to move. `strategy.step` is the mission actually
  // running, which is what incumbency is pricing.
  // INERT UNTIL SWAP IS A SCORED CANDIDATE — measured, not assumed. Two 240-seed arms came back
  // byte-identical to base on every metric including the swap counters, because `swap` is not in
  // MSN_CANDS, and missionPick only applies the bonus when `key === incumbent`. So a running swap
  // is never scored, never gets an incumbent bonus, and cannot defend itself: any candidate that
  // scores anything beats it. The terminal `return` was not A protection for swap, it was the ONLY
  // one — which is why a third of swaps are abandoned once ?flat removes it. See task #33.
  // The direction below is still correct and stays; it starts mattering the moment swap is scored.
  const running = (cmd.strategy && cmd.strategy.step) || '';
  if (INCUMB_DIR && INCUMBENT_INBOUND[running]) f = 1 - f;
  return Math.round((INCUMBENT_BASE + (INCUMBENT_MAX - INCUMBENT_BASE) * f) * 10) / 10;
}
let SWAP_SUPPLY = false;  // a running swap suppresses refuel/rearm/repair/armour (A/B knob)
export function setSwapSupply(on) { SWAP_SUPPLY = !!on; return SWAP_SUPPLY; }
let INCUMB_DIR = false;   // incumbency counts an inbound trip's progress correctly (A/B knob)
export function setIncumbDir(on) { INCUMB_DIR = !!on; return INCUMB_DIR; }
export const SUPPLY_LOW = { fuel: 0.18, ammo: 0.25, hp: 0.45, shield: 0.6 };   // start wanting it…
export const SUPPLY_FULL_F = 0.95;                                             // …and stay until this full
// How hard each shortage pulls at its worst (empty). Fuel leads: a dry tank is a dead unit, not
// merely a weak one. Armour is the softest — worth a detour, never worth a crisis.
// hp: 10 and NEAR_MAX 4 come from a 1200-match head-to-head over a 4x range of both knobs
// (2026-08-07). The honest result was a NULL one — every config landed inside 48.6%-51.6%, which
// at ~400 games each is noise, so win rate cannot pick between them. These are chosen on BEHAVIOUR
// instead: the strongest near/far contrast, which is the design goal (heal to full standing at the
// fob; do not cross the map for it until genuinely low). Do not read the numbers as tuned optima.
const SUPPLY_URGE = { fuel: 9, ammo: 6, hp: 10, shield: 3 };
// The curve. A plain linear ramp from the low line is nearly zero just under it, so the mission
// could never get STARTED — it would only become winnable once the unit was already in trouble,
// and "finish the job" only applies to a mission already running. The square root bites early
// and screams late: ~30% of full urge as soon as we dip under the line, all of it at empty. No
// step at the threshold, which is the house rule.
const supplyUrge = (frac, low, urge) => urge * Math.sqrt(Math.max(0, 1 - frac / low));
// 1 at NEAR_FAR or beyond, rising to NEAR_MAX standing on the base. Gradual on purpose — the
// house rule is that a term scales with how true its condition is rather than stepping at a line.
const NEAR_MAX = 4, NEAR_FAR = 140;
// PER-TEAM OVERRIDES, so one weight set can be played against another IN THE SAME MATCH and then
// the sides flipped — which is the only way to see which is actually better rather than which does
// better against a fixed opponent. Same shape as RR.setFof for the fight-or-flight weights.
const teamSupplyW = {};
export function setSupplyW(team, w) {
  teamSupplyW[team] = { ...(teamSupplyW[team] || {}), ...w };
  return teamSupplyW[team];
}
export function supplyWOf(team) { return teamSupplyW[team] || null; }
function supplyNearness(cmd) {
  const v = cmd.unit; if (!v || v.dead || !cmd._home) return 1;
  const w = teamSupplyW[cmd.team] || null;
  const nearMax = w && w.nearMax != null ? w.nearMax : NEAR_MAX;
  const nearFar = w && w.nearFar != null ? w.nearFar : NEAR_FAR;
  const p = v.holder.position;
  const d = Math.hypot(p.x - cmd._home.x, p.z - cmd._home.z);
  const t = Math.max(0, 1 - d / nearFar);
  return 1 + (nearMax - 1) * t;
}
const fracOf = (cmd, what) => {
  const v = cmd.unit; if (!v || v.dead) return 1;
  if (what === 'fuel') return v.maxFuel ? v.fuel / v.maxFuel : 1;
  if (what === 'ammo') return v.maxAmmo ? v.ammo / v.maxAmmo : 1;
  if (what === 'hp') return v.maxHp ? v.hp / v.maxHp : 1;
  return v.maxShield ? v.shield / v.maxShield : 1;
};
// SWAP — drive home and change vehicle. Formerly "the recall", which steered the unit itself via
// _driveHome and so bypassed the mission layer entirely: a second owner of the steering wheel that
// no mission could see and none could outrank. Jacob: "I don't like having things bypass the
// missions."
//
// What it cost as a bypass, measured over 240 seeds: 237 recalls armed and then gave up, and 212
// of those (89%) interrupted a unit that was already driving home on Flee. The collision is almost
// entirely on the default seed set — which is exactly the set where Flee underperforms, while the
// fresh set (3 collisions) came out FASTER than baseline. One seed showed a firebrat covering 128u
// in 40 seconds and finishing 0.8u from where it started, burning a whole tank, because its two
// owners pointed it opposite ways about once a second.
//
// The absurdity underneath: _wouldField substitutes an available chassis when the wanted one is
// out of stock, so a fleeing Firebrat with none left in the garage "wants" to be a Lurcher — and
// got recalled mid-escape to be swapped for one. As a mission this cannot happen: Swap runs only
// when the INCOMING mission asks for a different chassis, and a mission that says "keep what I am
// driving" is simply believed.
class Swap extends Mission {
  get key() { return 'swap'; }
  get garageOK() { return true; }            // the whole point is to reach the lift and change
  wantVehicle(cmd) { return this.want || (cmd.unit ? cmd.unit.type : 'lurcher'); }
  objective(cmd) { return cmd.homePos(); }
  shoot(cmd) { return false; }
  arriveDist(cmd) { return 6; }
  // Home, dead, or PROVEN UNABLE TO GET HOME. The last one is not a fallback — it is the event
  // the codebase already models as "waypoint proven unreachable", and `_driveHome` carried its own
  // version of it (RECALL_STALL) which I deleted with the rest of the recall and had to put back:
  // without it a unit that cannot reach the pad sits in `swap` forever. Seed 669 showed a single
  // swap lasting 547 seconds. A unit gets as long as it needs while it is still making ground —
  // a slow Jotun crawling across the map is fine, that is the game — and only zero progress for
  // SWAP_STALL counts as stuck. Any new closest-to-home resets the clock.
  tick(cmd, dt) {
    super.tick(cmd, dt);
    const v = cmd.unit; if (!v || v.dead) return;
    // THE CLOCK ONLY RUNS WHILE WE ARE ACTUALLY TRYING TO TRAVEL. `engaging` outranks `advance`,
    // so a unit that meets a rival on the way home stops closing on the pad — and a stall clock
    // that cannot tell STUCK from BUSY ditched a valkyrie mid-fight ten seconds after it switched
    // ("Working an angle on their turret" one second, gone the next). Fighting is a choice the
    // ladder made, not a failure of the trip: hold the clock while it lasts.
    const st = v._aiState;
    if (st === 'engage' || st === 'suppress' || st === 'pursue') { this.stallT = 0; return; }
    const p = v.holder.position, h = cmd.homePos();
    const d = Math.hypot(p.x - h.x, p.z - h.z);
    if (this.bestD == null || d < this.bestD - 0.5) { this.bestD = d; this.stallT = 0; }
    else this.stallT = (this.stallT || 0) + dt;
  }
  done(cmd) {
    const v = cmd.unit;
    if (!v || v.dead || cmd.atHomeBase()) return true;
    if ((this.stallT || 0) > SWAP_STALL) { this.ditched = true; return true; }
    return false;
  }
  label(cmd) { return `heading in to swap for a ${this.want || 'different vehicle'}`; }
  cry(cmd) { return pickCry(cmd, [
    `Wrong tool for this job — bringing it in for a ${this.want}!`,
    `Pulling back to the pad, we need a ${this.want} out here!`,
    `This isn't the vehicle for it. Coming home to switch!`,
  ]); }
}

// FLEE — the one way home, and the only mission that is never re-scored.
//
// Jacob's ruling (2026-08-07): a unit that loses the fight-or-flight call is by definition in no
// state to carry on doing what it was doing — hurt, dry, or outmatched — and base is where
// healing, fuel and ammo all are. So "run away", "limp home to patch up" and "the brain has
// judged this fight lost" are the SAME decision, and they get one owner. This replaces the
// brain's `_flee` latch, its `_hurt` latch feeding the retreat state, and fofBail. Three
// rulebooks for one judgement is the shape behind every flap this week.
//
// THE ROUTE IS FIXED AT THE MOMENT OF THE DECISION AND NEVER RECONSIDERED. That is the whole
// point. A plan that needs to see an enemy in order to exist evaporates and comes back every time
// the sighting flickers, and a destination changing fourteen times a second makes a unit spin on
// the spot instead of driving: measured at 881 goal changes in 64 seconds, throttle at zero 72%
// of the time, a 15-second run home stretched to 64 and two thirds of a tank burned.
//
//   1 BREAK AWAY   — square off the line between us and where the enemy WAS when we decided
//   2 STAGE BEHIND — a point out the far side of our own FOB
//   3 IN THE BACK  — through the gate nearest that point, and home
//
// A JOTUN NEVER FLEES (the brain refuses to raise the flag for one): it is far too slow to run
// and would only die with its back turned, so it stands and trades.
//
// For a Firebrat carrying the flag this is not a retreat at all. Capture is abandoned, but the
// destination is the same base, and an AI carrier scores on ARRIVAL — so fleeing is the backup
// plan that still wins the match.
// FIGHT — vehicle versus vehicle, the counterpart to Siege's vehicle versus tower gun.
// Until now a duel was invisible to the mission layer: `engage` is a STATE in AI.js's reflex
// layer, so a unit could pick a fight, win it, and the mission layer would never learn either
// happened. Seed 3362 is what that costs — a runner on capture-left was re-tasked to siege-back
// the instant an enemy appeared, killed that enemy three seconds later, and then died sieging a
// tower in a Firebrat, because the mission it was pulled onto had meanwhile earned its own
// incumbent bonus and the capture never came back.
//
// As a mission the duel becomes a thing that STARTS and ENDS, and the plan underneath survives it.
class Fight extends Mission {
  get key() { return 'fight'; }
  get garageOK() { return false; }            // decided in the field, mid-contact — never buy a hull for it
  wantVehicle(cmd) { return cmd.unit ? cmd.unit.type : this.doc.role('attack'); }   // fight with what we brought
  shoot(cmd) { return true; }
  arriveDist(cmd) { return 8; }
  enter(cmd, doc) {
    super.enter(cmd, doc);
    // Snapshot WHO we are fighting. The reflex layer re-picks its own target every tick — that is
    // its job — but the MISSION has to be about one opponent, or "is it over?" has no answer.
    // This used to snapshot a POINT, and that is the whole reason three gates of this mission
    // failed: a point cannot be killed, so `done` could not fire on a kill, and the point itself
    // was shared with hearing and with incoming fire, so an unrelated engine drone kept a finished
    // duel alive. Hold the vehicle.
    this.foeV = cmd.lastEnemyVeh ? cmd.lastEnemyVeh() : null;
    const s = cmd.lastEnemySeen && cmd.lastEnemySeen();
    this.foe = s ? { x: s.x, z: s.z } : null;
  }
  // THE FOE IS WHOEVER THE GUNS ARE ON (Jacob's ruling). Not a snapshot taken when the duel
  // opened: a second rival that closes to knife range while we chase the one that started it gets
  // to unload on us unopposed, so priority decides the target and the mission follows the target.
  //
  // Position still comes from the last SIGHTING, never from foeV.holder.position — that is the
  // live truth, and reading it would let a unit track an opponent it cannot see. So a foe that
  // breaks line of sight leaves its last known spot behind, which is exactly what "they got away"
  // has to be measured against.
  _acquire(cmd) {
    const t = cmd.lastEnemyVeh ? cmd.lastEnemyVeh() : null;
    if (t) {
      this.foeV = t;
      const s = cmd.lastEnemySeen && cmd.lastEnemySeen();
      if (s) { this.foe = { x: s.x, z: s.z }; this.foeT = s.t; }
    }
    return this.foeV;
  }
  objective(cmd) {
    // Where the fight is: refreshed while we have eyes on them so a pursuing unit keeps closing,
    // frozen at the last known spot once we lose them — which is what makes `done` fire on range
    // rather than on a flicker.
    this._acquire(cmd);
    return this.foe || cmd.enemyBasePos();
  }
  label(cmd) { return 'the rival in front of us'; }
  cry(cmd) { return pickCry(cmd, [
    'Contact! Break off and take them — everything else can wait!',
    'They picked the fight. Finish it!',
    'Enemy on us — guns front, deal with this first!',
  ]); }
  // OVER WHEN THEY ARE DEAD OR OUT OF REACH — never on losing sight (Jacob). A tree between two
  // vehicles is not the end of a battle; a rival that has opened the range beyond our gun has
  // genuinely escaped and chasing it is a different decision, taken by the scorer, not by this.
  // The 1.25 margin is hysteresis: without it a target dancing on the edge of reach toggles the
  // mission on and off, which is the flapping this whole layer exists to stop.
  done(cmd) {
    const v = cmd.unit; if (!v || v.dead) return true;
    // DEAD IS CHECKED BEFORE RE-ACQUIRING, and the order is the whole design. Acquiring first
    // would silently roll the duel onto the next body the moment we won, so a unit in a busy
    // midfield would never leave Fight and the plan underneath would never resume — that is
    // exactly the lock-in that doubled idle-at-goal in v3. The duel ENDS on the kill; the board
    // is re-scored; if somebody still qualifies, the next tick opens a fresh one.
    if (this.foeV && this.foeV.dead) return true;   // KILLING THEM ENDS IT (Jacob's first rule)
    if (!this._acquire(cmd)) return true;           // nobody to duel — a fight is vehicle vs vehicle
    // …OR THEY OPENED THE RANGE (Jacob's second rule), measured against where the opponent
    // ACTUALLY IS. Reading the live position here is not the wallhack it looks like, and the
    // distinction is worth stating because getting it wrong cost a whole gate:
    //   objective() decides where the unit DRIVES, and must use what we have SEEN — driving at a
    //   live position we have no eyes on would track a rival straight through a hill.
    //   done() only decides when to STOP, so the truth can only ever make the unit disengage
    //   sooner. It cannot help it aim, chase or intercept. There is no exploit in knowing that
    //   your opponent has genuinely left.
    // Measured against the frozen last-SEEN point instead, this test can never fire at all: the
    // ghost stands where we last saw it, so a rival that drives off is forever "in range". That
    // was v4 — idle-at-goal tripled because the goal WAS the stale point.
    const q = this.foeV.holder && this.foeV.holder.position;
    if (!q) return true;
    const reach = (cmd.shotReach ? cmd.shotReach(v.type) : 42) * FIGHT_BREAK;
    const p = v.holder.position;
    if ((q.x - p.x) ** 2 + (q.z - p.z) ** 2 > reach * reach) return true;
    // BACKSTOP, for the one case the two rules above leave open: an opponent alive and technically
    // within reach, but sat behind cover where we never see them — the range test says stay, the
    // objective sends us to a stale point, and the unit holds there indefinitely. A tree between
    // two vehicles is not the end of a battle (Jacob), and this is not a tree: eight seconds
    // without laying eyes on them is the line between an obstruction and a standoff we should
    // walk away from. Untuned — there is no measurement behind 8s, only the argument.
    return performance.now() - (this.foeT || 0) > FIGHT_LOST_MS;
  }
}
const FIGHT_BREAK = 1.25;   // they are out of the fight at 125% of our reach — see Fight.done
const FIGHT_LOST_MS = 8000; // …and they are OUT of it entirely once we have not laid eyes on them
                            // this long. Not "lost sight" (a tree blocks for a second or two) —
                            // this is the difference between an obstruction and an escape, and
                            // without it the frozen last-seen position makes a duel unendable.

class Flee extends Mission {
  get key() { return 'flee'; }
  get garageOK() { return false; }          // a decision taken in the field; never buy a chassis for it
  wantVehicle(cmd) { return cmd.unit ? cmd.unit.type : this.doc.role('attack'); }
  shoot(cmd) { return false; }              // the waypoints are places to be, not things to shell
  arriveDist(cmd) { return 6; }
  enter(cmd, doc) {
    super.enter(cmd, doc);
    // Snapshot the threat ONCE. After this the mission never reads perception again.
    const v = cmd.unit;
    const from = (cmd.lastEnemyPos && cmd.lastEnemyPos())
      || (v && v._hitByVeh ? { x: v._hitByVeh.x, z: v._hitByVeh.z } : null);
    this.route = (cmd.planFleeRoute && cmd.planFleeRoute(from)) || null;
    this.leg = 0;
  }
  objective(cmd) {
    const home = cmd.homePos();
    if (!this.route || !this.route.length) return home;
    const v = cmd.unit; if (!v) return home;
    const p = v.holder.position;
    while (this.leg < this.route.length - 1
      && (this.route[this.leg].x - p.x) ** 2 + (this.route[this.leg].z - p.z) ** 2 < FLEE_REACH * FLEE_REACH) this.leg++;
    return this.route[this.leg];
  }
  // Home. Nothing else ends it — not losing sight of the enemy, not healing up on the way, not a
  // better-looking mission. MissionScore gets to choose again when the unit is actually back.
  done(cmd) {
    const v = cmd.unit; if (!v || v.dead) return true;
    return cmd.atHomeBase();   // the SAME test that decides whether to flee at all — see atHomeBase
  }
  label(cmd) { return 'breaking off — going home the back way'; }
  cry(cmd) { return pickCry(cmd, [
    'I’m done out here — breaking off, coming in the back way!',
    'Can’t hold this. Going wide and heading for the back gate!',
    'Disengaging! Route’s around and in through the rear!',
  ]); }
}
const FLEE_REACH = 14;   // u — close enough to call a leg done and start the next
const SWAP_STALL = 10;   // s of ZERO progress toward home before a swap gives up on the trip

class Supply extends Mission {
  get what() { return 'fuel'; }
  get supplyWant() { return 'fuel'; }
  // Never buy a chassis for a top-up: these are things a unit ALREADY in the field decides to
  // do, and deploy() picks its vehicle from the running mission. Keep whatever we are driving.
  get garageOK() { return false; }
  wantVehicle(cmd) { return cmd.unit ? cmd.unit.type : this.doc.role('attack'); }
  done(cmd) { return fracOf(cmd, this.what) >= SUPPLY_FULL_F; }
  objective(cmd) { return cmd._supply || cmd._home || cmd.homePos(); }
  shoot(cmd) { return false; }
  arriveDist(cmd) { return 6; }
}
class Refuel extends Supply {
  get key() { return 'refuel'; }
  label(cmd) { return 'running dry — heading in to refuel'; }
  cry(cmd) { return pickCry(cmd, [
    'Low on fuel — breaking off to top up!',
    'Running on fumes, heading for the pump!',
    'Fuel’s down — I need to tank up before I’m a statue out here!',
  ]); }
}
class Rearm extends Supply {
  get key() { return 'rearm'; }
  get what() { return 'ammo'; }
  get supplyWant() { return 'ammo'; }
  label(cmd) { return 'winchester — heading in to rearm'; }
  cry(cmd) { return pickCry(cmd, [
    'Winchester! Falling back to rearm!',
    'Out of rounds — going for a reload!',
    'Magazine’s dry, I’m no use out here. Rearming!',
  ]); }
}
class Repair extends Supply {
  get key() { return 'repair'; }
  get what() { return 'hp'; }
  get supplyWant() { return 'base'; }   // only an OWN base patches a hull; a depot cannot
  objective(cmd) { return cmd._home || cmd.homePos(); }
  label(cmd) { return 'shot up — pulling back to patch the hull'; }
  cry(cmd) { return pickCry(cmd, [
    'I’m chewed up — pulling back to patch it!',
    'Taking too much damage, falling back to repair!',
    'Hull’s failing. Breaking off before I lose it!',
  ]); }
}
class ArmourUp extends Supply {
  get key() { return 'armour'; }
  get what() { return 'shield'; }
  get supplyWant() { return 'shield'; }
  objective(cmd) { const g = cmd.nearestKnownShield && cmd.unit ? cmd.nearestKnownShield(cmd.unit.holder.position.x, cmd.unit.holder.position.z) : null; return (g && g.pos) || cmd._home || cmd.homePos(); }
  label(cmd) { return 'topping up armour at the generator'; }
  cry(cmd) { return pickCry(cmd, [
    'Swinging by the generator — I want armour before this fight!',
    'No shield, no duel. Topping up first!',
    'Grabbing armour, then I’m back in it!',
  ]); }
}

const MISSIONS = { sap: Sap, trap: Trap, scout: Scout, attack: Attack, siege: Siege, capture: Capture, defend: Defend, intercept: Intercept, scavenge: Scavenge, harass: Harass,
  refuel: Refuel, rearm: Rearm, repair: Repair, armour: ArmourUp, flee: Flee, swap: Swap, fight: Fight };
function makeMission(key) { return new (MISSIONS[key] || Attack)(); }
// Is this mission one a commander may buy a chassis for at the lift? (Top-ups are decisions a
// unit already in the field makes; letting one reach the garage would deploy the wrong vehicle.)
export function missionGarageOK(key) { const M = MISSIONS[key]; return !(M && M.prototype.garageOK === false); }
// What chassis does mission `key` ask for? Asked by the commander when a mission change is about
// to happen, so it can send the unit home to change vehicles FIRST (see Commander.swapWanted).
// Built fresh rather than cached: it is called on a mission change, not per tick, and a mission's
// answer can depend on the board. A mission that names its own current vehicle is telling us it
// does not care — that answer is honoured exactly as given, no stock substitution.
export function missionWants(key, cmd) {
  const M = MISSIONS[key]; if (!M) return null;
  const m = new M(); m.doc = cmd.strategy;      // wantVehicle may fall through to doc.role(key)
  try { return m.wantVehicle(cmd) || null; } catch (e) { return null; }
}

// ---- DOCTRINE — a persona running one mission at a time ------------------------------
// Re-evaluates choose() every tick. A change only takes effect once the current mission
// has run a short dwell (anti-thrash) — except URGENT transitions (grab the flag now),
// which fire immediately. This is what makes missions complete/abort cleanly instead of
// the old linear step machine that could never let go of a finished objective.
// `fight` joins for the reason Jacob gave: life or death, the result of the highest-priority
// trigger. Unlike flee it is still SCORED (fight-or-flight can say this is a bad trade and it
// should lose) — being urgent only means that once chosen it starts now instead of waiting out
// the 8s dwell, which is the whole point of a contact.
const URGENT = new Set(['capture', 'intercept', 'sap', 'flee', 'fight']);   // sap fires once at the start — switch immediately, no wrong-unit deploy first
// A PLAN YOU CAN BENCH vs AN ERRAND YOU CANNOT. Benching "flee" is meaningless — you do not stop
// fleeing because fleeing did not work — so these never receive a report card, and a death while
// one is running is filed against the objective mission the unit was actually out doing. Every
// other mission in MSN_CANDS is a plan and can be judged. See _applyKey / cmd._primaryKey.
// `fight` is support for the same reason: you do not bench "fight" because fighting did not work.
// It also has a second job here — keeping _primaryKey on the real plan through a duel is what
// leaves the incumbent bonus with that plan, so winning a fight RESUMES the job instead of
// handing the board to whatever happened to be second.
const SUPPORT_MISSIONS = new Set(['flee', 'swap', 'refuel', 'rearm', 'repair', 'armour', 'fight']);
export const isSupportMission = key => SUPPORT_MISSIONS.has((key || '').split('-')[0]);
const DWELL = 1.5;   // seconds a mission must run before a non-urgent switch (event re-decides)
// How long a SCORED mission runs before a non-urgent re-think. Deliberately far calmer than the
// old cascade's 1.5s: the incumbent bonus plus this dwell are what turn a score into a commitment
// rather than an opinion re-formed twenty times a second. A decisive jump still switches at once.
const MSN_DWELL = 8;
// A floor and a ceiling on how often the plan is re-examined. The floor stops a trigger that
// fires repeatedly (a threat flickering at the edge of vision) from becoming per-tick scoring
// by another name — the very thing triggers exist to replace. The ceiling is a safety net for
// standing missions that have no legs yet; see _triggers.
const MSN_RESCORE_MIN = 1.0;    // s — never re-score more often than this
const MSN_RESCORE_MAX = 15;     // s — and never go longer than this without looking
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
// DEEP LOG (synced from main.js's RR.setDeepLog — same flag, kept local to avoid a circular
// import back to main.js). Same "log on change or ~3s heartbeat" shape so a value stuck silent
// (the actual bug shape found tonight) still surfaces instead of going quiet.
let DEEP_LOG = false;
export function setDeepLog(v) { DEEP_LOG = !!v; return DEEP_LOG; }
const _dlogState2 = new Map();
function dlog2(key, value, msg) {
  if (!DEEP_LOG) return;
  const now = performance.now();
  const s = _dlogState2.get(key);
  const snap = JSON.stringify(value);
  if (!s || s.snap !== snap || now - s.t > 3000) {
    console.log(`[DEEPLOG ${key}] ${msg}`, value);
    _dlogState2.set(key, { snap, t: now });
  }
}
// HUNTER HARASS (A/B knob): with no live contact to hunt, the hunter runs disruption
// tours on the enemy half instead of a generic attack push. Off = legacy hunter.
let HUNTER_HARASS = true;
export function setHunterHarass(v) { HUNTER_HARASS = !!v; }
export function setRogueRearSiege(v) { ROGUE_REAR_SIEGE = !!v; }
// CAPTURE ROUTES (A/B knob): multi-waypoint directional runner paths (doglegs + rear water arc)
// vs the pre-route single staging point. Isolates whether the routes are the nav regression.
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
// smooth anti-repeat: "never repeat a failing mission"). This is THE brain now — the classic
// default, so the classic playbook and this scorer both live in the build, knob-selectable.
// Slice A1: scores the existing mission set (capture undirected). Directional capture,
// Siege-back, and the fog-honest lane-clear land in A2.
                              // every axis, better by design on finish/reroute; the classic
                              // cascade stays selectable below as the A/B baseline)
// Per-team override (head-to-head A/B: scorer vs classic in ONE match, like the L2 net's
// missionPolicyTeam). undefined = follow the global knob.

// fleet-comp: (a type's share of our remaining fleet − threshold) × 10, bonus-only. Play to
// what we have — a Firebrat-heavy fleet leans capture, a Jotun-heavy one leans the front
// siege, a Valkyrie-heavy one the rear siege (the flyer clears the walls to get there).
const FLEET_FAV = { firebrat: ['capture', 0.40], lurcher: ['attack', 0.23], valkyrie: ['siege-back', 0.15], jotun: ['siege', 0.15] };
const FLEET_FAV_CAP = 5;   // most the fleet-composition nudge can be worth — see the cap note in missionScore
// archetype nudges per mission (the personalities survive, like v.fofW biases the fight
// score). A bare base key ('capture') applies to every direction of it.
// These are MULTIPLIED early in the match — see PERSONA_EARLY below.
// Exported so the AI Lab's commander page can chart the REAL numbers instead of a copy. The
// hand-authored copy it used to hold is exactly how that page drifted: it went on drawing each
// persona's choose() ladder long after MissionScore gated every one of them off.
export const PERSONA_BIAS = {
  warrior: { attack: 2, siege: 1 },
  turtle:  { defend: 2, scout: -1 },
  hunter:  { attack: 1, siege: 1, trap: 3, scout: 1 },
  // The rogue's list used to include plain `siege` — the frontal assault on the tower line,
  // which is the least rogue-like plan on the board, and the one term that made every rogue
  // open exactly like every warrior. It keeps the BACK door (siege-back) and the sneak.
  rogue:   { capture: 1, 'capture-rear': 2, scout: 1, sap: 2, 'siege-back': 2 },
};
// HOW LOUD IS THE PERSONALITY, AND FOR HOW LONG. Without this the archetypes were cosmetic
// for the opening: siege scores off `towers standing` + `flag sealed`, both of which are
// maximal BY DEFINITION at kickoff, so every commander of every persona opened siege and a
// whole dimension of the game never showed up. The bias is multiplied by (1 + PERSONA_EARLY)
// at t=0 and eases back to its plain value by PERSONA_FADE — who a commander IS decides the
// opening, what the BOARD says decides the rest of the match.
const PERSONA_EARLY = 3;     // ×4 bias at kickoff…
const PERSONA_FADE = 240;    // …down to ×1 by the four-minute mark
export const personaWeight = matchT => 1 + PERSONA_EARLY * Math.max(0, (PERSONA_FADE - matchT) / PERSONA_FADE);
// A2: capture is DIRECTIONAL (front/left/right/rear — a stonewalled lane has three other
// angles, and each direction remembers its own failures) and the rear siege is its own plan.
let FIGHT_MSN = false;   // A/B knob (?fightmsn / RR.setFightMission) — a duel becomes a mission
export function setFightMission(on) { FIGHT_MSN = !!on; return FIGHT_MSN; }
// Flee stops being a hard preempt and becomes a scored candidate like everything else, so
// fight-or-flight is one comparison on one board instead of a decision split across two
// mechanisms. SELECTION ONLY: the commitment ("once we are leaving, we are leaving") still lives
// in tick()'s terminal early-return, so this changes why flee is CHOSEN, not whether it can be
// abandoned halfway. Removing that early-return and letting the hull score hold the mission is
// the obvious next step and is deliberately NOT bundled in — one thing at a time.
let FLEE_SCORE = false;   // A/B knob (?fleescore / RR.setFleeScore)
export function setFleeScore(on) { FLEE_SCORE = !!on; return FLEE_SCORE; }
const MSN_CANDS_BASE = ['scout', 'attack', 'siege', 'siege-back',
  'capture-front', 'capture-left', 'capture-right', 'capture-rear',
  'defend', 'intercept', 'scavenge', 'sap', 'trap',
  // The supply missions (see the Supply classes above). `repair` JOINED once the rung it was
  // waiting on — `hurtLatched` — was replaced by the Flee mission: Flee gets a hurt unit HOME, and
  // repair is what keeps it there until the hull is actually patched. Without it a unit arrived,
  // MissionScore had no "stay and heal" to choose, so it took a fighting job and drove straight
  // back out at 30% hull. `armour` stays out: its pull is 3 against attack's 9-15, so it can never
  // be picked, and raising it flat would make armour worth abandoning a fight for. See task #40.
  'refuel', 'rearm', 'repair'];
// Built per call rather than mutated, so the flag genuinely removes `fight` from the board when
// off — a candidate scored at -50 would still show up in every breakdown and every near-tie log.
const MSN_CANDS = () => {
  let c = MSN_CANDS_BASE;
  if (FIGHT_MSN) c = c.concat('fight');
  if (FLEE_SCORE) c = c.concat('flee');
  return c;
};

// ---- requiredVehicle — CAN WE ACTUALLY CREW THIS PLAN? --------------------------------------
// MissionScore priced everything about a mission except whether the fleet can execute it, so an
// impossible plan could outrank the plan that would MAKE it possible: seed 3362 ran `capture` for
// 885s with no Firebrat alive or buildable, beating the siege that would have cleared the tower
// eating its runners. The same blind spot let a Firebrat be re-tasked onto a siege and killed.
//
// ONE VALUE carries both meanings (Jacob's call, and he was right — if a mission is impossible the
// graded part is irrelevant, and if it is possible the binary part is zero, so they never need to
// compose differently). The magnitude says which: 0 ideal, small negative workable, -50 impossible.
//
// Deliberately asks missionWants() for the ideal rather than carrying its own mission×chassis
// table: wantVehicle is already persona-aware (a Warrior sieges with a Jotun, a Rogue with a
// Valkyrie) and board-aware (enemy eliminated → Jotun, gambit → Valkyrie), and a parallel table
// would drift out of sync with it within a month.
const FIGHTERS = new Set(['jotun', 'lurcher', 'valkyrie']);   // interchangeable; the runner stands alone
const NO_SUBSTITUTE = new Set(['capture', 'sap']);            // only a Firebrat carries a flag / lays mines
// URGENCY BEATS FIT (Jacob): "anything can and should intercept — you use what you have because
// you don't have the time." A thief is leaving with our flag; charging the wrong chassis a
// penalty here would price a delay we cannot afford as if it were free.
const URGENT_FIT = new Set(['intercept']);
const REQV_IMPOSSIBLE = -50;   // the fleet cannot do this job at all
const REQV_SAME_ROLE = -2;     // a stand-in from the same role pool
const REQV_CROSS_ROLE = -6;    // a runner sent to fight, or a fighter sent to run
const REQV_RECALL_MAX = -3;    // …at the objective; 0 at the pad (mirrors INCUMBENT_MAX)

export function requiredVehicle(cmd, key) {
  const have = (cmd.unit && !cmd.unit.dead) ? cmd.unit.type : null;
  const ideal = missionWants(key, cmd);
  if (!ideal) return { score: 0, chassis: have };              // the mission does not care what it drives
  const base = key.split('-')[0];

  // WHAT WOULD ACTUALLY ROLL OUT. Ask _pickAvailableType — the same ladder deploy() walks,
  // including "save the last of a type" — so the scorer and the swapper cannot give different
  // answers. Guessing separately is the bug behind a firing spot solved for a Jotun's 80u gun and
  // handed to the Lurcher that replaced it.
  let chassis = have, recall = false;
  if (have !== ideal) {
    const pick = (cmd._pickAvailableType && cmd._pickAvailableType(ideal)) || null;
    // THE BANK IS PART OF THE FLEET. _pickAvailableType only reads what is parked; a commander
    // holding the scrap to build the right chassis is not short of it, it just has not spent yet.
    const buyable = (!cmd.roster || (cmd.roster[ideal] || 0) === 0)
      && cmd.canAfford && cmd.canAfford(ideal);
    // ORDER MATTERS, and getting it wrong inverts the whole term. With an empty Firebrat roster
    // _pickAvailableType('firebrat') does NOT return null — its last resort is "whatever we have
    // most of", so it hands back a Lurcher. Taking that answer first would score a capture as
    // IMPOSSIBLE for a commander sitting on the scrap to build a runner.
    if (pick === ideal) chassis = ideal;                            // the ladder already gives us the right one
    else if (!NO_SUBSTITUTE.has(base) && pick) chassis = pick;      // a stand-in is acceptable for this job
    else if (buyable) chassis = ideal;                              // no stand-in will do — buy the real thing
    else chassis = pick || have;                                    // stuck with whatever we can field
    recall = !!chassis && chassis !== have;
  }

  // Tier A — no substitute exists and none can be bought. A genuine binary, the same kind the
  // board already carries ("flag sealed" -10, "only way we win" +10), so the house rule allows it.
  if (chassis !== ideal && NO_SUBSTITUTE.has(base)) return { score: REQV_IMPOSSIBLE, chassis: null };

  let score = 0;
  // Tier B — how well can we crew it. The IDEAL scores 0, which is what makes this change
  // one-sided: a mission crewed correctly scores exactly what it scored before, so nothing on the
  // existing board needs rebalancing and only mismatches move.
  if (chassis !== ideal && !URGENT_FIT.has(base)) {
    const sameRole = FIGHTERS.has(chassis) === FIGHTERS.has(ideal);
    score += sameRole ? REQV_SAME_ROLE : REQV_CROSS_ROLE;
  }
  // Tier C — the trip. Only when the hull must change, and it must VANISH at the pad: that is what
  // makes the arrival re-score settle instead of recalling again. When the unit gets home the cost
  // is gone and the new chassis is in the roster, so the mission that sent it improves by exactly
  // what the trip cost — which is the whole reason this cannot become a recall treadmill.
  if (recall) score += REQV_RECALL_MAX * travelFraction(cmd);

  return { score: Math.round(score * 10) / 10, chassis };
}

// A/B for the last-runner term, set from main.js so both halves of the change — this and the
// substitution guard in deploy — toggle together. Module flag rather than a window.RR lookup:
// missionScore runs for all 13 candidates every decision, and the persona
// pattern right here is the house way to pass a knob across this boundary.
let REQ_VEHICLE = false;   // A/B knob (?reqveh / RR.setReqVehicle) — score whether the fleet can crew each plan
export function setReqVehicle(on) { REQ_VEHICLE = !!on; return REQ_VEHICLE; }
// ONE RUNNING PLAN, ONE NAME (?msnkeyfix). _msnKey is written only by _applyKey, but three forced
// transitions switch by bare literal and never touch it, so it goes on naming the mission the unit
// ABANDONED. That is not only the ai-lab lighting two cards: incumbentBonus() reads _msnKey
// UNGUARDED and pays the travel bonus to the abandoned plan, measured against that plan's
// objective. See NOTE_2026-08-09_stale_msnkey.txt.
// KEEP LOOKING WHILE PREEMPTED (?trigfix). _triggers holds a LEVEL memory per edge, and it is
// called only inside `if (!next)` — so an _urgent preempt skips it, and the terminal guards for
// flee/swap/fight return before reaching it at all. For the whole duration of a flee, a swap or a
// duel, every edge memory is frozen at whatever the board looked like when the unit last decided.
// This refreshes the memories every tick; the DECISION stays exactly where it was.
let TRIG_FIX = false;
export function setTrigFix(on) { TRIG_FIX = !!on; return TRIG_FIX; }
// …and the same freeze on the re-score clock (?scoreclock). _scoreT accumulates only inside that
// same block, so time spent in a duel does not count toward "it has been a while, look again".
let SCORE_CLOCK = false;
export function setScoreClock(on) { SCORE_CLOCK = !!on; return SCORE_CLOCK; }
let SWAP_YIELD = false;   // a swap still in progress no longer blocks the re-score (A/B knob)
// FLATTEN THE MISSION SPACE (Jacob, 2026-08-11). Flee, swap and fight each used to switch the
// commander OFF for their whole duration — `if (!done) return`, above the decision block — so while
// one ran, nothing could be re-scored: not a rival in front of us, not our flag being stolen, not a
// tower coming back up. Three special cases, each defensible alone, collectively a second decision
// system sitting on top of MissionScore.
//
// THE COMMITMENT DOES NOT LIVE IN THOSE RETURNS AND NEVER DID. It lives in `incumbentBonus` — "how
// much of the running plan is already paid for", weighted by travel — plus the dwell time, and the
// comment at its definition already says those two "are what turn a score into a commitment". The
// returns were a BINARY copy of a GRADUAL rule that was already there and already better. Deleting
// them removes the duplicate, not the commitment: a mission still has to be out-scored to be
// replaced, it just can no longer be un-replaceable.
//
// Completion is untouched — arriving home, finishing a swap at the pad, and winning a duel all
// still end their mission exactly as before, and Fight keeps its one self-preservation exit.
let FLAT_MISSIONS = false;
export function setFlatMissions(on) { FLAT_MISSIONS = !!on; return FLAT_MISSIONS; }
export function setSwapYield(on) { SWAP_YIELD = !!on; return SWAP_YIELD; }

// Score one mission → { total, terms:[[label,val],…] } (terms drive the troubleshooting log).
export function missionScore(cmd, key, running = null) {
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
        // OUR RUNNERS ARE DYING TO TOWERS → silence them before spending another one. The mirror
        // of `clear interceptors` on the attack side. A longer window than that one (60s vs 30s)
        // because knocking a tower down takes longer than killing a single interceptor, so the
        // incentive has to outlive the job it is asking for.
        const rTwr = (cmd._runnerTowerT != null && matchT - cmd._runnerTowerT < 60)
          ? Math.min(8, 3 * (cmd._runnerTowerN || 0)) : 0;
        if (rTwr) add('runners dying to towers', rTwr);
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
      // WHAT SHOOTS AT THIS ROUTE. Not "how many towers on that side of their keep are dead" —
      // which ignored the FOB's guns, assumed a map has a tidy front and rear, and was BONUS-ONLY
      // so live guns on the lane cost nothing at all. cmd.routeGuns walks the actual waypoints the
      // runner will drive and asks which known guns cover them (see routeGuns in main.js).
      //
      // Heavily negative, per the design call: a Firebrat has 14-damage pop-guns and no business
      // trading with a tower, so a lane a tower covers is not a slightly worse lane, it is a lane
      // that eats runners. Gradual on both counts the house rule cares about — the number of guns
      // AND how deep under them the path goes — so clipping the edge of one arc is priced well
      // below driving under two muzzles.
      const rg = cmd.routeGuns ? cmd.routeGuns(dir) : null;
      if (rg) {
        if (rg.n === 0) add('route clear of guns', 2);      // the door really is open on this side
        else {
          // PRICED BY HOW LONG WE ARE UNDER FIRE, AND BY HOW MUCH WORSE THIS LANE IS THAN THE
          // BEST ONE. Counting guns charged the same for clipping the edge of one arc as for
          // driving 400u beneath six muzzles. Worse, it charged every direction for the keep's
          // own guns, which cover the final run-in no matter which way you come — so the four
          // directions landed within a point of each other and capture got shy across the board
          // (average match time +10%, resolution unchanged).
          //
          // Split into the two things it was conflating:
          //   a flat charge — going for the flag at all, while guns are up, is dangerous
          //   the EXCESS over the safest lane — the part that actually chooses a direction
          // `worst` rides on top: deep under a muzzle beats skirting the rim at equal distance.
          const excess = Math.max(0, rg.exposure - (cmd.safestRouteExposure ? cmd.safestRouteExposure() : rg.exposure));
          add(`${rg.n} gun${rg.n > 1 ? 's' : ''} covering the route`, -(2 + rg.worst * 1.5 + excess / 40));
        }
      }
      // fog-honest lane intel: +1 only for a lane we've had eyes on and know is empty; a lane
      // with a KNOWN contact on it is actively repelling; unscouted = neutral (earn it by scouting)
      if (cmd.laneIntel) { const li = cmd.laneIntel(dir); if (li === 'clear') add('lane clear', 1); else if (li === 'blocked') add('lane blocked', -2); }
      if (spareFB >= 0.1) add('spare FB', spareFB); break;
    }
    // FIGHT — the duel, priced off the number the reflex layer ALREADY computes. Deliberately not
    // a second opinion: fightScore weighs hull, ammo, shields, persona, local numbers, crossfire,
    // the counter-web and whether we could even outrun this rival, and recomputing any of that
    // here would be two rulebooks for one judgement — the defect behind every flap in this layer.
    case 'fight': {
      const f = cmd.fightOdds ? cmd.fightOdds() : null;
      if (f == null) break;                    // nothing engaged — scores 0 and cannot be picked
      // The contact itself is the mandate (a rival inside our reach is not a thing to ignore);
      // the odds then decide whether we take it or let the board send us elsewhere. Range is
      // roughly ±5, so a duel lands 5-15: it beats routine work and loses to a real emergency.
      add('a rival on us', 10);
      add('odds', Math.round(f * 10) / 10);
      break;
    }
    // FLEE — the other half of the same decision as Fight, and now on the same board so the two
    // can actually be compared. Mirror-imaged deliberately: fight is 10 + odds, flee is 10 - odds,
    // so they cross where the odds cross and the breakdown reads as one judgement rather than two.
    case 'flee': {
      if (!cmd.shouldFlee || !cmd.shouldFlee()) break;   // 0 — the brain's bail test says we are staying
      add('breaking off', 10);
      const ff = cmd.fightOdds ? cmd.fightOdds() : null;
      if (ff != null) add('odds', -Math.round(ff * 10) / 10);
      // A CARRIER'S RUN HOME IS THE WIN CONDITION. The preempt gave this for free and deliberately
      // — flee's destination is our own base, so for a carrier it is the same errand by a safer
      // road, and arriving still wins the match. Stated as a weight now instead of as position in
      // a ladder, which is the whole point of moving it onto the board.
      const fl = cmd.flag && cmd.flag();
      if (fl && fl.carrier === cmd.unit) add('carrying the flag home', 6);
      break;
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
      if (cmd.needsPartsRun && cmd.needsPartsRun()) {
        add('need parts', 4);
        // THE ONLY WAY WE WIN. Their base is already open and we have no runner, no scrap to
        // build one, and parts lying on the field: fetching them is not one option among
        // several, it is the entire remaining path to a victory. Same genuine binary as
        // "there is an enemy" (+10) and "nothing to shoot with" (+10) — a fact, not a spectrum,
        // which is why the gradual-weights rule allows it. Seed 116: blue annihilated, keep at
        // 0hp, all four towers down, and red ran capture-front 7.5 in a LURCHER for the last
        // six minutes of the match while scavenge sat at 4 and the parts to win sat on the
        // ground. The flag cannot be carried by anything but a Firebrat.
        if (cmd.flagExposed && cmd.flagExposed()) add('only way we win', 10);
      }
      break;
    case 'sap':
      if (earlyB >= 0.1 && spareFB >= 0.5) add('opening sap', earlyB); break;
    case 'trap':
      // "READY" HAS TO MEAN THE TRAP EXISTS. This scored on _trapMode — the INTENT, rolled once at
      // the opening — while `_trap` (the mine cluster's centroid) is only set when the sap sortie
      // actually lays them. Picked before that, trapAnchor() falls back to homePos(), so the
      // hunter "sets its ambush" inside its own FOB, the no-show clock runs down, and it starts
      // lobbing signal shots 30u toward the enemy base — into its own gate. Measured: 234 of 234
      // signal-phase ticks were fired from inside the unit's own base.
      if (arch === 'hunter' && cmd._trapMode && cmd._trap && !cmd._trapDone) add('trap ready', 2); break;
    // SUPPLY MISSIONS. Two terms, and the split between them is the whole point. "how empty" is
    // GRADUAL — it rises as the tank drains rather than stepping on at a line — and "finish the
    // job" only applies while this IS the running mission, holding the score up until FULL. That
    // second term is the latch: it stops a top-up from un-justifying itself the instant the pump
    // lifts the level back over the line that sent us (the two-depot shuttle and the shield
    // flicker were both exactly that). It is a weight, not a lock, so a flag emergency still
    // outbids it — which is the ordering Jacob asked for, expressed as numbers on one scale.
    case 'refuel': case 'rearm': case 'repair': case 'armour': {
      const what = key === 'refuel' ? 'fuel' : key === 'rearm' ? 'ammo' : key === 'repair' ? 'hp' : 'shield';
      const v = cmd.unit;
      if (!v || v.dead) break;                                        // nothing in the field to top up
      // A SWAP ALREADY SOLVES ALL OF THESE. The unit is driving to the pad, and arriving hands it a
      // FRESH HULL — full tank, full magazine, full plating. Scoring a top-up against a swap in
      // progress is one trip home competing with another trip to the same place, and the one that
      // wins does strictly less. Measured under ?flat: ~30 swaps were stolen part-way by rearm,
      // repair and refuel, all with re-score reasons like "nothing has happened for a while".
      // This is not a guard bolted on to protect swap — it is a true statement about the board that
      // the scorer did not know, and it belongs in the score for the same reason everything else does.
      if (SWAP_SUPPLY && cmd.strategy && cmd.strategy.step === 'swap') break;
      if (key === 'armour' && !(v.maxShield > 0 && cmd.nearestKnownShield
          && cmd.nearestKnownShield(v.holder.position.x, v.holder.position.z))) break;   // no armour to fetch
      if (key === 'repair' && !cmd._home) break;                      // only an own base patches a hull
      const frac = fracOf(cmd, what), low = SUPPLY_LOW[what];
      // HOW MUCH IT PULLS DEPENDS ON HOW FAR THE CURE IS (Jacob). A flat number has to be two
      // contradictory things at once — worth crossing the map for, and not worth abandoning a
      // fight for — and it cannot be both, which is exactly why `armour` at a flat 3 was
      // unpickable while the detour it replaced would travel 208u. Healing is CHEAP when you are
      // standing on the pad and EXPENSIVE from the far side of the island, so the score says so:
      // strong enough at home to beat attacking and finish the job, small enough far away that
      // nobody walks home over a scratch.
      const nearMul = key === 'repair' ? supplyNearness(cmd) : 1;
      const tw = teamSupplyW[cmd.team];
      const urgeW = (tw && key === 'repair' && tw.hpUrge != null) ? tw.hpUrge : SUPPLY_URGE[what];
      add('low ' + what, supplyUrge(frac, low, urgeW) * nearMul);
      // CANNOT DO THE JOB AT ALL. A dry unit is not a weak unit, it is furniture: it parks at the
      // siege standoff with nothing to fire and sits there until the watchdog destroys it. This
      // term is why. As a ladder RUNG, resupply used to override the mission outright; as a
      // mission it merely competes — and `rearm` at ~6 loses to `siege` at ~9, so units kept
      // sieging on an empty magazine (measured: 23 scuttles, 14 of them lurchers in `suppress on
      // siege`, and one valkyrie sat dry from t316s while its fuel drained to 2%).
      // +10 is the same number the design gives fight/flight and the desperate grab: the moments
      // where one option has to win rather than argue. Being unable to act is one of them.
      if (what === 'ammo' && frac <= 0.02) add('nothing to shoot with', 10);
      if (what === 'fuel' && frac <= 0.05) add('about to be a statue', 10);
      if (running === key && frac < SUPPLY_FULL_F) add('finish the job', 8);
      break;
    }
  }
  // fleet-comp (play to strength) — a bare fav ('capture') covers all its directions
  for (const t in FLEET_FAV) {
    const [fav, thr] = FLEET_FAV[t];
    // CAPPED. Uncapped, a one-chassis fleet pays the full (share - threshold) x 10 — a roster of
    // nothing but Jotuns scores siege +8.5 on its own. Seed 1095 stalemated on exactly that: the
    // enemy keep was rubble and every board-driven siege term was ZERO, yet siege totalled 13
    // (clock 3, fleet 8.5, incumbency 1.5) and beat an open, grabbable flag at 10 for four hundred
    // seconds. The loop is self-sealing — owning only Jotuns says "siege", sieging keeps the Jotun
    // alive, and a roster that never turns over keeps owning only Jotuns.
    // "Play to your strengths" must not outvote the win condition being on the table. Owning the
    // wrong chassis is a reason to CHANGE chassis, not a reason to prefer the mission that suits it.
    if (fav === key || (fav === base && key !== 'siege-back')) { const b = Math.min(FLEET_FAV_CAP, ((roster[t] || 0) / fleet - thr) * 10); if (b > 0) add('fleet ' + t[0].toUpperCase(), b); }
  }
  // persona bias: the exact key's nudge plus the base key's (so rogue's capture +1 applies to
  // every direction, and its capture-rear +1 stacks on top of that for the back door)
  const PB = PERSONA_BIAS[arch] || {}, pw = personaWeight(matchT);
  // The hunter's trap nudge only counts when this hunter actually rolled a trap this match —
  // otherwise the persona was selling a plan it had no mines for, and at kickoff (where the
  // bias is loudest) that outscored everything the board was actually saying.
  const armed = key !== 'trap' || (cmd._trapMode && !cmd._trapDone);
  // Name WHICH entry each nudge came from. Both used to log as a bare "rogue", so a directional
  // capture printed the persona twice with no way to tell it was the base key and the exact key
  // rather than one term counted twice (Jacob, reading a live match: "why are there 2 rogue
  // bonuses?"). Same numbers, and now the breakdown says what they are.
  if (armed) {
    if (PB[base] && base !== key) add(`${arch}:${base}`, PB[base] * pw);
    if (PB[key]) add(`${arch}:${key}`, PB[key] * pw);
  }
  // success memory (the anti-repeat): a just-failed mission sits at −4, drifts back to 0.
  // Directional captures each carry their OWN memory — "front failed" leaves rear untouched.
  const s = cmd._missionSuccess && cmd._missionSuccess[key]; if (s) add('success', s);
  // affordability: a capture with no runner and no scrap to build one can't execute
  // A capture with nothing that can carry a flag is not a WEAKER plan, it is an IMPOSSIBLE one,
  // and -6 priced it as merely weak: capture still won the vote at 7.5 and the commander drove a
  // Lurcher at an open enemy flag until the clock ran out (seed 116). Price it out of contention
  // instead — this mission cannot produce a win no matter how good the board looks. The fielded
  // unit counts too: a Firebrat already on the field can finish the job with an empty roster.
  // SUPERSEDED BY requiredVehicle when that is on: this is the same statement ("we cannot crew
  // this plan") for one mission and one chassis, and requiredVehicle makes it for all of them.
  // Leaving both would stack -14 and -50 on the same fact.
  if (!REQ_VEHICLE && base === 'capture' && (roster.firebrat || 0) === 0 && !cmd.canAfford('firebrat')
      && !(cmd.unit && !cmd.unit.dead && cmd.unit.type === 'firebrat')) add('nothing can carry the flag', -14);
  // CAN THE FLEET ACTUALLY CREW THIS PLAN — and what would roll out if it did. One value: 0 for
  // the ideal chassis (so a correctly-crewed mission scores exactly what it always did), a small
  // negative for a stand-in plus the trip home, -50 for a job nothing we own or can buy can do.
  if (REQ_VEHICLE) {
    const rv = requiredVehicle(cmd, key);
    if (rv.score) add(rv.chassis ? `crew: ${rv.chassis}` : 'nothing can crew this', rv.score);
    (cmd._msnChassis || (cmd._msnChassis = {}))[key] = rv.chassis;   // the swapper reads this — one answer, not two
  }
  // THE LAST RUNNER IS A ONE-SHOT BET — the mirror of spareFB above. That term pays for having
  // SPARE runners, so holding exactly one produced no signal either way, and the fleet-comp term
  // is bonus-only (`if (b > 0)`) so being down to a last runner never discouraged capture at all:
  // a fleet of 2L/2V/1FB pushes attack +1.7 and siege-back +2.5 while capture gets nothing, and
  // late on capture still carries up to +3 of clock pressure. Scales with the guns still standing
  // (Jacob: "every other unit should have tried to kill the enemies and towers before the last FB
  // gets sent out"), so at four towers this is a bad bet and at zero it is exactly the moment to
  // go — the term falls to nothing on its own rather than needing a threshold.
  if (base === 'capture') {
    const runners = (roster.firebrat || 0) + (cmd.unit && !cmd.unit.dead && cmd.unit.type === 'firebrat' ? 1 : 0);
    if (runners === 1 && !cmd.canAfford('firebrat')) add('last runner', -Math.min(4, towers));
  }
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
  // even died — the anti-repeat barely bit.) NO rounding here: a per-tick increment (0.05s ×
  // 0.033 ≈ 0.0017) rounded to 2 decimals is rounded BACK TO ZERO — the bench never lifted
  // (seed 102: capture still −13 with the flag sitting open, 400s after the last loss).
  if (el > 0) for (const k in S) { S[k] = Math.min(0, S[k] + el * 0.033); if (S[k] > -0.05) delete S[k]; }
  // DECISIVE-EVENT FORGIVENESS: the flag just became EXPOSED (their keep cracked). The runners
  // that died before, died against a STANDING fort — that lesson no longer describes the board
  // (the whole MissionScore philosophy: score the situation in front of you). Clear the capture
  // bench so an open flag can actually be wanted; the towers/defenders that remain still shape
  // the score through their own live terms.
  const exp = (() => { try { return cmd.flagExposed(); } catch (e) { return false; } })();
  if (exp && !cmd._expForgave) { cmd._expForgave = true; for (const k in S) if (k === 'capture' || k.startsWith('capture-')) delete S[k]; }
  else if (!exp) cmd._expForgave = false;
  let best = null, bestV = -1e9; const all = [];
  for (const key of MSN_CANDS()) {
    const r = missionScore(cmd, key, incumbent);
    // INCUMBENT BONUS — now weighted by how much of the plan is already PAID FOR. Near-tied
    // scores must not flap the commander between missions every few seconds (autopsy: a
    // siege↔scavenge↔attack cycle at 4-6s), so a challenger has to genuinely beat the plan.
    // But a flat +1.5 gave a unit still on the pad exactly the same loyalty to its plan as a unit
    // 228u downrange that has spent forty seconds and half a tank getting there. Jacob's framing:
    // "if a siege does get re-evaluated 150u from the fob that translates to +1.5 towards siege."
    // So it scales with committed distance — the sunk cost is real and the scorer should see it.
    // Gradual per the house rule: 0 at the pad, INCUMBENT_MAX at the objective.
    if (incumbent && key === incumbent) {
      const bonus = incumbentBonus(cmd);
      r.total = Math.round((r.total + bonus) * 10) / 10; r.terms.push(['running', bonus]);
    }
    all.push([key, r.total, r.terms]);
    if (r.total > bestV) { bestV = r.total; best = key; }
  }
  all.sort((a, b) => b[1] - a[1]);
  cmd._missionScores = all;   // exposed for the ai-lab console breakdown
  cmd._missionTop = bestV;
  // Gap between #1 and #2 — small AND changing means the incumbent bonus (+1.5) isn't decisive
  // and the pick could start flapping soon. Logs on mode/gap change, so a genuine near-tie
  // stretch prints repeatedly (the actual pre-thrash signature) rather than going quiet.
  if (all.length > 1) {
    const gap = +(all[0][1] - all[1][1]).toFixed(1);
    dlog2(`missionPick:${cmd.team}`, { picked: best, runnerUp: all[1][0], gap, incumbent, changed: incumbent != null && best !== incumbent },
      `${cmd.cname}: mission pick = ${best} (runner-up ${all[1][0]}, gap ${gap})${gap < 1.5 ? ' — NEAR-TIE, thrash risk' : ''}${incumbent && best !== incumbent ? ` — CHANGED from ${incumbent}` : ''}.`);
  }
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
  // One-time per-match rolls that shape the opening. Called from the garage pick as well as
  // tick, because the picker scores `sap` and `trap` off these — deciding the opening before
  // the dice are thrown had the hunter committing to a mine trap it might have no mines for.
  _rollOpening(cmd) {
    if (cmd._sapOn !== undefined) return;
    cmd._sapOn = this.rng() < (SAP_CHANCE[cmd.archetype] ?? 0.35);
    cmd._sapSide = this.rng() < 0.5 ? 1 : -1;   // which flank to sap — rolled per match (was hardcoded per team)
    // A HUNTER that saps may turn it into a baited TRAP: mines on the lane + a Lurcher that lures.
    cmd._trapMode = cmd.archetype === 'hunter' && cmd._sapOn && this.rng() < 0.7;
    if (!cmd._sapOn) cmd._sapDone = true;
  }
  tick(cmd, dt) {
    this.t += dt;
    this.mission.tick(cmd, dt);
    // OBSERVE FIRST, DECIDE SECOND. Everything below can return early — the fight/flee/swap guards
    // do, and an _urgent preempt skips the block that used to be the ONLY caller of _triggers. So
    // run the observation here, above every early exit, and let the decision consult the answer
    // where it always did. Nothing about the ranking or the re-score gate changes.
    this._trigNow = TRIG_FIX ? this._triggers(cmd, dt) : null;
    if (SCORE_CLOCK) this._scoreT = (this._scoreT || 0) + dt;   // the same freeze, on the re-score clock
    this._rollOpening(cmd);
    if (this.step === 'sap' && this.mission.t > SAP_BUDGET) cmd._sapDone = true;   // sortie ran long — move on
    // The trap ends when its mines are spent (blew/cleared) or after a budget → resume normal play.
    if (this.step === 'trap' && ((cmd.trapSpent() && this.mission.t > 8) || this.mission.t > TRAP_BUDGET)) cmd._trapDone = true;
    if (cmd._clearPathT > 0) cmd._clearPathT -= dt;   // countdown: clearing a downed runner's interceptor
    if (cmd._softenT > 0) cmd._softenT -= dt;         // countdown: silencing the towers that keep killing runners
    if (cmd._softenT > 0 && cmd.fortDown && cmd.fortDown()) cmd._softenT = 0;   // towers are down — job done, go grab
    // ONCE WE ARE LEAVING, WE ARE LEAVING. Flee is the one mission nothing re-scores: no urgent
    // rung, no persona plan, no decisive score jump. It ends when the unit is home and MissionScore
    // gets to choose again — that is what "a decision replaces the route and is then committed to"
    // means in code, and it is the difference between this and every flapping version before it.
    if (this.step === 'flee') {
      if (this.mission.done(cmd)) {
        this._switch(this._applyKey(cmd, missionPick(cmd, null)) || 'attack', cmd, 'made it home — picking up the next job');
        return;
      }
      if (!FLAT_MISSIONS) return;
    }
    // SWAP is terminal for the same reason Flee is: it is a trip, and a trip half-taken is worse
    // than either end of it. Home → hand the chassis change to the commander (it owns despawn and
    // re-deploy) → run the job we were switching to when we noticed we were in the wrong vehicle.
    if (this.step === 'swap') {
      if (this.mission.done(cmd)) {
        const then = this._swapThen || 'attack';
        this._swapThen = null;
        cmd.completeSwap(this.mission.want, this.mission.ditched);
        this._switch(then, cmd, 'swapped at the pad — getting on with it');
        return;
      }
      // A TRIP IS NOT A BLINDFOLD (Jacob, 2026-08-11). Arriving is still terminal — the block above
      // is unchanged — but a swap that is merely IN PROGRESS no longer returns here, so the normal
      // decision path underneath gets to run: _urgent first (self-preservation, and our flag being
      // taken), then the trigger-driven re-score. The old early return is why "vehicles just walk
      // on by each other": for the whole duration of a trip the commander was not asked anything,
      // so a Lurcher heading home for a Firebrat could not notice a rival, a stolen flag, or a
      // rebuilt gun. It was not ignoring them — it never looked.
      //
      // WHAT THE GUARD WAS PROTECTING, and why this is not simply undoing it: a trip half-taken is
      // worse than either end of it, and the same reasoning gave Fight its terminal clause after a
      // measured disaster (transit-stuck +65%, nav alarms +40%, scuttles +91%). That thrash came
      // from an INPUT that flickered — _fof going null every time a rival left the sight cone — not
      // from the commander being asked too often. The fix for thrash is a steady signal, never a
      // deaf commander: MissionScore is free to pick anything and is expected to pick sensibly.
      // If it thrashes, that is a bug in the scoring, and it wants finding rather than muffling.
      if (!SWAP_YIELD && !FLAT_MISSIONS) return;
    }
    // A FIGHT IS A COMMITMENT TOO — and until this guard existed it was not one. Fight had no
    // terminal clause, so its done() was dead code and the duel survived only while it kept
    // out-scoring the entire board at every re-score. That made it hostage to the sight CONE:
    // _fof goes null the instant the rival leaves it, which during a duel is constantly, and the
    // unit was handed a fresh objective every few seconds. Measured over 240 seeds: transit-stuck
    // +65%, nav alarms +40%, scuttles +91%, concentrated in `advance` — the signature of a
    // destination that keeps changing. NEITHER of the two gates run before this tested the design;
    // both tested a mission that could not commit to anything.
    // done() reads lastEnemyPos (12s memory) and 1.25x our reach, so it is immune to that flicker
    // — which is exactly why it was written that way, and exactly why it had to be connected.
    if (this.step === 'fight') {
      // ONE exception, and only one: self-preservation. A unit whose brain has decided this fight
      // is lost must be able to leave it. Nothing else interrupts a duel — not a better-looking
      // plan, not a stolen flag. That is what makes it a commitment rather than an opinion.
      if (cmd.shouldFlee && cmd.shouldFlee()) { this._switch('flee', cmd, 'this fight is lost — breaking off'); return; }
      // ONE done() call — it re-acquires the foe and measures range, and this runs every tick.
      if (this.mission.done(cmd)) {
        // Over → back to the JOB. _primaryKey never moved (Fight is a support mission), so the plan
        // returns as the INCUMBENT and keeps the travel bonus it had already earned. That is what
        // makes winning a fight resume the job instead of handing the board to whatever was second —
        // seed 3362's runner was re-tasked onto a siege it then died on, having just won its duel.
        this._switch(this._applyKey(cmd, missionPick(cmd, cmd._primaryKey || null)) || 'attack', cmd,
          'contact dealt with — back to the job');
        return;
      }
      if (!FLAT_MISSIONS) return;
    }
    // Every forced transition carries a WHY — it's appended to the switch log so a mission
    // change always reads as decision + reason, not just a new battle cry out of nowhere.
    let next = this._urgent(cmd);
    // WHICH emergency. _urgent answers with 'flee' OR 'intercept', and this used to read `next`
    // as a bare truthy and describe it as a flag recovery either way — so a unit breaking off to
    // save itself was logged, and FILED, as "our flag is lying in the field". Both halves were
    // wrong: the bark read like nonsense next to the actual situation, and `fk` feeds the ai-lab
    // decision path, so every self-preservation flee in the game was recorded there as flag_loose.
    // Nothing downstream was broken by it; the LOGS were, which is worse — they are what we read
    // to work out why a match went the way it did.
    let why = null, fk = null;
    if (next === 'flee') {
      // shouldFlee has two reasons and they are different decisions, so name the one that fired:
      // the brain wrote this unit off, or we are carrying and the road home is shut.
      const hurt = !!(cmd.unit && cmd.unit.ai && cmd.unit.ai._bail);
      why = hurt ? 'we are done here — break off before we lose the hull'
                 : 'carrying, and the direct road home is blocked — take the back way';
      fk = hurt ? 'self_preservation' : 'route_home_blocked';
    } else if (next) {
      // Two flavours of the same emergency: a live thief carrying it (chase) vs the thief died
      // and the flag's lying loose in the field (drive over and touch it home before their next
      // runner re-grabs it mid-field — far closer than our base).
      const loose = !cmd.ourFlagStolen();
      why = loose ? 'our flag is lying in the field — recover it before they re-grab' : 'our flag is on the move — run the thief down';
      fk = loose ? 'flag_loose' : 'flag_stolen';   // which doctrine rung justified the decision (ai-lab decision-path)
    }
    // PRESERVATION (any persona): losing the attrition war → hold under tower cover instead
    // of trading the last of the army out in the open — UNLESS we can win right now by
    // grabbing an exposed flag. Sits above the persona's own plan so every archetype turtles
    // up when it's getting wiped, then resumes its doctrine once it's back on even footing.
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
    // DEFENSES BREACHED: the enemy's towers are down but their keep still stands → COMMIT to
    // siege and finish the HQ (which exposes the flag), instead of orbiting a defenceless base
    // dueling their leftover units. Without this, Hunter-type doctrines only siege on full
    // elimination, so a flyer circled a defenceless base for 150s with the HQ at full HP (trace).
    // STALEMATE GAMBIT: the match dragged on with the enemy base untouched — stop grinding the
    // mid-field duel and commit to the "Valkyrie around the back" siege (the Siege mission reads
    // cmd._gambit to force the flyer + rear flank, and rushBase suppresses engaging en route).
    // A capture runner was gunned down by an enemy VEHICLE → hunt the interceptor down before
    // feeding another firebrat into it (timed, so it doesn't chase forever).
    // Tower-soften window (see onRunnerLost): the towers keep shredding runners → hold SIEGE
    // until they're silenced, instead of rebuilding a firebrat into the same guns each lap.
    // OPENING SAPPER (persona-rolled): a Firebrat out to a home flank — lay mines on the way back,
    // drop a pod, scout that side — then fall through to the persona's real playbook.
    // HUNTER TRAP: once the trap's mined, tend it with a bait Lurcher until it's sprung/spent.
    if (!next) {
      {
        // MISSIONSCORE: the weighted picker owns the whole offensive/economy plan (the
        // fortDown/gambit/soften/clearPath/scavenge/sap/trap rungs above are gated off when
        // weights are on — the success memory + siege/scavenge terms subsume them, and killing
        // the soften/clearPath loop is the seed-116 fix). Only the flag emergency (_urgent) and
        // home-defense still hard-preempt.
        const runningKey = (cmd._msnKey && cmd._msnKey.split('-')[0] === this.step) ? cmd._msnKey : this.step;
        // RE-SCORE ON A TRIGGER, NOT EVERY TICK. This used to run missionPick on every single
        // tick, with a +1.5 bonus for the incumbent as the only thing holding a plan together —
        // a substitute for a latch. A reflex does not CHOOSE anything now; it says the situation
        // changed enough that the plan is worth re-examining, and calls the scorer. Between
        // triggers the mission simply runs, which is what makes it a commitment rather than an
        // opinion re-formed 20 times a second. See devblog/2026-08-05-one-mission-layer.md.
        // Already computed at the top of tick() when TRIG_FIX is on — reuse it rather than
        // running the edge pass twice (a second pass would consume its own rises).
        const trig = TRIG_FIX ? this._trigNow : this._triggers(cmd, dt);
        if (!SCORE_CLOCK) this._scoreT = (this._scoreT || 0) + dt;
        if (trig && this._scoreT >= MSN_RESCORE_MIN) {
          this._scoreT = 0; this._lastTrig = trig;
          // MID-SWAP RE-SCORE LEDGER. A swap is DERIVED, never scored: MissionScore picks a job,
          // the job asks for a chassis we are not driving, and swap is swapped in to go and get it
          // (see _applyKey). Nothing holds the unit to that trip — which is the design, because a
          // swap must still react to threats — so the trip survives only while the SAME job keeps
          // winning. That makes "did the top mission change mid-swap, and did the board change
          // too?" the question the whole model rests on, and it is invisible in every existing
          // counter. Recorded here, where the swap is still running and its intended follow-up
          // (_swapThen) is still known; read back via RR.swapRescore().
          const wasSwap = this.step === 'swap';
          const wantedJob = wasSwap ? this._swapThen : null;
          next = this._applyKey(cmd, missionPick(cmd, runningKey)); why = `re-scored: ${trig}`; fk = 'weights';
          if (wasSwap) {
            const S = (cmd._swapRescore || (cmd._swapRescore = { n: 0, held: 0, retarget: 0, dropped: 0, why: {}, to: {} }));
            S.n++;
            // READ `next`, NOT this.step. The actual switch happens ~30 lines below, after the
            // dwell gate — so testing this.step here reads the state BEFORE anything moved and
            // scores every single re-score as "held". That is exactly what it did: 419 of 419.
            //
            // _applyKey returns UNDEFINED when it re-derives a swap (it sets up the trip and
            // returns early), and a mission key when the winning job needs no new hull. So:
            //   next == null  → still swapping. Same job = held, different job = retargeted.
            //   next != null  → the job that asked for this trip stopped winning; the trip ends.
            if (next == null) {
              if (this._swapThen === wantedJob) S.held++;
              else { S.retarget++; S.to[`${wantedJob}→swap:${this._swapThen}`] = (S.to[`${wantedJob}→swap:${this._swapThen}`] || 0) + 1; }
            } else {
              S.dropped++;
              S.why[trig] = (S.why[trig] || 0) + 1;
              S.to[`${wantedJob}→${next}`] = (S.to[`${wantedJob}→${next}`] || 0) + 1;
            }
          }
        } else { next = runningKey ? this._applyKey(cmd, runningKey) : this.step; why = 'carrying on'; fk = 'weights'; }
      }
    }
    // REPORT CARD: the picked mission just cost two units in a row with nothing to show —
    // don't repeat the bad decision; run its unblocker. Superseded by the success memory when
    // MissionScore is on, so skip it there.
    this._firedRung = fk;   // ai-lab decision-path: which rung justified the current decision this tick
    // Switch on dwell, on an urgent mission, OR (weights) when a fresh event has spiked the
    // pick decisively past the running mission — so an exposed flag / lost unit re-decides now
    // instead of waiting out the dwell.
    const curKey = (cmd._msnKey && cmd._msnKey.split('-')[0] === this.step) ? cmd._msnKey : this.step;   // the RUNNING plan's full scored key
    const decisive = next !== this.step && (cmd._missionTop != null) && (cmd._missionTop - (missionScore(cmd, curKey).total) >= 4);
    // Weights re-think on a calmer clock (8s) than the classic cascade's 1.5s — the incumbent
    // bonus + this dwell kill the flapping; a DECISIVE score jump (an event spike: flag opened,
    // runner died) still switches immediately.
    const dwell = MSN_DWELL;
    if (next && next !== this.step && (this.t > dwell || URGENT.has(next) || decisive)) this._switch(next, cmd, why);
  }
  // Emergencies that preempt any persona's plan: our flag's been lifted → run it down;
  // the thief died and dropped it in the field → go RECOVER it (any teammate's touch snaps
  // it home). Both waived when WE'RE carrying the enemy flag home — don't blow a winning run.
  _urgent(cmd) {
    // SELF-PRESERVATION OUTRANKS EVERYTHING, and unlike the two below it is NOT waived for a
    // flag carrier: Flee's destination is our own base, so for a carrier it is the same trip by
    // a safer road, and arriving still wins the match.
    // …unless flee is being SCORED, in which case preempting here would short-circuit the very
    // comparison the change exists to make (the board would never see fight and flee side by side).
    if (!FLEE_SCORE && cmd.shouldFlee && cmd.shouldFlee()) return 'flee';
    if (cmd.flag() && cmd.flag().carrier === cmd.unit) return null;
    if (cmd.ourFlagStolen()) return 'intercept';
    if (cmd.ourFlagLoose && cmd.ourFlagLoose()) return 'intercept';
    return null;
  }
  // Directional keys map onto the base missions: 'capture-rear' runs the Capture mission
  // approaching from the rear (cmd._capDir routes the runner); 'siege-back' runs Siege with
  // the rear-tower bias (cmd._siegeBack gates the tower hunt). Records the full scored key on
  // the commander so failures are filed against the DIRECTION that failed, not the base plan.
  // WHAT MAKES A PLAN WORTH RE-EXAMINING. Returns a short reason string, or null to carry on.
  // Every one of these is an EDGE — the moment a thing becomes true — not a state, so a threat
  // that stays visible for a minute triggers one re-score, not twelve hundred. That distinction
  // is the whole difference between a trigger and the per-tick scoring it replaces.
  _triggers(cmd, dt) {
    const v = cmd.unit, S = cmd._msnTrig || (cmd._msnTrig = {});
    const edge = (name, now, label) => { const was = S[name]; S[name] = now; return now && !was ? label : null; };
    // 1-3: the reflexes. Self-preservation, then our flag, in the order Jacob set out.
    // EVERY EDGE IS EVALUATED EVERY CALL, before any of them is allowed to win. `S` holds a LEVEL
    // memory per edge — the `was` a rise is measured against — so an early return does not merely
    // skip a trigger, it freezes every state below it, and a latched-true state can never rise
    // again (`now && !was` = true && !true = nothing).
    //
    // HONEST NOTE ON WHAT THIS DOES AND DOES NOT FIX. It was written to explain the ai-lab showing
    // "hull low" against 100% hp, and MEASURED OVER 3 SEEDS IT CHANGED NOTHING: 112 vs 114 stale
    // samples out of 4180, byte-identical match outcomes. The early returns are not where the
    // states go stale. The real cause is one level up — `_triggers` is called inside `if (!next)`,
    // so ANY _urgent preemption skips it, and the terminal guards for flee/swap/fight return
    // before reaching that block at all. For the whole duration of a flee, a swap or a duel, every
    // level memory is frozen at whatever it was when the unit last ran the block.
    // Kept anyway because evaluating all of them is the correct shape and it costs nothing, but
    // the fix for the stale panel is to REFRESH the memories every tick regardless of preemption
    // and leave only the re-score DECISION gated. That is a behaviour change (edges would stop
    // accumulating a backlog across a flee) and wants its own flag and its own 240.
    // Priority below is unchanged; only the point at which we stop LOOKING has moved.
    const sees  = edge('sees',  !!(cmd.lastEnemyPos && cmd.lastEnemyPos()), 'a contact within 12s (seen, heard, or shot at)');
    const fire  = edge('fire',  !!(v && v._incomingFire), 'taking fire');
    const flag  = edge('flag',  !!(cmd.ourFlagStolen && cmd.ourFlagStolen()), 'our flag taken');
    // a LEG ended — arrived at the current waypoint, or the driver proved it can't be reached.
    // The unreachable case matters as much as the arrival: without it a unit grinds at an
    // impossible goal until the watchdog destroys it, which is the failure this whole
    // investigation started from. Either way the leg is over and the plan gets another look.
    const o = cmd._driver && cmd._driver.o;
    let legLabel = null;
    if (o && o.type === 'GOTO' && v && !v.dead) {
      const p = v.holder.position, d = Math.hypot(o.x - p.x, o.z - p.z);
      legLabel = edge('leg', d <= (o.arrive || 6) + 2 || !!o.violated,
        o.violated ? 'waypoint proven unreachable' : 'reached the waypoint');
    } else S.leg = false;
    // a supply crossed its low mark (the thing that starts a top-up). ALL of them, always.
    let lowLabel = null;
    for (const what in SUPPLY_LOW) {
      const t = edge('low' + what, fracOf(cmd, what) < SUPPLY_LOW[what], `${what} is low`);
      if (t && !lowLabel) lowLabel = t;
    }
    // …now rank them. 1-3 are the reflexes: self-preservation, then our flag, in the order set out.
    if (sees || fire || flag) return sees || fire || flag;
    // 4: the mission says it is finished (the supply missions know when they are full).
    if (this.mission && this.mission.done && this.mission.done(cmd)) return 'mission complete';
    if (legLabel) return legLabel;
    if (lowLabel) return lowLabel;
    // BACKSTOP, not part of the design: a standing mission with no legs (attack aims at a single
    // point) could otherwise ride a stale plan indefinitely. Defining legs for attack is the open
    // item that retires this — until then, a slow heartbeat is cheaper than a stuck commander.
    if ((this._scoreT || 0) >= MSN_RESCORE_MAX) return 'nothing has happened for a while';
    return null;
  }
  _applyKey(cmd, key) {
    cmd._msnKey = key;
    // THE PRIMARY MISSION — the JOB this unit is out doing, as opposed to the errand it is
    // running right now. A unit under fire switches to Flee (correctly — Flee is terminal and
    // re-scores nothing) and then dies, and every consumer that grades a death reads
    // strategy.step, so the report card, the chassis blame, the loss streak and the runner-death
    // handler all got filed against 'flee'. Measured over 8 seeds: 13 of 15 runner deaths were
    // recorded against a support mission, and the ledger on seed 3362 literally read
    // {"flee": -0.22}. The plan that got the unit killed kept a clean record and stayed top of
    // the board; the reflex that was working correctly took the blame.
    // Frozen while a support mission runs, so the errand can never inherit the blame — and the
    // supply missions are the reason this test lives here rather than at the write sites: Flee
    // and Swap return early before _applyKey, but refuel/rearm/repair are scored candidates and
    // come straight through it.
    if (!isSupportMission(key)) cmd._primaryKey = key;
    if (key.startsWith('capture-')) { cmd._capDir = key.slice(8); return 'capture'; }
    cmd._capDir = null;
    cmd._siegeBack = key === 'siege-back';
    return key === 'siege-back' ? 'siege' : key;
  }
  // DECIDE IN THE GARAGE. The vehicle a commander rolls out is chosen FOR the mission, so the
  // mission has to exist before the lift moves. It didn't: `opening` is an archetype constant
  // picked with no sight of the board, and deploy() ran before this doctrine had ever ticked —
  // so slot 0 committed a chassis to a mission nobody had scored, then re-decided seconds
  // later and swapped. Called from deploy(); a fresh unit has no plan in progress to protect,
  // so this skips the dwell timer and the incumbent bonus and just asks what the board wants.
  garagePick(cmd) {
    this._rollOpening(cmd);
    const urg = this._urgent(cmd);
    const next = urg || this._applyKey(cmd, missionPick(cmd, null));
    if (next !== this.step) this._switch(next, cmd, 'chosen in the garage, before roll-out');
  }
  _switch(key, cmd, why = null) {
    if (!key || key === this.step) { this.t = 0; return; }
    // WRONG VEHICLE FOR THE NEW JOB? Go and change it FIRST, as a mission, then run the job.
    // Every mission change already funnels through here, so this is the one place that needs to
    // know — which is the entire reason the recall could be deleted rather than fixed.
    // Skipped when we are already swapping (no recursion), when nothing is fielded (deploy will
    // simply pick the right chassis), and while a rival is close: driving home to change vehicles
    // with your back turned is how a slow hull dies. Deferring here is safe in a way the recall's
    // version was not — we just carry on with the current mission and get asked again, instead of
    // arming something that then has to abort.
    if (key !== 'swap' && cmd.unit && !cmd.unit.dead) {
      const want = cmd.swapWanted(key);
      if (want) {
        this._swapThen = key;
        this.mission = makeMission('swap');
        this.mission.want = want;
        this.mission.enter(cmd, this);
        this.step = 'swap'; this.t = 0;
        this._lastWhy = why || 'wrong vehicle for the next job';
        if (this.log) this.log(`${this.mission.cry(cmd)}   [${this.step} → swap → ${key}${why ? ' — ' + why : ''}]`);
        return;
      }
    }
    const from = this.step;
    // Coming OFF a support mission back onto the real job: the route and firing position the job
    // left behind were solved for where the unit stood before the errand, and the errand is what
    // moved it. Ask the slot to re-plan from where it actually is. Gated — see replanOnResume(),
    // which decides from `from` which support missions this should apply to.
    if (isSupportMission(from) && !isSupportMission(key) && cmd.replanOnResume) cmd.replanOnResume(from);
    this.mission = makeMission(key);
    this.mission.enter(cmd, this);
    this.step = key; this.t = 0;
    // ONE NAME for the running plan. _applyKey writes the full scored key (siege-back, capture-*),
    // but the forced transitions arrive here with a bare literal and leave _msnKey stale. Reconcile
    // at the one point every mission change funnels through: keep the directional key when it still
    // describes this step, adopt the step when it does not.
    if (!cmd._msnKey || cmd._msnKey.split('-')[0] !== key) cmd._msnKey = key;
    if (why) this._lastWhy = why;   // keep the last meaningful reason (for the ai-lab live overlay)
    // Radio-chatter order + a machine-readable decision trail: the cry() supplies the
    // characterful line, the bracket names the transition and WHY it happened, so every
    // mission change in the log is auditable (from → to — reason).
    if (this.log) this.log(`${this.mission.cry(cmd)}   [${from} → ${key}${why ? ' — ' + why : ''}]`);
    if (this.log) { const bd = missionScoreLog(cmd); if (bd) this.log(`  ↳ ${bd}`); }   // MissionScore troubleshooting breakdown
  }
  // Runner died storming the base → respond to WHY, instead of feeding another firebrat down
  // the same lane. Shot by an enemy VEHICLE → send an ATTACK to clear the interceptor first
  // (timed window). Shot by TOWERS on the approach → retry as a STEALTH capture: a wide rear
  // route around the hot zone (the flag's still grabbable, just not head-on).
  onRunnerLost(cmd, enemyHasUnits) {
    // MISSIONSCORE: a dead runner is a FAILED capture. The penalty ESCALATES with each loss so
    // the commander can't feed six runners into the same guns (Jacob: don't repeat a mistake).
    if (!cmd._missionSuccess) cmd._missionSuccess = {};
    const n = cmd._runnerLosses = (cmd._runnerLosses || 0) + 1;
    const pen = -Math.min(16, 4 + 5 * n);   // −9, −14, −16… escalating (enough to unseat an OPEN-flag capture at +13.9)
    // WHICH LANE FAILED. Prefer the primary mission over _msnKey: they agree on an objective
    // mission, but _msnKey follows the unit onto a supply errand (refuel/rearm/repair go through
    // _applyKey), so a runner that died during a top-up detour would file its loss under 'refuel'
    // and fall back to benching capture-front — a lane it may never have driven.
    const runKey = cmd._primaryKey || cmd._msnKey;
    const failedKey = (runKey && runKey.startsWith('capture-')) ? runKey : 'capture-front';
    if (enemyHasUnits) {
      // A DEFENDER killed the runner on THIS lane. Bench only this lane and raise ATTACK, so the
      // follow-up is a revenge sweep and the next grab can come straight down a different
      // approach. (Was: bench ALL FOUR lanes until "they're gone" — but the resume clause was
      // never written, so one death benched every approach for ~8 minutes of a 16-minute match.
      // It was also OMNISCIENT: "are their defenders dead" is not something a commander can
      // know — their reserves and scrap are fog, exactly like tower positions before
      // knownTowers. Judging the lane we actually lost a runner on needs no such knowledge.)
      cmd._missionSuccess[failedKey] = pen;
      cmd._runnerInterceptT = cmd._matchT;
    } else {
      // Pure tower gauntlet → bench just THIS lane so the next runner tries a different route
      // (the wide/rear arc), the other lanes keep their own records.
      cmd._missionSuccess[failedKey] = pen;
      // …and say WHY siege is now worth more, rather than leaving it to be inferred from
      // capture getting worse. Towers killed our runner, so silencing towers is the thing that
      // makes the next attempt survivable — the mirror of the `clear interceptors` term that
      // already boosts ATTACK when a VEHICLE does the killing (Jacob: "if it gets killed by a
      // tower that should incentivize siege"). Explicit beats implicit: it also shows up as a
      // named term in the AI Lab's weights board instead of being invisible.
      cmd._runnerTowerT = cmd._matchT;
      cmd._runnerTowerN = (cmd._runnerTowerN || 0) + 1;
    }
    // VISIBILITY (Jacob): show the re-evaluation after EVERY runner death — the switch-log only
    // fires on a mission CHANGE, so a commander re-deciding "capture again" was silent. Now the
    // penalized scores print each death, so you can watch capture drop and attack climb.
    if (cmd.strategy && cmd.strategy.log) { const bd = missionScoreLog(cmd); if (bd) cmd.strategy.log(`  ↳ runner lost (×${n}) — ${bd}`); }
    this.t = DWELL + 1;   // let the very next tick re-decide (event: our runner just died)
    return;
    
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
