/**
 * PSKT core — SHA-256, HMAC-SHA256, PBKDF2-HMAC-SHA256.
 *
 * Pure JS, no WebCrypto, works in browsers opened from file:// (crypto.subtle is
 * absent in a non-secure context, and this module must behave identically on the
 * print side and the scan side of an air-gapped link).
 *
 * Conventions:
 *   - Everything here is synchronous and self-contained (zero imports).
 *   - "msg" / "key" / "password" / "salt" accept Uint8Array (or any
 *     ArrayBufferView), ArrayBuffer, an array of byte numbers, or a string —
 *     strings are UTF-8 encoded. Inputs are never mutated.
 *   - Digests come back as fresh Uint8Array(32); the caller owns the memory.
 *   - `digest(bytes)` is the project-wide name for a payload SHA-256.
 *   - FIPS 180-4 padding: 0x80, zeros, then the 64-bit big-endian bit length.
 *   - Scratch (H state, W schedule, padding tail) is allocated once per public
 *     call and reused for every block of that call, so throughput does not
 *     depend on garbage collection. Helpers take scratch as arguments instead of
 *     sharing module-level mutable state, so nested use stays correct.
 */

/* ------------------------------------------------------------------ */
/* constants                                                           */
/* ------------------------------------------------------------------ */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const H_INIT = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
  0x1f83d9ab, 0x5be0cd19,
]);

const BLOCK = 64; // SHA-256 block size in bytes (also the HMAC block size)
const DIGEST = 32; // SHA-256 output size in bytes

const HEX = new Array(256);
for (let i = 0; i < 256; i++) HEX[i] = (i + 0x100).toString(16).slice(1);

const textEncoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;

/* ------------------------------------------------------------------ */
/* input normalization                                                 */
/* ------------------------------------------------------------------ */

/** View any accepted byte source as a Uint8Array, without copying arrays. */
function toBytes(input, what = 'msg') {
  if (input instanceof Uint8Array) return input;
  if (typeof input === 'string') {
    if (textEncoder) return textEncoder.encode(input);
    // Exotic hosts without TextEncoder: UTF-8 via percent-decoding trick.
    const s = unescape(encodeURIComponent(input));
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
    return out;
  }
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  if (Array.isArray(input)) return Uint8Array.from(input, (b) => b & 0xff);
  throw new TypeError(`hash: ${what} must be Uint8Array/ArrayBuffer/string`);
}

/* ------------------------------------------------------------------ */
/* compression                                                         */
/* ------------------------------------------------------------------ */

/**
 * Absorb one 64-byte block of `data` starting at `off` into state `H`.
 * `W` (length 64) is caller-owned scratch and is fully rewritten every call.
 */
function compressBlock(H, W, data, off) {
  let h0 = H[0], h1 = H[1], h2 = H[2], h3 = H[3];
  let h4 = H[4], h5 = H[5], h6 = H[6], h7 = H[7];

  for (let i = 0, j = off; i < 16; i++, j += 4) {
    W[i] = (data[j] << 24) | (data[j + 1] << 16) | (data[j + 2] << 8) | data[j + 3];
  }
  for (let i = 16; i < 64; i++) {
    const x = W[i - 15];
    const y = W[i - 2];
    const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
    const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
    W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0;
  }
  for (let i = 0; i < 64; i++) {
    const S1 = ((h4 >>> 6) | (h4 << 26)) ^ ((h4 >>> 11) | (h4 << 21)) ^ ((h4 >>> 25) | (h4 << 7));
    const ch = (h4 & h5) ^ (~h4 & h6);
    const t1 = (h7 + S1 + ch + K[i] + W[i]) >>> 0;
    const S0 = ((h0 >>> 2) | (h0 << 30)) ^ ((h0 >>> 13) | (h0 << 19)) ^ ((h0 >>> 22) | (h0 << 10));
    const maj = (h0 & h1) ^ (h0 & h2) ^ (h1 & h2);
    const t2 = (S0 + maj) >>> 0;
    h7 = h6; h6 = h5; h5 = h4; h4 = (h3 + t1) >>> 0;
    h3 = h2; h2 = h1; h1 = h0; h0 = (t1 + t2) >>> 0;
  }

  H[0] = (H[0] + h0) >>> 0; H[1] = (H[1] + h1) >>> 0;
  H[2] = (H[2] + h2) >>> 0; H[3] = (H[3] + h3) >>> 0;
  H[4] = (H[4] + h4) >>> 0; H[5] = (H[5] + h5) >>> 0;
  H[6] = (H[6] + h6) >>> 0; H[7] = (H[7] + h7) >>> 0;
}

