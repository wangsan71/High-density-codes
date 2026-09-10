#!/usr/bin/env node
/**
 * tools/unpsk.mjs -- turn a .psk image payload back into a viewable PNG.
 *
 * The other half of the image path: send --image-mode lossy produces a .psk payload, receive hands that
 * same payload back byte-for-byte, and this is how you look at it. Zero dependencies, same codec the
 * sender used (core/image/container.js), so what you see is exactly what was transmitted -- not a
 * re-encode.
 *
 *   node tools/unpsk.mjs photo-back.psk out.png
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { unpackImage } from '../core/image/container.js';
import { encodePNG } from '../core/render/png.js';

const USAGE = [
  'unpsk -- read a .psk image payload and write it as a PNG',
  '',
  '  node tools/unpsk.mjs <in.psk> [out.png]',
].join('\n');

function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === '--help' || argv[0] === '-h') {
    console.log(USAGE);
    process.exitCode = argv.length ? 0 : 2;
    return;
  }
  const inPath = resolve(argv[0]);
  const bytes = new Uint8Array(readFileSync(inPath));
  const img = unpackImage(bytes);
  const outPath = resolve(argv[1] || inPath.replace(/\.psk$/i, '') + '-unpsk.png');
  writeFileSync(outPath, encodePNG({ width: img.width, height: img.height, pixels: img.rgba, dpi: 96 }));
  console.log('unpsk: ' + basename(inPath) + ' (' + bytes.length + ' B) -> ' + img.width + 'x' + img.height +
    ' at quality q' + img.quality);
  console.log('  wrote ' + outPath + ' (' + readFileSync(outPath).length + ' B)');
}

try {
  main();
} catch (e) {
  console.error('unpsk: ' + e.message);
  process.exitCode = 2;
}
