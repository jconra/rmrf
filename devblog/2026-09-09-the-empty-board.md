# Devblog — The Empty Board

*2026-09-09. Written overnight across 5,760 headless matches. One stalemate turned out to be
three defects stacked on top of each other, and the deepest one was a board that changes its
mind about the game every time a hull leaves the field.*

---

## The seed that should not have stalemated

Seed 60. Blue is annihilated at 827 seconds — no units alive, no hulls in reserve, their keep
already rubble, their flag open and grabbable. Red has a Firebrat in the rack.

The match runs to the 1500-second buzzer. Six hundred and seventy-three seconds of unopposed
play, and nobody picks up the flag.

Three separate bugs were holding that door shut, and each one was invisible until the one above
it was removed.

---

## One: attack had nothing to attack

The mission-score log, printed for every decision:

```
1326s → 1467s   attack 7.1   ·   capture-front 6.3     (identical, every score, 150+ seconds)
```

The term math:

```
attack          7.1   base +1, fleet L +2.7, hunter:attack +1, running +2.4
capture-front   6.3   clock +3, flag OPEN +4, grabbable +2, 1 gun covering the route -2.7
```

`attack` is the mission that hunts their units. There were none, and none buildable, and
nothing in attack's case asked. `fleet L +2.7` is play-to-strength — *we own Lurchers, so prefer
the Lurcher mission* — and `running +2.4` is the incumbency bonus. Between them the mission
re-elected itself forever against an enemy that did not exist.

The knowledge was already in the codebase. `enemyEliminated()` has been there for months, and
the **old transition table consulted it**: *"no one to hunt → press the base."* When MissionScore
became the one place that decides, that piece of knowledge did not come with it. This is the
third time a migration has left something behind, and it is always the same shape: the deleted
layer knew something the new layer was never told.

`enemyStrength()` is the gradual form — units fielded plus hulls in reserve — and attack's whole
case now scales with it. Nearly-beaten is worth less to hunt than fresh; beaten is worth nothing.

Attack vanished from the board. **The seed still stalemated.**

---

## Two: the board is a different board when nothing is fielded

Underneath was something bigger, and finding it required admitting that two of my measurements
had been wrong.

The first read `cmd._missionScores` at the instant a hull was retired — which is the *previous*
tick's board, computed while the unit still existed. The second compared the raw scorer output
against a guard that operates on normalised keys, and produced a confident conclusion about a
guard that was working correctly all along.

So: one honest instrument instead of another inference. `RR.scoreGap()` scores the same board
twice at the same instant — as the commander actually is, and as if nothing were fielded:

```
22% of sampled instants flip the winning plan mission
purely by retiring the hull
```

(Supply missions excluded. A hull that does not exist needs no fuel, and the one that rolls out
arrives full — those collapsing to zero is the code being right.)

Capture loses `the flag is right there`, worth up to +10, because the term measures from a unit
that is momentarily gone. Siege keeps its structural terms and wins by default.

---

## Three: which is why swaps delivered the wrong vehicle

`deploy()` opens by calling `garagePick()`, and garagePick re-decides the mission. Its comment
explains why: *"a fresh unit has no plan in progress to protect."*

A delivery is not a fresh unit.

The trip was ordered **for** a job. The commander drove all the way home for it. The swap
completion deliberately does not re-pick, for exactly this reason — and then deploy re-picks
anyway, on the empty board, one second later. Capture has lost its proximity term. Siege wins. A
Lurcher rolls out for an errand that asked for a Firebrat.

Seed 60's own counter, which had been printing this all along:

```
swapLoopWhy: capture:firebrat->lurcher  x7
```

Seven trips home for a runner. Seven Lurchers. A Firebrat in the rack, and the enemy flag open
and — to a Lurcher — unreachable.

```
seed 60:   STALEMATE at 1500s   →   WON at tick 8016 (401s)
swap loops on that seed:  8 → 0
```

---

## What it measures across 3,840 matches

Two seed families, 960 matches each, control and fix, every arm on a frozen snapshot.

| | family 1 | family 2 |
|---|---|---|
| swap loops | 1298 → **77** | 1338 → **72** |
| stalemates | 9 → **3** | 10 → **2** |
| resolved | 951 → 957 | 950 → 958 |
| swap trips *ordered* | 5710 → 4764 | 5664 → 4650 |
| mission switches / match | 49.4 → 45.7 | 48.0 → 43.9 |
| losses with nothing to show | 153 → 122 | 129 → 119 |

The second-order effect is the one worth reading twice: about **a thousand fewer swap trips
ordered in the first place**. When the delivery honours the job, the commander stops re-ordering
the same trip it just abandoned.

### And two things that got worse, in both families

```
strobes       33 → 45      30 → 49
Jotun jolts  957 → 1028   993 → 1098
```

Both reproduce, so both are real. The strobe composition says what is happening: everything
paired with `fight` rises. Counted directly over eight seeds, total fight entries *fell*
128 → 101 while `firebrat entered fight from capture` **rose 15 → 23**.

