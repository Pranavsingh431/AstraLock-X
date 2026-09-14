# Metrics

Every KPI AstraLock-X reports, what it means, how it is computed, over which
samples, and in which units. Definition version **1**
(`METRICS_DEFINITION_VERSION`).

Implementation: `src/core/experiments/metrics.ts` (`SummaryBuilder`,
`LockAnalyser`), `evaluation.ts` (`Evaluator`), `performance-log.ts`. Hand-worked
examples of every rule below are in `metrics.test.ts`. Recording and artifacts:
[EXPERIMENTS.md](EXPERIMENTS.md).

## Ground rules

1. **Every metric is computed from recorded rows.** `events.jsonl`,
   `telemetry.csv`, `evaluation.csv` and the manifest — nothing else. The same
   builder runs at finalisation and in offline recomputation
   ([ADR-0015](adr/0015-persisted-raw-data-is-the-source-of-truth.md)).
2. **Truth-derived metrics are evaluation-only.** They are computed after the
   fact, from privileged samples the algorithm never receives
   ([ADR-0014](adr/0014-evaluation-reads-truth-one-way.md)).
3. **Host time is not simulated time.** They are never combined
   ([ADR-0016](adr/0016-host-time-is-not-simulated-time.md)).
4. **No threshold is baked into raw data.** Thresholds live in `metricsConfig`,
   which is recorded in the manifest and in the summary, with its fingerprint.
5. **Absence is explicit.** No `0`, `NaN`, `Infinity` or `-1` stands in for a
   missing value.

## N/A and unmodelled semantics

A quantity that may be absent is a `Measurement` (`src/core/contracts/measurement.ts`):
`{ value: number | null, status, unit }`.

| Status           | Value   | Meaning                                                               | Rendered as    |
| ---------------- | ------- | --------------------------------------------------------------------- | -------------- |
| `measured`       | present | Sensed by a modelled instrument                                       | the number     |
| `derived`        | present | Computed from recorded data                                           | the number     |
| `configured`     | present | Read from configuration                                               | the number     |
| `not-modelled`   | `null`  | The simulation does not model the physics                             | "Not modelled" |
| `not-applicable` | `null`  | Meaningless in this context                                           | "N/A"          |
| `not-measured`   | `null`  | Modelled and meaningful, but no sample existed (e.g. an empty window) | "Not measured" |

The schema rejects a present status without a value, an absent status with one,
and non-finite numbers.

**Audit of placeholder values (Phase 5 preflight).** Three safe diagnostics
reported physical values for effects that are not simulated:

| Field                       | Phase 4 | Now                 | Why                                                                                   |
| --------------------------- | ------- | ------------------- | ------------------------------------------------------------------------------------- |
| `TargetObservation.snr`     | `0 dB`  | `not-modelled` (dB) | No noise model. 0 dB means signal equals noise — a terrible detection, not "unknown". |
| `GimbalState.latency`       | `0 s`   | `not-modelled` (s)  | The encoder is read instantaneously; no reporting delay is modelled.                  |
| `GimbalState.encoderHealth` | `1`     | `not-modelled` (1)  | No encoder fault model; 1 would read as "measured, perfectly healthy".                |

Mission Control shows the current detection's SNR as "Not modelled". Values that
are genuine model properties — zero lens distortion, identity mounting rotation —
are configuration of an ideal model, not placeholders, and are unchanged.
`linkMargin` was already `null`.

## Statistics

For a window of `n` values:

| Statistic | Formula                                                                            |
| --------- | ---------------------------------------------------------------------------------- |
| mean      | Σxᵢ / n                                                                            |
| RMS       | √(Σxᵢ² / n)                                                                        |
| median    | P(0.5)                                                                             |
| P95       | P(0.95)                                                                            |
| max       | largest xᵢ                                                                         |
| P(q)      | linear interpolation on the sorted values at position q·(n−1) (Hyndman–Fan type 7) |

Interpolated rather than nearest-rank so a small sample's P95 is not forced onto
its maximum. An empty window gives `count: 0` and every statistic `not-measured`.

