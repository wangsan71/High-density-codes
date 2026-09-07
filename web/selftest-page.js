/**
 * The ?selftest=1 entry for the served site. Separate from app.js so the bundle stays
 * free of dynamic imports: selftest.js loads the 200 KB conformance vector document only
 * when someone actually asks for a self-test, and that laziness is a feature of the test
 * harness, not an accident to be flattened by a bundler.
 *
 * Exposes window.__PSKT_SELFTEST__ (the raw result array) so the check is machine-readable
 * by anything driving the page, and sets a ✓/✗ title so it is human-readable at a glance.
 */
import { runSelfTests, formatSelfTests } from './selftest.js';

const box = document.getElementById('selftest-wrap');
const out = document.getElementById('selftest');
box.hidden = false;
out.textContent = 'running…';

runSelfTests({
  loadConformance: () => fetch('./conformance.json').then((r) => (r.ok ? r.json() : Promise.reject(new Error(`conformance.json ${r.status}`)))),
})
  .then((res) => {
    window.__PSKT_SELFTEST__ = res;
    out.textContent = formatSelfTests(res);
    document.title = `${res.some((r) => r.status === 'fail') ? '✗' : '✓'} PSKT selftest`;
  })
  .catch((e) => {
    window.__PSKT_SELFTEST__ = [{ name: 'selftest runner', status: 'fail', detail: e.message }];
    out.textContent = `selftest could not run: ${e.message}`;
    document.title = '✗ PSKT selftest';
  });
