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
const { buildArtifacts } = await import(pathToFileURL(join(ROOT, 'web', 'sender.js')).href);
const { bootstrapDecode } = await import(pathToFileURL(join(ROOT, 'core', 'decode', 'bootstrap.js')).href);
const { TransferAssembler } = await import(pathToFileURL(join(ROOT, 'core', 'protocol.js')).href);
const { sha256Hex } = await import(pathToFileURL(join(ROOT, 'core', 'hash.js')).href);

const raw = new Uint8Array(n).map((_, i) => (i * 167 + (i >> 3)) & 0xff);
const want = sha256Hex(raw);
let failures = 0;

const step = (label, ok, detail) => {
  console.log(`${ok ? ' PASS' : ' FAIL'}  ${label}`);
  console.log(`          ${detail}`);
  if (!ok) failures++;
};

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
    const boot = await bootstrapDecode(p.bitmap, { maxAttempts: 24 });
    if (!boot.ok) {
      pageFail = `${p.tag}: ${boot.reason} after ${boot.attempts.length} candidates`;
      break;
    }
    const fed = await asm.feed({ levels: boot.page.levels, header: boot.page.headerBytes, channelMissing: boot.page.colourAlive ? [] : ['colour'] });
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
