/**
 * The KPI engine.
 *
 * Every number here is computed from recorded rows — events, telemetry and
 * evaluation samples — and nothing else. It takes no engine, no sensor and no
 * mount. That is the point: the recorder computes the stored summary by
 * streaming its own files back through this builder, and `recomputeSummary`
 * does the same from a cold start, so a published figure can be rebuilt by
 * anyone holding the files (ADR-0015).
 *
 * It is a **streaming** builder. Rows go in one at a time, in file order; the
 * builder keeps the scalar state the definitions need plus, for percentiles,
 * the values of each statistic in a compact typed array. It never holds a row
 * object after processing it.
 *
 * Definitions, denominators and units: docs/METRICS.md. The unit tests feed
 * this synthetic sequences whose answers were worked out by hand.
 */

import type { Measurement } from '@/core/contracts/measurement';
import { configured, derived, notApplicable, notMeasured } from '@/core/contracts/measurement';

import type {
  AcquisitionOutcome,
  EvaluationSample,
  ExperimentEvent,
  ExperimentSummary,
  LossEpisode,
  MetricsConfig,
  RetentionStatus,
  SummaryStatistics,
  TelemetrySample,
  TerminationReason,
  WindowedStatistics,
} from './schema';
import { TRACKING_MODES } from './schema';
import type { ExperimentSchemaVersion } from './schema';

/**
 * The PAT modes a metrics definition treats as the algorithm claiming a track.
 *
 * **Throws for a version the table does not cover.** It used to fall back to
 * `['track']`, and that fallback cost three phases of understated retention:
 * Phase 7 bumped the definition version to carry an SNR aperture, the table was
 * not extended, and handoff-ready time silently stopped counting as tracking
 * for every run scored under v3. Nothing failed, because a fallback to a valid
 * mode list produces valid-looking numbers.
 *
 * A metrics definition nobody has written down is not a metrics definition, so
 * it is refused rather than approximated.
 */
export function trackingModesFor(config: MetricsConfig): readonly string[] {
  const modes = TRACKING_MODES[config.definitionVersion];
  if (modes === undefined) {
    throw new RangeError(
      `Metrics definition v${String(config.definitionVersion)} does not say which PAT modes ` +
        'count as tracking. Add an entry to TRACKING_MODES rather than letting it default.',
    );
  }
  return modes;
}

// --- Statistics -------------------------------------------------------------

/**
 * Linear-interpolated percentile over a pre-sorted array (Hyndman-Fan type 7).
 *
 * Interpolated rather than nearest-rank so that the 95th percentile of a small
 * sample is not forced onto an actual observation — with 20 samples, nearest
 * rank makes p95 and max the same number, which hides the tail the percentile
 * exists to describe.
 */
export function percentile(sorted: ArrayLike<number>, fraction: number): number {
  const n = sorted.length;
  if (n === 0) return Number.NaN;
  if (n === 1) return sorted[0]!;
  const position = fraction * (n - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower]!;
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower);
}

function statisticsOf(values: Float64Array, unit: string): SummaryStatistics {
  const count = values.length;
  if (count === 0) {
    // An empty window is not-measured throughout, never zero. "Mean error 0"
    // for a run that never saw the target would be plausible, precise and
    // false.
    return {
      count: 0,
      mean: notMeasured(unit),
      rms: notMeasured(unit),
      median: notMeasured(unit),
      p95: notMeasured(unit),
      max: notMeasured(unit),
    };
  }

  let sum = 0;
  let sumSquares = 0;
  for (let index = 0; index < count; index += 1) {
    const value = values[index]!;
    sum += value;
    sumSquares += value * value;
  }
  const sorted = Float64Array.from(values).sort();

  return {
    count,
    mean: derived(sum / count, unit),
    rms: derived(Math.sqrt(sumSquares / count), unit),
    median: derived(percentile(sorted, 0.5), unit),
    p95: derived(percentile(sorted, 0.95), unit),
    max: derived(sorted[count - 1]!, unit),
  };
}

/** Summary statistics over a plain array. For tests and small inputs. */
export function statistics(values: readonly number[], unit: string): SummaryStatistics {
  return statisticsOf(Float64Array.from(values), unit);
}

/**
 * A growable column of doubles.
 *
 * Percentiles need every value, so a statistic's samples are kept — as eight
 * bytes each in a typed array, not as row objects. That is the finalisation
 * memory cost, and it is stated in docs/EXPERIMENTS.md.
 */
export class SampleSeries {
  private data = new Float64Array(256);
  private size = 0;

  public push(value: number): void {
    if (this.size === this.data.length) {
      const grown = new Float64Array(this.data.length * 2);
      grown.set(this.data);
      this.data = grown;
    }
    this.data[this.size] = value;
    this.size += 1;
  }

  public get length(): number {
    return this.size;
  }

