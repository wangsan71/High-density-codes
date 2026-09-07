#!/usr/bin/env node
/**
 * pskit -- print-scan keying toolkit (PSKT-1)
 *
 * Everything here is Node-side glue: argument parsing, files, the gate runners.
 * The protocol itself lives in core/ and is browser-compatible, so `pskit send`
 * output and the web receiver cannot drift apart.
 *
 * Gate runners execute **in-process** on purpose: this sandbox forbids child
 * processes with piped stdio (spawn EPERM), and a verification suite that cannot
 * run is worse than no suite at all.
 */
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, statSync, renameSync, rmSync } from 'node:fs';
import { join, dirname, resolve, basename, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const HELP = `pskit <command> [options]

  send <file>            encode a file into printable pages
    --profile <id>       P-M1-300 P-M1-600 P-M2-600 P-C4-600 PL-M1 PL-D2 PL-D3 PL-D3S PL-G REL-H1
    --nozzle <0.2|0.4|0.6|0.8>   plate profiles only (default 0.4)
    --monoSafe <full|partial|off>  colour-loss protection vs capacity (default per profile)
    --dpi <n>            raster resolution (plate default 300, paper uses the profile dpi)
    --plate <mm>         printable plate edge (default 200)
    --sheet <A4|Letter>  paper profiles only
    --parity <pct>       inter-page parity percentage (default per profile)
    --passphrase <pw>    ChaCha20 encrypt the payload (PBKDF2-SHA256, 150k iters)
    --format <png|tiff|pdf|both|all>   default png
                         pdf = one pack.pdf carrying every page at true physical
                         size (what you actually send to a printer)
    --mono               render as a single-colour print (proves the G7 fallback)
    --palette <id>       INK2 INK4 PAPER1 (default chosen by profile)
    --out <dir>          output directory (default artifacts/<name>)
    --dry-run            plan and report only, write nothing

  receive <dir|file>     decode page images back to the payload
    --photo              force the camera path: detect markers, undo the
                         perspective, then read (works on scans and prints)
    --out <file>         where to write the recovered payload
    --passphrase <pw>    decrypt a --passphrase transfer
    --profile/--nozzle/--dpi/--palette/--plate
                         required only when there is no manifest.json

  status                 profile / nozzle capacity table
  verify --gate <G>      run an acceptance gate in-process (G0 G1 G3 G5 G7 all)
    --seeds <n>          G1/G3/G7 repetitions (default per gate)
    --trials <n>         G5 tamper count (default 10000)
  roundtrip --selftest   encode+decode a synthetic payload, print timings
`;

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else {
        out[key] = next;
        i++;
      }
    } else out._.push(a);
  }
  return out;
}

async function load() {
  const [profiles, protocol, raster, layoutMod, png, tiff, nozzles, palette, hash, frame] = await Promise.all([
    import('../core/profiles.js'),
    import('../core/protocol.js'),
    import('../core/render/raster.js'),
    import('../core/render/layout.js'),
    import('../core/render/png.js'),
    import('../core/render/tiff.js'),
    import('../core/nozzles.js'),
    import('../core/palette.js'),
    import('../core/hash.js'),
    import('../core/frame.js'),
  ]);
  return { profiles, protocol, raster, layoutMod, png, tiff, nozzles, palette, hash, frame };
}

function defaultProfileFor(ext) {
  return 'PL-D2';
}

function pickPalette(mod, profileId, explicit) {
  if (explicit) return explicit;
  const p = mod.profiles.PROFILES[profileId];
  if (p.medium === 'paper') return p.channels.some((c) => c.name === 'colour') ? 'INK4' : 'PAPER1';
  const colour = p.channels.find((c) => c.name === 'colour');
  return colour && colour.levels > 2 ? 'INK4' : colour ? 'INK2' : 'PAPER1';
}

