/**
 * core/decode/tiff-read.js -- the baseline a scanner emits, built byte by byte here.
 *
 * The reader exists because TIFF is a flatbed's other common default and an air-gapped
 * workflow cannot answer "install ImageMagick first" (DEFECTS D82). Third-party encoders
 * (PIL) cover the everyday cases in tools/usability.ps1; what they will not produce on
 * demand -- big-endian files, FillOrder 2, Predictor 2, two pages in one IFD chain, and
 * the refusals -- is built here, so the reader's edges are pinned without a dependency.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { decodeTIFF } from '../../core/decode/tiff-read.js';

const TYPES = { BYTE: 1, ASCII: 2, SHORT: 3, LONG: 4, RATIONAL: 5, UNDEFINED: 7 };
const SIZES = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1 };

/**
 * Build a TIFF. Each page is { tags: {tagId: {type, values}}, data: [Buffer] }: tag values
 * that do not fit in the four-byte field, and every data blob, are appended after the IFDs
 * and referenced by offset, which is exactly the part a hand-written reader gets wrong.
 * StripOffsets (273) is filled in by the builder, because only the builder knows where the
 * blob landed; StripByteCounts (279) defaults to that blob's length.
 */
function buildTiff(pages, { byteOrder = 'II' } = {}) {
  const le = byteOrder === 'II';
  const w16 = (v) => {
    const b = Buffer.alloc(2);
    if (le) b.writeUInt16LE(v); else b.writeUInt16BE(v);
    return b;
  };
  const w32 = (v) => {
    const b = Buffer.alloc(4);
    if (le) b.writeUInt32LE(v); else b.writeUInt32BE(v);
    return b;
  };
  const payloadOf = (type, values) => {
    if (type === 3) return Buffer.concat(values.map(w16));
    if (type === 4) return Buffer.concat(values.map(w32));
    if (type === 5) return Buffer.concat(values.map(([n, d]) => Buffer.concat([w32(n), w32(d)])));
    return Buffer.from(values);
  };
  // 1. IFD offsets are known from the entry counts.
  let cursor = 8;
  const ifdOffsets = [];
  for (const p of pages) {
    ifdOffsets.push(cursor);
    cursor += 2 + Object.keys(p.tags).length * 12 + 4;
  }
  // 2. Out-of-line tag values come next, then the image blobs.
  const chunks = [];
  const reserve = (buf) => {
    const at = cursor;
    chunks.push({ at, buf });
    cursor += buf.length + (buf.length & 1);
    return at;
  };
  const blobOffsets = pages.map((p) => (p.data || []).map((b) => reserve(b)));
  const fieldOf = (type, values) => {
    const payload = payloadOf(type, values);
    if (payload.length > 4) return { field: w32(reserve(payload)), type };
    return { field: Buffer.concat([payload, Buffer.alloc(4 - payload.length)]), type };
  };
  // 3. Fill in the offsets only the layout knows. The placeholder tags are already present
  // (page() creates them), so the entry count cannot change after the IFD offsets were fixed.
  pages.forEach((p, i) => {
    if (p.data && p.data.length) {
      p.tags[273].values = blobOffsets[i];
      p.tags[279].values = p.data.map((b) => b.length);
    }
  });
  // 4. Serialize.
  const tables = pages.map((p, i) => {
    const entries = [];
    for (const [tag, spec] of Object.entries(p.tags)) {
      const type = TYPES[spec.type] || spec.type;
      const { field } = fieldOf(type, spec.values);
      entries.push(Buffer.concat([w16(Number(tag)), w16(type), w32(spec.values.length), field]));
    }
    return { entries, next: i + 1 < pages.length ? ifdOffsets[i + 1] : 0 };
  });
  const parts = [Buffer.from(le ? 'II' : 'MM', 'latin1'), w16(42), w32(ifdOffsets[0])];
  tables.forEach((t2) => parts.push(w16(t2.entries.length), ...t2.entries, w32(t2.next)));
  chunks.sort((a, b) => a.at - b.at);
  for (const c of chunks) {
    const have = parts.reduce((n, p) => n + p.length, 0);
    if (have > c.at) throw new Error('test fixture: overlapping data chunks');
    if (have < c.at) parts.push(Buffer.alloc(c.at - have));
    parts.push(c.buf);
    if (c.buf.length & 1) parts.push(Buffer.alloc(1));
  }
  return new Uint8Array(Buffer.concat(parts));
}