  public statistics(unit: string): SummaryStatistics {
    return statisticsOf(this.data.subarray(0, this.size), unit);
  }
}

class WindowedSeries {
  public readonly wholeRun = new SampleSeries();
  public readonly postAcquisition = new SampleSeries();
  public readonly trackState = new SampleSeries();

  public push(value: number, postAcquisition: boolean, inTrack: boolean): void {
    this.wholeRun.push(value);
    if (postAcquisition) this.postAcquisition.push(value);
    if (inTrack) this.trackState.push(value);
  }

  public statistics(unit: string): WindowedStatistics {
    return {
      wholeRun: this.wholeRun.statistics(unit),
      postAcquisition: this.postAcquisition.statistics(unit),
      trackState: this.trackState.statistics(unit),
    };
  }
}

// --- Evaluator conditions ---------------------------------------------------

/**
 * Whether the designated target was trackable at a sample.
 *
 * The bearing lies inside both axes' travel and the target is within the
 * trackable range. Deliberately **nothing** about where the camera was
 * pointing: a tracker that loses the target through bad pointing must be
 * charged for it, so "the camera was looking elsewhere" never removes time
 * from the retention denominator.
 */
export function isTrackable(sample: EvaluationSample, config: MetricsConfig): boolean {
  return (
    sample.truth_target_within_travel &&
    sample.truth_target_range_m !== null &&
    sample.truth_target_range_m <= config.maxTrackableRangeM
  );
}

/**
 * The evaluator's coarse-lock condition at one sample.
 *
 * Angular pointing error within the threshold, the target trackable, and the
 * algorithm in TRACK — all three. Algorithm state alone is not a lock: a
 * tracker can sit in TRACK while pointing at nothing. And this is an
 * evaluator-only condition; nothing the algorithm receives depends on it.
 */
export function lockConditionMet(sample: EvaluationSample, config: MetricsConfig): boolean {
  const error = sample.truth_angular_pointing_error_rad;
  return (
    error !== null &&
    error <= config.lockErrorThresholdRad &&
    isTrackable(sample, config) &&
    trackingModesFor(config).includes(sample.pat_state)
  );
}

/**
 * Whether a sample carries a detection *of the designated target*.
 *
 * A candidate exists, the target is in the image, the candidate is within the
 * association radius of its true projected centre, and no other emitter is
 * nearer. Known only to the evaluator; the algorithm cannot tell.
 */
export function detectionOfTarget(sample: EvaluationSample, config: MetricsConfig): boolean {
  return (
    sample.detection_present &&
    sample.truth_detector_centroid_error_px !== null &&
    sample.truth_detector_centroid_error_px <= config.detectionAssociationRadiusPx &&
    !sample.truth_detection_on_other_emitter
  );
}

// --- Lock episodes ----------------------------------------------------------

type LockStatus = 'unlocked' | 'locked' | 'lapsing';

/** The result of walking a run's samples for lock. */
export interface LockAnalysis {
  readonly lockTime: number | null;
  readonly lockedDuration: number;
  readonly trackableDuration: number;
  readonly everTrackable: boolean;
  readonly episodes: readonly LossEpisode[];
}

/**
 * Walks evaluation samples, in order, and works out when the system was locked.
 *
 * **Time integration is zero-order hold on the earlier sample.** The interval
 * between consecutive samples at t(i-1) and t(i) is attributed to the state
 * established at t(i-1). Time after the last sample is not extrapolated.
 *
 * **Coarse lock** is confirmed at the first sample at which the lock condition
 * has held at every sample since some t_s, with t - t_s >= dwell. The locked
 * duration starts there, not at t_s.
 *
 * **A brief lapse is not a loss.** When a locked condition fails at t_a, the
 * status becomes *lapsing*. If the condition is met again at a sample no more
 * than `grace` after t_a, the lapse is bridged and its time counts as locked.
 * If instead a sample at or beyond t_a + grace still fails — or the condition
 * only returns later than that — a loss episode is recorded as starting at t_a
 * and the lapse time is **not** credited as locked. A lapse still open when the
 * samples end is neither declared a loss nor credited.
 *
 * **Retention denominator.** Intervals whose earlier sample is at or after the
 * first confirmed lock and whose target was trackable. Locked and bridged time
 * is counted in the numerator only for those same intervals, so the rate cannot
 * exceed one.
 */
export class LockAnalyser {
  private status: LockStatus = 'unlocked';
  private conditionSince: number | null = null;
  private lapsedAt: number | null = null;
  private provisional = 0;

  private previousTime: number | null = null;
  private previousStatus: LockStatus = 'unlocked';
  private previousTrackable = false;
  private previousAcquired = false;

  public lockTime: number | null = null;
  public lockedDuration = 0;
  public trackableDuration = 0;
  public everTrackable = false;
  public readonly episodes: LossEpisode[] = [];

  constructor(private readonly config: MetricsConfig) {}

