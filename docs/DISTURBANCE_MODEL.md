# The disturbance model

What Phase 7 adds to the physics, in the order it acts, with the equations and
the units. Everything here is **camera-observable**: these are models of what a
camera sees when a platform vibrates, a path attenuates or a sensor is noisy.
None of it is wave-optics propagation, and nothing in this document should be
read as claiming otherwise.

Disturbances belong to the **scenario**, never to an algorithm's configuration.
A tracker cannot choose the weather it is tested in, and cannot read what that
weather is. It experiences all of it as pixels.

## Where it acts

```
World / target
  │
  ├─ geometric ─────── platform base attitude  → the camera really is pointed elsewhere
  │                    angular wander          → the beacon appears to arrive from elsewhere
  ▼
True optical geometry
  │
  ├─ radiometric ───── path attenuation        → how much of the beacon survives
  │                    scintillation           → how much that varies with time
  │                    finite exposure         → integrate the optical state over the frame
  │                    defocus                 → spread the spot further
  │                    ambient background      → add sky
  ▼
Accumulated intensity (floating point)
  │
  ├─ sensor ────────── shot noise              → signal-dependent
  │                    read noise              → signal-independent
  │                    clip and quantise       → what the ADC can express
  ▼
GRAY8 CameraSensorFrame
  │
  ├─ transport ─────── dropout                 → the frame is never delivered
  ▼
The algorithm
```

The order is part of the model. Attenuating after the background is added would
dim the sky along with the beacon. Adding read noise before the point spread
would put it through the optics. Quantising between sub-exposure samples would
round the same photon budget several times over.

Implementation: `src/core/disturbance/` builds the realization,
`src/core/sensors/virtual-camera.ts` applies it.

## Clean mode is Phase 6 exactly

With every effect disabled — or enabled and configured to zero, which
`isCleanDisturbance` treats identically — image formation takes the
**pre-Phase-7 code path unchanged**. Not a numerically equivalent path: the same
one. So "disturbances off" means byte-identical Phase-6 pixels, and every
Phase 0-6 regression stays pinned to the values it was pinned to.

That is why the renderer has two branches rather than one general one. A single
float pipeline would differ from Phase 6 in the last bit of some pixels, and
"almost the same" would have quietly invalidated every stored result.

## Determinism: indexed by frame, not by draw

Every stochastic effect is a **pure function of the root seed and the frame
index**. This is not the obvious implementation and it is not an optimisation.

A sequential generator's output depends on how many values have been taken from
it, which depends on how many frames were rendered — and _that_ is a display
decision. The live view renders only the newest frame due and skips the rest;
the autonomous runtime renders every one. With a sequential stream the
interactive run and the headless run would see different weather, and recording
a run would change its physics.

So:

- **Counter-based hashing.** `CounterStream.gaussianAt(index, lane)` hashes
  `(streamSeed, index, lane)` through SplitMix32. Evaluable in any order, any
  number of times, always the same answer.
- **Correlated processes walk a fixed grid.** An Ornstein-Uhlenbeck process
  stepped to frame 500 and one fast-forwarded straight to frame 500 give the
  same value, because the driving normals are counter-based. Asked for an index
  it has already passed, a process replays from the start rather than refusing:
  it stays a pure function of the index, so the sensor and the evaluator can
  walk the same run at different rates without disagreeing.
- **Per-pixel noise is seeded from the frame index.** Hashing 307,200 pixels
  individually would cost more than the rest of the frame; instead the _frame's_
  noise seed is counter-based and a fast sequential generator walks the pixels in
  raster order. The field is still a function of the frame index alone.

### Named streams

| Stream                        | Drives                                                      |
| ----------------------------- | ----------------------------------------------------------- |
| `disturbance:platform-jitter` | correlated base attitude jitter, both axes (lanes 0, 1)     |
| `disturbance:scintillation`   | log-intensity process                                       |
| `disturbance:wander`          | apparent angular displacement, both components (lanes 0, 1) |
| `disturbance:sensor-read`     | per-frame read-noise field                                  |
| `disturbance:sensor-shot`     | per-frame shot-noise field                                  |
| `disturbance:dropout`         | frame delivery, independent or burst                        |

