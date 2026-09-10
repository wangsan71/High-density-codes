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
import { packImage, packImageWithin, unpackImage } from '../core/image/container.js';

function parseArgs(argv) {
  const out = { width: 1240, height: 1754, qualities: [30, 50, 60, 70, 80, 90], writeImage: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--width') out.width = Number(argv[++i]);
    else if (a === '--height') out.height = Number(argv[++i]);
    else if (a === '--qualities') out.qualities = String(argv[++i]).split(',').map(Number);
    else if (a === '--write-image') out.writeImage = argv[++i];
    else if (a === '--budget') out.budget = Number(argv[++i]);
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
  const png = encodePNG({ width: w, height: h, pixels: src, dpi: 96 });
  console.log('image: ' + w + 'x' + h + ' (' + (w * h) + ' px), deterministic generator, our PNG of it = ' + png.length + ' B');
  if (args.writeImage) {
    mkdirSync(args.writeImage, { recursive: true });
    const p = join(args.writeImage, 'photo-' + w + 'x' + h + '.png');
    writeFileSync(p, png);
    console.log('wrote ' + p + ' for an external oracle to encode');
  }
  console.log('');
  console.log('q     payload B   PSNR dB   Y B      CbCr B    header B   B/px');
  for (const q of args.qualities) {
    // One implementation, used by the product too: packImage/unpackImage from core/image/container.js.
    const enc = packImage(src, w, h, q);
    const dec = unpackImage(enc.bytes);
    const bytes = enc.bytes.length;
    const p = psnr(src, dec.rgba, w, h, w);
    console.log(
      String(q).padEnd(5) + String(bytes).padEnd(12) + p.toFixed(2).padEnd(10) +
      String(enc.stats.planeBytes[0]).padEnd(9) +
      String(enc.stats.planeBytes[1] + enc.stats.planeBytes[2]).padEnd(10) +
      String(enc.stats.headerBytes).padEnd(11) + (bytes / (w * h)).toFixed(3));
  }
  if (args.budget) {
    // What a real page budget buys on this content: the search encodes until something fits, so this
    // number is measured, not extrapolated from the table above.
    const r = packImageWithin(src, w, h, args.budget, { minQuality: 5 });
    const dec = unpackImage(r.bytes);
    console.log('');
    console.log('budget ' + args.budget + ' B (e.g. 3 A4 pages at P-MX-300-5 = ' + (3 * 29100) + ' B): ' +
      'chose q' + r.quality + ' after ' + r.tried + ' encode(s), payload ' + r.bytes.length + ' B (' +
      (r.bytes.length / (w * h)).toFixed(3) + ' B/px), PSNR ' + psnr(src, dec.rgba, w, h, w).toFixed(2) + ' dB');
  }
}

// Only run when invoked as a program: tests import makePhoto/roundTripPlane from here, and a module
// that starts measuring the moment it is imported cannot be tested.
if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
