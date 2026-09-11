
/**
 * PSKT decode -- corner marker detection.
 *
 * The page carries four square markers: three solid and one hollow at bottom
 * right, which fixes orientation as well as position. Detection is deliberately
 * independent of scale: a phone photo of a plate has no notion of dpi, so the
 * markers are found by *shape* (square, high fill ratio, similar size to each
 * other) and the page scale is then derived from their spacing.
 *
 * Stages: ink mask -> connected components -> square filter -> size cluster ->
 * rectangle validation with the hollow one at bottom right.
 */

/** Per-pixel "how much ink" against the substrate, 0..255-ish. */
export function inkness(bitmap) {
  const { pixels, width, height } = bitmap;
  const sub = bitmap.substrate || [255, 255, 255];
  const out = new Float64Array(width * height);
  let max = 0;
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    const dr = pixels[p] - sub[0];
    const dg = pixels[p + 1] - sub[1];
    const db = pixels[p + 2] - sub[2];
    // luminance-weighted: a dark plate under red ink still reads as ink
    const v = Math.sqrt(dr * dr * 0.3 + dg * dg * 0.59 + db * db * 0.11);
    out[i] = v;
    if (v > max) max = v;
  }
  return { values: out, max };
}

/**
 * Global Otsu threshold on the inkness channel.
 * Returns 0 when the image has no ink at all (blank scan), so callers can fail
 * loudly instead of detecting nothing and reporting "not found".
 */
export function otsu(ink, samples = 40000) {
  const hist = new Uint32Array(64);
  const step = Math.max(1, Math.floor(ink.values.length / samples));
  let n = 0;
  let peak = 1;
  for (let i = 0; i < ink.values.length; i += step) {
    const v = ink.values[i];
    if (v > peak) peak = v;
    n++;
  }
  for (let i = 0; i < ink.values.length; i += step) {
    let bin = Math.floor((ink.values[i] / peak) * 63);
    if (bin < 0) bin = 0;
    else if (bin > 63) bin = 63;
    hist[bin]++;
  }
  let sum = 0;
  for (let b = 0; b < 64; b++) sum += b * hist[b];
  let sumB = 0;
  let wB = 0;
  let best = -1;
  let thr = 0;
  for (let b = 0; b < 64; b++) {
    wB += hist[b];
    if (wB === 0) continue;
    const wF = n - wB;
    if (wF === 0) break;
    sumB += b * hist[b];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) {
      best = between;
      thr = b;
    }
  }
  return (thr / 63) * peak;
}

/**
 * Median inkness as a fraction of the peak: how far the *typical* pixel sits from the substrate
 * relative to the most-inked pixel.
 *
 * This is the statistic that separates 「the marker is not here」 from 「this capture has no
 * ink/paper separation at all」, and it was chosen by measurement (round 79), not by taste:
 *
 *   pristine render            0.063     300 dpi scan            0.060
 *   pristine, cropped to code  0.063     blurred 4px at 300dpi   0.241
 *   phone-hard capture         0.668-0.793   phone40 capture     0.743
 *
 * Everything a healthy capture does stays at or below ~0.25, and every capture the phone-stress
 * channel produced sits at 0.67+. The cut is 0.5, in the gap. (The Otsu ink *fraction* was tried
 * first and rejected: a sharp page cropped to its code area reaches 0.560 and a scrambled image
 * reaches even higher, so that statistic fires on good captures -- measured.)
 */
function medianInknessRatio(ink, samples = 20000) {
  const v = ink && ink.values ? ink.values : ink;
  const max = ink && ink.max !== undefined ? ink.max : (v && v.length ? Math.max(...v) : 0);
  if (!v || !v.length || !(max > 0)) return 0;
  const step = Math.max(1, Math.floor(v.length / samples));
  const s = [];
  for (let i = 0; i < v.length; i += step) s.push(v[i]);
  s.sort((a, b) => a - b);
  return s[s.length >> 1] / max;
}

/**
 * Robust dynamic range of the inkness signal, independent of the assumed substrate.
 *
 * A blank white page is only blank relative to the ink/paper difference in the image itself.
 * Under the default INK2 palette the assumed paper is tinted ([246,242,234]), so a pure-white
 * scan is uniformly brighter than the substrate and every pixel binarises as ink. The p99-p1
 * range stays zero in that case, while a page with any real ink/paper separation has a large
 * range. p1/p99 rather than min/max prevent a handful of dust specks from turning a blank page
 * into a contrast diagnosis.
 */
