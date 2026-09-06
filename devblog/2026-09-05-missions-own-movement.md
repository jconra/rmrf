# Devblog — Missions Own Movement (finishing the flattening)

*2026-09-05. Status: proposed design, pre-implementation. Written after an evening of watching
games, where the same question kept coming back in different costumes: a vehicle is doing
something visibly wrong, and no layer will admit to having decided it.*

---

## The thing that keeps happening

A green Lurcher was doing what Jacob called a crazy dance. Sampled live off the running game at
8Hz for forty seconds:

```
red/1/lurcher   hp=22  ammo=3
  path travelled 112.9u vs net displacement 71.0u     churn 1.6x
  heading REVERSALS: 10
  mission: siege -> fight -> flee
  state:   advance -> assault -> advance -> assault -> advance -> assault -> advance -> engage
```

Read those last two lines together, because the contrast is the whole point.

**The mission layer behaved perfectly.** Three plans in forty seconds, each one a sensible
answer to what was in front of it, ending on `flee` at 22 hp with 3 rounds left. Two
transitions. That is a commander making decisions and committing to them, which is exactly what
the August flattening was for.

**Underneath it, something else changed its mind eight times.** `advance` and `assault` traded
places over and over, and each trade moved the steering target, and that is where the ten
heading reversals came from. The dance was never the commander. It was a second table, sitting
below the missions, re-picking a row sixty times a second.

## What is still in `js/AI.js`

Seven rows, evaluated top to bottom, first match wins, every tick:

| row | picks | what it means |
| --- | --- | --- |
| `fleeing` | advance | drive at the goal |
| `underAttack` | engage | a rival is on us and we cannot outrun it |
| `engaging` | engage | close enough for combat footwork |
| `resupLatched` | resupply | drive at the depot |
| `sieging` | suppress | stand off and shell a structure |
| `shootGoal` | assault | the goal is a fortification, shell it |
| `always` | advance | drive at the goal |

The August design said what should happen to this table:

> `js/AI.js`'s transition table stops being a decision-maker and becomes an executor: given the
> mission, produce this tick's behaviour and pedals. The rungs that were really missions
> (shield, resupply, hurt, fight, flee) move out.

Half of that shipped. `threatened` and `pursuing` were deleted, and suppress became a mission's
job rather than a reflex any passing hull could trip. The table itself survived, and it kept the
property the missions gave up: it re-opens its choice every tick, with no dwell and no latch.

It also sits closest to the wheels, so when it flaps, that is the most visible thing on screen.

## The word that was doing no work

The August doc called the surviving rows "executors". That term is the reason this took so long
to see clearly. It sounds like a resolved question — this row *executes*, so it is fine — and it
let seven rows keep having opinions under a name that implied they had none.

Drop it. Three things happen, and only three:

1. **Triggers** notice that something changed.
2. **Missions** decide what to do.
3. **Vehicles** move, shoot, and report back.

`always -> advance` is a good test of the vocabulary. Advancing to *where*? What does *always*
mean? There is always a mission — MissionScore never returns nothing — so this row is only ever
saying "travel to the objective the mission already picked." It is not a decision. It is also
not a row. It is what a travelling mission does.

## Where each row goes

| row | goes to |
| --- | --- |
| `fleeing` | Flee, which already exists and can state its own movement |
| `resupLatched` | Refuel / Rearm / Repair / Shield, same |
| `engaging` | Fight |
| `sieging`, `shootGoal` | Siege |
| `always` | every travelling mission, via a shared travel-to-a-point call |
| `underAttack` | **not movement at all** — it is a decision, and becomes a trigger |

`underAttack` is the one that matters most. It forces combat footwork on its own hp and odds
tests, without consulting the commander, from the top of the table where it outranks everything
the board decided. That is the shape the flattening exists to remove.

`sieging` keeps its footwork and hands back its hp-bail and ammo tests, because a hurt or empty
unit is a question for the board — where `flee` and `rearm` are already scored and already the
right answers.

## What the missions call

Missions say *where* and *what*. The vehicle decides *how*, because the chassis differ in ways
no shared routine can paper over: the Lurcher's six legs translate in any direction with an
independent nose, the Valkyrie flies over everything, the Jotun turns its whole hull to aim.

That ownership is already half built and in the right place:

- `js/Vehicles.js` has `class Vehicle`, and `driveOmni()` is already a method on it
- `js/Locomotion.js` holds the pedal maths every chassis funnels through
- `planPath` already returns a straight line for a flyer, because nothing can block it
- `VEH_MOVE` already records per-chassis facts: omni, strafe, flies, crosses water, crushes trees

