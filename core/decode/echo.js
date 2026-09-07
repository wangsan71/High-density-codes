import { decodeHeader, HEADER_LEN } from '../frame.js';
import { otsu } from './fiducial.js';

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
        dark += dr * dr + db * db + dg * dg;
        n++;
      }
    }
    confidence[i] = n ? dark / n : 0;
  }
  // The cut used to be a hard-coded `> 6000` in squared-RGB-distance units. That
  // survives a pristine render (dark ink is ~168 000 away from white) and dies on
  // any real capture, where exposure, white balance and paper tone move the whole
  // distribution: the strip decoded to the wrong bytes and `page.js` vetoed the
  // entire page over it -- the failure order seen on simulated scans
  // (echo-bad-magic/echo-header-crc while the RS-protected lattice under it read
  // fine). An Otsu cut alone is better but still one guess among many.
  //
  // So try the plausible cuts and let the strip's own CRC adjudicate. This is not
  // loosening acceptance: a candidate is only returned if decodeHeader accepts it,
  // which requires the right magic, version and CRC16 -- the same G5 guarantee as
  // before, now with a threshold that is chosen by evidence instead of by us.
  let thr = opts.threshold;
  const bytes = new Uint8Array(HEADER_LEN);
  if (thr != null) {
    for (let i = 0; i < e.bits; i++) bits[i] = confidence[i] > thr ? 1 : 0;
    for (let i = 0; i < e.bits; i++) bytes[i >> 3] |= bits[i] << (7 - (i & 7));
    const dec = decodeHeader(bytes);
    if (!dec.ok) return { ok: false, reason: dec.reason, headerBytes: bytes, ambiguousAbove: 0 };
    return { ok: true, headerBytes: bytes, header: dec.header, confidence, threshold: thr };
  }

  const sorted = Array.from(confidence).sort((a, b) => a - b);
  const cands = [otsu({ values: confidence })];
  // 6000 remains a candidate, not an assumption: it was tuned against the dark
  // matte plate path, where the substrate estimate compresses every distance and
  // an Otsu cut can land on the wrong side of the modes. With the CRC deciding,
  // keeping it costs one extra trial and recovers the plate geometry that the
  // old hard-coded cut could read.
  cands.push(6000);
  // Midpoints between consecutive samples, thinned to ~24 probes across the range
  // plus the Otsu neighbourhood: enough to cover a shifted distribution without
  // turning the CRC into a search target.
  const n = sorted.length;
  for (let k = 1; k < n; k += Math.max(1, Math.floor(n / 24))) {
    const mid = (sorted[k - 1] + sorted[k]) / 2;
    if (mid > 0) cands.push(mid);
  }
  for (const mult of [0.75, 0.9, 1.1, 1.3]) cands.push(cands[0] * mult);
  let closest = null;
  let closestDist = Infinity;
  const tried = new Set();
  for (const t of cands) {
    if (!Number.isFinite(t) || t <= 0) continue;
    const key = t.toFixed(1);
    if (tried.has(key)) continue;
    tried.add(key);
    bits.fill(0);
    for (let i = 0; i < e.bits; i++) bits[i] = confidence[i] > t ? 1 : 0;
    bytes.fill(0);
    for (let i = 0; i < e.bits; i++) bytes[i >> 3] |= bits[i] << (7 - (i & 7));
    const dec = decodeHeader(bytes);
    if (dec.ok) return { ok: true, headerBytes: bytes, header: dec.header, confidence, threshold: t, candidatesTried: tried.size };
    // keep the attempt that came closest to a valid header, for the error report
    let dist = 0;
    for (let i = 0; i < 4; i++) if (bytes[i] !== 0x50534b31 >> (8 * i)) dist++;
    if (dist < closestDist) {
      closestDist = dist;
      closest = { reason: dec.reason, headerBytes: bytes, threshold: t };
    }
  }
  const mid = sorted[n >> 1];
  return {
    ok: false,
    ...(closest || { reason: 'no-candidate', headerBytes: bytes }),
    confidence,
    ambiguousAbove: sorted.filter((v) => v > mid * 0.35 && v < mid * 3).length,
    candidatesTried: tried.size,
  };
}
