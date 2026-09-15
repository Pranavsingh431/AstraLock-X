// @vitest-environment node
/**
 * Both algorithms against the same disturbed physics.
 *
 * Every comparison here is paired: same scenario document, same seed, same
 * target motion, same camera, same mount, same disturbance realization, same
 * dropped frames, same decoys, same metric definitions. Only the algorithm and
 * its configuration differ.
 *
 * **These tests do not require AstraLock-X to win.** Several of them record it
 * losing, because it does. A test suite that only encoded the outcome its author
 * hoped for would be a way of not finding out.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_ASTRALOCK_CONFIG,
  DEFAULT_BASELINE_PAT_CONFIG,
  astraLockXPat,
  baselineKfPidPat,
} from '@/core/algorithms';
import { buildRig, drive } from '@/core/experiments/rig.node';
import { MemoryStorage } from '@/core/experiments/storage';
import type { ExperimentSummary } from '@/core/experiments/schema';
import type { ScenarioId } from '@/scenarios';

vi.setConfig({ testTimeout: 1_800_000 });

interface ArmResult {
  readonly summary: ExperimentSummary;
  readonly modes: readonly string[];
}

/** Runs one arm and returns its recorded summary. */
async function arm(scenario: ScenarioId, robust: boolean, seconds: number): Promise<ArmResult> {
  const rig = buildRig({
    scenario,
    storage: new MemoryStorage(),
    runId: `${scenario}-${robust ? 'robust' : 'baseline'}`,
    plugin: robust ? astraLockXPat : baselineKfPidPat,
    algorithmConfig: robust ? DEFAULT_ASTRALOCK_CONFIG : DEFAULT_BASELINE_PAT_CONFIG,
  });
  await rig.recorder!.start({ autonomyActive: true });
  const trace = drive(rig, seconds);
  return {
    summary: await rig.recorder!.complete(),
    modes: trace.modes
      .map((entry) => entry.split('@')[0]!)
      .filter((mode, index, all) => mode !== all[index - 1]),
  };
}

/**
 * One run per scenario, shared by every assertion about it.
 *
 * Each arm is a full closed-loop simulation, so running one per expectation
 * would mean forty simulations for fourteen facts. The results are pure
 * functions of the scenario and the seed, so computing them once is not a
 * shortcut — it is the same answer, once.
 */
const cache = new Map<string, Promise<{ baseline: ArmResult; robust: ArmResult }>>();

function pair(scenario: ScenarioId, seconds: number) {
  const key = `${scenario}:${String(seconds)}`;
  let result = cache.get(key);
  if (result === undefined) {
    result = (async () => ({
      baseline: await arm(scenario, false, seconds),
      robust: await arm(scenario, true, seconds),
    }))();
    cache.set(key, result);
  }
  return result;
}

const urad = (m: { value: number | null }): number | null =>
  m.value === null ? null : m.value * 1e6;

describe('A. platform vibration the mount can counteract', () => {
  it('is acquired by both, and the disturbance is measured rather than assumed', async () => {
    const { baseline, robust } = await pair('dist-vibration', 45);

    expect(baseline.summary.acquisitionOutcome).toBe('acquired');
    expect(robust.summary.acquisitionOutcome).toBe('acquired');

    // The scenario asks for a 0.03 degree tone plus 0.008 degrees of jitter.
    // The measured RMS of the realization has to agree with that, or the
    // comparison is against physics nobody specified.
    const measured = urad(robust.summary.disturbance!.platformJitterRmsAzimuth)!;
    expect(measured).toBeGreaterThan(250);
    expect(measured).toBeLessThan(450);
  });

  // The result, recorded because it is the result. Base vibration is unmodelled
  // process noise to an estimator that has no term for it, so excursions of
  // several hundred microradians look like outliers to a chi-square innovation
  // gate whose covariance says the target should be within sixty. The baseline
  // has no gate and simply follows the blob.
  it('costs AstraLock-X retention, because its gate rejects the excursions', async () => {
    const { baseline, robust } = await pair('dist-vibration', 45);

    expect(baseline.summary.lockRetentionRate.value).toBeGreaterThan(0.9);
    expect(robust.summary.lockRetentionRate.value).toBeLessThan(0.8);
    expect(robust.summary.algorithmRecovery!.entries).toBeGreaterThan(10);
  });
});

