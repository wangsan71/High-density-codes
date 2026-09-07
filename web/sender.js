/**
 * PSKT sender -- encode a file into printable pages, entirely in the browser.
 *
 * Why this page exists: the phone cannot run cli/pskit.mjs. Everything the CLI does after
 * `encodeTransfer` is pure core/ ESM (raster, PNG, PDF, mesh), so the browser can do it
 * too, and PLAN's "no external source" rule is respected even more strictly here: nothing
 * leaves the device, and the artifacts are `data:` URLs, so no blob handling and no
 * loosening of the page's CSP.
 *
 * The refusal behaviour is copied from the CLI on purpose, not reinterpreted:
 *   - a plate profile is required for the relief model; paper profiles are refused;
 *   - projectionReport / stlSelfCheck / selfCheck3MF must pass or no model is written.
 * A relief that does not reproduce the raster mask is the same class of failure as a
 * misaccepted frame, and this project does not ship those.
 *
 * No performance work here by instruction: candidate geometries are decoded serially, the
 * PNG is re-encoded for thumbnails, and the mesh is rebuilt per download click. It is slow
 * on a phone and correct, which is the order the contract prefers.
 */
import { PROFILES } from './core/profiles.js';
import { encodeTransfer } from './core/protocol.js';
import { pageLayout } from './core/render/layout.js';
import { renderPageBitmap, echoBitsOf } from './core/render/raster.js';
import { encodePNG } from './core/render/png.js';
import { encodePDFDocument } from './core/render/pdf.js';
import { buildPlateModel, projectionReport } from './core/mesh/plate.js';
import { encodeSTLSolid, stlSelfCheck } from './core/mesh/stl.js';
import { encode3MF, selfCheck3MF } from './core/mesh/threeMF.js';
import { sha256Hex } from './core/hash.js';
import { getPalette } from './core/palette.js';

const $ = (id) => document.getElementById(id);
const log = $('slog');
const say = (msg, cls = '') => {
  const line = document.createElement('div');
  if (cls) line.className = cls;
  line.textContent = msg;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
};

let state = null; // { raw, transfer, layout, dpi, paletteId, plateMm, sheet, mono, pages: [{tag, bitmap, png, url, header}] }

const isPlate = (id) => !!(PROFILES[id] && PROFILES[id].plate);
const b64 = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const give = (bytes, name, mime) => {
  const a = document.createElement('a');
  a.href = `data:${mime};base64,${b64(bytes)}`;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
};

function fillProfiles() {
  const sel = $('sprofile');
  sel.innerHTML = '';
  for (const [id, p] of Object.entries(PROFILES)) {
    const o = document.createElement('option');
    o.value = id;
    o.textContent = `${id}${p.plate ? ` 盘${p.plate.mm}mm` : ` ${p.sheet || '纸'}`} · ${p.dpi || 300}dpi`;
    sel.appendChild(o);
  }
  sel.value = 'P-M1-300';
  $('s3d').disabled = !isPlate(sel.value);
}