async function cmdSend(args) {
  const mod = await load();
  const input = args._[0];
  if (!input) throw new Error('send: need an input file (see --help)');
  const file = resolve(input);
  if (!existsSync(file)) throw new Error(`send: no such file: ${file}`);
  const raw = new Uint8Array(readFileSync(file));
  const profileId = args.profile || defaultProfileFor(extname(file));
  const nozzle = args.nozzle || (mod.profiles.PROFILES[profileId].medium === 'plate' ? '0.4' : undefined);
  const paletteId = pickPalette(mod, profileId, args.palette);
  const dpi = args.dpi ? Number(args.dpi) : mod.profiles.PROFILES[profileId].medium === 'paper' ? mod.profiles.PROFILES[profileId].dpi : 300;

  const geom = mod.profiles.planPage(profileId, {
    nozzle,
    plateMm: args.plate ? Number(args.plate) : undefined,
    sheet: args.sheet,
    parityPct: args.parity ? Number(args.parity) : undefined,
    monoSafe: args.monoSafe,
  });
  const plan = mod.profiles.planTransfer(profileId, { nozzle, plateMm: args.plate ? Number(args.plate) : undefined, sheet: args.sheet, parityPct: args.parity ? Number(args.parity) : undefined, monoSafe: args.monoSafe }, raw.length);

  console.log(`pskit send  ${basename(file)} (${raw.length} bytes)`);
  console.log(`  profile   ${profileId}${nozzle ? ` @ ${nozzle}mm nozzle` : ''}  palette ${paletteId}${args.mono ? '  [mono render]' : ''}`);
  console.log(`  page      ${geom.cols}x${geom.rows} cells @ ${geom.pitchMm}mm = ${geom.totalCells} cells, ${geom.bitsPerCell} bit/cell`);
  console.log(`  ECC       intra ${geom.ecc.mode} k=${geom.ecc.intra.k}+${geom.ecc.intra.nsym} x${geom.ecc.intra.blocks}  monoSafe=${geom.ecc.monoSafe}`);
  // planTransfer works on the uncompressed size, which is the *upper bound*: a
  // payload that compresses well needs fewer pages than this. Say so, or the
  // actual count below reads like pages went missing.
  console.log(`  net       ${geom.ecc.netBytesPerPage} B/page -> up to ${plan.dataPages}+${plan.parityPages} = ${plan.totalPages} pages (before compression)`);

  if (args['dry-run']) {
    console.log('  (dry run: nothing written)');
    return;
  }

  const t0 = performance.now();
  const t = await mod.protocol.encodeTransfer(raw, {
    profile: profileId,
    nozzle,
    plateMm: args.plate ? Number(args.plate) : undefined,
    sheet: args.sheet,
    parityPct: args.parity ? Number(args.parity) : undefined,
    monoSafe: args.monoSafe,
    cipher: !!args.passphrase,
    passphrase: args.passphrase,
  });
  const t1 = performance.now();

  const outDir = resolve(args.out || join(ROOT, 'artifacts', basename(file, extname(file))));
  mkdirSync(outDir, { recursive: true });

  const layout = mod.layoutMod.pageLayout(t.geom, dpi, {
    plateMm: args.plate ? Number(args.plate) : undefined,
    sheetMm: mod.profiles.PROFILES[profileId].medium === 'paper' ? t.geom.sheetMm : undefined,
  });

  const fmts = new Set(String(args.format || 'png').split(/[,\s]+/).filter(Boolean));
  if (fmts.has('both')) {
    fmts.add('png');
    fmts.add('tiff');
  }
  if (fmts.has('all')) {
    fmts.add('png');
    fmts.add('tiff');
    fmts.add('pdf');
  }
  const unknown = [...fmts].filter((f) => !['png', 'tiff', 'pdf'].includes(f));
  if (unknown.length) {
    throw new Error(`send: unknown --format ${unknown.join(', ')} (choose from png, tiff, pdf, both, all)`);
  }
  const wantPng = fmts.has('png');
  const wantTiff = fmts.has('tiff');
  const wantPdf = fmts.has('pdf');
  let pdfOk = wantPdf;
  const pdfPages = [];
  const pdfBudget = 380e6; // raw RGB bytes the in-memory PDF assembly will absorb
  const files = [];
  let inkSum = 0;
  for (let i = 0; i < t.pages.length; i++) {
    const p = t.pages[i];
    const bitmap = mod.raster.renderPageBitmap({
      geom: t.geom,
      levels: p.levels,
      layout,
      palette: paletteId,
      mono: !!args.mono,
      echoBits: mod.raster.echoBitsOf(p.header),
    });
    if (i === 0) {
      const cov = mod.raster.coverageStats({ geom: t.geom, levels: p.levels, layout, palette: paletteId, mono: !!args.mono });
      inkSum = cov.printedAreaFraction;
    }
    if (wantTiff) {
      const name = `page-${String(i).padStart(3, '0')}.tif`;
      writeFileSync(join(outDir, name), mod.tiff.encodeTIFF(bitmap));
      files.push(name);
    }
    if (wantPng) {
      const name = `page-${String(i).padStart(3, '0')}.png`;
      writeFileSync(join(outDir, name), mod.png.encodePNG(bitmap));
      files.push(name);
    }
    if (pdfOk && (i + 1) * layout.width * layout.height * 3 > pdfBudget) {
      // A PDF document is assembled in memory, so an A4 600 dpi pack of dozens of
      // pages would need gigabytes. Refuse the PDF and keep the images rather
      // than dying: the PNGs print just as well.
      console.log(`  pdf        not written: ${t.pages.length} pages at ${layout.width}x${layout.height}px exceed the ${Math.round(pdfBudget / 1e6)} MB assembly budget -- print the PNG files`);
      pdfOk = false;
      pdfPages.length = 0;
    } else if (pdfOk) {
      pdfPages.push(bitmap);
    }
  }
  if (pdfPages.length) {
    const { encodePDFDocument } = await import('../core/render/pdf.js');
    writeFileSync(join(outDir, 'pack.pdf'), encodePDFDocument(pdfPages));
    files.push('pack.pdf');
  }
  const t2 = performance.now();

  const manifest = {
    tool: 'pskit',
    version: 1,
    source: basename(file),
    sourceBytes: raw.length,
    sourceSha256: mod.hash.sha256Hex(raw),
    sessionId: Array.from(t.sessionId).map((b) => b.toString(16).padStart(2, '0')).join(''),
    profile: profileId,
    nozzle: nozzle || null,
    monoSafe: t.geom.ecc.monoSafe,
    palette: paletteId,
    monoRender: !!args.mono,
    encrypted: !!(t.flags & mod.frame.FLAGS.CIPHER),
    compressed: !!(t.flags & mod.frame.FLAGS.COMPRESSED),
    pageGeometry: {
      cols: t.geom.cols,
      rows: t.geom.rows,
      pitchMm: t.geom.pitchMm,
      bitsPerCell: t.geom.bitsPerCell,
      netBytesPerPage: t.geom.ecc.netBytesPerPage,
    },
    pageLayout: mod.layoutMod.describeLayout(layout),
    // The glyph geometry the printer actually produced. Recomputing it at the
    // receiver works only while both sides run the same quantisation rules; this
    // turns a silent disagreement into a named mismatch.
    glyph: (await import('../core/render/glyphs.js')).glyphSignature(layout.glyph),
    dpi,
    pages: t.pages.length,
    dataPages: t.dataPages,
    parityPages: t.parityPages,
    printedAreaFraction: Math.round(inkSum * 1000) / 1000,
    files,
    timingsMs: { encode: Math.round(t1 - t0), render: Math.round(t2 - t1) },
    note: 'Print at 100% scale (no "fit to page"). Verify the plate fits: ' + layout.physicalMm.wMm.toFixed(1) + 'x' + layout.physicalMm.hMm.toFixed(1) + 'mm',
  };
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(
    `  wrote      ${t.pages.length} page(s) (${t.dataPages} data + ${t.pages.length - t.dataPages} parity) as ${files.length} file(s) + manifest.json in ${outDir}`,
  );
  console.log(`  render     ${(layout.width)}x${layout.height}px @ ${dpi}dpi, printed area ${(inkSum * 100).toFixed(1)}%`);
  console.log(`  timings    encode ${Math.round(t1 - t0)}ms  render+write ${Math.round(t2 - t1)}ms`);
  return { outDir, manifest, t, raw, layout, dpi, paletteId, args };
}

