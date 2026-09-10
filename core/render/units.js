/**
 * Unit conversion. One source of truth on purpose: every module that turns
 * millimetres into pixels must go through here, so a change in DPI convention
 * cannot silently desynchronise the encoder from the decoder.
 */

export const MM_PER_INCH = 25.4;
export const PT_PER_MM = 72 / 25.4;

/** Millimetres to whole pixels at the given print resolution. */
export function mmToPx(mm, dpi) {
  if (!(dpi > 0)) throw new RangeError('mmToPx: dpi must be positive');
  return Math.round((mm * dpi) / MM_PER_INCH);
}

export function pxToMm(px, dpi) {
  if (!(dpi > 0)) throw new RangeError('pxToMm: dpi must be positive');
  return (px * MM_PER_INCH) / dpi;
}


/** Pixels of one extrusion width. */
export function ewPx(ewMm, dpi) {
  return (ewMm * dpi) / MM_PER_INCH;
}

/**
 * Round a length to the nearest whole number of pixels while keeping the
 * physical size within `tol` mm of the ideal. Used for cell pitches, where a
 * fraction of a pixel of drift per cell would smear the far edge of the page.
 */
function snapPx(mm, dpi, tol = 0.02) {
  const px = Math.round((mm * dpi) / MM_PER_INCH);
  const back = (px * MM_PER_INCH) / dpi;
  if (Math.abs(back - mm) > tol) {
    throw new RangeError(`snapPx: ${mm}mm at ${dpi}dpi cannot snap within ${tol}mm (got ${back.toFixed(4)})`);
  }
  return px;
}

export function round2(n) {
  return Math.round(n * 100) / 100;
}
