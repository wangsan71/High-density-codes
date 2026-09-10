#!/usr/bin/env node
/**
 * tools/image-codec-bench.mjs -- rate and distortion for the self-written lossy image path
 * (PLAN v5 P2b). This is the bench the ledger may cite: the image is generated deterministically here,
 * so the numbers can be reproduced from a clean checkout with one command.
 *
 * What is measured: YCbCr 4:2:0, 8x8 DCT, standard quantisation tables, our own Huffman tables per
 * plane, decoded back and compared with the original in RGB. Bytes counted are what actually leaves
 * jpegish.encodeBlocks() -- header included -- summed over the three planes.
 *
 * What is NOT measured: no bitstream container, no interleaving, no restart markers, no progressive
 * scan. Those cost bytes that this bench does not include, so the byte column is a LOWER bound.
 *
 *   node tools/image-codec-bench.mjs --width 1240 --height 1754 --qualities 30,50,60,70,80,90
 *   node tools/image-codec-bench.mjs --write-image .tmp/codec-bench    # PNG for an external oracle
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fdct8x8, idct8x8, quantise, dequantise, QUANT_LUMA, QUANT_CHROMA } from '../core/image/dct.js';
import { encodeBlocks, decodeBlocks } from '../core/image/jpegish.js';
import { encodePNG } from '../core/render/png.js';

function parseArgs(argv) {
  const out = { width: 1240, height: 1754, qualities: [30, 50, 60, 70, 80, 90], writeImage: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--width') out.width = Number(argv[++i]);
    else if (a === '--height') out.height = Number(argv[++i]);
    else if (a === '--qualities') out.qualities = String(argv[++i]).split(',').map(Number);
    else if (a === '--write-image') out.writeImage = argv[++i];
    else throw new Error('unknown argument: ' + a);
  }
  return out;
}

const clamp8 = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

/** A deterministic photograph stand-in: gradients, soft objects, fine texture, a hard edge, noise. */
export function makePhoto(w, h) {
  const px = new Uint8Array(w * h * 4);
  let seed = 20260911;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const u = x / w;
      const v = y / h;
      let r = 40 + 150 * u + 20 * Math.sin(v * 7);
      let g = 60 + 120 * v + 25 * Math.sin(u * 5 + 1.3);
      let b = 90 + 80 * (1 - u * v);
      const t = Math.sin(x * 0.55 + y * 0.31) * Math.sin(y * 0.13 + 0.7 * Math.sin(x * 0.07));
      r += 28 * t; g += 34 * t; b += 18 * t;
      const d1 = Math.hypot(x - 0.32 * w, y - 0.38 * h) / (0.22 * h);
      if (d1 < 1) { const s = Math.cos((d1 * Math.PI) / 2); r += 90 * s; g += 60 * s; b += 20 * s; }
      const d2 = Math.hypot(x - 0.71 * w, y - 0.66 * h) / (0.16 * h);
      if (d2 < 1) { const s = Math.cos((d2 * Math.PI) / 2); r -= 60 * s; g -= 30 * s; b += 70 * s; }
      if (x > 0.55 * w && y > 0.12 * h && y < 0.2 * h) { r = 250; g = 245; b = 235; }
      const n = (rnd() - 0.5) * 10;
      const i = (y * w + x) * 4;
      px[i] = clamp8(r + n); px[i + 1] = clamp8(g + n); px[i + 2] = clamp8(b + n); px[i + 3] = 255;
    }
  }
  return px;
}

function toYCbCr(px, w, h) {
  const Y = new Float32Array(w * h);
  const Cb = new Float32Array((w >> 1) * (h >> 1));
  const Cr = new Float32Array((w >> 1) * (h >> 1));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const r = px[i], g = px[i + 1], b = px[i + 2];
      Y[y * w + x] = 0.299 * r + 0.587 * g + 0.114 * b;
    }
  }
  const cw = w >> 1, ch = h >> 1;
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      let sb = 0, sr = 0;
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const i = ((y * 2 + dy) * w + (x * 2 + dx)) * 4;
          const r = px[i], g = px[i + 1], b = px[i + 2];
          sb += 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
          sr += 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
        }
      }
      Cb[y * cw + x] = sb / 4;
      Cr[y * cw + x] = sr / 4;
    }
  }
  return { Y, Cb, Cr, cw, ch };
}

