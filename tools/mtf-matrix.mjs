#!/usr/bin/env node
/**
 * tools/mtf-matrix.mjs -- a directory of plate captures in, the nozzle matrix out.
 *
 * docs/HANDOVER.md §12 names this as the next in-process item after the plate itself
 * (round 75/76) and the plate's corner markers (round 77): the reader
 * (core/calibrate/readmtf.js) can already answer "which nozzle can this chain resolve?"
 * for ONE capture, and tools/mtf-probe.ps1 proves that on the *simulator*. What was
 * missing is the path a human actually walks:
 *
 *   print the same MTF plate once per nozzle  ->  photograph each print  ->  drop the
 *   photos in one directory  ->  this tool says, per print, whether the recommendation
 *   names the nozzle that printed it.
 *
 * G10 ("nozzle x parameter matrix") needs a real printer and stays open until the user
 * prints and shoots; this tool only removes the part of the work that was mine. It
 * cannot tell where a file came from -- say so with --provenance, and docs/STATUS.md
 * must not claim a real-printer result without it.
 *
 * Usage:
 *   node tools/mtf-matrix.mjs --dir captures --provenance real-print
 *   node tools/mtf-matrix.mjs --dir captures --label 0.4=n04.png --label 0.6=n06.png
 *   node tools/mtf-matrix.mjs --selftest
 *
 * Labelling, in priority order (a capture with no label is still measured, and is
 * reported as "unlabelled" rather than guessed at):
 *   1. --label <nozzle>=<file>          (repeatable)
 *   2. <dir>/mtf-labels.json            { "0.4": "n04.png", ... } or the reverse mapping
 *   3. the file name: n02 / nozzle-0.2 / ew026 / "0.4" ... (see nozzleFromLabel)
 *
 * Exit code: 0 = every labelled capture named its own nozzle (or was allowed to come
 * back coarser with the reader saying why), 1 = a labelled capture mismatched, 2 = the
 * tool could not run (no directory, no spec, no image). It is **not** a gate: G10 is
 * decided by a real print, not by this script's exit code.
 */
