import { describe, expect, it } from 'vitest';

import type { TrajectoryConfig } from '@/core/contracts/trajectory';

import { RandomStream } from '../rng';
import { type Vector3, length, subtract, vec3 } from '../vector';
import { createTrajectory } from './index';
import { SeededManeuverTrajectory, generateManeuverSchedule } from './seeded-maneuver';
import type { Trajectory } from './types';

const stream = (seed = 12345): RandomStream => new RandomStream('trajectory', seed);

const build = (config: TrajectoryConfig, durationSeconds = 60): Trajectory =>
  createTrajectory(config, { stream: stream(), durationSeconds });

const expectVec = (actual: Vector3, x: number, y: number, z: number, digits = 9): void => {
  expect(actual.x).toBeCloseTo(x, digits);
  expect(actual.y).toBeCloseTo(y, digits);
  expect(actual.z).toBeCloseTo(z, digits);
};

/**
 * Central-difference check that velocity really is dp/dt.
 *
 * Worth doing on every analytic family: a sign slip in a hand-differentiated
 * expression produces a trajectory that still looks plausible when drawn.
 */
function expectDerivativesConsistent(trajectory: Trajectory, time: number, digits = 5): void {
  const h = 1e-5;
  const before = trajectory.sampleAt(time - h);
  const after = trajectory.sampleAt(time + h);
  const here = trajectory.sampleAt(time);

  expect(here.velocity.x).toBeCloseTo((after.position.x - before.position.x) / (2 * h), digits);
  expect(here.velocity.y).toBeCloseTo((after.position.y - before.position.y) / (2 * h), digits);
  expect(here.velocity.z).toBeCloseTo((after.position.z - before.position.z) / (2 * h), digits);

  expect(here.acceleration.x).toBeCloseTo((after.velocity.x - before.velocity.x) / (2 * h), digits);
  expect(here.acceleration.y).toBeCloseTo((after.velocity.y - before.velocity.y) / (2 * h), digits);
  expect(here.acceleration.z).toBeCloseTo((after.velocity.z - before.velocity.z) / (2 * h), digits);
}

describe('stationary', () => {
  const trajectory = build({
    kind: 'stationary',
    position: { x: 10, y: 20, z: 30 } as never,
  });

  it('holds position for all time', () => {
    for (const time of [0, 1, 999, -50]) {
      const sample = trajectory.sampleAt(time);
      expectVec(sample.position, 10, 20, 30);
      expectVec(sample.velocity, 0, 0, 0);
      expectVec(sample.acceleration, 0, 0, 0);
    }
  });
});

describe('linear', () => {
  const trajectory = build({
    kind: 'linear',
    position: { x: 0, y: 100, z: 50 } as never,
    velocity: { x: 10, y: -5, z: 2 } as never,
  });

  it('matches p = p0 + v0 t at known times', () => {
    expectVec(trajectory.sampleAt(0).position, 0, 100, 50);
    expectVec(trajectory.sampleAt(10).position, 100, 50, 70);
    expectVec(trajectory.sampleAt(2.5).position, 25, 87.5, 55);
  });

  it('holds velocity constant with no acceleration', () => {
    expectVec(trajectory.sampleAt(37).velocity, 10, -5, 2);
    expectVec(trajectory.sampleAt(37).acceleration, 0, 0, 0);
  });

  it('has consistent derivatives', () => {
    expectDerivativesConsistent(trajectory, 4);
  });
});

