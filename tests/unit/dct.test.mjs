/**
 * core/image/dct.js -- the transform and quantiser that decide quality (PLAN v5 P2b, brick one).
 * The entropy coder does not exist yet, so these tests pin the parts that do: the transform is
 * invertible, the quantiser is the only lossy step, and quality actually moves the error.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fdct8x8, idct8x8, quantise, dequantise, qualityScale,
  QUANT_LUMA, estimateBlockBits, magnitudeBits,
} from '../../core/image/dct.js';

function blockFrom(fn) {
  const b = new Float32Array(64);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) b[y * 8 + x] = fn(x, y);
  return b;
}

test('dct: forward then inverse is the identity to float precision', () => {
  const b = blockFrom((x, y) => Math.sin(x * 0.7) * Math.cos(y * 0.3) * 60 + 128);
  const back = idct8x8(fdct8x8(b));
  let worst = 0;
  for (let i = 0; i < 64; i++) worst = Math.max(worst, Math.abs(back[i] - b[i]));
  assert.ok(worst < 1e-3, 'round trip error ' + worst);
});

test('dct: a flat block has energy only in the DC coefficient', () => {
  const coeffs = fdct8x8(blockFrom(() => 128));
  assert.ok(Math.abs(coeffs[0] - 128 * 8) < 1e-3, 'DC should carry level*8, got ' + coeffs[0]);
  for (let i = 1; i < 64; i++) assert.ok(Math.abs(coeffs[i]) < 1e-3, 'AC ' + i + ' should be zero');
});

test('dct: quality moves the error, with q100 near-lossless and q10 coarse', () => {
  const b = blockFrom((x, y) => 128 + 40 * Math.sin((x + y) / 3));
  const coeffs = fdct8x8(b);
  const err = (q) => {
    const back = idct8x8(dequantise(quantise(coeffs, QUANT_LUMA, q), QUANT_LUMA, q));
    let se = 0;
    for (let i = 0; i < 64; i++) se += (back[i] - b[i]) ** 2;
    return Math.sqrt(se / 64);
  };
  const fine = err(100);
  const q70 = err(70);
  const coarse = err(10);
  // At q100 every step clamps to 1, so the only error left is rounding 64 coefficients to integers:
  // about 0.2 rms for a block of amplitude 40. That floor is the transform's, not a defect.
  assert.ok(fine < 0.5, 'q100 rms ' + fine);
  assert.ok(q70 > fine, 'a lower quality must not be more accurate');
  assert.ok(q70 < 12, 'q70 rms on a smooth block should stay small, got ' + q70);
  assert.ok(coarse > q70, 'q10 must be coarser than q70');
});

test('dct: qualityScale matches the convention the oracle numbers were produced with', () => {
  assert.equal(qualityScale(50), 100);
  assert.equal(qualityScale(70), 60);
  assert.equal(qualityScale(25), 200);
  assert.equal(qualityScale(100), 0);
});

test('dct: the size model is a monotone function of quality, and 0 costs nothing', () => {
  const b = blockFrom((x, y) => 128 + 50 * Math.cos(x / 2) * Math.sin(y / 2));
  const coeffs = fdct8x8(b);
  const bits = (q) => estimateBlockBits(quantise(coeffs, QUANT_LUMA, q));
  const flat = estimateBlockBits(quantise(fdct8x8(blockFrom(() => 128)), QUANT_LUMA, 70));
  assert.ok(flat <= 16, 'a flat block is one DC plus end-of-block, got ' + flat + ' bits');
  assert.ok(bits(90) >= bits(70), 'higher quality must not cost fewer bits');
  assert.ok(bits(70) >= bits(30), 'lower quality must not cost more bits');
  assert.equal(magnitudeBits(0), 0);
  assert.equal(magnitudeBits(1), 1);
  assert.equal(magnitudeBits(255), 8);
});
