/**
 * core/image/color.js -- the colour half of the image codec (PLAN v5 P2b).
 *
 * Kept apart from jpegish.js on purpose: that layer moves coefficient blocks around and has no opinion
 * about colour, while this one is where the 4:2:0 trade is made and undone. The upsampling filter is the
 * "fancy" one libjpeg uses -- a triangle filter (3/4 and 1/4 weights) rather than nearest neighbour --
 * because the bench measured nearest neighbour costing 0.15-0.5 dB for free.
 *
 * Pure ESM, no dependencies, no node: builtins.
 */

/** BT.601 full-range, the transform JPEG uses. */
export function rgbToYCbCr(px, w, h) {
  const Y = new Float32Array(w * h);
  const cw = w >> 1;
  const ch = h >> 1;
  const Cb = new Float32Array(cw * ch);
  const Cr = new Float32Array(cw * ch);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      Y[y * w + x] = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    }
  }
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      let sb = 0;
      let sr = 0;
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const i = ((y * 2 + dy) * w + (x * 2 + dx)) * 4;
          const r = px[i];
          const g = px[i + 1];
          const b = px[i + 2];
          sb += 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
          sr += 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
        }
      }
      Cb[y * cw + x] = sb / 4;
      Cr[y * cw + x] = sr / 4;
    }
  }
  return { Y, Cb, Cr, cw, ch };
}

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

/**
 * Triangle-filter upsampling of one chroma plane from cw x ch to outW x outH, which is 2cw x 2ch for
 * every even-sized image. Odd sizes keep the last column/row by replication, which is what the
 * encoder-side box filter effectively saw anyway.
 */
export function upsampleChroma2x(plane, cw, ch, outW, outH, out = new Float32Array(outW * outH)) {
  const tmp = new Float32Array(outW * ch);
  for (let y = 0; y < ch; y++) {
    const row = y * cw;
    for (let x = 0; x < outW; x++) {
      const i = x >> 1;
      const c = plane[row + i];
      if (x & 1) {
        const nxt = i + 1 < cw ? plane[row + i + 1] : c;
        tmp[y * outW + x] = (3 * c + nxt) / 4;
      } else {
        const prv = i > 0 ? plane[row + i - 1] : c;
        tmp[y * outW + x] = (3 * c + prv) / 4;
      }
    }
  }
  for (let y = 0; y < outH; y++) {
    const j = y >> 1;
    for (let x = 0; x < outW; x++) {
      const c = tmp[j * outW + x];
      if (y & 1) {
        const nxt = j + 1 < ch ? tmp[(j + 1) * outW + x] : c;
        out[y * outW + x] = (3 * c + nxt) / 4;
      } else {
        const prv = j > 0 ? tmp[(j - 1) * outW + x] : c;
        out[y * outW + x] = (3 * c + prv) / 4;
      }
    }
  }
  return out;
}

/** YCbCr planes (chroma at whatever resolution the caller has) back to RGBA. */
export function yCbCrToRgb(Y, cb, cr, w, h, out = new Uint8Array(w * h * 4)) {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const yy = Y[y * w + x];
      const b = cb[y * w + x] - 128;
      const r = cr[y * w + x] - 128;
      const i = (y * w + x) * 4;
      out[i] = clamp255(yy + 1.402 * r);
      out[i + 1] = clamp255(yy - 0.344136 * b - 0.714136 * r);
      out[i + 2] = clamp255(yy + 1.772 * b);
      out[i + 3] = 255;
    }
  }
  return out;
}
