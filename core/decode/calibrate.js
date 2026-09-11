/**
 * Threshold calibration from what the page itself declares.
 *
 * The failure this fixes is specific and measured: with optical blur fixed in
 * physical units, doubling the capture dpi roughly halves the per-pixel peak
 * coverage, so an Otsu cut keeps only the cores of each stroke -- a 60 px fiducial
 * measures 30 px, and the page is thrown away as `no-square-candidates`. The old
 * answer was a ladder of Otsu multipliers, which is tuning: it works only where the
 * ladder happens to have a rung, and 0.65 working while 0.7 does not is exactly the
 * smell of fitting a knob to one sample.
 *
 * The page carries a ground truth that does not depend on the capture: the shape
 * alphabet says how much of a cell each level inks, and the profile says how many
 * cells there are. So the *expected* printed area is computable, and the threshold is
 * whichever cut makes the measured area match it. That is calibration in the literal
 * sense -- one measurement against one declared quantity -- and it is scale-free: no
 * dpi, no manifest, no assumed exposure, all of which the previous approach needed.
 *
 * Deliberate limits, so nobody reads more into this than it does:
 *
 *   **This module is NOT the fix for the 600 dpi failure, and was built believing a
 *   claim that turned out to be false.** Round 10's story -- "at 600 dpi the fiducial
 *   measures 30 px where it should be 60, because Otsu keeps only stroke cores" --
 *   was checked this round and the premise is wrong twice over: the 600 dpi profile
 *   prints at pitch 0.4233 mm, so its cell is also 10 px and a ~30 px fiducial is the
 *   CORRECT size (measured on a healthy page: markerPx 29.25 with a 10 px cell = 2.92
 *   cells); and otsu/peak is 0.54 at 300 dpi versus 0.57 at 600 dpi, i.e. the cut
 *   sits in essentially the same place, so no photometric shrinkage was happening.
 *   What actually goes wrong at 600 dpi is that one of the four fiducials does not
 *   survive candidate selection, so the quad is built from three markers plus junk at
 *   the image border. Calibration cannot fix that; the measurement below stands on its
 *   own as a way to tell "this page has the ink the profile declares" and nothing more.
 *
 *   What the measurement did establish: the declared-area target is right within ~10%
 *   (integrated coverage / expected = 1.04-1.34 across six pages, pristine and
 *   channel-degraded alike), while *searching for a binarised cut that reproduces that
 *   area* is not a valid actuator -- it asks for x1.3 on pristine renders. Integrated
 *   coverage is usable as a health check; the cut must come from elsewhere.
 *
 *   - the target uses the mean glyph area over the alphabet, which assumes the level
 *     histogram is not wildly skewed. Deflate output and Reed-Solomon parity are
 *     close to uniform, so the error is a few percent on real payloads; a hand-made
 *     page of all-zero symbols would read as "too little ink" and want a looser cut.
 *     That is why the caller gets the ratio, not just a factor.
 *   - it calibrates the *marker* stage only. Cell readout still does its own
 *     matched-filter decision per cell; this does not touch that.
 */
import { otsu } from './fiducial.js';
import { glyphMaskForLevel } from '../render/glyphs.js';

/**
 * Expected ink area per unit of page area, from the page's own description.
 *
 * @param {object} geom  planPage() result: cols, rows, pitchMm, channels
 * @param {object} geo   glyphGeometry() result for the same page (has per-level area)
 * @param {object} [opt]
 * @param {number} [opt.marginMm]  quiet zone per side inside the page box
 * @param {number} [opt.dpi]
 * @returns {{ok:true, expectedArea:number, gridArea:number, expectedFraction:number} | {ok:false, reason:string}}
 */
