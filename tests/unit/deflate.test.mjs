import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import {
  compress,
  decompress,
  isCompressed,
  deflateRaw,
  inflateRaw,
  decompressPayload,
  MAGIC,
  METHOD_STORED,
  METHOD_DEFLATE,
  HEADER_SIZE,
} from '../../core/deflate.js';

function rng(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

function textCorpus(n, seed = 5) {
  const words = ['print', 'scan', 'pskit', 'plate', 'nozzle', 'parity', '{', '}', '"k":', '123', 'true', ' '];
  const r = rng(seed);
  const out = [];
  for (let i = 0; i < n; i++) out.push(words[(r() * words.length) | 0]);
  return new TextEncoder().encode(out.join(''));
}

function kinds(r, len) {
  const pick = (n) => {
    const b = new Uint8Array(n);
    for (let i = 0; i < n; i++) b[i] = (r() * 256) | 0;
    return b;
  };
  const builders = {
    zeros: (n) => new Uint8Array(n),
    ones: (n) => new Uint8Array(n).fill(0xff),
    ramp: (n) => Uint8Array.from({ length: n }, (_, i) => i & 255),
    ascii: (n) => new TextEncoder().encode('x'.repeat(n)),
    jsonlike: (n) => {
      const t = textCorpus(Math.max(16, n / 6), 11);
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i++) out[i] = t[i % t.length];
      return out;
    },
    random: (n) => pick(n),
    mixed: (n) => {
      const a = textCorpus(Math.max(16, n / 2), 7);
      const b = pick(Math.max(16, n - a.length));
      const out = new Uint8Array(n);
      out.set(a.subarray(0, Math.min(a.length, n)), 0);
      out.set(b.subarray(0, Math.max(0, n - a.length)), Math.min(a.length, n));
      return out;
    },
    lowEntropyNoise: (n) => Uint8Array.from({ length: n }, (_, i) => ((i >> 3) ^ (i >> 11)) & 255),
  };
  const names = Object.keys(builders);
  return names.map((name) => ({ name, bytes: builders[name](len) }));
}

test('deflate: property round-trip over 8 payload kinds x 12 lengths (96 cases)', () => {
  const r = rng(31337);
  const lengths = [0, 1, 2, 3, 17, 100, 1000, 4096, 5000, 65535, 300000, 100000];
  let cases = 0;
  for (const len of lengths) {
    for (const { name, bytes } of kinds(r, len)) {
      const c = compress(bytes);
      assert.ok(c.length >= HEADER_SIZE, `${name}/${len}: container too short`);
      assert.deepEqual(Array.from(c.subarray(0, 4)), Array.from(MAGIC), `${name}/${len}: magic`);
      assert.equal(isCompressed(c), true);
      const method = c[4];
      assert.ok(method === METHOD_STORED || method === METHOD_DEFLATE, `${name}/${len}: method ${method}`);
      const back = decompress(c);
      assert.equal(back.length, bytes.length, `${name}/${len}: length`);
      assert.deepEqual(Array.from(back), Array.from(bytes), `${name}/${len}: content ${name} len ${len}`);
      cases++;
    }
  }
  assert.equal(cases, lengths.length * 8);
});

test('deflate: compression ratio expectations (this is why we bother)', () => {
  const zeros = compress(new Uint8Array(100 * 1024));
  assert.ok(zeros.length < 1024, `100KB of zeros must shrink hard, got ${zeros.length}`);
  const periodic = compress(Uint8Array.from(new TextEncoder().encode('abcabcabc'.repeat(20000))));
  assert.ok(periodic.length < 0.02 * 180000, `repeating text must shrink below 2%, got ${periodic.length}`);
  const r = rng(4);
  const noisy = new Uint8Array(64 * 1024);
  for (let i = 0; i < noisy.length; i++) noisy[i] = (r() * 256) | 0;
  const stored = compress(noisy);
  assert.equal(stored[4], METHOD_STORED, 'incompressible data must fall back to stored');
  assert.ok(stored.length <= noisy.length + HEADER_SIZE + 2, `stored overhead: ${stored.length}`);
  assert.deepEqual(Array.from(decompress(stored)), Array.from(noisy));
});

