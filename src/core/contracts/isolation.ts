/**
 * Ground-truth isolation primitives.
 *
 * AstraLock-X exists to measure how well a tracker performs when it can only
 * see what a real sensor would see. That measurement is meaningless if the
 * tracker can read the simulator's answer key, so the separation is enforced
 * here rather than left to reviewer discipline.
 *
 * Four independent barriers guard it:
 *
 *   1. A brand on every ground-truth-bearing type ({@link GroundTruthTainted}).
 *   2. A type-level reachability check ({@link InspectGroundTruth}) that walks
 *      objects, arrays and function return types looking for that brand.
 *   3. Runtime detection ({@link assertGroundTruthFree}) for values that cross
 *      a worker or plugin boundary, where types have been erased.
 *   4. An ESLint import barrier over the tracking-side directories, so the
 *      ground-truth module cannot even be named there (see eslint.config.js).
 *
 * Both the type-level and runtime checks fail closed: anything they cannot
 * prove clean is treated as a leak.
 *
 * See docs/adr/0003-ground-truth-isolation.md.
 */

/**
 * Marker key carried by every ground-truth-bearing value.
 *
 * A real runtime property, not a phantom type, so one marker serves both the
 * compile-time check and the runtime check.
 *
 * It is deliberately a *string* key rather than a symbol. The runtime check
 * earns its keep at the worker and plugin boundary, and `structuredClone` —
 * which is what `postMessage` uses — copies own enumerable string-keyed
 * properties and silently drops symbol-keyed ones. A symbol brand would
 * therefore vanish at precisely the boundary it is meant to guard. The name is
 * prefixed to keep it clear of any plausible domain field.
 */
export const GROUND_TRUTH_BRAND = '__astraLockGroundTruth' as const;

/** Structural brand applied to types that carry simulator ground truth. */
export interface GroundTruthTainted {
  readonly [GROUND_TRUTH_BRAND]: true;
}

/**
 * Result of inspecting a type for reachable ground truth.
 *
 * - `clean`   proved to contain no ground truth;
 * - `tainted` proved to contain ground truth;
 * - `unknown` could not be decided within the inspection budget.
 *
 * The third state is the point of this design. A bounded type-level walk cannot
 * decide every type, and the only safe way to report that is to say so rather
 * than to answer "clean" and let a deep type through unchecked.
 */
export type GroundTruthVerdict = 'clean' | 'tainted' | 'unknown';

/**
 * Recursion budget for {@link InspectGroundTruth}.
 *
 * Twelve levels, against a measured worst case of six across the current
 * contracts (`TrackingOutput` -> `observations` -> `TargetObservation` ->
 * `pixelCovariance` -> outer tuple -> inner tuple -> `number`). The headroom is
 * deliberate; the budget is not a tuning knob for admitting deep types, because
 * exhausting it rejects rather than admits.
 */
export type GroundTruthInspectionDepth = 12;

type Decrement = {
  12: 11;
  11: 10;
  10: 9;
  9: 8;
  8: 7;
  7: 6;
  6: 5;
  5: 4;
  4: 3;
  3: 2;
  2: 1;
  1: 0;
  0: never;
};
type Depth = keyof Decrement;

/**
 * Walks `T` looking for the ground-truth brand, returning the union of every
 * verdict reached.
 *
 * A union is the natural result: a record whose fields are `clean` and
 * `tainted` yields `'clean' | 'tainted'`, and a caller that demands exactly
 * `'clean'` therefore rejects it. {@link IsProvablyGroundTruthFree} is that
 * caller.
 *
 * Two deliberate asymmetries:
 *
 * - `any` resolves to a union containing `'tainted'`, because `any` defeats
 *   checking altogether and a value the compiler cannot describe could be
 *   hiding anything.
 * - `unknown` resolves to `'clean'`. It is the safe top type — nothing can be
 *   read from it without narrowing first — and it is the declared default for
 *   a plugin that carries no config or debug payload.
 *
 * Exhausting the budget yields `'unknown'`, which callers must reject. A type
 * that recurses without bound, such as a self-referential JSON type, therefore
 * cannot be used on a plugin's surface; declare a concrete shape instead.
 */
export type InspectGroundTruth<T, D extends Depth = GroundTruthInspectionDepth> = [D] extends [
  never,
]
  ? 'unknown'
  : [T] extends [never]
    ? 'clean'
    : T extends GroundTruthTainted
      ? 'tainted'
      : // Fast path for leaves. Branded scalars such as `Meters` are
        // `number & { ... }`, and pixel buffers are typed arrays; without this
        // the walk would recurse through every method those carry. Binary
        // buffers are the legitimate sensor observable, so treating them as
        // clean is correct rather than merely convenient.
        [T] extends [
            | string
            | number
            | boolean
            | bigint
            | symbol
            | null
            | undefined
            | ArrayBufferView
            | ArrayBufferLike,
          ]
        ? 'clean'
        : T extends readonly (infer Element)[]
          ? InspectGroundTruth<Element, Decrement[D]>
          : T extends (...args: never[]) => infer Return
            ? InspectGroundTruth<Return, Decrement[D]>
            : T extends object
              ? [keyof T] extends [never]
                ? 'clean'
                : {
                    [K in keyof T]-?: InspectGroundTruth<T[K], Decrement[D]>;
                  }[keyof T]
              : 'clean';

/**
 * `true` only when every path through `T` was proved clean.
 *
 * Note the tuple wrapper: it stops the conditional distributing, so a verdict
 * union of `'clean' | 'unknown'` fails the test rather than partially passing.
 */
