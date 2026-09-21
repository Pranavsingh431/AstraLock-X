# Submission evidence

The source of truth for the presentation. Every number here was produced by
running the current code, and every one names where it came from. Nothing is
recalled from an earlier phase report.

Raw artifacts: [`artifacts/sih/evidence/`](../artifacts/sih/evidence/)

- `quick-validation.json` — the full AstraBench Quick Validation aggregate and
  manifest, 12 runs, 43.8 s wall.
- `experiments.json` — two recorded 40 s experiments on `code-decoy-hard`, each
  verified by recomputation from its own raw files (**0 differences**).

---

## Problem

A mobile free-space-optical terminal has to find a distant partner, lock onto
it, and hold that lock while the platform it is bolted to vibrates, the
atmosphere distorts the beam and other bright things appear in the field of
view. The optical beam is narrow enough that pointing error translates directly
into lost link margin, and the hard part is not the optics — it is the
pointing, acquisition and tracking loop and the evidence that it works.

Developing that loop against real hardware is slow, expensive, and — worst for
engineering — not repeatable. The same disturbance never happens twice.

## Our solution

AstraLock-X is a software workbench for developing and verifying coarse PAT
algorithms for mobile FSOC terminals. It provides a deterministic digital twin,
a virtual optical camera, a dynamic gimbal, physically parameterized
disturbances, coded optical beacon identity, autonomous PAT algorithms,
experiment recording with recomputable reports, and deterministic benchmarking.

The design commitment that matters: **a tracking algorithm receives only what a
real terminal's software would have** — pixels, its believed calibration, and
the measured mount state. Everything the simulator knows is held on the other
side of a boundary enforced five independent ways.

## System architecture

```
  scenario (validated document, seeded)
        │
        ▼
  deterministic engine ──► virtual optical camera ──► mono8 frame
        │                        ▲                          │
        │                        │                          ▼
        │                  disturbance engine        ┌──────────────┐
        │                  (frame-indexed)           │  ALGORITHM   │  ← the boundary
        ▼                                            │  detector    │
   gimbal model ◄──────────── command ───────────────│  estimator   │
   (servo, latency,                                  │  controller  │
    backlash, encoder)                               │  identity    │
        │                                            └──────────────┘
        ▼
   evaluation (privileged) ──► experiment record ──► report ──► AstraBench
```

Everything left of the boundary is simulator truth. Everything inside the
algorithm box is what a real terminal would have.

## What is actually implemented

| Subsystem                     | State                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------ |
| Deterministic simulation core | Seeded PRNG, fixed-tick engine, ENU frame, six trajectory families                               |
| Virtual optical camera        | Pinhole projection, point spread, exposure integration, `mono8` frames, independent camera clock |
| Dynamic gimbal                | Servo dynamics, transport latency, deadband, backlash, torque limits, encoder quantisation       |
| Baseline PAT                  | Detector, pixel-to-bearing, Kalman filter, PID, scan pattern — the control arm                   |
| AstraLock-X PAT               | IMM estimator (CV/CA), NIS gating, coasting, local recovery search, handoff readiness            |
| Disturbance engine            | 10 modelled effects, frame-indexed realization, fingerprinted into the scenario                  |
| Coded beacon identity         | Exposure-integrated code correlation with phase recovered by search                              |
| Experiment recorder           | Event, telemetry and evaluation logs; summary recomputable from them                             |
| AstraBench                    | Fairness-fingerprinted paired comparison across scenarios, seeds and algorithms                  |
| Reports                       | Reads runs back and recomputes every field to verify the stored summary                          |

Not implemented, and labelled as such in the interface: replay, calibration,
hardware-in-the-loop.

## Why AstraLock-X is different

Most simulation demos can be made to succeed. Three properties here make the
results mean something:

1. **The algorithm cannot cheat, structurally.** Ground-truth isolation is
   enforced by compile-time proofs, an admission function, an ESLint import
   barrier, a runtime guard and type-level tests (ADR-0003). The test suite
   asserts the exact set of keys an algorithm receives, and that none of them
   matches `/engine|world|truth|evaluat|scenario|target|emitter|disturb/i`.
2. **Comparisons are fair by construction.** Every arm of a benchmark case flies
   identical physics — same scenario, same seed, same disturbance realization —
   verified by fingerprint. A case whose arms disagree is reported **invalid**
   rather than reduced to a winner.
3. **Results are recomputable.** Both experiments below were regenerated from
   their own raw files and matched the stored summary in every field.

There is deliberately **no overall score**. Seconds, microradians and a
retention fraction have no exchange rate.

## Key experiments

### A. Coded beacon identity — the headline

`code-decoy-hard`: two optical sources, both modulating, one of them the
designated terminal. 40 s, AstraLock-X, seed from the scenario. The only
difference between the two runs is whether the receiver was configured to look
for a code.

|                            |     Identity OFF |    Identity ON |
| -------------------------- | ---------------: | -------------: |
| Acquisition (coarse)       |          13.12 s |        13.12 s |
| Lock retention             |        **0.279** |      **0.907** |
| False-lock episodes        |            **3** |          **0** |
| False-lock duration        |       **19.4 s** |      **0.0 s** |
| Unrecovered losses         |                1 |              0 |
| Post-acquisition RMS error | **282 337 µrad** | **2 652 µrad** |
| Track-state RMS error      |     266 196 µrad | **2 302 µrad** |
| Track-state median error   |     131 283 µrad |   **106 µrad** |
| Correct code associations  |                — |          1 690 |
| Wrong code associations    |                — |          **0** |
| Mean match correlation     |                — |          0.929 |
| Recompute verification     |    0 differences |  0 differences |

