import { sampleBilinear } from './transform.js';

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
  if (best) return best;
  return last || { ok: false, reason: 'blank-image', threshold: base.threshold, note: `every threshold factor starved the page (peak ${peak.toFixed(1)}, otsu ${base.threshold.toFixed(1)}, ${starved} skipped)` };
}

/** How far an attempt got, so the report can name the most advanced failure. */
function progressScore(r) {
  const rank = {
    'blank-image': 0,
    'no-square-candidates': 1,
    'no-marker-size-cluster': 2,
    'too-few-candidates': 2,
    'quad-too-small-for-page-region': 3,
    'no-hollow-corner': 4,
    'no-rectangular-quad': 5,
    'mirrored-image': 6,
    'homography-degenerate': 7,
    'quad-covers-little-of-the-photo': 8,
  };
  return (rank[r.reason] ?? 0) * 1000 + (r.candidates ?? 0);
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
    if (members.length >= 4) clusters.push({ anchor, members });
  }
  if (!clusters.length) {
    return { ok: false, reason: 'no-marker-size-cluster', candidates: squares.length, threshold: bin.threshold, sizes: squares.slice(0, 8).map((c) => c.w) };
  }
  let bestQuad = null;
  let bestScore = -1;
  const tried = [];
  for (const cl of clusters) {
    const quad = buildQuad(cl.members, page, region);
    if (quad.ok) return { ...quad, candidates: squares.length, threshold: bin.threshold, clusterPx: cl.anchor };
    tried.push({ clusterPx: cl.anchor, reason: quad.reason, hollowCount: quad.hollowCount ?? null });
    const score = progressScore(quad);
    if (score > bestScore) {
      bestScore = score;
      bestQuad = quad;
    }
  }
  return {
    ...bestQuad,
    candidates: squares.length,
    threshold: bin.threshold,
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
export function buildQuad(list, bin, region) {
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
    // Readings for whoever debugs a refusal, deliberately named so it cannot be mistaken
    // for a marker size. Historical measurement (docs/DEFECTS.md D24/D26, both closed): on a
    // shrinking synthetic page this tracked the largest blob, which can be a merged data
    // cluster rather than a corner marker -- it read 15 in one failing case and 9 in another.
    // So it is a diagnostic of what the binariser produced, nothing more, and no pixel floor
    // may be derived from it. The non-monotonicity it was recorded against turned out to be a
    // one-pixel sampling-point bug in hasHole (closed in round 30), not resolution.
    const maxBlobArea = ranked.reduce((m, c) => (c.area > m ? c.area : m), 0);
    const maxBlobSide = Math.round(Math.sqrt(maxBlobArea) * 10) / 10;
    // "No hollow corner" carries two operationally opposite cases: the sheet's fourth corner
    // is outside the photo (a framing problem -- move back), or the marker is present and its
    // hole cannot be read (a scuff, a reflection, a print defect). They need different advice
    // and one string cannot hold both (docs/ACCEPTANCE.md open defect #3). It still holds both
    // today, because the obvious separation was tried and refuted below; until a sound version
    // exists the advice entry for this reason speaks only to the second case, which is the one
    // it can honestly address.
    // Attempted and refuted by measurement, recorded here so nobody re-tries it blind
    // (docs/DEFECTS.md D36): the two operationally opposite cases behind `hollow.size === 0`
    // -- the fourth corner outside the photo, versus the marker present but its hole
    // unreadable -- cannot be separated by "find three same-size squares that form a
    // page-scale right angle, then look whether anything sits at the implied fourth corner".
    // On a real 300 dpi page with a 256-byte payload there are 159 square candidates, of
    // which the largest are merged data-cell blobs; the enumeration pool here is the top 14
    // by AREA, so genuine 30 px markers lose their slots to lattice clusters and a bogus
    // right angle gets built out of print noise -- its implied corner then sits nowhere near
    // the missing marker, and a page whose corner marker was present and solid was reported
    // as "out of frame". Switching the occupancy pool to all candidates pulls the other way
    // (more blobs near any given point, so the scuff case swallows the framing case), which
    // is what proves the approach rather than a parameter is wrong. A sound version has to
    // anchor the expected fourth position on the profile's own geometry (a predicted corner
    // from the three markers, checked against the layout the page declares), not on
    // arbitrary triples -- and it would need the failure path to carry the marker cluster
    // rather than a top-N area slice. Left as one reason until that exists.
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

/** Resample an arbitrary point of an image (used by the rectifier). */
export function sampleInk(bitmap, x, y) {
  const s = sampleBilinear(bitmap.pixels, bitmap.width, bitmap.height, 4, x, y);
  const sub = bitmap.substrate || [255, 255, 255];
  const dr = s.values[0] - sub[0];
  const dg = s.values[1] - sub[1];
  const db = s.values[2] - sub[2];
  return {
    rgb: [s.values[0], s.values[1], s.values[2]],
    inkness: Math.sqrt(dr * dr * 0.3 + dg * dg * 0.59 + db * db * 0.11),
    inside: s.inside,
  };
}
