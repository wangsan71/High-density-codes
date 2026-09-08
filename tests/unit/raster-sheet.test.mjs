/**
 * The raster half of DEFECTS D45: `--sheet` reached the PDF writer only, so the PNG a user printed
 * was a bare code area -- no margin, no crop marks, and the printer decided where on the paper it
 * landed. core/render/sheet.js is now the single source of that geometry and both writers call it.
 *
 * What is measured here rather than trusted:
 *   - the sheet bitmap really is the sheet, at the sheet's pixel size and dpi;
 *   - the code area lands centred, and its pixels are byte-for-byte the source (nothing smears);
 *   - the marks exist, and every mark pixel is OUTSIDE the content box -- ink the decoder was never
 *     told about is how a page stops decoding, so this is checked pixel by pixel, not by comment;
 *   - the stroke width cannot reach the content box, as arithmetic;
 *   - a degenerate sheet (no margin) draws nothing and changes nothing;
 *   - the PDF writer still reports the same sheet, via the MediaBox it writes uncompressed (its
 *     content stream is flated, so the CTM and the mark segments are pinned by
 *     tests/unit/pdf-truesize.test.mjs, which reads them out of the written bytes);
 *   - bad input is refused, including a sheet too small for the content.
 *
 * A synthetic bitmap is used on purpose: renderSheetBitmap's contract is about pixels and
 * millimetres, and building a whole transfer to test a blit would only hide the assertions behind
 * encoder setup. The end-to-end shape (a real `pskit send --sheet A4 --format png` writing
 * 2480x3508) is measured in docs/STATUS.md round 52, from the CLI itself.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderSheetBitmap } from '../../core/render/raster.js';
import { sheetPlacement, sheetMarks, MARK_MIN_MARGIN_MM, MARK_STROKE_MM } from '../../core/render/sheet.js';
import { encodePNG } from '../../core/render/png.js';
import { encodePDFDocument } from '../../core/render/pdf.js';
import { PT_PER_MM } from '../../core/render/units.js';

const DPI = 300;
const PX_PER_MM = DPI / 25.4;
const INK = [18, 18, 18]; // MACHINE_INK in core/render/raster.js
const PAPER = [252, 250, 246];

/** A code-area bitmap with a recognisable interior: a border of ink and a filled block off-centre. */
function fakePage(width, height, sheetMm) {
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const edge = x === 0 || y === 0 || x === width - 1 || y === height - 1;
      const blob = x > width * 0.6 && x < width * 0.75 && y > height * 0.2 && y < height * 0.4;
      const c = edge || blob ? INK : PAPER;
      pixels[o] = c[0];
      pixels[o + 1] = c[1];
      pixels[o + 2] = c[2];
      pixels[o + 3] = 255;
    }
  }
  return { width, height, pixels, dpi: DPI, substrate: PAPER, palette: 'PAPER1', sheetMm };
}

const contentMmOf = (bmp) => ({ w: bmp.width / PX_PER_MM, h: bmp.height / PX_PER_MM });

test('the sheet bitmap is the sheet: size, dpi, and the code area centred and untouched', () => {
  const bmp = fakePage(100, 80, [20, 17]);
  const out = renderSheetBitmap(bmp);
  const cm = contentMmOf(bmp);
  const pl = sheetPlacement(cm, { w: 20, h: 17 });

  assert.equal(out.width, Math.round(20 * PX_PER_MM), 'sheet width in px');
  assert.equal(out.height, Math.round(17 * PX_PER_MM), 'sheet height in px');
  assert.equal(out.dpi, DPI, 'dpi is carried through, so 100% printing still means true size');
  assert.deepEqual(out.contentOffsetPx, [Math.round(pl.txMm * PX_PER_MM), Math.round(pl.tyMm * PX_PER_MM)]);

  // The content region must be the source bitmap exactly: a blit that shifted by one pixel, or a
  // mark that landed inside, would show up here rather than in a scanner three steps later.
  const [ox, oy] = out.contentOffsetPx;
  for (let y = 0; y < bmp.height; y++) {
    for (let x = 0; x < bmp.width; x++) {
      const s = (y * bmp.width + x) * 4;
      const d = ((oy + y) * out.width + (ox + x)) * 4;
      for (let k = 0; k < 4; k++) {
        assert.equal(out.pixels[d + k], bmp.pixels[s + k], `content pixel ${x},${y} channel ${k} differs`);
      }
    }
  }
  // pageMm is the sheet and sheetMm is gone: that is what stops encodePDFDocument centring twice.
  assert.deepEqual(out.pageMm, { w: 20, h: 17 });
  assert.equal(out.sheetMm, undefined, 'a sheeted bitmap must not carry sheetMm or the PDF centres it again');
});

