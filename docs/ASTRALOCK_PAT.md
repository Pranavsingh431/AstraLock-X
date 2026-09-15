# AstraLock-X Reference PAT

The robust reference tracker. It sits **alongside** the Phase 4 baseline, not in
place of it: the baseline is now a scientific control, and a comparison needs
both arms to exist.

|                     | Baseline KF + PID               | AstraLock-X Reference PAT                               |
| ------------------- | ------------------------------- | ------------------------------------------------------- |
| Role                | control                         | robust reference                                        |
| States              | SEARCH / TRACK / LOST           | SEARCH / ACQUIRE / TRACK / RECOVER / HANDOFF            |
| Commit to a track   | first valid detection           | accumulated evidence                                    |
| Candidate choice    | brightest blob, always          | brightest without a track; gated by innovation with one |
| Estimator           | constant-velocity Kalman        | interacting multiple model, NCV ⇄ NCA                   |
| Control             | feedback on the present bearing | feedback plus feed-forward to the actuation instant     |
| Missing measurement | give up, rescan globally        | coast, predict, search locally, then fall back          |
| Coarse-to-fine      | none                            | explicit readiness gate                                 |

Implementation: `src/core/algorithms/astralock/`. Both run through the same
`AlgorithmPlugin` contract and the same closed-loop runtime, and the runtime
contains no special case for either.

## What it is allowed to know

Exactly what the baseline is allowed to know: `TrackingInput` — the frame's
pixels, its capture time, the believed camera calibration, the measured mount
state, and its own configuration and memory.

It cannot reach ground truth, the simulator, the sensor implementation, the
mount, the runtime, the bundled scenarios, or the experiment evaluator. The same
five barriers apply as in Phase 4 and 5: compile-time proofs inside the
contract, the `defineAlgorithm` admission check, the ESLint import barrier
verified by probe files, the runtime `guardTrackingInput`, and type-level tests
over the concrete config and debug types.

The one thing worth restating: **the evaluator's coarse-lock condition and the
handoff-validity verdict are not inputs.** The algorithm decides handoff
readiness from its own measurements; whether that claim was justified is
computed separately, afterwards, and never reaches it.

## States

```
                    ┌──────────────── evidence broke ───────────────┐
                    ▼                                               │
  SEARCH ──candidate──▶ ACQUIRE ──evidence complete──▶ TRACK ──conditions + dwell──▶ HANDOFF
     ▲                                                  │  ▲                          │
     │                                            misses │  │ gated reacquisition      │
     │                                                   ▼  │                          │
     └──── timeout, or uncertainty too wide ───────── RECOVER ◀──────── misses ─────────┘
```

**SEARCH** — no track. Sweep the configured region, or the prior's
high-probability region if one is supplied.

**ACQUIRE** — a candidate exists but is not yet trusted. Accumulate evidence.

**TRACK** — a validated track with measurement support.

**RECOVER** — a validated track has lost measurement support. Coast the
estimate, keep pointing at the prediction, widen the gate, search locally.

**HANDOFF** — the coarse track satisfies the readiness conditions. **This means
`HANDOFF_READY`, not that a fine-pointing actuator exists.** The coarse loop
keeps tracking throughout; the interface says "HANDOFF READY", never "fine
tracking active".

Every transition emits a deterministic event. None of them lives in UI code.

## ACQUIRE: evidence, not a single detection

The baseline commits to TRACK on one valid detection. That is the single biggest
reason it can be captured by a transient.

AstraLock-X accumulates, using only safe quantities:

| Condition                   | Default | Why                                                                  |
| --------------------------- | ------- | -------------------------------------------------------------------- |
| `minCandidateScore`         | 0.10    | A candidate too faint to be a beacon is not evidence of one          |
| `minSupportingObservations` | 6       | Six sightings, not one                                               |
| `minPersistence`            | 0.08 s  | Six sightings inside one frame interval prove persistence of nothing |
| `maxBearingDisplacement`    | 1.0°    | Consecutive sightings must be kinematically plausible                |
| `maxMeanNis`                | 8       | The innovations must be consistent with the motion being estimated   |
| `maxConsecutiveMisses`      | 3       | Evidence that stops arriving is evidence that broke                  |

Both the count and the elapsed-time conditions must hold — either alone is
cheap. If evidence breaks, ACQUIRE is abandoned and SEARCH resumes.

`acquisitionEvidence` is reported as a bounded progress measure:

