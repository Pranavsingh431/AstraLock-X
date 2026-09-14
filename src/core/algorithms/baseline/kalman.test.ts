// @vitest-environment node
/**
 * The constant-velocity filter.
 *
 * Most of these cases use synthetic measurement sequences generated here rather
 * than from the simulator: the filter is mathematics, and checking mathematics
 * against a known signal is both stronger and clearer than checking it against
 * a scenario. The last group then feeds it real detector output from real
 * camera frames, because a filter that is correct in isolation and wrong on the
 * actual measurement chain is still wrong.
 *
 * Nothing here reaches inside the filter to peek at truth. Where truth is used
 * it is in the assertion, comparing the filter's output against the signal the
 * test itself generated.
 */

import { describe, expect, it } from 'vitest';

import { loadScenario } from '@/scenarios';
import { cameraStateFrom } from '@/core/runtime/closed-loop';
import { SimulationEngine } from '@/core/simulation/engine';
import { VirtualCameraSensor } from '@/core/sensors/virtual-camera';
import { ExactWorldSampler } from '@/core/sensors/world-sampler';

import { shortestAngle, wrapAngle } from './angles';
import { pixelToBearing } from './bearing';
import { DEFAULT_BASELINE_PAT_CONFIG } from './config';
import { detect } from './detector';
import { BearingKalmanFilter, processNoiseMatrix, transitionMatrix } from './kalman';

const CONFIG = DEFAULT_BASELINE_PAT_CONFIG.kalman;

/** Deterministic pseudo-random noise, so a failure is reproducible. */
function noise(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    // Sum of two uniforms: a crude but adequate bell shape on [-1, 1].
    const a = state / 4294967296;
    state = (state * 1664525 + 1013904223) >>> 0;
    const b = state / 4294967296;
    return a + b - 1;
  };
}

// --- Angle helpers ----------------------------------------------------------

describe('angle arithmetic', () => {
  it('wraps to (-pi, pi]', () => {
    expect(wrapAngle(0)).toBe(0);
    expect(wrapAngle(Math.PI)).toBeCloseTo(Math.PI, 12);
    expect(wrapAngle(-Math.PI)).toBeCloseTo(Math.PI, 12);
    expect(wrapAngle(3 * Math.PI)).toBeCloseTo(Math.PI, 12);
    expect(wrapAngle(1.5 * Math.PI)).toBeCloseTo(-0.5 * Math.PI, 12);
  });

  it('takes the short way across the branch cut', () => {
    // The failure this prevents: a 2 rad innovation where the truth is 0.08 rad.
    const difference = shortestAngle(-3.1, 3.1);
    expect(Math.abs(difference)).toBeCloseTo(2 * Math.PI - 6.2, 12);
    expect(Math.abs(difference)).toBeLessThan(0.1);
  });

  it('is signed correctly either side of the cut', () => {
    // Getting from -3.1 to +3.1 means going *backwards* through +/-pi, which is
    // a negative difference of 0.083 rad, not a positive one of 6.2.
    expect(shortestAngle(3.1, -3.1)).toBeLessThan(0);
    expect(shortestAngle(-3.1, 3.1)).toBeGreaterThan(0);
    expect(shortestAngle(0.2, 0.1)).toBeCloseTo(0.1, 12);
  });
});

// --- Matrices ---------------------------------------------------------------

describe('the model matrices', () => {
  it('propagates position by rate over dt', () => {
    const f = transitionMatrix(0.5);
    expect(f[0]![2]).toBe(0.5);
    expect(f[1]![3]).toBe(0.5);
    expect(f[2]![2]).toBe(1);
  });

  it('builds the standard white-noise-acceleration Q', () => {
    const dt = 0.25;
    const q = processNoiseMatrix(dt, 3);

    expect(q[0]![0]).toBeCloseTo((3 * dt ** 4) / 4, 12);
    expect(q[0]![2]).toBeCloseTo((3 * dt ** 3) / 2, 12);
    expect(q[2]![2]).toBeCloseTo(3 * dt ** 2, 12);
    // The axes do not share noise.
    expect(q[0]![1]).toBe(0);
    expect(q[0]![3]).toBe(0);
  });

  it('is symmetric', () => {
    const q = processNoiseMatrix(0.3, 2);
    for (let i = 0; i < 4; i += 1) {
      for (let j = 0; j < 4; j += 1) expect(q[i]![j]).toBeCloseTo(q[j]![i]!, 15);
    }
  });
});

