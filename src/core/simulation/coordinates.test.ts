import { describe, expect, it } from 'vitest';

import { meters, metersPerSecond } from '@/core/contracts/units';

import {
  bearingRateTo,
  bearingTo,
  directionFromBearing,
  enuToRender,
  renderToEnu,
} from './coordinates';
import { cross, dot, vec3 } from './vector';

const ORIGIN = { x: meters(0), y: meters(0), z: meters(0) };
const at = (x: number, y: number, z: number) => ({ x: meters(x), y: meters(y), z: meters(z) });
const moving = (x: number, y: number, z: number) => ({
  x: metersPerSecond(x),
  y: metersPerSecond(y),
  z: metersPerSecond(z),
});
const STILL = moving(0, 0, 0);

describe('azimuth convention', () => {
  it('reads zero due North and a quarter turn due East', () => {
    // Compass convention: North is zero and azimuth increases clockwise seen
    // from above. Getting this backwards would put every bearing in the
    // scenario 90 degrees out and still look self-consistent.
    expect(bearingTo(ORIGIN, at(0, 1000, 0)).azimuth).toBeCloseTo(0, 12);
    expect(bearingTo(ORIGIN, at(1000, 0, 0)).azimuth).toBeCloseTo(Math.PI / 2, 12);
    expect(Math.abs(bearingTo(ORIGIN, at(0, -1000, 0)).azimuth)).toBeCloseTo(Math.PI, 12);
    expect(bearingTo(ORIGIN, at(-1000, 0, 0)).azimuth).toBeCloseTo(-Math.PI / 2, 12);
  });

  it('reads the intercardinals at the expected half-quarters', () => {
    expect(bearingTo(ORIGIN, at(1000, 1000, 0)).azimuth).toBeCloseTo(Math.PI / 4, 12);
    expect(bearingTo(ORIGIN, at(-1000, 1000, 0)).azimuth).toBeCloseTo(-Math.PI / 4, 12);
  });
});

describe('elevation convention', () => {
  it('is zero on the horizon and positive upward', () => {
    expect(bearingTo(ORIGIN, at(0, 1000, 0)).elevation).toBeCloseTo(0, 12);
    expect(bearingTo(ORIGIN, at(0, 1000, 1000)).elevation).toBeCloseTo(Math.PI / 4, 12);
    expect(bearingTo(ORIGIN, at(0, 1000, -1000)).elevation).toBeCloseTo(-Math.PI / 4, 12);
    expect(bearingTo(ORIGIN, at(0, 0, 500)).elevation).toBeCloseTo(Math.PI / 2, 12);
  });

  it('reports range as the slant distance', () => {
    expect(bearingTo(ORIGIN, at(300, 400, 0)).range).toBeCloseTo(500, 12);
    expect(bearingTo(ORIGIN, at(0, 3, 4)).range).toBeCloseTo(5, 12);
  });

  it('does not produce NaN when the target is directly overhead', () => {
    const bearing = bearingTo(ORIGIN, at(0, 0, 100));
    expect(Number.isNaN(bearing.azimuth)).toBe(false);
    expect(bearing.elevation).toBeCloseTo(Math.PI / 2, 12);
  });
});

describe('directionFromBearing', () => {
  it('inverts bearingTo', () => {
    for (const point of [at(120, 900, 45), at(-700, -200, 300), at(0, 1500, -60)]) {
      const bearing = bearingTo(ORIGIN, point);
      const unit = directionFromBearing(bearing);
      expect(unit.x).toBeCloseTo(point.x / bearing.range, 9);
      expect(unit.y).toBeCloseTo(point.y / bearing.range, 9);
      expect(unit.z).toBeCloseTo(point.z / bearing.range, 9);
    }
  });

  it('returns a unit vector', () => {
    const unit = directionFromBearing({ azimuth: 1.2 as never, elevation: 0.4 as never });
    expect(Math.hypot(unit.x, unit.y, unit.z)).toBeCloseTo(1, 12);
  });
});

