/**
 * MTF / resolution calibration plate (docs/PLAN.md §3.4) — the **generator** half.
 *
 * PLAN asks for "a nozzle-independent MTF calibration plate (0.6/0.9/1.2/1.8/2.4mm step
 * cells + two-colour samples + texture samples + a ruler)", and for the capture to yield
 * "the measured stable minimum cell pitch, colour-channel separation and white-balance
 * drift", from which a nozzle/pitch is recommended. This file is the plate: what is drawn
 * where, in millimetres, with the ground truth of every patch recorded next to it.
 * The reader is `core/calibrate/readmtf.js`; neither half knows the other's internals.
 *
 * Why "nozzle-independent" is a real property here, not a slogan: **the spec has no nozzle
 * parameter**. Every patch is a fraction of its own pitch or a fixed size in millimetres,
 * so the same plate file is printed by a 0.2 mm hot end and by a 0.8 mm hot end, and the
 * measurement says which of the two the result actually supports. The printer's own
 * quantisation happens in the printer (or, for simulation only, through the optional
 * `printEwMm` argument of `renderMtfPlate`, which is labelled as an emulation and never
 * used by the reader).
 *
 * What each part measures, and why it is shaped the way it is:
 *
 *   pitch ladder    five 24 mm blocks at 0.6/0.9/1.2/1.8/2.4 mm, each a *solid field with a
 *                   grid of square holes* (hole = 0.4 x pitch, ink between holes = 0.6 x
 *                   pitch). A solid field with holes, not a checkerboard of separate cells,
 *                   for two measured reasons: (a) separated solid cells are isolated square
 *                   components, and a block of 40 of them at 2.4 mm outcompetes the four
 *                   corner markers as a "same-size square cluster" — the marker detector
 *                   would then register the plate against its own data (the same failure
 *                   mode D37 records); (b) the hole has a *local* reference all around it,
 *                   so the reading of one cell cannot be moved by vignetting or glare.
 *   feature ladder  holes of 0.3/0.45/0.6/0.9/1.2 mm, each alone in a 3 mm cell of a solid
 *                   block. This is the one measurement that isolates **feature** size from
 *                   **pitch**: with a 3 mm pitch the ink gap is >= 1.8 mm for every rung, so
 *                   nothing about the rung is near the print or capture limit except the
 *                   hole itself. The smallest hole that still reads as open is the resolution
 *                   floor F of this print+capture chain.
 *   colour samples  one solid patch per ink of the palette, on the same substrate. The reader
 *                   compares them with the palette it was told was printed, using the decoder's
 *                   own `nearestLevel` descriptor — so "separation" means the separation this
 *                   product needs, not a number invented here.
 *   texture samples solid vs ribbed (0.4 mm top-skin period, vertical and horizontal). The
 *                   ribbed patches are the "texture channel" of PLAN §2; the measurement is
 *                   their modulation depth against the solid patch, reported, never enforced.
 *   ruler           a 150 mm bar with 1 mm ticks and 10 mm majors. Two uses: it gives an
 *                   independent pixel-per-mm reading inside the rectified plate, and it is
 *                   the physical 100 mm reference a user measures with a real ruler to settle
 *                   D8 (print scaling) — the plate cannot detect a *uniform* scale by itself,
 *                   because the fiducial registration absorbs exactly that.
 *   four markers    the same three-solid-one-hollow convention as a data page
 *                   (`core/render/layout.js`), sized on a 2.4 mm frame cell so they survive
 *                   the coarsest capture, so the reader can register the plate with the
 *                   decoder's own `findMarkers` + `rectifyPage`.
 *
 * Honest limits, so nobody reads more into this than it does:
 *
 *   - F is a **joint** print+capture floor. A hole that never printed (hole < 1 EW) and a hole
 *     that printed but is optically filled both read as closed. Separating the two needs a
 *     second capture at a different distance, which this plate does not ask for.
 *   - The plate is **not** the 3MF/STL artifact. `renderMtfPlate` produces the *appearance*
 *     raster (what a camera or scanner sees from above), which is what the channel simulator
 *     and every other plate-profile test in this repo consume. The mesh half (a printable
 *     STL/3MF of the same plate) is not written yet — see docs/DEFECTS.md.
 *   - No threshold in this file is fitted to a sample: the reader's cuts are stated as physical
 *     statements ("the hole is at least 75% open") and the ladder's monotonicity is checked
 *     against an injected blur (tests/unit/mtfplate.test.mjs) and against the Python channel
 *     (tools/mtf-probe.mjs).
 *
 * Pure ESM, zero dependencies, no `node:` imports: Node and the browser run this same file.
 */
