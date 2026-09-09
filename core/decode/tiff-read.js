/**
 * Baseline TIFF reader (core/decode/tiff-read.js).
 *
 * Why this exists (DEFECTS D82): TIFF is the default output of a lot of flatbed scanner
 * software, and in an air-gapped workflow "install ImageMagick first" is not an answer --
 * this project's whole promise is that it carries its own codecs. Until this file, the
 * receiver named TIFF as unreadable and told the user to convert, even though the writer
 * in core/render/tiff.js has always been able to produce one.
 *
 * Scope is deliberately the scanner-realistic baseline, and everything outside it is
 * refused by name rather than guessed at:
 *
 *   byte order      II and MM
 *   pages           one or more IFDs; every page is returned, in file order
 *   layout          strip-based, chunky (PlanarConfiguration 1)
 *   photometric     0 WhiteIsZero, 1 BlackIsZero, 2 RGB, 3 palette (ColorMap)
 *   bits/sample     1, 4, 8, 16 (all components equal; 16 keeps its high byte)
 *   samples/pixel   1 (gray, palette) or 3 (RGB); SampleFormat 1 (unsigned) only
 *   compression     1 none, 5 LZW (TIFF early-change), 8/32946 Deflate, 32773 PackBits
 *   fill order      1 (MSB first) and 2 (LSB first) -- scanners use both for bilevel
 *   predictor       1 none, 2 horizontal differencing
 *   orientation     1 (top-left) only
 *   resolution      XResolution/YResolution + ResolutionUnit -> dpi (2 inch, 3 cm)
 *
 * Tiles, separate planes, CMYK/YCbCr, floating point, JPEG-in-TIFF and every other
 * orientation throw with the tag that made them unsupported.
 */

import { inflateRaw } from '../deflate.js';

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

/** Bit-reversed byte, for FillOrder 2. */
const REVERSED = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  let v = 0;
  for (let b = 0; b < 8; b++) if (i & (1 << b)) v |= 1 << (7 - b);
  REVERSED[i] = v;
}

function fail(msg) {
  throw new Error('decodeTIFF: ' + msg);
}

/**
 * TIFF LZW (spec 13): MSB-first codes, 9..12 bits, Clear=256, EOI=257, and the
 * "early change" rule that grows the code width one code before the table is full.
 */
function lzwDecode(input, expected) {
  let out = new Uint8Array(expected > 0 ? expected : 1 << 20);
  let outLen = 0;
  const prefix = new Int32Array(4096);
  const suffix = new Uint8Array(4096);
  for (let i = 0; i < 256; i++) {
    prefix[i] = -1;
    suffix[i] = i;
  }
  const stack = new Uint8Array(4096);
  let bitPos = 0;
  let width = 9;
  let next = 258;
  let prev = -1;
  const totalBits = input.length * 8;
  const readCode = () => {
    let code = 0;
    for (let i = 0; i < width; i++) {
      const p = bitPos + i;
      if (p >= totalBits) return -1;
      code = (code << 1) | ((input[p >> 3] >> (7 - (p & 7))) & 1);
    }
    bitPos += width;
    return code;
  };
  while (true) {
    const code = readCode();
    if (code < 0 || code === 257) break;
    if (code === 256) {
      width = 9;
      next = 258;
      prev = -1;
      continue;
    }
    if (code > next) fail('LZW code ' + code + ' is not in the table');
    let sp = 0;
    if (code === next) {
      // KwKwK: the code being defined, plus its own first byte.
      if (prev < 0) fail('LZW code refers to itself with no previous string');
      let p = prev;
      while (p >= 0) {
        stack[sp++] = suffix[p];
        p = prefix[p];
      }
      stack[sp] = stack[sp - 1];
      sp++;
    } else {
      let p = code;
      while (p >= 0) {
        stack[sp++] = suffix[p];
        p = prefix[p];
      }
    }
    for (let i = sp - 1; i >= 0; i--) {
      if (outLen >= out.length) {
        const bigger = new Uint8Array(out.length * 2);
        bigger.set(out);
        out = bigger;
      }
      out[outLen++] = stack[i];
    }
    if (prev >= 0 && next < 4096) {
      prefix[next] = prev;
      suffix[next] = stack[sp - 1];
      next++;
      if (next === (1 << width) - 1 && width < 12) width++;
    }
    prev = code;
    if (expected > 0 && outLen >= expected) break;
  }
  return out.subarray(0, outLen);
}

