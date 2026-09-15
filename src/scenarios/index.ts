/**
 * Bundled example scenarios.
 *
 * These are real, loadable configuration documents, not documentation samples:
 * the application loads them through the same parser an imported file goes
 * through, so a scenario that would not run cannot ship.
 *
 * They are parsed lazily and the result is cached. Parsing six documents at
 * module load would run Zod during application start for scenarios the operator
 * may never open.
 */

import { type SimulationConfig, parseSimulationConfig } from '@/core/contracts/simulation';

import astralockHandoff from './astralock-handoff.json';
import astralockManeuver from './astralock-maneuver.json';
import astralockMoving from './astralock-moving.json';
import astralockShortLoss from './astralock-short-loss.json';
import astralockStationary from './astralock-stationary.json';
import cameraBoresight from './camera-boresight.json';
import cameraOutsideFov from './camera-target-outside-fov.json';
import circular from './circular.json';
import codeAmbiguous from './code-ambiguous.json';
import codeClean from './code-clean.json';
import codeDecoyHard from './code-decoy-hard.json';
import codeDecoyEasy from './code-decoy-easy.json';
import codeDecoyUncoded from './code-decoy-uncoded.json';
import codeIdentical from './code-identical.json';
import codeDecoyWrong from './code-decoy-wrong.json';
import codeFrameLoss from './code-frame-loss.json';
import codeInsufficient from './code-insufficient.json';
import distCombined from './dist-combined.json';
import distDecoyEasy from './dist-decoy-easy.json';
import distDecoyHard from './dist-decoy-hard.json';
import distFrameLoss from './dist-frame-loss.json';
import distLowContrast from './dist-low-contrast.json';
import distVibration from './dist-vibration.json';
import distVibrationExtreme from './dist-vibration-extreme.json';
import gimbalBacklash from './gimbal-backlash.json';
import gimbalLatency from './gimbal-latency.json';
import gimbalStepResponse from './gimbal-step-response.json';
import linearPass from './linear-pass.json';
import patLoss from './pat-loss.json';
import patMoving from './pat-moving-target.json';
import patStationary from './pat-stationary-outside-fov.json';
import seededManeuver from './seeded-maneuver.json';
import sinusoidal from './sinusoidal.json';
import stationary from './stationary.json';
import waypoints from './waypoints.json';

export const SCENARIO_IDS = [
  'stationary',
  'linear-pass',
  'circular',
  'sinusoidal',
  'waypoints',
  'seeded-maneuver',
  'camera-boresight',
  'camera-target-outside-fov',
  'gimbal-step-response',
  'gimbal-latency',
  'gimbal-backlash',
  'pat-stationary-outside-fov',
  'pat-moving-target',
  'pat-loss',
  'astralock-stationary',
  'astralock-moving',
  'astralock-maneuver',
  'astralock-short-loss',
  'astralock-handoff',
  'dist-vibration',
  'dist-vibration-extreme',
  'dist-low-contrast',
  'dist-frame-loss',
  'dist-decoy-easy',
  'dist-decoy-hard',
  'dist-combined',
  'code-clean',
  'code-decoy-uncoded',
  'code-decoy-easy',
  'code-decoy-wrong',
  'code-decoy-hard',
  'code-ambiguous',
  'code-identical',
  'code-insufficient',
  'code-frame-loss',
] as const;

export type ScenarioId = (typeof SCENARIO_IDS)[number];

const RAW_SCENARIOS: Record<ScenarioId, unknown> = {
  stationary,
  'linear-pass': linearPass,
  circular,
  sinusoidal,
  waypoints,
  'seeded-maneuver': seededManeuver,
  'camera-boresight': cameraBoresight,
  'camera-target-outside-fov': cameraOutsideFov,
  'gimbal-step-response': gimbalStepResponse,
  'gimbal-latency': gimbalLatency,
  'gimbal-backlash': gimbalBacklash,
  'pat-stationary-outside-fov': patStationary,
  'pat-moving-target': patMoving,
  'pat-loss': patLoss,
  'astralock-stationary': astralockStationary,
  'astralock-moving': astralockMoving,
  'astralock-maneuver': astralockManeuver,
  'astralock-short-loss': astralockShortLoss,
  'astralock-handoff': astralockHandoff,
  'dist-vibration': distVibration,
  'dist-vibration-extreme': distVibrationExtreme,
  'dist-low-contrast': distLowContrast,
  'dist-frame-loss': distFrameLoss,
  'dist-decoy-easy': distDecoyEasy,
  'dist-decoy-hard': distDecoyHard,
  'dist-combined': distCombined,
  'code-clean': codeClean,
  'code-decoy-uncoded': codeDecoyUncoded,
  'code-decoy-easy': codeDecoyEasy,
  'code-decoy-wrong': codeDecoyWrong,
  'code-decoy-hard': codeDecoyHard,
  'code-ambiguous': codeAmbiguous,
  'code-identical': codeIdentical,
  'code-insufficient': codeInsufficient,
  'code-frame-loss': codeFrameLoss,
};

const cache = new Map<ScenarioId, SimulationConfig>();

/**
 * Parses a bundled scenario.
 *
 * @throws {z.ZodError} if a bundled scenario is invalid, which is a build-time
 * mistake rather than a user error; the scenario test parses all of them so
 * that failure surfaces in CI rather than in the application.
 */
export function loadScenario(id: ScenarioId): SimulationConfig {
  const cached = cache.get(id);
  if (cached !== undefined) return cached;

  const parsed = parseSimulationConfig(RAW_SCENARIOS[id]);
  cache.set(id, parsed);
  return parsed;
}

/** Every bundled scenario's id and display name, for the scenario picker. */
export function listScenarios(): readonly { readonly id: ScenarioId; readonly name: string }[] {
  return SCENARIO_IDS.map((id) => ({ id, name: loadScenario(id).name }));
}

/** The scenario opened on a cold start. */
export const DEFAULT_SCENARIO_ID: ScenarioId = 'linear-pass';