  /** Processes one sample; returns whether the system is locked as of it. */
  public push(time: number, conditionMet: boolean, trackable: boolean): boolean {
    // 1. The interval that just ended, credited to the state at its start.
    if (this.previousTime !== null) {
      const dt = time - this.previousTime;
      if (this.previousAcquired && this.previousTrackable) {
        this.trackableDuration += dt;
        if (this.previousStatus === 'locked') this.lockedDuration += dt;
        else if (this.previousStatus === 'lapsing') this.provisional += dt;
      }
    }
    if (trackable) this.everTrackable = true;

    // 2. This sample's effect on the state.
    if (conditionMet) {
      if (this.status === 'lapsing') {
        if (time - this.lapsedAt! <= this.config.lockDropoutGraceSeconds) {
          this.status = 'locked';
          this.lockedDuration += this.provisional;
          this.provisional = 0;
          this.lapsedAt = null;
        } else {
          // The condition came back, but later than the grace allows.
          this.declareLoss();
        }
      }
      this.conditionSince ??= time;
      if (
        this.status === 'unlocked' &&
        time - this.conditionSince >= this.config.lockDwellSeconds
      ) {
        this.status = 'locked';
        this.lockTime ??= time;
        this.closeOpenEpisode(time);
      }
    } else {
      this.conditionSince = null;
      if (this.status === 'locked') {
        this.status = 'lapsing';
        this.lapsedAt = time;
      }
      if (
        this.status === 'lapsing' &&
        time - this.lapsedAt! >= this.config.lockDropoutGraceSeconds
      ) {
        this.declareLoss();
      }
    }

    this.previousTime = time;
    this.previousStatus = this.status;
    this.previousTrackable = trackable;
    this.previousAcquired = this.lockTime !== null;
    return this.status !== 'unlocked';
  }

  private declareLoss(): void {
    this.episodes.push({
      lost_at_s: this.lapsedAt!,
      recovered_at_s: null,
      duration_s: null,
      unrecovered: true,
    });
    this.status = 'unlocked';
    this.provisional = 0;
    this.lapsedAt = null;
  }

  private closeOpenEpisode(time: number): void {
    const last = this.episodes[this.episodes.length - 1];
    if (last === undefined || last.recovered_at_s !== null) return;
    this.episodes[this.episodes.length - 1] = {
      lost_at_s: last.lost_at_s,
      recovered_at_s: time,
      duration_s: time - last.lost_at_s,
      unrecovered: false,
    };
  }

  public result(): LockAnalysis {
    return {
      lockTime: this.lockTime,
      lockedDuration: this.lockedDuration,
      trackableDuration: this.trackableDuration,
      everTrackable: this.everTrackable,
      episodes: [...this.episodes],
    };
  }

  /** Retention so far, for a live display. `null` before any opportunity. */
  public get currentRetention(): number | null {
    return this.lockTime === null || this.trackableDuration <= 0
      ? null
      : Math.min(1, this.lockedDuration / this.trackableDuration);
  }
}

/** Lock analysis over an array of samples. For tests. */
export function analyseLock(
  samples: readonly EvaluationSample[],
  config: MetricsConfig,
): LockAnalysis {
  const analyser = new LockAnalyser(config);
  for (const sample of samples) {
    analyser.push(
      sample.capture_time_s,
      lockConditionMet(sample, config),
      isTrackable(sample, config),
    );
  }
  return analyser.result();
}

// --- The summary builder ----------------------------------------------------

/** What the summary needs that is not in a row. All of it comes from the manifest. */
export interface SummaryContext {
  /** The artifact format version the run was recorded under. */
  readonly schemaVersion: ExperimentSchemaVersion;
  readonly runId: string;
  readonly metricsConfig: MetricsConfig;
  readonly metricsFingerprint: string;
  readonly terminationReason: TerminationReason | null;
  readonly configuredSensorFps: number;
  /** Frames the sensor generated with capture time in [start, end). From the manifest. */
  readonly sensorFramesGenerated: number;
  /**
   * The disturbance preset named in the scenario, for provenance.
   *
   * The name only. Every parameter lives in the scenario snapshot, so a report
   * stays complete even if the preset is later retuned or removed.
   */
  readonly disturbancePreset?: string | null | undefined;
  readonly startSimulationTime: number;
  readonly endSimulationTime: number;
}

/** Whether a column carries a usable number, as opposed to null or absent. */
const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const numberDetail = (event: ExperimentEvent, key: string): number | null => {
  const value = event.detail[key];
  return typeof value === 'number' ? value : null;
};

const optional = (value: number | null, unit: string): Measurement =>
  value === null ? notMeasured(unit) : derived(value, unit);

const difference = (later: number | null, earlier: number | null, unit: string): Measurement =>
  later === null || earlier === null ? notMeasured(unit) : derived(later - earlier, unit);

