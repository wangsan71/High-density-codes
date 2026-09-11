/**
 * 手机连拍：决定哪些摄像头帧值得解、什么时候停。
 *
 * 这里不做的事：不检标记、不矫正、不解码任何东西。core/decode/page.js 已经把「照片」路径
 * 做完了（marker quad → rectifyPage → cell 测量），并把 path:'photo'、markerPx、coverage
 * 报告出来；core/decode/bootstrap.js 从页本身认几何。在这里再写一份就会变成「两份几何真
 * 相」，正是这个项目生 bug 的方式。
 *
 * 这里做的事——相机循环真正要的、也是没相机也能测的：
 *   - 质量门：把「角标太小」「整页没进画面」翻译成「走近一点 / 退半步」这样的人话，而不是
 *     静默失败；
 *   - 按 session + pageIndex 去重，手机在同一页上挂两秒不会假报「进度」；
 *   - 按 totalPages 报缺页 ——「缺第 2 页」才是让人能把 3 页传输收完的句子。
 *
 * createBurstCollector() 是纯函数：给它 async decode(bmp) + feed(header,page,bmp) 就跑，
 * Node 也能跑 —— 这正是 tools/smoke-capture.mjs 用合成变形照片干的事。下面 DOM 那段加了
 * 守卫，Node 下导入零成本。
 */
import { decodeHeader } from '../core/frame.js';
// 下载名策略，与 app.js 共享（DEFECTS D62）。静态拼写 '../core/' 像上面那行一样：
// tools/smoke-capture.mjs 在 Node 里 load 这文件，静态 import 得能在源码树里解析；
// tools/build-web.mjs 复制到 dist 时把 '../core/' 改写成 './core/'。下面那几条 dynamic
// import('./core/...') 是反过来的 —— 它们只在 dist 里的浏览器跑，所以拼成 dist 需要的
// 形态。请勿「统一」两套拼法，都是承重的。
import { downloadName } from '../core/naming.js';
// 同一张 advice 表，CLI 和桌面页都引用。给拒收的帧挂上它，「画面里没有本工具的页」才
// 变成一句说出物理成因 + 怎么做的话（第 81 轮：手机路径是唯一把 reason 丢掉的那一条）。
import { advise } from '../core/decode/advice.js';

const GATE_DEFAULTS = { minMarkerPx: 14, minCoverage: 0.72, maxConsecutiveRejections: 40 };

/** 从解出来的页里读 pageIndex / totalPages / sessionId，调用方随便什么形状。 */
function locate(page) {
  let h = page.header || null;
  if (!h && page.headerBytes) {
    const r = decodeHeader(page.headerBytes);
    h = r && r.ok ? r.header : null;
  }
  if (!h || !Number.isInteger(h.pageIndex) || !Number.isInteger(h.totalPages)) {
    return { ok: false, reason: 'no-header' };
  }
  const session = h.sessionId
    ? Array.from(h.sessionId).map((b) => b.toString(16).padStart(2, '0')).join('')
    : 'unknown';
  return { ok: true, pageIndex: h.pageIndex, totalPages: h.totalPages, session, kind: h.kind };
}

