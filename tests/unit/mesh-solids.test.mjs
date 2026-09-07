/**
 * tests/unit/mesh-solids.test.mjs — core/mesh/solids.js + core/mesh/stl.js 单测。
 *
 * 跑法（Windows / PowerShell，目录参数会 ERR_UNSUPPORTED_DIR_IMPORT，必须给文件）：
 *   node --test --test-isolation=none "tests/unit/mesh-solids.test.mjs"
 *
 * 测试文件里允许 node: 前缀（只有 core/** 禁止）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EPS,
  TRIANGLES_PER_RECT,
  discTriangleCount,
  ringTriangleCount,
  discTriangles,
  ringTriangles,
  prismFromMask,
  greedyRectCover,
  rectsCoverMaskExact,
  maskFromRects,
  weldTriangles,
  boundingBox,
} from '../../core/mesh/solids.js';
import {
  encodeSTLSolid,
  triangleCount,
  assertNoDegenerate,
  stlSelfCheck,
  stlByteLength,
  solidHeader,
} from '../../core/mesh/stl.js';
// 真实渲染层（只读调用，绝不修改）
import { glyphGeometry, glyphMaskForLevel } from '../../core/render/glyphs.js';
import { planPage } from '../../core/profiles.js';

/* ───────────────────────────── 测试用工具 ───────────────────────────── */

/** 右手定则法向（不归一化）：(B-A) × (C-A)。 */
function normalOf(tris, t) {
  const o = t * 9;
  const ax = tris[o], ay = tris[o + 1], az = tris[o + 2];
  const bx = tris[o + 3], by = tris[o + 4], bz = tris[o + 5];
  const cx = tris[o + 6], cy = tris[o + 7], cz = tris[o + 8];
  const e1 = [bx - ax, by - ay, bz - az];
  const e2 = [cx - ax, cy - ay, cz - az];
  return {
    n: [
      e1[1] * e2[2] - e1[2] * e2[1],
      e1[2] * e2[0] - e1[0] * e2[2],
      e1[0] * e2[1] - e1[1] * e2[0],
    ],
    centroid: [(ax + bx + cx) / 3, (ay + by + cy) / 3, (az + bz + cz) / 3],
  };
}

function triAt(tris, t) {
  const o = t * 9;
  return [tris[o], tris[o + 1], tris[o + 2], tris[o + 3], tris[o + 4], tris[o + 5], tris[o + 6], tris[o + 7], tris[o + 8]];
}

/** 用 '#'/'.' 字符串画掩码。 */
function maskFromRows(rows) {
  const height = rows.length;
  const width = rows[0].length;
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    assert.equal(rows[y].length, width, 'rows must be rectangular');
    for (let x = 0; x < width; x++) data[y * width + x] = rows[y][x] === '#' ? 1 : 0;
  }
  return { width, height, data };
}

/** 独立的位图重建 + 逐像素比对（不复用被测模块的 rectsCoverMaskExact）。 */
function rebuildAndCompare(rects, mask) {
  const grid = new Uint8Array(mask.width * mask.height);
  for (const r of rects) {
    for (let y = r.y0; y <= r.y1; y++) {
      for (let x = r.x0; x <= r.x1; x++) grid[y * mask.width + x] += 1;
    }
  }
  let exact = true;
  let doubled = 0;
  for (let i = 0; i < grid.length; i++) {
    if (grid[i] > 1) doubled += 1;
    if (grid[i] !== (mask.data[i] ? 1 : 0)) exact = false;
  }
  return { exact, doubled, grid };
}

function arraysEqualEps(a, b, eps = 0) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > eps) return false;
  return true;
}

/** 逐字节比较（Uint8Array）。 */
function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/* ═════════════════ 1. discTriangles：确定性与数量 ═════════════════ */

