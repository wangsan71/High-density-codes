/**
 * PSKT unit tests -- the fourth corner: out of frame, or in frame and unreadable.
 *
 * `no-hollow-corner` used to carry both (docs/ACCEPTANCE.md defect #3), and the first attempt
 * at splitting them was refuted by measurement (docs/DEFECTS.md D36). What made that attempt
 * unsound was asking whether any blob sat near the implied fourth corner -- on a data lattice
 * something always does and off it nothing ever does, so no parameter could serve both. The
 * version tested here asks a question with no parameter: three same-size squares forming a
 * page-scale right angle imply a rectangle, and either its fourth corner is inside the image
 * or it is not.
 *
 * One geometric fact shapes these fixtures. For an axis-aligned page the implied corner always
 * falls inside the bounding box of the three visible ones, so the out-of-frame branch can only
 * fire under rotation or perspective -- which is precisely the hand-held phone case. Whitening
 * a corner inside a full-size image is therefore NOT an out-of-frame fixture (an earlier draft
 * of this file used it as one and was measuring the wrong thing); it is an in-frame unreadable
 * corner, and it is kept here as that.
 *
 * The synthetic fixtures paint plain squares. They carry a fourth, differently sized square
 * because detectIn refuses to look for markers at all below four candidates, and that is a
 * property of the detector rather than of the case under test.
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
  return { width: bmp.width, height: bmp.height, pixels: Uint8Array.from(bmp.pixels) };
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

// A blank RGBA canvas with a few solid squares on it. The small square is the fourth
// candidate detectIn insists on; it is deliberately a different size so it never joins the
// cluster under test.
function synthetic(squares, size = 1200) {
  const bmp = { width: size, height: size, pixels: new Uint8Array(size * size * 4) };
  bmp.pixels.fill(255);
  for (const [cx, cy, half] of squares) inkSquare(bmp, cx, cy, half ?? 15);
  return bmp;
}

test('a real page with its corner damaged in frame is refused, and the report describes markers, not lattice', async () => {
  const base = await cleanPage();

  const good = findMarkers({ ...base, pixels: Uint8Array.from(base.pixels) }, {});
  assert.equal(good.ok, true, `the clean fixture must be findable, got reason=${good.reason}`);
  assert.ok(good.quad && good.quad.br, `a found page must expose quad.br, got: ${Object.keys(good).join(', ')}`);
  const br = { x: Math.round(good.quad.br.x), y: Math.round(good.quad.br.y) };

  // Corner erased, image still full size: the sheet is framed, the marker cannot be read.
  const erased = { ...base, pixels: Uint8Array.from(base.pixels) };
  whiteOut(erased, Math.floor(erased.width * 0.8), Math.floor(erased.height * 0.8));
  const fmErased = findMarkers(erased, {});
  assert.equal(fmErased.ok, false, 'an unreadable corner must not be accepted');
  assert.equal(fmErased.reason, 'no-hollow-corner', `in-frame damage is not a framing complaint, got ${fmErased.reason}`);
  // D37: the failure must be reported from the marker cluster. Before that fix the tie-break
  // preferred the cluster with more candidates, so this read 5 -- a data cell -- while the
  // corner markers were 30 px, and every number a user saw described print noise.
  assert.ok(
    fmErased.maxBlobSide >= 20,
    `the report must describe the markers (~30 px), not the lattice (5 px): maxBlobSide=${fmErased.maxBlobSide}, clusterPx=${fmErased.clusterPx}`,
  );

  // Same region, plus a solid square where the marker belongs: present, but nothing is hollow.
  const solid = { ...base, pixels: Uint8Array.from(base.pixels) };
  whiteOut(solid, Math.floor(solid.width * 0.8), Math.floor(solid.height * 0.8));
  inkSquare(solid, br.x, br.y, 14);
  const fmSolid = findMarkers(solid, {});
  assert.equal(fmSolid.ok, false, 'a marker with no readable hole must not be accepted');
  assert.equal(fmSolid.reason, 'no-hollow-corner', `got ${fmSolid.reason}`);
  assert.ok(fmSolid.maxBlobSide >= 20, `maxBlobSide=${fmSolid.maxBlobSide} still looks like lattice`);

  console.log(`    corner-damage · erased=${fmErased.reason}(blob=${fmErased.maxBlobSide}px,cluster=${fmErased.clusterPx}px) · solid=${fmSolid.reason}(blob=${fmSolid.maxBlobSide}px)`);
});

test('three markers whose implied fourth corner is outside the image say so', () => {
  // Right angle at (600,600), arms to (1160,360) and (840,1160): equal length (609 px),
  // perpendicular, page-scale. The rectangle they imply has its fourth corner at (1400,920),
  // past the edge of a 1200 px image.
  const fm = findMarkers(synthetic([[600, 600], [1160, 360], [840, 1160], [200, 200, 6]]), {});
  assert.equal(fm.ok, false, 'three markers can never be accepted');
  assert.equal(
    fm.reason,
    'fourth-corner-out-of-frame',
    `expected the framing reason, got ${fm.reason} (implied=${JSON.stringify(fm.impliedCorner)})`,
  );
  assert.ok(fm.impliedCorner.x > 1200, `the implied corner must be off-image, got ${JSON.stringify(fm.impliedCorner)}`);
});

test('three markers whose implied fourth corner is inside the image do not blame framing', () => {
  // Axis-aligned right angle at (400,400) with 600 px arms: the implied corner (1000,1000) is
  // comfortably inside, so nothing here is a framing problem. Arms are kept well above the
  // page-scale floor under either reading of the page region (whole image, or ink bounding
  // box), because a fixture that only just clears a threshold is a fixture that will silently
  // stop testing anything the day the threshold moves.
  const fm = findMarkers(synthetic([[400, 400], [1000, 400], [400, 1000], [200, 200, 6]]), {});
  assert.equal(fm.ok, false);
  assert.equal(
    fm.reason,
    'no-hollow-corner',
    `an in-frame missing corner must not be reported as out of frame, got ${fm.reason} (implied=${JSON.stringify(fm.impliedCorner)})`,
  );
  assert.ok(fm.impliedCorner.x < 1200 && fm.impliedCorner.y < 1200);
});

test('four solid same-size squares still take the normal path and are refused', () => {
  // The three-marker branch must not swallow the ordinary four-marker case: all solid means
  // the orientation marker cannot be read, which is what the four-corner path already said.
  const fm = findMarkers(synthetic([[400, 400], [1000, 400], [400, 1000], [1000, 1000], [200, 200, 6]]), {});
  assert.equal(fm.ok, false, 'four solid markers carry no orientation and must not be accepted');
  assert.equal(fm.reason, 'no-hollow-corner', `got ${fm.reason}`);
});

test('three same-size squares in a row are not a rectangle (the branch cannot fire on garbage)', () => {
  const fm = findMarkers(synthetic([[300, 600], [600, 600], [900, 600], [200, 200, 6]]), {});
  assert.equal(fm.ok, false);
  assert.equal(fm.reason, 'no-rectangular-quad', `collinear specks must not be dressed up as a page, got ${fm.reason}`);
});
