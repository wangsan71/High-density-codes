import { getPalette } from '../palette.js';
import { MEASURE, ANNULUS_AREA, levelFromRho, shapeThresholds, rhoFor } from '../render/glyphs.js';
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
      if (a > 0.5) printed++;
      if (a > 0.85) {
        strong[0] += pixels[o] * a;
        strong[1] += pixels[o + 1] * a;
        strong[2] += pixels[o + 2] * a;
        strongW += a;
      }
      const [nx, ny] = norm(px, py, cellPx);
      const rr = Math.sqrt(nx * nx + ny * ny);
      if (rr <= MEASURE.dotR) {
        dot += a;
      } else if (rr >= MEASURE.bandIn && rr <= MEASURE.bandOut) {
        band += a;
      }
      if (rr <= 0.5) total += a;
    }
  }
  // Coverage sums are areas normalised by the cell area; the guard band is a
  // subset of the annulus, so scale it back up before taking the ratio.
  const dotA = dot / n;
  const bandA = (band / n) * MEASURE.bandScale;
  const rho = bandA > 1e-4 ? dotA / bandA : NaN;
  const ink = strongW > 0 ? [strong[0] / strongW, strong[1] / strongW, strong[2] / strongW] : bestRGB;
  return { rho, ink, alphaMax, printed, total, band: bandA, dot: dotA, mean, blank: false };
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
    targets: measureTargets(layout.cellPx, shapeChannel.levels),
  });
  const levels = new Uint16Array(geom.totalCells);
  const quality = new Float32Array(geom.totalCells);
  const cells = [];
  const inks = [];
  for (let r = 0; r < geom.rows; r++) {
    for (let c = 0; c < geom.cols; c++) {
      const i = r * geom.cols + c;
      const a = analyseCell(bitmap, layout, c, r);
      cells.push(a);
      const shapeLevel = Number.isFinite(a.rho) ? levelFromRho(a.rho, thresholds) : null;
      if (shapeLevel === null) {
        quality[i] = 0;
        levels[i] = 0;
        continue;
      }
      quality[i] = Math.min(1, a.alphaMax);
      let colourLevel = 0;
      if (colourChannel) {
        colourLevel = nearestInk(a.ink, pal);
        inks.push(colourLevel);
      }
      levels[i] = joinCellLevels({ shape: shapeLevel, colour: colourLevel }, geom);
    }
  }

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
  return { levels, quality, cells, colourAlive, thresholds, shapeChannel, colourChannel };
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
