# ADR-0020: A disturbance realization is a function of the frame index

## Status

Accepted (Phase 7).

## Context

Every stochastic disturbance needs to be reproducible from a seed. The obvious
implementation is the one the simulator already uses: a sequential generator per
named stream, drawn from as the run proceeds.

That implementation is wrong here, and the reason is not obvious.

A sequential generator's output depends on **how many values have been taken from
it**, which depends on how many frames were rendered — and that is a _display_
decision. `captureLatest` renders only the newest frame due and skips the rest,
because a viewer can look at one image; the autonomous runtime renders every
frame in capture order. With a sequential stream those two would see different
weather from the same seed. Worse, the live view and a headless replay of the
same scenario would disagree, and recording a run would change its physics —
which contradicts the Phase 5 guarantee that recording is observation.

## Decision

Disturbance randomness is **counter-based**. The realization at frame `n` is a
pure function of `(rootSeed, streamName, n)`:

- `CounterStream` hashes the stream seed with the index through SplitMix32, so
  `gaussianAt(n, lane)` can be evaluated in any order, any number of times.
- Correlated processes walk a fixed index grid. A process stepped to frame 500
  and one fast-forwarded straight to it give the same value, because the driving
  normals are counter-based rather than sequential. Asked for an index it has
  already passed, a process replays from the start rather than refusing.
- Per-pixel noise seeds a fast sequential generator **from the frame index**.
  Hashing 307,200 pixels individually would cost more than the rest of the frame;
  the field is still a function of the frame index alone.

Streams are named and derived by hashing the name (ADR-0007), so adding a stream
cannot perturb an existing one.

## Consequences

**Good.**

- Skipping frames cannot change the weather. The live view, the headless
  runtime, a recorded run and a replay all agree.
- Two consumers can walk the same run at different rates without coordinating:
  the sensor renders frames while the evaluator scores them, each with its own
  process objects, and they cannot diverge.
- Changing one effect's implementation cannot move another's realization, which
  is what makes a stored result still mean what it said.

**Costs and risks.**

- Going backwards costs `O(index)` rather than `O(1)`, because the process
  replays. Nothing in the system does it often enough to matter, and the
  alternative — refusing — would push a coordination problem onto every caller.
- Counter-based normals cost two hashes each, against one step of a sequential
  generator. For the handful of scalar processes per frame this is irrelevant;
  it is precisely why the per-pixel path is sequential within a frame.
- The stream names are part of the reproducibility contract. Renaming one
  silently changes every realization drawn from it, so they are fixed in one
  place rather than constructed at call sites.

## Alternatives rejected

- **A sequential stream per effect.** The failure above: the realization would
  depend on how many frames a consumer chose to render.
- **Storing the realization in the recording.** It would make a run reproducible
  only if you had the recording, and the per-pixel field would turn a structured
  experiment record into a video.