async function cmdReceive(args) {
  const mod = await load();
  const { decodePNG } = await import('../core/decode/png-read.js');
  const { decodePage } = await import('../core/decode/page.js');
  const { advise } = await import('../core/decode/advice.js');
  const dir = resolve(args._[0] || '.');
  const stat = statSync(dir);
  const names = stat.isDirectory()
    ? readdirSync(dir).filter((n) => /\.(png|tif|tiff)$/i.test(n)).sort()
    : [basename(dir)];
  const base = stat.isDirectory() ? dir : dirname(dir);
  if (!names.length) throw new Error(`receive: no pages found in ${dir}`);
  const manifestPath = join(base, 'manifest.json');
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null;
  const profileId = manifest?.profile || args.profile;
  const nozzle = manifest?.nozzle || args.nozzle;
  const dpi = args.dpi ? Number(args.dpi) : manifest?.dpi || 300;
  const paletteId = manifest?.palette || args.palette || 'INK2';
  if (!profileId) throw new Error('receive: no manifest.json and no --profile, cannot know the page geometry');
  const plateMm = args.plate ? Number(args.plate) : manifest?.plateMm;
  const geom = mod.profiles.planPage(profileId, { nozzle, plateMm, monoSafe: manifest?.monoSafe });
  const layout = mod.layoutMod.pageLayout(geom, dpi, { plateMm });
  if (manifest?.glyph) {
    const { glyphSignature, glyphSignatureDiff } = await import('../core/render/glyphs.js');
    const diff = glyphSignatureDiff(glyphSignature(layout.glyph), manifest.glyph);
    if (diff.length) {
      console.log('receive: REFUSED -- the printed geometry does not match what this build would read');
      for (const d of diff) console.log(`  ${d}`);
      console.log('  the pages were rendered by a different build (or a different nozzle/pitch than the manifest says).');
      console.log('  Nothing was decoded, because reading the wrong circles produces plausible-looking garbage.');
      process.exitCode = 3;
      return;
    }
  }
  const asm = new mod.protocol.TransferAssembler({ passphrase: args.passphrase });

  const opts = {
    allowFastPath: !args.photo,
    requireFastPath: false,
    log: args.verbose ? (m) => console.log(`    ${m}`) : null,
  };
  const seen = new Map();
  let skippedTiff = 0;
  for (const name of names) {
    if (/\.tiff?$/i.test(name)) {
      skippedTiff++;
      continue;
    }
    const bytes = new Uint8Array(readFileSync(join(base, name)));
    let bitmap;
    try {
      bitmap = decodePNG(bytes);
    } catch (e) {
      console.log(`  ${name}: not a readable PNG (${e.message})`);
      continue;
    }
    bitmap.substrate = bitmap.substrate || mod.palette.getPalette(paletteId).background;
    const t0 = performance.now();
    const r = decodePage(bitmap, { geom, layout, paletteId }, opts);
    const ms = Math.round(performance.now() - t0);
    if (!r.ok) {
      const a = advise(r);
      console.log(`  ${name}: FAIL ${r.stage}/${r.reason} [${ms}ms]`);
      console.log(`      cause: ${a.cause}`);
      console.log(`      do:    ${a.do}`);
      continue;
    }
    const fed = await asm.feed({
      levels: r.levels,
      header: r.headerBytes,
      channelMissing: r.colourAlive ? [] : ['colour'],
    });
    const idx = r.header ? r.header.pageIndex : undefined;
    if (!fed.ok && !fed.duplicate) {
      const a = advise({ stage: 'assemble', reason: fed.reason });
      console.log(`  ${name}: REJECTED page ${idx ?? '?'} (${fed.reason})`);
      console.log(`      cause: ${a.cause}`);
      continue;
    }
    seen.set(idx, (seen.get(idx) || 0) + 1);
    console.log(
      `  ${name}: page ${idx === undefined ? '?' : idx} ${r.path}${r.path === 'photo' ? ` marker ${r.markerPx?.toFixed(0)}px cover ${(r.coverage * 100).toFixed(0)}%` : ''}` +
        `${r.colourAlive ? '' : ' [colour channel dead -> erasure]'} [${ms}ms]${fed.duplicate ? ' (duplicate)' : ''}`,
    );
  }
  if (skippedTiff) console.log(`  note: ${skippedTiff} TIFF input(s) ignored -- TIFF read-back is not wired yet, convert to PNG for now`);
  const dupes = [...seen.entries()].filter(([, n]) => n > 1).length;
  if (dupes) console.log(`  ${dupes} page(s) were supplied more than once (deduplicated)`);

  const out = args.out ? resolve(args.out) : join(base, 'pskt-received.out');
  if (!asm.result) {
    const { dataHave, dataNeed, noSession } = asm.progress;
    if (noSession) {
      console.log(`receive: INCOMPLETE -- not one page header could be read, so the receiver never learned the page geometry (${seen.size} distinct page(s) read out of ${names.length - skippedTiff} image(s) offered)`);
      console.log('  this is a whole-batch failure, not a missing page: parity cannot help when no page decoded');
    } else {
      console.log(`receive: INCOMPLETE (${dataHave}/${dataNeed} data pages) -- ${asm.error || 'still short'}`);
    }
    console.log('  nothing was written: a partial file is never produced');
    process.exitCode = 2;
    return;
  }
  // G3: the result lands on disk only as a complete, verified file. Write to a
  // temporary name and rename, so a crash cannot leave a half-written payload
  // that a later step might mistake for the deliverable.
  const tmp = `${out}.part`;
  writeFileSync(tmp, Buffer.from(asm.result));
  renameSync(tmp, out);
  const want = manifest?.sourceSha256;
  const got = mod.hash.sha256Hex(asm.result);
  console.log(`received ${asm.result.length} bytes -> ${out}`);
  console.log(`  sha256 ${got}`);
  if (want) console.log(`  ${want === got ? 'MATCHES' : 'DOES NOT MATCH'} manifest (${want})`);
  if (want && want !== got) {
    rmSync(out, { force: true });
    console.log('  refused: the digest does not match the manifest, output deleted');
    process.exitCode = 1;
  }
}

