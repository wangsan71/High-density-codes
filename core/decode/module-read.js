/**
 * Reader for the binary solid-module paper representation.
 *
 * The page is rectified by the existing corner-marker homography. The fixed
 * top/left timing rows then refine the origin and calibrate black/white levels.
 * The result is the same `levels` + `cellMissing` shape used by the existing RS
 * assembler.
 */

import { moduleTimingLevel } from '../render/modules.js';
import { interleaveStep } from '../protocol.js';
import { interleaveTable, applyPermute } from '../pack.js';

const WINDOW = 9;
const MIN_LOCAL_SPAN = 1000;
const ERASURE_MARGIN = 0.002;

function moduleDarkness(bitmap, layout, c, r, ox = 0, oy = 0) {
  const sub = bitmap.substrate || [255, 255, 255];
  const { pixels, width } = bitmap;
  const cellPx = layout.cellPx;
  const x0 = Math.round(layout.originPx.x + ox + c * cellPx);
  const y0 = Math.round(layout.originPx.y + oy + r * cellPx);
  let sum = 0;
  let n = 0;
  for (let py = 0; py < cellPx; py++) {
    const y = y0 + py;
    if (y < 0 || y >= Math.floor(pixels.length / (width * 4))) continue;
    for (let px = 0; px < cellPx; px++) {
      const x = x0 + px;
      if (x < 0 || x >= width) continue;
      const o = (y * width + x) * 4;
      const dr = pixels[o] - sub[0];
      const dg = pixels[o + 1] - sub[1];
      const db = pixels[o + 2] - sub[2];
      sum += dr * dr + dg * dg + db * db;
      n++;
    }
  }
  return n ? sum / n : 0;
}

function timingScore(bitmap, layout, geom, ox, oy) {
  const moduleCols = geom.moduleCols ?? geom.cols;
  const moduleRows = geom.moduleRows ?? geom.rows;
  let score = 0;
  for (let i = 0; i < moduleCols; i++) {
    const want = moduleTimingLevel(i, 0);
    score += (want ? 1 : -1) * moduleDarkness(bitmap, layout, i, 0, ox, oy);
  }
  for (let i = 1; i < moduleRows; i++) {
    const want = moduleTimingLevel(0, i);
    score += (want ? 1 : -1) * moduleDarkness(bitmap, layout, 0, i, ox, oy);
  }
  return score;
}

function refineTimingOffset(bitmap, layout, geom) {
  let best = { ox: 0, oy: 0, score: timingScore(bitmap, layout, geom, 0, 0) };
  for (let oy = -3; oy <= 3; oy++) {
    for (let ox = -3; ox <= 3; ox++) {
      if (ox === 0 && oy === 0) continue;
      const score = timingScore(bitmap, layout, geom, ox, oy);
      if (score > best.score) best = { ox, oy, score };
    }
  }
  return best;
}

function median(values) {
  if (!values.length) return 0;
  const s = Array.from(values).sort((a, b) => a - b);
  return s[s.length >> 1];
}

function otsu(values) {
  const bins = 32;
  const hist = new Uint32Array(bins);
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const span = hi - lo;
  if (!(span > 1e-9)) return { threshold: lo, span: 0, lo, hi };
  for (const v of values) hist[Math.min(bins - 1, Math.floor(((v - lo) / span) * bins))]++;
  let total = 0;
  let sum = 0;
  for (let b = 0; b < bins; b++) {
    total += hist[b];
    sum += b * hist[b];
  }
  let best = -1;
  let thr = 0;
  let w0 = 0;
  let s0 = 0;
  for (let b = 0; b < bins; b++) {
    w0 += hist[b];
    if (!w0) continue;
    const w1 = total - w0;
    if (!w1) break;
    s0 += b * hist[b];
    const m0 = s0 / w0;
    const m1 = (sum - s0) / w1;
    const between = w0 * w1 * (m0 - m1) * (m0 - m1);
    if (between > best) {
      best = between;
      thr = b + 0.5;
    }
  }
  return { threshold: lo + (thr / bins) * span, span, lo, hi };
}

