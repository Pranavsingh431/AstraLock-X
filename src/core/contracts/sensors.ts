/**
 * Sensor contracts: everything a tracker is permitted to observe.
 *
 * The three types here define the tracker's entire window onto the world. If a
 * quantity is not reachable from `CameraSensorFrame`, `CameraState` or
 * `GimbalState`, a tracking algorithm cannot use it.
 *
 * Each therefore models what a real device reports, not what the simulator
 * knows: the gimbal returns quantised encoder counts rather than true angles,
 * and the camera returns pixels rather than target positions.
 */

import type { ImageRect, Quaternion, Vec3 } from './geometry';
import type {
  Hertz,
  Meters,
  Normalized,
  Pixels,
  Radians,
  RadiansPerSecond,
  Seconds,
} from './units';

/** Pixel layout of a captured frame. */
export type PixelFormat = 'mono8' | 'mono16';

/** Backing store for a frame, matched to its {@link PixelFormat}. */
export type PixelBuffer = Uint8Array | Uint16Array;

/**
 * One captured camera frame.
 *
 * The payload is raw intensity, exactly as a machine-vision camera would
 * deliver it. There is intentionally no target position, no bounding box and
 * no target count: extracting those is the tracker's job.
 */
export interface CameraSensorFrame {
  /** Monotonic frame counter from the start of the run. */
  readonly frameId: number;
  /**
   * Time at the middle of the exposure, in simulated seconds.
   *
   * Mid-exposure rather than start-of-exposure because that is the instant a
   * centroid actually corresponds to when the scene is moving.
   */
  readonly captureTime: Seconds;
  readonly width: Pixels;
  readonly height: Pixels;
  readonly format: PixelFormat;
  /** Row-major intensity samples, `width * height` entries. */
  readonly data: PixelBuffer;
  /** Exposure time used for this frame. */
  readonly exposure: Seconds;
  /** Analogue gain applied, as a linear multiplier. */
  readonly gain: number;
  /**
   * Sequence number of the last frame the sensor dropped before this one, or
   * `null` if none were dropped. A tracker has to cope with gaps rather than
   * assume a uniform cadence.
   */
  readonly droppedSince: number | null;
  /**
   * Where the mount reports it was pointing when this frame was taken.
   *
   * Legitimately observable: a real system reads its own encoders. It is the
   * mount's *report*, not the truth — in Phase 2 the mount is ideal so the two
   * coincide, and from the phase that adds encoder quantisation, bias and
   * latency they will not.
   */
  readonly pose: CameraPose;
  /**
   * Identifies the optical configuration this frame was taken with, so a
   * consumer can tell that the camera changed under it without being handed the
   * scenario.
   */
  readonly cameraConfigId: string;
}

/** Pointing angles reported by the mount. */
export interface CameraPose {
  /** Clockwise from North, wrapped to (-pi, pi]. */
  readonly azimuth: Radians;
  /** Positive upward. */
  readonly elevation: Radians;
}

/**
 * Pinhole intrinsics with radial distortion.
 *
 * These are the *believed* intrinsics — whatever calibration has converged on.
 * Residual error between these and the simulator's true optics is part of what
 * the tracker must tolerate.
 */
export interface CameraIntrinsics {
  /** Focal length in pixels, per axis. */
  readonly focalLengthX: Pixels;
  readonly focalLengthY: Pixels;
  /** Principal point in pixels from the top-left corner. */
  readonly principalPointX: Pixels;
  readonly principalPointY: Pixels;
  /** Brown-Conrady radial coefficients k1, k2, k3. */
  readonly radialDistortion: readonly [number, number, number];
  /** Brown-Conrady tangential coefficients p1, p2. */
  readonly tangentialDistortion: readonly [number, number];
}

/**
 * Camera configuration and mounting, as the tracker understands it.
 *
 * `mountingRotation` is the calibration estimate of the camera-to-gimbal
 * alignment, not the simulator's true alignment.
 */
export interface CameraState {
  readonly intrinsics: CameraIntrinsics;
  readonly width: Pixels;
  readonly height: Pixels;
  /** Horizontal and vertical field of view implied by the intrinsics. */
  readonly horizontalFov: Radians;
  readonly verticalFov: Radians;
  /** Nominal capture rate. Actual frames may be dropped; see `droppedSince`. */
  readonly frameRate: Hertz;
  readonly exposure: Seconds;
  readonly gain: number;
  /** Believed rotation from the camera frame to the gimbal frame. */
  readonly mountingRotation: Quaternion;
  /** Believed lever arm from the gimbal rotation centre to the camera. */
  readonly mountingOffset: Vec3<Meters>;
  /** Region the sensor is currently reading out, if windowed. */
  readonly regionOfInterest: ImageRect | null;
}

/** Whether an axis is tracking its command or has run out of authority. */
export type AxisSaturation = 'none' | 'rate-limit' | 'travel-limit';

/** Travel and rate envelope of one gimbal axis. */
export interface GimbalAxisLimits {
  readonly minAngle: Radians;
  readonly maxAngle: Radians;
  readonly maxRate: RadiansPerSecond;
  readonly maxAcceleration: number;
}

/**
 * Measured gimbal state, as reported by the encoders.
 *
 * Distinct from the simulator's true gimbal state: these values carry encoder
 * quantisation, bias and reporting latency. Treating them as truth is a
 * classic source of pointing error, so the distinction is in the type names.
 */
export interface GimbalState {
  /** Time the encoders were sampled. May lag the current frame. */
  readonly sampleTime: Seconds;
  /** Measured azimuth, wrapped to (-pi, pi]. */
  readonly azimuth: Radians;
  /** Measured elevation. */
  readonly elevation: Radians;
  /** Measured angular rates, differentiated or tachometer-derived. */
  readonly azimuthRate: RadiansPerSecond;
  readonly elevationRate: RadiansPerSecond;
  readonly azimuthLimits: GimbalAxisLimits;
  readonly elevationLimits: GimbalAxisLimits;
  readonly azimuthSaturation: AxisSaturation;
  readonly elevationSaturation: AxisSaturation;
  /**
   * Age of this sample relative to the frame it accompanies. Non-zero latency
   * has to be compensated, so it is reported rather than hidden.
   */
  readonly latency: Seconds;
  /** Encoder health on [0, 1]; degraded encoders report below 1. */
  readonly encoderHealth: Normalized;
}
