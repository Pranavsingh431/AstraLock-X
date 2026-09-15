# Phase status

What actually works, and what does not. Updated at the end of each phase.

| Phase | Scope                                                                    | Status       |
| ----- | ------------------------------------------------------------------------ | ------------ |
| 0     | Project foundation: contracts, isolation, tooling, CI, shell             | **Complete** |
| 1     | Simulation core: world, motion, seeded RNG, tick loop, 3D observer       | **Complete** |
| 2     | Virtual optical camera and sensor image pipeline                         | **Complete** |
| 3     | Dynamic pan/tilt gimbal and actuator system                              | **Complete** |
| 4     | First autonomous closed-loop coarse PAT                                  | **Complete** |
| 5     | Experiment recorder, KPI engine and performance reporting                | **Complete** |
| 6     | Robust AstraLock-X PAT: IMM, beacon identity, uncertainty-aware recovery | Not started  |
| 7     | AstraBench, FailureHunter, Replay, disturbances and sensor noise         | Not started  |
| 8     | Final Mission Control UI, hardware-in-the-loop                           | Not started  |

The roadmap was re-sequenced after Phase 4: experiment recording and reporting
came before the robust tracker, so that the robust tracker is measured by the
same recorder the baseline was.

----- | ------------------------------------------------------------------ | ------------ |
| 0 | Project foundation: contracts, isolation, tooling, CI, shell | **Complete** |
| 1 | Simulation core: world, motion, seeded RNG, tick loop, 3D observer | **Complete** |
| 2 | Virtual optical camera and sensor image pipeline | **Complete** |
| 3 | Dynamic pan/tilt gimbal and actuator system | **Complete** |
| 4 | First autonomous closed-loop coarse PAT | **Complete** |
| 5 | Robust PAT: IMM, beacon identity, uncertainty-aware recovery | Not started |
| 6 | Metrics, experiment runner, AstraBench, Replay, Reports | Not started |
| 7 | Mission Control: live 3D scene, camera view, telemetry plots | Not started |
| 8 | Hardware-in-the-loop: serial and USB device drivers | Not started |

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

---

## Phase 2 — Virtual optical camera and sensor image pipeline

**Complete.**

A real virtual camera that turns the authoritative world into timestamped pixel
buffers, and a sensor monitor that shows them. **No detector, no Kalman filter,
no PID, no PAT state machine, no autonomous tracking, no noise model.** Nothing
looks at the pixels yet.

### Preflight: run bounds

Phase 1's engine would step indefinitely; an interactive session left running
walked past the end of its scenario one frame at a time, and for a seeded
manoeuvre that meant running past the generated schedule into the coast regime.
A run now stops at `floor(duration * tickRate)`, `step` returns how many ticks
it actually took, and deliberate overrun requires
`step(n, { beyondDuration: true })`. Seeded-manoeuvre mathematics is unchanged,
which is asserted directly.

Two long-run tests were quietly clamping to a quarter of the ticks they claimed
after this change; they now extend the scenario duration so they really run
100,000 ticks.

### Camera model

Self-contained in `core/sensors`, with no dependency on the simulator's vector
module, Three.js, WebGL or the DOM.

**Basis**, for a no-roll mount in East-North-Up:

```
forward = ( sin(az) cos(el),  cos(az) cos(el),  sin(el) )
right   = ( cos(az),         -sin(az),          0       )
up      = right x forward
```

`right` is horizontal by construction, so the image horizon stays level at every
elevation and the construction does not degenerate pointing straight up.
`(right, up, forward)` is left-handed — the usual computer-vision arrangement —
which is why the vertical projection term carries a minus sign.

**Projection:**

```
x_cam = r . right     y_cam = r . up     z_cam = r . forward
u = cx + fx * x_cam / z_cam
v = cy - fy * y_cam / z_cam
fx = width / (2 tan(hfov / 2))      fy = fx   (square-pixels policy)
```

**Pixel convention:** continuous coordinates with pixel centres at
half-integers. Pixel `(i, j)` covers `[i, i+1) x [j, j+1)`, the image spans
`[0, width] x [0, height]`, and the principal point defaults to
`(width / 2, height / 2)`. A consequence worth recording: an even-width image
has no centre _pixel_, so an on-axis beacon lands on the boundary between two
columns and they receive equal light. The boresight test asserts symmetry, not
a single brightest pixel.

**Format:** GRAY8 — spelled `mono8` in the pixel-format contract, for continuity
with Phase 0. `mono16` is declared and explicitly refused rather than emitting
8-bit data in a 16-bit buffer. The UI expands to RGBA only to draw.

### Sensor clock

```
captureTime(frameIndex) = frameIndex / frameRate
```

One division, never an accumulation. Frames due in an interval are queried
half-open so repeated stepping captures each exactly once, and the index bounds
are corrected against actual capture times because `frameIndex / rate` and
`time * rate` are not exact inverses in binary floating point.

**The frame rate is not required to divide the tick rate.** `round(200/60) = 3`
would be 66.7 FPS — an 11% error in every timestamp. 30, 50, 60, 90 and 120 FPS
are each tested over 200 Hz physics, producing exactly `rate * seconds + 1`
frames, and a ten-minute 60 FPS schedule lands on `captureTime(36000) = 600`
exactly.

### Sampling between ticks

Capture times fall between physics ticks — at 200 Hz and 60 FPS, two frames in
three do. The default policy is **exact**: the world is evaluated at the capture
time itself, with no timing error, which is possible because Phase 1 made
trajectories pure functions of time.

An **interpolating** sampler is also provided for the case exact sampling cannot
cover, once a control loop makes the world depend on its own previous state.
Positions interpolate linearly, angles along the shortest path. Its error is
bounded by `a h^2 / 8` — under 19 micrometres at 5 ms and 6 m/s^2 — and the test
suite measures the two policies against each other to confirm it.

### Image formation

A circular Gaussian point spread, evaluated at pixel centres about the exact
sub-pixel projected centre, bounded at three sigma, and evaluated **separably**
so a kernel of half-width `k` costs `2k` exponentials rather than `k^2`.
Contributions **add, then clip** — adding is what light does, clipping is what a
full well does, and taking the maximum would make two coincident beacons look
like one. Writes outside the image are clipped, never wrapped.

Multiple emitters are supported architecturally: the sensor takes an emitter
list, built from each target's beacon declaration, and never reaches for
`world.targets[0]`.

### The truth boundary

`CameraSensorFrame` carries pixels, timing, format, the mount's own reported
pose, and a configuration id. Nothing else — an adversarial test enumerates the
entire surface, searches it for the ground-truth brand, and confirms the true
projected centre does not appear in a serialisation of the frame.

`SensorEvaluationTruth` is a separate, branded object holding the answer key.
Each per-emitter projection is branded **individually**, which was a real gap
found by the type tests: nested-only branding would have let a projection be
lifted out as a clean-looking object holding the true centre and range.

`SensorCapture` — the pair — is branded too, so the type system refuses to hand
it to a plugin. The lint barrier blocks tracking-side code from importing
`core/sensors` at all.

