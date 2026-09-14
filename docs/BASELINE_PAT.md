# The baseline PAT algorithm

`baseline-kf-pid` — the first autonomous tracker in AstraLock-X, and since
Phase 6 the **scientific control** that the robust algorithm is measured
against.

It is deliberately unchanged. Improving it would destroy the comparison it
exists to make, and a robust result quoted without a control is not a result.
The robust tracker is [AstraLock-X Reference PAT](ASTRALOCK_PAT.md); both run
through the same plugin contract and the same closed-loop runtime, and the
paired harness gives them identical physics.

It is deliberately simple. Threshold, connected components, centroid, inverse
pinhole, constant-velocity Kalman filter, PID, raster scan. No beacon identity,
no manoeuvre model, no predictive recovery, no learned component. Where it is
weak, that weakness is documented rather than patched, because a baseline that
has quietly acquired the robust algorithm's ideas is no longer a baseline.

Implementation: `src/core/algorithms/baseline/`. The loop that runs it:
`src/core/runtime/closed-loop.ts`.

## The loop

```
  world ──▶ mount ──▶ camera ──▶ GRAY8 pixels
                                      │
                                      ▼
                          threshold + 8-connected components
                                      │
                                      ▼
                         intensity-moment subpixel centroid
                                      │
                                      ▼
                    inverse pinhole × MEASURED mount pose
                                      │
                                      ▼
                        constant-velocity Kalman filter
                                      │
                                      ▼
                     PID against the MEASURED mount pose
                                      │
                                      ▼
                            pointing intent (no timestamp)
                                      │
                        runtime stamps it and submits it
                                      │
                                      ▼
                    mount ──▶ different pixels next frame
```

Every arrow is real. The camera image changes because the mount physically
moved, and the mount moved because of what was in the previous image.

## What the algorithm is allowed to know

Its entire window on the world is `TrackingInput`: the frame's pixels, the
frame's capture time, the believed camera calibration, the measured gimbal
state, and its own configuration and memory.

It cannot reach `GroundTruthState`, `SensorEvaluationTruth`,
`EmitterProjectionTruth`, target coordinates or velocities, the mount's true
pose or motor state, the backlash take-up, future trajectory, emitter identity,
or the true projected pixel centre. Five things enforce that:

1. `TrackingInput`, `AlgorithmInit` and `TrackingOutput` are proved
   ground-truth-free at compile time by assertions inside the contract itself.
2. `defineAlgorithm` refuses a plugin whose own config or debug types can reach
   truth — or that it cannot prove otherwise.
3. The ESLint barrier makes `@/core/contracts/ground-truth`, `@/core/simulation`,
   `@/core/metrics`, `@/core/sensors`, `@/core/gimbal`, `@/core/runtime` and
   `@/scenarios` unreachable from `src/core/algorithms/**`, by alias, by
   relative path, and by type-only import. It is verified by running the real
   ESLint configuration over probe files.
4. `guardTrackingInput` re-checks at runtime, where types are erased.
5. `src/core/algorithms/baseline/isolation.test-d.ts` proves the baseline's own
   concrete types satisfy all of it, with `@ts-expect-error` cases that fail the
   build if they ever start compiling.

`@/scenarios` is on that list because a bundled scenario document contains the
target trajectories in full. An algorithm that could load one would not need to
track anything.

## Detector

Threshold, label, measure, filter, select.

**Threshold.** A single global value in raw format units (0–255 for `mono8`), so
it means the same thing as a pixel value an operator can read off the monitor.

**Components.** 8-connected, labelled by iterative flood fill with an explicit
stack. 8-connectivity rather than 4 because a Gaussian point spread sampled onto
a pixel grid routinely has diagonal neighbours in its skirt, and 4-connectivity
would split one beacon into slivers each below the minimum area. The stack is
explicit rather than recursive because a large saturated region in a 640×480
frame is 300k pixels deep.

**Measurements**, per component: area, peak, background-subtracted integrated
intensity, bounding box, and the intensity-weighted centroid

