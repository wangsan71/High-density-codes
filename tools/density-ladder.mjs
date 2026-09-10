#!/usr/bin/env node
/**
 * tools/density-ladder.mjs -- 纸面密度阶梯：一张纸上量出"能印多细 / 能装多少"。
 *
 * 为什么需要它（PLAN v5 P0）：现在的容量数字全部来自 *模拟* 信道，真打印机 + 真扫描仪一次都没量过。
 * 而新目标（在越来越小的纸上装越来越多的数据）完全取决于一个物理事实：**在用户的机器上，
 * 模块最小能做到多小、误码率是多少**。这个工具就是量它的尺子。
 *
 * 设计取舍：阶梯页**不是**一次完整传输（不装帧头、不做 RS），只印已知的伪随机比特阵。
 * 这样读回来能直接算 **BER**，再由 BER 推出"加 20% 校验后还能不能用"，比造一个完整码页更快、
 * 也更容易看出是"哪个间距开始塌"。
 *
 *   node tools/density-ladder.mjs --make --out .tmp/ladder [--sheet A4|A5|2R|WxH] [--dpi 300] [--pitches 0.85,0.51,...]
 *   node tools/density-ladder.mjs --read <扫描目录> --spec .tmp/ladder/density-ladder.json
 *
 * 退出码：0 = 跑成了（**不是**判决）；2 = 参数/文件问题。读数结果由调用者解释。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import { planPage, PROFILES } from '../core/profiles.js';
import { pageLayout } from '../core/render/layout.js';
import { renderPageBitmap, renderSheetBitmap } from '../core/render/raster.js';
import { encodePNG } from '../core/render/png.js';
import { encodePDFDocument } from '../core/render/pdf.js';
import { decodePNG } from '../core/decode/png-read.js';
import { decodeTIFF } from '../core/decode/tiff-read.js';
import { findMarkers } from '../core/decode/fiducial.js';
import { canvasQuad, canvasToPhoto } from '../core/decode/warp.js';
import { homographyFromQuad, sampleBilinear } from '../core/decode/transform.js';

/** 默认阶梯：从今天的默认档间距一路细到 2R 才需要的间距。 */
const DEFAULT_PITCHES = [0.847, 0.508, 0.423, 0.339, 0.254, 0.169, 0.127, 0.102, 0.085];

const SHEETS = {
  A4: { w: 210, h: 297 },
  A5: { w: 148, h: 210 },
  '2R': { w: 63.5, h: 88.9 },
  Letter: { w: 215.9, h: 279.4 },
};

/**
 * 每个条带的比特序列：确定性 xorshift32（与页面尺寸无关，读写两侧各自复算，不占文件体积）。
 * 首 32 位不含全 0/全 1 长串，避免"看起来像空白条带"的假象。
 */
function bandBits(seed, n) {
  let x = (seed >>> 0) || 0x9e3779b9;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    out[i] = x & 1;
  }
  // 位置 i 处若与前一位相同则翻转：保证没有长同值串，肉眼也能看出条带确实印上了东西
  for (let i = 1; i < n; i++) if (out[i] === out[i - 1]) out[i] ^= 1;
  return out;
}

function parsePitches(s) {
  if (!s) return DEFAULT_PITCHES.slice();
  return String(s).split(',').map((v) => Number(v.trim())).filter((v) => Number.isFinite(v) && v > 0);
}

function sheetMmOf(arg) {
  if (!arg) return null;
  const key = String(arg);
  if (SHEETS[key]) return SHEETS[key];
  const m = /^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/i.exec(key);
  if (m) return { w: Number(m[1]), h: Number(m[2]) };
  throw new Error('--sheet must be A4, A5, 2R, Letter or WxH in mm, got ' + key);
}

