/**
 * The experiment record: what is stored, and what it promises.
 *
 * An experiment artifact has to survive being read by someone who was not
 * there. That means every number carries a unit, every configuration that
 * affected the result is snapshotted rather than referenced, and every
 * quantity that could not be measured says so rather than defaulting to zero.
 *
 * Three files carry the raw record — events, safe telemetry, privileged
 * evaluation — and the summary is **derived** from them. It is never the
 * source of truth: the recorder computes it by reading those files back, and
 * `recomputeSummary` does the same from a cold start, so a reader does not have
 * to trust a live accumulator they cannot inspect (ADR-0015).
 *
 * One rule shapes the raw columns: **no metric threshold is baked into a raw
 * file.** The evaluation file records physical facts — the pointing error, the
 * range, whether the bearing is inside the mount's travel — and the lock
 * threshold, the dwell, the association radius and the trackable range are
 * applied when the summary is computed. A run can therefore be rescored under a
 * different, explicitly identified metrics definition without rerunning it and
 * without rewriting what was recorded.
 *
 * See docs/EXPERIMENTS.md and docs/METRICS.md.
 */

import { z } from 'zod';

import { measurementSchema } from '@/core/contracts/measurement';

/**
 * Version of the stored artifact format.
 *
 * - **1** — Phase 5.
 * - **2** — Phase 6: telemetry gains nullable columns for estimator and
 *   recovery diagnostics, and the summary gains optional handoff, recovery and
 *   estimator sections.
 *
 * Every version listed in {@link SUPPORTED_SCHEMA_VERSIONS} still loads,
 * recomputes and verifies. A run is always read under the version it declares.
 */
export const EXPERIMENT_SCHEMA_VERSION = 2;
export const SUPPORTED_SCHEMA_VERSIONS = [1, 2] as const;
const schemaVersionSchema = z.union([z.literal(1), z.literal(2)]);
export type ExperimentSchemaVersion = z.infer<typeof schemaVersionSchema>;

/**
 * Version of the *metric definitions*, separate from the file format.
 *
 * Changing what "lock retention" means must not silently rewrite history: a
 * stored summary records the definition version it was computed under, and a
 * recomputation under a different version is a new result rather than a
 * correction of the old one.
 */
export const METRICS_DEFINITION_VERSION = 3;

/**
 * The PAT modes that count as the algorithm claiming a measured track, per
 * metrics-definition version.
 *
 * - **v1** (Phase 5): `track` only — the only such state the baseline has.
 * - **v2** (Phase 6): `track` and `handoff`. Handoff-ready is tracking with
 *   stricter conditions met, so time spent there must not count against the
 *   tracker. `reacquire` (RECOVER) is **not** included: it is the algorithm
 *   stating that it has lost measurement support, even while it keeps pointing
 *   at its prediction.
 *
 * For the baseline, which never reports `handoff`, the two versions give
 * identical results.
 */
export const TRACKING_MODES: Readonly<Record<number, readonly string[]>> = {
  1: ['track'],
  2: ['track', 'handoff'],
};

// --- Lifecycle --------------------------------------------------------------

/**
 * Where a run got to.
 *
 * `running` on disk means the application stopped without finalising — a
 * crash, a close, a kill. The Reports view shows such a run as INCOMPLETE: it
 * is recoverable for inspection but is never a valid result.
 */
export const experimentStatusSchema = z.enum([
  'created',
  'running',
  'completed',
  'aborted',
  'failed',
]);
export type ExperimentStatus = z.infer<typeof experimentStatusSchema>;

/** Why a run stopped. */
export const terminationReasonSchema = z.enum([
  'operator-finalised',
  'operator-aborted',
  'scenario-duration-reached',
  'autonomy-disabled',
  'simulation-reset',
  'scenario-changed',
  'algorithm-changed',
  'runtime-error',
  'writer-error',
]);
export type TerminationReason = z.infer<typeof terminationReasonSchema>;

// --- Metric definitions -----------------------------------------------------

const metricsThresholdFields = {
  /** Angular pointing error at or below which the evaluator calls it locked. */
  lockErrorThresholdRad: z.number().positive(),
  /** How long the lock condition must hold continuously before lock is confirmed. */
  lockDwellSeconds: z.number().nonnegative(),
  /**
   * Once locked, how long the condition may lapse before it counts as a loss.
   *
   * Without this a single marginal frame would register as a loss-and-reacquire
   * pair and the episode statistics would be dominated by nothing.
   */
  lockDropoutGraceSeconds: z.number().nonnegative(),
  /** Maximum range at which the target is considered trackable at all. */
  maxTrackableRangeM: z.number().positive(),
  /**
   * How close a detection must be to the designated emitter's true projected
   * centre to count as a detection *of that emitter*.
   */
  detectionAssociationRadiusPx: z.number().positive(),
};

