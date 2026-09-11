/**
 * core/decode/tile-read.js -- read data cells back out of a tiled page (PLAN v5 P4).
 *
 * This is the pristine half of the reader: it samples the page raster in the RENDERER's own pixel
 * geometry (the same modulePixels() the writer used), which is what makes a round trip possible at all.
 * Finding a tile inside a photograph -- marker detection, perspective, uneven lighting -- is a separate
 * brick on top of this one, and until it exists this file must not be described as "scans a photo".
 *
 * The header of each tile carries (index, tile count, payload length), so a reader that sees a single
 * tile can say which slice it is, and a reader that sees all of them can put the payload back together.
 */

import { modulePixels } from '../render/tilepage.js';
import { crc16 } from '../crc.js';
import { homographyFromQuad, apply } from './transform.js';
import { rsDecode } from '../rs.js';

const HEADER_BYTES = 4;
const CRC_BYTES = 2;
const RS_PARITY = 16;

/**
 * Find where a tile actually sits, instead of assuming it sits where the plan says.
 *
 * A photograph is never perfectly registered: the sheet is a few pixels off, or slightly rotated or
 * scaled. This searches a window around the planned position and scores each candidate by the only thing
 * that is unambiguous about a tile -- its four finder patterns: dark centre, light ring. It is NOT a
 * perspective solver (that brick does not exist yet); it absorbs translation, which is what a phone
 * pointed at a page mostly produces.
 */
export function findTileOffset(img, plan, layout, t, opts = {}) {
  const searchPx = opts.searchPx === undefined ? 12 : opts.searchPx;
  const dpi = opts.dpi === undefined ? img.dpi : opts.dpi;
  const px = modulePixels(plan.tileMm, layout.modules, dpi);
  const toPx = (mm) => Math.round((mm * dpi) / 25.4);
  const pos = plan.positions[t];
  const baseX = toPx(pos.x);
  const baseY = toPx(pos.y);
  const c = (layout.modules - 1) / 2;
  // The four patterns, each as (dark centre module, light ring module).
  const probes = [];
  for (const f of layout.finders) {
    probes.push({ dark: [f.x + 3, f.y + 3], light: [f.x + 1, f.y + 1] });
  }
  const sampleAt = (ox, oy) => {
    let score = 0;
    for (const p of probes) {
      const dx = ox + Math.round(p.dark[0] * px + (px >> 1));
      const dy = oy + Math.round(p.dark[1] * px + (px >> 1));
      const lx = ox + Math.round(p.light[0] * px + (px >> 1));
      const ly = oy + Math.round(p.light[1] * px + (px >> 1));
      if (dx < 0 || dy < 0 || dx >= img.width || dy >= img.height) continue;
      if (lx < 0 || ly < 0 || lx >= img.width || ly >= img.height) continue;
      if (img.pixels[(dy * img.width + dx) * 4] < 128) score++;
      if (img.pixels[(ly * img.width + lx) * 4] >= 128) score++;
    }
    return score;
  };
  let best = { dx: 0, dy: 0, score: -1 };
  for (let dy = -searchPx; dy <= searchPx; dy++) {
    for (let dx = -searchPx; dx <= searchPx; dx++) {
      const s = sampleAt(baseX + dx, baseY + dy);
      // Ties go to the offset closest to where the plan says the tile is: the planned position is a real
      // prior, and without this the winner is whichever far-away offset happened to be scanned first
      // (that is exactly what the first version returned -- -5 for an unshifted page).
      const closer = Math.abs(dx) + Math.abs(dy) < Math.abs(best.dx) + Math.abs(best.dy);
      if (s > best.score || (s === best.score && closer)) best = { dx, dy, score: s };
    }
  }
  const maxScore = probes.length * 2;
  if (best.score < maxScore - 1) {
    throw new RangeError('tile-read: no tile found near position ' + t + ' (best finder score ' + best.score + '/' + maxScore +
      ' at offset ' + best.dx + ',' + best.dy + ') -- the page may be missing, rotated or too far off');
  }
  // The score plateaus: every offset that keeps the probes inside the same module scores the same, so the
  // coarse search alone lands on the edge of the plateau (up to a module away from the truth). Refine by
  // taking the centroid of the dark pixels around each finder centre -- the pattern's actual middle -- and
  // using the average displacement of the four as the offset.
  const cx0 = baseX + best.dx;
  const cy0 = baseY + best.dy;
  const half = Math.max(2, Math.round(px * 0.7));
  let sumX = 0;
  let sumY = 0;
  let n = 0;
  for (const f of layout.finders) {
    const ex = cx0 + f.x * px + Math.round(f.size * px / 2);
    const ey = cy0 + f.y * px + Math.round(f.size * px / 2);
    let sx = 0;
    let sy = 0;
    let count = 0;
    for (let y = ey - half; y <= ey + half; y++) {
      if (y < 0 || y >= img.height) continue;
      for (let x = ex - half; x <= ex + half; x++) {
        if (x < 0 || x >= img.width) continue;
        if (img.pixels[(y * img.width + x) * 4] < 128) { sx += x; sy += y; count++; }
      }
    }
    if (!count) continue;
    sumX += sx / count - ex;
    sumY += sy / count - ey;
    n++;
  }
  const refined = n
    ? { dx: best.dx + Math.round(sumX / n), dy: best.dy + Math.round(sumY / n) }
    : { dx: best.dx, dy: best.dy };
  // The centroid cannot do better than the plateau here: a solid finder's core is a uniform dark block, so
  // any window that stays inside it has nothing to say about where its edges are. Use the format itself
  // instead -- the 32-bit header (tile index, tile count, payload length) is a hard constraint that only
  // the correct alignment satisfies, so choose among the candidates by whether the header validates.
  const expectedCount = plan.positions.length;
  let chosen = null;
  for (let dy = -searchPx; dy <= searchPx; dy++) {
    for (let dx = -searchPx; dx <= searchPx; dx++) {
      const h = headerAt(img, plan, layout, t, dpi, dx, dy, 0);
      if (!h) continue;
      if (h.index !== t || h.count !== expectedCount) continue;
      const cost = Math.abs(dx) + Math.abs(dy);
      if (!chosen || cost < chosen.cost) chosen = { dx, dy, cost, length: h.length };
    }
  }
  if (chosen) return { dx: chosen.dx, dy: chosen.dy, score: best.score, maxScore, px, source: 'header', length: chosen.length };
  return { ...refined, score: best.score, maxScore, px, source: 'centroid', coarseOffset: { dx: best.dx, dy: best.dy }, findersUsed: n };
}