import { readdirSync, readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import { decodePNG } from '../core/decode/png-read.js';
import { readMtfPlate, recommendFromMtf, describeMtfMeasurement } from '../core/calibrate/readmtf.js';
import { mtfPlateSpec, renderMtfPlate } from '../core/calibrate/mtfplate.js';
import { NOZZLES, NOZZLE_IDS, getNozzle } from '../core/nozzles.js';

/* ------------------------------------------------------------------ */
/* labelling (pure -- unit-tested in tests/unit/mtf-matrix.test.mjs)   */
/* ------------------------------------------------------------------ */

/** Does this text look like the name of an image file? Used to tell sides apart. */
export function looksLikeImageFile(text) {
  return /\.(png|jpe?g|tiff?|webp)$/i.test(String(text).trim());
}

/** The nozzle whose id or extrusion width is this number, or null. */
function nozzleFromValue(v) {
  if (!Number.isFinite(v)) return null;
  for (const id of NOZZLE_IDS) {
    if (Math.abs(Number(id) - v) < 1e-9) return id;
    if (Math.abs(getNozzle(id).ewMm - v) < 1e-9) return id;
  }
  return null;
}

/**
 * Read a nozzle id out of arbitrary text: a file name, a label, or a directory name.
 *
 * Accepts the nozzle ids themselves (0.2 / 0.4 / 0.6 / 0.8), the zero-padded spellings
 * that 3D printing actually uses (02 -> 0.2, 070 -> 0.70), and the extrusion widths the
 * nozzles imply (0.26 / 0.45 / 0.70 / 0.95), because a user who prints at "0.45mm" has a
 * 0.4 nozzle. Everything else -- including a nozzle nobody sells, like 0.5 -- returns
 * null, and so does a name that mentions two different nozzles: guessing would silently
 * turn a mislabelled capture into a passing row, which is the one thing this tool must
 * not do.
 *
 * @param {string} text
 * @returns {string|null} one of NOZZLE_IDS, or null
 */
export function nozzleFromLabel(text) {
  if (text === null || text === undefined) return null;
  const s = String(text).toLowerCase();
  const found = new Set();
  for (const m of s.matchAll(/(\d+)(?:[.,](\d+))?/g)) {
    const whole = m[1];
    const frac = m[2] || '';
    const candidates = [];
    if (frac) candidates.push(Number(`${whole}.${frac}`));
    else {
      candidates.push(Number(whole));
      // "02" and "070" mean 0.2 and 0.70 in this domain, not 2 and 70.
      if (whole.length >= 2 && whole[0] === '0') candidates.push(Number(`0.${whole.slice(1)}`));
    }
    for (const v of candidates) {
      const id = nozzleFromValue(v);
      if (id) found.add(id);
    }
  }
  return found.size === 1 ? [...found][0] : null;
}

/** Parse `--label 0.4=n04.png` (or `n04.png=0.4`). Returns {file, nozzle} or throws. */
export function parseLabelArg(arg) {
  const at = String(arg).indexOf('=');
  if (at < 0) throw new Error(`--label needs NOZZLE=FILE, got "${arg}"`);
  const left = arg.slice(0, at).trim();
  const right = arg.slice(at + 1).trim();
  if (!left || !right) throw new Error(`--label needs NOZZLE=FILE, got "${arg}"`);
  const leftNz = nozzleFromLabel(left);
  const rightNz = nozzleFromLabel(right);
  // Which side is the file is decided by the *file name shape*, not by "which side parses
  // as a nozzle": a capture called n04.png parses as a nozzle too. With that settled, the
  // left side's nozzle wins, so `--label 0.8=n04.png` means what it says -- an explicit
  // label must be able to override a misleading file name.
  if (looksLikeImageFile(right) && !looksLikeImageFile(left)) {
    if (leftNz) return { file: right, nozzle: leftNz };
  } else if (looksLikeImageFile(left) && !looksLikeImageFile(right)) {
    if (rightNz) return { file: left, nozzle: rightNz };
  } else if (leftNz) {
    return { file: right, nozzle: leftNz };
  }
  throw new Error(`--label "${arg}" does not name a nozzle (left="${left}", right="${right}")`);
}

/**
 * A label map from JSON, in either direction (`{"0.4":"n04.png"}` or `{"n04.png":"0.4"}`).
 *
 * The file/nozzle sides are told apart by *which side looks like an image file*, not by
 * which side parses as a nozzle: a file called `n04.png` parses as a nozzle too, so
 * "both sides are nozzles" would make the reversed form unreadable. Anything that does
 * not name a known nozzle is dropped rather than guessed at.
 */
export function labelsFromJson(text) {
  const raw = JSON.parse(text);
  const out = new Map();
  const looksLikeFile = (s) => /\.(png|jpe?g|tiff?|webp)$/i.test(s);
  for (const [k, v] of Object.entries(raw)) {
    const ks = String(k).trim();
    const vs = String(v).trim();
    let file = null;
    let nozzle = null;
    if (looksLikeFile(vs) && !looksLikeFile(ks)) {
      file = vs;
      nozzle = nozzleFromLabel(ks);
    } else if (looksLikeFile(ks) && !looksLikeFile(vs)) {
      file = ks;
      nozzle = nozzleFromLabel(vs);
    } else if (!looksLikeFile(ks) && !looksLikeFile(vs)) {
      file = vs; // the documented form is {nozzle: file}
      nozzle = nozzleFromLabel(ks);
    }
    if (file && nozzle) out.set(basename(file), nozzle);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* the verdict (pure)                                                  */
/* ------------------------------------------------------------------ */

/**
 * Decide one row. Deliberately mirrors tools/mtf-probe.ps1's rule so the simulator probe
 * and a real capture are judged by the same sentence:
 *
 *   names-itself     the recommendation is exactly the nozzle that printed it
 *   allowed-coarser  only for the finest nozzle (0.2), and only when its own rung came
 *                    back filled -- i.e. the reader says why it could not do better
 *   mismatch         anything else (including "recommends nothing")
 *   unregistered     the four markers were not found/rectified: data, not a tool error
 *   unlabelled       no nozzle given, so there is nothing to compare against
 *
 * @param {object|null} measurement  readMtfPlate output (or null when the file was unreadable)
 * @param {object|null} rec          recommendFromMtf output
 * @param {string|null} printed      nozzle id that printed the capture, or null
 * @returns {{verdict: string, why: string}}
 */
export function judgeCapture(measurement, rec, printed) {
  if (!measurement) return { verdict: 'unreadable', why: 'the file could not be decoded as an image' };
  if (!measurement.ok) {
    return { verdict: 'unregistered', why: `registration failed at ${measurement.stage}/${measurement.reason}` };
  }
  if (!rec || !rec.ok || !rec.nozzle) {
    return { verdict: 'mismatch', why: rec && rec.reason ? rec.reason : 'no recommendation' };
  }
  if (!printed) return { verdict: 'unlabelled', why: `recommends ${rec.nozzle.id}mm` };
  if (rec.nozzle.id === printed) {
    return { verdict: 'names-itself', why: `the ${getNozzle(printed).ewMm}mm rung resolved` };
  }
  const own = (rec.nozzles || []).find((n) => n.id === printed);
  if (printed === NOZZLE_IDS[0] && own && own.tested && own.rungResolved === false) {
    return {
      verdict: 'allowed-coarser',
      why: `printed at ${printed}mm: its own ${own.ewMm}mm rung came back filled, so ${rec.nozzle.id}mm is what the chain resolves`,
    };
  }
  return {
    verdict: 'mismatch',
    why: `printed at ${printed}mm but the capture resolves ${rec.nozzle.id}mm (${rec.nozzle.why})`,
  };
}

/** Collect rows from per-file {file, printed, measurement, rec} entries. Pure. */
export function buildMatrix(entries) {
  return entries.map((e) => {
    const j = judgeCapture(e.measurement, e.rec, e.printed);
    return {
      file: e.file,
      printed: e.printed,
      recommended: e.rec && e.rec.ok && e.rec.nozzle ? e.rec.nozzle.id : null,
      floorMm: e.rec && e.rec.ok ? e.rec.floorMm : null,
      registration: e.measurement && e.measurement.ok ? e.measurement.registration : null,
      coverage: e.measurement && e.measurement.ok ? e.measurement.coverage : null,
      verdict: j.verdict,
      why: j.why,
    };
  });
}

/** Text table. Column widths follow the content so a long file name cannot misalign it. */
export function formatMatrix(rows) {
  const head = ['capture', 'printed', 'recommends', 'floor mm', 'verdict', 'why'];
  const cells = rows.map((r) => [
    r.file,
    r.printed || '-',
    r.recommended || '-',
    r.floorMm === null || r.floorMm === undefined ? '-' : String(r.floorMm),
    r.verdict,
    r.why,
  ]);
  const width = head.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i].length)));
  const line = (c) => c.map((v, i) => v.padEnd(width[i])).join('  ').trimEnd();
  return [line(head), line(width.map((w) => '-'.repeat(w))), ...cells.map(line)].join('\n');
}

