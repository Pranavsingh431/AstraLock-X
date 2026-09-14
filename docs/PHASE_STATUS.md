# Phase status

What actually works, and what does not. Updated at the end of each phase.

| Phase | Scope                                                                | Status       |
| ----- | -------------------------------------------------------------------- | ------------ |
| 0     | Project foundation: contracts, isolation, tooling, CI, shell         | **Complete** |
| 1     | Simulation core: world, motion, seeded RNG, tick loop, 3D observer   | **Complete** |
| 2     | Sensor models: camera frame formation, gimbal encoders; Scenario Lab | Not started  |
| 3     | Perception and estimation; first algorithm plugins                   | Not started  |
| 4     | Control and PAT state machine; Calibration                           | Not started  |
| 5     | Metrics, experiment runner, AstraBench, Replay, Reports              | Not started  |
| 6     | Mission Control: live 3D scene, camera view, telemetry plots         | Not started  |
| 7     | Hardware-in-the-loop: serial and USB device drivers                  | Not started  |

---

## Phase 0 — Project foundation

**Complete.**

### What was built

**Data contracts** (`src/core/contracts/`) — every type named in the phase
specification, plus the supporting vocabulary:

| Module                | Contents                                                                     |
| --------------------- | ---------------------------------------------------------------------------- |
| `units.ts`            | Branded scalar units and conversions between them                            |
| `geometry.ts`         | Vectors, quaternions, poses, bearings, covariances, reference frames         |
| `isolation.ts`        | The ground-truth brand, the type-level reachability check, the runtime guard |
| `ground-truth.ts`     | `GroundTruthState`, `WorldState`, `TargetId` — the restricted module         |
| `simulation.ts`       | `SimulationConfig`, `SimulationSeed`, and their Zod schemas                  |
| `sensors.ts`          | `CameraSensorFrame`, `CameraState`, `GimbalState`                            |
| `perception.ts`       | `TargetObservation`                                                          |
| `estimation.ts`       | `TargetEstimate`, `TrackId`                                                  |
| `control.ts`          | `ControlCommand`                                                             |
| `pat.ts`              | `PATState`                                                                   |
| `telemetry.ts`        | `TelemetrySample`                                                            |
| `experiments.ts`      | `ExperimentEvent`, `ExperimentSummary`, `RunId`                              |
| `algorithm-plugin.ts` | `AlgorithmPlugin`, `TrackingInput`, `TrackingOutput`, `defineAlgorithm`      |

**Ground-truth isolation**, enforced four ways and tested four ways. See
[ADR-0003](adr/0003-ground-truth-isolation.md).

**Application shell** — six views, each explicitly labelled NOT IMPLEMENTED,
each listing what it will do and what it needs first. Navigation by mouse or by
platform-modifier plus 1–6. The status bar reports real build facts (version
injected from `package.json`, Vite mode, and whether the Tauri bridge is
present); it does not report telemetry, because there is none.

**Tauri 2 desktop host** — window creation only. Capabilities are `core:default`
alone, and the content security policy permits no remote origins, which makes
the offline requirement structural.

**Tooling** — Vite 8, React 19.2, TypeScript 6.0 strict plus nine additional
checks, Tailwind 4, shadcn/ui with Radix, Zustand, Zod 4, Vitest 5, ESLint 10,
Prettier. Three TypeScript projects so application code cannot reach Node
globals.

**CI** — lint, typecheck, test and frontend build on Ubuntu; desktop build with
`cargo fmt` and Clippy on Ubuntu, macOS and Windows.

### Tests

87 tests across 9 files.

| File                           | Tests | Covers                                                                                                                                 |
| ------------------------------ | ----- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `isolation.test.ts`            | 16    | Runtime detection, path reporting, cycles, `structuredClone` durability, non-strippable brand, plugin-boundary guard                   |
| `isolation.test-d.ts`          | 16    | Type-level reachability, `defineAlgorithm` rejection, unit brand distinctness                                                          |
| `ground-truth-barrier.test.ts` | 6     | The real ESLint config blocks value imports, type imports, relative paths and metrics; allows the safe barrel and privileged consumers |
| `units.test.ts`                | 12    | Conversions, round-trips, `wrapToPi` across the discontinuity, non-positive rate rejection                                             |
| `simulation.test.ts`           | 11    | Seed range, schema acceptance and rejection, cross-field rules, multi-error reporting                                                  |
| `navigation-store.test.ts`     | 6     | View switching, no-op on re-selection, back behaviour                                                                                  |
| `views.test.ts`                | 7     | Registry integrity, lookup, narrowing                                                                                                  |
| `app-info.test.ts`             | 3     | Tauri bridge detection, real build facts                                                                                               |
| `AppShell.test.tsx`            | 10    | Default view, navigation, shortcuts, accessibility, placeholder content, status bar                                                    |

