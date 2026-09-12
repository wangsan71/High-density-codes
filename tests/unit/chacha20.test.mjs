/**
 * Unit tests for core/chacha20.js — RFC 8439 test vectors + cross-validation
 * against node:crypto's OpenSSL chacha20.
 *
 * Vector provenance: RFC 8439 §2.3.2, §2.4.2, A.1, A.2 (text taken verbatim from
 * https://www.rfc-editor.org/rfc/rfc8439.txt).
 *
 * NOTE on a commonly mixed-up pair of vectors (worth knowing before "fixing" these):
 *   - §2.3.2 (block function): nonce = 000000 09 0000004a00000000, counter = 1
 *     -> serialized block starts 10f1e7e4 d13b5915 ...
 *   - §2.4.2 (cipher/sunscreen): nonce = 000000 00 0000004a00000000, counter = 1
 *     -> keystream starts 224f51f3 401bd9e1 ...
 * Both appear below; they differ only in nonce byte 3, and are cross-checked against
 * node:crypto, so a transcription error cannot pass silently.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, randomBytes, pbkdf2Sync } from 'node:crypto';

import {
  CHACHA20_KEY_BYTES,
  CHACHA20_NONCE_BYTES,
  CHACHA20_BLOCK_BYTES,
  chacha20KeystreamBlock,
  chacha20Xor,
  chacha20Encrypt,
  chacha20Decrypt,
  deriveKey,
} from '../../core/chacha20.js';

/* ------------------------------------------------------------------ */
/* helpers                                                            */
/* ------------------------------------------------------------------ */

