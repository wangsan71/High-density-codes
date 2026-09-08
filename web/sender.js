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
import { renderPageBitmap, renderSheetBitmap, echoBitsOf } from '../core/render/raster.js';
import { encodePNG } from '../core/render/png.js';
import { encodePDFDocument } from '../core/render/pdf.js';
import { buildPlateModel, projectionReport } from '../core/mesh/plate.js';
import { encodeSTLSolid, stlSelfCheck } from '../core/mesh/stl.js';
import { encode3MF, selfCheck3MF, buildZip } from '../core/mesh/threeMF.js';
import { sha256Hex } from '../core/hash.js';
import { getPalette } from '../core/palette.js';
// header.kind is a u8 (0 = data page, 1 = parity page), so the constant has to come from the
// frame module rather than be remembered here -- this file used to compare it against a
// string and silently counted zero parity pages forever (docs/DEFECTS.md D15).
import { PAGE_KIND } from '../core/frame.js';

/**
 * Page-count policies, as pure functions, so tools/smoke-sender.mjs can check the arithmetic.
 *
 * The DOM handlers that apply them sit behind a `document` guard and cannot be reached in process --
 * which is exactly how round 67's print warning ended up printing AFTER the new window had already
 * been written: the cost was paid first and the user was told afterwards. Everything that decides
 * "how many pages is too many" lives here instead, and the handlers only obey.
 *
 * The numbers are measured, not guessed. A page at A4/300dpi is 2480x3508 px, so one RGBA raster is
 * 34.8 MB; round 66's tools/sender-memory-probe.mjs measured 30.6 MB of RSS per page in Node for the
 * same rasters, and a page's base64 PNG is ~0.47 MB of JS string. A browser decodes an <img> to a
 * raster whether or not it is on screen (loading="lazy" is a hint, not a promise), so one preview
 * costs ~35 MB decoded plus ~0.5 MB of string, and a print window holding every page is the same
 * arithmetic with no cap at all: 168 pages is ~5.8 GB. That is why the print path now refuses instead
 * of warning, and why previews are capped. Nothing is lost by refusing -- pack.pdf carries every page
 * at true physical size and is already what docs/USE.md tells users to print.
 */
const PAGE_RASTER_MB = 35; // 2480 x 3508 x 4 B at A4/300dpi, rounded; probe measured 30.6 MB/page RSS
export const PREVIEW_CAP = 8;
export const PRINT_WINDOW_PAGE_CAP = 8;

/** How many previews to build, and what to tell the user about the pages that get none. */
export function previewPlan(pageCount, cap = PREVIEW_CAP) {
  const n = Math.max(0, pageCount | 0);
  const shown = Math.min(n, Math.max(0, cap | 0));
  const hidden = n - shown;
  return {
    shown,
    hidden,
    // No markdown here: say() writes textContent, so asterisks would show up literally.
    note: hidden
      ? `预览只画了前 ${shown} 页，还有 ${hidden} 页没有预览：每张预览都是 base64 图片（约 0.5 MB 字符串），浏览器还会把它解码成位图（A4/300dpi 每页约 ${PAGE_RASTER_MB} MB），页数一多手机发送端会卡。所有页都在 pack.pdf 和 PNG（zip）里，一页不缺；要逐页看请下载它们。`
      : '',
  };
}

/**
 * Whether a download is big enough that the browser might not deliver it, and what to say if so.
 *
 * This page downloads through data: URLs (no blob handling, so the CSP needs no blob: allowance), and
 * that has a cost the page cannot hide: b64() builds the whole artifact as a JS string, btoa() makes a
 * second one 4/3 the size, and the href template makes a third -- so a 63 MB zip means roughly 295 MB
 * of transient string data before the browser even starts. Whether the download then succeeds is not
 * something this page can observe; there is no event for "the file landed", so a failure here is
 * silent, and silence is the one outcome this project refuses. DEFECTS D58 was the same shape: the log
 * claimed N downloads had happened and the browser had quietly dropped most of them.
 *
 * So above a threshold this says the size, says that the page cannot know whether it worked, and names
 * the route that has no browser in it. Below the threshold it stays quiet, because a warning on every
 * three-page transfer teaches the user to ignore the log. The threshold is a judgement and not a
 * measurement: there is no browser on this machine to measure with. It sits where the transient
 * strings reach a few hundred MB, i.e. where a phone tab plausibly dies. Exported so the arithmetic is
 * testable in process and the judgement is visible instead of buried in a comparison.
 */
