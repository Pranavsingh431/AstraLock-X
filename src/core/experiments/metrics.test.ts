// @vitest-environment node
/**
 * The KPI engine, on sequences whose answers were worked out by hand.
 *
 * Deliberately independent of the simulator. A metric checked only against a
 * real run is checked against whatever the code happens to produce; a metric
 * checked against a sequence built to have a specific answer is checked against
 * the definition. Each expected value below is written as the arithmetic that
 * produces it, from docs/METRICS.md, not by running the function first.
 *
 * Times are multiples of 0.25 s so every sum is exact in binary floating point
 * and the expectations can be compared exactly.
 */

import { describe, expect, it } from 'vitest';

import { fingerprint } from './fingerprint';
import { analyseLock, computeSummary, percentile, statistics } from './metrics';
import type { SummaryContext } from './metrics';
import { DEFAULT_METRICS_CONFIG, experimentSummarySchema } from './schema';
import type { EvaluationSample, ExperimentEvent, MetricsConfig, TelemetrySample } from './schema';

// --- Builders ---------------------------------------------------------------

const CONFIG: MetricsConfig = {
  ...DEFAULT_METRICS_CONFIG,
  lockErrorThresholdRad: 1e-3,
  lockDwellSeconds: 0.5,
  lockDropoutGraceSeconds: 0.5,
  maxTrackableRangeM: 5000,
  detectionAssociationRadiusPx: 5,
};

/** A locked-looking sample: on target, trackable, in TRACK. Patch what differs. */
const at = (time: number, patch: Partial<EvaluationSample> = {}): EvaluationSample => ({
  frame_id: Math.round(time * 1000),
  capture_time_s: time,
  pat_state: 'track',
  detection_present: false,
  truth_optical_axis_east: 0,
  truth_optical_axis_north: 1,
  truth_optical_axis_up: 0,
  truth_target_los_east: 0,
  truth_target_los_north: 1,
  truth_target_los_up: 0,
  truth_angular_pointing_error_rad: 0,
  truth_target_range_m: 1000,
  truth_target_within_travel: true,
  truth_target_in_image: true,
  truth_image_x_px: 320,
  truth_image_y_px: 240,
  truth_image_pointing_error_px: 0,
  truth_detector_centroid_error_px: null,
  truth_detection_on_other_emitter: false,
  truth_other_emitters_in_image: 0,
  ...patch,
});

/** Samples every 0.25 s from `from` to `to` inclusive. */
const every = (
  from: number,
  to: number,
  patch: (time: number) => Partial<EvaluationSample> = () => ({}),
): EvaluationSample[] => {
  const out: EvaluationSample[] = [];
  for (let step = Math.round(from * 4); step <= Math.round(to * 4); step += 1) {
    out.push(at(step / 4, patch(step / 4)));
  }
  return out;
};

const OFF_TARGET: Partial<EvaluationSample> = { truth_angular_pointing_error_rad: 0.1 };

let sequence = 0;
const event = (
  type: ExperimentEvent['type'],
  simulationTime: number,
  detail: ExperimentEvent['detail'] = {},
): ExperimentEvent => ({ sequence: sequence++, simulationTime, tick: 0, type, detail });

