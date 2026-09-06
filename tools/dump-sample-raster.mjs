/**
 * PSKT tools -- dump deterministic sample rasters as PNG / TIFF plus a `.raw`
 * sidecar, so an *independent* decoder (pillow: ref/verify_raster.py) can be
 * pointed at exactly the bytes our encoders produced.
 *
 * Sidecar layout (little-endian), one per image, same basename + `.raw`:
 *
 *   offset size  field
 *   ------ ----  ---------------------------------------------------------
 *    0      8    magic  'PSKTRAW1'
 *    8      4    width   uint32LE
 *   12      4    height  uint32LE
 *   16      4    dpi     uint32LE (Math.round(dpi))
 *   20      n    RGB bytes, width*height*3, row-major, top row first
 *
 * The sidecar holds what the encoder *should* have written after dropping
 * alpha -- it is the reference, not a re-read of the image file.
 *
 * CLI:  node tools/dump-sample-raster.mjs [outDir]
 */

import { encodePNG } from '../core/render/png.js';
import { encodeTIFF } from '../core/render/tiff.js';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const SIDECAR_MAGIC = 'PSKTRAW1';
export const SIDECAR_HEADER_SIZE = 20;

/** Pixels per mm at 600 dpi -- same rounding rule as core/render/units.js. */
export function mmToPx(mm, dpi) {
  return Math.round((mm * dpi) / 25.4);
}

/**
 * Deterministic RGBA raster generator (no rendering module involved): `kind`
 * picks a pattern, `rng` is a fixed-seed xorshift for the 'noise' pattern.
 */
export function sampleRaster(width, height, dpi, kind) {
  let s = 0x9e3779b9;
  const rnd = () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s >>> 0;
  };
  s = (width * 7919 + height * 104729 + kind.length) >>> 0 || 1;

  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      let r = 255, g = 255, b = 255, a = 255;
      switch (kind) {
        case 'solid':
          r = 17; g = 145; b = 60;
          break;
        case 'stripes-h': {
          const v = (y >> 2) & 1 ? 0 : 255;
          r = g = b = v;
          break;
        }
        case 'stripes-v': {
          const v = (x >> 2) & 1 ? 0 : 255;
          r = g = b = v;
          break;
        }
        case 'checker': {
          const v = (((x >> 3) + (y >> 3)) & 1) ? 0 : 255;
          r = g = b = v;
          break;
        }
        case 'channels': // every channel a different ramp: catches swapped RGB
          r = x & 255; g = y & 255; b = (x ^ y) & 255;
          break;
        case 'noise': {
          const n = rnd();
          r = n & 255; g = (n >>> 8) & 255; b = (n >>> 16) & 255;
          break;
        }
        case 'alpha': // opaque RGB over a varying alpha: alpha must be ignored
          r = g = b = (x + y) & 255; a = (x * 3 + y * 5) & 255;
          break;
        default:
          throw new Error(`sampleRaster: unknown kind '${kind}'`);
      }
      pixels[i] = r; pixels[i + 1] = g; pixels[i + 2] = b; pixels[i + 3] = a;
    }
  }
  return { width, height, pixels, dpi };
}

/** The RGB bytes a conforming encoder must have written for `img`. */
export function expectedRGB(img) {
  const { width, height, pixels } = img;
  const out = new Uint8Array(width * height * 3);
  let s = 0, d = 0;
  while (s < pixels.length) {
    out[d++] = pixels[s];
    out[d++] = pixels[s + 1];
    out[d++] = pixels[s + 2];
    s += 4;
  }
  return out;
}

/** `PSKTRAW1` sidecar bytes for `img` (reference RGB + geometry + dpi). */
export function sidecarBytes(img) {
  const { width, height, dpi } = img;
  const rgb = expectedRGB(img);
  const out = new Uint8Array(SIDECAR_HEADER_SIZE + rgb.length);
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  for (let i = 0; i < SIDECAR_MAGIC.length; i++) out[i] = SIDECAR_MAGIC.charCodeAt(i);
  dv.setUint32(8, width, true);
  dv.setUint32(12, height, true);
  dv.setUint32(16, Math.round(dpi), true);
  out.set(rgb, SIDECAR_HEADER_SIZE);
  return out;
}

/** The curated sample set: patterns, odd sizes, and a real A4 page at 600 dpi. */
export function sampleSet({ includePage = true } = {}) {
  const small = [
    ['dot', 1, 1, 600, 'solid'],
    ['odd', 7, 5, 300, 'stripes-v'],
    ['check16', 16, 16, 300, 'checker'],
    ['rgb-ramp', 64, 32, 600, 'channels'],
    ['alpha', 33, 17, 300, 'alpha'],
    ['noisy', 120, 90, 600, 'noise'],
  ].map(([name, w, h, dpi, kind]) => ({ name, img: sampleRaster(w, h, dpi, kind) }));
  if (!includePage) return small;
  const W = mmToPx(210, 600); // A4 short edge  -> 4961 px
  const H = mmToPx(297, 600); // A4 long edge   -> 7016 px
  // 4961 x 7016 lattice-scale page: the P-M1/P-M2 600 dpi grid is 453 x 659
  // cells at pitch ~4 px, i.e. a page of exactly this pixel order.
  small.push({ name: 'page-a4-600', img: sampleRaster(W, H, 600, 'checker') });
  return small;
}

/**
 * Write every sample as `<dir>/<name>.png`, `<name>.tif` and `<name>.raw`.
 * @returns {{name:string,png:string,tif:string,raw:string,pngBytes:number,tifBytes:number}[]}
 */
export function dumpSampleRaster(dir, { includePage = true } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const written = [];
  for (const { name, img } of sampleSet({ includePage })) {
    const png = encodePNG(img);
    const tif = encodeTIFF(img);
    const raw = sidecarBytes(img);
    const pngPath = path.join(dir, `${name}.png`);
    const tifPath = path.join(dir, `${name}.tif`);
    const rawPath = path.join(dir, `${name}.raw`);
    fs.writeFileSync(pngPath, png);
    fs.writeFileSync(tifPath, tif);
    fs.writeFileSync(rawPath, raw);
    written.push({
      name,
      png: pngPath,
      tif: tifPath,
      raw: rawPath,
      width: img.width,
      height: img.height,
      dpi: img.dpi,
      pngBytes: png.length,
      tifBytes: tif.length,
    });
  }
  return written;
}

/* Run directly: `node tools/dump-sample-raster.mjs out/samples` */
function main() {
  const dir = process.argv[2] || path.join('out', 'samples');
  const abs = path.resolve(dir);
  const t0 = performance.now();
  const rows = dumpSampleRaster(abs);
  console.log(`wrote ${rows.length} samples (png+tif+raw) to ${abs} in ${(performance.now() - t0).toFixed(0)} ms`);
  for (const r of rows) {
    console.log(
      `  ${r.name.padEnd(14)} ${String(r.width).padStart(5)}x${String(r.height).padStart(5)} @${r.dpi}dpi` +
        `  png=${(r.pngBytes / 1024).toFixed(1)}KiB  tif=${(r.tifBytes / 1048576).toFixed(1)}MiB`,
    );
  }
  console.log('\nmanual acceptance (pillow, independent decoder):');
  for (const r of rows) console.log(`  python ref/verify_raster.py "${r.png}" "${r.tif}"`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main();

export default dumpSampleRaster;
