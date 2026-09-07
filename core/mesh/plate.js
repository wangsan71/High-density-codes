/**
 * core/mesh/plate.js — 把"一页数据"装配成板材网格实体（STL 与 3MF 的共同上游）。
 *
 * 纯 ESM、零依赖、Node 与浏览器同一份：不得 import 任何 `node:` 模块。
 *
 * ── 为什么单独有这一个文件 ──────────────────────────────────────────────────
 *   `solids.js` 造原语，`stl.js` / `threeMF.js` 写字节，但"一页数据在板材上长什么
 *   样"这一层一直是缺的。装配只此一处，两个产物从**同一批三角形**出发 ——
 *   `MESH-CONTRACT.md` §5 要求"同一次布局的两种产物必须给出同一个格子集合，用于对拍"。
 *
 * ── 本文件遵守的绑定数字（docs/MESH-CONTRACT.md §2；改这里 = 改契约）─────────
 *   PLATE_MM     = 2.00 mm  底板厚（z=0 是打印床，材料在 z>0 一侧，法向按右手定则朝外）
 *   RELIEF_MM    = 0.30 mm  一级浮雕的高差
 *   INK_SUNK_MM  = 0.05 mm  双色档"墨色所在格"下沉量，**不携带任何数据位**
 *   QUIET_MM     = 6.00 mm  静区（与纸面同源，计入版面）
 *
 * ── 每格的形状从哪来（§3：不许另写公式）────────────────────────────────────
 *   半径**只**取自 `core/render/glyphs.js:glyphGeometry(cellEw, shapeLevels)` 的
 *   `outer` / `inner` / `dot[level]`（它们是"以格宽为 1 的比例半径"，mm 半径 = 比例 ×
 *   印刷格宽），而 `cellEw` / `glyph` 直接取 `pageLayout()` 算好的那一个对象 —— 也就
 *   是渲染器自己用的那一个。于是 PNG 与 3MF 用的是同一份几何，不是两份"看起来一样"。
 *   `glyphGeometry()` 在格宽不足时会 `ok:false`（4 级形状字母表要 ≥24 EW/格）；这里
 *   **原样拒绝并抛出原因**，不绕过、不猜半径。
 *
 * ── 为什么浮雕用 环+圆点 而不是 prismFromMask（诚实条款，务必读）─────────────
 *   `prismFromMask()` 把掩码拆成"最大矩形覆盖"再逐矩形挤出。相邻矩形在同一 Z 区间
 *   并存 ⇒ 公共侧壁被两侧各生成一次（重合面），矩形边长不等时还会留下 T 形接缝（一个
 *   顶点落在另一条边的中间）。这两种情况都让"每条无向边恰被两个三角形共用"这条水密
 *   判据**结构性地**不成立；要让它成立就必须做布尔并（CSG），而 §4 明令禁止声称 CSG。
 *
 *   本文件因此走另一条同样受约束的路：一格的形状本来就是"参考环 + 中心圆点"——
 *   `glyphMaskForLevel()` 的定义就是 (r≤outer ∧ r>inner) ∨ (r≤inner ∧ r≤dot[level]) ——
 *   所以用 `ringTriangles()` + `discTriangles()` 直接挤出这两个**各自封闭**的实体。
 *   它们之间、格与格之间由 glyphGeometry 的间距保证**互不接触**（量化几何留出 ≥1 EW
 *   空隙；理想几何 outer=0.47 ⇒ 0.06 格间隙，dot≤0.28 < inner=0.38），因此整个浮雕岛
 *   的并集仍然满足"每条无向边恰用两次"——不是靠偷偷去重，而是因为根本没有公共边。
 *   `manifoldReport()` 逐部件硬判；`tests/unit/mesh-3mf.test.mjs` 里带一个反例：把
 *   `prismFromMask()` 的矩形挤出喂进同一判据 ⇒ 它**必须**报不合法（判据因此有承重）。
 *
 * ── 为什么是多个部件而不是"一个 object"（诚实条款）──────────────────────────
 *   `MESH-CONTRACT.md` §5 写"<object type=\"model\"> 一个"。实测（PL-G@0.8 探针）：把底板
 *   与所有浮雕合成**一张** mesh 后，"每条无向边恰被两个三角形共用"这条计数**照样成立**
 *   —— 浮雕脚底的短边落在底板顶面那两个大三角形的**内部**，两边根本不共边。也就是说：
 *   这条计数在合并体上**什么也没证明**（那里有一对共面重叠的面，是一个自相交的壳集合，
 *   不是布尔并）—— 而这恰恰就是 `watertightHint` 那一类假绿。所以判据必须限定在
 *   **单个部件**内才有意义；分部件的第二个理由是 PLAN §G8 要求"底板 + 色A/色B 合并岛 +
 *   `<basematerials>`"，而 3MF 的材料 `pid/pindex` 只能按 object（或按三角形）挂。
 *   跨部件的共面/重叠事实写在 `facts.assembly` 里，并且绝不声称整个装配是并集（§4）。
 *
 * ── 下沉怎么落实现（诚实条款）──────────────────────────────────────────────
 *   "墨色所在格下沉 0.05 mm"落成：**把该格实体的顶面降低 0.05 mm**（底面仍在
 *   PLATE_MM，即实体矮 0.05 mm），不去底板里挖坑 —— 挖坑要在底板里做布尔减（§4 禁止
 *   声称 CSG），而接触式/光照读出的是"顶面高度"，两种做法给出的相对高差一样。
 *   承载数据的只有 `shape` 档（(level+1)×RELIEF_MM）；`colour` 档**只**决定这一格是否
 *   下沉，绝不改变它属于哪个数据值。文件加载时断言 `2×INK_SUNK_MM < RELIEF_MM`：下沉
 *   量小于半个级差，任何按高度分档的读法都不可能把它误读成一级。
 */

