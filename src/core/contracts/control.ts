/**
 * Control contracts: what the tracker asks the gimbal to do.
 *
 * Commands are demands, not outcomes. The gimbal has finite rate and travel, so
 * a command may be clipped; the resulting saturation comes back through
 * `GimbalState` rather than being reported here.
 */

import type { Radians, RadiansPerSecond, Seconds } from './units';

/** Slew both axes at a commanded angular rate. The normal tracking mode. */
export interface GimbalRateCommand {
  readonly kind: 'rate';
  /** Time the command was computed, for latency accounting. */
  readonly issuedAt: Seconds;
  readonly azimuthRate: RadiansPerSecond;
  readonly elevationRate: RadiansPerSecond;
  /**
   * Rate added ahead of the feedback term, typically from the estimated target
   * rate. Reported separately so the feedback and feed-forward contributions
   * can be attributed when a loop misbehaves.
   */
  readonly feedForwardAzimuthRate: RadiansPerSecond;
  readonly feedForwardElevationRate: RadiansPerSecond;
}

/** Drive to an absolute pointing angle. Used for slewing and for search patterns. */
export interface GimbalPositionCommand {
  readonly kind: 'position';
  readonly issuedAt: Seconds;
  readonly azimuth: Radians;
  readonly elevation: Radians;
}

/** Hold the current position and reject disturbance. Used when no track is active. */
export interface GimbalHoldCommand {
  readonly kind: 'hold';
  readonly issuedAt: Seconds;
}

/** Anything the control stage may emit. */
export type ControlCommand = GimbalRateCommand | GimbalPositionCommand | GimbalHoldCommand;