/** Metrics definition v1 (Phase 5). Still accepted for every run recorded under it. */
export const metricsConfigV1Schema = z.strictObject({
  definitionVersion: z.literal(1),
  ...metricsThresholdFields,
});

/** Metrics definition v2 (Phase 6): v1 plus handoff validity, and HANDOFF counts as tracking. */
export const metricsConfigV2Schema = z.strictObject({
  definitionVersion: z.literal(2),
  ...metricsThresholdFields,
  /**
   * True angular pointing error at or below which a handoff-ready claim is
   * judged physically valid by the evaluator.
   */
  handoffValidityThresholdRad: z.number().positive(),
});

/**
 * Metrics definition v3 (Phase 7): v2 plus the image-SNR aperture.
 *
 * The aperture has to be part of the *definition* rather than a constant in the
 * evaluator, because an SNR measured over a different box is a different number
 * and two reports quoting "SNR" over different apertures are not comparable.
 */
export const metricsConfigV3Schema = z.strictObject({
  definitionVersion: z.literal(3),
  ...metricsThresholdFields,
  handoffValidityThresholdRad: z.number().positive(),
  /**
   * Half-width, in pixels, of the square box around the designated target's
   * true projected centre over which image SNR is summed.
   */
  snrApertureRadiusPx: z.number().positive(),
});

/** The thresholds a run is scored against. Recorded so a score is reproducible. */
export const metricsConfigSchema = z.discriminatedUnion('definitionVersion', [
  metricsConfigV1Schema,
  metricsConfigV2Schema,
  metricsConfigV3Schema,
]);
export type MetricsConfig = z.infer<typeof metricsConfigSchema>;

export const DEFAULT_METRICS_CONFIG: MetricsConfig = metricsConfigSchema.parse({
  definitionVersion: METRICS_DEFINITION_VERSION,
  // Four times the widest bundled beacon spread, so the box contains
  // essentially all of the target's light and a ring of background around it.
  snrApertureRadiusPx: 12,
  // One milliradian: half the coarse-lock threshold. A handoff-ready claim is a
  // claim of better-than-coarse alignment, so it is held to a tighter bar.
  handoffValidityThresholdRad: 1e-3,
  // Two milliradians. The bundled cameras have a 12-degree field, so this is
  // about 1% of the field: comfortably inside, and far tighter than "somewhere
  // in frame", but loose enough that the mount's own deadband and backlash do
  // not break the lock on their own.
  lockErrorThresholdRad: 2e-3,
  lockDwellSeconds: 0.5,
  lockDropoutGraceSeconds: 0.25,
  maxTrackableRangeM: 50_000,
  // Two PSF widths for the bundled beacons (sigma 2.0-2.4 px). A noiseless
  // centroid lands well under a pixel from the true centre, so a real detection
  // of the target is always inside this; anything outside it is not the
  // target's spot.
  detectionAssociationRadiusPx: 5,
});

// --- Manifest ---------------------------------------------------------------

/**
 * Wall-clock and host provenance.
 *
 * Kept in its own object precisely so it can be excluded from engineering
 * comparisons. None of it enters a fingerprint: two runs of the same experiment
 * on different days on different machines are the same experiment.
 */
export const hostMetadataSchema = z.strictObject({
  /** When the recording was created. Set once and never rewritten. */
  createdAt: z.string(),
  /** When it was finalised, aborted or failed; `null` while running. */
  endedAt: z.string().nullable(),
  platform: z.string(),
  applicationVersion: z.string(),
  /**
   * Commit the build came from, or `null`.
   *
   * `null` when the build has no git information — a tarball, a machine without
   * git. Reported honestly rather than filled in with "main" or "latest", which
   * would be a claim about provenance that nobody checked.
   */
  sourceCommit: z.string().nullable(),
  /**
   * Whether the build's working tree had uncommitted changes relative to
   * `sourceCommit`, or `null` when that cannot be told. A modified tree is not
   * the commit it names.
   */
  sourceTreeModified: z.boolean().nullable(),
  /**
   * The smallest step the host's monotonic timer was observed to take, in
   * milliseconds, or `null` if it could not be measured.
   *
   * Host processing times are only as fine as this. Some runtimes coarsen
   * `performance.now()` — WKWebView reports whole milliseconds — so a stage
   * shorter than the resolution reads as 0 on an individual frame. Means over
   * many frames remain informative; per-frame values and percentiles are
   * quantised to it.
   */
  timerResolutionMs: z.number().positive().nullable(),
});
export type HostMetadata = z.infer<typeof hostMetadataSchema>;

/**
 * What each file in a run directory is.
 *
 * Written into the manifest so the classification travels with the data: a
 * reader who opens the folder without the application can still tell which
 * file is safe telemetry and which carries ground truth.
 */
