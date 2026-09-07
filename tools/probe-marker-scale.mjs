#!/usr/bin/env node
/**
 * At which capture scales does the corner detector lose the page, and does it lose it
 * monotonically?
 *
 * Written because a plausible fix was about to be built on an unmeasured signal: the plan
 * was to split the overloaded `no-hollow-corner` reason by declaring a marker pixel floor,
 * which is exactly what a phone UI needs ("move closer"). Measuring first killed that idea.
 * Shrinking one printed page shows the detector recovering the quad at 105 and 120 dpi while
 * failing at 150 dpi -- non-monotonic, so no floor can separate the cases, and the largest
 * blob side read 15 px in one failure and 9 px in another, i.e. it is not a marker size at
 * all (a merged data cluster is bigger than a marker). Recorded as D24 (corrected) and D26.
 *
 * This is a synthetic scale ladder on a clean downscale -- no blur, no noise, no JPEG -- so
 * it says nothing about G4's photographic grades; it only pins the interaction below.
 *
 *   node tools/probe-marker-scale.mjs [--profile P-M1-300] [--scales 1,0.7,0.5,0.4,0.35,0.3,0.25]
 */
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(join(ROOT, p)).href);
const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const profile = opt('--profile', 'P-M1-300');
const scales = String(opt('--scales', '1,0.7,0.5,0.4,0.35,0.3,0.25')).split(',').map(Number);

const { encodeTransfer } = await imp('core/protocol.js');
const { pageLayout } = await imp('core/render/layout.js');
const { renderPageBitmap, echoBitsOf } = await imp('core/render/raster.js');
const { findMarkers, binarize, components, pageRegion, cropMask, keepCandidateSquares } = await imp('core/decode/fiducial.js');
const { sampleBilinear } = await imp('core/decode/transform.js');

const raw = new Uint8Array(512).map((_, i) => (i * 7 + 3) & 0xff);
const t = await encodeTransfer(raw, { profile });
const dpi = 300;
const layout = pageLayout(t.geom, dpi, { sheetMm: t.geom.sheetMm });
const src = renderPageBitmap({ geom: t.geom, levels: t.pages[0].levels, layout, palette: 'PAPER1', echoBits: echoBitsOf(t.pages[0].header) });
const ch = Math.round(src.pixels.length / (src.width * src.height));

function shrink(f) {
  const w = Math.floor(src.width * f);
  const h = Math.floor(src.height * f);
  const out = new Uint8Array(w * h * ch);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = sampleBilinear(src.pixels, src.width, src.height, ch, x / f, y / f);
      for (let c = 0; c < ch; c++) out[(y * w + x) * ch + c] = v.values[c];
    }
  }
  return { width: w, height: h, dpi: Math.round(dpi * f), pixels: out };
}

// Where the detector's hollow test actually stands at each scale. The shipped test uses a
// probe window whose radius is round(0.12 * side) -- an integer that jumps a level as the
// marker shrinks -- so the hole can be sampled with a 5x5 window at one scale and a 3x3 at
// the next, which is the candidate explanation for the non-monotonicity above. This prints
// the ink fraction of the marker's centre region for every probe radius so the claim is a
// reading, not an inference: a small window inside the hole, a window that also catches the
// ring, and the threshold the shipped predicate compares against (0.35).
let keysLogged = false;
function explain(f) {
  const bmp = f === 1 ? src : shrink(f);
  const bin = binarize(bmp, {});
  const region = pageRegion(bin);
  // cropMask returns a bare Uint8Array (and sets region.cropInset as a side effect), while
  // components wants the bin-shaped object -- the first draft passed the mask straight
  // through and died reading .length on undefined, in the probe rather than in the client.
  const cropped = { ...bin, mask: cropMask(bin, region) };
  const comps = keepCandidateSquares(components(cropped), region);
  const big = comps.slice().sort((a, b) => b.area - a.area).slice(0, 4);
  const holeFraction = (c, r) => {
    // Component field names are read tolerantly: this probe walks the exported steps and
    // must not depend on a shape I have not verified (guessing them is the failure mode
    // that has cost a round here more than once).
    const x0 = c.x0 ?? c.x ?? 0;
    const x1 = c.x1 ?? x0 + (c.w ?? 0) - 1;
    const y0 = c.y0 ?? c.y ?? 0;
    const y1 = c.y1 ?? y0 + (c.h ?? 0) - 1;
    const cx = Math.floor((x0 + x1) / 2);
    const cy = Math.floor((y0 + y1) / 2);
    let ink = 0;
    let tot = 0;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= cropped.width || y >= cropped.height) continue;
        tot++;
        if (cropped.mask[y * cropped.width + x]) ink++;
      }
    }
    return tot ? ink / tot : 1;
  };
  const fm = findMarkers(bmp, {});
  console.log(`\n scale ${f.toFixed(2)}: ${comps.length} 个方形候选 · findMarkers ${fm.ok ? 'FOUND' : 'FAIL ' + fm.reason}`);
  // findMarkers already reports what it tried (fiducial.js clustersTried): one entry per
  // corner-cluster hypothesis, with the reason each attempt gave. That is the difference
  // between "the geometry is wrong" and "the detector never looked at the right set".
  for (const tr of fm.clustersTried || []) console.log(`   cluster ${tr.clusterPx}px -> ${tr.reason} hollow=${tr.hollowCount}`);
  for (const c of big) {
    const side = Math.min(c.w, c.h);
    const probeNow = Math.max(1, Math.round(side * 0.12));
    console.log(
      `   blob ${c.w}x${c.h} area=${c.area} [${Object.keys(c).slice(0, 6).join('|')}] 探针(现)=${probeNow} · 中心着墨率 r1=${holeFraction(c, 1).toFixed(2)} r2=${holeFraction(c, 2).toFixed(2)} r3=${holeFraction(c, 3).toFixed(2)} (空心判据 <0.35)`,
    );
  }
}

if (args.includes('--explain')) {
  for (const f of scales) explain(f);
  process.exit(0);
}

let prev = null;
const flips = [];
for (const f of scales) {
  const bmp = f === 1 ? src : shrink(f);
  const r = findMarkers(bmp, {});
  const found = !!r.ok;
  console.log(
    `scale ${f.toFixed(2)}  等效 ${String(Math.round(dpi * f)).padStart(3)}dpi  格边≈${(layout.cellPx * f).toFixed(1)}px  ${found ? 'FOUND   ' : 'FAIL    '} ${found ? '' : r.reason}${r.maxBlobSide !== undefined ? ` · maxBlobSide=${r.maxBlobSide} hollow=${r.hollowCount} cand=${r.candidates}` : ''}`,
  );
  if (prev && prev.found !== found) flips.push(`${prev.f}dpi ${prev.found ? 'FOUND' : 'FAIL'} -> ${f}dpi ${found ? 'FOUND' : 'FAIL'}`);
  prev = { f, found };
}
console.log('');
if (flips.length > 1) {
  console.log(`NON-MONOTONIC: 结果随尺度反复翻转 ⇒ 不能用任何像素阈值拆 reason，这是二值化/候选选择与该尺度的交互缺陷：`);
  flips.forEach((x) => console.log(`  ${x}`));
  process.exitCode = 2;
} else if (flips.length === 1) {
  console.log(`单一切点 ${flips[0]} ⇒ 存在可命名的分辨率地板，可据此拆 reason`);
} else {
  console.log('全表一致 ⇒ 本探针范围内无分辨率效应');
}
