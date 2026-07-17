// Driver.js — THE driver (Layer 0/1 of the driver architecture, see
// devblog/2026-07-16-driver-architecture.md). One driver sits in each fielded vehicle's
// seat. Behaviors don't emit motor math any more — they issue ORDERS ("GOTO this point")
// and the driver executes them with his pedals (Locomotion.js) plus his route-following
// skill (the injected A* waypoint follower). Everything the driver does is observable:
// every order is logged, telemetry runs every tick, and a flight recorder keeps the last
// ~12s so that when movement fails, the ALARM ships a full autopsy instead of a shrug.
//
// Slice 1 scope (the shell that holds the full design):
//   orders:  GOTO(x, z, arrive)  — route-follow via A*, locomote motor core
//            DIRECT              — combat footwork still steers itself; the driver only
//                                  observes (recorder + watchdog stay hot). Later slices
//                                  replace DIRECT with ALIGN/ORBIT/KITE/JOUST orders.
//   honesty: a GOTO whose route can't actually REACH the goal (A* partial path stops
//            short) is a Layer-2 contract violation — logged loudly, once per order.
//            The driver still walks the partial route for now; refusal lands when the
//            commanders learn to handle "no". Every violation is counted.
//   alarm:   a driver-owned net-progress watchdog (independent of the legacy jolt
//            machinery, which stays until the root causes are dead). No real ground
//            covered while the pedals are pressed → ALARM: flight-recorder dump to the
//            alarm sink + the ai log. Still pinned after the grace period → the unit
//            SELF-DESTRUCTS (loudly). No mud in this game: a stuck vehicle is a bug,
//            and a bug should cost the team, not pirouette for minutes.

import { locomote } from './Locomotion.js?v=1';

const REC_MAX = 120;          // flight-recorder ring: ~12s at the 0.1s sample floor
const REC_DT = 0.1;           // min seconds between recorder samples
const WATCH_WIN = 8;          // s — net-progress sampling window
const WATCH_MIN_MOVE = 6;     // u — under this much net ground in a window = no progress.
                              // 6u/8s = 0.75u/s: catches the CREEPER (a hull grinding a wall
                              // at ~0.3u/s "makes progress" past every naive clock — tournament
                              // recalls crept for 182s) while staying far below real travel speed.
const WATCH_WANT = 0.3;       // |pedal| above this counts as "trying to move"
const ALARM_WINDOWS = 2;      // consecutive no-progress windows before the alarm fires
const GOTO_STALL = 16;        // s — a GOTO making NO headway toward its goal this long = alarm.
                              // This is the ORBIT catcher: a circling unit covers plenty of
                              // ground (the pin detector never trips) while its distance-to-goal
                              // goes nowhere. Progress = getting CLOSER, not just moving.
const GOTO_STALL_MIN = 1;     // u — closing this much on the goal counts as headway
const GRIND_FRAC = 0.15;      // actual ground under this fraction of COMMANDED×nominal speed =
                              // a GRIND: pedals hard down, hull barely moving (wall friction,
                              // slope shove, crowd press). The seed-109 recall crept at ~1u/s —
                              // a tenth of a Lurcher's 14u/s — past both the pin floor AND the
                              // stall clock (it genuinely closed on home, glacially).
const GRIND_CMD_MIN = 0.5;    // only judge grind when the window's avg pedal is a real demand
const DESTRUCT_GRACE = 15;    // s pinned AFTER the alarm before the unit scuttles itself
const UNREACH_SLACK = 9;      // u — route ends farther than this from the goal = partial path

export class Driver {
  // hooks = {
  //   navWaypoint(nav, v, dest, dt) → {x,z}|null   — the A* path cache/follower
  //   log(team, msg)                               — ai battle log
  //   alarm(dump)                                  — alarm sink (autopsy collector)
  //   selfDestruct(v, why)                         — the scuttle (main.js damage path)
  // }
  constructor(hooks) {
    this.hooks = hooks;
    this.v = null;
    this.nav = null;           // the slot's shared A* cache record (owner may null .path)
    this.o = null;             // active order
    this.rec = [];             // flight-recorder ring
    this.alarms = 0;           // alarms fired for the CURRENT vehicle
    this.violations = 0;       // unreachable-GOTO contracts caught (current vehicle)
    this._recT = 0;
    this._winT = 0; this._winX = 0; this._winZ = 0; this._wantT = 0;
    this._cmdT = 0; this._why = 'pin';         // grind bookkeeping + last no-progress reason
    this._noProgWins = 0;      // consecutive windows with no net progress
    this._alarmT = -1;         // >=0: seconds since the alarm fired (grace countdown)
    this._lastPed = null;      // pedals actually driven this tick (set by note())
  }