function calibratedThreshold(bitmap, layout, geom) {
  const moduleCols = geom.moduleCols ?? geom.cols;
  const moduleRows = geom.moduleRows ?? geom.rows;
  const black = [];
  const white = [];
  for (let c = 0; c < moduleCols; c++) {
    const want = moduleTimingLevel(c, 0);
    (want ? black : white).push(moduleDarkness(bitmap, layout, c, 0));
  }
  for (let r = 0; r < moduleRows; r++) {
    const want = moduleTimingLevel(0, r);
    (want ? black : white).push(moduleDarkness(bitmap, layout, 0, r));
  }
  const b = median(black);
  const w = median(white);
  return { threshold: (b + w) / 2, black: b, white: w, span: Math.max(1, b - w) };
}

/**
 * Read a rectified module page.
 * @returns {{levels:Uint16Array, quality:Float32Array, cellMissing:Uint8Array,
 *   colourAlive:boolean, shapeCounts:number[]}}
 */
export function readModuleIdeal(bitmap, layout, geom) {
  const refined = refineTimingOffset(bitmap, layout, geom);
  const calibrated = calibratedThreshold(bitmap, layout, geom);
  const moduleCols = geom.moduleCols ?? geom.cols;
  const moduleRows = geom.moduleRows ?? geom.rows;
  const n = geom.totalCells;
  const values = new Float64Array(n);
  let dataIndex = 0;
  for (let r = 0; r < moduleRows; r++) {
    for (let c = 0; c < moduleCols; c++) {
      if (moduleTimingLevel(c, r) !== null) continue;
      values[dataIndex++] = moduleDarkness(bitmap, layout, c, r, refined.ox, refined.oy);
    }
  }

  const levels = new Uint16Array(n);
  const quality = new Float32Array(n);
  const missing = new Uint8Array(n);
  const shapeCounts = [0, 0];
  const windowValues = [];

  let i = 0;
  for (let r = 1; r < moduleRows; r++) {
    for (let c = 1; c < moduleCols; c++, i++) {
      const value = values[i];
      windowValues.length = 0;
      let timingSamples = 0;
      for (let wy = -Math.floor(WINDOW / 2); wy <= Math.floor(WINDOW / 2); wy++) {
        const yy = Math.min(moduleRows - 1, Math.max(0, r + wy));
        for (let wx = -Math.floor(WINDOW / 2); wx <= Math.floor(WINDOW / 2); wx++) {
          const xx = Math.min(moduleCols - 1, Math.max(0, c + wx));
          const timing = moduleTimingLevel(xx, yy);
          if (timing !== null) {
            timingSamples++;
            windowValues.push(moduleDarkness(bitmap, layout, xx, yy, refined.ox, refined.oy));
          } else {
            windowValues.push(values[(yy - 1) * geom.cols + (xx - 1)]);
          }
        }
      }
      const local = timingSamples === 0 ? otsu(windowValues) : null;
      const threshold =
        local && local.span > MIN_LOCAL_SPAN
          ? (local.threshold + calibrated.threshold) / 2
          : calibrated.threshold;
      const level = value > threshold ? 1 : 0;
      levels[i] = level;
      shapeCounts[level]++;
      const span = Math.max(calibrated.span, local ? local.span : 0);
      const margin = span > MIN_LOCAL_SPAN ? Math.abs(value - threshold) / span : 1;
      quality[i] = Math.min(1, Math.max(0, margin * 2));
      if (span > MIN_LOCAL_SPAN && margin < ERASURE_MARGIN) missing[i] = 1;
    }
  }

  // The assembler de-interleaves levels itself. The erasure flags describe the
  // physical modules, so they must be de-interleaved here to land beside the
  // logical levels the assembler will unpack.
  const perm = interleaveTable(n, interleaveStep(n));
  const logicalMissing = applyPermute(missing, perm.inv);
  return {
    levels,
    quality,
    cellMissing: logicalMissing,
    colourAlive: true,
    shapeCounts,
    timingOffset: { x: refined.ox, y: refined.oy },
    calibratedThreshold: calibrated,
  };
}
