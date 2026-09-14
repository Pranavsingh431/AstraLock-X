import { beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_VIEW } from '@/app/views';

import { useNavigationStore } from './navigation-store';

beforeEach(() => {
  useNavigationStore.setState({ activeView: DEFAULT_VIEW, previousView: null });
});

describe('navigation store', () => {
  it('starts on the default view with no history', () => {
    const state = useNavigationStore.getState();
    expect(state.activeView).toBe(DEFAULT_VIEW);
    expect(state.previousView).toBeNull();
  });

  it('records the outgoing view when switching', () => {
    useNavigationStore.getState().setActiveView('replay');

    const state = useNavigationStore.getState();
    expect(state.activeView).toBe('replay');
    expect(state.previousView).toBe(DEFAULT_VIEW);
  });

  it('ignores a switch to the already-active view', () => {
    useNavigationStore.getState().setActiveView('replay');
    const afterFirst = useNavigationStore.getState();

    useNavigationStore.getState().setActiveView('replay');
    const afterSecond = useNavigationStore.getState();

    // previousView must still point at where we came from, not at 'replay'
    // itself, or "back" would become a no-op loop.
    expect(afterSecond.previousView).toBe(afterFirst.previousView);
    expect(afterSecond.activeView).toBe('replay');
  });

  it('returns to the previous view', () => {
    useNavigationStore.getState().setActiveView('astrabench');
    useNavigationStore.getState().goBack();

    expect(useNavigationStore.getState().activeView).toBe(DEFAULT_VIEW);
  });

  it('toggles between two views on repeated back', () => {
    useNavigationStore.getState().setActiveView('reports');
    useNavigationStore.getState().goBack();
    useNavigationStore.getState().goBack();

    expect(useNavigationStore.getState().activeView).toBe('reports');
  });

  it('does nothing on back with no history', () => {
    useNavigationStore.getState().goBack();
    expect(useNavigationStore.getState().activeView).toBe(DEFAULT_VIEW);
  });
});