/**
 * Absorb the block-aligned part of data[dOff..dOff+dLen), pad, and write the
 * 32-byte digest into `out`. `baseLen` is how many bytes were already absorbed
 * and must be a multiple of 64, so this data starts block-aligned. `tail` is
 * caller-owned scratch of length 128 (holds the 1 or 2 final padded blocks).
 */
function finalizeInto(H, W, tail, data, dOff, dLen, baseLen, out) {
  const rem = dLen % BLOCK;
  const nFull = dLen - rem;
  for (let p = dOff, end = dOff + nFull; p < end; p += BLOCK) compressBlock(H, W, data, p);

  const total = baseLen + dLen;
  tail.fill(0);
  for (let i = 0; i < rem; i++) tail[i] = data[dOff + nFull + i];
  tail[rem] = 0x80;

  const blocks = rem <= 55 ? 1 : 2; // padding costs 9 bytes: 0x80 + zeros + 8-byte length
  const lenOff = blocks * BLOCK - 8;
  const bits = total * 8; // exact double for total < 2^53 bytes
  const hi = Math.floor(bits / 0x100000000);
  tail[lenOff] = hi >>> 24;
  tail[lenOff + 1] = hi >>> 16;
  tail[lenOff + 2] = hi >>> 8;
  tail[lenOff + 3] = hi;
  tail[lenOff + 4] = bits >>> 24;
  tail[lenOff + 5] = bits >>> 16;
  tail[lenOff + 6] = bits >>> 8;
  tail[lenOff + 7] = bits; // Uint8Array assignment truncates to one byte
  for (let b = 0; b < blocks; b++) compressBlock(H, W, tail, b * BLOCK);

  for (let i = 0; i < 8; i++) {
    const v = H[i];
    out[i * 4] = v >>> 24;
    out[i * 4 + 1] = v >>> 16;
    out[i * 4 + 2] = v >>> 8;
    out[i * 4 + 3] = v;
  }
  return out;
}

/** Per-call scratch bundle. */
function newScratch() {
  return {
    H: new Uint32Array(8),
    W: new Uint32Array(64),
    tail: new Uint8Array(128),
    inner: new Uint8Array(DIGEST),
  };
}

function resetH(H) {
  for (let i = 0; i < 8; i++) H[i] = H_INIT[i];
}

/** One-shot SHA-256 of an already-normalized byte array, into `out`. */
function hashInto(s, data, out) {
  resetH(s.H);
  return finalizeInto(s.H, s.W, s.tail, data, 0, data.length, 0, out);
}

/* ------------------------------------------------------------------ */
/* public API                                                          */
/* ------------------------------------------------------------------ */

/** SHA-256 → Uint8Array(32). */
export function sha256(msg) {
  const s = newScratch();
  return hashInto(s, toBytes(msg), new Uint8Array(DIGEST));
}

/** SHA-256 → 64-char lowercase hex. */
export function sha256Hex(msg) {
  const s = newScratch();
  const d = hashInto(s, toBytes(msg), s.inner);
  let out = '';
  for (let i = 0; i < DIGEST; i++) out += HEX[d[i]];
  return out;
}

/** Semantic alias: PSKT calls a payload's SHA-256 its "digest". */
export function digest(bytes) {
  return sha256(bytes);
}

