import test from 'node:test';
import assert from 'node:assert/strict';
import { planPage } from '../../core/profiles.js';
import { encodeTransfer, TransferAssembler, unpackLevels } from '../../core/protocol.js';
import { pageLayout, QUIET_CELLS } from '../../core/render/layout.js';
import { renderPageBitmap, echoBitsOf, coverageStats, buildCoverageTiles, measureTargets } from '../../core/render/raster.js';
import { rhoTable, shapeThresholds, rhoFor, MEASURE, ANNULUS_INNER, dotRadiusForRho, levelFromRho } from '../../core/render/glyphs.js';
import { readPageIdeal } from '../../core/decode/ideal.js';
import { decodeHeader, encodeHeader, HEADER_LEN } from '../../core/frame.js';
import { PALETTES } from '../../core/palette.js';

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
const rndBytes = (n, seed = 1) => {
  const r = rng(seed);
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (r() * 256) | 0;
  return b;
};
const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/* ------------------------------------------------------------------ */
/* glyph geometry                                                      */
/* ------------------------------------------------------------------ */

test('glyphs: rho targets are separable and the dot never touches the ring', () => {
  for (const levels of [2, 3, 4, 5]) {
    const t = shapeThresholds(levels);
    assert.equal(t.targets.length, levels);
    assert.equal(t.targets[0], 0);
    for (let i = 1; i < levels; i++) assert.ok(t.targets[i] > t.targets[i - 1], 'monotone');
    for (const rho of t.targets) {
      const rd = dotRadiusForRho(rho);
      assert.ok(rd < ANNULUS_INNER, `rho ${rho} gives dot radius ${rd}, which would merge into the ring`);
      assert.ok(rd < MEASURE.dotR, `rho ${rho} gives dot radius ${rd}, outside the ${MEASURE.dotR} measurement cut`);
    }
    // every target must classify back to its own level
    for (let i = 0; i < levels; i++) assert.equal(t.targets[i] === 0 ? 0 : nearestLevelTo(t.targets[i], t), i, `level ${i} of ${levels}`);
  }
});

function nearestLevelTo(rho, t) {
  let best = 0;
  let bd = Infinity;
  t.targets.forEach((target, i) => {
    const d = Math.abs(target - rho);
    if (d < bd) {
      bd = d;
      best = i;
    }
  });
  return best;
}

test('glyphs: coverage tiles integrate to the rho they claim', () => {
  const cellPx = 24;
  const levels = 4;
  const tiles = buildCoverageTiles(cellPx, levels);
  const perCell = cellPx * cellPx;
  let lastRho = -1;
  for (let level = 0; level < levels; level++) {
    const tile = tiles[level];
    let dot = 0;
    let band = 0;
    for (let py = 0; py < cellPx; py++) {
      for (let px = 0; px < cellPx; px++) {
        const nx = (px + 0.5) / cellPx - 0.5;
        const ny = (py + 0.5) / cellPx - 0.5;
        const rr = Math.hypot(nx, ny);
        const a = tile[py * cellPx + px] / 255;
        if (rr <= MEASURE.dotR) dot += a;
        else if (rr >= MEASURE.bandIn && rr <= MEASURE.bandOut) band += a;
      }
    }
    const rho = dot / (band * MEASURE.bandScale);
    const want = rhoFor(level, levels);
    // the buckets the decoder will really use: measured at this cell size
    const calibrated = measureTargets(cellPx, levels);
    const t = shapeThresholds(levels, { targets: calibrated });
    assert.ok(band * MEASURE.bandScale / perCell > 0.2, `ring barely printed at level ${level}: ${band / perCell}`);
    assert.equal(levelFromRho(rho, t), level, `level ${level}: measured rho ${rho.toFixed(4)} vs target ${want.toFixed(4)}`);
    assert.ok(Math.abs(rho - calibrated[level]) < 0.004, `level ${level}: measureTargets disagrees with the tile integration`);
    if (level > 0) assert.ok(calibrated[level] > calibrated[level - 1], 'measured targets must stay monotone');
    // the margin that actually protects us: distance to the nearest bucket edge
    const edges = [...t.mid, t.noDot, t.blob];
    const nearest = Math.min(...edges.map((m) => Math.abs(m - rho)));
    assert.ok(nearest > 0.05, `level ${level}: only ${nearest.toFixed(3)} of margin to a decision threshold`);
    assert.ok(Math.abs(rho - want) < 0.09, `level ${level}: raw bias ${(rho - want).toFixed(4)} too large to calibrate away`);
    if (level > 0) assert.ok(rho > lastRho, 'measurements must stay monotone in the level');
    lastRho = rho;
  }
});

