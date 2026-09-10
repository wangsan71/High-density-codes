/**
 * core/image/container.js -- one image as one payload (PLAN v5 P2b, brick four).
 *
 * dct.js/jpegish.js/color.js each own one half of the trade; this file is what a caller actually hands
 * around: a self-describing payload that carries its own geometry and quality, so the receiver can
 * rebuild the picture without being told anything out of band.
 *
 * The rules that do not bend: a payload that is not ours is refused by name, and a payload that is
 * truncated is refused rather than silently decoded into a different picture. The page layer above
 * still carries the CRC and digest that make silent corruption impossible end to end.
 */

import { fdct8x8, idct8x8, quantise, dequantise, QUANT_LUMA, QUANT_CHROMA } from './dct.js';
import { encodeBlocks, decodeBlocks } from './jpegish.js';
import { rgbToYCbCr, upsampleChroma2x, yCbCrToRgb } from './color.js';

export const MAGIC = [0x50, 0x53, 0x4b, 0x49]; // 'PSKI'
export const VERSION = 1;
export const HEADER_BYTES = 24;

const pad = (n) => (n + 7) & ~7;

/** One plane through DCT + quantisation + entropy coding. */
function packPlane(plane, w, h, table, quality) {
  const W = pad(w);
  const H = pad(h);
  const blocks = [];
  const raw = new Float32Array(64);
  for (let by = 0; by < H; by += 8) {
    for (let bx = 0; bx < W; bx += 8) {
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          const sx = Math.min(w - 1, bx + x);
          const sy = Math.min(h - 1, by + y);
          raw[y * 8 + x] = plane[sy * w + sx] - 128;
        }
      }
      blocks.push(quantise(fdct8x8(raw), table, quality));
    }
  }
  const enc = encodeBlocks(blocks);
  return { bytes: enc.bytes, blocks: (W / 8) * (H / 8), headerBytes: enc.stats.headerBytes };
}

function unpackPlane(stream, blocks, w, h, table, quality) {
  const W = pad(w);
  const H = pad(h);
  const quantised = decodeBlocks(stream, blocks);
  const out = new Float32Array(W * H);
  let n = 0;
  for (let by = 0; by < H; by += 8) {
    for (let bx = 0; bx < W; bx += 8) {
      const px = idct8x8(dequantise(quantised[n++], table, quality));
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) out[(by + y) * W + (bx + x)] = px[y * 8 + x] + 128;
    }
  }
  return out;
}

/**
 * Encode an RGBA image (Uint8Array, 4 bytes per pixel) into one payload.
 * Returns the payload and the sizes of the parts, because the bench reports them.
 */
export function packImage(rgba, width, height, quality) {
  if (!(rgba instanceof Uint8Array) || rgba.length !== width * height * 4) {
    throw new RangeError('container: expected width*height*4 = ' + width * height * 4 + ' bytes of RGBA, got ' + (rgba ? rgba.length : 'nothing'));
  }
  if (!(width > 0 && height > 0 && width <= 65535 && height <= 65535)) {
    throw new RangeError('container: width/height must be 1..65535, got ' + width + 'x' + height);
  }
  const q = Math.min(100, Math.max(1, Math.round(quality)));
  const { Y, Cb, Cr, cw, ch } = rgbToYCbCr(rgba, width, height);
  const y = packPlane(Y, width, height, QUANT_LUMA, q);
  const cb = packPlane(Cb, cw, ch, QUANT_CHROMA, q);
  const cr = packPlane(Cr, cw, ch, QUANT_CHROMA, q);

  const out = new Uint8Array(HEADER_BYTES + y.bytes.length + cb.bytes.length + cr.bytes.length);
  out.set(MAGIC, 0);
  out[4] = VERSION;
  out[5] = (width >> 8) & 0xff;
  out[6] = width & 0xff;
  out[7] = (height >> 8) & 0xff;
  out[8] = height & 0xff;
  out[9] = q;
  out[10] = 0; // subsampling: 0 = 4:2:0, the only mode this build writes
  out[11] = 0; // reserved
  const lens = [y.bytes.length, cb.bytes.length, cr.bytes.length];
  for (let i = 0; i < 3; i++) {
    out[12 + i * 4] = (lens[i] >>> 24) & 0xff;
    out[13 + i * 4] = (lens[i] >>> 16) & 0xff;
    out[14 + i * 4] = (lens[i] >>> 8) & 0xff;
    out[15 + i * 4] = lens[i] & 0xff;
  }
  out.set(y.bytes, HEADER_BYTES);
  out.set(cb.bytes, HEADER_BYTES + lens[0]);
  out.set(cr.bytes, HEADER_BYTES + lens[0] + lens[1]);
  return {
    bytes: out,
    stats: {
      width, height, quality: q, totalBytes: out.length, headerBytes: HEADER_BYTES,
      planeBytes: lens, blocks: y.blocks,
    },
  };
}

