# Devblog — The Night of the Nav Alarms

*2026-10-09 to 10-12. "Feel free to run large amounts of matches and try to figure out navigation alarms through
the night." About 3,800 headless matches, five investigators working in parallel, and one line of collision code
that had been holding tanks prisoner inside towers.*

---

## What a nav alarm is

The driver watches every unit for two kinds of no-progress: a trip whose goal stops getting closer for 16 seconds,
and a hull that keeps the pedals down and doesn't move. Either one sets off an alarm with a flight recording. A
unit that is still pinned after a grace period gets destroyed, on the theory that geometry has eaten it.

An alarm is supposed to mean a real defect. The first job was finding out how many didn't.

## Half the alarms were the alarm's fault

**It measured the wrong distance.** "Getting closer" was a straight line to the goal. A route that swings round a
lake gets *further* away in a straight line for a while, so a unit driving its route perfectly read as stalled.
Seed 305 had three alarms, all Jotuns doing exactly that. The watchdog now measures distance left along the route
it is actually driving.

**It inherited old grudges.** A re-issued trip to the same point took over the previous attempt's best distance, to
stop flicker from resetting a genuinely stuck unit's clock. On seed 242 a Lurcher fled north for four seconds, was
sent back south to a point it had once come within 11 units of, inherited that 11, and alarmed at 54 units out while
driving straight at it. A record now only carries over a short flicker, or a hull that hasn't moved.

**It killed units for a twentieth of a second.** The last check before destroying a unit asks whether it covered
ground in the last window. It was reading the window that had just started. A Lurcher that had driven 38 units in the
previous window was judged on the 0.05 seconds that followed, and destroyed.

After the first two fixes, alarms fell by about half on the same seeds.

## Then the real ones

The overnight collection ran 960 matches with every alarm's full recording saved, and a sorter grouped them by what
the unit was doing. Five investigators took a group each, each in its own copy of the game, and were told to prove
the mechanism by watching the unit at the moment, not by counting alarms. Any code change re-flows a match, so an
alarm that vanishes after a change proves nothing on its own.

**The tower that ate tanks.** When a hull's step is blocked, the collision code tries each axis on its own and slides
along whichever is clear. If *both* were clear, it took both, which is the exact step it had just refused. Against a
round collider, a tower or a tree, that cuts across the curve and leaves the hull a hair inside the circle. From inside,
every step is blocked, forever: full throttle, the heading still turning, the position frozen. On seed 16277 a Jotun
leaving its lift clipped a corner tower, landed 0.04 units inside it, and sat there until the tower was shot down. Four
of the seven units the driver destroyed overnight were this. The slide now takes the bigger axis, never both.

**The tank that couldn't step sideways.** A tank only moves along its own axis. Told to drive to a spot beside it while
keeping its nose on a rival, it slid to the point level with the spot and parked. A Jotun on seed 12242 rocked a metre
back and forth for over a hundred seconds. Now the further the spot sits off the nose line, the more the hull swings onto
the spot's line, and it squares back up as it arrives.

**Circling the firing spot.** At a siege standoff, a Jotun whose target sat just past its engage range eased forward at
0.4 throttle with the wheel at full lock, which for a tank is a circle. It left its spot, the route called it back,
it circled again: 24 order changes and six shots in 37 seconds from a gun that reloads every 1.7. It now only eases
forward when the target is past its gun's reach, scaled by how squared-up it is, and a unit that has reached its spot
keeps it while it has something to shoot. On the same moment, replayed with the fix: it pivots in place and fires four
rounds in five seconds.

**Firing spots in the wrong places.** When terrain buries a shot, the AI solves a nearby spot that clears the line. Those
spots could be out of sight of the rival, beyond the gun's reach, inside a building, or, once, in the middle of a lake.
A Firebrat had solved that one for a tower, and a Jotun inherited it from the cache. A spot now has to be in sight, in
reach, inside the line where the unit is allowed to shoot, and somewhere this hull can drive. It's kept until reached
rather than re-solved every few seconds from wherever a slow tank happened to be.

**Two flip-flops.** A Lurcher sitting at exactly 37.8 units from its rival, the "close in or duel" line, switched gear
every tick: forward, back, forward, a minute of it. The duel now has to back off well past the line before switching
back. A Valkyrie flipped between its strafing run and a reverse every half second, because its aiming check treated
water as ground and saw a buried shot that a real rocket would have flown straight over. The prediction now matches
the projectile code: ground only counts on land.

## The review

The merged build went to three reviewers, each with a different angle, and every problem they reported went to a
second reviewer trying to disprove it. Three survived:

- a duel spot could still be solved just past the duel's own firing line, so the walk out crossed it;
- a tank walking to a clear-shot spot could lose its aim on the way and be dragged back to its standoff;
- my own Firebrat fix from the night before charged the "don't risk the last runner" penalty under a different label
  when a heavy was going to do the job.

All three were fixed before the final test.

## The numbers

The old build against the new one, the same six seed sets, 480 matches each. The old build reproduced the overnight
collection's alarm counts set for set, so both arms ran.

| | old | new |
|---|---|---|
| nav alarms | 36 | **12** |
| destroyed for being "stuck" | 2 | **0** |
| units stuck in transit | 2,403 | **308** |
| reverse-and-turn escapes from a "wedge" | 1,440 | **269** |
| matches won | 472 | 474 |
| draws | 8 | 6 |
| average match | 398 s | 356 s |

Matches are about 40 seconds shorter. Not because shorter was the goal: units spend far less of the game fighting the
terrain, and they shoot from their siege spots and duels instead of circling and rocking in them.

One new thing showed up: three short flip-flops between siege and going home to swap hulls, against none before. That's
next.

## What watching found

With the test running, I followed one Lurcher through a whole match instead of counting anything. Fleeing at 26 hp it
drove 220 units straight home, sat on the pad facing the field until hull, ammo and fuel were all full, and left: the
pad score doing exactly what it was designed to do. And its defend mission couldn't decide where home was: three goals
in the first twelve seconds, trips of 50 to 100 units each abandoned partway. It never stopped moving, so nothing
alarms. That's the next thing to look at, and no tournament would have found it.

## Ships as

On by default in 8a8fe09. The full alarm recordings come from `NAVFULL=1` on the tournament rig; `_unitat.cjs`
watches one unit by name at a given match time, and `_follow.cjs` follows one chassis for a whole match.
