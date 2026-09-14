# ADR-0018: Point where the target will be, and coast when it disappears

- **Status:** Accepted
- **Date:** 2026-09-15
- **Phase:** Phase 6

## Context

Two independent Phase 4 behaviours have the same root cause: the baseline
reasons only about the present instant.

**It commands the present bearing.** The mount's command latency is 23 ms and
its servo takes tens of milliseconds more to respond. A command carrying the
target's current bearing is a command carrying where the target _was_ by the
time the mount acts on it. On a target crossing at 0.08 rad/s that is a
permanent 5 mrad lag that no amount of feedback gain removes, because the
feedback is also late.

**It discards a track the moment measurements stop.** A brief occlusion, a
target that leaves the frame during an evasive manoeuvre, a few dropped
detections — all produce the same response: declare the track lost and restart
a global sweep from the beginning. The estimator, which knows where the target
was going and how uncertain that is, is thrown away at exactly the moment its
prediction is most valuable.

## Decision

**Predict to the actuation instant.** The controller propagates the fused
estimate to `t_issue + h`, where

```
  h = commandLatency + servoLag
```

Both terms are **configuration** — the mount's declared latency and a modelled
servo lag — not measured host compute time and not privileged actuator state.
Host timing is Phase 5 performance telemetry and has no place in a control law;
the simulation models algorithm compute as taking zero simulated time, and
pretending otherwise would be inventing a delay.

**Feed-forward adds only the motion during the delay.** Feedback closes the
error against the estimate now; feed-forward adds `x̂(t+h) − x̂(t)` and nothing
else. The two cannot double-count, and a test asserts the arithmetic directly:
with unit proportional gain and no integral, the setpoint is exactly the
predicted bearing, once. For a stationary target the feed-forward term is
identically zero, so prediction cannot degrade the case the baseline already
handles well.

**Coast, predict, then search locally, then give up.** On missing measurements
the algorithm enters RECOVER rather than discarding the track:

- the estimator keeps propagating, and its covariance grows on its own;
- the mount keeps pointing at the predicted bearing;
- the association gate widens;
- after a short delay a local pattern is walked around the prediction, with
  radius scaled to the estimator's angular sigma and clamped at both ends;
- an accepted measurement returns to TRACK **without reinitialising** — the
  track survived, which is the entire point;
- a timeout or an unusably wide uncertainty falls back to a global sweep,
  restarted from the pointing nearest the last predicted bearing.

## Consequences

**Good.**

- On the short-loss scenario, on identical physics: the baseline goes
  TRACK → LOST → global SEARCH with a post-acquisition RMS error of 437 mrad;
  AstraLock-X goes TRACK → RECOVER → TRACK at 43 mrad. An order of magnitude,
  from not throwing the estimate away.
- Pointing error improves on every bundled scenario, most on the manoeuvring
  one, where the lag the horizon removes is largest.
- The local search is proportionate: a confident track looks in a small place, a
  stale one looks wider, and neither becomes a global sweep under another name.

**Costs and risks.**

- The horizon is only as good as the latency figure it is given. A wrong
  `commandLatency` produces confident over- or under-shoot, which looks like a
  badly tuned controller rather than like a configuration error. It is in the
  algorithm configuration and therefore in every run's manifest and fingerprint.
- Coasting a track that is genuinely gone costs time before the fallback. The
  envelope is bounded by `maxDuration` and by a covariance limit, both
  configured, and a test drives a run that never reacquires to confirm the
  fallback happens.
- A widened recovery gate is a wider door for a decoy. That is the identity
  limitation restated, and it is not fixed here.
- Scaling a search radius to an estimator covariance is defensible but is **not**
  a claim that the covariance is an optical probability distribution over the
  field of view. The documentation says so rather than implying the stronger
  statement.

**Rejected alternatives.**

_Compensate latency inside the mount model._ That would make the plant easier
rather than the controller better, and would misrepresent the hardware.

_Use measured host compute time as the horizon._ It is not simulated latency,
it varies with the machine, and it would make the control law non-deterministic.

_Predictive recovery in the baseline too._ The baseline is a control. Improving
it would destroy the comparison this phase exists to make.
