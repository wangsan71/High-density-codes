/**
 * core/image/container.js -- the "fit into a byte budget" search.
 * The invariant that matters: a returned payload never exceeds the budget it was given, and a budget
 * nothing fits is refused by name (with the measured cost of the cheapest rung, not an estimate).
 * Budgets here are derived from what this image actually costs, because a small smooth image has a
 * structural floor (one end-of-block symbol per block) that no quality setting goes below.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { packImage, packImageWithin, unpackImage, QUALITY_LADDER } from '../../core/image/container.js';

function photo(w, h) {
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      px[i] = 60 + 150 * (x / w) + 40 * Math.sin(y / 9);
      px[i + 1] = 70 + 120 * (y / h) + 30 * Math.sin(x / 7);
      px[i + 2] = 90 + 80 * (1 - x / w) + 20 * Math.cos((x + y) / 11);
      px[i + 3] = 255;
    }
  }
  return px;
}

const w = 48;
const h = 32;
const src = photo(w, h);
const hi = packImage(src, w, h, 95).bytes.length;
const lo = packImage(src, w, h, 10).bytes.length;

test('budget: the search never returns a payload larger than the budget', () => {
  assert.ok(lo < hi, 'the ladder must actually span a range on this image: ' + lo + '..' + hi);
  for (const budget of [hi, Math.floor((hi + lo) / 2), lo]) {
    const r = packImageWithin(src, w, h, budget);
    assert.ok(r.bytes.length <= budget, 'budget ' + budget + ' got ' + r.bytes.length + ' bytes');
    assert.ok(r.quality <= 95 && r.quality >= 10);
    assert.equal(unpackImage(r.bytes).width, w);
  }
});

test('budget: a generous budget buys a high quality and a tight one buys a low quality', () => {
  const generous = packImageWithin(src, w, h, hi);
  assert.equal(generous.quality, 95, 'a budget that q95 fits must not be spent on anything less');
  assert.equal(generous.tried, 1, 'the first rung should have been the answer here');
  const tight = packImageWithin(src, w, h, lo);
  assert.ok(tight.quality < generous.quality, 'a tighter budget must not return a higher quality');
  assert.ok(tight.bytes.length <= lo);
  assert.ok(tight.tried >= 2 && QUALITY_LADDER.includes(tight.quality));
});

test('budget: an impossible budget is refused with the measured cheapest cost in the message', () => {
  const cheapest = packImage(src, w, h, 5).bytes.length;
  assert.throws(() => packImageWithin(src, w, h, cheapest - 1, { minQuality: 5 }), (e) => {
    assert.match(e.message, /even q5 needs \d+ bytes and the budget is \d+/);
    assert.match(e.message, /downscale the image or allow more pages/);
    return true;
  });
  assert.throws(() => packImageWithin(src, w, h, lo - 1), /even q10 needs \d+ bytes/);
  assert.throws(() => packImageWithin(src, w, h, 0), /budget must be positive/);
  assert.throws(() => packImageWithin(src, w, h, 1000, { minQuality: 99 }), /no quality on the ladder/);
});
