/**
 * PSKT 发送端 — 浏览器内把文件编码成可打印产物。
 *
 * 存在的原因：手机跑不了 cli/pskit.mjs。CLI 在 encodeTransfer 之后做的所有事（raster、PNG、
 * PDF、网格）都是 core/ 里的纯 ESM，浏览器同样能做。PLAN 的「无外部源」在这里更严：什么
 * 都不出设备，下载走 data: URL，不申请 blob: 许可，所以 CSP 不用放宽。
 *
 * 结构由可测性决定，不是审美：buildArtifacts() 是纯函数、不碰 DOM，
 * tools/smoke-sender.mjs 才能在 Node 里跑同一段代码。这台机器没浏览器，而 click 测不到时，
 * 上一版发出去过三个臆造的字段（`p.plate.mm` / `p.sheet` / `prof.palette`，core/profiles.js
 * 里一个都没有），还有个 boolean 填到了 {w,h} 位置上。
 *
 * 拒绝规则和 CLI 同一份：纸面档不浮雕；浮雕档要 projectionReport / stlSelfCheck / selfCheck3MF
 * 全过才给模型。一个浮雕不能复现自己的栅格掩码，与一个被错接受的帧是同族的失败。
 *
 * 性能不做（按口径）：页顺序渲染、PNG 每下载一次重编、网格每次点击重算。
 */
import { PROFILES, planPage, isUnqualifiedPaper, profileOptionLabel } from '../core/profiles.js';
// 在 core 里实现、这里再 re-export：让页面有自己的 surface，也让 tests/unit/profile-picker-warning.test.mjs
// 可以从页面或 core 任一处 import，两边不会漂移。
export { isUnqualifiedPaper, profileOptionLabel };
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
// header.kind 是 u8（0 = 数据页，1 = 校验页），常量要从 frame 模块取，不能在这里记一份
// — 上一版就把它当成字符串比，结果校验页数永远是 0（docs/DEFECTS.md D15）。
import { PAGE_KIND } from '../core/frame.js';

/**
 * 页数策略，都写成纯函数，tools/smoke-sender.mjs 才能在进程内核对算术。
 *
 * 套在「document 守卫」后面的 DOM 处理器在 Node 里跑不到 —— 这正是第 67 轮那个 printPlan
 * 在新窗口已经写出来之后才警告的原因：成本先付、用户后知。所有「多少页算太多」的判断都住
 * 在这里，处理器只负责照办。
 *
 * 数字是量出来的，不是猜的：A4/300 dpi 一页 2480×3508 px，RGBA 光栅 34.8 MB；第 66 轮的
 * tools/sender-memory-probe.mjs 在 Node 里量到 30.6 MB/页；PNG 的 base64 约 0.47 MB 的 JS 字符串。
 * 浏览器把 <img> 解码成位图，不管它有没有上屏（loading="lazy" 是 hint 不是承诺），所以一张预览
 * 要 ~35 MB 解码后位图 + ~0.5 MB 字符串；一个把每页都装进去的 print 窗口是这个算术的 168 倍
 * ≈ 5.8 GB ⇒ 这就是为什么 print 路径现在直接拒绝、不再「先花掉再警告」。预览也限张数。
 * 失去的什么也没有：pack.pdf 每页按真实物理尺寸摆好，正是 docs/USE.md 告诉用户打印用的。
 */
const PAGE_RASTER_MB = 35; // 2480×3508×4 B @ A4/300dpi，向上取整；probe 实测 30.6 MB/页 RSS
export const PREVIEW_CAP = 8;
export const PRINT_WINDOW_PAGE_CAP = 8;

