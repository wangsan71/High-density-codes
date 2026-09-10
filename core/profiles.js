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
import { QUIET_CELLS } from './render/constants.js';
import { minCellEwFor } from './render/glyphs.js';

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
  // RETIRED (round 109): the product owner cancelled the 3D plate line. Kept so already-printed
  // plates still decode and so the history stays readable; hidden from the CLI help and the web
  // picker. See docs/PLAN-V5.md section 3.
  'PL-M1': {
    id: 'PL-M1', retired: true, medium: MEDIUM.PLATE,
    channels: [{ name: 'shape', levels: 2 }], intra: { k: 223, nsym: 32 },
    parityPct: 20, note: 'single-colour plate, native',
  },
  // RETIRED (round 109): the product owner cancelled the 3D plate line. Kept so already-printed
  // plates still decode and so the history stays readable; hidden from the CLI help and the web
  // picker. See docs/PLAN-V5.md section 3.
  'PL-D2': {
    id: 'PL-D2', retired: true, medium: MEDIUM.PLATE,
    channels: [{ name: 'colour', levels: 2 }, { name: 'shape', levels: 2 }],
    intra: { k: 127, nsym: 127 }, parityPct: 20, monoRecoverable: true,
    note: 'two-filament plate: colour carries data, shape carries parity',
  },
  // RETIRED (round 109): the product owner cancelled the 3D plate line. Kept so already-printed
  // plates still decode and so the history stays readable; hidden from the CLI help and the web
  // picker. See docs/PLAN-V5.md section 3.
  'PL-D3': {
    id: 'PL-D3', retired: true, medium: MEDIUM.PLATE,
    channels: [{ name: 'colour', levels: 4 }, { name: 'shape', levels: 2 }],
    intra: { k: 223, nsym: 32 }, parityPct: 20, monoSafe: 'off',
    note: 'four-filament plate, 3 bits/cell, maximum density: needs all four colours present',
  },
  // RETIRED (round 109): the product owner cancelled the 3D plate line. Kept so already-printed
  // plates still decode and so the history stays readable; hidden from the CLI help and the web
  // picker. See docs/PLAN-V5.md section 3.
  'PL-D3S': {
    id: 'PL-D3S', retired: true, medium: MEDIUM.PLATE,
    channels: [{ name: 'colour', levels: 4 }, { name: 'shape', levels: 4 }],
    intra: { k: 85, nsym: 85 }, parityPct: 20, monoSafe: 'partial',
    note: 'four-filament with parity: 3 bits/cell, survives ~50% colour loss',
  },
  // RETIRED (round 109): the product owner cancelled the 3D plate line. Kept so already-printed
  // plates still decode and so the history stays readable; hidden from the CLI help and the web
  // picker. See docs/PLAN-V5.md section 3.
  'PL-G': {
    id: 'PL-G', retired: true, medium: MEDIUM.PLATE, pitchMm: UNIVERSAL_PITCH_MM,
    channels: [{ name: 'shape', levels: 2 }], intra: { k: 127, nsym: 127 },
    parityPct: 33, note: 'universal floor: readable on any nozzle 0.2-0.8 and any phone',
    /**
     * The one profile PLAN §2/§3 calls readable by any phone. Measured in round 80 through the
     * phone40 channel preset (a whole 200mm plate inside a 1600x1200 phone frame): 8/8 transfers
     * byte-exact, while the paper profile P-M1-300 -- whose cells land at ~2.7 px in the same
     * framing -- was 0/8. Surfaced in the sender's profile picker so the choice is made with the
     * measurement in view, and pinned by tests/unit/profile-picker-warning.test.mjs.
     */
    phoneSafe: true,
  },
  // RETIRED (round 109): the product owner cancelled the 3D plate line. Kept so already-printed
  // plates still decode and so the history stays readable; hidden from the CLI help and the web
  // picker. See docs/PLAN-V5.md section 3.
  'REL-H1': {
    id: 'REL-H1', retired: true, medium: MEDIUM.PLATE,
    channels: [{ name: 'height', levels: 2 }], intra: { k: 223, nsym: 32 },
    parityPct: 20, note: 'relief only, decoded from shading (M10, optional)',
  },
  // Appended after REL-H1, never inserted into the historical order: profileCode is the
  // position in this table and is burned into already-printed pages.
  'P-MX-300-6': {
    id: 'P-MX-300-6', medium: MEDIUM.PAPER, dpi: 300, cellPx: 6,
    physicalEncoding: 'module', quietCells: 12, echoMinPx: 8,
    channels: [{ name: 'shape', levels: 2 }], intra: { k: 223, nsym: 32 },
    parityPct: 20, experimental: true,
    note: 'binary solid-module matrix at 300 dpi; simulation 16/16, real scanner pending',
  },
  'P-MX-300-5': {
    id: 'P-MX-300-5', medium: MEDIUM.PAPER, dpi: 300, cellPx: 5,
    physicalEncoding: 'module', quietCells: 14, echoMinPx: 8, fidHalfPx: 20, fidRingPx: 10,
    channels: [{ name: 'shape', levels: 2 }], intra: { k: 223, nsym: 32 },
    parityPct: 20, experimental: true,
    note: 'binary solid-module matrix at 300 dpi; simulation 16/16, real scanner pending',
  },
  'P-MX-300-4': {
    id: 'P-MX-300-4', medium: MEDIUM.PAPER, dpi: 300, cellPx: 4,
    physicalEncoding: 'module', quietCells: 21, echoMinPx: 10, minCellPx: 4, fidHalfPx: 32, fidRingPx: 12,
    channels: [{ name: 'shape', levels: 2 }], intra: { k: 223, nsym: 32 },
    parityPct: 20, experimental: true,
    note: 'binary solid-module matrix at 300 dpi; simulation 16/16, real scanner pending',
  },
};