```
  cx = Σ (sample − threshold)·x  /  Σ (sample − threshold)
  cy = Σ (sample − threshold)·y  /  Σ (sample − threshold)
```

Integrated intensity is background-subtracted on purpose: summing raw samples
would let a large dim region beat a small bright one purely by counting
pedestal, which is not what "brighter" means.

The centroid uses first-order intensity moments rather than the centre of the
bounding box. A Gaussian spot straddling two pixels has its energy distributed
between them, and the moment recovers where the spot actually sits to a fraction
of a pixel; the box centre quantises to half-pixel steps and would cap the whole
system's pointing accuracy at the sensor's pixel pitch.

**Measured centroid accuracy** on the clean sensor, against the simulator's true
projected centre (which the detector never sees): mean error a few thousandths
of a pixel, worst case under a hundredth, over a 30-frame run. On synthetic
Gaussians swept through sub-pixel offsets the worst error is under 0.02 px.

**Filtering.** Minimum and maximum area, minimum peak, minimum integrated
intensity. A single hot pixel fails the area test; whole-frame glare fails it
from the other side.

**Selection.** Highest integrated intensity among the survivors, ties broken by
discovery order so the choice is deterministic. This is the documented rule and
it is purely image-based — no identity, no position prior. It is also the
detector's central weakness: anything brighter and compact wins, beacon or not.
A test asserts that a brighter decoy captures the tracker, because that failure
is the motivation for coded beacon identification later.

**Score.** `integratedIntensity / (area × (fullScale − threshold))`, on [0, 1].
It says how strong the detection is relative to a saturated blob of the same
size. **It is not a probability** and is not described as one anywhere in the
interface.

## Pixel to bearing

```
  x = (u − cx) / fx
  y = −(v − cy) / fy
  z = 1
  ray_camera = normalise(x, y, z)
```

The vertical sign is negative because image rows increase downward while the
camera's y axis points up.

The ray is then rotated into world ENU with the no-roll basis built from the
**measured** mount pose:

```
  forward = ( sin(az)·cos(el),  cos(az)·cos(el),  sin(el) )
  right   = ( cos(az),         −sin(az),          0       )
  up      = right × forward

  world = x·right + y·up + z·forward

  azimuth   = atan2(east, north)
  elevation = atan2(up, hypot(east, north))
```

No distortion correction: the simulator's optics are an exact pinhole and the
believed intrinsics carry zero coefficients, so an undistortion would be an
identity dressed up as work. When a distorted sensor arrives it belongs here.

**Measured, not true, pose** — always. Using the true pose would remove the
encoder error from the measurement chain and hand the tracker a pose that
exactly explains its own pixels, which no real system gets. Round-trip tests
confirm that with an exact pose the recovery is correct to better than 1e-9 rad,
and that with a quantised pose the bearing error is exactly the pose error,
bounded by half an encoder count. That error is **not** corrected.

## Estimator

Constant-velocity Kalman filter over `[azimuth, elevation, azimuthRate,
elevationRate]`, measuring the two angles.

```
       ⎡1 0 dt 0⎤                        ⎡dt⁴/4   0    dt³/2   0  ⎤
  F =  ⎢0 1 0 dt⎥        Q = q · ⎢  0   dt⁴/4    0   dt³/2⎥
       ⎢0 0 1  0⎥                        ⎢dt³/2   0     dt²    0  ⎥
       ⎣0 0 0  1⎦                        ⎣  0   dt³/2    0    dt² ⎦

  H = [ I₂  0₂ ]              R = σ² · I₂
```

`Q` is the exact integral `∫₀^dt F(τ)·G·q·Gᵀ·F(τ)ᵀ dτ` for white-noise
acceleration, not an approximation of it. The two axes are independent: an
angular constant-velocity model is already an approximation of a target crossing
at constant linear velocity, and claiming a cross-axis correlation the model
cannot predict would be false precision. The consequence is a filter that lags
slightly through the fastest part of a crossing pass.

