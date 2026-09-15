# The virtual camera

What the sensor computes, how it stays reproducible, and what it deliberately
does not model.

Everything here is plain TypeScript in `src/core/sensors`. It runs with no
Three.js, no WebGL, no canvas and no DOM — the test suite exercises it in the
plain Node environment. A browser canvas may _display_ a frame; it never
_creates_ one ([ADR-0009](adr/0009-cpu-sensor-not-webgl-readback.md)).

> **There is still no detector, no Kalman filter, no controller and no
> autonomous tracking.** The camera turns the world into pixels. Nothing looks
> at those pixels yet.

---

## Camera frame and basis

The world frame is East-North-Up (`X = East, Y = North, Z = Up`), azimuth is
clockwise from North about `+Up`, elevation is positive upward
([ADR-0006](adr/0006-engineering-coordinate-convention.md)).

For a no-roll mount:

```
  forward = ( sin(az) cos(el),  cos(az) cos(el),  sin(el) )
  right   = ( cos(az),         -sin(az),          0       )
  up      = right x forward
```

`right` is horizontal by construction — that is what "no roll" means, and it is
why the image horizon stays level at every elevation. The construction stays
well defined pointing straight up, where deriving `right` from a world-up
reference would degenerate.

Note that `(right, up, forward)` is **left-handed**: `right x up = -forward`.
That is the usual computer-vision arrangement of x-right, y-up, z-forward, and
it is stated because the sign of the vertical projection term depends on it.

## Pinhole projection

With `r` the vector from the camera to a point, in world ENU metres:

```
  x_cam = r . right        y_cam = r . up        z_cam = r . forward

  u = cx + fx * x_cam / z_cam
  v = cy - fy * y_cam / z_cam
```

The minus sign in `v` is the whole of the raster convention: `y_cam` grows
upward in the world, row indices grow downward in the image, so a target that
climbs moves to a **lower** row.

Only `z_cam > 0` projects. Points behind the camera are reported as behind, not
as out of view, because that is the more useful diagnosis when a mount is
pointed the wrong way.

## Field of view and focal length

```
  fx = width / (2 tan(hfov / 2))
```

The scenario declares the **horizontal field of view**, not a focal length: an
angle is what a lens datasheet quotes and what an operator reasons about, while
a focal length in pixels is meaningless without also knowing the sensor width.

The vertical field of view is derived, under the `square-pixels` policy:

```
  fy = fx
  vfov = 2 atan(height / (2 fy))
```

Declaring both fields of view independently would let a scenario specify
non-square pixels by accident. The policy is a named field rather than an
implicit assumption so a non-square model can be added later without anyone
having to guess what the old scenarios meant.

## Pixel coordinate convention

Image coordinates are **continuous, with pixel centres at half-integers**.

- Pixel `(i, j)` covers `[i, i+1) x [j, j+1)`; its centre is `(i + 0.5, j + 0.5)`.
- The image spans `[0, width] x [0, height]`.
- The pixel containing a coordinate `u` is `floor(u)`.
- The principal point defaults to the image centre, `(width / 2, height / 2)`.

This is the OpenCV and graphics convention. The alternative — pixel centres at
integers, image centre at `((width-1)/2, (height-1)/2)` — needs an offset at
every boundary calculation, and mixing the two produces a half-pixel bias in a
centroid that is very hard to find later.

A consequence worth stating: an even-width image has no centre _pixel_. A
beacon exactly on the boresight of a 640-wide image projects to `u = 320.0`,
which is the boundary between columns 319 and 320, and those two columns receive
equal light. The correct test of an on-axis beacon is therefore symmetry, not a
single brightest pixel.

## Camera clock

The camera runs on its own clock, independent of both the physics tick and the
display refresh ([ADR-0010](adr/0010-independent-sensor-clock.md)):

```
  captureTime(frameIndex) = frameIndex / frameRate
```

One division, never an accumulation, so there is no drift however long the run.
Frame 0 is captured at `t = 0`.

Frames due in an interval are queried half-open, `(afterTime, throughTime]`, so
repeated stepping captures each frame exactly once.

**The frame rate is not required to divide the tick rate.** Capturing every
`round(200 / 60) = 3` ticks would be 66.7 FPS, an 11% timing error in every
timestamp. 30, 50, 60, 90 and 120 FPS are each tested over 200 Hz physics.

## Sampling between ticks

At 200 Hz physics and 60 FPS a frame falls 3.33 ticks apart, so two frames in
three are taken between ticks. Two policies exist:

**`exact`** (the default). The world is evaluated at exactly the capture time.
There is no timing error at all. This is possible because Phase 1 made
trajectories pure functions of time.

**`linear-between-ticks`**. Interpolates between the two bracketing snapshots:
positions linearly, angles along the shortest path so a bearing crossing `+/-pi`
does not swing the long way round. It exists for the case exact sampling cannot
cover — a world whose evolution depends on its own previous state, which a
closed control loop will make it — and because it bounds the error the exact
path avoids. That bound is `a h^2 / 8`: at `h = 5 ms` and `a = 6 m/s^2`, under
19 micrometres.

Sensor sampling is **not** display interpolation. The renderer blends frames for
smooth motion at the display's rate; this decides what the instrument saw.
Neither feeds the other.

## Image formation

An ideal point source is spread by a circular Gaussian:

```
  contribution(px, py) = peak * exp( -((px + 0.5 - u)^2 + (py + 0.5 - v)^2) / (2 s^2) )
```

evaluated at pixel centres about the **exact** sub-pixel projected centre.
Rounding the centre to a whole pixel would cap every future centroid at half a
pixel of accuracy, which is worse than the sensor itself.

The kernel is bounded at three sigma, where a Gaussian contributes under 1.2% of
its peak — at most three counts in an 8-bit image. It is evaluated **separably**:
`exp(-(dx^2 + dy^2)/2s^2)` factors into two one-dimensional exponentials, so a
kernel of half-width `k` costs `2k` calls to `Math.exp` rather than `k^2`. The
result is identical, not approximated.

**Combination rule: contributions add, then clip.** Adding is what light does;
clipping is what a full well does. Taking the maximum instead would make two
coincident beacons indistinguishable from one, which is exactly the case a
multi-target tracker has to resolve.

**Background** is a uniform pedestal from `camera.backgroundLevel`, usually
zero. Phase 2 models an ideal noiseless sensor, so there is no dark current, no
read noise and no shot noise.

Writes outside the image are clipped, never wrapped. A beacon at the left edge
draws its visible part and nothing else; a wrapped write would put light on the
far edge of the row above, which is invisible in a thumbnail and fatal to a
detector.

## Visibility

An emitter contributes light only when it is `visible`. The reasons are
reported for evaluation and debugging:

| Reason          | Meaning                                            |
| --------------- | -------------------------------------------------- |
| `visible`       | In front of the camera, in range, inside the image |
| `behind-camera` | `z_cam <= 0`                                       |
| `too-near`      | Closer than `camera.nearRange`                     |
| `too-far`       | Beyond `camera.farRange`                           |
| `outside-fov`   | Projects outside the image rectangle               |

**This reason never reaches a tracking algorithm.** "The target is outside the
field of view" is exactly the kind of answer a tracker is supposed to work out
for itself.

## The frame contract

`CameraSensorFrame` contains only what a real device could hand you:

| Field                       | Why it is permitted                       |
| --------------------------- | ----------------------------------------- |
| `frameId`, `captureTime`    | A camera timestamps its own frames        |
| `width`, `height`, `format` | The sensor's own specification            |
| `data`                      | The pixels                                |
| `exposure`, `gain`          | The settings used                         |
| `droppedSince`              | A camera knows when it dropped a frame    |
| `pose`                      | A mount reads its own encoders            |
| `cameraConfigId`            | So a consumer can tell the optics changed |

It contains **no** target position, velocity or identity, no projected centre,
no bearing, no range, no visibility reason, no emitter identity and no reference
to the simulation. An adversarial test enumerates the whole surface and searches
it for the ground-truth brand.

`pose` is the mount _reporting itself_, not the truth — and since Phase 3 those
are genuinely different numbers. The frame carries the **measured** angle, the
encoder reading; the image is formed from the **true** mechanical output. They
differ by up to half an encoder count at every instant, so a consumer cannot use
the reported pose to invert its own image formation. See
[ADR-0011](adr/0011-true-versus-measured-actuator-state.md) and
[GIMBAL_MODEL.md](GIMBAL_MODEL.md).

## The truth boundary

`SensorEvaluationTruth` is a **separate object**, branded as ground truth. It
holds, per emitter: the true projected centre, the true range, the offset from
boresight, the visibility reason and how many pixels the point spread wrote.
Each projection record is branded individually, not merely nested inside the
branded parent, so lifting one out does not produce a clean-looking object
holding the answer key.

It exists because the camera geometry has to be checkable — a projection bug is
otherwise invisible, since a wrong image still looks like an image — and because
evaluation will eventually score a tracker's centroid against the true one.

