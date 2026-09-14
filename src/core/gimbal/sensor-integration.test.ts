// @vitest-environment node
/**
 * The mount and the camera, together.
 *
 * Separately, each is easy to get right. The thing that actually matters is
 * whether the *image* shows the mount's behaviour — because the image is the
 * only thing a future tracking algorithm will ever see. A mount with perfect
 * dynamics feeding a camera that quietly pointed itself somewhere else would
 * pass every test in actuator.test.ts and be worthless.
 *
 * So these cases command the mount and then look at pixels.
 */

import { describe, expect, it } from 'vitest';

import { loadScenario } from '@/scenarios';
import { SimulationEngine } from '@/core/simulation/engine';
import { VirtualCameraSensor } from '@/core/sensors/virtual-camera';
import { ExactWorldSampler } from '@/core/sensors/world-sampler';

/** Intensity-weighted horizontal centroid, or null on an empty frame. */
function centroidX(data: Uint8Array, width: number): number | null {
  let weighted = 0;
  let total = 0;
  for (let index = 0; index < data.length; index += 1) {
    const value = data[index]!;
    if (value === 0) continue;
    weighted += (index % width) * value;
    total += value;
  }
  return total === 0 ? null : weighted / total;
}

interface Rig {
  readonly engine: SimulationEngine;
  readonly sensor: VirtualCameraSensor;
  readonly sampler: ExactWorldSampler;
  /** Advances the world and returns the beacon's horizontal centroid. */
  readonly step: (ticks: number) => number | null;
}

function rig(scenarioId: 'gimbal-step-response' | 'gimbal-latency' | 'gimbal-backlash'): Rig {
  const engine = new SimulationEngine(loadScenario(scenarioId));
  const sensor = new VirtualCameraSensor({ config: engine.config });
  const sampler = new ExactWorldSampler(engine);
  let frameIndex = 0;

  return {
    engine,
    sensor,
    sampler,
    step: (ticks) => {
      engine.step(ticks);
      frameIndex += 1;
      const capture = sensor.captureFrame(sampler, frameIndex);
      try {
        return centroidX(capture.frame.data as Uint8Array, capture.frame.width);
      } finally {
        capture.release();
      }
    },
  };
}

// --- A ----------------------------------------------------------------------

describe('A. the image does not teleport', () => {
  it('moves the beacon gradually across frames after a step command', () => {
    const { engine, step } = rig('gimbal-step-response');

    const start = step(1);
    expect(start).not.toBeNull();

    engine.gimbal.commandPosition(0.03, engine.config.gimbal.tilt.initialAngle);

    // Each frame's motion must be a fraction of the total, not all of it at
    // once. An ideal mount would put the whole displacement in frame one.
    const positions: number[] = [start!];
    for (let index = 0; index < 40; index += 1) {
      const x = step(4);
      if (x !== null) positions.push(x);
    }

    const total = Math.abs(positions[positions.length - 1]! - positions[0]!);
    expect(total).toBeGreaterThan(5);

    const firstMove = Math.abs(positions[1]! - positions[0]!);
    expect(firstMove).toBeLessThan(total / 4);
  });

  it('never jumps by more than the rate limit allows between frames', () => {
    const { engine, step, sensor } = rig('gimbal-step-response');
    step(1);
    engine.gimbal.commandPosition(0.05, engine.config.gimbal.tilt.initialAngle);

    const ticksPerSample = 4;
    const interval = ticksPerSample / engine.config.tickRate;
    // Pixels per radian at the image centre.
    const focal = sensor.intrinsics.fx;
    const bound = engine.config.gimbal.pan.maxRate * interval * focal * 1.05;

    let previous = step(ticksPerSample);
    for (let index = 0; index < 60; index += 1) {
      const current = step(ticksPerSample);
      if (previous !== null && current !== null) {
        expect(Math.abs(current - previous)).toBeLessThanOrEqual(bound);
      }
      previous = current;
    }
  });
});

// --- B ----------------------------------------------------------------------

describe('B. latency is visible in the image', () => {
  it('shows nothing moving until the command falls due', () => {
    const { engine, step } = rig('gimbal-latency');
    const latency = engine.config.gimbal.commandLatency;
    expect(latency).toBeGreaterThan(0);

    const before = step(1);
    engine.gimbal.commandPosition(0.04, engine.config.gimbal.tilt.initialAngle);

    // Well inside the delay: the picture must be identical, not merely similar.
    const ticksInsideDelay = Math.floor((latency * engine.config.tickRate) / 2);
    const during = step(ticksInsideDelay);
    expect(during).toBeCloseTo(before!, 9);

    // Past it: the picture has moved.
    const after = step(ticksInsideDelay * 4);
    expect(Math.abs(after! - before!)).toBeGreaterThan(1);
  });
});

