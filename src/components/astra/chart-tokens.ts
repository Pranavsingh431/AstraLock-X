/**
 * Chart colours and axis styling, shared by every plot in the application.
 *
 * Kept out of the component file so that the Mission Control telemetry, the
 * AstraBench distributions and anything added later cannot drift into three
 * different greens for the same meaning.
 *
 * Every value is chosen for a **white** plot area and for a projector. A line
 * that reads well on a dark console is often washed out at 1px on a slide, so
 * these run darker and more saturated than screen-only values would.
 */

/**
 * Series colours, in the order a chart should take them.
 *
 * Distinguishable at 1px, and ordered so the first two — the pair a two-series
 * engineering plot almost always needs, commanded against measured — are the
 * most separable.
 */
export const SERIES_COLORS = [
  'oklch(0.5 0.19 259)',
  'oklch(0.58 0.16 55)',
  'oklch(0.53 0.13 163)',
  'oklch(0.49 0.2 295)',
  'oklch(0.55 0.21 27)',
  'oklch(0.55 0.03 256)',
] as const;

/** The colour privileged simulator data is always drawn in. */
export const TRUTH_COLOR = 'oklch(0.49 0.2 295)';

/** Axis labels and ticks: dark enough to read, light enough not to compete. */
export const CHART_AXIS_COLOR = 'oklch(0.5 0.03 256)';

/** The grid: present, never a feature of the plot. */
export const CHART_GRID_COLOR = 'oklch(0.915 0.012 256)';
