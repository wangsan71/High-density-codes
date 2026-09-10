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
    --profile <id>       P-M1-300 P-M1-600 P-M2-600 P-C4-600 P-MX-300-4/5/6 PL-M1 PL-D2 PL-D3 PL-D3S PL-G REL-H1
    --nozzle <0.2|0.4|0.6|0.8>   plate profiles only (default 0.4)
    --monoSafe <full|partial|off>  colour-loss protection vs capacity (default per profile)
    --dpi <n>            raster resolution (plate default 300, paper uses the profile dpi)
    --plate <mm>         printable plate edge (default 200)
    --sheet <A4|Letter>  paper profiles only
    --parity <pct>       inter-page parity percentage (default per profile)
    --passphrase <pw>    ChaCha20 encrypt the payload (PBKDF2-SHA256, 150k iters)
    --format <png|tiff|pdf|both|all|stl|3mf>   default png; may be combined (png,3mf)
                         pdf = one pack.pdf carrying every page at true physical
                         size (what you actually send to a printer)
                         stl/3mf = the plate relief model (docs/MESH-CONTRACT.md);
                         plate profiles only -- paper profiles are refused, and
                         every page also writes page-NNN.model-facts.json for
                         ref/verify_model.py to check from the other side
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

  split <file>           cut a file into parts that each fit ONE transfer
    --max-bytes <n>      part ceiling (default 1400000; one transfer is at most 255
                         pages because a page header stores totalPages in one byte, and
                         P-M1-300 at its default 20% parity carries 1592968 B)
    --out <dir>          where to write part-NNN.bin and parts.json
                         (default <name>-parts next to the file). Each part is then its
                         own transfer: send it, print it, scan it, and receive it back
                         into that same directory under its part name.

  join <dir|parts.json>  put parts back: verify every part's digest, then the whole
                         file's digest, and only then write
    --out <file>         where to write. Default is the name the manifest recorded, and
                         that default is REFUSED if the file already exists -- pass
                         --out to choose somewhere. A missing, short or corrupt part is
                         a refusal and never a shorter file: nothing is written and the
                         exit code is 1.

  calibrate <dir|file>   measure a captured page set; changes no decode decision
    --photo              same meaning as in receive (force the camera path)
    --profile/--nozzle/--dpi/--palette/--plate
                         required only when there is no manifest.json
                         per page it prints: the readout outcome, how much of the
                         intra-page RS budget was spent ((2*errors + erasures) over
                         (blocks * nsym)), and the threshold-free ink-area ratio
                         (a health check only). NOT a gate: the exit code is not a
                         verdict, and no threshold is derived from the measurement.

  calibrate --make-mtf   write the MTF calibration plate (PLAN §3.4) and its spec
    --out <dir>          where to write (default .)
    --format <list>      png (appearance raster, default), 3mf, stl, or a comma list; 3mf/stl
                         write the printable plate (base + raised ink, watertight per object,
                         projection-checked against the spec before anything is written)
                         mtf-plate.json is always written -- the reader needs it
    --plate-mm/--dpi/--palette   plate side (200), raster dpi (300), palette (INK2)
    --print-ew <mm>      SIMULATION: emulate a printer whose smallest feature is this
                         wide, so the plate can be put through sim/channel.py with a
                         known nozzle. A real print does this by itself; omit it.
  calibrate <png> --mtf  read a capture of that plate back
    --spec <file>        plate spec (default mtf-plate.json beside the capture)
    --json               also write <capture>.mtf.json for tools/mtf-probe.ps1
    --fast               skip the texture and ruler measurements
                         It prints the pitch ladder, the feature ladder, colour
                         separation, white-balance drift and a nozzle/pitch
                         recommendation. Still not a gate: the exit code is not a verdict.

  status                 profile / nozzle capacity table
  verify --gate <G>      run an acceptance gate in-process (G0 G1 G2 G3 G5 G7 G8 all)
    --seeds <n>          G1/G3/G7 repetitions (default per gate)
    --trials <n>         G5 tamper count (default 10000)
    --corpus <dir>       G2: a corpus dir made by sim/channel.py (or --root DIR --match GLOB)
    --fast               G2: skip the photo-path decode (same as g2-corpus.mjs --fast)
    --file <a,b.3mf>     G8: check these files instead of building one in process
                         'all' covers G0 G1 G2 G3 G5 G7 G8; G4/G9 need a phone and a browser,
                         G6 is the long soak, G10 needs a printer -- name them to run them
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

/**
 * Which profile a bare `pskit send FILE` uses when the user names none.
 *
 * The function always took the extension and always ignored it, returning PL-D2 for everything --
 * a plate profile that carries ~180 B per page, so the documented main path (`P-M1-300`, a paper
 * page of ~7.5 kB) was one forgotten flag away from a refusal: measured, `pskit send some.bin`
 * answered "needs 1120 pages > 255". A model file still gets the plate profile, because sending a
 * 3D model to a plate is what the user means; everything else gets the paper workhorse USE.md
 * tells people to use.
 */
