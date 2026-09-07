/**
 * G2 corpus runner -- the measurement behind the gate, as a reproducible tool.
 *
 * `verify --gate G2` cannot produce the corpora itself: spawning Python is denied in
 * this sandbox (`spawn EPERM`), so the degradation channel runs out-of-band and this
 * tool only consumes directories that already exist on disk. That split is also the
 * honest one: a gate that generated its own channel could quietly start agreeing with
 * itself.
 *
 * The criterion is the digest, recomputed here. Not the word "received" printed by
 * some other process -- the point of G2 is that the bytes on disk are the bytes that
 * went in, so this file compares `sha256(result)` to `manifest.sourceSha256` itself
 * and calls anything else a failure.
 *
 *   node tools/g2-corpus.mjs --root .tmp --match 'nc-scan*'
 *   node tools/g2-corpus.mjs .tmp/nc-scan300-1 .tmp/nc-scan600-1 --json
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { performance } from 'node:perf_hooks';
import { decodePage } from '../core/decode/page.js';
import { decodePNG } from '../core/decode/png-read.js';
import { advise } from '../core/decode/advice.js';
import { binarize, components } from '../core/decode/fiducial.js';
import { glyphSignature, glyphSignatureDiff } from '../core/render/glyphs.js';

/**
 * Failure classification, by looking at the image -- not at the channel's report.
 *
 * Two rounds of mis-attribution ended when it was noticed that a "decoder failure" page
 * had 4.7 % ink coverage along its top edge against 100 % on a healthy page: the sheet
 * was outside the capture, so its top-left fiducial does not exist in the image. With
 * three fiducials there are six equations for an eight-degree-of-freedom homography, so
 * the receiver refuses because it cannot solve. That is the channel precondition failing,
 * not the decoder.
 *
 * This function therefore answers the physical question directly from pixels: how many
 * of the four corners actually contain a marker-sized square. It is used ONLY to label
 * the failure. It never turns a failure into a pass, and the pass/fail arithmetic above
 * is untouched -- removing these pages from the denominator would be redefining G2.
 */
const CORNERS = ['tl', 'tr', 'bl', 'br'];

function fiducialCensus(bitmap) {
  const W = bitmap.width;
  const H = bitmap.height;
  const bin = binarize(bitmap);
  const comps = components(bin);
  const squares = comps.filter((c) => {
    if (!(c.w > 8 && c.h > 8)) return false;
    const aspect = Math.abs(c.w - c.h) / Math.max(c.w, c.h);
    const fill = c.area / Math.max(1, c.w * c.h);
    return aspect < 0.15 && fill > 0.75;
  });
  if (!squares.length) {
    return { markers: 0, present: [], missing: CORNERS, sizeClass: null, edge: edgeCoverage(bin, W, H) };
  }
  // Dominant size class: fiducials are identical on the page, so the modal square side
  // is the marker. Anything else is border stubs or a glyph block.
  const bySide = new Map();
  for (const c of squares) {
    const k = Math.round(c.w / 3) * 3;
    if (!bySide.has(k)) bySide.set(k, []);
    bySide.get(k).push(c);
  }
  const cls = [...bySide.values()].sort((a, b) => b.length - a.length)[0];
  const seen = new Set();
  for (const c of cls) {
    const cx = c.x0 + c.w / 2;
    const cy = c.y0 + c.h / 2;
    seen.add(`${cy < H / 2 ? 't' : 'b'}${cx < W / 2 ? 'l' : 'r'}`);
  }
  return {
    markers: cls.length,
    sizeClass: cls[0].w,
    present: [...seen],
    missing: CORNERS.filter((k) => !seen.has(k)),
    edge: edgeCoverage(bin, W, H),
  };
}

/** Ink share in the outermost `band` px of each side: a cut border shows up here. */
function edgeCoverage(bin, W, H) {
  const band = Math.max(10, Math.round(Math.min(W, H) * 0.006));
  const acc = { top: [0, 0], bottom: [0, 0], left: [0, 0], right: [0, 0] };
  for (let y = 0; y < H; y += 3) {
    for (let x = 0; x < W; x += 3) {
      const on = !!bin.mask[y * W + x];
      if (y < band) acc.top[on ? 0 : 1]++;
      if (y >= H - band) acc.bottom[on ? 0 : 1]++;
      if (x < band) acc.left[on ? 0 : 1]++;
      if (x >= W - band) acc.right[on ? 0 : 1]++;
    }
  }
  const pct = ([a, b]) => (a + b ? Math.round((100 * a) / (a + b)) : 0);
  return { top: pct(acc.top), bottom: pct(acc.bottom), left: pct(acc.left), right: pct(acc.right) };
}

/** A marker-stage refusal plus a corner missing from the image is a channel precondition failure. */
const MARKER_STAGES = new Set(['markers', 'fiducial', 'quad']);

