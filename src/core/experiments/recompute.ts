/**
 * Summaries from the files on disk.
 *
 * The credibility feature. A live accumulator is something a reader has to take
 * on trust; a computation from the raw record is something they can check.
 *
 * There is exactly one way a summary is produced: {@link summariseStoredRun}
 * streams events.jsonl, telemetry.csv and evaluation.csv through the KPI engine,
 * using only the manifest for context. The recorder calls it at finalisation to
 * write summary.json. {@link recomputeSummary} calls it again, cold, and
 * compares the result with what was stored. Nothing about the stored summary is
 * an input to the recomputation, so a hand-edited summary.json, or a sample file
 * altered after the fact, shows up as a difference.
 *
 * It deliberately reruns **nothing**: no engine, no sensor, no algorithm. If a
 * metric could not be recomputed from the artifacts, the artifacts are missing
 * something and that is a defect in what gets recorded.
 */

import { fingerprint } from './fingerprint';
import { SummaryBuilder } from './metrics';
import {
  experimentManifestSchema,
  experimentSummarySchema,
  metricsConfigSchema,
  type ExperimentManifest,
  type ExperimentStatus,
  type ExperimentSummary,
  type MetricsConfig,
} from './schema';
import { evaluationParser, parseEventLine, telemetryParser } from './serialisation';
import { RUN_FILES } from './storage';
import type { ExperimentStorage } from './storage';

/** Reads and validates a run's manifest. */
export async function readManifest(
  storage: ExperimentStorage,
  runId: string,
): Promise<ExperimentManifest> {
  return experimentManifestSchema.parse(
    JSON.parse(await storage.readFile(runId, RUN_FILES.manifest)),
  );
}

/** Reads and validates a run's stored summary. */
export async function readStoredSummary(
  storage: ExperimentStorage,
  runId: string,
): Promise<ExperimentSummary> {
  return experimentSummarySchema.parse(
    JSON.parse(await storage.readFile(runId, RUN_FILES.summary)),
  );
}

/**
 * Checks that the configuration snapshots are the ones the run was recorded
 * with, by fingerprint.
 *
 * @throws naming the file whose contents no longer match the manifest.
 */
export async function verifySnapshots(
  storage: ExperimentStorage,
  manifest: ExperimentManifest,
): Promise<void> {
  const scenario = JSON.parse(
    await storage.readFile(manifest.runId, RUN_FILES.scenario),
  ) as unknown;
  const algorithm = JSON.parse(
    await storage.readFile(manifest.runId, RUN_FILES.algorithm),
  ) as unknown;
  if (fingerprint(scenario) !== manifest.scenarioFingerprint) {
    throw new Error(`${RUN_FILES.scenario} does not match the fingerprint in the manifest`);
  }
  if (fingerprint(algorithm) !== manifest.algorithmFingerprint) {
    throw new Error(`${RUN_FILES.algorithm} does not match the fingerprint in the manifest`);
  }
  if (fingerprint(manifest.metricsConfig) !== manifest.metricsFingerprint) {
    throw new Error('The metrics configuration in the manifest does not match its fingerprint');
  }
}

export interface SummariseOptions {
  /**
   * Score under a different metrics definition than the run was recorded with.
   *
   * The result carries the other definition's fingerprint, so it is a new,
   * explicitly identified result — never a silent correction of the stored one.
   */
  readonly metricsConfig?: MetricsConfig;
}

/**
 * Computes a run's summary from its stored artifacts.
 *
 * @throws if the run has not ended, a snapshot fails its fingerprint, a file is
 *   missing or malformed, or the event log is out of order. A run that cannot be
 *   read is reported as such rather than summarised from whatever was there.
 */
export async function summariseStoredRun(
  storage: ExperimentStorage,
  runId: string,
  options: SummariseOptions = {},
): Promise<ExperimentSummary> {
  const manifest = await readManifest(storage, runId);
  if (manifest.endSimulationTime === null || manifest.sensorFramesGenerated === null) {
    throw new Error(`Run ${runId} never ended, so it has no summary to compute`);
  }
  await verifySnapshots(storage, manifest);

  const metricsConfig =
    options.metricsConfig === undefined
      ? manifest.metricsConfig
      : metricsConfigSchema.parse(options.metricsConfig);
  const builder = new SummaryBuilder({
    runId: manifest.runId,
    metricsConfig,
    metricsFingerprint: fingerprint(metricsConfig),
    terminationReason: manifest.terminationReason,
    configuredSensorFps: manifest.camera.frameRate,
    sensorFramesGenerated: manifest.sensorFramesGenerated,
    startSimulationTime: manifest.startSimulationTime,
    endSimulationTime: manifest.endSimulationTime,
  });

  let lineNumber = 0;
  let previous: { sequence: number; time: number } | null = null;
  await storage.readLines(runId, RUN_FILES.events, (line) => {
    lineNumber += 1;
    const event = parseEventLine(line, lineNumber);
    if (event === null) return;
    // The log's order is part of its contract. A reordered or spliced log is
    // corrupt, and summarising it would give a confident wrong answer.
    if (
      previous !== null &&
      (event.sequence <= previous.sequence || event.simulationTime < previous.time)
    ) {
      throw new Error(`events.jsonl:${String(lineNumber)}: out of order`);
    }
    previous = { sequence: event.sequence, time: event.simulationTime };
    builder.addEvent(event);
  });

  const telemetry = telemetryParser();
  await storage.readLines(runId, RUN_FILES.telemetry, (line) => {
    const sample = telemetry.line(line);
    if (sample !== null) builder.addTelemetry(sample);
  });

  const evaluation = evaluationParser();
  await storage.readLines(runId, RUN_FILES.evaluation, (line) => {
    const sample = evaluation.line(line);
    if (sample !== null) builder.addEvaluation(sample);
  });

  if (!telemetry.sawHeader || !evaluation.sawHeader) {
    throw new Error(`Run ${runId} is missing a sample file header`);
  }

  return builder.finish();
}

