#!/usr/bin/env node
/**
 * tools/diag-page.mjs -- why did a page image fail to read?
 *
 * Prints the inkness distribution, the threshold Otsu chose, what a robust
 * percentile scale would have chosen instead, and how much ink each implies.
 * Written because the simulated channel produced pages measured at 25% ink
 * coverage that the decoder called `blank-image`, and no existing output said
 * which of those two claims was wrong.
 *
 *   node tools/diag-page.mjs path/to/page.png [--band]
 */
import { readFileSync } from 'node:fs';
import { decodePNG } from '../core/decode/png-read.js';
import { inkness, otsu, binarize } from '../core/decode/fiducial.js';

const file = process.argv[2];
if (!file) {
  console.log('usage: node tools/diag-page.mjs <page.png> [--band]');
  process.exit(2);
}
const bytes = new Uint8Array(readFileSync(file));
const bmp = decodePNG(bytes);
console.log(`file       ${file}`);
console.log(`size       ${bmp.width}x${bmp.height} channels=${bmp.channels} substrate=${JSON.stringify(bmp.substrate || null)}`);

const ink = inkness(bmp);
const v = ink.values;
// A deterministic subsample keeps the percentiles cheap on a 9 MB page.
const step = Math.max(1, Math.floor(v.length / 200000));
const s = [];
for (let i = 0; i < v.length; i += step) s.push(v[i]);
s.sort((a, b) => a - b);
const pct = (p) => s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
const fmt = (x) => x.toFixed(3);
console.log(`inkness    n=${s.length} p1=${fmt(pct(1))} p5=${fmt(pct(5))} p50=${fmt(pct(50))} p90=${fmt(pct(90))} p99=${fmt(pct(99))} p99.9=${fmt(pct(99.9))} max=${fmt(v.length ? s[s.length - 1] : 0)}`);

const thr = otsu(ink);
const bin = binarize(bmp);
console.log(`otsu       threshold=${fmt(thr)}  inkCount=${bin.inkCount} (${((bin.inkCount / v.length) * 100).toFixed(2)}% of pixels)`);

// --markers:解剖角标检测。打印四个最大方形候选的尺寸、中心探到的墨比例与
// hasHole 的判据(<0.35)，这样 "no-hollow-corner" 能立刻分辨是"洞被糊住"还是
// "探针位置不对/候选根本不是角标"。
if (process.argv.includes('--markers')) {
  const F = await import('../core/decode/fiducial.js');
  const bin = F.binarize(bmp);
  const region = F.pageRegion(bin);
  // cropMask is private, and on these pages the paper nearly fills the frame, so
  // the uncropped mask is a faithful stand-in for diagnosis purposes.
  const sq = F.keepCandidateSquares(F.components(bin), region);
  sq.sort((a, b) => b.w - a.w);
  console.log(`region     ${JSON.stringify(region && { x: region.x, y: region.y, w: region.w, h: region.h })}`);
  console.log(`squares    ${sq.length} (top 8, probe = 0.12*min(w,h), hole if centerInk < 0.35)`);
  const { width } = bin;
  for (const c of sq.slice(0, 8)) {
    const cx = Math.round(c.cx);
    const cy = Math.round(c.cy);
    const probe = Math.max(1, Math.round(Math.min(c.w, c.h) * 0.12));
    let inside = 0;
    let total = 0;
    for (let dy = -probe; dy <= probe; dy++) {
      for (let dx = -probe; dx <= probe; dx++) {
        total++;
        if (bin.mask[(cy + dy) * width + cx + dx]) inside++;
      }
    }
    // c.fill is the component's own area/bbox ratio, already computed by
    // components(): a solid square is 1.00, a ring of one-cell wall is 8/9.
    console.log(`  ${c.w}x${c.h} @${c.x0},${c.y0} fill=${c.fill.toFixed(2)} aspect=${c.aspect.toFixed(2)} probe=${probe}px centerInk=${(inside / total).toFixed(3)} -> ${inside / total < 0.35 ? 'HOLLOW' : 'solid'}`);
  }
  const anchors = [];
  const sorted = sq.slice().sort((a, b) => b.w - a.w);
  for (let i = 0; i < sorted.length && anchors.length < 6; i++) {
    const w = sorted[i].w;
    if (i > 0 && Math.abs(w - sorted[i - 1].w) <= sorted[i - 1].w * 0.3) continue;
    const m = sq.filter((c) => Math.abs(c.w - w) <= w * 0.3);
    if (m.length >= 4) anchors.push(`${w}:${m.length}`);
  }
  console.log(`clusters   >=4 members, largest first: ${anchors.join(' ')}`);
  const fm = F.findMarkers(bmp);
  console.log(`findMarkers ${JSON.stringify({ ok: fm.ok, reason: fm.reason, candidates: fm.candidates, markerPx: fm.markerPx, thresholdFactor: fm.thresholdFactor })}`);
}

// What a robust scale implies: the same Otsu machinery, but the histogram axis is

// pinned to a high percentile instead of the maximum, so one bright artifact
// cannot stretch it.
for (const p of [99, 99.9, 99.99]) {
  const cap = pct(p);
  const hist = new Uint32Array(64);
  let n = 0;
  for (let i = 0; i < v.length; i += step) {
    let b = Math.floor((Math.min(v[i], cap) / (cap || 1)) * 63);
    if (b > 63) b = 63;
    hist[b]++;
    n++;
  }
  let sum = 0;
  for (let b = 0; b < 64; b++) sum += b * hist[b];
  let sumB = 0;
  let wB = 0;
  let best = -1;
  let t = 0;
  for (let b = 0; b < 64; b++) {
    wB += hist[b];
    if (wB === 0) continue;
    const wF = n - wB;
    if (wF === 0) break;
    sumB += b * hist[b];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) {
      best = between;
      t = b;
    }
  }
  const thrP = (t / 63) * cap;
  let cnt = 0;
  for (let i = 0; i < v.length; i += step) if (v[i] > thrP) cnt++;
  console.log(`pct-${p.toString().padEnd(5)} cap=${fmt(cap)} threshold=${fmt(thrP)} ink=${((cnt / n) * 100).toFixed(2)}%`);
}
