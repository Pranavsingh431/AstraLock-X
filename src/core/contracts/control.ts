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

/**
 * What an algorithm asks for, before anyone decides when it happens.
 *
 * An intent carries **no timestamp**. The algorithm says where it wants the
 * mount pointed; the runtime decides when that request entered the physical
 * system and stamps it. The separation is not cosmetic: a frame captured at
 * 16.667 ms may not reach the algorithm until the engine has run to 20 ms, and
 * an algorithm that could write `issuedAt` itself could back-date its command
 * to the capture time and act 3.3 ms in the past. Real software cannot do that,
 * so the type does not let this one either.
 *
 * The runtime converts an intent into a stamped {@link ControlCommand} and,
 * from there, into a physical gimbal command with an id, a due time and
 * clamping. See docs/adr/0013-command-intent-and-issue-time.md.
 */
export interface PointingIntent {
  readonly kind: 'position';
  /** Desired absolute pan angle. Clamped to travel by the runtime. */
  readonly azimuth: Radians;
  /** Desired absolute tilt angle. */
  readonly elevation: Radians;
}

/** Leave the mount where it is. */
export interface HoldIntent {
  readonly kind: 'hold';
}

/** Anything an algorithm may request. */
export type CommandIntent = PointingIntent | HoldIntent;
