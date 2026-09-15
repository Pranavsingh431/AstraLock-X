/**
 * Chart colours and axis styling, shared by every plot in the application.
 *
 * Kept out of the component file so that the Mission Control telemetry, the
 * AstraBench distributions and anything added later cannot drift into three
 * different greens for the same meaning.
 */

/**
 * Series colours, in the order a chart should take them.
 *
 * Distinguishable at 1px, and ordered so the first two — the pair a two-series
 * engineering plot almost always needs, commanded against measured — are the
 * most separable.
 */
export const SERIES_COLORS = [
  'oklch(0.78 0.14 210)',
  'oklch(0.82 0.15 78)',
  'oklch(0.76 0.15 163)',
  'oklch(0.74 0.15 305)',
  'oklch(0.68 0.19 25)',
  'oklch(0.7 0.02 245)',
] as const;

/** The colour privileged simulator data is always drawn in. */
export const TRUTH_COLOR = 'oklch(0.74 0.15 305)';

export const CHART_AXIS_COLOR = 'oklch(0.62 0.02 245)';
export const CHART_GRID_COLOR = 'oklch(0.3 0.02 248)';
