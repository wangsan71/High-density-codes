/**
 * PSKT receiver self-test -- one body of assertions, run by BOTH hosts.
 *
 * It runs in the browser page (`?selftest=1`) and in Node (tools/check-dist.mjs), so
 * "selftest is green" means the same thing in both places instead of being a claim about
 * whichever host nobody actually executed. This matters here specifically: this machine
 * has no browser automation, so a browser-only self-test could not be verified by me at
 * all -- I would have been shipping an unexecuted green ✓✗
 *
 * Rules this file follows:
 *   - No DOM, no `node:` builtins, no fetch. Anything host-shaped (like loading the
 *     conformance vectors) arrives as an injected loader, and when it is absent the
 *     check reports `skipped`, never `pass`.
 *   - It must contain a check that can FAIL. The last one is the negative control: a
 *     deliberately corrupted transfer must come back either byte-exact or refused, and
 *     returning *some other bytes* is the only outcome that must go red -- because
 *     misacceptance is the single unforgivable failure in this project (PLAN 硬性约束).
 */

const encoder = new TextEncoder();

/** @returns {{name:string,status:'pass'|'fail'|'skipped',detail:string}[]} */
export async function runSelfTests(ctx = {}) {
  const out = [];
  const add = (name, fn) => {
    out.push({ name, status: 'pass', detail: '' });
    return out;
  };
  const { sha256Hex } = await import('../core/hash.js');
  const { crc16, toHex } = await import('../core/crc.js');
  const { compress, decompress } = await import('../core/deflate.js');
  const { rsEncode, rsDecode } = await import('../core/rs.js');
  const { encodeHeader, decodeHeader, HEADER_LEN } = await import('../core/frame.js');
  const { encodeTransfer, TransferAssembler } = await import('../core/protocol.js');
  const { renderPageBitmap, renderSheetBitmap, echoBitsOf } = await import('../core/render/raster.js');
  const { encodePNG } = await import('../core/render/png.js');
  const { decodePNG } = await import('../core/decode/png-read.js');
  const { pageLayout } = await import('../core/render/layout.js');
  const { getPalette } = await import('../core/palette.js');
  const { bootstrapDecode } = await import('../core/decode/bootstrap.js');

  const push = (name, fn) =>
    out.push(
      Promise.resolve()
        .then(fn)
        .then(
          (detail) => ({ name, status: 'pass', detail: String(detail ?? '') }),
          (e) => ({ name, status: 'fail', detail: e && e.message ? e.message : String(e) }),
        ),
    );

  // 1. Hash witnesses. Hard-coded, from an implementation nobody here wrote.
  push('sha256("") = e3b0c442…', () => {
    const want = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    const got = sha256Hex(encoder.encode(''));
    if (got !== want) throw new Error(`got ${got.slice(0, 16)}…`);
    return want.slice(0, 16) + '…';
  });
  push('sha256("abc") = ba7816bf…', () => {
    const want = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
    const got = sha256Hex(encoder.encode('abc'));
    if (got !== want) throw new Error(`got ${got.slice(0, 16)}…`);
    return 'ok';
  });
  // 2. CRC-16/CCITT-FALSE check value, the standard "123456789" witness.
  push('crc16("123456789") = 0x29B1', () => {
    const got = crc16(encoder.encode('123456789'));
    if (got !== 0x29b1) throw new Error(`got 0x${got.toString(16)}`);
    return '0x29b1';
  });
  // 3. RS: correctable case must correct, over-budget case must refuse (not guess).
  //    rsDecode returns {ok, cw, k, n, erasures, errors, clean, reason} -- not a bare
  //    array -- which the first draft of this file got wrong and reported as "returned
  //    nothing". The object shape is what makes the refusal case assertable.
  push('rs corrects 4 errors', async () => {
    const data = new Uint8Array(30).map((_, i) => (i * 7 + 3) & 0xff);
    const nsym = 10;
    const cw = rsEncode(data, nsym);
    const bad = cw.slice();
    for (const at of [2, 9, 17, 28]) bad[at] ^= 0xa5;
    const r = await rsDecode(bad, nsym);
    if (!r.ok) throw new Error(`refused a correctable code: ${r.reason || 'no reason'}`);
    for (let i = 0; i < cw.length; i++) if (r.cw[i] !== cw[i]) throw new Error(`uncorrected at ${i}`);
    return `${nsym} parity, 4 errors -> exact (errors=${r.errors})`;
  });
  push('rs refuses beyond budget', async () => {
    const data = new Uint8Array(30).map((_, i) => (i * 11 + 5) & 0xff);
    const cw = rsEncode(data, 6);
    const bad = cw.slice();
    for (let i = 0; i < 6; i++) bad[i * 4] ^= 0x5a; // 6 errors against nsym 6 (t=3)
    const r = await rsDecode(bad, 6);
    if (r.ok) {
      let same = true;
      for (let i = 0; i < cw.length; i++) if (r.cw[i] !== cw[i]) same = false;
      if (same) throw new Error('an over-budget pattern was "corrected" back to the codeword');
      throw new Error('ok:true with a wrong codeword -- that is a misacceptance');
    }
    return `refused (${r.reason || 'no reason'})`;
  });
  // 4. Container round trip + the length field is load-bearing.
  push('deflate round trip + tamper', () => {
    const raw = encoder.encode('pskt selftest payload '.repeat(400));
    const c = compress(raw);
    const back = decompress(c);
    if (back.length !== raw.length) throw new Error(`length ${back.length} != ${raw.length}`);
    const bad = c.slice();
    bad[6] ^= 0xff;
    let refused = false;
    try {
      decompress(bad);
    } catch {
      refused = true;
    }
    if (!refused) throw new Error('tampered originalLength was accepted');
    return `${raw.length} -> ${c.length} B, tamper refused`;
  });
  // 5. Header self-description: what the page claims must survive encode/decode.
  push('header round trip declares profile', async () => {
    const t = await encodeTransfer(encoder.encode('hello pskt'), { profile: 'P-M1-300' });
    const dec = decodeHeader(t.pages[0].header);
    if (!dec.ok) throw new Error(`decodeHeader: ${dec.reason}`);
    // decodeHeader nests the fields under .header on success (frame.js:104-120); reading
    // dec.profile instead returned undefined and looked like a protocol bug. It was mine.
    const h = dec.header;
    if (h.profile !== 'P-M1-300') throw new Error(`profile decoded as ${h.profile}`);
    if (h.totalPages < 1 || h.payloadLen < 1) throw new Error('header fields not self-consistent');
    return `profile=${h.profile} pages=${h.totalPages} payloadLen=${h.payloadLen}`;
  });
  push('header CRC is load-bearing', async () => {
    const t = await encodeTransfer(encoder.encode('hello pskt'), { profile: 'P-M1-300' });
    const bytes = t.pages[0].header.slice();
    bytes[HEADER_LEN - 3] ^= 0x01; // touch a payload byte, leave the stored CRC stale
    const h = decodeHeader(bytes);
    if (h.ok) throw new Error('a corrupted header decoded successfully');
    return `refused (${h.reason})`;
  });
  // 6-7. End to end, in memory, through the real rasteriser and PNG codec, then decoded
  // by the same bootstrap the browser uses -- no manifest, no sidecar, no URL.
  const e2e = async (label, profile, mono) => {
    const raw = new Uint8Array(6000).map((_, i) => (i * 37 + ((i >> 3) * 11)) & 0xff);
    // Single colour is the renderer's `mono` flag over a one-ink palette; there is no
    // "MONO" palette id (the shipped set is INK2/INK4/PAPER1), and monoSafe's legal value
    // here is 'full' -- both of which the first draft of this file invented wrongly.
    const t = await encodeTransfer(raw, { profile, monoSafe: mono ? 'full' : undefined });
    const paletteId = mono ? 'PAPER1' : 'INK2';
    const prof = (await import('../core/profiles.js')).PROFILES[profile];
    const layout = pageLayout(t.geom, prof.dpi || 300, { sheetMm: t.geom.sheetMm });
    const asm = new TransferAssembler({});
    const pngs = [];
    for (const p of t.pages) {
      const bmp = renderPageBitmap({ geom: t.geom, levels: p.levels, layout, palette: paletteId, mono: !!mono, echoBits: echoBitsOf(p.header) });
      // What a phone photographs is the sheet -- margins, the code area centred on them, crop and
      // registration marks -- because that is what `pskit send` writes since D45 was fixed. A
      // self-test that decodes the bare code area would stay green while proving nothing about the
      // page a user actually prints (DEFECTS D47).
      pngs.push(encodePNG(bmp.sheetMm ? renderSheetBitmap(bmp) : bmp));
    }
    const results = [];
    for (const bytes of pngs) {
      const bmp = decodePNG(bytes);
      const boot = await bootstrapDecode(bmp, { profileHint: profile, dpiHint: prof.dpi || 300, paletteHint: paletteId });
      if (!boot.ok) throw new Error(`bootstrap failed: ${boot.reason} after ${boot.attempts.length} attempts (${boot.attempts.map((a) => `${a.profileId}@${a.dpi}/${a.paletteId}:${a.stage}/${a.reason}`).slice(0, 3).join(' | ')})`);
      if (boot.attemptCount !== 1) throw new Error(`hinted bootstrap took ${boot.attemptCount} attempts, expected the first to match`);
      results.push({ boot, bmp });
    }
    for (const { boot } of results) {
      const fed = await asm.feed({ levels: boot.page.levels, header: boot.page.headerBytes, channelMissing: boot.page.colourAlive ? [] : ['colour'] });
      if (!fed.ok && !fed.duplicate) throw new Error(`feed rejected: ${fed.reason}`);
    }
    if (!asm.result) throw new Error(`no result: ${asm.error || JSON.stringify(asm.progress)}`);
    if (asm.result.length !== raw.length) throw new Error(`length ${asm.result.length} != ${raw.length}`);
    for (let i = 0; i < raw.length; i++) if (asm.result[i] !== raw[i]) throw new Error(`byte ${i} differs`);
    return `${raw.length} B, ${pngs.length} pages, geometry self-recovered${mono ? ' (single colour)' : ''}`;
  };
  push('e2e paper 300 dpi, no manifest', () => e2e('paper', 'P-M1-300', false));
  push('e2e single colour recovers', () => e2e('mono', 'P-M1-300', true));
  // 8. Bootstrapping with no hints at all must still land on the truth, and must land on
  // it by *agreement*, not by being told. So the candidate list is left wide open and the
  // declared profile is checked afterwards. The cap has to clear the other paper
  // profiles that sort ahead of this one -- an earlier draft used 3 and "failed" for
  // that reason alone, which is the difference between a red test and a broken test.
  push('bootstrap honours its cross-check', async () => {
    const raw = encoder.encode('cross check probe');
    const t = await encodeTransfer(raw, { profile: 'P-M1-300' });
    const prof = (await import('../core/profiles.js')).PROFILES['P-M1-300'];
    const layout = pageLayout(t.geom, prof.dpi || 300, { sheetMm: t.geom.sheetMm });
    const bmp = renderPageBitmap({ geom: t.geom, levels: t.pages[0].levels, layout, palette: 'INK2', echoBits: echoBitsOf(t.pages[0].header) });
    const bytes = encodePNG(bmp.sheetMm ? renderSheetBitmap(bmp) : bmp);
    const dec = decodePNG(bytes);
    const ok = await bootstrapDecode(dec, { maxAttempts: 24 });
    if (!ok.ok) throw new Error(`a genuine page did not bootstrap: ${ok.reason} after ${ok.attempts.length} attempts`);
    if (ok.header.profile !== 'P-M1-300') throw new Error(`page declared ${ok.header.profile}`);
    const bad = ok.attempts.filter((a) => a.stage === 'agree');
    return `unhinted: matched on attempt ${ok.attemptCount} in ${ok.ms}ms; ${bad.length} rejected for header disagreement; declared ${ok.header.profile}@${ok.header.nozzleCode}`;
  });
  // 9. NEGATIVE CONTROL -- this check exists so the green above means something.
  // A transfer whose pages have been edited must never come back as different bytes.
  push('corrupted pages never decode into wrong bytes', async () => {
    const raw = new Uint8Array(4000).map((_, i) => (i * 13 + 7) & 0xff);
    const t = await encodeTransfer(raw, { profile: 'P-M1-300' });
    const prof = (await import('../core/profiles.js')).PROFILES['P-M1-300'];
    const layout = pageLayout(t.geom, prof.dpi || 300, { sheetMm: t.geom.sheetMm });
    const asm = new TransferAssembler({});
    let fed = 0;
    for (const p of t.pages) {
      const bmp = renderPageBitmap({ geom: t.geom, levels: p.levels, layout, palette: 'INK2', echoBits: echoBitsOf(p.header) });
      const bytes = encodePNG(bmp.sheetMm ? renderSheetBitmap(bmp) : bmp);
      const dec = decodePNG(bytes);
      const boot = await bootstrapDecode(dec, { profileHint: 'P-M1-300', dpiHint: prof.dpi || 300 });
      if (!boot.ok) continue;
      const levels = boot.page.levels.slice();
      // Wreck a block: flip a contiguous run well past what intra ECC can absorb.
      for (let i = 0; i < 900 && i < levels.length; i++) levels[i] = (levels[i] + 1) & 1;
      const r = await asm.feed({ levels, header: boot.page.headerBytes, channelMissing: boot.page.colourAlive ? [] : ['colour'] });
      if (r.ok) fed++;
    }
    if (asm.result) {
      if (asm.result.length !== raw.length) throw new Error(`accepted ${asm.result.length} B that should have been ${raw.length} B`);
      for (let i = 0; i < raw.length; i++) {
        if (asm.result[i] !== raw[i]) throw new Error(`MISACCEPTANCE: byte ${i} wrong and it was still accepted`);
      }
      return 'ECC absorbed the damage and restored the exact original';
    }
    return `refused cleanly (${fed} page(s) accepted, progress ${JSON.stringify(asm.progress)})`;
  });

  // 10. Conformance vectors, only when the host supplied them. Skipped, never passed.
  if (typeof ctx.loadConformance !== 'function') {
    out.push(Promise.resolve({ name: 'conformance vectors', status: 'skipped', detail: 'host gave no loader (browser needs ?asset=conformance or the build must inline it)' }));
  } else {
    out.push(
      ctx
        .loadConformance()
        .then((doc) => {
          if (!doc || !Array.isArray(doc.vectors)) throw new Error('conformance document has no vectors[]');
          return { name: 'conformance vectors', status: 'pass', detail: `${doc.vectors.length} vectors available` };
        })
        .catch((e) => ({ name: 'conformance vectors', status: 'fail', detail: e.message })),
    );
  }

  const settled = await Promise.all(out.filter((x) => x && typeof x.then === 'function'));
  const inline = out.filter((x) => x && typeof x.then !== 'function');
  const all = [...inline, ...settled].filter(Boolean);
  return all;
}

/** Plain-text rendering, shared by the CLI report and the on-page panel. */
export function formatSelfTests(results) {
  const w = Math.max(...results.map((r) => r.name.length));
  const lines = results.map((r) => `${r.status === 'pass' ? ' ✓' : r.status === 'skipped' ? ' ·' : ' ✗'} ${r.name.padEnd(w)}  ${r.detail}`);
  const n = (s) => results.filter((r) => r.status === s).length;
  lines.push('');
  lines.push(`${n('pass')} passed / ${n('fail')} failed / ${n('skipped')} skipped  ->  ${n('fail') === 0 && n('pass') > 0 ? 'SELFTEST GREEN' : 'SELFTEST NOT GREEN'}`);
  // A run where everything was skipped is not green. That line is the whole point of
  // the file: an unexecuted check must not be able to look like a passing one.
  if (n('pass') === 0) lines.push('  NOTE: nothing actually executed -- this is not a pass.');
  return lines.join('\n');
}
