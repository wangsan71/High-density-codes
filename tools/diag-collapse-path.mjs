// Which decision path produced the collapse: the matched filter or the rho midpoint?
//
// WARNING -- this probe does NOT settle the question and must not be cited as if it
// does. Two flaws found the round after it was written:
//   1. `levels` is joinCellLevels({shape, colour}) -- a PACKED value, not the shape
//      histogram. Splitting on `v===0` conflates colour bits with shape, so the
//      levels0/1 numbers below are not "how many cells read shape level 1".
//   2. A page that reassembles byte-exact (nc-scan600-1/page-000) shows a wildly
//      lopsided 0/1 split and rho-vs-template disagree=74240 here anyway, which means
//      either the per-cell read is far noisier than the ECC-level success implies, or
//      page correspondence between the scan and pristine dirs is not what this probe
//      assumes. Both possibilities say the round-21 mechanism ("bleed pushes rho past
//      the 0.185 midpoint -> whole page reads level 1") is UNCONFIRMED, and the real
//      level-0 boundary is noDot ~= 0.102, not 0.185.
// To make this tool trustworthy it must histogram shape via splitCellLevel and align
// pages by their decoded header, not by filename. Left as a probe, not a gate.
import { readFileSync } from 'node:fs';
import { decodePNG } from '../core/decode/png-read.js';
import { readPageIdeal } from '../core/decode/ideal.js';
import { planPage } from '../core/profiles.js';
import { pageLayout } from '../core/render/layout.js';
import { getPalette } from '../core/palette.js';

function one(f, prof, dpi) {
  const geom = planPage(prof, { nozzle: null, monoSafe: 'n/a' });
  const lay = pageLayout(geom, dpi, {});
  const b = decodePNG(new Uint8Array(readFileSync(f)));
  b.substrate = getPalette('PAPER1').background;
  const r = readPageIdeal(b, lay, geom, 'PAPER1');
  let z = 0;
  let o = 0;
  for (const v of r.levels) { if (v === 0) z++; else o++; }
  let blank = 0;
  let rhoNaN = 0;
  let rhoSaysLevel0 = 0;
  let mfForcedNull = 0;
  // thresholds is an object {levels, targets, mid, noDot, blob}, not an array -- the
  // round-21 report called the level-0 boundary "the 0.185 midpoint", but the code
  // actually uses noDot = max(target0, mid0*0.55) ~= 0.102. Read the real fields.
  const thr = r.thresholds;
  const noDot = thr && Number.isFinite(thr.noDot) ? thr.noDot : NaN;
  for (const c of r.cells) {
    if (c.blank) blank++;
    if (!Number.isFinite(c.rho)) rhoNaN++;
    else if (Number.isFinite(noDot) && c.rho < noDot) rhoSaysLevel0++;
  }
  return { mf: r.matchedFilter, disagree: r.ratioDisagreements, z, o, blank, rhoNaN, rhoSaysLevel0, mfForcedNull, tot: r.levels.length, targets: [...r.targets].map((x) => x.toFixed(3)).join(','), noDot: Number.isFinite(noDot) ? noDot.toFixed(3) : '-', mid: thr && thr.mid ? thr.mid.map((x) => Number(x).toFixed(3)).join(',') : '-' };
}

const cases = [['COLLAPSED 7/002', '.tmp/nc-scan600-7/page-002.png', 'P-M1-600', 600], ['healthy 600-1/000', '.tmp/nc-scan600-1/page-000.png', 'P-M1-600', 600], ['pristine 000', '.tmp/sw-scan600-src/page-000.png', 'P-M1-600', 600]];
for (const [k, f, p, d] of cases) {
  const v = one(f, p, d);
  console.log(`${k.padEnd(18)} matchedFilter=${v.mf} levels0/1=${v.z}/${v.o} rho-vs-tmpl disagree=${v.disagree} cell-blank=${v.blank} rhoNaN=${v.rhoNaN} rhoWouldLevel0=${v.rhoSaysLevel0} targets[${v.targets}] noDot=${v.noDot} mid[${v.mid}]`);
}
