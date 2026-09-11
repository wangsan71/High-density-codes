/**
 * The `?selftest=1` entry for the SERVED site.
 *
 * It used to be an inline <script type="module"> in index.html, and that page's own CSP is
 * `script-src 'self'` -- which does not permit inline script. Browsers blocked it silently, so the
 * documented self-test entry never ran (DEFECTS D89, found in round 249 with a real browser). A module
 * loaded from a file is allowed by `script-src 'self'`, and the dynamic import below stays dynamic on
 * purpose: selftest.js fetches conformance.json at run time, so bundling it would either disable the
 * self-test or disable the bundler. The single-file build strips this <script> tag by its marker
 * comment and inlines everything, with 'unsafe-inline' added to its own CSP instead.
 */
if (new URLSearchParams(location.search).get('selftest') === '1') import('./selftest-page.js');
