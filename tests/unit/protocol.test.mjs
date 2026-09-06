import test from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeHeader,
  decodeHeader,
  encodeEcho,
  decodeEcho,
  describeFlags,
  HEADER_LEN,
  FLAGS,
  PAGE_KIND,
} from '../../core/frame.js';
import {
  PROFILES,
  PROFILE_IDS,
  planPage,
  planTransfer,
  densityReport,
} from '../../core/profiles.js';
import { NOZZLES } from '../../core/nozzles.js';
import {
  encodeTransfer,
  TransferAssembler,
  packLevels,
  unpackLevels,
  intraEncode,
  intraDecode,
  roundtrip,
} from '../../core/protocol.js';
import { sha256 } from '../../core/hash.js';

function rng(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}
const rndBytes = (n, seed = 1) => {
  const r = rng(seed);
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (r() * 256) | 0;
  return b;
};
const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const feedAll = async (asm, pages, order = null, pick = null) => {
  const idx = order || pages.map((_, i) => i);
  const out = [];
  for (const i of idx) {
    if (pick && !pick(pages[i], i)) continue;
    out.push(await asm.feed(pages[i]));
  }
  return out;
};
const mkPage = (p, extra = {}) => ({ levels: p.levels, header: p.header, ...extra });

/* ------------------------------------------------------------------ */
/* frame                                                               */
/* ------------------------------------------------------------------ */

const sampleHeaderFields = () => ({
  profile: 'PL-D2',
  nozzle: '0.4',
  flags: FLAGS.COMPRESSED | FLAGS.MONO_RECOVERABLE | FLAGS.INTERLEAVED,
  sessionId: sha256('session').subarray(0, 8),
  pageIndex: 7,
  totalPages: 21,
  kind: PAGE_KIND.PARITY,
  payloadLen: 123456,
  intraK: 122,
  intraNsym: 122,
  dataBytesPerPage: 1342,
  dataPages: 17,
  blockPad: 40,
  digest: sha256('payload').subarray(0, 22),
});

test('frame: header round-trips every field', () => {
  const f = sampleHeaderFields();
  const bytes = encodeHeader(f);
  assert.equal(bytes.length, HEADER_LEN);
  const r = decodeHeader(bytes);
  assert.equal(r.ok, true, r.reason);
  const h = r.header;
  assert.equal(h.profile, 'PL-D2');
  assert.equal(h.nozzle, '0.4');
  assert.equal(h.pageIndex, 7);
  assert.equal(h.totalPages, 21);
  assert.equal(h.kind, PAGE_KIND.PARITY);
  assert.equal(h.payloadLen, 123456);
  assert.equal(h.intraK, 122);
  assert.equal(h.intraNsym, 122);
  assert.equal(h.dataBytesPerPage, 1342);
  assert.equal(h.dataPages, 17);
  assert.equal(h.blockPad, 40);
  assert.deepEqual(Array.from(h.digest), Array.from(f.digest));
  assert.deepEqual(Array.from(h.sessionId), Array.from(f.sessionId));
  assert.equal(describeFlags(h.flags), 'compressed+monoRecoverable+interleaved');
});

test('frame: any single bit flip is rejected (never half-read)', () => {
  const bytes = encodeHeader(sampleHeaderFields());
  let accepted = 0;
  for (let bit = 0; bit < bytes.length * 8; bit++) {
    const t = Uint8Array.from(bytes);
    t[bit >> 3] ^= 1 << (7 - (bit & 7));
    const r = decodeHeader(t);
    if (r.ok) accepted++;
  }
  assert.equal(accepted, 0, 'a corrupted frame header must never decode as valid');
});