describe('circular', () => {
  // A horizontal circle: normal along Up, so the motion stays at constant
  // altitude and the basis vectors are the two horizontal axes.
  const radius = 400;
  const angularRate = 0.25;
  const trajectory = build({
    kind: 'circular',
    center: { x: 0, y: 1000, z: 100 } as never,
    radius: radius as never,
    angularRate: angularRate as never,
    planeNormal: { x: 0, y: 0, z: 1 },
    initialPhase: 0 as never,
  });

  it('stays on the circle', () => {
    for (const time of [0, 3, 7.5, 19, 100]) {
      const sample = trajectory.sampleAt(time);
      const offset = subtract(sample.position, vec3(0, 1000, 100));
      expect(length(offset)).toBeCloseTo(radius, 8);
    }
  });

  it('holds altitude for a horizontal plane', () => {
    for (const time of [0, 5, 11, 40]) {
      expect(trajectory.sampleAt(time).position.z).toBeCloseTo(100, 8);
    }
  });

  it('moves at speed R*omega, perpendicular to the radius', () => {
    const sample = trajectory.sampleAt(6);
    expect(length(sample.velocity)).toBeCloseTo(radius * angularRate, 8);

    const radial = subtract(sample.position, vec3(0, 1000, 100));
    const dotProduct =
      radial.x * sample.velocity.x + radial.y * sample.velocity.y + radial.z * sample.velocity.z;
    expect(dotProduct).toBeCloseTo(0, 6);
  });

  it('accelerates centripetally at omega^2 R toward the centre', () => {
    // Checking the physics rather than the formula: a sign error would satisfy
    // the expression and point the target outward.
    const sample = trajectory.sampleAt(9);
    expect(length(sample.acceleration)).toBeCloseTo(angularRate * angularRate * radius, 8);

    const towardCentre = subtract(vec3(0, 1000, 100), sample.position);
    const cosine =
      (towardCentre.x * sample.acceleration.x +
        towardCentre.y * sample.acceleration.y +
        towardCentre.z * sample.acceleration.z) /
      (length(towardCentre) * length(sample.acceleration));
    expect(cosine).toBeCloseTo(1, 8);
  });

  it('returns to the start after one period', () => {
    const period = (2 * Math.PI) / angularRate;
    const start = trajectory.sampleAt(0).position;
    const later = trajectory.sampleAt(period).position;
    expectVec(later, start.x, start.y, start.z, 6);
  });

  it('works in a tilted plane', () => {
    const tilted = build({
      kind: 'circular',
      center: { x: 0, y: 500, z: 200 } as never,
      radius: 150 as never,
      angularRate: 0.4 as never,
      planeNormal: { x: 0.3, y: 0.2, z: 0.9 },
      initialPhase: 1.1 as never,
    });

    for (const time of [0, 2, 13]) {
      const offset = subtract(tilted.sampleAt(time).position, vec3(0, 500, 200));
      expect(length(offset)).toBeCloseTo(150, 8);
      // The motion must stay in the plane: the offset is perpendicular to the
      // normal throughout.
      expect(offset.x * 0.3 + offset.y * 0.2 + offset.z * 0.9).toBeCloseTo(0, 6);
    }
  });

  it('has consistent derivatives', () => {
    expectDerivativesConsistent(trajectory, 3.3, 4);
  });
});

describe('sinusoidal', () => {
  const amplitude = 120;
  const frequency = 0.05;
  const trajectory = build({
    kind: 'sinusoidal',
    position: { x: 0, y: 2000, z: 90 } as never,
    velocity: { x: 0, y: -25, z: 0 } as never,
    components: [
      {
        axis: { x: 1, y: 0, z: 0 },
        amplitude: amplitude as never,
        frequency: frequency as never,
        phase: 0 as never,
      },
    ],
  });

  it('matches the base motion where the sinusoid is zero', () => {
    expectVec(trajectory.sampleAt(0).position, 0, 2000, 90, 8);
  });

  it('reaches peak displacement at a quarter period', () => {
    const quarterPeriod = 1 / (4 * frequency);
    expect(trajectory.sampleAt(quarterPeriod).position.x).toBeCloseTo(amplitude, 6);
  });

  it('carries the base velocity through', () => {
    const sample = trajectory.sampleAt(12.5);
    expect(sample.velocity.y).toBeCloseTo(-25, 9);
  });

  it('peaks in speed as it crosses zero displacement', () => {
    const omega = 2 * Math.PI * frequency;
    expect(trajectory.sampleAt(0).velocity.x).toBeCloseTo(amplitude * omega, 6);
  });

  it('accelerates as -omega^2 times the displacement', () => {
    const omega = 2 * Math.PI * frequency;
    const time = 7.3;
    const sample = trajectory.sampleAt(time);
    const displacement = sample.position.x;
    expect(sample.acceleration.x).toBeCloseTo(-omega * omega * displacement, 6);
  });

  it('superimposes several components', () => {
    const multi = build({
      kind: 'sinusoidal',
      position: { x: 0, y: 0, z: 0 } as never,
      velocity: { x: 0, y: 0, z: 0 } as never,
      components: [
        {
          axis: { x: 1, y: 0, z: 0 },
          amplitude: 10 as never,
          frequency: 0.25 as never,
          phase: 0 as never,
        },
        {
          axis: { x: 0, y: 0, z: 1 },
          amplitude: 4 as never,
          frequency: 0.5 as never,
          phase: (Math.PI / 2) as never,
        },
      ],
    });

    // At t = 1: first component sin(pi/2) = 1 -> x = 10.
    // Second: sin(pi + pi/2) = -1 -> z = -4.
    const sample = multi.sampleAt(1);
    expect(sample.position.x).toBeCloseTo(10, 8);
    expect(sample.position.z).toBeCloseTo(-4, 8);
  });

  it('has consistent derivatives', () => {
    expectDerivativesConsistent(trajectory, 5.5, 4);
  });
});

