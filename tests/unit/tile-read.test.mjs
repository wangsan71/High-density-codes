/**
 * core/decode/tile-read.js -- payload -> tiled page -> payload, on pristine pixels.
 * This is the round trip that the writer and the reader have to agree on; a reader that sees one tile
 * must be able to say which slice it is. Photo capture is NOT covered here (that brick does not exist).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { planTiles, tileLayout, tileCapacity } from '../../core/tiles.js';
import { renderTilePage } from '../../core/render/tilepage.js';
import { readTile, readTilePage } from '../../core/decode/tile-read.js';
import { tilePageTiles } from '../../tools/make-tile-page.mjs';

const sheetW = 210;
const sheetH = 297;
const dpi = 300;
const plan = planTiles({ sheetW, sheetH, tileMm: 30, marginMm: 9, gapMm: 2 });
const layout = tileLayout({ modules: 33, finder: 7, quiet: 1 });

test('tile-read: a payload survives page render and read-back byte for byte', () => {
  const payload = new Uint8Array(300);
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 37 + 11) & 0xff;
  const built = tilePageTiles(payload, plan, layout);
  const img = renderTilePage({ plan, layout, tiles: built.tiles, dpi, sheetW, sheetH });
  const back = readTilePage(img, plan, layout, dpi);
  assert.equal(back.length, payload.length);
  assert.deepEqual(Array.from(back.payload), Array.from(payload));
  assert.equal(back.bytesPerTile, 100, '104 raw bytes minus the 4-byte header');
  assert.deepEqual(back.missing, []);
});

test('tile-read: a single tile reports its own index and count, and a short payload is not padded', () => {
  const payload = new TextEncoder().encode('PSKT');
  const built = tilePageTiles(payload, plan, layout);
  const img = renderTilePage({ plan, layout, tiles: built.tiles, dpi, sheetW, sheetH });
  const t7 = readTile(img, plan, layout, 7, dpi);
  assert.equal(t7.index, 7);
  assert.equal(t7.count, 48);
  assert.equal(t7.length, 4);
  assert.deepEqual(Array.from(t7.slice), []);
  const back = readTilePage(img, plan, layout, dpi);
  assert.deepEqual(Array.from(back.payload), Array.from(payload));
  // Capacity is what the writer promised, checked from the reader's side too.
  assert.equal(tileCapacity(plan, layout).bytesPerTile - 4, 100);
  assert.throws(() => readTile(img, plan, layout, 48, dpi), /outside 0\.\.47/);
});