export const PROFILE_IDS = Object.keys(PROFILES);
export const DEFAULT_PROFILE = 'PL-D2';

/**
 * The sender's and receiver's profile dropdown labels, and the one predicate behind the warning.
 *
 * This lived in web/sender.js while only the sender rendered a dropdown. The receiver page builds
 * one too (web/app.js, for the case where auto-detection has to be told the profile), and it was
 * hand-rolling a label inline -- so the receiver silently lacked both the D49 warning and the
 * round-80 phone hint, and a user who picked a profile there chose without the same information.
 * Moved here (round 82) so there is one label policy, not two that can drift.
 *
 * G2 measured the paper side at 300 dpi as 200/200 byte-exact, and at 600 dpi as 162/200 with only
 * 43% of pages read directly (docs/DEFECTS.md D49, docs/ACCEPTANCE.md G2 section). The dropdown is
 * built from *every* profile in this table, so without a label a user can pick the unqualified one
 * and lose a file about one time in five -- and nothing warns them until the receiver names the
 * missing pages.
 *
 * The profile is deliberately NOT hidden: hiding it would quietly remove a capability, and today's
 * measurement may be superseded. When the 600 dpi side passes G2, delete this predicate and the
 * label suffix; tests/unit/profile-picker-warning.test.mjs pins both to the ledger so they cannot rot.
 */
export const isUnqualifiedPaper = (p) => !!p && p.medium !== 'plate' && (p.dpi || 0) >= 600;

/**
 * The dropdown label. Measured numbers stay in the ledger rather than in this string, so the UI
 * cannot go stale the way a hardcoded ratio would.
 */
export const profileOptionLabel = (id, p) =>
  `${id} · ${p.medium === 'plate' ? '实体盘' : '纸'}${p.dpi ? ` ${p.dpi}dpi` : ''}` +
  (isUnqualifiedPaper(p) ? ' · ⚠ 实测未达标 (D49)' : '') +
  (p.experimental ? ' · 新档·模拟16/16，真机待验' : '') +
  // Round 80: the phone40 channel measured PL-G at 8/8 byte-exact with a whole plate in one phone
  // frame, against 0/8 for the paper profile in the same framing. The hint repeats the profile's
  // own declared purpose (PLAN §2/§3) at the point where the choice is made.
  (p.phoneSafe ? ' · 手机拍摄首选' : '');


export function getProfile(id) {
  const p = PROFILES[id];
  if (!p) throw new RangeError(`unknown profile "${id}" (have: ${PROFILE_IDS.join(', ')})`);
  return p;
}