import { getPalette } from '../palette.js';
import { mmToPx, pxToMm, MM_PER_INCH } from '../render/units.js';
import { FID_CELLS } from '../render/constants.js';
import { idealGeometry } from '../render/glyphs.js';
import { NOZZLES } from '../nozzles.js';

/** Spec version; the reader refuses a spec it does not know. */
export const MTF_PLATE_VERSION = 1;

/** PLAN §3.4's step-cell pitches, coarsest last. */
export const MTF_RUNGS_MM = [0.6, 0.9, 1.2, 1.8, 2.4];

/** Hole side as a fraction of the rung's pitch: 0.4 leaves 0.6 of ink between holes. */
export const MTF_HOLE_FRACTION = 0.4;

/**
 * Feature-ladder hole sizes (mm), smallest first.
 *
 * The four nozzles' extrusion widths are rungs **by construction** (0.26 / 0.45 / 0.7 / 0.95,
 * from `core/nozzles.js`), so "which nozzle can this chain resolve?" is a direct read of the
 * ladder rather than an inference from an interval. The three in-between sizes (0.3 / 0.6 / 0.9)
 * are there so a floor that lands between two nozzles is visible as such, and 1.2 bounds the
 * coarsest case. This list is derived from NOZZLES, not typed twice: a nozzle whose EW changes
 * without this ladder following would make the recommendation silently untestable.
 */
export const MTF_FEATURE_MM = Array.from(
  new Set([...Object.values(NOZZLES).map((n) => n.ewMm), 0.3, 0.6, 0.9, 1.2]),
).sort((a, b) => a - b);

/** The feature ladder's own pitch: big enough that only the hole can be the limit. */
export const MTF_FEATURE_PITCH_MM = 3.0;

/** Frame cell (mm) the corner markers are sized on: the coarsest rung, so they survive. */
export const MTF_FRAME_CELL_MM = 2.4;

/** Top-skin texture period (mm) of the ribbed patches. */
export const MTF_TEXTURE_PERIOD_MM = 0.4;

/** Default plate side (mm) and raster resolution (px/inch) of the appearance render. */
export const MTF_PLATE_MM = 200;
export const MTF_DPI = 300;

const round4 = (x) => Math.round(x * 1e4) / 1e4;

function rectPxOf(rectMm, dpi) {
  const x = mmToPx(rectMm.x, dpi);
  const y = mmToPx(rectMm.y, dpi);
  return {
    x,
    y,
    w: Math.max(1, mmToPx(rectMm.x + rectMm.w, dpi) - x),
    h: Math.max(1, mmToPx(rectMm.y + rectMm.h, dpi) - y),
  };
}

/**
 * Build the plate specification.
 *
 * @param {object} [opts]
 * @param {number} [opts.plateMm=200]   plate side in mm
 * @param {number} [opts.dpi=300]       raster resolution of the appearance render
 * @param {string} [opts.palette='INK2'] palette id (decides how many colour samples exist)
 * @param {number[]} [opts.rungs]       pitch ladder, mm
 * @param {number[]} [opts.features]    feature ladder, mm
 * @returns {object} JSON-safe spec
 */
