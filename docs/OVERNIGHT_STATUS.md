# Overnight engineering status

## Phase 7 — pushed to `main`, remote CI green

Starting point: `1dfc90bc4de74701920106c450d02209797dbca4` (verified Phase 6).

Phase 7 implements the deterministic physical disturbance system described in
[DISTURBANCE_MODEL.md](DISTURBANCE_MODEL.md). Local acceptance evidence is
recorded in [PHASE_STATUS.md](PHASE_STATUS.md#local-phase-7-verification). It
was pushed to `main` and the Linux/macOS/Windows GitHub Actions matrix passed.

## Phase 8 — coded optical beacon identity

Starting point: `846c14a40785f8625129d9e38316d332fc03c281` (verified Phase 7,
including the UI polish commits that followed it).

Phase 8 adds camera-observable temporal beacon identity and the receiver that
recognises it, described in [BEACON_IDENTITY.md](BEACON_IDENTITY.md). Local
acceptance evidence is in
[PHASE_STATUS.md](PHASE_STATUS.md#local-phase-8-verification): the whole
TypeScript suite, the performance suites, the formatter, ESLint, the TypeScript
compiler, the production frontend build, Rust formatting, Clippy with warnings
denied and the Rust tests all pass locally, and the identity feature was
validated manually in the running application.

One local step is blocked and it is a machine problem rather than a code one.
`pnpm tauri build` now fails at the link step with "You have not agreed to the
Xcode license agreements", after an Xcode update on this machine; the fix is
`sudo xcodebuild -license` and it needs the machine owner's password. CI builds
and uploads the desktop bundle on Linux, macOS and Windows, so the desktop build
itself is covered — what is not covered locally is launching the native `.app`.

## Phase 9 and later

Not started. No AI/ONNX verifier, AstraBench benchmark engine, FailureHunter,
replay, HIL or final UI redesign was added as part of Phase 8. There is no
communications modem, no link budget and no wave-optics propagation.
