/**
 * Shape-glyph geometry: the nozzle-invariant half of the code.
 *
 * Each cell prints a *reference annulus* plus an optional centre dot, both in
 * the cell's own ink. The data is the ratio
 *
 *     rho = dotArea / annulusArea
 *
 * Because every radius is a fraction of the cell size, scaling the whole plate
 * up or down (different nozzle, different extrusion multiplier, different scan
 * zoom) leaves rho untouched, and a phone camera only has to recover an area
 * ratio -- which it can do from a distance even when the absolute feature size
 * is near the print resolution.
 *
 * Using the *same ink* for ring and dot is deliberate: the shape channel stays
 * measurable on a cell whose colour is black, which a "black feature on a
 * coloured patch" scheme cannot do. It also means a single-material print keeps
 * the whole shape channel alive while the colour channel is erased -- exactly
 * the monoSafe:'full' recovery path.
 *
 * All radii are normalised to cell half-width = 0.5, so (dx, dy) in [-0.5, 0.5].
 */

/** Outer radius of the reference annulus (fraction of the cell edge). */
const ANNULUS_OUTER = 0.47;
/**
 * Cell width (in extrusion widths) at or above which the ideal fractional
 * geometry is used as-is: the extrusion is now so fine relative to the cell that
 * rounding to whole EWs costs less than the process noise already present, so
 * quantising would be theatre. Also the ceiling of the quantisation search.
 */
const IDEAL_CROSSOVER_EW = 24;
/** Inner radius of the reference annulus. */
export const ANNULUS_INNER = 0.38;
/** Annulus area as a fraction of the cell area: pi*(R^2 - r^2), cell = 1 unit^2. */
export const ANNULUS_AREA = Math.PI * (ANNULUS_OUTER ** 2 - ANNULUS_INNER ** 2);

/**
 * Measurement regions, shared by the renderer's self-check and every decoder.
 *
 * The dot is read inside `dotR`, which is big enough to contain the largest
 * printed dot and small enough to stay clear of the annulus. The ring is read in
 * the guard sub-band [bandIn, bandOut], which excludes both soft edges, then
 * scaled up to the full annulus area. Without those guards the ring's inner edge
 * bleeds into the dot measurement and inflates rho by ~0.05 -- enough to eat a
 * third of the decision margin at four levels.
 */
export const MEASURE = {
  dotR: 0.3,
  bandIn: 0.4,
  bandOut: 0.455,
};
MEASURE.bandGuardArea = Math.PI * (MEASURE.bandOut ** 2 - MEASURE.bandIn ** 2);
/** Multiply a guard-band coverage sum by this to estimate the full annulus area. */
MEASURE.bandScale = ANNULUS_AREA / MEASURE.bandGuardArea;
/** Largest dot radius we ever print (rho == RHO_HI). */
const MAX_DOT_RADIUS = 0.28;

/** Smallest / largest rho we ever print. */
const RHO_LO = 0.3;
const RHO_HI = (Math.PI * MAX_DOT_RADIUS ** 2) / ANNULUS_AREA;

/** Target rho for a shape level. Level 0 prints no dot at all. */
export function rhoFor(level, levels) {
  if (!(levels >= 2)) throw new RangeError('rhoFor: needs at least 2 levels');
  if (level < 0 || level >= levels) throw new RangeError(`rhoFor: level ${level} out of range 0..${levels - 1}`);
  if (level === 0) return 0;
  return RHO_LO + ((RHO_HI - RHO_LO) * (level - 1)) / (levels - 1);
}

export function rhoTable(levels) {
  return Array.from({ length: levels }, (_, i) => rhoFor(i, levels));
}

/** Dot radius (normalised) that yields the requested rho, or 0 for no dot. */
export function dotRadiusForRho(rho) {
  if (rho <= 0) return 0;
  const r = Math.sqrt((rho * ANNULUS_AREA) / Math.PI);
  if (r > ANNULUS_INNER) {
    throw new RangeError(`dot radius ${r.toFixed(4)} would merge into the annulus (max ${ANNULUS_INNER})`);
  }
  return r;
}

