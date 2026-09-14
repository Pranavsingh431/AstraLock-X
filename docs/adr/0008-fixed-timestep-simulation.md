# ADR-0008: Fixed-timestep simulation driven by an integer tick index

- **Status:** Accepted
- **Date:** 2026-09-14
- **Phase:** Phase 1

## Context

The simulation has to be watched interactively and executed headlessly, and the
two must agree. Interactive rendering runs at whatever rate the display and the
machine allow — 60 Hz, 144 Hz, or a stutter when a tab is backgrounded. The
physics cannot inherit that.

The tempting design is to advance the world by the elapsed wall-clock time each
frame. It is also wrong for this project: the same scenario would evolve
differently on a fast machine than on a slow one, a dropped frame would inject a
large timestep, and a run could never be reproduced because the frame timings
could never be reproduced.

## Decision

**The authoritative quantity is an integer tick index.** Simulated time is
derived from it, never accumulated:

```
  time = tick / tickRate
```

Not `t += dt`. Accumulation drifts, and worse, it makes the result depend on how
the ticks were grouped: a run stepped a thousand times would land at a slightly
different time from one stepped a thousand at once. Deriving time from a counter
makes those identical by construction, and the test suite asserts it.

**Wall-clock time may decide how many ticks to run. It never decides how large a
tick is.** That translation lives in `PlaybackScheduler`, which takes elapsed
seconds and returns a whole number of ticks plus a sub-tick remainder. The
scheduler is ordinary testable code with no reference to
`requestAnimationFrame`, `performance.now` or the DOM; the caller supplies the
elapsed time.

**Catch-up is bounded.** A backgrounded tab reports an enormous delta on its
next frame. The scheduler emits at most a configured number of ticks per call
and drops the backlog rather than carrying a debt it can never repay. The
simulation falls behind real time; simulated time stays exact. For an
engineering tool that is the right trade — only the animation slips.

**Playback speed scales throughput, not physics.** A multiplier changes how fast
simulated time is consumed against the wall clock. What the world does at a
given simulated time is identical at 0.25x and 4x, which is tested by running
the same scenario at three speeds and comparing the state hash.

**Trajectories are pure functions of time**, not objects nudged each frame.
`sampleAt(t)` returns the same state for the same `t` however the run reached
it, which is what allows the renderer to interpolate between ticks, a future
Replay view to scrub backwards, and a snapshot to be taken at any tick without
moving the engine.

**Interpolation is visualisation only.** The renderer blends the previous and
current states across the sub-tick remainder. The blended value never re-enters
the world, and a test runs identical scenarios under different interpolation
rates and compares the authoritative hash.

## Consequences

- Interactive and headless execution reach identical state for the same tick
  count, tested directly against irregular frame timings.
- A UI freeze cannot corrupt a run: resuming does not inject the pause.
- Long runs are stable. An analytic trajectory evaluated from the tick index
  sits exactly on its closed form after 100,000 ticks, where an integrator
  would have drifted.
- The tick rate becomes a scenario parameter with real consequences, since it
  sets the resolution of everything downstream. It is validated against the
  camera frame rate.
- Every future subsystem has to take its timestep from the clock rather than
  measuring one. That is a discipline cost that will recur in every phase.
- The simulation can fall behind real time on a slow machine and there is no
  signal to the operator yet beyond the tick counter advancing slowly. Worth a
  status indicator later.

## Alternatives considered

**Variable timestep from the frame delta.** The obvious game-loop approach.
Rejected on reproducibility, which is the project's central requirement, and
because a dropped frame becomes a large integration step precisely when the
system is under stress.

**Fixed timestep with an accumulator carrying simulated time.** The standard
"fix your timestep" pattern, and nearly right. Rejected only for the time
derivation: accumulating `t += dt` reintroduces drift and grouping dependence
for no benefit when the tick count is already authoritative.

**Running the simulation inside the render loop.** Fewer moving parts.
Rejected because it ties the simulation's existence to a mounted component and
a visible canvas, which would make headless execution a second code path rather
than the same one.