import { boxTriangles, ringTriangles, discTriangles, weldTriangles, expandIndexedTriangles, boundingBox } from './solids.js';
import { splitCellLevel } from '../protocol.js';
import { dotRadiusForRho, rhoFor } from '../render/glyphs.js';
import { buildCoverageTiles } from '../render/raster.js';
import { MM_PER_INCH } from '../render/units.js';
import { getPalette } from '../palette.js';
import { getNozzle } from '../nozzles.js';

/** 底板厚（mm）。`docs/MESH-CONTRACT.md` §2。 */
export const PLATE_MM = 2.0;
/** 一级浮雕的高差（mm）。 */
export const RELIEF_MM = 0.3;
/** 双色档墨色格的下沉量（mm）—— 不携带数据位。 */
export const INK_SUNK_MM = 0.05;
/** 静区（mm）。 */
export const QUIET_MM = 6.0;

/** 顶点焊接的小数位数；3MF 的坐标文本用同一位数（见 threeMF.js）。 */
export const WELD_DECIMALS = 6;

/** 圆分段下限/上限（偶数）：24 段 ⇒ 多边形面积偏差 (2π/24)²/6 ≈ 1.1%。 */
export const MIN_FACETS = 24;
export const MAX_FACETS = 96;

/** G8 §6.3 判据：逐格投影面积差 <8%。 */
export const PROJECTION_TOL_PCT = 8;

// 这条不是注释里的安慰：它成立，"下沉不携带数据位"才是可论证的。
if (INK_SUNK_MM * 2 >= RELIEF_MM) {
  throw new Error(`plate.js: INK_SUNK_MM=${INK_SUNK_MM} must stay below half of RELIEF_MM=${RELIEF_MM}`);
}

/**
 * 一格某一 shape 档的顶面 Z（mm）。
 *
 * level 0 也占一级高：`glyphMaskForLevel` 在 level 0 仍然打印外环（点径=0），所以
 * "有形状"不等于"有高度台阶"，最低一档也必须真的有一层料 —— 用 (level+1)×RELIEF_MM
 * 而不是 level×RELIEF_MM，否则 level 0 会被挤成 0 高、被 `requireZBand` 直接拒掉，
 * 那一格在网格上就消失了（与掩码不同形）。
 */
export function reliefTopMm(level, { sunk = false } = {}) {
  if (!Number.isInteger(level) || level < 0) throw new RangeError(`reliefTopMm: bad level ${String(level)}`);
  return PLATE_MM + (level + 1) * RELIEF_MM - (sunk ? INK_SUNK_MM : 0);
}

/**
 * 一圈分多少段：让**弦长不超过一个挤出宽度**（比 EW 还细的分段打印机不会多画出任何
 * 东西，只会把文件撑大），同时不小于 MIN_FACETS（面积偏差 <1.2%）。纯函数、确定性。
 */
