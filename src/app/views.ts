import {
  ChartNoAxesColumn,
  Crosshair,
  FileText,
  FlaskConical,
  Gauge,
  History,
  type LucideIcon,
} from 'lucide-react';

/** Every top-level view, in navigation order. */
export const VIEW_IDS = [
  'mission-control',
  'scenario-lab',
  'astrabench',
  'replay',
  'calibration',
  'reports',
] as const;

export type ViewId = (typeof VIEW_IDS)[number];

/** The view shown on a cold start. */
export const DEFAULT_VIEW: ViewId = 'mission-control';

export interface ViewDefinition {
  readonly id: ViewId;
  readonly label: string;
  readonly icon: LucideIcon;
  /** One line describing what this view is for. */
  readonly summary: string;
  /** Phase that will make this view functional. */
  readonly plannedPhase: string;
  /** What this view will do once built. Statements of intent, not of fact. */
  readonly plannedCapabilities: readonly string[];
  /** What has to exist first. Empty when nothing blocks it. */
  readonly blockedBy: readonly string[];
}

/**
 * Registry of views.
 *
 * None of these are implemented yet, and each says so. The descriptions are
 * plans rather than claims: nothing here renders data, because at Phase 0 there
 * is no simulator to produce any, and a placeholder chart of invented numbers
 * would be worse than an empty view.
 */
export const VIEWS: readonly ViewDefinition[] = [
  {
    id: 'mission-control',
    label: 'Mission Control',
    icon: Gauge,
    summary: 'Live view of a running experiment.',
    plannedPhase: 'Phase 6',
    plannedCapabilities: [
      'Three-dimensional scene showing platform, gimbal boresight and targets',
      'Camera feed with the detections the tracker actually produced',
      'Pointing-error and gimbal-rate traces updating as the run advances',
      'PAT mode indicator with the reason for each transition',
      'Ground-truth overlay, off by default and explicitly labelled as debug',
    ],
    blockedBy: ['Simulation core', 'Sensor models', 'A tracking algorithm'],
  },
  {
    id: 'scenario-lab',
    label: 'Scenario Lab',
    icon: FlaskConical,
    summary: 'Author, validate and store experiment configurations.',
    plannedPhase: 'Phase 2',
    plannedCapabilities: [
      'Form-based editing of platform, target, camera, gimbal and atmosphere settings',
      'Live validation against the SimulationConfig schema, with field-level errors',
      'Seed selection, including sweeps for repeated trials',
      'Save and load scenarios as files on disk',
    ],
    blockedBy: ['Simulation core'],
  },
  {
    id: 'astrabench',
    label: 'AstraBench',
    icon: ChartNoAxesColumn,
    summary: 'Compare tracking algorithms across scenarios and seeds.',
    plannedPhase: 'Phase 5',
    plannedCapabilities: [
      'Batch execution of algorithm and scenario combinations over many seeds',
      'Pointing-error distributions, acquisition time and time-in-lock per algorithm',
      'Per-tick compute cost, for judging what fits an embedded target',
      'Results derived from executed runs only — never from stored constants',
    ],
    blockedBy: ['Experiment runner', 'Metrics', 'At least two algorithms'],
  },
  {
    id: 'replay',
    label: 'Replay',
    icon: History,
    summary: 'Step through a completed run and inspect why it behaved as it did.',
    plannedPhase: 'Phase 5',
    plannedCapabilities: [
      'Reconstruct a run exactly from its config and seed',
      'Scrub, step and pause over the recorded event log',
      'Inspect tracker state alongside ground truth at any tick',
      'Compare two runs that differ in one variable',
    ],
    blockedBy: ['Experiment runner', 'Event log persistence'],
  },
  {
    id: 'calibration',
    label: 'Calibration',
    icon: Crosshair,
    summary: 'Estimate camera intrinsics and camera-to-gimbal alignment.',
    plannedPhase: 'Phase 4',
    plannedCapabilities: [
      'Estimate intrinsics and distortion from observed reference points',
      'Recover the camera-to-gimbal mounting rotation and encoder bias',
      'Report residuals, so a bad calibration is visible rather than silent',
      'Feed the resulting estimates into CameraState for subsequent runs',
    ],
    blockedBy: ['Sensor models', 'Gimbal model'],
  },
  {
    id: 'reports',
    label: 'Reports',
    icon: FileText,
    summary: 'Export experiment summaries for use outside the application.',
    plannedPhase: 'Phase 5',
    plannedCapabilities: [
      'Export ExperimentSummary records as JSON and CSV',
      'Include the full config and seed, so any result can be reproduced',
      'Summarise a batch of runs into a single comparison document',
    ],
    blockedBy: ['Experiment runner', 'Metrics'],
  },
];

/** Looks up a view definition. Throws on an unknown id, which is a programming error. */
export function getView(id: ViewId): ViewDefinition {
  const view = VIEWS.find((candidate) => candidate.id === id);
  if (view === undefined) {
    throw new Error(`Unknown view id: ${id}`);
  }
  return view;
}

/** Narrows an arbitrary string to a {@link ViewId}. */
export function isViewId(value: string): value is ViewId {
  return (VIEW_IDS as readonly string[]).includes(value);
}
