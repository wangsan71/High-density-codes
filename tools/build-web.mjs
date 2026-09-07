#!/usr/bin/env node
/**
 * Build the PSKT web receiver into web/dist (and one self-contained file:// page).
 *
 * Two artifacts, two different failure modes, so both are generated and both are checked:
 *
 *   dist/                     the Pages site: index.html + app.js + the *closure* of core
 *                             modules it actually imports (not the whole tree -- shipping
 *                             mesh/pdf code to a browser that cannot use it would be
 *                             dead weight and a larger attack surface), plus sw.js with a
 *                             precache manifest whose hashes are computed here from the
 *                             bytes about to be served.
 *
 *   dist/pskt-file.html       one file, no imports, no service worker, opens from file://
 *                             because PLAN requires "选照片→解码" to work without a server.
 *                             It exists because browsers refuse ES module imports over
 *                             file:// (CORS), and a blob:-URL module loader would be
 *                             blocked by this site's own CSP (script-src 'self').
 *
 * The bundler is deliberately small and *refuses loudly*: dynamic import(), default
 * exports, `export {x as y}`, `import.meta` and namespace imports all throw instead of
 * being silently mangled. A bundler that quietly produces plausible broken output is the
 * worst possible tool in a repository whose one unforgivable failure is looking successful
 * while being wrong.
 *
 *   node tools/build-web.mjs            build into web/dist
 *   node tools/build-web.mjs --print    report only, do not write
 */
import { readFileSync, writeFileSync, rmSync, mkdirSync, existsSync, statSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'web', 'dist');
// There is no hand-written file list: dist's contents are derived from the import closure
// plus the entries below, so a new module cannot be forgotten in a list and then 404 in
// production while the build still looks green.
const ASSETS = [['tests/conformance.json', 'conformance.json']];
const PRINT_ONLY = process.argv.includes('--print');

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const read = (id) => readFileSync(join(ROOT, id.split('/').join(sep())), 'utf8');
const sep = () => (process.platform === 'win32' ? '\\' : '/');

/**
 * Resolve an import request to a module id (repo-root-relative, posix separators).
 * `web/core/...` maps to `core/...`: the app imports './core/x.js' so that it works from
 * dist/app.js next to dist/core/, and this is the rule that keeps the same string valid
 * when the source sits in web/.
 */
function resolveId(fromId, request) {
  if (!request.startsWith('./') && !request.startsWith('../')) {
    throw new Error(`${fromId}: bare specifier "${request}" -- the web bundle allows no packages`);
  }
  let p = posix.join(posix.dirname(fromId), request);
  if (p.startsWith('web/core/')) p = p.slice('web/'.length);
  if (!p.startsWith('core/') && !p.startsWith('web/')) throw new Error(`${fromId}: "${request}" resolves outside core/ and web/ (${p})`);
  if (!existsSync(join(ROOT, p.split('/').join(sep())))) throw new Error(`${fromId}: "${request}" -> ${p} does not exist on disk`);
  return p;
}

