/**
 * PSKT core -- PDF 1.4 writer for one or more rendered page bitmaps.
 *
 * Pure function, synchronous, byte-deterministic, zero dependency, no `node:`
 * builtins: the exact same module runs in Node and in a browser under `file://`.
 * See docs/RENDER-CONTRACT.md for the pixel buffer the input follows.
 *
 *   encodePDFDocument([{width,height,pixels,dpi,substrate?,pageMm?}, ...]) -> Uint8Array
 *   encodePDFPage(raster) -> Uint8Array            // one-page shorthand
 *
 * Why a PDF at all: the plate/paper geometry is fixed by the renderer, so the one
 * thing this file has to guarantee is that a print driver puts the bitmap on the
 * sheet at *true physical size* -- no "fit to page" surprises, no resampling
 * decision left to the viewer. Hence one XObject Image painted onto a MediaBox
 * whose size is derived from the pixel size and the dpi. And why *multiple*
 * pages: a 41-page paper pack is only printable as one file, because a human
 * cannot keep 41 separate documents in order.
 *
 * What it writes, in order:
 *
 *   1  Catalog          -> /Pages 2 0 R
 *   2  Pages            -> Kids [3 0 R, 6 0 R, ...], /Count N
 *   per page i (0-based):
 *     3+3i   Page       -> /MediaBox [0 0 w_pt h_pt], /Resources /XObject /Im0
 *     4+3i   Image      -> /DeviceRGB, /BitsPerComponent 8, /FlateDecode with
 *                          /DecodeParms /Predictor 15 /Colors 3 /Columns width*3
 *     5+3i   Contents   -> substrate background fill + `cm` scaling /Im0 onto the
 *                          whole MediaBox
 *   xref table (classic, one 20-byte entry per object) + trailer + startxref
 *
 * That numbering is not incidental: for N=1 it reproduces the object layout this
 * module has always emitted, so single-page fixtures stay byte-identical.
 *
 * The image data is *exactly* the PNG scanline stream: one filter-type byte 0
 * (None) in front of each RGB row, then `78 01` + core/deflate.js deflateRaw +
 * adler32 BE. Predictor 15 means "PNG row filters", so the same bytes are valid
 * in a PNG IDAT and in a PDF FlateDecode image -- that is the whole trick, and
 * why tests can inflate one stream and compare it against the other encoder.
 *
 * No DCTDecode, no JBIG2, no alpha, no colour management: a scanned page has no
 * use for transparency and a lossy codec would move ink edges, which is the
 * signal PSKT decodes. Nothing in this file depends on the wall clock or on
 * randomness: no /CreationDate, no /ModDate, and /ID is the first 16 bytes of
 * SHA-256 over the body preceding the xref table (a content digest, per the
 * contract), so two calls on one input return identical bytes.
 */

import { deflateRaw } from '../deflate.js';
import { sha256 } from '../hash.js';
import { toHex } from '../crc.js';
import { PT_PER_MM, round2 } from './units.js';

/** zlib CMF/FLG for "deflate, 32 KiB window, no preset dictionary". */
const ZLIB_CMF = 0x78;
const ZLIB_FLG = 0x01; // (0x78 * 256 + 0x01) % 31 === 0, so FCHECK is legal

/**
 * Local adler32 (RFC 1950 sec. 3.2) -- same deliberate choice core/render/png.js
 * made: core/crc.js stays about CRCs. Duplicated rather than exported from
 * png.js so neither render module depends on the other's surface.
 */
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

/** Optional [r,g,b] substrate; absent/null means "paint no background". */
function checkSubstrate(v) {
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v) && !(v instanceof Uint8Array)) {
    throw new TypeError('encodePDFPage: substrate must be [r,g,b] or absent');
  }
  if (v.length !== 3) throw new RangeError('encodePDFPage: substrate must have 3 components');
  for (const c of v) {
    if (!Number.isInteger(c) || c < 0 || c > 255) {
      throw new RangeError(`encodePDFPage: substrate component ${c} is not an 8-bit integer`);
    }
  }
  return v;
}

