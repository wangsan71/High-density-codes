/**
 * Reading an MTF calibration plate back: the **measurement** half of PLAN §3.4.
 *
 * `core/calibrate/mtfplate.js` draws the plate; this file turns a capture of it into
 * "the smallest feature this print+capture chain resolves", "the pitch that survives",
 * "how separable the colour channel is" and "how far white balance drifted", and then
 * into a nozzle/pitch recommendation.
 *
 * Design rules, all of them learned from this repo's own ledger:
 *
 *   1. **No second readout.** Registration is `findMarkers` + `rectifyPage`, coverage is
 *      `analyseCell`, colour classification is `nearestLevel` — the decoder's own code.
 *      A measurement that used its own copy of those would describe a parallel product.
 *   2. **Cuts are physical statements, not fitted knobs.** A rung counts as resolved when
 *      the hole's centre is at most 25% inked and the ink rim around it is at least 70%
 *      inked. Those are statements about the picture ("the hole is open", "the ink is
 *      there"), not thresholds tuned until a sample passed. The matched-filter margin is
 *      reported alongside but is **not** the cut (this repo has no enforced margin cut to
 *      borrow: `quality` is reported, never enforced).
 *   3. **Reported vs judged is kept apart.** Texture modulation and the ruler's tick
 *      uniformity are *reported*; only the feature ladder and the pitch ladder produce
 *      verdicts, and the recommendation names the rung it came from.
 *   4. **Refuse rather than recommend from nothing.** If no feature rung resolves, the
 *      answer is "this chain resolves nothing at these sizes", not a nozzle guess.
 *   5. **The floor is a joint print+capture limit** and is labelled as one everywhere:
 *      a hole that never printed and a hole that printed but is optically filled are
 *      indistinguishable from one capture. The plate does not pretend otherwise.
 *
 * Pure ESM, zero dependencies, no `node:` imports.
 */
import { findMarkers } from '../decode/fiducial.js';
import { rectifyPage, quietZoneSubstrate } from '../decode/warp.js';
import { analyseCell } from '../decode/ideal.js';
import { nearestLevel, describe, getPalette } from '../palette.js';
import { idealGeometry } from '../render/glyphs.js';
import { MM_PER_INCH } from '../render/units.js';
import { getNozzle, NOZZLE_IDS, nozzleFromExtrusionWidth } from '../nozzles.js';
import { PROFILES, planPage } from '../profiles.js';
import { mtfPlateLayout, MTF_PLATE_VERSION, MTF_HOLE_FRACTION } from './mtfplate.js';

/** A hole whose centre is at most this inked counts as open. Physical, not fitted. */
export const HOLE_OPEN_CUT = 0.25;
/** The ink around a hole must be at least this inked for the rung to mean anything. */
export const RIM_INKED_CUT = 0.7;
/** Fraction of the nominal hole side used as the measurement window, so edges stay out. */
export const HOLE_WINDOW_FRACTION = 0.55;

const median = (a) => {
  if (!a.length) return NaN;
  const s = Array.from(a).sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const quantile = (a, q) => {
  if (!a.length) return NaN;
  const s = Array.from(a).sort((x, y) => x - y);
  const i = Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))));
  return s[i];
};

/** Mean alpha inside an axis-aligned window of a cell's alpha map, in cell pixels. */
function windowMean(alphaMap, cellPx, cxPx, cyPx, halfPx) {
  let sum = 0;
  let n = 0;
  const x0 = Math.max(0, Math.round(cxPx - halfPx));
  const x1 = Math.min(cellPx, Math.round(cxPx + halfPx));
  const y0 = Math.max(0, Math.round(cyPx - halfPx));
  const y1 = Math.min(cellPx, Math.round(cyPx + halfPx));
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      sum += alphaMap[y * cellPx + x];
      n++;
    }
  }
  return n ? sum / n : NaN;
}

/** Ink coverage of the rim between the hole window and the cell edge, from the same map. */
function rimMean(alphaMap, cellPx, halfPx) {
  let sum = 0;
  let n = 0;
  const lo = Math.round(halfPx) + 1;
  for (let y = 0; y < cellPx; y++) {
    for (let x = 0; x < cellPx; x++) {
      const dx = x - cellPx / 2;
      const dy = y - cellPx / 2;
      if (Math.abs(dx) <= lo && Math.abs(dy) <= lo) continue;
      sum += alphaMap[y * cellPx + x];
      n++;
    }
  }
  return n ? sum / n : NaN;
}

