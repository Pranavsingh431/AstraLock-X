/**
 * Palette shared by the observer scene and its legend.
 *
 * Kept out of the component module so a Fast Refresh edit to the scene does not
 * reload the legend, and so the two can never drift apart.
 *
 * Chosen against the dark viewport ground: each has to stay legible on a deep
 * navy surface, stay distinguishable from the others in a screenshot, and read
 * as instrumentation rather than as decoration. The designated beacon is the
 * only thing here allowed to glow, because it is the only thing in the scene
 * that is actually emitting light.
 */
export const OBSERVER_COLORS = {
  /** The designated optical terminal: the one the evaluator scores against. */
  target: '#38bdf8',
  /** Its beacon, drawn as an emitter. */
  beacon: '#e2f4ff',
  /** Any other optical source in the scene. Never the same colour as the target. */
  decoy: '#fb923c',
  observer: '#94a3b8',
  boresight: '#22d3ee',
  /** The camera's field of view, as a frustum. */
  frustum: '#22d3ee',
  path: '#64748b',
  grid: '#1e3040',
  gridSection: '#2f4a5e',
} as const;
