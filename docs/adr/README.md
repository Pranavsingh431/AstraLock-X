# Architecture Decision Records

Each file records one decision: what was decided, what forced the decision, and
what it costs. They are written when the decision is made and are not rewritten
afterwards — a decision that turns out to be wrong gets a new record that
supersedes the old one, so the reasoning at the time stays visible.

| ADR                                                      | Title                                                                 | Status   |
| -------------------------------------------------------- | --------------------------------------------------------------------- | -------- |
| [0001](0001-tauri-react-typescript.md)                   | Tauri with a React and TypeScript frontend                            | Accepted |
| [0002](0002-separate-simulation-from-tracking.md)        | Simulation and tracking are separate subsystems                       | Accepted |
| [0003](0003-ground-truth-isolation.md)                   | Ground-truth isolation policy                                         | Accepted |
| [0004](0004-deterministic-seeded-experiments.md)         | Deterministic, seeded experiments                                     | Accepted |
| [0005](0005-typescript-core-with-rust-later.md)          | TypeScript core first, Rust or WASM only where profiling justifies it | Accepted |
| [0006](0006-engineering-coordinate-convention.md)        | East-North-Up engineering frame, with an explicit renderer mapping    | Accepted |
| [0007](0007-deterministic-prng-and-stream-derivation.md) | xoshiro128\*\* with per-subsystem stream derivation                   | Accepted |
| [0008](0008-fixed-timestep-simulation.md)                | Fixed-timestep simulation driven by an integer tick index             | Accepted |
| [0009](0009-cpu-sensor-not-webgl-readback.md)            | The authoritative camera is CPU-side, not a WebGL readback            | Accepted |
| [0010](0010-independent-sensor-clock.md)                 | The camera has its own clock                                          | Accepted |
| [0011](0011-true-versus-measured-actuator-state.md)      | The mount's true pose and its measured pose are different quantities  | Accepted |

Use [0000-template.md](0000-template.md) for new records.
