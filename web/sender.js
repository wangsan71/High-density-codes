/**
 * PSKT sender -- encode a file into printable pages, entirely in the browser.
 *
 * Why this page exists: a phone cannot run cli/pskit.mjs. Everything the CLI does after
 * `encodeTransfer` is pure core/ ESM (raster, PNG, PDF, mesh), so the browser can do it
 * too. PLAN's "no external source" rule is honoured even more strictly here: nothing leaves
 * the device, and downloads are `data:` URLs -- no blob handling, so the page's CSP needs
 * no `blob:` allowance.
 *
 * Structure is dictated by verification, not taste: buildArtifacts() is pure and DOM-free
 * so `tools/smoke-sender.mjs` can execute the exact same code path in Node. Without that
 * split, the only way to test this file was to click it in a browser, and there is no
 * browser on this machine -- which is how the previous version shipped three invented
 * profile fields (`p.plate.mm`, `p.sheet`, `prof.palette`, none of which exist in
 * core/profiles.js) and a boolean passed where {w,h} was required.
 *
 * The refusal rules are the CLI's, not reinterpreted: paper profiles get no relief model,
 * and projectionReport / stlSelfCheck / selfCheck3MF must pass or no model is offered. A
 * relief that cannot reproduce its own raster mask belongs to the same family of failure as
 * a misaccepted frame.
 *
 * No performance work, by instruction: pages are rendered serially, PNGs re-encoded for
 * each download, and the mesh is rebuilt on every click.
 */
import { PROFILES } from '../core/profiles.js';
import { encodeTransfer } from '../core/protocol.js';
import { pageLayout } from '../core/render/layout.js';
import { renderPageBitmap, echoBitsOf } from '../core/render/raster.js';
import { encodePNG } from '../core/render/png.js';
import { encodePDFDocument } from '../core/render/pdf.js';
import { buildPlateModel, projectionReport } from '../core/mesh/plate.js';
import { encodeSTLSolid, stlSelfCheck } from '../core/mesh/stl.js';
import { encode3MF, selfCheck3MF } from '../core/mesh/threeMF.js';
import { sha256Hex } from '../core/hash.js';
import { getPalette } from '../core/palette.js';
// header.kind is a u8 (0 = data page, 1 = parity page), so the constant has to come from the
// frame module rather than be remembered here -- this file used to compare it against a
// string and silently counted zero parity pages forever (docs/DEFECTS.md D15).
import { PAGE_KIND } from '../core/frame.js';

export const isPlate = (id) => !!PROFILES[id] && PROFILES[id].medium === 'plate';

/**
 * Ported verbatim from cli/pskit.mjs pickPalette (a page cannot import from cli/, and a
 * diverged copy would mean the web sender and the CLI sender produce different ink for the
 * same profile -- so keep this in sync if that function ever changes).
 */
export function pickPalette(profileId, explicit) {
  if (explicit) return explicit;
  const p = PROFILES[profileId];
  if (p.medium === 'paper') return p.channels.some((c) => c.name === 'colour') ? 'INK4' : 'PAPER1';
  const colour = p.channels.find((c) => c.name === 'colour');
  return colour && colour.levels > 2 ? 'INK4' : colour ? 'INK2' : 'PAPER1';
}

/**
 * The whole data path, no DOM. Returns { ok, ... } or { ok:false, stage, error, hint }.
 * Callers must treat ok:false as "produce nothing", never as "warn and continue".
 */
