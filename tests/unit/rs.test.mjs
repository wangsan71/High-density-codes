import test from 'node:test';
import assert from 'node:assert/strict';
import * as gf from '../../core/gf256.js';
import {
  rsEncode,
  rsDecode,
  rsSyndromes,
  generatorPoly,
  rsEncodeBlocks,
  rsDecodeBlocks,
  rsCapacity,
} from '../../core/rs.js';

/** deterministic xorshift so failures always reproduce */
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
const rand = (r, n) => {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (r() * 256) | 0;
  return b;
};

test('gf256: α is primitive (all 255 powers distinct, α^255 == 1)', () => {
  const seen = new Set();
  for (let i = 0; i < 255; i++) seen.add(gf.exp(i));
  assert.equal(seen.size, 255);
  assert.equal(gf.exp(255), 1);
  for (let k = 1; k < 255; k++) assert.notEqual(gf.exp(k), 1, `α^${k} must not be 1`);
});

test('gf256: table algebra closes (commutativity, distributivity, inverse) over all 65536 pairs', () => {
  for (let a = 0; a < 256; a++) {
    for (let b = 0; b < 256; b++) {
      assert.equal(gf.mul(a, b), gf.mul(b, a));
    }
  }
  for (let a = 1; a < 256; a++) assert.equal(gf.mul(a, gf.inv(a)), 1, `inv(${a})`);
  for (let a = 0; a < 256; a += 3) {
    for (let b = 0; b < 256; b += 5) {
      for (let c = 0; c < 256; c += 7) {
        assert.equal(gf.mul(a, b ^ c), gf.mul(a, b) ^ gf.mul(a, c));
      }
    }
  }
  assert.equal(gf.mul(0, 5), 0);
  assert.equal(gf.div(7, 7), 1);
  assert.throws(() => gf.div(1, 0), RangeError);
});

test('gf256: exp/pow negative and large exponents', () => {
  for (const a of [1, 2, 3, 7, 0x53, 0xff]) {
    for (const n of [0, 1, 5, 254, 255, 300]) {
      assert.equal(gf.pow(a, n), gf.pow(a, n + 255), `periodicity for ${a}^${n}`);
      if (n > 0) assert.equal(gf.mul(gf.pow(a, n), gf.pow(a, -n)), 1, `inverse power ${a}^${n}`);
    }
  }
  assert.equal(gf.pow(2, 8), 0x1d); // 0x100 ^ 0x11d
  assert.equal(gf.pow(0, 0), 1);
});

test('gf256: polynomial helpers', () => {
  // (x + a)(x + b) == x^2 + (a+b)x + ab
  const a = 0x53, b = 0x7f;
  const p = gf.polyMulHF(new Uint8Array([1, a]), new Uint8Array([1, b]));
  assert.equal(p.length, 3);
  assert.equal(p[0], 1);
  assert.equal(p[1], a ^ b);
  assert.equal(p[2], gf.mul(a, b));
  assert.equal(gf.polyEvalHF(p, 1), 1 ^ a ^ b ^ gf.mul(a, b));
  // LF derivative: d/dx (x^3) = 0 in char 2, d/dx(x^2 + x) = 1
  assert.equal(gf.polyDegLF(gf.polyDerivLF(new Uint8Array([0, 0, 0, 1]))), 3); // 3 mod 2 == 1, so d/dx x^3 == x^2
  const d = gf.polyDerivLF(new Uint8Array([9, 8, 7, 6]));
  assert.deepEqual(Array.from(d), [8, 0, 6]);
  // mod x^n truncation
  const m = gf.polyMulModXnLF(new Uint8Array([1, 1]), new Uint8Array([1, 1]), 2);
  assert.deepEqual(Array.from(m), [1, 0]); // (1+x)^2 = 1 + x^2, truncated at x^2
});

test('rs: generator polynomial has α^0..α^(nsym-1) as roots, monic', () => {
  for (const nsym of [2, 10, 16, 32, 64, 127]) {
    const g = generatorPoly(nsym);
    assert.equal(g.length, nsym + 1);
    assert.equal(g[0], 1);
    for (let i = 0; i < nsym; i++) assert.equal(gf.polyEvalHF(g, gf.exp(i)), 0, `root α^${i} of g_${nsym}`);
  }
});

test('rs: systematic encoding keeps data and produces zero syndromes', () => {
  const r = rng(7);
  for (const [k, nsym] of [[1, 4], [12, 10], [223, 32], [253, 2], [127, 128]]) {
    const d = rand(r, k);
    const cw = rsEncode(d, nsym);
    assert.equal(cw.length, k + nsym);
    assert.deepEqual(Array.from(cw.subarray(0, k)), Array.from(d), 'data must be unchanged');
    assert.equal(rsSyndromes(cw, nsym).nonzero, false, `clean syndromes k=${k}`);
  }
});

test('rs: known small vector (RS(7,3) style) decodes a single symbol error', () => {
  const d = new Uint8Array([1, 2, 3]);
  const cw = rsEncode(d, 4);
  const bad = Uint8Array.from(cw);
  bad[1] ^= 0x5e;
  const res = rsDecode(bad, 4);
  assert.equal(res.ok, true);
  assert.equal(res.errors, 1);
  assert.deepEqual(Array.from(res.cw), Array.from(cw));
});

