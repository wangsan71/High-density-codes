/**
 * tests/unit/mesh-3mf.test.mjs — core/mesh/threeMF.js + core/mesh/plate.js 单测（M5）。
 *
 * 跑法：
 *   node --test --test-isolation=none "tests/unit/mesh-3mf.test.mjs"
 *
 * 这个文件的规矩：新加的每一条严格守卫，这里都有一个**故意做坏**的输入去证明它真的
 * 会红（"新加的严格守卫若没有反例，只是把假绿换成假红"）。反例条目在下面都带
 * "反例" 两个字，方便一眼扫过去核对哪些判据是有承重的。
 *
 * 测试文件里允许 node: 前缀（只有 core/** 禁止）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';

import { crc32 } from '../../core/crc.js';
import { discTriangles, ringTriangles, boxTriangles, prismFromMask, weldTriangles, expandIndexedTriangles, boundingBox } from '../../core/mesh/solids.js';
import { encodeSTLSolid, triangleCount } from '../../core/mesh/stl.js';
import {
  manifoldReport,
  manifoldReportIndexed,
  buildZip,
  readZip,
  encode3MF,
  selfCheck3MF,
  readModel3MF,
  parseModelXml,
  modelXml,
  CONTENT_TYPES_PART,
  RELS_PART,
  MODEL_PART,
  CONTENT_TYPES_XML,
  RELS_XML,
  MODEL_CONTENT_TYPE,
  START_PART_REL_TYPE,
  ZIP_DOS_TIME,
  ZIP_DOS_DATE,
} from '../../core/mesh/threeMF.js';
import {
  PLATE_MM,
  RELIEF_MM,
  INK_SUNK_MM,
  QUIET_MM,
  PROJECTION_TOL_PCT,
  buildPlateModel,
  projectTopToCells,
  reliefTopMm,
  reliefSegments,
} from '../../core/mesh/plate.js';
import { planPage } from '../../core/profiles.js';
import { pageLayout } from '../../core/render/layout.js';
import { glyphSignature } from '../../core/render/glyphs.js';

/* ═════════════════════════════ 共用夹具 ═════════════════════════════ */

const PLATE_MM_ARG = 140;

function fixture(profile = 'PL-G', nozzle = '0.8', scale = 0.8) {
  const geom = planPage(profile, { nozzle, scale });
  const layout = pageLayout(geom, 300, { plateMm: geom.sheetMm ? geom.sheetMm.w : PLATE_MM_ARG });
  const levels = new Uint16Array(geom.totalCells);
  for (let i = 0; i < levels.length; i++) levels[i] = (i * 7919) % (1 << geom.bitsPerCell);
  return { geom, layout, levels };
}

function plateFixture() {
  const f = fixture();
  f.model = buildPlateModel({ geom: f.geom, levels: f.levels, layout: f.layout });
  f.bytes = encode3MF({ objects: f.model.objects, metadata: { 'pskt:profile': f.geom.profile } });
  return f;
}

function expandObject(o) {
  const out = new Float64Array(o.triangleCount * 9);
  for (let f = 0; f < o.triangleCount; f++) {
    for (let k = 0; k < 3; k++) {
      const v = o.indices[f * 3 + k] * 3;
      out[f * 9 + k * 3] = o.vertices[v];
      out[f * 9 + k * 3 + 1] = o.vertices[v + 1];
      out[f * 9 + k * 3 + 2] = o.vertices[v + 2];
    }
  }
  return out;
}

function fileTriangles(bytes) {
  const { model } = readModel3MF(bytes);
  const all = model.objects.map(expandObject);
  let n = 0;
  for (const a of all) n += a.length;
  const out = new Float64Array(n);
  let at = 0;
  for (const a of all) {
    out.set(a, at);
    at += a.length;
  }
  return { tris: out, model, objects: all };
}

function readSTL(u8) {
  const n = triangleCount(u8);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const out = new Float64Array(n * 9);
  for (let t = 0; t < n; t++) {
    const o = 84 + t * 50;
    for (let k = 0; k < 3; k++) {
      out[t * 9 + k * 3] = dv.getFloat32(o + 12 + k * 12, true);
      out[t * 9 + k * 3 + 1] = dv.getFloat32(o + 16 + k * 12, true);
      out[t * 9 + k * 3 + 2] = dv.getFloat32(o + 20 + k * 12, true);
    }
  }
  return out;
}

/* ═════════════════════════ 1. 手写 zip：CRC / 确定性 ═════════════════════════ */

