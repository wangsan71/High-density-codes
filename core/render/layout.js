import { mmToPx, pxToMm, ewPx } from './units.js';
import { HEADER_LEN } from '../frame.js';
import { getNozzle } from '../nozzles.js';
import { glyphGeometry } from './glyphs.js';
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
  const quietCells = geom.quietCells ?? QUIET_CELLS;
  const latticeCols = geom.moduleCols ?? geom.cols;
  const latticeRows = geom.moduleRows ?? geom.rows;
  const cellPx = mmToPx(geom.pitchMm, dpi);
  const minCellPx = geom.minCellPx ?? MIN_CELL_PX;
  if (cellPx < minCellPx) {
    throw new RangeError(
      `pageLayout: ${geom.pitchMm}mm pitch is only ${cellPx}px at ${dpi}dpi (min ${minCellPx}). Raise the dpi or coarsen the nozzle profile.`,
    );
  }
  // The glyph has to be drawable in whole extrusion widths, so the geometry is
  // derived from the cell size measured in EW -- not from an ideal circle.
  const shapeChannel = (geom.channels || []).find((c) => c.name !== 'colour') || (geom.channels || [])[0];
  const shapeLevels = shapeChannel ? shapeChannel.levels : 2;
  const ewMm = geom.nozzle ? getNozzle(geom.nozzle).ewMm : null;
  // null, not Infinity: paper has no extrusion width to quantise against, and an
  // Infinity in a returned object silently becomes `null` the moment anybody
  // serialises it -- which is how it first escaped into tests/conformance.json.
  const cellEw = ewMm ? geom.pitchMm / ewMm : null;
  const glyph = glyphGeometry(cellEw, shapeLevels);
  if (!glyph.ok) throw new RangeError(`pageLayout: ${glyph.reason} at ${geom.pitchMm}mm / ${geom.nozzle}mm nozzle`);
  // The echo strip is a *micro* lattice: 1 bit per cell, high contrast. Half the
  // data pitch is fine on paper, but on a coarse plate 56 bits at half pitch can
  // be wider than the plate, so the strip shrinks -- never below one extrusion
  // width, and never below what fits the canvas.
  const ewPxGuess = geom.nozzle ? ewPx(geom.nozzle, dpi) : 2;
  const latticeW0 = latticeCols * cellPx;
  const quietGuess = quietCells * cellPx;
  const echoFloor = Number.isFinite(geom.echoMinPx) ? Math.max(2, geom.echoMinPx) : 0;
  let echoPx = 0;
  for (const div of [2, 3, 4, 5, 6, 8, 10, 12]) {
    const cand = Math.max(echoFloor, Math.floor(cellPx / div));
    if (cand < Math.max(2, ewPxGuess)) break;
    if (ECHO_COLS * cand + 2 * quietGuess <= latticeW0 + 2 * quietGuess) {
      echoPx = cand;
      break;
    }
  }
  if (!echoPx) echoPx = Math.max(2, Math.floor(cellPx / 16));
  const echoW = ECHO_COLS * echoPx;
  const echoH = ECHO_ROWS * echoPx;

  // Quiet zone: quietCells cells all round; the top band also carries the echo
  // strip immediately above the lattice.
  const quietPx = quietCells * cellPx;
  const latticeW = latticeCols * cellPx;
  const latticeH = latticeRows * cellPx;
  // A coarse profile can have fewer data cells across than the echo strip has
  // bits (56), so the canvas takes the wider of the two and the lattice centres
  // inside it. The plate is bigger than both; there is nothing to gain from
  // refusing.
  const width = Math.max(latticeW, echoW) + quietPx * 2;
  const height = latticeH + quietPx * 2;
  const originX = Math.round((width - latticeW) / 2);
  const originY = quietPx;

  if (echoW + 2 * quietPx > width) throw new RangeError(`pageLayout: echo strip ${echoW}px does not fit in ${width}px`);
  const echoTop = originY - echoH - Math.floor(cellPx / 2);
  if (echoTop < 0) throw new RangeError(`pageLayout: no room for the echo strip in the top quiet zone (need ${echoH}px)`);
  const echo = {
    // left-aligned to the quiet zone, not to the (possibly centred) lattice, so a
    // strip wider than the lattice cannot run under the right-hand markers
    x: quietPx,
    y: echoTop,
    cellPx: echoPx,
    cols: ECHO_COLS,
    rows: ECHO_ROWS,
    bits: HEADER_LEN * 8,
  };

  // Fiducials sit at a fixed inset from the *canvas* corners, so the decoder can
  // recover the lattice origin from them alone.
  const fidHalf =
    geom.physicalEncoding === 'module'
      ? geom.fidHalfPx ?? Math.max(Math.round((FID_CELLS * cellPx) / 2), 20)
      : Math.round((FID_CELLS * cellPx) / 2);
  const inset = fidHalf + cellPx;
  const fiducials = [
    { role: 'tl', solid: true, x: inset, y: inset, half: fidHalf },
    { role: 'tr', solid: true, x: width - inset, y: inset, half: fidHalf },
    { role: 'bl', solid: true, x: inset, y: height - inset, half: fidHalf },
    { role: 'br', solid: false, x: width - inset, y: height - inset, half: fidHalf },
  ];
  const fidRing =
    geom.physicalEncoding === 'module' && geom.fidRingPx
      ? geom.fidRingPx
      : Math.max(1, Math.max(cellPx, Math.ceil(ewPxGuess)));
  for (const f of fiducials) f.ringPx = fidRing;
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
    moduleCols: geom.moduleCols ?? null,
    moduleRows: geom.moduleRows ?? null,
    width,
    height,
    pitchMm: geom.pitchMm,
    quietCells,
    cellEw,
    glyph,
    shapeLevels,
    originPx: { x: originX, y: originY },
    originMm: { x: pxToMm(originX, dpi), y: pxToMm(originY, dpi) },
    quietPx,
    fiducials,
    echo,
    physicalMm: phys,
    /**
     * The paper this layout was fitted to, or null when it was fitted to a plate (or to nothing).
     * Recorded because the PDF writer needs the sheet, not the code area: a page whose MediaBox is
     * the code area prints at the right size but is not the paper the user loaded, leaves no margin
     * for crop marks, and invites the "fit to page" click that scales the geometry (DEFECTS D44/D8).
     * Plates deliberately get null -- their artifact is 3MF/STL, and marks on a plate PDF are noise.
     */
    sheetMm: opts.sheetMm ? { w: opts.sheetMm.w, h: opts.sheetMm.h } : null,
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
  const latticeCols = geom.moduleCols ?? geom.cols;
  const latticeRows = geom.moduleRows ?? geom.rows;
  const cellX = (tr.x - tl.x) / latticeCols;
  const cellY = (bl.y - tl.y) / latticeRows;
  const quietCells = geom.quietCells ?? QUIET_CELLS;
  return { cellX, cellY, originX: tl.x - cellX * quietCells - cellX / 2, originY: tl.y - cellY * quietCells - cellY / 2 };
}

/** Human-readable one-liner for the print pack. */
export function describeLayout(layout) {
  return `${layout.cols}x${layout.rows} cells @ ${layout.pitchMm}mm (${layout.cellPx}px @ ${layout.dpi}dpi), ` +
    `page ${layout.physicalMm.wMm.toFixed(1)}x${layout.physicalMm.hMm.toFixed(1)}mm, ` +
    `echo ${layout.echo.cols}x${layout.echo.rows} @ ${layout.echo.cellPx}px`;
}
