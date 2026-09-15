/**
 * UI state for the simulation, and the loop that drives it.
 *
 * The store does **not** hold the world. It holds a reference to the
 * authoritative {@link SimulationEngine}, plus the derived values the interface
 * needs to draw. Every mutation goes through the engine; the store only
 * observes. That direction is what keeps the simulation reproducible when the
 * interface changes, and it is enforced by lint: `src/core` cannot import this
 * module, or React, or Three.js.
 *
 * The driving loop lives here rather than inside a React component so that the
 * simulation does not stop when a component unmounts, and so nothing about the
 * world depends on the render tree.
 */

import { create } from 'zustand';

import type { DisturbanceConfig } from '@/core/contracts/disturbance';
import { type SimulationConfig, parseSimulationConfig } from '@/core/contracts/simulation';
import {
  type PlaybackSpeed,
  type PlaybackStatus,
  PlaybackScheduler,
} from '@/core/simulation/clock';
import { SimulationEngine } from '@/core/simulation/engine';
import {
  type ObserverFrame,
  type RenderVec3,
  buildObserverFrame,
  buildTrajectoryPaths,
  interpolateObserverFrame,
} from '@/core/simulation';
import type { CameraSensorFrame } from '@/core/contracts/sensors';
import type { ActuatorTruth } from '@/core/gimbal/actuator-truth';
import { VirtualCameraSensor } from '@/core/sensors/virtual-camera';
import { ClosedLoopRuntime } from '@/core/runtime/closed-loop';
import {
  DEFAULT_ASTRALOCK_CONFIG,
  DEFAULT_BASELINE_PAT_CONFIG,
  algorithmById,
  astraLockXPat,
  baselineKfPidPat,
} from '@/core/algorithms';
import type { AstraLockConfig, AstraLockDebug } from '@/core/algorithms';
import type { BaselineDebug } from '@/core/algorithms';
import type { Measurement } from '@/core/contracts/measurement';
import type { PATMode } from '@/core/contracts/pat';
import {
  DEFAULT_METRICS_CONFIG,
  Evaluator,
  ExperimentRecorder,
  createStorage,
  type RecorderStatus,
  type TerminationReason,
} from '@/core/experiments';
import { readAppInfo } from '@/lib/app-info';
import type { SensorCapture } from '@/core/sensors/virtual-camera';
import type { SensorEvaluationTruth } from '@/core/sensors/sensor-truth';
import { ExactWorldSampler } from '@/core/sensors/world-sampler';
import { DEFAULT_SCENARIO_ID, type ScenarioId, loadScenario } from '@/scenarios';

/** Everything one loaded scenario needs at runtime. */
interface Session {
  readonly engine: SimulationEngine;
  readonly scheduler: PlaybackScheduler;
  readonly sensor: VirtualCameraSensor;
  readonly sampler: ExactWorldSampler;
  readonly labels: readonly string[];
  readonly paths: readonly (readonly RenderVec3[])[];
  /** Simulated time the sensor has already been asked for frames up to. */
  capturedThrough: number;
  /** Newest frame index rasterized, so the viewfinder can re-render it. */
  lastFrameIndex: number;
  /**
   * The capture whose lease the store currently holds.
   *
   * Exactly one at a time: replacing it releases the previous, which is what
   * keeps the pool from filling up during a long session.
   */
  heldCapture: SensorCapture | null;
  /**
   * The autonomous loop, or `null` while the operator is flying the mount.
   *
   * Built lazily when autonomy is first switched on and torn down when it is
   * switched off, so a manual session carries none of its state.
   */
  runtime: ClosedLoopRuntime | null;
  /** Which algorithm this session's runtime was built with. */
  algorithmId: string;
  /**
   * Whether the operator has switched coded beacon identity on.
   *
   * Defaults to on for a scenario whose designated beacon carries a code and is
   * inert otherwise, so loading a Phase 7 scenario behaves exactly as it did
   * before identity existed.
   */
  identityEnabled: boolean;
  /** The experiment recorder, or `null` when nothing is being recorded. */
  recorder: ExperimentRecorder | null;
  /**
   * Privileged evaluator for the live EVALUATION panel when nothing is
   * recording.
   *
   * Only ever read by the interface, never by the algorithm. The lint barrier
   * makes `@/core/experiments` unreachable from the tracking side, so this
   * reference cannot become a path back in.
   */
  evaluator: Evaluator;
}

/**
 * The live EVALUATION readout.
 *
 * While recording, it comes from the recorder's own evaluation samples, with
 * the dwell and grace of the coarse-lock definition applied. Otherwise it is
 * an instantaneous reading, and the quantities that need a history — confirmed
 * lock, retention, frames processed — are `null` rather than guessed.
 */
export interface LiveEvaluationReadout {
  readonly source: 'recording' | 'instantaneous';
  readonly angularPointingErrorRad: number | null;
  readonly imagePointingErrorPx: number | null;
  readonly lockConditionMet: boolean;
  readonly locked: boolean | null;
  readonly retention: number | null;
  readonly framesProcessed: number | null;
}

/** One point of the command-versus-measured trace. */
export interface ResponseSample {
  readonly time: number;
  readonly commandedPan: number;
  readonly measuredPan: number;
  readonly commandedTilt: number;
  readonly measuredTilt: number;
}

/**
 * Points kept in the response trace.
 *
 * Bounded on purpose: this is actuator diagnostics, not a recorder, and an
 * unbounded history is a leak that only shows up after a long run.
 */
const RESPONSE_HISTORY_LIMIT = 600;

export interface SimulationStoreState {
  /** Scenario id when a bundled scenario is loaded, `null` after a file import. */
  readonly scenarioId: ScenarioId | null;
  readonly config: SimulationConfig;
  readonly status: PlaybackStatus;
  readonly speed: PlaybackSpeed;
  /** Authoritative tick. Mirrored here purely so the HUD can render it. */
  readonly tick: number;
  readonly time: number;
  /** Frame at the previous tick, for interpolation. */
  readonly previousFrame: ObserverFrame;
  readonly currentFrame: ObserverFrame;
  /** Sub-tick fraction for the renderer. Visualisation only. */
  readonly alpha: number;
  readonly paths: readonly (readonly RenderVec3[])[];
  /** Message from the last failed scenario import, or `null`. */
  readonly importError: string | null;