/** Module coordinates under a rotation of the tile: 0, 90, 180 or 270 degrees. */
/**
 * Page-level mapping: where does the sheet's own pixel grid land in this photograph?
 *
 * The per-tile offset search absorbs a nudge; it cannot absorb perspective, because every row of the page
 * moves by a different amount (measured in STATUS round 180: 12-16 px at 300 dpi, then refusals). Given the
 * four corners of the sheet in the image, ONE homography maps the whole grid and every tile is read through
 * it. Points must be {x, y} objects -- transform.js destructures them (STATUS round 182).
 */
export function pageMapper(quad, srcW, srcH) {
  if (!Array.isArray(quad) || quad.length !== 4) throw new RangeError('tile-read: pageMapper needs the four sheet corners as {x,y} objects');
  const H = homographyFromQuad([{ x: 0, y: 0 }, { x: srcW, y: 0 }, { x: srcW, y: srcH }, { x: 0, y: srcH }], quad);
  return (sx, sy) => { const p = apply(H, sx, sy); return [p.x, p.y]; };
}

/**
 * Least-squares homography from anchor pairs ({gx,gy} page-grid pixels -> {ix,iy} image pixels).
 * 8 unknowns with h33 fixed at 1. Verified in STATUS round 235: exact anchors reproduce the transform to
 * 0.0 px, and anchors carrying +-3 px of noise still fit to 3.5 px -- which is the accuracy the refinement
 * below needs.
 */
function fitHomographyLS(pairs) {
  if (!Array.isArray(pairs) || pairs.length < 4) {
    throw new RangeError('tile-read: a homography needs at least 4 anchor pairs, got ' + (pairs ? pairs.length : 0));
  }
  const A = [];
  for (let i = 0; i < 8; i++) A.push(new Array(9).fill(0));
  for (const q of pairs) {
    const r1 = [q.gx, q.gy, 1, 0, 0, 0, -q.ix * q.gx, -q.ix * q.gy];
    const r2 = [0, 0, 0, q.gx, q.gy, 1, -q.iy * q.gx, -q.iy * q.gy];
    for (let i = 0; i < 8; i++) {
      for (let j = 0; j < 8; j++) A[i][j] += r1[i] * r1[j] + r2[i] * r2[j];
      A[i][8] += r1[i] * q.ix + r2[i] * q.iy;
    }
  }
  for (let i = 0; i < 8; i++) {
    let piv = i;
    for (let k = i + 1; k < 8; k++) if (Math.abs(A[k][i]) > Math.abs(A[piv][i])) piv = k;
    const tmp = A[i]; A[i] = A[piv]; A[piv] = tmp;
    if (Math.abs(A[i][i]) < 1e-12) {
      throw new RangeError('tile-read: these anchor pairs do not determine a homography (degenerate configuration)');
    }
    for (let k = i + 1; k < 8; k++) {
      const f = A[k][i] / A[i][i];
      for (let j = i; j <= 8; j++) A[k][j] -= f * A[i][j];
    }
  }
  const h = new Array(8);
  for (let i = 7; i >= 0; i--) {
    let s = A[i][8];
    for (let j = i + 1; j < 8; j++) s -= A[i][j] * h[j];
    h[i] = s / A[i][i];
  }
  return [[h[0], h[1], h[2]], [h[3], h[4], h[5]], [h[6], h[7], 1]];
}

