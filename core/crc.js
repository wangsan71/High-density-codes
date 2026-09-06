/**
 * PSKT core — CRC checksums (synchronous, pure JS, zero dependency).
 *
 *   crc16  : CRC-16/CCITT-FALSE  poly 0x1021, init 0xFFFF, refin/refout false,
 *            xorout 0x0000   -> check("123456789") = 0x29B1
 *   crc32  : CRC-32/ISO-HDLC   poly 0x04C11DB7 reflected, init 0xFFFFFFFF,
 *            xorout 0xFFFFFFFF -> check("123456789") = 0xCBF43926
 *
 * crc16 guards each page frame header, crc32 guards assembled pages and the
 * container formats (3MF zip entries).
 */

let T16 = null;
function table16() {
  if (T16) return T16;
  T16 = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 8;
    for (let k = 0; k < 8; k++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff;
    T16[i] = c;
  }
  return T16;
}

export function crc16(bytes, seed = 0xffff) {
  const t = table16();
  const b = asBytes(bytes);
  let c = seed & 0xffff;
  for (let i = 0; i < b.length; i++) c = ((c << 8) & 0xffff) ^ t[((c >>> 8) ^ b[i]) & 0xff];
  return c & 0xffff;
}

let T32 = null;
function table32() {
  if (T32) return T32;
  T32 = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    T32[i] = c >>> 0;
  }
  return T32;
}

export function crc32(bytes, seed = 0) {
  const t = table32();
  const b = asBytes(bytes);
  let c = (seed ^ 0xffffffff) >>> 0;
  for (let i = 0; i < b.length; i++) c = t[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Streaming helper: crc32 over a concatenation, given the final CRC of the
 * prefix. `crc32(b, crc32(a)) === crc32(concat(a, b))`.
 */
export function crc32Chain(prevCrc, bytes) {
  return crc32(bytes, prevCrc >>> 0);
}

export function asBytes(x) {
  if (x instanceof Uint8Array) return x;
  if (typeof x === 'string') {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(x);
    return Uint8Array.from(Buffer.from(x, 'utf8'));
  }
  if (x instanceof ArrayBuffer) return new Uint8Array(x);
  if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
  throw new TypeError('crc: unsupported input type ' + Object.prototype.toString.call(x));
}

export function toHex(bytes) {
  let s = '';
  const b = asBytes(bytes);
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
  return s;
}

export function fromHex(hex) {
  const h = hex.replace(/[^0-9a-fA-F]/g, '');
  if (h.length % 2) throw new RangeError('fromHex: odd length');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}
