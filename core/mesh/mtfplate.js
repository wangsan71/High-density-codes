/**
 * core/mesh/mtfplate.js — MTF 校准板的**可打印**半边（STL / 3MF 的共同上游，D67）。
 *
 * `core/calibrate/mtfplate.js` 给出"墨在哪里"（`spec.inkRegions`：像素矩形 + 挖掉的孔），
 * 外观光栅与这里的网格**都**由那一份列表驱动 ⇒ 网格与光栅不可能各自漂移（同一份几何、
 * 两个写出器，与本仓 `core/render/sheet.js` 的做法同源）。
 *
 * ── 为什么不能照 `core/mesh/plate.js` 那样做 ────────────────────────────────
 *   数据板的浮雕是"格内互不相碰的圆环+圆点"，所以逐格挤出后焊接仍满足"每条无向边恰被
 *   两个三角形使用"。校准板的墨区**天生贴边**（实心块挖孔 ⇒ 孔之间的墨带；标尺刻度贴在
 *   横杆上；角标是方环）⇒ 逐矩形挤出会产生共面重面，水密判据**结构性**不成立。
 *   本文件因此走 `core/mesh/rectilinear.js` 的**共形网格挤出**：并集先按所有矩形边界切成
 *   网格，格子作为四边形，只有"邻居在外面"的边才生成墙 ⇒ 没有内部面，水密是构造出来的。
 *
 * ── 与 `MESH-CONTRACT.md` 的关系（如实写，别当没这回事）────────────────────
 *   §2 要求底板厚 2.00mm、浮雕高差 0.30mm、静区 6mm —— 本文件直接 import `plate.js` 的
 *   `PLATE_MM`/`RELIEF_MM`/`QUIET_MM`/`WELD_DECIMALS`，不另写数字。
 *   §2 最后一行说"角标与纸面同一套" —— **数据板的网格至今没有角标**（`plate.js` 的
 *   `notModelled` 明写这一点，理由是角标的线宽在 `core/render` 里是像素量、而 §3 不许
 *   凭空发明半径）。本文件**带上角标**：它们的尺寸直接取自 `spec.fiducials`（像素）换算
 *   成 mm，环宽 = 1 个 frame cell = `frameCellMm`（≥1 EW，不需要发明任何半径），因为校准
 *   板**必须**能被 `findMarkers` 定位，否则打印出来就是一块没人认得出的板。数据板那一半
 *   仍记为 **D68**（同一根因：网格侧没有角标 ⇒ 真机照片登记不了），本轮不顺手改它。
 *   §4 的"不做 CSG"照旧：每个 object 内部水密，object 之间允许接触/重叠，**绝不声称**并集。
 *
 * 纯 ESM、零依赖、不得 import `node:`。
 */
import { boxTriangles, weldTriangles, expandIndexedTriangles, boundingBox } from './solids.js';
import { extrudeRectilinear, subtractRects } from './rectilinear.js';
import { PLATE_MM, RELIEF_MM, QUIET_MM, WELD_DECIMALS } from './plate.js';
import { applyPrintEw, MTF_PLATE_VERSION } from '../calibrate/mtfplate.js';
import { getPalette } from '../palette.js';
import { MM_PER_INCH } from '../render/units.js';