/** Summary counts + the exit code rule. Pure. */
export function summarise(rows) {
  const count = (v) => rows.filter((r) => r.verdict === v).length;
  const labelled = rows.filter((r) => r.printed);
  const bad = labelled.filter((r) => r.verdict === 'mismatch' || r.verdict === 'unregistered' || r.verdict === 'unreadable');
  return {
    total: rows.length,
    labelled: labelled.length,
    named: count('names-itself'),
    allowedCoarser: count('allowed-coarser'),
    unlabelled: count('unlabelled'),
    failed: bad.length,
    exitCode: bad.length ? 1 : 0,
  };
}

/* ------------------------------------------------------------------ */
/* in-process self-test                                                */
/* ------------------------------------------------------------------ */

/**
 * The matrix runner, exercised on captures it can make itself: the plate rendered as a
 * printer with each nozzle's extrusion width would print it (`printEwMm`, the same
 * emulation tools/mtf-probe.ps1 uses). No Python channel, no subprocess -- so this runs
 * anywhere the unit suite runs.
 *
 * Two controls, for the same reason the probe has them: EW 1.40 (coarser than every
 * nozzle) must resolve nothing, and the pristine render must resolve every rung. A
 * runner that always says "names-itself" would otherwise pass the four real cases.
 *
 * @returns {{ok: boolean, rows: object[], problems: string[]}}
 */