**dt comes from frame timestamps**, never from the configured frame rate. Frames
can be dropped and the rate is configurable; a controller that assumed a cadence
would compute the wrong derivative the moment one was missed.

**Joseph-form covariance update**:

```
  P⁺ = (I − K·H)·P⁻·(I − K·H)ᵀ + K·R·Kᵀ
```

rather than the shorter `(I − K·H)·P⁻`. Joseph costs two extra 4×4
multiplications and stays positive semi-definite under rounding and under a gain
that is not exactly optimal. The short form can drift to an indefinite
covariance over a long run, and a filter whose covariance has gone indefinite
produces confident nonsense rather than an obvious failure. The covariance is
additionally symmetrised after every update.

**Initialisation** is from one measurement, with rate zero and a large rate
variance. Seeding the rate from a difference of the first two noisy angles over
one frame interval is a very poor estimate and produces a violent first
correction.

**Long gaps are sub-stepped.** The transition is exact for any `dt`, but `Q`
grows as `dt³`–`dt⁴`, so one huge step inflates the covariance far more than the
same interval taken in pieces.

## Angle wrapping

Azimuth is periodic; elevation is not.

Every azimuth difference goes through `shortestAngle(a, b) = wrap(a − b)` into
(−π, π]. Without it a target crossing due South produces a 2π innovation, the
gain multiplies it, and the mount slews the long way round.

Elevation differences are taken directly. Elevation is bounded to [−π/2, π/2] by
geometry and the mount's travel is narrower still, so wrapping one would be
wrong rather than merely unnecessary: it would turn an impossible measurement
into a plausible one.

The filter's own azimuth state is kept on the principal branch, so a long run
does not march the state to hundreds of radians and lose precision in the low
bits.

**Limitation, stated plainly:** the bundled scenarios all sit well away from
±π, so the wrap logic is exercised by unit tests rather than by any shipped
scenario. The mount's pan travel is ±170°, which does include the cut.

## Controller

A PID **around the mount's own position servo**, not a replacement for it.

```
  panError  = shortestAngle(estimatedAzimuth, measuredPan)
  tiltError = estimatedElevation − measuredTilt

  desiredPan  = measuredPan  + pid_pan(panError)
  desiredTilt = measuredTilt + pid_tilt(tiltError)
```

The output is a _correction to the commanded angle_, not a torque, a rate or an
acceleration. The plant is already closed-loop — a mount that accepts an
absolute angle and moves there with its own bandwidth, damping, limits and
backlash — so the outer loop must be slow enough that the inner servo settles
between its steps, or the two fight and the mount rings. That is why the shipped
gains are modest.

**No feed-forward.** Target-rate feed-forward would remove the baseline's lag on
a moving target, and that lag is one of the things the robust controller is
supposed to improve on.

**Anti-windup by conditional integration.** The integral accumulates only when
the output is not already saturated in the direction the integral would push it
further, and is additionally hard-capped. When the mount is commanded somewhere
it cannot reach — against a travel stop, or beyond the per-step correction limit
— the integral stops growing instead of storing a demand that has to be unwound
before the axis will come back.

**Filtered derivative.** The error is a difference of a filtered estimate and a
quantised encoder reading, so it carries a step of up to one count. A raw
derivative of that is a spike of `count / dt` — over 20°/s of phantom rate at a
0.02° encoder and a 16.7 ms frame.

A non-positive or non-finite `dt` is treated as "no time has passed": the
proportional term is returned and the integral and derivative are left alone.

## States

Three, and no more: **SEARCH**, **TRACK**, **LOST**.

**SEARCH.** Walk the raster pattern. On `detectionsBeforeTrack` consecutive
frames with a valid candidate, initialise the filter from the measurement and
enter TRACK. One frame is enough to see something but not to believe it; a small
confirmation count costs a few frames and stops the scan being derailed by a
single hot pixel.

**TRACK.** Each new frame with a candidate: build the bearing, update the
filter, run both PID axes, issue an absolute setpoint. A frame with no candidate
coasts the filter on its model. After `missesBeforeLost` consecutive misses,
enter LOST.

