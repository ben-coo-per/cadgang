/**
 * The 2D solver, under test: a sketch must land exactly on its dimensions from
 * a rough starting pose, must say how much is still floating, and must name
 * the constraints that fight when they cannot all hold.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { sketch, loopArea } from '../src/core/sketch.js';
import { GraphError } from '../src/core/errors.js';

const near = (a, b, tol = 1e-6) =>
  assert.ok(Math.abs(a - b) < tol, `expected ${a} to be within ${tol} of ${b}`);

/** A rectangle drawn sloppily, dimensioned exactly. */
function roughRectangle(w = 60, h = 40) {
  const s = sketch();
  const a = s.anchor(0, 0);
  const b = s.point(50, 2);
  const c = s.point(48, 30);
  const d = s.point(1, 31);
  const l = [s.line(a, b), s.line(b, c), s.line(c, d), s.line(d, a)];
  s.horizontal(l[0]);
  s.vertical(l[1]);
  s.horizontal(l[2]);
  s.vertical(l[3]);
  s.distance(l[0], w);
  s.distance(l[1], h);
  return { s, points: [a, b, c, d], lines: l };
}

test('a sloppy rectangle solves onto its dimensions exactly', () => {
  const { s, points } = roughRectangle();
  const report = s.solve();

  assert.equal(report.converged, true);
  assert.equal(report.dof, 0);
  assert.equal(report.redundant, 0);

  const [a, b, c, d] = points.map((i) => s.points[i]);
  near(a.x, 0); near(a.y, 0);
  near(b.x, 60); near(b.y, 0);
  near(c.x, 60); near(c.y, 40);
  near(d.x, 0); near(d.y, 40);
});

test('an undimensioned rectangle keeps its shape and reports what floats', () => {
  const s = sketch();
  const a = s.anchor(0, 0);
  const b = s.point(50, 2);
  const c = s.point(48, 30);
  const d = s.point(1, 31);
  const l = [s.line(a, b), s.line(b, c), s.line(c, d), s.line(d, a)];
  s.horizontal(l[0]);
  s.vertical(l[1]);
  s.horizontal(l[2]);
  s.vertical(l[3]);

  const report = s.solve();
  assert.equal(report.converged, true);
  // Width and height are still free; nothing else is.
  assert.equal(report.dof, 2);
  // The solver must not have invented a size — the corners stay near where
  // they were drawn, squared up but not resized.
  assert.ok(Math.abs(s.points[b].x - 50) < 5, 'width drifted');
  assert.ok(Math.abs(s.points[c].y - 30) < 5, 'height drifted');
});

test('a dimension can be a cell parameter, and moves when it does', () => {
  const s = sketch();
  const a = s.anchor(0, 0);
  const b = s.point(10, 0);
  const l = s.line(a, b);
  s.horizontal(l);
  s.distance(l, 'width');

  s.solve({ params: { width: 25 } });
  near(s.points[b].x, 25);

  s.solve({ params: { width: 80 } });
  near(s.points[b].x, 80);

  assert.throws(() => s.solve({ params: {} }), /no parameter named 'width'/);
});

test('constraints that cannot all hold name themselves', () => {
  const { s, points } = roughRectangle();
  // A 60×40 rectangle has a 72.1mm diagonal. Demanding 10 is impossible.
  s.distance(points[0], points[2], 10);

  let err;
  try {
    s.solve();
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof GraphError, 'an impossible sketch must throw');
  assert.match(err.message, /over-constrained/i);
  assert.match(err.message, /distance/);
});

test('saying the same thing twice is reported as redundant, not as failure', () => {
  const { s, lines } = roughRectangle();
  s.horizontal(lines[0]);

  const report = s.solve();
  assert.equal(report.converged, true);
  assert.equal(report.dof, 0);
  assert.equal(report.redundant, 1);
});

test('perpendicular, parallel and equal hold a diamond square', () => {
  const s = sketch();
  const a = s.anchor(0, 0);
  const b = s.point(30, 4);
  const c = s.point(26, 34);
  const d = s.point(-3, 29);
  const l = [s.line(a, b), s.line(b, c), s.line(c, d), s.line(d, a)];
  s.perpendicular(l[0], l[1]);
  s.parallel(l[0], l[2]);
  s.parallel(l[1], l[3]);
  s.equal(l[0], l[1]);
  s.distance(l[0], 30);
  s.angle(l[0], l[1], 90);

  const report = s.solve();
  assert.equal(report.converged, true);
  const len = (i, j) => Math.hypot(s.points[i].x - s.points[j].x, s.points[i].y - s.points[j].y);
  near(len(a, b), 30, 1e-5);
  near(len(b, c), 30, 1e-5);
  near(len(c, d), 30, 1e-5);
  const u = [s.points[b].x - s.points[a].x, s.points[b].y - s.points[a].y];
  const v = [s.points[c].x - s.points[b].x, s.points[c].y - s.points[b].y];
  near((u[0] * v[0] + u[1] * v[1]) / 900, 0, 1e-6);
});

