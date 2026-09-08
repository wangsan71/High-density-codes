/**
 * pack.pdf is the paper the user loaded, the code area is drawn at its declared physical size and
 * truly centred, and the crop/registration marks stay out of the code area.
 *
 * DEFECTS D8 is the browser's print dialog: it obeys whatever scale the user picks, and a wrong
 * scale means wrong geometry, which the frame header then refuses -- loud, not silent, but the user
 * reprints and rescans. The half of that which is ours to guarantee is the artifact, and it can be
 * checked without a browser. D44 was this artifact failing the check: the page was the code area
 * (191.35x278.55 mm) rather than the declared A4 sheet, so there was no margin and no marks.
 *
 * Three independent sources are compared, and none of them is the PDF writer:
 *   - the sheet comes from encodeTransfer -> geom.sheetMm (protocol geometry);
 *   - the content size comes from pageLayout -> physicalMm (layout authority), converted with
 *     72/25.4 recomputed here rather than imported, so a shared constant cannot agree with itself;
 *   - the actual numbers come out of the PDF the web sender hands a user (buildArtifacts -> r.pdf),
 *     parsed as text: every /MediaBox, every painting CTM, and every stroked segment.
 *
 * Centring is checked arithmetically from the PDF's own numbers (translate == (box - content)/2),
 * because "the page is the right size" says nothing about where the ink landed: a page shoved into
 * the bottom-left corner prints off-centre and a user trimming by the marks cuts the code area.
 * Marks are checked to be *outside* the content box, since ink the decoder was never told about is
 * how a page stops decoding.
 *
 * And because a check that has never failed is not a check, the same judge is run against doctored
 * copies: a sheet shrunk to 94% ("fit to printable area"), a content box shrunk inside a correct
 * sheet, and a page whose content is no longer centred. All three must be reported.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeTransfer } from '../../core/protocol.js';
import { pageLayout } from '../../core/render/layout.js';
import { buildArtifacts } from '../../web/sender.js';

const PT_PER_MM = 72 / 25.4; // deliberately recomputed here, not imported from core/render/pdf.js
const TOL_PT = 0.01; // ~3.5 um: far below anything a printer can hold, tight enough to catch a unit slip
const PROFILE = 'P-M1-300';

/** Every /MediaBox, painting CTM and stroked segment in a PDF, read as text. */
export function parsePdfGeometry(bytes) {
  const text = Buffer.from(bytes).toString('latin1');
  const boxes = [...text.matchAll(/\/MediaBox\s*\[\s*0\s+0\s+([0-9.]+)\s+([0-9.]+)\s*\]/g)].map((m) => ({
    w: Number(m[1]),
    h: Number(m[2]),
    raw: `${m[1]} ${m[2]}`,
  }));
  const ctms = [...text.matchAll(/([0-9.]+)\s+0\s+0\s+([0-9.]+)\s+([-0-9.]+)\s+([-0-9.]+)\s+cm/g)].map((m) => ({
    w: Number(m[1]),
    h: Number(m[2]),
    tx: Number(m[3]),
    ty: Number(m[4]),
    raw: `${m[1]} ${m[2]} ${m[3]} ${m[4]}`,
  }));
  const segs = [...text.matchAll(/([0-9.]+)\s+([0-9.]+)\s+m\s+([0-9.]+)\s+([0-9.]+)\s+l/g)].map((m) => [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])]);
  const pages = (text.match(/\/Type\s*\/Page[^s]/g) || []).length;
  return { boxes, ctms, segs, pages, text };
}

/**
 * Judge a PDF against a sheet size and a content size, both in mm. Returns complaints; empty means
 * the artifact is printable as claimed. Separate from the assertions so the doctored copies below
 * are judged by the same code path as the real artifact -- otherwise the controls test a different
 * parser than the product does.
 */