/**
 * Reduces a recorded run to its metrics, one row at a time.
 *
 * Constructed with the run's context from the manifest. Feed every event, then
 * every telemetry row, then every evaluation row, each in file order, and call
 * {@link finish}. The order matters only within a file; the three streams are
 * independent.
 */
export class SummaryBuilder {
  // Events
  private searchStart: number | null = null;
  private trackEntry: number | null = null;
  private autonomyStart: number | null = null;
  private commandsIssued = 0;
  private commandsApplied = 0;
  private readonly inFlight = new Map<number, { captureTime: number; issuedAt: number }>();
  private readonly captureToIssue = new SampleSeries();
  private readonly issueToApplication = new SampleSeries();
  private readonly captureToApplication = new SampleSeries();
  private readonly scheduledToActual = new SampleSeries();

  // Telemetry
  private processedInWindow = 0;
  private readonly host = {
    worldStep: new SampleSeries(),
    sensorFrameGeneration: new SampleSeries(),
    detector: new SampleSeries(),
    bearingTransform: new SampleSeries(),
    estimator: new SampleSeries(),
    controller: new SampleSeries(),
    identity: new SampleSeries(),
    algorithmTotal: new SampleSeries(),
    runtimeOrchestration: new SampleSeries(),
  };

  // Evaluation
  private readonly lock: LockAnalyser;
  private evaluationCount = 0;
  private firstDetection: number | null = null;
  private readonly angular = new WindowedSeries();
  private readonly image = new WindowedSeries();
  private readonly centroid = new SampleSeries();
  private detectorMisses = 0;
  private falseLockExercised = false;
  private falseLockEpisodes = 0;
  private falseLockDuration = 0;

  // Beacon identity (Phase 8). The algorithm's verdict per frame, kept so the
  // evaluation pass can score it against truth. Telemetry is consumed in full
  // before evaluation begins, so the lookup is always populated by then.
  private identitySeen = false;
  private readonly identityByFrame = new Map<number, string>();
  private identityChallenges = 0;
  private correctCodeAssociations = 0;
  private wrongCodeAssociations = 0;
  private ambiguousEpisodes = 0;
  private insufficientEpisodes = 0;
  private matchFrames = 0;
  private mismatchFrames = 0;
  private readonly matchCorrelation = new SampleSeries();
  private previousIdentity: string | null = null;
  private trackDuration = 0;
  private trackWithoutLock = 0;
  private previous: {
    time: number;
    inTrack: boolean;
    falseLocked: boolean;
    conditionMet: boolean;
    inHandoff: boolean;
    handoffValid: boolean;
  } | null = null;

  // Definition v2: handoff readiness, from evaluation rows.
  private firstHandoff: number | null = null;
  private handoffEpisodes = 0;
  private handoffDuration = 0;
  private handoffValidDuration = 0;

  // Definition v2: the algorithm's own recovery attempts, from events.
  private recoverSince: number | null = null;
  private recoverEntries = 0;
  private recoverSuccesses = 0;
  private recoverFallbacks = 0;
  private readonly recoveryTimes = new SampleSeries();

  // Definition v2: estimator model probabilities, from telemetry.
  private framesWithImm = 0;

  // --- Disturbance realization, measured rather than read back from config ---
  private disturbanceSeen = false;
  private framesDropped = 0;
  private longestDropBurst = 0;
  private readonly baseAzimuth = new SampleSeries();
  private readonly baseElevation = new SampleSeries();
  private readonly wanderAzimuth = new SampleSeries();
  private readonly wanderElevation = new SampleSeries();
  private readonly scintillation = new SampleSeries();
  private readonly snrDb = new SampleSeries();
  private readonly saturated = new SampleSeries();
  private readonly caProbability = new SampleSeries();
  private readonly trackingModes: readonly string[];

  private readonly config: MetricsConfig;

  constructor(private readonly context: SummaryContext) {
    this.config = context.metricsConfig;
    this.lock = new LockAnalyser(context.metricsConfig);
    this.trackingModes = trackingModesFor(context.metricsConfig);
  }