test('deflate: our output is valid RFC1951 — node:zlib inflates it', () => {
  const r = rng(2024);
  for (const len of [0, 1, 5, 250, 40000, 200000]) {
    for (const { name, bytes } of kinds(r, len)) {
      if (name === 'random' && len > 1000) continue; // stored path has no raw payload to check
      const c = compress(bytes);
      const raw = c.subarray(HEADER_SIZE);
      if (c[4] === METHOD_DEFLATE) {
        const back = new Uint8Array(zlib.inflateRawSync(Buffer.from(raw)));
        assert.deepEqual(Array.from(back), Array.from(bytes), `zlib inflate of our stream: ${name}/${len}`);
      }
    }
  }
});

test('deflate: our inflate handles node:zlib output (fixed, dynamic, stored)', () => {
  const r = rng(99);
  const samples = [];
  for (const len of [0, 1, 10, 500, 40000, 200000]) {
    for (const { bytes } of kinds(r, len)) samples.push(bytes);
  }
  for (const bytes of samples) {
    for (const level of [0, 1, 6, 9]) {
      const raw = new Uint8Array(zlib.deflateRawSync(Buffer.from(bytes), { level }));
      const back = new Uint8Array(inflateRaw(raw, bytes.length));
      assert.deepEqual(Array.from(back), Array.from(bytes), `inflate node level=${level} len=${bytes.length}`);
    }
    // default dynamic-huffman text output (the interesting case)
    const dyn = new Uint8Array(zlib.deflateRawSync(Buffer.from(textCorpus(20000, 3)), { level: 9 }));
    const out = new Uint8Array(inflateRaw(dyn, 20000 * 6 + 100));
    assert.ok(out.length > 0);
  }
});

test('deflate: corrupt containers are rejected, never silently wrong', () => {
  const bytes = textCorpus(5000, 21);
  const c = compress(bytes);
  assert.throws(() => decompress(c.subarray(0, c.length - 5)), 'truncated stream must throw');
  const badLen = Uint8Array.from(c);
  badLen[6] ^= 0xff; // original length field
  assert.throws(() => decompress(badLen), 'length mismatch must throw');
  const badMethod = Uint8Array.from(c);
  badMethod[4] = 7;
  assert.throws(() => decompress(badMethod), 'unknown method must throw');
  const badMagic = Uint8Array.from(c);
  badMagic[1] ^= 0x01;
  assert.equal(isCompressed(badMagic), false);
  assert.throws(() => decompress(badMagic), 'bad magic must throw');
  assert.equal(decompress(c).length, bytes.length, 'untouched container still fine');
});

test('deflate: empty input round-trips', () => {
  const c = compress(new Uint8Array(0));
  assert.equal(decompress(c).length, 0);
  assert.equal(isCompressed(c), true);
});

test('deflate: every byte value x every run length 1..300 round-trips (overlap regression)', () => {
  // The bug this guards against: a match with dist < len must replicate the bytes
  // it is writing, not copy a source range that is still unwritten.
  for (let v = 0; v < 256; v += 7) {
    for (let n = 1; n <= 300; n++) {
      const b = new Uint8Array(n).fill(v);
      const back = decompress(compress(b));
      assert.equal(back.length, n, `len ${n} value ${v}`);
      for (let i = 0; i < n; i++) {
        if (back[i] !== v) throw new Error(`run ${v} x ${n} corrupted at ${i}: ${back[i]}`);
      }
      // and the same stream through zlib must agree
      if (n % 50 === 0) {
        const raw = new Uint8Array(deflateRaw(b));
        const z = new Uint8Array(zlib.inflateRawSync(Buffer.from(raw)));
        assert.equal(z.length, n);
      }
    }
  }
});

test('deflate: alternating short runs (dist=2 replication) round-trips', () => {
  for (const unit of [Buffer.from([0xaa, 0xbb]), Buffer.from('ab'), Buffer.from([0x00, 0xff])]) {
    const bytes = new Uint8Array(Buffer.concat(Array(200).fill(unit)));
    assert.deepEqual(Array.from(decompress(compress(bytes))), Array.from(bytes));
  }
  for (const n of [1000, 2000]) {
    const b = new Uint8Array(n).fill(7);
    assert.deepEqual(Array.from(decompress(compress(b))), Array.from(b));
    const z = new Uint8Array(zlib.deflateRawSync(Buffer.from(b), { level: 9 }));
    assert.deepEqual(Array.from(new Uint8Array(inflateRaw(z, n))), Array.from(b));
  }
});

