/**
 * PSKT core — ChaCha20 stream cipher, RFC 8439 flavour.
 *
 * Parameters (RFC 8439 §2.3):
 *   - 256-bit key, read as eight 32-bit little-endian words.
 *   - 96-bit nonce, read as three 32-bit little-endian words (state words 13-15).
 *   - 32-bit block counter (state word 12) => the "32-bit counter" variant of
 *     ChaCha, i.e. 1 block counter + 96-bit nonce, NOT the original
 *     64-bit counter + 64-bit nonce from Bernstein's paper.
 *   - State: 16 x uint32 = constants(4) | key(8) | counter(1) | nonce(3).
 *   - 20 rounds = 10 x (column round + diagonal round), then the initial state
 *     is added back word-wise (mod 2^32) and serialized little-endian => 64 bytes.
 *
 * Design constraints for PSKT (air-gapped print/scan transport):
 *   - Zero dependency: no npm packages, no `crypto.subtle` (browser `file://` is
 *     an insecure context there), no Node-only builtins in the cipher path.
 *   - Pure ESM, synchronous, identical on Node >= 20 and in browsers.
 *   - Byte-oriented: everything in/out is Uint8Array (ArrayBuffer is accepted for
 *     convenience and normalized). Inputs are never mutated.
 *
 * `deriveKey` is the one async export: PBKDF2-HMAC-SHA256 over the passphrase, so callers
 * can await the stretch instead of dropping it in the middle of a synchronous frame path.
 *
 * Honesty note (docs/PLAN.md): this passes every published RFC 8439 vector and is
 * cross-checked byte-for-byte against OpenSSL's chacha20 in the unit tests, but it
 * is a from-scratch, unaudited implementation. It adds no authentication: PSKT's
 * integrity comes from the CRC/frame layer, and ciphertext authenticity across the
 * air gap must not be assumed from this module alone.
 */

export const CHACHA20_KEY_BYTES = 32;
export const CHACHA20_NONCE_BYTES = 12;
export const CHACHA20_BLOCK_BYTES = 64;

/** State words 0..3 ("expa|nd 3|2-by|te k" in little-endian ASCII). */
const CONSTANTS = [0x61707865, 0x3320646e, 0x79622d32, 0x6b206574];

/** Max useful counter value; the counter is a single 32-bit state word. */
const COUNTER_MAX = 0xffffffff;

/* ------------------------------------------------------------------ */
/* rotations (bit-twiddling only, uint32 semantics via >>> 0)          */
/* ------------------------------------------------------------------ */

function rotl16(v) {
  return ((v << 16) | (v >>> 16)) >>> 0;
}

function rotl12(v) {
  return ((v << 12) | (v >>> 20)) >>> 0;
}

function rotl8(v) {
  return ((v << 8) | (v >>> 24)) >>> 0;
}

function rotl7(v) {
  return ((v << 7) | (v >>> 25)) >>> 0;
}

/**
 * ChaCha quarter round (RFC 8439 §2.1) on state words (a,b,c,d) of `w`:
 *
 *   a += b; d ^= a; d <<<= 16;
 *   c += d; b ^= c; b <<<= 12;
 *   a += b; d ^= a; d <<<= 8;
 *   c += d; b ^= c; b <<<= 7;
 *
 * The RFC's column round uses the index order (0,4,8,12),(1,5,9,13),
 * (2,6,10,14),(3,7,11,15); the diagonal round uses (0,5,10,15),(1,6,11,12),
 * (2,7,8,13),(3,4,9,14). See QR_INDEXES below.
 */
function quarterRound(w, a, b, c, d) {
  w[a] = (w[a] + w[b]) >>> 0; w[d] = rotl16(w[d] ^ w[a]);
  w[c] = (w[c] + w[d]) >>> 0; w[b] = rotl12(w[b] ^ w[c]);
  w[a] = (w[a] + w[b]) >>> 0; w[d] = rotl8(w[d] ^ w[a]);
  w[c] = (w[c] + w[d]) >>> 0; w[b] = rotl7(w[b] ^ w[c]);
}

/** 8 quarter rounds per inner block: 4 column + 4 diagonal, as flat index tuples. */
const QR_INDEXES = new Int32Array([
  // column round: (0,4,8,12), (1,5,9,13), (2,6,10,14), (3,7,11,15)
  0, 4, 8, 12,
  1, 5, 9, 13,
  2, 6, 10, 14,
  3, 7, 11, 15,
  // diagonal round: (0,5,10,15), (1,6,11,12), (2,7,8,13), (3,4,9,14)
  0, 5, 10, 15,
  1, 6, 11, 12,
  2, 7, 8, 13,
  3, 4, 9, 14,
]);

