# ADR-0011: The mount's true pose and its measured pose are different quantities

- **Status:** Accepted
- **Date:** 2026-09-14
- **Phase:** Phase 3

## Context

Phase 2's `IdealCameraMount` had one pose. Commanding it set that pose exactly
and instantly, and both the image and the frame metadata came from that single
number. Its own documentation said this was a placeholder.

Replacing it with a real actuator forces a question that the ideal mount let us
avoid: **which angle forms the image, and which angle goes on the frame?**

On real hardware these are never the same number. The optics sit wherever the
mechanism has actually put them. The controller knows only what the encoder
reports — a quantised reading, accurate to half a count at best. The gap between
them is not noise to be averaged away; it is a permanent structural feature of
every pointing system, and it is precisely the thing a coarse-PAT controller has
to be robust to.

Using one number for both would produce a simulator in which:

- the encoder error is invisible, because the pixels are generated from the same
  angle the frame reports;
- a tracking algorithm can invert its own image formation exactly, because the
  pose it is handed perfectly explains the pixels it received;
- backlash, deadband and settling would still be modelled, but their _observable
  consequence_ — that you cannot trust your own pose report — would be gone.

That last point is the one that matters. A controller developed against such a
simulator would be tuned against a problem strictly easier than the real one,
and the flattery would be invisible.

## Decision

The mount exposes **three** distinct states, and each has exactly one job.

**COMMAND** — what was asked for. The operator's or controller's intent. Held as
the axis setpoint after clamping to travel.

**TRUE** — the output angle of the mechanism, after servo dynamics, limits,
travel stops and backlash. This is where the lens physically is, so **this and
only this forms the image**. It is branded ground truth.

**MEASURED** — the encoder reading: `round(true / resolution) · resolution`.
**This and only this goes on the `CameraSensorFrame`.** It is algorithm-safe.

Rate follows the same rule. There is no tachometer in the model, so the reported
rate is differenced from successive encoder _readings_, not sampled from the
true rate:

```
  derivedRate = (measured_k − measured_{k−1}) / (t_k − t_{k−1})
```

which is what a controller differencing its own history would get, quantisation
noise included.

The mount's interior — motor angle, motor rate, backlash take-up, the
acceleration the servo demanded before the limit clipped it, the saturation
flags — is collected into an `ActuatorTruth` record, branded as ground truth and
reachable only by the three consumers ADR-0003 already permits: the simulator,
evaluation, and debug views explicitly labelled as such.

The ESLint barrier is extended to make `@/core/gimbal` unreachable from the
tracking side, by alias, by relative path, and by type-only import.
`@/core/contracts/gimbal` stays reachable, because a controller legitimately
needs to say where it wants the mount pointed and to know the travel and rate it
must work within. Neither is truth.

## Consequences

**Good.**

- The encoder error is real and unavoidable. A future controller must cope with
  a pose report that is wrong by up to half a count, as it would on hardware.
- A tracking algorithm cannot invert image formation exactly, because the pose
  it was given is not the pose the pixels came from.
- Backlash and deadband have visible optical consequences rather than merely
  internal ones — there are frames in which the motor moves and the picture does
  not, and the test suite asserts it.
- The debug panel can show the whole mechanism, honestly labelled, without
  widening what any algorithm can reach.

**Costs and risks.**

- Three states rather than one is more to hold in mind, and the distinction has
  to be respected at every boundary. The compiler helps — `SensorCameraPose`
  names all three explicitly and the geometry path takes `trueAzimuth` — but
  discipline is still required.
- Sensor tests must now be explicit about which pose they mean. Several Phase 2
  tests were updated accordingly; one that asserted the reported pose equalled
  the configured pointing exactly now asserts it is within half a count, which
  is a stricter and more meaningful statement.
- Anything wanting the mount's pose between ticks must go through the
  interpolating accessor, because a stateful mechanism has no closed form.

**Rejected alternatives.**

_One pose, with noise added to the reported value._ Additive noise is not
quantisation: it is zero-mean and averages away, whereas an encoder's error is
deterministic given the angle and does not. Modelling a rounding as a random
variable would make an easier problem look like a harder one.

_Report the true rate._ Simpler, and wrong: no encoder measures rate. A
controller given the true rate is given a derivative nobody has.

_Leave the ideal mount available alongside the real one._ Two mounts means every
consumer chooses, and the ideal one is always the convenient choice. It was
deleted.
