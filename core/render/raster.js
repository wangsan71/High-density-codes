import { getPalette, BACKGROUND } from '../palette.js';
import { glyphMaskForLevel, idealGeometry, MEASURE } from './glyphs.js';
import { splitCellLevel } from '../protocol.js';
import { HEADER_LEN } from '../frame.js';

/**
 * Raster renderer: cell levels -> a printed-looking RGBA bitmap.
 *
 * Physical model of one cell: the *shape* channel is a reference annulus plus a
 * centre dot, the *colour* channel is the ink they are printed in, and anything
 * not printed shows the substrate. So a cell is described by (ink, coverage)
 * and the output pixel is their composite over the substrate -- which is exactly
 * what a scanner later sees, and why the decoder can undo it:
 *
 *     observed = substrate * (1 - a) + ink * a
 *
 * Coverage is supersampled (default 4x4 sub-samples per pixel) because a glyph
 * edge is not a pixel decision: the printed area ratio rho is what carries the
 * data, and a hard-edged raster would quantise rho far more coarsely than a real
 * printer's spot does.
 *
 * `mono: true` renders every cell in one ink -- the colour channel is then
 * physically absent, which is the single-colour print case the G7 gate checks.
 */

const SUPERSAMPLE = 4;
const MACHINE_INK = [18, 18, 18]; // fiducials + echo strip: always the darkest ink

function composite(pixels, offset, substrate, ink, a) {
  if (a <= 0) return;
  const w = a / 255;
  const iw = 1 - w;
  pixels[offset] = Math.round(substrate[0] * iw + ink[0] * w);
  pixels[offset + 1] = Math.round(substrate[1] * iw + ink[1] * w);
  pixels[offset + 2] = Math.round(substrate[2] * iw + ink[2] * w);
  pixels[offset + 3] = 255;
}

function fillRect(pixels, width, height, x0, y0, x1, y1, rgb) {
  const xa = Math.max(0, Math.round(x0));
  const ya = Math.max(0, Math.round(y0));
  const xb = Math.min(width, Math.round(x1));
  const yb = Math.min(height, Math.round(y1));
  for (let y = ya; y < yb; y++) {
    let o = (y * width + xa) * 4;
    for (let x = xa; x < xb; x++, o += 4) {
      pixels[o] = rgb[0];
      pixels[o + 1] = rgb[1];
      pixels[o + 2] = rgb[2];
      pixels[o + 3] = 255;
    }
  }
}

/** Coverage tile (cellPx x cellPx, 0..255) for one shape level. Shared by every cell. */
export function buildCoverageTiles(cellPx, shapeLevels, glyph = null) {
  const geo = glyph || idealGeometry(shapeLevels);
  const tiles = [];
  const s2 = SUPERSAMPLE * SUPERSAMPLE;
  for (let level = 0; level < shapeLevels; level++) {
    const tile = new Uint8Array(cellPx * cellPx);
    for (let py = 0; py < cellPx; py++) {
      for (let px = 0; px < cellPx; px++) {
        let hits = 0;
        for (let sy = 0; sy < SUPERSAMPLE; sy++) {
          const dy = (py + (sy + 0.5) / SUPERSAMPLE) / cellPx - 0.5;
          for (let sx = 0; sx < SUPERSAMPLE; sx++) {
            const dx = (px + (sx + 0.5) / SUPERSAMPLE) / cellPx - 0.5;
            if (glyphMaskForLevel(dx, dy, level, geo)) hits++;
          }
        }
        tile[py * cellPx + px] = Math.round((hits / s2) * 255);
      }
    }
    tiles.push(tile);
  }
  return tiles;
}

/**
 * @param {object} args
 * @param {object} args.geom      planPage() result
 * @param {Uint16Array} args.levels one level value per cell, row-major (from packLevels)
 * @param {object} args.layout    pageLayout() result
 * @param {string} [args.palette] palette id from core/palette.js
 * @param {boolean} [args.mono]   collapse the colour channel to a single ink
 * @param {Uint8Array|null} [args.echoBits] HEADER_LEN*8 bits to draw in the echo strip
 * @returns {{width:number,height:number,pixels:Uint8Array,dpi:number,layout:object}}
 */
