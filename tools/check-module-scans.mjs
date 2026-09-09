/**
 * Module-profile scan checker for the user acceptance kit.
 *
 * The kit writes payload-module.bin and module-6/5/4 directories. This tool receives
 * the scanned PNG/TIFF directories through the same decodePage + arbitrated RS path as
 * the CLI and browser, then recomputes the payload digest instead of trusting filenames.
 *
 *   node tools/check-module-scans.mjs --kit .tmp/acceptance-kit --scans .tmp/module-scans
 */

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { planPage } from '../core/profiles.js';
import { TransferAssembler } from '../core/protocol.js';
import { pageLayout } from '../core/render/layout.js';
import { decodePage } from '../core/decode/page.js';
import { decodePNG } from '../core/decode/png-read.js';
import { decodeTIFF } from '../core/decode/tiff-read.js';
import { feedPageWithRecalibration } from '../core/decode/recalibrate.js';
import { getPalette } from '../core/palette.js';
import { sha256Hex } from '../core/hash.js';

const PROFILES = ['P-MX-300-6', 'P-MX-300-5', 'P-MX-300-4'];

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const kit = arg('--kit', '.tmp/acceptance-kit');
const scans = arg('--scans', '.tmp/module-scans');
const verbose = process.argv.includes('--verbose');

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log('usage: node tools/check-module-scans.mjs --kit DIR --scans DIR [--verbose]');
  process.exit(0);
}

const payloadPath = join(kit, 'payload-module.bin');
if (!existsSync(payloadPath) || !statSync(payloadPath).isFile()) {
  console.error(`check-module-scans: missing ${payloadPath}; run tools/acceptance-kit.ps1 first`);
  process.exit(2);
}
const payload = new Uint8Array(readFileSync(payloadPath));
const want = sha256Hex(payload);

const failures = [];
const t0 = performance.now();

for (const profile of PROFILES) {
  const suffix = profile.slice(-1);
  const dir = join(scans, `module-${suffix}`);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    failures.push(`${profile}: scan directory missing: ${dir}`);
    continue;
  }
  const names = readdirSync(dir)
    .filter((n) => /\.(png|tif|tiff)$/i.test(n))
    .sort();
  if (!names.length) {
    failures.push(`${profile}: no PNG/TIFF pages in ${dir}`);
    continue;
  }

  const geom = planPage(profile, {});
  const layout = pageLayout(geom, geom.dpi, { sheetMm: geom.sheetMm });
  const asm = new TransferAssembler();
  const pageFailures = [];
  let images = 0;
  let rescued = 0;

  for (const name of names) {
    const bytes = new Uint8Array(readFileSync(join(dir, name)));
    let bitmaps;
    try {
      bitmaps = /\.(tif|tiff)$/i.test(name) ? decodeTIFF(bytes).pages : [decodePNG(bytes)];
    } catch (e) {
      pageFailures.push(`${name}: unreadable image (${e.message})`);
      continue;
    }
    for (const bitmap of bitmaps) {
      images++;
      bitmap.substrate = bitmap.substrate || getPalette('PAPER1').background;
      const r = decodePage(bitmap, { geom, layout, paletteId: 'PAPER1' }, { allowFastPath: false });
      if (!r.ok) {
        pageFailures.push(`${name}: ${r.stage}/${r.reason}`);
        continue;
      }
      const resc = await feedPageWithRecalibration(asm, r, { geom });
      if (resc.retried && resc.fed.ok) rescued++;
      if (!resc.fed.ok && !resc.fed.duplicate) pageFailures.push(`${name}: assemble/${resc.fed.reason}`);
    }
  }

  const got = asm.result ? sha256Hex(asm.result) : null;
  const ok = got === want;
  if (!ok) {
    failures.push(
      `${profile}: ${asm.result ? 'digest mismatch' : `incomplete (${asm.progress.dataHave ?? 0}/${asm.progress.dataNeed ?? 0} data pages)`}`,
    );
  }
  console.log(`${ok ? 'PASS' : 'FAIL'} ${profile}  ${images} page image(s)${rescued ? `, ${rescued} rescued` : ''}  got=${got ? got.slice(0, 16) : 'none'} want=${want.slice(0, 16)}`);
  for (const f of pageFailures) if (verbose || !ok) console.log(`       ${f}`);
}

console.log(`MODULE SCANS: ${PROFILES.length - failures.length}/${PROFILES.length} profiles byte-exact in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
if (failures.length) process.exit(1);