/** Adobe Deflate (compression 8) wraps the deflate stream in zlib: 2 header bytes + adler32. */
function inflateZlib(raw, expected) {
  if (raw.length < 6 || (raw[0] & 0x0f) !== 8) fail('Deflate strip is not a zlib stream');
  return inflateRaw(raw.subarray(2, raw.length - 4), expected);
}

function packBitsDecode(input, expected) {
  const out = new Uint8Array(expected > 0 ? expected : input.length * 2);
  let o = 0;
  let i = 0;
  while (i < input.length) {
    const n = (input[i++] << 24) >> 24; // signed
    if (n >= 0) {
      const take = Math.min(n + 1, input.length - i);
      out.set(input.subarray(i, i + take), o);
      o += take;
      i += take;
    } else if (n !== -128) {
      const count = Math.min(1 - n, out.length - o);
      if (i < input.length) {
        out.fill(input[i], o, o + count);
        o += count;
      }
      i++;
    }
  }
  return out.subarray(0, o);
}

/** A single IFD, with every tag value resolved to an array. */
function readIfd(bytes, offset, le) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (o) => dv.getUint16(o, le);
  const u32 = (o) => dv.getUint32(o, le);
  if (offset + 2 > bytes.length) fail('IFD offset is past the end of the file');
  const count = u16(offset);
  const tags = new Map();
  for (let i = 0; i < count; i++) {
    const e = offset + 2 + i * 12;
    if (e + 12 > bytes.length) fail('IFD entry runs past the end of the file');
    const tag = u16(e);
    const type = u16(e + 2);
    const n = u32(e + 4);
    const size = (TYPE_SIZE[type] || 0) * n;
    if (!size) continue; // unknown type: the spec lets a reader skip it
    let at = e + 8;
    if (size > 4) at = u32(e + 8);
    if (at + size > bytes.length) fail('tag ' + tag + ' value runs past the end of the file');
    const values = [];
    for (let k = 0; k < n; k++) {
      const p = at + k * (TYPE_SIZE[type] || 1);
      if (type === 3) values.push(u16(p));
      else if (type === 4) values.push(u32(p));
      else if (type === 5) values.push(u32(p + 4) ? u32(p) / u32(p + 4) : 0);
      else if (type === 1 || type === 7 || type === 2) values.push(bytes[p]);
      else if (type === 9) values.push(dv.getInt32(p, le));
      else if (type === 8) values.push(dv.getInt16(p, le));
      else if (type === 6) values.push(dv.getInt8(p));
      else if (type === 10) values.push(u32(p + 4) ? dv.getInt32(p, le) / u32(p + 4) : 0);
      else if (type === 11) values.push(dv.getFloat32(p, le));
      else if (type === 12) values.push(dv.getFloat64(p, le));
      else values.push(0);
    }
    tags.set(tag, { type, values });
  }
  const next = u32(offset + 2 + count * 12);
  return { tags, next };
}

const tag1 = (ifd, id, dflt) => {
  const t = ifd.tags.get(id);
  return t && t.values.length ? t.values[0] : dflt;
};
const tagAll = (ifd, id, dflt) => {
  const t = ifd.tags.get(id);
  return t && t.values.length ? t.values : dflt;
};

function sampleAt(rowBuf, x, ch, depth, samplesPerPixel, bitsPerPixel) {
  if (depth === 8) return rowBuf[x * samplesPerPixel + ch];
  if (depth === 16) return rowBuf[(x * samplesPerPixel + ch) * 2];
  const bitIndex = x * bitsPerPixel + ch * depth;
  const byte = rowBuf[bitIndex >> 3];
  const shift = 8 - depth - (bitIndex & 7);
  return (byte >> shift) & ((1 << depth) - 1);
}