test('buildZip/readZip: 条目顺序、CRC 与 node:zlib 对拍，读回逐字节相同', () => {
  const a = new TextEncoder().encode('PSKT 3MF model part \u2014 ascii only in zip names');
  const b = new Uint8Array(70000).fill(7); // 压得动的内容：走 deflate 分支
  const c = new Uint8Array([1, 2, 3]); // 压不动的短内容：走 store 分支
  const bytes = buildZip([
    { name: '[Content_Types].xml', data: a },
    { name: '_rels/.rels', data: b },
    { name: '3D/3dmodel.model', data: c },
  ]);
  const entries = readZip(bytes);
  assert.deepEqual(entries.map((e) => e.name), ['[Content_Types].xml', '_rels/.rels', '3D/3dmodel.model']);
  assert.deepEqual(
    entries.map((e) => e.data.length),
    [a.length, b.length, c.length],
    '解压回来的长度必须等于原始长度',
  );
  assert.ok(entries.every((e, i) => [a, b, c][i].every((v, k) => v === e.data[k])), '内容逐字节相同');
  // CRC-32：自研实现 vs node:zlib（G0 的交叉验证在 core/crc.js 里；这里钉住"写进 zip 的
  // 那份 CRC"确实是同一算法，Python 的 zipfile 在 ref/verify_model.py 里再独立对一次）
  for (const e of entries) {
    assert.equal(e.crc32 >>> 0, zlib.crc32(Buffer.from(e.data)) >>> 0, `${e.name} 的 CRC 必须等于 zlib.crc32`);
  }
  const methods = entries.map((e) => e.method);
  assert.equal(methods[2], 0, '3 字节的东西 deflate 只会变大 ⇒ store');
  assert.equal(methods[1], 8, '70000 字节的定值能被 deflate 压小 ⇒ deflate');
});

test('buildZip: 没有任何时间成分 —— DOS time/date 全是写死的常数', () => {
  const bytes = buildZip([{ name: 'x.txt', data: new TextEncoder().encode('hello') }]);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const view = bytes;
  // 本地头（offset 10/12）+ 中央目录（offset 12/14）都扫一遍，不信任 reader
  let localSeen = 0;
  let centralSeen = 0;
  for (let p = 0; p + 4 <= view.length; p++) {
    const sig = dv.getUint32(p, true);
    if (sig === 0x04034b50) {
      assert.equal(dv.getUint16(p + 10, true), ZIP_DOS_TIME, '本地头 modtime');
      assert.equal(dv.getUint16(p + 12, true), ZIP_DOS_DATE, '本地头 moddate');
      assert.equal(dv.getUint16(p + 28, true), 0, 'extra field 必须为空（多一个字节都会破坏确定性）');
      localSeen++;
    } else if (sig === 0x02014b50) {
      assert.equal(dv.getUint16(p + 12, true), ZIP_DOS_TIME, '中央目录 modtime');
      assert.equal(dv.getUint16(p + 14, true), ZIP_DOS_DATE, '中央目录 moddate');
      centralSeen++;
    }
  }
  assert.equal(localSeen, 1);
  assert.equal(centralSeen, 1);
  assert.deepEqual([ZIP_DOS_TIME, ZIP_DOS_DATE], [0x0000, 0x0021], '常数就是 1980-01-01 00:00:00');
});

test('readZip 是承重的（反例）：改一个内容字节，CRC 检查必须炸', () => {
  const data = new TextEncoder().encode('ABCDEFGH');
  const bytes = buildZip([{ name: 'a.bin', data }]);
  const mutated = bytes.slice();
  const at = 30 + 'a.bin'.length + 2; // 越过本地头与名字，指进负载
  mutated[at] = mutated[at] ^ 0xff;
  assert.throws(() => readZip(mutated), /CRC-32 mismatch/, '内容被改动必须被 CRC 抓住');
  const head = bytes.slice();
  head[0] = 0x58; // 本地头魔数改掉
  assert.throws(() => readZip(head), /local header signature/, '魔数坏了也必须炸');
});

/* ═════════════════════════ 2. 水密判据本体 ═════════════════════════ */

const SOLID_3 = { zBottom: 0, zTop: 0.3 };

test('manifoldReport: 单个 disc / ring / box 都是封闭壳（体积正、Euler 对）', () => {
  const disc = manifoldReport(discTriangles({ ...SOLID_3, radiusMm: 1, segments: 24 }));
  assert.equal(disc.ok, true, disc.issues.join(';'));
  assert.equal(disc.euler, 2, '圆柱面的 Euler 特征 = 2');
  assert.ok(disc.volumeMm3 > 0, '符号体积必须为正 ⇒ 法向确实朝外');
  assert.equal(disc.components, 1);
  const ring = manifoldReport(ringTriangles({ ...SOLID_3, outerRadiusMm: 1, innerRadiusMm: 0.6, segments: 24 }));
  assert.equal(ring.ok, true, ring.issues.join(';'));
  assert.equal(ring.euler, 0, '环带挤出体的边界是环面 ⇒ χ=0（不是 χ=2，别拿"闭曲面=球"想当然）');
  assert.ok(ring.volumeMm3 > 0);
  const box = manifoldReport(boxTriangles({ xMinMm: 0, xMaxMm: 2, yMinMm: 0, yMaxMm: 1, zBottom: 0, zTop: 0.5 }));
  assert.equal(box.ok, true, box.issues.join(';'));
  assert.equal(box.euler, 2);
  assert.equal(box.vertices, 8);
  assert.equal(box.triangles, 12);
  assert.ok(Math.abs(box.volumeMm3 - 1.0) < 1e-12, `盒子体积 = 2*1*0.5 = 1，实得 ${box.volumeMm3}`);
});

