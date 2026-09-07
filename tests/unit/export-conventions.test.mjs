/**
 * PSKT unit tests -- export/import conventions inside core/.
 *
 * Why this file exists. tools/build-web.mjs refuses default exports and default/namespace
 * imports, because carrying core/** to a browser means walking every module into a plain
 * closure it can reason about. Three core modules -- render/pdf.js, render/png.js,
 * render/tiff.js -- each ended with a one-line `export default <name>;` that nothing in the
 * repository imported, and that dead line alone made PDF rendering impossible to bundle:
 * it is what blocked shipping the single-file sender (docs/DEFECTS.md D5). AGENTS.md also
 * requires core/ to be one pure ESM body, identical under Node and the browser, so `node:`
 * builtins do not belong there either.
 *
 * Both rules were convention with no check. A convention that silently costs a shipped
 * feature is not a convention, so it is a test now.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CORE_DIR = fileURLToPath(new URL('../../core/', import.meta.url));

// Paths are derived from this file, not from the working directory: a test that walks the
// wrong directory would report a green it never earned. Separators are normalised to '/'
// because readdirSync(..., {recursive:true}) returns 'render\pdf.js' on Windows, and the
// first version of this guard compared that against 'render/pdf.js' and failed -- the walk
// was fine, the string comparison was platform-blind. Node's fs accepts '/' on Windows, so
// reading these paths later is unaffected.
const jsFiles = readdirSync(CORE_DIR, { recursive: true })
  .map((p) => String(p))
  .filter((p) => p.endsWith('.js'))
  .map((p) => join(CORE_DIR, p).split(/[\\/]+/g).join('/'));

test('the walk actually sees core/ (otherwise the two rules below are vacuous)', () => {
  assert.ok(jsFiles.length >= 30, `only ${jsFiles.length} files found under ${CORE_DIR} -- the walk is broken, not the code`);
  for (const probe of ['protocol.js', 'frame.js', 'render/pdf.js', 'render/png.js', 'render/tiff.js', 'decode/fiducial.js']) {
    assert.ok(jsFiles.some((f) => f.endsWith(probe)), `expected to walk ${probe}`);
  }
});

test('core/ declares no default export -- the web bundler cannot carry one', () => {
  const offenders = jsFiles.filter((f) => /^\s*export\s+default\b/m.test(readFileSync(f, 'utf8')));
  assert.deepEqual(
    offenders,
    [],
    `${offenders.length} module(s) use a default export, which tools/build-web.mjs refuses, `
      + `so they can never reach the browser: ${offenders.map((f) => f.split('core')[1]).join(', ')}`,
  );
});

test('core/ imports nothing from node: -- it is the same ESM in Node and the browser', () => {
  const offenders = jsFiles
    .map((f) => ({ f, hits: [...readFileSync(f, 'utf8').matchAll(/^\s*import\s[^;]*?from\s+['"](node:[^'"]+)['"]/gm)].map((m) => m[1]) }))
    .filter((x) => x.hits.length);
  assert.deepEqual(
    offenders,
    [],
    `core/ must stay host-neutral; these import Node builtins: ${offenders.map((x) => `${x.f.split('core')[1]} (${x.hits.join(', ')})`).join('; ')}`,
  );
});