export const artifactClassificationSchema = z.enum([
  'provenance',
  'configuration',
  'event-log',
  'safe-telemetry',
  'privileged-evaluation',
  'derived-summary',
  'derived-report',
]);
export type ArtifactClassification = z.infer<typeof artifactClassificationSchema>;

/** Everything needed to know what was run, and to run it again. */
export const experimentManifestSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  metricsDefinitionVersion: z.number().int().positive(),

  /** Identity of this *recording*. Not deterministic; see the fingerprints. */
  runId: z.string().min(1),
  status: experimentStatusSchema,
  terminationReason: terminationReasonSchema.nullable(),

  scenarioId: z.string().nullable(),
  scenarioName: z.string(),
  scenarioSeed: z.number(),
  algorithmId: z.string().min(1),
  algorithmVersion: z.string().min(1),

  /**
   * Identity of the *experiment*, as opposed to the recording.
   *
   * SHA-256 over canonical JSON (keys sorted at every depth). Two runs sharing
   * all three are the same physical experiment with the same tracker under the
   * same metric definitions, whatever their run ids say. `recomputeSummary`
   * checks the first two against scenario.json and algorithm.json, so a
   * snapshot edited after the fact is caught.
   */
  scenarioFingerprint: z.string().min(1),
  algorithmFingerprint: z.string().min(1),
  metricsFingerprint: z.string().min(1),

  /** The metric definitions the run was scored under. */
  metricsConfig: metricsConfigSchema,

  /** The target the run is scored against, by index into scenario.json. */
  designatedTargetIndex: z.number().int().nonnegative(),
  designatedTargetLabel: z.string(),
  targetCount: z.number().int().nonnegative(),

  /** Simulation parameters repeated here so the manifest reads alone. */
  simulationTimestepSeconds: z.number().positive(),
  tickRate: z.number().positive(),
  camera: z.strictObject({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    frameRate: z.number().positive(),
    horizontalFovRad: z.number().positive(),
    principalPointXPx: z.number(),
    principalPointYPx: z.number(),
  }),
  gimbal: z.strictObject({
    commandLatencySeconds: z.number().nonnegative(),
    panMinRad: z.number(),
    panMaxRad: z.number(),
    tiltMinRad: z.number(),
    tiltMaxRad: z.number(),
    panMaxRateRadS: z.number().positive(),
    tiltMaxRateRadS: z.number().positive(),
  }),

  startSimulationTime: z.number(),
  endSimulationTime: z.number().nullable(),
  /**
   * The simulation engine's state hash at the end instant, or `null` until the
   * run ends.
   *
   * A deterministic fingerprint of the physical end state, so a rerun from
   * scenario.json and algorithm.json can be checked against the recording
   * itself rather than against someone's memory of it.
   */
  endStateHash: z.string().nullable(),

  /**
   * Frames the sensor produced for the closed loop with capture time in the
   * half-open window [startSimulationTime, endSimulationTime).
   *
   * A raw counter, not a derived value: it is counted as frames are generated
   * and written here at the end, because a frame that was generated and then
   * failed to process leaves no telemetry row to count. `null` until the run
   * ends.
   */
  sensorFramesGenerated: z.number().int().nonnegative().nullable(),

  artifacts: z.record(z.string(), artifactClassificationSchema),

  host: hostMetadataSchema,
});
export type ExperimentManifest = z.infer<typeof experimentManifestSchema>;

// --- Events -----------------------------------------------------------------

/**
 * Event kinds.
 *
 * Events mark *changes*, not samples. A per-frame record belongs in telemetry;
 * putting it here would drown the log in noise and make "what happened in this
 * run" unanswerable. The exceptions are `command-issued` and `command-applied`,
 * which are genuinely one event per command and are what the simulated
 * control-latency figures are computed from.
 *
 * `lock-lost` is the **algorithm's** declaration that it lost its track (TRACK
 * to LOST). The evaluator's own view of lock is not an event: it is derived
 * from evaluation.csv when the summary is computed, so it can be recomputed
 * under a different metrics definition.
 */
export const experimentEventTypeSchema = z.enum([
  'experiment-started',
  'simulation-started',
  'simulation-paused',
  'autonomy-enabled',
  'operator-override',
  'search-started',
  'candidate-detected',
  'acquire-entered',
  'track-entered',
  'recover-entered',
  'reacquired',
  'handoff-ready',
  'handoff-lost',
  'detection-missed',
  /**
   * One run of frames the sensor failed to deliver (v3).
   *
   * Recorded once per burst with its first frame and its length, not once per
   * frame: Phase 5's event log is change-only, and a 22 % drop rate would
   * otherwise add a thousand events to a ninety-second run.
   */
  'frames-dropped',
  'lock-lost',
  'lost-entered',
  'search-reentered',
  'command-issued',
  'command-applied',
  'mechanical-limit',
  'autonomy-disabled',
  'simulation-completed',
  'experiment-completed',
  'experiment-aborted',
  'experiment-failed',
]);
export type ExperimentEventType = z.infer<typeof experimentEventTypeSchema>;

