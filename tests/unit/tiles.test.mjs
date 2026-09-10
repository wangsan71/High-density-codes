/**
 * core/tiles.js -- tile grid geometry (PLAN v5 P4, first brick).
 * Geometry only: what is tested here is that the counts follow from the arithmetic, that the block is
 * centred, and that an impossible sheet is refused by name instead of silently yielding zero tiles.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { planTiles } from '../../core/tiles.js';

test('tiles: an A4 sheet holds the arithmetic number of 30 mm tiles, centred', () => {
  // usable = 210-18 = 192 wide, 297-18 = 279 tall; n tiles need n*30 + (n-1)*2 mm.
  // width:  6*30+5*2 = 190 <= 192   (7 would need 222)
  // height: 8*30+7*2 = 254 <= 279   (9 would need 286)
  const g = planTiles({ sheetW: 210, sheetH: 297, tileMm: 30, marginMm: 9, gapMm: 2 });
  assert.equal(g.cols, 6);
  assert.equal(g.rows, 8);
  assert.equal(g.tiles, 48);
  assert.equal(g.positions.length, 48);
  assert.equal(g.widthMm, 190);
  assert.equal(g.heightMm, 254);
  const xs = g.positions.map((p) => p.x);
  const ys = g.positions.map((p) => p.y);
  assert.equal(Math.min(...xs), 9 + (192 - 190) / 2);
  assert.equal(Math.min(...ys), 9 + (279 - 254) / 2);
  assert.equal(Math.max(...xs), Math.min(...xs) + 190 - 30);
  assert.equal(Math.max(...ys), Math.min(...ys) + 254 - 30);
  // Reading order, and no two tiles overlap.
  assert.deepEqual(g.positions[0], { x: Math.min(...xs), y: Math.min(...ys) });
  assert.equal(g.positions[1].y, g.positions[0].y);
  assert.equal(g.positions[6].y, g.positions[0].y + 32);
});

test('tiles: a sheet that cannot hold one tile is refused by name', () => {
  assert.throws(() => planTiles({ sheetW: 40, sheetH: 40, tileMm: 30, marginMm: 9, gapMm: 2 }), /cannot hold one 30 mm tile/);
  assert.throws(() => planTiles({ sheetW: 210, sheetH: 297, tileMm: 0 }), /tileMm must be a positive number/);
  assert.throws(() => planTiles({ sheetW: 210, sheetH: 297, tileMm: 30, marginMm: -1 }), /must be >= 0/);
  // A denser but legal case: 15 mm tiles on the same sheet.
  const dense = planTiles({ sheetW: 210, sheetH: 297, tileMm: 15, marginMm: 9, gapMm: 1 });
  assert.equal(dense.cols, 12);
  assert.equal(dense.rows, 17);
  assert.ok(dense.widthMm <= 210 - 18 && dense.heightMm <= 297 - 18);
});
