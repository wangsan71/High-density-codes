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
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
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
    --format <png|tiff|both>   default png
    --mono               render as a single-colour print (proves the G7 fallback)
    --palette <id>       INK2 INK4 PAPER1 (default chosen by profile)
    --out <dir>          output directory (default artifacts/<name>)
    --dry-run            plan and report only, write nothing

  receive <dir>          decode pages back (ideal channel, no camera)
  status                 profile / nozzle capacity table
  verify --gate <G>      run an acceptance gate in-process (G0 G1 G3 G7 all)
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
  console.log(`  net       ${geom.ecc.netBytesPerPage} B/page -> ${plan.dataPages}+${plan.parityPages} = ${plan.totalPages} pages`);

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
    if (args.format === 'tiff' || args.format === 'both') {
      const name = `page-${String(i).padStart(3, '0')}.tif`;
      writeFileSync(join(outDir, name), mod.tiff.encodeTIFF(bitmap));
      files.push(name);
    }
    if (args.format !== 'tiff') {
      const name = `page-${String(i).padStart(3, '0')}.png`;
      writeFileSync(join(outDir, name), mod.png.encodePNG(bitmap));
      files.push(name);
    }
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
  console.log(`  wrote      ${files.length} image(s) + manifest.json in ${outDir}`);
  console.log(`  render     ${(layout.width)}x${layout.height}px @ ${dpi}dpi, printed area ${(inkSum * 100).toFixed(1)}%`);
  console.log(`  timings    encode ${Math.round(t1 - t0)}ms  render+write ${Math.round(t2 - t1)}ms`);
  return { outDir, manifest, t, raw, layout, dpi, paletteId, args };
}

async function cmdReceive(args) {
  const mod = await load();
  const dir = resolve(args._[0] || '.');
  const names = readdirSync(dir).filter((n) => /\.(png|tif|tiff)$/i.test(n)).sort();
  if (!names.length) throw new Error(`receive: no pages found in ${dir}`);
  const manifestPath = join(dir, 'manifest.json');
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null;
  const { decodePNG } = await import('../core/decode/png-read.js');
  const profileId = manifest?.profile || args.profile;
  const nozzle = manifest?.nozzle || args.nozzle;
  const dpi = args.dpi ? Number(args.dpi) : manifest?.dpi || 300;
  const paletteId = manifest?.palette || args.palette || 'INK2';
  const geom = mod.profiles.planPage(profileId, { nozzle, plateMm: args.plate ? Number(args.plate) : undefined, monoSafe: manifest?.monoSafe });
  const layout = mod.layoutMod.pageLayout(geom, dpi, { plateMm: args.plate ? Number(args.plate) : undefined });
  const asm = new mod.protocol.TransferAssembler({ passphrase: args.passphrase });
  for (const name of names) {
    const bytes = new Uint8Array(readFileSync(join(dir, name)));
    const bitmap = /png$/i.test(name) ? decodePNG(bytes) : (() => {
      throw new Error('receive: TIFF input not wired yet, use PNG pages');
    })();
    bitmap.substrate = bitmap.substrate || mod.palette.getPalette(paletteId).background;
    const read = (await import('../core/decode/ideal.js')).readPageIdeal(bitmap, layout, geom, paletteId);
    const hdr = name.replace(/\.png$/i, '') ;
    // the echo strip carries the header; re-read it from the rendered page
    const echo = (await import('../core/decode/echo.js')).readEcho(bitmap, layout);
    if (!echo.ok) throw new Error(`receive: ${name}: echo strip unreadable (${echo.reason})`);
    void hdr;
    await asm.feed({ levels: read.levels, header: echo.headerBytes, channelMissing: read.colourAlive ? [] : ['colour'] });
  }
  if (!asm.result) throw new Error(`receive: incomplete (${asm.error || asm.progress.dataHave}/${asm.progress.dataNeed} data pages)`);
  const out = args.out || join(dir, basename(names[0]) + '.out');
  writeFileSync(out, Buffer.from(asm.result));
  const want = manifest?.sourceSha256;
  const got = mod.hash.sha256Hex(asm.result);
  console.log(`received ${asm.result.length} bytes -> ${out}`);
  console.log(`  sha256 ${got}`);
  if (want) console.log(`  ${want === got ? 'MATCHES' : 'DOES NOT MATCH'} manifest (${want})`);
  if (want && want !== got) process.exitCode = 1;
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
  const wanted = gate === 'all' ? ['G0', 'G1', 'G7'] : [gate.toUpperCase()];
  const runners = { G0: gateG0, G1: gateG1, G7: gateG7 };
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