Each seed is derived by hashing the stream _name_ with the root seed
(`deriveStreamSeed`, ADR-0007). Streams are therefore independent by
construction: adding a name, renaming nothing, cannot perturb an existing one,
and changing the read-noise implementation cannot move the vibration, the
dropout pattern or the scintillation.

## Platform base motion

**This is not gimbal-axis motion.** The camera's optical orientation in the world
is

```
  optical azimuth   = gimbal azimuth   + base azimuth
  optical elevation = gimbal elevation + base elevation
```

and the gimbal encoder measures **only the gimbal term**. Without a separate
attitude reference — which this terminal does not have — base motion is invisible
to the tracker except as image motion. That is the physical situation on a
vehicle, and it is why vibration is a genuine test rather than a number the
algorithm could subtract out.

The evaluator composes the same base attitude into its optical axis. Scoring
against the gimbal alone would report a mount holding its aim perfectly while
the target slid across the image.

Base attitude has three parts, which sum:

- **Bias.** A constant offset per axis. A fixed boresight error.
- **Tones.** `offset(t) = Σ A·sin(2πf·t + φ)`, evaluated in closed form at the
  exact time, so a tone cannot drift or depend on how the caller stepped.
  Evaluated at each sub-exposure instant, so vibration during an exposure
  produces real blur rather than a rigid shift.
- **Correlated jitter.** An Ornstein-Uhlenbeck process per axis, with a
  configured stationary RMS and correlation time.

### Why Ornstein-Uhlenbeck, integrated exactly

```
  a       = exp(-dt / tau)
  X(t+dt) = a·X(t) + sqrt(1 - a²)·sigma·N(0,1)
```

Independent draws every frame would be white noise: unbounded bandwidth, and a
mount asked to follow infinite acceleration. Calling that "vibration" would be
describing a numerical artefact.

The _exact_ discretisation matters separately. Euler-Maruyama would make the
stationary variance depend on the step size, so a scenario's measured RMS would
change silently with the frame rate. With the form above the stationary
distribution is exactly `N(0, sigma²)` at every step size — which is what lets a
configured RMS be checked against a measured one, and it is checked.

The process starts **in** its stationary distribution rather than at zero.
Starting at zero would give every run a transient of several correlation times
during which the disturbance is weaker than the scenario asked for, and for a
slow process that can be most of the run.

### Torque disturbance

Phase 3 left a disturbance insertion point around the actuator. Phase 7 does
**not** use it, and does not add a motor-torque disturbance. Base attitude motion
and shaft torque disturbance are different physical things and conflating them
would be wrong; implementing both when only one is needed would be complexity
without measurable benefit. The hook remains available and unused, and this
paragraph is the record of that decision.

## Path attenuation

```
  attenuationDb = dbPerKm · rangeKm
  transmittance = 10^(-attenuationDb / 10)
```

**Intensity convention, stated explicitly.** These decibels are power/intensity
decibels: exactly half the intensity is `10·log10(2) = 3.0103 dB`, and a round
3 dB is 0.5012. Nothing in this model attenuates a field amplitude, so the
20·log10 convention does not apply anywhere in it. The emitter's apparent
intensity is multiplied by the transmittance before anything else happens to it.

Range is the true straight-line distance to that emitter, so a distant decoy is
attenuated more than a near designated target, automatically.

At absurd path loss the transmittance underflows to exactly zero. That is a
limit of double precision and also the honest answer: 7000 dB extinguishes a
beacon completely.

## Scintillation

```
  X(t)    = Ornstein-Uhlenbeck, zero mean, sd = logAmplitudeSigma
  gain(t) = exp(X(t) - logAmplitudeSigma² / 2)
```