// --- Behaviour --------------------------------------------------------------

describe('a stationary bearing', () => {
  it('converges on it and reports near-zero rate', () => {
    const filter = new BearingKalmanFilter(CONFIG);
    const rand = noise(11);
    const trueAz = 0.4;
    const trueEl = 0.05;

    for (let k = 0; k < 300; k += 1) {
      filter.update(trueAz + rand() * 2e-4, trueEl + rand() * 2e-4, k / 60);
    }

    const e = filter.estimate();
    expect(e.azimuth).toBeCloseTo(trueAz, 4);
    expect(e.elevation).toBeCloseTo(trueEl, 4);
    expect(Math.abs(e.azimuthRate)).toBeLessThan(2e-3);
    expect(Math.abs(e.elevationRate)).toBeLessThan(2e-3);
  });

  it('shrinks its own uncertainty as evidence accumulates', () => {
    const filter = new BearingKalmanFilter(CONFIG);
    filter.update(0.4, 0.05, 0);
    const initial = filter.estimate().covariance[0]![0]!;

    for (let k = 1; k < 100; k += 1) filter.update(0.4, 0.05, k / 60);

    expect(filter.estimate().covariance[0]![0]!).toBeLessThan(initial);
  });
});

describe('a constant angular velocity', () => {
  it('recovers the rate', () => {
    const filter = new BearingKalmanFilter(CONFIG);
    const rand = noise(23);
    const rate = 0.08;

    for (let k = 0; k < 400; k += 1) {
      const t = k / 60;
      filter.update(0.1 + rate * t + rand() * 1e-4, 0.02 + rand() * 1e-4, t);
    }

    const e = filter.estimate();
    expect(e.azimuthRate).toBeCloseTo(rate, 2);
    expect(Math.abs(e.elevationRate)).toBeLessThan(5e-3);
  });

  it('predicts ahead using that rate', () => {
    const filter = new BearingKalmanFilter(CONFIG);
    const rate = 0.05;
    for (let k = 0; k < 300; k += 1) {
      const t = k / 60;
      filter.update(rate * t, 0, t);
    }

    const now = filter.time!;
    const ahead = filter.predictedAt(now + 0.5);
    expect(ahead.azimuth - filter.estimate().azimuth).toBeCloseTo(rate * 0.5, 2);
  });

  it('does not disturb the state when asked to predict ahead', () => {
    const filter = new BearingKalmanFilter(CONFIG);
    for (let k = 0; k < 60; k += 1) filter.update(0.01 * k, 0, k / 60);

    const before = filter.estimate();
    filter.predictedAt(filter.time! + 2);
    const after = filter.estimate();

    expect(after.azimuth).toBe(before.azimuth);
    expect(after.azimuthRate).toBe(before.azimuthRate);
  });
});

describe('irregular timing', () => {
  it('handles frame intervals that are not uniform', () => {
    // Dropped frames make dt vary. A filter that assumed 1/60 would build a
    // wrong rate here.
    const filter = new BearingKalmanFilter(CONFIG);
    const rate = 0.06;
    const gaps = [1 / 60, 1 / 60, 3 / 60, 1 / 60, 7 / 60, 2 / 60];
    let t = 0;

    for (let k = 0; k < 300; k += 1) {
      t += gaps[k % gaps.length]!;
      filter.update(rate * t, 0, t);
    }

    expect(filter.estimate().azimuthRate).toBeCloseTo(rate, 2);
  });

  it('refuses to run backwards', () => {
    const filter = new BearingKalmanFilter(CONFIG);
    filter.update(0.1, 0, 1);
    expect(() => filter.predictTo(0.5)).toThrow(RangeError);
  });

  it('sub-steps a long gap rather than taking it in one jump', () => {
    // Q grows as dt^3-dt^4, so the same interval taken whole accumulates more
    // process noise than the same interval taken in pieces. The two filters
    // differ only in their step cap, so the gap between them is exactly the
    // effect being tested.
    const inPieces = new BearingKalmanFilter(CONFIG);
    const inOneJump = new BearingKalmanFilter({ ...CONFIG, maxPredictStep: 1 });
    inPieces.initialise(0, 0, 0);
    inOneJump.initialise(0, 0, 0);

    inPieces.predictTo(1);
    inOneJump.predictTo(1);

    const piecewise = inPieces.estimate().covariance[0]![0]!;
    const single = inOneJump.estimate().covariance[0]![0]!;

    expect(piecewise).toBeLessThan(single);
    expect(Number.isFinite(piecewise)).toBe(true);
    // Both still grow relative to the initial variance: coasting really is less
    // certain than measuring.
    expect(piecewise).toBeGreaterThan(CONFIG.initialAngleVariance);
  });
});