// --- C ----------------------------------------------------------------------

describe('C. true drives the image, measured goes on the frame', () => {
  it('reports an encoder reading that differs from the pose forming the image', () => {
    const engine = new SimulationEngine(loadScenario('gimbal-backlash'));
    const sensor = new VirtualCameraSensor({ config: engine.config });
    const sampler = new ExactWorldSampler(engine);

    engine.gimbal.commandPosition(0.037, engine.config.gimbal.tilt.initialAngle);
    engine.step(120);

    const capture = sensor.captureFrame(sampler, 12);
    try {
      const reported = capture.frame.pose.azimuth;
      const trueAngle = capture.truth.cameraAzimuth;
      const resolution = engine.config.gimbal.pan.encoderResolution;

      // Quantised, within half a count, and genuinely not the same number.
      expect(Math.abs(reported / resolution - Math.round(reported / resolution))).toBeLessThan(
        1e-9,
      );
      expect(Math.abs(reported - trueAngle)).toBeLessThanOrEqual(resolution / 2 + 1e-12);
      expect(reported).not.toBe(trueAngle);
    } finally {
      capture.release();
    }
  });

  it('forms the image from the true pose, so the frame cannot be used to undo the quantisation', () => {
    // Projecting from the reported angle would make the encoder error
    // invisible — and would hand a tracker a pose that exactly explains its
    // own pixels, which no real system gets.
    const engine = new SimulationEngine(loadScenario('gimbal-backlash'));
    const sensor = new VirtualCameraSensor({ config: engine.config });
    const sampler = new ExactWorldSampler(engine);

    engine.gimbal.commandPosition(0.02, engine.config.gimbal.tilt.initialAngle);
    engine.step(200);

    const capture = sensor.captureFrame(sampler, 20);
    try {
      expect(capture.truth.cameraAzimuth).toBe(engine.gimbal.truePointing().panAngle);
      expect(capture.frame.pose.azimuth).not.toBe(engine.gimbal.truePointing().panAngle);
    } finally {
      capture.release();
    }
  });

  it('carries no actuator interior on the frame', () => {
    const engine = new SimulationEngine(loadScenario('gimbal-backlash'));
    const sensor = new VirtualCameraSensor({ config: engine.config });
    engine.step(20);

    const capture = sensor.captureFrame(new ExactWorldSampler(engine), 2);
    try {
      const keys = Object.keys(capture.frame.pose);
      expect(keys.sort()).toEqual(['azimuth', 'elevation']);

      // The scenario id legitimately contains the word "backlash", so the
      // search is for the interior's own field names rather than for a
      // substring that the configuration identifier would match by accident.
      const serialised = JSON.stringify({ ...capture.frame, data: undefined });
      for (const forbidden of [
        'motorAngle',
        'motorRate',
        'backlashDisplacement',
        'setpoint',
        'commandedAcceleration',
        'encoderError',
      ]) {
        expect(serialised).not.toContain(forbidden);
      }
    } finally {
      capture.release();
    }
  });
});

// --- D ----------------------------------------------------------------------

describe('D. backlash is visible in the image', () => {
  it('holds the picture still while the gearing is taken up', () => {
    const { engine, step } = rig('gimbal-backlash');
    const tilt = engine.config.gimbal.tilt.initialAngle;
    expect(engine.config.gimbal.pan.backlash).toBeGreaterThan(0);

    engine.gimbal.commandPosition(0.03, tilt);
    for (let index = 0; index < 60; index += 1) step(4);
    const settled = step(4);

    // Reverse, and watch for frames where the motor is moving and the picture
    // is not.
    engine.gimbal.commandPosition(-0.03, tilt);
    let stationaryFrames = 0;
    let previous = settled;
    for (let index = 0; index < 30; index += 1) {
      const motorBefore = engine.gimbal.truth().pan.motorAngle;
      const current = step(2);
      const motorMoved = Math.abs(engine.gimbal.truth().pan.motorAngle - motorBefore) > 1e-6;
      if (motorMoved && previous !== null && current !== null && current === previous) {
        stationaryFrames += 1;
      }
      previous = current;
    }

    expect(stationaryFrames).toBeGreaterThan(0);
  });
});

// --- E ----------------------------------------------------------------------

