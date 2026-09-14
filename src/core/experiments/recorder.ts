/**
 * The experiment recorder.
 *
 * An **observer** of the closed loop. It is attached to a `ClosedLoopRuntime`
 * as a `LoopObserver`, is told about each frame after the algorithm has
 * finished with it and the command has been submitted, and writes down what
 * happened. It never reaches back in: it does not alter algorithm input,
 * command timing, mount state or the progression of simulated time, and a test
 * compares a run with recording on against the same run with it off and
 * requires identical transitions, commands, final mount pose and world hash.
 *
 * Three consequences shape the design.
 *
 * **Disk speed must not reach the simulation.** Writes are queued and drained
 * asynchronously; the engineering timebase is simulated time and nothing here
 * touches it. When the queue grows past a high-water mark the recorder reports
 * `backpressured`, and whoever drives the simulation stops advancing it until
 * the queue drains. A slow disk makes the wall clock longer and the result
 * identical — no mandatory sample is ever dropped to keep up.
 *
 * **Memory is bounded.** Rows are serialised as they arrive into small batches
 * and flushed; the recorder retains no row objects, no per-sample arrays and no
 * history. What it does keep is a fixed amount of scalar state for the live
 * evaluation display. The summary is not accumulated live at all: at
 * finalisation it is computed by streaming the persisted files back through the
 * KPI engine, which is also exactly how an offline recomputation does it.
 *
 * **A failed write is never hidden.** If persistence fails the recorder enters
 * `failed` immediately, stops recording and says why. The control loop carries
 * on untouched; the experiment is simply not claimed to have been saved.
 *
 * See docs/EXPERIMENTS.md.
 */

import type { SimulationConfig } from '@/core/contracts/simulation';
import type {
  AppliedCommandObservation,
  LoopObservation,
  LoopObserver,
} from '@/core/runtime/closed-loop';
import type { SimulationEngine } from '@/core/simulation/engine';
import { resolveIntrinsics } from '@/core/sensors/pinhole';

import { Evaluator } from './evaluation';
import { fingerprint } from './fingerprint';
import { LockAnalyser, isTrackable, lockConditionMet } from './metrics';
import { summariseStoredRun } from './recompute';
import { renderStoredReport } from './report';
import { DEFAULT_METRICS_CONFIG, EXPERIMENT_SCHEMA_VERSION } from './schema';
import type {
  ArtifactClassification,
  EventDetail,
  ExperimentEvent,
  ExperimentEventType,
  ExperimentManifest,
  ExperimentStatus,
  ExperimentSummary,
  MetricsConfig,
  TelemetrySample,
  TerminationReason,
} from './schema';
import { evaluationHeader, evaluationRow, telemetryHeader, telemetryRow } from './serialisation';
import { RUN_FILES } from './storage';
import type { ExperimentStorage } from './storage';

/** Rows held per file before a flush. */
export const BATCH_ROWS = 120;

/**
 * Queued, unwritten bytes above which the recorder asks for backpressure.
 *
 * Far above what one frame produces (about 1.5 KB), so a healthy disk never
 * triggers it; low enough that a stalled one cannot grow the queue without
 * bound before the driver notices.
 */
export const BACKPRESSURE_BYTES = 2 * 1024 * 1024;

/** What each file in a run directory is. Written into the manifest. */
export const ARTIFACT_CLASSIFICATION: Readonly<Record<string, ArtifactClassification>> = {
  [RUN_FILES.manifest]: 'provenance',
  [RUN_FILES.scenario]: 'configuration',
  [RUN_FILES.algorithm]: 'configuration',
  [RUN_FILES.events]: 'event-log',
  [RUN_FILES.telemetry]: 'safe-telemetry',
  [RUN_FILES.evaluation]: 'privileged-evaluation',
  [RUN_FILES.summary]: 'derived-summary',
  [RUN_FILES.report]: 'derived-report',
};

