// @vitest-environment node
/**
 * A deliberately hostile consumer, and what it cannot get.
 *
 * The probe below stands in for a future tracking algorithm written by someone
 * trying to cheat. It is handed exactly what the harness will hand a plugin — a
 * `CameraSensorFrame` — and goes looking for the answer key: where the target
 * is, how far away, which emitter, where it truly projected, where it is going.
 *
 * Everything it finds must be something a real camera could have told it.
 */

import { describe, expect, it } from 'vitest';

import { findGroundTruthLeak, isGroundTruthTainted } from '@/core/contracts/isolation';
import type { CameraSensorFrame } from '@/core/contracts/sensors';
import { loadScenario } from '@/scenarios';
import { SimulationEngine } from '@/core/simulation/engine';

import { VirtualCameraSensor } from './virtual-camera';
import { ExactWorldSampler } from './world-sampler';

/** Every field name that would be a leak if it appeared on a frame. */
const FORBIDDEN_KEYS = [
  'target',
  'targets',
  'targetId',
  'emitter',
  'emitterId',
  'truth',
  'groundTruth',
  'range',
  'distance',
  'bearing',
  'azimuthTrue',
  'projected',
  'imageX',
  'imageY',
  'velocity',
  'trajectory',
  'position',
  'world',
  'visibility',
  'engine',
  'config',
];

/** Recursively collects every key reachable from a value. */
function reachableKeys(value: unknown, depth = 0, seen = new WeakSet<object>()): string[] {
  if (depth > 8 || typeof value !== 'object' || value === null) return [];
  if (seen.has(value)) return [];
  seen.add(value);
  if (ArrayBuffer.isView(value)) return [];

  const keys: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    keys.push(key, ...reachableKeys(child, depth + 1, seen));
  }
  return keys;
}

function captureFrame(): { frame: CameraSensorFrame; truthImageX: number | null } {
  const engine = new SimulationEngine(loadScenario('camera-boresight'));
  const sensor = new VirtualCameraSensor({ config: engine.config });
  engine.step(120);
  const capture = sensor.captureFrame(new ExactWorldSampler(engine), 4);
  return { frame: capture.frame, truthImageX: capture.truth.projections[0]!.imageX };
}

describe('what a hostile consumer can reach from a frame', () => {
  it('finds no field named after anything privileged', () => {
    const { frame } = captureFrame();
    const keys = new Set(reachableKeys(frame));

    for (const forbidden of FORBIDDEN_KEYS) {
      expect(keys.has(forbidden)).toBe(false);
    }
  });

  it('finds no ground-truth brand anywhere in the frame', () => {
    // The runtime guard, applied to the exact object a plugin receives.
    const { frame } = captureFrame();
    expect(isGroundTruthTainted(frame)).toBe(false);
    expect(findGroundTruthLeak(frame)).toBeNull();
    expect(findGroundTruthLeak({ handedToPlugin: frame })).toBeNull();
  });

  it('finds only pixels, timing, format, its own pose and a config id', () => {
    // Enumerated rather than sampled: a field added later has to be considered
    // here, which is the point of pinning the whole surface.
    const { frame } = captureFrame();
    expect(Object.keys(frame).sort()).toEqual(
      [
        'cameraConfigId',
        'captureTime',
        'data',
        'droppedSince',
        'exposure',
        'format',
        'frameId',
        'gain',
        'height',
        'pose',
        'width',
      ].sort(),
    );
  });

  it('cannot recover the true projected centre from the frame', () => {
    // The truth object holds it; the frame does not. A tracker has to centroid
    // the pixels, which is the whole job.
    const { frame, truthImageX } = captureFrame();
    expect(truthImageX).not.toBeNull();

    const serialised = JSON.stringify(frame, (key, value) =>
      key === 'data' ? '<pixels>' : (value as unknown),
    );
    expect(serialised).not.toContain(String(truthImageX));
  });

  it('gets a pose that is the mount reporting itself, not the target', () => {
    // Knowing where your own mount points is legitimate: a real system reads
    // its encoders. Knowing where the target is, is not.
    const { frame } = captureFrame();
    const scenario = loadScenario('camera-boresight');

    // Initial pointing now has a single source: the mount's own configuration.
    // The reported angle is an encoder reading, so it sits within half a count
    // of the configured angle rather than exactly on it — which is the point of
    // the true/measured split (ADR-0011), not a tolerance fudge.
    const panHalfCount = scenario.gimbal.pan.encoderResolution / 2;
    const tiltHalfCount = scenario.gimbal.tilt.encoderResolution / 2;
    expect(Math.abs(frame.pose.azimuth - scenario.gimbal.pan.initialAngle)).toBeLessThanOrEqual(
      panHalfCount,
    );
    expect(Math.abs(frame.pose.elevation - scenario.gimbal.tilt.initialAngle)).toBeLessThanOrEqual(
      tiltHalfCount,
    );
    expect(Object.keys(frame.pose).sort()).toEqual(['azimuth', 'elevation']);
  });

  it('survives being passed through a worker boundary unchanged', () => {
    // structuredClone is what postMessage uses; a truth object smuggled as a
    // non-enumerable property would not survive, but neither would it be there.
    const { frame } = captureFrame();
    const cloned: unknown = structuredClone({ ...frame, data: new Uint8Array(frame.data) });
    expect(findGroundTruthLeak(cloned)).toBeNull();
  });
});

describe('the capture pair is privileged', () => {
  it('is branded, so it cannot be handed to a plugin', () => {
    const engine = new SimulationEngine(loadScenario('camera-boresight'));
    const sensor = new VirtualCameraSensor({ config: engine.config });
    const capture = sensor.captureFrame(new ExactWorldSampler(engine), 0);

    expect(isGroundTruthTainted(capture)).toBe(true);
    expect(findGroundTruthLeak(capture)).toBe('');
  });

  it('carries the truth separately from the frame', () => {
    const engine = new SimulationEngine(loadScenario('camera-boresight'));
    const sensor = new VirtualCameraSensor({ config: engine.config });
    const capture = sensor.captureFrame(new ExactWorldSampler(engine), 0);

    expect(isGroundTruthTainted(capture.truth)).toBe(true);
    expect(isGroundTruthTainted(capture.frame)).toBe(false);
    // The frame is reachable from the pair but holds no reference back to it.
    expect(findGroundTruthLeak(capture.frame)).toBeNull();
  });

  it('records the answer key the frame withholds', () => {
    // Stating what the truth object is *for*: it is what evaluation will score
    // a centroid against, which is only meaningful if it is genuinely separate.
    const engine = new SimulationEngine(loadScenario('camera-boresight'));
    const sensor = new VirtualCameraSensor({ config: engine.config });
    const { truth } = sensor.captureFrame(new ExactWorldSampler(engine), 0);

    const projection = truth.projections[0]!;
    expect(projection.visibility).toBe('visible');
    expect(projection.imageX).not.toBeNull();
    expect(projection.range).toBeGreaterThan(0);
    expect(projection.emitterId).toBe('emitter-0');
  });
});
