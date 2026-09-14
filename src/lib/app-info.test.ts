import { afterEach, describe, expect, it } from 'vitest';

import { detectRuntimeHost, readAppInfo } from './app-info';

const TAURI_KEY = '__TAURI_INTERNALS__';

afterEach(() => {
  delete (window as unknown as Record<string, unknown>)[TAURI_KEY];
});

describe('detectRuntimeHost', () => {
  it('reports a plain browser when the Tauri bridge is absent', () => {
    expect(detectRuntimeHost()).toBe('browser');
  });

  it('reports Tauri once the bridge is present', () => {
    (window as unknown as Record<string, unknown>)[TAURI_KEY] = {};
    expect(detectRuntimeHost()).toBe('tauri');
  });
});

describe('readAppInfo', () => {
  it('reports real build facts rather than placeholders', () => {
    const info = readAppInfo();

    expect(info.name).toBe('AstraLock-X');
    // Injected from package.json at build time, so it must look like a version.
    expect(info.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(info.mode.length).toBeGreaterThan(0);
    expect(['tauri', 'browser']).toContain(info.host);
  });
});