/** Inverse: what rho does a dot of this normalised radius represent? */
export function rhoForDotRadius(rNorm) {
  return (Math.PI * rNorm * rNorm) / ANNULUS_AREA;
}

/**
 * Decision thresholds for a measured rho: boundaries midway between the printed
 * targets, with an explicit low cut that means "no dot" and a high cut that
 * means "the cell is a blob -- erase it".
 *
 * `opts.targets` lets a caller substitute *measured* targets. That matters: at
 * finite resolution the integrated rho of a small dot is systematically a few
 * hundredths below the geometric target, and a decoder that knows the cell size
 * can compute the real expected values instead of eating the bias as lost margin
 * (core/render/raster.js#measureTargets does exactly that; `pskit calibrate` does
 * it from a real scan).
 * @returns {{mid:number[], noDot:number, blob:number, levels:number, targets:number[]}}
 */
export function shapeThresholds(levels, opts = {}) {
  const t = opts.targets ? Array.from(opts.targets) : rhoTable(levels);
  if (t.length !== levels) throw new RangeError(`shapeThresholds: ${t.length} targets for ${levels} levels`);
  const mid = [];
  for (let i = 1; i < t.length; i++) mid.push((t[i - 1] + t[i]) / 2);
  return {
    levels,
    targets: t,
    calibrated: !!opts.targets,
    mid,
    noDot: mid.length ? Math.max(t[0], mid[0] * 0.55) : t[0] * 2,
    blob: 1.28, // measured rho this high means overlapping cells, not a level
  };
}

/** Classify a measured rho into a shape level, or null when un trustworthy. */
export function levelFromRho(rho, thresholds) {
  if (!(rho >= 0) || rho > thresholds.blob) return null;
  if (rho < thresholds.noDot) return 0;
  for (let i = 0; i < thresholds.mid.length; i++) {
    if (rho < thresholds.mid[i]) return i; // i >= 1 because noDot < mid[0]
  }
  return thresholds.levels - 1;
}

/**
 * Is the point (dx, dy) inside the printed part of a glyph of this rho?
 * Used by both the raster renderer and the mesh renderer, so a plate and its
 * paper preview can never disagree about what a glyph *is*.
 */
export function glyphMask(dx, dy, rho) {
  const r2 = dx * dx + dy * dy;
  if (r2 <= ANNULUS_INNER * ANNULUS_INNER) {
    const rd = dotRadiusForRho(rho);
    return rd > 0 && r2 <= rd * rd;
  }
  return r2 <= ANNULUS_OUTER * ANNULUS_OUTER;
}

/** Fraction of the cell area that gets printed for a given rho (ink budget). */
export function printedAreaFraction(rho) {
  return ANNULUS_AREA + Math.PI * dotRadiusForRho(rho) ** 2;
}

/**
 * Glyph geometry as a function of cell size **measured in extrusion widths**.
 *
 * The unit-circle design above is what a 600 dpi sheet produces. On an FDM plate
 * nothing smaller than about one extrusion width (EW) survives the process, and
 * the phone has to resolve the result: a ring 0.09 cells thick on a 4-EW cell is
 * 0.36 EW, and the 0.25-EW gap between neighbouring rings bridges under any real
 * blur -- in simulation the whole lattice merges into one blob. So on plates
 * every radius below is a whole number of EW:
 *
 *     printed-to-printed gap   >= 1 EW      (cell >= 2*outer + 1)
 *     ring thickness           >= 1 EW      (outer - inner)
 *     dot-to-ring clearance    >= 1 EW      (inner - maxDot)
 *     smallest printable dot   = 1 EW radius
 *
 * Because levels are linear in *area*, the k-th dot radius is
 * maxDot*sqrt(k/(L-1)), so a L-level alphabet needs maxDot >= sqrt(L-1) EW.
 * That works out to >= 7 EW per cell for 2 levels and >= 9 for 4. When the cell
 * is too small we return ok:false with the requirement instead of emitting a
 * plate that cannot be read -- and the caller can raise the pitch by exactly
 * that many EW.
 *
 * @param {number} cellEw cell pitch in extrusion widths (0/NaN = unknown = ideal)
 * @param {number} shapeLevels size of the shape alphabet
 */
