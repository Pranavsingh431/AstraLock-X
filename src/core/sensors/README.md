# `core/sensors`

Turns world state into what a device would actually report: camera frames with
shot and read noise, and gimbal encoder readings with quantisation, bias and
latency.

This is the boundary between the privileged and unprivileged sides. Ground
truth goes in; `CameraSensorFrame`, `CameraState` and `GimbalState` come out.
The fidelity of that degradation is what makes the rest of the measurement
meaningful — a noiseless sensor would make every tracker look good.

_Arrives in Phase 2. Empty by design at Phase 0._