export interface RecorderOptions {
  readonly storage: ExperimentStorage;
  readonly engine: SimulationEngine;
  readonly config: SimulationConfig;
  readonly scenarioId: string | null;
  readonly algorithmId: string;
  readonly algorithmVersion: string;
  readonly algorithmConfig: unknown;
  readonly metricsConfig?: MetricsConfig | undefined;
  /** Index into the scenario's targets of the one being scored. Defaults to 0. */
  readonly designatedTargetIndex?: number | undefined;
  readonly applicationVersion: string;
  readonly sourceCommit: string | null;
  readonly sourceTreeModified?: boolean | null | undefined;
  readonly platform: string;
  /**
   * Called once, synchronously, when the recorder stops because a write
   * failed — so whoever owns it can react immediately rather than on the next
   * simulation step, which may never come if the run is paused.
   */
  readonly onFailure?: ((message: string) => void) | undefined;
  /** Queued bytes above which to ask for backpressure. Defaults to {@link BACKPRESSURE_BYTES}. */
  readonly backpressureBytes?: number | undefined;
  /** Overridable so tests get deterministic ids and timestamps. */
  readonly runId?: string | undefined;
  readonly now?: (() => Date) | undefined;
}

/** What the interface shows about a recording. Every figure is a real count. */
export interface RecorderStatus {
  readonly runId: string;
  readonly state: ExperimentStatus;
  readonly terminationReason: TerminationReason | null;
  readonly startSimulationTime: number;
  readonly eventsRecorded: number;
  readonly telemetryRows: number;
  readonly evaluationRows: number;
  /** Bytes the storage has confirmed written. */
  readonly bytesWritten: number;
  /** Bytes serialised but not yet confirmed written. */
  readonly pendingBytes: number;
  readonly backpressured: boolean;
  readonly writerError: string | null;
  readonly runPath: string | null;
}

/**
 * The live evaluation readout.
 *
 * **Ground truth.** For the operator's EVALUATION panel only. It is derived
 * from the same privileged samples the recorder writes and is never routed to
 * the algorithm, which has no way to reach this module.
 */
export interface LiveEvaluation {
  readonly angularPointingErrorRad: number | null;
  readonly imagePointingErrorPx: number | null;
  /** The instantaneous lock condition, without dwell. */
  readonly lockConditionMet: boolean;
  /** Confirmed coarse lock, with dwell and grace applied. */
  readonly locked: boolean;
  /** Retention so far, or `null` before the first confirmed lock. */
  readonly retention: number | null;
  readonly framesProcessed: number;
}

export class ExperimentRecorder implements LoopObserver {
  public readonly runId: string;

  private readonly options: RecorderOptions;
  private readonly storage: ExperimentStorage;
  private readonly engine: SimulationEngine;
  private readonly evaluator: Evaluator;
  private readonly metricsConfig: MetricsConfig;
  private readonly createdAt: string;
  private timerResolutionMs: number | null = null;

  private state: ExperimentStatus = 'created';
  private terminationReason: TerminationReason | null = null;
  private startTime = 0;
  private endTime: number | null = null;
  private endStateHash: string | null = null;
  private endedAt: string | null = null;
  private runLocation: string | null = null;

  private sequence = 0;
  private lastEventTime = Number.NEGATIVE_INFINITY;
  private eventsRecorded = 0;
  private telemetryRows = 0;
  private evaluationRows = 0;
  private sensorFramesGenerated = 0;
  private lastGeneratedCaptureTime = Number.NEGATIVE_INFINITY;

  // Bounded batches of already-serialised rows.
  private eventBatch: string[] = [];
  private telemetryBatch: string[] = [];
  private evaluationBatch: string[] = [];

  // The write queue.
  private writeChain: Promise<void> = Promise.resolve();
  private pendingBytes = 0;
  private bytesWritten = 0;
  private writerError: string | null = null;

  // Change detection for events. Scalars only.
  private lastMode: string | null = null;
  private lastHadCandidate = false;
  private lastMisses = 0;
  private lastPanSaturation = 'none';
  private lastTiltSaturation = 'none';

  // Live evaluation. Scalars plus the analyser's episode list.
  private readonly liveLock: LockAnalyser;
  private live: LiveEvaluation = {
    angularPointingErrorRad: null,
    imagePointingErrorPx: null,
    lockConditionMet: false,
    locked: false,
    retention: null,
    framesProcessed: 0,
  };

