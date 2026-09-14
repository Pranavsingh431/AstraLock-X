# ADR-0013: An algorithm states intent; the runtime decides when it happened

- **Status:** Accepted
- **Date:** 2026-09-14
- **Phase:** Phase 4

## Context

Phase 4 closes the loop: pixels produce a command, the command moves the mount,
the mount changes the pixels. Two questions have to be answered before that loop
can be trusted, and both are easy to get wrong in a way that no test would
notice unless it was looking.

**Who owns the mount?** If a tracking algorithm holds a reference to
`DynamicGimbal` it can call `commandPosition` whenever it likes, skip the
command queue, choose its own command ids, or simply read the actuator's
interior. Every guarantee the mount makes about latency, ordering and clamping
becomes advisory.

**When did a command happen?** A camera frame carries a `captureTime`. The
software that reacts to that frame does not exist at that instant — the frame
has to be read out, delivered and processed first. At 60 FPS against a 200 Hz
physics tick, a frame captured at 16.667 ms is not available to software until
20 ms. An algorithm that could write `issuedAt` on its own command could stamp
it 16.667 ms and act 3.3 ms in the past: the mount's latency would start
counting from before the command existed, and the loop would be quietly
non-causal. It would also track slightly better, which is the dangerous part.

`ControlCommand` as Phase 0 defined it carries `issuedAt`, and `TrackingOutput`
returned one directly. So the algorithm was, in principle, stamping its own
commands.

## Decision

**An algorithm returns an intent, not a command.** `CommandIntent` is a new type
in `core/contracts/control`: a desired absolute pointing angle, or hold, with no
timestamp, no command id and no due time. `TrackingOutput.command` is now
`CommandIntent | null`.

**The runtime stamps it.** `ClosedLoopRuntime` converts an intent into a
physical command: it supplies the simulation time, obtains the id from the
mount, and lets the mount clamp to travel. The algorithm never receives the
mount object, and the lint barrier makes `@/core/runtime` unreachable from the
tracking side by alias, relative path and type-only import.

**Commands are never back-dated.** The invariant `issuedAt >= captureTime` holds
for every command, always, and is asserted directly.

**A frame becomes available at the first tick boundary at or after its capture
time.** Defined from the capture time alone, so it does not depend on how the
caller batched its ticks.

**The world is advanced only as far as the next frame, then the command is
issued.** The runtime walks forward frame by frame rather than jumping to the
end of a batch. Advancing ten ticks and only then issuing the commands for the
frames inside that span would hand the mount every command late by an amount
equal to the batch size — so the same scenario would behave differently headless
and on screen, and the display would be part of the control loop.

The echo back is asymmetric on purpose: `TrackingInput.previousCommand` is a
_stamped_ `ControlCommand`, because real control software knows what it
transmitted and when.

Phase 4 models the algorithm's own compute cost as zero, so the issue time is
the moment the frame became available rather than the moment processing
finished. When a compute-time model arrives it adds to the issue time and
nothing else changes.

## Consequences

**Good.**

- The loop is causal by construction, and the property is checked rather than
  assumed: commands are proved never to predate their frame, and proved to
  genuinely postdate it for a majority of frames, so the first check cannot pass
  vacuously.
- The autonomous result is identical headless and under a stuttering interactive
  cadence — same frames, same modes, same command ids, same world state hash.
- The mount's latency, ordering and clamping remain the mount's, because nothing
  else can reach past them.
- An algorithm cannot accidentally become fast by being wrong about time.

**Costs and risks.**

- A Phase 0 contract changed. `TrackingOutput.command` narrowed from
  `ControlCommand` to `CommandIntent`, which is a strict reduction in what an
  algorithm may say — it cannot express a rate command any more. Rate control is
  a later phase's concern and will reintroduce a rate _intent_; adding it now
  would be building for a controller that does not exist.
- The runtime's `step` is more intricate than "advance, then process": it walks
  frame boundaries. That complexity is the price of cadence independence and is
  covered by tests that compare batched and single-tick execution directly.
- `PATMode` gained a `lost` member so the baseline's three-state machine can be
  reported without claiming the predictive recovery that `reacquire` describes.

**Rejected alternatives.**

_Let the algorithm keep stamping, and validate afterwards._ Validation catches a
back-dated command but does not stop an algorithm being written around one, and
a rejected command mid-run is a worse failure than a type that cannot express
the mistake.

_Hand the algorithm the mount and trust the lint barrier._ The barrier stops an
import; it does not stop a harness passing the object through a field. Not
having a field is stronger.

_Stamp commands at capture time and model the delay inside the mount._ This
conflates two different delays — how long the software took to react, and how
long the hardware takes to respond — and makes the first invisible.
