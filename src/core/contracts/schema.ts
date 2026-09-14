/**
 * Shared Zod building blocks for the configuration schemas.
 *
 * Kept in one place so that "a quantity" and "a 3-vector" mean the same thing
 * in every schema, including the same rejection of NaN and Infinity. Zod 4's
 * `z.number()` already refuses both.
 */

import { z } from 'zod';

import type { Vec3 } from './geometry';
import type { AnyQuantity } from './units';

/** A plain number carrying a unit brand on the way out. */
export const tagged = <Q extends AnyQuantity>(base: z.ZodNumber) =>
  base.transform((value) => value as Q);

export const positiveNumber = z.number().positive();
export const nonNegativeNumber = z.number().nonnegative();
export const unitIntervalNumber = z.number().min(0).max(1);

/** A three-component vector whose components all carry unit `Q`. */
export const vec3Schema = <Q extends AnyQuantity>(): z.ZodType<Vec3<Q>> =>
  z.strictObject({
    x: tagged<Q>(z.number()),
    y: tagged<Q>(z.number()),
    z: tagged<Q>(z.number()),
  });

/** A direction vector. Unitless; normalised by the consumer, not here. */
export const directionSchema = z.strictObject({
  x: z.number(),
  y: z.number(),
  z: z.number(),
});

/** True when a direction has a length worth normalising. */
export const isNonZeroDirection = (v: { x: number; y: number; z: number }): boolean =>
  Math.hypot(v.x, v.y, v.z) > 0;