function inkRangeRatio(ink, samples = 20000) {
  const v = ink && ink.values ? ink.values : ink;
  const max = ink && ink.max !== undefined ? ink.max : (v && v.length ? Math.max(...v) : 0);
  if (!v || v.length < 4 || !(max > 0)) return { p1: 0, p99: 0, range: 0, ratio: 0, tailRatio: 0 };
  const step = Math.max(1, Math.floor(v.length / samples));
  const s = [];
  for (let i = 0; i < v.length; i += step) s.push(v[i]);
  s.sort((a, b) => a - b);
  const p1 = s[Math.floor((s.length - 1) * 0.01)];
  const p99 = s[Math.ceil((s.length - 1) * 0.99)];
  const range = p99 - p1;
  const tail = max - p99;
  return { p1, p99, range, ratio: range / max, tailRatio: tail / max };
}

/** Above this range ratio a capture has usable ink/paper dynamics; see inkRangeRatio. */
const BLANK_INK_RANGE_RATIO = 0.02;

/** Above this ratio the capture has no usable ink/paper separation (see medianInknessRatio). */
export const FLAT_CAPTURE_RATIO = 0.5;

/** Fraction of the image that binarises as ink -- reported alongside the ratio, never a cut. */
function inkFraction(bin) {
  const n = (bin.width || 0) * (bin.height || 0);
  return n > 0 ? bin.inkCount / n : 0;
}

/** Binary ink mask from an image. */
export function binarize(bitmap, opts = {}) {
  const ink = inkness(bitmap);
  const thr = opts.threshold ?? otsu(ink);
  const { width, height } = bitmap;
  const mask = new Uint8Array(width * height);
  let count = 0;
  for (let i = 0; i < mask.length; i++) {
    if (ink.values[i] > thr) {
      mask[i] = 1;
      count++;
    }
  }
  return { mask, width, height, threshold: thr, inkness: ink, inkCount: count };
}

/**
 * 8-connected components with bbox, area and a "has hole" probe.
 * Iterative flood fill (no recursion): a scanned page can produce components of
 * hundreds of thousands of pixels and recursion would blow the stack.
 */
export function components(bin) {
  const { mask, width, height } = bin;
  const seen = new Uint8Array(mask.length);
  const stack = new Int32Array(mask.length);
  const out = [];
  const minArea = Math.max(9, bin.minArea || 9);
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    let sp = 0;
    stack[sp++] = start;
    seen[start] = 1;
    let x0 = width;
    let y0 = height;
    let x1 = 0;
    let y1 = 0;
    let area = 0;
    while (sp > 0) {
      const p = stack[--sp];
      const py = (p / width) | 0;
      const px = p - py * width;
      area++;
      if (px < x0) x0 = px;
      if (py < y0) y0 = py;
      if (px > x1) x1 = px;
      if (py > y1) y1 = py;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = py + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = px + dx;
          if (nx < 0 || nx >= width) continue;
          const q = ny * width + nx;
          if (mask[q] && !seen[q]) {
            seen[q] = 1;
            stack[sp++] = q;
          }
        }
      }
    }
    if (area < minArea) continue;
    const bw = x1 - x0 + 1;
    const bh = y1 - y0 + 1;
    out.push({
      area,
      seed: start,
      x0,
      y0,
      x1,
      y1,
      w: bw,
      h: bh,
      cx: (x0 + x1 + 1) / 2,
      cy: (y0 + y1 + 1) / 2,
      fill: area / (bw * bh),
      aspect: bw / bh,
    });
  }
  return out;
}