export function reliefSegments(outerRadiusMm, ewMm) {
  if (!(outerRadiusMm > 0) || !Number.isFinite(outerRadiusMm)) throw new RangeError(`reliefSegments: outerRadiusMm=${outerRadiusMm}`);
  if (!(ewMm > 0) || !Number.isFinite(ewMm)) throw new RangeError(`reliefSegments: ewMm=${ewMm}`);
  let n = MIN_FACETS;
  while (n < MAX_FACETS && 2 * outerRadiusMm * Math.sin(Math.PI / n) > ewMm) n += 4;
  return Math.min(n, MAX_FACETS);
}

/** 该 shape 档的中心圆点比例半径 —— 与 `glyphMaskForLevel` 的分支**逐字同构**。 */
export function dotFractionForLevel(level, geo) {
  if (geo && geo.dot) return geo.dot[level] ?? 0;
  // 理想几何没有量化点径表，glyphMaskForLevel 走的是 rhoFor -> dotRadiusForRho；
  // 这里复用同一对导出函数，不另写公式。
  return dotRadiusForRho(rhoFor(level, geo.shapeLevels));
}

/**
 * 一格的实体 = 参考环 +（可选）中心圆点。半径全部 = geo 的比例 × 印刷格宽；
 * 这个函数里不许出现任何字面半径。
 */
function cellSolids({ centreXmm, centreYmm, pitchMm, geo, shapeLevel, zBottom, zTop, segments }) {
  const outerR = geo.outer * pitchMm;
  const innerR = geo.inner * pitchMm;
  const dotR = dotFractionForLevel(shapeLevel, geo) * pitchMm;
  const tris = [ringTriangles({ outerRadiusMm: outerR, innerRadiusMm: innerR, zBottom, zTop, segments, offsetXmm: centreXmm, offsetYmm: centreYmm })];
  if (dotR > 0) {
    if (!(dotR < innerR)) {
      throw new Error(`cellSolids: dot radius ${dotR} is not strictly inside the annulus hole ${innerR} (shapeLevels=${geo.shapeLevels})`);
    }
    tris.push(discTriangles({ radiusMm: dotR, zBottom, zTop, segments, offsetXmm: centreXmm, offsetYmm: centreYmm }));
  }
  return { tris, dotRadiusMm: dotR, outerRadiusMm: outerR, innerRadiusMm: innerR };
}

/**
 * 朝上三角形在 XY 平面的投影面积之和（mm²）。
 *
 * 侧壁三角形在 XY 上退化（两条边共线）⇒ 投影面积恒为 0；底面法向朝 −Z ⇒ 不计。
 * 所以这个和就是该三角形集合的"顶面投影"，正是 G8 §6.3 拿去和渲染掩码面积比的那个数。
 */
export function projectedUpAreaMm2(triangles) {
  let sum = 0;
  for (let t = 0; t + 8 < triangles.length; t += 9) {
    const ax = triangles[t], ay = triangles[t + 1];
    const bx = triangles[t + 3], by = triangles[t + 4];
    const cx = triangles[t + 6], cy = triangles[t + 7];
    const nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (nz > 0) sum += nz / 2;
  }
  return sum;
}

/**
 * 主入口：一页 → 可编码的部件列表 + 同一批三角形（STL 用）+ 可对拍的事实。
 *
 * @param {object} o
 * @param {object} o.geom     `planPage()` 的结果
 * @param {Uint16Array} o.levels  该页每格的打包档值（row-major，与渲染器同一份输入）
 * @param {object} o.layout `pageLayout()` 的结果（它已经算好 cellEw / glyph / originPx）
 * @param {boolean} [o.mono]  单色渲染：没有第二种料，也就不存在墨盒，一律不下沉
 * @param {string} [o.palette] 料号显示用的调色板 id
 * @param {number} [o.segments] 覆盖分段数（测试可用小值；默认按 EW 推导）
 */