test('frame: rejects foreign magic, wrong version, truncation', () => {
  const bytes = encodeHeader(sampleHeaderFields());
  assert.equal(decodeHeader(bytes.subarray(0, 20)).reason, 'short-header');
  const m = Uint8Array.from(bytes);
  m[0] ^= 0xff;
  assert.equal(decodeHeader(m).reason, 'bad-magic');
  const v = Uint8Array.from(bytes);
  v[4] = 99;
  assert.equal(decodeHeader(v).reason, 'version-99');
  const p = Uint8Array.from(bytes);
  p[5] = 250;
  p.set(encodeHeader(sampleHeaderFields()).subarray(54), 54); // keep crc stale on purpose
  assert.ok(!decodeHeader(p).ok);
});

test('frame: margin echo self-identifies a page from a raw bit band', () => {
  const bytes = encodeHeader(sampleHeaderFields());
  const echo = encodeEcho(bytes, 3);
  assert.equal(echo.length, HEADER_LEN * 8 * 3);
  const h = decodeEcho(echo);
  assert.ok(h, 'echo must decode');
  assert.equal(h.pageIndex, 7);
  assert.equal(h.totalPages, 21);
  // a band that is mostly noise still must not produce a bogus identity
  assert.equal(decodeEcho(new Uint8Array(HEADER_LEN * 8).fill(1)), null);
});

/* ------------------------------------------------------------------ */
/* profiles / geometry                                                 */
/* ------------------------------------------------------------------ */

test('profiles: geometry invariants hold for every profile x nozzle', () => {
  for (const id of PROFILE_IDS) {
    const p = PROFILES[id];
    const nozzles = p.medium === 'plate' ? Object.keys(NOZZLES) : [null];
    for (const nozzle of nozzles) {
      const g = planPage(id, { nozzle: nozzle || undefined, plateMm: 200 });
      assert.ok(g.cols > 4 && g.rows > 4, `${id}/${nozzle}: lattice too small`);
      assert.ok(g.totalCells * g.bitsPerCell >= 8 * (g.ecc.dataBytes + g.ecc.parityBytes), `${id}/${nozzle}: over-committed`);
      assert.ok(g.ecc.dataBytes > 0, `${id}/${nozzle}: no capacity`);
      assert.ok(g.ecc.intra.k + g.ecc.intra.nsym <= 255, `${id}/${nozzle}: RS block over 255`);
      assert.ok(g.ecc.intra.nsym >= 2, `${id}/${nozzle}: parity too thin`);
      assert.ok(g.wastedBits === undefined || g.wastedBits >= 0);
      if (nozzle) {
        const ew = NOZZLES[nozzle].ewMm;
        const ratio = g.pitchMm / ew;
        assert.ok(Math.abs(ratio - Math.round(ratio)) < 0.02, `${id}/${nozzle}: pitch ${g.pitchMm} is not whole EW (${ratio})`);
      }
    }
  }
});

test('profiles: coarser nozzles cost capacity, and 1.8mm at 0.4 matches the budget', () => {
  const fine = planPage('PL-D2', { nozzle: '0.2' }).ecc.netBytesPerPage;
  const mid = planPage('PL-D2', { nozzle: '0.4' }).ecc.netBytesPerPage;
  const coarse = planPage('PL-D2', { nozzle: '0.8' }).ecc.netBytesPerPage;
  assert.ok(fine > mid && mid > coarse, `${fine} > ${mid} > ${coarse}`);
  // 1.8mm pitch on a 200mm plate: 94x94 cells after the 5-cell quiet zone is paid for
  assert.ok(mid > 1000, `PL-D2@0.4 should carry ~1.1KB, got ${mid}`);
});

test('profiles: dual colour is both denser and mono-safe compared with single colour', () => {
  const mono = planPage('PL-M1', { nozzle: '0.4' });
  const dual = planPage('PL-D2', { nozzle: '0.4' });
  assert.equal(dual.ecc.monoRecoverable, true);
  assert.equal(mono.ecc.monoRecoverable, false);
  assert.ok(
    dual.ecc.netBytesPerPage > mono.ecc.netBytesPerPage,
    `PL-D2 (${dual.ecc.netBytesPerPage}) must beat PL-M1 (${mono.ecc.netBytesPerPage})`,
  );
});

