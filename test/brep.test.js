/**
 * The exact (B-rep) lineage: sketch -> solid -> boolean -> fillet -> STEP,
 * and the one-way bridge into the implicit lineage.
 *
 * These run against the real OCCT kernel, so the file pays a one-off ~1s WASM
 * load. Everything after that is synchronous.
 */

import { test, before } from 'node:test';
import assert from 'node:assert';
import { ModelDocument } from '../src/core/document.js';
import { compileNode, needsBrepKernel, nodeTypeCatalog, GraphError } from '../src/core/sdf.js';
import { initBrep, beginBrepScope, exportStep, tessellate } from '../src/core/brep.js';

before(async () => { await initBrep(); });

/** Compile inside a shape scope and hand the result to `body`. */
function compiled(doc, id, body) {
  const scope = beginBrepScope();
  try {
    return body(compileNode(doc, id));
  } finally {
    scope.dispose();
  }
}

/** The worked example: a plate with a bore and filleted corners. */
function platedDoc() {
  const doc = new ModelDocument(null);
  doc.createNode({ type: 'sketch_rect', id: 'sk', params: { plane: 'XY', width: 60, height: 40 } });
  doc.createNode({ type: 'brep_extrude', id: 'ex', params: { distance: 15 }, inputs: { profile: 'sk' } });
  doc.createNode({ type: 'brep_cylinder', id: 'cyl', params: { radius: 8, height: 40 } });
  doc.createNode({ type: 'brep_transform', id: 'mv', params: { translate: [0, 0, -5] }, inputs: { shape: 'cyl' } });
  doc.createNode({ type: 'brep_boolean', id: 'cut', params: { op: 'subtract' }, inputs: { base: 'ex', tool: ['mv'] } });
  doc.createNode({ type: 'brep_fillet', id: 'fil', params: { radius: 3, select: 'z' }, inputs: { shape: 'cut' } });
  return doc;
}

test('sketch -> extrude -> boolean -> fillet keeps an exact solid', () => {
  const doc = platedDoc();
  compiled(doc, 'fil', (r) => {
    assert.ok(r.brep, 'the whole chain stayed in the B-rep lineage');
    // `+ 0` normalises the -0 that rounding a tiny negative bound produces.
    assert.deepStrictEqual(r.bbox.min.map((v) => Math.round(v) + 0), [-30, -20, 0]);
    assert.deepStrictEqual(r.bbox.max.map((v) => Math.round(v) + 0), [30, 20, 15]);
  });
});

test('exact tessellation is far cheaper than remeshing the field', () => {
  const doc = platedDoc();
  compiled(doc, 'fil', (r) => {
    const t = tessellate(r.brep);
    // 11 faces: 2 caps, 4 walls, 4 corner fillets, 1 bore.
    assert.strictEqual(t.faces.length, 11);
    assert.ok(t.indices.length / 3 < 2000, `exact tessellation stays small (got ${t.indices.length / 3} triangles)`);
    assert.ok(t.faces.every((f) => f.count > 0), 'every B-rep face has triangles');
  });
});

