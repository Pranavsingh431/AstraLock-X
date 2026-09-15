/**
 * Palette shared by the observer scene and its legend.
 *
 * Kept out of the component module so a Fast Refresh edit to the scene does not
 * have to reload the legend, and so the two can never drift apart.
 */
export const OBSERVER_COLORS = {
  // Chosen against the light viewport ground: each has to stay legible on a
  // pale surface, and stay distinguishable from the others in a screenshot.
  target: '#0277bd',
  beacon: '#c77800',
  observer: '#37474f',
  boresight: '#d84315',
  path: '#4a7c95',
} as const;
