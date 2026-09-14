import { describe, expect, it } from 'vitest';

import { type TrackingInput, guardTrackingInput } from './algorithm-plugin';
import { brandAsGroundTruth } from './ground-truth';
import {
  GROUND_TRUTH_BRAND,
  GroundTruthLeakError,
  assertGroundTruthFree,
  findGroundTruthLeak,
  isGroundTruthTainted,
} from './isolation';

/**
 * Wraps `leaf` in `depth` levels of `{ value: ... }`.
 *
 * Built iteratively on purpose: constructing it recursively would hit the same
 * call-stack limit the traversal under test has to survive.
 */
function buildDeep(depth: number, leaf: unknown): unknown {
  let node: unknown = leaf;
  for (let level = 0; level < depth; level += 1) {
    node = { value: node };
  }
  return node;
}

/**
 * Deeper than V8's default call stack, so a recursive traversal would throw
 * RangeError here rather than answer.
 */
const BEYOND_CALL_STACK = 20_000;

describe('isGroundTruthTainted', () => {
  it('recognises a branded object', () => {
    expect(isGroundTruthTainted(brandAsGroundTruth({ value: 1 }))).toBe(true);
  });

  it('rejects plain objects and primitives', () => {
    expect(isGroundTruthTainted({ value: 1 })).toBe(false);
    expect(isGroundTruthTainted(null)).toBe(false);
    expect(isGroundTruthTainted(42)).toBe(false);
    expect(isGroundTruthTainted('truth')).toBe(false);
    expect(isGroundTruthTainted(undefined)).toBe(false);
  });

  it('is not fooled by a falsy brand value', () => {
    expect(isGroundTruthTainted({ [GROUND_TRUTH_BRAND]: false })).toBe(false);
    expect(isGroundTruthTainted({ [GROUND_TRUTH_BRAND]: 'true' })).toBe(false);
  });
});

describe('findGroundTruthLeak', () => {
  it('returns null for clean structures', () => {
    expect(findGroundTruthLeak({ a: 1, b: [2, 3], c: { d: 'x' } })).toBeNull();
  });

  it('reports the empty path when the value itself is tainted', () => {
    expect(findGroundTruthLeak(brandAsGroundTruth({ a: 1 }))).toBe('');
  });

  it('finds a leak nested in an object and names the path', () => {
    const input = { camera: { state: brandAsGroundTruth({ azimuth: 0 }) } };
    expect(findGroundTruthLeak(input)).toBe('camera.state');
  });

  it('finds a leak inside an array and names the index', () => {
    const input = { targets: [{ ok: true }, brandAsGroundTruth({ range: 100 })] };
    expect(findGroundTruthLeak(input)).toBe('targets[1]');
  });

  it('reports the first leak in depth-first order', () => {
    const input = {
      alpha: { inner: brandAsGroundTruth({ n: 1 }) },
      beta: brandAsGroundTruth({ n: 2 }),
    };
    expect(findGroundTruthLeak(input)).toBe('alpha.inner');
  });
});

describe('findGroundTruthLeak: unbounded depth', () => {
  it('traverses a structure deeper than the call stack without throwing', () => {
    // A recursive walk would overflow here. The traversal is iterative so that
    // the boundary cannot fail by crashing any more than by missing a leak.
    expect(findGroundTruthLeak(buildDeep(BEYOND_CALL_STACK, { ok: true }))).toBeNull();
  });

  it('still finds ground truth at the bottom of such a structure', () => {
    const deep = buildDeep(BEYOND_CALL_STACK, brandAsGroundTruth({ tick: 0 }));
    const leak = findGroundTruthLeak(deep);

    expect(leak).not.toBeNull();
    // One `value` segment per level of nesting.
    expect(leak?.split('.')).toHaveLength(BEYOND_CALL_STACK);
  });
});

