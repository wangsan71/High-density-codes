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
import { tilePageTiles, readTilePageFromPng, readTilePhotoFromPng } from '../../tools/make-tile-page.mjs';
import { homographyFromQuad, inv3, apply } from '../../core/decode/transform.js';

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

test('tile page: a PHOTOGRAPH of the sheet (turned, keystoned, not filling the frame) reads back', () => {
  const k = 6;
  const a5W = 148;
  const a5H = 210;
  const a5dpi = k * 25.4;
  const planA5 = planTiles({ sheetW: a5W, sheetH: a5H, tileMm: 30, marginMm: 9, gapMm: 2 });
  const payload = new Uint8Array(600);
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 151 + 17) & 0xff;
  const built = tilePageTiles(payload, planA5, layout);
  const base = renderTilePage({ plan: planA5, layout, tiles: built.tiles, dpi: a5dpi, sheetW: a5W, sheetH: a5H });
  const SW = base.width;
  const SH = base.height;
  const srcPx = a5dpi / 25.4;
  const W2 = Math.round(k * a5W * 1.62);
  const H2 = Math.round(k * a5H * 1.3);
  const th = (2.5 * Math.PI) / 180;
  const span = k * a5W;
  const spanY = k * a5H;
  const x0 = (W2 - span) / 2;
  const y0 = (H2 - spanY) / 2;
  const quad = [
    { x: x0 + k * 4, y: y0 + k * 3 },
    { x: x0 + span - k * 2, y: y0 + k * 3 + Math.tan(th) * span },
    { x: x0 + span, y: y0 + spanY },
    { x: x0 + k * 2, y: y0 + spanY - Math.tan(th) * span * 0.6 },
  ];
  const H = homographyFromQuad([{ x: 0, y: 0 }, { x: a5W, y: 0 }, { x: a5W, y: a5H }, { x: 0, y: a5H }], quad);
  const Hx = inv3(H);
  const img = { width: W2, height: H2, dpi: Math.round(a5dpi), pixels: new Uint8Array(W2 * H2 * 4).fill(255) };
  for (let y = 0; y < H2; y++) {
    for (let x = 0; x < W2; x++) {
      const p = apply(Hx, x, y);
      const sx = Math.round(p.x * srcPx);
      const sy = Math.round(p.y * srcPx);
      if (sx < 0 || sx >= SW || sy < 0 || sy >= SH) continue;
      const s = (sy * SW + sx) * 4;
      const d = (y * W2 + x) * 4;
      img.pixels[d] = base.pixels[s];
      img.pixels[d + 1] = base.pixels[s + 1];
      img.pixels[d + 2] = base.pixels[s + 2];
      img.pixels[d + 3] = 255;
    }
  }
  const png = encodePNG(img);
  const photo = readTilePhotoFromPng(png, { sheet: 'A5' });
  assert.deepEqual(Array.from(photo.payload), Array.from(payload), 'a photograph must read byte for byte');
  assert.deepEqual(photo.missing, [], 'zero tiles may be left unreadable');
  assert.equal(photo.mapRefined, true);
  assert.equal(photo.mapAnchors, 24, 'every tile of the A5 grid contributes an anchor');
  assert.ok(photo.mapIdentity && photo.mapIdentity.decided, 'the header vote must decide the labelling');
  assert.throws(() => readTilePageFromPng(png, {}), /declares|outside|no tile|refused|unreadable|reaches/);
});
