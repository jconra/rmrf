# Devblog — Triggers are triggers (removing pursue from the reflex ladder)

*2026-08-11. Status: agreed design, pre-implementation. Comes out of the mutual stare-down —
a stalemate class where two units sat three units apart and stared at each other for a
thousand seconds. The bug turned out to be architectural, not a missing guard.*

---

## The one-sentence version

**A trigger should fire once, when something changes, and ask MissionScore what to do.
It should never become a job the unit can be stuck inside.**

`pursue` was a trigger that had become a job. This spec takes it out.

---

## The bug that started it

Two Valkyries, three units apart, one with no rockets and one with a single rocket left.
Both bases already cracked open, both flags reachable — a won board for whoever moved. Neither
moved for the last thousand seconds of the match. It happens to **both sides at once**, because
the condition is mutual: each one is pursuing the other.

The chain, which runs through three files:

| # | Where | What happens |
|---|---|---|
| 1 | `main.js` `_navOverride` | A pursuit destination inside the 9u arrival slack gets `HOLD "arrived — pursue"`. Zero throttle. |
| 2 | `AI.js` perception | While the enemy is **in sight**, `lastSeen` is rewritten every tick, so the pursuit's own 3–8s expiry never lapses. Nothing times out. |
| 3 | `AIStrategies.js` Swap | The stall clock counts `pursue` as *fighting*, so the guard that exists for "sits in swap forever" never fires. |

The empty tank is a **symptom**, not the cause — a dry hull still limps at 35% throttle, and the
idle fuel floor drains a tank that sits still for a thousand seconds. Fuel never had anything to do
with it.

### Why it got there — the part worth remembering

Every aggressive rung on the ladder requires ammo. Except one.

```
threatened:  ammoFrac > 0
ambushed:    ammoFrac > 0
underAttack: ammoBurst
engaging:    ammoBurst
pursuing:    — nothing —
```

A unit with an empty magazine is refused by every rung that could start a fight, falls all the way
down the ladder, and lands on the only one that will take it. And the comment on `engaging` records
that **this exact stare-down was already found and fixed once**, in `engage`, after two dry Jotuns
did it for a whole match. That fix assumed the unit would fall through to resupply. When the mission
is a swap rather than a rearm, it sails past and lands on pursue instead.

The stare-down was never fixed. It moved one rung down the ladder. A guard would have moved it again.

---

## The actual problem: two decision systems

There are two independent things deciding what a unit does, and only one of them is the design.

**`_triggers` (AIStrategies.js) is already right.** It is a pure edge detector. Each named condition
remembers its previous level, and a trigger fires only on the rise:

```js
const edge = (name, now, label) => { const was = S[name]; S[name] = now; return now && !was ? label : null; };
```

It returns a *reason* — "a contact within 12s", "taking fire", "our flag taken", "reached the
waypoint", "waypoint proven unreachable", "fuel is low" — and that reason causes a re-score.
Nothing about it can be got stuck in. This is the model, and it works.

**The `transitions` ladder (AI.js) is the other one.** Eleven predicates evaluated every tick, each
mapping to a behaviour mode and a destination. It does not consult MissionScore, does not report a
reason, and the mode it picks becomes the unit's state until the ladder happens to pick differently.

That is how a pursuit hijacked a swap. The mission layer had already decided correctly — *go home
and change hulls* — and the reflex ladder quietly overrode it every tick.

---

## The design

### 1. `pursue` comes out of the ladder

It is deleted as a rung, not guarded. Both of its jobs already exist as missions, and both are
better built than the reflex:

**Fight** already does duel-chase properly. Its objective refreshes while we have eyes on the
opponent "so a pursuing unit keeps closing", and freezes at the last known spot once we lose them.
It holds a foe **vehicle** rather than a point, so the duel can end on a kill. Its `done()` has three
real rules — dead, opened the range, or behind cover — with hysteresis so a target dancing on the
edge cannot flap the mission.

**Attack** already is *seek*. Its objective is the enemy's last-known position, falling back to
where they emerge, with a proper arrival distance, and it deliberately does not blind-fire the goal.

So `pursue` is a third implementation of what two missions already do correctly, with its own
destination, its own arrival rule, and no way to end. Removing it removes a bypass, not a capability.