function defaultProfileFor(ext) {
  const e = String(ext || '').toLowerCase();
  if (e === '.stl' || e === '.3mf' || e === '.obj') return 'PL-D2';
  return 'P-M1-300';
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
  let plan;
  try {
    plan = mod.profiles.planTransfer(profileId, { nozzle, plateMm: args.plate ? Number(args.plate) : undefined, sheet: args.sheet, parityPct: args.parity ? Number(args.parity) : undefined, monoSafe: args.monoSafe }, raw.length);
  } catch (e) {
    // The refusal itself is core's (and correct: one transfer is at most 255 pages). What the CLI
    // can add is which profile would fit, because "use a denser profile" names nothing -- a plate
    // page carries ~180 B against a paper page's ~7.5 kB, two orders of magnitude apart. Measured
    // (round 84): a bare `send file` used to hit this with the plate default and name no way out.
    if (/inter-page RS limit/.test(String(e && e.message))) {
      const geomOpts = { nozzle, plateMm: args.plate ? Number(args.plate) : undefined, sheet: args.sheet, parityPct: args.parity ? Number(args.parity) : undefined };
      const per = mod.profiles.planPage('P-M1-300', {}).ecc.netBytesPerPage;
      const here = mod.profiles.planPage(profileId, geomOpts).ecc.netBytesPerPage;
      // What this profile can actually carry in ONE transfer: 255 pages minus the parity pages, times
      // the net bytes per page. A split that ignores it produces parts that are themselves too big --
      // the round-84 hint said "use pskit split" without saying how big a part may be, which for a
      // plate profile is ~46 kB, not the 1.4 MB default (measured, round 89).
      // Largest payload this profile can carry in ONE transfer: find the biggest data-page count D
      // whose D + parity(D) still fits the 255-page ceiling, then multiply by the net bytes per page.
      // (The first version of this loop walked bytes downward from 255 and stopped immediately --
      // 255 B always fits -- and printed "at most ~255 B" for a profile that really holds ~28 kB.)
      const geomHere = mod.profiles.planPage(profileId, geomOpts);
      const interRatio = geomHere.ecc.inter.nsym / geomHere.ecc.inter.k;
      let ceiling = null;
      for (let d = 253; d >= 1; d--) {
        const parity = Math.max(2, Math.ceil(d * interRatio));
        if (d + parity <= 255) { ceiling = d * geomHere.ecc.netBytesPerPage; break; }
      }
      console.log(`pskit send: ${e.message}`);
      console.log(
        `  hint: this transfer is ${raw.length} B; ${profileId} carries ~${here} B per page` +
          (ceiling ? `, so ONE transfer of this profile holds at most ~${ceiling} B (uncompressed)` : '') +
          `, while P-M1-300 (paper) carries ~${per} B per page -- about ${Math.ceil(raw.length / per)} page(s) for this file before compression.`,
      );
      if (ceiling) {
        console.log(
          `  to send it anyway: ` + `node cli/pskit.mjs split <file> --max-bytes ${ceiling} --out parts` +
            ' and send/print/scan each part as its own transfer (then join the received parts).',
        );
      }
      process.exitCode = 2;
      return;
    }
    throw e;
  }

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
  let t;
  try {
    t = await mod.protocol.encodeTransfer(raw, {
      profile: profileId,
      nozzle,
      plateMm: args.plate ? Number(args.plate) : undefined,
      sheet: args.sheet,
      parityPct: args.parity ? Number(args.parity) : undefined,
      monoSafe: args.monoSafe,
      cipher: !!args.passphrase,
      passphrase: args.passphrase,
    });
  } catch (e) {
    // The refusal itself is core's (and correct: one transfer is at most 255 pages). What the CLI
    // can add is which profile would fit, because "use a denser profile" names nothing -- and a
    // plate profile carries ~180 B per page against a paper page's ~7.5 kB, so the difference is
    // two orders of magnitude, not a nudge. Measured (round 84): a bare `send file` used to hit
    // this with the plate default and gave the user no way to act on it.
    if (/inter-page RS limit/.test(String(e && e.message))) {
      const paper = mod.profiles.PROFILES['P-M1-300'];
      const per = mod.profiles.planPage('P-M1-300', {}).ecc.netBytesPerPage;
      console.log(`pskit send: ${e.message}`);
      console.log(
        `  hint: this transfer is ${raw.length} B and ${profileId} carries ~${mod.profiles.planPage(profileId, { nozzle, plateMm: args.plate ? Number(args.plate) : undefined }).ecc.netBytesPerPage} B per page. ` +
          `${paper.id} (paper) carries ~${per} B per page and allows up to 255 pages, so about ${Math.ceil(raw.length / per)} page(s) before compression; ` +
          'or cut the file into parts with `pskit split` and send each part as its own transfer.',
      );
      process.exitCode = 2;
      return;
    }
    throw e;
  }
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
  const unknown = [...fmts].filter((f) => !['png', 'tiff', 'pdf', 'stl', '3mf'].includes(f));
  if (unknown.length) {
    throw new Error(`send: unknown --format ${unknown.join(', ')} (choose from png, tiff, pdf, both, all, stl, 3mf)`);
  }
  const wantPng = fmts.has('png');
  const wantTiff = fmts.has('tiff');
  const wantPdf = fmts.has('pdf');
  const wantStl = fmts.has('stl');
  const want3mf = fmts.has('3mf');
  const wantModel = wantStl || want3mf;
  if (wantModel && mod.profiles.PROFILES[profileId].medium !== 'plate') {
    // MESH-CONTRACT.md §3：纸面档的 cellEw 是 null，没有挤出宽度可以量化半径。
    // 按 0.4 mm 猜一个就能出文件，但那是一份"看起来对"的浮雕，所以这里明确拒绝。
    throw new Error(`send: --format stl|3mf needs a plate profile; ${profileId} is a paper medium (no extrusion width to quantise radii with) -- see docs/MESH-CONTRACT.md §3`);
  }
  const mesh = wantModel
    ? {
        plate: await import('../core/mesh/plate.js'),
        stl: await import('../core/mesh/stl.js'),
        three: await import('../core/mesh/threeMF.js'),
        glyphs: await import('../core/render/glyphs.js'),
      }
    : null;
  const modelReports = [];
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
    // Raster artefacts are the paper, not the code area: with a sheet chosen, paint the margins and
    // the crop/registration marks, so a user who prints the PNG gets the same sheet that pack.pdf
    // carries (DEFECTS D45). Without a sheet this is the identical bitmap and the identical bytes.
    // The PDF path keeps `bitmap` on purpose -- it centres the content and strokes its own marks.
    const rasterOut = bitmap.sheetMm ? mod.raster.renderSheetBitmap(bitmap) : bitmap;
    if (wantTiff) {
      const name = `page-${String(i).padStart(3, '0')}.tif`;
      writeFileSync(join(outDir, name), mod.tiff.encodeTIFF(rasterOut));
      files.push(name);
    }
    if (wantPng) {
      const name = `page-${String(i).padStart(3, '0')}.png`;
      writeFileSync(join(outDir, name), mod.png.encodePNG(rasterOut));
      files.push(name);
    }
    if (wantModel) {
      // ── 板材浮雕（docs/MESH-CONTRACT.md）───────────────────────────────────
      // 先装配、再逐格把顶面投影回格子网格和"渲染这一页得到的掩码"对拍（G8 §6.3），
      // 对不上就拒绝写文件：宁可不出图，也不出一张"看起来对"的浮雕。
      const tag = `page-${String(i).padStart(3, '0')}`;
      const model = mesh.plate.buildPlateModel({ geom: t.geom, levels: p.levels, layout, mono: !!args.mono, palette: paletteId });
      const proj = mesh.plate.projectionReport(model);
      if (!proj.ok) {
        throw new Error(
          `send: ${tag} relief does not reproduce the raster mask —— ` +
            `${proj.cellsOverTolerance}/${proj.cells} cells off by >= ${proj.tolerancePct}% (max ${proj.maxPct.toFixed(2)}%), ` +
            `straddling ${proj.straddlingTriangles} triangles, ink mismatch ${proj.inkedMismatch}; refusing to write the model`,
        );
      }
      const stlCheck = mesh.stl.stlSelfCheck(model.triangles);
      if (!stlCheck.ok) throw new Error(`send: ${tag} stlSelfCheck refused: ${stlCheck.issues.join('; ')}`);
      if (wantStl) {
        const name = `${tag}.stl`;
        const bytes = mesh.stl.encodeSTLSolid(model.triangles, { name: `PSKT-${profileId}-p${i}` });
        writeFileSync(join(outDir, name), bytes);
        files.push(name);
        modelReports.push({ tag, kind: 'stl', file: name, bytes: bytes.length, sha256: mod.hash.sha256Hex(bytes).slice(0, 12), triangles: stlCheck.tris, bboxMm: stlCheck.bbox.size.map((v) => +v.toFixed(4)) });
      }
      if (want3mf) {
        const name = `${tag}.3mf`;
        const bytes = mesh.three.encode3MF({
          objects: model.objects,
          metadata: {
            'pskt:profile': profileId,
            'pskt:page': i,
            'pskt:dpi': String(dpi),
            'pskt:cellPx': String(layout.cellPx),
            'pskt:glyph': JSON.stringify(mesh.glyphs.glyphSignature(layout.glyph)),
            'pskt:sourceSha256': mod.hash.sha256Hex(raw),
          },
        });
        const chk = mesh.three.selfCheck3MF(bytes, { expectTriangles: model.facts.trianglesTotal });
        if (!chk.ok) throw new Error(`send: ${tag} selfCheck3MF refused: ${chk.issues.join('; ')}`);
        writeFileSync(join(outDir, name), bytes);
        files.push(name);
        modelReports.push({
          tag,
          kind: '3mf',
          file: name,
          bytes: bytes.length,
          sha256: chk.sha256,
          triangles: chk.trianglesTotal,
          objects: chk.objects.map((o) => `${o.name}:${o.triangles}t/${o.vertices}v/${o.manifold.components}shells/${'χ=' + o.manifold.euler}`),
          watertightEachObject: chk.watertight,
          bboxMm: model.facts.bbox.size.map((v) => +v.toFixed(4)),
        });
      }
      const factsName = `${tag}.model-facts.json`;
      writeFileSync(
        join(outDir, factsName),
        JSON.stringify(
          {
            tool: 'pskit',
            version: 1,
            tag,
            sourceSha256: mod.hash.sha256Hex(raw),
            glyphSignature: mesh.glyphs.glyphSignature(layout.glyph),
            monoRender: !!args.mono,
            ...model.facts,
            bbox: { min: Array.from(model.facts.bbox.min), max: Array.from(model.facts.bbox.max), size: Array.from(model.facts.bbox.size) },
            cells: model.cells.map((c) => [c.col, c.row, c.shapeLevel, c.colourLevel, +c.topMm.toFixed(6)]),
            projection: {
              cells: proj.cells,
              tolerancePct: proj.tolerancePct,
              maxPct: +proj.maxPct.toFixed(4),
              meanPct: +proj.meanPct.toFixed(4),
              cellsOverTolerance: proj.cellsOverTolerance,
              straddlingTriangles: proj.straddlingTriangles,
              inkedMismatch: proj.inkedMismatch,
              ok: proj.ok,
            },
          },
          null,
          1,
        ) + '\n',
      );
      files.push(factsName);
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

  // The note travels with the artefacts, so it must describe the artefacts that were actually written.
  // It used to tell paper users to "verify the plate fits" and quoted the code area as though it were
  // the sheet (DEFECTS D46), and it said nothing about the 600 dpi paper profiles that the G2 gate
  // measured below its 100% criterion (D49). `layout.sheetMm` is `{w,h}` in mm and is null for plate
  // profiles; note that `renderPageBitmap` hands back the same fact as an ARRAY `[w,h]` -- do not mix
  // the two shapes here (getting it wrong prints "NaN x NaN mm" into the user's manifest).
  const codeAreaMm = layout.physicalMm.wMm.toFixed(1) + 'x' + layout.physicalMm.hMm.toFixed(1) + 'mm';
  const dpi600Warning =
    dpi >= 600
      ? ' WARNING: 600 dpi paper profiles are NOT qualified -- the G2 gate measured this side below its 100% criterion (docs/DEFECTS.md D49); prefer a 300 dpi paper profile unless you need this one.'
      : '';
  const note = layout.sheetMm
    ? 'Print at 100% scale (no "fit to page"). Sheet ' +
      layout.sheetMm.w.toFixed(1) +
      'x' +
      layout.sheetMm.h.toFixed(1) +
      'mm carries the ' +
      codeAreaMm +
      ' code area centred, with crop marks and registration crosses in the margin; scan colour at ' +
      dpi +
      ' dpi with auto-crop OFF.' +
      dpi600Warning
    : modelReports.length
      ? 'Print at 100% scale (no "fit to page"). Verify the plate fits: ' + codeAreaMm
      : 'Print at 100% scale (no "fit to page"). No sheet was requested, so these images carry only the ' +
        codeAreaMm +
        ' code area: the printer decides where it lands and there are no crop marks. Pass --sheet A4 for a printable sheet.' +
        dpi600Warning;

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
    ...(modelReports.length ? { model: modelReports } : {}),
    timingsMs: { encode: Math.round(t1 - t0), render: Math.round(t2 - t1) },
    note,
  };
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(
    `  wrote      ${t.pages.length} page(s) (${t.dataPages} data + ${t.pages.length - t.dataPages} parity) as ${files.length} file(s) + manifest.json in ${outDir}`,
  );
  // Report the artefact the user actually received, not only the code area: with a sheet chosen the
  // PNG/TIFF on disk IS the sheet (D45), so quoting just `layout.width x layout.height` tells the user
  // a size that does not match the file they are about to print -- the same class of lie as the
  // manifest note that D46 fixed (recorded as D50).
  const sheetPx = layout.sheetMm
    ? [Math.round((layout.sheetMm.w / 25.4) * dpi), Math.round((layout.sheetMm.h / 25.4) * dpi)]
    : null;
  console.log(
    `  render     ${(layout.width)}x${layout.height}px code area${sheetPx ? ` on a ${sheetPx[0]}x${sheetPx[1]}px sheet (${layout.sheetMm.w}x${layout.sheetMm.h}mm)` : ''} @ ${dpi}dpi, printed area ${(inkSum * 100).toFixed(1)}%`,
  );
  if (!modelReports.length && dpi >= 600) {
    // D49: the 600 dpi paper side of G2 measured below criterion, so say it where the user is looking
    // (stdout), not only inside manifest.json. The measured numbers live in the ledger, not here, so
    // this string cannot go stale the way a hardcoded ratio would.
    console.log(
      '  warning    600 dpi paper profile: the G2 gate measured this side BELOW its 100% criterion (docs/DEFECTS.md D49) -- prefer a 300 dpi paper profile unless you need this one',
    );
  }
  for (const r of modelReports) {
    const bbox = r.bboxMm.map((v) => v.toFixed(3)).join(' x ');
    console.log(`  ${r.kind.padEnd(9)} ${r.file}: ${r.triangles} tris, bbox ${bbox} mm, ${r.bytes} B, sha256 ${r.sha256}`);
    if (r.watertightEachObject !== undefined) {
      console.log(`            ${r.objects.join(' + ')}; each object watertight (every undirected edge used exactly twice): ${r.watertightEachObject}`);
    }
  }
  if (modelReports.length) {
    const p = JSON.parse(readFileSync(join(outDir, `${modelReports[0].tag}.model-facts.json`), 'utf8')).projection;
    console.log(`  projection   G8 §6.3: max ${p.maxPct.toFixed(2)}% mean ${p.meanPct.toFixed(2)}% off the raster mask, ${p.cellsOverTolerance}/${p.cells} cells >= ${p.tolerancePct}% -> ${p.ok ? 'PASS' : 'FAIL'}`);
  }
  console.log(`  timings    encode ${Math.round(t1 - t0)}ms  render+write ${Math.round(t2 - t1)}ms`);
  // The two commands that come next, spelled out with this transfer's own profile. The first-use
  // path used to end at "wrote N files"; a user then had to re-read the manual to know that the
  // receive side needs the profile (a fresh scan folder has no manifest.json) -- round 86.
  if (modelReports.length) {
    console.log(`  next       slice ${join(outDir, 'page-000.3mf')} (or the .stl), print it, photograph it, then:`);
  } else {
    console.log(`  next       print ${wantPdf ? join(outDir, 'pack.pdf') : join(outDir, 'page-000.png')} at 100%, scan the pages to PNG, then:`);
  }
  console.log(
    `             node cli/pskit.mjs receive <scan or photo dir> --photo --profile ${profileId}` +
      `${nozzle ? ` --nozzle ${nozzle}` : ''}${args.plate ? ` --plate ${args.plate}` : ''}` +
      `${args.passphrase ? ' --passphrase <the one you used>' : ''} --out <file>`,
  );
  return { outDir, manifest, t, raw, layout, dpi, paletteId, args };
}

