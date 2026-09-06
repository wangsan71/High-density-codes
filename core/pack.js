/**
 * PSKT core — bit packing, symbol-level Gray mapping and interleaving.
 *
 * Bit order convention (docs/PROTOCOL.md): **MSB-first within a byte**, i.e. the
 * first bit written becomes bit 7 of byte 0. The lattice is filled in symbol
 * order, so bit i of the stream maps to symbol cell i (1-bit profiles) or to
 * symbols[i / bitsPerCell] (multi-bit profiles).
 *
 * Multi-bit symbols use reflected-binary Gray code so that a single misread
 * symbol (the dominant physical error mechanism) flips exactly one bit, which
 * the Reed-Solomon layer — which counts *symbols*, not bits — is well matched to.
 */

/** reflected-binary Gray code */
export const toGray = (n) => n ^ (n >>> 1);
/** inverse Gray code (works for any width <= 31) */
export function fromGray(g) {
  let n = g;
  n ^= n >>> 16;
  n ^= n >>> 8;
  n ^= n >>> 4;
  n ^= n >>> 2;
  n ^= n >>> 1;
  return n & 0x7fffffff;
}

/** Gray-coded alphabet for `bits` bits per symbol: symbol index <-> bit pattern. */
export function grayAlphabet(bits) {
  const size = 1 << bits;
  const enc = new Uint16Array(size);
  const dec = new Uint16Array(size);
  for (let i = 0; i < size; i++) {
    enc[i] = toGray(i);
    dec[toGray(i)] = i;
  }
  return { bits, size, encode: enc, decode: dec };
}

/** Bit writer over a growable Uint8Array, MSB-first. */
export class BitWriter {
  constructor(capacityBits = 1024) {
    this.bytes = new Uint8Array(Math.max(1, Math.ceil(capacityBits / 8)));
    this.n = 0; // bits written
  }
  _grow() {
    if (this.n < this.bytes.length * 8) return;
    const next = new Uint8Array(this.bytes.length * 2);
    next.set(this.bytes, 0);
    this.bytes = next;
  }
  writeBit(bit) {
    this._grow();
    const byteIndex = this.n >>> 3;
    const shift = 7 - (this.n & 7);
    if (bit) this.bytes[byteIndex] |= 1 << shift;
    else this.bytes[byteIndex] &= ~(1 << shift) & 0xff;
    this.n++;
  }
  write(value, bits) {
    if (bits < 0 || bits > 32) throw new RangeError('write: bits out of range');
    for (let i = bits - 1; i >= 0; i--) this.writeBit(((value >>> i) & 1) ^ 0);
  }
  writeBytes(bytes) {
    for (let i = 0; i < bytes.length; i++) this.write(bytes[i], 8);
  }
  /** append padding so that n is a multiple of 8 */
  align() {
    while (this.n & 7) this.writeBit(0);
  }
  get lengthBits() {
    return this.n;
  }
  result() {
    this.align();
    return this.bytes.slice(0, this.n >>> 3);
  }
}

/** Bit reader over a fixed Uint8Array, MSB-first. */
export class BitReader {
  constructor(bytes, bitOffset = 0) {
    this.bytes = bytes;
    this.i = bitOffset;
  }
  get remaining() {
    return this.bytes.length * 8 - this.i;
  }
  readBit() {
    if (this.i >= this.bytes.length * 8) throw new RangeError('BitReader: overrun');
    const byteIndex = this.i >>> 3;
    const shift = 7 - (this.i & 7);
    this.i++;
    return (this.bytes[byteIndex] >>> shift) & 1;
  }
  read(bits) {
    let v = 0;
    for (let i = 0; i < bits; i++) v = (v << 1) | this.readBit();
    return v >>> 0;
  }
  readBytes(n) {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = this.read(8);
    return out;
  }
}

/** pack a byte array into a bit array (length 8n) */
export function bytesToBits(bytes) {
  const out = new Uint8Array(bytes.length * 8);
  for (let i = 0; i < bytes.length; i++) {
    for (let b = 0; b < 8; b++) out[i * 8 + b] = (bytes[i] >>> (7 - b)) & 1;
  }
  return out;
}

export function bitsToBytes(bits) {
  if (bits.length & 7) throw new RangeError('bitsToBytes: length must be multiple of 8');
  const out = new Uint8Array(bits.length >>> 3);
  for (let i = 0; i < out.length; i++) {
    let v = 0;
    for (let b = 0; b < 8; b++) v = (v << 1) | (bits[i * 8 + b] & 1);
    out[i] = v;
  }
  return out;
}

/**
 * Pack `levels` (one value per cell, 0..2^bits-1) into a bit stream, taking
 * `bits` bits per cell, MSB-first per cell.
 */
export function levelsToBits(levels, bits) {
  const out = new Uint8Array(levels.length * bits);
  for (let i = 0; i < levels.length; i++) {
    const v = levels[i];
    for (let b = 0; b < bits; b++) out[i * bits + b] = (v >>> (bits - 1 - b)) & 1;
  }
  return out;
}

export function bitsToLevels(bitsArr, bits) {
  const n = Math.floor(bitsArr.length / bits);
  const out = new Uint16Array(n);
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (let b = 0; b < bits; b++) v = (v << 1) | (bitsArr[i * bits + b] & 1);
    out[i] = v;
  }
  return out;
}

/**
 * Permute symbol indices with a quadratic (star) schedule: index i -> (i * step)
 * mod n, gcd(step, n) == 1. Physical streaks (missing extrusion line, scanner
 * band, dirt) then hit symbols that belong to *different* Reed-Solomon blocks.
 * Returns the forward and inverse tables.
 */
export function interleaveTable(n, step) {
  if (n <= 1) {
    const t = new Uint32Array(Math.max(n, 0));
    for (let i = 0; i < n; i++) t[i] = i;
    return { fwd: t, inv: t.slice(), step: 1 };
  }
  if (step === undefined || step === null) step = defaultStep(n);
  if (gcd(step, n) !== 1) throw new RangeError(`interleave: step ${step} not coprime with n=${n}`);
  const fwd = new Uint32Array(n);
  const inv = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    const j = mulMod(i, step, n);
    fwd[i] = j;
    inv[j] = i;
  }
  return { fwd, inv, step };
}

/** defaultStep picks the prime nearest to n/2 (coprime with n by construction). */
export function defaultStep(n) {
  for (let cand = Math.max(2, n >> 1); cand < n; cand++) {
    if (isPrime(cand) && gcd(cand, n) === 1) return cand;
  }
  for (let cand = 2; cand < n; cand++) if (gcd(cand, n) === 1) return cand;
  return 1;
}

export function applyPermute(src, permute, dst) {
  const out = dst || new src.constructor(src.length);
  for (let i = 0; i < src.length; i++) out[i] = src[permute[i]];
  return out;
}

function gcd(a, b) {
  while (b) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a;
}
export function isPrime(n) {
  if (n < 2) return false;
  if (!(n & 1)) return n === 2;
  for (let d = 3; d * d <= n; d += 2) if (n % d === 0) return false;
  return true;
}
/** (a*b) mod m without overflowing 2^53 */
function mulMod(a, b, m) {
  let r = 0;
  let x = a % m;
  let y = b;
  while (y > 0) {
    if (y & 1) r = (r + x) % m;
    x = (x * 2) % m;
    y = Math.floor(y / 2);
  }
  return r;
}
