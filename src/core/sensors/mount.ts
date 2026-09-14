/**
 * An **ideal** pan/tilt mount.
 *
 * The name is the documentation. This mount has no dynamics: commanding a pose
 * sets that pose, immediately and exactly. There is no rate limit, no travel
 * limit beyond the physical elevation range, no settling, no backlash and no
 * encoder error.
 *
 * That is deliberate for Phase 2, whose job is to get the optics right. The
 * real actuator model — rate and acceleration limits, servo bandwidth, encoder
 * quantisation and reporting latency — arrives in a later phase and will
 * replace this behind the same interface, so the sensor does not need rewriting
 * when it does.
 *
 * Nothing here should be read as a claim about how a gimbal behaves.
 */

import { type Radians, radians, wrapToPi } from '@/core/contracts/units';

import type { CameraPoseAngles } from './pinhole';

/** Elevation cannot pass the zenith or the nadir. */
const MAX_ELEVATION = Math.PI / 2;

export interface CameraMount {
  readonly azimuth: Radians;
  readonly elevation: Radians;
  /** Commands a new pose. */
  commandTo(azimuth: number, elevation: number): void;
  /** Adjusts the current pose by a relative amount. */
  nudge(deltaAzimuth: number, deltaElevation: number): void;
  /** Returns to the pose the mount was constructed with. */
  reset(): void;
  pose(): CameraPoseAngles;
}

export class IdealCameraMount implements CameraMount {
  private currentAzimuth: Radians;
  private currentElevation: Radians;

  constructor(
    private readonly initialAzimuth: number,
    private readonly initialElevation: number,
  ) {
    this.currentAzimuth = wrapToPi(radians(initialAzimuth));
    this.currentElevation = clampElevation(initialElevation);
  }

  public get azimuth(): Radians {
    return this.currentAzimuth;
  }

  public get elevation(): Radians {
    return this.currentElevation;
  }

  /**
   * Sets the pose.
   *
   * Azimuth wraps: panning past North comes round the other side, as a real
   * mount with slip rings would. Elevation clamps at the zenith and nadir,
   * because tipping past vertical is not a rotation this mount can make and
   * silently wrapping it would flip the image.
   */
  public commandTo(azimuth: number, elevation: number): void {
    if (!Number.isFinite(azimuth) || !Number.isFinite(elevation)) {
      throw new RangeError(
        `Mount pose must be finite, received az=${String(azimuth)} el=${String(elevation)}`,
      );
    }
    this.currentAzimuth = wrapToPi(radians(azimuth));
    this.currentElevation = clampElevation(elevation);
  }

  public nudge(deltaAzimuth: number, deltaElevation: number): void {
    this.commandTo(this.currentAzimuth + deltaAzimuth, this.currentElevation + deltaElevation);
  }

  public reset(): void {
    this.currentAzimuth = wrapToPi(radians(this.initialAzimuth));
    this.currentElevation = clampElevation(this.initialElevation);
  }

  public pose(): CameraPoseAngles {
    return { azimuth: this.currentAzimuth, elevation: this.currentElevation };
  }
}

function clampElevation(value: number): Radians {
  return radians(Math.min(MAX_ELEVATION, Math.max(-MAX_ELEVATION, value)));
}
