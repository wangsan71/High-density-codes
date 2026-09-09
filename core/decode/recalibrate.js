/**
 * Per-page recalibration of the shape-level decision, arbitrated by the page's own code.
 *
 * Why this exists (DEFECTS D51, rounds 61-62, all numbers measured by tools/rho-report.mjs):
 *
 *   - On a pristine render the level decision is exact: rho measures 0.0021 for level 0 and 0.3741
 *     for level 1 against targets [0, 0.3699].
 *   - Once a channel touches the page, rho is inflated four to twenty times (a perfectly decoding
 *     300 dpi page measures 0.5939 / 1.5750, a healthy 600 dpi page 0.6164 / 1.7289, a collapsed
 *     600 dpi page 1.2684 / 1.6824). The fixed boundary at mid[0] = 0.1850 is therefore wrong on
 *     60.1-90.6% of cells of *any* channel page, and the product works today only because the
 *     matched filter overrides the ratio decision.
 *   - Bleed fills the interior of every cell, so the annulus-plus-dot template fits every cell
 *     better than the annulus-only one, and the matched filter -- whose free per-cell gain absorbs
 *     amplitude but not shape -- then reports one single level for the whole page. That is the
 *     collapse: 141 intra-RS blocks fail while RS reports 0 errors and 0 erasures.
 *   - The information is not lost. An unsupervised cut on the page's own rho histogram leaves 0-208
 *     wrong cells out of 68904-287507 on all nine channel pages measured, including the three
 *     collapsed ones, against an intra-RS ceiling of 6.30%.
 *
 * So the fix re-decides the shape level against a cut estimated from the page in front of us.
 *
 * TWO DELIBERATE LIMITS, both of which are load-bearing:
 *
 * 1. ARBITRATION, NOT TRUST. A recalibrated read is offered to the assembler only after the
 *    matched-filter read has already been rejected with `intra-fail`, and it is accepted only if
 *    the page's own code accepts it -- intra-page RS here, then the frame CRC and the payload
 *    SHA-256 digest downstream. Nothing is believed because it came from the calibrated cut. This
 *    is the same shape as core/decode/echo.js:40-51, which replaced a hard-coded cut of 6000 with
 *    candidate cuts adjudicated by the strip's own CRC16 and says in terms that this is not
 *    loosening acceptance because the same guarantee holds while the threshold is chosen by
 *    evidence instead of by us. The page-level arbiter is far stronger than a CRC16.
 *    Consequence: a page that decodes today is read bit-identically today, because the retry never
 *    runs. That is why the 300 dpi side of G2 cannot regress by construction.
 *
 * 2. NO NAIVE OTSU. Measured trap: on a degenerate histogram (two delta spikes, sd 0.0000 -- which
 *    is exactly what a pristine render or the fast path produces) the textbook "first bin that
 *    maximises between-class variance" puts the cut at 0.0018, *below* the level-0 spike at 0.0021,
 *    and scores 60.102% cell errors -- it would break the one path that is perfect today. Every bin
 *    between two spikes ties exactly, so the estimator collects the whole tie plateau and cuts at
 *    its midpoint, which lands between the clusters by construction.
 *
 * Orientation needs no ground truth: the lower cluster is level 0, because level 0 prints no dot.
 * That is a property of the glyph alphabet (core/render/glyphs.js#rhoFor returns 0 for level 0),
 * not of the page being decoded.
 *
 * Scope: two-level shape alphabets only. With three or more levels a single cut means nothing, so
 * the estimator refuses and the caller keeps the matched-filter read. Refusing is the point -- an
 * unsupported case must fall back to today's behaviour, not to a guess.
 *
 * Purity: no node: builtins, no I/O, no crypto. Imports protocol.js one way (decode -> protocol),
 * which is acyclic because protocol.js never imports from decode/.
 */
import { joinCellLevels, splitCellLevel } from '../protocol.js';

/** How many shape levels this geometry prints. Mirrors ideal.js's channel lookup, with raster.js's fallback. */
export function shapeLevelsOf(geom) {
  const ch =
    (geom && geom.channels && (geom.channels.find((c) => c.name === 'shape') || geom.channels.find((c) => c.name !== 'colour') || geom.channels[0])) ||
    null;
  return ch ? ch.levels | 0 : 0;
}

