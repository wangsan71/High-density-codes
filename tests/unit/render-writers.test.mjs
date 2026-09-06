/**
 * PSKT unit tests -- core/render/png.js and core/render/tiff.js.
 *
 * Strategy: the encoders must not be trusted to grade their own homework. Every
 * claim is checked with something independent of the encoder code path:
 *   - node:zlib inflates our IDAT stream back to raw scanlines (proves the zlib
 *     header, our DEFLATE, the adler32 and the per-row filter bytes together);
 *   - a 30-line TIFF reader written below (proves the IFD layout, tag order and
 *     the strip geometry);
 *   - ref/verify_raster.py + pillow as a third-party check, driven manually
 *     (see the last test: it is skipped unless the sandbox lets it run).
 * Rasters come from tools/dump-sample-raster.mjs#sampleRaster -- deterministic
 * patterns, no dependency on any renderer.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { crc32 } from '../../core/crc.js';
import { inflateRaw } from '../../core/deflate.js';
import { encodePNG } from '../../core/render/png.js';
import { encodeTIFF } from '../../core/render/tiff.js';
import {
  dumpSampleRaster,
  expectedRGB,
  mmToPx,
  sampleRaster,
  SIDECAR_MAGIC,
  SIDECAR_HEADER_SIZE,
} from '../../tools/dump-sample-raster.mjs';

/* ------------------------------------------------------------------ */
/* shared helpers                                                      */
/* ------------------------------------------------------------------ */

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');

function eqBytes(a, b, msg) {
  assert.equal(a.length, b.length, `${msg}: length ${a.length} != ${b.length}`);
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      assert.fail(`${msg}: byte ${i} is ${a[i]}, expected ${b[i]}`);
    }
  }
}

function hex(b, n = b.length) {
  let s = '';
  for (let i = 0; i < n; i++) s += b[i].toString(16).padStart(2, '0');
  return s;
}

/** adler32, written here from RFC 1950 so it is independent of core/render/png.js. */
function adler32Ref(bytes) {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** Concatenate a run of chunks into one byte stream. */
function concat(chunks) {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.len, 0));
  let o = 0;
  for (const c of chunks) {
    out.set(c.data, o);
    o += c.len;
  }
  return out;
}

/** Strip the filter-type bytes off an all-filter-0 scanline stream -> RGB. */
function unfilterRGB(inflated, width, height) {
  const stride = width * 3;
  const rgb = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    assert.equal(inflated[y * (stride + 1)], 0, `row ${y} filter byte`);
    rgb.set(inflated.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride), y * stride);
  }
  return rgb;
}

/** RGBA raster -> the exact filtered scanline stream PNG must carry. */
function filteredRGBRef(img) {
  const { width, height, pixels } = img;
  const stride = width * 3;
  const raw = new Uint8Array(height * (stride + 1));
  let s = 0;
  for (let y = 0; y < height; y++) {
    const o = y * (stride + 1);
    raw[o] = 0;
    let d = o + 1;
    for (let x = 0; x < width; x++) {
      raw[d++] = pixels[s];
      raw[d++] = pixels[s + 1];
      raw[d++] = pixels[s + 2];
      s += 4;
    }
  }
  return raw;
}

/* ------------------------------------------------------------------ */
/* PNG chunk walker (structure only; decompression is done by node:zlib) */
/* ------------------------------------------------------------------ */

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function walkPNG(file) {
  assert.deepEqual(
    Array.from(file.subarray(0, 8)),
    PNG_SIGNATURE,
    'PNG signature (89 50 4E 47 0D 0A 1A 0A)',
  );
  const dv = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const chunks = [];
  let p = 8;
  while (p < file.length) {
    const len = dv.getUint32(p, false);
    const type = String.fromCharCode(file[p + 4], file[p + 5], file[p + 6], file[p + 7]);
    const data = file.subarray(p + 8, p + 8 + len);
    const crc = dv.getUint32(p + 8 + len, false);
    // Independent CRC: node's own crc32 (zlib) over type + data.
    const span = file.subarray(p + 4, p + 8 + len);
    const want = typeof zlib.crc32 === 'function' ? zlib.crc32(span) : crc32(span);
    assert.equal(crc >>> 0, want >>> 0, `${type} chunk CRC is wrong`);
    assert.ok(p + 12 + len <= file.length, `${type} chunk overruns the file`);
    chunks.push({ type, len, data });
    p += 12 + len;
  }
  assert.equal(p, file.length, 'chunks do not tile the file exactly');
  return chunks;
}