test('manifoldReport: 两个不相交实体并成一组仍然合法（这就是每格一实体能水密的原因）', () => {
  const a = discTriangles({ ...SOLID_3, radiusMm: 0.5, segments: 16, offsetXmm: 0, offsetYmm: 0 });
  const b = discTriangles({ ...SOLID_3, radiusMm: 0.5, segments: 16, offsetXmm: 5, offsetYmm: 0 });
  const joined = new Float64Array(a.length + b.length);
  joined.set(a, 0);
  joined.set(b, a.length);
  const rep = manifoldReport(joined);
  assert.equal(rep.ok, true, rep.issues.join(';'));
  assert.equal(rep.components, 2, '两个壳');
  assert.equal(rep.euler, 4, 'χ 必须按壳数累加');
});

test('反例（判据有承重）：挖掉一个三角形 / 翻一条绕序 / 捏合顶点，都必须判不合法', () => {
  const box = boxTriangles({ xMinMm: 0, xMaxMm: 1, yMinMm: 0, yMaxMm: 1, zBottom: 0, zTop: 1 });
  // 1) 开面：删掉最后一个三角形
  const holed = box.slice(0, box.length - 9);
  const repHole = manifoldReport(holed);
  assert.equal(repHole.ok, false, '删一个三角形 ⇒ 3 条边只被用一次');
  assert.equal(repHole.edgesUsedOnce, 3);
  assert.ok(repHole.issues.some((s) => /used once/.test(s)));
  // 2) 定向不一致：把最后一个三角形的 b/c 两个**顶点整体**互换（绕序反向，顶点集合不变）
  const flipped = Float64Array.from(box);
  const last = flipped.length - 9;
  for (let k = 0; k < 3; k++) {
    const t = flipped[last + 3 + k];
    flipped[last + 3 + k] = flipped[last + 6 + k];
    flipped[last + 6 + k] = t;
  }
  const repFlip = manifoldReport(flipped);
  assert.equal(repFlip.ok, false);
  assert.equal(repFlip.edgesUsedOnce, 0, '这条反例的意义：边**计数**没坏，坏的是朝向 —— 只有方向检查抓得住');
  assert.ok(repFlip.issues.some((s) => /opposite directions/.test(s)), repFlip.issues.join(';'));
  // 3) 退化三角形：把 c 整体挪到 b 上
  const degen = Float64Array.from(box);
  for (let k = 0; k < 3; k++) degen[last + 6 + k] = degen[last + 3 + k];
  assert.equal(manifoldReport(degen).ok, false, '把一个顶点挪到另一个上 ⇒ 退化，必须判不合法');
});

test('反例：两个只共一个顶点的立方体 —— 边计数全对，只有顶点链接检查抓得住', () => {
  const A = boxTriangles({ xMinMm: 0, xMaxMm: 1, yMinMm: 0, yMaxMm: 1, zBottom: 0, zTop: 1 });
  const B = boxTriangles({ xMinMm: 1, xMaxMm: 2, yMinMm: 1, yMaxMm: 2, zBottom: 1, zTop: 2 });
  const joined = new Float64Array(A.length + B.length);
  joined.set(A, 0);
  joined.set(B, A.length);
  const rep = manifoldReport(joined);
  assert.equal(rep.edgesUsedOnce, 0);
  assert.equal(rep.edgesUsedOverTwo, 0);
  assert.equal(rep.orientationConsistent, true);
  assert.ok(rep.volumeMm3 > 0, '2 mm^3');
  assert.equal(rep.ok, false, '捏合点（两个壳只碰一个顶点）不是流形顶点，必须判不合法');
  assert.equal(rep.nonManifoldVertices, 1);
});

test('反例：prismFromMask 的矩形覆盖不满足同一条判据（所以 plate.js 不用它）', () => {
  const rows = ['#####', '##.##', '#####'];
  const mask = { width: 5, height: 3, data: Uint8Array.from(rows.flatMap((s) => [...s].map((ch) => (ch === '#' ? 1 : 0)))) };
  const prism = prismFromMask(mask, { pixelMm: 0.4, zBottom: 0, zTop: 0.3 });
  const rep = manifoldReport(prism.triangles);
  assert.equal(rep.ok, false, '相邻矩形共墙 ⇒ 同一条边被用 4 次；这条判据在矩形挤出路径上**不该**通过');
  assert.ok(rep.edgesUsedOverTwo > 0, `期望有 >2 次的边，实得 ${rep.edgesUsedOverTwo}`);
  assert.equal(rep.degenerate, 0, '它没有退化三角形：失败纯粹来自重合侧壁，不是别的原因');
});

