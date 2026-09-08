/**
 * DEFECTS D55's root cause, pinned.
 *
 * The symptom, measured in round 65 on a real 600 dpi scan, was an exception escaping the decoder:
 * "joinCellLevels: colour level 2 out of range 0..1". Round 65 contained it -- bootstrapDecode now
 * catches a throwing candidate and records it -- but the cause stayed open. It is this: nearestInk
 * returns an INDEX INTO THE PALETTE, joinCellLevels validates against the GEOMETRY's colour-channel
 * level count, and candidatePlans crosses every profile with INK2/INK4/PAPER1 without checking that
 * the palette offers no more inks than the channel has levels. Two of the thirty combinations are
 * mismatched, both against INK4: P-C4-600 and PL-D2, each declaring two colour levels.
 *
 * Why the fix is a restriction rather than a removal: a page CAN be encoded with a 2-level colour
 * channel under INK4 -- the encoder prints pal.inks[level % inks.length], so levels 0 and 1 use inks 0
 * and 1 -- which means dropping those candidates would change verdicts and lose pages that exist.
 * Searching only the addressable inks is symmetric with the encoder instead, and it is a no-op wherever
 * palette and geometry already agree. Both halves are asserted below, the no-op half over the real
 * candidate list rather than over a hand-picked pair.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { nearestInk, inkSpread } from '../../core/decode/ideal.js';
import { getPalette } from '../../core/palette.js';
import { planPage } from '../../core/profiles.js';
import { candidatePlans } from '../../core/decode/bootstrap.js';
import { joinCellLevels } from '../../core/protocol.js';

/** The colour channel a candidate's geometry declares, or null when it has none. planPage legitimately
 *  refuses some nozzle/pitch pairs; those candidates are not this test's business. */
function colourLevelsOf(c) {
  try {
    const g = planPage(c.profileId, { nozzle: c.nozzle ?? undefined, plateMm: c.plateMm ?? undefined });
    const ch = (g.channels || []).find((x) => x.name === 'colour');
    return ch ? { geom: g, levels: ch.levels } : null;
  } catch {
    return null;
  }
}

test('D55: the mismatch is real, and the unrestricted index really is out of range for the geometry', () => {
  const ink4 = getPalette('INK4');
  const g = planPage('P-C4-600');
  const colour = g.channels.find((c) => c.name === 'colour');
  assert.equal(ink4.inks.length, 4, 'INK4 offers four inks');
  assert.equal(colour.levels, 2, 'P-C4-600 declares two colour levels');

  // Positive control. Without it the rest of this file proves nothing: if the unrestricted search did
  // not return an out-of-range index, there would be no bug to fix and no reason for the limit.
  const unrestricted = nearestInk([20, 20, 20], ink4);
  assert.equal(unrestricted, 3, "unrestricted, INK4's fourth ink is nearest to near-black");
  assert.ok(unrestricted >= colour.levels, '...and that index is out of range for this geometry');
  assert.throws(
    () => joinCellLevels({ shape: 1, colour: unrestricted }, g),
    /colour level 3 out of range 0\.\.1/,
    'the unrestricted index is exactly what used to reach joinCellLevels and throw'
  );

  // The fix: restricted to the addressable inks, no measurable colour can yield an unholdable level.
  for (let r = 0; r <= 255; r += 15) {
    for (let gg = 0; gg <= 255; gg += 15) {
      for (let b = 0; b <= 255; b += 15) {
        const lv = nearestInk([r, gg, b], ink4, colour.levels);
        assert.ok(lv >= 0 && lv < colour.levels, `nearestInk([${r},${gg},${b}], INK4, 2) = ${lv}`);
        assert.doesNotThrow(() => joinCellLevels({ shape: 1, colour: lv }, g));
      }
    }
  }
  // A limit of 0 -- what a caller with no colour channel would pass -- still yields a valid index.
  assert.equal(nearestInk([20, 20, 20], ink4, 0), 0);
});

test('D55: restricting is a no-op for every candidate whose palette and geometry already agree', () => {
  const probes = [[0, 0, 0], [255, 255, 255], [20, 20, 20], [14, 158, 196], [196, 22, 140], [230, 212, 12], [128, 64, 32]];
  let checked = 0;
  for (const c of candidatePlans()) {
    for (const paletteId of ['INK2', 'INK4', 'PAPER1']) {
      const cl = colourLevelsOf({ ...c, paletteId });
      if (!cl) continue; // no colour channel, or planPage refused this nozzle/pitch pair
      const pal = getPalette(paletteId);
      if (pal.inks.length > cl.levels) continue; // the mismatched pairs: the previous test owns those
      for (const rgb of probes) {
        assert.equal(
          nearestInk(rgb, pal, cl.levels),
          nearestInk(rgb, pal),
          `${paletteId} under ${c.profileId} at ${JSON.stringify(rgb)}`
        );
      }
      checked++;
    }
  }
  // Guard against the loop quietly checking nothing, which would make this test vacuous.
  assert.ok(checked > 20, `only ${checked} agreeing candidates were compared; the candidate list changed shape`);
});

test('D55: exactly two profile x palette combinations are mismatched, and both are INK4 against 2 levels', () => {
  const seen = new Map();
  for (const c of candidatePlans()) {
    const key = `${c.profileId}|${c.paletteId}`;
    if (seen.has(key)) continue;
    const cl = colourLevelsOf(c);
    if (!cl) continue;
    seen.set(key, { key, levels: cl.levels, inks: getPalette(c.paletteId).inks.length });
  }
  const bad = [...seen.values()].filter((r) => r.inks > r.levels);
  assert.deepEqual(
    bad.map((r) => `${r.key} (${r.levels} levels < ${r.inks} inks)`).sort(),
    ['P-C4-600|INK4 (2 levels < 4 inks)', 'PL-D2|INK4 (2 levels < 4 inks)'],
    'if this list grows, a new profile or palette reintroduced the mismatch: read the nearestInk comment'
  );
});

test('D55: inkSpread reports against the same inks the decision searched', () => {
  // This function had no caller anywhere in the repo while its own comment claimed it was "kept and
  // exercised", so the claim was false. It is exercised now, and the limit keeps the report from
  // contradicting the decision it describes.
  const pal = getPalette('INK4');
  const cells = [{ ink: [14, 158, 196] }, { ink: [196, 22, 140] }, { ink: null }, { ink: [20, 20, 20] }];
  const full = inkSpread(cells, pal);
  const restricted = inkSpread(cells, pal, 2);
  assert.equal(full, 0, 'every cell matches some INK4 entry exactly, so the full-palette spread is 0');
  assert.ok(restricted > 0 && Number.isFinite(restricted), 'restricted, the near-black cell has to be reported against ink 0 or 1');
  assert.notEqual(restricted, full, 'the report describes the decision, not a palette nobody used');
  assert.equal(inkSpread([{ ink: [14, 158, 196] }], pal, 2), 0, 'an exact match among the addressable inks costs nothing');
  assert.equal(inkSpread([], pal, 2), 1, 'no cells: the documented neutral value');
});