async function cmdStatus() {
  const mod = await load();
  const rows = mod.profiles.densityReport();
  console.log('profile    medium nozzle monoSafe  pitch   lattice      net B/page  rate  note');
  for (const r of rows) {
    if (r.error) {
      console.log(`${r.profile.padEnd(10)} -      -      -          -       -            -         ERROR ${r.error}`);
      continue;
    }
    const p = mod.profiles.PROFILES[r.profile];
    console.log(
      `${r.profile.padEnd(10)} ${String(p.medium).padEnd(6)} ${(r.nozzle || '-').padEnd(6)} ${String(r.monoSafe).padEnd(9)} ` +
        `${String(r.pitchMm).padEnd(7)} ${(r.cols + 'x' + r.rows).padEnd(12)} ${String(r.netPerPage).padEnd(10)} ${String(r.rate).padEnd(5)} ${p.note || ''}`,
    );
  }
  console.log('\nnozzles: ' + Object.entries(mod.nozzles.NOZZLES).map(([k, v]) => `${k}mm EW=${v.ewMm}`).join('  '));
  console.log(`universal floor PL-G pitch: ${mod.nozzles.UNIVERSAL_PITCH_MM}mm`);
}

/* ------------------------------------------------------------------ */
/* gates                                                               */
/* ------------------------------------------------------------------ */

async function runUnitFiles() {
  const { run } = await import('node:test');
  const files = globUnit();
  const tests = { pass: 0, fail: 0, errors: [], filesRun: new Set() };
  // isolation:'none' keeps every test file on this thread -- the sandbox forbids
  // child processes with piped stdio, so a spawning test runner simply cannot run.
  // That mode reports the `test:*` event vocabulary (not the legacy `test` events),
  // so both are handled here.
  const stream = run({ files, concurrency: 1, isolation: 'none', timeout: 900000 });
  // In isolation:'none' there is no file-level wrapper: every leaf test arrives
  // with nesting 0 and carries its own `file`. `test:complete` duplicates
  // `test:pass`/`test:fail`, and `test:summary` is a roll-up -- count neither.
  for await (const ev of stream) {
    const d = ev.data || {};
    if (ev.type === 'test:pass') {
      if (d.severity === 'initial' || d.type === 'suite') continue;
      tests.pass++;
      if (d.file) tests.filesRun.add(String(d.file).split(/[\\/]/).pop());
    } else if (ev.type === 'test:fail') {
      if (d.severity === 'initial') continue;
      tests.fail++;
      const file = String(d.file || '').replace(/^file:\/\//, '').split(/[\\/]/).pop();
      tests.errors.push(`${file || 'suite'} :: ${d.name}: ${String(d.details?.error?.message || d.error?.message || 'failed').split('\n')[0]}`);
    } else if (ev.type === 'test:diagnostic' && /ERR_[A-Z_]+/.test(String(d.message || ''))) {
      tests.errors.push(`diagnostic: ${d.message}`);
    }
  }
  if (tests.filesRun.size < files.length) {
    tests.fail++;
    tests.errors.push(`only ${tests.filesRun.size} of ${files.length} test files produced results`);
  }
  if (tests.pass === 0 && tests.fail === 0) {
    // An empty tally is a broken harness, not a green gate. Never let that pass.
    tests.fail = 1;
    tests.errors.push('no tests were observed -- the runner reported nothing, which must never count as success');
  }
  return tests;
}

function globUnit(pattern = 'tests/unit/**/*.test.mjs') {
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        walk(p);
      } else if (e.name.endsWith('.test.mjs')) out.push(p);
    }
  };
  walk(join(ROOT, 'tests', 'unit'));
  return out.sort();
}