### Buffer ownership and backpressure

Frames come from a bounded ring of reused buffers: 600 frames at 640x480
allocate 3 buffers, not 600. A frame does not own its pixels, which is stated,
tested, and given `copyFramePixels` as the escape.

Four distinct terms, kept distinct: **scheduled** (the clock called for it),
**rasterized** (pixels built), **superseded for display** (a newer frame was
already due, so the live view skipped it), and **dropped** (the sensor failed —
not modelled, always `null`). A superseded frame is a display decision and is
never reported as a sensor dropout.

### Performance, measured

Apple silicon, Node 24, three emitters in frame, 1000 samples after warm-up:

| Resolution | Mean      | P95       | Max       | Sustainable |
| ---------- | --------- | --------- | --------- | ----------- |
| 320x240    | 0.0150 ms | 0.0203 ms | 0.1442 ms | ~66,000 FPS |
| 640x480    | 0.0160 ms | 0.0185 ms | 1.0548 ms | ~62,000 FPS |

A 60 FPS budget is 16.67 ms, so frame generation uses roughly a thousandth of
it. Cost is dominated by clearing the background, which is linear in area; the
point spread is independent of image size, which is why the two resolutions are
so close. **No optimisation was attempted and none is warranted on this
evidence.**

### Tests

**502 tests across 32 files**, up from 324 across 22.

| File                           | Tests |
| ------------------------------ | ----- |
| `scenarios.test.ts`            | 63    |
| `trajectory.test.ts`           | 36    |
| `golden.test.ts`               | 34    |
| `isolation.test.ts`            | 26    |
| `camera-clock.test.ts`         | 25    |
| `engine.test.ts`               | 22    |
| `ground-truth-barrier.test.ts` | 21    |
| `image-formation.test.ts`      | 21    |
| `pipeline.test.ts`             | 20    |
| `rng.test.ts`                  | 20    |
| `isolation.test-d.ts`          | 20    |
| `clock.test.ts`                | 18    |
| `coordinates.test.ts`          | 17    |
| `scenario-io.test.ts`          | 15    |
| `mission-control.test.tsx`     | 14    |
| `observer-view.test.ts`        | 13    |
| `sensor-panel.test.tsx`        | 12    |
| `units.test.ts`                | 12    |
| `AppShell.test.tsx`            | 11    |
| `simulation.test.ts`           | 11    |
| `run-duration.test.ts`         | 10    |
| `sensor-isolation.test.ts`     | 9     |
| `headless.test.ts` (sensor)    | 7     |
| `views.test.ts`                | 7     |
| `navigation-store.test.ts`     | 6     |
| `sensor-isolation.test-d.ts`   | 6     |
| `export-boundary.test-d.ts`    | 5     |
| `headless.test.ts` (sim)       | 5     |
| `long-run.test.ts`             | 5     |
| `export-boundary.test.ts`      | 4     |
| `performance.test.ts`          | 4     |
| `app-info.test.ts`             | 3     |

The golden geometry suite covers all twelve required cases: boresight, east,
up, behind, both field-of-view edges, near and far range, manual pan, manual
tilt, sub-pixel placement, edge clipping and reproducibility.

### Scenarios

All six Phase 1 scenarios upgraded to schema version 3, plus two new ones:

- **`camera-boresight`** — a fixed beacon exactly on the boresight, the
  reference case for on-axis projection.
- **`camera-target-outside-fov`** — the beacon starts about 25 degrees off a
  12-degree field of view. Phase 4 will search for it autonomously; in Phase 2
  the operator pans until it appears.

Schema version 3 gives the camera a real optical description and replaces a
target's bare `beaconPower` with a beacon that has apparent optical properties.
Versions 1 and 2 are rejected rather than migrated — guessing a field of view
would be inventing the instrument.

### Manual validation

Run in the application, against `camera-target-outside-fov`:

| Check                                      | Result                                                                                         |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| Beacon initially outside the field of view | 0 lit pixels                                                                                   |
| Pan sweep 21° → 29°                        | Beacon traverses 533 → 320 → 108 px                                                            |
| Measured scale                             | 53.1 px/degree, matching `fx tan(1°)` exactly                                                  |
| Entry and exit                             | Absent below 19°, present 20°–31°, absent from 32°, for a 12° field of view on a 25.0° bearing |
| Partial clipping at the edge               | 135 lit pixels at 31° against 223 centred                                                      |
| Elevation limits                           | Absent at −2° and 9°, present 0°–6°, for a 9.0° vertical field of view on a 2.87° bearing      |
| Pause                                      | Tick and image frozen over 2.5 s                                                               |
| Pointing while paused                      | Image moved 53.2 px for 1°, tick unchanged                                                     |
| Reset                                      | Tick 0, camera back to the configured pointing, beacon out of view again                       |
| Truth overlay on                           | Marker at 320.31 against a rendered centroid of 320.39                                         |
| Truth overlay off                          | Zero overlay pixels remaining                                                                  |
| Observer orbit                             | **0 sensor pixels changed**                                                                    |
| Capture timing                             | `frameId = floor(simTime × 60)` at every sample                                                |

The last one is the important one: frame identity tracks simulated time, not the
display. The superseded counter rose while the pane was throttled, which is the
backpressure policy working and is counted as a display decision rather than a
sensor fault.

### Bugs found during implementation

1. **`EmitterProjectionTruth` was not branded.** Only the parent record was, so
   a projection lifted out of `projections` would have been a clean-looking
   object carrying the true image centre and range — and the type-level check
   would not have objected. Found by the compile-time isolation tests; each
   projection is now branded individually.

2. **A golden test asserted the wrong thing.** An on-axis beacon projects to
   `u = 400.0` exactly, which is the boundary between columns 399 and 400, so
   the two tie. The test expected a single brightest pixel; the correct property
   is symmetry, and it now asserts that.

3. **Two Phase 1 long-run tests silently weakened** once runs became bounded by
   duration, clamping to 24,000 of the 100,000 ticks they claimed. Both now
   extend the scenario duration.

### Limitations

Phase 2 additions; earlier entries still apply.

1. **No detector, filter, controller or tracking of any kind.** Nothing reads
   the pixels. This is the specified scope.
2. **The sensor is ideal and noiseless.** No read noise, shot noise, dark
   current, dropout, blur, glare, bloom or lens distortion.
3. **No link budget.** Beacon intensity is constant with range;
   `transmitPower` is declared but unused. A real beacon dims as `1/r^2` and is
   attenuated by the atmosphere.
4. **No occlusion.** Nothing ever blocks anything.
5. ~~**The mount is kinematically ideal.**~~ **Resolved in Phase 3.**
   `IdealCameraMount` was deleted and replaced by `DynamicGimbal`.
6. **`mono16` is unsupported.** Declared in the contract and refused by the
   renderer.
7. **Canvas drawing is not covered by automated tests.** jsdom has no 2D
   context, so the monitor's `getContext` returns null there and the draw path
   is exercised by running the application. The pixel _content_ is tested
   directly against the buffer.
