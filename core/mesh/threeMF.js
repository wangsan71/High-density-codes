/**
 * core/mesh/threeMF.js — 手写 OPC/ZIP 容器 + 3MF 模型 XML + 水密判据。
 *
 * 纯 ESM、零依赖、Node 与浏览器同一份：只用 Uint8Array / DataView / TextEncoder，
 * **不 import 任何 `node:` 模块**（zip 与 DEFLATE 都是仓库自研的：`core/deflate.js`，
 * CRC-32 是 `core/crc.js`，两者已在 G0 分别钉在 node:zlib / node:crypto 上对拍过）。
 *
 * ── 风格对齐 `core/mesh/stl.js` ──────────────────────────────────────────────
 *   `encode3MF()` 出字节，`selfCheck3MF()` 从字节回读并自证；确定性、拒绝退化三角形、
 *   不许有 `watertightHint` 这种"看起来对"的字段 —— 水密在这里是一个**可数的事实**
 *   （`manifoldReport()`：每条无向边恰被两个三角形共用），生成时逐部件硬断言。
 *
 * ── 确定性（同输入 ⇒ 逐字节相同）───────────────────────────────────────────
 *   zip 条目顺序固定（`[Content_Types].xml`、`_rels/.rels`、`3D/3dmodel.model`）；
 *   每条目的 DOS 时间/日期写死为 1980-01-01 00:00:00；不含外部文件属性/UID/注释；
 *   压缩与否由"压完是不是更小"这个纯函数决定，不看环境；坐标 `toFixed(6)` 位数写死。
 *   与 `stl.js` 的 80 字节头同一套思路：把版本与三角形数编进去，不把时间编进去。
 *
 * ── 压缩：store 或自研 raw deflate，两条都支持 ──────────────────────────────
 *   method 0（store）与 method 8（deflate，`deflateRaw()` 出来的裸 RFC1951 流）。
 *   默认 `auto` = 每条目单独比较大小后取小的那个。`selfCheck3MF()` 会**解压回读并逐
 *   字节比对**，CRC-32 也重算比对；`ref/verify_model.py` 再用 Python 的 `zipfile`
 *   （背后是 zlib）独立解一遍 —— 自研 deflate 的 round-trip 证据因此在两边各有一份。
 *
 * ── 3MF 规范落点（3MF Core 1.4，附录 B.1 XSD + 第 3/4/5 章）─────────────────
 *   * `<model unit="millimeter">`：单位属性名是 `unit`（`MESH-CONTRACT.md` §5 里写的
 *     `<unit millimeter="millimeter">` 不是合法 3MF，这里按规范落；单位仍是 mm，数字没动）。
 *   * **不写 `zUp`**：core 1.4 的 `<model>` 属性只有 unit / xml:lang / requiredextensions
 *     / recommendedextensions（XSD `CT_Model`），§3.1 直接规定"右手系、+Z 朝上、原点在
 *     底面前左"。写一个 schema 里没有的 `zUp="false"` 才是偏离规范；坐标系由 §3.1 保证，
 *     并由 `ref/verify_model.py` 反向核对（min z = 打印床 = 0、材料在 z>0）。
 *   * 三角形顶点序 = 逆时针、法向朝外（§4.1.3），与 `solids.js` 的右手定则约定一致。
 *   * `<basematerials>` / `<base name displaycolor>` 是 core 元素（第 5 章 + XSD
 *     `CT_BaseMaterials`），所以本文件不需要任何扩展命名空间。
 *   * §3.4 要求"先定义后引用" ⇒ `<basematerials>` 排在所有 `<object>` 之前。
 *
 * ── 多个 `<object>`：为什么不是"一个"（诚实条款）────────────────────────────
 *   `MESH-CONTRACT.md` §5 写"<object type=\"model\"> 一个"，同一节又要求"每条无向边恰
 *   被两个三角形使用两次"这两条在"底板 + 立在它上面的浮雕"这个几何下不能同时为真吗？
 *   实测：底板顶面与各浮雕脚底在 z=PLATE_MM **共面重合**，但两者的边互不重合（脚底的短边
 *   落在顶面大三角形的内部），所以合并成一张 mesh 时"每边恰两次"这条计数**照样通过**——
 *   也就是说，这条计数在合并 mesh 上**什么也没证明**（一个自相交的壳集合可以完美通过它）。
 *   那正是 `watertightHint` 那一类假绿。所以我们按 PLAN §G8 的"底板 + 色A/色B 合并岛 +
 *   `<basematerials>`"分部件，并且只在**单个部件内**断言水密（那里的每条边都真的只属于
 *   两个三角形，且该部件符号体积 > 0 ⇒ 法向确实朝外）；跨部件的共面/重叠事实记录在
 *   `facts.assembly` 与 `MANIFOLD_NOTE` 里，绝不声称整个装配是布尔并（§4 禁止）。
 */

import { crc32 } from '../crc.js';
import { deflateRaw, inflateRaw } from '../deflate.js';
import { sha256Hex } from '../hash.js';

/* ═════════════════════════════ 常量 ═════════════════════════════ */

