/**
 * Sketch cells end to end: a constrained 2D profile becoming a solid, and a
 * parameter change moving both.
 *
 * The property under test is the one that makes sketches worth having over a
 * point list — the dimension is the source, so turning a parameter re-solves
 * the sketch and rebuilds the solid without anyone editing coordinates.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { initBrep, beginBrepScope } from '../src/core/brep.js';
import { CellDocument, evaluateCells } from '../src/core/cells.js';
import * as ops from '../src/core/ops.js';
import { q, topology } from '../src/core/query.js';

await initBrep();

function inScope(fn) {
  const scope = beginBrepScope();
  try {
    return fn();
  } finally {
    scope.dispose();
  }
}

const near = (a, b, tol = 1e-3) =>
  assert.ok(Math.abs(a - b) < tol, `expected ${a} to be within ${tol} of ${b}`);

const PLATE_CODE = `
export const params = { width: 60, depth: 40, thickness: 6, hole: 5 };
export default ({ p, brep, sk }) => {
  const s = sk.sketch();
  const a = s.anchor(0, 0);
  const b = s.point(50, 3);
  const c = s.point(47, 30);
  const d = s.point(2, 31);
  const l = [s.line(a, b), s.line(b, c), s.line(c, d), s.line(d, a)];
  s.horizontal(l[0]);
  s.vertical(l[1]);
  s.horizontal(l[2]);
  s.vertical(l[3]);
  s.distance(l[0], 'width');
  s.distance(l[1], 'depth');

  const centre = s.point(30, 20);
  const hole = s.circle(centre, p.hole);
  s.radius(hole, 'hole');
  s.distanceX(a, centre, 20);
  s.distanceY(a, centre, 20);

  return brep.extrude(s, p.thickness);
};
`;

test('a constrained sketch extrudes to the solid its dimensions describe', () => {
  const doc = new CellDocument();
  doc.addCell({ id: 'plate', prompt: 'plate with a hole', code: PLATE_CODE });

  inScope(() => {
    const shape = evaluateCells(doc, 'plate').value;
    const { size } = ops.bbox(shape);
    near(size[0], 60);
    near(size[1], 40);
    near(size[2], 6);
    // 60 × 40 × 6 minus a 5mm-radius hole through it.
    near(ops.volume(shape), 60 * 40 * 6 - Math.PI * 25 * 6, 1);
    // The hole is real curved geometry, not a faceted approximation. OCCT
    // splits a full bore at its seam, so the count is halves, not one face.
    assert.equal(q.faces(shape).cylindrical().resolveOn(shape).length, 2);
    assert.equal(topology(shape).counts.faces, 8);
  });
});

test('turning a parameter re-solves the sketch and rebuilds the solid', () => {
  const doc = new CellDocument();
  doc.addCell({ id: 'plate', prompt: 'plate with a hole', code: PLATE_CODE });
  doc.updateCell('plate', { params: { width: 90, hole: 8 } });

  inScope(() => {
    const shape = evaluateCells(doc, 'plate').value;
    const { size } = ops.bbox(shape);
    near(size[0], 90);
    near(size[1], 40);
    near(ops.volume(shape), 90 * 40 * 6 - Math.PI * 64 * 6, 1);
  });
});

test('a sketch with a slot profile extrudes into one solid', () => {
  const doc = new CellDocument();
  doc.addCell({
    id: 'slot',
    prompt: '30mm slot, 5mm radius caps, 4mm thick',
    code: `
export const params = { length: 30, radius: 5, thickness: 4 };
export default ({ p, brep, sk }) => {
  const s = sk.sketch();
  const L = s.anchor(0, 0);
  const R = s.point(28, 1);
  const p1 = s.point(-1, 6);
  const p2 = s.point(29, 5);
  const p3 = s.point(31, -4);
  const p4 = s.point(0, -6);
  s.line(p1, p2);
  s.arc(R, p3, p2);
  s.line(p3, p4);
  s.arc(L, p1, p4);
  s.distanceX(L, R, 'length');
  s.distanceY(L, R, 0);
  s.distanceX(L, p1, 0);
  s.distanceY(L, p1, 'radius');
  s.distanceX(R, p2, 0);
  s.distanceY(R, p2, 'radius');
  s.distanceX(R, p3, 0);
  s.distanceY(R, p3, -p.radius);
  s.distanceX(L, p4, 0);
  s.distanceY(L, p4, -p.radius);
  return brep.extrude(s, p.thickness);
};
`,
  });

  inScope(() => {
    const shape = evaluateCells(doc, 'slot').value;
    const { size } = ops.bbox(shape);
    near(size[0], 40); // 30 between centres plus a 5mm cap at each end
    near(size[1], 10);
    near(ops.volume(shape), (30 * 10 + Math.PI * 25) * 4, 1);
  });
});

test('a sketch revolves about an axis', () => {
  const doc = new CellDocument();
  doc.addCell({
    id: 'disc',
    prompt: 'revolve a 10×4 rectangle 20mm out from the Z axis',
    code: `
export default ({ brep, sk }) => {
  const s = sk.sketch().on('XZ');
  const a = s.anchor(20, 0);
  const b = s.point(29, 1);
  const c = s.point(31, 5);
  const d = s.point(19, 4);
  const l = [s.line(a, b), s.line(b, c), s.line(c, d), s.line(d, a)];
  s.horizontal(l[0]);
  s.vertical(l[1]);
  s.horizontal(l[2]);
  s.vertical(l[3]);
  s.distance(l[0], 10);
  s.distance(l[1], 4);
  return brep.revolve(s, [0, 0, 1]);
};
`,
  });

  inScope(() => {
    const shape = evaluateCells(doc, 'disc').value;
    const { size } = ops.bbox(shape);
    near(size[0], 60, 0.05); // outer radius 30, so 60 across
    near(size[1], 60, 0.05);
    // A ring of rectangular section: π(30² − 20²) × 4.
    near(ops.volume(shape), Math.PI * (900 - 400) * 4, 5);
  });
});

test('an impossible sketch fails the cell with the constraints that fight', () => {
  const doc = new CellDocument();
  doc.addCell({
    id: 'bad',
    prompt: 'a 60mm line that is also 10mm long',
    code: `
export default ({ brep, sk }) => {
  const s = sk.sketch();
  const a = s.anchor(0, 0);
  const b = s.point(50, 0);
  const c = s.point(50, 30);
  const d = s.point(0, 30);
  const l = [s.line(a, b), s.line(b, c), s.line(c, d), s.line(d, a)];
  s.horizontal(l[0]);
  s.vertical(l[1]);
  s.horizontal(l[2]);
  s.vertical(l[3]);
  s.distance(l[0], 60);
  s.distance(l[1], 40);
  s.distance(a, c, 10);
  return brep.extrude(s, 5);
};
`,
  });

  const result = evaluateCells(doc, 'bad', { stopOnError: false });
  assert.equal(result.value, null);
  const entry = result.report.find((c) => c.id === 'bad');
  assert.equal(entry.status, 'error');
  assert.match(entry.error, /over-constrained/i);
});

test('a cell can extrude the sketch a person has been dragging', () => {
  const doc = new CellDocument();
  doc.addCell({
    id: 'drawn',
    prompt: 'extrude the drawn profile 8mm',
    code: `
export default ({ brep, sk }) => brep.extrude(sk.saved(), 8);
`,
    sketch: {
      plane: 'XY',
      points: [
        { x: 0, y: 0, fixed: true },
        { x: 20, y: 0 },
        { x: 20, y: 12 },
        { x: 0, y: 12 },
      ],
      entities: [
        { type: 'line', a: 0, b: 1 },
        { type: 'line', a: 1, b: 2 },
        { type: 'line', a: 2, b: 3 },
        { type: 'line', a: 3, b: 0 },
      ],
      constraints: [
        { type: 'horizontal', e: 0 },
        { type: 'vertical', e: 1 },
        { type: 'horizontal', e: 2 },
        { type: 'vertical', e: 3 },
      ],
    },
  });

  inScope(() => {
    const shape = evaluateCells(doc, 'drawn').value;
    near(ops.volume(shape), 20 * 12 * 8, 1e-3);
  });
});

test('a cell that asks for a sketch nobody drew says so', () => {
  const doc = new CellDocument();
  doc.addCell({
    id: 'empty',
    prompt: 'extrude the drawn profile',
    code: 'export default ({ brep, sk }) => brep.extrude(sk.saved(), 8);',
  });

  const entry = evaluateCells(doc, 'empty', { stopOnError: false })
    .report.find((c) => c.id === 'empty');
  assert.equal(entry.status, 'error');
  assert.match(entry.error, /no stored sketch/);
});
