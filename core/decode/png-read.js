import { inflateRaw } from '../deflate.js';

/**
 * Minimal PNG reader (8-bit RGB/RGBA/gray, non-interlaced, filters 0-4).
 *
 * This exists so `pskit receive` can read back exactly what `pskit send` wrote:
 * a real encoder/decoder pair, not an in-memory shortcut. It is deliberately
 * strict -- unknown chunks are skipped, but a chunk we cannot interpret throws
 * rather than returning a partially understood image.
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
  while (o + 8 <= b.length) {
    const len = u32(b, o);
    const type = String.fromCharCode(b[o + 4], b[o + 5], b[o + 6], b[o + 7]);
    const data = b.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') ihdr = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'pHYs') phy = data;
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
  if (depth !== 8) throw new Error(`decodePNG: bit depth ${depth} unsupported (need 8)`);
  if (compression !== 0 || filter !== 0) throw new Error('decodePNG: unsupported compression/filter method');
  if (interlace !== 0) throw new Error('decodePNG: interlaced PNG unsupported');
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`decodePNG: bad colour type ${colorType}`);
  if (colorType === 3) throw new Error('decodePNG: palette PNG unsupported (use RGB/RGBA)');

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
  const inflated = new Uint8Array(inflateRaw(raw, height * (1 + width * channels)));

  const stride = width * channels;
  const pixels = new Uint8Array(width * height * channels);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const f = inflated[pos++];
    const row = inflated.subarray(pos, pos + stride);
    pos += stride;
    const cur = pixels.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const bb = prev ? prev[x] : 0;
      const c = prev && x >= channels ? prev[x - channels] : 0;
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

  let dpi = null;
  if (phy && u32(phy, 8) === 1) dpi = Math.round(u32(phy, 0) / 39.3701);

  // normalise to RGBA so callers have exactly one shape to handle
  const out = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    if (channels === 4) {
      out[i * 4] = pixels[i * 4];
      out[i * 4 + 1] = pixels[i * 4 + 1];
      out[i * 4 + 2] = pixels[i * 4 + 2];
      out[i * 4 + 3] = pixels[i * 4 + 3];
    } else if (channels === 3) {
      out[i * 4] = pixels[i * 3];
      out[i * 4 + 1] = pixels[i * 3 + 1];
      out[i * 4 + 2] = pixels[i * 3 + 2];
      out[i * 4 + 3] = 255;
    } else if (channels === 1) {
      const g = colorType === 0 ? pixels[i] : 0;
      out[i * 4] = g;
      out[i * 4 + 1] = g;
      out[i * 4 + 2] = g;
      out[i * 4 + 3] = 255;
    } else {
      const g = pixels[i * 2];
      out[i * 4] = g;
      out[i * 4 + 1] = g;
      out[i * 4 + 2] = g;
      out[i * 4 + 3] = pixels[i * 2 + 1];
    }
  }
  return { width, height, pixels: out, dpi };
}