The negative tests were verified to have teeth: removing the check from
`defineAlgorithm` makes exactly two type tests fail with
`Unused '@ts-expect-error' directive`, and restoring it makes them pass.

### Limitations

These are real and deliberate, not oversights.

1. **Nothing is simulated.** There is no world, no sensor model and no tracking
   algorithm. Every view is empty. This is the specified scope of Phase 0.

2. **Seed derivation is specified but not implemented.** `SimulationSeed` exists
   and is validated. The derivation of independent per-subsystem streams from a
   root seed is described in [ADR-0004](adr/0004-deterministic-seeded-experiments.md)
   and arrives with the simulator in Phase 1.

3. **No Rust-side tests.** The crate creates a window and contains no logic
   worth testing. Rust tests arrive when Rust logic does.

4. **No end-to-end browser test.** Playwright was considered and deferred.
   Driving the Tauri webview needs `tauri-driver` and a WebDriver setup that
   would add substantial CI surface to assert what the existing React Testing
   Library tests already cover. It becomes worthwhile once there is a run to
   drive end to end — Phase 5 or 6.

5. **Isolation is not adversary-proof.** A contributor who casts through `any`
   or reaches for `structuredClone` deliberately can defeat the barriers. The
   goal is that accidents are impossible and deliberate circumvention is obvious
   in review.

6. ~~**The type-level reachability check is depth-limited.**~~ Closed in Phase
   0.5: the check now fails closed, and the runtime scan is unbounded.

7. ~~**Cross-platform desktop builds are unverified.**~~ Closed in Phase 0.5:
   all three platforms build in CI.

8. **Floating-point reproducibility is per-machine.** Runs reproduce exactly on
   one architecture. Bit-identical results across architectures are not
   guaranteed, so cross-machine metric comparisons should use tolerances.

9. **`exactOptionalPropertyTypes` may create friction later.** It is on because
   it catches a real class of bug in engineering contracts. Some third-party
   React component types are not written with it in mind, and adapters may be
   needed at those boundaries.

### Toolchain notes

Versions were pinned for mutual compatibility, which in three cases meant not
taking the newest release:

- **React 19.2.8**, not 19.3 — `@react-three/fiber` 9.7 declares `react: >=19 <19.3`.
- **TypeScript 6.0.3**, not 7.0.2 — `typescript-eslint` 8.70 supports
  `>=4.8.4 <6.1.0`; TypeScript 7 would disable type-aware linting entirely.
- **Vite 8** no longer bundles esbuild, so the build minifies with Oxc.

`pnpm install` reports no peer-dependency warnings.

### Verification

All commands run from a clean checkout:

| Command                       | Result                              |
| ----------------------------- | ----------------------------------- |
| `pnpm install`                | Success, no peer warnings           |
| `pnpm format:check`           | All files match Prettier style      |
| `pnpm lint`                   | No errors                           |
| `pnpm typecheck`              | No errors                           |
| `pnpm test`                   | 87 passed, 0 failed, no type errors |
| `pnpm build`                  | Success                             |
| `cargo fmt --check`           | Clean                               |
| `cargo clippy -- -D warnings` | Clean                               |
| `pnpm tauri build`            | `.app` and `.dmg` produced (macOS)  |

---

## Phase 0.5 — Cross-platform foundation gate

**Complete.**

Closed the foundation issues left open at Phase 0 and proved the repository on
all three target platforms.

### Toolchain, now pinned rather than inherited

| Tool    | Version                                     | Pinned by                                 |
| ------- | ------------------------------------------- | ----------------------------------------- |
| Node.js | 24 LTS — `>=24.0.0 <25`                     | `.nvmrc`, `.node-version`, `engines.node` |
| pnpm    | 10.15.0                                     | `packageManager`, provisioned by Corepack |
| Rust    | 1.98.1 with rustfmt and clippy              | `rust-toolchain.toml`                     |
| Tauri   | CLI 2.11.4, crate 2.11.5, tauri-build 2.6.3 | `package.json`, `Cargo.lock`              |

