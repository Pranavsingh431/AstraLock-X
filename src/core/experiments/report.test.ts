// @vitest-environment node
/**
 * How the report presents frame rates.
 *
 * "FPS" names four different things in this system — what the camera was
 * configured for, how many frames were generated, the window they were counted
 * over, and the rate that division produces — and a report that blurs them
 * invites a reader to compare the wrong pair of numbers. A rate also carries
 * only as much precision as its window affords, and over a very short window
 * that is not much.
 */

import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_ASTRALOCK_CONFIG, astraLockXPat } from '@/core/algorithms';
import { loadScenario } from '@/scenarios';

import { renderStoredReport } from './report';
import { buildRig, drive } from './rig.node';
import { MemoryStorage } from './storage';

vi.setConfig({ testTimeout: 900_000 });

/** Records a run of `seconds` of autonomous operation and renders its report. */
async function reportFor(seconds: number, runId: string): Promise<string> {
  const storage = new MemoryStorage();
  const rig = buildRig({
    scenario: 'astralock-stationary',
    storage,
    runId,
    plugin: astraLockXPat,
    algorithmConfig: DEFAULT_ASTRALOCK_CONFIG,
  });
  await rig.recorder!.start({ autonomyActive: true });
  drive(rig, seconds);
  const summary = await rig.recorder!.complete();
  return renderStoredReport(storage, runId, summary);
}

describe('the frame statistics section', () => {
  it('separates the configured rate, the frame count, the window and the observed rate', async () => {
    const html = await reportFor(20, 'run-fps-long');

    expect(html).toContain('Configured sensor rate');
    expect(html).toContain('Sensor frames generated');
    expect(html).toContain('Measurement window');
    expect(html).toContain('Observed sensor rate');
    // The configured figure is labelled as an instruction, so it cannot be read
    // as evidence of what the sensor did.
    expect(html).toContain('What the camera was asked for, not a measurement.');
  });

  it('quotes a rate measured over a long window to the precision it earns', async () => {
    const html = await reportFor(20, 'run-fps-precision');

    // 20 s of window: one frame either way is 0.05 fps, so two decimals are
    // meaningful and the short-window footnote must not appear.
    expect(html).toMatch(/<td>60\.00 fps/);
    expect(html).not.toContain('Short window:');
  });

  it('drops digits it cannot support on a very short window, without changing the number', async () => {
    const html = await reportFor(0.5, 'run-fps-short');

    // Half a second: one frame either way is 2 fps. Three decimals would be
    // fiction, so the figure is quoted whole and footnoted.
    expect(html).toContain('Short window:');
    expect(html).toMatch(/one frame either way is 2\.0 fps/);
    // Still the real measurement — the count over the window, not the
    // configured 60, and not rounded to it either.
    const match =
      /<th>Observed sensor rate<\/th><td>(\d+) fps <span class="sub">(\d+) frames over ([\d.]+) s/.exec(
        html,
      );
    expect(match).not.toBeNull();
    const [, rate, frames, window] = match!;
    expect(Number(rate)).toBe(Math.round(Number(frames) / Number(window)));
  });
});

describe('the beacon identity section', () => {
  /** Records a coded run with identity on or off and renders its report. */
  async function codedReport(identity: boolean, runId: string): Promise<string> {
    const storage = new MemoryStorage();
    const code = loadScenario('code-decoy-hard').targets[0]!.beacon!.identityCode!;
    const rig = buildRig({
      scenario: 'code-decoy-hard',
      storage,
      runId,
      plugin: astraLockXPat,
      algorithmConfig: {
        ...DEFAULT_ASTRALOCK_CONFIG,
        identity: {
          ...DEFAULT_ASTRALOCK_CONFIG.identity,
          enabled: identity,
          expectedSequence: code.sequence,
          symbolDuration: code.symbolDuration as number,
        },
      },
    });
    await rig.recorder!.start({ autonomyActive: true });
    drive(rig, 30);
    const summary = await rig.recorder!.complete();
    return renderStoredReport(storage, runId, summary);
  }

  it('reports what the tracker claimed and whether it was right', async () => {
    const html = await codedReport(true, 'run-identity-on');

    expect(html).toContain('Beacon identity');
    expect(html).toContain('Challenges');
    expect(html).toContain('Claimed recognition');
    expect(html).toContain('Wrong recognitions');
    expect(html).toContain('on the designated target');
  });

  it('says plainly that the correlation is not a probability', async () => {
    const html = await codedReport(true, 'run-identity-probability');

    expect(html).toContain('not a probability');
    // A coefficient on [-1, 1], never dressed up as a percentage or a
    // confidence. The section states the range rather than leaving a reader to
    // assume one.
    expect(html).toContain('[-1, 1]');
  });

  it('separates a wrong recognition from a false lock in the definitions', async () => {
    const html = await codedReport(true, 'run-identity-definitions');

    expect(html).toContain('Wrong recognition');
    expect(html).toContain('what it claimed to have recognised');
  });

  it('has no identity section at all for a run that never gave a verdict', async () => {
    // The same coded world, with the correlator switched off. An algorithm with
    // no opinion to score must not be shown an empty table of identity results.
    const html = await codedReport(false, 'run-identity-off');

    expect(html).toContain('False lock on a wrong source');
    expect(html).not.toContain('<h2>Beacon identity</h2>');
  });
});