```
  evidence = min(1, supports / minSupports) · min(1, persistence / minPersistence)
             · (innovations consistent ? 1 : 0.5)
```

It is **not** a probability and is not described as one anywhere.

## Association and gating

Without a track there is nothing to be consistent with, so the strongest image
candidate wins — the baseline's rule, used only where it is the only
information available.

With a track, the estimator predicts the measurement and candidates are gated on
normalised innovation squared:

```
  d² = νᵀ S⁻¹ ν          ν = z − H·x̂⁻ ,  azimuth by shortest angle
```

A candidate is admissible when `d² ≤ gateChi2` **and** its angular innovation is
within `maxGateRadius`; the admissible candidate with the smallest `d²` is
taken. Two gates because one is not enough: a very uncertain estimate makes the
statistical gate wide enough to swallow the field of view, and the angular
radius bounds that independently.

|         | `gateChi2`           | `maxGateRadius` |
| ------- | -------------------- | --------------- |
| TRACK   | 13.82 (99.9%, 2 dof) | 1.5°            |
| RECOVER | 13.82                | 6.0°            |

**This does not solve identity.** A decoy inside the gate with a smaller `d²`
than the real beacon takes the track, and a test asserts exactly that. Coded
beacon identification is a later phase, and this is the reason it is needed.

## Estimator: interacting multiple model

Common six-element state, both axes:

```
  x = [ azimuth, elevation, az_rate, el_rate, az_accel, el_accel ]ᵀ
```

Two models over that state:

**NCV — nearly constant velocity.** The acceleration row of its transition is
zero, and its position and rate rows carry no acceleration term. Process noise
is a continuous white-noise acceleration of spectral density `q`:

```
  F_ncv = [1  dt  0]        Q_ncv = q·[ dt³/3  dt²/2  0 ]
          [0   1  0]                  [ dt²/2  dt     0 ]
          [0   0  0]                  [ 0      0      r ]
```

`r` is **numerical, not dynamical**: it keeps that block of the covariance
non-singular for the mixing step, and cannot influence what NCV predicts. It was
originally named for a residual acceleration it does not model; a sweep during
Phase 6 showed it had no effect whatever, and it is now named
`ncvAccelerationStateVariance` for what it does.

**NCA — nearly constant acceleration.** Full transition, white-noise jerk:

```
  F_nca = [1  dt  dt²/2]    Q_nca = q_j·[ dt⁵/20  dt⁴/8  dt³/6 ]
          [0   1  dt   ]                [ dt⁴/8   dt³/3  dt²/2 ]
          [0   0   1   ]                [ dt³/6   dt²/2  dt    ]
```

### The IMM cycle

Genuinely interacting — not two filters with the better residual selected:

1. **mixing probabilities** `μ_{i|j} = p_{ij}·μ_i / c̄_j`;
2. **mixed initial conditions** per model, including the spread term
   `(x_i − x̄_j)(x_i − x̄_j)ᵀ`;
3. **model-conditioned prediction**;
4. **model-conditioned measurement update**;
5. **measurement likelihood** `Λ_j`, computed in the **log domain** and then
   shifted by the maximum before exponentiating, so a model that fits badly
   underflows to zero rather than to `NaN`;
6. **model probability update** `μ_j = Λ_j·c̄_j / Σ`;
7. **fused state** `x̂ = Σ μ_j·x_j`;
8. **fused covariance including between-model dispersion**:
   `P = Σ μ_j·[ P_j + (x_j − x̂)(x_j − x̂)ᵀ ]`.

Step 8 is what makes the fused covariance honest: when the models disagree, the
fused estimate is genuinely less certain, and the gate widens accordingly.

### Transition probabilities

Specified as per-reference-interval stay probabilities and converted to a rate,
so the matrix is correct at any `dt`:

```
  λ_i = −ln(stay_i) / referenceInterval
  p_ii = exp(−λ_i·dt)          p_ij = 1 − p_ii
```

Defaults: `stayNcv` 0.98, `stayNca` 0.95 over a 1/60 s reference. The stationary
distribution of that matrix is 0.71 / 0.29 — worth knowing, because that is
where the probabilities sit when the likelihood ratio is 1, which happens
whenever _both_ models explain the data equally well.

### Tuning, and how it was arrived at

The shipped densities are measured, not guessed. A sweep against a 7.85×10⁻³
rad/s² manoeuvre at 60 fps and 150 µrad measurement noise:

