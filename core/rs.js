/**
 * PSKT core — Reed–Solomon over GF(2^8), systematic, joint error + erasure decoding.
 *
 * Conventions (see docs/PROTOCOL.md):
 *   codeword  = [ data (k symbols) | parity (nsym symbols) ], n = k + nsym <= 255
 *   position exponent of codeword index j is X_j = α^(n-1-j)  (shortening-safe:
 *   a length-n codeword is treated as the low-order part of a 255-symbol codeword
 *   whose leading symbols are zero, which yields exactly this exponent)
 *   fcr (first consecutive root) = 0, generator α = 2
 *   erasures are symbols whose positions are known but values are not; they are
 *   zeroed before syndrome computation and recovered by Forney.
 *
 * Correction condition: 2t + e <= nsym   (t unknown errors, e known erasures)
 *
 * Zero dependency.
 */

import {
  exp as gfExp,
  mul as gfMul,
  div as gfDiv,
  inv as gfInv,
  pow as gfPow,
  polyMulHF,
  polyEvalHF,
  polyMulLF,
  polyMulModXnLF,
  polyEvalLF,
  polyDerivLF,
  polyDegLF,
} from './gf256.js';

export const RS_MAX_N = 255;
export const RS_FCR = 0;

const genCache = new Map();

/** Monic generator polynomial, highest-degree-first, length nsym + 1. */
export function generatorPoly(nsym) {
  if (nsym < 2 || nsym > 200) throw new RangeError('rs: nsym out of range');
  let g = genCache.get(nsym);
  if (!g) {
    g = new Uint8Array([1]);
    for (let i = 0; i < nsym; i++) g = polyMulHF(g, new Uint8Array([1, gfExp(i)]));
    genCache.set(nsym, g);
  }
  return g;
}

/**
 * Systematic encode: returns Uint8Array(data.length + nsym) whose first
 * data.length bytes are an exact copy of `data`.
 */
export function rsEncode(data, nsym) {
  if (data.length + nsym > RS_MAX_N) {
    throw new RangeError(`rs: shortened block too long (${data.length}+${nsym}>255)`);
  }
  const g = generatorPoly(nsym);
  const out = new Uint8Array(data.length + nsym);
  out.set(data, 0);
  for (let i = 0; i < data.length; i++) {
    const coef = out[i];
    if (coef === 0) continue;
    for (let j = 1; j < g.length; j++) out[i + j] ^= gfMul(g[j], coef);
  }
  out.set(data, 0); // synthetic division left data untouched; make it explicit
  return out;
}

/** Compute the nsym syndromes of a (possibly erased-zeroed) codeword. */
export function rsSyndromes(cw, nsym, fcr = RS_FCR) {
  const s = new Uint8Array(nsym);
  let nonzero = false;
  for (let k = 0; k < nsym; k++) {
    const v = polyEvalHF(cw, gfExp(k + fcr));
    s[k] = v;
    if (v !== 0) nonzero = true;
  }
  return { s, nonzero };
}

/** Erasure locator Λ_e(x) = Π (1 + X_j x), lowest-degree-first (Λ[0] === 1). */
function erasureLocator(erasures, n) {
  let lam = new Uint8Array([1]);
  for (const j of erasures) {
    const xj = gfExp(n - 1 - j);
    // (1 - X x) == (1 + X x) in GF(2^m): lowest-degree-first coefficients [1, X]
    lam = polyMulLF(lam, new Uint8Array([1, xj]));
  }
  return lam;
}

/**
 * Classic Berlekamp-Massey on a plain syndrome sequence (lowest-degree-first).
 * Returns Λ(x) with Λ[0] === 1.
 */