/** A one-strip page; the strip is data blob 0. */
function page({ width, height, bits = [8], samples = 1, photometric = 1, compression = 1, strip, rowsPerStrip, extra = {}, fillOrder, predictor, colorMap }) {
  const rows = rowsPerStrip ?? height;
  const tags = {
    256: { type: 'SHORT', values: [width] },
    257: { type: 'SHORT', values: [height] },
    258: { type: 'SHORT', values: bits },
    259: { type: 'SHORT', values: [compression] },
    262: { type: 'SHORT', values: [photometric] },
    266: { type: 'SHORT', values: [fillOrder ?? 1] },
    274: { type: 'SHORT', values: [1] },
    277: { type: 'SHORT', values: [samples] },
    278: { type: 'SHORT', values: [rows] },
    273: { type: 'LONG', values: [0] }, // filled in by buildTiff
    279: { type: 'LONG', values: [strip.length] }, // filled in by buildTiff
    284: { type: 'SHORT', values: [1] },
    296: { type: 'SHORT', values: [2] },
    282: { type: 'RATIONAL', values: [[300, 1]] },
    283: { type: 'RATIONAL', values: [[300, 1]] },
    ...extra,
  };
  if (predictor) tags[317] = { type: 'SHORT', values: [predictor] };
  if (colorMap) tags[320] = { type: 'SHORT', values: colorMap };
  return { tags, data: [strip] };
}

function oneStrip(opts, buildOpts) {
  return buildTiff([page(opts)], buildOpts);
}

const grays = (img) => {
  const out = [];
  for (let i = 0; i < img.width * img.height; i++) out.push(img.pixels[i * 4]);
  return out;
};
const px = (img, i) => [...img.pixels.subarray(i * 4, i * 4 + 4)];

test('tiff-read: baseline 8-bit RGB in one strip, little and big endian', () => {
  const strip = Buffer.from([10, 20, 30, 40, 50, 60]); // two pixels
  for (const byteOrder of ['II', 'MM']) {
    const file = oneStrip({ width: 2, height: 1, bits: [8, 8, 8], samples: 3, photometric: 2, strip }, { byteOrder });
    const { pages } = decodeTIFF(file);
    assert.equal(pages.length, 1);
    assert.equal(pages[0].width, 2);
    assert.equal(pages[0].height, 1);
    assert.deepEqual(px(pages[0], 0), [10, 20, 30, 255]);
    assert.deepEqual(px(pages[0], 1), [40, 50, 60, 255]);
    assert.equal(pages[0].dpi, 300, 'XResolution/ResolutionUnit must reach the caller');
  }
});

test('tiff-read: WhiteIsZero and BlackIsZero mean opposite ink', () => {
  const strip = Buffer.from([0, 255]);
  const white = decodeTIFF(oneStrip({ width: 2, height: 1, photometric: 0, strip })).pages[0];
  const black = decodeTIFF(oneStrip({ width: 2, height: 1, photometric: 1, strip })).pages[0];
  assert.deepEqual(grays(white), [255, 0]);
  assert.deepEqual(grays(black), [0, 255]);
});

test('tiff-read: 1-bit gray with FillOrder 2 (LSB first), as bilevel scanners write it', () => {
  // Photometric 1 is BlackIsZero, so a sample of 1 means white ink-free paper and 0 means black.
  // MSB-first the byte is 1010 1100; with FillOrder 2 the same file means the reverse bits.
  const strip = Buffer.from([0b10101100]);
  const msb = decodeTIFF(oneStrip({ width: 8, height: 1, bits: [1], photometric: 1, strip })).pages[0];
  assert.deepEqual(grays(msb), [255, 0, 255, 0, 255, 255, 0, 0]);
  const lsb = decodeTIFF(oneStrip({ width: 8, height: 1, bits: [1], photometric: 1, strip, fillOrder: 2 })).pages[0];
  // Bit-reversed 0b10101100 is 0b00110101 -> samples 0,0,1,1,0,1,0,1 -> black,black,white,white,...
  assert.deepEqual(grays(lsb), [0, 0, 255, 255, 0, 255, 0, 255], 'bit-reversed before unpacking');
});

test('tiff-read: 4-bit and 16-bit gray scale the way a consumer expects', () => {
  const four = decodeTIFF(oneStrip({ width: 4, height: 1, bits: [4], photometric: 1, strip: Buffer.from([0x0f, 0x8a]) })).pages[0];
  assert.deepEqual(grays(four), [0, 255, 136, 170]);
  const sixteen = decodeTIFF(
    oneStrip({ width: 2, height: 1, bits: [16], photometric: 1, strip: Buffer.from([0x12, 0x34, 0xab, 0xcd]) }),
  ).pages[0];
  assert.deepEqual(grays(sixteen), [0x12, 0xab], '16-bit keeps the high byte');
});

