#!/usr/bin/env node
/**
 * tools/find-dead-exports.mjs -- which exports of core/** does nothing outside their own file mention?
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
 *   node tools/find-dead-exports.mjs [--json]
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const BS = String.fromCharCode(92);
const SKIP = new Set(['node_modules', '.git', '.tmp', 'dist']);

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    if (SKIP.has(e)) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (e.endsWith('.mjs') || e.endsWith('.js')) out.push(p);
  }
  return out;
}

const sources = new Map();
for (const f of walk(ROOT)) sources.set(f.slice(ROOT.length + 1).split(BS).join('/'), readFileSync(f, 'utf8'));

const re = /^export\s+(?:async\s+)?(?:function|const|class|let)\s+([A-Za-z_$][\w$]*)/gm;
const never = [];
const testsOnly = [];
let examined = 0;

for (const [file, text] of sources) {
  if (!file.startsWith('core/')) continue;
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text))) {
    examined++;
    const name = m[1];
    let product = 0;
    let tests = 0;
    for (const [other, otherText] of sources) {
      if (other === file) continue;
      const hits = (otherText.match(new RegExp(name, 'g')) || []).length;
      if (!hits) continue;
      if (other.startsWith('tests/')) tests += hits; else product += hits;
    }
    if (!product && !tests) never.push({ file, name });
    else if (!product) testsOnly.push({ file, name, tests });
  }
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ examined, never, testsOnly }, null, 1));
} else {
  console.log('core exports examined: ' + examined);
  console.log('');
  console.log('NEVER MENTIONED OUTSIDE THEIR OWN FILE (' + never.length + ') -- candidates, check docs and ref/ before deleting:');
  for (const r of never) console.log('  ' + r.file + '  ' + r.name);
  console.log('');
  console.log('MENTIONED ONLY BY TESTS (' + testsOnly.length + ') -- measurement helpers live here:');
  for (const r of testsOnly) console.log('  ' + r.file + '  ' + r.name + '  (' + r.tests + ')');
}
