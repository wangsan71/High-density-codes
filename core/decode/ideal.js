import { getPalette } from '../palette.js';
import { MEASURE, ANNULUS_AREA, levelFromRho, shapeThresholds, rhoFor, glyphMaskForLevel } from '../render/glyphs.js';
import { joinCellLevels } from '../protocol.js';
import { measureTargets } from '../render/raster.js';

/**
 * The ideal sampler: read a rendered page back with no channel at all.
 *
 * It is deliberately the *same arithmetic* the camera decoder will use later --
 * estimate per-pixel coverage, integrate it over the dot region and the annulus
 * band, take the ratio -- so a bug that survives this stage but shows up in the
 * field is a channel problem, not a hidden model mismatch here.
 *
 *     observed = substrate * (1 - a) + ink * a
 *
 * Coverage per pixel is therefore  a = |observed - substrate| / |ink - substrate|,
 * with the cell's own ink direction taken from its strongest pixel (a cell is
 * printed with one ink, so that estimate needs no prior knowledge).
 */

function dist2(a, b) {
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return dr * dr + dg * dg + db * db;
}

/** Normalised (dx, dy) of a pixel inside a cell, -0.5 .. 0.5. */
function norm(dx, dy, cellPx) {
  return [(dx + 0.5) / cellPx - 0.5, (dy + 0.5) / cellPx - 0.5];
}

/**
 * Analyse one cell: coverage integration + ink estimate.
 * @returns {{rho:number, ink:number[]|null, alphaMax:number, printed:number, band:number, dot:number}}
 */
export function analyseCell(bitmap, layout, c, r) {
  const { pixels, width } = bitmap;
  const cellPx = layout.cellPx;
  const x0 = layout.originPx.x + c * cellPx;
  const y0 = layout.originPx.y + r * cellPx;
  const sub = bitmap.substrate;
  // measurement windows come from the page geometry, so an EW-quantised plate and
  // an ideal-circle paper page are read by the same code
  const m = (layout.glyph && layout.glyph.measure) || MEASURE;

  // pass 1: find the pixel furthest from the substrate -> this cell's ink direction
  let best = -1;
  let bestRGB = null;
  let sx = 0;
  let sy = 0;
  let sz = 0;
  for (let py = 0; py < cellPx; py++) {
    for (let px = 0; px < cellPx; px++) {
      const o = ((y0 + py) * width + x0 + px) * 4;
      const R = pixels[o];
      const G = pixels[o + 1];
      const B = pixels[o + 2];
      const d = (R - sub[0]) * (R - sub[0]) + (G - sub[1]) * (G - sub[1]) + (B - sub[2]) * (B - sub[2]);
      if (d > best) {
        best = d;
        bestRGB = [R, G, B];
      }
      sx += R;
      sy += G;
      sz += B;
    }
  }
  const n = cellPx * cellPx;
  const mean = [sx / n, sy / n, sz / n];
  if (best < 6) {
    // nothing printed in this cell at all: no geometry to measure rho from
    return { rho: 0, ink: null, alphaMax: 0, printed: 0, band: 0, dot: 0, mean, blank: true };
  }
  const denom = Math.max(1e-6, dist2(bestRGB, sub));
  const ux = (bestRGB[0] - sub[0]) / Math.sqrt(denom);
  const uy = (bestRGB[1] - sub[1]) / Math.sqrt(denom);
  const uz = (bestRGB[2] - sub[2]) / Math.sqrt(denom);

  let dot = 0;
  const amap = new Float64Array(n);
  let band = 0;
  let total = 0;
  let printed = 0;
  let alphaSum = 0;
  let alphaMax = 0;
  let strong = [0, 0, 0];
  let strongW = 0;
  for (let py = 0; py < cellPx; py++) {
    for (let px = 0; px < cellPx; px++) {
      const o = ((y0 + py) * width + x0 + px) * 4;
      const dr = pixels[o] - sub[0];
      const dg = pixels[o + 1] - sub[1];
      const db = pixels[o + 2] - sub[2];
      const a = Math.max(0, Math.min(1.2, (dr * ux + dg * uy + db * uz) / Math.sqrt(denom)));
      if (a > alphaMax) alphaMax = a;
      alphaSum += a;
      amap[py * cellPx + px] = a;
      if (a > 0.5) printed++;
      if (a > 0.85) {
        strong[0] += pixels[o] * a;
        strong[1] += pixels[o + 1] * a;
        strong[2] += pixels[o + 2] * a;
        strongW += a;
      }
      const [nx, ny] = norm(px, py, cellPx);
      const rr = Math.sqrt(nx * nx + ny * ny);
      if (rr <= m.dotR) {
        dot += a;
      } else if (rr >= m.bandIn && rr <= m.bandOut) {
        band += a;
      }
      if (rr <= 0.5) total += a;
    }
  }
  // Coverage sums are areas normalised by the cell area; the guard band is a
  // subset of the annulus, so scale it back up before taking the ratio.
  const dotA = dot / n;
  const bandA = (band / n) * m.bandScale;
  const rho = bandA > 1e-4 ? dotA / bandA : NaN;
  const ink = strongW > 0 ? [strong[0] / strongW, strong[1] / strongW, strong[2] / strongW] : bestRGB;
  return { rho, ink, alphaMax, printed, total, band: bandA, dot: dotA, mean, alphaMap: amap, blank: false };
}