  public addEvent(event: ExperimentEvent): void {
    switch (event.type) {
      case 'search-started':
        this.searchStart ??= event.simulationTime;
        break;
      case 'frames-dropped': {
        // One event per burst, carrying its length. Counting frames and the
        // longest run from the same record keeps the summary reproducible from
        // the log alone.
        const frames = numberDetail(event, 'frames') ?? 0;
        this.framesDropped += frames;
        this.longestDropBurst = Math.max(this.longestDropBurst, frames);
        break;
      }
      case 'track-entered':
        this.trackEntry ??= event.simulationTime;
        break;
      case 'autonomy-enabled':
        this.autonomyStart ??= event.simulationTime;
        break;
      case 'recover-entered':
        this.recoverEntries += 1;
        this.recoverSince = event.simulationTime;
        break;
      case 'reacquired':
        if (this.recoverSince !== null) {
          this.recoverSuccesses += 1;
          this.recoveryTimes.push(event.simulationTime - this.recoverSince);
          this.recoverSince = null;
        }
        break;
      case 'search-reentered':
        if (this.recoverSince !== null) {
          this.recoverFallbacks += 1;
          this.recoverSince = null;
        }
        break;
      case 'command-issued': {
        const id = numberDetail(event, 'commandId');
        const captureTime = numberDetail(event, 'captureTime');
        const issuedAt = numberDetail(event, 'issuedAt');
        if (id === null || captureTime === null || issuedAt === null) break;
        this.commandsIssued += 1;
        this.inFlight.set(id, { captureTime, issuedAt });
        this.captureToIssue.push(issuedAt - captureTime);
        break;
      }
      case 'command-applied': {
        const id = numberDetail(event, 'commandId');
        const appliedAt = numberDetail(event, 'appliedAt');
        const dueAt = numberDetail(event, 'dueAt');
        const origin = id === null ? undefined : this.inFlight.get(id);
        // Only commands this run issued. An application of a command issued
        // before recording began has no issue record to measure from.
        if (origin === undefined || appliedAt === null || dueAt === null) break;
        this.inFlight.delete(id!);
        this.commandsApplied += 1;
        this.issueToApplication.push(appliedAt - origin.issuedAt);
        this.captureToApplication.push(appliedAt - origin.captureTime);
        this.scheduledToActual.push(appliedAt - dueAt);
        break;
      }
      default:
        break;
    }
  }

  public addTelemetry(sample: TelemetrySample): void {
    // Frames are counted over the half-open window [start, end). A camera at f
    // fps yields f*T frames in a window of length T that way, rather than
    // f*T + 1 when one frame lands on each end, which would read as a sensor
    // running fast.
    const capture = sample.frame_capture_time_s;
    if (capture >= this.context.startSimulationTime && capture < this.context.endSimulationTime) {
      this.processedInWindow += 1;
    }
    const host = this.host;
    host.worldStep.push(sample.host_world_step_ms);
    host.sensorFrameGeneration.push(sample.host_sensor_frame_ms);
    host.algorithmTotal.push(sample.host_algorithm_ms);
    host.runtimeOrchestration.push(sample.host_orchestration_ms);
    // A stage that did not run on this frame is absent, not zero.
    if (sample.host_detector_ms !== null) host.detector.push(sample.host_detector_ms);
    if (sample.host_bearing_transform_ms !== null) {
      host.bearingTransform.push(sample.host_bearing_transform_ms);
    }
    if (sample.host_estimator_ms !== null) host.estimator.push(sample.host_estimator_ms);
    if (sample.host_controller_ms !== null) host.controller.push(sample.host_controller_ms);
    // Guarded on being a number rather than on being non-null: a run recorded
    // before the identity stage existed has this column absent, not null.
    if (isNumber(sample.host_identity_ms)) host.identity.push(sample.host_identity_ms);

    // An algorithm without a correlator writes an empty string here, and a run
    // recorded before the column existed has it absent. Neither is a verdict.
    const identity = sample.identity_state;
    if (typeof identity === 'string' && identity.length > 0) {
      this.identitySeen = true;
      this.identityByFrame.set(sample.frame_id, identity);
      if (identity === 'match') {
        this.matchFrames += 1;
        if (isNumber(sample.code_correlation)) this.matchCorrelation.push(sample.code_correlation);
      }
      if (identity === 'mismatch') this.mismatchFrames += 1;
      // Episodes are runs, not frames: a verdict that holds for a second is one
      // episode of not knowing, not sixty.
      if (identity === 'ambiguous' && this.previousIdentity !== 'ambiguous') {
        this.ambiguousEpisodes += 1;
      }
      if (
        identity === 'insufficient-evidence' &&
        this.previousIdentity !== 'insufficient-evidence'
      ) {
        this.insufficientEpisodes += 1;
      }
      this.previousIdentity = identity;
    } else {
      this.previousIdentity = null;
    }
    if (sample.imm_ca_probability !== null) {
      this.framesWithImm += 1;
      if (this.trackingModes.includes(sample.pat_state)) {
        this.caProbability.push(sample.imm_ca_probability);
      }
    }
  }