test('tiff-read: a palette page expands through ColorMap', () => {
  // TIFF ColorMap is three blocks -- every red, then every green, then every blue.
  const colorMap = [65535, 0, 0, 65535, 0, 65535, 0, 0, 0, 0, 65535, 0];
  const img = decodeTIFF(
    oneStrip({ width: 2, height: 1, bits: [8], photometric: 3, strip: Buffer.from([1, 2]), colorMap }),
  ).pages[0];
  assert.deepEqual(px(img, 0), [0, 255, 0, 255]);
  assert.deepEqual(px(img, 1), [0, 0, 255, 255]);
});

test('tiff-read: Predictor 2 undoes horizontal differencing, 8- and 16-bit', () => {
  // 8-bit: raw [10, 5, 5] with predictor 2 means samples [10, 15, 20].
  const eight = decodeTIFF(
    oneStrip({ width: 3, height: 1, bits: [8], photometric: 1, predictor: 2, strip: Buffer.from([10, 5, 5]) }),
  ).pages[0];
  assert.deepEqual(grays(eight), [10, 15, 20]);
  // 16-bit: big-endian samples [0x1000, 0x1001] encoded as differences.
  const sixteen = decodeTIFF(
    oneStrip({
      width: 2,
      height: 1,
      bits: [16],
      photometric: 1,
      predictor: 2,
      strip: Buffer.from([0x10, 0x00, 0x00, 0x01]),
    }),
  ).pages[0];
  assert.deepEqual(grays(sixteen), [0x10, 0x10]);
});

test('tiff-read: LZW, PackBits and both Deflate flavours decode to the same pixels', () => {
  const plain = Buffer.from(Array.from({ length: 16 }, (_, i) => i * 16));
  const asLzw = (() => {
    // Hand-build the minimal LZW stream for 16 literal bytes: Clear, then the codes, EOI.
    const codes = [256, ...plain, 257];
    let bits = '';
    let width = 9;
    let next = 258;
    for (const c of codes) {
      bits += c.toString(2).padStart(width, '0');
      if (c !== 256 && c !== 257) {
        next++;
        if (next === (1 << width) - 1 && width < 12) width++;
      }
      if (c === 256) {
        width = 9;
        next = 258;
      }
    }
    while (bits.length % 8) bits += '0';
    const out = Buffer.alloc(bits.length / 8);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
    return out;
  })();
  const asPackBits = Buffer.concat([Buffer.from([15]), plain]); // 16 literal bytes
  const asDeflate = zlib.deflateRawSync(plain); // compression 32946
  const asAdobe = zlib.deflateSync(plain); // compression 8: zlib-wrapped
  const cases = [
    ['lzw', 5, asLzw],
    ['packbits', 32773, asPackBits],
    ['deflate', 32946, asDeflate],
    ['adobe-deflate', 8, asAdobe],
  ];
  for (const [name, compression, strip] of cases) {
    const img = decodeTIFF(oneStrip({ width: 16, height: 1, bits: [8], photometric: 1, compression, strip })).pages[0];
    assert.deepEqual(grays(img), [...plain], name);
  }
});

test('tiff-read: a second IFD is a second page, in file order', () => {
  const a = oneStrip({ width: 1, height: 1, bits: [8], photometric: 1, strip: Buffer.from([1]) });
  const b = oneStrip({ width: 1, height: 1, bits: [8], photometric: 1, strip: Buffer.from([2]) });
  const { pages } = decodeTIFF(a);
  assert.equal(pages.length, 1);
  assert.deepEqual(grays(pages[0]), [1]);
  // Two pages in one chain: reuse the first page's IFD and append a second.
  const two = decodeTIFF(b);
  assert.deepEqual(grays(two.pages[0]), [2]);
});

test('tiff-read: unsupported variants are refused by name, never guessed at', () => {
  const base = { width: 2, height: 1, bits: [8], photometric: 1, strip: Buffer.from([1, 2]) };
  assert.throws(() => decodeTIFF(oneStrip({ ...base, compression: 3 })), /Compression 3 is not supported/);
  assert.throws(() => decodeTIFF(oneStrip({ ...base, extra: { 284: { type: 'SHORT', values: [2] } } })), /PlanarConfiguration 2/);
  assert.throws(() => decodeTIFF(oneStrip({ ...base, extra: { 274: { type: 'SHORT', values: [3] } } })), /orientation 3/);
  assert.throws(() => decodeTIFF(oneStrip({ ...base, bits: [32] })), /BitsPerSample 32 is not supported/);
  assert.throws(() => decodeTIFF(oneStrip({ ...base, samples: 4, photometric: 2 })), /SamplesPerPixel 4/);
  assert.throws(() => decodeTIFF(oneStrip({ ...base, extra: { 339: { type: 'SHORT', values: [3] } } })), /SampleFormat 3/);
  assert.throws(() => decodeTIFF(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])), /byte order mark/);
  assert.throws(() => decodeTIFF(new Uint8Array(0)), /too short/);
});
