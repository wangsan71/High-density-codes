import test from 'node:test';
import assert from 'node:assert/strict';

import { glyphGeometry, minCellEwFor, idealGeometry, glyphSignature, glyphSignatureDiff } from '../../core/render/glyphs.js';
import { planPage } from '../../core/profiles.js';
import { pageLayout } from '../../core/render/layout.js';

/**
 * The extrusion-width quantisation (decision 6) and the signature that lets a
 * receiver prove it is reading the same circles that were printed.
 */

test('glyphs: a shape alphabet below the EW floor is refused, and the refusal is truthful', () => {
  for (const levels of [2, 4]) {
    const need = minCellEwFor(levels);
    assert.ok(need >= 8, `${levels}-level alphabet needs ${need} EW`);
    assert.ok(glyphGeometry(need, levels).ok, `${levels}-level must work at the width the refusal names`);
    const r = glyphGeometry(3, levels);
    assert.equal(r.ok, false, `${levels}-level must not be printable at 3 EW`);
    assert.match(r.reason, /needs >= [\d.]+ EW per cell/);
    // The number a user is told has to be a number that actually works. An
    // analytical estimate once said 10 EW where 8 was enough, which would have
    // sent somebody to print a coarser plate than they needed.
    assert.equal(r.neededCellEw, need, 'refusal must agree with minCellEwFor');
    assert.ok(glyphGeometry(r.neededCellEw, levels).ok, 'the refused width must be printable');
  }
  assert.ok(minCellEwFor(4) > minCellEwFor(2), 'a bigger alphabet must cost more width');
});

test('glyphs: every quantised radius is a whole number of extrusion widths', () => {
  const EPS = 1e-9;
  const wholeEw = (frac, ew, what) => {
    const v = frac * ew;
    assert.ok(Math.abs(v - Math.round(v)) < EPS, `${what}: ${v} is not a whole EW`);
    return Math.round(v);
  };
  let checked = 0;
  for (const cellEw of [8, 8.5, 9, 10, 10.4, 12, 16, 20, 23.5]) {
    for (const levels of [2, 4]) {
      const g = glyphGeometry(cellEw, levels);
      if (!g.ok) continue;
      if (!g.quantised) {
        assert.ok(cellEw >= 24, `${levels}-level at ${cellEw} EW returned the ideal geometry where a quantised one should exist`);
        continue;
      }
      checked++;
      const outerEw = wholeEw(g.outer, cellEw, `outer at cellEw=${cellEw}`);
      const innerEw = wholeEw(g.inner, cellEw, `inner at cellEw=${cellEw}`);
      const dots = g.dot.map((d, i) => wholeEw(d, cellEw, `dot[${i}] at cellEw=${cellEw}`));
      // the physical clearance the whole rule exists to guarantee
      assert.ok(cellEw - outerEw >= 1 - EPS, `ring clearance ${cellEw - outerEw} EW < 1 at cellEw=${cellEw}`);
      assert.ok(innerEw - dots[dots.length - 1] >= 1 - EPS, `dot-to-ring gap < 1 EW at cellEw=${cellEw}`);
      assert.equal(new Set(dots).size, levels, 'levels must stay distinguishable');
      assert.ok(outerEw - innerEw >= 1, 'the ring itself must be at least one EW wide');
      assert.ok(g.rhoHi <= 0.95 + EPS, `rho_hi ${g.rhoHi} must stay inside the blob cut`);
    }
  }
  assert.ok(checked >= 8, `only ${checked} quantised geometries were exercised`);
});

test('glyphs: paper (no nozzle) means no EW constraint, and serialises as null not Infinity', () => {
  const g = glyphGeometry(null, 2);
  assert.ok(g.ok);
  assert.equal(g.quantised, false);
  assert.equal(g.cellEw, null, 'a JSON round-trip of Infinity would silently become null -- say null outright');
  assert.deepEqual(glyphSignature(g), {
    cellEw: null,
    shapeLevels: 2,
    quantised: false,
    outer: g.outer,
    inner: g.inner,
    dot: null,
    measure: g.measure,
  });
  assert.deepEqual(glyphSignature(null), null);
});

test('glyphs: the signature catches a geometry disagreement field by field', () => {
  const a = glyphSignature(glyphGeometry(10, 2));
  const b = glyphSignature(glyphGeometry(12, 2));
  const diff = glyphSignatureDiff(a, b);
  assert.ok(diff.length, 'different quantisations must not compare equal');
  assert.ok(diff.some((d) => d.startsWith('cellEw:')), diff.join(' | '));
  assert.deepEqual(glyphSignatureDiff(a, glyphSignature(glyphGeometry(10, 2))), [], 'identical geometry must agree');
  const c = { ...a, measure: { ...a.measure, dotR: 0.99 } };
  assert.deepEqual(glyphSignatureDiff(a, c), [`measure: ${JSON.stringify(a.measure)} vs ${JSON.stringify(c.measure)}`]);
});

test('glyphs: the layout of every shipping profile agrees with its own signature', () => {
  for (const [profile, nozzle, dpi] of [['PL-D2', '0.4', 300], ['PL-G', '0.8', 300], ['PL-D3', '0.2', 300], ['P-M1-600', null, 600]]) {
    const geom = planPage(profile, nozzle ? { nozzle } : {});
    const layout = pageLayout(geom, dpi, { plateMm: profile.startsWith('PL-') ? 200 : undefined });
    const sig = glyphSignature(layout.glyph);
    assert.equal(sig.cellEw, layout.cellEw, `${profile}: signature matches the layout it came from`);
    assert.deepEqual(glyphSignatureDiff(sig, JSON.parse(JSON.stringify(sig))), [], `${profile}: signature survives JSON`);
    if (nozzle) {
      assert.ok(sig.cellEw >= minCellEwFor(geom.channels.find((c) => c.name !== 'colour').levels), `${profile}: layout sits above its EW floor`);
    }
  }
  assert.ok(idealGeometry().ok);
});
