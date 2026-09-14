/**
 * Facts about the running application.
 *
 * Everything here is read from the real runtime. Nothing is invented: if a
 * value cannot be determined, it says so rather than guessing.
 */

/** Where the frontend is currently running. */
export type RuntimeHost = 'tauri' | 'browser';

/**
 * Detects whether the frontend is inside the Tauri webview.
 *
 * Tauri 2 installs `__TAURI_INTERNALS__` on the window before any application
 * code runs, so its presence is a reliable discriminator. During Vitest runs
 * and `pnpm dev` in a plain browser it is absent, and the answer is `browser`.
 */
export function detectRuntimeHost(): RuntimeHost {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window ? 'tauri' : 'browser';
}

/** Immutable description of this build. */
export interface AppInfo {
  readonly name: string;
  /** Version from package.json, injected at build time. */
  readonly version: string;
  /** Vite mode: `development` under `pnpm dev`, `production` in a real build. */
  readonly mode: string;
  readonly host: RuntimeHost;
}

/** Reads the current build and runtime facts. */
export function readAppInfo(): AppInfo {
  return {
    name: 'AstraLock-X',
    version: __APP_VERSION__,
    mode: import.meta.env.MODE,
    host: detectRuntimeHost(),
  };
}

/**
 * Whether the host looks like macOS, for rendering the right modifier glyph.
 *
 * `navigator.platform` is deprecated and `userAgentData` is not available in
 * every webview Tauri uses, so this falls back through both and finally to a
 * user-agent match. A wrong answer only mislabels a keyboard hint.
 */
export function isApplePlatform(): boolean {
  if (typeof navigator === 'undefined') return false;

  const withData = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = withData.userAgentData?.platform;
  if (typeof platform === 'string' && platform !== '') {
    return platform.toLowerCase().includes('mac');
  }

  return /mac|iphone|ipad/i.test(navigator.userAgent);
}

/** The modifier key label to show in shortcut hints on this host. */
export function modifierKeyLabel(): string {
  return isApplePlatform() ? '⌘' : 'Ctrl+';
}
