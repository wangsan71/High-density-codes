import test from 'node:test';
import assert from 'node:assert/strict';

import { planPage } from '../../core/profiles.js';
import { encodeTransfer, TransferAssembler } from '../../core/protocol.js';
import { pageLayout } from '../../core/render/layout.js';
import { renderPageBitmap, echoBitsOf } from '../../core/render/raster.js';
import { readModuleIdeal } from '../../core/decode/module-read.js';
import { decodePage } from '../../core/decode/page.js';
import { moduleTimingLevel } from '../../core/render/modules.js';
import { encodePNG } from '../../core/render/png.js';
import { decodePNG } from '../../core/decode/png-read.js';
import { bootstrapDecode } from '../../core/decode/bootstrap.js';

const MODULE_PROFILES = ['P-MX-300-6', 'P-MX-300-5', 'P-MX-300-4'];
const PROFILE = MODULE_PROFILES[0];

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

function bytes(n, seed) {
  const r = rng(seed);
  return Uint8Array.from({ length: n }, () => (r() * 256) | 0);
}

test('module geometry reserves fixed timing rows outside the data payload', () => {
  for (const profile of MODULE_PROFILES) {
    const geom = planPage(profile, {});
    assert.equal(geom.moduleCols, geom.cols + 1, profile);
    assert.equal(geom.moduleRows, geom.rows + 1, profile);
    const layout = pageLayout(geom, geom.dpi, { sheetMm: geom.sheetMm });
    const levels = Uint16Array.from({ length: geom.totalCells }, () => 0);
    const bm = renderPageBitmap({ geom, levels, layout, palette: 'PAPER1' });
    const darkAt = (c, r) => {
      const x = Math.round(layout.originPx.x + (c + 0.5) * layout.cellPx);
      const y = Math.round(layout.originPx.y + (r + 0.5) * layout.cellPx);
      const o = (y * bm.width + x) * 4;
      return bm.pixels[o] < 128;
    };
    for (const [c, r] of [[0, 0], [1, 0], [2, 0], [0, 1], [0, 2], [0, 3]]) {
      assert.equal(darkAt(c, r), !!moduleTimingLevel(c, r), `${profile} timing ${c},${r}`);
    }
    const read = readModuleIdeal(bm, layout, geom);
    assert.equal(read.levels.length, geom.totalCells, `${profile}: timing modules must not consume payload capacity`);
  }
});

test('module render -> read preserves non-timing bits', () => {
  for (const profile of MODULE_PROFILES) {
    const geom = planPage(profile, {});
    const layout = pageLayout(geom, geom.dpi, { sheetMm: geom.sheetMm });
    const r = rng(11);
    const levels = Uint16Array.from({ length: geom.totalCells }, () => (r() * 2) | 0);
    const bm = renderPageBitmap({ geom, levels, layout, palette: 'PAPER1' });
    const read = readModuleIdeal(bm, layout, geom);
    let bad = 0;
    for (let row = 0; row < geom.rows; row++) {
      for (let col = 0; col < geom.cols; col++) {
        const i = row * geom.cols + col;
        if (read.levels[i] !== (levels[i] & 1)) bad++;
      }
    }
    assert.equal(bad, 0, `${profile}: ${bad}/${geom.totalCells} modules misread`);
  }
});

test('module transfer renders, rectifies, and assembles byte-exactly', async () => {
  const payload = bytes(9000, 77);
  const t = await encodeTransfer(payload, { profile: PROFILE });
  const layout = pageLayout(t.geom, t.geom.dpi, { sheetMm: t.geom.sheetMm });
  const asm = new TransferAssembler();
  for (const p of t.pages) {
    const bm = renderPageBitmap({ geom: t.geom, levels: p.levels, layout, palette: 'PAPER1', echoBits: echoBitsOf(p.header) });
    const dec = decodePage(bm, { geom: t.geom, layout, paletteId: 'PAPER1' }, { allowFastPath: false });
    assert.equal(dec.ok, true, `${p.index}: ${dec.stage}/${dec.reason}`);
    const fed = await asm.feed({
      levels: dec.levels,
      header: dec.headerBytes,
      channelMissing: dec.colourAlive ? [] : ['colour'],
      cellMissing: dec.cellMissing,
    });
    assert.equal(
      fed.ok,
      true,
      `${p.index}: ${fed.reason} erasures=${dec.cellMissing ? dec.cellMissing.reduce((a, b) => a + b, 0) : 0} ` +
        `blocks=${fed.stats ? `${fed.stats.okBlocks}/${fed.stats.blocks}, failed=${fed.stats.failedBlocks.join(',')}, erasures=${fed.stats.erasures}, errors=${fed.stats.errors}` : 'none'}`,
    );
  }
  assert.ok(asm.result, asm.error || 'no result');
  assert.equal(asm.result.length, payload.length);
  assert.ok(asm.result.every((v, i) => v === payload[i]), 'payload differs');
});

test('module page bootstraps through the same PNG path as the browser', async () => {
  const payload = bytes(4000, 99);
  const t = await encodeTransfer(payload, { profile: PROFILE });
  const layout = pageLayout(t.geom, t.geom.dpi, { sheetMm: t.geom.sheetMm });
  const p = t.pages[0];
  const bm = renderPageBitmap({ geom: t.geom, levels: p.levels, layout, palette: 'PAPER1', echoBits: echoBitsOf(p.header) });
  const decoded = decodePNG(encodePNG(bm));
  const boot = await bootstrapDecode(decoded, { profileHint: PROFILE, dpiHint: t.geom.dpi, paletteHint: 'PAPER1' });
  assert.equal(boot.ok, true, `${boot.reason}: ${boot.attempts.map((a) => `${a.profileId}/${a.paletteId}:${a.reason}`).join(' | ')}`);
  assert.equal(boot.attemptCount, 1, 'the explicit module profile must be the first candidate');
  const asm = new TransferAssembler();
  const fed = await asm.feed({
    levels: boot.page.levels,
    header: boot.page.headerBytes,
    channelMissing: boot.page.colourAlive ? [] : ['colour'],
    cellMissing: boot.page.cellMissing,
  });
  assert.equal(fed.ok, true, fed.reason);
});