test('profiles: monoSafe dial trades capacity against colour-loss tolerance', async () => {
  const full = planPage('PL-D2', { nozzle: '0.2', monoSafe: 'full' });
  const off = planPage('PL-D3', { nozzle: '0.2' });
  assert.ok(off.ecc.netBytesPerPage > full.ecc.netBytesPerPage, 'no protection must be denser');
  // a mono print of the *protected* profile survives; the unprotected one is asked to re-print
  const payload = rndBytes(500, 5);
  const tFull = await encodeTransfer(payload, { profile: 'PL-D2', nozzle: '0.2', monoSafe: 'full' });
  const asmFull = new TransferAssembler();
  for (const p of tFull.pages) await asmFull.feed(mkPage(p, { channelMissing: ['colour'] }));
  assert.ok(eq(asmFull.result || new Uint8Array(), payload), 'full protection must recover from mono print');

  const tOff = await encodeTransfer(payload, { profile: 'PL-D3', nozzle: '0.2' });
  const asmOff = new TransferAssembler();
  for (const p of tOff.pages) await asmOff.feed(mkPage(p, { channelMissing: ['colour'] }));
  assert.equal(asmOff.result, null, 'unprotected profile must refuse, not guess');
});

test('profiles: page planning matches the ECC budget and refuses over-255 jobs', () => {
  const per = planPage('P-M1-600').ecc.netBytesPerPage;
  const t = planTransfer('P-M1-600', {}, per * 3 + 1);
  assert.equal(t.dataPages, 4);
  assert.ok(t.parityPages >= 2);
  assert.equal(t.totalPages, t.dataPages + t.parityPages);
  assert.throws(() => planTransfer('PL-D2', { nozzle: '0.8' }, 1024 * 1024), /255|capacity/);
});

test('profiles: density report covers every id without throwing', () => {
  const rows = densityReport();
  assert.equal(rows.length, PROFILE_IDS.length * 4 - (PROFILE_IDS.filter((i) => PROFILES[i].medium === 'paper').length * 3));
  for (const r of rows) assert.ok(!r.error, `${r.profile}/${r.nozzle}: ${r.error}`);
});

/* ------------------------------------------------------------------ */
/* level packing                                                       */
/* ------------------------------------------------------------------ */

test('pack: levels round-trip in both ECC modes and erasure flags map back', () => {
  for (const [id, opts] of [
    ['PL-D2', { nozzle: '0.2' }],
    ['PL-M1', { nozzle: '0.2' }],
    ['P-M1-300', {}],
  ]) {
    const g = planPage(id, opts);
    const D = g.ecc.dataBytes;
    const P = g.ecc.parityBytes;
    const content = rndBytes(D, 42);
    const parity = rndBytes(P, 43);
    const levels = packLevels({ content, parity, geom: g });
    assert.equal(levels.length, g.totalCells);
    const back = unpackLevels(levels, g);
    assert.ok(eq(back.content, content), `${id}: content`);
    assert.ok(eq(back.parity, parity), `${id}: parity`);
    assert.equal(back.contentErased.reduce((a, b) => a + b, 0), 0);

    const missing = new Uint8Array(g.totalCells);
    for (let i = 0; i < g.totalCells; i += 97) missing[i] = 1;
    const b2 = unpackLevels(levels, g, missing);
    const erasedCount = b2.contentErased.reduce((a, b) => a + b, 0);
    assert.ok(erasedCount > 0 && erasedCount < D, `${id}: expected partial erasure, got ${erasedCount}/${D}`);
    // erased positions must be a subset of the cells we flagged
    const clean = unpackLevels(levels, g);
    for (let i = 0; i < D; i++) if (!b2.contentErased[i]) assert.equal(b2.content[i], clean.content[i], `${id}: unerased byte ${i} changed`);
  }
});

/* ------------------------------------------------------------------ */
/* intra-page ECC                                                      */
/* ------------------------------------------------------------------ */

