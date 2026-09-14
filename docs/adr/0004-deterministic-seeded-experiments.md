# ADR-0004: Deterministic, seeded experiments

- **Status:** Accepted
- **Date:** 2026-09-14
- **Phase:** Phase 0

## Context

Tracking failures are usually rare and conditional. A loop holds lock for
ninety-nine runs and breaks on the hundredth, when a disturbance peak lands
during a frame drop while the gimbal is near a rate limit. That hundredth run is
the interesting one, and it is worthless if it cannot be reproduced.

Reproducibility is also what makes comparison valid. Saying algorithm A beats
algorithm B means nothing unless both faced the same world — the same noise
draws, the same dropped frames, the same disturbance.

## Decision

A run is fully determined by its `SimulationConfig`, which includes a
`SimulationSeed`. The same pair must reproduce the run exactly.

This implies several rules:

- **No ambient nondeterminism.** No `Date.now()`, no `performance.now()` feeding
  simulation state, no `Math.random()`. Simulated time advances by tick count.
  Wall-clock time is recorded as a _result_ — how long the algorithm took — and
  never as an input. `Math.random` is blocked by a lint rule with a message
  pointing here.

- **Independent random streams.** Each stochastic subsystem derives its own
  stream from the root seed. Adding a noise source to the camera model must not
  shift the draws the disturbance model makes, or every previously recorded run
  would silently change. This is why the seed is a root from which streams are
  derived rather than a single shared generator.

- **Algorithms get a seeded generator too.** `AlgorithmInit.random` supplies a
  uniform stream on `[0, 1)` derived from the run seed and independent of the
  simulator's streams. A particle filter or a randomised search pattern is
  therefore reproducible, and changing the algorithm cannot perturb the
  scenario.

- **Resumable state.** `WorldState` carries the cursor of every random stream,
  so a paused-and-resumed run continues exactly as an uninterrupted one would.

- **Configs are parsed, not trusted.** `SimulationConfig` has a Zod schema with
  cross-field rules — exposure cannot exceed the frame period, travel limits
  cannot be inverted, the physics tick rate cannot be below the frame rate. A
  config that is accepted is one the simulator can actually run.

- **Results carry their inputs.** `ExperimentSummary` includes the config, the
  seed and a config fingerprint, so any recorded result can be re-run.

## Consequences

- Any run can be reproduced from its summary, including the rare failure.
- Algorithm comparisons are valid, because runs can be held identical except for
  the algorithm.
- Seed sweeps become the natural way to characterise an algorithm: a
  distribution over many seeds rather than a number from one run.
- Regression testing gets easy. Store a config and its expected summary; a
  change in behaviour shows up as a diff.
- It costs discipline in every future phase. Every new stochastic element needs
  its own stream, and every new timing path has to distinguish simulated time
  from wall-clock time.
- Parallel execution must be careful. Runs may execute concurrently, but a
  single run's streams must be drawn in a fixed order, which constrains how a
  tick can be parallelised internally.
- Floating-point results are reproducible on one platform but not guaranteed
  bit-identical across architectures. Metrics comparisons should use tolerances
  rather than exact equality; exact reproduction is guaranteed per machine.

## Alternatives considered

**Recording and replaying sensor output instead of re-simulating.** Reproduces a
run exactly with no constraints on the simulator. Rejected as the primary
mechanism because recordings are large, cannot answer "what if the algorithm
were different", and do not permit seed sweeps. Recording remains useful for
capturing real hardware sessions.

**A single global generator.** Simplest to implement. Rejected because it
couples every subsystem: adding one draw anywhere shifts every subsequent draw
everywhere, invalidating stored results for reasons unrelated to the change.
