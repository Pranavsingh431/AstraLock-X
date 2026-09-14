import { useEffect } from 'react';

import { useNavigationStore } from '@/stores/navigation-store';

import { VIEW_IDS } from './views';

/**
 * Binds the platform modifier plus 1-6 to the six views.
 *
 * Desktop operators switch panels constantly, and reaching for the mouse each
 * time is the kind of friction that makes a tool feel like a web page.
 */
export function useViewShortcuts(): void {
  const setActiveView = useNavigationStore((state) => state.setActiveView);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      // Accept either modifier so the same binding works on macOS and elsewhere,
      // but reject combinations that belong to other shortcuts.
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;

      const index = Number.parseInt(event.key, 10) - 1;
      if (!Number.isInteger(index)) return;

      const target = VIEW_IDS[index];
      if (target === undefined) return;

      event.preventDefault();
      setActiveView(target);
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [setActiveView]);
}
