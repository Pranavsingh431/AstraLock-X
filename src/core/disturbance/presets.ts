/**
 * Engineering disturbance profiles.
 *
 * These are **reproducible parameter sets**, nothing more. None of them is
 * calibrated against a measured environment, a flight campaign or a published
 * link budget, so none of them is named after one: there is no "flight
 * realistic" or "ISRO environment" here, because this project has no source that
 * would justify the claim. They are named for what they contain.
 *
 * A preset is a convenience for populating a scenario, never a record of one.
 * Every parameter is copied into the scenario document and fingerprinted with
 * it, so a run stays fully described even if a preset is later retuned or
 * deleted. `disturbances.preset` carries the name for provenance only, and
 * nothing reads it back to reconstruct values.
 *
 * See docs/DISTURBANCE_MODEL.md for what each parameter means.
 */

import { CLEAN_DISTURBANCES, type DisturbanceConfig } from '@/core/contracts/disturbance';
import type { Hertz, Normalized, Pixels, Radians, Seconds } from '@/core/contracts/units';

const rad = (value: number): Radians => value as Radians;
const hz = (value: number): Hertz => value as Hertz;
const sec = (value: number): Seconds => value as Seconds;
const px = (value: number): Pixels => value as Pixels;
const unit = (value: number): Normalized => value as Normalized;

/** Degrees to radians, for writing vibration amplitudes legibly. */
const DEG = Math.PI / 180;

/**
 * A profile built from the clean default.
 *
 * Deep-cloning the frozen default rather than spreading it: the nested branches
 * would otherwise be shared between every preset, and one preset mutating a
 * branch would change the others.
 */
function from(patch: (base: DisturbanceConfig) => DisturbanceConfig): DisturbanceConfig {
  return Object.freeze(patch(structuredClone(CLEAN_DISTURBANCES)));
}

/**
 * Nothing enabled. The Phase-6 sensor exactly.
 *
 * Not merely "all parameters zero": with this profile the image formation path
 * takes the pre-Phase-7 branch, so clean runs are bit-identical to Phase 6
 * rather than numerically close to it.
 */
const CLEAN = CLEAN_DISTURBANCES;

/**
 * A vehicle-mounted terminal on a reasonable day.
 *
 * Small multi-tone base motion an order of magnitude inside the mount's ability
 * to counteract, light haze, weak scintillation, finite exposure and a little
 * sensor noise. The intent is "not a laboratory", not "difficult".
 */
const MILD_MOBILE = from((base) => ({
  ...base,
  preset: 'MILD_MOBILE',
  platform: {
    ...base.platform,
    enabled: true,
    tones: [
      { axis: 'azimuth', amplitude: rad(0.02 * DEG), frequency: hz(7), phase: rad(0) },
      { axis: 'elevation', amplitude: rad(0.015 * DEG), frequency: hz(11), phase: rad(1.1) },
    ],
    jitter: { enabled: true, rms: rad(0.01 * DEG), correlationTime: sec(0.4) },
  },
  atmosphere: {
    attenuation: { enabled: true, dbPerKm: 0.6 },
    scintillation: { enabled: true, logAmplitudeSigma: 0.12, correlationTime: sec(0.05) },
    wander: { enabled: true, rms: rad(30e-6), correlationTime: sec(0.8) },
  },
  optics: {
    ...base.optics,
    exposure: { enabled: true, subSamples: 4 },
  },
  sensor: {
    readNoise: { enabled: true, sigma: 1.5 },
    shotNoise: { enabled: true, scale: 0.35 },
  },
}));

/**
 * Base motion an order of magnitude larger, still within the mount.
 *
 * For separating "the tracker cannot cope" from "the mount cannot cope": these
 * amplitudes and rates are inside the pan and tilt axes' velocity and
 * acceleration limits, so a failure here is a control or estimation failure.
 */
const VIBRATION_HEAVY = from((base) => ({
  ...base,
  preset: 'VIBRATION_HEAVY',
  platform: {
    ...base.platform,
    enabled: true,
    tones: [
      { axis: 'azimuth', amplitude: rad(0.25 * DEG), frequency: hz(3), phase: rad(0) },
      { axis: 'azimuth', amplitude: rad(0.08 * DEG), frequency: hz(9.5), phase: rad(2.2) },
      { axis: 'elevation', amplitude: rad(0.18 * DEG), frequency: hz(4.5), phase: rad(0.7) },
    ],
    jitter: { enabled: true, rms: rad(0.05 * DEG), correlationTime: sec(0.25) },
  },
}));

/**
 * Base motion the mount physically cannot follow.
 *
 * Deliberately beyond the axes' rate limits, so that both algorithms are
 * expected to fail. A test that uses this is checking that they fail *honestly*
 * — losing lock and saying so — rather than reporting performance the physics
 * cannot support.
 */
