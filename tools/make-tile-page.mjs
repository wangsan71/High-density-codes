#!/usr/bin/env node
/**
 * tools/make-tile-page.mjs -- write a tiled page as a PNG (PLAN v5 P4, first product caller).
 *
 * Why this exists: the tiling geometry, bit mapping and renderer were all tested but had no caller, so
 * nothing a user could run produced a tiled page. This is the smallest honest bridge.
 *
 * How the payload is laid out: STRIPED, not repeated. Each tile carries its own two-byte header (tile
 * index, tile count) followed by that tile's slice of the payload. Striping is what makes a tiled page
 * carry a real payload (about 4.9 kB on A4 with 30 mm tiles); repetition would cap it at one tile's worth
 * and waste the rest of the sheet. The value of tiling is that a reader can lock onto ANY tile to rectify
 * the sheet, not that any tile holds the whole file.
 *
 *   node tools/make-tile-page.mjs "hello world" --out .tmp/tile.png
 *   node tools/make-tile-page.mjs --file payload.bin --tile 25 --dpi 600 --out .tmp/tile.png
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { planTiles, tileLayout, tileCapacity, fillTileModules } from '../core/tiles.js';
import { renderTilePage } from '../core/render/tilepage.js';
import { encodePNG } from '../core/render/png.js';
import { SHEETS } from '../core/profiles.js';

const USAGE = [
  'make-tile-page -- draw a tiled page (QR-style: every tile has its own finder patterns)',
  '',
  '  node tools/make-tile-page.mjs <text> [--tile 30] [--dpi 300] [--sheet A4] [--modules 33] [--out out.png]',
  '  node tools/make-tile-page.mjs --file payload.bin [...]',
].join('\n');

// index, tile count, payload length (u16) -- the length is what lets a reader trim the zero padding of
// the last tile instead of guessing where the payload ended.
const HEADER_BYTES = 4;

export function tilePageTiles(payload, plan, layout) {
  const cap = tileCapacity(plan, layout);
  const per = cap.bytesPerTile - HEADER_BYTES;
  if (per < 1) throw new RangeError('make-tile-page: a tile of ' + cap.bytesPerTile + ' B cannot hold a ' + HEADER_BYTES + '-byte header');
  if (payload.length > per * cap.tiles) {
    throw new RangeError('make-tile-page: ' + payload.length + ' B does not fit a tiled sheet of ' + cap.tiles +
      ' tiles x ' + per + ' B = ' + per * cap.tiles + ' B -- split it, use a smaller tile, or a bigger sheet');
  }
  const tiles = [];
  for (let t = 0; t < cap.tiles; t++) {
    const slice = payload.subarray(t * per, Math.min(payload.length, (t + 1) * per));
    const buf = new Uint8Array(HEADER_BYTES + slice.length);
    buf[0] = t & 0xff;
    buf[1] = cap.tiles & 0xff;
    buf[2] = (payload.length >> 8) & 0xff;
    buf[3] = payload.length & 0xff;
    buf.set(slice, HEADER_BYTES);
    tiles.push(fillTileModules(layout.dataCells, buf));
  }
  return { tiles, capacity: cap, bytesPerTile: per, usedBytes: payload.length };
}

function parseArgs(argv) {
  const out = { tile: 30, dpi: 300, sheet: 'A4', modules: 33, text: null, file: null, outPng: null };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--tile') out.tile = Number(argv[++i]);
    else if (a === '--dpi') out.dpi = Number(argv[++i]);
    else if (a === '--sheet') out.sheet = argv[++i];
    else if (a === '--modules') out.modules = Number(argv[++i]);
    else if (a === '--out') out.outPng = argv[++i];
    else if (a === '--file') out.file = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
    else rest.push(a);
  }
  out.text = rest.join(' ');
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || (!args.text && !args.file)) { console.log(USAGE); process.exitCode = args.help ? 0 : 2; return; }
  const sheet = SHEETS[args.sheet];
  if (!sheet) throw new Error('make-tile-page: unknown sheet ' + args.sheet + ' (have ' + Object.keys(SHEETS).join(', ') + ')');
  const payload = args.file ? new Uint8Array(readFileSync(resolve(args.file))) : new TextEncoder().encode(args.text);
  const plan = planTiles({ sheetW: sheet.w, sheetH: sheet.h, tileMm: args.tile, marginMm: 9, gapMm: 2 });
  const layout = tileLayout({ modules: args.modules, finder: 7, quiet: 1 });
  const built = tilePageTiles(payload, plan, layout);
  const img = renderTilePage({ plan, layout, tiles: built.tiles, dpi: args.dpi, sheetW: sheet.w, sheetH: sheet.h });
  const bytes = encodePNG(img);
  const outPath = resolve(args.outPng || 'tile-page.png');
  writeFileSync(outPath, bytes);
  console.log('make-tile-page: ' + payload.length + ' B payload -> ' + built.tiles.length + ' tiles (' +
    built.bytesPerTile + ' B each, ' + built.capacity.bytesPerTile + ' B raw)');
  console.log('  grid      ' + plan.cols + ' x ' + plan.rows + ' of ' + args.tile + ' mm tiles on ' + args.sheet +
    ' (' + sheet.w + 'x' + sheet.h + ' mm), ' + layout.modules + ' modules/tile');
  console.log('  capacity  ' + (built.bytesPerTile * built.capacity.tiles) + ' B per sheet (striped) vs ' +
    built.capacity.bytesPerTile + ' B per tile (repetition would cap the sheet at the latter)');
  console.log('  rendered  ' + img.width + 'x' + img.height + ' px @ ' + args.dpi + ' dpi -> ' + outPath + ' (' + bytes.length + ' B)');
  console.log('  next      print at 100%; a reader that sees ANY one tile can report which slice it is (index + count in its header)');
}

if (import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (e) { console.error('make-tile-page: ' + e.message); process.exitCode = 2; }
}