The `-sigma²/2` term makes `E[gain] = 1`. Without it, enabling scintillation
would also brighten the image, and the effect would be indistinguishable from a
gain change; with it, scintillation changes how much the received intensity
_varies_ and not how bright it is on average.

A correlated log-normal intensity multiplier is a defensible model for weak to
moderate fluctuation and is what the configuration bound (`logAmplitudeSigma ≤ 1`)
keeps it inside. Gamma-Gamma and other strong-turbulence distributions are **not**
implemented: they would need verification this phase does not have room for, and
an unverified heavier-tailed model is worse than a verified lighter-tailed one.

This is a camera-observable model of what scintillation does to a measured blob.
It is not wave propagation.

## Angular wander

Two orthogonal correlated components, each an Ornstein-Uhlenbeck process with a
configured RMS and correlation time, displacing **where the beacon appears to
come from** without moving the target.

Geometrically, a beacon appearing further round in azimuth is identical to a
camera pointed further back, so wander is applied by subtracting it from the
optical axis used for projection. The truth record keeps the two apart:

| Recorded                            | Includes base attitude | Includes wander |
| ----------------------------------- | ---------------------- | --------------- |
| `cameraAzimuth` / `cameraElevation` | yes                    | no              |
| `imageX` / `imageY`                 | yes                    | no              |
| `apparentImageX` / `apparentImageY` | yes                    | yes             |

So **geometric pointing error** is measured against where the emitter is, and
**detector centroid error** against where its light arrived, and an evaluator can
say which of the two a given error came from. With wander off the two image
centres are identical, which is every run before Phase 7 and every clean run
since.

**One model, not two.** A separate higher-frequency angle-of-arrival term was
considered and deliberately not added: with only a camera to observe them, a slow
large wander and a fast small jitter are the same two-parameter correlated
process with different parameters, and shipping both under different names would
be two identical implementations and a claim of physical distinction this model
cannot support. A scenario that wants fast small perturbation configures a short
correlation time and a small RMS.

## Finite exposure

The Phase-2 sensor sampled the world at one instant. With exposure enabled the
frame integrates `subSamples` optical states across the exposure window:

```
  t_k = captureTime - T/2 + T·(k + 0.5)/N,   k = 0 … N-1
```

Each sub-sample re-samples the **world** — target position, camera position,
gimbal output and base attitude — and contributes `peak/N` of the light. So blur
is a consequence of motion during the exposure, never a filter applied to a
finished image, and a stationary beacon produces none because every sub-sample
lands in the same place.

**The window is centred on the capture instant**, which makes the frame's
timestamp its mid-exposure time. An exposure running `[t, t+T]` would put a
blurred centroid half an exposure behind the timestamp, and every comparison
against truth at `t` would read that lag as pointing bias.

`N = 1` reproduces instantaneous capture **exactly**, not approximately: the
single sub-sample time is exactly the capture instant.

The count is a numerical parameter, not a physical one, and converges: for a
target crossing at 900 m/s the 8-bit image is already identical between 32 and
64 sub-samples. Measured blur matches the prediction — a streak of
`fx·v·T/range` pixels adds `L²/12` to the variance along the direction of motion
and nothing across it.

## Defocus

```
  sigma_effective = sqrt(sigma_beacon² + extraSigma²)
  peak_effective  = peak · sigma_beacon² / sigma_effective²
```

Quadrature addition, and the peak falls as `sigma²` rises so that the integral
`peak · 2π·sigma²` is unchanged. **Broadening at a fixed peak would create
light.** Energy conservation is checked directly, before clipping.

Not a lens model, and no claim to be one.

## Ambient background

A uniform level plus an optional linear ramp:

```
  level(x, y) = backgroundLevel + gradient · projection(x, y)
```

where the projection runs along `gradientAngle`, normalised so the mean over the
image is the uniform level alone — a gradient changes the _shape_ of the
background, not how much of it there is.