const VIBRATION_BEYOND_MOUNT = from((base) => ({
  ...base,
  preset: 'VIBRATION_BEYOND_MOUNT',
  platform: {
    ...base.platform,
    enabled: true,
    tones: [
      { axis: 'azimuth', amplitude: rad(3 * DEG), frequency: hz(11), phase: rad(0) },
      { axis: 'elevation', amplitude: rad(2.2 * DEG), frequency: hz(13), phase: rad(0.5) },
    ],
    jitter: { enabled: false, rms: rad(0), correlationTime: sec(1) },
  },
}));

/**
 * A dim beacon against a bright sky.
 *
 * Heavy attenuation plus ambient background and sensor noise: the target is
 * still there and still mathematically detectable, but its contrast against the
 * background is a fraction of what the clean scenarios give.
 */
const LOW_CONTRAST = from((base) => ({
  ...base,
  preset: 'LOW_CONTRAST',
  atmosphere: {
    attenuation: { enabled: true, dbPerKm: 9 },
    scintillation: { enabled: true, logAmplitudeSigma: 0.25, correlationTime: sec(0.04) },
    wander: { enabled: true, rms: rad(40e-6), correlationTime: sec(0.6) },
  },
  optics: {
    ...base.optics,
    defocus: { enabled: true, extraSigma: px(0.8) },
    background: {
      enabled: true,
      level: unit(0.12),
      gradient: unit(0.06),
      gradientAngle: rad(0.6),
    },
  },
  sensor: {
    readNoise: { enabled: true, sigma: 3.5 },
    shotNoise: { enabled: true, scale: 0.7 },
  },
}));

/**
 * Bursty delivery loss.
 *
 * Roughly one frame in eleven is lost, but in runs rather than singly: about
 * 1.2 s of delivery followed by about 100 ms of silence. Isolated losses are
 * easy — the estimator coasts one frame — and runs are what actually test a
 * recovery strategy.
 */
const FRAME_LOSS = from((base) => ({
  ...base,
  preset: 'FRAME_LOSS',
  dropouts: { mode: 'burst', probability: unit(0), meanGoodFrames: 72, meanBadFrames: 7 },
}));

/**
 * Several moderate effects at once.
 *
 * Not a torture case: each component is individually survivable, and the point
 * is to see what they do together rather than to manufacture a failure. A
 * scenario that no tracker can pass tells you nothing about either tracker.
 */
const COMBINED_STRESS = from((base) => ({
  ...base,
  preset: 'COMBINED_STRESS',
  platform: {
    ...base.platform,
    enabled: true,
    tones: [
      { axis: 'azimuth', amplitude: rad(0.09 * DEG), frequency: hz(5), phase: rad(0) },
      { axis: 'elevation', amplitude: rad(0.07 * DEG), frequency: hz(8), phase: rad(1.9) },
    ],
    jitter: { enabled: true, rms: rad(0.03 * DEG), correlationTime: sec(0.3) },
  },
  atmosphere: {
    attenuation: { enabled: true, dbPerKm: 4 },
    scintillation: { enabled: true, logAmplitudeSigma: 0.2, correlationTime: sec(0.05) },
    wander: { enabled: true, rms: rad(35e-6), correlationTime: sec(0.7) },
  },
  optics: {
    exposure: { enabled: true, subSamples: 6 },
    defocus: { enabled: true, extraSigma: px(0.5) },
    background: {
      enabled: true,
      level: unit(0.07),
      gradient: unit(0.03),
      gradientAngle: rad(2.4),
    },
  },
  sensor: {
    readNoise: { enabled: true, sigma: 2.5 },
    shotNoise: { enabled: true, scale: 0.5 },
  },
  dropouts: { mode: 'burst', probability: unit(0), meanGoodFrames: 150, meanBadFrames: 5 },
}));

/** Sensor noise alone, for isolating what noise costs. */
const SENSOR_NOISE = from((base) => ({
  ...base,
  preset: 'SENSOR_NOISE',
  sensor: {
    readNoise: { enabled: true, sigma: 3 },
    shotNoise: { enabled: true, scale: 0.6 },
  },
}));

export const DISTURBANCE_PRESETS = {
  CLEAN,
  MILD_MOBILE,
  VIBRATION_HEAVY,
  VIBRATION_BEYOND_MOUNT,
  LOW_CONTRAST,
  FRAME_LOSS,
  SENSOR_NOISE,
  COMBINED_STRESS,
} as const satisfies Record<string, DisturbanceConfig>;

export type DisturbancePresetName = keyof typeof DISTURBANCE_PRESETS;

export const PRESET_NAMES = Object.keys(DISTURBANCE_PRESETS) as readonly DisturbancePresetName[];

/** Looks a preset up by name, or `undefined` when there is no such profile. */
export function presetByName(name: string): DisturbanceConfig | undefined {
  return Object.hasOwn(DISTURBANCE_PRESETS, name)
    ? DISTURBANCE_PRESETS[name as DisturbancePresetName]
    : undefined;
}
