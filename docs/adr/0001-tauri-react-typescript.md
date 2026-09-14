# ADR-0001: Tauri with a React and TypeScript frontend

- **Status:** Accepted
- **Date:** 2026-09-14
- **Phase:** Phase 0

## Context

AstraLock-X has to run on Windows, macOS and Linux, work offline, and eventually
talk to real hardware over serial or USB for hardware-in-the-loop testing. Its
interface is dense and graphical: camera imagery, a 3D scene, several live plots,
and resizable engineering panels.

Two constraints narrow the field. Offline operation rules out anything that
assumes a server. Hardware access rules out a pure browser application, since
browsers cannot open a serial port without user gesture plumbing that does not
suit an instrument panel.

## Decision

Build a Tauri 2 desktop application with a Vite, React and TypeScript frontend.

TypeScript runs in strict mode, with several checks beyond `strict` enabled
(`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noImplicitReturns`
and others). The extra strictness is aimed squarely at a class of bug this
domain produces: an optional field silently read as `undefined`, or an array
index assumed to exist, shows up as a pointing error rather than as a crash.

## Consequences

- One codebase produces installers for all three desktop targets.
- The Rust side gives a direct path to serial and USB when hardware-in-the-loop
  work begins, with no browser permission model in the way.
- Bundles are small and start fast, because Tauri uses the platform webview
  rather than shipping a browser.
- The platform webview is also the cost: rendering differs slightly between
  WebKit on macOS, WebView2 on Windows and WebKitGTK on Linux, so anything
  visual needs checking on all three.
- Building for a platform requires that platform's toolchain, so releases need
  either three machines or a CI matrix.
- Contributors need a Rust toolchain installed even while nearly all the work is
  in TypeScript.

## Alternatives considered

**Electron.** Mature and predictable, with one Chromium across all platforms.
Rejected on bundle size and memory, which matter for an application intended to
run alongside hardware on modest machines, and because the Rust ecosystem is a
better fit for the device work that is coming.

**A web application.** Simplest to distribute and easiest to demo. Rejected
because offline operation and direct hardware access are both requirements, and
retrofitting either into a browser application is worse than starting native.

**A native desktop toolkit (Qt, egui).** Strong for instrument panels and fast
plotting. Rejected because the UI here is closer to a modern analytics
application than a traditional control panel, and the web ecosystem for charts,
3D and layout is far ahead for that style.
