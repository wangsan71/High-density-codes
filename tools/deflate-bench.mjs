#!/usr/bin/env node
/**
 * Compression bench: what our self-written DEFLATE encoder costs against a real one.
 *
 *   node tools/deflate-bench.mjs
 *   node tools/deflate-bench.mjs --encoder .tmp/old-deflate.mjs   (compare against another encoder)
 *
 * Why it exists: docs/STATUS.md round 300 replaced the fixed-Huffman-only encoder with
 * dynamic Huffman + lazy matching. Sizes move whenever the encoder moves, so the claim
 * "we are within N% of zlib -9" needs a command anyone can re-run, not a one-off probe.
 * This tool is the permanent equivalent of that probe. It is NOT a gate and NOT a verdict:
 * the compression gate lives in tests/unit/deflate.test.mjs (ratio ceilings + stored fallback).
 *
 * Every stream is verified twice before its size is reported -- our own inflateRaw and
 * node:zlib's -- because a size on a stream that does not decode would be a false number.
 * Exit 0 = every case round-tripped under both decoders; 1 = something did not.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as current from '../core/deflate.js';
import zlib from 'node:zlib';

// --encoder lets the same corpus be measured against a different (for example the previous,
// fetched with `git show HEAD:core/deflate.js > .tmp/old-deflate.mjs`) implementation.
const at = process.argv.indexOf('--encoder');
const encoderPath = at >= 0 ? process.argv[at + 1] : null;
const enc = encoderPath ? await import(pathToFileURL(resolve(encoderPath)).href) : current;
const { deflateRaw, inflateRaw, compress, decompress, HEADER_SIZE } = enc;
console.log('encoder: ' + (encoderPath || 'core/deflate.js (working tree)'));

const CASES = [
  ['core/deflate.js           source', () => readFileSync(new URL('../core/deflate.js', import.meta.url))],
  ['cli/pskit.mjs             source', () => readFileSync(new URL('../cli/pskit.mjs', import.meta.url))],
  ['docs/USE.md               prose ', () => readFileSync(new URL('../docs/USE.md', import.meta.url))],
  ['docs/STATUS.md            prose ', () => readFileSync(new URL('../docs/STATUS.md', import.meta.url))],
  ['tests/conformance.json   JSON  ', () => readFileSync(new URL('../tests/conformance.json', import.meta.url))],
  ['synthetic word soup       repeat', () => Buffer.from(words(), 'utf8')],
  ['synthetic periodic prose  repeat', () => Buffer.from('The quick brown fox jumps over the lazy dog. '.repeat(20000), 'utf8')],
  ['synthetic lcg bytes       noise ', () => Buffer.from(noise(262144))],
];

// Deterministic generators: no dependence on the host PRNG, so two runs are comparable.
function words() {
  let out = '';
  for (let i = 0; i < 180000; i++) out += 'word' + (i % 997) + ' ';
  return out;
}
function noise(n) {
  const out = new Uint8Array(n);
  let s = 0x1234abcd;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    out[i] = (s >>> 16) & 255;
  }
  return out;
}

const pad = (s, n) => String(s).padStart(n);
let ours = 0;
let z9 = 0;
let raw = 0;
let failures = 0;
console.log('case'.padEnd(34) + pad('raw', 10) + pad('ours', 10) + pad('zlib -9', 10) + pad('ours/zlib', 11) + '   round-trip');
for (const [label, make] of CASES) {
  const buf = make();
  const src = new Uint8Array(buf);
  const enc = deflateRaw(src);
  const reference = zlib.deflateRawSync(buf, { level: 9 }).length;
  let verdict = 'ours+zlib ok';
  try {
    const back = inflateRaw(enc, src.length);
    if (back.length !== src.length || !back.every((v, i) => v === src[i])) { verdict = 'OUR DECODER MISMATCH'; failures++; }
  } catch (e) { verdict = 'our decoder threw: ' + e.message; failures++; }
  try {
    const viaZlib = new Uint8Array(zlib.inflateRawSync(Buffer.from(enc)));
    if (viaZlib.length !== src.length || !viaZlib.every((v, i) => v === src[i])) { verdict = 'ZLIB MISMATCH'; failures++; }
  } catch (e) { verdict = 'zlib threw: ' + e.message; failures++; }
  // the container is what actually gets printed: check it too, not just the raw stream
  try {
    const back = decompress(compress(src));
    if (back.length !== src.length || !back.every((v, i) => v === src[i])) { verdict = 'CONTAINER MISMATCH'; failures++; }
  } catch (e) { verdict = 'container threw: ' + e.message; failures++; }
  ours += enc.length;
  z9 += reference;
  raw += src.length;
  console.log(label.padEnd(34) + pad(src.length, 10) + pad(enc.length, 10) + pad(reference, 10) + pad((enc.length / reference).toFixed(3), 11) + '   ' + verdict);
}
console.log('-'.repeat(90));
const delta = ours - z9;
console.log('TOTAL'.padEnd(34) + pad(raw, 10) + pad(ours, 10) + pad(z9, 10) + pad((ours / z9).toFixed(3), 11));
console.log('ours vs zlib -9: ' + (delta >= 0 ? '+' : '') + delta + ' bytes (' + ((ours / z9 - 1) * 100).toFixed(1) + '%), container header overhead excluded');
console.log('container header is ' + HEADER_SIZE + ' bytes/payload; page net capacity for P-M1-300 is 7514 B/page');
if (failures) {
  console.log('FAIL: ' + failures + ' case(s) did not round-trip -- the sizes above are not usable.');
  process.exit(1);
}
console.log('OK: every case round-tripped through our decoder, zlib, and the PSZ1 container.');
