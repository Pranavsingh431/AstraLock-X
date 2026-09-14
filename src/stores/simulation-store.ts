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
import { DEFAULT_SCENARIO_ID, type ScenarioId, loadScenario } from '@/scenarios';

/** Everything one loaded scenario needs at runtime. */
interface Session {
  readonly engine: SimulationEngine;
  readonly scheduler: PlaybackScheduler;
  readonly labels: readonly string[];
  readonly paths: readonly (readonly RenderVec3[])[];
}

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
    labels: config.targets.map((target) => target.label),
    paths: buildTrajectoryPaths(engine),
  };
}

function requireSession(): Session {
  if (session === null) throw new Error('No simulation session is loaded');
  return session;
}

/** The engine, for the ground-truth debug inspector. */
export function activeEngine(): SimulationEngine {
  return requireSession().engine;
}

function snapshotState(
  active: Session,
): Pick<
  SimulationStoreState,
  'tick' | 'time' | 'currentFrame' | 'previousFrame' | 'alpha' | 'status' | 'speed'
> {
  const frame = buildObserverFrame(active.engine.snapshot(), active.labels);
  return {
    tick: active.engine.tick,
    time: active.engine.time,
    currentFrame: frame,
    previousFrame: frame,
    alpha: 0,
    status: active.scheduler.status,
    speed: active.scheduler.speed,
  };
}

const initialConfig = loadScenario(DEFAULT_SCENARIO_ID);
const initialSession = createSession(initialConfig);
session = initialSession;

export const useSimulationStore = create<SimulationStoreState>()((set, get) => ({
  scenarioId: DEFAULT_SCENARIO_ID,
  config: initialConfig,
  paths: initialSession.paths,
  importError: null,
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
    set(snapshotState(active));
  },

  stepOnce: () => {
    // Single-stepping implies not running: advancing one tick while the loop is
    // also advancing would make "one tick" mean something else.
    const active = requireSession();
    active.scheduler.hold();
    stopDriver();

    const previous = buildObserverFrame(active.engine.snapshot(), active.labels);
    active.engine.step(1);

    set({
      ...snapshotState(active),
      previousFrame: previous,
      status: active.scheduler.status,
    });
  },

  setSpeed: (speed) => {
    const active = requireSession();
    active.scheduler.setSpeed(speed);
    set({ speed });
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

    set({
      tick: active.engine.tick,
      time: active.engine.time,
      previousFrame: previous,
      currentFrame: current,
      alpha: budget.alpha,
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
