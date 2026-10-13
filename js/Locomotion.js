// Locomotion.js — THE one steering primitive. Every behavior that wants a vehicle to be
// somewhere describes WHAT it wants (an order); this converts it into motor output that
// respects the chassis' kinematics. Before this, travel/siege/combat each carried their own
// inline copy of "turn = err*2, fwd = 1" — and every copy re-grew the same bugs on its own
// schedule (binary throttle → the turning-circle orbit; ungated strafe → sidestepping tank
// treads). Fix it here, every state inherits it.
//
//   locomote(kin, order) → { fwd, turn, strafe }
//
//   kin   = { x, z, heading, omni }   — omni: chassis translates in ANY direction (the
//           Lurcher's six legs); everything else steers like a tank (nose-first).
//   order = { goto: {x,z} | null      — where to be (null = hold position)
//           , face: {x,z} | null      — keep the nose on THIS while moving (else face travel)
//           , arrive: r }             — settle radius (default 8)
//
// Conventions (match the game): heading 0 = -Z; bearing err = wrapPi(atan2(-dx,-dz) - heading).
// strafe > 0 slides the hull to its local RIGHT at STRAFE_FRAC of forward speed.

const PIVOT = 0.6;     // |err| above this (≈34°): pivot in place, no forward (tank chassis)
const EASE = 0.25;     // |err| above this (≈14°): half throttle while lining up
const LATERAL_SPAN = 2;   // u of sideways offset over which a face-locked tank hands its nose to the travel
const DEAD = 0.06;     // |err| below this: drive dead straight (anti-wobble)

export function wrapPi(a) { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; }
const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;

export function locomote(kin, order) {
  const arrive = order.arrive ?? 8;
  const g = order.goto;
  const dx = g ? g.x - kin.x : 0, dz = g ? g.z - kin.z : 0;
  const dist = g ? Math.hypot(dx, dz) : 0;
  const want = g && dist >= arrive;                    // still travelling?

  // Which way the NOSE should point: an explicit face target wins; else the travel direction.
  const f = order.face;
  const faceErr = f ? wrapPi(Math.atan2(-(f.x - kin.x), -(f.z - kin.z)) - kin.heading)
    : (want ? wrapPi(Math.atan2(-dx, -dz) - kin.heading) : 0);
  const turn = Math.abs(faceErr) < DEAD ? 0 : clamp(faceErr * 2.2, -1, 1);

  if (!want) return { fwd: 0, turn, strafe: 0, arrived: true };

  const travelErr = wrapPi(Math.atan2(-dx, -dz) - kin.heading);   // goal bearing off the nose
  if (kin.omni) {
    // OMNI (the Lurcher): translate straight at the goal RIGHT NOW — forward and sideways
    // components of the goal bearing — while the nose swings independently (to the face
    // target if given). No turning circle: the orbit failure class doesn't exist here.
    // strafe axis: +1 = local right = bearing -π/2, so a goal at travelErr=-π/2 wants +1.
    return { fwd: clamp(Math.cos(travelErr) * 1.4, -1, 1),
             strafe: clamp(-Math.sin(travelErr) * 1.4, -1, 1),
             turn, arrived: false };
  }
  // TANK chassis: face-locked movement can only use the forward axis — advance when the goal
  // is ahead of the nose, back up when it's behind (that's how a kiting unit retreats while
  // shooting). Free-nose travel eases throttle by alignment: pivot → half → full. This ease
  // IS the anti-orbit fix — full speed + full turn arcs around any goal inside the turning
  // circle forever ("the spinning lurcher").
  const a = Math.abs(travelErr);
  const fwd = f ? clamp(Math.cos(travelErr) * 1.3, -1, 1)
    : (a > PIVOT ? 0 : a > EASE ? 0.5 : 1);
  if (f) {
    // A TANK HELD ON A FACE TARGET MOVES ONLY ALONG ITS OWN AXIS, so a goal off to the side is out of reach: it slides to the
    // point abeam of the goal and parks there with the throttle at zero. Seed 12242: a Jotun whose shot was buried in a bank,
    // sent to a firing spot 6u to its side with its nose held on the rival, rocked a metre back and forth for over a hundred
    // seconds. The further the goal sits off the face line, the more the hull swings onto the goal's line, so it drives in and
    // squares back up on the face as the offset closes.
    // Offset measured off the FACE line, not the hull's: measured off the hull it shrinks as the hull turns to meet it and
    // the swing stalls halfway (simulated: a 20u sidestep took 19s); off the face line it shrinks only as the ground closes.
    const faceH = kin.heading + faceErr, goalH = kin.heading + travelErr;
    const lateral = dist * Math.abs(Math.sin(goalH - faceH));
    const w = clamp((lateral - arrive * 0.5) / LATERAL_SPAN, 0, 1);   // under half of `arrive` abeam, the axis alone lands it
    if (w > 0) {
      // nose or tail onto the goal's line: whichever is nearer the HULL. Picking by the face flipped end to end with a goal
      // dead abeam (any drift crosses the tie) and the hull swung back and forth between the two.
      const axisH = Math.abs(travelErr) <= Math.PI / 2 ? goalH : goalH + Math.PI;
      const err2 = wrapPi(faceH + w * wrapPi(axisH - faceH) - kin.heading);
      return { fwd, turn: Math.abs(err2) < DEAD ? 0 : clamp(err2 * 2.2, -1, 1), strafe: 0, arrived: false };
    }
  }
  return { fwd, turn, strafe: 0, arrived: false };
}
