#!/usr/bin/env node
/**
 * Decompose G6's per-page decode cost. Read-only: it changes no decision and is not a gate.
 *
 * Why it exists. Round 65 implemented G6 (docs/PLAN.md L106: "decode <= 2 s/page") and measured
 * 8.6-9.0 s per page on real 300 dpi channel pages -- 4.5x over budget. Before aiming a fix at
 * anything, the cost has to be split into its parts, because the three parts have completely
 * different fixes:
 *   readFileSync   disk, irrelevant
 *   decodePNG      our own inflate (core/render/png.js + core/deflate.js)
 *   bootstrapDecode  N candidate attempts, each of which may do a FULL page read; the header of
 *                  core/decode/bootstrap.js says so out loud ("seconds at 300 dpi and worse at
 *                  600"), and candidatePlans() loops palettes outside dpi, so a page rendered in
 *                  PAPER1 is tried as INK2 and INK4 first.
 * It prints every attempt with its stage and its own milliseconds, which bootstrapDecode already
 * records -- no new instrumentation inside core, so this cannot drift from what the product does.
 *
 * The optional hints answer one question: what could a PERFECT cheap pre-ranking signal ever buy?
 * Most of the cost above is full page reads spent on the wrong geometry, so a hinted run is the floor
 * for the same page -- the search being told the answer instead of finding it. `--only-hints` makes the
 * hints restrict the candidate list (bootstrapDecode's own `onlyHints`), and `--palette` restricts too
 * (candidatePlans:54), so all three together leave exactly ONE candidate: the winner is the first and
 * only attempt, and its milliseconds are the whole bootstrap cost. That number decides whether building
 * a second signal can bring 600 dpi inside PLAN's 2 s budget or whether the budget itself is what needs
 * a decision -- a winning attempt is not recorded in `attempts`, so the floor cannot be read out of an
 * unhinted run, it has to be measured this way.
 *
 * usage: node tools/g6-perf-probe.mjs [--profile P-M1-600] [--dpi 600] [--palette PAPER1]
 *                                      [--only-hints] <page.png> [...]
 *        no flags at all reproduces the historical numbers exactly (maxAttempts 24, no hints).
 */
import { readFileSync, existsSync } from 'node:fs';
import { decodePNG } from '../core/decode/png-read.js';
import { bootstrapDecode } from '../core/decode/bootstrap.js';

const argv = process.argv.slice(2);
const files = [];
let profileHint;
let dpiHint;
let paletteHint;
let onlyHints = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--profile') profileHint = argv[++i];
  else if (a === '--dpi') dpiHint = Number(argv[++i]);
  else if (a === '--palette') paletteHint = argv[++i];
  else if (a === '--only-hints') onlyHints = true;
  else if (a.startsWith('--')) {
    console.error(`unknown flag ${a} (usage: --profile --dpi --palette --only-hints <page.png> ...)`);
    process.exit(2);
  } else files.push(a);
}
if (!files.length) {
  console.error('usage: node tools/g6-perf-probe.mjs [--profile P-M1-600] [--dpi 600] [--palette PAPER1] [--only-hints] <page.png> [...]');
  process.exit(2);
}
const msSince = (t0) => Number(process.hrtime.bigint() - t0) / 1e6;

for (const f of files) {
  if (!existsSync(f)) {
    console.log(`${f}\n  MISSING -- skipped (this probe measures real files, it does not invent them)`);
    continue;
  }
  const t0 = process.hrtime.bigint();
  const bytes = readFileSync(f);
  const tRead = msSince(t0);
  const t1 = process.hrtime.bigint();
  const bmp = decodePNG(new Uint8Array(bytes));
  const tPng = msSince(t1);
  const t2 = process.hrtime.bigint();
  const boot = await bootstrapDecode(bmp, { maxAttempts: 24, profileHint, dpiHint, paletteHint, onlyHints });
  const tBoot = msSince(t2);
  const attempts = boot.attempts ?? [];
  const tried = boot.attemptCount ?? attempts.length;
  console.log(`${f}`);
  console.log(`  hints: profile=${profileHint ?? '-'} dpi=${dpiHint ?? '-'} palette=${paletteHint ?? '-'} onlyHints=${onlyHints} maxAttempts=24`);
  console.log(`  image ${bmp.width}x${bmp.height} = ${((bmp.width * bmp.height) / 1e6).toFixed(1)} MP, file ${(bytes.length / 1048576).toFixed(1)} MB`);
  console.log(`  readFileSync ${tRead.toFixed(0)} ms + decodePNG ${tPng.toFixed(0)} ms + bootstrapDecode ${tBoot.toFixed(0)} ms = ${(tRead + tPng + tBoot).toFixed(0)} ms end to end`);
  console.log(`  bootstrap ok=${boot.ok} attempts=${tried} ${boot.ok ? `winner=${boot.profileId}@${boot.dpi}/${boot.paletteId}` : `reason=${boot.reason}`}`);
  // `attempts` records FAILURES only: bootstrapDecode returns the moment a candidate wins and does
  // not push that attempt. The first version of this probe labelled the LAST recorded entry as
  // "<== ACCEPTED", which printed "P-C4-600@600/PAPER1 <== ACCEPTED" directly under a line saying
  // winner=P-M1-300@300/INK2 -- self-contradictory, and it named the wrong geometry as the one that
  // worked. Round 63 already paid for ambiguous success output (an unattributed rescue note fooled
  // the person writing the ledger), so the winner is printed exactly once, from `boot`, and this
  // list is labelled as what it is.
  console.log(`  recorded failures ${attempts.length} (a winning attempt is not recorded, so attemptCount=${tried} can be one higher):`);
  const fullReads = attempts.filter((a) => (a.ms ?? 0) > 50);
  console.log(`  of those, costing > 50 ms (i.e. reached a full page read): ${fullReads.length}, total ${(fullReads.reduce((s, a) => s + (a.ms ?? 0), 0) / 1000).toFixed(1)} s`);
  attempts.forEach((a, i) => {
    const id = `${a.profileId ?? '?'}@${a.dpi ?? '?'}/${a.paletteId ?? '?'}`;
    console.log(`    [${i}] ${id} stage=${a.stage ?? '-'} ms=${(a.ms ?? 0).toFixed(0)} reason=${a.reason ?? '-'}${a.threw ? ` THREW: ${a.threw}` : ''}`);
  });
  console.log('');
}