test('marks are painted, and not one mark pixel falls inside the content box', () => {
  const bmp = fakePage(100, 80, [20, 17]);
  const out = renderSheetBitmap(bmp);
  const m = sheetMarks(contentMmOf(bmp), { w: 20, h: 17 });
  assert.equal(out.markSegments, 16, 'four corner Ls (2 segments each) plus four crosses (2 each)');
  assert.equal(m.segments.length, 16);

  const [ox, oy] = out.contentOffsetPx;
  const isPaper = (o) => out.pixels[o] === PAPER[0] && out.pixels[o + 1] === PAPER[1] && out.pixels[o + 2] === PAPER[2];
  const isInk = (o) => out.pixels[o] === INK[0] && out.pixels[o + 1] === INK[1] && out.pixels[o + 2] === INK[2];

  let marginInk = 0;
  let insideSurprises = 0;
  for (let y = 0; y < out.height; y++) {
    for (let x = 0; x < out.width; x++) {
      const o = (y * out.width + x) * 4;
      const inContent = x >= ox && x < ox + bmp.width && y >= oy && y < oy + bmp.height;
      if (isInk(o)) {
        if (!inContent) marginInk++;
      } else if (!inContent && !isPaper(o)) {
        // Anything in the margin that is neither paper nor the mark ink is unexplained.
        insideSurprises++;
      }
    }
  }
  assert.ok(marginInk > 200, `marks must actually be painted, found ${marginInk} ink px in the margin`);
  assert.equal(insideSurprises, 0, 'the margin holds only paper and marks');
  assert.ok(out.markStrokePx >= 2, `a 1 px mark at 300 dpi is 0.08 mm and a scanner erases it (got ${out.markStrokePx})`);
});

test('the stroke cannot reach the content box, as arithmetic not as a comment', () => {
  for (const sheet of [[20, 17], [210, 297], [12, 10], [30, 25]]) {
    const bmp = fakePage(100, 80, sheet);
    const m = sheetMarks(contentMmOf(bmp), { w: sheet[0], h: sheet[1] });
    if (m.degenerate) continue;
    // The raster caps the stroke at 0.8 of the gap; half of it is what could reach inward.
    const strokeMm = Math.min(MARK_STROKE_MM, m.gapMm * 0.8);
    const reach = m.gapMm - strokeMm / 2;
    assert.ok(reach > 0, `sheet ${sheet}: a mark could touch the content box (gap ${m.gapMm} stroke ${strokeMm})`);
    for (const [x1, y1, x2, y2] of m.segments) {
      const xa = Math.min(x1, x2) - strokeMm / 2;
      const xb = Math.max(x1, x2) + strokeMm / 2;
      const ya = Math.min(y1, y2) - strokeMm / 2;
      const yb = Math.max(y1, y2) + strokeMm / 2;
      const overlapsContent = xb > m.txMm && xa < m.txMm + m.contentMm.w && yb > m.tyMm && ya < m.tyMm + m.contentMm.h;
      assert.equal(overlapsContent, false, `sheet ${sheet}: segment ${x1},${y1}-${x2},${y2} reaches the content box`);
      assert.ok(xa >= 0 && ya >= 0 && xb <= m.sheetMm.w && yb <= m.sheetMm.h, `sheet ${sheet}: a mark would be clipped by the paper edge`);
    }
  }
});