  // Re-seat the driver each tick. A NEW vehicle (fresh deploy / swap) resets the
  // recorder and the watchdog — the old unit's flight data died with it.
  bind(v, nav, team, cname) {
    if (v !== this.v) {
      this.v = v; this.o = null; this.rec.length = 0; this.alarms = 0; this.violations = 0;
      this._recT = 0; this._winT = 0; this._wantT = 0; this._noProgWins = 0; this._alarmT = -1;
      this._winX = v.holder.position.x; this._winZ = v.holder.position.z;
      this._winD = null; this._lastGoto = null; this._cmdT = 0; this._why = 'pin';
    }
    this.nav = nav; this.team = team; this.cname = cname;
  }

  // Issue an order. Re-issuing the "same" order every tick (travel states recompute their
  // goal each frame) folds into the standing order: a GOTO whose goal only drifted keeps
  // its metadata and its violation latch; a genuinely NEW order (type changed, goal jumped,
  // different issuer/state) replaces it and is logged.
  //   o = { type:'GOTO', x, z, arrive, by, why } | { type:'DIRECT', by }
  order(o) {
    const cur = this.o;
    const same = cur && cur.type === o.type && cur.by === o.by
      && (o.type !== 'GOTO' || (Math.abs(cur.x - o.x) < 2 && Math.abs(cur.z - o.z) < 2));
    if (same) {
      if (o.type === 'GOTO') { cur.x = o.x; cur.z = o.z; cur.arrive = o.arrive; }   // goal drift
      return cur;
    }
    o.t0 = 0;                   // order age (ticks up in note())
    o.violated = false;         // unreachable-contract latch (log once per order)
    if (o.type === 'GOTO') {
      const p = this.v.holder.position;
      o.d0 = Math.hypot(o.x - p.x, o.z - p.z);   // start distance → progress %
      // ORDER CHURN must not launder a stall: brain-state flicker (advance→engage→advance)
      // re-issues "the same trip" as a fresh order every flip, and a wall-grinding unit's
      // stall clock reset to zero each time (autopsy: full pedals, stationary, stallT 0.1).
      // Same destination = same trip: inherit the previous attempt's progress bookkeeping.
      const lg = this._lastGoto;
      if (lg && Math.abs(lg.x - o.x) < 3 && Math.abs(lg.z - o.z) < 3) {
        o.bestD = lg.bestD; o.stallT = lg.stallT; o.violated = lg.violated; o.d0 = lg.d0;
      }
    }
    if (cur && cur.type === 'GOTO') this._lastGoto = { x: cur.x, z: cur.z, bestD: cur.bestD, stallT: cur.stallT || 0, violated: cur.violated, d0: cur.d0 };
    this.o = o;
    return o;
  }

  // Execute the active order → pedals {fwd, turn, strafe}, or null when the order is
  // DIRECT (the behavior's own motor output stands). GOTO: follow the A* route through
  // the shared nav cache; the last leg uses the order's arrive radius so the unit
  // settles instead of micro-hunting the exact cell centre.
  tick(dt) {
    const o = this.o, v = this.v;
    if (!o || o.type !== 'GOTO') return null;
    const dest = { x: o.x, z: o.z };
    const wp = this.hooks.navWaypoint(this.nav, v, dest, dt);
    this._checkReach(dest);
    if (!wp) return null;                        // no route at all — caller's fallback stands
    const last = this.nav.path && this.nav.idx >= this.nav.path.length - 1;
    return locomote(
      { x: v.holder.position.x, z: v.holder.position.z, heading: v.heading, omni: !!v._move.omni },
      { goto: wp, arrive: last ? Math.min(o.arrive || 2, 2) : 0.001 });
  }

  // GOTO honesty (the contract): A* runs with partial:true, so an unreachable goal comes
  // back as a route to the closest reachable cell — which the old code walked SILENTLY,
  // then ground against whatever separated it from the real goal (the walled-fob orbit).
  // The driver names it: route ends far short of the goal → that's the ISSUER's bug
  // (Layer 2 asked for the impossible). Logged once per order, counted always.
  _checkReach(dest) {
    const o = this.o, path = this.nav && this.nav.path;
    if (!path || !path.length || o.violated) return;
    // A budget-truncated search proves NOTHING about reachability — the goal may just be far
    // (a long trek on a big map exhausts maxNodes long before it exhausts the island). Only a
    // search that EMPTIED its open set — settled every reachable cell and the goal wasn't
    // there — convicts the order. Acting on budget partials was the false-conviction bug:
    // reachable pursuit contacts written off, good siege stands rotated away, resolution -4.
    if (path.budgetHit) return;
    const end = path[path.length - 1];
    const short = Math.hypot(end.x - dest.x, end.z - dest.z);
    if (short > Math.max(UNREACH_SLACK, o.arrive || 0)) {
      o.violated = true; this.violations++; Driver.violationsTotal++;
      Driver.violationsBy[o.by || '?'] = (Driver.violationsBy[o.by || '?'] || 0) + 1;   // WHO orders the impossible (Slice-2 targeting data)
      this.hooks.log(this.team, `[NAV CONTRACT] ${this.cname}: ${this.v.type} ordered to unreachable `
        + `(${Math.round(dest.x)},${Math.round(dest.z)}) by ${o.by || '?'} — route ends ${Math.round(short)}u short. `
        + `Walking the partial route; the ORDER is the bug.`);
    }
  }