const telemetryAt = (
  captureTime: number,
  patch: Partial<TelemetrySample> = {},
): TelemetrySample => ({
  frame_id: Math.round(captureTime * 60),
  frame_capture_time_s: captureTime,
  command_issue_time_s: captureTime,
  tick: 0,
  pat_state: 'track',
  candidate_count: 1,
  components_found: 1,
  centroid_x_px: 320,
  centroid_y_px: 240,
  candidate_score: 0.5,
  filtered_azimuth_rad: 0,
  filtered_elevation_rad: 0,
  filtered_azimuth_rate_rad_s: 0,
  filtered_elevation_rate_rad_s: 0,
  pid_pan_correction_rad: 0,
  pid_tilt_correction_rad: 0,
  command_id: null,
  commanded_pan_rad: null,
  commanded_tilt_rad: null,
  measured_pan_rad: 0,
  measured_tilt_rad: 0,
  measured_pan_rate_rad_s: 0,
  measured_tilt_rate_rad_s: 0,
  pan_saturation: 'none',
  tilt_saturation: 'none',
  consecutive_misses: 0,
  search_waypoint_index: null,
  host_world_step_ms: 0.1,
  host_sensor_frame_ms: 1,
  host_algorithm_ms: 2,
  host_detector_ms: 1.5,
  host_bearing_transform_ms: 0.01,
  host_estimator_ms: 0.02,
  host_controller_ms: 0.03,
  host_orchestration_ms: 0.2,
  track_quality: null,
  acquisition_evidence: null,
  innovation_nis: null,
  gate_accepted: null,
  imm_cv_probability: null,
  imm_ca_probability: null,
  filtered_azimuth_accel_rad_s2: null,
  filtered_elevation_accel_rad_s2: null,
  angular_sigma_rad: null,
  prediction_horizon_s: null,
  predicted_azimuth_rad: null,
  predicted_elevation_rad: null,
  feedforward_pan_rad: null,
  feedforward_tilt_rad: null,
  recovery_age_s: null,
  local_search_radius_rad: null,
  handoff_dwell_s: null,
  ...patch,
});

const context = (patch: Partial<SummaryContext> = {}): SummaryContext => ({
  schemaVersion: 2,
  runId: 'run-synthetic',
  metricsConfig: CONFIG,
  metricsFingerprint: fingerprint(CONFIG),
  terminationReason: 'operator-finalised',
  configuredSensorFps: 60,
  sensorFramesGenerated: 0,
  startSimulationTime: 0,
  endSimulationTime: 10,
  ...patch,
});

const summarise = (
  evaluation: readonly EvaluationSample[],
  extra: {
    events?: ExperimentEvent[];
    telemetry?: TelemetrySample[];
    context?: Partial<SummaryContext>;
  } = {},
) => {
  const summary = computeSummary({
    events: extra.events ?? [],
    telemetry: extra.telemetry ?? [],
    evaluation,
    context: context(extra.context),
  });
  // Every summary the engine produces must satisfy its own schema, including
  // the rule that an absent value carries an absent status.
  experimentSummarySchema.parse(summary);
  return summary;
};

// --- Statistics -------------------------------------------------------------

describe('summary statistics', () => {
  it('computes mean, RMS, median, P95 and max on a known set', () => {
    // 1..10: sum 55, sum of squares 385.
    const stats = statistics([7, 3, 10, 1, 5, 9, 2, 8, 4, 6], 'rad');
    expect(stats.count).toBe(10);
    expect(stats.mean.value).toBe(55 / 10);
    expect(stats.rms.value).toBe(Math.sqrt(385 / 10));
    // Median at position 0.5 * 9 = 4.5, between the 5th and 6th values: 5.5.
    expect(stats.median.value).toBe(5.5);
    // P95 at position 0.95 * 9 = 8.55: 9 + 0.55 * (10 - 9).
    expect(stats.p95.value).toBeCloseTo(9.55, 12);
    expect(stats.max.value).toBe(10);
    expect(stats.mean.unit).toBe('rad');
    expect(stats.mean.status).toBe('derived');
  });

  it('separates RMS from mean, which matters for a heavy tail', () => {
    // Nine zeros and a ten: mean 1, RMS sqrt(100 / 10) = sqrt(10).
    const stats = statistics([0, 0, 0, 0, 0, 0, 0, 0, 0, 10], 'px');
    expect(stats.mean.value).toBe(1);
    expect(stats.rms.value).toBe(Math.sqrt(10));
  });

  it('interpolates percentiles rather than snapping to an observation', () => {
    // Twenty values 1..20: nearest-rank P95 would be 19; type 7 gives
    // position 0.95 * 19 = 18.05, so 19 + 0.05 * 1.
    const sorted = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(percentile(sorted, 0.95)).toBeCloseTo(19.05, 12);
    expect(percentile([4], 0.95)).toBe(4);
  });

  it('reports an empty window as not measured, never as zero', () => {
    const stats = statistics([], 's');
    expect(stats.count).toBe(0);
    for (const field of [stats.mean, stats.rms, stats.median, stats.p95, stats.max]) {
      expect(field.value).toBeNull();
      expect(field.status).toBe('not-measured');
      expect(field.unit).toBe('s');
    }
  });
});

