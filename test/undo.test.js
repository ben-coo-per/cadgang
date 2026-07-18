import { test } from 'node:test';
import assert from 'node:assert';
import { ModelDocument } from '../src/core/document.js';

test('undo/redo walk node edits back and forth', () => {
  const doc = new ModelDocument(null);
  const s = doc.createNode({ type: 'sphere', params: { radius: 10 } });
  doc.updateNode(s.id, { params: { radius: 20 } });
  doc.updateNode(s.id, { inputs: {} , name: 'ball' });

  doc.undo(); // name change
  assert.equal(doc.nodes[s.id].name, s.id);
  doc.undo(); // radius change
  assert.equal(doc.nodes[s.id].params.radius, 10);
  doc.undo(); // creation
  assert.equal(Object.keys(doc.nodes).length, 0);
  assert.equal(doc.output, null);

  doc.redo();
  assert.equal(doc.nodes[s.id].params.radius, 10);
  assert.equal(doc.output, s.id);
  doc.redo();
  assert.equal(doc.nodes[s.id].params.radius, 20);

  // A fresh edit clears the redo stack.
  doc.updateNode(s.id, { params: { radius: 33 } });
  assert.throws(() => doc.redo(), /Nothing to redo/);
});

test('rapid same-param edits coalesce into one undo step', () => {
  const doc = new ModelDocument(null);
  const s = doc.createNode({ type: 'sphere', params: { radius: 10 } });
  // Simulates a slider drag: many PATCHes to the same param in quick succession.
  for (const r of [11, 12, 13, 14, 15]) doc.updateNode(s.id, { params: { radius: r } });
  assert.equal(doc.nodes[s.id].params.radius, 15);
  doc.undo();
  assert.equal(doc.nodes[s.id].params.radius, 10, 'whole drag undone in one step');
});

test('edits to different params are separate undo steps', () => {
  const doc = new ModelDocument(null);
  const b = doc.createNode({ type: 'box', params: {} });
  doc.updateNode(b.id, { params: { round: 2 } });
  doc.updateNode(b.id, { params: { size: [10, 10, 10] } });
  doc.undo();
  assert.equal(doc.nodes[b.id].params.round, 2);
  assert.deepEqual(doc.nodes[b.id].params.size ?? null, null);
  doc.undo();
  assert.equal(doc.nodes[b.id].params.round ?? null, null);
});

test('undo restores deletions, output, vars, and assets', () => {
  const doc = new ModelDocument(null);
  const s = doc.createNode({ type: 'sphere', params: {} });
  doc.setVar('w', 42);
  const asset = doc.addAsset({
    name: 'a', positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2], faces: [{ first: 0, count: 1 }],
  });

  doc.deleteAsset(asset.id);
  doc.undo();
  assert.ok(doc.assets[asset.id], 'asset restored');

  doc.deleteVar('w');
  doc.undo();
  assert.equal(doc.vars.w, 42);

  doc.deleteNode(s.id);
  doc.undo();
  assert.ok(doc.nodes[s.id]);
  assert.equal(doc.output, s.id, 'output restored with the node');

  doc.clear();
  doc.undo();
  assert.ok(doc.nodes[s.id] && doc.vars.w === 42 && doc.assets[asset.id], 'clear is undoable');
});

test('failed updates leave no undo entry', () => {
  const doc = new ModelDocument(null);
  const s = doc.createNode({ type: 'sphere', params: { radius: 10 } });
  doc.updateNode(s.id, { params: { radius: 20 } });
  assert.throws(() => doc.updateNode(s.id, { params: { radius: 'nope(' } }));
  doc.undo();
  assert.equal(doc.nodes[s.id].params.radius, 10, 'undo skips the failed edit');
});

test('nothing to undo throws a GraphError', () => {
  const doc = new ModelDocument(null);
  assert.throws(() => doc.undo(), /Nothing to undo/);
});