/** 3MF 规范要求的三个包内条目名（顺序也固定，见文件头"确定性"）。 */
export const CONTENT_TYPES_PART = '[Content_Types].xml';
export const RELS_PART = '_rels/.rels';
export const MODEL_PART = '3D/3dmodel.model';

export const CORE_NS = 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02';
export const CONTENT_TYPES_NS = 'http://schemas.openxmlformats.org/package/2006/content-types';
export const RELATIONSHIPS_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
export const START_PART_REL_TYPE = 'http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel';
export const MODEL_CONTENT_TYPE = 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml';

/** 写死的 DOS 时间戳 = 1980-01-01 00:00:00（zip 的纪元）。 */
export const ZIP_DOS_TIME = 0x0000;
export const ZIP_DOS_DATE = 0x0021; // bit0-4=日(1) bit5-8=月(1) bit9-15=年-1980(0)

/** version-made-by / version-needed-to-extract：2.0，宿主系统 0 = MS-DOS/FAT。 */
const ZIP_VERSION = 0x0014;
const ZIP_ATTR_ARCHIVE = 0x20;
const ZIP_LOCAL_SIG = 0x04034b50;
const ZIP_CENTRAL_SIG = 0x02014b50;
const ZIP_EOCD_SIG = 0x06054b50;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

/** 坐标文本的小数位数；与 `plate.js:WELD_DECIMALS` 同值，写死不用环境变量。 */
export const COORD_DECIMALS = 6;

/** 编码器版本：进 ZIP 注释? 不，进 XML metadata，且不含时间。 */
export const THREE_MF_PRODUCER = 'PSKT pskit M5/1 (hand-written OPC writer, zero dependency)';

/** STL 侧不许"改进"成水密声明；3MF 侧的说法在这里。 */
export const MANIFOLD_NOTE =
  'watertightness is asserted per 3MF object (every undirected edge used exactly twice, consistent outward orientation, positive signed volume); ' +
  'objects may touch or overlap each other - that is not a boolean union and is never claimed (MESH-CONTRACT.md §4)';

/** 判据定义（一句话，给报告和测试引用）。 */
const MANIFOLD_RULE = 'every undirected edge is shared by exactly two triangles';

/* ═════════════════════ 水密 / 拓扑判据（纯函数） ═════════════════════ */

function asTriangles(triangles) {
  if (!(triangles instanceof Float64Array) && !(triangles instanceof Float32Array) && !Array.isArray(triangles)) {
    throw new Error(`manifoldReport: expected a flat triangle array, got ${String(triangles)}`);
  }
  if (triangles.length % 9 !== 0) {
    throw new Error(`manifoldReport: length ${triangles.length} is not a multiple of 9`);
  }
  return triangles;
}

/**
 * 焊接后拓扑上的水密/定向报告 —— **判据本体**。
 *
 * @param {Float64Array} triangles 扁平三角形顶点（每三角形 9 个 double）
 * @param {object} [opt]
 * @param {number} [opt.decimals=6] 焊接精度（先量化再判边，和 3MF 文件里存的是同一套顶点）
 * @param {boolean} [opt.vertexLinks=true] 是否顺便检查"每个顶点的链接是单个环"
 *        （关掉它只影响 `nonManifoldVertices` 这一项；边计数与体积不受影响）
 */
export function manifoldReport(triangles, opt = {}) {
  const t = asTriangles(triangles);
  const w = weldTrianglesLocal(t, opt.decimals ?? COORD_DECIMALS);
  return manifoldReportIndexed(w.vertices, w.indices, opt);
}

