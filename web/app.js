/**
 * PSKT 接收端 — 浏览器外壳。
 *
 * 这里不含任何解码逻辑：所有解码都走 ../core（与 CLI、Python 参考实现同一份）。
 * 网页端要重新实现，就成「两套更易骗的实现」了；本项目的硬约束是误接受 = 0，不是
 * 「我看着也像 0」。
 *
 * 不出网：没有 fetch（仅 selftest 同源拉 conformance.json），没有 font、没有 CDN、没有
 * 分析代码。CSP 在 index.html 写的是 default-src 'self'；tools/check-dist.mjs 会
 * 把这一点变成「机器断言」而不是「我承诺」。
 */
import { decodePNG } from './core/decode/png-read.js';
import { bootstrapDecode } from './core/decode/bootstrap.js';
import { TransferAssembler } from './core/protocol.js';
// 页码被本页自己的码拒绝时，用「按本页实测标定的 ρ 切点」重读一次；重读同样只有过了
// 页内 RS + 帧 CRC + 摘要才被接受（docs/DEFECTS.md D51）。这是接收端与 CLI、G2 门限共用的同一段逻辑。
import { feedPageWithRecalibration } from './core/decode/recalibrate.js';
import { sha256Hex } from './core/hash.js';
import { PROFILE_IDS, PROFILES, profileOptionLabel } from './core/profiles.js';
import { advise } from './core/decode/advice.js';
// 下载名策略（DEFECTS D62）：与 capture.js、CLI 用户共享，纯函数，单测钉住。
// 这里不即兴起名：download 属性要从用户输入的文本走出一条安全的路径分量，每个平台都认。
import { downloadName } from './core/naming.js';

const $ = (id) => document.getElementById(id);

/* --------------------------------------------------------------- 状态 -------- */

/** 当前接收进度：决定主区卡片右上角 pill 与整张卡的 data-state。 */
const setState = (cardId, state, pillId, text) => {
  if (cardId) {
    const c = $(cardId);
    if (c) c.setAttribute('data-state', state || 'idle');
  }
  if (pillId) {
    const p = $(pillId);
    if (p) p.textContent = text;
  }
};

/** 带颜色等级的日志追加：所有用户可见文字都走这里（textContent，不走 innerHTML，markdown 不会被渲染）。 */
const logEl = $('log');
const log = (m, cls = '') => {
  const span = document.createElement('span');
  span.className = 'l' + (cls ? ' ' + cls : '');
  span.textContent = m + '\n';
  logEl.appendChild(span);
  logEl.scrollTop = logEl.scrollHeight;
};
const logClear = () => { logEl.textContent = ''; };
const setStatus = (m, state) => {
  const pill = $('status');
  if (pill) pill.textContent = m;
  setState('card-run', state || (m === '完成' ? 'ok' : m === '未完成' || m === '需要口令' ? 'err' : 'busy'), 'status', m);
};

/* ----------------------------------------------------------- 剖面下拉 -------- */

// 与发送页共用一份 label 策略（core/profiles.js），所以接收端的下拉也带 D49 警告 + 手机提示，
// 而不是再手写一份漏掉其中之一。
for (const id of PROFILE_IDS) {
  const o = document.createElement('option');
  o.value = id;
  o.textContent = profileOptionLabel(id, PROFILES[id]);
  $('profile').appendChild(o);
}

/* --------------------------------------------------------------- 文件 -------- */