function quantise(cellEw, L) {
  const minDotEw = Math.ceil(Math.sqrt(L - 1));
  // One full EW of *unprinted* clearance on every side. Half an EW is what the
  // antialias tails of adjacent rings sit in, and under any real blur they
  // bridge: the lattice then reads as one connected mesh and the corner markers
  // merge into it (observed in simulation with a 1px blur).
  for (let outerEw = Math.floor((cellEw - 2) / 2); outerEw >= 2; outerEw--) {
    const ringEw = Math.max(1, Math.round(outerEw * 0.18));
    const innerEw = outerEw - ringEw;
    if (innerEw < 2) continue;
    const maxDotEw = innerEw - 1;
    if (maxDotEw < minDotEw) continue;
    const radii = [];
    for (let k = 0; k < L; k++) radii.push(k === 0 ? 0 : Math.max(1, Math.round(maxDotEw * Math.sqrt(k / (L - 1)))));
    if (new Set(radii).size !== L) continue; // two levels collapsing onto one radius is unresolvable
    const outer = outerEw / cellEw;
    const inner = innerEw / cellEw;
    const dot = radii.map((r) => r / cellEw);
    // Guard band: a wide ring is read a fraction of an EW in from each edge so
    // soft antialias never enters the ratio; a 1-EW ring has no room for that,
    // and taking a fixed 0.5 EW guard would leave a zero-area measurement window.
    const guardEw = Math.min(0.5, ringEw / 4);
    const bandIn = (innerEw + guardEw) / cellEw;
    const bandOut = (outerEw - guardEw) / cellEw;
    const area = Math.PI * (outer ** 2 - inner ** 2);
    // The reference ring must stay the dominant reflector: rho is dot/annulus, and
    // a dot larger than the ring pushes it past 1, where the "this cell is a blob"
    // cut correctly rejects the reading. Keep the quantised geometry inside the
    // same contract as the ideal one (RHO_HI ~= 0.97).
    const rhoHi = (Math.PI * dot[L - 1] ** 2) / area;
    if (!(rhoHi > 0) || rhoHi > 0.95) continue;
    const guard = Math.PI * (bandOut ** 2 - bandIn ** 2);
    const measure = {
      dotR: Math.min(Math.max(dot[L - 1] + guardEw / cellEw, inner - guardEw / cellEw), 0.49),
      bandIn,
      bandOut,
      bandGuardArea: guard,
      bandScale: guard > 0 ? area / guard : 1,
    };
    return {
      ok: true,
      quantised: true,
      cellEw,
      shapeLevels: L,
      outer,
      inner,
      outerEw,
      innerEw,
      dot,
      dotEw: radii,
      area,
      measure,
      rhoHi,
    };
  }
  return null;
}

/**
 * The narrowest cell (in EW) that `quantise` can build an alphabet into. Derived
 * by searching the same routine the renderer uses, because an analytical estimate
 * of it overstated the requirement (it said 10 EW where 8 works) and that number
 * goes into a refusal message a user is expected to act on.
 *
 * Half-EW steps, not integers: the real cell width is pitchMm/ewMm and is almost
 * never an integer, and quantisation success is sensitive to that fraction (10.4
 * admits a 4-level alphabet where neither 10 nor 11 does). Searching integers only
 * would report a floor the renderer then contradicts.
 */
function searchCellEw(L, limit = IDEAL_CROSSOVER_EW) {
  for (let ew = 3; ew <= limit + 1e-9; ew += 0.5) if (quantise(ew, L)) return ew;
  return null;
}

