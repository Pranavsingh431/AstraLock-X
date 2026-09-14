import { describe, expect, it } from 'vitest';

import { DEFAULT_VIEW, VIEWS, VIEW_IDS, getView, isViewId } from './views';

describe('view registry', () => {
  it('defines exactly one entry per id, in navigation order', () => {
    expect(VIEWS.map((view) => view.id)).toEqual([...VIEW_IDS]);
  });

  it('has a unique id per view', () => {
    expect(new Set(VIEW_IDS).size).toBe(VIEW_IDS.length);
  });

  it('includes the default view', () => {
    expect(VIEW_IDS).toContain(DEFAULT_VIEW);
  });

  it('describes every view well enough to render a placeholder', () => {
    for (const view of VIEWS) {
      expect(view.label.length).toBeGreaterThan(0);
      expect(view.summary.length).toBeGreaterThan(0);
      expect(view.plannedPhase).toMatch(/^Phase \d+$/);
      expect(view.plannedCapabilities.length).toBeGreaterThan(0);
    }
  });

  it('looks up a view by id', () => {
    expect(getView('replay').label).toBe('Replay');
  });

  it('throws on an unknown id, which would be a programming error', () => {
    // @ts-expect-error - deliberately passing an id outside the union.
    expect(() => getView('does-not-exist')).toThrow(/Unknown view id/);
  });

  it('narrows arbitrary strings', () => {
    expect(isViewId('calibration')).toBe(true);
    expect(isViewId('calibrations')).toBe(false);
    expect(isViewId('')).toBe(false);
  });
});
