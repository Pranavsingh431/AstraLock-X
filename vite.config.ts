import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { execSync } from 'node:child_process';

import { defineConfig } from 'vitest/config';

const env = process.env;

// Single source of truth for the version shown in the UI: the manifest.
const packageManifest = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { version: string };

/**
 * Tauri sets TAURI_DEV_HOST when the dev server has to be reachable from a
 * physical device rather than from localhost. It is unset for desktop runs.
 */
const devHost = env['TAURI_DEV_HOST'];
const isTauriDebug = Boolean(env['TAURI_ENV_DEBUG']);
const tauriPlatform = env['TAURI_ENV_PLATFORM'];

/** Runs a git command, or returns `null` if git cannot answer. */
function git(command: string): string | null {
  try {
    return execSync(`git ${command}`, { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

/** The commit HEAD points at, or `null` if it cannot be determined. */
const sourceCommit = git('rev-parse HEAD');

/**
 * Whether the working tree differs from that commit, or `null` if unknown.
 *
 * A build from a modified tree is not the commit it names, and a result that
 * cited the commit alone would be attributed to code that never contained it.
 */
const sourceTreeModified =
  sourceCommit === null ? null : (git('status --porcelain --untracked-files=no') ?? '') !== '';

export default defineConfig({
  plugins: [react(), tailwindcss()],

  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },

  // Tauri pipes the Vite output through its own console; clearing the screen
  // would hide Rust compiler diagnostics.
  clearScreen: false,

  server: {
    port: 1420,
    strictPort: true,
    host: devHost ?? false,
    // Spread rather than assign undefined: exactOptionalPropertyTypes treats an
    // explicit undefined as a distinct value from an absent key.
    ...(devHost === undefined ? {} : { hmr: { protocol: 'ws', host: devHost, port: 1421 } }),
    watch: {
      // The Rust side has its own watcher; double-watching causes rebuild loops.
      ignored: ['**/src-tauri/**'],
    },
  },

  envPrefix: ['VITE_', 'TAURI_ENV_'],

  define: {
    __APP_VERSION__: JSON.stringify(packageManifest.version),
    /**
     * Commit this build came from, or `null`.
     *
     * Experiment manifests record it so a result can be traced to the exact
     * code that produced it. `null` when git is unavailable — a tarball, a
     * detached checkout, a build machine without git — because "main" or
     * "latest" would be a provenance claim nobody verified.
     */
    __SOURCE_COMMIT__: JSON.stringify(sourceCommit),
    __SOURCE_TREE_MODIFIED__: JSON.stringify(sourceTreeModified),
  },

  build: {
    // Match the oldest webview Tauri targets on each platform.
    target: tauriPlatform === 'windows' ? 'chrome105' : 'safari13',
    // Vite 8 transpiles and minifies with Oxc and no longer ships esbuild;
    // naming 'esbuild' here would require installing it separately.
    minify: isTauriDebug ? false : 'oxc',
    sourcemap: isTauriDebug,
    outDir: 'dist',
    emptyOutDir: true,
  },

  test: {
    environment: 'jsdom',
    globals: false,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    restoreMocks: true,
    typecheck: {
      // Enabled on demand via `--typecheck`; see package.json scripts.
      enabled: false,
      include: ['src/**/*.test-d.ts'],
      tsconfig: './tsconfig.test.json',
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.test.{ts,tsx}',
        'src/**/*.test-d.ts',
        'src/test/**',
        'src/main.tsx',
        'src/vite-env.d.ts',
        'src/**/index.ts',
      ],
    },
  },
});
