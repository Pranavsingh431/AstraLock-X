# Architecture

## The shape of the thing

AstraLock-X is a simulation harness with a strict boundary through the middle.
On one side is a world the application knows everything about. On the other is a
tracking algorithm that must work from what a camera and a gimbal would actually
report. The value of every measurement the application produces depends on that
boundary holding.

```
                      privileged                 |            unprivileged
                                                 |
  SimulationConfig ──► core/simulation ──────────┼──► core/sensors ──┐
       + seed          (world, truth, mount)     |    (degrade)      │
                                ▲                |                   ▼
                                │                |          ┌─────────────────┐
                                │                |          │ core/perception │
                                │                |          │ core/estimation │
                                │                |          │ core/control    │
                                │                |          │ core/pat        │
                                │                |          │ core/algorithms │
                                │                |          └────────┬────────┘
                                │                |                   │
                                ▼                |                   ▼
                         core/metrics ◄──────────┼──────────  ControlCommand
                          (score a run)          |             TelemetrySample
                                ▲                |            GimbalPositionCommand
                                │                |                   │
                                ▼                |                   │
                       ExperimentSummary ◄───────┴───────────────────┘
```

Everything crossing the boundary left-to-right passes through `core/sensors`.
Nothing crosses right-to-left except gimbal commands — a `GimbalPositionCommand`
naming where the mount should point. The mount answers over simulated time and
imperfectly, and what comes back is a camera frame, so the loop closes through
the sensor like everything else. `core/metrics` reads both
sides but only ever writes to reports — it observes the tracker from outside and
never feeds it.

## Layout

```
src/
  app/          Application shell: view registry, routing state, shortcuts
  components/   ui/ holds shadcn primitives; shell/ holds the frame
  features/     One directory per view
  core/
    contracts/  All shared types. The only module every layer may depend on
    simulation/ The world. Sole producer of ground truth. Plain TypeScript:
                no React, no Three.js, no DOM — enforced by lint
    sensors/    Truth to observable. The boundary. The virtual camera lives
                here: pinhole projection, point-spread rasterisation, its own
                frame clock. Plain TypeScript, no WebGL (ADR-0009)
    gimbal/     The pan/tilt mount: servo dynamics, limits, deadband, backlash,
                encoder quantisation, command latency. Privileged — it holds the
                actuator interior, so the lint barrier keeps it away from the
                tracking side (ADR-0011)
    runtime/    The closed-loop runtime. The only place world, mount, camera and
                algorithm meet. Owns causality: frame ordering, command issue
                time, frame-lease lifetime. Privileged (ADR-0013)
    experiments/Recording, the KPI engine and reporting. The recorder is a
                LoopObserver; the evaluator reads ground truth to score a
                tracker from outside; summaries are computed from the persisted
                raw files. Privileged (ADR-0014, ADR-0015, ADR-0016,
                docs/EXPERIMENTS.md, docs/METRICS.md, docs/REPORTING.md)
    perception/ Frames to detections
    estimation/ Detections to tracks
    control/    Tracks to gimbal commands
    pat/        Acquisition state machine
    metrics/    Reserved for cross-run scoring; per-run scoring lives in
                experiments/
    algorithms/ AlgorithmPlugin implementations and their registry. The most
                restricted directory: it may not reach ground truth, the
                simulator, the sensor, the mount, the runtime, the bundled
                scenarios or the experiment evaluator.
                  baseline/  the Phase 4 control: threshold detector, CV Kalman,
                             PID, raster search (docs/BASELINE_PAT.md)
                  astralock/ the robust reference: validated acquisition, IMM,
                             gated association, latency-aware control,
                             predictive recovery, handoff readiness
                             (docs/ASTRALOCK_PAT.md, ADR-0017, ADR-0018)
  workers/      Web Workers for the tick loop and batch runs
  stores/       Zustand stores for UI state
  lib/          Small shared utilities
  styles/       Tailwind theme
  test/         Test setup and fixtures

src-tauri/      Rust host: window creation, and later device I/O
docs/adr/       Architecture decision records
```

The dependency rule is that `core` never imports from `app`, `components`,
`features` or `stores`. The UI depends on the core; the core does not know the
UI exists. This keeps the core runnable in a worker, in a test, or from a
command line.

## The simulation core is not the renderer

The authoritative world lives in `core/simulation`, in plain TypeScript. It is
driven from tests, and will be driven from a headless benchmark runner, using
the same code path the interactive UI uses.

```
  SimulationEngine  ──►  WorldState (frozen, branded)
         │                      │
         │                      ├──►  evaluation / metrics
         │                      │
         └──────────────────────┴──►  observer-view adapter  ──►  React Three Fiber
```

Rendering reads the core. Nothing writes back. If world truth lived in
`Object3D.position`, in React state, or in `useFrame` timing, then "the
simulation" would be whatever the renderer happened to be showing, and a run
could not be reproduced without a GPU.