describe('B. platform vibration beyond the mount', () => {
  // A regime neither algorithm can survive. The point is that both fail
  // *honestly* — no acquisition, no confirmed lock — rather than reporting
  // performance the physics cannot support.
  it('defeats both, and both say so', async () => {
    const { baseline, robust } = await pair('dist-vibration-extreme', 25);

    expect(baseline.summary.acquisitionOutcome).not.toBe('acquired');
    expect(robust.summary.acquisitionOutcome).not.toBe('acquired');
    expect(baseline.summary.lockRetentionRate.value ?? 0).toBeLessThan(0.05);
    expect(robust.summary.lockRetentionRate.value ?? 0).toBeLessThan(0.05);
  });

  it('does not invent a pointing figure for a run that never locked', async () => {
    const { robust } = await pair('dist-vibration-extreme', 25);
    expect(robust.summary.angularPointingError.postAcquisition.rms.value).toBeNull();
    expect(robust.summary.angularPointingError.postAcquisition.rms.status).not.toBe('derived');
  });
});

describe('C. low contrast and sensor noise', () => {
  it('is still acquired by both: dim, not impossible', async () => {
    const { baseline, robust } = await pair('dist-low-contrast', 45);
    expect(baseline.summary.acquisitionOutcome).toBe('acquired');
    expect(robust.summary.acquisitionOutcome).toBe('acquired');
  });

  it('measures a real image SNR rather than reporting a fabricated one', async () => {
    const { robust } = await pair('dist-low-contrast', 45);
    const snr = robust.summary.disturbance!.imageSnrDb;

    expect(snr.count).toBeGreaterThan(20);
    expect(snr.mean.value).not.toBeNull();
    // A finite, plausible figure — and emphatically not the 0 dB placeholder
    // Phase 5 removed.
    expect(Number.isFinite(snr.mean.value!)).toBe(true);
    expect(snr.mean.value).not.toBe(0);
  });

  // Both arms share one detector, so a perception weakness shows in both. What
  // differs is what each does about a weak candidate: the baseline takes the
  // strongest blob whatever its score, and AstraLock-X refuses one below its
  // threshold, which it then counts as a miss.
  it('costs the robust arm detections that the baseline simply accepts', async () => {
    const { baseline, robust } = await pair('dist-low-contrast', 45);
    expect(robust.summary.detectorMissesWithTargetInImage).toBeGreaterThan(
      baseline.summary.detectorMissesWithTargetInImage,
    );
  });
});

describe('D. bursty frame loss', () => {
  it('drops the same frames for both arms', async () => {
    const { baseline, robust } = await pair('dist-frame-loss', 45);

    expect(baseline.summary.disturbance!.framesDropped).toBeGreaterThan(100);
    expect(robust.summary.disturbance!.framesDropped).toBe(
      baseline.summary.disturbance!.framesDropped,
    );
    // Runs, not isolated losses: a single missing frame is coasted over without
    // either algorithm noticing, and proves nothing about recovery.
    expect(robust.summary.disturbance!.longestDropBurstFrames).toBeGreaterThan(20);
  });

  it('delivers nothing at all for a dropped frame, rather than a blank one', async () => {
    const { robust } = await pair('dist-frame-loss', 45);
    const dropped = robust.summary.disturbance!.framesDropped;
    const scheduled = robust.summary.sensorFramesGenerated + dropped;

    // Every scheduled frame was either processed or never existed.
    expect(robust.summary.algorithmFramesProcessed).toBeLessThanOrEqual(scheduled - dropped);
  });

  // An honest negative result. AstraLock-X counts consecutive *processed* frames
  // without a detection, so a frame that never arrives is never counted, and
  // pure delivery loss does not put it into RECOVER at all. Its predictive
  // recovery — the thing that wins the Phase 6 loss scenario — is therefore
  // never engaged here, and its longer extrapolation across the gap costs it
  // more than the baseline's simpler filter.
  it('does not engage AstraLock-X recovery, because a missing frame is not a miss', async () => {
    const { robust } = await pair('dist-frame-loss', 45);
    expect(robust.summary.algorithmRecovery!.entries).toBe(0);
  });
});

describe('E. an obvious decoy', () => {
  // Phase 5 built the false-lock machinery and reported it "not exercised" on
  // every run, because no scenario had a second emitter. This is the first time
  // it fires.
  it('finally exercises the false-lock challenge, which no earlier scenario could', async () => {
    const { baseline } = await pair('dist-decoy-easy', 45);
    expect(baseline.summary.falseLockExercised).toBe(true);
  });

  // The robust arm never sees the intruder at all, and that is the correct
  // outcome rather than a gap in the test: the decoy sits about thirty degrees
  // off the designated target's bearing, so once AstraLock-X is tracking, the
  // decoy is outside a twelve-degree field of view and never projects into the
  // image. "Obvious" here means separable by geometry alone.
  it('never even puts the intruder in the robust arm’s image', async () => {
    const { robust } = await pair('dist-decoy-easy', 45);
    expect(robust.summary.falseLockExercised).toBe(false);
    expect(robust.summary.falseLockEpisodes).toBe(0);
  });

  // The baseline picks the strongest blob and has no way to prefer one source
  // over another, so a brighter intruder simply wins. AstraLock-X rejects it on
  // motion and innovation consistency and stays on the designated target.
  it('captures the baseline and not the robust arm', async () => {
    const { baseline, robust } = await pair('dist-decoy-easy', 45);

    // The baseline takes the strongest blob and has no way to prefer one source
    // over another, so a brighter intruder simply wins — and it never acquires
    // the target it was asked to track.
    expect(baseline.summary.falseLockEpisodes).toBeGreaterThan(0);
    expect(baseline.summary.acquisitionOutcome).not.toBe('acquired');

    expect(robust.summary.falseLockEpisodes).toBe(0);
    expect(robust.summary.acquisitionOutcome).toBe('acquired');
  });
});