describe('findGroundTruthLeak: cycles', () => {
  it('terminates on a cyclic structure with no ground truth', () => {
    const cyclic: Record<string, unknown> = { name: 'loop' };
    cyclic['self'] = cyclic;
    expect(findGroundTruthLeak(cyclic)).toBeNull();
  });

  it('finds a leak reachable through a cycle', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    cyclic['truth'] = brandAsGroundTruth({ tick: 0 });
    expect(findGroundTruthLeak(cyclic)).toBe('truth');
  });

  it('terminates on mutually referencing objects', () => {
    const left: Record<string, unknown> = { name: 'left' };
    const right: Record<string, unknown> = { name: 'right', left };
    left['right'] = right;
    expect(findGroundTruthLeak(left)).toBeNull();
  });

  it('finds a leak behind a mutual reference', () => {
    const left: Record<string, unknown> = { name: 'left' };
    const right: Record<string, unknown> = { name: 'right', left };
    left['right'] = right;
    right['truth'] = brandAsGroundTruth({ tick: 1 });
    expect(findGroundTruthLeak(left)).toBe('right.truth');
  });

  it('terminates on a cycle formed through an array', () => {
    const nodes: unknown[] = [];
    nodes.push({ children: nodes });
    expect(findGroundTruthLeak(nodes)).toBeNull();
  });
});

describe('findGroundTruthLeak: collections and binary payloads', () => {
  it('finds ground truth stored as a Map value', () => {
    const input = { byId: new Map([['t1', brandAsGroundTruth({ range: 10 })]]) };
    expect(findGroundTruthLeak(input)).toBe('byId.get("t1")');
  });

  it('finds ground truth used as a Map key', () => {
    const input = { index: new Map([[brandAsGroundTruth({ range: 10 }), 'label']]) };
    expect(findGroundTruthLeak(input)).toBe('index.key[0]');
  });

  it('finds ground truth inside a Set', () => {
    const input = { seen: new Set([{ ok: true }, brandAsGroundTruth({ range: 10 })]) };
    expect(findGroundTruthLeak(input)).toBe('seen.item[1]');
  });

  it('does not walk into pixel buffers, which hold no references', () => {
    // Also what keeps this affordable: enumerating a 640x480 frame byte by byte
    // would be 307,200 property visits per check.
    const frame = { data: new Uint8Array(64_000) };
    expect(findGroundTruthLeak(frame)).toBeNull();
  });

  it('still catches a buffer that is itself branded', () => {
    // The taint check runs before the binary skip, so branding the buffer does
    // not smuggle it through.
    const branded = brandAsGroundTruth(new Uint8Array([1, 2, 3]));
    expect(findGroundTruthLeak({ data: branded })).toBe('data');
  });
});

describe('assertGroundTruthFree', () => {
  it('returns the value unchanged when clean', () => {
    const value = { frameId: 7 };
    expect(assertGroundTruthFree(value, 'a tracking algorithm')).toBe(value);
  });

  it('throws a GroundTruthLeakError naming the context and path', () => {
    const input = { gimbal: brandAsGroundTruth({ azimuth: 0 }) };

    expect(() => assertGroundTruthFree(input, 'a tracking algorithm')).toThrow(
      GroundTruthLeakError,
    );

    try {
      assertGroundTruthFree(input, 'a tracking algorithm');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(GroundTruthLeakError);
      const leak = error as GroundTruthLeakError;
      expect(leak.path).toBe('gimbal');
      expect(leak.message).toContain('a tracking algorithm');
      expect(leak.message).toContain('gimbal');
    }
  });
});

describe('brand durability', () => {
  it('survives structuredClone, which is what a worker boundary uses', () => {
    // The brand is a string key rather than a symbol precisely for this:
    // structuredClone drops symbol-keyed properties, which would disarm the
    // runtime check exactly where static types no longer apply.
    const original = brandAsGroundTruth({ tick: 3, targets: [{ range: 10 }] });
    const cloned: unknown = structuredClone(original);

    expect(isGroundTruthTainted(cloned)).toBe(true);
    expect(findGroundTruthLeak({ payload: cloned })).toBe('payload');
  });

  it('cannot be stripped by assignment', () => {
    const truth = brandAsGroundTruth({ tick: 1 });
    expect(() => {
      Object.defineProperty(truth, GROUND_TRUTH_BRAND, { value: false });
    }).toThrow(TypeError);
    expect(isGroundTruthTainted(truth)).toBe(true);
  });
});

describe('guardTrackingInput', () => {
  it('passes a clean input through to the algorithm', () => {
    const input = { tick: 4, frame: null } as unknown as TrackingInput;
    expect(guardTrackingInput(input)).toBe(input);
  });

  it('refuses an input that a harness bug assembled from simulator state', () => {
    const leaked = {
      tick: 4,
      gimbal: brandAsGroundTruth({ azimuth: 0 }),
    } as unknown as TrackingInput;

    expect(() => guardTrackingInput(leaked)).toThrow(GroundTruthLeakError);
    expect(() => guardTrackingInput(leaked)).toThrow(/tracking algorithm/);
  });
});