const SHEETS = {
  A4: { w: 210, h: 297 },
  // PLAN v5: the target is more data on less paper, so the smaller sheets are first-class. The
  // lattice is derived from the sheet inside planPage (region = sheet - 2*margin, minus the quiet
  // zone), so an A5 page simply carries fewer cells at the same pitch -- no new profile needed.
  A5: { w: 148, h: 210 },
  A6: { w: 105, h: 148 },
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

  // A glyph drawn finer than one extrusion width does not survive FDM, and the
  // ring-to-ring gap has to stay printable too. If the nominal pitch is too fine
  // for this profile's shape alphabet, the pitch is raised to the smallest whole
  // number of EW that works -- capacity drops, but the plate can actually be read.
  let pitchRaisedFrom = null;
  if (nozzleId && p.medium === MEDIUM.PLATE) {
    const shapeCh = p.channels.find((c) => c.name !== 'colour') || p.channels[0];
    const need = minCellEwFor(shapeCh.levels);
    const ew = getNozzle(nozzleId).ewMm;
    if (pitchMm / ew < need) {
      pitchRaisedFrom = pitchMm;
      pitchMm = round4(quantizePitch(need * ew, nozzleId).mm);
    }
  }

  const sheet = p.medium === MEDIUM.PAPER ? SHEETS[opts.sheet || 'A4'] : { w: opts.plateMm || 200, h: opts.plateMm || 200 };
  const marginMm = opts.marginMm ?? (p.medium === MEDIUM.PAPER ? 9 : 6);
  const region = { w: sheet.w - 2 * marginMm, h: sheet.h - 2 * marginMm };
  if (region.w <= 0 || region.h <= 0) throw new RangeError('margin leaves no printable region');

  const quietCells = Number.isInteger(p.quietCells) && p.quietCells > 0 ? p.quietCells : QUIET_CELLS;

  // The quiet zone and corner markers are printed *inside* the printable region, so
  // they come out of the cell budget. Fitting the lattice alone (as an earlier
  // revision did) produced pages that silently overflowed the plate.
  let cols = Math.floor(region.w / pitchMm) - 2 * quietCells;
  let rows = Math.floor(region.h / pitchMm) - 2 * quietCells;
  if (cols < 4 || rows < 4) {
    throw new RangeError(
      cols < 0 || rows < 0
        ? `profile ${p.id}: no room for a lattice in ${sheet.w}x${sheet.h}mm at ${pitchMm}mm pitch (the ${quietCells}-cell quiet zone alone fills it)`
        : `profile ${p.id}: only ${cols}x${rows} cells fit ${sheet.w}x${sheet.h}mm at ${pitchMm}mm pitch once the ${quietCells}-cell quiet zone is paid for`,
    );
  }
  const physicalCols = cols;
  const physicalRows = rows;
  if (p.physicalEncoding === 'module') {
    cols -= 1; // left timing column
    rows -= 1; // top timing row
    if (cols < 4 || rows < 4) {
      throw new RangeError(`profile ${p.id}: timing rows leave only ${cols}x${rows} data modules`);
    }
  }
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

  const ecc = planEcc(p, channels, parityPct, opts);

  return {
    profile: p.id,
    profileDef: p,
    medium: p.medium,
    nozzle: nozzleId,
    dpi: p.dpi || null,
    physicalEncoding: p.physicalEncoding ?? 'glyph',
    quietCells,
    sheetMm: sheet,
    marginMm,
    pitchMm,
    pitchRaisedFrom,
    echoMinPx: p.echoMinPx ?? null,
    minCellPx: p.minCellPx ?? null,
    fidHalfPx: p.fidHalfPx ?? null,
    fidRingPx: p.fidRingPx ?? null,
    cols,
    rows,
    moduleCols: p.physicalEncoding === 'module' ? physicalCols : null,
    moduleRows: p.physicalEncoding === 'module' ? physicalRows : null,
    totalCells,
    bitsPerCell,
    channels,
    symbolBytes,
    ecc,
    regionCells: { cols, rows },
    // region top-left in mm (the data lattice origin), used by renderer + decoder
    originMm: {
      x: marginMm + round4((region.w - physicalCols * pitchMm) / 2),
      y: marginMm + round4((region.h - physicalRows * pitchMm) / 2),
    },
    notes: p.note,
  };
}

/**
 * Budget the two Reed-Solomon layers for a profile.
 *
 * monoSafe (the capacity/robustness dial the user chooses):
 *   'full'    parity bytes >= colour bytes  -> a *totally* unreadable colour
 *             channel (single-colour print, empty spool, wrong filament) is still
 *             recovered, because those bytes are erasures at known positions.
 *   'partial' parity = half the colour bytes -> survives up to ~50% colour cell
 *             loss (glare, a smeared island) but not a whole-channel loss.
 *   'off'     data spans every channel with a standard light parity budget ->
 *             maximum density, no colour-loss protection at all.
 */
