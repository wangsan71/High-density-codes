#!/usr/bin/env node
/**
 * tools/fit-image.mjs -- make a picture fit a page budget by downscaling it (LOSSY, on purpose).
 *
 * PLAN v5 P3. The owner asked for "an image under 1 MB in no more than a few pages"; send --pages N
 * refuses when the file cannot fit (measured: a 292 kB PNG needs 3 pages of budget against 65,656 B of
 * compressed payload, and --pages 3 refuses it). This tool is the other half: it produces a SMALLER
 * image that does fit, and says out loud what it gave up.
 *
 * It is deliberately a separate tool rather than a flag on send:
 *   - the fitted PNG is written to a file the user can look at before printing anything;
 *   - nothing about send/receive changes, so a fitted file is an ordinary transfer of an ordinary PNG;
 *   - the lossy step stays visible in the command the user typed, not buried in a flag.
 *
 *   node tools/fit-image.mjs photo.png --pages 3 --profile P-MX-300-5 --sheet A4 --out fitted.png
 *
 * Scope: PNG in, PNG out. core/ has no JPEG decoder by design (browser converts JPEG; Windows CLI uses
 * tools/jpeg-to-png.ps1 first), so a JPEG input is refused by name.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { decodePNG } from '../core/decode/png-read.js';
import { encodePNG } from '../core/render/png.js';
import { compress } from '../core/deflate.js';
import { planPage, PROFILES } from '../core/profiles.js';

/** How many data pages N total pages leave, given the inter-page parity percentage. */
function maxDataPages(want, pct) {
  for (let d = want; d >= 1; d--) {
    const par = Math.max(2, Math.ceil((d * pct) / 100));
    if (d + par <= want) return d;
  }
  return 0;
}

/** Box-filter downscale by an integer factor (a real, honest resize: every source pixel counts once). */
function downscale(img, k) {
  const w = Math.floor(img.width / k);
  const h = Math.floor(img.height / k);
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let dy = 0; dy < k; dy++) {
        for (let dx = 0; dx < k; dx++) {
          const o = ((y * k + dy) * img.width + (x * k + dx)) * 4;
          r += img.pixels[o]; g += img.pixels[o + 1]; b += img.pixels[o + 2]; a += img.pixels[o + 3];
        }
      }
      const n = k * k;
      const q = (y * w + x) * 4;
      out[q] = Math.round(r / n); out[q + 1] = Math.round(g / n); out[q + 2] = Math.round(b / n); out[q + 3] = Math.round(a / n);
    }
  }
  return { width: w, height: h, pixels: out, dpi: img.dpi || 300 };
}

/** Nearest-neighbour upscale back to a target size (what a viewer would show of the fitted image). */
function upscaleNearest(img, w, h) {
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(img.height - 1, Math.floor((y * img.height) / h));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(img.width - 1, Math.floor((x * img.width) / w));
      const o = (sy * img.width + sx) * 4;
      const q = (y * w + x) * 4;
      out[q] = img.pixels[o]; out[q + 1] = img.pixels[o + 1]; out[q + 2] = img.pixels[o + 2]; out[q + 3] = img.pixels[o + 3];
    }
  }
  return { width: w, height: h, pixels: out, dpi: img.dpi };
}

/**
 * PSNR of the round trip a receiver would actually see: fitted image scaled back up to the original
 * size, compared against the original. G-IMG asks for >= 30 dB, so the number has to be printed here,
 * where the pixels are, rather than asserted somewhere else.
 */
function psnrAgainst(original, fitted) {
  const back = upscaleNearest(fitted, original.width, original.height);
  let se = 0;
  const n = original.width * original.height;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) {
      const d = original.pixels[i * 4 + c] - back.pixels[i * 4 + c];
      se += d * d;
    }
  }
  const mse = se / (n * 3);
  return mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse);
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { const v = argv[++i]; if (v === undefined) throw new Error(a + ' needs a value'); return v; };
    if (a === '--pages') out.pages = next();
    else if (a === '--profile') out.profile = next();
    else if (a === '--sheet') out.sheet = next();
    else if (a === '--out') out.out = next();
    else if (a === '--max-factor') out.maxFactor = next();
    else if (a === '--min-scale') out.minScale = next();
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a.startsWith('-')) throw new Error('unknown option ' + a);
    else out._.push(a);
  }
  return out;
}

