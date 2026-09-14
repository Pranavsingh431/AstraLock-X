# The gimbal model

How AstraLock-X turns a pointing command into a camera pose.

Phase 2 used an ideal mount: commanding a pose set that pose, exactly and
immediately. That was a deliberate simplification while the optics were being
got right, and it is gone. This document describes what replaced it, what it
does not model, and how accurate it is.

The implementation is `src/core/gimbal/`. The public, algorithm-safe types are
in `src/core/contracts/gimbal.ts`.

## What a mount is, here

Two independent axes — **pan** and **tilt** — each a second-order servo driving
a load through imperfect gearing, reported by a finite-resolution encoder.

Commands go in. An **image** comes out. In between sit six effects, each
separately configurable and separately testable:

```
  command ──▶ latency queue ──▶ setpoint (clamped to travel)
                                     │
                                     ▼
                                  deadband
                                     │
                                     ▼
                              second-order servo
                                     │
                            acceleration limit
                                     │
                                   rate limit
                                     │
                                     ▼
                             motor angle ──▶ travel stop
                                     │
                                     ▼
                                 backlash
                                     │
                                     ▼
                          OUTPUT ANGLE ─────▶ forms the image
                                     │
                                     ▼
                              encoder quantiser
                                     │
                                     ▼
                        MEASURED ANGLE ─────▶ goes on the frame
```

## Three states, not one

The single most important thing in this model is that "where the mount is
pointing" is three different quantities, and conflating them would make the
whole exercise pointless.

| State        | Meaning                       | Who may read it                       |
| ------------ | ----------------------------- | ------------------------------------- |
| **COMMAND**  | What was asked for            | Anyone — the operator asked for it    |
| **TRUE**     | Where the optics actually are | Simulator, evaluation, debug views    |
| **MEASURED** | What the encoder reports      | Anyone, including a future controller |

Image formation uses **TRUE**, because that is where the lens is. The frame
carries **MEASURED**, because an encoder count is all a real system gets. They
differ by up to half a count at every instant, and that difference is a
permanent fact of the instrument rather than an error to be removed.

See `docs/adr/0011-true-versus-measured-actuator-state.md`.

## The axis model

Each axis is the standard second-order system

```
  x'' + 2·ζ·ω·x' + ω²·x = ω²·u        ω = 2π·naturalFrequency
```

integrated with **semi-implicit (symplectic) Euler**: the rate is updated first
and the new rate moves the angle.

```
  e      = deadband(setpoint − motorAngle)
  a_raw  = ω²·e − 2·ζ·ω·motorRate
  a      = clamp(a_raw, ±maxAcceleration)
  rate′  = clamp(motorRate + a·dt, ±maxRate)
  angle′ = clamp(motorAngle + rate′·dt, minAngle, maxAngle)
```

Semi-implicit rather than forward Euler because forward Euler _injects_ energy
into an oscillator: an axis left alone would slowly gain amplitude, which looks
exactly like a badly tuned servo and is in fact a broken integrator. The
symplectic form does not. `numerics.test.ts` checks this directly.

`dt` is a parameter, not a constant, because a command falling due mid-tick
splits the tick in two.

### Stability bound

The closed-form path has no stability condition — it is the analytic answer, and
is well behaved even at `ω·dt = 2`. The clamped Euler fallback does. The
scenario schema therefore still **rejects** any configuration where

```
  ω·dt = 2π·naturalFrequency / tickRate  >  0.5
```

(`MAX_SERVO_OMEGA_TIMESTEP` in `src/core/contracts/gimbal.ts`). This is a
validation error at load time, not a runtime surprise. Its meaning changed with
ADR-0012: it now guards the saturated fallback rather than the main path.

### Accuracy

The unsaturated path is exact. Measured against the closed-form step response,
peak error as a fraction of the commanded step, at the bundled 200 Hz tick:

| Profile                            | ω·dt  | Phase 3 (Euler) | Now (closed form) |
| ---------------------------------- | ----- | --------------- | ----------------- |
| Near-ideal (12 Hz, ζ = 0.9)        | 0.377 | 13.3%           | 4 × 10⁻¹⁴%        |
| Realistic-lab pan (6 Hz, ζ = 0.65) | 0.189 | 7.3%            | 7 × 10⁻¹⁴%        |
| Realistic-lab tilt (5 Hz, ζ = 0.7) | 0.157 | 5.9%            | 7 × 10⁻¹⁴%        |

That is floating-point noise, in every damping regime, at every step size.
Settling-time difference against the continuous solution is zero.

The saturated fallback remains first-order in the step. A scenario that spends
most of its time against the acceleration limit gets that accuracy, which is
what the `ω·dt` bound above is now for.

## The six effects

### 1. Command latency

A command issued at `t` becomes active at `t + commandLatency`, in **simulated**
time. It is applied at its **exact** due time by splitting the integration
there, so a 23 ms latency under a 5 ms tick stays 23 ms rather than being
rounded to 20 or 25. The cost is that sub-steps have unequal lengths and the
discrete response is not bit-identical to one taken in uniform steps; that is
inherent to representing a delay exactly, it remains deterministic because the
split points are a function of the command times, and the alternative is a mount
whose delay silently depends on the tick rate.

Commands are ordered by due time, ties broken by command id, so a batch is
deterministic. A command issued while the run is paused changes nothing until
the run advances — a stationary mount does not move because someone typed a
number.

### 2. Deadband

Subtractive, not a threshold:

```
  |e| ≤ B  →  0
  e >  B   →  e − B
  e < −B   →  e + B
```

A threshold that switched from zero to the full error at the boundary would step
the demanded acceleration, and the integrator would turn that discontinuity into
a visible tick in the image every time the axis crossed it. The subtractive form
grows continuously from zero.

Consequence worth knowing: a settled axis normally carries a residual error of
about the deadband width. It parks _within_ the band, not at the setpoint.

### 3. Servo dynamics

Above. `naturalFrequency` and `dampingRatio` per axis.

### 4. Rate and acceleration limits

Hard clamps on the integrator, with flags (`rateSaturated`,
`accelerationSaturated`) reporting when they bind. The privileged truth record
carries both the acceleration the servo _demanded_ and the one it _got_.

A mechanical stop is an impulse and sits outside the acceleration budget by
definition: on contact, outward rate is set to zero rather than being allowed to
accumulate, so the axis does not store momentum and leap the instant it is
commanded back inward.

### 5. Backlash

The play operator:

```
  output′ = clamp(output, motor − B/2, motor + B/2)
```

Moving in one direction the load rides the leading face of the gap and follows
exactly. On a reversal the motor crosses the whole gap — `B` radians — before
touching the other face, and during that crossing **the load does not move at
all**. That is genuine hysteresis: the output depends on the direction of
approach, not merely on the current motor angle, and the same motor angle gives
two different camera poses depending on which way it was reached.

With `B = 0` the clamp collapses to `output = motor`, exactly direct coupling,
with no special case.

The effect is visible in the image, not just in the state: `sensor-integration.test.ts`
finds frames during which the motor moves and the picture does not.

### 6. Encoder quantisation

```
  measured = round(true / resolution) · resolution
```

A real loss of information, not cosmetic rounding. The reported angle is within
half a count of the truth and is generally not equal to it.

**Rate is not sensed.** There is no tachometer in this model. The reported rate
is differenced from successive encoder _readings_ —

```
  derivedRate = (measured_k − measured_{k−1}) / (t_k − t_{k−1})
```

— which is what a controller differencing its own encoder history would actually
get, quantisation noise included. Reporting the true rate would hand a future
controller a measurement no real system has.

## Sampling between ticks

The camera runs on its own clock (ADR-0010), so most frames fall between physics
ticks. A trajectory can simply be evaluated at the capture time, because Phase 1
made trajectories pure functions of time. **A stateful mechanism cannot be.**