/* ------------------------------------------------------------------ */
/* layout                                                              */
/* ------------------------------------------------------------------ */

test('layout: page grows with dpi, cells stay integral, everything fits', () => {
  const geom = planPage('PL-D2', { nozzle: '0.4' });
  const a = pageLayout(geom, 300, { plateMm: 200 });
  const b = pageLayout(geom, 600, { plateMm: 200 });
  // doubling dpi doubles the pixel count only up to per-page rounding of the pitch
  assert.ok(Math.abs(a.cellPx * 2 - b.cellPx) <= 2, `${a.cellPx}px vs ${b.cellPx}px`);
  assert.ok(Math.abs(a.width * 2 - b.width) / b.width < 0.03, `${a.width} vs ${b.width}`);
  assert.ok(Math.abs(a.height * 2 - b.height) / b.height < 0.03);
  assert.ok(Math.abs(a.physicalMm.wMm - (geom.cols + 2 * QUIET_CELLS) * geom.pitchMm) < 2.5);
  assert.ok((geom.cols + 2 * QUIET_CELLS) * geom.pitchMm <= planPage('PL-D2', { nozzle: '0.4' }).sheetMm.w + 1e-6,
    'the printed page must fit the plate it was planned for');
  assert.ok(a.originPx.x % a.cellPx === 0 && a.originPx.y >= a.quietPx, 'lattice must sit on the cell grid below the echo strip');
  assert.ok(a.echo.y + a.echo.rows * a.echo.cellPx <= a.originPx.y, 'echo strip must sit above the lattice');
  for (const f of a.fiducials) {
    assert.ok(f.x - f.half >= 0 && f.y - f.half >= 0);
    assert.ok(f.x + f.half <= a.width && f.y + f.half <= a.height);
  }
  assert.equal(a.echo.bits % 8, 0);
  assert.equal(a.echo.cols * a.echo.rows, HEADER_LEN * 8);
});

test('layout: refuses a pitch that is not printable at the requested dpi', () => {
  const geom = planPage('P-M1-600');
  assert.throws(() => pageLayout(geom, 150, {}), /min|raise the dpi/i);
});

/* ------------------------------------------------------------------ */
/* ideal render -> ideal read (the seed of G1)                         */
/* ------------------------------------------------------------------ */

function renderAndRead(pid, opts, dpi, levels, paletteId = 'INK2', mono = false) {
  const geom = planPage(pid, opts);
  const layout = pageLayout(geom, dpi, opts);
  const bitmap = renderPageBitmap({ geom, levels, layout, palette: paletteId, mono });
  const read = readPageIdeal(bitmap, layout, geom, paletteId);
  return { geom, layout, bitmap, read };
}

test('render+ideal read: every cell comes back with the levels that went in', () => {
  const per = planPage('PL-D2', { nozzle: '0.4' });
  const cells = per.totalCells;
  const r = rng(7);
  const maxLevel = (1 << per.bitsPerCell) - 1;
  const levels = new Uint16Array(cells);
  for (let i = 0; i < cells; i++) levels[i] = (r() * (maxLevel + 1)) | 0;
  const { read } = renderAndRead('PL-D2', { nozzle: '0.4' }, 300, levels);
  let bad = 0;
  const hist = new Map();
  for (let i = 0; i < cells; i++) {
    if (read.levels[i] !== levels[i]) {
      bad++;
      const key = `${levels[i]}->${read.levels[i]}`;
      hist.set(key, (hist.get(key) || 0) + 1);
    }
  }
  assert.equal(bad, 0, `${bad}/${cells} cells misread; worst: ${[...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).join(', ')}`);
  assert.equal(read.colourAlive, true);
});

test('render+ideal read: 4-level shape alphabet at 0.2 nozzle', () => {
  const geom = planPage('PL-D3S', { nozzle: '0.2' });
  const r = rng(11);
  const maxLevel = (1 << geom.bitsPerCell) - 1;
  const levels = Uint16Array.from({ length: geom.totalCells }, () => (r() * (maxLevel + 1)) | 0);
  const { read } = renderAndRead('PL-D3S', { nozzle: '0.2' }, 600, levels, 'INK4');
  let bad = 0;
  for (let i = 0; i < levels.length; i++) if (read.levels[i] !== levels[i]) bad++;
  assert.ok(bad === 0, `${bad}/${levels.length} cells misread at 4 levels`);
});