/* ═════════════════════════ 3. 3MF 容器与 XML ═════════════════════════ */

test('encode3MF: 部件划分 = 底板 + 每料一岛；逐部件水密，且拒绝非流形', () => {
  const f = plateFixture();
  const names = f.model.objects.map((o) => o.name);
  assert.deepEqual(names, ['plate-base', 'relief-ink0'], 'PL-G 只有 1 个 colour 档 ⇒ 一块底板 + 一个岛');
  const chk = selfCheck3MF(f.bytes, { expectTriangles: f.model.facts.trianglesTotal });
  assert.equal(chk.ok, true, chk.issues.join(';'));
  assert.equal(chk.watertight, true);
  for (const o of chk.objects) assert.equal(o.manifold.ok, true, `${o.name}: ${o.manifold.issues.join(';')}`);
  const base = chk.objects.find((o) => o.name === 'plate-base');
  assert.equal(base.triangles, 12);
  assert.equal(base.vertices, 8);
  assert.equal(base.manifold.euler, 2);

  // 反例：翻掉一条绕序 ⇒ 编码器必须拒绝出文件
  const broken = f.model.objects.map((o) => ({ ...o, vertices: Float64Array.from(o.vertices), indices: Uint32Array.from(o.indices) }));
  const ix = broken[1].indices;
  const t = ix.length - 3;
  const tmp = ix[t + 1];
  ix[t + 1] = ix[t + 2];
  ix[t + 2] = tmp;
  assert.throws(() => encode3MF({ objects: broken, metadata: {} }), /not watertight/, '非流形输入必须拒写，而不是写出去再指望别人发现');
});

test('模型 XML: unit=millimeter、无 zUp、部件先定义后引用、内容与关系指回模型', () => {
  const f = plateFixture();
  const entries = readZip(f.bytes);
  assert.deepEqual(entries.map((e) => e.name), [CONTENT_TYPES_PART, RELS_PART, MODEL_PART]);
  const dec = new TextDecoder();
  const ct = dec.decode(entries[0].data);
  const rels = dec.decode(entries[1].data);
  assert.ok(ct.includes(MODEL_CONTENT_TYPE), ct);
  assert.ok(ct.includes('Extension="rels"'), ct);
  assert.ok(rels.includes(START_PART_REL_TYPE), rels);
  assert.ok(rels.includes('/' + MODEL_PART), rels);
  const model = parseModelXml(dec.decode(entries[2].data));
  assert.equal(model.unit, 'millimeter');
  assert.equal(model.attributes.zUp, undefined, '3MF core 1.4 的 <model> 没有 zUp 属性：写了才是偏离规范');
  assert.ok(model.text.indexOf('<basematerials') < model.text.indexOf('<object'), '§3.4 先定义后引用');
  assert.ok(model.text.indexOf('xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"') > 0);
  assert.equal(model.objects.length, 2);
  assert.equal(model.build.length, 2);
  assert.ok(model.materials.length >= 1);
  // 顶点/三角形数与 facts 一致
  const sum = model.objects.reduce((s, o) => s + o.triangleCount, 0);
  assert.equal(sum, f.model.facts.trianglesTotal);
});

test('modelXml 是纯函数：不改动传进来的部件对象（否则两次编码的语义就不可信）', () => {
  const f = plateFixture();
  const before = f.model.objects.map((o) => Object.keys(o).sort().join(','));
  modelXml({ objects: f.model.objects, metadata: { a: 1 } });
  const after = f.model.objects.map((o) => Object.keys(o).sort().join(','));
  assert.deepEqual(after, before, 'modelXml 不得往调用方的对象上挂私有字段');
});

test('RELS_XML / CONTENT_TYPES_XML 里没有时间点，字符串本身就是常量', () => {
  assert.equal(RELS_XML, RELS_XML);
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(CONTENT_TYPES_XML + RELS_XML + THREE_MF_META()));
  function THREE_MF_META() {
    return modelXml({ objects: [oneBoxObject()], metadata: {} });
  }
});

function oneBoxObject() {
  const tris = boxTriangles({ xMinMm: 0, xMaxMm: 1, yMinMm: 0, yMaxMm: 1, zBottom: 0, zTop: 1 });
  const w = weldTriangles(tris, { decimals: 6 });
  return { name: 'box', vertices: w.vertices, indices: w.indices };
}

/* ═════════════════════════ 4. 确定性 ═════════════════════════ */

