import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyExports } from '../../tools/find-dead-exports.mjs';
import { loadSources } from '../../tools/find-dead-locals.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BS = String.fromCharCode(92);

/**
 * Round 267 taught this repository something expensive: core/render/glyphs.js carried a function
 * (glyphMask) that nothing had called for 25+ rounds -- including its own file -- while the sweep kept
 * reporting "3 candidates, all documented interfaces". The reason was the mention test: it used a bare
 * RegExp(name), so every mention of the longer glyphMaskForLevel counted as a mention of glyphMask and
 * the dead function looked alive. The sweep now uses word boundaries, and these tests are its permanent
 * positive control: a sweep that cannot go red is worse than no sweep, because it prints a green that
 * means nothing.
 *
 * The fixture assertions are exact (both directions: dead flagged, live silent). The repository
 * assertions are deliberately semantic rather than exact-count: a name that nothing outside its own
 * file mentions is only dead if its own file does not use it either. That is the rule the directive
 * cares about, and unlike "the count must be 3" it does not fire on an export kept for a future test.
 */

function mentionsInOwnFile(sources, row) {
  const text = sources.get(row.file);
  const META = '.*+?^$()[]{}|' + BS;
  const escaped = Array.from(row.name).map((c) => (META.includes(c) ? BS + c : c)).join('');
  const re = new RegExp('(?<![A-Za-z0-9_$])' + escaped + '(?![A-Za-z0-9_$])', 'g');
  return (text.match(re) || []).length;
}

const FIXTURE = new Map([
  ['core/a.js', 'export function liveCore() {}\nexport function deadCore() {}\nexport function testOnlyCore() {}\n'],
  ['core/b.js', 'liveCore();\n'],
  ['tests/a.test.mjs', 'testOnlyCore();\nexport function deadTest() {}\n'],
  ['web/w.js', 'export function liveWeb() {}\nexport function deadWeb() {}\n'],
  ['web/uses.js', 'liveWeb();\n'],
]);

const names = (rows) => rows.map((r) => r.file + ':' + r.name).sort().join(',');

test('the classifier flags the dead export and stays silent on the live one', () => {
  const core = classifyExports(FIXTURE, 'core');
  assert.equal(core.examined, 3, 'three core exports in the fixture');
  assert.equal(names(core.never), 'core/a.js:deadCore');
  assert.equal(names(core.testsOnly), 'core/a.js:testOnlyCore');
});

test('scope all reaches outside core and keeps test files in their own bucket', () => {
  const all = classifyExports(FIXTURE, 'all');
  assert.equal(all.examined, 5, 'the two web exports join the three core ones');
  assert.equal(names(all.never), 'core/a.js:deadCore,web/w.js:deadWeb', 'the non-core dead one is caught, the live one is not');
  assert.equal(names(all.neverInTests), 'tests/a.test.mjs:deadTest');
  assert.equal(all.examinedTests, 1);
});

test('no core export is dead, whatever the buckets say', () => {
  const sources = loadSources(ROOT);
  const core = classifyExports(sources, 'core');
  assert.ok(core.examined > 300, 'the walk found the core exports (got ' + core.examined + ')');
  // Deliberately semantic, not an exact list of names: the three names the docs treat as interface
  // (expectedRho, decodePages, DEFAULT_PROFILE) have no product mentions, so they land in the
  // never-or-tests-only buckets -- and this test file itself mentions them, which moves them from one
  // bucket to the other. What must hold is the directive: a name nothing outside its own file mentions
  // has to be used inside its own file. Round 267's glyphMask failed exactly this and was deleted.
  const dead = core.never.filter((row) => mentionsInOwnFile(sources, row) < 2).map((r) => r.file + ':' + r.name);
  assert.deepEqual(dead, [], 'these core names are dead code: nothing mentions them and their own file never uses them');
});

test('every export nothing outside its own file mentions is at least used inside its own file', () => {
  const sources = loadSources(ROOT);
  const all = classifyExports(sources, 'all');
  const dead = [];
  for (const row of all.never) {
    // One mention is the declaration itself; anything less than two means the function or constant is
    // never called, read or exported-to-anyone -- that is the shape glyphMask had.
    if (mentionsInOwnFile(sources, row) < 2) dead.push(row.file + ':' + row.name);
  }
  assert.deepEqual(dead, [], 'these names are dead code: nothing outside their file mentions them and their own file never uses them');
  for (const row of all.neverInTests) assert.match(row.file, /^tests\//, 'test-file declarations must stay in their own bucket');
});
