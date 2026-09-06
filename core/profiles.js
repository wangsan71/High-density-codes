/**
 * PSKT core — profile table, page geometry and unequal-protection ECC planning.
 *
 * A "profile" fixes: medium, printable sheet size, cell pitch, the channels each
 * cell carries, and how the two Reed-Solomon layers are budgeted. Everything the
 * renderer and decoder need is derived here so that both sides (and the Python
 * reference implementation) agree from the profile id alone.
 *
 * Unequal protection (docs/PLAN.md §2.2, the reason G7 can be guaranteed):
 *   - when a profile has a colour channel, the *colour* bits carry the payload and
 *     the *shape* bits carry Reed-Solomon parity of those payload bytes.
 *     Losing colour entirely = a burst of known-position erasures, which RS fixes
 *     as long as parity >= data (rate <= 1/2). That is "single-colour printing
 *     still works", by construction rather than by hope.
 *   - single-channel profiles take parity out of their own channel with RS(255,223).
 */

import { getNozzle, pitchFor, quantizePitch, UNIVERSAL_PITCH_MM } from './nozzles.js';

export const MEDIUM = { PAPER: 'paper', PLATE: 'plate' };

/** bits per level count */
export const bitsOfLevels = (levels) => {
  const b = Math.round(Math.log2(levels));
  if (1 << b !== levels) throw new RangeError('levels must be a power of two');
  return b;
};

export const PROFILES = {
  'P-M1-300': {
    id: 'P-M1-300', medium: MEDIUM.PAPER, dpi: 300, cellPx: 10,
    channels: [{ name: 'shape', levels: 2 }], intra: { k: 223, nsym: 32 },
    parityPct: 20, note: 'paper, most robust all-round profile',
  },
  'P-M1-600': {
    id: 'P-M1-600', medium: MEDIUM.PAPER, dpi: 600, cellPx: 10,
    channels: [{ name: 'shape', levels: 2 }], intra: { k: 223, nsym: 32 },
    parityPct: 20, note: 'paper at 600 dpi, the MB-scale workhorse',
  },
  'P-M2-600': {
    id: 'P-M2-600', medium: MEDIUM.PAPER, dpi: 600, cellPx: 10,
    channels: [{ name: 'shape', levels: 4 }], intra: { k: 223, nsym: 32 },
    parityPct: 20, note: 'paper 2 bits/cell (4 glyph levels); needs a good printer',
  },
  'P-C4-600': {
    id: 'P-C4-600', medium: MEDIUM.PAPER, dpi: 600, cellPx: 10,
    channels: [{ name: 'colour', levels: 2 }, { name: 'shape', levels: 2 }],
    intra: { k: 127, nsym: 127 }, parityPct: 20, monoRecoverable: true,
    note: 'colour laser paper, colour=data + shape=parity',
  },
  'PL-M1': {
    id: 'PL-M1', medium: MEDIUM.PLATE,
    channels: [{ name: 'shape', levels: 2 }], intra: { k: 223, nsym: 32 },
    parityPct: 20, note: 'single-colour plate, native',
  },
  'PL-D2': {
    id: 'PL-D2', medium: MEDIUM.PLATE,
    channels: [{ name: 'colour', levels: 2 }, { name: 'shape', levels: 2 }],
    intra: { k: 127, nsym: 127 }, parityPct: 20, monoRecoverable: true,
    note: 'two-filament plate: colour carries data, shape carries parity',
  },
  'PL-D3': {
    id: 'PL-D3', medium: MEDIUM.PLATE,
    channels: [{ name: 'colour', levels: 4 }, { name: 'shape', levels: 2 }],
    intra: { k: 85, nsym: 170 }, parityPct: 20, monoRecoverable: true,
    note: 'four-filament plate: 2 bits colour (data) + 1 bit shape (parity), rate 1/2',
  },
  'PL-G': {
    id: 'PL-G', medium: MEDIUM.PLATE, pitchMm: UNIVERSAL_PITCH_MM,
    channels: [{ name: 'shape', levels: 2 }], intra: { k: 127, nsym: 127 },
    parityPct: 33, note: 'universal floor: readable on any nozzle 0.2-0.8 and any phone',
  },
  'REL-H1': {
    id: 'REL-H1', medium: MEDIUM.PLATE,
    channels: [{ name: 'height', levels: 2 }], intra: { k: 223, nsym: 32 },
    parityPct: 20, note: 'relief only, decoded from shading (M10, optional)',
  },
};

