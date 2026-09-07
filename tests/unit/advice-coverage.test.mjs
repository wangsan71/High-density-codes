/**
 * Decision 11 says every failure reason must carry advice. That is only true if
 * something enforces it, and nothing did: five reasons (`intra-fail`, `bad-magic`,
 * `header-crc`, `short-header`, `other-session`) were reachable -- I watched the CLI
 * print "unmapped failure (assemble: intra-fail)" while telling the user to retake a
 * whole batch whose other pages were fine. So: scan the core for every reason string
 * it can emit and require advice for each one.
 *
 * Deliberately one-directional. The reverse check (no advice without an emitting
 * site) is NOT asserted here: several keys are built dynamically ('echo-' + reason),
 * so a literal scan would report five false positives -- the mistake made twice now
 * with guards stricter than the code they police.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { advise } from '../../core/decode/advice.js';

const SCAN = ['core/decode', 'core/render', 'core'];
const seen = new Map(); // reason -> files that mention it

function collect(file) {
  const src = readFileSync(file, 'utf8');
  // reason: 'x'  |  reason: "x"  |  reasons compared against a table: 'x' in REASONS
  for (const m of src.matchAll(/reason:\s*'([a-z0-9-]+)'/g)) {
    if (!seen.has(m[1])) seen.set(m[1], new Set());
    seen.get(m[1]).add(file);
  }
}

function walk(rel) {
  const abs = new URL(`../../${rel}/`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
  for (const e of readdirSync(abs, { withFileTypes: true })) {
    if (e.isDirectory() && !e.name.startsWith('.')) walk(`${rel}/${e.name}`);
    else if (e.isFile() && e.name.endsWith('.js') && !/\.test\.js$/.test(e.name)) collect(`${rel}/${e.name}`);
  }
}

test('every reason the core can emit has mapped advice (decision 11)', () => {
  for (const rel of SCAN) walk(rel);
  const missing = [...seen.keys()].filter((r) => !advise({ stage: 'audit', reason: r }).known);
  assert.ok(
    seen.size >= 20,
    `the scan found only ${seen.size} reason strings -- it is probably matching nothing, which would make this test decoration`,
  );
  assert.deepEqual(missing, [], `reasons without advice: ${missing.join(', ')}`);
  assert.ok(
    seen.has('intra-fail') && seen.has('other-session'),
    'the scan must actually see the assemble-stage reasons that motivated this test',
  );
});

test('an unknown reason says so instead of borrowing somebody else advice', () => {
  const a = advise({ stage: 'markers', reason: 'reason-invented-by-a-future-commit' });
  assert.equal(a.known, false);
  assert.match(a.cause, /unmapped failure \(markers: reason-invented-by-a-future-commit\)/);
});