export type IsProvablyGroundTruthFree<T> = [InspectGroundTruth<T>] extends ['clean'] ? true : false;

/**
 * `T` when it is provably ground-truth-free, otherwise `never`.
 *
 * Fails closed: a type the walk could not decide collapses to `never` just as a
 * tainted one does.
 */
export type GroundTruthFree<T> = IsProvablyGroundTruthFree<T> extends true ? T : never;

/** Diagnostic surfaced when a type demonstrably reaches ground truth. */
export interface GroundTruthReachable<T> {
  readonly __astraLockError: 'Ground truth is reachable from this type (ADR-0003)';
  readonly offendingType: T;
}

/**
 * Diagnostic surfaced when a type nests deeper than the inspection budget.
 *
 * Distinct from {@link GroundTruthReachable} on purpose: the fix is different.
 * A reachable leak means removing the ground-truth dependency; an unprovable
 * type means flattening it, or replacing an unbounded recursive type with a
 * concrete one.
 */
export interface GroundTruthUnprovable<T> {
  readonly __astraLockError: 'This type nests deeper than the ground-truth inspection budget, so it cannot be proved free of ground truth (ADR-0003)';
  readonly offendingType: T;
}

/**
 * Resolves to `true` for a provably clean type, and to a diagnostic interface
 * otherwise. Pair with {@link StaticAssert} to turn either failure into a build
 * error at the point of declaration.
 */
export type AssertGroundTruthFree<T> = [InspectGroundTruth<T>] extends ['clean']
  ? true
  : 'tainted' extends InspectGroundTruth<T>
    ? GroundTruthReachable<T>
    : GroundTruthUnprovable<T>;

/** Fails to instantiate unless its argument is exactly `true`. */
export type StaticAssert<T extends true> = T;

/** Shallow check: is this exact value branded as ground truth? */
export function isGroundTruthTainted(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Partial<GroundTruthTainted>)[GROUND_TRUTH_BRAND] === true
  );
}

interface Pending {
  readonly node: unknown;
  readonly path: string;
}

/** Labels a Map key inside a diagnostic path without assuming it is a string. */
function describeKey(key: unknown): string {
  return typeof key === 'string' ? JSON.stringify(key) : String(key);
}

/**
 * Deep search for a ground-truth brand.
 *
 * Returns the property path of the first tainted value in depth-first order, or
 * `null` when the value is clean.
 *
 * The traversal is iterative rather than recursive, and has no depth limit. A
 * recursive walk would overflow the call stack on a deeply nested structure,
 * and a depth limit would silently stop looking — both are ways for the check
 * to report "clean" about something it never examined. Cycles are handled with
 * a visited set, so a self-referential object terminates instead of looping.
 */
export function findGroundTruthLeak(value: unknown): string | null {
  const seen = new WeakSet<object>();
  const stack: Pending[] = [{ node: value, path: '' }];

  while (stack.length > 0) {
    // Guarded by the loop condition; the check keeps noUncheckedIndexedAccess happy.
    const current = stack.pop();
    if (current === undefined) break;
    const { node, path } = current;

    if (typeof node !== 'object' || node === null) continue;
    if (seen.has(node)) continue;
    seen.add(node);

    if (isGroundTruthTainted(node)) return path;

    // Binary payloads are the legitimate sensor observable and hold no object
    // references. Skipping them is also what keeps this affordable: a 640x480
    // frame would otherwise enumerate 307,200 index properties.
    if (ArrayBuffer.isView(node) || node instanceof ArrayBuffer) continue;

    const children: Pending[] = [];

    if (Array.isArray(node)) {
      for (let index = 0; index < node.length; index += 1) {
        children.push({ node: node[index], path: `${path}[${String(index)}]` });
      }
    } else if (node instanceof Map) {
      let index = 0;
      for (const [key, mapValue] of node) {
        children.push({ node: key, path: `${path}.key[${String(index)}]` });
        children.push({ node: mapValue, path: `${path}.get(${describeKey(key)})` });
        index += 1;
      }
    } else if (node instanceof Set) {
      let index = 0;
      for (const member of node) {
        children.push({ node: member, path: `${path}.item[${String(index)}]` });
        index += 1;
      }
    } else {
      for (const [key, child] of Object.entries(node)) {
        children.push({ node: child, path: path === '' ? key : `${path}.${key}` });
      }
    }

    // Pushed in reverse so they pop in declaration order, which keeps the
    // reported path the first leak in depth-first order rather than an
    // arbitrary one.
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child !== undefined) stack.push(child);
    }
  }

  return null;
}

/** Thrown when ground truth reaches code that is not allowed to see it. */
export class GroundTruthLeakError extends Error {
  public readonly path: string;

  constructor(context: string, path: string) {
    const location = path === '' ? 'the value itself' : `property "${path}"`;
    super(
      `Ground truth reached ${context}: ${location} carries the ground-truth brand. ` +
        `A tracker may only observe sensor output (ADR-0003).`,
    );
    this.name = 'GroundTruthLeakError';
    this.path = path;
  }
}

/**
 * Runtime gate for values crossing into tracking code.
 *
 * Types are erased at a worker or plugin boundary, so the compile-time checks
 * cannot follow the value across. Returns the value unchanged when it is clean.
 *
 * @throws {GroundTruthLeakError} when any reachable value carries the brand.
 */
export function assertGroundTruthFree<T>(value: T, context: string): T {
  const leak = findGroundTruthLeak(value);
  if (leak !== null) {
    throw new GroundTruthLeakError(context, leak);
  }
  return value;
}
