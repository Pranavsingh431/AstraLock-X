# `core/algorithms`

Concrete `AlgorithmPlugin` implementations and the registry that holds them.

The most tightly restricted directory in the codebase. Code here may not import
`core/contracts/ground-truth`, `core/simulation` or `core/metrics`, by lint
rule, and every plugin passes through `defineAlgorithm`, which rejects a plugin
whose own config or debug types could reach ground truth.

_Arrives in Phase 3. Empty by design at Phase 0._