/** 已经是 (顶点表, 索引表) 的那一份 —— 3MF 编码器直接用，避免二次焊接。 */
export function manifoldReportIndexed(vertices, indices, opt = {}) {
  if (vertices.length % 3 !== 0) throw new Error(`manifold: vertex length ${vertices.length} is not a multiple of 3`);
  if (indices.length % 3 !== 0) throw new Error(`manifold: index count ${indices.length} is not a multiple of 3`);
  const vcount = vertices.length / 3;
  const fcount = indices.length / 3;
  const issues = [];

  const undirected = new Map(); // key -> count
  const directed = new Map(); // 'a>b' -> count
  const degenerate = [];
  let volume = 0;
  const wantLinks = opt.vertexLinks !== false;
  /** @type {Map<number, number[]>|null} */
  const links = wantLinks ? new Map() : null;

  for (let f = 0; f < fcount; f++) {
    const o = f * 3;
    const a = indices[o];
    const b = indices[o + 1];
    const c = indices[o + 2];
    for (const [n, v] of [['v1', a], ['v2', b], ['v3', c]]) {
      if (!(v >= 0 && v < vcount) || !Number.isInteger(v)) {
        throw new Error(`manifold: triangle #${f} ${n} index ${v} out of vertex range 0..${vcount - 1}`);
      }
    }
    if (a === b || b === c || c === a) {
      if (degenerate.length < 3) degenerate.push(f);
      issues.push(`manifold: triangle #${f} has a repeated vertex index (${a}, ${b}, ${c})`);
      continue;
    }
    // 面积/法向（右手定则），同时用于符号体积
    const ax = vertices[a * 3], ay = vertices[a * 3 + 1], az = vertices[a * 3 + 2];
    const bx = vertices[b * 3], by = vertices[b * 3 + 1], bz = vertices[b * 3 + 2];
    const cx = vertices[c * 3], cy = vertices[c * 3 + 1], cz = vertices[c * 3 + 2];
    const nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
    const ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    const nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const area2 = Math.hypot(nx, ny, nz);
    if (!(area2 > 1e-12)) {
      if (degenerate.length < 3) degenerate.push(f);
      issues.push(`manifold: triangle #${f} is degenerate (2*area = ${area2.toExponential(3)})`);
    }
    volume += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
    for (const [p, q] of [[a, b], [b, c], [c, a]]) {
      const uk = p < q ? p + '|' + q : q + '|' + p;
      undirected.set(uk, (undirected.get(uk) || 0) + 1);
      const dk = p + '>' + q;
      directed.set(dk, (directed.get(dk) || 0) + 1);
    }
    if (wantLinks) {
      // 顶点链接：包含 v 的每个三角形给链接图添一条"另外两个顶点"之间的边
      pushLink(links, a, b, c);
      pushLink(links, b, c, a);
      pushLink(links, c, a, b);
    }
  }

  let usedOnce = 0;
  let usedTwice = 0;
  let usedOverTwo = 0;
  let inconsistent = 0;
  const exampleBadEdge = [];
  for (const [k, n] of undirected) {
    if (n === 1) usedOnce++;
    else if (n === 2) usedTwice++;
    else usedOverTwo++;
    if (n !== 2 && exampleBadEdge.length < 3) exampleBadEdge.push(`${k} used ${n}x`);
    const [p, q] = k.split('|').map(Number);
    const dp = directed.get(p + '>' + q) || 0;
    const dq = directed.get(q + '>' + p) || 0;
    // 可定向闭曲面：同一条无向边必须被两个三角形**反向**各用一次
    if (dp !== 1 || dq !== 1) inconsistent++;
  }

  let nonManifoldVertices = 0;
  if (wantLinks) {
    // 流形顶点的**链接必须是单个环**：图节点 = 与 v 相邻的顶点，包含 v 的每个三角形
    // 给链接图添一条 (n1,n2) 边。判据：每个节点度 2，且从任一节点能走完所有节点。
    // 这一步专门抓"两个壳只共一个顶点"的捏合点（pinch）——那种网格每条边都恰好
    // 两次、体积也正，单看边计数会假绿；链接检查不会放过它。
    for (const [, pairs] of links) {
      const nbr = new Map();
      const add = (p, q) => {
        let l = nbr.get(p);
        if (!l) {
          l = [];
          nbr.set(p, l);
        }
        l.push(q);
      };
      for (const [p, q] of pairs) {
        add(p, q);
        add(q, p);
      }
      const nodes = nbr.size;
      let singleCycle = nodes > 0;
      for (const l of nbr.values()) if (l.length !== 2) singleCycle = false;
      if (singleCycle) {
        const start = nbr.keys().next().value;
        const seen = new Set([start]);
        const stack = [start];
        while (stack.length) {
          const x = stack.pop();
          for (const y of nbr.get(x)) {
            if (!seen.has(y)) {
              seen.add(y);
              stack.push(y);
            }
          }
        }
        if (seen.size !== nodes) singleCycle = false;
      }
      if (!singleCycle) nonManifoldVertices++;
    }
  }

  const components = countComponents(vertices, indices);
  const edges = undirected.size;
  const euler = vcount - edges + fcount;
  const ok = issues.length === 0 && usedOnce === 0 && usedOverTwo === 0 && inconsistent === 0 && nonManifoldVertices === 0 && volume > 0;
  if (ok === false) {
    if (usedOnce) issues.push(`manifold: ${usedOnce} edge(s) used once (open surface)`);
    if (usedOverTwo) issues.push(`manifold: ${usedOverTwo} edge(s) used more than twice (coincident / non-manifold faces) ${exampleBadEdge.join(' ')}`);
    if (inconsistent) issues.push(`manifold: ${inconsistent} edge(s) not used in opposite directions by their two triangles (orientation inconsistent)`);
    if (nonManifoldVertices) issues.push(`manifold: ${nonManifoldVertices} vertex/vertices whose link is not a single cycle (pinch / cone point)`);
    if (!(volume > 0)) issues.push(`manifold: signed volume ${volume} must be positive (normals point outward)`);
  }

  return {
    ok,
    vertices: vcount,
    triangles: fcount,
    edges,
    edgesUsedOnce: usedOnce,
    edgesUsedTwice: usedTwice,
    edgesUsedOverTwo: usedOverTwo,
    orientationConsistent: inconsistent === 0,
    nonManifoldVertices,
    components,
    euler,
    volumeMm3: volume,
    degenerate: degenerate.length,
    rule: MANIFOLD_RULE,
    issues: issues.slice(0, 8),
  };
}

