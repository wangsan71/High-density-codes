/**
 * core/mesh/rectilinear.js — 把"轴对齐矩形的并集"挤成一个**逐对象水密**的实体。
 *
 * 为什么需要它（而不是直接用 `solids.js` 的 `boxTriangles` 逐矩形挤出）：
 * `MESH-CONTRACT.md` §6.2 的判据是"**每条无向边恰被两个三角形使用**"，而 MTF 校准板上
 * 几乎每个墨区都是**互相贴边**的矩形（实心块挖孔 ⇒ 孔与孔之间的墨带；标尺的刻度贴在
 * 横杆上；角标是方环）。逐矩形挤出会让相邻两个盒子**共面重面** ⇒ 焊接后那条边被 4 个
 * 三角形用到 ⇒ 判据**结构性**不成立（这正是 `core/mesh/plate.js` 当年改用"环+圆点、
 * 彼此不相碰"的原因，见该文件头部）。`plate.js` 的走法对"格内不接触的圆环+圆点"有效，
 * 对"贴边的矩形并集"无效。
 *
 * 本文件走**扫描线**：把并集按 x 切成若干竖条，每条内是若干 y 区间；顶面/底面就是这些
 * "竖条 × 区间"四边形（内部边恰好被两个四边形共用），而**只出现一次的边**就是并集的边界
 * ⇒ 每条边界边挤出一面墙。于是水密不是"希望"，是构造出来的：**没有任何内部面**。
 * `manifoldReport()` 直接硬判，测试里另有一个"故意让两个矩形重叠 ⇒ 必须报不合法"的
 * 反例，证明这条判据在本文件上承重。
 *
 * 约定与 `solids.js` 一致：z=0 是打印床、材料在 z>0 侧、三角形 [A,B,C] 的外法向 =
 * (B−A)×(C−A)（右手定则，与 STL 规范一致）。纯 ESM、零依赖、不得 import `node:`。
 */

/** 坐标量化位数：与 weldTriangles/3MF 的 6 位小数一致，避免 1e-15 级差异把边算成两条。 */
const COORD_QUANT = 1e6;

const q = (v) => Math.round(v * COORD_QUANT);

/**
 * @param {{x0:number,x1:number,y0:number,y1:number}[]} rects 轴对齐矩形（mm），可以贴边、**不允许重叠**
 * @param {object} o
 * @param {number} o.zBottom
 * @param {number} o.zTop
 * @returns {{ok:true, triangles:Float64Array, quads:number, walls:number, boundaryEdges:number, areaMm2:number, bbox:object}
 *          | {ok:false, reason:string, overlap?:object}}
 */
