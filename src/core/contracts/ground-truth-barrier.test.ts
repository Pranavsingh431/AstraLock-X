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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const probeDirectory = join(projectRoot, 'src', 'core', 'algorithms', '__lint_probe__');
const allowedDirectory = join(projectRoot, 'src', 'core', 'metrics', '__lint_probe__');
const uiDirectory = join(projectRoot, 'src', 'features', '__lint_probe__');

const RESTRICTED_RULE = '@typescript-eslint/no-restricted-imports';

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
  for (const probe of probes) {
    writeFileSync(probe.path, probe.source, 'utf8');
  }
  eslint = new ESLint({ cwd: projectRoot });
});

afterAll(() => {
  rmSync(probeDirectory, { recursive: true, force: true });
  rmSync(allowedDirectory, { recursive: true, force: true });
  rmSync(uiDirectory, { recursive: true, force: true });
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