export function mtfPlateSpec(opts = {}) {
  const plateMm = Number(opts.plateMm ?? MTF_PLATE_MM);
  const dpi = Number(opts.dpi ?? MTF_DPI);
  const paletteId = opts.palette || 'INK2';
  const rungs = (opts.rungs || MTF_RUNGS_MM).slice();
  const features = (opts.features || MTF_FEATURE_MM).slice();
  if (!(plateMm > 40)) throw new RangeError(`mtfPlateSpec: plateMm ${plateMm} is too small to hold the plate`);
  if (!(dpi > 0)) throw new RangeError(`mtfPlateSpec: dpi ${dpi}`);
  const pal = getPalette(paletteId);

  const width = mmToPx(plateMm, dpi);
  const height = width;
  const marginMm = 6;

  // --- corner markers: the data-page convention, on the coarsest frame cell -------------
  const frameCellPx = mmToPx(MTF_FRAME_CELL_MM, dpi);
  const fidHalf = Math.round((FID_CELLS * frameCellPx) / 2);
  const inset = fidHalf + frameCellPx;
  const fiducials = [
    { role: 'tl', solid: true, x: inset, y: inset, half: fidHalf },
    { role: 'tr', solid: true, x: width - inset, y: inset, half: fidHalf },
    { role: 'bl', solid: true, x: inset, y: height - inset, half: fidHalf },
    { role: 'br', solid: false, x: width - inset, y: height - inset, half: fidHalf },
  ];
  const ringPx = Math.max(1, frameCellPx);
  for (const f of fiducials) f.ringPx = ringPx;

  // --- pitch ladder: five 24 mm blocks, centred ----------------------------------------
  const patchMm = 24;
  const gapMm = 6;
  const rowAy = 20;
  const ladderW = rungs.length * patchMm + (rungs.length - 1) * gapMm;
  const rowAx = round4((plateMm - ladderW) / 2);
  const pitchLadder = rungs.map((pitchMmNominal, i) => {
    const cellPx = mmToPx(pitchMmNominal, dpi);
    const pitchMm = round4((cellPx * MM_PER_INCH) / dpi);
    const cols = Math.floor(mmToPx(patchMm, dpi) / cellPx);
    const rows = cols;
    const xMm = rowAx + i * (patchMm + gapMm);
    const originX = mmToPx(xMm, dpi);
    const originY = mmToPx(rowAy, dpi);
    const holeSideMm = round4(MTF_HOLE_FRACTION * pitchMm);
    const holeSidePx = Math.max(1, Math.min(cellPx - 2, mmToPx(holeSideMm, dpi)));
    return {
      id: `pitch-${String(pitchMmNominal).replace('.', 'p')}`,
      kind: 'pitch',
      pitchMmNominal,
      pitchMm,
      cellPx,
      cols,
      rows,
      originPx: { x: originX, y: originY },
      originMm: { x: pxToMm(originX, dpi), y: pxToMm(originY, dpi) },
      holeFraction: MTF_HOLE_FRACTION,
      holeSideMm,
      holeSidePx,
      rectMm: { x: xMm, y: rowAy, w: round4((cols * cellPx * MM_PER_INCH) / dpi), h: round4((rows * cellPx * MM_PER_INCH) / dpi) },
    };
  });

  // --- feature ladder: isolated holes in a solid block ----------------------------------
  const rowBy = 52;
  const featurePitchPx = mmToPx(MTF_FEATURE_PITCH_MM, dpi);
  const featureBlockMm = { x: 28, y: rowBy, w: 10 * features.length, h: 16 };
  const featureCells = features.map((sizeMm, i) => {
    const cxMm = featureBlockMm.x + 5 + i * 10;
    const cyMm = rowBy + featureBlockMm.h / 2;
    const sizePx = Math.max(1, mmToPx(sizeMm, dpi));
    const originX = mmToPx(cxMm, dpi) - (featurePitchPx >> 1);
    const originY = mmToPx(cyMm, dpi) - (featurePitchPx >> 1);
    return {
      id: `feature-${String(sizeMm).replace('.', 'p')}`,
      kind: 'feature',
      sizeMm,
      sizePx,
      cellPx: featurePitchPx,
      originPx: { x: originX, y: originY },
      centrePx: { x: mmToPx(cxMm, dpi), y: mmToPx(cyMm, dpi) },
      centreMm: { x: cxMm, y: cyMm },
    };
  });

  // --- colour samples: one solid patch per ink -----------------------------------------
  const colourSlots = 4;
  const colourSizeMm = 16;
  const colourGapMm = 4;
  const colourW = colourSlots * colourSizeMm + (colourSlots - 1) * colourGapMm;
  const colourX0 = round4(plateMm - marginMm - colourW);
  const colourSamples = [];
  for (let i = 0; i < Math.min(colourSlots, pal.inks.length); i++) {
    const xMm = colourX0 + i * (colourSizeMm + colourGapMm);
    const rectMm = { x: xMm, y: rowBy, w: colourSizeMm, h: colourSizeMm };
    colourSamples.push({ id: `ink${i}`, kind: 'ink', inkLevel: i, rectMm, rectPx: rectPxOf(rectMm, dpi) });
  }

  // --- texture samples: solid vs ribbed, both directions --------------------------------
  const rowCy = 76;
  const textureSamples = [
    { id: 'tex-solid', kind: 'solid' },
    { id: 'tex-ribbed-v', kind: 'ribbed-v' },
    { id: 'tex-ribbed-h', kind: 'ribbed-h' },
  ].map((t, i) => {
    const rectMm = { x: 28 + i * (patchMm + gapMm), y: rowCy, w: patchMm, h: patchMm };
    return { ...t, periodMm: MTF_TEXTURE_PERIOD_MM, rectMm, rectPx: rectPxOf(rectMm, dpi) };
  });

  // --- 10 mm scale square, centred in its own 24 mm slot --------------------------------
  const scaleRectMm = { x: 118 + (patchMm - 10) / 2, y: rowCy + (patchMm - 10) / 2, w: 10, h: 10 };

  // --- ruler: 150 mm bar, 1 mm ticks, 10 mm majors --------------------------------------
  const ruler = {
    x0Mm: 20,
    x1Mm: 170,
    barMm: { x: 20, y: 178, w: 150, h: 2 },
    barPx: rectPxOf({ x: 20, y: 178, w: 150, h: 2 }, dpi),
    tickPeriodMm: 1,
    majorEvery: 10,
    tickWidthMm: 0.4,
    tickHeightMm: 2,
    majorHeightMm: 6,
    tickTopMm: 176,
    majorTopMm: 172,
  };
  ruler.ticks = [];
  for (let k = 0; k * ruler.tickPeriodMm <= 150 + 1e-9; k++) {
    const xMm = ruler.x0Mm + k * ruler.tickPeriodMm;
    const major = k % ruler.majorEvery === 0;
    ruler.ticks.push({
      k,
      xMm: round4(xMm),
      major,
      rectMm: { x: round4(xMm - ruler.tickWidthMm / 2), y: major ? ruler.majorTopMm : ruler.tickTopMm, w: ruler.tickWidthMm, h: major ? ruler.majorHeightMm : ruler.tickHeightMm },
    });
  }

  return {
    version: MTF_PLATE_VERSION,
    kind: 'pskt-mtf-plate',
    plateMm,
    dpi,
    palette: paletteId,
    width,
    height,
    marginMm,
    frameCellMm: MTF_FRAME_CELL_MM,
    frameCellPx,
    fiducials,
    pitchLadder,
    featureBlockMm,
    featureBlockPx: rectPxOf(featureBlockMm, dpi),
    featureLadder: featureCells,
    featurePitchMm: MTF_FEATURE_PITCH_MM,
    colourSamples,
    textureSamples,
    scaleSquare: { sizeMm: 10, rectMm: scaleRectMm, rectPx: rectPxOf(scaleRectMm, dpi) },
    ruler,
    /** Ground truth the reader compares against. Recorded, never assumed. */
    nominal: {
      background: pal.background.slice(),
      inks: pal.inks.map((c) => c.slice()),
      minStablePitchPredictedMm: null, // filled by the reader, not by the spec
    },
  };
}

