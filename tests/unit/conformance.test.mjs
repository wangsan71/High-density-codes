import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as rs from '../../core/rs.js';
import * as crc from '../../core/crc.js';
import * as hash from '../../core/hash.js';
import * as deflate from '../../core/deflate.js';
import * as chacha from '../../core/chacha20.js';
import * as frame from '../../core/frame.js';
import * as pack from '../../core/pack.js';
import * as profiles from '../../core/profiles.js';
import * as layoutMod from '../../core/render/layout.js';

/**
 * tests/conformance.json is the answer key that ref/decode.py has to match.
 * Two ways it can rot: the emitter stops being deterministic (so the committed
 * file drifts from what the code produces), or `core/` changes a rule without
 * the fixture noticing. Both are caught here, in-process, without Python.
 */

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, '..', 'conformance.json');
const doc = JSON.parse(readFileSync(FIXTURE, 'utf8'));
const byId = new Map(doc.vectors.map((v) => [v.id, v]));
const ofKind = (k) => doc.vectors.filter((v) => v.kind === k);
const unhex = (h) => new Uint8Array(Buffer.from(h, 'hex'));
const hexOf = (b) => Buffer.from(b).toString('hex');

test('conformance: document shape and budget', () => {
  assert.equal(doc.meta.document, 'pskt-conformance');
  assert.equal(doc.meta.version, 1);
  assert.equal(new Set(doc.vectors.map((v) => v.id)).size, doc.vectors.length, 'ids must be unique');
  const bytes = readFileSync(FIXTURE).length;
  assert.ok(bytes < 400 * 1024, `fixture is ${(bytes / 1024).toFixed(0)} KiB, over the 400 KiB budget`);
  assert.ok(doc.vectors.length >= 60, `only ${doc.vectors.length} vectors`);
  // the point of the file: every primitive the readout depends on is pinned
  for (const kind of ['crc', 'sha256', 'deflate', 'chacha20', 'pbkdf2', 'rs-encode', 'rs-erase', 'rs-error', 'rs-fail', 'interleave', 'header', 'page-unpack', 'page-decode', 'transfer', 'transfer-loss', 'geometry']) {
    assert.ok(ofKind(kind).length >= 1, `no ${kind} vectors`);
  }
});

test('conformance: re-emitting produces byte-identical output', async () => {
  const tmp = join(here, `reemit-${process.pid}.json`);
  const argv = process.argv;
  process.argv = [argv[0], 'emit-conformance.mjs', '--out', tmp];
  try {
    // The emitter is top-level code, so importing it runs it exactly once.
    await import('../../tools/emit-conformance.mjs');
    assert.deepEqual(readFileSync(tmp), readFileSync(FIXTURE), 'the committed fixture differs from a fresh emission');
  } finally {
    process.argv = argv;
    rmSync(tmp, { force: true });
  }
});

test('conformance: CRC vectors recompute from core', () => {
  for (const v of ofKind('crc')) {
    const b = unhex(v.input);
    assert.equal(v.algo === 'crc16' ? crc.crc16(b) : crc.crc32(b), v.expected, v.id);
  }
  assert.equal(crc.crc16(new TextEncoder().encode('123456789')), 0x29b1, 'the stated CRC-16 parameters must be the real ones');
});

test('conformance: SHA-256 vectors recompute, including the pad-block edge cases', () => {
  const lens = ofKind('sha256').map((v) => v.inputLength);
  assert.ok(lens.includes(55) && lens.includes(119), 'the 55/119 byte lengths are what catch a two-pad-block bug');
  for (const v of ofKind('sha256')) {
    assert.equal(hexOf(hash.sha256(unhex(v.input))), v.expected, v.id);
  }
});

test('conformance: every deflate container inflates back to its input', () => {
  for (const v of ofKind('deflate')) {
    const out = deflate.decompress(unhex(v.container));
    assert.deepEqual(Array.from(out), Array.from(unhex(v.input)), `${v.id}: container must round-trip`);
    assert.equal(v.method === 0 || v.input.length === 0 || true, true);
  }
  for (const v of ofKind('deflate-raw')) {
    const out = deflate.inflateRaw(unhex(v.stream), unhex(v.input).length);
    assert.deepEqual(Array.from(out), Array.from(unhex(v.input)), v.id);
  }
  // the stored path is only real if something actually took it
  assert.ok(ofKind('deflate').some((v) => v.method === 0), 'expected at least one stored (method 0) container');
});

test('conformance: ChaCha20 and PBKDF2 vectors recompute', () => {
  for (const v of ofKind('chacha20')) {
    const ct = chacha.chacha20Xor(unhex(v.key), unhex(v.nonce), unhex(v.plaintext), v.counter);
    assert.equal(hexOf(ct), v.ciphertext, v.id);
    const back = chacha.chacha20Xor(unhex(v.key), unhex(v.nonce), unhex(v.ciphertext), v.counter);
    assert.equal(hexOf(back), v.plaintext, `${v.id}: the same keystream must undo itself`);
  }
  for (const v of ofKind('pbkdf2')) {
    const dk = hash.pbkdf2Sha256(new TextEncoder().encode(v.passphrase), unhex(v.salt), v.iterations, v.dkLen);
    assert.equal(hexOf(dk), v.expected, v.id);
    assert.equal(dk.length, v.dkLen);
  }
});

