import test from 'node:test';
import assert from 'node:assert/strict';
import { homographyFromQuad, apply, inv3, mul3, sampleBilinear } from '../../core/decode/transform.js';

const close = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b));

test('homography maps its four control pairs exactly', () => {
  // an arbitrary skew quad -> an axis-aligned rectangle in page mm
  const src = [
    { x: 120, y: 90 },
    { x: 2310, y: 140 },
    { x: 2260, y: 2180 },
    { x: 60, y: 2110 },
  ];
  const dst = [
    { x: 0, y: 0 },
    { x: 200, y: 0 },
    { x: 200, y: 200 },
    { x: 0, y: 200 },
  ];
  const H = homographyFromQuad(src, dst);
  assert.ok(H, 'solve returned null');
  for (let i = 0; i < 4; i++) {
    const p = apply(H, src[i].x, src[i].y);
    assert.ok(close(p.x, dst[i].x, 1e-5), `corner ${i} x: ${p.x} vs ${dst[i].x}`);
    assert.ok(close(p.y, dst[i].y, 1e-5), `corner ${i} y: ${p.y} vs ${dst[i].y}`);
  }
  // a point inside maps inside, and the far side stays ordered
  const mid = apply(H, 1200, 1150);
  assert.ok(mid.x > 80 && mid.x < 120 && mid.y > 80 && mid.y < 120, JSON.stringify(mid));
});

test('homography round-trips through its inverse', () => {
  const src = [{ x: 0, y: 0 }, { x: 1000, y: 40 }, { x: 1100, y: 900 }, { x: -50, y: 860 }];
  const dst = [{ x: 3, y: 7 }, { x: 210.5, y: 2 }, { x: 205, y: 198 }, { x: 8, y: 201.25 }];
  const H = homographyFromQuad(src, dst);
  const Hi = inv3(H);
  assert.ok(Hi, 'H not invertible');
  const C = mul3(Hi, H);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      const want = i === j ? 1 : 0;
      // scale-free: normalise by the bottom-right entry
      assert.ok(close(C[i][j] / C[2][2], want, 1e-6), `H⁻¹H[${i}][${j}] = ${C[i][j] / C[2][2]} != ${want}`);
    }
  }
  for (const p of [{ x: 500, y: 500 }, { x: 1050, y: 470 }, { x: 12, y: 900 }]) {
    const fwd = apply(H, p.x, p.y);
    const back = apply(Hi, fwd.x, fwd.y);
    assert.ok(close(back.x, p.x, 1e-6) && close(back.y, p.y, 1e-6), `round trip ${p.x},${p.y} -> ${back.x},${back.y}`);
  }
});

test('a similarity (scale + rotation + translation) is reproduced by the projective solve', () => {
  const pxPerMm = 6.3;
  const ang = 0.31;
  const ca = Math.cos(ang);
  const sa = Math.sin(ang);
  const toPixel = (x, y) => ({
    x: 400 + pxPerMm * (x * ca - y * sa),
    y: 250 + pxPerMm * (x * sa + y * ca),
  });
  const quad = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
  // `.map(toPixel)` would pass (element, index) and silently build NaN points
  const H = homographyFromQuad(quad.map((q) => toPixel(q.x, q.y)), quad);
  for (const q of [{ x: 37.5, y: 62.5 }, { x: 99, y: 1 }, { x: 1, y: 99 }]) {
    const p = toPixel(q.x, q.y);
    const got = apply(H, p.x, p.y);
    assert.ok(close(got.x, q.x, 1e-5), `${q.x} -> ${got.x}`);
    assert.ok(close(got.y, q.y, 1e-5), `${q.y} -> ${got.y}`);
  }
  // perspective terms must be ~zero for a pure similarity
  assert.ok(Math.abs(H[2][0]) < 1e-8 && Math.abs(H[2][1]) < 1e-8, JSON.stringify(H[2]));
});

test('degenerate quads are refused instead of producing nonsense', () => {
  const collinear = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }];
  const dst = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
  const H = homographyFromQuad(collinear, dst);
  const bad = H === null || !Number.isFinite(H.flat().reduce((a, b) => a + b, 0));
  assert.ok(bad, `expected null/non-finite, got ${JSON.stringify(H)}`);
});

test('sampleBilinear interpolates and clamps', () => {
  const w = 4;
  const h = 4;
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      px[o] = x * 60;
      px[o + 1] = y * 60;
      px[o + 2] = 128;
      px[o + 3] = 255;
    }
  }
  // texel centres sit at integer coordinates: 1.5 is midway between x=1 and x=2
  const c = sampleBilinear(px, w, h, 4, 1.5, 1.5);
  assert.equal(c.values[0], 90);
  assert.equal(c.values[1], 90);
  const exact = sampleBilinear(px, w, h, 4, 3, 1);
  assert.equal(exact.values[0], 180);
  assert.equal(exact.values[1], 60);
  assert.equal(exact.inside, true);
  const o = sampleBilinear(px, w, h, 4, -3, 100);
  assert.equal(o.inside, false);
  assert.equal(o.values[2], 128, 'clamped read must still hit the border');
});
