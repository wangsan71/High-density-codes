import { homographyFromQuad, apply, inv3, sampleBilinear } from './transform.js';

/**
 * PSKT decode -- page rectification.
 *
 * Once the four corner markers are located in the photo, one homography maps
 * the photo onto the canonical page canvas. Rectifying first means the cell
 * sampler is the *same code* as the ideal-path sampler: no second measurement
 * implementation to drift out of agreement with the renderer, which is the most
 * likely place for a "reads fine in tests, fails on a desk" bug to hide.
 */

/** Corner-marker centres in canonical canvas pixels, keyed by role. */
function canvasQuad(layout) {
  const out = {};
  for (const f of layout.fiducials) out[f.role] = { x: f.x, y: f.y };
  if (!(out.tl && out.tr && out.br && out.bl)) throw new RangeError('canvasQuad: layout has no fiducials');
  return out;
}

/**
 * Estimate the substrate colour (paper white / plate background) from the quiet
 * zone, which is empty by construction. Median per channel, so dust or a hair
 * crossing the margin cannot move it.
 */
function estimateSubstrate(scan, samples = 4000) {
  const { pixels, width, height } = scan;
  const r = [];
  const g = [];
  const b = [];
  const step = Math.max(1, Math.floor(samples / 160));
  const pick = (x, y) => {
    const o = (Math.round(y) * width + Math.round(x)) * 4;
    if (o + 3 >= pixels.length) return;
    r.push(pixels[o]);
    g.push(pixels[o + 1]);
    b.push(pixels[o + 2]);
  };
  const perSide = Math.max(8, (samples / 4) | 0);
  for (let i = 0; i < perSide; i++) {
    const t = i / (perSide - 1);
    pick(2 + t * (width - 4), 1);
    pick(2 + t * (width - 4), height - 2);
    pick(1, 2 + t * (height - 4));
    pick(width - 2, 2 + t * (height - 4));
  }
  const med = (a) => {
    if (!a.length) return 255;
    a.sort((x, y) => x - y);
    return a[a.length >> 1];
  };
  void step;
  return [med(r), med(g), med(b)];
}

/**
 * Warp a photo of a page onto the canonical canvas.
 * @param {object} scan {width,height,pixels} RGBA (substrate optional)
 * @param {object} layout pageLayout() result for the profile/dpi being decoded
 * @param {{tl,tr,br,bl}} quadPx marker centres in the photo
 * @param {object} opts {substrate, out}
 * @returns {{width,height,pixels,dpi:0,substrate:number[],H:number[][]}}
 */
export function rectifyPage(scan, layout, quadPx, opts = {}) {
  const cw = canvasQuad(layout);
  const src = [cw.tl, cw.tr, cw.br, cw.bl];
  const dst = [quadPx.tl, quadPx.tr, quadPx.br, quadPx.bl];
  const canvasToImage = homographyFromQuad(src, dst);
  if (!canvasToImage) return { ok: false, reason: 'homography-degenerate' };
  const imageToCanvas = inv3(canvasToImage);
  void imageToCanvas;
  const [m00, m01, m02] = canvasToImage[0];
  const [m10, m11, m12] = canvasToImage[1];
  const [m20, m21, m22] = canvasToImage[2];

  const width = layout.width;
  const height = layout.height;
  const pixels = opts.out || new Uint8Array(width * height * 4);
  const inside = { count: 0, outside: 0 };
  for (let y = 0; y < height; y++) {
    let rowOff = y * width * 4;
    for (let x = 0; x < width; x++) {
      const w = m20 * x + m21 * y + m22;
      const o = rowOff + x * 4;
      if (!Number.isFinite(w) || Math.abs(w) < 1e-9) {
        inside.outside++;
        continue;
      }
      const s = 1 / w;
      const sx = (m00 * x + m01 * y + m02) * s;
      const sy = (m10 * x + m11 * y + m12) * s;
      if (sx < -1 || sy < -1 || sx > scan.width || sy > scan.height) {
        inside.outside++;
        continue;
      }
      const v = sampleBilinear(scan.pixels, scan.width, scan.height, 4, sx, sy);
      pixels[o] = v.values[0];
      pixels[o + 1] = v.values[1];
      pixels[o + 2] = v.values[2];
      pixels[o + 3] = 255;
      inside.count++;
    }
  }
  if (inside.count < width * height * 0.5) {
    return { ok: false, reason: 'quad-covers-little-of-the-photo', inside };
  }
  return {
    ok: true,
    width,
    height,
    pixels,
    dpi: 0,
    // The substrate has to come from the *page*, never from the photo border: a
    // plate on a dark bed would otherwise be measured against black, which turns
    // the paper into ink and inverts every reading. The quiet zone is blank paper
    // by construction, so its bright mode is the reference white.
    substrate: opts.substrate || quietZoneSubstrate({ width, height, pixels }) || estimateSubstrate(scan),
    H: canvasToImage,
    coverage: inside.count / (width * height),
  };
}

/**
 * Reference white taken from the rectified page's own quiet zone.
 *
 * The band inside the outer edge is blank paper by contract (QUIET_CELLS cells,
 * of which the outermost are empty in every direction), so the brightest mode of
 * that band is the substrate -- measured through the same exposure, blur and
 * colour cast that the data cells went through, which is exactly why it beats a
 * global or border-based estimate.
 */
export function quietZoneSubstrate(img, bandFrac = 0.035) {
  const { width, height, pixels } = img;
  const bx = Math.max(2, Math.round(width * bandFrac));
  const by = Math.max(2, Math.round(height * bandFrac));
  const lum = [];
  const acc = [0, 0, 0];
  let n = 0;
  const push = (i) => {
    const l = 0.3 * pixels[i] + 0.59 * pixels[i + 1] + 0.11 * pixels[i + 2];
    lum.push({ l, i });
  };
  for (let y = 0; y < height; y++) {
    const edgeBand = y < by || y >= height - by;
    for (let x = 0; x < width; x++) {
      if (!edgeBand && !(x < bx || x >= width - bx)) continue;
      push((y * width + x) * 4);
    }
  }
  if (!lum.length) return null;
  lum.sort((a, b) => b.l - a.l);
  // the top quartile is unambiguously blank paper: ink and shadows cannot reach it
  const k = Math.max(8, Math.floor(lum.length / 4));
  for (let j = 0; j < k; j++) {
    const i = lum[j].i;
    acc[0] += pixels[i];
    acc[1] += pixels[i + 1];
    acc[2] += pixels[i + 2];
    n++;
  }
  return n ? [acc[0] / n, acc[1] / n, acc[2] / n] : null;
}

/**
 * Map a point in canonical canvas pixels back to the photo. Useful for pulling
 * extra samples (colour statistics, confidence maps) without re-solving.
 */
export function canvasToPhoto(H, x, y) {
  return apply(H, x, y);
}