async function gateG0(args) {
  const t = await runUnitFiles();
  console.log(`G0 unit suite: ${t.pass} passed, ${t.fail} failed`);
  for (const e of t.errors.slice(0, 12)) console.log(`  FAIL ${e}`);
  return t.fail === 0;
}

async function gateG1(args) {
  const mod = await load();
  const seeds = Number(args.seeds || 20);
  const cases = [
    ['PL-D2', { nozzle: '0.2' }, 'INK2'],
    ['PL-D2', { nozzle: '0.4' }, 'INK2'],
    ['PL-D2', { nozzle: '0.8' }, 'INK2'],
    ['PL-M1', { nozzle: '0.4' }, 'PAPER1'],
    ['PL-D3', { nozzle: '0.2' }, 'INK4'],
    ['PL-G', { nozzle: '0.8' }, 'PAPER1'],
    ['P-M1-300', {}, 'PAPER1'],
  ];
  let allOk = true;
  for (const [pid, opts, pal] of cases) {
    const geom = mod.profiles.planPage(pid, opts);
    const per = geom.ecc.netBytesPerPage;
    let bad = 0;
    let cells = 0;
    let misread = 0;
    const t0 = performance.now();
    for (let s = 0; s < seeds; s++) {
      const size = Math.max(1, Math.floor(per * (0.3 + (s % 5) * 0.25)));
      const payload = new Uint8Array(size);
      let x = (s + 1) * 2654435761 >>> 0;
      for (let i = 0; i < size; i++) {
        x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
        payload[i] = x & 255;
      }
      const t = await mod.protocol.encodeTransfer(payload, { profile: pid, ...opts });
      const layout = mod.layoutMod.pageLayout(t.geom, pid.startsWith('P-') ? geom.dpi : 300, { plateMm: opts.nozzle ? 200 : undefined });
      const asm = new mod.protocol.TransferAssembler();
      for (const p of t.pages) {
        const bm = mod.raster.renderPageBitmap({ geom: t.geom, levels: p.levels, layout, palette: pal, echoBits: mod.raster.echoBitsOf(p.header) });
        const read = (await import('../core/decode/ideal.js')).readPageIdeal(bm, layout, t.geom, pal);
        for (let i = 0; i < read.levels.length; i++) {
          cells++;
          if (read.levels[i] !== p.levels[i]) misread++;
        }
        await asm.feed({ levels: read.levels, header: p.header, channelMissing: read.colourAlive ? [] : ['colour'] });
      }
      if (!asm.result || asm.result.length !== payload.length || !asm.result.every((v, i) => v === payload[i])) bad++;
    }
    const dt = ((performance.now() - t0) / 1000).toFixed(1);
    const ok = bad === 0 && misread === 0;
    allOk &&= ok;
    console.log(`  ${ok ? 'PASS' : 'FAIL'} ${pid}${opts.nozzle ? '@' + opts.nozzle : ''}: ${seeds} transfers, ${bad} failed, ${misread}/${cells} cells misread, ${dt}s`);
  }
  console.log(`G1 ideal round trip: ${allOk ? 'PASS' : 'FAIL'}`);
  return allOk;
}