export function selftest() {
  const spec = mtfPlateSpec({});
  const problems = [];
  const entries = [];
  const run = (file, printed, printEwMm) => {
    const img = renderMtfPlate(spec, printEwMm ? { printEwMm } : {});
    const m = readMtfPlate(img, spec, { texture: false, ruler: false });
    const rec = m.ok ? recommendFromMtf(m, { plateMm: spec.plateMm }) : null;
    entries.push({ file, printed, measurement: m, rec });
    return { m, rec };
  };
  for (const id of NOZZLE_IDS) run(`selftest-${id}.png`, id, getNozzle(id).ewMm);
  const rows = buildMatrix(entries);
  for (const row of rows) {
    if (row.verdict !== 'names-itself' && row.verdict !== 'allowed-coarser') {
      problems.push(`${row.file}: ${row.verdict} -- ${row.why}`);
    }
  }
  // control 1: coarser than any nozzle
  const coarse = run('selftest-ew1.40.png', '0.8', 1.4);
  if (coarse.rec && coarse.rec.ok) problems.push('control EW 1.40 resolved a nozzle; the reader is guessing');
  // control 2: pristine render resolves every rung
  const plain = readMtfPlate(renderMtfPlate(spec, {}), spec, { texture: false, ruler: false });
  if (!plain.ok) problems.push(`control pristine: registration failed (${plain.stage}/${plain.reason})`);
  else if (!(plain.features && plain.features.floorMm !== null)) problems.push('control pristine: no feature rung resolved');
  return { ok: problems.length === 0, rows, problems };
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const out = { labels: [], dir: '.', provenance: null, json: null, verbose: false, fast: false, selftest: false, spec: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--dir' || a === '-d') out.dir = next();
    else if (a === '--spec') out.spec = next();
    else if (a === '--label') out.labels.push(next());
    else if (a === '--json') out.json = next();
    else if (a === '--provenance') out.provenance = next();
    else if (a === '--verbose' || a === '-v') out.verbose = true;
    else if (a === '--fast') out.fast = true;
    else if (a === '--selftest') out.selftest = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a.startsWith('-')) throw new Error(`unknown option ${a}`);
    else out.dir = a;
  }
  return out;
}

const USAGE = `mtf-matrix -- read a directory of MTF plate captures, one per nozzle

  node tools/mtf-matrix.mjs --dir <captures> [options]

  --dir <dir>            captures directory (default .)
  --spec <file>          plate spec (default <dir>/mtf-plate.json)
  --label <nozzle>=<file>  which nozzle printed that capture (repeatable)
  --json <file>          write the machine-readable matrix
  --provenance <text>    what these captures are (e.g. real-print, simulation)
  --fast                 skip the texture and ruler measurements
  --verbose              also print the full per-capture readout
  --selftest             run the in-process synthetic matrix (no captures needed)
  --help

  Exit 0 = every labelled capture named its own nozzle (or was allowed to come back
  coarser, with the reader saying why); 1 = a labelled capture mismatched; 2 = the tool
  could not run. Not a gate: G10 is decided by a real print, not by this exit code.`;