/** 一条带的落位：在可用晶格矩形里自上而下切，条带之间留一条 cellPx 宽的白缝。 */
function planBands(rect, pitches, dpi) {
  const bands = [];
  const gut = Math.max(4, Math.round(dpi / 75));
  const each = Math.floor((rect.h - gut * (pitches.length - 1)) / pitches.length);
  let y = rect.y;
  for (let k = 0; k < pitches.length; k++) {
    const pitch = pitches[k];
    const cellPx = Math.max(2, Math.round((pitch / 25.4) * dpi));
    const cols = Math.floor(rect.w / cellPx);
    const rows = Math.floor(each / cellPx);
    bands.push({
      index: k, pitchMmRequested: pitch, dpi,
      cellPx, pitchMm: (cellPx / dpi) * 25.4,
      x: rect.x + Math.floor((rect.w - cols * cellPx) / 2), y,
      cols, rows,
      wMm: ((cols * cellPx) / dpi) * 25.4, hMm: ((rows * cellPx) / dpi) * 25.4,
      seed: 0x51ed2701 + k * 2654435761,
      bits: cols * rows,
    });
    y += each + gut;
  }
  return bands;
}

function make(args) {
  const profileId = args.profile || 'P-MX-300-4';
  const prof = PROFILES[profileId];
  if (!prof) throw new Error('unknown profile ' + profileId);
  const dpi = args.dpi ? Number(args.dpi) : prof.dpi;
  const sheetMm = sheetMmOf(args.sheet || 'A4');
  const pitches = parsePitches(args.pitches);
  const geom = planPage(profileId, {});
  const layout = pageLayout(geom, dpi, { sheetMm });
  const blank = renderPageBitmap({ geom, levels: new Uint16Array(geom.totalCells), layout, palette: 'PAPER1', echoBits: null });
  const px = blank.pixels;
  const W = blank.width, H = blank.height;

  // 可用晶格矩形 = originPx .. originPx + cols*cellPx（角标与回显条都在它外面）
  const rect = {
    x: layout.originPx.x, y: layout.originPx.y,
    w: layout.cols * layout.cellPx, h: layout.rows * layout.cellPx,
  };
  const bands = planBands(rect, pitches, dpi);
  // Two requested pitches can land on the same cellPx (the pixel grid cannot express them).
  // Say so instead of printing the same band twice and calling it a ladder.
  const dupes = new Map();
  for (const b of bands) dupes.set(b.cellPx, (dupes.get(b.cellPx) || 0) + 1);
  for (const [cellPx, n] of dupes) {
    if (n > 1) {
      console.log('  NOTE ' + n + ' requested pitches collapse to ' + cellPx + 'px at ' + dpi + 'dpi (' + ((cellPx / dpi) * 25.4).toFixed(4) + 'mm): render again with a higher --dpi to resolve them');
    }
  }

  const paint = (x0, y0, n, rgb) => {
    for (let dy = 0; dy < n; dy++) {
      const y = y0 + dy;
      if (y < 0 || y >= H) continue;
      for (let dx = 0; dx < n; dx++) {
        const x = x0 + dx;
        if (x < 0 || x >= W) continue;
        const o = (y * W + x) * 4;
        px[o] = rgb[0]; px[o + 1] = rgb[1]; px[o + 2] = rgb[2]; px[o + 3] = 255;
      }
    }
  };

  for (const b of bands) {
    const bits = bandBits(b.seed, b.bits);
    for (let r = 0; r < b.rows; r++) {
      for (let c = 0; c < b.cols; c++) {
        if (bits[r * b.cols + c]) paint(b.x + c * b.cellPx, b.y + r * b.cellPx, b.cellPx, [0, 0, 0]);
      }
    }
  }

  const outDir = resolve(args.out || '.tmp/ladder');
  mkdirSync(outDir, { recursive: true });
  // PNG = the sheet canvas (paper + marks + code area); PDF = the code-area raster that carries
  // sheetMm, which is the shape encodePDFDocument expects (same pairing the CLI uses for pack.pdf).
  const sheetBitmap = blank.sheetMm ? renderSheetBitmap(blank) : blank;
  writeFileSync(join(outDir, 'density-ladder.png'), encodePNG(sheetBitmap));
  writeFileSync(join(outDir, 'density-ladder.pdf'), encodePDFDocument([blank.sheetMm ? blank : sheetBitmap]));
  const spec = {
    tool: 'density-ladder', version: 1,
    profile: profileId, dpi, sheetMm, sheetName: args.sheet || 'A4',
    layout: { width: layout.width, height: layout.height, originPx: layout.originPx, cellPx: layout.cellPx, cols: layout.cols, rows: layout.rows },
    bandRect: rect,
    bands,
    note: 'Print at 100% (no fit-to-page). Scan at 300/600/1200 dpi, colour, auto-crop OFF, and run --read.',
  };
  writeFileSync(join(outDir, 'density-ladder.json'), JSON.stringify(spec, null, 1));
  console.log('density-ladder: ' + sheetMm.w + 'x' + sheetMm.h + 'mm at ' + dpi + 'dpi, ' + bands.length + ' bands');
  for (const b of bands) {
    console.log('  band ' + b.index + '  pitch ' + b.pitchMm.toFixed(4) + 'mm (' + b.cellPx + 'px)  ' + b.cols + 'x' + b.rows + ' modules  ' + b.wMm.toFixed(1) + 'x' + b.hMm.toFixed(1) + 'mm');
  }
  console.log('  wrote ' + join(outDir, 'density-ladder.png') + ' and .pdf (print the PDF at 100%)');
  return 0;
}

