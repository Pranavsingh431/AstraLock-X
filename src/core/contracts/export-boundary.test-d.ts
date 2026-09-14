/**
 * Type-level guard on the public contract surface.
 *
 * Reachability, not just naming: a type here could acquire a ground-truth field
 * indirectly, through a field whose own type changed several modules away.
 * Each assertion below is a standing proof that has not happened.
 */

import { describe, expectTypeOf, it } from 'vitest';

import type {
  AlgorithmInit,
  AlgorithmInstance,
  AlgorithmPlugin,
  CameraSensorFrame,
  CameraState,
  ControlCommand,
  GimbalState,
  PATState,
  SimulationConfig,
  TargetEstimate,
  TargetObservation,
  TrackingInput,
  TrackingOutput,
} from './index';
import type { AssertGroundTruthFree } from './isolation';

describe('public contract surface', () => {
  it('keeps every type an algorithm receives provably ground-truth-free', () => {
    expectTypeOf<AssertGroundTruthFree<TrackingInput>>().toEqualTypeOf<true>();
    expectTypeOf<AssertGroundTruthFree<AlgorithmInit>>().toEqualTypeOf<true>();
    expectTypeOf<AssertGroundTruthFree<CameraSensorFrame>>().toEqualTypeOf<true>();
    expectTypeOf<AssertGroundTruthFree<CameraState>>().toEqualTypeOf<true>();
    expectTypeOf<AssertGroundTruthFree<GimbalState>>().toEqualTypeOf<true>();
  });

  it('keeps every type an algorithm emits provably ground-truth-free', () => {
    expectTypeOf<AssertGroundTruthFree<TrackingOutput>>().toEqualTypeOf<true>();
    expectTypeOf<AssertGroundTruthFree<AlgorithmInstance>>().toEqualTypeOf<true>();
    expectTypeOf<AssertGroundTruthFree<TargetObservation>>().toEqualTypeOf<true>();
    expectTypeOf<AssertGroundTruthFree<TargetEstimate>>().toEqualTypeOf<true>();
    expectTypeOf<AssertGroundTruthFree<ControlCommand>>().toEqualTypeOf<true>();
    expectTypeOf<AssertGroundTruthFree<PATState>>().toEqualTypeOf<true>();
  });

  it('keeps the experiment definition ground-truth-free', () => {
    expectTypeOf<AssertGroundTruthFree<SimulationConfig>>().toEqualTypeOf<true>();
  });

  it('checks a plugin through its config and debug types, not its manifest', () => {
    // `AlgorithmManifest` carries a Zod schema, whose type is wide enough that
    // walking it exhausts the compiler's instantiation limit outright (TS2589)
    // rather than returning a verdict. That is not a hole: the manifest never
    // crosses the isolation boundary, and it exposes no reachable surface
    // beyond `TConfig`, which `defineAlgorithm` checks directly. It is also
    // still fail-closed — TS2589 is a compile error, so such a type cannot be
    // admitted silently; it simply reports worse than the dedicated diagnostic.
    expectTypeOf<AssertGroundTruthFree<AlgorithmPlugin['create']>>().toEqualTypeOf<true>();
  });
});
