/**
 * The MTF calibration plate (docs/PLAN.md §3.4, M7's missing half): generator, reader, and
 * the two controls that make the reader's answer mean something.
 *
 * What is being pinned here, and why each test can fail:
 *
 *   - the ladder must **carry the answer**: every nozzle's extrusion width is a rung. If a
 *     nozzle's EW stops being a rung (someone edits NOZZLES without editing the plate), the
 *     recommendation silently becomes an inference and this test says so.
 *   - the reader must resolve **everything** on a pristine render. That is the positive
 *     control for the whole measurement: without it, "the channel filled the 0.26mm hole"
 *     and "the reader cannot see a 0.26mm hole" are the same observation.
 *   - a printer whose features are below one EW must fill the hole, not round it up: the
 *     emulation is checked against the picture, because rounding up would let a 0.2mm nozzle
 *     masquerade as a 0.4mm one.
 *   - the floor must be **monotone** in injected blur, and the fine rungs must actually close.
 *     A reader that returned a constant would pass the pristine test alone.
 *   - a printer coarser than every nozzle must get **no** recommendation.
 *
 * The blur here is a test fixture (a separable Gaussian in millimetres), not the channel:
 * sim/channel.py is the independent physics and tools/mtf-probe.ps1 is where the plate meets
 * it. This file is the fast regression net around the same code.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mtfPlateSpec,
  renderMtfPlate,
  describeMtfPlate,
  mtfPlateLayout,
  MTF_RUNGS_MM,
  MTF_FEATURE_MM,
  MTF_HOLE_FRACTION,
} from '../../core/calibrate/mtfplate.js';
import { readMtfPlate, recommendFromMtf, describeMtfMeasurement } from '../../core/calibrate/readmtf.js';
import { NOZZLE_IDS, getNozzle } from '../../core/nozzles.js';
import { MM_PER_INCH } from '../../core/render/units.js';

const DPI = 300;
const spec = mtfPlateSpec({ plateMm: 200, dpi: DPI, palette: 'INK2' });

/** Separable Gaussian blur with sigma in millimetres; radius capped so tests stay quick. */
function blurMm(img, sigmaMm) {
  if (!(sigmaMm > 0)) return img;
  const sigmaPx = (sigmaMm * img.dpi) / MM_PER_INCH;
  const radius = Math.max(1, Math.min(12, Math.ceil(sigmaPx * 2.5)));
  const kernel = new Float64Array(2 * radius + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / (2 * sigmaPx * sigmaPx));
    kernel[i + radius] = v;
    sum += v;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;
  const { width, height } = img;
  const tmp = new Float64Array(width * height * 4);
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) {
        let acc = 0;
        for (let k = -radius; k <= radius; k++) {
          const xx = Math.min(width - 1, Math.max(0, x + k));
          acc += kernel[k + radius] * img.pixels[(y * width + xx) * 4 + c];
        }
        tmp[o + c] = acc;
      }
      tmp[o + 3] = 255;
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) {
        let acc = 0;
        for (let k = -radius; k <= radius; k++) {
          const yy = Math.min(height - 1, Math.max(0, y + k));
          acc += kernel[k + radius] * tmp[(yy * width + x) * 4 + c];
        }
        out[o + c] = Math.round(Math.min(255, Math.max(0, acc)));
      }
      out[o + 3] = 255;
    }
  }
  return { ...img, pixels: out };
}

test('spec: the ladder carries every nozzle as a rung, and the plate fits its own box', () => {
  for (const id of NOZZLE_IDS) {
    const ew = getNozzle(id).ewMm;
    assert.ok(
      MTF_FEATURE_MM.some((s) => Math.abs(s - ew) < 1e-9),
      `nozzle ${id} (EW ${ew}mm) is not a rung of the feature ladder -- the recommendation would become an inference`,
    );
  }
  assert.deepEqual(spec.pitchLadder.map((r) => r.pitchMmNominal), MTF_RUNGS_MM);
  assert.ok(MTF_HOLE_FRACTION > 0 && MTF_HOLE_FRACTION < 0.5, 'hole fraction must leave more ink than hole');
  assert.equal(spec.fiducials.length, 4);
  assert.equal(spec.fiducials.filter((f) => !f.solid).length, 1, 'exactly one hollow marker, or orientation is ambiguous');
  // every drawn patch stays inside the plate, with the margin respected
  const boxes = [
    ...spec.pitchLadder.map((r) => r.rectMm),
    spec.featureBlockMm,
    ...spec.colourSamples.map((s) => s.rectMm),
    ...spec.textureSamples.map((t) => t.rectMm),
    spec.scaleSquare.rectMm,
    spec.ruler.barMm,
  ];
  for (const b of boxes) {
    assert.ok(b.x >= spec.marginMm - 1e-9 && b.y >= 0, `patch at ${b.x},${b.y} starts outside the margin`);
    assert.ok(b.x + b.w <= spec.plateMm - spec.marginMm + 1e-6, `patch at ${b.x} extends past the plate`);
    assert.ok(b.y + b.h <= spec.plateMm, `patch at ${b.y} extends past the plate`);
  }
  assert.match(describeMtfPlate(spec), /MTF plate 200x200mm/);
});

