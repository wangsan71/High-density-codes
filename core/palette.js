/**
 * Ink palettes and illumination-robust colour classification.
 *
 * The protocol only ever carries *level indices*; the palette is a rendering
 * parameter that both ends must agree on (it is recorded in the print pack).
 * Nothing here is secret: swapping palettes is fine as long as the decoder is
 * told which one was used.
 *
 * Two rules drive the choice of colours:
 *  1. Levels are assigned in Gray order (see core/pack.js#toGray), so a
 *     neighbouring misclassification costs exactly one bit. The palette is
 *     therefore ordered so that *Gray-adjacent* pairs are far apart, not just
 *     consecutive ones.
 *  2. Classification must survive unknown lighting, so we compare a
 *     scale-invariant descriptor rather than raw RGB.
 */

export const BACKGROUND = [252, 252, 250]; // paper / unpunched plate substrate

function hex(h) {
  const v = h.replace('#', '');
  return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)];
}

/**
 * Named palettes. Index = the colour-channel *level value* (already Gray-decoded).
 * `inks` are printed colours; the substrate shows through where nothing is printed.
 */
export const PALETTES = {
  // Two-filament plate: black + red. A printer that only manages one of them
  // destroys the whole colour channel -- which is exactly what monoSafe:'full'
  // is designed to survive.
  INK2: {
    id: 'INK2',
    name: 'black + red (two-filament plate)',
    background: [246, 242, 234], // 'natural' PLA
    inks: [hex('#141414'), hex('#c8202c')],
  },
  // Four-filament plate / colour laser: cyan, magenta, yellow, key, ordered so
  // that the Gray-neighbour pairs (0,1),(1,3),(3,2) are all widely separated.
  INK4: {
    id: 'INK4',
    name: 'CMYK (four-filament plate or colour laser)',
    background: [252, 252, 250],
    inks: [hex('#0e9ec4'), hex('#c4168c'), hex('#e6d40c'), hex('#141414')],
  },
  // Grayscale paper: one ink, so the colour channel degenerates to one bit.
  PAPER1: {
    id: 'PAPER1',
    name: 'black toner only (paper)',
    background: [255, 255, 255],
    inks: [hex('#101010')],
  },
};

const PALETTE_IDS = Object.keys(PALETTES);

export function getPalette(id) {
  const p = PALETTES[id];
  if (!p) throw new RangeError(`unknown palette "${id}" (have: ${PALETTE_IDS.join(', ')})`);
  return p;
}

/** RGB of a colour level; level 0 of a 1-ink palette is the lightest ink. */
export function inkOf(palette, level) {
  const p = typeof palette === 'string' ? getPalette(palette) : palette;
  if (!p.inks.length) throw new Error('palette has no inks');
  return p.inks[level % p.inks.length];
}

/**
 * Scale-invariant colour descriptor: (l, r, b) where l is luminance in 0..1 and
 * r,b are opponent ratios in -1..1. Dividing by the sum makes the chromatic
 * part invariant to a *multiplicative* light-level change, which is the dominant
 * variation in phone photos of a page.
 */
export function describe(rgb) {
  const [R, G, B] = rgb;
  const sum = R + G + B;
  const l = sum / (3 * 255);
  if (sum < 24) return [0, 0, 0]; // crushed to black by exposure; chromaticity is noise
  return [l, (R - G) / sum, (B - Math.max(R, G)) / sum];
}

/**
 * Nearest ink for a sampled cell. `weights` tilt the comparison when a scanner
 * is known to blow out highlights (callers can raise the chroma weight).
 * @returns {{level:number, distance:number, ambiguous:boolean, runnerUp:number}}
 */
export function nearestLevel(rgb, palette, opts = {}) {
  const p = typeof palette === 'string' ? getPalette(palette) : palette;
  const wl = opts.wLum ?? 0.55;
  const wc = opts.wChroma ?? 1;
  const ambig = opts.ambiguousGap ?? 0.035;
  const d = describe(rgb);
  let best = -1;
  let bestD = Infinity;
  let second = Infinity;
  for (let i = 0; i < p.inks.length; i++) {
    const e = describe(p.inks[i]);
    const dl = (d[0] - e[0]) * wl;
    const dr = (d[1] - e[1]) * wc;
    const db = (d[2] - e[2]) * wc;
    const dist = Math.sqrt(dl * dl + dr * dr + db * db);
    if (dist < bestD) {
      second = bestD;
      bestD = dist;
      best = i;
    } else if (dist < second) {
      second = dist;
    }
  }
  return { level: best, distance: bestD, runnerUp: second, ambiguous: second - bestD < ambig };
}

/** True if a sampled cell is closer to the substrate than to any ink. */
export function isBackground(rgb, palette, opts = {}) {
  const p = typeof palette === 'string' ? getPalette(palette) : palette;
  const d = describe(rgb);
  const e = describe(p.background);
  const dist = Math.hypot((d[0] - e[0]) * 0.55, d[1] - e[1], d[2] - e[2]);
  return dist < (opts.backgroundGap ?? 0.05);
}
