/**
 * PSKT core -- PNG (ISO/IEC 15948, "PNG Third Edition") raster encoder.
 *
 * Pure function, synchronous, byte-deterministic, zero dependency, no `node:`
 * builtins: the exact same module runs in Node and in a browser under `file://`.
 * See docs/RENDER-CONTRACT.md for the pixel buffer the input must follow.
 *
 *   encodePNG({ width, height, pixels, dpi }) -> Uint8Array
 *
 * `pixels` is RGBA (width*height*4, row-major, first row is the TOP row);
 * the alpha channel is dropped and the file carries 8-bit truecolor RGB
 * (color type 2), which is what the print pipeline wants -- a scanned page has
 * no use for transparency.
 *
 * Layout written, in order:
 *   89 50 4E 47 0D 0A 1A 0A   signature
 *   IHDR   width height 8 2 0 0 0        (bit depth 8, color type 2 = RGB,
 *                                         compression 0, filter 0, no interlace)
 *   pHYs   ppm ppm 1                     (Math.round(dpi * 39.3701), unit metre)
 *   IDAT+  one zlib stream, split into chunks of at most 64 KiB
 *   IEND
 *
 * The zlib stream is `78 01` + core/deflate.js deflateRaw(...) + adler32 BE,
 * where adler32 is deliberately local to this file (core/crc.js stays about
 * CRCs). Every chunk CRC is plain CRC-32 over chunk type + data, i.e.
 * core/crc.js `crc32(bytes)` with its default seed of 0.
 */

import { crc32 } from '../crc.js';
import { deflateRaw } from '../deflate.js';

const SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const EMPTY = new Uint8Array(0);

/** zlib CMF/FLG for "deflate, 32 KiB window, no preset dictionary". */
const ZLIB_CMF = 0x78;
const ZLIB_FLG = 0x01; // (0x78 * 256 + 0x01) % 31 === 0, so FCHECK is legal

/** PNG allows any number of consecutive IDAT chunks; we cap each at 64 KiB. */
const MAX_IDAT_CHUNK = 65536;

/** Inches -> metres: the unit pHYs records (1 inch = 0.0254 m => 39.3701 /m). */
const DPI_TO_PPM = 39.3701;

/* ------------------------------------------------------------------ */
/* adler32 (RFC 1950 sec. 3.2) -- deliberately NOT in core/crc.js      */
/* ------------------------------------------------------------------ */

const ADLER_MOD = 65521;
/** Longest run keeping `b` under 2**31 before the modulo (RFC 1950 note). */
const ADLER_NMAX = 5552;

function adler32(bytes) {
  let a = 1;
  let b = 0;
  let i = 0;
  const n = bytes.length;
  while (i < n) {
    const end = n - i > ADLER_NMAX ? i + ADLER_NMAX : n;
    for (; i < end; i++) {
      a += bytes[i];
      b += a;
    }
    a %= ADLER_MOD;
    b %= ADLER_MOD;
  }
  return ((b << 16) | a) >>> 0;
}

/* ------------------------------------------------------------------ */
/* input validation                                                    */
/* ------------------------------------------------------------------ */

function checkRaster(img, who) {
  if (img === null || typeof img !== 'object') {
    throw new TypeError(`${who}: expected a raster object { width, height, pixels, dpi }`);
  }
  const { width, height, pixels, dpi } = img;
  if (!Number.isInteger(width) || width <= 0) throw new RangeError(`${who}: bad width ${width}`);
  if (!Number.isInteger(height) || height <= 0) throw new RangeError(`${who}: bad height ${height}`);
  if (!(pixels instanceof Uint8Array)) {
    throw new TypeError(`${who}: pixels must be a Uint8Array (RGBA, 4 bytes per pixel)`);
  }
  const need = width * height * 4;
  if (pixels.length !== need) {
    throw new RangeError(`${who}: pixels.length is ${pixels.length}, expected width*height*4 = ${need}`);
  }
  if (typeof dpi !== 'number' || !Number.isFinite(dpi) || dpi <= 0) {
    throw new RangeError(`${who}: bad dpi ${dpi}`);
  }
  return { width, height, pixels, dpi };
}

/* ------------------------------------------------------------------ */
/* big-endian writer over a pre-sized buffer (PNG is BE throughout)    */
/* ------------------------------------------------------------------ */

class Writer {
  constructor(buf) {
    this.a = buf;
    this.n = 0;
  }

  u8(v) {
    this.a[this.n++] = v & 255;
  }