test('deflate: throughput is usable for MB-scale payloads', () => {
  const big = textCorpus(300000, 33); // ~1.8 MB of compressible text
  const t0 = performance.now();
  const c = compress(big);
  const t1 = performance.now();
  const back = decompress(c);
  const t2 = performance.now();
  console.log(`  ${big.length} bytes -> ${c.length} in ${(t1 - t0).toFixed(0)} ms; back in ${(t2 - t1).toFixed(0)} ms`);
  assert.equal(back.length, big.length);
  assert.ok(t2 - t0 < 20000, `compress+decompress of ${big.length} bytes took ${t2 - t0} ms`);
});

/* ================================================================== */
/* Spec suite (docs/PLAN.md G0): the normative PSZ1 contract checks.   */
/*                                                                     */
/* The heart of this file is the 60-case property block below: a fixed- */
/* seed xorshift generator walks several data shapes, and every case is */
/* asserted three ways -- our own roundtrip, the container framing, and */
/* an *independent* decoder (node:zlib) on our payload. A self-         */
/* consistent bug in encoder+decoder would pass the roundtrip alone;    */
/* pairing it with zlib's decoder is what makes the evidence real.      */
/* ================================================================== */

function bytesEq(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
function firstDiffAt(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}
function writeU32LE(buf, off, value) {
  const v = value >>> 0;
  buf[off] = v & 255;
  buf[off + 1] = (v >>> 8) & 255;
  buf[off + 2] = (v >>> 16) & 255;
  buf[off + 3] = (v >>> 24) & 255;
}
function readU32LE(buf, off) {
  return ((buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16)) >>> 0) + buf[off + 3] * 0x1000000;
}
/** integer xorshift32: reproducible, independent of the JS PRNG */
function xs32(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s >>> 0;
  };
}

const XS = xs32(0x5eed2024);
function rint(lo, hi) {
  return lo + (XS() % (hi - lo + 1));
}
function enc(s) {
  return Uint8Array.from(Buffer.from(s, 'utf8'));
}

const SPEC_SHAPES = {
  allZero: (n) => new Uint8Array(n),
  sameByte: (n) => new Uint8Array(n).fill(rint(0, 255)),
  increasing: (n) => Uint8Array.from({ length: n }, (_, i) => (i * 7 + 3) & 255),
  asciiRepeat: (n) => {
    const u = enc('the quick brown fox jumps over the lazy dog 0123456789\n');
    return Uint8Array.from({ length: n }, (_, i) => u[i % u.length]);
  },
  jsonLike: (n) => {
    const u = enc('{"id":123,"name":"plate-7","profile":"PL-D2","nozzle":0.4,"cells":27556,"ok":true}\n');
    return Uint8Array.from({ length: n }, (_, i) => u[(i + ((i >> 6) & 7)) % u.length]);
  },
  lowEntropyNoise: (n) => {
    const out = new Uint8Array(n);
    let v = rint(0, 255);
    for (let i = 0; i < n; i++) {
      v = (v + rint(-2, 2)) & 255;
      out[i] = v;
    }
    return out;
  },
  highEntropy: (n) => Uint8Array.from({ length: n }, () => XS() & 255),
  mixedTextThenRandom: (n) => {
    const head = SPEC_SHAPES.asciiRepeat(Math.floor(n * 0.6));
    const tail = SPEC_SHAPES.highEntropy(n - head.length);
    const out = new Uint8Array(n);
    out.set(head, 0);
    out.set(tail, head.length);
    return out;
  },
  mixedRandomThenText: (n) => {
    const head = SPEC_SHAPES.highEntropy(Math.floor(n * 0.7));
    const tail = SPEC_SHAPES.jsonLike(n - head.length);
    const out = new Uint8Array(n);
    out.set(head, 0);
    out.set(tail, head.length);
    return out;
  },
};
const SPEC_KINDS = Object.keys(SPEC_SHAPES);