function parseIHDR(data) {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    width: dv.getUint32(0, false),
    height: dv.getUint32(4, false),
    bitDepth: data[8],
    colorType: data[9],
    compression: data[10],
    filter: data[11],
    interlace: data[12],
  };
}

/* ------------------------------------------------------------------ */
/* the PNG self-proof: node:zlib decodes what our encoder wrote        */
/* ------------------------------------------------------------------ */

function verifyPNGAgainst(img, label) {
  const file = encodePNG(img);
  const chunks = walkPNG(file);

  // --- structure: IHDR, pHYs, one or more IDAT, IEND, nothing else ---
  assert.equal(chunks[0].type, 'IHDR', 'first chunk must be IHDR');
  assert.equal(chunks[0].len, 13, 'IHDR is always 13 bytes');
  assert.equal(chunks[1].type, 'pHYs', 'pHYs must come before the first IDAT');
  assert.equal(chunks[1].len, 9, 'pHYs is always 9 bytes');
  assert.equal(chunks[chunks.length - 1].type, 'IEND', 'last chunk must be IEND');
  assert.equal(chunks[chunks.length - 1].len, 0, 'IEND carries no data');
  const idats = chunks.slice(2, -1);
  assert.ok(idats.length >= 1, 'there must be at least one IDAT');
  for (const c of idats) assert.equal(c.type, 'IDAT', `chunk between pHYs and IEND is ${c.type}`);

  // --- IHDR fields, straight out of docs/RENDER-CONTRACT.md ---
  const ihdr = parseIHDR(chunks[0].data);
  assert.deepEqual(
    ihdr,
    {
      width: img.width,
      height: img.height,
      bitDepth: 8,
      colorType: 2, // truecolor RGB: no alpha, no palette
      compression: 0,
      filter: 0,
      interlace: 0,
    },
    `IHDR fields (${label})`,
  );

  // --- pHYs: round(dpi * 39.3701) pixels per metre, unit = 1 ---
  const pdv = new DataView(chunks[1].data.buffer, chunks[1].data.byteOffset, chunks[1].data.byteLength);
  const ppm = Math.round(img.dpi * 39.3701);
  assert.equal(pdv.getUint32(0, false), ppm, `pHYs X (${label})`);
  assert.equal(pdv.getUint32(4, false), ppm, `pHYs Y (${label})`);
  assert.equal(chunks[1].data[8], 1, 'pHYs unit must be 1 = metre');

  // --- the strong one: hand the concatenated IDAT to node:zlib ---
  for (const c of idats) assert.ok(c.len <= 65536, 'IDAT chunks must stay <= 64 KiB');
  const stream = concat(idats);
  const zlibLen = stream.length;
  assert.equal(stream[0], 0x78, 'zlib CMF: deflate, 32 KiB window');
  assert.equal(stream[1], 0x01, 'zlib FLG: no preset dictionary, legal FCHECK');
  assert.equal((stream[0] * 256 + stream[1]) % 31, 0, 'CMF/FLG must be a multiple of 31');
  const adler =
    ((stream[zlibLen - 4] << 24) |
      (stream[zlibLen - 3] << 16) |
      (stream[zlibLen - 2] << 8) |
      stream[zlibLen - 1]) >>>
    0;

  const expected = filteredRGBRef(img);
  // inflateSync verifies ADLER32 itself and throws on a mismatch, so a bad
  // adler can never slip through this line.
  const got = new Uint8Array(zlib.inflateSync(stream));
  eqBytes(got, expected, `inflated IDAT != filtered scanlines (${label})`);
  assert.equal(got.length, img.height * (1 + img.width * 3), `unfiltered size (${label})`);
  assert.equal(adler, adler32Ref(expected), `adler32 trailer (${label})`);

  // every row must start with filter type 0 (None), and the RGB triplets must
  // be the input with alpha dropped -- decoded "by hand", byte for byte.
  eqBytes(unfilterRGB(got, img.width, img.height), expectedRGB(img), `pixels after unfilter (${label})`);

  // our own inflater must also read the stream: core/deflate must stay the
  // single source of truth for the send pipeline *and* for PNG.
  const bare = inflateRaw(stream.subarray(2, zlibLen - 4), expected.length);
  eqBytes(bare, expected, `core/deflate inflateRaw(IDAT) (${label})`);

  return file;
}