export function buildPlateModel({ geom, levels, layout, mono = false, palette = null, segments = null } = {}) {
  if (!geom || geom.medium !== 'plate') {
    throw new Error(
      `plate: ${(geom && geom.profile) || '?'} is medium "${geom && geom.medium}" —— --format stl|3mf 只吃板材档。` +
        `MESH-CONTRACT.md §3：纸面档 cellEw 为 null，没有挤出宽度可量化半径，绝不按 0.4mm 猜一个。`,
    );
  }
  if (!layout || !layout.glyph) throw new Error('buildPlateModel: layout must come from pageLayout()');
  if (!layout.glyph.ok) throw new Error(`buildPlateModel: glyphGeometry refused this cell: ${layout.glyph.reason}`);
  const shapeCh = (geom.channels || []).find((c) => c.name === 'shape');
  if (!shapeCh) {
    throw new Error(
      `buildPlateModel: profile ${geom.profile} has no 'shape' channel (${(geom.channels || []).map((c) => c.name).join(', ')}); ` +
        `height-only profiles (REL-*) are not wired to the mesh path`,
    );
  }
  if (!levels || levels.length < geom.totalCells) {
    throw new RangeError(`buildPlateModel: expected ${geom.totalCells} levels, got ${levels ? levels.length : 'none'}`);
  }
  const ewMm = geom.nozzle ? getNozzle(geom.nozzle).ewMm : geom.pitchMm / layout.cellEw;
  if (!(ewMm > 0) || !Number.isFinite(ewMm)) throw new Error(`buildPlateModel: no usable extrusion width (nozzle=${geom.nozzle}, cellEw=${layout.cellEw})`);

  // ── 印刷坐标系：格位与格宽都用 **像素量化后** 的尺寸。渲染器画出来的是整数像素：
  //    cellPx = round(pitchMm*dpi/25.4)，所以印刷格宽 = cellPx*25.4/dpi 与名义 pitch
  //    差几十微米；40 格累计就是近半格的漂移，投影对拍会整片错位。
  const dpi = layout.dpi;
  const mmPerPx = MM_PER_INCH / dpi;
  const pitchMm = layout.cellPx * mmPerPx;
  const originXmm = layout.originPx.x * mmPerPx;
  const originYmm = layout.originPx.y * mmPerPx;
  const pageWMm = layout.width * mmPerPx;
  const pageHMm = layout.height * mmPerPx;
  const geo = layout.glyph;

  // 静区：版面外沿到点阵的最小边距必须 ≥ QUIET_MM（§2）。不满足就拒绝出图，不"差不多就行"。
  const latticeWMm = geom.cols * pitchMm;
  const latticeHMm = geom.rows * pitchMm;
  const marginMm = Math.min(originXmm, originYmm, pageWMm - (originXmm + latticeWMm), pageHMm - (originYmm + latticeHMm));
  if (!(marginMm + 1e-9 >= QUIET_MM)) {
    throw new Error(`buildPlateModel: quiet margin ${marginMm.toFixed(3)}mm < QUIET_MM ${QUIET_MM}mm (MESH-CONTRACT §2)`);
  }

  const seg = segments ?? reliefSegments(geo.outer * pitchMm, ewMm);
  if (!Number.isInteger(seg) || seg < 3) throw new RangeError(`buildPlateModel: segments must be an integer >= 3, got ${seg}`);
  const colourCh = (geom.channels || []).find((c) => c.name === 'colour') || null;
  const colourLevels = colourCh ? colourCh.levels : 1;
  const canSink = !!colourCh && !mono;

  const base = boxTriangles({ xMinMm: 0, xMaxMm: pageWMm, yMinMm: 0, yMaxMm: pageHMm, zBottom: 0, zTop: PLATE_MM });

  /** 按 colour 档分桶（=按料分"合并岛"）；桶内所有格子焊成一个部件。 */
  const buckets = Array.from({ length: colourLevels }, (_, i) => ({ colourLevel: i, parts: [], solids: 0 }));
  const cells = [];
  for (let r = 0; r < geom.rows; r++) {
    for (let c = 0; c < geom.cols; c++) {
      const idx = r * geom.cols + c;
      const parts = splitCellLevel(levels[idx], geom);
      const shapeLevel = parts.shape | 0;
      const colourLevel = parts.colour === undefined ? 0 : parts.colour | 0;
      if (shapeLevel < 0 || shapeLevel >= shapeCh.levels) {
        throw new RangeError(`buildPlateModel: cell ${idx} shape level ${shapeLevel} out of range 0..${shapeCh.levels - 1}`);
      }
      const sunk = canSink && colourLevel > 0;
      const zTop = reliefTopMm(shapeLevel, { sunk });
      // 模型 +Y 指向版面"后"沿（图像第 0 行在顶）⇒ Y 要翻折；与 prismFromMask 的
      // rectToMm 同源约定，保证印出来的浮雕与位图同手性（不镜像）。
      const cx = originXmm + (c + 0.5) * pitchMm;
      const cy = pageHMm - (originYmm + (r + 0.5) * pitchMm);
      const solid = cellSolids({ centreXmm: cx, centreYmm: cy, pitchMm, geo, shapeLevel, zBottom: PLATE_MM, zTop, segments: seg });
      const bucket = buckets[colourLevel];
      for (const t of solid.tris) {
        bucket.parts.push(t);
        bucket.solids += 1;
      }
      // 注意：这里**不**记任何"这一格的面积"。面积只在 `projectTopToCells()` 里从
      // 三角形集合按几何算出来 —— 装配顺手记一份、对拍再算一份，就会有第二个真值来源。
      cells.push({
        col: c,
        row: r,
        shapeLevel,
        colourLevel,
        sunk,
        centreMm: { x: cx, y: cy },
        topMm: zTop,
        dotRadiusMm: solid.dotRadiusMm,
        outerRadiusMm: solid.outerRadiusMm,
        innerRadiusMm: solid.innerRadiusMm,
      });
    }
  }

  const paletteId = palette || (colourLevels > 2 ? 'INK4' : colourLevels > 1 ? 'INK2' : 'PAPER1');
  const pal = getPalette(paletteId);
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
    });
  }
  for (const b of buckets) {
    if (!b.parts.length) continue;
    const w = weldOne(b.parts);
    objects.push({
      name: `relief-ink${b.colourLevel}`,
      kind: 'relief',
      colourLevel: b.colourLevel,
      sunk: canSink && b.colourLevel > 0,
      solids: b.solids,
      materialName: `${paletteId}:ink${b.colourLevel}`,
      displayColor: rgbaHex(pal.inks[b.colourLevel % pal.inks.length]),
      vertices: w.vertices,
      indices: w.indices,
      triangles: expandIndexedTriangles(w.vertices, w.indices),
      bbox: boundingBox(w.vertices),
    });
  }

  // STL 侧：把所有部件"焊接后展开"的三角形按部件顺序拼成**同一个**三角形集合。
  // 3MF 存索引化的那一份，STL 只能存展开的那一份，两边同源 => 对拍才有意义。
  let total = 0;
  for (const o of objects) total += o.triangles.length;
  const triangles = new Float64Array(total);
  let at = 0;
  for (const o of objects) {
    triangles.set(o.triangles, at);
    at += o.triangles.length;
  }

  const facts = {
    profile: geom.profile,
    nozzle: geom.nozzle || null,
    ewMm,
    cellEw: layout.cellEw,
    pitchMmNominal: geom.pitchMm,
    pitchMmPrinted: pitchMm,
    dpi,
    mmPerPx,
    cellPx: layout.cellPx,
    cols: geom.cols,
    rows: geom.rows,
    originMm: { x: originXmm, y: originYmm },
    pageMm: { w: pageWMm, h: pageHMm },
    requestedPlateMm: geom.sheetMm ? geom.sheetMm.w : null,
    quietMarginMm: marginMm,
    yAxisFlipped: true, // model Y = pageHMm - imageY_mm
    plateMm: PLATE_MM,
    reliefMm: RELIEF_MM,
    inkSunkMm: INK_SUNK_MM,
    quietMm: QUIET_MM,
    segments: seg,
    weldDecimals: WELD_DECIMALS,
    shapeLevels: shapeCh.levels,
    colourLevels,
    sinkActive: canSink,
    monoRender: !!mono,
    palette: paletteId,
    bitsPerCell: geom.bitsPerCell,
    glyph: {
      cellEw: geo.cellEw ?? null,
      shapeLevels: geo.shapeLevels,
      quantised: !!geo.quantised,
      outer: geo.outer,
      inner: geo.inner,
      dot: geo.dot ? Array.from(geo.dot) : null,
    },
    objects: objects.map((o) => ({
      name: o.name,
      kind: o.kind,
      vertices: o.vertices.length / 3,
      triangles: o.indices.length / 3,
      materialName: o.materialName,
      displayColor: o.displayColor,
    })),
    trianglesTotal: triangles.length / 9,
    bbox: boundingBox(triangles),
    // 跨部件接触面的真相（实测，不是推测）：把全部部件合成**一张** mesh 再数边，
    // "每条无向边恰用两次"照样成立 —— 因为各浮雕脚底的短边落在底板顶面那两个大
    // 三角形的**内部**，两边根本不共边。也就是说这条计数在合并 mesh 上什么也没证明：
    // 那里有一对共面重叠的面（底板顶面 vs 浮雕脚底），那是一个自相交的壳集合，不是
    // 布尔并。所以判据只在**单个部件**内有意义，合并体的状态如实记在这里。
    assembly: {
      objectsWatertightEach: 'asserted by threeMF.encode3MF()/manifoldReportIndexed() at write time -- a file only exists if every object passed',
      mergedMeshEdgeCensus: 'passes (every undirected edge used exactly twice)',
      mergedMeshIsValidUnion: false,
      reason:
        'plate top face and every relief foot are coplanar at z=PLATE_MM and overlap in XY; the merged mesh therefore has coincident ' +
        'internal faces. It is not a boolean union, and MESH-CONTRACT.md §4 forbids claiming one -- slicers resolve the overlap by ' +
        'treating each closed shell as its own extrusion, which is exactly the per-object reading used here.',
    },
    // 模型里没有建模的东西也要说清楚，别让人以为文件"看起来全了"。
    notModelled: [
      'corner fiducials and the echo strip: their radii/line widths are pixel-derived in core/render, not glyphGeometry radii, ' +
        'and MESH-CONTRACT.md §3 forbids inventing radii -- so the plate carries the data lattice only.',
    ],
    projection: null, // 由 projectTopToCells()/projectionReport() 填
  };

  return { objects, triangles, cells, facts, geom, layout, levels };
}