  constructor(options: RecorderOptions) {
    this.options = options;
    this.storage = options.storage;
    this.engine = options.engine;
    this.metricsConfig = options.metricsConfig ?? DEFAULT_METRICS_CONFIG;
    const now = options.now?.() ?? new Date();
    this.createdAt = now.toISOString();
    this.runId = options.runId ?? generateRunId(now);
    this.evaluator = new Evaluator({
      engine: options.engine,
      config: options.config,
      designatedIndex: options.designatedTargetIndex ?? 0,
    });
    this.liveLock = new LockAnalyser(this.metricsConfig);
  }

  public get status(): RecorderStatus {
    return {
      runId: this.runId,
      state: this.state,
      terminationReason: this.terminationReason,
      startSimulationTime: this.startTime,
      eventsRecorded: this.eventsRecorded,
      telemetryRows: this.telemetryRows,
      evaluationRows: this.evaluationRows,
      bytesWritten: this.bytesWritten,
      pendingBytes: this.pendingBytes,
      backpressured: this.backpressured,
      writerError: this.writerError,
      runPath: this.runLocation,
    };
  }

  public get isRecording(): boolean {
    return this.state === 'running';
  }

  /** True while the write queue is over its high-water mark. */
  public get backpressured(): boolean {
    return this.pendingBytes > (this.options.backpressureBytes ?? BACKPRESSURE_BYTES);
  }

  public get liveEvaluation(): LiveEvaluation {
    return this.live;
  }

  /**
   * Creates the run directory and writes everything that does not depend on
   * when recording begins: the configuration snapshots, a manifest with status
   * `created`, and the file headers.
   *
   * Asynchronous, and deliberately separate from {@link begin}: the simulation
   * may keep advancing while storage works, and the run's start instant must be
   * the instant the observer is attached, not some moment during a file write.
   */
  public async prepare(): Promise<void> {
    if (this.state !== 'created' || this.runLocation !== null) {
      throw new Error(`Run ${this.runId} has already been prepared`);
    }
    const location = await this.storage.createRun(this.runId);
    this.runLocation = this.storage.runPath(this.runId) ?? location.path;
    this.timerResolutionMs = measureTimerResolutionMs();

    await this.storage.writeAtomic(
      this.runId,
      RUN_FILES.scenario,
      `${JSON.stringify(this.options.config, null, 2)}\n`,
    );
    await this.storage.writeAtomic(
      this.runId,
      RUN_FILES.algorithm,
      `${JSON.stringify(this.options.algorithmConfig, null, 2)}\n`,
    );
    await this.writeManifest();
    await this.storage.append(this.runId, RUN_FILES.events, '');
    await this.storage.append(this.runId, RUN_FILES.telemetry, `${telemetryHeader()}\n`);
    await this.storage.append(this.runId, RUN_FILES.evaluation, `${evaluationHeader()}\n`);
  }

  /**
   * Starts recording, synchronously, at the engine's current instant.
   *
   * Attach the recorder to the loop in the same synchronous block, so no frame
   * can fall between the start instant and the first observation. The manifest
   * is rewritten with status `running` through the ordered write queue, ahead of
   * any sample: a process that dies mid-run leaves a directory that says so.
   *
   * @param autonomyActive whether a tracker is already flying the mount. If it
   *   is, autonomy is recorded as engaged from this instant, which is where the
   *   frame-rate window starts.
   */
  public begin({ autonomyActive }: { autonomyActive: boolean }): void {
    if (this.state !== 'created' || this.runLocation === null) {
      throw new Error(`Run ${this.runId} must be prepared, and not yet started`);
    }
    this.startTime = this.engine.time;
    this.state = 'running';
    this.queueWrite(() => this.writeManifest(), 0);

    this.recordEvent('experiment-started', {
      runId: this.runId,
      scenarioFingerprint: fingerprint(this.options.config),
    });
    if (autonomyActive) this.recordEvent('autonomy-enabled', { alreadyEngaged: true });
  }

  /** {@link prepare} then {@link begin}, for a harness whose engine is not running meanwhile. */
  public async start(options: { autonomyActive: boolean }): Promise<void> {
    await this.prepare();
    this.begin(options);
    await this.drain();
  }

