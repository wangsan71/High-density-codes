#!/usr/bin/env node
/**
 * Docs integrity: markdown tables in the ledgers must survive rendering.
 *
 * Two ways a row breaks, both silent:
 *
 *  1. A bare `|` inside an inline code span. GFM splits cells on unescaped pipes even between
 *     backticks, so `pageLayout(t.geom, prof.dpi || 300, {})` in a cell adds two columns and every
 *     later cell in that row shifts left. The table still renders as a table, so it goes unnoticed:
 *     DEFECTS D47's row did this in round 53, D44's had been doing it since round 48, and several
 *     STATUS gate rows carry `--format stl|3mf` -- some of them land on the header's cell count by
 *     coincidence, which is why counting cells alone is not a sufficient check.
 *  2. A row whose cell count differs from its header's (a missing or extra column).
 *
 * A block of `|` lines is only treated as a table when its second line is the `---|---` separator.
 * Blocks without one are reported as NOTEs, not failures: in this repo they mean a table was
 * interrupted by prose, so the rows after the interruption have no header at all and render on their
 * own -- a structural problem the checker names but does not pretend to measure (DEFECTS D48).
 *
 *   node tools/check-docs-tables.mjs            # report; exit 1 on any failure
 *   node tools/check-docs-tables.mjs --write    # escape bare pipes inside code spans, then report
 *
 * `--write` only ever inserts backslashes inside code spans of real table rows. It does not repair
 * cell counts: that needs a human who knows what the column was supposed to say.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const WRITE = argv.includes('--write');
const args = argv.filter((a) => !a.startsWith('--'));
const files = args.length
  ? args
  : [...readdirSync(join(ROOT, 'docs')).filter((f) => f.endsWith('.md')).map((f) => join('docs', f)), ...(existsSync(join(ROOT, 'README.md')) ? ['README.md'] : []), ...(existsSync(join(ROOT, 'AGENTS.md')) ? ['AGENTS.md'] : [])];

const SEPARATOR = /^\s*\|[\s:|-]+\|\s*$/;

/** Split a row on pipes that are not backslash-escaped; drop the two outer empties. */
function cellsOf(row) {
  const trimmed = row.trim().replace(/^\|/, '').replace(/\|$/, '');
  const out = [];
  let cur = '';
  for (let i = 0; i < trimmed.length; i++) {
    const c = trimmed[i];
    if (c === '\\' && trimmed[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (c === '|') {
      out.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

/** Escape bare pipes that sit inside inline code spans. Returns the fixed row and how many it fixed. */
function escapeSpans(row) {
  let fixed = 0;
  const out = row.replace(/`[^`]*`/g, (span) =>
    span.replace(/\|/g, (pipe, at, s) => {
      if (s[at - 1] === '\\') return pipe;
      fixed++;
      return '\\|';
    }),
  );
  return { out, fixed };
}

/** Bare pipes inside code spans still present in a row, for the diagnostic. */
function bareSpans(row) {
  return (row.match(/`[^`]*`/g) || []).filter((s) => /(?<!\\)\|/.test(s));
}

let tables = 0;
let rows = 0;
let notes = 0;
let failures = 0;
let escaped = 0;

for (const rel of files) {
  const path = join(ROOT, rel);
  if (!existsSync(path)) {
    console.log(`SKIP  ${rel}: not found`);
    continue;
  }
  const original = readFileSync(path, 'utf8');
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const lines = original.split(/\r?\n/);
  let changed = false;
  let block = null;

  const flush = () => {
    if (!block || block.length < 2) {
      block = null;
      return;
    }
    const isTable = SEPARATOR.test(block[1].text);
    if (!isTable) {
      notes++;
      console.log(`NOTE  ${rel}:${block[0].no}: ${block.length} pipe-line(s) with no ---|--- separator on line ${block[0].no + 1} -- a table interrupted by prose; those rows have no header and render on their own (D48)`);
      block = null;
      return;
    }
    tables++;
    const headCells = cellsOf(block[0].text).length;
    for (const line of block) {
      if (SEPARATOR.test(line.text)) continue;
      rows++;
      let text = line.text;
      if (WRITE) {
        const r = escapeSpans(text);
        if (r.fixed) {
          escaped += r.fixed;
          text = r.out;
          lines[line.no - 1] = text;
          changed = true;
        }
      }
      const spans = bareSpans(text);
      if (spans.length) {
        failures++;
        console.log(`FAIL  ${rel}:${line.no}: bare pipe inside a code span splits the row${WRITE ? ' (still, after --write: check nesting)' : ''}`);
        for (const s of spans.slice(0, 3)) console.log(`        ${s.slice(0, 110)}`);
        if (!WRITE) console.log('        fix: node tools/check-docs-tables.mjs --write');
      }
      const got = cellsOf(text).length;
      if (got !== headCells) {
        failures++;
        console.log(`FAIL  ${rel}:${line.no}: ${got} cells, header has ${headCells} -- a column is missing or extra; only a human knows what it should say`);
        console.log(`        row starts: ${text.trim().slice(0, 110)}`);
      }
    }
    block = null;
  };

  for (let i = 0; i < lines.length; i++) {
    if (/^\s*\|/.test(lines[i])) {
      if (!block) block = [];
      block.push({ no: i + 1, text: lines[i] });
    } else {
      flush();
    }
  }
  flush();
  if (changed) {
    writeFileSync(path, lines.join(eol), 'utf8');
    console.log(`WROTE ${rel}: escaped bare pipes inside code spans`);
  }
}

console.log('');
console.log(
  failures
    ? `DOCS TABLES: ${failures} failure(s) across ${tables} table(s), ${rows} row(s) checked, ${notes} interrupted-table note(s)${escaped ? `, ${escaped} pipe(s) escaped by --write` : ''}`
    : `DOCS TABLES: clean -- ${rows} rows in ${tables} tables agree with their headers and hold no bare pipes${notes ? `; ${notes} NOTE(s) about tables interrupted by prose (D48)` : ''}${escaped ? `; ${escaped} pipe(s) escaped by --write` : ''}`,
);
process.exitCode = failures ? 1 : 0;
