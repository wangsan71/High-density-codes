#!/usr/bin/env node
/**
 * G6 -- performance + soak, in process.
 *
 * The criterion is quoted from docs/PLAN.md L106 and is not restated loosely anywhere below:
 *   encode 1 MB <= 5 s; decode <= 2 s/page; a 30-60 min soak (background task) with
 *   RSS growth <= 10% and zero false accepts.
 *
 * Why this file exists: G6 was the only gate still red purely because nobody had written it --
 * it needs no phone, no browser and no printer, only time. ACCEPTANCE recorded the perf half as
 * "430 ms on the ideal path, worst hard page 4.9 s on a real channel" and the soak half as
 * "never executed", i.e. the performance budget contained an unknown. This measures both.
 *
 * What a run covers, and what it does not (printed by every run, so "G6 PASS" cannot be quoted
 * as more than it is):
 *   covered    encode of a 1 MB payload; per-page decode timing on real channel pages when a
 *              corpus is present (otherwise on freshly rendered pristine pages, and the report
 *              says which); a long loop of full desktop-path transfers (encode -> render ->
 *              PNG -> bootstrap -> arbitrated feed -> digest) plus G5-style level corruptions
 *              that must each end in exact bytes or a refusal; RSS sampled through the loop.
 *   not covered the optical channel itself (sim/channel.py is Python and cannot be spawned from
 *              inside Node here), real ink/paper, a real phone camera, browsers. A corpus passed
 *              with --corpus brings real channel pages into the decode timing and the loop, which
 *              is the closest in-process equivalent; it is still not G2/G4 evidence.
 *
 * Deliberate choices:
 *   - RSS is compared as median-of-first-samples against median-of-last-samples, not min against
 *     max: a single sample is GC timing, and min/max would report noise as a leak (or hide one).
 *   - Per-cycle data stays local. Accumulating bitmaps or page objects here would manufacture the
 *     very growth this gate is supposed to detect, and the verdict would be about this file.
 *   - Decode timing is judged on the WORST page, not the mean: the criterion is per page, and a
 *     mean would let one 10 s page hide behind ninety fast ones.
 *   - Fixtures are deterministic (xorshift filler, no Math.random) so a verdict is repeatable.
 */

import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodeTransfer, TransferAssembler } from '../core/protocol.js';
import { pageLayout } from '../core/render/layout.js';
import { renderPageBitmap, renderSheetBitmap, echoBitsOf } from '../core/render/raster.js';
import { encodePNG } from '../core/render/png.js';
import { decodePNG } from '../core/decode/png-read.js';
import { bootstrapDecode } from '../core/decode/bootstrap.js';
import { feedPageWithRecalibration } from '../core/decode/recalibrate.js';
import { sha256Hex } from '../core/hash.js';

const PROFILE = 'P-M1-300';
const DPI = 300;
const PALETTE = 'PAPER1';
const ENCODE_BUDGET_MS = 5000; // PLAN: encode 1 MB <= 5 s
const DECODE_BUDGET_MS = 2000; // PLAN: decode <= 2 s/page
const RSS_BUDGET_PCT = 10; // PLAN: RSS growth <= 10%

/** Deterministic incompressible-ish filler. No Math.random: a gate verdict must be repeatable. */
function filler(n, seed) {
  const out = new Uint8Array(n);
  let x = (seed >>> 0) || 1;
  for (let i = 0; i < n; i++) {
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    out[i] = x & 255;
  }
  return out;
}

