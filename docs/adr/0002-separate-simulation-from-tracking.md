# ADR-0002: Simulation and tracking are separate subsystems

- **Status:** Accepted
- **Date:** 2026-09-14
- **Phase:** Phase 0

## Context

AstraLock-X exists to answer one question: how well does a given tracking
algorithm hold a coarse PAT lock under given conditions? Answering it requires
running the algorithm against a world, which the application also provides.

That creates an obvious hazard. When the thing being measured and the thing
doing the measuring live in the same codebase, the boundary between them erodes
gradually and for good local reasons — a convenient import here, a shared helper
there — until the algorithm is quietly reading something a real system could
never observe. Nothing fails; the numbers simply stop meaning anything.

The second reason for separation is hardware. The eventual goal is
hardware-in-the-loop: the same tracker driving a real gimbal and a real camera.
That is only possible if the tracker never depended on the simulator in the
first place.

## Decision

Simulation and tracking are separate subsystems that communicate only through
the sensor contracts.

The pipeline runs in one direction:

```
simulation  ->  sensors  ->  [ perception -> estimation -> control -> pat ]  ->  gimbal command
   (truth)      (degrade)    (----------- the tracking side -----------)
                                                |
                             metrics  <---------+  (scored against truth, from outside)
```

- `core/simulation` owns the world and is the only producer of ground truth.
- `core/sensors` degrades truth into `CameraSensorFrame`, `CameraState` and
  `GimbalState`. This is the only channel into the tracking side.
- `core/perception`, `core/estimation`, `core/control`, `core/pat` and
  `core/algorithms` make up the tracking side. They see sensor output and their
  own previous commands, and nothing else.
- `core/metrics` scores a completed run by comparing telemetry against truth. It
  observes the tracker from outside and never feeds it.
- `core/experiments` drives the loop and owns reproducibility.

The tracking side is swappable as a unit. Replacing `core/sensors` with a driver
for a real camera and gimbal is the whole of what hardware-in-the-loop requires.

## Consequences

- An algorithm that scores well has demonstrably done so from observable data.
- The same algorithm binary can be pointed at simulated or real sensors.
- Algorithms are comparable, because they all see exactly the same inputs.
- The sensor layer becomes load-bearing: if it models noise, latency and
  quantisation badly, every result is optimistic. That is a real cost, and it is
  the reason `GimbalState` models encoder readings rather than true angles.
- Some things are harder to debug. When a tracker fails, the reason is not
  directly visible from inside it, which is why ground-truth debug overlays exist
  as explicitly labelled views rather than as data the tracker can reach.
- There is per-tick copying at the boundary that a fused design would avoid.
  Measured against the value of a trustworthy result, this is not close.

## Alternatives considered

**One integrated loop with discipline about what is read.** Less code and less
copying. Rejected because "discipline" is not enforceable, degrades under
deadline, and fails silently rather than loudly.

**Separate processes.** Stronger isolation than module boundaries. Rejected as
disproportionate: it would add IPC, serialisation and lifecycle management for a
guarantee the type system and lint rules already provide within one process.
See ADR-0003 for how the boundary is actually enforced.
