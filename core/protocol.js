/**
 * PSKT core -?transfer builder and receiver assembler.
 *
 * Unified page model (docs/PROTOCOL.md):
 *   - a *page* carries `D` content bytes and `P` parity bytes (D/P come from the
 *     profile's ECC plan, and are identical for every page of a transfer),
 *   - the **primary channel** (colour when the profile has one, otherwise shape)
 *     carries the content bytes,
 *   - the **secondary channel** (shape) carries the intra-page Reed-Solomon
 *     parity of that content. In "native" single-channel profiles content and
 *     parity share the one channel, laid out as content || parity,
 *   - data pages hold a slice of the payload; parity pages hold Reed-Solomon
 *     parity *across pages* of the same content columns, so any missing page can
 *     be rebuilt. Parity pages are structurally identical to data pages (their
 *     content is RS parity, their channel parity is intra RS of that).
 *
 * Why single-colour printing still works (gate G7): if the colour channel is
 * unreadable, every content byte is an *erasure at a known position*, and the
 * shape channel still carries P >= D parity bytes -?RS recovers it exactly.
 */

import { planPage } from './profiles.js';
import { rsEncode, rsDecode } from './rs.js';
import { encodeHeader, decodeHeader, FLAGS, PAGE_KIND, DIGEST_LEN } from './frame.js';
import { interleaveTable, applyPermute, defaultStep } from './pack.js';
import { sha256 } from './hash.js';
import { compress, decompress } from './deflate.js';
import { chacha20Xor, deriveKey } from './chacha20.js';

export const NONCE_LEN = 12;

/* ------------------------------------------------------------------ */
/* geometry-derived helpers                                            */
/* ------------------------------------------------------------------ */

export function channelNames(geom) {
  const names = geom.channels.map((c) => c.name);
  if (geom.ecc.mode === 'unequal') {
    return { primary: 'colour', secondary: 'shape', bits: Object.fromEntries(geom.channels.map((c) => [c.name, c.bits])) };
  }
  const only = names[0];
  return { primary: only, secondary: null, bits: { [only]: geom.bitsPerCell } };
}

/**
 * Split one cell's packed level value into per-channel values. The bit order is
 * the same one packLevels writes: the first channel's bits are most significant.
 * Works in both ECC modes because it follows the *physical* channel bit widths.
 */
export function splitCellLevel(value, geom) {
  let v = value;
  const out = {};
  for (let i = geom.channels.length - 1; i >= 0; i--) {
    const c = geom.channels[i];
    out[c.name] = v & ((1 << c.bits) - 1);
    v >>>= c.bits;
  }
  if (v !== 0) throw new RangeError(`splitCellLevel: ${value} overflows ${geom.bitsPerCell} bits`);
  return out;
}

/** Inverse of splitCellLevel. */
export function joinCellLevels(parts, geom) {
  let v = 0;
  for (const c of geom.channels) {
    const value = parts[c.name] | 0;
    if (value < 0 || value >= c.levels) {
      throw new RangeError(`joinCellLevels: ${c.name} level ${value} out of range 0..${c.levels - 1}`);
    }
    v = (v << c.bits) | value;
  }
  return v;
}

export function interleaveStep(cellCount) {
  return defaultStep(cellCount);
}

/* ------------------------------------------------------------------ */
/* level packing                                                       */
/* ------------------------------------------------------------------ */

/**
 * Pack content (+parity) bytes into one symbol level per cell.
 * bit layout inside a cell: [primary bits (MSB) ... secondary bits (LSB)]
 */
export function packLevels({ content, parity, geom }) {
  const ch = channelNames(geom);
  const cells = geom.totalCells;
  const pb = ch.bits[ch.primary] || 0;
  const sb = ch.secondary ? ch.bits[ch.secondary] : 0;
  if (pb + sb !== geom.bitsPerCell) throw new Error('packLevels: channel bit mismatch');

  // native profiles carry content || parity in the one and only channel: the
  // secondary bit budget does not exist there, so parity must not be counted twice.
  const native = geom.ecc.mode !== 'unequal';
  const primSource = native ? concat(content, parity || new Uint8Array(0)) : content;
  const primBits = bytesToBitArray(primSource);
  const secBits = native || !parity ? new Uint8Array(0) : bytesToBitArray(parity);
  const primCapacity = cells * pb;
  const secCapacity = cells * sb;
  if (primBits.length > primCapacity) throw new RangeError(`content too large for page: ${primBits.length}>${primCapacity} bits`);
  if (secBits.length > secCapacity) throw new RangeError(`parity too large for page: ${secBits.length}>${secCapacity} bits`);

  const levels = new Uint16Array(cells);
  for (let i = 0; i < cells; i++) {
    let v = 0;
    for (let b = 0; b < pb; b++) {
      const idx = i * pb + b;
      v = (v << 1) | (idx < primBits.length ? primBits[idx] : 0);
    }
    for (let b = 0; b < sb; b++) {
      const idx = i * sb + b;
      v = (v << 1) | (idx < secBits.length ? secBits[idx] : 0);
    }
    levels[i] = v;
  }
  return levels;
}

