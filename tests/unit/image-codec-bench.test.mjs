/**
 * tools/image-codec-bench.mjs -- the bench itself must be deterministic, or its numbers are not citable.
 * These tests pin that, plus the two ends of the quality range: near-lossless at q100, and strictly
 * worse at q30 than at q90 (a positive control for "the quality knob does something").
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { makePhoto, roundTripPlane } from '../../tools/image-codec-bench.mjs';
import { QUANT_LUMA } from '../../core/image/dct.js';

const planePsnr = (a, b, n) => {
  let se = 0;
  for (let i = 0; i < n; i++) se += (a[i] - b[i]) ** 2;
  const mse = se / n;
  return mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse);
};

test('bench: the generator is deterministic, so the published numbers can be reproduced', () => {
  const a = makePhoto(96, 64);
  const b = makePhoto(96, 64);
  assert.deepEqual(Array.from(a), Array.from(b));
  const c = makePhoto(95, 64);
  assert.notDeepEqual(Array.from(a), Array.from(c), 'a different width must give a different image');
});

test('bench: q100 is near-lossless on a plane and q30 is strictly worse', () => {
  const w = 64, h = 48;
  const px = makePhoto(w, h);
  const Y = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) Y[i] = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
  const fine = roundTripPlane(Y, w, h, QUANT_LUMA, 100);
  const coarse = roundTripPlane(Y, w, h, QUANT_LUMA, 30);
  const n = w * h;
  // roundTripPlane() centres the plane before the DCT and puts the 128 back on the way out, so both
  // sides of this comparison are in the same (uncentred) space. Comparing against a centred plane here
  // is worth 5.99 dB of pure offset error, which is exactly what this comment is here to prevent.
  const pf = planePsnr(Y, fine.plane.subarray(0, n), n);
  const pc = planePsnr(Y, coarse.plane.subarray(0, n), n);
  assert.ok(pf > 45, 'q100 should be near-lossless on the luma plane, got ' + pf.toFixed(2) + ' dB');
  assert.ok(pc < pf - 5, 'q30 must be clearly worse than q100: ' + pc.toFixed(2) + ' vs ' + pf.toFixed(2));
  assert.ok(fine.bytes > coarse.bytes, 'quality must cost bytes as well as dB');
});
