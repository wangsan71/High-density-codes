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
import { renderTilePage, modulePixels } from '../core/render/tilepage.js';
import { findPageQuadFromTiles, pageMapper, readTilePage } from '../core/decode/tile-read.js';
import { encodePNG } from '../core/render/png.js';
import { decodePNG } from '../core/decode/png-read.js';
import { SHEETS } from '../core/profiles.js';
import { crc16 } from '../core/crc.js';
import { rsEncode } from '../core/rs.js';

const USAGE = [
  'make-tile-page -- draw a tiled page (QR-style: every tile has its own finder patterns)',
  '',
  '  node tools/make-tile-page.mjs <text> [--tile 30] [--dpi 300] [--sheet A4] [--modules 33] [--out out.png]',
  '  node tools/make-tile-page.mjs --file payload.bin [...]',
  '  node tools/make-tile-page.mjs --read page.png --out payload.bin          (a pristine PNG of the page)',
  '  node tools/make-tile-page.mjs --read photo.png --photo --out payload.bin (a PHOTOGRAPH: the page finds itself)',
].join('\n');

// index, tile count, payload length (u16) -- the length is what lets a reader trim the zero padding of
// the last tile instead of guessing where the payload ended. The last two bytes are a CRC16 over
// everything before them: error DETECTION before error correction, because returning wrong bytes is the
// one failure this project does not accept, and a 16-bit check turns a misread tile into a named refusal
// (it is also what makes the locator able to tell a good alignment from a plausible one).
const HEADER_BYTES = 4;
export const CRC_BYTES = 2;
// Per-tile Reed-Solomon. rsEncode()/rsDecode() are the low-level pair the whole-page protocol uses
// (core/protocol.js:224/245); the *Blocks() wrappers return objects, which is what broke an earlier
// attempt at exactly this. k + RS_PARITY fills the tile's data cells: 82 + 16 + 4 header + 2 CRC = 104.
export const RS_PARITY = 16;

export function tilePageTiles(payload, plan, layout) {
  const cap = tileCapacity(plan, layout);
  const per = cap.bytesPerTile - HEADER_BYTES - CRC_BYTES - RS_PARITY;
  if (per < 1) throw new RangeError('make-tile-page: a tile of ' + cap.bytesPerTile + ' B cannot hold a ' + HEADER_BYTES + '-byte header');
  if (payload.length > per * cap.tiles) {
    throw new RangeError('make-tile-page: ' + payload.length + ' B does not fit a tiled sheet of ' + cap.tiles +
      ' tiles x ' + per + ' B = ' + per * cap.tiles + ' B -- split it, use a smaller tile, or a bigger sheet');
  }
  const tiles = [];
  for (let t = 0; t < cap.tiles; t++) {
    const slice = payload.subarray(t * per, Math.min(payload.length, (t + 1) * per));
    const buf = new Uint8Array(cap.bytesPerTile);
    buf[0] = t & 0xff;
    buf[1] = cap.tiles & 0xff;
    buf[2] = (payload.length >> 8) & 0xff;
    buf[3] = payload.length & 0xff;
    const block = new Uint8Array(per);
    block.set(slice, 0);
    buf.set(rsEncode(block, RS_PARITY), HEADER_BYTES);
    // The CRC covers the header and the DATA (not the RS parity): it judges what correction produced,
    // which is the only thing the reader actually trusts.
    const check = new Uint8Array(HEADER_BYTES + per);
    check.set(buf.subarray(0, HEADER_BYTES), 0);
    check.set(block, HEADER_BYTES);
    const sum = crc16(check);
    buf[buf.length - 2] = (sum >> 8) & 0xff;
    buf[buf.length - 1] = sum & 0xff;
    tiles.push(fillTileModules(layout.dataCells, buf));
  }
  return { tiles, capacity: cap, bytesPerTile: per, usedBytes: payload.length };
}

/**
 * Read a tiled page back from PNG bytes. Exported so it can be tested without a file system: the CLI mode
 * below is a thin wrapper around exactly this call.
 */