/** 画几张预览，没画到的怎么告诉用户。 */
export function previewPlan(pageCount, cap = PREVIEW_CAP) {
  const n = Math.max(0, pageCount | 0);
  const shown = Math.min(n, Math.max(0, cap | 0));
  const hidden = n - shown;
  return {
    shown,
    hidden,
    // 不写 markdown：say() 走 textContent，星号会原样显示。
    note: hidden
      ? `预览只画了前 ${shown} 页，还有 ${hidden} 页没有预览：每张预览都是 base64 图片（约 0.5 MB 字符串），浏览器还会把它解码成位图（A4/300dpi 每页约 ${PAGE_RASTER_MB} MB），页数一多手机发送端会卡。所有页都在 pack.pdf 和 PNG（zip）里，一页不缺；要逐页看请下载它们。`
      : '',
  };
}

/**
 * 下载体量会不会让浏览器拖不住，拖不住时怎么说。
 *
 * 本页下载走 data: URL（不走 blob:，所以 CSP 不用放宽），这是有代价的：b64() 把整个产物
 * 变成 JS 字符串，btoa() 再乘 4/3，href 模板再乘 1 倍 —— 一个 63 MB 的 zip，瞬时字符串数据
 * ~295 MB，浏览器才开始下载。下载是否落地浏览器不告诉本页（没有「文件落地」事件），失败就是
 * 静默的，而「静默」是本项目拒绝的那一种失败。DEFECTS D58 是同一种病：那版日志说下载了 N 个，
 * 浏览器悄悄丢了大多数。
 *
 * 所以超过一个阈值就明说：体量、能否成功不知道、点名不经过浏览器的路径；阈值以下就不出声，
 * 因为三页的传输也警告的话，用户就学会忽略日志了。阈值是判断不是测量：本机没浏览器能量。
 * 阈值落在瞬时字符串几百 MB 的位置，也就是手机标签页大概率死的那个点。export 出来是为了让算
 * 术在进程内可测、让判断不埋在比较里。
 */
export const DATA_URL_RISK_BYTES = 32 * 1024 * 1024;

/**
 * 一次传输能装多少的真正限制（以及用户撞上时该看到什么）。
 *
 * 不是浏览器限制，也不是判断：页头 totalPages 是 1 字节（core/frame.js:19），所以一次传输
 * 最多 255 页，core/protocol.js:318-320 还会用掉一部分做页间校验，剩下的用满就拒：
 * `too many pages: N data pages leave no room for parity`。P-M1-300 默认 20% 校验下
 * 上限是 212 数据页 × 7490 B ≈ 1.5 MB 的不可压数据。量出来的，不是算出来的：1 MiB 编出
 * 168 页 ~180 ms，2 MiB 在 48 ms 拒。下面这些是浏览器的故事，这条是协议的事，所以 CLI
 * 和网页口径一致，切换路径不变 —— 措辞得说出来，因为「用 CLI 替代」是本项目常用的逃生口，
 * 这里它不是逃生口。
 */
export const PROTOCOL_PAGE_LIMIT = 255; // core/frame.js:19，totalPages 是 u8
const PAGE_RENDER_MS = 202; // ACCEPTANCE G6：A4/300dpi 渲染+PNG/页，量出来的
// 把文件读进标签页是一次性同步分配它的整个大小。超过这个数，先说。这是个判断不是测量（本机没
// 浏览器能量），它只产生一句话、不会拒，所以猜错也只是多一句噪音。
const BIG_READ_BYTES = 64 * 1024 * 1024;

/**
 * {dataPages, parityPages, pages, over, limit, maxPayloadBytes, perDataPageBytes, parityPct}，
 * 几何未知时返 null —— 没数就别说话，更不能猜。
 *
 * 镜像 core/protocol.js:307-321：dataPages = ceil(payload / geom.ecc.dataBytes)，
 * parity = max(2, ceil(dataPages * pct / 100))，总页被 1 字节的页头字段封顶。
 * tools/smoke-sender.mjs 拿这个镜像去钉编码器自己产出的数：1 MiB 默认校验下两边都说 168 页，
 * 2 MiB 两边都说 280 数据页。
 *
 * 假设 deflate 一无所获，所以 `pages` 对任何可压文件都是高估，上界不限：本项目自己的 deflate
 * 把 4 MiB 的全 0 压到 6 页。这条规则可以警告、不能拒 —— 第 71 轮第一版在估计量上拒了，smoke
 * 在发版前抓住：20 MB 的日志压成几百页，本来能传，被卡在选文件上，这是误拒，是教用户「这工具
 * 是坏的」的那种。拒的事归 core/protocol.js，压缩后长度是事实。
 */
