# Pursuit navigates. DIRECT goes away.

Design note, 2026-08-08. Companion to `2026-07-16-driver-architecture.md`.

## The problem, measured

Over 240 seeds the Driver logs **699 unreachable-GOTO contract violations**, and it already
names who causes them:

```
violations by ISSUER:   pursue 495   advance 203   resupply 1
```

Pursuit is 71% of it. The reason is that pursuit does not navigate at all:

```js
this._driver.order({ type: 'DIRECT', by: cmd.state });     // main.js
```

`DIRECT` means *"combat footwork steers itself; the driver only observes."* No route, no
pathfinder, no reachability test. A Lurcher chasing a Firebrat that hovers over water is
commanded straight at it, walks into the sea, and grinds.

Everything downstream of that is compensation. `aiAntiGrind` cuts the throttle of a sinker
pointed at deep water — which stops the grinding and leaves the unit standing still, still
holding a target it can never reach.

Measured cost of that trade, 240 seeds, identical outcomes (234/240 resolved either way):

| | near-water stuck | inland stuck | total | scuttled | nav alarms |
|---|---|---|---|---|---|
| with anti-grind | 3781 | 1503 | 5284 | 14 | 60 |
| without | 3185 | 965 | **4150** | 20 | 78 |

Removing the guard gives the *lowest* stuck total — and costs 6 scuttled vehicles and 18
alarms, which is the shore-dancing it was written to prevent. It is an exchange rate, not a
fix, and it only exists because something upstream keeps issuing goals into water.

## The design

**DIRECT was always scaffolding.** The Driver's own header says so: *"Later slices replace
DIRECT with ALIGN/ORBIT/KITE/JOUST orders."* This is finishing that, starting with pursuit.

**Pursuit plans a route.** A bounded A* to the target. `astarGrid` already takes `maxNodes`,
and `planPath` already takes `opts.nodeMul`, so a combat-range search can run at a fraction
of the full-map budget. Combat distances are short; the search is cheap by construction.

**Replan at a fixed 1 Hz.** Not "when the target has moved more than N units." Jacob's call,
and the right one: a fixed tick is cheaper to reason about, has no threshold to tune, and
cannot develop the failure modes a distance heuristic invites (a target oscillating across
the threshold, a stale plan held because the target technically didn't move far enough).
One second is also the commitment interval — see *plans are commitments*.

**No route means DECLINE the target.** This is the decision that makes the whole thing
small. When A* finds no path to the target, the unit does not path toward it, does not wait
at the shoreline, does not predict where it might re-emerge. It **forgets the target and
asks MissionScore for something else to do.**

Jacob, on a Lurcher that loses a Firebrat over water:

> That's tough luck for the Lurcher. [...] the FB can always remain out of reach. It's not
> going to come back ashore if the Lurcher is waiting there. So I think the best plan is for
> the Lurcher to forget about the FB and consult the commander to pursue its own goals.

A shore-waiting behaviour would be speculative ambush logic guarding against an opponent who
simply never comes. Declining is both simpler and more correct.

## Why this should collapse a whole class of bugs

Once an unreachable target is declined rather than pursued:

- the 495 pursue violations have no way to occur;
- `aiAntiGrind` has nothing left to absorb, so it can be deleted — and until it is, its
  firing rate becomes a genuine alarm that some other issuer is still handing out
  impossible goals;
- the ford halo can be judged on its own merits instead of through a band-aid that
  distorts exactly the cells it opens up.

## Order of work

1. Pursuit only: bounded A* + 1 Hz replan + decline-on-no-route, behind a flag so it A/Bs
   cleanly. Before number to beat: **495 pursue violations**.
2. Re-measure. Then `advance` (203 violations), which is a different issuer with different
   reasons for picking a goal.
3. Then delete `aiAntiGrind` and re-run the ford halo, which is currently uncommitted and
   blocked on exactly this.
4. Then the remaining maneuvers — ALIGN / ORBIT / KITE / JOUST — as routed orders, which is
   where DIRECT finally disappears.

The target state is the one worth naming: **A* solid enough that navigation errors go to
zero**, and every order in the game is a route the driver can refuse.
