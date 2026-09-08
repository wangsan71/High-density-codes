#!/usr/bin/env node
/**
 * Prove that the sender's "PNG（zip）" button produces an archive an independent implementation can
 * read, with every page's bytes intact. Read-only, not a gate.
 *
 * Why this exists separately from tools/smoke-sender.mjs: the click handler lives behind a
 * `typeof document !== 'undefined'` guard in web/sender.js, so nothing in process can click it. This
 * script runs the IDENTICAL expression on the IDENTICAL artifacts from buildArtifacts and writes the
 * archive to disk, where a third-party reader can be pointed at it -- the same discipline G8 uses for
 * 3MF/STL ("our writer says it is fine" is not evidence; "someone else's reader agrees" is).
 *
 * What it replaced, and why (DEFECTS D58): the button used to fire one automatic download per page,
 * and browsers block multiple automatic downloads after the first couple, so a 168-page transfer
 * could land two PNGs while the log claimed all N had been downloaded. One zip, one download.
 *
 * usage: node tools/sender-zip-check.mjs [--bytes N] [--profile P-M1-300]
 * then, independently (Python's zipfile is not our code):
 *   python -c "import zipfile,hashlib; z=zipfile.ZipFile('.tmp/sender-pages.zip'); print('entries',len(z.namelist())); print('testzip:',z.testzip()); [print(' ',i.filename,i.file_size,'compress_type='+str(i.compress_type),hashlib.sha256(z.read(i.filename)).hexdigest()) for i in z.infolist()]"
 * Compare the digests line by line, and check compress_type is 0: PNGs are already compressed, so the
 * entries are STORED; a nonzero method here means someone changed the call and paid deflate for nothing.
 */
import { writeFileSync } from 'node:fs';
import { buildArtifacts } from '../web/sender.js';
import { buildZip } from '../core/mesh/threeMF.js';
import { sha256Hex } from '../core/hash.js';

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
};
const n = Number(opt('--bytes', 20480));
const profile = String(opt('--profile', 'P-M1-300'));

// Deterministic payload, so two runs produce the same digests and can be compared.
const payload = new Uint8Array(n);
let x = 0x12345678 >>> 0;
for (let i = 0; i < n; i++) {
  x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
  payload[i] = x & 255;
}

const r = await buildArtifacts(payload, { profile });
if (!r.ok) {
  console.log(`buildArtifacts failed at ${r.stage}: ${r.error}`);
  process.exit(1);
}
// Exactly the expression the click handler uses. If the handler changes, change this with it -- a
// check that drifts from the code it claims to cover is worse than no check.
const zip = buildZip(r.pages.map((p) => ({ name: `${p.tag}.png`, data: p.png, method: 'store' })));
const out = new URL('../.tmp/sender-pages.zip', import.meta.url);
writeFileSync(out, zip);
console.log(`${profile}: ${r.bytesIn} B in -> ${r.pages.length} page(s); zip ${zip.length} B; magic ${String.fromCharCode(zip[0], zip[1])}; wrote .tmp/sender-pages.zip`);
console.log('our side, per entry:');
for (const p of r.pages) console.log(`  ${p.tag}.png ${p.png.length} B ${sha256Hex(p.png)}`);
console.log('now read it back with something that is not our code (command in this file\'s header) and compare digests.');