  // Observe the tick that actually drove the vehicle — whatever produced the pedals
  // (a GOTO above, or the behavior's own combat footwork under DIRECT). Feeds the
  // flight recorder and the net-progress watchdog. Call ONCE per tick, at drive time.
  note(dt, ped, blk) {
    const v = this.v; if (!v || v.dead) return;
    this._lastPed = ped;
    const o = this.o; if (o) o.t0 += dt;
    // flight recorder (ring)
    this._recT += dt;
    if (this._recT >= REC_DT) {
      this._recT = 0;
      this.rec.push({
        t: +(performance.now() / 1000).toFixed(1),
        x: +v.holder.position.x.toFixed(1), z: +v.holder.position.z.toFixed(1),
        h: +v.heading.toFixed(2),
        f: +(ped.fwd || 0).toFixed(2), r: +(ped.turn || 0).toFixed(2), s: +(ped.strafe || 0).toFixed(2),
        blk: blk || '···', ord: o ? this.label() : '-',
      });
      if (this.rec.length > REC_MAX) this.rec.shift();
    }
    // net-progress watchdog — the driver's own, independent of the legacy jolt machinery:
    // sampling NET displacement over a window catches every wedge class at once (feeler-
    // blind shore slides included). "Trying to move" = any pedal pressed hard enough.
    const wants = Math.abs(ped.fwd || 0) > WATCH_WANT || Math.abs(ped.strafe || 0) > WATCH_WANT;
    if (wants) this._wantT += dt;
    this._cmdT += Math.min(1, Math.abs(ped.fwd || 0) + Math.abs(ped.strafe || 0)) * dt;   // window's commanded-throttle integral (grind check)
    // GOTO goal-progress stall — the orbit catcher. Any real closing on the goal resets
    // the clock (and stands an armed alarm down); driving hard without ever getting
    // closer runs it up. DIRECT orders skip this (combat holds ground on purpose).
    // A VIOLATED order accrues even with the pedals OFF: a unit that walked its partial
    // route to the end "arrives" (locomote settles, pedals go quiet) while standing far
    // short of an unreachable goal — the silent soft-lock the autopsy caught. Standing
    // at the end of a route that never reached the order IS the failure, motion or not.
    if (o && o.type === 'GOTO' && (wants || o.violated)) {
      const d = Math.hypot(o.x - v.holder.position.x, o.z - v.holder.position.z);
      if (!wants && d <= (o.arrive || 2) + 2) { /* genuinely arrived — nothing to stall */ } else
      if (o.bestD == null || d < o.bestD - GOTO_STALL_MIN) {
        o.bestD = d; o.stallT = 0;   // stall clock resets on any closing — but an ARMED alarm
        // does NOT stand down here: a creeper closes 1u every few seconds forever. Recovery
        // is judged once per window below, at a rate no wall-grind can fake.
      } else {
        o.stallT = (o.stallT || 0) + dt;
        if (o.stallT > GOTO_STALL && this._alarmT < 0) this._fireAlarm(o.violated && !wants ? 'partial-freeze' : 'stall');
      }
    }
    this._winT += dt;
    if (this._winT >= WATCH_WIN) {
      const moved = Math.hypot(v.holder.position.x - this._winX, v.holder.position.z - this._winZ);
      const pinned = this._wantT > WATCH_WIN * 0.6 && moved < WATCH_MIN_MOVE;
      // GRIND: expected ground = avg commanded throttle × the chassis' nominal speed; actual
      // ground under GRIND_FRAC of that means the hull is being held back by something the
      // pedals can't beat — whatever the absolute numbers.
      const avgCmd = this._cmdT / WATCH_WIN; this._cmdT = 0;
      const nom = (v.def && v.def.speed) || 10;
      const ground = avgCmd > GRIND_CMD_MIN && moved < avgCmd * nom * WATCH_WIN * GRIND_FRAC;
      const noProg = pinned || ground;
      this._why = pinned ? 'pin' : ground ? 'grind' : this._why;
      this._noProgWins = noProg ? this._noProgWins + 1 : 0;
      // RECOVERY (alarm stand-down), judged once per window: real ground covered AND — when
      // still on a GOTO — real closing on the goal (≥4u/window ≈ 0.5u/s). An orbit moves
      // without closing; a creeper closes without moving fast; neither counts as recovered.
      if (this._alarmT >= 0 && !noProg) {
        const closed = (o && o.type === 'GOTO' && this._winD != null)
          ? this._winD - Math.hypot(o.x - v.holder.position.x, o.z - v.holder.position.z) : null;
        if (closed == null || closed >= 4) { this._alarmT = -1; if (o) o.stallT = 0; }
      }
      this._winD = (o && o.type === 'GOTO')
        ? Math.hypot(o.x - v.holder.position.x, o.z - v.holder.position.z) : null;
      this._winT = 0; this._wantT = 0;
      this._winX = v.holder.position.x; this._winZ = v.holder.position.z;
      if (noProg && this._noProgWins >= ALARM_WINDOWS && this._alarmT < 0) this._fireAlarm(this._why);
    }
    // scuttle countdown: pinned right through the post-alarm grace → the driver ends it
    if (this._alarmT >= 0) {
      this._alarmT += dt;
      if (this._alarmT > DESTRUCT_GRACE) {
        this.hooks.log(this.team, `[NAV ALARM] ${this.cname}: ${v.type} still pinned ${Math.round(WATCH_WIN * ALARM_WINDOWS + this._alarmT)}s after the alarm — scuttling it. This is a BUG, see the flight recording.`);
        this._alarmT = -1;
        this.hooks.selfDestruct(v, 'nav-alarm');
      }
    }
  }