export function transferBudget(byteLength, geom, parityPct) {
  const D = geom && geom.ecc && geom.ecc.dataBytes > 0 ? geom.ecc.dataBytes : 0;
  if (!(D > 0)) return null;
  const pct = parityPct === '' || parityPct == null || !Number.isFinite(Number(parityPct))
    ? (geom.ecc.inter ? Number(geom.ecc.inter.parityPct) || 0 : 0)
    : Number(parityPct);
  const n = Math.max(0, Math.floor(Number(byteLength) || 0));
  const dataPages = Math.ceil(n / D) || 1; // protocol.js:307 也是 `|| 1`
  const parityPages = Math.max(2, Math.ceil((dataPages * pct) / 100));
  // 最大载荷是这样问出来的：往回走 dataPages，直到它要的校验页让总数还塞在 1 字节字段里。
  let maxData = 0;
  for (let d = PROTOCOL_PAGE_LIMIT - 2; d >= 1; d--) {
    if (d + Math.max(2, Math.ceil((d * pct) / 100)) <= PROTOCOL_PAGE_LIMIT) { maxData = d; break; }
  }
  return {
    dataPages,
    parityPages,
    pages: dataPages + parityPages,
    limit: PROTOCOL_PAGE_LIMIT,
    over: dataPages + parityPages > PROTOCOL_PAGE_LIMIT,
    maxPayloadBytes: maxData * D,
    perDataPageBytes: D,
    parityPct: pct,
  };
}

/** core/protocol.js:320 那次拒的整句用户语，带真数字。几何未知就空串，让调用方保留原 hint。 */
export function pageLimitHint(byteLength, geom, parityPct) {
  const b = transferBudget(byteLength, geom, parityPct);
  if (!b) return '';
  const mb = (v) => (v / 1048576).toFixed(2);
  const at0 = transferBudget(byteLength, geom, 0);
  // 不写 markdown：say() 走 textContent，星号会原样显示。
  return `装不下，而且是协议装不下、不是浏览器的问题：页头的 totalPages 只有一个字节（core/frame.js:19）⇒ 一次传输最多 ${b.limit} 页，校验页挤到没位置时 core/protocol.js:320 就拒绝。这个文件按当前档（每页净 ${b.perDataPageBytes} B）与 ${b.parityPct}% 校验页需要 ${b.pages} 页（${b.dataPages} 个数据页 + ${b.parityPages} 个校验页），而当前配置一次最多约 ${mb(b.maxPayloadBytes)} MB。三条路：① 把校验页 % 调低（0% 时约 ${at0 ? mb(at0.maxPayloadBytes) : '更多'} MB，代价是丢页时的恢复能力下降）；② 换每页装得更多的档（如 600 dpi 或四色档，代价是对打印与扫描的要求更高）；③ 把它切成几份分别传，这一条有现成命令：node cli/pskit.mjs split 你的文件（默认每份 ≤1.4 MB，写出 part-NNN.bin 与 parts.json）⇒ 每份各自发送、打印、扫描，接收时写回同一目录、用同一个 part 名字 ⇒ node cli/pskit.mjs join 那个目录 --out 文件名（逐份校验摘要、再校验整文件摘要，缺一份或错一位就拒绝并退出 1，绝不交出一个「短一点的文件」）。注意：CLI 受同一个 255 页限制（它走同一个 encodeTransfer），所以「改用 CLI」解决不了这一条 —— 解决它的是切分。`;
}