/**
 * 渲染层参考面积：每一 shape 档"这一格里真正被印出来的面积"（mm²）。
 *
 * 用的是渲染器自己的 `buildCoverageTiles()`（同一份 `glyphMaskForLevel`、同一个
 * `cellPx`、同样的 4× 超采样），不是另外算的圆面积，也不是"shape>0 才有料"这种和装配
 * 同源的判断 —— `shape` 档 0 也有一圈外环，参考值必须反映这一点，否则对拍就是空转。
 */
export function renderReferenceAreas({ layout, shapeLevels, pitchMm }) {
  const tiles = buildCoverageTiles(layout.cellPx, shapeLevels, layout.glyph);
  const cellArea = pitchMm * pitchMm;
  const denom = layout.cellPx * layout.cellPx * 255;
  return tiles.map((tile, level) => {
    let acc = 0;
    for (let i = 0; i < tile.length; i++) acc += tile[i];
    const coverFraction = acc / denom;
    return { level, coverFraction, areaMm2: coverFraction * cellArea, cellAreaMm2: cellArea };
  });
}

/** 三角形（2D）对轴对齐矩形的 Sutherland–Hodgman 裁剪面积。 */
function clipArea(x0, y0, x1, y1, x2, y2, rect) {
  const [rxMin, ryMin, rxMax, ryMax] = rect;
  let poly = [x0, y0, x1, y1, x2, y2];
  // 四个半平面：coord=0 是 x、1 是 y；keepMin=true 表示"留下 >= bound 的那侧"
  for (const [coord, bound, keepMin] of [
    [0, rxMin, true],
    [0, rxMax, false],
    [1, ryMin, true],
    [1, ryMax, false],
  ]) {
    const out = [];
    for (let i = 0; i < poly.length; i += 2) {
      const j = (i + 2) % poly.length;
      const av = poly[i + coord];
      const bv = poly[j + coord];
      const aIn = keepMin ? av >= bound : av <= bound;
      const bIn = keepMin ? bv >= bound : bv <= bound;
      if (aIn) out.push(poly[i], poly[i + 1]);
      if (aIn !== bIn) {
        const t = (bound - av) / (bv - av);
        out.push(poly[i] + t * (poly[j] - poly[i]), poly[i + 1] + t * (poly[j + 1] - poly[i + 1]));
      }
    }
    poly = out;
    if (poly.length < 6) return 0;
  }
  let a = 0;
  for (let i = 0; i < poly.length; i += 2) {
    const j = (i + 2) % poly.length;
    a += poly[i] * poly[j + 1] - poly[j] * poly[i + 1];
  }
  return Math.abs(a) / 2;
}

