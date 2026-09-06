/**
 * Layout constants with no dependencies.
 *
 * These live in their own leaf module because `core/profiles.js` needs them to
 * fit the lattice to a sheet, while `core/render/layout.js` needs them to place
 * the marks, and layout.js also imports frame.js -- which imports profiles.js.
 * Importing the constants from layout.js would close that cycle and put
 * frame.js's `PROFILE_CODES` table in a temporal dead zone at module init.
 */

/**
 * Quiet-zone width, measured in data cells, on every side.
 * 5 cells: 4 is the barcode-convention minimum, and the extra cell gives the
 * echo strip a lane beside the corner markers instead of on top of them.
 */
export const QUIET_CELLS = 5;

/** Corner marker side length in cells. Three are solid, the fourth hollow. */
export const FID_CELLS = 3;

/** Width of the frame-header echo strip, in micro cells. */
export const ECHO_COLS = 56;

/** A cell smaller than this in pixels is not printable at that dpi. */
export const MIN_CELL_PX = 5;
