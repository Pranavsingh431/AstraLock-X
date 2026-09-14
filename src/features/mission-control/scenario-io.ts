/**
 * Scenario import and export.
 *
 * The two functions here are pure, so the round trip can be tested without a
 * DOM. The file-picker and download plumbing that uses them is a few lines in
 * the component and is deliberately thin: a saved scenario is just the
 * validated config as JSON, and that document is sufficient on its own to
 * reproduce the run.
 *
 * What is *not* saved is as important: no view state, no camera pose, no
 * playback speed. Those describe how someone was looking at a run, not what the
 * run was.
 */

import type { z } from 'zod';

import { type SimulationConfig, safeParseSimulationConfig } from '@/core/contracts/simulation';

/** Serialises a config for download. Indented, since a human may read it. */
export function serializeScenario(config: SimulationConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

export type ScenarioParseResult =
  | { readonly ok: true; readonly config: SimulationConfig }
  | { readonly ok: false; readonly message: string };

/** Formats a Zod issue list into something a person can act on. */
function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 6)
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `${path}: ${issue.message}`;
    })
    .join('\n');
}

/**
 * Parses scenario JSON.
 *
 * Returns a message rather than throwing, because the caller is a file picker
 * and the likeliest input is a file that is not a scenario at all.
 */
export function deserializeScenario(text: string): ScenarioParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      message: `Not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const result = safeParseSimulationConfig(parsed);
  if (result.success) return { ok: true, config: result.data };

  return { ok: false, message: describeIssues(result.error) };
}

/** Filename a scenario downloads as. */
export function scenarioFilename(config: SimulationConfig): string {
  const safeId = config.id.replace(/[^a-z0-9-]+/gi, '-').toLowerCase();
  return `${safeId || 'scenario'}.json`;
}
