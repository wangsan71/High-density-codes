/**
 * Phone burst capture: decide which camera frames are worth decoding, and stop when the
 * transfer is complete.
 *
 * What this module is NOT: it does not detect markers, rectify, or decode anything.
 * core/decode/page.js already does the photo path (marker quad -> rectifyPage -> cell
 * measurement) and reports `path:'photo'`, `markerPx` and `coverage` on the way out, and
 * core/decode/bootstrap.js identifies the geometry from the page itself. Re-implementing
 * that here would be a second source of truth for geometry, which is how this project
 * acquires bugs.
 *
 * What it IS -- the part a camera loop actually needs, and the part that can be tested
 * without a camera:
 *   - a quality gate that turns "markerPx too small" and "page not fully in frame" into
 *     instructions a human can follow (step closer, get the corners in view) instead of a
 *     silent failure;
 *   - dedupe by session + page index, so holding the phone over one page does not look
 *     like progress;
 *   - missing-page reporting from the declared totalPages, because "缺第 2 页" is what
 *     makes a 3-page transfer finishable by a person.
 *
 * createBurstCollector() is pure: give it an async decode(bmp) and a feed(header,page,bmp)
 * and it stays runnable under Node -- which is exactly what tools/smoke-capture.mjs does
 * with synthetic warped photos. The DOM half below is guarded so importing this file in
 * Node costs nothing.
 */
import { decodeHeader } from '../core/frame.js';
// Download-name policy, shared with app.js (DEFECTS D62). Static and spelled '../core/' like the import
// above: tools/smoke-capture.mjs loads this file from Node, so its static imports have to resolve in the
// source tree, and tools/build-web.mjs rewrites '../core/' to './core/' when it copies this file to
// dist. The dynamic './core/...' imports further down are the opposite case -- they only ever run in a
// browser, from dist, so they are spelled the way dist needs them. Do not "tidy" one set to match the
// other; both spellings are load-bearing.
import { downloadName } from '../core/naming.js';
// The same advice table the CLI and the desktop page use. Attaching it to a rejected frame is what
// turns "画面里没有本工具的页" into a sentence that names the physical cause and the fix (round 81:
// the phone path was the one place that threw the reason away).
import { advise } from '../core/decode/advice.js';

const GATE_DEFAULTS = { minMarkerPx: 14, minCoverage: 0.72, maxConsecutiveRejections: 40 };

/** Read pageIndex/totalPages/sessionId from a decoded page, whatever shape the caller has. */
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

    // A photo of a page held at arm's length is technically rectifiable and practically
    // useless: the cell dots fall under the sampling floor and ECC starts erasing real
    // information. Say "closer" rather than decoding it badly and reporting a failure.
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

    // One transfer at a time: a page from a different session is not progress, it is a mix
    // of two files, and the assembler would (correctly) refuse to close.
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
    /** Stop asking the camera once there is nothing missing; the caller closes the stream. */
    done: () => !!current && progress().missing.length === 0,
    /** Give up after a stretch of unusable frames, with the reason that dominated. */
    stuck: () => rejectsInRow >= gate.maxConsecutiveRejections,
    reset: () => {
      sessions.clear();
      current = null;
      rejectsInRow = 0;
    },
  };
}

/* ------------------------------------------------------------------ DOM wiring ----
 * Guarded for the same reason as web/sender.js: the pure logic above has to stay
 * importable under Node, where there is no camera and no document.
 */
