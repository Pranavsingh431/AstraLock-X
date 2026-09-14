/**
 * The tracking algorithm interface.
 *
 * This is the seam AstraLock-X is built around: anything implementing
 * `AlgorithmPlugin` can be dropped into the same harness, run against the same
 * scenarios and scored on the same metrics, which is what makes comparison
 * between algorithms meaningful.
 *
 * The interface is deliberately narrow. An algorithm receives a frame, the
 * camera configuration and the measured gimbal state, and returns detections,
 * track estimates and a gimbal command. It is given no target positions, no
 * target identities and no view of the future — not by convention, but because
 * the types it is handed cannot carry them:
 *
 *   - `TrackingInput` is proved ground-truth-free at compile time by the
 *     assertions at the bottom of this file, which fail the build if any field
 *     ever gains a tainted type;
 *   - `defineAlgorithm` rejects a plugin whose own config or debug type can
 *     reach ground truth — or that it cannot prove otherwise — so a plugin
 *     cannot widen its own surface to smuggle truth in through configuration
 *     or out through debug output;
 *   - `guardTrackingInput` re-checks at runtime, where types are erased.
 *
 * See docs/adr/0003-ground-truth-isolation.md.
 */

import type { z } from 'zod';

import type { ControlCommand } from './control';
import type { TargetEstimate } from './estimation';
import {
  assertGroundTruthFree,
  type AssertGroundTruthFree,
  type GroundTruthReachable,
  type GroundTruthUnprovable,
  type InspectGroundTruth,
  type StaticAssert,
} from './isolation';
import type { PATState } from './pat';
import type { TargetObservation } from './perception';
import type { CameraSensorFrame, CameraState, GimbalState } from './sensors';
import type { Hertz, Milliseconds, Seconds } from './units';

/**
 * Everything an algorithm may observe on one tick.
 *
 * `frame` is `null` when the sensor dropped a frame. An algorithm still gets
 * the tick — a real system has to keep its loop running and coast the estimate
 * through the gap rather than stall.
 */
export interface TrackingInput {
  readonly tick: number;
  /** Simulated time of this tick. */
  readonly time: Seconds;
  /** The captured frame, or `null` if none was delivered this tick. */
  readonly frame: CameraSensorFrame | null;
  /** Camera configuration and believed calibration. */
  readonly camera: CameraState;
  /** Measured gimbal state, carrying quantisation, bias and latency. */
  readonly gimbal: GimbalState;
  /**
   * The command this algorithm issued on the previous tick, echoed back. The
   * gimbal may have clipped it; comparing this against `gimbal` is how an
   * algorithm notices it is asking for more authority than it has.
   */
  readonly previousCommand: ControlCommand | null;
}

/** What an algorithm produces for one tick. */
export interface TrackingOutput<TDebug = unknown> {
  /** Detections extracted from this tick's frame. Empty if no frame arrived. */
  readonly observations: readonly TargetObservation[];
  /** Current belief about every live track. */
  readonly estimates: readonly TargetEstimate[];
  /** Gimbal demand, or `null` to leave the gimbal on its previous command. */
  readonly command: ControlCommand | null;
  /** Current PAT mode, as the algorithm sees it. */
  readonly pat: PATState;
  /**
   * Optional algorithm-defined payload for debug overlays. Bounded by
   * `GroundTruthFree` at the plugin level, so it cannot become a back channel.
   */
  readonly debug: TDebug | null;
}

/** What an algorithm is given once, at construction. */
export interface AlgorithmInit<TConfig = unknown> {
  /** Validated instance of the plugin's own config type. */
  readonly config: TConfig;
  /** Camera configuration for the run. */
  readonly camera: CameraState;
  /** Gimbal state at the start of the run. */
  readonly gimbal: GimbalState;
  /** Rate the harness will call `update` at. */
  readonly tickRate: Hertz;
  /**
   * Seeded uniform generator on [0, 1).
   *
   * Stochastic algorithms — particle filters, randomised search patterns —
   * draw from this rather than `Math.random`, so that a run replays exactly.
   * The stream is derived from the run seed and is independent of the streams
   * the simulator uses, so changing the algorithm cannot perturb the scenario
   * (ADR-0004).
   */
  readonly random: () => number;
  /**
   * Wall-clock budget per tick. Exceeding it is recorded as a result rather
   * than aborting the run: an algorithm that is accurate but too slow for the
   * target hardware is a finding worth reporting.
   */
  readonly tickBudget: Milliseconds;
}

/** A configured, running algorithm. */
export interface AlgorithmInstance<TDebug = unknown> {
  /** Advance one tick. Called at the harness tick rate, in order, without gaps. */
  update(input: TrackingInput): TrackingOutput<TDebug>;
  /** Return to the state it had immediately after construction. */
  reset(): void;
  /** Release any retained resources. Optional. */
  dispose?(): void;
}

