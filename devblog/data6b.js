window.LAB6B = { html: `
<h3 style="color:#6ab7ff;font-size:14px;letter-spacing:1px;margin:2px 0 6px">Sweep 13 — the curse breaks</h3>
<p style="font-size:13px;margin:8px 0"><b>Seed 25: RESOLVED, t=753s — and the winner is GREY, the team whose
runner was the dancer.</b> The commit ring (v314) turned out to be necessary but unreachable: measurement
showed the runner turning back 170–270u from the flag, at <b>100% health the entire time</b> — "Taking fire"
was never literal. <code style="background:#0a0f16;padding:1px 5px;border-radius:4px;color:#ffcf6a">runnerFlee</code>
trips on mere <i>proximity</i>, so fear calibrated for mid-game survival was vetoing the championship point.</p>
<p style="font-size:13px;margin:8px 0"><b>Fix (v315):</b> with the flag grabbable and the runner healthy, a
sighting no longer turns it around — only real incoming fire does. A hurt runner still evades; a runner being
shot still breaks off; the 85u dash still commits unconditionally. Risk ladder intact, cowardice removed.</p>
<p style="font-size:13px;margin:8px 0">Seed 25 had stalemated in 11 of 12 sweeps. Its thirteenth match ended
with a flag on a pedestal — and with this, <b>every one of the six benchmark seeds has been won</b> under the
current AI. The remaining stalemates are chaos, not curses.</p>
` };