| `q_ncv` | `q_jerk` | NCV on constant velocity | NCA peak during manoeuvre |
| ------- | -------- | ------------------------ | ------------------------- |
| 2×10⁻⁴  | 2×10⁻²   | 0.72                     | 0.29                      |
| 2×10⁻⁷  | 2×10⁻²   | 0.92                     | 0.38                      |
| 2×10⁻⁷  | 2×10⁻⁴   | **0.82**                 | **0.68**                  |
| 2×10⁻⁷  | 2×10⁻⁶   | 0.74                     | 0.79                      |

The original jerk density of 2×10⁻² made the NCA likelihood so broad that the
model could never win, and the estimator sat at the transition matrix's
stationary distribution whatever the target did. A tight NCV is deliberate:
letting it absorb acceleration is exactly what destroys the IMM's ability to
tell the two apart. Catching the manoeuvre is NCA's job.

Measured in the closed loop with the shipped values: NCA sits at **0.08** on a
constant-velocity target and peaks at **0.79** during the manoeuvre.

### Angles

Azimuth residuals use shortest-angle throughout, and model states are mixed
about the dominant model's azimuth rather than averaged naively — a naive mean
of +179° and −179° is 0°, which is the opposite side of the sky. Elevation is
bounded, not periodic, and is never wrapped.

## Prediction to the actuation instant

The baseline points at where the target is. By the time the mount responds, the
target is elsewhere.

```
  horizon h = commandLatency + servoLag
```

Both are **configuration**: the mount's declared command latency and a modelled
servo lag. Neither is a measured host compute time — that is Phase 5 performance
telemetry and has no place in a control law — and neither reads privileged
actuator state. Default: 23 ms + 40 ms = 63 ms.

The fused IMM state is propagated to `t_issue + h`, giving predicted bearing,
rate and acceleration. The horizon is reported in the safe diagnostics.

## Controller

An **outer** loop around the mount's own position servo, exactly as the baseline
is. It outputs an absolute setpoint, never a torque or a rate.

```
  e        = shortestAngle(x̂(t_issue), measured)        present error
  ff       = x̂(t_issue + h) − x̂(t_issue)                motion during the delay
  setpoint = measured + pid(e) + ff
```

**The two terms cannot double-count.** Feedback closes the error against the
estimate _now_; feed-forward adds only the _additional_ motion expected during
the actuation delay. With unit proportional gain and no integral the setpoint is
exactly the predicted bearing — once, not twice — and a test asserts that
arithmetic directly.

For a stationary target `ff` is identically zero, so prediction cannot make the
easy case worse. Pan and tilt are configured independently, with conditional-
integration anti-windup, an integral cap, a filtered derivative, and clamping to
the mount's travel.

A test shows that for a moving target and a known delay, the predicted command
lands nearer the target's future bearing than a zero-horizon command — and does
not overshoot past it.

## Search with no prior

Boustrophedon coverage of the configured region, with spacing derived from the
camera's **actual field of view** rather than from constants:

```
  step = fov · (1 − overlapFraction)
```

Default overlap 0.25, so with the bundled 12.0° × 9.0° field the spacing is
9.0° × 6.75°. `assertCoverage` refuses a configuration where
`step/2 + settleTolerance > fov/2`, because the mount stops within a tolerance
of each waypoint and the overlap has to absorb that error. A test measures the
worst gap between any point in the region and the nearest pointing, and requires
it to be inside the half-field.

This is a real difference from the baseline, and it matters when acquisition
times are compared: the baseline's 5.0° × 3.5° steps are constants chosen in
Phase 4, so it visits 91 waypoints where AstraLock-X visits 32. **Most of the
acquisition-time difference between the two arms is this, not the estimator.**

Waypoints advance on measured arrival, measured rate and dwell, with a
simulated-time timeout so a deadband cannot stall the sweep. No target bearing
enters any of it.

## Optional coarse prior

`search.prior` is `null` by default and every shipped comparison is prior-free.

When supplied, it carries a centre, per-axis sigmas and a `source` string, and
it reorders the sweep: grid pointings within the sigma extent first, nearest in
Mahalanobis distance, then the rest of the coverage grid. High-probability
first, deterministic, no stochastic search, and no claim of Bayesian optimality.

A prior must be **externally supplied** — GNSS/INS, ephemeris, a previous
terminal bearing, an operator estimate. It is never derived from simulator
truth. It appears in the algorithm configuration, so it is in the manifest,
fingerprint and report of every run that used one.

**Never compare a prior-assisted acquisition against a prior-free one and call
the difference algorithmic.** Official validation is prior-free; prior-assisted
results are reported separately.

