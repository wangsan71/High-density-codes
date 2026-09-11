#!/usr/bin/env node
/**
 * G9 -- the web/Pages gate, checked against the built artifact in web/dist.
 *
 * PLAN's G9 asks for five things; each is asserted against the artifact instead of being
 * asserted in prose:
 *
 *   1. zero third-party origin in what the page *loads* (src=, href=, import(), fetch(),
 *      @import). Scoped to loads deliberately: unanchored text scans in this repository
 *      have already fired on `URL.createObjectURL` and on a doc comment containing the
 *      words "from 'an image'". A guard that cries wolf trains the next reader to ignore
 *      it when it is right.
 *   2. CSP `default-src 'self'` on both the site page and the single-file page.
 *   3. the service-worker precache manifest hashes equal the bytes on disk, and every
 *      built file except sw.js / build-manifest.json is listed ("SW 清单哈希与产物一致").
 *   4. `?selftest=1` green -- executed from web/dist/selftest.js here, the same module body
 *      the page imports, because there is no browser on this machine and an unexecuted
 *      browser-only green is precisely the claim this project refuses. An all-skipped run
 *      is not a pass.
 *   5. the single-file build references nothing but data: URIs.
 *
 * Then the check that matters most without a browser: the shipped bundle must decode page
 * images that already exist on disk, identify their geometry with no hints, and reproduce
 * the digest recorded in their own manifest.
 *
 *   node tools/build-web.mjs && node tools/check-dist.mjs [--pages .tmp/g2src]
 */
import { readFileSync, readdirSync, existsSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'web', 'dist');
const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const pagesDir = opt('--pages', '.tmp/g2src');

const results = [];
const record = (name, ok, detail) => results.push({ name, ok, detail: String(detail ?? '') });
const check = (name, fn) => {
  try {
    record(name, true, fn());
  } catch (e) {
    record(name, false, e.message);
  }
};

if (!existsSync(DIST)) {
  console.error('web/dist missing -- run: node tools/build-web.mjs');
  process.exit(2);
}
const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
const files = walk(DIST);
const text = (f) => readFileSync(f, 'utf8');
// Dist-relative URL of a built file. Substring-replacing 'web/dist/' was wrong: the
// session path itself contains that text, so keys came out as `.../things/./app.css` and
// every hash compare missed.
const rel = (f) => './' + f.slice(DIST.length + 1).split('\\').join('/');