function pushLink(map, v, n1, n2) {
  let list = map.get(v);
  if (!list) {
    list = [];
    map.set(v, list);
  }
  list.push([n1, n2]);
}

/** 连通分量（并查集，按三角形索引做三次合并：同一三角形的顶点同属一壳）。 */
function countComponents(vertices, indices) {
  const vcount = vertices.length / 3;
  const parent = new Int32Array(vcount);
  for (let i = 0; i < vcount; i++) parent[i] = i;
  const find = (x) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  for (let o = 0; o < indices.length; o += 3) {
    const a = find(indices[o]);
    const b = find(indices[o + 1]);
    const c = find(indices[o + 2]);
    if (a !== b) parent[b] = a;
    if (a !== c) parent[c] = find(a);
  }
  let n = 0;
  for (let i = 0; i < vcount; i++) if (find(i) === i) n++;
  return n;
}

/** 本地焊接（不复用 solids.weldTriangles 的返回值形态，但同一套量化规则与同一套顺序）。 */
function weldTrianglesLocal(triangles, decimals) {
  const scale = 10 ** decimals;
  const map = new Map();
  const vertices = [];
  const indices = [];
  for (let i = 0; i < triangles.length; i += 3) {
    const x = Math.round(triangles[i] * scale) / scale;
    const y = Math.round(triangles[i + 1] * scale) / scale;
    const z = Math.round(triangles[i + 2] * scale) / scale;
    const key = x + ',' + y + ',' + z;
    let at = map.get(key);
    if (at === undefined) {
      at = vertices.length / 3;
      map.set(key, at);
      vertices.push(x, y, z);
    }
    indices.push(at);
  }
  return { vertices: Float64Array.from(vertices), indices: Uint32Array.from(indices) };
}

/* ═════════════════════════════ OPC / ZIP ═════════════════════════════ */

const enc = new TextEncoder();

function u16(view, off, v) {
  view.setUint16(off, v, true);
}
function u32(view, off, v) {
  view.setUint32(off, v >>> 0, true);
}

function dosStamp() {
  return { time: ZIP_DOS_TIME, date: ZIP_DOS_DATE };
}

/**
 * 写一个只含"store + 自研 raw deflate"两种方法的 zip。
 *
 * 条目顺序 = 传入顺序（调用方给的就是固定顺序）；时间戳/外部属性/版本全部写死；
 * 没有 zip 注释、没有 extra field、没有 Unicode 扩展（条目名都是 ASCII）。
 *
 * @param {{name:string, data:Uint8Array, method?:'auto'|'store'|'deflate'}[]} entries
 * @returns {Uint8Array}
 */
export function buildZip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  const { time, date } = dosStamp();
  let totalSize = 0;

  for (const e of entries) {
    const nameBytes = enc.encode(e.name);
    if (!e.data || !(e.data instanceof Uint8Array)) {
      throw new Error(`zip: entry "${e.name}" data must be a Uint8Array`);
    }
    for (const ch of e.name) {
      const code = ch.charCodeAt(0);
      if (code < 0x20 || code > 0x7e) throw new Error(`zip: entry name "${e.name}" must be printable ASCII (determinism + OPC)`);
    }
    if (e.name.startsWith('/') || e.name.includes('\\')) throw new Error(`zip: entry name "${e.name}" must be a relative POSIX part name`);

    let method = METHOD_STORE;
    let payload = e.data;
    const want = e.method || 'auto';
    if (want === 'deflate' || want === 'auto') {
      const deflated = deflateRaw(e.data);
      if (want === 'deflate' || deflated.length < e.data.length) {
        payload = deflated;
        method = METHOD_DEFLATE;
      }
    }
    if (want === 'store') {
      method = METHOD_STORE;
      payload = e.data;
    }
    const crc = crc32(e.data); // CRC 永远算**未压缩**数据 —— zip 的定义，也是 selfCheck 的抓手
    const local = 30 + nameBytes.length + payload.length;
    const head = new Uint8Array(30 + nameBytes.length);
    const hv = new DataView(head.buffer);
    u32(hv, 0, ZIP_LOCAL_SIG);
    u16(hv, 4, ZIP_VERSION);
    u16(hv, 6, 0); // general purpose flags: 全 0（没有加密/没有 data descriptor/名字是 ASCII）
    u16(hv, 8, method);
    u16(hv, 10, time);
    u16(hv, 12, date);
    u32(hv, 14, crc);
    u32(hv, 18, payload.length);
    u32(hv, 22, e.data.length);
    u16(hv, 26, nameBytes.length);
    u16(hv, 28, 0); // extra field length
    head.set(nameBytes, 30);
    parts.push(head, payload);

    const cen = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cen.buffer);
    u32(cv, 0, ZIP_CENTRAL_SIG);
    u16(cv, 4, ZIP_VERSION); // version made by
    u16(cv, 6, ZIP_VERSION); // version needed
    u16(cv, 8, 0); // flags
    u16(cv, 10, method);
    u16(cv, 12, time);
    u16(cv, 14, date);
    u32(cv, 16, crc);
    u32(cv, 20, payload.length);
    u32(cv, 24, e.data.length);
    u16(cv, 28, nameBytes.length);
    u16(cv, 30, 0); // extra
    u16(cv, 32, 0); // comment
    u16(cv, 34, 0); // disk number start
    u16(cv, 36, 0); // internal attributes
    u32(cv, 38, ZIP_ATTR_ARCHIVE); // external attributes: 只带 DOS archive 位
    u32(cv, 42, offset); // relative offset of local header
    cen.set(nameBytes, 46);
    central.push(cen);

    offset += local;
    totalSize += local;
  }

  const cdStart = totalSize;
  let cdSize = 0;
  for (const c of central) cdSize += c.length;
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  u32(ev, 0, ZIP_EOCD_SIG);
  u16(ev, 4, 0);
  u16(ev, 6, 0);
  u16(ev, 8, entries.length);
  u16(ev, 10, entries.length);
  u32(ev, 12, cdSize);
  u32(ev, 16, cdStart);
  u16(ev, 20, 0); // comment length
  if (offset > 0xffffff || entries.length > 0xffff) {
    // 不静默写坏文件：ZIP64 我们没有实现。
    throw new Error(`zip: ${entries.length} entries / ${offset} bytes exceed the non-ZIP64 limits`);
  }
  const out = new Uint8Array(cdStart + cdSize + end.length);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  for (const c of central) {
    out.set(c, o);
    o += c.length;
  }
  out.set(end, o);
  return out;
}