/**
 * Estimate the level boundary from a page's own rho values, with no ground truth.
 *
 * @param {Float32Array|number[]} rho  per-cell measured rho; NaN entries are ignored
 * @param {{bins?:number, levels?:number, tieTolerance?:number}} [opts]
 * @returns {{ok:true, cut:number, m0:number, m1:number, sd0:number, sd1:number, separation:number,
 *            minorityShare:number, n:number, bins:number, plateauLo:number, plateauHi:number,
 *            unimodal:boolean} | {ok:false, reason:string}}
 */
export function estimateRhoCut(rho, opts = {}) {
  const bins = opts.bins || 512;
  const levels = opts.levels || 2;
  // A relative tolerance for treating between-class variance values as tied. It is a floating-point
  // tie test, not a decision threshold: on a two-spike histogram the ties are exact, and on a noisy
  // one the plateau stays inside the valley, so its midpoint is where the cut belongs anyway.
  const tie = opts.tieTolerance ?? 1e-9;
  if (levels !== 2) {
    return { ok: false, reason: `a single cut is meaningless for ${levels} shape levels; keeping the matched-filter read` };
  }
  const vals = [];
  let nan = 0;
  for (let i = 0; i < rho.length; i++) {
    const v = rho[i];
    if (Number.isFinite(v)) vals.push(v);
    else nan++;
  }
  if (vals.length < 64) return { ok: false, reason: `only ${vals.length} measurable cells (plus ${nan} unmeasurable); not enough to estimate a cut` };
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of vals) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const span = hi - lo;
  if (!(span > 1e-9)) return { ok: false, reason: `rho is constant at ${lo.toFixed(6)}; no cut exists` };

  const hist = new Float64Array(bins);
  for (const v of vals) {
    const b = Math.min(bins - 1, Math.max(0, Math.floor(((v - lo) / span) * bins)));
    hist[b]++;
  }
  let sumAll = 0;
  for (let b = 0; b < bins; b++) sumAll += b * hist[b];
  const n = vals.length;
  let w0 = 0;
  let sum0 = 0;
  let best = -1;
  let plateauLo = 0;
  let plateauHi = 0;
  for (let b = 0; b < bins; b++) {
    w0 += hist[b];
    if (!w0) continue;
    const w1 = n - w0;
    if (!w1) break;
    sum0 += b * hist[b];
    const m0 = sum0 / w0;
    const m1 = (sumAll - sum0) / w1;
    const between = w0 * w1 * (m0 - m1) * (m0 - m1);
    if (best < 0 || between > best * (1 + tie)) {
      best = between;
      plateauLo = b;
      plateauHi = b;
    } else if (between >= best * (1 - tie) && b === plateauHi + 1) {
      // Contiguous tie: extend the plateau instead of taking the first maximum. This single line is
      // what keeps the degenerate pristine histogram from putting the cut below the level-0 spike.
      plateauHi = b;
    }
  }
  const cut = lo + (((plateauLo + plateauHi + 1) / 2) * span) / bins;

  let c0 = 0;
  let c1 = 0;
  let s0 = 0;
  let s1 = 0;
  for (const v of vals) {
    if (v > cut) {
      c1++;
      s1 += v;
    } else {
      c0++;
      s0 += v;
    }
  }
  const m0 = c0 ? s0 / c0 : NaN;
  const m1 = c1 ? s1 / c1 : NaN;
  let q0 = 0;
  let q1 = 0;
  for (const v of vals) {
    if (v > cut) q1 += (v - m1) * (v - m1);
    else q0 += (v - m0) * (v - m0);
  }
  const sd0 = c0 ? Math.sqrt(q0 / c0) : NaN;
  const sd1 = c1 ? Math.sqrt(q1 / c1) : NaN;
  const separation = Number.isFinite(sd0) && Number.isFinite(sd1) ? (m1 - m0) / Math.max(1e-12, sd0 + sd1) : NaN;
  return {
    ok: true,
    cut,
    m0,
    m1,
    sd0,
    sd1,
    separation,
    minorityShare: n ? Math.min(c0, c1) / n : NaN,
    n,
    nan,
    bins,
    plateauLo,
    plateauHi,
    // Reported, never enforced: a page whose rho really is one cluster still gets a cut (and the
    // arbiter will reject the resulting levels), but the flag says out loud that the estimate had
    // nothing to separate. Round 20's lesson is that a statistic must not become a gate before its
    // spread across a healthy population has been measured.
    unimodal: Number.isFinite(separation) && separation < 1,
  };
}

