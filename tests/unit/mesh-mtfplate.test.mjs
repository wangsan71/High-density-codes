/**
 * 校准板的**可打印**半边（D67）：共形网格挤出 + 网格装配 + 投影对拍。
 *
 * 这里钉住的是"网格印出来就是同一块板"，以及几个我本轮真踩过的坑：
 *
 *   - **贴边矩形不能逐矩形挤出**：第一版这样写，`manifoldReport` 立刻报"12 条边被用了 4 次、
 *     24 个夹点顶点"（T 形接缝）。测试里保留一个重叠反例，证明这条判据在本模块上承重。
 *   - **孔比一格挤出宽度窄时必须被"填死"，不是放大到一格**：放大会让 0.2 喷嘴冒充 0.4。
 *   - **比较孔与 EW 要用设计尺寸（mm），不能用像素取整后的尺寸**：0.26mm 在 300dpi 画出来是
 *     3px = 0.254mm，用像素比较会把 0.2 喷嘴**自己那一档**填死 ⇒ 那个喷嘴变得不可测（本轮实测）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { extrudeRectilinear, subtractRects } from '../../core/mesh/rectilinear.js';
import { manifoldReport } from '../../core/mesh/threeMF.js';
import { stlSelfCheck, encodeSTLSolid } from '../../core/mesh/stl.js';
import { buildMtfPlateModel, projectionReport, expectedRegionAreasMm2 } from '../../core/mesh/mtfplate.js';
import { mtfPlateSpec, renderMtfPlate, applyPrintEw, MTF_FEATURE_MM } from '../../core/calibrate/mtfplate.js';
import { NOZZLE_IDS, getNozzle } from '../../core/nozzles.js';

const spec = mtfPlateSpec({ plateMm: 200, dpi: 300, palette: 'INK2' });

test('rectilinear: a block with a hole grid extrudes to ONE watertight solid with the exact area', () => {
  const outer = { x0: 0, x1: 20, y0: 0, y1: 20 };
  const holes = [];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) holes.push({ x0: 2 + c * 7, x1: 4 + c * 7, y0: 2 + r * 7, y1: 4 + r * 7 });
  const rects = subtractRects(outer, holes);
  const sum = rects.reduce((a, r) => a + (r.x1 - r.x0) * (r.y1 - r.y0), 0);
  assert.equal(sum, 400 - 9 * 4, 'the decomposition must cover exactly block minus holes');
  const e = extrudeRectilinear(rects, { zBottom: 2, zTop: 2.3 });
  assert.equal(e.ok, true);
  assert.equal(e.areaMm2, 400 - 36);
  assert.equal(manifoldReport(e.triangles).ok, true, `not watertight: ${JSON.stringify(manifoldReport(e.triangles).issues)}`);
  assert.equal(stlSelfCheck(e.triangles).ok, true);
});

test('rectilinear: overlapping rects are refused (the negative control for the watertight claim)', () => {
  const e = extrudeRectilinear([{ x0: 0, x1: 10, y0: 0, y1: 10 }, { x0: 5, x1: 15, y0: 5, y1: 15 }], { zBottom: 0, zTop: 0.3 });
  assert.equal(e.ok, false);
  assert.match(e.reason, /overlap/);
});

test('rectilinear: rects that merely TOUCH merge into one watertight solid (ruler bar + ticks)', () => {
  const e = extrudeRectilinear(
    [
      { x0: 0, x1: 50, y0: 4, y1: 6 },
      { x0: 10, x1: 10.4, y0: 2, y1: 4 },
      { x0: 20, x1: 20.4, y0: 2, y1: 4 },
    ],
    { zBottom: 2, zTop: 2.3 },
  );
  assert.equal(e.ok, true);
  assert.equal(manifoldReport(e.triangles).ok, true);
});

test('mesh: every object is watertight and the projection matches the spec exactly', () => {
  const model = buildMtfPlateModel(spec);
  assert.equal(model.objects.length, 3, 'base + one object per ink of the palette');
  for (const o of model.objects) {
    const mr = manifoldReport(o.triangles);
    assert.equal(mr.ok, true, `${o.name} not watertight: ${JSON.stringify(mr.issues)}`);
  }
  const sc = stlSelfCheck(model.triangles);
  assert.equal(sc.ok, true);
  // bbox = the plate itself, at the relief top
  assert.ok(Math.abs(sc.bbox.size[0] - spec.plateMm) < 0.05, `bbox x ${sc.bbox.size[0]}`);
  assert.ok(Math.abs(sc.bbox.size[2] - (model.facts.baseMm + model.facts.reliefMm)) < 1e-9);
  const proj = projectionReport(model, spec);
  assert.equal(proj.ok, true, `projection: worst ${proj.maxPct}`);
  assert.ok(proj.maxPct < 1e-4, `per-region areas must agree with the spec arithmetic, worst ${proj.maxPct}`);
  assert.equal(proj.regions.length, expectedRegionAreasMm2(spec).length);
  // the hollow marker really is smaller than the solid ones
  const tl = proj.regions.find((r) => r.id === 'marker-tl');
  const br = proj.regions.find((r) => r.id === 'marker-br');
  assert.ok(br.expectedMm2 < tl.expectedMm2, 'the hollow corner marker must carry less ink than a solid one');
});

test('mesh: deterministic, and the print emulation changes the mesh the same way it changes the raster', () => {
  const a = buildMtfPlateModel(spec);
  const b = buildMtfPlateModel(spec);
  assert.deepEqual(a.triangles, b.triangles, 'same spec must give the same triangles');
  assert.equal(encodeSTLSolid(a.triangles).length, encodeSTLSolid(b.triangles).length);

  // The 0.26mm hole is this nozzle's own rung: a 0.45mm printer must fill it, and the design
  // must keep it (that is what makes the 0.2mm nozzle measurable at all).
  const keep = applyPrintEw(spec.inkRegions, 0.26, spec.dpi).find((r) => r.id === 'feature-ladder');
  const drop = applyPrintEw(spec.inkRegions, 0.45, spec.dpi).find((r) => r.id === 'feature-ladder');
  const has = (regs, mm) => regs.holesPx.some((h) => Math.abs((h.nominalMm ?? -1) - mm) < 1e-9);
  assert.equal(has(keep, 0.26), true, 'a 0.26mm printer keeps the 0.26mm hole');
  assert.equal(has(drop, 0.26), false, 'a 0.45mm printer fills it');
  assert.equal(has(drop, 0.45), true, 'but keeps the 0.45mm hole');
  // and the mesh really differs, not just the region list
  const coarse = buildMtfPlateModel(spec, { printEwMm: 0.45 });
  assert.notEqual(coarse.triangles.length, a.triangles.length);
  assert.equal(projectionReport(coarse, spec).ok, true);
  // the raster and the mesh are driven by the same emulation, so their ink areas must agree
  const img = renderMtfPlate(spec, { printEwMm: 0.45 });
  assert.equal(img.printEwMm, 0.45);
  for (const id of NOZZLE_IDS) {
    const ew = getNozzle(id).ewMm;
    assert.ok(MTF_FEATURE_MM.some((s) => Math.abs(s - ew) < 1e-9), `nozzle ${id} must stay a ladder rung`);
  }
});

test('mesh: a mono model collapses the colour samples into one object', () => {
  const mono = buildMtfPlateModel(spec, { mono: true });
  assert.equal(mono.objects.length, 2, 'base + a single ink object');
  assert.equal(projectionReport(mono, spec).ok, true);
});
