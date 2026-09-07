#!/usr/bin/env node
/**
 * Where does a page actually go wrong? Per-cell error map against a clean read.
 *
 * Motivation: `assemble/intra-fail` recurs on roughly nine 600 dpi pages across eight
 * seeds, never at 300 dpi, and it is neither the out-of-frame effect nor the echo
 * strip. Before any theory about why, the question is where the wrong cells are --
 * illumination and focus failures cluster in a region, sampling and moire spread out,
 * a mis-registered grid puts errors along a line. One screenful answers which.
 *
 * Ground truth comes from the same reader on the pristine render of the same page
 * (not from the encoder's idea of the levels), so the comparison measures the channel
 * and the front end together, which is exactly the pair under suspicion. The pristine
 * read is trusted because the ideal path is what G1 verified at 2 692 800 cells.
 *
 *   node tools/diag-intra.mjs --degraded .tmp/nc-scan600-11/page-001.png \
 *                             --pristine .tmp/sw-scan600-src/page-001.png \
 *                             --profile P-M1-600 --dpi 600
 *
 * How this tool earned its current shape (all three mistakes were mine, all found by
 * measurement rather than by thinking harder):
 *   1. levels are packed NUMBERS, so comparing `.shape`/`.colour` gave `undefined` on
 *      both sides and announced "0 mismatches" on pages that fail assembly. Void result.
 *   2. The channel-split section then compared `NaN !== NaN` -- wrong in the opposite
 *      direction. It now normalises through symOf/asLevel.
 *   3. It hardcoded --nozzle 0.4 and palette INK2 while these corpora declare
 *      `nozzle: null` and `palette: PAPER1`. Wrong substrate/background flips most colour
 *      decisions, which is where the "88 % of cells disagree" number came from -- about a
 *      corpus that decodes at 93.8 %, i.e. fiction presented as a measurement.
 * The read configuration now comes from the manifest and the tool refuses to guess.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodePNG } from '../core/decode/png-read.js';
import { decodePage } from '../core/decode/page.js';
import { planPage } from '../core/profiles.js';
import { pageLayout } from '../core/render/layout.js';
import { getPalette } from '../core/palette.js';

const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const degradedPath = opt('--degraded');
const pristinePath = opt('--pristine');
if (!degradedPath || !pristinePath) {
  console.log('usage: node tools/diag-intra.mjs --degraded F --pristine F [--manifest DIR] [--profile P --dpi N]');
  process.exit(2);
}

/**
 * Read configuration comes from the corpus manifest, never from a guess.
 *
 * The first version of this tool hardcoded `--nozzle 0.4` and `palette INK2`, while the
 * corpora declare `nozzle: null` and `palette: PAPER1`. On a paper page the palette
 * decides which ink is background and which is the colour channel, so getting it wrong
 * misreads roughly two thirds of the packed cell values -- and this tool then announced
 * "88 % of cells disagree with the clean read" about a corpus that decodes at 93.8 %.
 * A diagnostic that invents its own read configuration is worse than no diagnostic,
 * because its numbers look like measurements. If no manifest is found, this refuses.
 */
function readManifest(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  } catch {
    return null;
  }
}
const manifestDir = opt('--manifest') || degradedPath.replace(/[\\/][^\\/]+$/, '');
const mf = readManifest(manifestDir);
if (!mf && !(opt('--profile') && opt('--dpi'))) {
  console.error(`diag-intra: no manifest.json in ${manifestDir} and no explicit --profile/--dpi.`);
  console.error('  Refusing to guess the read configuration -- a wrong palette here silently');
  console.error('  misreads most of the page and the resulting error map is fiction.');
  process.exit(2);
}
const profileId = opt('--profile') || mf.profile;
const dpi = Number(opt('--dpi') || mf.dpi);
const nozzle = mf ? mf.nozzle : (opt('--nozzle') ? Number(opt('--nozzle')) : null);
const paletteId = opt('--palette') || (mf && mf.palette) || 'INK2';
const monoSafe = mf ? mf.monoSafe : undefined;
const plateMm = mf ? mf.plateMm : undefined;
console.log(`read config: profile=${profileId} dpi=${dpi} palette=${paletteId} nozzle=${nozzle} monoSafe=${monoSafe}${mf ? ' (manifest)' : ' (explicit flags, no manifest)'}`);
if (mf && mf.printedAreaFraction !== undefined) {
  // The manifest declares how much of the page it printed. Worth echoing: any measure
  // of ink on the page should agree with this number, and it costs nothing to check.
  console.log(`manifest printedAreaFraction = ${mf.printedAreaFraction}`);
}