const LOAD_PATTERNS = [
  [/\bsrc\s*=\s*["'](https?:)?\/\/[^"']*/i, 'external src='],
  [/\bhref\s*=\s*["'](https?:)?\/\/(?!data:)[^"']*/i, 'external href='],
  [/(?:^|[^.\w$])(?:import|fetch)\s*\(\s*["'](https?:)?\/\//im, 'external import()/fetch()'],
  [/@import\s+(?:url\()?["']?(https?:)?\/\//i, 'external @import'],
];

check('no third-party load site (src/href/import/fetch/@import)', () => {
  const hits = [];
  for (const f of files) {
    const s = text(f);
    for (const [re, label] of LOAD_PATTERNS) {
      const m = s.match(re);
      if (m) hits.push(`${rel(f)}: ${label} -> ${m[0].slice(0, 60)}`);
    }
  }
  if (hits.length) throw new Error(hits.join(' | '));
  return `${files.length} built files scanned for load sites`;
});

check('inline CSS has no external url()/@import', () => {
  let n = 0;
  for (const f of files.filter((x) => /\.html$/i.test(x))) {
    for (const block of text(f).match(/<style>[\s\S]*?<\/style>/gi) || []) {
      if (/@import|url\(\s*["']?(?!data:)/i.test(block)) throw new Error(`${rel(f)} inline CSS references something external`);
      n++;
    }
  }
  return `${n} inline style block(s)`;
});

check('CSP default-src self on both pages', () => {
  const need = ['index.html', 'pskt-file.html'];
  for (const n of need) {
    const p = join(DIST, n);
    if (!existsSync(p)) throw new Error(`missing ${n}`);
    const s = text(p);
    if (!/http-equiv=["']Content-Security-Policy["']/i.test(s)) throw new Error(`${n}: no CSP meta`);
    if (!/default-src\s+'self'/.test(s)) throw new Error(`${n}: CSP lacks default-src self`);
  }
  return need.join(', ');
});

check('every built JavaScript file parses', () => {
  // Round 249: I typed a comma where a semicolon belonged in web/capture.js. Nothing caught it. The unit
  // suite never imports capture.js; tools/build-web.mjs stitches source text without parsing it; and
  // capture.js is in neither single-file page, so the assertion below (inline scripts parse) never saw it.
  // The usability smoke eventually caught it, indirectly and late -- a broken served page should fail here,
  // where the artifact is the subject. `node --check` is the parser the runtime itself uses, and a
  // spawnSync with stdio 'ignore' is the one spawn shape this sandbox allows (AGENTS section 5.1).
  //
  // Positive control: run against the tree while capture.js carried the comma and this fails naming it.
  const files = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) files.push(p);
    }
  };
  walk(DIST);
  if (!files.length) throw new Error('no built JavaScript found -- the walk found nothing to check');
  for (const f of files) {
    const r = spawnSync(process.execPath, ['--check', f], { stdio: 'ignore' });
    if (r.status !== 0) throw new Error(`${f.slice(DIST.length + 1)}: does not parse (node --check exit ${r.status})`);
  }
  return `${files.length} file(s) parsed`;
});

check('no served page carries an inline script its own CSP forbids', () => {
  // Found in round 249 with a real browser (the DSH browser plugin): the served receiver page's ONLY
  // inline script was the `?selftest=1` loader, and that page's CSP is `script-src 'self'` -- which does
  // not permit inline script. The browser blocked it silently, so the documented self-test entry never
  // ran, and nothing here noticed: the CSP assertion checked that a CSP exists, not that the page's own
  // scripts are allowed by it (DEFECTS D89). tools/build-web.mjs already had this exact guard, but only
  // for the single-file builds it rewrites -- the served pages were never checked.
  //
  // Positive control: run against the tree before the fix and this assertion fails, naming the 95-char
  // loader. That is how it was shown to bite rather than assumed to.
  const names = ['index.html', 'send.html'];
  let inline = 0;
  for (const n of names) {
    const p = join(DIST, n);
    if (!existsSync(p)) continue;
    const s = text(p);
    const csp = (s.match(/http-equiv=["']Content-Security-Policy["'][^>]*content=["']([^"']*)["']/i) || [])[1] || '';
    const allowsInline = /script-src[^;]*'unsafe-inline'/.test(csp);
    const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = re.exec(s))) {
      inline++;
      if (!allowsInline) {
        throw new Error(`${n}: an inline <script> (${m[1].trim().length} chars) is not permitted by its own CSP -- the browser will block it without a word`);
      }
    }
  }
  return inline === 0 ? 'no inline script in the served pages' : `${inline} inline script(s), each permitted by its own CSP`;
});

check('SW precache manifest hashes match the artifacts on disk', () => {
  const sw = text(join(DIST, 'sw.js'));
  if (sw.includes('__PSKT_')) throw new Error('sw.js still has build placeholders');
  const m = sw.match(/const MANIFEST = (\{[\s\S]*?\});/);
  if (!m) throw new Error('could not find MANIFEST in sw.js');
  const man = JSON.parse(m[1]);
  if (!Array.isArray(man.entries) || !man.entries.length) throw new Error('manifest has no entries');
  const byName = new Map(man.entries.map((e) => [e.url, e.sha256]));
  const missing = [];
  for (const f of files) {
    const r = rel(f);
    if (r === './sw.js' || r === './build-manifest.json') continue;
    if (!byName.has(r)) {
      missing.push(r);
      continue;
    }
    const got = createHash('sha256').update(readFileSync(f)).digest('hex');
    if (got !== byName.get(r)) throw new Error(`${r}: manifest ${byName.get(r).slice(0, 12)} vs bytes ${got.slice(0, 12)}`);
  }
  if (missing.length) throw new Error(`built but not precached: ${missing.join(', ')}`);
  // Tightness both ways. The build used to write some modules twice (import closure and the
  // whole-core copy overlap), which padded the manifest with duplicate urls -- harmless at
  // run time, but it made "78 entries verified" describe 49 artifacts, and a reported
  // number that does not match the thing on disk is the failure mode this project exists to
  // avoid, even when it is only a count.
  if (man.entries.length !== byName.size) {
    throw new Error(`precache list has duplicates: ${man.entries.length} entries but ${byName.size} distinct urls`);
  }
  const onDisk = files.filter((f) => rel(f) !== './sw.js' && rel(f) !== './build-manifest.json').length;
  if (byName.size !== onDisk) throw new Error(`manifest covers ${byName.size} urls, ${onDisk} artifacts exist on disk`);
  return `${man.entries.length} entries verified against bytes on disk, build ${man.buildId}`;
});

check('every inline script in a single-file page parses as JavaScript', () => {
  // A single-file artifact lives or dies on one thing: the code inlined into it must still
  // be valid JavaScript the browser can parse when the user double-clicks the file. Cutting
  // the bundle in at build time, or a replacement that matched the wrong span, produces a
  // page that looks complete on disk and never runs -- and nothing else here would notice,
  // because the other assertions read markup, not the script body. Whether a browser also
  // enforces this page's CSP under file:// cannot be checked here (docs/DEFECTS.md D18);
  // that it parses can be, so it is verified rather than assumed.
  const names = ['pskt-file.html', 'pskt-send-file.html'];
  let blocks = 0;
  for (const n of names) {
    const s = text(join(DIST, n));
    const inline = [...s.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
    if (!inline.length) throw new Error(`${n}: no inline script found -- the bundle was not inlined`);
    for (const body of inline) {
      // new Function parses without executing: nothing here can reach the network or disk.
      try {
        new Function(body);
      } catch (e) {
        throw new Error(`${n}: inline script does not parse (${e.message})`);
      }
      blocks++;
    }
  }
  return `${blocks} inline script blocks parsed`;
});

check('pskt-file.html references nothing but data:', () => {
  const s = text(join(DIST, 'pskt-file.html'));
  const refs = [...s.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]).filter((v) => !v.startsWith('data:'));
  if (refs.length) throw new Error(`external references: ${refs.join(', ')}`);
  if (!/globalThis.__PSKT__/.test(s)) throw new Error('bundle was not inlined');
  if (/PSKT-SELFTEST-LOADER/.test(s)) throw new Error('selftest loader survived into the single file');
  return `${(Buffer.byteLength(s) / 1024).toFixed(1)} KiB, 0 external references`;
});

check('every markup reference in a built page resolves to a built file', () => {
  // This is the check that was missing when the build emitted ./web/app.js while
  // index.html asked for ./app.js: a site that 404s its own entry script, built by a
  // build that reported success.
  const onDisk = new Set(files.map(rel));
  const broken = [];
  for (const f of files.filter((x) => /\.html$/i.test(x))) {
    for (const m of text(f).matchAll(/(?:src|href)\s*=\s*["']([^"'#?]+)["']/gi)) {
      const ref = m[1];
      if (ref.startsWith('data:') || ref.startsWith('http')) continue;
      const url = ref.startsWith('.') ? './' + ref.replace(/^\.\//, '') : './' + ref;
      if (!onDisk.has(url)) broken.push(`${rel(f)} -> ${url}`);
    }
  }
  if (broken.length) throw new Error(`references with no matching file: ${broken.join(', ')}`);
  return `${onDisk.size} built paths, all page references resolve`;
});

check('the PWA manifest declares a square icon', () => {
  // Keep-side pairing for D13: build-web.mjs already refuses to write a non-square icon (it
  // reads IHDR out of the bytes it just encoded and takes the declared size from that same
  // reading, so the manifest cannot describe a different image than the file). This check
  // covers the other direction -- that nobody later replaces the icon with an A4-shaped one
  // and updates the manifest to match, which would both install crooked and stay green here.
  const m = JSON.parse(text(join(DIST, 'manifest.webmanifest')));
  const sizes = (m.icons || []).map((i) => String(i.sizes || ''));
  if (!sizes.length) throw new Error('manifest declares no icons');
  // "Declares icons" is not the same as "a browser will offer to install it": installability wants
  // 192x192 and 512x512, and before D43 was fixed this check passed on a manifest whose only icon
  // was the 3290x3290 page render. Assert the sizes, and the maskable variant, so the property
  // cannot quietly rot back out of the build.
  for (const want of ['192x192', '512x512']) {
    if (!sizes.includes(want)) throw new Error(`manifest icons lack ${want} (declared: ${sizes.join(', ') || 'none'}) -- a browser will not offer install`);
  }
  if (!(m.icons || []).some((i) => String(i.purpose || '').split(/\s+/).includes('maskable'))) {
    throw new Error('manifest declares no maskable icon -- an adaptive launcher would crop the corners, which are the fiducials');
  }
  const bad = sizes.filter((s) => {
    const mm = /^(\d+)x(\d+)$/.exec(s);
    return !mm || mm[1] !== mm[2];
  });
  if (bad.length) throw new Error(`non-square icon sizes: ${bad.join(', ')}`);
  return sizes.join(', ');
});

check('the served index.html keeps its link to the sender', () => {
  // Pairing for build-web's single-file strip rule, which deletes <p class="nav"> from the
  // inlined page. Without this, that same class-name regex could delete the link from the
  // SERVED page too -- or a future edit could drop the link entirely -- and every other
  // assertion would still pass, because they only check that references which remain
  // resolve, never that a required reference is present.
  const s = text('web/dist/index.html');
  if (!/href="\.\/send\.html"/.test(s)) throw new Error('nav link to send.html missing from served index.html');
  const single = text('web/dist/pskt-file.html');
  if (/href="\.\/send\.html"/.test(single)) throw new Error('single file still links out to a sibling page');
  return 'site has the link, single file does not';
});

check('every getElementById in built JS exists in some built page', () => {
  // web/*.js attaches behaviour behind `if (document.getElementById('burst'))` guards, so
  // a renamed or deleted markup id makes the feature quietly absent while every other
  // assertion stays green. That is the definition of a silent failure: check the pair.
  const htmlIds = new Set();
  for (const f of files.filter((x) => /\.html$/i.test(x))) {
    for (const m of text(f).matchAll(/\bid\s*=\s*["']([^"']+)["']/gi)) htmlIds.add(m[1]);
  }
  const wanted = new Map();
  for (const f of files.filter((x) => /\.js$/i.test(x))) {
    for (const m of text(f).matchAll(/getElementById\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      if (!htmlIds.has(m[1])) wanted.set(m[1], f);
    }
  }
  if (wanted.size) throw new Error(`ids referenced but never declared: ${[...wanted].map(([k, v]) => `${k} (${rel(v)})`).join(', ')}`);
  return `${htmlIds.size} markup ids, every JS getElementById resolves`;
});

check('no built page declares the same id twice', () => {
  // The sibling of the check above, and the one that was missing: existence is not uniqueness.
  // index.html declared id="video" twice -- the single-shot camera element in section 1 and the
  // burst preview in the last section -- so capture.js's getElementById('video') silently returned
  // the FIRST one in document order, the hidden single-shot element. The burst preview stayed black
  // and frames were read from a display:none video, which is browser-dependent and not something
  // iOS Safari can be relied on to decode (DEFECTS D57). Every other assertion stayed green and so
  // did the unit suite; the only way to see it was to run the phone path on a phone, which is
  // precisely the evidence this project cannot produce in process. So it is checked here, per page,
  // at build time, where it costs nothing.
  const htmlFiles = files.filter((x) => /\.html$/i.test(x));
  const dupes = [];
  for (const f of htmlFiles) {
    const seen = new Map();
    for (const m of text(f).matchAll(/\bid\s*=\s*["']([^"']+)["']/gi)) seen.set(m[1], (seen.get(m[1]) || 0) + 1);
    for (const [id, n] of seen) if (n > 1) dupes.push(`${rel(f)}: ${id} x${n}`);
  }
  if (dupes.length) throw new Error(`duplicate ids, so getElementById returns the first and the rest are dead: ${dupes.join(', ')}`);
  return `every id unique within its own page, across ${htmlFiles.length} built page(s)`;
});

// Async checks are wrapped in IIFEs. A bare `return` inside a top-level block is a
// SyntaxError -- that is how the first version of this file died, and it died loudly,
// which is the correct behaviour for a checker.
await (async () => {
  const name = 'dist selftest green (executed here, not claimed for a browser)';
  try {
    const mod = await import(pathToFileURL(join(DIST, 'selftest.js')).href);
    const res = await mod.runSelfTests({
      loadConformance: async () => JSON.parse(readFileSync(join(DIST, 'conformance.json'), 'utf8')),
    });
    const fails = res.filter((x) => x.status === 'fail');
    const passes = res.filter((x) => x.status === 'pass');
    const skipped = res.filter((x) => x.status === 'skipped');
    if (!passes.length) throw new Error('nothing executed -- an all-skipped selftest is not a pass');
    if (fails.length) throw new Error(fails.map((f) => `${f.name}: ${f.detail}`).join(' | '));
    record(name, true, `${passes.length} pass / ${skipped.length} skipped${skipped.length ? ' (asset NOT loaded)' : ' (conformance asset loaded)'} / 0 fail`);
  } catch (e) {
    record(name, false, e.message);
  }
})();

await (async () => {
  const name = 'bundle decodes on-disk pages unhinted, digest matches manifest';
  try {
    const dir = join(ROOT, pagesDir);
    // The fixture is this check's own input, so a fresh clone must not fail just because nobody
    // happens to have .tmp/g2src on disk. Round 64 walked docs/USE.md §0 from a checkout of the
    // tracked files only: build-web exited 0, this assertion exited 1 with "has no manifest.json",
    // and the manual tells the user to judge the build by its exit code -- so every new user was
    // being told their build was broken. Generating the pages in-process keeps the assertion
    // load-bearing; skipping it would gut the only check that the shipped bundle reads real PNGs off
    // disk, and this file's own header says an all-skipped run is not a pass.
    let generated = false;
    if (!existsSync(join(dir, 'manifest.json'))) {
      // Made with core, not with the bundle: the fixture is the INPUT to the claim, and letting the
      // artifact under test manufacture its own input would make the check self-referential. If core
      // and the bundle ever disagree, this assertion is exactly where that shows up.
      const { encodeTransfer } = await import('../core/protocol.js');
      const { pageLayout } = await import('../core/render/layout.js');
      const { renderPageBitmap, renderSheetBitmap, echoBitsOf } = await import('../core/render/raster.js');
      const { encodePNG } = await import('../core/render/png.js');
      const { sha256Hex: hexOf } = await import('../core/hash.js');
      const payload = new Uint8Array(20480);
      // Deterministic filler: a check must not depend on Math.random, or its verdict is not repeatable.
      for (let i = 0; i < payload.length; i++) payload[i] = (Math.imul(i + 1, 2654435761) >>> 13) & 255;
      const t = await encodeTransfer(payload, { profile: 'P-M1-300' });
      const layout = pageLayout(t.geom, 300);
      mkdirSync(dir, { recursive: true });
      t.pages.forEach((p, i) => {
        const code = renderPageBitmap({ geom: t.geom, levels: p.levels, layout, palette: 'PAPER1', echoBits: echoBitsOf(p.header) });
        const bmp = code.sheetMm ? renderSheetBitmap(code) : code; // the whole sheet, like a printed page
        writeFileSync(join(dir, `page-${String(i).padStart(3, '0')}.png`), Buffer.from(encodePNG(bmp)));
      });
      const manifest = {
        sourceSha256: hexOf(payload),
        profile: 'P-M1-300',
        dpi: 300,
        palette: 'PAPER1',
        pages: t.pages.length,
        generatedBy: 'tools/check-dist.mjs (the fixture was missing, so this run made it)',
      };
      writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
      generated = true;
    }
    const pngs = readdirSync(dir).filter((f) => /\.png$/i.test(f)).sort();
    if (!pngs.length) throw new Error(`no PNGs in ${pagesDir}`);
    const mf = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    const src = text(join(DIST, 'pskt-bundle.js'));
    // Evaluate the shipped artifact as a <script> would and use only what it exposes, so
    // a green run cannot be produced by importing core modules directly behind the bundle.
    const { R } = new Function(`${src}\n;return globalThis.__PSKT__;`)();
    const { decodePNG } = R('core/decode/png-read.js');
    const { bootstrapDecode } = R('core/decode/bootstrap.js');
    const { TransferAssembler } = R('core/protocol.js');
    const { sha256Hex } = R('core/hash.js');
    // Taken from the bundle for the same reason: this is the feed the desktop page, the phone burst
    // path and the G2 harness have all used since round 63 (DEFECTS D51). Calling asm.feed directly
    // here would leave this check measuring a cousin of the product -- it was the seventh call site,
    // and the one round 63 missed. Asking the bundle for it also proves the artifact contains it.
    const { feedPageWithRecalibration } = R('core/decode/recalibrate.js');
    const asm = new TransferAssembler({});
    const geoms = new Set();
    let attempts = 0;
    for (const f of pngs) {
      const bmp = decodePNG(new Uint8Array(readFileSync(join(dir, f))));
      const boot = await bootstrapDecode(bmp, { maxAttempts: 24 });
      if (!boot.ok) throw new Error(`${f}: ${boot.reason} after ${boot.attempts.length} candidate(s)`);
      geoms.add(`${boot.profileId}@${boot.dpi}/${boot.paletteId}`);
      attempts += boot.attemptCount;
      const resc = await feedPageWithRecalibration(asm, boot.page, { geom: boot.geom });
      const fed = resc.fed;
      if (!fed.ok && !fed.duplicate) throw new Error(`${f}: assembler rejected (${fed.reason})`);
    }
    const res = asm.result;
    if (!res) throw new Error(`assembler produced nothing: ${asm.error || JSON.stringify(asm.progress)}`);
    const hex = sha256Hex(res);
    if (hex !== mf.sourceSha256) throw new Error(`digest ${hex.slice(0, 16)} != manifest ${String(mf.sourceSha256).slice(0, 16)}`);
    record(name, true, `${pngs.length} page(s), ${attempts} candidate tries, geometry self-identified as ${[...geoms].join(' ')}, ${res.length} B, digest matches ${pagesDir}/manifest.json${generated ? ' [fixture generated in-process this run: a fresh clone has no .tmp]' : ''}`);
  } catch (e) {
    record(name, false, e.message);
  }
})();

let bad = 0;
for (const r of results) {
  if (!r.ok) bad++;
  console.log(`${r.ok ? ' PASS' : ' FAIL'}  ${r.name}`);
  console.log(`          ${r.detail}`);
}
console.log('');
console.log(bad ? `G9 CHECK: ${bad} of ${results.length} FAILED` : `G9 CHECK: all ${results.length} assertions pass`);
if (!results.length) {
  console.log('  (no checks ran -- that is not a pass)');
  process.exitCode = 1;
} else {
  process.exitCode = bad ? 1 : 0;
}