The same rule governs the sensor, for the same reason. The virtual camera
computes pixels on the CPU from an explicit pinhole model; the canvas in Mission
Control displays that buffer and plays no part in creating it
([ADR-0009](adr/0009-cpu-sensor-not-webgl-readback.md)). Three clocks run
independently — physics at a fixed tick, the camera at its own frame rate, the
display at whatever the machine manages — and only the first two affect what is
recorded ([ADR-0010](adr/0010-independent-sensor-clock.md)). A lint rule stops `src/core` importing
React, Three.js, `@react-three/*` or any store, and a test runs the real ESLint
configuration over probe files to confirm the rule still fires.

The mount obeys the same discipline. It is a stateful mechanism on the physics
clock, and image formation uses its **true** output angle while the frame
carries the **measured** encoder reading — two numbers that differ by up to half
a count and must not be conflated
([ADR-0011](adr/0011-true-versus-measured-actuator-state.md),
[GIMBAL_MODEL.md](GIMBAL_MODEL.md)).

Recording obeys it too, from the other side. The experiment recorder is a
`LoopObserver`: the runtime tells it about each frame after the algorithm has
produced its output and the command has been submitted, and about each command
after the mount applied it. It cannot alter algorithm input, command timing,
mount state or the progression of simulated time, and attaching or detaching it
rebuilds nothing. Tests run scenarios with recording off and on — including with
a failing and with a deliberately slow writer — and require identical
transitions, commands, final pose and world hash. Wall-clock time may differ;
the simulation may not. The recorder keeps no per-sample state: it writes raw
files, and the summary is computed afterwards from those files by the same code
an offline recomputation uses
([ADR-0014](adr/0014-evaluation-reads-truth-one-way.md),
[ADR-0015](adr/0015-persisted-raw-data-is-the-source-of-truth.md),
[EXPERIMENTS.md](EXPERIMENTS.md)).

Host processing time is measured around that work and handed only to observers.
The algorithm reports its own stages through a write-only profiler that returns
the work's result and never a duration, so a clock reading cannot influence what
it computes ([ADR-0016](adr/0016-host-time-is-not-simulated-time.md)).

Two algorithms now run through that seam, and the distinction between them is
deliberate. **Baseline KF + PID is a scientific control**: unchanged since Phase
4, regression-tested, never tuned to flatter anything. **AstraLock-X Reference
PAT** is the robust implementation measured against it, on identical physics
through a paired harness in which only the plugin and its configuration differ.
The runtime contains no special case for either.

So does the autonomous loop. `core/runtime` owns the meeting point of world,
mount, camera and algorithm, and with it the two things that decide whether the
loop is honest: frames reach the algorithm in capture order and none is skipped,
and a command is stamped with the time the _request existed_ rather than the
time the frame was taken. An algorithm returns an intent with no timestamp and
never holds the mount, so it cannot back-date a command or bypass the actuator
([ADR-0013](adr/0013-command-intent-and-issue-time.md),
[BASELINE_PAT.md](BASELINE_PAT.md)). The interface is told what happened
afterwards and is not part of the loop: the same scenario gives the same result
headless and on screen.

Interactive rendering runs at the display's rate; the physics runs at a fixed
tick. The renderer blends the previous and current snapshots across the sub-tick
remainder for smooth motion, and that blend never re-enters the world — tested
by running the same scenario under different interpolation rates and comparing
the authoritative state hash. See ADR-0006 and ADR-0008, and docs/SIMULATION.md.

## Contracts

`core/contracts` is the vocabulary of the system. Two properties of it matter
more than the individual types.

**Units are part of the type.** `Radians`, `Microradians`, `Meters` and the rest
are branded numbers, so passing degrees where radians are expected is a compile
error. At runtime they are plain numbers with no wrapper and no cost. Coarse PAT
mixes degrees, radians and microradians constantly, and a unit error looks
exactly like a tracking bug.

**Measured and true are different types.** `GimbalState` is what the encoders
report — quantised, biased, late. The simulator's true gimbal angles are
`GroundTruthGimbalState`, a different type in a different module. The distinction
is not documentation; it is enforced.

The contracts are plain data throughout: records of numbers, strings, arrays and
typed arrays, with no classes, no methods and no closures. That is deliberate —
see [ADR-0005](adr/0005-typescript-core-with-rust-later.md).

## The ground-truth boundary

This is the central design constraint, specified in
[ADR-0003](adr/0003-ground-truth-isolation.md). In summary:

