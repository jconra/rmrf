# Devblog — The Same Unit, Twice

*2026-09-11. Written across about 6,000 headless matches and one game watched over someone's
shoulder. Three separate bugs turned out to be the same arithmetic mistake, made three times in
two days — and the counter I used to prove the last one was fixed could never have moved.*

---

## A Valkyrie with 143 fuel

It started with a stalemate. Seed 732: a Valkyrie sitting still for the last 1,008 seconds of a
match, empty tank, sixty units from the nearest supply.

The obvious story is that it ran out of fuel. Jacob's reaction was the right one:

> "similar things have happened before and its always that the no fuel is a result of it being
> stuck, not the cause. so we need to figure out why its not moving."

He was right. At the moment it stopped it had **143 fuel**. It burned the rest idling.

What actually happened was four separately-reasonable rules with no exit between them. Out of
ammo, it turned for home. On the way it passed a scrap pile, and a block of code with nothing to
do with missions quietly rewrote its destination. There were *two* piles, so as it flew the
nearest one changed and the aim point jumped 9.9 units sideways in a single tick.

Then the driver's honesty rule fired. It says: *if the route in my hand ends a long way short of
where I've been told to go, whoever gave me this order asked for something impossible.* A good
rule. But the route in its hand was the route to the first pile, and it had just been told to go
to the second. It measured one against the other, got 9.9, and its threshold for "a long way" was
9.

So it looked at a perfectly good route, to a perfectly reachable crate, and concluded: that's
impossible. The response to impossible is *stand at the end of the route you've got, that's as
close as you can get* — and the end of that route was the spot it was already hovering on.

It stopped. Twenty-five seconds later the verdict expired, it tried again, made the identical
mistake, and stopped for another twenty-five. It did that **forty-one more times**.

It froze 9.8 units from the pile it had stopped for. The pickup radius is 8.

---

## The same unit, twice

Here is the part worth writing down. That 9.9-versus-9 comparison is not one bug. It is the same
bug three times, in three different places, over two days.

**Once**, because the cache is allowed to keep a route while the goal drifts under two grid cells
— ten units — while the contract convicted anything ending more than nine units short. A
one-unit window, and a goal slid into it.

**Twice**, a day later: a Firebrat sat 23 units from a base that heals at 16, on 33% hull, for
three minutes. Its own flood fill could reach within 4 units of the door the entire time. The
route had been asked to finish "within 14 units of the centre" and came back at 15 — because A\*
settles *cells*, and on a five-unit grid the last waypoint lands wherever the cell does. One unit
past its own requirement, convicted for it, capped where it stood, and then the driver's nine-unit
stopping tolerance was applied to *that*, putting it 23 units out.

**Three times**, that evening, watching a live game: a Lurcher parked twelve units from a shield
generator that charges at eleven, throttle at zero. Its order was carrying a goal radius of 12 —
the generic default inherited from a job it had finished ten seconds earlier — because the code
that folds a drifting order into the standing one refreshed the coordinates and the stopping
tolerance and *not* the radius.

Every one of those is a number compared against a tolerance assembled by hand out of three or four
other numbers. Every version of that sum has been wrong by a unit or two.

So the fix in the end was to stop doing the arithmetic. A\* now reports whether it **reached** what
it was asked for. It is the only thing in the system that actually knows.

That overcorrected on its first outing — 111 convictions became 1,752 — because `reached` answers
the question *exactly* as asked, which is right for a ring target like a base and far too strict
for the much more common case of "land on this exact cell", where stopping one cell short has
still done everything the order needs. Both verdicts accept now. Convictions across 240 matches:

```
6227  →  233     the goal radius wasn't in the tolerance at all
 233  →   33     …and then it was, but measured in points instead of cells
```

Transit-stuck units over the same 240 matches: **5,027 → 194**.

---

## The counter that could not move

The nav work shipped with an invariant: the route cache and the reachability contract must agree
about which trip is running. If they ever disagree, that is a bug, and it raises an alarm.

I reported it as holding: **zero stale-route alarms across 1,200 headless matches.**

Jacob watched one live game and it fired at 2,305 seconds.

The alarm depends on the cache *deferring* a replan, and one of the two ways it defers is the
per-frame A\* budget. That budget accrues as `performance.now() - start`. Every headless rig in
this project freezes `performance.now` for determinism, so that subtraction is **always zero**,
the budget never fills, and the path the counter watches cannot execute in a test.