/* ------------------------------------------------------------------ */
/* a 30-line baseline TIFF reader, written only for this test          */
/* ------------------------------------------------------------------ */

const TIFF_TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

function parseTIFF(file) {
  const dv = new DataView(file.buffer, file.byteOffset, file.byteLength);
  assert.equal(String.fromCharCode(file[0], file[1]), 'II', 'byte order mark must be II (LE)');
  assert.equal(dv.getUint16(2, true), 42, 'TIFF magic 42');
  const ifdAt = dv.getUint32(4, true);
  assert.ok(ifdAt >= 8, 'first IFD offset must be >= 8');

  const n = dv.getUint16(ifdAt, true);
  const tags = new Map();
  const order = [];
  for (let i = 0; i < n; i++) {
    const e = ifdAt + 2 + i * 12;
    assert.ok(e + 12 <= file.length, 'IFD entry overruns the file');
    const tag = dv.getUint16(e, true);
    const type = dv.getUint16(e + 2, true);
    const count = dv.getUint32(e + 4, true);
    const size = count * TIFF_TYPE_SIZE[type];
    assert.ok(type in TIFF_TYPE_SIZE, `tag ${tag}: unknown field type ${type}`);
    const at = size <= 4 ? e + 8 : dv.getUint32(e + 8, true);
    if (size > 4) assert.ok(at + size <= file.length, `tag ${tag}: value offset out of file`);
    const values = [];
    for (let j = 0; j < count; j++) {
      if (type === 5) values.push([dv.getUint32(at + j * 8, true), dv.getUint32(at + j * 8 + 4, true)]);
      else if (type === 3) values.push(dv.getUint16(at + j * 2, true));
      else values.push(dv.getUint32(at + j * 4, true));
    }
    tags.set(tag, { type, count, values, value: values[0], at });
    order.push(tag);
  }

  // TIFF 6.0 sec. 1: IFD entries MUST be sorted by ascending tag number.
  const sorted = order.slice().sort((a, b) => a - b);
  assert.deepEqual(order, sorted, 'IFD tags must be in ascending tag order');
  assert.equal(new Set(order).size, order.length, 'duplicate tag in IFD');
  const nextIFD = dv.getUint32(ifdAt + 2 + n * 12, true);
  return { dv, ifdAt, n, tags, order, nextIFD };
}