const geom = planPage(profileId, { nozzle, plateMm, monoSafe });
const layout = pageLayout(geom, dpi, { plateMm });
const opts = { allowFastPath: false, requireFastPath: false, log: null };

function read(path) {
  const bmp = decodePNG(new Uint8Array(readFileSync(path)));
  bmp.substrate = bmp.substrate || getPalette(paletteId).background;
  const r = decodePage(bmp, { geom, layout, paletteId }, opts);
  if (!r.ok) {
    console.error(`${path}: read failed at ${r.stage}/${r.reason}`);
    process.exit(1);
  }
  return { r, bmp };
}

const clean = read(pristinePath);
const dirty = read(degradedPath);
const a = clean.r.levels;
const b = dirty.r.levels;
if (a.length !== b.length) {
  console.error(`level length differs: pristine ${a.length} degraded ${b.length}`);
  process.exit(1);
}
const cols = geom.cols;
const rows = geom.rows;
const wrong = [];
// Compare by canonical string, not by `.shape`/`.colour`. When levels are packed
// numbers those properties are undefined on BOTH sides, `undefined !== undefined`
// is false, and the tool reports a perfect 0 mismatches while the page is in fact
// failing assembly -- a vacuous comparison, which is the sixth time this project has
// produced one and the first time it was inside a diagnostic built to find errors.
const symOf = (v) => (v && typeof v === 'object' ? `${v.shape}/${v.colour ?? 0}` : String(v));
const levelType = a.length ? `${typeof a[0]} ${a[0] && typeof a[0] === 'object' ? `keys:${Object.keys(a[0]).join(',')}` : JSON.stringify(a[0])}` : 'empty';
console.log(`levels[0] is ${levelType}`);
for (let i = 0; i < a.length; i++) {
  if (symOf(a[i]) !== symOf(b[i])) wrong.push(i);
}
const asLevel = (v) => (v && typeof v === 'object' ? v : { shape: NaN, colour: NaN });
console.log(`page cells ${cols}x${rows} = ${a.length}`);
console.log(`degraded read: ok at path=${dirty.r.path} markerPx=${Math.round(dirty.r.markerPx)} coverage=${(100 * (dirty.r.coverage ?? 0)).toFixed(1)}%`);
console.log(`MISMATCH CELLS: ${wrong.length} (${((100 * wrong.length) / a.length).toFixed(2)}%)`);
if (!wrong.length) {
  console.log('  -> the front end reads this page perfectly; intra-fail cannot come from cells.');
  process.exit(0);
}

// Two cheap tests that separate "the ink was destroyed" from "the grid phase is wrong".
// (a) symbol histograms: a shift or permutation preserves the distribution, photometric
//     damage does not.
// (b) mismatch under whole-cell shifts: if some offset collapses the disagreement, the
//     rectification landed on the wrong cell and nothing about the ink is at fault.
const hist = (arr) => {
  const h = new Map();
  for (const v of arr) h.set(symOf(v), (h.get(symOf(v)) || 0) + 1);
  return h;
};
const ha = hist(a);
const hb = hist(b);
const sameHist = ha.size === hb.size && [...ha].every(([k, v]) => hb.get(k) === v);
console.log(`symbol histogram: pristine ${ha.size} distinct, degraded ${hb.size} distinct -> ${sameHist ? 'IDENTICAL (content preserved, order is what differs)' : 'DIFFERENT (ink pattern itself changed)'}`);
if (!sameHist) {
  const top = (h) => [...h.entries()].sort((x, y) => y[1] - x[1]).slice(0, 5).map(([k, v]) => `${k}:${v}`).join(' ');
  console.log(`  pristine top5: ${top(ha)}`);
  console.log(`  degraded top5: ${top(hb)}`);
}
const mismatchAt = (dc, dr) => {
  let k = 0;
  let tot = 0;
  for (let r = 0; r < rows; r++) {
    const rr = r + dr;
    if (rr < 0 || rr >= rows) continue;
    for (let c = 0; c < cols; c++) {
      const cc = c + dc;
      if (cc < 0 || cc >= cols) continue;
      tot++;
      if (symOf(a[rr * cols + cc]) !== symOf(b[r * cols + cc])) k++;
    }
  }
  return { k, tot, pct: tot ? (100 * k) / tot : NaN };
};
const base = mismatchAt(0, 0);
console.log(`  phase scan (cells): offset 0,0 -> ${base.pct.toFixed(2)}%`);
const candidates = [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, 1], [-2, 0], [2, 0], [0, -2], [0, 2]];
let best = { pct: base.pct, dc: 0, dr: 0 };
for (const [dc, dr] of candidates) {
  const r = mismatchAt(dc, dr);
  const flag = r.pct < best.pct ? ' <-- best' : '';
  if (r.pct < best.pct) best = { pct: r.pct, dc, dr };
  console.log(`  offset ${dc},${dr} -> ${r.pct.toFixed(2)}%${flag}`);
}
console.log(best.pct < base.pct / 2
  ? `  -> mismatch collapses at offset ${best.dc},${best.dr}: GRID PHASE error, the ink is fine`
  : `  -> no whole-cell offset helps: the disagreement is not a simple phase shift`);