const pad = (n) => (n + 7) & ~7;

/** One plane through the whole pipeline; returns the bytes it took and the reconstructed plane. */
export function roundTripPlane(plane, w, h, table, quality) {
  const W = pad(w), H = pad(h);
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
  const back = decodeBlocks(enc.bytes, blocks.length);
  const out = new Float32Array(W * H);
  let n = 0;
  for (let by = 0; by < H; by += 8) {
    for (let bx = 0; bx < W; bx += 8) {
      const coeffs = dequantise(back[n++], table, quality);
      const px = idct8x8(coeffs);
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) out[(by + y) * W + (bx + x)] = px[y * 8 + x] + 128;
    }
  }
  return { bytes: enc.bytes.length, headerBytes: enc.stats.headerBytes, plane: out, W, H };
}

function toRGB(Y, W, H, cb, cr, cw, ch) {
  const px = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const yy = Y[y * W + x];
      // Nearest-neighbour chroma upsampling: a real decoder would interpolate, so this is the
      // pessimistic side of the comparison and is stated as such in the ledger.
      const cx = Math.min(cw - 1, x >> 1), cy = Math.min(ch - 1, y >> 1);
      const b = cb[cy * cw + cx] - 128;
      const r = cr[cy * cw + cx] - 128;
      const i = (y * W + x) * 4;
      px[i] = clamp8(yy + 1.402 * r);
      px[i + 1] = clamp8(yy - 0.344136 * b - 0.714136 * r);
      px[i + 2] = clamp8(yy + 1.772 * b);
      px[i + 3] = 255;
    }
  }
  return px;
}

/** PSNR over the original w x h window; the decoded planes are padded out to a multiple of 8, and
 *  comparing against that padding would be comparing against rows that do not exist. */
function psnr(src, dec, w, h, decStride) {
  let se = 0;
  const n = w * h * 3;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const j = (y * decStride + x) * 4;
      for (let c = 0; c < 3; c++) { const d = src[i + c] - dec[j + c]; se += d * d; }
    }
  }
  const mse = se / n;
  return mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const { width: w, height: h } = args;
  const src = makePhoto(w, h);
  const { Y, Cb, Cr, cw, ch } = toYCbCr(src, w, h);
  const png = encodePNG({ width: w, height: h, pixels: src, dpi: 96 });
  console.log('image: ' + w + 'x' + h + ' (' + (w * h) + ' px), deterministic generator, our PNG of it = ' + png.length + ' B');
  if (args.writeImage) {
    mkdirSync(args.writeImage, { recursive: true });
    const p = join(args.writeImage, 'photo-' + w + 'x' + h + '.png');
    writeFileSync(p, png);
    console.log('wrote ' + p + ' for an external oracle to encode');
  }
  console.log('');
  console.log('q     our bytes   PSNR dB   Y B      CbCr B   header B   B/px');
  for (const q of args.qualities) {
    const y = roundTripPlane(Y, w, h, QUANT_LUMA, q);
    const cb = roundTripPlane(Cb, cw, ch, QUANT_CHROMA, q);
    const cr = roundTripPlane(Cr, cw, ch, QUANT_CHROMA, q);
    const rgb = toRGB(y.plane, y.W, y.H, cb.plane, cr.plane, cb.W, cb.H);
    const bytes = y.bytes + cb.bytes + cr.bytes;
    const head = y.headerBytes + cb.headerBytes + cr.headerBytes;
    const p = psnr(src, rgb, w, h, y.W);
    console.log(
      String(q).padEnd(5) + String(bytes).padEnd(12) + p.toFixed(2).padEnd(10) +
      String(y.bytes).padEnd(9) + String(cb.bytes + cr.bytes).padEnd(9) + String(head).padEnd(11) +
      (bytes / (w * h)).toFixed(3));
  }
}

// Only run when invoked as a program: tests import makePhoto/roundTripPlane from here, and a module
// that starts measuring the moment it is imported cannot be tested.
if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