function classifyFailure(bitmap, stage, reason) {
  const markerish = MARKER_STAGES.has(stage) || /square|corner|quad|marker/i.test(String(reason));
  if (!markerish) return null;
  let census;
  try {
    census = fiducialCensus(bitmap);
  } catch {
    return null;
  }
  if (!census.missing.length) return null;
  return {
    kind: 'fiducial-out-of-frame',
    detail: `${census.missing.length} of 4 corners carry no marker in the image (missing ${census.missing.join('+')}, ` +
      `size class ${census.sizeClass}px, ${census.markers} candidates, edges T${census.edge.top}/B${census.edge.bottom}/L${census.edge.left}/R${census.edge.right}% ink) ` +
      `-- 3 corners give 6 equations for an 8-DOF homography, so refusing is correct`,
  };
}


function parse(argv) {
  const out = { dirs: [], root: null, match: '*', photo: true, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') out.root = argv[++i];
    else if (a === '--match') out.match = argv[++i];
    else if (a === '--fast') out.photo = false;
    else if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else out.dirs.push(a);
  }
  return out;
}

/** A directory counts as a corpus only if it holds a manifest and at least one PNG. */
function looksLikeCorpus(dir) {
  try {
    if (!existsSync(join(dir, 'manifest.json'))) return false;
    return readdirSync(dir).some((n) => /\.png$/i.test(n));
  } catch {
    return false;
  }
}