export const DATA_URL_RISK_BYTES = 32 * 1024 * 1024;

/** {risk, note}: note is '' unless the artifact is big enough that a data: URL download is doubtful. */
export function downloadPlan(name, byteLength) {
  const n = Math.max(0, Math.floor(Number(byteLength) || 0));
  if (n < DATA_URL_RISK_BYTES) return { risk: false, note: '' };
  const mb = (v) => (v / 1048576).toFixed(1);
  const b64Bytes = Math.ceil(n / 3) * 4;
  // No markdown: say() writes textContent, so asterisks would show up literally.
  return {
    risk: true,
    note: `「${name}」有 ${mb(n)} MB。这一页是把它变成约 ${mb(b64Bytes)} MB 的 data: URL 文本再交给浏览器下载的，这个体量可能很慢、也可能直接失败，而页面无法知道下载有没有成功（浏览器不给这个事件）。如果没落地：电脑上有 Node 就用 CLI 直接写盘、不经浏览器 —— node cli/pskit.mjs send 你的文件 --profile P-M1-300 --format png,pdf --out 目录；或者把文件切小、分几次传。`,
  };
}

/** Whether the browser-print path may write its window at all, and if not, what to say instead. */
export function printPlan(pageCount, cap = PRINT_WINDOW_PAGE_CAP) {
  const n = Math.max(0, pageCount | 0);
  if (n <= Math.max(0, cap | 0)) return { write: true, note: '' };
  return {
    write: false,
    note: `不打印：这一路会把 ${n} 页位图全部写进一个新窗口再解码，每页约 ${PAGE_RASTER_MB} MB，合计约 ${((n * PAGE_RASTER_MB) / 1024).toFixed(1)} GB —— 浏览器会卡死或者根本打不开，所以超过 ${cap} 页就不再尝试（而不是先花掉再提醒）。请改用 pack.pdf：单文件、每页按真实物理尺寸放置，下载后在任何 PDF 阅读器里打印，页数不限。`,
  };
}

export const isPlate = (id) => !!PROFILES[id] && PROFILES[id].medium === 'plate';

/**
 * G2 measured the paper side at 300 dpi as 200/200 byte-exact, and at 600 dpi as 162/200 with only
 * 43% of pages read directly (docs/DEFECTS.md D49, docs/ACCEPTANCE.md G2 section). The picker below
 * is built from *every* profile in core/profiles.js, so without a label a user can pick the
 * unqualified one and lose a file about one time in five -- and nothing warns them until the
 * receiver names the missing pages.
 *
 * The profile is deliberately NOT hidden: hiding it would quietly remove a capability, and today's
 * measurement may be superseded (calibration is unimplemented, so a capability gap cannot even be
 * ruled out). When the 600 dpi side passes G2, delete this predicate and the label suffix; the guard
 * test `tests/unit/profile-picker-warning.test.mjs` pins both to the ledger so they cannot rot.
 */
export const isUnqualifiedPaper = (p) => !!p && p.medium !== 'plate' && (p.dpi || 0) >= 600;

/**
 * The dropdown label. Measured numbers stay in the ledger rather than in this string, so the UI
 * cannot go stale the way a hardcoded ratio would (the same rule the CLI manifest note follows).
 */