/**
 * The ChaCha20 block function (RFC 8439 §2.3): 20 rounds over `state`,
 * feedback-addition of the initial state, serialized little-endian.
 * `state` is not modified.
 */
function blockFunction(state) {
  const w = new Uint32Array(state); // working copy = initial state
  for (let round = 0; round < 10; round++) { // 10 x (column + diagonal) = 20 rounds
    for (let q = 0; q < 8; q++) {
      const o = q * 4;
      quarterRound(w, QR_INDEXES[o], QR_INDEXES[o + 1], QR_INDEXES[o + 2], QR_INDEXES[o + 3]);
    }
  }
  const out = new Uint8Array(CHACHA20_BLOCK_BYTES);
  for (let i = 0; i < 16; i++) {
    const v = (w[i] + state[i]) >>> 0;
    out[i * 4] = v & 0xff;
    out[i * 4 + 1] = (v >>> 8) & 0xff;
    out[i * 4 + 2] = (v >>> 16) & 0xff;
    out[i * 4 + 3] = (v >>> 24) & 0xff;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* input normalization                                                 */
/* ------------------------------------------------------------------ */

/** Accept Uint8Array / ArrayBuffer / other ArrayBufferView; return a Uint8Array *view*. */
function asBytes(value, what) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new TypeError(`${what} must be a Uint8Array or ArrayBuffer, got ${describe(value)}`);
}

function describe(value) {
  if (value === null || value === undefined) return String(value);
  return typeof value === 'object' && value && value.constructor
    ? value.constructor.name
    : typeof value;
}

function assertByteLength(bytes, expected, what) {
  if (bytes.length !== expected) {
    throw new RangeError(`${what} must be exactly ${expected} bytes, got ${bytes.length}`);
  }
  return bytes;
}

function readKey(key) {
  return assertByteLength(asBytes(key, 'key'), CHACHA20_KEY_BYTES, 'key');
}

function readNonce(nonce) {
  return assertByteLength(asBytes(nonce, 'nonce'), CHACHA20_NONCE_BYTES, 'nonce');
}

function readCounter(counter, what = 'counter') {
  if (typeof counter !== 'number' || !Number.isInteger(counter)) {
    throw new TypeError(`${what} must be an integer, got ${describe(counter)}`);
  }
  if (counter < 0 || counter > COUNTER_MAX) {
    throw new RangeError(`${what} must be within 0..${COUNTER_MAX} (32-bit block counter), got ${counter}`);
  }
  return counter;
}

/** Build the 16-word initial state: constants | key | counter | nonce (all LE). */
function initialState(key, counter, nonce) {
  const s = new Uint32Array(16);
  s[0] = CONSTANTS[0];
  s[1] = CONSTANTS[1];
  s[2] = CONSTANTS[2];
  s[3] = CONSTANTS[3];
  for (let i = 0; i < 8; i++) {
    const o = i * 4;
    // little-endian: key[0] is the least significant byte of state word 4
    s[4 + i] = (key[o] | (key[o + 1] << 8) | (key[o + 2] << 16) | (key[o + 3] << 24)) >>> 0;
  }
  s[12] = counter >>> 0;
  for (let i = 0; i < 3; i++) {
    const o = i * 4;
    s[13 + i] = (nonce[o] | (nonce[o + 1] << 8) | (nonce[o + 2] << 16) | (nonce[o + 3] << 24)) >>> 0;
  }
  return s;
}

/* ------------------------------------------------------------------ */
/* public API                                                          */
/* ------------------------------------------------------------------ */

/**
 * One keystream block (64 bytes) for `key` / `nonce` at block index `counter`.
 *
 * @param {Uint8Array|ArrayBuffer} key      32-byte key
 * @param {number} counter                  32-bit block counter, 0 .. 2^32-1
 * @param {Uint8Array|ArrayBuffer} nonce    12-byte nonce
 * @returns {Uint8Array} 64 new bytes
 */
export function chacha20KeystreamBlock(key, counter, nonce) {
  const k = readKey(key);
  const n = readNonce(nonce);
  const c = readCounter(counter);
  return blockFunction(initialState(k, c, n));
}

/**
 * XOR `data` with the ChaCha20 keystream generated from (`key`, `nonce`) starting
 * at block `counter` (default 1, per RFC 8439's convention of reserving block 0
 * for a one-time MAC key). Always allocates a fresh output buffer; never touches
 * `data`. Encryption and decryption are the same operation.
 *
 * The per-block counter wraps modulo 2^32 (same as the reference pseudocode); a
 * wrap would repeat keystream, so callers must keep (counter + ceil(len/64)) <= 2^32.
 *
 * @param {Uint8Array|ArrayBuffer} key
 * @param {Uint8Array|ArrayBuffer} nonce
 * @param {Uint8Array|ArrayBuffer} data   arbitrary length, including 0
 * @param {number} [counter=1]
 * @returns {Uint8Array} same length as `data`
 */
export function chacha20Xor(key, nonce, data, counter = 1) {
  const k = readKey(key);
  const n = readNonce(nonce);
  const c0 = readCounter(counter);
  const src = asBytes(data, 'data');
  const len = src.length;
  const out = new Uint8Array(len);
  const words = initialState(k, c0, n);
  let o = 0;
  let block = 0;
  while (o < len) {
    const ks = blockFunction(words);
    const end = Math.min(o + CHACHA20_BLOCK_BYTES, len);
    for (let i = o; i < end; i++) out[i] = src[i] ^ ks[i - o];
    o = end;
    block++;
    // advance the 32-bit block counter (word 12), wrapping mod 2^32
    words[12] = (c0 + block) >>> 0;
  }
  return out;
}

/** ChaCha20 is symmetric: `chacha20Encrypt` is an alias of `chacha20Xor`. */
export function chacha20Encrypt(key, nonce, plaintext, counter = 1) {
  return chacha20Xor(key, nonce, plaintext, counter);
}

/** ChaCha20 is symmetric: `chacha20Decrypt` is an alias of `chacha20Xor`. */
export function chacha20Decrypt(key, nonce, ciphertext, counter = 1) {
  return chacha20Xor(key, nonce, ciphertext, counter);
}

/**
 * Stretch a passphrase into a 32-byte ChaCha20 key: PBKDF2-HMAC-SHA256.
 *
 * Async on purpose: key stretching is a UI-blocking affair on the scan side and callers
 * must be able to `await` it (show a spinner, chunk a batch). Honest caveat: the PBKDF2
 * work itself still runs as one synchronous block inside core/hash.js, so `await` buys
 * API shape and import laziness, not intra-loop yielding — measured ~0.15 s for the
 * default 150k iterations on Node 24 / a desktop core, less than a page render budget
 * but worth doing off the hot path. The hash primitive lives in core/hash.js
 * (`pbkdf2Sha256(password, salt, iterations, dkLenBytes)`) and is imported lazily so this
 * module stays loadable (and the cipher fully testable) while that workstream lands; a
 * static import here would take down every consumer of chacha20.js if hash.js is missing.
 *
 * @param {string|Uint8Array|ArrayBuffer} passphrase
 * @param {Uint8Array|ArrayBuffer} saltBytes   per-message salt (recommend >= 16 bytes)
 * @param {number} [iterations=150000]
 * @returns {Promise<Uint8Array>} 32-byte key
 */
// pbkdf2 used to arrive through `await import('./hash.js')` so this module stayed
// loadable "while that workstream lands". That premise expired a long time ago: hash.js
// is present, passes RFC/peer witnesses in the unit suite, and imports nothing itself
// (checked -- so there is no cycle to dodge). The laziness now only blocks the browser
// bundle, which cannot resolve a graph decided at run time, and tools/build-web.mjs
// refuses dynamic imports instead of guessing at them. The export check stays: a missing
// symbol is still a failure worth naming, and it is cheap.
import { pbkdf2Sha256 } from './hash.js';

export async function deriveKey(passphrase, saltBytes, iterations = 150000) {
  if (typeof pbkdf2Sha256 !== 'function') {
    throw new Error('chacha20.deriveKey: core/hash.js does not export pbkdf2Sha256()');
  }
  const salt = asBytes(saltBytes, 'saltBytes');
  if (typeof passphrase !== 'string' && !(passphrase instanceof Uint8Array) && !(passphrase instanceof ArrayBuffer)) {
    throw new TypeError('passphrase must be a string or bytes');
  }
  if (!Number.isInteger(iterations) || iterations < 1) {
    throw new RangeError(`iterations must be a positive integer, got ${describe(iterations)}`);
  }
  const dk = pbkdf2Sha256(passphrase, salt, iterations, CHACHA20_KEY_BYTES);
  const bytes = asBytes(dk, 'pbkdf2Sha256 output');
  assertByteLength(bytes, CHACHA20_KEY_BYTES, 'derived key');
  return Uint8Array.from(bytes); // always hand back an owned 32-byte array
}