| Mechanism                                             | Catches                                                                                                     |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `GroundTruthTainted` brand + `ContainsGroundTruth<T>` | A tainted type reaching a tracker-facing contract — build fails at the declaration                          |
| `defineAlgorithm` registration guard                  | A plugin declaring a tainted config or debug type                                                           |
| `@typescript-eslint/no-restricted-imports` barrier    | A tracking-side file importing the ground-truth module, the simulator, or metrics — including `import type` |
| `assertGroundTruthFree`                               | A tainted value crossing a worker or plugin boundary, where types are erased                                |

`core/contracts/index.ts` does not re-export `ground-truth.ts`. Reaching ground
truth means naming that module, which makes the dependency visible in review.

All four mechanisms are covered by tests, including negative tests that fail if
a barrier is weakened rather than only confirming it currently works.

## Determinism

A run is a pure function of `SimulationConfig` and `SimulationSeed`. Simulated
time is derived from an integer tick index — `time = tick / tickRate` — never
accumulated, so `step(1)` a thousand times and `step(1000)` once are identical
by construction.

Each stochastic subsystem draws from its own xoshiro128\*\* stream derived from
the root seed, so adding a draw in one cannot shift another's sequence.
Algorithms receive a seeded generator of their own. `Math.random` is blocked by
a lint rule.

Wall-clock time may decide how many ticks to run; it never decides how large a
tick is. See [ADR-0004](adr/0004-deterministic-seeded-experiments.md),
[ADR-0007](adr/0007-deterministic-prng-and-stream-derivation.md) and
[ADR-0008](adr/0008-fixed-timestep-simulation.md).

## Plugins

A tracking algorithm implements `AlgorithmPlugin`: a manifest describing itself
and a `create` function returning an instance with `update`, `reset` and an
optional `dispose`. `update` receives a `TrackingInput` and returns a
`TrackingOutput`.

The manifest carries a Zod schema for the plugin's own configuration, so the
harness can validate a config before construction and the Scenario Lab can build
a form for it without the plugin shipping UI code.

Plugins register through `defineAlgorithm`, which is where the isolation check
is applied.

## State

UI state lives in Zustand stores under `src/stores`. Simulation state does not:
it lives in `WorldState`, owned by the simulator, and reaches the UI as telemetry
and events. The UI is a view over run output, not a participant in the run. That
is what makes it possible to run a batch of experiments with no UI attached.

## Desktop host

The Rust crate creates the window. That is all it does at Phase 0, by design —
see [ADR-0005](adr/0005-typescript-core-with-rust-later.md). It is also where
serial and USB device access will live when hardware-in-the-loop work starts,
which is one of the main reasons for choosing Tauri
([ADR-0001](adr/0001-tauri-react-typescript.md)).

The Tauri capability set is deliberately minimal: `core:default` only. No
network, shell or filesystem permission is granted until a phase needs one. The
content security policy allows no remote origins, which is what makes the
offline requirement structural rather than aspirational.

## Camera-observable disturbances (Phase 7)

`src/core/disturbance/` is a privileged physical layer between world sampling
and the authoritative `GRAY8` frame. It owns platform base attitude,
propagation-style intensity effects, finite exposure, sensor noise and frame
transport loss. The algorithm graph cannot import it: a tracker receives only
the delivered frame, capture time, calibration and measured gimbal pose.

Disturbance configuration is part of `SimulationConfig`, so it is serialized,
fingerprinted and stored with the physical scenario. A second, evaluator-only
stack reproduces the same frame-indexed realization to score it without feeding
truth back into the runtime. The exact layer ordering, equations and limits are
in [DISTURBANCE_MODEL.md](DISTURBANCE_MODEL.md).

## Coded beacon identity (Phase 8)

A beacon may modulate its emitted intensity to a binary code. The modulation is
applied where the physics is — inside image formation, integrated exactly over
each exposure — so what reaches a tracker is a brightness that varies frame to
frame, and nothing else.

The receiving half lives in the algorithm graph, in
`src/core/algorithms/astralock/identity.ts`. It keeps a bounded brightness
history per detected blob, joined across frames by bearing, and correlates each
against the exposure-integrated shape of the pattern it has been **configured**
to expect. The tracker is told the pattern, the way a radio is told a frequency;
it is never told which object in the world is emitting, what any emitter is
actually sending, or what the transmitter's phase is. Phase is recovered by
search.

The one module both halves share is `src/core/contracts/code-waveform.ts`, the
integral of a square wave over an interval. Sharing it is deliberate — two
implementations of the same integral would eventually disagree — and leaks
nothing: the sensor calls it with the scenario's code and the tracker calls it
with its own configured one, and neither can see the other's arguments.

Identity is ranked after physics and never overrides it, and the evaluator
scores the tracker's verdicts against truth the tracker never saw. The codes,
the timing constraint the camera imposes, the correlator and the measured
results are in [BEACON_IDENTITY.md](BEACON_IDENTITY.md); the decisions are
ADR-0023, ADR-0024 and ADR-0025.
