import { describe, expect, it } from 'vitest';

import { findGroundTruthLeak, isGroundTruthTainted } from '@/core/contracts/isolation';
import { loadScenario } from '@/scenarios';

import { SimulationEngine } from './engine';
import {
  buildObserverFrame,
  buildTrajectoryPaths,
  interpolateObserverFrame,
} from './observer-view';

const frameAt = (engine: SimulationEngine): ReturnType<typeof buildObserverFrame> =>
  buildObserverFrame(engine.snapshot(), ['Target']);

describe('observer frame', () => {
  it('is branded as ground truth, because that is what it shows', () => {
    // The observer view is a privileged debug view of the answer key. Branding
    // it means the runtime guard would catch it if it ever reached a tracker.
    const engine = new SimulationEngine(loadScenario('linear-pass'));
    const frame = frameAt(engine);

    expect(isGroundTruthTainted(frame)).toBe(true);
    expect(findGroundTruthLeak({ payload: frame })).toBe('payload');
  });

  it('expresses positions in renderer coordinates', () => {
    const engine = new SimulationEngine(loadScenario('stationary'));
    const frame = frameAt(engine);
    const truth = engine.snapshot().truth.targets[0]!.pose.position;

    // ENU (east, north, up) becomes (east, up, -north).
    expect(frame.targets[0]!.position[0]).toBeCloseTo(truth.x, 9);
    expect(frame.targets[0]!.position[1]).toBeCloseTo(truth.z, 9);
    expect(frame.targets[0]!.position[2]).toBeCloseTo(-(truth.y as number), 9);
  });

  it('carries the observer, targets and a beacon per target', () => {
    const engine = new SimulationEngine(loadScenario('circular'));
    const frame = frameAt(engine);

    expect(frame.observer.kind).toBe('platform');
    expect(frame.targets).toHaveLength(1);
    expect(frame.beacons).toHaveLength(1);
    expect(frame.beacons[0]!.kind).toBe('beacon');
  });

  it('draws a boresight ray away from the observer', () => {
    const engine = new SimulationEngine(loadScenario('stationary'));
    const frame = frameAt(engine);

    const [ox, oy, oz] = frame.observer.position;
    const [bx, by, bz] = frame.boresightEnd;
    expect(Math.hypot(bx - ox, by - oy, bz - oz)).toBeGreaterThan(100);
  });

  it('uses the scenario label for the target', () => {
    const engine = new SimulationEngine(loadScenario('linear-pass'));
    const frame = buildObserverFrame(engine.snapshot(), ['Crossing aircraft']);
    expect(frame.targets[0]!.label).toBe('Crossing aircraft');
  });
});

describe('interpolation', () => {
  const engine = new SimulationEngine(loadScenario('linear-pass'));
  const previous = frameAt(engine);
  const advanced = new SimulationEngine(loadScenario('linear-pass'));
  advanced.step(20);
  const current = buildObserverFrame(advanced.snapshot(), ['Target']);

  it('returns the endpoints at alpha 0 and 1', () => {
    expect(interpolateObserverFrame(previous, current, 0).targets[0]!.position).toEqual(
      previous.targets[0]!.position,
    );
    expect(interpolateObserverFrame(previous, current, 1).targets[0]!.position).toEqual(
      current.targets[0]!.position,
    );
  });

  it('lands halfway at alpha 0.5', () => {
    const blended = interpolateObserverFrame(previous, current, 0.5);
    const a = previous.targets[0]!.position;
    const b = current.targets[0]!.position;

    expect(blended.targets[0]!.position[0]).toBeCloseTo((a[0] + b[0]) / 2, 9);
    expect(blended.targets[0]!.position[2]).toBeCloseTo((a[2] + b[2]) / 2, 9);
  });

  it('clamps rather than extrapolating', () => {
    // Showing a position the simulation never passed through would be inventing
    // motion, which is exactly what this project must not do.
    const beyond = interpolateObserverFrame(previous, current, 3);
    expect(beyond.targets[0]!.position).toEqual(current.targets[0]!.position);

    const before = interpolateObserverFrame(previous, current, -2);
    expect(before.targets[0]!.position).toEqual(previous.targets[0]!.position);
  });

  it('does not touch the authoritative world', () => {
    const engineUnderTest = new SimulationEngine(loadScenario('sinusoidal'));
    engineUnderTest.step(100);
    const before = engineUnderTest.stateHash();

    const a = buildObserverFrame(engineUnderTest.snapshot(), ['T']);
    engineUnderTest.step(1);
    const b = buildObserverFrame(engineUnderTest.snapshot(), ['T']);
    for (const alpha of [0, 0.1, 0.37, 0.9, 1]) interpolateObserverFrame(a, b, alpha);

    engineUnderTest.reset();
    engineUnderTest.step(100);
    expect(engineUnderTest.stateHash()).toBe(before);
  });

  it('leaves the world independent of how often it is interpolated', () => {
    // Render rate must not reach the physics. Two runs stepped identically but
    // observed at different rates must end in the same state.
    const rare = new SimulationEngine(loadScenario('seeded-maneuver'));
    const often = new SimulationEngine(loadScenario('seeded-maneuver'));

    let previousFrame = buildObserverFrame(often.snapshot(), ['T']);
    for (let tick = 0; tick < 1_000; tick += 1) {
      rare.step(1);
      often.step(1);

      const nextFrame = buildObserverFrame(often.snapshot(), ['T']);
      for (let sub = 0; sub < 4; sub += 1) {
        interpolateObserverFrame(previousFrame, nextFrame, sub / 4);
      }
      previousFrame = nextFrame;
    }

    expect(often.stateHash()).toBe(rare.stateHash());
  });
});

describe('trajectory paths', () => {
  it('produces a polyline per target', () => {
    const engine = new SimulationEngine(loadScenario('waypoints'));
    const paths = buildTrajectoryPaths(engine, 64);

    expect(paths).toHaveLength(1);
    expect(paths[0]).toHaveLength(65);
    expect(paths[0]![0]).toHaveLength(3);
  });

  it('does not advance the engine', () => {
    const engine = new SimulationEngine(loadScenario('circular'));
    engine.step(42);
    buildTrajectoryPaths(engine, 128);
    expect(engine.tick).toBe(42);
  });

  it('traces the configured circle', () => {
    const engine = new SimulationEngine(loadScenario('circular'));
    const config = loadScenario('circular').targets[0]!.trajectory;
    if (config.kind !== 'circular') throw new Error('scenario changed shape');

    // Renderer coordinates: (east, up, -north).
    for (const [x, y, z] of buildTrajectoryPaths(engine, 32)[0]!) {
      const offset = Math.hypot(x - config.center.x, y - config.center.z, z + config.center.y);
      expect(offset).toBeCloseTo(config.radius, 6);
    }
  });
});
