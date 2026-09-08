#!/usr/bin/env node
/**
 * Serve web/dist to this machine and to every phone on the same LAN, and print the exact URL to
 * open. Node builtins only: zero dependencies, and no Python needed for the phone path.
 *
 * Why this exists: docs/USE.md told the user to run `python -m http.server` and then to substitute
 * their own LAN address, which asks them to know two things they usually do not -- that Python is
 * installed, and which of their machine's addresses the phone can reach. Both are answered here.
 *
 * What it does not do, stated rather than hidden: a LAN http origin is not a secure context, so a
 * browser will not register the service worker or offer to install the PWA from this server
 * (DEFECTS D43; only https hosting changes that, and that needs the user's repository and
 * credentials). Everything else on the phone path -- open the page, point the camera at printed
 * pages, decode, download the file -- works over plain http on the LAN.
 *
 * Usage:
 *   node tools/serve.mjs                    # port 8000, web/dist, all interfaces
 *   node tools/serve.mjs --port 8123        # a specific port
 *   node tools/serve.mjs --dir web/dist     # a specific directory (default shown)
 *   node tools/serve.mjs --host 127.0.0.1   # this machine only (no LAN exposure)
 *
 * Exit codes: 0 after a clean Ctrl+C, 1 if it cannot serve (missing build, port in use, bad args).
 */
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(HERE, '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.3mf': 'application/vnd.ms-package.threedmanufacturing',
  '.stl': 'model/stl',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
};

function parseArgs(argv) {
  const out = { port: 8000, portExplicit: false, dir: join(ROOT, 'web', 'dist'), host: '0.0.0.0' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--port') {
      out.port = Number(next());
      out.portExplicit = true;
    } else if (a === '--dir') out.dir = resolve(ROOT, next());
    else if (a === '--host') out.host = next();
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`unknown argument ${a} (try --help)`);
  }
  if (!Number.isInteger(out.port) || out.port < 1 || out.port > 65535) throw new Error(`--port must be an integer in 1..65535, got ${out.port}`);
  return out;
}

/**
 * What to tell the user when a port will not bind. Exported so the wording is testable, because the
 * wording is the fix: the obvious advice ("something is on that port") is only half true on Windows
 * and sends people to look in the wrong place. This tool met port 8131 held by an *outbound*
 * connection -- netstat showed it solely as ESTABLISHED to a remote :443, a LISTENING filter found
 * nothing, and Get-NetTCPConnection -LocalPort 8131 returned nothing at all -- while bind still
 * failed with EADDRINUSE. Both causes are named, and so is the command that actually shows them.
 */
export function busyMessage(port, explicit, nextPort) {
  const head = `       port ${port} will not bind. On Windows that has two causes, and only one of them shows up in "netstat -ano | findstr LISTENING":`;
  const causes = [
    '         (a) something is listening on it;',
    '         (b) an outbound connection is transiently holding it as its own local port -- invisible to a LISTENING',
    '             filter and often to Get-NetTCPConnection too, while bind still fails with EADDRINUSE.',
  ];
  const look = `       to see which: netstat -ano | findstr :${port}   (every state, not just LISTENING)`;
  if (!explicit && nextPort) {
    return [head, ...causes, `       --port was not given explicitly, so this moves itself: trying ${nextPort}.`, look].join('\n');
  }
  return [head, ...causes, '       you asked for this port explicitly, so it is not being moved behind your back: free it, or pick another with --port.', look].join('\n');
}

/** LAN IPv4 addresses worth printing, i.e. the ones a phone on the same network can reach. */
function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push({ name, address: ni.address });
    }
  }
  return out;
}

const USAGE = `node tools/serve.mjs [--port 8000] [--dir web/dist] [--host 0.0.0.0]

Serves the built client so a phone on the same LAN can open it. Ctrl+C stops it.
--host 127.0.0.1 keeps it on this machine only.`;

export function main(argv = process.argv.slice(2)) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    console.error(`serve: ${e.message}`);
    console.error(USAGE);
    return 1;
  }
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }

  const dir = opts.dir;
  const index = join(dir, 'index.html');
  if (!existsSync(index)) {
    // Actionable, not decorative: a bare 404 here would send the user hunting through source.
    console.error(`serve: ${index} does not exist.`);
    console.error('       web/dist is a build product and is not in git, so build it first:');
    console.error('         node tools/build-web.mjs');
    console.error('       (docs/USE.md section 0)');
    return 1;
  }

  const server = createServer((req, res) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('400 bad request URL\n');
      return;
    }
    if (pathname.endsWith('/')) pathname += 'index.html';
    const full = resolve(dir, `.${pathname}`);
    // Refuse anything that escapes the served directory. A static server that answers ../ is a
    // reader for the whole disk, and this one is bound to every interface by default.
    if (full !== dir && !full.startsWith(dir + sep)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('403 outside the served directory\n');
      return;
    }
    let st = null;
    try {
      st = statSync(full);
    } catch {
      st = null;
    }
    if (!st || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`404 no such file: ${pathname}\n`);
      return;
    }
    const type = MIME[extname(full).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': String(st.size),
      // no-store, so a rebuild is visible on the next request instead of after a cache expiry:
      // this server exists to hand a phone the current build, not to be a CDN.
      'Cache-Control': 'no-store',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const stream = createReadStream(full);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  });

  // Walk up to the next free port when the caller did not choose one: a recipe that says "open
  // http://<ip>:8000" must not fail because some browser happens to be using 8000 as an outbound
  // local port at that moment. An explicitly requested port is never moved silently.
  const MAX_WALK = 20;
  let port = opts.port;
  const start = () => {
    server.once('error', (e) => {
      if (e.code === 'EADDRINUSE' && !opts.portExplicit && port - opts.port < MAX_WALK) {
        console.log(busyMessage(port, false, port + 1));
        port += 1;
        start();
        return;
      }
      console.error(`serve: cannot listen on ${opts.host}:${port} -- ${e.message}`);
      console.error(busyMessage(port, true, null));
      process.exitCode = 1;
    });
    server.listen(port, opts.host, () => {
      // A runtime socket error is not a bind failure; do not report it as one.
      server.removeAllListeners('error');
      server.on('error', (e2) => console.error(`serve: ${e2.message}`));
      const lan = lanAddresses();
      console.log(`serving ${dir}`);
      console.log(`  this machine : http://127.0.0.1:${port}/index.html`);
      if (lan.length) {
        console.log('  phone on the same LAN, open one of:');
        for (const a of lan) console.log(`    http://${a.address}:${port}/index.html   (${a.name})`);
    } else {
      console.log('  no non-loopback IPv4 address found: the phone will not be able to reach this server.');
    }
    console.log('');
    console.log('  single-file pages that also work without this server (file://):');
    console.log('    web/dist/pskt-send-file.html  (sender)   web/dist/pskt-file.html  (receiver)');
    console.log('');
    console.log('  Not available over plain http: service-worker registration and PWA install,');
    console.log('  because a LAN http origin is not a secure context (DEFECTS D43). Everything else');
    console.log('  on the phone path works: open the page, shoot the printed pages, decode, download.');
    console.log('');
    console.log('  Ctrl+C stops it.');
    });
  };
  start();

  const stop = () => {
    server.close(() => {
      console.log('\nserve: stopped');
      process.exit(0);
    });
    // close() waits for live connections; do not hang forever on a phone mid-download.
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  return 0;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const code = main();
  if (code !== 0) process.exitCode = code;
}