  _fireAlarm(why = 'pin') {
    const v = this.v, o = this.o;
    this.alarms++; Driver.alarmsTotal++;
    this._alarmT = 0;
    const dump = {
      when: Date.now(), why, team: this.team, cname: this.cname, type: v.type,
      x: +v.holder.position.x.toFixed(1), z: +v.holder.position.z.toFixed(1),
      order: o ? { ...o } : null, label: this.label(),
      navPath: this.nav && this.nav.path ? this.nav.path.length : 0,
      navIdx: this.nav ? this.nav.idx : 0,
      rec: this.rec.slice(),                    // the last ~12s, tick by tick
    };
    this.hooks.log(this.team, `[NAV ALARM · ${why}] ${this.cname}: ${v.type} is making NO ground `
      + `@(${Math.round(v.holder.position.x)},${Math.round(v.holder.position.z)}) on ${this.label()} — `
      + `flight recording dumped (${this.rec.length} samples). ${DESTRUCT_GRACE}s to break free.`);
    this.hooks.alarm(dump);
  }

  // One-line order description — the chain-of-command display's "maneuver" row.
  label() {
    const o = this.o; if (!o) return 'idle';
    if (o.type === 'GOTO') {
      const p = this.v.holder.position;
      const d = Math.hypot(o.x - p.x, o.z - p.z);
      const prog = o.d0 > 1 ? Math.max(0, Math.min(100, Math.round((1 - d / o.d0) * 100))) : 100;
      return `GOTO(${Math.round(o.x)},${Math.round(o.z)}) ${prog}% · ${Math.round(d)}u left`
        + (o.violated ? ' · UNREACHABLE' : '');
    }
    return `DIRECT (${o.by || 'combat'})`;
  }

  // The chain-of-command display's "driver" row: the pedals this tick, in plain words.
  pedals() {
    const p = this._lastPed; if (!p) return '-';
    const bits = [];
    if (Math.abs(p.fwd || 0) > 0.05) bits.push((p.fwd > 0 ? 'fwd ' : 'rev ') + Math.abs(p.fwd).toFixed(1));
    if (Math.abs(p.turn || 0) > 0.05) bits.push((p.turn > 0 ? 'right ' : 'left ') + Math.abs(p.turn).toFixed(1));
    if (Math.abs(p.strafe || 0) > 0.05) bits.push((p.strafe > 0 ? 'slide-R ' : 'slide-L ') + Math.abs(p.strafe).toFixed(1));
    return bits.length ? bits.join(' · ') : 'hold';
  }
}
Driver.alarmsTotal = 0;       // match-wide counters (the nightly "alarms per match" metric)
Driver.violationsTotal = 0;
Driver.violationsBy = {};     // unreachable orders per issuing state — names the Layer-2 bugs
