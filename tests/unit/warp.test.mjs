import test from 'node:test';
import assert from 'node:assert/strict';
import { planPage } from '../../core/profiles.js';
import { encodeTransfer, splitCellLevel } from '../../core/protocol.js';
import { pageLayout } from '../../core/render/layout.js';
import { renderPageBitmap, echoBitsOf } from '../../core/render/raster.js';
import { readPageIdeal } from '../../core/decode/ideal.js';
import { readEcho } from '../../core/decode/echo.js';
import { findMarkers } from '../../core/decode/fiducial.js';
import { rectifyPage } from '../../core/decode/warp.js';
import { mul3, inv3, apply, sampleBilinear } from '../../core/decode/transform.js';
import { HEADER_LEN } from '../../core/frame.js';

/**
 * A synthetic "photo": we push the rendered page through a known homography,
 * resample it, blur it and add noise. Everything after that -- marker detection,
 * rectification, cell measurement -- runs on the resulting pixels with no
 * knowledge of the transform that produced them.
 */

function rng(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

function randBytes(n, seed) {
  const r = rng(seed);
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (r() * 256) | 0;
  return b;
}

/** canvas -> photo matrix: mild keystone, rotation, scale, offset.
 *
 * The perspective terms are deliberately in the physically sane range: kx/ky of
 * ~2e-5 over a 2200px page is a ~2.5% depth change across the frame, i.e. the
 * phone held at a modest angle. Much larger and the quad leaves the frame
 * entirely, which no detector should be expected to recover.
 */
function photoTransform({ scale = 1, rot = 0, kx = 0, ky = 0, tx = 30, ty = 24 }) {
  const ca = Math.cos(rot);
  const sa = Math.sin(rot);
  const sim = [
    [scale * ca, -scale * sa, tx],
    [scale * sa, scale * ca, ty],
    [0, 0, 1],
  ];
  const persp = [
    [1, 0, 0],
    [0, 1, 0],
    [kx, ky, 1],
  ];
  return mul3(sim, persp);
}

/** Resample `page` through H (canvas -> photo); returns a photo RGBA bitmap. */
function makePhoto(page, H, opts = {}) {
  const corners = [
    [0, 0],
    [page.width, 0],
    [page.width, page.height],
    [0, page.height],
  ].map(([x, y]) => apply(H, x, y));
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const c of corners) {
    x0 = Math.min(x0, c.x);
    y0 = Math.min(y0, c.y);
    x1 = Math.max(x1, c.x);
    y1 = Math.max(y1, c.y);
  }
  const pad = 40;
  const width = Math.ceil(x1 - x0) + pad * 2;
  const height = Math.ceil(y1 - y0) + pad * 2;
  const pixels = new Uint8Array(width * height * 4);
  const Hi = inv3(H);
  const r = rng(opts.seed || 7);
  const noise = opts.noise ?? 10;
  const bg = opts.background ?? [40, 40, 45];
  const outX0 = x0 - pad;
  const outY0 = y0 - pad;
  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      const o = (py * width + px) * 4;
      const cx = px + outX0;
      const cy = py + outY0;
      const p = apply(Hi, cx, cy);
      if (!p || p.x < 0 || p.y < 0 || p.x >= page.width || p.y >= page.height) {
        pixels[o] = bg[0];
        pixels[o + 1] = bg[1];
        pixels[o + 2] = bg[2];
        pixels[o + 3] = 255;
        continue;
      }
      const v = sampleBilinear(page.pixels, page.width, page.height, 4, p.x, p.y);
      pixels[o] = v.values[0];
      pixels[o + 1] = v.values[1];
      pixels[o + 2] = v.values[2];
      pixels[o + 3] = 255;
    }
  }
  if (opts.blur) boxBlur(pixels, width, height, opts.blur);
  if (noise > 0) {
    for (let i = 0; i < pixels.length; i += 4) {
      const n = (r() - 0.5) * 2 * noise;
      for (let c = 0; c < 3; c++) {
        const v = pixels[i + c] + n;
        pixels[i + c] = v < 0 ? 0 : v > 255 ? 255 : v;
      }
    }
  }
  return { width, height, pixels, substrate: page.substrate, offsetX: outX0, offsetY: outY0 };
}

function boxBlur(pixels, width, height, radius) {
  const tmp = new Uint8Array(pixels.length);
  const win = radius * 2 + 1;
  for (let pass = 0; pass < 2; pass++) {
    const src = pass === 0 ? pixels : tmp;
    const dst = pass === 0 ? tmp : pixels;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        for (let c = 0; c < 3; c++) {
          let acc = 0;
          for (let k = -radius; k <= radius; k++) {
            const xx = Math.min(width - 1, Math.max(0, x + k));
            acc += src[(y * width + xx) * 4 + c];
          }
          dst[(y * width + x) * 4 + c] = acc / win;
        }
      }
    }
  }
}

