/**
 * PSKT decode — projective geometry.
 *
 * A printed page is planar, so one homography maps the camera image to page
 * millimetres. Everything downstream (cell sampling, marker detection) is
 * expressed in page mm and never has to know where the phone was pointing.
 *
 * Pure functions, no dependencies, browser-compatible.
 */

/** @typedef {{a:number[]}} Mat3 */

/** Multiply two 3x3 row-major matrices. */
export function mul3(A, B) {
  const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      C[i][j] = A[i][0] * B[0][j] + A[i][1] * B[1][j] + A[i][2] * B[2][j];
    }
  }
  return C;
}

/** Invert a 3x3 matrix. Returns null when singular (degenerate quad). */
export function inv3(M) {
  const [
    [a, b, c],
    [d, e, f],
    [g, h, i],
  ] = M;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  const id = 1 / det;
  return [
    [A * id, (c * h - b * i) * id, (b * f - c * e) * id],
    [B * id, (a * i - c * g) * id, (c * d - a * f) * id],
    [C * id, (b * g - a * h) * id, (a * e - b * d) * id],
  ];
}

/** Apply a homography to a point. Returns null on the line at infinity. */
export function apply(M, x, y) {
  const w = M[2][0] * x + M[2][1] * y + M[2][2];
  if (!Number.isFinite(w) || Math.abs(w) < 1e-12) return null;
  const s = 1 / w;
  return {
    x: (M[0][0] * x + M[0][1] * y + M[0][2]) * s,
    y: (M[1][0] * x + M[1][1] * y + M[1][2]) * s,
  };
}

/**
 * Solve the homography mapping four source points to four destination points.
 * Classic Hartley DLT on exactly four correspondences (8 equations, 8 unknowns);
 * an n-point least-squares version can come later if we ever fit against more
 * than the four corner markers.
 *
 * Points are `{x, y}`; inputs must be in general position (no three collinear).
 * @returns {number[][]|null} row-major 3x3, or null if degenerate
 */
export function homographyFromQuad(src, dst) {
  if (src.length !== 4 || dst.length !== 4) throw new RangeError('homographyFromQuad needs 4 point pairs');
  // Normalise both sides first: unnormalised DLT on pixel coordinates (x ~ 4000)
  // loses too much float precision for an 8x8 solve.
  const ns = normalisePoints(src);
  const nd = normalisePoints(dst);
  const A = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = ns.pts[i];
    const { x: X, y: Y } = nd.pts[i];
    A.push([-x, -y, -1, 0, 0, 0, X * x, X * y, X]);
    A.push([0, 0, 0, -x, -y, -1, Y * x, Y * y, Y]);
  }
  const h = solveNullspace(A);
  if (!h) return null;
  const Hn = [
    [h[0], h[1], h[2]],
    [h[3], h[4], h[5]],
    [h[6], h[7], h[8]],
  ];
  // Denormalise. With T_src = ns.matrix and T_dst = nd.matrix,
  // T_dst·p_dst = Hn·T_src·p_src, so H = T_dst⁻¹ · Hn · T_src.
  const tdstInv = inv3(nd.matrix);
  if (!tdstInv) return null;
  const H = mul3(tdstInv, mul3(Hn, ns.matrix));
  // Never hand back an unverified projective fit: a degenerate quad (three
  // collinear corners, a marker the detector matched to the wrong blob) makes
  // the DLT rank-deficient and the "solution" maps the whole page onto a line.
  // Checking the residuals costs four point transforms and turns that into null.
  let diag = 0;
  for (let i = 0; i < 4; i++) diag = Math.max(diag, Math.hypot(dst[i].x - dst[(i + 2) % 4].x, dst[i].y - dst[(i + 2) % 4].y));
  if (!(diag > 0)) return null;
  for (let i = 0; i < 4; i++) {
    const p = apply(H, src[i].x, src[i].y);
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
    if (Math.hypot(p.x - dst[i].x, p.y - dst[i].y) > diag * 5e-3) return null;
  }
  return H;
}

