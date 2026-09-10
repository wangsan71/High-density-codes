/**
 * core/image/jpegish.js -- quantised coefficient blocks to a byte stream and back (PLAN v5 P2b, brick three).
 *
 * This is the layer between dct.js (which decides quality) and huff.js (which decides bytes): zigzag
 * order, DC prediction, AC run-length coding, magnitude bits, and a self-describing header that carries
 * the two code-length sets. The name is deliberate -- the *rules* are the JPEG ones because they are the
 * ones with fifty years of evidence behind them, but this is our own container and our own tables.
 *
 * The entropy layer is lossless by construction, and that is the property tested here: coefficients in,
 * the same coefficients out, or a named refusal. Nothing in this file may ever return "close enough".
 */

import { magnitudeBits } from './dct.js';
import { huffmanLengths, canonicalCodes, decoderTable, readSymbol, BitWriter, BitReader } from './huff.js';

export const MAGIC = [0x50, 0x53, 0x4b, 0x4a]; // 'PSKJ'
export const VERSION = 1;

/** Natural index of each zigzag position (the standard JPEG sequence). */
export const ZIGZAG = new Uint8Array([
  0, 1, 8, 16, 9, 2, 3, 10,
  17, 24, 32, 25, 18, 11, 4, 5,
  12, 19, 26, 33, 40, 48, 41, 34,
  27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36,
  29, 22, 15, 23, 30, 37, 44, 51,
  58, 59, 52, 45, 38, 31, 39, 46,
  53, 60, 61, 54, 47, 55, 62, 63,
]);

export function toZigzag(block, out = new Int16Array(64)) {
  for (let i = 0; i < 64; i++) out[i] = block[ZIGZAG[i]];
  return out;
}

export function fromZigzag(zz, out = new Int16Array(64)) {
  for (let i = 0; i < 64; i++) out[ZIGZAG[i]] = zz[i];
  return out;
}

/**
 * The magnitude representation JPEG uses: for a value needing s bits, positive values are written as
 * themselves and negative ones as v + 2^s - 1, so the leading bit always tells the sign.
 */
export function magnitudeValue(v, s) { return v >= 0 ? v : v + (1 << s) - 1; }

/** Inverse of magnitudeValue(): a value whose leading bit is 0 is negative. */
export function valueFromMagnitude(bits, s) {
  if (s === 0) return 0;
  return bits < (1 << (s - 1)) ? bits - ((1 << s) - 1) : bits;
}

const ZRL = 0xf0;
const EOB = 0x00;

/** One pass over the blocks: symbol frequencies plus the raw magnitude-bit count (not Huffman coded). */
export function scanSymbols(blocks) {
  // Both alphabets are 256 wide: the header only carries the symbols that were actually used, so a
  // uniform width costs nothing and removes a class of "which table is this" mistakes.
  const dcFreq = new Uint32Array(256);
  const acFreq = new Uint32Array(256);
  let dcExtra = 0;
  let acExtra = 0;
  let prevDc = 0;
  const zz = new Int16Array(64);
  for (const b of blocks) {
    toZigzag(b, zz);
    const diff = zz[0] - prevDc;
    prevDc = zz[0];
    const ds = magnitudeBits(diff);
    if (ds > 15) throw new RangeError('jpegish: DC difference needs ' + ds + ' bits (limit 15)');
    dcFreq[ds]++;
    dcExtra += ds;
    let run = 0;
    for (let k = 1; k < 64; k++) {
      if (zz[k] === 0) { run++; continue; }
      while (run > 15) { acFreq[ZRL]++; run -= 16; }
      const s = magnitudeBits(zz[k]);
      if (s > 15) throw new RangeError('jpegish: AC coefficient needs ' + s + ' bits (limit 15)');
      acFreq[(run << 4) | s]++;
      acExtra += s;
      run = 0;
    }
    if (run > 0) acFreq[EOB]++;
  }
  return { dcFreq, acFreq, dcExtra, acExtra };
}

/**
 * The symbol list is written in CANONICAL order -- by code length, then by symbol id -- because that is
 * the only order from which a reader can rebuild the lengths it was not told. Writing the symbols in
 * plain ascending order instead is the bug this comment exists to prevent: the stream still looks fine
 * and decodes to silently different coefficients.
 */
function writeTableBytes(out, lengths) {
  const counts = new Uint8Array(16);
  for (let s = 0; s < lengths.length; s++) if (lengths[s] > 0) counts[lengths[s] - 1]++;
  for (const c of counts) out.push(c);
  let n = 0;
  for (let len = 1; len <= 16; len++) {
    for (let s = 0; s < lengths.length; s++) {
      if (lengths[s] === len) { out.push(s); n++; }
    }
  }
  return n;
}

function readTableBytes(bytes, pos) {
  const alphabet = 256;
  const lengths = new Uint8Array(alphabet);
  const counts = bytes.slice(pos.p, pos.p + 16);
  pos.p += 16;
  let n = 0;
  for (const c of counts) n += c;
  const start = pos.p;
  pos.p += n;
  let k = 0;
  for (let len = 1; len <= 16; len++) {
    for (let i = 0; i < counts[len - 1]; i++) {
      const sym = bytes[start + k++];
      if (sym === undefined) throw new RangeError('jpegish: header ends inside the code-length table');
      lengths[sym] = len;
    }
  }
  return lengths;
}