let shapeErr = 0;
let colourErr = 0;
const shapeDelta = new Map();
for (const i of wrong) {
  const sa = asLevel(a[i]).shape;
  const sb = asLevel(b[i]).shape;
  if (sa !== sb) shapeErr++;
  if (asLevel(a[i]).colour !== asLevel(b[i]).colour) colourErr++;
  const d = Math.abs((sa ?? 0) - (sb ?? 0));
  shapeDelta.set(Number.isFinite(d) ? d : '?', (shapeDelta.get(Number.isFinite(d) ? d : '?') || 0) + 1);
}
console.log(`  by channel: shape ${shapeErr}, colour ${colourErr} (a cell can hit both)`);
console.log(`  shape distance histogram: ${[...shapeDelta.entries()].sort().map(([k, v]) => `${k}:${v}`).join(' ')}`);

// Spatial map: is it a region, a band, or spread out?
const BX = 44;
const BY = 44;
const grid = Array.from({ length: BY }, () => new Array(BX).fill(0));
const rowCount = new Array(rows).fill(0);
const colCount = new Array(cols).fill(0);
for (const i of wrong) {
  const c = i % cols;
  const r = Math.floor(i / cols);
  grid[Math.floor((r * BY) / rows)][Math.floor((c * BX) / cols)]++;
  rowCount[r]++;
  colCount[c]++;
}
let out = '  error map (# = 1 cell, then A-Z, 0 = clean):\n    ';
for (let r = 0; r < BY; r++) {
  let line = '';
  for (let c = 0; c < BX; c++) {
    const v = grid[r][c];
    line += v === 0 ? ' ' : v === 1 ? '#' : v < 36 ? '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'[v - 2] : 'Z';
  }
  out += `\n    ${line}`;
}
console.log(out);
const top = (arr, n) => arr.map((v, i) => [v, i]).sort((x, y) => y[0] - x[0]).slice(0, n);
console.log(`  densest cell-rows: ${top(rowCount, 6).map(([v, i]) => `r${i}:${v}`).join(' ')}`);
console.log(`  densest cell-cols: ${top(colCount, 6).map(([v, i]) => `c${i}:${v}`).join(' ')}`);
// Quadrant + radial summary: an illumination/focus falloff shows up as a gradient.
const quad = { tl: 0, tr: 0, bl: 0, br: 0 };
for (const i of wrong) {
  const c = i % cols;
  const r = Math.floor(i / cols);
  quad[`${r < rows / 2 ? 't' : 'b'}${c < cols / 2 ? 'l' : 'r'}`]++;
}
console.log(`  quadrants: tl=${quad.tl} tr=${quad.tr} bl=${quad.bl} br=${quad.br}`);
const spread = wrong.map((i) => [i % cols, Math.floor(i / cols)]);
const meanC = spread.reduce((s, p) => s + p[0], 0) / spread.length;
const meanR = spread.reduce((s, p) => s + p[1], 0) / spread.length;
const sd = Math.sqrt(spread.reduce((s, p) => s + (p[0] - meanC) ** 2 + (p[1] - meanR) ** 2, 0) / spread.length);
console.log(`  error centroid (col ${meanC.toFixed(1)}, row ${meanR.toFixed(1)}) of grid ${cols}x${rows}, radial sd ${sd.toFixed(1)} cells`);
console.log(`  uniform spread would give sd ~${(Math.sqrt((cols * cols + rows * rows) / 6) / 2).toFixed(1)} cells`);
