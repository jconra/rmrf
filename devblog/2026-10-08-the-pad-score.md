# Devblog — The Pad Score

*2026-10-08. One design conversation, about 5,000 headless matches, and three fixes that each looked
like a tuning problem until they didn't. The question was a small one: why can't a Valkyrie fire its
last rocket? The answer was that the rule everyone was talking about hadn't run in a month.*

---

## The rule that wasn't there

Back in August the game had an ammo gate: a unit needed a "usable burst" before it would start a
fight, so a Valkyrie with one rocket left would not answer a rival. Jacob's verdict at the time:

> "That's not a good solution. It's dumb if you can't fire your last rocket."

It had been restated as a number of rounds per chassis, and reading it again it had an off-by-one —
`ammo / magazine > rounds / magazine` on whole rounds asks for one round *more* than it means. A Jotun
still couldn't start a fight on its last shell, the exact case the restatement was written for.

But the gate lived in the old priority table, and that table hasn't run in normal play since
September, when missions took over their own movement. The off-by-one changed nothing. The real
reasons a unit didn't fire its last round were somewhere else entirely:

- the mission board counted **one round as an empty gun** (+10 toward rearming at `ammo <= 1`),
  because nothing re-thought the board when the magazine actually ran dry — the next look could be
  fifteen seconds away;
- a unit driving home to rearm **never fired** on the way, even with sixteen rounds in the gun;
- "full" meant **95% of the one thing it came for** — a Lurcher left the pad with 65 of 68 rounds,
  and a rearm trip ignored the fuel and hull the same base was filling;
- anything that outscored the top-up pulled it off the pad, and the fight it left for **never came
  back to finish the job**;
- and the "fight from the pad" code — face the chaser, shoot back while the base heals you — was
  still in the file, unreachable since September. A unit topping up parked nose-in, its eyes on its
  own buildings and its back to the field.

## Three rules, then no rules

Jacob's first answer was three rules: fire every round you have; resupply until full; turn around
and fight from the pad while you're being resupplied. His second answer took the rules back out:

> "I want to try to avoid explicit rules like you must stay at the resupply until 100% because there
> may be reasons why it is important to leave early such as the flag is stolen... I am hoping that
> everything in the game will be based off of competing scores while also trying to avoid the
> missions flapping back and forth."

And then he described the score. Close to the supply with a lot missing: a big number. A hundred units
away and just starting to need ammo: not enough to peel off a siege. As the magazine approaches zero:
exponential, so it goes home from anywhere. Standing on the pad: the distance is nothing, so the
score holds it there until it's full, when the score drops to zero. And a really big score — a fight,
the flag — still wins.

## The formula

For each thing a top-up gives (a base gives fuel, ammo and hull at once; a depot gives its one kind),
two parts, summed:

    stay = S · e^(−T/Ts) · missing/(missing + K)
    need = (A · √missing + X · empty(f)) · (1 + (C − 1) · e^(−T/T0))

`T` is seconds of driving to the edge of the supply (zero standing inside it), `missing` is how much
of the tank, magazine or hull is gone, and `empty(f)` is an exponential in how full it is — zero when
full, one when empty, and steep at the bottom. `stay` is the "you're here, don't leave half-full"
part; `need` is the "you're running out" part, made stronger the closer the supply is.

When everything the supply gives is full, both parts are zero. The top-up ends because there's
nothing left to want, not because a line was crossed.

Alongside it: an "empty magazine" trigger so the board hears the last round go; supply trips fire at
a rival inside the gun's own arc without leaving the route; a unit topping up holds still, faces the
field — the rival it can see, else whoever last shot it, else the last contact, else straight out the
way it came — and fires from where it stands.

## Three things that looked like tuning

**A Firebrat that never filled up.** The first `stay` used `missing^0.2` so it stayed high until
nearly full. A hovering Firebrat burns a little fuel while it waits, so it is never *exactly* full —
and 0.1% missing to the power 0.2 is still worth five points, more than the jobs it should have been
doing. It parked. The fix is the knee: `missing/(missing + K)` is high for a real shortfall and close
to zero for a sliver.

**Units refuelling on the way past.** `stay` first faded over three seconds of driving, so it reached
any unit passing near a base. Refuel trips went from 8 to 206 in sixteen matches. Jacob had said
*very close*; three seconds isn't. It now fades in under half a second — it's for the unit that is
standing there.

**Fuel pulling at a third of a tank.** Refuel trips went from 33 to 461 over 80 matches. The design
note from August said it already: an empty tank drives at 35% speed, it never strands a unit. Fuel's
mid-tank pull came down to a third of ammo's; its pull now lives almost all at the empty end.

## What the review found