// --- Lock -------------------------------------------------------------------

describe('coarse lock and retention', () => {
  it('is confirmed only once the condition has held for the dwell', () => {
    // Condition holds from t = 0; dwell 0.5 s, so lock is confirmed at 0.5.
    // Locked time starts there: intervals (0.5, 0.75] and (0.75, 1.0].
    const lock = analyseLock(every(0, 1), CONFIG);
    expect(lock.lockTime).toBe(0.5);
    expect(lock.lockedDuration).toBe(0.5);
    expect(lock.trackableDuration).toBe(0.5);
    expect(lock.episodes).toEqual([]);
  });

  it('is never confirmed when a failure resets the dwell', () => {
    // Held at 0 and 0.25, failed at 0.5, held again from 0.75: by 1.0 only
    // 0.25 s of continuous hold, short of the 0.5 s dwell.
    const samples = every(0, 1, (t) => (t === 0.5 ? OFF_TARGET : {}));
    const summary = summarise(samples);
    expect(summary.coarseLockTime.value).toBeNull();
    expect(summary.coarseLockTime.status).toBe('not-measured');
    // The target was trackable throughout, so this is a failure to acquire:
    // a real zero, not an undefined rate.
    expect(summary.lockRetentionRate.value).toBe(0);
    expect(summary.lockRetentionStatus).toBe('no-acquisition');
    expect(summary.acquisitionOutcome).toBe('no-acquisition');
  });

  it('bridges a lapse regained within the grace period, counting it as locked', () => {
    // Lock at 0.5. Fails at 1.0 and 1.25, regained at 1.5: 1.5 - 1.0 = 0.5,
    // within the 0.5 s grace. All of (0.5, 3.0] is locked: 2.5 s.
    const samples = every(0, 3, (t) => (t === 1 || t === 1.25 ? OFF_TARGET : {}));
    const lock = analyseLock(samples, CONFIG);
    expect(lock.episodes).toEqual([]);
    expect(lock.lockedDuration).toBe(2.5);
    expect(lock.trackableDuration).toBe(2.5);
  });

  it('records a loss that outlasts the grace, and a reacquisition after a fresh dwell', () => {
    // Lock at 0.5. Fails at 1.0, 1.25 and 1.5: at 1.5 the lapse has lasted
    // 0.5 s, so the loss is declared as starting at 1.0. Condition returns at
    // 1.75; after 0.5 s of dwell lock is confirmed again at 2.25.
    //   locked:    (0.5, 1.0] + (2.25, 3.0] = 0.5 + 0.75 = 1.25
    //   trackable: (0.5, 3.0]                              = 2.5
    const samples = every(0, 3, (t) => (t >= 1 && t <= 1.5 ? OFF_TARGET : {}));
    const summary = summarise(samples);
    expect(summary.episodes).toEqual([
      { lost_at_s: 1, recovered_at_s: 2.25, duration_s: 1.25, unrecovered: false },
    ]);
    expect(summary.lockedDurationSeconds.value).toBe(1.25);
    expect(summary.trackableOpportunitySeconds.value).toBe(2.5);
    expect(summary.lockRetentionRate.value).toBe(0.5);
    expect(summary.lossOfLockEpisodes).toBe(1);
    expect(summary.reacquisitionCount).toBe(1);
    expect(summary.unrecoveredLosses).toBe(0);
    expect(summary.reacquisitionTime.median.value).toBe(1.25);
    expect(summary.reacquisitionTime.max.value).toBe(1.25);
  });

  it('keeps an unrecovered loss in the record, censored, and out of the timing statistics', () => {
    // Lock at 0.5; condition fails from 1.0 to the end. Loss declared at 1.0.
    //   locked 0.5; trackable (0.5, 3.0] = 2.5; retention 0.2.
    const samples = every(0, 3, (t) => (t >= 1 ? OFF_TARGET : {}));
    const summary = summarise(samples);
    expect(summary.episodes).toEqual([
      { lost_at_s: 1, recovered_at_s: null, duration_s: null, unrecovered: true },
    ]);
    expect(summary.lossOfLockEpisodes).toBe(1);
    expect(summary.unrecoveredLosses).toBe(1);
    expect(summary.reacquisitionCount).toBe(0);
    expect(summary.reacquisitionTime.count).toBe(0);
    expect(summary.reacquisitionTime.median.status).toBe('not-measured');
    expect(summary.lockRetentionRate.value).toBe(0.2);
  });

  it('declares a loss when the condition only returns after the grace has passed', () => {
    // A gap in the samples: failing at 1.0, next sample 2.0 is on target. The
    // lapse lasted 1.0 s > 0.5 s grace, so it is a loss from 1.0, and 2.0 starts
    // a fresh dwell confirmed at 2.5.
    //   locked (0.5, 1.0] + (2.5, 2.75] = 0.75; trackable (0.5, 2.75] = 2.25.
    const samples = [...every(0, 0.75), at(1, OFF_TARGET), ...every(2, 2.75)];
    const lock = analyseLock(samples, CONFIG);
    expect(lock.episodes).toEqual([
      { lost_at_s: 1, recovered_at_s: 2.5, duration_s: 1.5, unrecovered: false },
    ]);
    expect(lock.lockedDuration).toBe(0.75);
    expect(lock.trackableDuration).toBe(2.25);
  });

  it('neither declares nor credits a lapse still open when the samples end', () => {
    // Lock at 0.5; failing at 1.0 and 1.25, where the samples stop. The lapse
    // (0.25 s) is inside the grace, so no loss — but it is not locked time.
    const samples = every(0, 1.25, (t) => (t >= 1 ? OFF_TARGET : {}));
    const lock = analyseLock(samples, CONFIG);
    expect(lock.episodes).toEqual([]);
    expect(lock.lockedDuration).toBe(0.5);
    expect(lock.trackableDuration).toBe(0.75);
  });

  it('keeps bad pointing in the denominator and takes unreachable time out of it', () => {
    // Lock at 0.5. Pointing goes bad at 1.0 (loss declared at 1.5, from 1.0)
    // while the target stays reachable: that time counts. From 2.0 the bearing
    // leaves the mount's travel: that time does not.
    //   trackable (0.5, 2.0] = 1.5; locked (0.5, 1.0] = 0.5; retention 1/3.
    const samples = every(0, 3, (t) => ({
      ...(t >= 1 ? OFF_TARGET : {}),
      ...(t >= 2 ? { truth_target_within_travel: false } : {}),
    }));
    const summary = summarise(samples);
    expect(summary.trackableOpportunitySeconds.value).toBe(1.5);
    expect(summary.lockedDurationSeconds.value).toBe(0.5);
    expect(summary.lockRetentionRate.value).toBeCloseTo(1 / 3, 15);
  });

  it('treats a target beyond the trackable range as unavailable', () => {
    const samples = every(0, 2, () => ({ truth_target_range_m: 6000 }));
    const summary = summarise(samples);
    expect(summary.coarseLockTime.value).toBeNull();
    expect(summary.lockRetentionRate.value).toBeNull();
    expect(summary.lockRetentionStatus).toBe('no-trackable-opportunity');
  });

  it('reports retention as N/A, not zero, when there was never an opportunity', () => {
    const samples = every(0, 2, () => ({ truth_target_within_travel: false }));
    const summary = summarise(samples);
    expect(summary.lockRetentionRate.value).toBeNull();
    expect(summary.lockRetentionRate.status).toBe('not-applicable');
    expect(summary.lockRetentionStatus).toBe('no-trackable-opportunity');
  });

  it('does not count TRACK state as lock', () => {
    // In TRACK the whole time, but pointing is off: TRACK is claimed without
    // lock for every interval, (0, 1.0] = 1.0 s, and lock is never confirmed.
    const samples = every(0, 1, () => OFF_TARGET);
    const summary = summarise(samples);
    expect(summary.coarseLockTime.value).toBeNull();
    expect(summary.trackClaimedWithoutLockSeconds.value).toBe(1);
  });
});