/**
 * Ideal coverage map for each shape level, sampled on the same pixel-centre grid
 * `analyseCell` uses. The templates come from `glyphMaskForLevel` -- the very
 * function the renderer draws with -- so the decoder cannot drift away from the
 * encoder without the conformance vectors noticing.
 */
export function buildShapeTemplates(cellPx, geo, shapeLevels) {
  const out = [];
  for (let lv = 0; lv < shapeLevels; lv++) {
    const t = new Float64Array(cellPx * cellPx);
    for (let py = 0; py < cellPx; py++) {
      for (let px = 0; px < cellPx; px++) {
        const [nx, ny] = norm(px, py, cellPx);
        t[py * cellPx + px] = glyphMaskForLevel(nx, ny, lv, geo) ? 1 : 0;
      }
    }
    out.push(t);
  }
  return out;
}

/**
 * Decide a cell's shape level by matched filter instead of by one ratio.
 *
 * `rho` throws away most of the cell: it integrates the coverage over two annuli
 * and compares one number to a table. That is exactly why it has no tolerance for
 * edge displacement -- EW expansion and optical MTF move ink across the annulus
 * boundary and every level's rho drifts in the same direction at once, so the
 * decision boundary stops meaning anything. Here the whole alpha map is compared
 * against each level's template instead, with two deliberate invariances:
 *
 *   - a free per-cell gain (the residual is minimised analytically over the scale
 *     of the template), so exposure and blur, which attenuate coverage without
 *     changing its shape, cannot by themselves flip the decision;
 *   - a small integer alignment search, so a registration error of a pixel does not
 *     have to be absorbed by the shape channel.
 *
 * @param {Float64Array} alphaMap  cellPx*cellPx measured coverage, row-major
 * @param {Float64Array[]} templates  from buildShapeTemplates()
 * @param {number} cellPx
 * @param {{offsetPx?:number}} [opts]
 * @returns {{level:number,residual:number,margin:number,offset:number,blank:boolean,all:object[]}}
 */
export function matchedShapeLevel(alphaMap, templates, cellPx, opts = {}) {
  const offsetPx = opts.offsetPx ?? 1;
  let aa = 0;
  for (let i = 0; i < alphaMap.length; i++) aa += alphaMap[i] * alphaMap[i];
  const normAa = Math.max(1e-9, aa);
  if (aa < 1e-6) {
    // Nothing printed here at all. Do not let the filter invent a shape from noise:
    // an unmatched 0/0 comparison would return level 0 with perfect confidence, and
    // the caller needs this to be an erasure, not a plausible-looking symbol.
    return { level: null, residual: 0, margin: 0, offset: 0, blank: true, all: [] };
  }
  const scores = [];
  for (let lv = 0; lv < templates.length; lv++) {
    const T = templates[lv];
    let best = Infinity;
    let bestOff = 0;
    for (let oy = -offsetPx; oy <= offsetPx; oy++) {
      for (let ox = -offsetPx; ox <= offsetPx; ox++) {
        let at = 0;
        let tt = 0;
        for (let py = 0; py < cellPx; py++) {
          const ty = py + oy;
          if (ty < 0 || ty >= cellPx) continue;
          const rowT = ty * cellPx;
          const rowA = py * cellPx;
          for (let px = 0; px < cellPx; px++) {
            const tx = px + ox;
            if (tx < 0 || tx >= cellPx) continue;
            const v = T[rowT + tx];
            if (!v) continue;
            at += v * alphaMap[rowA + px];
            tt += v;
          }
        }
        if (tt < 1) continue;
        // min over gain s of ||A - sT||^2  =  ||A||^2 - <A,T>^2 / ||T||^2
        const res = aa - (at * at) / tt;
        if (res < best) {
          best = res;
          bestOff = oy * cellPx + ox;
        }
      }
    }
    scores.push({ level: lv, residual: Math.max(0, best) / normAa });
  }
  scores.sort((a, b) => a.residual - b.residual);
  const win = scores[0];
  const next = scores[1];
  return {
    level: win.level,
    residual: win.residual,
    // 1.0 when the runner-up is a total mismatch; ->0 as two levels become
    // indistinguishable, which is what the erasure decision wants to see.
    margin: next ? (next.residual - win.residual) / Math.max(1e-9, next.residual) : 1,
    offset: win.offset,
    blank: false,
    all: scores,
  };
}

