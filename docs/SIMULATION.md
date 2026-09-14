# The simulation core

What the simulator computes, how it is kept reproducible, and — just as
importantly — what it does not model yet.

Everything here is plain TypeScript in `src/core/simulation`. It runs without
React, without Three.js, without WebGL and without a DOM, which is checked by
lint and exercised by a test suite that runs in the plain Node environment. The
3D view is a consumer of this core, never its owner (ADR-0006).

---

## Coordinate system

**Frame: `world-enu`.** X is East, Y is North, Z is Up, in metres. Right-handed:
`East × North = Up`. The origin is the scenario datum, and the frame is treated
as inertial.

**Azimuth** is measured clockwise from North about +Up, wrapped to (−π, π]:
North is 0, East is +π/2. This is a left-handed rotation about +Up even though
the frame is right-handed — the compass convention every pointing mount uses.

**Elevation** is positive upward from the horizontal plane, in [−π/2, +π/2].
Zero is the local horizon.

Azimuth is undefined for a target directly overhead; it is reported as zero,
with elevation carrying the full answer, rather than NaN.

### Renderer mapping

Three.js is Y-up. The conversion happens in exactly one place,
`coordinates.ts`, and only in one direction:

```
  renderer.x =  east
  renderer.y =  up
  renderer.z = −north
```

North maps to −Z so a default Three.js camera, which looks down −Z, faces North:
the scene reads like a map. The mapping has determinant +1, so it preserves
handedness — a mirrored mapping would pass a naive axis check while flipping
every cross product and every azimuth drawn on screen, which is why there is a
test for it specifically. Scene units are metres; there is no scale factor.

## Units

Physical quantities use the branded types from Phase 0, so passing degrees where
radians belong is a compile error. Radians are canonical inside the core;
degrees appear only at configuration and display boundaries.

| Quantity     | Unit                                 |
| ------------ | ------------------------------------ |
| Position     | metres                               |
| Velocity     | metres per second                    |
| Acceleration | metres per second squared            |
| Time         | seconds, derived from the tick index |
| Angle        | radians                              |
| Angular rate | radians per second                   |

## Run bounds

A scenario declares a duration, and the run ends there: the final tick is
`floor(duration * tickRate)`, and `step` will not go past it. Without that, an
interactive session left running would keep producing ticks past the end of the
experiment — still "playing", but no longer the experiment anyone configured,
and for a seeded manoeuvre already past the end of its generated schedule into
the coast regime.

Deliberate overrun is still possible for tests and headless exploration, through
`step(n, { beyondDuration: true })`. It has to be asked for.

## Clock

The authoritative quantity is an **integer tick index**. Simulated time is
derived, never accumulated:

```
  time = tick / tickRate
```

`t += dt` would drift and, worse, would make the result depend on how ticks were
grouped. Deriving from a counter makes `step(1)` a thousand times and
`step(1000)` once identical by construction.

Wall-clock time decides _how many_ ticks to run and nothing else.
`PlaybackScheduler` performs that translation: it takes elapsed seconds and
returns a whole tick count plus a sub-tick remainder. It never touches
`requestAnimationFrame` or the DOM, so it is ordinary testable code.

- **Catch-up is bounded.** A backgrounded tab reports an enormous delta; the
  scheduler emits at most `maxTicksPerAdvance` ticks and drops the backlog
  rather than carrying an unpayable debt. Simulated time stays exact; the
  animation slips.
- **Pausing costs nothing.** Time spent paused is not owed on resume.
- **Playback speed scales throughput, not physics.** The world at a given
  simulated time is identical at 0.25× and 4×.

See ADR-0008.

## Deterministic randomness

**Generator: xoshiro128\*\*** (Blackman & Vigna) — 128-bit state, period
2^128 − 1, and an inner loop of only 32-bit operations, which JavaScript
expresses exactly through `Math.imul` and `>>>`. State is expanded from a 32-bit
stream seed with SplitMix32.

**Stream derivation:**

