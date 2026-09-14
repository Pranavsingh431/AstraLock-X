# `core/estimation`

Associates observations across frames and maintains `TargetEstimate`s —
filtering, track initiation, coasting and termination.

Unprivileged. Invents its own `TrackId`s; never sees a simulator `TargetId`.

_Arrives in Phase 3. Empty by design at Phase 0._