// --- Milestones and windows -------------------------------------------------

describe('acquisition milestones', () => {
  const samples = [
    // Searching, target far off, a detection that is not the target (8 px away).
    at(0, {
      pat_state: 'scan',
      truth_angular_pointing_error_rad: 0.3,
      truth_image_pointing_error_px: null,
      truth_target_in_image: false,
      detection_present: true,
      truth_detector_centroid_error_px: null,
    }),
    // A detection near the target's centre but nearer another emitter.
    at(0.25, {
      pat_state: 'scan',
      truth_angular_pointing_error_rad: 0.2,
      truth_image_pointing_error_px: 150,
      detection_present: true,
      truth_detector_centroid_error_px: 0.5,
      truth_detection_on_other_emitter: true,
    }),
    // A detection 8 px from the target: outside the 5 px association radius.
    at(0.5, {
      truth_angular_pointing_error_rad: 5e-4,
      truth_image_pointing_error_px: 1.5,
      detection_present: true,
      truth_detector_centroid_error_px: 8,
    }),
    // The first detection that is of the target.
    at(0.75, {
      truth_angular_pointing_error_rad: 5e-4,
      truth_image_pointing_error_px: 1.5,
      detection_present: true,
      truth_detector_centroid_error_px: 0.25,
    }),
    at(1, {
      truth_angular_pointing_error_rad: 5e-4,
      truth_image_pointing_error_px: 1.5,
      detection_present: true,
      truth_detector_centroid_error_px: 0.25,
    }),
  ];
  const events = [event('search-started', 0.125), event('track-entered', 0.5)];

  it('reports each milestone separately, and acquisition as lock minus search start', () => {
    const summary = summarise(samples, { events });
    expect(summary.searchStartTime.value).toBe(0.125);
    // Associated detection: not 0 (target not in image), not 0.25 (another
    // emitter nearer), not 0.5 (outside the radius) — 0.75.
    expect(summary.firstDetectionTime.value).toBe(0.75);
    expect(summary.trackEntryTime.value).toBe(0.5);
    // Condition holds from 0.5 (TRACK, 0.5 mrad), dwell 0.5: lock at 1.0.
    expect(summary.coarseLockTime.value).toBe(1);
    expect(summary.timeToFirstDetection.value).toBe(0.75 - 0.125);
    expect(summary.timeToTrack.value).toBe(0.5 - 0.125);
    expect(summary.coarseAcquisitionTime.value).toBe(1 - 0.125);
    expect(summary.acquisitionOutcome).toBe('acquired');
  });

  it('separates the whole-run, post-acquisition and TRACK windows', () => {
    const summary = summarise(samples, { events });
    const angular = summary.angularPointingError;
    expect(angular.wholeRun.count).toBe(5);
    expect(angular.wholeRun.mean.value).toBeCloseTo((0.3 + 0.2 + 3 * 5e-4) / 5, 15);
    // Only the sample at the lock instant and after.
    expect(angular.postAcquisition.count).toBe(1);
    expect(angular.postAcquisition.max.value).toBe(5e-4);
    expect(angular.trackState.count).toBe(3);
    expect(angular.trackState.max.value).toBe(5e-4);
    // Image error is only defined while the target is in the image.
    expect(summary.imagePointingError.wholeRun.count).toBe(4);
    expect(summary.imagePointingError.wholeRun.max.value).toBe(150);
    // Centroid error: the three samples with a detection and the target in view.
    expect(summary.detectorCentroidError.count).toBe(4);
    expect(summary.detectorCentroidError.max.value).toBe(8);
  });

  it('cannot report acquisition time without a recorded search start', () => {
    const summary = summarise(samples, { events: [event('track-entered', 0.5)] });
    expect(summary.coarseLockTime.value).toBe(1);
    expect(summary.coarseAcquisitionTime.value).toBeNull();
    expect(summary.coarseAcquisitionTime.status).toBe('not-measured');
    expect(summary.acquisitionOutcome).toBe('no-search-recorded');
  });

  it('counts frames where the target was in view but nothing was detected', () => {
    const summary = summarise(every(0, 1, (t) => ({ detection_present: t >= 0.5 })));
    expect(summary.detectorMissesWithTargetInImage).toBe(2);
  });

  it('reports a run with no samples as such', () => {
    const summary = summarise([]);
    expect(summary.acquisitionOutcome).toBe('no-samples');
    expect(summary.angularPointingError.wholeRun.count).toBe(0);
    expect(summary.lockRetentionRate.status).toBe('not-applicable');
  });
});

