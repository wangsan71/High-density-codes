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
 *
 * D12, fixed here rather than in the criterion: the scan used to read comments as code, so
 * writing `reason: 'x'` in prose -- I did it to explain renaming a success path -- made this
 * test demand advice for a reason the core cannot emit. The fix strips comments before matching.
 * The way to get that wrong is to strip too much, because a reason swallowed by an over-eager
 * stripper disappears silently and the requirement set shrinks with it; that is why the
 * stripper walks the source as a scanner (string, template, regex literal, comment) instead of
 * deleting /*...*\/ and //... with a regex, and why the sensitivity pins below -- a minimum
 * count and two named reasons -- stay exactly where they were. They are what turns "the stripper
 * ate something" from a silent weakening into a red test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { advise, knownReasons, localizedReasons } from '../../core/decode/advice.js';

const SCAN = ['core/decode', 'core/render', 'core'];
const reasonRe = () => /reason:\s*'([a-z0-9-]+)'/g;

/** Characters after which a `/` is division rather than the start of a regex literal. */
const operandEnd = (ch) => /[A-Za-z0-9_$'"`)\]]/.test(ch);
/** ...except after these keywords, where a `/` really does start a regex. */
const REGEX_PRECEDERS = ['return', 'typeof', 'instanceof', 'case', 'in', 'of', 'new', 'delete', 'void', 'throw', 'do', 'else', 'yield', 'await'];

/**
 * Remove JS comments and keep everything else byte for byte.
 *
 * Known simplification, stated rather than hidden: inside a template literal the `${}`
 * sub-expressions are not tracked, so a backtick nested in an interpolation would end the
 * template early. Nothing in core/ does that, and if it ever does the pins below go red
 * instead of the requirement set quietly shrinking.
 */
function stripComments(src) {
  let out = '';
  let prev = ''; // last significant character emitted
  let prevWord = ''; // trailing run of letters, for the keyword case above
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && d === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      out += ' '; // keep neighbouring tokens from fusing
      prev = ' ';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      out += c;
      i++;
      while (i < n) {
        if (src[i] === '\\') {
          out += src[i] + (i + 1 < n ? src[i + 1] : '');
          i += 2;
          continue;
        }
        out += src[i];
        const done = src[i] === q;
        i++;
        if (done) break;
      }
      prev = q;
      prevWord = '';
      continue;
    }
    if (c === '/' && (prev === '' || !operandEnd(prev) || REGEX_PRECEDERS.includes(prevWord))) {
      out += c;
      i++;
      let inClass = false;
      while (i < n) {
        const e = src[i];
        if (e === '\\') {
          out += e + (i + 1 < n ? src[i + 1] : '');
          i += 2;
          continue;
        }
        out += e;
        i++;
        if (e === '[') inClass = true;
        else if (e === ']') inClass = false;
        else if (e === '/' && !inClass) break;
      }
      while (i < n && /[a-z]/.test(src[i])) {
        out += src[i];
        i++;
      }
      prev = '/';
      prevWord = '';
      continue;
    }
    out += c;
    if (!/\s/.test(c)) {
      prev = c;
      prevWord = /[A-Za-z]/.test(c) ? (prevWord + c).slice(-12) : '';
    }
    i++;
  }
  return out;
}

/** The reason literals in a source text, in order. Shared by the scan and by the tests below. */
const scanReasons = (src) => [...src.matchAll(reasonRe())].map((m) => m[1]);

function collect(file, sink, strip) {
  const raw = readFileSync(file, 'utf8');
  for (const r of scanReasons(strip ? stripComments(raw) : raw)) {
    if (!sink.has(r)) sink.set(r, new Set());
    sink.get(r).add(file);
  }
}

