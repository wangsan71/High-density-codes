/**
 * tools/make-tile-page.mjs -- the read path, covered by a test instead of only by a command.
 * The round trip goes through real PNG bytes (encodePNG -> decodePNG), which is the part a command-line
 * run proves but a future refactor could silently break.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { planTiles, tileLayout } from '../../core/tiles.js';
import { renderTilePage } from '../../core/render/tilepage.js';
import { encodePNG } from '../../core/render/png.js';
import { tilePageTiles, readTilePageFromPng } from '../../tools/make-tile-page.mjs';

const dpi = 300;
const sheetW = 210;
const sheetH = 297;
const plan = planTiles({ sheetW, sheetH, tileMm: 30, marginMm: 9, gapMm: 2 });
const layout = tileLayout({ modules: 33, finder: 7, quiet: 1 });

test('tile page: a payload survives the PNG file round trip', () => {
  const payload = new Uint8Array(600);
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 53 + 7) & 0xff;
  const built = tilePageTiles(payload, plan, layout);
  const png = encodePNG(renderTilePage({ plan, layout, tiles: built.tiles, dpi, sheetW, sheetH }));
  const back = readTilePageFromPng(png);
  assert.equal(back.length, payload.length);
  assert.deepEqual(Array.from(back.payload), Array.from(payload));
  assert.deepEqual(back.missing, []);
  assert.equal(back.plan.cols, 6);
  assert.equal(back.plan.rows, 8);
  assert.equal(back.img.dpi, dpi);
});

test('tile page: a short payload is trimmed, not padded, and a wrong tile size is refused', () => {
  const payload = new TextEncoder().encode('PSKT');
  const built = tilePageTiles(payload, plan, layout);
  const png = encodePNG(renderTilePage({ plan, layout, tiles: built.tiles, dpi, sheetW, sheetH }));
  const back = readTilePageFromPng(png);
  assert.equal(back.length, 4);
  assert.deepEqual(Array.from(back.payload), Array.from(payload));
  // Asking to read the same page as if it were built from 25 mm tiles must not silently "work": the grid
  // would be different, so the header check inside readTile is what has to catch it.
  assert.throws(() => readTilePageFromPng(png, { tile: 25 }), /declares|outside|no tile|header/);
});