const files = [];
const updateFileLine = () => {
  const wrap = $('fileline-wrap');
  const line = $('fileline');
  if (!files.length) {
    wrap.hidden = true;
    line.textContent = '';
    $('go').disabled = true;
    setState('card-intake', 'idle', 'intake-pill', '等待文件');
    setStatus('等待文件', 'idle');
    return;
  }
  const total = files.reduce((s, f) => s + f.size, 0);
  const fmt = (n) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(2)} MB`;
  line.textContent = `${files.length} 张 · ${fmt(total)} · ${files.slice(0, 3).map((f) => f.name).join(' · ')}${files.length > 3 ? ` …+${files.length - 3}` : ''}`;
  wrap.hidden = false;
  $('go').disabled = false;
  setState('card-intake', 'ok', 'intake-pill', `${files.length} 张就绪`);
  setStatus('就绪');
};

const setFiles = (list) => {
  files.length = 0;
  for (const f of list) files.push(f);
  updateFileLine();
};

$('files').addEventListener('change', (e) => setFiles(Array.from(e.target.files || [])));

// 拖放：单文件喂也按当前选择策略走，但允许一次拖多张。
const drop = $('drop-zone');
['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('is-drag'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('is-drag'); }));
drop.addEventListener('drop', (e) => {
  const dt = e.dataTransfer;
  if (!dt) return;
  const list = dt.items ? Array.from(dt.items).filter((i) => i.kind === 'file').map((i) => i.getAsFile()).filter(Boolean) : Array.from(dt.files || []);
  if (list.length) setFiles(list);
});
// 让 drop 区在键盘上也能点开文件选择（按 Enter/Space 触发 input.click）。
drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('files').click(); } });

/* ------------------------------------------------------------- 命名 -------- */

// 上一次完成传输的命名上下文；只存一份，避免 D73 那次的「每跑一次多挂一个监听器」。
let currentNaming = null;
const applyName = () => {
  if (!currentNaming) return;
  const name = downloadName({ ...currentNaming, userText: $('outname').value });
  $('download').setAttribute('download', name);
  $('outname-note').textContent = `将保存为：${name}`;
};
$('outname').addEventListener('input', applyName);

/* ---------------------------------------------------------------- 跑 -------- */

let busy = false;
$('go').addEventListener('click', () => { if (!busy) run(); });

async function decodeBrowserRaster(file) {
  const url = URL.createObjectURL(file);
  try {
    const bitmap = await createImageBitmap(file);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0);
    const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    return { width: bitmap.width, height: bitmap.height, pixels: Uint8Array.from(data.data), dpi: null };
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function run() {
  busy = true;
  $('out').hidden = true;
  logClear();
  setStatus('解码中…', 'busy');
  setState('log-wrap', 'busy', 'log-pill', '运行中');

  const hints = {
    profileHint: $('profile').value || null,
    dpiHint: $('dpi').value ? Number($('dpi').value) : null,
    paletteHint: $('palette').value || null,
    onlyHints: $('strict').checked,
  };
  const asm = new TransferAssembler({ passphrase: $('pass').value || undefined });
  log(`候选：${hints.profileHint || hints.dpiHint || hints.paletteHint ? JSON.stringify(hints) : '全自动（逐个整页读，可能几十秒）'}`);

  let accepted = 0;
  let lastHeader = null;
  let i = 0;
  for (const f of files) {
    i++;
    setStatus(`读第 ${i}/${files.length} 张：${f.name}`);
    let bmp;
    try {
      const jpegLike = /\.jpe?g$/i.test(f.name) || f.type === 'image/jpeg';
      bmp = jpegLike ? await decodeBrowserRaster(f) : decodePNG(new Uint8Array(await f.arrayBuffer()));
    } catch (e) {
      log(`  ${f.name}: 不是能读的图片（${e.message}）—— PNG/TIFF 由内核直读，JPEG 由浏览器解码；TIFF 请先转 PNG`, 'bad');
      continue;
    }
    const t0 = performance.now();
    const boot = await bootstrapDecode(bmp, {
      ...hints,
      onAttempt: (a) => log(`    试 ${a.profileId}@${a.dpi}/${a.paletteId}${a.nozzle ? '/' + a.nozzle : ''} -> ${a.stage}/${a.reason} [${a.ms}ms]`, 'hint'),
    });
    if (!boot.ok) {
      log(`  ${f.name}: 认不出来（试了 ${boot.tried ?? boot.attempts.length} 组候选 · ${Math.round(performance.now() - t0)}ms）`, 'bad');
      const a = adviseOr('no-geometry-matched', '这些图里没有本工具能认出的页码几何（可能被裁掉一角、分辨率过低、或来自另一套剖面）');
      log(`      成因：${a.cause}`);
      log(`      做法：${a.do}`);
      continue;
    }
    const h = boot.header;
    lastHeader = h;
    log(`  ${f.name}: ${boot.profileId}@${boot.dpi}dpi ${boot.paletteId} 第 ${h.pageIndex}/${h.totalPages - 1} 页（${h.kind ? '校验' : '数据'}）· 第 ${boot.attemptCount} 次命中 · ${Math.round(performance.now() - t0)}ms`);
    const resc = await feedPageWithRecalibration(asm, boot.page, { geom: boot.geom });
    const fed = resc.fed;
    if (fed.duplicate) { log('      重复页（已去重）'); continue; }
    if (!fed.ok) {
      log(`      装配拒绝：${fed.reason}`, 'bad');
      if (resc.retried) log(`      已按本页实测的 ρ 切点重读过一次（切点 ${resc.estimate?.cut?.toFixed(4)}、改了 ${resc.changed} 格），仍被本页的码拒绝（${resc.secondReason}）⇒ 不写盘`);
      continue;
    }
    if (resc.retried) {
      log(`      救回：匹配滤波的读法被页内码拒绝，改用按本页实测 ρ 标定的切点重读（切点 ${resc.estimate.cut.toFixed(4)}、两簇 ${resc.estimate.m0.toFixed(3)}/${resc.estimate.m1.toFixed(3)}、改了 ${resc.changed} 格）`);
      log('      接受它的理由是页内 RS + 帧 CRC + 摘要都过了，不是那个切点本身');
    }
    accepted++;
  }

  setStatus('核对摘要…', 'busy');
  if (!asm.result) {
    const p = asm.progress;
    if (asm.needPassphrase) {
      // 所有页都到齐，所以「仍缺料」会把用户送回打印机（白跑一趟，D66）。
      // 这里不写 markdown：log() 走 textContent，星号会原样显示。
      log('未完成：页收齐了（数据页 ' + p.dataHave + '/' + p.dataNeed + '），但这批是加密传输，而第 2 节的「口令」是空的。', 'bad');
      log('      缺的不是页、是口令：在上面填入口令，再按一次「3 · 开始还原」就行 —— 已选的文件还在，不必重新选，更不必重印重扫。');
      log('      没有写出任何文件：没有钥匙就没有明文，也就无从核对页头声明的摘要。');
      busy = false;
      setStatus('需要口令', 'err');
      setState('log-wrap', 'warn', 'log-pill', '需要口令');
      return;
    }
    log(p.noSession
      ? '未完成：没有任何一页的头能读出来 —— 这是整批失败，缺页校验也帮不上（几何还没认出来）'
      : `未完成（数据页 ${p.dataHave}/${p.dataNeed}）：${asm.error || '仍缺料'}`, 'bad');
    log('没有写出任何文件：本工具从不产出半成品');
    busy = false;
    setStatus('未完成', 'err');
    setState('log-wrap', 'err', 'log-pill', '未完成');
    return;
  }

  const digest = sha256Hex(asm.result);
  const blob = new Blob([asm.result], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  $('download').href = url;
  // 文件名由字节导出：页头没有名字字段（frame.js:14-28 只有 magic..digest..crc16），
  // 默认名只能从字节算出来。这是单测钉死的，下面的 userText 只改扩展名/前缀。
  // 监听器在模块加载时挂一次（D73 修的就是「run() 内挂 → 每次多挂一个」），不在 run() 里。
  currentNaming = { byteLength: asm.result.length, sha256Hex: digest };
  applyName();

  $('result-line').innerHTML = '';
  const meta = document.createElement('span');
  meta.innerHTML = `已逐字节还原：<b>${asm.result.length.toLocaleString()}</b> 字节 · SHA-256 <code>${digest.slice(0, 16)}…</code>（与页头声明摘要一致才走到这里）· <b>${accepted}</b> 页被接受`;
  $('result-line').appendChild(meta);
  $('out').hidden = false;
  setState('out', 'ok', null, null);
  setState('card-run', 'ok', null, null);
  log(`完成：${asm.result.length} 字节，摘要核对通过`, 'ok');
  busy = false;
  setStatus('完成', 'ok');
  setState('log-wrap', 'ok', 'log-pill', '完成');
}

function adviseOr(reason, fallback) {
  try {
    return advise({ stage: 'markers', reason });
  } catch {
    // advice.js 映射一个固定的 reason 集合；没映射的 reason 不能让整条 readout 链都崩掉 —— 日志的价值就是「总是说点什么」。
    return { cause: fallback, do: '换一组候选（剖面/dpi/色板）重试，或改用 CLI 的 receive 带 manifest 定位。' };
  }
}

/* ------------------------------------------------------------- 摄像头 --------
 * `file://` 在 Chrome 算安全上下文，所以「isSecureContext 为 false」不是真原因——
 * 真正的限制是不透明 origin（SW 注册不到，getUserMedia 策略因浏览器而异）。
 * 把协议名说出来，别猜。
 */
