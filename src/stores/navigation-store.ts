import { create } from 'zustand';

import { DEFAULT_VIEW, type ViewId } from '@/app/views';

export interface NavigationState {
  /** View currently displayed in the main panel. */
  readonly activeView: ViewId;
  /** View displayed before the current one, or `null` on a cold start. */
  readonly previousView: ViewId | null;
  /**
   * Whether privileged simulator state may be drawn.
   *
   * On — the default, because this is an engineering workbench — the ground
   * truth overlay, the 3D twin, the actuator interior, the disturbance
   * realization and the true pointing error are all available. Off, the
   * interface shows only what the terminal's own software could compute from
   * pixels, the believed calibration and the measured mount state, so a run can
   * be demonstrated without the answer key anywhere on screen.
   *
   * This gates **drawing only**. It computes nothing, records nothing, and
   * changes no simulation or tracking behaviour, which is the property that
   * makes the comparison between the two modes worth anything: the same run
   * produces the same numbers with the panels visible or hidden.
   */
  readonly engineeringMode: boolean;
  /** Switches views. Selecting the already-active view is a no-op. */
  setActiveView: (view: ViewId) => void;
  /** Returns to the previously active view. No-op when there is none. */
  goBack: () => void;
  /** Shows or hides every privileged panel at once. */
  setEngineeringMode: (enabled: boolean) => void;
}

export const useNavigationStore = create<NavigationState>()((set) => ({
  activeView: DEFAULT_VIEW,
  previousView: null,
  engineeringMode: true,

  setActiveView: (view) => {
    set((state) =>
      // Guarding here rather than in the caller keeps `previousView` meaningful:
      // re-selecting the current view must not make "back" a no-op loop.
      state.activeView === view ? state : { activeView: view, previousView: state.activeView },
    );
  },

  setEngineeringMode: (enabled) => {
    set({ engineeringMode: enabled });
  },

  goBack: () => {
    set((state) =>
      state.previousView === null
        ? state
        : { activeView: state.previousView, previousView: state.activeView },
    );
  },
}));