describe('waypoint', () => {
  const trajectory = build({
    kind: 'waypoint',
    loop: false,
    waypoints: [
      { position: { x: 0, y: 0, z: 0 } as never, arrivalTime: 0 as never },
      { position: { x: 100, y: 0, z: 0 } as never, arrivalTime: 10 as never },
      { position: { x: 100, y: 200, z: 50 } as never, arrivalTime: 30 as never },
    ],
  });

  it('sits on each waypoint at its arrival time', () => {
    expectVec(trajectory.sampleAt(0).position, 0, 0, 0);
    expectVec(trajectory.sampleAt(10).position, 100, 0, 0);
    expectVec(trajectory.sampleAt(30).position, 100, 200, 50);
  });

  it('interpolates linearly inside a segment', () => {
    expectVec(trajectory.sampleAt(5).position, 50, 0, 0);
    expectVec(trajectory.sampleAt(20).position, 100, 100, 25);
  });

  it('holds a constant velocity within a segment', () => {
    expectVec(trajectory.sampleAt(2).velocity, 10, 0, 0);
    expectVec(trajectory.sampleAt(8).velocity, 10, 0, 0);
    expectVec(trajectory.sampleAt(15).velocity, 0, 10, 2.5);
  });

  it('reports zero acceleration, the documented cost of the linear model', () => {
    expectVec(trajectory.sampleAt(4).acceleration, 0, 0, 0);
  });

  it('holds the endpoints outside the schedule', () => {
    expectVec(trajectory.sampleAt(-5).position, 0, 0, 0);
    expectVec(trajectory.sampleAt(500).position, 100, 200, 50);
    expectVec(trajectory.sampleAt(500).velocity, 0, 0, 0);
  });

  it('wraps when looping', () => {
    const looping = build({
      kind: 'waypoint',
      loop: true,
      waypoints: [
        { position: { x: 0, y: 0, z: 0 } as never, arrivalTime: 0 as never },
        { position: { x: 100, y: 0, z: 0 } as never, arrivalTime: 10 as never },
      ],
    });

    expectVec(looping.sampleAt(15).position, 50, 0, 0);
    expectVec(looping.sampleAt(25).position, 50, 0, 0);
  });

  it('refuses waypoints that do not advance in time', () => {
    expect(() =>
      build({
        kind: 'waypoint',
        loop: false,
        waypoints: [
          { position: { x: 0, y: 0, z: 0 } as never, arrivalTime: 5 as never },
          { position: { x: 1, y: 0, z: 0 } as never, arrivalTime: 5 as never },
        ],
      }),
    ).toThrow(RangeError);
  });

  it('refuses a single waypoint', () => {
    expect(() =>
      build({
        kind: 'waypoint',
        loop: false,
        waypoints: [{ position: { x: 0, y: 0, z: 0 } as never, arrivalTime: 0 as never }],
      }),
    ).toThrow(RangeError);
  });
});