export const profileOptionLabel = (id, p) =>
  `${id} · ${p.medium === 'plate' ? '实体盘' : '纸'}${p.dpi ? ` ${p.dpi}dpi` : ''}` +
  (isUnqualifiedPaper(p) ? ' · ⚠ 实测未达标 (D49)' : '');

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
      // The PNG a browser offers for printing is the paper: margins, the code area centred, crop and
      // registration marks (DEFECTS D45). `bitmap` itself stays the code area, because
      // encodePDFDocument below centres it and strokes its own vector marks -- handing it an
      // already-sheeted bitmap would centre the sheet on the sheet.
      const png = encodePNG(bitmap.sheetMm ? renderSheetBitmap(bitmap) : bitmap);
      pages.push({ tag: `page-${String(i).padStart(3, '0')}`, bitmap, png, header: p.header, headerBytes: p.headerBytes, levels: p.levels });
    }
  } catch (e) {
    return { ok: false, stage: 'render', error: e.message, hint: `渲染 ${paletteId} 色板时失败：单色出图请把色板留在 PAPER1。` };
  }

  // Hand the writer one raster at a time and drop each one the moment it has been consumed, so the
  // peak is one page's raster plus the encoded streams instead of every page's raster. Measured
  // before this change (tools/sender-memory-probe.mjs, same command): 42 pages held 1.30 GB of
  // arrayBuffers with all 42 rasters still referenced by the returned result, while heapUsed stayed
  // at 5 MB -- a 256 KiB file, an entirely ordinary document, needing more memory than a phone has.
  // `pages[i].bitmap` is null afterwards BY DESIGN: the artifacts a user downloads are the page PNGs
  // and pack.pdf, and the raster was only ever an intermediate. Anything that needs to look at a page
  // again decodes its PNG, which is the artifact that actually gets printed -- that is what
  // tools/smoke-sender.mjs now does, and it is the stronger test, not a weaker one.
  const pdf = encodePDFDocument(
    (function* rasters() {
      for (const p of pages) {
        const bmp = p.bitmap;
        p.bitmap = null;
        yield bmp;
      }
    })(),
  );

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
    // Said before the attempt, because the page cannot observe whether a download lands (downloadPlan
    // above, DEFECTS D63). One place for it: every artifact on this page -- zip, pdf, 3mf, stl -- goes
    // through give(), so a per-button warning would miss one eventually.
    const plan = downloadPlan(name, bytes.length);
    if (plan.note) say(plan.note, 'hint');
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
    o.textContent = profileOptionLabel(id, p);
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
    // Previews are capped (previewPlan above). Each one is ~0.5 MB of base64 string and, once the
    // browser decodes it, up to ~35 MB of raster -- so an uncapped preview is the cost round 66
    // removed from pack.pdf, reintroduced in the DOM (DEFECTS D61). loading/decoding are hints that
    // keep offscreen previews from being decoded eagerly; the cap is what actually bounds it.
    const plan = previewPlan(r.pages.length);
    for (let i = 0; i < plan.shown; i++) {
      const p = r.pages[i];
      const card = document.createElement('figure');
      const img = document.createElement('img');
      img.alt = p.tag;
      img.loading = 'lazy';
      img.decoding = 'async';
      img.src = `data:image/png;base64,${b64(p.png)}`;
      const fig = document.createElement('figcaption');
      fig.textContent = `${p.tag} · ${i + 1}/${r.pages.length}`;
      card.append(img, fig);
      $('pages').appendChild(card);
    }
    if (plan.note) say(plan.note, 'hint');
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
    // Decide BEFORE spending anything. Round 67 put a warning here, but it ran after window.open and
    // document.write had already pushed every page into the new window, so the user learned the cost
    // only once it had been paid -- and at 168 pages (~5.8 GB of decoded raster in one window) the tab
    // may never come back to say anything at all, which is the silent failure this project refuses.
    // printPlan() is pure, so tools/smoke-sender.mjs checks this refusal in process.
    const plan = printPlan(state.pages.length);
    if (!plan.write) return say(plan.note, 'bad');
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
  $('dlpng').addEventListener('click', async () => {
    if (!state) return say('先编码。', 'bad');
    // One zip, one download. This used to call give() once per page, i.e. N automatic downloads from
    // a single click, and browsers block that after the first couple behind a "allow multiple
    // downloads?" prompt -- so a 168-page transfer could land two files in the Downloads folder
    // while the log below claimed "N 张 PNG 逐个下载". A claim this code cannot verify is exactly the
    // silent partial success the project forbids: the user has no way to know 166 were dropped.
    // The zip writer is our own (core/mesh/threeMF.js packs 3MF with it), so this adds no dependency,
    // and entries are STORED rather than deflated because PNGs already are compressed. buildZip is
    // imported statically at the top of this file, and please leave it there: tools/build-web.mjs
    // refuses dynamic import() in web/*.js, and the first version of this handler used one -- the
    // guard fired and the build went red, which is the guard working. (A lazy './core/...' specifier
    // would also be wrong in the source tree, where the core modules live at ../core/.)
    const zip = buildZip(state.pages.map((p) => ({ name: `${p.tag}.png`, data: p.png, method: 'store' })));
    give(zip, `pskt-pages-${state.pages.length}.zip`, 'application/zip');
    say(`${state.pages.length} 张 PNG 打成一个 zip（${zip.length.toLocaleString()} B）：一次下载，不必跟浏览器的批量下载拦截打交道。想逐张看就用上面的预览或 pack.pdf。`);
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
