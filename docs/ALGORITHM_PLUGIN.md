# Writing a tracking algorithm

How to add an algorithm to AstraLock-X, what it is given, what it must return,
and — the part that matters most — what it cannot reach.

The short version: a plugin is written against `src/core/contracts/`, and
nothing else. `src/core/algorithms/example/plugin.ts` is a complete worked
example whose only imports are that directory. If you find yourself needing to
import the simulator, the sensor or the evaluator, the contract is missing
something and that is a bug worth reporting rather than working around.

## The contract

```ts
interface AlgorithmPlugin<TConfig, TDebug> {
  readonly manifest: AlgorithmManifest<TConfig>;
  create(init: AlgorithmInit<TConfig>): AlgorithmInstance<TDebug>;
}

interface AlgorithmInstance<TDebug> {
  update(input: TrackingInput): TrackingOutput<TDebug>;
  reset(): void;
  dispose?(): void;
}
```

The manifest carries an id, a name, a semantic version, a description, a **Zod
schema** for the configuration and a default configuration. A runtime schema
rather than a type alone, because the harness validates a configuration before
constructing anything and the Scenario Lab builds a form from it.

Register the plugin in `src/core/algorithms/index.ts` with a `kind`:

- `tracker` — a real algorithm, eligible for benchmark comparison.
- `reference` — a worked example that does not track. Kept out of comparisons,
  because measuring a tracker against a non-tracker produces a number that
  flatters the tracker and measures nothing.

Registration is a source change, and deliberately so. There is no path that
loads a plugin from a URL, a downloaded bundle or a string of JavaScript: a
benchmark host that executed arbitrary code on the operator's machine would be a
much larger security question than a benchmark deserves. What the contract buys
is that adding an algorithm requires no change to the simulator.

## What arrives

`AlgorithmInit`, once, at construction:

| Field        | What it is                                                        |
| ------------ | ----------------------------------------------------------------- |
| `config`     | Your own configuration, already validated against your schema     |
| `camera`     | Camera configuration and the **believed** calibration             |
| `gimbal`     | Measured mount state at the start of the run                      |
| `tickRate`   | The rate `update` will be called at                               |
| `random`     | A seeded uniform stream on `[0, 1)`                               |
| `tickBudget` | Wall-clock budget per tick, for reporting rather than enforcement |
| `prior`      | An optional mission prior, when the operator configured one       |

`TrackingInput`, every tick:

| Field             | What it is                                                   |
| ----------------- | ------------------------------------------------------------ |
| `tick`, `time`    | The tick index and its simulated instant                     |
| `frame`           | The captured frame, or `null` when none was delivered        |
| `camera`          | Camera configuration and believed calibration                |
| `gimbal`          | Measured mount state: quantised, biased, latent              |
| `previousCommand` | The command the runtime issued for you last time, as stamped |

That is the entire surface. A dropped frame is `null` — not a flag, not a black
image — because a camera that produced no frame cannot tell anyone it did not.

**Use `init.random`, never `Math.random`.** The stream is derived from the run
seed and is independent of the simulator's streams, so a stochastic algorithm
replays exactly and cannot perturb the physics (ADR-0004). This is what makes a
benchmark's arms comparable: whichever algorithm is flying, the vibration, the
scintillation and the dropped frames are the same.

## What you cannot reach, and why it is enforced five ways

No plugin receives the simulation engine, the mount object, world entities, the
evaluator, sensor truth, a target trajectory, an emitter identity or a
designated-target index. That is enforced by five independent mechanisms, so
that no single mistake defeats it:

1. **Compile-time proofs** in `src/core/contracts/isolation.ts` — a type that
   can reach ground truth is rejected by the type system.
2. **`defineAlgorithm` admission** — a plugin whose own config or debug type is
   tainted, or merely unprovable, fails to register. Unprovable fails closed.
3. **An ESLint import barrier** — algorithm files cannot import the simulator,
   sensor internals or the evaluator, verified by real-ESLint probe files.
4. **`guardTrackingInput` at runtime** — the harness checks what it is about to
   hand over.
5. **`.test-d.ts` proofs** over the concrete config and debug types.

Running inside a benchmark grants nothing extra. `astrabench.test.ts` asserts
the exact key set of `TrackingInput` from inside a benchmark run.

## What you return

`TrackingOutput` carries observations, estimates, a PAT state, an optional debug
payload, and a **command intent**:

```ts
type CommandIntent = { kind: 'position'; azimuth: Radians; elevation: Radians } | { kind: 'hold' };
```

An intent carries **no timestamp**. You say where you want the mount pointed;
the runtime decides when that request entered the physical system and stamps it.
The separation is not cosmetic — an algorithm that could write `issuedAt` itself
could back-date a command to the frame's capture time and act in the past, which
real software cannot do (ADR-0013).

The debug payload is bounded by `GroundTruthFree`, so it cannot become a back
channel out of the algorithm either.

## The expected beacon pattern is configuration

If your algorithm recognises a coded beacon, the pattern it expects belongs in
**your configuration**, and it must not be derived from the scenario.

This is worth stating plainly because Phase 8 got it wrong and Phase 9 corrected
it. The application used to read the designated emitter's `identityCode` out of
the loaded scenario and copy it into the tracker's configuration. Every measured
result was still honest — the algorithm never saw the scenario — but no
arrangement of scenario and algorithm could produce a genuine identity failure,
because the receiver always agreed with the emitter. A benchmark in which one
arm cannot lose is not a benchmark.

Now the expected pattern is a **terminal profile** the operator or the benchmark
arm selects: a sequence and a symbol duration, the two numbers a mission card
would carry. A terminal expecting code A flown against a beacon transmitting
code B fails to acquire, exactly as a misconfigured real terminal would, and
`expected-code-independence.test.ts` measures it. See
[BEACON_IDENTITY.md](BEACON_IDENTITY.md).

## Checklist

- [ ] Imports only from `src/core/contracts/`.
- [ ] A Zod schema and a default configuration on the manifest.
- [ ] `reset()` returns the instance to its just-constructed state.
- [ ] Stochastic behaviour draws from `init.random`.
- [ ] No `Math.random`, no `Date.now`, no wall clock in any engineering path.
- [ ] Registered in `src/core/algorithms/index.ts` with the right `kind`.
- [ ] The debug payload names evidence, not the world.