/** A one-cell layout for a patch whose grid is not the plate's own frame grid. */
function cellLayout(cellPx, originPx) {
  return { cellPx, originPx, glyph: idealGeometry(2), width: 0, height: 0 };
}

/**
 * Measure one hole-grid patch: for every cell, the hole's openness and the rim's ink.
 * @returns {{cells:object[], holeMedian:number, holeP90:number, rimMedian:number, resolved:boolean}}
 */
function measureHoleGrid(rect, layout, cellPx, cols, rows, holeSidePx) {
  const half = Math.max(1, (HOLE_WINDOW_FRACTION * holeSidePx) / 2);
  const cells = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const a = analyseCell(rect, layout, c, r);
      if (!a.alphaMap) {
        cells.push({ c, r, hole: NaN, rim: NaN, blank: true });
        continue;
      }
      cells.push({
        c,
        r,
        hole: windowMean(a.alphaMap, cellPx, cellPx / 2, cellPx / 2, half),
        rim: rimMean(a.alphaMap, cellPx, half),
        blank: false,
      });
    }
  }
  const holes = cells.filter((x) => Number.isFinite(x.hole)).map((x) => x.hole);
  const rims = cells.filter((x) => Number.isFinite(x.rim)).map((x) => x.rim);
  const holeMedian = median(holes);
  const holeP90 = quantile(holes, 0.9);
  const rimMedian = median(rims);
  return {
    cells,
    holeMedian,
    holeP90,
    rimMedian,
    resolved: Number.isFinite(holeMedian) && holeMedian <= HOLE_OPEN_CUT && rimMedian >= RIM_INKED_CUT,
  };
}

/**
 * Register a capture against a plate spec and measure everything.
 *
 * @param {{width:number,height:number,pixels:Uint8Array,substrate?:number[]}} bitmap
 * @param {object} spec  from mtfPlateSpec
 * @param {object} [opts]
 * @param {boolean} [opts.allowFastPath] true = trust a canvas-sized image without checking its
 *   markers (for a pristine render you generated yourself); default: a canvas-sized image is used
 *   only when its four markers really are at their nominal positions, otherwise it is registered.
 * @param {boolean} [opts.texture=true] measure the texture patches (skip to save time)
 * @param {boolean} [opts.ruler=true] measure the ruler
 * @param {object} [opts.markerOpts] passed through to findMarkers
 * @returns {object} measurements (see the shape at the bottom of this function)
 */
