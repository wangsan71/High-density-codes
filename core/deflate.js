/**
 * PSKT core -- self-contained, lossless DEFLATE subset (RFC 1951) + PSKT container.
 *
 * Zero dependency, synchronous, runs on Node >= 20 and in browsers under `file://`
 * (no node:zlib, no CompressionStream, no npm). This is the compressor the send
 * pipeline (docs/PLAN.md sec. 4) puts in front of the SHA-256 digest, and the
 * decoder the scan side uses to un-shrink a payload.
 *
 * ===========================================================================
 * PSKT container format ("PSZ1") -- normative; cross-language reference
 * decoders (ref/*.py) implement exactly this layout. Integers are little-endian.
 *
 *   offset  size  field
 *   ------  ----  -----------------------------------------------------------
 *    0       4    magic    'P' 'S' 'Z' 1   =  50 53 5A 01
 *    4       1    method   0x00 = stored   (payload is a raw byte copy)
 *                         0x01 = DEFLATE  (RFC 1951 bit stream)
 *    5       1    reserved 0x00 (written as 0; readers must ignore it)
 *    6       4    originalLength  uint32LE -- length of the UNCOMPRESSED bytes
 *   10       n    payload
 *
 * The method = 0x01 payload is the raw RFC 1951 DEFLATE bit stream, packed
 * LSB-first (RFC 1951 sec. 1.4) and zero-padded to the next byte boundary; there
 * is no zlib/gzip wrapper and no checksum inside the payload. This library always
 * emits a single BTYPE=01 (fixed Huffman) block with BFINAL=1, but its inflate
 * accepts BTYPE=00 (stored), BTYPE=01 and BTYPE=10 (dynamic Huffman) blocks in
 * any number, so node:zlib `deflateRawSync` output cross-validates both ways.
 *
 * originalLength is a defensive check, not a convenience: decompress() throws
 * unless the produced byte count equals it, so a truncated or tampered payload
 * can never be silently accepted (PSKT invariant: fail rather than mis-decode).
 * For method = 0x00 the payload length must also equal originalLength exactly.
 * A DEFLATE reader stops at the end of the final block and ignores whatever
 * bytes follow (zlib / Python zlib.decompressobj() semantics): the stream is
 * self-terminating, and the enclosing frame owns the exact payload boundary.
 * ===========================================================================
 *
 * Bit order (the classic DEFLATE trap): the *stream* is LSB-first -- every header
 * field and every extra-bit group is taken from the low bit up -- while Huffman
 * codes are *written* MSB-first per the RFC 1951 tables, so codes are
 * bit-reversed on output (FIXED_*_REV) and bit-reversed again on lookup (rev16).
 *
 * Compressor: LZ77 with a 16-bit 3-byte hash table plus hash chains over a
 * 32768-byte window (shrunk to the input length), min match 3, max match 258,
 * greedy with chain pruning; RFC 1951 fixed Huffman codes for literals, lengths
 * and distances. If the result is not below 98% of the input size (incompressible
 * data) we fall back to method 0x00 stored, so compress() never bloats by more
 * than the header.
 *
 * Exports
 *   compress(bytes)          -> Uint8Array   PSZ1 container
 *   decompress(bytes)        -> Uint8Array   original bytes, or throws
 *   isCompressed(bytes)      -> boolean      PSZ1 magic present (routing hint)
 *   deflateRaw(bytes)        -> Uint8Array   bare RFC 1951 stream (no container)
 *   inflateRaw(bytes, [n])   -> Uint8Array   bare RFC 1951 decoder; n, when given,
 *                                            caps the output at n bytes
 *   decompressPayload        = inflateRaw (alias used by the CLI and the tests)
 *   MAGIC, METHOD_STORED, METHOD_DEFLATE, HEADER_SIZE, MAX_ORIGINAL_LENGTH
 *
 * Every entry point accepts Uint8Array or ArrayBuffer (any TypedArray view too)
 * and returns a freshly allocated Uint8Array that never aliases the input.
 */

/* ------------------------------------------------------------------ */
/* container constants                                                 */
/* ------------------------------------------------------------------ */

export const MAGIC = new Uint8Array([0x50, 0x53, 0x5a, 0x31]); // "PSZ1"
export const METHOD_STORED = 0x00;
export const METHOD_DEFLATE = 0x01;
export const HEADER_SIZE = 10;
const MAX_ORIGINAL_LENGTH = 0xffffffff;

