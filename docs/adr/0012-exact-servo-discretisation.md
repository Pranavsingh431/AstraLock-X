# ADR-0012: The servo's unsaturated step is taken in closed form

- **Status:** Accepted
- **Date:** 2026-09-14
- **Phase:** Phase 4 (preflight)

## Context

Phase 3 integrated each gimbal axis with semi-implicit (symplectic) Euler. That
was a defensible choice: it is stable to far larger steps than forward Euler and
does not inject energy into an oscillator, so an axis left alone does not slowly
gain amplitude. Its accuracy was measured and reported honestly — first order in
the step, several percent of a commanded step in peak transient error.

Phase 4 puts a pointing controller around that plant, and the Phase 4 preflight
required the numerical quality of the **shipped profiles** to be checked before
any gain was tuned. Measured against the closed-form step response, in the
unsaturated, no-backlash, no-deadband case, at the bundled 200 Hz tick:

| Profile                          | ω·dt  | Peak error | RMS transient | Settling difference |
| -------------------------------- | ----- | ---------- | ------------- | ------------------- |
| Near-ideal (12 Hz, ζ = 0.9)      | 0.377 | **13.3%**  | 7.0%          | +10 ms              |
| Realistic-lab pan (6 Hz, ζ=0.65) | 0.189 | **7.3%**   | 3.4%          | −10 ms              |
| Realistic-lab tilt (5 Hz, ζ=0.7) | 0.157 | **5.9%**   | 2.8%          | −20 ms              |

All three exceed the 5% gate, and the near-ideal profile — the one named for its
fidelity — is the worst, because its higher bandwidth gives it the largest
`ω·dt`.

This matters more for Phase 4 than it did for Phase 3. A pointing controller
tuned against this plant would have been partly compensating for the
integrator's error rather than for the mechanism, and the gains would then be
wrong for any other tick rate. A 13% error in the step response is comparable to
the pointing error the whole loop is trying to remove.

## Decision

While no limit binds, take the step in **closed form**.

The axis obeys `x'' + 2ζωx' + ω²x = ω²u`, and while `u` is constant that is
linear and time-invariant. Writing the error `e = x − u`, the state `[e, ė]`
advances by the matrix exponential `Φ(dt) = exp(A·dt)` with
`A = [[0, 1], [−ω², −2ζω]]`. Applying Φ is exact — the analytic solution
evaluated at the step boundary, not an approximation that improves as the step
shrinks. Three damping regimes are written separately, because a single
expression degenerates to 0/0 at ζ = 1.

The deadband does not spoil this. Outside the band the subtractive dead zone is
affine in the angle, so the dynamics remain LTI about a shifted setpoint; inside
it the servo demand is zero and the axis coasts under damping alone.

When the acceleration or rate limit binds, the system is genuinely nonlinear and
there is no closed form, so the step falls back to the Phase 3 clamped
semi-implicit Euler. That is acceptable where it applies: a saturated axis is
moving at a constant clamped acceleration or a constant clamped rate, and Euler
integrates both exactly in the rate.

Saturation is decided from the demand at the start of the step and then
re-checked two further ways — against the mean acceleration the exact step
implies, and against the demand at the far end. The first check alone is not
enough: on the step where a fast-moving axis first comes out of acceleration
saturation, the linear solution asks for more acceleration part-way through than
the mechanism has. A hard acceleration limit is a property of the plant, so the
linear path may only be used where the plant could genuinely have followed it.

## Consequences

**Good.**

- Discretisation error on the unsaturated path falls from 13.3% to ~4 × 10⁻¹⁴%
  — floating-point noise — across every damping regime, at every step size, for
  both shipped profiles. Settling-time difference is zero.
- The Phase 4 controller is tuned against the mechanism rather than against the
  integrator, and its gains mean the same thing at any tick rate.
- The exact transition has no stability condition, so it is well behaved even at
  `ω·dt = 2`, four times the bound Euler needed.
- Cost is negligible: Φ depends only on `(ω, ζ, dt)`, and `dt` is the fixed tick
  on all but the split steps, so it is computed once and cached.

**Costs and risks.**

- Two integration paths instead of one, and a saturation test that decides
  between them. The test is conservative — when in doubt it takes the clamped
  path — but it is a place a future edit could get subtly wrong, so the axis
  tests exercise both branches explicitly.
- The saturated path is still first-order. A scenario that spends most of its
  time against the acceleration limit gets Phase 3's accuracy, which is why
  `MAX_SERVO_OMEGA_TIMESTEP` is retained: it no longer guards the unsaturated
  path, which needs no guarding, but it still guards the Euler fallback.
- Phase 3's recorded accuracy figures are superseded. They are kept in
  `docs/PHASE_STATUS.md` as the measurement that motivated this change rather
  than deleted, because the history is the reason the decision was made.

**Rejected alternatives.**

_Raise the tick rate._ At 800 Hz the near-ideal profile still errs by 3.1%, and
every scenario would cost four times as much to run. It treats a modelling
defect as a budget problem.

_Lower the default natural frequency._ This would change the plant to make the
numbers look better — the preflight explicitly forbids altering the plant to
make tracking easier, and a slower mount is an easier mount.

_RK4 throughout._ Fourth-order and still approximate, four force evaluations per
step instead of one matrix multiply, and no benefit over a method that is exact.