**LOST.** Hold position for `lostHoldTime`, then discard everything — filter,
both controllers, scan position — and return to SEARCH.

That is the whole of baseline recovery. There is no predicted neighbourhood, no
widened gate, no track memory. It is deliberately weak, and the `pat-loss`
scenario exists to show it.

The contract's `PATMode` gained a `lost` member for this, so the baseline can
report where it is without claiming the predictive behaviour `reacquire`
describes.

## Search pattern

Boustrophedon raster over a configured pan/tilt rectangle, with **no target
prior of any kind**.

Serpentine rather than a raster that returns to the start of each row: the
return leg would spend half the scan re-covering ground, which on a rate-limited
mount is half the acquisition time thrown away.

The lattice always includes both ends of both axes. A region whose extent is not
a whole number of steps would otherwise leave an uncovered strip at the far
edge, which is exactly where a target the operator guessed wrong about would be.

**Waypoints are not issued per frame.** Commanding a fresh setpoint every 16.7 ms
would mean the mount never finishes a move before being told to do something
else, and the scan would crawl while looking busy. A waypoint is held until

- the measured position error is inside `settleTolerance`, **and**
- the measured rate is below `measuredRateTolerance`, **and**
- it has stayed that way for `dwellTime`;

or until `waypointTimeout` expires. The timeout is measured in **simulated**
time and exists because a deadband wider than the settle tolerance, or a
setpoint the travel stops make unreachable, would otherwise hold the scan for
ever.

Everything in that decision — commanded angle, measured angle, measured rate,
simulated time — is available to real control software. The scan never consults
the mount's true pose, the backlash state, or the world.

## Control timing

The rule: **`issuedAt >= captureTime`, always.**

```
  captureTime  ──▶  frame available  ──▶  algorithm  ──▶  issue time
    16.667 ms          20.000 ms          (0 cost)         20.000 ms
                                                              │
                                                 + commandLatency
                                                              ▼
                                                           due time
```

A frame becomes available at the first physics tick boundary at or after its
capture instant — defined from the capture time alone, so it does not depend on
how the caller batched its ticks. Phase 4 models the algorithm's own compute
cost as zero; when a compute model arrives it adds to the issue time and nothing
else changes.

The algorithm returns a `CommandIntent`, which has no timestamp, no command id
and no due time. The runtime supplies all three. See
[ADR-0013](adr/0013-command-intent-and-issue-time.md).

## Runtime ordering

Per call to `ClosedLoopRuntime.step(ticks)`:

1. find the next camera frame due;
2. advance the world and the mount to that frame's availability time — **not**
   to the end of the batch;
3. rasterise the frame from the state at its own capture instant;
4. hand it to the algorithm with the mount state as measured at that instant;
5. take the intent;
6. stamp it with the current simulation time;
7. submit it to the mount, which applies its own latency and clamping from
   there;
8. release the frame lease, in a `finally`;
9. repeat until no frame remains in the interval, then run out the rest.

Step 2 is what keeps the interface out of the control loop. Advancing ten ticks
and only then issuing the commands for the frames inside that span would hand
the mount every command late by the batch size, and the same scenario would
behave differently headless and on screen. A test compares batched and
single-tick execution directly and requires identical frames, modes, command ids
and world state hash.

Step 8 is what keeps the frame pool bounded: a detector or filter that throws
cannot leak a buffer.

The display path is separate. The runtime offers an `onFrame` callback that is
handed a **borrowed** capture after the algorithm has finished with it; a
consumer that wants to draw the frame copies it with `toOwned()`. Interactive
frame dropping therefore cannot make the algorithm miss a sensor frame.

## Configuration

`BaselinePatConfig` is versioned and entirely separate from `SimulationConfig`.
A scenario describes the world; an algorithm config describes how one tracker
chooses to attack it. Mixing them would make it impossible to run two algorithms
against an identical scenario — the whole point of the comparison AstraBench
will do — and would let a scenario author tune the tracker.

The shipped default is used unchanged for every bundled PAT scenario and by
every acceptance test. It is a default, not a fitted constant.