function renderIdeal(geom, levels, dpi, palette, opts = {}) {
  const layout = pageLayout(geom, dpi, { plateMm: opts.plateMm ?? 200, sheetMm: geom.sheetMm });
  const bm = renderPageBitmap({
    geom,
    levels,
    layout,
    palette,
    mono: !!opts.mono,
    echoBits: opts.noEcho ? null : echoBitsOf(opts.header || new Uint8Array(HEADER_LEN)),
  });
  return { layout, bm };
}

/**
 * Where a canvas point actually lands in the photo makePhoto produced.
 * makePhoto chooses its own frame around the mapped page, so the canvas -> photo
 * matrix alone is not enough: the frame origin has to be subtracted.
 */
function photoPoint(photo, H, x, y) {
  const p = apply(H, x, y);
  return { x: p.x - photo.offsetX, y: p.y - photo.offsetY };
}

test('corner markers are found in a tilted, blurred, noisy photo', () => {
  const geom = planPage('PL-D2', { nozzle: '0.4' });
  const { layout, bm } = renderIdeal(geom, new Uint8Array(geom.totalCells), 300, 'INK2');
  const H = photoTransform({ scale: 1.15, rot: 0.06, kx: 0.00002, ky: -0.000015 });
  const photo = makePhoto(bm, H, { noise: 9, blur: 1 });
  const found = findMarkers(photo);
  assert.ok(found.ok, `detection failed: ${found.reason} (${JSON.stringify(found.sizes || [])})`);
  assert.equal(found.thresholdFactor, 1, 'a clean photo should binarize at Otsu, not need a stricter cut');
  for (const role of ['tl', 'tr', 'br', 'bl']) {
    const f = layout.fiducials.find((x) => x.role === role);
    const want = photoPoint(photo, H, f.x, f.y);
    const got = found.quad[role];
    const err = Math.hypot(got.x - want.x, got.y - want.y);
    assert.ok(err < 2.5, `${role}: off by ${err.toFixed(2)}px (want ${want.x.toFixed(1)},${want.y.toFixed(1)} got ${got.x.toFixed(1)},${got.y.toFixed(1)})`);
  }
});

test('a rectified photo reads back every cell exactly (geometry only, no blur)', () => {
  const geom = planPage('PL-D2', { nozzle: '0.4' });
  const r = rng(101);
  const levels = new Uint8Array(geom.totalCells);
  for (let i = 0; i < levels.length; i++) levels[i] = (r() * (1 << geom.bitsPerCell)) | 0;
  const { layout, bm } = renderIdeal(geom, levels, 300, 'INK2');
  const H = photoTransform({ scale: 1.2, rot: -0.045, kx: 0.000018, ky: 0.000012 });
  // No optical blur here: this test pins the warp/geometry chain. Blur belongs to
  // the channel model (G3), not to the geometry layer.
  const photo = makePhoto(bm, H, { noise: 8, blur: 0 });
  const found = findMarkers(photo);
  assert.ok(found.ok, `detection failed: ${found.reason}`);
  const t0 = performance.now();
  const rect = rectifyPage(photo, layout, found.quad);
  assert.ok(rect.ok, `rectify failed: ${rect.reason}`);
  const t1 = performance.now();
  const read = readPageIdeal(rect, layout, geom, 'INK2');
  let bad = 0;
  for (let i = 0; i < levels.length; i++) if (read.levels[i] !== levels[i]) bad++;
  assert.equal(bad, 0, `${bad}/${levels.length} cells misread through perspective`);
  console.log(`  rectify ${(t1 - t0).toFixed(0)}ms for ${rect.width}x${rect.height}, coverage ${(rect.coverage * 100).toFixed(1)}%`);
});

test('bytes survive a photo: encode -> print -> tilt -> detect -> rectify -> decode', async () => {
  for (const [pid, opts, palette, scale] of [
    ['PL-G', { nozzle: '0.8' }, 'PAPER1', 0.8],
    ['PL-D2', { nozzle: '0.4' }, 'INK2', 1.0],
    ['PL-M1', { nozzle: '0.4' }, 'PAPER1', 1.0],
  ]) {
    const payload = randBytes(700, 55 + pid.length);
    const t = await encodeTransfer(payload, { profile: pid, ...opts });
    const geom = t.geom;
    const dpi = 300;
    const layout = pageLayout(geom, dpi, { plateMm: 200, sheetMm: geom.sheetMm });
    const H = photoTransform({ scale, rot: 0.05, kx: 0.00002, ky: -0.000018 });
    const asm = new (await import('../../core/protocol.js')).TransferAssembler();
    let echoRead = 0;
    for (const p of t.pages) {
      const bm = renderPageBitmap({ geom, levels: p.levels, layout, palette, echoBits: echoBitsOf(p.header) });
      const photo = makePhoto(bm, H, { noise: 8, blur: 1 });
      const found = findMarkers(photo);
      assert.ok(found.ok, `${pid}: marker detection failed: ${found.reason}`);
      const rect = rectifyPage(photo, layout, found.quad);
      assert.ok(rect.ok, `${pid}: ${rect.reason}`);
      const echo = readEcho(rect, layout);
      assert.ok(echo.ok, `${pid}: echo unreadable: ${echo.reason}`);
      assert.deepEqual(Array.from(echo.headerBytes), Array.from(p.header), `${pid}: header mismatch`);
      echoRead++;
      const read = readPageIdeal(rect, layout, geom, palette);
      await asm.feed({ levels: read.levels, header: echo.headerBytes, channelMissing: read.colourAlive ? [] : ['colour'] });
    }
    assert.ok(echoRead === t.pages.length);
    assert.ok(asm.result, `${pid}: no result (${asm.error || 'incomplete'})`);
    assert.equal(asm.result.length, payload.length);
    assert.ok(asm.result.every((v, i) => v === payload[i]), `${pid}: payload differs`);
    console.log(`  ${pid}${opts.nozzle ? '@' + opts.nozzle : ''}: ${t.pages.length} tilted pages recovered, ${payload.length} B`);
  }
});

