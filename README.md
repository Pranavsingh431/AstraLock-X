# AstraLock-X

Engineering workbench for coarse **Pointing, Acquisition and Tracking (PAT)** of
mobile **Free Space Optical Communication (FSOC)** links.

A cross-platform desktop application for developing, simulating, benchmarking
and — eventually — hardware-in-the-loop validation of coarse PAT systems. It
runs offline, produces reproducible experiments, and reports measured results
rather than illustrative ones.

> **Status: Phase 0.5 — foundation, proved cross-platform.** Data contracts,
> ground-truth isolation, pinned toolchains, tests, CI and the application
> shell are in place, with CI green on Linux, macOS and Windows. There is no
> simulator and no tracking algorithm yet, and every view in the application
> says so. See [docs/PHASE_STATUS.md](docs/PHASE_STATUS.md).

## What the problem is

A mobile FSOC link is a laser between two platforms that are moving. The beam is
narrow — often around a milliradian — so the two ends have to find each other and
then stay pointed at each other while the platforms move and vibrate. Coarse PAT
is the first stage of that: a gimbal and a camera searching for the other
terminal, acquiring it, and holding it inside the capture range of the fine
pointing stage.

Getting this right is mostly about failure modes that are rare and conditional:
a disturbance peak landing during a dropped frame, a target crossing a gimbal
travel limit, a filter that is confidently wrong. Those are hard to study on
hardware and easy to study in simulation — but only if the simulation is honest
about what the tracker can see, and only if a run that fails can be reproduced.

## What this application does about it

**The tracker cannot see the answer.** The simulator knows where every target is.
A tracking algorithm never does. It receives camera frames and measured gimbal
encoder readings, and nothing else. This is enforced by the type system, by a
registration-time check, by a lint barrier, and by a runtime guard, and it fails
closed: a type the compiler cannot prove ground-truth-free is rejected rather
than admitted. [ADR-0003](docs/adr/0003-ground-truth-isolation.md) explains why
four mechanisms rather than one.

**Every run is reproducible.** A run is fully determined by its configuration
and seed. There is no wall-clock input, no unseeded randomness, and each
stochastic subsystem draws from its own stream so that adding noise in one place
does not silently change results everywhere else
([ADR-0004](docs/adr/0004-deterministic-seeded-experiments.md)).

**Nothing is fabricated.** Every number displayed comes from a computation that
actually ran. Views that have no data to show are empty and labelled, rather
than filled with plausible-looking placeholders.

## Views

| View            | Purpose                                       | Status                    |
| --------------- | --------------------------------------------- | ------------------------- |
| Mission Control | Live view of a running experiment             | Not implemented (Phase 6) |
| Scenario Lab    | Author and validate experiment configurations | Not implemented (Phase 2) |
| AstraBench      | Compare algorithms across scenarios and seeds | Not implemented (Phase 5) |
| Replay          | Step through a completed run                  | Not implemented (Phase 5) |
| Calibration     | Estimate intrinsics and gimbal alignment      | Not implemented (Phase 4) |
| Reports         | Export experiment summaries                   | Not implemented (Phase 5) |

## Getting started

Prerequisites: Node.js 24 LTS, Corepack, and [rustup](https://rustup.rs). The
exact pnpm and Rust versions are pinned by the repository, so nothing else needs
choosing. See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for the full setup.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm tauri:dev
```

Frontend only, in a browser:

```bash
pnpm dev
```

Run everything CI runs:

```bash
pnpm verify
```

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — how the system is put together
- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) — setup, commands, conventions
- [docs/PHASE_STATUS.md](docs/PHASE_STATUS.md) — what works, what does not
- [docs/adr/](docs/adr/) — why things are the way they are

## Licence

MIT