What is missing is the level above: `driveTo(x, z)` and `shootAt(target)`, so a mission stops
assembling routes itself.

Shared behaviour lives in helpers the missions **call** — travel to a point, stand off and
shell, chase a hull. Not a table that picks between them. Seventeen missions each owning
movement is seventeen chances to copy-paste the ladder back into existence, and that is the
obvious way this design fails.

## The third verb

Drive and shoot are not enough. The vehicle also has to **report**, and this is the part the
current code gets wrong in a way that has cost real hours.

A flag carrier was watched sitting motionless in a cracked keep, holding the enemy flag, with
`_reachCap` pinned at its own position and nine seconds still to run. The chain behind it:

1. A\* has a node cap. Hitting it returns the best partial route so far, flagged `budgetHit` —
   meaning *I stopped early, I do not know whether the rest is reachable*.
2. The unit drives that partial to its end, waits half a second, and re-searches with double the
   budget. Then triple. Then quadruple. This escalation works.
3. After the fourth try, `main.js` clears `budgetHit` — not because the route is complete, but to
   force a verdict. Its own comment says it converts *"we don't know"* into *"we could not get
   there."*
4. Nothing detects the truncation after that. The unit drives to the end of a stub, stops on a
   waypoint it is already standing on, and the driver reports the destination unreachable.

Three hundred lines earlier the same file carries the comment `"partial because FAR" != "partial
because UNREACHABLE"`. Step 3 throws away the distinction the flag exists to preserve.

The premise that settles it is Jacob's, and it is stronger than anything in the code: **the map
is static, and the unit drove in.** Reachability is symmetric on unchanging terrain. A carrier
standing on a flag it walked to has proved a route out exists. Any "no path" home is therefore a
bug, not a fact about the map — and the honest states are *still working on it*, *this is taking
a lot of searching*, and *the open set emptied*, never a silent collapse of all three into one.

If `driveTo()` owns the route, it owns the truth about the route. That is the loud-alarms rule
applied at the one boundary that has been quietly swallowing failures.

## Two things that stay out of missions

**The anti-wedge jolt** fires when a hull has throttle on and is not moving. **Whisker dodge**
steers around an obstacle in the next few metres. Neither changes the plan, so neither is a
mission — they belong inside the vehicle's movement code, where they have no opinion about
anything.

But both are symptoms, not features. On a static map a correct, followable route needs neither.
They exist because the route and the world disagree — and the interesting part is *where* that
disagreement is not.

**Hull size is already handled.** `cellBlocked` inflates every obstacle by `VEH_R * 0.9` = 2.7u
before testing, so a cell is blocked for a body, not for a point.

**Smoothing is already collision-checked, more strictly than A\* itself.** Every shortcut passes
`hasRoom()`, which walks the line and requires all eight neighbours of each cell on it to be
clear. The comment beside it records what happened when it did not: `suppress` stuck 93 -> 307,
scuttles 8 -> 18, nav alarms 49 -> 89.

**The gap is the follower.** The capture radius is `c * 1.2` = 6u on a 5u grid, so a unit
declares a waypoint reached from more than a full cell away and turns immediately toward the
next. A\* guarantees clearance along the path. `_smooth` guarantees clearance along any shortcut.
The follower drives *neither of those lines* — it drives a rounded-off version that cuts up to 6u
off every corner, and nothing validates that line at all. All the clearance work is being done on
a path the vehicle does not actually follow.

This is the standing candidate for a symptom watched repeatedly: a vehicle leaves the FOB
elevator and drives into the corner of its own base. The path is going out the gate; the follower
is not driving the path.

**The fix is pure pursuit, and it is Jacob's lerp idea.** Rather than "am I within X of node k",
find the closest point on the route and aim at a point a lookahead distance further along it. The
aim point slides continuously instead of jumping node to node, so the hull tracks the line rather
than the corners. Corner cutting becomes bounded by the lookahead instead of unbounded, and the
chord from the hull to its aim point can be validated with `hasRoom()` — machinery that already
exists and is already proven.

Lookahead is per-chassis, which is an independent argument for the vehicle owning movement: the
Lurcher translates sideways and can track a line almost exactly, wanting a short lookahead; the
Jotun turns its whole hull, and a lookahead shorter than its turning radius makes it orbit its own
aim point. That number belongs to the vehicle, not to a shared constant.