test('discTriangles: 确定性 + 三角形数 = segments*4 + 顶点焊接', () => {
  const args = { radiusMm: 1.2, zBottom: 0, zTop: 0.3, segments: 8, offsetXmm: 1.5, offsetYmm: -2.25 };
  const a = discTriangles(args);
  const b = discTriangles(args);
  assert.equal(a.length, discTriangleCount(8) * 9);
  assert.equal(a.length, 8 * 4 * 9, '顶 8 + 底 8 + 侧壁 16 = 32 个三角形');
  assert.ok(arraysEqualEps(a, b, 0), '两次调用必须逐元素完全相等');

  // 焊接：每个圆只用 1 + 2*segments 个不同顶点 → 展开后的三角形里共享坐标必须逐位相同
  const uniq = new Set();
  for (let t = 0; t < a.length / 9; t++) {
    const v = triAt(a, t);
    uniq.add(`${v[0].toExponential(17)}|${v[1].toExponential(17)}|${v[2].toExponential(17)}`);
    uniq.add(`${v[3].toExponential(17)}|${v[4].toExponential(17)}|${v[5].toExponential(17)}`);
    uniq.add(`${v[6].toExponential(17)}|${v[7].toExponential(17)}|${v[8].toExponential(17)}`);
  }
  assert.equal(uniq.size, 2 + 2 * 8, '唯一顶点 = 2 个圆心 + 顶圈 8 + 底圈 8（相邻三角形共享同一顶点数值）');
  assert.ok(discTriangleCount(8) * 3 > uniq.size, '展开数组里的顶点数 > 唯一顶点数');

  assert.throws(() => discTriangles({ ...args, segments: 2 }), /segments/, 'segments<3 必须拒绝');
  assert.throws(() => discTriangles({ ...args, zTop: 0 }), /Z band/, '零高度必须拒绝');
  assert.throws(() => discTriangles({ ...args, radiusMm: 0 }), /radiusMm/, '零半径必须拒绝');
});

/* ═════════════════ 2. 朝向（由顶点顺序表达）═════════════════ */

test('discTriangles: 顶面 +Z、底面 −Z、侧壁朝外', () => {
  const seg = 12;
  const off = { offsetXmm: 3, offsetYmm: -1 };
  const tris = discTriangles({ radiusMm: 2, zBottom: 0.5, zTop: 1.5, segments: seg, ...off });
  // 生成顺序：每个 i 出 [顶, 底, 侧, 侧]
  for (let i = 0; i < seg; i++) {
    const base = i * 4;
    const top = normalOf(tris, base);
    const bot = normalOf(tris, base + 1);
    assert.ok(top.n[2] > 0, `#${base} 顶面法向必须朝 +Z`);
    assert.ok(bot.n[2] < 0, `#${base + 1} 底面法向必须朝 −Z`);
    for (const k of [2, 3]) {
      const side = normalOf(tris, base + k);
      assert.ok(Math.abs(side.n[2]) < EPS, '侧壁法向的 z 分量应为 0');
      const dot = (side.centroid[0] - off.offsetXmm) * side.n[0] + (side.centroid[1] - off.offsetYmm) * side.n[1];
      assert.ok(dot > 0, `#${base + k} 侧壁法向必须朝外（重心·法向 > 0），实得 ${dot}`);
    }
  }
  // 无偏移版本：直接用 x*px + y*py
  const plain = discTriangles({ radiusMm: 1, zBottom: 0, zTop: 0.2, segments: 7 });
  for (let i = 0; i < 7; i++) {
    for (const k of [2, 3]) {
      const s = normalOf(plain, i * 4 + k);
      assert.ok(s.centroid[0] * s.n[0] + s.centroid[1] * s.n[1] > 0, '朝外');
    }
  }
});

/* ═════════════════ 3. ringTriangles：孔壁朝内 + 参数校验 ═════════════════ */

