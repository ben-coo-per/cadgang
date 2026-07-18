import { test } from 'node:test';
import assert from 'node:assert';
import { ModelDocument } from '../src/core/document.js';
import { compileNode } from '../src/core/sdf.js';

test('setVar stores numbers and resolves expression values', () => {
  const doc = new ModelDocument(null);
  doc.setVar('w', 30);
  assert.strictEqual(doc.vars.w, 30);
  doc.setVar('h', '2 * w'); // expression resolved against existing vars, stored as a number
  assert.strictEqual(doc.vars.h, 60);
  // vars ride along in toJSON
  assert.deepStrictEqual(doc.toJSON().vars, { w: 30, h: 60 });
});

test('setVar rejects bad names, reserved names, and non-finite values', () => {
  const doc = new ModelDocument(null);
  assert.throws(() => doc.setVar('2x', 1), /must match/);
  assert.throws(() => doc.setVar('a-b', 1), /must match/);
  assert.throws(() => doc.setVar('sin', 1), /collides/);
  assert.throws(() => doc.setVar('pi', 3), /collides/);
  assert.throws(() => doc.setVar('a', '1/0'), /finite/);
});

test('deleteVar errors on missing and refuses when referenced by a node', () => {
  const doc = new ModelDocument(null);
  doc.setVar('w', 30);
  doc.setVar('ww', 5);
  assert.throws(() => doc.deleteVar('missing'), /does not exist/);

  doc.createNode({ type: 'box', id: 'b', params: { size: ['w', 'w/2', 10] } });
  assert.throws(() => doc.deleteVar('w'), (e) => /referenced by node/.test(e.message) && /\bb\b/.test(e.message));

  // Word boundaries: 'w' is not considered referenced by the token 'ww'.
  doc.createNode({ type: 'sphere', id: 's', params: { radius: 'ww' } });
  doc.updateNode('b', { params: { size: [1, 2, 3] } }); // drop the 'w' references
  doc.deleteVar('w'); // now allowed
  assert.ok(!('w' in doc.vars));
  assert.throws(() => doc.deleteVar('ww'), /referenced by node/); // still used by 's'
});

test('expression params resolve at compile time against vars', () => {
  const doc = new ModelDocument(null);
  doc.setVar('w', 30);
  doc.createNode({ type: 'box', id: 'b', params: { size: ['w', 'w/2', 10] } });
  doc.setOutput('b');
  // Raw authored strings are stored, not resolved numbers.
  assert.deepStrictEqual(doc.nodes.b.params.size, ['w', 'w/2', 10]);

  let { fn } = compileNode(doc, 'b');
  // half extents: x=15, y=7.5, z=5
  assert.ok(fn(0, 0, 0) < 0, 'origin inside');
  assert.ok(Math.abs(fn(15, 0, 0)) < 1e-6, 'x face at 15');
  assert.ok(Math.abs(fn(0, 7.5, 0)) < 1e-6, 'y face at 7.5');
  assert.ok(fn(20, 0, 0) > 0, 'outside past x face');

  // Changing the var re-resolves on the next compile.
  doc.setVar('w', 40);
  ({ fn } = compileNode(doc, 'b'));
  assert.ok(Math.abs(fn(20, 0, 0)) < 1e-6, 'x face now at 20');
  assert.ok(fn(15, 0, 0) < 0, 'formerly-face point now inside');
});

test('bad expression params are rejected at edit time', () => {
  const doc = new ModelDocument(null);
  assert.throws(() => doc.createNode({ type: 'sphere', params: { radius: 'nope' } }), /Unknown identifier 'nope'/);
  doc.setVar('r', 5);
  doc.createNode({ type: 'sphere', id: 's', params: { radius: 'r' } });
  assert.throws(() => doc.updateNode('s', { params: { radius: 'r + bogus' } }), /Unknown identifier 'bogus'/);
  // The rejected update did not mutate the stored param.
  assert.strictEqual(doc.nodes.s.params.radius, 'r');
});
