import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findDeadLocals, findOrphanTools, countMentions, loadSources } from '../../tools/find-dead-locals.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Round 262 promoted the module-scope sweep out of a throwaway probe under .tmp/ into a command, because
 * the ledger is not allowed to point at a file that is not in the repository. These tests are the
 * detector's positive control: a sweep that cannot go red is worse than no sweep, since it prints a
 * green that means nothing.
 *
 * Every assertion below states both directions -- it fails if the detector stops firing on the known
 * dead, and also if it starts firing on the known live.
 */

test('the module-scope detector fires on a dead local and stays silent on a live one', () => {
  const sources = new Map([
    ['core/fixture.js', 'function live() { return 1; }\nfunction dead() { return 2; }\nconst \$ = (id) => id;\n\$("out");\n'],
    ['core/caller.js', 'live();\n'],
  ]);
  const { product, test: testBucket } = findDeadLocals(sources);
  assert.deepEqual(
    product.map((r) => r.file + ':' + r.name),
    ['core/fixture.js:dead'],
    'exactly the dead local; "live" is called elsewhere and the \$ helper is called as \$(...) so it is live too',
  );
  assert.deepEqual(testBucket, []);
  // The \$ case is a regression control, not decoration: round 257 used a plain \b boundary, which sits
  // between a space and a dollar sign, so a call written \$(...) never counted as a mention and the sweep
  // reported a helper that is called on nearly every line of web/app.js as dead.
  assert.equal(countMentions(sources, '\$'), 2, 'the declaration and the call both count');
});

test('a product name mentioned only by a test is not reported by this sweep', () => {
  // Deliberate: the export scanner already has a "mentioned only by tests" bucket for exactly this
  // shape, and a measurement helper exercised by tests is not dead code. This bucket is for names no
  // code mentions at all.
  const sources = new Map([
    ['core/probe.js', 'function probe() { return 1; }\n'],
    ['tests/probe.test.mjs', 'probe();\n'],
  ]);
  assert.deepEqual(findDeadLocals(sources).product, []);
});

test('a declaration inside a function is not module scope', () => {
  const sources = new Map([['core/inner.js', 'function outer() {\n  const inner = 1;\n  return inner;\n}\nouter();\n']]);
  // Column zero is the whole definition of module scope here: a body declaration is indented, so it can
  // never match the anchor. Without this control, a change to the anchor could report every local in
  // every function and the suite would still pass the two tests above.
  assert.deepEqual(findDeadLocals(sources).product, []);
});

test('the tool-file detector reports an orphan and honours a mention in the docs', () => {
  const sources = new Map([
    ['tools/live-tool.mjs', 'export const x = 1;\n'],
    ['tools/dead-tool.mjs', 'export const y = 2;\n'],
    ['docs/notes.md', 'the command is node tools/live-tool.mjs\n'],
  ]);
  const { examined, orphans } = findOrphanTools(sources);
  assert.equal(examined, 2);
  assert.deepEqual(orphans.map((r) => r.file), ['tools/dead-tool.mjs'], 'docs count as a reference; nothing self-references');
});

test('the repository itself has no dead module-scope name and no orphan tool file', () => {
  const sources = loadSources(ROOT);
  assert.ok(sources.size > 100, 'the walk actually found the repository (got ' + sources.size + ' text files)');
  const { product, test: testBucket } = findDeadLocals(sources);
  assert.deepEqual(
    product.map((r) => r.file + ':' + r.name),
    [],
    'delete the name, or mention it where it is actually used -- candidates are not verdicts, but a new one needs a reason',
  );
  // Test code is out of scope for the sweep by the standing directive; it is asserted only so that the
  // bucket cannot silently start swallowing product code.
  for (const r of testBucket) assert.match(r.file, /^tests\//);
  const { orphans } = findOrphanTools(sources);
  assert.deepEqual(orphans.map((r) => r.file), [], 'a tool nothing mentions is either wired into the docs or deleted');
});
