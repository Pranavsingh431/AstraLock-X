/**
 * Values that may not exist, and why.
 *
 * A number in a report is a claim. `0` is a claim that a quantity was measured
 * and found to be zero; `NaN` is a claim that a calculation went wrong; `-1` is
 * a claim dressed as a sentinel that some consumer will eventually forget to
 * check. None of them means "this system does not model that".
 *
 * Phase 4 reported a detection's signal-to-noise ratio as 0 dB. The sensor has
 * no noise model, so there is no ratio to compute — but 0 dB is a real physical
 * value meaning signal and noise are equal, which would be a terrible
 * detection. A reader had no way to tell the difference between "measured, and
 * bad" and "not modelled". This module exists so that distinction is in the
 * type rather than in a comment.
 *
 * Every quantity that might be absent is a {@link Measurement}: a nullable
 * value plus a {@link MeasurementStatus} saying what kind of absence or
 * presence it is. A report renders `not-modelled` as "Not modelled" and
 * `not-applicable` as "N/A", and never as a number.
 */

import { z } from 'zod';

/**
 * Where a value came from, or why there isn't one.
 *
 * - `measured`        sensed by an instrument the simulation models;
 * - `derived`         computed from measurements or from configuration;
 * - `configured`      taken directly from a configuration document;
 * - `not-modelled`    the simulation does not model the underlying physics, so
 *                     no honest value exists — not now, not with better code;
 * - `not-applicable`  the quantity is meaningless in this context, for example
 *                     a lock-retention rate for a run that never locked;
 * - `not-measured`    modelled and meaningful, but this particular sample has
 *                     no value: the target was not visible, no detection was
 *                     made, the window was empty.
 */
export type MeasurementStatus =
  'measured' | 'derived' | 'configured' | 'not-modelled' | 'not-applicable' | 'not-measured';

/** Statuses that carry a value, and those that cannot. */
const STATUSES_WITH_VALUE: readonly MeasurementStatus[] = ['measured', 'derived', 'configured'];

/**
 * A quantity that may be absent, tagged with the reason.
 *
 * The invariant — a present status has a value and an absent one does not — is
 * checked by the schema and by {@link isPresent}, because the type system
 * cannot express it without making every construction site a discriminated
 * union the callers would have to narrow.
 */
export interface Measurement<T extends number = number> {
  readonly value: T | null;
  readonly status: MeasurementStatus;
  /**
   * Unit symbol, so a serialised measurement is self-describing.
   *
   * A CSV column called `error` is a bug waiting to happen; one called
   * `pointing_error_rad` is not. Carried here for the JSON artifacts, where
   * there are no column headers to lean on.
   */
  readonly unit: string;
}

/** Builds a measured value. */
export const measured = <T extends number>(value: T, unit: string): Measurement<T> => ({
  value,
  status: 'measured',
  unit,
});

/** Builds a value computed from other values. */
export const derived = <T extends number>(value: T, unit: string): Measurement<T> => ({
  value,
  status: 'derived',
  unit,
});

/** Builds a value read straight from configuration. */
export const configured = <T extends number>(value: T, unit: string): Measurement<T> => ({
  value,
  status: 'configured',
  unit,
});

/** The simulation does not model the physics this would come from. */
export const notModelled = <T extends number>(unit: string): Measurement<T> => ({
  value: null,
  status: 'not-modelled',
  unit,
});

/** The quantity is meaningless here. */
export const notApplicable = <T extends number>(unit: string): Measurement<T> => ({
  value: null,
  status: 'not-applicable',
  unit,
});

/** Modelled and meaningful, but this sample has no value. */
export const notMeasured = <T extends number>(unit: string): Measurement<T> => ({
  value: null,
  status: 'not-measured',
  unit,
});

/** Whether a measurement carries a usable number. */
export function isPresent<T extends number>(
  measurement: Measurement<T>,
): measurement is Measurement<T> & { readonly value: T } {
  return measurement.value !== null;
}

/**
 * How a measurement should read to a human.
 *
 * Deliberately not a number for the absent cases. A report that printed "0" or
 * "—" for every kind of absence would be throwing away the one piece of
 * information the reader most needs: whether the gap is a limitation of the
 * simulator, a property of this run, or simply inapplicable.
 */
export function formatMeasurement<T extends number>(
  measurement: Measurement<T>,
  digits = 3,
): string {
  if (measurement.value === null) {
    switch (measurement.status) {
      case 'not-modelled':
        return 'Not modelled';
      case 'not-applicable':
        return 'N/A';
      default:
        return 'Not measured';
    }
  }
  return `${measurement.value.toFixed(digits)} ${measurement.unit}`;
}

/** Schema for a serialised measurement, enforcing the value/status invariant. */
export const measurementSchema = z
  .strictObject({
    value: z.number().finite().nullable(),
    status: z.enum([
      'measured',
      'derived',
      'configured',
      'not-modelled',
      'not-applicable',
      'not-measured',
    ]),
    unit: z.string().min(1),
  })
  .refine((m) => (m.value === null) !== STATUSES_WITH_VALUE.includes(m.status), {
    message:
      'A measurement with a present status must carry a value, and an absent status must not',
    path: ['value'],
  });