export function readMtfPlate(bitmap, spec, opts = {}) {
  if (!spec || spec.kind !== 'pskt-mtf-plate') throw new Error('readMtfPlate: not an MTF plate spec');
  if (spec.version !== MTF_PLATE_VERSION) {
    throw new Error(`readMtfPlate: spec version ${spec.version} is not ${MTF_PLATE_VERSION} (regenerate the plate)`);
  }
  const layout = mtfPlateLayout(spec);
  let rect = null;
  let registration = 'none';
  // Canvas-sized is not the same as canvas-aligned. A photo that happens to share the
  // dimensions would otherwise be measured at nominal positions and could produce a
  // confident, wrong recommendation -- the one failure this project refuses. So the fast
  // path is only taken when the four markers are actually where the spec says they are.
  const alreadyCanvas =
    bitmap.width === spec.width && bitmap.height === spec.height && (opts.allowFastPath === true || markersAligned(bitmap, spec));
  if (alreadyCanvas && opts.allowFastPath !== false) {
    rect = {
      width: bitmap.width,
      height: bitmap.height,
      pixels: bitmap.pixels,
      substrate: bitmap.substrate || quietZoneSubstrate(bitmap),
      coverage: 1,
    };
    registration = 'canvas';
  } else {
    const found = findMarkers(bitmap, opts.markerOpts || {});
    if (!found.ok) return { ok: false, stage: 'markers', reason: found.reason, detail: found };
    const r = rectifyPage(bitmap, layout, found.quad, opts);
    if (!r.ok) return { ok: false, stage: 'rectify', reason: r.reason, detail: r };
    rect = r;
    registration = 'markers';
    rect.markerPx = found.markerPx;
  }
  const substrate = rect.substrate || [255, 255, 255];
  rect.substrate = substrate;

  const out = {
    ok: true,
    registration,
    markerPx: rect.markerPx ?? null,
    coverage: rect.coverage ?? 1,
    substrate,
    dpi: spec.dpi,
    pitch: null,
    features: null,
    colour: null,
    texture: null,
    ruler: null,
    warnings: [],
  };

  // ---- pitch ladder ----------------------------------------------------------------
  const rungs = [];
  for (const rung of spec.pitchLadder) {
    const lay = cellLayout(rung.cellPx, rung.originPx);
    const m = measureHoleGrid(rect, lay, rung.cellPx, rung.cols, rung.rows, rung.holeSidePx);
    rungs.push({
      id: rung.id,
      pitchMm: rung.pitchMm,
      pitchMmNominal: rung.pitchMmNominal,
      holeSideMm: rung.holeSideMm,
      cells: rung.cols * rung.rows,
      holeMedian: m.holeMedian,
      holeP90: m.holeP90,
      rimMedian: m.rimMedian,
      resolved: m.resolved,
    });
  }
  const pitchResolved = rungs.filter((r) => r.resolved);
  const minStablePitchMm = pitchResolved.length ? Math.min(...pitchResolved.map((r) => r.pitchMm)) : null;
  out.pitch = {
    rungs,
    minStablePitchMm,
    // The floor implied by the pitch ladder alone: a rung needs hole 0.4p and ink 0.6p, so
    // the smallest usable pitch is 1/0.4 = 2.5x the smallest feature that resolves.
    impliedFloorMm: minStablePitchMm === null ? null : minStablePitchMm * MTF_HOLE_FRACTION,
    anyResolved: pitchResolved.length > 0,
  };

  // ---- feature ladder --------------------------------------------------------------
  const feats = [];
  for (const cell of spec.featureLadder) {
    const lay = cellLayout(cell.cellPx, cell.originPx);
    const a = analyseCell(rect, lay, 0, 0);
    const half = Math.max(1, (HOLE_WINDOW_FRACTION * cell.sizePx) / 2);
    const hole = a.alphaMap ? windowMean(a.alphaMap, cell.cellPx, cell.cellPx / 2, cell.cellPx / 2, half) : NaN;
    const rim = a.alphaMap ? rimMean(a.alphaMap, cell.cellPx, half) : NaN;
    feats.push({
      id: cell.id,
      sizeMm: cell.sizeMm,
      hole,
      rim,
      resolved: Number.isFinite(hole) && hole <= HOLE_OPEN_CUT && rim >= RIM_INKED_CUT,
    });
  }
  const featResolved = feats.filter((f) => f.resolved);
  const featFailed = feats.filter((f) => !f.resolved);
  const floorHiMm = featResolved.length ? Math.min(...featResolved.map((f) => f.sizeMm)) : null;
  const floorLoMm = floorHiMm === null ? null : Math.max(0, ...featFailed.filter((f) => f.sizeMm < floorHiMm).map((f) => f.sizeMm));
  out.features = {
    rungs: feats,
    // The chain resolves every feature at least this big; the largest feature it failed
    // bounds the floor from below. [lo, hi] is the interval the floor provably lies in.
    floorMm: floorHiMm,
    floorIntervalMm: floorHiMm === null ? null : [floorLoMm, floorHiMm],
    allResolved: featResolved.length === feats.length,
    noneResolved: featResolved.length === 0,
  };
  if (featResolved.length && featResolved.length === feats.length) {
    out.warnings.push(`every feature rung resolved, including the smallest (${feats[0].sizeMm}mm): the floor is below what this plate tests`);
  }
  if (!featResolved.length) {
    out.warnings.push('no feature rung resolved: the chain resolves nothing at these sizes');
  }

  // ---- colour samples --------------------------------------------------------------
  const pal = getPalette(spec.palette);
  const colour = [];
  for (const s of spec.colourSamples) {
    const mean = patchMean(rect, s.rectPx, 0.6);
    const cls = nearestLevel(mean, pal, { limit: Math.max(1, pal.inks.length) });
    colour.push({
      id: s.id,
      inkLevel: s.inkLevel,
      mean,
      nominal: pal.inks[s.inkLevel % pal.inks.length],
      classifiedAs: cls.level,
      distance: cls.distance,
      gapToRunnerUp: cls.runnerUp - cls.distance,
      ambiguous: cls.ambiguous,
      correct: cls.level === s.inkLevel % pal.inks.length,
    });
  }
  const separations = [];
  for (let i = 0; i < colour.length; i++) {
    for (let j = i + 1; j < colour.length; j++) {
      const a = describe(colour[i].mean);
      const b = describe(colour[j].mean);
      separations.push({ pair: [colour[i].id, colour[j].id], distance: Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) });
    }
  }
  const gains = substrate.map((v, i) => (pal.background[i] > 0 ? v / pal.background[i] : NaN));
  out.colour = {
    samples: colour,
    separations,
    minSeparation: separations.length ? Math.min(...separations.map((s) => s.distance)) : null,
    allCorrect: colour.every((c) => c.correct),
    ambiguousCount: colour.filter((c) => c.ambiguous).length,
    whiteBalance: {
      measuredSubstrate: substrate.slice(),
      nominalBackground: pal.background.slice(),
      gains,
      // A single scale-invariant number: how far the three channels moved *relative to
      // each other*. A uniform exposure change is a gain on all three and leaves this 1.
      chromaticSpread: chromaticSpread(gains),
    },
  };

  // ---- texture samples (reported, never enforced) -----------------------------------
  if (opts.texture !== false) {
    const ink = pal.inks[0];
    const tex = [];
    for (const t of spec.textureSamples) {
      const prof = profileModulation(rect, t.rectPx, substrate, ink, t.kind === 'ribbed-h' ? 'v' : 'u');
      tex.push({ id: t.id, kind: t.kind, periodMm: t.periodMm, modulation: prof.modulation, profileP10: prof.p10, profileP90: prof.p90 });
    }
    const solid = tex.find((t) => t.kind === 'solid');
    out.texture = { samples: tex, solidModulation: solid ? solid.modulation : null };
  }

  // ---- ruler (reported, never enforced) ---------------------------------------------
  if (opts.ruler !== false) {
    out.ruler = measureRuler(rect, spec, substrate, pal.inks[0]);
  }

  return out;
}