export function checkTrueSize(bytes, sheetMm, contentMm, expectPages) {
  const { boxes, ctms, segs, pages } = parsePdfGeometry(bytes);
  const bad = [];
  const wantBoxW = sheetMm.w * PT_PER_MM;
  const wantBoxH = sheetMm.h * PT_PER_MM;
  const wantW = contentMm.w * PT_PER_MM;
  const wantH = contentMm.h * PT_PER_MM;
  if (pages !== expectPages) bad.push(`found ${pages} /Page objects, expected ${expectPages}`);
  if (boxes.length !== expectPages) bad.push(`found ${boxes.length} MediaBox entries, expected ${expectPages}`);
  if (ctms.length !== expectPages) bad.push(`found ${ctms.length} painting CTMs, expected ${expectPages}`);
  boxes.forEach((b, i) => {
    if (Math.abs(b.w - wantBoxW) > TOL_PT) bad.push(`page ${i}: MediaBox width ${b.w} pt, wanted ${wantBoxW.toFixed(3)} pt (${sheetMm.w} mm sheet) -- off by ${((b.w - wantBoxW) / PT_PER_MM).toFixed(3)} mm`);
    if (Math.abs(b.h - wantBoxH) > TOL_PT) bad.push(`page ${i}: MediaBox height ${b.h} pt, wanted ${wantBoxH.toFixed(3)} pt (${sheetMm.h} mm sheet) -- off by ${((b.h - wantBoxH) / PT_PER_MM).toFixed(3)} mm`);
  });
  ctms.forEach((c, i) => {
    const box = boxes[i];
    if (Math.abs(c.w - wantW) > TOL_PT || Math.abs(c.h - wantH) > TOL_PT) {
      bad.push(`page ${i}: the code area is painted at ${(c.w / PT_PER_MM).toFixed(2)}x${(c.h / PT_PER_MM).toFixed(2)} mm, wanted ${contentMm.w.toFixed(2)}x${contentMm.h.toFixed(2)} mm -- printing this would give the decoder the wrong cell pitch`);
    }
    if (!box) return;
    const wantTx = (box.w - c.w) / 2;
    const wantTy = (box.h - c.h) / 2;
    if (Math.abs(c.tx - wantTx) > TOL_PT || Math.abs(c.ty - wantTy) > TOL_PT) {
      bad.push(`page ${i}: the code area sits at (${c.tx}, ${c.ty}) pt inside a ${box.raw} pt page; centred would be (${wantTx.toFixed(2)}, ${wantTy.toFixed(2)}) -- off-centre ink means the trim marks cut the code`);
    }
    // Marks must be margin furniture, never ink inside the code area.
    const x0 = c.tx;
    const y0 = c.ty;
    const x1 = c.tx + c.w;
    const y1 = c.ty + c.h;
    const inside = (x, y) => x > x0 + TOL_PT && x < x1 - TOL_PT && y > y0 + TOL_PT && y < y1 - TOL_PT;
    for (const [ax, ay, bx, by] of segs) {
      if (inside(ax, ay) || inside(bx, by)) {
        bad.push(`page ${i}: a stroked mark runs from (${ax}, ${ay}) to (${bx}, ${by}), which is inside the code area (${x0}, ${y0})-(${x1.toFixed(2)}, ${y1.toFixed(2)}) -- the decoder was never told about that ink`);
        break;
      }
    }
  });
  return bad;
}

const payload = new Uint8Array(20480).map((_, i) => (i * 31 + (i >> 4)) & 0xff);

/** The sheet and content sizes from their own authorities, plus the artifact under test. */
async function measure() {
  const it = await encodeTransfer(payload, { profile: PROFILE });
  const r = await buildArtifacts(payload, { profile: PROFILE });
  assert.ok(r.ok, `buildArtifacts failed at ${r.stage}: ${r.error}`);
  const sheetMm = it.geom.sheetMm;
  assert.ok(sheetMm && sheetMm.w > 0 && sheetMm.h > 0, `${PROFILE} declares no sheetMm, so there is nothing to compare against`);
  const layout = pageLayout(it.geom, r.dpi, { sheetMm });
  const contentMm = { w: layout.physicalMm.wMm, h: layout.physicalMm.hMm };
  return { it, r, sheetMm, contentMm };
}

test('pack.pdf is the declared sheet, the code area is true size and centred, and the marks stay in the margin', async () => {
  const { it, r, sheetMm, contentMm } = await measure();
  assert.equal(r.pages.length, it.pages.length, 'the sender and the protocol disagree about the page count');
  assert.ok(r.pdf && r.pdf.length > 1000, `the sender produced no usable pack.pdf (${r.pdf ? r.pdf.length : 0} B)`);

  const bad = checkTrueSize(r.pdf, sheetMm, contentMm, r.pages.length);
  assert.deepEqual(bad, [], `pack.pdf is not what a user must print:\n  ${bad.join('\n  ')}`);

  const { boxes, ctms, segs, text } = parsePdfGeometry(r.pdf);
  // Marks: 8 crop arms + 8 cross arms, stroked black at 1 pt.
  assert.equal(segs.length, 16 * r.pages.length, `expected 16 mark segments per page, found ${segs.length} in ${r.pages.length} page(s)`);
  assert.match(text, /0 0 0 RG\n1 w\n/, 'the marks must be stroked, not filled, at a deterministic line width');
  console.log(
    `        pack.pdf: ${r.pages.length} page(s), sheet ${sheetMm.w}x${sheetMm.h} mm = ${boxes[0].raw} pt, code area ${contentMm.w.toFixed(2)}x${contentMm.h.toFixed(2)} mm painted at (${ctms[0].tx}, ${ctms[0].ty}) pt, ${segs.length / r.pages.length} mark segments/page, ${r.pdf.length} B`,
  );
});

