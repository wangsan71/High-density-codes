#!/usr/bin/env node
/**
 * Measure what the web sender costs in memory for a payload of a given size. Read-only, not a gate.
 *
 * Why this exists. docs/USE.md tells a user the paper profile carries up to 255 pages (about
 * 1.9 MB), and PLAN's own G6 criterion treats "encode 1 MB" as an ordinary case -- but
 * web/sender.js kept every page's RGBA raster alive and handed all of them to encodePDFDocument at
 * once. At A4/300 dpi one page's raster is roughly 30 MB, so the peak scaled with the transfer:
 * ~0.3 GB for a 200 KiB file, gigabytes for anything a user would actually want to send. A browser
 * tab dies long before that, and a phone dies sooner. The RGBA bytes live in arrayBuffers, outside
 * the JS heap, which is exactly why "heapUsed looks fine" is not evidence either way -- so this
 * prints both.
 *
 * Run the same command before and after a change: that turns a claim about memory into a
 * measurement, and the sha256 of pack.pdf and of page 0's PNG in the output say whether the
 * artifacts themselves moved.
 *
 * usage: node tools/sender-memory-probe.mjs [--bytes N] [--profile P-M1-300]
 *        node --max-old-space-size=2048 tools/sender-memory-probe.mjs --bytes 262144
 * (the --max-old-space-size form models a tab's budget; note it caps the JS heap, and typed arrays
 * are external, so a sender that over-allocates rasters shows up in rss/arrayBuffers rather than as
 * a clean heap OOM -- read the numbers, do not rely on the process dying to make the point.)
 */
import { buildArtifacts } from '../web/sender.js';
import { sha256Hex } from '../core/hash.js';

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
};
const bytesN = Number(opt('--bytes', 262144));
const profile = String(opt('--profile', 'P-M1-300'));

// Deterministic payload: same bytes every run, so artifacts and hashes are comparable across runs.
const payload = new Uint8Array(bytesN);
let x = 0x5eed1234 >>> 0;
for (let i = 0; i < bytesN; i++) {
  x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
  payload[i] = x & 255;
}

const mb = (v) => (v / 1048576).toFixed(1);
const before = process.memoryUsage();
const t0 = Date.now();
const r = await buildArtifacts(payload, { profile });
const ms = Date.now() - t0;
if (!r || !r.ok) {
  console.log(`FAIL at stage ${r && r.stage}: ${r && r.error}`);
  process.exit(1);
}
const mu = process.memoryUsage();
const pngTotal = r.pages.reduce((s, p) => s + (p.png ? p.png.length : 0), 0);
const bmpAlive = r.pages.filter((p) => p.bitmap).length;
console.log(`${profile}: ${r.bytesIn} B in -> ${r.pages.length} page(s) in ${ms} ms (parity pages ${r.parityPages})`);
console.log(`  pack.pdf ${r.pdf.length} B  sha256 ${sha256Hex(r.pdf).slice(0, 16)}`);
console.log(`  page PNGs ${(pngTotal / 1048576).toFixed(2)} MB total; page-000 png sha256 ${sha256Hex(r.pages[0].png).slice(0, 16)}`);
console.log(`  rasters still referenced by the returned result: ${bmpAlive} of ${r.pages.length}`);
console.log(`  rss ${mb(mu.rss)} MB (was ${mb(before.rss)})  arrayBuffers ${mb(mu.arrayBuffers)} MB (was ${mb(before.arrayBuffers)})`);
console.log(`  heapUsed ${mb(mu.heapUsed)} MB  heapTotal ${mb(mu.heapTotal)} MB  external ${mb(mu.external)} MB`);
console.log(`  => per page: rss ${(((mu.rss - before.rss) / r.pages.length) / 1048576).toFixed(1)} MB, arrayBuffers ${(((mu.arrayBuffers - before.arrayBuffers) / r.pages.length) / 1048576).toFixed(1)} MB`);