describe('prediction without measurement', () => {
  it('coasts on the estimated rate', () => {
    const filter = new BearingKalmanFilter(CONFIG);
    const rate = 0.07;
    for (let k = 0; k < 300; k += 1) filter.update(rate * (k / 60), 0, k / 60);

    const before = filter.estimate();
    filter.predictTo(filter.time! + 0.2);
    const after = filter.estimate();

    expect(after.azimuth - before.azimuth).toBeCloseTo(rate * 0.2, 3);
  });

  it('grows the uncertainty while coasting', () => {
    const filter = new BearingKalmanFilter(CONFIG);
    for (let k = 0; k < 100; k += 1) filter.update(0.1, 0, k / 60);

    const before = filter.estimate().covariance[0]![0]!;
    filter.predictTo(filter.time! + 1);

    expect(filter.estimate().covariance[0]![0]!).toBeGreaterThan(before);
  });

  it('does nothing at all before initialisation', () => {
    const filter = new BearingKalmanFilter(CONFIG);
    filter.predictTo(5);
    expect(filter.isInitialised).toBe(false);
  });
});

describe('initialisation and reset', () => {
  it('starts from the first measurement with zero rate', () => {
    const filter = new BearingKalmanFilter(CONFIG);
    filter.update(0.33, -0.02, 4);

    const e = filter.estimate();
    expect(e.azimuth).toBeCloseTo(0.33, 12);
    expect(e.elevation).toBeCloseTo(-0.02, 12);
    expect(e.azimuthRate).toBe(0);
    expect(filter.isInitialised).toBe(true);
    expect(filter.time).toBe(4);
  });

  it('declares an honest initial uncertainty on the unobserved rate', () => {
    const filter = new BearingKalmanFilter(CONFIG);
    filter.update(0.33, -0.02, 0);
    const c = filter.estimate().covariance;

    expect(c[2]![2]).toBe(CONFIG.initialRateVariance);
    expect(c[2]![2]).toBeGreaterThan(c[0]![0]!);
  });

  it('reset clears everything', () => {
    const filter = new BearingKalmanFilter(CONFIG);
    for (let k = 0; k < 50; k += 1) filter.update(0.01 * k, 0, k / 60);

    filter.reset();

    expect(filter.isInitialised).toBe(false);
    expect(filter.updateCount).toBe(0);
    expect(filter.time).toBeNull();
  });
});

describe('numerical health', () => {
  it('keeps the covariance symmetric over a long run', () => {
    const filter = new BearingKalmanFilter(CONFIG);
    const rand = noise(77);
    for (let k = 0; k < 20_000; k += 1) {
      filter.update(0.2 + rand() * 1e-4, 0.1 + rand() * 1e-4, k / 60);
    }

    const c = filter.estimate().covariance;
    for (let i = 0; i < 4; i += 1) {
      for (let j = 0; j < 4; j += 1) expect(c[i]![j]).toBe(c[j]![i]);
    }
  });

  it('keeps the diagonal positive, so the covariance stays meaningful', () => {
    const filter = new BearingKalmanFilter(CONFIG);
    const rand = noise(91);
    for (let k = 0; k < 20_000; k += 1) {
      filter.update(0.2 + rand() * 1e-4, 0.1 + rand() * 1e-4, k / 60);
    }

    for (let i = 0; i < 4; i += 1) {
      expect(filter.estimate().covariance[i]![i]!).toBeGreaterThan(0);
    }
  });

  it('produces no NaN or Infinity over a long mixed run', () => {
    const filter = new BearingKalmanFilter(CONFIG);
    const rand = noise(13);
    let t = 0;

    for (let k = 0; k < 30_000; k += 1) {
      t += (1 + (k % 5)) / 60;
      if (k % 17 === 0) filter.predictTo(t);
      else filter.update(Math.sin(t * 0.1) + rand() * 1e-3, Math.cos(t * 0.05) * 0.2, t);
    }

    const e = filter.estimate();
    for (const value of [e.azimuth, e.elevation, e.azimuthRate, e.elevationRate]) {
      expect(Number.isFinite(value)).toBe(true);
    }
    for (const row of e.covariance)
      for (const value of row) expect(Number.isFinite(value)).toBe(true);
  });

  it('reports a normalised innovation squared of a sensible size', () => {
    // A filter whose NIS sits far from its 2 degrees of freedom is mistuned,
    // which matters more for a control loop than raw error does.
    const filter = new BearingKalmanFilter({ ...CONFIG, measurementNoiseStdDev: 1e-4 });
    const rand = noise(5);
    const samples: number[] = [];

    for (let k = 0; k < 2000; k += 1) {
      filter.update(0.3 + rand() * 1e-4, 0.1 + rand() * 1e-4, k / 60);
      const nis = filter.estimate().normalisedInnovationSquared;
      if (k > 100 && nis !== null) samples.push(nis);
    }

    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    // Two degrees of freedom, so the expectation is 2. The generous window
    // reflects that the injected noise is triangular rather than Gaussian.
    expect(mean).toBeGreaterThan(0.05);
    expect(mean).toBeLessThan(6);
  });
});