/** A single disagreement between a stored and a recomputed summary. */
export interface SummaryDifference {
  readonly path: string;
  readonly stored: unknown;
  readonly recomputed: unknown;
}

/**
 * The tolerance a recomputation is held to.
 *
 * Relative, one part in 10^12. In practice the comparison is exact — the raw
 * files round-trip every double and the same builder consumes them in the same
 * order — but a verification that failed over the last bit of a sum on some
 * future platform would be reporting noise rather than a discrepancy.
 */
export const RECOMPUTE_RELATIVE_TOLERANCE = 1e-12;

/** Compares two summaries field by field. No field is exempt. */
export function compareSummaries(
  stored: ExperimentSummary,
  recomputed: ExperimentSummary,
  relativeTolerance = RECOMPUTE_RELATIVE_TOLERANCE,
): readonly SummaryDifference[] {
  const differences: SummaryDifference[] = [];

  const walk = (a: unknown, b: unknown, path: string): void => {
    if (typeof a === 'number' && typeof b === 'number') {
      const scale = Math.max(Math.abs(a), Math.abs(b));
      if (Math.abs(a - b) > relativeTolerance * scale) {
        differences.push({ path, stored: a, recomputed: b });
      }
      return;
    }

    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) {
        differences.push({ path: `${path}.length`, stored: a.length, recomputed: b.length });
        return;
      }
      a.forEach((entry, index) => {
        walk(entry, b[index], `${path}[${String(index)}]`);
      });
      return;
    }

    if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
      const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
      for (const key of keys) {
        walk(
          (a as Record<string, unknown>)[key],
          (b as Record<string, unknown>)[key],
          path === '' ? key : `${path}.${key}`,
        );
      }
      return;
    }

    if (a !== b) differences.push({ path, stored: a, recomputed: b });
  };

  walk(stored, recomputed, '');
  return differences;
}

/** The outcome of verifying a stored summary against its raw record. */
export interface Recomputation {
  readonly manifest: ExperimentManifest;
  readonly stored: ExperimentSummary;
  readonly recomputed: ExperimentSummary;
  readonly differences: readonly SummaryDifference[];
}

/**
 * Recomputes a completed run's summary from its raw artifacts and compares it
 * with the stored one.
 *
 * @throws if the run is not completed: an aborted, failed or interrupted run
 *   has no stored result to verify.
 */
export async function recomputeSummary(
  storage: ExperimentStorage,
  runId: string,
): Promise<Recomputation> {
  const manifest = await readManifest(storage, runId);
  if (manifest.status !== 'completed') {
    throw new Error(
      `Run ${runId} is ${displayStatus(manifest.status)}; it has no result to verify`,
    );
  }
  const stored = await readStoredSummary(storage, runId);
  const recomputed = await summariseStoredRun(storage, runId);
  return { manifest, stored, recomputed, differences: compareSummaries(stored, recomputed) };
}

// --- Listing ----------------------------------------------------------------

/**
 * How a status reads to a person.
 *
 * `running` on disk only ever means the process stopped before finalising,
 * because a live recording is not listed from disk — so it reads INCOMPLETE.
 */
export function displayStatus(status: ExperimentStatus): string {
  switch (status) {
    case 'running':
    case 'created':
      return 'incomplete';
    default:
      return status;
  }
}

/** Everything the Reports view needs to list a run without opening it fully. */
export interface RunListing {
  readonly runId: string;
  readonly manifest: ExperimentManifest | null;
  /** Present only for a completed run whose summary parsed. */
  readonly summary: ExperimentSummary | null;
  /** Set when the run's files could not be read or parsed. */
  readonly error: string | null;
}

/**
 * Lists every stored run.
 *
 * A run whose manifest says `running` was interrupted: the process died before
 * finalisation. It is listed — a user may want to inspect or delete it — but it
 * carries no summary, so nothing can mistake it for a result.
 */
export async function listRuns(storage: ExperimentStorage): Promise<readonly RunListing[]> {
  const ids = await storage.listRuns();
  const listings: RunListing[] = [];

  for (const runId of ids) {
    try {
      const manifest = await readManifest(storage, runId);
      const summary =
        manifest.status === 'completed' ? await readStoredSummary(storage, runId) : null;
      listings.push({ runId, manifest, summary, error: null });
    } catch (error) {
      listings.push({
        runId,
        manifest: null,
        summary: null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return listings;
}

/**
 * The runs that are valid results.
 *
 * Completed, with a summary. Anything else — aborted, failed, interrupted,
 * unreadable — is excluded, so no aggregate or comparison can ever include a run
 * that did not finish.
 */
export function completedResults(
  listings: readonly RunListing[],
): readonly (RunListing & { manifest: ExperimentManifest; summary: ExperimentSummary })[] {
  return listings.filter(
    (
      listing,
    ): listing is RunListing & {
      manifest: ExperimentManifest;
      summary: ExperimentSummary;
    } => listing.manifest?.status === 'completed' && listing.summary !== null,
  );
}