  /**
   * Appends one event.
   *
   * @param time the engineering instant the event describes. Defaults to the
   *   engine's current time. Events are recorded in non-decreasing time order;
   *   an out-of-order timestamp is a bug in the caller and is refused rather
   *   than written into a log whose ordering is part of its contract.
   */
  public recordEvent(
    type: ExperimentEventType,
    detail: EventDetail = {},
    time: number = this.engine.time,
  ): void {
    if (this.state !== 'running') return;
    if (time < this.lastEventTime) {
      throw new RangeError(
        `Event ${type} at ${String(time)} s precedes the previous event at ${String(this.lastEventTime)} s`,
      );
    }
    for (const [key, value] of Object.entries(detail)) {
      if (typeof value === 'number' && !Number.isFinite(value)) {
        throw new RangeError(`Event ${type} detail ${key} is not finite`);
      }
    }

    const event: ExperimentEvent = {
      sequence: this.sequence,
      simulationTime: time,
      tick: this.engine.tick,
      type,
      detail,
    };
    this.sequence += 1;
    this.lastEventTime = time;
    this.eventsRecorded += 1;
    this.eventBatch.push(JSON.stringify(event));
    if (this.eventBatch.length >= BATCH_ROWS) this.flushFile('events');
  }

  // --- LoopObserver ---------------------------------------------------------

  public onSensorFrame(_frameId: number, captureTime: number): void {
    if (this.state !== 'running') return;
    this.sensorFramesGenerated += 1;
    this.lastGeneratedCaptureTime = captureTime;
  }

  /**
   * Frames generated with capture time in [start, end).
   *
   * Every frame generated while recording was captured after the start instant
   * and no later than the end instant, so only a frame captured exactly at the
   * end can fall outside the half-open window.
   */
  private framesInWindow(): number {
    return this.endTime !== null && this.lastGeneratedCaptureTime >= this.endTime
      ? this.sensorFramesGenerated - 1
      : this.sensorFramesGenerated;
  }

  public onCommandApplied(applied: AppliedCommandObservation): void {
    this.recordEvent(
      'command-applied',
      {
        commandId: applied.commandId,
        issuedAt: applied.issuedAt,
        dueAt: applied.dueAt,
        appliedAt: applied.appliedAt,
        frameId: applied.frameId,
        captureTime: applied.captureTime,
      },
      applied.appliedAt,
    );
  }