/** Nominal annulus area as a fraction of the cell, used as the rho denominator. */
export function nominalBandFraction() {
  return ANNULUS_AREA;
}

/**
 * Read every cell of a rendered page.
 * @returns {{levels:Uint16Array, quality:Float32Array, cells:object[], colourAlive:boolean}}
 */
export function readPageIdeal(bitmap, layout, geom, palette = 'INK2') {
  const pal = getPalette(palette);
  const shapeChannel = geom.channels.find((ch) => ch.name === 'shape');
  const colourChannel = geom.channels.find((ch) => ch.name === 'colour');
  const thresholds = shapeThresholds(shapeChannel.levels, {
    targets: measureTargets(layout.cellPx, shapeChannel.levels, layout.glyph),
  });
  const levels = new Uint16Array(geom.totalCells);
  const quality = new Float32Array(geom.totalCells);
  const cells = [];
  const inks = [];
  // One template set per page: the shapes are fixed by the geometry, only the
  // measured alpha changes per cell.
  const templates = layout.glyph && shapeChannel ? buildShapeTemplates(layout.cellPx, layout.glyph, shapeChannel.levels) : null;
  let disagreed = 0;
  for (let r = 0; r < geom.rows; r++) {
    for (let c = 0; c < geom.cols; c++) {
      const i = r * geom.cols + c;
      const a = analyseCell(bitmap, layout, c, r);
      cells.push(a);
      let shapeLevel = Number.isFinite(a.rho) ? levelFromRho(a.rho, thresholds) : null;
      if (templates && a.alphaMap) {
        const mf = matchedShapeLevel(a.alphaMap, templates, layout.cellPx);
        if (!mf.blank && mf.level !== null) {
          if (shapeLevel !== null && shapeLevel !== mf.level) disagreed++;
          shapeLevel = mf.level;
          // Quality becomes the matched-filter margin, which is the honest number:
          // "how much better did the winner fit than the runner-up", not "how dark
          // was the darkest pixel". The receiver's erasure decision reads this.
          quality[i] = Math.min(1, Math.max(0, mf.margin));
        } else {
          quality[i] = 0;
        }
      } else {
        quality[i] = shapeLevel === null ? 0 : Math.min(1, a.alphaMax);
      }
      if (shapeLevel === null) {
        quality[i] = 0;
        levels[i] = 0;
        continue;
      }
      let colourLevel = 0;
      if (colourChannel) {
        colourLevel = nearestInk(a.ink, pal);
        inks.push(colourLevel);
      }
      levels[i] = joinCellLevels({ shape: shapeLevel, colour: colourLevel }, geom);
    }
  }
  // (The ratio-vs-template disagreement count is returned below rather than hidden:
  // if the two methods disagree a lot on a clean render, one of them is wrong, and
  // that is a fact worth seeing in the gate output instead of a silent choice.)

  // A single-colour print leaves the colour channel with nothing to say: every
  // cell resolves to the same ink. Detect that from the data alone (no side
  // channel), because it is what tells the receiver to treat colour as erasures
  // and rebuild it from the shape-channel parity.
  //
  // Note the deliberate asymmetry: a *colour* page whose payload happens to use
  // only one ink is also reported dead. That costs capacity (the receiver will
  // rebuild a channel it could have read) but can never lose data.
  let colourAlive = true;
  if (colourChannel) {
    const distinct = new Set(inks).size;
    colourAlive = pal.inks.length > 1 && distinct > 1;
  }
  return { levels, quality, cells, colourAlive, thresholds, shapeChannel, colourChannel, matchedFilter: !!templates, ratioDisagreements: disagreed };
}

function nearestInk(rgb, pal) {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < pal.inks.length; i++) {
    const d = dist2(rgb, pal.inks[i]);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** Mean distance between each cell's ink and the palette entry it matched, scaled.
 * Not used by the colour-alive decision (which is deliberately conservative);
 * kept and exercised because the camera decoder will need a quality metric and
 * an untested helper there would be worse than a few dead lines here.
 * @internal */
export function inkSpread(cells, pal) {
  let acc = 0;
  let n = 0;
  for (const c of cells) {
    if (!c.ink) continue;
    const i = nearestInk(c.ink, pal);
    acc += Math.sqrt(dist2(c.ink, pal.inks[i])) / 441.7;
    n++;
    if (n > 400) break;
  }
  return n ? acc / n : 1;
}

/** What rho *should* a given shape level measure as, for calibration reports. */
export function expectedRho(level, shapeLevels) {
  return rhoFor(level, shapeLevels);
}