  /** Newest camera frame, or `null` before the first capture. */
  readonly sensorFrame: CameraSensorFrame | null;
  /**
   * Privileged per-frame evaluation record.
   *
   * Held here only so the debug overlay can draw it. It is a separate object
   * from the frame and is never passed anywhere a tracking algorithm could
   * reach; the lint barrier stops tracking-side code importing its type at all.
   */
  readonly sensorTruth: SensorEvaluationTruth | null;
  /** Privileged truth overlay. Off by default. */
  readonly showTruthOverlay: boolean;
  readonly framesScheduled: number;
  readonly framesRasterized: number;
  readonly framesSupersededForDisplay: number;

  /** What the operator asked for. */
  readonly commandedPan: number;
  readonly commandedTilt: number;
  /** What the encoder reports. Not the same thing. */
  readonly measuredPan: number;
  readonly measuredTilt: number;
  readonly measuredPanRate: number;
  readonly measuredTiltRate: number;
  readonly servoPhase: 'active' | 'settling' | 'holding';
  readonly commandsPending: number;
  readonly panAtLimit: boolean;
  readonly tiltAtLimit: boolean;
  readonly panRateSaturated: boolean;
  readonly tiltRateSaturated: boolean;
  readonly lastCommandClamped: boolean;
  /** Privileged actuator interior, for the debug panel. */
  readonly actuatorTruth: ActuatorTruth | null;
  readonly showActuatorTruth: boolean;
  readonly responseHistory: readonly ResponseSample[];

  /** Whether the tracking algorithm is flying the mount. */
  readonly autonomyEnabled: boolean;
  /** Identifier of the algorithm in command. */
  readonly algorithmId: string;
  /** PAT mode, read from the algorithm itself. Never a decoration. */
  readonly patMode: PATMode | null;
  /** The algorithm's own safe diagnostics, or `null` when it is not running. */
  readonly algorithmDebug: BaselineDebug | AstraLockDebug | null;
  /**
   * Signal-to-noise ratio of the current detection, as the algorithm reported
   * it, or `null` when there is no detection. The sensor has no noise model, so
   * this reads "Not modelled" — never a number.
   */
  readonly detectionSnr: Measurement | null;
  /** Draw the algorithm's detections on the sensor feed. */
  readonly showAlgorithmOverlay: boolean;
  /**
   * Whether the tracker is configured to recognise the beacon by its code.
   *
   * A property of the *tracker's configuration*, not of the world. Turning it
   * off is the control arm of the identity comparison and reproduces Phase 7
   * behaviour exactly.
   */
  readonly identityEnabled: boolean;
  /**
   * Whether the loaded scenario has a coded beacon to recognise at all.
   *
   * False for every scenario written before Phase 8. Identity is offered only
   * where it means something: switched on against an unmodulated beacon, the
   * tracker would correctly refuse to acquire anything, which is a confusing
   * way to present "this scenario cannot demonstrate the feature".
   */
  readonly identityAvailable: boolean;
  /**
   * Operator override: manual pointing while autonomy is engaged.
   *
   * Off by default, so a human cannot silently fight the controller. Turning it
   * on is an explicit act and is visible on screen.
   */
  readonly manualOverride: boolean;

  /**
   * The current recording's status, or the last one's after it ended, or
   * `null` if nothing has been recorded this session.
   */
  readonly recorderStatus: RecorderStatus | null;
  /** True while a recording is being started, finalised or aborted. */
  readonly recorderBusy: boolean;
  /** Message from the last recording failure, or `null`. */
  readonly recorderError: string | null;
  /** Message from the last closed-loop runtime failure, or `null`. */
  readonly runtimeError: string | null;
  /**
   * Whether the live EVALUATION readout is computed and shown.
   *
   * Hideable, because the autonomous system must be demonstrable with no truth
   * assistance on screen at all. When hidden it is not computed either.
   */
  readonly showLiveEvaluation: boolean;
  /** Whether the privileged disturbance realization readout is shown. */
  readonly showDisturbanceTruth: boolean;
  /** Whether the privileged world-truth inspector column is shown. */
  readonly showGroundTruthInspector: boolean;
  /** Frames the sensor failed to deliver so far in this run. */
  readonly framesDropped: number;
  /** Live figures from ground truth, or `null` when hidden. Never routed to the algorithm. */
  readonly liveEvaluation: LiveEvaluationReadout | null;

  loadScenarioById: (id: ScenarioId) => void;
  loadConfig: (config: SimulationConfig, scenarioId?: ScenarioId | null) => void;
  setImportError: (message: string | null) => void;
  start: () => void;
  pause: () => void;
  resume: () => void;
  reset: () => void;
  stepOnce: () => void;
  setSpeed: (speed: PlaybackSpeed) => void;
  /** Advances by one wall-clock frame. Called by the driver loop. */
  advance: (elapsedSeconds: number) => void;

  /** Issues a position command. The mount responds over simulated time. */
  setCameraPose: (azimuth: number, elevation: number) => void;
  /** Issues a command relative to the current setpoint. */
  nudgeCamera: (deltaAzimuth: number, deltaElevation: number) => void;
  /** Commands the mount back to the scenario's configured pointing. */
  resetCamera: () => void;
  setTruthOverlay: (visible: boolean) => void;
  setActuatorTruthVisible: (visible: boolean) => void;

  /** Hands the mount to the algorithm, or takes it back. */
  setAutonomy: (enabled: boolean) => void;
  /** Immediately disengages autonomy and pauses the run. */
  emergencyStop: () => void;
  setAlgorithmOverlay: (visible: boolean) => void;
  /** Chooses which tracker flies the mount. Ends any recording in progress. */
  setAlgorithm: (id: string) => void;
  setManualOverride: (enabled: boolean) => void;
  /**
   * Switches coded identity on or off, rebuilding the tracker.
   *
   * The tracker's configuration cannot change under a running estimator, so the
   * runtime is rebuilt and the algorithm starts from nothing — the same rule
   * that governs swapping algorithms mid-run.
   */
  setIdentityEnabled: (enabled: boolean) => void;