  /**
   * Records one processed frame: the events it implies, one safe telemetry row
   * and one privileged evaluation row.
   */
  public onFrameProcessed(observation: LoopObservation): void {
    if (this.state !== 'running') return;

    const { frame, output, gimbal, timings, command } = observation;
    const time = observation.issueTime;
    const mode = output.pat.mode;
    const debug = (output.debug ?? {}) as Record<string, unknown>;
    const detection = output.observations[0]?.centroid ?? null;
    const estimate = output.estimates[0] ?? null;
    const candidates = integerOr(debug['candidateCount'], output.observations.length);
    const misses = output.pat.consecutiveMisses;

    // --- Events, from changes only.
    if (mode !== this.lastMode) {
      this.emitModeEvents(this.lastMode, mode, frame.frameId);
      this.lastMode = mode;
    }
    const hasCandidate = candidates > 0;
    if (hasCandidate && !this.lastHadCandidate) {
      this.recordEvent('candidate-detected', {
        frameId: frame.frameId,
        captureTime: frame.captureTime,
        candidateCount: candidates,
        patState: mode,
      });
    }
    this.lastHadCandidate = hasCandidate;
    if (mode === 'track' && misses > 0 && this.lastMisses === 0) {
      this.recordEvent('detection-missed', { frameId: frame.frameId, patState: mode });
    }
    this.lastMisses = misses;
    for (const [axis, now, before] of [
      ['pan', gimbal.azimuthSaturation, this.lastPanSaturation],
      ['tilt', gimbal.elevationSaturation, this.lastTiltSaturation],
    ] as const) {
      if (now === 'travel-limit' && before !== 'travel-limit') {
        this.recordEvent('mechanical-limit', { axis, frameId: frame.frameId });
      }
    }
    this.lastPanSaturation = gimbal.azimuthSaturation;
    this.lastTiltSaturation = gimbal.elevationSaturation;
    if (command !== null) {
      this.recordEvent(
        'command-issued',
        {
          commandId: command.commandId,
          frameId: frame.frameId,
          captureTime: frame.captureTime,
          issuedAt: command.issuedAt,
          azimuthRad: command.azimuth,
          elevationRad: command.elevation,
        },
        command.issuedAt,
      );
    }

    // --- Safe telemetry.
    const telemetry: TelemetrySample = {
      frame_id: frame.frameId,
      frame_capture_time_s: frame.captureTime,
      command_issue_time_s: time,
      tick: this.engine.tick,
      pat_state: mode,
      candidate_count: candidates,
      components_found: integerOr(debug['componentsFound'], candidates),
      centroid_x_px: detection === null ? null : detection.x,
      centroid_y_px: detection === null ? null : detection.y,
      candidate_score: nullableNumber(debug['candidateScore']),
      filtered_azimuth_rad: estimate === null ? null : estimate.bearing.azimuth,
      filtered_elevation_rad: estimate === null ? null : estimate.bearing.elevation,
      filtered_azimuth_rate_rad_s: estimate === null ? null : estimate.bearingRate.azimuth,
      filtered_elevation_rate_rad_s: estimate === null ? null : estimate.bearingRate.elevation,
      pid_pan_correction_rad: mode === 'track' ? nullableNumber(debug['panCorrection']) : null,
      pid_tilt_correction_rad: mode === 'track' ? nullableNumber(debug['tiltCorrection']) : null,
      command_id: command?.commandId ?? null,
      commanded_pan_rad: command?.azimuth ?? null,
      commanded_tilt_rad: command?.elevation ?? null,
      measured_pan_rad: gimbal.azimuth,
      measured_tilt_rad: gimbal.elevation,
      measured_pan_rate_rad_s: gimbal.azimuthRate,
      measured_tilt_rate_rad_s: gimbal.elevationRate,
      pan_saturation: gimbal.azimuthSaturation,
      tilt_saturation: gimbal.elevationSaturation,
      consecutive_misses: misses,
      search_waypoint_index: nullableInteger(debug['searchWaypointIndex']),
      host_world_step_ms: timings.worldStepMs,
      host_sensor_frame_ms: timings.sensorFrameMs,
      host_algorithm_ms: timings.algorithmMs,
      host_detector_ms: timings.stages.detector,
      host_bearing_transform_ms: timings.stages['bearing-transform'],
      host_estimator_ms: timings.stages.estimator,
      host_controller_ms: timings.stages.controller,
      host_orchestration_ms: timings.orchestrationMs,
      track_quality: nullableNumber(debug['trackQuality']),
      acquisition_evidence: nullableNumber(debug['acquisitionEvidence']),
      innovation_nis: nullableNumber(debug['innovationNis']),
      gate_accepted:
        typeof debug['gateAccepted'] === 'boolean' ? (debug['gateAccepted'] ? 1 : 0) : null,
      imm_cv_probability: nullableNumber(debug['immCvProbability']),
      imm_ca_probability: nullableNumber(debug['immCaProbability']),
      filtered_azimuth_accel_rad_s2: nullableNumber(debug['azimuthAcceleration']),
      filtered_elevation_accel_rad_s2: nullableNumber(debug['elevationAcceleration']),
      angular_sigma_rad: nullableNumber(debug['angularSigma']),
      prediction_horizon_s: nullableNumber(debug['predictionHorizon']),
      predicted_azimuth_rad: nullableNumber(debug['predictedAzimuth']),
      predicted_elevation_rad: nullableNumber(debug['predictedElevation']),
      feedforward_pan_rad: nullableNumber(debug['feedforwardPan']),
      feedforward_tilt_rad: nullableNumber(debug['feedforwardTilt']),
      recovery_age_s: nullableNumber(debug['recoveryAge']),
      local_search_radius_rad: nullableNumber(debug['localSearchRadius']),
      handoff_dwell_s: nullableNumber(debug['handoffDwell']),
    };
    this.telemetryBatch.push(telemetryRow(telemetry));
    this.telemetryRows += 1;

    // --- Privileged evaluation, at the frame's own capture instant.
    const evaluation = this.evaluator.sample(
      frame.frameId,
      frame.captureTime,
      mode,
      detection === null ? null : { x: detection.x, y: detection.y },
    );
    this.evaluationBatch.push(evaluationRow(evaluation));
    this.evaluationRows += 1;

    // --- Live readout, from the sample just written.
    const conditionMet = lockConditionMet(evaluation, this.metricsConfig);
    const locked = this.liveLock.push(
      evaluation.capture_time_s,
      conditionMet,
      isTrackable(evaluation, this.metricsConfig),
    );
    this.live = {
      angularPointingErrorRad: evaluation.truth_angular_pointing_error_rad,
      imagePointingErrorPx: evaluation.truth_image_pointing_error_px,
      lockConditionMet: conditionMet,
      locked,
      retention: this.liveLock.currentRetention,
      framesProcessed: this.telemetryRows,
    };

    if (this.telemetryBatch.length >= BATCH_ROWS) this.flushAll();
  }