/** True when the centre of the bbox is background while the ring around it is ink. */
function hasHole(comp, bin) {
  const { mask, width } = bin;
  // Sample at floor((x0+x1)/2) rather than the comp.cx/cy that components() reports. Those
  // are also bounding-box centres (cx = (x0+x1+1)/2, line ~150), but rounded up for odd
  // widths -- so on a 15 px marker the two conventions differ by exactly one pixel. That
  // single pixel decides this test: measured on a clean shrinking page
  // (tools/probe-marker-scale.mjs --explain), at a 15 px marker with probe radius 2 the
  // rounded convention reads 0.36 ink against a 0.35 cut-off -- "solid", no hollow corner,
  // page refused -- while the floored centre reads 0.00 at that scale and at every other
  // scale down to 75dpi-equivalent. The non-monotonicity of the old behaviour was this
  // boundary flipping depending on marker parity, not resolution. (An earlier draft of this
  // comment blamed centroid bias; comp.cx is not a centroid, so that story was wrong and is
  // replaced by the two readings above.) Solid markers still read 1.00 here at every scale,
  // so the criterion is not being loosened -- the sample point was simply off by one.
  const cx = Math.floor((comp.x0 + comp.x1) / 2);
  const cy = Math.floor((comp.y0 + comp.y1) / 2);
  // the hole is one data cell across, i.e. ~1/3 of the marker side, so the probe
  // must stay well inside that: 0.12 of the short edge, never the ring itself
  const probe = Math.max(1, Math.round(Math.min(comp.w, comp.h) * 0.12));
  let inside = 0;
  let total = 0;
  for (let dy = -probe; dy <= probe; dy++) {
    for (let dx = -probe; dx <= probe; dx++) {
      total++;
      if (mask[(cy + dy) * width + cx + dx]) inside++;
    }
  }
  return inside / total < 0.35;
}

/**
 * Locate the page itself by taking the largest *non-ink* region.
 *
 * A photo of a plate on a dark bed inverts the problem: everything outside the
 * page reads as ink, the page border becomes one giant blob, and the corner
 * markers merge into it. Cropping to the light region first removes that whole
 * class of failure, and on a scanner (where the frame is all paper) the region
 * is simply the whole image, so the crop costs nothing.
 */
export function pageRegion(bin) {
  const { mask, width, height } = bin;
  const light = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) light[i] = mask[i] ? 0 : 1;
  const comps = components({ mask: light, width, height, minArea: Math.max(64, (width * height) / 400) });
  if (!comps.length) return { x0: 0, y0: 0, x1: width - 1, y1: height - 1, cropped: false, pixels: null };
  let best = comps[0];
  for (const c of comps) if (c.area > best.area) best = c;
  if (best.area < width * height * 0.08) return { x0: 0, y0: 0, x1: width - 1, y1: height - 1, cropped: false, pixels: null };
  return { x0: best.x0, y0: best.y0, x1: best.x1, y1: best.y1, cropped: true, area: best.area, pixels: null };
}

/**
 * Keep only the ink inside the page's own bounding box, so the photo background
 * cannot form one huge blob.
 *
 * The box is then pulled in by a hair: resampling a rotated page against a dark
 * backdrop leaves a couple of pixels of dark *rim* along the paper edge, and that
 * rim is what glues a corner marker to a background wedge and ruins its aspect
 * ratio. The inset stays far below the ~one-cell clearance between the paper
 * edge and the markers, so it removes the rim without touching them.
 */
export function cropMask(bin, region) {
  const { mask, width, height } = bin;
  if (!region.cropped) return mask;
  // The rim is a couple of pixels; the markers sit ONE CELL inside the paper edge,
  // which at 300 dpi is 10 px and does not grow with the page -- so an inset that
  // scales with page size eventually eats the outer 8 px of every fiducial, the
  // ring's hole merges with the outside, no candidate is hollow any more, and every
  // page is rejected as `no-hollow-corner`. That is what this line did (0.008 *
  // 2259 = 18 px on a 300 dpi sheet, 36 px at 600 dpi). Keep it a genuine rim trim
  // and let keepCandidateSquares' own border rule handle anything bigger.
  const inset = Math.max(2, Math.min(4, Math.round(0.002 * Math.min(region.x1 - region.x0, region.y1 - region.y0))));
  region.cropInset = inset;
  const x0 = Math.max(0, region.x0 + inset);
  const y0 = Math.max(0, region.y0 + inset);
  const x1 = Math.min(width - 1, region.x1 - inset);
  const y1 = Math.min(height - 1, region.y1 - inset);
  const out = new Uint8Array(mask.length);
  for (let y = y0; y <= y1; y++) {
    const row = y * width;
    for (let x = x0; x <= x1; x++) out[row + x] = mask[row + x];
  }
  return out;
}

/**
 * Drop structures that cannot be corner markers.
 *
 * Two things swallow a marker if left in: the background wedge that leaks into
 * the corners of a rotated page's bounding box (it always touches that box's
 * border and it is large), and the data lattice itself, which under real blur
 * bridges into one page-scale mesh. Markers are neither: they are a few percent
 * of the page area and sit inside it.
 */