export function createBurstCollector(opts = {}) {
  const gate = { ...GATE_DEFAULTS, ...(opts.gate || {}) };
  const decode = opts.decode;
  const feed = opts.feed;
  if (typeof decode !== 'function' || typeof feed !== 'function') {
    throw new TypeError('createBurstCollector needs decode(bmp) and feed(page,bmp)');
  }

  const sessions = new Map(); // session -> { totalPages, have:Set, pending:Promise }
  let current = null; // session id the collector is filling
  const stats = { frames: 0, accepted: 0, duplicates: 0, rejected: 0, byReason: {} };
  let rejectsInRow = 0;
  const counters = (reason) => {
    stats.rejected++;
    rejectsInRow++;
    stats.byReason[reason] = (stats.byReason[reason] || 0) + 1;
  };

  const progress = () => {
    if (!current) return { session: null, have: 0, total: 0, missing: [] };
    const s = sessions.get(current);
    const missing = [];
    for (let i = 0; i < s.totalPages; i++) if (!s.have.has(i)) missing.push(i);
    return { session: current, have: s.have.size, total: s.totalPages, missing };
  };

  async function addFrame(bmp) {
    stats.frames++;
    const boot = await decode(bmp);
    if (!boot || !boot.ok) {
      counters(boot && boot.reason ? boot.reason : 'decode-fail');
      const adv = advise({ stage: boot && boot.stage, reason: (boot && boot.reason) || 'decode-fail' });
      return { accepted: false, kind: 'no-page', reason: (boot && boot.reason) || 'decode-fail', advice: adv, progress: progress() };
    }
    const page = boot.page || boot;
    const loc = locate(page);
    if (!loc.ok) {
      counters(loc.reason);
      return { accepted: false, kind: 'no-header', reason: loc.reason, progress: progress() };
    }

    // 手机伸长臂拍的照片技术上能矫正、实际上没用：cell 点掉到采样地板下，ECC 开始把真
    // 信息当成错误擦掉。说「走近」而不是解出来再报失败。
    if (page.path === 'photo') {
      if (typeof page.markerPx === 'number' && page.markerPx < gate.minMarkerPx) {
        counters('marker-too-small');
        return { accepted: false, kind: 'too-far', reason: 'marker-too-small', hint: `角标只有 ${page.markerPx.toFixed(0)}px：把手机靠近一点，让四个角标都进画面。`, progress: progress() };
      }
      if (typeof page.coverage === 'number' && page.coverage < gate.minCoverage) {
        counters('low-coverage');
        return { accepted: false, kind: 'partial', reason: 'low-coverage', hint: `页面只占画面 ${(page.coverage * 100).toFixed(0)}%：退半步把整页拍进去。`, progress: progress() };
      }
    }

    // 一次只跑一传输：出现另一个 session 的页不是进度，是两个文件混在一起，assembler
    // 会（正确地）拒绝合上。
    if (current && loc.session !== current) {
      counters('other-session');
      return { accepted: false, kind: 'other-session', reason: 'other-session', hint: '这批还没收完，画面里出现了另一次传输的页（会话号不同）。', progress: progress() };
    }
    if (!current) {
      current = loc.session;
      sessions.set(current, { totalPages: loc.totalPages, have: new Set() });
    }
    const s = sessions.get(current);
    if (loc.totalPages !== s.totalPages) {
      counters('total-mismatch');
      return { accepted: false, kind: 'conflict', reason: 'total-mismatch', hint: `这页声明共 ${loc.totalPages} 页，本批已记录 ${s.totalPages} 页：不是同一批。`, progress: progress() };
    }
    if (s.have.has(loc.pageIndex)) {
      stats.duplicates++;
      return { accepted: false, kind: 'duplicate', pageIndex: loc.pageIndex, progress: progress() };
    }

    let res;
    try {
      res = await feed(page, bmp);
    } catch (e) {
      counters('feed-threw');
      return { accepted: false, kind: 'error', reason: e.message, progress: progress() };
    }
    if (!res || (!res.ok && !res.duplicate)) {
      counters((res && res.reason) || 'feed-rejected');
      const adv = advise({ stage: 'assemble', reason: (res && res.reason) || 'feed-rejected' });
      return { accepted: false, kind: 'rejected', reason: (res && res.reason) || 'feed-rejected', advice: adv, pageIndex: loc.pageIndex, progress: progress() };
    }
    s.have.add(loc.pageIndex);
    stats.accepted++;
    rejectsInRow = 0;
    const p = progress();
    return { accepted: true, kind: 'page', pageIndex: loc.pageIndex, path: page.path || 'fast', markerPx: page.markerPx ?? null, coverage: page.coverage ?? null, progress: p, complete: p.missing.length === 0 };
  }

  return {
    addFrame,
    progress,
    stats,
    /** 没缺页就别再问相机了，调用方自己关流。 */
    done: () => !!current && progress().missing.length === 0,
    /** 连续一段不可用就放手，附上主导 reason。 */
    stuck: () => rejectsInRow >= gate.maxConsecutiveRejections,
    reset: () => {
      sessions.clear();
      current = null;
      rejectsInRow = 0;
    },
  };
}

/* ----------------------------------------------------------------- DOM --------
 * 守卫同 web/sender.js：纯逻辑必须能在 Node 里 import，Node 里没相机也没 document。
 */