## Measured results

On the bundled scenarios, with the shipped default config, judged from outside
using privileged truth that the algorithm never sees. Since Phase 5 these are
produced by the experiment recorder and are reproducible from the stored
artifacts; see [EXPERIMENTS.md](EXPERIMENTS.md). Errors are the beacon's
true distance from the principal point, sampled from 3 s after acquisition.

| Scenario                     | Acquired | Modes                          | Beacon visible | Median error | p95     |
| ---------------------------- | -------- | ------------------------------ | -------------- | ------------ | ------- |
| `pat-stationary-outside-fov` | 12.0 s   | SEARCH → TRACK                 | 100%           | 0.48 px      | 4.28 px |
| `pat-moving-target`          | 26.0 s   | SEARCH → TRACK                 | 100%           | 0.19 px      | 3.20 px |
| `pat-loss`                   | 0.02 s   | SEARCH → TRACK → LOST → SEARCH | 8.2%           | 2.27 px      | 5.52 px |

The stationary case's median is slightly _worse_ than the moving case's. That is
real: on a stationary target the loop settles into a small limit cycle driven by
the mount's deadband and backlash, whereas on a constant-velocity target the
integral settles into a steady lag that happens to sit closer to centre. It is
reported rather than smoothed over.

Acquisition time is dominated by the scan, not by the tracker: the mount is
rate-limited to 40°/s and the region is 60° × 20°.

## Performance

Measured on the development machine (Apple Silicon, Node 24), 640×480 at 60 FPS:

| Stage                                                                          | Mean    | p95     |
| ------------------------------------------------------------------------------ | ------- | ------- |
| Detector alone on a real frame                                                 | 0.97 ms | —       |
| Detector, over 300 frames                                                      | 1.05 ms | 1.18 ms |
| Whole per-frame path (image formation + detect + bearing + KF + PID + runtime) | 1.02 ms | 1.15 ms |

Against a 16.67 ms frame period that is about 6% of budget, so roughly 16×
headroom. The detector dominates; the filter and controller are not measurable
next to it. There is no case for Rust, WASM or OpenCV at this resolution.

## Known weaknesses

Stated because the robust algorithm needs a real baseline to beat.

1. **The brightest blob wins.** No beacon identity. Anything brighter and
   compact captures the tracker — a test asserts exactly this.
2. **Acquisition is slow.** A blind raster over a large region takes tens of
   seconds. There is no uncertainty weighting and no prior.
3. **Recovery is nothing.** LOST discards the track and restarts the scan from
   the beginning. A target that reappears where it vanished is found only by
   scanning to it again.
4. **The constant-velocity model lags a manoeuvre.** Any real acceleration is
   absorbed as process noise, and the tracker trails through the fastest part of
   a crossing pass.
5. **No feed-forward**, so a constant-rate target sits at a steady offset that
   only the integral removes, and slowly.
6. **The filter can be captured by a false measurement.** A single wrong
   detection is folded in with no gating. There is no NIS test on the update,
   though the NIS is computed and reported.
7. **One track.** No multi-hypothesis association; a second bright object is
   simply ignored or steals the track outright.
8. **Fixed thresholds.** The detector's threshold is a constant. On a sensor
   with a varying background — which does not exist yet — it would need to
   adapt.
9. **No compute-time model.** Algorithm latency is zero after a frame becomes
   available.
10. **No link budget, no SNR.** The sensor has no noise model, so there is no
    ratio to compute. Since Phase 5 `snr` is a `Measurement` reported as
    `not-modelled` rather than as 0 dB — a real physical value meaning signal
    equal to noise, and therefore a lie about a noiseless sensor. See
    [METRICS.md](METRICS.md#na-and-unmodelled-semantics).

Items 1, 3, 4, 5 and 6 are precisely what the robust algorithm is for, and
[ASTRALOCK_PAT.md](ASTRALOCK_PAT.md) records how far it gets with each. Item 1 —
identity — is not solved there either, and remains open until coded beacon
identification.