export async function buildArtifacts(bytes, opts = {}) {
  const profileId = opts.profile || 'P-M1-300';
  const prof = PROFILES[profileId];
  if (!prof) return { ok: false, stage: 'profile', error: `未知剖面 ${profileId}`, hint: `可选：${Object.keys(PROFILES).join(' ')}` };
  const plate = isPlate(profileId);
  const mono = !!opts.mono;
  const paletteId = mono ? 'PAPER1' : pickPalette(profileId, opts.palette);
  const dpi = Number(opts.dpi) || prof.dpi || 300;
  const plateMm = plate ? Number(opts.plateMm) || 200 : undefined;
  const pass = opts.passphrase || '';
  const t0 = Date.now();

  let t;
  try {
    t = await encodeTransfer(bytes, {
      profile: profileId,
      nozzle: opts.nozzle ? Number(opts.nozzle) : undefined,
      plateMm,
      parityPct: opts.parityPct === '' || opts.parityPct == null ? undefined : Number(opts.parityPct),
      monoSafe: opts.monoSafe || undefined,
      cipher: !!pass,
      passphrase: pass || undefined,
    });
  } catch (e) {
    return { ok: false, stage: 'encode', error: e.message, hint: '常见原因：载荷超出该剖面单页容量，或校验页比例吃光预算。换更大剖面、调低校验页 %，或先分割文件。' };
  }

  // sheetMm must be {w,h} taken from the geometry the encoder just chose (cli/pskit.mjs:156);
  // a boolean here makes pageLayout's fit check compare against `true` and never fail --
  // the previous version of this file did exactly that.
  let layout;
  try {
    layout = pageLayout(t.geom, dpi, { plateMm, sheetMm: plate ? undefined : t.geom.sheetMm });
  } catch (e) {
    return { ok: false, stage: 'layout', error: e.message, hint: 'dpi 太低或幅面太小：每格至少要有可画的挤出宽度。提高 dpi 或改用粗喷嘴剖面。' };
  }

  const pages = [];
  try {
    for (let i = 0; i < t.pages.length; i++) {
      const p = t.pages[i];
      const bitmap = renderPageBitmap({ geom: t.geom, levels: p.levels, layout, palette: paletteId, mono, echoBits: echoBitsOf(p.header) });
      const png = encodePNG(bitmap);
      pages.push({ tag: `page-${String(i).padStart(3, '0')}`, bitmap, png, header: p.header, headerBytes: p.headerBytes, levels: p.levels });
    }
  } catch (e) {
    return { ok: false, stage: 'render', error: e.message, hint: `渲染 ${paletteId} 色板时失败：单色出图请把色板留在 PAPER1。` };
  }

  const pdf = encodePDFDocument(pages.map((p) => p.bitmap));

  // The relief path is per page and must survive the same three guards the CLI insists on.
  const models = [];
  if (plate) {
    for (let i = 0; i < pages.length; i++) {
      let model;
      try {
        model = buildPlateModel({ geom: t.geom, levels: pages[i].levels, layout, mono, palette: paletteId });
      } catch (e) {
        return { ok: false, stage: 'model', error: `${pages[i].tag}: ${e.message}`, hint: '浮雕装配失败：该页未出模型（不会给出一半的产物）。' };
      }
      const proj = projectionReport(model);
      if (!proj.ok) {
        return {
          ok: false,
          stage: 'projection',
          error: `${pages[i].tag}: ${proj.cellsOverTolerance}/${proj.cells} 格与栅格掩码偏差 ≥${proj.tolerancePct}%（最大 ${proj.maxPct.toFixed(2)}%），straddling ${proj.straddlingTriangles}，墨量不符 ${proj.inkedMismatch}`,
          hint: '拒绝出模型：浮雕打出来将不等于纸上印的内容。',
        };
      }
      const chk = stlSelfCheck(model.triangles);
      if (!chk.ok) return { ok: false, stage: 'stl-selfcheck', error: `${pages[i].tag}: ${chk.issues.join('; ')}`, hint: 'STL 自检不通过（非水密/退化三角形），未出模型。' };
      const three = encode3MF({
        objects: model.objects,
        metadata: {
          'pskt:profile': profileId,
          'pskt:page': i,
          'pskt:dpi': String(dpi),
          'pskt:cellPx': String(layout.cellPx),
          'pskt:sourceSha256': sha256Hex(bytes),
        },
      });
      const mfChk = selfCheck3MF(three, { expectTriangles: model.facts.trianglesTotal });
      if (!mfChk.ok) return { ok: false, stage: '3mf-selfcheck', error: `${pages[i].tag}: ${mfChk.issues.join('; ')}`, hint: '3MF 自检不通过，未出模型。' };
      models.push({
        tag: pages[i].tag,
        stl: encodeSTLSolid(model.triangles, { name: `PSKT-${profileId}-p${i}` }),
        three,
        triangles: chk.tris,
        bboxMm: chk.bbox && chk.bbox.size ? chk.bbox.size.map((v) => +v.toFixed(2)) : null,
      });
    }
  }

  return {
    ok: true,
    profileId,
    plate,
    mono,
    paletteId,
    dpi,
    plateMm,
    sheetMm: plate ? null : t.geom.sheetMm,
    layout,
    cellPx: layout.cellPx,
    geomKeys: Object.keys(t.geom).join(','),
    transfer: t,
    pages,
    pdf,
    models,
    sourceSha256: sha256Hex(bytes),
    ms: Date.now() - t0,
    bytesIn: bytes.length,
    parityPages: pages.filter((p) => p.header && p.header.kind === PAGE_KIND.PARITY).length,
  };
}

