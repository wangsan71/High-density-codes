/**
 * core/tiles.js -- tile grid geometry for the QR-style page (PLAN v5 P4, first brick).
 *
 * P4 turns a page into M x N independent tiles, each with its own finder pattern, so a phone can lock
 * onto ANY one of them instead of needing the whole sheet in frame. This file is only the geometry: how
 * many tiles fit, and where they sit, in millimetres from the sheet origin. No renderer, no reader, no
 * error correction yet -- those come next and will use these numbers.
 *
 * Pure ESM, no dependencies, no node: builtins.
 */

/**
 * @param {object} spec
 * @param {number} spec.sheetW  sheet width in mm
 * @param {number} spec.sheetH  sheet height in mm
 * @param {number} spec.tileMm  edge length of one tile in mm (finder patterns live inside it)
 * @param {number} spec.marginMm printer margin to stay clear of, per side
 * @param {number} spec.gapMm   gap between neighbouring tiles (and to the quiet zone)
 * @returns {{cols:number, rows:number, tiles:number, tileMm:number, gapMm:number, widthMm:number, heightMm:number, positions:Array<{x:number,y:number}>}}
 */
export function planTiles(spec) {
  const { sheetW, sheetH, tileMm, marginMm = 9, gapMm = 2 } = spec || {};
  for (const [name, v] of [['sheetW', sheetW], ['sheetH', sheetH], ['tileMm', tileMm]]) {
    if (!(typeof v === 'number' && Number.isFinite(v) && v > 0)) {
      throw new RangeError('tiles: ' + name + ' must be a positive number of millimetres, got ' + v);
    }
  }
  if (!(marginMm >= 0) || !(gapMm >= 0)) throw new RangeError('tiles: marginMm and gapMm must be >= 0');
  const usableW = sheetW - 2 * marginMm;
  const usableH = sheetH - 2 * marginMm;
  // n tiles need n*tile + (n-1)*gap; the pieces are laid out from the top-left in reading order so the
  // page has a deterministic, describable geometry instead of an arithmetic accident.
  const fit = (usable, tile) => Math.floor((usable + gapMm) / (tile + gapMm));
  const cols = fit(usableW, tileMm);
  const rows = fit(usableH, tileMm);
  if (cols < 1 || rows < 1) {
    throw new RangeError('tiles: a ' + sheetW + 'x' + sheetH + ' mm sheet cannot hold one ' + tileMm +
      ' mm tile with ' + marginMm + ' mm margins (usable ' + usableW + 'x' + usableH + ' mm) -- use a bigger sheet or smaller tile');
  }
  const widthMm = cols * tileMm + (cols - 1) * gapMm;
  const heightMm = rows * tileMm + (rows - 1) * gapMm;
  // Centre the block: whatever slack is left is split evenly, which keeps the geometry symmetric under
  // a 180-degree rotation (a phone that sees the page upside down still gets the same grid).
  const x0 = marginMm + (usableW - widthMm) / 2;
  const y0 = marginMm + (usableH - heightMm) / 2;
  const positions = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) positions.push({ x: x0 + c * (tileMm + gapMm), y: y0 + r * (tileMm + gapMm) });
  }
  return { cols, rows, tiles: cols * rows, tileMm, gapMm, widthMm, heightMm, positions };
}