This **adds to** the camera's own `backgroundLevel` pedestal rather than
replacing it: the pedestal is the instrument's dark level, this is the sky.

An engineering model of reduced contrast. Deliberately not a photograph: a
decorative background in an engineering sensor would be untestable and would
invite reading detection performance off an image that was chosen for how it
looked.

## Sensor noise

Applied to the accumulated intensity, before clipping and quantisation. A
sensor's noise is in its signal chain, not in its analogue-to-digital converter.

**Units are simulation intensity counts on the 0-255 scale, not electrons.**
This sensor works in relative 8-bit intensity and has no calibrated conversion
gain, so quoting electrons would be a unit the model cannot support. Phase 4's
`readNoiseElectrons` and `fullWellElectrons` fields were removed in scenario
schema v5 for exactly that reason: they named a calibrated quantity and nothing
computed one.

### Shot noise — an approximation, named as one

```
  sigma_shot(pixel) = scale · sqrt(max(signal + background, 0))
```

drawn from a **normal** distribution, not a Poisson one.

The square-root dependence is the physically meaningful part: bright pixels are
noisier than dark ones, and that is what changes a detector's behaviour against a
bright sky. The absolute scale is a free parameter.

This is **not** exact Poisson photoelectron noise and is not called that. A true
Poisson model needs an intensity-to-expected-count mapping, which needs a
calibrated conversion gain, which this sensor does not have. Mixing arbitrary
8-bit intensity with a claim of photon counts would be a fabricated unit.

### Read noise

Zero-mean normal, standard deviation `sigma` in intensity counts,
signal-independent.

### Clipping and quantisation

```
  out = round(clamp(value, 0, 255))
```

A clamp, never a wrap. A wrapped overflow turns the brightest pixel in the image
into the darkest, which is invisible in a thumbnail and fatal to a detector.
Checked directly: a deliberately saturating frame has pixels pinned at 255 and
almost none near zero.

## Frame dropouts

A dropped frame is a frame the algorithm **never receives**. Not a black frame,
and not a frame carrying a "this one is bad" flag — either would hand the tracker
information that a camera which failed to deliver cannot give it. The world is
still advanced to the instant the frame would have arrived, so simulated time
passes normally and the tracker experiences exactly what a real terminal would:
nothing, for one frame period.

Two modes:

- **`independent`** — each scheduled frame is dropped with `probability`.
- **`burst`** — a two-state Markov chain over frame indices with expected dwells
  `meanGoodFrames` and `meanBadFrames`, so losses arrive in runs. Isolated losses
  are easy, because an estimator coasts one frame without noticing; runs are what
  actually test a recovery strategy.

### Four frame counters, kept separate

| Counter                    | Meaning                                                                     |
| -------------------------- | --------------------------------------------------------------------------- |
| **scheduled**              | the camera clock called for a frame                                         |
| **generated** (rasterized) | pixels were actually built                                                  |
| **dropped**                | the _sensor_ failed to deliver — no pixels, no truth, no consumer           |
| **superseded for display** | the _interface_ chose not to rasterize a frame it would immediately discard |

The last two are categorically different and Phase 5's distinction is preserved:
one is an instrument failure, the other is a display decision.

## False optical sources

Decoys are **not** a disturbance parameter. They are ordinary targets, with
ordinary trajectories and ordinary beacons, in the scenario's `targets` array.

That is the physically correct representation and it is the point: a decoy is not
a special kind of object the renderer has to know about. It is another emitter,
it is attenuated by its own range like any other, and telling it apart is the
tracker's job. Representing decoys as a disturbance field would have made them a
distinguishable category inside the simulator — exactly the thing that must not
exist.

Identity lives only in privileged state: the evaluator's `designatedTargetIndex`
says which emitter counts. Neither algorithm receives it, and neither receives
anything that identifies an emitter.

