#!/usr/bin/env node
/**
 * Emit tests/conformance.json -- the vectors an *independent* implementation has
 * to reproduce (docs/PLAN.md §9). `ref/decode.py` re-implements the readout side
 * of PSKT from scratch (its own GF(2^8) arithmetic, its own bit order, its own
 * ChaCha20) and must land on the same bytes for every vector here.
 *
 * Why a file and not just two test suites: a bug that lives in the *reader's*
 * head -- a bit order I wrote once and assumed everywhere -- cannot be caught by
 * testing my code against itself. Two authors, one answer key.
 *
 * Byte convention: every byte string in this document is lowercase hex, and a
 * "bytes" value is always the whole buffer, never a base64 blob, so the file
 * stays greppable and diffable.
 *
 *   node tools/emit-conformance.mjs [--out tests/conformance.json]
 *
 * The output is deterministic: fixed payloads, injected salts/nonces, no clock,
 * no randomness, so re-running it should not change the file unless the protocol
 * itself changed. That property is asserted by tests/conformance.test.mjs.
 */

import { writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as protocol from '../core/protocol.js';
import * as rs from '../core/rs.js';
import * as crc from '../core/crc.js';
import * as hash from '../core/hash.js';
import * as deflate from '../core/deflate.js';
import * as chacha from '../core/chacha20.js';
import * as frame from '../core/frame.js';
import * as pack from '../core/pack.js';
import * as profiles from '../core/profiles.js';
import * as layoutMod from '../core/render/layout.js';

const hex = (b) => Buffer.from(b).toString('hex').padStart(b.length * 2, '0');
const unhex = (h) => new Uint8Array(Buffer.from(h, 'hex'));
/** Repeatable byte source that is not accidentally compressible. */
function bytes(n, seed) {
  const a = new Uint8Array(n);
  let x = (seed >>> 0) || 1;
  for (let i = 0; i < n; i++) {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    a[i] = x & 255;
  }
  return a;
}

const V = [];
const add = (kind, id, o) => V.push(Object.assign({ id, kind }, o));

/* ---------------------------------------------------------------- */
/* parameters: stated, not implied                                   */
/* ---------------------------------------------------------------- */

const meta = {
  document: 'pskt-conformance',
  version: 1,
  protocolVersion: frame.VERSION,
  headerLength: frame.HEADER_LEN,
  digestLength: frame.DIGEST_LEN,
  generatedBy: 'tools/emit-conformance.mjs',
  byteEncoding: 'lowercase hex, whole buffer',
  gf256: {
    primitivePolynomial: 0x11d,
    generator: 2,
    firstConsecutiveRoot: rs.RS_FCR,
    note: 'alpha^i with alpha=2; the codeword is data||parity; position exponent for the syndromes is X_j = alpha^(n-1-j) (fcr=0, i.e. roots at alpha^0..alpha^(nsym-1) counting from the last symbol).',
    capacityRule: '2*t + e <= nsym, where t = symbol errors, e = erasures',
  },
  crc: {
    crc16: { name: 'CRC-16/CCITT-FALSE', poly: 0x1021, init: 0xffff, refin: false, refout: false, xorout: 0x0000, check: 0x29b1 },
    crc32: { name: 'CRC-32/ISO-HDLC', poly: 0x04c11db7, init: 0xffffffff, refin: true, refout: true, xorout: 0xffffffff, check: 0xcbf43926 },
  },
  hash: { sha256: 'FIPS 180-4; see also the vectors in tests/unit/hash.test.mjs' },
  compression: {
    container: 'PSZ1 header is exactly 10 bytes (HEADER_SIZE): offset 0 magic 50 53 5a 31 ("PSZ1"), offset 4 u8 method (0 = stored, 1 = raw RFC 1951 DEFLATE), offset 5 u8 reserved written as 0 (readers must ignore it), offset 6 u32 LITTLE-endian originalLength (length of the UNCOMPRESSED bytes), offset 10 payload. Little-endian here; the page frame header is big-endian.',
    rawDeflate: 'fixed Huffman (BTYPE=01, BFINAL=1), no preset dictionary, no zlib/gzip wrapper, no checksum inside the payload; bits are packed LSB-first per RFC 1951 sec 1.4 and the last byte is zero-padded to the boundary.',
    note: 'method 0 stores the payload verbatim -- do NOT inflate it. method 1 is a raw DEFLATE stream: inflate with zlib(-15). Decompressing is one-way: a Python compressor is not required to produce byte-identical DEFLATE output, only to inflate the emitted stream back to `input`.',
  },
  encryption: {
    cipher: 'ChaCha20 (RFC 8439), 32-byte key, 12-byte nonce, initial counter 1',
    kdf: 'PBKDF2-HMAC-SHA256, 150000 iterations, 32-byte output, salt = the 16 bytes at the head of the payload',
    layout: 'encrypted payload = salt(16) || nonce(12) || ciphertext',
    note: 'the JavaScript side is checked against the RFC 8439 vectors in tests/unit/chacha20.test.mjs; matching this file makes the Python side agree with the RFC transitively.',
  },
  cellPacking: {
    rule: 'a cell holds bitsPerCell bits: the primary channel occupies the most significant bits, the secondary channel the least. bits of a byte stream are taken most-significant-bit first, cell by cell, and cells that run past the end of the source are zero-padded.',
    interleave: 'after packing, cell i is moved to position (i*step) mod n; step = defaultStep(n) = the smallest prime >= n/2 that is coprime with n (falling back to the smallest coprime, then 1). The FLAGS.INTERLEAVED bit says whether a page was permuted.',
    erasure: 'a channel declared dead arrives as `missing`, and its cells are erased as whole bytes of the affected stream -- not per bit.',
    // Written because an independent implementation read the prose above and got
    // the *second* channel wrong (it re-read the primary bits), producing a page
    // whose content half matched and parity half did not. Prose that a careful
    // reader can misread is not a specification; the M8 browser receiver will be
    // written from this same text, so it gets numbers too.
    example: 'PL-D2 @ 0.4 mm: bitsPerCell=2, channels in order [colour(1 bit, top), shape(1 bit, bottom)], ECC mode unequal, D=P=220 bytes, 1764 cells. With content[0]=0xB4 (bits 1,0,1,1,0,1,0,0 MSB-first) and parity[0]=0x1D (bits 0,0,0,1,1,1,0,1), the first eight cell levels are 2,0,2,3,1,3,0,1 -- i.e. level = (contentBit << 1) | parityBit. Channel k therefore sits at shift = bitsPerCell - (sum of bits of channels 0..k) ... the primary takes the top bits and each following channel the bits immediately below, so the LAST channel of an unequal page has shift 0, not bitsPerCell - itsWidth.',
  },
  headerLayout: [
    [0, 4, 'magic "PSK1" (u32be 0x50534b31)'],
    [4, 1, 'version'],
    [5, 1, 'profile code'],
    [6, 1, 'nozzle code (mm x 10)'],
    [7, 1, 'flags'],
    [8, 8, 'session id'],
    [16, 2, 'page index (u16be)'],
    [18, 1, 'total pages (data + parity)'],
    [19, 1, 'kind: 0 data, 1 parity'],
    [20, 4, 'payload length (u32be) -- the post-transform payload (after compression and/or encryption) INCLUDING the intra-page block padding that filled out the last page: meaningful bytes = this minus blockPad, and the assembled wire region is dataPages*dataBytesPerPage. It is NOT the plaintext file size; the plaintext is identified only by the digest field.'],
    [24, 1, 'intra-page k'],
    [25, 1, 'intra-page nsym'],
    [26, 2, 'data bytes per page (u16be)'],
    [28, 2, 'data pages (u16be)'],
    [30, 2, 'block pad (u16be)'],
    [32, 22, 'truncated SHA-256 of the recovered payload'],
    [54, 2, 'CRC-16/CCITT-FALSE over the first 54 bytes'],
  ],
  // Half-open ranges, stated as data rather than as prose. The prose above once
  // said "over bytes 0..53", which the independent decoder read as a half-open
  // span and required 0..54 -- both readings are defensible, so the sentence was
  // the bug. Any consumer should read THIS field and not parse the description.
  headerCrc: { field: [54, 56], covers: [0, 54], algo: 'crc16', ranges: 'half-open: [start, end)' },
  flags: frame.FLAGS,
  profileCodes: frame.PROFILE_CODES,
  howToVerify: 'ref/decode.py reads this file, re-implements the readout, and exits non-zero on the first mismatch.',
};

/* ---------------------------------------------------------------- */
/* CRC / hash                                                        */
/* ---------------------------------------------------------------- */

const CRC_INPUTS = ['123456789', '', 'a', 'The quick brown fox jumps over the lazy dog', bytes(64, 3).fill(0)];
for (const [i, s] of CRC_INPUTS.entries()) {
  const b = typeof s === 'string' ? new TextEncoder().encode(s) : s;
  add('crc', `crc16-${i}`, { algo: 'crc16', input: hex(b), expected: crc.crc16(b) });
  add('crc', `crc32-${i}`, { algo: 'crc32', input: hex(b), expected: crc.crc32(b) });
}
add('crc', 'crc16-checkvalue', { algo: 'crc16', input: hex(new TextEncoder().encode('123456789')), expected: 0x29b1, note: 'the standard check value pins the parameters' });

const HASH_INPUTS = ['', 'abc', bytes(55, 5), bytes(56, 6), bytes(64, 7), bytes(119, 8), bytes(1000, 9)];
for (const [i, b] of HASH_INPUTS.entries()) {
  add('sha256', `sha256-${i}`, { input: hex(b), inputLength: b.length, expected: hex(hash.sha256(b)) });
}
// 55/56/119 are not arbitrary: a length field that lands in the wrong pad block
// is the most common SHA-256 implementation bug, and only these residues test it.
for (const [i, b] of HASH_INPUTS.entries()) {
  if (b.length === 55 || b.length === 119) add('sha256', `sha256-padnote-${i}`, { note: `length ${b.length} forces the two-pad-block case`, input: hex(b), expected: hex(hash.sha256(b)) });
}

/* ---------------------------------------------------------------- */
/* DEFLATE (one-way: Python inflates what we wrote)                  */
/* ---------------------------------------------------------------- */

const DEFLATE_INPUTS = [
  { id: 'stored-incompressible', data: bytes(200, 11), why: 'random input must take the stored path' },
  { id: 'deflate-repetitive', data: new TextEncoder().encode('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), why: 'long run' },
  { id: 'deflate-mixed', data: new Uint8Array(4096).map((_, i) => (i % 251) | ((i * 7) & 0xf0)), why: 'structured but not trivial' },
  { id: 'empty', data: new Uint8Array(0), why: 'zero-length must survive the container' },
];
for (const { id, data, why } of DEFLATE_INPUTS) {
  const container = deflate.compress(data);
  add('deflate', `deflate-${id}`, {
    why,
    input: hex(data),
    container: hex(container),
    method: container[4],
    rawLength: data.length,
    note: container[4] === 1
      ? 'method 1: inflate the container body (offset 10 onward) with zlib(-15) and compare against `input`'
      : 'method 0 (stored): the container body IS `input`, byte for byte -- inflating it is an error, not a test',
  });
  if (data.length) {
    const raw = deflate.deflateRaw(data);
    add('deflate-raw', `deflateraw-${id}`, { input: hex(data), stream: hex(raw) });
  }
}

/* ---------------------------------------------------------------- */
/* ChaCha20                                                          */
/* ---------------------------------------------------------------- */

for (const [i, n] of [16, 64, 65, 200].entries()) {
  const key = bytes(32, 21 + i);
  const nonce = bytes(12, 31 + i);
  const pt = bytes(n, 41 + i);
  add('chacha20', `chacha20-${i}`, {
    key: hex(key),
    nonce: hex(nonce),
    counter: 1,
    plaintext: hex(pt),
    ciphertext: hex(chacha.chacha20Xor(key, nonce, pt, 1)),
    note: n === 65 ? '65 bytes crosses a block boundary, which is where a counter bug shows up' : '',
  });
}
for (const [i, len] of [32, 100, 150].entries()) {
  const salt = bytes(16, 51 + i);
  add('pbkdf2', `pbkdf2-${i}`, {
    passphrase: 'correct horse battery staple',
    salt: hex(salt),
    iterations: 150000,
    dkLen: len,
    expected: hex(hash.pbkdf2Sha256(new TextEncoder().encode('correct horse battery staple'), salt, 150000, len)),
  });
}

/* ---------------------------------------------------------------- */
/* GF(256) Reed-Solomon                                              */
/* ---------------------------------------------------------------- */

for (const [i, [k, nsym, seed]] of [[12, 8, 61], [30, 10, 62], [64, 32, 63], [223, 32, 64]].entries()) {
  const data = bytes(k, seed);
  // rsEncode returns the systematic codeword data||parity, not the parity alone.
  const cw = rs.rsEncode(data, nsym);
  const parity = cw.subarray(k);
  add('rs-encode', `rs-encode-${i}`, { k, nsym, data: hex(data), expectedParity: hex(parity), codeword: hex(cw) });
  // erasures: a known-bad position is much cheaper to fix than an unknown one
  const erased = [0, Math.floor(k / 2), k + nsym - 1].filter((v, j, a) => a.indexOf(v) === j);
  const withHoles = cw.slice();
  for (const e of erased) withHoles[e] = (withHoles[e] ^ 0xa5) & 0xff;
  const back = rs.rsDecode(withHoles, nsym, erased);
  add('rs-erase', `rs-erase-${i}`, {
    k, nsym, codeword: hex(withHoles), erasures: erased,
    expected: hex(cw),
    ok: !!(back && back.ok && back.cw.length === cw.length && back.cw.every((v, j) => v === cw[j])),
  });
  // unknown errors, inside capacity
  const errPos = [3, 7, k - 1].filter((p) => p < cw.length);
  const damaged = cw.slice();
  for (const [j, p] of errPos.entries()) damaged[p] = (damaged[p] + 17 + j * 5) & 0xff;
  const fixed = rs.rsDecode(damaged, nsym, []);
  add('rs-error', `rs-error-${i}`, {
    k, nsym, codeword: hex(damaged), errorsAt: errPos,
    expected: fixed && fixed.ok && fixed.cw.length === cw.length && fixed.cw.every((v, j) => v === cw[j]) ? hex(cw) : null,
    expectedOutcome: 'decode must return the original codeword',
  });
  // beyond capacity: must be refused, never silently "corrected"
  const tooMany = cw.slice();
  for (let j = 0; j <= nsym; j++) tooMany[j % cw.length] = (tooMany[j % cw.length] + 1) & 0xff;
  const res = rs.rsDecode(tooMany, nsym, []);
  add('rs-fail', `rs-fail-${i}`, {
    k, nsym, codeword: hex(tooMany),
    expectedOutcome: res && res.ok ? 'decoded-but-outside-capacity' : 'fail',
    decoded: res && res.ok ? hex(res.cw) : null,
    note: `${nsym + 1} errors with nsym=${nsym} is outside 2t+e<=nsym; the decoder must not present this as data`,
  });
}

/* ---------------------------------------------------------------- */
/* interleaving                                                      */
/* ---------------------------------------------------------------- */

for (const n of [2, 7, 8, 24, 100, 255, 2401, 2273]) {
  const step = pack.defaultStep(n);
  const t = pack.interleaveTable(n, step);
  // The whole table would be tens of kilobytes of numbers for a lattice that
  // size, and it is fully determined by (n, step) -- so pin it with a checksum
  // and a head sample instead. A wrong `defaultStep` changes the sum.
  let sum = 0;
  for (const v of t.fwd) sum = (sum + v * 31) >>> 0;
  add('interleave', `interleave-${n}`, {
    n, step,
    fwdSample: Array.from(t.fwd.slice(0, 24)),
    invSample: Array.from(t.inv.slice(0, 24)),
    checksum: sum,
    rule: 'out[i] = src[fwd[i]]; fwd[i] = (i*step) mod n; inverse satisfies inv[fwd[i]] = i; step = smallest prime >= n>>1 coprime with n, else smallest coprime, else 1',
  });
}

/* ---------------------------------------------------------------- */
/* frame header                                                      */
/* ---------------------------------------------------------------- */

{
  const geom = profiles.planPage('PL-D2', { nozzle: '0.4' });
  const digest = hash.sha256(bytes(500, 71)).subarray(0, frame.DIGEST_LEN);
  for (const [i, kind] of [frame.PAGE_KIND.DATA, frame.PAGE_KIND.PARITY].entries()) {
    const f = {
      profile: 'PL-D2',
      nozzle: '0.4',
      flags: frame.FLAGS.INTERLEAVED,
      sessionId: bytes(8, 81 + i),
      pageIndex: i,
      totalPages: 4,
      kind,
      payloadLen: 500,
      intraK: geom.ecc.intra.k,
      intraNsym: geom.ecc.intra.nsym,
      dataBytesPerPage: geom.ecc.dataBytes,
      dataPages: 2,
      blockPad: geom.ecc.blockPad || 0,
      digest,
    };
    const bytes_ = frame.encodeHeader(f);
    const dec = frame.decodeHeader(bytes_);
    add('header', `header-${kind === 0 ? 'data' : 'parity'}`, {
      fields: { ...f, sessionId: hex(f.sessionId), digest: hex(digest) },
      bytes: hex(bytes_),
      roundTrips: dec.ok && dec.header.pageIndex === i,
      crcValid: true,
    });
    // a single flipped bit anywhere in the header must be caught by the CRC
    const corrupt = bytes_.slice();
    corrupt[7] ^= 0x08;
    add('header-crc', `header-crc-${i}`, { bytes: hex(corrupt), expectedOutcome: 'reject', reason: frame.decodeHeader(corrupt).reason });
  }
}

/* ---------------------------------------------------------------- */
/* page unpacking and full transfers                                 */
/* ---------------------------------------------------------------- */

const TRANSFERS = [
  { id: 'plain-PL-D2', profile: 'PL-D2', opts: { nozzle: '0.4' }, size: 4, passphrase: null },
  // The four-level, unequal-ECC packing path. A paper profile would pin the same
  // rule but costs 70k cells per page -- an A4 lattice -- which made this file
  // three-quarters lattice numbers and no more informative. PL-D3 exercises the
  // identical bit routing at 1/40th the size; paper geometry is pinned by the
  // `geometry` vectors instead.
  { id: 'unequal-PL-D3', profile: 'PL-D3', opts: { nozzle: '0.2' }, size: 3, passphrase: null },
  { id: 'encrypted-PL-M1', profile: 'PL-M1', opts: { nozzle: '0.4' }, size: 3, passphrase: 'hunter2-hunter2' },
];

for (const { id, profile, opts, size, passphrase } of TRANSFERS) {
  const geom = profiles.planPage(profile, opts);
  const payload = bytes(geom.ecc.netBytesPerPage * size, 101 + size);
  const t = await protocol.encodeTransfer(payload, { profile, ...opts, passphrase, salt: bytes(16, 111), nonce: bytes(12, 112) });
  const parity = t.pages.length - t.dataPages;
  add('transfer', `transfer-${id}`, {
    profile,
    nozzle: opts.nozzle || null,
    passphrase: passphrase || null,
    kdfIterations: 150000,
    payload: hex(payload),
    payloadSha256: hex(hash.sha256(payload)),
    dataPages: t.dataPages,
    parityPages: parity,
    totalCells: geom.totalCells,
    bitsPerCell: geom.bitsPerCell,
    channels: geom.channels.map((c) => ({ name: c.name, levels: c.levels, bits: c.bits })),
    ecc: {
      mode: geom.ecc.mode,
      intra: geom.ecc.intra,
      inter: geom.ecc.inter,
      dataBytes: geom.ecc.dataBytes,
      parityBytes: geom.ecc.parityBytes,
      netBytesPerPage: geom.ecc.netBytesPerPage,
      blockPad: geom.ecc.blockPad || 0,
      monoSafe: geom.ecc.monoSafe,
    },
    pages: t.pages.map((p) => ({ header: hex(p.header), levels: Array.from(p.levels) })),
    recipe: 'per page: de-interleave levels (if FLAGS.INTERLEAVED), unpack to codeword, intra-page RS decode, take the first dataBytesPerPage bytes of content; then inter-page RS over the data-page contents (pad each to netBytesPerPage, strip blockPad); concatenate, decrypt (salt||nonce||ct) if the flag says so, inflate, and compare the SHA-256.',
  });
  // pin one page's raw packing so a bit-order disagreement names itself
  const p0 = t.pages[0];
  // FLAGS.INTERLEAVED means the rendered order is not the codeword order: cell i
  // was moved to (i*step) mod n, so the decoder applies the inverse permutation
  // first. Feeding the on-page order straight to unpackLevels produces a page
  // full of valid-looking garbage -- which is precisely why this vector exists.
  const step = protocol.interleaveStep(geom.totalCells);
  const perm = pack.interleaveTable(geom.totalCells, step);
  const levelsRaw = pack.applyPermute(p0.levels, perm.inv);
  const unpacked = protocol.unpackLevels(levelsRaw, geom);
  const cw0 = new Uint8Array(unpacked.content.length + unpacked.parity.length);
  cw0.set(unpacked.content, 0);
  cw0.set(unpacked.parity, unpacked.content.length);
  const ik = geom.ecc.intra.k;
  const ins = geom.ecc.intra.nsym;
  add('page-unpack', `page-unpack-${id}`, {
    page: 0,
    bitsPerCell: geom.bitsPerCell,
    channels: geom.channels.map((c) => ({ name: c.name, bits: c.bits, levels: c.levels })),
    intra: { k: ik, nsym: ins, blocks: geom.ecc.intra.blocks },
    dataBytes: geom.ecc.dataBytes,
    parityBytes: geom.ecc.parityBytes,
    levelsFrom: `transfer-${id}:pages[0].levels`,
    deinterleave: { n: geom.totalCells, step, rule: 'raw[i] = printed[perm.inv[i]]; perm.inv[(i*step) mod n] = i' },
    codeword: hex(cw0),
    layout: 'codeword = content(dataBytes) || parity(parityBytes); content itself is blocks RS codewords concatenated by part, so block b takes content[b*k..(b+1)*k] and parity[b*nsym..(b+1)*nsym]',
    contentErasedCount: Array.from(unpacked.contentErased).filter(Boolean).length,
    parityErasedCount: Array.from(unpacked.parityErased).filter(Boolean).length,
    note: 'levels are in on-printed-page (interleaved) order as rendered; the decoder de-interleaves first, then reads the codeword',
  });
  const decoded = protocol.intraDecode(unpacked.content, unpacked.parity, ik, ins, unpacked.contentErased, unpacked.parityErased);
  add('page-decode', `page-decode-${id}`, {
    page: 0,
    codeword: hex(cw0),
    intra: { k: ik, nsym: ins, blocks: geom.ecc.intra.blocks },
    expectedContent: decoded && decoded.ok !== false ? hex(decoded.content) : null,
    expectedOutcome: decoded && decoded.ok ? 'recover' : 'fail',
    blocks: decoded ? decoded.blocks : null,
    okBlocks: decoded ? decoded.okBlocks : null,
    note: 'the intra-page step alone: a page codeword in, blocks*k bytes out',
  });
  // a lossy variant: withhold one page and name it, rather than re-listing every
  // other page's levels (that alone made this file three times its needed size).
  if (parity >= 1) {
    const drop = size % 2 === 0 ? t.pages.length - 1 : 0; // parity page, or data page 0
    add('transfer-loss', `transfer-loss-${id}`, {
      from: `transfer-${id}`,
      droppedPages: [drop],
      expectedPayloadSha256: hex(hash.sha256(payload)),
      note: drop === 0
        ? 'a DATA page is missing: the parity pages must carry it, and the result must still hash to the same digest'
        : 'a parity page is missing: the data pages alone are enough, so this must decode identically',
    });
  }
}

/* ---------------------------------------------------------------- */
/* geometry (what the renderer must agree with)                      */
/* ---------------------------------------------------------------- */

for (const [profile, opts, dpi] of [['PL-D2', { nozzle: '0.4' }, 300], ['PL-G', { nozzle: '0.8' }, 300], ['P-M1-600', {}, 600], ['PL-D3', { nozzle: '0.2' }, 300]]) {
  const geom = profiles.planPage(profile, opts);
  const layout = layoutMod.pageLayout(geom, dpi, { plateMm: profile.startsWith('PL-') ? 200 : undefined });
  add('geometry', `geometry-${profile}${opts.nozzle ? '-' + opts.nozzle : ''}`, {
    profile,
    nozzle: opts.nozzle || null,
    dpi,
    pitchMm: geom.pitchMm,
    sheetOrPlateMm: layout.physicalMm,
    cols: geom.cols,
    rows: geom.rows,
    totalCells: geom.totalCells,
    bitsPerCell: geom.bitsPerCell,
    channels: geom.channels.map((c) => ({ name: c.name, levels: c.levels, bits: c.bits })),
    netBytesPerPage: geom.ecc.netBytesPerPage,
    cellPx: layout.cellPx,
    latticePx: { w: layout.latticeW, h: layout.latticeH },
    quietPx: layout.quietPx,
    canvasPx: { w: layout.width, h: layout.height },
    echoPx: layout.echo ? layout.echo.px : null,
    fiducials: layout.fiducials.map((f) => ({ corner: f.corner, cx: f.cx, cy: f.cy, ringPx: f.ringPx })),
    glyph: layout.glyph ? { cellEw: layout.glyph.cellEw, outer: layout.glyph.outer, inner: layout.glyph.inner, dot: layout.glyph.dot, measure: layout.glyph.measure, rhoHi: layout.glyph.rhoHi } : null,
    note: 'pixel and millimetre integers must match exactly; the glyph block is the EW-quantised geometry the print must reproduce',
  });
}

/* ---------------------------------------------------------------- */
/* write                                                             */
/* ---------------------------------------------------------------- */

const outPath = resolve(process.argv.find((a) => a === '--out') ? process.argv[process.argv.indexOf('--out') + 1] : join(dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'conformance.json'));
const body = V.map((v) => JSON.stringify(v)).join(',\n  ');
const doc = `{\n  "meta": ${JSON.stringify(meta, null, 4).replace(/\n/g, '\n  ')},\n  "vectors": [\n  ${body}\n  ]\n}\n`;
// This file is committed and read by a person diffing a protocol change, so it
// has a budget. Refusing to write a bloated fixture is better than quietly
// committing 5 MB of lattice arrays that nobody will eyeball.
const BUDGET = 400 * 1024;
if (Buffer.byteLength(doc) > BUDGET) {
  const byKind = {};
  for (const v of V) byKind[v.kind] = (byKind[v.kind] || 0) + JSON.stringify(v).length;
  const worst = Object.entries(byKind).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k2, n]) => `${k2}=${(n / 1024).toFixed(0)}KB`);
  throw new Error(`conformance.json would be ${(Buffer.byteLength(doc) / 1024).toFixed(0)} KiB over the ${BUDGET / 1024} KiB budget; heaviest kinds: ${worst.join(' ')}`);
}
writeFileSync(outPath, doc);
console.log(`wrote ${outPath}: ${V.length} vectors, ${(doc.length / 1024).toFixed(0)} KiB`);
const kinds = {};
for (const v of V) kinds[v.kind] = (kinds[v.kind] || 0) + 1;
console.log('  ' + Object.entries(kinds).map(([k, n]) => `${k}=${n}`).join('  '));
