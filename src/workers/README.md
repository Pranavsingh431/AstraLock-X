# `workers`

Web Workers that keep long computations off the render thread — the simulation
tick loop and batch benchmark runs.

Worth noting for isolation: `postMessage` uses structured clone, which copies
own enumerable string-keyed properties and silently drops symbol-keyed ones.
The ground-truth brand is therefore a string key rather than a symbol, so it
survives the crossing and `assertGroundTruthFree` still works on the far side,
where static types have been erased.

_Arrives in Phase 5. Empty by design at Phase 0._