/**
 * {warn, note}：读文件进标签页前该说的话。只警告不拒 —— 看 transferBudget 为什么「估计量不该拒」。
 *
 * 两件事值得提前说，因为都发生在确切页数算出来之前：文件可能一次装不下，以及读是一次性同步分配
 * 整份（DEFECTS D65）。知道为什么标签页即将不响的只是被打扰；不知道的会以为工具坏了。
 */
export function earlySizePlan(byteLength, geom, parityPct) {
  const n = Math.max(0, Math.floor(Number(byteLength) || 0));
  const b = transferBudget(n, geom, parityPct);
  const mb = (v) => (v / 1048576).toFixed(2);
  const parts = [];
  if (b && b.over) {
    const at0 = transferBudget(n, geom, 0);
    parts.push(`这个文件有 ${mb(n)} MB：如果 deflate 压不动它，一次传输装不下 —— 需要 ${b.pages} 页（${b.dataPages} 个数据页 + ${b.parityPages} 个校验页），而一次最多 ${b.limit} 页（页头 totalPages 只有一个字节：core/frame.js:19）。当前档每页净 ${b.perDataPageBytes} B、校验页 ${b.parityPct}%，一次最多约 ${mb(b.maxPayloadBytes)} MB。三条路：把校验页 % 调低（0% 时约 ${at0 ? mb(at0.maxPayloadBytes) : '更多'} MB）、换每页装得更多的档、或把它切成几份分别传（现成命令：node cli/pskit.mjs split 你的文件，然后每份各自发送与接收，最后 node cli/pskit.mjs join 那个目录 --out 文件名；join 逐份校验摘要再校验整文件摘要，缺一份就拒绝）。压得动就没事：我们会先压缩再按真实页数判定（本项目自己的 deflate 把 4 MiB 全零压成 6 页）。`);
  } else if (b && b.pages * PAGE_RENDER_MS >= 10000) {
    parts.push(`如果这个文件压不动，它约 ${b.pages} 页，渲染期间页面会有约 ${Math.round((b.pages * PAGE_RENDER_MS) / 1000)} 秒不响应（渲染是同步的，实测约 ${PAGE_RENDER_MS} ms/页）。`);
  }
  if (n >= BIG_READ_BYTES) {
    parts.push(`另外：把 ${mb(n)} MB 读进标签页是一次性同步分配，本身就可能卡住几十秒，甚至让页面死掉。`);
  }
  return { warn: parts.length > 0, note: parts.join(' ') };
}

/** {risk, note}：note 在产物大到 data: URL 下载可疑时才有。 */
export function downloadPlan(name, byteLength) {
  const n = Math.max(0, Math.floor(Number(byteLength) || 0));
  if (n < DATA_URL_RISK_BYTES) return { risk: false, note: '' };
  const mb = (v) => (v / 1048576).toFixed(1);
  const b64Bytes = Math.ceil(n / 3) * 4;
  return {
    risk: true,
    // 不写 markdown：say() 走 textContent，星号会原样显示。
    note: `「${name}」有 ${mb(n)} MB。这一页是把它变成约 ${mb(b64Bytes)} MB 的 data: URL 文本再交给浏览器下载的，这个体量可能很慢、也可能直接失败，而页面无法知道下载有没有成功（浏览器不给这个事件）。如果没落地：电脑上有 Node 就用 CLI 直接写盘、不经浏览器 —— node cli/pskit.mjs send 你的文件 --profile P-M1-300 --format png,pdf --out 目录；或者把文件切小、分几次传。`,
  };
}

/** 浏览器打印这条路能不能开新窗、不能开时怎么说。 */
export function printPlan(pageCount, cap = PRINT_WINDOW_PAGE_CAP) {
  const n = Math.max(0, pageCount | 0);
  if (n <= Math.max(0, cap | 0)) return { write: true, note: '' };
  return {
    write: false,
    note: `不打印：这一路会把 ${n} 页位图全部写进一个新窗口再解码，每页约 ${PAGE_RASTER_MB} MB，合计约 ${((n * PAGE_RASTER_MB) / 1024).toFixed(1)} GB —— 浏览器会卡死或者根本打不开，所以超过 ${cap} 页就不再尝试（而不是先花掉再提醒）。请改用 pack.pdf：单文件、每页按真实物理尺寸放置，下载后在任何 PDF 阅读器里打印，页数不限。`,
  };
}

