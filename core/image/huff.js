/**
 * core/image/huff.js -- canonical Huffman coding for the image codec (PLAN v5 P2b, brick two).
 *
 * The transformer in dct.js decides *quality*; this file decides *bytes*. It is deliberately not the
 * fixed Annex K table set: a transfer is encoded once by us and decoded once by us, so the code lengths
 * can be measured from the actual coefficients and carried in a few dozen bytes of header. That is
 * strictly better than a table chosen for photographs in general, and it is easier to prove correct
 * than to transcribe.
 *
 * Pure ESM, no dependencies, no node: builtins -- same constraints as the rest of core/.
 */

/**
 * Huffman code lengths (1..maxLen) for the given symbol frequencies, or 0 for symbols that never occur.
 * Lengths are limited the way zlib does it: any leaf deeper than maxLen is lifted, then the tree is
 * repaired by moving leaves down until the budget fits. The result is a complete, valid length set.
 */
export function huffmanLengths(freqs, maxLen = 16) {
  const n = freqs.length;
  const out = new Uint8Array(n);
  const used = [];
  for (let i = 0; i < n; i++) if (freqs[i] > 0) used.push(i);
  if (used.length === 0) return out;
  if (used.length === 1) { out[used[0]] = 1; return out; }

  // Plain Huffman tree over the used symbols. Small alphabets only (a few hundred), so the O(n^2)
  // "take the two smallest" loop costs nothing and cannot be wrong about tie-breaking.
  const nodes = used.map((s) => ({ freq: freqs[s], sym: s, left: null, right: null }));
  while (nodes.length > 1) {
    nodes.sort((a, b) => (a.freq - b.freq) || (a.sym - b.sym));
    const a = nodes.shift();
    const b = nodes.shift();
    nodes.push({ freq: a.freq + b.freq, sym: -1, left: a, right: b });
  }
  const depthOf = new Map();
  const walk = (node, depth) => {
    if (node.sym >= 0) { depthOf.set(node.sym, Math.max(1, depth)); return; }
    walk(node.left, depth + 1);
    walk(node.right, depth + 1);
  };
  walk(nodes[0], 0);

  let maxDepth = 0;
  for (const d of depthOf.values()) if (d > maxDepth) maxDepth = d;

  // Most frequent first; ties by symbol id so the whole encoder is deterministic.
  const order = used.slice().sort((a, b) => (freqs[b] - freqs[a]) || (a - b));
  const lens = order.map((s) => Math.max(1, depthOf.get(s)));

  if (maxDepth > maxLen) {
    // Lifting the deep leaves can push the Kraft sum above 1 (the lifted leaves gain more than the rest
    // loses), so the repair is stated as an invariant instead of as arithmetic: squeeze the rarest
    // symbols deeper until the budget is legal, then spend whatever is left on the most frequent ones.
    // Every step recomputes the exact power-of-two change, so the invariant is checked, not assumed.
    if (used.length > 2 ** maxLen) throw new Error('huff: ' + used.length + ' symbols do not fit in ' + maxLen + '-bit codes');
    for (let i = 0; i < lens.length; i++) if (lens[i] > maxLen) lens[i] = maxLen;
    let k = lens.reduce((s, l) => s + 2 ** -l, 0);
    for (let i = lens.length - 1; i >= 0 && k > 1; i--) {
      while (lens[i] < maxLen && k > 1) { k -= 2 ** -lens[i] - 2 ** -(lens[i] + 1); lens[i]++; }
    }
    for (let i = 0; i < lens.length; i++) {
      while (lens[i] > 1 && k + 2 ** -(lens[i] - 1) - 2 ** -lens[i] <= 1) {
        k += 2 ** -(lens[i] - 1) - 2 ** -lens[i];
        lens[i]--;
      }
    }
    if (k > 1 + 1e-12) throw new Error('huff: repair left an over-complete code (Kraft ' + k + ')');
  }

  for (let i = 0; i < order.length; i++) out[order[i]] = lens[i];
  return out;
}

/**
 * Canonical codes for a length set: assign codes in order of increasing length, symbol id ascending
 * inside a length. The decoder must use this same rule, which is why it lives here and not in the
 * encoder.
 */
export function canonicalCodes(lengths, maxLen = 16) {
  const codes = new Uint32Array(lengths.length);
  let code = 0;
  for (let len = 1; len <= maxLen; len++) {
    for (let s = 0; s < lengths.length; s++) {
      if (lengths[s] !== len) continue;
      codes[s] = code++;
    }
    code <<= 1;
  }
  return codes;
}

/** Total bits a symbol stream costs under a length set. Used by the tests and the bench. */
export function codedBits(freqs, lengths) {
  let bits = 0;
  for (let i = 0; i < freqs.length; i++) bits += freqs[i] * lengths[i];
  return bits;
}

/** Shannon entropy in bits for the same distribution -- the floor any code must sit just above. */
export function entropyBits(freqs) {
  let total = 0;
  for (const f of freqs) total += f;
  if (total === 0) return 0;
  let bits = 0;
  for (const f of freqs) if (f > 0) bits += f * Math.log2(total / f);
  return bits;
}

/** MSB-first bit writer. */
export class BitWriter {
  constructor() { this.bytes = []; this.cur = 0; this.nbits = 0; }
  writeBits(value, len) {
    for (let i = len - 1; i >= 0; i--) {
      this.cur = ((this.cur << 1) | ((value >>> i) & 1)) & 0xff;
      this.nbits++;
      if (this.nbits === 8) { this.bytes.push(this.cur); this.cur = 0; this.nbits = 0; }
    }
    return this;
  }
  /** Pad the last partial byte with zero bits, the way every byte-oriented container does. */
  finish() {
    if (this.nbits > 0) this.bytes.push((this.cur << (8 - this.nbits)) & 0xff);
    return Uint8Array.from(this.bytes);
  }
}

/** MSB-first bit reader that refuses to read past the end instead of inventing zero bits. */
export class BitReader {
  constructor(bytes) { this.bytes = bytes; this.pos = 0; }
  get bitsLeft() { return this.bytes.length * 8 - this.pos; }
  readBits(len) {
    if (len > this.bitsLeft) throw new RangeError('huff: bit reader ran out (' + len + ' bits asked, ' + this.bitsLeft + ' left)');
    let v = 0;
    for (let i = 0; i < len; i++) {
      const byte = this.bytes[this.pos >> 3];
      v = (v << 1) | ((byte >> (7 - (this.pos & 7))) & 1);
      this.pos++;
    }
    return v;
  }
}

/** Decoder table: (len, code) -> symbol, plus the longest length so the reader knows its bound. */
export function decoderTable(lengths) {
  const maxLen = lengths.reduce((m, l) => Math.max(m, l), 0);
  const codes = canonicalCodes(lengths, maxLen);
  const table = new Map();
  for (let s = 0; s < lengths.length; s++) {
    if (lengths[s] > 0) table.set(lengths[s] * 65536 + codes[s], s);
  }
  return { table, maxLen };
}

/** Decode one symbol. Throws on a code that is not in the table -- silence here means wrong data. */
export function readSymbol(reader, dec) {
  let code = 0;
  for (let len = 1; len <= dec.maxLen; len++) {
    code = (code << 1) | reader.readBits(1);
    const hit = dec.table.get(len * 65536 + code);
    if (hit !== undefined) return hit;
  }
  throw new RangeError('huff: no code matches the next bits (stream is not what it claims)');
}