/**
 * The quality ladder the "fit into a byte budget" search walks, highest first. Steps of five are what
 * the measured rate/distortion curve (STATUS round 131/132) supports; a finer ladder buys fractions of
 * a dB for whole extra encodes.
 */
export const QUALITY_LADDER = [95, 90, 85, 80, 75, 70, 65, 60, 55, 50, 45, 40, 35, 30, 25, 20, 15, 10, 5];

/**
 * Pack an image so that the payload fits maxBytes, by trying the ladder from the top down.
 *
 * This MEASURES instead of estimating: it really encodes and compares real lengths, because "compression
 * ratio" has no upper bound and a budget refused on an estimate is a budget refused wrongly (AGENTS
 * section 6.4). One assumption is stated rather than hidden: bytes are assumed to fall as quality falls,
 * so the first rung that fits ends the search. If that assumption were ever violated for a particular
 * image, the returned payload still fits -- it might just not be the best one that fits, which is the
 * safe direction to be wrong in.
 *
 * Refusal is named and actionable: it says what the smallest rung actually cost and what the budget was.
 */
export function packImageWithin(rgba, width, height, maxBytes, opts = {}) {
  const minQuality = opts.minQuality === undefined ? 10 : opts.minQuality;
  if (!(maxBytes > 0)) throw new RangeError('container: byte budget must be positive, got ' + maxBytes);
  const ladder = (opts.ladder || QUALITY_LADDER).filter((q) => q >= minQuality);
  if (ladder.length === 0) throw new RangeError('container: no quality on the ladder is at or above minQuality ' + minQuality);
  let smallest = null;
  for (let i = 0; i < ladder.length; i++) {
    const enc = packImage(rgba, width, height, ladder[i]);
    smallest = enc;
    if (enc.bytes.length <= maxBytes) {
      return { ...enc, quality: ladder[i], tried: i + 1, budget: maxBytes, fits: true };
    }
  }
  throw new RangeError(
    'container: even q' + ladder[ladder.length - 1] + ' needs ' + smallest.bytes.length +
    ' bytes and the budget is ' + maxBytes + ' -- downscale the image or allow more pages');
}

/** Read the header. Everything that is not exactly what this build writes is a named refusal. */
export function parseContainer(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('container: expected a Uint8Array');
  if (bytes.length < HEADER_BYTES) throw new RangeError('container: ' + bytes.length + ' bytes is too short to hold a header');
  for (let i = 0; i < 4; i++) if (bytes[i] !== MAGIC[i]) throw new RangeError('container: not a PSKI payload (bad magic)');
  if (bytes[4] !== VERSION) throw new RangeError('container: payload version ' + bytes[4] + ' is not the one this build reads (' + VERSION + ')');
  const width = (bytes[5] << 8) | bytes[6];
  const height = (bytes[7] << 8) | bytes[8];
  const quality = bytes[9];
  if (bytes[10] !== 0) throw new RangeError('container: subsampling mode ' + bytes[10] + ' is not supported by this build');
  if (width === 0 || height === 0) throw new RangeError('container: header claims a ' + width + 'x' + height + ' image');
  const u32 = (i) => ((bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3]) >>> 0;
  const lens = [u32(12), u32(16), u32(20)];
  const total = HEADER_BYTES + lens[0] + lens[1] + lens[2];
  if (total !== bytes.length) {
    throw new RangeError('container: header declares ' + total + ' bytes of planes but the payload is ' + bytes.length + ' bytes');
  }
  const streams = [];
  let off = HEADER_BYTES;
  for (const len of lens) {
    streams.push(bytes.subarray(off, off + len));
    off += len;
  }
  return { width, height, quality, lens, streams };
}

/** Decode a payload back to RGBA. Odd sizes are handled by cropping to the declared geometry. */
export function unpackImage(bytes) {
  const head = parseContainer(bytes);
  const { width, height, quality } = head;
  const cw = width >> 1;
  const ch = height >> 1;
  const yBlocks = (pad(width) / 8) * (pad(height) / 8);
  const cBlocks = (pad(cw) / 8) * (pad(ch) / 8);
  const Y = unpackPlane(head.streams[0], yBlocks, width, height, QUANT_LUMA, quality);
  const Cb = unpackPlane(head.streams[1], cBlocks, cw, ch, QUANT_CHROMA, quality);
  const Cr = unpackPlane(head.streams[2], cBlocks, cw, ch, QUANT_CHROMA, quality);
  const YW = pad(width);
  const YH = pad(height);
  const cbUp = upsampleChroma2x(Cb, pad(cw), pad(ch), YW, YH);
  const crUp = upsampleChroma2x(Cr, pad(cw), pad(ch), YW, YH);
  const full = yCbCrToRgb(Y, cbUp, crUp, YW, YH);
  // Hand back exactly the declared geometry: a caller that has to know about the block padding is a
  // caller that will eventually forget to.
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) rgba.set(full.subarray(y * YW * 4, y * YW * 4 + width * 4), y * width * 4);
  return { width, height, quality, rgba };
}