`SensorCapture`, the pair of a frame and its truth, is itself branded, so the
type system refuses to hand it to a plugin. The harness passes `capture.frame`
and nothing else.

The lint barrier blocks tracking-side code from importing `core/sensors` at all.

## Buffer ownership and backpressure

A 640x480 GRAY8 frame is 307,200 bytes; at 60 FPS that would be 18 MB/s of
fresh allocation. Frames are drawn from a small ring of reused buffers instead.

**A frame does not own its pixels.** After `capacity` further frames the same
memory is handed out again and the old frame's pixels change underneath it.
That sharp edge is stated here, kept small so it appears immediately rather than
rarely, and given an escape hatch: `copyFramePixels` for a consumer that needs
to keep one.

Two delivery policies, deliberately distinguished:

| Term                       | Meaning                                                                         |
| -------------------------- | ------------------------------------------------------------------------------- |
| **scheduled**              | The camera clock called for this frame                                          |
| **rasterized**             | Pixels were actually built                                                      |
| **superseded for display** | Scheduled, but a newer frame was already due, so the live view did not build it |
| **dropped**                | The _sensor_ failed to produce a frame — not modelled in Phase 2, always `null` |

`captureLatest` is the live path: it builds only the newest frame due, because a
viewer can look at one image and building the ones behind it would cost time and
memory to produce something discarded immediately. A superseded frame is a
**display** decision and is never reported as a sensor dropout.

`captureRange` is the analysis path: every frame, delivered through a callback
so a long headless interval does not materialise thousands of images at once.

## Measured cost

On the development machine (Apple silicon, Node 24), three emitters in frame:

| Resolution | Mean      | P95       | Sustainable |
| ---------- | --------- | --------- | ----------- |
| 320x240    | 0.0150 ms | 0.0203 ms | ~66,000 FPS |
| 640x480    | 0.0160 ms | 0.0185 ms | ~62,000 FPS |

A 60 FPS budget is 16.67 ms, so frame generation uses about a thousandth of it.
Cost is dominated by clearing the background, which is linear in area; the point
spread is independent of image size. No optimisation has been attempted, and
none is warranted on this evidence.

## What Phase 2 does NOT model

| Not modelled                                            | Consequence                                                                                                                                     |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Read noise, shot noise, dark current                    | The image is exactly background plus point spreads                                                                                              |
| Sensor dropout                                          | `droppedSince` is always `null`                                                                                                                 |
| Atmospheric attenuation, scintillation, turbulence      | No range or weather dependence                                                                                                                  |
| Link budget                                             | Beacon intensity is constant with range; `transmitPower` is declared but unused                                                                 |
| Occlusion                                               | Nothing ever blocks anything                                                                                                                    |
| Glare, bloom, blooming, smear                           | No cross-pixel artefacts beyond the point spread                                                                                                |
| Lens distortion                                         | The projection is an exact pinhole                                                                                                              |
| Motion blur                                             | Exposure is declared but instantaneous                                                                                                          |
| Actuator disturbance, friction, flexure, cross-coupling | The mount models servo dynamics, limits, deadband, backlash and encoder quantisation, but nothing else — see [GIMBAL_MODEL.md](GIMBAL_MODEL.md) |
| `mono16`                                                | Declared in the contract; the renderer refuses it rather than emitting 8-bit data in a 16-bit buffer                                            |
| Detection, estimation, control, PAT                     | Nothing looks at the pixels                                                                                                                     |

Since Phase 4 something does look at the pixels: `baseline-kf-pid` reads
`frame.data` directly and nothing else. See
[BASELINE_PAT.md](BASELINE_PAT.md).

GRAY8 — spelled `mono8` in the pixel-format contract, for continuity with
Phase 0 — is the authoritative sensor format. The UI expands it to RGBA to draw
it, which is a display concern only; a detector has no use for three identical
colour channels.

## Phase 7 camera-observable disturbance model

The Phase 2 omissions above describe the original clean path. Phase 7 retains
that byte-for-byte path whenever the scenario is clean, and adds an explicitly
separate disturbed image-formation path. It models finite exposure, optical
attenuation, correlated scintillation and angular wander, PSF broadening,
ambient background, signal-dependent shot-noise approximation, read noise,
clipping and GRAY8 quantisation. A dropout is not a black frame or a flag: the
sensor does not rasterize or deliver it at all.

These are camera-observable engineering models, not a calibrated link budget or
full wave-optics propagation. Their order, units, equations, deterministic RNG
streams and tested limits are specified in
[DISTURBANCE_MODEL.md](DISTURBANCE_MODEL.md).