test('ringTriangles: 孔壁法向朝孔心、顶底朝 ±Z、inner>=outer 抛错含 ring:', () => {
  const seg = 10;
  const args = { outerRadiusMm: 1.2, innerRadiusMm: 0.8, zBottom: 0, zTop: 0.35, segments: seg };
  const tris = ringTriangles(args);
  assert.equal(tris.length, ringTriangleCount(seg) * 9);
  assert.equal(tris.length / 9, seg * 8, '顶2s+底2s+外壁2s+内壁2s');

  // 生成顺序：每个 i 出 [顶,顶,底,底,外,外,内,内]
  for (let i = 0; i < seg; i++) {
    const base = i * 8;
    assert.ok(normalOf(tris, base).n[2] > 0, '顶面 +Z');
    assert.ok(normalOf(tris, base + 1).n[2] > 0, '顶面 +Z');
    assert.ok(normalOf(tris, base + 2).n[2] < 0, '底面 −Z');
    assert.ok(normalOf(tris, base + 3).n[2] < 0, '底面 −Z');
    for (const k of [4, 5]) {
      const o = normalOf(tris, base + k);
      assert.ok(o.centroid[0] * o.n[0] + o.centroid[1] * o.n[1] > 0, `#${base + k} 外壁必须朝外`);
    }
    for (const k of [6, 7]) {
      const h = normalOf(tris, base + k);
      const radial = Math.hypot(h.centroid[0], h.centroid[1]);
      const dot = h.centroid[0] * h.n[0] + h.centroid[1] * h.n[1];
      assert.ok(dot < 0, `#${base + k} 孔壁法向必须朝孔心（材料内侧），实得 ${dot}`);
      // 孔壁上的点半径 ≈ innerRadiusMm（证明它真的是孔，不是实心）
      assert.ok(Math.abs(radial - args.innerRadiusMm) < 0.12, `孔壁半径≈inner，实得 ${radial}`);
    }
  }

  for (const [o, r] of [[1, 1], [0.5, 1.2], [1 + EPS / 2, 1]]) {
    assert.throws(
      () => ringTriangles({ outerRadiusMm: o, innerRadiusMm: r, zBottom: 0, zTop: 1, segments: 6 }),
      (e) => {
        assert.match(e.message, /ring:/, '消息必须包含 ring: 前缀');
        assert.ok(e.message.includes(String(o)), '消息必须包含实际外半径');
        assert.ok(e.message.includes(String(r)), '消息必须包含实际内半径');
        return true;
      },
    );
  }
  // 确定性
  assert.ok(arraysEqualEps(tris, ringTriangles(args), 0));
  // 环形顶面不能是"外圆减内圆"的假三角形：所有顶面三角形的重心半径都在内外之间
  for (let i = 0; i < seg; i++) {
    for (const k of [0, 1]) {
      const c = normalOf(tris, i * 8 + k).centroid;
      const r = Math.hypot(c[0], c[1]);
      assert.ok(r > args.innerRadiusMm && r < args.outerRadiusMm, `环形顶面三角形半径落在材料带内，实得 ${r}`);
    }
  }
});

/* ═════════════════ 4. prismFromMask：最大矩形覆盖逐像素精确 ═════════════════ */