/**
 * Are the four markers where the spec says they are?
 *
 * Three solid and one hollow: the centre of each solid marker must be darker than its own
 * surround, and the hollow one's centre must be brighter than its ring. Cheap (four small
 * windows) and decisive against a rotated, scaled or shifted image of the same pixel size.
 */
function markersAligned(bitmap, spec) {
  const { pixels, width, height } = bitmap;
  if (!pixels || !width || !height) return false;
  const patch = (cx, cy, half) => {
    let sum = 0;
    let n = 0;
    const x0 = Math.max(0, Math.round(cx - half));
    const x1 = Math.min(width, Math.round(cx + half));
    const y0 = Math.max(0, Math.round(cy - half));
    const y1 = Math.min(height, Math.round(cy + half));
    for (let y = y0; y < y1; y++) {
      let o = (y * width + x0) * 4;
      for (let x = x0; x < x1; x++, o += 4) {
        sum += 0.299 * pixels[o] + 0.587 * pixels[o + 1] + 0.114 * pixels[o + 2];
        n++;
      }
    }
    return n ? sum / n : NaN;
  };
  for (const f of spec.fiducials) {
    const centreHalf = Math.max(1, f.half * 0.4);
    const ringHalf = Math.max(1, f.half * 0.9);
    const centre = patch(f.x, f.y, centreHalf);
    const ring = patch(f.x, f.y, ringHalf);
    if (!Number.isFinite(centre) || !Number.isFinite(ring)) return false;
    // The ring window contains the centre window, so a solid marker has ring < centre
    // slightly; a hollow one has its centre much brighter than its ring.
    if (f.solid ? !(centre <= ring + 12) : !(centre >= ring + 40)) return false;
  }
  return true;
}

/** Mean RGB over the central `frac` of a pixel rect. */
function patchMean(img, rect, frac = 0.6) {
  const { pixels, width } = img;
  const mx = Math.round((rect.w * (1 - frac)) / 2);
  const my = Math.round((rect.h * (1 - frac)) / 2);
  const x0 = rect.x + mx;
  const x1 = rect.x + rect.w - mx;
  const y0 = rect.y + my;
  const y1 = rect.y + rect.h - my;
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    let o = (y * width + x0) * 4;
    for (let x = x0; x < x1; x++, o += 4) {
      r += pixels[o];
      g += pixels[o + 1];
      b += pixels[o + 2];
      n++;
    }
  }
  return n ? [r / n, g / n, b / n] : [NaN, NaN, NaN];
}