/** Identifying and descriptive metadata for a plugin. */
export interface AlgorithmManifest<TConfig = unknown> {
  /** Stable machine identifier, e.g. `centroid-kalman`. Used in summaries. */
  readonly id: string;
  /** Human-readable name for the UI. */
  readonly name: string;
  /** Semantic version, so results can be attributed to an exact implementation. */
  readonly version: string;
  readonly description: string;
  /**
   * Schema for this plugin's config. The harness validates against it before
   * construction, and the Scenario Lab uses it to build a form, which is why a
   * runtime schema is required rather than a type alone.
   */
  readonly configSchema: z.ZodType<TConfig>;
  /** Config used when the operator has not chosen one. */
  readonly defaultConfig: TConfig;
}

/**
 * A pluggable tracking algorithm.
 *
 * The type parameters are unconstrained here on purpose: a bound of the form
 * `TConfig extends GroundTruthFree<TConfig>` is rejected by TypeScript as a
 * circular constraint, and a trailing proof parameter cannot be checked while
 * the parameters are still generic. The equivalent check is applied instead at
 * {@link defineAlgorithm}, which is the point where a plugin actually enters
 * the system and where both parameters are concrete.
 */
export interface AlgorithmPlugin<TConfig = unknown, TDebug = unknown> {
  readonly manifest: AlgorithmManifest<TConfig>;
  /** Construct a fresh instance. Must not retain anything across runs. */
  create(init: AlgorithmInit<TConfig>): AlgorithmInstance<TDebug>;
}

/* eslint-disable @typescript-eslint/no-explicit-any --
 * `any` is used purely as an inference constraint for the two helper types
 * below. Narrower bounds do not work: `AlgorithmPlugin<never, unknown>` would
 * require `defaultConfig: never` and `z.ZodType<never>`, which no real plugin
 * satisfies. No value is ever typed `any`.
 */
/** The config type of a concrete plugin type. */
export type ConfigOf<P> = P extends AlgorithmPlugin<infer TConfig, any> ? TConfig : never;

/** The debug-payload type of a concrete plugin type. */
export type DebugOf<P> = P extends AlgorithmPlugin<any, infer TDebug> ? TDebug : never;

/**
 * Registers a plugin, refusing at compile time to accept one whose own config
 * or debug type can reach ground truth.
 *
 * The second half of the parameter type is a check rather than a value: it is
 * `unknown` — which intersects away to nothing — for a clean plugin, and
 * {@link GroundTruthLeak} for a tainted one, so a tainted plugin's object
 * literal is reported as missing the `__astraLockError` property. Inference
 * still flows from the first half, so callers write nothing extra.
 *
 * This complements, rather than replaces, the lint barrier: the barrier stops
 * an algorithm file from importing the ground-truth module at all, and this
 * stops a tainted type reaching the harness by any other route.
 */
export function defineAlgorithm<P extends AlgorithmPlugin<any, any>>(
  plugin: P & GroundTruthAdmission<ConfigOf<P> | DebugOf<P>, P>,
): P {
  return plugin;
}

/**
 * The admission check applied to a plugin's own type parameters.
 *
 * Resolves to `unknown` — which intersects away to nothing — for a plugin whose
 * config and debug types are provably clean, and to a diagnostic interface
 * otherwise, so the plugin's object literal is reported as missing the
 * `__astraLockError` property.
 *
 * Three outcomes, deliberately:
 *
 *   provably clean -> admitted
 *   reaches truth  -> rejected as GroundTruthReachable
 *   undecidable    -> rejected as GroundTruthUnprovable
 *
 * The third is the fail-closed case. A type the walk could not decide within
 * its budget is refused rather than admitted, because admitting it would mean
 * scoring an algorithm whose inputs were never actually checked.
 */
type GroundTruthAdmission<T, P> = [InspectGroundTruth<T>] extends ['clean']
  ? unknown
  : 'tainted' extends InspectGroundTruth<T>
    ? GroundTruthReachable<P>
    : GroundTruthUnprovable<P>;
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Runtime gate for the plugin boundary.
 *
 * The compile-time proofs below cover code built against these types, but a
 * plugin loaded across a worker boundary has had its types erased, and a
 * harness bug could in principle assemble an input from simulator state. This
 * catches that case where it happens rather than letting it silently score well.
 *
 * @throws {GroundTruthLeakError} if anything reachable from `input` is tainted.
 */
export function guardTrackingInput(input: TrackingInput): TrackingInput {
  return assertGroundTruthFree(input, 'a tracking algorithm');
}

// --- Compile-time isolation proofs ------------------------------------------
//
// These are not tests that someone has to remember to run: they are type
// aliases inside the contract itself. If a future edit gives any field of
// `TrackingInput`, `AlgorithmInit` or `TrackingOutput` a type that can reach
// ground truth, `StaticAssert` fails its constraint and `pnpm typecheck` —
// and therefore CI — fails at this line.

/** Proof that nothing an algorithm receives per tick can carry ground truth. */
export type ProofTrackingInputIsClean = StaticAssert<AssertGroundTruthFree<TrackingInput>>;

/** Proof that nothing an algorithm receives at construction can carry ground truth. */
export type ProofAlgorithmInitIsClean = StaticAssert<AssertGroundTruthFree<AlgorithmInit>>;

/** Proof that an algorithm's output surface cannot carry ground truth back out. */
export type ProofTrackingOutputIsClean = StaticAssert<AssertGroundTruthFree<TrackingOutput>>;