test('STEP export writes real analytic surfaces, not facets', async () => {
  const doc = platedDoc();
  const step = await compiled(doc, 'fil', (r) => exportStep(r.brep));
  const text = step.toString('utf8');
  assert.match(text, /^ISO-10303-21;/);
  // The bore plus the four corner fillets are true cylinders in the file. A
  // tessellated export would have none of these and thousands of planes.
  const cylinders = text.match(/CYLINDRICAL_SURFACE/g) ?? [];
  assert.strictEqual(cylinders.length, 5);
  assert.ok((text.match(/= PLANE\(/g) ?? []).length < 20, 'planar faces are not exploded into facets');
});

test('the derived distance field agrees with the exact solid', () => {
  const doc = platedDoc();
  compiled(doc, 'fil', (r) => {
    assert.ok(r.fn(25, 0, 7) < 0, 'a point in the material is inside');
    assert.ok(r.fn(0, 0, 7) > 0, 'a point in the bore is outside');
    assert.ok(r.fn(100, 0, 0) > 50, 'a far point is far outside');
  });
});

test('a B-rep solid feeds a field block, and the result is field-only', () => {
  const doc = platedDoc();
  doc.createNode({ type: 'gyroid', id: 'gy', params: { cell: 8, thickness: 1.2 } });
  doc.createNode({ type: 'intersect', id: 'infill', inputs: { shapes: ['fil', 'gy'] } });
  compiled(doc, 'infill', (r) => {
    assert.strictEqual(r.brep, null, 'crossing into a field drops the exact solid');
    assert.ok(Number.isFinite(r.fn(25, 0, 7)), 'the field still evaluates');
  });
});

test('export_step refuses field geometry instead of writing facets', () => {
  const doc = platedDoc();
  doc.createNode({ type: 'gyroid', id: 'gy', params: { cell: 8, thickness: 1.2 } });
  doc.createNode({ type: 'intersect', id: 'infill', inputs: { shapes: ['fil', 'gy'] } });
  doc.createNode({ type: 'export_step', id: 'bad', inputs: { shape: 'infill' } });
  assert.throws(
    () => compiled(doc, 'bad', () => {}),
    (e) => e instanceof GraphError && /implicit \(field\) geometry/.test(e.message)
  );
});

test('export_step distinguishes an unwired input from a field one', () => {
  const doc = new ModelDocument(null);
  doc.createNode({ type: 'export_step', id: 'out', inputs: {} });
  assert.throws(
    () => compiled(doc, 'out', () => {}),
    (e) => e instanceof GraphError && /missing required input/i.test(e.message)
  );
});

test('a sketch cannot be used where a solid belongs', () => {
  const doc = new ModelDocument(null);
  doc.createNode({ type: 'sketch_circle', id: 'sk', params: { radius: 10 } });
  doc.createNode({ type: 'brep_fillet', id: 'f', params: { radius: 1 }, inputs: { shape: 'sk' } });
  assert.throws(
    () => compiled(doc, 'f', () => {}),
    (e) => e instanceof GraphError && /extrude or revolve/.test(e.message)
  );
});

test('symmetric extrude centres the solid on its sketch plane, on any plane', () => {
  for (const [plane, axis] of [['XY', 2], ['XZ', 1], ['YZ', 0]]) {
    const doc = new ModelDocument(null);
    doc.createNode({ type: 'sketch_rect', id: 'sk', params: { plane, width: 20, height: 20 } });
    doc.createNode({
      type: 'brep_extrude', id: 'ex',
      params: { distance: 8, symmetric: true }, inputs: { profile: 'sk' },
    });
    compiled(doc, 'ex', (r) => {
      assert.ok(Math.abs(r.bbox.min[axis] + 4) < 1e-6, `${plane} extrudes to -4 on axis ${axis}`);
      assert.ok(Math.abs(r.bbox.max[axis] - 4) < 1e-6, `${plane} extrudes to +4 on axis ${axis}`);
    });
  }
});

test('a failed OCCT operation reports the kernel\'s own reason', () => {
  const doc = new ModelDocument(null);
  doc.createNode({ type: 'brep_box', id: 'b', params: { size: [10, 10, 10] } });
  doc.createNode({ type: 'brep_fillet', id: 'f', params: { radius: 50 }, inputs: { shape: 'b' } });
  assert.throws(
    () => compiled(doc, 'f', () => {}),
    // The point is that the message is OCCT's, not a bare heap pointer.
    (e) => e instanceof GraphError && /^fillet failed: \D/.test(e.message)
  );
});

test('a shape feeding two parents is not consumed by the first', () => {
  const doc = new ModelDocument(null);
  doc.createNode({ type: 'brep_box', id: 'b', params: { size: [20, 20, 20] } });
  doc.createNode({ type: 'brep_sphere', id: 's', params: { radius: 12 } });
  // 'b' is both the base of a subtract and a tool in a union.
  doc.createNode({ type: 'brep_boolean', id: 'sub', params: { op: 'subtract' }, inputs: { base: 'b', tool: ['s'] } });
  doc.createNode({ type: 'brep_boolean', id: 'uni', params: { op: 'union' }, inputs: { base: 's', tool: ['b'] } });
  doc.createNode({ type: 'brep_boolean', id: 'both', params: { op: 'union' }, inputs: { base: 'sub', tool: ['uni'] } });
  compiled(doc, 'both', (r) => {
    assert.ok(r.brep, 'both branches survived sharing an operand');
    assert.ok(r.bbox.max[0] > 9, 'the union reaches the box extent');
  });
});

test('needsBrepKernel only fires for graphs that actually use B-rep blocks', () => {
  const fieldOnly = new ModelDocument(null);
  fieldOnly.createNode({ type: 'sphere', id: 's', params: { radius: 10 } });
  fieldOnly.createNode({ type: 'export_stl', id: 'out', inputs: { shape: 's' } });
  assert.strictEqual(needsBrepKernel(fieldOnly, 'out'), false);
  assert.strictEqual(needsBrepKernel(platedDoc(), 'fil'), true);
});

test('the catalog marks which blocks can reach STEP', () => {
  const cat = nodeTypeCatalog();
  assert.strictEqual(cat.brep_fillet.exact, true);
  assert.strictEqual(cat.brep_fillet.kind, 'brep');
  assert.strictEqual(cat.sketch_rect.kind, 'sketch');
  assert.strictEqual(cat.smooth_union.exact, false);
  assert.deepStrictEqual(cat.brep_boolean.params.op.options, ['union', 'subtract', 'intersect']);
});