/** Relative spread of a per-channel gain triple: 0 when all three moved together. */
function chromaticSpread(gains) {
  if (gains.some((g) => !Number.isFinite(g) || g <= 0)) return NaN;
  const logs = gains.map((g) => Math.log(g));
  const mean = logs.reduce((a, b) => a + b, 0) / logs.length;
  const varSum = logs.reduce((a, b) => a + (b - mean) * (b - mean), 0) / logs.length;
  return Math.exp(Math.sqrt(varSum)) - 1;
}

/**
 * Modulation depth of a patch along one axis, from its own ink coverage.
 *
 * Coverage per pixel is the projection onto the (ink - substrate) direction, the same
 * quantity `analyseCell` integrates — computed here from the patch's known two colours
 * because a ribbed patch has no glyph windows to integrate over.
 */
function profileModulation(img, rect, substrate, ink, axis) {
  const { pixels, width } = img;
  const dr = ink[0] - substrate[0];
  const dg = ink[1] - substrate[1];
  const db = ink[2] - substrate[2];
  const denom = dr * dr + dg * dg + db * db;
  const inset = 2;
  const x0 = rect.x + inset;
  const x1 = rect.x + rect.w - inset;
  const y0 = rect.y + inset;
  const y1 = rect.y + rect.h - inset;
  if (x1 <= x0 || y1 <= y0 || !(denom > 0)) return { modulation: NaN, p10: NaN, p90: NaN };
  const profile = [];
  if (axis === 'u') {
    for (let x = x0; x < x1; x++) {
      let s = 0;
      let n = 0;
      for (let y = y0; y < y1; y++) {
        const o = (y * width + x) * 4;
        s += clamp01(((pixels[o] - substrate[0]) * dr + (pixels[o + 1] - substrate[1]) * dg + (pixels[o + 2] - substrate[2]) * db) / denom);
        n++;
      }
      profile.push(s / n);
    }
  } else {
    for (let y = y0; y < y1; y++) {
      let s = 0;
      let n = 0;
      let o = (y * width + x0) * 4;
      for (let x = x0; x < x1; x++, o += 4) {
        s += clamp01(((pixels[o] - substrate[0]) * dr + (pixels[o + 1] - substrate[1]) * dg + (pixels[o + 2] - substrate[2]) * db) / denom);
        n++;
      }
      profile.push(s / n);
    }
  }
  const p10 = quantile(profile, 0.1);
  const p90 = quantile(profile, 0.9);
  const modulation = p90 + p10 > 1e-6 ? (p90 - p10) / (p90 + p10) : 0;
  return { modulation, p10, p90 };
}

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Ruler: tick positions in the rectified plate, and how many ticks resolved at all. */
function measureRuler(img, spec, substrate, ink) {
  const r = spec.ruler;
  const { pixels, width } = img;
  const dr = ink[0] - substrate[0];
  const dg = ink[1] - substrate[1];
  const db = ink[2] - substrate[2];
  const denom = dr * dr + dg * dg + db * db;
  const px = (mm) => Math.round((mm * spec.dpi) / MM_PER_INCH);
  const x0 = px(r.x0Mm);
  const x1 = px(r.x1Mm);
  // Two bands, measured separately: the majors rise higher than the minors, so averaging
  // one band over both heights would report "10 mm ticks only" while claiming to count the
  // 1 mm ones (measured: 16 of 151 found, spacing 118 px instead of 11.8 px).
  const columnProfile = (yTopMm, yBotMm) => {
    const yTop = px(yTopMm);
    const yBot = px(yBotMm);
    const cols = [];
    for (let x = x0; x <= x1 && x < width; x++) {
      let s = 0;
      let n = 0;
      for (let y = yTop; y < yBot; y++) {
        const o = (y * width + x) * 4;
        s += clamp01(((pixels[o] - substrate[0]) * dr + (pixels[o + 1] - substrate[1]) * dg + (pixels[o + 2] - substrate[2]) * db) / denom);
        n++;
      }
      cols.push(n ? s / n : 0);
    }
    return cols;
  };
  // Ink runs in a band: each run is a tick. The cut sits half way between the band's own
  // floor and its own peak, so the count does not depend on the absolute exposure.
  const runsIn = (cols) => {
    const lo = quantile(cols, 0.2);
    const hi = quantile(cols, 0.98);
    const cut = lo + (hi - lo) * 0.5;
    const runs = [];
    let start = -1;
    for (let i = 0; i < cols.length; i++) {
      if (cols[i] > cut && start < 0) start = i;
      else if (cols[i] <= cut && start >= 0) {
        runs.push({ start: x0 + start, end: x0 + i - 1, centre: x0 + (start + i - 1) / 2 });
        start = -1;
      }
    }
    if (start >= 0) runs.push({ start: x0 + start, end: x0 + cols.length - 1, centre: x0 + (start + cols.length - 1) / 2 });
    return runs;
  };
  // First-to-last over the run count, not the median of adjacent gaps: adjacent gaps of a
  // pixel-quantised ruler alternate 12/11/12 px, so their median reports 1.6% high on a
  // perfect plate (measured). The span averages that quantisation out.
  const spacingOf = (runs) => {
    if (runs.length < 2) return NaN;
    return (runs[runs.length - 1].centre - runs[0].centre) / (runs.length - 1);
  };
  // The minor band sits between the bar and where the majors start; the major band above it.
  const minorRuns = runsIn(columnProfile(r.tickTopMm, r.barMm.y));
  const majorRuns = runsIn(columnProfile(r.majorTopMm, r.tickTopMm));
  const runs = minorRuns;
  const spacingPx = spacingOf(minorRuns);
  const majorSpacingPx = spacingOf(majorRuns);
  const nominalSpacingPx = (r.tickPeriodMm * spec.dpi) / MM_PER_INCH;
  return {
    ticksFound: runs.length,
    ticksExpected: r.ticks.length,
    majorTicksFound: majorRuns.length,
    majorTicksExpected: r.ticks.filter((t) => t.major).length,
    majorSpacingPx,
    nominalMajorSpacingPx: nominalSpacingPx * r.majorEvery,
    spacingPx,
    nominalSpacingPx,
    // The tick spacing in the *rectified* plate is a check on the ruler itself, not on the
    // print scale: registration maps the fiducials onto their nominal positions, so a
    // uniformly scaled print is absorbed by the homography. Settling D8 needs the user's
    // own ruler against the 150 mm bar -- this number cannot do it, and says so.
    spacingRatio: Number.isFinite(spacingPx) && nominalSpacingPx > 0 ? spacingPx / nominalSpacingPx : NaN,
    note: 'rectified spacing; a uniform print scale is absorbed by registration -- measure the bar with a real ruler for D8',
  };
}

