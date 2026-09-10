/**
 * core/image/dct.js -- 8x8 DCT, JPEG quantisation tables and a coefficient size model.
 *
 * PLAN v5 P2b, first brick. The decision measurement (STATUS round 127, oracle = a third-party JPEG)
 * said a lossy transform codec buys about sixteen times the pixels of our PNG path for the same page
 * budget, so a self-written one is required if photographs are the point. This file is the part that
 * decides *quality*: the transform and the quantiser. Entropy coding (Huffman) is the next brick and
 * is deliberately absent -- without it there is nothing to be wrong about yet.
 *
 * Everything here is pure and allocation-light, in the same style as the rest of core/: plain ESM,
 * no dependencies, no node: builtins, runs in Node and in a browser unchanged.
 */

/** cos((2x+1) u pi / 16) * (u == 0 ? 1/sqrt(2) : 1) / 2, precomputed once. */
const C = new Float64Array(64);
for (let u = 0; u < 8; u++) {
  const s = u === 0 ? Math.SQRT1_2 : 1;
  for (let x = 0; x < 8; x++) C[u * 8 + x] = s * Math.cos(((2 * x + 1) * u * Math.PI) / 16) * 0.5;
}

/** Standard JPEG luminance quantisation table (Annex K.1). */
export const QUANT_LUMA = new Uint8Array([
  16, 11, 10, 16, 24, 40, 51, 61,
  12, 12, 14, 19, 26, 58, 60, 55,
  14, 13, 16, 24, 40, 57, 69, 56,
  14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77,
  24, 35, 55, 64, 81, 104, 113, 92,
  49, 64, 78, 87, 103, 121, 120, 101,
  72, 92, 95, 98, 112, 100, 103, 99,
]);

/** Standard JPEG chrominance quantisation table (Annex K.1). */
export const QUANT_CHROMA = new Uint8Array([
  17, 18, 24, 47, 99, 99, 99, 99,
  18, 21, 26, 66, 99, 99, 99, 99,
  24, 26, 56, 99, 99, 99, 99, 99,
  47, 66, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
]);

/**
 * The scaling libjpeg uses for quality 1..100: below 50 the table is multiplied by 50/q, above it by
 * (100-q)/50 clipped at 100. Matching the convention matters because the oracle numbers in the ledger
 * were produced that way.
 */
export function qualityScale(quality) {
  const q = Math.min(100, Math.max(1, Math.round(quality)));
  return q < 50 ? 5000 / q : 200 - 2 * q;
}

/** Forward DCT of one 8x8 block of samples (128 = zero level, i.e. samples are already centred). */
export function fdct8x8(samples, out = new Float32Array(64)) {
  const tmp = new Float64Array(64);
  for (let y = 0; y < 8; y++) {
    for (let u = 0; u < 8; u++) {
      let s = 0;
      for (let x = 0; x < 8; x++) s += samples[y * 8 + x] * C[u * 8 + x];
      tmp[y * 8 + u] = s;
    }
  }
  for (let u = 0; u < 8; u++) {
    for (let v = 0; v < 8; v++) {
      let s = 0;
      for (let y = 0; y < 8; y++) s += tmp[y * 8 + u] * C[v * 8 + y];
      out[v * 8 + u] = s;
    }
  }
  return out;
}

/** Inverse DCT of one 8x8 coefficient block. */
export function idct8x8(coeffs, out = new Float32Array(64)) {
  const tmp = new Float64Array(64);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      let s = 0;
      for (let u = 0; u < 8; u++) s += C[u * 8 + x] * coeffs[y * 8 + u];
      tmp[y * 8 + x] = s;
    }
  }
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      let s = 0;
      for (let v = 0; v < 8; v++) s += C[v * 8 + y] * tmp[v * 8 + x];
      out[y * 8 + x] = s;
    }
  }
  return out;
}

/** Divide by the scaled quantisation table and round to integers (the only lossy step). */
export function quantise(coeffs, table, quality, out = new Int16Array(64)) {
  const scale = qualityScale(quality);
  for (let i = 0; i < 64; i++) {
    const step = Math.max(1, Math.round((table[i] * scale) / 100));
    out[i] = Math.round(coeffs[i] / step);
  }
  return out;
}

/** Undo quantise(). Kept separate so a reader can be written without duplicating the table maths. */
export function dequantise(quantised, table, quality, out = new Float32Array(64)) {
  const scale = qualityScale(quality);
  for (let i = 0; i < 64; i++) {
    const step = Math.max(1, Math.round((table[i] * scale) / 100));
    out[i] = quantised[i] * step;
  }
  return out;
}

/** Bits needed for the magnitude of a value, the size category JPEG codes. */
export function magnitudeBits(v) {
  let a = Math.abs(v);
  let n = 0;
  while (a >= 1) { a >>= 1; n++; }
  return n;
}

/**
 * A SIZE MODEL, not an encoder: rough bits for one block if it were Huffman coded the JPEG way --
 * one DC difference plus (run, size) per non-zero AC. It overestimates (it ignores the real Huffman
 * table's short codes), and it exists so a quality/factor choice can be compared with the oracle's
 * byte counts before an entropy coder exists.
 */
export function estimateBlockBits(quantised, prevDc = 0) {
  let bits = magnitudeBits(quantised[0] - prevDc) + 4;
  let run = 0;
  for (let i = 1; i < 64; i++) {
    const v = quantised[i];
    if (v === 0) { run++; continue; }
    while (run > 15) { bits += 4; run -= 16; }
    bits += 4 + magnitudeBits(v);
    run = 0;
  }
  if (run > 0) bits += 4;
  return bits;
}