## Pointing error

### Angular pointing error

The angle between the **true optical axis** of the camera and the **true line
of sight** from the platform to the **designated target**, at a frame's capture
instant.

```
a = unit optical axis    (from the mount's true mechanical pan/tilt, not the encoder)
b = unit line of sight   (target position − platform position, normalised)

angular_pointing_error = atan2(|a × b|, a · b)          radians
```

`atan2` rather than `acos(a · b)`: near zero — where a working tracker lives —
`acos` has infinite slope and the dot product equals 1 to within rounding, so a
100 µrad error is resolved to only a few digits. The cross product is linear in
the angle there. Not an azimuth/elevation difference, which misbehaves near the
zenith and at azimuth wrap. Stored in radians; reported in µrad.

The optical axis comes from the true pose because scoring against the encoder
would score the tracker's belief about where it pointed, which is exactly the
error being measured.

### Image-space pointing error

The distance, in pixels, from the **true projected target centre** to the
**principal point**, using the true optics. Defined only when the target projects
inside the image; otherwise the cell is empty and the sample is excluded from
image-space statistics (the count shows how many).

### Detector centroid error

The distance from the detector's selected centroid to the **true projected
centre** of the designated target. A **detector** diagnostic: it says how well
the spot was located in the image the detector was given, not where the camera
was aimed. Defined only when a detection exists **and** the target projects into
the image. A miss is a miss — never an enormous error. Frames with the target in
the image and no detection are counted in `detectorMissesWithTargetInImage`.

Image coordinates are continuous, pixel centres at half-integers, principal point
at (width/2, height/2) for the bundled cameras; the detector reports centroids in
the same convention.

## Sample windows

Every angular and image statistic is reported over three windows. The report
states which window every figure comes from.

| Window            | Samples                                                                |
| ----------------- | ---------------------------------------------------------------------- |
| `wholeRun`        | every frame where the quantity is defined                              |
| `postAcquisition` | frames with capture time ≥ T_COARSE_LOCK, **including** any later loss |
| `trackState`      | frames where the algorithm reported TRACK                              |