describe('E. travel limits are visible in the image', () => {
  it('stops the picture at the stop, however far it is commanded', () => {
    const { engine, step } = rig('gimbal-step-response');
    const tilt = engine.config.gimbal.tilt;

    // Command far past the tilt stop.
    engine.gimbal.commandPosition(0, tilt.maxAngle + 5);
    for (let index = 0; index < 200; index += 1) step(4);

    expect(engine.gimbal.truePointing().tiltAngle).toBeLessThanOrEqual(tilt.maxAngle + 1e-9);
    expect(engine.gimbal.truth().tilt.atMaxLimit).toBe(true);
    expect(engine.gimbal.lastApplied?.tiltClamped).toBe(true);
  });
});

// --- F ----------------------------------------------------------------------

describe('F. capture between ticks', () => {
  it('interpolates the mount, because a stateful mechanism has no closed form', () => {
    const engine = new SimulationEngine(loadScenario('gimbal-step-response'));
    const sampler = new ExactWorldSampler(engine);

    engine.gimbal.commandPosition(0.05, engine.config.gimbal.tilt.initialAngle);
    engine.step(20);

    const tick = 1 / engine.config.tickRate;
    const earlier = engine.time - tick;
    const middle = engine.time - tick / 2;

    const a = sampler.sampleAt(earlier).cameraPose.trueAzimuth;
    const b = sampler.sampleAt(middle).cameraPose.trueAzimuth;
    const c = sampler.sampleAt(engine.time).cameraPose.trueAzimuth;

    // Strictly between the bracketing samples, and halfway along.
    expect(b).toBeGreaterThan(Math.min(a, c));
    expect(b).toBeLessThan(Math.max(a, c));
    expect(b).toBeCloseTo((a + c) / 2, 12);
  });

  it('clamps rather than extrapolating past the history', () => {
    const engine = new SimulationEngine(loadScenario('gimbal-step-response'));
    engine.gimbal.commandPosition(0.05, engine.config.gimbal.tilt.initialAngle);
    engine.step(10);

    const now = engine.gimbal.truePointingAt(engine.time);
    const future = engine.gimbal.truePointingAt(engine.time + 5);
    expect(future.panAngle).toBe(now.panAngle);
  });

  it('gives a frame taken between ticks a pose from that instant', () => {
    // The camera clock is independent of the physics tick, so most frames land
    // between ticks; a pose snapped to the nearest tick would be a timing error
    // baked into the data a tracker is scored on.
    const engine = new SimulationEngine(loadScenario('gimbal-step-response'));
    const sensor = new VirtualCameraSensor({ config: engine.config });
    const sampler = new ExactWorldSampler(engine);

    engine.gimbal.commandPosition(0.05, engine.config.gimbal.tilt.initialAngle);
    engine.step(40);

    const captureTime = sensor.clock.captureTime(7);
    const tick = 1 / engine.config.tickRate;
    expect(Math.abs(captureTime / tick - Math.round(captureTime / tick))).toBeGreaterThan(1e-6);

    const capture = sensor.captureFrame(sampler, 7);
    try {
      expect(capture.truth.cameraAzimuth).toBe(engine.gimbal.truePointingAt(captureTime).panAngle);
    } finally {
      capture.release();
    }
  });
});

// --- G ----------------------------------------------------------------------

describe('G. headless', () => {
  it('runs the whole chain with no browser, deterministically', () => {
    // This file already runs in the node environment; the point is that the
    // same command script gives the same pixels twice.
    const runOnce = (): string => {
      const engine = new SimulationEngine(loadScenario('gimbal-latency'));
      const sensor = new VirtualCameraSensor({ config: engine.config });
      const sampler = new ExactWorldSampler(engine);
      const tilt = engine.config.gimbal.tilt.initialAngle;
      let digest = '';

      for (let index = 1; index <= 60; index += 1) {
        if (index === 5) engine.gimbal.commandPosition(0.04, tilt);
        if (index === 35) engine.gimbal.commandPosition(-0.02, tilt + 0.01);
        engine.step(4);

        const capture = sensor.captureFrame(sampler, index);
        try {
          const x = centroidX(capture.frame.data as Uint8Array, capture.frame.width);
          digest += `${String(x)}|${capture.frame.pose.azimuth.toExponential(17)};`;
        } finally {
          capture.release();
        }
      }
      return digest;
    };

    const first = runOnce();
    expect(runOnce()).toBe(first);
    expect(first).not.toContain('null');
  });

  it('needs no global beyond the language', () => {
    expect(typeof globalThis.window).toBe('undefined');
    expect(typeof globalThis.document).toBe('undefined');
  });
});