test('确定性：同一输入两次编码逐字节相同；metadata 键序不影响字节', () => {
  const f = plateFixture();
  const again = encode3MF({ objects: f.model.objects, metadata: { 'pskt:profile': f.geom.profile } });
  assert.equal(again.length, f.bytes.length);
  for (let i = 0; i < again.length; i++) assert.equal(again[i], f.bytes[i], `byte ${i} 不同`);
  const a = encode3MF({ objects: f.model.objects, metadata: { z: 1, a: 2 } });
  const b = encode3MF({ objects: f.model.objects, metadata: { a: 2, z: 1 } });
  assert.ok(a.every((v, i) => v === b[i]), 'metadata 的键顺序不得改变字节（模型里按名字排序）');
  // 隔一次"新装配"再编：同一页数据必须得到同一份字节
  const f2 = fixture();
  const model2 = buildPlateModel({ geom: f2.geom, levels: f2.levels, layout: f2.layout });
  const c = encode3MF({ objects: model2.objects, metadata: { 'pskt:profile': f2.geom.profile } });
  assert.ok(c.length === f.bytes.length && c.every((v, i) => v === f.bytes[i]), '重新装配同一页 ⇒ 字节仍须相同');
});

test('确定性（反例）：换一格数据，字节必须变；而且 zip 里仍然找不到时间成分', () => {
  const f = plateFixture();
  const other = fixture();
  other.levels[0] = (other.levels[0] + 1) % (1 << other.geom.bitsPerCell);
  const m2 = buildPlateModel({ geom: other.geom, levels: other.levels, layout: other.layout });
  const b2 = encode3MF({ objects: m2.objects, metadata: { 'pskt:profile': other.geom.profile } });
  assert.ok(!b2.every((v, i) => v === f.bytes[i]), '数据变了字节必须变，否则编码器在写死东西');
  for (const e of readZip(b2)) {
    assert.equal(e.dosTime, ZIP_DOS_TIME);
    assert.equal(e.dosDate, ZIP_DOS_DATE);
  }
});

/* ═════════════════════ 5. STL 与 3MF 同源 ═════════════════════ */

test('STL 与 3MF 是同一批三角形：数量、序号逐点、以及顺序无关的质心集合', () => {
  const f = plateFixture();
  const stl = encodeSTLSolid(f.model.triangles, { name: 'PSKT-PLG' });
  const a = readSTL(stl);
  const { tris: b } = fileTriangles(f.bytes);
  assert.equal(a.length / 9, b.length / 9);
  assert.equal(a.length / 9, f.model.facts.trianglesTotal);
  let maxDev = 0;
  for (let i = 0; i < a.length; i++) maxDev = Math.max(maxDev, Math.abs(a[i] - b[i]));
  // STL 存 float32：182 mm 处半个 ULP 约 7.3e-6 mm。容差取 1e-3 mm —— 远大于表示噪声，
  // 又远小于任何真实缺陷（最小 EW 0.26 mm）。Python 侧同一条判据再量一次。
  assert.ok(maxDev <= 1e-3, `同序号三角形的最大偏差 ${maxDev} mm 必须 <= 1e-3`);
  const ca = centroidsSorted(a);
  const cb = centroidsSorted(b);
  for (let i = 0; i < ca.length; i++) assert.ok(Math.abs(ca[i] - cb[i]) <= 1e-3, `第 ${i} 个质心对不上`);
  const bb = boundingBox(b);
  assert.ok(Math.abs(bb.size[0] - f.model.facts.pageMm.w) < 1e-3, '包围盒 = 版面（含静区）');
  assert.ok(Math.abs(bb.size[2] - (PLATE_MM + 2 * RELIEF_MM)) < 1e-9, 'Z 跨度 = 底板 + 两级浮雕');
  assert.equal(bb.min[2], 0, 'z=0 是打印床');
});

function centroidsSorted(tris) {
  const out = [];
  for (let t = 0; t + 8 < tris.length; t += 9) out.push((tris[t] + tris[t + 3] + tris[t + 6]) / 3, (tris[t + 1] + tris[t + 4] + tris[t + 7]) / 3);
  out.sort((x, y) => x - y);
  return out;
}

/* ═════════════════════ 6. G8 §6.3：投影对拍 ═════════════════════ */

test('投影对拍：从**文件里**的三角形逐格复现渲染掩码，面积差远小于 8%', () => {
  const f = plateFixture();
  const { tris } = fileTriangles(f.bytes);
  const rep = projectTopToCells(tris, { geom: f.geom, layout: f.layout, levels: f.levels });
  assert.equal(rep.ok, true, JSON.stringify(rep.detail));
  assert.equal(rep.cellsOverTolerance, 0);
  assert.equal(rep.inkedMismatch, 0);
  assert.equal(rep.straddlingTriangles, 0);
  assert.ok(rep.maxPct < PROJECTION_TOL_PCT, `max ${rep.maxPct}% 必须 < ${PROJECTION_TOL_PCT}%`);
  assert.ok(rep.maxPct < 3, `实测应当在 1.5% 以内（24 段多边形 vs 圆），实得 ${rep.maxPct.toFixed(3)}%`);
  assert.equal(rep.upTriangles > 0, true);
  // 期望值必须真的来自光栅：level 0 也有面积（外环），否则这一条就是空转
  assert.ok(rep.reference[0].areaMm2 > 0, 'shape 档 0 的参考面积必须 > 0');
});