/** A flat, scalar payload. */
export const eventDetailSchema = z.record(
  z.string(),
  z.union([z.number(), z.string(), z.boolean(), z.null()]),
);
export type EventDetail = z.infer<typeof eventDetailSchema>;

/**
 * One entry in the append-only log.
 *
 * `sequence` is the final tie-break. Several engineering events legitimately
 * share a simulation timestamp — a frame that produces a detection, a state
 * change and a command all happen at one instant — and a log whose order
 * depended on sort stability would not be reproducible. The log is written in
 * sequence order, and simulation time is non-decreasing along it.
 */
export const experimentEventSchema = z.strictObject({
  sequence: z.number().int().nonnegative(),
  /** The engineering instant the event describes, in simulated seconds. */
  simulationTime: z.number(),
  /** The engine tick at which the recorder learned of it. */
  tick: z.number().int().nonnegative(),
  type: experimentEventTypeSchema,
  /**
   * Typed detail, flat and scalar.
   *
   * Deliberately not a place to put an object graph: a privileged world object
   * serialised into an event payload would put ground truth into the log by
   * accident.
   */
  detail: eventDetailSchema,
});
export type ExperimentEvent = z.infer<typeof experimentEventSchema>;

// --- Telemetry (safe) -------------------------------------------------------

/**
 * One safe telemetry row per processed frame: exactly what the operator's
 * console could show.
 *
 * Everything here is derivable from pixels, the believed calibration, the
 * measured mount state, the algorithm's own memory and the host clock. Nothing
 * requires privileged access, so the file can be handed to anyone.
 *
 * Column names carry units. The `host_*_ms` columns are wall-clock diagnostics
 * of the machine that ran the experiment, not simulated quantities; an empty
 * stage cell means that stage did not run on that frame.
 */
export const telemetrySampleSchema = z.strictObject({
  frame_id: z.number().int(),
  frame_capture_time_s: z.number(),
  command_issue_time_s: z.number(),
  tick: z.number().int(),
  pat_state: z.string(),
  candidate_count: z.number().int(),
  components_found: z.number().int(),
  centroid_x_px: z.number().nullable(),
  centroid_y_px: z.number().nullable(),
  candidate_score: z.number().nullable(),
  filtered_azimuth_rad: z.number().nullable(),
  filtered_elevation_rad: z.number().nullable(),
  filtered_azimuth_rate_rad_s: z.number().nullable(),
  filtered_elevation_rate_rad_s: z.number().nullable(),
  pid_pan_correction_rad: z.number().nullable(),
  pid_tilt_correction_rad: z.number().nullable(),
  command_id: z.number().int().nullable(),
  commanded_pan_rad: z.number().nullable(),
  commanded_tilt_rad: z.number().nullable(),
  measured_pan_rad: z.number(),
  measured_tilt_rad: z.number(),
  measured_pan_rate_rad_s: z.number(),
  measured_tilt_rate_rad_s: z.number(),
  pan_saturation: z.string(),
  tilt_saturation: z.string(),
  consecutive_misses: z.number().int(),
  search_waypoint_index: z.number().int().nullable(),
  host_world_step_ms: z.number(),
  host_sensor_frame_ms: z.number(),
  host_algorithm_ms: z.number(),
  host_detector_ms: z.number().nullable(),
  host_bearing_transform_ms: z.number().nullable(),
  host_estimator_ms: z.number().nullable(),
  host_controller_ms: z.number().nullable(),
  host_orchestration_ms: z.number(),
  // --- Schema v3: beacon identity. Empty for an algorithm without a
  // correlator, and for every v1 and v2 file.
  //
  // Everything here is the algorithm's verdict on its own evidence. There is no
  // column naming a source, because the tracker cannot name one.
  /** Identity correlation and phase search. Empty for an algorithm without one. */
  host_identity_ms: z.number().nullable(),
  /** The tracker's own verdict: match, mismatch, unconfirmed, ambiguous, insufficient. */
  identity_state: z.string(),
  /** Best normalised correlation, on [-1, 1]. Not a probability. */
  code_correlation: z.number().nullable(),
  /** Recovered code phase, seconds into the code period. */
  code_phase_s: z.number().nullable(),
  identity_samples: z.number().nullable(),
  identity_span_s: z.number().nullable(),
  identity_candidates: z.number().nullable(),
  identity_rejected: z.number().nullable(),
  // --- Schema v2: estimator, association, control and recovery diagnostics.
  // Empty for an algorithm that does not report them, and for every v1 file.
  track_quality: z.number().nullable(),
  acquisition_evidence: z.number().nullable(),
  innovation_nis: z.number().nullable(),
  gate_accepted: z.number().nullable(),
  imm_cv_probability: z.number().nullable(),
  imm_ca_probability: z.number().nullable(),
  filtered_azimuth_accel_rad_s2: z.number().nullable(),
  filtered_elevation_accel_rad_s2: z.number().nullable(),
  angular_sigma_rad: z.number().nullable(),
  prediction_horizon_s: z.number().nullable(),
  predicted_azimuth_rad: z.number().nullable(),
  predicted_elevation_rad: z.number().nullable(),
  feedforward_pan_rad: z.number().nullable(),
  feedforward_tilt_rad: z.number().nullable(),
  recovery_age_s: z.number().nullable(),
  local_search_radius_rad: z.number().nullable(),
  handoff_dwell_s: z.number().nullable(),
});
export type TelemetrySample = z.infer<typeof telemetrySampleSchema>;