test('a degenerate sheet draws nothing and changes nothing', () => {
  const bmp = fakePage(100, 80, null);
  const cm = contentMmOf(bmp);
  const exact = renderSheetBitmap({ ...bmp, sheetMm: [cm.w, cm.h] });
  assert.equal(exact.markSegments, 0, 'no margin means nowhere to put a mark');
  assert.equal(exact.width, bmp.width);
  assert.equal(exact.height, bmp.height);
  assert.deepEqual(Array.from(exact.pixels), Array.from(bmp.pixels), 'a zero-margin sheet must be the code area, byte for byte');
  assert.ok(MARK_MIN_MARGIN_MM > 0 && MARK_MIN_MARGIN_MM < 0.2, 'the threshold is the PDFs 0.5 pt, expressed in mm');
});

test('the PDF writer reports the same sheet, read from the bytes it writes uncompressed', () => {
  const bmp = fakePage(100, 80, [20, 17]);
  const pdf = encodePDFDocument([{ width: bmp.width, height: bmp.height, pixels: bmp.pixels, dpi: bmp.dpi, sheetMm: bmp.sheetMm }]);
  const text = Buffer.from(pdf).toString('latin1');
  const box = /\/MediaBox \[0 0 ([0-9.]+) ([0-9.]+)\]/.exec(text);
  assert.ok(box, 'the page object is written uncompressed, so the MediaBox is readable');
  const pl = sheetPlacement(contentMmOf(bmp), { w: 20, h: 17 });
  // Same millimetres, same conversion the writer uses, so the two paths cannot disagree about paper.
  assert.equal(box[1], (Math.round(pl.sheetMm.w * PT_PER_MM * 100) / 100).toFixed(2), 'MediaBox width from the shared geometry');
  assert.equal(box[2], (Math.round(pl.sheetMm.h * PT_PER_MM * 100) / 100).toFixed(2), 'MediaBox height from the shared geometry');
  // Positive control: a geometry off by a millimetre must NOT match, or this assertion proves nothing.
  const wrong = (Math.round((pl.sheetMm.w + 1) * PT_PER_MM * 100) / 100).toFixed(2);
  assert.notEqual(box[1], wrong, 'control: the check must be able to fail');
});

test('the PNG that reaches the user carries the sheet size and dpi in its own header', () => {
  const bmp = fakePage(100, 80, [20, 17]);
  const png = encodePNG(renderSheetBitmap(bmp));
  // IHDR: width and height are big-endian at bytes 16..23, the same place the G2 fixture audit read.
  const w = Buffer.from(png).readUInt32BE(16);
  const h = Buffer.from(png).readUInt32BE(20);
  assert.equal(w, Math.round(20 * PX_PER_MM));
  assert.equal(h, Math.round(17 * PX_PER_MM));
  assert.notEqual(w, bmp.width, 'control: this must not be the code area any more');
});

test('bad input is refused instead of producing a plausible-looking page', () => {
  const ok = fakePage(100, 80, [20, 17]);
  assert.throws(() => renderSheetBitmap({ ...ok, sheetMm: undefined }), /no sheetMm/);
  assert.throws(() => renderSheetBitmap({ ...ok, sheetMm: [20] }), /no sheetMm/);
  assert.throws(() => renderSheetBitmap({ ...ok, pixels: ok.pixels.subarray(0, 40) }), /width\*height\*4/);
  assert.throws(() => renderSheetBitmap({ ...ok, dpi: 0 }), /bad dpi/);
  assert.throws(() => renderSheetBitmap({ ...ok, width: 2.5, pixels: new Uint8Array(4 * 3 * 80) }), /bad size/);
  assert.throws(() => renderSheetBitmap(null), /expected a rendered bitmap/);
  // A sheet smaller than the content is the D44 family of bug: it must refuse, not clip ink.
  assert.throws(() => renderSheetBitmap(fakePage(100, 80, [5, 4])), /cannot carry/);
  assert.throws(() => sheetPlacement({ w: 10, h: 10 }, { w: 0, h: 10 }), /positive finite length/);
});
