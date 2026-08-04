import { test } from 'node:test';
import assert from 'node:assert';
import os from 'node:os';
import http from 'node:http';
import express from 'express';
import { ModelDocument } from '../src/core/document.js';
import { apiRouter } from '../src/server/api.js';

/** Start the API on an ephemeral port; returns {base, close}. */
async function serve(doc) {
  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter(doc, os.tmpdir()));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

test('GET /api/mesh?colors=1 attributes vertices to nearest direct part', async () => {
  const doc = new ModelDocument(null);
  doc.createNode({ type: 'sphere', id: 'A', params: { radius: 10 } });
  doc.createNode({ type: 'transform', id: 'ta', params: { translate: [-20, 0, 0] }, inputs: { shape: 'A' } });
  doc.createNode({ type: 'sphere', id: 'B', params: { radius: 10 } });
  doc.createNode({ type: 'transform', id: 'tb', params: { translate: [20, 0, 0] }, inputs: { shape: 'B' } });
  doc.createNode({ type: 'union', id: 'u', inputs: { shapes: ['ta', 'tb'] } });
  doc.setOutput('u');

  const { base, close } = await serve(doc);
  try {
    const res = await fetch(`${base}/api/mesh?colors=1&resolution=48`);
    const body = await res.json();
    const vertexCount = body.positions.length / 3;

    assert.deepStrictEqual(body.partIds, ['ta', 'tb']);
    assert.strictEqual(body.owners.length, vertexCount);

    // Left cluster (x<0) is sphere A (index 0); right cluster (x>0) is B (index 1).
    let checkedLeft = 0, checkedRight = 0;
    for (let v = 0; v < vertexCount; v++) {
      const x = body.positions[v * 3];
      if (x < -5) { assert.strictEqual(body.owners[v], 0); checkedLeft++; }
      if (x > 5) { assert.strictEqual(body.owners[v], 1); checkedRight++; }
    }
    assert.ok(checkedLeft > 100 && checkedRight > 100, 'both clusters sampled');
  } finally {
    close();
  }
});

test('colors=1 on an input-less node attributes everything to the node itself', async () => {
  const doc = new ModelDocument(null);
  doc.createNode({ type: 'sphere', id: 's', params: { radius: 10 } });
  doc.setOutput('s');

  const { base, close } = await serve(doc);
  try {
    const res = await fetch(`${base}/api/mesh?colors=1&resolution=40`);
    const body = await res.json();
    assert.deepStrictEqual(body.partIds, ['s']);
    assert.strictEqual(body.owners.length, body.positions.length / 3);
    assert.ok(body.owners.every((o) => o === 0));
  } finally {
    close();
  }
});

// The web UI always asks for colors=1, so a sketch input that throws on being
// asked for a distance took the whole mesh down — extrude and revolve rendered
// nothing at all.
test('colors=1 on a sketch-fed block meshes anyway, with no owners', async () => {
  const doc = new ModelDocument(null);
  doc.createNode({ type: 'sketch_rect', id: 'sk', params: { plane: 'XY', width: 30, height: 20 } });
  doc.createNode({ type: 'brep_extrude', id: 'ex', params: { distance: 10 }, inputs: { profile: 'sk' } });
  doc.setOutput('ex');

  const { base, close } = await serve(doc);
  try {
    const res = await fetch(`${base}/api/mesh?colors=1&resolution=40`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.ok(body.positions.length > 0, 'the extrude meshed');
    assert.strictEqual(body.owners, undefined);
    assert.strictEqual(body.partIds, undefined);
  } finally {
    close();
  }
});

test('mesh without colors omits partIds/owners; stats path never has them', async () => {
  const doc = new ModelDocument(null);
  doc.createNode({ type: 'sphere', id: 's', params: { radius: 10 } });
  doc.setOutput('s');

  const { base, close } = await serve(doc);
  try {
    const plain = await (await fetch(`${base}/api/mesh?resolution=40`)).json();
    assert.strictEqual(plain.owners, undefined);
    assert.strictEqual(plain.partIds, undefined);
    const stats = await (await fetch(`${base}/api/mesh/stats?resolution=40&colors=1`)).json();
    assert.strictEqual(stats.owners, undefined);
    assert.strictEqual(stats.partIds, undefined);
  } finally {
    close();
  }
});
