import { create } from 'zustand';

import { DEFAULT_VIEW, type ViewId } from '@/app/views';

export interface NavigationState {
  /** View currently displayed in the main panel. */
  readonly activeView: ViewId;
  /** View displayed before the current one, or `null` on a cold start. */
  readonly previousView: ViewId | null;
  /** Switches views. Selecting the already-active view is a no-op. */
  setActiveView: (view: ViewId) => void;
  /** Returns to the previously active view. No-op when there is none. */
  goBack: () => void;
}

export const useNavigationStore = create<NavigationState>()((set) => ({
  activeView: DEFAULT_VIEW,
  previousView: null,

  setActiveView: (view) => {
    set((state) =>
      // Guarding here rather than in the caller keeps `previousView` meaningful:
      // re-selecting the current view must not make "back" a no-op loop.
      state.activeView === view ? state : { activeView: view, previousView: state.activeView },
    );
  },

  goBack: () => {
    set((state) =>
      state.previousView === null
        ? state
        : { activeView: state.previousView, previousView: state.activeView },
    );
  },
}));