  public addEvaluation(sample: EvaluationSample): void {
    const config = this.config;
    const time = sample.capture_time_s;
    const inTrack = this.trackingModes.includes(sample.pat_state);
    const inHandoff = sample.pat_state === 'handoff';
    // Every definition except v1 has a handoff-validity threshold, and writing
    // the condition as "not v1" rather than "is v2" is what stops the next
    // version bump from silently dropping it — which is exactly how v3 lost it
    // between Phase 7 and Phase 9.
    const handoffValid =
      inHandoff &&
      config.definitionVersion !== 1 &&
      sample.truth_angular_pointing_error_rad !== null &&
      sample.truth_angular_pointing_error_rad <= config.handoffValidityThresholdRad;
    if (inHandoff) this.firstHandoff ??= time;
    const conditionMet = lockConditionMet(sample, config);
    this.evaluationCount += 1;

    this.lock.push(time, conditionMet, isTrackable(sample, config));
    const postAcquisition = this.lock.lockTime !== null && time >= this.lock.lockTime;

    if (sample.truth_angular_pointing_error_rad !== null) {
      this.angular.push(sample.truth_angular_pointing_error_rad, postAcquisition, inTrack);
    }
    if (sample.truth_image_pointing_error_px !== null) {
      this.image.push(sample.truth_image_pointing_error_px, postAcquisition, inTrack);
    }
    if (sample.truth_detector_centroid_error_px !== null) {
      this.centroid.push(sample.truth_detector_centroid_error_px);
    }
    if (sample.truth_target_in_image && !sample.detection_present) this.detectorMisses += 1;
    if (this.firstDetection === null && detectionOfTarget(sample, config)) {
      this.firstDetection = time;
    }
    if (sample.truth_other_emitters_in_image > 0) this.falseLockExercised = true;

    // Guarded on being an actual number, not merely on being non-null. A row
    // recorded before these columns existed has them absent rather than null,
    // and `undefined !== null` is true — which would push NaN into every series
    // and turn the whole block into NaN.
    if (isNumber(sample.truth_base_azimuth_rad)) {
      this.disturbanceSeen = true;
      this.baseAzimuth.push(sample.truth_base_azimuth_rad);
      if (isNumber(sample.truth_base_elevation_rad)) {
        this.baseElevation.push(sample.truth_base_elevation_rad);
      }
    }
    if (isNumber(sample.truth_wander_azimuth_rad)) {
      this.disturbanceSeen = true;
      this.wanderAzimuth.push(sample.truth_wander_azimuth_rad);
      if (isNumber(sample.truth_wander_elevation_rad)) {
        this.wanderElevation.push(sample.truth_wander_elevation_rad);
      }
    }
    if (isNumber(sample.truth_scintillation_gain)) {
      this.disturbanceSeen = true;
      this.scintillation.push(sample.truth_scintillation_gain);
    }
    if (isNumber(sample.truth_image_snr_db)) this.snrDb.push(sample.truth_image_snr_db);
    if (isNumber(sample.truth_saturated_fraction)) {
      this.saturated.push(sample.truth_saturated_fraction);
    }

    // A false lock is the tracker holding a detection on the *wrong* emitter.
    // High pointing error alone is a loss of lock, not a false lock; the two
    // are different failures and conflating them would make both meaningless.
    const falseLocked = inTrack && sample.truth_detection_on_other_emitter;

    if (this.previous !== null) {
      const dt = time - this.previous.time;
      if (this.previous.inTrack) this.trackDuration += dt;
      if (this.previous.falseLocked) this.falseLockDuration += dt;
      if (this.previous.inTrack && !this.previous.conditionMet) this.trackWithoutLock += dt;
      if (this.previous.inHandoff) this.handoffDuration += dt;
      if (this.previous.handoffValid) this.handoffValidDuration += dt;
    }
    // Identity scoring. The challenge count is deliberately independent of
    // whether identity is enabled, so an ON/OFF comparison is over the same
    // number of opportunities rather than over whatever each arm happened to
    // encounter.
    if (inTrack && sample.truth_other_emitters_in_image > 0) this.identityChallenges += 1;
    if (this.identityByFrame.get(sample.frame_id) === 'match') {
      if (sample.truth_detection_on_other_emitter) this.wrongCodeAssociations += 1;
      else if (sample.detection_present) this.correctCodeAssociations += 1;
    }

    if (falseLocked && this.previous?.falseLocked !== true) this.falseLockEpisodes += 1;
    if (inHandoff && this.previous?.inHandoff !== true) this.handoffEpisodes += 1;

    this.previous = { time, inTrack, falseLocked, conditionMet, inHandoff, handoffValid };
  }

