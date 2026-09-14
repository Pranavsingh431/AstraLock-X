// @vitest-environment node
/**
 * The latency-aware pointing controller.
 *
 * Two properties carry the phase. The feed-forward term must be *exactly* the
 * motion the target is expected to make during the actuation delay — no more,
 * because the feedback term is already closing the present error, and
 * double-counting the same motion is the classic way a feed-forward loop
 * overshoots. And for a stationary target it must vanish, so adding prediction
 * cannot make the easy case worse.
 *
 * The last case is the one that justifies the whole design: for a moving target
 * and a known actuation delay, commanding the predicted bearing must land
 * nearer the target's future position than commanding its present one.
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_ASTRALOCK_CONFIG } from './config';
import { PointingController, type PointingControllerConfig } from './controller';

const LIMITS = {
  azimuth: { minAngle: -3, maxAngle: 3 },
  elevation: { minAngle: -0.35, maxAngle: 1.39 },
};

const config = (patch: Partial<PointingControllerConfig> = {}): PointingControllerConfig => ({
  ...DEFAULT_ASTRALOCK_CONFIG.controller,
  ...patch,
});

const bearing = (azimuth: number, elevation = 0) => ({ azimuth, elevation });

describe('the prediction horizon', () => {
  it('is the delay the controller actually knows about', () => {
    // Command latency plus the modelled servo lag. Both are engineering
    // quantities from configuration — not a measured host time, which belongs
    // to performance telemetry and has no place in a control law.
    const controller = new PointingController(config({ commandLatency: 0.023, servoLag: 0.04 }));
    expect(controller.horizon).toBeCloseTo(0.063, 12);
  });
});

describe('feed-forward', () => {
  it('vanishes for a stationary target', () => {
    // The non-regression property: prediction must not disturb the easy case.
    const controller = new PointingController(config());
    const step = controller.step({
      target: bearing(0.2),
      targetAtHorizon: bearing(0.2),
      measured: bearing(0.2),
      dt: 1 / 60,
      limits: LIMITS,
    });

    expect(step.feedforwardAzimuth).toBe(0);
    expect(step.feedforwardElevation).toBe(0);
  });

  it('is exactly the motion expected during the horizon', () => {
    // Not the target bearing, and not the error: the *difference* between where
    // the target will be and where it is. That is the only quantity the
    // feedback term is not already handling.
    const controller = new PointingController(config());
    const step = controller.step({
      target: bearing(0.2, 0.1),
      targetAtHorizon: bearing(0.23, 0.11),
      measured: bearing(0.2, 0.1),
      dt: 1 / 60,
      limits: LIMITS,
    });

    expect(step.feedforwardAzimuth).toBeCloseTo(0.03, 12);
    expect(step.feedforwardElevation).toBeCloseTo(0.01, 12);
  });

  it('does not double-count the present error', () => {
    // Feedback closes `target − measured`; feed-forward adds
    // `targetAtHorizon − target`. Together they reach the predicted bearing
    // once, not twice. With unit proportional gain and no integral the setpoint
    // should be the predicted bearing exactly.
    const controller = new PointingController(
      config({
        pan: { ...DEFAULT_ASTRALOCK_CONFIG.controller.pan, kp: 1, ki: 0, kd: 0 },
        tilt: { ...DEFAULT_ASTRALOCK_CONFIG.controller.tilt, kp: 1, ki: 0, kd: 0 },
      }),
    );

    const step = controller.step({
      target: bearing(0.25),
      targetAtHorizon: bearing(0.28),
      measured: bearing(0.2),
      dt: 1 / 60,
      limits: LIMITS,
    });

    // measured 0.20 + feedback (0.25 − 0.20) + feed-forward (0.28 − 0.25) = 0.28
    expect(step.setpointAzimuth).toBeCloseTo(0.28, 9);
  });

  it('can be switched off, leaving pure feedback', () => {
    const controller = new PointingController(config({ feedforward: false }));
    const step = controller.step({
      target: bearing(0.2),
      targetAtHorizon: bearing(0.5),
      measured: bearing(0.2),
      dt: 1 / 60,
      limits: LIMITS,
    });

    expect(step.feedforwardAzimuth).toBe(0);
  });

  it('takes the shortest arc in azimuth', () => {
    // A horizon that crosses ±π must be a small correction, not a near-2π one.
    const controller = new PointingController(config());
    const step = controller.step({
      target: bearing(Math.PI - 0.01),
      targetAtHorizon: bearing(-Math.PI + 0.01),
      measured: bearing(Math.PI - 0.01),
      dt: 1 / 60,
      limits: LIMITS,
    });

    expect(Math.abs(step.feedforwardAzimuth)).toBeCloseTo(0.02, 9);
  });
});

describe('feedback', () => {
  it('commands in the direction of the error', () => {
    const controller = new PointingController(config());
    const positive = controller.step({
      target: bearing(0.3),
      targetAtHorizon: bearing(0.3),
      measured: bearing(0.2),
      dt: 1 / 60,
      limits: LIMITS,
    });
    expect(positive.feedbackAzimuth).toBeGreaterThan(0);

    controller.reset();
    const negative = controller.step({
      target: bearing(0.1),
      targetAtHorizon: bearing(0.1),
      measured: bearing(0.2),
      dt: 1 / 60,
      limits: LIMITS,
    });
    expect(negative.feedbackAzimuth).toBeLessThan(0);
  });

  it('gets the tilt sign right too', () => {
    const controller = new PointingController(config());
    const step = controller.step({
      target: bearing(0, 0.2),
      targetAtHorizon: bearing(0, 0.2),
      measured: bearing(0, 0.1),
      dt: 1 / 60,
      limits: LIMITS,
    });
    expect(step.feedbackElevation).toBeGreaterThan(0);
  });

  it('is zero when there is no error', () => {
    const controller = new PointingController(config());
    const step = controller.step({
      target: bearing(0.2, 0.1),
      targetAtHorizon: bearing(0.2, 0.1),
      measured: bearing(0.2, 0.1),
      dt: 1 / 60,
      limits: LIMITS,
    });
    expect(step.feedbackAzimuth).toBe(0);
    expect(step.setpointAzimuth).toBeCloseTo(0.2, 12);
  });
});

describe('saturation and anti-windup', () => {
  it('clamps the commanded setpoint to the mount travel', () => {
    const controller = new PointingController(config());
    const step = controller.step({
      target: bearing(2.9),
      targetAtHorizon: bearing(2.9),
      measured: bearing(2.99),
      dt: 1 / 60,
      limits: { azimuth: { minAngle: -3, maxAngle: 3 }, elevation: LIMITS.elevation },
    });

    expect(step.setpointAzimuth).toBeLessThanOrEqual(3);
    expect(step.setpointAzimuth).toBeGreaterThanOrEqual(-3);
  });

  it('stops integrating while the output is saturated', () => {
    // Otherwise a mount held against a stop stores a demand that has to be
    // unwound before it will come back.
    const controller = new PointingController(config());
    const drive = (): void => {
      controller.step({
        target: bearing(2.0),
        targetAtHorizon: bearing(2.0),
        measured: bearing(0),
        dt: 0.1,
        limits: LIMITS,
      });
    };

    for (let i = 0; i < 30; i += 1) drive();
    const early = controller.integrals.azimuth;
    for (let i = 0; i < 300; i += 1) drive();

    expect(controller.integrals.azimuth).toBeCloseTo(early, 6);
  });

  it('never starts integrating when the very first step is already saturated', () => {
    // A large step error saturates immediately, so there is nothing to wind up
    // in the first place. The integral must stay at exactly zero rather than
    // accumulating and being clamped afterwards.
    const controller = new PointingController(config());
    for (let i = 0; i < 50; i += 1) {
      controller.step({
        target: bearing(2.0),
        targetAtHorizon: bearing(2.0),
        measured: bearing(0),
        dt: 0.1,
        limits: LIMITS,
      });
    }
    expect(controller.integrals.azimuth).toBe(0);
  });

  it('unwinds once the error reverses', () => {
    // A small, unsaturated error does accumulate; reversing it must bring the
    // integral back rather than leaving the mount leaning on a stale demand.
    const controller = new PointingController(config());
    const drive = (target: number): void => {
      controller.step({
        target: bearing(target),
        targetAtHorizon: bearing(target),
        measured: bearing(0),
        dt: 0.05,
        limits: LIMITS,
      });
    };

    for (let i = 0; i < 20; i += 1) drive(0.002);
    const wound = controller.integrals.azimuth;
    expect(wound).toBeGreaterThan(0);

    for (let i = 0; i < 5; i += 1) drive(-0.002);
    expect(controller.integrals.azimuth).toBeLessThan(wound);
  });

  it('reset clears the integrator', () => {
    const controller = new PointingController(config());
    for (let i = 0; i < 20; i += 1) {
      controller.step({
        target: bearing(0.3),
        targetAtHorizon: bearing(0.3),
        measured: bearing(0.2),
        dt: 0.1,
        limits: LIMITS,
      });
    }
    expect(controller.integrals.azimuth).not.toBe(0);

    controller.reset();
    expect(controller.integrals.azimuth).toBe(0);
  });
});

describe('timing', () => {
  it('survives a zero or non-finite interval', () => {
    const controller = new PointingController(config());
    for (const dt of [0, -1, Number.NaN]) {
      const step = controller.step({
        target: bearing(0.3),
        targetAtHorizon: bearing(0.3),
        measured: bearing(0.2),
        dt,
        limits: LIMITS,
      });
      expect(Number.isFinite(step.setpointAzimuth)).toBe(true);
    }
  });

  it('stays finite over a long run', () => {
    const controller = new PointingController(config());
    for (let i = 0; i < 100_000; i += 1) {
      const target = Math.sin(i / 200) * 0.4;
      const step = controller.step({
        target: bearing(target),
        targetAtHorizon: bearing(target + 0.001),
        measured: bearing(target * 0.98),
        dt: 1 / 60,
        limits: LIMITS,
      });
      expect(Number.isFinite(step.setpointAzimuth)).toBe(true);
    }
  });
});

describe('why the horizon is there at all', () => {
  it('lands nearer the future target than a zero-horizon command', () => {
    // The justification for the whole design, as arithmetic rather than
    // assertion. A target crossing at a constant angular rate, a mount that
    // will apply the command one horizon from now: commanding where the target
    // *is* is commanding where it *was* by the time the mount gets there.
    const rate = 0.08;
    const horizon = 0.063;
    const present = 0.3;
    const future = present + rate * horizon;

    const gains = {
      ...DEFAULT_ASTRALOCK_CONFIG.controller.pan,
      kp: 1,
      ki: 0,
      kd: 0,
    };
    const withHorizon = new PointingController(
      config({ pan: gains, tilt: gains, commandLatency: horizon, servoLag: 0 }),
    );
    const withoutHorizon = new PointingController(
      config({ pan: gains, tilt: gains, feedforward: false }),
    );

    const measured = bearing(present - 0.002);
    const predicted = withHorizon.step({
      target: bearing(present),
      targetAtHorizon: bearing(future),
      measured,
      dt: 1 / 60,
      limits: LIMITS,
    });
    const naive = withoutHorizon.step({
      target: bearing(present),
      targetAtHorizon: bearing(future),
      measured,
      dt: 1 / 60,
      limits: LIMITS,
    });

    expect(Math.abs(predicted.setpointAzimuth - future)).toBeLessThan(
      Math.abs(naive.setpointAzimuth - future),
    );
    // And it is not overshooting past the future bearing either.
    expect(predicted.setpointAzimuth).toBeLessThanOrEqual(future + 1e-9);
  });

  it('makes no difference when the target is not moving', () => {
    const still = 0.3;
    const gains = { ...DEFAULT_ASTRALOCK_CONFIG.controller.pan, kp: 1, ki: 0, kd: 0 };
    const withHorizon = new PointingController(config({ pan: gains, tilt: gains }));
    const withoutHorizon = new PointingController(
      config({ pan: gains, tilt: gains, feedforward: false }),
    );

    const args = {
      target: bearing(still),
      targetAtHorizon: bearing(still),
      measured: bearing(still - 0.002),
      dt: 1 / 60,
      limits: LIMITS,
    };

    expect(withHorizon.step(args).setpointAzimuth).toBeCloseTo(
      withoutHorizon.step(args).setpointAzimuth,
      12,
    );
  });

  it('scales the correction with the target rate', () => {
    const controller = new PointingController(config());
    const slow = controller.step({
      target: bearing(0.3),
      targetAtHorizon: bearing(0.301),
      measured: bearing(0.3),
      dt: 1 / 60,
      limits: LIMITS,
    });
    controller.reset();
    const fast = controller.step({
      target: bearing(0.3),
      targetAtHorizon: bearing(0.31),
      measured: bearing(0.3),
      dt: 1 / 60,
      limits: LIMITS,
    });

    expect(fast.feedforwardAzimuth).toBeCloseTo(10 * slow.feedforwardAzimuth, 9);
  });
});