/**
 * Re-decide the shape level of every measurable cell against a per-page cut.
 *
 * Cells whose rho is unmeasurable keep the matched filter's answer: guessing a level for a cell we
 * could not measure would be exactly the "looks like success but is wrong" failure this repo forbids.
 *
 * @param {{levels:Uint16Array, rho:Float32Array, colourLevels?:Uint8Array, geom:object, cut:number}} args
 * @returns {{levels:Uint16Array, changed:number, kept:number}}
 */
export function recalibrateLevels({ levels, rho, colourLevels, geom, cut }) {
  const shapeLevels = shapeLevelsOf(geom);
  if (shapeLevels !== 2) throw new RangeError(`recalibrateLevels: ${shapeLevels} shape levels; only 2 are supported`);
  if (!Number.isFinite(cut)) throw new RangeError('recalibrateLevels: cut must be finite');
  const out = Uint16Array.from(levels);
  let changed = 0;
  let kept = 0;
  for (let i = 0; i < rho.length; i++) {
    const v = rho[i];
    if (!Number.isFinite(v)) {
      kept++;
      continue;
    }
    // Re-decide the shape channel ONLY, and carry every other channel over from the value the matched
    // filter produced -- by name, not by assuming the alphabet is exactly {shape, colour}. Building
    // the parts from scratch would silently zero any third channel a profile might carry, which is
    // the "looks like success but is wrong" failure this repo forbids. The colour comes from the
    // measurement when the geometry has one: for a cell whose shape level was untrustworthy, that
    // path wrote a literal 0, so the measurement is better than what is there.
    const parts = splitCellLevel(out[i], geom);
    parts.shape = v > cut ? 1 : 0;
    if (colourLevels && 'colour' in parts) parts.colour = colourLevels[i] | 0;
    const joined = joinCellLevels(parts, geom);
    if (joined !== out[i]) changed++;
    out[i] = joined;
  }
  return { levels: out, changed, kept, n: rho.length };
}

/**
 * Feed a decoded page to the assembler, and -- only if the page's own code rejects the read --
 * offer a recalibrated re-read for the same verdict.
 *
 * @param {object} asm  a TransferAssembler
 * @param {object} decoded  a decodePage result: {levels, headerBytes, colourAlive, rho?, colourLevels?}
 * @param {{geom?:object, log?:(msg:string)=>void}} [opts]
 * @returns {Promise<{fed:object, retried:boolean, estimate?:object, changed?:number, secondReason?:string, reason?:string}>}
 *   `fed` is the verdict the caller should act on: the recalibrated one when it was accepted,
 *   otherwise the original, so the reason codes a gate census records stay comparable.
 */
export async function feedPageWithRecalibration(asm, decoded, opts = {}) {
  const { geom = null, log = null } = opts;
  const channelMissing = decoded.colourAlive ? [] : ['colour'];
  const first = await asm.feed({ levels: decoded.levels, header: decoded.headerBytes, channelMissing, cellMissing: decoded.cellMissing });
  if (first.ok || first.duplicate || first.reason !== 'intra-fail') return { fed: first, retried: false };
  if (!geom) return { fed: first, retried: false, reason: 'no-geometry' };
  if (!decoded.rho || !decoded.colourLevels) return { fed: first, retried: false, reason: 'no-rho' };
  const est = estimateRhoCut(decoded.rho, { levels: shapeLevelsOf(geom) });
  if (!est.ok) return { fed: first, retried: false, reason: est.reason, estimate: est };
  const re = recalibrateLevels({ levels: decoded.levels, rho: decoded.rho, colourLevels: decoded.colourLevels, geom, cut: est.cut });
  const second = await asm.feed({ levels: re.levels, header: decoded.headerBytes, channelMissing, cellMissing: decoded.cellMissing });
  if (log) {
    log(
      `recalibrated re-read: cut ${est.cut.toFixed(4)} (clusters ${est.m0.toFixed(3)}/${est.m1.toFixed(3)}, separation ${est.separation.toFixed(2)}` +
        `${est.unimodal ? ', UNIMODAL -- nothing to separate' : ''}), ${re.changed} of ${re.n} cells changed (${re.kept} unmeasurable kept the matched-filter answer) -> ` +
        (second.ok ? 'accepted by the page code' : `still rejected (${second.reason})`),
    );
  }
  if (second.ok) return { fed: second, retried: true, estimate: est, changed: re.changed };
  return { fed: first, retried: true, estimate: est, changed: re.changed, secondReason: second.reason };
}
