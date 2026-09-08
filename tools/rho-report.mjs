#!/usr/bin/env node
/**
 * rho-report -- why does a page's level readout collapse? Measure rho against the truth.
 *
 * Context (DEFECTS D51): at 600 dpi some pages read every cell as one single level. `tools/level-diff.mjs`
 * established THAT; this tool asks WHY, and specifically asks the question that decides which fix can
 * work. ideal.js already documents the suspected mechanism (its comment near "rhoSum/targetSum came out
 * 1.0651-1.0660 on pristine renders and 3.6-21.7 on channel pages at 600 dpi"): blur sigma is fixed in
 * mm, so at double the dpi it is twice as wide in cells, ink bleeds across the fixed measurement windows,
 * and rho inflates until a padding cell crosses the boundary that separates level 0 from level 1.
 * sim/selfcheck.py states the design consequence (near line 808): if the rho table is re-measured on the
 * captured page, a *systematic* shift of every rho costs a decoder nothing.
 *
 * So the number that matters is not "how far did rho move" but "how much cell error remains at the BEST
 * per-page cut", because that is the ceiling of the re-measure-the-table fix:
 *
 *   bestCutErr  << (nsym/2)/(k+nsym)  => per-page recalibration can work: RS absorbs what is left.
 *   bestCutErr  >= that               => no cut of this statistic separates the levels on this page, so
 *                                        recalibrating the table cannot save it; the measurement windows
 *                                        (or the pitch) have to change instead.
 *
 * Ground truth comes from the pristine render of the same page (the input to sim/channel.py), whose own
 * readout is taken as truth. Levels are the joined shape+colour values; the majority group is labelled
 * "0-like" and the minority "1-like", which is safe for these payloads (the level histograms measured in
 * round 61 were 0=256118 / 1=27037, so majority == level 0) and is printed so the assumption is visible.
 *
 * This mirrors core/decode/page.js:41-63 (findMarkers -> rectifyPage -> readPageIdeal) because decodePage
 * does not expose per-cell rho. To keep that mirror honest it also runs decodePage on the same bitmap and
 * compares the resulting level arrays, so drift would appear as a mismatch instead of silently biasing
 * every number below. Pass --no-cross-check to skip that second decode.
 *
 * Measurement only, not a gate: exit 0 means the comparison ran. Exit 1 means it could not (missing
 * files, a page that would not decode, or level arrays that disagree with the geometry).
 *
 * Usage: node tools/rho-report.mjs <pristineDir> <channelDir> <pages> [--no-cross-check]
 *   e.g. node tools/rho-report.mjs .tmp/g2src-a4-600 .tmp/sc-scan600-11 0,1
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { decodePNG } from '../core/decode/png-read.js';
import { decodePage } from '../core/decode/page.js';
import { findMarkers } from '../core/decode/fiducial.js';
import { rectifyPage } from '../core/decode/warp.js';
import { readPageIdeal } from '../core/decode/ideal.js';
import { levelFromRho } from '../core/render/glyphs.js';
import { planPage } from '../core/profiles.js';
import { pageLayout } from '../core/render/layout.js';
import { getPalette } from '../core/palette.js';

const argv = process.argv.slice(2);
const crossCheck = !argv.includes('--no-cross-check');
const pos = argv.filter((a) => !a.startsWith('--'));
const [pristineDir, channelDir, pagesArg] = pos;
if (!pristineDir || !channelDir || !pagesArg) {
  console.error('usage: node tools/rho-report.mjs <pristineDir> <channelDir> <pages> [--no-cross-check]');
  process.exit(1);
}
const pages = pagesArg.split(',').map((s) => Number(s.trim()));
const pageName = (i) => `page-${String(i).padStart(3, '0')}.png`;

function ctxOf(dir) {
  const mp = join(dir, 'manifest.json');
  if (!existsSync(mp)) throw new Error(`${mp} is missing -- expected a pskit send output`);
  const man = JSON.parse(readFileSync(mp, 'utf8'));
  const geom = planPage(man.profile, { nozzle: man.nozzle, plateMm: man.plateMm, monoSafe: man.monoSafe });
  const layout = pageLayout(geom, man.dpi, { plateMm: man.plateMm });
  return { man, geom, layout, paletteId: man.palette || 'INK2' };
}

function bitmap(dir, i, paletteId) {
  const p = join(dir, pageName(i));
  if (!existsSync(p)) throw new Error(`${p} does not exist`);
  const bm = decodePNG(new Uint8Array(readFileSync(p)));
  bm.substrate = bm.substrate || getPalette(paletteId).background;
  return bm;
}

const pct = (sorted, q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))] : NaN);
const f4 = (x) => (Number.isFinite(x) ? x.toFixed(4) : 'n/a');

const pctx = ctxOf(pristineDir);
const cctx = ctxOf(channelDir);
if (pctx.man.profile !== cctx.man.profile || pctx.man.dpi !== cctx.man.dpi) {
  console.error(`rho-report: pristine ${pctx.man.profile}@${pctx.man.dpi} vs channel ${cctx.man.profile}@${cctx.man.dpi} -- not the same transfer`);
  process.exit(1);
}
console.log(
  `pristine ${pristineDir} / channel ${channelDir}: profile ${pctx.man.profile} dpi ${pctx.man.dpi} cellPx ${pctx.layout.cellPx} cols ${pctx.geom.cols} rows ${pctx.geom.rows}` +
    ` intra RS k=${pctx.geom.ecc.intra.k} nsym=${pctx.geom.ecc.intra.nsym}`,
);
const nSym = pctx.geom.ecc.intra.k + pctx.geom.ecc.intra.nsym;
const rsTol = pctx.geom.ecc.intra.nsym / 2 / nSym;
console.log(
  `RS head-room: a block of ${nSym} symbols absorbs ${pctx.geom.ecc.intra.nsym / 2} symbol errors => ${(rsTol * 100).toFixed(2)}% cell error rate is the ceiling for "recalibrate the table and let RS finish the job"`,
);

let aborted = false;
for (const i of pages) {
  console.log(`\n--- page ${i} ---`);
  // Ground truth: the pristine render's own readout.
  let truth;
  try {
    const r = decodePage(bitmap(pristineDir, i, pctx.paletteId), pctx, { allowFastPath: true, requireFastPath: false, log: null });
    if (!r.ok) throw new Error(`pristine page did not decode: ${r.stage}/${r.reason}`);
    truth = r.levels;
  } catch (e) {
    console.log(`  ${e.message} -- no ground truth, skipping this page`);
    aborted = true;
    continue;
  }

  // Channel page, through the same sequence page.js uses, keeping the per-cell measurements.
  let bm;
  try {
    bm = bitmap(channelDir, i, cctx.paletteId);
  } catch (e) {
    console.log(`  ${e.message} -- skipping`);
    aborted = true;
    continue;
  }
  const opts = { allowFastPath: false, requireFastPath: false, log: null };
  const found = findMarkers(bm, opts);
  if (!found.ok) {
    console.log(`  channel page failed at markers/${found.reason} -- no readout to measure`);
    continue;
  }
  const rect = rectifyPage(bm, cctx.layout, found.quad, opts);
  if (!rect.ok) {
    console.log(`  channel page failed at rectify/${rect.reason} -- no readout to measure`);
    continue;
  }
  const read = readPageIdeal(rect, cctx.layout, cctx.geom, cctx.paletteId);

  if (crossCheck) {
    const dp = decodePage(bm, cctx, opts);
    if (!dp.ok) {
      console.log(`  MIRROR CHECK FAILED: decodePage says ${dp.stage}/${dp.reason} while the mirrored path produced levels -- do not trust this page's numbers`);
      aborted = true;
      continue;
    }
    let diff = 0;
    for (let j = 0; j < dp.levels.length; j++) if (dp.levels[j] !== read.levels[j]) diff++;
    console.log(
      `  mirror check vs decodePage: ${diff} differing level(s) of ${dp.levels.length}` +
        (diff === 0 ? ' => this probe measures the product path, not a parallel one' : ' => DRIFT, numbers below are suspect'),
    );
    if (diff !== 0) aborted = true;
  }

  const th = read.thresholds;
  console.log(
    `  thresholds used by the readout: noDot ${f4(th.noDot)}  mid [${th.mid.map(f4).join(', ')}]  blob ${f4(th.blob)}` +
      `  targets [${th.targets.map(f4).join(', ')}]  calibrated=${th.calibrated}`,
  );
  console.log(
    `  inkBalance.ratio ${f4(read.inkBalance.ratio)} (rhoSum/targetSum; ~1.07 on pristine renders, 3.6-21.7 measured on 600 dpi channel pages per ideal.js)` +
      `  ratioDisagreements ${read.ratioDisagreements}  matchedFilter=${read.matchedFilter}`,
  );

  // Group cells by the pristine (true) level; majority group = 0-like.
  const groups = new Map();
  for (let j = 0; j < truth.length; j++) groups.set(truth[j], (groups.get(truth[j]) || 0) + 1);
  const ordered = [...groups.entries()].sort((a, b) => b[1] - a[1]);
  const lowKey = ordered[0][0];
  console.log(
    `  true level groups (pristine readout): ${ordered.map(([k, v]) => `${k}=${v}`).join(' ')} => label ${lowKey} as 0-like (majority), ${ordered.slice(1).map(([k]) => k).join('/')} as 1-like`,
  );
  if (ordered.length !== 2) console.log('      note: not a two-group page, so the single-cut numbers below are only indicative');

  const rhoOf = [];
  let nanRho = 0;
  const rho0 = [];
  const rho1 = [];
  const ratioHist = new Map();
  let ratioNull = 0;
  for (let j = 0; j < read.cells.length; j++) {
    const rho = read.cells[j].rho;
    if (!Number.isFinite(rho)) {
      nanRho++;
      continue;
    }
    rhoOf.push(rho);
    (truth[j] === lowKey ? rho0 : rho1).push(rho);
    const lv = levelFromRho(rho, th);
    if (lv === null) ratioNull++;
    ratioHist.set(lv, (ratioHist.get(lv) || 0) + 1);
  }
  rhoOf.sort((a, b) => a - b);
  rho0.sort((a, b) => a - b);
  rho1.sort((a, b) => a - b);
  const line = (name, s) =>
    `      ${name}: n=${s.length} p1 ${f4(pct(s, 0.01))} p5 ${f4(pct(s, 0.05))} p50 ${f4(pct(s, 0.5))} p95 ${f4(pct(s, 0.95))} p99 ${f4(pct(s, 0.99))} max ${f4(s.length ? s[s.length - 1] : NaN)}`;
  console.log(`  rho distribution (unmeasurable cells: ${nanRho})`);
  console.log(line('all cells  ', rhoOf));
  console.log(line('true 0-like', rho0));
  console.log(line('true 1-like', rho1));
  const frac = (s, t) => (s.length ? s.filter((x) => x > t).length / s.length : NaN);
  console.log(
    `      share above noDot: 0-like ${(frac(rho0, th.noDot) * 100).toFixed(2)}%  1-like ${(frac(rho1, th.noDot) * 100).toFixed(2)}%` +
      `   above blob(${f4(th.blob)}): 0-like ${(frac(rho0, th.blob) * 100).toFixed(2)}%  1-like ${(frac(rho1, th.blob) * 100).toFixed(2)}%`,
  );
  console.log(
    `  ratio-path decision alone (levelFromRho): ${[...ratioHist.entries()].sort((a, b) => String(a[0]) < String(b[0]) ? -1 : 1).map(([k, v]) => `${k}=${v}`).join(' ')}` +
      `  null(untrustworthy)=${ratioNull}`,
  );
  const finalHist = new Map();
  for (let j = 0; j < read.levels.length; j++) finalHist.set(read.levels[j], (finalHist.get(read.levels[j]) || 0) + 1);
  console.log(`  final levels after the matched filter overrode it: ${[...finalHist.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  let truthErr = 0;
  for (let j = 0; j < read.levels.length; j++) if (read.levels[j] !== truth[j]) truthErr++;
  console.log(`  final level error vs pristine truth: ${truthErr}/${read.levels.length} = ${((truthErr / read.levels.length) * 100).toFixed(3)}%`);

  // The decisive number: the best single cut on rho for THIS page, against the truth.
  const cand = [];
  const lo = rhoOf.length ? rhoOf[0] : 0;
  const hi = rhoOf.length ? rhoOf[rhoOf.length - 1] : 1;
  for (let s = 0; s <= 400; s++) cand.push(lo + ((hi - lo) * s) / 400);
  let best = { t: NaN, err: Infinity };
  for (const t of cand) {
    const e0 = rho0.filter((x) => x > t).length; // 0-like pushed above the cut
    const e1 = rho1.length - rho1.filter((x) => x > t).length; // 1-like left below it
    if (e0 + e1 < best.err) best = { t, err: e0 + e1 };
  }
  const total = rho0.length + rho1.length;
  const bestRate = total ? best.err / total : NaN;
  const fixedErr = rho0.filter((x) => x > th.mid[0]).length + (rho1.length - rho1.filter((x) => x > th.mid[0]).length);
  const fixedRate = total ? fixedErr / total : NaN;
  console.log(
    `  best per-page cut on rho: t=${f4(best.t)} => ${best.err}/${total} = ${(bestRate * 100).toFixed(3)}% cell errors` +
      `   (fixed mid[0]=${f4(th.mid[0])} gives ${(fixedRate * 100).toFixed(3)}%)`,
  );
  console.log(
    `  verdict for this page: bestCut ${(bestRate * 100).toFixed(3)}% vs RS ceiling ${(rsTol * 100).toFixed(2)}% => ` +
      (bestRate < rsTol
        ? 'RECALIBRATING THE TABLE COULD WORK: a per-page cut leaves fewer errors than intra-RS can absorb'
        : 'RECALIBRATING THE TABLE CANNOT SAVE THIS PAGE: even the best cut leaves more cell errors than intra-RS can absorb, so the measurement windows or the pitch must change instead'),
  );

  // The oracle cut above used ground truth, which a decoder does not have. This is the number a fix
  // could actually use: an unsupervised Otsu cut on the page's own rho histogram, labelled by rank --
  // the lower cluster is level 0 because level 0 prints no dot, which is a property of the glyph
  // alphabet rather than of this page, so no truth is needed to orient it.
  //
  // The cluster statistics are printed for EVERY page, including the healthy ones and the pristine
  // controls, because the guardrail from round 11 is that a cut may only be trusted on a criterion
  // that is stable across seeds: a number reported only for the pages it happens to suit is not a
  // criterion, it is a tune-to-pass.
  const bins = 512;
  const bmax = rhoOf.length ? rhoOf[rhoOf.length - 1] : 1;
  const hist = new Float64Array(bins);
  for (const x of rhoOf) hist[Math.min(bins - 1, Math.floor((x / (bmax || 1)) * bins))]++;
  let sumAll = 0;
  for (let b = 0; b < bins; b++) sumAll += b * hist[b];
  let w0 = 0;
  let sum0 = 0;
  let bestBetween = -Infinity;
  let bestBin = 0;
  for (let b = 0; b < bins; b++) {
    w0 += hist[b];
    if (!w0) continue;
    const w1 = rhoOf.length - w0;
    if (!w1) break;
    sum0 += b * hist[b];
    const mb0 = sum0 / w0;
    const mb1 = (sumAll - sum0) / w1;
    const between = w0 * w1 * (mb0 - mb1) * (mb0 - mb1);
    if (between > bestBetween) {
      bestBetween = between;
      bestBin = b;
    }
  }
  const tOtsu = ((bestBin + 0.5) / bins) * (bmax || 1);
  const errOtsu = rho0.filter((x) => x > tOtsu).length + (rho1.length - rho1.filter((x) => x > tOtsu).length);
  const otsuRate = total ? errOtsu / total : NaN;
  const mean = (s) => (s.length ? s.reduce((a, x) => a + x, 0) / s.length : NaN);
  const sd = (s) => {
    const m = mean(s);
    return s.length ? Math.sqrt(s.reduce((a, x) => a + (x - m) * (x - m), 0) / s.length) : NaN;
  };
  const cm0 = mean(rho0);
  const cm1 = mean(rho1);
  const cs0 = sd(rho0);
  const cs1 = sd(rho1);
  const separation = (cm1 - cm0) / Math.max(1e-9, cs0 + cs1);
  const loBin = Math.min(bins - 1, Math.max(0, Math.floor((cm0 / (bmax || 1)) * bins)));
  const hiBin = Math.min(bins - 1, Math.max(loBin, Math.floor((cm1 / (bmax || 1)) * bins)));
  let valley = Infinity;
  for (let b = loBin; b <= hiBin; b++) valley = Math.min(valley, hist[b]);
  let peak0 = 0;
  for (let b = 0; b <= loBin; b++) peak0 = Math.max(peak0, hist[b]);
  let peak1 = 0;
  for (let b = hiBin; b < bins; b++) peak1 = Math.max(peak1, hist[b]);
  console.log(
    `  unsupervised cut (Otsu over ${bins} bins, lower cluster = level 0): t=${f4(tOtsu)} => ${errOtsu}/${total} = ` +
      `${(otsuRate * 100).toFixed(3)}% cell errors   (oracle best ${(bestRate * 100).toFixed(3)}%, fixed threshold ${(fixedRate * 100).toFixed(3)}%)`,
  );
  console.log(
    `      cluster means ${f4(cm0)} / ${f4(cm1)}   sd ${f4(cs0)} / ${f4(cs1)}   separation (m1-m0)/(sd0+sd1) = ${separation.toFixed(2)}` +
      `   valley/min(peak) = ${peak0 > 0 && peak1 > 0 && Number.isFinite(valley) ? (valley / Math.min(peak0, peak1)).toFixed(5) : 'n/a'}` +
      `   minority share ${total ? ((rho1.length / total) * 100).toFixed(2) : 'n/a'}%`,
  );
  console.log(
    `  verdict with no ground truth (what a fix could use): Otsu ${(otsuRate * 100).toFixed(3)}% vs RS ceiling ${(rsTol * 100).toFixed(2)}% => ` +
      (otsuRate < rsTol
        ? 'AN UNSUPERVISED PER-PAGE CUT LEAVES FEWER ERRORS THAN INTRA-RS CAN ABSORB'
        : 'even an unsupervised per-page cut leaves too many errors: the measurement windows or the pitch must change instead'),
  );
}
console.log('\nnote       measurement only: exit 0 means the report ran, not that any page is good.');
if (aborted) process.exitCode = 1;
