/**
 * core/image/huff.js -- canonical Huffman coding (PLAN v5 P2b, brick two).
 * The point of these tests is that the code is *decodable by the same rule the encoder used* and that
 * the 16-bit length limit is repaired into a still-complete code, not into a silently broken one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  huffmanLengths, canonicalCodes, decoderTable, readSymbol,
  BitWriter, BitReader, codedBits, entropyBits,
} from '../../core/image/huff.js';

const kraft = (lengths) => lengths.reduce((s, l) => s + (l > 0 ? 2 ** -l : 0), 0);
const fib = (n) => { const f = [1, 1]; while (f.length < n) f.push(f[f.length - 1] + f[f.length - 2]); return f.slice(0, n); };

test('huff: canonical codes match the hand-computed reference', () => {
  const codes = canonicalCodes(Uint8Array.from([2, 1, 3, 3]));
  assert.deepEqual(Array.from(codes), [2, 0, 6, 7]);
});

test('huff: a measured distribution gives a complete prefix-free code', () => {
  const freqs = new Uint32Array([1000, 500, 250, 125, 60, 30, 15, 7, 3, 1]);
  const lengths = huffmanLengths(freqs);
  for (let i = 0; i < freqs.length; i++) assert.ok(lengths[i] > 0, 'used symbol ' + i + ' got no code');
  assert.ok(Math.abs(kraft(lengths) - 1) < 1e-12, 'Kraft sum ' + kraft(lengths));
  const codes = canonicalCodes(lengths);
  for (let a = 0; a < lengths.length; a++) {
    for (let b = 0; b < lengths.length; b++) {
      if (a === b) continue;
      const shifted = codes[a] >>> (lengths[a] - lengths[b]);
      assert.ok(!(lengths[b] <= lengths[a] && shifted === codes[b]), 'code ' + a + ' starts with code ' + b);
    }
  }
});

test('huff: the 16-bit limit is repaired into a complete code, not into a broken one', () => {
  const freqs = Uint32Array.from(fib(40));           // deliberately deep tree
  const lengths = huffmanLengths(freqs, 16);
  assert.ok(lengths.every((l) => l <= 16), 'a length exceeded the limit: ' + Array.from(lengths).join(','));
  assert.ok(Math.abs(kraft(lengths) - 1) < 1e-12, 'Kraft sum after repair ' + kraft(lengths));
  const tight = huffmanLengths(freqs, 8);
  assert.ok(tight.every((l) => l <= 8));
  // A tighter limit can only cost bits; the penalty is what the header's limit buys back.
  assert.ok(codedBits(freqs, tight) >= codedBits(freqs, lengths));
  // Measured cost of the 16-bit limit on this deliberately pathological distribution: 0.31% more bits
  // than the deepest code (fib(64): 0.04%). The bound is loose on purpose -- it is a regression fence,
  // not a claim that the limiter is optimal (it is a greedy repair, not package-merge).
  const deep = huffmanLengths(freqs, 32);
  const penalty = codedBits(freqs, lengths) / codedBits(freqs, deep);
  assert.ok(penalty <= 1.01, 'the 16-bit limit cost ' + ((penalty - 1) * 100).toFixed(2) + '% here');
});

test('huff: the code sits between the entropy and entropy+1 bit per symbol', () => {
  const freqs = Uint32Array.from([812, 400, 199, 98, 51, 25, 12, 6, 3, 2, 1]);
  const lengths = huffmanLengths(freqs);
  const total = freqs.reduce((a, b) => a + b, 0);
  const h = entropyBits(freqs);
  const c = codedBits(freqs, lengths);
  assert.ok(c >= h, 'Huffman cannot beat the entropy: ' + c + ' < ' + h);
  assert.ok(c <= h + total, 'Huffman must stay within one bit per symbol: ' + c + ' vs ' + h + ' + ' + total);
});

test('huff: encode then decode returns the same symbols', () => {
  const alphabet = 40;
  const freqs = new Uint32Array(alphabet);
  const seq = [];
  let rng = 12345;
  for (let i = 0; i < alphabet; i++) freqs[i] = (i % 5) + 1;
  for (let i = 0; i < 5000; i++) {
    rng = (rng * 1103515245 + 12345) & 0x7fffffff;
    const pick = rng % alphabet;
    seq.push(pick);
    freqs[pick]++;
  }
  const lengths = huffmanLengths(freqs);
  const codes = canonicalCodes(lengths);
  const w = new BitWriter();
  for (const s of seq) w.writeBits(codes[s], lengths[s]);
  const bytes = w.finish();
  const dec = decoderTable(lengths);
  const r = new BitReader(bytes);
  const back = [];
  for (let i = 0; i < seq.length; i++) back.push(readSymbol(r, dec));
  assert.deepEqual(back, seq);
  // The coder must not be wasting the padded bits: the payload is a near-optimal code.
  assert.ok(bytes.length * 8 <= codedBits(freqs, lengths) + 8);
});

test('huff: one symbol gets a one-bit code, and no symbols means no codes', () => {
  const single = huffmanLengths(Uint32Array.from([0, 7, 0]));
  assert.deepEqual(Array.from(single), [0, 1, 0]);
  const w = new BitWriter();
  w.writeBits(0, 1); w.writeBits(0, 1); w.writeBits(0, 1);
  const r = new BitReader(w.finish());
  const dec = decoderTable(single);
  assert.equal(readSymbol(r, dec), 1);
  assert.equal(readSymbol(r, dec), 1);
  const none = huffmanLengths(new Uint32Array(4));
  assert.deepEqual(Array.from(none), [0, 0, 0, 0]);
  assert.equal(entropyBits(new Uint32Array(4)), 0);
});

test('huff: the reader refuses to read past the end and refuses unknown codes', () => {
  const r = new BitReader(Uint8Array.from([0b10100000]));
  assert.equal(r.readBits(3), 0b101);
  assert.equal(r.bitsLeft, 5);
  assert.throws(() => r.readBits(6), /ran out/);
  // Positive control for readSymbol: a code that is not in the table must throw, not return garbage.
  const dec = decoderTable(Uint8Array.from([1, 1]));
  const bad = new BitReader(Uint8Array.from([0b11110000]));
  bad.readBits(1);
  assert.equal(readSymbol(bad, dec), 1);
  const wide = decoderTable(Uint8Array.from([0, 0, 2, 2]));
  const junk = new BitReader(Uint8Array.from([0b11111111]));
  assert.throws(() => readSymbol(junk, wide), /no code matches/);
});
