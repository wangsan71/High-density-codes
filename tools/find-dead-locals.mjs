#!/usr/bin/env node
/**
 * tools/find-dead-locals.mjs -- the two sweeps tools/find-dead-exports.mjs cannot see.
 *
 * The export scanner answers "which exports of core/** does nothing outside their own file mention?".
 * That leaves two shapes invisible, and both have bitten this repository before:
 *
 *   1. a module-scope, NON-exported name nobody calls any more (a leftover helper, round 257);
 *   2. a whole tool file nothing mentions any more (an orphan probe).
 *
 * Round 262 promoted this from a throwaway probe under .tmp/: the ledger is not allowed to point at a
 * file that is not in the repository, and a sweep that exists only inside one session is not a sweep.
 *
 * Output is CANDIDATES, not verdicts -- the same caveats as the export scanner:
 *   - the directive that asks for this sweep every five rounds excludes TEST code, so declarations
 *     that live in tests/ are printed in their own bucket and are not part of the number that matters;
 *   - a tool file named only by docs/ is legitimate when the docs ARE its interface
 *     (tools/probe-marker-scale.mjs is the recorded reproduction command for D24/D26);
 *   - mention counting is textual and covers .mjs/.js: a constant that is only ever used by the Python
 *     reference implementation under ref/ shows up here as unused.
 *
 *   node tools/find-dead-locals.mjs [--json] [--selftest]
 *
 * --selftest is the positive control. It runs both detectors over a fixture holding a known-dead local,
 * a known-dead tool file and live counterparts of each, and exits 1 unless the detectors fire on the
 * dead ones and stay silent on the live ones. A sweep that cannot go red is not a sweep.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const BS = String.fromCharCode(92);
const SKIP_DIRS = new Set(['node_modules', '.git', '.tmp', 'dist', 'ref']);
const TEXT_EXT = /\.(mjs|js|ps1|json|md)$/;
const CODE_EXT = /\.(mjs|js)$/;
const META = '.*+?^$()[]{}|' + BS;

export function norm(p) {
  return p.split(BS).join('/');
}

/** Every text file under dir, skipping the trees that are generated or vendored. Native paths. */
export function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    if (SKIP_DIRS.has(e)) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (TEXT_EXT.test(e)) out.push(p);
  }
  return out;
}

/** Map of repository-relative POSIX path -> file text. */
export function loadSources(root) {
  const out = new Map();
  for (const f of walk(root)) out.set(norm(relative(root, f)), readFileSync(f, 'utf8'));
  return out;
}

function escapeRe(s) {
  return Array.from(s).map((c) => (META.includes(c) ? BS + c : c)).join('');
}

/**
 * Whole-word occurrences of name across files matching filter.
 *
 * The boundary excludes dollar signs explicitly. Round 257 used a plain \b here and that made the
 * sweep report web/app.js's module-scope helper as dead: \b sits between a space and a dollar sign,
 * so a call written $(...) never counted as a mention. A false positive costs a wasted deletion.
 */
export function countMentions(sources, name, filter = CODE_EXT) {
  const re = new RegExp('(?<![A-Za-z0-9_$])' + escapeRe(name) + '(?![A-Za-z0-9_$])', 'g');
  let total = 0;
  for (const [file, text] of sources) {
    if (!filter.test(file)) continue;
    total += (text.match(re) || []).length;
  }
  return total;
}

