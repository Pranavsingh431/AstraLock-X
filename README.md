# AstraLock-X

Engineering workbench for coarse **Pointing, Acquisition and Tracking (PAT)** of
mobile **Free Space Optical Communication (FSOC)** links.

[![CI](https://github.com/Pranavsingh431/AstraLock-X/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Pranavsingh431/AstraLock-X/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Platforms](https://img.shields.io/badge/platforms-Linux%20%7C%20macOS%20%7C%20Windows-607D8B.svg)](https://github.com/Pranavsingh431/AstraLock-X/actions/workflows/ci.yml)
[![Status](https://img.shields.io/badge/status-prototype%20%C2%B7%20frozen-blue.svg)](docs/PHASE_STATUS.md)

[![Tauri](https://img.shields.io/badge/Tauri-2-24C8DB.svg)](https://tauri.app)
[![React](https://img.shields.io/badge/React-19-61DAFB.svg)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.0%20strict-3178C6.svg)](https://www.typescriptlang.org)
[![Rust](https://img.shields.io/badge/Rust-1.98-CE422B.svg)](https://www.rust-lang.org)
[![Node](https://img.shields.io/badge/Node-24%20LTS-5FA04E.svg)](https://nodejs.org)

A cross-platform desktop application for developing, simulating and
benchmarking coarse PAT systems. It runs offline, produces reproducible
experiments, and reports measured results rather than illustrative ones.

![Mission Control tracking a target](artifacts/sih/screenshots/01-mission-control-hero.png)

_Mission Control at HANDOFF READY. White workstation chrome around a dark
virtual sensor feed and a dark 3D engineering viewport; every number on screen
was computed by the run it describes._

> **Status: prototype complete and frozen.** Ten development phases, CI green on
> Linux, macOS and Windows. Everything below is implemented and measured; what
> is not built is listed as such rather than implied.
>
> **Two trackers.** _Baseline KF + PID_ is kept unchanged as a scientific
> control. _AstraLock-X Reference PAT_ validates a candidate before committing
> to it, estimates with an interacting multiple model that reports when the
> target is manoeuvring, gates measurements on innovation, points where the
> target will be when the mount responds, coasts and searches locally when it
> loses sight of it, and declares coarse-to-fine handoff readiness from its own
> measurements. Both run through the same plugin contract and the same
> closed-loop runtime. Neither can reach ground truth.
>
> **A plausible decoy used to capture either tracker.** That is now solved, and
> it is the sharpest result here: with coded beacon identity off, AstraLock-X
> false-locks a convincing decoy for 19.4 s and holds 0.279 retention; with it
> on, on identical physics, 0 false locks and 0.907 retention — a 106× reduction
> in post-acquisition RMS pointing error, from one receiver setting.
> [docs/PPT_EVIDENCE.md](docs/PPT_EVIDENCE.md) has the figures and their
> provenance; [docs/PHASE_STATUS.md](docs/PHASE_STATUS.md) is the full ledger.
>
> New here? Start with **[HANDOFF.md](HANDOFF.md)** — how to run it, the
> invariants that must not be broken, and what is left to build.

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
registration-time check, by a lint barrier, by `.test-d.ts` proofs and by a
runtime guard, and it fails closed: a type the compiler cannot prove
ground-truth-free is rejected rather than admitted.
[ADR-0003](docs/adr/0003-ground-truth-isolation.md) explains why several
independent mechanisms rather than one, and
[docs/ALGORITHM_PLUGIN.md](docs/ALGORITHM_PLUGIN.md) enumerates them.

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

| Workspace       | Purpose                                       | Status                                          |
| --------------- | --------------------------------------------- | ----------------------------------------------- |
| Mission Control | Fly a scenario and watch the tracker work     | The operator's workstation (Phase 10)           |
| Scenario Lab    | Author and validate experiment configurations | Scenario summary and disturbance editor         |
| AstraBench      | Compare algorithms across scenarios and seeds | Deterministic benchmarking (Phase 9)            |
| Replay          | Step through a completed run                  | Not implemented — the view says what it will do |
| Calibration     | Estimate intrinsics and gimbal alignment      | Not implemented — the view says what it will do |
| Reports         | Inspect and verify recorded runs              | Reads runs back and recomputes them (Phase 5)   |

The interface has two modes. **Engineering view** — the default — may draw
privileged simulator state: ground truth, the 3D twin, the actuator interior,
the true pointing error. Every one of those is violet-edged and labelled.
**Flight-representative view** removes all of them at once, leaving only what a
real terminal's own software could compute. It changes what is drawn and nothing
else: the same run produces the same numbers either way.

See [docs/UI_GUIDE.md](docs/UI_GUIDE.md) for the design rules the workstation
follows.

## What it looks like working

![Coded beacon identity](artifacts/sih/screenshots/04-coded-identity.png)

_**Coded beacon identity**, on the hard-decoy scenario. Two modulating sources
are in frame. The overlay marks one **MISMATCH** in red and the other
**SELECTED · MATCH** in green; the detector reports two candidates with one
rejected by the gate. No simulator identifier appears anywhere the algorithm can
see, because it is never given one._

![Recovery](artifacts/sih/screenshots/02-recovery.png)

_**RECOVER.** The beacon has gone. The tracker is coasting on its own
prediction — uncertainty ring visibly grown, 57 consecutive misses, recovery age
0.95 s — and the PAT timeline shows the amber excursion at the end of a TRACK
run. The capture waited for the tracker to enter this state on its own._

![Disturbance](artifacts/sih/screenshots/03-disturbance.png)

_**Combined disturbance.** Vibration, attenuation, sensor noise and frame
dropout acting together. The sensor image really is that noisy — it is the frame
the algorithm received, not a filter over a clean one._

![AstraBench](artifacts/sih/screenshots/05-astrabench.png)

_**AstraBench preflight.** Every case with its scenario, arms, declared seed and
success rule — shown **before** the run, because "the comparison was decided in
advance" is only a claim you can check if the plan is on screen._

Each image is real application state, captured by driving the actual controls
and waiting for the tracker's own PAT state. Provenance for every one is in
[artifacts/sih/screenshots/README.md](artifacts/sih/screenshots/README.md), and
[docs/SCREENSHOT_GUIDE.md](docs/SCREENSHOT_GUIDE.md) says how to reproduce them.

## Getting started

New to the codebase — or an AI assistant being pointed at it? Read
**[HANDOFF.md](HANDOFF.md)**: running it, the five invariants that must not be
broken, the traps that cost an hour, and what is left to build.

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
- [docs/BEACON_IDENTITY.md](docs/BEACON_IDENTITY.md) — coded optical beacon identity: why a camera cannot read a fast carrier, the codes, exposure integration, the correlator, measured results and what it cannot do
- [docs/ASTRABENCH.md](docs/ASTRABENCH.md) — deterministic algorithm benchmarking: fairness fingerprints, paired seeds, aggregation, the offline benchmark report and its limits
- [docs/ALGORITHM_PLUGIN.md](docs/ALGORITHM_PLUGIN.md) — writing a tracking algorithm: the contract, what arrives, what it cannot reach, and how to register one
- [docs/PPT_EVIDENCE.md](docs/PPT_EVIDENCE.md) — the submission's source of truth: what is implemented, the verified headline results and their provenance, limitations and future work
- [docs/SIH_COMPLIANCE.md](docs/SIH_COMPLIANCE.md) — the problem statement's requirements mapped to what exists today, with anything incomplete marked
- [docs/SCREENSHOT_GUIDE.md](docs/SCREENSHOT_GUIDE.md) — exact scenario, algorithm and timing for each submission screenshot
- [docs/UI_GUIDE.md](docs/UI_GUIDE.md) — the workstation: colour and its meanings, the design primitives, the two view modes, overlay semantics, and the rules for adding a panel
- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) — setup, commands, conventions
- [docs/PHASE_STATUS.md](docs/PHASE_STATUS.md) — what works, what does not
- [docs/adr/](docs/adr/) — why things are the way they are
- [HANDOFF.md](HANDOFF.md) — picking this up: orientation, invariants, traps, and the remaining roadmap

## Status and scope

This is a **prototype**, complete and frozen for a submission. It is a
development and verification workbench, not flight software, and it does not
claim flight readiness.

Built and measured: the deterministic digital twin, the virtual optical camera,
the dynamic gimbal, two autonomous PAT algorithms, physically parameterized
disturbances, coded optical beacon identity, experiment recording with
recomputable reports, and deterministic benchmarking.

Deliberately not built, and labelled as future work in the interface rather than
hidden: replay, calibration, hardware-in-the-loop, a learned verifier, and an
operating-envelope explorer. [HANDOFF.md](HANDOFF.md) says where each would
start.

## Licence

MIT