test('prismFromMask: 回字形 —— 8 个最大矩形 + 并集逐像素等于掩码', () => {
  // 手算（按 greedy：逐行找连续 1，向下合并同宽相邻行，产出后从 remaining 清零）
  //   R1 x[0,8]y[0,0]  顶边整条（第 1 行只有 0/8 两列，无法向下合并）
  //   R2 x[0,0]y[1,8]  左边整条
  //   R3 x[8,8]y[1,8]  右边整条
  //   R4 x[3,5]y[3,3]  内环顶边
  //   R5 x[3,3]y[4,5]  内环左边（跨 2 行）
  //   R6 x[5,5]y[4,5]  内环右边（跨 2 行）
  //   R7 x[4,4]y[5,5]  内环底边中段
  //   R8 x[1,7]y[8,8]  底边中段（0/8 已被 R2/R3 吃掉）
  // 合计 8 个矩形。
  const mask = maskFromRows([
    '#########',
    '#.......#',
    '#.......#',
    '#..###..#',
    '#..#.#..#',
    '#..###..#',
    '#.......#',
    '#.......#',
    '#########',
  ]);
  const { triangles, stats } = prismFromMask(mask, { pixelMm: 0.2, zBottom: 0, zTop: 0.4 });
  assert.equal(stats.coverageExact, true);
  assert.equal(stats.rects, 8, '最大矩形数必须等于手算的 8');
  assert.equal(rectsCoverMaskExact(greedyRectCover(mask), mask), true);
  assert.equal(stats.triangles, 8 * TRIANGLES_PER_RECT);
  assert.equal(triangles.length, 8 * TRIANGLES_PER_RECT * 9);
  // 不重叠（矩形的并集是掩码的一个划分，不是叠加）
  const cmp = rebuildAndCompare(stats.rectsList, mask);
  assert.equal(cmp.exact, true, '矩形并集必须逐像素等于掩码');
  assert.equal(cmp.doubled, 0, '矩形之间不得重叠');
  assert.equal(stats.filledPixels, mask.data.reduce((s, v) => s + v, 0));
});

test('prismFromMask: 5×5 竖缝洞 / 单像素洞 —— 各 4 个矩形', () => {
  // 竖缝：R1 x[0,4]y[0,0]; R2 x[0,1]y[1,4]; R3 x[3,4]y[1,4]; R4 x[2,2]y[4,4] → 4
  const slit = maskFromRows(['#####', '##.##', '##.##', '##.##', '#####']);
  const s1 = prismFromMask(slit, { pixelMm: 0.36, zBottom: 0, zTop: 0.2 });
  assert.equal(s1.stats.rects, 4, '手算 4 个矩形');
  assert.equal(s1.stats.coverageExact, true);

  // 中心单孔：R1 x[0,4]y[0,1]; R2 x[0,1]y[2,4]; R3 x[3,4]y[2,4]; R4 x[2,2]y[4,4] → 4
  const hole = maskFromRows(['#####', '#####', '##.##', '#####', '#####']);
  const s2 = prismFromMask(hole, { pixelMm: 0.36, zBottom: 0, zTop: 0.2 });
  assert.equal(s2.stats.rects, 4, '手算 4 个矩形');
  assert.equal(s2.stats.coverageExact, true);
  assert.equal(rebuildAndCompare(s2.stats.rectsList, hole).exact, true);

  // 挤出体本身：包围盒 = 覆盖到的 mm 范围 × 层高；每个矩形 12 个三角形
  assert.equal(s2.stats.triangles, 4 * TRIANGLES_PER_RECT);
  const bb = boundingBox(s2.triangles);
  assert.equal(bb.size[2], 0.2);
  assert.ok(Math.abs(bb.size[0] - 5 * 0.36) < 1e-9, 'X 跨度必须等于 5 个像素');
  // 顶面 +Z / 底面 −Z / 侧壁朝该矩形自己的外侧
  for (let r = 0; r < 4; r++) {
    const base = r * TRIANGLES_PER_RECT;
    // 该矩形自身的中心（由各矩形 12 个三角形的顶点求均值 → 盒子中心）
    let sx = 0, sy = 0;
    for (let i = base * 9; i < (base + TRIANGLES_PER_RECT) * 9; i += 3) { sx += s2.triangles[i]; sy += s2.triangles[i + 1]; }
    const nVerts = TRIANGLES_PER_RECT * 3;
    const cx = sx / nVerts, cy = sy / nVerts;
    assert.ok(normalOf(s2.triangles, base).n[2] > 0, '顶 1 +Z');
    assert.ok(normalOf(s2.triangles, base + 1).n[2] > 0, '顶 2 +Z');
    assert.ok(normalOf(s2.triangles, base + 2).n[2] < 0, '底 1 −Z');
    assert.ok(normalOf(s2.triangles, base + 3).n[2] < 0, '底 2 −Z');
    for (let k = 4; k < 12; k++) {
      const w = normalOf(s2.triangles, base + k);
      assert.ok(Math.abs(w.n[2]) < EPS, '侧壁法向无 z 分量');
      const dx = w.centroid[0] - cx;
      const dy = w.centroid[1] - cy;
      assert.ok(dx * w.n[0] + dy * w.n[1] > 0, `#${base + k} 侧壁必须朝该矩形外侧`);
      // 更强的判定：法向必须轴对齐，且落在"离开中心"的那一侧
      if (Math.abs(w.n[0]) > Math.abs(w.n[1])) {
        assert.ok(Math.abs(w.n[1]) < EPS && Math.sign(w.n[0]) === Math.sign(dx), `#${base + k} 应为 ±X 外法向`);
      } else {
        assert.ok(Math.abs(w.n[0]) < EPS && Math.sign(w.n[1]) === Math.sign(dy), `#${base + k} 应为 ±Y 外法向`);
      }
    }
  }
  assert.doesNotThrow(() => assertNoDegenerate(s2.triangles));
});

