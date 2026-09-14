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

import type { SimulationConfig } from '@/core/contracts/simulation';
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
import { DEFAULT_BASELINE_PAT_CONFIG, baselineKfPidPat } from '@/core/algorithms';
import type { BaselineDebug } from '@/core/algorithms';
import type { PATMode } from '@/core/contracts/pat';
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
  readonly algorithmDebug: BaselineDebug | null;
  /** Draw the algorithm's detections on the sensor feed. */
  readonly showAlgorithmOverlay: boolean;
  /**
   * Operator override: manual pointing while autonomy is engaged.
   *
   * Off by default, so a human cannot silently fight the controller. Turning it
   * on is an explicit act and is visible on screen.
   */
  readonly manualOverride: boolean;

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
  setManualOverride: (enabled: boolean) => void;
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
let pendingOutput: { pat: { mode: PATMode }; debug: unknown } | null = null;

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

/** Drains the parked result into the shape the store stores. */
function drainAutonomousFrame(): Partial<SimulationStoreState> {
  if (pendingDisplayFrame === null) return {};
  const update: Partial<SimulationStoreState> = {
    sensorFrame: pendingDisplayFrame,
    sensorTruth: pendingDisplayTruth,
    patMode: pendingOutput?.pat.mode ?? null,
    algorithmDebug: (pendingOutput?.debug ?? null) as BaselineDebug | null,
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
    ...actuatorState(active),
  };
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
  showAlgorithmOverlay: true,
  manualOverride: false,
  ...snapshotState(initialSession),

  loadScenarioById: (id) => {
    get().loadConfig(loadScenario(id), id);
  },

  loadConfig: (config, scenarioId = null) => {
    stopDriver();
    const wasAutonomous = get().autonomyEnabled;
    session = createSession(config);
    set({
      scenarioId,
      config,
      paths: session.paths,
      importError: null,
      responseHistory: [],
      patMode: null,
      algorithmDebug: null,
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
    set({ status: active.scheduler.status });
    startDriver();
  },

  pause: () => {
    const active = requireSession();
    active.scheduler.pause();
    stopDriver();
    set({ status: active.scheduler.status });
  },

  resume: () => {
    const active = requireSession();
    active.scheduler.resume();
    set({ status: active.scheduler.status });
    startDriver();
  },

  reset: () => {
    const active = requireSession();
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
      responseHistory: [],
      patMode: null,
      algorithmDebug: null,
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
      active.runtime.step(1);
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
      ...sensorUpdate,
      ...actuator,
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
      active.runtime?.dispose();
      active.runtime = null;
      set({
        autonomyEnabled: false,
        manualOverride: false,
        patMode: null,
        algorithmDebug: null,
      });
      return;
    }

    active.runtime = new ClosedLoopRuntime({
      engine: active.engine,
      sensor: active.sensor,
      sampler: active.sampler,
      plugin: baselineKfPidPat,
      config: DEFAULT_BASELINE_PAT_CONFIG,
      historyLimit: 256,
      // The interface's only connection to the loop: it is told what happened,
      // after the fact, and copies the frame it wants to draw.
      onFrame: (capture, output) => {
        pendingDisplayFrame = capture.toOwned();
        pendingDisplayTruth = capture.truth;
        pendingOutput = output;
      },
    });

    // The runtime drives the sensor from here, so the store's own capture
    // bookkeeping must not also claim frames.
    active.capturedThrough = active.engine.time;
    set({
      autonomyEnabled: true,
      manualOverride: false,
      patMode: null,
      algorithmDebug: null,
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

  setManualOverride: (enabled) => {
    set({ manualOverride: enabled });
  },

  advance: (elapsedSeconds) => {
    const active = requireSession();
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
      active.runtime.step(budget.ticks);
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
      ...sensorUpdate,
      ...actuator,
      responseHistory: appendResponse(get().responseHistory, active, actuator),
    });

    if (active.engine.isComplete) {
      active.scheduler.pause();
      stopDriver();
      set({ status: active.scheduler.status });
    }
  },
}));

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
    const elapsed = Math.min((now - lastFrameTime) / 1000, MAX_FRAME_DELTA);
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