  u32(v) {
    this.a[this.n++] = (v >>> 24) & 255;
    this.a[this.n++] = (v >>> 16) & 255;
    this.a[this.n++] = (v >>> 8) & 255;
    this.a[this.n++] = v & 255;
  }

  bytes(src, off, len) {
    this.a.set(src.subarray(off, off + len), this.n);
    this.n += len;
  }

  ascii(s) {
    for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i));
  }
}

/**
 * Chunk framing: length (data only) | type | data | CRC(type + data).
 * `crc32(bytes, seed)` takes the *previous final CRC* as its second argument,
 * so the default seed 0 already means "start over" -- CRC-32's own init value
 * 0xFFFFFFFF is applied inside crc32(), which is exactly what PNG requires
 * (check vector: crc32("123456789") === 0xcbf43926).
 */
function writeChunk(w, type, data, off, len) {
  w.u32(len);
  const head = w.n;
  w.ascii(type);
  w.bytes(data, off, len);
  w.u32(crc32(w.a.subarray(head, w.n))); // spans chunk type + chunk data
}

/**
 * RGBA (row-major, top row first) -> filtered RGB scanlines with a filter-type
 * byte 0 (None) in front of each row: the byte stream DEFLATE must cover.
 */
function filteredScanlines(width, height, pixels) {
  const stride = width * 3;
  const raw = new Uint8Array(height * (stride + 1));
  let s = 0;
  for (let y = 0; y < height; y++) {
    const o = y * (stride + 1);
    raw[o] = 0; // filter type: None
    let d = o + 1;
    for (let x = 0; x < width; x++) {
      raw[d++] = pixels[s];
      raw[d++] = pixels[s + 1];
      raw[d++] = pixels[s + 2];
      s += 4; // alpha dropped: color type 2 carries no transparency
    }
  }
  return raw;
}

/**
 * Encode an RGBA raster as an 8-bit truecolor (RGB) PNG.
 * @param {{width:number,height:number,pixels:Uint8Array,dpi:number}} img
 * @returns {Uint8Array} the complete file
 */
export function encodePNG(img) {
  const { width, height, pixels, dpi } = checkRaster(img, 'encodePNG');

  const ppm = Math.round(dpi * DPI_TO_PPM);
  if (ppm < 1 || ppm > 0xffffffff) {
    throw new RangeError(`encodePNG: dpi ${dpi} does not fit pHYs (${ppm} px/m)`);
  }

  const ihdr = new Uint8Array(13);
  {
    const w = new Writer(ihdr);
    w.u32(width);
    w.u32(height);
    w.u8(8); // bit depth
    w.u8(2); // color type: 2 = truecolor RGB
    w.u8(0); // compression method: 0 = deflate
    w.u8(0); // filter method: 0
    w.u8(0); // interlace method: 0 = none
  }

  const phys = new Uint8Array(9);
  {
    const w = new Writer(phys);
    w.u32(ppm);
    w.u32(ppm);
    w.u8(1); // unit specifier: 1 = metre
  }

  const filtered = filteredScanlines(width, height, pixels);
  const body = deflateRaw(filtered); // view with an exact .length
  const zlibLen = 2 + body.length + 4;

  const zlib = new Uint8Array(zlibLen);
  {
    const z = new Writer(zlib);
    z.u8(ZLIB_CMF);
    z.u8(ZLIB_FLG);
    z.bytes(body, 0, body.length);
    z.u32(adler32(filtered)); // ADLER32 of the *uncompressed* scanlines, BE
  }

  const nIdat = Math.max(1, Math.ceil(zlibLen / MAX_IDAT_CHUNK));
  const total =
    SIGNATURE.length + (12 + ihdr.length) + (12 + phys.length) + nIdat * 12 + zlibLen + 12;

  const out = new Uint8Array(total);
  const w = new Writer(out);

  w.bytes(SIGNATURE, 0, SIGNATURE.length);
  writeChunk(w, 'IHDR', ihdr, 0, ihdr.length);
  writeChunk(w, 'pHYs', phys, 0, phys.length);
  for (let off = 0; off < zlibLen; off += MAX_IDAT_CHUNK) {
    writeChunk(w, 'IDAT', zlib, off, Math.min(MAX_IDAT_CHUNK, zlibLen - off));
  }
  writeChunk(w, 'IEND', EMPTY, 0, 0);

  if (w.n !== total) throw new Error(`encodePNG: internal size mismatch (${w.n} != ${total})`);
  return out;
}

// No default export: see core/render/pdf.js and tests/unit/export-conventions.test.mjs --
// the web bundler refuses default exports and every caller imports the name.
