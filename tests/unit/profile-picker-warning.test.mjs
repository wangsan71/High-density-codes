/**
 * Guard for the user-facing half of D49.
 *
 * The sender page builds its profile dropdown from *every* profile in core/profiles.js, so the
 * 600 dpi paper profiles -- which the G2 gate measured at 162/200 byte-exact with only 43% of pages
 * read directly -- are one click away from a user who reads no source. `web/sender.js` now labels
 * them at the point of choice instead of hiding them.
 *
 * Anti-vacuity, and the reason this test exists in this shape: I originally recorded in the ledger
 * that "the web sender does not offer P-M1-600" because `grep P-M1-600 web/` found nothing -- while
 * the list is built with `Object.entries(PROFILES)`, so the id never appears as a literal. A text
 * scan can prove a string is present; it cannot prove a *dynamically built* list omits an item. So
 * this test asserts on the labels the picker actually renders, requires the flagged set to be
 * non-empty, requires the specific measured profile to be in it, and requires the qualified
 * profiles to stay unlabelled (otherwise the warning is noise and users learn to ignore it).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PROFILES } from '../../core/profiles.js';
import { isUnqualifiedPaper, profileOptionLabel } from '../../web/sender.js';

const entries = Object.entries(PROFILES);
const flagged = entries.filter(([, p]) => isUnqualifiedPaper(p));

test('the flagged set is exactly the 600 dpi paper profiles, and it is not empty', () => {
  // An empty set would make every other assertion here pass without labelling anything.
  assert.ok(flagged.length >= 1, 'nothing is flagged -- the warning label would never be rendered');
  for (const [id, p] of flagged) {
    assert.notEqual(p.medium, 'plate', `${id} is a plate profile and must not be flagged as paper`);
    assert.ok(p.dpi >= 600, `${id} is flagged at ${p.dpi} dpi`);
  }
  // Positive control: the profile the failing G2 run actually used must be in the set.
  assert.ok(
    flagged.some(([id]) => id === 'P-M1-600'),
    'P-M1-600 -- the profile the 600 dpi G2 batch was judged on -- is not flagged',
  );
});

test('every flagged profile carries the warning, and keeps its id and medium in the label', () => {
  for (const [id, p] of flagged) {
    const label = profileOptionLabel(id, p);
    assert.match(label, /未达标/, `${id}: label carries no warning: ${label}`);
    assert.match(label, /D49/, `${id}: label does not point at the ledger entry: ${label}`);
    assert.ok(label.startsWith(id), `${id}: label lost the profile id: ${label}`);
    assert.match(label, /纸/, `${id}: label lost the medium word: ${label}`);
    // The measured numbers belong in the ledger, not in the UI string, so the UI cannot go stale.
    assert.ok(!/\d{2,}\/\d{2,}/.test(label), `${id}: label hardcodes a ratio that will rot: ${label}`);
  }
});

test('qualified profiles are NOT warned (negative control)', () => {
  let checked = 0;
  for (const [id, p] of entries) {
    if (isUnqualifiedPaper(p)) continue;
    const label = profileOptionLabel(id, p);
    assert.ok(!/未达标/.test(label), `${id}: warned although not in the flagged set: ${label}`);
    assert.ok(label.startsWith(id), `${id}: label lost the profile id: ${label}`);
    checked++;
  }
  assert.ok(checked >= 1, 'no qualified profile was checked -- the negative control is vacuous');
  // The profile the manual tells users to use must exist and stay clean.
  assert.ok(PROFILES['P-M1-300'], 'P-M1-300 is missing from core/profiles.js');
  assert.ok(!/未达标/.test(profileOptionLabel('P-M1-300', PROFILES['P-M1-300'])));
});

test('the picker renders through the helper, and the warning text lives in exactly one place', () => {
  const src = readFileSync(new URL('../../web/sender.js', import.meta.url), 'utf8');
  assert.match(
    src,
    /o\.textContent = profileOptionLabel\(id, p\);/,
    'sender.js no longer builds its dropdown labels through profileOptionLabel -- the warning can be bypassed',
  );
  assert.equal(
    (src.match(/未达标/g) || []).length,
    1,
    'the warning wording must live in exactly one place (the helper) so it cannot drift',
  );
});
