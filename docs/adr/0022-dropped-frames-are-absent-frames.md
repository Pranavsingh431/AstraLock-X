# ADR-0022: A dropped frame is an absent frame

## Status

Accepted (Phase 7).

## Context

Phase 7 models sensor delivery loss. There are three ways to hand a tracker a
frame that did not arrive, and two of them are lies.

1. **A black frame.** The algorithm receives an image, runs its detector on it,
   finds nothing, and counts a detection miss. That is a frame in which the
   target was dark, not a frame that never existed — and a real camera that fails
   to deliver produces no buffer at all.
2. **A frame carrying a "this one is bad" flag.** The algorithm is told that a
   frame is missing. No camera can tell you about a frame it did not produce;
   the flag is information from the simulator, and any recovery behaviour built
   on it would be responding to a message rather than to an absence.
3. **Nothing.** The frame is never rasterized, never delivered, and never
   mentioned.

## Decision

The third. A dropped frame is not rasterized, is not handed to the algorithm,
and carries no flag. The world is still advanced to the instant the frame would
have arrived, so simulated time passes normally and the tracker experiences
exactly what a real terminal would: nothing, for one frame period.

Four counters stay semantically distinct, extending Phase 5's discipline:

| Counter                | Meaning                                                    |
| ---------------------- | ---------------------------------------------------------- |
| scheduled              | the camera clock called for a frame                        |
| generated              | pixels were built                                          |
| **dropped**            | the _sensor_ failed to deliver                             |
| superseded for display | the _interface_ declined to build a frame it would discard |

The last two are categorically different: one is an instrument failure, the
other a display decision.

Drops are recorded in the event log **once per burst**, with the first frame and
the run length, not once per frame. Phase 5's log is change-only; a scenario
losing a fifth of its frames would otherwise add a thousand rows to a
ninety-second run and drown every state transition.

## Consequences

**Good.**

- A recovery strategy is tested against the thing it claims to handle.
- It immediately produced an honest negative result: AstraLock-X counts
  consecutive _processed_ frames without a detection, so a frame that never
  arrives is never counted, and pure delivery loss does not put it into RECOVER
  at all. Its predictive recovery — the behaviour that wins the Phase 6 loss
  scenario — is simply never engaged. That weakness was invisible until frames
  could go missing, and it is reported rather than patched, because making the
  tracker smarter is out of scope for a physics phase.

**Costs and risks.**

- An algorithm whose timeouts are counted in frames rather than seconds cannot
  notice delivery loss at all. That is a real property of the Phase 6 design and
  is now documented as one.
- The burst-level event log reconstructs the count and the longest run but not
  which individual frames were lost. The seed and the frame index reproduce the
  exact pattern, so nothing is unrecoverable.
- Because the burst is only known to be a burst once delivery resumes, its event
  is stamped when it closed, not when it began; the start is carried in the
  detail. The event log must be non-decreasing in simulated time.

## Alternatives rejected

Both alternatives above: a black frame teaches the detector a fiction, and a
flag hands the algorithm a fact the instrument does not have.
