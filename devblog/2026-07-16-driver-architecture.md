# Devblog — The Driver Architecture (single-driver locomotion redesign)

*2026-07-16. Status: agreed design, pre-implementation. The locomotion-port experiment
(Locomotion.js + state-machine wiring) is parked uncommitted: the math is validated, the
wiring showed a tournament regression (49/60 → 44/60 resolved, a new 174s stuck class),
and this architecture replaces that wiring wholesale.*

---

## The philosophy: "stuck" is a bug report, not a situation

There is no mud in this game. Every stuck ever logged has been one of these **failures**,
not weather:

| Root cause | What actually happened |
|---|---|
| **Dishonest goals** | Commander ordered the driver somewhere unreachable (the walled fob centre). A* silently returned a *partial* path and the driver ground against the gap forever. |
| **Planner/hull mismatch** | A* plans on cell centres; the hull has width. It threads a gap on paper the body can't fit through. |
| **Terrain physics** | Shore slopes shove the hull; feelers see nothing (`blk ···`), unit slides in place. |
| **Steering math** | The turning-circle orbit — fixed (eased throttle), was pure code disease. |
| **Missing chassis maneuver** | Jotun's lane-clear was an illegal strafe; gate it and it stands there — found and fixed (reverse-arc). |
| **Unit-vs-unit shoving** | Two friendlies meet in a throat and push. |

The jolt/unstick machinery is an **apology for upstream lies**. In the new architecture it
becomes an **alarm**: it fires, dumps a flight recording, counts against us in the nightly
report, and each firing is a bug we kill at the source. The design goal is that the alarm
goes silent.

**Ruling (Q6):** no recovery dance. The alarm flags the bug and we investigate; the game may
continue. Preference: a stuck unit **self-destructs** (after a short grace) rather than
circling for minutes — the team pays for the bug, which keeps the pressure on fixing it,
and the match isn't visually ruined by a pirouette.

---

## The layer stack

### Layer 0 — THE DRIVER (pure execution, no decisions)

One driver per vehicle. Owns exactly the basic controls:

| Control | Notes |
|---|---|
| throttle | continuous −1..+1. **Reverse caps at 0.5** for every chassis except the Lurcher (full speed any direction). Reverse exists for maneuvers that need it — plain navigation turns around instead. |
| rotate | −1..+1, chassis turn rate |
| strafe | −1..+1 **only if the chassis has the pedal** (Lurcher omni; Firebrat/Valkyrie lateral; Jotun physically lacks it) |
| altitude | Valkyrie only (cruise band) |