  /** Begins recording. Resolves once the run directory exists and recording has begun. */
  startExperiment: () => Promise<void>;
  /** Finalises: computes the summary and the report from the files, marks the run completed. */
  finaliseExperiment: (reason?: TerminationReason) => Promise<void>;
  /** Ends the recording without treating it as a result. */
  abortExperiment: (reason?: TerminationReason) => Promise<void>;
  setLiveEvaluation: (visible: boolean) => void;
  setDisturbanceTruthVisible: (visible: boolean) => void;
  setGroundTruthInspectorVisible: (visible: boolean) => void;
  /**
   * Replaces the scenario's disturbances, rebuilding the world.
   *
   * Refused while a recording is open: changing the physics under an experiment
   * would splice two different worlds into one record.
   */
  setDisturbances: (disturbances: DisturbanceConfig) => void;
  /** Whether an experiment is currently recording. */
  isRecording: () => boolean;
}

/**
 * The live session.
 *
 * Held outside the store's state on purpose: the engine is a mutable object, and
 * putting it in reactive state would invite a component to treat it as a value
 * to be replaced rather than a service to be called.
 */
let session: Session | null = null;

/**
 * What the autonomous loop last produced, waiting to be drawn.
 *
 * The runtime calls back synchronously while it holds a borrowed frame lease,
 * and a Zustand `set` from inside that callback would re-render React in the
 * middle of the control loop. So the result is parked here and picked up by
 * whichever store action is driving, after the loop has finished with it.
 */
let pendingDisplayFrame: CameraSensorFrame | null = null;
let pendingDisplayTruth: SensorEvaluationTruth | null = null;
let pendingOutput: {
  pat: { mode: PATMode };
  debug: unknown;
  observations: readonly { snr: Measurement }[];
} | null = null;

/**
 * Builds the autonomous runtime for a session, observed by the recorder if one
 * is running.
 *
 * Starting or stopping a recording later does **not** rebuild the runtime: it
 * attaches or detaches the observer, so the algorithm's filter, scan and state
 * machine carry on untouched. Rebuilding would construct a fresh algorithm
 * instance, and ending a recording would then reset the tracker it recorded.
 */
function buildRuntime(active: Session): ClosedLoopRuntime {
  return new ClosedLoopRuntime({
    engine: active.engine,
    sensor: active.sensor,
    sampler: active.sampler,
    plugin: selectedPlugin(active.algorithmId),
    config: selectedConfig(active.algorithmId, active.engine.config, active.identityEnabled),
    historyLimit: 256,
    // Where the sensor has already been read to. Zero when autonomy is being
    // enabled on a fresh session, non-zero when the operator swaps algorithms
    // mid-run: the replacement must pick the frame stream up where the world
    // actually is rather than rewinding to the start.
    capturedThrough: active.capturedThrough,
    ...(active.recorder === null ? {} : { observer: active.recorder }),
    // The interface's only connection to the loop: it is told what happened,
    // after the fact, and copies the frame it wants to draw.
    onFrame: (capture, output) => {
      pendingDisplayFrame = capture.toOwned();
      pendingDisplayTruth = capture.truth;
      pendingOutput = output;
    },
  });
}

/**
 * Whether the operator is allowed to command the mount right now.
 *
 * While the algorithm is flying, manual commands are refused unless the
 * operator has explicitly taken override. Two controllers issuing setpoints to
 * one servo is not shared control, it is a fight, and the mount would sit
 * wherever the last command landed with neither party understanding why.
 */
function canCommandManually(state: SimulationStoreState): boolean {
  return !state.autonomyEnabled || state.manualOverride;
}

/**
 * The two shipped algorithms, by id.
 *
 * The baseline stays available as a scientific control: a comparison needs both
 * arms, and the robust algorithm's numbers mean nothing without it.
 */
const ALGORITHM_CONFIGS: Record<string, unknown> = {
  [baselineKfPidPat.manifest.id]: DEFAULT_BASELINE_PAT_CONFIG,
  [astraLockXPat.manifest.id]: DEFAULT_ASTRALOCK_CONFIG,
};

const selectedPlugin = (id: string) => algorithmById(id) ?? baselineKfPidPat;

/**
 * The signalling pattern the designated beacon is configured to send, if any.
 *
 * **This is a configuration path, not a channel into the algorithm.** A real
 * terminal is told what its partner will transmit before the link is attempted,
 * the same way a radio is set to a frequency; the application plays that role
 * here by reading the scenario the operator loaded. What crosses is a sequence
 * of ones and zeros and a symbol duration — the same two numbers that would be
 * written on a mission card.
 *
 * What does **not** cross is any fact about the world: no position, no emitter
 * id, no target index, nothing that changes during the run, and nothing about
 * any other source in the scene. The tracker still has to find the pattern in
 * pixels, and still cannot tell which object it is looking at.
 */
function configuredIdentityCode(
  config: SimulationConfig,
): { sequence: readonly (0 | 1)[]; symbolDuration: number } | null {
  // The designated target: index 0, the same one the evaluator scores against.
  const code = config.targets[0]?.beacon?.identityCode ?? null;
  if (code === null || !code.enabled) return null;
  return { sequence: code.sequence, symbolDuration: code.symbolDuration };
}

/** Whether this scenario can demonstrate coded identity at all. */
const scenarioHasCode = (config: SimulationConfig): boolean =>
  configuredIdentityCode(config) !== null;

/**
 * The algorithm's configuration for a session.
 *
 * Identity is off unless the operator has switched it on *and* the loaded
 * scenario carries a coded beacon. Both conditions matter: with identity on,
 * acquisition requires a positive recognition, so switching it on against an
 * unmodulated beacon would correctly — and uselessly — refuse to acquire
 * anything at all.
 */
function selectedConfig(id: string, config: SimulationConfig, identityOn: boolean): unknown {
  const base = ALGORITHM_CONFIGS[id] ?? DEFAULT_BASELINE_PAT_CONFIG;
  if (id !== astraLockXPat.manifest.id) return base;

  const code = identityOn ? configuredIdentityCode(config) : null;
  const astra = base as AstraLockConfig;
  return code === null
    ? { ...astra, identity: { ...astra.identity, enabled: false } }
    : {
        ...astra,
        identity: {
          ...astra.identity,
          enabled: true,
          expectedSequence: code.sequence,
          symbolDuration: code.symbolDuration,
        },
      };
}

