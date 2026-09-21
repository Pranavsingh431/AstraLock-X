# Picking this up

You have just cloned AstraLock-X, or you are an AI assistant being pointed at
it. This file gets you from nothing to productive, and tells you what is left to
build and how to build it without breaking what is already true.

Read this first. Then [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## 1. What this is, in one paragraph

A desktop engineering workbench for **coarse Pointing, Acquisition and
Tracking** of mobile **Free Space Optical Communication** links. It simulates a
world (moving terminals, a pan/tilt gimbal, an optical camera, atmospheric and
platform disturbances), runs tracking algorithms against it under a strict
information boundary, records experiments, and compares algorithms
deterministically. It is a **prototype**, frozen for a submission — not flight
software, and it says so everywhere.

**Current state:** frozen at commit `d83dae3`, CI green on Linux, macOS and
Windows. 88 test files / 1 648 tests plus 30 performance tests. Ten development
phases are complete; [docs/PHASE_STATUS.md](docs/PHASE_STATUS.md) is the
honest ledger of what each one delivered and what it did not.

---

## 2. Run it

### Prerequisites

Node 24 LTS, Corepack, and [rustup](https://rustup.rs). Versions are pinned by
the repository — `.nvmrc`, `packageManager`, `rust-toolchain.toml` — so nothing
needs choosing. Full per-platform list, including the Linux `apt` packages, is
in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

`engine-strict=true` is set, so an unsupported Node fails the install
immediately with a clear message rather than breaking later in a stranger way.

```bash
corepack enable
pnpm install --frozen-lockfile
```

### Two ways to run it

```bash
pnpm tauri:dev   # the real desktop application
pnpm dev         # frontend only, http://localhost:1420
```

The React frontend is identical in both. **The difference that matters is
durable storage**: recording experiments and running benchmarks write run
artifacts to disk, which only the Tauri build can do. In a browser tab the
Reports and AstraBench workspaces correctly report that they need the desktop
application, and disable themselves rather than pretending.

So: use `pnpm dev` for UI work, and `pnpm tauri:dev` when you touch experiments,
reports or benchmarks.

### Confirm the checkout is healthy

```bash
pnpm verify
```

That is format check, lint, typecheck, the full test suite (including type
tests), the performance suite run serially, and a production build — the same
sequence CI runs. It takes a few minutes. If it passes, your checkout matches
what was shipped.

---

## 3. What you are looking at

```
src/
  core/             the engineering. No React, no DOM, no browser.
    contracts/      types, units, the algorithm plugin interface, the truth boundary
    simulation/     seeded PRNG, fixed-tick engine, trajectories
    sensors/        the virtual optical camera
    gimbal/         servo dynamics, latency, backlash, encoder
    disturbance/    platform vibration, atmosphere, sensor noise, frame loss
    perception/     detector: threshold, components, centroid, SNR
    estimation/     Kalman and IMM filters
    control/        PID and the command pipeline
    pat/            the PAT state machine
    algorithms/     the two trackers, behind the plugin contract
    metrics/        KPI definitions — PRIVILEGED, reads ground truth
    experiments/    recorder, storage, recompute, reporting
    benchmark/      AstraBench: suites, runner, fairness, aggregation
    runtime/        the closed loop that ties it together
  features/         one folder per workspace (mission-control, astrabench, …)
  components/
    astra/          the design system: Panel, MetricReadout, StatusBadge, …
    ui/             shadcn primitives, restyled
    shell/          nav rail, title bar, status bar
  stores/           Zustand: simulation-store, navigation-store
  scenarios/        35 bundled scenario definitions
src-tauri/          the Rust desktop shell. Small: storage and window plumbing.
docs/               subsystem documentation and 25 ADRs
artifacts/sih/      generated submission evidence — screenshots and raw JSON
```

**Read it in this order** if you want to actually understand it:

1. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — how the pieces fit
2. [ADR-0003](docs/adr/0003-ground-truth-isolation.md) — the boundary everything
   else rests on
3. [docs/SIMULATION.md](docs/SIMULATION.md) — the world, and what is _not_
   modelled
4. [docs/ALGORITHM_PLUGIN.md](docs/ALGORITHM_PLUGIN.md) — what a tracker
   receives and what it cannot reach
5. [docs/METRICS.md](docs/METRICS.md) — every KPI's formula, denominator and
   N/A rule

The 25 ADRs in [docs/adr/](docs/adr/) record _why_ things are the way they are.
When something looks odd, there is usually an ADR explaining that it is
deliberate. Read it before changing it.

---

## 4. Five invariants. Do not break these.

These are not style preferences. They are what makes the numbers this project
produces worth anything, and each is enforced by machinery rather than by
goodwill.

### 4.1 A tracking algorithm cannot see ground truth

A tracker receives exactly six things: `tick`, `time`, `frame`, `camera`,
`gimbal`, `previousCommand`. Nothing else. No target position, no true bearing,
no emitter identity, no disturbance realization.

Enforced five ways: compile-time proofs, a `defineAlgorithm` admission check, an
ESLint import barrier, a runtime `guardTrackingInput`, and `.test-d.ts`
type-level proofs. The test suite asserts the exact key set and that no key
matches `/engine|world|truth|evaluat|scenario|target|emitter|disturb/i`.

If you are working in `core/algorithms`, `core/perception`, `core/estimation`,
`core/control` or `core/pat`, lint will refuse the import. **That is the design.**
If you need a quantity you cannot reach, the question is _how would a real
terminal measure this?_ — not _how do I get past the barrier?_

### 4.2 Everything is deterministic

No `Date.now()`, `performance.now()` or `Math.random()` in anything affecting
simulation state. `Math.random` is blocked by lint. Each stochastic subsystem
draws from its own seeded stream, so adding noise in one place does not silently
change results elsewhere. Disturbance randomness is indexed by frame
([ADR-0020](docs/adr/0020-disturbance-randomness-is-indexed-by-frame.md)), so
the same scenario and seed produce the same world on any machine, in any run
order.

Same seed, same scenario, same numbers. If that stops being true, something is
badly wrong.

### 4.3 Nothing displayed is fabricated

Every number on screen came from a computation that ran. A panel with no data is
empty and says why it is empty. A quantity the system does not model reports
`null` — rendered as an em dash — never a plausible zero.

There is deliberately no aggregate "system health" percentage: the application
has no basis for one, and a single figure over seconds, microradians and a
retention fraction would be invented.

### 4.4 Units are typed, and always shown

Physical quantities use the branded types in `core/contracts/units.ts`.
Construct with `radians(x)`, `meters(x)` — do not cast. Radians are canonical
internally; degrees appear only at configuration and display boundaries. Every
value shown in the UI carries its unit.

### 4.5 Metric definitions are versioned

Metrics carry a definition version (currently **v3**) and a fingerprint. If you
change what a metric means, you bump the version — you do not silently
redefine it, because old recorded runs would then be compared against a
different question. [docs/METRICS.md](docs/METRICS.md) has the rules.

---

## 5. Traps that will cost you an hour

**Rust may not link on macOS.** If `cargo check` fails with _"You have not
agreed to the Xcode license agreements"_, run `sudo xcodebuild -license` and
accept. Until you do, `pnpm tauri:dev` and every `cargo` command except
`cargo fmt` will fail at the link step. This blocked desktop-build work through
Phases 8–10; the frontend was used instead.

**Performance tests must run serially.** They assert wall-clock budgets, so
running them alongside eighty-odd other files measures contention rather than
code. `pnpm test` already separates them. If a `performance.test.ts` fails,
re-run it alone before believing it.

**Resizable panels register once per group.** `react-resizable-panels` builds its
constraint table at mount. Conditionally rendering a panel into a live group
leaves that table stale and throws `Panel constraints not found for index N`.
Mission Control remounts the centre group with a `key` when the panel set
changes. If you add a conditional panel to any group, do the same.

**jsdom measures everything as 0×0 at the origin.** That makes every
`react-resizable-panels` separator hit-test match every click, which suppresses
the `mousedown` that Radix tabs select on. `selectTab` in `src/test/setup.ts`
dispatches it directly. It is a test-environment artefact, not an application
bug.

**Node must be 24.** If you use a version manager, `nvm use` reads `.nvmrc`.

---

## 6. What is left

Nothing here is started. Each is genuinely deferred scope, not a half-finished
thing — the two workspaces that exist for deferred features render an honest
"FUTURE WORK" panel rather than a broken tool.

Roughly in order of value for effort:

| #   | Work                            | Why it matters                                                                                                                                                                            | Where to start                                                                             |
| --- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 1   | **Replay**                      | The event log is already recorded. Stepping a completed run against it, with the tracker's state beside ground truth at any tick, is the cheapest big win — most of the machinery exists. | `src/features/replay/`, [docs/EXPERIMENTS.md](docs/EXPERIMENTS.md) for the artifact format |
| 2   | **Calibration**                 | Intrinsics and camera-to-gimbal alignment are currently _configured_. Estimating them from observations closes a real gap between this and a deployable terminal.                         | `src/features/calibration/`, [docs/SENSOR_MODEL.md](docs/SENSOR_MODEL.md)                  |
| 3   | **Larger statistical suite**    | Five seeds is a small sample and the docs say so. More seeds plus significance testing would make the comparisons quotable.                                                               | `src/core/benchmark/suites.ts` — add a suite; seeds are declared in source on purpose      |
| 4   | **Operating-envelope explorer** | Sweep disturbance parameters to map where each tracker fails. The disturbance engine is already parameterized for exactly this.                                                           | `src/core/disturbance/`, [docs/DISTURBANCE_MODEL.md](docs/DISTURBANCE_MODEL.md)            |
| 5   | **Learned verifier (optional)** | An ONNX model scoring candidates, as a third arm alongside the two trackers. It must go through the plugin contract like everything else.                                                 | [docs/ALGORITHM_PLUGIN.md](docs/ALGORITHM_PLUGIN.md)                                       |
| 6   | **Hardware-in-the-loop**        | The plugin contract was designed so a real camera and gimbal can be substituted without touching tracking code. Large, and the real prize.                                                | [ADR-0002](docs/adr/0002-separate-simulation-from-tracking.md)                             |

Two smaller, concrete items:

- **`06-reports-verified.png` was never captured.** It needs the Tauri build,
  which needs the Xcode licence accepted. Exact steps are at the end of
  [artifacts/sih/screenshots/README.md](artifacts/sih/screenshots/README.md).
  The verification itself passes — both headline experiments recompute from
  their raw files with zero differences.
- **A theme switch.** The app ships white only. The token architecture in
  `src/styles/globals.css` supports a second palette; a dark set existed in
  Phase 10 and was removed rather than left half-tuned.

### A known result worth not losing

AstraBench records a genuine failure, and it should stay recorded. Against the
_uncoded_ hard decoy, AstraLock-X performs **worse** than the baseline — its own
confidence carries it onto the wrong source. Coded beacon identity is what fixes
it, not a better filter. That asymmetry is the most interesting thing the
benchmark says; do not tune it away or hide it.

---

## 7. How to pick up a piece of work

The phases that built this all followed the same shape, and it worked:

1. **Read the relevant ADRs and subsystem doc first.** Most surprising decisions
   are already explained.
2. **Write the test that describes the behaviour you want**, in the same voice
   as the ones around it — tests here state an engineering property, not an
   implementation detail. Read a few first.
3. **Implement it in `core/` with no UI**, so it can be exercised headlessly.
4. **Then surface it**, using the `components/astra` primitives so it looks like
   the rest of the instrument. [docs/UI_GUIDE.md](docs/UI_GUIDE.md) has the
   rules, including "adding a panel".
5. **Run `pnpm verify`.** All of it, before pushing.
6. **Update [docs/PHASE_STATUS.md](docs/PHASE_STATUS.md)** with what you
   measured and — this is the important half — what you did _not_ do, and what
   is still limited.

Commit messages in this repository explain _why_, not _what_; `git log` is worth
reading as documentation.

---

## 8. If you are an AI assistant

Everything above applies to you. A few things specifically:

**Load the invariants before writing code.** Sections 4 and 5 of this file are
the ones that will bite. In particular: do not route around the ground-truth
lint barrier. If a task seems to need privileged data inside an algorithm, the
task is wrong, or it belongs in `core/metrics` — which is allowed to read truth,
one way, by [ADR-0014](docs/adr/0014-evaluation-reads-truth-one-way.md).

**Do not fabricate results.** Do not write plausible numbers into documentation,
do not stub telemetry to make a screen look populated, and do not hand-type a
metric you did not run. If you need real figures, generate them: the evidence in
`artifacts/sih/evidence/` was produced by temporary harnesses that ran the real
benchmark and the real recorder, wrote JSON, and were then deleted. Do the same
and say where the number came from.

**Verify claims before repeating them.** `docs/PHASE_STATUS.md` records what was
true when written. Before quoting a figure, re-run it — metric definitions have
changed across phases, and a Phase 7 number may not mean what a Phase 9 number
means.

**Check state before you start.** `git log --oneline -5`, `git status`, and the
last CI run. The repository is frozen at `d83dae3`; if HEAD differs, find out
why before building on it.

**For Claude Code specifically:** you can copy sections 4 and 5 into a root
`CLAUDE.md` to have them loaded automatically in every session. They are the
parts worth always having in context.

---

## 9. Where to find things

| You want                        | Read                                                 |
| ------------------------------- | ---------------------------------------------------- |
| How it is all put together      | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)         |
| Setup, commands, conventions    | [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)           |
| What works and what does not    | [docs/PHASE_STATUS.md](docs/PHASE_STATUS.md)         |
| Why a decision was made         | [docs/adr/](docs/adr/)                               |
| The information boundary        | [ADR-0003](docs/adr/0003-ground-truth-isolation.md)  |
| Writing a tracking algorithm    | [docs/ALGORITHM_PLUGIN.md](docs/ALGORITHM_PLUGIN.md) |
| KPI formulas and N/A rules      | [docs/METRICS.md](docs/METRICS.md)                   |
| UI design rules                 | [docs/UI_GUIDE.md](docs/UI_GUIDE.md)                 |
| Verified results and provenance | [docs/PPT_EVIDENCE.md](docs/PPT_EVIDENCE.md)         |
| Requirement coverage            | [docs/SIH_COMPLIANCE.md](docs/SIH_COMPLIANCE.md)     |
| Reproducing the screenshots     | [docs/SCREENSHOT_GUIDE.md](docs/SCREENSHOT_GUIDE.md) |