/**
 * 读回一个 zip（只为自证与 G8 投影脚本服务；独立的那一份解析在 `ref/verify_model.py`）。
 * 逐条目校验 CRC-32 与长度，decompressed 数据用 `inflateRaw` 解，任何不一致都抛错。
 */
export function readZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.byteLength < 22) throw new Error('zip: shorter than an end-of-central-directory record');
  let eocd = -1;
  for (let p = view.byteLength - 22; p >= Math.max(0, view.byteLength - 66000); p--) {
    if (view.getUint32(p, true) === ZIP_EOCD_SIG) {
      eocd = p;
      break;
    }
  }
  if (eocd < 0) throw new Error('zip: no end-of-central-directory record found');
  const count = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  const cdStart = view.getUint32(eocd + 16, true);
  const commentLen = view.getUint16(eocd + 20, true);
  if (eocd + 22 + commentLen !== view.byteLength) throw new Error('zip: trailing bytes after the EOCD record');
  if (cdStart + cdSize !== eocd) throw new Error('zip: central directory does not end where the EOCD says it does');

  const entries = [];
  let p = cdStart;
  for (let i = 0; i < count; i++) {
    if (view.getUint32(p, true) !== ZIP_CENTRAL_SIG) throw new Error(`zip: central header #${i} signature missing`);
    const method = view.getUint16(p + 10, true);
    const time = view.getUint16(p + 12, true);
    const date = view.getUint16(p + 14, true);
    const crc = view.getUint32(p + 16, true) >>> 0;
    const compSize = view.getUint32(p + 20, true);
    const rawSize = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const cmtLen = view.getUint16(p + 32, true);
    const localOff = view.getUint32(p + 42, true);
    const name = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + cmtLen;

    if (view.getUint32(localOff, true) !== ZIP_LOCAL_SIG) throw new Error(`zip: "${name}" local header signature missing`);
    const lMethod = view.getUint16(localOff + 8, true);
    const lTime = view.getUint16(localOff + 10, true);
    const lDate = view.getUint16(localOff + 12, true);
    const lCrc = view.getUint32(localOff + 14, true) >>> 0;
    const lComp = view.getUint32(localOff + 18, true);
    const lRaw = view.getUint32(localOff + 22, true);
    const lNameLen = view.getUint16(localOff + 26, true);
    const lExtraLen = view.getUint16(localOff + 28, true);
    if (lMethod !== method || lCrc !== crc || lComp !== compSize || lRaw !== rawSize) {
      throw new Error(`zip: "${name}" local header disagrees with the central directory`);
    }
    if (lTime !== time || lDate !== date) throw new Error(`zip: "${name}" local/central timestamps differ`);
    if (lNameLen !== nameLen) throw new Error(`zip: "${name}" local/central name lengths differ`);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const comp = bytes.subarray(dataStart, dataStart + compSize);
    let raw;
    if (method === METHOD_STORE) {
      if (compSize !== rawSize) throw new Error(`zip: "${name}" stored entry with compSize != rawSize`);
      raw = comp.slice();
    } else if (method === METHOD_DEFLATE) {
      raw = inflateRaw(comp, rawSize);
    } else {
      throw new Error(`zip: "${name}" uses compression method ${method}; this reader only knows 0 (store) and 8 (raw deflate)`);
    }
    if (raw.length !== rawSize) throw new Error(`zip: "${name}" inflated to ${raw.length} bytes, central directory said ${rawSize}`);
    const gotCrc = crc32(raw);
    if (gotCrc !== crc) throw new Error(`zip: "${name}" CRC-32 mismatch (wrote 0x${crc.toString(16)}, content hashes 0x${gotCrc.toString(16)})`);
    entries.push({ name, method, dosTime: time, dosDate: date, crc32: crc, compressedSize: compSize, size: rawSize, data: raw, offset: localOff });
  }
  return entries;
}