Node 23 was the local runtime at Phase 0 and is end-of-life. It is now refused
outright: `engine-strict=true` in `.npmrc` turns a wrong runtime into an
immediate, explicit install failure rather than a warning. Verified by running
`pnpm install` on Node 23 and watching it refuse.

Exact versions used for verification: **Node v24.19.0**, **pnpm 10.15.0**,
**rustc 1.98.1 (48a229cea 2026-09-01)**. CI resolves `.nvmrc` to the latest
24.x, so the matrix covers a second Node 24 patch release as well.

### Ground-truth isolation now fails closed

The type-level walk previously returned a boolean and answered "clean" when it
exhausted its depth budget, so a sufficiently deeply nested type was admitted
without ever being examined. It now returns one of three verdicts, and only one
of them is admitted:

| Verdict   | Meaning                           | Outcome  |
| --------- | --------------------------------- | -------- |
| `clean`   | proved to contain no ground truth | accepted |
| `tainted` | proved to contain ground truth    | rejected |
| `unknown` | undecided within the budget       | rejected |

`defineAlgorithm` reports the two rejections differently —
`GroundTruthReachable` versus `GroundTruthUnprovable` — because the remedies
differ: remove the dependency, or flatten the type.

The runtime scan lost its depth cutoff entirely. It is now iterative rather than
recursive, so it traverses structures deeper than the JavaScript call stack, and
it tracks visited objects so cycles terminate instead of looping. Binary buffers
are skipped after the brand check, which also removes a real cost: enumerating a
640x480 frame byte by byte would have been 307,200 property visits per call.

Both changes were mutation-tested. Reverting the type walk to fail-open makes
exactly six type tests fail, two of them with `Unused '@ts-expect-error'`
directives on the `defineAlgorithm` rejection cases.

### Export boundary

Audited and now tested. `contracts/index.ts` re-exports nothing from the
ground-truth module — checked at runtime by comparing the two modules' export
sets, so adding `export * from './ground-truth'` fails a test rather than
silently widening the surface. Fifteen tracker-facing types carry standing
type-level proofs that ground truth is not reachable through them.

The lint barrier gained three routes it did not previously block: imports naming
an explicit file extension, relative paths from any nesting depth, and test
fixtures reaching application code.

One rough edge, recorded honestly: a type that is both very wide and deep — the
Zod schema inside `AlgorithmManifest` is the example here — exhausts the
compiler's own instantiation limit and reports TS2589 rather than the dedicated
diagnostic. That is still fail-closed, since TS2589 is a compile error, but the
message is worse. It does not affect the checked surface: the manifest never
crosses the boundary and exposes nothing beyond `TConfig`, which is checked
directly.

### Repository

The AstraLock-X directory is itself the repository root, with
`https://github.com/Pranavsingh431/AstraLock-X` as `origin`. No parent
repository configuration is involved. `.gitattributes` normalises line endings
to LF in every working tree, and `.gitignore` covers dependencies, build output,
Rust target directories, generated bundles, editor and OS files, environment
files, keys and signing material.

### CI: green on all three platforms

Run: <https://github.com/Pranavsingh431/AstraLock-X/actions/runs/34832372912>

| Platform                 | Result  | Bundle produced               |
| ------------------------ | ------- | ----------------------------- |
| Linux (ubuntu-latest)    | success | 178.2 MB (deb, rpm, AppImage) |
| macOS (macos-latest)     | success | 4.4 MB (.app, .dmg)           |
| Windows (windows-latest) | success | 3.2 MB (.msi, NSIS .exe)      |

Every platform runs the same chain: `pnpm install --frozen-lockfile`, format
check, lint, typecheck, tests, frontend production build, `cargo fmt --check`,
`cargo clippy -- -D warnings`, and a real `pnpm tauri build`. The desktop build
is not skipped or soft-failed anywhere; each job uploads its bundle, and the
step fails if no files are produced. Artifacts are unsigned, which is
deliberate at this stage.

The first run failed on Windows and only on Windows: Git checks out CRLF there
by default while `.prettierrc.json` pins `endOfLine: "lf"`, so `prettier
--check` rejected every file. Fixed at the repository level with
`.gitattributes` rather than by relaxing Prettier, which also stops CRLF being
committed.

### Clean-clone reproducibility

A fresh `git clone` of the pushed repository into an unrelated directory, set up
from the repository documentation alone:

