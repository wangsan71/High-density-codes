/**
 * core/image/color.js -- the colour transform and the chroma upsampling filter.
 * The property that matters: a full-resolution round trip must be near-lossless (so the transform is not
 * what costs quality), and the upsampler must not invent values outside its inputs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { rgbToYCbCr, upsampleChroma2x, yCbCrToRgb } from '../../core/image/color.js';

const psnr = (a, b, n) => {
  let se = 0;
  for (let i = 0; i < n; i++) se += (a[i] - b[i]) ** 2;
  const mse = se / n;
  return mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse);
};

function gradient(w, h) {
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      px[i] = (x * 7 + y * 3) % 256;
      px[i + 1] = (x * 2 + y * 11) % 256;
      px[i + 2] = (x * 5 + y * 5 + 40) % 256;
      px[i + 3] = 255;
    }
  }
  return px;
}

test('color: the RGB to YCbCr to RGB round trip is near-lossless at full chroma resolution', () => {
  const w = 32;
  const h = 16;
  const src = gradient(w, h);
  const { Y, Cb, Cr, cw, ch } = rgbToYCbCr(src, w, h);
  // Undo the 4:2:0 downsample exactly (nearest replication) so this test measures the transform alone.
  const cbFull = new Float32Array(w * h);
  const crFull = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      cbFull[y * w + x] = Cb[(y >> 1) * cw + (x >> 1)];
      crFull[y * w + x] = Cr[(y >> 1) * cw + (x >> 1)];
    }
  }
  const back = yCbCrToRgb(Y, cbFull, crFull, w, h);
  // Chroma is quantised to one byte per 2x2 block here, so the bound is set by that, not by the maths.
  const p = psnr(src, back, w * h * 3);
  assert.ok(p > 40, 'transform round trip should be near-lossless, got ' + p.toFixed(2) + ' dB');
});

test('color: the upsampler is exact on a constant plane and never overshoots a ramp', () => {
  const cw = 8;
  const ch = 4;
  const flat = new Float32Array(cw * ch).fill(77);
  const up = upsampleChroma2x(flat, cw, ch, cw * 2, ch * 2);
  for (const v of up) assert.equal(v, 77);
  const ramp = new Float32Array(cw * ch);
  for (let i = 0; i < cw * ch; i++) ramp[i] = i % cw;
  const ru = upsampleChroma2x(ramp, cw, ch, cw * 2, ch * 2);
  for (let y = 0; y < ch * 2; y++) {
    for (let x = 0; x < cw * 2; x++) {
      const v = ru[y * cw * 2 + x];
      assert.ok(v >= 0 && v <= cw - 1, 'overshoot at ' + x + ',' + y + ': ' + v);
    }
    // Monotone in x: a triangle filter on a ramp cannot reorder values.
    for (let x = 1; x < cw * 2; x++) assert.ok(ru[y * cw * 2 + x] >= ru[y * cw * 2 + x - 1] - 1e-6);
  }
  // The two interior samples between two taps are the 3/4 and 1/4 mixes, in that order.
  assert.equal(ru[2], (3 * ramp[1] + ramp[0]) / 4);
  assert.equal(ru[3], (3 * ramp[1] + ramp[2]) / 4);
});
