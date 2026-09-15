// @vitest-environment node
/**
 * The code waveform and its exposure integral.
 *
 * Every later claim about identity rests on this arithmetic being right, and it
 * is the kind of arithmetic that is easy to get subtly wrong in ways that still
 * produce a plausible-looking modulated image: an off-by-one in the symbol
 * index, a midpoint sample instead of an integral, a modulo that reflects
 * negative times instead of wrapping them. Each is checked here against a value
 * worked out by hand.
 */

import { describe, expect, it } from 'vitest';

import {
  codePeriod,
  integratedLevel,
  integratedShape,
  levelAt,
  type CodeSymbol,
  type CodeWaveform,
} from './code-waveform';

/** `1 0 1 1` at one second a symbol, on = 1, off = 0, starting at t = 0. */
function code(overrides: Partial<CodeWaveform> = {}): CodeWaveform {
  return {
    sequence: [1, 0, 1, 1] as CodeSymbol[],
    symbolDuration: 1,
    phaseOffset: 0,
    onLevel: 1,
    offLevel: 0,
    repeat: true,
    ...overrides,
  };
}

describe('the symbol grid', () => {
  it('holds each symbol for its whole duration', () => {
    const waveform = code();
    expect(levelAt(waveform, 0)).toBe(1);
    expect(levelAt(waveform, 0.999)).toBe(1);
    expect(levelAt(waveform, 1)).toBe(0);
    expect(levelAt(waveform, 1.999)).toBe(0);
    expect(levelAt(waveform, 2)).toBe(1);
    expect(levelAt(waveform, 3)).toBe(1);
  });

  it('repeats with the sequence period', () => {
    const waveform = code();
    expect(codePeriod(waveform)).toBe(4);
    for (const time of [0, 0.5, 1.2, 2.7, 3.9]) {
      expect(levelAt(waveform, time + 4), `t=${String(time)}`).toBe(levelAt(waveform, time));
      expect(levelAt(waveform, time + 40)).toBe(levelAt(waveform, time));
    }
  });

  // `-1 % 4` is `-1` in JavaScript, which would index off the front of the
  // sequence and silently return the wrong symbol for every time before the
  // phase offset.
  it('wraps times before the phase offset instead of reflecting them', () => {
    const waveform = code();
    expect(levelAt(waveform, -1)).toBe(levelAt(waveform, 3));
    expect(levelAt(waveform, -0.5)).toBe(levelAt(waveform, 3.5));
    expect(levelAt(waveform, -4.25)).toBe(levelAt(waveform, -0.25));
  });

  it('shifts the whole pattern with the phase offset', () => {
    const shifted = code({ phaseOffset: 0.25 });
    expect(levelAt(shifted, 0.2)).toBe(levelAt(code(), 3.95));
    expect(levelAt(shifted, 0.3)).toBe(1);
    expect(levelAt(shifted, 1.3)).toBe(0);
  });

  it('holds on for ever once a non-repeating code has finished', () => {
    const once = code({ repeat: false });
    expect(levelAt(once, 1)).toBe(0);
    expect(levelAt(once, 3.5)).toBe(1);
    // Past the end of the sequence: no longer signalling.
    expect(levelAt(once, 4)).toBe(1);
    expect(levelAt(once, 400)).toBe(1);
    // And before it started.
    expect(levelAt(once, -1)).toBe(1);
  });
});

