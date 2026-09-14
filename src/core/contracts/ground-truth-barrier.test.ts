/**
 * Verifies the lint half of the ground-truth barrier.
 *
 * The type-level checks in isolation.test-d.ts prove a tracker cannot be
 * *handed* ground truth. This proves it cannot go and *fetch* it either, by
 * running the project's real ESLint configuration over probe files placed in a
 * tracking-side directory.
 *
 * A configuration test rather than a code test: the rule it checks lives in
 * eslint.config.js, and a well-meaning refactor of that file could remove the
 * barrier without any other test noticing.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ESLint } from 'eslint';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const probeDirectory = join(projectRoot, 'src', 'core', 'algorithms', '__lint_probe__');
const allowedDirectory = join(projectRoot, 'src', 'core', 'metrics', '__lint_probe__');
const uiDirectory = join(projectRoot, 'src', 'features', '__lint_probe__');
const coreDirectory = join(projectRoot, 'src', 'core', 'simulation', '__lint_probe__');

const RESTRICTED_RULE = '@typescript-eslint/no-restricted-imports';

/**
 * These tests run the project's real ESLint configuration, including the
 * type-aware project service, so the first lint pays for building a TypeScript
 * program over the whole repository. That is the cost of testing the actual
 * barrier rather than a copy of it, and it grows with the codebase.
 */
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

interface Probe {
  readonly path: string;
  readonly source: string;
}

const probes: readonly Probe[] = [
  {
    path: join(probeDirectory, 'value-import.ts'),
    source: `import { brandAsGroundTruth } from '@/core/contracts/ground-truth';\nexport const probe = brandAsGroundTruth;\n`,
  },
  {
    path: join(probeDirectory, 'type-import.ts'),
    source: `import type { GroundTruthState } from '@/core/contracts/ground-truth';\nexport type Probe = GroundTruthState;\n`,
  },
  {
    path: join(probeDirectory, 'relative-import.ts'),
    source: `import type { WorldState } from '../../contracts/ground-truth';\nexport type Probe = WorldState;\n`,
  },
  {
    path: join(probeDirectory, 'metrics-import.ts'),
    source: `export type { ExperimentSummary } from '@/core/metrics';\n`,
  },
  {
    path: join(probeDirectory, 'extension-import.ts'),
    source: `import type { GroundTruthState } from '@/core/contracts/ground-truth.js';\nexport type Probe = GroundTruthState;\n`,
  },
  {
    path: join(probeDirectory, 'deep-relative-import.ts'),
    source: `import type { GroundTruthState } from '../../../core/contracts/ground-truth';\nexport type Probe = GroundTruthState;\n`,
  },
  {
    path: join(probeDirectory, 'fixture-import.ts'),
    source: `import { makeValidRawConfig } from '@/test/fixtures';\nexport const probe = makeValidRawConfig;\n`,
  },
  {
    path: join(probeDirectory, 'safe-import.ts'),
    source: `import type { TrackingInput } from '@/core/contracts';\nexport type Probe = TrackingInput;\n`,
  },
  {
    path: join(allowedDirectory, 'privileged-import.ts'),
    source: `import type { GroundTruthState } from '@/core/contracts/ground-truth';\nexport type Probe = GroundTruthState;\n`,
  },
  {
    path: join(uiDirectory, 'fixture-import.ts'),
    source: `import { makeValidRawConfig } from '@/test/fixtures';\nexport const probe = makeValidRawConfig;\n`,
  },
  {
    path: join(probeDirectory, 'simulation-import.ts'),
    source: `import { SimulationEngine } from '@/core/simulation';\nexport const probe = SimulationEngine;\n`,
  },
  {
    path: join(probeDirectory, 'observer-view-import.ts'),
    source: `import { buildObserverFrame } from '@/core/simulation/observer-view';\nexport const probe = buildObserverFrame;\n`,
  },
  {
    path: join(probeDirectory, 'sensor-import.ts'),
    source: `import { VirtualCameraSensor } from '@/core/sensors';\nexport const probe = VirtualCameraSensor;\n`,
  },
  {
    path: join(probeDirectory, 'sensor-truth-import.ts'),
    source: `import type { SensorEvaluationTruth } from '@/core/sensors/sensor-truth';\nexport type Probe = SensorEvaluationTruth;\n`,
  },
  {
    path: join(probeDirectory, 'emitter-import.ts'),
    source: `import type { EmitterId } from '@/core/sensors/emitters';\nexport type Probe = EmitterId;\n`,
  },
  {
    path: join(probeDirectory, 'camera-frame-import.ts'),
    source: `import type { CameraSensorFrame } from '@/core/contracts';\nexport type Probe = CameraSensorFrame;\n`,
  },
  {
    path: join(coreDirectory, 'three-import.ts'),
    source: `import * as three from 'three';\nexport const probe = three;\n`,
  },
  {
    path: join(coreDirectory, 'react-import.ts'),
    source: `import { useState } from 'react';\nexport const probe = useState;\n`,
  },
  {
    path: join(coreDirectory, 'fiber-import.ts'),
    source: `import { Canvas } from '@react-three/fiber';\nexport const probe = Canvas;\n`,
  },
  {
    path: join(coreDirectory, 'store-import.ts'),
    source: `import { useNavigationStore } from '@/stores/navigation-store';\nexport const probe = useNavigationStore;\n`,
  },
  {
    path: join(coreDirectory, 'contracts-import.ts'),
    source: `import type { SimulationConfig } from '@/core/contracts/simulation';\nexport type Probe = SimulationConfig;\n`,
  },
];