`wholeRun` includes search, when the target is typically far outside the field.
`trackState` is not whole-run accuracy and is never labelled as such. The
official "average/maximum tracking error" is `postAcquisition` (see
[the performance log](#performance-log)).

## Trackability

A sample's target is **trackable** when

```
truth_target_within_travel  AND  truth_target_range_m ≤ maxTrackableRangeM
```

Within travel: the true bearing's azimuth and elevation lie inside both axes'
configured travel. Deliberately nothing about where the camera pointed, and
nothing about angular rate: a tracker that loses the target by pointing badly, or
because the target outruns the mount, is charged for it.

## Acquisition milestones

| Milestone         | Definition                                                                                                                                                                       | Source           |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| T_SEARCH_START    | First `search-started` event: the first processed frame of a recording whose PAT state is SCAN                                                                                   | `events.jsonl`   |
| T_FIRST_DETECTION | First frame where a detection is present, the target is in the image, the centroid lies within `detectionAssociationRadiusPx` of its true centre, and no other emitter is nearer | `evaluation.csv` |
| T_TRACK_ENTRY     | First `track-entered` event                                                                                                                                                      | `events.jsonl`   |
| T_COARSE_LOCK     | First confirmed coarse lock (below)                                                                                                                                              | `evaluation.csv` |

Derived, all simulated seconds:

```
timeToFirstDetection  = T_FIRST_DETECTION − T_SEARCH_START
timeToTrack           = T_TRACK_ENTRY     − T_SEARCH_START
coarseAcquisitionTime = T_COARSE_LOCK     − T_SEARCH_START
```

`acquisitionOutcome`: `no-samples` (no evaluation rows), `no-acquisition` (never
locked), `no-search-recorded` (locked, but the recording did not see search
begin — acquisition time is then `not-measured`), else `acquired`.

T_FIRST_DETECTION precedes T_TRACK_ENTRY for the baseline, which requires
`detectionsBeforeTrack` (2) consecutive detections.

## Coarse lock

An **evaluator-only** condition. The algorithm never receives it and its
behaviour cannot depend on it.

```
lock condition at a sample:
    truth_angular_pointing_error_rad ≤ lockErrorThresholdRad
    AND target trackable
    AND pat_state = track
```

Algorithm state alone is not a lock: a tracker can sit in TRACK pointing at
nothing (reported as `trackClaimedWithoutLockSeconds`).

`LockAnalyser` processes samples in capture order with three states — unlocked,
locked, lapsing:

- **Confirmation.** From unlocked, lock is confirmed at the first sample t at
  which the condition has held at every sample since some t_s with
  t − t_s ≥ `lockDwellSeconds`. T_COARSE_LOCK is the first such t.
- **Lapse.** When a locked condition fails at t_a, the state becomes lapsing.
- **Bridged.** If the condition is met again at a sample t with
  t − t_a ≤ `lockDropoutGraceSeconds`, the state returns to locked and the lapse
  counts as locked time.
- **Loss.** If a failing sample has t − t_a ≥ grace, or the condition returns only
  with t − t_a > grace, a loss episode is recorded **starting at t_a**, the lapse
  is not credited, and a fresh dwell is required to lock again.
- **Open lapse at the end.** Neither declared a loss nor credited as locked.

Default definition (`DEFAULT_METRICS_CONFIG`):

| Parameter                      | Value    | Rationale                                                                                       |
| ------------------------------ | -------- | ----------------------------------------------------------------------------------------------- |
| `lockErrorThresholdRad`        | 2 × 10⁻³ | About 1 % of the bundled 12° field; tight, but outside what deadband and backlash alone produce |
| `lockDwellSeconds`             | 0.5      | Rules out a single lucky frame                                                                  |
| `lockDropoutGraceSeconds`      | 0.25     | One marginal frame is not a loss-and-reacquire pair                                             |
| `maxTrackableRangeM`           | 50,000   | Beyond any bundled scenario; a scenario that needs a limit sets one                             |
| `detectionAssociationRadiusPx` | 5        | ≈ 2 PSF sigmas for the bundled beacons; a noiseless centroid is well under 1 px from truth      |

## Lock retention

### Time integration

**Zero-order hold on the earlier sample.** For consecutive samples at t₍ᵢ₋₁₎ and
tᵢ, the interval (t₍ᵢ₋₁₎, tᵢ] takes the state established at t₍ᵢ₋₁₎. Nothing is
extrapolated past the last sample.

### Formula

```
trackableOpportunity = Σ intervals whose earlier sample is at or after T_COARSE_LOCK
                         and had a trackable target
lockedDuration       = Σ of those intervals whose earlier sample was locked,
                         plus bridged lapse time

lockRetentionRate    = lockedDuration / trackableOpportunity        (dimensionless, [0, 1])
```

The denominator **includes** time pointed the wrong way, time after a loss, and
time spent re-dwelling. It excludes only time the target was out of travel or
range.

| Case                                                 | `lockRetentionRate` | `lockRetentionStatus`      |
| ---------------------------------------------------- | ------------------- | -------------------------- |
| Locked, with opportunity                             | derived ratio       | `computed`                 |
| Target trackable at some point, never locked         | derived **0**       | `no-acquisition`           |
| Target never trackable, or no opportunity after lock | `not-applicable`    | `no-trackable-opportunity` |

## Loss and reacquisition

Each loss episode records `lost_at_s` (t_a), `recovered_at_s` (the next
T_COARSE_LOCK) and `duration_s`. An episode never recovered before the run ended
is kept with `recovered_at_s: null`, `duration_s: null`, `unrecovered: true` —
**censored, not dropped**.

| Field                | Meaning                                                         |
| -------------------- | --------------------------------------------------------------- |
| `lossOfLockEpisodes` | all episodes                                                    |
| `reacquisitionCount` | recovered episodes                                              |
| `unrecoveredLosses`  | censored episodes                                               |
| `reacquisitionTime`  | count/mean/RMS/median/P95/max over **recovered** durations only |
| `episodes`           | the full list                                                   |

The loss count and the censored count make clear what the timing statistics omit.

## False lock

**Wrong source.** Time in TRACK while the selected detection's nearest projected
emitter is not the designated target (`truth_detection_on_other_emitter`).

```
falseLockEpisodes        = number of rising edges of (TRACK ∧ detection on other emitter)
falseLockDurationSeconds = zero-order-hold integral of the same condition
falseLockRate            = falseLockDurationSeconds / time in TRACK
```

**Not** high pointing error: that is a loss of lock, a different failure. TRACK
without the lock condition is reported separately as
`trackClaimedWithoutLockSeconds`, and is not attributed to a wrong source.

**Exercised?** `falseLockExercised` is true only if some sample had a
non-designated emitter in the image. Otherwise duration and rate are
`not-applicable`, and the report says the challenge was not exercised: a count
of zero from a single-emitter scenario is not evidence of identity robustness.
Every bundled Phase 4 scenario has one emitter.

## Frame rates

| Quantity                    | Definition                                                                   |
| --------------------------- | ---------------------------------------------------------------------------- |
| `configuredSensorFps`       | `camera.frameRate` from the scenario (`configured`)                          |
| `sensorFramesGenerated`     | raw counter: frames generated for the loop with capture time in [start, end) |
| `algorithmFramesProcessed`  | telemetry rows with capture time in [start, end)                             |
| `autonomousDurationSeconds` | end − max(first `autonomy-enabled`, start)                                   |
| `effectiveSensorFps`        | `sensorFramesGenerated / autonomousDurationSeconds`                          |
| `algorithmProcessedFps`     | `algorithmFramesProcessed / autonomousDurationSeconds`                       |

**Half-open window.** A camera at f fps produces f·T frames in [start, end) but
f·T + 1 if a frame lands on each end, which would read as a sensor running fast
(this build first showed 60.025 fps against 60). A frame captured exactly at the
end instant is still recorded in telemetry but belongs to the next interval.

The runtime delivers every frame in capture order and skips none, so the two
rates are equal unless a frame was generated and then failed to process.

A count over a window is quantised: over an arbitrary window of length T the
rate can exceed the configured rate by up to 1/T (a 26.26 s desktop run reads
60.015 fps: 1,576 frames).

**Host timer resolution** is measured before recording and stored as
`host.timerResolutionMs`. Node resolves far below a microsecond; the macOS
desktop webview (WKWebView) resolves **1 ms**, so there a stage shorter than a
millisecond reads 0 on an individual frame and medians and percentiles are
quantised. Means over many frames remain informative.

Not reported: **display FPS** (the report describes the simulation, not the
interface; shown as "Not measured"), and a frame rate derived from the playback
multiplier. **Host throughput** is measured only in the intentional benchmark in
`performance.test.ts`.

## Simulated control latency

From `command-issued` and `command-applied` events, joined by command id. All
simulated seconds.

| Interval                       | Formula                 | Count over                                       |
| ------------------------------ | ----------------------- | ------------------------------------------------ |
| `captureToIssue`               | issuedAt − captureTime  | commands issued during the recording             |
| `issueToApplication`           | appliedAt − issuedAt    | commands issued **and** applied in the recording |
| `captureToApplication`         | appliedAt − captureTime | as above                                         |
| `scheduledToActualApplication` | appliedAt − dueAt       | as above                                         |

`appliedAt` is read from the mount's own record of when it applied the command,
not assumed from the configured latency. `commandsPendingAtEnd` counts commands
issued but not yet applied when the run ended; an application of a command
issued before recording began is ignored.

**Compute latency is modelled as zero.** Capture → issue is only the wait for the
next physics tick boundary (0–5 ms at 200 Hz, 1.67 ms mean for a 60 fps camera);
issue → application is the mount's configured transport latency (23 ms for the
bundled mounts), applied at its exact due time.

## Host processing time

Wall-clock durations on the machine that ran the experiment, from
`performance.now()` (monotonic, high resolution), in milliseconds per processed
frame. Performance diagnostics; they never affect commands, simulated time or any
hash, and differ on every run
([ADR-0016](adr/0016-host-time-is-not-simulated-time.md)).

| Stage                   | What is timed                                                                                 |
| ----------------------- | --------------------------------------------------------------------------------------------- |
| `worldStep`             | Advancing world and mount to the frame's availability tick                                    |
| `sensorFrameGeneration` | Rasterising the frame                                                                         |
| `algorithmTotal`        | The algorithm's `update`, end to end                                                          |
| `detector`              | Baseline threshold + connected components + centroid                                          |
| `bearingTransform`      | Inverse pinhole to a world bearing                                                            |
| `estimator`             | Kalman initialise / update / predict                                                          |
| `controller`            | PID step in TRACK, scan step in SEARCH                                                        |
| `runtimeOrchestration`  | Iteration time − world − sensor − algorithm: input building, encoder read, command submission |

The four top-level stages partition one loop iteration, excluding observer and
display callbacks. The algorithm reports its stages through a write-only
`StageProfiler`: it hands over work and gets the work's result back, never a
duration. A stage that did not run on a frame is empty in `telemetry.csv` and not
counted. Earlier in this phase `detector` was a copy of the whole-algorithm time
and `runtimeOrchestration` timed a single property read; both are now real.

## Performance log

The brief asks for simulation duration, FPS, acquisition time, average and
maximum tracking error, lock retention rate and processing time. Each is bound to
one summary field (`performance-log.ts`), printed at the top of the report, and
checked against the data model in `compliance.test.ts`:

| Category               | Field                                                                | Definition in brief form                                  |
| ---------------------- | -------------------------------------------------------------------- | --------------------------------------------------------- |
| Simulation duration    | `simulationDurationSeconds`                                          | end − start, simulated                                    |
| FPS                    | `configuredSensorFps`, `effectiveSensorFps`, `algorithmProcessedFps` | three distinct rates, above                               |
| Acquisition time       | `coarseAcquisitionTime`                                              | T_COARSE_LOCK − T_SEARCH_START                            |
| Average tracking error | `angularPointingError.postAcquisition.mean`                          | angular, from first coarse lock, including any later loss |
| Maximum tracking error | `angularPointingError.postAcquisition.max`                           | as above                                                  |
| Lock retention rate    | `lockRetentionRate`                                                  | locked ÷ trackable after first lock                       |
| Processing time        | `hostProcessingTime.algorithmTotal.mean`                             | host wall clock per frame; not simulated latency          |

## Validation results

Measured by `recorder.test.ts` on the bundled Phase 4 scenarios with the default
definition. Validation records of a deliberately simple baseline in a noiseless
simulation — not benchmark claims.

| Scenario (duration)                 | Search → detection → TRACK → lock | Acquisition | Retention | Post-acq. angular mean / P95 / max | Post-acq. image median | Losses                     |
| ----------------------------------- | --------------------------------- | ----------- | --------- | ---------------------------------- | ---------------------- | -------------------------- |
| `pat-stationary-outside-fov` (40 s) | 0 → 11.90 → 11.92 → 16.05 s       | 16.05 s     | 100 %     | 199 / 716 / 1,490 µrad             | 0.48 px                | 0                          |
| `pat-moving-target` (50 s)          | 0 → 25.90 → 25.92 → 30.10 s       | 30.10 s     | 100 %     | 143 / 691 / 1,374 µrad             | 0.21 px                | 0                          |
| `pat-loss` (40 s)                   | 0 → 0.00 → 0.02 → 3.53 s          | 3.53 s      | 6.8 %     | 1.29 / 1.87 / 1.99 rad             | 2.15 px                | 1, unrecovered from 6.02 s |

Pointing jitter in the first two rows is dominated by the scenarios' platform
base disturbance (1.5 mrad RMS), not the detector, whose median centroid error is
under 0.01 px. The loss scenario's post-acquisition error is large because the
window deliberately includes everything after the target outran the mount. The
image medians agree with the Phase 4 validation (0.48 px and 0.19 px, measured
from 3 s after acquisition).
