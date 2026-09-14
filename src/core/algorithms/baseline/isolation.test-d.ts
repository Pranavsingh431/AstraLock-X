/**
 * Type-level proof that the baseline algorithm is sealed.
 *
 * Run by `pnpm test` via `vitest --typecheck`. The `@ts-expect-error` cases are
 * the important half: each asserts that a line must **fail** to compile, and if
 * a future change ever made one compile, TypeScript reports the unused
 * directive and the build breaks. A negative test that silently started passing
 * would be worse than no test at all.
 *
 * `defineAlgorithm`'s own three-valued admission check — clean admitted,
 * tainted rejected, undecidable rejected — is proved in
 * `src/core/contracts/isolation.test-d.ts` and is not repeated here. What this
 * file adds is that the *concrete* types the baseline actually uses satisfy it,
 * and that the new Phase 4 surfaces cannot be subverted.
 */

import { describe, expectTypeOf, it } from 'vitest';

import type {
  AlgorithmInit,
  TrackingInput,
  TrackingOutput,
} from '@/core/contracts/algorithm-plugin';
import type { CommandIntent, ControlCommand } from '@/core/contracts/control';
import type { AssertGroundTruthFree, StaticAssert } from '@/core/contracts/isolation';

import type { BaselinePatConfig } from './config';
import type { BaselineDebug } from './plugin';

// --- Standing proofs --------------------------------------------------------
//
// Type aliases, not tests: if any of these ever stops holding, `tsc` fails at
// this line and CI fails with it.

/** The baseline's own config cannot reach ground truth. */
export type ProofConfigIsClean = StaticAssert<AssertGroundTruthFree<BaselinePatConfig>>;

/** Neither can its debug payload, which is what the UI renders. */
export type ProofDebugIsClean = StaticAssert<AssertGroundTruthFree<BaselineDebug>>;

/** Nor anything it is handed at construction. */
export type ProofInitIsClean = StaticAssert<
  AssertGroundTruthFree<AlgorithmInit<BaselinePatConfig>>
>;

/** Nor its whole per-tick output surface. */
export type ProofOutputIsClean = StaticAssert<AssertGroundTruthFree<TrackingOutput<BaselineDebug>>>;

describe('what the baseline can be handed', () => {
  it('has no route from its input to the world', () => {
    const input = {} as TrackingInput;

    // @ts-expect-error -- there is no ground-truth state on a tracking input.
    void input.truth;
    // @ts-expect-error -- nor a target list.
    void input.targets;
    // @ts-expect-error -- nor the simulation engine.
    void input.engine;
    // @ts-expect-error -- nor the mount object, which would let it bypass the runtime.
    void input.gimbalDevice;
    // @ts-expect-error -- nor the scenario, whose target blocks are the answer key.
    void input.scenario;
  });

  it('gets a frame that reports only what a camera reports', () => {
    const frame = {} as NonNullable<TrackingInput['frame']>;

    // @ts-expect-error -- no true optical pose: the frame carries the encoder reading.
    void frame.truePose;
    // @ts-expect-error -- no projected target centre.
    void frame.imageX;
    // @ts-expect-error -- no per-frame evaluation record.
    void frame.truth;
    // @ts-expect-error -- no emitter identity, which would trivialise association.
    void frame.emitterId;

    // What it does have is the pixels and the mount's own report.
    expectTypeOf(frame.data).toEqualTypeOf<Uint8Array | Uint16Array>();
    expectTypeOf(frame.pose.azimuth).toBeNumber();
  });

  it('gets the encoder side of the mount and nothing behind it', () => {
    const gimbal = {} as TrackingInput['gimbal'];

    // @ts-expect-error -- the motor angle is the mount's interior.
    void gimbal.motorAngle;
    // @ts-expect-error -- so is how much of the backlash gap is taken up.
    void gimbal.backlashDisplacement;
    // @ts-expect-error -- and the acceleration the servo demanded.
    void gimbal.commandedAcceleration;

    expectTypeOf(gimbal.azimuth).toBeNumber();
  });
});

describe('what the baseline can emit', () => {
  it('returns an intent, which cannot carry a command time', () => {
    // The heart of ADR-0013. If an algorithm could stamp its own command it
    // could back-date it to the frame's capture time and act in the past.
    const intent = {} as Extract<CommandIntent, { kind: 'position' }>;

    // @ts-expect-error -- an intent has no issue time; the runtime supplies it.
    void intent.issuedAt;
    // @ts-expect-error -- nor a command id, which the mount assigns.
    void intent.commandId;

    expectTypeOf(intent.azimuth).toBeNumber();
  });

  it('cannot return a stamped command in place of an intent', () => {
    const stamped = {} as ControlCommand;
    // @ts-expect-error -- TrackingOutput['command'] is CommandIntent | null.
    const output: TrackingOutput<BaselineDebug>['command'] = stamped;
    void output;
  });

  it('reports only diagnostics it derived itself', () => {
    const debug = {} as BaselineDebug;

    // @ts-expect-error -- the true bearing belongs to evaluation, not here.
    void debug.trueAzimuth;
    // @ts-expect-error -- nor the true pointing error.
    void debug.truePointingError;
    // @ts-expect-error -- nor the true projected centre.
    void debug.trueImageX;

    // What it does report is measured, filtered or commanded by the algorithm.
    expectTypeOf(debug.centroidX).toEqualTypeOf<number | null>();
    expectTypeOf(debug.filteredAzimuth).toEqualTypeOf<number | null>();
    expectTypeOf(debug.panCorrection).toBeNumber();
  });
});

describe('the command surface', () => {
  it('is an intent, and the echo back is stamped', () => {
    // Asymmetric on purpose: the algorithm asks without a timestamp, and is
    // told afterwards what was actually sent and when. Real control software
    // knows what it transmitted.
    expectTypeOf<TrackingOutput<BaselineDebug>['command']>().toEqualTypeOf<CommandIntent | null>();
    expectTypeOf<TrackingInput['previousCommand']>().toEqualTypeOf<ControlCommand | null>();
  });
});
