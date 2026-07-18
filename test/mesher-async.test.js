import { test } from 'node:test';
import assert from 'node:assert';
import { compileNode, meshingBounds } from '../src/core/sdf.js';
import { ModelDocument } from '../src/core/document.js';
import { meshSDF, meshSDFAsync } from '../src/core/mesher.js';

function sampleSDF() {
  const doc = new ModelDocument(null);
  doc.createNode({ type: 'box', id: 'b', params: { size: [24, 16, 20], round: 3 } });
  doc.createNode({ type: 'sphere', id: 's', params: { radius: 10 } });
  doc.createNode({ type: 'smooth_union', id: 'u', params: { blend: 4 }, inputs: { a: 'b', b: 's' } });
  doc.setOutput('u');
  const { fn, bbox } = compileNode(doc, 'u');
  return { fn, bounds: meshingBounds(bbox) };
}

test('meshSDFAsync output is byte-identical to meshSDF', async () => {
  const { fn, bounds } = sampleSDF();
  const sync = meshSDF(fn, bounds, 64);
  const asyncMesh = await meshSDFAsync(fn, bounds, 64, () => {});

  assert.strictEqual(asyncMesh.positions.length, sync.positions.length);
  assert.strictEqual(asyncMesh.indices.length, sync.indices.length);
  assert.strictEqual(asyncMesh.normals.length, sync.normals.length);
  // Buffers are typed arrays — compare exact bytes.
  assert.deepStrictEqual(Buffer.from(asyncMesh.positions.buffer), Buffer.from(sync.positions.buffer));
  assert.deepStrictEqual(Buffer.from(asyncMesh.indices.buffer), Buffer.from(sync.indices.buffer));
  assert.deepStrictEqual(Buffer.from(asyncMesh.normals.buffer), Buffer.from(sync.normals.buffer));
  assert.deepStrictEqual(asyncMesh.stats, sync.stats);
});

test('onProgress is monotonic, starts low, and ends at exactly 1', async () => {
  const { fn, bounds } = sampleSDF();
  const seen = [];
  await meshSDFAsync(fn, bounds, 72, (p) => seen.push(p));

  assert.ok(seen.length >= 2, 'multiple progress reports');
  assert.ok(seen[0] <= 0.1, `first report ${seen[0]} should be <= ~0.1`);
  for (let i = 1; i < seen.length; i++) {
    assert.ok(seen[i] >= seen[i - 1], `progress must not decrease (${seen[i - 1]} -> ${seen[i]})`);
    assert.ok(seen[i] >= 0 && seen[i] <= 1, `progress ${seen[i]} in [0,1]`);
  }
  assert.strictEqual(seen[seen.length - 1], 1, 'final report is exactly 1');
});

test('onProgress crosses each weighted phase and reaches the mid-range', async () => {
  const { fn, bounds } = sampleSDF();
  const seen = [];
  await meshSDFAsync(fn, bounds, 80, (p) => seen.push(p));
  // Sampling alone caps at 0.70; we should see values inside the later phases too.
  assert.ok(seen.some((p) => p > 0 && p < 0.7), 'some sampling-phase progress');
  assert.ok(seen.some((p) => p > 0.7), 'progress advances past the sampling phase');
});