/**
 * Measure one tile's origin in IMAGE space through the page model handed in.
 *
 * The model supplies more than a position: probing the map itself gives its LOCAL SHAPE (the 2x2 Jacobian,
 * in image pixels per module), and the finder test points are laid out through that Jacobian instead of on
 * a fixed axis-aligned grid. Doing this through the map is what makes the measurer work for any map.
 *
 * Why it matters -- measured on a 5 degree tilt, same page, same window (STATUS round 237): scoring an
 * axis-aligned tile through a ROUGH model biases the answer by an amount that grows along the row, col1
 * (-3.0,-2.5) px against col5 (+1.0,+2.0) px, worst 11.2 px, and 16 of the 48 tiles never reach a score at
 * all; through the model's own Jacobian the same probe is flat (col0 (1.0,1.8) .. col5 (1.0,2.0), worst
 * 2.2 px, 48/48 measured). The residual bias is a constant, so the homography fit absorbs it.
 *
 * Returns {x, y, gx, gy, score, points} or null when the tile's finder signature cannot be found.
 */
function measureTileOrigin(img, plan, layout, t, dpi, map, opts = {}) {
  const px = modulePixels(plan.tileMm, layout.modules, dpi);
  const toPx = (mm) => Math.round((mm * dpi) / 25.4);
  const pos = plan.positions[t];
  const gx = toPx(pos.x);
  const gy = toPx(pos.y);
  const c = map(gx, gy);
  const ax = map(gx - px, gy), bx2 = map(gx + px, gy);
  const ay = map(gx, gy - px), by = map(gx, gy + px);
  const jx = [(bx2[0] - ax[0]) / 2, (bx2[1] - ax[1]) / 2];
  const jy = [(by[0] - ay[0]) / 2, (by[1] - ay[1]) / 2];
  const dark = (x, y) => {
    const xi = Math.round(x), yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= img.width || yi >= img.height) return 0;
    return img.pixels[(yi * img.width + xi) * 4] < 128 ? 1 : 0;
  };
  const score = (ox, oy) => {
    let s = 0;
    for (const f of layout.finders) {
      const row = (m) => {
        const dx = f.x + m + 0.5, dy = f.y + 3.5;
        return dark(ox + jx[0] * dx + jy[0] * dy, oy + jx[1] * dx + jy[1] * dy);
      };
      const m1 = row(1), m2 = row(2), m3 = row(3), m4 = row(4);
      if (f.hollow) { if (!m1 && !m2 && m3 && !m4) s += 4; } else if (!m1 && m2 && m3 && m4) s += 4;
    }
    return s;
  };
  const minScore = opts.minScore === undefined ? 16 : opts.minScore;
  const reach = opts.reach === undefined ? 64 : opts.reach;
  const coarse = opts.coarse === undefined ? Math.max(2, px >> 2) : opts.coarse;
  let best = -1, bdx = 0, bdy = 0;
  for (let dx = -reach; dx <= reach; dx += coarse) {
    for (let dy = -reach; dy <= reach; dy += coarse) {
      const s = score(c[0] + dx, c[1] + dy);
      if (s > best) { best = s; bdx = dx; bdy = dy; }
    }
  }
  if (best < minScore) return null;
  // The optimum sits on a plateau a few pixels wide; average it at whole-pixel resolution so the answer is
  // sub-pixel instead of quantised to the coarse grid.
  const fine = coarse + 2;
  let top = -1;
  for (let dx = bdx - fine; dx <= bdx + fine; dx++) for (let dy = bdy - fine; dy <= bdy + fine; dy++) {
    const s = score(c[0] + dx, c[1] + dy);
    if (s > top) top = s;
  }
  let sx = 0, sy = 0, n = 0;
  for (let dx = bdx - fine; dx <= bdx + fine; dx++) for (let dy = bdy - fine; dy <= bdy + fine; dy++) {
    if (score(c[0] + dx, c[1] + dy) === top) { sx += dx; sy += dy; n++; }
  }
  if (n === 0) return null;
  return { x: c[0] + sx / n, y: c[1] + sy / n, gx, gy, score: top, points: n };
}

/**
 * Re-fit the page model from the tiles themselves, one measurement pass at a time.
 *
 * A quad measured off a tilted photograph is a ROUGH model: its local shape is wrong, and a wrong shape is
 * what fills the measurement with a position-dependent bias. Measuring through the model and then fitting a
 * homography to those anchors replaces the shape with the page's real one, and the next pass measures
 * through that. Measured on a 5 degree tilt (STATUS round 237): pass 0 -- rough Jacobian -- 32/48 anchors,
 * worst origin error 16.96 px; pass 1 -- fitted Jacobian -- 48/48 anchors, worst 2.75 px; pass 2, 1.62 px.
 * The first pass is the expensive one (a rough model can be tens of pixels out); the later ones search a
 * small window because the previous fit already put the tile within a few pixels.
 *
 * opts.report, when given, is called once per pass with {pass, anchors, residual, refined, H}: H is the
 * fitted homography itself, which is what makes "where did the refinement actually put the page?" a
 * measurable question instead of a claim (and is how the identity stage below is probed).
 *
 * Returns a new map function, or null when fewer than 8 tiles could be measured -- the caller keeps its own
 * map then, and the per-tile CRC still decides what is readable.
 */