// --- False lock -------------------------------------------------------------

describe('false lock on a wrong source', () => {
  it('counts episodes and duration only while TRACK holds a detection on another emitter', () => {
    // Another emitter in view throughout. The detection is on it at 0.5, 0.75
    // and 1.25. Episodes start at 0.5 and 1.25: two. Duration by zero-order
    // hold: (0.5, 0.75] + (0.75, 1.0] + (1.25, 1.5] = 0.75 s. Time in TRACK is
    // all six intervals, 1.5 s, so the rate is 0.5.
    const onOther = new Set([0.5, 0.75, 1.25]);
    const samples = every(0, 1.5, (t) => ({
      truth_other_emitters_in_image: 1,
      detection_present: true,
      truth_detection_on_other_emitter: onOther.has(t),
    }));
    const summary = summarise(samples);
    expect(summary.falseLockExercised).toBe(true);
    expect(summary.falseLockEpisodes).toBe(2);
    expect(summary.falseLockDurationSeconds.value).toBe(0.75);
    expect(summary.falseLockRate.value).toBe(0.5);
  });

  it('is reported as not exercised when no competing emitter was ever in view', () => {
    const summary = summarise(every(0, 1));
    expect(summary.falseLockExercised).toBe(false);
    expect(summary.falseLockEpisodes).toBe(0);
    expect(summary.falseLockDurationSeconds.value).toBeNull();
    expect(summary.falseLockDurationSeconds.status).toBe('not-applicable');
    expect(summary.falseLockRate.status).toBe('not-applicable');
  });

  it('does not treat high pointing error as a false lock', () => {
    const summary = summarise(
      every(0, 1, () => ({ ...OFF_TARGET, truth_other_emitters_in_image: 1 })),
    );
    expect(summary.falseLockEpisodes).toBe(0);
    expect(summary.falseLockDurationSeconds.value).toBe(0);
  });
});