/** Optional explicit page size in mm (docs/RENDER-CONTRACT.md lists it). */
function checkPageMm(v) {
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v) && !(v instanceof Float64Array)) {
    throw new TypeError('encodePDFPage: pageMm must be [wMm, hMm] or absent');
  }
  if (v.length !== 2) throw new RangeError('encodePDFPage: pageMm must have 2 entries');
  for (const n of v) {
    if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) {
      throw new RangeError(`encodePDFPage: bad pageMm entry ${n}`);
    }
  }
  return { w: v[0], h: v[1] };
}

/* ------------------------------------------------------------------ */
/* byte helpers                                                        */
/* ------------------------------------------------------------------ */

const ENC = new TextEncoder();

function ascii(s) {
  return ENC.encode(s);
}

/** PDF real from a length in points: two decimals, plain notation, never 1e3. */
function numPt(v) {
  const s = String(round2(v));
  if (!/^\d+(\.\d{1,2})?$/.test(s)) throw new RangeError(`encodePDFPage: bad point value ${v} -> ${s}`);
  return s;
}

/** 8-bit channel -> PDF user-space component in [0,1], fixed 4 decimals. */
function numUnit(v) {
  const s = (Math.round((v / 255) * 10000) / 10000).toFixed(4);
  const n = Number(s);
  if (!(n >= 0 && n <= 1)) throw new RangeError(`encodePDFPage: ${v} does not fit [0,1]`);
  return s;
}

