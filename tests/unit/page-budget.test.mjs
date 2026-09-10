/**
 * core/profiles.js -- pageBudgetFor()/dataPagesFor(): what a page budget carries BEFORE encoding.
 * The three expected rows below are the CLI's own output (ground truth), not a re-derivation:
 *   node cli/pskit.mjs send FILE --profile P-MX-300-5 --pages N --dry-run   for N = 3, 5, 8
 * printed "1 data + 2 parity = 29082 B", "3 data + 2 parity = 87246 B", "6 data + 2 parity = 174492 B".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { pageBudgetFor, dataPagesFor, planPage, PROFILES } from '../../core/profiles.js';

const pct = PROFILES['P-MX-300-5'].parityPct;
const net = planPage('P-MX-300-5', {}).ecc.netBytesPerPage;

test('page budget: the rule matches the CLI for the three checked page counts', () => {
  assert.equal(net, 29082);
  const rows = [[3, 1, 2, 29082], [5, 3, 2, 87246], [8, 6, 2, 174492]];
  for (const [pages, data, parity, bytes] of rows) {
    const b = pageBudgetFor('P-MX-300-5', pages);
    assert.equal(b.dataPages, data, 'data pages for ' + pages);
    assert.equal(b.parityPages, parity, 'parity pages for ' + pages);
    assert.equal(b.budgetBytes, bytes, 'budget bytes for ' + pages);
    assert.equal(b.budgetBytes, data * net);
  }
});

test('page budget: the parity floor is two pages, so a 1- or 2-page budget carries nothing', () => {
  assert.equal(dataPagesFor(1, pct), 0);
  assert.equal(dataPagesFor(2, pct), 0);
  assert.equal(dataPagesFor(3, pct), 1);
  assert.throws(() => pageBudgetFor('P-MX-300-5', 2), /cannot carry even one data page/);
  assert.throws(() => pageBudgetFor('P-MX-300-5', 0), /whole number 1\.\.255/);
  assert.throws(() => pageBudgetFor('P-MX-300-5', 256), /whole number 1\.\.255/);
  assert.throws(() => pageBudgetFor('NOPE-1', 5), /unknown profile/);
  // Monotone in the page count: more pages never carry less.
  let prev = 0;
  for (let p = 3; p <= 40; p++) {
    const b = pageBudgetFor('P-MX-300-5', p);
    assert.ok(b.budgetBytes >= prev, 'budget fell at ' + p);
    prev = b.budgetBytes;
  }
});