function walk(rel, sink, strip) {
  const abs = new URL(`../../${rel}/`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
  for (const e of readdirSync(abs, { withFileTypes: true })) {
    if (e.isDirectory() && !e.name.startsWith('.')) walk(`${rel}/${e.name}`, sink, strip);
    else if (e.isFile() && e.name.endsWith('.js') && !/\.test\.js$/.test(e.name)) collect(`${rel}/${e.name}`, sink, strip);
  }
}

const scanTree = (strip) => {
  const sink = new Map();
  for (const rel of SCAN) walk(rel, sink, strip);
  return sink;
};

test('every reason the core can emit has mapped advice (decision 11)', () => {
  const seen = scanTree(true);
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

test('the stripper drops prose and keeps code (D12)', () => {
  // The exact shape that broke it: a comment explaining a rename carries the literal.
  assert.deepEqual(scanReasons(stripComments("/* reason: 'phantom-in-prose' */ const o = { reason: 'real-one' };")), ['real-one']);
  assert.deepEqual(scanReasons(stripComments("// reason: 'line-phantom'\nconst o = { reason: 'kept' };")), ['kept']);
  // A doc comment that quotes a whole line of code must not become a requirement either.
  assert.deepEqual(scanReasons(stripComments("/**\n * renamed: reason: 'old-name'\n */\nreason: 'new-name'")), ['new-name']);
  // Eating a string or a regex literal would lose real reasons -- the one unacceptable direction.
  assert.deepEqual(scanReasons(stripComments("const s = '// not a comment'; const o = { reason: 'after-string' };")), ['after-string']);
  assert.deepEqual(scanReasons(stripComments("const re = /a\\/\\/b/; const o = { reason: 'after-regex' };")), ['after-regex']);
  // An unbalanced comment opener inside a string: a naive stripper eats the rest of the file here.
  assert.deepEqual(scanReasons(stripComments("const s = '/* open'; const o = { reason: 'after-unbalanced' };")), ['after-unbalanced']);
  assert.deepEqual(scanReasons(stripComments("if (x) return /reason: 'return-then-regex'/.source;")), ['return-then-regex']);
  // An escaped quote inside a string must not end it early and expose what follows as code.
  assert.deepEqual(scanReasons(stripComments("const s = 'a\\'b // c'; const o = { reason: 'after-escape' };")), ['after-escape']);
});

test('on the real tree, stripping changes nothing today -- and names it if that ever stops being true', () => {
  const naive = scanTree(false);
  const stripped = scanTree(true);
  const proseOnly = [...naive.keys()].filter((r) => !stripped.has(r));
  const invented = [...stripped.keys()].filter((r) => !naive.has(r));
  assert.deepEqual(invented, [], 'the stripper produced reasons that are not in the source at all');
  assert.deepEqual(
    proseOnly,
    [],
    `these reasons appear only inside comments, so they are not emittable and must not be required: ${proseOnly.join(', ')}`,
  );
  assert.ok(stripped.size >= 20, `stripped scan found only ${stripped.size} reasons -- the stripper is eating code`);
});


test('the phone UI translation table names real reasons and covers the phone path (D72)', () => {
  const known = new Set(knownReasons());
  const zh = localizedReasons();
  // Anti-vacuity: an empty table would make the rest pass without translating anything.
  assert.ok(zh.length >= 10, `only ${zh.length} localized reason(s) -- the phone UI would fall back to English`);
  for (const r of zh) {
    assert.ok(known.has(r), `${r} has a Chinese line but no entry in ADVICE -- a rename left it dangling`);
    assert.ok(advise({ reason: r }).zh.length > 8, `${r}: the Chinese line is empty or a stub`);
  }
  // Every reason the burst UI can realistically surface must be localized, or the phone user
  // (the audience those diagnoses were written for) sees English or a generic line again.
  const phonePath = ['no-contrast', 'echo-no-contrast', 'no-square-candidates', 'no-rectangular-quad', 'no-hollow-corner', 'fourth-corner-out-of-frame', 'blank-image', 'no-geometry-matched', 'intra-fail', 'digest-mismatch'];
  for (const r of phonePath) assert.ok(zh.includes(r), `${r} can reach the phone but has no Chinese line`);
  // Negative control: an unmapped reason must NOT borrow a translation.
  assert.equal(advise({ reason: 'definitely-not-a-reason' }).zh, undefined);
});
test('an unknown reason says so instead of borrowing somebody else advice', () => {
  const a = advise({ stage: 'markers', reason: 'reason-invented-by-a-future-commit' });
  assert.equal(a.known, false);
  assert.match(a.cause, /unmapped failure \(markers: reason-invented-by-a-future-commit\)/);
});