The number wasn't cautious. It was measuring nothing.

The rig can exercise it, once you know to ask — `setNavBudget(0)` makes the comparison `0 >= 0`
and defers every replan. Run that way:

```
before   16,124 stale-route alarms in 6 seeds
after         0                              (convictions and nav alarms unchanged)
```

Sixteen thousand, against a reported zero.

---

## A signal that only sees half the world

That turns out to be a shape, not an incident. The same two days produced three of them.

**`view.underFire` reads `_hitByVehT`**, which only the vehicle damage path writes. So the entire
"I am being shot, break off" reflex was blind to towers. A Valkyrie at 24% hull, under sustained
tower fire, 226 units from home, scored:

```
siege-back  11.6      ← and 'a tower has us in range' is a POSITIVE term
siege        9.6
repair       6.8      ← damped by distance from home
flee         0        ← gated behind a bail flag that cannot see towers
```

The thing killing it was making the siege *more* attractive the more it was shot. Fixing it cut
deaths-under-tower-fire per match from 2.83 / 2.46 / 2.88 to 1.50 / 1.54 / 1.04 across three
disjoint seed sets, and deaths with an empty magazine from ~0.5 to ~0.15.

**A new fight term read `_hitByVeh`** and measured nothing at all — because 86% of the cases it
was written for are units being shot by *towers*, or in the lobe with nothing landing yet.

**And the harness itself**, above.

Three signals, each correct about the half of the world it could see.

---

## What watching found that 6,000 matches didn't

Jacob watched one match. It produced: the stale-route alarm; a Lurcher fetching a shield and then
trading in the freshly-shielded hull for a Jotun because siege had crept **0.4 points** ahead of
attack; and the observation that "a tower is close" was paying out for a tower **146 units away**
on a 480-unit map.

Two Jotuns, well inside each other's sight lobes, one driving past the other until it died,
produced this:

> "A vehicle should not just be trying to go on it's merry way while it's getting shredded by it's
> opponent."

The fight score was two terms — a flat 10 for a contact at any range, and the odds of winning —
against a siege carrying seven stacked terms plus the travel bonus it had banked on the way. Flat
10 cannot tell a speck on the horizon from a shell through the hull.

---

## Four predictions, four wrong

The overnight sweeps are the least flattering part of this post and the most useful.

**I predicted** the "being hit" term would carry the benefit and "in reach" would carry the
thrash. Backwards: reach carried all of it, hit carried none — for the `_hitByVeh` reason above.

**I predicted** narrowing that 146-unit tower radius would be an improvement. It halves the
walk-by cases exactly as expected, and takes stalemates from 2 to 11, swaps from 72 to 124 and
scuttles from 4 to 9. That fat term isn't right; it's a **stabiliser**. Narrow it and siege
collapses to within a point of attack, the two trade places constantly, and every flip that wants
a different hull buys a trip home.

**I predicted** that instability was the whole cost, so pricing the trip would let the radius come
down. It doesn't: margin plus narrow radius still gives 8 stalemates.

**I predicted** the stalemates that the new fight terms cost were attrition. Deaths per match
actually *fell*, 13.25 to 11.83.

And two long-standing worries turned out to be nothing at all. Home-defence trips are abandoned
58% of the time — and across 39 abandonments the base was still under attack in **zero** of them.
Every one turned away because the raider had already left. Drownings, the price of removing the
water wall, are not a pathfinding failure either: over 40 seeds every sinking unit was 10 to 46
units *off* its route, and its route never touched deep water in 11 cases out of 11. Nine of
eleven were circling under an ORBIT — combat footwork steering by pure geometry, with no idea
where the shoreline is. It already knows how to reverse when something blocks its lane; the sea
just needed to count as something. Sink events: **11 → 1**.

---

## The pattern

Every bug here is a rule that was right about what it could see.

The contract was right that a route ending far from its goal is suspicious. The cache was right
that replanning every tick is wasteful. `underFire` was right about vehicles. The orbit was right
about geometry. The harness was right about determinism.

None of them were wrong. They were each answering a slightly different question from the one being
asked of them, and the gap between the two questions is where every one of these lived.

Which is why the last fix is the one I like most, and it is a deletion: A\* now says whether it
arrived, and nothing downstream tries to work it out from coordinates. The system that knows the
answer is the one that gives it.
