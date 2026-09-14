/**
 * Palette shared by the observer scene and its legend.
 *
 * Kept out of the component module so a Fast Refresh edit to the scene does not
 * have to reload the legend, and so the two can never drift apart.
 */
export const OBSERVER_COLORS = {
  target: '#4fc3f7',
  beacon: '#ffd54f',
  observer: '#e8f4fa',
  boresight: '#ff7043',
  path: '#3f7f9f',
} as const;