/** The layout object `rectifyPage`/`analyseCell` expect, for a plate spec. */
export function mtfPlateLayout(spec) {
  if (!spec || spec.kind !== 'pskt-mtf-plate') throw new Error('mtfPlateLayout: not an MTF plate spec');
  if (spec.version !== MTF_PLATE_VERSION) {
    throw new Error(`mtfPlateLayout: spec version ${spec.version} is not ${MTF_PLATE_VERSION} (regenerate the plate)`);
  }
  return {
    dpi: spec.dpi,
    width: spec.width,
    height: spec.height,
    cellPx: spec.frameCellPx,
    pitchMm: spec.frameCellMm,
    glyph: idealGeometry(2),
    originPx: { x: 0, y: 0 },
    fiducials: spec.fiducials.map((f) => ({ ...f })),
  };
}

/**
 * Render the plate's appearance.
 *
 * @param {object} spec  from mtfPlateSpec
 * @param {object} [opts]
 * @param {number} [opts.printEwMm=0]  SIMULATION ONLY: emulate a printer whose smallest
 *   printable feature is this wide, by snapping every hole to a whole number of them and
 *   filling a hole that cannot be printed with at least one feature width of ink on each
 *   side. 0 (the default) draws the design as specified — no printer, no quantisation.
 * @returns {{width:number,height:number,pixels:Uint8Array,dpi:number,substrate:number[],printEwMm:number}}
 */
