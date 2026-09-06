import { decodeHeader, HEADER_LEN } from '../frame.js';

/**
 * Read the frame header back out of the margin echo strip.
 *
 * The strip is a micro-lattice of 1-bit cells: a printed cell is a 1. Everything
 * the receiver needs before it can decode a page -- profile, nozzle, page index,
 * session -- comes from here, so this is the first thing that runs on a scanned
 * image and it must fail loudly rather than guess.
 */
export function readEcho(bitmap, layout, opts = {}) {
  const e = layout.echo;
  const sub = bitmap.substrate || [255, 255, 255];
  const { pixels, width } = bitmap;
  const bits = new Uint8Array(e.bits);
  const confidence = new Float32Array(e.bits);
  const samples = Math.max(1, opts.samples || 2);

  for (let i = 0; i < e.bits; i++) {
    const cx = i % e.cols;
    const cy = (i / e.cols) | 0;
    let dark = 0;
    let n = 0;
    for (let sy = 0; sy < samples; sy++) {
      for (let sx = 0; sx < samples; sx++) {
        const px = e.x + cx * e.cellPx + Math.floor(((sx + 0.5) * e.cellPx) / samples);
        const py = e.y + cy * e.cellPx + Math.floor(((sy + 0.5) * e.cellPx) / samples);
        if (px < 0 || py < 0 || px >= width || py * width >= pixels.length / 4) continue;
        const o = (py * width + px) * 4;
        const dr = pixels[o] - sub[0];
        const dg = pixels[o + 1] - sub[1];
        const db = pixels[o + 2] - sub[2];
        dark += dr * dr + dg * dg + db * db;
        n++;
      }
    }
    const d = n ? dark / n : 0;
    bits[i] = d > (opts.threshold ?? 6000) ? 1 : 0;
    confidence[i] = d;
  }

  const bytes = new Uint8Array(HEADER_LEN);
  for (let i = 0; i < e.bits; i++) bytes[i >> 3] |= bits[i] << (7 - (i & 7));
  const dec = decodeHeader(bytes);
  if (!dec.ok) {
    // report how close we were: a strip that is half-readable has a distinctive
    // confidence profile, and "which bit was wrong" is the first question on site
    const sorted = Array.from(confidence).sort((a, b) => a - b);
    const mid = sorted[sorted.length >> 1];
    return { ok: false, reason: dec.reason, headerBytes: bytes, ambiguousAbove: sorted.filter((v) => v > mid * 0.35 && v < mid * 3).length };
  }
  return { ok: true, headerBytes: bytes, header: dec.header, confidence };
}
