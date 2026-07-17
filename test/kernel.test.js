import { test } from 'node:test';
import assert from 'node:assert';
import { compileNode, meshingBounds } from '../src/core/sdf.js';
import { ModelDocument } from '../src/core/document.js';
import { meshSDF } from '../src/core/mesher.js';
import { toBinarySTL } from '../src/core/stl.js';

function docWith(nodes, output) {
  const doc = new ModelDocument(null);
  for (const n of nodes) doc.createNode(n);
  doc.setOutput(output);
  return doc;
}

test('sphere SDF is correct', () => {
  const doc = docWith([{ type: 'sphere', id: 's', params: { radius: 10 } }], 's');
  const { fn } = compileNode(doc, 's');
  assert.ok(Math.abs(fn(0, 0, 0) + 10) < 1e-9);
  assert.ok(Math.abs(fn(10, 0, 0)) < 1e-9);
  assert.ok(Math.abs(fn(0, 20, 0) - 10) < 1e-9);
});

test('subtract removes material', () => {
  const doc = docWith([
    { type: 'box', id: 'b', params: { size: [20, 20, 20] } },
    { type: 'sphere', id: 's', params: { radius: 8 } },
    { type: 'subtract', id: 'cut', inputs: { a: 'b', b: 's' } },
  ], 'cut');
  const { fn } = compileNode(doc, 'cut');
  assert.ok(fn(0, 0, 0) > 0, 'center is carved out');
  assert.ok(fn(9.5, 9.5, 9.5) < 0, 'corner remains solid');
});

test('transform translates the shape', () => {
  const doc = docWith([
    { type: 'sphere', id: 's', params: { radius: 5 } },
    { type: 'transform', id: 't', params: { translate: [100, 0, 0] }, inputs: { shape: 's' } },
  ], 't');
  const { fn, bbox } = compileNode(doc, 't');
  assert.ok(fn(100, 0, 0) < 0);
  assert.ok(fn(0, 0, 0) > 0);
  assert.ok(Math.abs(bbox.min[0] - 95) < 1e-9);
});

test('cycles are rejected', () => {
  const doc = new ModelDocument(null);
  doc.createNode({ type: 'sphere', id: 'a' });
  doc.createNode({ type: 'shell', id: 'b', inputs: { shape: 'a' }, params: { thickness: 1 } });
  // manually wire a cycle (bypasses validation on purpose)
  doc.nodes.a = { id: 'a', type: 'shell', params: { thickness: 1 }, inputs: { shape: 'b' } };
  assert.throws(() => compileNode(doc, 'a'), /Cycle/);
});

test('deleting a used node is refused', () => {
  const doc = docWith([
    { type: 'sphere', id: 's' },
    { type: 'shell', id: 'sh', inputs: { shape: 's' } },
  ], 'sh');
  assert.throws(() => doc.deleteNode('s'), /uses it as an input/);
});

test('mesher produces a closed sphere with correct volume', () => {
  const doc = docWith([{ type: 'sphere', id: 's', params: { radius: 10 } }], 's');
  const { fn, bbox } = compileNode(doc, 's');
  const mesh = meshSDF(fn, meshingBounds(bbox), 80);
  assert.ok(mesh.stats.triangleCount > 1000);
  const exact = (4 / 3) * Math.PI * 1000;
  assert.ok(Math.abs(mesh.stats.volume - exact) / exact < 0.02, `volume ${mesh.stats.volume} vs ${exact}`);
  const exactArea = 4 * Math.PI * 100;
  assert.ok(Math.abs(mesh.stats.surfaceArea - exactArea) / exactArea < 0.02);
  // watertight: every edge shared by exactly two triangles
  const edges = new Map();
  const idx = mesh.indices;
  for (let t = 0; t < idx.length; t += 3) {
    for (const [a, b] of [[idx[t], idx[t + 1]], [idx[t + 1], idx[t + 2]], [idx[t + 2], idx[t]]]) {
      const k = a < b ? `${a}_${b}` : `${b}_${a}`;
      edges.set(k, (edges.get(k) || 0) + 1);
    }
  }
  for (const count of edges.values()) assert.strictEqual(count, 2);
});

test('STL export has valid header and size', () => {
  const doc = docWith([{ type: 'box', id: 'b', params: { size: [10, 10, 10] } }], 'b');
  const { fn, bbox } = compileNode(doc, 'b');
  const mesh = meshSDF(fn, meshingBounds(bbox), 40);
  const stl = toBinarySTL(mesh.positions, mesh.indices, 'b');
  const triCount = stl.readUInt32LE(80);
  assert.strictEqual(triCount, mesh.indices.length / 3);
  assert.strictEqual(stl.length, 84 + triCount * 50);
});