/* ═════════════════════════════ 3MF XML ═════════════════════════════ */

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\r/g, '&#13;')
    .replace(/\n/g, '&#10;');
}

function fmtCoord(v, decimals = COORD_DECIMALS) {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`3mf: non-finite coordinate ${v}`);
  const fixed = Math.abs(n) < 0.5 * 10 ** -decimals ? 0 : n; // 抹掉 "-0.000000"
  return fixed.toFixed(decimals);
}

export const CONTENT_TYPES_XML =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  `<Types xmlns="${CONTENT_TYPES_NS}">` +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  `<Default Extension="model" ContentType="${MODEL_CONTENT_TYPE}"/>` +
  '</Types>';

export const RELS_XML =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  `<Relationships xmlns="${RELATIONSHIPS_NS}">` +
  `<Relationship Id="rId1" Type="${START_PART_REL_TYPE}" Target="/${MODEL_PART}"/>` +
  '</Relationships>';

/**
 * 生成 `3D/3dmodel.model` 的文本。
 *
 * @param {object} o
 * @param {{name:string, materialName?:string, displayColor?:string, vertices:Float64Array, indices:Uint32Array}[]} o.objects
 * @param {Record<string,string|number>} [o.metadata] 写进 `<metadata name="...">`
 * @param {number} [o.decimals]
 */
export function modelXml({ objects, metadata = {}, decimals = COORD_DECIMALS }) {
  if (!Array.isArray(objects) || !objects.length) throw new Error('modelXml: at least one object is required');
  const lines = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(`<model unit="millimeter" xml:lang="en-US" xmlns="${CORE_NS}">`);
  lines.push(`<metadata name="Application">${xmlEscape(THREE_MF_PRODUCER)}</metadata>`);
  const metaNames = Object.keys(metadata).sort(); // 排序：调用方对象键顺序不影响字节（确定性）
  for (const k of metaNames) {
    const v = metadata[k];
    if (v === null || v === undefined) continue;
    // 只收字符串与有限数：对象在这里会变成 "[object Object]" 写进模型，那是"看起来
    // 成功但是错"的那一类失败，宁可拒写。结构化的值请调用方自己 JSON.stringify。
    if (typeof v === 'object') throw new Error(`modelXml: metadata "${k}" is an object; pass JSON.stringify(...) if you mean to embed it`);
    if (typeof v === 'number' && !Number.isFinite(v)) throw new Error(`modelXml: metadata "${k}" is not finite`);
    lines.push(`<metadata name="${xmlEscape(k)}">${xmlEscape(typeof v === 'number' ? String(v) : String(v))}</metadata>`);
  }
  lines.push('<resources>');
  // 先定义后引用（§3.4）⇒ basematerials 必须在 object 之前
  const materials = [];
  const pindexOf = [];
  for (const o of objects) {
    if (!o.materialName) {
      pindexOf.push(null);
      continue;
    }
    let at = materials.findIndex((m) => m.name === o.materialName);
    if (at < 0) {
      materials.push({ name: o.materialName, color: o.displayColor || '#CCCCCCCC' });
      at = materials.length - 1;
    }
    pindexOf.push(at);
  }
  if (materials.length) {
    lines.push('<basematerials id="1">');
    for (const m of materials) lines.push(`<base name="${xmlEscape(m.name)}" displaycolor="${xmlEscape(m.color)}"/>`);
    lines.push('</basematerials>');
  }
  const ids = objects.map((_, i) => i + 2); // id=1 已经给了 basematerials
  objects.forEach((o, i) => {
    const id = ids[i];
    const pid = pindexOf[i] === null || !materials.length ? '' : ` pid="1" pindex="${pindexOf[i]}"`;
    lines.push(`<object id="${id}" type="model" name="${xmlEscape(o.name)}"${pid}>`);
    lines.push('<mesh>');
    lines.push('<vertices>');
    const v = o.vertices;
    for (let k = 0; k + 2 < v.length; k += 3) {
      lines.push(`<vertex x="${fmtCoord(v[k], decimals)}" y="${fmtCoord(v[k + 1], decimals)}" z="${fmtCoord(v[k + 2], decimals)}"/>`);
    }
    lines.push('</vertices>');
    lines.push('<triangles>');
    const ix = o.indices;
    for (let k = 0; k + 2 < ix.length; k += 3) {
      lines.push(`<triangle v1="${ix[k]}" v2="${ix[k + 1]}" v3="${ix[k + 2]}"/>`);
    }
    lines.push('</triangles>');
    lines.push('</mesh>');
    lines.push('</object>');
  });
  lines.push('</resources>');
  lines.push('<build>');
  for (let i = 0; i < objects.length; i++) lines.push(`<item objectid="${ids[i]}"/>`);
  lines.push('</build>');
  lines.push('</model>');
  return lines.join('\n');
}

/* ═════════════════════════ 极简 XML 回读 ═════════════════════════ */

