# AstraLock-X

Engineering workbench for coarse **Pointing, Acquisition and Tracking (PAT)** of
mobile **Free Space Optical Communication (FSOC)** links.

A cross-platform desktop application for developing, simulating, benchmarking
and — eventually — hardware-in-the-loop validation of coarse PAT systems. It
runs offline, produces reproducible experiments, and reports measured results
rather than illustrative ones.

> **Status: Phase 6 — robust reference PAT engine.** There are now two trackers.
> **Baseline KF + PID** is unchanged from Phase 4 and is kept as a scientific
> control. **AstraLock-X Reference PAT** is the robust implementation: it
> validates a candidate before committing to it, estimates with an interacting
> multiple model that reports when the target is manoeuvring, gates measurements
> on innovation, points where the target will be when the mount responds, coasts
> and searches locally when it loses sight of it, and declares coarse-to-fine
> handoff readiness from its own measurements.
>
> Both run through the same plugin contract and the same closed-loop runtime,
> and a paired harness runs them on identical physics so the comparison means
> something. Neither can reach ground truth.
>
> Identity is still unsolved: a plausible decoy inside the association gate can
> capture either tracker, and a test says so.
> See [docs/PHASE_STATUS.md](docs/PHASE_STATUS.md).

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
than filled with plausible-looking placeholders, and quantities the current
phase does not model report null rather than a plausible guess —
[docs/SIMULATION.md](docs/SIMULATION.md) lists them explicitly.

**The renderer is a view, not the simulation.** The authoritative world is plain
TypeScript that runs without React, Three.js or a browser, so the same code path
serves a test, the interactive UI and a future headless benchmark runner
([ADR-0006](docs/adr/0006-engineering-coordinate-convention.md)).

## Views

| View            | Purpose                                       | Status                                      |
| --------------- | --------------------------------------------- | ------------------------------------------- |
| Mission Control | Live view of a running experiment             | Disturbance status added (Phase 7)          |
| Scenario Lab    | Author and validate experiment configurations | Physical disturbance editor added (Phase 7) |
| AstraBench      | Compare algorithms across scenarios and seeds | Not implemented (Phase 5)                   |
| Replay          | Step through a completed run                  | Not implemented (Phase 5)                   |
| Calibration     | Estimate intrinsics and gimbal alignment      | Not implemented (Phase 4)                   |
| Reports         | Export experiment summaries                   | Not implemented (Phase 5)                   |

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
- [docs/SIMULATION.md](docs/SIMULATION.md) — coordinates, clock, PRNG, trajectory equations, and what is not modelled
- [docs/SENSOR_MODEL.md](docs/SENSOR_MODEL.md) — pinhole projection, camera clock, point spread, the frame contract and the truth boundary
- [docs/GIMBAL_MODEL.md](docs/GIMBAL_MODEL.md) — the actuator: servo dynamics, latency, deadband, backlash, encoder quantisation, measured accuracy and what is not modelled
- [docs/ASTRALOCK_PAT.md](docs/ASTRALOCK_PAT.md) — the robust reference tracker: states, acquisition evidence, IMM mathematics, gating, prediction to actuation, recovery, handoff readiness, measured results and known weaknesses
- [docs/BASELINE_PAT.md](docs/BASELINE_PAT.md) — the control algorithm: detector, pixel-to-bearing, Kalman filter, PID, search, control timing, measured results and known weaknesses
- [docs/EXPERIMENTS.md](docs/EXPERIMENTS.md) — recording a run: lifecycle, artifacts, run identity, storage, recomputation and reproducibility
- [docs/METRICS.md](docs/METRICS.md) — every KPI formula, denominator, unit and N/A rule
- [docs/REPORTING.md](docs/REPORTING.md) — the generated offline report and the Reports screen
- [docs/DISTURBANCE_MODEL.md](docs/DISTURBANCE_MODEL.md) — camera-observable platform, propagation-style, sensor and transport disturbances
- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) — setup, commands, conventions
- [docs/PHASE_STATUS.md](docs/PHASE_STATUS.md) — what works, what does not
- [docs/adr/](docs/adr/) — why things are the way they are

## Licence

MIT
