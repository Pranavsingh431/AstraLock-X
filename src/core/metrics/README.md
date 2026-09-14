# `core/metrics`

Scores a run by comparing telemetry against ground truth: pointing-error
statistics, time in lock, acquisition time, false tracks.

Privileged — this is one of the three legitimate consumers of ground truth, and
solving the track-to-target association is part of its job. The lint barrier
prevents the tracking side from importing it, since doing so would create an
indirect path to the answer key.

_Arrives in Phase 5. Empty by design at Phase 0._