export function keepCandidateSquares(comps, region) {
  const rw = region.x1 - region.x0 + 1;
  const rh = region.y1 - region.y0 + 1;
  const area = rw * rh;
  const out = [];
  for (const c of comps) {
    const rel = c.area / area;
    if (rel > 0.08) continue; // page-scale structure (mesh, border frame)
    if (c.w > 0.35 * rw || c.h > 0.35 * rh) continue; // spans the page in one axis
    const pad = (region.cropInset || 0) + 1;
    const touchesBorder = c.x0 <= region.x0 + pad || c.y0 <= region.y0 + pad || c.x1 >= region.x1 - pad || c.y1 >= region.y1 - pad;
    if (touchesBorder && rel > 0.01) continue; // a wedge, not a marker
    if (c.aspect < SQUARE_ASPECT || c.aspect > 1 / SQUARE_ASPECT) continue;
    if (c.fill < SQUARE_FILL) continue;
    out.push(c);
  }
  return out;
}

const SQUARE_ASPECT = 0.78;
const SQUARE_FILL = 0.5;

/**
 * Find the four corner markers.
 *
 * The threshold matters more than it should: at Otsu the faint antialias tail
 * between two adjacent rings counts as ink, the lattice becomes one mesh, and
 * the markers disappear inside it. Retrying at progressively stricter cut-offs
 * keeps only the dark cores, which is exactly what a real photo of a printed
 * plate needs too (ink is dense, bridging haze is not).
 *
 * @returns {{ok:boolean, quad?:{tl:{x:number,y:number},tr:{x:number,y:number},br:{x:number,y:number},bl:{x:number,y:number}}, markerPx?:number, candidates?:number, reason?:string, threshold?:number}}
 */
export function findMarkers(bitmap, opts = {}) {
  const base = binarize(bitmap, opts);
  if (base.inkCount < 32) return { ok: false, reason: 'blank-image', threshold: base.threshold };
  // A blank page can be brighter than an assumed tinted substrate, which makes inkCount huge.
  // Classify it from its own dynamic range before the threshold ladder turns "no ink at all"
  // into "the lens needs cleaning" (DEFECTS D83).
  const rangeInfo = inkRangeRatio(base.inkness);
  if (rangeInfo.ratio < BLANK_INK_RANGE_RATIO && rangeInfo.tailRatio < BLANK_INK_RANGE_RATIO) {
    return {
      ok: false,
      reason: 'blank-image',
      threshold: base.threshold,
      flatRangeRatio: rangeInfo.ratio,
      flatTailRatio: rangeInfo.tailRatio,
      inkRange: rangeInfo.range,
      note:
        `the image inkness range ${rangeInfo.range.toFixed(2)} is ${(rangeInfo.ratio * 100).toFixed(1)}% of its peak, ` +
        `and the top 1% of samples are only ${(rangeInfo.tailRatio * 100).toFixed(1)}% below that peak, so it is effectively uniform`,
    };
  }
  // The ladder used to be one-sided: 1, 1.35, 1.7, 2.1 -- it could only get
  // STRICTER. That is the right direction when a low threshold bridges the lattice
  // into a mesh, but it is the wrong direction when the capture leaves only the
  // cores of each stroke. At 600 dpi (20 px/cell) with a constant physical blur the
  // per-pixel peak coverage roughly halves, so Otsu keeps about a third of the ink
  // and a 60 px fiducial measures 30 px: `no-square-candidates`, and the whole
  // batch dies even though 600 dpi should be the *easier* channel. Trying looser
  // cuts first (after the standard one, so the most likely reading still wins the
  // race -- the first success returns immediately) covers both failure directions.
  const factors = opts.thresholds || [1, 0.85, 0.7, 0.55, 1.35, 1.7];
  const peak = base.inkness.max;
  // A stricter cut-off is only worth trying while some pixel can survive it. On a
  // real scan the inkness maximum is ~248 while Otsu sits near 140, so the factor
  // 2.1 attempt asked for a threshold of 296: zero ink, `blank-image`, and because
  // this loop used to return its LAST result, that starvation message overwrote
  // whatever the useful attempts had found -- telling a user "nothing was printed"
  // about a page that was merely hard to segment. Track the furthest attempt
  // instead, and let starvation disqualify an attempt rather than report it.
  const floor = Math.max(32, base.inkCount * 1e-4);
  let last = null;
  let best = null;
  let bestScore = -1;
  let starved = 0;
  for (const f of factors) {
    if (base.threshold * f >= peak) {
      starved++;
      continue;
    }
    const bin = f === 1 ? base : rethreshold(base, f);
    if (bin.inkCount < floor) {
      starved++;
      continue;
    }
    const r = detectIn(bin, opts);
    if (r.ok) return { ...r, thresholdFactor: f };
    last = { ...r, thresholdFactor: f };
    const score = progressScore(r);
    if (score > bestScore) {
      bestScore = score;
      best = last;
    }
  }
  // Before reporting the furthest attempt, check whether the picture was ever segmentable.
  // Measured (round 79, phone-stress channel): a flat or blown-out capture binarises 70.7% of its
  // pixels as ink, and every attempt then fails with no square candidates -- which the user reads
  // as 「the corners are not in the photo」 and answers by reframing, while the actual fix is
  // exposure/glare. The diagnosis is added only here, on the failure path: no page becomes
  // acceptable, the reason string just stops naming the wrong cause (DEFECTS D69).
  const ratio = medianInknessRatio(base.inkness);
  // The peak must be real ink: a uniform image has a median/peak ratio of 1 by arithmetic alone
  // (both are the same tiny number), and that case is already named by 'blank-image' above.
  if (base.inkness.max > 24 && ratio > FLAT_CAPTURE_RATIO) {
    const out = {
      ok: false,
      reason: 'no-contrast',
      flatRatio: ratio,
      inkFraction: inkFraction(base),
      threshold: base.threshold,
      note:
        `the typical pixel sits at ${(ratio * 100).toFixed(0)}% of the peak ink level (a healthy page is 6-25%): ` +
        'the ink and the paper were not separable in this capture, so a missing marker says nothing about the framing',
    };
    if (best) Object.assign(out, { furthest: best.reason, furthestDetail: best });
    return out;
  }
  if (best) return best;
  return last || { ok: false, reason: 'blank-image', threshold: base.threshold, note: `every threshold factor starved the page (peak ${peak.toFixed(1)}, otsu ${base.threshold.toFixed(1)}, ${starved} skipped)` };
}

