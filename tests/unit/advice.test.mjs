import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { knownReasons, advise } from '../../core/decode/advice.js';

/**
 * Every rejection the decoder can produce must come with a cause and an
 * instruction, because "detection failed" is not something an operator can act
 * on. The mapping is easy to forget when a new branch is added, so it is checked
 * against the source text rather than against somebody's memory.
 */

const here = dirname(fileURLToPath(import.meta.url));
const DECODE_DIR = join(here, '..', '..', 'core', 'decode');

function literalReasons() {
  const found = new Set();
  for (const name of readdirSync(DECODE_DIR)) {
    if (!name.endsWith('.js') || name === 'advice.js') continue;
    const src = readFileSync(join(DECODE_DIR, name), 'utf8');
    // reason: 'foo'  |  reason: `foo-${x}` (prefix part only)
    for (const m of src.matchAll(/reason:\s*'([a-z0-9-]+)'/g)) found.add(m[1]);
    for (const m of src.matchAll(/reason:\s*`([a-z0-9-]+)-/g)) found.add(m[1] + '-*');
    // readFast wraps the echo failure as `echo-${reason}`
    for (const m of src.matchAll(/reason:\s*`echo-\$\{([a-z]+)\.reason\}`/g)) found.add('echo-template');
  }
  return found;
}

test('advice: every mapped reason is a real failure shape', () => {
  const keys = knownReasons();
  assert.ok(keys.length >= 10, `only ${keys.length} reasons mapped`);
  for (const k of keys) {
    const a = advise({ stage: 'x', reason: k });
    assert.ok(a.known, `${k} should be known`);
    assert.ok(a.cause.length > 20 && a.do.length > 10, `${k} has thin advice`);
    assert.ok(/[a-z]/.test(a.cause));
  }
});

test('advice: decoder source reasons are all covered (or explicitly templated)', () => {
  const mapped = new Set(knownReasons());
  const literal = literalReasons();
  const missing = [];
  for (const r of literal) {
    if (r === 'echo-template') continue;
    if (r.endsWith('-*')) {
      // template: the concrete suffix must be covered by a family entry
      const prefix = r.slice(0, -2);
      if (![...mapped].some((k) => k.startsWith(prefix))) missing.push(r);
      continue;
    }
    if (!mapped.has(r)) missing.push(r);
  }
  assert.deepEqual(missing, [], `unmapped failure reasons (add advice, or the operator gets generic advice): ${missing.join(', ')}`);
});

test('advice: an unmapped reason still yields guidance and announces itself', () => {
  const a = advise({ stage: 'readout', reason: 'brand-new-failure' });
  assert.equal(a.known, false);
  assert.match(a.cause, /unmapped/);
  assert.ok(a.do.length > 10);
});

test('advice: no user-facing string carries markdown, because both hosts print it as plain text', () => {
  // The browser logs through textContent and the CLI writes plain console lines, so **bold** reaches the
  // user with its asterisks (AGENTS section 6.6). Round 285 found two, both in the Chinese one-liners and
  // both on paths a phone user actually hits: markers/no-contrast and digest-mismatch.
  const markdown = /\*\*|__/;
  // Positive control first: the detector has to be able to fire, or the sweep below proves nothing.
  assert.ok(markdown.test('但**四个角标必须还在画面里**'), 'the detector must fire on the shape that was shipped');
  const bad = [];
  for (const reason of knownReasons()) {
    const a = advise({ reason });
    for (const field of ['cause', 'do', 'zh']) {
      const text = a[field];
      if (typeof text === 'string' && markdown.test(text)) bad.push(reason + '.' + field);
    }
  }
  assert.deepEqual(bad, [], 'user-facing advice must be plain text; markdown found in: ' + bad.join(', '));
});