test('rectsCoverMaskExact 是承重的：缩小一格 / 多出一格都会被判 false', () => {
  const mask = maskFromRows(['#####', '##.##', '#####']);
  const rects = greedyRectCover(mask);
  assert.equal(rectsCoverMaskExact(rects, mask), true, '原始覆盖必须判 true');
  assert.equal(rebuildAndCompare(rects, mask).exact, true);

  // 反例 1：把最后一个矩形缩小一格 → 漏一个像素
  const shrunk = rects.map((r) => ({ ...r }));
  const last = shrunk[shrunk.length - 1];
  last.x1 = last.x1 - 1;
  assert.equal(rectsCoverMaskExact(shrunk, mask), false, '缩小一格必须被发现');
  assert.equal(rebuildAndCompare(shrunk, mask).exact, false);

  // 反例 2：多出一格（超出掩码）→ 假材料
  const grown = rects.map((r) => ({ ...r }));
  grown[0] = { ...grown[0], x1: grown[0].x1 + 1 };
  assert.equal(rectsCoverMaskExact(grown, mask), false, '多出一格必须被发现');

  // 反例 3：丢掉一个矩形
  assert.equal(rectsCoverMaskExact(rects.slice(0, -1), mask), false);
  // 反例 4：重叠（同一条覆盖两次）→ 不是划分
  assert.equal(rebuildAndCompare(rects.concat([rects[0]]), mask).doubled > 0, true);
});

test('prismFromMask: 空格（无材料）出空网格，非法入参抛错', () => {
  const empty = maskFromRows(['..', '..']);
  const e = prismFromMask(empty, { pixelMm: 1, zBottom: 0, zTop: 1 });
  assert.equal(e.stats.rects, 0, '空格不应凭空造出矩形');
  assert.equal(e.stats.coverageExact, true, '空并集 == 空掩码，逐像素仍然精确');
  assert.equal(e.triangles.length, 0);
  const one = maskFromRows(['#']);
  const r = prismFromMask(one, { pixelMm: 1, zBottom: 0, zTop: 1 });
  assert.equal(r.stats.rects, 1);
  assert.equal(r.triangles.length, 12 * 9);
  assert.throws(() => prismFromMask(one, { pixelMm: 0, zBottom: 0, zTop: 1 }), /pixelMm/);
  assert.throws(() => prismFromMask({ width: 2, height: 2, data: new Uint8Array(3) }, { pixelMm: 1, zBottom: 0, zTop: 1 }), /data\.length/);
});

/* ═════════════════ 5. weldTriangles ═════════════════ */

