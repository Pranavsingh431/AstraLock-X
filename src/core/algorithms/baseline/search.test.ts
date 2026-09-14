// @vitest-environment node
/**
 * The scan.
 *
 * Two things have to be true and are easy to get wrong. First, the pattern must
 * actually cover the region — a lattice that stops one step short leaves a
 * strip where a target is never looked at, and the failure looks exactly like
 * "the tracker didn't find it". Second, the scan must decide when to move on
 * using only quantities real control software has, because a scan that peeked
 * at the world to know when to skip a waypoint would be the whole isolation
 * story undone at the last step.
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_BASELINE_PAT_CONFIG } from './config';
import { SearchPattern, buildWaypoints, type SearchConfig } from './search';

const DEG = Math.PI / 180;
const BASE: SearchConfig = DEFAULT_BASELINE_PAT_CONFIG.search;

const cfg = (patch: Partial<SearchConfig> = {}): SearchConfig => ({ ...BASE, ...patch });

describe('coverage', () => {
  it('includes both ends of both axes', () => {
    // A region whose extent is not a whole number of steps would otherwise
    // leave an unvisited strip at the far edge, which is exactly where a target
    // the operator guessed wrong about would be.
    const config = cfg({
      panMin: -0.3,
      panMax: 0.31,
      tiltMin: 0,
      tiltMax: 0.17,
      horizontalStep: 0.1,
      verticalStep: 0.1,
    });
    const points = buildWaypoints(config);

    const pans = points.map((p) => p.pan);
    const tilts = points.map((p) => p.tilt);

    expect(Math.min(...pans)).toBeCloseTo(config.panMin, 12);
    expect(Math.max(...pans)).toBeCloseTo(config.panMax, 12);
    expect(Math.min(...tilts)).toBeCloseTo(config.tiltMin, 12);
    expect(Math.max(...tilts)).toBeCloseTo(config.tiltMax, 12);
  });

  it('leaves no gap larger than the configured step', () => {
    const points = buildWaypoints(BASE);
    const rows = new Map<number, number[]>();
    for (const point of points) {
      const row = rows.get(point.tilt) ?? [];
      row.push(point.pan);
      rows.set(point.tilt, row);
    }

    for (const [, pans] of rows) {
      const sorted = [...pans].sort((a, b) => a - b);
      for (let index = 1; index < sorted.length; index += 1) {
        expect(sorted[index]! - sorted[index - 1]!).toBeLessThanOrEqual(
          BASE.horizontalStep + 1e-12,
        );
      }
    }

    const tilts = [...rows.keys()].sort((a, b) => a - b);
    for (let index = 1; index < tilts.length; index += 1) {
      expect(tilts[index]! - tilts[index - 1]!).toBeLessThanOrEqual(BASE.verticalStep + 1e-12);
    }
  });

  it('overlaps the bundled field of view rather than merely abutting it', () => {
    // The bundled cameras are 12.0 x 9.0 degrees. Waypoint spacing must be
    // comfortably inside that or a target between two waypoints is seen by
    // neither, especially once the mount's settle tolerance is allowed for.
    expect(BASE.horizontalStep).toBeLessThan(12 * DEG * 0.75);
    expect(BASE.verticalStep).toBeLessThan(9 * DEG * 0.75);
  });

  it('visits every waypoint exactly once per pass', () => {
    const points = buildWaypoints(BASE);
    const seen = new Set(points.map((p) => `${p.pan.toFixed(9)},${p.tilt.toFixed(9)}`));
    expect(seen.size).toBe(points.length);
  });

  it('sweeps alternate rows in opposite directions', () => {
    // Serpentine, not a raster that flies back to the start of each row: the
    // return leg would be half the scan spent re-covering ground.
    const points = buildWaypoints(cfg({ horizontalStep: 0.2, verticalStep: 0.2 }));
    const rows = new Map<number, number[]>();
    for (const point of points) {
      const row = rows.get(point.tilt) ?? [];
      row.push(point.pan);
      rows.set(point.tilt, row);
    }

    const ordered = [...rows.entries()].sort((a, b) => a[0] - b[0]);
    expect(ordered.length).toBeGreaterThan(1);
    const first = ordered[0]![1];
    const second = ordered[1]![1];

    expect(first[0]).toBeLessThan(first[first.length - 1]!);
    expect(second[0]).toBeGreaterThan(second[second.length - 1]!);
  });

  it('handles a degenerate region without dividing by zero', () => {
    const points = buildWaypoints(
      cfg({
        panMin: 0,
        panMax: 1e-9,
        tiltMin: 0,
        tiltMax: 1e-9,
        horizontalStep: 1,
        verticalStep: 1,
      }),
    );
    expect(points.length).toBeGreaterThan(0);
    for (const point of points) {
      expect(Number.isFinite(point.pan)).toBe(true);
      expect(Number.isFinite(point.tilt)).toBe(true);
    }
  });
});

describe('determinism', () => {
  it('gives the same sequence for the same config', () => {
    const a = buildWaypoints(BASE).map((p) => `${p.pan},${p.tilt}`);
    const b = buildWaypoints(BASE).map((p) => `${p.pan},${p.tilt}`);
    expect(b).toEqual(a);
  });

  it('gives the same walk for the same measured inputs', () => {
    const walk = (): string[] => {
      const search = new SearchPattern(BASE);
      const visited: string[] = [];
      for (let k = 0; k < 2000; k += 1) {
        // A mount that arrives instantly, so the walk is driven purely by the
        // dwell and the step logic.
        const target = search.current;
        const point = search.step(k / 60, target.pan, target.tilt, 0, 0);
        visited.push(`${point.index}`);
      }
      return visited;
    };
    expect(walk()).toEqual(walk());
  });
});

describe('staying inside the mount', () => {
  it('never asks for an angle outside the configured region', () => {
    for (const point of buildWaypoints(BASE)) {
      expect(point.pan).toBeGreaterThanOrEqual(BASE.panMin - 1e-12);
      expect(point.pan).toBeLessThanOrEqual(BASE.panMax + 1e-12);
      expect(point.tilt).toBeGreaterThanOrEqual(BASE.tiltMin - 1e-12);
      expect(point.tilt).toBeLessThanOrEqual(BASE.tiltMax + 1e-12);
    }
  });

  it('the shipped region is inside the bundled mount travel', () => {
    // Pan travel is +/-170 deg and tilt -20 to +80 deg on the bundled profiles.
    expect(BASE.panMin).toBeGreaterThan(-170 * DEG);
    expect(BASE.panMax).toBeLessThan(170 * DEG);
    expect(BASE.tiltMin).toBeGreaterThan(-20 * DEG);
    expect(BASE.tiltMax).toBeLessThan(80 * DEG);
  });
});

describe('advancing between waypoints', () => {
  it('holds a waypoint until the mount has arrived and stopped', () => {
    const search = new SearchPattern(cfg({ dwellTime: 0.1, waypointTimeout: 100 }));
    const first = search.current;

    // Still travelling: position is right but the mount is moving.
    for (let k = 0; k < 50; k += 1) {
      search.step(k / 60, first.pan, first.tilt, 10 * DEG, 0);
    }
    expect(search.current.index).toBe(first.index);

    // Arrived and stopped, but not yet dwelled.
    search.step(1.0, first.pan, first.tilt, 0, 0);
    expect(search.current.index).toBe(first.index);

    // Dwelled.
    search.step(1.2, first.pan, first.tilt, 0, 0);
    expect(search.current.index).toBe(first.index + 1);
  });

  it('does not advance while the mount is still far away', () => {
    const search = new SearchPattern(cfg({ waypointTimeout: 100 }));
    const first = search.current;

    for (let k = 0; k < 200; k += 1) {
      search.step(k / 60, first.pan + 0.5, first.tilt, 0, 0);
    }
    expect(search.current.index).toBe(first.index);
  });

  it('gives up on an unreachable waypoint after the timeout', () => {
    // A deadband wider than the settle tolerance, or a setpoint the travel
    // stops make unreachable, would otherwise hold the scan for ever.
    const search = new SearchPattern(cfg({ waypointTimeout: 0.5, dwellTime: 0.1 }));
    const first = search.current;

    // Just past one timeout, not two: the loop runs to 0.5 s exactly.
    for (let k = 0; k <= 30; k += 1) {
      search.step(k / 60, first.pan + 1, first.tilt, 0, 0);
    }

    expect(search.current.index).toBe(first.index + 1);
    expect(search.lastAdvanceReason).toBe('timeout');
  });

  it('measures the timeout in simulated time, not wall time', () => {
    const search = new SearchPattern(cfg({ waypointTimeout: 10, dwellTime: 0.1 }));
    const first = search.current;

    // A thousand calls at the same instant must not age the waypoint at all.
    for (let k = 0; k < 1000; k += 1) search.step(0, first.pan + 1, first.tilt, 0, 0);
    expect(search.current.index).toBe(first.index);

    search.step(11, first.pan + 1, first.tilt, 0, 0);
    expect(search.current.index).toBe(first.index + 1);
  });

  it('records why it moved on', () => {
    const search = new SearchPattern(cfg({ dwellTime: 0.05, waypointTimeout: 100 }));
    const first = search.current;
    search.step(0, first.pan, first.tilt, 0, 0);
    search.step(0.2, first.pan, first.tilt, 0, 0);
    expect(search.lastAdvanceReason).toBe('settled');
  });
});

describe('exhausting the region', () => {
  it('loops when configured to', () => {
    const search = new SearchPattern(cfg({ loop: true, dwellTime: 0, waypointTimeout: 0.01 }));
    const count = search.all.length;

    for (let k = 0; k <= count + 2; k += 1) {
      const point = search.current;
      search.step(k * 0.02, point.pan, point.tilt, 0, 0);
    }

    expect(search.isComplete).toBe(false);
    expect(search.current.index).toBeLessThan(count);
  });

  it('stops at the end when it is not', () => {
    const search = new SearchPattern(cfg({ loop: false, dwellTime: 0, waypointTimeout: 0.01 }));
    const count = search.all.length;

    for (let k = 0; k <= count + 5; k += 1) {
      const point = search.current;
      search.step(k * 0.02, point.pan, point.tilt, 0, 0);
    }

    expect(search.isComplete).toBe(true);
    expect(search.current.index).toBe(count - 1);
  });

  it('rewinds on reset', () => {
    const search = new SearchPattern(cfg({ dwellTime: 0, waypointTimeout: 0.01 }));
    for (let k = 0; k < 20; k += 1) {
      const point = search.current;
      search.step(k * 0.02, point.pan, point.tilt, 0, 0);
    }
    expect(search.current.index).toBeGreaterThan(0);

    search.reset();
    expect(search.current.index).toBe(0);
    expect(search.isComplete).toBe(false);
  });
});

describe('what the scan is allowed to know', () => {
  it('takes only time and measured mount state', () => {
    // Five parameters: time, measured pan, measured tilt, and the two measured
    // rates. There is no parameter through which a target bearing could arrive.
    expect(SearchPattern.prototype.step.length).toBe(5);
  });

  it('produces an identical walk whatever the world contains', () => {
    // Same measured inputs, same sequence — the scan cannot be reacting to
    // anything else, because there is nothing else.
    const walk = (): number[] => {
      const search = new SearchPattern(BASE);
      const out: number[] = [];
      for (let k = 0; k < 500; k += 1) {
        const point = search.current;
        out.push(search.step(k / 60, point.pan, point.tilt, 0, 0).index);
      }
      return out;
    };
    expect(walk()).toEqual(walk());
  });
});