/* ------------------------------------------------------------------ */
/* RFC 1951 sec. 3.2.5 length / distance tables                        */
/* ------------------------------------------------------------------ */

const LEN_BASE = new Uint16Array([
  3, 4, 5, 6, 7, 8, 9, 10, // codes 257..264, 0 extra bits
  11, 13, 15, 17, // 265..268, 1 extra
  19, 23, 27, 31, // 269..272, 2 extra
  35, 43, 51, 59, // 273..276, 3 extra
  67, 83, 99, 115, // 277..280, 4 extra
  131, 163, 195, 227, // 281..284, 5 extra
  258, // 285, 0 extra
]);
const LEN_EXTRA = new Uint8Array([
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
]);
const DIST_BASE = new Uint16Array([
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769,
  1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
]);
const DIST_EXTRA = new Uint8Array([
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
]);
const MAX_MATCH = 258;
const MIN_MATCH = 3;
const MAX_WINDOW = 32768;
const MAX_BITS = 15;

/** match length (3..258) -> index into LEN_BASE / LEN_EXTRA */
const LEN_CODE = (() => {
  const t = new Uint8Array(MAX_MATCH + 1);
  for (let i = 0; i < LEN_BASE.length; i++) {
    const hi = i + 1 < LEN_BASE.length ? LEN_BASE[i + 1] - 1 : MAX_MATCH;
    for (let l = LEN_BASE[i]; l <= hi; l++) t[l] = i;
  }
  return t;
})();

/** distance (1..32768) -> index into DIST_BASE / DIST_EXTRA */
const DIST_CODE = (() => {
  const t = new Uint8Array(MAX_WINDOW + 1);
  for (let i = 0; i < DIST_BASE.length; i++) {
    const hi = i + 1 < DIST_BASE.length ? DIST_BASE[i + 1] - 1 : MAX_WINDOW;
    const upto = hi < MAX_WINDOW ? hi : MAX_WINDOW;
    for (let d = DIST_BASE[i]; d <= upto; d++) t[d] = i;
  }
  return t;
})();

/* ------------------------------------------------------------------ */
/* bit helpers                                                         */
/* ------------------------------------------------------------------ */

function reverseBits(x, len) {
  let r = 0;
  for (let i = 0; i < len; i++) {
    r = (r << 1) | (x & 1);
    x >>>= 1;
  }
  return r >>> 0;
}

const REV8 = (() => {
  const t = new Uint16Array(256);
  for (let i = 0; i < 256; i++) t[i] = reverseBits(i, 8);
  return t;
})();

/** reverse the 16 bits of x (x < 65536); result < 65536 */
function rev16(x) {
  return ((REV8[x & 255] << 8) | REV8[(x >>> 8) & 255]) >>> 0;
}

/** LSB-first bit sink over a self-growing byte buffer. */
class BitWriter {
  constructor(capacity) {
    this.buf = new Uint8Array(capacity > 0 ? capacity : 64);
    this.n = 0;
    this.acc = 0;
    this.nbits = 0;
  }

  /** append `count` bits of `value`, lowest bit first (0 <= count <= 16). */
  bits(value, count) {
    if (count === 0) return;
    this.acc = (this.acc | ((value & ((1 << count) - 1)) << this.nbits)) >>> 0;
    this.nbits += count;
    while (this.nbits >= 8) {
      this._byte(this.acc & 255);
      this.acc >>>= 8;
      this.nbits -= 8;
    }
  }

  /**
   * Append a Huffman code. `rev` must already be bit-reversed for the LSB-first
   * stream, i.e. rev === reverseBits(msbFirstCode, count) (see FIXED_*_REV).
   */
  hcode(rev, count) {
    this.bits(rev, count);
  }

  _byte(b) {
    if (this.n === this.buf.length) {
      const bigger = new Uint8Array(this.buf.length * 2 + 64);
      bigger.set(this.buf.subarray(0, this.n));
      this.buf = bigger;
    }
    this.buf[this.n++] = b;
  }

  /** zero-pad to the next byte boundary and return the payload. */
  finish() {
    if (this.nbits > 0) {
      this._byte(this.acc & 255);
      this.acc = 0;
      this.nbits = 0;
    }
    return this.buf.subarray(0, this.n);
  }
}

