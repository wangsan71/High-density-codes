#!/usr/bin/env node
/**
 * Does a curled sheet break today's decoder, and at how many pixels of bend?
 *
 * Why measure this before building anything: PLAN section on geometry calls for a
 * double-frequency alignment comb along all four edges to recover sub-pixel grid phase
 * (recorded as D21: never implemented). The decoder already has (a) a four-corner fiducial
 * homography, which absorbs translation, rotation, uniform and differential scale, shear
 * and perspective -- six affine degrees plus the two projective ones -- and (b) a per-cell
 * +/-1 px integer search inside the matched filter. The only common physical case those
 * cannot express is out-of-plane bend: a lifted middle or a rolled sheet shifts each row by
 * a different amount, which no single homography can follow. So the comb's value is exactly
 * the curl case, and the right question is quantitative -- at what bend does the current
 * pipeline actually start failing, and does it fail as a clean refusal or as a wrong read?
 *
 * The failure *mode* matters more than the rate here. This project tolerates a page it
 * cannot read (it asks for a re-shoot); it does not tolerate a page read wrongly. So the
 * probe reports, per severity, whether a recovered page's symbols match the ground truth
 * cell-for-cell, not merely whether a decode returned ok.
 *
 * Synthetic channel only: the warp is a first-order inverse of y + bend*sin(pi*x/W), the
 * sheet's own curve. It is not a substitute for G4's real photographs, and it will not be
 * cited as one -- it is a prior for deciding whether the comb earns its risk.
 *
 *   node tools/probe-curl-tolerance.mjs [--page 0] [--down 2] [--bend 0,2,6,12,24]
 */
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(join(ROOT, p)).href);
const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const pageIndex = Number(opt('--page', 0));
const down = Number(opt('--down', 2));
const bends = String(opt('--bend', '0,2,6,12,24')).split(',').map(Number);

const { encodeTransfer } = await imp('core/protocol.js');
const { pageLayout } = await imp('core/render/layout.js');
const { renderPageBitmap, echoBitsOf } = await imp('core/render/raster.js');
const { bootstrapDecode } = await imp('core/decode/bootstrap.js');
const { sampleBilinear } = await imp('core/decode/transform.js');
const { homographyFromQuad } = await imp('core/decode/transform.js');

const raw = new Uint8Array(1024).map((_, i) => (i * 151 + 11) & 0xff);
const t = await encodeTransfer(raw, { profile: 'P-M1-300' });
const dpi = 300;
const layout = pageLayout(t.geom, dpi, { sheetMm: t.geom.sheetMm });
const src = renderPageBitmap({ geom: t.geom, levels: t.pages[pageIndex].levels, layout, palette: 'PAPER1', echoBits: echoBitsOf(t.pages[pageIndex].header) });
const ch = Math.round(src.pixels.length / (src.width * src.height));
const W = Math.floor(src.width / down);
const H = Math.floor(src.height / down);
const rot = (Number(opt('--rot', 1.2)) * Math.PI) / 180; // a phone is never perfectly square
const cosR = Math.cos(rot);
const sinR = Math.sin(rot);

/** page px -> photo px: downscale, bend the sheet, rotate about the centre. */
function forward(x, y, bend) {
  const bx = x + bend * Math.sin((Math.PI * x) / src.width) * (y / src.height);
  const by = y + bend * Math.sin((Math.PI * x) / src.width);
  const cx = W / 2;
  const cy = H / 2;
  const px = (bx / down - cx) * cosR - (by / down - cy) * sinR + cx;
  const py = (bx / down - cx) * sinR + (by / down - cy) * cosR + cy;
  return [px, py];
}

function shoot(bend) {
  const out = new Uint8Array(W * H * ch);
  let oor = 0; // pixels whose inverse map fell outside the page (clamped by the sampler)
  // White outside the sheet: a real photo has a background, and a detector that keys on the
  // fiducial rings should have to earn its answer rather than get a padded page edge.
  for (let c = 0; c < ch; c++) for (let i = 0; i < out.length; i += ch) out[i + c] = 255;
  // First-order inverse: the bend is small relative to the sheet, so inverting the
  // sinusoid by one Newton step is accurate to well under a pixel of this probe's own grid.
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      let x = px * down;
      let y = py * down;
      for (let it = 0; it < 3; it++) {
        const [qx, qy] = forward(x, y, bend);
        x += (px - qx) * down;
        y += (py - qy) * down;
      }
      // sampleBilinear returns {values:[...], inside:boolean}: the first draft read v[c]
      // from that object, got undefined, wrote 0 -- and produced an all-black "photo" whose
      // refusal the decoder was right to give. `inside` doubles as the clipping meter.
      const smp = sampleBilinear(src.pixels, src.width, src.height, ch, x, y);
      if (!smp.inside) oor++;
      const o = (py * W + px) * ch;
      for (let c = 0; c < ch; c++) out[o + c] = smp.values[c];
    }
  }
  return { width: W, height: H, dpi: Math.round(dpi / down), pixels: out, _oor: oor };
}

