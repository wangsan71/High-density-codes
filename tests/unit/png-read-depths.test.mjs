/**
 * core/decode/png-read.js -- the PNG variants a scanner actually emits (DEFECTS D80).
 *
 * "Black and white" / "line art" are the default scan modes on most flatbeds, and they
 * write 1-bit gray or palette PNGs; film and photo scanners write 16-bit gray. Refusing
 * those meant the receiver rejected the cleanest input it can be handed and blamed the
 * user's file. These tests build each variant byte by byte (no third-party encoder, so
 * they run anywhere) and assert the exact RGBA the decoder must produce.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { decodePNG } from '../../core/decode/png-read.js';
import { crc32 } from '../../core/crc.js';

const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), Buffer.from(data)]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([len, body, crc]);
}

/**
 * A non-interlaced PNG from raw (already filtered) scanline bytes, with an explicit filter
 * type per row -- so the byte-level filter path can be exercised at every bit depth.
 */
function png({ width, height, depth, colorType, rows, filters, plte, trns, interlace = 0 }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = depth;
  ihdr[9] = colorType;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = interlace;
  const raw = [];
  rows.forEach((r, i) => {
    raw.push(filters ? filters[i] : 0);
    for (const byte of r) raw.push(byte & 255);
  });
  const parts = [SIG, chunk('IHDR', ihdr)];
  if (plte) parts.push(chunk('PLTE', plte));
  if (trns) parts.push(chunk('tRNS', trns));
  parts.push(chunk('IDAT', zlib.deflateSync(Buffer.from(raw))));
  parts.push(chunk('IEND', Buffer.alloc(0)));
  return new Uint8Array(Buffer.concat(parts));
}

/** The gray channel of every pixel, in row-major order. */
const grays = (img) => {
  const out = [];
  for (let i = 0; i < img.width * img.height; i++) out.push(img.pixels[i * 4]);
  return out;
};
const rgba = (img, i) => [...img.pixels.subarray(i * 4, i * 4 + 4)];

test('png-read: 1-bit gray unpacks MSB-first and scales 0/1 to 0/255', () => {
  const img = decodePNG(png({ width: 8, height: 1, depth: 1, colorType: 0, rows: [[0b10101100]] }));
  assert.equal(img.width, 8);
  assert.equal(img.height, 1);
  assert.deepEqual(grays(img), [255, 0, 255, 0, 255, 255, 0, 0]);
  assert.deepEqual(rgba(img, 0), [255, 255, 255, 255], 'a black-and-white scan must come back as opaque RGB');
});

test('png-read: 2-bit and 4-bit gray scale to the full range', () => {
  const two = decodePNG(png({ width: 4, height: 1, depth: 2, colorType: 0, rows: [[0b00011011]] }));
  assert.deepEqual(grays(two), [0, 85, 170, 255]);
  const four = decodePNG(png({ width: 4, height: 1, depth: 4, colorType: 0, rows: [[0x0f, 0x8a]] }));
  assert.deepEqual(grays(four), [0, 255, 136, 170]);
});

test('png-read: a palette PNG expands through PLTE and tRNS', () => {
  const img = decodePNG(
    png({
      width: 4,
      height: 1,
      depth: 2,
      colorType: 3,
      rows: [[0b00011011]],
      plte: [255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0],
      trns: [255, 128],
    }),
  );
  assert.deepEqual(rgba(img, 0), [255, 0, 0, 255]);
  assert.deepEqual(rgba(img, 1), [0, 255, 0, 128], 'tRNS gives the entry its alpha');
  assert.deepEqual(rgba(img, 2), [0, 0, 255, 255], 'entries past tRNS stay opaque');
  assert.deepEqual(rgba(img, 3), [255, 255, 0, 255]);
});

test('png-read: 16-bit gray and RGB keep the high byte', () => {
  const gray = decodePNG(
    png({ width: 3, height: 1, depth: 16, colorType: 0, rows: [[0x12, 0x34, 0xab, 0xcd, 0x00, 0xff]] }),
  );
  assert.deepEqual(grays(gray), [0x12, 0xab, 0x00]);
  const rgb = decodePNG(
    png({ width: 1, height: 1, depth: 16, colorType: 2, rows: [[0x12, 0x34, 0xab, 0xcd, 0xef, 0x01]] }),
  );
  assert.deepEqual(rgba(rgb, 0), [0x12, 0xab, 0xef, 255]);
});

test('png-read: gray+alpha keeps its alpha channel', () => {
  const img = decodePNG(png({ width: 2, height: 1, depth: 8, colorType: 4, rows: [[10, 20, 30, 40]] }));
  assert.deepEqual(rgba(img, 0), [10, 10, 10, 20]);
  assert.deepEqual(rgba(img, 1), [30, 30, 30, 40]);
});

test('png-read: sub-byte rows still run the filters with a one-byte pixel offset', () => {
  // depth 4, width 4 -> row bytes [0x0f, 0x8a]; filter 1 (Sub) with bpp = 1 byte:
  // raw[0] = want[0], raw[i] = want[i] - want[i-1]. Getting bpp wrong (2 instead of 1)
  // would smear the nibbles into a different picture.
  const sub = decodePNG(png({ width: 4, height: 1, depth: 4, colorType: 0, rows: [[0x0f, 0x8a - 0x0f]], filters: [1] }));
  assert.deepEqual(grays(sub), [0, 255, 136, 170]);
  // depth 16, 1 px wide: bpp is 2 bytes, so filter 2 (Up) subtracts the row above byte-wise.
  const up = decodePNG(
    png({
      width: 1,
      height: 2,
      depth: 16,
      colorType: 0,
      rows: [[0x12, 0x34], [0x34 - 0x12, 0x56 - 0x34]],
      filters: [2, 2],
    }),
  );
  assert.deepEqual(grays(up), [0x12, 0x34]);
});

test('png-read: malformed headers are refused by name, never guessed at', () => {
  const base = { width: 2, height: 1, depth: 1, colorType: 0, rows: [[0b10000000]] };
  assert.throws(() => decodePNG(png({ ...base, interlace: 1 })), /interlaced/);
  assert.throws(() => decodePNG(png({ ...base, depth: 16, colorType: 3, rows: [[1, 2, 3, 4]] })), /not valid for colour type 3/);
  assert.throws(() => decodePNG(png({ ...base, depth: 4, colorType: 2, rows: [[1, 2, 3]] })), /not valid for colour type 2/);
  assert.throws(() => decodePNG(png({ ...base, colorType: 3, rows: [[0b10000000]] })), /without a valid PLTE/);
  assert.throws(
    () => decodePNG(png({ width: 2, height: 1, depth: 1, colorType: 3, rows: [[0b11000000]], plte: [1, 2, 3] })),
    /palette index 1 is out of range/,
  );
  assert.throws(
    () => decodePNG(png({ width: 8, height: 1, depth: 1, colorType: 0, rows: [[0]], filters: [9] })),
    /bad filter type 9/,
  );
});

test('png-read: our own writer still round-trips (8-bit RGB and RGBA)', async () => {
  const { encodePNG } = await import('../../core/render/png.js');
  const pixels = new Uint8Array(4 * 2 * 4);
  for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 37) & 255;
  for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255; // the writer drops alpha: truecolour RGB
  const file = encodePNG({ width: 4, height: 2, pixels, dpi: 300 });
  const back = decodePNG(file);
  assert.equal(back.width, 4);
  assert.equal(back.height, 2);
  assert.deepEqual([...back.pixels], [...pixels], 'the reader must keep reading what the writer writes');
  assert.equal(back.dpi, 300);
});