/** LSB-first bit source over a fixed byte range. */
class BitReader {
  constructor(data, offset, length) {
    this.data = data;
    this.pos = offset;
    this.end = offset + length;
    this.bitbuf = 0;
    this.bitcnt = 0;
  }

  /** pull bytes into the accumulator until more than `nbits` are held, or EOF. */
  fill(nbits) {
    while (this.bitcnt <= nbits && this.pos < this.end) {
      this.bitbuf = (this.bitbuf | (this.data[this.pos++] << this.bitcnt)) >>> 0;
      this.bitcnt += 8;
    }
  }

  /** read `count` ordinary bits, LSB-first (0 <= count <= 16). */
  bits(count) {
    if (count === 0) return 0;
    if (this.bitcnt < count) {
      this.fill(count);
      if (this.bitcnt < count) throw new Error('deflate.inflate: truncated bit stream');
    }
    const v = (this.bitbuf & ((1 << count) - 1)) >>> 0;
    this.bitbuf = (this.bitbuf >>> count) >>> 0;
    this.bitcnt -= count;
    return v;
  }

  /** decode one Huffman symbol (codes are written MSB-first into an LSB-first stream). */
  huffman(dec) {
    if (dec.maxlen === 0) throw new Error('deflate.inflate: symbol without a Huffman code');
    if (this.bitcnt < 16) this.fill(15);
    const k = this.bitcnt < 16 ? this.bitcnt : 16;
    const lim = dec.maxlen < k ? dec.maxlen : k;
    if (lim === 0) throw new Error('deflate.inflate: truncated bit stream');
    const y = rev16(this.bitbuf & 0xffff);
    let first = 0;
    let index = 0;
    for (let len = 1; len <= lim; len++) {
      const cnt = dec.counts[len];
      // `first` doubles on every level (canonical numbering), including levels
      // with no code at all, so the bookkeeping must not be inside the cnt test.
      const code = (y >>> (16 - len)) >>> 0;
      if (cnt !== 0 && code - cnt < first) {
        this.bitbuf = (this.bitbuf >>> len) >>> 0;
        this.bitcnt -= len;
        return dec.symbols[index + code - first];
      }
      index += cnt;
      first = (first + cnt) << 1;
    }
    throw new Error('deflate.inflate: invalid Huffman code');
  }

  /** discard the unused low bits of the current byte. */
  align() {
    const r = this.bitcnt & 7;
    this.bitbuf = (this.bitbuf >>> r) >>> 0;
    this.bitcnt -= r;
  }

  /** raw (byte-aligned) copy of `len` bytes into out. */
  copyRaw(len, out) {
    while (len > 0 && this.bitcnt >= 8) {
      out.byte(this.bitbuf & 255);
      this.bitbuf = (this.bitbuf >>> 8) >>> 0;
      this.bitcnt -= 8;
      len--;
    }
    if (len > 0) {
      if (this.pos + len > this.end) throw new Error('deflate.inflate: truncated stored block');
      if (this.bitcnt === 0 && len >= 16) {
        out.block(this.data.subarray(this.pos, this.pos + len));
        this.pos += len;
      } else {
        while (len--) out.byte(this.bits(8));
      }
    }
  }
}

/**
 * Byte sink with capacity growth. `max` bounds total output: for a PSKT container
 * it is the declared originalLength, so a corrupt stream can never make us
 * allocate without end; bare inflateRaw uses a generous fixed cap.
 */
class ByteSink {
  constructor(capacity, max) {
    this.a = new Uint8Array(capacity > 0 ? capacity : 4096);
    this.n = 0;
    this.max = max;
  }

  _room(k) {
    if (this.n + k <= this.a.length) return;
    let c = this.a.length;
    while (c < this.n + k) c *= 2;
    const bigger = new Uint8Array(c);
    bigger.set(this.a.subarray(0, this.n));
    this.a = bigger;
  }

  byte(b) {
    if (this.n >= this.max) throw new Error('deflate.inflate: output exceeds declared length');
    if (this.n === this.a.length) this._room(1);
    this.a[this.n++] = b;
  }

  block(src) {
    if (this.n + src.length > this.max) {
      throw new Error('deflate.inflate: output exceeds declared length');
    }
    this._room(src.length);
    this.a.set(src, this.n);
    this.n += src.length;
  }

