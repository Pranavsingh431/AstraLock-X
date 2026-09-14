// @vitest-environment node
/**
 * Coverage search, optional priors, and the covariance-scaled local search.
 *
 * Two properties are load-bearing. The no-prior sweep must genuinely cover its
 * region — a lattice that leaves a strip unvisited produces a tracker that
 * "fails to acquire" for reasons that have nothing to do with tracking. And the
 * local search must scale with the estimator's own uncertainty, so a confident
 * track looks in a small place and a stale one looks in a large one.
 *
 * Everything here uses configuration, the camera's field of view, measured
 * mount state and time. No target bearing enters any of it.
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_ASTRALOCK_CONFIG } from './config';
import {
  WaypointSearch,
  assertCoverage,
  coverageGap,
  coverageWaypoints,
  gridSpacing,
  localSearchOffset,
  localSearchRadius,
  priorWaypoints,
  type FieldOfView,
  type SearchRegion,
} from './search';

const DEG = Math.PI / 180;

/** The bundled cameras: 12.0 deg x 9.0 deg. */
const FOV: FieldOfView = { horizontal: 12 * DEG, vertical: 9 * DEG };
const REGION: SearchRegion = {
  panMin: -30 * DEG,
  panMax: 30 * DEG,
  tiltMin: -5 * DEG,
  tiltMax: 15 * DEG,
};

describe('spacing is derived from the field of view', () => {
  it('leaves the configured overlap between adjacent pointings', () => {
    // The baseline's steps are constants chosen in Phase 4. These are computed
    // from the optics, which is why the two algorithms sweep the same region at
    // different rates — a real difference, and one worth stating when their
    // acquisition times are compared.
    const spacing = gridSpacing(FOV, 0.25);
    expect(spacing.horizontal).toBeCloseTo(9 * DEG, 12);
    expect(spacing.vertical).toBeCloseTo(6.75 * DEG, 12);
  });

  it('refuses a grid that cannot cover the ground', () => {
    // The rule is spacing/2 + settleTolerance <= FOV/2 on both axes: the mount
    // stops within a tolerance of each waypoint, so the overlap has to absorb
    // that error or a target can fall between cells even though the nominal
    // spacing looks fine.
    expect(() => assertCoverage(FOV, -0.5, 0.5 * DEG)).toThrow(/gaps/);
    expect(() => assertCoverage(FOV, 0.05, 2 * DEG)).toThrow(/gaps/);
  });

  it('accepts the shipped configuration', () => {
    expect(() =>
      assertCoverage(
        FOV,
        DEFAULT_ASTRALOCK_CONFIG.search.overlapFraction,
        DEFAULT_ASTRALOCK_CONFIG.search.settleTolerance,
      ),
    ).not.toThrow();
  });
});

describe('the no-prior sweep', () => {
  const waypoints = coverageWaypoints(REGION, FOV, 0.25);

  it('reaches both ends of both axes', () => {
    // A region whose extent is not a whole number of steps would otherwise
    // leave an unvisited strip at the far edge — exactly where a target the
    // operator guessed wrong about would be.
    const az = waypoints.map((w) => w.azimuth);
    const el = waypoints.map((w) => w.elevation);

    expect(Math.min(...az)).toBeCloseTo(REGION.panMin, 12);
    expect(Math.max(...az)).toBeCloseTo(REGION.panMax, 12);
    expect(Math.min(...el)).toBeCloseTo(REGION.tiltMin, 12);
    expect(Math.max(...el)).toBeCloseTo(REGION.tiltMax, 12);
  });

  it('leaves no gap a point beacon could fall through', () => {
    // Measured directly: the widest distance from any point in the region to
    // the nearest pointing, compared against the half-field. If this exceeded
    // the half-field there would be places the camera never looks.
    const gap = coverageGap(waypoints, REGION);
    expect(gap.horizontal).toBeLessThan(FOV.horizontal / 2);
    expect(gap.vertical).toBeLessThan(FOV.vertical / 2);
  });

  it('sweeps alternate rows in opposite directions', () => {
    const rows = new Map<number, number[]>();
    for (const w of waypoints) {
      const row = rows.get(w.elevation) ?? [];
      row.push(w.azimuth);
      rows.set(w.elevation, row);
    }
    const ordered = [...rows.entries()].sort((a, b) => a[0] - b[0]);
    expect(ordered.length).toBeGreaterThan(1);
    expect(ordered[0]![1][0]!).toBeLessThan(ordered[0]![1].at(-1)!);
    expect(ordered[1]![1][0]!).toBeGreaterThan(ordered[1]![1].at(-1)!);
  });

  it('is deterministic', () => {
    const a = coverageWaypoints(REGION, FOV, 0.25).map((w) => `${w.azimuth},${w.elevation}`);
    const b = coverageWaypoints(REGION, FOV, 0.25).map((w) => `${w.azimuth},${w.elevation}`);
    expect(b).toEqual(a);
  });

  it('never leaves the configured region', () => {
    for (const w of waypoints) {
      expect(w.azimuth).toBeGreaterThanOrEqual(REGION.panMin - 1e-12);
      expect(w.azimuth).toBeLessThanOrEqual(REGION.panMax + 1e-12);
      expect(w.elevation).toBeGreaterThanOrEqual(REGION.tiltMin - 1e-12);
      expect(w.elevation).toBeLessThanOrEqual(REGION.tiltMax + 1e-12);
    }
  });

  it('knows nothing about where the target is', () => {
    // The signature is the guarantee: a region, the optics, and an overlap.
    expect(coverageWaypoints.length).toBe(3);
  });
});

