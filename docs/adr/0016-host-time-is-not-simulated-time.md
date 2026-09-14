# ADR-0016: Host processing time and simulated latency are different quantities

- **Status:** Accepted
- **Date:** 2026-09-14
- **Phase:** Phase 5

## Context

"Processing time" and "latency" invite one number. In AstraLock-X they are two
unrelated things.

**Simulated latency** is part of the physics. A frame captured at 16.667 ms
becomes available at the 20 ms tick; the command it produces is stamped then;
the mount applies it 23 ms later (ADR-0013). These are deterministic, reproduce
exactly, and change what the tracker does.

**Host processing time** is how long this computer took to run the detector,
the filter and the rest. It varies run to run and machine to machine. The
simulation models algorithm compute as taking zero simulated time, so host time
has, by design, no effect on the result.

Adding them, or reporting host time as "latency", would put a machine-dependent,
non-reproducible figure into a result that is otherwise reproducible — and would
suggest a compute-latency model that does not exist.

Measuring host time also creates a subtler hazard. An algorithm that could read a
clock could let its output depend on how fast the host was, and a run would no
longer replay.

Finally, the first attempt at stage timing in this phase was not honest:
"detector" was a copy of whole-algorithm time, and "orchestration" timed a single
property read and was always about zero.

## Decision

1. **Separate fields, separate files, separate words.** Host timings are
   `hostProcessingTime.*` in milliseconds, from `host_*_ms` telemetry columns.
   Simulated delays are `controlLatency.*` in seconds, from command events.
   Nothing combines them. Every report section and definition names which is
   which, and neither is called the other.
2. **Host time never feeds back.** Measured with `performance.now()` around work
   that was going to happen anyway, handed only to observers, and never passed to
   the algorithm, the command path, simulated time or any hash. Tests require
   identical engineering results with and without observation.
3. **The algorithm reports stages through a write-only profiler.**
   `AlgorithmInit.profiler.time(stage, work)` runs `work` and returns its result.
   It never returns a duration or a timestamp, and the object handed over exposes
   only `time`, so a duration cannot be read back even by casting. A test runs the
   same closed loop with the host profiler and with a no-op one and requires
   identical commands and hash. Stages are a closed set — detector, bearing
   transform, estimator, controller — and one that did not run on a frame is
   absent, not zero.
4. **Orchestration is a remainder, not a guess.** The runtime times the world
   step, the sensor frame and the algorithm, and one whole iteration excluding
   observation; orchestration is the iteration minus the three.
5. **Simulated application time is observed, not assumed.** The mount keeps a
   bounded log of applied commands; the runtime reports each command's actual
   `appliedAt` to observers, and `scheduledToActualApplication` shows the
   difference from its due time.
6. **Wall-clock measurements that compare configurations are intentional
   benchmarks.** Recorder overhead, writer throughput and frame budgets live in
   `performance.test.ts` files, run in a separate, sequential test pass so they
   measure the code rather than contention with the rest of the suite.

## Consequences

**Good.**

- Every report can quote host timing for what it is — how heavy the software is on
  this machine — without contaminating reproducible results.
- The zero-compute-latency modelling assumption is visible in the numbers:
  capture → issue is only tick alignment.
- A future compute-latency model has an obvious place to go, in simulated time,
  without anyone having to untangle the two.
- Per-stage figures point directly at where host time is spent (the detector,
  about 1 ms of about 1.1 ms per frame for the baseline).

**Costs and risks.**

- A few `performance.now()` calls and a closure per stage per frame. Measured
  recorder overhead including all instrumentation and writing is about 3 %.
- `AlgorithmInit` gained an optional field. An algorithm that ignores the
  profiler simply reports no stages.
- The mount carries a 64-entry applied-command log. An observer that falls
  further behind than that gets an error rather than a silently shortened list.

**Rejected alternatives.**

_Model compute latency now, from host time._ Would make results depend on the
machine and destroy reproducibility. A compute-latency model, when it comes,
will be a configured, simulated quantity.

_Let the algorithm time itself and put the figures in its debug output._ Hands
the algorithm a clock and puts nondeterministic values into a payload that tests
compare.

_Time stages from outside by wrapping algorithm internals._ Only possible for
one algorithm, and would couple the runtime to the baseline's structure.
