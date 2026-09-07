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
function rowsOf(md) {
  const out = [];
  md.split('\n').forEach((line, i) => {
    if (!line.startsWith('|')) return;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
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
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 4 || !/^~{0,2}D\d+~{0,2}$/.test(cells[0])) return;
    const repro = cells[cells.length - 2];
    if (!/[A-Za-z0-9]/.test(repro.replace(/^[—-]+$/, ''))) bad.push(`line ${i + 1} (${cells[0]}): no reproduce column content`);
  });
  assert.deepEqual(bad, [], `ledger rows without a reproduce entry:\n  ${bad.join('\n  ')}`);
});
