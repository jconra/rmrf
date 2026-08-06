# Devblog — One Mission Layer (flattening the decision stack)

*2026-08-05. Status: proposed design, pre-implementation. Written after the nav-alarm
investigation traced a class of "stuck" units that were never stuck — they were being
argued over by two layers that could not see each other.*

---

## What went wrong

Two autopsies from the 30-seed fresh-seed run, both units destroyed by the driver's
watchdog, neither one actually wedged.

**A Lurcher between two supply dumps.** Fuel sat on a quarter tank. The rule for choosing a
dump reads "if I have enough gas to keep moving, go get ammo; otherwise go get gas," and
"enough gas" is a quarter tank. So: drive to the fuel dump, fill to 26%, which means *I have
enough gas*, so turn around for the ammo dump 90u away, which burns 5% of a tank, which means
*I need gas*, so turn around. Fuel readings across the whole stretch: 0.25, 0.21, 0.26, 0.25,
0.22, 0.26, 0.25.

**A Lurcher parked at a shield generator, under fire.** The generator recharged its armour at
almost exactly the rate incoming rounds drained it — 145.8 gained against 138.9 lost over 30
seconds — so the shield balanced on 60%, which is the number that decides "do I want armour?"
At 62% the shield rule switched off and "I'm out of fuel" took over; a round landed, 58%, and
the shield rule outranked fuel again. It alternated once a second for seventeen seconds, burned
the last fifth of its tank standing in one place, and never got either the armour or the fuel.

Measured across both arms of the tournament, destination changes of more than 25u per
unit-minute went from 4.48 to 7.11, and total thrash events from ~450 to ~1150 — tracking the
nav alarms (6 → 14) almost exactly. The persona work did not cause this. It raised the
exposure until it was visible.

## Why the priority ladder didn't stop it

`js/AI.js` already has a priority ladder, and it works the way you would expect: it stops at
the first rule that says yes. The resupply rung is properly latched — it trips on "fuel low"
and only clears on `resupDone`, which means *topped up*.

The problem is above it. Of thirteen rungs, three latch:

| # | rung | latched? |
|---|---|---|
| 1 | still inside the gate | no (self-ending) |
| 2 | final dash to a grabbable flag | **no** |
| 3 | runner fleeing | **yes** |
| 4 | inescapable enemy on top of us | **no** |
| 5 | grab that shield generator | **no** |
| 6 | fight-or-flight says fight | **no** |
| 7 | hurt, go heal | **yes** |
| 8 | low on supplies, go resupply | **yes** |
| 9 | something's shooting at us | **no** |
| 10–12 | chase / assault / do the mission | no |

Five unlatched rungs sit above resupply. A latch protects you from rules *below* it and from
nothing above. The brain's own decision recorder named the culprits on the seed above:

```
34  shieldRun    <->  threatened
22  resupLatched <->  shieldRun
 9  threatened   <->  unstick
```

`_shieldRun` is wiped to `false` at the top of every tick and rebuilt from a bare distance and
percentage check. The comment above it calls it a commit. It isn't one.

**The structural point:** "go get armour" is a unit-level reflex, "go refuel" is a latched
unit-level job, and "defend" is a commander-level mission. Three layers, no shared list, so
nothing can arbitrate between them. The layers take turns instead.

---

## The design

**One list of missions. One thing that picks. Missions end.**

### Reflexes are triggers, not deciders

A reflex does not choose anything. It says *the situation changed enough that the plan is worth
re-examining* and calls the scorer. This is the whole trick: it keeps reaction time without
creating a second decision-maker that can disagree with the first.

Triggers, in the order they matter:

1. an enemy came into view
2. rounds are landing on us from somewhere
3. our flag was taken
4. the current mission reported **done**
5. **a leg of the current mission was completed** (see below)
6. fuel / ammo / hull / shield crossed a low mark

There is no timer in that list. (5) replaces it.

Note what this replaces: `missionPick` runs **every tick** today, and thrash is held off by an
incumbent bonus of +1.5 for the plan already running. That bonus is a substitute for a latch.
Under this design the latch is real — a mission runs until it ends or a trigger fires — and the
incumbent bonus becomes a tie-breaker rather than the only thing holding the plan together.

### One flat mission list

Everything a unit can be doing is a mission, scored on one scale.

| mission | ends when | garage-eligible? |
|---|---|---|
| scout | map fraction explored / budget | yes |
| attack | standing — re-score at each leg | yes |
| siege, siege-back | towers down / target dead (standing between) | yes |
| capture (×4 directions) | flag home or runner lost | yes |
| defend | standing — re-score at each leg | yes |
| intercept | flag recovered | yes |
| scavenge | parts collected | yes |
| sap | budget spent | yes |
| trap | mines spent / no takers | yes |
| **fight** | enemy dead, gone, or out of sight | **no** |
| **flight** | 100u of separation (reuse `fleeClear`) | **no** |
| **refuel** | tank full | **no** |
| **rearm** | magazine full | **no** |
| **repair** | hull full (respecting `healCap`) | **no** |
| **armour up** | shield full | **no** |

The bottom six are new. They are the things that used to live in the brain's ladder, promoted
to first-class missions so they latch like everything else.

**Garage-eligible** matters because `deploy()` buys a chassis for the current mission. "Flight"
must never be the mission when a vehicle is being purchased. One flag on the mission, checked
in `garagePick`.

