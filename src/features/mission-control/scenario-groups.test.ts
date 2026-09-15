/**
 * The scenario selector's groups.
 *
 * Grouping thirty-five scenarios into six headings is a readability decision,
 * but it introduces a way to lose one: a scenario added later and not listed
 * here would still exist, still run from a test, and simply never appear in
 * the interface. That is exactly the kind of failure nobody notices, so it is
 * checked rather than trusted.
 */

import { describe, expect, it } from 'vitest';

import { SCENARIO_IDS } from '@/scenarios';

import { SCENARIO_GROUPS, SCENARIO_PURPOSE, ungroupedScenarios } from './scenario-groups';

describe('the scenario groups', () => {
  it('reach every bundled scenario', () => {
    expect(ungroupedScenarios()).toEqual([]);
  });

  it('list each scenario exactly once', () => {
    const listed = SCENARIO_GROUPS.flatMap((group) => group.ids);
    expect(listed).toHaveLength(new Set(listed).size);
    expect(listed).toHaveLength(SCENARIO_IDS.length);
  });

  it('name only scenarios that exist', () => {
    const known = new Set<string>(SCENARIO_IDS);
    for (const group of SCENARIO_GROUPS) {
      for (const id of group.ids) expect(known.has(id)).toBe(true);
    }
    for (const id of Object.keys(SCENARIO_PURPOSE)) expect(known.has(id)).toBe(true);
  });
});