Plus driver *competencies* — not decisions, just skill: square-up easing (never full
throttle while badly mis-aimed; this is the anti-orbit fix), arrive-and-settle deadzone,
anti-wobble, turning-circle self-knowledge, and **collision anticipation** (whiskers slow
him down *before* contact — a good driver doesn't hit the wall and then react).

The pure-math core already exists and is unit-verified: `js/Locomotion.js`.

### Layer 1 — MANEUVERS (the vehicle commander's order book)

Each is an order the commander issues; the driver executes with his pedals.

| Maneuver | Contract | Eligibility / per-chassis flavor |
|---|---|---|
| **GOTO(point, arrive, throttleCap?)** | Plan a road-preferring, mine-avoiding route and follow it. **Honesty rule: refuses unreachable points** — answers "nearest reachable is X" instead of silently walking a partial path. This one contract change kills the biggest stuck class. Optional throttle cap for quiet movement (see stealth notes). | Omni translates through waypoint corners; tank square-ups. |
| **ALIGN(target, arc)** | Bring target into weapon arc, minimum time. | Jotun: **reverse-arc** (back up while rotating, opening range). Lurcher: turret does it, hull needn't move. Valkyrie: normally *ineligible* — a hovering aligner is a sitting duck — but not denied if fight-or-flight is strongly positive. Its native attack is JOUST. |
| **JOUST(target, offset)** | *Valkyrie signature.* Full-speed run past the target with it held to one side, firing the missile rack through the window, then extend away and **reassess fight-or-flight before committing to another pass**. | Valkyrie only. |
| **HOLD(face?)** | Park; keep nose/turret on a bearing. Guard-duty default facing: the most-likely-enemy direction (enemy base bearing), overridden by heard sound. **No mission waits in HOLD longer than ~5s** — scan, then move on. | — |
| **ORBIT(center, radius, dir)** | Circle a point keeping face on it (duel strafing, flanking a tower). | Omni orbits natively sideways; tank approximates with arcs; Jotun doesn't get this order. |
| **KITE(threat, toward)** | Retreat along a safe vector while facing the threat, firing when it bears. | Tank = reverse-fire (0.5 speed); omni = backpedal any direction at full speed. |
| **BREAKAWAY(threat)** | Max-speed escape with rim/water awareness (the runner's move). Turns around and drives — no long blind reversing. | — |
| **REVERSE-OUT(dist)** | Deliberately back out of a nose-in position while staying ready to fire forward — leaving a firing notch, or opening range from an enemy detected by noise/sensor pod when fight-or-flight is negative. Legal and planned — unlike a jolt. | All chassis (0.5 speed; Lurcher full). |
| **THREAD(gate)** | Align on the throat, drive straight through — no dodging inside. | — |

**Reverse doctrine (Q3):** reverse is a *maneuver* tool (KITE, REVERSE-OUT, Jotun ALIGN),
never a navigation shortcut. Distance-limited; beyond the maneuver's need, turn around.

### Layer 2 — VEHICLE COMMANDER (tactics = picking maneuvers)

The brain states and duel footwork re-expressed as order-givers: travel→GOTO; duel =
ORBIT/KITE/ALIGN/JOUST + press; siege = GOTO(standoff) + HOLD(face tower) + fire ladder.
All the tuned judgment lives here; zero motor math.

**Siege interrupted from behind (Q2):** any sieging unit reacts *immediately* on detecting
an enemy — break off the siege: first drive *away from the tower* (out of its arc so it
isn't taking free tower hits), then ALIGN on the attacker. Whether it fights or flees after
aligning is the existing **fight-or-flight score** (see below). A truly ambushed Jotun —
already taking fire, negative escape odds — accepts its fate and trades: keep shooting
what it can kill (the `jotunFloor` term already encodes "a Jotun with ammo always fights").

**Shoot-through vs go-around (Q4):** a **commander decision flavored by personality plus a
dice roll** — D&D style: situation modifiers + personality stats + RNG, so identical
situations play out differently between matches and between personalities. Constraint:
never target your own team's walls.

**Fight-or-flight score (the "score" referenced throughout):** `fightScore()` in AI.js —
signed, >0 fight / ≤0 disengage. Terms: own hp & ammo & shield, personality
(aggression/defensiveness), Firebrat fragility, local numbers (allies vs rivals nearby),
crossfire (tower + rival at once), counter-matchup both directions, enemy-weaker/already-
fleeing bonus, escape survivability (can't outrun → stand and trade), facing advantage
(who has whose back), Jotun-with-ammo floor. Weights per team (`v.fofW`) — the set the L1
evolution runs bred. Commitment bias prevents sign-flap at the boundary.

### Layer 3 — MISSION / DOCTRINE — unchanged, already clean.

---

## Right-of-way & friendly interference (Q1)

Flag carrier always has priority; two friendlies should never both enter a contested
throat and have to back out. Direction: **time-window path reservation** (cooperative A*):
a unit reserves the grid cells along the next ~7 seconds of its route when it plans;
priority goes to whoever reserved first (flag carrier trumps), cells release as the unit
passes them. Cheap version: only pay the coordination cost when a friendly actually
overlaps the local A* grid — then replan more often over shorter horizons. FOB
distribution in 3v3 already makes the collision case rare; this handles the remainder.

---

## Detection & stealth (phase 2 — changes game balance, gets its own tournament)

- **Sight is a cone, not a circle**: full detection range in a ~90° forward arc, half
  range out to 180°, nothing behind. Sound stays 360° (as today). Opens real stealth play.
- **Half-throttle = quiet**: commanders can order reduced throttle to shrink their sound
  signature when investigating or setting an ambush (GOTO throttleCap).
- **Guards look around**: face the likely-enemy bearing, turn toward heard sound and
  cautiously advance on it, periodic scan; never idle longer than ~5s.
- **Loud units check their six**: a unit that just made a racket (Jotun taking down a
  tower gun) does a look-around scan for stalkers.
- All of these behaviors log their reasoning.

---

## Logging (everything, until nav is clean)

- **Order log** per unit: every maneuver issued — by whom, why, params. In the ?nav
  overlay + published to the ai-lab console.
- **Driver telemetry**: active maneuver, route length, progress %, expected-vs-actual
  speed. A **progress watchdog** replaces the stuck timer: behind schedule = early
  warning, zero progress = ALARM.
- **On alarm: flight-recorder dump** — last ~10s of tick samples (pos/heading/motor/
  feelers) + order history, to ai-log and localStorage; tournaments collect autopsies
  automatically. Then (after grace) the unit self-destructs, loudly logged.
- **Contract-violation log**: a commander requesting an unreachable goal is a Layer-2 bug
  by definition — logged as such.
- Nightly metric: **alarms per match**, driven to zero.

### Chain-of-command display (ai-lab console)

The unit brain panel shows every layer of the decision, live:

```
WARRIOR                                  ← doctrine / personality
ATTACK · step=defend                     ← mission (Layer 3)
tactical: lost sight of enemy → re-acquire    ← commander reasoning (Layer 2)
maneuver: ALIGN(45°) then GOTO(34,-20)        ← the standing order (Layer 1)
driver:   turn right · reverse 0.5            ← pedals this tick (Layer 0)
```

---

## Implementation slices

1. **Slice 1 — the Driver object**: owns path cache, route-following, and the motor layer
   (Locomotion.js core) behind the order interface; GOTO with the honesty rule; order log
   + telemetry + alarm/flight-recorder plumbing; chain-of-command publish to console.
2. **Slice 2 — ALIGN** (incl. Jotun reverse-arc) + HOLD + REVERSE-OUT; siege break-off.
3. **Slice 3 — duel footwork as orders**: ORBIT/KITE/BREAKAWAY/JOUST; retire the last
   inline steering.
4. **Phase 2 — detection cone + stealth throttle + guard scanning** (own tournament).
5. **Later — path reservation** for friendly right-of-way.

Every slice: before/after tournament, fresh-seed confirm on anything surprising.
