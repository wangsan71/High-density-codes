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
export const ANNULUS_OUTER = 0.47;
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
export const MAX_DOT_RADIUS = 0.28;

/** Smallest / largest rho we ever print. */
export const RHO_LO = 0.3;
export const RHO_HI = (Math.PI * MAX_DOT_RADIUS ** 2) / ANNULUS_AREA;

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
