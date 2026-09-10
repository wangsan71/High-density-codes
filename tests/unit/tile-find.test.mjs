/**
 * core/decode/tile-read.js -- finding a tile in a shifted page.
 * The tolerance tested here is TRANSLATION (a phone pointed at a page mostly produces that). Perspective
 * and rotation are not covered, and the test says so rather than implying more than it proves.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { planTiles, tileLayout } from '../../core/tiles.js';
import { renderTilePage } from '../../core/render/tilepage.js';
import { readTile, findTileOffset, detectTileRotation } from '../../core/decode/tile-read.js';
import { tilePageTiles } from '../../tools/make-tile-page.mjs';

const sheetW = 210;
const sheetH = 297;
const dpi = 300;
const plan = planTiles({ sheetW, sheetH, tileMm: 30, marginMm: 9, gapMm: 2 });
const layout = tileLayout({ modules: 33, finder: 7, quiet: 1 });

function shift(img, dx, dy) {
  const out = { width: img.width, height: img.height, dpi: img.dpi, pixels: new Uint8Array(img.width * img.height * 4).fill(255) };
  for (let y = 0; y < img.height; y++) {
    const sy = y - dy;
    if (sy < 0 || sy >= img.height) continue;
    for (let x = 0; x < img.width; x++) {
      const sx = x - dx;
      if (sx < 0 || sx >= img.width) continue;
      const s = (sy * img.width + sx) * 4;
      const d = (y * img.width + x) * 4;
      out.pixels[d] = img.pixels[s]; out.pixels[d + 1] = img.pixels[s + 1];
      out.pixels[d + 2] = img.pixels[s + 2]; out.pixels[d + 3] = 255;
    }
  }
  return out;
}

test('tile-read: a tile shifted by a few pixels is still found and still reads', () => {
  const payload = new Uint8Array(1500);   // long enough that tile 10 really has a slice to carry
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 91 + 5) & 0xff;
  const built = tilePageTiles(payload, plan, layout);
  const img = renderTilePage({ plan, layout, tiles: built.tiles, dpi, sheetW, sheetH });
  for (const [dx, dy] of [[0, 0], [7, -5], [-9, 11]]) {
    const moved = shift(img, dx, dy);
    const found = findTileOffset(moved, plan, layout, 10, { dpi });
    // The score plateaus: any offset that keeps every probe inside the same module scores the same, so
    // the localiser's resolution is sub-module (about +-3 px at 10 px/module), not exact. Demanding an
    // exact match here would be a test of arithmetic luck; what matters is that the tile still READS,
    // which the assertions below check.
    // Measured resolution of this first localiser: anywhere inside the same module validates (the header
    // it decodes is identical), so the reported offset can sit up to one module away from the true shift.
    // The assertion that matters is the payload one below -- an offset that reads the right bytes is
    // correct whatever the true shift was.
    assert.ok(Math.abs(found.dx - dx) <= found.px, 'x offset ' + found.dx + ' for a true shift of ' + dx);
    assert.ok(Math.abs(found.dy - dy) <= found.px, 'y offset ' + found.dy + ' for a true shift of ' + dy);
    assert.equal(found.score, found.maxScore, 'all finder probes should agree');
    const tile = readTile(moved, plan, layout, 10, dpi, found);
    assert.equal(tile.index, 10);
    // 82 usable bytes per tile (104 raw - 4 header - 2 CRC16 - 16 RS parity).
    assert.deepEqual(Array.from(tile.slice), Array.from(payload.subarray(820, 902)), 'tile 10 carries bytes 820..901');
  }
});

test('tile-read: a blank image is refused by name, not read as zeros', () => {
  const blank = { width: 2480, height: 3508, dpi, pixels: new Uint8Array(2480 * 3508 * 4).fill(255) };
  assert.throws(() => findTileOffset(blank, plan, layout, 0, { dpi }), /no tile found near position 0/);
});

test('tile-read: the CRC decides which way up a rotated tile is', () => {
  const payload = new Uint8Array(1500);
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 17 + 9) & 0xff;
  const built = tilePageTiles(payload, plan, layout);
  const base = renderTilePage({ plan, layout, tiles: built.tiles, dpi, sheetW, sheetH });
  const px = 10;
  const side = layout.modules * px;
  const toPx = (mm) => Math.round((mm * dpi) / 25.4);
  const pos = plan.positions[5];
  const ox = toPx(pos.x);
  const oy = toPx(pos.y);
  // Rotate the tile slot counter-clockwise by q quarter turns (the direction turn() compensates for --
  // measured with a probe, not assumed: see STATUS round 176).
  const spin = (img, q) => {
    const copy = new Uint8Array(side * side * 4);
    for (let y = 0; y < side; y++) {
      for (let x = 0; x < side; x++) {
        const s = ((oy + y) * img.width + ox + x) * 4;
        const d = (y * side + x) * 4;
        copy[d] = img.pixels[s]; copy[d + 1] = img.pixels[s + 1]; copy[d + 2] = img.pixels[s + 2]; copy[d + 3] = 255;
      }
    }
    for (let y = 0; y < side; y++) {
      for (let x = 0; x < side; x++) {
        let sx = x, sy = y;
        for (let i = 0; i < q; i++) { const ny = side - 1 - sx; sx = sy; sy = ny; }
        const s = (sy * side + sx) * 4;
        const d = ((oy + y) * img.width + ox + x) * 4;
        img.pixels[d] = copy[s]; img.pixels[d + 1] = copy[s + 1]; img.pixels[d + 2] = copy[s + 2]; img.pixels[d + 3] = 255;
      }
    }
  };
  assert.equal(detectTileRotation(base, plan, layout, 5, { dpi }).rot, 0, 'an upright tile needs no rotation');
  for (const [quarterTurns, expected] of [[1, 90], [2, 180], [3, 270]]) {
    const img = { width: base.width, height: base.height, dpi, pixels: Uint8Array.from(base.pixels) };
    spin(img, quarterTurns);
    const found = detectTileRotation(img, plan, layout, 5, { dpi });
    assert.equal(found.rot, expected, 'a slot spun ' + quarterTurns + ' quarter turn(s) CCW');
    const tile = readTile(img, plan, layout, 5, dpi, { dx: 0, dy: 0, rot: found.rot });
    assert.deepEqual(Array.from(tile.slice), Array.from(payload.subarray(410, 492)), 'tile 5 carries bytes 410..491');
  }
});