export const isPlate = (id) => !!PROFILES[id] && PROFILES[id].medium === 'plate';

// profileOptionLabel / isUnqualifiedPaper 现在住在 core/profiles.js，在文件顶上 re-export。

/**
 * 原样从 cli/pskit.mjs 的 pickPalette 搬过来 —— 页面没法 import cli/，而一份漂走的副本意味
 * 着网页发送端与 CLI 发送端对同一档位印出不同的墨。若 pickPalette 改，本函数也要改。
 */
export function pickPalette(profileId, explicit) {
  if (explicit) return explicit;
  const p = PROFILES[profileId];
  if (p.medium === 'paper') return p.channels.some((c) => c.name === 'colour') ? 'INK4' : 'PAPER1';
  const colour = p.channels.find((c) => c.name === 'colour');
  return colour && colour.levels > 2 ? 'INK4' : colour ? 'INK2' : 'PAPER1';
}

/**
 * 整条数据路径，无 DOM。返回 { ok, ... } 或 { ok:false, stage, error, hint }。
 * 调用方必须把 ok:false 当成「什么都不出」，不能当成「警告一下然后继续」。
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
    // core/protocol.js:320 的 "too many pages: N data pages leave no room for parity" 是 RangeError，
    // 是真的，但不是用户能照做的句子：它不说上限、为什么、文件要多少、哪个旋钮。
    // CLI 从第 47 轮起就把这句话说完整（"needs 1120 pages > 255 (inter-page RS limit): shrink payload or use a denser profile"），
    // 这一页以前只把异常原文 + 一句通用提示（DEFECTS D65）。数字从 transferBudget 算，
    // smoke-sender 把这套算术钉在编码器自己产出的数上。
    let hint = '常见原因：载荷超出该剖面单页容量，或校验页比例吃光预算。换更大剖面、调低校验页 %，或先分割文件。';
    if (/too many pages/i.test(e.message)) {
      try {
        const g = planPage(profileId, { nozzle: opts.nozzle ? Number(opts.nozzle) : undefined, plateMm });
        hint = pageLimitHint(bytes.length, g, opts.parityPct) || hint;
      } catch {
        // 解释失败不能盖住真错误：保留通用提示。
      }
    }
    return { ok: false, stage: 'encode', error: e.message, hint };
  }

  // sheetMm 必须是 {w,h}，从编码器刚选的 geom 取（cli/pskit.mjs:156）；
  // 这里如果传 boolean，pageLayout 的 fit 检查会拿它和 `true` 比，永远不失败
  // —— 上一版正是这么写的。
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
      // 浏览器拿去打印的是纸：边距、码区居中、裁切与套准标记（DEFECTS D45）。`bitmap` 本身留作
      // 码区，因为下面的 encodePDFDocument 会自己居中并描自己的矢量标记 —— 给它一个已带白边的
      // 位图会变成「在白边上居中白边」。
      const png = encodePNG(bitmap.sheetMm ? renderSheetBitmap(bitmap) : bitmap);
      pages.push({ tag: `page-${String(i).padStart(3, '0')}`, bitmap, png, header: p.header, headerBytes: p.headerBytes, levels: p.levels });
    }
  } catch (e) {
    return { ok: false, stage: 'render', error: e.message, hint: `渲染 ${paletteId} 色板时失败：单色出图请把色板留在 PAPER1。` };
  }

  // 一次喂给 writer 一张位图，用完就丢：峰值 = 一页的位图 + 编码流，而不是每页都留。
  // 改之前量过（tools/sender-memory-probe.mjs，同一命令）：42 页持着 1.30 GB arrayBuffer，
  // 42 张位图仍被返回结果引用着；heapUsed 才 5 MB —— 一个 256 KiB 的普通文档，要的内存比手机
  // 还多。`pages[i].bitmap` 之后被故意置 null：用户拿到的是 PNG 与 pack.pdf，位图只是中间。
  // 想再看就重新解它的 PNG（这才真正是要打印的那一份 —— tools/smoke-sender.mjs 现在这么干，
  // 那是更强的测试，不是更弱的）。
  const pdf = encodePDFDocument(
    (function* rasters() {
      for (const p of pages) {
        const bmp = p.bitmap;
        p.bitmap = null;
        yield bmp;
      }
    })(),
  );

  // 浮雕路径逐页走 CLI 坚持的那三道关。
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

/* ----------------------------------------------------------------- DOM --------
 * 守卫让 tools/smoke-sender.mjs 能在 Node 里 import 本模块：没有它，模块作用域里的 `document`
 * 立即 ReferenceError，唯一能测的就剩语法。
 */
