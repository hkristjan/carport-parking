import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './extract.mjs';

const { geom } = loadApp();
const round = n => { const r = Math.round(n * 1e6) / 1e6; return r === 0 ? 0 : r; }; // normalise -0

// The eight wall-shaped entries of today's staticObstacles, verbatim.
const BOXES = [
  { x: 2.25, y: 0.00, w: 0.22, h: 11.35 },
  { x: 2.55, y: 3.57, w: 7.95, h: 0.42 },
  { x: 2.55, y: 3.99, w: 0.10, h: 5.65 },
  { x: 10.40, y: 3.99, w: 0.10, h: 2.20 },
  { x: 10.40, y: 7.45, w: 0.10, h: 2.20 },
  { x: 2.50, y: 11.23, w: 2.00, h: 0.12 },
  { x: 10.90, y: 11.45, w: 7.70, h: 0.14 },
  { x: 0.00, y: 15.30, w: 18.6, h: 0.16 },
];

test('wallQuad reproduces every wall box exactly', () => {
  for (const r of BOXES) {
    const vertical = r.h > r.w, t = vertical ? r.w : r.h;
    const p = vertical ? [r.x + r.w / 2, r.y] : [r.x, r.y + r.h / 2];
    const q = vertical ? [r.x + r.w / 2, r.y + r.h] : [r.x + r.w, r.y + r.h / 2];
    const bb = geom.bboxOf(geom.wallQuad(p, q, t).corners);
    assert.deepEqual(
      [round(bb.x), round(bb.y), round(bb.w), round(bb.h)],
      [round(r.x), round(r.y), round(r.w), round(r.h)],
    );
  }
});

test('wallQuad angle follows the centreline', () => {
  assert.equal(round(geom.wallQuad([0, 0], [1, 0], 0.2).a), 0);
  assert.equal(round(geom.wallQuad([0, 0], [0, 1], 0.2).a), round(Math.PI / 2));
});

test('rectQuad centres on the given point', () => {
  const bb = geom.bboxOf(geom.rectQuad(5, 5, 2, 4).corners);
  assert.deepEqual([bb.x, bb.y, bb.w, bb.h], [4, 3, 2, 4]);
});

test('collide reports overlap for intersecting boxes and null otherwise', () => {
  const a = geom.rectCorners({ x: 0, y: 0, w: 2, h: 2 });
  assert.ok(geom.collide(a, 0, geom.rectCorners({ x: 1, y: 1, w: 2, h: 2 }), 0).d > 0);
  assert.equal(geom.collide(a, 0, geom.rectCorners({ x: 5, y: 5, w: 2, h: 2 }), 0), null);
  // touching edges are not a collision: overlap of exactly 0 returns null
  assert.equal(geom.collide(a, 0, geom.rectCorners({ x: 2, y: 0, w: 2, h: 2 }), 0), null);
});

test('a NaN coordinate yields a bogus MTV with d = NaN — hence validation on load', () => {
  // With every corner NaN, every axis projection is NaN, so both the "overlap <= 0"
  // early-out and the "overlap < best.d" comparison are always false (any comparison
  // against NaN is false) — collide never returns null, it returns a bogus MTV whose
  // d is NaN. That silent corruption (not a thrown error, not a clean null) is exactly
  // why callers must validate coordinates before they ever reach collide.
  const a = geom.rectCorners({ x: 0, y: 0, w: 2, h: 2 });
  const bad = [[NaN, NaN], [NaN, NaN], [NaN, NaN], [NaN, NaN]];
  const hit = geom.collide(a, 0, bad, 0);
  assert.ok(hit && Number.isNaN(hit.d));
});

// Only the direction of the minimum translation vector pushes the vehicle back out.
// `collide`'s sign term decides it, and nothing else in the suite reads nx/ny: flipping
// that sign would leave every other test green while every collision shoved the vehicle
// deeper into the obstacle.
test('the MTV points away from the other box', () => {
  const a = geom.rectCorners({ x: 0, y: 0, w: 2, h: 2 });
  const right = geom.collide(a, 0, geom.rectCorners({ x: 1, y: 0, w: 2, h: 2 }), 0);
  assert.deepEqual([round(right.d), round(right.nx), round(right.ny)], [1, -1, 0]);
  const left = geom.collide(a, 0, geom.rectCorners({ x: -1, y: 0, w: 2, h: 2 }), 0);
  assert.deepEqual([round(left.d), round(left.nx), round(left.ny)], [1, 1, 0]);
});
