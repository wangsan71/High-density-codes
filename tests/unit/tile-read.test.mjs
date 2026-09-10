/**
 * core/decode/tile-read.js -- payload -> tiled page -> payload, on pristine pixels.
 * This is the round trip that the writer and the reader have to agree on; a reader that sees one tile
 * must be able to say which slice it is. Photo capture is NOT covered here (that brick does not exist).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { planTiles, tileLayout, tileCapacity } from '../../core/tiles.js';
import { renderTilePage } from '../../core/render/tilepage.js';
import { readTile, readTilePage, pageMapper } from '../../core/decode/tile-read.js';
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
  // The refusal is now at the PAGE level and says so: a tile that cannot be repaired makes the whole
  // page unreadable rather than a payload with a hole in it.
  assert.throws(() => readTilePage(img, plan, layout, dpi), /refusing rather than returning a payload with holes|could not be corrected/);
});

test('tile-read: straight, nudged and turned tiles all read, and a hole is refused', () => {
  const payload = new Uint8Array(2000);
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 41 + 13) & 0xff;
  const built = tilePageTiles(payload, plan, layout);
  const img = renderTilePage({ plan, layout, tiles: built.tiles, dpi, sheetW, sheetH });
  const px = 10;
  const side = layout.modules * px;
  const toPx = (mm) => Math.round((mm * dpi) / 25.4);
  const spin = (tileIndex, quarterTurns) => {
    const pos = plan.positions[tileIndex];
    const ox = toPx(pos.x);
    const oy = toPx(pos.y);
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
        for (let i = 0; i < quarterTurns; i++) { const nx = side - 1 - sy; sy = sx; sx = nx; }
        const s = (sy * side + sx) * 4;
        const d = ((oy + y) * img.width + ox + x) * 4;
        img.pixels[d] = copy[s]; img.pixels[d + 1] = copy[s + 1]; img.pixels[d + 2] = copy[s + 2]; img.pixels[d + 3] = 255;
      }
    }
  };
  spin(3, 2);
  const back = readTilePage(img, plan, layout, dpi);
  assert.deepEqual(Array.from(back.payload), Array.from(payload), 'a spun tile must still be read');
  assert.deepEqual(back.missing, []);
  assert.equal(back.partial, false);
  assert.ok(back.hows.straight >= 40, 'most tiles read straight: ' + JSON.stringify(back.hows));
  assert.equal(back.hows.rot180, 1, 'the spun tile is the one that needed turning');
  // Now wreck one tile beyond repair: the page must be refused, not returned with a hole.
  const pos = plan.positions[7];
  const ox7 = toPx(pos.x);
  const oy7 = toPx(pos.y);
  for (let i = 0; i < 60; i++) {
    const c = layout.dataCells[i * 11];
    for (let y = oy7 + c.y * px; y < oy7 + (c.y + 1) * px; y++) {
      for (let x = ox7 + c.x * px; x < ox7 + (c.x + 1) * px; x++) {
        const k = (y * img.width + x) * 4;
        img.pixels[k] = 0; img.pixels[k + 1] = 0; img.pixels[k + 2] = 0;
      }
    }
  }
  assert.throws(() => readTilePage(img, plan, layout, dpi), /unreadable .*refusing rather than returning a payload with holes/);
  const partial = readTilePage(img, plan, layout, dpi, { allowPartial: true });
  assert.equal(partial.partial, true);
  assert.ok(partial.missing.includes(7), 'the wrecked tile is reported: ' + JSON.stringify(partial.missing));
});

test('tile-read: one page homography absorbs a shear the per-tile search cannot', () => {
  const payload = new Uint8Array(3000);
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 37 + 11) & 0xff;
  const built = tilePageTiles(payload, plan, layout);
  const base = renderTilePage({ plan, layout, tiles: built.tiles, dpi, sheetW, sheetH });
  const W = base.width;
  const H = base.height;
  const shearPx = 40;
  const sheared = { width: W, height: H, dpi, pixels: new Uint8Array(W * H * 4).fill(255) };
  for (let y = 0; y < H; y++) {
    const shift = Math.round((shearPx * y) / (H - 1));
    for (let x = 0; x < W; x++) {
      const sx = x - shift;
      if (sx < 0 || sx >= W) continue;
      const s = (y * W + sx) * 4;
      const d = (y * W + x) * 4;
      sheared.pixels[d] = base.pixels[s];
      sheared.pixels[d + 1] = base.pixels[s + 1];
      sheared.pixels[d + 2] = base.pixels[s + 2];
      sheared.pixels[d + 3] = 255;
    }
  }
  assert.throws(() => readTilePage(sheared, plan, layout, dpi), /unreadable|reaches outside|refusing/);
  const quad = [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W + shearPx, y: H }, { x: shearPx, y: H }];
  const back = readTilePage(sheared, plan, layout, dpi, { map: pageMapper(quad, W, H) });
  assert.deepEqual(Array.from(back.payload), Array.from(payload), 'a 40 px page shear must read once the corners are given');
  assert.deepEqual(back.missing, []);
});

test('tile-read: with a page map, a wrecked tile is refused instead of being "found" in the wrong space', () => {
  const payload = new Uint8Array(3000);
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 37 + 11) & 0xff;
  const built = tilePageTiles(payload, plan, layout);
  const base = renderTilePage({ plan, layout, tiles: built.tiles, dpi, sheetW, sheetH });
  const W = base.width;
  const H = base.height;
  const shearPx = 40;
  const sheared = { width: W, height: H, dpi, pixels: new Uint8Array(W * H * 4).fill(255) };
  for (let y = 0; y < H; y++) {
    const shift = Math.round((shearPx * y) / (H - 1));
    for (let x = 0; x < W; x++) {
      const sx = x - shift;
      if (sx < 0 || sx >= W) continue;
      const s = (y * W + sx) * 4;
      const d = (y * W + x) * 4;
      sheared.pixels[d] = base.pixels[s];
      sheared.pixels[d + 1] = base.pixels[s + 1];
      sheared.pixels[d + 2] = base.pixels[s + 2];
      sheared.pixels[d + 3] = 255;
    }
  }
  const quad = [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W + shearPx, y: H }, { x: shearPx, y: H }];
  const map = pageMapper(quad, W, H);
  const px = 10;
  const toPx = (mm) => Math.round((mm * dpi) / 25.4);
  const pos = plan.positions[7];
  const ox = toPx(pos.x);
  const oy = toPx(pos.y);
  const shift7 = Math.round((shearPx * (oy + 15)) / (H - 1));
  // Wreck 60 data cells of tile 7 -- past what 16 RS parity bytes can repair.
  for (let i = 0; i < 60; i++) {
    const c = layout.dataCells[i * 13];
    for (let y = oy + c.y * px; y < oy + (c.y + 1) * px; y++) {
      for (let x = ox + c.x * px + shift7; x < ox + (c.x + 1) * px + shift7; x++) {
        if (y < 0 || y >= H || x < 0 || x >= W) continue;
        const k = (y * W + x) * 4;
        sheared.pixels[k] = 0; sheared.pixels[k + 1] = 0; sheared.pixels[k + 2] = 0;
      }
    }
  }
  assert.throws(() => readTilePage(sheared, plan, layout, dpi, { map }), /unreadable|refusing|could not be corrected/);
  const partial = readTilePage(sheared, plan, layout, dpi, { map, allowPartial: true });
  assert.equal(partial.partial, true, 'the damaged tile must be reported, not guessed');
});