/** 一条带里每个模块的深浅：取模块中心的小窗平均灰度。 */
/**
 * One module's grey level, sampled at the module CENTRE with bilinear interpolation.
 *
 * Sub-pixel matters here: at 2-3 px per module a half-pixel origin error puts the sample on the
 * module boundary and flips bits by itself. Greyscale of a whole window cannot fix that (the window
 * averages both states), so the sample point is interpolated and the caller searches fractional
 * offsets alongside whole-pixel ones. That makes a pristine re-render read as BER 0 instead of the
 * 1e-3 floor the first version showed -- a floor that would have been mistaken for physics.
 */
function moduleGray(rectified, b, c, r, ox = 0, oy = 0, fx = 0, fy = 0) {
  const { pixels, width, height } = rectified;
  const cx = b.x + c * b.cellPx + b.cellPx / 2 + ox + fx;
  const cy = b.y + r * b.cellPx + b.cellPx / 2 + oy + fy;
  const x0 = Math.floor(cx), y0 = Math.floor(cy);
  const tx = cx - x0, ty = cy - y0;
  const at = (x, y) => {
    const xx = Math.min(Math.max(x, 0), width - 1);
    const yy = Math.min(Math.max(y, 0), (height || Math.floor(pixels.length / (width * 4))) - 1);
    const o = (yy * width + xx) * 4;
    if (o + 2 >= pixels.length) return 255;
    return (pixels[o] + pixels[o + 1] + pixels[o + 2]) / 3;
  };
  const top = at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx;
  const bot = at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx;
  return top * (1 - ty) + bot * ty;
}