Removing collision outright is not the answer, because the keep sealing the flag is load-bearing
for the entire siege design. Making routes trustworthy enough that avoidance never fires is the
same goal without that cost.

## Settled

- **Triggers notice, missions decide, vehicles do and report.** Three layers, no fourth.
- **`underAttack` becomes a trigger.** It is a decision, and decisions belong to the board.
- **`fleeing` and `resupLatched` are deleted outright.** The missions they shadow already exist.
- **Navigation and weapons belong to the vehicle class**, because the chassis genuinely differ.
- **Missions call shared helpers**, never a table that arbitrates between them.
- **"Executor" is retired as a term.** It described a row that decides things while sounding like
  one that does not.

## Still open

**1. The `advance <-> assault` flap has a second cause.** Both rows survive this cut as movement,
so folding them into Siege removes the flap by removing the choice — but the underlying input is
still flickering. `Siege.shoot()` returns a constant `true`, so `v.shootGoal` going false and
back means `_shielding`, `_intercepting` or `_scrapDetour` is toggling. Worth finding even once
nothing is listening.

**2. What `driveTo()` reports, exactly.** "Still working," "searching hard," and "genuinely
blocked" need to be three distinct answers a mission can act on differently, and the third one
should be loud, because on a static map it is almost always wrong.

**3. Whether pure pursuit removes the jolt and the dodge entirely.** If the hull genuinely drives
the validated line, neither reflex should ever fire. If they still do, something else is wrong and
it will finally be isolated rather than papered over.

**4. Order of operations.** The four queued behaviour fixes — ammo emptiness as a count rather
than a fraction, sensing triggering a fight-or-flight call, outranged contact, and this refactor
— overlap. This one moves the most code and should probably land first, so the others are
written once into the new shape rather than twice.

---

## Built in `rmrf-dev`, 2026-09-05 (all gated off by default)

Nothing below changes behaviour until its knob is turned on, and each is separately gatable.

| knob | what it does |
| --- | --- |
| `RR.setMsnMove(true)` / `?msnmove` | missions answer "how do I move"; the AI.js priority table is bypassed |
| `RR.setAmmoCount(true)` | "nothing to shoot with" counts rounds instead of magazine fraction |
| `RR.setOutranged(true)` / `?outranged` | fight-or-flight is offered when EITHER hull can shoot |
| `RR.setSeesLevel(true)` / `?seeslevel` | re-score every second while a rival is sensed, not once on the edge |
| `RR.setPurePursuit(true)` / `?purepursuit` | follow the route line instead of capturing waypoints at 6u |
| `RR.setPursuitFree(true)` | unclamped pursuit, for comparison against the clearance-clamped version |

`Mission.prototype.movement()` returns `{mode, target}`; Fight, Flee, Supply and Siege override
it. Siege's two gears — shell the gun in front of us, or shell the objective — are now one method
instead of two table rows that traded whenever their inputs flickered.

**Three dead things deleted outright.** `BEHAVIORS.exit` (no state named it once the `mustGo` rung
went), `states.pursue` (no transition has selected it since the pursuing rung was removed), and
`states.unstick` — which named `BEHAVIORS.unstick`, **a behaviour that does not exist**. The
anti-wedge jolt returns early and never reaches the behaviour lookup, so it was harmless purely by
never being used; any mode routed there would have called `undefined(ctx)`.

## What the follower measurement actually says

First attempt, one seed, reported as percentiles: median halved, tail improved. That reading was
wrong, and the way it was wrong is worth keeping. Re-cut as *time spent outside the corridor the
navigator actually guarantees* (2.7u, `VEH_R * 0.9`), plain pursuit went **7.6% -> 12.1%**. It
tracks better on straights, which was never the problem, and leaves the corridor more often on
corners, which was. Aiming a fixed distance ahead cuts corners by definition.

Two further faults in that first measurement, both mine:

- **The simulations diverge.** Changing the follower changes the match, so the two runs were two
  different games. Sample counts differed by a quarter.
- **Combat footwork is not route-following.** A unit in `engage` kites and circles and ignores its
  path on purpose. Pooling those in measures the mix of behaviours, not the follower.

Both fixed: travelling units only, pooled across twelve seeds. The corrected baseline is
`typical 3.42u, outside 13.5%, worst 155.1u`.

**That 155u is a finding in itself.** It is far too large to be following error — it is a unit
nowhere near its route, which points at a stale `_nav.path` held after the goal moved. Until that
is understood, "distance from the planned path" is partly measuring staleness rather than
steering, and no follower change can be judged on it.