/** Drains the parked result into the shape the store stores. */
function drainAutonomousFrame(): Partial<SimulationStoreState> {
  if (pendingDisplayFrame === null) return {};
  const update: Partial<SimulationStoreState> = {
    sensorFrame: pendingDisplayFrame,
    sensorTruth: pendingDisplayTruth,
    patMode: pendingOutput?.pat.mode ?? null,
    algorithmDebug: (pendingOutput?.debug ?? null) as BaselineDebug | AstraLockDebug | null,
    detectionSnr: pendingOutput?.observations[0]?.snr ?? null,
  };
  pendingDisplayFrame = null;
  pendingDisplayTruth = null;
  pendingOutput = null;
  return update;
}

function createSession(config: SimulationConfig): Session {
  const engine = new SimulationEngine(config);
  return {
    engine,
    scheduler: new PlaybackScheduler({ tickRate: config.tickRate }),
    sensor: new VirtualCameraSensor({ config }),
    // Exact sampling: capture times fall between physics ticks, and the world
    // is a pure function of time, so there is nothing to approximate.
    sampler: new ExactWorldSampler(engine),
    labels: config.targets.map((target) => target.label),
    paths: buildTrajectoryPaths(engine),
    // Before -1 so the frame at t = 0 is due on the first advance.
    capturedThrough: -1,
    lastFrameIndex: 0,
    heldCapture: null,
    runtime: null,
    algorithmId: baselineKfPidPat.manifest.id,
    // On by default where it means something, so loading a coded scenario
    // demonstrates the capability without the operator having to find a switch.
    identityEnabled: scenarioHasCode(config),
    recorder: null,
    evaluator: new Evaluator({ engine, config }),
  };
}

/** Replaces the held capture, releasing the previous lease. */
function holdCapture(active: Session, capture: SensorCapture): void {
  active.heldCapture?.release();
  active.heldCapture = capture;
}

function requireSession(): Session {
  if (session === null) throw new Error('No simulation session is loaded');
  return session;
}

/** The engine, for the ground-truth debug inspector. */
export function activeEngine(): SimulationEngine {
  return requireSession().engine;
}

type SessionSnapshot = Pick<
  SimulationStoreState,
  | 'tick'
  | 'time'
  | 'currentFrame'
  | 'previousFrame'
  | 'alpha'
  | 'status'
  | 'speed'
  | 'sensorFrame'
  | 'sensorTruth'
  | 'framesScheduled'
  | 'framesRasterized'
  | 'framesSupersededForDisplay'
  | 'framesDropped'
  | 'commandedPan'
  | 'commandedTilt'
  | 'measuredPan'
  | 'measuredTilt'
  | 'measuredPanRate'
  | 'measuredTiltRate'
  | 'servoPhase'
  | 'commandsPending'
  | 'panAtLimit'
  | 'tiltAtLimit'
  | 'panRateSaturated'
  | 'tiltRateSaturated'
  | 'lastCommandClamped'
  | 'actuatorTruth'
>;

function snapshotState(active: Session): SessionSnapshot {
  const frame = buildObserverFrame(active.engine.snapshot(), active.labels);

  // A capture at the current instant, so the viewfinder shows the scene before
  // the run starts rather than an empty rectangle.
  const capture = active.sensor.captureFrame(active.sampler, active.lastFrameIndex);
  holdCapture(active, capture);

  return {
    tick: active.engine.tick,
    time: active.engine.time,
    currentFrame: frame,
    previousFrame: frame,
    alpha: 0,
    status: active.scheduler.status,
    speed: active.scheduler.speed,
    sensorFrame: capture.frame,
    sensorTruth: capture.truth,
    framesScheduled: active.sensor.framesScheduled,
    framesRasterized: active.sensor.framesRasterized,
    framesSupersededForDisplay: active.sensor.framesSupersededForDisplay,
    framesDropped: active.sensor.framesDropped,
    ...actuatorState(active),
  };
}

/**
 * The live EVALUATION readout, or nothing when it is hidden.
 *
 * Ground truth, shown under an EVALUATION label for the operator only. When the
 * panel is hidden nothing is computed, so a demonstration with it hidden is a
 * demonstration with no truth anywhere on screen.
 */
function liveEvaluation(
  active: Session,
  visible: boolean,
  patMode: PATMode | null,
): Pick<SimulationStoreState, 'liveEvaluation'> {
  if (!visible) return { liveEvaluation: null };

  const recorder = active.recorder;
  if (recorder?.isRecording === true) {
    return { liveEvaluation: { source: 'recording', ...recorder.liveEvaluation } };
  }

  const config = DEFAULT_METRICS_CONFIG;
  const frame = active.evaluator.at(active.engine.time);
  return {
    liveEvaluation: {
      source: 'instantaneous',
      angularPointingErrorRad: frame.angularPointingError,
      imagePointingErrorPx: frame.imagePointingError,
      lockConditionMet:
        frame.angularPointingError !== null &&
        frame.angularPointingError <= config.lockErrorThresholdRad &&
        frame.targetWithinTravel &&
        frame.targetRange !== null &&
        frame.targetRange <= config.maxTrackableRangeM &&
        patMode === 'track',
      locked: null,
      retention: null,
      framesProcessed: null,
    },
  };
}

/**
 * Detaches the recorder from the session and the loop, in one synchronous step.
 *
 * Called before a recording is ended, so no frame can arrive after its end
 * instant while finalisation is writing files.
 */
function detachRecorder(active: Session): ExperimentRecorder | null {
  const recorder = active.recorder;
  active.recorder = null;
  active.runtime?.observe(null);
  return recorder;
}

/** Everything the interface shows about the mount, read from the actuator. */
function actuatorState(
  active: Session,
): Pick<
  SimulationStoreState,
  | 'commandedPan'
  | 'commandedTilt'
  | 'measuredPan'
  | 'measuredTilt'
  | 'measuredPanRate'
  | 'measuredTiltRate'
  | 'servoPhase'
  | 'commandsPending'
  | 'panAtLimit'
  | 'tiltAtLimit'
  | 'panRateSaturated'
  | 'tiltRateSaturated'
  | 'lastCommandClamped'
  | 'actuatorTruth'