/**
 * Turn measurements into a nozzle/pitch recommendation.
 *
 * The rule is one sentence: **use the finest nozzle whose features this chain resolves.**
 * The smallest feature a product plate carries is one extrusion width (the glyph ring is
 * 1 EW thick), so a nozzle is usable exactly when its EW is at least the measured floor.
 *
 * @param {object} m  readMtfPlate() result
 * @param {object} [opts]
 * @param {number} [opts.plateMm=200]
 */
export function recommendFromMtf(m, opts = {}) {
  if (!m || !m.ok) return { ok: false, reason: 'no measurements' };
  const floor = m.features && m.features.floorMm;
  const out = { ok: true, floorMm: floor, floorIntervalMm: m.features ? m.features.floorIntervalMm : null, nozzle: null, nozzles: [], profiles: [], notes: [] };
  if (floor === null || floor === undefined) {
    out.ok = false;
    out.reason = 'no feature rung resolved, so there is no measured floor to recommend from';
    out.nozzles = NOZZLE_IDS.map((id) => ({ id, ewMm: getNozzle(id).ewMm, usable: false }));
    return out;
  }
  const plateMm = opts.plateMm || 200;
  // Each nozzle's own extrusion width is a rung of the feature ladder, so the answer is read
  // off the ladder when the rung exists; the interval logic below is the fallback for a spec
  // whose ladder does not carry that size (a hand-edited plate).
  const rungFor = (ew) => (m.features.rungs || []).find((r) => Math.abs(r.sizeMm - ew) < 1e-6) || null;
  for (const id of NOZZLE_IDS) {
    const ew = getNozzle(id).ewMm;
    const rung = rungFor(ew);
    out.nozzles.push({
      id,
      ewMm: ew,
      tested: !!rung,
      rungResolved: rung ? rung.resolved : null,
      usable: rung ? rung.resolved : ew + 1e-9 >= floor,
      marginMm: ew - floor,
    });
  }
  const usable = out.nozzles.filter((n) => n.usable);
  if (!usable.length) {
    out.ok = false;
    out.reason =
      `no nozzle's extrusion width resolved: the floor is ${floor}mm, coarser than the coarsest nozzle (${getNozzle('0.8').ewMm}mm)`;
    out.notes.push('shoot closer / scan instead of photographing, or accept that no plate profile can be read by this chain');
    return out;
  }
  const best = usable[0]; // NOZZLE_IDS is ordered finest-first
  const nearest = nozzleFromExtrusionWidth(floor);
  out.nozzle = {
    id: best.id,
    ewMm: best.ewMm,
    floorMm: floor,
    marginMm: best.marginMm,
    fromExactRung: best.tested,
    // What the *interval* says, which is the honest version when the floor only bounds EW
    // from above: every nozzle whose EW lies in (lo, hi] is consistent with this capture.
    intervalMm: out.floorIntervalMm,
    intervalCandidates: out.floorIntervalMm
      ? NOZZLE_IDS.filter((id) => getNozzle(id).ewMm > out.floorIntervalMm[0] + 1e-9 && getNozzle(id).ewMm <= out.floorIntervalMm[1] + 1e-9)
      : [],
    nearestByEw: nearest.id,
    nearestDeltaMm: nearest.delta,
    why: best.tested
      ? `the ${best.ewMm}mm rung (this nozzle's own extrusion width) came back OPEN, and no finer nozzle's rung did`
      : `measured floor ${floor}mm, which is at or below this nozzle's ${best.ewMm}mm features; the ladder has no rung at exactly ${best.ewMm}mm`,
  };
  if (!best.tested) {
    out.notes.push(
      `the recommendation is inferred from the floor interval (${out.floorIntervalMm[0]}, ${out.floorIntervalMm[1]}]mm rather than read off a rung at ${best.ewMm}mm ` +
        `(consistent nozzles: ${out.nozzle.intervalCandidates.join(', ') || 'none'}) -- regenerate the plate with the default ladder to make it a direct read`,
    );
  }
  // Profiles: the product's own geometry at the recommended nozzle, plus the pitch check.
  for (const id of Object.keys(PROFILES)) {
    if (PROFILES[id].medium !== 'plate') continue;
    let geom;
    try {
      geom = planPage(id, { nozzle: best.id, plateMm });
    } catch (e) {
      out.profiles.push({ id, ok: false, reason: e.message });
      continue;
    }
    const pitchOk = m.pitch && m.pitch.minStablePitchMm !== null ? geom.pitchMm + 1e-9 >= m.pitch.minStablePitchMm : null;
    out.profiles.push({
      id,
      ok: pitchOk !== false,
      nozzle: best.id,
      pitchMm: geom.pitchMm,
      cols: geom.cols,
      rows: geom.rows,
      bitsPerCell: geom.bitsPerCell,
      symbolBytes: geom.symbolBytes,
      smallestFeatureMm: best.ewMm,
      pitchCheck: pitchOk,
    });
  }
  // The two ladders answer different questions and are allowed to disagree, but a
  // disagreement wider than 1.5x is worth naming: the pitch rungs are encroached by ink
  // bleed from all four sides inside a single cell, so they read *stricter* than an isolated
  // hole of the same size in a solid block. Measured through sim/channel.py at 300 dpi with
  // EW 0.45: feature ladder floor 0.45mm, pitch ladder implies 0.71mm.
  if (m.pitch && m.pitch.minStablePitchMm !== null) {
    const implied = m.pitch.impliedFloorMm;
    if (implied !== null) {
      const ratio = Math.max(floor, implied) / Math.max(1e-9, Math.min(floor, implied));
      if (ratio > 1.5) {
        const stricter = implied > floor ? 'pitch' : 'feature';
        out.notes.push(
          `the two ladders disagree by ${ratio.toFixed(1)}x: the feature ladder measured ${floor}mm, the pitch ladder implies ${implied.toFixed(2)}mm ` +
            `(the ${stricter} ladder is the stricter one here -- a hole inside a lattice cell is encroached by ink on all four sides, an isolated hole is not). ` +
            'Use the feature ladder for the nozzle and the pitch ladder for the pitch; they measure different things.',
        );
      }
    }
  }
  return out;
}


