#!/usr/bin/env node
/**
 * tools/find-dead-exports.mjs -- which exports does nothing outside their own file mention?
 *
 * This exists because the plan says to sweep for dead code every few rounds, and a sweep has to be a
 * command rather than a feeling. READ THE OUTPUT CAREFULLY -- it is a list of CANDIDATES, not verdicts:
 *
 *   - It counts textual mentions in .mjs/.js files only. A name that appears only in the docs
 *     (AGENTS.md, docs/*.md) or only in the Python reference implementation (ref/*.py) shows up here as
 *     unused, and removing it would break parity or the documentation.
 *   - "tests only" means exactly that: the name is exercised by tests but never by product code. That is
 *     a legitimate shape for a measurement helper (codedBits, entropyBits) -- not automatically dead,
 *     and the product pays nothing for it at run time.
 *   - An unused export costs nothing at run time. Delete only what is provably unreachable AND not part
 *     of the documented surface, then run the full gate set.
 *
 *   node tools/find-dead-exports.mjs [--scope core|all] [--json] [--selftest]
 *
 * Round 267 added two things the first five sweeps did not cover:
 *   - --scope all: rounds 242-262 only ever looked inside core/**, so an export that stopped being
 *     imported in tools/, cli/ or web/ was invisible to every sweep. Declarations in tests/ count as a
 *     separate bucket because the standing directive excludes test code from the sweep.
 *   - --selftest: the positive control. It runs the same classifier over a fixture that holds a dead
 *     export, a live one, a tests-only one and a test-file one, and fails loudly if the classifier stops
 *     flagging the dead ones or starts flagging the live ones. A sweep that cannot go red is not a sweep.
 *
 * The mention test uses explicit word boundaries that treat the dollar sign as a word character; the
 * pre-267 version used a bare RegExp(name) with no boundaries at all, which also counted a name that
 * merely appears inside a longer identifier.
 */

import { loadSources } from './find-dead-locals.mjs';

const BS = String.fromCharCode(92);
const META = '.*+?^$()[]{}|' + BS;
const CODE_EXT = /\.(mjs|js)$/;

const DECL = /^export\s+(?:async\s+)?(?:function|const|class|let)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm;

function escapeRe(s) {
  return Array.from(s).map((c) => (META.includes(c) ? BS + c : c)).join('');
}

/**
 * Classify every export declaration in scope.
 *
 * scope 'core' looks only inside core/** (the historical behaviour, so the round 242-262 series stays
 * comparable); scope 'all' looks at every non-test file and reports test-file declarations separately.
 */
export function classifyExports(sources, scope = 'core') {
  const never = [];
  const testsOnly = [];
  const neverInTests = [];
  let examined = 0;
  let examinedTests = 0;
  for (const [file, text] of sources) {
    if (!CODE_EXT.test(file)) continue;
    const inTests = file.startsWith('tests/');
    if (scope === 'core') {
      if (!file.startsWith('core/')) continue;
    } else if (inTests) {
      // examined, but its verdict is reported in its own bucket: the directive excludes test code
    }
    DECL.lastIndex = 0;
    let m;
    while ((m = DECL.exec(text))) {
      if (inTests) examinedTests++; else examined++;
      const name = m[1];
      const re = new RegExp('(?<![A-Za-z0-9_$])' + escapeRe(name) + '(?![A-Za-z0-9_$])', 'g');
      let product = 0;
      let tests = 0;
      for (const [other, otherText] of sources) {
        if (other === file || !CODE_EXT.test(other)) continue;
        const hits = (otherText.match(re) || []).length;
        if (!hits) continue;
        if (other.startsWith('tests/')) tests += hits; else product += hits;
      }
      if (product) continue;
      if (tests) {
        testsOnly.push({ file, name, tests });
        continue;
      }
      if (inTests && scope === 'all') neverInTests.push({ file, name });
      else never.push({ file, name });
    }
  }
  return { scope, examined, examinedTests, never, testsOnly, neverInTests };
}

const FIXTURE = new Map([
  ['core/a.js', 'export function liveCore() {}\nexport function deadCore() {}\nexport function testOnlyCore() {}\n'],
  ['core/b.js', 'liveCore();\n'],
  ['tests/a.test.mjs', 'testOnlyCore();\nexport function deadTest() {}\n'],
  ['web/w.js', 'export function liveWeb() {}\nexport function deadWeb() {}\n'],
  ['web/uses.js', 'liveWeb();\n'],
]);

export function selftest() {
  const core = classifyExports(FIXTURE, 'core');
  const all = classifyExports(FIXTURE, 'all');
  const names = (rows) => rows.map((r) => r.file + ':' + r.name).sort().join(',');
  const checks = [
    [core.examined === 3 && names(core.never) === 'core/a.js:deadCore' && names(core.testsOnly) === 'core/a.js:testOnlyCore',
      'scope core: exactly the dead core export, the live one silent, the tests-only one in its own bucket (got ' + names(core.never) + ' / ' + names(core.testsOnly) + ')'],
    [all.examined === 5 && names(all.never) === 'core/a.js:deadCore,web/w.js:deadWeb',
      'scope all: the non-core dead export is caught too, and the live non-core one is not (got ' + names(all.never) + ')'],
    [names(all.neverInTests) === 'tests/a.test.mjs:deadTest' && all.examinedTests === 1,
      'test-file declarations land in their own bucket, never in the product one (got ' + names(all.neverInTests) + ')'],
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
    console.log('SELFTEST RED -- ' + bad + ' of ' + checks.length + ' -- the classifier is broken, do not trust a green sweep');
    process.exit(1);
  }
  console.log('SELFTEST GREEN -- ' + checks.length + ' of ' + checks.length + ' -- dead flagged, live silent, scopes and buckets behave');
}

function report(rows, label) {
  console.log('');
  console.log(label + ' (' + rows.length + ') -- candidates, check docs and ref/ before deleting:');
  for (const r of rows) console.log('  ' + r.file + '  ' + r.name);
}

if (process.argv[1] && process.argv[1].split(BS).join('/').endsWith('tools/find-dead-exports.mjs')) {
  const args = process.argv.slice(2);
  if (args.includes('--selftest')) {
    selftest();
  } else {
    const scope = args.includes('--scope') ? String(args[args.indexOf('--scope') + 1]) : 'core';
    if (scope !== 'core' && scope !== 'all') {
      console.log('usage: node tools/find-dead-exports.mjs [--scope core|all] [--json] [--selftest]');
      process.exit(2);
    }
    const res = classifyExports(loadSources('.'), scope);
    if (args.includes('--json')) {
      console.log(JSON.stringify(res, null, 1));
    } else {
      console.log((scope === 'core' ? 'core' : 'non-test') + ' exports examined: ' + res.examined);
      if (scope === 'all') console.log('test-file exports examined (out of scope): ' + res.examinedTests);
      report(res.never, 'NEVER MENTIONED OUTSIDE THEIR OWN FILE');
      console.log('');
      console.log('MENTIONED ONLY BY TESTS (' + res.testsOnly.length + ') -- measurement helpers live here:');
      for (const r of res.testsOnly) console.log('  ' + r.file + '  ' + r.name + '  (' + r.tests + ')');
      if (scope === 'all') report(res.neverInTests, 'NEVER MENTIONED IN TEST CODE TOO (out of scope by the directive)');
    }
  }
}
