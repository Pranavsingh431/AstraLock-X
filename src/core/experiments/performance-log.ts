/**
 * The performance log the problem statement asks for, mapped onto the summary.
 *
 * The brief requests automatic reporting of simulation duration, FPS,
 * acquisition time, average and maximum tracking error, lock retention rate and
 * processing time. Each of those words is ambiguous — FPS of what, error over
 * which samples, processing of which stages — so each is bound here to exactly
 * one field of the summary, with the definition that field implements. The
 * report prints this table, and the compliance test checks it against the data
 * model rather than against the HTML.
 *
 * Nothing here computes anything. It only says which already-derived number
 * answers which question.
 */

import type { Measurement } from '@/core/contracts/measurement';

import type { ExperimentSummary } from './schema';

/** The categories the brief names. */
export type PerformanceCategory =
  | 'simulation-duration'
  | 'fps'
  | 'acquisition-time'
  | 'average-tracking-error'
  | 'maximum-tracking-error'
  | 'lock-retention-rate'
  | 'processing-time';

export interface PerformanceLogEntry {
  readonly category: PerformanceCategory;
  readonly label: string;
  readonly value: Measurement;
  /** Dotted path of the summary field this value is, so it can be checked. */
  readonly source: string;
  /** What the number means, in one sentence. */
  readonly definition: string;
}

/** Reads a dotted path out of a summary. */
export function summaryField(summary: ExperimentSummary, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (value, key) =>
        value !== null && typeof value === 'object'
          ? (value as Record<string, unknown>)[key]
          : undefined,
      summary,
    );
}

const ENTRIES: readonly Omit<PerformanceLogEntry, 'value'>[] = [
  {
    category: 'simulation-duration',
    label: 'Simulation duration',
    source: 'simulationDurationSeconds',
    definition: 'Simulated seconds from the start of recording to the end of the run.',
  },
  {
    category: 'fps',
    label: 'Sensor FPS (configured)',
    source: 'configuredSensorFps',
    definition: 'The camera frame rate in the scenario configuration.',
  },
  {
    category: 'fps',
    label: 'Sensor FPS (effective)',
    source: 'effectiveSensorFps',
    definition:
      'Frames the sensor generated for the closed loop, divided by the simulated autonomous duration.',
  },
  {
    category: 'fps',
    label: 'Algorithm FPS (processed)',
    source: 'algorithmProcessedFps',
    definition:
      'Frames the algorithm processed, divided by the simulated autonomous duration. Not a display or host throughput figure.',
  },
  {
    category: 'acquisition-time',
    label: 'Coarse acquisition time',
    source: 'coarseAcquisitionTime',
    definition:
      'First confirmed evaluator coarse lock minus the start of autonomous search, in simulated seconds.',
  },
  {
    category: 'average-tracking-error',
    label: 'Mean angular pointing error (post-acquisition)',
    source: 'angularPointingError.postAcquisition.mean',
    definition:
      'Mean angle between the true optical axis and the true line of sight to the designated target, over samples at or after first coarse lock.',
  },
  {
    category: 'maximum-tracking-error',
    label: 'Maximum angular pointing error (post-acquisition)',
    source: 'angularPointingError.postAcquisition.max',
    definition:
      'Largest angular pointing error over the same post-acquisition samples, including any loss that followed.',
  },
  {
    category: 'lock-retention-rate',
    label: 'Lock retention rate',
    source: 'lockRetentionRate',
    definition:
      'Locked time divided by trackable time after first coarse lock; time the camera pointed the wrong way counts against it.',
  },
  {
    category: 'processing-time',
    label: 'Host processing time per frame (algorithm, mean)',
    source: 'hostProcessingTime.algorithmTotal.mean',
    definition:
      "Host wall-clock time of the algorithm's update per frame: detection, bearing, estimation and control. A diagnostic of this machine, not simulated latency.",
  },
];

/** The performance log for one summary, in the brief's order. */
export function performanceLog(summary: ExperimentSummary): readonly PerformanceLogEntry[] {
  return ENTRIES.map((entry) => ({
    ...entry,
    value: summaryField(summary, entry.source) as Measurement,
  }));
}

/** Every category the brief names, for the compliance test. */
export const REQUIRED_PERFORMANCE_CATEGORIES: readonly PerformanceCategory[] = [
  'simulation-duration',
  'fps',
  'acquisition-time',
  'average-tracking-error',
  'maximum-tracking-error',
  'lock-retention-rate',
  'processing-time',
];
