window.LAB3 = { html: `
<h3 style="color:#6ab7ff;font-size:14px;letter-spacing:1px;margin:2px 0 6px">Run 3 (v301 afterglow) → Run 4 (v302 commitment bias)</h3>
<p style="font-size:13px;margin:8px 0"><b>Run 3:</b> the afterglow landed — seed 25 dropped from 7 message-storms
&amp; a ×54 state-flap to 2 storms &amp; ×16; total flaps 22 → 15. It exposed driver #2: a
<code style="background:#0a0f16;padding:1px 5px;border-radius:4px;color:#ffcf6a">resupply↔engage ×38</code> strobe — the
fight-or-flight score hovering at zero. v302 added <i>commitment bias</i>: once engaged, only a clearly bad
score (−0.25) disengages.</p>
<p style="font-size:13px;margin:8px 0"><b>Run 4: 3/6 resolved (seeds 39, 53, 67)</b> — the best combined outcome
yet, with 53 and 67 (chronic stalemates) both finishing. The suppress↔engage storms are gone. What survived —
and it's a genuinely interesting find — is that seed 11's ×38 strobe reproduced <i>identically</i>: same tick,
same spot. Deterministic seeds mean unchanged code paths replay exactly, so that flap never touched the
fight-or-flight code at all. Its real driver is the <b>underAttack reflex</b> ("an enemy is on top of us —
answer NOW") strobing on its distance boundary while a dry-ammo jotun drives home with a chaser at the edge
of the radius. Different rule, needs its own hysteresis — next on the list.</p>
<p style="font-size:13px;margin:8px 0">Also on the list from this sweep: the capture↔attack mission loop
(~4 switches/100s in most seeds — functional, seed 53 won through it, but wasteful), and a firebrat that
parks in a map <b>corner</b> on its flank route (seeds 11 &amp; 81, up to 77s) — the "go around the side"
beach point appears to land in unwalkable corner terrain.</p>
<p style="font-size:11px;color:#8fa3b3;margin:8px 0">Builds v299→v302 · four 6-seed sweeps · fixes: gambit
recall deadlock, suppress A* travel, barred-plant gate, exit re-arm cooldown, engage afterglow, fof commitment
bias, log anti-bounce + structured archive.</p>
` };
window.LAB3.html += `
<h3 style="color:#6ab7ff;font-size:14px;letter-spacing:1px;margin:14px 0 6px">Run 5 (v303) — backlog verification</h3>
<p style="font-size:13px;margin:8px 0"><b>Seed 11's ×38 ammo strobe → ×6</b>, same tick, same spot — the
controlled experiment passed. The dry jotun was flipping resupply↔engage on every refill tick, fighting one
round at a time; <i>ammo hysteresis</i> (enter a fight with a usable magazine, ~12%; stay with any) cut the
cadence 6×, and the pad-fight covers the gap by returning fire from inside resupply.</p>
<p style="font-size:13px;margin:8px 0"><b>The corner-parked flank runners are gone</b> (seeds 11 &amp; 81) —
the flank march now caps at 55% of base separation and snaps to standable ground. And <b>seed 25 resolved for
the first time in five runs</b>; seed 39's win is its fastest yet (338s).</p>
<p style="font-size:13px;margin:8px 0">Next layer exposed: <b>runner panic flap</b> — capture firebrats
bouncing <code style="background:#0a0f16;padding:1px 5px;border-radius:4px;color:#ffcf6a">pursue↔flee</code>
under fire (3 seeds, ×7–11), one fleeing firebrat pinned against the map edge with an unstick storm, and a
1-second engage↔resupply micro-strobe on a low-fuel valkyrie. The onion has more layers, but each one is
thinner than the last.</p>
`;
