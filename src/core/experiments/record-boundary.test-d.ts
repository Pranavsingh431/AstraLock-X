/**
 * The safe parts of an experiment record carry no ground truth, by type.
 *
 * Phase 0 sketched `TelemetrySample` and `ExperimentEvent` as placeholder
 * contracts; Phase 6 removed those in favour of the persisted Phase 5 schemas,
 * which are the only definitions. These assertions moved with them: telemetry
 * and events may be handed to anyone, so a ground-truth type reachable from
 * either would travel further than a leak confined to one tick.
 */

import { describe, expectTypeOf, it } from 'vitest';

import type { AssertGroundTruthFree } from '@/core/contracts/isolation';

import type { ExperimentEvent, ExperimentManifest, TelemetrySample } from './schema';

describe('the safe experiment record', () => {
  it('keeps telemetry, events and provenance ground-truth-free', () => {
    expectTypeOf<AssertGroundTruthFree<TelemetrySample>>().toEqualTypeOf<true>();
    expectTypeOf<AssertGroundTruthFree<ExperimentEvent>>().toEqualTypeOf<true>();
    expectTypeOf<AssertGroundTruthFree<ExperimentManifest>>().toEqualTypeOf<true>();
  });
});
