/**
 * core/mesh/solids.js — 3D 网格产物底层之一：把"浮雕图案的一格"变成三角形集合。
 *
 * 纯 ESM、零依赖、Node 与浏览器同一份：不得 import 任何 `node:` 模块，
 * 只用 Uint8Array / Float64Array / DataView。
 *
 * ── 诚实声明（务必读完再用本文件）────────────────────────────────────────────
 *   NO CSG UNION HERE. This module only EXTRUDES and STACKS solids.
 *   If two solids overlap inside the same Z band the resulting mesh KEEPS
 *   INTERNAL FACES; slicers handle this via even-odd / extrusion merging.
 *   Nothing in this file produces (or claims) a watertight boolean union.
 *
 *   中文：本文件只提供"挤出 + 堆叠"。同一 Z 区间内两个实体相交时，网格内部会
 *   保留相交面（不是水密并集）。若需要真正的水密声明，请走 3MF 路径并用
 *   逐像素掩码覆盖不变式（rectsCoverMaskExact）自证，不要靠 STL 猜测。
 *
 * ── 确定性 ───────────────────────────────────────────────────────────────────
 *   所有顶点都来自"索引化生成"：一个圆的 cos/sin 只按 i/segments 计算一次并放进
 *   顶点表，三角形只引用顶点表下标，因此相邻三角形共享**完全相同**的坐标数值。
 *   代码里没有任何 Math.random / Date / 对象键遍历顺序依赖（Map 走插入顺序）。
 *   同样的入参 → 逐元素相同的输出，这是 STL 逐字节确定性的前提。
 *
 * ── 绕序约定 ─────────────────────────────────────────────────────────────────
 *   不写显式法向；用顶点顺序表达。三角形 [A,B,C] 的外法向 = (B-A) × (C-A)
 *   （右手定则，与 STL 规范一致）。顶面朝 +Z、底面朝 −Z、侧壁朝材料外侧。
 */

/** 通用浮点比较容差（单位：mm）。 */
export const EPS = 1e-9;

const TAU = Math.PI * 2;

/** 每个矩形挤出的三角形数：2 顶 + 2 底 + 4 侧壁×2。 */
export const TRIANGLES_PER_RECT = 12;

/** 一个圆的挤出体：顶 segments + 底 segments + 侧壁 segments*2。 */
export function discTriangleCount(segments) {
  return segments * 4;
}

/** 一个环（垫圈）挤出体：顶 2s + 底 2s + 外壁 2s + 内壁 2s。 */
export function ringTriangleCount(segments) {
  return segments * 8;
}

/* ───────────────────────────── 内部小工具 ───────────────────────────── */

