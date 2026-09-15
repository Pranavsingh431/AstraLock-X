/**
 * Physical disturbances: platform motion, propagation, optics, sensor and
 * frame transport.
 *
 * **Privileged.** Everything here knows the disturbance realization, which is
 * the answer key to the pixels. No algorithm may import it; the lint barrier
 * enforces that.
 *
 * See docs/DISTURBANCE_MODEL.md.
 */

export { DisturbanceStack } from './stack';
export type { BaseAttitude, FrameDisturbance, WanderOffset } from './stack';
export { BurstChain, OrnsteinUhlenbeck, toneSum } from './processes';
export type { Tone } from './processes';
export {
  CounterStream,
  DISTURBANCE_STREAM_NAMES,
  DisturbanceStreams,
  SequentialNoise,
} from './streams';
export type { DisturbanceStreamName } from './streams';
export { DISTURBANCE_PRESETS, presetByName, PRESET_NAMES } from './presets';
export type { DisturbancePresetName } from './presets';
