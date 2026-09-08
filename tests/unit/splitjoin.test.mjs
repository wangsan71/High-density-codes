/**
 * split/join: cutting a file into transfer-sized parts and putting it back (DEFECTS D65's undone item).
 *
 * The point of these tests is not that join concatenates -- it is that join REFUSES. A reassembly tool
 * that can hand back a file which is not the file that was split is worse than no tool, because the user
 * has already done the work of printing, scanning and receiving every part and has no way to tell. So
 * every refusal test here is paired with a positive control proving the same call succeeds on untampered
 * input: without that, a join that always refuses would pass every assertion below.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitParts, joinParts, partName, DEFAULT_PART_BYTES, MANIFEST_KIND } from '../../core/splitjoin.js';
import { sha256Hex } from '../../core/hash.js';

/** Deterministic non-zero filler: an all-zero payload would hide a join that returns zeroes. */
function payload(n, seed = 1) {
  const out = new Uint8Array(n);
  let x = (seed >>> 0) || 1;
  for (let i = 0; i < n; i++) {
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    out[i] = x & 255;
  }
  return out;
}

/** Parts as a directory listing would hand them over: right names, deliberately WRONG order. */
function fromDisk(parts, shuffle = true) {
  const list = parts.map((p) => ({ name: p.name, bytes: p.bytes }));
  if (shuffle && list.length > 1) list.reverse(); // index, not listing order, must decide
  return list;
}

test('split then join returns identical bytes at every interesting size, in shuffled disk order', () => {
  // Small sizes against a 7 B ceiling, so every boundary of the cut arithmetic is hit (0, 1, exactly one
  // part, one over, two parts, a partial last part). The 1.4 MB sizes are checked against the DEFAULT
  // ceiling instead -- cutting them at 7 B would make 200k parts and test nothing new.
  const cases = [
    [0, 7], [1, 7], [6, 7], [7, 7], [8, 7], [9, 7], [1000, 7],
    [DEFAULT_PART_BYTES - 1, DEFAULT_PART_BYTES], [DEFAULT_PART_BYTES, DEFAULT_PART_BYTES],
    [DEFAULT_PART_BYTES + 1, DEFAULT_PART_BYTES], [3 * DEFAULT_PART_BYTES + 5, DEFAULT_PART_BYTES],
  ];
  for (const [n, m] of cases) {
    const bytes = payload(n, 0x1000 + (n % 65536));
    const s = splitParts(bytes, m);
    assert.equal(s.ok, true, `split of ${n} B at ${m} B must succeed`);
    assert.equal(s.parts.length, Math.max(1, Math.ceil(n / m)));
    const j = joinParts(s.manifest, fromDisk(s.parts));
    assert.equal(j.ok, true, `join of ${n} B must succeed: ${j.error ?? ''}`);
    assert.equal(j.bytes.length, n);
    assert.deepEqual(Array.from(j.bytes), Array.from(bytes), `${n} B must come back identical`);
    assert.equal(j.sha256, sha256Hex(bytes));
    assert.equal(j.checked, s.parts.length);
  }
  // The default part size is the one the CLI uses, so check the boundary that matters for a real user:
  // a file just under it is ONE part, one byte over is two.
  assert.equal(splitParts(payload(DEFAULT_PART_BYTES, 7), DEFAULT_PART_BYTES).parts.length, 1);
  assert.equal(splitParts(payload(DEFAULT_PART_BYTES + 1, 7), DEFAULT_PART_BYTES).parts.length, 2);
});

test('parts respect the size ceiling, are named in order, and concatenate to the original', () => {
  const bytes = payload(3500, 99);
  const s = splitParts(bytes, 1000);
  assert.equal(s.parts.length, 4); // 1000+1000+1000+500
  for (const p of s.parts) {
    assert.ok(p.byteLength <= 1000, `part ${p.name} is ${p.byteLength} B, over the 1000 B ceiling`);
    assert.equal(p.name, partName(p.index));
    assert.equal(p.sha256, sha256Hex(p.bytes));
  }
  assert.deepEqual(s.parts.map((p) => p.name), ['part-000.bin', 'part-001.bin', 'part-002.bin', 'part-003.bin']);
  const cat = new Uint8Array(bytes.length);
  let at = 0;
  for (const p of s.parts) { cat.set(p.bytes, at); at += p.bytes.length; }
  assert.deepEqual(Array.from(cat), Array.from(bytes));
  assert.equal(s.manifest.pskt, MANIFEST_KIND);
  assert.equal(s.manifest.source.sha256, sha256Hex(bytes));
  assert.equal(s.manifest.source.byteLength, bytes.length);
  // A view, not a copy: splitting must not allocate a second file's worth of bytes.
  assert.equal(s.parts[0].bytes.buffer, bytes.buffer);
  // Invalid ceiling refused rather than silently defaulted.
  assert.equal(splitParts(bytes, 0).ok, false);
  assert.equal(splitParts(bytes, -5).ok, false);
  assert.equal(splitParts(bytes, 'abc').ok, false);
});

