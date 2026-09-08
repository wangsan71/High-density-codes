#!/usr/bin/env node
/**
 * Execute the web sender's real data path in Node, then decode what it produced.
 *
 * web/sender.js keeps its DOM behind a guard precisely so this file can import
 * buildArtifacts() and call it. That matters because there is no browser here: without an
 * executable path, the only verification available for the sender page was syntax, and
 * syntax accepted three invented profile fields last round (DEFECTS D2/D9).
 *
 * The two profiles are not decoration:
 *   P-M1-300 -- paper: exercises sheetMm from geometry, PDF, and refuses the relief path.
 *   PL-D2    -- plate: exercises buildPlateModel + projectionReport + stlSelfCheck +
 *                selfCheck3MF, i.e. the guards that are allowed to produce nothing.
 *
 * After encoding, each rendered page is decoded back through core/decode/bootstrap.js (no
 * hints, the same call the receiver page makes) and reassembled. The end-to-end assertion
 * is against the SHA-256 of the input bytes, so a "success" here cannot be the encoder
 * agreeing with itself about a wrong payload.
 *
 *   node tools/smoke-sender.mjs [--bytes 4096]
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const n = Number(args.includes('--bytes') ? args[args.indexOf('--bytes') + 1] : 4096);
// previewPlan / printPlan are the two page-count policies the DOM applies. The handlers themselves sit
// behind a `document` guard, so these pure functions are the only in-process view of them: an uncapped
// preview costs ~35 MB of decoded raster per page, and round 67's print warning printed only after the
// window had already been written (DEFECTS D61).
const { buildArtifacts, previewPlan, printPlan, PREVIEW_CAP, PRINT_WINDOW_PAGE_CAP, downloadPlan, DATA_URL_RISK_BYTES } = await import(pathToFileURL(join(ROOT, 'web', 'sender.js')).href);
const { bootstrapDecode } = await import(pathToFileURL(join(ROOT, 'core', 'decode', 'bootstrap.js')).href);
const { TransferAssembler } = await import(pathToFileURL(join(ROOT, 'core', 'protocol.js')).href);
const { sha256Hex } = await import(pathToFileURL(join(ROOT, 'core', 'hash.js')).href);
// Round 66: the sender no longer keeps a page's raster after pack.pdf has consumed it (holding all of
// them cost ~31 MB per page, 1.30 GB for a 256 KiB file), so this smoke decodes the PNG instead --
// which is the artifact a user actually prints, so the blind decode now covers the PNG encoder and
// the whole sheet (margins, crop and registration marks) as well. Stronger, not weaker.
const { decodePNG } = await import(pathToFileURL(join(ROOT, 'core', 'decode', 'png-read.js')).href);
// Round 66: this was also a feed site still calling asm.feed directly, i.e. one of the call sites the
// round-63 RS-arbitrated re-read (DEFECTS D51) did not reach. Every path that feeds a page uses it.
const { feedPageWithRecalibration } = await import(pathToFileURL(join(ROOT, 'core', 'decode', 'recalibrate.js')).href);

const raw = new Uint8Array(n).map((_, i) => (i * 167 + (i >> 3)) & 0xff);
const want = sha256Hex(raw);
let failures = 0;

const step = (label, ok, detail) => {
  console.log(`${ok ? ' PASS' : ' FAIL'}  ${label}`);
  console.log(`          ${detail}`);
  if (!ok) failures++;
};

// Round 68: the page-count policies are pure functions, so these two steps are the in-process check on
// DOM behaviour nothing else can reach. Both carry a positive control -- a 3-page transfer must preview
// all three pages, and a page count at the cap must still be printable -- otherwise a policy that
// refused everything would "pass" these assertions while breaking the product.
{
  const small = previewPlan(3);
  const big = previewPlan(168);
  step(
    'sender previews are capped, and the cap says what it skipped',
    small.shown === 3 && small.hidden === 0 && small.note === '' &&
      big.shown === PREVIEW_CAP && big.hidden === 168 - PREVIEW_CAP &&
      big.note.includes(String(big.hidden)) && /pack\.pdf/.test(big.note) && /zip/.test(big.note),
    `3 pages -> shown ${small.shown} hidden ${small.hidden}, no note (positive control); 168 pages -> shown ${big.shown} hidden ${big.hidden}, note states the hidden count and names pack.pdf + zip`
  );
  const fits = printPlan(PRINT_WINDOW_PAGE_CAP);
  const tooMany = printPlan(168);
  step(
    'sender refuses the browser-print window before spending, not after',
    fits.write === true && fits.note === '' && printPlan(0).write === true &&
      tooMany.write === false && /pack\.pdf/.test(tooMany.note) && /GB/.test(tooMany.note),
    `${PRINT_WINDOW_PAGE_CAP} pages -> write, 0 pages -> write (positive controls); 168 pages -> refuse, naming ${((168 * 35) / 1024).toFixed(1)} GB and offering pack.pdf`
  );
}

// Round 70: the download-size warning (DEFECTS D63). Positive controls on BOTH sides of the threshold,
// because the failure mode this guards against is a silent download -- and the opposite failure mode is
// a page that cries wolf on every three-page transfer until the user stops reading the log.
{
  const quiet = downloadPlan('pskt-pack.pdf', 802 * 1024);
  const loud = downloadPlan('pskt-pages-168.zip', 63 * 1024 * 1024);
  step(
    'sender says when a data: URL download is too big to trust, and stays quiet when it is not',
    quiet.risk === false && quiet.note === '' &&
      downloadPlan('x.bin', DATA_URL_RISK_BYTES - 1).risk === false &&
      loud.risk === true && loud.note.includes('pskt-pages-168.zip') && /MB/.test(loud.note) &&
      /cli\/pskit\.mjs send/.test(loud.note) &&
      downloadPlan('x.bin', DATA_URL_RISK_BYTES).risk === true,
    `802 KB -> no note and ${(DATA_URL_RISK_BYTES - 1)} B -> no note (positive controls); 63 MB -> note names the file, its size and the CLI route; the threshold ${DATA_URL_RISK_BYTES} B is inclusive`
  );
}

for (const profile of ['P-M1-300', 'PL-D2']) {
  const r = await buildArtifacts(raw, { profile });
  if (!r.ok) {
    step(`sender ${profile}`, false, `stage ${r.stage}: ${r.error}`);
    continue;
  }
  step(`sender ${profile} encodes`, true, `${r.pages.length} page(s) · palette ${r.paletteId} · ${r.dpi} dpi · cellPx ${r.cellPx} · ${r.ms} ms · pdf ${r.pdf.length} B · models ${r.models.length}`);
  if (r.parityPages !== 0) console.log(`          (note: ${r.parityPages} page(s) reported header.kind === 'parity')`);

  const asm = new TransferAssembler({});
  let pageFail = null;
  for (const p of r.pages) {
    const boot = await bootstrapDecode(decodePNG(p.png), { maxAttempts: 24 });
    if (!boot.ok) {
      pageFail = `${p.tag}: ${boot.reason} after ${boot.attempts.length} candidates`;
      break;
    }
    const resc = await feedPageWithRecalibration(asm, boot.page, { geom: boot.geom });
    const fed = resc.fed;
    if (!fed.ok && !fed.duplicate) {
      pageFail = `${p.tag}: assembler rejected (${fed.reason})`;
      break;
    }
  }
  if (pageFail) {
    step(`sender ${profile} pages decode`, false, pageFail);
    continue;
  }
  const got = asm.result;
  step(
    `sender ${profile} pages decode and round-trip`,
    !!got && sha256Hex(got) === want,
    `${r.pages.length} page(s) self-identified, ${got ? got.length : 0} B recovered, sha256 ${got ? sha256Hex(got).slice(0, 16) : '-'} vs ${want.slice(0, 16)}`,
  );

  if (profile === 'PL-D2') {
    const okShapes = r.models.length === r.pages.length && r.models.every((m) => m.triangles > 0 && m.three.length > 100 && m.stl.length > 300);
    step('sender plate models pass the CLI guards', okShapes, `3MF bytes ${r.models.map((m) => m.three.length).join('/')} · STL bytes ${r.models.map((m) => m.stl.length).join('/')} · tris ${r.models.map((m) => m.triangles).join('/')} · bbox ${JSON.stringify(r.models[0].bboxMm)}`);
  } else {
    step('sender paper profile offers no relief model', r.models.length === 0 && !r.plate, `plate=${r.plate} models=${r.models.length} (refusal is the correct behaviour, mirroring the CLI)`);
  }
}

// A negative case: an unusable option must fail closed with a named stage, not half-build.
const bad = await buildArtifacts(raw, { profile: 'P-M1-300', dpi: 30 });
step('sender refuses an impossible dpi instead of emitting garbage', !bad.ok && !!bad.stage, bad.ok ? 'it claimed success at 30 dpi' : `stage ${bad.stage}: ${String(bad.error).slice(0, 90)}`);

console.log('');
console.log(failures ? `SENDER SMOKE: ${failures} FAILED` : 'SENDER SMOKE: all assertions pass');
process.exitCode = failures ? 1 : 0;