  /**
   * Maps a PAT mode change onto the event vocabulary.
   *
   * Generic over algorithms: the baseline's SEARCH/TRACK/LOST and AstraLock-X's
   * SEARCH/ACQUIRE/TRACK/RECOVER/HANDOFF both map here, so historical baseline
   * runs record exactly the events they always did.
   */
  private emitModeEvents(from: string | null, to: string, frameId: number): void {
    // The first frame a recording sees establishes the state; it is a change
    // only if that state is the start of a search. Joining a run mid-track is
    // not a track entry.
    if (from === null) {
      if (to === 'scan') this.recordEvent('search-started', { frameId });
      return;
    }
    if (from === 'handoff' && to !== 'handoff') {
      this.recordEvent('handoff-lost', { to, frameId });
    }
    if (to === 'scan') {
      this.recordEvent('search-reentered', { from, frameId });
    } else if (to === 'acquire') {
      this.recordEvent('acquire-entered', { from, frameId });
    } else if (to === 'reacquire') {
      this.recordEvent('recover-entered', { from, frameId });
    } else if (to === 'handoff') {
      this.recordEvent('handoff-ready', { from, frameId });
    } else if (to === 'track') {
      if (from === 'reacquire') this.recordEvent('reacquired', { frameId });
      // Returning from handoff-ready is not a new track entry.
      if (from !== 'handoff') this.recordEvent('track-entered', { from, frameId });
    } else if (to === 'lost') {
      if (from === 'track') {
        // The algorithm's own declaration. The evaluator's view of lock is
        // derived from the evaluation file, not logged here.
        this.recordEvent('lock-lost', { declaredBy: 'algorithm', frameId });
      }
      this.recordEvent('lost-entered', { from, frameId });
    }
  }

  // --- Lifecycle ------------------------------------------------------------

  /**
   * Finalises: flushes, computes the summary **from the stored files**, renders
   * the report from them, and only then marks the run completed.
   *
   * @throws if persistence failed at any point; the run is then marked failed
   *   and no summary is claimed.
   */
  public async complete(
    reason: TerminationReason = 'operator-finalised',
  ): Promise<ExperimentSummary> {
    await this.end(reason, 'experiment-completed');

    // Until the final manifest lands, the run reads as incomplete on disk.
    try {
      const summary = await summariseStoredRun(this.storage, this.runId);
      await this.storage.writeAtomic(
        this.runId,
        RUN_FILES.summary,
        `${JSON.stringify(summary, null, 2)}\n`,
      );
      await this.storage.writeAtomic(
        this.runId,
        RUN_FILES.report,
        await renderStoredReport(this.storage, this.runId, summary),
      );
      this.state = 'completed';
      await this.writeManifest();
      return summary;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.markFailed('writer-error', message);
      await this.writeManifest().catch(() => undefined);
      throw new Error(`Experiment ${this.runId} could not be finalised: ${message}`, {
        cause: error,
      });
    }
  }