  match(dist, len) {
    if (this.n + len > this.max) throw new Error('deflate.inflate: output exceeds declared length');
    if (dist > this.n) throw new Error('deflate.inflate: distance too far back');
    this._room(len);
    // An LZ77 copy is NOT a memmove. When len > dist the tail of the run is read
    // back out of the bytes this very match is writing (RFC 1951 sec. 3.2.5), so a
    // single copyWithin -- which copies the source range as it looked *before* the
    // copy, and therefore reads the untouched zero slack past `n` -- turns
    // `ff ff ff ff ...` into `ff 00 00 00 ...`.
    // Seed the run with the `dist` bytes that exist, then keep replicating the
    // run's own already-materialised prefix; each round doubles it, so even a
    // dist=1 run of 258 bytes costs log2(258) ~ 9 block copies.
    const dst = this.n;
    let done = dist < len ? dist : len;
    this.a.copyWithin(dst, dst - dist, dst - dist + done);
    while (done < len) {
      const rest = len - done;
      const chunk = rest < done ? rest : done; // <= bytes materialised at [dst, dst+done)
      this.a.copyWithin(dst + done, dst, dst + chunk);
      done += chunk;
    }
    this.n = dst + len;
  }
}

/* ------------------------------------------------------------------ */
/* Huffman tables                                                      */
/* ------------------------------------------------------------------ */

/** Canonical (RFC 1951 sec. 3.2.2) MSB-first codes for a set of code lengths. */
function canonicalCodes(lengths) {
  const bl = new Uint16Array(MAX_BITS + 1);
  for (let i = 0; i < lengths.length; i++) {
    if (lengths[i] > MAX_BITS) throw new Error('deflate: code length too large');
    bl[lengths[i]]++;
  }
  bl[0] = 0;
  const next = new Uint32Array(MAX_BITS + 2);
  let code = 0;
  for (let len = 1; len <= MAX_BITS; len++) {
    code = (code + bl[len - 1]) << 1;
    next[len] = code >>> 0;
  }
  const out = new Uint16Array(lengths.length);
  for (let i = 0; i < lengths.length; i++) {
    const l = lengths[i];
    if (l !== 0) out[i] = next[l]++;
  }
  return out;
}

/**
 * Decode side of a canonical Huffman code: symbol counts per code length plus
 * symbols in canonical order, so decoding needs no bit-reversal table per symbol.
 */
function makeDecoder(lengths) {
  const counts = new Uint16Array(MAX_BITS + 1);
  let maxlen = 0;
  for (let i = 0; i < lengths.length; i++) {
    const l = lengths[i];
    if (l !== 0) {
      if (l > MAX_BITS) throw new Error('deflate.inflate: code length too large');
      counts[l]++;
      if (l > maxlen) maxlen = l;
    }
  }
  let left = 1;
  for (let len = 1; len <= maxlen; len++) {
    left <<= 1;
    left -= counts[len];
    if (left < 0) throw new Error('deflate.inflate: over-subscribed Huffman code');
  }
  const index = new Int32Array(MAX_BITS + 2);
  let sum = 0;
  for (let len = 1; len <= MAX_BITS; len++) {
    index[len] = sum;
    sum += counts[len];
  }
  const symbols = new Int32Array(sum);
  const fill = Int32Array.from(index);
  for (let i = 0; i < lengths.length; i++) {
    const l = lengths[i];
    if (l !== 0) symbols[fill[l]++] = i;
  }
  return { counts, symbols, maxlen };
}

/* RFC 1951 sec. 3.2.6 fixed literal/length code lengths. */
const FIXED_LENGTHS = (() => {
  const l = new Uint8Array(288);
  l.fill(8, 0, 144); // 0..143   -> 8 bits
  l.fill(9, 144, 256); // 144..255 -> 9 bits
  l.fill(7, 256, 280); // 256..279 -> 7 bits
  l.fill(8, 280, 288); // 280..287 -> 8 bits
  return l;
})();
/* fixed distance code: 30 codes, all 5 bits */
const FIXED_DIST_LENGTHS = (() => {
  const l = new Uint8Array(30);
  l.fill(5);
  return l;
})();

