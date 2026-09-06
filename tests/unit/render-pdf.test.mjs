/**
 * PSKT unit tests -- core/render/pdf.js.
 *
 * The encoder must not grade its own homework, so nothing here trusts a claim
 * core/render/pdf.js makes about its own output:
 *   - a ~40-line PDF/xref reader written below seeks every object by the offset
 *     the xref table advertises and checks that the bytes there really are
 *     `N 0 obj`, that entries are 20 bytes, and that the objects the table
 *     claims tile the body with no gaps and no strays;
 *   - node:zlib inflates the image stream, which independently proves the zlib
 *     header, core/deflate.js, the adler32 trailer and the per-row filter bytes;
 *   - the trailer /ID is recomputed over the exact body bytes it claims to digest.
 * Determinism is checked the only way it can be: encode twice, compare bytes, and
 * look for the timestamp keys a "helpful" writer likes to add.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';

import { sha256 } from '../../core/hash.js';
import { toHex } from '../../core/crc.js';
import { encodePDFPage } from '../../core/render/pdf.js';
import { planPage } from '../../core/profiles.js';
import { pageLayout } from '../../core/render/layout.js';
import { renderPageBitmap } from '../../core/render/raster.js';

const DEC = new TextDecoder('latin1');

/** Decode a byte slice as latin1: one code unit per byte, so indices stay offsets. */
function text(file, from = 0, to = file.length) {
  return DEC.decode(file.subarray(Math.max(0, from), Math.min(file.length, to)));
}

function eqBytes(a, b, msg) {
  assert.equal(a.length, b.length, `${msg}: length ${a.length} != ${b.length}`);
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) assert.fail(`${msg}: byte ${i} is ${a[i]}, expected ${b[i]}`);
  }
}

/* ------------------------------------------------------------------ */
/* the synthetic page: substrate plus two ink blocks, no renderer      */
/* ------------------------------------------------------------------ */

const SUBSTRATE = [245, 242, 235];
const INK_A = [12, 14, 16];
const INK_B = [200, 30, 40];

function synthBitmap({ width = 40, height = 23, dpi = 300, alpha = 255, substrate = SUBSTRATE } = {}) {
  const pixels = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    pixels[o] = substrate[0];
    pixels[o + 1] = substrate[1];
    pixels[o + 2] = substrate[2];
    pixels[o + 3] = alpha;
  }
  const rect = (x0, y0, x1, y1, rgb) => {
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const o = (y * width + x) * 4;
        pixels[o] = rgb[0];
        pixels[o + 1] = rgb[1];
        pixels[o + 2] = rgb[2];
      }
    }
  };
  rect(2, 3, Math.min(11, width), Math.min(9, height), INK_A); // dark block, upper left
  rect(Math.min(18, width), Math.min(12, height), width, height, INK_B); // coloured block, lower right
  return { width, height, pixels, dpi, substrate: Array.from(substrate) };
}

/** RGBA -> the RGB triplets the file must carry, alpha dropped. */
function expectedRGB(img) {
  const { width, height, pixels } = img;
  const rgb = new Uint8Array(width * height * 3);
  for (let s = 0, d = 0; s < pixels.length; s += 4) {
    rgb[d++] = pixels[s];
    rgb[d++] = pixels[s + 1];
    rgb[d++] = pixels[s + 2];
  }
  return rgb;
}

/* ------------------------------------------------------------------ */
/* a minimal PDF reader: xref table, objects, streams                  */
/* ------------------------------------------------------------------ */

const RE_MEDIABOX = /\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/;

/**
 * Validate the classic cross-reference table and return object offsets/dicts.
 * Fails on everything a real reader would trip over.
 */