export const PROFILE_IDS = Object.keys(PROFILES);
export const DEFAULT_PROFILE = 'PL-D2';

export function getProfile(id) {
  const p = PROFILES[id];
  if (!p) throw new RangeError(`unknown profile "${id}" (have: ${PROFILE_IDS.join(', ')})`);
  return p;
}

const SHEETS = {
  A4: { w: 210, h: 297 },
  LETTER: { w: 215.9, h: 279.4 },
};

/**
 * Build the concrete geometry for a print job.
 * @param {string} profileId
 * @param {object} opts {nozzle='0.4', sheet='A4', plateMm=200, marginMm, parityPct}
 */
export function planPage(profileId, opts = {}) {
  const p = getProfile(profileId);
  const nozzleId = p.medium === MEDIUM.PLATE ? (opts.nozzle || '0.4') : null;
  const parityPct = opts.parityPct ?? p.parityPct;

  let pitchMm;
  if (p.medium === MEDIUM.PAPER) {
    pitchMm = round4((p.cellPx / p.dpi) * 25.4);
  } else if (p.pitchMm) {
    // universal floor: still snapped to whole extrusion widths of the target nozzle
    pitchMm = quantizePitch(p.pitchMm, nozzleId).mm;
  } else {
    const maxLevels = Math.max(...p.channels.map((c) => c.levels));
    const base = p.channels.find((c) => c.name !== 'colour') || p.channels[0];
    pitchMm = pitchFor(nozzleId, base.name, base.name === 'colour' ? maxLevels : p.channels.length > 1 ? 2 : maxLevels).mm;
    pitchMm = quantizePitch(pitchMm, nozzleId).mm;
  }

  const sheet = p.medium === MEDIUM.PAPER ? SHEETS[opts.sheet || 'A4'] : { w: opts.plateMm || 200, h: opts.plateMm || 200 };
  const marginMm = opts.marginMm ?? (p.medium === MEDIUM.PAPER ? 9 : 6);
  const region = { w: sheet.w - 2 * marginMm, h: sheet.h - 2 * marginMm };
  if (region.w <= 0 || region.h <= 0) throw new RangeError('margin leaves no printable region');

  const cols = Math.floor(region.w / pitchMm);
  const rows = Math.floor(region.h / pitchMm);
  const totalCells = cols * rows;

  const channels = p.channels.map((c) => ({
    name: c.name,
    levels: c.levels,
    bits: bitsOfLevels(c.levels),
    cells: totalCells,
    bitCount: totalCells * bitsOfLevels(c.levels),
    byteCount: Math.floor((totalCells * bitsOfLevels(c.levels)) / 8),
  }));
  const bitsPerCell = channels.reduce((a, c) => a + c.bits, 0);
  const symbolBytes = Math.floor((totalCells * bitsPerCell) / 8);

  const ecc = planEcc(p, channels, parityPct);

  return {
    profile: p.id,
    profileDef: p,
    medium: p.medium,
    nozzle: nozzleId,
    dpi: p.dpi || null,
    sheetMm: sheet,
    marginMm,
    pitchMm,
    cols,
    rows,
    totalCells,
    bitsPerCell,
    channels,
    symbolBytes,
    ecc,
    regionCells: { cols, rows },
    // region top-left in mm (the data lattice origin), used by renderer + decoder
    originMm: { x: marginMm + round4((region.w - cols * pitchMm) / 2), y: marginMm + round4((region.h - rows * pitchMm) / 2) },
    notes: p.note,
  };
}

/**
 * Budget the two Reed-Solomon layers for a profile.
 * Returns {mode, intra:{k,nsym,blocks,dataBytes,parityBytes}, inter:{...}, netBytesPerPage}
 */