if (typeof document !== 'undefined' && typeof document.getElementById === 'function' && document.getElementById('burst')) {
  const $ = (id) => document.getElementById(id);
  const logEl = $('burst-log');
  // The same rule the single-shot section states up front (web/app.js), said here BEFORE the button is
  // pressed rather than only in the log afterwards: a page served over plain http on a LAN address is not a
  // secure context, so the camera API is not merely denied -- it is absent. No dialog will appear and there
  // is nothing to switch on in the phone's settings. Round 248: the user pressed the button, saw no prompt,
  // and had to ask how to enable it on iPhone and Android.
  {
    const note = $('burst-note');
    const canCamera = typeof navigator !== 'undefined' && !!navigator.mediaDevices && !!navigator.mediaDevices.getUserMedia;
    if (note) {
      note.textContent = canCamera
        ? '会请求摄像头权限；帧只在本机处理，不上传。'
        : '这个来源拿不到摄像头（浏览器只在 https 或 localhost 才给）：请用手机系统相机拍照后走上面的「选择文件」，或改用 https 的接收页。';
    }
  }
  const say = (m, cls = '') => {
    const d = document.createElement('span');
    if (cls) d.className = 'l' + (cls ? ' ' + cls : '');
    d.textContent = m + '\n';
    logEl.appendChild(d);
    logEl.scrollTop = logEl.scrollHeight;
  };

  $('burst').addEventListener('click', async () => {
    // 不是 'video'。index.html 里有两段 video，第 1 节单张拍照的那段在文档流上更靠前，
    // getElementById('video') 拿到的是它：连拍区的预览一片黑，帧是从 display:none 的
    // video 读出来的 —— 这事儿因浏览器而异，iOS Safari 不能指望它解。dist 已有「同页
    // id 不重复」护栏（tools/check-dist.mjs），这俩 id 不许被「统一」回去。
    const video = $('burst-video');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      say('这个来源拿不到摄像头 API（非 https 且非 file:// localhost）。请用手机系统相机拍照存成图片，再走文件选择解码。', 'bad');
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, focusMode: { ideal: 'continuous' } }, audio: false });
    } catch (e) {
      say(`摄像头被拒绝或不可用：${e.name} ${e.message}。改走「拍照存成 PNG → 文件选择」，解码不受影响。`, 'bad');
      return;
    }
    video.srcObject = stream;
    await video.play().catch(() => {});
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    setPill('burst-pill', '连拍中…', 'busy');
    $('burst-wrap').setAttribute('data-state', 'busy');
    say('连拍开始：把整页拍进画面，四角对齐；系统会自动挑帧，收满自动停。', 'hint');

    const { bootstrapDecode } = await import('./core/decode/bootstrap.js');
    const { TransferAssembler } = await import('./core/protocol.js');
    const { sha256Hex } = await import('./core/hash.js');
    // 手机连拍这条路也要能救回「被页内码拒绝」的页：与 app.js、CLI、G2 门限共用同一段仲裁逻辑
    // （docs/DEFECTS.md D51）。少改这一处，手机端就仍是旧读法。
    const { feedPageWithRecalibration } = await import('./core/decode/recalibrate.js');
    // 连拍区要有自己的口令。发送端（send.html 的 #spw）和本接收页的「文件选择」那半（#pass）都有，
    // 缺这一处的话，手机收到加密传输的所有页却没地方输密码 —— 而（D66 之前）消息会怪到「缺页」。
    // 连拍开始时读一次：assembler 合批时才派生 key，帧不留。
    const burstPass = $('burstpass');
    const asm = new TransferAssembler(burstPass && burstPass.value ? { passphrase: burstPass.value } : {});
    // 重读需要「这一帧认出来的几何」。addFrame 内部总是先 decode 再 feed、且逐帧 await，
    // 所以暂存本帧几何是精确的，不是取巧。
    let frameGeom = null;
    const collector = createBurstCollector({
      decode: async (bmp) => {
        const b = await bootstrapDecode(bmp, { maxAttempts: 24 });
        if (b.ok) frameGeom = b.geom;
        return b;
      },
      // assembler 住这里、不在 app.js 里：连拍会话不能依赖接收页内部（早期一稿 import 了一个
      // 不存在的模块，就是这么踩出来的）。
      feed: (page) => feedPageWithRecalibration(asm, page, { geom: frameGeom }).then((r) => r.fed),
    });

    let running = true;
    let last = 0;
    const step = async (ts) => {
      if (!running) return;
      if (ts - last > 220) {
        last = ts;
        const w = video.videoWidth || 0;
        const h = video.videoHeight || 0;
        if (w > 0 && h > 0) {
          canvas.width = w;
          canvas.height = h;
          ctx.drawImage(video, 0, 0, w, h);
          const img = ctx.getImageData(0, 0, w, h);
          const r = await collector.addFrame({ width: w, height: h, pixels: new Uint8Array(img.data.buffer) });
          if (r.kind === 'page') say(`第 ${r.pageIndex + 1} 页收到（${r.path}${r.markerPx ? ` · 角标 ${r.markerPx.toFixed(0)}px` : ''}）· 已有 ${r.progress.have}/${r.progress.total} · 缺 ${r.progress.missing.map((i) => i + 1).join(',') || '无'}`);
          else if (r.hint) say(r.hint, 'hint');
          else if (r.kind === 'duplicate') { /* 每秒几次，静默 */ }
          else if (r.kind === 'no-page' || r.kind === 'rejected') say(r.advice && (r.advice.zh || r.advice.cause) ? (r.advice.zh || `${r.advice.cause} → ${r.advice.do}`) : '画面里没有本工具的页（或太糊/太暗）', 'hint');
          $('burstprog').textContent = `已收 ${r.progress.have}/${r.progress.total || '?'} 页 · 缺 ${r.progress.missing.map((i) => i + 1).join(',') || '无'}`;
          if (r.complete) {
            say('页收齐了：正在组装……', 'hint');
            running = false;
            stream.getTracks().forEach((t) => t.stop());
            const out = asm.result;
            if (!out) {
              if (asm.needPassphrase) {
                // 页都收齐，所以「未知原因」或「缺页」会把用户送去找别的东西（D66）。
                // 不写 markdown：say() 走 textContent。
                say('页收齐了，但这批是加密传输，而「口令」框是空的：填入口令后按「开始连拍」重来一次。没有写出任何文件。', 'bad');
                say('如实说清代价：连拍不留已解出的页（在手机上常驻每页的判读结果太贵），所以这次要重拍 —— 下次先填口令再按开始。', 'hint');
                setPill('burst-pill', '需要口令', 'err');
                $('burst-wrap').setAttribute('data-state', 'err');
              } else {
                say(`组装失败：${asm.error || '未知原因'}（页收齐但内容不完整，勿当作成功）`, 'bad');
                setPill('burst-pill', '未完成', 'err');
                $('burst-wrap').setAttribute('data-state', 'err');
              }
            } else {
              const a = document.createElement('a');
              const dg = sha256Hex(out);
              // 默认名还是从字节算：页头没名字字段，其他名字都是页面撑不住的承诺。
              // 填名字是可选，改的不是解出来的内容 —— 在手机上它就是「能不能被应用打开」
              // 的差别，因为 handler 来自扩展名（DEFECTS D62）。策略在 core/naming.js，
              // 与 app.js 共享、单测钉住；这里不即兴取名。
              const nameEl = $('burstname');
              const name = downloadName({ byteLength: out.length, sha256Hex: dg, userText: nameEl ? nameEl.value : '' });
              // Blob + createObjectURL：本页桌面那段（app.js: new Blob([asm.result]) + URL.createObjectURL）
              // 已经用同样的机制发文件。这条路以前是把 bytes 经 btoa + 分块 String.fromCharCode 编
              // 成 data: URL 再用 `download` —— 在手机平台上最不被浏览器当回事，刚好卡在「解出来了
              // 拿不走」那一步（要拿走的最后一步）。**不是**说 blob: 在每台手机上验过：两种机制都
              // 还没在这台机器的真浏览器上走过，G4/G9 的清单就是要在真手机/真浏览器上点一次。这里
              // 只保证「一个页面不再两种走法」。不是 D63 的反转：D63 记的是发送端 data: URL（最大
              // 63 MB 的产物，send.html 的 CSP），那条没动；这里载荷被协议封顶在 ~1.52 MB。
              // 不主动 revokeObjectURL：a.click() 之后立刻 revoke 在某些浏览器会跟下载抢，一次连
              // 拍一个 blob 不值得冒那个险。
              const blob = new Blob([out], { type: 'application/octet-stream' });
              a.href = URL.createObjectURL(blob);
              a.download = name;
              document.body.appendChild(a);
              a.click();
              a.remove();
              say(`完成：${out.length.toLocaleString()} B · SHA-256 ${dg} · 已按「${name}」下载（页头没有文件名字段：留空时名字由摘要导出，填了就按你填的存；手机要靠扩展名才知道用什么打开）`, 'ok');
              setPill('burst-pill', '完成', 'ok');
              $('burst-wrap').setAttribute('data-state', 'ok');
            }
            return;
          }
        }
      }
      if (collector.stuck()) {
        say('连续几十帧都不合格，先停下来：检查光照（避免反光）、把四个角标都拍进画面、手机稳一点。', 'bad');
        running = false;
        stream.getTracks().forEach((t) => t.stop());
        setPill('burst-pill', '已停止', 'err');
        $('burst-wrap').setAttribute('data-state', 'err');
        return;
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
    $('burststop').hidden = false;
    $('burststop').onclick = () => {
      running = false;
      stream.getTracks().forEach((t) => t.stop());
      say('已手动停止。', 'hint');
      setPill('burst-pill', '已停止', 'warn');
      $('burst-wrap').setAttribute('data-state', 'warn');
    };
  });

  // pill 状态联动：找到所属 card 打 data-state。
  function setPill(id, text, state) {
    const p = $(id);
    if (!p) return;
    p.textContent = text;
    if (state) {
      let n = p.parentElement;
      while (n && n !== document.body) {
        if (n.classList && n.classList.contains('card')) { n.setAttribute('data-state', state); break; }
        n = n.parentElement;
      }
    }
  }
}