/** Ids of rules that fired on a probe file. */
async function lintProbe(eslint: ESLint, path: string): Promise<readonly string[]> {
  const [result] = await eslint.lintFiles([path]);
  if (result === undefined) throw new Error(`ESLint returned no result for ${path}`);
  return result.messages.map((message) => message.ruleId ?? '<fatal>');
}

let eslint: ESLint;

beforeAll(() => {
  mkdirSync(probeDirectory, { recursive: true });
  mkdirSync(allowedDirectory, { recursive: true });
  mkdirSync(uiDirectory, { recursive: true });
  mkdirSync(coreDirectory, { recursive: true });
  for (const probe of probes) {
    writeFileSync(probe.path, probe.source, 'utf8');
  }
  eslint = new ESLint({ cwd: projectRoot });
});

beforeAll(async () => {
  // Warm the project service once, so the build cost lands here rather than
  // being charged to whichever test happens to run first.
  await lintProbe(eslint, join(probeDirectory, 'safe-import.ts'));
});

afterAll(() => {
  rmSync(probeDirectory, { recursive: true, force: true });
  rmSync(allowedDirectory, { recursive: true, force: true });
  rmSync(uiDirectory, { recursive: true, force: true });
  rmSync(coreDirectory, { recursive: true, force: true });
});

describe('ground-truth import barrier', () => {
  it('blocks a value import of the ground-truth module from an algorithm', async () => {
    const rules = await lintProbe(eslint, join(probeDirectory, 'value-import.ts'));
    expect(rules).toContain(RESTRICTED_RULE);
  });

  it('blocks a type-only import, which is the likeliest leak path', async () => {
    // The core `no-restricted-imports` rule ignores `import type`; the
    // typescript-eslint variant is configured precisely to catch this.
    const rules = await lintProbe(eslint, join(probeDirectory, 'type-import.ts'));
    expect(rules).toContain(RESTRICTED_RULE);
  });

  it('blocks a relative path that sidesteps the alias', async () => {
    const rules = await lintProbe(eslint, join(probeDirectory, 'relative-import.ts'));
    expect(rules).toContain(RESTRICTED_RULE);
  });

  it('blocks evaluation code, which would be an indirect route to truth', async () => {
    const rules = await lintProbe(eslint, join(probeDirectory, 'metrics-import.ts'));
    expect(rules).toContain(RESTRICTED_RULE);
  });

  it('blocks an import that names the file extension explicitly', async () => {
    const rules = await lintProbe(eslint, join(probeDirectory, 'extension-import.ts'));
    expect(rules).toContain(RESTRICTED_RULE);
  });

  it('blocks a deep relative path from any nesting level', async () => {
    const rules = await lintProbe(eslint, join(probeDirectory, 'deep-relative-import.ts'));
    expect(rules).toContain(RESTRICTED_RULE);
  });

  it('allows the contracts barrel, which carries no ground truth', async () => {
    const rules = await lintProbe(eslint, join(probeDirectory, 'safe-import.ts'));
    expect(rules).not.toContain(RESTRICTED_RULE);
  });

  it('leaves privileged consumers such as metrics free to read truth', async () => {
    const rules = await lintProbe(eslint, join(allowedDirectory, 'privileged-import.ts'));
    expect(rules).not.toContain(RESTRICTED_RULE);
  });
});