test('render: byte deterministic, and mono differs from colour only in ink', () => {
  const geom = planPage('PL-D2', { nozzle: '0.6' });
  const layout = pageLayout(geom, 300, { plateMm: 200 });
  const levels = Uint16Array.from({ length: geom.totalCells }, (_, i) => (i * 7) % 4);
  const a = renderPageBitmap({ geom, levels, layout, palette: 'INK2' });
  const b = renderPageBitmap({ geom, levels, layout, palette: 'INK2' });
  assert.ok(eq(a.pixels, b.pixels), 'same input must give the same bytes');
  const m = renderPageBitmap({ geom, levels, layout, palette: 'INK2', mono: true });
  assert.ok(!eq(a.pixels, m.pixels), 'mono must look different');
  assert.deepEqual(Array.from(m.substrate), Array.from(PALETTES.INK2.background));
  const inks = new Set();
  for (let i = 0; i < m.pixels.length; i += 4) inks.add(`${m.pixels[i]},${m.pixels[i + 1]},${m.pixels[i + 2]}`);
  assert.ok(inks.size < 300, `mono render leaked several inks (${inks.size} distinct colours)`);
});

test('coverage: printed area fraction stays in a printable band for every profile', () => {
  for (const [pid, opts, palette] of [
    ['PL-M1', { nozzle: '0.4' }, 'PAPER1'],
    ['PL-D2', { nozzle: '0.4' }, 'INK2'],
    ['PL-D3', { nozzle: '0.2' }, 'INK4'],
  ]) {
    const geom = planPage(pid, opts);
    const layout = pageLayout(geom, 300, { plateMm: 200 });
    const worst = { min: 1, max: 0 };
    for (const seed of [0, 1]) {
      const levels = Uint16Array.from({ length: geom.totalCells }, (_, i) => (seed ? (i * 31) % (1 << geom.bitsPerCell) : 0));
      const s = coverageStats({ geom, levels, layout, palette });
      worst.min = Math.min(worst.min, s.printedAreaFraction);
      worst.max = Math.max(worst.max, s.printedAreaFraction);
    }
    assert.ok(worst.min > 0.12, `${pid}: only ${(worst.min * 100).toFixed(1)}% printed - too sparse to reliably detect`);
    assert.ok(worst.max < 0.8, `${pid}: ${(worst.max * 100).toFixed(1)}% printed - will fuse at the printer`);
  }
});

/* ------------------------------------------------------------------ */
/* echo strip                                                          */
/* ------------------------------------------------------------------ */

test('echo strip: the frame header survives render and pixel readout', () => {
  const geom = planPage('PL-D2', { nozzle: '0.4' });
  const layout = pageLayout(geom, 300, { plateMm: 200 });
  const header = encodeHeader({
    profile: 'PL-D2',
    nozzle: '0.4',
    flags: 5,
    sessionId: rndBytes(8, 3),
    pageIndex: 11,
    totalPages: 23,
    kind: 1,
    payloadLen: 4242,
    intraK: 122,
    intraNsym: 122,
    dataBytesPerPage: 1342,
    dataPages: 17,
    blockPad: 9,
    digest: rndBytes(22, 4),
  });
  const bits = echoBitsOf(header);
  const levels = new Uint16Array(geom.totalCells);
  const bitmap = renderPageBitmap({ geom, levels, layout, palette: 'INK2', echoBits: bits });

  // read the micro-lattice back the way the decoder will: threshold on coverage
  const e = layout.echo;
  const sub = bitmap.substrate;
  const out = new Uint8Array(HEADER_LEN);
  for (let i = 0; i < e.bits; i++) {
    const cx = e.x + (i % e.cols) * e.cellPx + Math.floor(e.cellPx / 2);
    const cy = e.y + (((i / e.cols) | 0) + 0.5) * e.cellPx - 0.5;
    const o = (Math.round(cy) * bitmap.width + cx) * 4;
    const dark =
      (sub[0] - bitmap.pixels[o]) ** 2 + (sub[1] - bitmap.pixels[o + 1]) ** 2 + (sub[2] - bitmap.pixels[o + 2]) ** 2;
    const bit = dark > 6000 ? 1 : 0;
    out[i >> 3] |= bit << (7 - (i & 7));
  }
  assert.deepEqual(Array.from(out), Array.from(header), 'echo strip must reproduce the header bytes');
  const dec = decodeHeader(out);
  assert.equal(dec.ok, true, dec.reason);
  assert.equal(dec.header.pageIndex, 11);
  assert.equal(dec.header.totalPages, 23);
});