  /**
   * Ends a run without treating it as a result.
   *
   * The whole raw record is kept for inspection, but no summary or report is
   * written: a summary.json in an aborted run's folder would read as a finding
   * to anyone who opened the folder rather than the application.
   */
  public async abort(reason: TerminationReason = 'operator-aborted'): Promise<void> {
    await this.end(reason, 'experiment-aborted');
    this.state = 'aborted';
    await this.writeManifest();
  }

  /** Marks the run failed and records why, as far as storage still allows. */
  public async fail(message: string, reason: TerminationReason = 'runtime-error'): Promise<void> {
    if (this.state !== 'running' && this.state !== 'created') return;
    this.recordEvent('experiment-failed', { message, reason });
    this.flushAll();
    await this.drain();
    this.markFailed(reason, message);
    await this.writeManifest().catch(() => undefined);
  }

  /** Waits for every queued write. */
  public async drain(): Promise<void> {
    let chain: Promise<void>;
    do {
      chain = this.writeChain;
      await chain;
    } while (chain !== this.writeChain);
  }

  private async end(reason: TerminationReason, event: ExperimentEventType): Promise<void> {
    if (this.state === 'failed') {
      throw new Error(
        `Experiment ${this.runId} failed to persist: ${this.writerError ?? 'unknown'}`,
      );
    }
    if (this.state !== 'running') {
      throw new Error(`Run ${this.runId} is ${this.state}, not running`);
    }
    this.recordEvent(event, { reason });
    this.endTime = this.engine.time;
    this.endStateHash = this.engine.stateHash();
    this.terminationReason = reason;
    this.endedAt = (this.options.now?.() ?? new Date()).toISOString();

    this.flushAll();
    await this.drain();
    if (this.writerError !== null) {
      throw new Error(`Experiment ${this.runId} failed to persist: ${this.writerError}`);
    }
    // The end time and frame count must be on disk before the summary is
    // computed, because the summary is computed from disk.
    await this.writeManifest();
  }

  private markFailed(reason: TerminationReason, message: string): void {
    this.state = 'failed';
    this.terminationReason ??= reason;
    this.writerError ??= message;
    this.endTime ??= this.engine.time;
    this.endedAt ??= (this.options.now?.() ?? new Date()).toISOString();
    this.eventBatch = [];
    this.telemetryBatch = [];
    this.evaluationBatch = [];
  }

  // --- Writing --------------------------------------------------------------

  private flushAll(): void {
    this.flushFile('events');
    this.flushFile('telemetry');
    this.flushFile('evaluation');
  }

  private flushFile(which: 'events' | 'telemetry' | 'evaluation'): void {
    const batch =
      which === 'events'
        ? this.eventBatch
        : which === 'telemetry'
          ? this.telemetryBatch
          : this.evaluationBatch;
    if (batch.length === 0) return;
    const payload = `${batch.join('\n')}\n`;
    if (which === 'events') this.eventBatch = [];
    else if (which === 'telemetry') this.telemetryBatch = [];
    else this.evaluationBatch = [];
    this.queue(RUN_FILES[which], payload);
  }

  /**
   * Adds a write to the serial chain.
   *
   * Serial because appends must land in order. A failure is captured rather
   * than thrown into the caller, which is inside the control loop: the loop
   * must keep running. The recorder instead stops recording at once and reports
   * the error, so no later sample can be written into a log with a hole in it.
   */
  private queue(fileName: string, payload: string): void {
    this.queueWrite(() => this.storage.append(this.runId, fileName, payload), payload.length);
  }

