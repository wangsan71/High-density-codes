#!/usr/bin/env node
/**
 * Verify the burst-capture decision logic without a camera.
 *
 * Scope discipline: web/capture.js owns three things and only three -- which frames are
 * worth decoding, how to dedupe, and how to report what is missing. Rectification itself
 * (marker quad -> rectifyPage -> cell measurement) is already covered by
 * tests/unit/warp.test.mjs, which pushes a rendered page through a known homography and
 * decodes it blind. Re-testing that here would double the surface and could disagree with
 * itself, so this file feeds real page bitmaps through the real bootstrapDecode and checks
 * the collector's judgement, plus hand-built signals for the gates a camera produces
 * (small markers, low coverage, foreign session, duplicate page).
 *
 * The last case matters most: a crop of a page is a genuine frame a phone produces every
 * day, and the collector must not accept it as progress.
 *
 *   node tools/smoke-capture.mjs [--bytes 1536]
 */
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(join(ROOT, p)).href);
const args = process.argv.slice(2);
const n = Number(args.includes('--bytes') ? args[args.indexOf('--bytes') + 1] : 1536);

const { createBurstCollector } = await imp('web/capture.js');
const { encodeTransfer, TransferAssembler } = await imp('core/protocol.js');
const { pageLayout } = await imp('core/render/layout.js');
const { renderPageBitmap, renderSheetBitmap, echoBitsOf } = await imp('core/render/raster.js');
const { bootstrapDecode } = await imp('core/decode/bootstrap.js');
const { sha256Hex } = await imp('core/hash.js');
const { decodeHeader } = await imp('core/frame.js');

let failures = 0;
const step = (label, ok, detail) => {
  console.log(`${ok ? ' PASS' : ' FAIL'}  ${label}\n          ${detail}`);
  if (!ok) failures++;
};

const raw = new Uint8Array(n).map((_, i) => (i * 149 + 7) & 0xff);
const want = sha256Hex(raw);
const t = await encodeTransfer(raw, { profile: 'P-M1-300' });
const layout = pageLayout(t.geom, 300, { sheetMm: t.geom.sheetMm });
const code = t.pages.map((p) => renderPageBitmap({ geom: t.geom, levels: p.levels, layout, palette: 'PAPER1', echoBits: echoBitsOf(p.header) }));
// What a phone actually photographs is the *sheet*: margins, the code area centred on them, crop and
// registration marks -- exactly what `pskit send` writes to page-NNN.png since D45 was fixed. Feeding
// the bare code area here would keep this smoke green while proving nothing about the artifact a user
// prints and photographs (DEFECTS D47). The code-area frames are kept as a second, still-legitimate
// input below: a user who scans or crops just the code area, and every plate profile, which has no
// sheet at all.
const bitmaps = code.map((b) => (b.sheetMm ? renderSheetBitmap(b) : b));
step('synthetic corpus ready', bitmaps.length >= 2, `${bitmaps.length} sheet(s), ${bitmaps[0].width}x${bitmaps[0].height}px (code area ${code[0].width}x${code[0].height}px), payload ${n} B`);
step(
  'the frames are the shipped shape, not the bare code area',
  bitmaps[0].width > code[0].width && bitmaps[0].height > code[0].height && bitmaps[0].sheetMm === undefined && bitmaps[0].markSegments > 0,
  `sheet ${bitmaps[0].width}x${bitmaps[0].height}px, ${bitmaps[0].markSegments} mark segments, margin ${bitmaps[0].marginMm.toFixed(2)}mm · code ${code[0].width}x${code[0].height}px`,
);

/* ---- 1. real pages through the real receiver path ---- */
const asm = new TransferAssembler({});
const collector = createBurstCollector({
  decode: (bmp) => bootstrapDecode(bmp, { maxAttempts: 24 }),
  feed: (page) => asm.feed({ levels: page.levels, header: page.headerBytes, channelMissing: page.colourAlive ? [] : ['colour'] }),
});
const seen = [];
let evt;
for (const b of bitmaps) {
  evt = await collector.addFrame(b);
  seen.push(`${evt.kind}:${evt.pageIndex ?? evt.reason}`);
  if (!evt.accepted) break;
}
step('collector accepts each distinct real page once', seen.every((s) => s.startsWith('page:')), seen.join(' '));
step('collector reports completion from declared totalPages', collector.done() && evt && evt.complete === true, `progress ${JSON.stringify(collector.progress())}`);
const out = asm.result;
step('recovered payload matches the input digest', !!out && sha256Hex(out) === want, `got ${out ? out.length : 0} B · sha ${out ? sha256Hex(out).slice(0, 16) : '-'} vs ${want.slice(0, 16)}`);

/* ---- 2. holding the phone still must not look like progress ---- */
const again = await collector.addFrame(bitmaps[0]);
step('a repeated page is a duplicate, not progress', !again.accepted && again.kind === 'duplicate', `kind ${again.kind} · stats ${JSON.stringify(collector.stats)}`);

