/**
 * The disturbance configuration and the one scenario migration.
 *
 * Two things are being protected here. The first is that "clean" means clean:
 * `isCleanDisturbance` decides whether the sensor takes the Phase-6 image
 * formation path unchanged, so a configuration it wrongly calls clean would
 * silently disable a disturbance, and one it wrongly calls dirty would change
 * Phase-6 pixels for no reason.
 *
 * The second is that every experiment recorded before Phase 7 can still be
 * loaded and re-run. A recorded run whose scenario no longer parses is not
 * reproducible, and reproducibility is most of what the recording was for.
 */

import { describe, expect, it } from 'vitest';

import { makeValidRawConfig } from '@/test/fixtures';

import {
  CLEAN_DISTURBANCES,
  isCleanDisturbance,
  parseDisturbanceConfig,
  type DisturbanceConfig,
} from './disturbance';
import {
  MIGRATABLE_SCENARIO_VERSION,
  SIMULATION_CONFIG_SCHEMA_VERSION,
  migrateScenarioDocument,
  parseSimulationConfig,
  safeParseSimulationConfig,
} from './simulation';

/** The clean configuration with one branch overridden. */
function withPatch(patch: (config: DisturbanceConfig) => DisturbanceConfig): DisturbanceConfig {
  return patch(structuredClone(CLEAN_DISTURBANCES));
}

describe('the clean configuration', () => {
  it('parses, so the default is a real document and not a type-level fiction', () => {
    expect(() => parseDisturbanceConfig(CLEAN_DISTURBANCES)).not.toThrow();
  });

  it('is clean', () => {
    expect(isCleanDisturbance(CLEAN_DISTURBANCES)).toBe(true);
  });

  it('is frozen, so one scenario cannot mutate the default for the next', () => {
    expect(Object.isFrozen(CLEAN_DISTURBANCES)).toBe(true);
  });
});

describe('deciding whether a configuration is clean', () => {
  // An effect that is switched on but configured to zero does nothing. Treating
  // it as dirty would cost the Phase-6 fast path for no change to any pixel.
  it.each([
    [
      'platform bias',
      (c: DisturbanceConfig) => ({ ...c, platform: { ...c.platform, enabled: true } }),
    ],
    [
      'a zero-amplitude tone',
      (c: DisturbanceConfig) => ({
        ...c,
        platform: {
          ...c.platform,
          enabled: true,
          tones: [
            {
              axis: 'azimuth' as const,
              amplitude: 0 as never,
              frequency: 10 as never,
              phase: 0 as never,
            },
          ],
        },
      }),
    ],
    [
      'zero-strength scintillation',
      (c: DisturbanceConfig) => ({
        ...c,
        atmosphere: {
          ...c.atmosphere,
          scintillation: { ...c.atmosphere.scintillation, enabled: true },
        },
      }),
    ],
    [
      'zero read noise',
      (c: DisturbanceConfig) => ({
        ...c,
        sensor: { ...c.sensor, readNoise: { enabled: true, sigma: 0 } },
      }),
    ],
    [
      'independent dropouts at zero probability',
      (c: DisturbanceConfig) => ({
        ...c,
        dropouts: { ...c.dropouts, mode: 'independent' as const },
      }),
    ],
    [
      'a single exposure sub-sample',
      (c: DisturbanceConfig) => ({
        ...c,
        optics: { ...c.optics, exposure: { enabled: true, subSamples: 1 } },
      }),
    ],
  ])('still calls it clean with %s', (_label, patch) => {
    expect(isCleanDisturbance(withPatch(patch))).toBe(true);
  });

  it.each([
    [
      'a real vibration tone',
      (c: DisturbanceConfig) => ({
        ...c,
        platform: {
          ...c.platform,
          enabled: true,
          tones: [
            {
              axis: 'azimuth' as const,
              amplitude: 1e-4 as never,
              frequency: 12 as never,
              phase: 0 as never,
            },
          ],
        },
      }),
    ],
    [
      'attenuation',
      (c: DisturbanceConfig) => ({
        ...c,
        atmosphere: { ...c.atmosphere, attenuation: { enabled: true, dbPerKm: 2 } },
      }),
    ],
    [
      'read noise',
      (c: DisturbanceConfig) => ({
        ...c,
        sensor: { ...c.sensor, readNoise: { enabled: true, sigma: 2 } },
      }),
    ],
    [
      'burst dropouts',
      (c: DisturbanceConfig) => ({ ...c, dropouts: { ...c.dropouts, mode: 'burst' as const } }),
    ],
    [
      'multi-sample exposure',
      (c: DisturbanceConfig) => ({
        ...c,
        optics: { ...c.optics, exposure: { enabled: true, subSamples: 8 } },
      }),
    ],
  ])('calls it dirty with %s', (_label, patch) => {
    expect(isCleanDisturbance(withPatch(patch))).toBe(false);
  });

  // Disabling is absolute: a configured value that is switched off does
  // nothing, so the operator can park a profile without deleting it.
  it('ignores configured values behind a disabled flag', () => {
    const parked = withPatch((c) => ({
      ...c,
      sensor: { readNoise: { enabled: false, sigma: 12 }, shotNoise: { enabled: false, scale: 4 } },
    }));
    expect(isCleanDisturbance(parked)).toBe(true);
  });
});

