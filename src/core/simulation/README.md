# `core/simulation`

Owns the world: platform and target motion, atmospheric effects, and the
advance of simulated time.

This is the only place that may construct `GroundTruthState` and `WorldState`.
It is on the privileged side of the ground-truth boundary, so nothing in
`core/perception`, `core/estimation`, `core/control`, `core/pat` or
`core/algorithms` may import from it — enforced by the lint barrier in
`eslint.config.js`.

Everything here must be a pure function of `SimulationConfig` and the run seed.
No wall-clock reads, no unseeded randomness. See ADR-0004.

_Arrives in Phase 1. Empty by design at Phase 0._
