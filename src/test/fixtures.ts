/**
 * Test fixtures.
 *
 * These are inputs for validation tests, deliberately kept as plain untyped
 * objects so they exercise the same parsing path an on-disk scenario file
 * would. They are not scenario content and are not used by the application;
 * the lint barrier stops application code importing them.
 */

/** A raw config object that satisfies every rule in the schema. */
export function makeValidRawConfig(): Record<string, unknown> {
  return {
    schemaVersion: 5,
    id: 'fixture-001',
    name: 'Fixture scenario',
    seed: 12345,
    duration: 10,
    tickRate: 200,
    platform: {
      initialPosition: { x: 0, y: 0, z: 30 },
      initialVelocity: { x: 0, y: 0, z: 0 },
    },
    targets: [
      {
        label: 'Target A',
        trajectory: {
          kind: 'linear',
          position: { x: 1200, y: 0, z: 60 },
          velocity: { x: 0, y: 14, z: 0 },
        },
        radius: 0.5,
        beacon: { transmitPower: 0.05, intensity: 0.9, psfSigma: 2 },
      },
    ],
    camera: {
      width: 640,
      height: 480,
      horizontalFov: 0.2,
      verticalFovPolicy: 'square-pixels',
      principalPoint: null,
      nearRange: 1,
      farRange: 50000,
      frameRate: 100,
      backgroundLevel: 0,
      exposure: 0.002,
      gain: 1,
      format: 'mono8',
    },
    gimbal: {
      pan: {
        initialAngle: 0,
        minAngle: -3.0,
        maxAngle: 3.0,
        maxRate: 2,
        maxAcceleration: 10,
        naturalFrequency: 8,
        dampingRatio: 0.9,
        deadband: 0.00002,
        backlash: 0,
        encoderResolution: 0.00002,
      },
      tilt: {
        initialAngle: 0.04,
        minAngle: -0.5,
        maxAngle: 1.4,
        maxRate: 2,
        maxAcceleration: 10,
        naturalFrequency: 8,
        dampingRatio: 0.9,
        deadband: 0.00002,
        backlash: 0,
        encoderResolution: 0.00002,
      },
      commandLatency: 0,
    },
    disturbances: {
      preset: 'CLEAN',
      platform: {
        enabled: false,
        biasAzimuth: 0,
        biasElevation: 0,
        tones: [],
        jitter: { enabled: false, rms: 0, correlationTime: 1 },
      },
      atmosphere: {
        attenuation: { enabled: false, dbPerKm: 0 },
        scintillation: { enabled: false, logAmplitudeSigma: 0, correlationTime: 1 },
        wander: { enabled: false, rms: 0, correlationTime: 1 },
      },
      optics: {
        exposure: { enabled: false, subSamples: 1 },
        defocus: { enabled: false, extraSigma: 0 },
        background: { enabled: false, level: 0, gradient: 0, gradientAngle: 0 },
      },
      sensor: {
        readNoise: { enabled: false, sigma: 0 },
        shotNoise: { enabled: false, scale: 0 },
      },
      dropouts: { mode: 'none', probability: 0, meanGoodFrames: 1, meanBadFrames: 1 },
    },
  };
}
