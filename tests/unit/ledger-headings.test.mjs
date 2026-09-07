/**
 * PSKT unit tests -- the ledgers must keep their section headings.
 *
 * Eight times an edit to docs/STATUS.md or docs/DEFECTS.md inserted a new section and took the
 * heading that followed it, leaving an orphan table or a missing round. Round 35 turned that
 * into a rule ("new_string must end with old_string verbatim") and round 36 broke the rule
 * immediately, which is the evidence that a rule I have to remember is not a control. So this
 * file checks the symptom instead, per document:
 *
 *   STATUS.md   round headings run newest-first, one per round, no gaps. A swallowed heading
 *               shows up as a missing round number or a duplicate.
 *   DEFECTS.md  gaps and repeats are legitimate here -- a round may have both a "new" and a
 *               "closed" section, and a round that only struck rows in place has no section at
 *               all -- so contiguity would be a false alarm. The symptom that is not
 *               legitimate is a ledger table with no heading above it, or a round heading with
 *               no table under it.
 *
 * Every helper gets a positive control, because a checker that cannot fail is decoration.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const docLines = (rel) => readFileSync(join(ROOT, rel), 'utf8').split(/\r?\n/);

const ROUND = /^###\s*第\s*(\d+)\s*轮/;
const LEDGER_TABLE = /^\|\s*#\s*\|\s*缺陷\s*\|/;

function roundHeadings(lines) {
  const out = [];
  lines.forEach((l, i) => {
    const m = ROUND.exec(l);
    if (m) out.push({ n: Number(m[1]), line: i + 1 });
  });
  return out;
}

/** STATUS.md: newest-first, one heading per round, no missing round in between. */
function statusProblems(lines) {
  const hs = roundHeadings(lines);
  if (hs.length < 5) return [`only ${hs.length} round headings found -- this walk is not reading the real ledger`];
  const problems = [];
  for (let i = 1; i < hs.length; i++) {
    if (hs[i].n >= hs[i - 1].n) {
      problems.push(`line ${hs[i].line}: round ${hs[i].n} is not older than round ${hs[i - 1].n} above it (headings run newest-first; a repeat means an edit re-added or swallowed one)`);
    }
  }
  const nums = hs.map((h) => h.n);
  for (let n = Math.min(...nums); n <= Math.max(...nums); n++) {
    if (!nums.includes(n)) problems.push(`round ${n} has no heading -- a section was swallowed by an edit`);
  }
  return problems;
}

/** DEFECTS.md: a ledger table with no heading above it is a heading an edit ate. */
function orphanTables(lines) {
  const bad = [];
  lines.forEach((l, i) => {
    if (!LEDGER_TABLE.test(l)) return;
    const above = lines.slice(Math.max(0, i - 3), i).join('\n');
    if (!/^#{2,3}\s/m.test(above)) bad.push(`line ${i + 1}: a ledger table has no heading within 3 lines above it`);
  });
  return bad;
}

/** DEFECTS.md: a round heading with nothing under it is a table an edit ate. */
function headingsWithoutTable(lines) {
  const bad = [];
  lines.forEach((l, i) => {
    if (!ROUND.test(l)) return;
    // Any table row within three lines counts. Requiring the separator specifically would
    // flag a legitimate section whose first row is the `| # | ... |` header.
    if (!lines.slice(i + 1, i + 4).some((x) => /^\|/.test(x))) {
      bad.push(`line ${i + 1}: round heading with no table under it`);
    }
  });
  return bad;
}

test('docs/STATUS.md keeps one heading per round, newest first, with no round missing', () => {
  const lines = docLines('docs/STATUS.md');
  assert.deepEqual(statusProblems(lines), [], 'STATUS.md round headings are broken');
});

test('docs/DEFECTS.md has no orphan ledger table and no empty round section', () => {
  const lines = docLines('docs/DEFECTS.md');
  assert.deepEqual(orphanTables(lines), [], 'a ledger table lost its heading');
  assert.deepEqual(headingsWithoutTable(lines), [], 'a round heading lost its table');
});

test('the ledger checkers can fail (positive controls)', () => {
  // A missing round, and a repeated one.
  assert.equal(statusProblems(['### 第 7 轮', '### 第 6 轮', '### 第 4 轮', '### 第 3 轮', '### 第 2 轮']).length, 1);
  assert.match(statusProblems(['### 第 7 轮', '### 第 6 轮', '### 第 5 轮', '### 第 5 轮', '### 第 4 轮']).join(' '), /not older than/);
  // A well-formed ledger is clean, so the two above are not just "always fails". Five rounds,
  // because fewer trips the anti-vacuity guard that keeps this checker honest about having
  // read a real ledger at all.
  assert.deepEqual(statusProblems(['### 第 5 轮', '### 第 4 轮', '### 第 3 轮', '### 第 2 轮', '### 第 1 轮']), []);
  // An orphan table, and the same table under a heading.
  assert.equal(orphanTables(['| # | 缺陷 | 复验 | 状态 |', '|---|---|---|---|']).length, 1);
  assert.deepEqual(orphanTables(['### 第 9 轮闭掉的', '', '| # | 缺陷 | 复验 | 状态 |', '|---|---|---|---|']), []);
  // A heading whose table was eaten.
  assert.equal(headingsWithoutTable(['### 第 9 轮', '', '只有散文，没有表格']).length, 1);
  assert.deepEqual(headingsWithoutTable(['### 第 9 轮', '', '| # | 缺陷 |', '|---|---|']), []);
});
