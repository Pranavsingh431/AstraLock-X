# Development

## Prerequisites

| Tool               | Version                   | How it is pinned                          |
| ------------------ | ------------------------- | ----------------------------------------- |
| Node.js            | 24 LTS (`>=24.0.0 <25`)   | `.nvmrc`, `.node-version`, `engines.node` |
| pnpm               | 10.15.0                   | `packageManager`, provisioned by Corepack |
| Rust               | 1.98.1 + rustfmt + clippy | `rust-toolchain.toml`                     |
| Platform toolchain | see below                 | —                                         |

Node 24 is the supported line. **Node 23 is end-of-life and will not work**:
`engine-strict=true` in `.npmrc` makes `pnpm install` refuse an unsupported
runtime rather than warn and carry on, so a wrong version fails immediately with
a clear message instead of surfacing later as something stranger.

Nothing here depends on whichever Node happens to be installed globally. With
`nvm`, `fnm`, `asdf` or `nodenv`, `.nvmrc` selects the right one:

```bash
nvm use        # or: fnm use
```

pnpm comes from Corepack, which ships with Node and reads the `packageManager`
field, so the exact pnpm version is pinned by the repository:

```bash
corepack enable
```

Rust is pinned by `rust-toolchain.toml`. rustup reads it automatically for any
cargo command run inside the repository and installs the toolchain on first
use, so a new machine needs [rustup](https://rustup.rs) and nothing else.

Platform toolchains:

- **macOS** — Xcode Command Line Tools (`xcode-select --install`)
- **Windows** — Microsoft C++ Build Tools and the WebView2 runtime
- **Linux** — the Tauri 2 prerequisites:

  ```bash
  sudo apt-get install libwebkit2gtk-4.1-dev build-essential curl wget file \
    libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
  ```

  Note `libwebkit2gtk-4.1-dev`: Tauri 1 used 4.0, and older tutorials still say
  so. `.github/workflows/ci.yml` installs exactly this list, so it is the
  authoritative version.

Tauri's [prerequisites page](https://tauri.app/start/prerequisites/) has the
per-distribution package names.

If `cargo` is not on your `PATH` after installing Rust, add rustup's environment
to your shell profile — the path is the one rustup reports, not a fixed
location:

```bash
echo 'source "$HOME/.cargo/env"' >> ~/.zshrc
```

## Setup

```bash
corepack enable
pnpm install --frozen-lockfile
```

## Commands

| Command              | What it does                                      |
| -------------------- | ------------------------------------------------- |
| `pnpm dev`           | Vite dev server on port 1420, frontend only       |
| `pnpm tauri:dev`     | Full desktop app with hot reload                  |
| `pnpm build`         | Typecheck, then production frontend build         |
| `pnpm tauri:build`   | Production desktop bundle for the current OS      |
| `pnpm typecheck`     | `tsc -b` across app, test and node projects       |
| `pnpm lint`          | ESLint, including the ground-truth import barrier |
| `pnpm lint:fix`      | ESLint with autofix                               |
| `pnpm format`        | Prettier write                                    |
| `pnpm format:check`  | Prettier check, as CI runs it                     |
| `pnpm test`          | Runtime tests and type tests                      |
| `pnpm test:unit`     | Runtime tests only                                |
| `pnpm test:types`    | Type tests only                                   |
| `pnpm test:watch`    | Watch mode                                        |
| `pnpm test:coverage` | Coverage report                                   |
| `pnpm verify`        | Everything CI runs, in order                      |

Run `pnpm verify` before pushing.

## How the TypeScript projects are split

Three projects, referenced from the root `tsconfig.json`:

- **`tsconfig.app.json`** — application source. Types are `vite/client` only,
  and test files are excluded. Node types are deliberately absent so that
  `process.env` and `node:fs` cannot be reached from code that ships to a
  webview.
- **`tsconfig.test.json`** — tests plus the application code they exercise, with
  Node types available. Vitest's type-test runner uses this project.
- **`tsconfig.node.json`** — `vite.config.ts`.

Beyond `strict`, these are on: `exactOptionalPropertyTypes`,
`noUncheckedIndexedAccess`, `noImplicitReturns`, `noImplicitOverride`,
`noPropertyAccessFromIndexSignature`, `noUnusedLocals`, `noUnusedParameters`,
`noFallthroughCasesInSwitch` and `verbatimModuleSyntax`.

## Testing

Vitest with jsdom and React Testing Library. Globals are off — import
`describe`, `it` and `expect` from `vitest` explicitly.

Three kinds of test:

- **`*.test.ts` / `*.test.tsx`** — ordinary runtime tests.
- **`*.test-d.ts`** — type-level tests, run by `vitest --typecheck`. These use
  `expectTypeOf` and `@ts-expect-error`. The `@ts-expect-error` cases are the
  valuable ones: TypeScript reports an _unused_ `@ts-expect-error` as an error,
  so the test fails if the code it marks ever starts compiling.
- **Configuration tests** — `ground-truth-barrier.test.ts` runs the project's
  real ESLint configuration over probe files to confirm the import barrier still
  fires. It writes probes into `src/core/algorithms/__lint_probe__/` and
  `src/core/metrics/__lint_probe__/` and removes them afterwards.

When you add a barrier, add a test that fails if the barrier is removed. A test
that only confirms the current behaviour will not notice a weakened guarantee.

## Conventions

**Units.** Physical quantities use the branded types in
`core/contracts/units.ts`. Construct them with the provided functions
(`radians(x)`, `meters(x)`) rather than casting. Radians are canonical
internally; degrees appear only at configuration and display boundaries.

**Determinism.** No `Date.now()`, `performance.now()` or `Math.random()` in
anything that affects simulation state. `Math.random` is blocked by lint. Draw
from the seeded stream you are given. See
[ADR-0004](adr/0004-deterministic-seeded-experiments.md).

**Ground truth.** If you are working in `core/algorithms`, `core/perception`,
`core/estimation`, `core/control` or `core/pat`, you cannot import
`core/contracts/ground-truth`, `core/simulation` or `core/metrics`, and lint will
tell you so. That is the design, not an obstacle — see
[ADR-0003](adr/0003-ground-truth-isolation.md). If you need a quantity you
cannot reach, the question to ask is how a real system would measure it.

**No fabricated data.** Every number shown in the UI must come from a
computation that ran. A view with nothing to show should be empty and say why.

**Imports.** Use the `@/` alias for anything outside the current directory.

## Adding a UI component

shadcn/ui components are copied into `src/components/ui`, not installed. Add one
with:

```bash
pnpm dlx shadcn@latest add <component>
```

`components.json` is configured for the new-york style with Tailwind v4 CSS
variables.

## Regenerating application icons

Icons are generated from `src-tauri/icons/icon-source.png` (1024×1024):

```bash
pnpm tauri icon src-tauri/icons/icon-source.png
```

iOS and Android output is removed afterwards — this is a desktop application.

## Notes on the toolchain

Versions were chosen for mutual compatibility rather than for being newest:

- **Node 24 LTS**, not Node 23, which reached end of life. Vite 8 needs
  `^20.19 || >=22.12`; Node 24 satisfies that and is supported.

- **React 19.2**, not 19.3, because `@react-three/fiber` 9.7 declares
  `react: >=19 <19.3`.
- **TypeScript 6.0**, not 7.0, because `typescript-eslint` 8.70 supports
  `>=4.8.4 <6.1.0`. TypeScript 7 would disable type-aware linting.
- **Vite 8** transpiles and minifies with Oxc and no longer bundles esbuild, so
  `build.minify` is `'oxc'`.
- `eslint-plugin-react-hooks` v7 exposes its flat config at
  `configs.flat['recommended-latest']`; `configs['recommended-latest']` is still
  the legacy array form and will not load under ESLint 10.

## Where things are decided

Read [docs/adr/](adr/) before changing anything structural. If you change a
decision, add a new ADR that supersedes the old one rather than editing it.
