/**
 * core/render/tilepage.js -- the tiled sheet as pixels.
 * Sampling is done in the RENDERER's own pixel geometry (tile origin + module * modulePixels), not in
 * millimetres: modulePixels() floors, so a 30 mm slot at 33 modules draws 10 px per module = 27.9 mm of
 * ink, and a millimetre-based sample point drifts off the cell it means to check (that mistake cost a
 * failing assertion here before it cost anything in the field).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { planTiles, tileLayout, fillTileModules, tileCapacity } from '../../core/tiles.js';
import { renderTilePage, modulePixels } from '../../core/render/tilepage.js';

const sheetW = 210;
const sheetH = 297;
const dpi = 300;
const plan = planTiles({ sheetW, sheetH, tileMm: 30, marginMm: 9, gapMm: 2 });
const layout = tileLayout({ modules: 33, finder: 7, quiet: 1 });
const px = modulePixels(30, 33, dpi);
const toPx = (mm) => Math.round((mm * dpi) / 25.4);

/** Pixel sample at the centre of module (m,n) of tile t, in the renderer's own geometry. */
function sample(img, t, m, n) {
  const pos = plan.positions[t];
  const x = toPx(pos.x) + Math.round((m + 0.5) * px);
  const y = toPx(pos.y) + Math.round((n + 0.5) * px);
  return img.pixels[(y * img.width + x) * 4];
}

test('tilepage: an A4 sheet renders at A4 pixel size with the right module pitch', () => {
  const img = renderTilePage({ plan, layout, tiles: null, dpi, sheetW, sheetH });
  assert.equal(img.width, 2480);
  assert.equal(img.height, 3508);
  assert.equal(px, 10, '30 mm / 33 modules at 300 dpi is 10 px per module');
  assert.equal(img.pixels.length, img.width * img.height * 4);
  // The drawn tile is slightly smaller than its 30 mm slot because the pitch is floored: worth knowing,
  // not worth hiding.
  assert.ok(px * 33 < toPx(30), 'drawn tile ' + px * 33 + ' px vs slot ' + toPx(30) + ' px');
});

test('tilepage: finders are dark where they must be, and data cells follow their bit', () => {
  const cap = tileCapacity(plan, layout);
  const payload = new Uint8Array(cap.bytesPerTile);
  payload[0] = 0b10000000;                       // the very first data cell must be dark
  const mods = fillTileModules(layout.dataCells, payload);
  const img = renderTilePage({ plan, layout, tiles: plan.positions.map(() => mods), dpi, sheetW, sheetH });
  // Solid finder at the top-left corner: centre module 3, ring interior module 1.
  assert.equal(sample(img, 0, 3, 3), 0, 'solid finder centre');
  assert.equal(sample(img, 0, 1, 1), 255, 'solid finder interior');
  // Hollow finder at module 26: single dark centre at 29, interior around it light.
  assert.equal(sample(img, 0, 29, 29), 0, 'hollow finder centre');
  assert.equal(sample(img, 0, 27, 29), 255, 'hollow finder interior');
  assert.equal(sample(img, 0, 31, 29), 255, 'hollow finder interior, other side');
  // Data cells carry the payload bits: the first is 1, the second is 0.
  const d0 = layout.dataCells[0];
  const d1 = layout.dataCells[1];
  assert.equal(sample(img, 0, d0.x, d0.y), 0, 'first data cell');
  assert.equal(sample(img, 0, d1.x, d1.y), 255, 'second data cell');
  // A different tile carries the same payload (every tile is independent and identical here).
  assert.equal(sample(img, 5, d0.x, d0.y), 0, 'tile 5 first data cell');
});
