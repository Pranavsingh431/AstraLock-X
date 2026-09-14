import '@testing-library/jest-dom/vitest';

import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// React Testing Library does not unmount between tests on its own when globals
// are disabled, and a leaked tree makes the next test's queries ambiguous.
afterEach(() => {
  cleanup();
});

/**
 * Minimal ResizeObserver.
 *
 * jsdom does not implement it, and react-use-measure — which React Three
 * Fiber's `Canvas` depends on — throws without it. The stub never fires, which
 * is fine: nothing under test depends on a resize actually being observed.
 *
 * WebGL itself is not emulated here at all. Tests that would need a real
 * drawing context mock the `Canvas` instead, and the rendered scene is verified
 * by running the application.
 */
if (!('ResizeObserver' in globalThis)) {
  class ResizeObserverStub implements ResizeObserver {
    public observe(): void {
      // No layout in jsdom, so there is nothing to report.
    }
    public unobserve(): void {}
    public disconnect(): void {}
  }
  globalThis.ResizeObserver = ResizeObserverStub;
}