/** How far an attempt got, so the report can name the most advanced failure. */
const FAILURE_RANK = {
  'blank-image': 0,
  'no-square-candidates': 1,
  'no-marker-size-cluster': 2,
  'too-few-candidates': 2,
  'quad-too-small-for-page-region': 3,
  'no-hollow-corner': 4,
  // Three markers forming a consistent rectangle whose fourth corner is not in the image is
  // as far along as finding four markers and failing to read one, so it shares the rank.
  'fourth-corner-out-of-frame': 4,
  'no-rectangular-quad': 5,
  'mirrored-image': 6,
  'homography-degenerate': 7,
  'quad-covers-little-of-the-photo': 8,
};

function reasonRank(r) {
  return FAILURE_RANK[r.reason] ?? 0;
}

function progressScore(r) {
  return reasonRank(r) * 1000 + (r.candidates ?? 0);
}

/**
 * Which of two failed cluster attempts should be the one reported.
 *
 * progressScore's tie-break adds candidate count, which is right for the threshold ladder in
 * findMarkers (more candidates at a looser threshold really is more progress) and wrong inside
 * detectIn, where the contest is between size clusters of one image: a 152-member data-cell
 * cluster then outranks the 4-member corner-marker cluster whenever both fail for the same
 * reason. Measured, not argued (docs/DEFECTS.md D37) -- the report carried maxBlobSide 5, a
 * number describing the print lattice, while the markers were 30 px, and a discriminator run
 * on that cluster is run on the lattice, where any three cells form a right angle. Four corners
 * means four markers, so among equal-rank failures prefer the largest anchor and then the
 * fewest members. Rank still dominates: a more advanced failure always wins.
 */
function betterFailure(a, b) {
  if (a.rank !== b.rank) return a.rank > b.rank;
  if (a.anchor !== b.anchor) return a.anchor > b.anchor;
  return a.members < b.members;
}

function rethreshold(base, factor) {
  const thr = base.threshold * factor;
  const mask = new Uint8Array(base.mask.length);
  let count = 0;
  for (let i = 0; i < mask.length; i++) {
    if (base.inkness.values[i] > thr) {
      mask[i] = 1;
      count++;
    }
  }
  return { ...base, mask, threshold: thr, inkCount: count };
}

