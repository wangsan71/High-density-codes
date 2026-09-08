/**
 * Per-page rho recalibration and its RS arbitration (DEFECTS D51, rounds 61-63).
 *
 * The cluster centres, error rates and the RS ceiling asserted here were measured on real corpora by
 * tools/rho-report.mjs in round 62; this file turns those measurements into regressions, so the fix
 * cannot quietly turn back into the thing it fixed. Two of the tests are deliberately adversarial
 * against the fix itself: the naive-Otsu positive control (which reproduces the measured 60.102%
 * trap) and the "rho carries no information" case (which must NOT be rescued).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateRhoCut, recalibrateLevels, feedPageWithRecalibration, shapeLevelsOf } from '../../core/decode/recalibrate.js';
import { encodeTransfer, TransferAssembler, joinCellLevels, splitCellLevel } from '../../core/protocol.js';

/** The intra-page RS ceiling at these profiles: (nsym/2)/(k+nsym) = 16/254. */
const RS_CEILING = 16 / 254;

/** Deterministic jitter; tests must never depend on Math.random. */
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * The textbook Otsu this fix deliberately does NOT use: bin from zero and take the FIRST bin that
 * maximises between-class variance. On a two-delta histogram -- exactly what a pristine render or the
 * fast path produces -- it lands below the lower spike and calls most of the page level 1. Round 62
 * measured that: cut 0.0018 against a level-0 spike at 0.0021, 60.102% cell errors. Kept here as an
 * executable positive control, so "we avoided the trap" is a checked claim rather than a comment.
 */
function naiveFirstMaximumCut(values, bins = 512) {
  let hi = -Infinity;
  for (const v of values) if (v > hi) hi = v;
  const hist = new Float64Array(bins);
  for (const v of values) hist[Math.min(bins - 1, Math.max(0, Math.floor((v / hi) * bins)))]++;
  const n = values.length;
  let sumAll = 0;
  for (let b = 0; b < bins; b++) sumAll += b * hist[b];
  let w0 = 0;
  let sum0 = 0;
  let best = -1;
  let argmax = 0;
  for (let b = 0; b < bins; b++) {
    w0 += hist[b];
    if (!w0) continue;
    const w1 = n - w0;
    if (!w1) break;
    sum0 += b * hist[b];
    const m0 = sum0 / w0;
    const m1 = (sumAll - sum0) / w1;
    const between = w0 * w1 * (m0 - m1) * (m0 - m1);
    if (between > best) {
      best = between;
      argmax = b;
    }
  }
  return ((argmax + 0.5) / bins) * hi;
}

function errorRateAt(rho, truth, cut) {
  let errs = 0;
  for (let i = 0; i < rho.length; i++) if ((rho[i] > cut ? 1 : 0) !== truth[i]) errs++;
  return errs / rho.length;
}

test('rho cut: on a two-spike histogram the cut lands between the spikes, and the naive rule reproduces the measured trap', () => {
  const n = 68904; // a real 300 dpi page: cols 216 x rows 319
  const truth = new Uint8Array(n);
  const rho = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    truth[i] = i % 5 < 2 ? 1 : 0; // 60/40, the level mix the pristine 300 dpi control measured
    rho[i] = truth[i] ? 0.3741 : 0.0021; // measured pristine cluster centres, sd 0.0000
  }
  const est = estimateRhoCut(rho);
  assert.equal(est.ok, true);
  assert.ok(est.cut > 0.0021 && est.cut < 0.3741, `cut ${est.cut} must fall between the two spikes`);
  assert.ok(est.plateauHi > est.plateauLo, 'the exact tie plateau must be recognised, not only its first bin');
  assert.equal(errorRateAt(rho, truth, est.cut), 0, 'a pristine-shaped page must stay perfect');
  assert.equal(est.unimodal, false);

  const naive = naiveFirstMaximumCut(rho);
  assert.ok(naive < 0.0021, `the naive rule must reproduce the measured trap, got cut ${naive.toFixed(6)}`);
  const naiveErr = errorRateAt(rho, truth, naive);
  assert.ok(naiveErr > 0.5, `naive cut errs ${(naiveErr * 100).toFixed(3)}%, expected the measured ~60.102%`);
});