## RECOVER

On `missesBeforeRecover` consecutive frames without an accepted measurement:

1. enter RECOVER — **do not discard the track**;
2. keep propagating the IMM without measurements, so covariance grows naturally;
3. keep pointing at the predicted bearing at the actuation instant;
4. after `localSearchDelay`, walk a local pattern around that prediction;
5. attempt association every frame through the widened recovery gate;
6. on an accepted measurement, return to TRACK **without reinitialising the
   estimator** — the whole point is that the track survived;
7. on `maxDuration` or an unusably wide uncertainty, fall back to SEARCH,
   restarting the sweep from the pointing nearest the last predicted bearing
   rather than from the corner of the region.

### Local search

Radius scales with the estimator's own angular sigma:

```
  radius = clamp(sigmaMultiple · σ_angular, minRadius, maxRadius)
```

Defaults: 3σ, clamped to [0.5°, 8.0°]. A confident track looks in a small place;
a stale one looks wider; neither becomes a global sweep wearing a local sweep's
name. The pattern starts at the prediction itself, then rings at half and full
radius, and azimuth offsets are divided by `cos(elevation)` so the pattern keeps
its true angular size on the sky. Deterministic throughout.

This is **not** a claim that the covariance is an optical probability
distribution over the field of view. It is a defensible way to scale a search to
an uncertainty.

## HANDOFF readiness

Every condition must hold continuously for `dwell`:

| Condition                               | Default   |
| --------------------------------------- | --------- |
| a measurement was associated this frame | —         |
| measured boresight residual, azimuth    | ≤ 0.10°   |
| measured boresight residual, elevation  | ≤ 0.10°   |
| estimator angular sigma                 | ≤ 0.05°   |
| estimated angular rate                  | ≤ 0.50°/s |
| track quality                           | ≥ 0.70    |
| dwell                                   | 1.0 s     |

All of it is measured or estimated by the tracker. **None of it is the true
pointing error**, which the algorithm cannot know.

While ready, the thresholds relax by `exitHysteresis` so readiness does not
chatter on the boundary; a missing measurement clears it immediately. The coarse
loop keeps tracking and the estimator keeps running — handoff readiness is a
claim, not a handover.

Whether the claim was _justified_ is the evaluator's separate verdict:
handoff-ready time during which the true angular pointing error was within
`handoffValidityThresholdRad` (1 mrad, half the coarse-lock threshold). That
comparison is computed offline from the recorded run and never reaches the
algorithm.

## Track quality

```
  quality = (strength + consistency + persistence + certainty) / 4
```

| Component     | Definition                                           |
| ------------- | ---------------------------------------------------- |
| `strength`    | accepted candidate score ÷ `scoreReference`, clamped |
| `consistency` | `1 − NIS_ewma / gateChi2`, clamped                   |
| `persistence` | accepted frames in the last `persistenceWindow` (30) |
| `certainty`   | `1 − σ_angular / sigmaReference`, clamped            |

Bounded on [0, 1], and all four components are reported so a low score can be
explained rather than merely observed.

It is **not** a probability of tracking the correct target, and is not named as
one. Nothing derived from truth contributes to it.

## Measured results

Paired against the baseline on identical physics — same scenario document, same
seed, same sensor, mount and camera, same metric definitions. Only the algorithm
and its configuration differ. Post-acquisition angular pointing error, in µrad.

Run lengths are chosen so that **both** arms have settled well before the run
ends. This matters more than it sounds: the baseline takes roughly twice as long
to find the target, so a window sized for AstraLock-X ends while the baseline is
still converging, and the comparison then measures the search rather than the
tracking. An earlier draft of this table was measured that way and reported
baseline errors an order of magnitude larger than the figures below. Those
numbers were not wrong about what they measured; they were measuring the wrong
thing.

