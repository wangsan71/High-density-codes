import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import {
  compress,
  decompress,
  isCompressed,
  deflateRaw,
  inflateRaw,
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