describe('bearing rates', () => {
  it('matches v/r for a purely tangential crossing', () => {
    // A target 1000 m due North moving East at 10 m/s sweeps 0.01 rad/s.
    const rate = bearingRateTo(ORIGIN, STILL, at(0, 1000, 0), moving(10, 0, 0));
    expect(rate.azimuth).toBeCloseTo(0.01, 12);
    expect(rate.elevation).toBeCloseTo(0, 12);
  });

  it('puts purely vertical motion into elevation alone', () => {
    const rate = bearingRateTo(ORIGIN, STILL, at(0, 1000, 0), moving(0, 0, 10));
    expect(rate.azimuth).toBeCloseTo(0, 12);
    expect(rate.elevation).toBeCloseTo(0.01, 12);
  });

  it('is zero for motion straight along the line of sight', () => {
    // Closing directly on the observer changes range, not bearing.
    const rate = bearingRateTo(ORIGIN, STILL, at(0, 1000, 0), moving(0, -30, 0));
    expect(rate.azimuth).toBeCloseTo(0, 12);
    expect(rate.elevation).toBeCloseTo(0, 12);
  });

  it('agrees with a finite difference of bearingTo', () => {
    // The analytic derivative is the one used in production; this checks it
    // against the definition rather than against itself.
    const target = at(400, 900, 150);
    const velocity = moving(-12, 20, 5);
    const dt = 1e-6;

    const before = bearingTo(ORIGIN, target);
    const after = bearingTo(
      ORIGIN,
      at(target.x + velocity.x * dt, target.y + velocity.y * dt, target.z + velocity.z * dt),
    );
    const analytic = bearingRateTo(ORIGIN, STILL, target, velocity);

    expect(analytic.azimuth).toBeCloseTo((after.azimuth - before.azimuth) / dt, 4);
    expect(analytic.elevation).toBeCloseTo((after.elevation - before.elevation) / dt, 4);
  });

  it('accounts for observer motion, not just target motion', () => {
    // Observer and target moving identically hold a constant bearing.
    const rate = bearingRateTo(ORIGIN, moving(10, 0, 0), at(0, 1000, 0), moving(10, 0, 0));
    expect(rate.azimuth).toBeCloseTo(0, 12);
    expect(rate.elevation).toBeCloseTo(0, 12);
  });
});

describe('renderer mapping', () => {
  it('sends East to +X, Up to +Y and North to -Z', () => {
    // Compared component-wise: negating a zero component yields -0, which is
    // numerically equal to 0 but not deeply equal to it.
    const expectAxis = (actual: readonly number[], expected: readonly number[]): void => {
      expected.forEach((value, index) => {
        expect(actual[index]).toBeCloseTo(value, 12);
      });
    };

    expectAxis(enuToRender(at(1, 0, 0)), [1, 0, 0]);
    expectAxis(enuToRender(at(0, 1, 0)), [0, 0, -1]);
    expectAxis(enuToRender(at(0, 0, 1)), [0, 1, 0]);
  });

  it('round-trips', () => {
    const original = at(123.5, -67.25, 9.125);
    const restored = renderToEnu(enuToRender(original));
    expect(restored.x).toBe(original.x);
    expect(restored.y).toBe(original.y);
    expect(restored.z).toBe(original.z);
  });

  it('preserves handedness', () => {
    // East x North = Up must still hold after mapping. A mirrored mapping
    // would satisfy the three axis cases above and silently flip every cross
    // product and every azimuth drawn on screen.
    const [ex, ey, ez] = enuToRender(at(1, 0, 0));
    const [nx, ny, nz] = enuToRender(at(0, 1, 0));
    const [ux, uy, uz] = enuToRender(at(0, 0, 1));

    const product = cross(vec3(ex, ey, ez), vec3(nx, ny, nz));
    expect(product.x).toBeCloseTo(ux, 12);
    expect(product.y).toBeCloseTo(uy, 12);
    expect(product.z).toBeCloseTo(uz, 12);
  });

  it('preserves lengths and angles', () => {
    const a = at(30, -40, 120);
    const b = at(-5, 60, 8);
    const [ax, ay, az] = enuToRender(a);
    const [bx, by, bz] = enuToRender(b);

    expect(Math.hypot(ax, ay, az)).toBeCloseTo(Math.hypot(a.x, a.y, a.z), 10);
    expect(dot(vec3(ax, ay, az), vec3(bx, by, bz))).toBeCloseTo(
      a.x * b.x + a.y * b.y + a.z * b.z,
      9,
    );
  });

  it('uses metres as scene units, with no hidden scale factor', () => {
    const [x, y, z] = enuToRender(at(1234.5, 678.25, 90.125));
    expect(Math.hypot(x, y, z)).toBeCloseTo(Math.hypot(1234.5, 678.25, 90.125), 9);
  });
});
