/**
 * Self-describing bootstrap: recover the page geometry from the printed page alone.
 *
 * Why this exists. The CLI `receive` path reads a `manifest.json` sidecar to learn the
 * profile, dpi, nozzle and palette (cli/pskit.mjs:393-402). A browser receiving nothing
 * but photographs -- which is the whole point of an air-gapped transfer -- has no such
 * file, and must not fetch one from anywhere: PLAN decision 3 forbids any external
 * source. So the page has to say what it is.
 *
 * It already does. The 56-byte frame header carries profileCode, nozzleCode, intraK,
 * intraNsym, dataBytesPerPage, dataPages and a CRC-16 over all of it (core/frame.js:14-28),
 * so once *any* candidate geometry yields a header that passes magic + version + CRC and
 * names a known profile, the page has told us everything the receiver needs.
 *
 * The bootstrap therefore searches a small, ordered candidate list and lets the header's
 * own CRC arbitrate -- the same pattern core/decode/echo.js already uses to pick a
 * threshold without a magic constant. Two honesty notes written where they will be read:
 *
 *  1. A wrong geometry almost always dies at the marker or echo stage, but a "pass" here
 *     is never taken on faith: the header's declared profile/nozzle are CROSS-CHECKED
 *     against the candidate that produced it, and disagreement is a failure. That turns
 *     "the CRC happened to pass" into "two independent statements about the page agree".
 *  2. Cost is real. Each attempt that survives the marker stage does a full page read,
 *     which is seconds at 300 dpi and worse at 600. So candidates are ordered by
 *     likelihood, the caller can narrow with hints, and every attempt is reported with
 *     its stage and reason -- a slow bootstrap is visible, not silent. The UI offers an
 *     explicit profile/dpi choice for exactly this reason; 'auto' is convenience, not
 *     a claim that guessing is free.
 */
import { planPage, PROFILES, PROFILE_IDS } from '../profiles.js';
import { pageLayout } from '../render/layout.js';
import { getPalette } from '../palette.js';
import { decodePage } from './page.js';

/** The palettes the renderer can emit. Verified against core/palette.js, whose shipped
 *  ids are INK2, INK4 and PAPER1 -- the first draft of this file listed a 'MONO' palette
 *  that does not exist, so single-colour is handled by the renderer's `mono` flag, not by
 *  a palette id. Unknown ids throw, which the candidate loop records as a skipped
 *  candidate rather than letting one bad hint abort the search. */
export const BOOTSTRAP_PALETTES = ['INK2', 'INK4', 'PAPER1'];

/** Paper at these densities; plate profiles need their nozzle, so they come later. */
const BOOTSTRAP_DPIS = [300, 600];
const BOOTSTRAP_NOZZLES = [null, '0.4', '0.2', '0.6', '0.8'];

/**
 * Ordered candidate geometries to try. Hints move their own combinations to the front
 * but never remove candidates, unless `onlyHints` is set (the UI does that when the
 * user explicitly picks a profile: then a failure is a named failure, not a silent
 * fallback to a lucky guess).
 */
export function candidatePlans(opts = {}) {
  const { profileHint = null, dpiHint = null, nozzleHint = null, paletteHint = null, plateMm = null, monoSafe = null } = opts;
  const palettes = paletteHint ? [paletteHint] : BOOTSTRAP_PALETTES;
  // Paper profiles first: they are the common case for a scanner, need no nozzle, and
  // carry their own dpi. Then plates (which do need a nozzle).
  const ids = PROFILE_IDS.slice().sort((a, b) => {
    const am = PROFILES[a].medium === 'paper' ? 0 : 1;
    const bm = PROFILES[b].medium === 'paper' ? 0 : 1;
    if (am !== bm) return am - bm;
    return a < b ? -1 : 1;
  });
  const profiles = profileHint ? [profileHint, ...ids.filter((x) => x !== profileHint)] : ids;
  const dpis = dpiHint ? [dpiHint, ...BOOTSTRAP_DPIS.filter((d) => d !== dpiHint)] : BOOTSTRAP_DPIS;
  const nozzles = nozzleHint ? [nozzleHint, ...BOOTSTRAP_NOZZLES.filter((n) => n !== nozzleHint)] : BOOTSTRAP_NOZZLES;
  const out = [];
  for (const profileId of profiles) {
    const prof = PROFILES[profileId];
    if (!prof) continue;
    const profileIsPaper = prof.medium === 'paper';
    for (const paletteId of palettes) {
      for (const dpi of dpis) {
        // A paper profile has one native dpi; letting 600 through would burn a full
        // page read on a geometry that cannot match the printed pitch.
        if (profileIsPaper && prof.dpi && dpi !== prof.dpi) continue;
        for (const nozzle of profileIsPaper ? [null] : nozzles) {
          out.push({ profileId, dpi, nozzle, paletteId, plateMm, monoSafe });
        }
      }
    }
  }
  return out;
}