const DECL = /^(export\s+)?(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm;

/**
 * Module-scope, non-exported declarations that the whole repository mentions exactly once -- that once
 * being the declaration itself. Column zero is what makes this module scope: a declaration inside a
 * function is indented, so it never matches the ^ anchor. Destructuring (const { a } = ...) is not
 * matched, and neither is a name declared at column zero inside a template literal.
 */
export function findDeadLocals(sources) {
  const product = [];
  const test = [];
  for (const [file, text] of sources) {
    if (!CODE_EXT.test(file)) continue;
    DECL.lastIndex = 0;
    let m;
    while ((m = DECL.exec(text))) {
      if (m[1]) continue;
      const name = m[2];
      if (countMentions(sources, name) > 1) continue;
      (file.startsWith('tests/') ? test : product).push({ file, name });
    }
  }
  return { product, test };
}

/** Tool files whose basename nothing else in the repository mentions. Docs count as a reference. */
export function findOrphanTools(sources) {
  const orphans = [];
  let examined = 0;
  for (const file of sources.keys()) {
    if (!file.startsWith('tools/')) continue;
    examined++;
    const base = file.slice(file.lastIndexOf('/') + 1);
    const re = new RegExp('(?<![A-Za-z0-9_$])' + escapeRe(base) + '(?![A-Za-z0-9_$])', 'g');
    let hits = 0;
    for (const [other, text] of sources) {
      if (other === file) continue;
      hits += (text.match(re) || []).length;
    }
    if (!hits) orphans.push({ file });
  }
  return { examined, orphans };
}

const FIXTURE = new Map([
  ['core/fixture.js', 'function live() { return 1; }\nfunction dead() { return 2; }\nconst $ = (id) => id;\n$("out");\n'],
  ['core/caller.js', 'live();\n'],
  ['tools/live-tool.mjs', 'export const x = 1;\n'],
  ['tools/dead-tool.mjs', 'export const y = 2;\n'],
  ['docs/notes.md', 'the command is node tools/live-tool.mjs\n'],
  ['tests/fixture.test.mjs', 'function testLive() {}\ntestLive();\n\nfunction testDead() {}\n'],
]);

export function selftest() {
  const locals = findDeadLocals(FIXTURE);
  const tools = findOrphanTools(FIXTURE);
  const product = locals.product.map((r) => r.file + ':' + r.name).sort().join(',');
  const test = locals.test.map((r) => r.file + ':' + r.name).sort().join(',');
  const orphans = tools.orphans.map((r) => r.file).sort().join(',');
  const checks = [
    [product === 'core/fixture.js:dead', 'product bucket is exactly the dead local (got "' + product + '")'],
    [test === 'tests/fixture.test.mjs:testDead', 'test bucket is exactly the dead test local (got "' + test + '")'],
    [orphans === 'tools/dead-tool.mjs' && tools.examined === 2, 'tools bucket is exactly the orphan, of 2 examined (got "' + orphans + '" of ' + tools.examined + ')'],
  ];
  let bad = 0;
  for (const [ok, what] of checks) {
    if (ok) console.log('  ok   ' + what);
    else {
      bad++;
      console.log('  FAIL ' + what);
    }
  }
  if (bad) {
    console.log('SELFTEST RED -- ' + bad + ' of ' + checks.length + ' -- the detectors are broken, do not trust a green sweep');
    process.exit(1);
  }
  console.log('SELFTEST GREEN -- ' + checks.length + ' of ' + checks.length + ' -- both detectors fire on the dead and stay silent on the live; the $ boundary holds');
}

if (process.argv[1] && norm(process.argv[1]).endsWith('tools/find-dead-locals.mjs')) {
  const args = process.argv.slice(2);
  if (args.includes('--selftest')) {
    selftest();
  } else {
    const sources = loadSources('.');
    const locals = findDeadLocals(sources);
    const tools = findOrphanTools(sources);
    if (args.includes('--json')) {
      console.log(JSON.stringify({ locals, tools, files: sources.size }, null, 1));
    } else {
      console.log('module-scope names the whole repository mentions exactly once (that once is the declaration):');
      console.log('');
      console.log('  PRODUCT CODE (' + locals.product.length + ') -- candidates; check docs/ and ref/ before deleting:');
      for (const r of locals.product) console.log('    ' + r.file + '  ' + r.name);
      console.log('');
      console.log('  TEST CODE (' + locals.test.length + ') -- out of scope for this sweep, listed for completeness:');
      for (const r of locals.test) console.log('    ' + r.file + '  ' + r.name);
      console.log('');
      console.log('tool files nothing else in the repository mentions: ' + tools.orphans.length + ' of ' + tools.examined);
      for (const r of tools.orphans) console.log('    ' + r.file);
    }
  }
}