function detectIn(bin, opts) {
  if (bin.inkCount < 32) return { ok: false, reason: 'blank-image', threshold: bin.threshold };
  const region = pageRegion(bin);
  const page = { ...bin, mask: cropMask(bin, region) };
  const squares = keepCandidateSquares(components(page), region);
  if (squares.length < 4) {
    return { ok: false, reason: 'no-square-candidates', candidates: squares.length, threshold: bin.threshold };
  }
  // The four markers share one physical size, so a size cluster with at least four
  // members is a candidate for "the markers". It used to be enough to find the
  // *largest* such cluster and stop there, on the reasoning that the corner markers
  // are by construction the biggest isolated squares on the page. That premise is
  // false exactly when it matters: at a permissive threshold the anti-alias tail
  // bridges the data lattice into 300 px meshes (a pristine 300 dpi page binarises
  // to 41% ink when its true coverage is ~25%), those meshes pass the page-scale
  // filter, they sort ahead of the 30 px markers -- and the winner is a lattice
  // cluster in which no corner is hollow, so every real page was rejected as
  // `no-hollow-corner`. Try the clusters largest-first instead and let the
  // three-solid-one-hollow pattern decide, which is the only claim that actually
  // identifies the markers. Bounded because the search is per anchor.
  squares.sort((a, b) => b.w - a.w);
  const sizeTol = opts.sizeTol ?? 0.3;
  const maxClusters = opts.maxClusters ?? 16;
  const clusters = [];
  for (let i = 0; i < squares.length && clusters.length < maxClusters; i++) {
    const anchor = squares[i].w;
    // only the first member of each cluster starts a new anchor
    if (i > 0 && Math.abs(anchor - squares[i - 1].w) <= squares[i - 1].w * sizeTol) continue;
    const members = squares.filter((c) => Math.abs(c.w - anchor) <= anchor * sizeTol);
    // Three, not four: a photo that genuinely misses one corner shows three markers, and
    // requiring four made that case undiagnosable -- it fell through to a lattice cluster or
    // to `no-marker-size-cluster`, so the user was told "not four of the same size" about a
    // page they had simply not framed. buildQuad decides what three means; it never reports
    // success on three, so this widens diagnosis without widening acceptance.
    if (members.length >= 3) clusters.push({ anchor, members });
  }
  if (!clusters.length) {
    return { ok: false, reason: 'no-marker-size-cluster', candidates: squares.length, threshold: bin.threshold, sizes: squares.slice(0, 8).map((c) => c.w) };
  }
  let bestQuad = null;
  let bestKey = null;
  const tried = [];
  for (const cl of clusters) {
    const quad = buildQuad(cl.members, page, region);
    if (quad.ok) return { ...quad, candidates: squares.length, threshold: bin.threshold, clusterPx: cl.anchor };
    tried.push({ clusterPx: cl.anchor, members: cl.members.length, reason: quad.reason, hollowCount: quad.hollowCount ?? null });
    const key = { rank: reasonRank(quad), anchor: cl.anchor, members: cl.members.length };
    if (!bestKey || betterFailure(key, bestKey)) {
      bestKey = key;
      bestQuad = quad;
    }
  }
  return {
    ...bestQuad,
    candidates: squares.length,
    threshold: bin.threshold,
    clusterPx: bestKey ? bestKey.anchor : null,
    clusterMembers: bestKey ? bestKey.members : null,
    sizes: clusters.map((c) => c.anchor).slice(0, 8),
    clustersTried: tried,
  };
}

/**
 * Pick the four corner markers out of same-size candidates and label them.
 * Validation is geometric: the four centres must form a convex quad whose
 * opposite sides agree within tolerance, and exactly one corner must be hollow
 * at the bottom right of that ordering (which is what fixes rotation).
 */