_Source: `artifacts/sih/evidence/experiments.json`, metrics definition v3._

A ~106× reduction in post-acquisition RMS pointing error, from one receiver
setting. The tracker is the same in both runs.

### B. AstraBench Quick Validation

Six cases, one declared seed (9101), two arms each, 12 runs, 43.8 s wall.
Suite fingerprint `suite:sha256:a87ed252…`. Every case's comparison validated as
same-physics.

| Case                         | Baseline acq / RMS |      AstraLock-X acq / RMS |
| ---------------------------- | -----------------: | -------------------------: |
| Acquisition from outside FOV | 16.05 s / 287 µrad | **12.53 s** / **257 µrad** |
| Smooth crossing              | 30.10 s / 384 µrad | **13.12 s** / **341 µrad** |
| Manoeuvring target           | 29.35 s / 371 µrad | **13.22 s** / **297 µrad** |
| Short loss and return        | 41.37 s / 617 µrad | **23.27 s** / **322 µrad** |

And the two cases that are _not_ a clean win, which is why they are here:

| Case                | Arm                       | Outcome                                                           |
| ------------------- | ------------------------- | ----------------------------------------------------------------- |
| Hard decoy, uncoded | Baseline KF + PID         | succeeded, RMS 315 µrad, retention 1.000                          |
| Hard decoy, uncoded | AstraLock-X               | **failed** — RMS 361 635 µrad, retention 0.235, 24.4 s false lock |
| Hard decoy, coded   | AstraLock-X, identity off | **failed** — RMS 361 636 µrad, retention 0.235                    |
| Hard decoy, coded   | AstraLock-X, identity on  | succeeded, RMS 2 435 µrad, retention 0.922                        |

_Source: `artifacts/sih/evidence/quick-validation.json`._

This is the honest shape of the result. Against a convincing decoy, the more
sophisticated tracker does **worse** than the baseline on one realization — its
own confidence carries it onto the wrong source. What fixes it is not a better
filter; it is giving the receiver something to verify identity against. The
benchmark shows the failure rather than hiding it.

### C. Processing performance

Per-frame host cost, mean over 2 401 frames at 60 Hz (identity ON run):

| Stage                   |         Mean |          p95 |
| ----------------------- | -----------: | -----------: |
| Sensor frame generation |       614 µs |       694 µs |
| Detector                |       969 µs |     1 084 µs |
| Estimator (IMM)         |       115 µs |       165 µs |
| Identity correlator     |        66 µs |       139 µs |
| Controller              |       1.6 µs |       4.5 µs |
| **Algorithm total**     | **1 280 µs** | **1 612 µs** |
| World step              |       0.6 µs |       1.0 µs |

Against a 16.7 ms budget at 60 Hz, the whole algorithm costs under 10% of a
frame. Simulation runs at roughly 8× real time on this machine.

_Source: `artifacts/sih/evidence/experiments.json`._

## Ground-truth isolation

The property everything else rests on. An algorithm's `step` receives exactly
six keys: `tick`, `time`, `frame`, `camera`, `gimbal`, `previousCommand`. The
test suite asserts that set exactly, and asserts that no key matches
`/engine|world|truth|evaluat|scenario|target|emitter|disturb/i`.

Five independent barriers, enumerated in
[ALGORITHM_PLUGIN.md](ALGORITHM_PLUGIN.md) and motivated by
[ADR-0003](adr/0003-ground-truth-isolation.md): compile-time proofs, `defineAlgorithm`
admission, an ESLint import barrier on the privileged modules, a runtime
`guardTrackingInput`, and `.test-d.ts` type-level proofs.

In the interface the same boundary is visible: privileged panels are
violet-edged and labelled, and one control switches to a
flight-representative view that removes all of them — changing only what is
drawn, never what is computed.

## Disturbance testing

Ten modelled effects, each physically parameterized rather than a severity
slider: platform vibration tones and jitter, atmospheric attenuation,
scintillation, angular wander, exposure, defocus, background, read noise, shot
noise and frame dropouts. The realization is indexed by frame (ADR-0020), so
the same scenario and seed produce the same disturbance on any machine and in
any run order — which is what makes a paired comparison possible at all.

Disturbance parameters are written into the scenario document and fingerprinted
with it. A preset fills the fields in and is then irrelevant.

## Limitations

- **Coarse pointing only.** No fine-pointing stage is modelled. HANDOFF READY is
  a readiness claim, nothing more.
- **Five seeds is a small sample.** No statistical significance is claimed.
- **No hardware in the loop.** Every result is simulation.
- **Sequential execution.** No worker parallelism; the 90-run engineering suite
  takes about four minutes.
- **Single-machine timing.** Processing figures are from one Apple-silicon
  laptop and are not a platform claim.
- **Atmospheric model is phenomenological.** Scintillation and wander are
  parameterized statistical effects, not a resolved turbulence simulation.

## Future work

Deferred to a potential finals round, not present in this prototype:

- real camera and gimbal hardware-in-the-loop
- a calibration workflow that estimates intrinsics and camera-to-gimbal alignment
- replay: stepping a recorded run against its event log
- an optional learned verifier for candidate discrimination
- an operating-envelope explorer mapping where the tracker fails
- a larger statistical benchmark suite with significance testing
- validation against a real FSOC terminal
