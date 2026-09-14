// @vitest-environment node
/**
 * Absent values, and why they are absent.
 *
 * The property under test is that a report cannot accidentally present "we do
 * not model this" as a number. Phase 4 did exactly that with a 0 dB
 * signal-to-noise ratio on a noiseless sensor, and no test caught it because
 * `0` is a perfectly valid `Decibels`.
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_BASELINE_PAT_CONFIG, baselineKfPidPat } from '@/core/algorithms';
import { ClosedLoopRuntime } from '@/core/runtime/closed-loop';
import { SimulationEngine } from '@/core/simulation/engine';
import { VirtualCameraSensor } from '@/core/sensors/virtual-camera';
import { ExactWorldSampler } from '@/core/sensors/world-sampler';
import { loadScenario } from '@/scenarios';

import {
  configured,
  derived,
  formatMeasurement,
  isPresent,
  measured,
  measurementSchema,
  notApplicable,
  notMeasured,
  notModelled,
} from './measurement';

describe('constructing a measurement', () => {
  it('carries the value and the unit when there is one', () => {
    const m = measured(12.5, 'dB');
    expect(m.value).toBe(12.5);
    expect(m.status).toBe('measured');
    expect(m.unit).toBe('dB');
    expect(isPresent(m)).toBe(true);
  });

  it.each([
    ['not modelled', notModelled<number>('dB'), 'not-modelled'],
    ['not applicable', notApplicable<number>('1'), 'not-applicable'],
    ['not measured', notMeasured<number>('rad'), 'not-measured'],
  ])('records %s as absent, with no number at all', (_label, m, status) => {
    expect(m.value).toBeNull();
    expect(m.status).toBe(status);
    expect(isPresent(m)).toBe(false);
  });

  it('distinguishes the three kinds of absence, because they mean different things', () => {
    // "the simulator cannot tell you", "the question is meaningless here" and
    // "nothing was seen this time" are three different findings.
    const statuses = new Set([
      notModelled<number>('dB').status,
      notApplicable<number>('1').status,
      notMeasured<number>('rad').status,
    ]);
    expect(statuses.size).toBe(3);
  });

  it('separates measured, derived and configured provenance', () => {
    expect(measured(1, 'm').status).toBe('measured');
    expect(derived(1, 'm').status).toBe('derived');
    expect(configured(1, 'm').status).toBe('configured');
  });
});

describe('formatting for a human', () => {
  it('never renders an absent value as a number', () => {
    for (const m of [
      notModelled<number>('dB'),
      notApplicable<number>('1'),
      notMeasured<number>('rad'),
    ]) {
      const text = formatMeasurement(m);
      expect(text).not.toMatch(/\d/);
    }
  });

  it('says which kind of absence it is', () => {
    expect(formatMeasurement(notModelled<number>('dB'))).toBe('Not modelled');
    expect(formatMeasurement(notApplicable<number>('1'))).toBe('N/A');
    expect(formatMeasurement(notMeasured<number>('rad'))).toBe('Not measured');
  });

  it('renders a present value with its unit', () => {
    expect(formatMeasurement(measured(1.23456, 'rad'), 3)).toBe('1.235 rad');
  });
});

describe('the serialised form', () => {
  it('accepts a present value with a present status', () => {
    expect(measurementSchema.safeParse(measured(3, 'dB')).success).toBe(true);
  });

  it('accepts an absent value with an absent status', () => {
    expect(measurementSchema.safeParse(notModelled<number>('dB')).success).toBe(true);
  });

  it('rejects a present status carrying no value', () => {
    expect(
      measurementSchema.safeParse({ value: null, status: 'measured', unit: 'dB' }).success,
    ).toBe(false);
  });

  it('rejects an absent status carrying a value, which is the 0 dB bug', () => {
    // The exact shape of the Phase 4 defect: a number sitting behind a status
    // that says there is no number.
    expect(
      measurementSchema.safeParse({ value: 0, status: 'not-modelled', unit: 'dB' }).success,
    ).toBe(false);
  });

  it('rejects NaN and Infinity, which are not absences either', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(measurementSchema.safeParse({ value, status: 'measured', unit: 'dB' }).success).toBe(
        false,
      );
    }
  });
});

describe('the detector no longer claims a signal-to-noise ratio', () => {
  it('reports SNR as unmodelled on a real detection, not as 0 dB', () => {
    const engine = new SimulationEngine(loadScenario('pat-stationary-outside-fov'));
    const sensor = new VirtualCameraSensor({ config: engine.config });
    const runtime = new ClosedLoopRuntime({
      engine,
      sensor,
      sampler: new ExactWorldSampler(engine),
      plugin: baselineKfPidPat,
      config: DEFAULT_BASELINE_PAT_CONFIG,
    });

    let observation: { snr: { value: number | null; status: string } } | undefined;
    const ticks = 25 * engine.config.tickRate;
    for (let tick = 0; tick < ticks && observation === undefined; tick += 1) {
      runtime.step(1);
      observation = runtime.algorithmOutput?.observations[0];
    }

    expect(observation).toBeDefined();
    expect(observation!.snr.value).toBeNull();
    expect(observation!.snr.status).toBe('not-modelled');
  });

  it('still reports the quantities it genuinely computes', () => {
    // The point is not to make everything null: peak intensity is measured
    // from the pixels and stays a number.
    const engine = new SimulationEngine(loadScenario('camera-boresight'));
    const sensor = new VirtualCameraSensor({ config: engine.config });
    const runtime = new ClosedLoopRuntime({
      engine,
      sensor,
      sampler: new ExactWorldSampler(engine),
      plugin: baselineKfPidPat,
      config: DEFAULT_BASELINE_PAT_CONFIG,
    });

    for (let tick = 0; tick < 200; tick += 1) runtime.step(1);

    const observation = runtime.algorithmOutput?.observations[0];
    expect(observation).toBeDefined();
    expect(observation!.peakIntensity).toBeGreaterThan(0);
  });
});