function assertFinite(label, value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label}: expected a finite number, got ${String(value)}`);
  }
}

/** 校验分段数：必须是 ≥3 的整数（多边形近似至少是三角形）。 */
function requireSegments(label, segments) {
  assertFinite(`${label}: segments`, segments);
  if (!Number.isInteger(segments) || segments < 3) {
    throw new Error(`${label}: segments must be an integer >= 3, got ${String(segments)}`);
  }
  return segments;
}

/** 校验 Z 区间非退化（否则所有三角形面积为 0，会被 assertNoDegenerate 拒掉）。 */
function requireZBand(label, zBottom, zTop) {
  assertFinite(`${label}: zBottom`, zBottom);
  assertFinite(`${label}: zTop`, zTop);
  if (Math.abs(zTop - zBottom) <= EPS) {
    throw new Error(`${label}: degenerate Z band zBottom=${zBottom} zTop=${zTop} (|dz| <= ${EPS})`);
  }
}

/**
 * 索引化顶点表：生成器只往表里 push 一次坐标，三角形记录表下标。
 * 这样"焊接"在生成阶段就已经成立——共享顶点是同一个数值，不是各算一遍。
 */
function builder() {
  /** @type {number[]} 扁平 xyz 顶点表 */
  const v = [];
  /** @type {number[]} 每 3 个下标一个三角形 */
  const t = [];
  return {
    vertex(x, y, z) {
      v.push(x, y, z);
      return v.length / 3 - 1;
    },
    triangle(a, b, c) {
      t.push(a, b, c);
    },
    vertexCount() {
      return v.length / 3;
    },
    triangleCount() {
      return t.length / 3;
    },
    /** 展开成扁平三角形顶点数组（长度 = 三角形数 × 9）。 */
    finish() {
      const out = new Float64Array(t.length * 3);
      let o = 0;
      for (let k = 0; k < t.length; k++) {
        const b = t[k] * 3;
        out[o++] = v[b];
        out[o++] = v[b + 1];
        out[o++] = v[b + 2];
      }
      return out;
    },
  };
}

/**
 * 单位圆顶点表（按 i/segments 均匀分布，起点角度 0）。
 * 只在调用内算一次 cos/sin，半径/偏移在写顶点时线性缩放 → 确定性。
 */
function unitRing(segments) {
  const xs = new Float64Array(segments);
  const ys = new Float64Array(segments);
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * TAU;
    xs[i] = Math.cos(a);
    ys[i] = Math.sin(a);
  }
  return { xs, ys };
}

/* ───────────────────────────── 圆（实心盘）───────────────────────────── */

/**
 * 实心圆盘挤出体（顶/底扇形 + 侧壁）。
 *
 * @param {object}  o
 * @param {number}  o.radiusMm   半径（mm），> EPS
 * @param {number}  o.zBottom    底面 Z（mm）
 * @param {number}  o.zTop       顶面 Z（mm）
 * @param {number}  o.segments   分段数（多边形近似），整数 ≥3
 * @param {number} [o.offsetXmm=0]
 * @param {number} [o.offsetYmm=0]
 * @returns {Float64Array} 三角形顶点扁平数组，长度 = segments*4*9
 */
export function discTriangles({ radiusMm, zBottom, zTop, segments, offsetXmm = 0, offsetYmm = 0 } = {}) {
  const label = 'discTriangles';
  const seg = requireSegments(label, segments);
  assertFinite(`${label}: radiusMm`, radiusMm);
  if (!(radiusMm > EPS)) {
    throw new Error(`${label}: radiusMm must be > ${EPS}, got ${String(radiusMm)}`);
  }
  assertFinite(`${label}: offsetXmm`, offsetXmm);
  assertFinite(`${label}: offsetYmm`, offsetYmm);
  requireZBand(label, zBottom, zTop);

  const { xs, ys } = unitRing(seg);
  const B = builder();
  const cx = offsetXmm;
  const cy = offsetYmm;
  const cTop = B.vertex(cx, cy, zTop);
  const cBot = B.vertex(cx, cy, zBottom);

  const top = new Array(seg);
  const bot = new Array(seg);
  for (let i = 0; i < seg; i++) {
    const px = cx + radiusMm * xs[i];
    const py = cy + radiusMm * ys[i];
    top[i] = B.vertex(px, py, zTop);
    bot[i] = B.vertex(px, py, zBottom);
  }

  for (let i = 0; i < seg; i++) {
    const j = (i + 1) % seg;
    // 顶面：圆心 + CCW 相邻两点 → (B-A)×(C-A) 朝 +Z
    B.triangle(cTop, top[i], top[j]);
    // 底面：镜像绕序 → 朝 −Z
    B.triangle(cBot, bot[j], bot[i]);
    // 侧壁：两条三角形，法向沿半径朝外（材料外侧）
    B.triangle(top[i], bot[j], top[j]);
    B.triangle(top[i], bot[i], bot[j]);
  }
  return B.finish();
}

/* ───────────────────────────── 环（带孔）────────────────────────────── */

/**
 * 环形（垫圈）挤出体：外壁法向朝外，孔壁法向朝孔心（= 材料内侧），
 * 顶/底面是真正的**环形三角化**（内外两圈顶点连成四边形），
 * 不是"外圆减内圆"的假三角形。
 *
 * @returns {Float64Array} 长度 = segments*8*9
 * @throws {Error} 当 outerRadiusMm <= innerRadiusMm + EPS（消息含 `ring:` 与两个半径）
 */
export function ringTriangles({
  outerRadiusMm,
  innerRadiusMm,
  zBottom,
  zTop,
  segments,
  offsetXmm = 0,
  offsetYmm = 0,
} = {}) {
  const label = 'ringTriangles';
  const seg = requireSegments(label, segments);
  assertFinite(`${label}: outerRadiusMm`, outerRadiusMm);
  assertFinite(`${label}: innerRadiusMm`, innerRadiusMm);
  assertFinite(`${label}: offsetXmm`, offsetXmm);
  assertFinite(`${label}: offsetYmm`, offsetYmm);
  requireZBand(label, zBottom, zTop);

  if (!(outerRadiusMm > innerRadiusMm + EPS)) {
    throw new Error(
      `ring: outerRadiusMm=${outerRadiusMm} must exceed innerRadiusMm=${innerRadiusMm} ` +
        `by more than EPS=${EPS} (a ring whose hole is not strictly inside the outer wall ` +
        `has no material cross-section)`,
    );
  }
  if (!(innerRadiusMm > EPS)) {
    throw new Error(
      `ring: innerRadiusMm=${innerRadiusMm} must be > ${EPS}; use discTriangles() for a solid disc`,
    );
  }
  if (!(outerRadiusMm > EPS)) {
    throw new Error(`ring: outerRadiusMm=${outerRadiusMm} must be > ${EPS}`);
  }

  const { xs, ys } = unitRing(seg);
  const B = builder();
  const cx = offsetXmm;
  const cy = offsetYmm;

  const oTop = new Array(seg);
  const oBot = new Array(seg);
  const iTop = new Array(seg);
  const iBot = new Array(seg);
  for (let i = 0; i < seg; i++) {
    const ox = cx + outerRadiusMm * xs[i];
    const oy = cy + outerRadiusMm * ys[i];
    const ix = cx + innerRadiusMm * xs[i];
    const iy = cy + innerRadiusMm * ys[i];
    oTop[i] = B.vertex(ox, oy, zTop);
    oBot[i] = B.vertex(ox, oy, zBottom);
    iTop[i] = B.vertex(ix, iy, zTop);
    iBot[i] = B.vertex(ix, iy, zBottom);
  }

  for (let i = 0; i < seg; i++) {
    const j = (i + 1) % seg;
    // 顶面环形（+Z）：外圈 CCW，内圈反向连
    B.triangle(oTop[i], oTop[j], iTop[j]);
    B.triangle(oTop[i], iTop[j], iTop[i]);
    // 底面环形（−Z）：每个三角形绕序取反
    B.triangle(oBot[i], iBot[j], oBot[j]);
    B.triangle(oBot[i], iBot[i], iBot[j]);
    // 外壁：法向沿半径朝外
    B.triangle(oTop[i], oBot[j], oTop[j]);
    B.triangle(oTop[i], oBot[i], oBot[j]);
    // 孔壁：法向沿半径朝孔心（材料内侧）
    B.triangle(iTop[i], iTop[j], iBot[j]);
    B.triangle(iTop[i], iBot[j], iBot[i]);
  }
  return B.finish();
}

/* ───────────────────── 掩码 → 最大矩形覆盖 → 挤出体 ───────────────────── */

function requireMask(maskRows) {
  if (!maskRows || typeof maskRows !== 'object') {
    throw new Error(`mask: expected { width, height, data:Uint8Array }, got ${String(maskRows)}`);
  }
  const { width, height, data } = maskRows;
  assertFinite('mask: width', width);
  assertFinite('mask: height', height);
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new Error(`mask: width/height must be positive integers, got ${width}x${height}`);
  }
  if (!(data instanceof Uint8Array)) {
    throw new Error('mask: data must be a Uint8Array (1 = material)');
  }
  if (data.length !== width * height) {
    throw new Error(`mask: data.length=${data.length} != width*height=${width * height}`);
  }
  return { width, height, data };
}

/**
 * 最大矩形贪心覆盖（greedy maximal rectangles）——"投影正确"的核心。
 *
 * 算法：维护 remaining = 尚未被覆盖的掩码像素。逐行扫描，找到本行一段连续的
 * remaining 像素 [x0,x1]，向下贪心扩展 y1 —— 只要下一行的**同一区间**仍全部
 * 未被覆盖就继续合并（同宽相邻行）。产出后把这些像素从 remaining 清零。
 *
 * 因为矩形只在 remaining 上生长，矩形之间互不相交，且并集恰好等于掩码
 * （见 rectsCoverMaskExact）——这是逐像素不变式，不是近似。
 *
 * @returns {Array<{x0:number,y0:number,x1:number,y1:number}>} 闭区间像素坐标
 */
export function greedyRectCover(maskRows) {
  const { width, height, data } = requireMask(maskRows);
  const remaining = new Uint8Array(width * height);
  for (let i = 0; i < remaining.length; i++) remaining[i] = data[i] ? 1 : 0;

  const rects = [];
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let x = 0;
    while (x < width) {
      if (!remaining[row + x]) {
        x += 1;
        continue;
      }
      let x1 = x;
      while (x1 + 1 < width && remaining[row + x1 + 1]) x1 += 1;

      let y1 = y;
      for (let yy = y + 1; yy < height; yy++) {
        const r = yy * width;
        let covered = true;
        for (let xx = x; xx <= x1; xx++) {
          if (!remaining[r + xx]) {
            covered = false;
            break;
          }
        }
        if (!covered) break;
        y1 = yy;
      }

      rects.push({ x0: x, y0: y, x1, y1 });
      for (let yy = y; yy <= y1; yy++) {
        const r = yy * width;
        for (let xx = x; xx <= x1; xx++) remaining[r + xx] = 0;
      }
      x = x1 + 1;
    }
  }
  return rects;
}

/** 由矩形列表重建位图（计数，非布尔）；用于逐像素比对。 */
export function maskFromRects(rects, width, height) {
  const out = new Uint8Array(width * height);
  for (const r of rects) {
    for (let y = r.y0; y <= r.y1; y++) {
      const row = y * width;
      for (let x = r.x0; x <= r.x1; x++) out[row + x] += 1;
    }
  }
  return out;
}

/**
 * 断言性检查：矩形的并集是否**逐像素**等于输入掩码（每格恰好覆盖一次）。
 * @returns {boolean}
 */
export function rectsCoverMaskExact(rects, maskRows) {
  const { width, height, data } = requireMask(maskRows);
  const built = maskFromRects(rects, width, height);
  for (let i = 0; i < built.length; i++) {
    if (built[i] !== (data[i] ? 1 : 0)) return false;
  }
  return true;
}

/**
 * 像素矩形 → mm 矩形。行 0 是图像**顶行**（+Y 最大），即掩码不做上下翻转，
 * 打印出来的浮雕与位图方向一致。
 */
function rectToMm(r, { pixelMm, height, originXmm, originYmm }) {
  const xMin = originXmm + r.x0 * pixelMm;
  const xMax = originXmm + (r.x1 + 1) * pixelMm;
  const yMin = originYmm + (height - 1 - r.y1) * pixelMm;
  const yMax = originYmm + (height - r.y0) * pixelMm;
  return { xMin, xMax, yMin, yMax };
}

/** 把一个 mm 矩形挤出成 12 个三角形，写进 builder。 */
function emitRect(B, m, zBottom, zTop) {
  const { xMin, xMax, yMin, yMax } = m;
  // 底面多边形角点按 CCW（从 +Z 看）排布：A 左下 → B 右下 → C 右上 → D 左上
  const a = B.vertex(xMin, yMin, zBottom);
  const b = B.vertex(xMax, yMin, zBottom);
  const c = B.vertex(xMax, yMax, zBottom);
  const d = B.vertex(xMin, yMax, zBottom);
  const aT = B.vertex(xMin, yMin, zTop);
  const bT = B.vertex(xMax, yMin, zTop);
  const cT = B.vertex(xMax, yMax, zTop);
  const dT = B.vertex(xMin, yMax, zTop);

  // 顶面（+Z）
  B.triangle(aT, bT, cT);
  B.triangle(aT, cT, dT);
  // 底面（−Z）：绕序取反
  B.triangle(a, c, b);
  B.triangle(a, d, c);

  // 四条侧壁：底边按 CCW 走 P→Q，则两条三角形为 [P顶, Q底, Q顶] 与 [P顶, P底, Q底]
  // （右手定则 → 法向指向该边外侧）。与 discTriangles 的侧壁模式保持一致。
  // 边 A→B（yMin 侧，外法向 −Y）
  B.triangle(aT, b, bT);
  B.triangle(aT, a, b);
  // 边 B→C（xMax 侧，外法向 +X）
  B.triangle(bT, c, cT);
  B.triangle(bT, b, c);
  // 边 C→D（yMax 侧，外法向 +Y）
  B.triangle(cT, d, dT);
  B.triangle(cT, c, d);
  // 边 D→A（xMin 侧，外法向 −X）
  B.triangle(dT, a, aT);
  B.triangle(dT, d, a);
}

/**
 * 二值位图 → 挤出体网格（最大矩形覆盖，每矩形 12 个三角形）。
 *
 * 不做 CSG 布尔：相邻矩形在同一 Z 区间并存，共享面被各自重复生成（内部面）。
 *
 * @param {{width:number,height:number,data:Uint8Array}} maskRows  1 = 有材料
 * @param {object} o
 * @returns {{ triangles: Float64Array, stats: object }}
 */
export function prismFromMask(maskRows, { pixelMm, zBottom, zTop, originXmm = 0, originYmm = 0 } = {}) {
  const label = 'prismFromMask';
  const mask = requireMask(maskRows);
  assertFinite(`${label}: pixelMm`, pixelMm);
  if (!(pixelMm > EPS)) {
    throw new Error(`${label}: pixelMm must be > ${EPS}, got ${String(pixelMm)}`);
  }
  assertFinite(`${label}: originXmm`, originXmm);
  assertFinite(`${label}: originYmm`, originYmm);
  requireZBand(label, zBottom, zTop);

  const rects = greedyRectCover(mask);
  const coverageExact = rectsCoverMaskExact(rects, mask);
  if (!coverageExact) {
    // 绝不输出"看起来成功但是错"的几何：不变式破了就直接失败。
    throw new Error(`${label}: rect cover is NOT pixel-exact (${rects.length} rects, ${mask.width}x${mask.height})`);
  }

  let pixels = 0;
  for (let i = 0; i < mask.data.length; i++) if (mask.data[i]) pixels += 1;

  const B = builder();
  for (const r of rects) {
    emitRect(B, rectToMm(r, { pixelMm, height: mask.height, originXmm, originYmm }), zBottom, zTop);
  }
  const triangles = B.finish();
  return {
    triangles,
    stats: {
      rects: rects.length,
      coverageExact,
      width: mask.width,
      height: mask.height,
      filledPixels: pixels,
      triangles: triangles.length / 9,
      vertices: triangles.length / 3,
      pixelMm,
      zBottom,
      zTop,
      originXmm,
      originYmm,
      rectsList: rects,
    },
  };
}

/* ───────────────────────────── 顶点焊接 ───────────────────────────── */

function asTriangleArray(triangles) {
  if (!(triangles instanceof Float64Array) && !(triangles instanceof Float32Array) && !Array.isArray(triangles)) {
    throw new Error(`weld: expected Float64Array/Float32Array/array of triangle vertices, got ${String(triangles)}`);
  }
  if (triangles.length % 9 !== 0) {
    throw new Error(`weld: triangles length ${triangles.length} is not a multiple of 9`);
  }
  return triangles;
}

/**
 * 按坐标键焊接顶点。键 = `ix|iy|iz`，其中 i* = Math.round(coord * 10^decimals)
 * （定宽的**整数**键，用 | 分隔 → 无歧义、无浮点字符串歧义）。
 * Map 走插入顺序 → 输出确定性。
 *
 * 三角形数不变（indices.length === triangles.length / 3），顶点数只减不增。
 * 顶点表存的是**量化后的**坐标，因此 welding 本身是幂等的。
 */
export function weldTriangles(triangles, { decimals = 6 } = {}) {
  const arr = asTriangleArray(triangles);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 12) {
    throw new Error(`weld: decimals must be an integer in 0..12, got ${String(decimals)}`);
  }
  const scale = Math.pow(10, decimals);
  const seen = new Map();
  const vout = [];
  const idx = [];
  for (let i = 0; i < arr.length; i += 3) {
    const x = arr[i];
    const y = arr[i + 1];
    const z = arr[i + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      throw new Error(`weld: non-finite vertex at offset ${i}: [${x}, ${y}, ${z}]`);
    }
    const ix = Math.round(x * scale);
    const iy = Math.round(y * scale);
    const iz = Math.round(z * scale);
    const key = `${ix}|${iy}|${iz}`;
    let at = seen.get(key);
    if (at === undefined) {
      at = seen.size;
      seen.set(key, at);
      vout.push(ix / scale, iy / scale, iz / scale);
    }
    idx.push(at);
  }
  return {
    vertices: Float64Array.from(vout),
    indices: Uint32Array.from(idx),
  };
}

/* ───────────────────────────── 包围盒 ───────────────────────────── */

/**
 * @param {ArrayLike<number>} vertices 扁平 xyz
 * @returns {{min:number[],max:number[],size:number[],center:number[]}}
 */
export function boundingBox(vertices) {
  if (!vertices || vertices.length === 0) {
    throw new Error('boundingBox: empty vertex array');
  }
  if (vertices.length % 3 !== 0) {
    throw new Error(`boundingBox: length ${vertices.length} is not a multiple of 3`);
  }
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < vertices.length; i += 3) {
    const x = vertices[i], y = vertices[i + 1], z = vertices[i + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      throw new Error(`boundingBox: non-finite vertex at offset ${i}`);
    }
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  return {
    min: [minX, minY, minZ],
    max: [maxX, maxY, maxZ],
    size: [maxX - minX, maxY - minY, maxZ - minZ],
    center: [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2],
  };
}
