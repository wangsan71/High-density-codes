/**
 * PSKT core — page frame header (self-describing page, no side channel).
 *
 * A scanned page must be decodable with no prior knowledge: everything needed to
 * locate the page inside its transfer (profile, nozzle, session, index, digest)
 * lives in this 56-byte header, which is additionally repeated in the margin band
 * at 4x cell size (see `encodeEcho`) so a half-in-frame page still identifies
 * itself.
 *
 * Layout (all big-endian):
 *   0..3    magic 0x50534B31  'PSK1'
 *   4       version (u8) = 1
 *   5       profileCode (u8)      index into PROFILE_CODES
 *   6       nozzleCode  (u8)      2|4|6|8 = nozzle*10, 0 = paper / not applicable
 *   7       flags       (u8)      bit0 cipher, bit1 compressed, bit2 monoRecoverable,
 *                                 bit3 lastPagePaddingPresent, bit4 interleave
 *   8..15   sessionId   (8B)      first 8 bytes of the payload digest
 *   16..17  pageIndex   (u16)
 *   18      totalPages  (u8)      data + parity, <= 255
 *   19      kind        (u8)      0 = data page, 1 = parity page
 *   20..23  payloadLen  (u32)     length of the (possibly encrypted) payload stream
 *   24      intraK      (u8)
 *   25      intraNsym   (u8)
 *   26..27  dataBytesPerPage (u16)
 *   28..29  dataPages   (u16)
 *   30..31  blockPad    (u16)     bytes of zero padding appended to the final chunk
 *   32..53  digest      (22B)     truncated SHA-256 of the payload stream (176 bit)
 *   54..55  crc16       (u16)     CRC-16/CCITT-FALSE over bytes 0..53
 */

import { crc16 } from './crc.js';
import { PROFILE_IDS, getProfile } from './profiles.js';

export const MAGIC = 0x50534b31;
export const VERSION = 1;
export const HEADER_LEN = 56;
export const DIGEST_LEN = 22;

export const FLAGS = {
  CIPHER: 1,
  COMPRESSED: 2,
  MONO_RECOVERABLE: 4,
  PADDED: 8,
  INTERLEAVED: 16,
};

export const PAGE_KIND = { DATA: 0, PARITY: 1 };

const CODE_ORDER = PROFILE_IDS.slice();
export const PROFILE_CODES = Object.fromEntries(CODE_ORDER.map((id, i) => [id, i]));
const PROFILE_BY_CODE = Object.fromEntries(CODE_ORDER.map((id, i) => [i, id]));

export function nozzleCode(id) {
  if (!id) return 0;
  const n = Number(id);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 10);
}

export function encodeHeader(f) {
  const out = new Uint8Array(HEADER_LEN);
  const put32 = (o, v) => {
    out[o] = (v >>> 24) & 255;
    out[o + 1] = (v >>> 16) & 255;
    out[o + 2] = (v >>> 8) & 255;
    out[o + 3] = v & 255;
  };
  const put16 = (o, v) => {
    out[o] = (v >>> 8) & 255;
    out[o + 1] = v & 255;
  };
  put32(0, MAGIC);
  out[4] = VERSION;
  const pc = typeof f.profileCode === 'number' ? f.profileCode : PROFILE_CODES[f.profile];
  if (pc === undefined) throw new RangeError(`header: unknown profile ${f.profile}`);
  out[5] = pc;
  out[6] = f.nozzleCode ?? nozzleCode(f.nozzle);
  out[7] = f.flags & 255;
  out.set(f.sessionId.subarray(0, 8), 8);
  put16(16, f.pageIndex);
  out[18] = f.totalPages;
  out[19] = f.kind ?? PAGE_KIND.DATA;
  put32(20, f.payloadLen >>> 0);
  out[24] = f.intraK;
  out[25] = f.intraNsym;
  put16(26, f.dataBytesPerPage);
  put16(28, f.dataPages);
  put16(30, f.blockPad || 0);
  out.set(f.digest.subarray(0, DIGEST_LEN), 32);
  put16(54, crc16(out.subarray(0, 54)));
  return out;
}

/** @returns {{ok:boolean, header?:object, reason?:string}} */
export function decodeHeader(bytes) {
  if (bytes.length < HEADER_LEN) return { ok: false, reason: 'short-header' };
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const rd32 = (o) => ((u[o] << 24) | (u[o + 1] << 16) | (u[o + 2] << 8) | u[o + 3]) >>> 0;
  const rd16 = (o) => (u[o] << 8) | u[o + 1];
  if (rd32(0) !== MAGIC) return { ok: false, reason: 'bad-magic' };
  if (u[4] !== VERSION) return { ok: false, reason: `version-${u[4]}` };
  const want = rd16(54);
  const got = crc16(u.subarray(0, 54));
  if (want !== got) return { ok: false, reason: 'header-crc' };
  const profile = PROFILE_BY_CODE[u[5]];
  if (!profile) return { ok: false, reason: `unknown-profile-code-${u[5]}` };
  return {
    ok: true,
    header: {
      version: u[4],
      profileCode: u[5],
      profile,
      nozzleCode: u[6],
      nozzle: u[6] ? String(u[6] / 10) : null,
      flags: u[7],
      sessionId: u.slice(8, 16),
      pageIndex: rd16(16),
      totalPages: u[18],
      kind: u[19],
      payloadLen: rd32(20),
      intraK: u[24],
      intraNsym: u[25],
      dataBytesPerPage: rd16(26),
      dataPages: rd16(28),
      blockPad: rd16(30),
      digest: u.slice(32, 32 + DIGEST_LEN),
      crc16: want,
    },
  };
}

/** Human-readable flag set for reports. */
export function describeFlags(flags) {
  const names = [];
  if (flags & FLAGS.CIPHER) names.push('cipher');
  if (flags & FLAGS.COMPRESSED) names.push('compressed');
  if (flags & FLAGS.MONO_RECOVERABLE) names.push('monoRecoverable');
  if (flags & FLAGS.PADDED) names.push('padded');
  if (flags & FLAGS.INTERLEAVED) names.push('interleaved');
  return names.join('+') || 'none';
}

/**
 * Margin echo: the header as 1-bit big cells, repeated `times` at the bottom of
 * the quiet band so a partially framed page can still self-identify.
 * Each echo block = HEADER_LEN*8 bits (448 cells).
 */
export function encodeEcho(headerBytes, times = 2) {
  const bits = new Uint8Array(HEADER_LEN * 8);
  for (let i = 0; i < HEADER_LEN; i++) {
    for (let b = 0; b < 8; b++) bits[i * 8 + b] = (headerBytes[i] >>> (7 - b)) & 1;
  }
  const out = new Uint8Array(bits.length * times);
  for (let t = 0; t < times; t++) out.set(bits, t * bits.length);
  return out;
}

/** Try to synchronise on an echo bit stream; returns decoded header or null. */
export function decodeEcho(echoBits) {
  const block = HEADER_LEN * 8;
  const nBlocks = Math.floor(echoBits.length / block);
  for (let t = 0; t < nBlocks; t++) {
    const bytes = new Uint8Array(HEADER_LEN);
    for (let i = 0; i < HEADER_LEN; i++) {
      let v = 0;
      for (let b = 0; b < 8; b++) v = (v << 1) | (echoBits[t * block + i * 8 + b] & 1);
      bytes[i] = v;
    }
    const r = decodeHeader(bytes);
    if (r.ok) return r.header;
  }
  return null;
}