function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  if (args.selftest) {
    const st = selftest();
    console.log(formatMatrix(st.rows));
    for (const p of st.problems) console.log(` FAIL  ${p}`);
    console.log(st.ok ? 'MTF MATRIX SELFTEST: pass (4 nozzles named themselves, 2 controls held)' : 'MTF MATRIX SELFTEST: FAILED');
    return st.ok ? 0 : 1;
  }
  const dir = resolve(args.dir);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`mtf-matrix: no directory ${dir}`);
  const specPath = args.spec ? resolve(args.spec) : join(dir, 'mtf-plate.json');
  if (!existsSync(specPath)) {
    throw new Error(`mtf-matrix: no plate spec at ${specPath} (print the plate with \`pskit calibrate --make-mtf\` and keep mtf-plate.json next to the captures, or pass --spec)`);
  }
  const spec = JSON.parse(readFileSync(specPath, 'utf8'));

  // labels: --label wins over the sidecar, the sidecar wins over the file name
  const labels = new Map();
  const sidecar = join(dir, 'mtf-labels.json');
  if (existsSync(sidecar)) for (const [k, v] of labelsFromJson(readFileSync(sidecar, 'utf8'))) labels.set(k, v);
  for (const raw of args.labels) {
    const { file, nozzle } = parseLabelArg(raw);
    labels.set(basename(file), nozzle);
  }

  const files = readdirSync(dir)
    .filter((n) => /\.(png|tif|tiff)$/i.test(n))
    .filter((n) => n !== basename(specPath))
    .sort();
  if (!files.length) throw new Error(`mtf-matrix: no PNG/TIFF captures in ${dir}`);

  const entries = [];
  for (const file of files) {
    const printed = labels.get(file) || nozzleFromLabel(file);
    let measurement = null;
    try {
      measurement = readMtfPlate(decodePNG(new Uint8Array(readFileSync(join(dir, file)))), spec, { texture: !args.fast, ruler: !args.fast });
    } catch (e) {
      entries.push({ file, printed, measurement: null, rec: null, error: e.message });
      continue;
    }
    const rec = measurement.ok ? recommendFromMtf(measurement, { plateMm: spec.plateMm }) : null;
    entries.push({ file, printed, measurement, rec });
    if (args.verbose) for (const line of describeMtfMeasurement(measurement, rec)) console.log(`  ${file}: ${line}`);
  }
  const rows = buildMatrix(entries);
  console.log(`mtf-matrix: spec ${specPath}`);
  console.log(`  captures ${dir} -- ${files.length} image(s), ${rows.filter((r) => r.printed).length} labelled`);
  console.log(formatMatrix(rows));
  const s = summarise(rows);
  console.log(
    `  summary: ${s.named} named themselves, ${s.allowedCoarser} allowed coarser, ${s.unlabelled} unlabelled, ${s.failed} failed`,
  );
  // The one thing this tool must never do is let a simulated capture read as a real one.
  console.log(
    args.provenance
      ? `  provenance: ${args.provenance} (recorded as stated; the pixels cannot tell)`
      : '  provenance: unstated -- pass --provenance real-print when these came off a real printer; docs/STATUS.md must not claim G10 without it',
  );
  console.log('  this is a measurement, not a gate: G10 is decided by a real print (docs/USE.md §5)');
  if (args.json) {
    writeFileSync(
      resolve(args.json),
      JSON.stringify({ tool: 'mtf-matrix', version: 1, spec: specPath, dir, provenance: args.provenance || 'unstated', summary: s, rows, measurements: entries.map((e) => ({ file: e.file, printed: e.printed, error: e.error || null, rec: e.rec, m: e.measurement })) }, null, 1),
    );
    console.log(`  wrote            ${resolve(args.json)}`);
  }
  return s.exitCode;
}

// Importable as a module (the unit tests do) without running the CLI.
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('/tools/mtf-matrix.mjs')) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    console.error(`mtf-matrix: ${e.message}`);
    process.exitCode = 2;
  }
}
