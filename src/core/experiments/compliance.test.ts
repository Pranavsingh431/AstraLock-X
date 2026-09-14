// @vitest-environment node
/**
 * Does a finished run answer the questions the problem statement asks?
 *
 * The brief requires automatic reporting of simulation duration, FPS,
 * acquisition time, average and maximum tracking error, lock retention rate
 * and processing time. This checks each against the **data model**: the field
 * exists, carries a unit and an explicit status, is bound to one stated
 * definition, and equals a value recomputed here directly from the raw files
 * without the metrics engine.
 *
 * Checking that those words appear somewhere in the HTML would prove nothing: a
 * report can print "FPS" next to a number that came from nowhere.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';

import type { Measurement } from '@/core/contracts/measurement';
import { formatMeasurement, measurementSchema } from '@/core/contracts/measurement';

import { REQUIRED_PERFORMANCE_CATEGORIES, performanceLog, summaryField } from './performance-log';
import { readManifest } from './recompute';
import { buildRig, drive } from './rig.node';
import { experimentSummarySchema } from './schema';
import type { ExperimentManifest, ExperimentSummary } from './schema';
import { parseEvaluationCsv, parseEventLog, parseTelemetryCsv } from './serialisation';
import { MemoryStorage, RUN_FILES } from './storage';

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

let summary: ExperimentSummary;
let manifest: ExperimentManifest;
let storage: MemoryStorage;
let report: string;

beforeAll(async () => {
  storage = new MemoryStorage();
  const rig = buildRig({ scenario: 'pat-stationary-outside-fov', storage, runId: 'run-sih' });
  await rig.recorder!.start({ autonomyActive: true });
  drive(rig, 35);
  await rig.recorder!.complete();
  // Everything below reads the stored artifacts.
  summary = experimentSummarySchema.parse(
    JSON.parse(await storage.readFile('run-sih', RUN_FILES.summary)),
  );
  manifest = await readManifest(storage, 'run-sih');
  report = await storage.readFile('run-sih', RUN_FILES.report);
});

const isMeasurement = (value: unknown): value is Measurement =>
  measurementSchema.safeParse(value).success;

describe('the performance log', () => {
  it('covers every category the brief names, each bound to a real summary field', () => {
    const log = performanceLog(summary);
    const categories = new Set(log.map((entry) => entry.category));
    for (const category of REQUIRED_PERFORMANCE_CATEGORIES) {
      expect(categories.has(category), category).toBe(true);
    }
    for (const entry of log) {
      // The value is literally the summary field it names, not a copy.
      expect(summaryField(summary, entry.source)).toBe(entry.value);
      expect(isMeasurement(entry.value), entry.source).toBe(true);
      expect(entry.value.unit.length, entry.source).toBeGreaterThan(0);
      expect(entry.definition.length, entry.source).toBeGreaterThan(30);
    }
  });

  it('distinguishes the three frame rates, and says which is configured', () => {
    const fps = performanceLog(summary).filter((entry) => entry.category === 'fps');
    expect(fps.map((entry) => entry.source)).toEqual([
      'configuredSensorFps',
      'effectiveSensorFps',
      'algorithmProcessedFps',
    ]);
    expect(fps[0]!.value.status).toBe('configured');
    expect(fps[1]!.value.status).toBe('derived');
    expect(fps[2]!.value.status).toBe('derived');
    for (const entry of fps) expect(entry.value.unit).toBe('fps');
  });
});

describe('each required value derives from the raw record', () => {
  // These recompute from the files with plain arithmetic, not the KPI engine.

  it('simulation duration is end minus start from the manifest', () => {
    expect(summary.simulationDurationSeconds.value).toBe(
      manifest.endSimulationTime! - manifest.startSimulationTime,
    );
    expect(summary.simulationDurationSeconds.unit).toBe('s');
  });

  it('FPS is frames in [start, end) over the autonomous duration', async () => {
    const telemetry = parseTelemetryCsv(await storage.readFile('run-sih', RUN_FILES.telemetry));
    const events = parseEventLog(await storage.readFile('run-sih', RUN_FILES.events));
    const autonomy = events.find((event) => event.type === 'autonomy-enabled')!.simulationTime;
    const inWindow = telemetry.filter(
      (row) =>
        row.frame_capture_time_s >= manifest.startSimulationTime &&
        row.frame_capture_time_s < manifest.endSimulationTime!,
    ).length;
    const duration = manifest.endSimulationTime! - Math.max(autonomy, manifest.startSimulationTime);
    expect(summary.algorithmProcessedFps.value).toBe(inWindow / duration);
    expect(summary.effectiveSensorFps.value).toBe(manifest.sensorFramesGenerated! / duration);
    expect(summary.configuredSensorFps.value).toBe(manifest.camera.frameRate);
  });

  it('acquisition time is the evaluator lock minus the recorded search start', async () => {
    const events = parseEventLog(await storage.readFile('run-sih', RUN_FILES.events));
    const search = events.find((event) => event.type === 'search-started')!.simulationTime;
    expect(summary.coarseAcquisitionTime.value).toBe(summary.coarseLockTime.value! - search);
    expect(summary.coarseAcquisitionTime.unit).toBe('s');
  });

  it('average and maximum tracking error match the post-acquisition rows of evaluation.csv', async () => {
    const rows = parseEvaluationCsv(await storage.readFile('run-sih', RUN_FILES.evaluation));
    const lock = summary.coarseLockTime.value!;
    const errors = rows
      .filter((row) => row.capture_time_s >= lock)
      .map((row) => row.truth_angular_pointing_error_rad)
      .filter((value): value is number => value !== null);
    let sum = 0;
    for (const value of errors) sum += value;

    const window = summary.angularPointingError.postAcquisition;
    expect(window.count).toBe(errors.length);
    expect(window.mean.value).toBeCloseTo(sum / errors.length, 15);
    expect(window.max.value).toBe(Math.max(...errors));
    expect(window.mean.unit).toBe('rad');
  });

  it('lock retention is locked time over trackable time, both exposed', () => {
    const rate = summary.lockRetentionRate;
    expect(rate.status).toBe('derived');
    expect(rate.unit).toBe('1');
    expect(rate.value).toBe(
      summary.lockedDurationSeconds.value! / summary.trackableOpportunitySeconds.value!,
    );
    expect(summary.lockRetentionStatus).toBe('computed');
  });

  it('processing time is the mean of host_algorithm_ms, and says it is host time', async () => {
    const telemetry = parseTelemetryCsv(await storage.readFile('run-sih', RUN_FILES.telemetry));
    let sum = 0;
    for (const row of telemetry) sum += row.host_algorithm_ms;
    const processing = performanceLog(summary).find(
      (entry) => entry.category === 'processing-time',
    )!;
    expect(processing.value.value).toBeCloseTo(sum / telemetry.length, 12);
    expect(processing.value.unit).toBe('ms');
    expect(processing.definition).toMatch(/not simulated latency/i);
  });
});

describe('absent values', () => {
  it('carry an explicit status and never a placeholder number', () => {
    const walk = (value: unknown, path: string): void => {
      if (isMeasurement(value)) {
        if (value.value === null) {
          expect(['not-modelled', 'not-applicable', 'not-measured'], path).toContain(value.status);
        } else {
          expect(Number.isFinite(value.value), path).toBe(true);
        }
        return;
      }
      if (value !== null && typeof value === 'object') {
        for (const [key, entry] of Object.entries(value)) walk(entry, `${path}.${key}`);
      }
    };
    walk(summary, 'summary');
  });

  it('say the false-lock challenge was not exercised, rather than reporting a zero', () => {
    expect(summary.falseLockExercised).toBe(false);
    expect(summary.falseLockDurationSeconds).toEqual({
      value: null,
      status: 'not-applicable',
      unit: 's',
    });
  });
});

describe('the generated report', () => {
  it('works offline: no script, stylesheet link, font, image or network reference', () => {
    for (const forbidden of [
      'http://',
      'https://',
      '<script',
      '<link',
      '@import',
      'url(',
      '<img',
      'src=',
    ]) {
      expect(report, forbidden).not.toContain(forbidden);
    }
  });

  it('prints every performance-log entry with the value from the data model', () => {
    const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    for (const entry of performanceLog(summary)) {
      expect(report).toContain(escape(entry.label));
      if (entry.value.unit !== 'rad' && entry.value.unit !== '1' && entry.value.value !== null) {
        expect(report).toContain(escape(formatMeasurement(entry.value, 3)));
      }
    }
  });

  it('states provenance, status and the metric definitions it used', () => {
    expect(report).toContain(manifest.runId);
    expect(report).toContain(manifest.scenarioFingerprint);
    expect(report).toContain('status completed');
    expect(report).toMatch(/commit <span class="absent">unavailable<\/span>/);
    expect(report).toContain('Metric definitions');
    expect(report).toContain(
      `pointing error ≤ ${(summary.metricsConfig.lockErrorThresholdRad * 1e6).toFixed(0)} µrad`,
    );
    expect(report).toContain('<strong>Not</strong> simulated control latency');
  });

  it('draws its plots from the run: one path vertex per reduced sample, not decoration', () => {
    for (const title of [
      'Angular pointing error vs simulation time',
      'Image-space pointing error vs simulation time',
      'Pan: commanded vs measured',
      'Tilt: commanded vs measured',
      'PAT state and evaluator lock',
      'Detected centroid distance from principal point',
    ]) {
      expect(report).toContain(title);
    }
    expect((report.match(/<path d="M/g) ?? []).length).toBeGreaterThanOrEqual(7);
    expect((report.match(/L\d/g) ?? []).length).toBeGreaterThan(1000);
    expect(report.length).toBeLessThan(400_000);
  });
});
