# Architecture Decision Records

Each file records one decision: what was decided, what forced the decision, and
what it costs. They are written when the decision is made and are not rewritten
afterwards — a decision that turns out to be wrong gets a new record that
supersedes the old one, so the reasoning at the time stays visible.

| ADR                                                        | Title                                                                 | Status   |
| ---------------------------------------------------------- | --------------------------------------------------------------------- | -------- |
| [0001](0001-tauri-react-typescript.md)                     | Tauri with a React and TypeScript frontend                            | Accepted |
| [0002](0002-separate-simulation-from-tracking.md)          | Simulation and tracking are separate subsystems                       | Accepted |
| [0003](0003-ground-truth-isolation.md)                     | Ground-truth isolation policy                                         | Accepted |
| [0004](0004-deterministic-seeded-experiments.md)           | Deterministic, seeded experiments                                     | Accepted |
| [0005](0005-typescript-core-with-rust-later.md)            | TypeScript core first, Rust or WASM only where profiling justifies it | Accepted |
| [0006](0006-engineering-coordinate-convention.md)          | East-North-Up engineering frame, with an explicit renderer mapping    | Accepted |
| [0007](0007-deterministic-prng-and-stream-derivation.md)   | xoshiro128\*\* with per-subsystem stream derivation                   | Accepted |
| [0008](0008-fixed-timestep-simulation.md)                  | Fixed-timestep simulation driven by an integer tick index             | Accepted |
| [0009](0009-cpu-sensor-not-webgl-readback.md)              | The authoritative camera is CPU-side, not a WebGL readback            | Accepted |
| [0010](0010-independent-sensor-clock.md)                   | The camera has its own clock                                          | Accepted |
| [0011](0011-true-versus-measured-actuator-state.md)        | The mount's true pose and its measured pose are different quantities  | Accepted |
| [0012](0012-exact-servo-discretisation.md)                 | The servo's unsaturated step is taken in closed form                  | Accepted |
| [0013](0013-command-intent-and-issue-time.md)              | An algorithm states intent; the runtime decides when it happened      | Accepted |
| [0014](0014-evaluation-reads-truth-one-way.md)             | Evaluation reads ground truth; nothing reads evaluation back          | Accepted |
| [0015](0015-persisted-raw-data-is-the-source-of-truth.md)  | A run's summary is computed from its persisted raw files              | Accepted |
| [0016](0016-host-time-is-not-simulated-time.md)            | Host processing time and simulated latency are different quantities   | Accepted |
| [0017](0017-interacting-multiple-model-estimation.md)      | Two motion models, interacting — not one model, and not a race        | Accepted |
| [0018](0018-prediction-to-actuation-and-recovery.md)       | Point where the target will be, and coast when it disappears          | Accepted |
| [0019](0019-platform-motion-is-not-gimbal-motion.md)       | The platform moves, and the encoder cannot see it                     | Accepted |
| [0020](0020-disturbance-randomness-is-indexed-by-frame.md) | A disturbance realization is a function of the frame index            | Accepted |
| [0021](0021-image-snr-is-defined-or-absent.md)             | Image SNR is stated with its formula, or not stated at all            | Accepted |
| [0022](0022-dropped-frames-are-absent-frames.md)           | A dropped frame is an absent frame                                    | Accepted |

Use [0000-template.md](0000-template.md) for new records.
