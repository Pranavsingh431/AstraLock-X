# ADR-0003: Ground-truth isolation policy

- **Status:** Accepted
- **Date:** 2026-09-14
- **Phase:** Phase 0

## Context

ADR-0002 separates simulation from tracking. This record specifies how that
separation is enforced, because a boundary that depends on reviewer vigilance is
not a boundary.

The failure mode is specific and quiet. A tracker that reads simulator ground
truth — target position, target identity, or future trajectory — produces
excellent results and no errors. There is no crash, no failing test, and no
obviously wrong number. The first symptom is usually that the algorithm behaves
completely differently against real hardware, months later.

It is also easy to do by accident. Ground truth and sensor output describe the
same physical quantities, so a leak looks like a reasonable line of code.

## Decision

Ground truth is unreachable from the tracking side, enforced by four independent
mechanisms. Each would be defeatable alone; together they cover the realistic
routes.

**1. A brand on the data.** Every ground-truth-bearing type extends
`GroundTruthTainted`, which carries a marker property. The marker is a _string_
key, not a symbol: `structuredClone` — which is what `postMessage` uses — copies
own enumerable string-keyed properties and silently drops symbol-keyed ones, so
a symbol brand would vanish at exactly the worker boundary where the runtime
check matters most. `brandAsGroundTruth` defines it non-writable and
non-configurable, so it cannot be stripped in passing.

**2. A type-level reachability check that fails closed.**
`InspectGroundTruth<T>` walks a type through objects, arrays and function return
types looking for the brand, and returns one of three verdicts:

| Verdict   | Meaning                                | Outcome  |
| --------- | -------------------------------------- | -------- |
| `clean`   | proved to contain no ground truth      | admitted |
| `tainted` | proved to contain ground truth         | rejected |
| `unknown` | undecided within the inspection budget | rejected |

The third state is the substance of the design. A bounded type-level walk cannot
decide every type, and the only safe way to report that is to say so. An earlier
version returned a boolean and answered "clean" when it ran out of budget, which
meant a sufficiently deeply nested type was admitted without ever being
examined — a silent hole in the boundary, which is the worst possible failure
mode for a check whose whole purpose is to catch what review misses.

The budget is twelve levels, against a measured worst case of six across the
current contracts. It is not a tuning knob for admitting deep types: raising it
would move the cliff, not remove it, and exhausting it now rejects. A type that
recurses without bound — a self-referential JSON type, say — therefore cannot
appear on a plugin's surface, and the diagnostic says to declare a concrete
shape instead.

`TrackingInput`, `AlgorithmInit` and `TrackingOutput` each carry a static
assertion built on this, so if a future edit gives any of their fields a tainted
or undecidable type, `pnpm typecheck` fails at the declaration.

Two type-system asymmetries are deliberate. `any` resolves to tainted, because it
defeats checking and could be hiding anything. `unknown` resolves to clean: it is
the safe top type, nothing can be read from it without narrowing, and it is the
declared default for a plugin carrying no config or debug payload.

One rough edge is worth recording. A type that is both very wide and deep — the
Zod schema inside `AlgorithmManifest` is the example in this codebase — exhausts
the compiler's own instantiation limit and reports TS2589 instead of the
dedicated diagnostic. That is still fail-closed, since TS2589 is a compile
error, but the message is worse. It does not affect the checked surface: the
manifest never crosses the boundary, and exposes nothing beyond `TConfig`, which
is checked directly.

**3. A guard at plugin registration.** `defineAlgorithm` refuses a plugin whose
own config or debug type reaches ground truth — or that it cannot prove
otherwise — so a plugin cannot widen its own surface to smuggle truth in through
configuration or back out through debug output. The two rejections carry
different diagnostics, `GroundTruthReachable` and `GroundTruthUnprovable`,
because the remedies differ: remove the dependency, or flatten the type.

The check lives at registration rather than on the `AlgorithmPlugin` interface
because TypeScript rejects a self-referential bound of the form
`T extends GroundTruthFree<T>` as circular, and a trailing proof parameter
cannot be verified while the parameters are still generic.

**4. A lint barrier.** `core/algorithms`, `core/perception`, `core/estimation`,
`core/control` and `core/pat` may not import `core/contracts/ground-truth`,
`core/simulation` or `core/metrics`. The rule used is
`@typescript-eslint/no-restricted-imports` rather than the core rule, because
only the former reports `import type` — which is the most likely leak, since a
tracker wanting ground truth usually wants the type first.

Supporting these, `core/contracts/index.ts` deliberately does **not** re-export
`ground-truth.ts`. Obtaining `GroundTruthState`, `WorldState` or `TargetId`
requires naming that module directly, which makes every privileged dependency
visible in a diff.

The only legitimate consumers of ground truth are the simulator, evaluation and
metrics, and debug views explicitly labelled as ground-truth overlays.

`assertGroundTruthFree` provides the runtime half, for values crossing a worker
or plugin boundary where static types have been erased. Its traversal is
iterative and has no depth limit: a recursive walk would overflow the call stack
on a deeply nested structure, and a depth cutoff would stop looking without
saying so — both are ways of reporting "clean" about something never examined.
Cycles are handled with a visited set. Binary buffers are skipped after the
brand check, since they hold no object references and enumerating a 640x480
frame would cost 307,200 property visits per call.

## Consequences

- A leak is a build failure or a lint failure, not a silent measurement error.
- The guarantee is testable, and it is tested: `isolation.test-d.ts` includes
  `@ts-expect-error` cases that fail if the offending code ever starts
  compiling, and `ground-truth-barrier.test.ts` runs the project's real ESLint
  configuration over probe files to confirm the import rule still fires.
- Evaluation is harder, in a way that reflects reality. Metrics cannot ask which
  target a track corresponds to; it has to solve the association. That is the
  same problem a real evaluation faces, so the added work is not artificial.
- Debugging a tracker means reading its own state and its own inputs. Ground
  truth is available in the UI, but only through views that say so.
- The runtime scan costs a traversal at boundary crossings. It is applied at
  boundaries, not per field access.
- Failing closed will occasionally reject a legitimate type that is merely deep.
  That is the intended trade: a false rejection is a compile error with a clear
  remedy, whereas a false acceptance is a silently meaningless benchmark.
- A determined author can still defeat all of this with a cast. The aim is to
  make accidents impossible and deliberate circumvention obvious in review, not
  to defend against a hostile contributor.

## Alternatives considered

**Convention and code review.** Zero machinery. Rejected: the failure is silent,
so review is the only detector, and review does not reliably catch a plausible
line of code.

**Running the tracker in a separate process or worker with a narrow message
protocol.** Genuinely stronger. Not rejected permanently — it is the natural
form once the tick loop moves into a worker (see `src/workers/README.md`), and
the string-keyed brand was chosen to keep the runtime check working across that
boundary. It is not sufficient on its own, because a harness bug could still
assemble a message containing truth, which is what the runtime guard catches.

**Branding by nominal wrapper types instead of a marker property.** Would give a
compile-time guarantee without a runtime marker. Rejected because the runtime
marker is what survives serialisation, and a wrapper would force unwrapping at
every use inside the simulator.
