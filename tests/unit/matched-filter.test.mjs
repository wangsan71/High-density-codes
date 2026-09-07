/**
 * The matched filter's contract, tested on synthetic alpha maps rather than on
 * rendered pages: the properties worth locking are about the *decision rule*
 * (invariances, refusal on blank cells, and a margin that means something), and
 * each of them is testable without a renderer in the loop.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildShapeTemplates, matchedShapeLevel } from '../../core/decode/ideal.js';

// A comfortably resolved cell: glyphGeometry refuses a 4-level shape alphabet below
// 24 EW per cell (the ideal crossover), so 24 is the smallest honest choice and the
// refusal itself is why this test builds its geometry rather than assuming one.
const CELL_PX = 10;
const CELL_EW = 24;
const SHAPE_LEVELS = 4;
let templates;
try {
  const { glyphGeometry } = await import('../../core/render/glyphs.js');
  const geo = glyphGeometry(CELL_EW, SHAPE_LEVELS);
  assert.ok(geo.ok, `glyphGeometry refused: ${geo.reason}`);
  templates = buildShapeTemplates(CELL_PX, geo, SHAPE_LEVELS);
} catch (e) {
  // If the shape source ever stops exporting what the decoder needs, the matched
  // filter silently cannot run -- so failing here is the point.
  assert.fail(`could not build templates from the renderer's own shape source: ${e.message}`);
}

const sum = (a) => a.reduce((x, y) => x + y, 0);

test('templates are distinct shapes with different ink areas', () => {
  const areas = templates.map((t) => sum(t));
  assert.equal(new Set(areas.map((a) => a.toFixed(1))).size, SHAPE_LEVELS, `levels collide: ${areas.join(',')}`);
});

test('a template measured exactly is decoded as its own level', () => {
  for (let lv = 0; lv < SHAPE_LEVELS; lv++) {
    const mf = matchedShapeLevel(Float64Array.from(templates[lv]), templates, CELL_PX);
    assert.equal(mf.level, lv, `level ${lv} decoded as ${mf.level} (residuals ${mf.all.map((s) => s.residual.toFixed(3)).join('|')})`);
  }
});

test('the decision survives a gain change (exposure / blur attenuation)', () => {
  for (let lv = 0; lv < SHAPE_LEVELS; lv++) {
    for (const gain of [2.5, 1.0, 0.35, 0.08]) {
      const a = Float64Array.from(templates[lv], (v) => v * gain);
      const mf = matchedShapeLevel(a, templates, CELL_PX);
      assert.equal(mf.level, lv, `gain ${gain} flipped level ${lv} to ${mf.level}`);
    }
  }
});

test('the decision survives a one-pixel registration error', () => {
  const { offsetPx } = { offsetPx: 1 };
  for (let lv = 0; lv < SHAPE_LEVELS; lv++) {
    for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1]]) {
      const a = new Float64Array(CELL_PX * CELL_PX);
      for (let y = 0; y < CELL_PX; y++) {
        for (let x = 0; x < CELL_PX; x++) {
          const sx = x + ox;
          const sy = y + oy;
          if (sx < 0 || sy < 0 || sx >= CELL_PX || sy >= CELL_PX) continue;
          a[y * CELL_PX + x] = templates[lv][sy * CELL_PX + sx];
        }
      }
      const mf = matchedShapeLevel(a, templates, CELL_PX, { offsetPx });
      assert.equal(mf.level, lv, `offset (${ox},${oy}) flipped level ${lv} to ${mf.level}`);
    }
  }
});

test('a blank cell is refused, not decoded as some plausible level', () => {
  // This is a false-acceptance guard: an all-zero cell must come back as an
  // erasure. A filter that normalised 0/0 into "level 0, perfect confidence" would
  // quietly convert unreadable pages into wrong data.
  const mf = matchedShapeLevel(new Float64Array(CELL_PX * CELL_PX), templates, CELL_PX);
  assert.equal(mf.blank, true);
  assert.equal(mf.level, null);
});

test('the margin reports ambiguity instead of always looking confident', () => {
  const clean = matchedShapeLevel(Float64Array.from(templates[1]), templates, CELL_PX);
  assert.ok(clean.margin > 0.1, `a perfect match scored margin ${clean.margin}`);
  // Halfway between two levels is genuinely ambiguous, and the margin has to say so.
  const mixed = new Float64Array(CELL_PX * CELL_PX);
  for (let i = 0; i < mixed.length; i++) mixed[i] = (templates[0][i] + templates[SHAPE_LEVELS - 1][i]) / 2;
  const m = matchedShapeLevel(mixed, templates, CELL_PX);
  assert.ok(m.margin < clean.margin, `ambiguous cell scored margin ${m.margin} >= clean ${clean.margin}`);
});

test('deterministic pixel noise at the nominal level boundary still resolves', () => {
  // 10% of the cell's peak amplitude: comparable to the inkness noise the simulated
  // channel measures on a real 300 dpi scan (sigma ~2.5/255 on paper).
  let state = 12345;
  const rnd = () => ((state = (state * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  let wrong = 0;
  for (let lv = 0; lv < SHAPE_LEVELS; lv++) {
    for (let trial = 0; trial < 25; trial++) {
      const a = Float64Array.from(templates[lv], (v) => Math.max(0, v + (rnd() - 0.5) * 0.2));
      if (matchedShapeLevel(a, templates, CELL_PX).level !== lv) wrong++;
    }
  }
  assert.equal(wrong, 0, `${wrong}/100 noisy cells decoded to the wrong level`);
});
