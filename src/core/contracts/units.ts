/**
 * Branded scalar units.
 *
 * Coarse PAT work mixes degrees, radians and microradians in the same
 * expression constantly, and a silent unit error looks exactly like a tracking
 * bug. Every physical quantity therefore carries a phantom unit tag, so the
 * compiler rejects `Radians` where `Microradians` is expected even though both
 * are numbers at runtime.
 *
 * The tag exists only in the type system: a `Meters` is a plain `number` once
 * compiled, with no wrapper allocation and no arithmetic penalty.
 */

declare const UNIT: unique symbol;

/** A `number` tagged with the unit symbol `U`. */
export type Quantity<U extends string> = number & { readonly [UNIT]: U };

/** Any tagged quantity, for generic helpers. */
export type AnyQuantity = Quantity<string>;

// --- Time -------------------------------------------------------------------

/** Seconds of simulated or wall-clock time. */
export type Seconds = Quantity<'s'>;
/** Milliseconds. */
export type Milliseconds = Quantity<'ms'>;
/** Cycles per second. */
export type Hertz = Quantity<'Hz'>;

// --- Angle ------------------------------------------------------------------

/** Radians. The canonical angular unit everywhere inside the core. */
export type Radians = Quantity<'rad'>;
/** Degrees. Accepted at configuration and display boundaries only. */
export type Degrees = Quantity<'deg'>;
/**
 * Microradians. The natural scale for FSOC pointing error: a link with a 1 mrad
 * beam needs pointing held to tens of microradians.
 */
export type Microradians = Quantity<'urad'>;
/** Angular rate. */
export type RadiansPerSecond = Quantity<'rad/s'>;
/** Angular acceleration. */
export type RadiansPerSecondSquared = Quantity<'rad/s^2'>;

// --- Length and motion ------------------------------------------------------

/** Metres. */
export type Meters = Quantity<'m'>;
/** Metres per second. */
export type MetersPerSecond = Quantity<'m/s'>;
/** Metres per second squared. */
export type MetersPerSecondSquared = Quantity<'m/s^2'>;

// --- Imaging ----------------------------------------------------------------

/** Pixels, in image coordinates. */
export type Pixels = Quantity<'px'>;
/** Pixel motion per second, in image coordinates. */
export type PixelsPerSecond = Quantity<'px/s'>;

// --- Radiometry and signal --------------------------------------------------

/** Watts. */
export type Watts = Quantity<'W'>;
/** Decibels (a ratio, already logarithmic). */
export type Decibels = Quantity<'dB'>;
/** A dimensionless ratio, conventionally on [0, 1]. */
export type Normalized = Quantity<'1'>;

// --- Constructors -----------------------------------------------------------
//
// These are identity functions at runtime. They exist so that attaching a unit
// is an explicit, greppable act rather than a scattered `as` cast.

const tag = <Q extends AnyQuantity>(value: number): Q => value as Q;

export const seconds = (value: number): Seconds => tag(value);
export const milliseconds = (value: number): Milliseconds => tag(value);
export const hertz = (value: number): Hertz => tag(value);
export const radians = (value: number): Radians => tag(value);
export const degrees = (value: number): Degrees => tag(value);
export const microradians = (value: number): Microradians => tag(value);
export const radiansPerSecond = (value: number): RadiansPerSecond => tag(value);
export const radiansPerSecondSquared = (value: number): RadiansPerSecondSquared => tag(value);
export const meters = (value: number): Meters => tag(value);
export const metersPerSecond = (value: number): MetersPerSecond => tag(value);
export const metersPerSecondSquared = (value: number): MetersPerSecondSquared => tag(value);
export const pixels = (value: number): Pixels => tag(value);
export const pixelsPerSecond = (value: number): PixelsPerSecond => tag(value);
export const watts = (value: number): Watts => tag(value);
export const decibels = (value: number): Decibels => tag(value);
export const normalized = (value: number): Normalized => tag(value);

// --- Conversions ------------------------------------------------------------

/** Radians in one degree. */
export const RADIANS_PER_DEGREE = Math.PI / 180;
/** Microradians in one radian. */
export const MICRORADIANS_PER_RADIAN = 1e6;

export const degreesToRadians = (value: Degrees): Radians => tag(value * RADIANS_PER_DEGREE);
export const radiansToDegrees = (value: Radians): Degrees => tag(value / RADIANS_PER_DEGREE);

export const radiansToMicroradians = (value: Radians): Microradians =>
  tag(value * MICRORADIANS_PER_RADIAN);
export const microradiansToRadians = (value: Microradians): Radians =>
  tag(value / MICRORADIANS_PER_RADIAN);

export const secondsToMilliseconds = (value: Seconds): Milliseconds => tag(value * 1000);
export const millisecondsToSeconds = (value: Milliseconds): Seconds => tag(value / 1000);

/**
 * Sampling period of a rate.
 *
 * @throws {RangeError} when `rate` is not strictly positive, since a
 * non-positive rate has no period and silently returning `Infinity` would
 * propagate into timing code.
 */
export const hertzToPeriod = (rate: Hertz): Seconds => {
  if (!(rate > 0)) {
    throw new RangeError(`Sampling rate must be strictly positive, received ${String(rate)} Hz`);
  }
  return tag(1 / rate);
};

/** Inverse of {@link hertzToPeriod}. */
export const periodToHertz = (period: Seconds): Hertz => {
  if (!(period > 0)) {
    throw new RangeError(`Sampling period must be strictly positive, received ${String(period)} s`);
  }
  return tag(1 / period);
};

/**
 * Wraps an angle to the half-open interval (-pi, pi].
 *
 * Bearing residuals are differences of angles, so they have to be wrapped
 * before they are squared or fed to a filter; without this a target crossing
 * the +/-pi boundary produces a spurious 2*pi error spike.
 */
export const wrapToPi = (angle: Radians): Radians => {
  const twoPi = 2 * Math.PI;
  const wrapped = angle - twoPi * Math.floor((angle + Math.PI) / twoPi);
  // floor() maps exactly -pi to -pi; the interval is closed at +pi by convention.
  return tag(wrapped === -Math.PI ? Math.PI : wrapped);
};

/** Smallest signed rotation from `from` to `to`, wrapped to (-pi, pi]. */
export const angularDifference = (from: Radians, to: Radians): Radians =>
  wrapToPi(tag<Radians>(to - from));
