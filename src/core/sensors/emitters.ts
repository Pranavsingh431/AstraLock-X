/**
 * Optical emitters, as the simulator knows them.
 *
 * **Privileged.** An emitter carries its host entity's identity and its true
 * position, so this module sits behind the ground-truth barrier. A tracking
 * algorithm sees the *pixels* an emitter produces and nothing else — working
 * out that a bright blob is a beacon, and which beacon, is the job it exists to
 * do.
 *
 * The sensor takes a list of emitters rather than reaching into
 * `world.targets[0]`. Multiple emitters are the normal case in the scenarios
 * this project is heading towards — two terminals in frame, or a beacon and a
 * decoy — and a renderer that assumed one would have to be rewritten rather
 * than extended.
 */

import type { WorldState } from '@/core/contracts/ground-truth';
import type { CodeWaveform } from '@/core/contracts/code-waveform';
import type { SimulationConfig } from '@/core/contracts/simulation';
import type { Meters, Normalized, Pixels } from '@/core/contracts/units';

import type { Vec3Lite } from './pinhole';

declare const emitterIdBrand: unique symbol;

/**
 * Identity of an optical emitter.
 *
 * Simulator-assigned, like `TargetId`, and equally off-limits to a tracker: an
 * algorithm handed emitter identities would not need to solve association at
 * all.
 */
export type EmitterId = string & { readonly [emitterIdBrand]: 'EmitterId' };

/** Deterministic emitter id for the target at `index`. */
export const emitterIdAt = (index: number): EmitterId => `emitter-${String(index)}` as EmitterId;

/** One ideal point source in the world. */
export interface OpticalEmitter {
  readonly id: EmitterId;
  /** The entity carrying this emitter. */
  readonly hostEntityId: string;
  /** True position in world ENU metres. */
  readonly position: Vec3Lite;
  /**
   * Peak apparent intensity in a clean image, on [0, 1].
   *
   * Constant with range in Phase 2. A real beacon dims as `1/r^2` and is
   * attenuated by the atmosphere; both belong to the link budget, which is not
   * modelled yet. Treating intensity as constant is a stated idealisation, not
   * an oversight.
   */
  readonly intensity: Normalized;
  /** Standard deviation of the point spread, in pixels. */
  readonly psfSigma: Pixels;
  /**
   * The temporal code this source is emitting, or `null` for a steady one.
   *
   * The *waveform*, not an identity. Two emitters carrying the same code are
   * indistinguishable here and are meant to be: a code says what a source is
   * signalling, and working out which physical object that is remains the
   * tracker's problem. Nothing downstream may use the presence or contents of
   * this field as a label.
   */
  readonly code: CodeWaveform | null;
}

/**
 * Emitters present in a world snapshot.
 *
 * Built from the configuration's beacon declarations and the snapshot's true
 * target positions, so a passive target contributes nothing and a scenario with
 * several beacons contributes several emitters.
 */
export function emittersFrom(
  config: SimulationConfig,
  targetPositions: readonly { readonly x: Meters; readonly y: Meters; readonly z: Meters }[],
): readonly OpticalEmitter[] {
  const emitters: OpticalEmitter[] = [];

  config.targets.forEach((target, index) => {
    const beacon = target.beacon;
    const position = targetPositions[index];
    if (beacon === null || position === undefined) return;

    const code = beacon.identityCode;
    emitters.push({
      id: emitterIdAt(index),
      hostEntityId: `target-${String(index)}`,
      position: { x: position.x, y: position.y, z: position.z },
      intensity: beacon.intensity,
      psfSigma: beacon.psfSigma,
      code:
        code === null || !code.enabled
          ? null
          : {
              sequence: code.sequence,
              symbolDuration: code.symbolDuration,
              phaseOffset: code.phaseOffset,
              // Levels are multipliers on the beacon's own intensity, so the
              // waveform carries the product and the renderer stays unaware
              // that any modulation happened.
              onLevel: code.onIntensity,
              offLevel: code.offIntensity,
              repeat: code.repeat,
            },
    });
  });

  return emitters;
}

/** Emitters present in an authoritative world snapshot. */
export function emittersFromWorld(world: WorldState): readonly OpticalEmitter[] {
  return emittersFrom(
    world.config,
    world.truth.targets.map((target) => target.pose.position),
  );
}