### Two kinds of ending, and legs

- **Completing missions** — refuel, rearm, repair, armour up, intercept, fight, flight. There
  is a fact that makes them over. These are the ones the thrash bugs live in, and defining the
  end *as full* rather than *as no longer starving* is the fix.
- **Standing missions** — defend, attack, siege. No natural end. Instead they are a **sequence
  of legs**, and a completed leg is the moment to re-score.

A leg is one nav target. The unit commits to reaching it; when it arrives, the plan is
reconsidered. This is better than a timer for three reasons: the decision point is a real event
rather than an arbitrary interval, the pace follows how fast the unit is actually progressing,
and — the important one — **a unit part-way through a leg cannot be yanked off it.** That is
precisely the failure both autopsies show. Under legs, the shield-generator Lurcher drives to
the generator, arrives, and *then* reconsiders whether fuel matters more.

Part of this already exists. `patrolSpot()` builds a multi-point patrol route for defend, and
capture already runs multi-waypoint routes (`setCapRoutes`). Attack does not — it aims at the
enemy base as a single point and would need legs defining.

Two things a leg needs beyond "arrived":

- **An unreachable leg must end the leg, not grind on it.** The driver already proves this: A*
  empties its open set without settling the goal and the order is marked violated. That signal
  should complete the leg as *failed* and trigger a re-score. Today it is only counted.
- **A floor on leg length or on time between re-scores.** `patrolSpot()` can advance its route
  over short hops; if every few units of travel triggers a re-score we are back to scoring
  continuously by another name.

### Fight and flight are scored, not branched

`missionScore` calls the existing fight-or-flight evaluation and uses its result as a term:

- an enemy is present → **+10 to both fight and flight**, so one of them wins
- the fight-or-flight score itself decides *which*: positive favours fight, negative favours
  flight, scaled rather than stepped. **Fight-or-flight is the main consideration** — nothing
  else should be able to talk a unit out of the answer it gives.
- persona rides on the same scale — a warrior biases fight, a turtle biases flight — which
  folds `v.fofW` into `PERSONA_BIAS` where the rest of the personality already lives

The +10 is a genuine binary because "there is an enemy" is a genuine fact, which the
gradual-weights rule allows.

**Capture gets the same +10 near the flag.** A runner inside grab range of an exposed enemy
flag is in the same category of moment: the win is on the table right now. So capture takes
+10 when the flag is close enough to go for, which puts the desperate grab on level footing
with the fight-or-flight answer instead of losing to it. This keeps everything on one scale —
no exemption, no special-case rung — and preserves the existing behaviour that a runner on the
final approach commits rather than stopping to trade.

**Fight is never benched.** The anti-repeat memory (`_missionSuccess`, −4 on failure) must not
apply to fight or flight. A unit dying in a duel is not evidence that fighting was the wrong
plan, and benching it would make a team pacifist for half a minute after losing one trade. The
fight-or-flight score already weighs hp, ammo, matchup and numbers — that is the mechanism for
"should we fight," and it re-evaluates from the live board every time.

### What happens to the ladder

`js/AI.js`'s transition table stops being a decision-maker and becomes an **executor**: given
the mission, produce this tick's behaviour and pedals. The rungs that were really missions
(shield, resupply, hurt, fight, flee) move out. The rungs that are genuine per-tick execution
detail (`mustGo` clearing the gate, `unstick`) stay.

---

## Settled

- **The desperate grab.** Capture within range of an exposed flag gets +10, matching
  fight/flight, so the win-now moment competes on the same scale rather than needing an
  exemption. This also preserves the existing behaviour that a runner on the final approach
  commits instead of stopping to trade.
- **Fight is never benched.** Fight-or-flight is the main consideration and re-derives from the
  live board; the anti-repeat memory does not apply to it.
- **Re-score on leg completion, not on a timer.** Standing missions are sequences of nav
  targets; arriving at one is the decision point.
- **`missionScore` already has the intel.** No signature change and nothing to expose:
  `update()` copies the slot's fields onto the commander before mission logic runs, so
  `cmd.unit` is the bound unit — `missionScore` already reads it in the last-runner term. The
  new terms just use what is already there.

## Still open

**1. Legs for attack.** Defend has `patrolSpot()` and capture has multi-waypoint routes, so both
already have legs. Attack aims at a single point and needs its legs defined — probably staged
approach points into the enemy half.

**2. Minimum leg size.** `patrolSpot()` can advance over short hops. Without a floor on leg
length (or on time between re-scores), leg-completion scoring drifts back toward continuous
scoring by another name.

**3. Facing at a supply point.** A unit parked on a completing mission should face where danger
is most likely — back the way it came, falling back to the enemy base. Small, and it only
matters once units actually *stay* at the pump, so it lands with this change.

---

## Order of work

1. **Thresholds first, before any refactor.** Put a gap between "start wanting it" and "stop
   wanting it" for fuel/ammo/shield, and move the shield rung below hurt and resupply. Small,
   independently valuable, and it gives a measured before/after to judge the refactor against.
2. **The flattening**, with triggers on top and the six new missions.
3. **Facing at supply.**

The gate for (2) is the thrash metric this investigation built (`~/pw/_thrash.cjs`): far-goal
changes per unit-minute, currently 7.11. Nav alarms and the tournament are the backstop, but
thrash is the number this design exists to move.
