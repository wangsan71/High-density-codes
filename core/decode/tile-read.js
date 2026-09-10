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

const HEADER_BYTES = 4;

/** Read one tile's data cells as bytes. Returns the header fields plus this tile's slice. */
export function readTile(img, plan, layout, t, dpi) {
  if (!img || !plan || !layout) throw new RangeError('tile-read: needs an image, a plan and a layout');
  if (!(t >= 0 && t < plan.positions.length)) throw new RangeError('tile-read: tile ' + t + ' is outside 0..' + (plan.positions.length - 1));
  const px = modulePixels(plan.tileMm, layout.modules, dpi === undefined ? img.dpi : dpi);
  const toPx = (mm) => Math.round((mm * (dpi === undefined ? img.dpi : dpi)) / 25.4);
  const pos = plan.positions[t];
  const ox = toPx(pos.x);
  const oy = toPx(pos.y);
  const bits = new Uint8Array(layout.dataCells.length);
  for (let i = 0; i < bits.length; i++) {
    const c = layout.dataCells[i];
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
  if (length > bytes.length * (count ? 1 : 1) * count) throw new RangeError('tile-read: header claims ' + length + ' bytes, which the sheet cannot hold');
  const slice = bytes.subarray(HEADER_BYTES, HEADER_BYTES + Math.min(bytes.length - HEADER_BYTES, Math.max(0, length - t * (bytes.length - HEADER_BYTES))));
  return { index, count, length, slice, bytes };
}

/** Read every tile and reassemble the payload. Missing tiles are reported, never guessed. */
export function readTilePage(img, plan, layout, dpi) {
  const first = readTile(img, plan, layout, 0, dpi);
  const per = first.bytes.length - HEADER_BYTES;
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