const USAGE = [
  'fit-image -- downscale a PNG so it fits a page budget (LOSSY)',
  '',
  '  node tools/fit-image.mjs <in.png> --pages N [--profile P-MX-300-5] [--sheet A4] [--out fitted.png]',
  '',
  '  Prints what it gave up (dimensions, bytes, page budget) and writes the fitted PNG.',
  '  It never guesses: if even the largest allowed factor cannot fit, it refuses and says so.',
].join('\n');

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args._.length) { console.log(USAGE); process.exitCode = args.help ? 0 : 2; }
  else {
    const inPath = resolve(args._[0]);
    if (!/\.png$/i.test(inPath)) throw new Error('fit-image: only PNG input is supported (core has no JPEG decoder; see tools/jpeg-to-png.ps1)');
    const profileId = args.profile || 'P-MX-300-5';
    const prof = PROFILES[profileId];
    if (!prof) throw new Error('fit-image: unknown profile ' + profileId);
    if (prof.medium !== 'paper') throw new Error('fit-image: ' + profileId + ' is not a paper profile');
    const pages = Number(args.pages);
    if (!Number.isInteger(pages) || pages < 1 || pages > 255) throw new Error('fit-image: --pages must be 1..255, got ' + args.pages);
    // G-IMG (PLAN-V5 section 4) asks for PSNR >= 30 dB AND a linear resolution of at least a quarter of
    // the original, because a thumbnail passes PSNR on smooth content (measured: 77x109 scored 35.25 dB).
    // The floor is enforced here as a hard cap on the downscale factor; --min-scale 0 lifts it for
    // someone who explicitly accepts a coarser picture.
    const minScale = args.minScale === undefined ? 0.25 : Number(args.minScale);
    if (!(minScale >= 0 && minScale <= 1)) throw new Error('fit-image: --min-scale must be 0..1, got ' + args.minScale);
    const floorFactor = minScale > 0 ? Math.max(1, Math.floor(1 / minScale)) : Infinity;
    const maxFactor = Math.min(args.maxFactor ? Number(args.maxFactor) : 16, floorFactor);
    if (minScale > 0) console.log('  floor     G-IMG: at most 1/' + floorFactor + ' downscale (' + (minScale * 100).toFixed(0) + '% linear resolution) unless --min-scale 0');

    const img = decodePNG(new Uint8Array(readFileSync(inPath)));
    const geom = planPage(profileId, { sheet: args.sheet });
    const dataPages = maxDataPages(pages, prof.parityPct);
    const budget = dataPages * geom.ecc.netBytesPerPage;
    const originalBytes = readFileSync(inPath).length;

    console.log('fit-image: ' + basename(inPath) + '  ' + img.width + 'x' + img.height + '  ' + originalBytes + ' B');
    console.log('  budget    ' + pages + ' page(s) of ' + profileId + ' (' + (args.sheet || 'A4') + ') = ' + dataPages + ' data x ' + geom.ecc.netBytesPerPage + ' B = ' + budget + ' B');

    let chosen = null;
    for (let k = 2; k <= maxFactor; k++) {
      const small = downscale(img, k);
      const bytes = encodePNG(small);
      const zipped = compress(bytes).length;
      console.log('  factor ' + String(k).padStart(2) + ': ' + small.width + 'x' + small.height + '  png ' + bytes.length + ' B  compressed ' + zipped + ' B' + (zipped <= budget ? '  <- fits' : ''));
      if (zipped <= budget && !chosen) { chosen = { k, small, bytes, zipped }; break; }
    }
    if (!chosen) {
      const why = minScale > 0 && maxFactor === floorFactor
        ? 'fitting ' + pages + ' page(s) would need a downscale below the G-IMG floor of 1/' + floorFactor + ' -- raise --pages, use a denser profile (or a smaller sheet), or pass --min-scale 0 to accept a coarser picture on purpose'
        : 'even 1/' + maxFactor + ' does not fit ' + pages + ' page(s) (budget ' + budget + ' B)';
      throw new Error('fit-image: ' + why);
    }
    const outPath = resolve(args.out || join(dirnameOf(inPath), basename(inPath).replace(/\.png$/i, '') + '-fit' + chosen.k + '.png'));
    writeFileSync(outPath, chosen.bytes);
    const psnr = psnrAgainst(img, chosen.small);
    console.log('  LOSSY: 1/' + chosen.k + ' downscale, ' + img.width + 'x' + img.height + ' -> ' + chosen.small.width + 'x' + chosen.small.height);
    console.log('  quality   PSNR ' + (psnr === Infinity ? 'inf' : psnr.toFixed(2)) + ' dB after scaling back to ' + img.width + 'x' + img.height + (psnr >= 30 ? '  (G-IMG criterion >= 30 dB: met)' : '  (G-IMG criterion >= 30 dB: NOT met -- raise --pages or accept a coarser picture)'));
    console.log('  wrote     ' + outPath + ' (' + chosen.bytes.length + ' B, compressed ' + chosen.zipped + ' B)');
    console.log('  next      node cli/pskit.mjs send "' + outPath + '" --profile ' + profileId + (args.sheet ? ' --sheet ' + args.sheet : '') + ' --pages ' + pages + ' --format png,pdf --out <dir>');
  }
} catch (e) {
  console.error('fit-image: ' + e.message);
  process.exitCode = 2;
}

function dirnameOf(p) {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i > 0 ? p.slice(0, i) : '.';
}