No temporal coding, no beacon authentication and no learned classifier exists in
this phase. The identity weakness is therefore real and is meant to be visible.

## Evaluator-only disturbance truth

Recorded per frame, for scoring and for debug views, never for an algorithm:

- true base attitude, both axes
- true apparent angular displacement, both components
- true scintillation gain
- whether the frame was dropped

The per-pixel noise field is **not** recorded. It is hundreds of kilobytes a
frame and is exactly reproducible from the seed and the frame index, both of
which are recorded. Storing it would turn a structured experiment record into a
video.

## Image SNR

Phase 5 replaced a fabricated 0 dB SNR with "Not modelled". Phase 7 models signal
and noise, so an evaluation-only image SNR is defined — with its formula, because
"SNR" without one is not a measurement:

```
  signal(p)  = clean target contribution at pixel p, before any stochastic noise
  noise(p)   = noisy image - deterministic clean image
  SNR_power  = Σ signal(p)² / Σ noise(p)²     over the evaluation aperture
  SNR_dB     = 10 · log10(SNR_power)
```

The aperture is a fixed box around the designated target's true projected centre.
Both images come from the same deterministic realization, so the difference is
the noise field and nothing else.

When no stochastic noise is configured the denominator is zero and the ratio is
undefined. It is reported as **not applicable — no stochastic noise** rather than
as infinity, and never as 0 dB. The algorithm never receives it.

## What this model does NOT do

| Not modelled                            | Consequence                                                                                           |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Wave-optics propagation                 | Scintillation and wander are camera-domain proxies with configured statistics, not derived from `Cn²` |
| Gamma-Gamma / strong turbulence         | The log-normal model is bounded to the weak-to-moderate regime it is defensible in                    |
| Calibrated radiometry                   | Intensity is relative; there are no watts, no electrons and no photon counts                          |
| Poisson photoelectron statistics        | The shot-noise approximation is normal with a square-root standard deviation                          |
| Aperture averaging                      | Scintillation acts on the whole spot uniformly                                                        |
| Wavelength dependence                   | One broadband channel; attenuation is a single dB/km                                                  |
| Motor torque disturbance                | Base attitude only; the Phase 3 actuator hook is unused                                               |
| Rolling shutter                         | The exposure window is global                                                                         |
| Dead or hot pixels, fixed-pattern noise | Every pixel has identical statistics                                                                  |
| Lens distortion, glare, bloom, smear    | The projection is an exact pinhole and the PSF is a Gaussian                                          |
| Occlusion                               | Nothing blocks anything                                                                               |
| Beacon identity of any kind             | Deliberate: Phase 8's subject                                                                         |

## Presets

Reproducible engineering profiles, named for what they contain. None is
calibrated against a measured environment, a flight campaign or a published link
budget, so none is named after one.

| Preset                   | Contains                                                                                             |
| ------------------------ | ---------------------------------------------------------------------------------------------------- |
| `CLEAN`                  | nothing; the Phase-6 sensor exactly                                                                  |
| `MILD_MOBILE`            | small multi-tone base motion, light haze, weak scintillation, finite exposure, a little sensor noise |
| `VIBRATION_HEAVY`        | base motion an order of magnitude larger, still inside the mount's rate and acceleration limits      |
| `VIBRATION_BEYOND_MOUNT` | base motion the mount physically cannot follow; both algorithms are expected to fail                 |
| `LOW_CONTRAST`           | attenuation, ambient background, defocus and sensor noise                                            |
| `FRAME_LOSS`             | bursty delivery loss                                                                                 |
| `SENSOR_NOISE`           | read and shot noise alone                                                                            |
| `COMBINED_STRESS`        | several moderate effects together                                                                    |

A preset is a convenience for populating a scenario, **never a record of one**.
Every parameter is copied into the scenario document and fingerprinted with it,
so a run stays fully described even if a preset is later retuned or deleted.
`disturbances.preset` carries the name for provenance only, and nothing reads it
back to reconstruct values.