export function extrudeRectilinear(rects, { zBottom, zTop } = {}) {
  if (!Array.isArray(rects) || !rects.length) return { ok: false, reason: 'no rects' };
  if (!(zTop > zBottom)) return { ok: false, reason: `zTop ${zTop} must exceed zBottom ${zBottom}` };
  const norm = rects.map((r, i) => {
    const x0 = Math.min(r.x0, r.x1);
    const x1 = Math.max(r.x0, r.x1);
    const y0 = Math.min(r.y0, r.y1);
    const y1 = Math.max(r.y0, r.y1);
    if (!(x1 > x0) || !(y1 > y0)) throw new RangeError(`extrudeRectilinear: rect ${i} is degenerate (${JSON.stringify(r)})`);
    return { x0, x1, y0, y1, i };
  });
  // Overlap check, in the quantised coordinate space the mesh will actually use. Two rects may
  // share an edge (that is the normal case here); a shared *area* would mean the union has an
  // internal face and the watertight rule would fail for a reason nobody could see.
  for (let a = 0; a < norm.length; a++) {
    for (let b = a + 1; b < norm.length; b++) {
      const A = norm[a];
      const B = norm[b];
      if (q(A.x1) <= q(B.x0) || q(B.x1) <= q(A.x0) || q(A.y1) <= q(B.y0) || q(B.y1) <= q(A.y0)) continue;
      return { ok: false, reason: `rects ${a} and ${b} overlap`, overlap: { a: rects[a], b: rects[b] } };
    }
  }
  // Conforming grid: every rectangle boundary becomes a grid line, so no boundary segment can
  // ever land in the middle of a quad edge. The first version of this file merged y-bands into
  // full-width quads and produced T-junctions -- the top face's edge ran straight past where a
  // hole wall started, and manifoldReport correctly reported "12 edges used 4x, 24 pinch
  // vertices". A finer grid is the honest fix: correctness before triangle count.
  const xs = Array.from(new Set(norm.flatMap((r) => [q(r.x0), q(r.x1)]))).sort((a, b) => a - b);
  const ys = Array.from(new Set(norm.flatMap((r) => [q(r.y0), q(r.y1)]))).sort((a, b) => a - b);
  const nx = xs.length - 1;
  const ny = ys.length - 1;
  if (nx < 1 || ny < 1) return { ok: false, reason: 'the rect set has zero area' };
  const cell = new Uint8Array(nx * ny);
  const lower = (arr, v) => {
    let lo = 0;
    let hi = arr.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] < v) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  for (const r of norm) {
    const i0 = lower(xs, q(r.x0));
    const i1 = lower(xs, q(r.x1));
    const j0 = lower(ys, q(r.y0));
    const j1 = lower(ys, q(r.y1));
    for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) cell[j * nx + i] = 1;
  }
  let insideCount = 0;
  for (let k = 0; k < cell.length; k++) insideCount += cell[k];
  if (!insideCount) return { ok: false, reason: 'the rect set has zero area' };
  const at = (i, j) => (i < 0 || j < 0 || i >= nx || j >= ny ? 0 : cell[j * nx + i]);

  const tri = [];
  const push = (ax, ay, az, bx, by, bz, cx, cy, cz) => {
    tri.push(ax, ay, az, bx, by, bz, cx, cy, cz);
  };
  let walls = 0;
  let area = 0;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      if (!at(i, j)) continue;
      const x0 = xs[i] / COORD_QUANT;
      const x1 = xs[i + 1] / COORD_QUANT;
      const y0 = ys[j] / COORD_QUANT;
      const y1 = ys[j + 1] / COORD_QUANT;
      area += (x1 - x0) * (y1 - y0);
      minX = Math.min(minX, x0);
      maxX = Math.max(maxX, x1);
      minY = Math.min(minY, y0);
      maxY = Math.max(maxY, y1);
      // top face (+Z): CCW seen from above
      push(x0, y0, zTop, x1, y0, zTop, x1, y1, zTop);
      push(x0, y0, zTop, x1, y1, zTop, x0, y1, zTop);
      // bottom face (-Z): reversed winding
      push(x0, y0, zBottom, x1, y1, zBottom, x1, y0, zBottom);
      push(x0, y0, zBottom, x0, y1, zBottom, x1, y1, zBottom);
      // walls: for every neighbour that is outside, one quad along the shared edge, emitted in
      // the cell's CCW direction so that (B-A)x(C-A) is the outward normal (dy, -dx).
      if (!at(i, j - 1)) {
        push(x0, y0, zBottom, x1, y0, zBottom, x1, y0, zTop);
        push(x0, y0, zBottom, x1, y0, zTop, x0, y0, zTop);
        walls++;
      }
      if (!at(i + 1, j)) {
        push(x1, y0, zBottom, x1, y1, zBottom, x1, y1, zTop);
        push(x1, y0, zBottom, x1, y1, zTop, x1, y0, zTop);
        walls++;
      }
      if (!at(i, j + 1)) {
        push(x1, y1, zBottom, x0, y1, zBottom, x0, y1, zTop);
        push(x1, y1, zBottom, x0, y1, zTop, x1, y1, zTop);
        walls++;
      }
      if (!at(i - 1, j)) {
        push(x0, y1, zBottom, x0, y0, zBottom, x0, y0, zTop);
        push(x0, y1, zBottom, x0, y0, zTop, x0, y1, zTop);
        walls++;
      }
    }
  }
  return {
    ok: true,
    triangles: Float64Array.from(tri),
    quads: insideCount,
    walls,
    boundaryEdges: walls,
    areaMm2: area,
    bbox: { x: [minX, maxX], y: [minY, maxY], z: [zBottom, zTop] },
  };
}

/**
 * `outer` 减去一组互不重叠的孔，返回**贴边但互不重叠**的矩形列表（供 `extrudeRectilinear`）。
 *
 * 分解方式：按孔的 y 边界切横带；每条横带内按该带上活跃孔的 x 边界切竖条。结果是"并集
 * 恰好等于 outer − holes"的矩形集，且相邻矩形**贴边**（扫描线会合并它们）。
 */
export function subtractRects(outer, holes = []) {
  const o = { x0: Math.min(outer.x0, outer.x1), x1: Math.max(outer.x0, outer.x1), y0: Math.min(outer.y0, outer.y1), y1: Math.max(outer.y0, outer.y1) };
  const hs = holes
    .map((h) => ({ x0: Math.min(h.x0, h.x1), x1: Math.max(h.x0, h.x1), y0: Math.min(h.y0, h.y1), y1: Math.max(h.y0, h.y1) }))
    .filter((h) => h.x1 > h.x0 && h.y1 > h.y0 && h.x0 >= o.x0 - 1e-9 && h.x1 <= o.x1 + 1e-9 && h.y0 >= o.y0 - 1e-9 && h.y1 <= o.y1 + 1e-9);
  const ys = Array.from(new Set([q(o.y0), q(o.y1), ...hs.flatMap((h) => [q(h.y0), q(h.y1)])])).sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i + 1 < ys.length; i++) {
    const y0 = ys[i] / COORD_QUANT;
    const y1 = ys[i + 1] / COORD_QUANT;
    if (!(y1 > y0)) continue;
    const mid = (y0 + y1) / 2;
    const active = hs.filter((h) => h.y0 - 1e-9 <= mid && mid <= h.y1 + 1e-9).map((h) => [h.x0, h.x1]).sort((a, b) => a[0] - b[0]);
    let x = o.x0;
    for (const [hx0, hx1] of active) {
      if (hx0 > x + 1e-12) out.push({ x0: x, x1: hx0, y0, y1 });
      x = Math.max(x, hx1);
    }
    if (x < o.x1 - 1e-12) out.push({ x0: x, x1: o.x1, y0, y1 });
  }
  return out;
}
