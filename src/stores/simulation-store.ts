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
}

/**
 * The live session.
 *
 * Held outside the store's state on purpose: the engine is a mutable object, and
 * putting it in reactive state would invite a component to treat it as a value
 * to be replaced rather than a service to be called.
 */
let session: Session | null = null;

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
  ...snapshotState(initialSession),

  loadScenarioById: (id) => {
    get().loadConfig(loadScenario(id), id);
  },

  loadConfig: (config, scenarioId = null) => {
    stopDriver();
    session = createSession(config);
    set({
      scenarioId,
      config,
      paths: session.paths,
      importError: null,
      responseHistory: [],
      ...snapshotState(session),
    });
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
    active.heldCapture?.release();
    active.heldCapture = null;
    active.sensor.reset();
    active.capturedThrough = -1;
    active.lastFrameIndex = 0;
    set({ ...snapshotState(active), responseHistory: [] });
  },

  stepOnce: () => {
    // Single-stepping implies not running: advancing one tick while the loop is
    // also advancing would make "one tick" mean something else.
    const active = requireSession();
    active.scheduler.hold();
    stopDriver();

    const previous = buildObserverFrame(active.engine.snapshot(), active.labels);
    active.engine.step(1);
    const current = buildObserverFrame(active.engine.snapshot(), active.labels);

    // The frame captured here is the one that gets shown. Calling the snapshot
    // helper instead would rasterize the same instant a second time, inflate the
    // frame counters, and leak this lease.
    const capturedTo = active.engine.time;
    const result = active.sensor.captureLatest(active.sampler, active.capturedThrough, capturedTo);
    active.capturedThrough = capturedTo;

    let sensorUpdate: Partial<SimulationStoreState> = {};
    if (result.capture !== null) {
      holdCapture(active, result.capture);
      active.lastFrameIndex = result.capture.frame.frameId;
      sensorUpdate = { sensorFrame: result.capture.frame, sensorTruth: result.capture.truth };
    }

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
    active.engine.gimbal.commandPosition(azimuth, elevation);
    set(actuatorState(active));
  },

  nudgeCamera: (deltaAzimuth, deltaElevation) => {
    const active = requireSession();
    active.engine.gimbal.nudge(deltaAzimuth, deltaElevation);
    set(actuatorState(active));
  },

  resetCamera: () => {
    const active = requireSession();
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

  advance: (elapsedSeconds) => {
    const active = requireSession();
    const budget = active.scheduler.advance(elapsedSeconds);

    if (budget.ticks === 0) {
      set({ alpha: budget.alpha });
      return;
    }

    const previous = get().currentFrame;
    active.engine.step(budget.ticks);
    const current = buildObserverFrame(active.engine.snapshot(), active.labels);

    // The camera runs on its own clock. Only the newest frame due in the
    // interval is rasterized: a viewer can look at one image, so building the
    // ones behind it would cost time and memory to produce something discarded
    // immediately, and would let a slow display accumulate a backlog.
    const capturedTo = active.engine.time;
    const result = active.sensor.captureLatest(active.sampler, active.capturedThrough, capturedTo);
    active.capturedThrough = capturedTo;

    let sensorUpdate: Partial<SimulationStoreState> = {};
    if (result.capture !== null) {
      holdCapture(active, result.capture);
      active.lastFrameIndex = result.capture.frame.frameId;
      sensorUpdate = { sensorFrame: result.capture.frame, sensorTruth: result.capture.truth };
    }

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