8. ~~**A frame does not own its pixels.**~~ **Resolved in Phase 3.** The pool
   now hands out explicit leases: exhaustion throws instead of silently
   recycling, and using a released frame throws instead of returning another
   frame's pixels.
9. **`Math.exp` is not bit-specified across engines.** Cross-platform results
   could differ in the last ulp of a Gaussian weight, which is immaterial after
   quantisation to 8 bits but is worth recording alongside ADR-0004's existing
   per-architecture caveat.

### Next

Phase 3 — the dynamic gimbal. See below.

---

## Phase 3 — Dynamic pan/tilt gimbal and actuator system

**Complete.**

The camera no longer teleports. Phase 2's `IdealCameraMount` — which adopted
whatever pose it was handed, exactly and instantly — is deleted, and the camera
now sits on a mount with dynamics, limits, imperfect gearing and a
finite-resolution encoder.

### What was built

**Three states where there was one.** COMMAND (what was asked for), TRUE (where
the optics are), MEASURED (what the encoder reports). Image formation uses TRUE;
the `CameraSensorFrame` carries MEASURED. They differ by up to half an encoder
count at every instant, so a future tracker cannot invert its own image
formation. See [ADR-0011](adr/0011-true-versus-measured-actuator-state.md).

**A real axis model** (`src/core/gimbal/axis.ts`). Second-order servo integrated
with semi-implicit Euler, in a chain that is observable at every stage:

```
setpoint → deadband → servo → accel limit → rate limit
         → motor angle → travel stop → backlash → output angle → encoder
```

**Six effects, each separately configurable and separately tested:** command
latency applied at its exact sub-tick due time; subtractive deadband; rate and
acceleration limits with saturation flags; travel stops that absorb outward
momentum; backlash as genuine hysteresis; encoder quantisation with rate
differenced from successive readings rather than sensed.

**Schema v4.** The gimbal block became the real actuator configuration, and
`camera.initialAzimuth`, `camera.initialElevation` and `platform.boresight` were
removed: initial pointing had been declared in three places that could disagree
and now has one. A cross-field rule rejects any scenario whose
`2π·naturalFrequency / tickRate` exceeds 0.5, because the integration would
diverge — a load-time error rather than a runtime surprise.

**Three new scenarios** isolating each effect: `gimbal-step-response`,
`gimbal-latency` (23 ms, deliberately not a multiple of the 5 ms tick) and
`gimbal-backlash`. Eleven bundled scenarios in total, all parsed and executed by
the suite.

**Frame ownership** (`src/core/sensors/frame-pool.ts`). The pool now hands out
explicit leases. Exhaustion throws with a message naming the fix; using a
released frame throws; double release is a no-op; reset reclaims everything.
Silent recycling was tolerable when every consumer drew a frame inside one
synchronous call, and stopped being tolerable once captures are held.

**Mission Control** commands the mount for real. Command against measurement
side by side, servo state, in-flight command count, latency, live limit and
saturation warnings, jog controls, a home command, a bounded command-vs-measured
response plot per axis, and a privileged, labelled, off-by-default ACTUATOR
TRUTH panel showing the mechanism's interior.

**The barrier was extended.** `@/core/gimbal` is unreachable from the tracking
side by alias, relative path and type-only import, verified by running the real
ESLint configuration over probe files. `@/core/contracts/gimbal` stays
reachable, because a controller legitimately needs to issue commands and to know
the travel it must work within.

### Verification

| Check             | Result                        |
| ----------------- | ----------------------------- |
| `pnpm format`     | clean                         |
| `pnpm lint`       | 0 errors, 0 warnings          |
| `tsc -b --force`  | 0 errors                      |
| `pnpm test`       | 617 passing, 33 files         |
| `pnpm build`      | succeeds                      |
| Manual (dev host) | all 11 scenarios load and run |

103 tests were added. The integrator is checked against the **closed-form**
second-order step response rather than against a recorded trajectory, which is
the only check that can tell whether the model does what the differential
equation says.

### Measured accuracy

Peak transient error against the closed form, as a fraction of the commanded
step, at ω·dt = 0.251 (8 Hz servo, 200 Hz tick): 12% at ζ = 0.3 falling to 6.5%
at ζ = 1.5. Steady-state error is zero to machine precision; the error is
first-order in the step (measured convergence ratios 2.05, 2.02, 2.01 over three
halvings) and proportional to the step size. At ω·dt = 0.0063 it is under 0.3%.

These numbers are stated rather than hidden. A model whose error nobody has
measured is not a model. Full table in [GIMBAL_MODEL.md](GIMBAL_MODEL.md).

### Measured cost

Median of five runs of 200,000 ticks on the development machine: mount alone
0.25 µs/tick, engine tick 0.19 µs, engine plus a 640×480 camera at 60 FPS
3.59 µs. The tick budget at 200 Hz is 5000 µs.

### Two defects found and fixed while building this

1. **The store leaked frame leases.** `stepOnce` captured a frame through
   `captureLatest` and then captured the same instant again through the snapshot
   helper, leaking the first lease and inflating the frame counters. The new
   lease model turned a silent aliasing bug into a loud one, which is what it is
   for.
2. **Jogging lost presses.** A relative command measured from the _applied_
   setpoint meant that every press inside one latency window requested the same
   angle, so six presses moved one step. It now accumulates from the latest
   requested position, clamped to travel so jogging into a stop cannot wind up.

### Limitations

1. **No detector, filter, controller or tracking of any kind.** Nothing reads
   the pixels. This remains the specified scope; the mount is pointed by hand.
2. **The disturbance hook is always zero.** `advanceTo` takes a
   `GimbalDisturbance` and nothing generates a non-zero one. The hook exists so
   base motion and wind loading can be added without reshaping the call path.
3. **No friction model.** No stiction, Coulomb friction or breakaway torque. The
   deadband is a crude stand-in for the _pointing consequence_ of stiction, not
   a model of it.
4. **No structural flexibility, thermal drift, gravitational sag or unbalanced
   load.** The load is rigid apart from the backlash gap.
5. **No motor model.** No current loop, back-EMF, torque ripple or cogging;
   `maxAcceleration` stands in for all of it.
6. **No encoder faults.** No bias, non-linearity, missed counts or eccentricity.
   Quantisation only.
7. **No axis cross-coupling.** Pan and tilt are fully independent; a real
   two-axis mount has inertial coupling.
8. **Reporting is instantaneous.** Only _command_ latency is modelled; there is
   no measurement transport delay.
9. **Sub-tick latency changes the discrete response.** Splitting a tick at a
   command's exact due time gives unequal sub-steps, so a run with latency is
   not bit-identical to the same run without it. That is inherent to
   representing a delay exactly; it remains fully deterministic.
10. **The transient error above is not small.** At the bundled 200 Hz tick and
    an 8 Hz servo it is several percent of a step. It is first-order in the
    tick, so a scenario needing better can have it.
11. **Everything inherited from Phase 2 still applies** — ideal noiseless
    sensor, no link budget, no occlusion, no `mono16`, canvas drawing untested
    in jsdom.

### Next

Phase 4 — the first autonomous closed loop. See below.

---

