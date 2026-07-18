import { test } from 'node:test';
import assert from 'node:assert';
import { ModelDocument } from '../src/core/document.js';
import { compileNode } from '../src/core/sdf.js';

test('drape lays a sheet over a sphere down to the floor', () => {
  const doc = new ModelDocument(null);
  const s = doc.createNode({ type: 'sphere', params: { radius: 10 } });
  const d = doc.createNode({
    type: 'drape',
    params: { thickness: 2, blend: 0, floor: -15, margin: 10 },
    inputs: { shapes: [s.id] },
  });
  const { fn, bbox } = compileNode(doc, d.id);
  assert.ok(fn(0, 0, 11) < 0, 'sheet rests on top of the sphere');
  assert.ok(fn(0, 0, 14) > 0, 'above the sheet');
  assert.ok(fn(0, 0, 0) > 0, 'inside the sphere volume is not sheet');
  assert.ok(fn(15, 0, -14) < 0, 'sheet lies on the floor beside the sphere');
  assert.ok(fn(15, 0, -17) > 0, 'nothing below the floor');
  assert.ok(fn(25, 0, -14) > 0, 'sheet ends at the margin');
  assert.equal(bbox.min[2], -15);
});

test('drape blend rounds the sheet across gaps', () => {
  const build = (blend) => {
    const doc = new ModelDocument(null);
    const s = doc.createNode({ type: 'sphere', params: { radius: 5 } });
    const arr = doc.createNode({
      type: 'linear_array',
      params: { count: 2, step: [20, 0, 0] },
      inputs: { shape: s.id },
    });
    const d = doc.createNode({
      type: 'drape',
      params: { thickness: 2, blend, floor: -10, margin: 5 },
      inputs: { shapes: [arr.id] },
    });
    return compileNode(doc, d.id).fn;
  };
  // Midpoint between the two spheres, mid-sheet just above the floor:
  const probe = [10, 0, -9];
  assert.ok(build(0)(...probe) < 0, 'blend 0: sheet sags to the floor between spheres');
  assert.ok(build(30)(...probe) > 0, 'blend 30: sheet bridges the gap, lifted off the floor');
});

test('linear_array repeats a shape along the step vector', () => {
  const doc = new ModelDocument(null);
  const s = doc.createNode({ type: 'sphere', params: { radius: 5 } });
  const arr = doc.createNode({
    type: 'linear_array',
    params: { count: 3, step: [20, 0, 0] },
    inputs: { shape: s.id },
  });
  const { fn, bbox } = compileNode(doc, arr.id);
  for (const x of [0, 20, 40]) assert.ok(fn(x, 0, 0) < 0, `copy at x=${x}`);
  assert.ok(Math.abs(fn(60, 0, 0) - 15) < 1e-9, 'no fourth copy');
  assert.deepEqual(bbox, { min: [-5, -5, -5], max: [45, 5, 5] });
});

test('polar_array revolves copies around Z', () => {
  const doc = new ModelDocument(null);
  const s = doc.createNode({ type: 'sphere', params: { radius: 5 } });
  const t = doc.createNode({
    type: 'transform',
    params: { translate: [20, 0, 0] },
    inputs: { shape: s.id },
  });
  const arr = doc.createNode({
    type: 'polar_array',
    params: { count: 4, sweep: 360 },
    inputs: { shape: t.id },
  });
  const { fn, bbox } = compileNode(doc, arr.id);
  for (const [x, y] of [[20, 0], [0, 20], [-20, 0], [0, -20]]) {
    assert.ok(fn(x, y, 0) < 0, `copy at ${x},${y}`);
  }
  assert.ok(fn(14, 14, 0) > 0, 'no copy at 45 degrees');
  assert.ok(bbox.min[0] <= -25 && bbox.max[0] >= 25, 'bbox spans the ring');
});

test('polar_array partial sweep places endpoints inclusively', () => {
  const doc = new ModelDocument(null);
  const s = doc.createNode({ type: 'sphere', params: { radius: 5 } });
  const t = doc.createNode({ type: 'transform', params: { translate: [20, 0, 0] }, inputs: { shape: s.id } });
  const arr = doc.createNode({ type: 'polar_array', params: { count: 3, sweep: 90 }, inputs: { shape: t.id } });
  const { fn } = compileNode(doc, arr.id);
  assert.ok(fn(20, 0, 0) < 0, 'start of sweep');
  const r = Math.SQRT1_2 * 20;
  assert.ok(fn(r, r, 0) < 0, 'middle copy at 45 degrees');
  assert.ok(fn(0, 20, 0) < 0, 'end of sweep at 90 degrees');
  assert.ok(fn(-20, 0, 0) > 0, 'nothing at 180 degrees');
});