/**
 * 把 `3dmodel.model` 解析回结构（只为 selfCheck3MF / 投影脚本服务；独立解析在 Python）。
 * 故意只认自己写出来的那种形状：属性顺序固定、元素不嵌套命名空间。
 */
export function parseModelXml(text) {
  const modelOpen = /<model\b([^>]*)>/.exec(text);
  if (!modelOpen) throw new Error('parseModelXml: no <model> element');
  const attrs = {};
  const aRe = /([\w:.-]+)="([^"]*)"/g;
  let a;
  while ((a = aRe.exec(modelOpen[1]))) attrs[a[1]] = a[2];
  const metadata = {};
  const mRe = /<metadata name="([^"]*)">([\s\S]*?)<\/metadata>/g;
  let mm;
  while ((mm = mRe.exec(text))) metadata[mm[1]] = xmlUnescape(mm[2]);
  const materials = [];
  const bRe = /<base name="([^"]*)" displaycolor="([^"]*)"\/>/g;
  let bb;
  while ((bb = bRe.exec(text))) materials.push({ name: bb[1], displayColor: bb[2] });

  const objects = [];
  const oRe = /<object id="(\d+)" type="(\w+)" name="([^"]*)"(?: pid="(\d+)" pindex="(\d+)")?>\s*<mesh>\s*<vertices>([\s\S]*?)<\/vertices>\s*<triangles>([\s\S]*?)<\/triangles>\s*<\/mesh>\s*<\/object>/g;
  let o;
  while ((o = oRe.exec(text))) {
    const vertices = [];
    const vRe = /<vertex x="(-?[\d.]+)" y="(-?[\d.]+)" z="(-?[\d.]+)"\/>/g;
    let vv;
    while ((vv = vRe.exec(o[6]))) vertices.push(Number(vv[1]), Number(vv[2]), Number(vv[3]));
    const indices = [];
    const tRe = /<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"\/>/g;
    let tt;
    while ((tt = tRe.exec(o[7]))) indices.push(Number(tt[1]), Number(tt[2]), Number(tt[3]));
    const pindex = o[5] === undefined ? null : Number(o[5]);
    objects.push({
      id: Number(o[1]),
      type: o[2],
      name: xmlUnescape(o[3]),
      pid: o[4] === undefined ? null : Number(o[4]),
      pindex,
      material: pindex === null ? null : materials[pindex] ? materials[pindex].name : null,
      vertices: Float64Array.from(vertices),
      vertexCount: vertices.length / 3,
      indices: Uint32Array.from(indices),
      triangleCount: indices.length / 3,
    });
  }
  const build = [];
  const iRe = /<item objectid="(\d+)"\/>/g;
  let ii;
  while ((ii = iRe.exec(text))) build.push(Number(ii[1]));
  return { unit: attrs.unit || null, attributes: attrs, metadata, materials, objects, build, text };
}

