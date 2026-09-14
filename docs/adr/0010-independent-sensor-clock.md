# ADR-0010: The camera has its own clock

- **Status:** Accepted
- **Date:** 2026-09-14
- **Phase:** Phase 2

## Context

Three rates are now in play and none of them divides the others:

- **physics**, 200 Hz in the bundled scenarios, fixed by ADR-0008;
- **the camera**, 30 to 120 FPS depending on the instrument;
- **the display**, 60 Hz or 144 Hz or whatever the machine manages.

The tempting implementation is to capture every _N_-th physics tick with
`N = round(tickRate / frameRate)`. At 200 Hz and 60 FPS that is
`round(3.33) = 3`, which is 66.7 FPS — an 11% timing error, present in every
timestamp, and invisible because the frames still arrive at a plausible rate.
A future tracker estimating velocity from those timestamps would be 11% wrong
about every speed in the scenario.

The second temptation is to let the render loop decide. That makes sensor
timestamps a property of the monitor the experiment happened to run on.

## Decision

The camera runs on an independent clock, and capture times come from the frame
index by a single division:

```
  captureTime(frameIndex) = frameIndex / frameRate
```

Never `t += 1 / frameRate`. Accumulation drifts, and over a ten-minute run at
60 FPS the drift is large enough to matter; a single division cannot drift at
all, so the thirty-six-thousandth frame is exactly as accurate as the first.

Frames due in an interval are found with a half-open query,
`(afterTime, throughTime]`, so repeated stepping never captures a frame twice
and never skips one: each call's upper bound becomes the next call's lower
bound. The index bounds are computed by multiplication and then corrected
against the actual capture times, because `frameIndex / frameRate` and
`time * frameRate` are not exact inverses in binary floating point — at 60 FPS
`(1/60) * 60` is not exactly 1, and a bound derived by multiplication alone is
occasionally off by one. The corrections run at most twice.

Because capture times fall between physics ticks, world state is sampled at the
exact capture time rather than at the nearest tick. That is possible because
Phase 1 made trajectories pure functions of time, so there is no approximation
to document. An interpolating sampler is also provided, with linear position
and shortest-path angular interpolation, for the case a later phase makes the
world depend on its own previous state; its error is bounded by `a h^2 / 8`,
which at 5 ms and 6 m/s^2 is under 19 micrometres.

Sensor sampling is **not** display interpolation. The renderer blends frames
for smooth motion at the display's rate; the sensor decides what the instrument
actually saw. Neither feeds the other.

## Consequences

- 30, 50, 60, 90 and 120 FPS all work correctly over 200 Hz physics, each
  producing exactly `rate * seconds + 1` frames over a run. This is tested per
  rate rather than argued.
- The capture schedule is identical under headless stepping and under
  interactive scheduling with irregular frame times, which is asserted directly
  against 60 Hz, 144 Hz and stuttering cadences.
- Sensor timestamps are a property of the experiment, not of the machine.
- The camera can be faster than the physics tick. Nothing prevents configuring
  500 FPS over 200 Hz; exact sampling means those frames are still correct, they
  simply sample the same continuous trajectories more often. Whether that is
  _physically_ sensible is a scenario question, and the schema's requirement
  that `tickRate >= frameRate` currently forbids it.
- Every future consumer has to take capture time from the frame rather than
  from a tick index. That is a discipline cost, and it is the reason
  `captureTime` is on the frame contract rather than left to be inferred.

## Alternatives considered

**Capture every N-th tick.** Simple and wrong whenever the rates do not divide,
which is the common case. Rejected above.

**Constrain frame rates to divisors of the tick rate.** Would make the simple
implementation correct. Rejected because it makes the instrument's
specification a function of the simulator's step size, which is backwards: a
real camera runs at 60 FPS whatever the simulation does.

**Accumulate capture time as frames are produced.** Matches how a naive game
loop tracks time. Rejected for drift, and because it would make the schedule
depend on how the run was stepped.