function globToRe(glob) {
  return new RegExp(`^${String(glob).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
}

function collect(opts) {
  const found = [...opts.dirs];
  if (opts.root) {
    const re = globToRe(opts.match);
    for (const name of readdirSync(opts.root).sort()) {
      if (!re.test(name)) continue;
      const p = join(opts.root, name);
      try {
        if (statSync(p).isDirectory() && looksLikeCorpus(p)) found.push(p);
      } catch {
        /* unreadable entry: not a corpus */
      }
    }
  }
  return found.filter(looksLikeCorpus);
}

/** One corpus directory -> one verdict. Mirrors `pskit receive`, minus the printing. */
async function runCorpus(dir, mod) {
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  const profileId = manifest.profile;
  const nozzle = manifest.nozzle;
  const dpi = manifest.dpi || 300;
  const paletteId = manifest.palette || 'INK2';
  if (!profileId) return { dir: basename(dir), ok: false, reason: 'manifest has no profile' };
  // planPage returns the geometry itself and throws on a bad profile/nozzle -- it is
  // not a {ok,reason} result, so `if (!geom.ok)` here would reject every valid page
  // (which is exactly what it did, reporting 0/16 in 0.0 s).
  let geom;
  try {
    geom = mod.profiles.planPage(profileId, { nozzle, plateMm: manifest.plateMm, monoSafe: manifest.monoSafe });
  } catch (e) {
    return { dir: basename(dir), ok: false, reason: `planPage threw: ${e.message}` };
  }
  const layout = mod.layoutMod.pageLayout(geom, dpi, { plateMm: manifest.plateMm });
  // The page is self-describing, and the manifest carries the signature of the shapes
  // it was rendered with. If they disagree the samples are not what the receiver thinks
  // they are, and reading them anyway would be the exact "looks like success" failure.
  if (manifest.glyph) {
    const diff = glyphSignatureDiff(glyphSignature(layout.glyph), manifest.glyph);
    if (diff.length) return { dir: basename(dir), ok: false, reason: `glyph signature: ${diff.join('; ')}` };
  }

  const names = readdirSync(dir).filter((n) => /\.png$/i.test(n)).sort();
  const asm = new mod.protocol.TransferAssembler({ passphrase: manifest.passphraseHint || undefined });
  const opts = { allowFastPath: !mod.photo, requireFastPath: false, log: null };
  const failures = [];
  const pageClasses = [];
  for (const name of names) {
    let bitmap;
    try {
      bitmap = decodePNG(new Uint8Array(readFileSync(join(dir, name))));
    } catch (e) {
      failures.push(`${name}: png (${e.message})`);
      continue;
    }
    bitmap.substrate = bitmap.substrate || mod.palette.getPalette(paletteId).background;
    const r = decodePage(bitmap, { geom, layout, paletteId }, opts);
    if (!r.ok) {
      // Same failure, but labelled with what the pixels say about it. Annotation only:
      // this cannot and does not make the page pass.
      const cls = classifyFailure(bitmap, r.stage, r.reason);
      failures.push(`${name}: ${r.stage}/${r.reason}${cls ? `  [${cls.kind}] ${cls.detail}` : ''}`);
      if (cls) (r.classes ||= []).push(cls.kind);
      (pageClasses ||= []).push(cls ? cls.kind : `decoder/${r.reason}`);
      continue;
    }
    const fed = await asm.feed({ levels: r.levels, header: r.headerBytes, channelMissing: r.colourAlive ? [] : ['colour'] });
    if (!fed.ok && !fed.duplicate) {
      failures.push(`${name}: assemble/${fed.reason}`);
      // The assemble stage fails for its own reasons (intra/inter RS budget exceeded),
      // and those pages were silently missing from the census until this line existed.
      pageClasses.push(`assemble/${fed.reason}`);
    } else if (fed.duplicate) {
      pageClasses.push('assemble/duplicate-ok');
    }
  }
  if (!asm.result) {
    const p = asm.progress;
    return {
      dir: basename(dir),
      ok: false,
      reason: p.noSession ? 'no-page-header' : `short ${p.dataHave ?? '?'}/${p.dataNeed ?? '?'}`,
      failures,
      pageClasses,
    };
  }
  const got = mod.hash.sha256Hex(asm.result);
  const want = manifest.sourceSha256;
  const bytes = asm.result.length;
  if (!want) return { dir: basename(dir), ok: false, bytes, reason: 'manifest has no sourceSha256 to verify against', failures, pageClasses };
  if (want !== got) {
    // The one outcome that must never be reported as anything but a hard failure.
    return { dir: basename(dir), ok: false, bytes, reason: `DIGEST MISMATCH got ${got.slice(0, 16)} want ${want.slice(0, 16)}`, failures, pageClasses };
  }
  return { dir: basename(dir), ok: true, bytes, sha: got, failures, pageClasses };
}

const opts = parse(process.argv.slice(2));
if (opts.help) {
  console.log('usage: node tools/g2-corpus.mjs [--root DIR --match GLOB] [dir...] [--fast] [--json]');
  process.exit(0);
}
const mod = {
  profiles: await import('../core/profiles.js'),
  protocol: await import('../core/protocol.js'),
  layoutMod: await import('../core/render/layout.js'),
  palette: await import('../core/palette.js'),
  hash: await import('../core/hash.js'),
  photo: opts.photo,
};
const dirs = collect(opts);
if (!dirs.length) {
  console.error('g2-corpus: no corpus directories found (need manifest.json + at least one .png)');
  console.error('  generate one with: python sim/channel.py --in SRC --out DST --seed N --preset scan300 --modifier nocrop');
  process.exit(2);
}
const results = [];
const t0 = performance.now();
for (const d of dirs) {
  const r = await runCorpus(d, mod);
  results.push(r);
  if (!opts.json) {
    const tail = r.ok ? `${r.bytes} bytes, digest verified` : `FAILED (${r.reason})`;
    console.log(`${r.dir.padEnd(22)} ${r.ok ? 'OK  ' : 'FAIL'}  ${tail}`);
    for (const f of r.failures || []) console.log(`       - ${f}`);
  }
}
const passed = results.filter((r) => r.ok).length;
const aggregate = { runs: results.length, passed, rate: passed / results.length, seconds: (performance.now() - t0) / 1000, results };
if (opts.json) writeFileSync(join(process.cwd(), '.tmp', 'g2-corpus.json'), JSON.stringify(aggregate, null, 2));
console.log(`G2 corpus: ${passed}/${results.length} byte-exact (${(100 * aggregate.rate).toFixed(1)}%) in ${aggregate.seconds.toFixed(1)}s`);
if (passed !== results.length) {
  // G2's criterion is 100%: anything else is a failing run, not a partial score.
  const reasons = {};
  for (const r of results) if (!r.ok) reasons[r.reason.replace(/got \S+ want \S+/, 'digest differs')] = (reasons[r.reason.replace(/got \S+ want \S+/, 'digest differs')] || 0) + 1;
  console.log(`  failure classes: ${Object.entries(reasons).map(([k, v]) => `${k} x${v}`).join(', ')}`);
  // Page-level classification from the pixels. Reported so the number can be read
  // honestly; it does not enter the arithmetic above.
  const byPage = {};
  for (const r of results) for (const c of r.pageClasses || []) byPage[c] = (byPage[c] || 0) + 1;
  const entries = Object.entries(byPage);
  if (entries.length) {
    console.log(`  page failure kinds (annotation only, still counted as failures):`);
    for (const [k, v] of entries.sort((a, b) => b[1] - a[1])) console.log(`       ${String(v).padStart(3)} x ${k}`);
    const outOfFrame = byPage['fiducial-out-of-frame'] || 0;
    if (outOfFrame) {
      console.log(`     -> ${outOfFrame} page(s) had a fiducial outside the capture: unrecoverable by`);
      console.log(`        construction (a homography needs 4 point pairs), and a real flatbed can`);
        console.log(`        produce it when the sheet is nearly as wide as the platen and rotated.`);
      console.log(`        G2's stated criterion does not yet name that precondition -- see ACCEPTANCE G2.`);
    }
  }
  process.exit(1);
}