describe('seeded manoeuvre', () => {
  const options = {
    initialPosition: vec3(0, 1500, 120),
    initialVelocity: vec3(18, 0, 0),
    maxAcceleration: 6,
    maxSpeed: 45,
    minSegmentDuration: 1.5,
    maxSegmentDuration: 5,
    boundsRadius: 2200,
    duration: 120,
  };

  it('is completely determined by the seed', () => {
    const first = generateManeuverSchedule(stream(4242), options);
    const second = generateManeuverSchedule(stream(4242), options);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('differs under a different seed', () => {
    const first = generateManeuverSchedule(stream(1), options);
    const second = generateManeuverSchedule(stream(2), options);
    expect(JSON.stringify(second)).not.toBe(JSON.stringify(first));
  });

  it('covers the requested duration', () => {
    const schedule = generateManeuverSchedule(stream(), options);
    expect(schedule.terminalTime).toBeGreaterThanOrEqual(options.duration);
  });

  it('respects the configured limits', () => {
    const schedule = generateManeuverSchedule(stream(99), options);
    for (const segment of schedule.segments) {
      expect(segment.duration).toBeGreaterThanOrEqual(options.minSegmentDuration);
      expect(segment.duration).toBeLessThanOrEqual(options.maxSegmentDuration);
      expect(length(segment.acceleration)).toBeLessThanOrEqual(options.maxAcceleration + 1e-9);
      expect(length(segment.startVelocity)).toBeLessThanOrEqual(options.maxSpeed + 1e-9);
    }
  });

  it('takes a fixed number of draws per segment', () => {
    // A variable draw count would make the stream cursor depend on the path the
    // target happened to take, which would break resume.
    const generator = stream(7);
    const schedule = generateManeuverSchedule(generator, options);
    expect(generator.drawCount).toBe(schedule.segments.length * 4);
  });

  it('is continuous across segment boundaries', () => {
    const trajectory = new SeededManeuverTrajectory(generateManeuverSchedule(stream(17), options));
    for (const segment of trajectory.schedule.slice(1, 8)) {
      const before = trajectory.sampleAt(segment.startTime - 1e-6);
      const after = trajectory.sampleAt(segment.startTime + 1e-6);
      expect(length(subtract(after.position, before.position))).toBeLessThan(1e-3);
    }
  });

  it('has position, velocity and acceleration that agree inside a segment', () => {
    const trajectory = new SeededManeuverTrajectory(generateManeuverSchedule(stream(23), options));
    const segment = trajectory.schedule[3]!;
    expectDerivativesConsistent(trajectory, segment.startTime + segment.duration / 2, 4);
  });

  it('exposes its schedule for the debug inspector', () => {
    const trajectory = new SeededManeuverTrajectory(generateManeuverSchedule(stream(5), options));
    expect(trajectory.schedule.length).toBeGreaterThan(0);
    expect(trajectory.schedule[0]!.index).toBe(0);
    expect(trajectory.describe()).toContain('segments');
  });

  it('coasts at constant velocity past the end of its schedule', () => {
    // Extrapolating the last leg's acceleration instead would accelerate
    // without bound, which a long run turns into a speed of many hundreds of
    // metres per second.
    const schedule = generateManeuverSchedule(stream(13), options);
    const trajectory = new SeededManeuverTrajectory(schedule);

    const atEnd = trajectory.sampleAt(schedule.terminalTime);
    const wellPast = trajectory.sampleAt(schedule.terminalTime + 400);

    expectVec(wellPast.acceleration, 0, 0, 0);
    expect(length(wellPast.velocity)).toBeCloseTo(length(atEnd.velocity), 9);
    expect(length(wellPast.velocity)).toBeLessThanOrEqual(options.maxSpeed + 1e-9);

    // Continuous across the boundary.
    const justBefore = trajectory.sampleAt(schedule.terminalTime - 1e-6);
    expect(length(subtract(atEnd.position, justBefore.position))).toBeLessThan(1e-3);
  });

  it('samples independently of the order it is sampled in', () => {
    // Purity is what allows the renderer to interpolate and a future Replay
    // view to scrub backwards.
    const trajectory = new SeededManeuverTrajectory(generateManeuverSchedule(stream(31), options));
    const forward = [0, 5, 10, 20, 40].map((t) => trajectory.sampleAt(t).position.x);
    const backward = [40, 20, 10, 5, 0].map((t) => trajectory.sampleAt(t).position.x).reverse();
    expect(backward).toEqual(forward);
  });
});
