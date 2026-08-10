# The +2 that wasn't

Overnight results, 2026-08-10. Ten 240-seed A/B pairs, run back to back while nobody was
watching. One change shipped. One change looked like the best result in weeks and turned out to
be nothing. The most useful thing the night produced was a better ruler.

## The one that looked like a win

The mission layer re-examines its plan when something changes — a contact appears, a supply drops
below its mark, a leg of the route ends. That's `_triggers`, and it works by edge detection: it
holds a **level memory** of what each condition looked like last time, and reports a *rise*.

The memories only get refreshed inside one branch:

```js
if (!next) {                       // …only when nothing has already preempted
  const trig = this._triggers(cmd, dt);
```

So for the entire duration of a flee, a swap, or a duel — every tick of it — nothing looks at the
world. The memories sit frozen at whatever the board looked like when the unit last decided. On
resuming, it compares the present against a snapshot minutes old: fires edges that already passed,
misses ones that happened while it was busy. The function's own comment says this, and asks for
the fix by name.

So we made the observation run every tick and left the *decision* exactly where it was. Observe
first, decide second.

| seeds 11+ | base | trigfix |
|---|---|---|
| resolved | 237 | **239** |
| stalemates | 3 | **1** |
| transit-stuck, near-water | 728 | **343** |
| stuck in `advance` | 833 | **457** |

Two matches that couldn't resolve now resolve. Half of all near-water stuck time gone. A correct
diagnosis, a one-line fix, and the numbers to match.

## Then we ran it on seeds it had never seen

| seeds 5011+ | base | trigfix |
|---|---|---|
| resolved | 237 | **236** |
| stalemates | 3 | **4** |
| idle-at-goal | 4948 | **6428** |

Same build. Same flag. 240 fresh maps. The effect is gone, and slightly negative.

A third set, seeds 9011+, came back **237 → 238**. So the full picture is **+2, −1, +1**:

| seed set | base | trigfix |
|---|---|---|
| 11+ | 237 | 239 |
| 5011+ | 237 | 236 |
| 9011+ | 237 | 238 |

**The sign flips.** 711 → 713 across 720 matches. That is not a fix; that is a coin with a story
attached, which is the dangerous kind.

The diagnosis is still *true*, incidentally. The memories really are frozen through every flee and
every duel; that's not in question. It just doesn't cost enough matches to measure. **Being right
about the mechanism doesn't entitle you to a result.**

The only reason we know is that the winner got re-run on fresh seed territory before it shipped.
Had the night stopped at the first table, we'd have shipped a change that does nothing and written
a confident post about why it worked.

## The ruler was wrong too

Every A/B pair runs its own baseline arm. After four pairs there were four independent base runs
sitting in the results directory — same build, same 240 seeds, hours apart, different machine load.

All four: **237/240 resolved, 3 stalemates, 728 near-water stuck.** Exactly two seeds of 240
differed at all, and only in the tick they finished on. **Zero flipped win↔stalemate.**

We had been reading ±1 as noise, on a figure inherited from an older harness. It isn't. At 240
seeds and a 1500-second limit, resolution is deterministic — a ±1 is a real result. Twice that
night a genuine −1 got waved off as "inside the noise floor".

Measuring it cost nothing. The samples were already on disk. *N* pairs is *N* free noise samples,
and comparing them beats assuming.

## What actually shipped

One change, and it scored exactly zero.

There are two names for the plan a unit is running: `strategy.step`, which is always correct, and
`cmd._msnKey`, the full scored key including directional variants like `siege-back`. `_msnKey` is
written in exactly one place — and three forced transitions bypass it:

```js
_switch('flee',   cmd, 'this fight is lost — breaking off')
_switch('attack', cmd, 'runner intercepted — clear the defenders first')
_switch('siege',  cmd, 'the towers keep shredding our runners')
```

After any of those, the two names disagree. The visible symptom was the AI Lab lighting two
mission cards at once, which is impossible by design and was the thing that started this.

The invisible symptom is worse:

```js
export function incumbentBonus(cmd) {
  const key = (cmd._msnKey || '').split('-')[0];      // unguarded
  ...
  const f = travelFraction(cmd);                       // how far along we are
```

The incumbent bonus exists so a half-driven plan isn't dropped for a fresher-looking one. It reads
the plan's identity from the stale field, and measures travel progress toward *that* plan's
objective. So a unit that broke off a duel to run home was being scored as though it were still
sieging. Three other call sites defend against exactly this with a stem test. This one never did.

The fix reconciles the two names in `_switch`, the single point every mission change already flows
through. 240 seeds: **237 → 237**, every stuck column within seven samples. Exactly free.

Shipped on correctness. The tournament's only job was to prove it cost nothing, and a flat result
against a deterministic baseline is the strongest form of that proof.

## Fight, finally described in numbers

`?fightmsn` turns a vehicle duel into a mission that starts and ends. It has never survived a gate.
Now we know what it actually trades:

| | base | fightmsn |
|---|---|---|
| resolved | 237 | **231** |
| stalemates | 3 | **9** |
| avg resolve | 375s | **360s** |
| transit-stuck, near-water | 728 | **246** |
| stuck in `advance` | 833 | **393** |

Fight isn't broken. It makes matches *faster* and dramatically *less stuck* — and much less likely
to end. Units fight instead of doing the job that wins, and the only way to win is to take the flag.

That's a design statement, not a bug: a duel is a legitimate thing to want, and it costs
resolution. Worth knowing precisely before deciding how much of it to buy.

## The one that did replicate — and still isn't shipping

Two days earlier, driving sieging units *onto* their solved firing position instead of stopping
14u short had been measured and switched off. The verdict was blunt: suppress-stuck 254 versus 4,
"the approach cannot take it."

Re-run now, across all three seed sets:

| seed set | base | standarrive |
|---|---|---|
| 11+ | 237 | 239 |
| 5011+ | 237 | 238 |
| 9011+ | 237 | 238 |

The sign never flips. 711 → 715. And suppress-stuck, the column that killed it last time,
*improved* — 36 to 32. Two things landed in between (the nav retry, and the parked-unit fix), and
both act on exactly the bad ground that was blamed. The old verdict was true when it was written
and isn't any more.

So it's a real, replicated, consistent win. It's staying off.

Because of what it costs: near-water transit-stuck **+190%** and **+206%** on the two fresh sets,
stuck in `advance` **+97%** and **+239%**, and matches 18–26 seconds slower. One extra match in
240 resolves, and in exchange there are two to three times as many units standing still.

This game is meant to be *watched*. A number going up while the thing on screen gets duller is a
bad trade, and no amount of statistical significance makes it a good one. It's behind
`?standarrive` if the trade ever looks worth it.

## A tidy piece of evidence

Two candidates were tested: drop the cached route when a support mission ends, or drop the cached
*firing position*. The second came back **per-seed byte-identical** to the combined version across
all 240 matches — not similar, identical. So clearing the standoff commitment does nothing on that
path, and every bit of the regression belongs to clearing the route.

We'd named the standoff as the prime suspect, on the strength of a scar in the code about two
siege slots ping-ponging goals. Wrong. Exonerated by experiment, in one run, unambiguously.

Which is the whole argument for gating one variable at a time: it's the only way a result can tell
you that your favourite theory is wrong.
