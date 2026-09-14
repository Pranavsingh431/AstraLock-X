// @vitest-environment node
/**
 * The raw files: exact, self-describing, and strict about what they accept.
 *
 * `recomputeSummary` is only as credible as the round trip through these files,
 * so the round trip is tested bit for bit, and a file that does not match the
 * schema it claims is refused rather than read positionally.
 */

import { describe, expect, it } from 'vitest';

import {
  EVALUATION_COLUMNS,
  TELEMETRY_COLUMNS,
  evaluationHeader,
  evaluationParser,
  evaluationRow,
  formatNumber,
  parseEventLine,
  telemetryHeader,
  telemetryParser,
} from './serialisation';
import type { EvaluationSample } from './schema';
import { LineSplitter, MemoryStorage, forEachLine } from './storage';

const evaluation = (patch: Partial<EvaluationSample> = {}): EvaluationSample => ({
  frame_id: 12,
  capture_time_s: 0.2,
  pat_state: 'track',
  detection_present: true,
  truth_optical_axis_east: 0.1,
  truth_optical_axis_north: 0.99,
  truth_optical_axis_up: -0.0000001,
  truth_target_los_east: null,
  truth_target_los_north: null,
  truth_target_los_up: null,
  truth_angular_pointing_error_rad: 1.2345678901234566e-7,
  truth_target_range_m: 1657.3741279505964,
  truth_target_within_travel: true,
  truth_target_in_image: false,
  truth_image_x_px: null,
  truth_image_y_px: null,
  truth_image_pointing_error_px: null,
  truth_detector_centroid_error_px: null,
  truth_detection_on_other_emitter: false,
  truth_other_emitters_in_image: 0,
  ...patch,
});

describe('number formatting', () => {
  it('round-trips every double exactly, not to display precision', () => {
    // A deterministic spread across magnitudes, including the awkward ones.
    const values = [
      0.1,
      1 / 3,
      Math.PI,
      -Math.E,
      1e-300,
      5e-324,
      Number.MAX_VALUE,
      Number.MIN_VALUE,
      2 ** 53 + 2,
      0.023000000000000003,
      123456.789e-12,
    ];
    let state = 0x9e3779b9;
    for (let i = 0; i < 2000; i += 1) {
      state = Math.imul(state ^ (state >>> 15), 0x2c1b3c6d) >>> 0;
      values.push(((state / 0xffffffff) * 2 - 1) * 10 ** ((i % 40) - 20));
    }
    for (const value of values) {
      expect(Object.is(Number(formatNumber(value)), value), String(value)).toBe(true);
    }
  });

  it('keeps the sign of negative zero and writes integers plainly', () => {
    expect(Object.is(Number(formatNumber(-0)), -0)).toBe(true);
    expect(formatNumber(4001)).toBe('4001');
    expect(formatNumber(0.5)).toBe('5.0000000000000000e-1');
  });

  it('refuses to write a non-finite value into an archival record', () => {
    expect(() => formatNumber(Number.NaN)).toThrow(RangeError);
    expect(() => formatNumber(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe('sample files', () => {
  it('put units in every numeric column name', () => {
    const unitSuffix = /_(s|m|px|rad|rad_s|ms)$/;
    const unitless = new Set([
      'frame_id',
      'tick',
      'pat_state',
      'candidate_count',
      'components_found',
      'candidate_score',
      'command_id',
      'pan_saturation',
      'tilt_saturation',
      'consecutive_misses',
      'search_waypoint_index',
      'detection_present',
      'truth_optical_axis_east',
      'truth_optical_axis_north',
      'truth_optical_axis_up',
      'truth_target_los_east',
      'truth_target_los_north',
      'truth_target_los_up',
      'truth_target_within_travel',
      'truth_target_in_image',
      'truth_detection_on_other_emitter',
      'truth_other_emitters_in_image',
    ]);
    for (const column of [...TELEMETRY_COLUMNS, ...EVALUATION_COLUMNS]) {
      if (unitless.has(column.name)) continue;
      expect(column.name, column.name).toMatch(unitSuffix);
    }
  });

  it('mark every ground-truth column in the evaluation file, and none in telemetry', () => {
    const safe = new Set(['frame_id', 'capture_time_s', 'pat_state', 'detection_present']);
    for (const column of EVALUATION_COLUMNS) {
      if (!safe.has(column.name)) expect(column.name).toMatch(/^truth_/);
    }
    for (const column of TELEMETRY_COLUMNS) expect(column.name).not.toMatch(/truth/);
  });

  it('round-trip an evaluation row exactly, nulls and booleans included', () => {
    const original = evaluation();
    const parser = evaluationParser();
    expect(parser.line(evaluationHeader())).toBeNull();
    expect(parser.line(evaluationRow(original))).toEqual(original);
  });

  it('reject a file whose header does not match this schema', () => {
    const parser = telemetryParser();
    const renamed = telemetryHeader().replace('measured_pan_rad', 'pan');
    expect(() => parser.line(renamed)).toThrow(/header does not match/);
  });

  it('reject a row with the wrong number of cells or an invalid value', () => {
    const parser = evaluationParser();
    parser.line(evaluationHeader());
    expect(() => parser.line('1,2,3')).toThrow(/expected \d+ cells/);
    const row = evaluationRow(evaluation()).replace(/^12,/, 'twelve,');
    expect(() => parser.line(row)).toThrow(/invalid row/);
  });

  it('refuse text that would need CSV quoting, rather than escaping it', () => {
    expect(() => evaluationRow(evaluation({ pat_state: 'track,lost' }))).toThrow(RangeError);
  });

  it('reject an event line that is not a valid event', () => {
    expect(parseEventLine('', 1)).toBeNull();
    expect(() => parseEventLine('{"sequence":0,"type":"nonsense"}', 3)).toThrow(/events.jsonl:3/);
  });
});

describe('reading a file line by line', () => {
  it('agrees on what a line is, including a missing final newline and CRLF', () => {
    const lines: string[] = [];
    forEachLine('a\r\nb\n\nc', (line) => lines.push(line));
    expect(lines).toEqual(['a', 'b', '', 'c']);
  });

  it('reassembles lines split across arbitrary chunk boundaries', () => {
    const text = 'alpha,1\nbeta,2\ngamma,3\nµrad,4\n';
    for (let size = 1; size <= text.length; size += 1) {
      const lines: string[] = [];
      const splitter = new LineSplitter((line) => lines.push(line));
      for (let start = 0; start < text.length; start += size) {
        splitter.push(text.slice(start, start + size));
      }
      splitter.end();
      expect(lines, `chunk size ${String(size)}`).toEqual([
        'alpha,1',
        'beta,2',
        'gamma,3',
        'µrad,4',
      ]);
    }
  });

  it('streams from storage in order', async () => {
    const storage = new MemoryStorage();
    await storage.createRun('run-lines');
    await storage.append('run-lines', 'events.jsonl', 'one\ntwo\n');
    await storage.append('run-lines', 'events.jsonl', 'three');
    const lines: string[] = [];
    await storage.readLines('run-lines', 'events.jsonl', (line) => lines.push(line));
    expect(lines).toEqual(['one', 'two', 'three']);
  });
});
