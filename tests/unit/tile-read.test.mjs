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
  assert.equal(back.bytesPerTile, 82, '104 raw bytes minus 4 header, 2 CRC16 and 16 Reed-Solomon parity');
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

test('tile-read: Reed-Solomon repairs a few damaged cells, and too much damage is refused', () => {
  const payload = new Uint8Array(2000);
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 29 + 3) & 0xff;
  const built = tilePageTiles(payload, plan, layout);
  const img = renderTilePage({ plan, layout, tiles: built.tiles, dpi, sheetW, sheetH });
  const px = 10;   // 30 mm / 33 modules at 300 dpi
  const toPx = (mm) => Math.round((mm * dpi) / 25.4);
  const paintCell = (tileIndex, cellIndex, dark) => {
    const pos = plan.positions[tileIndex];
    const c = layout.dataCells[cellIndex];
    const x0 = toPx(pos.x) + c.x * px;
    const y0 = toPx(pos.y) + c.y * px;
    for (let y = y0; y < y0 + px; y++) {
      for (let x = x0; x < x0 + px; x++) {
        const i = (y * img.width + x) * 4;
        const v = dark ? 0 : 255;
        img.pixels[i] = v; img.pixels[i + 1] = v; img.pixels[i + 2] = v;
      }
    }
  };
  // Eight flipped CELLS in tile 5 = up to eight byte errors, which 16 parity bytes can repair (8 errors).
  for (let k = 0; k < 8; k++) paintCell(5, 100 + k * 7, false);
  const back = readTilePage(img, plan, layout, dpi);
  assert.deepEqual(Array.from(back.payload), Array.from(payload), 'the payload must survive 8 damaged cells');
  // Wreck 40 cells of the same tile: beyond what the parity can repair, so it must be refused by name
  // rather than decoded into different bytes.
  for (let k = 0; k < 40; k++) paintCell(5, 200 + k * 3, true);
  assert.throws(() => readTilePage(img, plan, layout, dpi), /could not be corrected|fails its CRC16/);
});