test('intra ECC: encodes/decodes blocks and survives a whole-channel erasure', () => {
  const g = planPage('PL-D2', { nozzle: '0.2' });
  const { k, nsym, blocks } = g.ecc.intra;
  const content = rndBytes(k * blocks, 9);
  const parity = intraEncode(content, k, nsym);
  assert.equal(parity.length, nsym * blocks);
  const clean = intraDecode(content, parity, k, nsym, null, null);
  assert.equal(clean.ok, true);
  assert.ok(eq(clean.content, content));

  // entire colour channel gone: every content byte is an erasure
  const zeros = new Uint8Array(content.length);
  const allErased = new Uint8Array(content.length).fill(1);
  const r = intraDecode(zeros, parity, k, nsym, allErased, null);
  assert.equal(r.ok, true, `full-colour-loss decode must succeed (nsym=${nsym} per block)`);
  assert.ok(eq(r.content, content));
});

/* ------------------------------------------------------------------ */
/* end-to-end transfer (ideal, no channel)                             */
/* ------------------------------------------------------------------ */

const PROFILES_TO_TEST = [
  ['PL-D2', { nozzle: '0.2' }],
  ['PL-D2', { nozzle: '0.4' }],
  ['PL-M1', { nozzle: '0.2' }],
  ['PL-D3', { nozzle: '0.2' }],
  ['PL-G', { nozzle: '0.4' }],
  ['P-M1-300', {}],
  ['P-M1-600', {}],
  ['P-M2-600', {}],
  ['P-C4-600', {}],
];

for (const [pid, opts] of PROFILES_TO_TEST) {
  test(`transfer: ${pid}${opts.nozzle ? '@' + opts.nozzle : ''} ideal round-trip at boundary sizes`, async () => {
    const per = planPage(pid, opts).ecc.netBytesPerPage;
    for (const size of [0, 1, 2, Math.floor(per / 2), per - 1, per, per + 1, per * 2 + 5]) {
      const payload = rndBytes(size, 1000 + size);
      const t = await encodeTransfer(payload, { profile: pid, ...opts });
      assert.ok(t.pages.length >= 3, `${pid}: need at least data+parity pages`);
      const asm = new TransferAssembler();
      await feedAll(asm, t.pages);
      assert.ok(asm.result, `${pid} size=${size}: no result (${asm.error || ''})`);
      assert.equal(asm.result.length, size, `${pid} size=${size} length`);
      assert.ok(eq(asm.result, payload), `${pid} size=${size} bytes differ`);
    }
  });
}

test('transfer: 100 KB through the paper profile, byte identical', async () => {
  const payload = rndBytes(100 * 1024, 77);
  const t = await encodeTransfer(payload, { profile: 'P-M1-600' });
  assert.ok(t.pages.length >= 4 && t.pages.length <= 10, `unexpected page count ${t.pages.length}`);
  const asm = new TransferAssembler();
  await feedAll(asm, t.pages);
  assert.ok(eq(asm.result, payload));
});

test('transfer: compressible payload takes the deflate path and still matches', async () => {
  const text = new TextEncoder().encode('pskit print scan plate nozzle parity '.repeat(2000));
  const per = planPage('P-M1-600').ecc.netBytesPerPage;
  const t = await encodeTransfer(text, { profile: 'P-M1-600' });
  assert.ok(t.flags & FLAGS.COMPRESSED, 'expected the compressed flag');
  assert.ok(
    t.dataPages < Math.ceil(text.length / per),
    `compression must reduce data pages: ${t.dataPages} vs ${Math.ceil(text.length / per)}`,
  );
  const asm = new TransferAssembler();
  await feedAll(asm, t.pages);
  assert.ok(eq(asm.result, text));
});