function verifyTIFFAgainst(img, label) {
  const file = encodeTIFF(img);
  const { tags, nextIFD } = parseTIFF(file);
  assert.equal(nextIFD, 0, 'exactly one IFD');

  const rgb = expectedRGB(img);
  const want = {
    256: [4, [img.width]], //                              ImageWidth
    257: [4, [img.height]], //                             ImageHeight
    258: [3, [8, 8, 8]], //                                BitsPerSample
    259: [3, [1]], //                                      Compression = 1 (none)
    262: [3, [2]], //                                      PhotometricInterpretation = 2 (RGB)
    277: [3, [3]], //                                      SamplesPerPixel
    278: [4, [img.height]], //                             RowsPerStrip -> one strip
    279: [4, [rgb.length]], //                             StripByteCounts
    282: [5, [[Math.round(img.dpi), 1]]], //               XResolution
    283: [5, [[Math.round(img.dpi), 1]]], //               YResolution
    296: [3, [2]], //                                      ResolutionUnit = 2 (inch)
  };
  for (const [tag, [type, values]] of Object.entries(want)) {
    const got = tags.get(Number(tag));
    assert.ok(got, `tag ${tag} missing (${label})`);
    assert.equal(got.type, type, `tag ${tag} field type (${label})`);
    assert.deepEqual(got.values, values, `tag ${tag} value (${label})`);
  }
  assert.equal(tags.get(258).at % 2, 0, 'out-of-line values must sit at even offsets');

  // single, self-consistent strip covering the whole image, data after the IFD
  assert.equal(tags.get(273).values.length, 1, 'only one StripOffsets value -> one strip');
  assert.equal(tags.get(279).values.length, 1, 'only one StripByteCounts value -> one strip');
  const off = tags.get(273).value;
  const len = tags.get(279).value;
  assert.equal(len, img.width * img.height * 3, `strip length (${label})`);
  assert.equal(tags.get(278).value, img.height, 'RowsPerStrip must cover the whole image');
  assert.ok(off > 8 + 2 + 12 * tags.size, 'strip data must live after the IFD');
  assert.ok(off + len <= file.length, 'strip must fit inside the file');
  eqBytes(file.subarray(off, off + len), rgb, `strip pixels vs RGBA-minus-alpha (${label})`);

  // no padding slack: the strip is the tail of the file
  assert.equal(off + len, file.length, `strip is not the tail of the file (${label})`);
  return file;
}

/* ------------------------------------------------------------------ */
/* crc32 self-check that PNG framing depends on                        */
/* ------------------------------------------------------------------ */

test('png/tiff preflight: crc32 has the official PNG/checksum vector', () => {
  assert.equal(crc32('123456789'), 0xcbf43926, 'crc32("123456789") must be 0xCBF43926');
  // seed argument semantics used by PNG framing: previous *final* CRC in
  assert.equal(crc32('56789', crc32('1234')), crc32('123456789'), 'crc32 chaining');
});

/* ------------------------------------------------------------------ */
/* PNG                                                                 */
/* ------------------------------------------------------------------ */

test('PNG: structural + zlib-level proof over 6 deterministic patterns', () => {
  const cases = [
    ['1x1 solid', sampleRaster(1, 1, 600, 'solid')],
    ['odd 7x5 stripes-v', sampleRaster(7, 5, 300, 'stripes-v')],
    ['checker 16x16', sampleRaster(16, 16, 300, 'checker')],
    ['stripes-h 40x24', sampleRaster(40, 24, 600, 'stripes-h')],
    ['channel ramp 64x32', sampleRaster(64, 32, 600, 'channels')],
    ['noise 120x90', sampleRaster(120, 90, 600, 'noise')],
  ];
  for (const [label, img] of cases) verifyPNGAgainst(img, label);
});

test('PNG: byte-deterministic (same input twice -> identical bytes)', () => {
  for (const [w, h, kind] of [[9, 7, 'checker'], [64, 48, 'channels'], [200, 120, 'noise']]) {
    const a = encodePNG(sampleRaster(w, h, 300, kind));
    const b = encodePNG(sampleRaster(w, h, 300, kind));
    eqBytes(a, b, `${w}x${h} ${kind}: two calls differ`);
    // and re-encoding the very same object must be stable too
    const img = sampleRaster(w, h, 300, kind);
    eqBytes(encodePNG(img), a, `${w}x${h} ${kind}: re-encode differs`);
    assert.ok(a.length > 8 + 12 + 13 + 12 + 9 + 12, 'output must be a real file, not a stub');
  }
});

