# `core/experiments`

Runs experiments: the tick loop that drives simulator and algorithm in
lockstep, the event log, seed sweeps, and batch execution for AstraBench.

Owns reproducibility. A run is identified by its config and seed, and repeating
that pair must reproduce the run exactly. See ADR-0004.

_Arrives in Phase 5. Empty by design at Phase 0._