function berlekampMassey(S) {
  let lam = new Uint8Array([1]);
  let b = new Uint8Array([1]);
  let L = 0;
  let m = 1;
  let bb = 1;
  for (let nn = 0; nn < S.length; nn++) {
    let d = S[nn];
    for (let i = 1; i <= L; i++) {
      const c = lam[i];
      if (c) d ^= gfMul(c, S[nn - i] || 0);
    }
    if (d === 0) {
      m++;
      continue;
    }
    const lamArr = lam;
    const ratio = gfDiv(d, bb);
    if (2 * L <= nn) {
      const scaledB = new Uint8Array(b.length);
      for (let i = 0; i < b.length; i++) scaledB[i] = gfMul(b[i], ratio);
      const size = Math.max(lamArr.length, scaledB.length + m);
      const next = new Uint8Array(size);
      next.set(lamArr, 0);
      for (let i = 0; i < scaledB.length; i++) next[i + m] ^= scaledB[i];
      b = lamArr;
      bb = d;
      L = nn + 1 - L;
      lam = next;
      m = 1;
    } else {
      const scaledB = new Uint8Array(b.length);
      for (let i = 0; i < b.length; i++) scaledB[i] = gfMul(b[i], ratio);
      const size = Math.max(lamArr.length, scaledB.length + m);
      const next = new Uint8Array(size);
      next.set(lamArr, 0);
      for (let i = 0; i < scaledB.length; i++) next[i + m] ^= scaledB[i];
      lam = next;
      m++;
    }
  }
  // normalise so the array is at least length L+1
  if (lam.length < L + 1) {
    const t = new Uint8Array(L + 1);
    t.set(lam, 0);
    lam = t;
  }
  return lam;
}

/**
 * Decode a codeword in place-safe fashion.
 * @param {Uint8Array} cw full codeword (data|parity), length n = k + nsym
 * @param {number} nsym number of parity symbols
 * @param {Iterable<number>} [erasures] indices in cw whose values are unknown
 * @param {{maxErasures?: number}} [opts]
 * @returns {{ok: boolean, cw: Uint8Array, k: number, n: number,
 *            erasures: number, errors: number, reason?: string,
 *            clean: boolean}}
 */
export function rsDecode(cw, nsym, erasures = [], opts = {}) {
  const n = cw.length;
  const k = n - nsym;
  if (k < 1) return { ok: false, cw, k, n, erasures: 0, errors: 0, clean: false, reason: 'short' };
  if (n > RS_MAX_N) return { ok: false, cw, k, n, erasures: 0, errors: 0, clean: false, reason: 'long' };

  const er = Array.from(new Set(erasures)).sort((a, b) => a - b);
  for (const j of er) {
    if (j < 0 || j >= n) return { ok: false, cw, k, n, erasures: er.length, errors: 0, clean: false, reason: 'erasure-oob' };
  }

  const recv = Uint8Array.from(cw);
  for (const j of er) recv[j] = 0;

  const { s: synd, nonzero } = rsSyndromes(recv, nsym);
  if (!nonzero && er.length === 0) {
    return { ok: true, cw: recv, k, n, erasures: 0, errors: 0, clean: true };
  }
  if (!nonzero && er.length > 0) {
    // every erased symbol is legitimately zero
    for (const j of er) recv[j] = 0;
    return { ok: true, cw: recv, k, n, erasures: er.length, errors: 0, clean: false };
  }

  const e = er.length;
  if (e > nsym) {
    return { ok: false, cw: recv, k, n, erasures: e, errors: 0, clean: false, reason: 'too-many-erasures' };
  }

  const lamE = erasureLocator(er, n);
  // V = S · Λ_e  mod x^nsym ; then BM on V[e .. ] (the first e coefficients are
  // contaminated by the unknown error-evaluator terms)
  const V = polyMulModXnLF(synd, lamE, nsym);
  const Vshift = V.subarray(Math.min(e, nsym));
  const lamErr = berlekampMassey(Vshift);
  const t = polyDegLF(lamErr) - 1;
  if (2 * t + e > nsym) {
    return { ok: false, cw: recv, k, n, erasures: e, errors: t, clean: false, reason: 'beyond-limit' };
  }

  const lam = polyMulLF(lamE, lamErr);
  const lamDeg = polyDegLF(lam) - 1;

  // Chien search over the actual codeword indices
  const pos = [];
  for (let j = 0; j < n; j++) {
    const xj = gfExp(n - 1 - j);
    if (polyEvalLF(lam, gfInv(xj)) === 0) pos.push(j);
  }
  if (pos.length !== lamDeg) {
    return { ok: false, cw: recv, k, n, erasures: e, errors: lamDeg, clean: false, reason: 'chien-mismatch' };
  }
  for (const j of er) {
    if (!pos.includes(j)) {
      return { ok: false, cw: recv, k, n, erasures: e, errors: lamDeg - e, clean: false, reason: 'erasure-not-in-locator' };
    }
  }

  // Ω = S · Λ mod x^nsym ; Forney
  const omega = polyMulModXnLF(synd, lam, nsym);
  const lamPrime = polyDerivLF(lam);
  const out = Uint8Array.from(recv);
  for (const j of pos) {
    const xj = gfExp(n - 1 - j);
    const xinv = gfInv(xj);
    const den = polyEvalLF(lamPrime, xinv);
    if (den === 0) {
      return { ok: false, cw: recv, k, n, erasures: e, errors: lamDeg - e, clean: false, reason: 'forney-den0' };
    }
    const num = polyEvalLF(omega, xinv);
    const mag = gfMul(gfPow(xj, 1 - RS_FCR), gfDiv(num, den));
    out[j] ^= mag;
  }

  const recheck = rsSyndromes(out, nsym);
  if (recheck.nonzero) {
    return { ok: false, cw: recv, k, n, erasures: e, errors: lamDeg - e, clean: false, reason: 'recheck-failed' };
  }
  return { ok: true, cw: out, k, n, erasures: e, errors: lamDeg - e, clean: false };
}