test('PNG: alpha is dropped and never leaks into the output', () => {
  const opaque = sampleRaster(24, 12, 300, 'checker');
  const translucent = { ...opaque, pixels: opaque.pixels.slice() };
  for (let i = 3; i < translucent.pixels.length; i += 4) translucent.pixels[i] = (i * 7) & 255;
  eqBytes(
    encodePNG(opaque),
    encodePNG(translucent),
    'same RGB with different alpha must encode to identical bytes',
  );
  verifyPNGAgainst(translucent, 'translucent');
});

test('PNG: input validation rejects anything off contract', () => {
  const ok = sampleRaster(4, 3, 300, 'solid');
  assert.throws(() => encodePNG({ ...ok, pixels: ok.pixels.subarray(0, 40) }), /width\*height\*4/);
  assert.throws(() => encodePNG({ ...ok, pixels: new Uint8Array(12) }), /width\*height\*4/);
  assert.throws(() => encodePNG({ ...ok, width: 0 }), /bad width/);
  assert.throws(() => encodePNG({ ...ok, height: 2.5 }), /bad height/);
  assert.throws(() => encodePNG({ ...ok, pixels: Array.from(ok.pixels) }), /Uint8Array/);
  assert.throws(() => encodePNG({ ...ok, dpi: 0 }), /bad dpi/);
  assert.throws(() => encodePNG({ ...ok, dpi: NaN }), /bad dpi/);
  assert.throws(() => encodePNG(null), /raster object/);
});

test('PNG: 300 and 600 dpi only change pHYs, never the pixels', () => {
  const img300 = sampleRaster(32, 32, 300, 'checker');
  const img600 = { ...img300, dpi: 600 };
  const a = walkPNG(encodePNG(img300));
  const b = walkPNG(encodePNG(img600));
  assert.deepEqual(
    Array.from(a[2].data).concat(Array.from(a[a.length - 1].data)),
    Array.from(b[2].data).concat(Array.from(b[b.length - 1].data)),
    'IDAT payload must not depend on dpi',
  );
  assert.notDeepEqual(Array.from(a[1].data), Array.from(b[1].data), 'pHYs must differ');
  const dv = (c) => new DataView(c.buffer, c.byteOffset, c.byteLength);
  assert.equal(dv(a[1].data).getUint32(0, false), Math.round(300 * 39.3701));
  assert.equal(dv(b[1].data).getUint32(0, false), Math.round(600 * 39.3701));
});

/* ------------------------------------------------------------------ */
/* TIFF                                                               */
/* ------------------------------------------------------------------ */

test('TIFF: header, IFD and strip proof over 5 deterministic patterns', () => {
  const cases = [
    ['1x1 solid', sampleRaster(1, 1, 600, 'solid')],
    ['odd 7x5 stripes-h', sampleRaster(7, 5, 300, 'stripes-h')],
    ['checker 16x16', sampleRaster(16, 16, 300, 'checker')],
    ['channel ramp 64x32', sampleRaster(64, 32, 600, 'channels')],
    ['noise 120x90', sampleRaster(120, 90, 600, 'noise')],
  ];
  for (const [label, img] of cases) verifyTIFFAgainst(img, label);
});

test('TIFF: byte-deterministic and alpha-blind', () => {
  const a = encodeTIFF(sampleRaster(37, 23, 300, 'checker'));
  const b = encodeTIFF(sampleRaster(37, 23, 300, 'checker'));
  eqBytes(a, b, 'two encodes differ');

  const opaque = sampleRaster(37, 23, 300, 'channels');
  const translucent = { ...opaque, pixels: opaque.pixels.slice() };
  for (let i = 3; i < translucent.pixels.length; i += 4) translucent.pixels[i] = 0;
  eqBytes(encodeTIFF(opaque), encodeTIFF(translucent), 'alpha must not reach the strip');
});