function refinePageMap(img, plan, layout, dpi, map, opts = {}) {
  // Four passes, not two: the fit after the first pass still carries a couple of pixels of per-tile error,
  // and at 25 px of corner error that is the difference between 20 unreadable tiles and none (measured in
  // STATUS round 237). Pass 0 searches +-64 px with its own coarse step; the later ones only +-16 px, so
  // each extra pass costs a few hundred candidate positions per tile, not thousands.
  const passes = opts.passes === undefined ? 4 : opts.passes;
  const report = opts.report || null;
  let cur = map;
  for (let pass = 0; pass < passes; pass++) {
    const o = { coarse: opts.coarse, minScore: opts.minScore };
    o.reach = pass === 0
      ? (opts.reach === undefined ? 64 : opts.reach)
      : (opts.reachFine === undefined ? 16 : opts.reachFine);
    const pairs = [];
    for (let t = 0; t < plan.positions.length; t++) {
      const m = measureTileOrigin(img, plan, layout, t, dpi, cur, o);
      if (m) pairs.push({ gx: m.gx, gy: m.gy, ix: m.x, iy: m.y });
    }
    if (pairs.length < 8) {
      if (report) report({ pass, anchors: pairs.length, refined: false });
      return null;
    }
    const H = fitHomographyLS(pairs);
    let residual = 0;
    for (const q of pairs) {
      const p = apply(H, q.gx, q.gy);
      residual = Math.max(residual, Math.hypot(p.x - q.ix, p.y - q.iy));
    }
    cur = (sx, sy) => { const p = apply(H, sx, sy); return [p.x, p.y]; };
    if (report) report({ pass, anchors: pairs.length, residual, refined: true, H });
  }
  return cur;
}

/**
 * Which slice does the model THINK it is looking at, and which one is actually there?
 *
 * A geometric fit cannot answer that: the tile lattice is periodic, so a model one tile out scores just as
 * well as a correct one (that is why findPageQuadFromTiles corners can sit 719 px out and still look tidy).
 * The tile header carries the index, so the header is what decides. Each tile that reads cleanly votes for
 * (declared - assumed); the vote must be decisive -- at least 8 clean reads and a 60 percent majority -- or
 * no correction is made at all. Measured on a 5 degree tilt (STATUS round 237): 32 of 40 clean reads voted
 * +2, the rest were blank margin declaring 0, and the page read 48/48 once the model was moved back.
 */
function identifyShift(img, plan, layout, dpi, map, opts = {}) {
  const minVotes = opts.minVotes === undefined ? 8 : opts.minVotes;
  const majority = opts.majority === undefined ? 0.6 : opts.majority;
  const tally = new Map();
  let votes = 0;
  for (let t = 0; t < plan.positions.length; t++) {
    let declared = null;
    try { declared = readTile(img, plan, layout, t, dpi, null, { map }).index; }
    catch (e) {
      // The index is checked before the CRC, so only the tiles that got far enough to name an index count as
      // evidence; "could not be corrected" and "reaches outside the image" are not votes.
      const m = /declares index (\d+)/.exec(String(e.message));
      if (m) declared = Number(m[1]);
    }
    if (declared === null) continue;
    votes++;
    const diff = declared - t;
    tally.set(diff, (tally.get(diff) || 0) + 1);
  }
  let best = 0, bestN = 0;
  for (const [k, n] of tally) if (n > bestN) { best = k; bestN = n; }
  if (votes < minVotes || best === 0 || bestN < majority * votes) return { shift: 0, votes, agreed: bestN, decided: false };
  return { shift: best, votes, agreed: bestN, decided: true };
}

/** Move a source-space map by whole tiles: source coordinate s now samples what s - shift used to. */
function shiftMapSource(map, plan, dpi, shift) {
  const drow = Math.floor(shift / plan.cols);
  const dcol = shift % plan.cols;
  const pitchX = (plan.positions[1].x - plan.positions[0].x) * (dpi / 25.4);
  const pitchY = (plan.positions[plan.cols].y - plan.positions[0].y) * (dpi / 25.4);
  return (sx, sy) => map(sx - dcol * pitchX, sy - drow * pitchY);
}