function cat(chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/**
 * RGBA (row-major, top row first) -> filtered RGB scanlines with a filter-type
 * byte 0 (None) in front of each row. Byte-identical to what a PNG IDAT carries,
 * which is what PDF predictor 15 expects.
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
      s += 4; // alpha dropped: DeviceRGB carries no transparency
    }
  }
  return raw;
}

/** The zlib container around a raw DEFLATE stream (RFC 1950). */
function zlibWrap(filtered) {
  const body = deflateRaw(filtered); // view with an exact .length
  const out = new Uint8Array(2 + body.length + 4);
  out[0] = ZLIB_CMF;
  out[1] = ZLIB_FLG;
  out.set(body, 2);
  const adler = adler32(filtered); // of the *uncompressed* bytes
  out[out.length - 4] = (adler >>> 24) & 255;
  out[out.length - 3] = (adler >>> 16) & 255;
  out[out.length - 2] = (adler >>> 8) & 255;
  out[out.length - 1] = adler & 255;
  return out;
}

/* ------------------------------------------------------------------ */
/* the writer                                                          */
/* ------------------------------------------------------------------ */

/**
 * Encode one or more RGBA rasters as a PDF whose pages each carry their own
 * MediaBox at true physical size. Object numbering is chosen so that a
 * one-page document produces exactly the layout `encodePDFPage` has always
 * produced (Catalog 1, Pages 2, then Page 3 / Image 4 / Contents 5), which keeps
 * existing byte-for-byte fixtures valid while allowing a 41-page print pack to
 * ship as a single file -- the thing that actually gets sent to a printer.
 *
 * @param {Array<object>|object} images one raster, or a list of them in page order
 * @returns {Uint8Array} the complete file, ending in `%%EOF`
 */
export function encodePDFDocument(images) {
  const list = Array.isArray(images) ? images : [images];
  if (!list.length) throw new RangeError('encodePDFDocument: no pages to write');
  const pages = list.map((img) => {
    const { width, height, pixels, dpi } = checkRaster(img, 'encodePDFDocument');
    return { width, height, pixels, dpi, substrate: checkSubstrate(img.substrate), pageMm: checkPageMm(img.pageMm) };
  });

  const header = cat([ascii(`%PDF-1.4\n`), new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])]);
  const objects = [
    ascii(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`),
    null, // /Pages, filled in once the kid numbers are known
  ];

  pages.forEach((p, i) => {
    const { width, height, pixels, dpi, substrate, pageMm } = p;
    const pageNo = 3 + i * 3;
    const imageNo = pageNo + 1;
    const contentNo = pageNo + 2;
    const wPt = pageMm ? numPt(pageMm.w * PT_PER_MM) : numPt((width / dpi) * 72);
    const hPt = pageMm ? numPt(pageMm.h * PT_PER_MM) : numPt((height / dpi) * 72);

    const imageData = zlibWrap(filteredScanlines(width, height, pixels));
    const pageObj = ascii(
      `${pageNo} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${wPt} ${hPt}]\n` +
        `   /Resources << /XObject << /Im0 ${imageNo} 0 R >> /ProcSet [/PDF /ImageC] >>\n` +
        `   /Contents ${contentNo} 0 R >>\nendobj\n`,
    );
    const imageObj = cat([
      ascii(
        `${imageNo} 0 obj\n` +
          `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height}\n` +
          // Interpolate false: a viewer that resamples the bitmap blurs the ink
          // edges, and edge position is exactly what the decoder measures.
          `   /ColorSpace /DeviceRGB /BitsPerComponent 8 /Interpolate false\n` +
          `   /Filter /FlateDecode\n` +
          `   /DecodeParms << /Predictor 15 /Colors 3 /BitsPerComponent 8 /Columns ${width * 3} >>\n` +
          `   /Length ${imageData.length} >>\nstream\n`,
      ),
      imageData,
      ascii(`\nendstream\nendobj\n`),
    ]);
    // The substrate fill is invisible while /Im0 covers the box; it is there so a
    // viewer that clips the image still shows material colour, not white.
    const content = ascii(
      `q\n` +
        (substrate ? `${numUnit(substrate[0])} ${numUnit(substrate[1])} ${numUnit(substrate[2])} rg\n0 0 ${wPt} ${hPt} re f\n` : '') +
        `${wPt} 0 0 ${hPt} 0 0 cm\n/Im0 Do\nQ\n`,
    );
    const contentObj = cat([ascii(`${contentNo} 0 obj\n<< /Length ${content.length} >>\nstream\n`), content, ascii(`\nendstream\nendobj\n`)]);
    objects.push(pageObj, imageObj, contentObj);
    pages[i].kids = pageNo;
  });

  objects[1] = ascii(`2 0 obj\n<< /Type /Pages /Kids [${pages.map((p) => `${p.kids} 0 R`).join(' ')}] /Count ${pages.length} >>\nendobj\n`);

  const offsets = [];
  let at = header.length;
  for (const o of objects) {
    offsets.push(at);
    at += o.length;
  }
  const body = cat([header, ...objects]);
  const size = objects.length + 1; // xref entry 0 is the free head

  const xrefAt = body.length;
  let xref = `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    // Every entry is exactly 20 bytes: 10-digit offset, SP, 5-digit generation,
    // SP, type, then the 2-byte EOL (" \n"). Readers seek by these bytes, so a
    // short entry silently shifts every object after it -- refuse rather than
    // write a table that points anywhere but at its object.
    if (off > 9999999999) {
      throw new RangeError(`encodePDFDocument: offset ${off} does not fit the 10-digit xref field`);
    }
    xref += `${String(off).padStart(10, '0')} 00000 n \n`;
  }
  const digest = sha256(body).subarray(0, 16); // deterministic: no clock, no salt
  const id = toHex(digest).toUpperCase();
  const trailer =
    `trailer\n<< /Size ${size} /Root 1 0 R\n   /ID [<${id}> <${id}>] >>\n` +
    `startxref\n${xrefAt}\n%%EOF`;

  return cat([body, ascii(xref + trailer)]);
}

/**
 * Single-page convenience wrapper: the object layout of the result is identical
 * to what this module produced before multi-page support existed.
 * @param {{width:number,height:number,pixels:Uint8Array,dpi:number,
 *          substrate?:number[]|Uint8Array,pageMm?:number[]}} img
 */
export function encodePDFPage(img) {
  return encodePDFDocument([img]);
}

export default encodePDFDocument;