function normalisePoints(pts) {
  let cx = 0;
  let cy = 0;
  for (const p of pts) {
    cx += p.x;
    cy += p.y;
  }
  cx /= pts.length;
  cy /= pts.length;
  let scale = 0;
  for (const p of pts) scale += Math.hypot(p.x - cx, p.y - cy);
  scale /= pts.length;
  const s = scale > 1e-9 ? Math.SQRT2 / scale : 1;
  const matrix = [
    [s, 0, -s * cx],
    [0, s, -s * cy],
    [0, 0, 1],
  ];
  return {
    pts: pts.map((p) => ({ x: s * (p.x - cx), y: s * (p.y - cy) })),
    matrix,
    inverse: [
      [1 / s, 0, cx],
      [0, 1 / s, cy],
      [0, 0, 1],
    ],
  };
}

/**
 * Smallest-singular-vector by iterated power iteration on AᵀA.
 * A is 8x9 here, so this is cheap and dependency-free; the 9th solution of a
 * full-rank-underdetermined system is what we want.
 */
function solveNullspace(A) {
  const n = 9;
  const AtA = Array.from({ length: n }, () => new Float64Array(n));
  for (const row of A) {
    for (let i = 0; i < n; i++) {
      if (row[i] === 0) continue;
      for (let j = 0; j < n; j++) AtA[i][j] += row[i] * row[j];
    }
  }
  // Shift so power iteration converges to the *smallest* eigenvector:
  // (σI − AᵀA) shares eigenvectors with AᵀA and flips the ordering.
  let sigma = 0;
  for (let i = 0; i < n; i++) sigma = Math.max(sigma, AtA[i][i]);
  sigma *= 1.000001;
  let v = new Float64Array(n).fill(1 / Math.sqrt(n));
  for (let iter = 0; iter < 400; iter++) {
    const w = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let acc = 0;
      for (let j = 0; j < n; j++) acc += (i === j ? sigma - AtA[i][j] : -AtA[i][j]) * v[j];
      w[i] = acc;
    }
    let norm = 0;
    for (let i = 0; i < n; i++) norm += w[i] * w[i];
    norm = Math.sqrt(norm);
    if (!(norm > 0)) return null;
    for (let i = 0; i < n; i++) w[i] /= norm;
    let delta = 0;
    for (let i = 0; i < n; i++) delta += Math.abs(w[i] - v[i]);
    v = w;
    if (delta < 1e-12) break;
  }
  const H = [v[0], v[1], v[2], v[3], v[4], v[5], v[6], v[7], v[8]];
  if (Math.abs(H[8]) < 1e-9) {
    // w-scale collapsed; rescale by the largest entry and hope the solve is fine
    const mx = Math.max(...H.map(Math.abs));
    if (!(mx > 0)) return null;
    for (let i = 0; i < 9; i++) H[i] /= mx;
  } else {
    for (let i = 0; i < 9; i++) H[i] /= H[8];
  }
  return H;
}

/**
 * Bilinear sample from an RGBA or single-channel row-major buffer.
 * `channels` is 4 for the render contract's RGBA buffers, 1 for grayscale.
 * Coordinate convention: texel *centres* are at integers, so (0,0) is the centre
 * of the first texel and (2.0,2.0) sits midway between texels 1 and 2.
 * Returns [r,g,b] (or [v]) plus an `inside` flag; out-of-bounds clamps.
 */
export function sampleBilinear(buf, width, height, channels, x, y) {
  const fx = Math.min(width - 1, Math.max(0, x));
  const fy = Math.min(height - 1, Math.max(0, y));
  const x0 = Math.min(width - 1, Math.floor(fx));
  const y0 = Math.min(height - 1, Math.floor(fy));
  const tx = fx - x0;
  const ty = fy - y0;
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const out = [];
  for (let c = 0; c < channels; c++) {
    const p00 = buf[(y0 * width + x0) * channels + c];
    const p10 = buf[(y0 * width + x1) * channels + c];
    const p01 = buf[(y1 * width + x0) * channels + c];
    const p11 = buf[(y1 * width + x1) * channels + c];
    out.push(p00 * (1 - tx) * (1 - ty) + p10 * tx * (1 - ty) + p01 * (1 - tx) * ty + p11 * tx * ty);
  }
  return {
    values: out,
    inside: x >= 0 && y >= 0 && x < width && y < height,
  };
}