export function expectedInkArea(geom, geo, opt = {}) {
  // Prefer the real per-level table. `geo.area` alone is one reference level, and
  // using it as the alphabet mean is what made the first version of this module ask
  // for a 0.6 cut on a healthy page.
  const levels = opt.levels ?? (geom.channels && geom.channels.find((c) => c.name === 'shape')?.levels);
  let areas = Array.isArray(geo.areaLevels) && geo.areaLevels.length ? geo.areaLevels : null;
  if (!areas && levels > 1) areas = integrateLevelAreas(geo, levels);
  if (!areas) areas = levelAreas(geo);
  if (!areas) return { ok: false, reason: 'glyphGeometry exposes no per-level area' };
  const pitchMm = geom.pitchMm;
  if (!(pitchMm > 0) || !(geom.cols > 0) || !(geom.rows > 0)) {
    return { ok: false, reason: 'geometry lacks a usable cell grid' };
  }
  const cols = geom.cols;
  const rows = geom.rows;
  // Mean over levels: what one cell inks on average when the payload is unskewed.
  const mean = areas.reduce((a, b) => a + b, 0) / areas.length;
  const cellArea = pitchMm * pitchMm;
  const gridArea = cols * rows * cellArea;
  const expectedArea = gridArea * mean;
  const marginMm = opt.marginMm ?? 0;
  const pageW = cols * pitchMm + 2 * marginMm;
  const pageH = rows * pitchMm + 2 * marginMm;
  return {
    ok: true,
    expectedArea,
    gridArea,
    pageArea: pageW * pageH,
    expectedFraction: expectedArea / (pageW * pageH),
    levelAreas: areas,
  };
}

/** Per-level covered-area fractions, from the same object the renderer drew with. */
function levelAreas(geo) {
  if (!geo) return null;
  if (Array.isArray(geo.areaLevels) && geo.areaLevels.length) return geo.areaLevels;
  if (Number.isFinite(geo.area)) {
    // A single area is enough for the mean, and it is what glyphGeometry returns for
    // the unquantised ideal case. Do not invent a per-level table from it.
    return [geo.area];
  }
  return null;
}

/**
 * Covered-area fraction of every shape level, integrated from the same mask function
 * the renderer fills with. Needed because glyphGeometry exposes one reference `area`,
 * and using that as if it were the mean over the alphabet inflates the target ~3x --
 * which is how the first version of this module ended up demanding a 0.6 cut on a
 * perfectly healthy page.
 *
 * @param {object} geo  glyphGeometry() result
 * @param {number} levels
 * @param {number} [n]  integration grid per side (51 is ~2 600 samples/cell)
 */
function integrateLevelAreas(geo, levels, n = 51) {
  const out = [];
  for (let lv = 0; lv < levels; lv++) {
    let hits = 0;
    for (let gy = 0; gy < n; gy++) {
      const dy = (gy + 0.5) / n - 0.5;
      for (let gx = 0; gx < n; gx++) {
        if (glyphMaskForLevel((gx + 0.5) / n - 0.5, dy, lv, geo)) hits++;
      }
    }
    out.push(hits / (n * n));
  }
  return out;
}

/**
 * Threshold-free ink area: integrate coverage instead of counting pixels above a cut.
 *
 * `inkness` is already a per-pixel coverage-like quantity (0..peak for full ink), so
 * dividing by the peak and summing gives the effective number of fully-inked pixels.
 * A binarised count cannot do that: a pixel that is half ink falls below most cuts
 * and is counted as zero, which biases the measured area low by a factor that grows
 * exactly when the channel gets blurrier -- the bias that made the first version of
 * this module unusable.
 */
export function integratedInkArea(inkness) {
  const values = inkness && inkness.values ? inkness.values : inkness;
  const peak = maxOf(values);
  if (!(peak > 0)) return { ok: false, reason: 'no ink at all', area: 0, pixels: values.length };
  let s = 0;
  for (let i = 0; i < values.length; i++) {
    const a = values[i] / peak;
    s += a > 1 ? 1 : a;
  }
  return { ok: true, area: s, pixels: values.length, peak, fraction: s / values.length };
}

/**
 * Calibrate the marker cut by matching declared ink area to integrated ink area.
 *
 * Returns the cut that brings the binarised measurement to the target, plus the
 * threshold-free ratio that justifies it. `ratio` is the number to look at: near 1
 * means the page has the ink the profile says it should, whatever the exposure did.
 */

/**
 * Measure the ink-area ratio and find the cut that makes it 1.
 *
 * @param {Uint8Array|{values:Float64Array|number[], length?:number}} inkness  per-pixel inkness
 * @param {object} target  from expectedInkArea (uses expectedFraction)
 * @param {object} [opts]
 * @param {number} [opts.pixelsPerPixel]  px per mm at capture (to turn mm^2 into px^2)
function maxOf(a) {
  let m = -Infinity;
  for (let i = 0; i < a.length; i++) if (a[i] > m) m = a[i];
  return m;
}

