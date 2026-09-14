# Architecture Decision Records

Each file records one decision: what was decided, what forced the decision, and
what it costs. They are written when the decision is made and are not rewritten
afterwards — a decision that turns out to be wrong gets a new record that
supersedes the old one, so the reasoning at the time stays visible.

| ADR                                               | Title                                                                 | Status   |
| ------------------------------------------------- | --------------------------------------------------------------------- | -------- |
| [0001](0001-tauri-react-typescript.md)            | Tauri with a React and TypeScript frontend                            | Accepted |
| [0002](0002-separate-simulation-from-tracking.md) | Simulation and tracking are separate subsystems                       | Accepted |
| [0003](0003-ground-truth-isolation.md)            | Ground-truth isolation policy                                         | Accepted |
| [0004](0004-deterministic-seeded-experiments.md)  | Deterministic, seeded experiments                                     | Accepted |
| [0005](0005-typescript-core-with-rust-later.md)   | TypeScript core first, Rust or WASM only where profiling justifies it | Accepted |

Use [0000-template.md](0000-template.md) for new records.
