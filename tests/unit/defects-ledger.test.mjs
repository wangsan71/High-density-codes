import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * The defect ledger is load-bearing: rounds are prioritised by reading it, and the plan's
 * honesty claim ("errors are recorded, not hidden") is checked against it. But it is edited
 * by hand, in markdown tables, across many rounds -- and the editing pattern that keeps
 * going wrong is appending a new table with a defect's new state while the old row still
 * asserts the previous one. Three rounds in a row the editor ate a section heading, which
 * silently reparents rows under the wrong state.
 *
 * So do not trust prose discipline here: assert that a defect id cannot be OPEN in one row
 * and CLOSED in another. Rows that merely point at another section (both states CLOSED) are
 * fine, because they add no contradiction. The check reads every table row in the file and
 * ignores prose mentions, since only a row claims a state.
 */
/**
 * Cells of a markdown table row, honouring the `\|` escape.
 *
 * Splitting on a bare '|' is wrong for this file: rows legitimately contain escaped pipes (a grep
 * pattern such as `crop\|registration`, a flag list such as `A4\|Letter`), and a naive split slices
 * such a row into extra cells, so a guard then reads the *state* and *reproduce* columns out of the
 * wrong fragments. That is exactly what both guards below did until round 48: for the D44 row they
 * happened to land on the right cells only because every escaped pipe in that row sits before them,
 * which is the worst outcome -- a guard that is wrong and still green. Round 48 found this while
 * inspecting that row by hand and first blamed the ledger; the ledger was fine and the inspection
 * was not. Splitting on unescaped pipes only, then asserting the cell count, makes both the escape
 * and a genuinely malformed row visible.
 */
const cellsOf = (line) => line.split(/(?<!\\)\|/).slice(1, -1).map((c) => c.trim());

function rowsOf(md) {
  const out = [];
  md.split('\n').forEach((line, i) => {
    if (!line.startsWith('|')) return;
    const cells = cellsOf(line);
    if (cells.length < 2) return;
    const m = /^~{0,2}(D\d+)~{0,2}$/.exec(cells[0]);
    if (!m) return; // header row, separator row, or a non-defect table
    const struck = cells[0].includes('~~');
    const saysClosed = /CLOSED/.test(cells[cells.length - 1]) || struck;
    out.push({ id: m[1], line: i + 1, state: saysClosed ? 'CLOSED' : 'OPEN' });
  });
  return out;
}

test('docs/DEFECTS.md tracks every defect in exactly one state', () => {
  const md = readFileSync(join(ROOT, 'docs', 'DEFECTS.md'), 'utf8');
  const rows = rowsOf(md);
  assert.ok(rows.length >= 20, `expected a populated ledger, found ${rows.length} defect rows`);
  const byId = new Map();
  for (const r of rows) {
    if (!byId.has(r.id)) byId.set(r.id, []);
    byId.get(r.id).push(r);
  }
  const conflicts = [];
  for (const [id, list] of byId) {
    const states = new Set(list.map((r) => r.state));
    if (states.size > 1) conflicts.push(`${id}: ${list.map((r) => `line ${r.line}=${r.state}`).join(', ')}`);
  }
  assert.deepEqual(conflicts, [], `defect rows contradict each other -- strike the superseded row:\n  ${conflicts.join('\n  ')}`);
});

test('docs/DEFECTS.md keeps its rule lines and every row reproducible', () => {
  const md = readFileSync(join(ROOT, 'docs', 'DEFECTS.md'), 'utf8');
  // The file's own contract: each entry must carry a command, because "recorded" without
  // "reproducible" degrades into a wish list within two rounds.
  const bad = [];
  md.split('\n').forEach((line, i) => {
    if (!line.startsWith('|')) return;
    const cells = cellsOf(line);
    if (cells.length < 4 || !/^~{0,2}D\d+~{0,2}$/.test(cells[0])) return;
    const repro = cells[cells.length - 2];
    if (!/[A-Za-z0-9]/.test(repro.replace(/^[—-]+$/, ''))) bad.push(`line ${i + 1} (${cells[0]}): no reproduce column content`);
  });
  assert.deepEqual(bad, [], `ledger rows without a reproduce entry:\n  ${bad.join('\n  ')}`);
});

test('the cell splitter honours an escaped pipe, so the guards above are not reading fragments', () => {
  // Positive control first: if cellsOf were the old naive split, both of these would be wrong and
  // every guard in this file would be judging the wrong columns while staying green.
  assert.deepEqual(cellsOf('| D1 | a\\|b | c | d |'), ['D1', 'a\\|b', 'c', 'd'], 'an escaped pipe must stay inside its cell');
  assert.deepEqual(cellsOf('| D1 | a|b | c | d |'), ['D1', 'a', 'b', 'c', 'd'], 'a bare pipe really does split, which is what the next test forbids in the ledger');
  assert.deepEqual(cellsOf('| ~~D9~~ | x | y | CLOSED |'), ['~~D9~~', 'x', 'y', 'CLOSED'], 'a struck id and a state cell must survive intact');
});

test('every defect row has exactly the four columns the header declares', () => {
  const md = readFileSync(join(ROOT, 'docs', 'DEFECTS.md'), 'utf8');
  const bad = [];
  let rows = 0;
  md.split('\n').forEach((line, i) => {
    if (!line.startsWith('|')) return;
    const cells = cellsOf(line);
    if (!/^~{0,2}D\d+~{0,2}$/.test(cells[0] || '')) return;
    rows++;
    if (cells.length !== 4) {
      bad.push(`line ${i + 1} (${cells[0]}): ${cells.length} cells, expected 4 -- a bare '|' inside a cell splits the row and silently reparents the state and reproduce columns; write '\\|' instead`);
    }
  });
  assert.ok(rows >= 20, `expected a populated ledger, found ${rows} defect rows -- this guard would otherwise pass on an empty file`);
  assert.deepEqual(bad, [], `malformed ledger rows:\n  ${bad.join('\n  ')}`);
});
