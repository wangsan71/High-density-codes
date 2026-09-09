/**
 * PSKT receiver -- browser shell. Contains no decoding logic of its own: every bit of it
 * is in ../core (the same modules the CLI and the independent Python reference use), so
 * the web path cannot quietly become a second, easier-to-fool implementation.
 *
 * Nothing here reaches the network. There is no fetch() except for the selftest asset
 * served from this same origin, no analytics, no font, no CDN, and the CSP header in
 * index.html (default-src 'self') is what makes that a machine-checked claim rather than
 * a promise -- tools/check-dist.mjs asserts both.
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
// The download-name policy (DEFECTS D62): shared with capture.js and the CLI's users, pure, and pinned
// by tests/unit/naming.test.mjs. Not improvised here, because a `download` attribute built from typed
// text has to come out a single safe path component on every platform.
import { downloadName } from './core/naming.js';

const $ = (id) => document.getElementById(id);
const logEl = $('log');
const log = (m) => { logEl.textContent += m + '\n'; logEl.scrollTop = logEl.scrollHeight; };
const setStatus = (m) => { $('status').textContent = m; };

for (const id of PROFILE_IDS) {
  const o = document.createElement('option');
  o.value = id;
  // Same label policy as the sender page (core/profiles.js), so the receiver's dropdown carries
  // the D49 warning and the phone hint too -- it used to hand-roll a label and show neither.
  o.textContent = profileOptionLabel(id, PROFILES[id]);
  $('profile').appendChild(o);
}

const files = [];
$('files').addEventListener('change', (e) => {
  files.length = 0;
  files.push(...Array.from(e.target.files || []));
  $('go').disabled = files.length === 0;
  setStatus(files.length ? `${files.length} 个文件待还原` : '等待文件');
});

let busy = false;
$('go').addEventListener('click', () => { if (!busy) run(); });

/**
 * Naming inputs of the last completed transfer, and the one listener that uses them.
 *
 * Registered here, once, because the alternative -- adding an `input` listener inside run() -- leaks
 * one listener (and its closure over the whole assembled payload) per transfer (DEFECTS D73).
 * `null` until the first transfer completes, so typing before then changes nothing.
 */
let currentNaming = null;
const applyName = () => {
  if (!currentNaming) return;
  const name = downloadName({ ...currentNaming, userText: $('outname').value });
  $('download').download = name;
  $('outname-note').textContent = `将保存为：${name}`;
};
$('outname').addEventListener('input', applyName);