/**
 * Encode quantised coefficient blocks. Blocks are Int16Array(64) in natural order; missing blocks must
 * be supplied as zero blocks by the caller, because this layer has no opinion about image geometry.
 */
export function encodeBlocks(blocks) {
  const { dcFreq, acFreq } = scanSymbols(blocks);
  const dcLengths = huffmanLengths(dcFreq, 16);
  const acLengths = huffmanLengths(acFreq, 16);
  const dcCodes = canonicalCodes(dcLengths);
  const acCodes = canonicalCodes(acLengths);

  const header = [];
  for (const b of MAGIC) header.push(b);
  header.push(VERSION);
  header.push((dcLengths.length >> 8) & 0xff, dcLengths.length & 0xff);
  const dcSyms = writeTableBytes(header, dcLengths);
  const acSyms = writeTableBytes(header, acLengths);

  const w = new BitWriter();
  let prevDc = 0;
  const zz = new Int16Array(64);
  for (const b of blocks) {
    toZigzag(b, zz);
    const diff = zz[0] - prevDc;
    prevDc = zz[0];
    const ds = magnitudeBits(diff);
    w.writeBits(dcCodes[ds], dcLengths[ds]);
    if (ds > 0) w.writeBits(magnitudeValue(diff, ds), ds);
    let run = 0;
    for (let k = 1; k < 64; k++) {
      if (zz[k] === 0) { run++; continue; }
      while (run > 15) { w.writeBits(acCodes[ZRL], acLengths[ZRL]); run -= 16; }
      const s = magnitudeBits(zz[k]);
      const sym = (run << 4) | s;
      w.writeBits(acCodes[sym], acLengths[sym]);
      w.writeBits(magnitudeValue(zz[k], s), s);
      run = 0;
    }
    if (run > 0) w.writeBits(acCodes[EOB], acLengths[EOB]);
  }
  const body = w.finish();
  const head = Uint8Array.from(header);
  const out = new Uint8Array(head.length + body.length);
  out.set(head, 0);
  out.set(body, head.length);
  return {
    bytes: out,
    stats: {
      blocks: blocks.length,
      headerBytes: head.length,
      bodyBytes: body.length,
      dcSymbols: dcSyms,
      acSymbols: acSyms,
      dcMaxLen: dcLengths.reduce((m, l) => Math.max(m, l), 0),
      acMaxLen: acLengths.reduce((m, l) => Math.max(m, l), 0),
    },
  };
}

/** Parse a stream produced by encodeBlocks() into code tables and the entropy payload. */
export function parseHeader(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('jpegish: expected a Uint8Array');
  if (bytes.length < 6) throw new RangeError('jpegish: stream is too short to hold a header');
  for (let i = 0; i < 4; i++) if (bytes[i] !== MAGIC[i]) throw new RangeError('jpegish: not a PSKJ stream (bad magic)');
  const version = bytes[4];
  if (version !== VERSION) throw new RangeError('jpegish: stream version ' + version + ' is not the one this build writes (' + VERSION + ')');
  const alphabet = (bytes[5] << 8) | bytes[6];
  if (alphabet !== 256) throw new RangeError('jpegish: unexpected alphabet size ' + alphabet);
  const pos = { p: 7 };
  const dcLengths = readTableBytes(bytes, pos);
  const acLengths = readTableBytes(bytes, pos);
  return { dcLengths, acLengths, bodyOffset: pos.p, body: bytes.subarray(pos.p) };
}

/** Decode count blocks. Anything the stream does not actually contain is a named error, never a guess. */
export function decodeBlocks(bytes, count) {
  const { dcLengths, acLengths, body } = parseHeader(bytes);
  const dc = decoderTable(dcLengths);
  const ac = decoderTable(acLengths);
  const r = new BitReader(body);
  const out = [];
  let prevDc = 0;
  const zz = new Int16Array(64);
  for (let n = 0; n < count; n++) {
    zz.fill(0);
    const ds = readSymbol(r, dc);
    const diff = ds === 0 ? 0 : valueFromMagnitude(r.readBits(ds), ds);
    prevDc += diff;
    zz[0] = prevDc;
    // Bounded by 63 coefficients, not by an end-of-block marker: a block whose last coefficient is
    // non-zero carries no EOB, and waiting for one would swallow the next block's DC symbol.
    let k = 1;
    while (k < 64) {
      const sym = readSymbol(r, ac);
      if (sym === EOB) break;
      if (sym === ZRL) { k += 16; continue; }
      k += sym >> 4;
      const s = sym & 15;
      if (k > 63) throw new RangeError('jpegish: run-length coding runs past the end of block ' + n);
      zz[k] = valueFromMagnitude(r.readBits(s), s);
      k++;
    }
    out.push(fromZigzag(zz));
  }
  return out;
}
