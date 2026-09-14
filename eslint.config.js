import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Directories that make up the tracking side of the application. Code here runs
 * as, or on behalf of, a tracking algorithm and therefore must never be able to
 * reach simulator ground truth. See docs/adr/0003-ground-truth-isolation.md.
 */
const TRACKING_SIDE = [
  'src/core/algorithms/**/*.{ts,tsx}',
  'src/core/perception/**/*.{ts,tsx}',
  'src/core/estimation/**/*.{ts,tsx}',
  'src/core/control/**/*.{ts,tsx}',
  'src/core/pat/**/*.{ts,tsx}',
];

/**
 * Files that are neither tests nor test helpers. Used to keep fixture exports
 * out of code that ships.
 */
const PRODUCTION_SOURCE_IGNORES = [
  'src/**/*.test.ts',
  'src/**/*.test.tsx',
  'src/**/*.test-d.ts',
  'src/test/**',
];

/**
 * Test fixtures are not a public API. Without this, a fixture could quietly
 * become the source of a default scenario, which is exactly the kind of
 * invented data the project forbids.
 */
const TEST_HELPER_PATTERN = {
  group: ['@/test', '@/test/**', '**/src/test/**'],
  allowTypeImports: false,
  message:
    'Test fixtures must not be reachable from application code. Move the value into a real module if production needs it.',
};

/**
 * Import patterns that would hand ground truth to the tracking side. The
 * typescript-eslint variant of the rule is used deliberately: unlike the core
 * rule it also reports `import type`, which is the most likely leak path.
 *
 * The globs cover the alias, any relative depth, and an explicit file
 * extension, since all three resolve to the same module.
 */
const GROUND_TRUTH_PATTERNS = [
  {
    group: [
      '@/core/contracts/ground-truth',
      '@/core/contracts/ground-truth.*',
      '**/contracts/ground-truth',
      '**/contracts/ground-truth.*',
      './ground-truth',
      './ground-truth.*',
      '../ground-truth',
      '../ground-truth.*',
    ],
    allowTypeImports: false,
    message:
      'Ground truth is not observable by a tracker. Consume CameraSensorFrame, CameraState and GimbalState instead (ADR-0003).',
  },
  {
    group: [
      '@/core/simulation',
      '@/core/simulation/**',
      '**/core/simulation',
      '**/core/simulation/**',
    ],
    allowTypeImports: false,
    message:
      'The tracking side must not depend on simulator internals; it only sees sensor output (ADR-0002, ADR-0003).',
  },
  {
    group: ['@/core/metrics', '@/core/metrics/**', '**/core/metrics', '**/core/metrics/**'],
    allowTypeImports: false,
    message:
      'Evaluation code scores a tracker from the outside and reads ground truth. A tracker importing it would create a leak path (ADR-0003).',
  },
];

/**
 * The tracking-side barrier.
 *
 * Repeats {@link TEST_HELPER_PATTERN} because ESLint replaces a rule's options
 * wholesale when a later config block sets the same rule, rather than merging
 * them. Dropping it here would silently relax the tracking side.
 */
const GROUND_TRUTH_IMPORT_BARRIER = [
  'error',
  { patterns: [...GROUND_TRUTH_PATTERNS, TEST_HELPER_PATTERN] },
];

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'coverage/**',
      'node_modules/**',
      'src-tauri/target/**',
      'src-tauri/gen/**',
    ],
  },

  // Base JavaScript rules (this config file itself, and any future .js tooling).
  {
    files: ['**/*.js'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.node,
    },
  },

  // Type-aware linting for all TypeScript in the app.
  {
    files: ['**/*.{ts,tsx}'],
    extends: [js.configs.recommended, tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.es2023 },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'prefer-const': 'error',
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.object.name='Math'][callee.property.name='random']",
          message:
            'Math.random() is not reproducible. Draw from a seeded generator so an experiment replays exactly (ADR-0004).',
        },
      ],
    },
  },

  // React-specific rules for components.
  //
  // eslint-plugin-react-hooks v7 still exposes the legacy array-style `plugins`
  // at `configs['recommended-latest']`; the flat-config equivalent lives under
  // `configs.flat`.
  {
    files: ['src/**/*.tsx'],
    extends: [reactHooks.configs.flat['recommended-latest'], reactRefresh.configs.vite],
  },

  // shadcn/ui primitives.
  //
  // Each primitive exports its cva variant builder alongside the component, so
  // call sites can style a non-button as a button. react-refresh/only-export-
  // components flags that, but its `allowConstantExport` escape hatch does not
  // cover a returned function. The rule protects Fast Refresh ergonomics, not
  // correctness, and keeping the file layout the shadcn CLI generates means the
  // CLI can still add components to this directory.
  {
    files: ['src/components/ui/**/*.tsx'],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },

  // Application code may not reach into test fixtures.
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: PRODUCTION_SOURCE_IGNORES,
    rules: {
      '@typescript-eslint/no-restricted-imports': ['error', { patterns: [TEST_HELPER_PATTERN] }],
    },
  },

  // The ground-truth isolation barrier. Must come after the block above, whose
  // rule options it deliberately supersedes and re-includes.
  {
    files: TRACKING_SIDE,
    rules: {
      '@typescript-eslint/no-restricted-imports': GROUND_TRUTH_IMPORT_BARRIER,
    },
  },

  // Node-side build tooling.
  {
    files: ['vite.config.ts'],
    languageOptions: { globals: globals.node },
  },

  // Tests may assert on rejected shapes, so they need a little more latitude.
  {
    files: ['src/**/*.{test,spec}.{ts,tsx}', 'src/**/*.test-d.ts', 'src/test/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
    },
  },

  // Must stay last: turns off everything that fights Prettier.
  prettier,
);