test('render: deterministic, and a hole narrower than the printer is FILLED, not rounded up', () => {
  const a = renderMtfPlate(spec);
  const b = renderMtfPlate(spec);
  assert.deepEqual(a.pixels, b.pixels, 'two renders of the same spec must be byte-identical');
  // A 0.45mm printer cannot make the 0.6mm rung's 0.237mm hole. Rounding it up to one EW
  // would draw a hole that a 0.2mm nozzle could not make either, and would let a coarse
  // nozzle look fine: the reader must therefore see the rung as closed, and here we check
  // the picture itself, not the reader.
  const coarse = renderMtfPlate(spec, { printEwMm: 0.45 });
  const rung = spec.pitchLadder[0];
  // The centre of a cell, not the corner where cells meet: sampling the boundary lands on
  // ink in both pictures and would make the control pass for the wrong reason.
  const centreOf = (img, r) => {
    const x = r.originPx.x + Math.floor(r.cols / 2) * r.cellPx + (r.cellPx >> 1);
    const y = r.originPx.y + Math.floor(r.rows / 2) * r.cellPx + (r.cellPx >> 1);
    return img.pixels[(y * img.width + x) * 4];
  };
  const pristineCentre = centreOf(a, rung);
  const coarseCentre = centreOf(coarse, rung);
  assert.ok(pristineCentre > 200, `the pristine 0.6mm rung must show an open hole at its centre (got ${pristineCentre})`);
  assert.ok(coarseCentre < 60, `a 0.45mm printer must fill the 0.6mm rung's hole (centre ${coarseCentre})`);
});

test('reader: a pristine render resolves every rung (positive control for the measurement)', () => {
  const img = renderMtfPlate(spec);
  const m = readMtfPlate(img, spec);
  assert.equal(m.ok, true);
  assert.equal(m.registration, 'canvas');
  assert.equal(m.features.allResolved, true, 'every feature rung must resolve with no channel');
  assert.equal(m.features.floorMm, Math.min(...MTF_FEATURE_MM));
  for (const r of m.pitch.rungs) assert.equal(r.resolved, true, `pitch rung ${r.pitchMmNominal}mm must resolve pristine`);
  assert.equal(m.colour.allCorrect, true);
  assert.ok(m.colour.minSeparation > 0.2, `black/red separation ${m.colour.minSeparation} looks too small`);
  const rec = recommendFromMtf(m);
  assert.equal(rec.ok, true);
  assert.equal(rec.nozzle.id, '0.2', 'with a floor of 0.26mm the finest nozzle is the answer');
  assert.ok(describeMtfMeasurement(m, rec).length > 8);
});

test('reader: the emulated printer is named back exactly, for every nozzle', () => {
  for (const id of NOZZLE_IDS) {
    const ew = getNozzle(id).ewMm;
    const img = renderMtfPlate(spec, { printEwMm: ew });
    const m = readMtfPlate(img, spec, { texture: false, ruler: false });
    const rec = recommendFromMtf(m);
    assert.equal(m.ok, true);
    assert.equal(rec.ok, true, `EW ${ew}mm: ${rec.reason}`);
    assert.equal(rec.nozzle.id, id, `EW ${ew}mm should read back as nozzle ${id}, got ${rec.nozzle.id} (floor ${m.features.floorMm})`);
    assert.equal(rec.nozzle.fromExactRung, true, 'the answer must come from a rung at that EW, not from an interval');
  }
});

