#!/usr/bin/env node
/**
 * Population baseline for the readout-sanity gate, measured before any threshold exists.
 *
 * Round 19 found four pages whose cell readout collapses (one page read 287 507 of
 * 287 507 cells as a single symbol). The tempting fix is "reject a page whose symbol
 * distribution looks impossible" -- but this project has already been burned twice by
 * choosing a threshold from the failures it was meant to catch (the 0.65 Otsu factor,
 * the 1.0 area denominator). A healthy page of this payload is NOT near-uniform: the
 * test payload is a repeating pattern, deflate shrinks it hard, so most cells are
 * padding and one symbol legitimately dominates. Any number picked from four bad pages
 * would therefore be fiction.
 *
 * So this tool measures the good population first: for every page of every corpus it
 * prints the readout's max symbol fraction, distinct symbol count, and what eventually
 * happened to the page. Only with that distribution in hand can a cut be set that
 * cannot fire on a healthy page -- and if the distributions overlap, the honest answer
 * is that this criterion does not work at all and something else is needed.
 *
 *   node tools/diag-symbol-population.mjs --root .tmp --match 'nc-scan*'
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { decodePage } from '../core/decode/page.js';
import { decodePNG } from '../core/decode/png-read.js';
import { planPage } from '../core/profiles.js';
import { pageLayout } from '../core/render/layout.js';
import { getPalette } from '../core/palette.js';

const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const root = opt('--root', '.tmp');
const match = opt('--match', '*');
const re = new RegExp(`^${String(match).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);

const dirs = readdirSync(root).filter((n) => {
  if (!re.test(n)) return false;
  const p = join(root, n);
  try {
    return statSync(p).isDirectory() && existsSync(join(p, 'manifest.json')) && readdirSync(p).some((f) => /\.png$/i.test(f));
  } catch {
    return false;
  }
}).sort();
if (!dirs.length) {
  console.error(`no corpora matched ${match} under ${root}`);
  process.exit(2);
}

const rows = [];
for (const name of dirs) {
  const dir = join(root, name);
  const mf = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  if (!mf.profile) continue;
  let geom;
  let layout;
  try {
    geom = planPage(mf.profile, { nozzle: mf.nozzle, plateMm: mf.plateMm, monoSafe: mf.monoSafe });
    layout = pageLayout(geom, mf.dpi, { plateMm: mf.plateMm });
  } catch (e) {
    rows.push({ dir: name, page: '-', note: `plan refused: ${e.message.slice(0, 40)}` });
    continue;
  }
  const paletteId = mf.palette || 'INK2';
  for (const f of readdirSync(dir).filter((n) => /\.png$/i.test(n)).sort()) {
    let cell;
    let ib = null;
    try {
      const bmp = decodePNG(new Uint8Array(readFileSync(join(dir, f))));
      bmp.substrate = bmp.substrate || getPalette(paletteId).background;
      const r = decodePage(bmp, { geom, layout, paletteId }, { allowFastPath: false, requireFastPath: false, log: null });
      if (!r.ok) {
        rows.push({ dir: name, page: f, note: `${r.stage}/${r.reason}` });
        continue;
      }
      cell = r.levels;
      ib = r.inkBalance || null;
    } catch (e) {
      rows.push({ dir: name, page: f, note: `error ${e.message.slice(0, 30)}` });
      continue;
    }
    const hist = new Map();
    for (const v of cell) hist.set(v, (hist.get(v) || 0) + 1);
    let maxV = null;
    let maxN = -1;
    for (const [v, n] of hist) if (n > maxN) { maxN = n; maxV = v; }
    rows.push({
      dir: name,
      page: f,
      cells: cell.length,
      distinct: hist.size,
      maxFrac: maxN / cell.length,
      maxSym: maxV,
      // The second-most-common symbol matters as much: a real page has structure, a
      // collapsed one has one spike and nothing else.
      secondFrac: [...hist.values()].sort((a, b) => b - a)[1] / cell.length || 0,
      // Ink balance: measured coverage over claimed coverage. Unlike the two columns
      // above it does not depend on how compressible the payload is (round 20).
      inkRatio: ib && Number.isFinite(ib.ratio) ? ib.ratio : null,
      misfitFrac: ib && Number.isFinite(ib.misfitFrac) ? ib.misfitFrac : null,
      inkCells: ib ? ib.cells : 0,
    });
  }
}

const read = rows.filter((r) => r.distinct);
console.log(`pages read: ${read.length} of ${rows.length} (others failed before cell readout)`);
const fr = read.map((r) => r.maxFrac).sort((a, b) => a - b);
const pct = (p) => (fr.length ? fr[Math.min(fr.length - 1, Math.floor(p * fr.length))] : NaN);
console.log(`max-symbol fraction across the good population:`);
console.log(`  min ${pct(0).toFixed(4)}  p50 ${pct(0.5).toFixed(4)}  p90 ${pct(0.9).toFixed(4)}  p99 ${pct(0.99).toFixed(4)}  max ${pct(1).toFixed(4)}`);
const ds = read.map((r) => r.distinct).sort((a, b) => a - b);
console.log(`  distinct symbols: min ${ds[0]} p50 ${ds[Math.floor(ds.length / 2)]} max ${ds[ds.length - 1]}`);
const worst = [...read].sort((a, b) => b.maxFrac - a.maxFrac).slice(0, 10);
console.log(`  the ten most collapsed-looking pages (this is the candidate set a threshold would have to spare):`);
for (const r of worst) {
  console.log(`    ${r.maxFrac.toFixed(4)} distinct=${String(r.distinct).padStart(3)} 2nd=${r.secondFrac.toFixed(4)} ${r.dir}/${r.page}`);
}
const sf = read.map((r) => r.secondFrac).sort((a, b) => a - b);
console.log(`  second-symbol fraction: min ${sf[0].toFixed(4)} p50 ${sf[Math.floor(sf.length / 2)].toFixed(4)} max ${sf[sf.length - 1].toFixed(4)}`);

// The ink-balance candidate. This is the one that should not care about payload
// compressibility, so its healthy spread is the number that decides whether it can
// become a gate at all -- measure first, threshold second (round 20's lesson).
const ink = read.filter((r) => Number.isFinite(r.inkRatio));
const q = (arr, p) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(p * arr.length))] : NaN);
const ir = ink.map((r) => r.inkRatio).sort((a, b) => a - b);
const mf2 = ink.map((r) => r.misfitFrac).sort((a, b) => a - b);
console.log(`ink balance across ${ink.length} pages (measured coverage / claimed coverage):`);
console.log(`  ratio  min ${q(ir, 0).toFixed(4)} p50 ${q(ir, 0.5).toFixed(4)} p90 ${q(ir, 0.9).toFixed(4)} p99 ${q(ir, 0.99).toFixed(4)} max ${q(ir, 1).toFixed(4)}`);
console.log(`  misfit frac (cells off by >0.5 rel) min ${q(mf2, 0).toFixed(4)} p50 ${q(mf2, 0.5).toFixed(4)} p90 ${q(mf2, 0.9).toFixed(4)} max ${q(mf2, 1).toFixed(4)}`);
const byMisfit = [...ink].sort((a, b) => b.misfitFrac - a.misfitFrac).slice(0, 10);
console.log(`  ten pages with the worst ink misfit:`);
for (const r of byMisfit) console.log(`    misfit=${r.misfitFrac.toFixed(4)} ratio=${r.inkRatio.toFixed(4)} maxFrac=${r.maxFrac.toFixed(4)} ${r.dir}/${r.page}`);
console.log('  -> if the ten above include pages that assembled fine, max-fraction alone cannot be the gate;');
console.log('     second-symbol fraction is reported for the same reason: a genuine page keeps a tail, a');
console.log('     constant-output collapse has none at all.');