test('transfer: missing pages up to the parity budget are rebuilt', async () => {
  const payload = rndBytes(9000, 31);
  const t = await encodeTransfer(payload, { profile: 'P-M1-300' });
  const drop = (dropN, seed) => {
    const r = rng(seed);
    const idx = t.pages.map((_, i) => i);
    for (let i = idx.length - 1; i > 0; i--) {
      const j = (r() * (i + 1)) | 0;
      [idx[i], idx[j]] = [idx[j], idx[i]];
    }
    const gone = new Set(idx.slice(0, dropN));
    return t.pages.filter((_, i) => !gone.has(i));
  };
  for (let d = 1; d <= t.parityPages; d++) {
    const asm = new TransferAssembler();
    await feedAll(asm, drop(d, 400 + d));
    assert.ok(eq(asm.result || new Uint8Array(), payload), `dropping ${d} pages must still recover`);
  }
  // one page beyond the budget: must refuse cleanly, never emit wrong bytes
  const asm2 = new TransferAssembler();
  await feedAll(asm2, drop(t.parityPages + 1, 400));
  assert.equal(asm2.result, null, 'over-budget loss must be refused, not guessed');
});

test('transfer: order does not matter and duplicates are ignored', async () => {
  const payload = rndBytes(5000, 55);
  const t = await encodeTransfer(payload, { profile: 'P-M1-300' });
  const r = rng(1234);
  const order = t.pages.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = (r() * (i + 1)) | 0;
    [order[i], order[j]] = [order[j], order[i]];
  }
  const asm = new TransferAssembler();
  await feedAll(asm, t.pages, order);
  assert.ok(eq(asm.result, payload));
  const before = asm.duplicates;
  await feedAll(asm, t.pages, order.slice(0, 2));
  assert.ok(asm.duplicates > before, 'rescanned pages must be counted as duplicates');
  assert.ok(eq(asm.result, payload), 'result stable after duplicates');
});

test('transfer: pages from two sessions never mix', async () => {
  const a = await encodeTransfer(rndBytes(4000, 61), { profile: 'P-M1-300' });
  const b = await encodeTransfer(rndBytes(4000, 62), { profile: 'P-M1-300' });
  assert.notEqual(Buffer.from(a.sessionId).toString('hex'), Buffer.from(b.sessionId).toString('hex'));
  const asm = new TransferAssembler();
  await asm.feed(mkPage(a.pages[0])); // open the session without completing it
  let rejected = 0;
  for (const p of b.pages) {
    const res = await asm.feed(mkPage(p));
    if (!res.ok && res.reason === 'other-session') rejected++;
  }
  assert.equal(rejected, b.pages.length, 'every foreign page must be rejected by session id');
  assert.notEqual(
    Buffer.from(asm.session.sessionId).toString('hex'),
    Buffer.from(b.sessionId).toString('hex'),
    'session must stay locked to the first transfer seen',
  );
});

test('transfer: damaged cells within budget are corrected; beyond it is refused', async () => {
  const payload = rndBytes(6000, 71);
  const t = await encodeTransfer(payload, { profile: 'PL-D2', nozzle: '0.2' });
  const cells = t.geom.totalCells;
  const damage = async (frac) => {
    const r = rng(999);
    const asm = new TransferAssembler();
    for (const p of t.pages) {
      const missing = new Uint8Array(cells);
      for (let i = 0; i < cells; i++) if (r() < frac) missing[i] = 1;
      const res = await asm.feed(mkPage(p, { cellMissing: missing }));
      if (!res.ok) return { asm, res };
    }
    return { asm, res: null };
  };
  const light = await damage(0.05);
  assert.ok(eq(light.asm.result || new Uint8Array(), payload), '5% random cell loss must be corrected');
  const heavy = await damage(0.6);
  assert.equal(heavy.asm.result, null, '60% cell loss must be refused');
});

test('transfer: wrong passphrase is detected, never silently wrong output', async () => {
  const text = new TextEncoder().encode('secret nozzle calibration key 0123456789'.repeat(20));
  const t = await encodeTransfer(text, {
    profile: 'PL-G',
    nozzle: '0.4',
    cipher: true,
    passphrase: 'correct horse',
    iterations: 2000,
  });
  assert.ok(t.flags & FLAGS.CIPHER);

  const good = new TransferAssembler({ passphrase: 'correct horse', iterations: 2000 });
  await feedAll(good, t.pages);
  assert.ok(good.result, `decrypt failed: ${good.error}`);
  assert.ok(eq(good.result, text));

  const bad = new TransferAssembler({ passphrase: 'wrong horse', iterations: 2000 });
  await feedAll(bad, t.pages);
  assert.equal(bad.result, null);
  assert.match(bad.error, /digest-mismatch|transform-failed/);

  const locked = new TransferAssembler();
  await feedAll(locked, t.pages);
  assert.equal(locked.result, null);
  assert.equal(locked.needPassphrase, true, 'receiver must ask for the passphrase, not fail silently');
});