/**
 * G8 §6.3 的对拍本体：**把顶面三角形投影回格子网格，逐格复现渲染页掩码**。
 *
 * 三条都是故意的：
 *  1. 入参是"三角形 + 布局"，不是"装配时顺手记的面积" —— 调用方一般把**从文件读回来**
 *     的那份三角形喂进来（`ref/verify_model.py` 从 3MF 自己算一遍，两边互为反证）。
 *  2. 落格是纯几何的：按投影三角形的 bbox 找它压到哪几格，跨界就用矩形裁剪把面积
 *     **分账**给相邻格 ⇒ 把某一格的半径改大，相邻格立刻出现"白得的料"，误差爆表。
 *  3. 期望值来自 `renderReferenceAreas()`（光栅侧 `buildCoverageTiles` ⇒ 同一份
 *     `glyphMaskForLevel`），shape 档 0 也有外环面积 ⇒ 不会像"shape>0 才有料"那样空转。
 *
 * @param {Float64Array} triangles 扁平三角形（9 个 double 一三角）
 * @param {object} o
 * @param {object} o.geom     planPage() 结果
 * @param {object} o.layout pageLayout() 结果
 * @param {Uint16Array} o.levels 每格打包档值（决定每格期望的是哪一档）
 * @param {number} [o.tolPct=8] 逐格面积差容差（百分比）
 * @param {number} [o.floorZmm=PLATE_MM] 低于这个 Z 的朝上面不算浮雕（底板顶面）
 */
