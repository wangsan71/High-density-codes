/**
 * PSKT-1 · one entry point from "an image" to "a page's worth of data".
 *
 * This is the composition root of the decoder: marker detection -> homography ->
 * echo header -> cell readout. Both the Node CLI and the browser receiver call
 * exactly this, so there is one readout path to test rather than one per host.
 *
 * A pristine render and a phone photo go through the *same* code. The fast path
 * (an image already aligned to the canvas) skips the warp only after confirming
 * the geometry is the expected one, because pixel-exactness is what lets the
 * ideal round-trip gate (G1) say "zero symbol errors" honestly.
 */

import { findMarkers } from './fiducial.js';
import { rectifyPage } from './warp.js';
import { readEcho } from './echo.js';
import { readPageIdeal } from './ideal.js';

/**
 * @param {object} bitmap {width,height,pixels,dpi?,substrate?} RGBA
 * @param {object} ctx {geom, layout, paletteId}
 * @param {object} [opts] {allowFastPath: true, threshold, quietZoneSubstrate, log}
 * @returns {{ok:true, levels, headerBytes, colourAlive, path:'fast'|'photo', markerPx, coverage} | {ok:false, stage, reason, advice?, detail}}
 */
export function decodePage(bitmap, { geom, layout, paletteId = 'INK2' }, opts = {}) {
  const alreadyCanvas =
    opts.allowFastPath !== false &&
    bitmap.width === layout.width &&
    bitmap.height === layout.height &&
    Math.abs((bitmap.dpi || layout.dpi) - layout.dpi) < 0.5;

  if (alreadyCanvas) {
    const fast = readFast(bitmap, geom, layout, paletteId);
    if (fast.ok) return { ...fast, path: 'fast', markerPx: null, coverage: 1 };
    // A page that claims to be canvas-sized but will not read is not a canvas:
    // it is far more likely to be a scan that happens to share the dimensions,
    // so fall through to the geometric path rather than giving up.
    if (opts.requireFastPath) return { ok: false, stage: 'fast', reason: fast.reason, detail: fast };
  }

  const found = findMarkers(bitmap, opts);
  if (!found.ok) return { ok: false, stage: 'markers', reason: found.reason, detail: found };

  const rect = rectifyPage(bitmap, layout, found.quad, opts);
  if (!rect.ok) return { ok: false, stage: 'rectify', reason: rect.reason, detail: rect };

  const read = readFast(rect, geom, layout, paletteId);
  if (!read.ok) return { ok: false, stage: 'readout', reason: read.reason, detail: read };
  return {
    ...read,
    path: 'photo',
    markerPx: found.markerPx,
    coverage: rect.coverage,
    substrate: rect.substrate,
    thresholdFactor: found.thresholdFactor,
  };
}

/** Header + cells from a bitmap already aligned to the page canvas. */
function readFast(bitmap, geom, layout, paletteId) {
  const echo = readEcho(bitmap, layout);
  if (!echo.ok) return { ok: false, reason: `echo-${echo.reason}`, detail: echo };
  const read = readPageIdeal(bitmap, layout, geom, paletteId);
  const levels = read.levels;
  if (!levels || levels.length !== geom.totalCells) {
    return { ok: false, reason: 'levels-length', detail: { have: levels ? levels.length : 0, want: geom.totalCells } };
  }
  return {
    ok: true,
    levels,
    headerBytes: echo.headerBytes,
    header: echo.header || null,
    colourAlive: read.colourAlive,
    quality: read.quality,
  };
}

/**
 * Decode a list of images into page records, classifying every failure rather
 * than aborting on the first one: a shoot with two bad frames out of seven must
 * still deliver if the parity covers it, and the operator must be told *which*
 * frames to retake and why.
 */
export function decodePages(images, ctx, opts = {}) {
  const pages = [];
  const failures = [];
  for (const img of images) {
    const r = decodePage(img.bitmap, ctx, opts);
    if (r.ok) {
      pages.push({ name: img.name, ...r });
    } else {
      failures.push({ name: img.name, stage: r.stage, reason: r.reason });
    }
  }
  return { pages, failures };
}