describe('the exposure integral', () => {
  it('returns the symbol level when the window lies inside one symbol', () => {
    const waveform = code();
    expect(integratedLevel(waveform, 0.1, 0.9)).toBeCloseTo(1, 12);
    expect(integratedLevel(waveform, 1.1, 1.9)).toBeCloseTo(0, 12);
  });

  // The property that separates an exposure model from a sample. A window
  // straddling a boundary reports what the camera actually collected, which is
  // neither of the two symbol levels.
  it('splits a window that straddles a symbol boundary by overlap', () => {
    const waveform = code();
    // Half in the 1 at [0,1), half in the 0 at [1,2).
    expect(integratedLevel(waveform, 0.5, 1.5)).toBeCloseTo(0.5, 12);
    // A quarter in the 1, three quarters in the 0.
    expect(integratedLevel(waveform, 0.75, 1.75)).toBeCloseTo(0.25, 12);
    // Three quarters in the 0, a quarter in the following 1.
    expect(integratedLevel(waveform, 1.25, 2.25)).toBeCloseTo(0.25, 12);
  });

  it('averages correctly across several symbols', () => {
    const waveform = code();
    // The whole period 1,0,1,1 averages to three quarters.
    expect(integratedLevel(waveform, 0, 4)).toBeCloseTo(0.75, 12);
    expect(integratedLevel(waveform, 0, 8)).toBeCloseTo(0.75, 12);
    // Two symbols, 1 then 0.
    expect(integratedLevel(waveform, 0, 2)).toBeCloseTo(0.5, 12);
  });

  it('respects the configured on and off levels', () => {
    const waveform = code({ onLevel: 0.9, offLevel: 0.3 });
    expect(integratedLevel(waveform, 0.1, 0.9)).toBeCloseTo(0.9, 12);
    expect(integratedLevel(waveform, 1.1, 1.9)).toBeCloseTo(0.3, 12);
    // Half and half.
    expect(integratedLevel(waveform, 0.5, 1.5)).toBeCloseTo(0.6, 12);
  });

  it('is the instantaneous level in the limit of a closing window', () => {
    const waveform = code();
    expect(integratedLevel(waveform, 1.5, 1.5)).toBe(0);
    expect(integratedLevel(waveform, 0.5, 0.5)).toBe(1);
    // And approaches it continuously.
    expect(integratedLevel(waveform, 0.5, 0.5 + 1e-9)).toBeCloseTo(1, 9);
  });

  // The integral over a whole number of periods is the sequence's duty cycle,
  // whatever phase the window starts at. A drifting or off-by-one symbol walk
  // would break this for some start times and not others.
  it('gives the duty cycle over any whole number of periods, from any phase', () => {
    const waveform = code();
    const duty = 3 / 4;
    for (const start of [0, 0.3, 1.7, 2.5, -1.2, 11.9]) {
      expect(integratedLevel(waveform, start, start + 4), `start=${String(start)}`).toBeCloseTo(
        duty,
        12,
      );
      expect(integratedLevel(waveform, start, start + 12)).toBeCloseTo(duty, 12);
    }
  });

  it('is additive over adjacent windows', () => {
    const waveform = code({ sequence: [1, 0, 0, 1, 1, 0] as CodeSymbol[] });
    const whole = integratedLevel(waveform, 0.4, 3.1) * (3.1 - 0.4);
    const first = integratedLevel(waveform, 0.4, 1.7) * (1.7 - 0.4);
    const second = integratedLevel(waveform, 1.7, 3.1) * (3.1 - 1.7);
    expect(first + second).toBeCloseTo(whole, 10);
  });

  it('handles a window far longer than the code period without drifting', () => {
    const waveform = code({ symbolDuration: 1e-3 });
    // Ten thousand periods. A walk that accumulated its cursor would drift here.
    expect(integratedLevel(waveform, 0, 40)).toBeCloseTo(0.75, 9);
  });

  it('stays exactly on the grid at symbol edges', () => {
    const waveform = code();
    expect(integratedLevel(waveform, 1, 2)).toBeCloseTo(0, 12);
    expect(integratedLevel(waveform, 2, 3)).toBeCloseTo(1, 12);
    expect(integratedLevel(waveform, 0, 1)).toBeCloseTo(1, 12);
  });

  it.each([
    ['a backwards window', () => integratedLevel(code(), 1, 0)],
    ['a zero symbol duration', () => integratedLevel(code({ symbolDuration: 0 }), 0, 1)],
    ['an empty sequence', () => integratedLevel(code({ sequence: [] }), 0, 1)],
    ['a non-finite bound', () => integratedLevel(code(), 0, Number.POSITIVE_INFINITY)],
  ])('refuses %s', (_label, run) => {
    expect(run).toThrow(RangeError);
  });
});

describe('the unit-amplitude shape', () => {
  // What a receiver predicts against: the pattern with the amplitude divided
  // out, because a terminal knows the signalling pattern and not how bright the
  // far end happens to be.
  it('is the code with on = 1 and off = 0', () => {
    const sequence: CodeSymbol[] = [1, 0, 1, 1];
    expect(integratedShape(sequence, 1, 0, 0.1, 0.9)).toBeCloseTo(1, 12);
    expect(integratedShape(sequence, 1, 0, 1.1, 1.9)).toBeCloseTo(0, 12);
    expect(integratedShape(sequence, 1, 0, 0.5, 1.5)).toBeCloseTo(0.5, 12);
  });

  it('is unaffected by the emitter levels it is being compared against', () => {
    const sequence: CodeSymbol[] = [1, 0, 1, 1];
    const shape = integratedShape(sequence, 1, 0, 0.5, 1.5);
    // The emitter could be sending anything between 0.3 and 0.9; the shape the
    // receiver predicts is the same.
    const emitted = integratedLevel(
      { sequence, symbolDuration: 1, phaseOffset: 0, onLevel: 0.9, offLevel: 0.3, repeat: true },
      0.5,
      1.5,
    );
    expect(shape).toBeCloseTo(0.5, 12);
    expect(emitted).toBeCloseTo(0.6, 12);
    // Affinely related: emitted = off + (on - off) * shape.
    expect(0.3 + 0.6 * shape).toBeCloseTo(emitted, 12);
  });
});
