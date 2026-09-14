/**
 * Type-level tests for ground-truth isolation.
 *
 * Run by `pnpm test` via `vitest --typecheck`. The `@ts-expect-error` cases are
 * the important half: they fail if the offending code ever starts compiling, so
 * they detect a weakened barrier rather than just confirming a working one.
 *
 * The property under test is three-valued, and all three states are covered:
 *
 *   provably clean -> admitted
 *   reaches truth  -> rejected
 *   undecidable    -> rejected
 */

import { describe, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import {
  type AlgorithmInstance,
  type AlgorithmPlugin,
  type TrackingInput,
  type TrackingOutput,
  defineAlgorithm,
} from './algorithm-plugin';
import type { GroundTruthState, WorldState } from './ground-truth';
import type {
  AssertGroundTruthFree,
  GroundTruthFree,
  GroundTruthReachable,
  GroundTruthUnprovable,
  InspectGroundTruth,
  IsProvablyGroundTruthFree,
} from './isolation';
import type { CameraState, GimbalState } from './sensors';
import type { Degrees, Radians } from './units';

// --- Helpers for expressing nesting depth ------------------------------------

/** A tuple of length `N`, used only to count nesting levels. */
type Tuple<N extends number, Acc extends readonly unknown[] = []> = Acc['length'] extends N
  ? Acc
  : Tuple<N, [...Acc, unknown]>;

/** Wraps `T` in one `{ value: ... }` level per element of `Levels`. */
type Nest<T, Levels extends readonly unknown[]> = Levels extends readonly [unknown, ...infer Rest]
  ? { readonly value: Nest<T, Rest> }
  : T;

interface Leaf {
  readonly gain: number;
}

/** Comfortably inside the inspection budget. */
type ShallowClean = Nest<Leaf, Tuple<5>>;
/** Comfortably beyond it, so the walk cannot decide. */
type TooDeepToDecide = Nest<Leaf, Tuple<24>>;
/** Tainted, but only a few levels down. */
type NestedTainted = Nest<GroundTruthState, Tuple<3>>;

// --- The three verdicts ------------------------------------------------------

describe('InspectGroundTruth', () => {
  it('reports clean for a type it can fully walk', () => {
    expectTypeOf<InspectGroundTruth<ShallowClean>>().toEqualTypeOf<'clean'>();
    expectTypeOf<InspectGroundTruth<TrackingInput>>().toEqualTypeOf<'clean'>();
    expectTypeOf<InspectGroundTruth<CameraState>>().toEqualTypeOf<'clean'>();
    expectTypeOf<InspectGroundTruth<GimbalState>>().toEqualTypeOf<'clean'>();
    expectTypeOf<InspectGroundTruth<TrackingOutput>>().toEqualTypeOf<'clean'>();
  });

  it('reports tainted when ground truth is reachable', () => {
    expectTypeOf<InspectGroundTruth<GroundTruthState>>().toEqualTypeOf<'tainted'>();
    expectTypeOf<InspectGroundTruth<WorldState>>().toEqualTypeOf<'tainted'>();
    expectTypeOf<InspectGroundTruth<NestedTainted>>().toEqualTypeOf<'tainted'>();
  });

  it('reports unknown when the type nests past the budget', () => {
    expectTypeOf<InspectGroundTruth<TooDeepToDecide>>().toEqualTypeOf<'unknown'>();
  });

  it('finds ground truth through arrays, functions and unions', () => {
    expectTypeOf<InspectGroundTruth<readonly GroundTruthState[]>>().toEqualTypeOf<'tainted'>();
    expectTypeOf<InspectGroundTruth<{ peek: () => GroundTruthState }>>().toEqualTypeOf<'tainted'>();
    expectTypeOf<InspectGroundTruth<GroundTruthState | CameraState>>().toEqualTypeOf<
      'tainted' | 'clean'
    >();
  });

  it('treats `any` as tainted and `unknown` as clean', () => {
    // `any` defeats checking, so it is refused. `unknown` is the safe top type
    // and is the declared default for a plugin with no config or debug payload.
    expectTypeOf<IsProvablyGroundTruthFree<any>>().toEqualTypeOf<false>();
    expectTypeOf<InspectGroundTruth<unknown>>().toEqualTypeOf<'clean'>();
  });
});

describe('IsProvablyGroundTruthFree', () => {
  it('accepts only the provably clean case', () => {
    expectTypeOf<IsProvablyGroundTruthFree<ShallowClean>>().toEqualTypeOf<true>();
    expectTypeOf<IsProvablyGroundTruthFree<NestedTainted>>().toEqualTypeOf<false>();
    expectTypeOf<IsProvablyGroundTruthFree<TooDeepToDecide>>().toEqualTypeOf<false>();
  });

  it('rejects a union with one tainted arm', () => {
    expectTypeOf<
      IsProvablyGroundTruthFree<CameraState | GroundTruthState>
    >().toEqualTypeOf<false>();
  });
});

describe('GroundTruthFree', () => {
  it('passes a provably clean type through unchanged', () => {
    expectTypeOf<GroundTruthFree<CameraState>>().toEqualTypeOf<CameraState>();
  });

  it('collapses both failure modes to never', () => {
    expectTypeOf<GroundTruthFree<GroundTruthState>>().toEqualTypeOf<never>();
    expectTypeOf<GroundTruthFree<TooDeepToDecide>>().toEqualTypeOf<never>();
  });
});

describe('AssertGroundTruthFree', () => {
  it('distinguishes a reachable leak from an undecidable type', () => {
    // The two diagnostics carry different remedies: remove the dependency, or
    // flatten the type. Collapsing them into one message would hide that.
    expectTypeOf<AssertGroundTruthFree<ShallowClean>>().toEqualTypeOf<true>();
    expectTypeOf<AssertGroundTruthFree<NestedTainted>>().toEqualTypeOf<
      GroundTruthReachable<NestedTainted>
    >();
    expectTypeOf<AssertGroundTruthFree<TooDeepToDecide>>().toEqualTypeOf<
      GroundTruthUnprovable<TooDeepToDecide>
    >();
  });
});

// --- defineAlgorithm ---------------------------------------------------------

interface CleanConfig {
  readonly gateThreshold: number;
}
interface CleanDebug {
  readonly candidateCount: number;
}

const cleanInstance: AlgorithmInstance<CleanDebug> = {
  update: () => ({}) as TrackingOutput<CleanDebug>,
  reset: () => undefined,
};

const cleanManifest = {
  id: 'test-plugin',
  name: 'Test Plugin',
  version: '0.0.0',
  description: 'Fixture used by type tests.',
  configSchema: z.object({ gateThreshold: z.number() }),
  defaultConfig: { gateThreshold: 3 },
};

describe('defineAlgorithm', () => {
  it('admits a plugin whose config and debug types are provably clean', () => {
    const plugin = defineAlgorithm<AlgorithmPlugin<CleanConfig, CleanDebug>>({
      manifest: cleanManifest,
      create: () => cleanInstance,
    });
    expectTypeOf(plugin).toEqualTypeOf<AlgorithmPlugin<CleanConfig, CleanDebug>>();
  });

  it('rejects a plugin whose config type reaches ground truth', () => {
    defineAlgorithm<AlgorithmPlugin<{ truth: GroundTruthState }, CleanDebug>>(
      // @ts-expect-error - config reaches GroundTruthState, so the plugin is refused.
      {
        manifest: {
          ...cleanManifest,
          configSchema: z.custom<{ truth: GroundTruthState }>(),
          defaultConfig: {} as { truth: GroundTruthState },
        },
        create: () => cleanInstance,
      },
    );
  });

  it('rejects a plugin whose debug payload can carry ground truth back out', () => {
    defineAlgorithm<AlgorithmPlugin<CleanConfig, { leaked: GroundTruthState }>>(
      // @ts-expect-error - debug payload reaches GroundTruthState, so the plugin is refused.
      {
        manifest: cleanManifest,
        create: () => cleanInstance as unknown as AlgorithmInstance<{ leaked: GroundTruthState }>,
      },
    );
  });

  it('rejects a plugin whose config is too deep to decide', () => {
    // Fail-closed. Nothing here is tainted; the walk simply ran out of budget,
    // and admitting it would mean scoring an algorithm whose surface was never
    // actually checked.
    defineAlgorithm<AlgorithmPlugin<TooDeepToDecide, CleanDebug>>(
      // @ts-expect-error - config cannot be proved ground-truth-free, so it is refused.
      {
        manifest: {
          ...cleanManifest,
          configSchema: z.custom<TooDeepToDecide>(),
          defaultConfig: {} as TooDeepToDecide,
        },
        create: () => cleanInstance,
      },
    );
  });

  it('rejects a plugin whose debug payload is too deep to decide', () => {
    defineAlgorithm<AlgorithmPlugin<CleanConfig, TooDeepToDecide>>(
      // @ts-expect-error - debug payload cannot be proved ground-truth-free.
      {
        manifest: cleanManifest,
        create: () => cleanInstance as unknown as AlgorithmInstance<TooDeepToDecide>,
      },
    );
  });

  it('rejects a plugin parameterised with `any`', () => {
    defineAlgorithm<AlgorithmPlugin<any, CleanDebug>>(
      // @ts-expect-error - `any` defeats the check, so it is refused.
      {
        manifest: { ...cleanManifest, configSchema: z.any(), defaultConfig: {} },
        create: () => cleanInstance,
      },
    );
  });
});

describe('TrackingInput', () => {
  it('has no member that resolves to ground truth', () => {
    expectTypeOf<AssertGroundTruthFree<TrackingInput>>().toEqualTypeOf<true>();
  });

  it('does not accept a ground-truth field being added by a caller', () => {
    // @ts-expect-error - TrackingInput has no `truth` member and is not open.
    const bad: TrackingInput = { truth: {} as GroundTruthState };
    expectTypeOf(bad).toEqualTypeOf<TrackingInput>();
  });
});

describe('unit brands', () => {
  it('keeps angular units distinct', () => {
    expectTypeOf<Radians>().not.toEqualTypeOf<Degrees>();
    expectTypeOf<Radians>().toExtend<number>();
  });

  it('refuses a raw number where a unit is required', () => {
    // @ts-expect-error - a bare number carries no unit.
    const angle: Radians = 1.57;
    expectTypeOf(angle).toEqualTypeOf<Radians>();
  });
});