export function planEcc(p, channels, parityPct) {
  const byName = Object.fromEntries(channels.map((c) => [c.name, c]));
  const hasColour = !!byName.colour;

  if (p.monoRecoverable && hasColour) {
    const dataBytes = byName.colour.byteCount;
    const parityBytes = byName.shape.byteCount;
    if (parityBytes < dataBytes) {
      throw new RangeError(`profile ${p.id}: colour parity budget smaller than data (${parityBytes} < ${dataBytes})`);
    }
    let { k, nsym } = p.intra;
    if (nsym < k) nsym = k; // rate 1/2 so that losing the whole colour channel is recoverable
    if (k + nsym > 255) {
      k = 127;
      nsym = 127;
    }
    const blocks = Math.floor(Math.min(dataBytes / k, parityBytes / nsym));
    const useData = blocks * k;
    const useParity = blocks * nsym;
    return {
      mode: 'unequal',
      monoRecoverable: true,
      dataBytes: useData,
      parityBytes: useParity,
      wastedBytes: dataBytes + parityBytes - useData - useParity,
      rate: useData / (useData + useParity),
      intra: { k, nsym, blocks },
      inter: planInter(useData, parityPct),
      netBytesPerPage: useData,
    };
  }

  const only = channels.reduce((a, c) => ({ bytes: a.bytes + c.byteCount }), { bytes: 0 });
  const totalBytes = only.bytes;
  const { k, nsym } = p.intra;
  const blocks = Math.floor(totalBytes / (k + nsym));
  const useData = blocks * k;
  const useParity = blocks * nsym;
  return {
    mode: 'native',
    monoRecoverable: false,
    dataBytes: useData,
    parityBytes: useParity,
    wastedBytes: totalBytes - useData - useParity,
    rate: useData / (useData + useParity),
    intra: { k, nsym, blocks },
    inter: planInter(useData, parityPct),
    netBytesPerPage: useData,
  };
}

/** Inter-page MDS budget: parityPct% extra pages, n = k + p <= 255. */
export function planInter(dataBytesPerPage, parityPct) {
  const p = Math.max(2, Math.ceil((parityPct / 100) * 255 * 0.25));
  // choose the largest systematic n <= 255 with at least parityPct% parity
  const nsym = Math.max(2, Math.round((255 * parityPct) / (100 + parityPct)));
  const k = RS_MAX_K(nsym);
  return { nsym, k, maxDataPages: k, maxTotalPages: k + nsym, parityPct };
}
function RS_MAX_K(nsym) {
  return 255 - nsym;
}

/** How many pages a payload of `bytes` needs, including parity pages. */
export function planTransfer(profileId, opts, payloadBytes) {
  const geom = planPage(profileId, opts);
  const per = geom.ecc.netBytesPerPage;
  if (per <= 0) throw new RangeError(`profile ${profileId} has zero usable capacity`);
  const dataPages = Math.max(1, Math.ceil(payloadBytes / per));
  const { nsym } = geom.ecc.inter;
  const parityPages = Math.max(2, Math.ceil((dataPages * nsym) / geom.ecc.inter.k));
  const total = dataPages + parityPages;
  if (total > 255) throw new RangeError(`needs ${total} pages > 255 (inter-page RS limit): shrink payload or use a denser profile`);
  return { geom, payloadBytes, perPage: per, dataPages, parityPages, totalPages: total, netCapacityBytes: dataPages * per };
}

/** One-line density report used by the G-CAP assertion. */
export function densityReport(opts = {}) {
  const rowsOut = [];
  for (const id of PROFILE_IDS) {
    const p = PROFILES[id];
    for (const nozzle of p.medium === MEDIUM.PLATE ? ['0.2', '0.4', '0.6', '0.8'] : [null]) {
      try {
        const g = planPage(id, { ...opts, nozzle: nozzle || undefined });
        rowsOut.push({
          profile: id,
          nozzle: nozzle || '-',
          pitchMm: g.pitchMm,
          cols: g.cols,
          rows: g.rows,
          cells: g.totalCells,
          bitsPerCell: g.bitsPerCell,
          netPerPage: g.ecc.netBytesPerPage,
          rate: round4(g.ecc.rate),
          mode: g.ecc.mode,
        });
      } catch (e) {
        rowsOut.push({ profile: id, nozzle: nozzle || '-', error: e.message });
      }
    }
  }
  return rowsOut;
}

const round4 = (x) => Math.round(x * 1e4) / 1e4;

export function getNozzleSafe(id) {
  return getNozzle(id || '0.4');
}