That is not the fix misbehaving. It is the fix working: deliveries now actually hand out
runners, so there are more runners in the field to be pulled off their flag run. The defect was
always there — it was just rarely reachable, because the runner usually never got built.

A Firebrat has the thinnest hull in the game and a 14-damage gun that this codebase already
refuses to point at a tower, on the stated grounds that *"excluding it costs nothing and
protects the runner."* The same sentence applies to duelling. A runner runs or it flees —
self-preservation still preempts, so a cornered Firebrat still breaks off — but it does not
stand and trade.

Gated on its own, on both families, against the build that already had the other two fixes:

| | family 1 | family 2 |
|---|---|---|
| strobes | 45 → **19** | 49 → **27** |
| `capture<->fight` strobes | 18 → **0** | 18 → **0** |
| losses with nothing to show | 122 → 77 | 119 → 89 |
| Firebrat jolts | 522 → 293 | 447 → 267 |
| mission switches / match | 45.7 → 39.8 | 43.9 → 39.5 |

The capture/fight strobe class goes to **zero** in both families, and it takes the Jotun jolt
regression with it — 1028 → 977 and 1098 → 929, back level with the original control. A runner
that stops turning to fight also stops getting wedged while it turns.

### The whole stack against the original control

| 960 seeds x2 | family 1 | family 2 |
|---|---|---|
| resolved | 951 → **958** | 950 → **958** |
| stalemates | 9 → **2** | 10 → **2** |
| swap loops | 1298 → **52** | 1338 → **61** |
| mission switches / match | 49.4 → **39.8** | 48.0 → **39.5** |
| losses with nothing to show | 153 → **77** | 129 → **89** |
| anti-wedge jolts | 2773 → **2372** | 2745 → **2278** |
| dry trips | 70 → 61 | 73 → 54 |
| scuttled | 57 → 51 | 60 → 54 |

Eight disjoint sets of 240 seeds. Stalemates are never worse in any set. Nothing regresses.

Matches also finish 4–10% sooner, and that is worth saying carefully, because short matches are
not the goal: the time came out of *wasted trips*. A thousand fewer swap orders, ten fewer
mission switches per match, and half as many units lost with nothing to show for it. The clock
moved because the game stopped doing things that accomplished nothing.

---

## The census

The reason for running thousands of matches rather than dozens. Failure classes, 960 matches:

| class | count | per match |
|---|---|---|
| swap loops | 1298 | 1.35 |
| stands taken under crossfire | 1299 | 1.35 |
| transit-stuck | 1130 | 1.18 |
| losses with nothing to show | 153 | 0.16 |
| standoff solver came back empty | 84 | — |
| dry trips | 70 | — |
| scuttled | 57 | — |
| stalemates | 9 / 960 | 0.94% |

And the one nothing had ranked before:

```
HOME-DEFENCE:  1845 started · 732 arrived · 1098 abandoned en route
               of arrivals: 124 CONTACT, 608 FUTILE (empty crater)
               repeat trips by the same hull 583 · median trip 4s
```

1845 responses producing 124 useful arrivals. **6.7%.** Fifty-nine per cent are abandoned
mid-trip; eighty-three per cent of the ones that arrive find an empty crater. Scoring home
defence properly cut the *time* spent on it by 61% earlier this month, and the trips themselves
are still almost entirely waste. That is the next thing to open.

---

## A Lurcher in the sea

One more, found by chasing a regression that turned out to be exposure. Seed 214, a Lurcher —
a hull whose movement profile is literally `water: 'sink'`:

```
t=86..111   position (33,-137)  →  (34,-137)
            throttle 0.65–1.0        fuel 156 → 100
            path: (35,-135):0.0  (30,-135):0.0  (25,-135):0.0
```

Twenty-five seconds at full power, one unit of progress, a third of its fuel burned, and every
waypoint on its route sitting at terrain height zero. Those cells classify as `deep=false,
land=false` — the shallow ring, which A\* correctly treats as fordable at a cost of 35.

Neither stuck-reflex can see it. `_stillT` never accrues because the shuffle exceeds
`stillEps`; `_wedgeT` peaks at 1.35 against a limit of 1.6 before the oscillation resets it. The
unit is technically moving and technically making progress, and it is doing neither.

The horizontal cause is not yet identified — there is no water speed penalty in the code, so
waypoint ping-pong at the shoreline is the standing suspect. Written down here rather than
guessed at, because the last two guesses this session were both wrong and both cost more time
than the measurement would have.

---

## What this session actually taught

Three of my own conclusions had to be withdrawn before the real defects came out: a firing-spot
clamp that could never fire, a swap guard that was already working, and a stale score board read
one tick too late. Each one was confidently stated and each one dissolved the moment it was
measured directly rather than argued from the source.

The pattern is worth naming, because it is not carelessness — it is that reading code tells you
what it is *for*, and only instruments tell you what it *does*. `RR.scoreGap` exists because of
that, and it found in one run what three readings of the same file had missed.