So the mount keeps a bounded ring of pointing samples at tick boundaries, and a
capture between ticks interpolates the two bracketing samples.

**Linearly, not along the shortest arc.** These are _bounded joint_ coordinates,
not free bearings. The axis has hard stops and physically cannot take the short
way round through them, so wrapping the interpolation would invent a motion the
mechanism cannot make. World bearings, which do wrap, use shortest-path
interpolation elsewhere; the difference is deliberate.

Times outside the retained history clamp to its ends rather than extrapolating,
since extrapolating a servo response would invent motion.

## Configuration

Per axis: `initialAngle`, `minAngle`, `maxAngle`, `maxRate`, `maxAcceleration`,
`naturalFrequency`, `dampingRatio`, `deadband`, `backlash`, `encoderResolution`.
Plus one shared `commandLatency`.

Initial pointing has exactly **one** source: `gimbal.pan.initialAngle` and
`gimbal.tilt.initialAngle`. Schema v4 removed the duplicate
`camera.initialAzimuth` / `camera.initialElevation` fields, which were a second
declaration of the same fact and could disagree with it.

Two reference profiles ship with the bundled scenarios:

| Profile           | Deadband | Backlash   | Encoder | Latency | Bandwidth |
| ----------------- | -------- | ---------- | ------- | ------- | --------- |
| **Ideal**         | ~0       | 0          | 0.0005° | 0       | 12 Hz     |
| **Realistic lab** | 0.0005°  | up to 0.5° | 0.02°   | 0–23 ms | 8 Hz      |

`gimbal-step-response`, `gimbal-latency` and `gimbal-backlash` are the scenarios
that isolate each effect. The latency scenario uses 23 ms deliberately: it is
not a multiple of the 5 ms tick, so a mount that rounded delays to tick
boundaries would fail it.

## Cost

Measured on the development machine (Apple Silicon, Node 24), median of five
runs of 200,000 ticks:

| Path                              | Per tick | Share of the 5 ms budget |
| --------------------------------- | -------- | ------------------------ |
| Mount only                        | 0.25 µs  | 0.005%                   |
| Engine tick (world + mount)       | 0.19 µs  | 0.004%                   |
| Engine + 640×480 camera at 60 FPS | 3.59 µs  | 0.072%                   |

The mount is two second-order integrations, a queue check and two roundings. If
it were anywhere near the tick budget the model would be wrong rather than slow.
The pointing history is a fixed-size ring, so a long run neither leaks nor slows
down; `engine-integration.test.ts` checks that directly.

## What this model does **not** include

Stated plainly, because an unstated omission is a lie by default:

1. **No disturbance.** `advanceTo` takes a `GimbalDisturbance` argument and it
   is always zero. The hook exists so base motion and wind loading can be added
   without reshaping the call path; nothing generates a non-zero value today.
2. **No friction model.** No stiction, no Coulomb friction, no breakaway torque.
   The deadband is a crude stand-in for the pointing consequence of stiction,
   not a model of it.
3. **No structural flexibility.** The load is rigidly coupled to the motor apart
   from the backlash gap. No resonance, no ringing of the structure itself.
4. **No thermal or gravitational effects.** No drift with temperature, no sag,
   no unbalanced-load torque that varies with tilt.
5. **No motor model.** No current loop, no back-EMF, no torque ripple, no
   cogging. `maxAcceleration` stands in for the whole of it.
6. **No encoder faults.** No bias, no non-linearity, no missed counts, no
   eccentricity. Quantisation only.
7. **No axis cross-coupling.** Pan and tilt are fully independent. A real
   two-axis mount has inertial coupling between them.
8. **Reporting is instantaneous.** The encoder reading is available at the same
   instant it is taken; there is no measurement transport delay. Only _command_
   latency is modelled.

Items 1–8 are not defects to be hidden behind a plausible-looking number. Where
a quantity is not modelled, nothing in the interface claims it is.