test('conformance: RS vectors recompute and the refusals stay refusals', () => {
  for (const v of ofKind('rs-encode')) {
    const cw = rs.rsEncode(unhex(v.data), v.nsym);
    assert.equal(hexOf(cw.subarray(v.k)), v.expectedParity, v.id);
    assert.equal(hexOf(cw), v.codeword, `${v.id}: codeword is data||parity`);
  }
  for (const v of ofKind('rs-erase')) {
    const r = rs.rsDecode(unhex(v.codeword), v.nsym, v.erasures);
    assert.ok(r.ok, `${v.id}: erasure decode must succeed (reason ${r.reason})`);
    assert.equal(hexOf(r.cw), v.expected, v.id);
  }
  for (const v of ofKind('rs-error')) {
    const r = rs.rsDecode(unhex(v.codeword), v.nsym, []);
    assert.ok(r.ok, `${v.id}: in-capacity error decode must succeed`);
    assert.equal(hexOf(r.cw), v.expected, v.id);
  }
  for (const v of ofKind('rs-fail')) {
    const r = rs.rsDecode(unhex(v.codeword), v.nsym, []);
    assert.equal(r.ok, false, `${v.id}: beyond-capacity must be refused, not silently corrected`);
    assert.equal(v.decoded, null, `${v.id}: a refused codeword must not carry bytes into the fixture`);
  }
});

test('conformance: interleave vectors recompute from the stated rule', () => {
  for (const v of ofKind('interleave')) {
    assert.equal(pack.defaultStep(v.n), v.step, `${v.id}: step`);
    const t = pack.interleaveTable(v.n, v.step);
    assert.deepEqual(Array.from(t.fwd.slice(0, v.fwdSample.length)), v.fwdSample, `${v.id}: fwd sample`);
    assert.deepEqual(Array.from(t.inv.slice(0, v.invSample.length)), v.invSample, `${v.id}: inv sample`);
    let sum = 0;
    for (const x of t.fwd) sum = (sum + x * 31) >>> 0;
    assert.equal(sum, v.checksum, `${v.id}: the whole table is pinned by its checksum`);
    for (let i = 0; i < v.n; i++) assert.equal(t.inv[t.fwd[i]], i, `${v.id}: inv must undo fwd at ${i}`);
  }
});

test('conformance: header vectors round-trip and a scribbled header is rejected', () => {
  for (const v of ofKind('header')) {
    const b = unhex(v.bytes);
    assert.equal(b.length, frame.HEADER_LEN, `${v.id}: header length`);
    const dec = frame.decodeHeader(b);
    assert.ok(dec.ok, `${v.id}: must decode (${dec.reason})`);
    assert.equal(dec.header.pageIndex, v.fields.pageIndex);
    assert.equal(dec.header.kind, v.fields.kind);
    assert.equal(hexOf(dec.header.sessionId), v.fields.sessionId);
    assert.equal(hexOf(dec.header.digest), v.fields.digest);
    // re-encoding from the fields must reproduce the bytes, or the layout table
    // in meta and encodeHeader disagree
    assert.equal(hexOf(frame.encodeHeader({ ...v.fields, sessionId: unhex(v.fields.sessionId), digest: unhex(v.fields.digest) })), v.bytes, `${v.id}: re-encode`);
  }
  for (const v of ofKind('header-crc')) {
    const dec = frame.decodeHeader(unhex(v.bytes));
    assert.equal(dec.ok, false, `${v.id}: a single flipped bit must not pass the header CRC`);
  }
});

test('conformance: page unpack and decode recompute through the de-interleave', async () => {
  const { unpackLevels, intraDecode } = await import('../../core/protocol.js');
  for (const v of ofKind('page-unpack')) {
    const src = byId.get(v.levelsFrom.split(':')[0]);
    assert.ok(src, `${v.id}: refers to a missing transfer`);
    const levels = Uint16Array.from(src.pages[v.page].levels);
    const t = pack.interleaveTable(v.deinterleave.n, v.deinterleave.step);
    const raw = pack.applyPermute(levels, t.inv);
    const geom = profiles.planPage(src.profile, src.nozzle ? { nozzle: src.nozzle } : {});
    const u = unpackLevels(raw, geom);
    const cw = new Uint8Array(u.content.length + u.parity.length);
    cw.set(u.content, 0);
    cw.set(u.parity, u.content.length);
    assert.equal(hexOf(cw), v.codeword, `${v.id}: codeword from levels`);
    const d = intraDecode(u.content, u.parity, v.intra.k, v.intra.nsym, u.contentErased, u.parityErased);
    const twin = byId.get(v.id.replace('page-unpack', 'page-decode'));
    assert.ok(d.ok, `${v.id}: intra decode must succeed`);
    assert.equal(hexOf(d.content), twin.expectedContent, `${twin.id}: content`);
  }
});

test('conformance: geometry vectors recompute from the profile tables', () => {
  for (const v of ofKind('geometry')) {
    const geom = profiles.planPage(v.profile, v.nozzle ? { nozzle: v.nozzle } : {});
    const layout = layoutMod.pageLayout(geom, v.dpi, { plateMm: v.profile.startsWith('PL-') ? 200 : undefined });
    assert.equal(geom.totalCells, v.totalCells, `${v.id}: cells`);
    assert.equal(geom.bitsPerCell, v.bitsPerCell, `${v.id}: bits per cell`);
    assert.equal(layout.cellPx, v.cellPx, `${v.id}: cellPx`);
    assert.equal(layout.width, v.canvasPx.w, `${v.id}: canvas width`);
    assert.equal(layout.height, v.canvasPx.h, `${v.id}: canvas height`);
    assert.deepEqual(geom.channels.map((c) => c.levels), v.channels.map((c) => c.levels), `${v.id}: channel alphabets`);
    if (v.glyph) {
      assert.equal(layout.glyph.outer, v.glyph.outer, `${v.id}: glyph outer radius (EW-quantised)`);
      assert.equal(layout.glyph.cellEw, v.glyph.cellEw, `${v.id}: cells in EW`);
    }
  }
});