  public finish(): ExperimentSummary {
    const context = this.context;
    const lock = this.lock.result();
    const duration = context.endSimulationTime - context.startSimulationTime;

    const autonomyFrom =
      this.autonomyStart === null
        ? null
        : Math.max(this.autonomyStart, context.startSimulationTime);
    const autonomousDuration =
      autonomyFrom === null ? null : context.endSimulationTime - autonomyFrom;
    const perSecond = (count: number): Measurement =>
      autonomousDuration === null || autonomousDuration <= 0
        ? notMeasured('fps')
        : derived(count / autonomousDuration, 'fps');

    const acquisitionOutcome: AcquisitionOutcome =
      this.evaluationCount === 0
        ? 'no-samples'
        : lock.lockTime === null
          ? 'no-acquisition'
          : this.searchStart === null
            ? 'no-search-recorded'
            : 'acquired';

    // Retention has three distinct outcomes and they must not collapse into one
    // number. Never locked while the target was trackable: a real zero, and the
    // run failed to acquire. Never any trackable opportunity: undefined, not
    // zero, because there was nothing to retain.
    let retention: Measurement;
    let retentionStatus: RetentionStatus;
    if (!lock.everTrackable) {
      retention = notApplicable('1');
      retentionStatus = 'no-trackable-opportunity';
    } else if (lock.lockTime === null) {
      retention = derived(0, '1');
      retentionStatus = 'no-acquisition';
    } else if (lock.trackableDuration > 0) {
      retention = derived(Math.min(1, lock.lockedDuration / lock.trackableDuration), '1');
      retentionStatus = 'computed';
    } else {
      retention = notApplicable('1');
      retentionStatus = 'no-trackable-opportunity';
    }

    const recovered = new SampleSeries();
    for (const episode of lock.episodes) {
      if (episode.duration_s !== null) recovered.push(episode.duration_s);
    }

    const summary: ExperimentSummary = {
      schemaVersion: context.schemaVersion,
      metricsDefinitionVersion: context.metricsConfig.definitionVersion,
      metricsFingerprint: context.metricsFingerprint,
      runId: context.runId,
      metricsConfig: context.metricsConfig,
      terminationReason: context.terminationReason,

      simulationDurationSeconds: derived(duration, 's'),
      autonomousDurationSeconds: optional(autonomousDuration, 's'),
      configuredSensorFps: configured(context.configuredSensorFps, 'fps'),
      effectiveSensorFps: perSecond(context.sensorFramesGenerated),
      algorithmProcessedFps: perSecond(this.processedInWindow),
      sensorFramesGenerated: context.sensorFramesGenerated,
      algorithmFramesProcessed: this.processedInWindow,

      acquisitionOutcome,
      searchStartTime: optional(this.searchStart, 's'),
      firstDetectionTime: optional(this.firstDetection, 's'),
      trackEntryTime: optional(this.trackEntry, 's'),
      coarseLockTime: optional(lock.lockTime, 's'),
      timeToFirstDetection: difference(this.firstDetection, this.searchStart, 's'),
      timeToTrack: difference(this.trackEntry, this.searchStart, 's'),
      coarseAcquisitionTime: difference(lock.lockTime, this.searchStart, 's'),

      angularPointingError: this.angular.statistics('rad'),
      imagePointingError: this.image.statistics('px'),
      detectorCentroidError: this.centroid.statistics('px'),
      detectorMissesWithTargetInImage: this.detectorMisses,

      lockRetentionRate: retention,
      lockRetentionStatus: retentionStatus,
      lockedDurationSeconds: derived(lock.lockedDuration, 's'),
      trackableOpportunitySeconds: derived(lock.trackableDuration, 's'),
      lossOfLockEpisodes: lock.episodes.length,
      unrecoveredLosses: lock.episodes.filter((episode) => episode.unrecovered).length,
      reacquisitionCount: recovered.length,
      reacquisitionTime: recovered.statistics('s'),
      episodes: [...lock.episodes],
      trackClaimedWithoutLockSeconds: derived(this.trackWithoutLock, 's'),

      // No competing emitter ever in view: the wrong-target challenge was never
      // posed. Reporting "0 false locks" without saying so would imply a
      // robustness the run never tested.
      beaconIdentity: this.identitySeen
        ? {
            identityEnabled: true,
            identityChallenges: this.identityChallenges,
            correctCodeAssociations: this.correctCodeAssociations,
            wrongCodeAssociations: this.wrongCodeAssociations,
            ambiguousIdentityEpisodes: this.ambiguousEpisodes,
            insufficientEvidenceEpisodes: this.insufficientEpisodes,
            matchFrames: this.matchFrames,
            mismatchFrames: this.mismatchFrames,
            matchCorrelation: this.matchCorrelation.statistics('1'),
          }
        : null,
      falseLockExercised: this.falseLockExercised,
      falseLockEpisodes: this.falseLockEpisodes,
      falseLockDurationSeconds: this.falseLockExercised
        ? derived(this.falseLockDuration, 's')
        : notApplicable('s'),
      falseLockRate:
        this.falseLockExercised && this.trackDuration > 0
          ? derived(this.falseLockDuration / this.trackDuration, '1')
          : notApplicable('1'),

      hostProcessingTime: {
        worldStep: this.host.worldStep.statistics('ms'),
        sensorFrameGeneration: this.host.sensorFrameGeneration.statistics('ms'),
        detector: this.host.detector.statistics('ms'),
        bearingTransform: this.host.bearingTransform.statistics('ms'),
        estimator: this.host.estimator.statistics('ms'),
        controller: this.host.controller.statistics('ms'),
        identity: this.host.identity.statistics('ms'),
        algorithmTotal: this.host.algorithmTotal.statistics('ms'),
        runtimeOrchestration: this.host.runtimeOrchestration.statistics('ms'),
      },

      commandsIssued: this.commandsIssued,
      commandsApplied: this.commandsApplied,
      commandsPendingAtEnd: this.inFlight.size,
      controlLatency: {
        captureToIssue: this.captureToIssue.statistics('s'),
        issueToApplication: this.issueToApplication.statistics('s'),
        captureToApplication: this.captureToApplication.statistics('s'),
        scheduledToActualApplication: this.scheduledToActual.statistics('s'),
      },
    };

    // Definition v1 summaries stop here, exactly as Phase 5 wrote them, so a
    // historical run recomputes to the summary it stored.
    if (context.metricsConfig.definitionVersion === 1) return summary;

    return {
      ...summary,
      trackingModes: [...this.trackingModes],
      handoff: {
        firstHandoffReadyTime: optional(this.firstHandoff, 's'),
        timeToHandoffReady: difference(this.firstHandoff, this.searchStart, 's'),
        episodes: this.handoffEpisodes,
        durationSeconds: derived(this.handoffDuration, 's'),
        validDurationSeconds: derived(this.handoffValidDuration, 's'),
        validityRate:
          this.handoffDuration > 0
            ? derived(this.handoffValidDuration / this.handoffDuration, '1')
            : notApplicable('1'),
      },
      algorithmRecovery: {
        entries: this.recoverEntries,
        reacquired: this.recoverSuccesses,
        fellBackToSearch: this.recoverFallbacks,
        unresolved: this.recoverSince === null ? 0 : 1,
        recoveryTime: this.recoveryTimes.statistics('s'),
      },
      estimator: {
        framesWithModelProbabilities: this.framesWithImm,
        caProbabilityWhileTracking: this.caProbability.statistics('1'),
      },
      disturbance: this.disturbanceSummary(autonomousDuration),
    };
  }