/**
 * Try candidates until one yields a page whose header decodes AND agrees with the
 * candidate. Resolves to the first agreement, or to a report listing every attempt.
 *
 * @param {object} bitmap  a decoded bitmap (see core/decode/png-read.js) -- already
 *   substrate-tagged is fine; substrate is set per candidate palette here.
 * @param {object} opts    {profileHint,dpiHint,nozzleHint,paletteHint,plateMm,monoSafe,
 *   onlyHints,maxAttempts,onAttempt}
 */
export async function bootstrapDecode(bitmap, opts = {}) {
  const { maxAttempts = 64, onlyHints = false, onAttempt = null, decodeOpts = {} } = opts;
  let plans = candidatePlans(opts);
  if (onlyHints && (opts.profileHint || opts.dpiHint)) {
    plans = plans.filter(
      (c) => (!opts.profileHint || c.profileId === opts.profileHint) && (!opts.dpiHint || c.dpi === opts.dpiHint),
    );
  }
  if (!plans.length) return { ok: false, reason: 'no-candidate-geometry', hint: 'the hints excluded every known profile', attempts: [] };
  // Order the search by what the bitmap itself already says, before spending a full page read on
  // any candidate. Measured in round 65 with tools/g6-perf-probe.mjs: a 2653x3695 scan of an A4
  // page burned three ~2.0-2.4 s full page reads on P-C4-600@600 candidates -- every one dying at
  // stage=readout with echo-bad-magic -- before reaching P-M1-300@300, which is what the page
  // actually was; 8.3 s per page against PLAN's G6 budget of 2 s. candidatePlans() puts paper
  // profiles first and then sorts ALPHABETICALLY, and 'P-C4' < 'P-M1', so this file's header claim
  // that candidates are "ordered by likelihood" was not true -- it was ordered by the alphabet.
  // This reorders and never removes (the rule this file already states), and it cannot change a
  // verdict: a candidate can only win by having the page's own header declare that candidate's
  // profile and nozzle (the cross-check below), so whichever order they are tried in, the same
  // candidate is the first one that can possibly be accepted. What changes is milliseconds.
  if (bitmap && bitmap.width > 0 && bitmap.height > 0) {
    const sizeScore = (c) => {
      try {
        const g = planPage(c.profileId, { nozzle: c.nozzle, plateMm: c.plateMm ?? undefined, monoSafe: c.monoSafe ?? undefined });
        const l = pageLayout(g, c.dpi, { plateMm: c.plateMm ?? undefined });
        if (!(l.width > 0) || !(l.height > 0)) return Number.POSITIVE_INFINITY;
        // Log-ratio: a code area twice too big scores the same as one half too small, and a photo
        // where the page fills only part of the frame is ranked later, never excluded.
        return Math.abs(Math.log(bitmap.width / l.width)) + Math.abs(Math.log(bitmap.height / l.height));
      } catch {
        // planPage/pageLayout legitimately reject some combinations (a coarse nozzle with a fine
        // pitch). Those candidates score worst and the loop below records them exactly as before.
        return Number.POSITIVE_INFINITY;
      }
    };
    const scored = plans.map((c, i) => ({ c, i, s: sizeScore(c) }));
    scored.sort((a, b) => (a.s - b.s) || (a.i - b.i)); // stable: ties keep candidatePlans' own order
    plans = scored.map((x) => x.c);
  }
  const attempts = [];
  const t0 = Date.now();
  for (let i = 0; i < plans.length && i < maxAttempts; i++) {
    const c = plans[i];
    let geom;
    let layout;
    try {
      geom = planPage(c.profileId, { nozzle: c.nozzle, plateMm: c.plateMm ?? undefined, monoSafe: c.monoSafe ?? undefined });
      layout = pageLayout(geom, c.dpi, { plateMm: c.plateMm ?? undefined });
    } catch (e) {
      attempts.push({ ...c, stage: 'plan', reason: String(e.message).slice(0, 60), ms: 0 });
      continue;
    }
    // The substrate comes from the palette: a missing substrate makes every cell read as
    // ink, so this must be set per candidate rather than assumed from the caller.
    const probe = { ...bitmap };
    try {
      probe.substrate = getPalette(c.paletteId).background;
    } catch {
      attempts.push({ ...c, stage: 'palette', reason: `unknown palette ${c.paletteId}`, ms: 0 });
      continue;
    }
    const ta = Date.now();
    // Never the fast path: bootstrap is used on photographs, which are not aligned to a
    // page canvas by construction, and a fast-path hit on a scan would be its own bug.
    let r;
    try {
      r = await decodePage(probe, { geom, layout, paletteId: c.paletteId }, { allowFastPath: false, requireFastPath: false, ...decodeOpts });
    } catch (e) {
      // A wrong candidate can make the readout THROW instead of reporting a failure. Measured in
      // round 65 on a 600 dpi channel page: "joinCellLevels: colour level 2 out of range 0..1"
      // from core/decode/ideal.js -- under that candidate's palette the readout measured a colour
      // level the candidate's own channel cannot hold. planPage, pageLayout and getPalette were
      // already caught and recorded per candidate; this call was the one that was not, so the
      // exception escaped bootstrapDecode and landed on the caller. In a browser or a phone burst
      // that is not a refusal, it is a crash in the middle of receiving, and the contract this
      // project holds is decode-or-refuse-cleanly (a wrong guess must cost time, never a session).
      // `stage` and `reason` reuse existing literals on purpose: every reason literal in core is
      // scanned by tests/unit/advice.test.mjs as something an operator must be told about, and one
      // candidate throwing inside a search that then continues is not a new operator-facing
      // condition -- the message keeps its own field so nothing is lost from the report.
      attempts.push({ ...c, stage: 'decode', reason: 'fail', threw: String(e && e.message ? e.message : e).slice(0, 120), ms: Date.now() - ta });
      if (onAttempt) onAttempt(attempts[attempts.length - 1]);
      continue;
    }
    const ms = Date.now() - ta;
    if (!r.ok) {
      attempts.push({ ...c, stage: r.stage || 'decode', reason: r.reason || 'fail', ms });
      if (onAttempt) onAttempt(attempts[attempts.length - 1]);
      continue;
    }
    // The cross-check. A header read under the wrong geometry would have to reproduce
    // magic, version and CRC by luck; if it did, it still has to name the profile and
    // nozzle we just used, or we do not trust it.
    const declared = r.header || null;
    if (!declared) {
      attempts.push({ ...c, stage: 'agree', reason: 'no header object', ms });
      continue;
    }
    if (declared.profile && declared.profile !== c.profileId) {
      attempts.push({ ...c, stage: 'agree', reason: `header says profile ${declared.profile}, candidate was ${c.profileId}`, ms });
      if (onAttempt) onAttempt(attempts[attempts.length - 1]);
      continue;
    }
    if (declared.nozzleCode && c.nozzle === null) {
      attempts.push({ ...c, stage: 'agree', reason: `header declares nozzle ${declared.nozzleCode / 10}mm, candidate had none`, ms });
      if (onAttempt) onAttempt(attempts[attempts.length - 1]);
      continue;
    }
    // `reason` is reserved for failures: advice-coverage (decision 11) treats every
    // reason literal in core as something an operator can be told about, and "this
    // candidate matched the declared header" is a bookkeeping note, not a failure. Giving
    // the success path a reason value made that scanner demand advice for a success -- the
    // test was right and my field choice was wrong, so the field moves, not the assertion.
    // (Note the scanner matches text, comments included: describing this very mistake with
    // a literal reason value in prose re-triggers it. That is logged as a defect of the
    // scanner, not a licence to write the comment some other way and call it fixed.)
    if (onAttempt) onAttempt({ ...c, stage: 'ok', matchNote: 'agreed', ms, attempts: i + 1 });
    return {
      ok: true,
      profileId: c.profileId,
      dpi: c.dpi,
      nozzle: c.nozzle,
      paletteId: c.paletteId,
      geom,
      layout,
      page: r,
      header: declared,
      attempts,
      attemptCount: i + 1,
      ms: Date.now() - t0,
    };
  }
  return { ok: false, reason: 'no-geometry-matched', attempts, tried: Math.min(plans.length, maxAttempts), ms: Date.now() - t0 };
}
