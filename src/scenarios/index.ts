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

import circular from './circular.json';
import linearPass from './linear-pass.json';
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
] as const;

export type ScenarioId = (typeof SCENARIO_IDS)[number];

const RAW_SCENARIOS: Record<ScenarioId, unknown> = {
  stationary,
  'linear-pass': linearPass,
  circular,
  sinusoidal,
  waypoints,
  'seeded-maneuver': seededManeuver,
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
