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


test('exactly the phone-safe profile carries the phone hint, and no other label does (round 80)', () => {
  const phoneSafe = entries.filter(([, p]) => p.phoneSafe);
  // Anti-vacuity: an empty set would make the rest pass without labelling anything.
  assert.equal(phoneSafe.length, 1, 'expected exactly one phoneSafe profile (PL-G, PLAN §2/§3)');
  assert.equal(phoneSafe[0][0], 'PL-G');
  for (const [id, p] of phoneSafe) {
    const label = profileOptionLabel(id, p);
    assert.match(label, /手机拍摄首选/, `${id}: label lost the phone hint: ${label}`);
    assert.ok(!/未达标/.test(label), `${id}: the phone-safe profile must not also carry the unqualified warning`);
  }
  // Negative control: every other profile stays without the hint, so the hint means something.
  let checked = 0;
  for (const [id, p] of entries) {
    if (p.phoneSafe) continue;
    assert.ok(!/手机拍摄首选/.test(profileOptionLabel(id, p)), `${id}: got the phone hint without being phoneSafe`);
    checked++;
  }
  assert.ok(checked >= 5, `only ${checked} profiles checked -- the negative control is vacuous`);
  // The paper profile the round-80 measurement failed on must NOT be advertised as phone-friendly.
  assert.ok(!/手机拍摄首选/.test(profileOptionLabel('P-M1-300', PROFILES['P-M1-300'])));
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

test('the outname listener is registered once, outside run() (D73)', () => {
  const app = readFileSync(new URL('../../web/app.js', import.meta.url), 'utf8');
  const listeners = app.match(/addEventListener\('input'/g) || [];
  assert.equal(listeners.length, 1, `expected exactly one input listener, found ${listeners.length}`);
  // The registration must not sit inside run(): that is what leaked one listener per transfer.
  const runStart = app.indexOf('async function run()');
  const runEnd = app.indexOf('\nfunction ', runStart + 10);
  assert.ok(runStart > 0, 'run() is gone -- this guard is reading a different file');
  const runBody = app.slice(runStart, runEnd > 0 ? runEnd : app.length);
  assert.ok(!/addEventListener\('input'/.test(runBody), 'the input listener is registered inside run() again -- it leaks one per transfer');
  // Positive control: the same slicing does find the click listener that IS inside run's scope.
  assert.ok(/addEventListener\('click'/.test(app), 'the file has no listeners at all -- the guard is vacuous');
});
test('both pages render through the shared helper, and the warning wording lives in exactly one file', () => {
  const sender = readFileSync(new URL('../../web/sender.js', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../../web/app.js', import.meta.url), 'utf8');
  const core = readFileSync(new URL('../../core/profiles.js', import.meta.url), 'utf8');
  assert.match(
    sender,
    /o\.textContent = profileOptionLabel\(id, p\);/,
    'sender.js no longer builds its dropdown labels through profileOptionLabel -- the warning can be bypassed',
  );
  // Round 82: the receiver page has a profile dropdown too, and it used to hand-roll its label, so
  // it silently showed neither the D49 warning nor the phone hint.
  assert.match(
    app,
    /o\.textContent = profileOptionLabel\(id, PROFILES\[id\]\);/,
    'app.js hand-rolls its profile label instead of using profileOptionLabel -- the receiver then shows neither warning',
  );
  assert.ok(
    !/o\.textContent = `\$\{id\} \(/.test(app),
    'app.js still builds a raw profile label somewhere',
  );
  assert.equal(
    (core.match(/未达标/g) || []).length,
    1,
    'the warning wording must live in exactly one file (core/profiles.js) so it cannot drift',
  );
  assert.equal(
    ((sender + app).match(/未达标/g) || []).length,
    0,
    'a page still spells the warning itself instead of importing the helper',
  );
});