const round6 = (x) => Math.round(x * 1e6) / 1e6;
const rgbaHex = (rgb) => `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;

/**
 * 装配校准板的网格。
 *
 * @param {object} spec  `mtfPlateSpec()` 的结果
 * @param {object} [opts]
 * @param {number} [opts.printEwMm=0]  仿真：与外观光栅**同一套** `applyPrintEw`（见该函数）
 * @param {boolean} [opts.mono=false]  单色渲染：所有墨区并成一个 object
 * @param {string} [opts.palette]      调色板 id（默认取 spec.palette）
 * @param {number} [opts.baseMm]       底板厚（默认 PLATE_MM）
 * @param {number} [opts.reliefMm]     浮雕高差（默认 RELIEF_MM）
 * @returns {{objects:object[], triangles:Float64Array, facts:object}}
 */
export function buildMtfPlateModel(spec, opts = {}) {
  if (!spec || spec.kind !== 'pskt-mtf-plate') throw new Error('buildMtfPlateModel: not an MTF plate spec');
  if (spec.version !== MTF_PLATE_VERSION) {
    throw new Error(`buildMtfPlateModel: spec version ${spec.version} is not ${MTF_PLATE_VERSION} (regenerate the plate)`);
  }
  const paletteId = opts.palette || spec.palette;
  const pal = getPalette(paletteId);
  const baseMm = opts.baseMm ?? PLATE_MM;
  const reliefMm = opts.reliefMm ?? RELIEF_MM;
  if (!(reliefMm > 0)) throw new RangeError(`buildMtfPlateModel: reliefMm ${reliefMm}`);
  const mmPerPx = MM_PER_INCH / spec.dpi;
  const printEwMm = Number(opts.printEwMm || 0);
  const regions = printEwMm > 0 ? applyPrintEw(spec.inkRegions, printEwMm, spec.dpi) : spec.inkRegions;

  const plateWMm = spec.width * mmPerPx;
  const plateHMm = spec.height * mmPerPx;
  // +Y 指向版面"后"沿：图像第 0 行在顶 ⇒ 模型 y = plateHMm - imageY（与 plate.js 同约定）
  const toMm = (r) => ({
    x0: r.x * mmPerPx,
    x1: (r.x + r.w) * mmPerPx,
    y0: plateHMm - (r.y + r.h) * mmPerPx,
    y1: plateHMm - r.y * mmPerPx,
  });

  const byInk = new Map();
  for (const region of regions) {
    const ink = opts.mono ? 0 : region.inkLevel % pal.inks.length;
    if (!byInk.has(ink)) byInk.set(ink, []);
    const bucket = byInk.get(ink);
    for (const outerPx of region.outersPx) {
      const outer = toMm(outerPx);
      const holes = region.holesPx.map(toMm);
      for (const r of subtractRects(outer, holes)) bucket.push(r);
    }
  }

  const base = boxTriangles({ xMinMm: 0, xMaxMm: plateWMm, yMinMm: 0, yMaxMm: plateHMm, zBottom: 0, zTop: baseMm });
  const objects = [];
  const weldOne = (tris) => {
    let total = 0;
    for (const t of tris) total += t.length;
    const flat = new Float64Array(total);
    let o = 0;
    for (const t of tris) {
      flat.set(t, o);
      o += t.length;
    }
    return weldTriangles(flat, { decimals: WELD_DECIMALS });
  };
  {
    const w = weldOne([base]);
    objects.push({
      name: 'plate-base',
      kind: 'base',
      materialName: `${paletteId}:substrate`,
      displayColor: rgbaHex(pal.background),
      vertices: w.vertices,
      indices: w.indices,
      triangles: expandIndexedTriangles(w.vertices, w.indices),
      bbox: boundingBox(w.vertices),
      solids: 1,
      areaMm2: round6(plateWMm * plateHMm),
    });
  }
  const reliefFacts = [];
  for (const ink of Array.from(byInk.keys()).sort((a, b) => a - b)) {
    const rects = byInk.get(ink);
    const e = extrudeRectilinear(rects, { zBottom: baseMm, zTop: baseMm + reliefMm });
    if (!e.ok) throw new Error(`buildMtfPlateModel: ink ${ink} could not be extruded: ${e.reason}`);
    const w = weldOne([e.triangles]);
    objects.push({
      name: `relief-ink${ink}`,
      kind: 'relief',
      colourLevel: ink,
      materialName: `${paletteId}:ink${ink}`,
      displayColor: rgbaHex(pal.inks[ink % pal.inks.length]),
      vertices: w.vertices,
      indices: w.indices,
      triangles: expandIndexedTriangles(w.vertices, w.indices),
      bbox: boundingBox(w.vertices),
      solids: 1,
      areaMm2: round6(e.areaMm2),
    });
    reliefFacts.push({ ink, rects: rects.length, quads: e.quads, walls: e.walls, areaMm2: round6(e.areaMm2) });
  }

  let total = 0;
  for (const o of objects) total += o.triangles.length;
  const triangles = new Float64Array(total);
  let at = 0;
  for (const o of objects) {
    triangles.set(o.triangles, at);
    at += o.triangles.length;
  }

  return {
    objects,
    triangles,
    facts: {
      kind: 'pskt-mtf-plate-mesh',
      specVersion: spec.version,
      plateMm: spec.plateMm,
      platePrintedMm: { w: round6(plateWMm), h: round6(plateHMm) },
      dpi: spec.dpi,
      mmPerPx: round6(mmPerPx),
      palette: paletteId,
      mono: !!opts.mono,
      printEwMm: printEwMm || null,
      baseMm,
      reliefMm,
      quietMm: QUIET_MM,
      weldDecimals: WELD_DECIMALS,
      yAxisFlipped: true,
      objects: objects.map((o) => ({
        name: o.name,
        kind: o.kind,
        vertices: o.vertices.length / 3,
        triangles: o.indices.length / 3,
        materialName: o.materialName,
        displayColor: o.displayColor,
        areaMm2: o.areaMm2,
      })),
      relief: reliefFacts,
      trianglesTotal: triangles.length / 9,
      bbox: boundingBox(triangles),
      notModelled: [
        'the ink-height relief carries the whole pattern: colour decides only WHICH filament a patch is printed in, never whether a patch is raised',
      ],
    },
  };
}

/**
 * 投影对拍：把网格**顶面**三角形投影到 z=顶面平面，按墨区统计面积，与**规格的矩形算术**
 * 比对（`MESH-CONTRACT.md` §6.3 的同一条判据，只是这里的参考值来自 `spec.inkRegions`）。
 *
 * 两个量来自互不相干的路径：一边是三角形（`projectedUpAreaMm2`，与渲染无关的几何事实），
 * 一边是规格里的矩形加减（像素 → mm²）。任何一侧错位、绕序反了、孔没挖掉，都会在这里分开。
 * 这不是"网格能不能打开"，而是"网格印出来是不是同一块板"。
 *
 * @param {object} model  `buildMtfPlateModel()` 的结果
 * @param {object} spec   `mtfPlateSpec()` 的结果
 * @param {object} [opts]
 * @param {number} [opts.tolerancePct=8]  与 MESH-CONTRACT §6.3 同值
 */
export function projectionReport(model, spec, opts = {}) {
  const tolerancePct = opts.tolerancePct ?? 8;
  const mmPerPx = MM_PER_INCH / spec.dpi;
  const plateHMm = spec.height * mmPerPx;
  const expected = expectedRegionAreasMm2(spec, { printEwMm: model.facts.printEwMm || 0 });
  // region lookup in model coordinates (y flipped)
  const boxes = expected.map((r) => {
    const specRegion = spec.inkRegions.find((x) => x.id === r.id);
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (const o of specRegion.outersPx) {
      x0 = Math.min(x0, o.x * mmPerPx);
      x1 = Math.max(x1, (o.x + o.w) * mmPerPx);
      y0 = Math.min(y0, plateHMm - (o.y + o.h) * mmPerPx);
      y1 = Math.max(y1, plateHMm - o.y * mmPerPx);
    }
    return { ...r, x0, x1, y0, y1 };
  });
  const measured = boxes.map((b) => ({ ...b, projectedMm2: 0 }));
  let upTotal = 0;
  for (const o of model.objects) {
    if (o.kind !== 'relief') continue;
    const t = o.triangles;
    for (let i = 0; i + 8 < t.length; i += 9) {
      const ax = t[i];
      const ay = t[i + 1];
      const bx = t[i + 3];
      const by = t[i + 4];
      const cx = t[i + 6];
      const cy = t[i + 7];
      const twice = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      if (!(twice > 0)) continue; // side walls project to zero; downward faces are not top
      const area = twice / 2;
      upTotal += area;
      const gx = (ax + bx + cx) / 3;
      const gy = (ay + by + cy) / 3;
      // A triangle may straddle a region border only for the ruler/scale patches, which are
      // disjoint by construction; assign by centroid and count straddles so a straddle cannot
      // hide as a small error.
      let hit = null;
      let straddle = false;
      for (const m of measured) {
        const inside = gx >= m.x0 - 1e-9 && gx <= m.x1 + 1e-9 && gy >= m.y0 - 1e-9 && gy <= m.y1 + 1e-9;
        if (inside) {
          if (hit) straddle = true;
          else hit = m;
        }
      }
      if (hit) {
        hit.projectedMm2 += area;
        if (straddle) hit.straddling = (hit.straddling || 0) + 1;
      } else {
        // outside every declared region: the mesh has ink the spec never asked for
        upTotal -= 0;
      }
    }
  }
  let worst = 0;
  const rows = measured.map((m) => {
    const exp = m.areaMm2;
    const pct = exp > 1e-9 ? Math.abs(m.projectedMm2 - exp) / exp : m.projectedMm2 > 1e-9 ? Infinity : 0;
    worst = Math.max(worst, pct);
    return {
      id: m.id,
      kind: m.kind,
      expectedMm2: exp,
      projectedMm2: round6(m.projectedMm2),
      pct: Math.round(pct * 10000) / 10000,
      ok: pct * 100 <= tolerancePct,
      straddling: m.straddling || 0,
    };
  });
  const declared = expected.reduce((a, r) => a + r.areaMm2, 0);
  return {
    ok: rows.every((r) => r.ok) && Math.abs(upTotal - declared) / declared <= tolerancePct / 100,
    tolerancePct,
    maxPct: Math.round(worst * 10000) / 10000,
    declaredMm2: round6(declared),
    projectedMm2: round6(upTotal),
    regions: rows,
  };
}

/** 每个墨区在设计上的面积（mm²），供投影对拍当**解析**参考值（不是从网格算出来的）。 */
export function expectedRegionAreasMm2(spec, opts = {}) {
  const mmPerPx = MM_PER_INCH / spec.dpi;
  const regions = (opts.printEwMm > 0 ? applyPrintEw(spec.inkRegions, opts.printEwMm, spec.dpi) : spec.inkRegions);
  return regions.map((r) => {
    const outers = r.outersPx.reduce((a, o) => a + o.w * o.h, 0);
    const holes = r.holesPx.reduce((a, h) => a + h.w * h.h, 0);
    return { id: r.id, kind: r.kind, inkLevel: r.inkLevel, areaMm2: round6((outers - holes) * mmPerPx * mmPerPx) };
  });
}