/** Human-readable summary lines, for the CLI and for the probe tool. */
export function describeMtfMeasurement(m, rec) {
  if (!m.ok) return [`mtf: registration failed at ${m.stage}/${m.reason}`];
  const lines = [];
  lines.push(`mtf: registered by ${m.registration}${m.markerPx ? ` (marker ${m.markerPx.toFixed(1)}px)` : ''}, coverage ${(m.coverage * 100).toFixed(0)}%`);
  lines.push('  pitch ladder   (hole openness; resolved = centre <= 0.25 inked and rim >= 0.70 inked)');
  for (const r of m.pitch.rungs) {
    lines.push(
      `    ${r.pitchMmNominal}mm pitch (hole ${r.holeSideMm}mm, ${r.cells} cells): centre ${fmt(r.holeMedian)} (p90 ${fmt(r.holeP90)}), rim ${fmt(r.rimMedian)} -> ${r.resolved ? 'RESOLVED' : 'closed'}`,
    );
  }
  lines.push(`    smallest resolved pitch: ${m.pitch.minStablePitchMm === null ? 'none' : m.pitch.minStablePitchMm + 'mm'}`);
  lines.push('  feature ladder (isolated holes at 3mm pitch)');
  for (const f of m.features.rungs) {
    lines.push(`    ${f.sizeMm}mm hole: centre ${fmt(f.hole)}, rim ${fmt(f.rim)} -> ${f.resolved ? 'OPEN' : 'filled'}`);
  }
  lines.push(
    `    floor: ${m.features.floorMm === null ? 'none' : m.features.floorMm + 'mm'}` +
      (m.features.floorIntervalMm ? ` (interval (${m.features.floorIntervalMm[0]}, ${m.features.floorIntervalMm[1]}]mm)` : ''),
  );
  if (m.colour) {
    lines.push(`  colour         min separation ${fmt(m.colour.minSeparation)}, all classify correctly: ${m.colour.allCorrect}, ambiguous: ${m.colour.ambiguousCount}`);
    lines.push(
      `    white balance  substrate ${m.colour.whiteBalance.measuredSubstrate.map((v) => v.toFixed(0)).join(',')} vs nominal ` +
        `${m.colour.whiteBalance.nominalBackground.join(',')} -> gains ${m.colour.whiteBalance.gains.map((g) => fmt(g)).join(',')} (chromatic spread ${fmt(m.colour.whiteBalance.chromaticSpread)})`,
    );
  }
  if (m.texture) {
    lines.push(`  texture        solid modulation ${fmt(m.texture.solidModulation)}; ${m.texture.samples.filter((t) => t.kind !== 'solid').map((t) => `${t.id} ${fmt(t.modulation)}`).join(', ')}`);
  }
  if (m.ruler) {
    lines.push(
      `  ruler          1mm ticks ${m.ruler.ticksFound}/${m.ruler.ticksExpected} (spacing ${fmt(m.ruler.spacingPx)}px vs nominal ${fmt(m.ruler.nominalSpacingPx)}px, ratio ${fmt(m.ruler.spacingRatio)}), ` +
        `10mm majors ${m.ruler.majorTicksFound}/${m.ruler.majorTicksExpected} (spacing ${fmt(m.ruler.majorSpacingPx)}px vs ${fmt(m.ruler.nominalMajorSpacingPx)}px)`,
    );
  }
  if (m.warnings.length) for (const w of m.warnings) lines.push(`  warning        ${w}`);
  if (rec) {
    lines.push('  recommendation');
    lines.push(`    nozzle       ${rec.ok ? `${rec.nozzle.id}mm (EW ${rec.nozzle.ewMm}mm, margin ${fmt(rec.nozzle.marginMm)}mm) -- ${rec.nozzle.why}` : `none: ${rec.reason}`}`);
    for (const n of rec.nozzles) {
      lines.push(
        `    nozzle ${n.id}mm: EW ${n.ewMm}mm -> ${n.usable ? 'usable' : 'features too fine'}` +
          (n.tested ? ` (rung ${n.rungResolved ? 'OPEN' : 'filled'})` : ' (no rung at this size)'),
      );
    }
    for (const p of rec.profiles) {
      lines.push(
        p.ok
          ? `    profile ${p.id}: pitch ${p.pitchMm}mm, ${p.cols}x${p.rows} cells, ${p.bitsPerCell} bit/cell, ${p.symbolBytes} B/page`
          : `    profile ${p.id}: REFUSED (${p.reason || 'pitch below the measured floor'})`,
      );
    }
    for (const n of rec.notes) lines.push(`    note         ${n}`);
  }
  return lines;
}

const fmt = (x) => (Number.isFinite(x) ? (Math.abs(x) >= 100 ? x.toFixed(0) : x.toFixed(3)) : 'n/a');