test('transfer: nothing is reported complete unless bytes match', async () => {
  // mini G5: mutate whole cells on every page; either RS fixes it, or we refuse.
  const payload = rndBytes(3000, 88);
  const t = await encodeTransfer(payload, { profile: 'P-M1-300' });
  let accepted = 0;
  let refused = 0;
  let wrong = 0;
  const r = rng(5);
  for (let trial = 0; trial < 300; trial++) {
    const asm = new TransferAssembler();
    for (const p of t.pages) {
      const levels = Uint16Array.from(p.levels);
      const nMut = 1 + ((r() * 40) | 0);
      for (let i = 0; i < nMut; i++) levels[(r() * levels.length) | 0] ^= 1 << ((r() * 3) | 0);
      await asm.feed({ levels, header: p.header });
    }
    if (asm.result) {
      accepted++;
      if (!eq(asm.result, payload)) wrong++;
    } else refused++;
  }
  assert.equal(wrong, 0, 'a false accept happened: the safety invariant is broken');
  assert.ok(accepted > 0, 'light damage must be corrected');

  // heavy damage leg: past the intra+inter budget the receiver must fall silent
  let heavyAccepted = 0;
  let heavyWrong = 0;
  for (let trial = 0; trial < 40; trial++) {
    const asm = new TransferAssembler();
    for (const p of t.pages) {
      const levels = Uint16Array.from(p.levels);
      const nMut = 2000 + ((r() * 3000) | 0);
      for (let i = 0; i < nMut; i++) levels[(r() * levels.length) | 0] ^= 1 << ((r() * 3) | 0);
      await asm.feed({ levels, header: p.header });
    }
    if (asm.result) {
      heavyAccepted++;
      if (!eq(asm.result, payload)) heavyWrong++;
    }
  }
  assert.equal(heavyWrong, 0, 'false accept under heavy damage');
  assert.ok(heavyAccepted < 40, `heavy damage was never refused (${heavyAccepted}/40 accepted)`);
});

test('roundtrip helper: ideal, dropped-page and mono-degraded paths', async () => {
  const payload = rndBytes(2000, 101);
  const ideal = await roundtrip(payload, { profile: 'PL-D2', nozzle: '0.2' });
  assert.ok(eq(ideal.result, payload));

  const mono = await roundtrip(payload, { profile: 'PL-D2', nozzle: '0.2' }, (p) => ({
    levels: p.levels,
    channelMissing: ['colour'],
  }));
  assert.ok(eq(mono.result, payload), 'single-colour print of a dual profile must work');

  const dropped = await roundtrip(payload, { profile: 'PL-D2', nozzle: '0.2' }, (p, i) => (i % 3 === 0 ? null : {}));
  assert.ok(dropped.result === null || eq(dropped.result, payload));
});

test('progress reporting tells the operator which pages are still missing', async () => {
  const t = await encodeTransfer(rndBytes(20000, 3), { profile: 'P-M1-300' });
  assert.ok(t.dataPages >= 3, `need several data pages, got ${t.dataPages}`);
  const asm = new TransferAssembler();
  await feedAll(asm, t.pages.slice(0, 1));
  const pr = asm.progress;
  assert.equal(pr.dataHave, 1);
  assert.ok(pr.missing.length >= 1, 'must list missing data pages');
  assert.equal(pr.missing[0], 1);
  assert.equal(pr.complete, false);
  assert.equal(pr.dataNeed, t.dataPages);
  assert.ok(pr.need > 2);
});
