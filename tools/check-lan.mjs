#!/usr/bin/env node
/**
 * Prove the LAN-serving half of the phone path, without a browser.
 *
 * docs/USE.md tells a user to run `python -m http.server 8000 --directory web/dist` and open
 * index.html on a phone. That instruction was prose until this file existed. What a browser
 * would do on that origin is knowable and reproducible here:
 *
 *   - sw.js carries a precache manifest (48 entries as built; the number is read from the file,
 *     not assumed), each a url plus the SHA-256 of the bytes
 *     that were on disk at build time. Its install handler calls cache.add(new Request(url)) for
 *     every entry, so one 404 fails the whole install. This fetches every entry and compares the
 *     served bytes against the manifest hash with our own core/hash.js -- the same value the
 *     browser would put in the cache. tools/check-dist.mjs already checks manifest-against-disk;
 *     this checks manifest-against-what-the-server-actually-hands-out, which is the half that can
 *     only be wrong in production.
 *   - the air-gap contract says no external URLs. So every served HTML is scanned for an absolute
 *     http(s) reference in a src/href attribute or in fetch()/import(). XML namespace strings
 *     (http://schemas.microsoft.com/...) are not references to anything fetchable and are exempt,
 *     and the exemption is narrow: only inside xmlns-ish attribute values.
 *   - the thin pages only work over http because browsers refuse ES modules from file://, so their
 *     module graph has to resolve on this origin too.
 *
 * What this cannot prove, and says so: service worker registration, the install prompt, camera
 * permission, and the CSP as a browser enforces it. Those need a real browser (gate G9, DEFECTS
 * D18). It also reports the PWA install blockers it can see -- a LAN http origin is not a secure
 * context, and the manifest's only icon is a full-page render rather than 192/512 -- without
 * letting them affect the exit code, because they are not what this tool claims to check.
 *
 *   node tools/check-lan.mjs --port 8123 [--host 127.0.0.1]
 *
 * Start the server yourself first; node cannot spawn it here (piped stdio is denied in-process):
 *   python -m http.server 8123 --directory web/dist
 */
import { sha256Hex } from '../core/hash.js';

const args = process.argv.slice(2);
const opt = (name, dflt) => (args.includes(name) ? args[args.indexOf(name) + 1] : dflt);
const PORT = Number(opt('--port', '8123'));
const HOST = opt('--host', '127.0.0.1');
const BASE = `http://${HOST}:${PORT}`;

let failures = 0;
const pass = (label, detail) => console.log(` PASS  ${label}\n          ${detail}`);
const fail = (label, detail) => {
  failures++;
  console.log(` FAIL  ${label}\n          ${detail}`);
};
const note = (label, detail) => console.log(` note  ${label}\n          ${detail}`);

/** Fetch a path and return { status, bytes, text, type }. Never throws: a refusal is a result. */
async function get(path) {
  try {
    const r = await fetch(BASE + path, { redirect: 'manual' });
    const buf = new Uint8Array(await r.arrayBuffer());
    return { status: r.status, ok: r.ok, bytes: buf, text: new TextDecoder('utf-8').decode(buf), type: r.headers.get('content-type') || '' };
  } catch (e) {
    return { status: 0, ok: false, bytes: new Uint8Array(0), text: '', type: '', error: String(e && e.message ? e.message : e) };
  }
}

console.log('');
console.log(`check-lan: ${BASE}  (web/dist over http, the origin a phone on the same LAN would use)`);
console.log('');

// 0. Is there anything there at all? A tool that reports 47 failures because nobody started the
//    server is noise, so name that case once and stop.
const probe = await get('/index.html');
if (probe.status === 0) {
  console.log(` FAIL  nothing is listening on ${BASE}: ${probe.error}`);
  console.log('          start it first:  python -m http.server ' + PORT + ' --directory web/dist');
  process.exit(1);
}
if (!probe.ok) {
  console.log(` FAIL  ${BASE}/index.html returned ${probe.status}, not 200`);
  process.exit(1);
}

// 1. The precache manifest, entry by entry, byte for byte.
const sw = await get('/sw.js');
if (!sw.ok) {
  fail('sw.js is served', `status ${sw.status}`);
  process.exit(1);
}
const m = /const MANIFEST = (\{[\s\S]*?\});\s*\n/.exec(sw.text);
if (!m) {
  fail('sw.js carries a precache manifest', 'no `const MANIFEST = {...}` literal found -- the served file is not the built one');
  process.exit(1);
}
let manifest;
try {
  manifest = JSON.parse(m[1]);
} catch (e) {
  fail('the precache manifest is JSON', String(e.message || e));
  process.exit(1);
}
const buildId = /const BUILD_ID = "([0-9a-f]+)"/.exec(sw.text);
if (!buildId || buildId[1] !== manifest.buildId) {
  fail('sw.js BUILD_ID matches the manifest buildId', `${buildId ? buildId[1] : 'none'} vs ${manifest.buildId}`);
} else {
  pass('sw.js BUILD_ID matches its manifest', buildId[1]);
}

let missing = 0;
let mismatched = 0;
const badNames = [];
for (const e of manifest.entries) {
  if (!e.url.startsWith('./')) {
    badNames.push(`${e.url} (not a relative url, so it would not resolve against the SW scope)`);
    continue;
  }
  const path = '/' + e.url.slice(2);
  const r = await get(path);
  if (!r.ok) {
    missing++;
    badNames.push(`${path} -> ${r.status}${r.error ? ' ' + r.error : ''}`);
    continue;
  }
  const got = sha256Hex(r.bytes);
  if (got !== e.sha256) {
    mismatched++;
    badNames.push(`${path} served bytes whose sha256 is ${got.slice(0, 16)}..., manifest says ${e.sha256.slice(0, 16)}...`);
  }
}
if (missing || mismatched) {
  fail(
    `every precached asset is served byte-identical (${manifest.entries.length} entries)`,
    `${missing} not served, ${mismatched} hash mismatch -- a browser install would fail on the first one:\n          ` + badNames.slice(0, 8).join('\n          '),
  );
} else {
  pass(
    `every precached asset is served byte-identical`,
    `${manifest.entries.length} entries, each fetched over http and hashed with core/hash.js: sha256 matches the build manifest, so cache.add() would have nothing to fail on`,
  );
}

