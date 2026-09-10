/**
 * core/image/jpegish.js -- coefficient blocks to bytes and back (PLAN v5 P2b, brick three).
 * The property under test is the one the whole project rests on: the same coefficients come back, or
 * the decoder says why not. Silent corruption is the only unacceptable outcome.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fdct8x8, quantise, dequantise, magnitudeBits, QUANT_LUMA } from '../../core/image/dct.js';
import {
  ZIGZAG, toZigzag, fromZigzag, magnitudeValue, valueFromMagnitude,
  scanSymbols, encodeBlocks, decodeBlocks, parseHeader,
} from '../../core/image/jpegish.js';
import { huffmanLengths } from '../../core/image/huff.js';

const sparse = (entries) => {
  const b = new Int16Array(64);
  for (const [i, v] of entries) b[i] = v;
  return b;
};

test('jpegish: the zigzag sequence is the standard one and inverts', () => {
  assert.deepEqual(Array.from(ZIGZAG.slice(0, 10)), [0, 1, 8, 16, 9, 2, 3, 10, 17, 24]);
  assert.equal(ZIGZAG[63], 63);
  assert.equal(new Set(ZIGZAG).size, 64);
  const nat = new Int16Array(64).map((_, i) => i + 1);
  const round = fromZigzag(toZigzag(nat));
  assert.deepEqual(Array.from(round), Array.from(nat));
  // Position 1 in zigzag order is natural index 1, position 2 is natural index 8: a transposed table
  // would still invert, which is why the two hand-checked entries above are part of the test.
  assert.equal(toZigzag(nat)[2], 9);
});

test('jpegish: magnitude representation round-trips for every value at its own size', () => {
  // The (value, size) pair is not free: the size must be the one magnitudeBits() reports, otherwise the
  // leading bit stops telling the sign. Both directions are checked, and the boundary values where the
  // leading bit flips are checked explicitly.
  assert.equal(valueFromMagnitude(0, 0), 0);
  for (let s = 1; s <= 15; s++) {
    // The size boundaries themselves: the leading bit flips exactly at +-2^(s-1).
    assert.equal(magnitudeBits(2 ** (s - 1)), s, 'positive boundary of size ' + s);
    assert.equal(magnitudeBits(-(2 ** (s - 1))), s, 'negative boundary of size ' + s);
    assert.equal(magnitudeBits(2 ** s - 1), s, 'top of size ' + s);
    for (const v of [-(2 ** s - 1), -(2 ** (s - 1)), -(2 ** (s - 1)) + 1, -1, 1, 2 ** (s - 1), 2 ** s - 1]) {
      if (v === 0) continue;
      const size = Math.max(1, magnitudeBits(v));
      assert.equal(valueFromMagnitude(magnitudeValue(v, size), size), v, 'v=' + v + ' size=' + size);
    }
  }
});

test('jpegish: DC prediction is what makes a flat image cheap', () => {
  const flat = [];
  for (let i = 0; i < 20; i++) flat.push(sparse([[0, 100]]));
  const { dcFreq } = scanSymbols(flat);
  assert.equal(dcFreq[0], 19, 'the first block pays for its DC, the rest predict it exactly');
  const { bytes, stats } = encodeBlocks(flat);
  assert.ok(stats.bodyBytes < 20, 'a flat block should cost about an end-of-block symbol, got ' + stats.bodyBytes + ' B');
  const back = decodeBlocks(bytes, flat.length);
  assert.deepEqual(back.map((b) => b[0]), flat.map((b) => b[0]));
});

test('jpegish: quantised real coefficients survive the round trip', () => {
  const blocks = [];
  for (let n = 0; n < 24; n++) {
    const raw = new Float32Array(64);
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) raw[y * 8 + x] = 128 + 45 * Math.sin((x + n) / 2.5) * Math.cos((y + n) / 1.7);
    }
    blocks.push(quantise(fdct8x8(raw), QUANT_LUMA, 70));
    blocks.push(new Int16Array(64));                                   // an all-zero block
  }
  blocks.push(sparse([[0, -7], [63, 3], [62, -250]]));                 // last coefficient non-zero
  blocks.push(sparse([[0, 5], [17, 9]]));                              // forces a ZRL symbol
  const { bytes, stats } = encodeBlocks(blocks);
  assert.ok(stats.headerBytes > 30 && stats.headerBytes < 200, 'header ' + stats.headerBytes + ' B');
  assert.ok(stats.dcMaxLen <= 16 && stats.acMaxLen <= 16);
  const back = decodeBlocks(bytes, blocks.length);
  for (let i = 0; i < blocks.length; i++) {
    assert.deepEqual(Array.from(back[i]), Array.from(blocks[i]), 'block ' + i + ' differs');
  }
  // The ZRL symbol must actually have been used, or the test above proved nothing about it.
  const { acFreq } = scanSymbols(blocks);
  assert.ok(acFreq[0xf0] >= 1, 'the sparse block was expected to need a ZRL symbol');
});

test('jpegish: the stream carries its own tables and says what the header costs', () => {
  const blocks = [sparse([[0, 40], [5, -3]]), sparse([[0, 40], [9, 12], [40, -1]])];
  const { bytes, stats } = encodeBlocks(blocks);
  const head = parseHeader(bytes);
  assert.equal(head.bodyOffset, stats.headerBytes);
  assert.equal(head.body.length, stats.bodyBytes);
  assert.equal(head.dcLengths.length, 256);
  // The tables in the header must be the ones the encoder used: a symbol with no code would make the
  // stream undecodable, and an unused one would waste header bytes.
  assert.ok(head.dcLengths[0] > 0, 'the zero-size DC symbol was used and needs a code');
  assert.ok(head.acLengths[0] > 0, 'end-of-block needs a code');
  const { dcFreq, acFreq } = scanSymbols(blocks);
  for (let s = 0; s < 256; s++) {
    if (acFreq[s] > 0) assert.ok(head.acLengths[s] > 0, 'AC symbol ' + s + ' was used but has no code');
    if (head.acLengths[s] > 0) assert.ok(acFreq[s] > 0, 'AC symbol ' + s + ' has a code but was never used');
  }
  // The header must rebuild the EXACT tables the encoder used, not merely some valid-looking set: a
  // reader that has to guess the symbol order can decode a well-formed stream into wrong coefficients.
  assert.deepEqual(Array.from(head.acLengths), Array.from(huffmanLengths(acFreq, 16)));
  assert.deepEqual(Array.from(head.dcLengths), Array.from(huffmanLengths(dcFreq, 16)));
});

test('jpegish: a stream that is not ours is refused by name', () => {
  const { bytes } = encodeBlocks([sparse([[0, 1]])]);
  const bad = Uint8Array.from(bytes); bad[0] = 0x51;
  assert.throws(() => parseHeader(bad), /bad magic/);
  const ver = Uint8Array.from(bytes); ver[4] = 9;
  assert.throws(() => parseHeader(ver), /version 9/);
  assert.throws(() => parseHeader(Uint8Array.from([0x50, 0x53, 0x4b])), /too short/);
  // Truncation must be a refusal, never a shorter answer.
  const cut = bytes.slice(0, bytes.length - 3);
  assert.throws(() => decodeBlocks(cut, 1), /jpegish|huff/);
  // Asking for more blocks than were encoded must also fail rather than invent zero blocks.
  assert.throws(() => decodeBlocks(bytes, 50), /jpegish|huff/);
});

test('jpegish: measured tables beat a flat 8-bit-per-coefficient stream', () => {
  const blocks = [];
  for (let n = 0; n < 40; n++) blocks.push(sparse([[0, n], [1, n % 3 === 0 ? 12 : 0], [2, -4]]));
  const { bytes, stats } = encodeBlocks(blocks);
  assert.ok(stats.bodyBytes * 8 < blocks.length * 64 * 8 / 4, 'the coder must actually compress');
  const back = decodeBlocks(bytes, blocks.length);
  assert.deepEqual(Array.from(back[39]), Array.from(blocks[39]));
});
