import { mmToPx, pxToMm } from './units.js';
import { HEADER_LEN } from '../frame.js';
import { QUIET_CELLS, FID_CELLS, ECHO_COLS, MIN_CELL_PX } from './constants.js';

export { QUIET_CELLS, FID_CELLS, ECHO_COLS, MIN_CELL_PX };

/**
 * Page layout: turn a `planPage()` geometry into pixel positions.
 *
 * Canvas, from the outside in:
 *
 *   +--------------------------------------------------+
 *   |  [F]                 echo band                  [F] |   <- top quiet zone + echo strip
 *   |     +----------------------------------------+      |
 *   |     |          data lattice (cols x rows)    |      |
 *   |     +----------------------------------------+      |
 *   |  [F]                                        [f] |   <- [F] solid, [f] hollow: fixes orientation
 *   +--------------------------------------------------+
 *
 * Three solid corner fiducials give the decoder an affine frame; the hollow
 * fourth corner is both a perspective check and the reason a 90- or 180-degree
 * rotation of the sheet can never be mistaken for a valid page.
 */

export const ECHO_ROWS = (HEADER_LEN * 8) / ECHO_COLS; // 8 rows of 56 bits

/**
 * @param {object} geom a planned page from core/profiles.js#planPage
 * @param {number} dpi print resolution
 * @param {{plateMm?:number, sheetMm?:{w:number,h:number}}} opts
 */
export function pageLayout(geom, dpi, opts = {}) {
  if (!(dpi > 0)) throw new RangeError('pageLayout: dpi must be positive');
  const cellPx = mmToPx(geom.pitchMm, dpi);
  if (cellPx < MIN_CELL_PX) {
    throw new RangeError(
      `pageLayout: ${geom.pitchMm}mm pitch is only ${cellPx}px at ${dpi}dpi (min ${MIN_CELL_PX}). Raise the dpi or coarsen the nozzle profile.`,
    );
  }
  // The echo strip is a *micro* lattice: 1 bit per cell, high contrast, so it can
  // be half the data pitch without becoming fragile, and being visibly finer is
  // what keeps the decoder from ever reading it as data.
  const echoPx = Math.max(2, Math.floor(cellPx / 2));
  const echoW = ECHO_COLS * echoPx;
  const echoH = ECHO_ROWS * echoPx;

  // Quiet zone: 6 cells, of which the outer 4 are empty in every direction and
  // the top 6 also carry the echo strip immediately above the lattice.
  const quietPx = QUIET_CELLS * cellPx;
  const latticeW = geom.cols * cellPx;
  const latticeH = geom.rows * cellPx;
  const width = latticeW + quietPx * 2;
  const height = latticeH + quietPx * 2;
  const originX = quietPx;
  const originY = quietPx;

  if (echoW + 2 * quietPx > width) throw new RangeError(`pageLayout: echo strip ${echoW}px does not fit in ${width}px`);
  const echoTop = originY - echoH - Math.floor(cellPx / 2);
  if (echoTop < 0) throw new RangeError(`pageLayout: no room for the echo strip in the top quiet zone (need ${echoH}px)`);
  const echo = {
    x: originX,
    y: echoTop,
    cellPx: echoPx,
    cols: ECHO_COLS,
    rows: ECHO_ROWS,
    bits: HEADER_LEN * 8,
  };

  // Fiducials sit at a fixed inset from the *canvas* corners, so the decoder can
  // recover the lattice origin from them alone.
  const fidHalf = Math.round((FID_CELLS * cellPx) / 2);
  const inset = fidHalf + cellPx;
  const fiducials = [
    { role: 'tl', solid: true, x: inset, y: inset, half: fidHalf },
    { role: 'tr', solid: true, x: width - inset, y: inset, half: fidHalf },
    { role: 'bl', solid: true, x: inset, y: height - inset, half: fidHalf },
    { role: 'br', solid: false, x: width - inset, y: height - inset, half: fidHalf },
  ];
  for (const f of fiducials) {
    if (f.x - f.half < 0 || f.y - f.half < 0 || f.x + f.half > width || f.y + f.half > height) {
      throw new RangeError(`pageLayout: ${f.role} fiducial falls outside the canvas`);
    }
  }
  // the echo strip must not touch a corner marker, or the detector cannot tell them apart
  for (const f of fiducials.filter((x) => x.y < originY)) {
    const overlapX = f.x + f.half > echo.x && f.x - f.half < echo.x + echoW;
    const overlapY = f.y + f.half > echo.y && f.y - f.half < echo.y + echoH;
    if (overlapX && overlapY) {
      throw new RangeError(`pageLayout: echo strip overlaps the ${f.role} fiducial; widen the quiet zone`);
    }
  }

  const phys = {
    wMm: pxToMm(width, dpi),
    hMm: pxToMm(height, dpi),
  };
  const fitMm = opts.sheetMm || (opts.plateMm ? { w: opts.plateMm, h: opts.plateMm } : null);
  if (fitMm && (phys.wMm > fitMm.w + 1e-6 || phys.hMm > fitMm.h + 1e-6)) {
    throw new RangeError(
      `pageLayout: page ${phys.wMm.toFixed(1)}x${phys.hMm.toFixed(1)}mm does not fit ${fitMm.w}x${fitMm.h}mm at ${dpi}dpi`,
    );
  }

  return {
    dpi,
    cellPx,
    cols: geom.cols,
    rows: geom.rows,
    width,
    height,
    pitchMm: geom.pitchMm,
    originPx: { x: originX, y: originY },
    originMm: { x: pxToMm(originX, dpi), y: pxToMm(originY, dpi) },
    quietPx,
    fiducials,
    echo,
    physicalMm: phys,
    /** centre of lattice cell (c, r) in pixels */
    cellCentre(c, r) {
      return { x: originX + (c + 0.5) * cellPx, y: originY + (r + 0.5) * cellPx };
    },
  };
}

/** Inverse of pageLayout's geometry for the decoder: cell size and origin from three fiducials. */
export function layoutFromFiducials(fid, geom) {
  const tl = fid.find((f) => f.role === 'tl');
  const tr = fid.find((f) => f.role === 'tr');
  const bl = fid.find((f) => f.role === 'bl');
  if (!tl || !tr || !bl) throw new Error('layoutFromFiducials: need tl, tr, bl');
  const cellX = (tr.x - tl.x) / geom.cols;
  const cellY = (bl.y - tl.y) / geom.rows;
  return { cellX, cellY, originX: tl.x - cellX * QUIET_CELLS - cellX / 2, originY: tl.y - cellY * QUIET_CELLS - cellY / 2 };
}

/** Human-readable one-liner for the print pack. */
export function describeLayout(layout) {
  return `${layout.cols}x${layout.rows} cells @ ${layout.pitchMm}mm (${layout.cellPx}px @ ${layout.dpi}dpi), ` +
    `page ${layout.physicalMm.wMm.toFixed(1)}x${layout.physicalMm.hMm.toFixed(1)}mm, ` +
    `echo ${layout.echo.cols}x${layout.echo.rows} @ ${layout.echo.cellPx}px`;
}
