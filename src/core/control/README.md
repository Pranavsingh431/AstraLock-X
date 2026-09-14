# `core/control`

Turns a track estimate into a `ControlCommand`: the pointing loop, rate
feed-forward, and saturation handling.

Unprivileged. Closes the loop on measured gimbal state, not true state.

_Arrives in Phase 4. Empty by design at Phase 0._