function buildQuad(list, bin, region) {
  if (list.length < 3) return { ok: false, reason: 'too-few-candidates', need: 4, have: list.length };
  if (list.length === 3) {
    // Exactly three same-size squares and no fourth. Two operationally opposite situations
    // look like this from the inside: the sheet's fourth corner is not in the photo at all
    // (reframe it), or it is in the photo and the marker there cannot be read (clean it,
    // flip the plate, reprint). They are separated by geometry with no tolerance to tune:
    // three points forming a page-scale right angle imply the rectangle's fourth corner, and
    // whether that point lies inside the image is a bounds check.
    //
    // Note what this can and cannot fire on. For an axis-aligned page the implied corner is
    // always inside the bounding box of the three visible ones, so the bounds check only ever
    // trips under rotation or perspective -- which is exactly the hand-held phone case, and
    // exactly the case the round-33 attempt got wrong (docs/DEFECTS.md D36). That attempt
    // asked whether any blob sat near the implied corner, which is unanswerable in principle:
    // on a data lattice something always does, and off it nothing ever does, so the two
    // fixtures pulled the parameter in opposite directions. A bounds check has no parameter.
    const regionW = region ? region.x1 - region.x0 + 1 : bin.width;
    const regionH = region ? region.y1 - region.y0 + 1 : bin.height;
    const minSpan = 0.45 * Math.min(regionW, regionH);
    for (let i = 0; i < 3; i++) {
      const p = list[i];
      const u = list[(i + 1) % 3];
      const v = list[(i + 2) % 3];
      const ux = u.cx - p.cx;
      const uy = u.cy - p.cy;
      const vx = v.cx - p.cx;
      const vy = v.cy - p.cy;
      const lu = Math.hypot(ux, uy);
      const lv = Math.hypot(vx, vy);
      if (lu < minSpan || lv < minSpan) continue;
      if (Math.min(lu, lv) / Math.max(lu, lv) < 0.4) continue; // A4 0.71, Letter 0.77
      if (Math.abs((ux * vx + uy * vy) / (lu * lv)) > 0.25) continue; // about 15 deg of give
      const qx = p.cx + ux + vx;
      const qy = p.cy + uy + vy;
      const margin = 0.5 * Math.max(list[0].w, list[1].w, list[2].w);
      const outside = qx < -margin || qy < -margin || qx > bin.width + margin || qy > bin.height + margin;
      const blobArea = list.reduce((m, c) => (c.area > m ? c.area : m), 0);
      return {
        ok: false,
        reason: outside ? 'fourth-corner-out-of-frame' : 'no-hollow-corner',
        impliedCorner: { x: Math.round(qx), y: Math.round(qy) },
        hollowCount: list.filter((c) => hasHole(c, bin)).length,
        maxBlobSide: Math.round(Math.sqrt(blobArea) * 10) / 10,
        candidates: list.length,
      };
    }
    // Three same-size squares that are not a page-scale right angle: they are cells, echo
    // marks, or specks, and the honest complaint is that no rectangle was found.
    return { ok: false, reason: 'no-rectangular-quad', hollowCount: 0, candidates: list.length };
  }
  if (list.length < 4) return { ok: false, reason: 'too-few-candidates', need: 4, have: list.length };
  const ranked = list.slice().sort((a, b) => b.area - a.area).slice(0, 14);
  // Rectangularity is invariant under cyclic relabelling, so it cannot by itself
  // choose which of the four corners is "br" -- and the hollow corner is what
  // fixes rotation. Therefore the hollowness pattern has to gate the enumeration,
  // not merely validate its winner: a winner chosen on geometry alone can put a
  // solid block at br and report "hollow-corner-missing" over a perfectly good
  // set of markers.
  const hollow = new Set(ranked.filter((c) => hasHole(c, bin)));
  let bestScore = Infinity;
  let bestQuad = null;
  let bestMirror = Infinity;
  let bestMirrored = null;
  for (const tl of ranked) {
    if (hollow.has(tl)) continue;
    for (const tr of ranked) {
      if (tr === tl || hollow.has(tr)) continue;
      for (const br of ranked) {
        if (br === tl || br === tr || !hollow.has(br)) continue;
        for (const bl of ranked) {
          if (bl === tl || bl === tr || bl === br || hollow.has(bl)) continue;
          const q = evaluateQuad(tl, tr, br, bl);
          if (q.mirrored) {
            if (q.score < bestMirror) {
              bestMirror = q.score;
              bestMirrored = { tl, tr, br, bl };
            }
            continue;
          }
          if (q.score < bestScore) {
            bestScore = q.score;
            bestQuad = { tl, tr, br, bl, score: q.score };
          }
        }
      }
    }
  }
  if (!bestQuad || bestScore > 0.6) {
    if (bestMirrored && bestMirror <= 0.6) {
      // The only consistent labelling is the mirror image: the page is face down
      // (or the scan was flipped). Say so -- the fix is to turn the sheet over,
      // not to retake the photo.
      return { ok: false, reason: 'mirrored-image', score: bestMirror };
    }
    // Readings for whoever debugs a refusal, deliberately named so it cannot be mistaken for
    // a marker size. It is the largest blob of the cluster this failure was reported from,
    // and since D37 that cluster is chosen for being marker-like rather than for having the
    // most candidates: before that fix this read 5 px -- a data-lattice cell -- while the
    // corner markers were 30 px, which is why two rounds of D24/D26 analysis argued over a
    // "resolution floor" that turned out to be a one-pixel sampling bug in hasHole (closed
    // in round 30). Treat it as a description of what the binariser produced, nothing more;
    // no pixel floor may be derived from it.
    const maxBlobArea = ranked.reduce((m, c) => (c.area > m ? c.area : m), 0);
    const maxBlobSide = Math.round(Math.sqrt(maxBlobArea) * 10) / 10;
    // Four markers were found and they span a plausible rectangle, but none of them is hollow:
    // the orientation marker cannot be read (scuff, reflection, wrong face of a plate). The
    // operationally different case -- the fourth corner is not in the image at all -- is its
    // own reason now, decided in the three-marker branch above by a bounds check rather than
    // by guessing (docs/DEFECTS.md D36, docs/ACCEPTANCE.md defect #3).
    return {
      ok: false,
      reason: hollow.size === 0 ? 'no-hollow-corner' : 'no-rectangular-quad',
      score: bestScore,
      hollowCount: hollow.size,
      maxBlobSide,
      candidates: ranked.length,
    };
  }
  // Orientation is carried by the hollow corner; the enumeration above already
  // required exactly that pattern (hollow at br, solid at the other three).
  // The four markers sit near the page corners, so the quad they span must cover
  // most of the page region. Echo-strip blobs fail this immediately.
  if (region && region.cropped) {
    const quadArea = polyArea([bestQuad.tl, bestQuad.tr, bestQuad.br, bestQuad.bl]);
    const regionArea = (region.x1 - region.x0 + 1) * (region.y1 - region.y0 + 1);
    const cover = quadArea / regionArea;
    if (cover < 0.45) return { ok: false, reason: 'quad-too-small-for-page-region', cover };
  }
  return {
    ok: true,
    quad: {
      tl: { x: bestQuad.tl.cx, y: bestQuad.tl.cy },
      tr: { x: bestQuad.tr.cx, y: bestQuad.tr.cy },
      br: { x: bestQuad.br.cx, y: bestQuad.br.cy },
      bl: { x: bestQuad.bl.cx, y: bestQuad.bl.cy },
    },
    markerPx: (bestQuad.tl.w + bestQuad.tr.w + bestQuad.br.w + bestQuad.bl.w) / 4,
    geometry: { score: bestScore, cover: region && region.cropped ? polyArea([bestQuad.tl, bestQuad.tr, bestQuad.br, bestQuad.bl]) / ((region.x1 - region.x0 + 1) * (region.y1 - region.y0 + 1)) : null },
  };
}