const median = (a) => {
  if (!a.length) return NaN;
  const s = [...a].sort((p, q) => p - q);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Render every page of a transfer to PNG bytes, the way the desktop sender does. */
function renderToPngs(t) {
  const layout = pageLayout(t.geom, DPI);
  return t.pages.map((p) => {
    const code = renderPageBitmap({ geom: t.geom, levels: p.levels, layout, palette: PALETTE, echoBits: echoBitsOf(p.header) });
    const bmp = code.sheetMm ? renderSheetBitmap(code) : code;
    return encodePNG(bmp);
  });
}

/**
 * Decode PNG bytes back to a payload through the product path (bootstrap, then the RS-arbitrated
 * feed the desktop page, the phone burst path, the G2 harness and check-dist all use).
 * Returns per-page timings so the caller can judge the per-page budget on the worst page.
 */
async function decodePngs(pngs, { expectSha } = {}) {
  const asm = new TransferAssembler({});
  const perPage = [];
  const refusals = [];
  for (const png of pngs) {
    const t0 = process.hrtime.bigint();
    const bmp = decodePNG(png instanceof Uint8Array ? png : new Uint8Array(png));
    const boot = await bootstrapDecode(bmp, { maxAttempts: 24 });
    if (!boot.ok) {
      refusals.push(`bootstrap:${boot.reason}`);
      perPage.push(Number(process.hrtime.bigint() - t0) / 1e6);
      continue;
    }
    const resc = await feedPageWithRecalibration(asm, boot.page, { geom: boot.geom });
    perPage.push(Number(process.hrtime.bigint() - t0) / 1e6);
    if (!resc.fed.ok && !resc.fed.duplicate) refusals.push(`feed:${resc.fed.reason}`);
  }
  const out = { perPage, refusals, result: asm.result, asm };
  if (asm.result && expectSha) {
    const hex = sha256Hex(asm.result);
    out.digestOk = hex === expectSha;
    out.digest = hex;
  }
  return out;
}

/** Discover real channel corpora under .tmp unless the caller named them. */
function defaultCorpora(root = '.tmp', prefix = 'sc-scan300-', limit = 3) {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((d) => d.startsWith(prefix) && existsSync(join(root, d, 'manifest.json')))
    .sort()
    .slice(0, limit)
    .map((d) => join(root, d));
}

function readCorpus(dir) {
  const pngs = readdirSync(dir).filter((f) => /\.png$/i.test(f)).sort().map((f) => readFileSync(join(dir, f)));
  let expectSha = null;
  const mfPath = join(dir, 'manifest.json');
  if (existsSync(mfPath)) {
    try {
      expectSha = JSON.parse(readFileSync(mfPath, 'utf8')).sourceSha256 ?? null;
    } catch {
      expectSha = null;
    }
  }
  return { pngs, expectSha };
}

export async function runSoak(opts = {}) {
  const minutes = Number(opts.minutes ?? 30);
  const log = opts.log ?? ((s) => console.log(s));
  const corpora = (opts.corpus && opts.corpus.length ? opts.corpus : defaultCorpora()).map((d) => ({ dir: d, ...readCorpus(d) }));
  const say = (s) => log(s);

  say(`PSKT G6 soak -- criterion quoted from docs/PLAN.md L106:`);
  say(`  encode 1MB <= ${ENCODE_BUDGET_MS} ms; decode <= ${DECODE_BUDGET_MS} ms/page; ${minutes} min soak with RSS growth <= ${RSS_BUDGET_PCT}% and zero false accepts`);
  say(`  profile ${PROFILE} @ ${DPI} dpi; corpora with real channel pages: ${corpora.length ? corpora.map((c) => c.dir).join(', ') : 'NONE (decode timing will be on pristine rendered pages, and the report says so)'}`);

  // ---- phase A: encode 1 MB -------------------------------------------------------------
  const oneMB = 1024 * 1024;
  const big = filler(oneMB, 0x60a6);
  let encMs;
  let bigPages = 0;
  {
    const t0 = process.hrtime.bigint();
    const t = await encodeTransfer(big, { profile: PROFILE });
    encMs = Number(process.hrtime.bigint() - t0) / 1e6;
    bigPages = t.pages.length;
  }
  const encOk = encMs <= ENCODE_BUDGET_MS;
  say(`A. encode ${oneMB} B -> ${bigPages} pages in ${encMs.toFixed(0)} ms  ${encOk ? '<= budget' : 'OVER BUDGET'} (${(encMs / 1000).toFixed(2)} s)`);

  // Render throughput is reported, not judged: the criterion names encoding, and rendering 137
  // A4 sheets here would take minutes and dominate a number PLAN did not ask for.
  {
    const small = await encodeTransfer(filler(20480, 11), { profile: PROFILE });
    const t0 = process.hrtime.bigint();
    const pngs = renderToPngs(small);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    say(`   (reported, not judged: render+PNG of ${pngs.length} page(s) took ${ms.toFixed(0)} ms = ${(ms / pngs.length).toFixed(0)} ms/page)`);
  }

  // ---- phase B: decode timing per page ---------------------------------------------------
  // Real channel pages when a corpus exists -- that is the number ACCEPTANCE called unknown.
  let decWorst = 0;
  let decMean = 0;
  let decPages = 0;
  let decSource = 'pristine rendered pages (no corpus)';
  let decOk = true;
  {
    const timings = [];
    if (corpora.length) {
      decSource = `real channel pages from ${corpora.map((c) => c.dir).join(', ')}`;
      for (const c of corpora) {
        const r = await decodePngs(c.pngs, { expectSha: c.expectSha });
        timings.push(...r.perPage);
        if (c.expectSha && r.result && r.digestOk === false) {
          say(`   !! corpus ${c.dir}: assembler closed but digest ${r.digest} != manifest ${c.expectSha}`);
          decOk = false; // a wrong payload would be a false accept, which no budget can excuse
        }
      }
    } else {
      const t = await encodeTransfer(filler(20480, 7), { profile: PROFILE });
      const r = await decodePngs(renderToPngs(t), { expectSha: sha256Hex(filler(20480, 7)) });
      timings.push(...r.perPage);
      if (r.digestOk === false) decOk = false;
    }
    decPages = timings.length;
    decWorst = timings.length ? Math.max(...timings) : NaN;
    decMean = timings.length ? timings.reduce((a, b) => a + b, 0) / timings.length : NaN;
    decOk = decOk && Number.isFinite(decWorst) && decWorst <= DECODE_BUDGET_MS;
    say(`B. decode ${decPages} page(s) from ${decSource}`);
    say(`   worst ${decWorst.toFixed(0)} ms/page, mean ${decMean.toFixed(0)} ms/page  ${decWorst <= DECODE_BUDGET_MS ? '<= budget' : 'OVER BUDGET'} (judged on the worst page: the criterion is per page)`);
  }

  // ---- phase C: the soak -----------------------------------------------------------------
  // The budget clock is started after warmup, not here: with the deadline computed at the top of
  // the phase, the two warmup cycles (each ~80 s, because a cycle decodes real channel pages at
  // the measured 8.6 s/page) ate an entire --minutes 1 trial and the loop reported "0 cycles,
  // RSS NaN". PLAN asks for 30-60 min of soak, so the clock starts when the soaking starts.
  let deadline = 0;
  const rss = [];
  const cycleMs = [];
  let cycles = 0;
  let pagesDecoded = 0;
  let trials = 0;
  let falseAccepts = 0;
  let mismatches = 0;
  let errors = 0;
  let refusalsSeen = 0;
  let rescued = 0;
  const firstErr = [];

  // Warmup before the baseline: the first cycles pay for JIT and for the first GCs, and a
  // baseline taken there would make every later sample look like growth.
  const warm = async () => {
    for (let i = 0; i < 2; i++) await cycle(i, true);
    rss.length = 0;
    cycleMs.length = 0;
    cycles = 0;
    pagesDecoded = 0;
    trials = 0;
    falseAccepts = 0;
    mismatches = 0;
    errors = 0;
    refusalsSeen = 0;
    rescued = 0;
    firstErr.length = 0;
  };

  async function cycle(i, warming) {
    const t0 = process.hrtime.bigint();
    // 1. a full desktop-path transfer with a payload whose size walks 4 KiB..64 KiB
    const size = 4096 + ((i * 7919) % 15) * 4096;
    const payload = filler(size, 0x1000 + i);
    const expect = sha256Hex(payload);
    const t = await encodeTransfer(payload, { profile: PROFILE });
    const pngs = renderToPngs(t);
    const d = await decodePngs(pngs, { expectSha: expect });
    pagesDecoded += d.perPage.length;
    refusalsSeen += d.refusals.length;
    if (!d.result) {
      mismatches++;
      if (firstErr.length < 5) firstErr.push(`cycle ${i}: pristine round trip did not close (${d.refusals.join(', ') || 'no reason'})`);
    } else if (d.digestOk === false) {
      falseAccepts++;
      if (firstErr.length < 5) firstErr.push(`cycle ${i}: FALSE ACCEPT digest ${d.digest} != ${expect}`);
    }

    // 2. real channel pages, rotating through the corpora when we have them
    if (corpora.length) {
      const c = corpora[i % corpora.length];
      const r = await decodePngs(c.pngs, { expectSha: c.expectSha });
      pagesDecoded += r.perPage.length;
      refusalsSeen += r.refusals.length;
      if (c.expectSha && r.result && r.digestOk === false) {
        falseAccepts++;
        if (firstErr.length < 5) firstErr.push(`cycle ${i}: FALSE ACCEPT on corpus ${c.dir}`);
      }
    }

    // 3. G5-style corruptions: every one must end in exact bytes or in a refusal
    const geom = t.geom;
    for (let k = 0; k < 8; k++) {
      trials++;
      const pages = t.pages.map((p) => ({ levels: p.levels.slice(), header: p.header.slice() }));
      const victim = pages[k % pages.length];
      if (k % 2 === 0) {
        const flips = 1 + ((i + k) % 24);
        for (let f = 0; f < flips; f++) {
          const idx = (Math.imul(f + 1, 2654435761) ^ (i * 31 + k)) % victim.levels.length;
          victim.levels[Math.abs(idx)] ^= 1 << (f % geom.bitsPerCell);
        }
      } else {
        // heavy damage: most of one page rewritten, beyond what intra-page RS can fix
        const from = Math.floor(victim.levels.length * 0.2);
        const to = Math.floor(victim.levels.length * (0.2 + 0.6 * (((k + i) % 5) / 5 || 0.2)));
        for (let j = from; j < to; j++) victim.levels[j] = (victim.levels[j] ^ 0x55) & ((1 << geom.bitsPerCell) - 1);
      }
      const asm = new TransferAssembler({});
      let bad = 0;
      for (const p of pages) {
        const resc = await feedPageWithRecalibration(asm, { levels: p.levels, headerBytes: p.header, channelMissing: [] }, { geom });
        if (resc.retried) rescued++;
        if (!resc.fed.ok && !resc.fed.duplicate) bad++;
      }
      if (asm.result) {
        const hex = sha256Hex(asm.result);
        if (hex !== expect) {
          // It closed on bytes that are not the payload: the only unforgivable outcome.
          falseAccepts++;
          if (firstErr.length < 5) firstErr.push(`cycle ${i} trial ${k}: FALSE ACCEPT ${hex} != ${expect}`);
        }
      } else if (bad === 0) {
        mismatches++;
        if (firstErr.length < 5) firstErr.push(`cycle ${i} trial ${k}: every page fed ok but nothing assembled`);
      }
    }

    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    if (!warming) {
      cycles++;
      cycleMs.push(ms);
      rss.push(process.memoryUsage().rss);
    }
  }

  const wrap = async (i, warming) => {
    try {
      await cycle(i, warming);
    } catch (e) {
      errors++;
      if (firstErr.length < 5) firstErr.push(`cycle ${i}: threw ${e && e.message ? e.message : String(e)}`);
      if (!warming) rss.push(process.memoryUsage().rss);
    }
  };

  await warm();
  const started = Date.now();
  deadline = started + minutes * 60_000;
  let i = 0;
  let lastReport = 0;
  while (Date.now() < deadline) {
    await wrap(i++, false);
    const now = Date.now();
    if (now - lastReport >= 60_000) {
      lastReport = now;
      const mins = ((now - started) / 60000).toFixed(1);
      say(`   ... ${mins} min in, ${cycles} cycles, ${pagesDecoded} pages decoded, rss ${(rss[rss.length - 1] / 1048576).toFixed(1)} MB, ${falseAccepts} false accepts, ${errors} errors`);
    }
  }
  const elapsedMin = (Date.now() - started) / 60000;

  const n = rss.length;
  // Window length is an instrument-resolution question, and round 67 measured the answer instead of
  // guessing it. RSS in this process swings between 449.3 and 641.4 MB with GC around a FLAT median:
  // per-minute medians over the 30.2 min post-fix run were 510.6 MB (3-8 min), 512.8 (8-20 min) and
  // 515.5 (20-31 min), i.e. +0.95% across 28 minutes -- no leak, and no startup ramp either (the
  // first three minutes were HIGHER, 581.9 MB, than the plateau). But a window of 10% of the samples
  // is only ~3 minutes once a cycle takes 13 s, which is SHORTER THAN ONE SAWTOOTH SWING, so what it
  // reported was whichever GC phase each window happened to land in: this same tool on this same code
  // said +2.50% when a cycle took ~80 s (3 samples = 4 min) and +13.98% when a cycle took 13 s
  // (14 samples = 3 min). The criterion is untouched at <=10%; the window became a quartile so each
  // side averages ~7 minutes of sawtooth. Both statistics are computed, both are printed, and both go
  // into the JSON, so the switch hides nothing and the old number stays comparable across runs.
  const head = Math.max(8, Math.round(n * 0.25));
  const base = median(rss.slice(0, head));
  const fin = median(rss.slice(Math.max(0, n - head)));
  const growthPct = ((fin - base) / base) * 100;
  const narrowHead = Math.max(3, Math.round(n * 0.1));
  const narrowBase = median(rss.slice(0, narrowHead));
  const narrowPct = ((median(rss.slice(Math.max(0, n - narrowHead))) - narrowBase) / narrowBase) * 100;
  // Quartile medians: a leak is a monotone climb across these four numbers, GC noise is not. Printed
  // so a human can see the shape rather than trust one endpoint difference.
  const q = [0, 1, 2, 3].map((k) => median(rss.slice(Math.floor((n * k) / 4), Math.max(Math.floor((n * k) / 4) + 1, Math.floor((n * (k + 1)) / 4)))));
  const peak = n ? Math.max(...rss) : NaN;
  const floor = n ? Math.min(...rss) : NaN;
  const mb = (v) => (v / 1048576).toFixed(1);
  const early = median(cycleMs.slice(0, Math.max(3, Math.round(cycleMs.length * 0.1))));
  const late = median(cycleMs.slice(Math.max(0, cycleMs.length - Math.max(3, Math.round(cycleMs.length * 0.1)))));

  say(`C. soak ran ${elapsedMin.toFixed(1)} min, ${cycles} cycles, ${pagesDecoded} pages decoded, ${trials} corruption trials`);
  say(`   rss baseline ${mb(base)} MB (median of first ${head} samples = first quartile) -> final ${mb(fin)} MB (median of last ${head}) = ${growthPct >= 0 ? '+' : ''}${growthPct.toFixed(2)}%  ${growthPct <= RSS_BUDGET_PCT ? '<= budget' : 'OVER BUDGET'}; peak ${mb(peak)} MB, floor ${mb(floor)} MB; ${n} samples`);
  say(`   rss quartile medians Q1..Q4 ${q.map(mb).join(' / ')} MB -- a leak climbs monotonically across these four, GC noise does not`);
  say(`   (the pre-round-67 window, 10% of samples = ${narrowHead}, would report ${narrowPct >= 0 ? '+' : ''}${narrowPct.toFixed(2)}%; printed, not judged: with a ${mb(floor)}-${mb(peak)} MB sawtooth that window is shorter than one swing)`);
  say(`   cycle time median early ${early.toFixed(0)} ms -> late ${late.toFixed(0)} ms (reported, not judged: PLAN puts no bound on drift)`);
  say(`   false accepts ${falseAccepts}, digest mismatches / non-closing round trips ${mismatches}, thrown errors ${errors}, page refusals ${refusalsSeen} (refusals are correct behaviour, counted not judged), arbitrated re-reads offered ${rescued}`);
  if (firstErr.length) for (const e of firstErr) say(`   !! ${e}`);

  const rssOk = Number.isFinite(growthPct) && growthPct <= RSS_BUDGET_PCT;
  const cleanOk = falseAccepts === 0 && mismatches === 0 && errors === 0;
  // 30 min is a FLOOR of the criterion, which --minutes may raise but never lower. This line used to
  // read `elapsedMin >= Math.min(minutes, 30) * 0.98`, so a 72-second run printed
  // `PASS G6: encode 196 ms <= 5000; ... 1.2 min >= 30 min` -- a green G6 from `--minutes 1`, and
  // reachable from the documented gate command (`verify --gate G6 --minutes 1`). A gate that can be
  // satisfied by running it for less time than the criterion names is the falsest output there is,
  // and the comment that sat beside it ("a 30 min soak must actually be 30 min") already said the
  // right thing; the code did not do it. Round 67's one-minute trial is what exposed both.
  const MINUTES_REQUIRED = 30;
  const minutesOk = elapsedMin >= MINUTES_REQUIRED * 0.98;
  const ok = encOk && decOk && rssOk && cleanOk && minutesOk;

  say('');
  say(`covers: encode 1MB, per-page decode timing (${decSource}), ${cycles} full desktop-path transfers, ${trials} corruption trials, ${n} RSS samples over ${elapsedMin.toFixed(1)} min`);
  say(`does NOT cover: the optical channel model in sim/channel.py (Python, not spawnable from Node here), real ink/paper, a real phone camera, browsers -- those are G2/G4/G9 evidence, not G6`);
  say(`${ok ? 'PASS' : 'FAIL'} G6: encode ${encMs.toFixed(0)} ms ${encOk ? '<=' : '>'} ${ENCODE_BUDGET_MS}; worst decode ${decWorst.toFixed(0)} ms/page ${decWorst <= DECODE_BUDGET_MS ? '<=' : '>'} ${DECODE_BUDGET_MS}; rss ${growthPct >= 0 ? '+' : ''}${growthPct.toFixed(2)}% ${rssOk ? '<=' : '>'} ${RSS_BUDGET_PCT}%; false accepts ${falseAccepts}; mismatches ${mismatches}; errors ${errors}; ${elapsedMin.toFixed(1)} min ${minutesOk ? '>=' : '<'} ${MINUTES_REQUIRED} min`);
  if (!ok && !minutesOk) say(`  note: the run was shorter than the criterion asks (${elapsedMin.toFixed(1)} min); a short run cannot pass G6, only fail it`);

  const result = {
    ok,
    minutes: elapsedMin,
    encode: { bytes: oneMB, pages: bigPages, ms: encMs, budgetMs: ENCODE_BUDGET_MS, ok: encOk },
    decode: { pages: decPages, worstMs: decWorst, meanMs: decMean, source: decSource, budgetMs: DECODE_BUDGET_MS, ok: decOk },
    soak: { cycles, pagesDecoded, trials, rssSamples: n, rssWindowSamples: head, rssBaselineBytes: base, rssFinalBytes: fin, rssPeakBytes: peak, rssFloorBytes: floor, rssQuartileMediansBytes: q, growthPct, narrowWindowSamples: narrowHead, narrowGrowthPct: narrowPct, budgetPct: RSS_BUDGET_PCT, ok: rssOk, cycleMsEarly: early, cycleMsLate: late },
    integrity: { falseAccepts, mismatches, errors, refusalsSeen, rescued, ok: cleanOk, firstErrors: firstErr },
    corpora: corpora.map((c) => c.dir),
  };
  if (opts.out) {
    writeFileSync(opts.out, `${JSON.stringify(result, null, 2)}\n`);
    say(`wrote ${opts.out}`);
  }
  return result;
}

const isMain = process.argv[1] && /soak\.mjs$/.test(process.argv[1]);
if (isMain) {
  const argv = process.argv.slice(2);
  const opt = (name, dflt) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
  };
  const corpora = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === '--corpus' && argv[i + 1]) corpora.push(argv[++i]);
  const res = await runSoak({
    minutes: Number(opt('--minutes', 30)),
    corpus: corpora,
    out: opt('--out', null),
  });
  process.exitCode = res.ok ? 0 : 1;
}