## Phase 4 — First autonomous closed-loop coarse PAT

**Complete.**

The loop is closed. Nothing in Phases 0–3 read the pixels; now something does,
and what it decides moves the mount, and the mount moving changes the pixels.

### Preflight: the actuator was not accurate enough

Before tuning any controller, the phase required the numerical quality of the
**shipped** gimbal profiles to be measured against the closed-form response.
All three failed the 5% gate:

| Profile                            | ω·dt  | Peak error | RMS transient | Settling difference |
| ---------------------------------- | ----- | ---------- | ------------- | ------------------- |
| Near-ideal (12 Hz, ζ = 0.9)        | 0.377 | **13.3%**  | 7.0%          | +10 ms              |
| Realistic-lab pan (6 Hz, ζ = 0.65) | 0.189 | **7.3%**   | 3.4%          | −10 ms              |
| Realistic-lab tilt (5 Hz, ζ = 0.7) | 0.157 | **5.9%**   | 2.8%          | −20 ms              |

A controller tuned against that plant would have been compensating for the
integrator rather than the mechanism, and its gains would have been wrong at any
other tick rate.

The unsaturated step is now taken in **closed form** — the matrix exponential of
the second-order system, which is exact rather than convergent. Error fell to
~4 × 10⁻¹⁴% on every profile, in every damping regime, at every step size, with
zero settling-time difference. The clamped Euler path is retained for saturated
intervals, where the system is genuinely nonlinear. The plant was **not**
softened to make tracking easier: nothing about its bandwidth, limits, deadband,
backlash or encoder changed. See
[ADR-0012](adr/0012-exact-servo-discretisation.md).

### What was built

**A real detector** on GRAY8 pixels: threshold, 8-connected components by
iterative flood fill, per-component area, peak, background-subtracted integrated
intensity, bounding box and intensity-moment sub-pixel centroid. Selection is
the strongest total signal — purely image-based, no identity.

**Pixel to bearing** by inverse pinhole, rotated into world ENU with the
**measured** mount pose. Round-trip against the simulator's own optics is exact
to better than 1e-9 rad; with a quantised pose the bearing carries exactly the
encoder error, and that error is not corrected.

**A constant-velocity Kalman filter** over (azimuth, elevation, and their
rates), with the standard white-noise-acceleration Q, Joseph-form covariance
update, enforced symmetry, shortest-arc azimuth innovation, timestamp-derived
dt, and sub-stepped long gaps.

**A PID outer loop** around the mount's existing position servo, with
conditional-integration anti-windup, a hard integral cap and a filtered
derivative. It outputs a correction to the commanded angle, never a torque or a
rate, and never bypasses the actuator.

**A deterministic raster search** with no target prior, advancing only on
measured position, measured rate and dwell, with a simulated-time waypoint
timeout so a deadband cannot stall it.

**SEARCH / TRACK / LOST** — and no more. `PATMode` gained a `lost` member so the
baseline can report where it is without claiming the predictive recovery
`reacquire` describes.

**A closed-loop runtime** that owns causality: it advances the world only as far
as the next frame, delivers every frame in capture order, stamps the command
with the time the request actually existed, and releases the frame lease in a
`finally`. The algorithm returns an **intent** with no timestamp and never holds
the mount. See [ADR-0013](adr/0013-command-intent-and-issue-time.md).

**Three bundled PAT scenarios**, and Mission Control controls to hand the mount
to the tracker, watch its detections on the sensor feed, and take it back.

### Verification

| Check                  | Result                                |
| ---------------------- | ------------------------------------- |
| `pnpm format`          | clean                                 |
| `pnpm lint`            | 0 errors, 0 warnings                  |
| `tsc -b --force`       | 0 errors                              |
| `pnpm test`            | 798 passing, 41 files                 |
| `pnpm build`           | succeeds                              |
| `cargo fmt` / `clippy` | clean                                 |
| Manual (desktop app)   | all 17 demo steps, truth overlays off |

177 tests added.

### Measured results

Judged from outside with privileged truth the algorithm never sees. Error is the
beacon's true distance from the principal point, from 3 s after acquisition.

| Scenario                     | Acquired | Modes                          | Visible | Median  | p95     |
| ---------------------------- | -------- | ------------------------------ | ------- | ------- | ------- |
| `pat-stationary-outside-fov` | 12.0 s   | SEARCH → TRACK                 | 100%    | 0.48 px | 4.28 px |
| `pat-moving-target`          | 26.0 s   | SEARCH → TRACK                 | 100%    | 0.19 px | 3.20 px |
| `pat-loss`                   | 0.02 s   | SEARCH → TRACK → LOST → SEARCH | 8.2%    | 2.27 px | 5.52 px |

The stationary median is slightly _worse_ than the moving one. That is real: on
a stationary target the loop settles into a small limit cycle driven by the
mount's deadband and backlash, while on a constant-velocity target the integral
settles into a steady lag that happens to sit nearer centre.

Per-frame cost at 640×480: detector 0.97–1.05 ms, whole path 1.02 ms mean and
1.15 ms p95, against a 16.67 ms frame period — about 6% of budget. No case for
Rust, WASM or OpenCV at this resolution.

### Bugs found while building this

1. **The runtime's issue time depended on batch size.** Advancing ten ticks and
   then processing the frames inside that span handed the mount every command
   late by the batch, so the same scenario behaved differently headless and on
   screen. The runtime now walks frame by frame; a test compares batched against
   single-tick execution and requires identical frames, modes, command ids and
   world state hash.
2. **The exact servo step could exceed the acceleration limit mid-step.**
   Checking the demand only at the start of the interval let the linear solution
   ask for more than the mechanism has on the step where a fast axis comes out
   of saturation. Two further checks — the mean acceleration implied and the
   demand at the far end — close it.
3. **`@/scenarios` was reachable from the algorithm side.** A bundled scenario
   contains the target trajectories in full; an algorithm that could load one
   would not need to track anything. Now barred, with a probe test.

### Known weaknesses of the baseline

Recorded because the robust phase needs a real baseline to beat, not a flattered
one.

1. **The brightest blob wins.** No beacon identity: anything brighter and
   compact captures the tracker. A test asserts exactly this failure.
2. **Acquisition is slow** — tens of seconds for a blind raster over a large
   region. No uncertainty weighting, no prior.
3. **Recovery is nothing.** LOST discards the track and restarts the scan from
   the beginning.
4. **The constant-velocity model lags a manoeuvre**, trailing through the
   fastest part of a crossing pass.
5. **No feed-forward**, so a constant-rate target sits at a steady offset that
   only the integral slowly removes.
6. **No measurement gating.** A single wrong detection is folded straight in;
   the NIS is computed and reported but not used to reject.
7. **One track.** No association; a second bright object is ignored or steals
   the track.
8. **Fixed detector thresholds.**

### Limitations

1. **The sensor is still ideal and noiseless**, so the measured centroid
   accuracy is a best case. Camera noise arrives in a later phase.
2. **No compute-time model.** Algorithm latency is zero once a frame is
   available; only the mount's command latency is modelled.
