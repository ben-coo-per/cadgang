import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ModelDocument } from '../src/core/document.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cadgang-'));
}

test('pos is accepted on create and survives toJSON round-trip', () => {
  const doc = new ModelDocument(null);
  doc.createNode({ type: 'sphere', id: 's', pos: [12, -3.5] });
  assert.deepStrictEqual(doc.nodes.s.pos, [12, -3.5]);
  const json = JSON.parse(JSON.stringify(doc.toJSON()));
  assert.deepStrictEqual(json.nodes.s.pos, [12, -3.5]);
});

test('pos is updatable via updateNode', () => {
  const doc = new ModelDocument(null);
  doc.createNode({ type: 'sphere', id: 's' });
  assert.strictEqual(doc.nodes.s.pos, undefined);
  doc.updateNode('s', { pos: [1, 2] });
  assert.deepStrictEqual(doc.nodes.s.pos, [1, 2]);
});

test('invalid pos is rejected on create and update', () => {
  const doc = new ModelDocument(null);
  assert.throws(() => doc.createNode({ type: 'sphere', id: 'a', pos: [1] }), /pos must be/);
  assert.throws(() => doc.createNode({ type: 'sphere', id: 'b', pos: [1, 2, 3] }), /pos must be/);
  assert.throws(() => doc.createNode({ type: 'sphere', id: 'c', pos: [1, NaN] }), /pos must be/);
  assert.throws(() => doc.createNode({ type: 'sphere', id: 'd', pos: 'x' }), /pos must be/);
  doc.createNode({ type: 'sphere', id: 's' });
  assert.throws(() => doc.updateNode('s', { pos: [Infinity, 0] }), /pos must be/);
});

test('saveAs / loadFrom round-trip restores nodes and output', () => {
  const dir = tmpDir();
  const a = new ModelDocument(null);
  a.createNode({ type: 'box', id: 'b', params: { size: [10, 10, 10] }, pos: [5, 6] });
  a.createNode({ type: 'sphere', id: 's', params: { radius: 4 } });
  a.setOutput('s');
  const { name, file } = a.saveAs(dir, 'my model');
  assert.strictEqual(name, 'my model');
  assert.ok(fs.existsSync(file));

  const b = new ModelDocument(null);
  b.createNode({ type: 'sphere', id: 'other' });
  const revBefore = b.revision;
  const loaded = b.loadFrom(dir, 'my model');
  assert.deepStrictEqual(Object.keys(b.nodes).sort(), ['b', 's']);
  assert.strictEqual(b.output, 's');
  assert.deepStrictEqual(b.nodes.b.pos, [5, 6]);
  assert.strictEqual(loaded.output, 's');
  assert.ok(b.revision > revBefore, 'revision keeps incrementing (not reset)');
});

test('loadFrom on a missing save throws', () => {
  const dir = tmpDir();
  const doc = new ModelDocument(null);
  assert.throws(() => doc.loadFrom(dir, 'nope'), /Save 'nope' not found/);
});

test('listSaves lists what was saved, newest first', () => {
  const dir = tmpDir();
  const doc = new ModelDocument(null);
  doc.createNode({ type: 'sphere', id: 's' });
  doc.saveAs(dir, 'first');
  doc.createNode({ type: 'box', id: 'b', params: { size: [1, 1, 1] } });
  doc.saveAs(dir, 'second');

  const saves = doc.listSaves(dir);
  const names = saves.map((s) => s.name).sort();
  assert.deepStrictEqual(names, ['first', 'second']);
  for (const s of saves) {
    assert.ok(typeof s.mtime === 'string' && !Number.isNaN(Date.parse(s.mtime)));
    assert.strictEqual(typeof s.nodes, 'number');
  }
  const second = saves.find((s) => s.name === 'second');
  assert.strictEqual(second.nodes, 2);
});

test('listSaves returns [] when the dir does not exist', () => {
  const doc = new ModelDocument(null);
  assert.deepStrictEqual(doc.listSaves(path.join(os.tmpdir(), 'cadgang-missing-' + Date.now())), []);
});

test('listSaves reports null nodes for an unparseable save', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'broken.json'), '{ not valid json');
  const saves = new ModelDocument(null).listSaves(dir);
  assert.strictEqual(saves.find((s) => s.name === 'broken').nodes, null);
});

test('sanitize strips path separators so a save cannot escape the dir', () => {
  const dir = tmpDir();
  const doc = new ModelDocument(null);
  doc.createNode({ type: 'sphere', id: 's' });
  const { name, file } = doc.saveAs(dir, '../evil');
  // Slashes and dots-with-slash are stripped; file stays inside dir.
  assert.strictEqual(name, 'evil');
  assert.strictEqual(path.dirname(path.resolve(file)), path.resolve(dir));
  assert.ok(!fs.existsSync(path.join(path.dirname(dir), 'evil.json')), 'nothing written outside the saves dir');
});

test('deleteSave removes a save and errors when missing', () => {
  const dir = tmpDir();
  const doc = new ModelDocument(null);
  doc.createNode({ type: 'sphere', id: 's' });
  doc.saveAs(dir, 'gone');
  assert.strictEqual(doc.deleteSave(dir, 'gone'), 'gone');
  assert.ok(!fs.existsSync(path.join(dir, 'gone.json')));
  assert.throws(() => doc.deleteSave(dir, 'gone'), /not found/);
});

test('empty name after sanitize is rejected', () => {
  const dir = tmpDir();
  const doc = new ModelDocument(null);
  doc.createNode({ type: 'sphere', id: 's' });
  assert.throws(() => doc.saveAs(dir, '///'), /empty after sanitizing/);
});
