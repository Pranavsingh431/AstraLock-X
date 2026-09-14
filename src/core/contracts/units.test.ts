import { describe, expect, it } from 'vitest';

import {
  angularDifference,
  degrees,
  degreesToRadians,
  hertz,
  hertzToPeriod,
  microradians,
  microradiansToRadians,
  milliseconds,
  millisecondsToSeconds,
  periodToHertz,
  radians,
  radiansToDegrees,
  radiansToMicroradians,
  seconds,
  secondsToMilliseconds,
  wrapToPi,
} from './units';

describe('angle conversion', () => {
  it('converts degrees to radians', () => {
    expect(degreesToRadians(degrees(180))).toBeCloseTo(Math.PI, 12);
    expect(degreesToRadians(degrees(0))).toBe(0);
    expect(degreesToRadians(degrees(-90))).toBeCloseTo(-Math.PI / 2, 12);
  });

  it('round-trips degrees through radians', () => {
    for (const value of [-359.9, -45, 0, 12.34, 180, 359.9]) {
      expect(radiansToDegrees(degreesToRadians(degrees(value)))).toBeCloseTo(value, 10);
    }
  });

  it('converts radians to microradians at the scale FSOC pointing needs', () => {
    expect(radiansToMicroradians(radians(1))).toBe(1e6);
    // A 50 urad pointing error is a realistic coarse-stage budget.
    expect(radiansToMicroradians(radians(50e-6))).toBeCloseTo(50, 9);
    expect(microradiansToRadians(microradians(50))).toBeCloseTo(50e-6, 15);
  });
});

describe('time conversion', () => {
  it('converts between seconds and milliseconds', () => {
    expect(secondsToMilliseconds(seconds(1.5))).toBe(1500);
    expect(millisecondsToSeconds(milliseconds(250))).toBe(0.25);
  });

  it('converts a rate to its sampling period', () => {
    expect(hertzToPeriod(hertz(100))).toBeCloseTo(0.01, 15);
    expect(periodToHertz(seconds(0.01))).toBeCloseTo(100, 12);
  });

  it('refuses a non-positive rate rather than returning Infinity', () => {
    expect(() => hertzToPeriod(hertz(0))).toThrow(RangeError);
    expect(() => hertzToPeriod(hertz(-10))).toThrow(RangeError);
    expect(() => hertzToPeriod(hertz(Number.NaN))).toThrow(RangeError);
    expect(() => periodToHertz(seconds(0))).toThrow(RangeError);
  });
});

describe('wrapToPi', () => {
  it('leaves angles already inside the interval alone', () => {
    expect(wrapToPi(radians(0))).toBe(0);
    expect(wrapToPi(radians(0.5))).toBeCloseTo(0.5, 15);
    expect(wrapToPi(radians(-1.25))).toBeCloseTo(-1.25, 15);
  });

  it('closes the interval at +pi', () => {
    expect(wrapToPi(radians(Math.PI))).toBeCloseTo(Math.PI, 12);
    expect(wrapToPi(radians(-Math.PI))).toBeCloseTo(Math.PI, 12);
  });

  it('wraps angles outside the interval', () => {
    expect(wrapToPi(radians(3 * Math.PI))).toBeCloseTo(Math.PI, 12);
    expect(wrapToPi(radians(-1.5 * Math.PI))).toBeCloseTo(Math.PI / 2, 12);
    expect(wrapToPi(radians(2 * Math.PI + 0.25))).toBeCloseTo(0.25, 12);
  });

  it('always lands inside (-pi, pi] for a wide sweep', () => {
    for (let k = -20; k <= 20; k += 1) {
      const wrapped = wrapToPi(radians(k * 0.7));
      expect(wrapped).toBeGreaterThan(-Math.PI - 1e-12);
      expect(wrapped).toBeLessThanOrEqual(Math.PI + 1e-12);
    }
  });
});

describe('angularDifference', () => {
  it('takes the short way round the discontinuity', () => {
    // Just under +pi to just over -pi is a small positive step, not almost -2pi.
    const difference = angularDifference(radians(3.0), radians(-3.0));
    expect(difference).toBeCloseTo(2 * Math.PI - 6, 12);
    expect(Math.abs(difference)).toBeLessThan(Math.PI);
  });

  it('is zero for identical angles and antisymmetric otherwise', () => {
    expect(angularDifference(radians(1.1), radians(1.1))).toBe(0);
    expect(angularDifference(radians(0.2), radians(0.5))).toBeCloseTo(0.3, 12);
    expect(angularDifference(radians(0.5), radians(0.2))).toBeCloseTo(-0.3, 12);
  });
});