/** Static-import/export subset this bundler understands. Anything else is a hard error. */
function transform(id, src) {
  const code = stripComments(src);
  if (/\bimport\s*\(/.test(code)) throw new Error(`${id}: dynamic import() is not supported by the web bundler (make it a static import)`);
  if (/\bimport\.meta\b/.test(code)) throw new Error(`${id}: import.meta is not supported by the web bundler`);
  if (/^\s*export\s+default/m.test(code)) throw new Error(`${id}: export default is not supported`);
  if (/^\s*import\s+[A-Za-z_$][\w$]*\s*,/m.test(code) || /^\s*import\s+[A-Za-z_$][\w$]*\s+from/m.test(code)) {
    throw new Error(`${id}: default imports are not supported`);
  }
  if (/^\s*import\s+\*\s+as/m.test(code)) throw new Error(`${id}: namespace imports are not supported`);
  const exported = new Set();
  let body = src;

  body = body.replace(/^\s*import\s*\{([^}]+)\}\s*from\s*(['"])([^'"]+)\2\s*;?\s*$/gm, (_m, names, _q, request) => {
    const target = resolveId(id, request);
    const parts = String(names)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        // `import { exp as gfExp } from '../gf256.js'` is real code in this repo (rs.js),
        // so renames have to be carried across, not refused: `const { exp: gfExp } = ...`.
        // Anything shaped otherwise still throws -- a silent drop here would compile a
        // module whose bindings quietly do not exist.
        const m = /^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/.exec(s);
        if (!m) throw new Error(`${id}: cannot parse import binding "${s}"`);
        return m[2] ? `${m[1]}: ${m[2]}` : m[1];
      });
    return `const { ${parts.join(', ')} } = __R(${JSON.stringify(target)});`;
  });

  body = body.replace(/^\s*import\s*(['"])([^'"]+)\1\s*;?\s*$/gm, (_m, _q, request) => `__R(${JSON.stringify(resolveId(id, request))}); // side-effect import`);

  body = body.replace(/^\s*export\s+(async\s+function|function|const|let|class)\s+([A-Za-z_$][\w$]*)/gm, (_m, kind, name) => {
    exported.add(name);
    return `${kind} ${name}`;
  });

  body = body.replace(/^\s*export\s*\{([^}]*)\}\s*;?/gm, (_m, names) => {
    for (const raw of String(names).split(',')) {
      const s = raw.trim();
      if (!s) continue;
      if (s.includes(' as ')) throw new Error(`${id}: export rename "${s}" is not supported`);
      if (!/^[A-Za-z_$][\w$]*$/.test(s)) throw new Error(`${id}: unparseable export "${s}"`);
      exported.add(s);
    }
    return '';
  });

  if (/^\s*import\s/m.test(stripComments(body))) {
    throw new Error(`${id}: an import form was left unhandled:\n${body.match(/^\s*import\s.*$/m)[0]}`);
  }
  return { body, exported: [...exported] };
}

/**
 * Remove comments so a scanner cannot read prose as code. This is not cosmetic: the first
 * version of this tool scanned raw source, so (a) a doc-comment phrase like "decodes from
 * 'an image'" was taken for an import specifier, and (b) a comment explaining why a
 * dynamic import had been removed tripped the guard that forbids dynamic imports -- the
 * tool failed on its own documentation. Rewriting still happens on the original text
 * (import statements begin at a line start, which comment bodies do not), but every
 * *decision* is made on this.
 * The `[^:\\]` guard before `//` keeps `https://...` inside a string from looking like
 * the start of a comment.
 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}

/**
 * The ONE definition of "what this file imports", shared by the closure walk and the
 * rewriter. It was not shared the first time, and the loose scan picked up the phrase
 * `from 'an image'` inside a doc comment and demanded a module by that name. Comment
 * prose is not a specifier: anchor to a statement start and nothing else.
 */
function importSpecs(id, src) {
  const code = stripComments(src);
  const out = [];
  const named = /^\s*import\s*\{([^}]*)\}\s*from\s*(['"])([^'"]+)\2/gm;
  const bare = /^\s*import\s+(?:[\w$]+\s*,\s*)?\{[^}]*\}\s*from\s*(['"])([^'"]+)\1/gm;
  const side = /^\s*import\s*(['"])([^'"]+)\1/gm;
  for (const m of code.matchAll(named)) out.push(m[3]);
  for (const m of code.matchAll(bare)) out.push(m[2]);
  for (const m of code.matchAll(side)) out.push(m[2]);
  for (const m of code.matchAll(/^\s*export\s*\{[^}]*\}\s*from\s*(['"])([^'"]+)\1/gm)) {
    throw new Error(`${id}: re-export ("${m[2]}") is not supported by the web bundler`);
  }
  if (/^\s*import\s+[^;{]*from/gm.test(code) && !out.length) {
    throw new Error(`${id}: an import statement exists that the bundler's scanner does not recognise`);
  }
  return [...new Set(out)];
}

function closure(entry) {
  const order = [];
  const seen = new Set();
  const stack = [[entry, null]];
  while (stack.length) {
    const [id, parent] = stack.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    const src = read(id);
    const deps = [];
    for (const req of importSpecs(id, src)) deps.push(resolveId(id, req));
    for (const d of deps) if (!seen.has(d)) stack.push([d, id]);
    order.push({ id, src, deps });
  }
  // Modules must be defined before the app body resolves them at run time; define order
  // is not load order here (__R is lazy), so only the entry needs to be last for clarity.
  order.sort((a, b) => (a.id === entry ? 1 : b.id === entry ? -1 : a.id < b.id ? -1 : 1));
  return order;
}

function bundle(entry) {
  const mods = closure(entry);
  const chunks = [];
  for (const { id, src } of mods) {
    const { body, exported } = transform(id, src);
    chunks.push(`__D(${JSON.stringify(id)}, (__R) => {\n${body.trimEnd()}\nreturn { ${exported.join(', ')} };\n});`);
  }
  const ids = mods.map((m) => m.id);
  return [
    '(function () {',
    '  var __DEF = {}, __REG = {};',
    '  function __D(id, fn) { __DEF[id] = fn; }',
    '  function __R(id) {',
    '    if (Object.prototype.hasOwnProperty.call(__REG, id)) return __REG[id];',
    '    if (!__DEF[id]) throw new Error("web bundle: module not included: " + id);',
    '    var fn = __DEF[id];',
    '    delete __DEF[id];',
    '    var mod = fn(__R) || {};',
    '    __REG[id] = mod;',
    '    return mod;',
    '  }',
    '  var IDS = ' + JSON.stringify(ids) + ';',
    chunks.join('\n\n'),
    '  globalThis.__PSKT__ = { R: __R, modules: IDS };',
    '  if (typeof document !== "undefined" && typeof document.getElementById === "function" && document.getElementById("files")) {',
    '    __R("web/app.js");',
    '  }',
    '})();',
    '',
  ].join('\n');
}

const appBundle = bundle('web/app.js');
// selftest.js is kept as a normal module for the Pages site (?selftest=1 imports it) and
// is NOT bundled: it uses dynamic import() on purpose so a browser can load the
// conformance asset lazily, and the bundler refuses those. That refusal is the point --
// it means the bundler cannot be talked into a half-baked answer here.
// selftest.js lives in the source tree and imports '../core/...', which is right for
// Node (that is how tools/check-dist.mjs executes it) and wrong for dist, where the file
// sits beside dist/core/. Rewrite that one specifier form only -- a path-depth fix, not a
// change of meaning.
const selftestSrc = read('web/selftest.js').replace(/(['"])\.\.\/core\//g, '$1./core/');

const distFiles = [];
const writeDist = (rel, content) => {
  const p = join(OUT, rel.split('/').join(sep()));
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
  distFiles.push({ url: './' + rel, bytes: Buffer.byteLength(content), sha256: sha256(Buffer.from(content)) });
};

if (PRINT_ONLY) {
  console.log(`closure of web/app.js: ${JSON.parse(appBundle.match(/var IDS = (\[[^\]]*\])/)[1]).length} modules`);
  for (const id of JSON.parse(appBundle.match(/var IDS = (\[[^\]]*\])/)[1])) console.log(`  ${id}`);
  console.log(`bundle: ${(Buffer.byteLength(appBundle) / 1024).toFixed(1)} KiB (unminified)`);
  process.exit(0);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// Ship every core module, not only a computed closure. selftest.js reaches some modules
// through dynamic import() on purpose, and a closure walk cannot see those: the first dist
// build produced a selftest.js whose `core/render/png.js` existed in the source tree and
// not in dist -- green in source, broken in the artifact. A few tens of KiB is a cheap
// price for removing that whole class of failure; the closure walk still runs, because its
// job (refusing unsupported import forms) is a correctness check, not a size optimisation.
const needIds = new Set(JSON.parse(appBundle.match(/var IDS = (\[[^\]]*\])/)[1]));
for (const m of closure('web/selftest.js')) needIds.add(m.id);
for (const m of closure('web/sender.js')) needIds.add(m.id);
const allCore = [];
(function walkCore(d) {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) walkCore(p);
    else if (f.endsWith('.js')) allCore.push(p.split(sep()).join('/').replace(ROOT.split(sep()).join('/') + '/', ''));
  }
})(join(ROOT, 'core'));
for (const id of [...needIds, ...allCore].sort()) {
  // A dist-relative url: web/app.js is served as ./app.js, not ./web/app.js. Getting this
  // wrong produced a site whose index.html pointed at a file that did not exist, which no
  // earlier check could see -- nothing in the build compared markup to disk.
  if (id === 'web/selftest.js') continue; // written below, with its specifier rewrite
  if (id === 'web/sender.js') continue; // likewise
  writeDist(id.replace(/^web\//, ''), read(id));
}
writeDist('pskt-bundle.js', appBundle);
writeDist('selftest.js', selftestSrc);
writeDist('selftest-page.js', read('web/selftest-page.js'));
for (const [src, rel] of ASSETS) writeDist(rel, read(src));

// The single-file page: same markup, styles inlined, and the bundle inlined instead of the
// module script. Nothing external is left, which tools/check-dist.mjs asserts by grepping.
const html = read('web/index.html');
const css = read('web/app.css');
let single = html
  .replace('<link rel="stylesheet" href="./app.css">', `<style>\n${css}\n</style>`)
  .replace('<script type="module" src="./app.js"></script>', `<script>\n${appBundle}\n</script>`)
  .replace(/\n?\s*<!-- PSKT-SELFTEST-LOADER[\s\S]*?<\/script>/, '')
  // A manifest link would make the single file non-self-contained (and the checker, which
  // requires every markup reference to resolve, would rightly fail on file:// where no
  // sibling files exist). Installability belongs to the served site, not to one file.
  .replace(/\s*<link rel="manifest"[^>]*>/, '')
  .replace(/<meta name="description"[^>]*>/, '<meta name="description" content="Single-file PSKT receiver. Works from file:// with no network access.">');
// What makes the single-file page "self-contained" is its MARKUP: no src=, no href=, no
// url() pointing anywhere else. A check that scanned the whole text would trip over the
// bundled JS (which legitimately contains strings like './hash.js' inside module bodies)
// -- that is what happened first, and "fixing" it by deleting the strings would have been
// the wrong kind of green.
const externalRefs = [...single.matchAll(/(?:src|href)\s*=\s*(["'])\s*(?!#)([^"']+)\1/gi)]
  .map((m) => m[2].trim())
  .filter((v) => !v.startsWith('data:'));
if (externalRefs.length) throw new Error(`single-file build is not self-contained: ${externalRefs.join(', ')}`);
// Scope the CSS check to the style block. An unanchored `url(` test matched
// `URL.createObjectURL(...)` in the inlined bundle -- the third time this round that one
// of my guards fired on ordinary text because it was not anchored to where the thing it
// forbids can actually appear.
const styleBlocks = single.match(/<style>[\s\S]*?<\/style>/gi) || [];
for (const s of styleBlocks) {
  if (/@import|url\(\s*['"]?(?!data:)/i.test(s)) throw new Error('inline CSS references an external url/@import');
}
writeDist('pskt-file.html', single);

// Precache manifest for the service worker: computed from the bytes just written, so the
// hashes cannot describe a different build than the one being served.
// Markup-referenced files are written BEFORE the manifest is computed. index.html and
// app.css used to be written after it, so they were absent from the precache list while
// the build still reported success -- the artifact was quietly unwired for offline use.
writeDist('index.html', read('web/index.html'));
writeDist('app.css', read('web/app.css'));
// The sender page too: until now the build copied the receiver only, so a green G9 check
// said nothing at all about whether the phone-facing page ships.
writeDist('send.html', read('web/send.html'));
// Same path-depth rewrite as selftest.js: source uses ../core/ (so Node can import the
// file and tools/smoke-sender.mjs can execute it), dist uses ./core/ (so the module
// resolves next to dist/core/).
writeDist('sender.js', read('web/sender.js').replace(/(['"])\.\.\/core\//g, '$1./core/'));

/* PWA installability, drawn by this project's own renderer.
 * The icon is a real PSKT page bitmap encoded with core/render/png.js: no image library, no
 * new dependency (package.json stays {} as the contract requires), and the build cannot
 * claim an icon that the repo's own encoder cannot produce.
 * These come from core/ directly rather than out of the bundle, because the bundle is the
 * receiver's closure and a receiver never encodes a PNG -- the first version asked
 * globalThis.__PSKT__ for core/render/png.js and the bundler correctly answered "not
 * included", which is the same mistake (assuming a module is there because I wanted it)
 * this repository keeps making.
 * Must happen before the precache manifest is computed, or these files would ship
 * unprecached and offline install would quietly miss them. */
{
  const { encodeTransfer } = await import('../core/protocol.js');
  const { pageLayout } = await import('../core/render/layout.js');
  const { renderPageBitmap, echoBitsOf } = await import('../core/render/raster.js');
  const { encodePNG } = await import('../core/render/png.js');
  const seed = new Uint8Array(64).fill(0x5a);
  const it = await encodeTransfer(seed, { profile: 'P-M1-300' });
  const ilayout = pageLayout(it.geom, 300, { sheetMm: it.geom.sheetMm });
  const ibmp = renderPageBitmap({ geom: it.geom, levels: it.pages[0].levels, layout: ilayout, palette: 'PAPER1', echoBits: echoBitsOf(it.pages[0].header) });
  const ipng = Buffer.from(encodePNG(ibmp));
  writeFileSync(join(OUT, 'icon-page.png'), ipng);
  distFiles.push({ url: './icon-page.png', bytes: ipng.length, sha256: sha256(ipng) });
  const iconSizes = ibmp.width && ibmp.height ? `${ibmp.width}x${ibmp.height}` : 'any';
  const webmanifest = {
    name: 'PSKT 打印—扫描传输',
    short_name: 'PSKT',
    description: '把文件印成自描述码页，再用摄像头或扫描件还原：无 URL、无外部资源。',
    start_url: './index.html',
    scope: './',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#101317',
    icons: [{ src: './icon-page.png', sizes: iconSizes, type: 'image/png', purpose: 'any' }],
  };
  const mw = Buffer.from(JSON.stringify(webmanifest, null, 1) + '\n');
  writeFileSync(join(OUT, 'manifest.webmanifest'), mw);
  distFiles.push({ url: './manifest.webmanifest', bytes: mw.length, sha256: sha256(mw) });
  console.log(`  pwa: icon ${ipng.length} B (${iconSizes}), manifest ${mw.length} B`);
}

const forSw = distFiles.filter((f) => !f.url.endsWith('sw.js'));
const buildId = sha256(forSw.map((f) => `${f.url} ${f.sha256}\n`).join('')).slice(0, 16);
const swPatched = read('web/sw.js')
  .replace("'__PSKT_BUILD_ID__'", JSON.stringify(buildId))
  .replace('__PSKT_PRECACHE_MANIFEST__', JSON.stringify({ buildId, entries: forSw.map((f) => ({ url: f.url, sha256: f.sha256 })) }));
if (swPatched.includes('__PSKT_')) throw new Error('sw placeholders were not all replaced');
writeDist('sw.js', swPatched);

const manifestJson = { buildId, generatedBy: 'tools/build-web.mjs', entries: distFiles.map((f) => ({ ...f, url: f.url })) };
writeFileSync(join(OUT, 'build-manifest.json'), JSON.stringify(manifestJson, null, 1) + '\n');

console.log(`web/dist: ${distFiles.length + 1} files, build ${buildId}`);
console.log(`  bundle ${(Buffer.byteLength(appBundle) / 1024).toFixed(1)} KiB / ${JSON.parse(appBundle.match(/var IDS = (\[[^\]]*\])/)[1]).length} modules`);
console.log(`  single-file pskt-file.html ${(statSync(join(OUT, 'pskt-file.html')).size / 1024).toFixed(1)} KiB`);
console.log(`  precache entries ${forSw.length}`);
