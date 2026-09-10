/**
 * core/mesh/stl.js — 3D 网格产物底层之二：二进制 STL 编码器 + 自校验。
 *
 * 纯 ESM、零依赖、Node 与浏览器同一份：只用 Uint8Array / DataView / TextEncoder。
 *
 * ── 确定性 ───────────────────────────────────────────────────────────────────
 *   同样的输入三角形数组，两次 encodeSTLSolid() 必须**逐字节相同**。
 *   因此 80 字节头里绝不写时间戳、文件路径、随机数；只写固定前缀 + 版式说明 +
 *   solid 名 + 三角形数，剩余字节 NUL 填充。
 *
 * ── 为什么头不以 "solid" 开头 ────────────────────────────────────────────────
 *   规范上二进制 STL 的 80 字节头是任意文本，但大量工具（和一些切片器）用
 *   "文件是否以 `solid` 开头 + 长度是否等于 84+50n" 来猜 ASCII/二进制。
 *   我们把首 5 字节固定为 `PSKT/`，配合精确的 84+50n 长度，避免被误判成 ASCII。
 *
 * ── 法向 ─────────────────────────────────────────────────────────────────────
 *   法向**由顶点顺序用右手定则算出**：n = normalize((B-A) × (C-A))。
 *   退化（面积为 0 / 顶点重合 / 叉积为零向量）→ 这里写 [0,0,0]，
 *   但这种数据必须被 assertNoDegenerate() 拒绝；不要把它发给打印机。
 *   STL 本身没有共享顶点拓扑，所以水密性**不在这里**声明（见 stlSelfCheck）。
 */

import { boundingBox } from './solids.js';

const HEADER_BYTES = 80;
const BYTES_PER_TRIANGLE = 50;

/** 面积小于该值的三角形视为退化（mm²）。真实最小特征 (~0.05mm 格) ≫ 此值。 */
export const DEGENERATE_AREA_EPS = 1e-15;

/** 头里的固定前缀（同时用作默认 solid 名）。 */
const STL_HEADER_PREFIX = 'PSKT/';

/** STL 无共享顶点拓扑 —— 这句话不许被"改进"成水密声明。 */
export const WATERTIGHT_NOTE =
  'STL has no shared-vertex topology; watertightness is asserted by the 3MF path, not here';

/** 二进制 STL 的字节数：84 + 50*n。 */
export function stlByteLength(triangleCount) {
  return HEADER_BYTES + 4 + triangleCount * BYTES_PER_TRIANGLE;
}

function asTriangleArray(triangles) {
  if (!(triangles instanceof Float64Array) && !(triangles instanceof Float32Array) && !Array.isArray(triangles)) {
    throw new Error(`stl: expected Float64Array/Float32Array/array of triangle vertices, got ${String(triangles)}`);
  }
  if (triangles.length % 9 !== 0) {
    throw new Error(`stl: triangles length ${triangles.length} is not a multiple of 9`);
  }
  return triangles;
}

/** 只保留可打印 ASCII，且不让 name 破坏头的 `;`/`=` 结构。 */
function sanitizeName(name) {
  const s = String(name)
    .replace(/[^ -~]/g, '_')
    .replace(/[;=]/g, '-');
  return s.length === 0 ? 'PSKT' : s;
}

/**
 * 构造 80 字节头（NUL 填充）。示例：
 *   `PSKT/binary-stl;v1;solid=PSKT;units=mm;tri=120` + NUL…
 * 超长则**确定性截断**到 80 字节（不报错、不夹带时间/路径）。
 */
export function solidHeader(name = 'PSKT', triangleCount = 0) {
  const text = `${STL_HEADER_PREFIX}binary-stl;v1;solid=${sanitizeName(name)};units=mm;tri=${triangleCount}`;
  const bytes = new Uint8Array(HEADER_BYTES);
  const enc = new TextEncoder().encode(text);
  bytes.set(enc.subarray(0, HEADER_BYTES));
  return bytes;
}

/**
 * 由顶点顺序（右手定则）求单位法向。退化 → [0, 0, 0]。
 * @returns {number[]}
 */
export function triangleNormal(ax, ay, az, bx, by, bz, cx, cy, cz) {
  const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
  const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
  let nx = e1y * e2z - e1z * e2y;
  let ny = e1z * e2x - e1x * e2z;
  let nz = e1x * e2y - e1y * e2x;
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (!(len > 0) || !Number.isFinite(len)) return [0, 0, 0];
  nx /= len; ny /= len; nz /= len;
  return [nx, ny, nz];
}

/** 三角形面积（0 = 退化）。 */
function triangleArea(ax, ay, az, bx, by, bz, cx, cy, cz) {
  const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
  const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
  const cx1 = e1y * e2z - e1z * e2y;
  const cy1 = e1z * e2x - e1x * e2z;
  const cz1 = e1x * e2y - e1y * e2x;
  return 0.5 * Math.sqrt(cx1 * cx1 + cy1 * cy1 + cz1 * cz1);
}