function xmlUnescape(s) {
  return s.replace(/&#10;/g, '\n').replace(/&#13;/g, '\r').replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
}

/**
 * 从字节读出模型（zip → XML → 顶点/索引数组）。G8 的投影对拍与测试都走这条路，
 * 保证量的是**文件里的**几何，不是编码器手里的那一份。
 */
export function readModel3MF(bytes) {
  const entries = readZip(bytes);
  const byName = Object.fromEntries(entries.map((e) => [e.name, e]));
  const model = parseModelXml(new TextDecoder().decode(byName[MODEL_PART].data));
  return { entries, model };
}

/* ═════════════════════════════ 编码器 ═════════════════════════════ */

/**
 * 编码一个 3MF。
 *
 * @param {object} o
 * @param {{name:string, vertices:Float64Array, indices:Uint32Array, materialName?:string, displayColor?:string}[]} o.objects
 *        **已经焊接好**的部件（`plate.js` 给的就是）。
 * @param {Record<string,any>} [o.metadata] 模型级 metadata（含 pskt: 前缀的布局事实）
 * @param {'auto'|'store'|'deflate'} [o.compression='auto']
 * @param {number} [o.decimals=6]
 * @param {boolean} [o.requireManifold=true] 逐部件断言水密；不为真就抛错，不出文件
 * @returns {Uint8Array}
 */
export function encode3MF({ objects, metadata = {}, compression = 'auto', decimals = COORD_DECIMALS, requireManifold = true } = {}) {
  if (!Array.isArray(objects) || !objects.length) throw new Error('encode3MF: at least one object is required');
  for (const o of objects) {
    if (!(o.vertices instanceof Float64Array)) throw new Error(`encode3MF: object "${o.name}" needs Float64Array vertices`);
    if (!(o.indices instanceof Uint32Array)) throw new Error(`encode3MF: object "${o.name}" needs Uint32Array indices`);
    if (o.indices.length % 3 !== 0) throw new Error(`encode3MF: object "${o.name}" index count ${o.indices.length} is not a multiple of 3`);
    const rep = manifoldReportIndexed(o.vertices, o.indices, { vertexLinks: true });
    if (requireManifold && !rep.ok) {
      throw new Error(`encode3MF: object "${o.name}" is not watertight: ${rep.issues.join('; ')}`);
    }
  }
  const xml = modelXml({ objects, metadata, decimals });
  const modelBytes = enc.encode(xml);
  const entries = [
    { name: CONTENT_TYPES_PART, data: enc.encode(CONTENT_TYPES_XML), method: 'auto' },
    { name: RELS_PART, data: enc.encode(RELS_XML), method: 'auto' },
    { name: MODEL_PART, data: modelBytes, method: compression },
  ];
  const bytes = buildZip(entries);
  return bytes;
}

/**
 * 从字节回读并自证 —— 与 `stlSelfCheck()` 同一角色。
 *
 * 检查项：zip 条目名/顺序/CRC/长度/时间戳、store|deflate 解压后逐字节一致、
 * XML 里声明的顶点数/三角形数与真实元素数一致、索引全部落在顶点表内、
 * 逐部件水密报告（从**文件里**的顶点/索引重算，不是拿编码器传给自己的那份）、
 * 单位、build 项与 object id 一一对应、以及"同一份字节再编一次是否相同"由
 * 调用方（测试/CLI）用 `encode3MF` 重跑对比，这里只报告 sha256。
 */
export function selfCheck3MF(bytes, { expectTriangles = null } = {}) {
  const issues = [];
  const out = {
    ok: false,
    entries: [],
    model: null,
    objects: [],
    trianglesTotal: 0,
    verticesTotal: 0,
    watertight: false,
    sha256: null,
    issues,
    note: MANIFOLD_NOTE,
  };
  let parsed;
  try {
    parsed = readZip(bytes);
  } catch (e) {
    issues.push(`selfCheck3MF: zip unreadable: ${e.message}`);
    return out;
  }
  out.entries = parsed.map((e) => ({
    name: e.name,
    method: e.method,
    size: e.size,
    compressedSize: e.compressedSize,
    crc32: e.crc32 >>> 0,
    dosTime: e.dosTime,
    dosDate: e.dosDate,
  }));
  for (const e of parsed) {
    if (e.dosTime !== ZIP_DOS_TIME || e.dosDate !== ZIP_DOS_DATE) {
      issues.push(`selfCheck3MF: entry "${e.name}" carries a non-fixed DOS timestamp (${e.dosTime}/${e.dosDate})`);
    }
  }
  const names = parsed.map((e) => e.name).join(' ');
  if (names !== [CONTENT_TYPES_PART, RELS_PART, MODEL_PART].join(' ')) {
    issues.push(`selfCheck3MF: entry order is not the fixed OPC order (got "${names}")`);
  }
  const byName = Object.fromEntries(parsed.map((e) => [e.name, e]));
  let model;
  try {
    model = parseModelXml(new TextDecoder().decode(byName[MODEL_PART].data));
  } catch (e) {
    issues.push(`selfCheck3MF: model XML unreadable: ${e.message}`);
    return out;
  }
  out.model = { unit: model.unit, metadata: model.metadata, objects: model.objects.length, materials: model.materials.map((m) => m.name) };
  if (model.unit !== 'millimeter') issues.push(`selfCheck3MF: <model unit> is "${model.unit}", not "millimeter"`);
  if (new TextDecoder().decode(byName[RELS_PART].data).indexOf('/' + MODEL_PART) < 0) {
    issues.push('selfCheck3MF: _rels/.rels does not point at the model part');
  }
  if (new TextDecoder().decode(byName[CONTENT_TYPES_PART].data).indexOf(MODEL_CONTENT_TYPE) < 0) {
    issues.push('selfCheck3MF: [Content_Types].xml does not declare the 3MF model content type');
  }
  for (const o of model.objects) {
    const rep = manifoldReportIndexed(o.vertices, o.indices, { vertexLinks: true });
    out.objects.push({ name: o.name, id: o.id, vertices: o.vertexCount, triangles: o.triangleCount, material: o.material, manifold: rep });
    out.trianglesTotal += o.triangleCount;
    out.verticesTotal += o.vertexCount;
    if (!rep.ok) issues.push(`selfCheck3MF: object "${o.name}" is not watertight: ${rep.issues.join('; ')}`);
    if (o.vertexCount * 3 !== o.vertices.length) issues.push(`selfCheck3MF: object "${o.name}" vertex count mismatch`);
  }
  for (const id of model.build) {
    if (!model.objects.some((o) => o.id === id)) issues.push(`selfCheck3MF: <build> item refers to missing object id ${id}`);
  }
  if (!model.build.length) issues.push('selfCheck3MF: empty <build> -- a slicer would print nothing');
  if (expectTriangles !== null && expectTriangles !== out.trianglesTotal) {
    issues.push(`selfCheck3MF: ${out.trianglesTotal} triangles in the file, expected ${expectTriangles}`);
  }
  out.watertight = out.objects.length > 0 && out.objects.every((o) => o.manifold.ok);
  out.sha256 = sha256Hex(bytes).slice(0, 12);
  out.ok = issues.length === 0 && out.watertight && out.trianglesTotal > 0;
  return out;
}