/** Inverse of packLevels. `missing` marks cells that could not be read.
 *  `missing` may be a Uint8Array of per-cell flags, or
 *  `{cells, channels: {colour:true|shape:true}}` to erase a whole channel
 *  (which is exactly what a single-colour print does to a colour profile). */
export function unpackLevels(levels, geom, missing = null) {
  const ch = channelNames(geom);
  const cells = geom.totalCells;
  const pb = ch.bits[ch.primary] || 0;
  const sb = ch.secondary ? ch.bits[ch.secondary] : 0;
  const D = geom.ecc.dataBytes;
  const P = geom.ecc.parityBytes;
  const cellFlags = missing instanceof Uint8Array ? missing : missing && missing.cells ? missing.cells : null;
  const chanFlags = missing && missing.channels ? missing.channels : null;
  const primaryErased = !!(chanFlags && (chanFlags[ch.primary] || chanFlags.primary));
  const secondaryErased = !!(chanFlags && ch.secondary && (chanFlags[ch.secondary] || chanFlags.secondary));

  const primBits = new Uint8Array(cells * pb);
  const primBad = new Uint8Array(cells * pb);
  const secBits = new Uint8Array(cells * sb);
  const secBad = new Uint8Array(cells * sb);

  for (let i = 0; i < cells; i++) {
    let v = levels[i];
    const cellMissing = cellFlags ? !!cellFlags[i] : false;
    const tmp = new Uint8Array(pb + sb);
    for (let b = pb + sb - 1; b >= 0; b--) {
      tmp[b] = v & 1;
      v >>= 1;
    }
    for (let b = 0; b < pb; b++) {
      primBits[i * pb + b] = tmp[b];
      if (cellMissing) primBad[i * pb + b] = 1;
    }
    for (let b = 0; b < sb; b++) {
      secBits[i * sb + b] = tmp[pb + b];
      if (cellMissing) secBad[i * sb + b] = 1;
    }
  }

  if (primaryErased) primBad.fill(1, 0, cells * pb);
  if (secondaryErased) secBad.fill(1, 0, cells * sb);

  if (geom.ecc.mode === 'unequal') {
    const content = bitArrayToBytes(primBits, D);
    const parity = bitArrayToBytes(secBits, P);
    const contentErased = bitFlagsToByteFlags(primBad, D, pb);
    const parityErased = bitFlagsToByteFlags(secBad, P, sb);
    return { content, parity, contentErased, parityErased, ch };
  }
  // native: one channel carries content || parity
  const all = new Uint8Array(cells * pb);
  const allBad = new Uint8Array(cells * pb);
  all.set(primBits.subarray(0, all.length));
  allBad.set(primBad.subarray(0, all.length));
  const content = bitArrayToBytes(all, D);
  const parity = bitArrayToBytes(all.subarray(D * 8) , P);
  const flatBad = allBad;
  const contentErased = bitFlagsToByteFlags(flatBad.subarray(0, D * 8), D, 1);
  const parityErased = bitFlagsToByteFlags(allBad.subarray(D * 8, D * 8 + P * 8), P, 1);
  return { content, parity, contentErased, parityErased, ch };
}

function bytesToBitArray(bytes) {
  const out = new Uint8Array(bytes.length * 8);
  for (let i = 0; i < bytes.length; i++) {
    for (let b = 0; b < 8; b++) out[i * 8 + b] = (bytes[i] >>> (7 - b)) & 1;
  }
  return out;
}

/** bits (MSB-first, padded with zeros at the tail) -> bytes */
function bitArrayToBytes(bits, byteCount) {
  const out = new Uint8Array(byteCount);
  for (let i = 0; i < byteCount; i++) {
    let v = 0;
    for (let b = 0; b < 8; b++) v = (v << 1) | (bits[i * 8 + b] || 0);
    out[i] = v;
  }
  return out;
}

