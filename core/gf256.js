/**
 * PSKT core — GF(2^8) arithmetic.
 *
 * Field: primitive polynomial 0x11D (x^8 + x^4 + x^3 + x^2 + 1), primitive element
 * α = 2. Same parameters as classic QR/Reed-Solomon practice, so results are
 * comparable with independent reference implementations.
 *
 * Polynomial convention used across this file:
 *   - "HF" = highest-degree-first  ([1, a, b]  ==  x^2 + a·x + b)
 *   - "LF" = lowest-degree-first   ([b, a, 1]  ==  b + a·x + x^2)
 * Encoder/synthetic-division code uses HF; locator / syndrome algebra uses LF.
 *
 * Zero dependency, synchronous, runs on Node >= 20 and in browsers (no WebCrypto).
 */

const GF_POLY = 0x11d;
export const GF_Q = 256; // field size
const GF_M = 255; // multiplicative group order
export const GF_PRIM = 2; // primitive element α

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);

{
  let x = 1;
  for (let i = 0; i < GF_M; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= GF_POLY;
  }
  for (let i = GF_M; i < 512; i++) EXP[i] = EXP[i - GF_M];
}

/** α^i for any integer i (negative allowed). */
export function exp(i) {
  i %= GF_M;
  if (i < 0) i += GF_M;
  return EXP[i];
}

/** discrete log base α of a nonzero byte; 0 is undefined and throws. */
export function log(a) {
  if (a === 0) throw new RangeError('gf.log(0) undefined');
  return LOG[a];
}

export function mul(a, b) {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

export function div(a, b) {
  if (b === 0) throw new RangeError('gf.div by zero');
  if (a === 0) return 0;
  return EXP[(LOG[a] + GF_M - LOG[b]) % GF_M];
}

/** a^n, n any integer (negative => inverse power). */
export function pow(a, n) {
  if (a === 0) return n === 0 ? 1 : 0;
  if (n < 0) return pow(inv(a), -n);
  return EXP[((LOG[a] * n) % GF_M + GF_M) % GF_M];
}

export function inv(a) {
  if (a === 0) throw new RangeError('gf.inv(0)');
  return EXP[GF_M - LOG[a]];
}

export const add = (a, b) => a ^ b;
export const sub = (a, b) => a ^ b;

/* ------------------------------------------------------------------ */
/* polynomial helpers                                                  */
/* ------------------------------------------------------------------ */

/** HF: multiply two polynomials given highest-degree-first. */
export function polyMulHF(a, b) {
  if (!a.length || !b.length) return [];
  const out = new Uint8Array(a.length + b.length - 1);
  for (let i = 0; i < a.length; i++) {
    const ai = a[i];
    if (ai === 0) continue;
    for (let j = 0; j < b.length; j++) out[i + j] ^= mul(ai, b[j]);
  }
  return out;
}

/** HF: evaluate polynomial at x (Horner). */
export function polyEvalHF(p, x) {
  let y = 0;
  for (let i = 0; i < p.length; i++) y = mul(y, x) ^ p[i];
  return y;
}

/** LF: multiply two polynomials given lowest-degree-first. */
export function polyMulLF(a, b) {
  if (!a.length || !b.length) return [];
  const out = new Uint8Array(a.length + b.length - 1);
  for (let i = 0; i < a.length; i++) {
    const ai = a[i];
    if (ai === 0) continue;
    for (let j = 0; j < b.length; j++) out[i + j] ^= mul(ai, b[j]);
  }
  return out;
}

/** LF: multiply, then truncate to the first n coefficients (mod x^n). */
export function polyMulModXnLF(a, b, n) {
  const out = new Uint8Array(n);
  for (let i = 0; i < a.length && i < n; i++) {
    const ai = a[i];
    if (ai === 0) continue;
    const maxj = Math.min(b.length, n - i);
    for (let j = 0; j < maxj; j++) out[i + j] ^= mul(ai, b[j]);
  }
  return out;
}

/** LF: evaluate polynomial at x (Horner from the top). */
export function polyEvalLF(p, x) {
  let y = 0;
  for (let i = p.length - 1; i >= 0; i--) y = mul(y, x) ^ p[i];
  return y;
}

/** LF: formal derivative (d/dx), lowest-degree-first. */
export function polyDerivLF(p) {
  const out = new Uint8Array(Math.max(0, p.length - 1));
  // in characteristic 2 only odd-degree terms survive; coefficient of x^i is (i+1 mod 2)*p[i+1]
  for (let i = 0; i + 1 < p.length; i++) {
    out[i] = (i + 1) & 1 ? p[i + 1] : 0;
  }
  return out;
}

/** LF: xor two polynomials (pad with zeros), returns trimmed of trailing zeros but keeps >=1 coef. */
export function polyXorLF(a, b) {
  const n = Math.max(a.length, b.length);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (a[i] || 0) ^ (b[i] || 0);
  return out;
}

/** LF: scale every coefficient by c. */
export function polyScaleLF(p, c) {
  const out = new Uint8Array(p.length);
  for (let i = 0; i < p.length; i++) out[i] = mul(p[i], c);
  return out;
}

/** LF: number of significant coefficients (drops trailing zeros, keeps at least 1). */
export function polyDegLF(p) {
  let n = p.length;
  while (n > 1 && p[n - 1] === 0) n--;
  return n;
}