> {
  const gimbal = active.engine.gimbal;
  const measured = gimbal.measuredPointing();
  const axes = gimbal.axisStates();
  const lastApplied = gimbal.lastApplied;

  // The setpoint is what the servo is chasing; a command still in flight has
  // not changed it yet, so the operator sees their request only once it is due.
  const pendingLatest = gimbal.pendingCommands.at(-1)?.command;

  return {
    commandedPan: pendingLatest?.requestedPan ?? axes.pan.setpoint,
    commandedTilt: pendingLatest?.requestedTilt ?? axes.tilt.setpoint,
    measuredPan: measured.panAngle,
    measuredTilt: measured.tiltAngle,
    measuredPanRate: measured.derivedPanRate,
    measuredTiltRate: measured.derivedTiltRate,
    servoPhase: gimbal.servoPhase(1 / active.engine.config.tickRate),
    commandsPending: gimbal.pendingCommands.length,
    panAtLimit: axes.pan.flags.atMinLimit || axes.pan.flags.atMaxLimit,
    tiltAtLimit: axes.tilt.flags.atMinLimit || axes.tilt.flags.atMaxLimit,
    panRateSaturated: axes.pan.flags.rateSaturated,
    tiltRateSaturated: axes.tilt.flags.rateSaturated,
    lastCommandClamped: (lastApplied?.panClamped ?? false) || (lastApplied?.tiltClamped ?? false),
    actuatorTruth: gimbal.truth(),
  };
}

/** Appends a point to the bounded command-versus-measured trace. */
function appendResponse(
  history: readonly ResponseSample[],
  active: Session,
  state: ReturnType<typeof actuatorState>,
): readonly ResponseSample[] {
  const next = [
    ...history,
    {
      time: active.engine.time,
      commandedPan: state.commandedPan,
      measuredPan: state.measuredPan,
      commandedTilt: state.commandedTilt,
      measuredTilt: state.measuredTilt,
    },
  ];
  return next.length > RESPONSE_HISTORY_LIMIT
    ? next.slice(next.length - RESPONSE_HISTORY_LIMIT)
    : next;
}

const initialConfig = loadScenario(DEFAULT_SCENARIO_ID);
const initialSession = createSession(initialConfig);
session = initialSession;