  private queueWrite(write: () => Promise<void>, bytes: number): void {
    this.pendingBytes += bytes;
    this.writeChain = this.writeChain.then(async () => {
      try {
        if (this.writerError === null) {
          await write();
          this.bytesWritten += bytes;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (this.state === 'running') {
          this.markFailed('writer-error', message);
          this.options.onFailure?.(message);
          // Best effort: say so on disk too, so the run lists as FAILED rather
          // than INCOMPLETE. If the manifest cannot be written either, the
          // directory still reads as incomplete — which is also not a result.
          await this.writeManifest().catch(() => undefined);
        }
        this.writerError ??= message;
      } finally {
        this.pendingBytes -= bytes;
      }
    });
  }

  private manifest(): ExperimentManifest {
    const config = this.options.config;
    const intrinsics = resolveIntrinsics(config.camera);
    const designated = this.options.designatedTargetIndex ?? 0;
    return {
      schemaVersion: EXPERIMENT_SCHEMA_VERSION,
      metricsDefinitionVersion: this.metricsConfig.definitionVersion,
      runId: this.runId,
      status: this.state,
      terminationReason: this.terminationReason,
      scenarioId: this.options.scenarioId,
      scenarioName: config.name,
      scenarioSeed: config.seed,
      algorithmId: this.options.algorithmId,
      algorithmVersion: this.options.algorithmVersion,
      scenarioFingerprint: fingerprint(config),
      algorithmFingerprint: fingerprint(this.options.algorithmConfig),
      metricsFingerprint: fingerprint(this.metricsConfig),
      metricsConfig: this.metricsConfig,
      designatedTargetIndex: designated,
      designatedTargetLabel: config.targets[designated]?.label ?? '',
      targetCount: config.targets.length,
      simulationTimestepSeconds: 1 / config.tickRate,
      tickRate: config.tickRate,
      camera: {
        width: config.camera.width,
        height: config.camera.height,
        frameRate: config.camera.frameRate,
        horizontalFovRad: config.camera.horizontalFov,
        principalPointXPx: intrinsics.cx,
        principalPointYPx: intrinsics.cy,
      },
      gimbal: {
        commandLatencySeconds: config.gimbal.commandLatency,
        panMinRad: config.gimbal.pan.minAngle,
        panMaxRad: config.gimbal.pan.maxAngle,
        tiltMinRad: config.gimbal.tilt.minAngle,
        tiltMaxRad: config.gimbal.tilt.maxAngle,
        panMaxRateRadS: config.gimbal.pan.maxRate,
        tiltMaxRateRadS: config.gimbal.tilt.maxRate,
      },
      startSimulationTime: this.startTime,
      endSimulationTime: this.endTime,
      endStateHash: this.endStateHash,
      sensorFramesGenerated: this.endTime === null ? null : this.framesInWindow(),
      artifacts: ARTIFACT_CLASSIFICATION,
      host: {
        createdAt: this.createdAt,
        endedAt: this.endedAt,
        platform: this.options.platform,
        applicationVersion: this.options.applicationVersion,
        sourceCommit: this.options.sourceCommit,
        sourceTreeModified: this.options.sourceTreeModified ?? null,
        timerResolutionMs: this.timerResolutionMs,
      },
    };
  }

  private async writeManifest(): Promise<void> {
    await this.storage.writeAtomic(
      this.runId,
      RUN_FILES.manifest,
      `${JSON.stringify(this.manifest(), null, 2)}\n`,
    );
  }
}

const nullableNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const nullableInteger = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) ? value : null;

const integerOr = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isInteger(value) ? value : fallback;

/**
 * The smallest non-zero step of `performance.now()`, in milliseconds.
 *
 * Sampled before recording begins, never inside the control loop. Bounded to a
 * few milliseconds of busy-waiting; returns `null` if no step was seen.
 */
export function measureTimerResolutionMs(): number | null {
  let smallest = Number.POSITIVE_INFINITY;
  let previous = performance.now();
  const deadline = previous + 25;
  let steps = 0;
  while (steps < 64) {
    const now = performance.now();
    if (now > previous) {
      smallest = Math.min(smallest, now - previous);
      steps += 1;
      previous = now;
    }
    if (now > deadline) break;
  }
  return Number.isFinite(smallest) ? smallest : null;
}

/** Distinguishes runs started inside the same second. */
let runCounter = 0;

/**
 * A run id.
 *
 * Time-ordered so a directory listing sorts chronologically, with a counter so
 * two runs started in the same second cannot collide. It identifies a
 * *recording*; the experiment's identity lives in the fingerprints.
 */
export function generateRunId(now: Date): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
  runCounter = (runCounter + 1) % 0x10000;
  return `run-${stamp}-${runCounter.toString(16).padStart(4, '0')}`;
}
