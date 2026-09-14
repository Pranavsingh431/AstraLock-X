/**
 * Compile-time half of the sensor isolation proof.
 *
 * The runtime probe in sensor-isolation.test.ts shows a hostile consumer cannot
 * *find* truth in a frame. This shows the compiler will not let one be *given*
 * truth in the first place.
 */

import { describe, expectTypeOf, it } from 'vitest';

import {
  type AlgorithmInstance,
  type AlgorithmPlugin,
  type TrackingOutput,
  defineAlgorithm,
} from '@/core/contracts/algorithm-plugin';
import type { AssertGroundTruthFree } from '@/core/contracts/isolation';
import type { CameraPose, CameraSensorFrame } from '@/core/contracts/sensors';

import type { EmitterProjectionTruth, SensorEvaluationTruth } from './sensor-truth';
import type { SensorCapture } from './virtual-camera';

describe('the frame a tracker receives', () => {
  it('is provably ground-truth-free', () => {
    expectTypeOf<AssertGroundTruthFree<CameraSensorFrame>>().toEqualTypeOf<true>();
    expectTypeOf<AssertGroundTruthFree<CameraPose>>().toEqualTypeOf<true>();
  });
});

describe('the evaluation truth', () => {
  it('is tainted, so nothing clean can be typed with it', () => {
    expectTypeOf<AssertGroundTruthFree<SensorEvaluationTruth>>().not.toEqualTypeOf<true>();
    expectTypeOf<AssertGroundTruthFree<SensorCapture>>().not.toEqualTypeOf<true>();
    expectTypeOf<
      AssertGroundTruthFree<{ readonly t: SensorEvaluationTruth }>
    >().not.toEqualTypeOf<true>();
  });
});

const instance: AlgorithmInstance<{ count: number }> = {
  update: () => ({}) as TrackingOutput<{ count: number }>,
  reset: () => undefined,
};

const manifest = {
  id: 'sensor-isolation-probe',
  name: 'Probe',
  version: '0.0.0',
  description: 'Fixture for the sensor isolation type tests.',
  configSchema: { parse: (v: unknown) => v } as never,
  defaultConfig: { count: 0 } as never,
};

describe('a plugin that tries to take sensor truth', () => {
  it('is refused when its config asks for the evaluation record', () => {
    defineAlgorithm<AlgorithmPlugin<{ truth: SensorEvaluationTruth }, { count: number }>>(
      // @ts-expect-error - config reaches SensorEvaluationTruth, so it is refused.
      { manifest, create: () => instance },
    );
  });

  it('is refused when its debug payload would carry a projection', () => {
    defineAlgorithm<AlgorithmPlugin<{ count: number }, { leaked: EmitterProjectionTruth }>>(
      // @ts-expect-error - debug payload reaches emitter truth, so it is refused.
      { manifest, create: () => instance as never },
    );
  });

  it('is refused when it asks for the whole capture pair', () => {
    defineAlgorithm<AlgorithmPlugin<SensorCapture, { count: number }>>(
      // @ts-expect-error - the capture pair contains the answer key.
      { manifest, create: () => instance },
    );
  });

  it('is admitted when it only wants frames', () => {
    // The permitted case, so the rejections above are known to be about truth
    // rather than about the fixture being unusable.
    const plugin = defineAlgorithm<
      AlgorithmPlugin<{ readonly threshold: number }, { readonly lastFrameId: number }>
    >({ manifest, create: () => instance as never });

    expectTypeOf(plugin).toEqualTypeOf<
      AlgorithmPlugin<{ readonly threshold: number }, { readonly lastFrameId: number }>
    >();
  });
});
