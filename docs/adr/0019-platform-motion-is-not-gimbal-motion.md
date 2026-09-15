# ADR-0019: The platform moves, and the encoder cannot see it

## Status

Accepted (Phase 7).

## Context

Phase 7 adds disturbances that stress the trackers. The most important of them
is motion of the structure the gimbal is bolted to, because a mobile FSOC
terminal spends its life on something that moves.

There were two ways to implement it.

**As gimbal-axis motion**: perturb the mount's own angles. Simple, and wrong.
The gimbal encoder measures the axes, so the tracker would see the disturbance
in its own pose reading and could subtract it out. The test would be measuring
whether an algorithm can do arithmetic.

**As base attitude**: a separate orientation that composes with the gimbal's
output to give the camera's orientation in the world.

## Decision

Base attitude is a distinct quantity. The camera's optical orientation is

```
  optical azimuth   = gimbal azimuth   + base azimuth
  optical elevation = gimbal elevation + base elevation
```

and **the encoder reports the gimbal term alone**. No safe sensor exposes base
attitude, because this terminal has no attitude reference. Base motion is
therefore invisible to a tracker except as image motion.

The **evaluator composes the same base attitude** into its optical axis. Scoring
against the gimbal alone would report a mount holding its aim perfectly while the
target slid across the image.

Base attitude is evaluated at each sub-exposure instant, so vibration during an
exposure produces real motion blur rather than a rigid shift.

Three components sum: a constant bias, a sum of fixed tones evaluated in closed
form, and a correlated Ornstein-Uhlenbeck jitter per axis.

## Consequences

**Good.**

- Vibration is a genuine test of tracking rather than of bookkeeping. The
  tracker can only respond to what it sees.
- It exposed a real property of AstraLock-X immediately: base excursions of a
  few hundred microradians are many sigma of the IMM's own uncertainty, so its
  chi-square innovation gate rejects legitimate measurements and retention
  collapses. That is a finding about the estimator's assumptions, and it is only
  visible because the disturbance is unmodelled by construction.
- The distinction survives into the record: evaluation truth carries the base
  attitude separately, so a reader can see how much of a pointing error the
  platform contributed.

**Costs and risks.**

- Two places now compose base attitude — the sensor and the evaluator — and they
  must agree. They agree by construction, because every process is a pure
  function of the frame index, but it is a coupling that did not exist before.
- A future phase that adds an attitude sensor (an IMU) will have to decide
  deliberately what it exposes. The default must stay "nothing": an IMU that
  perfectly reported base attitude would hand the tracker the answer.
- No motor-torque disturbance is implemented. Base attitude and shaft torque are
  different physical things and the Phase 3 actuator hook remains unused; adding
  both when one suffices would be complexity without measurable benefit.

## Alternatives rejected

- **Perturbing the target instead.** Moving the target to imitate vibration would
  make the evaluator's line of sight move too, so pointing error would not
  register the disturbance at all — the very thing being measured.
- **Exposing base attitude on `GimbalState`.** It would be a lie about the
  instrument, and it would make every vibration scenario trivial.