/**
 * A bit-level "bad" flag expands to a byte-level erasure marker (RS here works on
 * bytes): if any bit of a byte is untrusted, the whole byte becomes an erasure.
 */
function bitFlagsToByteFlags(badBits, byteCount, _bitsPerCell) {
  const out = new Uint8Array(byteCount);
  for (let i = 0; i < byteCount; i++) {
    let bad = 0;
    for (let b = 0; b < 8; b++) if (badBits[i * 8 + b]) bad = 1;
    out[i] = bad;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* intra-page ECC                                                      */
/* ------------------------------------------------------------------ */

export function intraEncode(content, k, nsym) {
  const blocks = Math.floor(content.length / k);
  const out = new Uint8Array(blocks * nsym);
  for (let b = 0; b < blocks; b++) {
    const cw = rsEncode(content.subarray(b * k, (b + 1) * k), nsym);
    out.set(cw.subarray(k), b * nsym);
  }
  return out;
}

/**
 * @param {Uint8Array} erasureFlagsC length k: 1 = data byte erased
 *                       length nsym: 1 = parity byte erased (block-local)
 */
export function intraDecode(content, parity, k, nsym, contentErased, parityErased) {
  const blocks = Math.floor(content.length / k);
  const out = new Uint8Array(blocks * k);
  const stats = { blocks, okBlocks: 0, failedBlocks: [], erasures: 0, errors: 0, cleanBlocks: 0 };
  for (let b = 0; b < blocks; b++) {
    const cw = new Uint8Array(k + nsym);
    cw.set(content.subarray(b * k, (b + 1) * k), 0);
    cw.set(parity.subarray(b * nsym, (b + 1) * nsym), k);
    const er = [];
    for (let i = 0; i < k; i++) if (contentErased && contentErased[b * k + i]) er.push(i);
    for (let i = 0; i < nsym; i++) if (parityErased && parityErased[b * nsym + i]) er.push(k + i);
    const r = rsDecode(cw, nsym, er);
    if (!r.ok) {
      stats.failedBlocks.push(b);
      continue;
    }
    stats.okBlocks++;
    stats.erasures += r.erasures;
    stats.errors += r.errors;
    if (r.clean) stats.cleanBlocks++;
    out.set(r.cw.subarray(0, k), b * k);
  }
  stats.ok = stats.failedBlocks.length === 0;
  return { content: out, ...stats };
}

/* ------------------------------------------------------------------ */
/* encoder                                                             */
/* ------------------------------------------------------------------ */

/**
 * Build all pages of a transfer.
 * @param {Uint8Array} raw payload bytes
 * @param {object} opts {profile, nozzle, parityPct, passphrase, cipher, sheet, plateMm}
 */
export async function encodeTransfer(raw, opts = {}) {
  const geom = planPage(opts.profile || 'PL-D2', opts);
  const D = geom.ecc.dataBytes;
  const P = geom.ecc.parityBytes;
  if (D <= 0) throw new Error('profile has no usable content budget');

  let flags = 0;
  let payload = raw.length ? Uint8Array.from(raw) : new Uint8Array(0);

  // The frame digest always covers the *plaintext*: it is the thing the receiver
  // must reproduce, so a wrong passphrase (or a corrupt deflate stream) is caught
  // instead of silently yielding garbage.
  const fullDigest = sha256(payload);
  const sessionId = fullDigest.slice(0, 8);

  const zipped = compress(payload);
  if (zipped.length + 1 < payload.length) {
    payload = zipped;
    flags |= FLAGS.COMPRESSED;
  }

  let key = null;
  // A passphrase *is* the request to encrypt. Making callers pass a second
  // `cipher: true` as well bought nothing and left a footgun: with only a
  // passphrase, encodeTransfer silently produced a plaintext transfer whose
  // header carried no CIPHER flag. The CLI happened to pass both, so the bug was
  // caught by the conformance fixture, whose encrypted vector turned out to be
  // unencrypted -- and by an independent decoder reading the printed header and
  // observing that nothing on the page told it to decrypt.
  if (opts.cipher || opts.passphrase) {
    if (!opts.passphrase && !opts.key) throw new Error('cipher requested without passphrase');
    const salt = opts.salt || randomBytes(16);
    key = opts.key || (await deriveKey(opts.passphrase, salt, opts.iterations || 150000));
    const nonce = opts.nonce || randomBytes(NONCE_LEN);
    payload = concat(salt, nonce, chacha20Xor(key, nonce, payload, 1));
    flags |= FLAGS.CIPHER;
  }

  const dataPages = Math.ceil(payload.length / D) || 1;
  const padTo = dataPages * D;
  const blockPad = padTo - payload.length;
  if (blockPad) {
    const padded = new Uint8Array(padTo);
    padded.set(payload);
    payload = padded;
    flags |= FLAGS.PADDED;
  }
  const payloadLen = payload.length;

  let parityPages = Math.max(2, Math.ceil((dataPages * (opts.parityPct ?? geom.ecc.inter.parityPct)) / 100));
  if (dataPages + parityPages > 255) parityPages = 255 - dataPages;
  if (parityPages < 1) throw new RangeError(`too many pages: ${dataPages} data pages leave no room for parity`);
  const totalPages = dataPages + parityPages;

  // inter-page RS over content columns
  const pageContent = [];
  for (let q = 0; q < dataPages; q++) pageContent.push(payload.subarray(q * D, (q + 1) * D));
  const parityContent = [];
  for (let j = 0; j < parityPages; j++) parityContent.push(new Uint8Array(D));
  for (let b = 0; b < D; b++) {
    const col = new Uint8Array(dataPages);
    for (let q = 0; q < dataPages; q++) col[q] = pageContent[q][b];
    const cw = rsEncode(col, parityPages);
    for (let j = 0; j < parityPages; j++) parityContent[j][b] = cw[dataPages + j];
  }

  const step = interleaveStep(geom.totalCells);
  const perm = interleaveTable(geom.totalCells, step);
  const intraK = geom.ecc.intra.k;
  const intraNsym = geom.ecc.intra.nsym;

  const pages = [];
  for (let idx = 0; idx < totalPages; idx++) {
    const kind = idx < dataPages ? PAGE_KIND.DATA : PAGE_KIND.PARITY;
    const content = idx < dataPages ? pageContent[idx] : parityContent[idx - dataPages];
    const parity = intraEncode(content, intraK, intraNsym);
    const levelsRaw = packLevels({ content, parity, geom });
    const levels = applyPermute(levelsRaw, perm.fwd);
    const header = encodeHeader({
      profile: geom.profile,
      nozzle: geom.nozzle,
      flags: flags | (geom.ecc.monoRecoverable ? FLAGS.MONO_RECOVERABLE : 0) | FLAGS.INTERLEAVED,
      sessionId,
      pageIndex: idx,
      totalPages,
      kind,
      payloadLen: payload.length,
      intraK,
      intraNsym,
      dataBytesPerPage: D,
      dataPages,
      blockPad,
      digest: fullDigest.subarray(0, DIGEST_LEN),
    });
    pages.push({
      index: idx,
      kind,
      header,
      levels,
      content,
      parity,
      geom,
    });
  }

  return {
    geom,
    sessionId,
    fullDigest,
    pages,
    dataPages,
    parityPages,
    totalPages,
    flags,
    payloadLen: payload.length,
    rawLen: raw.length,
    perPage: D,
    step,
    cipher: !!key,
  };
}

/* ------------------------------------------------------------------ */
/* receiver                                                            */
/* ------------------------------------------------------------------ */

/**
 * Incremental, order-agnostic receiver. Feed it decoded pages (in any order, with
 * duplicates); it assembles, applies inter-page erasure decoding, and only then
 * hands back bytes -?and only if the digest matches.
 */
export class TransferAssembler {
  constructor(opts = {}) {
    this.opts = opts;
    this.session = null; // {sessionId, geom, dataPages, parityPages, D, P, flags, digest}
    this.pages = new Map(); // pageIndex -> {content, header, stats}
    this.duplicates = 0;
    this.rejected = [];
    this.result = null;
  }

  get progress() {
    if (!this.session) {
      // Not one page header was readable, so there is no session to report against.
      // Returning the same key names as the formed-session branch matters: the CLI
      // used to print "(undefined/undefined data pages)" here, which hid the single
      // most diagnostic fact about a failure -- that the receiver never even learned
      // what it was looking at.
      return { have: 0, need: 0, dataHave: 0, dataNeed: 0, missing: [], complete: false, noSession: true };
    }
    const need = this.session.dataPages;
    const have = [...this.pages.keys()].filter((i) => i < need).length;
    const missing = [];
    for (let i = 0; i < need; i++) if (!this.pages.has(i)) missing.push(i);
    return { have: this.pages.size, need: this.session.totalPages, dataHave: have, dataNeed: need, missing, complete: this.result != null };
  }

  /**
   * @param {object} page {levels, header|headerBytes, cellMissing?, channelMissing?}
   * @returns {{ok:boolean, reason?:string, duplicate?:boolean, assembled?:boolean}}
   */
  async feed(page) {
    const rawHeader = page.headerBytes || (page.header instanceof Uint8Array ? page.header : null);
    const hdrRaw = rawHeader ? decodeHeader(rawHeader) : { ok: true, header: page.header };
    if (!hdrRaw.ok) {
      this.rejected.push({ reason: hdrRaw.reason });
      return { ok: false, reason: `header:${hdrRaw.reason}` };
    }
    const h = hdrRaw.header;
    if (this.session) {
      if (!sameBytes(this.session.sessionId, h.sessionId)) return { ok: false, reason: 'other-session' };
      if (this.pages.has(h.pageIndex)) {
        this.duplicates++;
        return { ok: true, duplicate: true };
      }
    } else {
      const geom = planPage(h.profile, {
        nozzle: h.nozzle || undefined,
        sheet: this.opts.sheet,
        plateMm: this.opts.plateMm,
      });
      if (geom.ecc.dataBytes !== h.dataBytesPerPage) {
        return { ok: false, reason: `geometry-mismatch(${geom.ecc.dataBytes}!=${h.dataBytesPerPage})` };
      }
      this.session = {
        sessionId: h.sessionId,
        geom,
        flags: h.flags,
        digest: h.digest,
        dataPages: h.dataPages,
        totalPages: h.totalPages,
        payloadLen: h.payloadLen,
        blockPad: h.blockPad,
        monoSafe: geom.ecc.monoSafe,
        D: h.dataBytesPerPage,
        P: geom.ecc.parityBytes,
        profile: h.profile,
        nozzle: h.nozzle,
      };
    }

    const geom = this.session.geom;
    let levels = page.levels;
    if (h.flags & FLAGS.INTERLEAVED) {
      const perm = interleaveTable(levels.length, interleaveStep(levels.length));
      levels = applyPermute(levels, perm.inv);
    }
    const missing = page.cellMissing || page.missing || null;
    const missingSpec = page.channelMissing
      ? { cells: missing, channels: Object.fromEntries(page.channelMissing.map((n) => [n, true])) }
      : missing;
    const { content, parity, contentErased, parityErased } = unpackLevels(levels, geom, missingSpec);
    const dec = intraDecode(content, parity, h.intraK, h.intraNsym, contentErased, parityErased);
    if (!dec.ok) {
      this.rejected.push({ page: h.pageIndex, reason: 'intra-fail', stats: dec });
      return { ok: false, reason: 'intra-fail', stats: dec };
    }
    this.pages.set(h.pageIndex, { content: dec.content, header: h, stats: dec });

    const done = await this.tryAssemble();
    return { ok: true, assembled: !!done, stats: dec };
  }

  /** @returns {Uint8Array|null} the recovered payload, or null while incomplete */
  async tryAssemble() {
    const s = this.session;
    if (!s) return null;
    const { dataPages, totalPages, D } = s;
    const cols = [];
    const erasureSets = [];
    let ready = true;
    for (let q = 0; q < dataPages; q++) {
      const p = this.pages.get(q);
      if (!p) {
        ready = false;
        break;
      }
      cols.push(p.content);
    }
    if (ready) return finish.call(this, cols);

    // need inter-page recovery
    const parityPages = totalPages - dataPages;
    const missingData = [];
    for (let q = 0; q < dataPages; q++) if (!this.pages.has(q)) missingData.push(q);
    if (missingData.length > parityPages) return null;
    let haveParity = 0;
    for (let j = 0; j < parityPages; j++) if (this.pages.has(dataPages + j)) haveParity++;
    if (haveParity < missingData.length) return null;

    const outPages = new Array(dataPages);
    for (let q = 0; q < dataPages; q++) if (this.pages.has(q)) outPages[q] = Uint8Array.from(this.pages.get(q).content);

    for (let b = 0; b < D; b++) {
      const n = dataPages + parityPages;
      const cw = new Uint8Array(n);
      const er = [];
      for (let q = 0; q < dataPages; q++) {
        const p = this.pages.get(q);
        if (p) cw[q] = p.content[b];
        else er.push(q);
      }
      for (let j = 0; j < parityPages; j++) {
        const p = this.pages.get(dataPages + j);
        if (p) cw[dataPages + j] = p.content[b];
        else er.push(dataPages + j);
      }
      const r = rsDecode(cw, parityPages, er);
      if (!r.ok) return null;
      for (let q = 0; q < dataPages; q++) {
        if (!outPages[q]) (outPages[q] = outPages[q] || new Uint8Array(D))[b] = r.cw[q];
        else if (!this.pages.has(q)) outPages[q][b] = r.cw[q];
      }
    }
    for (let q = 0; q < dataPages; q++) {
      if (!this.pages.has(q)) {
        this.pages.set(q, { content: outPages[q], header: null, stats: { recovered: true } });
      }
    }
    return finish.call(this, outPages);
  }
}

async function finish(pageContents) {
  const s = this.session;
  const joined = new Uint8Array(pageContents.length * s.D);
  for (let q = 0; q < pageContents.length; q++) joined.set(pageContents[q], q * s.D);
  // payloadLen counts the zero padding that filled out the last page; the wire
  // bytes that matter stop at payloadLen - blockPad.
  let payload = joined.subarray(0, s.payloadLen - s.blockPad);

  try {
    if (s.flags & FLAGS.CIPHER) {
      const salt = payload.subarray(0, 16);
      const nonce = payload.subarray(16, 16 + NONCE_LEN);
      const body = payload.subarray(16 + NONCE_LEN);
      if (!this.opts.passphrase && !this.opts.key) {
        // Every consumer reads `error` when `result` is null, and this branch used to leave it unset --
        // so all three receivers fell through to their generic fallback and told the user the batch was
        // SHORT OF PAGES ("still short" / "仍缺料" / "未知原因") while their own progress line read N/N.
        // The pages are all here; what is missing is the key. `needPassphrase` stays the boolean the
        // tests pin, and `error` now carries a machine-readable reason that cannot be mistaken for a
        // missing page (DEFECTS D66). Nothing about acceptance changes: still no result, still no bytes.
        this.needPassphrase = true;
        this.error = 'need-passphrase';
        return null;
      }
      const key = this.opts.key || (await deriveKey(this.opts.passphrase, salt, this.opts.iterations || 150000));
      payload = chacha20Xor(key, nonce, body, 1);
    }
    if (s.flags & FLAGS.COMPRESSED) payload = decompress(payload);
  } catch (e) {
    this.error = `transform-failed: ${e.message}`;
    return null;
  }

  // final gate: the digest covers the plaintext, so nothing wrong ever escapes
  const digest = sha256(payload);
  for (let i = 0; i < DIGEST_LEN; i++) {
    if (digest[i] !== s.digest[i]) {
      this.error = 'digest-mismatch';
      return null;
    }
  }
  this.result = payload;
  return payload;
}

/* ------------------------------------------------------------------ */
/* small utilities                                                     */
/* ------------------------------------------------------------------ */

export function sameBytes(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function concat(...parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function randomBytes(n) {
  const out = new Uint8Array(n);
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.getRandomValues) {
    globalThis.crypto.getRandomValues(out);
  } else {
    for (let i = 0; i < n; i++) out[i] = (Math.random() * 256) & 255;
  }
  return out;
}

/**
 * Convenience one-shot round trip (used by `pskit roundtrip` and the harness).
 * `degrade` may erase whole channels or individual cells to emulate a bad read.
 */
export async function roundtrip(bytes, opts = {}, degrade = null) {
  const t = await encodeTransfer(bytes, opts);
  const asm = new TransferAssembler(opts);
  const order = t.pages.map((p, i) => i);
  if (opts.shuffle) {
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
  }
  for (const i of order) {
    const p = t.pages[i];
    if (degrade) {
      const d = degrade(p, i);
      if (d === null) continue; // page dropped entirely
      await asm.feed({ levels: d.levels ?? p.levels, header: p.header, cellMissing: d.cellMissing, channelMissing: d.channelMissing });
    } else {
      await asm.feed({ levels: p.levels, header: p.header });
    }
  }
  return { transfer: t, result: asm.result, assembler: asm };
}