function fmtTri(ax, ay, az, bx, by, bz, cx, cy, cz) {
  const v = (x, y, z) => `[${x}, ${y}, ${z}]`;
  return `${v(ax, ay, az)} ${v(bx, by, bz)} ${v(cx, cy, cz)}`;
}

/**
 * 拒绝退化三角形（面积为 0：重合顶点、共线、零高度）。
 * @param {number} [o.minArea=0] 额外的最小面积（mm²）；> 0 时用它当阈值
 * @throws {Error} 消息含三角形序号与三个顶点
 */
export function assertNoDegenerate(triangles, { minArea = 0 } = {}) {
  const arr = asTriangleArray(triangles);
  const limit = Number.isFinite(minArea) && minArea > 0 ? minArea : DEGENERATE_AREA_EPS;
  const n = arr.length / 9;
  for (let t = 0; t < n; t++) {
    const o = t * 9;
    const ax = arr[o], ay = arr[o + 1], az = arr[o + 2];
    const bx = arr[o + 3], by = arr[o + 4], bz = arr[o + 5];
    const cx = arr[o + 6], cy = arr[o + 7], cz = arr[o + 8];
    if (
      !Number.isFinite(ax) || !Number.isFinite(ay) || !Number.isFinite(az) ||
      !Number.isFinite(bx) || !Number.isFinite(by) || !Number.isFinite(bz) ||
      !Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(cz)
    ) {
      throw new Error(
        `assertNoDegenerate: triangle #${t} has a non-finite vertex: ` +
          fmtTri(ax, ay, az, bx, by, bz, cx, cy, cz),
      );
    }
    const area = triangleArea(ax, ay, az, bx, by, bz, cx, cy, cz);
    if (!(area > limit)) {
      throw new Error(
        `assertNoDegenerate: triangle #${t} is degenerate (area=${area.toExponential(3)} <= ${limit}): ` +
          fmtTri(ax, ay, az, bx, by, bz, cx, cy, cz),
      );
    }
  }
  return true;
}

/**
 * 编码为二进制 STL。
 *
 * 注意：本函数**不**替你调 assertNoDegenerate —— 退化三角形会写出法向 [0,0,0]
 * 的合法字节流。生产路径请在编码前先 assert 一遍（stlSelfCheck 会报出来）。
 *
 * @returns {Uint8Array} 长度 = 84 + 50 × 三角形数
 */
export function encodeSTLSolid(triangles, { name = 'PSKT' } = {}) {
  const arr = asTriangleArray(triangles);
  const n = arr.length / 9;
  const out = new Uint8Array(stlByteLength(n));
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);

  out.set(solidHeader(name, n), 0);
  dv.setUint32(HEADER_BYTES, n, true);

  let o = HEADER_BYTES + 4;
  for (let t = 0; t < n; t++) {
    const s = t * 9;
    const ax = arr[s], ay = arr[s + 1], az = arr[s + 2];
    const bx = arr[s + 3], by = arr[s + 4], bz = arr[s + 5];
    const cx = arr[s + 6], cy = arr[s + 7], cz = arr[s + 8];
    const [nx, ny, nz] = triangleNormal(ax, ay, az, bx, by, bz, cx, cy, cz);
    dv.setFloat32(o, nx, true);
    dv.setFloat32(o + 4, ny, true);
    dv.setFloat32(o + 8, nz, true);
    dv.setFloat32(o + 12, ax, true);
    dv.setFloat32(o + 16, ay, true);
    dv.setFloat32(o + 20, az, true);
    dv.setFloat32(o + 24, bx, true);
    dv.setFloat32(o + 28, by, true);
    dv.setFloat32(o + 32, bz, true);
    dv.setFloat32(o + 36, cx, true);
    dv.setFloat32(o + 40, cy, true);
    dv.setFloat32(o + 44, cz, true);
    dv.setUint16(o + 48, 0, true); // attribute byte count = 0
    o += BYTES_PER_TRIANGLE;
  }
  return out;
}

/**
 * 从 STL 字节读回三角形数（自校验用）。长度必须严格等于 84 + 50n，否则 throw。
 */
export function triangleCount(u8) {
  if (!(u8 instanceof Uint8Array)) {
    throw new Error(`triangleCount: expected Uint8Array, got ${String(u8)}`);
  }
  if (u8.byteLength < HEADER_BYTES + 4) {
    throw new Error(`triangleCount: buffer too small (${u8.byteLength} bytes)`);
  }
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const n = dv.getUint32(HEADER_BYTES, true);
  const expected = stlByteLength(n);
  if (u8.byteLength !== expected) {
    throw new Error(
      `triangleCount: size mismatch — header says ${n} triangles ` +
        `(expected ${expected} bytes) but got ${u8.byteLength} bytes`,
    );
  }
  return n;
}