/* ---- 2b. the bare code area must still decode: a user may scan or crop just that ---- */
{
  const asmCode = new TransferAssembler({});
  const cCode = createBurstCollector({
    decode: (bmp) => bootstrapDecode(bmp, { maxAttempts: 24 }),
    feed: (page) => asmCode.feed({ levels: page.levels, header: page.headerBytes, channelMissing: page.colourAlive ? [] : ['colour'] }),
  });
  const kinds = [];
  for (const b of code) {
    const e = await cCode.addFrame(b);
    kinds.push(e.kind);
    if (!e.accepted) break;
  }
  const outCode = asmCode.result;
  step(
    'a code-area-only frame set still recovers the payload',
    kinds.every((k) => k === 'page') && !!outCode && sha256Hex(outCode) === want,
    `kinds ${kinds.join(' ')} · sha ${outCode ? sha256Hex(outCode).slice(0, 16) : '-'} vs ${want.slice(0, 16)}`,
  );
}

/* ---- 3. the gates, driven by the same signals a camera produces ---- */
const fakeDecode = async (page) => ({ ok: true, page });
const gate = async (label, page, expectKind) => {
  const c2 = createBurstCollector({ decode: fakeDecode, feed: async () => ({ ok: true }) });
  const r = await c2.addFrame(page);
  step(label, r.kind === expectKind, `got ${r.kind}${r.hint ? ` · hint: ${r.hint.slice(0, 52)}` : ''}`);
  return r;
};
// A header is needed for the identity checks; reuse the real one and mutate what the gates read.
const realBoot = await bootstrapDecode(bitmaps[0], { maxAttempts: 24 });
const hdr = realBoot.page.header || decodeHeader(realBoot.page.headerBytes).header;
const basePage = { levels: realBoot.page.levels, headerBytes: realBoot.page.headerBytes, header: hdr, colourAlive: true, path: 'photo', markerPx: 40, coverage: 0.95 };
await gate('too-far gate: small marker is refused with advice', { ...basePage, markerPx: 6 }, 'too-far');
await gate('partial gate: low coverage is refused with advice', { ...basePage, coverage: 0.4 }, 'partial');
const foreign = { ...basePage, header: { ...hdr, sessionId: new Uint8Array(8).fill(0xee) } };
const c3 = createBurstCollector({ decode: fakeDecode, feed: async () => ({ ok: true }) });
const r0 = await c3.addFrame(basePage);
const r3 = await c3.addFrame(foreign);
step('a page from another session never joins this batch', r3.kind === 'other-session', `kind ${r3.kind} · have ${c3.progress().have}/${c3.progress().total}`);
const c4 = createBurstCollector({ decode: fakeDecode, feed: async () => ({ ok: true }) });
await c4.addFrame(basePage);
const r4 = await c4.addFrame({ ...basePage, header: { ...hdr, pageIndex: 1, totalPages: 9 } });
step('declared totalPages conflict is refused, not averaged', r4.kind === 'conflict', `kind ${r4.kind}${r4.hint ? ` · ${r4.hint.slice(0, 46)}` : ''}`);
const c5 = createBurstCollector({ decode: async () => ({ ok: false, reason: 'no-geometry-matched', attempts: [] }), feed: async () => ({ ok: true }) });
const r5 = await c5.addFrame({});
step('an undecodable frame reports no-page with the decoder reason', r5.kind === 'no-page' && r5.reason === 'no-geometry-matched', `kind ${r5.kind} reason ${r5.reason}`);

/* ---- 4. a real frame a phone produces constantly: page cut off ---- */
// renderPageBitmap hands back {width,height,pixels} with four channels; `data` does not
// exist (the first draft assumed it and died here rather than in the shipped artifact).
const src = bitmaps[0];
const ch = Math.round(src.pixels.length / (src.width * src.height));
const crop = { width: Math.floor(src.width * 0.55), height: Math.floor(src.height * 0.55), dpi: src.dpi, pixels: null };
{
  const d = new Uint8Array(crop.width * crop.height * ch);
  for (let y = 0; y < crop.height; y++) {
    for (let x = 0; x < crop.width; x++) {
      const si = (y * src.width + x) * ch;
      const di = (y * crop.width + x) * ch;
      for (let c = 0; c < ch; c++) d[di + c] = src.pixels[si + c];
    }
  }
  crop.pixels = d;
}
step('crop keeps the source channel count', ch === 4, `channels ${ch} · crop ${crop.width}x${crop.height}px`);
const c6 = createBurstCollector({ decode: (bmp) => bootstrapDecode(bmp, { maxAttempts: 24 }), feed: async () => ({ ok: true }) });
const r6 = await c6.addFrame(crop);
step('a cropped page is not accepted as a page', !r6.accepted, `kind ${r6.kind} reason ${r6.reason || '-'}`);

console.log('');
console.log(failures ? `CAPTURE SMOKE: ${failures} FAILED` : `CAPTURE SMOKE: all assertions pass (stats ${JSON.stringify(collector.stats)})`);
process.exitCode = failures ? 1 : 0;