function readOne(bitmap, spec) {
  const found = findMarkers(bitmap, {});
  if (!found.ok) return { ok: false, reason: 'markers/' + found.reason };
  // Rebuild the real layout (rectifyPage needs the fiducial list to know the canvas frame),
  // from the profile and sheet the ladder was generated with.
  const geom = planPage(spec.profile, {});
  const layout = pageLayout(geom, spec.dpi, { sheetMm: spec.sheetMm });
  // Do NOT rectify-then-sample: that resamples the page onto the canvas first, and on 2-3 px
  // modules the second sampling lands each module a little differently -> a ~1e-3 error floor on a
  // PRISTINE render, which would have been mistaken for physics. Instead map each module centre
  // through the marker homography and sample the ORIGINAL image once (same math a real scan needs).
  const cw = canvasQuad(layout);
  const H = homographyFromQuad([cw.tl, cw.tr, cw.br, cw.bl], [found.quad.tl, found.quad.tr, found.quad.br, found.quad.bl]);
  if (!H) return { ok: false, reason: 'homography-degenerate' };
  const grey = (b, c, r, ox = 0, oy = 0, fx = 0, fy = 0) => {
    const x = b.x + c * b.cellPx + b.cellPx / 2 + ox + fx;
    const y = b.y + r * b.cellPx + b.cellPx / 2 + oy + fy;
    const p = canvasToPhoto(H, x, y);
    if (!p) return 255;
    const s = sampleBilinear(bitmap.pixels, bitmap.width, bitmap.height, 4, p.x, p.y).values;
    return (s[0] + s[1] + s[2]) / 3;
  };
  if (process.env.LADDER_DEBUG) {
    const cwq = canvasQuad(layout);
    const b0 = spec.bands[0];
    const p0 = canvasToPhoto(H, b0.x + b0.cellPx / 2, b0.y + b0.cellPx / 2);
    console.log('  DEBUG canvas tl', JSON.stringify(cwq.tl), 'quad tl', JSON.stringify(found.quad.tl));
    console.log('  DEBUG band0 first module canvas', (b0.x + b0.cellPx / 2), (b0.y + b0.cellPx / 2), '-> photo', JSON.stringify(p0), 'bitmap', bitmap.width + 'x' + bitmap.height);
    const s = sampleBilinear(bitmap.pixels, bitmap.width, bitmap.height, 4, p0.x, p0.y);
    console.log('  DEBUG sample', JSON.stringify(s));
  }
  const rows = [];
  for (const b of spec.bands) {
    // Whole-pixel origin error is the ruler's own noise floor: at 2-3 px per module a half-pixel
    // offset flips modules by itself. The real decoder searches for alignment, so the ruler must
    // too -- otherwise a pristine re-render would look like it had errors.
    const bitsPre = bandBits(b.seed, b.bits);
    let bestOx = 0, bestOy = 0, bestFx = 0, bestFy = 0, bestErr = Infinity;
    for (let oy = -3; oy <= 3; oy++) {
      for (let ox = -3; ox <= 3; ox++) {
        for (const fy of [0, 0.5]) {
          for (const fx of [0, 0.5]) {
            let wrong = 0, n = 0;
            for (let rr = 0; rr < b.rows; rr += 3) {
              for (let cc = 0; cc < b.cols; cc += 3) {
                const g = grey(b, cc, rr, ox, oy, fx, fy);
                if ((g < 128) !== (bitsPre[rr * b.cols + cc] === 1)) wrong++;
                n++;
              }
            }
            const err = n ? wrong / n : 1;
            if (err < bestErr) { bestErr = err; bestOx = ox; bestOy = oy; bestFx = fx; bestFy = fy; }
          }
        }
      }
    }
    const bits = bandBits(b.seed, b.bits);
    let dark = 0, light = 0, wrong = 0, n = 0;
    const samples = [];
    for (let rr = 0; rr < b.rows; rr++) {
      for (let cc = 0; cc < b.cols; cc++) {
        const g = grey(b, cc, rr, bestOx, bestOy, bestFx, bestFy);
        samples.push(g);
        n++;
      }
    }
    const sorted = samples.slice().sort((a, z) => a - z);
    const lo = sorted[Math.floor(n * 0.05)];
    const hi = sorted[Math.floor(n * 0.95)];
    const cut = (lo + hi) / 2;
    const span = hi - lo;
    let i = 0;
    for (let rr = 0; rr < b.rows; rr++) {
      for (let cc = 0; cc < b.cols; cc++) {
        const isDark = samples[i] < cut;
        if (samples[i] < cut) dark++; else light++;
        if (isDark !== (bits[i] === 1)) wrong++;
        i++;
      }
    }
    const ber = n ? wrong / n : 1;
    rows.push({
      index: b.index, pitchMm: b.pitchMm, cellPx: b.cellPx, cols: b.cols, rows: b.rows,
      align: { ox: bestOx, oy: bestOy, fx: bestFx, fy: bestFy },
      modules: n, dark, light, span, cut, wrong, ber,
      netBytesPerPage: Math.round((n * (1 - 0.2)) / 8),
      bitsPerMm2: b.wMm && b.hMm ? n / (b.wMm * b.hMm) : null,
    });
  }
  return { ok: true, rows };
}

