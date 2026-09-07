/**
 * PSKT unit tests -- corner-damage fixtures must never be accepted.
 *
 * This file began as the test for a new failure reason that would tell a phone "your fourth
 * corner is out of frame" apart from "the marker is there and its hole cannot be read". That
 * separation was built, measured, and refuted (docs/DEFECTS.md D36): on a real page with
 * ~159 square candidates, any three same-size squares can form a page-scale right angle, so
 * the corner it implies is not the missing marker's corner. No reason is asserted here --
 * deliberately, and the current reasons are printed instead so the day someone rebuilds the
 * split, this output shows what it has to distinguish.
 *
 * What does get asserted is the part this contract cares about: a page whose fourth corner is
 * occluded, or whose orientation marker has been replaced by a solid blob, must be REFUSED.
 * A wrong label is a confusing message; a wrong acceptance is the one unforgivable outcome
 * (docs/PLAN.md). One test, three checks, no shared mutable state between tests -- an earlier
 * draft had two and its first assertion read a variable the second one assigned, which is the
 * fixture-authoring mistake already recorded in docs/DEFECTS.md D23.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { encodeTransfer } from '../../core/protocol.js';
import { pageLayout } from '../../core/render/layout.js';
import { renderPageBitmap, echoBitsOf } from '../../core/render/raster.js';
import { findMarkers } from '../../core/decode/fiducial.js';

// The same five calls tools/build-web.mjs uses to draw the PWA icon: module shapes copied
// from working code rather than reconstructed from memory.
async function cleanPage() {
  const it = await encodeTransfer(new Uint8Array(256).fill(0x33), { profile: 'P-M1-300' });
  const layout = pageLayout(it.geom, 300, { sheetMm: it.geom.sheetMm });
  const bmp = renderPageBitmap({
    geom: it.geom,
    levels: it.pages[0].levels,
    layout,
    palette: 'PAPER1',
    echoBits: echoBitsOf(it.pages[0].header),
  });
  return { width: bmp.width, height: bmp.height, pixels: Uint8ClampedArray.from(bmp.pixels) };
}

// White is paper, so painting a region white removes what was printed there.
function whiteOut(bmp, x0, y0) {
  for (let y = y0; y < bmp.height; y++) {
    for (let x = x0; x < bmp.width; x++) {
      const o = (y * bmp.width + x) * 4;
      bmp.pixels[o] = 255;
      bmp.pixels[o + 1] = 255;
      bmp.pixels[o + 2] = 255;
      bmp.pixels[o + 3] = 255;
    }
  }
}

function inkSquare(bmp, cx, cy, half) {
  for (let y = cy - half; y <= cy + half; y++) {
    for (let x = cx - half; x <= cx + half; x++) {
      if (x < 0 || y < 0 || x >= bmp.width || y >= bmp.height) continue;
      const o = (y * bmp.width + x) * 4;
      bmp.pixels[o] = 0;
      bmp.pixels[o + 1] = 0;
      bmp.pixels[o + 2] = 0;
      bmp.pixels[o + 3] = 255;
    }
  }
}

test('a page missing or unable to read its fourth corner is refused, never accepted', async () => {
  const base = await cleanPage();

  const good = findMarkers({ ...base, pixels: Uint8ClampedArray.from(base.pixels) }, {});
  assert.equal(good.ok, true, `the clean fixture must be findable, got reason=${good.reason}`);
  assert.ok(good.quad && good.quad.br, `a found page must expose quad.br, got: ${Object.keys(good).join(', ')}`);
  const br = { x: Math.round(good.quad.br.x), y: Math.round(good.quad.br.y) };

  // Fixture 1: the bottom-right corner of the sheet is not in the image at all.
  const cropped = { ...base, pixels: Uint8ClampedArray.from(base.pixels) };
  whiteOut(cropped, Math.floor(cropped.width * 0.8), Math.floor(cropped.height * 0.8));
  const fmCropped = findMarkers(cropped, {});
  assert.equal(fmCropped.ok, false, `occluded fourth corner must not be accepted (hollow=${fmCropped.hollowCount})`);

  // Fixture 2: same removed region, but a solid square of marker size sits where the marker
  // belongs -- the corner is demonstrably present, only its hole cannot be read.
  const solid = { ...base, pixels: Uint8ClampedArray.from(base.pixels) };
  whiteOut(solid, Math.floor(solid.width * 0.8), Math.floor(solid.height * 0.8));
  inkSquare(solid, br.x, br.y, 14);
  const fmSolid = findMarkers(solid, {});
  assert.equal(fmSolid.ok, false, 'a marker with no readable hole must not be accepted');

  // Printed, not asserted: this is what the pending reason split has to separate (D36).
  console.log(`    D36 现状 · 第四角被遮=${fmCropped.reason}(hollow=${fmCropped.hollowCount},cand=${fmCropped.candidates}) · 角标在而孔不可读=${fmSolid.reason}(hollow=${fmSolid.hollowCount},cand=${fmSolid.candidates})`);
});