test('the check fails on a sheet shrunk to 94%, which is what "fit to printable area" does', async () => {
  const { r, sheetMm, contentMm } = await measure();
  const text = Buffer.from(r.pdf).toString('latin1');
  const doctored = text.replace(/\/MediaBox\s*\[\s*0\s+0\s+([0-9.]+)\s+([0-9.]+)\s*\]/g, (_m, w, h) => {
    const f = (x) => String(Number((Number(x) * 0.94).toFixed(3)));
    return `/MediaBox [0 0 ${f(w)} ${f(h)}]`;
  });
  assert.notEqual(doctored, text, 'the MediaBox replacement did not match anything -- the parser and the writer have drifted apart');
  const bad = checkTrueSize(Buffer.from(doctored, 'latin1'), sheetMm, contentMm, r.pages.length);
  assert.ok(bad.length >= r.pages.length, `a 94%-shrunk sheet was not reported (got ${bad.length} complaints)`);
  assert.match(bad.join('\n'), /MediaBox width/, 'the complaint must name what is wrong');
});

test('the check fails when the code area is painted smaller than declared', async () => {
  const { r, sheetMm, contentMm } = await measure();
  const text = Buffer.from(r.pdf).toString('latin1');
  // Shrink only the CTM scale, leaving the sheet correct: the file still claims the right paper and
  // the ink is quietly 90%. This is the failure mode a page-size-only check misses entirely.
  const doctored = text.replace(/([0-9.]+)(\s+)0(\s+)0(\s+)([0-9.]+)(\s+[-0-9.]+\s+[-0-9.]+\s+cm)/g, (_m, w, s1, s2, s3, h, tail) => {
    const f = (x) => String(Number((Number(x) * 0.9).toFixed(3)));
    return `${f(w)}${s1}0${s2}0${s3}${f(h)}${tail}`;
  });
  assert.notEqual(doctored, text, 'the CTM replacement did not match anything -- the parser and the writer have drifted apart');
  const bad = checkTrueSize(Buffer.from(doctored, 'latin1'), sheetMm, contentMm, r.pages.length);
  assert.ok(bad.some((b) => /painted at/.test(b)), `a 90% code area inside a correct sheet was not reported: ${bad.join(' | ')}`);
});

test('the check fails when the code area is not centred on the sheet', async () => {
  const { r, sheetMm, contentMm } = await measure();
  const text = Buffer.from(r.pdf).toString('latin1');
  // Drop the content into the bottom-left corner: right paper, right size, wrong place -- and the
  // user trimming by the crop marks would cut through the code area.
  const doctored = text.replace(/([0-9.]+\s+0\s+0\s+[0-9.]+\s+)([-0-9.]+)(\s+)([-0-9.]+)(\s+cm)/g, (_m, head, _tx, s, _ty, tail) => `${head}0${s}0${tail}`);
  assert.notEqual(doctored, text, 'the translate replacement did not match anything -- the parser and the writer have drifted apart');
  const bad = checkTrueSize(Buffer.from(doctored, 'latin1'), sheetMm, contentMm, r.pages.length);
  assert.ok(bad.some((b) => /off-centre/.test(b)), `an off-centre code area was not reported: ${bad.join(' | ')}`);
});

test('a sheet smaller than the page is refused instead of clipping ink', async () => {
  const { encodePDFPage } = await import('../../core/render/pdf.js');
  const img = { width: 400, height: 300, pixels: new Uint8Array(400 * 300 * 4).fill(255), dpi: 300 };
  // 400x300 px at 300 dpi is 33.87x25.4 mm; a 20 mm sheet cannot carry it.
  assert.throws(() => encodePDFPage({ ...img, sheetMm: [20, 20] }), /cannot carry/, 'a too-small sheet must throw, not silently clip');
  // And the same page with a generous sheet writes, centres, and marks. Judged by the same tolerant
  // judge as the real artifact: the writer rounds every number to two decimals, so recomputing the
  // centre from the rounded page and demanding strict equality is a 0.01 pt argument about nothing.
  const ok = encodePDFPage({ ...img, sheetMm: [50, 40] });
  const { boxes, segs } = parsePdfGeometry(ok);
  assert.equal(boxes.length, 1);
  assert.ok(Math.abs(boxes[0].w - 50 * PT_PER_MM) <= TOL_PT, `sheet width ${boxes[0].w}`);
  assert.deepEqual(
    checkTrueSize(ok, { w: 50, h: 40 }, { w: (400 / 300) * 25.4, h: (300 / 300) * 25.4 }, 1),
    [],
    'a synthetic sheet must satisfy the same judge as the real one',
  );
  assert.equal(segs.length, 16, 'a sheet with a real margin must carry crop marks and registration crosses');
});