test('a 90-degree rotated page still decodes (orientation comes from the hollow marker)', async () => {
  const payload = randBytes(420, 9);
  const t = await encodeTransfer(payload, { profile: 'PL-D2', nozzle: '0.4' });
  const geom = t.geom;
  const layout = pageLayout(geom, 300, { plateMm: 200 });
  const asm = new (await import('../../core/protocol.js')).TransferAssembler();
  for (const p of t.pages) {
    const bm = renderPageBitmap({ geom, levels: p.levels, layout, palette: 'INK2', echoBits: echoBitsOf(p.header) });
    // rotate the page 90 deg clockwise about its centre, then add a small skew
    const rot = photoTransform({ scale: 1, rot: Math.PI / 2, kx: 0.00005, tx: 40, ty: 400 });
    const photo = makePhoto(bm, rot, { noise: 6 });
    const found = findMarkers(photo);
    assert.ok(found.ok, `rotated detection failed: ${found.reason}`);
    const rect = rectifyPage(photo, layout, found.quad);
    assert.ok(rect.ok, rect.reason);
    const echo = readEcho(rect, layout);
    assert.ok(echo.ok, `rotated echo unreadable: ${echo.reason}`);
    const read = readPageIdeal(rect, layout, geom, 'INK2');
    await asm.feed({ levels: read.levels, header: echo.headerBytes, channelMissing: read.colourAlive ? [] : ['colour'] });
  }
  assert.ok(asm.result, `rotated page did not reassemble (${asm.error})`);
  assert.ok(asm.result.every((v, i) => v === payload[i]), 'rotated payload differs');
});

test('blank and scrambled photos are refused, never guessed', () => {
  const blank = { width: 400, height: 300, pixels: new Uint8Array(400 * 300 * 4).fill(250), substrate: [250, 250, 246] };
  const r0 = findMarkers(blank);
  assert.equal(r0.ok, false);
  assert.ok(['blank-image', 'no-square-candidates', 'too-few-candidates', 'no-rectangular-quad'].includes(r0.reason), r0.reason);

  // four squares that are not a page: same size, wrong arrangement (a row)
  const w = 600;
  const h = 200;
  const px = new Uint8Array(w * h * 4).fill(255);
  const paint = (cx, cy, side) => {
    for (let y = cy - side / 2; y < cy + side / 2; y++) {
      for (let x = cx - side / 2; x < cx + side / 2; x++) {
        const o = (Math.round(y) * w + Math.round(x)) * 4;
        px[o] = 10;
        px[o + 1] = 10;
        px[o + 2] = 10;
      }
    }
  };
  for (let i = 0; i < 4; i++) paint(80 + i * 130, 100, 24);
  const row = findMarkers({ width: w, height: h, pixels: px, substrate: [255, 255, 255] });
  assert.equal(row.ok, false, 'a row of four squares must not be accepted as a page');
});

test('per-cell levels survive: split/join agreement after rectification', () => {
  const geom = planPage('PL-D3', { nozzle: '0.2' });
  const r = rng(2024);
  const levels = new Uint8Array(geom.totalCells);
  for (let i = 0; i < levels.length; i++) levels[i] = (r() * (1 << geom.bitsPerCell)) | 0;
  const { layout, bm } = renderIdeal(geom, levels, 300, 'INK4');
  const photo = makePhoto(bm, photoTransform({ scale: 1.3, rot: 0.03, ky: 0.00002 }), { noise: 8, blur: 1 });
  const found = findMarkers(photo);
  assert.ok(found.ok, found.reason);
  const rect = rectifyPage(photo, layout, found.quad);
  assert.ok(rect.ok, rect.reason);
  const read = readPageIdeal(rect, layout, geom, 'INK4');
  let badShape = 0;
  let badColour = 0;
  for (let i = 0; i < levels.length; i++) {
    const a = splitCellLevel(levels[i], geom);
    const b = splitCellLevel(read.levels[i], geom);
    if (a.shape !== b.shape) badShape++;
    if (a.colour !== b.colour) badColour++;
  }
  assert.equal(badShape, 0, 'shape channel must survive a 3-bit page through perspective');
  assert.equal(badColour, 0, 'colour channel must survive too');
});