test('join refuses a corrupted part, and the same input joins clean (positive control)', () => {
  const bytes = payload(2500, 5);
  const s = splitParts(bytes, 1000);
  const clean = joinParts(s.manifest, fromDisk(s.parts));
  assert.equal(clean.ok, true, `the control must pass first, or the refusal below proves nothing: ${clean.error}`);

  const tampered = fromDisk(s.parts, false).map((p) => ({ name: p.name, bytes: Uint8Array.from(p.bytes) }));
  tampered[1].bytes[424] ^= 0xff; // one bit-flip's worth of damage, in the middle part
  const j = joinParts(s.manifest, tampered);
  assert.equal(j.ok, false);
  assert.equal(j.bytes, undefined, 'a refused join must hand back no bytes at all');
  assert.match(j.error, /part-001\.bin/);
  assert.match(j.error, /digest/);
  assert.equal(j.checked, 1, 'it verified part 000 and stopped at 001, and says so');

  // Wrong length is caught even if the digest field is not what a truncation would produce.
  const short = fromDisk(s.parts, false).map((p) => ({ name: p.name, bytes: p.bytes }));
  short[2] = { name: short[2].name, bytes: short[2].bytes.subarray(0, 10) };
  const js = joinParts(s.manifest, short);
  assert.equal(js.ok, false);
  assert.match(js.error, /part-002\.bin is 10 B on disk but the manifest says 500 B/);
});

test('join refuses a missing part and names it', () => {
  const bytes = payload(2500, 6);
  const s = splitParts(bytes, 1000);
  assert.equal(joinParts(s.manifest, fromDisk(s.parts)).ok, true); // control
  const listed = fromDisk(s.parts, false).filter((p) => p.name !== 'part-002.bin');
  const j = joinParts(s.manifest, listed);
  assert.equal(j.ok, false);
  assert.equal(j.bytes, undefined);
  assert.match(j.error, /missing part part-002\.bin \(index 2\)/);
  assert.equal(j.checked, 2, 'two parts verified before the gap was hit');
  // An extra, unlisted file in the directory must not change anything either way.
  const extra = [...fromDisk(s.parts, false), { name: 'part-999.bin', bytes: payload(50, 1) }];
  assert.equal(joinParts(s.manifest, extra).ok, true);
});

test('join refuses parts that are individually perfect but are not the manifest\'s file', () => {
  const bytes = payload(1500, 7);
  const s = splitParts(bytes, 1000);
  const other = splitParts(payload(1500, 8), 1000); // same sizes, different content
  assert.equal(joinParts(s.manifest, fromDisk(s.parts)).ok, true); // control
  // Swap in another split's parts: every digest check passes only if the manifest is swapped too, so
  // this is the case where the parts are self-consistent and the whole-file digest is the only net.
  const j = joinParts(s.manifest, fromDisk(other.parts));
  assert.equal(j.ok, false);
  assert.match(j.error, /part-000\.bin digest/);
  // And the nastier version: parts and their digests all agree, but the source digest was rewritten.
  const lied = JSON.parse(JSON.stringify(s.manifest));
  lied.source.sha256 = sha256Hex(payload(1500, 8));
  const j2 = joinParts(lied, fromDisk(s.parts));
  assert.equal(j2.ok, false);
  assert.equal(j2.bytes, undefined);
  assert.match(j2.error, /every part verified, but together they are/);
  assert.equal(j2.checked, s.parts.length, 'it checked every part and still refused');
});

test('join refuses a manifest it cannot trust, instead of guessing', () => {
  const bytes = payload(1200, 9);
  const s = splitParts(bytes, 1000);
  const good = fromDisk(s.parts);
  assert.equal(joinParts(s.manifest, good).ok, true); // control

  assert.equal(joinParts(null, good).ok, false);
  assert.equal(joinParts({}, good).ok, false);
  assert.match(joinParts({ pskt: 'split/2', parts: [], source: {} }, good).error, /not a pskit split manifest/);
  assert.match(joinParts({ ...s.manifest, parts: [] }, good).error, /lists no parts/);
  assert.match(joinParts({ ...s.manifest, source: { sha256: 'nope' } }, good).error, /not a 64-hex digest/);

  // A gap in the indexes would silently drop a part, so it is refused before any digest is computed.
  const gapped = JSON.parse(JSON.stringify(s.manifest));
  gapped.parts = [gapped.parts[0], { ...gapped.parts[1], index: 2 }];
  const jg = joinParts(gapped, good);
  assert.equal(jg.ok, false);
  assert.match(jg.error, /indexes must be 0\.\.1 in order/);
  assert.equal(jg.checked, 0);

  // The same part listed twice would let one file stand in for two.
  const dup = JSON.parse(JSON.stringify(s.manifest));
  dup.parts[1] = { ...dup.parts[0], index: 1 };
  assert.match(joinParts(dup, good).error, /lists part-000\.bin twice/);
});
