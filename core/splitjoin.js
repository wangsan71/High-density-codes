/**
 * Cutting one file into parts that each fit inside a single transfer, and putting them back together.
 *
 * Why this exists. One transfer is at most 255 pages, because a page header stores totalPages in ONE
 * byte (core/frame.js:19), and the inter-page parity pages take slots out of that: P-M1-300 at its
 * default 20% parity carries 1,592,968 B of payload deflate cannot shrink (measured in round 71; the
 * arithmetic lives in web/sender.js `transferBudget`, pinned to the encoder's own output by
 * tools/smoke-sender.mjs). So a file bigger than that cannot go as one transfer, and the sender says so
 * with numbers -- but "split it into parts" is advice a user cannot follow unless something splits the
 * file AND something puts the parts back with the same integrity discipline the receiver has. This is
 * that pair. It is the item D65 recorded as still undone: the documented escape route was a dead end.
 *
 * Shape: pure functions over bytes, no `node:` builtins and no IO, so the CLI stays thin glue and the
 * arithmetic is testable in process (the same split that made D61/D63/D65 verifiable). `splitParts`
 * hands back VIEWS into the input (`subarray`), so cutting a large file allocates nothing; the caller
 * writes each view and can drop it.
 *
 * The integrity rule is this repo's: a wrong answer is the only unforgivable outcome. So `joinParts`
 * verifies every part's digest AND the whole file's digest, and on any mismatch returns ok:false with
 * NO bytes -- the caller then writes nothing. There is deliberately no "join what we have": a file
 * missing one part is not a shorter file, it is a different file, and handing it over would be exactly
 * the "looks like success but is wrong" outcome core/decode refuses.
 *
 * What this does NOT do: it does not chain transfers. Each part is an independent transfer with its own
 * pages, its own parity and its own digest gate; the user sends and receives them one at a time and then
 * joins the received files. Nothing here is transmitted -- the manifest stays on the sending machine,
 * which is also why `--passphrase` transfers work unchanged (each part is encrypted by its own send).
 */
import { sha256Hex } from './hash.js';

/**
 * Default part size. P-M1-300 at its default 20% parity carries 1,592,968 B (round 71, measured against
 * the encoder), so 1.4 MB leaves ~12% of headroom for a profile or parity setting that carries slightly
 * less. A denser profile carries more and the user may raise this; `pskit send` refuses with numbers if
 * a part is still too big, so guessing high costs a sentence and never a wrong artifact.
 */
export const DEFAULT_PART_BYTES = 1400000;

/** Part file names sort into transfer order in any file manager: part-000.bin, part-001.bin, ... */
export function partName(index) {
  return `part-${String(index).padStart(3, '0')}.bin`;
}

/** The manifest's format marker. joinParts refuses anything else rather than guessing at a layout. */
export const MANIFEST_KIND = 'split/1';

function concat(list) {
  let total = 0;
  for (const b of list) total += b.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const b of list) {
    out.set(b, at);
    at += b.length;
  }
  return out;
}

/**
 * {ok:true, parts, manifest} or {ok:false, error}.
 *
 * An empty file yields ONE empty part, so `join` is total: there is no input for which split succeeds
 * and join then has nothing to say. Every part carries its own digest, and the manifest carries the
 * whole file's, so join can tell "a part is corrupt" from "the parts are fine but this is not the file
 * the manifest was written for".
 */
export function splitParts(bytes, maxBytes = DEFAULT_PART_BYTES) {
  const m = Math.floor(Number(maxBytes));
  if (!(m > 0)) return { ok: false, error: `maxBytes must be a positive integer, got ${maxBytes}` };
  if (!bytes || typeof bytes.length !== 'number') return { ok: false, error: 'splitParts needs the file bytes' };
  const n = bytes.length;
  const count = Math.max(1, Math.ceil(n / m));
  const parts = [];
  for (let i = 0; i < count; i++) {
    const slice = bytes.subarray(i * m, Math.min(n, (i + 1) * m));
    parts.push({ index: i, name: partName(i), bytes: slice, byteLength: slice.length, sha256: sha256Hex(slice) });
  }
  const manifest = {
    pskt: MANIFEST_KIND,
    source: { byteLength: n, sha256: sha256Hex(bytes) },
    maxBytes: m,
    parts: parts.map((p) => ({ index: p.index, name: p.name, byteLength: p.byteLength, sha256: p.sha256 })),
  };
  return { ok: true, parts, manifest };
}

