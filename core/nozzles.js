/**
 * PSKT core — nozzle / extrusion-width model (docs/PLAN.md §3).
 *
 * Every printable feature is expressed in integer multiples of the extrusion
 * width (EW) for the chosen nozzle. This is what makes a sheet decodable after
 * someone else re-slices it: quantising to EW removes the random placement of
 * perimeter lines inside a cell, which would otherwise move the measured
 * on-area ratio ρ across the decision threshold.
 *
 * Channel cost in EW units (measured/adjusted through `pskit calibrate`):
 *   colour  : a whole cell is one solid patch of filament A or B -> 3 EW is the
 *             hard floor, 4 EW is the safe default.
 *   shape   : cell with an optional centre hole -> needs wall 1 EW + hole 2 EW
 *             + wall 1 EW = 4 EW for 2 levels; 5 EW for 4 levels.
 *   height  : 0.2 mm step; needs >= 3 EW laterally to survive a coarse nozzle.
 */

/** Nominal extrusion width per nozzle (mm) for round-0.4-style hot ends. */
export const NOZZLES = {
  '0.2': { id: '0.2', nozzleMm: 0.2, ewMm: 0.26, minEwPerCell: 3, note: 'fine features, slower, more clog-prone' },
  '0.4': { id: '0.4', nozzleMm: 0.4, ewMm: 0.45, minEwPerCell: 3, note: 'default', default: true },
  '0.6': { id: '0.6', nozzleMm: 0.6, ewMm: 0.7, minEwPerCell: 4, note: 'robust, fast, coarse' },
  '0.8': { id: '0.8', nozzleMm: 0.8, ewMm: 0.95, minEwPerCell: 4, note: 'very coarse, PL-G territory' },
};

export const NOZZLE_IDS = Object.keys(NOZZLES);

/**
 * Universal floor pitch (mm) used by profile PL-G: chosen so that even a 0.8 mm
 * nozzle (EW 0.95 mm) draws >= 3 EW per cell while a 0.2 mm nozzle wastes some
 * resolution. This is the "I do not know the receiver's printer" mode.
 */
export const UNIVERSAL_PITCH_MM = 3.0;

export function getNozzle(id) {
  const n = NOZZLES[String(id)];
  if (!n) throw new RangeError(`unknown nozzle "${id}" (choose one of ${NOZZLE_IDS.join(', ')})`);
  return n;
}

/** Nearest integer number of extrusion widths that is >= `mm`. */
function ewCountAtLeast(mm, ewMm) {
  const k = Math.ceil(round4(mm / ewMm) - 1e-9);
  return Math.max(1, k);
}

/** Round a cell pitch up to a whole number of EW, returning {mm, ew}. */
export function quantizePitch(mm, nozzleId) {
  const n = getNozzle(nozzleId);
  const ew = Math.max(n.minEwPerCell, ewCountAtLeast(mm, n.ewMm));
  return { mm: round4(ew * n.ewMm), ew, ewMm: n.ewMm };
}

/** Quantise an arbitrary feature size to a whole number of EW (>= 1 EW). */
export function quantizeFeature(mm, nozzleId) {
  const n = getNozzle(nozzleId);
  const ew = Math.max(1, ewCountAtLeast(mm, n.ewMm));
  return { mm: round4(ew * n.ewMm), ew, ewMm: n.ewMm };
}

/**
 * Cell pitch for a channel at a given nozzle.
 * @param {string} nozzleId  '0.2'|'0.4'|'0.6'|'0.8'
 * @param {'colour'|'shape'|'height'|'universal'} channel
 * @param {number} levels    shape-channel levels (2 or 4)
 */
export function pitchFor(nozzleId, channel, levels = 2) {
  const n = getNozzle(nozzleId);
  if (channel === 'universal') return { mm: UNIVERSAL_PITCH_MM, ew: ewCountAtLeast(UNIVERSAL_PITCH_MM, n.ewMm), ewMm: n.ewMm };
  let ew;
  if (channel === 'colour') ew = Math.max(n.minEwPerCell, levels >= 4 ? 5 : 4);
  else if (channel === 'shape') ew = levels >= 4 ? 5 : 4;
  else if (channel === 'height') ew = Math.max(3, n.minEwPerCell);
  else throw new RangeError('pitchFor: unknown channel ' + channel);
  ew = Math.max(ew, n.minEwPerCell);
  return { mm: round4(ew * n.ewMm), ew, ewMm: n.ewMm };
}

/** Glyph vocabulary that survives a given pitch (see docs/NOZZLES.md). */
export function glyphsFor(nozzleId, pitchMm) {
  const n = getNozzle(nozzleId);
  const ew = pitchMm / n.ewMm;
  if (ew >= 5.5) return ['dot', 'cross', 'ring', 'solid']; // 2 bits
  if (ew >= 4) return ['ring', 'solid']; // 1 bit
  return ['hole', 'solid']; // 1 bit, hole shrinks: only for >=3 EW with care
}

/** Inverse lookup: which nozzle would someone have to be using? (calibrate) */
export function nozzleFromExtrusionWidth(ewMm) {
  let best = null;
  let bestD = Infinity;
  for (const id of NOZZLE_IDS) {
    const d = Math.abs(NOZZLES[id].ewMm - ewMm);
    if (d < bestD) {
      bestD = d;
      best = id;
    }
  }
  return { id: best, delta: round4(bestD) };
}

const round4 = (x) => Math.round(x * 1e4) / 1e4;