function unhex(hex) {
  const h = hex.replace(/[^0-9a-fA-F]/g, '');
  assert.equal(h.length % 2, 0, 'hex vector must have even length');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function toHex(bytes) {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

/** The 32-byte key 00:01:02:...:1f used by §2.3.2 and §2.4.2. */
const KEY_001F = unhex('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');

const SUNSCREEN =
  "Ladies and Gentlemen of the class of '99: If I could offer you only one " +
  'tip for the future, sunscreen would be it.';

const RFC242_NONCE = unhex('000000000000004a00000000');
const RFC242_KEYSTREAM = unhex(
  '224f51f3401bd9e12fde276fb8631ded8c131f823d2c06e27e4fcaec9ef3cf78' +
  '8a3b0aa372600a92b57974cded2b9334794cba40c63e34cdea212c4cf07d41b7' +
  '69a6749f3f630f4122cafe28ec4dc47e26d4346d70b98c73f3e9c53ac40c5945' +
  '398b6eda1a832c89c167eacd901d7e2bf363',
);
const RFC242_CIPHERTEXT = unhex(
  '6e2e359a2568f98041ba0728dd0d6981e97e7aec1d4360c20a27afccfd9fae0b' +
  'f91b65c5524733ab8f593dabcd62b3571639d624e65152ab8f530c359f0861d8' +
  '07ca0dbf500d6a6156a38e088a22b65e52bc514d16ccf806818ce91ab7793736' +
  '5af90bbf74a35be6b40b8eedf2785e42874d',
);

/** OpenSSL chacha20: IV = counter_le32 || nonce96. */
function nodeChaCha20Xor(key, nonce, data, counter) {
  const iv = Buffer.alloc(16);
  iv.writeUInt32LE(counter >>> 0, 0);
  Buffer.from(nonce).copy(iv, 4);
  const cipher = createCipheriv('chacha20', Buffer.from(key), iv);
  const out = cipher.update(Buffer.from(data));
  cipher.final();
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}

function randomBytesView(n) {
  const b = randomBytes(n);
  return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
}

/* ------------------------------------------------------------------ */
/* RFC 8439 §2.4.2 — the canonical cipher test vector                 */
/* ------------------------------------------------------------------ */

test('RFC 8439 §2.4.2 — plaintext vector is the expected 114 bytes', () => {
  assert.equal(Buffer.byteLength(SUNSCREEN, 'utf8'), 114);
  assert.equal(RFC242_KEYSTREAM.length, 114);
  assert.equal(RFC242_CIPHERTEXT.length, 114);
  assert.equal(KEY_001F.length, CHACHA20_KEY_BYTES);
  assert.equal(RFC242_NONCE.length, CHACHA20_NONCE_BYTES);
});

test('RFC 8439 §2.4.2 — first keystream block (counter = 1) matches, all 64 bytes', () => {
  const ks = chacha20KeystreamBlock(KEY_001F, 1, RFC242_NONCE);
  assert.equal(ks.length, CHACHA20_BLOCK_BYTES);
  assert.equal(toHex(ks), toHex(RFC242_KEYSTREAM.subarray(0, 64)));
  // explicit hex prefix, straight from the RFC, independent of the constant above
  assert.match(toHex(ks), /^224f51f3401bd9e12fde276fb8631ded8c131f823d2c06e27e4fcaec9ef3cf78/);
  assert.equal(
    toHex(ks),
    '224f51f3401bd9e12fde276fb8631ded8c131f823d2c06e27e4fcaec9ef3cf78' +
    '8a3b0aa372600a92b57974cded2b9334794cba40c63e34cdea212c4cf07d41b7',
  );
});

test('RFC 8439 §2.4.2 — second keystream block (counter = 2) completes the vector', () => {
  const ks = chacha20KeystreamBlock(KEY_001F, 2, RFC242_NONCE);
  // The RFC only prints 114 keystream bytes, i.e. the first 50 bytes of block 2.
  assert.equal(
    toHex(ks.subarray(0, 50)),
    '69a6749f3f630f4122cafe28ec4dc47e26d4346d70b98c73f3e9c53ac40c5945' +
    '398b6eda1a832c89c167eacd901d7e2bf363',
  );
  // the whole 64-byte block is then checked against an independent implementation
  assert.deepEqual(Array.from(ks),
    Array.from(nodeChaCha20Xor(KEY_001F, RFC242_NONCE, new Uint8Array(64), 2)));
});

test('RFC 8439 §2.4.2 — ciphertext equals the published vector byte for byte (full 114 bytes, not a prefix)', () => {
  const pt = new Uint8Array(Buffer.from(SUNSCREEN, 'utf8'));
  const ct = chacha20Encrypt(KEY_001F, RFC242_NONCE, pt);
  assert.equal(ct.length, pt.length);
  assert.equal(toHex(ct), toHex(RFC242_CIPHERTEXT));
  assert.deepEqual(Array.from(ct), Array.from(RFC242_CIPHERTEXT));
  // and the whole concatenated keystream shows up in the xor of zeros
  const keystream = chacha20Xor(KEY_001F, RFC242_NONCE, new Uint8Array(114));
  assert.equal(toHex(keystream), toHex(RFC242_KEYSTREAM));
});

test('RFC 8439 §2.4.2 — decrypting the published ciphertext returns the plaintext', () => {
  const pt = chacha20Decrypt(KEY_001F, RFC242_NONCE, RFC242_CIPHERTEXT);
  assert.equal(Buffer.from(pt).toString('utf8'), SUNSCREEN);
});

/* ------------------------------------------------------------------ */
/* RFC 8439 §2.3.2 / A.1 — the block function                         */
/* ------------------------------------------------------------------ */

test('RFC 8439 §2.3.2 — block function vector (key 00..1f, nonce ...09..4a.., counter 1)', () => {
  const nonce = unhex('000000090000004a00000000');
  const expected = unhex(
    '10f1e7e4d13b5915500fdd1fa32071c4c7d1f4c733c068030422aa9ac3d46c4e' +
    'd2826446079faa0914c2d705d98b02a2b5129cd1de164eb9cbd083e8a2503c4e',
  );
  const got = chacha20KeystreamBlock(KEY_001F, 1, nonce);
  assert.equal(toHex(got.subarray(0, 16)), '10f1e7e4d13b5915500fdd1fa32071c4');
  assert.equal(toHex(got), toHex(expected));
  // the same block function must also agree with an independent implementation
  assert.deepEqual(Array.from(got), Array.from(nodeChaCha20Xor(KEY_001F, nonce, new Uint8Array(64), 1)));
});

test('RFC 8439 A.1 — five published block-function vectors', () => {
  const zeros32 = new Uint8Array(32);
  const zeros12 = new Uint8Array(12);
  const keyV3 = (() => { const k = new Uint8Array(32); k[31] = 1; return k; })();
  const keyV4 = (() => { const k = new Uint8Array(32); k[1] = 0xff; return k; })();
  const nonceV5 = (() => { const n = new Uint8Array(12); n[11] = 2; return n; })();

  const cases = [
    ['A.1 #1', zeros32, 0, zeros12,
      '76b8e0ada0f13d90405d6ae55386bd28bdd219b8a08ded1aa836efcc8b770dc7' +
      'da41597c5157488d7724e03fb8d84a376a43b8f41518a11cc387b669b2ee6586'],
    ['A.1 #2', zeros32, 1, zeros12,
      '9f07e7be5551387a98ba977c732d080dcb0f29a048e3656912c6533e32ee7aed' +
      '29b721769ce64e43d57133b074d839d531ed1f28510afb45ace10a1f4b794d6f'],
    ['A.1 #3', keyV3, 1, zeros12,
      '3aeb5224ecf849929b9d828db1ced4dd832025e8018b8160b82284f3c949aa5a' +
      '8eca00bbb4a73bdad192b5c42f73f2fd4e273644c8b36125a64addeb006c13a0'],
    ['A.1 #4', keyV4, 2, zeros12,
      '72d54dfbf12ec44b362692df94137f328fea8da73990265ec1bbbea1ae9af0ca' +
      '13b25aa26cb4a648cb9b9d1be65b2c0924a66c54d545ec1b7374f4872e99f096'],
    ['A.1 #5', zeros32, 0, nonceV5,
      'c2c64d378cd536374ae204b9ef933fcd1a8b2288b3dfa49672ab765b54ee27c7' +
      '8a970e0e955c14f3a88e741b97c286f75f8fc299e8148362fa198a39531bed6d'],
  ];

  for (const [name, key, counter, nonce, hex] of cases) {
    const got = chacha20KeystreamBlock(key, counter, nonce);
    assert.equal(toHex(got), hex, `${name} keystream mismatch`);
    assert.deepEqual(Array.from(got), Array.from(nodeChaCha20Xor(key, nonce, new Uint8Array(64), counter)),
      `${name} disagrees with node:crypto`);
  }
});

test('RFC 8439 A.2 — encryption vectors #1 and #3', () => {
  // #1: zero key/nonce, counter 0, 64 zero bytes => ciphertext == keystream
  const ct1 = chacha20Encrypt(new Uint8Array(32), new Uint8Array(12), new Uint8Array(64), 0);
  assert.equal(toHex(ct1),
    '76b8e0ada0f13d90405d6ae55386bd28bdd219b8a08ded1aa836efcc8b770dc7' +
    'da41597c5157488d7724e03fb8d84a376a43b8f41518a11cc387b669b2ee6586');

  // #3: jabberwocky, 127 bytes (not a multiple of 64), initial counter 42
  const key = unhex('1c9240a5eb55d38af333888604f6b5f0473917c1402b80099dca5cbc207075c0');
  const nonce = unhex('000000000000000000000002');
  const pt = new Uint8Array(Buffer.from(
    "'Twas brillig, and the slithy toves\nDid gyre and gimble in the wabe:\n" +
    'All mimsy were the borogoves,\nAnd the mome raths outgrabe.', 'utf8'));
  assert.equal(pt.length, 127);
  const ct = chacha20Encrypt(key, nonce, pt, 42);
  assert.equal(toHex(ct),
    '62e6347f95ed87a45ffae7426f27a1df5fb69110044c0d73118effa95b01e5cf' +
    '166d3df2d721caf9b21e5fb14c616871fd84c54f9d65b283196c7fe4f60553eb' +
    'f39c6402c42234e32a356b3e764312a61a5532055716ead6962568f87d3f3f77' +
    '04c6a8d1bcd1bf4d50d6154b6da731b187b58dfd728afa36757a797ac188d1');
  assert.deepEqual(Array.from(chacha20Decrypt(key, nonce, ct, 42)), Array.from(pt));
});

/* ------------------------------------------------------------------ */
/* cross-validation against node:crypto (the strongest evidence)       */
/* ------------------------------------------------------------------ */

test('cross-validation vs node:crypto chacha20 — 15 random cases, byte identical', () => {
  const requiredLengths = [0, 1, 63, 64, 65, 4096, 10000];
  const lengths = [...requiredLengths];
  while (lengths.length < 15) lengths.push(randomBytes(2).readUInt16LE(0)); // extra random sizes

  assert.equal(lengths.length, 15);

  for (let i = 0; i < 15; i++) {
    const len = lengths[i];
    const key = randomBytesView(32);
    const nonce = randomBytesView(12);
    const data = randomBytesView(len);
    const blocks = Math.ceil(len / 64);
    // keep the counter sequence inside 32-bit space so neither impl wraps
    const counter = blocks === 0
      ? randomBytes(4).readUInt32LE(0)
      : randomBytes(4).readUInt32LE(0) % (0x100000000 - blocks);

    const mine = chacha20Xor(key, nonce, data, counter);
    const theirs = nodeChaCha20Xor(key, nonce, data, counter);

    assert.equal(mine.length, len, `case ${i} (len ${len}) wrong length`);
    assert.deepEqual(Array.from(mine), Array.from(theirs),
      `case ${i}: key=${toHex(key).slice(0, 8)}… nonce=${toHex(nonce)} counter=${counter} len=${len}`);
  }
});

test('cross-validation vs node:crypto — keystream blocks 0..3 for a random key/nonce', () => {
  const key = randomBytesView(32);
  const nonce = randomBytesView(12);
  const stream = nodeChaCha20Xor(key, nonce, new Uint8Array(256), 0);
  for (let c = 0; c < 4; c++) {
    const ks = chacha20KeystreamBlock(key, c, nonce);
    assert.deepEqual(Array.from(ks), Array.from(stream.subarray(c * 64, c * 64 + 64)),
      `block ${c} disagrees with node:crypto`);
  }
});

test('default counter is 1 (RFC 8439 convention)', () => {
  const key = randomBytesView(32);
  const nonce = randomBytesView(12);
  const data = randomBytesView(200);
  assert.deepEqual(Array.from(chacha20Xor(key, nonce, data)), Array.from(chacha20Xor(key, nonce, data, 1)));
  assert.deepEqual(Array.from(chacha20Xor(key, nonce, data, 1)),
    Array.from(nodeChaCha20Xor(key, nonce, data, 1)));
  assert.notDeepEqual(Array.from(chacha20Xor(key, nonce, data, 1)),
    Array.from(chacha20Xor(key, nonce, data, 0)));
});

test('multi-block stream is the concatenation of consecutive keystream blocks', () => {
  const key = randomBytesView(32);
  const nonce = randomBytesView(12);
  const len = 64 * 3 + 7;
  const zeros = new Uint8Array(len);
  const stream = chacha20Xor(key, nonce, zeros, 5);
  for (let c = 0; c < 4; c++) {
    const ks = chacha20KeystreamBlock(key, 5 + c, nonce);
    const want = stream.subarray(c * 64, Math.min((c + 1) * 64, len));
    assert.deepEqual(Array.from(ks.subarray(0, want.length)), Array.from(want));
  }
});

/* ------------------------------------------------------------------ */
/* API semantics                                                       */
/* ------------------------------------------------------------------ */

test('encrypt/decrypt round-trip on random data of assorted lengths', () => {
  const key = randomBytesView(32);
  const nonce = randomBytesView(12);
  // "the cipher transformed the data" cannot be asserted per sample for short inputs: a one-byte ciphertext
  // equals its plaintext with probability 1/256, because the keystream byte is uniform. That is exactly what
  // made this test flake -- D87, open since round 190 and root-caused in round 260, when the failing
  // assertion was finally captured ('ciphertext == plaintext at len 1') and the rate measured: 11 collisions
  // in 5000 one-byte samples. My round-245 conclusion that it was 'not input-dependent' was wrong: 200 clean
  // runs were a coin flip against a 1-in-256 event. So the two jobs are split -- per-length where a collision
  // is impossible in practice, and once over the whole loop for the short lengths.
  let differed = 0;
  let nonEmpty = 0;
  for (const len of [0, 1, 2, 63, 64, 65, 128, 129, 999, 4096, 10001]) {
    const pt = randomBytesView(len);
    const ct = chacha20Encrypt(key, nonce, pt);
    assert.equal(ct.length, len);
    const back = chacha20Decrypt(key, nonce, ct);
    assert.deepEqual(Array.from(back), Array.from(pt), `round trip failed at len ${len}`);
    if (len === 0) continue;
    nonEmpty++;
    if (toHex(ct) !== toHex(pt)) differed++;
    // 8 bytes and up: a full collision needs 2^-64, so this can be asserted per sample.
    if (len >= 8) assert.notEqual(toHex(ct), toHex(pt), `ciphertext == plaintext at len ${len}`);
  }
  // And for the short lengths, the same claim made soundly: a pass-through cipher would collide everywhere.
  assert.ok(differed > 0, `every one of ${nonEmpty} non-empty lengths encrypted to its own plaintext`);
});

test('inputs are never mutated, and the output is a fresh buffer', () => {
  const key = randomBytesView(32);
  const nonce = randomBytesView(12);
  const data = randomBytesView(200);
  const keyCopy = key.slice(), nonceCopy = nonce.slice(), dataCopy = data.slice();

  const out = chacha20Encrypt(key, nonce, data, 7);
  assert.deepEqual(Array.from(key), Array.from(keyCopy));
  assert.deepEqual(Array.from(nonce), Array.from(nonceCopy));
  assert.deepEqual(Array.from(data), Array.from(dataCopy));
  assert.notEqual(out.buffer, data.buffer, 'output must not alias the input buffer');
  assert.ok(out instanceof Uint8Array);

  // decrypting from the ciphertext buffer must not corrupt it either
  const ctCopy = out.slice();
  chacha20Decrypt(key, nonce, out, 7);
  assert.deepEqual(Array.from(out), Array.from(ctCopy));
});

test('accepts ArrayBuffer as well as Uint8Array, and returns identical bytes', () => {
  const key = randomBytesView(32);
  const nonce = randomBytesView(12);
  const data = randomBytesView(133);
  const viaView = chacha20Encrypt(key, nonce, data);
  const viaAB = chacha20Encrypt(
    key.slice().buffer,
    nonce.slice().buffer,
    new Uint8Array(data).slice().buffer,
  );
  assert.deepEqual(Array.from(viaAB), Array.from(viaView));
});

test('empty input yields an empty Uint8Array (no keystream side effects)', () => {
  const out = chacha20Encrypt(randomBytesView(32), randomBytesView(12), new Uint8Array(0));
  assert.ok(out instanceof Uint8Array);
  assert.equal(out.length, 0);
});

test('non-multiple-of-64 tail: only the needed keystream bytes are consumed', () => {
  const key = randomBytesView(32);
  const nonce = randomBytesView(12);
  const pt = randomBytesView(65);
  const ct = chacha20Encrypt(key, nonce, pt, 0);
  assert.equal(ct.length, 65);
  // first 64 bytes must equal the single-block encryption of the same prefix
  assert.deepEqual(Array.from(ct.subarray(0, 64)),
    Array.from(chacha20Encrypt(key, nonce, pt.subarray(0, 64), 0)));
  // byte 64 is XORed with keystream block 1, byte 0
  const ks1 = chacha20KeystreamBlock(key, 1, nonce);
  assert.equal(ct[64], pt[64] ^ ks1[0]);
});

test('length validation throws RangeError', () => {
  const nonce = randomBytesView(12);
  const data = new Uint8Array(8);
  for (const bad of [new Uint8Array(0), new Uint8Array(16), new Uint8Array(31), new Uint8Array(33), new Uint8Array(64)]) {
    assert.throws(() => chacha20Encrypt(bad, nonce, data), RangeError, `key len ${bad.length} accepted`);
    assert.throws(() => chacha20KeystreamBlock(bad, 0, nonce), RangeError, `key len ${bad.length} accepted`);
  }
  const key = randomBytesView(32);
  for (const bad of [new Uint8Array(0), new Uint8Array(8), new Uint8Array(11), new Uint8Array(13), new Uint8Array(16)]) {
    assert.throws(() => chacha20Encrypt(key, bad, data), RangeError, `nonce len ${bad.length} accepted`);
    assert.throws(() => chacha20KeystreamBlock(key, 0, bad), RangeError, `nonce len ${bad.length} accepted`);
  }
  assert.throws(() => chacha20Encrypt(key, nonce, data, -1), RangeError);
  assert.throws(() => chacha20Encrypt(key, nonce, data, 0x100000000), RangeError);
  assert.throws(() => chacha20Encrypt(key, nonce, data, 1.5), TypeError);
  assert.throws(() => chacha20Encrypt(key, nonce, data, '1'), TypeError);
  assert.throws(() => chacha20Encrypt(null, nonce, data), TypeError);
  assert.throws(() => chacha20Encrypt(key, 'not-bytes', data), TypeError);
  // the legal extremes do not throw
  chacha20Encrypt(key, nonce, data, 0);
  chacha20Encrypt(key, nonce, data, 0xffffffff);
});

/* ------------------------------------------------------------------ */
/* deriveKey (needs core/hash.js — owned by another workstream)        */
/* ------------------------------------------------------------------ */

let hashReady = false;
try {
  const mod = await import('../../core/hash.js');
  hashReady = typeof mod.pbkdf2Sha256 === 'function';
} catch {
  hashReady = false;
}

test('deriveKey — PBKDF2-HMAC-SHA256 stretch to a 32-byte ChaCha key', async (t) => {
  if (!hashReady) {
    t.skip('core/hash.js (pbkdf2Sha256) not implemented yet — skipping deriveKey coverage');
    return;
  }
  const salt = unhex('0b0e0d070a090c0305020f0106040b0a');
  const dk = await deriveKey('correct horse battery staple', salt, 1000);
  assert.ok(dk instanceof Uint8Array);
  assert.equal(dk.length, CHACHA20_KEY_BYTES);

  // deterministic for the same inputs, different for a different salt
  const again = await deriveKey('correct horse battery staple', salt, 1000);
  assert.equal(toHex(dk), toHex(again));
  const other = await deriveKey('correct horse battery staple', salt.slice(0, 15), 1000);
  assert.notEqual(toHex(dk), toHex(other));

  // agrees with node's PBKDF2 (sha256), and is usable as a ChaCha20 key
  const want = new Uint8Array(pbkdf2Sync('correct horse battery staple', Buffer.from(salt), 1000, 32, 'sha256'));
  assert.equal(toHex(dk), toHex(want));
  const nonce = unhex('000000000000004a00000000');
  const ct = chacha20Encrypt(dk, nonce, new Uint8Array(70));
  assert.equal(ct.length, 70);
  assert.deepEqual(Array.from(chacha20Decrypt(dk, nonce, ct)), Array.from(new Uint8Array(70)));

  // iteration count matters; bogus iteration counts throw
  assert.notEqual(toHex(await deriveKey('x', salt, 999)), toHex(await deriveKey('x', salt, 1000)));
  await assert.rejects(() => deriveKey('x', salt, 0), RangeError);
  await assert.rejects(() => deriveKey('x', salt, 1.5), RangeError);
});