const SPEC_REQUIRED_LENGTHS = [0, 1, 2, 3, 17, 100, 1000, 5000, 65535, 300000];

function specCases() {
  const cases = [];
  for (const n of SPEC_REQUIRED_LENGTHS) {
    cases.push({ n, kind: SPEC_KINDS[cases.length % SPEC_KINDS.length] });
  }
  while (cases.length < 60) {
    cases.push({ n: rint(1, 40000), kind: SPEC_KINDS[cases.length % SPEC_KINDS.length] });
  }
  return cases;
}

test('spec: 60 fixed-seed property cases round-trip byte-exactly and framing holds', () => {
  const cases = specCases();
  assert.equal(cases.length, 60);
  const seenMethod = new Set();
  const seenKind = new Set();
  let deflated = 0;
  for (const { n, kind } of cases) {
    seenKind.add(kind);
    const x = SPEC_SHAPES[kind](n);
    assert.equal(x.length, n, `${kind}/${n}: generator produced wrong length`);

    const c = compress(x);
    // --- container framing: PSZ1 magic, reserved byte, uint32LE length ---
    assert.deepEqual(Array.from(c.subarray(0, 4)), Array.from(MAGIC), `${kind}/${n}: magic`);
    assert.equal(c[4] === METHOD_STORED || c[4] === METHOD_DEFLATE, true, `${kind}/${n}: method ${c[4]}`);
    assert.equal(c[5], 0, `${kind}/${n}: reserved byte must be 0x00`);
    assert.equal(readU32LE(c, 6), n, `${kind}/${n}: originalLength field`);
    assert.ok(c.length >= HEADER_SIZE, `${kind}/${n}: container shorter than the header`);
    assert.equal(isCompressed(c), true, `${kind}/${n}: isCompressed`);
    seenMethod.add(c[4]);

    // --- our own decoder ---
    const back = decompress(c);
    assert.equal(back.length, n, `${kind}/${n}: decoded length`);
    assert.equal(bytesEq(back, x), true, `${kind}/${n}: differs at ${firstDiffAt(back, x)}`);

    // --- independent decoder on the same payload ---
    if (c[4] === METHOD_DEFLATE) {
      deflated++;
      const viaZlib = new Uint8Array(zlib.inflateRawSync(Buffer.from(c.subarray(HEADER_SIZE))));
      assert.equal(bytesEq(viaZlib, x), true, `zlib disagrees on ${kind}/${n} at ${firstDiffAt(viaZlib, x)}`);
    }
  }
  assert.equal(seenKind.size, SPEC_KINDS.length, 'every payload kind must be covered');
  assert.ok(seenMethod.has(METHOD_STORED) && seenMethod.has(METHOD_DEFLATE), 'both methods must appear');
  assert.ok(deflated >= 30, `expected most cases to deflate, got ${deflated}`);
});

test('spec: ratio gates -- zeros < 1%, periodic < 2%, random -> stored within +16', () => {
  const zeros = new Uint8Array(100 * 1024);
  const cz = compress(zeros);
  const pz = (cz.length / zeros.length) * 100;
  console.log(`  100KB zeros      -> ${cz.length} B (${pz.toFixed(3)}%, method ${cz[4]})`);
  assert.ok(pz < 1, `100KB of zeros must land below 1%, got ${pz.toFixed(3)}%`);
  assert.equal(bytesEq(decompress(cz), zeros), true);

  const periodic = enc('abcabcabc'.repeat(20000));
  const cp = compress(periodic);
  const pp = (cp.length / periodic.length) * 100;
  console.log(`  abc*20000 (${periodic.length} B) -> ${cp.length} B (${pp.toFixed(3)}%, method ${cp[4]})`);
  assert.ok(pp < 2, `periodic text must land below 2%, got ${pp.toFixed(3)}%`);
  assert.equal(bytesEq(decompress(cp), periodic), true);

  const rnd = Uint8Array.from({ length: 64 * 1024 }, () => XS() & 255);
  const cr = compress(rnd);
  console.log(`  64KB random      -> ${cr.length} B (method ${cr[4]})`);
  assert.equal(cr[4], METHOD_STORED, 'high-entropy input must take the stored branch');
  assert.ok(cr.length <= rnd.length + 16, `stored container ${cr.length} > ${rnd.length} + 16`);
  assert.equal(bytesEq(decompress(cr), rnd), true);
});