if (typeof document !== 'undefined' && typeof document.getElementById === 'function' && document.getElementById('sfile')) {
  const $ = (id) => document.getElementById(id);
  const log = $('slog');
  const say = (msg, cls = '') => {
    const line = document.createElement('span');
    if (cls) line.className = 'l' + (cls ? ' ' + cls : '');
    line.textContent = msg + '\n';
    log.appendChild(line);
    log.scrollTop = log.scrollHeight;
  };
  const b64 = (bytes) => {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const give = (bytes, name, mime) => {
    // 先说，再下：浏览器不告诉页面下载是否落地（downloadPlan 同源、DEFECTS D63）。
    // 一处发：所有产物（zip、pdf、3mf、stl）都走 give()，所以「按按钮才警告」迟早漏一个。
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
    $('opts').setAttribute('data-state', state ? 'ok' : 'idle');
  };
  sel.addEventListener('change', syncEnabled);
  syncEnabled();

  // 文件选择 + 拖放（与接收端同一套：拖进 / 点开都走同一路径）。
  const sendDrop = $('send-drop');
  if (sendDrop) {
    ['dragenter', 'dragover'].forEach((ev) => sendDrop.addEventListener(ev, (e) => { e.preventDefault(); sendDrop.classList.add('is-drag'); }));
    ['dragleave', 'drop'].forEach((ev) => sendDrop.addEventListener(ev, (e) => { e.preventDefault(); sendDrop.classList.remove('is-drag'); }));
    sendDrop.addEventListener('drop', (e) => {
      const dt = e.dataTransfer;
      if (!dt) return;
      const f = dt.items ? (Array.from(dt.items).find((i) => i.kind === 'file')?.getAsFile()) : (Array.from(dt.files || [])[0]);
      if (!f) return;
      const inp = $('sfile');
      try {
        const dt2 = new DataTransfer();
        dt2.items.add(f);
        inp.files = dt2.files;
      } catch {
        // 老 Safari 不支持 DataTransfer 构造；只更新文字提示，不强行塞 input.files。
      }
      say(`已选 ${f.name} · ${(f.size / 1024).toFixed(1)} KB`, 'hint');
    });
  }

  async function encode() {
    log.textContent = '';
    $('pages').innerHTML = '';
    state = null;
    setPill('send-pill', '编码中…', 'busy');
    setPill('preview-pill', '—', 'idle');
    $('opts').setAttribute('data-state', 'busy');
    const file = $('sfile').files[0];
    if (!file) {
      say('先选一个文件（任何格式，我们只搬字节）。', 'bad');
      $('opts').setAttribute('data-state', 'idle');
      setPill('send-pill', '未编码', 'idle');
      return;
    }
    // 大文件的代价先说、再读。这一页只警告、不能拒（看 transferBudget：deflate 不可压的
    // 估计量拒了就会让一个 20 MB 的日志被卡在选文件上 —— 误拒，D65）。读是一次性同步分配
    // 整份，渲染也是，所以用户得在标签页停转之前看到数字。planPage 拒过的选项组合就别说。
    try {
      const g = planPage(sel.value, {
        nozzle: Number($('snozzle').value) || undefined,
        plateMm: Number($('splate').value) || undefined,
      });
      const early = earlySizePlan(file.size, g, $('sparity').value);
      if (early.warn) say(early.note, 'hint');
    } catch {
      // 这个选项组合没估计量；编码器会自己拒。
    }
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
      $('opts').setAttribute('data-state', 'err');
      setPill('send-pill', '失败', 'err');
      return;
    }
    state = r;
    // 预览限张（previewPlan）。每张 ~0.5 MB base64 字符串，浏览器解了再 +~35 MB 位图 —— 不限张就
    // 是把第 66 轮从 pack.pdf 上拿掉的代价又从 DOM 那边加回来（DEFECTS D61）。loading/decoding
    // 是 hint，cap 才是上限。
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
      fig.innerHTML = '';
      const t = document.createElement('span'); t.textContent = p.tag; fig.appendChild(t);
      const c = document.createElement('span'); c.className = 'muted'; c.textContent = `${i + 1}/${r.pages.length}`; fig.appendChild(c);
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
    $('opts').setAttribute('data-state', 'ok');
    setPill('send-pill', '已编码', 'ok');
    setPill('preview-pill', `${r.pages.length} 页`, 'ok');
    $('ssheetinfo').textContent = r.plate ? `${r.plateMm}×${r.plateMm} mm` : `${r.sheetMm.w}×${r.sheetMm.h} mm`;
  }

  const printableCss = () => {
    const paper = state.plate ? `${state.plateMm}mm ${state.plateMm}mm` : state.sheetMm ? `${state.sheetMm.w}mm ${state.sheetMm.h}mm` : 'A4';
    const pageW = state.plate ? state.plateMm : state.sheetMm ? state.sheetMm.w : 210;
    return `@page{size:${paper};margin:0}@media print{html,body{margin:0;padding:0;background:#fff}nav,#opts,.no-print,.notice,#out,header,footer{display:none!important}figure{margin:0;page-break-after:always}img{width:${pageW}mm;height:auto}}`;
  };

  $('doencode').addEventListener('click', () => encode().catch((e) => say(`异常：${e.message}`, 'bad')));
  $('doprint').addEventListener('click', () => {
    if (!state) return say('先编码。', 'bad');
    // 先决定、再花。第 67 轮在这个位置放过 warning，但那是 window.open + document.write 已经
    // 把每页塞进新窗口之后 —— 用户是花了钱才知道的，168 页 ≈ 5.8 GB 的解码位图塞一窗，标签页
    // 也许再也不会回来说话，那是本项目拒绝的静默失败。printPlan() 是纯函数，smoke-sender
    // 在进程内就把这条拒掉了。
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
    // 一个 zip、一次下载。以前是每页一次 give()，等于一次点击 N 次自动下载，浏览器到第 2 个
    // 就开始弹「是否允许多次下载」——168 页的传输可能只落地两张，日志却写「N 张 PNG 逐个下载」。
    // 这一次点击页面看不见的话，就是项目禁止的「半成品假装成功」。zip 写入器是我们自己的
    // （core/mesh/threeMF.js 打包 3MF 用的就是它），不引依赖；条目走 STORED 而非 deflated，
    // 因为 PNG 已经压过。buildZip 在文件顶上静态 import，麻烦别动：tools/build-web.mjs 拒绝
    // web/*.js 里的 dynamic import()，第一版用了就红过，这是护栏在工作。
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

  // 状态 pill 工具。
  function setPill(id, text, state) {
    const p = $(id);
    if (!p) return;
    p.textContent = text;
    if (state) {
      // 找到包含这个 pill 的 card 并打 data-state，让整张卡也跟着变色。
      let n = p.parentElement;
      while (n && n !== document.body) {
        if (n.classList && n.classList.contains('card')) { n.setAttribute('data-state', state); break; }
        n = n.parentElement;
      }
    }
  }
}