test('a line tangent to a circle stays on the side it started on', () => {
  const s = sketch();
  const a = s.anchor(-20, 0);
  const b = s.point(20, 1);
  const l = s.line(a, b);
  const centre = s.point(0, 9);
  const c = s.circle(centre, 8);
  s.horizontal(l);
  s.radius(c, 8);
  s.distanceX(a, centre, 20);
  s.tangent(l, c);

  const report = s.solve();
  assert.equal(report.converged, true);
  // The line is horizontal through y = 0, so tangency puts the centre 8 above
  // it — not 8 below, which is the other valid answer.
  near(s.points[centre].y, 8, 1e-6);
  assert.ok(s.points[centre].y > 0, 'the circle flipped to the far side of the line');
});

test('point-on-entity puts a hole centre on a diagonal', () => {
  const s = sketch();
  const a = s.anchor(0, 0);
  const b = s.point(40, 40, { fixed: true });
  const l = s.line(a, b);
  const centre = s.point(30, 5);
  s.circle(centre, 3);
  s.pointOn(centre, l);
  s.distanceX(a, centre, 20);

  s.solve();
  near(s.points[centre].y, 20, 1e-6);
});

test('a rectangle with a hole comes back as two loops, boundary first', () => {
  const { s } = roughRectangle();
  const centre = s.point(30, 20);
  s.circle(centre, 5);
  s.solve();

  const loops = s.loops();
  assert.equal(loops.length, 2);
  near(Math.abs(loopArea(loops[0])), 2400, 1e-5);
  near(Math.abs(loopArea(loops[1])), Math.PI * 25, 1e-5);
});

test('lines pulled together by coincident constraints close into one loop', () => {
  const s = sketch();
  // Four separate lines with eight separate endpoints — the way a UI drawing
  // tool produces them — welded by coincidence rather than by shared points.
  const p = [
    [0, 0], [30, 1], [30, 1], [30, 20], [30, 20], [0, 20], [0, 20], [0, 0],
  ].map(([x, y]) => s.point(x, y));
  const l = [s.line(p[0], p[1]), s.line(p[2], p[3]), s.line(p[4], p[5]), s.line(p[6], p[7])];
  s.coincident(p[1], p[2]);
  s.coincident(p[3], p[4]);
  s.coincident(p[5], p[6]);
  s.coincident(p[7], p[0]);
  s.horizontal(l[0]);
  s.vertical(l[1]);
  s.horizontal(l[2]);
  s.vertical(l[3]);
  s.solve();

  const loops = s.loops();
  assert.equal(loops.length, 1);
  assert.equal(loops[0].segments.length, 4);
});

test('a slot closes into one loop of two lines and two arcs', () => {
  const s = sketch();
  const L = s.anchor(0, 0);
  const R = s.point(28, 1);
  const p1 = s.point(-1, 6);
  const p2 = s.point(29, 5);
  const p3 = s.point(31, -4);
  const p4 = s.point(0, -6);
  s.line(p1, p2);
  s.arc(R, p3, p2); // right cap, counter-clockwise from the bottom
  s.line(p3, p4);
  s.arc(L, p1, p4); // left cap, counter-clockwise from the top
  s.distanceX(L, R, 30);
  s.distanceY(L, R, 0);
  s.distanceX(L, p1, 0);
  s.distanceY(L, p1, 5);
  s.distanceX(R, p2, 0);
  s.distanceY(R, p2, 5);
  s.distanceX(R, p3, 0);
  s.distanceY(R, p3, -5);
  s.distanceX(L, p4, 0);
  s.distanceY(L, p4, -5);

  const report = s.solve();
  assert.equal(report.converged, true);
  assert.equal(report.redundant, 0);

  const loops = s.loops();
  assert.equal(loops.length, 1);
  assert.equal(loops[0].segments.length, 4);
  // 30 × 10 body plus a full 5mm-radius circle across the two caps.
  near(Math.abs(loopArea(loops[0])), 300 + Math.PI * 25, 0.5);

  // Both arcs bulge outward: their mid-points sit beyond the straight ends.
  const arcs = loops[0].segments.filter((seg) => seg.type === 'arc');
  assert.equal(arcs.length, 2);
  const xs = arcs.map((seg) => seg.mid[0]).sort((a, b) => a - b);
  near(xs[0], -5, 1e-5);
  near(xs[1], 35, 1e-5);
});

test('an open chain of edges is refused rather than silently closed', () => {
  const s = sketch();
  const a = s.anchor(0, 0);
  const b = s.point(30, 0);
  const c = s.point(30, 20);
  s.line(a, b);
  s.line(b, c);
  s.solve();

  assert.throws(() => s.loops(), /not a set of closed loops/);
});

test('a sketch round-trips through JSON with its solved state', () => {
  const { s } = roughRectangle();
  s.solve();
  const revived = sketch(JSON.parse(JSON.stringify(s)));

  assert.equal(revived.points.length, s.points.length);
  assert.equal(revived.constraints.length, s.constraints.length);
  const report = revived.solve();
  assert.equal(report.converged, true);
  assert.equal(report.dof, 0);
  near(revived.points[1].x, 60);
  assert.equal(revived.points[0].fixed, true);
});
