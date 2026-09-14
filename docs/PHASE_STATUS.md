# Phase status

What actually works, and what does not. Updated at the end of each phase.

| Phase | Scope                                                                | Status       |
| ----- | -------------------------------------------------------------------- | ------------ |
| 0     | Project foundation: contracts, isolation, tooling, CI, shell         | **Complete** |
| 1     | Simulation core: world, motion, seeded RNG, tick loop                | Not started  |
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

6. **The type-level reachability check is depth-limited.** `ContainsGroundTruth`
   walks nine levels; the runtime scan walks twelve. The deepest path into
   `TrackingInput` today is four, so there is ample margin, but a contract that
   nested ground truth deeper than the budget would be missed by the type check
   rather than reported. The lint barrier is unaffected by depth.

7. **Cross-platform desktop builds are unverified locally.** The macOS build is
   verified on this machine. Windows and Linux builds are wired into CI but have
   not run yet, as the repository has no push history.

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

### Next

Phase 1 — the simulation core. Do not begin it without an explicit request.