| Scenario   | Arm         | Acquired | RMS       | P95    | Max    | Retention | States                                                         |
| ---------- | ----------- | -------- | --------- | ------ | ------ | --------- | -------------------------------------------------------------- |
| stationary | baseline    | 16.1 s   | 172       | 157    | 1490   | 1.000     | scan→track                                                     |
|            | AstraLock-X | 12.5 s   | **158**   | 114    | 1448   | 1.000     | scan→acquire→track→handoff                                     |
| moving     | baseline    | 30.1 s   | **167**   | 220    | 1374   | 1.000     | scan→track                                                     |
|            | AstraLock-X | 13.1 s   | 209       | 434    | 1529   | 1.000     | scan→acquire→track                                             |
| manoeuvre  | baseline    | 29.4 s   | 371       | 834    | 1401   | 1.000     | scan→track                                                     |
|            | AstraLock-X | 13.2 s   | **297**   | 538    | 1680   | 1.000     | scan→acquire→track                                             |
| short loss | baseline    | 41.4 s   | 422590    | 820515 | 896628 | 0.127     | scan→track→**lost**→scan→track                                 |
|            | AstraLock-X | 23.3 s   | **39275** | 35423  | 324720 | **0.871** | scan→acquire→track→**recover**→track→**recover**→track→handoff |
| handoff    | baseline    | 31.4 s   | **193**   | 375    | 1364   | 1.000     | scan→track                                                     |
|            | AstraLock-X | 13.6 s   | **168**   | 346    | 1354   | 1.000     | scan→acquire→track→**handoff**                                 |

What this actually shows:

- **Acquisition is about twice as fast**, on every scenario. Read that with the
  search-spacing caveat above: nearly all of it is FOV-aware waypoint spacing,
  not the estimator. The baseline would gain the same gap from the same change.
- **Steady-state accuracy on easy targets is a wash.** 172 against 158 µrad on a
  stationary target is not a meaningful separation at this sensor resolution,
  and on the **moving** scenario the robust algorithm is honestly _worse_ —
  209 µrad against 167, with a P95 twice the baseline's. A six-state IMM
  estimating acceleration that is not there has more freedom to be wrong than a
  constant-velocity filter, and on a constant-velocity target that freedom costs
  something. It is the price of the manoeuvre and loss behaviour, and on targets
  that never manoeuvre it buys nothing.
- **The manoeuvre scenario is a modest win** — 297 against 371 µrad — and the
  NCA model probability is what earns it, peaking at 0.79 during the
  acceleration against a steady 0.07.
- **The loss scenario is the result that matters.** The baseline loses the
  target, falls back to a global sweep, and holds coarse lock for 12.7 % of the
  time it could have. AstraLock-X coasts its estimate through the gap, recovers
  twice by looking where it predicts rather than rescanning, holds lock 87.1 %
  of the time, and ends the run ready to hand off. An order of magnitude in RMS,
  and a seven-fold difference in retention, on identical physics.

The short-loss row is the justification for the whole phase. The rest of the
table is the honest cost of getting it.

## Cost

Per processed frame at 640×480, against the 16.67 ms camera period:

|             | Mean    | Median | P95  | Max  |
| ----------- | ------- | ------ | ---- | ---- |
| Baseline    | 0.63 ms | 0.61   | 0.68 | 1.90 |
| AstraLock-X | 0.81 ms | 0.79   | 0.87 | 3.80 |

1.27× the baseline, and about 5% of the frame budget. The IMM's predict-plus-
update cycle is 61 µs; the detector, which both share, dominates. There is no
measured bottleneck that would justify moving anything to Rust.

## Known weaknesses

Stated because a later phase has to beat this one, and because a reference
implementation that hid its limits would be worth less than none.

1. **Identity is unresolved.** Prediction and motion consistency narrow the
   field; they do not establish which emitter is which. A plausible decoy inside
   the gate captures the track, and a test asserts it. Coded beacon
   identification is the fix, and it is a later phase.
2. **Recovery has a finite envelope.** A disappearance longer than
   `maxDuration`, or one after which the target does not return near the
   prediction, falls back to a global sweep — correctly, but that is still a
   full reacquisition.
3. **The IMM cannot separate the models on a benign target.** When both explain
   the data equally well the probabilities relax to the transition matrix's
   stationary distribution. That is correct behaviour and it means the model
   probabilities are informative about manoeuvres, not about truth.
4. **Two models only.** No coordinated-turn model, so a sustained turn is
   absorbed as acceleration rather than recognised as a turn.
5. **The acquisition thresholds are fixed.** They do not adapt to how cluttered
   the image is, because nothing yet measures clutter.
6. **Handoff readiness is a claim about the coarse track**, not a measurement of
   fine-pointing feasibility, and there is no fine-pointing stage to accept it.
7. **Disturbance identity is still unresolved.** Phase 7 adds
   camera-observable motion, attenuation, noise and dropout, but it does not
   make a blob carry a verified identity. Their limits are deliberately exposed
   rather than hidden; coded optical identity is a later concern.
8. **Single target.** One track hypothesis, no multi-target association.