/** Shoelace area of an ordered quad. */
function polyArea(q) {
  let a = 0;
  for (let i = 0; i < q.length; i++) {
    const p = q[i];
    const n = q[(i + 1) % q.length];
    a += p.cx * n.cy - n.cx * p.cy;
  }
  return Math.abs(a / 2);
}

/** Rectangularity score of an ordered quad: 0 = perfect rectangle. */
function evaluateQuad(tl, tr, br, bl) {
  const d = (a, b) => Math.hypot(a.cx - b.cx, a.cy - b.cy);
  const top = d(tl, tr);
  const bottom = d(bl, br);
  const left = d(tl, bl);
  const right = d(tr, br);
  if (Math.min(top, bottom, left, right) < 8) return { score: Infinity };
  const sideErr = (Math.abs(top - bottom) + Math.abs(left - right)) / (top + bottom + left + right);
  // diagonals of a parallelogram are equal; a perspective skew breaks this only
  // mildly, so the tolerance is generous but rejects scrambled labellings
  const d1 = d(tl, br);
  const d2 = d(tr, bl);
  const diagErr = Math.abs(d1 - d2) / Math.max(d1, d2);
  // the ordered walk must be convex and consistently oriented
  const turns = [
    [tl, tr, br],
    [tr, br, bl],
    [br, bl, tl],
    [bl, tl, tr],
  ].map(([a, b, c]) => (b.cx - a.cx) * (c.cy - b.cy) - (b.cy - a.cy) * (c.cx - b.cx));
  if (turns.some((t) => t === 0)) return { score: Infinity };
  const positive = turns.filter((t) => t > 0).length;
  // tl -> tr -> br -> bl turns *left-to-right then down* on the canvas, which in
  // image coordinates (y down) is a fixed sign. Equal signs alone are not enough:
  // the mirrored walk is equally convex and equally "hollow at br", and accepting
  // it labels the corners one rotation away from where they are.
  if (positive !== 4 && positive !== 0) return { score: Infinity };
  return { score: sideErr * 1.5 + diagErr, mirrored: positive === 0 };
}