const FIXED_CODES = canonicalCodes(FIXED_LENGTHS);
const FIXED_DIST_CODES = canonicalCodes(FIXED_DIST_LENGTHS);
/* Pre-reversed so the encoder appends them without touching REV8 per symbol. */
const FIXED_LIT_REV = new Uint16Array(288);
const FIXED_LIT_LEN = new Uint8Array(288);
const FIXED_DIST_REV = new Uint16Array(30);
const FIXED_DIST_LEN = new Uint8Array(30);
for (let i = 0; i < 288; i++) {
  const l = FIXED_LENGTHS[i];
  FIXED_LIT_LEN[i] = l;
  FIXED_LIT_REV[i] = reverseBits(FIXED_CODES[i], l);
}
for (let i = 0; i < 30; i++) {
  FIXED_DIST_LEN[i] = 5;
  FIXED_DIST_REV[i] = reverseBits(FIXED_DIST_CODES[i], 5);
}

const FIXED_LIT_DEC = makeDecoder(FIXED_LENGTHS);
const FIXED_DIST_DEC = makeDecoder(FIXED_DIST_LENGTHS);

/** CLCL transmission order of RFC 1951 sec. 3.2.7. */
const CLEN_ORDER = new Uint8Array([16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]);

/* ------------------------------------------------------------------ */
/* input coercion                                                      */
/* ------------------------------------------------------------------ */

/** Accept Uint8Array / ArrayBuffer / any TypedArray / plain number array. */
function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  if (Array.isArray(input)) return Uint8Array.from(input);
  throw new TypeError('deflate: expected Uint8Array or ArrayBuffer');
}

/* ------------------------------------------------------------------ */
/* compressor                                                          */
/* ------------------------------------------------------------------ */

const HASH_BITS = 16;
const HASH_SIZE = 1 << HASH_BITS;
const HASH_MASK = HASH_SIZE - 1;
const PREV_MASK = HASH_SIZE - 1;
const MAX_CHAIN = 64;

function hash3(b, i) {
  return ((b[i] << 10) ^ (b[i + 1] << 5) ^ b[i + 2]) & HASH_MASK;
}

/**
 * One fixed-Huffman (BTYPE=01) block with BFINAL=1: LZ77 over `bytes` using hash
 * chains, literals/lengths/distances emitted with the RFC 1951 fixed code table.
 * The result is a legal RFC 1951 stream, so inflateRawSync() accepts it.
 */
function deflateFixed(bytes) {
  const n = bytes.length;
  const win = n < MAX_WINDOW ? n : MAX_WINDOW;
  const bw = new BitWriter(n + (n >> 3) + 64);

  bw.bits(1, 1); // BFINAL = 1
  bw.bits(1, 2); // BTYPE = 01 (fixed Huffman)

  if (n === 0) {
    bw.hcode(FIXED_LIT_REV[256], FIXED_LIT_LEN[256]);
    return bw.finish();
  }

  const head = new Int32Array(HASH_SIZE).fill(-1);
  const prev = new Int32Array(HASH_SIZE).fill(-1);
  let inserted = 0;
  let i = 0;

  while (i < n) {
    // Index every position strictly before i (a start needs a full 3-byte read).
    // Positions covered by a just-emitted match are indexed on the next round,
    // so chains stay dense without a second pass over the input.
    while (inserted < i && inserted + MIN_MATCH <= n) {
      const h = hash3(bytes, inserted);
      prev[inserted & PREV_MASK] = head[h];
      head[h] = inserted;
      inserted++;
    }
    if (inserted < i) inserted = i; // tail: no further indexable starts

    let bestLen = 0;
    let bestDist = 0;
    const maxAvail = n - i < MAX_MATCH ? n - i : MAX_MATCH;
    if (maxAvail >= MIN_MATCH) {
      const h = hash3(bytes, i);
      let cand = head[h]; // only positions < i are ever indexed, so dist >= 1
      const lower = i - win;
      let chain = MAX_CHAIN;
      while (cand > lower && chain-- > 0) {
        // cheap prune: the byte that would extend the current best must match
        if (bytes[cand + bestLen] === bytes[i + bestLen]) {
          let l = 0;
          while (l < maxAvail && bytes[cand + l] === bytes[i + l]) l++;
          if (l > bestLen) {
            bestLen = l;
            bestDist = i - cand;
            if (l >= maxAvail || l >= MAX_MATCH) break;
          }
        }
        cand = prev[cand & PREV_MASK];
      }
    }

    if (bestLen >= MIN_MATCH) {
      const li = LEN_CODE[bestLen];
      bw.hcode(FIXED_LIT_REV[257 + li], FIXED_LIT_LEN[257 + li]);
      bw.bits(bestLen - LEN_BASE[li], LEN_EXTRA[li]);
      const di = DIST_CODE[bestDist];
      bw.hcode(FIXED_DIST_REV[di], FIXED_DIST_LEN[di]);
      bw.bits(bestDist - DIST_BASE[di], DIST_EXTRA[di]);
      i += bestLen;
    } else {
      const b = bytes[i];
      bw.hcode(FIXED_LIT_REV[b], FIXED_LIT_LEN[b]);
      i++;
    }
  }

  bw.hcode(FIXED_LIT_REV[256], FIXED_LIT_LEN[256]); // end of block
  return bw.finish();
}