3. **`snr` is reported as 0 dB** because no noise model exists to compute it
   from. It is not an invented figure.
4. **Azimuth wrapping is exercised by unit tests only.** No bundled scenario
   crosses ±π, though the mount's ±170° pan travel includes it.
5. **`estimatedPointingError` is the tracker's own belief**, not the true error.
   An over-confident filter reports a small number here while missing badly;
   detecting that gap is evaluation's job and evaluation does not exist yet.
6. **Interactive playback with autonomy engaged runs below the requested speed
   multiplier** on this machine — the per-frame React re-render, not the loop,
   is the bottleneck. The engineering result is unaffected and this is proved:
   headless and irregular interactive cadence produce identical frames, modes,
   command ids and state hash.
7. **Everything inherited from Phases 2 and 3 still applies** — no link budget,
   no occlusion, no `mono16`, no actuator disturbance, friction or
   cross-coupling.

### Deliberately not implemented

IMM or constant-acceleration estimators, coded beacon authentication, CNN/ONNX
verification, adaptive uncertainty-aware recovery, atmospheric disturbance,
camera noise, FailureHunter, AstraBench, MPC, hardware-in-the-loop, an
experiment recorder or report generator, and the robust
SEARCH/ACQUIRE/TRACK/RECOVER/HANDOFF architecture. All belong to later phases.

### Next

Phase 5 — the robust tracker. Do not begin it without an explicit request.

---

## Phase 5 — Experiment recorder, KPI engine and performance reporting

**Complete.**

Closed-loop runs are now records. A run writes a versioned manifest, snapshots of
the exact scenario and algorithm configuration, an ordered event log, safe
telemetry and privileged evaluation samples; its summary and an offline HTML
report are computed **from those files**, and can be recomputed and verified
from them. See [EXPERIMENTS.md](EXPERIMENTS.md), [METRICS.md](METRICS.md),
[REPORTING.md](REPORTING.md) and ADRs
[0014](adr/0014-evaluation-reads-truth-one-way.md),
[0015](adr/0015-persisted-raw-data-is-the-source-of-truth.md),
[0016](adr/0016-host-time-is-not-simulated-time.md).

### Preflight: false placeholder values

`TargetObservation.snr` (0 dB), `GimbalState.latency` (0 s) and
`GimbalState.encoderHealth` (1) reported physical values for effects that are
not simulated. All three are now `Measurement`s with status `not-modelled`, and
Mission Control shows SNR as "Not modelled".

### What was built

- **`LoopObserver` seam** on `ClosedLoopRuntime`: attachable and detachable
  without rebuilding the algorithm; per-frame host timings that partition the
  loop iteration; actual command application instants from a bounded mount log.
- **Write-only `StageProfiler`** in the plugin contract; the baseline reports
  detector, bearing transform, estimator and controller time without ever
  seeing a duration.
- **`ExperimentRecorder`**: explicit lifecycle, change-only event log, bounded
  batches, byte-based backpressure, immediate failure reporting, atomic
  manifest/summary/report writes, `created`/`running` on disk until the final
  step.
- **`Evaluator`**: stable `atan2(|a×b|, a·b)` angular pointing error, image-space
  error, detector centroid error, within-travel, other emitters in view — no
  thresholds in the raw data.
- **Streaming KPI engine** (`SummaryBuilder`, `LockAnalyser`): acquisition
  milestones, dwell/grace coarse lock, retention with an explicit denominator,
  censored loss episodes, false lock with an exercised flag, three sample
  windows, frame rates, simulated control latency, host stage timings.
- **Recompute and rescore**: one summarising path from files; cold
  recomputation compares every field; snapshots are fingerprint-checked;
  rescoring under another definition yields a separately fingerprinted result.
- **Offline `report.html`** with the SIH performance log, provenance, config,
  statistics, seven data-driven SVG plots and the metric definitions.
- **Storage**: `MemoryStorage`, `NodeFileStorage`, and `TauriStorage` over narrow
  Rust commands confined to `<app data>/runs/<run id>/`, with streaming chunked
  reads, fsync'd atomic writes, open-folder and open-report.
- **Mission Control** Record / Stop & finalise / Abort, real counters, hideable
  EVALUATION readout, confirmations before reset, scenario change or autonomy
  off; the emergency stop never asks.
- **Reports screen**: every run with status (COMPLETED, ABORTED, FAILED,
  INCOMPLETE), headline results, details, open report, open folder, recompute &
  verify, delete with confirmation. Nothing editable.

### Verification

| Check                          | Result                                                    |
| ------------------------------ | --------------------------------------------------------- |
| `pnpm format:check` / `lint`   | clean                                                     |
| `pnpm typecheck`               | 0 errors                                                  |
| `pnpm test` (main pass)        | 970 tests in 53 files, including 38 type-level tests      |
| `pnpm test` (performance pass) | 10 tests in 3 files, run sequentially after the main pass |
| `pnpm build`                   | succeeds                                                  |
| `cargo fmt` / `clippy` / tests | clean / clean / 5 passing                                 |
| Desktop app                    | see below                                                 |

Mandatory properties, each a test: recording on vs off identical (two scenarios,
plus slow-disk backpressure and writer failure); cold offline recomputation with
zero differences, plus agreement with an independent `acos` oracle and detection
of four kinds of tampering; interrupted runs never trusted, including one that
died after writing its summary; reproduction from saved files matches the
recorded commands, transitions, final encoder reading and end-state hash; a
120 s run stays bounded (peak queue = mark + one batch), loses no rows, keeps
order, grows linearly and recomputes.

**Desktop application.** Run in the real Tauri app on macOS through the real
store, `TauriStorage` and Rust commands: stationary-outside-FOV recorded at 4×
with live counters rising (events, frames, bytes written, queue 0, no
backpressure) and the live readout going from not locked to LOCKED; finalised
to COMPLETED; the Reports screen listed it with status, duration 26.3 s,
acquisition 16.05 s, retention 100 %; the in-app Recompute & verify reported
every field reproduced; a second run aborted to ABORTED with no summary or
report on disk; artifacts under
`~/Library/Application Support/dev.astralock.x/runs/` inspected and consistent.
Recording in a plain browser tab refuses with a visible error and no console
errors. The interrupted-run, hidden-evaluation, SNR "Not modelled" and
confirmation flows are covered by the UI tests against the real store; they were
not clicked by hand in the native window, because no automation reaches a
WKWebView on macOS.

### Measured results

