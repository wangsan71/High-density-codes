#!/usr/bin/env node
/**
 * Verify a running static server for the phone path: the bytes it hands out are the bytes on disk,
 * a directory traversal is refused, and the responses carry the headers a browser needs.
 *
 * Written because tools/serve.mjs binds every interface by default -- which is the point, since a
 * phone has to reach it -- and a static server that answers `../` is a reader for the whole disk.
 * "It serves the page" is not enough; the interesting failures are the ones where it serves
 * something else, or serves the right path with the wrong bytes.
 *
 * This does NOT prove: service-worker registration or PWA install (a LAN http origin is not a
 * secure context -- DEFECTS D43), and it does not prove a real phone camera decodes a real printed
 * page (D18 / G9). Those need https and hardware respectively.
 *
 * Usage:
 *   node tools/check-serve.mjs --port 8131 [--host 127.0.0.1] [--dir web/dist]
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Hex } from '../core/hash.js';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

function args(argv) {
  const o = { port: 8000, host: '127.0.0.1', dir: join(ROOT, 'web', 'dist') };
  for (let i = 0; i < argv.length; i++) {
    // Capture the flag before advancing: `const v = argv[++i]` first and then comparing argv[i]
    // compares against the value, so every flag fell through to "unknown argument" and this tool
    // could not be run at all. Found by running it, not by reading it.
    const a = argv[i];
    const v = argv[++i];
    if (v === undefined) throw new Error(`${a} needs a value`);
    if (a === '--port') o.port = Number(v);
    else if (a === '--host') o.host = v;
    else if (a === '--dir') o.dir = resolve(ROOT, v);
    else throw new Error(`unknown argument ${a}`);
  }
  if (!Number.isInteger(o.port) || o.port < 1 || o.port > 65535) throw new Error(`--port must be an integer in 1..65535, got ${o.port}`);
  return o;
}

const opt = args(process.argv.slice(2));
const base = `http://${opt.host}:${opt.port}`;
const results = [];
const record = (ok, label, detail) => {
  results.push({ ok, label, detail });
  console.log(` ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (detail) console.log(`          ${detail}`);
};

async function get(path, method = 'GET') {
  try {
    const res = await fetch(base + path, { method, redirect: 'manual' });
    const buf = Buffer.from(await res.arrayBuffer());
    return { status: res.status, type: res.headers.get('content-type') || '', cache: res.headers.get('cache-control') || '', len: Number(res.headers.get('content-length') || -1), bytes: buf, text: buf.toString('utf8') };
  } catch (e) {
    return { status: 0, type: '', cache: '', len: -1, bytes: Buffer.alloc(0), text: '', error: e.message };
  }
}

const disk = (rel) => {
  const p = join(opt.dir, rel);
  return existsSync(p) ? readFileSync(p) : null;
};

// 1. The page a phone opens, byte for byte against what is on disk.
const idx = await get('/index.html');
const idxDisk = disk('index.html');
record(
  idx.status === 200 && idxDisk && sha256Hex(new Uint8Array(idx.bytes)) === sha256Hex(new Uint8Array(idxDisk)),
  '/index.html is served byte-identical to the file on disk',
  idx.error
    ? `request failed: ${idx.error}`
    : `${idx.status}, ${idx.bytes.length} B, sha256 ${idxDisk ? sha256Hex(new Uint8Array(idx.bytes)).slice(0, 16) : '-'} vs disk ${idxDisk ? sha256Hex(new Uint8Array(idxDisk)).slice(0, 16) : 'missing'}`,
);

// 2. The bare path must land on the same document, or the printed URL is a 404.
const root = await get('/');
record(root.status === 200 && root.bytes.length === idx.bytes.length, 'GET / serves the same document as /index.html', `${root.status}, ${root.bytes.length} B`);

// 3. Directory traversal: the status matters less than the body. A 200 with package.json in it is
//    the failure, and a server that answers 403 while leaking the file would also be a failure.
const SECRET = '"dependencies"'; // package.json's own content, one directory above web/dist
for (const p of ['/../package.json', '/..%2fpackage.json', '/sub/../../package.json', '/%2e%2e/package.json']) {
  const r = await get(p);
  const leaked = r.text.includes(SECRET);
  record(!leaked && r.status !== 200, `traversal refused: ${p}`, `${r.status}${leaked ? ' -- THE FILE WAS SERVED' : ''}`);
}

// 4. A missing file is a 404, not a redirect to the index (which would make a typo look like a working page).
const miss = await get('/definitely-not-here.html');
record(miss.status === 404, 'a missing file is a 404', `${miss.status}`);

// 5. HEAD must work: browsers and proxies use it, and a server that 500s on HEAD is not a static server.
const head = await get('/index.html', 'HEAD');
record(head.status === 200 && head.bytes.length === 0 && head.len === idx.bytes.length, 'HEAD /index.html reports the length with an empty body', `${head.status}, content-length ${head.len}, body ${head.bytes.length} B`);

// 6. Headers a browser acts on: the manifest's type decides whether it is parsed as a manifest, and
//    no-store decides whether a rebuild is visible without a cache expiry.
const man = await get('/manifest.webmanifest');
record(man.status === 200 && /application\/manifest\+json/.test(man.type), 'manifest.webmanifest is served as application/manifest+json', `${man.status}, ${man.type}`);
record(/no-store/.test(idx.cache), 'responses are no-store, so a rebuild shows up on the next request', `cache-control: ${idx.cache || '(none)'}`);

const bad = results.filter((r) => !r.ok);
console.log('');
if (bad.length) {
  console.log(`CHECK-SERVE: ${bad.length} of ${results.length} FAILED`);
  process.exitCode = 1;
} else {
  console.log(`CHECK-SERVE: all ${results.length} checks pass against ${base} (dir ${opt.dir})`);
  console.log('           Not proven here: service-worker registration and PWA install (needs https, D43),');
  console.log('           and a real phone camera decoding a real printed page (D18 / G9).');
}