// 2. Air gap: no absolute http(s) reference that a browser would actually go and fetch.
const PAGES = ['/index.html', '/send.html', '/pskt-file.html', '/pskt-send-file.html'];
const external = [];
const csp = [];
for (const p of PAGES) {
  const r = await get(p);
  if (!r.ok) {
    external.push(`${p} -> ${r.status}`);
    continue;
  }
  // src=/href= pointing at an absolute http(s) url, and fetch()/import() with an http(s) literal.
  const attrRe = /(?:src|href)\s*=\s*(["'])\s*(https?:\/\/[^"' ]+)\1/gi;
  const callRe = /(?:fetch|import)\s*\(\s*(["'`])(https?:\/\/[^"'`]+)\1/gi;
  for (const re of [attrRe, callRe]) {
    let hit;
    while ((hit = re.exec(r.text))) {
      // Namespace declarations are identifiers, not requests. Anything else is a real dependency.
      const around = r.text.slice(Math.max(0, hit.index - 40), hit.index);
      if (/xmlns(:[A-Za-z0-9_.-]+)?\s*=\s*["']?$/i.test(around) || /rel\s*=\s*["']?[a-z-]*namespace/i.test(around)) continue;
      external.push(`${p}: ${hit[2]}`);
    }
  }
  const c = /<meta[^>]+http-equiv\s*=\s*["']?Content-Security-Policy["']?[^>]*>/i.exec(r.text);
  csp.push(`${p}: ${c ? 'CSP meta present' : 'NO CSP meta tag'}`);
}
if (external.length) {
  fail('no served page references an external URL (air-gap contract)', external.slice(0, 10).join('\n          '));
} else {
  pass('no served page references an external URL', `${PAGES.length} pages scanned for absolute http(s) in src=/href= and in fetch()/import(); xmlns namespace strings exempted and nothing else found`);
}
note('Content-Security-Policy as served', csp.join('\n          ') + '\n          python -m http.server sends no CSP header, so any policy here comes from a meta tag; a browser enforcing it is gate G9 / D18, not this tool');

// 3. The thin pages' module graph has to resolve on this origin -- that is the whole reason they
//    need http at all (browsers refuse ES modules from file://).
const thin = [
  ['/index.html', ['./app.js', './capture.js', './manifest.webmanifest']],
  ['/send.html', ['./sender.js']],
];
const unresolved = [];
for (const [page, wants] of thin) {
  const r = await get(page);
  for (const w of wants) {
    const name = w.replace('./', '');
    if (!r.text.includes(name)) unresolved.push(`${page} does not reference ${w} at all`);
    const a = await get('/' + name);
    if (!a.ok) unresolved.push(`${page} -> ${w} returned ${a.status}`);
  }
}
if (unresolved.length) {
  fail('the thin pages and everything they load resolve over http', unresolved.join('\n          '));
} else {
  pass('the thin pages and everything they load resolve over http', 'index.html -> app.js, capture.js, manifest.webmanifest; send.html -> sender.js; each referenced by the page and served 200');
}

// 4. The web app manifest, and the install blockers this tool can see but does not own.
const man = await get('/manifest.webmanifest');
if (!man.ok) {
  fail('manifest.webmanifest is served', `status ${man.status}`);
} else {
  let parsed = null;
  try {
    parsed = JSON.parse(man.text);
  } catch (e) {
    fail('manifest.webmanifest is valid JSON', String(e.message || e));
  }
  if (parsed) {
    const start = await get('/' + String(parsed.start_url || '').replace(/^\.\//, ''));
    if (!start.ok) fail('the manifest start_url resolves', `${parsed.start_url} -> ${start.status}`);
    else pass('manifest.webmanifest parses and its start_url resolves', `${parsed.name} · start_url ${parsed.start_url} · display ${parsed.display} · scope ${parsed.scope}`);
    const sizes = (parsed.icons || []).map((i) => `${i.src} ${i.sizes}`);
    const installable = (parsed.icons || []).some((i) => /(^|\s)(192x192|512x512)(\s|$)/.test(String(i.sizes)));
    console.log('');
    console.log(' PWA install blockers this tool can see (they do not affect the exit code, and neither is fixed):');
    console.log('   1. a LAN http origin is not a secure context, so a browser refuses registration and install;');
    console.log('      https hosting is needed and .github/workflows/pages.yml does not exist yet');
    console.log(`   2. icon sizes offered: ${sizes.join(', ') || 'none'} -- installability wants 192x192 and 512x512${installable ? '' : ', and neither is present'}`);
    console.log('   Both are recorded in docs/DEFECTS.md; reporting them here is not the same as passing them.');
  }
}

console.log('');
if (failures) {
  console.log(`CHECK-LAN: ${failures} FAILED`);
  console.log('           Not proven either way: SW registration, the install prompt, camera permission,');
  console.log('           and CSP as a browser enforces it -- those need a real browser (G9 / D18).');
  process.exit(1);
}
console.log('CHECK-LAN: everything above passed');
console.log('           A phone on this LAN would get every asset the service worker precaches, byte for');
console.log('           byte, from a local origin with no external URL in it. Registration, install and');
console.log('           camera still need a real browser and https (G9 / D18 / the icon blocker above).');
process.exit(0);