function parsePdf(file, label = 'pdf') {
  assert.ok(file.length > 200, `${label}: ${file.length} bytes is not a PDF`);
  assert.ok(text(file, 0, 9).startsWith('%PDF-1.'), `${label}: header must start with %PDF-1.x`);

  const tail = text(file, file.length - 48);
  const xm = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(tail);
  assert.ok(xm, `${label}: file must end "startxref\\n<offset>\\n%%EOF" (got ${JSON.stringify(tail)})`);
  const xrefAt = Number(xm[1]);
  assert.ok(xrefAt > 0 && xrefAt < file.length, `${label}: startxref ${xrefAt} is outside the file`);

  const head = /^xref\n(\d+) (\d+)\n/.exec(text(file, xrefAt, xrefAt + 24));
  assert.ok(head, `${label}: startxref does not land on an xref table`);
  assert.equal(Number(head[1]), 0, `${label}: xref subsection must start at object 0`);
  const count = Number(head[2]);

  const trailerText = text(file, xrefAt);
  const sizeM = /\/Size\s+(\d+)/.exec(trailerText);
  assert.ok(sizeM, `${label}: trailer has no /Size`);
  const size = Number(sizeM[1]);
  assert.equal(count, size, `${label}: xref covers ${count} entries but /Size says ${size}`);
  assert.equal(text(file, xrefAt - 7, xrefAt), 'endobj\n', `${label}: xref must start right after the last object`);

  const tableAt = xrefAt + head[0].length;
  const entries = [];
  for (let i = 0; i < size; i++) {
    const e = text(file, tableAt + i * 20, tableAt + i * 20 + 20);
    assert.equal(e.length, 20, `${label}: xref entry ${i} is ${e.length} bytes, not 20`);
    const em = /^(\d{10}) (\d{5}) ([nf])[\s\S]{2}$/.exec(e);
    assert.ok(em, `${label}: xref entry ${i} is malformed: ${JSON.stringify(e)}`);
    entries.push({ off: Number(em[1]), gen: em[2], type: em[3] });
  }
  // Entry 0 is the free-list head; offset field 0 means "no free objects", which
  // is what a freshly written, never-rewritten file must look like.
  assert.equal(entries[0].type, 'f', `${label}: entry 0 is the free-list head`);
  assert.equal(entries[0].gen, '65535', `${label}: free head generation`);
  assert.equal(entries[0].off, 0, `${label}: a file with no free objects must chain to 0`);

  const objects = new Map();
  for (let i = 1; i < size; i++) {
    const e = entries[i];
    assert.equal(e.type, 'n', `${label}: object ${i} is marked free but /Size counts it`);
    assert.equal(e.gen, '00000', `${label}: object ${i} generation must be 0`);
    const seen = text(file, e.off, e.off + 16);
    assert.ok(
      seen.startsWith(`${i} ${Number(e.gen)} obj`),
      `${label}: offset ${e.off} for object ${i} reads ${JSON.stringify(seen)}, expected "${i} 0 obj"`,
    );
    objects.set(i, e.off);
  }
  assert.equal(objects.size, size - 1, `${label}: /Size-1 in-use objects must be present`);

  // The ranges the offsets imply must tile the body exactly, each ending in
  // `endobj\n`: no hidden objects, no padding a viewer would have to guess about.
  const nums = [...objects.keys()].sort((a, b) => a - b);
  const offs = nums.map((n) => objects.get(n));
  for (let i = 0; i < offs.length; i++) {
    const end = i + 1 < offs.length ? offs[i + 1] : xrefAt;
    assert.ok(offs[i] < end, `${label}: object ${nums[i]} range is empty/overlapping`);
    assert.equal(text(file, end - 7, end), 'endobj\n', `${label}: object ${nums[i]} does not end at its advertised range`);
  }
  const pre = text(file, 0, offs[0]);
  assert.ok(pre.startsWith('%PDF-1.') && pre.endsWith('\n'), `${label}: header region is ${JSON.stringify(pre)}`);
  assert.ok(offs[0] > 9, `${label}: object 1 must come after the header`);

  // Dictionaries: every dict we write is ASCII and short, so reading the first
  // 2 KiB of each object is enough to parse it without touching binary data.
  const dicts = new Map();
  for (let k = 0; k < nums.length; k++) {
    const n = nums[k];
    const end = k + 1 < offs.length ? offs[k + 1] : xrefAt;
    dicts.set(n, { num: n, off: offs[k], end, dict: text(file, offs[k], offs[k] + 2048) });
  }
  return { size, xrefAt, objects, dicts, trailerText, file };
}

