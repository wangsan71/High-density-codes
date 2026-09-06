import test from 'node:test';
import assert from 'node:assert/strict';
import { crc16, crc32, crc32Chain, toHex, fromHex } from '../../core/crc.js';
import {
  BitWriter,
  BitReader,
  bytesToBits,
  bitsToBytes,
  levelsToBits,
  bitsToLevels,
  toGray,
  fromGray,
  grayAlphabet,
  interleaveTable,
  applyPermute,
  defaultStep,
  isPrime,
} from '../../core/pack.js';

test('crc16 CCITT-FALSE check value and incremental behaviour', () => {
  assert.equal(crc16('123456789'), 0x29b1);
  assert.equal(crc16(new Uint8Array(0)), 0xffff);
  const a = fromHex('001122334455');
  const b = fromHex('66778899');
  assert.equal(crc16(new Uint8Array([...a, ...b])), crc16(b, crc16(a)));
  // single bit flip always detected
  let undetected = 0;
  for (let i = 0; i < 64; i++) {
    const base = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
    const t = Uint8Array.from(base);
    t[i >> 3] ^= 1 << (i & 7);
    if (crc16(base) === crc16(t)) undetected++;
  }
  assert.equal(undetected, 0);
});

test('crc32 published check value and chaining', () => {
  assert.equal(crc32('123456789'), 0xcbf43926);
  assert.equal(crc32(new Uint8Array(0)), 0);
  const a = fromHex('de1c0c47237b'), b = fromHex('89d2c701');
  assert.equal(crc32Chain(crc32(a), b), crc32(new Uint8Array([...a, ...b])));
});

test('hex helpers', () => {
  assert.equal(toHex(fromHex('00ff10')), '00ff10');
  assert.throws(() => fromHex('abc'), RangeError);
});

test('bit packing is MSB-first and invertible', () => {
  const data = new Uint8Array([0b1001_0110, 0b0000_1111, 0xff, 0x00]);
  const bits = bytesToBits(data);
  assert.equal(bits.length, 32);
  assert.deepEqual(Array.from(bits.slice(0, 8)), [1, 0, 0, 1, 0, 1, 1, 0]);
  assert.deepEqual(Array.from(bitsToBytes(bits)), Array.from(data));

  const w = new BitWriter(8);
  w.write(0b101, 3);
  w.write(0x5a, 8);
  w.writeBit(1);
  w.writeBytes(new Uint8Array([0x0f]));
  const out = w.result();
  assert.equal(out.length, Math.ceil((3 + 8 + 1 + 8) / 8));
  const r = new BitReader(out);
  assert.equal(r.read(3), 0b101);
  assert.equal(r.read(8), 0x5a);
  assert.equal(r.readBit(), 1);
  assert.equal(r.read(8), 0x0f);
  assert.equal(r.remaining, out.length * 8 - 20); // zero padding to the byte boundary
  assert.equal(r.read(r.remaining), 0, 'padding bits must be zero');
  assert.throws(() => r.readBit(), RangeError);
});

test('multi-bit level packing keeps cell alignment', () => {
  for (const bits of [1, 2, 3]) {
    const levels = new Uint16Array([0, 1, 2, 3, 4, 5, 6, 7].map((v) => v & ((1 << bits) - 1)));
    const b = levelsToBits(levels, bits);
    assert.equal(b.length, levels.length * bits);
    assert.deepEqual(Array.from(bitsToLevels(b, bits)), Array.from(levels));
  }
});

test('gray code: bijection, adjacency differs by one bit', () => {
  for (const bits of [1, 2, 3, 4]) {
    const { encode, decode, size } = grayAlphabet(bits);
    assert.equal(size, 1 << bits);
    const seen = new Set();
    for (let i = 0; i < size; i++) {
      seen.add(encode[i]);
      assert.equal(decode[encode[i]], i);
      assert.equal(encode[i], toGray(i));
      assert.equal(fromGray(encode[i]), i);
    }
    assert.equal(seen.size, size, 'gray map must be a permutation');
    for (let i = 1; i < size; i++) {
      const d = encode[i] ^ encode[i - 1];
      assert.equal(d & (d - 1), 0, `consecutive gray words must differ in exactly one bit (${i - 1}->${i})`);
      assert.equal(d, 1 << Math.floor(Math.log2(d)), 'sanity: single bit');
    }
  }
});

test('interleave: permutation, coprime step, self-inverse composition', () => {
  for (const n of [1, 2, 3, 7, 64, 100, 10816, 23409]) {
    const step = defaultStep(n);
    assert.equal(isPrime(step) || n <= 2, true, `step ${step} for n=${n}`);
    const { fwd, inv } = interleaveTable(n, step);
    assert.equal(new Set(fwd).size, n, 'must be a permutation');
    for (let i = 0; i < n; i++) assert.equal(inv[fwd[i]], i);
    const src = new Uint16Array(n);
    for (let i = 0; i < n; i++) src[i] = i & 0xffff;
    const p = applyPermute(src, fwd);
    const back = applyPermute(p, inv);
    assert.deepEqual(Array.from(back), Array.from(src));
  }
});

test('interleave spreads a contiguous physical burst across the stream', () => {
  const n = 10816;
  const { inv } = interleaveTable(n);
  // cells 500..563 are destroyed physically; where do they land in symbol order?
  const burst = new Set();
  for (let c = 500; c < 564; c++) burst.add(inv[c]);
  assert.equal(burst.size, 64);
  const sorted = [...burst].sort((a, b) => a - b);
  const span = sorted[sorted.length - 1] - sorted[0];
  assert.ok(span > n / 4, `burst must be scattered (span ${span})`);
});