// --- Frames, latency and host timing ----------------------------------------

describe('frame rates', () => {
  it('counts frames over the half-open window, from autonomy engaging', () => {
    // Recording 10-20 s, autonomy from 12 s. Frames at 12 + k/60 up to and
    // including 20: those with capture < 20 number 8 * 60 = 480.
    const telemetry = Array.from({ length: 481 }, (_, k) => telemetryAt(12 + k / 60));
    const summary = summarise([], {
      events: [event('autonomy-enabled', 12)],
      telemetry,
      context: { startSimulationTime: 10, endSimulationTime: 20, sensorFramesGenerated: 480 },
    });
    expect(summary.simulationDurationSeconds.value).toBe(10);
    expect(summary.autonomousDurationSeconds.value).toBe(8);
    expect(summary.algorithmFramesProcessed).toBe(480);
    expect(summary.algorithmProcessedFps.value).toBe(60);
    expect(summary.effectiveSensorFps.value).toBe(60);
    expect(summary.configuredSensorFps).toEqual({ value: 60, status: 'configured', unit: 'fps' });
  });

  it('starts the window at the recording if autonomy was already engaged', () => {
    const summary = summarise([], {
      events: [event('autonomy-enabled', 5)],
      context: { startSimulationTime: 10, endSimulationTime: 20, sensorFramesGenerated: 300 },
    });
    expect(summary.autonomousDurationSeconds.value).toBe(10);
    expect(summary.effectiveSensorFps.value).toBe(30);
  });

  it('reports frame rates as not measured when autonomy never engaged', () => {
    const summary = summarise([]);
    expect(summary.autonomousDurationSeconds.status).toBe('not-measured');
    expect(summary.effectiveSensorFps.value).toBeNull();
    expect(summary.algorithmProcessedFps.status).toBe('not-measured');
  });
});

