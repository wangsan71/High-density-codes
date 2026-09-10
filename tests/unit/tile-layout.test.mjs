/**
 * core/tiles.js -- tileLayout(): the finders inside one tile and the cells left for data.
 * The count is arithmetic, and the point of testing it is that a cell belonging to a finder pattern must
 * never be handed to the encoder: a code that uses one is unreadable in the field, not merely worse.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { tileLayout } from '../../core/tiles.js';

test('tiles: a 33-module tile keeps its corners and hands out only the remaining cells', () => {
  const L = tileLayout({ modules: 33, finder: 7, quiet: 1 });
  assert.equal(L.finders.length, 4);
  assert.equal(L.finders.filter((f) => f.hollow).length, 1);
  assert.equal(L.dataCount, L.dataCells.length);
  // On a 33-module tile the four (finder + quiet) blocks are 8x8 and disjoint -- corners of a 33-grid
  // cannot reach each other -- so the blocked area is exactly 256 and the data cells exactly 1089-256.
  // (I first guessed there would be overlaps to subtract; the arithmetic said otherwise.)
  const blocked = 33 * 33 - L.dataCount;
  assert.equal(blocked, 4 * 8 * 8);
  assert.equal(L.dataCount, 1089 - 256);
  // Every finder corner is blocked, the centre is not, and no data cell touches a finder module.
  const key = (x, y) => x + ',' + y;
  const data = new Set(L.dataCells.map((c) => key(c.x, c.y)));
  assert.ok(!data.has(key(0, 0)) && !data.has(key(32, 0)) && !data.has(key(0, 32)) && !data.has(key(32, 32)));
  assert.ok(data.has(key(16, 16)), 'the centre must be usable');
  for (const f of L.finders) {
    for (let y = f.y; y < f.y + f.size; y++) {
      for (let x = f.x; x < f.x + f.size; x++) assert.ok(!data.has(key(x, y)), 'finder cell ' + x + ',' + y + ' leaked into data');
    }
  }
});

test('tiles: an impossible finder is refused by name, and 21 modules still yields data cells', () => {
  assert.throws(() => tileLayout({ modules: 21, finder: 20, quiet: 1 }), /does not fit a 21-module tile/);
  assert.throws(() => tileLayout({ modules: 33, finder: 7.5 }), /must be a non-negative whole number/);
  const small = tileLayout({ modules: 21, finder: 7, quiet: 1 });
  assert.ok(small.dataCount > 0 && small.dataCount < 21 * 21);
  const bigger = tileLayout({ modules: 45, finder: 7, quiet: 1 });
  assert.ok(bigger.dataCount > small.dataCount, 'more modules must mean more data cells');
});
