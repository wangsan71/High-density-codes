/**
 * core/render/tilepage.js -- draw a tiled page (PLAN v5 P4, the rendering brick).
 *
 * Geometry comes from core/tiles.js and nothing is recomputed here: this file only turns "tile at
 * (x,y) mm, module (m,n) is dark" into pixels. Keeping the split means the arithmetic that decides what
 * fits is testable without a raster, and the raster code has no opinion about capacity.
 *
 * Pure ESM, no dependencies, no node: builtins.
 */

const MM_PER_INCH = 25.4;

/** Pixel size of one module, the same for every tile on the sheet. */
export function modulePixels(tileMm, modules, dpi) {
  const px = Math.floor(((tileMm / modules) * dpi) / MM_PER_INCH);
  if (px < 1) throw new RangeError('tiles: a ' + tileMm + ' mm tile with ' + modules + ' modules is under one pixel per module at ' + dpi + ' dpi');
  return px;
}

function fillRect(pixels, width, x0, y0, w, h, value) {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const i = (y * width + x) * 4;
      pixels[i] = value; pixels[i + 1] = value; pixels[i + 2] = value; pixels[i + 3] = 255;
    }
  }
}

/** One finder pattern: a ringed square. The hollow one has a single dark centre instead of a 3x3 block. */
function drawFinder(pixels, width, ox, oy, size, px, hollow) {
  fillRect(pixels, width, ox, oy, size * px, size * px, 0);
  const inner = size - 2;
  fillRect(pixels, width, ox + px, oy + px, inner * px, inner * px, 255);
  if (hollow) {
    const c = Math.floor(size / 2);
    fillRect(pixels, width, ox + c * px, oy + c * px, px, px, 0);
  } else {
    const c = size - 4;
    fillRect(pixels, width, ox + 2 * px, oy + 2 * px, c * px, c * px, 0);
  }
}

/**
 * Render a whole tiled sheet.
 * tiles: array (one entry per position) of Uint8Array data modules, or null for a blank tile.
 */
export function renderTilePage(spec) {
  const { plan, layout, tiles, dpi = 300, sheetW, sheetH } = spec;
  if (!plan || !layout) throw new RangeError('tilepage: needs a plan and a layout');
  const width = Math.round((sheetW * dpi) / MM_PER_INCH);
  const height = Math.round((sheetH * dpi) / MM_PER_INCH);
  const px = modulePixels(plan.tileMm, layout.modules, dpi);
  const pixels = new Uint8Array(width * height * 4).fill(255);
  const toPx = (mm) => Math.round((mm * dpi) / MM_PER_INCH);
  for (let t = 0; t < plan.positions.length; t++) {
    const pos = plan.positions[t];
    const ox = toPx(pos.x);
    const oy = toPx(pos.y);
    const mods = (tiles && tiles[t]) || null;
    // Data first, then the finders on top: a payload that overflows its cells can never paint over the
    // patterns a reader needs to find the tile in the first place.
    if (mods) {
      if (mods.length !== layout.dataCells.length) {
        throw new RangeError('tilepage: tile ' + t + ' has ' + mods.length + ' modules but the layout has ' + layout.dataCells.length + ' data cells');
      }
      for (let i = 0; i < mods.length; i++) {
        if (!mods[i]) continue;
        const c = layout.dataCells[i];
        fillRect(pixels, width, ox + c.x * px, oy + c.y * px, px, px, 0);
      }
    }
    for (const f of layout.finders) {
      drawFinder(pixels, width, ox + f.x * px, oy + f.y * px, f.size, px, f.hollow);
    }
  }
  return { width, height, pixels, dpi };
}