describe('at the azimuth branch cut', () => {
  it('does not see a 2-pi jump when the target crosses due South', () => {
    const filter = new BearingKalmanFilter(CONFIG);
    const rate = 0.05;

    // Walk from just below +pi across to just above -pi.
    let t = 0;
    let angle = Math.PI - 0.1;
    for (let k = 0; k < 200; k += 1) {
      filter.update(wrapAngle(angle), 0, t);
      angle += rate / 60;
      t += 1 / 60;
    }

    const e = filter.estimate();
    // The rate must still be the true one: a 2-pi innovation would have thrown
    // it wildly, and the estimate would be nowhere near the measurement.
    expect(e.azimuthRate).toBeCloseTo(rate, 1);
    expect(Math.abs(shortestAngle(e.azimuth, wrapAngle(angle)))).toBeLessThan(0.05);
  });

  it('keeps its own state on the principal branch', () => {
    const filter = new BearingKalmanFilter(CONFIG);
    let angle = 0;
    for (let k = 0; k < 3000; k += 1) {
      angle += 0.01;
      filter.update(wrapAngle(angle), 0, k / 60);
    }

    // Without wrapping inside the filter the state would have marched to 30 rad
    // and lost precision in the low bits.
    expect(Math.abs(filter.estimate().azimuth)).toBeLessThanOrEqual(Math.PI + 1e-9);
  });

  it('starts correctly from a measurement at the cut', () => {
    const filter = new BearingKalmanFilter(CONFIG);
    filter.update(Math.PI - 1e-6, 0, 0);
    expect(Math.abs(filter.estimate().azimuth)).toBeLessThanOrEqual(Math.PI);
  });
});

// --- With real measurements -------------------------------------------------

describe('fed by the real detector on real frames', () => {
  it('tracks the bearing of a beacon the camera actually saw', () => {
    const engine = new SimulationEngine(loadScenario('camera-boresight'));
    const sensor = new VirtualCameraSensor({ config: engine.config });
    const sampler = new ExactWorldSampler(engine);
    const camera = cameraStateFrom(engine.config);
    const filter = new BearingKalmanFilter(CONFIG);

    let measurements = 0;
    for (let frame = 1; frame <= 120; frame += 1) {
      engine.step(3);
      const capture = sensor.captureFrame(sampler, frame);
      try {
        const result = detect(capture.frame, DEFAULT_BASELINE_PAT_CONFIG.detector);
        if (result.selected === null) continue;
        const bearing = pixelToBearing(
          result.selected.centroidX + 0.5,
          result.selected.centroidY + 0.5,
          camera,
          capture.frame.pose.azimuth,
          capture.frame.pose.elevation,
        );
        filter.update(bearing.azimuth, bearing.elevation, capture.frame.captureTime);
        measurements += 1;
      } finally {
        capture.release();
      }
    }

    expect(measurements).toBeGreaterThan(100);

    // The beacon is stationary and the mount is still, so the filter should
    // have settled on a fixed bearing with essentially no rate.
    const e = filter.estimate();
    expect(Number.isFinite(e.azimuth)).toBe(true);
    expect(Math.abs(e.azimuthRate)).toBeLessThan(1e-2);
    expect(Math.abs(e.elevationRate)).toBeLessThan(1e-2);
  });
});