describe('an optional coarse prior', () => {
  const prior = {
    centreAzimuth: 10 * DEG,
    centreElevation: 4 * DEG,
    sigmaAzimuth: 3 * DEG,
    sigmaElevation: 2 * DEG,
    source: 'operator-estimate',
  };

  it('starts at the centre of the prior, not at the corner of the region', () => {
    const waypoints = priorWaypoints(prior, REGION, FOV, 0.25, 3);
    expect(waypoints[0]!.azimuth).toBeCloseTo(prior.centreAzimuth, 9);
    expect(waypoints[0]!.elevation).toBeCloseTo(prior.centreElevation, 9);
  });

  it('expands outward from there', () => {
    // High-probability first, then wider: that is the entire benefit a prior
    // buys, and it is deterministic rather than stochastic.
    const waypoints = priorWaypoints(prior, REGION, FOV, 0.25, 3);
    const distance = (index: number): number =>
      Math.hypot(
        waypoints[index]!.azimuth - prior.centreAzimuth,
        waypoints[index]!.elevation - prior.centreElevation,
      );

    const early = distance(1);
    const late = distance(waypoints.length - 1);
    expect(late).toBeGreaterThan(early);
  });

  it('stays inside the mount region even when the prior sits near its edge', () => {
    const edge = { ...prior, centreAzimuth: 29 * DEG, sigmaAzimuth: 10 * DEG };
    for (const w of priorWaypoints(edge, REGION, FOV, 0.25, 3)) {
      expect(w.azimuth).toBeLessThanOrEqual(REGION.panMax + 1e-12);
      expect(w.azimuth).toBeGreaterThanOrEqual(REGION.panMin - 1e-12);
    }
  });

  it('is deterministic', () => {
    const a = priorWaypoints(prior, REGION, FOV, 0.25, 3).map((w) => `${w.azimuth},${w.elevation}`);
    const b = priorWaypoints(prior, REGION, FOV, 0.25, 3).map((w) => `${w.azimuth},${w.elevation}`);
    expect(b).toEqual(a);
  });

  it('is off by default, so the shipped comparison is prior-free', () => {
    // A prior-assisted acquisition time compared against a prior-free one would
    // not be a measurement of the algorithm.
    expect(DEFAULT_ASTRALOCK_CONFIG.search.prior).toBeNull();
  });
});

