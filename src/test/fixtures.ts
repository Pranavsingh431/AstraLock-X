/**
 * Test fixtures.
 *
 * These are inputs for validation tests, deliberately kept as plain untyped
 * objects so they exercise the same parsing path an on-disk scenario file
 * would. They are not scenario content and are not used by the application.
 */

/** A raw config object that satisfies every rule in the schema. */
export function makeValidRawConfig(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: 'fixture-001',
    name: 'Fixture scenario',
    seed: 12345,
    duration: 10,
    tickRate: 200,
    platform: {
      initialPosition: { x: 0, y: 0, z: 30 },
      initialVelocity: { x: 0, y: 0, z: 0 },
      baseDisturbanceRms: 0.002,
      baseDisturbanceBandwidth: 20,
    },
    targets: [
      {
        label: 'Target A',
        initialPosition: { x: 1200, y: 0, z: 60 },
        initialVelocity: { x: 0, y: 14, z: 0 },
        radius: 0.5,
        beaconPower: 0.05,
      },
    ],
    camera: {
      width: 640,
      height: 480,
      focalLength: 1800,
      frameRate: 100,
      exposure: 0.002,
      gain: 1,
      format: 'mono8',
      readNoiseElectrons: 3.2,
      fullWellElectrons: 10000,
      dropoutProbability: 0.001,
    },
    gimbal: {
      azimuthLimits: { minAngle: -3.1, maxAngle: 3.1, maxRate: 2, maxAcceleration: 10 },
      elevationLimits: { minAngle: -0.5, maxAngle: 1.4, maxRate: 2, maxAcceleration: 10 },
      encoderResolution: 0.00005,
      encoderBias: 0.0001,
      reportingLatency: 0.001,
      servoBandwidth: 30,
    },
    atmosphere: {
      refractiveIndexStructure: 1e-14,
      visibility: 20000,
    },
  };
}
