# ADR-0009: The authoritative camera is CPU-side, not a WebGL readback

- **Status:** Accepted
- **Date:** 2026-09-14
- **Phase:** Phase 2

## Context

The application already draws a 3D scene with Three.js. Adding a second camera
to that scene and reading its framebuffer back would produce an image, and it
would do so with hardware acceleration and very little new code. It is the
obvious thing to try.

It is also the wrong authority. The question a sensor model answers is "what
would this instrument have recorded", and that has to be answerable in a test,
in a worker, and in a benchmark sweep with no display attached. A frame that
only exists after a GPU round trip cannot be produced in any of those places.

Three further problems make the choice clear rather than marginal.

A rasteriser is not a radiometer. WebGL renders for appearance: it applies
tone mapping, gamma, antialiasing and colour management, each of which is
tuned to look right rather than to preserve intensity. The pixel values that
come back are not the ones an 8-bit machine-vision sensor would have produced,
and the difference is exactly the part a detector depends on.

Readback is slow and synchronous. `readPixels` stalls the pipeline; at 60 FPS
that stall lands in the middle of the frame budget it is supposed to fit into.

Results would vary by machine. Driver, GPU and browser differences change
rasterisation at the margin. ADR-0004 already limits reproducibility to
per-architecture; making the sensor depend on a graphics stack would widen that
to per-driver, and "the benchmark disagrees on this laptop" is not a debuggable
statement.

## Decision

Image formation happens in plain TypeScript in `core/sensors`, on the CPU.

The sensor takes world state and produces a `Uint8Array` of intensity values
through an explicit pinhole projection and an explicit point-spread function.
It imports nothing from Three.js, React, the DOM or WebGL, which the existing
core-purity lint rule enforces.

A browser canvas may **display** a frame. It must never **create** one. The
sensor monitor in Mission Control expands the GRAY8 buffer into RGBA and calls
`putImageData`; that is a presentation step over an image that already exists.

The Three.js observer view remains what it has been since Phase 1: a debug view
of ground truth for a human, with no part in the measurement.

## Consequences

- The sensor runs headlessly. The test suite exercises it in the plain Node
  environment, with `document`, `window`, `HTMLCanvasElement` and
  `WebGLRenderingContext` all asserted absent.
- Pixel values mean something. An intensity is a modelled intensity, not the
  output of a tone-mapping curve.
- Frames are reproducible on a machine regardless of its graphics stack.
- The sensor is bounded by CPU rather than GPU. Measured cost is 0.016 ms for a
  640x480 frame with three emitters, which is roughly a thousandth of a 60 FPS
  budget, so the constraint is theoretical at present.
- Complex optics would be more work here than in a shader. That is a real cost
  and it is accepted: Phase 2 models an ideal pinhole, and a future phase that
  wants scattering or bloom will pay for it in explicit code that can be tested,
  rather than in a pipeline that can only be eyeballed.
- Two rendering paths now exist — the observer scene and the sensor. They can
  disagree, and if they do the sensor is right. Only one of them is the
  instrument.

## Alternatives considered

**Render the sensor with an offscreen WebGL context and read it back.** Fast on
a machine with a GPU. Rejected on every count above: not headless, not
radiometric, not reproducible across drivers, and stalling at exactly the wrong
moment.

**Render with WebGL for display and separately compute on the CPU for
evaluation.** Keeps the pretty path and the correct path. Rejected as two
implementations of the same thing, which would drift, and which would mean the
image on screen was not the image being measured — the specific confusion the
labelling in this phase exists to prevent.

**Defer image formation and hand a tracker projected coordinates directly.**
Much less work. Rejected outright: a tracker that receives the answer is not
being measured at all, which is the whole subject of ADR-0003.