export function renderPageBitmap({ geom, levels, layout, palette = 'INK2', mono = false, echoBits = null }) {
  const pal = getPalette(palette);
  const substrate = pal.background; // the same sheet of material either way
  const { width, height, cellPx } = layout;
  if (!levels || levels.length !== geom.totalCells) {
    throw new RangeError(`renderPageBitmap: expected ${geom.totalCells} levels, got ${levels ? levels.length : 'none'}`);
  }
  const shapeChannel = geom.channels.find((c) => c.name === 'shape');
  if (!shapeChannel) throw new Error('renderPageBitmap: geometry has no shape channel');
  const shapeLevels = shapeChannel.levels;

  const pixels = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    pixels[o] = substrate[0];
    pixels[o + 1] = substrate[1];
    pixels[o + 2] = substrate[2];
    pixels[o + 3] = 255;
  }

  for (const f of layout.fiducials) {
    const half = f.half;
    if (f.solid) {
      fillRect(pixels, width, height, f.x - half, f.y - half, f.x + half, f.y + half, MACHINE_INK);
    } else {
      // one data cell thick: thinner than that does not survive an extrusion
      // width, and the decoder predicts this exact ring from layout.ringPx
      const t = Math.max(1, Math.round(f.ringPx ?? half / 4));
      fillRect(pixels, width, height, f.x - half, f.y - half, f.x + half, f.y + half, MACHINE_INK);
      fillRect(pixels, width, height, f.x - half + t, f.y - half + t, f.x + half - t, f.y + half - t, substrate);
    }
  }

  if (echoBits) {
    const need = layout.echo.bits;
    if (echoBits.length < need) throw new RangeError(`renderPageBitmap: echo needs ${need} bits, got ${echoBits.length}`);
    const e = layout.echo;
    for (let i = 0; i < need; i++) {
      if (!echoBits[i]) continue;
      const cx = i % e.cols;
      const cy = (i / e.cols) | 0;
      fillRect(pixels, width, height, e.x + cx * e.cellPx, e.y + cy * e.cellPx, e.x + (cx + 1) * e.cellPx, e.y + (cy + 1) * e.cellPx, MACHINE_INK);
    }
  }

  // A mono print has no colour channel, so the shape alphabet widens to carry
  // everything it can; a colour print uses the profile's own split.
  const tiles = buildCoverageTiles(cellPx, shapeLevels, layout.glyph);
  const inkCache = new Map();
  const inkFor = (colourLevel) => {
    const key = mono ? 0 : colourLevel;
    let ink = inkCache.get(key);
    if (!ink) {
      ink = pal.inks[key % pal.inks.length];
      inkCache.set(key, ink);
    }
    return ink;
  };

  for (let r = 0; r < geom.rows; r++) {
    for (let c = 0; c < geom.cols; c++) {
      const cell = r * geom.cols + c;
      const parts = splitCellLevel(levels[cell], geom);
      // mono does not move colour bits into the shape alphabet: it deletes them.
      // That erasure is what monoSafe:'full' parity exists to repair.
      const shapeLevel = parts.shape | 0;
      const ink = inkFor(parts.colour | 0);
      const tile = tiles[shapeLevel];
      const x0 = layout.originPx.x + c * cellPx;
      const y0 = layout.originPx.y + r * cellPx;
      for (let py = 0; py < cellPx; py++) {
        const y = y0 + py;
        if (y < 0 || y >= height) continue;
        let o = (y * width + x0) * 4;
        let t = py * cellPx;
        for (let px = 0; px < cellPx; px++, t++, o += 4) {
          const x = x0 + px;
          if (x < 0 || x >= width) continue;
          const a = tile[t];
          if (a) composite(pixels, o, substrate, ink, a);
        }
      }
    }
  }

  // sheetMm rides along so the PDF writer can make the page the paper rather than the code area
  // (DEFECTS D44). pageMm is deliberately NOT attached: the writer derives the content box from
  // width/dpi exactly as it always has, so adding only the sheet leaves every existing byte alone.
  return { width, height, pixels, dpi: layout.dpi, layout, substrate, palette: pal.id, sheetMm: layout.sheetMm ? [layout.sheetMm.w, layout.sheetMm.h] : undefined };
}

/**
 * What rho each shape level *actually measures* when rendered at this cell size.
 *
 * A disc of radius 0.16 cells drawn on a 24px grid does not integrate to its
 * geometric area, and the shortfall is resolution dependent. A decoder that
 * knows the layout can therefore set its decision buckets from these numbers
 * instead of eating the bias as margin -- this is the same loop that
 * `pskit calibrate` closes with a real scan, run here against the renderer.
 */
export function measureTargets(cellPx, shapeLevels, glyph = null) {
  const tiles = buildCoverageTiles(cellPx, shapeLevels, glyph);
  const m = (glyph && glyph.measure) || MEASURE;
  const out = [];
  for (let level = 0; level < shapeLevels; level++) {
    const tile = tiles[level];
    let dot = 0;
    let band = 0;
    for (let py = 0; py < cellPx; py++) {
      for (let px = 0; px < cellPx; px++) {
        const nx = (px + 0.5) / cellPx - 0.5;
        const ny = (py + 0.5) / cellPx - 0.5;
        const rr = Math.hypot(nx, ny);
        const a = tile[py * cellPx + px] / 255;
        if (rr <= m.dotR) dot += a;
        else if (rr >= m.bandIn && rr <= m.bandOut) band += a;
      }
    }
    out.push(band > 0 ? dot / (band * m.bandScale) : 0);
  }
  return out;
}

/** Header bytes -> the bit sequence drawn in the echo strip (MSB first). */
export function echoBitsOf(headerBytes) {
  if (headerBytes.length < HEADER_LEN) throw new RangeError('echoBitsOf: header too short');
  const bits = new Uint8Array(HEADER_LEN * 8);
  for (let i = 0; i < HEADER_LEN; i++) {
    for (let b = 0; b < 8; b++) bits[i * 8 + b] = (headerBytes[i] >> (7 - b)) & 1;
  }
  return bits;
}

/** Physical ink coverage of a rendered page, for the print-pack estimate. */
export function coverageStats({ geom, levels, layout, palette = 'INK2', mono = false }) {
  const shapeChannel = geom.channels.find((c) => c.name !== 'colour') || geom.channels[0];
  const shapeLevels = shapeChannel.levels;
  const tiles = buildCoverageTiles(layout.cellPx, shapeLevels, layout.glyph);
  let sum = 0;
  const perCell = layout.cellPx * layout.cellPx;
  for (let i = 0; i < levels.length; i++) {
    const parts = splitCellLevel(levels[i], geom);
    const shapeLevel = parts.shape | 0;
    let acc = 0;
    const tile = tiles[shapeLevel];
    for (let k = 0; k < perCell; k++) acc += tile[k];
    sum += acc;
  }
  const cellArea = geom.totalCells * perCell;
  return { printedAreaFraction: sum / (cellArea * 255), cells: geom.totalCells, cellPx: layout.cellPx };
}
