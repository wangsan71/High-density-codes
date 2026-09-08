/**
 * One geometry for putting the code area onto a sheet of paper: where the content sits, and which
 * marks belong in the margin. Two writers call this -- core/render/pdf.js to place a vector image
 * and stroke the marks, core/render/raster.js to paint the very same sheet as pixels.
 *
 * Why one module instead of two implementations that "both look right": `--sheet` used to reach the
 * PDF only, so `pskit send --sheet A4 --format png` wrote a 2260x3290 px code area while
 * `--format pdf` wrote a real A4 page (DEFECTS D45). Whoever printed the PNG got no margin, no crop
 * marks, and no say in where the printer put the code on the paper -- and every G2 corpus was fed
 * that shape, which is how two 600 dpi corpora lost fiducials off the edge of the image and got
 * (correctly) refused.
 *
 * All lengths here are millimetres. Mark geometry is expressed as fractions of the margin so a mark
 * can never reach the content box: gap + arm is 0.8 of the margin, and each registration cross stays
 * within 0.3 of its half margin. Ink the decoder was never told about is how a page stops decoding,
 * so "it fits" is arithmetic here rather than a comment.
 */

import { PT_PER_MM } from './units.js';

/**
 * The PDF writer has always skipped marks when the margin is 0.5 pt or less (a sheet the same size
 * as the content leaves nowhere to put one). Expressed in mm from the same PT_PER_MM the PDF uses,
 * so the raster path agrees exactly instead of inventing its own threshold.
 */
export const MARK_MIN_MARGIN_MM = 0.5 / PT_PER_MM;

/** Stroke width the PDF uses for marks: `1 w`, one point. In mm, for the raster path. */
export const MARK_STROKE_MM = 1 / PT_PER_MM;

function posMm(v, who) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
    throw new RangeError(`${who}: expected a positive finite length in mm, got ${v}`);
  }
  return v;
}

/**
 * Where the content box sits on the sheet: centred, with the margin that leaves.
 *
 * @param {{w:number,h:number}} contentMm the code area, in mm
 * @param {{w:number,h:number}} sheetMm   the paper, in mm
 * @param {string} [who] name used in error text, so a failure says which writer asked
 */
export function sheetPlacement(contentMm, sheetMm, who = 'sheetPlacement') {
  const cw = posMm(contentMm && contentMm.w, `${who}: contentMm.w`);
  const ch = posMm(contentMm && contentMm.h, `${who}: contentMm.h`);
  const sw = posMm(sheetMm && sheetMm.w, `${who}: sheetMm.w`);
  const sh = posMm(sheetMm && sheetMm.h, `${who}: sheetMm.h`);
  if (sw < cw - 1e-9 || sh < ch - 1e-9) {
    throw new RangeError(`${who}: sheet ${sw}x${sh}mm cannot carry a ${cw.toFixed(1)}x${ch.toFixed(1)}mm content box`);
  }
  const txMm = (sw - cw) / 2;
  const tyMm = (sh - ch) / 2;
  return {
    contentMm: { w: cw, h: ch },
    sheetMm: { w: sw, h: sh },
    txMm,
    tyMm,
    marginMm: Math.min(txMm, tyMm),
  };
}

/**
 * The marks themselves, as axis-aligned segments in mm: [x1, y1, x2, y2], origin at the sheet's
 * lower-left corner in the PDF's coordinate system and at its top-left once the raster writer flips
 * y (each writer converts; the segment list is the same).
 *
 * Four corner L's just outside the content box, one registration cross centred in each margin.
 * A degenerate sheet (no margin to speak of) returns an empty list and says so, rather than drawing
 * marks that would land on the code area.
 */
export function sheetMarks(contentMm, sheetMm, who = 'sheetMarks') {
  const pl = sheetPlacement(contentMm, sheetMm, who);
  if (pl.marginMm <= MARK_MIN_MARGIN_MM) {
    // Nothing is drawn and nothing is claimed: the sheet then equals the content box, which is the
    // pre-D44 shape, and the caller's own size check still sees a sheet it can judge.
    return { ...pl, gapMm: 0, armMm: 0, crossMm: 0, segments: [], degenerate: true };
  }
  const gapMm = pl.marginMm * 0.25;
  const armMm = pl.marginMm * 0.55;
  const crossMm = pl.marginMm * 0.3;
  const { txMm, tyMm } = pl;
  const { w: cw, h: ch } = pl.contentMm;
  const { w: sw, h: sh } = pl.sheetMm;
  const x0 = txMm;
  const y0 = tyMm;
  const x1 = txMm + cw;
  const y1 = tyMm + ch;
  const segments = [];
  for (const [cx, sx] of [[x0, -1], [x1, 1]]) {
    for (const [cy, sy] of [[y0, -1], [y1, 1]]) {
      const vx = cx + sx * gapMm;
      const hy = cy + sy * gapMm;
      segments.push([vx, hy, vx + sx * armMm, hy]);
      segments.push([vx, hy, vx, hy + sy * armMm]);
    }
  }
  for (const [cx, cy] of [
    [sw / 2, tyMm / 2],
    [sw / 2, sh - tyMm / 2],
    [txMm / 2, sh / 2],
    [sw - txMm / 2, sh / 2],
  ]) {
    segments.push([cx - crossMm, cy, cx + crossMm, cy]);
    segments.push([cx, cy - crossMm, cx, cy + crossMm]);
  }
  return { ...pl, gapMm, armMm, crossMm, segments, degenerate: false };
}