test('rho cut: bleed-shifted clusters are recovered while the fixed boundary loses the whole page', () => {
  const n = 287507; // a real 600 dpi page: cols 443 x rows 649
  const truth = new Uint8Array(n);
  const rho = new Float32Array(n);
  const rnd = lcg(600);
  for (let i = 0; i < n; i++) {
    truth[i] = rnd() < 0.0957 ? 1 : 0; // the 27516/287507 level mix measured on the pristine 600 dpi control
    // Round 62, collapsed 600 dpi pages: clusters at 1.2684 (level 0) and 1.6824 (level 1).
    rho[i] = (truth[i] ? 1.6824 : 1.2684) + (rnd() - 0.5) * 0.14;
  }
  const est = estimateRhoCut(rho);
  assert.equal(est.ok, true);
  assert.ok(est.cut > 1.2684 && est.cut < 1.6824, `cut ${est.cut} must fall inside the gap`);
  assert.ok(est.separation > 3, `round 62 measured separation 3.61-5.53 on collapsed pages, got ${est.separation.toFixed(2)}`);
  assert.equal(est.unimodal, false);

  const err = errorRateAt(rho, truth, est.cut);
  assert.ok(err < RS_CEILING, `recovered error rate ${(err * 100).toFixed(4)}% must stay under the RS ceiling ${(RS_CEILING * 100).toFixed(2)}%`);
  // The fixed boundary the product used before this fix: mid[0] = 0.1850, measured wrong on
  // 60.1-90.6% of the cells of every channel page.
  const fixedErr = errorRateAt(rho, truth, 0.185);
  assert.ok(fixedErr > 0.9, `the fixed cut must lose the page, got ${(fixedErr * 100).toFixed(1)}%`);
});

test('rho cut refuses the cases where one cut means nothing, and says why', () => {
  const constant = new Float32Array(5000).fill(1.3);
  const c = estimateRhoCut(constant);
  assert.equal(c.ok, false);
  assert.match(c.reason, /constant/, 'a page with one rho value has no cut; refusing is the point');

  const few = new Float32Array(5000);
  few.fill(NaN);
  for (let i = 0; i < 10; i++) few[i] = i / 10;
  assert.match(estimateRhoCut(few).reason, /not enough/);

  const rho = new Float32Array(5000);
  const rnd = lcg(7);
  for (let i = 0; i < rho.length; i++) rho[i] = rnd() < 0.5 ? 0.1 + rnd() * 0.05 : 1.5 + rnd() * 0.05;
  assert.match(estimateRhoCut(rho, { levels: 3 }).reason, /3 shape levels/, 'a single cut is meaningless above two levels');

  const withNans = Float32Array.from(rho);
  for (let i = 0; i < 40; i++) withNans[i * 7] = NaN;
  const est = estimateRhoCut(withNans);
  assert.equal(est.ok, true);
  assert.equal(est.nan, 40, 'unmeasurable cells are ignored but must be counted out loud');
});

test('recalibrateLevels re-decides measurable cells and keeps the matched filter answer for the rest', async () => {
  const payload = new Uint8Array(4096);
  const rnd = lcg(11);
  for (let i = 0; i < payload.length; i++) payload[i] = Math.floor(rnd() * 256);
  const t = await encodeTransfer(payload, { profile: 'P-M1-300' });
  const geom = t.geom;
  assert.equal(shapeLevelsOf(geom), 2);
  const levels = t.pages[0].levels;
  const n = geom.totalCells;

  const rho = new Float32Array(n);
  const colourLevels = new Uint8Array(n);
  const nanIdx = [];
  for (let i = 0; i < n; i++) {
    const parts = splitCellLevel(levels[i], geom);
    colourLevels[i] = parts.colour;
    if (i % 997 === 0) {
      rho[i] = NaN;
      nanIdx.push(i);
    } else {
      rho[i] = parts.shape ? 1.7 : 1.2; // the truth, shifted the way bleed shifts it
    }
  }
  const out = recalibrateLevels({ levels, rho, colourLevels, geom, cut: 1.45 });
  assert.equal(out.n, n);
  assert.equal(out.kept, nanIdx.length);
  for (const i of nanIdx) assert.equal(out.levels[i], levels[i], `cell ${i} was unmeasurable, so its level must not move`);
  const hasColour = geom.channels.some((c) => c.name === 'colour');
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(rho[i])) continue;
    const got = splitCellLevel(out.levels[i], geom);
    const want = splitCellLevel(levels[i], geom);
    assert.equal(got.shape, want.shape, `cell ${i} must come back at its true shape level`);
    // splitCellLevel is keyed by channel name, and the P-M1 paper profiles carry no colour channel at
    // all -- asserting a colour there would be asserting a field that does not exist.
    if (hasColour) assert.equal(got.colour, colourLevels[i], `cell ${i} must keep its measured colour, not an invented one`);
    for (const ch of geom.channels) {
      if (ch.name === 'shape' || ch.name === 'colour') continue;
      assert.equal(got[ch.name], want[ch.name], `cell ${i}: channel ${ch.name} must be carried over untouched`);
    }
  }
  assert.throws(() => recalibrateLevels({ levels, rho, colourLevels, geom: { channels: [{ name: 'shape', levels: 3 }], totalCells: n }, cut: 1.45 }), RangeError);
});