/**
 * Telemetry columns added in schema v3 (Phase 8); absent from v1 and v2 files.
 *
 * A run recorded before beacon identity existed has none of these, and its file
 * is read with the shorter header and the columns filled as empty — which is the
 * correct reading, since those runs had no correlator rather than a correlator
 * that reported nothing.
 */
export const TELEMETRY_V3_COLUMNS = [
  'host_identity_ms',
  'identity_state',
  'code_correlation',
  'code_phase_s',
  'identity_samples',
  'identity_span_s',
  'identity_candidates',
  'identity_rejected',
] as const;

/**
 * Evaluation columns added in schema v3; absent from v1 and v2 files.
 *
 * A Phase 5 or Phase 6 run has no disturbance realization to record, so its
 * evaluation file simply lacks these columns. The reader accepts the shorter
 * header and fills them as null — which is the correct reading, since those runs
 * had no disturbances rather than disturbances measured at zero.
 */
export const EVALUATION_V3_COLUMNS = [
  'truth_base_azimuth_rad',
  'truth_base_elevation_rad',
  'truth_wander_azimuth_rad',
  'truth_wander_elevation_rad',
  'truth_scintillation_gain',
  'truth_image_snr_db',
  'truth_saturated_fraction',
] as const;

/** Telemetry columns added in schema v2; absent from v1 files and read as empty. */
export const TELEMETRY_V2_COLUMNS = [
  'track_quality',
  'acquisition_evidence',
  'innovation_nis',
  'gate_accepted',
  'imm_cv_probability',
  'imm_ca_probability',
  'filtered_azimuth_accel_rad_s2',
  'filtered_elevation_accel_rad_s2',
  'angular_sigma_rad',
  'prediction_horizon_s',
  'predicted_azimuth_rad',
  'predicted_elevation_rad',
  'feedforward_pan_rad',
  'feedforward_tilt_rad',
  'recovery_age_s',
  'local_search_radius_rad',
  'handoff_dwell_s',
] as const;

// --- Evaluation (privileged) ------------------------------------------------

/**
 * One privileged evaluation row per processed frame, at the frame's capture
 * instant.
 *
 * **Ground truth.** Every column derived from the simulator's truth is prefixed
 * `truth_`, so the file declares itself in any tool that opens it. It is never
 * routed back into the algorithm, and it records derived truth quantities —
 * line of sight, optical axis, pointing error, visibility — rather than the
 * world state, because those are what the metrics need and nothing more should
 * leave the simulator.
 *
 * No metric threshold appears here; see the module comment.
 */
