import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * The acceptance kit ships tools/acceptance-readme.txt as a plain .txt the user opens in Notepad, and
 * tools/acceptance-kit.ps1 copies it verbatim (only the placeholders are substituted). Markdown emphasis
 * therefore reaches the reader as literal asterisks: round 286 found eleven instances of ** in it
 * (DEFECTS D99), on the very steps the user is told to follow. This asserts the template stays plain text.
 *
 * The same reasoning as the advice check in tests/unit/advice.test.mjs: whatever a user reads as plain
 * text must not be markdown.
 */
test('the acceptance kit README is plain text, not markdown', () => {
  const text = readFileSync(join(ROOT, 'tools', 'acceptance-readme.txt'), 'utf8');
  const markdown = /\*\*|__/;
  // Positive control first: the detector has to fire on the shape that actually shipped, or a green here
  // would mean nothing at all.
  assert.ok(markdown.test('把每一步的**终端输出**发回来'), 'the detector must fire on the shipped shape');
  const bad = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (markdown.test(line)) bad.push(i + 1 + ': ' + line.trim().slice(0, 80));
  });
  assert.deepEqual(bad, [], 'user-facing plain text must not carry markdown:\n' + bad.join('\n'));
});