test('TIFF: input validation rejects anything off contract', () => {
  const ok = sampleRaster(4, 3, 300, 'solid');
  assert.throws(() => encodeTIFF({ ...ok, pixels: new Uint8Array(47) }), /width\*height\*4/);
  assert.throws(() => encodeTIFF({ ...ok, width: -2 }), /bad width/);
  assert.throws(() => encodeTIFF({ ...ok, dpi: Infinity }), /bad dpi/);
});

test('TIFF: single-strip geometry stays self-consistent for a tall page', () => {
  // A tall, narrow raster is where a broken RowsPerStrip/StripByteCounts shows up.
  const img = sampleRaster(61, 497, 300, 'stripes-h');
  const file = verifyTIFFAgainst(img, 'tall');
  const { tags } = parseTIFF(file);
  assert.equal(tags.get(278).value * tags.get(256).value * 3, tags.get(279).value);
});

/* ------------------------------------------------------------------ */
/* size / time / repeat-stability on a real page at 600 dpi            */
/* ------------------------------------------------------------------ */

const PAGE_W = mmToPx(210, 600); // A4 short edge at 600 dpi = 4961 px
const PAGE_H = mmToPx(297, 600); // A4 long edge at 600 dpi = 7016 px
const pageRaster = () => sampleRaster(PAGE_W, PAGE_H, 600, 'checker');

test(`PNG+TIFF: ${PAGE_W}x${PAGE_H} page (the 453x659-cell 600dpi grid) encodes in < 5 s`, () => {
  assert.equal(PAGE_W, 4961);
  assert.equal(PAGE_H, 7016);
  const img = pageRaster();
  assert.equal(img.pixels.length, PAGE_W * PAGE_H * 4);

  const t0 = performance.now();
  const png = encodePNG(img);
  const tPng = performance.now() - t0;

  const t1 = performance.now();
  const tiff = encodeTIFF(img);
  const tTiff = performance.now() - t1;

  console.log(
    `  page encode: png ${tPng.toFixed(0)} ms (${(png.length / 1048576).toFixed(2)} MiB) |` +
      ` tiff ${tTiff.toFixed(0)} ms (${(tiff.length / 1048576).toFixed(1)} MiB)`,
  );
  assert.ok(tPng < 5000, `PNG page encode took ${tPng.toFixed(0)} ms (budget 5000 ms)`);
  assert.ok(tTiff < 5000, `TIFF page encode took ${tTiff.toFixed(0)} ms (budget 5000 ms)`);

  // structural proof on the big one, but with the cheap comparisons only
  const chunks = walkPNG(png);
  const pageIdats = chunks.slice(2, -1);
  assert.ok(pageIdats.length >= 2, 'a page this size needs more than one IDAT');
  for (const c of pageIdats.slice(0, -1)) {
    assert.equal(c.len, 65536, 'all IDATs but the last are exactly 64 KiB');
  }
  assert.ok(pageIdats.at(-1).len <= 65536, 'the last IDAT may be short');
  const inflated = new Uint8Array(zlib.inflateSync(concat(chunks.slice(2, -1))));
  assert.equal(inflated.length, PAGE_H * (1 + PAGE_W * 3), 'page: inflated length');
  eqBytes(unfilterRGB(inflated, PAGE_W, PAGE_H), expectedRGB(img), 'page: pixels vs RGBA-minus-alpha');
  verifyTIFFAgainst(img, 'page');
  assert.equal(
    tiff.length,
    8 + 2 + 12 * 12 + 4 + 6 + 8 + 8 + PAGE_W * PAGE_H * 3,
    'TIFF total size = header + IFD + out-of-line values + one RGB strip',
  );

  // page scale also has to be repeatable: three more full-page encodes must
  // land on exactly the same bytes (no allocator state leaking into output).
  for (let i = 0; i < 3; i++) {
    eqBytes(encodePNG(img), png, `page round ${i}: PNG drifted`);
    eqBytes(encodeTIFF(img), tiff, `page round ${i}: TIFF drifted`);
  }
});