function read(args) {
  const specPath = args.spec ? resolve(args.spec) : null;
  if (!specPath || !existsSync(specPath)) throw new Error('--read needs --spec <density-ladder.json>');
  const spec = JSON.parse(readFileSync(specPath, 'utf8'));
  const dir = resolve(args._[0] || '.');
  const files = statSync(dir).isDirectory()
    ? readdirSync(dir).filter((n) => /\.(png|tiff?)$/i.test(n)).sort().map((n) => join(dir, n))
    : [dir];
  if (!files.length) throw new Error('no PNG/TIFF in ' + dir);
  let any = false;
  for (const f of files) {
    const bytes = new Uint8Array(readFileSync(f));
    let bmp;
    try {
      bmp = /\.(tiff?)$/i.test(f) ? decodeTIFF(bytes).pages[0] : decodePNG(bytes);
    } catch (e) {
      console.log('  ' + basename(f) + ': not a readable image (' + e.message + ')');
      continue;
    }
    const res = readOne(bmp, spec);
    if (!res.ok) {
      console.log('  ' + basename(f) + ': ' + res.reason);
      continue;
    }
    any = true;
    console.log('  ' + basename(f) + '  (' + bmp.width + 'x' + bmp.height + ')');
    console.log('    band  pitch mm   px  modules   BER        net B/page   bit/mm2   usable');
    for (const row of res.rows) {
      const usable = row.ber < 0.0005 ? 'yes' : row.ber < 0.01 ? 'marginal' : 'no';
      console.log('    ' + String(row.index).padEnd(5) + ' ' + row.pitchMm.toFixed(4).padEnd(9) + ' ' + String(row.cellPx).padEnd(3) + ' ' +
        String(row.modules).padEnd(9) + ' ' + row.ber.toFixed(6).padEnd(10) + ' ' + String(row.netBytesPerPage).padEnd(12) + ' ' +
        (row.bitsPerMm2 ? row.bitsPerMm2.toFixed(1) : '-').padEnd(9) + ' ' + usable);
    }
  }
  if (!any) console.log('  nothing measured (no page registered)');
  console.log('  note: BER here is raw module error rate; a page also needs ~20% parity, so usable means BER well under ~1e-3');
  return 0;
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { const v = argv[++i]; if (v === undefined) throw new Error(a + ' needs a value'); return v; };
    if (a === '--make') out.make = true;
    else if (a === '--read') out.read = true;
    else if (a === '--out') out.out = next();
    else if (a === '--spec') out.spec = next();
    else if (a === '--profile') out.profile = next();
    else if (a === '--sheet') out.sheet = next();
    else if (a === '--dpi') out.dpi = next();
    else if (a === '--pitches') out.pitches = next();
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a.startsWith('-')) throw new Error('unknown option ' + a);
    else out._.push(a);
  }
  return out;
}

const USAGE = [
  'density-ladder -- 纸面密度阶梯：一张纸量出"能印多细 / 能装多少"',
  '',
  '  node tools/density-ladder.mjs --make --out .tmp/ladder [--sheet A4|A5|2R|WxH] [--dpi 300] [--pitches a,b,c]',
  '     生成一张阶梯页（PNG + 真尺寸 PDF）+ density-ladder.json。按 100% 打印（别选"适应页面"）。',
  '  node tools/density-ladder.mjs --read <扫描目录> --spec .tmp/ladder/density-ladder.json',
  '     读回扫描件：逐条带给 BER / 净 B per page / bit per mm2 / 可用性。',
  '',
  '  它印的是已知伪随机比特阵（不是完整传输），所以量的是**物理层误码率**：',
  '  BER 远低于 1e-3 才可能在加 20% 校验后仍可用。退出码 0 只表示"跑成了"，不是判决。',
].join('\n');

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(USAGE); process.exitCode = 0; }
  else if (args.make) process.exitCode = make(args);
  else if (args.read) process.exitCode = read(args);
  else { console.log(USAGE); process.exitCode = 2; }
} catch (e) {
  console.error('density-ladder: ' + e.message);
  process.exitCode = 2;
}