test('spec: zlib cross-check (b) -- fixed, dynamic and stored blocks decode byte-exactly', () => {
  const samples = [
    enc('hello hello hello hello hello hello hello hello'),
    SPEC_SHAPES.jsonLike(150000), // dynamic Huffman, multiple blocks
    SPEC_SHAPES.asciiRepeat(40000),
    SPEC_SHAPES.lowEntropyNoise(9000),
    Uint8Array.from({ length: 5000 }, () => XS() & 255),
    new Uint8Array(200000),
    Uint8Array.from({ length: 1 }, () => 42),
  ];
  for (const x of samples) {
    for (const level of [9, 6, 1, 0]) {
      const raw = new Uint8Array(zlib.deflateRawSync(Buffer.from(x), { level }));
      const mine = new Uint8Array(inflateRaw(raw, x.length));
      assert.equal(bytesEq(mine, x), true, `inflate failed for level ${level}, len ${x.length} at ${firstDiffAt(mine, x)}`);
      // the same bytes through the alias the CLI/tests use
      assert.equal(bytesEq(new Uint8Array(decompressPayload(raw, x.length)), x), true);
    }
  }
  // a dynamic-Huffman stream boxed in a PSZ1 container (method byte we never emit)
  const x = SPEC_SHAPES.jsonLike(60000);
  const dyn = new Uint8Array(zlib.deflateRawSync(Buffer.from(x), { level: 9 }));
  // BFINAL in bit 0, BTYPE in bits 1..2 -> 4 means BTYPE=10, a real dynamic block.
  assert.equal(dyn[0] & 6, 4, 'sanity: this corpus must produce a dynamic-Huffman block');
  const boxed = new Uint8Array(HEADER_SIZE + dyn.length);
  boxed.set(MAGIC, 0);
  boxed[4] = METHOD_DEFLATE;
  writeU32LE(boxed, 6, x.length);
  boxed.set(dyn, HEADER_SIZE);
  assert.equal(bytesEq(decompress(boxed), x), true, 'decompress must accept dynamic blocks');
});

test('spec: tampered originalLength always throws', () => {
  const text = SPEC_SHAPES.asciiRepeat(5000);
  const c = compress(text);
  assert.equal(c[4], METHOD_DEFLATE);
  for (const delta of [1, -1, 4096, -4096, 0x10000]) {
    const bad = Uint8Array.from(c);
    writeU32LE(bad, 6, readU32LE(bad, 6) + delta);
    assert.throws(() => decompress(bad), /originalLength|exceeds/, `tamper ${delta} must be rejected`);
  }
  const stored = compress(Uint8Array.from({ length: 3000 }, () => XS() & 255));
  assert.equal(stored[4], METHOD_STORED);
  for (const delta of [1, -1, 70000]) {
    const bad = Uint8Array.from(stored);
    writeU32LE(bad, 6, readU32LE(bad, 6) + delta);
    assert.throws(() => decompress(bad), /originalLength/, `stored tamper ${delta} must be rejected`);
  }
  assert.equal(decompress(c).length, text.length, 'untouched container still decodes');
});

test('spec: truncation throws or returns provably different data -- never a silent hit', () => {
  const x = SPEC_SHAPES.jsonLike(30000);
  const c = compress(x);
  assert.equal(c[4], METHOD_DEFLATE);
  let threw = 0;
  for (const keep of [0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.99]) {
    const cut = Math.max(HEADER_SIZE, Math.floor(c.length * keep));
    const t = c.slice(0, cut);
    try {
      const out = decompress(t);
      assert.equal(bytesEq(out, x), false, `truncating to ${cut} silently returned the whole payload`);
    } catch (err) {
      assert.ok(err instanceof Error, 'truncation must raise an Error');
      threw++;
    }
  }
  assert.ok(threw >= 6, `expected truncated deflated containers to throw, threw ${threw}/7`);

  assert.throws(() => decompress(c.slice(0, 3)), /too short|magic/);
  assert.throws(() => decompress(c.slice(0, HEADER_SIZE - 1)), /too short/);
  assert.throws(() => decompress(c.slice(0, HEADER_SIZE)), /exceeds|originalLength|truncated/);

  const s = compress(Uint8Array.from({ length: 4000 }, () => XS() & 255));
  assert.equal(s[4], METHOD_STORED);
  assert.throws(() => decompress(s.slice(0, s.length - 1)), /originalLength/);
});

