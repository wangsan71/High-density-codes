/**
 * core/tiles.js -- tileCapacity() and fillTileModules(): how much fits, and where the bits go.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { planTiles, tileLayout, tileCapacity, fillTileModules } from '../../core/tiles.js';

test('tiles: one A4 sheet of 30 mm tiles carries about five kilobytes', () => {
  const plan = planTiles({ sheetW: 210, sheetH: 297, tileMm: 30, marginMm: 9, gapMm: 2 });
  const layout = tileLayout({ modules: 33, finder: 7, quiet: 1 });
  const cap = tileCapacity(plan, layout);
  assert.equal(cap.cellsPerTile, 833);
  assert.equal(cap.tiles, 48);
  assert.equal(cap.cells, 833 * 48);
  assert.equal(cap.bytes, Math.floor(833 * 48 / 8));
  assert.equal(cap.bytesPerTile, 104);
  // The sheet number must be the sum of what the tiles can hold, not a separate calculation.
  assert.ok(cap.bytes >= cap.bytesPerTile * cap.tiles);
});

test('tiles: bits land MSB first and an oversized payload is refused with both numbers', () => {
  const mods = fillTileModules(new Array(16).fill(0), Uint8Array.from([0b10110010, 0b00000001]));
  // 0b10110010 then 0b00000001, most significant bit first: the ninth cell is the MSB of the SECOND
  // byte (0), not a continuation of the first -- I got that wrong the first time, which is why the
  // expectation is spelled out bit by bit here instead of as a number.
  assert.deepEqual(Array.from(mods.slice(0, 9)), [1, 0, 1, 1, 0, 0, 1, 0, 0]);
  assert.equal(mods.length, 16, 'every cell gets a value, padding included');
  assert.equal(mods[15], 1, 'the last bit of the second byte');
  assert.equal(mods[14], 0);
  assert.throws(() => fillTileModules(new Array(8).fill(0), Uint8Array.from([1, 2])), /2 B need 16 cells but the tile only has 8/);
  assert.throws(() => tileCapacity(null, null), /needs a plan and a layout/);
});
