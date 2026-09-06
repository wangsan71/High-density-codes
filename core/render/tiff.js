/**
 * PSKT core -- baseline TIFF (TIFF 6.0, little-endian) raster encoder.
 *
 * Pure function, synchronous, byte-deterministic, zero dependency, no `node:`
 * builtins. See docs/RENDER-CONTRACT.md for the pixel buffer the input follows.
 *
 *   encodeTIFF({ width, height, pixels, dpi }) -> Uint8Array
 *
 * What it writes -- deliberately the smallest legal baseline image:
 *
 *   byte 0    'I' 'I'                 little-endian
 *   byte 2    42 (uint16 LE)          TIFF magic
 *   byte 4    8  (uint32 LE)          offset of the single first IFD
 *   byte 8    IFD: uint16 count, 12-byte entries, uint32 next-IFD = 0
 *   after it  out-of-line tag values (even offsets), then one uncompressed strip
 *
 * Tags, ALWAYS in ascending tag-number order (TIFF 6.0 sec. 1: "the values of
 * fields ... must be in ascending order"):
 *
 *   256 ImageWidth                 LONG
 *   257 ImageHeight                LONG
 *   258 BitsPerSample              3 x SHORT = 8,8,8        (out of line)
 *   259 Compression                SHORT = 1                (no compression)
 *   262 PhotometricInterpretation  SHORT = 2                (RGB)
 *   273 StripOffsets               LONG                     (out of line data)
 *   277 SamplesPerPixel            SHORT = 3
 *   278 RowsPerStrip               LONG = height            (exactly one strip)
 *   279 StripByteCounts            LONG = width*height*3
 *   282 XResolution                RATIONAL = dpi / 1       (out of line)
 *   283 YResolution                RATIONAL = dpi / 1       (out of line)
 *   296 ResolutionUnit             SHORT = 2                (inch)
 *
 * The strip is plain packed RGB, row-major, top row first, no per-row padding,
 * matching the RGBA input minus its alpha channel.
 */

const TYPE_BYTE = 1;
const TYPE_ASCII = 2;
const TYPE_SHORT = 3;
const TYPE_LONG = 4;
const TYPE_RATIONAL = 5;

const SAMPLE_BYTES = { [TYPE_BYTE]: 1, [TYPE_ASCII]: 1, [TYPE_SHORT]: 2, [TYPE_LONG]: 4, [TYPE_RATIONAL]: 8 };

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
/* little-endian writer over a pre-sized buffer                        */
/* ------------------------------------------------------------------ */

class Writer {
  constructor(buf) {
    this.a = buf;
    this.n = 0;
  }

  u8(v) {
    this.a[this.n++] = v & 255;
  }

  u16(v) {
    this.a[this.n++] = v & 255;
    this.a[this.n++] = (v >>> 8) & 255;
  }

  u32(v) {
    this.a[this.n++] = v & 255;
    this.a[this.n++] = (v >>> 8) & 255;
    this.a[this.n++] = (v >>> 16) & 255;
    this.a[this.n++] = (v >>> 24) & 255;
  }

  bytes(src, off, len) {
    this.a.set(src.subarray(off, off + len), this.n);
    this.n += len;
  }
}

/**
 * Encode an RGBA raster as a baseline little-endian, single-strip, uncompressed
 * RGB TIFF.
 * @param {{width:number,height:number,pixels:Uint8Array,dpi:number}} img
 * @returns {Uint8Array} the complete file
 */
export function encodeTIFF(img) {
  const { width, height, pixels, dpi } = checkRaster(img, 'encodeTIFF');

  const resDpi = Math.round(dpi);
  if (resDpi < 1 || resDpi > 0xffffffff) {
    throw new RangeError(`encodeTIFF: dpi ${dpi} does not fit a RATIONAL`);
  }

  // ---- strip geometry: packed RGB, one row after another, top row first ----
  // (written straight into the file below -- no 100 MB temporary copy)
  const stripLen = width * height * 3;

  // ---- tag table, ascending by tag number ----
  const tags = [
    { tag: 256, type: TYPE_LONG, count: 1, value: width },
    { tag: 257, type: TYPE_LONG, count: 1, value: height },
    { tag: 258, type: TYPE_SHORT, count: 3, shorts: [8, 8, 8] },
    { tag: 259, type: TYPE_SHORT, count: 1, value: 1 },
    { tag: 262, type: TYPE_SHORT, count: 1, value: 2 },
    { tag: 273, type: TYPE_LONG, count: 1, value: 0 }, // value = stripAt, set below
    { tag: 277, type: TYPE_SHORT, count: 1, value: 3 },
    { tag: 278, type: TYPE_LONG, count: 1, value: height },
    { tag: 279, type: TYPE_LONG, count: 1, value: stripLen },
    { tag: 282, type: TYPE_RATIONAL, count: 1, rational: [resDpi, 1] },
    { tag: 283, type: TYPE_RATIONAL, count: 1, rational: [resDpi, 1] },
    { tag: 296, type: TYPE_SHORT, count: 1, value: 2 },
  ];
  for (let i = 1; i < tags.length; i++) {
    if (tags[i].tag <= tags[i - 1].tag) throw new Error('encodeTIFF: tag table not ascending');
  }
  for (const t of tags) {
    t.size = t.count * SAMPLE_BYTES[t.type];
    t.inline = t.size <= 4;
  }

  const ifdAt = 8;
  const ifdSize = 2 + tags.length * 12 + 4;
  let cursor = ifdAt + ifdSize;
  for (const t of tags) {
    if (t.inline) continue;
    if (cursor & 1) cursor++; // keep every out-of-line offset even
    t.offset = cursor;
    cursor += t.size;
  }
  if (cursor & 1) cursor++;
  const stripAt = cursor;

  // Now that the geometry is fixed, StripOffsets can be filled in: it is the
  // only tag whose value depends on where the file ends up laying itself out.
  for (const t of tags) if (t.tag === 273) t.value = stripAt;

  const total = stripAt + stripLen;
  const out = new Uint8Array(total);
  const w = new Writer(out);

  // header
  w.u16(0x4949); // 'II'
  w.u16(42);
  w.u32(ifdAt);
  if (w.n !== ifdAt) throw new Error('encodeTIFF: header is not 8 bytes');

  // IFD
  w.u16(tags.length);
  for (const t of tags) {
    w.u16(t.tag);
    w.u16(t.type);
    w.u32(t.count);
    if (t.inline) {
      if (t.type === TYPE_SHORT) {
        w.u16(t.value);
        w.u16(0); // SHORT values are left-padded to the 4-byte value field
      } else {
        w.u32(t.value);
      }
    } else {
      w.u32(t.offset);
    }
  }
  w.u32(0); // no next IFD

  // out-of-line values
  for (const t of tags) {
    if (t.inline) continue;
    w.n = t.offset;
    if (t.shorts) {
      for (const s of t.shorts) w.u16(s);
    } else if (t.rational) {
      w.u32(t.rational[0]);
      w.u32(t.rational[1]);
    }
  }

  // strip: RGBA -> RGB straight into the file, no intermediate buffer
  w.n = stripAt;
  for (let s = 0; s < pixels.length; s += 4) {
    w.u8(pixels[s]);
    w.u8(pixels[s + 1]);
    w.u8(pixels[s + 2]);
  }

  if (w.n !== total) throw new Error(`encodeTIFF: internal size mismatch (${w.n} != ${total})`);
  return out;
}

export default encodeTIFF;