async function run() {
  busy = true;
  $('out').hidden = true;
  logEl.textContent = '';
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
      bmp = decodePNG(new Uint8Array(await f.arrayBuffer()));
    } catch (e) {
      log(`  ${f.name}: 不是能读的 PNG（${e.message}）—— 只支持 PNG，TIFF 请先转 PNG`);
      continue;
    }
    const t0 = performance.now();
    const boot = await bootstrapDecode(bmp, {
      ...hints,
      onAttempt: (a) => log(`    试 ${a.profileId}@${a.dpi}/${a.paletteId}${a.nozzle ? '/' + a.nozzle : ''} -> ${a.stage}/${a.reason} [${a.ms}ms]`),
    });
    if (!boot.ok) {
      log(`  ${f.name}: 认不出来（试了 ${boot.tried ?? boot.attempts.length} 组候选 · ${Math.round(performance.now() - t0)}ms）`);
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
      log(`      装配拒绝：${fed.reason}`);
      if (resc.retried) log(`      已按本页实测的 ρ 切点重读过一次（切点 ${resc.estimate?.cut?.toFixed(4)}、改了 ${resc.changed} 格），仍被本页的码拒绝（${resc.secondReason}）⇒ 不写盘`);
      continue;
    }
    if (resc.retried) {
      log(`      救回：匹配滤波的读法被页内码拒绝，改用按本页实测 ρ 标定的切点重读（切点 ${resc.estimate.cut.toFixed(4)}、两簇 ${resc.estimate.m0.toFixed(3)}/${resc.estimate.m1.toFixed(3)}、改了 ${resc.changed} 格）`);
      log('      接受它的理由是页内 RS + 帧 CRC + 摘要都过了，不是那个切点本身');
    }
    accepted++;
  }
  setStatus('核对摘要…');
  if (!asm.result) {
    const p = asm.progress;
    if (asm.needPassphrase) {
      // Every page arrived, so "仍缺料" would send the user back to the printer for nothing (D66).
      // No markdown here: log() assigns textContent, so asterisks would show up literally.
      log(`未完成：页收齐了（数据页 ${p.dataHave}/${p.dataNeed}），但这批是加密传输，而第 2 节的「口令」是空的。`);
      log('      缺的不是页、是口令：在上面填入口令，再按一次「3 · 开始还原」就行 —— 已选的文件还在，不必重新选，更不必重印重扫。');
      log('      没有写出任何文件：没有钥匙就没有明文，也就无从核对页头声明的摘要。');
      busy = false;
      setStatus('需要口令');
      return;
    }
    log(p.noSession
      ? '未完成：没有任何一页的头能读出来 —— 这是整批失败，缺页校验也帮不上（几何还没认出来）'
      : `未完成（数据页 ${p.dataHave}/${p.dataNeed}）：${asm.error || '仍缺料'}`);
    log('没有写出任何文件：本工具从不产出半成品');
    busy = false;
    setStatus('未完成');
    return;
  }
  const digest = sha256Hex(asm.result);
  const blob = new Blob([asm.result], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  $('download').href = url;
  // Named by its own digest, not by a filename: the printed header carries no name field
  // (frame.js:14-28 lists magic..digest..crc16 and nothing else), so the only honest
  // default is a name derived from the bytes themselves. That default is unchanged and
  // tests/unit/naming.test.mjs pins it byte for byte. What changed is the second half of
  // the old comment, "the user renames it after": on a phone that rename has to happen
  // inside the OS file manager, and until it does nothing will open the file, because iOS
  // and Android pick the handler from the extension (DEFECTS D62). So the user can type a
  // name here instead. The policy that turns typed text into one safe path component is
  // core/naming.js, shared with capture.js. The note says which name will be used, since a
  // download whose name the user cannot see is a download the user cannot find afterwards.
  // The listener is registered once at module load (below), not here: registering it inside run()
  // added one more listener per transfer, each closing over that run's asm/digest (DEFECTS D73).
  // The visible effect was a leak, not a wrong name -- listeners fire in registration order, so the
  // newest one always won -- but stale closures holding a whole assembled payload are not free.
  currentNaming = { byteLength: asm.result.length, sha256Hex: digest };
  applyName();
  $('result-line').textContent = `已逐字节还原：${asm.result.length} 字节 · SHA-256 ${digest.slice(0, 16)}…（与页头声明摘要一致才走到这里）· ${accepted} 页被接受`;
  $('out').hidden = false;
  log(`完成：${asm.result.length} 字节，摘要核对通过`);
  busy = false;
  setStatus('完成');
}

function adviseOr(reason, fallback) {
  try {
    return advise({ stage: 'markers', reason });
  } catch {
    // advice.js maps a fixed reason set; an unmapped reason must not take the whole
    // readout path down with it -- the point of the log is that it always says something.
    return { cause: fallback, do: '换一组候选（剖面/dpi/色板）重试，或改用 CLI 的 receive 带 manifest 定位。' };
  }
}

/* ---- camera: only where it can legally work, and say so where it cannot ----
 * `file://` counts as a secure context in Chrome, so isSecureContext alone is the wrong
 * test to print: the page would claim "not a secure context" while the real reason is an
 * opaque origin (no SW registration possible, and getUserMedia policy varies by browser).
 * Name the protocol, not a guess about it. */
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
            log('已抓到一帧，开始还原。');
            run();
          } catch (e) {
            log(`抓帧失败：${e.message}`);
          }
        }, 'image/png');
      };
    } catch (e) {
      log(`摄像头不可用：${e.name} ${e.message}`);
    }
  });
}

/* ---- service worker: offline precache, only where it is allowed ---- */
if ('serviceWorker' in navigator && secure) {
  navigator.serviceWorker.register('./sw.js').then(
    () => log('离线缓存已就绪（下次断网也能还原）。'),
    (e) => log(`Service Worker 注册失败：${e.message}（不影响本次还原）`),
  );
}

/* ---- ?selftest=1 lives in its own entry (web/selftest-page.js), loaded by index.html.
 * It is deliberately NOT imported from here: selftest.js uses dynamic import() on
 * purpose so the 200 KB conformance vector document is fetched only when a self-test is
 * actually requested, and tools/build-web.mjs refuses to bundle dynamic imports rather
 * than guess at them. Bundling it would have meant either weakening the selftest or
 * weakening the bundler -- both wrong. ---- */
