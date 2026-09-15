import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent } from '@testing-library/react';
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

/**
 * Quiet jsdom's 2D canvas.
 *
 * jsdom does not implement `getContext` and logs a "not implemented" error for
 * every call, which buries real output. The sensor monitor already handles a
 * null context by drawing nothing, so returning null here exercises that path
 * rather than papering over it. Actual pixel output is verified by the sensor's
 * own tests, which read the buffer directly, and by running the application.
 */
if (typeof HTMLCanvasElement !== 'undefined') {
  HTMLCanvasElement.prototype.getContext = (): null => null;
}

/**
 * Selecting a tab, in a workstation built out of resizable panels.
 *
 * `react-resizable-panels` installs a capture-phase `pointerdown` listener that
 * calls `preventDefault()` when the pointer lands inside a separator's hit band,
 * so that starting a drag does not also select text. It decides that from
 * `getBoundingClientRect`, and in jsdom every rect is 0×0 at the origin — so
 * every separator's band contains every click, and `preventDefault` fires on
 * everything. `userEvent` then correctly suppresses the `mousedown` that would
 * have followed.
 *
 * Buttons survive this, because a `click` still arrives. Radix tabs do not:
 * they select on `mousedown`. Dispatching that event directly is the narrowest
 * way around a measurement artefact that does not exist in a real browser,
 * where a tab twelve pixels from a divider is nowhere near its hit band.
 */
export function selectTab(tab: HTMLElement): void {
  fireEvent.mouseDown(tab, { button: 0 });
}