export function glyphGeometry(cellEw, shapeLevels) {
  const L = Math.max(2, shapeLevels | 0);
  const ideal = { ok: true, quantised: false, cellEw: Number.isFinite(cellEw) ? cellEw : null, shapeLevels: L, outer: ANNULUS_OUTER, inner: ANNULUS_INNER, area: ANNULUS_AREA, measure: MEASURE, dot: null };
  if (!Number.isFinite(cellEw) || cellEw <= 0) return ideal;
  if (cellEw >= IDEAL_CROSSOVER_EW) return ideal; // inkjet/laser: EW quantisation is below the process floor anyway
  const hit = quantise(cellEw, L);
  if (hit) return hit;
  const needed = searchCellEw(L) ?? IDEAL_CROSSOVER_EW;
  return {
    ok: false,
    reason: `a ${L}-level shape alphabet needs >= ${needed} EW per cell (this cell is ${cellEw.toFixed(2)} EW)`,
    neededCellEw: needed,
    ideal,
  };
}

/**
 * A JSON-safe projection of a glyph geometry, for anything that has to *prove*
 * two sides agree on the printed geometry rather than silently recompute it
 * (the manifest records this; the receiver compares it).
 *
 * Recomputing from profile+nozzle would usually work, but "usually" is the wrong
 * word for a system that must fail loudly: if the renderer's quantisation changes
 * between printing a plate and scanning it back, the two sides read different
 * circles and the transfer just does not work, with nothing to point at. A
 * mismatch here names the field.
 */
export function glyphSignature(glyph) {
  if (!glyph) return null;
  return {
    cellEw: glyph.cellEw ?? null,
    shapeLevels: glyph.shapeLevels,
    quantised: !!glyph.quantised,
    outer: glyph.outer,
    inner: glyph.inner,
    dot: glyph.dot ? Array.from(glyph.dot) : null,
    measure: glyph.measure ? { ...glyph.measure } : null,
  };
}

/** @returns {string[]} the field paths that differ, empty when they agree. */
export function glyphSignatureDiff(a, b) {
  const bad = [];
  const seen = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const k of seen) {
    const x = JSON.stringify(a ? a[k] : undefined);
    const y = JSON.stringify(b ? b[k] : undefined);
    if (x !== y) bad.push(`${k}: ${x} vs ${y}`);
  }
  return bad;
}

/** The smallest cell width (in EW) at which an L-level shape alphabet is printable. */
export function minCellEwFor(shapeLevels) {
  const L = Math.max(2, shapeLevels | 0);
  // Same search the refusal message quotes, so the two can never disagree:
  // if nothing below the crossover quantises, the crossover *is* the floor
  // (at that width the ideal geometry applies and is printable by definition).
  return searchCellEw(L) ?? IDEAL_CROSSOVER_EW;
}

/**
 * Is (dx, dy) printed for this *level* under this geometry?
 * Level-based rather than rho-based so EW-quantised radii are exact.
 */
export function glyphMaskForLevel(dx, dy, level, geo) {
  const r2 = dx * dx + dy * dy;
  const outer = geo ? geo.outer : ANNULUS_OUTER;
  const inner = geo ? geo.inner : ANNULUS_INNER;
  if (r2 <= inner * inner) {
    const rd = geo && geo.dot ? geo.dot[level] : dotRadiusForRho(rhoFor(level, geo ? geo.shapeLevels : 0));
    return rd > 0 && r2 <= rd * rd;
  }
  return r2 <= outer * outer;
}

/** Fraction of the cell that ends up printed at this level (ink budget). */
export function cellInkFraction(level, geo) {
  const g = geo || idealGeometry();
  const dotR = g.dot ? g.dot[level] : dotRadiusForRho(rhoFor(level, g.shapeLevels));
  return g.area + Math.PI * dotR * dotR;
}

/** The unit-cell geometry, for callers that have no nozzle information (paper, previews). */
export function idealGeometry(shapeLevels = 2) {
  return { ok: true, quantised: false, cellEw: null, shapeLevels, outer: ANNULUS_OUTER, inner: ANNULUS_INNER, area: ANNULUS_AREA, measure: MEASURE, dot: null };
}