| Step                             | Result                                            |
| -------------------------------- | ------------------------------------------------- |
| `pnpm install --frozen-lockfile` | Success, zero warnings                            |
| `pnpm verify`                    | 114 tests passed, no type errors, build succeeded |
| `cargo fmt --check`              | Clean                                             |
| `cargo clippy -- -D warnings`    | Clean                                             |
| `pnpm tauri build`               | `.app` and `.dmg` produced                        |

The pinned Rust toolchain installed itself from `rust-toolchain.toml` with no
manual step. Nothing was copied in from the original working tree.

### Tests

114 tests across 11 files, up from 87 across 9.

| File                           | Tests | Covers                                                                                                                                                                     |
| ------------------------------ | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `isolation.test.ts`            | 26    | Runtime detection, path reporting, 20,000-level depth, four cycle shapes, Maps and Sets, binary payloads, `structuredClone`, plugin-boundary guard                         |
| `isolation.test-d.ts`          | 20    | All three verdicts, fail-closed rejection of undecidable types, `any` versus `unknown`, plugin admission and rejection                                                     |
| `ground-truth-barrier.test.ts` | 10    | The real ESLint config blocks value imports, type imports, explicit extensions, deep relative paths, metrics and fixtures; allows the safe barrel and privileged consumers |
| `export-boundary.test.ts`      | 4     | The barrel re-exports nothing privileged and still exports the isolation tooling                                                                                           |
| `export-boundary.test-d.ts`    | 5     | Fifteen tracker-facing types proved ground-truth-free                                                                                                                      |
| `units.test.ts`                | 12    | Conversions, round-trips, `wrapToPi`, non-positive rate rejection                                                                                                          |
| `simulation.test.ts`           | 11    | Seed range, schema acceptance and rejection, cross-field rules                                                                                                             |
| `navigation-store.test.ts`     | 6     | View switching, no-op on re-selection, back behaviour                                                                                                                      |
| `views.test.ts`                | 7     | Registry integrity, lookup, narrowing                                                                                                                                      |
| `app-info.test.ts`             | 3     | Tauri bridge detection, real build facts                                                                                                                                   |
| `AppShell.test.tsx`            | 10    | Default view, navigation, shortcuts, accessibility, placeholder content, status bar                                                                                        |

### Local verification

Run on Node v24.19.0 with pnpm 10.15.0 and the pinned Rust 1.98.1:

| Command                          | Result                                                  |
| -------------------------------- | ------------------------------------------------------- |
| `pnpm install --frozen-lockfile` | Success, zero peer warnings on a removed `node_modules` |
| `pnpm format:check`              | All files match Prettier style                          |
| `pnpm lint`                      | No errors                                               |
| `pnpm typecheck`                 | No errors                                               |
| `pnpm test`                      | 114 passed, 0 failed, no type errors                    |
| `pnpm build`                     | Success                                                 |
| `pnpm verify`                    | Exit 0                                                  |
| `cargo fmt --check`              | Clean                                                   |
| `cargo clippy -- -D warnings`    | Exit 0, zero warnings                                   |
| `pnpm tauri build`               | `.app` and `.dmg` produced                              |

### Remaining limitations

Non-blocking, and unchanged in substance from Phase 0 except where noted.

1. **Nothing is simulated.** No world, no sensor model, no tracking algorithm.
   Every view is empty and says so. This remains the specified scope.

2. **Seed derivation is specified but not implemented.** Arrives with the
   simulator in Phase 1.

3. **No Rust-side tests.** The crate creates a window and contains no logic
   worth testing.

4. **No end-to-end browser test.** Driving the Tauri webview needs
   `tauri-driver`; worthwhile once there is a run to drive, at Phase 5 or 6.

5. **Isolation is not adversary-proof.** A contributor who casts through `any`
   or reaches for `structuredClone` deliberately can still defeat the barriers.
   The goal is that accidents are impossible and deliberate circumvention is
   obvious in review.

6. **Failing closed can reject a legitimate type that is merely deep.** The
   budget is twelve levels against a measured worst case of six, so there is
   margin, but an unbounded recursive type cannot appear on a plugin's surface.
   This is the intended trade: a false rejection is a compile error with a clear
   remedy, a false acceptance is a silently meaningless benchmark.

7. **A very wide and deep type reports TS2589** rather than the dedicated
   diagnostic. Still a build failure, so still fail-closed; just a worse message.

8. **Desktop artifacts are unsigned.** No code signing, Apple notarisation or
   Windows signing. Deliberate at this stage; a signed release pipeline is a
   later concern.