test('spec: junk and non-container input are rejected without throwing from isCompressed', () => {
  assert.equal(isCompressed(enc('just some plain bytes')), false);
  assert.equal(isCompressed(new Uint8Array([0x50, 0x53])), false);
  assert.equal(isCompressed(new Uint8Array([0x50, 0x53, 0x5a, 0x31])), true, 'magic alone counts');
  assert.equal(isCompressed(null), false);
  assert.equal(isCompressed(undefined), false);
  assert.equal(isCompressed('PSZ1'), false);
  assert.throws(() => decompress(enc('not a pskt container at all')), /magic|too short/);

  const c = compress(SPEC_SHAPES.asciiRepeat(400));
  const badMethod = Uint8Array.from(c);
  badMethod[4] = 0x02;
  assert.throws(() => decompress(badMethod), /unsupported method/);
  // Bytes past the end of the final block are ignored (zlib parity: the stream is
  // self-terminating and the frame owns the boundary), so the decode must still be
  // exactly right rather than merely "not an error".
  const withJunk = new Uint8Array(c.length + 2);
  withJunk.set(c);
  withJunk[c.length] = 0x7f;
  withJunk[c.length + 1] = 0x11;
  assert.equal(bytesEq(decompress(withJunk), SPEC_SHAPES.asciiRepeat(400)), true);
  // ... and node:zlib agrees with that same leniency, so the Python reference
  // decoder built on zlib.decompressobj() will behave identically.
  assert.equal(
    zlib.inflateRawSync(Buffer.from(withJunk.subarray(HEADER_SIZE))).length,
    400,
    'zlib must also ignore the trailing bytes',
  );
});

test('spec: bit corruption is detected or changes the data -- never a silent no-op', () => {
  // DEFLATE carries no checksum of its own (the PSKT frame header's CRC16 and the
  // payload SHA-256 digest are what close that hole). So the honest invariant for
  // the codec is: a flipped bit must either throw, or decode to bytes that differ
  // from the original -- it must never look like a clean decode of the original.
  const x = SPEC_SHAPES.asciiRepeat(20000);
  const c = compress(x);
  assert.equal(c[4], METHOD_DEFLATE);
  let threw = 0;
  let differed = 0;
  const silent = [];
  for (let k = 0; k < 60; k++) {
    const bad = Uint8Array.from(c);
    const at = HEADER_SIZE + (rint(0, (1 << 30) - 1) % (bad.length - HEADER_SIZE));
    bad[at] ^= 1 << rint(0, 7);
    try {
      const out = decompress(bad);
      if (bytesEq(out, x)) silent.push(at);
      else differed++;
    } catch (err) {
      assert.ok(err instanceof Error);
      threw++;
    }
  }
  console.log(`  60 single-bit flips: ${threw} threw, ${differed} decoded differently, ${silent.length} silent`);
  assert.equal(silent.length, 0, `flips decoded as a clean copy of the original at ${silent.join(',')}`);
  assert.ok(threw > 0, 'no corruption was rejected at all -- the decoder is not validating');
});

test('spec: ArrayBuffer and view inputs are accepted; stored payload is a copy', () => {
  const data = SPEC_SHAPES.asciiRepeat(500);
  const ab = new ArrayBuffer(data.length);
  new Uint8Array(ab).set(data);
  assert.equal(bytesEq(decompress(compress(ab)), data), true, 'ArrayBuffer input');
  const view = new Uint8Array(ab, 2, 100);
  assert.equal(bytesEq(decompress(compress(view)), data.subarray(2, 102)), true, 'subarray input');

  // mutating the caller's buffer must not change what a stored container decodes to
  const src = Uint8Array.from({ length: 64 }, () => XS() & 255);
  const boxed = compress(src);
  assert.equal(boxed[4], METHOD_STORED);
  const decoded = decompress(boxed);
  boxed[HEADER_SIZE] ^= 0xff;
  assert.equal(decoded[0], src[0], 'decoded buffer must be independent of the container');
});