test('rs: exhaustive stress �?every (t,e) with 2t+e <= nsym recovers', () => {
  const cases = [
    [8, 0], [16, 0], [0, 16], [0, 32], [5, 10], [9, 6], [1, 30], [8, 1],
    [10, 10], [0, 31], [15, 2], [2, 28], [4, 24],
  ];
  for (const [t, e] of cases) {
    let okc = 0;
    const tries = 40, k = 223, nsym = 32, n = k + nsym;
    let lastReason = '';
    for (let trial = 0; trial < tries; trial++) {
      const r = rng(9000 + trial * 31 + t * 131 + e * 17);
      const d = rand(r, k);
      const cw = rsEncode(d, nsym);
      const idx = [...Array(n).keys()];
      for (let i = n - 1; i > 0; i--) {
        const j = (r() * (i + 1)) | 0;
        [idx[i], idx[j]] = [idx[j], idx[i]];
      }
      const errPos = idx.slice(0, t);
      const eraPos = idx.slice(t, t + e);
      const recv = Uint8Array.from(cw);
      for (const j of errPos) {
        let v = 0;
        while (v === 0) v = (r() * 256) | 0;
        recv[j] ^= v;
      }
      for (const j of eraPos) recv[j] = 0;
      const res = rsDecode(recv, nsym, eraPos);
      if (res.ok && Array.from(res.cw.subarray(0, k)).every((x, i) => x === d[i])) okc++;
      else lastReason = res.reason || 'mismatch';
    }
    assert.equal(okc, tries, `t=${t} e=${e} (2t+e=${2 * t + e}) -> ${okc}/${tries} ${lastReason}`);
  }
});

test('rs: burst of erasures equal to nsym is recoverable (this is what G7 depends on)', () => {
  const r = rng(1234);
  for (const nsym of [16, 32, 64, 127]) {
    const k = Math.min(127, 255 - nsym);
    const d = rand(r, k);
    const cw = rsEncode(d, nsym);
    const recv = Uint8Array.from(cw);
    const er = [];
    for (let i = 0; i < nsym; i++) {
      const j = (i * 7) % cw.length;
      er.push(j);
      recv[j] = 0;
    }
    const uniq = [...new Set(er)];
    assert.ok(uniq.length === nsym, 'test bug: duplicate erasure positions');
    const res = rsDecode(recv, nsym, uniq);
    assert.equal(res.ok, true, `nsym=${nsym} full-strength erasure decode must work`);
    assert.deepEqual(Array.from(res.cw.subarray(0, k)), Array.from(d));
  }
});

test('rs: beyond the limit is reported as failure, never silently accepted', () => {
  const k = 223, nsym = 32;
  const d = new Uint8Array(k).fill(0x33);
  const cw = rsEncode(d, nsym);
  // 20 unknown errors > 16 correctable
  const bad1 = Uint8Array.from(cw);
  for (let j = 0; j < 20; j++) bad1[j] ^= j + 1;
  const r1 = rsDecode(bad1, nsym);
  assert.equal(r1.ok, false);
  assert.ok(r1.reason, 'must carry a reason');
  // 33 erasures > nsym
  const bad2 = Uint8Array.from(cw);
  const er = [];
  for (let j = 0; j < 33; j++) {
    er.push(j * 5 % cw.length);
  }
  er.forEach((j) => (bad2[j] = 0));
  const r2 = rsDecode(bad2, nsym, [...new Set(er)]);
  assert.equal(r2.ok, false);
  // out of range erasure index
  assert.equal(rsDecode(Uint8Array.from(cw), nsym, [99999]).ok, false);
});

test('rs: 255 blocks �?no codeword shorter than nsym+1 accepted silently', () => {
  const cw = rsEncode(new Uint8Array([5]), 8);
  assert.equal(cw.length, 9);
  assert.ok(rsDecode(Uint8Array.from(cw), 8).ok);
});

test('rs: block helpers round-trip with global erasure indices', () => {
  const r = rng(777);
  const k = 223, nsym = 32, nblk = 6;
  const data = rand(r, k * nblk);
  const { stream, blockSize } = rsEncodeBlocks(data, k, nsym);
  assert.equal(stream.length, nblk * blockSize);
  const tampered = Uint8Array.from(stream);
  const erased = [];
  for (let i = 0; i < 40; i++) {
    const g = (r() * stream.length) | 0;
    erased.push(g);
    tampered[g] = 0;
  }
  const res = rsDecodeBlocks(tampered, k, nsym, erased);
  assert.equal(res.ok, true, `failed blocks: ${res.failedBlocks}`);
  assert.deepEqual(Array.from(res.data.subarray(0, data.length)), Array.from(data));
  assert.equal(res.erasures, [...new Set(erased)].length);
});

test('rs: capacity reporting', () => {
  assert.deepEqual(rsCapacity(32), { errors: 16, erasures: 32 });
  assert.deepEqual(rsCapacity(127), { errors: 63, erasures: 127 });
});