test('PNG+TIFF: 50 consecutive encodes stay byte-identical (no hidden state/leak)', () => {
  const img = sampleRaster(1200, 900, 600, 'channels'); // ~4.3 MB of RGBA
  const basePng = encodePNG(img);
  const baseTiff = encodeTIFF(img);
  const heap0 = process.memoryUsage().heapUsed;
  let pngCrc = 0;
  for (let i = 0; i < 50; i++) {
    eqBytes(encodePNG(img), basePng, `round ${i}: PNG drifted`);
    eqBytes(encodeTIFF(img), baseTiff, `round ${i}: TIFF drifted`);
    pngCrc = crc32(basePng, pngCrc); // touch every byte, defeat lazy work
  }
  const heap1 = process.memoryUsage().heapUsed;
  const grew = (heap1 - heap0) / 1048576;
  console.log(`  50x1.1 MP: png crc chain ${pngCrc >>> 0}, heap delta ${grew.toFixed(1)} MiB`);
  assert.ok(grew < 600, `heap grew ${grew.toFixed(0)} MiB over 50 rounds -- leak?`);
});

/* ------------------------------------------------------------------ */
/* pillow cross-check (manual acceptance; skipped inside the sandbox)  */
/* ------------------------------------------------------------------ */

test('PNG+TIFF: pillow (ref/verify_raster.py) agrees on every dumped sample', (t) => {
  // PSKIT_PY_VERIFY set == a human is already running the python check, so the
  // suite does not duplicate it.
  if (process.env.PSKIT_PY_VERIFY) {
    t.skip('PSKIT_PY_VERIFY is set: the python check is being run by hand');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pskit-raster-'));
  try {
    const rows = dumpSampleRaster(dir, { includePage: false });
    const files = rows.flatMap((r) => [r.png, r.tif]);
    const run = spawnSync(
      process.env.PYTHON || 'python',
      [path.join(REPO_ROOT, 'ref', 'verify_raster.py'), ...files],
      { cwd: REPO_ROOT, stdio: 'inherit' }, // piped stdio is what the sandbox blocks
    );
    if (run.error || run.status === null) {
      t.skip(`cannot spawn python here (${run.error ? run.error.code || run.error.message : 'killed'})`);
      return;
    }
    assert.equal(run.status, 0, `verify_raster.py exited ${run.status}`);
    for (const f of files) assert.ok(fs.existsSync(f), `${f} should have been written`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sidecar: dump-sample-raster writes a self-describing .raw', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pskit-sidecar-'));
  try {
    const rows = dumpSampleRaster(dir, { includePage: false });
    assert.ok(rows.length >= 5, 'the small sample set must have several entries');
    for (const r of rows) {
      const blob = new Uint8Array(fs.readFileSync(r.raw));
      const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
      assert.equal(String.fromCharCode(...blob.subarray(0, 8)), SIDECAR_MAGIC, `${r.name}: magic`);
      assert.equal(dv.getUint32(8, true), r.width, `${r.name}: width`);
      assert.equal(dv.getUint32(12, true), r.height, `${r.name}: height`);
      assert.equal(dv.getUint32(16, true), Math.round(r.dpi), `${r.name}: dpi`);
      assert.equal(blob.length, SIDECAR_HEADER_SIZE + r.width * r.height * 3, `${r.name}: length`);
      // the sidecar must agree with the file: decode the PNG and compare
      const png = new Uint8Array(fs.readFileSync(r.png));
      const chunks = walkPNG(png).slice(2, -1);
      eqBytes(
        unfilterRGB(new Uint8Array(zlib.inflateSync(concat(chunks))), r.width, r.height),
        blob.subarray(SIDECAR_HEADER_SIZE),
        `${r.name}: sidecar vs PNG scanlines`,
      );
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
