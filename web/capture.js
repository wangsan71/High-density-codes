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
      return { accepted: false, kind: 'no-page', reason: (boot && boot.reason) || 'decode-fail', progress: progress() };
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
      return { accepted: false, kind: 'rejected', reason: (res && res.reason) || 'feed-rejected', pageIndex: loc.pageIndex, progress: progress() };
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
    const video = $('video');
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
    const asm = new TransferAssembler({});
    const collector = createBurstCollector({
      decode: (bmp) => bootstrapDecode(bmp, { maxAttempts: 24 }),
      // The assembler lives here, not in app.js: a burst session must not depend on the
      // receiver page's internals (an earlier draft imported a module that does not exist).
      feed: (page) => asm.feed({ levels: page.levels, header: page.headerBytes, channelMissing: page.colourAlive ? [] : ['colour'] }),
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
          else if (r.kind === 'no-page') say('画面里没有本工具的页（或太糊/太暗）', 'hint');
          $('burstprog').textContent = `已收 ${r.progress.have}/${r.progress.total || '?'} 页 · 缺 ${r.progress.missing.map((i) => i + 1).join(',') || '无'}`;
          if (r.complete) {
            say('页收齐了：正在组装……', 'hint');
            running = false;
            stream.getTracks().forEach((t) => t.stop());
            const out = asm.result;
            if (!out) {
              say(`组装失败：${asm.error || '未知原因'}（页收齐但内容不完整，勿当作成功）`, 'bad');
            } else {
              let s = '';
              for (let i = 0; i < out.length; i += 0x8000) s += String.fromCharCode.apply(null, out.subarray(i, i + 0x8000));
              const a = document.createElement('a');
              const dg = sha256Hex(out);
              a.href = `data:application/octet-stream;base64,${btoa(s)}`;
              a.download = `pskt-${out.length}B-${dg.slice(0, 12)}.bin`;
              document.body.appendChild(a);
              a.click();
              a.remove();
              say(`完成：${out.length.toLocaleString()} B · SHA-256 ${dg}（文件名由摘要导出，因为没有文件名字段）`, 'ok');
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