const isFile = location.protocol === 'file:';
const secure = window.isSecureContext === true && !isFile;
if (!secure) {
  $('camera-note').textContent = isFile
    ? '以 file:// 打开时不保证能用摄像头（来源是不透明的，且 Service Worker 无法注册）：请用系统相机拍照存成 PNG，再走上面的文件选择。解码本身完全不受影响。'
    : '此页面不是安全上下文：浏览器不允许调用摄像头。请拍照存成 PNG 后走文件选择，解码本身不受影响。';
  $('camera').disabled = true;
} else {
  $('camera-note').textContent = '会请求摄像头权限；帧数据只在本机处理，不做任何上传。';
  $('camera').addEventListener('click', async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 4096 }, height: { ideal: 3000 } } });
      const v = $('video');
      v.hidden = false;
      v.srcObject = stream;
      await v.play();
      log('对准整页，四点都在画面内、不反光，然后按快门。');
      $('camera').textContent = '拍照';
      $('camera').onclick = () => {
        const g = $('grab');
        g.width = v.videoWidth;
        g.height = v.videoHeight;
        g.getContext('2d').drawImage(v, 0, 0);
        stream.getTracks().forEach((t) => t.stop());
        v.hidden = true;
        g.toBlob(async (b) => {
          const bytes = new Uint8Array(await b.arrayBuffer());
          try {
            const bmp = decodePNG(bytes);
            files.length = 0;
            files.push(new File([bytes], 'camera-page.png', { type: 'image/png' }));
            log('已抓到一帧，开始还原。', 'ok');
            run();
          } catch (e) {
            log(`抓帧失败：${e.message}`, 'bad');
          }
        }, 'image/png');
      };
    } catch (e) {
      log(`摄像头不可用：${e.name} ${e.message}`, 'bad');
    }
  });
}

/* ----------------------------------------------- Service Worker：离线预缓存 -- */

if ('serviceWorker' in navigator && secure) {
  navigator.serviceWorker.register('./sw.js').then(
    () => log('离线缓存已就绪（下次断网也能还原）。', 'hint'),
    (e) => log(`Service Worker 注册失败：${e.message}（不影响本次还原）`, 'hint'),
  );
}

/* ------------------------------------------- ?selftest=1 的入口在 selftest-page.js，
 * 不要从这里 import 它：selftest.js 故意用 dynamic import() 拉 conformance.json
 * 200KB 的向量表，build-web.mjs 拒绝把 dynamic import 打进 bundle（这是契约不是 bug）：
 * 把它打包就意味着要么 selftest 失能，要么 bundler 失能，两边一起坏。 */

// 启动时给文件区一个明确的初始态。
updateFileLine();