test('a collapsed page is rejected, then rescued by the arbitrated re-read, and the payload is byte-identical', async () => {
  const payload = new Uint8Array(20000);
  const rnd = lcg(63);
  for (let i = 0; i < payload.length; i++) payload[i] = Math.floor(rnd() * 256);
  const t = await encodeTransfer(payload, { profile: 'P-M1-300' });
  const geom = t.geom;
  assert.ok(t.pages.length >= 2, 'the payload must span several pages or this test proves nothing');
  const collapseIndex = 1;

  const rhoOfTruth = (levels, seed) => {
    const r = new Float32Array(geom.totalCells);
    const j = lcg(seed);
    for (let i = 0; i < r.length; i++) r[i] = (splitCellLevel(levels[i], geom).shape ? 1.68 : 1.27) + (j() - 0.5) * 0.12;
    return r;
  };
  const colourOf = (levels) => {
    const c = new Uint8Array(geom.totalCells);
    for (let i = 0; i < c.length; i++) c[i] = splitCellLevel(levels[i], geom).colour;
    return c;
  };

  // The collapse as the 600 dpi census shows it: the matched filter put every cell at one level.
  const collapsed = Uint16Array.from(t.pages[collapseIndex].levels);
  for (let i = 0; i < collapsed.length; i++) collapsed[i] = joinCellLevels({ shape: 1, colour: splitCellLevel(collapsed[i], geom).colour }, geom);

  // Positive control: without the fix, the page's own code rejects it. If this ever stops failing,
  // the test below would be rescuing nothing and the whole file would be decoration.
  const control = new TransferAssembler();
  const ctrlFed = await control.feed({ levels: collapsed, header: t.pages[collapseIndex].header, channelMissing: [] });
  assert.equal(ctrlFed.ok, false);
  assert.equal(ctrlFed.reason, 'intra-fail', 'a collapsed page must die in intra-page RS');

  const asm = new TransferAssembler();
  for (let p = 0; p < t.pages.length; p++) {
    const page = t.pages[p];
    const decoded =
      p === collapseIndex
        ? { levels: collapsed, headerBytes: page.header, colourAlive: true, rho: rhoOfTruth(page.levels, 21), colourLevels: colourOf(page.levels) }
        : { levels: page.levels, headerBytes: page.header, colourAlive: true };
    const res = await feedPageWithRecalibration(asm, decoded, { geom });
    assert.equal(res.fed.ok, true, `page ${p} must be accepted, got ${res.fed.reason ?? 'ok'}`);
    if (p === collapseIndex) {
      assert.equal(res.retried, true, 'the collapsed page must have been re-read');
      assert.ok(res.changed > 0, 'the re-read must actually have changed cells');
      assert.ok(res.estimate.separation > 1, 'and it must say out loud how well the clusters separated');
    } else {
      // The non-regression guarantee: a page that reads correctly today is never re-read, so it is
      // read bit-identically. This is why the 300 dpi side of G2 cannot regress by construction.
      assert.equal(res.retried, false, `page ${p} read fine, so no recalibration may run`);
    }
  }
  assert.ok(asm.result, 'the transfer must complete');
  assert.deepEqual(new Uint8Array(asm.result), payload, 'the rescued transfer must be byte-identical to the original');
});

test('a page whose rho carries no information is NOT rescued: the estimator refuses and the rejection stands', async () => {
  const payload = new Uint8Array(20000);
  const rnd = lcg(64);
  for (let i = 0; i < payload.length; i++) payload[i] = Math.floor(rnd() * 256);
  const t = await encodeTransfer(payload, { profile: 'P-M1-300' });
  const geom = t.geom;
  const collapseIndex = 0;

  const collapsed = Uint16Array.from(t.pages[collapseIndex].levels);
  for (let i = 0; i < collapsed.length; i++) collapsed[i] = joinCellLevels({ shape: 1, colour: splitCellLevel(collapsed[i], geom).colour }, geom);

  const asm = new TransferAssembler();
  for (let p = 0; p < t.pages.length; p++) {
    const page = t.pages[p];
    const decoded =
      p === collapseIndex
        ? {
            levels: collapsed,
            headerBytes: page.header,
            colourAlive: true,
            // One value for every cell: rho says nothing about which cell is which. Inventing a cut
            // here is exactly the "looks like success but is wrong" failure this repo forbids, so the
            // estimator must refuse and the original rejection must stand.
            rho: new Float32Array(geom.totalCells).fill(1.3),
            colourLevels: new Uint8Array(geom.totalCells),
          }
        : { levels: page.levels, headerBytes: page.header, colourAlive: true };
    const res = await feedPageWithRecalibration(asm, decoded, { geom });
    if (p === collapseIndex) {
      assert.equal(res.retried, false, 'no re-read may be offered when there is nothing to calibrate on');
      assert.equal(res.fed.ok, false);
      assert.equal(res.fed.reason, 'intra-fail');
      assert.match(res.reason, /constant/);
    }
  }
  // Refusing to invent a cut does not by itself leave the transfer incomplete: inter-page parity may
  // reconstruct the refused page, which is a feature and is why the 300 dpi side of G2 passes 200/200
  // while a handful of its pages are unreadable. What must never happen is a WRONG payload, so the
  // assertion is the one that matters -- if the transfer closed, its bytes are the original ones.
  if (asm.result) {
    assert.deepEqual(new Uint8Array(asm.result), payload, 'a refused page may be reconstructed by inter-page parity, but never into different bytes');
  }
  assert.ok(Array.isArray(asm.rejected) && asm.rejected.some((r) => r.reason === 'intra-fail'), 'the refusal must be recorded, not swallowed');
});