describe('F. a plausible decoy', () => {
  // The result this phase exists to expose, and it is a failure. A comparably
  // bright intruder crossing close to the predicted track cannot be told from
  // the designated target by image and motion alone, because nothing in either
  // algorithm carries identity. AstraLock-X follows the wrong source.
  //
  // This is NOT fixed here. Phase 8 is where identity belongs.
  it('fools AstraLock-X, which has nothing to tell the two sources apart', async () => {
    const { robust } = await pair('dist-decoy-hard', 50);

    expect(robust.summary.falseLockExercised).toBe(true);
    expect(robust.summary.falseLockEpisodes).toBeGreaterThan(0);
    expect(robust.summary.falseLockDurationSeconds.value).toBeGreaterThan(5);
  });

  it('records it as a wrong-source lock and not merely as a loss of lock', async () => {
    const { robust } = await pair('dist-decoy-hard', 50);

    // The two are different failures. A high pointing error alone is a loss;
    // this is the tracker holding a confident detection on the wrong emitter.
    expect(robust.summary.falseLockEpisodes).toBeGreaterThan(0);
    expect(robust.summary.falseLockRate.value).toBeGreaterThan(0);
  });
});

describe('G. combined stress', () => {
  it('runs both arms against one realization of several effects at once', async () => {
    const { baseline, robust } = await pair('dist-combined', 60);

    const active = robust.summary.disturbance!.active;
    expect(active).toContain('platform');
    expect(active).toContain('wander');
    expect(active).toContain('scintillation');
    expect(active).toContain('dropouts');
    expect(active).toContain('sensor-noise');

    expect(baseline.summary.acquisitionOutcome).toBe('acquired');
    expect(robust.summary.acquisitionOutcome).toBe('acquired');
  });

  // Here the robust arm wins, and for the reason it was built: the distant
  // intruder repeatedly captures the baseline's strongest-blob selection, and
  // gating rejects it.
  it('keeps AstraLock-X on the designated target while the baseline is repeatedly taken', async () => {
    const { baseline, robust } = await pair('dist-combined', 60);

    expect(baseline.summary.falseLockEpisodes).toBeGreaterThan(0);
    expect(robust.summary.falseLockEpisodes).toBe(0);
    expect(robust.summary.lockRetentionRate.value).toBeGreaterThan(
      baseline.summary.lockRetentionRate.value! * 0.8,
    );
  });

  it('names the preset for provenance without relying on it for the parameters', async () => {
    const { robust } = await pair('dist-combined', 60);
    expect(robust.summary.disturbance!.preset).toBe('COMBINED_STRESS');
    // The measured values come from the realization, not from the preset name.
    expect(robust.summary.disturbance!.scintillationGain.count).toBeGreaterThan(1000);
  });
});

describe('the pairing itself', () => {
  it('gives both arms an identical disturbance realization', async () => {
    const { baseline, robust } = await pair('dist-combined', 60);
    const a = baseline.summary.disturbance!;
    const b = robust.summary.disturbance!;

    // The realization is a function of the seed and the frame index, so it
    // cannot depend on which tracker was flying.
    expect(b.platformJitterRmsAzimuth.value).toBeCloseTo(a.platformJitterRmsAzimuth.value!, 12);
    expect(b.apparentWanderRmsAzimuth.value).toBeCloseTo(a.apparentWanderRmsAzimuth.value!, 12);
    expect(b.scintillationGain.mean.value).toBeCloseTo(a.scintillationGain.mean.value!, 12);
    expect(b.framesDropped).toBe(a.framesDropped);
  });

  it('scores both arms under the same metric definition', async () => {
    const { baseline, robust } = await pair('dist-vibration', 45);
    expect(robust.summary.metricsDefinitionVersion).toBe(baseline.summary.metricsDefinitionVersion);
    expect(robust.summary.metricsFingerprint).toBe(baseline.summary.metricsFingerprint);
  });
});
