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
/**
 * Inside one tile: where the finders go and which cells are left for data (PLAN v5 P4).
 *
 * QR's arrangement, for the same reason QR uses it: three solid squares give a camera scale, rotation
 * and which corner is which; the small hollow one at the fourth corner disambiguates orientation. The
 * difference from QR is that here every tile is independent, so a reader only ever needs one.
 *
 * Everything is in module units -- the renderer multiplies by a pixel/module count and the geometry does
 * not care. Returns the data cells explicitly so the encoder cannot silently use a cell that belongs to
 * a finder pattern (that is exactly how a code ends up unreadable in the field).
 */
export function tileLayout(spec = {}) {
  const modules = spec.modules === undefined ? 33 : spec.modules;
  const finder = spec.finder === undefined ? 7 : spec.finder;
  const quiet = spec.quiet === undefined ? 1 : spec.quiet;
  for (const [name, v] of [['modules', modules], ['finder', finder], ['quiet', quiet]]) {
    if (!Number.isInteger(v) || v < 0) throw new RangeError('tiles: ' + name + ' must be a non-negative whole number, got ' + v);
  }
  if (modules < 1) throw new RangeError('tiles: a tile must be at least one module across, got ' + modules);
  if (finder + 2 * quiet > modules) {
    throw new RangeError('tiles: a ' + finder + '-module finder with a ' + quiet + '-module quiet zone does not fit a ' +
      modules + '-module tile (needs ' + (finder + 2 * quiet) + ')');
  }
  const blocked = new Uint8Array(modules * modules);
  const at = (x, y) => y * modules + x;
  const solid = [
    { x: 0, y: 0, size: finder, hollow: false },
    { x: modules - finder, y: 0, size: finder, hollow: false },
    { x: 0, y: modules - finder, size: finder, hollow: false },
  ];
  const hollow = { x: modules - finder, y: modules - finder, size: finder, hollow: true };
  const all = solid.concat([hollow]);
  // Each pattern reserves its own modules plus the quiet ring around it.
  for (const f of all) {
    for (let y = f.y - quiet; y < f.y + f.size + quiet; y++) {
      for (let x = f.x - quiet; x < f.x + f.size + quiet; x++) {
        if (x >= 0 && y >= 0 && x < modules && y < modules) blocked[at(x, y)] = 1;
      }
    }
  }
  const dataCells = [];
  for (let y = 0; y < modules; y++) {
    for (let x = 0; x < modules; x++) if (!blocked[at(x, y)]) dataCells.push({ x, y });
  }
  return { modules, finder, quiet, finders: all, dataCells, dataCount: dataCells.length };
}

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