test('weldTriangles: 索引数守恒、顶点数减少、还原后与输入一致', () => {
  // 5×5 网格掩码：矩形之间共享边界坐标吗？先用显然重复的数据测焊接
  const clean = Float64Array.from([
    0, 0, 0, 0.25, 0, 0, 0.25, 0.5, 0, // tri0
    0.25, 0, 0, 0.5, 0, 0, 0.5, 0.5, 0, // tri1（与 tri0 共享 (0.25,0,0)）
  ]);
  const w = weldTriangles(clean);
  assert.equal(w.indices.length, clean.length / 3, 'indices.length === triangles.length/3');
  assert.equal(w.indices.length, 6);
  assert.ok(w.vertices.length / 3 < clean.length / 3, '焊接后顶点数必须减少');
  assert.equal(w.vertices.length / 3, 5, '6 个顶点里 (0.25,0,0) 出现两次 → 5 个唯一顶点');
  // 还原
  const restored = new Float64Array(clean.length);
  for (let i = 0; i < w.indices.length; i++) {
    const b = w.indices[i] * 3;
    restored[i * 3] = w.vertices[b];
    restored[i * 3 + 1] = w.vertices[b + 1];
    restored[i * 3 + 2] = w.vertices[b + 2];
  }
  assert.ok(arraysEqualEps(restored, clean, 0), '整数量级坐标必须逐位还原');

  // 真实几何：disc 的 cos/sin 是无理数 → 用 decimals=9 焊接，误差必须 < 1e-9
  const tris = discTriangles({ radiusMm: 1.2, zBottom: 0, zTop: 0.3, segments: 16 });
  const rawVerts = tris.length / 3;
  const W = weldTriangles(tris, { decimals: 9 });
  assert.equal(W.indices.length, tris.length / 3);
  assert.ok(W.vertices.length / 3 < rawVerts, `${W.vertices.length / 3} 必须 < ${rawVerts}`);
  assert.equal(W.vertices.length / 3, 2 + 2 * 16, '焊接后正好回到顶点表的唯一顶点数（2 圆心 + 2 圈）');
  const back = new Float64Array(tris.length);
  for (let i = 0; i < W.indices.length; i++) {
    const b = W.indices[i] * 3;
    back[i * 3] = W.vertices[b];
    back[i * 3 + 1] = W.vertices[b + 1];
    back[i * 3 + 2] = W.vertices[b + 2];
  }
  assert.ok(arraysEqualEps(back, tris, 1e-9), '焊接→还原 误差必须 < 1e-9');
  // 确定性 + 幂等（再焊一次不再减少顶点）
  const W2 = weldTriangles(tris, { decimals: 9 });
  assert.ok(arraysEqualEps(W2.vertices, W.vertices, 0), '顶点表必须确定');
  assert.ok(arraysEqualEps(new Float64Array(W2.indices), new Float64Array(W.indices), 0), '索引必须确定');
  const W3 = weldTriangles(tris, { decimals: 9 });
  assert.equal(W3.indices.length, tris.length / 3);
  assert.ok(trianglesFromIndexed(W3.vertices, W3.indices).length === tris.length);
});

/** 索引表 → 扁平三角形数组。 */
function trianglesFromIndexed(vertices, indices) {
  const out = new Float64Array(indices.length * 3);
  for (let i = 0; i < indices.length; i++) {
    const b = indices[i] * 3;
    out[i * 3] = vertices[b];
    out[i * 3 + 1] = vertices[b + 1];
    out[i * 3 + 2] = vertices[b + 2];
  }
  return out;
}

/* ═════════════════ 6. STL 编码 ═════════════════ */