async function encode() {
  log.innerHTML = '';
  state = null;
  $('pages').innerHTML = '';
  const file = $('sfile').files[0];
  if (!file) return say('先选一个文件（任何格式，我们只搬字节）。', 'bad');
  const profileId = $('sprofile').value;
  const prof = PROFILES[profileId] || {};
  const mono = $('smono').checked;
  const paletteId = mono ? 'PAPER1' : $('spalette').value || prof.palette || 'INK2';
  const plateMm = Number($('splate').value) || prof.plate?.mm || 200;
  const sheet = prof.sheet || $('ssheet').value || 'A4';
  const dpi = Number($('sdpi').value) || prof.dpi || 300;
  const nozzle = isPlate(profileId) ? Number($('snozzle').value) || 0.4 : null;
  const parityPct = $('sparity').value === '' ? undefined : Number($('sparity').value);
  const pass = $('spw').value || '';

  say(`读入 ${file.name} · ${file.size.toLocaleString()} B · ${new Date(file.lastModified).toISOString()}`);
  const raw = new Uint8Array(await file.arrayBuffer());
  const t0 = performance.now();
  let t;
  try {
    t = await encodeTransfer(raw, {
      profile: profileId,
      nozzle,
      plateMm,
      sheet,
      parityPct,
      monoSafe: $('smonosafe').value || undefined,
      cipher: !!pass,
      passphrase: pass || undefined,
    });
  } catch (e) {
    say(`编码失败：${e.message}`, 'bad');
    say('常见原因：载荷超出该剖面单页容量，或校验页比例把预算吃光。换更大剖面、调低校验页 %，或先压缩/分割文件。', 'hint');
    return;
  }
  const layout = pageLayout(t.geom, dpi, { plateMm: isPlate(profileId) ? plateMm : undefined, sheetMm: !isPlate(profileId) });
  const palette = getPalette(paletteId);
  const pages = [];
  for (let i = 0; i < t.pages.length; i++) {
    const p = t.pages[i];
    const bitmap = renderPageBitmap({ geom: t.geom, levels: p.levels, layout, palette: paletteId, mono, echoBits: echoBitsOf(p.header) });
    const png = encodePNG(bitmap);
    pages.push({ tag: `page-${String(i).padStart(3, '0')}`, bitmap, png, header: p.header, headerBytes: p.headerBytes });
    const card = document.createElement('figure');
    card.innerHTML = `<img alt="${pages[pages.length - 1].tag}" src="data:image/png;base64,${b64(png)}"><figcaption>${pages[pages.length - 1].tag} · ${i + 1}/${t.pages.length}${
      p.parity ? ' · 校验页' : ''
    }</figcaption>`;
    $('pages').appendChild(card);
  }
  state = { raw, t, layout, dpi, paletteId, plateMm, sheet, mono, pages, nozzle };
  const secs = ((performance.now() - t0) / 1000).toFixed(1);
  const geomKeys = Object.keys(t.geom || {}).slice(0, 8).join(',');
  say(`编好 ${t.pages.length} 页 · ${secs}s · 载荷 ${raw.length.toLocaleString()} B · geom 字段：${geomKeys}`, 'hint');
  say(`明文 SHA-256 ${sha256Hex(raw)}（接收端只需这 64 个字符即可判定成功/失败，无需文件名）`);
  const inkCount = palette && palette.inks ? palette.inks.length : '?';
  say(`色板 ${paletteId}（${inkCount} 色）· ${mono ? '单色出图' : '双色'} · dpi ${dpi} · ${isPlate(profileId) ? `盘 ${plateMm}mm / 喷嘴 ${nozzle}` : `纸 ${sheet}`}`);
  for (const id of ['doprint', 'dlpng', 'dlpdf']) $(id).disabled = false;
  $('dl3mf').disabled = $('dlstl').disabled = !isPlate(profileId);
  if (!isPlate(profileId)) say('这个剖面无实体盘：STL/3MF 按钮保持禁用（与 CLI 相同的拒绝规则）。', 'hint');
}

function printableCss() {
  if (!state) return '';
  const paper = isPlate(state.t.profileId || $('sprofile').value)
    ? `${state.plateMm}mm ${state.plateMm}mm`
    : (state.sheet === 'A4' ? 'A4' : 'Letter');
  return `@page { size: ${paper}; margin: 0 } @media print { html,body{margin:0;padding:0;background:#fff} nav,.no-print{display:none!important} figure{margin:0;page-break-after:always} img{width:${
    isPlate(state.t.profileId || $('sprofile').value) ? state.plateMm : 210
  }mm;height:auto} }`;
}

async function makePdf() {
  if (!state) return say('先编码。', 'bad');
  const bytes = encodePDFDocument(state.pages.map((p) => p.bitmap));
  give(bytes, 'pskt-pack.pdf', 'application/pdf');
  say(`pack.pdf ${bytes.length.toLocaleString()} B · 每一页按其真实物理尺寸放置（发打印机用这个，别用浏览器缩放打印）。`);
}