export function projectTopToCells(triangles, { geom, layout, levels, tolPct = PROJECTION_TOL_PCT, floorZmm = PLATE_MM } = {}) {
  if (!geom || !layout || !levels) throw new Error('projectTopToCells: needs {geom, layout, levels}');
  const shapeCh = (geom.channels || []).find((c) => c.name === 'shape');
  if (!shapeCh) throw new Error(`projectTopToCells: profile ${geom.profile} has no shape channel`);
  const mmPerPx = MM_PER_INCH / layout.dpi;
  const pitchMm = layout.cellPx * mmPerPx;
  const originXmm = layout.originPx.x * mmPerPx;
  const originYmm = layout.originPx.y * mmPerPx;
  const pageHMm = layout.height * mmPerPx;
  const cols = geom.cols;
  const rows = geom.rows;
  const total = cols * rows;
  const ref = renderReferenceAreas({ layout, shapeLevels: shapeCh.levels, pitchMm });
  const refArea = ref.map((r) => r.areaMm2);
  const mesh = new Float64Array(total);

  const cellOf = (x, y) => {
    const c = Math.floor((x - originXmm) / pitchMm);
    const r = Math.floor((pageHMm - y - originYmm) / pitchMm);
    return [c, r];
  };
  const rectOf = (c, r) => [originXmm + c * pitchMm, pageHMm - (originYmm + (r + 1) * pitchMm), originXmm + (c + 1) * pitchMm, pageHMm - (originYmm + r * pitchMm)];

  let upTris = 0;
  let straddling = 0;
  let outsideMm2 = 0;
  const detail = [];
  for (let t = 0; t + 8 < triangles.length; t += 9) {
    const ax = triangles[t], ay = triangles[t + 1], az = triangles[t + 2];
    const bx = triangles[t + 3], by = triangles[t + 4], bz = triangles[t + 5];
    const cx = triangles[t + 6], cy = triangles[t + 7], cz = triangles[t + 8];
    const nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (!(nz > 0)) continue; // 侧壁投影面积为 0、底面法向朝 −Z：都不算顶面
    if (az <= floorZmm && bz <= floorZmm && cz <= floorZmm) continue; // 底板顶面不是浮雕
    upTris++;
    const area = nz / 2;
    const xMin = Math.min(ax, bx, cx), xMax = Math.max(ax, bx, cx);
    const yMin = Math.min(ay, by, cy), yMax = Math.max(ay, by, cy);
    const [c0, r0] = cellOf(xMin, yMax); // 左上角：x 最小、model y 最大 ⇒ 图像行最小
    const [c1, r1] = cellOf(xMax, yMin);
    if (c0 === c1 && r0 === r1 && c0 >= 0 && c0 < cols && r0 >= 0 && r0 < rows) {
      mesh[r0 * cols + c0] += area;
      continue;
    }
    straddling++;
    for (let r = Math.max(0, Math.min(r0, r1)); r <= Math.min(rows - 1, Math.max(r0, r1)); r++) {
      for (let c = Math.max(0, Math.min(c0, c1)); c <= Math.min(cols - 1, Math.max(c0, c1)); c++) {
        const a = clipArea(ax, ay, bx, by, cx, cy, rectOf(c, r));
        if (a > 0) mesh[r * cols + c] += a;
        outsideMm2 += 0; // 落在点阵外的部分在下面单独统计
      }
    }
    // 裁剪后没进任何格的部分 = 点阵之外的材料（静区里长出料，同样是缺陷）
    let inside = 0;
    for (let r = Math.min(r0, r1); r <= Math.max(r0, r1); r++) {
      for (let c = Math.min(c0, c1); c <= Math.max(c0, c1); c++) {
        if (c >= 0 && c < cols && r >= 0 && r < rows) inside += clipArea(ax, ay, bx, by, cx, cy, rectOf(c, r));
      }
    }
    const spilled = area - inside;
    if (spilled > 1e-9) outsideMm2 += spilled;
  }

  let maxPct = 0;
  let sumPct = 0;
  let over = 0;
  let inkedMismatch = 0;
  let worst = null;
  const cellArea = pitchMm * pitchMm;
  for (let i = 0; i < total; i++) {
    const shape = splitCellLevel(levels[i], geom).shape | 0;
    const want = refArea[shape];
    if (!(want > 0)) throw new Error(`projectTopToCells: raster reference for shape level ${shape} is ${want} (a level with no ink cannot be area-compared)`);
    const got = mesh[i];
    const pct = (Math.abs(got - want) / want) * 100;
    sumPct += pct;
    if (pct > maxPct) {
      maxPct = pct;
      worst = { col: i % cols, row: Math.floor(i / cols), shapeLevel: shape, meshAreaMm2: got, renderAreaMm2: want };
    }
    if (pct >= tolPct) {
      over++;
      if (detail.length < 6) detail.push(`cell ${i % cols},${Math.floor(i / cols)} level=${shape} mesh=${got.toFixed(4)}mm2 render=${want.toFixed(4)}mm2 err=${pct.toFixed(1)}%`);
    }
    // 逐格"有/无材料"也必须一致（面积之外的第二道：空格不得有料、有料格不得空）
    const wantInk = want > cellArea * 1e-6;
    const gotInk = got > cellArea * 1e-6;
    if (wantInk !== gotInk) inkedMismatch++;
  }
  const n = total || 1;
  return {
    cells: total,
    upTriangles: upTris,
    straddlingTriangles: straddling,
    materialOutsideLatticeMm2: outsideMm2,
    tolerancePct: tolPct,
    maxPct,
    meanPct: sumPct / n,
    cellsOverTolerance: over,
    inkedMismatch,
    ok: total > 0 && over === 0 && inkedMismatch === 0 && straddling === 0 && outsideMm2 < 1e-9,
    worst,
    reference: ref,
    detail,
  };
}

/** 便捷包装：对 `buildPlateModel` 的结果直接量一遍（同样只走几何，不用装配顺手记的数）。 */
export function projectionReport(model, opt = {}) {
  const out = projectTopToCells(model.triangles, {
    geom: model.geom,
    layout: model.layout,
    levels: model.levels,
    tolPct: opt.tolPct ?? PROJECTION_TOL_PCT,
  });
  model.facts.projection = {
    cells: out.cells,
    tolerancePct: out.tolerancePct,
    maxPct: out.maxPct,
    meanPct: out.meanPct,
    cellsOverTolerance: out.cellsOverTolerance,
    inkedMismatch: out.inkedMismatch,
    straddlingTriangles: out.straddlingTriangles,
    materialOutsideLatticeMm2: out.materialOutsideLatticeMm2,
    ok: out.ok,
    worst: out.worst,
  };
  return out;
}

function rgbaHex(rgb) {
  return '#' + rgb.map((v) => Math.max(0, Math.min(255, v | 0)).toString(16).padStart(2, '0').toUpperCase()).join('') + 'FF';
}