/* ------------------------------------------------------------------ DOM wiring ----
 * Everything below touches the page. The guard is what lets tools/smoke-sender.mjs import
 * this module under Node: without it, `document` at module scope is a ReferenceError and
 * the only testable thing about this file would be its syntax.
 */
if (typeof document !== 'undefined' && typeof document.getElementById === 'function' && document.getElementById('sfile')) {
  const $ = (id) => document.getElementById(id);
  const log = $('slog');
  const say = (msg, cls = '') => {
    const line = document.createElement('div');
    if (cls) line.className = cls;
    line.textContent = msg;
    log.appendChild(line);
    log.scrollTop = log.scrollHeight;
  };
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

  let state = null;

  const sel = $('sprofile');
  sel.innerHTML = '';
  for (const [id, p] of Object.entries(PROFILES)) {
    const o = document.createElement('option');
    o.value = id;
    o.textContent = `${id} · ${p.medium === 'plate' ? '实体盘' : '纸'}${p.dpi ? ` ${p.dpi}dpi` : ''}`;
    sel.appendChild(o);
  }
  sel.value = 'P-M1-300';
  const syncEnabled = () => {
    const plate = isPlate(sel.value);
    $('s3d').hidden = !plate;
    $('sheetbox').hidden = plate;
    $('dl3mf').disabled = $('dlstl').disabled = !plate || !state;
    if (!state) for (const id of ['doprint', 'dlpng', 'dlpdf']) $(id).disabled = true;
  };
  sel.addEventListener('change', syncEnabled);
  syncEnabled();

  async function encode() {
    log.innerHTML = '';
    $('pages').innerHTML = '';
    state = null;
    const file = $('sfile').files[0];
    if (!file) return say('先选一个文件（任何格式，我们只搬字节）。', 'bad');
    say(`读入 ${file.name} · ${file.size.toLocaleString()} B`);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const r = await buildArtifacts(bytes, {
      profile: sel.value,
      dpi: $('sdpi').value,
      nozzle: $('snozzle').value,
      palette: $('spalette').value,
      plateMm: $('splate').value,
      parityPct: $('sparity').value,
      monoSafe: $('smonosafe').value,
      mono: $('smono').checked,
      passphrase: $('spw').value,
    });
    if (!r.ok) {
      say(`【${r.stage}】${r.error}`, 'bad');
      if (r.hint) say(r.hint, 'hint');
      say('没有产出任何文件：宁可不出，不出半成品。', 'hint');
      syncEnabled();
      return;
    }
    state = r;
    r.pages.forEach((p, i) => {
      const card = document.createElement('figure');
      const img = document.createElement('img');
      img.alt = p.tag;
      img.src = `data:image/png;base64,${b64(p.png)}`;
      const cap = document.createElement('figcaption');
      cap.textContent = `${p.tag} · ${i + 1}/${r.pages.length}`;
      card.append(img, cap);
      $('pages').appendChild(card);
    });
    say(`编好 ${r.pages.length} 页 · ${r.ms} ms · 色板 ${r.paletteId}${r.mono ? '（单色出图）' : ''} · ${r.dpi} dpi${r.plate ? ` · 盘 ${r.plateMm}mm` : ` · 纸 ${r.sheetMm ? r.sheetMm.w + '×' + r.sheetMm.h + 'mm' : ''}`}`);
    say(`页几何字段：${r.geomKeys}`);
    say(`明文 SHA-256 ${r.sourceSha256} —— 接收端只靠这 64 个字符判定成败，不需要文件名，也不需要联网。`);
    say(r.plate ? `实体码牌 ${r.models.length} 个已过对拍 + STL 自检 + 3MF 自检（三角形 ${r.models.map((m) => m.triangles).join('/')}）。` : '纸面剖面：无实体盘，STL/3MF 按钮保持禁用（与 CLI 相同的拒绝规则）。', 'hint');
    for (const id of ['doprint', 'dlpng', 'dlpdf']) $(id).disabled = false;
    $('dl3mf').disabled = $('dlstl').disabled = !r.plate;
  }

  const printableCss = () => {
    const paper = state.plate ? `${state.plateMm}mm ${state.plateMm}mm` : state.sheetMm ? `${state.sheetMm.w}mm ${state.sheetMm.h}mm` : 'A4';
    const pageW = state.plate ? state.plateMm : state.sheetMm ? state.sheetMm.w : 210;
    return `@page{size:${paper};margin:0}@media print{html,body{margin:0;padding:0;background:#fff}nav,#opts,.no-print,.notice{display:none!important}figure{margin:0;page-break-after:always}img{width:${pageW}mm;height:auto}}`;
  };

  $('doencode').addEventListener('click', () => encode().catch((e) => say(`异常：${e.message}`, 'bad')));
  $('doprint').addEventListener('click', () => {
    if (!state) return say('先编码。', 'bad');
    const w = window.open('', '_blank');
    if (!w) return say('浏览器拦住了新窗口：请改用 pack.pdf 打印。', 'bad');
    w.document.write(`<!doctype html><meta charset=utf-8><title>PSKT</title><style>${printableCss()}body{font:14px system-ui}</style>${state.pages
      .map((p) => `<figure><img src="data:image/png;base64,${b64(p.png)}"></figure>`)
      .join('')}`);
    w.document.close();
    w.focus();
    setTimeout(() => w.print(), 300);
    say('浏览器打印可能自行缩放：要精确物理尺寸请走 pack.pdf。', 'hint');
  });
  $('dlpng').addEventListener('click', () => {
    if (!state) return say('先编码。', 'bad');
    for (const p of state.pages) give(p.png, `${p.tag}.png`, 'image/png');
    say(`${state.pages.length} 张 PNG 逐个下载（浏览器会问很多次：不打包，是为了零第三方依赖）。`);
  });
  $('dlpdf').addEventListener('click', () => {
    if (!state) return say('先编码。', 'bad');
    give(state.pdf, 'pskt-pack.pdf', 'application/pdf');
    say(`pack.pdf ${state.pdf.length.toLocaleString()} B：每页按真实物理尺寸放置，发打印机用这个。`);
  });
  const giveModels = (kind) => {
    if (!state || !state.plate) return say('纸面剖面无实体盘。', 'bad');
    for (const m of state.models) give(m[kind === 'stl' ? 'stl' : 'three'], `${m.tag}.${kind}`, kind === 'stl' ? 'model/stl' : 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml');
    say(`${state.models.length} 个 .${kind} 已下载。${kind === 'stl' ? 'STL 不带单位：切片器里按 mm 解释。' : '3MF 自带 mm 单位与 pskt:sourceSha256 元数据。'}`);
  };
  $('dlstl').addEventListener('click', () => giveModels('stl'));
  $('dl3mf').addEventListener('click', () => giveModels('3mf'));
  say('这一页只负责把文件变成能打印的东西：本机完成，不出网。接收端在 index.html。', 'hint');
}