test('spec: 1MB throughput has real headroom under the G6 budget', () => {
  // A word-soup corpus: mostly literals with mid-length matches, i.e. the shape
  // a manifest or JSON payload actually has -- far more work than a periodic run.
  const local = xs32(0xc0ffee);
  const words = [
    'print', 'scan', 'pskit', 'plate', 'nozzle', 'parity', 'profile', 'digest',
    '{"k":', '123', 'true', 'null', 'PL-D2', '0.4', '27556', '\n', ' ',
  ];
  const parts = [];
  let size = 0;
  const target = 1024 * 1024;
  while (size < target) {
    const w = words[local() % words.length];
    parts.push(w);
    size += w.length + 1;
  }
  const data = enc(parts.join(' '));
  const size1 = data.length;

  const t0 = performance.now();
  const c = compress(data);
  const t1 = performance.now();
  const back = decompress(c);
  const t2 = performance.now();
  const msC = t1 - t0;
  const msD = t2 - t1;
  console.log(
    `  1MB word-soup: compress ${msC.toFixed(1)} ms (budget 3000), decompress ${msD.toFixed(1)} ms ` +
      `(budget 2000), ${c.length} B = ${((c.length / size1) * 100).toFixed(3)}% (method ${c[4]})`,
  );
  const ref = zlib.deflateRawSync(Buffer.from(data), { level: 6 });
  console.log(`  node:zlib level 6 reference size: ${ref.length + HEADER_SIZE} B`);

  assert.equal(bytesEq(back, data), true);
  assert.equal(c[4], METHOD_DEFLATE);
  // independent decoder agreement on a >32 KiB stream (long distances)
  assert.equal(
    bytesEq(new Uint8Array(zlib.inflateRawSync(Buffer.from(c.subarray(HEADER_SIZE)))), data),
    true,
    'zlib disagrees on the 1MB stream',
  );
  // Budget is the gate; 8 s is the ceiling we assert, so a loaded box cannot go falsely red.
  assert.ok(msC < 8000, `compress took ${msC.toFixed(0)} ms, above the 8 s ceiling`);
  assert.ok(msD < 8000, `decompress took ${msD.toFixed(0)} ms, above the 8 s ceiling`);

  // A periodic 1MB stream too: it crosses the 32 KiB window boundary repeatedly.
  const unit = enc('PSKT page 007 of 038 | profile PL-D2 | nozzle 0.4 | parity 20 | cells 27556 | ');
  const periodic = Uint8Array.from({ length: target }, (_, i) => unit[i % unit.length]);
  const p0 = performance.now();
  const pc = compress(periodic);
  const p1 = performance.now();
  const pback = decompress(pc);
  const p2 = performance.now();
  console.log(
    `  1MB periodic : compress ${(p1 - p0).toFixed(1)} ms, decompress ${(p2 - p1).toFixed(1)} ms, ` +
      `${pc.length} B = ${((pc.length / target) * 100).toFixed(3)}%`,
  );
  assert.equal(bytesEq(pback, periodic), true);
  assert.ok(p1 - p0 < 8000 && p2 - p1 < 8000, 'periodic 1MB over the ceiling');
});

test('spec: 1MB of zlib dynamic-Huffman blocks inflates under the G6 budget', () => {
  const size = 1024 * 1024;
  const data = Uint8Array.from({ length: size }, (_, i) => (i * 3 + (i >> 8)) & 255);
  const raw = new Uint8Array(zlib.deflateRawSync(Buffer.from(data), { level: 9 }));
  const t0 = performance.now();
  const out = new Uint8Array(inflateRaw(raw, size));
  const ms = performance.now() - t0;
  console.log(`  1MB zlib-dynamic inflate: ${ms.toFixed(1)} ms (budget 2000, ceiling 8000)`);
  assert.equal(bytesEq(out, data), true);
  assert.ok(ms < 8000, `inflate took ${ms.toFixed(0)} ms, above the 8 s ceiling`);
});