test('encodeSTLSolid: 84+50n 长度、逐字节确定、回读三角形数一致', () => {
  const tris = ringTriangles({ outerRadiusMm: 1.2, innerRadiusMm: 0.8, zBottom: 0, zTop: 0.35, segments: 12 });
  const n = tris.length / 9;
  const a = encodeSTLSolid(tris, { name: 'PSKT-D2' });
  const b = encodeSTLSolid(tris, { name: 'PSKT-D2' });
  assert.equal(a.length, 84 + 50 * n);
  assert.equal(a.length, stlByteLength(n));
  assert.ok(bytesEqual(a, b), '两次编码必须逐字节相同');
  assert.equal(triangleCount(a), n);
  assert.equal(new DataView(a.buffer, a.byteOffset, a.byteLength).getUint32(80, true), n);

  // 头：PSKT/ 前缀、ASCII 版式说明、末尾零填充、不含时间/路径
  const head = new TextDecoder().decode(a.subarray(0, 80)).replace(/\u0000+$/, '');
  assert.ok(head.startsWith('PSKT/'), '必须以 PSKT/ 开头');
  assert.ok(!/^solid/.test(head), '不能以 solid 开头（避免被当成 ASCII STL）');
  assert.match(head, /binary-stl/);
  assert.ok(a.subarray(head.length, 80).every((v) => v === 0), '头必须 NUL 填充');
  assert.ok(!/[A-Za-z]:[\\/]/.test(head) && !head.includes('Users'), '头里不得出现路径');
  assert.deepEqual(Array.from(solidHeader('PSKT', 0).subarray(0, 5)), Array.from(new TextEncoder().encode('PSKT/')));
  // 属性字节数 = 0
  const dv = new DataView(a.buffer, a.byteOffset, a.byteLength);
  for (let t = 0; t < n; t += 7) assert.equal(dv.getUint16(84 + t * 50 + 48, true), 0);

  // 法向由顶点顺序推出：float32 读回后与叉积方向同号
  for (let t = 0; t < n; t += 5) {
    const o = 84 + t * 50;
    const nx = dv.getFloat32(o, true), ny = dv.getFloat32(o + 4, true), nz = dv.getFloat32(o + 8, true);
    const expect = normalOf(tris, t).n;
    const dot = nx * expect[0] + ny * expect[1] + nz * expect[2];
    assert.ok(dot > 0, `tri #${t}: STL 法向必须与顶点顺序的右手定则同向`);
  }

  // 空输入
  assert.equal(encodeSTLSolid(new Float64Array(0)).length, 84);
  assert.throws(() => encodeSTLSolid(new Float64Array(10)), /multiple of 9/);
  assert.throws(() => triangleCount(a.subarray(0, a.length - 1)), /size mismatch/);
});

test('assertNoDegenerate: 零面积三角形被拒（消息含序号与顶点）', () => {
  const good = discTriangles({ radiusMm: 1, zBottom: 0, zTop: 0.2, segments: 6 });
  assert.doesNotThrow(() => assertNoDegenerate(good));

  const bad = Float64Array.from([
    0, 0, 0, 1, 0, 0, 2, 0, 0, // #0 共线 → 面积 0
    0, 0, 0, 0, 0, 0, 1, 1, 1, // #1 两顶点重合
    0, 0, 0, 1, 0, 0, 0, 1, 0, // #2 正常
  ]);
  assert.throws(
    () => assertNoDegenerate(bad),
    (e) => {
      assert.match(e.message, /triangle #0/);
      assert.ok(e.message.includes('0, 0, 0'));
      assert.ok(e.message.includes('1, 0, 0'));
      return true;
    },
  );
  // minArea 阈值能真的收紧判定
  assert.throws(() => assertNoDegenerate(good, { minArea: 1e6 }), /triangle #/);
  assert.throws(
    () => assertNoDegenerate(Float64Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, NaN, 0, 0, 0, 0, 0, 1, 1, 1])),
    /non-finite/,
  );
});

test('stlSelfCheck: 不谎报水密', () => {
  const tris = prismFromMask(maskFromRows(['###', '#.#', '###']), { pixelMm: 0.4, zBottom: 0, zTop: 0.3 }).triangles;
  const chk = stlSelfCheck(tris);
  assert.equal(chk.ok, true, chk.issues.join('; '));
  assert.equal(chk.tris, tris.length / 9);
  assert.equal(chk.watertightHint, false, 'STL 路径不得声称水密');
  assert.match(chk.watertightNote, /no shared-vertex topology/);
  assert.ok(chk.bbox && chk.bbox.size[2] > 0);

  const broken = Float64Array.from([0, 0, 0, 1, 0, 0, 2, 0, 0]);
  const bad = stlSelfCheck(broken);
  assert.equal(bad.ok, false);
  assert.equal(bad.watertightHint, false);
  assert.equal(stlSelfCheck(new Float64Array(0)).ok, false, '零三角形不得判 ok');
});