A three-lens code review, each finding checked by a second agent trying to refute it, turned up three
real defects:

- **A flag carrier went shopping.** The pad score's scale (stay up to 20 per supply, need up to four
  times stronger near one) is far past the +6 "carrying the flag home" bonus. On seed 109 a carrier at
  5% hull switched to repair and parked 1.5 units outside its own scoring ring for six seconds. A
  carrier now does not shop, and never tops up.
- **A stolen flag couldn't pull a unit off the pad**, even with a full magazine — the hold ran before
  the old "chase the carrier" override could steer. Now an armed unit goes; a dry one stays and
  rearms. ("If the vehicle has no ammo then intercept is worthless.")
- **The ledger couldn't see a death.** "Died while topping up" was counted inside the victim's own
  tick — and shots, rails, towers and mines all land outside it. It read zero for a whole day and I
  reported it as a result. It's counted in `destroyVehicle` now, and proven by killing a unit
  mid-top-up and watching the count move.

## The numbers

Old game (`?oldpad`, verified seed-for-seed against the previous build) against the pad score, three
seed sets of 80, 30,000 ticks:

| | old | pad score |
|---|---|---|
| matches won | 237/240 | 240/240 |
| average match | 381 s | 411 s |
| top-ups ending full | — | 89% |
| died while topping up | — | 3.5% of stays (56 in 240 matches) |
| left nearly full to answer a fight | — | 3.3% |
| rounds fired from the pad / on the drive in | ~0 | 673 / 1,450 |

Matches run about 30 seconds longer. That's the time units now spend filling up — repair time
doubled, rearm rose a quarter — not anything going wrong.

**Head to head**, the new brain on one team and the old one on the other in the same match, every
seed played twice with the sides swapped: 121–117 over 240 matches. A tie. Resupply style, like the
repair weights in August, doesn't decide who wins; it decides how the game reads.

**The sweep.** Fourteen variations of the weights, each against the shipped set, 180 matches apiece:
every one landed between 47% and 54% — inside the noise. One pattern held in all three seed sets: a
weaker mid-level pull (A halved) won 55/55/53%, and a stronger one lost 49/50/42%.

Then the confirmation, on three fresh seed sets (6011/8011/10011), 240 matches per row:

| | share | per set |
|---|---|---|
| new brain vs old (old's share) | 49.4% | 49 / 51 / 48 |
| mid-level pull halved | 51.7% | 54 / 49 / 52 |
| no mid-level pull at all | 52.9% | 56 / 50 / 53 |

The head-to-head is a tie twice over: 241–234 across both runs. Halving the mid-level pull held its lean
on fresh seeds, smaller — 221–197 over six sets, five of them above 50%.

So it went in, and was played against the *old* resupply on three more fresh sets. It lost 139–100. That
looked like a verdict until the unchanged pad score was played on the same seeds: it lost too, 123–113.
Those seeds just like the old resupply; the extra four or five points that halving cost are inside what
one set swings. Two lessons, both already in the house rules and both needed again: a win against the
shipped weights doesn't chain into a win against the alternative, and a result on one seed group means
nothing until the control has played the same seeds. `A` stays where it was.

## The flip-flop

The tournament's strobe alarm caught two episodes over 240 matches: a unit switching between rearm and
siege six times in ten seconds. Slowed down, it was a Valkyrie shelling a tower from a spot inside an ammo
depot. Every rocket it fired left it one short, with the depot right there, so `stay` jumped past the
siege; it switched to rearm, the depot handed the rocket back in a sixth of a second, and it went back to
the siege to fire it again.

Refilling goes by where a unit is, not what it's doing — that Valkyrie was being topped up all along. The
stay is "don't leave a top-up half-done", so it now belongs to the running top-up alone. Strobes over the
next 480 matches: zero. Played head to head against the version without the fix: 84–81.

## Also in this batch

- **Only the elevator wins.** An AI carrier used to score inside 12 units of its main base as well as at
  its FOB, a finish line the player never had. Jacob: "Only at the elevator." The main base still counts on
  a map with no FOB. Same seeds, before and after: 160/160 resolved both ways, the same match lengths.
- **Difficulty on the start menu**: Easy / Medium / Hard under PLAYER VS AI, remembered between visits
  (the address's `?difficulty=` still wins).

## Ships as

The pad score is on by default. `?oldpad` restores the old resupply exactly. The flag chase weighed
by firepower (`?interceptfp`) is built and off, waiting for its own head-to-head. The weights are in
`PAD_W` (AIStrategies.js), per team for duels via `RR.setPadW(w, team)`; `RR.padStats()` is the ledger,
and the tournament prints it as PAD LEDGER, with every death while topping up named by what killed it.
