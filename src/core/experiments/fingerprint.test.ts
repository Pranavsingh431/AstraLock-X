// @vitest-environment node
/**
 * Configuration fingerprints: a documented hash over a canonical form.
 *
 * The hash is checked against published SHA-256 test vectors and against
 * Node's own implementation, and the canonical form against the ways the same
 * configuration can be written differently.
 */

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { loadScenario } from '@/scenarios';

import { canonicalise, fingerprint, sha256 } from './fingerprint';

describe('sha256', () => {
  it('matches the FIPS 180-2 test vectors', () => {
    expect(sha256('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });

  it('agrees with an independent implementation across block boundaries and UTF-8', () => {
    for (const length of [1, 55, 56, 63, 64, 65, 119, 120, 1000]) {
      const text = 'µ'.repeat(length) + 'x'.repeat(length % 7);
      expect(sha256(text)).toBe(createHash('sha256').update(text, 'utf8').digest('hex'));
    }
  });
});

describe('canonical form', () => {
  it('does not depend on key order, at any depth', () => {
    const a = { b: 1, a: { d: [1, { y: 2, x: 3 }], c: 'text' } };
    const b = { a: { c: 'text', d: [1, { x: 3, y: 2 }] }, b: 1 };
    expect(canonicalise(a)).toBe(canonicalise(b));
    expect(fingerprint(a)).toBe(fingerprint(b));
  });

  it('keeps array order, and distinguishes values that differ', () => {
    expect(fingerprint([1, 2])).not.toBe(fingerprint([2, 1]));
    expect(fingerprint({ a: 1 })).not.toBe(fingerprint({ a: 1.0000000000000002 }));
    expect(fingerprint({ a: '1' })).not.toBe(fingerprint({ a: 1 }));
  });

  it('treats absent and undefined as the same, and -0 as 0', () => {
    expect(fingerprint({ a: 1, b: undefined })).toBe(fingerprint({ a: 1 }));
    expect(fingerprint({ a: -0 })).toBe(fingerprint({ a: 0 }));
  });

  it('refuses a non-finite number rather than hashing it', () => {
    expect(() => fingerprint({ a: Number.NaN })).toThrow(TypeError);
  });

  it('gives a scenario the same fingerprint however it was loaded', () => {
    const loaded = loadScenario('pat-moving-target');
    const roundTripped = JSON.parse(JSON.stringify(loaded)) as unknown;
    expect(fingerprint(roundTripped)).toBe(fingerprint(loaded));
    expect(fingerprint(loaded)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(fingerprint(loadScenario('pat-loss'))).not.toBe(fingerprint(loaded));
  });
});