async function gateG3(args) {
  const mod = await load();
  const { encodeTransfer, TransferAssembler } = mod.protocol;
  let allOk = true;
  const note = (ok, msg) => {
    allOk &&= ok;
    console.log(`  ${ok ? 'PASS' : 'FAIL'} ${msg}`);
  };
  const payloadOf = (n, seed) => {
    const p = new Uint8Array(n);
    let x = seed >>> 0 || 1;
    for (let i = 0; i < n; i++) {
      x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
      p[i] = x & 255;
    }
    return p;
  };

  for (const [pid, opts] of [['PL-D2', { nozzle: '0.2' }], ['PL-G', { nozzle: '0.4' }], ['P-M1-300', {}]]) {
    const geom = mod.profiles.planPage(pid, opts);
    const payload = payloadOf(Math.max(1, geom.ecc.netBytesPerPage * 2), 4242);
    const t = await encodeTransfer(payload, { profile: pid, ...opts });
    const parity = t.pages.length - t.dataPages;
    // exactly at the parity budget must recover
    for (let e = 0; e <= parity; e++) {
      const keep = t.pages.slice();
      // drop a spread of pages, not just the tail: parity pages matter too
      for (let d = 0; d < e; d++) keep.splice((d * 3 + 1) % keep.length, 1);
      // and hand the rest over in a shuffled order
      for (let i = keep.length - 1; i > 0; i--) {
        const j = (i * 7 + e) % (i + 1);
        [keep[i], keep[j]] = [keep[j], keep[i]];
      }
      const asm = new TransferAssembler();
      for (const p of keep) await asm.feed({ levels: p.levels, header: p.header, channelMissing: [] });
      const ok = !!asm.result && asm.result.length === payload.length && asm.result.every((v, i) => v === payload[i]);
      if (!ok) note(false, `${pid}: lost ${e}/${parity} parity pages did not recover`);
      if (e === 0 || e === parity || e === 1) note(ok, `${pid}: ${e} page(s) lost of ${t.pages.length} (${parity} parity) -> recovered`);
    }
    // one beyond the budget must refuse, and refuse without producing bytes
    const asm = new TransferAssembler();
    const keep = t.pages.slice(0, t.pages.length - parity - 1);
    for (const p of keep) await asm.feed({ levels: p.levels, header: p.header, channelMissing: [] });
    note(asm.result === null, `${pid}: losing ${parity + 1} pages refuses (result null, nothing written)`);
    if (asm.result !== null) {
      allOk = false;
      console.log('      produced bytes from too few pages -- THIS IS A FALSE ACCEPT');
    }
    // duplicates must be counted and must not corrupt the assembly
    const asm2 = new TransferAssembler();
    for (const p of t.pages) {
      await asm2.feed({ levels: p.levels, header: p.header, channelMissing: [] });
      await asm2.feed({ levels: p.levels, header: p.header, channelMissing: [] });
    }
    note(
      asm2.result && asm2.result.every((v, i) => v === payload[i]) && asm2.duplicates >= t.pages.length,
      `${pid}: every page supplied twice -> ${asm2.duplicates} duplicates ignored, bytes identical`,
    );
    // a foreign session interleaved into the stream must not be blended in
    const other = await encodeTransfer(payloadOf(payload.length, 9999), { profile: pid, ...opts });
    const asm3 = new TransferAssembler();
    for (const p of t.pages) await asm3.feed({ levels: p.levels, header: p.header, channelMissing: [] });
    const foreign = other.pages[0];
    const res = await asm3.feed({ levels: foreign.levels, header: foreign.header, channelMissing: [] });
    note(!res.ok || res.duplicate === true, `${pid}: a page from another session is rejected (${res.reason || 'ignored'})`);
  }
  console.log(`G3 page loss / order / duplicates: ${allOk ? 'PASS' : 'FAIL'}`);
  return allOk;
}

/**
 * G5 -- false acceptance must measure zero.
 *
 * Ten thousand randomised corruptions of a real transfer, each one required to
 * end in either "the exact original bytes" or "a refusal". A single wrong-but-
 * accepted result fails the gate, because a silent corruption is the only
 * failure this system is not allowed to have.
 *
 * The second half is the mutation check: it proves the *last* guard is actually
 * load-bearing. A page is taken from a different transfer, given the other
 * session's id and a freshly correct CRC, so it is structurally perfect -- the
 * only thing left between it and your disk is the SHA-256 digest of the whole
 * payload. If deleting that check still produced bytes, the suite would be
 * green while the system was wrong.
 */
