# `core/pat`

The acquisition state machine: scan, acquire, track, reacquire, and the
transitions between them.

Unprivileged. Decides when a track is trustworthy using only what the tracker
itself can observe.

_Arrives in Phase 4. Empty by design at Phase 0._
