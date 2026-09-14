import { describe, expect, it } from 'vitest';

import { SimulationEngine } from '@/core/simulation/engine';
import { SCENARIO_IDS, loadScenario } from '@/scenarios';

import { deserializeScenario, scenarioFilename, serializeScenario } from './scenario-io';

describe('serializeScenario', () => {
  it('produces JSON that parses back to an equivalent config', () => {
    const original = loadScenario('circular');
    const result = deserializeScenario(serializeScenario(original));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config).toEqual(original);
  });

  it.each(SCENARIO_IDS)('%s reproduces the same run after a round trip', (id) => {
    // The saved document must be sufficient to reproduce the world evolution;
    // that is the whole point of saving it.
    const original = loadScenario(id);
    const restored = deserializeScenario(serializeScenario(original));
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;

    const a = new SimulationEngine(original);
    const b = new SimulationEngine(restored.config);
    a.step(1_000);
    b.step(1_000);

    expect(b.stateHash()).toBe(a.stateHash());
  });
});

describe('deserializeScenario', () => {
  it('reports malformed JSON rather than throwing', () => {
    const result = deserializeScenario('{ not json');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('Not valid JSON');
  });

  it('reports which field was wrong', () => {
    const config = { ...loadScenario('stationary'), tickRate: -5 };
    const result = deserializeScenario(JSON.stringify(config));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('tickRate');
  });

  it('rejects a document that is not a scenario at all', () => {
    expect(deserializeScenario('{"hello":"world"}').ok).toBe(false);
    expect(deserializeScenario('[]').ok).toBe(false);
    expect(deserializeScenario('null').ok).toBe(false);
  });

  it('rejects an unknown trajectory kind with a usable message', () => {
    const config = loadScenario('linear-pass');
    const broken = {
      ...config,
      targets: [{ ...config.targets[0], trajectory: { kind: 'warp' } }],
    };
    const result = deserializeScenario(JSON.stringify(broken));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message.length).toBeGreaterThan(0);
  });
});

describe('scenarioFilename', () => {
  it('derives a safe filename from the scenario id', () => {
    expect(scenarioFilename(loadScenario('linear-pass'))).toBe('linear-pass.json');
  });

  it('sanitises anything unusual in the id', () => {
    const config = { ...loadScenario('stationary'), id: 'My Run/2026 #1' };
    expect(scenarioFilename(config)).toMatch(/^[a-z0-9-]+\.json$/);
  });
});