export const evaluationSampleSchema = z.strictObject({
  frame_id: z.number().int(),
  capture_time_s: z.number(),
  /** Algorithm state, copied from telemetry so this file reads alone. Safe. */
  pat_state: z.string(),
  /** Whether the algorithm selected a candidate on this frame. Safe. */
  detection_present: z.boolean(),
  /** True optical axis of the camera, world ENU unit vector. */
  truth_optical_axis_east: z.number(),
  truth_optical_axis_north: z.number(),
  truth_optical_axis_up: z.number(),
  /** True line of sight to the designated target, world ENU unit vector. */
  truth_target_los_east: z.number().nullable(),
  truth_target_los_north: z.number().nullable(),
  truth_target_los_up: z.number().nullable(),
  /** Angle between the two above. The angular pointing error. */
  truth_angular_pointing_error_rad: z.number().nullable(),
  truth_target_range_m: z.number().nullable(),
  /** Whether the bearing to the target lies inside both axes' travel. */
  truth_target_within_travel: z.boolean(),
  /** Whether the designated target projects inside the image. */
  truth_target_in_image: z.boolean(),
  truth_image_x_px: z.number().nullable(),
  truth_image_y_px: z.number().nullable(),
  /** Distance from the true projected centre to the principal point. */
  truth_image_pointing_error_px: z.number().nullable(),
  /** Distance from the detector's centroid to the true projected centre. */
  truth_detector_centroid_error_px: z.number().nullable(),
  /** A detection exists and its nearest projected emitter is not the designated one. */
  truth_detection_on_other_emitter: z.boolean(),
  /** Non-designated emitters projecting inside the image at this instant. */
  truth_other_emitters_in_image: z.number().int().nonnegative(),

  // --- Disturbance realization (v3). Null on a run with no disturbances. ---
  /** True base attitude added to the mount's own pointing, radians. */
  truth_base_azimuth_rad: z.number().nullable(),
  truth_base_elevation_rad: z.number().nullable(),
  /** True apparent angular displacement of the received beacon, radians. */
  truth_wander_azimuth_rad: z.number().nullable(),
  truth_wander_elevation_rad: z.number().nullable(),
  /** True scintillation multiplier applied to every emitter this frame. */
  truth_scintillation_gain: z.number().nullable(),
  /**
   * Image signal-to-noise ratio in decibels over the metrics aperture.
   *
   * Null when the run has no stochastic noise, in which case the noise image is
   * identically zero and the ratio is undefined. Never a fabricated 0 dB.
   */
  truth_image_snr_db: z.number().nullable(),
  /** Fraction of pixels at the top of the range in this frame. */
  truth_saturated_fraction: z.number().nullable(),
});
export type EvaluationSample = z.infer<typeof evaluationSampleSchema>;

// --- Summary ----------------------------------------------------------------

/** A measurement that was never taken. The value a stage with no samples reports. */
const absentStatistic = { value: null, status: 'not-measured', unit: 'ms' } as const;

const statisticsSchema = z.strictObject({
  count: z.number().int().nonnegative(),
  mean: measurementSchema,
  rms: measurementSchema,
  median: measurementSchema,
  p95: measurementSchema,
  max: measurementSchema,
});
export type SummaryStatistics = z.infer<typeof statisticsSchema>;

/** The three sample windows every error statistic is reported over. */
const windowedSchema = z.strictObject({
  /** Every sample where the quantity is defined. */
  wholeRun: statisticsSchema,
  /** Samples at or after the first confirmed coarse lock. */
  postAcquisition: statisticsSchema,
  /** Samples where the algorithm was in TRACK. */
  trackState: statisticsSchema,
});
export type WindowedStatistics = z.infer<typeof windowedSchema>;

const episodeSchema = z.strictObject({
  lost_at_s: z.number(),
  recovered_at_s: z.number().nullable(),
  duration_s: z.number().nullable(),
  /** True when the run ended before this loss was ever recovered: censored. */
  unrecovered: z.boolean(),
});
export type LossEpisode = z.infer<typeof episodeSchema>;

/** A milestone, or why it was never reached. */
export const acquisitionOutcomeSchema = z.enum([
  'acquired',
  'no-acquisition',
  'no-search-recorded',
  'no-samples',
]);
export type AcquisitionOutcome = z.infer<typeof acquisitionOutcomeSchema>;

/** Why the retention rate has the value, or absence, it has. */
export const retentionStatusSchema = z.enum([
  'computed',
  'no-acquisition',
  'no-trackable-opportunity',
]);
export type RetentionStatus = z.infer<typeof retentionStatusSchema>;

/**
 * The derived result of a run.
 *
 * Every field is recomputable from the raw artifacts — events.jsonl,
 * telemetry.csv, evaluation.csv and the manifest — and `recomputeSummary` does
 * exactly that. Nothing here is typed in by anyone.
 */
/** Handoff-readiness results (metrics definition v2). */
const handoffSummarySchema = z.strictObject({
  firstHandoffReadyTime: measurementSchema,
  /** First handoff-ready instant minus search start. */
  timeToHandoffReady: measurementSchema,
  episodes: z.number().int().nonnegative(),
  durationSeconds: measurementSchema,
  /** Handoff-ready time during which true pointing error met the validity threshold. */
  validDurationSeconds: measurementSchema,
  validityRate: measurementSchema,
});

/** The algorithm's own recovery attempts, from its RECOVER transitions (v2). */
const algorithmRecoverySummarySchema = z.strictObject({
  entries: z.number().int().nonnegative(),
  reacquired: z.number().int().nonnegative(),
  fellBackToSearch: z.number().int().nonnegative(),
  /** Still in RECOVER when the run ended. Censored, not dropped. */
  unresolved: z.number().int().nonnegative(),
  /** RECOVER entry to reacquisition, over successful recoveries only. */
  recoveryTime: statisticsSchema,
});

