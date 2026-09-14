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
       + seed              (world, truth)        |    (degrade)      │
                                │                |                   ▼
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
                                │                |                   │
                                ▼                |                   │
                       ExperimentSummary ◄───────┴───────────────────┘
```

Everything crossing the boundary left-to-right passes through `core/sensors`.
Nothing crosses right-to-left except gimbal commands. `core/metrics` reads both
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
    simulation/ The world. Sole producer of ground truth
    sensors/    Truth to observable. The boundary
    perception/ Frames to detections
    estimation/ Detections to tracks
    control/    Tracks to gimbal commands
    pat/        Acquisition state machine
    metrics/    Scoring, against ground truth, from outside
    experiments/Run execution, event logs, seed sweeps
    algorithms/ AlgorithmPlugin implementations and their registry
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
time advances by tick count, never by a clock. Each stochastic subsystem draws
from its own stream derived from the root seed, so a change in one subsystem
cannot shift another's draws. Algorithms receive a seeded generator of their own.
`Math.random` is blocked by a lint rule. See
[ADR-0004](adr/0004-deterministic-seeded-experiments.md).

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