export function planEcc(p, channels, parityPct, opts = {}) {
  const byName = Object.fromEntries(channels.map((c) => [c.name, c]));
  const monoSafe = opts.monoSafe || p.monoSafe || (p.monoRecoverable ? 'full' : 'off');
  const colour = byName.colour;
  const secondary = byName.shape || byName.height;

  const nativeBudget = (total) => {
    // Fill every cell: pick the number of blocks first, then the largest (k, nsym)
    // that keeps the profile's parity ratio and the 255-symbol codeword limit.
    const ratio = p.intra.nsym / p.intra.k;
    const blocks = Math.max(1, Math.ceil(total / 255));
    let k = Math.floor(total / blocks / (1 + ratio));
    let nsym = Math.round(k * ratio);
    if (k + nsym > 255) nsym = 255 - k;
    if (blocks * (k + nsym) > total) {
      // rounding pushed us past the budget: drop one block worth of symbols
      k = Math.floor((total - (blocks - 1) * (k + nsym)) / (1 + ratio));
      nsym = Math.round(k * ratio);
    }
    const dataBytes = blocks * k;
    const parityBytes = blocks * nsym;
    return {
      mode: 'native',
      monoSafe: 'n/a', // no colour channel exists, so there is nothing to lose
      monoRecoverable: false,
      parityRatio: round4(ratio),
      dataBytes,
      parityBytes,
      wastedBytes: total - dataBytes - parityBytes,
      rate: dataBytes / Math.max(1, dataBytes + parityBytes),
      intra: { k, nsym, blocks },
      inter: planInter(dataBytes, parityPct),
      netBytesPerPage: dataBytes,
    };
  };

  if (!colour || monoSafe === 'off') {
    const total = channels.reduce((a, c) => a + c.byteCount, 0);
    const r = nativeBudget(total);
    if (monoSafe !== 'off') r.monoSafe = 'off';
    return r;
  }
  if (!secondary) throw new RangeError(`profile ${p.id}: monoSafe=${monoSafe} needs a parity channel`);

  const dataAvail = colour.byteCount;
  const parityAvail = secondary.byteCount + (byName.height ? byName.height.byteCount : 0);
  const ratio = monoSafe === 'full' ? 1 : monoSafe === 'partial' ? 0.5 : null;
  if (ratio === null) throw new RangeError(`unknown monoSafe "${monoSafe}"`);

  // data capped so that the parity budget can cover it at the requested ratio
  const dataWanted = Math.min(dataAvail, Math.floor(parityAvail / ratio));
  const want = { k: 0, nsym: 0, blocks: 0, dataBytes: 0, parityBytes: 0 };
  if (dataWanted >= 1) {
    const per = ratio === 1 ? 127 : 170; // k + nsym <= 255 with nsym = k or nsym = k/2
    let k = Math.min(dataWanted, per);
    let blocks = Math.max(1, Math.ceil(dataWanted / k));
    k = Math.floor(dataWanted / blocks);
    let nsym = Math.max(1, Math.min(Math.floor(parityAvail / blocks), Math.ceil(k * ratio), 255 - k));
    while (blocks * nsym > parityAvail && blocks > 1) blocks--;
    want.k = k;
    want.nsym = nsym;
    want.blocks = blocks;
    want.dataBytes = k * blocks;
    want.parityBytes = nsym * blocks;
  }
  if (want.dataBytes < 1) throw new RangeError(`profile ${p.id} (${p.note}): no usable capacity at this nozzle`);
  return {
    mode: 'unequal',
    monoSafe,
    monoRecoverable: ratio === 1,
    dataBytes: want.dataBytes,
    parityBytes: want.parityBytes,
    wastedBytes: dataAvail + parityAvail - want.dataBytes - want.parityBytes,
    rate: want.dataBytes / (want.dataBytes + want.parityBytes),
    intra: { k: want.k, nsym: want.nsym, blocks: want.blocks },
    inter: planInter(want.dataBytes, parityPct),
    netBytesPerPage: want.dataBytes,
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
          monoSafe: g.ecc.monoSafe,
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