Validation records, not benchmarks: see [METRICS.md](METRICS.md#validation-results).
Recorder overhead +3.1 % (median of three interleaved runs); writer alone
~240 MB/s; finalisation ~120 ms for 30 s; raw record ~1.25 KB per frame.

### Bugs found while building this

1. **Starting or stopping a recording reset the tracker.** The store rebuilt the
   runtime to attach a recorder, constructing a fresh algorithm.
2. **"Recompute" was circular**: it read the metrics config, frame count and
   target count from the summary it verified, and exempted host timings.
3. **Recorder memory was unbounded**: every sample was retained.
4. **"Detector" host time was a copy of total algorithm time; "orchestration"
   timed one property read.**
5. **First detection was tied to TRACK entry** and ignored target association.
6. **Per-frame event noise**: a `detection-missed` on every search frame and a
   `mechanical-limit` on every frame at a stop.
7. **`createdAt` was rewritten on every manifest write.**
8. **The lock threshold was baked into `evaluation.csv`**, preventing rescoring.
9. **Effective FPS read 60.025 for a 60 fps camera** (closed-window fencepost).
10. **Every report said INCOMPLETE**: rendered before the final manifest flip.
11. **µrad rendered as "ΜRAD"** by CSS uppercasing, reading as milliradians.
12. **`-0` and `0` fingerprinted differently**, the opposite of the documented intent.
13. **A writer failure never reached the manifest or the UI** until the next
    `advance()` — not on `stepOnce`, and never while paused.
14. **The live readout showed the previous recording's lock** after starting a new one.
15. **Provenance claimed a commit for uncommitted code**; now `sourceTreeModified`.
16. **WKWebView's 1 ms timer** made sub-millisecond host stages read 0; the
    resolution is now measured and stated in the manifest and report.
17. **Wall-clock tests failed under contention** with the new suites; they now
    run in a separate pass. A first attempt with Vitest projects silently stopped
    running the type-level isolation tests, and was replaced.
18. **An aborted run wrote `summary.json`** (found earlier in the phase).

### Known limitations

- Finalisation memory grows with run length (~120 B per frame of statistic
  samples); the live recording itself is bounded.
- Host timings in the desktop app are quantised to 1 ms.
- Frame-rate figures are counts over a window and can exceed the configured rate
  by up to 1/T.
- One designated target; every bundled scenario has one emitter, so false lock
  is reported as not exercised.
- Closing the app mid-recording leaves an INCOMPLETE run by design; no
  last-moment abort is attempted.
- Rust command handlers are tested through their pure helpers; the IPC layer is
  exercised by the desktop run, not by an automated Tauri test.
- The Phase 0 placeholder types in `contracts/experiments.ts` and
  `contracts/telemetry.ts` are unused and not yet reconciled with the Phase 5
  schema.

### Not started at the Phase 6 checkpoint

No IMM, constant-acceleration model, beacon identity, AI verifier, adaptive
search, predictive recovery, handoff, feed-forward control, disturbances, sensor
noise, AstraBench, FailureHunter, replay, HIL or UI redesign was added.

## Phase 6 — Robust AstraLock-X reference PAT engine

**Complete.**

A second real algorithm, `astralock-x`, runs alongside the Phase-4 baseline. The
baseline was not modified, replaced or "upgraded in place": it is kept as a
scientific control, and both are selectable at runtime so every claim below is a
paired comparison on identical physics. See
[ASTRALOCK_PAT.md](ASTRALOCK_PAT.md) and ADRs
[0017](adr/0017-interacting-multiple-model-estimation.md) and
[0018](adr/0018-prediction-to-actuation-and-recovery.md).

### What was built

- **States** SEARCH → ACQUIRE → TRACK ⇄ RECOVER → HANDOFF, against the
  baseline's scan → track → lost.
- **Acquisition validation**: a candidate must survive a persistence window,
  supporting observations, a bearing-displacement bound and a mean-NIS check
  before TRACK. The baseline commits on the first detection.
- **IMM estimator**: six-state, nearly-constant-velocity and
  nearly-constant-acceleration models, full mixing, log-domain likelihoods, and
  a fused covariance that includes between-model dispersion.
- **Gating**: chi-square innovation gate plus an independent hard angular
  radius, with separate thresholds for TRACK and RECOVER.
- **Latency-aware control**: the state is predicted forward by
  `commandLatency + servoLag` — a configured horizon, never a measured host
  time — and the controller adds motion feed-forward to feedback without
  double-counting.
- **Predictive RECOVER**: the estimate coasts through missing measurements and
  the mount is pointed where the target is predicted to be, with an
  uncertainty-scaled local search, instead of restarting a global sweep.
- **Coarse-to-fine HANDOFF readiness** with an explicit dwell, and an
  evaluator verdict on that claim that plays no part in making it.
- **FOV-aware search** with measured coverage, an optional prior, and a
  coverage-gap assertion.
- Five new scenarios, recorder/metrics/report support for the new states
  (metrics definition v2), and algorithm selection in Mission Control.

### Ground-truth isolation

Unchanged and re-proved for the new algorithm: the ESLint import barrier now
also covers `src/core/algorithms/astralock/**`, and the phase adds 17 isolation
tests including a blank-pixel anti-cheat run in which the tracker must fail to
acquire.

### Measured results

Paired, identical physics, post-acquisition angular RMS. Full table with method
and caveats in [ASTRALOCK_PAT.md](ASTRALOCK_PAT.md#measured-results).

| Scenario   | Baseline | AstraLock-X | Retention (base → robust) |
| ---------- | -------- | ----------- | ------------------------- |
| stationary | 172 µrad | 158         | 1.000 → 1.000             |
| moving     | **167**  | 209         | 1.000 → 1.000             |
| manoeuvre  | 371      | **297**     | 1.000 → 1.000             |
| short loss | 422590   | **39275**   | **0.127 → 0.871**         |
| handoff    | 193      | **168**     | 1.000 → 1.000             |

Acquisition is about twice as fast on every scenario, but that is FOV-aware
search spacing rather than the estimator. **The robust algorithm is honestly
worse on the constant-velocity scenario** — 209 µrad against 167 — because a
six-state filter estimating an absent acceleration has more freedom to be wrong.
That is the price of the loss-recovery behaviour, which is the result the phase
exists for: an order of magnitude in RMS and seven-fold in retention.

IMM behaviour: NCA probability 0.07 steady, peaking at 0.79 during the
manoeuvre. Cost 0.81 ms per frame against the baseline's 0.63, on a 16.67 ms
budget; the IMM cycle itself is 61 µs.

### Bugs found while building this

1. **`ncvResidualAccelerationStdDev` had no effect at all.** The NCV transition
   matrix zeroes the acceleration row, so the parameter only inflated an unused
   state. Renamed and documented as what it actually is: a numerical floor that
   keeps the covariance block invertible for mixing.
2. **The CA model could never win.** The first jerk density made the NCA
   likelihood so broad that the probabilities sat at the transition matrix's
   stationary distribution whatever the target did. Found by sweep, retuned, and
   the sweep recorded rather than left as folklore.
3. **Three scenarios did not exercise what they claimed.** The "manoeuvre" was
   invisible frame-to-frame, the "loss" was a climb the mount simply followed,
   and a later loss excursion outlasted the recovery timeout. All three were
   redesigned in bearing space against the mount's actual rate limits.
4. **Switching algorithm mid-run stopped the control loop** with `Tick count
must be a non-negative integer, received -5200`. The replacement runtime
   began frame accounting at time zero and asked the engine to step backwards
   over frames the previous runtime had already consumed. Found by flying the
   application, not by a test.
5. **A negative animation-frame delta could kill playback permanently.** The
   callback's timestamp is when the browser began the frame, which can precede
   the `performance.now()` reading taken when the driver started; the resulting
   negative elapsed time was rejected, and the throw escaped before the next
   frame was requested. Found in the browser console during manual validation.
6. **The published results table was measured unfairly.** Its window was sized
   for AstraLock-X and ended while the baseline was still converging, so it
   reported baseline errors an order of magnitude too large and overstated the
   improvement. Remeasured over windows long enough for both arms.

### Verification

| Check                          | Result                                                    |
| ------------------------------ | --------------------------------------------------------- |
| `pnpm format:check` / `lint`   | clean                                                     |
| `pnpm typecheck`               | 0 errors                                                  |
| `pnpm test` (main pass)        | 1162 tests in 66 files                                    |
| `pnpm test` (performance pass) | 15 tests in 4 files, run sequentially after the main pass |
| `pnpm build`                   | succeeds                                                  |
| `cargo fmt --check` / `clippy` | clean, `-D warnings`                                      |
| `cargo test`                   | 5 passed                                                  |

### Known limitations

- The IMM costs accuracy on targets that never accelerate; see the moving row
  above. It is the wrong estimator for a link whose targets are always inertial.
- HANDOFF readiness is a claim about the coarse loop's own state. No fine
  pointing stage exists, so nothing consumes it.
- Recovery is bounded by a timeout; a loss longer than it falls back to SEARCH,
  which is correct but means the recovery advantage has a horizon.
- Manual desktop validation was performed against the dev view at
  `localhost:1420` — identical frontend, store and algorithm code — because no
  automation available here can drive a native macOS WKWebView. Experiment
  recording cannot run there at all: browser storage is `UnavailableStorage` and
  the app says so rather than pretending. The record → finalise → report →
  recompute chain was therefore validated headlessly against `NodeFileStorage`
  on real files, which exercises the same recorder, metrics, report and
  recompute code the desktop uses, and by the automated suites. The Tauri IPC
  layer itself remains covered only by its pure helpers.

### Not started

No coded beacon identification, AI/ONNX verifier, AstraBench batch
benchmarking, FailureHunter, replay, HIL or final UI redesign had been added.

## Phase 7 — physically parameterized disturbance engine

Phase 7 adds deterministic, **camera-observable** platform, optical, sensor and
frame-transport disturbances to physical scenario schema v5. The clean scenario
path remains the original Phase 6 rasterizer; historical v4 scenarios migrate
to an explicit clean configuration and remain recomputable.

The implemented chain is: base attitude and apparent angular wander; path
attenuation and correlated scintillation; finite-exposure integration, PSF
broadening and background; shot/read noise, clipping and GRAY8 quantisation;
then true missing-frame transport dropout. Clutter is represented by real scene
emitters. Algorithms receive only legitimate camera frames and measured
gimbal-relative pose—never a realization, SNR or truth state. The evaluator has
a separate one-way truth tap for metrics and reports.

Seven disturbed scenarios cover normal and extreme vibration, low contrast,
bursty loss, easy and plausible decoys, and combined stress. The hard-decoy
scenario deliberately demonstrates that the existing non-identity algorithms
can false-lock; no Phase 7 algorithm change conceals that weakness.

### Local Phase 7 verification

| Evidence                                                    | Result                                                                                                                    |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Clean-mode regression                                       | 13 passed                                                                                                                 |
| Contracts, stochastic processes, optics and image formation | 122 passed                                                                                                                |
| Paired closed-loop disturbance scenarios                    | 20 passed                                                                                                                 |
| Five declared seeds across low contrast and combined stress | 9 passed                                                                                                                  |
| Throughput and bounded-memory checks                        | 10 passed                                                                                                                 |
| TypeScript format, lint, typecheck and production build     | passed locally                                                                                                            |
| Rust `fmt --check`, Clippy `-D warnings`, and tests         | passed locally; 5 Rust tests                                                                                              |
| Native macOS executable and `.app`                          | built and launched locally                                                                                                |
| macOS DMG                                                   | produced with Tauri's generated non-GUI packager; Finder cosmetic scripting is unavailable to this automation environment |

The detailed model, assumptions and explicitly excluded full-wave-optics claims
are in [DISTURBANCE_MODEL.md](DISTURBANCE_MODEL.md). The local completion commit
and pending remote-CI status are recorded in
[OVERNIGHT_STATUS.md](OVERNIGHT_STATUS.md).

## Phase 8 — coded optical beacon identity and false-lock resistance

Phase 8 gives a beacon a camera-observable temporal identity and gives the
tracker a way to recognise it. A target's beacon may carry an `identityCode` —
a binary sequence, a symbol duration, a phase offset and two emitted levels —
and the simulator modulates that emitter's intensity accordingly. The
modulation reaches an image the way light does: integrated exactly over the
exposure, never sampled at an instant.

AstraLock-X keeps a bounded brightness history for every blob the detector
reports, joined across frames **by bearing** rather than by pixel position, and
correlates each history against the exposure-integrated shape of the pattern it
has been configured to expect. The correlation is normalised, so a brighter
source scores no better for being brighter, and phase is recovered by a bounded
search because the transmitter's clock is not known.

**The tracker is configured with a pattern, not told an answer.** What crosses
into the algorithm is a sequence of ones and zeros and a symbol duration — a
setting, the way a radio's frequency is a setting. No emitter identifier, no
target index, no true code, no true phase and no truth of any kind reaches it,
and the anti-cheat suite holds that line: the same world with its entities
renamed produces a bit-identical run, and blank pixels produce no verdict at
all.

Identity is ranked **after** physics and never overrides it. A candidate
outside the motion gate is not where the target can be, and no correlation
rescues it; a positively refused identity removes a candidate even when it is
the only one admitted; among what remains a match outranks a non-match and the
smallest innovation breaks the tie. Starting a track requires a positive
recognition within a bounded wait, and an established track is never ended
because the evidence ran out — a beacon that stops signalling is reported as
unconfirmable, not as wrong.

Nine coded scenarios cover a clean coded target, an uncoded intruder, an obvious
decoy well off the predicted path, an
intruder sending a different code, the Phase 7 hard decoy with both sources
coded, an intruder replaying a rotation of the beacon's code, an intruder
sending the identical code at the identical phase, a beacon that stops
signalling twenty seconds in, and a coded beacon through bursty frame loss.

### What it achieves, measured

Same world, same seed, identity switched on and off; both arms scored by the
same evaluator from the same recorded files.

| Scenario             | RMS error (µrad) off → on | Retention off → on | False lock off → on |
| -------------------- | ------------------------- | ------------------ | ------------------- |
| `code-clean`         | 315 → 315                 | 1.000 → 1.000      | 0 → 0               |
| `code-decoy-uncoded` | 370 → 2 683               | 1.000 → 0.921      | 1 → **0**           |
| `code-decoy-easy`    | 315 → 315                 | 1.000 → 1.000      | 0 → 0               |
| `code-decoy-wrong`   | 498 → 2 905               | 0.975 → 0.919      | 1 → **0**           |
| `code-decoy-hard`    | 361 636 → **2 435**       | 0.235 → **0.922**  | 3 (24.4 s) → **0**  |
| `code-ambiguous`     | 361 636 → 15 574          | 0.235 → 0.831      | 24.4 s → 0.4 s      |
| `code-identical`     | 361 635 → 361 635         | 0.235 → 0.235      | 24.4 s → 24.4 s     |
| `code-insufficient`  | 315 → 453                 | 1.000 → 0.963      | 0 → 0               |
| `code-frame-loss`    | 5 066 → 5 066             | 0.726 → 0.726      | 0 → 0               |

The `code-decoy-hard` result holds on all five declared seeds, not only on the
median. Identity costs 0.02–0.16 ms per frame against a 16.67 ms budget, and
0.061 ms measured a second way as whole-loop wall clock; the cost does not grow
with run length.

### Honest limits

- **`code-identical` shows no improvement, and that is the correct result.** Two
  sources sending the same code at the same phase are the same signal from
  different objects. Identity abstains and what is left is Phase 7 behaviour.
  The run's 1 271 "wrong recognitions" are truthful: the tracker claimed the
  source it held is sending the expected pattern, and that was true of the
  decoy.
- **Removing a false lock can cost pointing accuracy.** On `code-decoy-uncoded`
  and `code-decoy-wrong` the control arm was already nearly fine, and identity
  raises RMS error from a few hundred to a few thousand microradians while
  eliminating the false lock. The cost is the merged blob: within about 1.3
  pixels of each other the two emitters are one detection carrying two
  superimposed codes, and the tracker declines a measurement it cannot
  attribute rather than accepting it.
- **A rotation of the expected code is indistinguishable to a receiver that has
  not locked phase**, which is measured at 15/15. A locked receiver separates
  them, because the rotated copy is at the wrong phase in absolute time.
- **This is recognition, not authentication.** The code is not secret and
  carries no signature, so a decoy that knows the pattern can send it and will
  be accepted. Phase 8 resists confusion; it does not resist an adversary.
- **Identity needs time** — roughly half a second of continuous observation at
  the bundled timing. A target seen more briefly is reported as
  `insufficient-evidence` rather than guessed at.
- Identity is off by default and is offered in the interface only on a scenario
  whose beacon carries a code. Enabled against an unmodulated beacon it would
  correctly, and uselessly, refuse to acquire anything.

### Local Phase 8 verification

| Evidence                                                          | Result                                                |
| ----------------------------------------------------------------- | ----------------------------------------------------- |
| Whole TypeScript suite, type tests included                       | 79 files, 1 559 tests passed                          |
| Performance suites (run separately)                               | 5 files, 27 tests passed                              |
| Code waveform, code library and correlator unit tests             | 92 passed                                             |
| Image-level identity, through the real sensor                     | 10 passed                                             |
| Identity ON/OFF ablation over nine scenarios and five seeds       | 21 passed                                             |
| Camera timing: 30/60/90 fps, and exposures that straddle symbols  | 3 passed                                              |
| Recording, cold recomputation and report rendering of a coded run | 11 passed                                             |
| Anti-cheat and isolation, including identity                      | 23 passed                                             |
| Clean-mode regression, including "identity off is Phase 7"        | 15 passed                                             |
| TypeScript format, lint, typecheck and production build           | passed locally                                        |
| Rust `fmt --check`, Clippy `-D warnings`, and tests               | passed locally; 5 Rust tests                          |
| Manual validation in the running application                      | performed against the dev view at `localhost:1420`    |
| Native macOS build                                                | **blocked**: Xcode licence not agreed on this machine |

The correlator was measured against camera timing it was not tuned for: at 30,
60 and 90 frames per second with symbols scaled to four frames each it reaches
MATCH at 0.932, 0.931 and 0.931 — nothing in the receiver counts frames, and a
design that had assumed 60 fps would have failed two of the three. A scenario
whose symbols are shorter than two frame periods is refused at load. With the
shutter open for 16 ms against a 33 ms symbol, so that a large share of
exposures span a transition, the score falls from 1.000 to 0.964 and the verdict
holds: smearing costs contrast, and a design that sampled the code at the
capture instant rather than integrating it would not have shown that fall.

Manual validation walked the identity feature end to end in the running
application, with the ground-truth overlay off:

- `code-clean`: SEARCH shows IDLE with "no candidate is being watched"; ACQUIRE
  is reached at 9.7 s and waits with NO EVIDENCE on six observations; TRACK is
  reached at 10.2 s with MATCH on 36 observations over 0.6 s, correlation 0.942.
- `code-decoy-uncoded`: the decoy enters at 17 s and the panel goes to two
  watched sources while staying MATCH on the beacon; at the crossing the merged
  blob is refused (one refusal, RECOVER), and the beacon is picked back up at
  23 s at 0.931.
- `code-decoy-wrong`: the sensor overlay marks the two sources simultaneously in
  the match and mismatch colours — the tracker is visibly refusing the decoy
  while holding the beacon.
- `code-decoy-hard`, same physics, 30 s in: identity **off** leaves the tracker
  in TRACK with a true pointing error of 323 250 µrad — following the decoy —
  and identity **on** leaves it at 51 µrad.
- `code-identical` reports AMBIGUOUS during the crossing rather than claiming to
  have separated two identical signals; `code-insufficient` reports NO EVIDENCE
  after the beacon stops signalling, never MATCH.
- With the evaluation panel hidden — "hidden, and not computed" — the tracker
  still acquires and holds with MATCH, so nothing in the demonstration depends
  on truth being on screen.
- A scenario with no coded beacon offers no identity control at all.
- The browser console carries no errors: a deprecation notice from the 3D
  library, dev-server chatter, and a canvas hint provoked by the validation
  script's own pixel readback.

Two steps could not be completed on this machine, and neither is a code
problem:

- **Experiment recording in the browser.** The application refuses it and says
  why — "Experiment recording needs the desktop application: a browser tab has
  nowhere durable to write run artifacts." The record → finalise → report →
  recompute chain was therefore validated headlessly against `NodeFileStorage`,
  which exercises the same recorder, metrics, report and recompute code the
  desktop uses, and by the automated report and reproducibility suites.
- **The native macOS build.** `pnpm tauri build` fails at the link step with
  "You have not agreed to the Xcode license agreements", after an Xcode update
  on this machine. The fix is `sudo xcodebuild -license`, which needs the
  machine owner's password. Rust formatting, Clippy with warnings denied and the
  Rust tests all pass locally, and CI builds and uploads the desktop bundle on
  Linux, macOS and Windows.

The model, the codes, the correlator, the measured results and the limits are in
[BEACON_IDENTITY.md](BEACON_IDENTITY.md); the decisions are
[ADR-0023](adr/0023-identity-is-a-configured-expectation.md),
[ADR-0024](adr/0024-code-timing-follows-the-camera.md) and
[ADR-0025](adr/0025-identity-is-evidence-not-proof.md).

### Not started

No AI/ONNX verifier, AstraBench batch benchmarking, FailureHunter, replay, HIL
or final UI redesign has been added. There is no communications modem, no link
budget and no wave-optics propagation.