**Pursue survives in exactly one place: inside the Fight mission, chasing its locked-on target.**

Attack's behaviour gets **labelled "seek"** so the two read differently in logs and in the AI Lab.
Distinct names per mission is the whole point — it is what makes a trace legible.

### 2. `ambushed` becomes information, not a job

"I just got hit" is genuinely different from "I can see an enemy", and no mission covers it. It stays
— but it stops selecting a movement mode. Its entire job becomes: **work out who hit us, record it,
and let MissionScore run.**

It should identify the attacker without facing it. Taking a railgun round in the rear-left is enough
to say a Jotun is at seven o'clock — the target comes from the damage's origin, not from what the
hull happens to be pointed at.

### 3. Fight gets picked whenever `engage` or `ambushed` rises

Which should be about as often as the reflex fires today. That is the measurable claim, and the
main risk of the deletion — see below.

### 4. THE WINDOW THAT SHOULD NOT EXIST, AND DOES

The design says: low ammo rises → MissionScore runs → fight-or-flight scores it → Flee (or Rearm)
gets picked. No gap.

Today there is a gap, and the code documents it:

> *"`_triggers` is called inside `if (!next)`, so ANY `_urgent` preemption skips it, and the terminal
> guards for flee/swap/fight return before reaching that block at all. For the whole duration of a
> flee, a swap or a duel, every level memory is frozen."*

**During a swap, triggers are not evaluated at all.** Both stare-down units were on `swap`. A perfect
low-ammo trigger still would not have fired. So this is not a footnote — it is load-bearing:

> **Refresh every trigger's level memory every tick, regardless of preemption. Gate only the
> re-score DECISION, never the looking.**

This is a behaviour change in its own right (edges stop accumulating a backlog across a flee) and
it gets its own flag and its own gate.

### 5. Fight-or-flight stops being pre-empted by a binary copy of itself

`fightScore` already weighs ammo — a dry magazine is the single heaviest negative term in the table,
which is precisely "dry guns can't win". But both rungs that could call it bail on an ammo check
*first*, so for a dry unit **fight-or-flight is never actually run**.

That is a hard on/off gate sitting in front of a gradual weight that already says the same thing,
only better. The gate goes; the weight decides. Enemy in front of us → fight-or-flight runs → an
empty magazine pushes it negative → flee.

Worth noting for the record: **fuel is not a term in fightScore at all**, which matches the
instinct that low fuel should barely matter to a fight. Only hull, ammo, shield, personality,
numbers, crossfire, matchup, relative health, escape odds and facing.

---

## Explicitly out of scope

Both of these are real and both are deliberately **not** in this change, so they can be measured on
their own:

- **Accuracy by difficulty, and better rocket leading.** Aim-lead is one global constant today, not
  wired to any difficulty setting. The missile is the slowest projectile in the game, which is why
  two Valkyries are so bad at hitting each other.
- **The magazine entry gate.** It means a Valkyrie needs two rockets to start a fight and will never
  spend its last one. A fraction is doing a job that wanted a shot count. The strobe it was written
  to stop should be fixed on the resupply side instead.

---

## Risks, and how we will know

| Risk | How it shows | Measurement |
|---|---|---|
| Fight/Attack are not picked often enough to replace the reflex | Units ignore enemies they used to chase | Count Fight+Attack selections per match, before vs after — this is the headline number |
| Refreshing triggers every tick causes re-score churn | Mission thrash, plans abandoned mid-leg | Mission switches per match; watch for a rise |
| A dry unit dithers instead of leaving | New idle-at-goal samples | Idle-at-goal, and the stare-down signature specifically |

The stare-down has a clean signature to test against — **both** units holding on `arrived — pursue`
at once. Three seeds reproduce it today and are the regression set.

Everything gets gated the usual way: 240 seeds, three seed sets, the sign reported across sets
rather than the best table.

---

## What gets thrown away

The two flags written before this design existed (a 9u radius guard on the pursuit, and a change to
what the swap stall clock counts as fighting). Both worked — every stalemate in the regression set
resolved under either one. Both are the wrong fix, because both keep pursue on the ladder and only
change where it gets stuck. The magic number goes in the bin with them.