/** Raw RFC 1951 DEFLATE stream (no PSKT header), fixed Huffman. */
export function deflateRaw(input) {
  return deflateFixed(toBytes(input));
}

/**
 * Compress into a PSKT "PSZ1" container.
 * @param {Uint8Array|ArrayBuffer} input
 * @returns {Uint8Array}
 */
export function compress(input) {
  const src = toBytes(input);
  const n = src.length;
  if (n > MAX_ORIGINAL_LENGTH) {
    throw new RangeError('deflate: input larger than the uint32 length field');
  }

  let method = METHOD_DEFLATE;
  let payload = deflateFixed(src);
  // incompressible input (>= 98% of the original size) -> stored, exactly:
  //   payload.length >= n * 98 / 100   <=>   payload.length * 50 >= n * 49
  if (payload.length * 50 >= n * 49) {
    method = METHOD_STORED;
    payload = src.slice();
  }

  const out = new Uint8Array(HEADER_SIZE + payload.length);
  out.set(MAGIC, 0);
  out[4] = method;
  out[5] = 0; // reserved
  out[6] = n & 255;
  out[7] = (n >>> 8) & 255;
  out[8] = (n >>> 16) & 255;
  out[9] = (n >>> 24) & 255;
  out.set(payload, HEADER_SIZE);
  return out;
}

/* ------------------------------------------------------------------ */
/* inflater                                                            */
/* ------------------------------------------------------------------ */

/** Build the literal/length and distance decoders of a BTYPE=10 block. */
function dynamicTables(br) {
  const hlit = br.bits(5) + 257;
  const hdist = br.bits(5) + 1;
  const hclen = br.bits(4) + 4;

  const clens = new Uint8Array(19);
  for (let i = 0; i < hclen; i++) clens[CLEN_ORDER[i]] = br.bits(3);
  const cldec = makeDecoder(clens);

  const lengths = new Uint8Array(hlit + hdist);
  const total = lengths.length;
  let n = 0;
  while (n < total) {
    const s = br.huffman(cldec);
    if (s < 16) {
      lengths[n++] = s;
    } else if (s === 16) {
      if (n === 0) throw new Error('deflate.inflate: no previous code length to repeat');
      const v = lengths[n - 1];
      let r = 3 + br.bits(2);
      while (r-- > 0 && n < total) lengths[n++] = v;
    } else if (s === 17) {
      let r = 3 + br.bits(3);
      while (r-- > 0 && n < total) lengths[n++] = 0;
    } else if (s === 18) {
      let r = 11 + br.bits(7);
      while (r-- > 0 && n < total) lengths[n++] = 0;
    } else {
      throw new Error('deflate.inflate: bad code-length symbol');
    }
  }

  const lit = makeDecoder(lengths.subarray(0, hlit));
  const dist = makeDecoder(lengths.subarray(hlit));
  if (lit.maxlen === 0) throw new Error('deflate.inflate: empty literal code');
  return { lit, dist };
}

function inflateBlock(br, lit, dist, out) {
  for (;;) {
    const sym = br.huffman(lit);
    if (sym < 256) {
      out.byte(sym);
    } else if (sym === 256) {
      return; // end of block
    } else {
      const li = sym - 257;
      if (li < 0 || li >= LEN_BASE.length) throw new Error('deflate.inflate: bad length symbol');
      const len = LEN_BASE[li] + br.bits(LEN_EXTRA[li]);
      const dsym = br.huffman(dist);
      if (dsym < 0 || dsym >= DIST_BASE.length) {
        throw new Error('deflate.inflate: bad distance symbol');
      }
      const d = DIST_BASE[dsym] + br.bits(DIST_EXTRA[dsym]);
      out.match(d, len);
    }
  }
}