describe('simulation-core barrier', () => {
  it('blocks the tracking side from importing the simulation core', async () => {
    const rules = await lintProbe(eslint, join(probeDirectory, 'simulation-import.ts'));
    expect(rules).toContain(RESTRICTED_RULE);
  });

  it('blocks the tracking side from importing the ground-truth observer view', async () => {
    // The observer view renders the answer key. It is a debug view, not
    // something an algorithm may consult.
    const rules = await lintProbe(eslint, join(probeDirectory, 'observer-view-import.ts'));
    expect(rules).toContain(RESTRICTED_RULE);
  });
});

describe('sensor barrier', () => {
  it('blocks the tracking side from building its own camera', async () => {
    // A tracker that could run the sensor could also read the evaluation truth
    // the sensor produces alongside every frame.
    const rules = await lintProbe(eslint, join(probeDirectory, 'sensor-import.ts'));
    expect(rules).toContain(RESTRICTED_RULE);
  });

  it('blocks the per-frame evaluation truth', async () => {
    const rules = await lintProbe(eslint, join(probeDirectory, 'sensor-truth-import.ts'));
    expect(rules).toContain(RESTRICTED_RULE);
  });

  it('blocks emitter identity', async () => {
    // Handed emitter ids, a tracker would not need to solve association at all.
    const rules = await lintProbe(eslint, join(probeDirectory, 'emitter-import.ts'));
    expect(rules).toContain(RESTRICTED_RULE);
  });

  it('still allows the camera frame contract, which carries no truth', async () => {
    const rules = await lintProbe(eslint, join(probeDirectory, 'camera-frame-import.ts'));
    expect(rules).not.toContain(RESTRICTED_RULE);
  });
});

describe('core purity barrier', () => {
  // The simulation core has to run in a test, a worker and eventually a
  // headless benchmark runner. If it could import the renderer, world state
  // would drift into scene-graph transforms and component state.
  it.each([
    ['three', 'three-import.ts'],
    ['react', 'react-import.ts'],
    ['@react-three/fiber', 'fiber-import.ts'],
    ['a Zustand store', 'store-import.ts'],
  ])('blocks the core from importing %s', async (_label, file) => {
    const rules = await lintProbe(eslint, join(coreDirectory, file));
    expect(rules).toContain(RESTRICTED_RULE);
  });

  it('still lets the core import its own contracts', async () => {
    const rules = await lintProbe(eslint, join(coreDirectory, 'contracts-import.ts'));
    expect(rules).not.toContain(RESTRICTED_RULE);
  });
});

describe('test-fixture barrier', () => {
  it('blocks application code from importing test fixtures', async () => {
    const rules = await lintProbe(eslint, join(uiDirectory, 'fixture-import.ts'));
    expect(rules).toContain(RESTRICTED_RULE);
  });

  it('blocks the tracking side too, where the rule options are superseded', async () => {
    // The tracking-side block replaces this rule's options wholesale, so this
    // asserts the fixture pattern was carried across rather than dropped.
    const rules = await lintProbe(eslint, join(probeDirectory, 'fixture-import.ts'));
    expect(rules).toContain(RESTRICTED_RULE);
  });
});
