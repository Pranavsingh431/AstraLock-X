# ADR-0005: TypeScript core first, Rust or WASM only where profiling justifies it

- **Status:** Accepted
- **Date:** 2026-09-14
- **Phase:** Phase 0

## Context

The application is a Tauri app, so Rust is already present and there is an
obvious argument for putting the simulation core there: it is faster, and the
tick loop is the hot path.

The counter-argument is about where the work actually is. The core is mostly
contracts, state machines, filtering logic and metrics — code that will be
rewritten repeatedly as the physics and the algorithms are understood better.
The UI is TypeScript regardless. Splitting the core across the IPC boundary
early means every contract exists twice, in two type systems, kept in sync by
hand, while the shape of those contracts is still changing weekly.

It is also not yet known where the time goes. The obvious guess is image
formation — synthesising frames with noise for a few hundred ticks per second —
but that guess has not been measured.

## Decision

The core is TypeScript for now. Rust or WebAssembly is introduced later, for
specific components, when profiling shows a specific component is the
bottleneck.

Two things are done now to keep that door open:

- **Contracts are plain data.** Every type in `core/contracts` is a
  structurally simple record of numbers, strings, arrays and typed arrays. There
  are no classes, no methods on data, and no closures inside state. Such a type
  crosses a WASM boundary or a `postMessage` without redesign.

- **Pixel data is already a typed array.** `CameraSensorFrame.data` is a
  `Uint8Array` or `Uint16Array`, not a number array, so the most likely
  candidate for a Rust rewrite already has a layout that can be shared rather
  than copied.

When a component does move, it moves behind its existing interface. A Rust
implementation of image formation replaces the body of the sensor module, not
its contract.

The Rust crate stays minimal until then: at Phase 0 it creates the window and
nothing else. Adding an IPC boundary before there is anything to send across it
would add serialisation cost and two type systems for no gain.

## Consequences

- Iteration stays fast while the design is still moving, which is where the
  schedule risk actually is.
- One language, one type system, one test runner for the whole core.
- The ground-truth isolation of ADR-0003 is enforced by the TypeScript compiler
  and ESLint. A Rust core would need that boundary rebuilt on the Rust side.
- Simulation will be slower than it could be. For interactive runs at a few
  hundred ticks per second this is expected to be acceptable; for large batch
  sweeps in AstraBench it may not be, and that is the likely trigger for the
  first move.
- JavaScript's numeric behaviour is a constraint: all arithmetic is double
  precision, and there is no control over vectorisation. Where that matters,
  it is an argument for moving that component rather than for micro-optimising
  it in place.
- Deferring means a migration later, with a boundary to design under time
  pressure. The plain-data contract rule is what keeps that cost bounded.

## Alternatives considered

**Rust core from the start.** Fastest end state and no migration. Rejected
because the contracts are not stable yet, and maintaining them in two type
systems during the phase where they change most would cost more than the
performance is currently worth.

**WebAssembly compiled from Rust, running in the frontend.** Keeps everything in
one process and avoids IPC. This is the most likely form of the eventual move —
particularly for image formation, where a shared `Uint8Array` avoids copying —
and nothing here precludes it. It is deferred for the same reason: no measurement
yet says it is needed.

**A numeric library in TypeScript to close the gap.** Helps with linear algebra
but not with the per-pixel work that is the suspected bottleneck. Can be adopted
independently of this decision if filtering turns out to be hot.