describe('stepping through waypoints', () => {
  const config = {
    settleTolerance: 0.5 * DEG,
    measuredRateTolerance: 1.5 * DEG,
    dwellTime: 0.05,
    waypointTimeout: 1.5,
  };

  it('holds a waypoint until the mount has arrived and stopped', () => {
    const search = new WaypointSearch(coverageWaypoints(REGION, FOV, 0.25), config);
    const first = search.current;

    for (let i = 0; i < 40; i += 1) {
      search.step(i / 60, { azimuth: first.azimuth, elevation: first.elevation }, 10 * DEG, 0);
    }
    expect(search.index).toBe(0);

    search.step(1.0, { azimuth: first.azimuth, elevation: first.elevation }, 0, 0);
    search.step(1.2, { azimuth: first.azimuth, elevation: first.elevation }, 0, 0);
    expect(search.index).toBe(1);
  });

  it('gives up on an unreachable waypoint after the timeout', () => {
    const search = new WaypointSearch(coverageWaypoints(REGION, FOV, 0.25), config);
    for (let i = 0; i <= 90; i += 1) {
      search.step(
        i / 60,
        { azimuth: search.current.azimuth + 1, elevation: search.current.elevation },
        0,
        0,
      );
    }
    expect(search.index).toBeGreaterThan(0);
  });

  it('measures the timeout in simulated time, not wall time', () => {
    const search = new WaypointSearch(coverageWaypoints(REGION, FOV, 0.25), config);
    for (let i = 0; i < 1000; i += 1) {
      search.step(
        0,
        { azimuth: search.current.azimuth + 1, elevation: search.current.elevation },
        0,
        0,
      );
    }
    expect(search.index).toBe(0);
  });

  it('can restart from the pointing nearest a bearing', () => {
    // How RECOVER falls back: resume the sweep where the target was last
    // believed to be rather than from the corner of the region.
    const waypoints = coverageWaypoints(REGION, FOV, 0.25);
    const search = new WaypointSearch(waypoints, config);
    const target = waypoints.at(-3)!;

    search.startNearest({ azimuth: target.azimuth, elevation: target.elevation });
    expect(search.current.azimuth).toBeCloseTo(target.azimuth, 9);
    expect(search.current.elevation).toBeCloseTo(target.elevation, 9);
  });

  it('loops rather than stopping at the end', () => {
    const search = new WaypointSearch(coverageWaypoints(REGION, FOV, 0.25), {
      ...config,
      dwellTime: 0,
      waypointTimeout: 0.01,
    });
    const count = search.waypoints.length;
    for (let i = 0; i <= count + 4; i += 1) {
      search.step(
        i * 0.02,
        { azimuth: search.current.azimuth, elevation: search.current.elevation },
        0,
        0,
      );
    }
    expect(search.index).toBeLessThan(count);
  });
});

describe('the local search during recovery', () => {
  const config = DEFAULT_ASTRALOCK_CONFIG.recovery;

  it('scales its radius with the estimator uncertainty', () => {
    // A confident track looks in a small place; a stale one looks wider. That
    // is the whole difference from the baseline, which looks everywhere.
    const tight = localSearchRadius(1e-4, config);
    const loose = localSearchRadius(2e-2, config);
    expect(loose).toBeGreaterThan(tight);
  });

  it('is clamped at both ends', () => {
    // Never so small the pattern is pointless, never so wide it is a global
    // sweep wearing a local sweep's name.
    expect(localSearchRadius(0, config)).toBeCloseTo(config.localSearchMinRadius, 12);
    expect(localSearchRadius(1, config)).toBeCloseTo(config.localSearchMaxRadius, 12);
  });

  it('is the configured multiple of sigma between the clamps', () => {
    // Chosen above the minimum radius so the multiple, not the clamp, decides.
    const sigma = 5e-3;
    const scaled = config.localSearchSigmaMultiple * sigma;
    expect(scaled).toBeGreaterThan(config.localSearchMinRadius);
    expect(scaled).toBeLessThan(config.localSearchMaxRadius);
    expect(localSearchRadius(sigma, config)).toBeCloseTo(scaled, 12);
  });

  it('walks a deterministic pattern', () => {
    const first = localSearchOffset(0.5, 2 * DEG, 0, config);
    const again = localSearchOffset(0.5, 2 * DEG, 0, config);
    expect(again).toEqual(first);
  });

  it('visits different offsets as the recovery ages', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 8; i += 1) {
      const offset = localSearchOffset(i * config.localSearchDwell, 2 * DEG, 0, config);
      seen.add(`${offset.azimuth.toFixed(9)},${offset.elevation.toFixed(9)}`);
    }
    expect(seen.size).toBeGreaterThan(3);
  });

  it('keeps its true angular size at high elevation', () => {
    // An azimuth offset subtends less sky as elevation rises, so the pattern
    // would silently shrink near the zenith without the cosine.
    const level = localSearchOffset(0.5, 2 * DEG, 0, config);
    const steep = localSearchOffset(0.5, 2 * DEG, 1.2, config);
    expect(Math.abs(steep.azimuth)).toBeGreaterThan(Math.abs(level.azimuth));
  });

  it('starts at the centre, so a target still at the prediction is found first', () => {
    const start = localSearchOffset(0, 2 * DEG, 0, config);
    expect(Math.hypot(start.azimuth, start.elevation)).toBe(0);
  });
});