/**
 * Find the sheet's four corners from the tiles themselves.
 *
 * The tiled page carries no sheet-level markers (round 188: the legacy detector answers "no-hollow-corner"),
 * so the tiles ARE the fiducials. Every step below was measured on a sheared page before it was written:
 *
 *  1. scan for the sharp per-finder signature (round 189: solid reads light-dark-dark-dark across modules
 *     1..4, hollow reads light-light-dark-light). 137 hits on the test page.
 *  2. three coarse extremes give a provisional affine; measured worst error over the 48 tiles: 5.7 px
 *     (my earlier guess that it would be a module out was wrong -- round 194).
 *  3. pair every hit with its nearest tile under that model and least-squares refit. With a 15 px
 *     tolerance that pairs all 137 hits and puts the sheet corners within 1.6 px (round 194), which is what
 *     turns the six unreadable tiles of round 190 into zero.
 *
 * The model is affine: a shear is affine, and the returned quad is only a starting point. A perspective
 * photograph needs 8 unknowns instead of 6; that fit is refinePageMap() below, which is now the default
 * step inside readTilePage whenever a map is supplied (STATUS round 237 -- the affine quad alone corners a
 * 5 degree tilt 25.3 px out and reads nothing; refined, 48/48 tiles).
 */
export function findPageQuadFromTiles(img, plan, layout, opts = {}) {
  const dpi = opts.dpi === undefined ? img.dpi : opts.dpi;
  if (!(opts.sheetW > 0 && opts.sheetH > 0)) {
    throw new RangeError('tile-read: findPageQuadFromTiles needs sheetW and sheetH in millimetres');
  }
  const px = modulePixels(plan.tileMm, layout.modules, dpi);
  const step = opts.step === undefined ? Math.max(2, px >> 1) : opts.step;
  const tolerance = opts.pairTolerance === undefined ? Math.max(6, Math.round(px * 1.5)) : opts.pairTolerance;
  const toPx = (mm) => Math.round((mm * dpi) / 25.4);
  const dark = (x, y) => {
    if (x < 0 || y < 0 || x >= img.width || y >= img.height) return 0;
    return img.pixels[(y * img.width + x) * 4] < 128 ? 1 : 0;
  };
  const scoreTile = (ox, oy) => {
    let s = 0;
    for (const f of layout.finders) {
      const row = (m) => dark(ox + f.x * px + Math.round((m + 0.5) * px), oy + f.y * px + Math.round(3.5 * px));
      const m1 = row(1), m2 = row(2), m3 = row(3), m4 = row(4);
      if (f.hollow) { if (!m1 && !m2 && m3 && !m4) s += 4; } else if (!m1 && m2 && m3 && m4) s += 4;
    }
    return s;
  };
  const span = layout.modules * px;
  const hits = [];
  for (let oy = 0; oy + span < img.height; oy += step) {
    for (let ox = 0; ox + span < img.width; ox += step) if (scoreTile(ox, oy) === 16) hits.push({ ox, oy });
  }
  if (hits.length < 8) {
    throw new RangeError('tile-read: only ' + hits.length + ' tile signature hit(s) in this image -- the page ' +
      'may be missing, too small, or too blurred to find');
  }
  const grid = (t) => ({ x: toPx(plan.positions[t].x), y: toPx(plan.positions[t].y) });
  const fitAffine = (pairs) => {
    let Sxx = 0, Sxy = 0, Syy = 0, Sx = 0, Sy = 0;
    let Sxu = 0, Syu = 0, Su = 0, Sxv = 0, Syv = 0, Sv = 0;
    for (const p of pairs) {
      Sxx += p.gx * p.gx; Sxy += p.gx * p.gy; Syy += p.gy * p.gy; Sx += p.gx; Sy += p.gy;
      Sxu += p.gx * p.ox; Syu += p.gy * p.ox; Su += p.ox;
      Sxv += p.gx * p.oy; Syv += p.gy * p.oy; Sv += p.oy;
    }
    const n = pairs.length;
    const solve3 = (M, r) => {
      const A = M.map((row, i) => row.concat([r[i]]));
      for (let i = 0; i < 3; i++) {
        let piv = i;
        for (let k = i + 1; k < 3; k++) if (Math.abs(A[k][i]) > Math.abs(A[piv][i])) piv = k;
        const tmp = A[i]; A[i] = A[piv]; A[piv] = tmp;
        for (let k = i + 1; k < 3; k++) {
          const f = A[k][i] / A[i][i];
          for (let j = i; j < 4; j++) A[k][j] -= f * A[i][j];
        }
      }
      const out = [0, 0, 0];
      for (let i = 2; i >= 0; i--) { let s = A[i][3]; for (let j = i + 1; j < 3; j++) s -= A[i][j] * out[j]; out[i] = s / A[i][i]; }
      return out;
    };
    const M = [[Sxx, Sxy, Sx], [Sxy, Syy, Sy], [Sx, Sy, n]];
    const ax = solve3(M, [Sxu, Syu, Su]);
    const ay = solve3(M, [Sxv, Syv, Sv]);
    return (gx, gy) => [ax[0] * gx + ax[1] * gy + ax[2], ay[0] * gx + ay[1] * gy + ay[2]];
  };
  const gridLine = (t) => grid(t);
  const collect = (model, tol) => {
    const byTile = new Map();
    for (const h of hits) {
      let bestT = -1;
      let bd = Infinity;
      for (let t = 0; t < plan.positions.length; t++) {
        const g = gridLine(t);
        const p = model(g.x, g.y);
        const d = Math.hypot(h.ox - p[0], h.oy - p[1]);
        if (d < bd) { bd = d; bestT = t; }
      }
      if (bd > tol) continue;
      if (!byTile.has(bestT)) byTile.set(bestT, { n: 0, ox: 0, oy: 0 });
      const acc = byTile.get(bestT);
      acc.n++; acc.ox += h.ox; acc.oy += h.oy;
    }
    const out = [];
    for (const [t, acc] of byTile) {
      const g = gridLine(t);
      out.push({ gx: g.x, gy: g.y, ox: acc.ox / acc.n, oy: acc.oy / acc.n, tile: t, n: acc.n });
    }
    return out;
  };
  // A few candidate identities for the top-most-left hit, each taken through the WHOLE pipeline. The old
  // version assumed that hit was tile 0, which fails silently when a corner tile has no hit at all (round
  // 198: 41 of 48 tiles had anchors at an 80 px skew). Scoring the hypotheses with a crude model did not
  // work either -- a translation model cannot tell a one-row-out guess from the right one (round 200), so
  // the score here is the number of tiles the FITTED model can anchor.
  const h1 = hits.reduce((a, b) => (b.ox + b.oy < a.ox + a.oy ? b : a));
  const candidates = opts.seedCandidates || [0, 1, plan.cols, plan.cols + 1];
  const attempt = (t1) => {
    const g1 = gridLine(t1);
    const seedModel = (gx, gy) => [h1.ox + (gx - g1.x), h1.oy + (gy - g1.y)];
    const first = collect(seedModel, Math.max(40, Math.round(toPx(plan.tileMm + plan.gapMm) / 5)));
    if (first.length < 8) return null;
    const fittedModel = fitAffine(first);
    const refined = collect(fittedModel, tolerance);
    if (refined.length < 8) return null;
    return { model: fitAffine(refined), anchors: refined.length, t1 };
  };
  let best = null;
  for (const t1 of candidates) {
    const a = attempt(t1);
    if (a && (!best || a.anchors > best.anchors)) best = a;
  }
  if (!best) {
    throw new RangeError('tile-read: no tile-identity hypothesis could anchor the grid -- the page may be ' +
      'missing, rotated or too distorted to fit');
  }
  let model = best.model;
  const byTile = new Map();
  for (const p of collect(model, tolerance)) byTile.set(p.tile, p);
  const pairs = [];
  for (const [t, acc] of byTile) pairs.push(acc);
  model = fitAffine(pairs);
  const W = toPx(opts.sheetW);
  const H = toPx(opts.sheetH);
  const c = (gx, gy) => { const p = model(gx, gy); return { x: p[0], y: p[1] }; };
  return { tl: c(0, 0), tr: c(W, 0), br: c(W, H), bl: c(0, H), anchors: pairs.length, hits: hits.length };
}