describe('simulated control latency', () => {
  it('joins issue and application events by command id', () => {
    const events = [
      event('command-issued', 1.005, { commandId: 1, captureTime: 1, issuedAt: 1.005 }),
      event('command-issued', 1.02, { commandId: 2, captureTime: 1.0125, issuedAt: 1.02 }),
      event('command-applied', 1.028, {
        commandId: 1,
        issuedAt: 1.005,
        dueAt: 1.028,
        appliedAt: 1.028,
      }),
      // Issued before recording began: nothing to measure it from.
      event('command-applied', 1.03, {
        commandId: 99,
        issuedAt: 0.9,
        dueAt: 1.03,
        appliedAt: 1.03,
      }),
    ];
    const summary = summarise([], { events });
    expect(summary.commandsIssued).toBe(2);
    expect(summary.commandsApplied).toBe(1);
    // Command 2 was never applied: in flight at the end, counted, not dropped.
    expect(summary.commandsPendingAtEnd).toBe(1);

    const latency = summary.controlLatency;
    expect(latency.captureToIssue.count).toBe(2);
    expect(latency.captureToIssue.max.value).toBeCloseTo(0.0075, 12);
    expect(latency.issueToApplication.count).toBe(1);
    expect(latency.issueToApplication.mean.value).toBeCloseTo(0.023, 12);
    expect(latency.captureToApplication.mean.value).toBeCloseTo(0.028, 12);
    expect(latency.scheduledToActualApplication.max.value).toBe(0);
    expect(latency.issueToApplication.mean.unit).toBe('s');
  });
});

describe('host processing time', () => {
  it('is kept per stage, skipping frames on which a stage did not run', () => {
    const telemetry = [
      telemetryAt(0, { host_estimator_ms: null, host_algorithm_ms: 1 }),
      telemetryAt(1 / 60, { host_estimator_ms: 0.5, host_algorithm_ms: 2 }),
      telemetryAt(2 / 60, { host_estimator_ms: 0.25, host_algorithm_ms: 3 }),
    ];
    const summary = summarise([], { telemetry });
    expect(summary.hostProcessingTime.algorithmTotal.count).toBe(3);
    expect(summary.hostProcessingTime.algorithmTotal.mean.value).toBe(2);
    expect(summary.hostProcessingTime.estimator.count).toBe(2);
    expect(summary.hostProcessingTime.estimator.mean.value).toBe(0.375);
    expect(summary.hostProcessingTime.algorithmTotal.mean.unit).toBe('ms');
  });

  it('never enters the simulated latency figures', () => {
    const summary = summarise([], { telemetry: [telemetryAt(0, { host_algorithm_ms: 500 })] });
    expect(summary.controlLatency.captureToIssue.count).toBe(0);
    expect(summary.controlLatency.issueToApplication.mean.status).toBe('not-measured');
  });
});

describe('the summary records its own definitions', () => {
  it('carries the metrics configuration and its fingerprint', () => {
    const summary = summarise(every(0, 1));
    expect(summary.metricsConfig).toEqual(CONFIG);
    expect(summary.metricsFingerprint).toBe(fingerprint(CONFIG));
    expect(summary.metricsDefinitionVersion).toBe(CONFIG.definitionVersion);
  });

  it('gives a different result under a different, identified definition', () => {
    // Same samples; a 5 s dwell can never be met in a 1 s run.
    const strict: MetricsConfig = { ...CONFIG, lockDwellSeconds: 5 };
    const loose = summarise(every(0, 1));
    const tight = summarise(every(0, 1), {
      context: { metricsConfig: strict, metricsFingerprint: fingerprint(strict) },
    });
    expect(loose.coarseLockTime.value).toBe(0.5);
    expect(tight.coarseLockTime.value).toBeNull();
    expect(tight.metricsFingerprint).not.toBe(loose.metricsFingerprint);
  });
});
