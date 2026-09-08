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
import { sheetPlacement, sheetMarks } from './sheet.js';

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

/**
 * Optional sheet (paper) size in mm: [wMm, hMm]. When present the page is the paper and the
 * raster is centred on it, with crop marks and registration crosses drawn in the margin.
 * Distinct from pageMm on purpose: pageMm says how big the *content* is, sheetMm says what the
 * user actually loaded into the printer (DEFECTS D44).
 */
function checkSheetMm(v) {
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v) && !(v instanceof Float64Array)) {
    throw new TypeError('encodePDFDocument: sheetMm must be [wMm, hMm] or absent');
  }
  if (v.length !== 2) throw new RangeError('encodePDFDocument: sheetMm must have 2 entries');
  for (const n of v) {
    if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) {
      throw new RangeError(`encodePDFDocument: bad sheetMm entry ${n}`);
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
  // One pass over a possibly LAZY sequence, and no page's raster is referenced after that page's own
  // objects have been emitted. The old shape mapped the whole list into `pages` first -- which kept
  // every raster alive -- and only then encoded them, so a caller had to hold every page at once.
  // Measured in round 66 with tools/sender-memory-probe.mjs: ~31 MB per A4/300dpi page, i.e. 1.30 GB
  // of arrayBuffers for a 256 KiB file (42 pages) and ~5 GB for the 1 MB case that PLAN's own G6
  // criterion treats as ordinary, against the 255-page ceiling docs/USE.md advertises. A browser tab
  // dies long before that, and heapUsed sits at ~5 MB the whole time, so nothing watching the JS heap
  // would ever see it coming.
  // What does NOT change is the file this writer produces: objects are still emitted in page order
  // and the /Kids list is still built from the same numbers, so the bytes are identical -- the
  // round-66 ledger records the sha256 of a pack built before and after. Validation moves inside the
  // pass, so a bad page 3 now throws after pages 0-2 have been encoded instead of before; the caller
  // sees the same error and still gets no file, because the throw leaves this function either way.
  const isSeq = images && typeof images !== 'string' && typeof images[Symbol.iterator] === 'function';
  const list = Array.isArray(images) || isSeq ? images : [images];
  const header = cat([ascii(`%PDF-1.4\n`), new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])]);
  const objects = [
    ascii(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`),
    null, // /Pages, filled in once the kid numbers are known
  ];
  const kids = [];
  for (const img of list) {
    const i = kids.length;
    const { width, height, pixels, dpi } = checkRaster(img, 'encodePDFDocument');
    const substrate = checkSubstrate(img.substrate);
    const pageMm = checkPageMm(img.pageMm);
    const sheetMm = checkSheetMm(img.sheetMm);
    const pageNo = 3 + i * 3;
    const imageNo = pageNo + 1;
    const contentNo = pageNo + 2;
    // Content box: what this writer has always produced -- pageMm when the caller states a physical
    // size, otherwise the bitmap's own extent at its own dpi. The sheet work below does not touch it.
    const wNum = pageMm ? pageMm.w * PT_PER_MM : (width / dpi) * 72;
    const hNum = pageMm ? pageMm.h * PT_PER_MM : (height / dpi) * 72;
    const wPt = numPt(wNum);
    const hPt = numPt(hNum);

    // Sheet box: the paper. With it the page IS the paper and the content is centred on it, so the
    // margins are real and crop marks have somewhere to live (D44). Without it the page is the
    // content and the bytes are identical to what this module produced before the sheet existed.
    // pageLayout already refuses a page that does not fit its sheet; this refuses as well, because a
    // writer that trusts its callers eventually clips ink and says nothing about it.
    let boxWPt = wPt;
    let boxHPt = hPt;
    let txNum = 0;
    let tyNum = 0;
    let txPt = '0';
    let tyPt = '0';
    let sheetWNum = 0;
    let sheetHNum = 0;
    let place = null;
    if (sheetMm) {
      // The placement arithmetic lives in core/render/sheet.js, which the raster writer uses as
      // well: one definition of "the code area on the paper", so the PNG and the PDF cannot drift
      // apart (DEFECTS D45 -- `--sheet` used to reach this writer only). The refusal stays here with
      // its own wording, because callers and tests match on "cannot carry".
      if (sheetMm.w * PT_PER_MM < wNum - 1e-9 || sheetMm.h * PT_PER_MM < hNum - 1e-9) {
        throw new RangeError(
          `encodePDFDocument: sheet ${sheetMm.w}x${sheetMm.h}mm cannot carry a ${(wNum / PT_PER_MM).toFixed(1)}x${(hNum / PT_PER_MM).toFixed(1)}mm page`,
        );
      }
      place = sheetPlacement({ w: wNum / PT_PER_MM, h: hNum / PT_PER_MM }, sheetMm, 'encodePDFDocument');
      sheetWNum = place.sheetMm.w * PT_PER_MM;
      sheetHNum = place.sheetMm.h * PT_PER_MM;
      boxWPt = numPt(sheetWNum);
      boxHPt = numPt(sheetHNum);
      txNum = place.txMm * PT_PER_MM;
      tyNum = place.tyMm * PT_PER_MM;
      txPt = numPt(txNum);
      tyPt = numPt(tyNum);
    }

    const imageData = zlibWrap(filteredScanlines(width, height, pixels));
    const pageObj = ascii(
      `${pageNo} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${boxWPt} ${boxHPt}]\n` +
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
    // Crop marks at the four corners of the code area and a registration cross centred in each
    // margin, as vector strokes rather than pixels: they stay crisp at any printer resolution, and
    // they are geometry the decoder never has to interpret. Every length is derived from the margin
    // itself, so the marks always fit -- a fixed 5 mm arm on a 3 mm margin would be clipped by the
    // printer, or worse, land on the code area, and ink the decoder was never told about is exactly
    // how a page stops decoding. gap+arm is 0.8 of the margin and the crosses stay within 0.8 of
    // their half-margin, so nothing here can reach the content box; tests/unit/pdf-truesize.test.mjs
    // asserts that from the written bytes rather than trusting this comment.
    let marks = '';
    if (place) {
      // The same segment list the raster writer paints, in mm and converted once: four corner L's
      // plus four registration crosses = 16 segments. A degenerate sheet draws nothing and claims
      // nothing, exactly as before this geometry was shared.
      const m = sheetMarks({ w: wNum / PT_PER_MM, h: hNum / PT_PER_MM }, place.sheetMm, 'encodePDFDocument');
      if (!m.degenerate) {
        const seg = m.segments.map(
          ([x1, y1, x2, y2]) => `${numPt(x1 * PT_PER_MM)} ${numPt(y1 * PT_PER_MM)} m ${numPt(x2 * PT_PER_MM)} ${numPt(y2 * PT_PER_MM)} l`,
        );
        marks = `0 0 0 RG\n1 w\n${seg.join('\n')}\nS\n`;
      }
    }

    // The substrate fill is invisible while /Im0 covers the box; it is there so a
    // viewer that clips the image still shows material colour, not white. With a sheet it covers the
    // whole page, because the paper is the page now and a coloured substrate that stopped at the
    // code area would print as a rectangle the user did not ask for.
    const content = ascii(
      `q\n` +
        (substrate ? `${numUnit(substrate[0])} ${numUnit(substrate[1])} ${numUnit(substrate[2])} rg\n0 0 ${boxWPt} ${boxHPt} re f\n` : '') +
        marks +
        `${wPt} 0 0 ${hPt} ${txPt} ${tyPt} cm\n/Im0 Do\nQ\n`,
    );
    const contentObj = cat([ascii(`${contentNo} 0 obj\n<< /Length ${content.length} >>\nstream\n`), content, ascii(`\nendstream\nendobj\n`)]);
    objects.push(pageObj, imageObj, contentObj);
    kids.push(pageNo);
  }
  // The old code refused an empty list before encoding anything; a lazy sequence has no length up
  // front, so the same refusal now happens once the sequence turns out to be empty. Same error, same
  // message, and still no file.
  if (!kids.length) throw new RangeError('encodePDFDocument: no pages to write');

  objects[1] = ascii(`2 0 obj\n<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>\nendobj\n`);

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

// No default export: tools/build-web.mjs refuses default exports, so one here made this
// module impossible to carry into the browser -- which is what blocked the single-file
// sender (docs/DEFECTS.md D5) even though every caller already imports the name.
// tests/unit/export-conventions.test.mjs now keeps it that way.