```
  streamSeed(root, name) = splitMix32( splitMix32(root) XOR fnv1a32(name) )
```

Named streams: `trajectory`, `environment`, `platform`, `sensor`,
`disturbance`. The last two are reserved for Phase 2 and declared now, because
each name derives independently and adding one later must not perturb the
others.

Adding draws to one stream does not change another's sequence. That is the
property the whole design exists for, and it is tested directly.

Gaussians consume two draws and discard one: caching the second would put state
outside the generator, and a snapshot taken between the two calls would not
restore the same sequence.

`Math.random` is blocked by lint. There is no cryptographic randomness — it is
not reproducible, which is the only property that matters here.

See ADR-0007.

## Trajectories

A trajectory is a **pure function of simulated time**. `sampleAt(t)` returns the
same state for the same `t` regardless of how many times it is called, in what
order, or how the run got there. Velocity and acceleration are the analytic
derivatives of position, not finite differences across ticks — differencing
would make the reported rate depend on the timestep and add noise no real target
produced.

### Stationary

```
  p(t) = p0        v = 0        a = 0
```

### Linear

```
  p(t) = p0 + v0 t        v(t) = v0        a(t) = 0
```

### Circular

With `u`, `w` an orthonormal basis of the plane whose normal is `n`, and
`θ = φ0 + ω t`:

```
  p(t) = c + R (cos θ · u + sin θ · w)
  v(t) = R ω (−sin θ · u + cos θ · w)
  a(t) = −R ω² (cos θ · u + sin θ · w) = −ω² (p − c)
```

The acceleration is centripetal: magnitude `ω²R`, pointing at the centre. The
basis is built by Gram-Schmidt against whichever world axis is least aligned
with the normal, which is well conditioned for every normal and — more
importantly — deterministic, since the initial phase is measured from `u`.

### Sinusoidal

Constant-velocity base motion plus any number of sinusoids, with
`ωᵢ = 2π fᵢ`:

```
  p(t) = p0 + v0 t + Σ Aᵢ sin(ωᵢ t + φᵢ) dᵢ
  v(t) = v0        + Σ Aᵢ ωᵢ cos(ωᵢ t + φᵢ) dᵢ
  a(t) =           − Σ Aᵢ ωᵢ² sin(ωᵢ t + φᵢ) dᵢ
```

This is a real weaving manoeuvre in the authoritative state, not a wobble
applied to a rendered object.

### Waypoint

**Interpolation model for Phase 1: piecewise linear in time.** Position is
continuous. Velocity is constant within a segment and steps discontinuously at
each node. Acceleration is zero everywhere except at the nodes, where the true
value is an impulse that this model reports as zero.

That is a deliberate, documented simplification. A smooth spline would hide the
corner but invent accelerations nobody specified. A C¹ model can be added later
as a second option without changing this one.

Outside the schedule the target holds the first or last waypoint with zero
velocity, unless `loop` is set, in which case time wraps over the schedule's
span. Arrival times must strictly increase: a zero-duration segment demands
infinite speed and a decreasing one demands time travel, so both are rejected.

### Seeded manoeuvre

A reproducible sequence of bounded constant-acceleration legs, generated **up
front** from the `trajectory` stream and then frozen. Within a leg:

```
  p(τ) = p0 + v0 τ + a τ² / 2        v(τ) = v0 + a τ
```

