#!/usr/bin/env node
/**
 * level-diff -- compare the levels a captured page produced against the pristine render of the
 * same page, cell by cell.
 *
 * Why this exists (DEFECTS D51, round 61): at 600 dpi some pages fail with ALL intra-RS blocks
 * broken while RS reports ZERO corrected errors and ZERO erasures. Accumulated noise does not look
 * like that. Comparing against the pristine render showed what it actually is: the channel page read
 * every one of its 283155 interior cells as the same level (all 1) where the render had
 * 0=256118 1=27037 -- a total collapse of the per-cell level decision, not noise, not local damage,
 * and not a lattice offset (48 shifts of up to +/-3 cells did not help).
 *
 * So this tool is the evidence for that finding, and it is the regression check for the fix: after
 * the level readout is re-derived per page (measure the rho table on the captured page instead of
 * deciding against fixed thresholds), a page that used to collapse must show a near-zero mismatch
 * rate here -- or at least stop being a single level.
 *
 * It is a MEASUREMENT, not a gate. Exit code 0 means "the comparison ran"; a 90% mismatch is data,
 * not failure. Exit 1 is reserved for the tool being unable to compare at all (missing files, or
 * level arrays whose length disagrees with the geometry, which would make every rate below
 * meaningless).
 *
 * Controls are built into the output, because a comparison that cannot fail is not evidence:
 * run it on a page that decoded cleanly first -- that page must show ~0.000% mismatch. If it does
 * not, the geometry or the palette assumption is wrong and the interesting numbers are worthless.
 *
 * Usage:
 *   node tools/level-diff.mjs <pristineDir> <channelDir> [pages]
 *     pristineDir  the un-simulated render (pskit send output; needs its manifest.json)
 *     channelDir   the captured or simulated pages of the same transfer
 *     pages        comma-separated page indices, default 0,1,2
 *   e.g. node tools/level-diff.mjs .tmp/g2src-a4-600 .tmp/sc-scan600-11 0,1
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { decodePNG } from '../core/decode/png-read.js';
import { decodePage } from '../core/decode/page.js';
import { planPage } from '../core/profiles.js';
import { pageLayout } from '../core/render/layout.js';
import { getPalette } from '../core/palette.js';

const [pristineDir, channelDir, pagesArg] = process.argv.slice(2);
if (!pristineDir || !channelDir) {
  console.error('usage: node tools/level-diff.mjs <pristineDir> <channelDir> [pages]');
  process.exit(1);
}
const pages = (pagesArg || '0,1,2').split(',').map((s) => Number(s.trim()));

const manPath = join(pristineDir, 'manifest.json');
if (!existsSync(manPath)) {
  console.error(`level-diff: ${manPath} is missing -- the pristine directory must be a pskit send output`);
  process.exit(1);
}
const man = JSON.parse(readFileSync(manPath, 'utf8'));
const geom = planPage(man.profile, { nozzle: man.nozzle, plateMm: man.plateMm, monoSafe: man.monoSafe });
const layout = pageLayout(geom, man.dpi, { plateMm: man.plateMm });
const paletteId = man.palette || 'PAPER1';
const cols = geom.cols;
const rows = geom.rows;

// The channel directory normally carries a copy of the same manifest (sim/channel.py copies it). If
// it disagrees, the two sides are not the same transfer and every number below is meaningless.
const chManPath = join(channelDir, 'manifest.json');
if (existsSync(chManPath)) {
  const ch = JSON.parse(readFileSync(chManPath, 'utf8'));
  for (const k of ['profile', 'dpi', 'palette']) {
    if (ch[k] !== undefined && man[k] !== undefined && ch[k] !== man[k]) {
      console.error(`level-diff: manifest mismatch on ${k}: pristine ${man[k]} vs channel ${ch[k]} -- not the same transfer`);
      process.exit(1);
    }
  }
}

console.log(
  `pristine ${pristineDir}: profile ${man.profile} dpi ${man.dpi} palette ${paletteId} geom cols ${cols} rows ${rows} = ${cols * rows} cells`,
);
console.log(`channel  ${channelDir}: pages ${pages.join(', ')}`);

const pageName = (i) => `page-${String(i).padStart(3, '0')}.png`;

function readLevels(dir, i) {
  const p = join(dir, pageName(i));
  if (!existsSync(p)) return { ok: false, stage: 'file', reason: `${p} does not exist` };
  let bm;
  try {
    bm = decodePNG(new Uint8Array(readFileSync(p)));
  } catch (e) {
    return { ok: false, stage: 'file', reason: `not a readable PNG (${e.message})` };
  }
  bm.substrate = bm.substrate || getPalette(paletteId).background;
  const r = decodePage(bm, { geom, layout, paletteId }, { allowFastPath: true, requireFastPath: false, log: null });
  if (!r.ok) return { ok: false, stage: r.stage, reason: r.reason };
  return { ok: true, levels: r.levels, path: r.path };
}

// Compare A at (r,c) against B at (r+dy, c+dx) over the interior, so a shift never runs off the grid.
function compare(A, B, dx, dy) {
  let n = 0;
  let bad = 0;
  for (let r = 2; r < rows - 2; r++) {
    for (let c = 2; c < cols - 2; c++) {
      const rr = r + dy;
      const cc = c + dx;
      if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) continue;
      n++;
      if (A[r * cols + c] !== B[rr * cols + cc]) bad++;
    }
  }
  return { n, bad, rate: n ? bad / n : NaN };
}

function hist(L) {
  const h = new Map();
  for (let r = 2; r < rows - 2; r++) {
    for (let c = 2; c < cols - 2; c++) {
      const v = L[r * cols + c];
      h.set(v, (h.get(v) || 0) + 1);
    }
  }
  return [...h.entries()].sort((p, q) => p[0] - q[0]).map(([k, v]) => `${k}=${v}`).join(' ');
}

function bands(arr, n, k) {
  const out = [];
  const w = Math.max(1, Math.floor(n / k));
  for (let b = 0; b < k; b++) {
    let s = 0;
    for (let j = b * w; j < Math.min((b + 1) * w, n); j++) s += arr[j];
    out.push(s);
  }
  return out;
}

let aborted = false;
for (const i of pages) {
  const a = readLevels(pristineDir, i);
  if (!a.ok) {
    console.log(`  page ${i}: PRISTINE did not decode (${a.stage}/${a.reason}) -- no ground truth, comparison impossible`);
    aborted = true;
    continue;
  }
  const b = readLevels(channelDir, i);
  if (!b.ok) {
    console.log(`  page ${i}: channel page did not decode (${b.stage}/${b.reason}) -- no levels to compare`);
    continue;
  }
  console.log(
    `  page ${i}: levels pristine=${a.levels.length} channel=${b.levels.length} expected=${cols * rows} (path ${a.path} -> ${b.path})`,
  );
  if (a.levels.length !== cols * rows || b.levels.length !== a.levels.length) {
    console.log('      ABORT: level array sizes disagree with geom cols*rows -- the geometry assumption is wrong, do not read any rate below');
    aborted = true;
    continue;
  }
  const zero = compare(a.levels, b.levels, 0, 0);
  console.log(`      mismatch unshifted: ${zero.bad}/${zero.n} = ${(zero.rate * 100).toFixed(3)}%`);
  console.log(`      hist interior  pristine: ${hist(a.levels)}    channel: ${hist(b.levels)}`);
  const single = new Set(b.levels).size === 1;
  if (single) console.log('      COLLAPSE: the channel page read every cell as one single level');

  const conf = new Map();
  for (let r = 2; r < rows - 2; r++) {
    for (let c = 2; c < cols - 2; c++) {
      const x = a.levels[r * cols + c];
      const y = b.levels[r * cols + c];
      if (x !== y) {
        const k = `${x}->${y}`;
        conf.set(k, (conf.get(k) || 0) + 1);
      }
    }
  }
  const top = [...conf.entries()].sort((p, q) => q[1] - p[1]).slice(0, 6);
  if (top.length) console.log(`      confusion (pristine->channel): ${top.map(([k, v]) => `${k} x${v}`).join(', ')}`);
  console.log(`      distinct confusion pairs: ${conf.size}`);

  const shifts = [];
  for (let dy = -3; dy <= 3; dy++) {
    for (let dx = -3; dx <= 3; dx++) {
      if (!dx && !dy) continue;
      shifts.push({ dx, dy, rate: compare(a.levels, b.levels, dx, dy).rate });
    }
  }
  shifts.sort((p, q) => p.rate - q.rate);
  console.log(
    `      shift test (best 3 of ${shifts.length}): ` +
      shifts.slice(0, 3).map((s) => `dx${s.dx} dy${s.dy} -> ${(s.rate * 100).toFixed(3)}%`).join(' | '),
  );
  console.log(
    `      => ${shifts[0].rate < zero.rate / 4 ? `a lattice offset at dx${shifts[0].dx} dy${shifts[0].dy} explains most of it => SYSTEMATIC offset` : 'no small shift explains it => not a whole-lattice offset at cell granularity'}`,
  );

  const rowBad = new Array(rows).fill(0);
  const colBad = new Array(cols).fill(0);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (a.levels[r * cols + c] !== b.levels[r * cols + c]) {
        rowBad[r]++;
        colBad[c]++;
      }
    }
  }
  console.log(`      mismatch by row band (5): ${bands(rowBad, rows, 5).join(' ')}   by col band (5): ${bands(colBad, cols, 5).join(' ')}`);
}
console.log('  note       measurement only: exit 0 means the comparison ran, not that the page is good.');
if (aborted) process.exitCode = 1;
