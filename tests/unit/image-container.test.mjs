/**
 * core/image/container.js -- one image as one payload.
 * What is tested: the payload describes itself, the picture comes back, and anything that is not a
 * payload this build wrote is refused by name instead of decoded into a different picture.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { packImage, unpackImage, parseContainer, HEADER_BYTES, MAGIC } from '../../core/image/container.js';

const psnr = (a, b, n) => {
  let se = 0;
  for (let i = 0; i < n; i++) se += (a[i] - b[i]) ** 2;
  const mse = se / n;
  return mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse);
};

function photo(w, h) {
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const u = x / w;
      px[i] = 60 + 150 * u + 40 * Math.sin(y / 9);
      px[i + 1] = 70 + 120 * (y / h) + 30 * Math.sin(x / 7);
      px[i + 2] = 90 + 80 * (1 - u) + 20 * Math.cos((x + y) / 11);
      px[i + 3] = 255;
    }
  }
  return px;
}

test('container: a payload describes itself and gives the picture back', () => {
  const w = 61;              // deliberately odd, and not a multiple of 8
  const h = 43;
  const src = photo(w, h);
  const { bytes, stats } = packImage(src, w, h, 90);
  const head = parseContainer(bytes);
  assert.equal(head.width, w);
  assert.equal(head.height, h);
  assert.equal(head.quality, 90);
  assert.equal(stats.headerBytes, HEADER_BYTES);
  assert.equal(bytes.length, HEADER_BYTES + head.lens.reduce((a, b) => a + b, 0));
  const out = unpackImage(bytes);
  assert.equal(out.rgba.length, w * h * 4, 'the decoder must hand back exactly the declared geometry');
  const p = psnr(src, out.rgba, w * h * 3);
  assert.ok(p > 32, 'q90 on a smooth image should be well above 32 dB, got ' + p.toFixed(2));
  assert.ok(bytes.length < w * h * 4, 'the payload must be smaller than the raw pixels: ' + bytes.length + ' vs ' + w * h * 4);
});

test('container: packing is deterministic and the magic is the one the reader expects', () => {
  const src = photo(32, 24);
  const a = packImage(src, 32, 24, 70);
  const b = packImage(src, 32, 24, 70);
  assert.deepEqual(Array.from(a.bytes), Array.from(b.bytes));
  assert.deepEqual(Array.from(a.bytes.slice(0, 4)), MAGIC);
  assert.equal(a.stats.planeBytes.length, 3);
  assert.ok(a.stats.planeBytes[0] > a.stats.planeBytes[1], 'luma carries more than one chroma plane');
});

test('container: a payload that is not ours, or is not whole, is refused by name', () => {
  const src = photo(24, 16);
  const { bytes } = packImage(src, 24, 16, 70);
  const badMagic = Uint8Array.from(bytes); badMagic[0] = 0x51;
  assert.throws(() => parseContainer(badMagic), /bad magic/);
  const badVersion = Uint8Array.from(bytes); badVersion[4] = 7;
  assert.throws(() => parseContainer(badVersion), /version 7/);
  assert.throws(() => parseContainer(bytes.slice(0, 10)), /too short/);
  const badSub = Uint8Array.from(bytes); badSub[10] = 3;
  assert.throws(() => parseContainer(badSub), /subsampling mode 3/);
  // A header whose declared plane length does not match what is actually there is a different picture,
  // not a shorter one: it has to be caught before a single coefficient is decoded.
  const badLen = Uint8Array.from(bytes); badLen[15] = (badLen[15] + 1) & 0xff;
  assert.throws(() => parseContainer(badLen), /declares .* but the payload is/);
  assert.throws(() => unpackImage(bytes.slice(0, bytes.length - 8)), /container|jpegish|huff/);
});

test('container: quality is carried in the payload, and the argument is the one used', () => {
  const src = photo(48, 32);
  const low = packImage(src, 48, 32, 25);
  const high = packImage(src, 48, 32, 95);
  assert.ok(high.bytes.length > low.bytes.length, 'higher quality must cost bytes');
  assert.equal(parseContainer(low.bytes).quality, 25);
  const pl = psnr(src, unpackImage(low.bytes).rgba, 48 * 32 * 3);
  const ph = psnr(src, unpackImage(high.bytes).rgba, 48 * 32 * 3);
  assert.ok(ph > pl + 3, 'q95 must be clearly better than q25: ' + ph.toFixed(2) + ' vs ' + pl.toFixed(2));
  // A quality outside 1..100 is clamped, not accepted as a different contract.
  assert.equal(packImage(src, 48, 32, 400).stats.quality, 100);
  assert.equal(packImage(src, 48, 32, 0).stats.quality, 1);
  assert.throws(() => packImage(src, 48, 31, 70), /expected width\*height\*4/);
});