console.log(`page ${pageIndex} of ${t.pages.length}: ${src.width}x${src.height} @${dpi}dpi -> shot ${W}x${H} @${dpi / down}等效dpi (down ${down}), 旋转 ${(rot * 180) / Math.PI}°`);
console.log(`ground truth cells: ${t.pages[pageIndex].levels.length}; 弯曲量为页中部相对四角的附加起伏像素 (全分辨率等效)\n`);
// Instrument: the control depends on what the probe claims to do. At down=1 with no
// rotation and no bend the "photo" must be a byte-identical copy of the rendered page --
// anything else means the sampler is broken (it did, once: sampleBilinear returns
// {values,inside} and reading v[c] produced an all-black frame the decoder rightly
// refused). At down>1 identity is not expected (resampling is the point), so the control
// becomes weaker but still real: the flat, merely downscaled sheet must still decode.
// A control that cannot pass must not be reported as a measurement.
const controlIsCopy = down === 1 && rot === 0;
{
  const p = shoot(0);
  let diff = 0;
  if (p.width === src.width && p.height === src.height) {
    for (let i = 0; i < p.pixels.length; i++) if (p.pixels[i] !== src.pixels[i]) diff++;
  } else diff = -1;
  const r = await bootstrapDecode(p, { maxAttempts: 24 });
  if (controlIsCopy) {
    console.log(`CONTROL (byte-identity, required at down=1/rot=0): ${p.width}x${p.height}, differing bytes = ${diff}${diff === 0 ? ' ✓' : ' ✗ 探针自己就不恒等'}`);
  } else {
    console.log(`CONTROL (resampling, identity not expected at down=${down}): ${src.width}x${src.height} -> ${p.width}x${p.height} @${p.dpi}dpi · decode ${r.ok ? r.profileId + '@' + r.dpi + '/' + r.paletteId : 'REFUSED ' + r.reason}`);
  }
  if (!r.ok) {
    // Which stage kills each candidate -- 'markers' means the sheet was not even found,
    // 'readout' means it was found and rectified but the cells did not resolve. Those are
    // different defects with different fixes, and the earlier draft could not tell them
    // apart, which is how a resolution limit got misfiled as "no scale search".
    const tally = new Map();
    for (const a of r.attempts || []) {
      const k = `${a.stage || a.reason || '?'}${a.reason ? '/' + a.reason : ''}`;
      tally.set(k, (tally.get(k) || 0) + 1);
    }
    console.log(`  control decode REFUSED: ${r.reason} (候选 ${r.attempts?.length ?? 0}) · 阶段分布 ${[...tally].map(([k, n]) => `${k}×${n}`).join(' ')}`);
  }
  console.log('');
}
const rows = [];
for (const bend of bends) {
  const t0 = Date.now();
  const photo = shoot(bend);
  const boot = await bootstrapDecode(photo, { maxAttempts: 24 });
  const ms = Date.now() - t0;
  if (!boot.ok) {
    rows.push({ bend, ok: false, reason: boot.reason, attempts: boot.attempts.length, ms });
    console.log(`  bend ${String(bend).padStart(3)}px  REFUSED  ${boot.reason} (候选 ${boot.attempts.length} · ${ms} ms)`);
    continue;
  }
  const got = boot.page.levels;
  const wantLevels = t.pages[pageIndex].levels;
  let same = 0;
  const n = Math.min(got.length, wantLevels.length);
  for (let i = 0; i < n; i++) if (got[i] === wantLevels[i]) same++;
  rows.push({ bend, ok: true, same, n, attempts: boot.attemptCount, geom: `${boot.profileId}@${boot.dpi}/${boot.paletteId}`, ms });
  console.log(
    `  bend ${String(bend).padStart(3)}px  DECODED ${boot.profileId}@${boot.dpi}/${boot.paletteId}  符号一致 ${same}/${n} = ${((same / n) * 100).toFixed(2)}%  (候选 ${boot.attemptCount} · ${ms} ms)${
      same === n ? ' ✓' : '  ✗✗ 读错了但返回成功'
    }`,
  );
}
const refused = rows.filter((r) => !r.ok).map((r) => r.bend);
const wrong = rows.filter((r) => r.ok && r.same !== r.n).map((r) => r.bend);
const worked = rows.filter((r) => r.ok && r.same === r.n).map((r) => r.bend);
console.log('');
console.log(`完全读对的最高弯曲: ${worked.length ? Math.max(...worked) + 'px' : '无'}`);
console.log(`开始拒绝的最低弯曲: ${refused.length ? Math.min(...refused) + 'px' : '本表内未出现'}`);
console.log(`错误读取(返回成功但符号不符)的弯曲: ${wrong.length ? wrong.join(',') + 'px  ✗✗ 这是最坏的一种' : '无 ✓'}`);
// A broken instrument must not be allowed to file a report. The bend=0 row is the control:
// if a perfectly flat, merely rotated and downscaled sheet does not decode byte-for-cell,
// then every conclusion below would be describing the probe, not the decoder. (The first
// run of this file did exactly that -- it printed a confident conclusion over a table whose
// control row had failed, because the synthetic shot's dpi was labelled 600 instead of 150.)
const control = rows.find((r) => r.bend === 0);
if (!control || !control.ok || control.same !== control.n) {
  console.log('');
  console.log('CONTROL FAILED: bend=0 都没有逐格读对 ⇒ 本表无结论（先修探针，再谈判据）。');
  console.log(`  control row: ${JSON.stringify(control)}`);
  process.exitCode = 2;
} else if (wrong.length) {
  console.log('\n结论（限定在页级）：存在"卷曲导致页级读出返回 ok 但符号大面积不符"的档位。');
  console.log('  这不等于误接受：页级 ok 之上还有页间/页内 RS 与末端 SHA-256 摘要，误接受由那条链定夺（G5 已测 10000 次篡改 0 误接受 ✓）。');
  console.log('  本探针不主张任何传输级结论 —— 那要把整盘页喂进组装/校验路径重测（docs/DEFECTS.md D25）。');
} else {
  console.log('\n结论：本探针内卷曲只造成拒绝、不造成误读 ⇒ 梳子属鲁棒性收益，不应以改动采样路径的风险换取。');
}