9. **Floating-point reproducibility is per-machine.** Runs reproduce exactly on
   one architecture; bit-identical results across architectures are not
   guaranteed, so cross-machine metric comparisons should use tolerances.

10. **`exactOptionalPropertyTypes` may create friction later** with third-party
    React component types not written with it in mind.

11. **Linux CI artifacts are large** (178 MB, since AppImage bundles a runtime).
    Retention is capped at seven days; if this becomes a nuisance, narrow the
    uploaded bundle targets.

---

## Phase 1 — Deterministic simulation core

**Complete.**

A real authoritative simulator, and a 3D observer of it. No sensor model, no
detector, no filter, no control loop, and no tracking of any kind.

### The architectural line

The authoritative world is `SimulationEngine`, plain TypeScript in
`src/core/simulation`. It runs with no React, no Three.js, no WebGL and no DOM:
the headless and long-run suites execute in the plain Node environment, and a
lint rule refuses any import of React, Three.js, `@react-three/*` or a store
from `src/core`. That rule is itself tested, by running the project's real
ESLint configuration over probe files.

Rendering reads snapshots and never writes back. Entity transforms are applied
imperatively inside `useFrame`, so a moving target does not re-render the scene
graph; the HUD subscribes to low-frequency fields only.

### Coordinate convention

`world-enu`: **X = East, Y = North, Z = Up**, metres, right-handed
(`East × North = Up`). **Azimuth clockwise from North** about +Up, wrapped to
(−π, π]; **elevation positive upward**. Radians throughout the core.

Renderer mapping, in one function and one direction:
`renderer = (east, up, −north)`. Determinant +1, so handedness is preserved —
tested via a preserved cross product, because a mirrored mapping would pass a
naive axis check while flipping every azimuth drawn. Scene units are metres with
no scale factor. See [ADR-0006](adr/0006-engineering-coordinate-convention.md).

### PRNG and stream derivation

**xoshiro128\*\*** (Blackman & Vigna): 128-bit state, period 2^128 − 1, inner
loop entirely 32-bit operations, which JavaScript expresses exactly via
`Math.imul` and `>>>`. State expanded from a 32-bit stream seed with SplitMix32;
an all-zero state is checked for rather than assumed away.

```
streamSeed(root, name) = splitMix32( splitMix32(root) XOR fnv1a32(name) )
```

Streams: `trajectory`, `environment`, `platform`, `sensor`, `disturbance` — the
last two reserved for Phase 2 and declared now, since each name derives
independently. Gaussians take two draws and discard one so that no state lives
outside the generator. `Math.random` is blocked by lint. See
[ADR-0007](adr/0007-deterministic-prng-and-stream-derivation.md).

### Fixed timestep

Authoritative quantity is an **integer tick index**; time is derived, never
accumulated:

```
time = tick / tickRate
```

Bundled scenarios run at **200 Hz**, so the fixed timestep is **5 ms**. Wall
clock decides how many ticks to run and nothing else; catch-up is bounded and
drops the backlog rather than carrying an unpayable debt. See
[ADR-0008](adr/0008-fixed-timestep-simulation.md).

### Trajectory families

All six implemented with analytic derivatives — velocity and acceleration are
differentiated from the position expression, not differenced across ticks. Every
family is checked against a central finite difference as well as against known
values.

| Family           | Model                                                   |
| ---------------- | ------------------------------------------------------- |
| Stationary       | Fixed point                                             |
| Linear           | `p = p0 + v0 t`                                         |
| Circular         | Arbitrary plane; `a = −ω²(p − c)`, verified centripetal |
| Sinusoidal       | Base motion plus N sinusoids; `a = −ω²` × displacement  |
| Waypoint         | Piecewise linear in time, optional looping              |
| Seeded manoeuvre | Bounded constant-acceleration legs from the seed        |

The seeded family generates its whole schedule at construction — exactly four
draws per leg regardless of the path taken — so `sampleAt` stays pure and the
schedule is inspectable in the debug panel.

### Bug found by the long-run test

The seeded manoeuvre originally extrapolated the final leg's acceleration past
the end of its schedule. Over a 500 s run against a 120 s schedule that is
unbounded: speed reached **1491 m/s** against a configured ceiling of 45. It now
coasts at constant velocity past the schedule, which is continuous in position
and velocity and stays inside the speed ceiling.