function modelFor(i) {
  const p = state.pages[i];
  const model = buildPlateModel({ geom: state.t.geom, levels: p.header ? state.t.pages[i].levels : state.t.pages[i].levels, layout: state.layout, mono: state.mono, palette: state.paletteId });
  const proj = projectionReport(model);
  if (!proj.ok) {
    say(
      `${p.tag} 浮雕与栅格掩码对拍失败：${proj.cellsOverTolerance}/${proj.cells} 格偏差 ≥${proj.tolerancePct}%（最大 ${proj.maxPct.toFixed(2)}%）， straddling ${proj.straddlingTriangles}，墨量不符 ${proj.inkedMismatch} —— 拒绝出模型。`,
      'bad',
    );
    return null;
  }
  const chk = stlSelfCheck(model.triangles);
  if (!chk.ok) {
    say(`${p.tag} STL 自检拒绝：${chk.issues.join('; ')}`, 'bad');
    return null;
  }
  return model;
}

function makeModels(kind) {
  if (!state) return say('先编码。', 'bad');
  if (!isPlate($('sprofile').value)) return say('纸面剖面无实体盘。', 'bad');
  const data = [];
  for (let i = 0; i < state.pages.length; i++) {
    const model = modelFor(i);
    if (!model) return;
    if (kind === 'stl') {
      data.push({ name: `${state.pages[i].tag}.stl`, bytes: encodeSTLSolid(model.triangles, { name: `PSKT-${$('sprofile').value}-p${i}` }) });
    } else {
      const bytes = encode3MF({
        objects: model.objects,
        metadata: {
          'pskt:profile': $('sprofile').value,
          'pskt:page': i,
          'pskt:dpi': String(state.dpi),
          'pskt:cellPx': String(state.layout.cellPx),
          'pskt:sourceSha256': sha256Hex(state.raw),
        },
      });
      const chk = selfCheck3MF(bytes, { expectTriangles: model.facts.trianglesTotal });
      if (!chk.ok) {
        say(`${state.pages[i].tag} 3MF 自检拒绝：${chk.issues.join('; ')}`, 'bad');
        return;
      }
      data.push({ name: `${state.pages[i].tag}.3mf`, bytes });
    }
  }
  for (const d of data) give(d.bytes, d.name, kind === 'stl' ? 'model/stl' : 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml');
  say(`${data.length} 个 .${kind} 已下载（每个都过了对拍与自检；${kind === 'stl' ? 'STL 无单位元数据，切片器里按 mm' : '3MF 自带 mm 单位'}）。`);
}

$('sprofile').addEventListener('change', () => {
  $('s3d').disabled = !isPlate($('sprofile').value);
  $('dl-stl').disabled = $('dl-3mf').disabled = !isPlate($('sprofile').value);
});
$('doprint').addEventListener('click', () => {
  if (!state) return say('先编码。', 'bad');
  const w = window.open('', '_blank');
  if (!w) return say('浏览器拦住了新窗口：改用 pack.pdf 打印更可靠。', 'bad');
  w.document.write(
    `<!doctype html><meta charset=utf-8><title>PSKT pages</title><style>${printableCss()} body{font:14px system-ui}</style><section>${state.pages
      .map((p) => `<figure><img src="${p.png ? `data:image/png;base64,${b64(p.png)}` : ''}"></figure>`)
      .join('')}</section>`,
  );
  w.document.close();
  w.focus();
  setTimeout(() => w.print(), 250);
  say('打印窗口用的是 CSS 物理尺寸，但浏览器可能自行缩放：要精确请走 pack.pdf。', 'hint');
});
$('dopng').addEventListener('click', () => {
  if (!state) return say('先编码。', 'bad');
  for (const p of state.pages) give(p.png, `${p.tag}.png`, 'image/png');
  say(`${state.pages.length} 张 PNG 已逐个下载（浏览器会问很多次，是刻意的：不打包 ⇒ 零第三方依赖）。`);
});
$('dlpdf').addEventListener('click', makePdf);
$('dlstl').addEventListener('click', () => makeModels('stl'));
$('dl3mf').addEventListener('click', () => makeModels('3mf'));
$('doencode').addEventListener('click', () => encode().catch((e) => say(`异常：${e.message}`, 'bad')));
fillProfiles();
say('接收端在 index.html；这一页只负责「把文件变成能打印的东西」，全程不出网。', 'hint');