test('反例：把一格的半径改大 30% ⇒ 投影对拍必须红，而且红在那一格', () => {
  const f = plateFixture();
  const { tris } = fileTriangles(f.bytes);
  const pitch = f.model.facts.pitchMmPrinted;
  const c0 = f.model.cells[0];
  const bad = tris.slice();
  let touched = 0;
  for (let t = 0; t + 8 < bad.length; t += 9) {
    const gx = (bad[t] + bad[t + 3] + bad[t + 6]) / 3;
    const gy = (bad[t + 1] + bad[t + 4] + bad[t + 7]) / 3;
    if (Math.abs(gx - c0.centreMm.x) < pitch / 2 && Math.abs(gy - c0.centreMm.y) < pitch / 2) {
      for (let k = 0; k < 3; k++) {
        bad[t + k * 3] = c0.centreMm.x + (bad[t + k * 3] - c0.centreMm.x) * 1.3;
        bad[t + k * 3 + 1] = c0.centreMm.y + (bad[t + k * 3 + 1] - c0.centreMm.y) * 1.3;
      }
      touched++;
    }
  }
  assert.ok(touched > 0, '反例必须真的碰到三角形，否则它什么都没测');
  const rep = projectTopToCells(bad, { geom: f.geom, layout: f.layout, levels: f.levels });
  assert.equal(rep.ok, false, '改了半径还判 ok ⇒ 这条对拍是假的');
  assert.ok(rep.cellsOverTolerance >= 1);
  assert.equal(rep.worst.col, c0.col);
  assert.equal(rep.worst.row, c0.row);
  assert.ok(rep.maxPct > 20, `误差要明显超出容差，实得 ${rep.maxPct.toFixed(1)}%`);
});

test('反例：删掉一格的全部实体 ⇒ 该格必须被"每格都得有料"抓住', () => {
  const f = plateFixture();
  const { tris } = fileTriangles(f.bytes);
  const pitch = f.model.facts.pitchMmPrinted;
  const c0 = f.model.cells[0];
  const keep = [];
  let removed = 0;
  for (let t = 0; t + 8 < tris.length; t += 9) {
    const gx = (tris[t] + tris[t + 3] + tris[t + 6]) / 3;
    const gy = (tris[t + 1] + tris[t + 4] + tris[t + 7]) / 3;
    const inside = Math.abs(gx - c0.centreMm.x) < pitch / 2 && Math.abs(gy - c0.centreMm.y) < pitch / 2 && tris[t + 2] > PLATE_MM;
    if (inside) removed++;
    else keep.push(tris[t], tris[t + 1], tris[t + 2], tris[t + 3], tris[t + 4], tris[t + 5], tris[t + 6], tris[t + 7], tris[t + 8]);
  }
  assert.ok(removed > 0);
  const rep = projectTopToCells(Float64Array.from(keep), { geom: f.geom, layout: f.layout, levels: f.levels });
  assert.equal(rep.ok, false);
  assert.ok(rep.inkedMismatch >= 1 || rep.cellsOverTolerance >= 1, JSON.stringify(rep.detail));
});

/* ═════════════════════ 7. plate.js 的契约数字 ═════════════════════ */

test('契约数字：底板 2.00、每级 0.30、墨色格下沉 0.05、静区 6.00，且下沉不占一级', () => {
  assert.deepEqual([PLATE_MM, RELIEF_MM, INK_SUNK_MM, QUIET_MM], [2.0, 0.3, 0.05, 6.0]);
  assert.equal(reliefTopMm(0), 2.3);
  assert.equal(reliefTopMm(1), 2.6);
  // 浮点上不能指望 == 2.55：2.0+2*0.3-0.05 = 2.5500000000000003。写进文件时按 6 位小数
  // 量化（fmtCoord），所以产物里是 2.550000；这里量的是"误差远小于任何真实尺寸"。
  assert.ok(Math.abs(reliefTopMm(1, { sunk: true }) - 2.55) < 1e-12, String(reliefTopMm(1, { sunk: true })));
  assert.ok(INK_SUNK_MM * 2 < RELIEF_MM, '下沉量必须小于半个级差');
  // 反例：把下沉量提到半个级差 ⇒ 模块加载时的那条断言会说话；这里验证判据本身
  assert.throws(() => reliefTopMm(-1), RangeError);
  assert.throws(() => reliefTopMm(1.5), RangeError);
});