  /**
   * What the disturbances actually did, measured from the recorded realization.
   *
   * `null` for a run that had none — not a block of zeroes, which would read as
   * "measured and found to be nothing" when the truth is that no such thing was
   * modelled.
   */
  private disturbanceSummary(autonomousDuration: number | null): ExperimentSummary['disturbance'] {
    if (!this.disturbanceSeen && this.framesDropped === 0) return null;

    const active: string[] = [];
    if (this.baseAzimuth.length > 0) active.push('platform');
    if (this.wanderAzimuth.length > 0) active.push('wander');
    if (this.scintillation.length > 0) active.push('scintillation');
    if (this.framesDropped > 0) active.push('dropouts');
    if (this.snrDb.length > 0) active.push('sensor-noise');

    const scheduled =
      autonomousDuration === null ? null : this.context.sensorFramesGenerated + this.framesDropped;

    return {
      preset: this.context.disturbancePreset ?? null,
      active,
      platformJitterRmsAzimuth: rmsOf(this.baseAzimuth, 'rad'),
      platformJitterRmsElevation: rmsOf(this.baseElevation, 'rad'),
      apparentWanderRmsAzimuth: rmsOf(this.wanderAzimuth, 'rad'),
      apparentWanderRmsElevation: rmsOf(this.wanderElevation, 'rad'),
      scintillationGain: this.scintillation.statistics('1'),
      framesDropped: this.framesDropped,
      frameDropRate:
        scheduled === null || scheduled === 0
          ? notMeasured('1')
          : derived(this.framesDropped / scheduled, '1'),
      longestDropBurstFrames: this.longestDropBurst,
      // Undefined rather than zero when nothing stochastic was configured: a
      // run with no noise has no signal-to-noise ratio.
      // An empty series already reports not-measured throughout, which is the
      // honest reading: with no stochastic noise the ratio is undefined, and
      // "0 dB" is exactly the fabrication Phase 5 removed.
      imageSnrDb: this.snrDb.statistics('dB'),
      saturatedPixelFraction:
        this.saturated.length > 0 ? this.saturated.statistics('1').mean : notApplicable('1'),
    };
  }
}

/** Root mean square of a series, or `not-measured` when it is empty. */
function rmsOf(series: SampleSeries, unit: string): Measurement {
  const stats = series.statistics(unit);
  return stats.rms;
}

/** Everything a whole-array summary needs. For tests. */
export interface SummaryInputs {
  readonly events: readonly ExperimentEvent[];
  readonly telemetry: readonly TelemetrySample[];
  readonly evaluation: readonly EvaluationSample[];
  readonly context: SummaryContext;
}

/** Reduces arrays of rows to a summary. Same builder, same answers. */
export function computeSummary(inputs: SummaryInputs): ExperimentSummary {
  const builder = new SummaryBuilder(inputs.context);
  for (const event of inputs.events) builder.addEvent(event);
  for (const sample of inputs.telemetry) builder.addTelemetry(sample);
  for (const sample of inputs.evaluation) builder.addEvaluation(sample);
  return builder.finish();
}