/** Locate a stream object's payload and prove its /Length by re-deriving the framing. */
function readStream(info, n, label) {
  const o = info.dicts.get(n);
  assert.ok(o, `${label}: object ${n} missing`);
  const at = o.dict.indexOf('\nstream\n');
  assert.ok(at > 0, `${label}: object ${n} has no stream keyword`);
  const lenM = /\/Length\s+(\d+)/.exec(o.dict.slice(0, at));
  assert.ok(lenM, `${label}: object ${n} stream has no /Length`);
  const len = Number(lenM[1]);
  const dataAt = o.off + at + '\nstream\n'.length;
  assert.ok(dataAt + len + 11 <= o.end, `${label}: object ${n} stream overruns the object`);
  assert.equal(
    text(info.file, dataAt + len, dataAt + len + 11),
    '\nendstream\n',
    `${label}: object ${n} /Length ${len} does not match its stream bytes`,
  );
  return { data: info.file.subarray(dataAt, dataAt + len), len };
}

/** The full proof of one encoded page: structure, image stream, pixels. */
function verifyPdf(file, img, label) {
  const info = parsePdf(file, label);

  // --- the page tree, followed from the trailer down ---
  const rootM = /\/Root\s+(\d+) 0 R/.exec(info.trailerText);
  assert.ok(rootM, `${label}: trailer must have /Root`);
  assert.match(info.dicts.get(Number(rootM[1])).dict, /\/Type\s*\/Catalog/, `${label}: /Root must be the catalog`);
  const pagesM = /\/Pages\s+(\d+) 0 R/.exec(info.dicts.get(Number(rootM[1])).dict);
  assert.ok(pagesM, `${label}: catalog must name /Pages`);
  assert.match(info.dicts.get(Number(pagesM[1])).dict, /\/Type\s*\/Pages[\s\S]*\/Count 1/, `${label}: single page`);
  assert.match(info.dicts.get(3).dict, /\/Type\s*\/Page\b/, `${label}: object 3 must be the page`);
  assert.match(info.dicts.get(3).dict, new RegExp(`/Parent\\s+${pagesM[1]} 0 R`), `${label}: page must name its parent`);
  assert.match(info.dicts.get(3).dict, /\/Contents\s+5 0 R/, `${label}: page must reference its content stream`);

  // --- the image xobject: DeviceRGB + predictor 15, nothing lossy ---
  const xo = info.dicts.get(4).dict;
  assert.match(xo, /\/Subtype\s*\/Image/, `${label}: object 4 must be an Image XObject`);
  assert.match(xo, /\/Type\s*\/XObject/, `${label}: object 4 must be an XObject`);
  assert.equal(Number(/\/Width\s+(\d+)/.exec(xo)[1]), img.width, `${label}: /Width`);
  assert.equal(Number(/\/Height\s+(\d+)/.exec(xo)[1]), img.height, `${label}: /Height`);
  assert.match(xo, /\/ColorSpace\s*\/DeviceRGB/, `${label}: colour space must be /DeviceRGB`);
  assert.match(xo, /\/BitsPerComponent\s+8/, `${label}: 8 bits per component`);
  assert.match(xo, /\/Filter\s*\/FlateDecode/, `${label}: /Filter must be /FlateDecode`);
  assert.match(xo, /\/DecodeParms\s*<<[^>]*\/Predictor\s+15/, `${label}: PNG predictor 15 required`);
  assert.match(xo, /\/DecodeParms\s*<<[^>]*\/Colors\s+3/, `${label}: /Colors 3`);
  assert.equal(Number(/\/Columns\s+(\d+)/.exec(xo)[1]), img.width * 3, `${label}: /Columns is samples per row = width*3`);
  assert.match(
    info.dicts.get(3).dict,
    /\/XObject\s*<<\s*\/Im0\s+4 0 R\s*>>/,
    `${label}: the page resources must map /Im0 to object 4`,
  );
  assert.ok(!/\/SMask|\/Mask\b|\/Decode\s*\[/.test(xo), `${label}: no transparency machinery`);
  assert.ok(
    !/DCTDecode|JBIG2|CCITT|JPX|CalRGB|ICCBased|\bLab\b/.test(xo),
    `${label}: image must be lossless device-RGB (a lossy codec moves ink edges, which is the signal)`,
  );

  // --- the content stream: one cm, full bleed, /Im0 painted ---
  const content = text(readStream(info, 5, label).data);
  assert.match(content, /\/Im0 Do/, `${label}: content must draw the image`);
  const mb = RE_MEDIABOX.exec(info.dicts.get(3).dict);
  assert.ok(mb, `${label}: page needs /MediaBox [0 0 w h]`);
  const cm = /([\d.]+) 0 0 ([\d.]+) 0 0 cm/.exec(content);
  assert.ok(cm, `${label}: content must scale the image with a cm matrix: ${JSON.stringify(content)}`);
  assert.equal(cm[1], mb[1], `${label}: cm scale must match MediaBox width`);
  assert.equal(cm[2], mb[2], `${label}: cm scale must match MediaBox height`);
  assert.equal((content.match(/\bq\b/g) || []).length, 1, `${label}: one graphics-state save`);
  assert.equal((content.match(/\bQ\b/g) || []).length, 1, `${label}: and one restore`);

  // --- the strong one: node:zlib decodes what we wrote ---
  const stream = readStream(info, 4, label).data;
  assert.equal(stream[0], 0x78, `${label}: zlib CMF (deflate, 32 KiB window)`);
  assert.equal((stream[0] * 256 + stream[1]) % 31, 0, `${label}: CMF/FLG must be a multiple of 31`);
  const inflated = new Uint8Array(zlib.inflateSync(stream)); // verifies adler32 or throws
  assert.equal(inflated.length, img.height * (1 + img.width * 3), `${label}: inflated predictor stream length`);
  const stride = img.width * 3;
  const rgb = new Uint8Array(img.height * stride);
  for (let y = 0; y < img.height; y++) {
    assert.equal(inflated[y * (stride + 1)], 0, `${label}: row ${y} filter byte must be 0 (None)`);
    rgb.set(inflated.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride), y * stride);
  }
  eqBytes(rgb, expectedRGB(img), `${label}: decoded RGB vs input pixels (alpha dropped)`);

  // --- determinism hygiene: no clock, no random ids ---
  assert.ok(
    !/CreationDate|ModDate|\/D\s*\(|Date\s*\(/.test(text(file, 0, 64) + info.trailerText),
    `${label}: timestamps are forbidden`,
  );
  return info;
}

/* ------------------------------------------------------------------ */
/* small synthetic page                                                */
/* ------------------------------------------------------------------ */

test('PDF: 40x23 page -- header, exact xref, every object found where it claims', () => {
  const img = synthBitmap();
  const file = encodePDFPage(img);
  const info = verifyPdf(file, img, 'synth 40x23');
  assert.ok(text(file, file.length - 8).endsWith('%%EOF'), 'the file must end with %%EOF');
  assert.equal(info.size, 6, 'catalog, pages, page, image, contents + the free head');
  assert.deepEqual([...info.objects.keys()].sort((a, b) => a - b), [1, 2, 3, 4, 5], 'object numbers 1..5');
  for (const n of [1, 2, 3, 4, 5]) {
    assert.ok(info.dicts.get(n).dict.startsWith(`${n} 0 obj`), `object ${n} header text`);
  }
  // the two ink blocks must survive: spot-check a dark and a coloured pixel
  const s = readStream(info, 4, 'synth').data;
  const px = new Uint8Array(zlib.inflateSync(s));
  const at = (x, y) => y * (1 + img.width * 3) + 1 + x * 3;
  assert.deepEqual([...px.subarray(at(5, 5), at(5, 5) + 3)], INK_A, 'ink block A');
  assert.deepEqual([...px.subarray(at(30, 15), at(30, 15) + 3)], INK_B, 'ink block B');
  assert.deepEqual([...px.subarray(at(15, 2), at(15, 2) + 3)], SUBSTRATE, 'substrate');
});

test('PDF: MediaBox is the bitmap true physical size in points', () => {
  for (const dpi of [300, 600, 72, 1200]) {
    const img = synthBitmap({ width: 40, height: 23, dpi });
    const info = parsePdf(encodePDFPage(img), `dpi ${dpi}`);
    const mb = RE_MEDIABOX.exec(info.dicts.get(3).dict);
    assert.ok(mb, `dpi ${dpi}: MediaBox present`);
    const wantW = (40 / dpi) * 72;
    const wantH = (23 / dpi) * 72;
    assert.ok(Math.abs(Number(mb[1]) - wantW) <= 0.01, `dpi ${dpi}: width ${mb[1]} vs ${wantW.toFixed(4)}`);
    assert.ok(Math.abs(Number(mb[2]) - wantH) <= 0.01, `dpi ${dpi}: height ${mb[2]} vs ${wantH.toFixed(4)}`);
    assert.equal(Number(mb[1]) > Number(mb[2]), wantW > wantH, `dpi ${dpi}: orientation preserved`);
    // two decimals at most: a print driver must not be fed 17 digits of float noise
    assert.match(mb[1], /^\d+(\.\d{1,2})?$/, `dpi ${dpi}: width not rounded to 2dp`);
    assert.match(mb[2], /^\d+(\.\d{1,2})?$/, `dpi ${dpi}: height not rounded to 2dp`);
  }
});

test('PDF: byte-deterministic -- the same input twice gives the same bytes', () => {
  const a = encodePDFPage(synthBitmap());
  const b = encodePDFPage(synthBitmap());
  eqBytes(a, b, 'two fresh, identical rasters');
  const img = synthBitmap();
  eqBytes(encodePDFPage(img), a, 're-encoding the same object');
  eqBytes(encodePDFPage(img), a, 'and once more (no hidden state)');
  assert.ok(a.length > 200, 'output must be a real file, not a stub');
});

test('PDF: alpha never reaches the output', () => {
  const opaque = synthBitmap({ alpha: 255 });
  const translucent = synthBitmap({ alpha: 7 });
  const mixed = synthBitmap();
  for (let i = 3; i < mixed.pixels.length; i += 4) mixed.pixels[i] = (i * 31) & 255;
  eqBytes(encodePDFPage(opaque), encodePDFPage(translucent), 'alpha 255 vs alpha 7');
  eqBytes(encodePDFPage(opaque), encodePDFPage(mixed), 'alpha 255 vs a random alpha ramp');
  verifyPdf(encodePDFPage(mixed), mixed, 'mixed alpha');
});

test('PDF: trailer /ID is a content digest, not a constant or a timestamp', () => {
  const file = encodePDFPage(synthBitmap());
  const info = parsePdf(file, 'id');
  const idm = /\/ID\s*\[\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\]/.exec(info.trailerText);
  assert.ok(idm, 'trailer must carry /ID [<hex> <hex>]');
  assert.equal(idm[1].toLowerCase(), idm[2].toLowerCase(), '/ID[0] and /ID[1] must agree in a fresh file');
  assert.equal(idm[1].length, 32, '/ID entries are 16 bytes of hex');
  // /ID claims to digest the body in front of the xref table -- recompute it here.
  assert.equal(
    idm[1].toUpperCase(),
    toHex(sha256(file.subarray(0, info.xrefAt)).subarray(0, 16)).toUpperCase(),
    '/ID must be SHA-256[0..16) of the bytes before the xref table',
  );
  // a different page must give a different digest, and still be reproducible
  const other = encodePDFPage(synthBitmap({ width: 41 }));
  const oi = parsePdf(other, 'id-other');
  assert.notEqual(/\/ID\s*\[\s*<([0-9A-Fa-f]+)/.exec(oi.trailerText)[1], idm[1], '/ID must track content');
  eqBytes(encodePDFPage(synthBitmap({ width: 41 })), other, 'the second input is deterministic too');
});

test('PDF: substrate is painted as the page background; no substrate is legal', () => {
  const info = parsePdf(encodePDFPage(synthBitmap()), 'substrate');
  const content = text(readStream(info, 5, 'substrate').data);
  const lines = content.split('\n');
  const rg = /^([\d.]+) ([\d.]+) ([\d.]+) rg$/.exec(lines[1]);
  assert.ok(rg, `content must paint the substrate first, got ${JSON.stringify(content)}`);
  for (let i = 0; i < 3; i++) {
    assert.ok(Number(rg[i + 1]) >= 0 && Number(rg[i + 1]) <= 1, 'rg components in [0,1]');
    assert.ok(Math.abs(Number(rg[i + 1]) - SUBSTRATE[i] / 255) < 1e-4, `substrate channel ${i}`);
  }
  assert.match(lines[2], /^0 0 [\d.]+ [\d.]+ re f$/, 'the fill must cover the MediaBox');

  const bare = { ...synthBitmap({ width: 12, height: 9 }), substrate: undefined };
  const bi = parsePdf(encodePDFPage(bare), 'no substrate');
  const bc = text(readStream(bi, 5, 'no substrate').data);
  assert.ok(!bc.includes(' rg\n'), 'no colour fill when the caller gives no substrate');
  verifyPdf(encodePDFPage(bare), bare, 'no substrate');
});

test('PDF: explicit pageMm overrides the MediaBox and leaves the pixels alone', () => {
  const img = synthBitmap();
  const file = encodePDFPage({ ...img, pageMm: [50, 30] });
  const info = parsePdf(file, 'pageMm');
  const mb = RE_MEDIABOX.exec(info.dicts.get(3).dict);
  assert.equal(Number(mb[1]), 141.73, '50mm * 72/25.4');
  assert.equal(Number(mb[2]), 85.04, '30mm * 72/25.4');
  // the physical size is metadata only: the image bytes must be identical
  const plain = parsePdf(encodePDFPage(img), 'plain');
  eqBytes(readStream(info, 4, 'pageMm').data, readStream(plain, 4, 'plain').data, 'image stream vs pageMm');
});

test('PDF: input validation rejects anything off the raster contract', () => {
  const ok = synthBitmap({ width: 4, height: 3 });
  assert.throws(() => encodePDFPage({ ...ok, pixels: new Uint8Array(47) }), /width\*height\*4/);
  assert.throws(() => encodePDFPage({ ...ok, width: 0 }), /bad width/);
  assert.throws(() => encodePDFPage({ ...ok, height: 2.5 }), /bad height/);
  assert.throws(() => encodePDFPage({ ...ok, pixels: Array.from(ok.pixels) }), /Uint8Array/);
  assert.throws(() => encodePDFPage({ ...ok, dpi: 0 }), /bad dpi/);
  assert.throws(() => encodePDFPage({ ...ok, dpi: NaN }), /bad dpi/);
  assert.throws(() => encodePDFPage(null), /raster object/);
  assert.throws(() => encodePDFPage({ ...ok, substrate: [1, 2] }), /substrate/);
  assert.throws(() => encodePDFPage({ ...ok, substrate: [1, 2, 300] }), /substrate/);
  assert.throws(() => encodePDFPage({ ...ok, substrate: 'paper' }), /substrate/);
  assert.throws(() => encodePDFPage({ ...ok, pageMm: [10] }), /pageMm/);
  assert.throws(() => encodePDFPage({ ...ok, pageMm: [10, -1] }), /pageMm/);
});

/* ------------------------------------------------------------------ */
/* a real page, end to end                                             */
/* ------------------------------------------------------------------ */

test('PDF: a real PL-M1 page at 300 dpi encodes and passes the xref reader', () => {
  const geom = planPage('PL-M1', { nozzle: '0.4' });
  const layout = pageLayout(geom, 300);
  const levels = new Uint16Array(geom.totalCells); // blank plate: every cell at level 0
  const bitmap = renderPageBitmap({ geom, levels, layout });
  assert.equal(bitmap.pixels.length, bitmap.width * bitmap.height * 4, 'the renderer follows the raster contract');
  assert.ok(bitmap.width > 100 && bitmap.height > 100, 'this must be a real page, not a thumbnail');

  const file = encodePDFPage(bitmap);
  assert.ok(file.length > 1000, `a ${bitmap.width}x${bitmap.height} page cannot be ${file.length} bytes`);
  const info = verifyPdf(file, bitmap, 'PL-M1 300dpi');

  // on the plate at true size: pixel grid / dpi -> points
  const mb = RE_MEDIABOX.exec(info.dicts.get(3).dict);
  const wantW = (bitmap.width / bitmap.dpi) * 72;
  const wantH = (bitmap.height / bitmap.dpi) * 72;
  assert.ok(Math.abs(Number(mb[1]) - wantW) <= 0.01, `MediaBox width ${mb[1]} vs ${wantW.toFixed(2)}`);
  assert.ok(Math.abs(Number(mb[2]) - wantH) <= 0.01, `MediaBox height ${mb[2]} vs ${wantH.toFixed(2)}`);
  assert.equal(Number(/\/Columns\s+(\d+)/.exec(info.dicts.get(4).dict)[1]), bitmap.width * 3, 'predictor Columns');
  eqBytes(encodePDFPage(bitmap), file, 'a full page must be reproducible byte for byte');
});