/** How many pure errors / pure erasures a given nsym can take. */
export function rsCapacity(nsym) {
  return { errors: nsym >> 1, erasures: nsym };
}

/**
 * Convenience: split a byte stream into fixed-size RS blocks and encode them,
 * returning the interleaved symbol stream (data of all blocks then parity of all
 * blocks kept per block: [blk0(k)|blk0(nsym)|blk1(k)|...]).
 */
export function rsEncodeBlocks(data, k, nsym) {
  const blockSize = k + nsym;
  const nblk = Math.ceil(data.length / k);
  const out = new Uint8Array(nblk * blockSize);
  for (let b = 0; b < nblk; b++) {
    const start = b * k;
    const chunk = new Uint8Array(k);
    const len = Math.min(k, data.length - start);
    chunk.set(data.subarray(start, start + len));
    const cw = rsEncode(chunk, nsym);
    out.set(cw, b * blockSize);
  }
  return { stream: out, nblk, blockSize };
}

/** Decode those blocks; erased positions are expressed in *block-local* index space. */
export function rsDecodeBlocks(stream, k, nsym, erasedGlobal = []) {
  const blockSize = k + nsym;
  const nblk = stream.length / blockSize;
  const out = new Uint8Array(nblk * k);
  const stats = { nblk, okBlocks: 0, failedBlocks: [], erasures: 0, errors: 0 };
  const perBlock = new Map();
  for (const g of erasedGlobal) {
    const b = Math.floor(g / blockSize);
    const j = g % blockSize;
    if (!perBlock.has(b)) perBlock.set(b, []);
    perBlock.get(b).push(j);
  }
  for (let b = 0; b < nblk; b++) {
    const cw = stream.subarray(b * blockSize, (b + 1) * blockSize);
    const r = rsDecode(cw, nsym, perBlock.get(b) || []);
    if (!r.ok) {
      stats.failedBlocks.push(b);
      continue;
    }
    stats.okBlocks++;
    stats.erasures += r.erasures;
    stats.errors += r.errors;
    out.set(r.cw.subarray(0, k), b * k);
  }
  stats.ok = stats.failedBlocks.length === 0;
  return { data: out, ...stats };
}