A second defect in the same test was mine, not the code's: the bounds envelope
assumed one segment of overshoot, but the homeward override is only evaluated at
segment boundaries, so two segments is the correct bound.

### Configuration

`SimulationConfig` extended to **schema version 2**: targets declare a
`trajectory` instead of a start position and velocity, and the platform declares
a `boresight`. A version 1 document is rejected rather than migrated — guessing
a trajectory for a config that never specified one would be inventing the
experiment.

Six bundled scenarios in `src/scenarios`, one per family, each parsed _and
executed_ by the test suite. Export writes the validated config and nothing
else: no camera pose, no playback speed, no view toggles.

### Observer view

Mission Control now shows the simulation, labelled **OBSERVER / GROUND-TRUTH
VIEW** with a second line stating it is not the tracking sensor feed. It draws
the grid, world origin, axes, observer platform, fixed boresight ray, target and
beacon markers, and the full trajectory path, with orbit/pan/zoom for the
operator.

A separate panel headed **GROUND TRUTH — DEBUG ONLY** reads the restricted
simulation API directly — legitimate under ADR-0003, which names debug views as
a permitted consumer — and shows positions, velocity, acceleration, entity ids,
the manoeuvre schedule, stream draw counts and the state hash. It widens nothing:
`AlgorithmPlugin`'s surface is untouched, and a test confirms the tracking side
still cannot import either the simulation core or the observer adapter.

### Tests

**324 tests across 22 files**, up from 114 across 11.

| File                           | Tests |
| ------------------------------ | ----- |
| `scenarios.test.ts`            | 38    |
| `trajectory.test.ts`           | 36    |
| `isolation.test.ts`            | 26    |
| `engine.test.ts`               | 22    |
| `rng.test.ts`                  | 20    |
| `isolation.test-d.ts`          | 20    |
| `clock.test.ts`                | 18    |
| `coordinates.test.ts`          | 17    |
| `ground-truth-barrier.test.ts` | 17    |
| `mission-control.test.tsx`     | 15    |
| `observer-view.test.ts`        | 13    |
| `scenario-io.test.ts`          | 13    |
| `units.test.ts`                | 12    |
| `simulation.test.ts`           | 11    |
| `AppShell.test.tsx`            | 11    |
| `views.test.ts`                | 7     |
| `navigation-store.test.ts`     | 6     |
| `headless.test.ts`             | 5     |
| `long-run.test.ts`             | 5     |
| `export-boundary.test-d.ts`    | 5     |
| `export-boundary.test.ts`      | 4     |
| `app-info.test.ts`             | 3     |

The long-run suite executes **100,000 ticks** (500 s of simulated flight) and
checks for NaN and Infinity, that state stays inside an envelope _derived from
the configuration_, that a repeat run hashes identically, that one jump equals
many steps, and that an analytic trajectory still sits exactly on its closed
form afterwards.

Headless-versus-interactive equivalence is asserted directly: 5,000 ticks driven
by irregular frame times through the scheduler reach the same state hash as
`step(5000)` with no renderer present.

### Limitations

Phase 1 additions; earlier entries still apply.

1. **No sensor model, detector, filter or control loop.** Nothing tracks
   anything. This is the specified scope.
2. **Quantities not modelled report zero or null, never a guess.** Received
   beacon power is `null` regardless of configured transmit power; occlusion,
   base-motion disturbance, platform attitude and the gimbal servo are all
   zero. [docs/SIMULATION.md](SIMULATION.md) lists them in full.
3. **Waypoint interpolation is piecewise linear**, so velocity steps at nodes
   and the impulsive acceleration there is reported as zero. A C¹ model can be
   added later as a second option.
4. **The platform translates but does not rotate**, and its boresight is a fixed
   reference direction rather than a servo.
5. **Targets are points** with identity orientation; no attitude model.
6. **WebGL is not covered by automated tests.** jsdom has no drawing context, so
   the canvas is stubbed in UI tests and the rendered scene is verified by
   running the application. A future end-to-end harness could close this.
7. **No performance work has been done, deliberately.** The engine has not been
   profiled, so no bottleneck is claimed and none has been optimised. 100,000
   ticks run in well under a second in the test suite, which is the only
   measurement taken.
8. **The simulation can fall behind real time** on a slow machine or a
   backgrounded tab; the tick counter advancing slowly is the only signal.

### Next

Phase 2 — sensor models and the Scenario Lab. Do not begin it without an
explicit request.