/* ------------------------------------------------------------------ */
/* end-to-end through the image, ideal channel                         */
/* ------------------------------------------------------------------ */

async function imageRoundTrip(pid, opts, payload, { dpi = 300, palette = 'INK2', mono = false } = {}) {
  const t = await encodeTransfer(payload, { profile: pid, ...opts });
  const asm = new TransferAssembler();
  const report = [];
  for (const p of t.pages) {
    const layout = pageLayout(p.geom ?? t.geom, dpi, opts);
    const bitmap = renderPageBitmap({ geom: t.geom, levels: p.levels, layout, palette, mono, echoBits: echoBitsOf(p.header) });
    const read = readPageIdeal(bitmap, layout, t.geom, palette);
    report.push(read);
    const missing = {};
    if (mono && !read.colourAlive) missing.colour = true;
    await asm.feed({
      levels: read.levels,
      header: p.header,
      channelMissing: Object.keys(missing),
    });
  }
  return { t, asm, report };
}

for (const [pid, opts, size] of [
  ['PL-D2', { nozzle: '0.4' }, 900],
  ['PL-D2', { nozzle: '0.2' }, 3000],
  ['PL-M1', { nozzle: '0.4' }, 900],
  ['PL-G', { nozzle: '0.8' }, 120],
  ['P-M1-300', {}, 6000],
]) {
  test(`G1 seed: ${pid}${opts.nozzle ? '@' + opts.nozzle : ''} bytes -> raster -> ideal read -> bytes`, async () => {
    const payload = rndBytes(size, 17);
    const { t, asm } = await imageRoundTrip(pid, opts, payload, {
      palette: pid.startsWith('P-') ? 'PAPER1' : pid === 'PL-D2' ? 'INK2' : 'PAPER1',
    });
    assert.ok(asm.result, `no result after ${t.pages.length} pages: ${asm.error || ''}`);
    assert.ok(eq(asm.result, payload), `${pid}: payload mismatch after image round trip`);
  });
}

test('G7 seed: a single-colour print of a protected profile still delivers the bytes', async () => {
  const payload = rndBytes(1500, 23);
  const { t, asm, report } = await imageRoundTrip('PL-D2', { nozzle: '0.4' }, payload, { mono: true });
  assert.ok(report.length >= 3);
  for (const read of report) assert.equal(read.colourAlive, false, 'mono render must be detectable as colour-dead');
  assert.ok(asm.result, `mono round trip failed: ${asm.error || 'no result'}`);
  assert.ok(eq(asm.result, payload), 'single-colour printing must not lose data');
});

test('G7 seed: an unprotected profile refuses rather than guessing under mono', async () => {
  const payload = rndBytes(1500, 24);
  const { asm } = await imageRoundTrip('PL-D3', { nozzle: '0.2' }, payload, { palette: 'INK4', mono: true });
  assert.equal(asm.result, null, 'PL-D3 (monoSafe off) must not silently produce bytes from a mono print');
});

test('G1 seed: 600 dpi paper page renders and reads back cell-exact', () => {
  const geom = planPage('P-M1-600');
  const layout = pageLayout(geom, 600, {});
  const r = rng(3);
  const levels = Uint16Array.from({ length: geom.totalCells }, () => (r() * 2) | 0);
  const t0 = performance.now();
  const bitmap = renderPageBitmap({ geom, levels, layout, palette: 'PAPER1' });
  const t1 = performance.now();
  const read = readPageIdeal(bitmap, layout, geom, 'PAPER1');
  const t2 = performance.now();
  let bad = 0;
  for (let i = 0; i < levels.length; i++) if (read.levels[i] !== levels[i]) bad++;
  console.log(`  600dpi page ${bitmap.width}x${bitmap.height}: render ${(t1 - t0).toFixed(0)}ms read ${(t2 - t1).toFixed(0)}ms, misread ${bad}/${levels.length}`);
  assert.equal(bad, 0, `600dpi paper page misread ${bad} of ${levels.length} cells`);
  assert.ok(t2 - t0 < 60000, `too slow: ${(t2 - t0) / 1000}s`);
});