/**
 * How many image pixels does one millimetre span? A photograph does not say, and the tile locator needs to
 * know before it can look for finder patterns at all. The printed tiles are the darkest thing in a photograph
 * of a page, so the bounding box of the ink IS the code area, and the model knows how wide that is in mm.
 *
 * Measured (STATUS round 240): the locator tolerates a few percent of scale error and nothing more -- on a
 * faithful fixture (page rendered at the photograph's own scale) the correct scale read 24/24 tiles with zero
 * holes, while 5% out refused. So this estimate is only the centre of a short ladder, never the answer on
 * its own, and a dark background around the page breaks the assumption -- which the refusal says out loud.
 */
function estimateDpiFromInk(img, plan) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, ink = 0;
  for (let y = 0; y < img.height; y += 2) {
    for (let x = 0; x < img.width; x += 2) {
      if (img.pixels[(y * img.width + x) * 4] < 128) {
        ink++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (ink < 1000 || !(maxX > minX) || !(maxY > minY)) return null;
  // The quiet ring around each tile is paper, so the ink is inset from the modelled span by about one module
  // on each outer edge; the geometric mean of the two axes keeps a bbox clipped on one side from deciding.
  const inset = (plan.tileMm / 33) * 2;
  const byX = ((maxX - minX + 1) / (plan.widthMm - inset)) * 25.4;
  const byY = ((maxY - minY + 1) / (plan.heightMm - inset)) * 25.4;
  return Math.sqrt(byX * byY);
}
/**
 * Read a tiled page from a PHOTOGRAPH. The sheet is not the frame here, so the page has to find itself.
 *
 * What a photograph does not say is how far away the camera was. estimateDpiFromInk() measures the scale from
 * the ink's bounding box; the locator is then run at that scale and at a few percent either side, because the
 * tolerance is only a few percent (round 240) and the estimate carries a couple of percent of its own. Only
 * the LOCATOR depends on the guess: once it has the sheet's four corners, one homography maps the whole page,
 * and the reader re-fits that map from the tiles themselves (STATUS round 237).
 */
export function readTilePhotoFromPng(pngBytes, opts = {}) {
  const img = decodePNG(pngBytes instanceof Uint8Array ? pngBytes : new Uint8Array(pngBytes));
  const sheetName = opts.sheet === undefined ? 'A4' : opts.sheet;
  const sheet = SHEETS[sheetName];
  if (!sheet) throw new RangeError('make-tile-page: unknown sheet ' + sheetName + ' (have ' + Object.keys(SHEETS).join(', ') + ')');
  const tileMm = opts.tile === undefined ? 30 : opts.tile;
  const modules = opts.modules === undefined ? 33 : opts.modules;
  const plan = planTiles({ sheetW: sheet.w, sheetH: sheet.h, tileMm, marginMm: 9, gapMm: 2 });
  const layout = tileLayout({ modules, finder: 7, quiet: 1 });
  const estimate = opts.dpi ? Number(opts.dpi) : estimateDpiFromInk(img, plan);
  if (!estimate) {
    throw new RangeError(
      'make-tile-page --photo: could not measure the page in this image -- almost nothing in it is dark, so ' +
      'either the page is not in the frame or the photograph is unusable (a blank or over-exposed frame)',
    );
  }
  // A few percent either side of the estimate, best guess first: the locator's own tolerance, measured.
  const offsets = opts.offsets || [0, -0.03, 0.03, -0.06, 0.06, -0.09, 0.09];
  const tried = [];
  for (const offset of offsets) {
    const fraction = 1 + offset;
    const dpi = Math.round(estimate * fraction);
    // Below roughly three pixels per module there is nothing to look for, and searching anyway would only
    // turn a 'get closer' into a pile of misleading reasons.
    if (modulePixels(tileMm, modules, dpi) < 3) {
      tried.push({ fraction, dpi, why: 'fewer than 3 px per module at this scale -- the page is too small in the frame' });
      continue;
    }
    try {
      const quad = findPageQuadFromTiles(img, plan, layout, { dpi, sheetW: sheet.w, sheetH: sheet.h });
      const map = pageMapper([quad.tl, quad.tr, quad.br, quad.bl], (sheet.w * dpi) / 25.4, (sheet.h * dpi) / 25.4);
      const back = readTilePage(img, plan, layout, dpi, { map });
      return { ...back, img, plan, layout, quad, dpi, fraction, tried };
    } catch (e) {
      tried.push({ fraction, dpi, why: String(e.message).slice(0, 110) });
    }
  }
  throw new RangeError(
    'make-tile-page --photo: could not find the sheet at any of the ' + offsets.length + ' scales tried ' +
      '(' + Math.round(estimate) + ' dpi was estimated from the bounding box of the ink, then +/-3/6/9%). ' +
      'The locator said: ' + tried.slice(0, 3).map((t) => Math.round(t.dpi) + ' dpi -> ' + t.why).join(' | ') +
      ' -- photograph the page straight on, keep all four edges inside the frame, and put it on a LIGHT ' +
      'background (this measures the page from the ink bounding box, and a dark background around the page ' +
      'makes that measurement meaningless)',
  );
}

export function readTilePageFromPng(pngBytes, opts = {}) {
  const img = decodePNG(pngBytes instanceof Uint8Array ? pngBytes : new Uint8Array(pngBytes));
  const tileMm = opts.tile === undefined ? 30 : opts.tile;
  const modules = opts.modules === undefined ? 33 : opts.modules;
  // The sheet size is derived from the raster and its dpi rather than from a profile table: the file knows
  // how big it is, and a page that was printed at 100% keeps those numbers.
  const plan = planTiles({
    sheetW: (img.width * 25.4) / img.dpi,
    sheetH: (img.height * 25.4) / img.dpi,
    tileMm, marginMm: 9, gapMm: 2,
  });
  const layout = tileLayout({ modules, finder: 7, quiet: 1 });
  const back = readTilePage(img, plan, layout, img.dpi);
  return { ...back, img, plan, layout };
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
    else if (a === '--read') { out.mode = 'read'; out.readFrom = argv[++i]; }
    else if (a === '--photo') out.photo = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else rest.push(a);
  }
  out.text = rest.join(' ');
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || (args.mode !== 'read' && !args.text && !args.file)) { console.log(USAGE); process.exitCode = args.help ? 0 : 2; return; }
  if (args.mode === 'read') {
    // Read a page back from a PNG. The pixels are whatever the file holds -- a print-and-scan round trip
    // is the same code path with scanned pixels in place of rendered ones, once a photo locator exists.
    const bytes = new Uint8Array(readFileSync(resolve(args.readFrom)));
    if (args.photo) {
      // A photograph: the sheet is somewhere inside the frame, at a scale nobody wrote down. The page's own
      // tiles are the fiducials, so this needs no markers, no echo bar and no manifest -- it is the format's
      // whole point, and until now nothing a user could run reached it (STATUS round 240).
      const photo = readTilePhotoFromPng(bytes, { tile: args.tile, modules: args.modules, sheet: args.sheet });
      const outPath = resolve(args.outPng || 'tile-payload.bin');
      writeFileSync(outPath, photo.payload);
      console.log('make-tile-page --read --photo: ' + photo.img.width + 'x' + photo.img.height + ' px photograph -> ' +
        photo.plan.cols + ' x ' + photo.plan.rows + ' tiles on ' + args.sheet);
      console.log('  located   read at ' + photo.dpi + ' dpi (the ink bounding box said ~' + Math.round(photo.dpi / photo.fraction) +
        ' dpi, this candidate is ' + (photo.fraction >= 1 ? '+' : '') + Math.round((photo.fraction - 1) * 100) + '% of it); ' +
        photo.tried.length + ' scale(s) were tried before it');
      console.log('  map       re-fitted from the tiles: refined=' + photo.mapRefined + ', ' + photo.mapAnchors + '/' +
        photo.plan.positions.length + ' anchors, header vote ' + JSON.stringify(photo.mapIdentity));
      console.log('  payload   ' + photo.length + ' B (' + photo.bytesPerTile + ' B/tile, ' + photo.tiles.length +
        ' tiles read, missing ' + photo.missing.length + ')');
      console.log('  wrote     ' + outPath);
      return;
    }
    const back = readTilePageFromPng(bytes, { tile: args.tile, modules: args.modules });
    const { img, plan } = back;
    const outPath = resolve(args.outPng || 'tile-payload.bin');
    writeFileSync(outPath, back.payload);
    console.log('make-tile-page --read: ' + img.width + 'x' + img.height + ' px @ ' + img.dpi + ' dpi -> ' +
      plan.cols + ' x ' + plan.rows + ' tiles');
    console.log('  payload   ' + back.length + ' B (' + back.bytesPerTile + ' B/tile, ' + back.tiles.length + ' tiles read, missing ' + back.missing.length + ')');
    console.log('  wrote     ' + outPath);
    return;
  }
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
