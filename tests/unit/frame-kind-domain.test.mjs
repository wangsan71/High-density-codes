/**
 * PSKT unit tests -- header.kind is a u8, so comparing it against a string is a lie that
 * nothing in this repository would otherwise catch (docs/DEFECTS.md D15).
 *
 * The sender counted parity pages this way for many rounds: `p.header.kind` compared to a
 * quoted literal is false for every page, so the UI reported zero parity pages on every
 * transfer. Nothing else went visibly wrong -- pages were still built, the receiver still
 * assembled, the SHA-256 still matched -- the count was simply always 0, and a count that is
 * always 0 looks exactly like a transfer that genuinely has no parity pages. That is the
 * shape of bug this contract cares most about: a plausible-looking number that is not true.
 *
 * Pinned from two directions. First, what the encoder actually emits, decoded back through
 * the frame module. Second, a source scan for the mistake's shape -- scoped to `.header.kind`
 * because `web/capture.js` has a `kind` of its own that is a string by design, and a check
 * that fires on correct code gets ignored, which is worse than no check. Both directions get
 * a positive control, since a scan that cannot fail proves nothing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { PAGE_KIND, decodeHeader } from '../../core/frame.js';
import { encodeTransfer } from '../../core/protocol.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

// A header kind compared against a quoted literal. The mistake lives in the quoting, so the
// shape is worth scanning for independently of any one call site.
const STRING_HEADER_KIND = /\.header\.kind\s*[=!]==?\s*['"][A-Za-z_-]+['"]/g;

test('the encoded page-kind domain is exactly the declared PAGE_KIND values, as numbers', async () => {
  const it = await encodeTransfer(new Uint8Array(4096).fill(7), { profile: 'P-M1-300', parityPct: 50 });
  assert.ok(it.pages.length >= 2, `a 4 KiB payload at parityPct 50 must span pages, got ${it.pages.length}`);
  const seen = new Set();
  for (const p of it.pages) {
    const h = decodeHeader(p.header);
    assert.equal(h.ok, true, `the header must decode: ${h.reason}`);
    assert.equal(typeof h.header.kind, 'number', `kind must be a u8 number, got ${typeof h.header.kind}`);
    assert.ok(
      Object.values(PAGE_KIND).includes(h.header.kind),
      `kind ${h.header.kind} is not one of the declared PAGE_KIND values`,
    );
    seen.add(h.header.kind);
  }
  assert.deepEqual(
    [...seen].sort((a, b) => a - b),
    [PAGE_KIND.DATA, PAGE_KIND.PARITY].sort((a, b) => a - b),
    'parityPct 50 must actually produce both kinds, or this test would pass on a data-only transfer',
  );
});

test('no source file compares a header kind against a string literal', () => {
  const hits = [];
  let files = 0;
  for (const dir of ['web', 'cli', 'tools', 'core']) {
    for (const name of readdirSync(join(ROOT, dir), { recursive: true })) {
      const p = join(ROOT, dir, String(name));
      if (!/\.(js|mjs)$/.test(p) || !statSync(p).isFile()) continue;
      // web/dist holds built output. Scanning it made this test's verdict depend on whether
      // the bundle had been rebuilt since the source changed -- it failed on a stale copy of
      // an already-fixed line, and passed only because a build happened to run first. The
      // rule is about source, so generated directories are skipped rather than tolerated.
      if (/(^|[\\/])(dist|node_modules)([\\/]|$)/.test(p)) continue;
      files++;
      for (const m of readFileSync(p, 'utf8').matchAll(STRING_HEADER_KIND)) {
        hits.push(`${dir}/${String(name).split(/[\\/]+/).pop()}: ${m[0]}`);
      }
    }
  }
  assert.ok(files >= 30, `the scan must have walked the real tree, saw only ${files} files`);
  assert.deepEqual(hits, [], `always-false comparison of a u8 header field: ${hits.join(' | ')}`);
});

test('the scan can fail, and does not fire on correct code (positive control)', () => {
  STRING_HEADER_KIND.lastIndex = 0;
  assert.equal(
    STRING_HEADER_KIND.test(`pages.filter((p) => p.header.kind === 'parity')`),
    true,
    'the regex must catch the original bug',
  );
  STRING_HEADER_KIND.lastIndex = 0;
  assert.equal(
    STRING_HEADER_KIND.test('pages.filter((p) => p.header.kind === PAGE_KIND.PARITY)'),
    false,
    'the constant form is correct and must not be flagged',
  );
  STRING_HEADER_KIND.lastIndex = 0;
  assert.equal(
    STRING_HEADER_KIND.test("if (r.kind === 'page') say('ok')"),
    false,
    "capture.js's own string-typed kind is a different field and must not be flagged",
  );
  STRING_HEADER_KIND.lastIndex = 0;
});