async function cmdReceive(args) {
  const mod = await load();
  const { decodePNG } = await import('../core/decode/png-read.js');
  const { decodePage } = await import('../core/decode/page.js');
  const { advise } = await import('../core/decode/advice.js');
  const { feedPageWithRecalibration } = await import('../core/decode/recalibrate.js');
  const { decodeTIFF } = await import('../core/decode/tiff-read.js');
  const dir = resolve(args._[0] || '.');
  const stat = statSync(dir);
  const all = stat.isDirectory() ? readdirSync(dir).sort() : [basename(dir)];
  const base = stat.isDirectory() ? dir : dirname(dir);
  // PNG and TIFF are both read natively now: a flatbed's two most common defaults are "PNG" and
  // "TIFF", and in an air-gapped workflow "install ImageMagick first" is not an answer (DEFECTS
  // D82). What is left over is named rather than silently skipped -- a phone camera writes JPEG,
  // and "scan to PDF" is very common, so "no pages found" about a directory full of .jpg or .pdf
  // sends the user looking for a problem that is not there (round 83, DEFECTS D74).
  const TIFF_RE = /\.(tiff?)$/i;
  const names = all.filter((n) => /\.png$/i.test(n) || TIFF_RE.test(n));
  const UNREADABLE = /\.(jpe?g|webp|gif|bmp|heic|heif)$/i;
  const unreadable = all.filter((n) => UNREADABLE.test(n));
  const pdfs = all.filter((n) => /\.pdf$/i.test(n));
  const fmtList = [...new Set([...unreadable, ...pdfs].map((n) => extname(n).toLowerCase()))].sort().join(' ');
  if (!names.length) {
    // PDF gets its own sentence: this build *writes* PDFs (that is the print path) and cannot
    // rasterize one, so the remedy is an export, not a different viewer -- and a page exported by
    // an online converter can be geometrically altered (DEFECTS D78), which is worth saying.
    if (pdfs.length && !unreadable.length) {
      throw new Error(
        `receive: found ${pdfs.length} PDF file(s) in ${dir}, and this build does not rasterize PDF pages -- it only writes them. ` +
          'Export the scanned pages as PNG (scanner software: choose PNG; any PDF viewer: "export as image", 300 dpi, colour, ' +
          'auto-crop off) and run receive again. Do not screenshot a viewer window: that resamples the ink and moves the markers.',
      );
    }
    if (unreadable.length || pdfs.length) {
      throw new Error(
        `receive: found ${unreadable.length + pdfs.length} file(s) in ${dir}, but none in a format this build reads (${fmtList}). ` +
          'PNG and TIFF are decoded natively; JPEG, WebP and friends are not (PDF is written but never rasterized). Convert them first, e.g. ' +
          "tools\\jpeg-to-png.ps1 -Source DIR -Out DIR-png (Windows), " +
          "magick convert '*.jpg' -png out/page-%03d.png (ImageMagick), or python -c \"from PIL import Image; ...\" -- " +
          'or open the browser receiver, which decodes JPEG natively.',
      );
    }
    throw new Error(`receive: no pages found in ${dir}`);
  }
  const manifestPath = join(base, 'manifest.json');
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null;
  const profileId = manifest?.profile || args.profile;
  const nozzle = manifest?.nozzle || args.nozzle;
  const dpi = args.dpi ? Number(args.dpi) : manifest?.dpi || 300;
  const paletteId = manifest?.palette || args.palette || 'INK2';
  if (!profileId) {
    throw new Error(
      `receive: ${dir} has no manifest.json and no --profile was given, so the page geometry is unknown. ` +
        'Pass the profile the pages were printed with (e.g. --profile P-M1-300, or --profile PL-G --nozzle 0.4 --plate 200 for a plate) ' +
        '-- or use the browser receiver (web/dist/pskt-file.html), which searches the candidate geometries for you.',
    );
  }
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
  // One file may hold several pages: a scanner that writes one multi-page TIFF is the normal
  // case, not a corner case, and making the user split it by hand would be exactly the kind of
  // needless dependency this project refuses (DEFECTS D82). Each page is decoded as its own
  // bitmap and reported with the file name plus its page number.
  const images = [];
  for (const name of names) {
    const bytes = new Uint8Array(readFileSync(join(base, name)));
    try {
      if (TIFF_RE.test(name)) {
        const { pages } = decodeTIFF(bytes);
        if (pages.length > 1) console.log(`  ${name}: ${pages.length} pages in one file`);
        pages.forEach((bitmap, i) => images.push({ label: pages.length > 1 ? `${name} [page ${i}]` : name, bitmap }));
      } else {
        images.push({ label: name, bitmap: decodePNG(bytes) });
      }
    } catch (e) {
      console.log(`  ${name}: not a readable image (${e.message})`);
    }
  }
  for (const { label: name, bitmap } of images) {
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
    // Arbitrated feed, shared with web/app.js and the G2 harness: the matched-filter read goes first
    // and a recalibrated re-read is offered only after the page's own code rejected it. A page that
    // decodes today is read bit-identically today, because the retry never runs (DEFECTS D51).
    const resc = await feedPageWithRecalibration(asm, r, { geom, log: null });
    const fed = resc.fed;
    if (resc.retried) {
      const e = resc.estimate || {};
      // The note names its own file and page. This line prints BEFORE the page's own status line, so
      // without the name it reads as a comment on the previous page -- a misreading that is not
      // hypothetical: it fooled me while writing this round's ledger, and a user must not have to
      // guess which page was rescued. Ambiguous success output is how wrong conclusions get recorded.
      console.log(
        `      ${name} (page ${r.header?.pageIndex ?? '?'}): ${fed.ok ? 'RESCUED' : 're-read also rejected'}` +
          ` -- shape levels re-decided against a cut measured on this page` +
          ` (cut ${e.cut?.toFixed(4)}, clusters ${e.m0?.toFixed(3)}/${e.m1?.toFixed(3)}, separation ${e.separation?.toFixed(2)}${e.unimodal ? ', UNIMODAL' : ''},` +
          ` ${resc.changed} cells changed)${fed.ok ? '; accepted because the page code accepted it, not because of the cut' : ` (${resc.secondReason})`}`,
      );
    }
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
  if (unreadable.length || pdfs.length) {
    console.log(
      `  note: ${unreadable.length + pdfs.length} file(s) in ${fmtList} were NOT read -- this build decodes PNG and TIFF` +
        `${pdfs.length ? ', writes PDF but never rasterizes one' : ''}. Convert them (e.g. ` +
        "magick convert '*.jpg' -png out/page-%03d.png) or use the browser receiver, which decodes JPEG natively.",
    );
  }
  const dupes = [...seen.entries()].filter(([, n]) => n > 1).length;
  if (dupes) console.log(`  ${dupes} page(s) were supplied more than once (deduplicated)`);
  // A page the receiver had to rebuild from the parity pages is worth saying out loud: the user
  // printed N pages, fewer were accepted, and the file still came back -- without this line that
  // looks like the receiver silently skipped something (round 88). The assembler marks each
  // rebuilt page with stats.recovered (core/protocol.js:545).
  const rebuilt = [...asm.pages.entries()].filter(([, p]) => p && p.stats && p.stats.recovered).map(([i]) => i).sort((a, b) => a - b);
  if (rebuilt.length) {
    console.log(
      `  note: ${rebuilt.map((i) => `page ${i} (page-${String(i).padStart(3, '0')}.png)`).join(', ')} rebuilt from the parity pages (that is what they are for) -- ` +
        'the images for those pages were missing or unreadable, so nothing needs reprinting unless the digest below fails',
    );
  }

  const out = args.out ? resolve(args.out) : join(base, 'pskt-received.out');
  if (!asm.result) {
    const { dataHave, dataNeed, noSession } = asm.progress;
    if (asm.needPassphrase) {
      // Not the INCOMPLETE branch: every page arrived, and telling the user to reprint or rescan
      // would send them after the wrong thing (DEFECTS D66).
      console.log(`receive: NEEDS PASSPHRASE -- all ${dataNeed} data page(s) arrived, but this transfer is encrypted and no key was given`);
      console.log('  this is not a missing-page problem: re-run the same command with --passphrase <pw>');
      console.log('  the page images are still on disk -- nothing to reprint, nothing to rescan');
      console.log('  nothing was written: without the key there is no plaintext to match the declared digest against');
      process.exitCode = 2;
      return;
    }
    if (noSession) {
      // `names` is now only the readable files (round 83 split them out); the count the user needs is
      // how many images were offered in total, readable or not. The old expression referenced the
      // variable that split removed, so this branch threw a ReferenceError instead of printing a
      // diagnosis (measured by the user, round 90).
      console.log(
        `receive: INCOMPLETE -- not one page header could be read, so the receiver never learned the page geometry (` +
          `${seen.size} distinct page(s) read out of ${names.length + unreadable.length} image(s) offered` +
          `${unreadable.length ? `, ${unreadable.length} of them in a format this build cannot read (${fmtList})` : ''})`,
      );
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

/**
 * split / join. One transfer is at most 255 pages -- a page header stores totalPages in one byte
 * (core/frame.js:19) -- and the inter-page parity pages take slots out of that, so P-M1-300 at its
 * default 20% parity carries 1,592,968 B (measured in round 71 against the encoder itself). A bigger
 * file cannot be sent whole, and since round 71 the sender says so with numbers and tells the user to
 * split it -- which was a dead end until something split the file and something else put it back
 * (DEFECTS D65's "仍未做" item). The arithmetic lives in core/splitjoin.js, pure and unit-tested; this
 * is only IO, and it keeps the receiver's discipline: write to a temporary name and rename, and on any
 * digest mismatch write nothing at all.
 */
async function cmdSplit(args) {
  const sj = await import('../core/splitjoin.js');
  const src = args._[0];
  if (!src) throw new Error('usage: pskit split <file> [--max-bytes N] [--out DIR]');
  const from = resolve(src);
  if (!existsSync(from)) throw new Error(`no such file: ${from}`);
  if (statSync(from).isDirectory()) throw new Error(`${from} is a directory; split takes one file`);
  const maxBytes = args['max-bytes'] === undefined || args['max-bytes'] === true ? sj.DEFAULT_PART_BYTES : Number(args['max-bytes']);
  const bytes = new Uint8Array(readFileSync(from));
  const r = sj.splitParts(bytes, maxBytes);
  if (!r.ok) throw new Error(r.error);
  // Only a default for `join --out`. Like every name in this project it is never transmitted: the pages
  // carry bytes and a digest, nothing else (see docs/DEFECTS.md D62).
  r.manifest.source.name = basename(from);
  const outDir = resolve(args.out && args.out !== true ? args.out : join(dirname(from), `${basename(from, extname(from))}-parts`));
  mkdirSync(outDir, { recursive: true });
  for (const p of r.parts) writeFileSync(join(outDir, p.name), Buffer.from(p.bytes));
  const manifestPath = join(outDir, 'parts.json');
  const manifestTmp = `${manifestPath}.part`;
  writeFileSync(manifestTmp, JSON.stringify(r.manifest, null, 2));
  renameSync(manifestTmp, manifestPath);
  const widest = Math.max(...r.parts.map((p) => p.byteLength));
  console.log(`split ${bytes.length} B -> ${r.parts.length} part(s) in ${outDir}`);
  console.log(`  source sha256 ${r.manifest.source.sha256}`);
  console.log(`  largest part ${widest} B (ceiling ${maxBytes} B); one transfer carries 1592968 B at P-M1-300 with default parity`);
  console.log('  each part is its own transfer -- send it, print it, scan it, then receive it back into this same directory under the same name:');
  console.log(`    pskit send ${join(outDir, r.parts[0].name)} --profile P-M1-300 --sheet A4 --format png,pdf`);
  console.log(`    pskit receive <that part's page images> --out ${join(outDir, r.parts[0].name)}`);
  if (r.parts.length > 1) {
    console.log(`  ... and the same for ${sj.partName(1)} .. ${r.parts[r.parts.length - 1].name}: ${r.parts.length} transfers, ${r.parts.length} print/scan rounds`);
  }
  console.log(`  then put it back: pskit join ${outDir} --out <file>`);
  console.log('  join verifies every part digest and then the whole-file digest, so a part that came back wrong is a refusal, not a shorter file');
}

async function cmdJoin(args) {
  const sj = await import('../core/splitjoin.js');
  const src = args._[0];
  if (!src) throw new Error('usage: pskit join <dir|parts.json> --out <file>');
  const base = resolve(src);
  if (!existsSync(base)) throw new Error(`no such file or directory: ${base}`);
  const manifestPath = statSync(base).isDirectory() ? join(base, 'parts.json') : base;
  if (!existsSync(manifestPath)) throw new Error(`no manifest at ${manifestPath} (split writes parts.json next to the parts)`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const dir = dirname(manifestPath);
  const parts = [];
  for (const f of readdirSync(dir).sort()) {
    if (!/^part-\d+\.bin$/.test(f)) continue;
    parts.push({ name: f, bytes: new Uint8Array(readFileSync(join(dir, f))) });
  }
  const listed = Array.isArray(manifest?.parts) ? manifest.parts.length : 0;
  const r = sj.joinParts(manifest, parts);
  if (!r.ok) {
    console.log(`join: REFUSED -- ${r.error}`);
    console.log(`  ${r.checked} of ${listed} part(s) verified before the refusal; nothing was written`);
    console.log('  a missing, short or corrupt part makes a DIFFERENT file, and handing that over is the one outcome this tool refuses');
    process.exitCode = 1;
    return;
  }
  const named = args.out && args.out !== true ? resolve(args.out) : null;
  const out = named ?? join(dirname(dir), manifest.source?.name || 'pskt-joined.out');
  if (!named && existsSync(out)) {
    console.log(`join: REFUSED -- ${out} already exists and --out was not given`);
    console.log(`  the parts did verify (${r.checked} of ${listed}, sha256 ${r.sha256}); pass --out <file> to write them somewhere`);
    process.exitCode = 1;
    return;
  }
  mkdirSync(dirname(out), { recursive: true });
  const tmp = `${out}.part`;
  writeFileSync(tmp, Buffer.from(r.bytes));
  renameSync(tmp, out);
  console.log(`joined ${r.checked} part(s) -> ${r.bytes.length} B at ${out}`);
  console.log(`  sha256 ${r.sha256} MATCHES the manifest (${manifest.source.sha256})`);
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
    // The phone hint the web picker shows belongs here too: this table is where a CLI user chooses.
    // (PL-G is the profile PLAN §2/§3 calls readable by any phone; round 80 measured 8/8 byte-exact
    // with a whole plate in one phone frame, against 0/8 for the paper profile in the same framing.)
    const note = (p.note || '') + (p.phoneSafe ? '  [手机拍摄首选]' : '');
    console.log(
      `${r.profile.padEnd(10)} ${String(p.medium).padEnd(6)} ${(r.nozzle || '-').padEnd(6)} ${String(r.monoSafe).padEnd(9)} ` +
        `${String(r.pitchMm).padEnd(7)} ${(r.cols + 'x' + r.rows).padEnd(12)} ${String(r.netPerPage).padEnd(10)} ${String(r.rate).padEnd(5)} ${note}`,
    );
  }
  console.log('\nnozzles: ' + Object.entries(mod.nozzles.NOZZLES).map(([k, v]) => `${k}mm EW=${v.ewMm}`).join('  '));
  console.log(`universal floor PL-G pitch: ${mod.nozzles.UNIVERSAL_PITCH_MM}mm`);
  console.log('a phone camera needs a coarse profile: PL-G (3.12-7.6mm cells) reads at whole-page framing, a paper page (0.85mm cells) does not -- docs/USE.md section 2');
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
    ['P-MX-300-6', {}, 'PAPER1'],
    ['P-MX-300-5', {}, 'PAPER1'],
    ['P-MX-300-4', {}, 'PAPER1'],
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
        const read =
          t.geom.physicalEncoding === 'module'
            ? (await import('../core/decode/module-read.js')).readModuleIdeal(bm, layout, t.geom)
            : (await import('../core/decode/ideal.js')).readPageIdeal(bm, layout, t.geom, pal);
        for (let i = 0; i < read.levels.length; i++) {
          cells++;
          if (read.levels[i] !== p.levels[i]) misread++;
        }
        await asm.feed({
          levels: read.levels,
          header: p.header,
          channelMissing: read.colourAlive ? [] : ['colour'],
          cellMissing: read.cellMissing,
        });
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

  // ---- the recalibrated re-read seam must not be able to manufacture bytes ----
  // Added in round 63 together with the seam itself (DEFECTS D51). The tamper mix above feeds
  // asm.feed directly, so on its own it says nothing about the new acceptance path: a page whose
  // read the page code rejects is now offered a second read against a cut measured on that page.
  // These trials give that second read every chance to do harm -- rho is made consistent with a
  // THIRD reading, neither the damaged one nor the true one, so a re-read trusted on its own authority
  // would hand the assembler a page that is self-consistent and wrong. Acceptance still has to come
  // from the page's own RS, then the frame CRC, then the payload digest, so the only pass is "exact
  // original bytes or a refusal".
  //
  // It runs on P-M1-300 rather than this gate's PL-M1 because two-level paper is where the collapse
  // was measured and where a single cut means anything; shapeLevelsOf is asserted so that if the
  // alphabet ever grows past two levels this block fails loudly instead of quietly testing nothing.
  {
    const { feedPageWithRecalibration, shapeLevelsOf } = await import('../core/decode/recalibrate.js');
    const seamPid = 'P-M1-300';
    const seamGeom = mod.profiles.planPage(seamPid);
    if (shapeLevelsOf(seamGeom) !== 2) throw new Error(`G5 seam trials assume a two-level shape alphabet, ${seamPid} has ${shapeLevelsOf(seamGeom)}`);
    // Incompressible, or DEFLATE shrinks it to one page and the victim page never decides anything
    // (the same trap the foreign-page case below documents).
    const seamPayload = new Uint8Array(seamGeom.ecc.netBytesPerPage * 3);
    let y = 630063 >>> 0;
    for (let i = 0; i < seamPayload.length; i++) {
      y ^= y << 13; y >>>= 0; y ^= y >>> 17; y ^= y << 5; y >>>= 0;
      seamPayload[i] = y & 255;
    }
    const seamBase = await encodeTransfer(seamPayload, { profile: seamPid });
    const seamClone = (p) => ({ levels: p.levels.slice(), header: p.header.slice() });
    const seamTrials = 2000;
    let seamFalse = 0;
    let seamRecovered = 0;
    let seamRefused = 0;
    let seamRetried = 0;
    for (let k = 0; k < seamTrials; k++) {
      const pages = seamBase.pages.map(seamClone);
      const victimIdx = (rnd() * pages.length) | 0;
      const victim = pages[victimIdx];
      const truth = seamBase.pages[victimIdx].levels;
      // Heavy damage: 20-80% of the page rewritten, the mode that actually reaches intra-fail.
      const n = Math.floor(victim.levels.length * (0.2 + rnd() * 0.6));
      for (let i = 0; i < n; i++) victim.levels[(rnd() * victim.levels.length) | 0] = (rnd() * (1 << seamGeom.bitsPerCell)) | 0;
      // rho consistent with a third reading: the truth with a further random subset of shape bits
      // flipped, so the re-read is neither a repair nor a copy of the damage.
      const rho = new Float32Array(victim.levels.length);
      const colourLevels = new Uint8Array(victim.levels.length);
      for (let i = 0; i < victim.levels.length; i++) {
        const truthShape = mod.protocol.splitCellLevel(truth[i], seamGeom).shape;
        const third = rnd() < 0.35 ? truthShape ^ 1 : truthShape;
        rho[i] = (third ? 1.68 : 1.27) + rnd() * 0.02;
        colourLevels[i] = mod.protocol.splitCellLevel(victim.levels[i], seamGeom).colour | 0;
      }
      const asm2 = new TransferAssembler();
      for (let pi = 0; pi < pages.length; pi++) {
        const p = pages[pi];
        const decoded =
          pi === victimIdx
            ? { levels: p.levels, headerBytes: p.header, colourAlive: true, rho, colourLevels }
            : { levels: p.levels, headerBytes: p.header, colourAlive: true };
        const res = await feedPageWithRecalibration(asm2, decoded, { geom: seamGeom });
        if (res.retried) seamRetried++;
      }
      if (asm2.result) {
        const same = asm2.result.length === seamPayload.length && asm2.result.every((v, i) => v === seamPayload[i]);
        if (same) seamRecovered++;
        else seamFalse++;
      } else {
        seamRefused++;
      }
    }
    // Anti-vacuity: if the seam never fired, this block proved nothing and must not print PASS.
    const seamOk = seamFalse === 0 && seamRetried > 0;
    ok &&= seamOk;
    console.log(
      `  ${seamOk ? 'PASS' : 'FAIL'} ${seamTrials} recalibrated-seam trials on ${seamPid}: ${seamRecovered} recovered exactly, ${seamRefused} refused, ${seamFalse} FALSE ACCEPTS` +
        ` (re-read offered ${seamRetried} times; rho described a third reading, so the seam had every chance to invent bytes)`,
    );
  }

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

/**
 * G2 -- paper at 300/600 dpi, fixed seeds, <=1 MB payload, 100% byte-identical.
 *
 * The corpora are made out of band by sim/channel.py, because spawning Python is denied in
 * this sandbox and because that split is the honest one: a gate that generated its own channel
 * could quietly start agreeing with itself. What runs here is tools/g2-corpus.mjs, imported
 * rather than copied, so the digest comparison, the failure classification and the
 * 100%-or-fail arithmetic stay in exactly one place.
 *
 * Two ways this could print a green that is not G2, both closed here: an empty run (no corpora
 * is a broken harness, not a pass), and a pristine corpus -- nothing on disk distinguishes one
 * from a scanned one, so corpusProvenance measures the tone spread and refuses it.
 */
async function gateG2(args) {
  if (!args.corpus && !args.root) {
    return {
      skipped:
        'no --corpus DIR given; G2 consumes pages made out of band by sim/channel.py ' +
        '(python sim/channel.py --in SRC --out DST --seed N --preset scan300 --modifier nocrop), ' +
        'then: verify --gate G2 --corpus DST',
    };
  }
  const g2 = await import('../tools/g2-corpus.mjs');
  const opts = g2.parse([]);
  if (args.corpus) opts.dirs.push(String(args.corpus));
  if (args.root) {
    opts.root = String(args.root);
    opts.match = String(args.match || '*');
  }
  const dirs = g2.collect(opts);
  if (!dirs.length) {
    console.log('  FAIL G2: no corpus directories found (each needs manifest.json + at least one .png)');
    return false;
  }
  const mod = await g2.buildMod({ photo: !args.fast });
  const results = [];
  const t0 = performance.now();
  for (const d of dirs) {
    const prov = g2.corpusProvenance(d);
    if (!prov.channelDegraded) {
      console.log(`  FAIL G2: ${d} looks pristine (${prov.median} grey levels in ${prov.firstPage}, floor ${prov.floor})`);
      console.log('       a pristine render decodes byte-exact, so it would print 100% while measuring');
      console.log('       nothing: G2 is about pages that went through the channel. Regenerate them with');
      console.log('       sim/channel.py, or point --corpus at a directory that was.');
      return false;
    }
    const r = await g2.runCorpus(d, mod);
    results.push(r);
    console.log(`       ${String(r.dir).padEnd(22)} ${r.ok ? 'OK  ' : 'FAIL'}  ${r.ok ? `${r.bytes} bytes, digest verified` : `FAILED (${r.reason})`}`);
    for (const f of r.failures || []) console.log(`         - ${f}`);
  }
  const passed = results.filter((r) => r.ok).length;
  const secs = ((performance.now() - t0) / 1000).toFixed(1);
  const ok = passed === results.length;
  // PLAN names 200 fixed seeds. Printing the count this run actually had keeps "G2 PASS" from
  // being read as "the stated sample size was met" when it was not.
  console.log(`  ${ok ? 'PASS' : 'FAIL'} G2 corpus: ${passed}/${results.length} byte-exact in ${secs}s (criterion is 100%; PLAN asks for 200 fixed seeds, this run had ${results.length})`);
  if (!ok) {
    const classes = {};
    for (const r of results) if (!r.ok) classes[r.reason] = (classes[r.reason] || 0) + 1;
    console.log(`       failure classes: ${Object.entries(classes).map(([k, v]) => `${k} x${v}`).join(', ')}`);
  }
  return ok;
}

/**
 * G8 -- the half of the 3D-artifact gate that can run in process.
 *
 * It builds a plate .3mf with our own encoder and hands the bytes to tools/check-3mf.mjs, which
 * checks the Core 1.4 subset from the file alone and deliberately without the writer's parser:
 * `parseModelXml` only recognises the exact shape our emitter produces, so a checker built on it
 * could not notice that the shape itself is not what the schema allows. The rules are read against
 * the schema vendored in this repository, `ref/3mf-core-1.4.0.xsd`; the first version of them was
 * taken from a schema fetched off the web and produced a false finding against our own emitter,
 * recorded and withdrawn as D40 (docs/DEFECTS.md).
 *
 * G8's other half (projecting the solid back onto the cell grid and comparing with the raster
 * mask) needs Python + OpenCV, so it stays a documented command in docs/ACCEPTANCE.md rather than
 * a printed guess here: the same split G2 uses, because spawning is denied in this sandbox and a
 * gate only I could run would not be a gate the user can reproduce.
 */
async function gateG8(args) {
  const check = await import('../tools/check-3mf.mjs');
  const targets = [];
  if (args.file) {
    const { readFileSync } = await import('node:fs');
    for (const f of String(args.file).split(',')) targets.push({ label: f, bytes: new Uint8Array(readFileSync(f)) });
  } else {
    const protocol = await import('../core/protocol.js');
    const layoutMod = await import('../core/render/layout.js');
    const plate = await import('../core/mesh/plate.js');
    const three = await import('../core/mesh/threeMF.js');
    const profileId = String(args.profile || 'PL-D2');
    const nozzle = String(args.nozzle || '0.4');
    const t = await protocol.encodeTransfer(new Uint8Array(64).fill(0x5a), { profile: profileId, nozzle });
    // A plate profile carries no dpi of its own (PL-D2's is undefined, geom.dpi is null), so this
    // is the canonical plate call used by `pskit send` and by the mesh tests: 300 dpi, 200 mm.
    const layout = layoutMod.pageLayout(t.geom, 300, { plateMm: 200 });
    const model = plate.buildPlateModel({ geom: t.geom, levels: t.pages[0].levels, layout });
    const bytes = three.encode3MF({ objects: model.objects, metadata: { 'pskt:profile': profileId, 'pskt:page': 0 } });
    const self = three.selfCheck3MF(bytes, { expectTriangles: model.facts.trianglesTotal });
    console.log(`       built in process: ${profileId}@${nozzle} -> ${model.objects.length} objects, ${model.facts.trianglesTotal} triangles, ${bytes.length} bytes; selfCheck3MF ${self.ok ? 'ok' : `REFUSED: ${self.issues.join('; ')}`}`);
    targets.push({ label: `${profileId}@${nozzle} (in process)`, bytes });
  }
  let ok = true;
  for (const target of targets) {
    const r = check.validate3MF(target.bytes);
    const s = r.stats;
    const shape = s && s.model ? `${s.parts} parts, ${s.model.objects} objects / ${s.model.triangles} triangles / ${s.model.vertices} vertices, unit ${s.model.unit}` : s ? `${s.parts} parts` : '';
    console.log(`       ${r.ok ? 'OK  ' : 'FAIL'} ${target.label}  ${shape}`);
    for (const i of r.issues.slice(0, 12)) console.log(`         - ${i}`);
    if (r.issues.length > 12) console.log(`         ... and ${r.issues.length - 12} more`);
    if (!r.ok) ok = false;
  }
  console.log(`  ${ok ? 'PASS' : 'FAIL'} G8 subset: ${targets.length} file(s) checked against 3MF Core 1.4 (package parts, content types, relationships, model part), rules taken from the vendored ref/3mf-core-1.4.0.xsd. Not schema conformance -- there is no XSD engine here: docs/ACCEPTANCE.md G8.`);
  return ok;
}

async function gateG6(args) {
  // The implementation lives in tools/soak.mjs so it can also run standalone as a background task
  // (node tools/soak.mjs --minutes 30 --out .tmp/g6.json). The criterion is quoted there from
  // docs/PLAN.md L106; this wrapper only turns the result into an exit code.
  const { runSoak } = await import('../tools/soak.mjs');
  const corpora = args.corpus ? String(args.corpus).split(',') : [];
  const res = await runSoak({ minutes: Number(args.minutes || 30), corpus: corpora });
  console.log(`  ${res.ok ? 'PASS' : 'FAIL'} G6: criterion per docs/PLAN.md L106 -- encode 1MB <= 5s, decode <= 2s/page, a 30-60 min soak with RSS growth <= 10% and zero false accepts. Not covered here: the optical channel model, real ink/paper, phones, browsers (that is G2/G4/G9 evidence).`);
  return res.ok;
}

async function cmdVerify(args) {
  const gate = String(args.gate || 'all');
  // G6 stays out of 'all' on purpose: its criterion is a 30-60 minute soak, so folding it into the
  // routine baseline would make every --gate all run half an hour long and hide the fast gates'
  // regressions behind it. It is opt-in, and the summary line below says so out loud.
  const wanted = gate === 'all' ? ['G0', 'G1', 'G2', 'G3', 'G5', 'G7', 'G8'] : [gate.toUpperCase()];
  const runners = { G0: gateG0, G1: gateG1, G2: gateG2, G3: gateG3, G5: gateG5, G6: gateG6, G7: gateG7, G8: gateG8 };
  let allOk = true;
  const skipped = [];
  for (const g of wanted) {
    const r = runners[g];
    if (!r) {
      console.log(`${g}: not implemented yet (have: ${Object.keys(runners).join(', ')})`);
      allOk = false;
      continue;
    }
    console.log(`--- ${g} ---`);
    const ok = await r(args);
    // A runner may report that it could not evaluate anything. That is not a pass, and it
    // cannot be left to `allOk &&= ok`: an object is truthy, so a skip would have been counted
    // as green. Skips are named in the summary line instead of being folded into it.
    if (ok && typeof ok === 'object' && ok.skipped) {
      skipped.push(`${g}: ${ok.skipped}`);
      continue;
    }
    allOk &&= ok;
  }
  const evaluated = wanted.length - skipped.length;
  // The "ALL GATES PASS" prefix stays greppable; what changed is that it now says out loud
  // which gates were not evaluated, so a run cannot be quoted as covering more than it did.
  console.log(
    allOk
      ? `\nALL GATES PASS${skipped.length ? ` -- ${evaluated}/${wanted.length} evaluated, ${skipped.length} skipped\n  ${skipped.join('\n  ')}` : ''}`
      : '\nGATE FAILURE',
  );
  // Name what this run did not cover, so a quoted "ALL GATES PASS" cannot be read as more than it
  // is. G8 joined 'all' in the round it went green; it had been held out while it was red, because
  // folding a known-red gate in would make every run red and hide regressions in the green ones.
  const notHere = ['G0', 'G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8', 'G9', 'G10'].filter((g) => !wanted.includes(g));
  if (notHere.length) {
    console.log(`  not evaluated by this run: ${notHere.join(' ')}`);
    console.log('    G4 G9 need a real phone/browser; G6 is implemented now but its criterion is a 30-60 min soak, so it stays opt-in (--gate G6); G10 needs a printer');
  }
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

/**
 * `pskit calibrate --make-mtf` -- write the MTF calibration plate (PLAN §3.4).
 *
 * Writes two files: the appearance raster (`mtf-plate.png`) and the spec
 * (`mtf-plate.json`) that says what is printed where. The reader needs the spec; without it
 * the picture is just a picture. Both are deterministic from the flags alone.
 *
 * `--print-ew` is a **simulation** flag: it makes the renderer emulate a printer whose
 * smallest feature is that wide, by filling every hole narrower than it (see
 * core/calibrate/mtfplate.js). A real print does that by itself; the flag exists so the
 * probe in tools/mtf-probe.ps1 can put a known nozzle through the Python channel.
 */
async function cmdMakeMtf(args, mod) {
  const { mtfPlateSpec, renderMtfPlate, describeMtfPlate } = await import('../core/calibrate/mtfplate.js');
  const spec = mtfPlateSpec({
    plateMm: args['plate-mm'] ? Number(args['plate-mm']) : undefined,
    dpi: args.dpi ? Number(args.dpi) : undefined,
    palette: args.palette || 'INK2',
  });
  const printEwMm = args['print-ew'] ? Number(args['print-ew']) : 0;
  const outDir = resolve(args.out || args._[0] || '.');
  mkdirSync(outDir, { recursive: true });
  const formats = String(args.format || 'png,pdf-free')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const wantPng = formats.includes('png') || formats.includes('all');
  const wantModel = formats.includes('3mf') || formats.includes('stl') || formats.includes('all');
  const specPath = join(outDir, 'mtf-plate.json');
  writeFileSync(specPath, JSON.stringify({ ...spec, renderedPrintEwMm: printEwMm }, null, 1));
  console.log(`mtf-plate: ${describeMtfPlate(spec)}`);
  if (printEwMm > 0) console.log(`  emulated printer  smallest feature ${printEwMm}mm (holes narrower than this are filled)`);
  if (wantPng) {
    const img = renderMtfPlate(spec, { printEwMm });
    const pngPath = join(outDir, 'mtf-plate.png');
    writeFileSync(pngPath, mod.png.encodePNG(img));
    console.log(`  wrote            ${pngPath} (${img.width}x${img.height}px @ ${spec.dpi}dpi) -- what a camera/scanner sees`);
  }
  if (wantModel) {
    const { buildMtfPlateModel, projectionReport } = await import('../core/mesh/mtfplate.js');
    const model = buildMtfPlateModel(spec, { printEwMm });
    const proj = projectionReport(model, spec);
    if (!proj.ok) {
      throw new Error(
        `calibrate --make-mtf: the mesh does not reproduce the plate spec -- worst region ${proj.maxPct * 100}% off ` +
          `(${proj.regions.filter((r) => !r.ok).map((r) => r.id).join(', ') || 'total'}); refusing to write the model`,
      );
    }
    const three = await import('../core/mesh/threeMF.js');
    const stlMod = await import('../core/mesh/stl.js');
    for (const o of model.objects) {
      const mr = three.manifoldReport(o.triangles);
      if (!mr.ok) throw new Error(`calibrate --make-mtf: ${o.name} is not watertight: ${mr.issues.join('; ')}`);
    }
    if (formats.includes('stl') || formats.includes('all')) {
      const bytes = stlMod.encodeSTLSolid(model.triangles, { name: 'PSKT-MTF' });
      writeFileSync(join(outDir, 'mtf-plate.stl'), bytes);
      console.log(`  wrote            ${join(outDir, 'mtf-plate.stl')} (${model.facts.trianglesTotal} triangles, ${Math.round(bytes.length / 1024)} KB)`);
    }
    if (formats.includes('3mf') || formats.includes('all')) {
      const bytes = three.encode3MF({
        objects: model.objects,
        metadata: { 'pskt:plate': 'mtf', 'pskt:dpi': String(spec.dpi), 'pskt:palette': spec.palette },
      });
      const chk = three.selfCheck3MF(bytes, { expectTriangles: model.facts.trianglesTotal });
      if (!chk.ok) throw new Error(`calibrate --make-mtf: selfCheck3MF refused: ${chk.issues.join('; ')}`);
      writeFileSync(join(outDir, 'mtf-plate.3mf'), bytes);
      console.log(`  wrote            ${join(outDir, 'mtf-plate.3mf')} (${model.objects.length} objects, ${Math.round(bytes.length / 1024)} KB)`);
    }
    console.log(
      `  model            base ${model.facts.baseMm}mm + relief ${model.facts.reliefMm}mm; ink ${proj.declaredMm2}mm^2 projected ${proj.projectedMm2}mm^2 ` +
        `(worst region ${proj.maxPct * 100}% off, tolerance ${proj.tolerancePct}%); every object watertight`,
    );
  }
  console.log(`  wrote            ${specPath}  <- the reader needs this file`);
}

/**
 * `pskit calibrate <png> --mtf` -- read a capture of that plate.
 *
 * Prints the two ladders cell by cell, the colour/texture/ruler measurements, and one
 * recommendation. Like the rest of `calibrate`, the exit code is **not** a verdict on the
 * plate: a capture that registers but resolves nothing is data, not a tool error. `--json`
 * writes the machine-readable result next to the capture, which is what tools/mtf-probe.ps1
 * reads.
 */
async function cmdReadMtf(args, mod) {
  const { decodePNG } = await import('../core/decode/png-read.js');
  const { readMtfPlate, recommendFromMtf, describeMtfMeasurement } = await import('../core/calibrate/readmtf.js');
  const target = resolve(args._[0] || '.');
  const st = statSync(target);
  const files = st.isDirectory()
    ? readdirSync(target).filter((n) => /\.(png|tif|tiff)$/i.test(n)).sort().map((n) => join(target, n))
    : [target];
  if (!files.length) throw new Error(`calibrate --mtf: no image found in ${target}`);
  const specPath = args.spec
    ? resolve(args.spec)
    : join(st.isDirectory() ? target : dirname(target), 'mtf-plate.json');
  if (!existsSync(specPath)) {
    throw new Error(`calibrate --mtf: no plate spec at ${specPath} (run \`calibrate --make-mtf\` first, or pass --spec)`);
  }
  const spec = JSON.parse(readFileSync(specPath, 'utf8'));
  console.log(`mtf: spec ${specPath}`);
  let worst = null;
  for (const file of files) {
    const bytes = new Uint8Array(readFileSync(file));
    let bitmap;
    try {
      bitmap = decodePNG(bytes);
    } catch (e) {
      console.log(`  ${basename(file)}: not a readable PNG (${e.message})`);
      continue;
    }
    const t0 = performance.now();
    const m = readMtfPlate(bitmap, spec, { texture: !args.fast, ruler: !args.fast });
    const rec = recommendFromMtf(m, { plateMm: spec.plateMm });
    const ms = Math.round(performance.now() - t0);
    console.log(`  ${basename(file)} [${ms}ms]`);
    for (const line of describeMtfMeasurement(m, rec)) console.log(`  ${line}`);
    if (args.json) {
      const outPath = join(dirname(file), `${basename(file).replace(/\.[^.]+$/, '')}.mtf.json`);
      writeFileSync(outPath, JSON.stringify({ file: basename(file), spec: specPath, measurements: m, recommendation: rec }, null, 1));
      console.log(`  wrote            ${outPath}`);
    }
    worst = rec;
  }
  if (!worst) console.log('  nothing measured');
}

/**
 * `pskit calibrate <dir|file>` -- measure a captured page set. Change no decision.
 *
 * This is the *measurement* half of the calibrate PLAN puts in M7. It exists because
 * the ledger kept having to leave one question open: D49 -- G2 measured 200/200 at
 * 300 dpi and 162/200 at 600 dpi, and "the intra-page ECC margin is too thin" was a
 * hypothesis, not a measurement. What separates the candidate explanations is how
 * much of the error-correction budget a page actually spends:
 *
 *   - pages clustering just under 100% => the profile sits at the cliff, i.e. a
 *     capacity/margin problem (the fix is more parity or a coarser pitch);
 *   - most pages near zero with a few past 100% => bimodal, i.e. something geometric
 *     or photometric destroys individual pages, and more parity would not save those
 *     pages at all.
 *
 * Two deliberate limits:
 *
 *   1. It reuses the receive path verbatim -- same decodePage, same
 *      TransferAssembler.feed -- so the numbers describe this product instead of a
 *      parallel implementation free to drift from it. `feed` already returns the
 *      intraDecode statistics on both the rejection path (core/protocol.js:484) and
 *      the success path (:489), so nothing under core/ had to change for this.
 *   2. It derives NO threshold and wires nothing into the detector. Searching for a
 *      binarisation cut was disproved in round 15 (it asks for x1.3 on a pristine
 *      render), and any change to decode decisions makes acceptance easier, so it
 *      would have to be re-judged against G5 (false accepts) first. The ink-area
 *      ratio printed here is a health indicator only, and carries the caveats written
 *      in core/decode/calibrate.js's own header (it measures bleed as much as
 *      coverage, and it was built on a premise that round 15 falsified).
 *
 * It is NOT a gate and its exit code is NOT a verdict: a page that fails to read is
 * data here, not a tool error. G2 remains the judgement (`verify --gate G2`).
 */
async function cmdCalibrate(args) {
  const mod = await load();
  if (args['make-mtf']) return cmdMakeMtf(args, mod);
  if (args.mtf) return cmdReadMtf(args, mod);
  const { decodePNG } = await import('../core/decode/png-read.js');
  const { decodeTIFF } = await import('../core/decode/tiff-read.js');
  const { decodePage } = await import('../core/decode/page.js');
  const { advise } = await import('../core/decode/advice.js');
  const { feedPageWithRecalibration } = await import('../core/decode/recalibrate.js');
  const { inkness } = await import('../core/decode/fiducial.js');
  const { expectedInkArea, integratedInkArea } = await import('../core/decode/calibrate.js');

  const dir = resolve(args._[0] || '.');
  const dst = statSync(dir);
  const names = dst.isDirectory()
    ? readdirSync(dir).filter((n) => /\.(png|tif|tiff|jpe?g|webp)$/i.test(n)).sort()
    : [basename(dir)];
  const base = dst.isDirectory() ? dir : dirname(dir);
  if (!names.length) throw new Error(`calibrate: no page images found in ${dir}`);
  const manifestPath = join(base, 'manifest.json');
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null;
  const profileId = args.profile || manifest?.profile;
  const nozzle = args.nozzle || manifest?.nozzle;
  const dpi = args.dpi ? Number(args.dpi) : manifest?.dpi || 300;
  const paletteId = args.palette || manifest?.palette || 'INK2';
  if (!profileId) {
    throw new Error(
      `calibrate: ${dir} has no manifest.json and no --profile was given, so the page geometry is unknown. ` +
        'Pass the profile the pages were printed with (e.g. --profile P-M1-300), or point --spec at the plate spec that calibrate --make-mtf wrote.',
    );
  }
  const plateMm = args.plate ? Number(args.plate) : manifest?.plateMm;
  const geom = mod.profiles.planPage(profileId, { nozzle, plateMm, monoSafe: manifest?.monoSafe });
  const layout = mod.layoutMod.pageLayout(geom, dpi, { plateMm });
  const exp = expectedInkArea(geom, layout.glyph, { dpi });
  const median = (a) => {
    if (!a.length) return NaN;
    const s = [...a].sort((x, y) => x - y);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };

  console.log(`calibrate: ${dir}`);
  console.log(
    `  geometry   profile ${profileId}  dpi ${dpi}  palette ${paletteId}  layout ${layout.width}x${layout.height}px` +
      `  intra RS k=${geom.ecc.intra.k} nsym=${geom.ecc.intra.nsym}` +
      (exp.ok ? `  expected ink fraction ${exp.expectedFraction.toFixed(4)}` : `  expected ink unavailable (${exp.reason})`),
  );
  console.log(
    '  budget     (2*errors + erasures) / (blocks * nsym): an error costs two units, an erasure one; over 100% = past what intra-page RS can absorb',
  );

  const asm = new mod.protocol.TransferAssembler({ passphrase: args.passphrase });
  const opts = { allowFastPath: !args.photo, requireFastPath: false, log: null };
  const rows = [];
  // PNG and TIFF both decode now, and a multi-page TIFF expands into one measurement per page
  // (DEFECTS D82). JPEG/WebP are still named as skipped rather than silently ignored.
  const images = [];
  for (const name of names) {
    const bytes = new Uint8Array(readFileSync(join(base, name)));
    try {
      if (/\.(tiff?)$/i.test(name)) {
        const { pages } = decodeTIFF(bytes);
        pages.forEach((bitmap, i) => images.push({ label: pages.length > 1 ? `${name} [page ${i}]` : name, bitmap }));
      } else if (/\.png$/i.test(name)) {
        images.push({ label: name, bitmap: decodePNG(bytes) });
      } else {
        console.log(`  ${name}: skipped (this build decodes PNG and TIFF; see receive's note on converting)`);
      }
    } catch (e) {
      console.log(`  ${name}: not a readable image (${e.message})`);
      rows.push({ name, stage: 'file', reason: e.message });
    }
  }
  for (const { label: name, bitmap } of images) {
    bitmap.substrate = bitmap.substrate || mod.palette.getPalette(paletteId).background;
    const t0 = performance.now();
    const r = decodePage(bitmap, { geom, layout, paletteId }, opts);
    const ms = Math.round(performance.now() - t0);
    if (!r.ok) {
      const a = advise(r);
      console.log(`  ${name}: FAIL ${r.stage}/${r.reason} [${ms}ms]`);
      console.log(`      cause: ${a.cause}`);
      rows.push({ name, stage: r.stage, reason: r.reason, ms });
      continue;
    }
    // Arbitrated feed, shared with web/app.js and the G2 harness: the matched-filter read goes first
    // and a recalibrated re-read is offered only after the page's own code rejected it. A page that
    // decodes today is read bit-identically today, because the retry never runs (DEFECTS D51).
    const resc = await feedPageWithRecalibration(asm, r, { geom, log: null });
    const fed = resc.fed;
    if (resc.retried) {
      const e = resc.estimate || {};
      // The note names its own file and page. This line prints BEFORE the page's own status line, so
      // without the name it reads as a comment on the previous page -- a misreading that is not
      // hypothetical: it fooled me while writing this round's ledger, and a user must not have to
      // guess which page was rescued. Ambiguous success output is how wrong conclusions get recorded.
      console.log(
        `      ${name} (page ${r.header?.pageIndex ?? '?'}): ${fed.ok ? 'RESCUED' : 're-read also rejected'}` +
          ` -- shape levels re-decided against a cut measured on this page` +
          ` (cut ${e.cut?.toFixed(4)}, clusters ${e.m0?.toFixed(3)}/${e.m1?.toFixed(3)}, separation ${e.separation?.toFixed(2)}${e.unimodal ? ', UNIMODAL' : ''},` +
          ` ${resc.changed} cells changed)${fed.ok ? '; accepted because the page code accepted it, not because of the cut' : ` (${resc.secondReason})`}`,
      );
    }
    const h = r.header || {};
    const ink = integratedInkArea(inkness(bitmap));
    const ratio = ink.ok && exp.ok ? ink.fraction / exp.expectedFraction : NaN;
    const s = fed.stats;
    if (!s) {
      console.log(
        `  ${name}: page ${h.pageIndex ?? '?'} ${fed.duplicate ? 'duplicate -- nothing new to measure' : `not fed (${fed.reason || 'no stats'})`} [${ms}ms]`,
      );
      rows.push({ name, page: h.pageIndex, stage: 'assemble', reason: fed.duplicate ? 'duplicate' : fed.reason || 'no-stats', ms, ratio });
      continue;
    }
    const nsym = h.intraNsym || geom.ecc.intra.nsym;
    const capacity = s.blocks * nsym;
    // Blocks that fail report no error count at all (core/protocol.js:247 just pushes
    // the index and moves on), so each is charged its whole budget. The percentage is
    // therefore a LOWER bound whenever failedBlocks is non-empty -- saying so on the
    // same line is what keeps this a measurement instead of a number that quietly
    // flatters the profile.
    const lowerBound = 2 * s.errors + s.erasures + s.failedBlocks.length * nsym;
    const pct = capacity > 0 ? (lowerBound / capacity) * 100 : NaN;
    rows.push({ name, page: h.pageIndex, ms, ratio, pct, s, ok: !!fed.ok, reason: fed.ok ? null : fed.reason });
    console.log(
      `  ${name}: page ${h.pageIndex ?? '?'} read out [${ms}ms] path=${r.path}` +
        (r.path === 'photo' ? ` marker ${r.markerPx?.toFixed(1)}px cover ${((r.coverage || 0) * 100).toFixed(0)}%` : '') +
        (r.colourAlive ? '' : ' [colour channel dead -> erasure]') +
        (fed.ok ? '' : ` REJECTED (${fed.reason})`),
    );
    console.log(
      `      ecc      blocks ${s.blocks}  clean ${s.cleanBlocks}  errors ${s.errors}  erasures ${s.erasures}  failedBlocks ${s.failedBlocks.length}` +
        `  (k=${h.intraK ?? geom.ecc.intra.k} nsym=${nsym})`,
    );
    console.log(
      `      budget   ${lowerBound}/${capacity} units = ${pct.toFixed(1)}%` +
        (s.failedBlocks.length ? '  LOWER BOUND (failed blocks report no error count; each is charged its whole budget)' : ''),
    );
    console.log(
      `      ink      integrated ${ink.ok ? ink.fraction.toFixed(4) : 'n/a'} / expected ${exp.ok ? exp.expectedFraction.toFixed(4) : 'n/a'}` +
        (Number.isFinite(ratio) ? ` = ${ratio.toFixed(2)}x  (health check only -- it measures bleed as much as coverage)` : '  (ratio unavailable)'),
    );
  }

  const measured = rows.filter((r) => r.s);
  const dead = rows.filter((r) => !r.s);
  console.log('  ---');
  console.log(`  summary    ${names.length} image(s): ${measured.length} read out with ECC stats, ${dead.length} not measured`);
  if (dead.length) {
    const by = new Map();
    for (const d of dead) {
      const k = `${d.stage || '?'}/${d.reason || '?'}`;
      by.set(k, (by.get(k) || 0) + 1);
    }
    for (const [k, n] of [...by.entries()].sort((a, b) => b[1] - a[1])) console.log(`      not measured: ${k} x${n}`);
  }
  if (measured.length) {
    const pcts = measured.map((r) => r.pct).filter(Number.isFinite);
    const ratios = measured.map((r) => r.ratio).filter(Number.isFinite);
    const cleanPages = measured.filter((r) => r.s.failedBlocks.length === 0 && r.s.errors === 0 && r.s.erasures === 0).length;
    const blocks = measured.reduce((a, r) => a + r.s.blocks, 0);
    const cleanBlocks = measured.reduce((a, r) => a + r.s.cleanBlocks, 0);
    const failedBlocks = measured.reduce((a, r) => a + r.s.failedBlocks.length, 0);
    const anyLB = measured.some((r) => r.s.failedBlocks.length > 0);
    console.log(
      `      budget   min ${Math.min(...pcts).toFixed(1)}%  median ${median(pcts).toFixed(1)}%  max ${Math.max(...pcts).toFixed(1)}%` +
        (anyLB ? '  (at least one page is a LOWER bound)' : ''),
    );
    console.log(
      `      pages    perfectly clean ${cleanPages}/${measured.length}  blocks clean ${cleanBlocks}/${blocks}  blocks failed ${failedBlocks}`,
    );
    if (ratios.length) {
      console.log(
        `      ink      ratio min ${Math.min(...ratios).toFixed(2)}x  median ${median(ratios).toFixed(2)}x  max ${Math.max(...ratios).toFixed(2)}x`,
      );
    }
  }
  console.log('  note       this command measured; it changed no decode decision and derived no threshold. It is not a gate.');
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];
try {
  if (args.help || !cmd) console.log(HELP);
  else if (cmd === 'send') await cmdSend(args._.length > 1 ? { ...args, _: args._.slice(1) } : args);
  else if (cmd === 'receive') await cmdReceive({ ...args, _: args._.slice(1) });
  else if (cmd === 'split') await cmdSplit({ ...args, _: args._.slice(1) });
  else if (cmd === 'join') await cmdJoin({ ...args, _: args._.slice(1) });
  else if (cmd === 'calibrate') await cmdCalibrate({ ...args, _: args._.slice(1) });
  else if (cmd === 'status') await cmdStatus();
  else if (cmd === 'verify') await cmdVerify(args);
  else if (cmd === 'roundtrip') await cmdRoundtrip(args);
  else console.log(`unknown command "${cmd}"\n\n${HELP}`);
} catch (e) {
  // Many messages name their own command ("receive: no pages found in ...") because they are also
  // read from tests and from other tools; without this the CLI would print
  // "pskit receive: receive: no pages found". Strip one duplicate prefix instead of rewriting
  // every throw, so both audiences keep the wording they match on.
  const msg = String((e && e.message) || e).replace(new RegExp(`^${cmd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\s*`), '');
  console.error(`pskit ${cmd}: ${msg}`);
  if (process.env.PSKIT_TRACE) console.error(e.stack);
  process.exitCode = 1;
}