/** HMAC-SHA256 (RFC 2104): block size 64; keys longer than 64 bytes are hashed. */
export function hmacSha256(key, msg) {
  const s = newScratch();
  const pads = hmacPads(s, toBytes(key, 'key'));
  return hmacInto(s, pads, toBytes(msg), new Uint8Array(DIGEST));
}

/** PBKDF2-HMAC-SHA256 (RFC 2898 §5.2); supports dkLenBytes > 32 via block chaining. */
export function pbkdf2Sha256(password, salt, iterations, dkLenBytes) {
  if (!Number.isInteger(iterations) || iterations < 1) {
    throw new RangeError('pbkdf2: iterations must be a positive integer');
  }
  if (!Number.isInteger(dkLenBytes) || dkLenBytes < 1) {
    throw new RangeError('pbkdf2: dkLenBytes must be a positive integer');
  }
  const P = toBytes(password, 'password');
  const S = toBytes(salt, 'salt');
  const s = newScratch();
  const pads = hmacPads(s, P);

  // HMAC input is salt || INT_32_BE(blockIndex): build once, patch the counter.
  const input = new Uint8Array(S.length + 4);
  input.set(S, 0);
  const U = new Uint8Array(DIGEST); // current PRF output
  const T = new Uint8Array(DIGEST); // XOR accumulator for this output block
  const dk = new Uint8Array(dkLenBytes);
  const nBlocks = Math.ceil(dkLenBytes / DIGEST);

  for (let block = 1; block <= nBlocks; block++) {
    const cOff = S.length;
    input[cOff] = (block >>> 24) & 0xff;
    input[cOff + 1] = (block >>> 16) & 0xff;
    input[cOff + 2] = (block >>> 8) & 0xff;
    input[cOff + 3] = block & 0xff;

    hmacInto(s, pads, input, U); // U_1 = PRF(P, salt || i)
    T.set(U);
    for (let it = 1; it < iterations; it++) {
      hmacInto(s, pads, U, U); // U_j = PRF(P, U_{j-1}) — in place, msg === out
      for (let j = 0; j < DIGEST; j++) T[j] ^= U[j];
    }
    const dst = (block - 1) * DIGEST;
    const n = Math.min(DIGEST, dkLenBytes - dst);
    for (let j = 0; j < n; j++) dk[dst + j] = T[j];
  }
  return dk;
}

/**
 * Compare two byte strings without leaking *content* through early exit.
 * A length mismatch returns false immediately; the loop itself never does.
 */
export function constantTimeEqual(a, b) {
  const x = toBytes(a, 'a');
  const y = toBytes(b, 'b');
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/* ------------------------------------------------------------------ */
/* HMAC internals (scratch and pads are passed in so callers reuse them) */
/* ------------------------------------------------------------------ */

/** @returns {{ipad: Uint8Array, opad: Uint8Array}} 64-byte padded key blocks. */
function hmacPads(s, key) {
  let mk = key;
  if (mk.length > BLOCK) {
    const hashed = new Uint8Array(DIGEST); // distinct buffer: `key` may be caller-owned
    hashInto(s, mk, hashed);
    mk = hashed;
  }
  const ipad = new Uint8Array(BLOCK);
  const opad = new Uint8Array(BLOCK);
  ipad.set(mk);
  opad.set(mk);
  for (let i = 0; i < BLOCK; i++) {
    ipad[i] ^= 0x36;
    opad[i] ^= 0x5c;
  }
  return { ipad, opad };
}

/** H(opad || H(ipad || msg)) → out. `s.inner` is scratch, so msg === out is safe. */
function hmacInto(s, pads, msg, out) {
  const { H, W, tail, inner } = s;

  resetH(H);
  compressBlock(H, W, pads.ipad, 0); // ipad is exactly one block → msg stays aligned
  finalizeInto(H, W, tail, msg, 0, msg.length, BLOCK, inner);

  resetH(H);
  compressBlock(H, W, pads.opad, 0);
  return finalizeInto(H, W, tail, inner, 0, inner.length, BLOCK, out);
}