/** What an interacting-multiple-model estimator reported, if the algorithm has one (v2). */
const estimatorSummarySchema = z.strictObject({
  framesWithModelProbabilities: z.number().int().nonnegative(),
  /** Constant-acceleration model probability over frames in a tracking mode. */
  caProbabilityWhileTracking: statisticsSchema,
});

/**
 * What the disturbances actually did during a run (v3).
 *
 * Measured from the recorded realization, not read back from the configuration:
 * a scenario asking for 50 µrad of wander and a run that delivered 50 µrad of
 * wander are different claims, and only the second is evidence.
 *
 * `null` for a run with no disturbances, rather than a block of zeroes — a table
 * of zeroes reads as "measured and found to be nothing" when the truth is "no
 * such thing was modelled".
 */
const disturbanceSummarySchema = z.strictObject({
  /** The preset a scenario was populated from, for provenance only. */
  preset: z.string().nullable(),
  /** Which effects were active. The parameters live in the scenario snapshot. */
  active: z.array(z.string()),

  /** Measured RMS of the true base attitude, per axis. */
  platformJitterRmsAzimuth: measurementSchema,
  platformJitterRmsElevation: measurementSchema,
  /** Measured RMS of the true apparent angular displacement, per component. */
  apparentWanderRmsAzimuth: measurementSchema,
  apparentWanderRmsElevation: measurementSchema,
  /** The scintillation multiplier actually delivered. Mean should be near one. */
  scintillationGain: statisticsSchema,

  /** Frames the sensor was scheduled to produce and failed to deliver. */
  framesDropped: z.number().int().nonnegative(),
  /** Dropped as a fraction of scheduled, over the autonomous window. */
  frameDropRate: measurementSchema,
  /** Longest run of consecutive dropped frames. */
  longestDropBurstFrames: z.number().int().nonnegative(),

  /**
   * Image signal-to-noise ratio in decibels, over the aperture the metrics
   * definition names.
   *
   * `not-applicable` when the run has no stochastic noise: the noise image is
   * identically zero and the ratio is undefined. Reported as such rather than
   * as infinity, and never as a fabricated 0 dB.
   */
  imageSnrDb: statisticsSchema,
  /** Fraction of pixels at the top of the range, averaged over sampled frames. */
  saturatedPixelFraction: measurementSchema,
});