export function turn(m, n, modules, rot) {
  if (rot === 90) return [modules - 1 - n, m];
  if (rot === 180) return [modules - 1 - m, modules - 1 - n];
  if (rot === 270) return [n, modules - 1 - m];
  return [m, n];
}

/**
 * Which way up is this tile? Answered by the format itself rather than by geometry: sample the tile as if
 * it were rotated by each of the four amounts and keep the one whose CRC16 validates. That is the same
 * criterion readTile() trusts, so the detector cannot disagree with the reader -- and it needs no
 * assumption about which corner a hollow pattern "should" be in.
 */
export function detectTileRotation(img, plan, layout, t, opts = {}) {
  const dpi = opts.dpi === undefined ? img.dpi : opts.dpi;
  const tried = [];
  for (const rot of [0, 90, 180, 270]) {
    try {
      const tile = readTile(img, plan, layout, t, dpi, { dx: 0, dy: 0, rot });
      return { rot, ok: true, length: tile.length, tried };
    } catch (e) {
      tried.push({ rot, why: String(e.message).slice(0, 60) });
    }
  }
  throw new RangeError('tile-read: tile ' + t + ' validates in none of the four orientations -- ' +
    tried.map((x) => x.rot + ': ' + x.why).join(' | '));
}

/** Sample just the 32 header bits at a candidate offset; null when it cannot be sampled. */
function headerAt(img, plan, layout, t, dpi, dx, dy, rot) {
  const px = modulePixels(plan.tileMm, layout.modules, dpi);
  const toPx = (mm) => Math.round((mm * dpi) / 25.4);
  const pos = plan.positions[t];
  const ox = toPx(pos.x) + dx;
  const oy = toPx(pos.y) + dy;

  // Sample the whole tile so the CRC can be checked: a correct alignment is now defined as "the tile's
  // CRC16 validates", which is a far sharper criterion than the four header bytes alone.
  const all = new Uint8Array(layout.dataCells.length);
  for (let i = 0; i < all.length; i++) {
    const c = layout.dataCells[i];
    const x = ox + c.x * px + (px >> 1);
    const y = oy + c.y * px + (px >> 1);
    if (x < 0 || y < 0 || x >= img.width || y >= img.height) return null;
    all[i] = img.pixels[(y * img.width + x) * 4] < 128 ? 1 : 0;
  }
  const out = new Uint8Array(all.length >> 3);
  for (let i = 0; i < out.length * 8; i++) if (all[i]) out[i >> 3] |= 1 << (7 - (i & 7));
  const want = (out[out.length - 2] << 8) | out[out.length - 1];
  const got = crc16(out.subarray(0, out.length - CRC_BYTES));
  if (want !== got) return null;
  return { index: out[0], count: out[1], length: (out[2] << 8) | out[3], crc: true };
}