describe('migrating a version-4 scenario', () => {
  /** The version-4 shape, as every Phase 3 to Phase 6 run stored it. */
  function version4Document(): Record<string, unknown> {
    const raw = makeValidRawConfig();
    raw['schemaVersion'] = MIGRATABLE_SCENARIO_VERSION;
    delete raw['disturbances'];
    raw['platform'] = {
      ...(raw['platform'] as Record<string, unknown>),
      baseDisturbanceRms: 0.002,
      baseDisturbanceBandwidth: 20,
    };
    raw['camera'] = {
      ...(raw['camera'] as Record<string, unknown>),
      readNoiseElectrons: 3.2,
      fullWellElectrons: 10_000,
      dropoutProbability: 0.001,
    };
    raw['atmosphere'] = { refractiveIndexStructure: 1e-14, visibility: 20_000 };
    return raw;
  }

  it('parses, which is what keeps every recorded Phase 3 to Phase 6 run re-runnable', () => {
    const config = parseSimulationConfig(version4Document());
    expect(config.schemaVersion).toBe(SIMULATION_CONFIG_SCHEMA_VERSION);
  });

  it('records that the run had no disturbances, because it provably had none', () => {
    const config = parseSimulationConfig(version4Document());
    expect(isCleanDisturbance(config.disturbances)).toBe(true);
    expect(config.disturbances.preset).toBe('CLEAN');
  });

  it('drops the five fields that declared effects nothing ever computed', () => {
    const migrated = migrateScenarioDocument(version4Document()) as Record<string, unknown>;
    const platform = migrated['platform'] as Record<string, unknown>;
    const camera = migrated['camera'] as Record<string, unknown>;

    expect(migrated['atmosphere']).toBeUndefined();
    expect(platform['baseDisturbanceRms']).toBeUndefined();
    expect(platform['baseDisturbanceBandwidth']).toBeUndefined();
    expect(camera['readNoiseElectrons']).toBeUndefined();
    expect(camera['fullWellElectrons']).toBeUndefined();
    expect(camera['dropoutProbability']).toBeUndefined();
  });

  it('changes nothing else about the experiment', () => {
    const original = version4Document();
    const migrated = parseSimulationConfig(original);

    expect(migrated.seed).toBe(original['seed']);
    expect(migrated.duration).toBe(original['duration']);
    expect(migrated.tickRate).toBe(original['tickRate']);
    expect(migrated.targets).toHaveLength((original['targets'] as unknown[]).length);
    expect(migrated.camera.width).toBe((original['camera'] as Record<string, number>)['width']);
  });

  it('does not modify the document it was given', () => {
    const document = version4Document();
    migrateScenarioDocument(document);
    expect(document['schemaVersion']).toBe(MIGRATABLE_SCENARIO_VERSION);
    expect(document['atmosphere']).toBeDefined();
  });

  it('leaves a version-5 document alone', () => {
    const current = makeValidRawConfig();
    expect(migrateScenarioDocument(current)).toBe(current);
  });

  // The migration must not become a general "make it parse" hammer. A version
  // it cannot understand has to fail with its own version named in the error.
  it.each([1, 2, 3, 6])('does not touch version %i', (version) => {
    const raw = makeValidRawConfig();
    raw['schemaVersion'] = version;
    expect(migrateScenarioDocument(raw)).toBe(raw);
    expect(safeParseSimulationConfig(raw).success).toBe(false);
  });

  it.each([null, undefined, 42, 'scenario', []])('passes %s through untouched', (input) => {
    expect(migrateScenarioDocument(input)).toBe(input);
  });
});