if (typeof document !== 'undefined' && typeof document.getElementById === 'function' && document.getElementById('burst')) {
  const $ = (id) => document.getElementById(id);
  const logEl = $('burst-log');
  const say = (m, cls = '') => {
    const d = document.createElement('div');
    if (cls) d.className = cls;
    d.textContent = m;
    logEl.appendChild(d);
    logEl.scrollTop = logEl.scrollHeight;
  };

  $('burst').addEventListener('click', async () => {
    // Not 'video'. index.html carries two video elements and the single-shot one in section 1 comes
    // first in document order, so getElementById('video') handed this burst path THAT element: the
    // visible preview in the burst section stayed black while the frames were read from a
    // display:none video -- which is browser-dependent and not something iOS Safari can be relied on
    // to decode. Duplicate ids in the shipped pages are a build check now (tools/check-dist.mjs), so
    // this cannot quietly regress, and please do not "tidy" the two ids back into one.
    const video = $('burst-video');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      say('这个来源拿不到摄像头 API（非 https 且非 file:// localhost）。请用手机系统相机拍照存成图片，再走文件选择解码。', 'bad');
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, focusMode: { ideal: 'continuous' } }, audio: false });
    } catch (e) {
      say(`摄像头被拒绝或不可用：${e.name} ${e.message}。改走"拍照存成 PNG → 文件选择"，解码不受影响。`, 'bad');
      return;
    }
    video.srcObject = stream;
    await video.play().catch(() => {});
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    say('连拍开始：把整页拍进画面，四角对齐；系统会自动挑帧，收满自动停。', 'hint');

    const { bootstrapDecode } = await import('./core/decode/bootstrap.js');
    const { TransferAssembler } = await import('./core/protocol.js');
    const { sha256Hex } = await import('./core/hash.js');
    // 手机连拍这条路也要能救回「被页内码拒绝」的页：与 app.js、CLI、G2 门限共用同一段仲裁逻辑
    // （docs/DEFECTS.md D51）。少改这一处，手机端就仍是旧读法。
    const { feedPageWithRecalibration } = await import('./core/decode/recalibrate.js');
    // The burst section needs its own passphrase field. The sender page offers encryption (send.html
    // #spw) and the file-intake half of THIS page has #pass, so without it a phone could receive every
    // page of an encrypted transfer and still be unable to open it -- with nowhere to type the key, and
    // (before D66) a message blaming missing pages. Read once at burst start: the assembler derives the
    // key when the batch closes, and the collected frames are not kept afterwards.
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
      // The assembler lives here, not in app.js: a burst session must not depend on the
      // receiver page's internals (an earlier draft imported a module that does not exist).
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
          else if (r.kind === 'duplicate') { /* silent: this fires many times per second */ }
          else if (r.kind === 'no-page' || r.kind === 'rejected') say(r.advice && (r.advice.zh || r.advice.cause) ? (r.advice.zh || `${r.advice.cause} → ${r.advice.do}`) : '画面里没有本工具的页（或太糊/太暗）', 'hint');
          $('burstprog').textContent = `已收 ${r.progress.have}/${r.progress.total || '?'} 页 · 缺 ${r.progress.missing.map((i) => i + 1).join(',') || '无'}`;
          if (r.complete) {
            say('页收齐了：正在组装……', 'hint');
            running = false;
            stream.getTracks().forEach((t) => t.stop());
            const out = asm.result;
            if (!out) {
              if (asm.needPassphrase) {
                // Every page arrived, so "未知原因" or anything about missing pages would send the user
                // after the wrong thing (D66). No markdown: say() assigns textContent.
                say('页收齐了，但这批是加密传输，而「口令」框是空的：填入口令后按「开始连拍」重来一次。没有写出任何文件。', 'bad');
                say('如实说清代价：连拍不留已解出的页（在手机上常驻每页的判读结果太贵），所以这次要重拍 —— 下次先填口令再按开始。', 'hint');
              } else {
                say(`组装失败：${asm.error || '未知原因'}（页收齐但内容不完整，勿当作成功）`, 'bad');
              }
            } else {
              const a = document.createElement('a');
              const dg = sha256Hex(out);
              // The default name still comes from the bytes: the printed header has no name field, so
              // anything else would be a claim the pages cannot support. Typing a name is optional and
              // changes nothing about what was decoded -- but on a phone it is the difference between a
              // file that opens and one the OS cannot place, because the handler comes from the
              // extension (DEFECTS D62). Policy is core/naming.js, shared with app.js, unit-tested;
              // nothing here improvises a filename.
              const nameEl = $('burstname');
              const name = downloadName({ byteLength: out.length, sha256Hex: dg, userText: nameEl ? nameEl.value : '' });
              // Blob + createObjectURL: the same mechanism the desktop half of THIS page already ships
              // (app.js: new Blob([asm.result]) + URL.createObjectURL). It used to be a data: URL built
              // by btoa over a chunked String.fromCharCode loop -- the mechanism a browser is least
              // likely to honour for `download`, on the platform where downloads are most constrained,
              // for the last step of the phone path (decoding is worthless if the file cannot be
              // retrieved). This is NOT a claim that blob: is verified on every phone: neither mechanism
              // has been exercised in a real browser here, and the G4/G9 checklist says to check once on
              // a real phone that the file lands and opens. What it does claim is that one page no longer
              // saves two different ways. Not the D63 decision reversed either: D63 recorded the SENDER's
              // data: URL (up to 63 MB of artifacts, send.html's CSP) and that stays untouched in the G9
              // batch; this payload is capped by the protocol at ~1.52 MB.
              // Deliberately not revoked: revokeObjectURL right after a programmatic click races the
              // download in some browsers, and one blob per completed burst is not worth that risk.
              const blob = new Blob([out], { type: 'application/octet-stream' });
              a.href = URL.createObjectURL(blob);
              a.download = name;
              document.body.appendChild(a);
              a.click();
              a.remove();
              say(`完成：${out.length.toLocaleString()} B · SHA-256 ${dg} · 已按「${name}」下载（页头没有文件名字段：留空时名字由摘要导出，填了就按你填的存；手机要靠扩展名才知道用什么打开）`, 'ok');
            }
            return;
          }
        }
      }
      if (collector.stuck()) {
        say('连续几十帧都不合格，先停下来：检查光照（避免反光）、把四个角标都拍进画面、手机稳一点。', 'bad');
        running = false;
        stream.getTracks().forEach((t) => t.stop());
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
    };
  });
}
