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
export function readTile(img, plan, layout, t, dpi, offset) {
  if (!img || !plan || !layout) throw new RangeError('tile-read: needs an image, a plan and a layout');
  if (!(t >= 0 && t < plan.positions.length)) throw new RangeError('tile-read: tile ' + t + ' is outside 0..' + (plan.positions.length - 1));
  const px = modulePixels(plan.tileMm, layout.modules, dpi === undefined ? img.dpi : dpi);
  const toPx = (mm) => Math.round((mm * (dpi === undefined ? img.dpi : dpi)) / 25.4);
  const pos = plan.positions[t];
  const ox = toPx(pos.x) + (offset ? offset.dx : 0);
  const oy = toPx(pos.y) + (offset ? offset.dy : 0);
  const rot = (offset && offset.rot) || 0;
  const bits = new Uint8Array(layout.dataCells.length);
  for (let i = 0; i < bits.length; i++) {
    const cell = layout.dataCells[i];
    const t2 = turn(cell.x, cell.y, layout.modules, rot);
    const c = { x: t2[0], y: t2[1] };
    const x = ox + c.x * px + (px >> 1);
    const y = oy + c.y * px + (px >> 1);
    if (x >= img.width || y >= img.height) throw new RangeError('tile-read: tile ' + t + ' reaches outside the image (' + x + ',' + y + ')');
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
export function readTilePage(img, plan, layout, dpi) {
  const first = readTile(img, plan, layout, 0, dpi);
  const per = first.bytesPerTile;
  const out = new Uint8Array(first.length);
  const seen = new Uint8Array(first.count);
  const tiles = [];
  for (let t = 0; t < first.count; t++) {
    const r = readTile(img, plan, layout, t, dpi);
    tiles.push({ index: r.index, bytes: r.bytes.length });
    seen[t] = 1;
    const from = t * per;
    if (from >= first.length) continue;
    out.set(r.slice.subarray(0, Math.min(per, first.length - from)), from);
  }
  const missing = [];
  for (let t = 0; t < seen.length; t++) if (!seen[t]) missing.push(t);
  return { payload: out, length: first.length, tiles, missing, bytesPerTile: per };
}