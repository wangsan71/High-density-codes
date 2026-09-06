#!/usr/bin/env node
/**
 * Find and repair text that got mangled by a Windows codepage round-trip.
 *
 * Two byte sequences are unambiguously wrong in a UTF-8 source file:
 *   - U+FFFD REPLACEMENT CHARACTER: the decoder hit a byte the codepage could not map
 *   - U+0080..U+009F (C1 controls): what CP1252 produces for a UTF-8 lead byte
 * Legitimate non-ASCII (— ≤ → Λ, Chinese prose) is left completely alone, which is
 * why this is a targeted repair and not a general transliterator.
 *
 * Usage:
 *   node tools/fix-mojibake.mjs            # report
 *   node tools/fix-mojibake.mjs --write    # repair in place
 */
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, extname, relative } from 'node:path';

const ROOT = process.cwd();
const SKIP_DIRS = new Set(['.git', 'node_modules', 'artifacts', 'out', 'bench', '.npm-cache', '__pycache__', 'web-dist']);
const EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.json', '.md', '.html', '.css', '.py', '.yml', '.yaml', '.txt']);
const WRITE = process.argv.includes('--write');

// C1 controls have no business in prose or code; map each to what was probably there.
const REPAIRS = [
  [/* U+FFFD */ /\uFFFD+/g, '-'],
  [/* any C1 control */ /[\u0080-\u009F]+/g, '-'],
];

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.gitignore') continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else if (EXTENSIONS.has(extname(entry.name).toLowerCase())) yield p;
  }
}

let files = 0;
let hits = 0;
for (const file of walk(ROOT)) {
  const text = readFileSync(file, 'utf8');
  if (!/[^\x00-\x7F]/.test(text)) continue;
  let repaired = text;
  let changed = 0;
  for (const [re, to] of REPAIRS) {
    repaired = repaired.replace(re, (m) => {
      changed += m.length;
      return to;
    });
  }
  if (!changed) continue;
  files++;
  hits += changed;
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  const lines = repaired.split('\n');
  const where = [];
  text.split('\n').forEach((l, i) => {
    if (REPAIRS.some(([re]) => re.test(l))) where.push(i + 1);
  });
  console.log(`${rel}: ${changed} mangled char(s) on line(s) ${where.join(', ')}`);
  if (WRITE) {
    writeFileSync(file, repaired, 'utf8');
    console.log(`  -> repaired (kept ${lines.length} lines)`);
  }
}
console.log(`${WRITE ? 'Repaired' : 'Found'} ${hits} mangled character(s) across ${files} file(s).`);
if (!WRITE && hits) {
  console.log('Re-run with --write to repair.');
  process.exitCode = 1;
}