export const useSimulationStore = create<SimulationStoreState>()((set, get) => ({
  scenarioId: DEFAULT_SCENARIO_ID,
  config: initialConfig,
  paths: initialSession.paths,
  importError: null,
  showTruthOverlay: false,
  showActuatorTruth: false,
  responseHistory: [],
  autonomyEnabled: false,
  algorithmId: baselineKfPidPat.manifest.id,
  patMode: null,
  algorithmDebug: null,
  detectionSnr: null,
  showAlgorithmOverlay: true,
  identityEnabled: initialSession.identityEnabled,
  identityAvailable: scenarioHasCode(initialSession.engine.config),
  manualOverride: false,
  recorderStatus: null,
  recorderBusy: false,
  recorderError: null,
  runtimeError: null,
  showLiveEvaluation: true,
  // Off by default, like the other privileged readouts: an operator should have
  // to ask to see the answer key.
  showDisturbanceTruth: false,
  // Off by default, like every other privileged readout. It shows the answer
  // key — true target position, true bearing, random stream cursors — and an
  // operator should have to ask for it rather than have it on screen while
  // judging whether the tracker is working.
  showGroundTruthInspector: false,
  liveEvaluation: null,
  ...snapshotState(initialSession),

  loadScenarioById: (id) => {
    get().loadConfig(loadScenario(id), id);
  },

  loadConfig: (config, scenarioId = null) => {
    stopDriver();
    // A recording belongs to the world it was recording. Replacing that world
    // ends it, honestly, as aborted: there is no result to report.
    if (session !== null && session.recorder !== null) {
      void endRecording(session, 'abort', 'scenario-changed');
    }
    const wasAutonomous = get().autonomyEnabled;
    const chosenAlgorithm = get().algorithmId;
    session = createSession(config);
    // A new world does not change which tracker the operator picked. The
    // session is rebuilt around the new scenario, so the choice has to be
    // carried across explicitly or it silently reverts to the default.
    session.algorithmId = chosenAlgorithm;
    set({
      scenarioId,
      config,
      identityEnabled: session.identityEnabled,
      identityAvailable: scenarioHasCode(config),
      paths: session.paths,
      importError: null,
      runtimeError: null,
      ...liveEvaluation(session, get().showLiveEvaluation, null),
      responseHistory: [],
      patMode: null,
      algorithmDebug: null,
      detectionSnr: null,
      ...snapshotState(session),
    });
    // A new scenario keeps the operator's choice about who is flying, but the
    // algorithm starts from nothing: its filter, its scan and its state machine
    // belong to the run that just ended.
    if (wasAutonomous) get().setAutonomy(true);
  },

  setImportError: (message) => {
    set({ importError: message });
  },

  start: () => {
    const active = requireSession();
    active.scheduler.start();
    active.recorder?.recordEvent('simulation-started');
    set({ status: active.scheduler.status });
    startDriver();
  },

  pause: () => {
    const active = requireSession();
    active.scheduler.pause();
    stopDriver();
    active.recorder?.recordEvent('simulation-paused');
    set({ status: active.scheduler.status });
  },

  resume: () => {
    const active = requireSession();
    active.scheduler.resume();
    active.recorder?.recordEvent('simulation-started', { resumed: true });
    set({ status: active.scheduler.status });
    startDriver();
  },

  reset: () => {
    const active = requireSession();
    // A reset would rewind the world underneath an open recording, leaving a
    // run whose samples come from two different experiments. The recording is
    // ended honestly instead, as aborted by the reset. The interface asks the
    // operator first; this is what happens if they go ahead.
    if (active.recorder !== null) {
      void endRecording(active, 'abort', 'simulation-reset');
    }
    stopDriver();
    active.engine.reset();
    active.scheduler.reset();
    active.runtime?.reset();
    active.heldCapture?.release();
    active.heldCapture = null;
    active.sensor.reset();
    active.capturedThrough = -1;
    active.lastFrameIndex = 0;
    pendingDisplayFrame = null;
    pendingDisplayTruth = null;
    pendingOutput = null;
    set({
      ...snapshotState(active),
      ...liveEvaluation(active, get().showLiveEvaluation, null),
      runtimeError: null,
      responseHistory: [],
      patMode: null,
      algorithmDebug: null,
      detectionSnr: null,
    });
  },

  stepOnce: () => {
    // Single-stepping implies not running: advancing one tick while the loop is
    // also advancing would make "one tick" mean something else.
    const active = requireSession();
    active.scheduler.hold();
    stopDriver();

    const previous = buildObserverFrame(active.engine.snapshot(), active.labels);

    let sensorUpdate: Partial<SimulationStoreState> = {};

    if (active.runtime !== null) {
      if (!stepRuntime(active, 1)) return;
      active.capturedThrough = active.engine.time;
      sensorUpdate = drainAutonomousFrame();
      if (sensorUpdate.sensorFrame != null) {
        active.lastFrameIndex = sensorUpdate.sensorFrame.frameId;
      }
    } else {
      active.engine.step(1);
      // The frame captured here is the one that gets shown. Calling the
      // snapshot helper instead would rasterize the same instant a second time,
      // inflate the frame counters, and leak this lease.
      const capturedTo = active.engine.time;
      const result = active.sensor.captureLatest(
        active.sampler,
        active.capturedThrough,
        capturedTo,
      );
      active.capturedThrough = capturedTo;

      if (result.capture !== null) {
        holdCapture(active, result.capture);
        active.lastFrameIndex = result.capture.frame.frameId;
        sensorUpdate = { sensorFrame: result.capture.frame, sensorTruth: result.capture.truth };
      }
    }

    const current = buildObserverFrame(active.engine.snapshot(), active.labels);

    const actuator = actuatorState(active);
    checkRecorderHealth(active);

    set({
      tick: active.engine.tick,
      time: active.engine.time,
      previousFrame: previous,
      currentFrame: current,
      alpha: 0,
      status: active.scheduler.status,
      speed: active.scheduler.speed,
      framesScheduled: active.sensor.framesScheduled,
      framesRasterized: active.sensor.framesRasterized,
      framesSupersededForDisplay: active.sensor.framesSupersededForDisplay,
      framesDropped: active.sensor.framesDropped,
      ...sensorUpdate,
      ...actuator,
      ...liveEvaluation(active, get().showLiveEvaluation, sensorUpdate.patMode ?? get().patMode),
      recorderStatus: active.recorder?.status ?? get().recorderStatus,
      responseHistory: appendResponse(get().responseHistory, active, actuator),
    });
  },

  setSpeed: (speed) => {
    const active = requireSession();
    active.scheduler.setSpeed(speed);
    set({ speed });
  },

  setCameraPose: (azimuth, elevation) => {
    // Issues a command. It does not move anything: the mount responds over
    // simulated time, and while the run is paused nothing mechanical changes at
    // all. That is the whole difference from the ideal mount this replaced.
    const active = requireSession();
    if (!canCommandManually(get())) return;
    active.engine.gimbal.commandPosition(azimuth, elevation);
    set(actuatorState(active));
  },

  nudgeCamera: (deltaAzimuth, deltaElevation) => {
    const active = requireSession();
    if (!canCommandManually(get())) return;
    active.engine.gimbal.nudge(deltaAzimuth, deltaElevation);
    set(actuatorState(active));
  },

  resetCamera: () => {
    const active = requireSession();
    if (!canCommandManually(get())) return;
    const gimbal = active.engine.config.gimbal;
    active.engine.gimbal.commandPosition(gimbal.pan.initialAngle, gimbal.tilt.initialAngle);
    set(actuatorState(active));
  },

  setTruthOverlay: (visible) => {
    set({ showTruthOverlay: visible });
  },

  setActuatorTruthVisible: (visible) => {
    set({ showActuatorTruth: visible });
  },

  setAutonomy: (enabled) => {
    const active = requireSession();

    if (!enabled) {
      // Handing back to the operator. The mount keeps whatever setpoint it was
      // last given and continues under its own physics — it does not snap
      // anywhere, because nothing physical changed.
      //
      // A recording measures the autonomous tracker, so its measurement window
      // ends here: it is finalised with that reason. Anything after this would
      // be the operator's flying, not the algorithm's.
      if (active.recorder !== null && active.runtime !== null) {
        active.recorder.recordEvent('autonomy-disabled');
        void endRecording(active, 'complete', 'autonomy-disabled');
      }
      active.runtime?.dispose();
      active.runtime = null;
      set({
        autonomyEnabled: false,
        manualOverride: false,
        patMode: null,
        algorithmDebug: null,
        detectionSnr: null,
      });
      return;
    }

    // Built first, so it inherits the watermark as it stands. The distinction
    // matters at tick zero: `-1` means no frame has been taken yet and the
    // frame at t = 0 is still to come, whereas `0` would mean it had already
    // been consumed and the runtime would skip it.
    active.runtime = buildRuntime(active);
    active.recorder?.recordEvent('autonomy-enabled');

    // The runtime drives the sensor from here, so the store's own capture
    // bookkeeping must not also claim frames.
    active.capturedThrough = active.engine.time;
    set({
      autonomyEnabled: true,
      runtimeError: null,
      manualOverride: false,
      patMode: null,
      algorithmDebug: null,
      detectionSnr: null,
    });
  },

  emergencyStop: () => {
    const active = requireSession();
    active.scheduler.pause();
    stopDriver();
    get().setAutonomy(false);
    set({ status: active.scheduler.status });
  },

  setAlgorithmOverlay: (visible) => {
    set({ showAlgorithmOverlay: visible });
  },

  setIdentityEnabled: (enabled) => {
    const active = requireSession();
    if (active.identityEnabled === enabled) return;

    // Same rule as changing the algorithm: the tracker's configuration is part
    // of what a recording is a record of, so a run cannot span both settings.
    if (active.recorder !== null) {
      set({ recorderError: 'Recording stopped: beacon identity was switched mid-run.' });
      void active.recorder.abort('algorithm-changed');
      active.recorder = null;
      set({ recorderStatus: null });
    }

    active.identityEnabled = enabled;
    if (active.runtime !== null) active.runtime = buildRuntime(active);
    set({ identityEnabled: enabled, patMode: null, algorithmDebug: null });
  },

  setManualOverride: (enabled) => {
    // An operator taking the mount mid-run changes what the run measures, so a
    // recording says when it happened.
    requireSession().recorder?.recordEvent('operator-override', { engaged: enabled });
    set({ manualOverride: enabled });
  },

  startExperiment: async () => {
    const active = requireSession();
    if (active.recorder !== null || get().recorderBusy) return;

    const info = readAppInfo();
    const recordedPlugin = selectedPlugin(active.algorithmId);
    const recorder = new ExperimentRecorder({
      storage: createStorage(),
      engine: active.engine,
      config: active.engine.config,
      scenarioId: get().scenarioId,
      // The tracker the operator actually chose. Recording the baseline's id
      // for an AstraLock-X run would mislabel the experiment, and the label is
      // most of what makes two runs comparable.
      algorithmId: recordedPlugin.manifest.id,
      algorithmVersion: recordedPlugin.manifest.version,
      algorithmConfig: selectedConfig(
        active.algorithmId,
        active.engine.config,
        active.identityEnabled,
      ),
      metricsConfig: DEFAULT_METRICS_CONFIG,
      // Lets the evaluator render the noiseless reference frames that image
      // SNR is measured against.
      sampler: active.sampler,
      applicationVersion: info.version,
      sourceCommit: info.sourceCommit,
      sourceTreeModified: info.sourceTreeModified,
      platform: typeof navigator === 'undefined' ? 'unknown' : navigator.userAgent,
      // Surfaced at once, not on the next step: the run may be paused.
      onFailure: () => {
        if (session !== null && session.recorder === recorder) checkRecorderHealth(session);
      },
    });

    set({ recorderBusy: true, recorderError: null });
    try {
      await recorder.prepare();
    } catch (error) {
      // Nothing is being recorded. Say so rather than showing a run id for a
      // run that does not exist.
      set({
        recorderBusy: false,
        recorderStatus: null,
        recorderError: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    // The world may have been replaced while storage was working. A recording
    // of a session that no longer exists is not started at all.
    if (session !== active) {
      set({ recorderBusy: false, recorderError: 'The scenario changed before recording began.' });
      return;
    }

    // Recording begins *before* autonomy is the intended order: search and
    // acquisition are the most interesting part of a PAT run, and a recorder
    // started after the tracker would miss the interval the acquisition metrics
    // measure. Begin and attach happen in one synchronous block, so no frame can
    // fall between the start instant and the first observation.
    recorder.begin({ autonomyActive: active.runtime !== null });
    active.recorder = recorder;
    active.runtime?.observe(recorder);
    // The readout now describes this recording, which has no samples yet —
    // not whatever the previous one last showed.
    set({
      recorderBusy: false,
      recorderStatus: recorder.status,
      ...liveEvaluation(active, get().showLiveEvaluation, get().patMode),
    });
  },

  finaliseExperiment: async (reason = 'operator-finalised') => {
    await endRecording(requireSession(), 'complete', reason);
  },

  abortExperiment: async (reason = 'operator-aborted') => {
    await endRecording(requireSession(), 'abort', reason);
  },

  setAlgorithm: (id) => {
    const active = requireSession();
    if (active.algorithmId === id) return;

    // Changing the tracker mid-recording would splice two different experiments
    // into one record, so the run is ended honestly first. The operator is told
    // rather than silently losing the recording.
    if (active.recorder !== null) {
      set({ recorderError: 'Recording stopped: the algorithm was changed mid-run.' });
      void active.recorder.abort('algorithm-changed');
      active.recorder = null;
      set({ recorderStatus: null });
    }

    active.algorithmId = id;
    // The runtime holds the plugin, so switching means rebuilding it. The
    // engine, sensor and mount are untouched: the physical run continues.
    if (active.runtime !== null) active.runtime = buildRuntime(active);

    set({ algorithmId: id, patMode: null, algorithmDebug: null });
  },

  setDisturbanceTruthVisible: (visible) => {
    set({ showDisturbanceTruth: visible });
  },

  setGroundTruthInspectorVisible: (visible) => {
    set({ showGroundTruthInspector: visible });
  },

  setDisturbances: (disturbances) => {
    const active = requireSession();
    if (active.recorder !== null) {
      set({
        recorderError:
          'Disturbances cannot change while an experiment is recording: the run would span two different worlds.',
      });
      return;
    }
    // Parsed rather than trusted, exactly as a scenario from disk is. A value
    // typed into a form is no more validated than one read off a file.
    const parsed = parseSimulationConfig({ ...active.engine.config, disturbances });
    get().loadConfig(parsed, get().scenarioId);
  },

  setLiveEvaluation: (visible) => {
    const active = requireSession();
    set({ showLiveEvaluation: visible, ...liveEvaluation(active, visible, get().patMode) });
  },

  isRecording: () => session?.recorder?.isRecording === true,

  advance: (elapsedSeconds) => {
    const active = requireSession();

    // Recorder backpressure: the disk is behind. Do not advance the simulation
    // this frame, and do not bank the wall-clock time either. The run slows
    // down in wall-clock terms and is otherwise unchanged; no sample is dropped.
    if (active.recorder?.backpressured === true) {
      set({ recorderStatus: active.recorder.status });
      return;
    }

    const budget = active.scheduler.advance(elapsedSeconds);

    if (budget.ticks === 0) {
      set({ alpha: budget.alpha });
      return;
    }

    const previous = get().currentFrame;

    // Two ways to advance, and which one runs is the difference between the
    // operator flying the mount and the algorithm flying it.
    //
    // Under autonomy the runtime owns the sensor: it steps the world frame by
    // frame, hands every frame to the algorithm in capture order, and issues
    // the commands. The display then copies whatever the last frame was. Under
    // manual control the store drives the sensor itself and rasterises only the
    // newest frame due, because a viewer can look at one image.
    let sensorUpdate: Partial<SimulationStoreState> = {};

    if (active.runtime !== null) {
      if (!stepRuntime(active, budget.ticks)) return;
      active.capturedThrough = active.engine.time;
      sensorUpdate = drainAutonomousFrame();
      if (sensorUpdate.sensorFrame != null) {
        active.lastFrameIndex = sensorUpdate.sensorFrame.frameId;
      }
    } else {
      active.engine.step(budget.ticks);
      const capturedTo = active.engine.time;
      const result = active.sensor.captureLatest(
        active.sampler,
        active.capturedThrough,
        capturedTo,
      );
      active.capturedThrough = capturedTo;

      if (result.capture !== null) {
        holdCapture(active, result.capture);
        active.lastFrameIndex = result.capture.frame.frameId;
        sensorUpdate = { sensorFrame: result.capture.frame, sensorTruth: result.capture.truth };
      }
    }

    const current = buildObserverFrame(active.engine.snapshot(), active.labels);

    const actuator = actuatorState(active);

    set({
      tick: active.engine.tick,
      time: active.engine.time,
      previousFrame: previous,
      currentFrame: current,
      alpha: budget.alpha,
      framesScheduled: active.sensor.framesScheduled,
      framesRasterized: active.sensor.framesRasterized,
      framesSupersededForDisplay: active.sensor.framesSupersededForDisplay,
      framesDropped: active.sensor.framesDropped,
      ...sensorUpdate,
      ...actuator,
      ...liveEvaluation(active, get().showLiveEvaluation, sensorUpdate.patMode ?? get().patMode),
      recorderStatus: active.recorder?.status ?? get().recorderStatus,
      responseHistory: appendResponse(get().responseHistory, active, actuator),
    });

    checkRecorderHealth(active);

    if (active.engine.isComplete) {
      active.scheduler.pause();
      stopDriver();
      set({ status: active.scheduler.status });
      if (active.recorder !== null) {
        active.recorder.recordEvent('simulation-completed');
        void endRecording(active, 'complete', 'scenario-duration-reached');
      }
    }
  },
}));

/**
 * Steps the autonomous runtime, containing a failure.
 *
 * An exception from the loop stops the run where it is and is shown to the
 * operator. A recording in progress is marked failed with the message, rather
 * than being left running or finalised as if nothing had happened.
 *
 * @returns whether the step succeeded.
 */
function stepRuntime(active: Session, ticks: number): boolean {
  try {
    active.runtime!.step(ticks);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    active.scheduler.pause();
    stopDriver();
    useSimulationStore.setState({ status: active.scheduler.status, runtimeError: message });
    const recorder = detachRecorder(active);
    if (recorder !== null) {
      void recorder.fail(message, 'runtime-error').finally(() => {
        useSimulationStore.setState({ recorderStatus: recorder.status, recorderError: message });
      });
    }
    return false;
  }
}

/**
 * Notices a recorder that failed mid-run.
 *
 * A write failure stops the recorder at once; this detaches it and surfaces the
 * error. The control loop is not touched.
 */
function checkRecorderHealth(active: Session): void {
  const recorder = active.recorder;
  if (recorder === null || recorder.status.state !== 'failed') return;
  detachRecorder(active);
  useSimulationStore.setState({
    recorderStatus: recorder.status,
    recorderError: recorder.status.writerError,
  });
}

/**
 * Ends the active recording, however it is ending.
 *
 * The recorder is detached synchronously first, so its end instant is exactly
 * now; the files are then finished asynchronously while the interface shows the
 * recording as busy.
 */
async function endRecording(
  active: Session,
  kind: 'complete' | 'abort',
  reason: TerminationReason,
): Promise<void> {
  const recorder = detachRecorder(active);
  if (recorder === null) return;
  const store = useSimulationStore;
  store.setState({ recorderBusy: true, recorderStatus: recorder.status });
  try {
    if (kind === 'complete') await recorder.complete(reason);
    else await recorder.abort(reason);
    store.setState({ recorderError: null });
  } catch (error) {
    store.setState({ recorderError: error instanceof Error ? error.message : String(error) });
  } finally {
    const state = store.getState();
    store.setState({
      recorderBusy: false,
      recorderStatus: recorder.status,
      ...(session === active
        ? liveEvaluation(active, state.showLiveEvaluation, state.patMode)
        : {}),
    });
  }
}

// --- Driver loop ------------------------------------------------------------

let frameHandle: number | null = null;
let lastFrameTime = 0;

/** Longest wall-clock delta a single frame may report, in seconds. */
const MAX_FRAME_DELTA = 0.25;

function startDriver(): void {
  if (frameHandle !== null || typeof requestAnimationFrame === 'undefined') return;

  lastFrameTime = performance.now();
  const onFrame = (now: number): void => {
    // Wall-clock time decides how many ticks to run. It never reaches the
    // world: the engine only ever advances by whole fixed steps.
    //
    // Clamped at zero because the delta really can come out negative. The
    // argument is the instant the browser began the frame, which may precede
    // the `performance.now()` read that started the driver — press play partway
    // through a frame and the first callback looks like about a millisecond of
    // travel backwards. Unclamped, `advance` rejects it, and the throw escapes
    // before the next frame is scheduled, so playback stops for good. A zero
    // delta is the honest reading: no time has passed, so no tick is due.
    const elapsed = Math.min(Math.max(now - lastFrameTime, 0) / 1000, MAX_FRAME_DELTA);
    lastFrameTime = now;
    useSimulationStore.getState().advance(elapsed);
    frameHandle = requestAnimationFrame(onFrame);
  };
  frameHandle = requestAnimationFrame(onFrame);
}

function stopDriver(): void {
  if (frameHandle === null || typeof cancelAnimationFrame === 'undefined') return;
  cancelAnimationFrame(frameHandle);
  frameHandle = null;
}

/** The frame to draw, blended across the current sub-tick fraction. */
export function interpolatedFrame(state: SimulationStoreState): ObserverFrame {
  return interpolateObserverFrame(state.previousFrame, state.currentFrame, state.alpha);
}