/** Read one tile's data cells as bytes. Returns the header fields plus this tile's slice. */
export function readTile(img, plan, layout, t, dpi, offset, opts = {}) {
  if (!img || !plan || !layout) throw new RangeError('tile-read: needs an image, a plan and a layout');
  if (!(t >= 0 && t < plan.positions.length)) throw new RangeError('tile-read: tile ' + t + ' is outside 0..' + (plan.positions.length - 1));
  const px = modulePixels(plan.tileMm, layout.modules, dpi === undefined ? img.dpi : dpi);
  const toPx = (mm) => Math.round((mm * (dpi === undefined ? img.dpi : dpi)) / 25.4);
  const pos = plan.positions[t];
  const ox = toPx(pos.x) + (offset ? offset.dx : 0);
  const oy = toPx(pos.y) + (offset ? offset.dy : 0);
  const rot = (offset && offset.rot) || 0;
  const map = (opts && opts.map) || null;
  const bits = new Uint8Array(layout.dataCells.length);
  for (let i = 0; i < bits.length; i++) {
    const cell = layout.dataCells[i];
    const t2 = turn(cell.x, cell.y, layout.modules, rot);
    const c = { x: t2[0], y: t2[1] };
    let x = ox + c.x * px + (px >> 1);
    let y = oy + c.y * px + (px >> 1);
    // Through a homography the coordinates are fractional, and an unrounded index into a typed array is
    // undefined -- which reads as "light" and silently corrupts bits (that is what broke this twice:
    // STATUS rounds 181/183). Round to the nearest pixel here; bilinear sampling is the upgrade path.
    if (map) { const p = map(x, y); x = Math.round(p[0]); y = Math.round(p[1]); }
    if (!(x >= 0 && y >= 0 && x < img.width && y < img.height)) {
      throw new RangeError('tile-read: tile ' + t + ' reaches outside the image (' + x + ',' + y + ')');
    }
    bits[i] = img.pixels[(y * img.width + x) * 4] < 128 ? 1 : 0;
  }
  const bytes = new Uint8Array(bits.length >> 3);
  for (let i = 0; i < bytes.length * 8; i++) if (bits[i]) bytes[i >> 3] |= 1 << (7 - (i & 7));
  const index = bytes[0];
  const count = bytes[1];
  const length = (bytes[2] << 8) | bytes[3];
  if (index !== t) throw new RangeError('tile-read: tile ' + t + ' declares index ' + index + ' -- the page and the geometry disagree');
  if (count !== plan.positions.length) throw new RangeError('tile-read: tile ' + t + ' declares ' + count + ' tiles but the plan has ' + plan.positions.length);
  const per = bytes.length - HEADER_BYTES - CRC_BYTES - RS_PARITY;
  if (length > per * count) throw new RangeError('tile-read: header claims ' + length + ' bytes, which the sheet cannot hold');
  // Reed-Solomon repairs a few misread cells, then the CRC judges the result: correction alone cannot say
  // it failed, detection alone cannot save a tile with one bad cell. Together they turn a misread tile
  // into a named refusal instead of wrong bytes.
  const codeword = bytes.subarray(HEADER_BYTES, bytes.length - CRC_BYTES);
  const dec = rsDecode(codeword, RS_PARITY);
  if (!dec.ok) {
    throw new RangeError('tile-read: tile ' + t + ' could not be corrected (' + (dec.reason || 'unknown') + ', ' + dec.errors + ' error(s))');
  }
  const data = dec.cw.subarray(0, per);
  const check = new Uint8Array(HEADER_BYTES + per);
  check.set(bytes.subarray(0, HEADER_BYTES), 0);
  check.set(data, HEADER_BYTES);
  const want = (bytes[bytes.length - 2] << 8) | bytes[bytes.length - 1];
  const got = crc16(check);
  if (want !== got) {
    throw new RangeError('tile-read: tile ' + t + ' fails its CRC16 after correction (header says ' + want.toString(16) + ', the pixels say ' + got.toString(16) + ') -- the tile is misread, not empty');
  }
  const slice = data.subarray(0, Math.max(0, Math.min(per, length - t * per)));
  return { index, count, length, slice, bytes, bytesPerTile: per, corrected: dec.errors + dec.erasures };
}

/** Read every tile and reassemble the payload. Missing tiles are reported, never guessed. */
/**
 * Read one tile the way a stranger with a phone would: straight, then nudged, then turned. Every attempt
 * is judged by the same CRC the reader trusts, so "it read" means "it validated" and nothing else.
 */