export const experimentSummarySchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  metricsDefinitionVersion: z.number().int().positive(),
  metricsFingerprint: z.string().min(1),
  runId: z.string().min(1),
  metricsConfig: metricsConfigSchema,
  terminationReason: terminationReasonSchema.nullable(),

  // --- Duration and frame rates ---
  simulationDurationSeconds: measurementSchema,
  /** From autonomy engaging to the end of the run: the window frame rates use. */
  autonomousDurationSeconds: measurementSchema,
  configuredSensorFps: measurementSchema,
  effectiveSensorFps: measurementSchema,
  algorithmProcessedFps: measurementSchema,
  sensorFramesGenerated: z.number().int().nonnegative(),
  algorithmFramesProcessed: z.number().int().nonnegative(),

  // --- Acquisition milestones ---
  acquisitionOutcome: acquisitionOutcomeSchema,
  searchStartTime: measurementSchema,
  firstDetectionTime: measurementSchema,
  trackEntryTime: measurementSchema,
  coarseLockTime: measurementSchema,
  timeToFirstDetection: measurementSchema,
  timeToTrack: measurementSchema,
  /** coarseLockTime - searchStartTime. The headline acquisition figure. */
  coarseAcquisitionTime: measurementSchema,

  // --- Pointing and detector accuracy ---
  angularPointingError: windowedSchema,
  imagePointingError: windowedSchema,
  /** A detector diagnostic, never a substitute for pointing error. */
  detectorCentroidError: statisticsSchema,
  /** Frames where the target was in the image and no candidate was selected. */
  detectorMissesWithTargetInImage: z.number().int().nonnegative(),

  // --- Lock ---
  lockRetentionRate: measurementSchema,
  lockRetentionStatus: retentionStatusSchema,
  lockedDurationSeconds: measurementSchema,
  trackableOpportunitySeconds: measurementSchema,
  lossOfLockEpisodes: z.number().int().nonnegative(),
  unrecoveredLosses: z.number().int().nonnegative(),
  reacquisitionCount: z.number().int().nonnegative(),
  /** Over recovered episodes only; unrecovered ones are counted above, not dropped. */
  reacquisitionTime: statisticsSchema,
  episodes: z.array(episodeSchema),
  /** Time in TRACK while the evaluator's lock condition did not hold. */
  trackClaimedWithoutLockSeconds: measurementSchema,

  // --- False lock on a wrong source ---
  falseLockExercised: z.boolean(),
  falseLockEpisodes: z.number().int().nonnegative(),
  falseLockDurationSeconds: measurementSchema,
  falseLockRate: measurementSchema,

  /**
   * How the algorithm's own identity verdicts compare with the truth.
   *
   * `null` for a run in which no identity verdict was ever reported — the
   * baseline, and AstraLock-X with identity switched off. A block of zeroes
   * would claim the question was asked and answered negatively, which is a
   * different statement from "the question was never asked".
   *
   * **Scored here and nowhere else.** The tracker states an opinion about its
   * evidence; only the evaluator knows which emitter a detection actually sat
   * on, so only the evaluator can say whether an opinion was right. Nothing in
   * this block is visible to the algorithm.
   */
  beaconIdentity: z
    .strictObject({
      /** Whether any identity verdict was reported at all. Always true here. */
      identityEnabled: z.boolean(),
      /**
       * Frames on which the tracker was tracking and at least one
       * non-designated emitter was also in the image: the chances it had to be
       * fooled. Counted whether or not identity is enabled, so the two arms of
       * an ablation are compared over the same exposure.
       */
      identityChallenges: z.number().int().nonnegative(),
      /** Frames where the tracker claimed MATCH and was on the designated target. */
      correctCodeAssociations: z.number().int().nonnegative(),
      /**
       * Frames where the tracker claimed MATCH and was on some other emitter.
       *
       * The number that matters most: a confident identity claim that was
       * wrong. Anything above zero is a recognition failure, not a near miss.
       */
      wrongCodeAssociations: z.number().int().nonnegative(),
      /** Runs of consecutive frames reported AMBIGUOUS. */
      ambiguousIdentityEpisodes: z.number().int().nonnegative(),
      /** Runs of consecutive frames reported INSUFFICIENT-EVIDENCE. */
      insufficientEvidenceEpisodes: z.number().int().nonnegative(),
      /** Frames reported MATCH, MISMATCH, and everything else, for context. */
      matchFrames: z.number().int().nonnegative(),
      mismatchFrames: z.number().int().nonnegative(),
      /** Correlation over frames the tracker called a match. */
      matchCorrelation: statisticsSchema,
    })
    .nullable()
    // Absent, not merely null, in every summary stored before identity existed.
    // Those runs asked no identity question and their files must keep loading.
    .default(null),

  // --- Host processing time (wall clock, diagnostics) ---
  /**
   * Coarse-to-fine handoff, or `null` for an algorithm that has no such state.
   *
   * Nullable rather than a block of N/A rows: the baseline cannot reach handoff
   * readiness at all, and a report that showed it an empty handoff table would
   * be describing a capability it does not have. Only produced under metrics
   * definition v2 and later, which is where the concept was introduced.
   */
  hostProcessingTime: z.strictObject({
    worldStep: statisticsSchema,
    sensorFrameGeneration: statisticsSchema,
    detector: statisticsSchema,
    bearingTransform: statisticsSchema,
    estimator: statisticsSchema,
    controller: statisticsSchema,
    /**
     * Identity correlation and phase search.
     *
     * Defaulted rather than required, because a summary stored before the
     * stage existed has no such key and those files must keep loading. The
     * default is an empty statistic — no samples, no values — which is exactly
     * what a run that never ran the stage produces today.
     */
    identity: statisticsSchema.default(() => ({
      count: 0,
      mean: absentStatistic,
      rms: absentStatistic,
      median: absentStatistic,
      p95: absentStatistic,
      max: absentStatistic,
    })),
    algorithmTotal: statisticsSchema,
    runtimeOrchestration: statisticsSchema,
  }),

  // --- Simulated control latency ---
  commandsIssued: z.number().int().nonnegative(),
  commandsApplied: z.number().int().nonnegative(),
  /** Issued during the run but not yet applied when it ended. Censored, not dropped. */
  commandsPendingAtEnd: z.number().int().nonnegative(),
  controlLatency: z.strictObject({
    captureToIssue: statisticsSchema,
    issueToApplication: statisticsSchema,
    captureToApplication: statisticsSchema,
    scheduledToActualApplication: statisticsSchema,
  }),

  // --- Metrics definition v2 only. Absent from every v1 summary.
  /** The PAT modes this summary treated as the algorithm claiming a track. */
  trackingModes: z.array(z.string()).optional(),
  handoff: handoffSummarySchema.optional(),
  algorithmRecovery: algorithmRecoverySummarySchema.optional(),
  estimator: estimatorSummarySchema.optional(),
  /** What the disturbances did, or `null`/absent on a clean run (v3). */
  disturbance: disturbanceSummarySchema.nullable().optional(),
});
export type ExperimentSummary = z.infer<typeof experimentSummarySchema>;