test('reader: a printer coarser than every nozzle gets no recommendation (negative control)', () => {
  const img = renderMtfPlate(spec, { printEwMm: 1.4 });
  const m = readMtfPlate(img, spec, { texture: false, ruler: false });
  assert.equal(m.features.noneResolved, true);
  const rec = recommendFromMtf(m);
  assert.equal(rec.ok, false);
  // Either branch is a refusal; what matters is that no nozzle was named.
  assert.match(rec.reason, /no nozzle|no feature rung/);
  assert.equal(rec.nozzle, null);
});

test('reader: the floor is monotone in injected blur, and the fine rungs really close', () => {
  // Measured floors at these sigmas (scratch run, 300 dpi): 0.26 / 0.45 / 0.9 mm, and at
  // 0.45 mm nothing resolves at all. The set is chosen so every step of the ladder moves.
  const floors = [];
  const fineResolved = [];
  for (const sigma of [0, 0.12, 0.2]) {
    const img = blurMm(renderMtfPlate(spec), sigma);
    const m = readMtfPlate(img, spec, { texture: false, ruler: false });
    assert.equal(m.ok, true, `sigma ${sigma}mm: registration failed (${m.stage}/${m.reason})`);
    floors.push(m.features.floorMm);
    fineResolved.push(m.features.rungs.find((r) => Math.abs(r.sizeMm - 0.26) < 1e-9).resolved);
  }
  assert.equal(floors[0], 0.26, 'no blur must still resolve the finest rung');
  assert.equal(fineResolved[0], true);
  assert.equal(fineResolved[1], false, 'at sigma 0.12mm the 0.26mm rung must close -- otherwise the fixture proves nothing');
  for (let i = 1; i < floors.length; i++) {
    assert.ok(
      floors[i] === null || floors[i] >= floors[i - 1] - 1e-9,
      `floor went DOWN with more blur: ${floors.join(' -> ')}mm`,
    );
  }
  assert.ok(floors[2] > floors[0], `more blur must coarsen the floor: ${floors.join(' -> ')}mm`);
  // And past the plate's own ladder the answer must become "nothing", not a guess.
  const dead = readMtfPlate(blurMm(renderMtfPlate(spec), 0.45), spec, { texture: false, ruler: false });
  assert.equal(dead.features.floorMm, null);
  assert.equal(recommendFromMtf(dead).ok, false);
});

test('reader: a canvas-SIZED image that is not canvas-ALIGNED is registered, not assumed', () => {
  // The fast path is a convenience, and an unverified convenience is how a wrong answer
  // gets printed with confidence: a photo that merely shares the pixel dimensions would be
  // measured at nominal positions. Roll the pristine render by a large, non-round amount --
  // same size, markers somewhere else -- and the reader must go through marker registration.
  // Roll the pristine render by a large, non-round amount -- same size, markers somewhere
  // else -- and the reader must go through marker registration. (A wrap would push plate
  // content across the frame, which is a different failure; a 180-degree turn keeps the
  // plate whole and moves every marker off its nominal position.)
  const img = renderMtfPlate(spec);
  const turned = new Uint8Array(img.pixels.length);
  for (let y = 0; y < img.height; y++) {
    const sy = img.height - 1 - y;
    for (let x = 0; x < img.width; x++) {
      const sx = img.width - 1 - x;
      const from = (sy * img.width + sx) * 4;
      const to = (y * img.width + x) * 4;
      turned[to] = img.pixels[from];
      turned[to + 1] = img.pixels[from + 1];
      turned[to + 2] = img.pixels[from + 2];
      turned[to + 3] = 255;
    }
  }
  const m = readMtfPlate({ ...img, pixels: turned }, spec, { texture: false, ruler: false });
  assert.equal(m.ok, true, `turned image: ${m.stage}/${m.reason}`);
  assert.equal(m.registration, 'markers', 'a turned image must be registered, not taken as aligned');
  assert.equal(m.features.floorMm, 0.26, 'the turned image still carries the same plate, so the floor must be unchanged');
});

test('reader: refuses a spec it does not know', () => {
  const img = renderMtfPlate(spec);
  assert.throws(() => readMtfPlate(img, { ...spec, version: 99 }), /regenerate the plate/);
  assert.throws(() => mtfPlateLayout({ kind: 'not-a-plate' }), /not an MTF plate spec/);
});
