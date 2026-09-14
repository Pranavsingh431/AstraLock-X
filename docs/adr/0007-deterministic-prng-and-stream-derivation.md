# ADR-0007: xoshiro128\*\* with per-subsystem stream derivation

- **Status:** Accepted
- **Date:** 2026-09-14
- **Phase:** Phase 1

## Context

ADR-0004 committed the project to reproducible runs and deferred the mechanism.
Phase 1 needs it: the seeded manoeuvre family generates its whole schedule from
randomness, and Phase 2 will add sensor noise and base-motion disturbance.

Three requirements shape the choice.

The generator must be **exactly reproducible across engines**. JavaScript has no
integer type, so an algorithm expressed in floating point is at the mercy of
rounding; one expressed in 32-bit integer operations is not, because `Math.imul`
and `>>>` are exactly specified.

Subsystems must be **independent**. If every subsystem drew from one sequence,
adding a noise source to the camera model would shift every draw the trajectory
model makes, and every previously recorded run would silently become a different
run for a reason unrelated to the change.

The stream position must be **serializable**, so a paused run resumes exactly
and a saved run reloads exactly.

## Decision

**Generator: xoshiro128\*\*** (Blackman and Vigna). A published, citable
algorithm with a reference implementation, 128 bits of state, a period of
2^128 - 1, and an inner loop that is entirely 32-bit shifts, xors, rotations and
multiplications. `Math.imul` and `>>>` express those exactly, so the sequence is
identical on any conforming engine.

**Seeding: SplitMix32.** The four-word state is expanded from a 32-bit stream
seed by iterating the SplitMix32 finalizer, which is the procedure the xoshiro
authors recommend. An all-zero state — a fixed point of the generator — is
checked for and replaced, because the generator would otherwise be silently dead.

**Stream derivation:**

```
  streamSeed(root, name) = splitMix32( splitMix32(root) XOR fnv1a32(name) )
```

The root is mixed first, then combined with a 32-bit FNV-1a hash of the stream
name, then mixed again. Mixing _after_ the combination matters: `root XOR
nameHash` alone gives correlated seeds to names whose hashes differ in few bits,
and consecutive root seeds are the common case in a sweep.

Streams are named and fixed in one place: `trajectory`, `environment`,
`platform`, `sensor`, `disturbance`. The last two are reserved for Phase 2 and
are declared now, before anything depends on the derivation, because each name
derives independently — adding a name later cannot perturb the streams that
already exist.

**Gaussians consume two draws and discard one.** Box-Muller produces two
variates; caching the second would halve the cost but place state outside the
generator, so a snapshot taken between the two calls would not restore the same
sequence. Correctness of pause and resume is worth more than the draws.

**No `Math.random` anywhere.** A lint rule blocks it, with a message pointing at
ADR-0004. No cryptographic randomness either: it is not reproducible, which is
the one property that matters here.

## Consequences

- A run is reproducible from its config and seed, and the seeded manoeuvre
  scenario is tested to reproduce bit-for-bit over 100,000 ticks.
- Adding a stochastic subsystem later cannot disturb existing recorded runs,
  which is tested directly: draws taken from three streams leave a fourth
  stream's sequence untouched.
- Stream position round-trips through JSON, so pause, resume and reload all
  reproduce the sequence.
- Every stochastic subsystem must remember to use its own stream. Nothing
  enforces the _choice_ of stream; the streams themselves are enforced by
  there being no other source of randomness.
- The generator is not cryptographically secure. It does not need to be, and
  saying so here should stop anyone reaching for `crypto.getRandomValues`
  because it sounds better.
- Reproducibility of the _generator_ is exact on any engine. Reproducibility of
  the _simulation_ remains per-architecture, because the physics is
  double-precision floating point; ADR-0004 already records that limit.

## Alternatives considered

**PCG32.** Better statistical reputation and a very clear paper. Rejected
because its state is 64-bit, which JavaScript can only express through BigInt —
slow in a per-tick path — or through a hand-split 64-bit emulation, which is
exactly the kind of fiddly code that silently diverges between implementations.

**Mulberry32 or a small xorshift.** Simpler and adequate for a toy. Rejected on
state size: 32 bits of state gives a period around 4 billion, which a long
benchmark sweep could plausibly exhaust, and short-period artefacts in a noise
model would be indistinguishable from a real effect.

**One global generator with subsystems drawing in a fixed order.** Simplest
possible. Rejected for the reason the whole design exists: it couples every
subsystem to every other, so no recorded result survives an unrelated change.
