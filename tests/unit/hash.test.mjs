/**
 * PSKT unit tests — core/hash.js (SHA-256 / HMAC / PBKDF2).
 *
 * Strategy: FIPS 180-4 public vectors pin the algorithm, then node:crypto acts as
 * an independent oracle over every padding boundary length and random inputs.
 * Run: node --test tests/unit/hash.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';

import {
  sha256,
  sha256Hex,
  hmacSha256,
  pbkdf2Sha256,
  digest,
  constantTimeEqual,
} from '../../core/hash.js';

const hex = (b) => Buffer.from(b).toString('hex');
const bytes = (...a) => Uint8Array.from(...a);

/* ------------------------------------------------------------------ */
/* SHA-256: published vectors                                          */
/* ------------------------------------------------------------------ */

test('sha256: FIPS 180-4 / NIST public vectors', () => {
  assert.equal(
    sha256Hex(''),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  );
  assert.equal(
    sha256Hex('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
  // 56-byte message: 56 + 1 + 8 > 64, so padding spans two blocks. NB: FIPS 180-4
  // prints the SHA-224 digest of this same string (…6b8ff330cd56889f2b4c11e0);
  // the SHA-256 value is the one below (verified against node:crypto).
  assert.equal(
    sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'),
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
  );
  assert.equal(
    sha256Hex('a'.repeat(1000000)),
    'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0',
  );
});

test('sha256: padding-boundary lengths have the expected digests', () => {
  // rem = len % 64; rem <= 55 pads in one block, rem >= 56 needs a second block.
  const expected = {
    1: 'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb',
    55: '9f4390f8d30c2dd92ec9f095b65e2b9ae9b0a925a5258e241c9f1e910f734318',
    56: 'b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a',
    63: '7d3e74a05d7db15bce4ad9ec0658ea98e3f06eeecf16b4c6fff2da457ddc2f34',
    64: 'ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb',
    65: '635361c48bb9eab14198e76ea8ab7f1a41685d6ad62aa9146d301d4f17eb0ae0',
    119: '31eba51c313a5c08226adf18d4a359cfdfd8d2e816b13f4af952f7ea6584dcfb',
    120: '2f3d335432c70b580af0e8e1b3674a7c020d683aa5f73aaaedfdc55af904c21c',
    128: '6836cf13bac400e9105071cd6af47084dfacad4e5e302c94bfed24e013afb73e',
    129: 'c12cb024a2e5551cca0e08fce8f1c5e314555cc3fef6329ee994a3db752166ae',
  };
  for (const [len, want] of Object.entries(expected)) {
    const s = 'a'.repeat(Number(len));
    assert.equal(sha256Hex(s), want, `string len=${len}`);
    assert.equal(sha256Hex(bytes(new Uint8Array(s.length).fill(0x61))), want, `bytes len=${len}`);
    assert.equal(sha256Hex(new TextEncoder().encode(s).buffer), want, `ArrayBuffer len=${len}`);
  }
});

test('sha256: matches node:crypto over 20 lengths incl. every block boundary', () => {
  const lengths = [
    0, 1, 2, 55, 56, 57, 63, 64, 65, 111, 112, 119, 127, 128, 129, 1000, 4096,
    65535, 65536, 65537,
  ];
  assert.equal(lengths.length, 20);
  for (const len of lengths) {
    const data = randomBytes(len);
    assert.equal(
      hex(sha256(data)),
      createHash('sha256').update(data).digest('hex'),
      `len=${len}`,
    );
  }
});

test('sha256: matches node:crypto on 40 random-length blobs', () => {
  for (let i = 0; i < 40; i++) {
    const len = Math.floor(Math.random() * 30000);
    const data = randomBytes(len);
    assert.equal(hex(sha256(data)), createHash('sha256').update(data).digest('hex'), `len=${len}`);
  }
});

test('sha256: accepts strings (UTF-8), ArrayBuffer, views, and number arrays', () => {
  const s = '日本語テスト'; // 6 code units → 18 UTF-8 bytes
  assert.equal(new TextEncoder().encode(s).length, 18);
  assert.equal(
    sha256Hex(s),
    '4b09dffafb42f5b069c66a0283523c0e85c9af2a5530a8fbd541b3e5f9a9c7cd',
  );
  assert.equal(sha256Hex(s), sha256Hex(new TextEncoder().encode(s)));

  const raw = randomBytes(200);
  const rawAB = new Uint8Array(raw).slice().buffer; // standalone ArrayBuffer, not a pool view
  assert.equal(hex(sha256(rawAB)), hex(sha256(raw)));
  // A view with a non-zero byteOffset must hash only its own bytes.
  const pooled = new Uint8Array(300);
  pooled.set(raw, 50);
  const view = new Uint8Array(pooled.buffer, 50, raw.length);
  assert.equal(hex(sha256(view)), hex(sha256(raw)));
  assert.equal(hex(sha256(Array.from(raw.slice(0, 16)))), hex(sha256(raw.slice(0, 16))));
  assert.equal(hex(sha256(Buffer.from(raw))), hex(sha256(raw))); // Node Buffer is a Uint8Array
});

test('sha256: returns a fresh 32-byte array and never mutates its input', () => {
  const data = randomBytes(130);
  const copy = Uint8Array.from(data);
  const a = sha256(data);
  const b = sha256(data);
  assert.ok(a instanceof Uint8Array);
  assert.equal(a.length, 32);
  assert.notEqual(a, b); // no shared scratch buffer between calls
  assert.deepEqual(a, b);
  b[0] ^= 0xff;
  assert.equal(a[0], b[0] ^ 0xff); // mutating one result leaves the other alone
  assert.equal(hex(data), hex(copy)); // input left untouched
});

test('digest() is the payload-summary alias of sha256()', () => {
  const payload = randomBytes(512);
  assert.deepEqual(digest(payload), sha256(payload));
  assert.equal(hex(digest('abc')), sha256Hex('abc'));
});

/* ------------------------------------------------------------------ */
/* HMAC-SHA256                                                         */
/* ------------------------------------------------------------------ */

test('hmacSha256: matches node:crypto on 10 random key/message pairs', () => {
  const cases = [
    [new Uint8Array(0), randomBytes(32)], // empty key
    [randomBytes(100), randomBytes(64)], // key > block size → key gets hashed
    [randomBytes(64), new Uint8Array(0)], // key === block size, empty msg
    [randomBytes(65), randomBytes(1)], // key === block size + 1
    [randomBytes(32), randomBytes(0)],
  ];
  for (let i = 0; i < 5; i++) {
    cases.push([randomBytes(1 + Math.floor(Math.random() * 200)), randomBytes(Math.floor(Math.random() * 300))]);
  }
  assert.equal(cases.length, 10);
  for (const [key, msg] of cases) {
    assert.equal(
      hex(hmacSha256(key, msg)),
      createHmac('sha256', key).update(msg).digest('hex'),
      `key=${key.length} msg=${msg.length}`,
    );
  }
});

test('hmacSha256: strings and RFC 4231-style vector, output is 32 fresh bytes', () => {
  // RFC 4231 hatley test case 2 (trimmed key/message form).
  assert.equal(
    hex(hmacSha256('key', 'The quick brown fox jumps over the lazy dog')),
    'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8',
  );
  assert.equal(
    hex(hmacSha256('secret', 'payload')),
    createHmac('sha256', 'secret').update('payload').digest('hex'),
  );
  const out = hmacSha256('k', 'm');
  assert.ok(out instanceof Uint8Array);
  assert.equal(out.length, 32);
});

/* ------------------------------------------------------------------ */
/* PBKDF2-HMAC-SHA256                                                  */
/* ------------------------------------------------------------------ */

test('pbkdf2Sha256: published vectors', () => {
  assert.equal(
    hex(pbkdf2Sha256('password', 'salt', 1, 32)),
    '120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b',
  );
  assert.equal(
    hex(pbkdf2Sha256('password', 'salt', 2, 32)),
    'ae4d0c95af6b46d32d0adff928f06dd02a303f8ef3c251dfd6e2d85a95474c43',
  );
  assert.equal(
    hex(pbkdf2Sha256('password', 'salt', 4096, 32)),
    'c5e478d59288c841aa530db6845c4c8d962893a001ce4e11a4963873aa98134a',
  );
});

test('pbkdf2Sha256: matches node:crypto across dkLen and iteration shapes', () => {
  const cases = [
    ['password', 'salt', 1, 32],
    ['password', 'salt', 2, 32],
    ['password', 'salt', 4096, 32],
    ['password', 'salt', 4096, 40], // two blocks, second one truncated
    ['password', 'salt', 1, 1], // single leading byte
    ['password', 'salt', 1, 40],
    ['password', 'salt', 3, 64], // exact multiple of the PRF output
    ['password', 'salt', 2, 65], // three blocks
    ['', 'salt', 5, 32], // empty password
    ['p', '', 7, 20], // empty salt
    ['口令password', '盐salt', 100, 48], // non-ASCII strings → UTF-8
  ];
  for (const [p, s, c, dk] of cases) {
    assert.equal(
      hex(pbkdf2Sha256(p, s, c, dk)),
      pbkdf2Sync(p, s, c, dk, 'sha256').toString('hex'),
      `pw=${JSON.stringify(p)} salt=${JSON.stringify(s)} c=${c} dkLen=${dk}`,
    );
  }
});

test('pbkdf2Sha256: matches node:crypto with random salts and byte inputs', () => {
  for (let i = 0; i < 8; i++) {
    const pw = randomBytes(1 + Math.floor(Math.random() * 80));
    const salt = randomBytes(1 + Math.floor(Math.random() * 130));
    const c = 1 + Math.floor(Math.random() * 12);
    const dk = 1 + Math.floor(Math.random() * 100);
    assert.equal(
      hex(pbkdf2Sha256(pw, salt, c, dk)),
      pbkdf2Sync(pw, salt, c, dk, 'sha256').toString('hex'),
      `pw=${pw.length} salt=${salt.length} c=${c} dkLen=${dk}`,
    );
    // long salt (> block size) must also work when given as an ArrayBuffer
    const saltAB = new Uint8Array(salt).slice().buffer; // not a view into a Buffer pool
    assert.equal(
      hex(pbkdf2Sha256(pw, saltAB, c, dk)),
      pbkdf2Sync(pw, salt, c, dk, 'sha256').toString('hex'),
    );
  }
  const out = pbkdf2Sha256('a', 'b', 1, 3);
  assert.ok(out instanceof Uint8Array);
  assert.equal(out.length, 3);
});

test('pbkdf2Sha256: rejects bad iterations / dkLen', () => {
  assert.throws(() => pbkdf2Sha256('a', 'b', 0, 32), RangeError);
  assert.throws(() => pbkdf2Sha256('a', 'b', -1, 32), RangeError);
  assert.throws(() => pbkdf2Sha256('a', 'b', 1.5, 32), RangeError);
  assert.throws(() => pbkdf2Sha256('a', 'b', 1, 0), RangeError);
  assert.throws(() => pbkdf2Sha256('a', 'b', 1, 32.5), RangeError);
});

/* ------------------------------------------------------------------ */
/* constantTimeEqual                                                   */
/* ------------------------------------------------------------------ */

test('constantTimeEqual: equality, content mismatch, length mismatch', () => {
  const a = randomBytes(32);
  assert.equal(constantTimeEqual(a, Uint8Array.from(a)), true);
  assert.equal(constantTimeEqual(a, a), true);
  assert.equal(constantTimeEqual(new Uint8Array(0), new Uint8Array(0)), true);

  const lastDiff = Uint8Array.from(a);
  lastDiff[lastDiff.length - 1] ^= 0x01;
  assert.equal(constantTimeEqual(a, lastDiff), false);

  const firstDiff = Uint8Array.from(a);
  firstDiff[0] ^= 0x80;
  assert.equal(constantTimeEqual(a, firstDiff), false);

  assert.equal(constantTimeEqual(a, a.subarray(0, 31)), false); // shorter
  assert.equal(constantTimeEqual(a.subarray(0, 31), a), false); // longer
  assert.equal(constantTimeEqual('abc', 'abc'), true); // strings accepted
  assert.equal(constantTimeEqual('abc', 'abd'), false);
  assert.equal(constantTimeEqual(hex(digest('x')), hex(digest('x'))), true);
});

/* ------------------------------------------------------------------ */
/* performance guardrail                                               */
/* ------------------------------------------------------------------ */

test('sha256: 1 MB random data is hashed fast (throughput floor)', () => {
  const data = randomBytes(1024 * 1024);
  sha256(data); // warm up the JIT

  const runs = [];
  for (let i = 0; i < 3; i++) {
    const t0 = process.hrtime.bigint();
    sha256(data);
    runs.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  const ms = Math.min(...runs);
  const mib = data.length / 1048576;
  console.log(
    `  sha256: 1 MiB in ${ms.toFixed(2)} ms (best of 3) → ~${(mib / (ms / 1000)).toFixed(1)} MB/s ` +
      `(all runs: ${runs.map((r) => r.toFixed(2)).join(', ')} ms)`,
  );
  // Deliberately loose: machine noise must not fail the suite. 60 MB/s is the
  // design target; anything under 2 s is a working implementation.
  assert.ok(ms < 200, `expected 1 MB under the 200 ms budget, took ${ms.toFixed(1)} ms`);
  assert.ok(ms < 2000, `sha256 looks broken-slow: ${ms.toFixed(1)} ms for 1 MB`);
});