test('格位用的是像素量化后的尺寸，不是名义 pitchMm（否则累计漂移半格）', () => {
  const f = plateFixture();
  const facts = f.model.facts;
  const printedFromPx = (f.layout.cellPx * 25.4) / f.layout.dpi;
  assert.ok(Math.abs(facts.pitchMmPrinted - printedFromPx) < 1e-12);
  assert.equal(facts.cellPx, f.layout.cellPx);
  assert.equal(facts.originMm.x, (f.layout.originPx.x * 25.4) / f.layout.dpi);
  // 名义值与印刷值确实不同（不是巧合，是 dpi 取整的必然）
  assert.notEqual(facts.pitchMmNominal, facts.pitchMmPrinted);
  const drift = Math.abs(facts.pitchMmPrinted - facts.pitchMmNominal) * facts.cols;
  assert.ok(drift > 0, `第 ${facts.cols} 格处两套坐标的累计差 = ${drift.toFixed(4)} mm`);
  const last = f.model.cells[f.model.cells.length - 1];
  assert.ok(Math.abs(last.centreMm.x - (facts.originMm.x + (facts.cols - 0.5) * facts.pitchMmPrinted)) < 1e-12);
});

test('cellEw 取渲染器那一份，半径取 glyphGeometry 那一份（不是喷嘴宽）', () => {
  const f = plateFixture();
  assert.equal(f.model.facts.cellEw, f.layout.cellEw);
  assert.equal(f.model.facts.glyph.outer, f.layout.glyph.outer);
  assert.equal(f.model.facts.glyph.inner, f.layout.glyph.inner);
  assert.deepEqual(f.model.facts.glyph.dot, Array.from(f.layout.glyph.dot));
  const cell = f.model.cells[0];
  assert.ok(Math.abs(cell.outerRadiusMm - f.layout.glyph.outer * f.model.facts.pitchMmPrinted) < 1e-12);
  // 反例：换成喷嘴宽算出的 cellEw 会得到**另一份**几何 ⇒ 必须和 layout.glyph 不同
  const wrongEw = f.geom.pitchMm / 0.4;
  assert.notEqual(wrongEw, f.layout.cellEw, '这条反例的前提：EW 与喷嘴宽不是一回事（0.8 喷嘴的 EW=0.7）');
});

test('分段数按挤出宽度定：弦长不得超过一个 EW，且不超过上限', () => {
  const ew = 0.7;
  const n = reliefSegments(0.375 * 7.62, ew);
  assert.ok(n % 2 === 0 && n >= 24 && n <= 96);
  const chord = 2 * 0.375 * 7.62 * Math.sin(Math.PI / n);
  assert.ok(chord <= ew + 1e-12, `弦长 ${chord} 必须 <= EW ${ew}`);
  assert.equal(reliefSegments(0.1, 10), 24, '小圆不必细分 ⇒ 下限');
  assert.equal(reliefSegments(50, 0.1), 96, '大圆要细分但封顶 ⇒ 上限');
  assert.throws(() => reliefSegments(0, 0.4), RangeError);
  assert.throws(() => reliefSegments(1, 0), RangeError);
});

test('INK_SUNK 只在有第二档料时生效；单档（PL-G）一律不下沉', () => {
  const g = fixture('PL-G', '0.8', 0.8);
  const mg = buildPlateModel({ geom: g.geom, levels: g.levels, layout: g.layout });
  assert.equal(mg.facts.sinkActive, false);
  assert.equal(mg.objects.length, 2);
  assert.ok(mg.cells.every((c) => !c.sunk));
  const d = fixture('PL-D2', '0.4', 0.4);
  const md = buildPlateModel({ geom: d.geom, levels: d.levels, layout: d.layout });
  assert.equal(md.facts.sinkActive, true);
  assert.deepEqual(md.objects.map((o) => o.name), ['plate-base', 'relief-ink0', 'relief-ink1']);
  assert.ok(md.cells.some((c) => c.sunk), 'PL-D2 的墨色格必须真的矮 0.05');
  assert.equal(md.objects[2].sunk, true);
  const mono = buildPlateModel({ geom: d.geom, levels: d.levels, layout: d.layout, mono: true });
  assert.equal(mono.facts.sinkActive, false, '单色印刷没有第二种墨盒，所以一律不下沉（G7 的退路）');
  // 下沉格的顶面确实低 0.05，而不是被搬到了别的高度
  const sunkCell = md.cells.find((c) => c.sunk);
  const sameCell = md.cells.find((c) => c.shapeLevel === sunkCell.shapeLevel && !c.sunk);
  assert.ok(Math.abs(sameCell.topMm - sunkCell.topMm - INK_SUNK_MM) < 1e-12);
});

test('多料岛各自水密：PL-D2 两个 relief 部件都要过判据', () => {
  const d = fixture('PL-D2', '0.4', 0.4);
  const model = buildPlateModel({ geom: d.geom, levels: d.levels, layout: d.layout });
  const bytes = encode3MF({ objects: model.objects, metadata: {} });
  const chk = selfCheck3MF(bytes, { expectTriangles: model.facts.trianglesTotal });
  assert.equal(chk.ok, true, chk.issues.join(';'));
  assert.equal(chk.objects.length, 3);
  assert.ok(chk.objects.every((o) => o.manifold.ok));
  assert.ok(chk.model.materials.length >= 2, '两种料 ⇒ <basematerials> 至少两条');
});

