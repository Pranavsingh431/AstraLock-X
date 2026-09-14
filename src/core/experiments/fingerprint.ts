/**
 * Stable identity for an engineering configuration.
 *
 * Two runs of the same physical scenario with the same algorithm settings are
 * the same *experiment*, whatever time they happened or what the recording was
 * called. A fingerprint makes that sameness checkable rather than asserted, and
 * it is the thing that lets a reader confirm two reports are comparable.
 *
 * Two pieces are needed and both are easy to get subtly wrong.
 *
 * **Canonical serialisation.** `JSON.stringify` preserves insertion order, so
 * the same configuration built two different ways serialises two different ways
 * and hashes differently. Object keys are therefore sorted, at every depth.
 * Numbers are emitted in a fixed form so that `1`, `1.0` and `1e0` cannot
 * disagree.
 *
 * **A documented hash.** SHA-256, implemented here rather than taken from
 * `node:crypto` or `SubtleCrypto`: the core has to run identically in Node, in
 * a browser and inside Tauri, `SubtleCrypto` is asynchronous, and a fingerprint
 * that could only be computed on one of the three would be useless in exactly
 * the place it matters. It is a few dozen lines and is checked against the
 * published test vectors.
 */

/** Canonical JSON: keys sorted at every depth, numbers in a fixed form. */
export function canonicalise(value: unknown): string {
  if (value === null) return 'null';

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`Cannot fingerprint a non-finite number: ${String(value)}`);
    }
    // Exponential with full precision: one spelling per value, and no
    // dependence on how the number was written in the source document. `-0`
    // and `0` are the same engineering quantity, so they share a spelling.
    return (Object.is(value, -0) ? 0 : value).toExponential(17);
  }

  if (typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);

  if (Array.isArray(value)) return `[${value.map(canonicalise).join(',')}]`;

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const parts: string[] = [];
    for (const key of keys) {
      const entry = record[key];
      // `undefined` is absence, not a value. Emitting it would make a config
      // that omits a field hash differently from one that sets it to
      // undefined, which are the same configuration.
      if (entry === undefined) continue;
      parts.push(`${JSON.stringify(key)}:${canonicalise(entry)}`);
    }
    return `{${parts.join(',')}}`;
  }

  throw new TypeError(`Cannot fingerprint a value of type ${typeof value}`);
}

// --- SHA-256 ---------------------------------------------------------------

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));

/** SHA-256 of a UTF-8 string, as lowercase hex. */
export function sha256(text: string): string {
  const bytes = new TextEncoder().encode(text);

  // Pad: 0x80, then zeros, then the 64-bit big-endian bit length.
  const bitLength = bytes.length * 8;
  const padded = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  // Lengths beyond 2^53 bits are not representable here and not reachable:
  // that is a petabyte of configuration.
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(padded.length - 4, bitLength >>> 0);

  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);

  for (let block = 0; block < padded.length; block += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(block + i * 4);
    for (let i = 16; i < 64; i += 1) {
      const a = w[i - 15]!;
      const b = w[i - 2]!;
      const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3);
      const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }

    let [a, b, c, d, e, f, g, hh] = [h[0]!, h[1]!, h[2]!, h[3]!, h[4]!, h[5]!, h[6]!, h[7]!];

    for (let i = 0; i < 64; i += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (hh + s1 + ch + K[i]! + w[i]!) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;

      hh = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h[0] = (h[0]! + a) >>> 0;
    h[1] = (h[1]! + b) >>> 0;
    h[2] = (h[2]! + c) >>> 0;
    h[3] = (h[3]! + d) >>> 0;
    h[4] = (h[4]! + e) >>> 0;
    h[5] = (h[5]! + f) >>> 0;
    h[6] = (h[6]! + g) >>> 0;
    h[7] = (h[7]! + hh) >>> 0;
  }

  return Array.from(h, (word) => word.toString(16).padStart(8, '0')).join('');
}

/**
 * Fingerprint of an engineering configuration.
 *
 * Prefixed with the algorithm name so a stored fingerprint stays readable if
 * the hash ever changes, and so nobody has to guess what produced it.
 */
export function fingerprint(value: unknown): string {
  return `sha256:${sha256(canonicalise(value))}`;
}
