import { inflateRaw } from '../deflate.js';

/**
 * Minimal PNG reader: every non-interlaced combination a scanner or a screenshot tool
 * actually emits -- colour types 0 (gray), 2 (RGB), 3 (palette), 4 (gray+alpha) and 6
 * (RGBA), at bit depths 1/2/4/8/16 where the spec allows them, with filters 0-4.
 *
 * This exists so `pskit receive` can read back exactly what `pskit send` wrote: a real
 * encoder/decoder pair, not an in-memory shortcut. It is deliberately strict -- unknown
 * chunks are skipped, but a chunk we cannot interpret throws rather than returning a
 * partially understood image.
 *
 * Why the low bit depths and the palette matter (DEFECTS D80): "black and white" and
 * "line art" are the default modes of most flatbed scanners, and they produce exactly
 * 1-bit gray and palette PNGs. Refusing them meant the tool rejected the *cleanest*
 * input a scanner can give it, and told the user their file was "not a readable PNG"
 * when the scanner had done nothing wrong. 16-bit is accepted by taking the high byte,
 * which is what every 8-bit consumer does.
 */

function u32(b, o) {
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** @returns {{width:number,height:number,pixels:Uint8Array,dpi:number|null}} RGBA8 */
export function decodePNG(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < 8; i++) if (b[i] !== SIGNATURE[i]) throw new Error('decodePNG: not a PNG');
  let o = 8;
  let ihdr = null;
  const idat = [];
  let phy = null;
  let plte = null;
  let trns = null;
  while (o + 8 <= b.length) {
    const len = u32(b, o);
    const type = String.fromCharCode(b[o + 4], b[o + 5], b[o + 6], b[o + 7]);
    const data = b.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') ihdr = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'pHYs') phy = data;
    else if (type === 'PLTE') plte = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IEND') break;
    o += 12 + len;
  }
  if (!ihdr) throw new Error('decodePNG: no IHDR');
  const width = u32(ihdr, 0);
  const height = u32(ihdr, 4);
  const depth = ihdr[8];
  const colorType = ihdr[9];
  const compression = ihdr[10];
  const filter = ihdr[11];
  const interlace = ihdr[12];
  if (compression !== 0 || filter !== 0) throw new Error('decodePNG: unsupported compression/filter method');
  if (interlace !== 0) throw new Error('decodePNG: interlaced PNG unsupported');
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`decodePNG: bad colour type ${colorType}`);
  // The depths the spec allows per colour type. Palette may not be 16-bit, and 1/2/4 only
  // exist for gray and palette; anything else is a corrupt header, not a scanner variant.
  const allowedDepths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] }[colorType];
  if (!allowedDepths.includes(depth)) {
    throw new Error(`decodePNG: bit depth ${depth} is not valid for colour type ${colorType}`);
  }
  const bitsPerPixel = depth * channels;
  const rowBytes = Math.ceil((width * bitsPerPixel) / 8);
  // PNG filters work on BYTES, and the byte offset used by Sub/Paeth is one whole pixel
  // rounded up to a byte -- 1 for every sub-byte depth, 2*channels for 16-bit.
  const bpp = Math.max(1, Math.ceil(bitsPerPixel / 8));

  const total = idat.reduce((a, c) => a + c.length, 0);
  const z = new Uint8Array(total);
  let so = 0;
  for (const c of idat) {
    z.set(c, so);
    so += c.length;
  }
  // zlib wrapper: 2 header bytes + raw deflate + 4-byte adler32 trailer
  if (z.length < 6) throw new Error('decodePNG: truncated IDAT');
  const cmf = z[0];
  if ((cmf & 0x0f) !== 8) throw new Error('decodePNG: unexpected zlib method');
  const raw = z.subarray(2, z.length - 4);
  const inflated = new Uint8Array(inflateRaw(raw, height * (1 + rowBytes)));

  const rows = new Uint8Array(height * rowBytes);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const f = inflated[pos++];
    const row = inflated.subarray(pos, pos + rowBytes);
    pos += rowBytes;
    const cur = rows.subarray(y * rowBytes, (y + 1) * rowBytes);
    const prev = y > 0 ? rows.subarray((y - 1) * rowBytes, y * rowBytes) : null;
    for (let x = 0; x < rowBytes; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const bb = prev ? prev[x] : 0;
      const c = prev && x >= bpp ? prev[x - bpp] : 0;
      let v;
      switch (f) {
        case 0: v = row[x]; break;
        case 1: v = row[x] + a; break;
        case 2: v = row[x] + bb; break;
        case 3: v = row[x] + ((a + bb) >> 1); break;
        case 4: v = row[x] + paeth(a, bb, c); break;
        default: throw new Error(`decodePNG: bad filter type ${f}`);
      }
      cur[x] = v & 255;
    }
  }

  // pHYs is 4-byte pixels-per-unit-x, 4-byte pixels-per-unit-y, then ONE byte of unit.
  // Reading the unit with u32() ran three bytes past the chunk, so the test was never true
  // and dpi was always null -- which silently disarmed decodePage's "is this really the
  // nominal canvas?" dpi guard (DEFECTS D81).
  let dpi = null;
  if (phy && phy.length >= 9 && phy[8] === 1) dpi = Math.round(u32(phy, 0) / 39.3701);

  // Palette: PLTE is mandatory for colour type 3, tRNS (if present) gives per-entry alpha.
  let paletteEntries = 0;
  if (colorType === 3) {
    if (!plte || plte.length < 3 || plte.length % 3 !== 0) throw new Error('decodePNG: palette PNG without a valid PLTE');
    paletteEntries = plte.length / 3;
  }

  /** One 8-bit sample (16-bit input keeps its high byte, which is what 8-bit consumers do). */
  const sampleAt = (y, x, ch) => {
    const base = y * rowBytes;
    if (depth === 16) return rows[base + x * channels * 2 + ch * 2];
    if (depth === 8) return rows[base + x * channels + ch];
    // Sub-byte depths only exist for gray and palette (channels === 1): MSB first.
    const perByte = 8 / depth;
    const byte = rows[base + ((x / perByte) | 0)];
    const shift = 8 - depth * ((x % perByte) + 1);
    return (byte >> shift) & ((1 << depth) - 1);
  };
  // Gray samples below 8 bits are scaled to the full range, per the PNG spec.
  const grayScale = depth >= 8 ? 1 : 255 / ((1 << depth) - 1);

  // normalise to RGBA so callers have exactly one shape to handle
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (colorType === 3) {
        const idx = sampleAt(y, x, 0);
        if (idx >= paletteEntries) throw new Error(`decodePNG: palette index ${idx} is out of range (${paletteEntries} entries)`);
        out[i] = plte[idx * 3];
        out[i + 1] = plte[idx * 3 + 1];
        out[i + 2] = plte[idx * 3 + 2];
        out[i + 3] = trns && idx < trns.length ? trns[idx] : 255;
      } else if (colorType === 0) {
        const g = sampleAt(y, x, 0) * grayScale;
        out[i] = g; out[i + 1] = g; out[i + 2] = g; out[i + 3] = 255;
      } else if (colorType === 4) {
        const g = sampleAt(y, x, 0);
        out[i] = g; out[i + 1] = g; out[i + 2] = g; out[i + 3] = sampleAt(y, x, 1);
      } else if (colorType === 2) {
        out[i] = sampleAt(y, x, 0); out[i + 1] = sampleAt(y, x, 1); out[i + 2] = sampleAt(y, x, 2); out[i + 3] = 255;
      } else {
        out[i] = sampleAt(y, x, 0); out[i + 1] = sampleAt(y, x, 1); out[i + 2] = sampleAt(y, x, 2); out[i + 3] = sampleAt(y, x, 3);
      }
    }
  }
  return { width, height, pixels: out, dpi };
}