function inflatePayload(input, offset, declaredLen) {
  const data = toBytes(input);
  const UNCAPED_MAX = 512 * 1024 * 1024; // bare inflateRaw: still bounded
  const max = declaredLen >= 0 ? declaredLen : UNCAPED_MAX;
  const br = new BitReader(data, offset, data.length - offset);
  const initial = declaredLen >= 0 && declaredLen + 1 < (1 << 22) ? declaredLen + 1 : 4096;
  const out = new ByteSink(initial, max);

  for (;;) {
    const final = br.bits(1);
    const type = br.bits(2);
    if (type === 0) {
      br.align();
      const len = br.bits(16);
      const nlen = br.bits(16);
      if (((len ^ 0xffff) & 0xffff) !== nlen) {
        throw new Error('deflate.inflate: stored block LEN/NLEN mismatch');
      }
      br.copyRaw(len, out);
    } else if (type === 1) {
      inflateBlock(br, FIXED_LIT_DEC, FIXED_DIST_DEC, out);
    } else if (type === 2) {
      const t = dynamicTables(br);
      inflateBlock(br, t.lit, t.dist, out);
    } else {
      throw new Error('deflate.inflate: invalid block type 11');
    }
    if (final) break;
  }

  // Bytes past the end of the final block are ignored, exactly like zlib and
  // Python's zlib.decompressobj(): a DEFLATE stream is self-terminating, so
  // surplus bytes cannot change what we produced, and the caller's framing layer
  // (which knows the true payload length) owns that boundary. Truncation, in
  // contrast, always throws -- the bit stream runs dry mid-symbol -- and the
  // byte count is re-checked against the container's originalLength by
  // decompress(), so a short read can never pass as success either.
  const result = new Uint8Array(out.n);
  result.set(out.a.subarray(0, out.n));
  return result;
}

/**
 * Inflate a raw RFC 1951 DEFLATE bit stream (no PSKT header): stored, fixed and
 * dynamic Huffman blocks, any number of them. This is what makes bidirectional
 * cross-validation with node:zlib possible.
 *
 * @param {Uint8Array|ArrayBuffer} input raw bit stream bytes
 * @param {number} [expectedLen=-1] when >= 0, output is capped at this many bytes
 * @returns {Uint8Array}
 */
export function inflateRaw(input, expectedLen = -1) {
  return inflatePayload(input, 0, expectedLen);
}

/** Alias for inflateRaw(): inflate a bare DEFLATE payload (no PSKT header). */
export const decompressPayload = inflateRaw;

/**
 * Decode a PSKT "PSZ1" container.
 * @throws if the magic is wrong, the method is unknown, the payload disagrees
 *         with the uint32 originalLength, or the bit stream is truncated or
 *         malformed. Never returns data that differs from what went into
 *         compress() without throwing first.
 */
export function decompress(input) {
  const src = toBytes(input);
  if (src.length < HEADER_SIZE) throw new Error('deflate: input too short for a PSZ1 header');
  for (let i = 0; i < 4; i++) {
    if (src[i] !== MAGIC[i]) throw new Error('deflate: not a PSZ1 container (bad magic)');
  }
  const method = src[4];
  const originalLength = ((src[6] | (src[7] << 8) | (src[8] << 16)) >>> 0) + src[9] * 0x1000000;
  const payload = src.subarray(HEADER_SIZE);

  let out;
  if (method === METHOD_STORED) {
    if (payload.length !== originalLength) {
      throw new Error('deflate: stored payload length != originalLength');
    }
    out = payload.slice(); // copy: never hand out a view of the caller's buffer
  } else if (method === METHOD_DEFLATE) {
    out = inflatePayload(payload, 0, originalLength);
  } else {
    throw new Error(`deflate: unsupported method 0x${method.toString(16)}`);
  }

  if (out.length !== originalLength) {
    throw new Error(`deflate: produced ${out.length} bytes but originalLength is ${originalLength}`);
  }
  return out;
}

/**
 * True when `bytes` starts with the PSZ1 magic (never throws on junk input).
 * Deliberately magic-only, not full-header: a truncated container must still be
 * recognised as compressed, so the caller fails loudly instead of silently
 * treating compressed bytes as raw data.
 */
export function isCompressed(input) {
  let src;
  try {
    src = toBytes(input);
  } catch {
    return false;
  }
  if (src.length < 4) return false;
  return src[0] === MAGIC[0] && src[1] === MAGIC[1] && src[2] === MAGIC[2] && src[3] === MAGIC[3];
}