async function gateG5(args) {
  const mod = await load();
  const { encodeTransfer, TransferAssembler } = mod.protocol;
  const trials = Number(args.trials || 10000);
  const pid = 'PL-M1';
  const opts = { nozzle: '0.4' };
  const geom = mod.profiles.planPage(pid, opts);
  const payload = new Uint8Array(Math.max(16, geom.ecc.netBytesPerPage));
  let x = 20250802 >>> 0;
  const rnd = () => {
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    return x / 4294967296;
  };
  for (let i = 0; i < payload.length; i++) payload[i] = (rnd() * 256) | 0;
  const base = await encodeTransfer(payload, { profile: pid, ...opts });
  const clone = (p) => ({ levels: p.levels.slice(), header: p.header.slice() });

  let falseAccept = 0;
  let recovered = 0;
  let refused = 0;
  const guard = {};
  const fire = (why) => {
    guard[why] = (guard[why] || 0) + 1;
  };

  for (let k = 0; k < trials; k++) {
    const pages = base.pages.map(clone);
    const mode = k % 7;
    const pick = (n) => (rnd() * n) | 0;
    if (mode === 0) {
      // flip bits in one page's readout levels (the optical channel's failure mode)
      const p = pages[pick(pages.length)];
      const flips = 1 + pick(24);
      for (let i = 0; i < flips; i++) {
        const idx = pick(p.levels.length);
        p.levels[idx] ^= 1 << pick(geom.bitsPerCell);
      }
    } else if (mode === 6) {
      // heavy damage: a smudge or a bridged print covering most of one page, far
      // beyond what the intra-page code can fix -- this is where the last guards
      // have to work, so it needs to be a real share of the mix
      const p = pages[pick(pages.length)];
      const n = Math.floor(p.levels.length * (0.2 + rnd() * 0.6));
      for (let i = 0; i < n; i++) p.levels[pick(p.levels.length)] = pick(1 << geom.bitsPerCell);
    } else if (mode === 1) {
      // erase whole cells (a smudge, a dropped print block)
      const p = pages[pick(pages.length)];
      const n = 1 + pick(p.levels.length);
      for (let i = 0; i < n; i++) p.levels[pick(p.levels.length)] = 0;
    } else if (mode === 2) {
      // lose a page outright
      pages.splice(pick(pages.length), 1);
    } else if (mode === 3) {
      // scribble on the header without repairing the CRC
      const p = pages[pick(pages.length)];
      p.header[pick(p.header.length)] ^= 1 << pick(8);
    } else if (mode === 4) {
      // lie about a header field and repair the CRC: everything structural now
      // checks out, so this only fails if the content behind it is verified too
      const p = pages[pick(pages.length)];
      const dec = mod.frame.decodeHeader(p.header);
      if (dec.ok) {
        dec.header.pageIndex = (dec.header.pageIndex + 1 + pick(3)) % Math.max(2, base.pages.length);
        p.header = mod.frame.encodeHeader(dec.header);
      }
    } else {
      // substitute a page from an unrelated transfer, same geometry
      const other = await encodeTransfer(new Uint8Array([1 + (k & 255), 2, 3, 4, 5, 6, 7, 8]), { profile: pid, ...opts });
      const src = other.pages[0];
      const dst = pages[pick(pages.length)];
      dst.levels.set(src.levels.subarray(0, Math.min(dst.levels.length, src.levels.length)));
    }
    const asm = new TransferAssembler();
    let fed = 0;
    for (const p of pages) {
      const r = await asm.feed({ levels: p.levels, header: p.header, channelMissing: [] });
      if (r.ok) fed++;
      else fire(`feed:${r.reason || '?'}`);
    }
    if (asm.result) {
      const same = asm.result.length === payload.length && asm.result.every((v, i) => v === payload[i]);
      if (same) {
        recovered++;
        fire('accepted-original');
      } else {
        falseAccept++;
        fire('FALSE-ACCEPT');
      }
    } else {
      refused++;
      fire(`refused:${asm.error ? asm.error.split(/[\s(]/)[0] : 'incomplete'}${fed ? '' : '-nofeed'}`);
    }
  }
  let ok = falseAccept === 0;
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${trials} tamper trials: ${recovered} recovered exactly, ${refused} refused, ${falseAccept} FALSE ACCEPTS`);
  const top = Object.entries(guard).sort((a, b) => b[1] - a[1]).slice(0, 6);
  console.log(`      which guard fired: ${top.map(([k2, v]) => `${k2}=${v}`).join('  ')}`);
  // the header-CRC guard must actually be exercised, or the trial mix is weak
  const crcFired = Object.keys(guard).some((k2) => /header-crc|bad-magic/.test(k2));
  ok &&= crcFired;
  console.log(`  ${crcFired ? 'PASS' : 'FAIL'} trial mix exercises the frame CRC/magic guards (mutation check on the suite itself)`);

  // ---- the digest is load-bearing: structurally perfect foreign page -------
  // The transfer must be *short* one data page before the forgery arrives, or the
  // assembly completes from the honest pages alone and the forged page never
  // reaches the decision -- which is exactly how this case first passed for the
  // wrong reason.
  {
    // Incompressible bytes, or DEFLATE shrinks the payload to a page or two and
    // the transfer is no longer multi-page -- which silently defeats the whole
    // point of this case (that is exactly what the first version of it did).
    const rndBytes = (n, seed) => {
      const a = new Uint8Array(n);
      let y = seed >>> 0 || 7;
      for (let i = 0; i < n; i++) {
        y ^= y << 13; y >>>= 0; y ^= y >>> 17; y ^= y << 5; y >>>= 0;
        a[i] = y & 255;
      }
      return a;
    };
    let tall = rndBytes(geom.ecc.netBytesPerPage * 3, 5150);
    let b2 = await encodeTransfer(tall, { profile: pid, ...opts });
    // netBytesPerPage is a deliberately conservative figure (it under-promises
    // what a page really carries, so the printed page count never surprises
    // upwards), which means the payload may have to be grown to get a real
    // multi-page transfer.
    for (let g = 4; b2.dataPages < 3 && g <= 40; g += 4) {
      tall = rndBytes(geom.ecc.netBytesPerPage * g, 5150 + g);
      b2 = await encodeTransfer(tall, { profile: pid, ...opts });
    }
    if (b2.dataPages < 3) {
      ok = false;
      console.log(`  FAIL digest case needs >= 3 data pages, got ${b2.dataPages}`);
    } else {
      const other = await encodeTransfer(rndBytes(tall.length, 9001), { profile: pid, ...opts });
      const stolenHeader = mod.frame.decodeHeader(other.pages[b2.dataPages - 1].header);
      const hostHeader = mod.frame.decodeHeader(b2.pages[0].header);
      stolenHeader.header.sessionId = hostHeader.header.sessionId; // claim the live session
      stolenHeader.header.pageIndex = b2.dataPages - 1; // the one page we are short of
      const stolen = mod.frame.encodeHeader(stolenHeader.header); // and a fresh, valid CRC
      const asm = new TransferAssembler();
      for (let i = 0; i < b2.dataPages - 1; i++) {
        await asm.feed({ levels: b2.pages[i].levels, header: b2.pages[i].header, channelMissing: [] });
      }
      const shortOf = asm.result === null;
      const r = await asm.feed({ levels: other.pages[b2.dataPages - 1].levels, header: stolen, channelMissing: [] });
      const rejected = asm.result === null;
      ok &&= shortOf && rejected;
      console.log(
        `  ${shortOf && rejected ? 'PASS' : 'FAIL'} forgery only matters when short (${shortOf ? 'yes' : 'no'}), and a foreign page with the live session id + valid CRC is refused (${rejected ? 'yes' : 'NO -- BYTES WERE PRODUCED'}) [feed: ${r.ok ? 'accept' : r.reason}]`,
      );
      if (!rejected) falseAccept++;
    }
  }
  console.log(`G5 false acceptance: ${ok ? 'PASS' : 'FAIL'}`);
  return ok;
}

async function gateG7(args) {
  const mod = await load();
  const ideal = await import('../core/decode/ideal.js');
  let allOk = true;
  for (const [pid, opts, pal, mustWork] of [
    ['PL-D2', { nozzle: '0.4' }, 'INK2', true],
    ['PL-D2', { nozzle: '0.2' }, 'INK2', true],
    ['PL-G', { nozzle: '0.8' }, 'PAPER1', true],
    ['PL-D3', { nozzle: '0.2' }, 'INK4', false],
  ]) {
    const geom = mod.profiles.planPage(pid, opts);
    const payload = new Uint8Array(900);
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 37 + 11) & 255;
    const t = await mod.protocol.encodeTransfer(payload, { profile: pid, ...opts });
    const layout = mod.layoutMod.pageLayout(t.geom, 300, { plateMm: 200 });
    const asm = new mod.protocol.TransferAssembler();
    let detected = 0;
    for (const p of t.pages) {
      const bm = mod.raster.renderPageBitmap({ geom: t.geom, levels: p.levels, layout, palette: pal, mono: true, echoBits: mod.raster.echoBitsOf(p.header) });
      const read = ideal.readPageIdeal(bm, layout, t.geom, pal);
      if (!read.colourAlive) detected++;
      await asm.feed({ levels: read.levels, header: p.header, channelMissing: read.colourAlive ? [] : ['colour'] });
    }
    const ok = mustWork ? !!asm.result : !asm.result;
    allOk &&= ok;
    console.log(
      `  ${ok ? 'PASS' : 'FAIL'} ${pid}${opts.nozzle ? '@' + opts.nozzle : ''} monoSafe=${geom.ecc.monoSafe}: ` +
        `colour channel declared dead on ${detected}/${t.pages.length} pages, result ${asm.result ? 'recovered' : 'refused'}`,
    );
  }
  console.log(`G7 single-colour fallback: ${allOk ? 'PASS' : 'FAIL'}`);
  return allOk;
}

async function cmdVerify(args) {
  const gate = String(args.gate || 'all');
  const wanted = gate === 'all' ? ['G0', 'G1', 'G3', 'G5', 'G7'] : [gate.toUpperCase()];
  const runners = { G0: gateG0, G1: gateG1, G3: gateG3, G5: gateG5, G7: gateG7 };
  let allOk = true;
  for (const g of wanted) {
    const r = runners[g];
    if (!r) {
      console.log(`${g}: not implemented yet (have: ${Object.keys(runners).join(', ')})`);
      allOk = false;
      continue;
    }
    console.log(`--- ${g} ---`);
    const ok = await r(args);
    allOk &&= ok;
  }
  console.log(allOk ? '\nALL GATES PASS' : '\nGATE FAILURE');
  if (!allOk) process.exitCode = 1;
}

async function cmdRoundtrip(args) {
  const mod = await load();
  const size = Number(args.bytes || 5000);
  const payload = new Uint8Array(size);
  let x = 123456789;
  for (let i = 0; i < size; i++) {
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    payload[i] = x & 255;
  }
  const t0 = performance.now();
  const t = await mod.protocol.encodeTransfer(payload, { profile: args.profile || 'PL-D2', nozzle: args.nozzle || '0.4' });
  const t1 = performance.now();
  const asm = new mod.protocol.TransferAssembler();
  for (const p of t.pages) await asm.feed({ levels: p.levels, header: p.header });
  const t2 = performance.now();
  const ok = !!asm.result && asm.result.length === size && asm.result.every((v, i) => v === payload[i]);
  console.log(`roundtrip ${size}B via ${t.pages.length} pages: ${ok ? 'OK' : 'FAIL'} (encode ${Math.round(t1 - t0)}ms decode ${Math.round(t2 - t1)}ms)`);
  if (args.selftest && !ok) process.exitCode = 1;
  if (args.selftest && ok) console.log('selftest PASS');
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];
try {
  if (args.help || !cmd) console.log(HELP);
  else if (cmd === 'send') await cmdSend(args._.length > 1 ? { ...args, _: args._.slice(1) } : args);
  else if (cmd === 'receive') await cmdReceive({ ...args, _: args._.slice(1) });
  else if (cmd === 'status') await cmdStatus();
  else if (cmd === 'verify') await cmdVerify(args);
  else if (cmd === 'roundtrip') await cmdRoundtrip(args);
  else console.log(`unknown command "${cmd}"\n\n${HELP}`);
} catch (e) {
  console.error(`pskit ${cmd}: ${e.message}`);
  if (process.env.PSKIT_TRACE) console.error(e.stack);
  process.exitCode = 1;
}