function readTileAuto(img, plan, layout, t, dpi, opts = {}) {
  try {
    return { tile: readTile(img, plan, layout, t, dpi, null, opts), how: 'straight' };
  } catch (e) {
    // With a page homography the tile positions are known analytically, so searching image space would be
    // searching the WRONG space: the search "validates" an alignment in the unmapped frame and can hand
    // back something that only looks right (measured in STATUS round 186: it reports 8/8 finder score and
    // a plausible offset on a page it cannot actually read). So the fallbacks only exist for the no-map case.
    if (opts.map) throw e;
    try {
      const found = findTileOffset(img, plan, layout, t, { dpi });
      return { tile: readTile(img, plan, layout, t, dpi, found, opts), how: found.rot ? 'found+rot' + found.rot : 'found+' + found.dx + ',' + found.dy };
    } catch (e2) {
      const rot = detectTileRotation(img, plan, layout, t, { dpi });
      return { tile: readTile(img, plan, layout, t, dpi, { dx: 0, dy: 0, rot: rot.rot }, opts), how: 'rot' + rot.rot };
    }
  }
}

export function readTilePage(img, plan, layout, dpi, opts = {}) {
  const use = Object.assign({}, opts);
  let mapRefined = false, mapAnchors = 0;
  let mapIdentity = null;
  if (use.map && use.refine !== false) {
    // A quad taken off a tilted photograph is a rough model, and a rough model's local shape biases every
    // tile measurement (round 237). Re-fitting the map from the tiles themselves is what makes the tilt
    // readable, so it is the default whenever a caller has supplied a map. If the refinement cannot find
    // anchors the caller's map is kept: the per-tile CRC below still decides what is readable, and nothing
    // is ever accepted that does not validate.
    const ro = Object.assign({}, use.refineOpts);
    ro.report = (r) => { if (r.anchors >= 8) { mapAnchors = r.anchors; mapRefined = true; }
      if (use.refineOpts && use.refineOpts.report) use.refineOpts.report(r); };
    const refined = refinePageMap(img, plan, layout, dpi, use.map, ro);
    if (refined) use.map = refined;
    else { mapRefined = false; mapAnchors = 0; }
    // Finally, the labelling. A refined map says where the page is; it cannot say WHICH tile is where, and
    // the lattice is periodic so geometry alone never can. The header votes, and the vote moves the model
    // back by whole tiles. Measured on a 5 degree photograph (round 237): without this the page refuses with
    // "tile 0 declares index 2"; with it the same pixels read 48/48 byte for byte.
    if (use.map && use.identify !== false) {
      const id = identifyShift(img, plan, layout, dpi, use.map, use.identifyOpts);
      mapIdentity = id;
      if (id.decided) {
        use.map = shiftMapSource(use.map, plan, dpi, id.shift);
        // Now that the model samples the tiles it names, the fit can use the whole sheet instead of the
        // part of it the shifted-away model still landed on (32 of 48 anchors before, 48 after). The map is
        // already close, so this re-fit searches a small window instead of the +-64 px opening pass.
        const again = refinePageMap(img, plan, layout, dpi, use.map, Object.assign({}, ro, { reach: 16, passes: 2 }));
        if (again) use.map = again;
      }
    }
  }
  const first = readTileAuto(img, plan, layout, 0, dpi, use);
  const per = first.tile.bytesPerTile;
  const out = new Uint8Array(first.tile.length);
  const tiles = [{ index: first.tile.index, bytes: first.tile.bytes.length, how: first.how }];
  const hows = {};
  hows[first.how] = 1;
  out.set(first.tile.slice.subarray(0, Math.min(per, first.tile.length)), 0);
  const missing = [];
  for (let t = 1; t < first.tile.count; t++) {
    let got;
    try {
      got = readTileAuto(img, plan, layout, t, dpi, use);
    } catch (e) {
      missing.push(t);
      continue;
    }
    tiles.push({ index: got.tile.index, bytes: got.tile.bytes.length, how: got.how });
    hows[got.how] = (hows[got.how] || 0) + 1;
    const from = t * per;
    if (from >= first.tile.length) continue;
    out.set(got.tile.slice.subarray(0, Math.min(per, first.tile.length - from)), from);
  }
  // A page with a hole in it is NOT a page: returning a short payload and calling it a success is the
  // "looks successful but is wrong" failure this project refuses to ship. Partial reads happen only when
  // the caller asks for them, and then they are labelled.
  if (missing.length && !opts.allowPartial) {
    throw new RangeError('tile-read: ' + missing.length + ' tile(s) unreadable (' + missing.slice(0, 8).join(', ') +
      (missing.length > 8 ? ', ...' : '') + ') -- refusing rather than returning a payload with holes' +
      ' (pass { allowPartial: true } to get the readable part, labelled)');
  }
  return { payload: out, length: first.tile.length, tiles, missing, bytesPerTile: per, hows, partial: missing.length > 0, mapRefined, mapAnchors, mapIdentity };
}