/**
 * 自校验：三角形数、有限性、退化计数、法向与顶点顺序是否一致、包围盒。
 *
 * watertightHint 恒为 false —— 但这句话说的是**容器**，不是几何。STL 不携带共享顶点
 * 拓扑，所以它无从声明；把它"改进"成水密声明是本仓库唯一不可原谅的失败。
 *
 * 实测事实（M5，PL-G 页，14x14 格，装了底板之后重量，别把保守当真相）：把这 45,132 个
 * 三角形按 1e-6 mm 焊接再数无向边，67,698 条边里 **100.00% 恰被两个三角形反向共用**，
 * 符号体积 +68,180.17 mm^3 为正（`ref/verify_model.py` 的 stl/edge-census 与
 * stl/signed-volume-positive 两条独立量出同样的数）。也就是说这批网格**确实**闭合成壳，
 * 只是 STL 这个格式没法把这件事交给下游。几何层面的声明在 3MF 路径：
 * `threeMF.encode3MF()` 逐 `<object>` 跑 `manifoldReportIndexed()`，不过就拒写。
 *
 * 早期这里写的是 "prismFromMask 的矩形共墙 ⇒ 边被用 4 次，不水密"：那句话对
 * `prismFromMask` 这条路仍然成立（`ringTriangles`/`discTriangles` 每格各自成壳，
 * 彼此由几何间隙分开，所以根本不共边），但它是**那条路**的性质，不是本网格的事实。
 *
 * @returns {{ok:boolean, tris:number, watertightHint:false, watertightNote:string,
 *            bbox:object|null, issues:string[], degenerate:number}}
 */
export function stlSelfCheck(triangles) {
  const issues = [];
  let arr;
  try {
    arr = asTriangleArray(triangles);
  } catch (e) {
    return {
      ok: false, tris: 0, watertightHint: false, watertightNote: WATERTIGHT_NOTE,
      bbox: null, degenerate: 0, issues: [String(e && e.message ? e.message : e)],
    };
  }
  const n = arr.length / 9;
  if (n === 0) issues.push('stlSelfCheck: zero triangles');

  let degenerate = 0;
  let normalMismatch = 0;
  for (let t = 0; t < n; t++) {
    const s = t * 9;
    const ax = arr[s], ay = arr[s + 1], az = arr[s + 2];
    const bx = arr[s + 3], by = arr[s + 4], bz = arr[s + 5];
    const cx = arr[s + 6], cy = arr[s + 7], cz = arr[s + 8];
    if (
      !Number.isFinite(ax) || !Number.isFinite(ay) || !Number.isFinite(az) ||
      !Number.isFinite(bx) || !Number.isFinite(by) || !Number.isFinite(bz) ||
      !Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(cz)
    ) {
      issues.push(`stlSelfCheck: triangle #${t} has a non-finite vertex`);
      continue;
    }
    const area = triangleArea(ax, ay, az, bx, by, bz, cx, cy, cz);
    if (!(area > DEGENERATE_AREA_EPS)) {
      degenerate += 1;
      if (degenerate <= 3) issues.push(`stlSelfCheck: triangle #${t} is degenerate (area=${area.toExponential(3)})`);
      continue;
    }
    // 法向必须由顶点顺序推出（右手定则），且非零
    const [nx, ny, nz] = triangleNormal(ax, ay, az, bx, by, bz, cx, cy, cz);
    if (nx === 0 && ny === 0 && nz === 0) normalMismatch += 1;
  }
  if (degenerate > 3) issues.push(`stlSelfCheck: ... ${degenerate} degenerate triangles in total`);
  if (normalMismatch > 0) issues.push(`stlSelfCheck: ${normalMismatch} triangles have a zero normal`);

  let bbox = null;
  try {
    bbox = boundingBox(arr);
  } catch (e) {
    if (n > 0) issues.push(`stlSelfCheck: bbox failed: ${e.message}`);
  }

  // 字节流自校验：能编出来、长度对得上、三角形数回读一致、两次编码逐字节相同。
  if (n > 0) {
    try {
      const a = encodeSTLSolid(arr);
      const b = encodeSTLSolid(arr);
      if (triangleCount(a) !== n) issues.push('stlSelfCheck: triangleCount round-trip mismatch');
      if (a.length !== stlByteLength(n)) issues.push('stlSelfCheck: encoded length != 84+50n');
      for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) {
          issues.push(`stlSelfCheck: encoding is not deterministic (first diff at byte ${i})`);
          break;
        }
      }
    } catch (e) {
      issues.push(`stlSelfCheck: encode failed: ${e.message}`);
    }
  }

  return {
    ok: issues.length === 0 && n > 0 && degenerate === 0 && normalMismatch === 0,
    tris: n,
    watertightHint: false,
    watertightNote: WATERTIGHT_NOTE,
    bbox,
    degenerate,
    issues,
  };
}