Each leg draws exactly four values — duration, two for a direction uniform on
the sphere, and a magnitude — so the stream cursor is a function of the segment
count alone and never of the path the target took. Direction is sampled by
choosing `z` uniformly on [−1, 1] and the azimuth uniformly, which is exact
(Archimedes' theorem) and needs no rejection.

Speed is clamped to `maxSpeed` at every leg boundary. Beyond `boundsRadius` the
drawn direction is replaced by one pointing back at the origin — the draw is
still consumed, so the cursor does not depend on position.

Past the end of the schedule the target **coasts at constant velocity**. The
first implementation extrapolated the last leg's acceleration instead, which is
unbounded: a 500 s run against a 120 s schedule reached 1491 m/s against a
configured ceiling of 45. The long-run test found it.

The generated schedule is exposed for the debug inspector, so a run that went
wrong can be explained rather than guessed at.

## World state

`SimulationEngine` owns the world. It holds the clock, the random streams and
the trajectories, and produces `WorldState` snapshots on demand.

- **Snapshots are deep-frozen and branded as ground truth.** A component cannot
  reach through a rendered prop and edit the world; attempting to throws.
- **Snapshots are memoised per tick**, so observing more often costs nothing and
  — tested directly — changes nothing.
- **Entity ids are deterministic**: `target-0`, `target-1`, `platform-0`, derived
  from position in the config rather than from a counter or a UUID, so a stored
  result can be matched back to the entity it described.
- **`stateHash()`** is FNV-1a over the raw IEEE-754 bytes of the state, which is
  what makes repeatability checks meaningful down to the last bit.

## Determinism guarantee

A run is a pure function of `SimulationConfig` and `SimulationSeed`. Concretely,
and each of these is a test:

- The same config reproduces the same state, including over 100,000 ticks.
- `step(1)` × N equals `step(N)`.
- Reset returns exactly to the tick-zero state and replays identically.
- Interactive scheduling with irregular frame times reaches the same state as
  headless stepping.
- A pause in the driving loop changes nothing.
- Render interpolation rate changes nothing.
- Playback speed changes nothing at a given tick.
- Export and re-import reproduces the run.

Reproducibility is exact **on one architecture**. Floating-point results are not
guaranteed bit-identical across CPU architectures; ADR-0004 records that limit,
so cross-machine metric comparisons should use tolerances.

## What Phase 1 does NOT model

Stated explicitly, because the alternative is a plausible-looking number that
nothing computed. Each of these reports zero or null today:

| Not modelled                        | Consequence                                                                                                                   | Arrives             |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| Camera image formation              | No frames are produced; `frameCounter` is 0                                                                                   | Phase 2             |
| Received optical power              | `beaconPower` on a target state is `null` regardless of the configured transmit power — a link budget is a different quantity | Phase 2             |
| Occlusion                           | `visibility` is always 1                                                                                                      | Phase 2             |
| Sensor noise, quantisation, dropout | No sensor output exists yet                                                                                                   | Phase 2             |
| Gimbal servo and encoders           | The boresight is a fixed reference direction; rates are zero                                                                  | Phase 2–4           |
| Base-motion disturbance             | `disturbance` is zero although the scenario declares an RMS                                                                   | Phase 2             |
| Platform attitude dynamics          | `angularVelocity` is zero; the platform translates only                                                                       | Phase 2             |
| Target attitude                     | Targets are points with identity orientation                                                                                  | Later, if justified |
| Atmospheric propagation             | Declared in config, unused                                                                                                    | Phase 2             |
| Detection, estimation, control, PAT | Nothing tracks anything                                                                                                       | Phases 3–4          |

`inFieldOfView` **is** computed: it is a real rectangular field-of-view
containment test against the boresight, derived from the focal length and sensor
size. It is geometry only — no occlusion, no detectability, no image.

## Scenarios

Six bundled scenarios live in `src/scenarios`, one per trajectory family. They
are real documents loaded through the same validator an imported file uses, and
every one is parsed _and executed_ by the test suite, so a scenario that would
not run cannot ship.

A scenario is validated by Zod, including cross-field rules. Invalid input is
rejected rather than repaired: unknown trajectory kinds, negative radii,
zero-length plane normals, non-finite numbers, non-increasing waypoint times,
inverted manoeuvre durations, non-positive tick rates, and superseded schema
versions all fail with the offending field named.

Schema version 2 replaced a target's start position and velocity with a
trajectory. A version 1 document is rejected rather than migrated: guessing a
trajectory for a config that never specified one would be inventing the
experiment.

Export writes the validated config and nothing else — no camera pose, no
playback speed, no view toggles. Those describe how someone was looking at a
run, not what the run was.
