// @vitest-environment node
/**
 * The bundled codes, against the properties they are chosen for.
 *
 * A code is only worth using for identity if its correlation behaviour is
 * known, so these tests compute that behaviour rather than assuming it. Two
 * results here are load-bearing for the rest of the phase:
 *
 *  - the m-sequences have an off-peak autocorrelation of exactly 1 against a
 *    peak of 15, which is what lets a phase search find one true alignment;
 *  - `CODE_A` and `CODE_B` reach a cross-correlation of 7 out of 15 at their
 *    worst alignment, which is a *floor* under how well any threshold can
 *    separate them and is why the match threshold sits well above 0.47.
 *
 * The third bundled code exists to fail: it is a rotation of `CODE_A`, and a
 * receiver searching over phase cannot tell it apart from `CODE_A` at all.
 */

import { describe, expect, it } from 'vitest';

import {
  CODE_A,
  CODE_A_SHIFTED,
  CODE_B,
  CODE_LIBRARY,
  maximumLengthSequence,
  peakCrossCorrelation,
  peakSidelobe,
  periodicCorrelation,
  rotate,
} from './code-library';

describe('maximum-length sequence generation', () => {
  it('produces a sequence of length 2^n - 1', () => {
    expect(maximumLengthSequence(4, [4, 1])).toHaveLength(15);
    expect(maximumLengthSequence(5, [5, 3])).toHaveLength(31);
    expect(maximumLengthSequence(6, [6, 1])).toHaveLength(63);
  });

  // The defining property: the register visits every non-zero state exactly
  // once, so the output is balanced to within one symbol.
  it('is balanced: 2^(n-1) ones and one fewer zero', () => {
    for (const [degree, taps] of [
      [4, [4, 1]],
      [5, [5, 3]],
      [6, [6, 1]],
    ] as const) {
      const sequence = maximumLengthSequence(degree, [...taps]);
      const ones = sequence.filter((symbol) => symbol === 1).length;
      expect(ones, `degree ${String(degree)}`).toBe(2 ** (degree - 1));
      expect(sequence.length - ones).toBe(2 ** (degree - 1) - 1);
    }
  });

  it('is deterministic', () => {
    expect(maximumLengthSequence(4, [4, 1])).toEqual(maximumLengthSequence(4, [4, 1]));
  });

  it.each([
    ['a degree below two', () => maximumLengthSequence(1, [1])],
    ['a non-integer degree', () => maximumLengthSequence(4.5, [4, 1])],
    ['no taps', () => maximumLengthSequence(4, [])],
    ['a tap outside the register', () => maximumLengthSequence(4, [5])],
  ])('refuses %s', (_label, run) => {
    expect(run).toThrow(RangeError);
  });
});

describe('correlation arithmetic', () => {
  it('maps symbols to +/-1 so a perfect match scores the full length', () => {
    expect(periodicCorrelation(CODE_A, CODE_A, 0)).toBe(15);
    expect(periodicCorrelation(CODE_B, CODE_B, 0)).toBe(15);
  });

  it('scores the exact opposite of a sequence as minus its length', () => {
    const inverted = CODE_A.map((symbol) => (symbol === 1 ? 0 : 1)) as typeof CODE_A;
    expect(periodicCorrelation(CODE_A, inverted, 0)).toBe(-15);
  });

  it('wraps rather than truncating, so it is genuinely periodic', () => {
    for (let shift = 0; shift < 15; shift += 1) {
      expect(periodicCorrelation(CODE_A, CODE_A, shift)).toBe(
        periodicCorrelation(CODE_A, CODE_A, shift + 15),
      );
    }
  });

  it.each([
    ['sequences of different length', () => periodicCorrelation(CODE_A, CODE_A.slice(1), 0)],
    ['an empty sequence', () => periodicCorrelation([], [], 0)],
  ])('refuses %s', (_label, run) => {
    expect(run).toThrow(RangeError);
  });
});

describe('the bundled codes', () => {
  // The property the whole phase-search design rests on. An m-sequence
  // correlates at 15 with itself aligned and at exactly -1 at every other
  // shift, so there is one unambiguous alignment and no near-miss.
  it('have the ideal m-sequence autocorrelation: peak 15, off-peak 1', () => {
    for (const [name, code] of [
      ['CODE_A', CODE_A],
      ['CODE_B', CODE_B],
    ] as const) {
      expect(periodicCorrelation(code, code, 0), name).toBe(15);
      expect(peakSidelobe(code), name).toBe(1);
      for (let shift = 1; shift < 15; shift += 1) {
        expect(periodicCorrelation(code, code, shift), `${name} shift ${String(shift)}`).toBe(-1);
      }
    }
  });

  it('are genuinely different codes, not rotations of each other', () => {
    expect(CODE_A).not.toEqual(CODE_B);
    for (let shift = 0; shift < 15; shift += 1) {
      expect(rotate(CODE_A, shift), `shift ${String(shift)}`).not.toEqual([...CODE_B]);
    }
  });

  // The measured separation floor. Length-15 has only two m-sequences and they
  // are not orthogonal: at its worst alignment a CODE_B source can reach 7/15
  // against an expected CODE_A. Any match threshold has to clear that, and the
  // algorithm's default does.
  it('reach a worst-case cross-correlation of 7 out of 15', () => {
    expect(peakCrossCorrelation(CODE_A, CODE_B)).toBe(7);
    expect(7 / 15).toBeCloseTo(0.4667, 3);
  });

  it('are balanced, so a correlation is not biased by duty cycle', () => {
    expect(CODE_A.filter((s) => s === 1)).toHaveLength(8);
    expect(CODE_B.filter((s) => s === 1)).toHaveLength(8);
  });
});

describe('the ambiguous control code', () => {
  // This code is meant to be impossible to separate, and saying so in a test
  // keeps it from ever being presented as a success.
  it('is a rotation of CODE_A and therefore indistinguishable under a phase search', () => {
    expect(peakCrossCorrelation(CODE_A, CODE_A_SHIFTED)).toBe(15);
    expect(CODE_A_SHIFTED).toEqual(rotate(CODE_A, 4));
  });

  it('still has the same autocorrelation, because a rotation changes nothing about that', () => {
    expect(peakSidelobe(CODE_A_SHIFTED)).toBe(1);
  });

  it('is not the same sequence at zero shift, so only the phase search confuses them', () => {
    expect([...CODE_A_SHIFTED]).not.toEqual([...CODE_A]);
    expect(periodicCorrelation(CODE_A, CODE_A_SHIFTED, 0)).toBe(-1);
  });
});

describe('the library', () => {
  it('names every bundled code', () => {
    expect(Object.keys(CODE_LIBRARY).sort()).toEqual([
      'AMBIGUOUS_CODE_A_SHIFTED',
      'DECOY_CODE_B',
      'TARGET_CODE_A',
    ]);
  });

  it('holds only binary symbols', () => {
    for (const [name, code] of Object.entries(CODE_LIBRARY)) {
      for (const symbol of code) {
        expect([0, 1], `${name} carries ${String(symbol)}`).toContain(symbol);
      }
    }
  });

  // A code that encoded which target it belonged to would hand identity to the
  // tracker for free. These are patterns, and the test says so.
  it('carries no index, length or ordering that could name a simulator entity', () => {
    expect(CODE_LIBRARY.TARGET_CODE_A).toHaveLength(15);
    expect(CODE_LIBRARY.DECOY_CODE_B).toHaveLength(15);
    expect(CODE_LIBRARY.AMBIGUOUS_CODE_A_SHIFTED).toHaveLength(15);
  });
});