/**
 * {ok:true, bytes, checked, sha256} or {ok:false, error, checked}.
 *
 * `parts` is a list of {name, bytes} exactly as read from disk. Their ORDER IN THE LIST DOES NOT MATTER:
 * the manifest's index decides, because a file browser or a shell glob that sorts differently must not
 * be able to reorder somebody's file. `checked` counts the parts whose digest was verified before the
 * outcome, so a refusal can say how far it got instead of leaving the user to guess which part is bad.
 */
export function joinParts(manifest, parts) {
  if (!manifest || manifest.pskt !== MANIFEST_KIND) {
    const got = manifest && manifest.pskt !== undefined ? JSON.stringify(manifest.pskt) : 'missing';
    return { ok: false, error: `not a pskit split manifest: pskt is ${got}, expected "${MANIFEST_KIND}"`, checked: 0 };
  }
  const want = Array.isArray(manifest.parts) ? manifest.parts : [];
  if (!want.length) return { ok: false, error: 'manifest lists no parts', checked: 0 };
  const src = manifest.source;
  if (!src || typeof src.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(src.sha256)) {
    return { ok: false, error: 'manifest.source.sha256 is missing or is not a 64-hex digest', checked: 0 };
  }
  // Validate the manifest against itself before trusting any of it: a gap or a repeat in the indexes
  // would silently drop or duplicate bytes, and a duplicate name would let one part stand in for two.
  const seenNames = new Set();
  for (let i = 0; i < want.length; i++) {
    const w = want[i];
    if (!w || w.index !== i) {
      return { ok: false, error: `manifest part at position ${i} has index ${w ? w.index : 'none'}: indexes must be 0..${want.length - 1} in order, or a part would be silently dropped or reordered`, checked: 0 };
    }
    if (typeof w.name !== 'string' || !w.name) return { ok: false, error: `manifest part ${i} has no name`, checked: 0 };
    if (seenNames.has(w.name)) return { ok: false, error: `manifest lists ${w.name} twice: one part would stand in for two`, checked: 0 };
    seenNames.add(w.name);
    if (!(w.byteLength >= 0) || typeof w.sha256 !== 'string') {
      return { ok: false, error: `manifest part ${i} (${w.name}) has no byteLength or no digest`, checked: 0 };
    }
  }
  const byName = new Map();
  for (const p of parts || []) if (p && typeof p.name === 'string') byName.set(p.name, p.bytes);
  const ordered = [];
  let checked = 0;
  for (const w of want) {
    const got = byName.get(w.name);
    if (!got) return { ok: false, error: `missing part ${w.name} (index ${w.index})`, checked };
    if (got.length !== w.byteLength) {
      return { ok: false, error: `part ${w.name} is ${got.length} B on disk but the manifest says ${w.byteLength} B`, checked };
    }
    const hex = sha256Hex(got);
    if (hex !== w.sha256) {
      return { ok: false, error: `part ${w.name} digest ${hex} does not match the manifest's ${w.sha256}`, checked };
    }
    ordered.push(got);
    checked++;
  }
  const bytes = concat(ordered);
  const whole = sha256Hex(bytes);
  const lenBad = typeof src.byteLength === 'number' && bytes.length !== src.byteLength;
  if (lenBad || whole !== src.sha256) {
    return {
      ok: false,
      error: `every part verified, but together they are ${bytes.length} B / ${whole} while the manifest's source is ${src.byteLength} B / ${src.sha256}`,
      checked,
    };
  }
  return { ok: true, bytes, checked, sha256: whole };
}
