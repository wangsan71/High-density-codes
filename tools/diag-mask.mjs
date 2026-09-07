#!/usr/bin/env node
/**
 * Show where the ink actually is, as a coarse ASCII density map.
 *
 * Exists because counting components and pixels kept leading to theories about
 * structure (is there a frame? is the lattice bridged? is a marker merged with
 * something?) that only looking at the picture can settle. Two pages side by side,
 * one accepted and one rejected, usually ends the argument in one screenful.
 *
 * Usage: node tools/diag-mask.mjs FILE.png [FILE2.png ...] [--cols 52] [--rows 18]
 */
import { readFileSync } from 'node:fs';
import { decodePNG } from '../core/decode/png-read.js';
import { binarize } from '../core/decode/fiducial.js';

const args = process.argv.slice(2);
const files = args.filter((a) => !a.startsWith('--'));
const num = (flag, dflt) => {
  const i = args.indexOf(flag);
  return i >= 0 ? Number(args[i + 1]) : dflt;
};
const COLS = num('--cols', 52);
const ROWS = num('--rows', 18);

for (const file of files) {
  const bmp = decodePNG(new Uint8Array(readFileSync(file)));
  const bin = binarize(bmp);
  const mask = bin.mask || bin.bitmap || bin.values;
  if (!mask) {
    console.log(`${file}: binarize() returned no mask (keys: ${Object.keys(bin).join(',')})`);
    continue;
  }
  const W = bmp.width;
  const H = bmp.height;
  let out = `${file}  ${W}x${H}  ink=${bin.inkCount} (${((100 * bin.inkCount) / (W * H)).toFixed(2)}%)  thr=${Math.round(bin.threshold)}\n`;
  for (let r = 0; r < ROWS; r++) {
    const y0 = Math.floor((r * H) / ROWS);
    const y1 = Math.floor(((r + 1) * H) / ROWS);
    for (let c = 0; c < COLS; c++) {
      const x0 = Math.floor((c * W) / COLS);
      const x1 = Math.floor(((c + 1) * W) / COLS);
      let n = 0;
      let tot = 0;
      for (let y = y0; y < y1; y += 3) {
        for (let x = x0; x < x1; x += 3) {
          tot++;
          if (mask[y * W + x]) n++;
        }
      }
      const d = tot ? n / tot : 0;
      out += d > 0.5 ? '#' : d > 0.2 ? '+' : d > 0.05 ? '.' : ' ';
    }
    out += '\n';
  }
  // Per-edge ink share: a frame or border wash shows up here immediately.
  const band = 40;
  const edge = (name, test) => {
    let n = 0;
    let tot = 0;
    for (let y = 0; y < H; y += 3) {
      for (let x = 0; x < W; x += 3) {
        if (!test(x, y)) continue;
        tot++;
        if (mask[y * W + x]) n++;
      }
    }
    return `${name}=${tot ? ((100 * n) / tot).toFixed(1) : '?'}%`;
  };
  out += `  edges(${band}px): ${edge('top', (x, y) => y < band)} ${edge('bottom', (x, y) => y >= H - band)} ${edge('left', (x, y) => x < band)} ${edge('right', (x, y) => x >= W - band)} ${edge('interior', (x, y) => x >= band && y >= band && x < W - band && y < H - band)}\n`;
  process.stdout.write(out + '\n');
}