export function renderMtfPlate(spec, opts = {}) {
  const { width, height, dpi } = spec;
  const pal = getPalette(spec.palette);
  const substrate = pal.background;
  const ink = pal.inks[0];
  const ewMm = Number(opts.printEwMm || 0);
  if (ewMm < 0 || !Number.isFinite(ewMm)) throw new RangeError(`renderMtfPlate: printEwMm ${opts.printEwMm}`);
  const ewPx = ewMm > 0 ? (ewMm * dpi) / MM_PER_INCH : 0;

  const pixels = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    pixels[o] = substrate[0];
    pixels[o + 1] = substrate[1];
    pixels[o + 2] = substrate[2];
    pixels[o + 3] = 255;
  }
  const fill = (rect, rgb) => {
    const x0 = Math.max(0, Math.round(rect.x));
    const y0 = Math.max(0, Math.round(rect.y));
    const x1 = Math.min(width, Math.round(rect.x + rect.w));
    const y1 = Math.min(height, Math.round(rect.y + rect.h));
    for (let y = y0; y < y1; y++) {
      let o = (y * width + x0) * 4;
      for (let x = x0; x < x1; x++, o += 4) {
        pixels[o] = rgb[0];
        pixels[o + 1] = rgb[1];
        pixels[o + 2] = rgb[2];
        pixels[o + 3] = 255;
      }
    }
  };

  // pitch ladder: solid block, then punch the hole grid
  for (const rung of spec.pitchLadder) {
    const { originPx, cellPx, cols, rows } = rung;
    fill({ x: originPx.x, y: originPx.y, w: cols * cellPx, h: rows * cellPx }, ink);
    let holePx = rung.holeSidePx;
    if (ewPx > 0) {
      // A hole narrower than one feature width is not printed at all -- the solid fill closes
      // over it -- and a printer cannot compensate by making it wider, which is why this is a
      // *fill*, not a round-up. A hole whose ink rim is thinner than one feature width merges
      // with its neighbours and closes for the same reason.
      if (rung.holeSideMm < ewMm - 1e-9) continue;
      const holeEw = Math.max(1, Math.round(holePx / ewPx));
      const gapMm = rung.pitchMm - (holeEw * ewPx * MM_PER_INCH) / dpi;
      if (gapMm < ewMm - 1e-9) continue;
      holePx = Math.round(holeEw * ewPx);
    }
    if (holePx < 1 || holePx > cellPx - 2) continue;
    const off = Math.floor((cellPx - holePx) / 2);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        fill({ x: originPx.x + c * cellPx + off, y: originPx.y + r * cellPx + off, w: holePx, h: holePx }, substrate);
      }
    }
  }

  // feature ladder: solid block, one hole per cell
  {
    const b = spec.featureBlockPx;
    fill({ x: b.x, y: b.y, w: b.w, h: b.h }, ink);
    for (const cell of spec.featureLadder) {
      let sizePx = cell.sizePx;
      if (ewPx > 0) {
        // Same rule as the pitch ladder: below one feature width the hole is filled, not
        // rounded up to the feature width.
        if (cell.sizeMm < ewMm - 1e-9) continue;
        sizePx = Math.round(Math.max(1, Math.round(sizePx / ewPx)) * ewPx);
      }
      const cx = cell.centrePx.x;
      const cy = cell.centrePx.y;
      fill({ x: cx - sizePx / 2, y: cy - sizePx / 2, w: sizePx, h: sizePx }, substrate);
    }
  }

  // colour samples
  for (const s of spec.colourSamples) {
    fill(s.rectPx, pal.inks[s.inkLevel % pal.inks.length]);
  }

  // texture samples
  for (const t of spec.textureSamples) {
    const r = t.rectPx;
    if (t.kind === 'solid') {
      fill(r, ink);
      continue;
    }
    const periodPx = Math.max(2, Math.round((t.periodMm * dpi) / MM_PER_INCH));
    const barPx = Math.max(1, Math.round(periodPx / 2));
    for (let k = 0; k * periodPx < (t.kind === 'ribbed-h' ? r.h : r.w); k++) {
      if (t.kind === 'ribbed-h') fill({ x: r.x, y: r.y + k * periodPx, w: r.w, h: barPx }, ink);
      else fill({ x: r.x + k * periodPx, y: r.y, w: barPx, h: r.h }, ink);
    }
  }

  // 10 mm scale square
  fill(spec.scaleSquare.rectPx, ink);

  // ruler bar + ticks
  fill(spec.ruler.barPx, ink);
  for (const t of spec.ruler.ticks) fill(rectPxOf(t.rectMm, dpi), ink);

  // corner markers, same convention as a data page
  for (const f of spec.fiducials) {
    const rect = { x: f.x - f.half, y: f.y - f.half, w: 2 * f.half, h: 2 * f.half };
    fill(rect, ink);
    if (!f.solid) fill({ x: rect.x + f.ringPx, y: rect.y + f.ringPx, w: rect.w - 2 * f.ringPx, h: rect.h - 2 * f.ringPx }, substrate);
  }

  return { width, height, pixels, dpi, substrate: substrate.slice(), printEwMm: ewMm };
}

/** One-line human summary, for the CLI. */
export function describeMtfPlate(spec) {
  const rungs = spec.pitchLadder.map((r) => `${r.pitchMmNominal}mm(${r.cols}x${r.rows}@${r.cellPx}px)`).join(' ');
  return (
    `MTF plate ${spec.plateMm}x${spec.plateMm}mm @ ${spec.dpi}dpi, palette ${spec.palette}: ` +
    `pitch ladder ${rungs}; feature ladder ${spec.featureLadder.map((f) => `${f.sizeMm}mm`).join(' ')}; ` +
    `${spec.colourSamples.length} colour sample(s), ${spec.textureSamples.length} texture sample(s), ` +
    `ruler ${spec.ruler.x1Mm - spec.ruler.x0Mm}mm, ${spec.fiducials.length} markers`
  );
}
