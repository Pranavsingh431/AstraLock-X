// @vitest-environment node
/**
 * Long-run stability.
 *
 * A tracking failure worth studying is usually rare, so runs are long. This
 * exercises a scenario well past any interactive session to check that nothing
 * degrades quietly: no NaN creeping in from a division, no unbounded drift, and
 * no dependence on how the run was executed.
 *
 * Determinism is asserted on this machine and this runtime. ADR-0004 already
 * limits floating-point reproducibility to per-architecture, so a cross-CPU
 * bit-identical claim would be one this project cannot honour.
 */

import { describe, expect, it } from 'vitest';

import { seconds } from '@/core/contracts/units';
import type { SimulationConfig } from '@/core/contracts/simulation';
import { loadScenario } from '@/scenarios';

import { SimulationEngine } from './engine';

/** 100,000 ticks at 200 Hz is 500 s of simulated flight. */
const LONG_RUN_TICKS = 100_000;
const LONG_RUN_SECONDS = 500;

/**
 * The manoeuvring scenario, declared long enough to cover the whole run.
 *
 * The bundled scenario runs for 120 s, and past the end of its schedule the
 * target coasts. Coasting is the right behaviour but it is not the regime worth
 * stress-testing, so the duration is extended here to keep the manoeuvre
 * generator active for every one of the 100,000 ticks.
 */
function longManeuverConfig(): SimulationConfig {
  return { ...loadScenario('seeded-maneuver'), duration: seconds(LONG_RUN_SECONDS) };
}

/**
 * The circular scenario, likewise extended to cover the run.
 *
 * A run stops at its configured duration, so stepping 100,000 ticks against a
 * 120 s scenario would quietly stop at 24,000 and the test would still pass
 * while exercising a quarter of what it claims to.
 */
function longCircularConfig(): SimulationConfig {
  return { ...loadScenario('circular'), duration: seconds(LONG_RUN_SECONDS) };
}

describe('long run', () => {
  it('stays numerically healthy over 100,000 ticks', () => {
    const engine = new SimulationEngine(longManeuverConfig());

    let worstSpeed = 0;
    let worstDistance = 0;

    for (let block = 0; block < 100; block += 1) {
      engine.step(1_000);
      const target = engine.snapshot().truth.targets[0]!;

      const position = target.pose.position;
      const velocity = target.velocity;

      expect(Number.isFinite(position.x)).toBe(true);
      expect(Number.isFinite(position.y)).toBe(true);
      expect(Number.isFinite(position.z)).toBe(true);
      expect(Number.isFinite(target.range)).toBe(true);
      expect(Number.isNaN(target.bearingFromGimbal.azimuth)).toBe(false);
      expect(Number.isNaN(target.bearingFromGimbal.elevation)).toBe(false);

      worstDistance = Math.max(worstDistance, Math.hypot(position.x, position.y, position.z));
      worstSpeed = Math.max(worstSpeed, Math.hypot(velocity.x, velocity.y, velocity.z));
    }

    expect(engine.tick).toBe(LONG_RUN_TICKS);
    expect(engine.isComplete).toBe(true);

    // The envelope is derived from the configuration, not fitted to the run.
    //
    // Speed is clamped to maxSpeed at every segment boundary, so within a
    // segment it can reach at most maxSpeed + maxAcceleration * maxDuration.
    //
    // Distance needs more care. The homeward override is evaluated once per
    // segment, so the target can sit just inside boundsRadius when checked,
    // travel one whole segment outward, and then travel a second segment
    // outward while the override is decelerating it. Two segments of
    // worst-case outward travel is therefore the correct bound; one is not,
    // and assuming one is what this assertion originally got wrong.
    const trajectory = longManeuverConfig().targets[0]!.trajectory;
    if (trajectory.kind !== 'seeded-maneuver') throw new Error('scenario changed shape');

    const { maxSpeed, maxAcceleration, maxSegmentDuration, boundsRadius } = trajectory;
    const speedCeiling = maxSpeed + maxAcceleration * maxSegmentDuration;
    const travelPerSegment =
      speedCeiling * maxSegmentDuration + 0.5 * maxAcceleration * maxSegmentDuration ** 2;
    const distanceCeiling = boundsRadius + 2 * travelPerSegment;

    expect(worstSpeed).toBeLessThanOrEqual(speedCeiling);
    expect(worstDistance).toBeLessThanOrEqual(distanceCeiling);
    // The bound must actually constrain: a ceiling the run could never reach
    // would pass whatever the simulation did.
    expect(worstDistance).toBeGreaterThan(boundsRadius * 0.5);
  });

  it('repeats bit-for-bit on this runtime', () => {
    const first = new SimulationEngine(longManeuverConfig());
    first.step(LONG_RUN_TICKS);

    const second = new SimulationEngine(longManeuverConfig());
    second.step(LONG_RUN_TICKS);

    expect(second.stateHash()).toBe(first.stateHash());
  });

  it('reaches the same state in one jump as in many steps', () => {
    const jumped = new SimulationEngine(longCircularConfig());
    jumped.step(LONG_RUN_TICKS);

    const stepped = new SimulationEngine(longCircularConfig());
    for (let block = 0; block < LONG_RUN_TICKS / 500; block += 1) stepped.step(500);

    expect(stepped.stateHash()).toBe(jumped.stateHash());
  });

  it('does not accumulate state as it runs', () => {
    // Nothing should grow per tick. The manoeuvre schedule is generated once at
    // construction and is the only per-run collection.
    const engine = new SimulationEngine(longManeuverConfig());
    const scheduleLength = engine.trajectoryAt(0)?.describe();

    engine.step(LONG_RUN_TICKS);

    expect(engine.trajectoryAt(0)?.describe()).toBe(scheduleLength);
    expect(Object.keys(engine.randomStreamCursors())).toHaveLength(5);
    // The trajectory stream is drawn once at construction, never per tick.
    expect(engine.randomStreamCursors()['sensor']).toBe(0);
  });

  it('keeps an analytic trajectory exactly on its closed form after a long run', () => {
    // Drift would show here as a departure from the circle, which is the classic
    // symptom of integrating instead of evaluating.
    const engine = new SimulationEngine(longCircularConfig());
    engine.step(LONG_RUN_TICKS);

    const config = loadScenario('circular').targets[0]!.trajectory;
    if (config.kind !== 'circular') throw new Error('scenario changed shape');

    const position = engine.snapshot().truth.targets[0]!.pose.position;
    const offset = Math.hypot(
      position.x - config.center.x,
      position.y - config.center.y,
      position.z - config.center.z,
    );

    expect(offset).toBeCloseTo(config.radius, 6);
  });
});