/* ═════════════════════ 8. 该拒绝的必须拒绝 ═════════════════════ */

test('拒绝：纸面档没有挤出宽度 ⇒ 不出模型，也不猜一个（MESH-CONTRACT §3）', () => {
  const geom = planPage('P-C4-600', {});
  const layout = pageLayout(geom, 600, { sheetMm: geom.sheetMm });
  const levels = new Uint16Array(geom.totalCells);
  assert.throws(
    () => buildPlateModel({ geom, levels, layout }),
    /plate profiles only|只吃板材档/,
    '纸面档必须被拒绝',
  );
});

test('拒绝：glyphGeometry 觉得格宽不够时，装配原样抛出原因，不绕过去猜半径', () => {
  const geom = planPage('PL-G', { nozzle: '0.2', scale: 0.2 });
  const layout = pageLayout(geom, 300, { plateMm: geom.sheetMm.w });
  assert.equal(layout.glyph.ok, true, '夹具本身要合法，反例才说明问题');
  const levels = new Uint16Array(geom.totalCells);
  const bad = { ...layout, glyph: { ok: false, reason: 'cell too narrow for 4 shape levels' } };
  assert.throws(() => buildPlateModel({ geom, levels, layout: bad }), /cell too narrow/, 'glyphGeometry 拒绝 ⇒ 装配也必须拒绝，并把原因原样带出去');
});

test('拒绝：静区不足 6 mm 不出图；没有 shape 通道的档也不出图', () => {
  const geom = planPage('PL-G', { nozzle: '0.8', scale: 0.8 });
  const ok = pageLayout(geom, 300, { plateMm: geom.sheetMm.w });
  const levels = new Uint16Array(geom.totalCells);
  assert.doesNotThrow(() => buildPlateModel({ geom, levels, layout: ok }));
  // 把版面缩小到静区不够（originPx 直接变小）：用 originPx 挪出边界的最小店面
  const cramped = { ...ok, originPx: { x: 4, y: 4 }, width: Math.round(geom.cols * ok.cellPx + 8), height: Math.round(geom.rows * ok.cellPx + 8) };
  assert.throws(() => buildPlateModel({ geom, levels, layout: cramped }), /quiet margin/, '静区 6mm 是契约数字，不是装饰');
  const noShape = { ...geom, channels: geom.channels.filter((c) => c.name !== 'shape') };
  assert.throws(() => buildPlateModel({ geom: noShape, levels, layout: ok }), /no 'shape' channel/);
  assert.throws(() => buildPlateModel({ geom, levels: levels.slice(0, 3), layout: ok }), /expected \d+ levels/);
});

test('拒绝：零三角形 / 空对象列表，编码器不出文件', () => {
  assert.throws(() => encode3MF({ objects: [] }), /at least one object/);
  const w = weldTriangles(new Float64Array(0), { decimals: 6 });
  assert.throws(() => encode3MF({ objects: [{ name: 'empty', vertices: w.vertices, indices: w.indices }] }), /watertight|multiple of 3|not watertight/);
});

/* ═════════════════════ 9. 与 Python 侧同判据的向导出 ═════════════════════ */

test('manifoldReportIndexed 与 manifoldReport 同一条判据（3MF 编码器用前者）', () => {
  const f = plateFixture();
  for (const o of f.model.objects) {
    const viaIndex = manifoldReportIndexed(o.vertices, o.indices);
    const viaFlat = manifoldReport(expandIndexedTriangles(o.vertices, o.indices));
    assert.equal(viaIndex.ok, viaFlat.ok);
    assert.equal(viaIndex.triangles, viaFlat.triangles);
    assert.equal(viaIndex.edges, viaFlat.edges);
    assert.ok(Math.abs(viaIndex.volumeMm3 - viaFlat.volumeMm3) < 1e-9);
    assert.equal(viaIndex.euler, viaFlat.euler);
  }
});

test('glyphSignature 进模型 metadata：两份产物对不上几何时会当场暴露', () => {
  const f = plateFixture();
  const sig = glyphSignature(f.layout.glyph);
  const withSig = encode3MF({ objects: f.model.objects, metadata: { 'pskt:glyph': JSON.stringify(sig) } });
  const { model } = readModel3MF(withSig);
  assert.deepEqual(JSON.parse(model.metadata['pskt:glyph']), sig);
  // 反例：直接把对象塞进 metadata —— 早先的写法会静默写成 "[object Object]"，
  // 那正是"看起来成功但是错"，现在必须拒写。
  assert.throws(() => encode3MF({ objects: f.model.objects, metadata: { 'pskt:glyph': sig } }), /JSON\.stringify/);
});