/** Predictor 2: horizontal differencing, per sample. */
function undoPredictor(rowBuf, width, depth, samplesPerPixel) {
  if (depth === 8) {
    for (let x = samplesPerPixel; x < width * samplesPerPixel; x++) {
      rowBuf[x] = (rowBuf[x] + rowBuf[x - samplesPerPixel]) & 255;
    }
  } else if (depth === 16) {
    for (let x = samplesPerPixel; x < width * samplesPerPixel; x++) {
      const cur = x * 2;
      const prev = (x - samplesPerPixel) * 2;
      const v = ((rowBuf[cur] << 8) | rowBuf[cur + 1]) + ((rowBuf[prev] << 8) | rowBuf[prev + 1]);
      rowBuf[cur] = (v >> 8) & 255;
      rowBuf[cur + 1] = v & 255;
    }
  } else {
    fail('Predictor 2 with ' + depth + '-bit samples is not supported');
  }
}

/** Decode one IFD into {width,height,pixels,dpi}. */
function decodeIfd(bytes, ifd) {
  const width = tag1(ifd, 256, 0);
  const height = tag1(ifd, 257, 0);
  if (!width || !height) fail('page has no ImageWidth/ImageLength');
  const compression = tag1(ifd, 259, 1);
  const photometric = tag1(ifd, 262, 1);
  const fillOrder = tag1(ifd, 266, 1);
  const orientation = tag1(ifd, 274, 1);
  const samplesPerPixel = tag1(ifd, 277, 1);
  const rowsPerStrip = tag1(ifd, 278, height);
  const planar = tag1(ifd, 284, 1);
  const predictor = tag1(ifd, 317, 1);
  const sampleFormat = tag1(ifd, 339, 1);
  const bits = tagAll(ifd, 258, [1]);
  const stripOffsets = tagAll(ifd, 273, []);
  const stripBytes = tagAll(ifd, 279, []);
  const colorMap = tagAll(ifd, 320, []);

  if (orientation !== 1) fail('orientation ' + orientation + ' is not supported (only 1, top-left)');
  if (planar !== 1) fail('PlanarConfiguration ' + planar + ' (separate planes) is not supported');
  if (sampleFormat !== 1) fail('SampleFormat ' + sampleFormat + ' is not supported (only 1, unsigned integer)');
  if (!stripOffsets.length) fail('no StripOffsets: tiled TIFFs are not supported');
  const depth = bits[0];
  if (![1, 4, 8, 16].includes(depth)) fail('BitsPerSample ' + depth + ' is not supported (1, 4, 8, 16)');
  if (bits.some((b) => b !== depth)) fail('BitsPerSample differs per component, which this reader does not support');
  if (samplesPerPixel !== 1 && samplesPerPixel !== 3) fail('SamplesPerPixel ' + samplesPerPixel + ' is not supported (1 or 3)');
  if (photometric === 3 && samplesPerPixel !== 1) fail('palette TIFF with more than one sample per pixel');
  if (photometric === 2 && samplesPerPixel !== 3) fail('RGB TIFF without three samples per pixel');
  if (photometric === 3 && !colorMap.length) fail('palette TIFF without a ColorMap');
  if (![0, 1, 2, 3].includes(photometric)) fail('PhotometricInterpretation ' + photometric + ' is not supported (0, 1, 2, 3)');

  const bitsPerPixel = depth * samplesPerPixel;
  const bytesPerRow = Math.ceil((width * bitsPerPixel) / 8);
  const pixels = new Uint8Array(width * height * 4);
  let rowBase = 0;
  for (let s = 0; s < stripOffsets.length; s++) {
    const rows = Math.min(rowsPerStrip, height - rowBase);
    if (rows <= 0) break;
    const start = stripOffsets[s];
    const len = stripBytes[s] ?? bytes.length - start;
    const raw = bytes.subarray(start, start + len);
    const want = rows * bytesPerRow;
    let data;
    if (compression === 1) data = raw;
    else if (compression === 5) data = lzwDecode(raw, want);
    else if (compression === 8) data = inflateZlib(raw, want); // Adobe Deflate: zlib-wrapped
    else if (compression === 32946) data = inflateRaw(raw, want); // Deflate: raw RFC 1951
    else if (compression === 32773) data = packBitsDecode(raw, want);
    else fail('Compression ' + compression + ' is not supported (1 none, 5 LZW, 8 Deflate, 32773 PackBits)');
    if (data.length < want) fail('strip ' + s + ' is short: ' + data.length + ' of ' + want + ' bytes');

    const rowBuf = new Uint8Array(bytesPerRow);
    for (let r = 0; r < rows; r++) {
      rowBuf.set(data.subarray(r * bytesPerRow, (r + 1) * bytesPerRow));
      if (fillOrder === 2) for (let i = 0; i < bytesPerRow; i++) rowBuf[i] = REVERSED[rowBuf[i]];
      if (predictor === 2) undoPredictor(rowBuf, width, depth, samplesPerPixel);
      const o = (rowBase + r) * width * 4;
      if (photometric === 3) {
        const entries = colorMap.length / 3;
        for (let x = 0; x < width; x++) {
          const idx = sampleAt(rowBuf, x, 0, depth, samplesPerPixel, bitsPerPixel);
          if (idx >= entries) fail('ColorMap index ' + idx + ' is out of range (' + entries + ' entries)');
          pixels[o + x * 4] = colorMap[idx] >> 8;
          pixels[o + x * 4 + 1] = colorMap[entries + idx] >> 8;
          pixels[o + x * 4 + 2] = colorMap[2 * entries + idx] >> 8;
          pixels[o + x * 4 + 3] = 255;
        }
      } else if (photometric === 2) {
        for (let x = 0; x < width; x++) {
          const i = o + x * 4;
          pixels[i] = sampleAt(rowBuf, x, 0, depth, samplesPerPixel, bitsPerPixel);
          pixels[i + 1] = sampleAt(rowBuf, x, 1, depth, samplesPerPixel, bitsPerPixel);
          pixels[i + 2] = sampleAt(rowBuf, x, 2, depth, samplesPerPixel, bitsPerPixel);
          pixels[i + 3] = 255;
        }
      } else {
        // 0 = WhiteIsZero, 1 = BlackIsZero: the same numbers mean opposite ink.
        const scale = depth === 1 ? 255 : depth === 4 ? 17 : 1;
        for (let x = 0; x < width; x++) {
          let g = sampleAt(rowBuf, x, 0, depth, samplesPerPixel, bitsPerPixel) * scale;
          if (photometric === 0) g = 255 - g;
          const i = o + x * 4;
          pixels[i] = g;
          pixels[i + 1] = g;
          pixels[i + 2] = g;
          pixels[i + 3] = 255;
        }
      }
    }
    rowBase += rows;
  }

  // Resolution: RATIONAL values with unit 2 (inch) or 3 (centimetre).
  let dpi = null;
  const xres = tag1(ifd, 282, 0);
  const unit = tag1(ifd, 296, 2);
  if (xres > 0 && (unit === 2 || unit === 3)) dpi = Math.round(unit === 3 ? xres * 2.54 : xres);
  return { width, height, pixels, dpi };
}

/**
 * @param {Uint8Array|Buffer} bytes
 * @returns {{pages: Array<{width:number,height:number,pixels:Uint8Array,dpi:number|null}>}}
 */
export function decodeTIFF(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length < 8) fail('file is too short to be a TIFF');
  const le = b[0] === 0x49 && b[1] === 0x49;
  const be = b[0] === 0x4d && b[1] === 0x4d;
  if (!le && !be) fail('byte order mark is neither II nor MM');
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (dv.getUint16(2, le) !== 42) fail('magic is not 42');
  let offset = dv.getUint32(4, le);
  const pages = [];
  let guard = 0;
  while (offset && guard++ < 512) {
    const ifd = readIfd(b, offset, le);
    pages.push(decodeIfd(b, ifd));
    offset = ifd.next;
  }
  if (!pages.length) fail('no image file directory found');
  return { pages };
}