/* ═════════════════ 7. 与真实渲染层联动（只读调用）═══════════════ */

test('集成：planPage(PL-D2) → glyphGeometry → glyphMaskForLevel → prismFromMask → STL', () => {
  const plan = planPage('PL-D2', { nozzle: '0.4' });
  const nozzleMm = Number(plan.nozzle);
  assert.ok(nozzleMm > 0 && plan.pitchMm > 0);
  // EW = 挤出线宽（此路径下 = 喷嘴宽度）；cellEw = 一格等于几个 EW
  const cellEw = plan.pitchMm / nozzleMm;
  const shape = plan.channels.find((c) => c.name === 'shape');
  const geo = glyphGeometry(cellEw, shape.levels);
  assert.equal(geo.ok, true, geo.reason || 'glyphGeometry 必须可行');
  assert.ok(geo.outer > geo.inner, '外半径必须大于内半径');

  // 半径一律来自 glyphGeometry（本文件绝不自己写圆/环公式）
  const cellMm = plan.pitchMm;
  const cellPx = 24;
  const pixelMm = cellMm / cellPx;
  for (const level of [0, shape.levels - 1]) {
    const data = new Uint8Array(cellPx * cellPx);
    for (let j = 0; j < cellPx; j++) {
      for (let i = 0; i < cellPx; i++) {
        const dx = (i + 0.5) / cellPx - 0.5; // 归一化格坐标：格中心 (0,0)，范围 ±0.5
        const dy = (j + 0.5) / cellPx - 0.5;
        data[j * cellPx + i] = glyphMaskForLevel(dx, dy, level, geo) ? 1 : 0;
      }
    }
    const mask = { width: cellPx, height: cellPx, data };
    const filled = data.reduce((s, v) => s + v, 0);
    assert.ok(filled > 0, `level ${level} 的掩码不应为空`);

    const { triangles, stats } = prismFromMask(mask, { pixelMm, zBottom: 0, zTop: nozzleMm });
    assert.equal(stats.coverageExact, true, `level ${level}：矩形并集必须逐像素等于掩码`);
    assert.ok(stats.rects > 0);
    assert.equal(triangles.length / 9, stats.rects * TRIANGLES_PER_RECT);
    assert.equal(triangles.length / 9, stats.triangles);
    assert.ok(triangles.length > 0);
    assert.doesNotThrow(() => assertNoDegenerate(triangles));

    // 尺寸必须由 geo.outer 决定：X 跨度 ≈ 2*outer*cellMm（±2 像素）
    const bb = boundingBox(triangles);
    const wanted = 2 * geo.outer * cellMm;
    assert.ok(Math.abs(bb.size[0] - wanted) <= 2 * pixelMm, `X 跨度 ${bb.size[0]} 必须 ≈ 2*outer*cell = ${wanted}`);
    assert.ok(Math.abs(bb.size[1] - wanted) <= 2 * pixelMm, `Y 跨度 ${bb.size[1]} 必须 ≈ ${wanted}`);
    assert.ok(bb.size[0] < cellMm, '环形不得铺满整格（否则就是没用到 outer/inner）');
    assert.equal(bb.size[2], nozzleMm);

    const stl = encodeSTLSolid(triangles, { name: `PSKT-PL-D2-lv${level}` });
    const n = triangles.length / 9;
    assert.equal(stl.length, 84 + 50 * n);
    assert.equal(triangleCount(stl), n);
    const chk = stlSelfCheck(triangles);
    assert.equal(chk.ok, true, chk.issues.join('; '));
    assert.ok(chk.tris > 0);
    assert.equal(chk.watertightHint, false);
  }
});
