/**
 * The cell REST surface, exercised over a real socket.
 *
 * These routes are where the authoring loop actually lives — introspect, test a
 * query, apply, render — and the failure modes are HTTP-shaped (route ordering,
 * a scope disposed before the response is serialized) rather than anything a
 * unit test of the document model would catch.
 */

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { CellDocument } from '../src/core/cells.js';
import { cellsRouter } from '../src/server/cells.js';

const doc = new CellDocument();
let base;
let server;

before(async () => {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/api/cells', cellsRouter(doc, '/tmp/cadgang-test'));
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}/api/cells`;
});

after(() => server?.close());

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (res.headers.get('content-type') || '').includes('json')
    ? await res.json()
    : Buffer.from(await res.arrayBuffer());
  return { status: res.status, data, headers: res.headers };
}

const BOX_CODE = `
export const params = { w: 60, d: 40, h: 24 };
export default ({ p, brep }) => brep.box(p.w, p.d, p.h);
`;

test('a cell stack can be authored over HTTP', async () => {
  let r = await api('/', { method: 'POST', body: { id: 'body', prompt: '60×40×24 box', code: BOX_CODE } });
  assert.equal(r.status, 200);
  assert.equal(r.data.status, 'ok');
  assert.deepEqual(r.data.params, { w: 60, d: 40, h: 24 });

  r = await api('/document');
  assert.equal(r.data.version, 2);
  assert.equal(r.data.cells.length, 1);
});

test('topology introspection reports what a query could filter on', async () => {
  const { status, data } = await api('/topology?cell=body');
  assert.equal(status, 200);
  assert.equal(data.counts.faces, 6);
  assert.equal(data.counts.edges, 12);
  assert.ok(data.faces.every((f) => f.kind === 'PLANE' && Number.isFinite(f.area)));
  // The measures come back alongside, so a text-only client needs one call.
  assert.equal(Math.round(data.measures.volume), 60 * 40 * 24);
  assert.deepEqual(data.measures.bbox.size.map(Math.round), [60, 40, 24]);
});

test('a query can be counted before it is committed to a cell', async () => {
  let r = await api('/query', {
    method: 'POST',
    body: { cell: 'body', expression: "q.edges(shape).linear().along('z')" },
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.count, 4);
  assert.equal(r.data.matches.length, 4);

  // The check that makes generated code trustworthy: a wrong guess reads as
  // zero here rather than as a silently different part later.
  r = await api('/query', {
    method: 'POST',
    body: { cell: 'body', expression: 'q.edges(shape).circular()' },
  });
  assert.equal(r.data.count, 0);

  r = await api('/query', { method: 'POST', body: { cell: 'body', expression: '42' } });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /did not produce a query/);
});

test('a query expression is sandboxed like a cell', async () => {
  const r = await api('/query', {
    method: 'POST',
    body: { cell: 'body', expression: 'typeof process === "undefined" ? q.faces(shape) : null' },
  });
  assert.equal(r.data.count, 6, 'process must not exist inside a query probe');
});

test('the second cell eats the first, and the stack evaluates', async () => {
  await api('/', {
    method: 'POST',
    body: {
      id: 'round',
      prompt: '3mm fillet on the vertical edges',
      code: `
        export const params = { r: 3 };
        export default ({ p, brep, q, input }) =>
          brep.fillet(input, q.edges(input).linear().along('z').expect(4), p.r);
      `,
    },
  });
  const { data } = await api('/evaluate');
  assert.deepEqual(data.order, ['body', 'round']);
  assert.deepEqual(data.cells.map((c) => c.status), ['ok', 'ok']);
  assert.equal(data.target, 'round');
  assert.ok(data.measures.volume < 60 * 40 * 24);
});

test('a parameter change over HTTP re-runs the program', async () => {
  const r = await api('/body', { method: 'PATCH', body: { params: { w: 80 } } });
  assert.equal(r.status, 200);
  assert.equal(r.data.status, 'ok', 'a knob is not a change of intent');
  const { data } = await api('/topology');
  assert.equal(Math.round(data.measures.bbox.size[0]), 80);
  assert.equal(data.counts.faces, 10, 'the fillet still caught exactly the four verticals');
});

test('a prompt edit is reported, not acted on', async () => {
  const r = await api('/body', { method: 'PATCH', body: { prompt: 'make it much taller' } });
  assert.equal(r.data.status, 'stale');
  const { data } = await api('/topology');
  assert.equal(Math.round(data.measures.bbox.size[2]), 24, 'geometry did not follow the prompt');
});

test('a compile commit is the only route back to ok', async () => {
  const r = await api('/body/compile', {
    method: 'POST',
    body: {
      prompt: 'make it much taller',
      code: BOX_CODE.replace('h: 24', 'h: 90'),
      compiledBy: 'claude-opus-5',
    },
  });
  assert.equal(r.data.status, 'ok');
  assert.equal(r.data.compiledBy, 'claude-opus-5');
  const { data } = await api('/topology');
  assert.equal(Math.round(data.measures.bbox.size[2]), 90);
});

test('a broken cell fails the request with the cell named', async () => {
  await api('/', {
    method: 'POST',
    body: { id: 'bust', code: "export default ({ brep, q, input }) => brep.fillet(input, q.faces(input).spherical(), 1);" },
  });
  const r = await api('/evaluate');
  assert.equal(r.status, 400);
  assert.match(r.data.error, /matched no faces/);

  // stopOnError=0 walks the whole stack so one round trip shows everything.
  const all = await api('/evaluate?stopOnError=0');
  assert.equal(all.status, 200);
  assert.deepEqual(all.data.cells.map((c) => c.status), ['ok', 'ok', 'error']);

  await api('/bust', { method: 'DELETE' });
});

test('a broken tail cell does not blank the viewport', async () => {
  await api('/', {
    method: 'POST',
    body: { id: 'tail', code: 'export default () => { throw new Error("still drafting"); };' },
  });

  // The viewport falls back to the deepest cell that built, and says which.
  const mesh = await api('/mesh');
  assert.equal(mesh.status, 200);
  assert.equal(mesh.data.cell, 'round');
  assert.equal(mesh.data.requested, 'tail');
  assert.equal(mesh.data.partial, true);
  assert.ok(mesh.data.positions.length > 0);

  // The numbers follow the same fallback rather than going blank.
  const ev = await api('/evaluate?stopOnError=0');
  assert.equal(ev.data.shown, 'round');
  assert.ok(ev.data.measures.volume > 0);

  // An export must NOT: shipping a partial model as the model is a worse
  // failure than refusing.
  const step = await api('/export/step?cell=tail');
  assert.equal(step.status, 400);
  assert.match(step.data.error, /still drafting/);

  await api('/tail', { method: 'DELETE' });
});

test('geometry comes out as triangles, STEP, and a PNG', async () => {
  const mesh = await api('/mesh');
  assert.ok(mesh.data.exact);
  assert.ok(mesh.data.positions.length > 0 && mesh.data.indices.length > 0);
  assert.ok(mesh.data.faces.length > 0, 'face ranges ship for picking');
  assert.ok(mesh.data.edges.lines.length > 0, 'real edge curves ship for the wireframe');

  const step = await api('/export/step');
  assert.equal(step.status, 200);
  assert.match(step.data.subarray(0, 13).toString(), /^ISO-10303-21/);

  const png = await api('/preview.png?width=64&height=48');
  assert.equal(png.status, 200);
  assert.deepEqual([...png.data.subarray(1, 4)], [0x50, 0x4e, 0x47]);
});

test('a delete that would orphan a reference is refused', async () => {
  await api('/round', { method: 'PATCH', body: { refs: ['body'] } });
  const r = await api('/body', { method: 'DELETE' });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /cell\(s\) round reference it/);
});

test('a pick is made by index and stored as an anchor', async () => {
  await api('/', {
    method: 'POST',
    body: {
      id: 'nick', prompt: 'chamfer that edge', selections: { lip: 'edge' },
      code: 'export default ({ brep, sel, input }) => brep.chamfer(input, sel.lip, 1);',
    },
  });

  // The cell parks, and /pending tells the UI what to click and where.
  let r = await api('/pending');
  assert.equal(r.data.pending.length, 1);
  assert.deepEqual(
    { cell: r.data.pending[0].cell, name: r.data.pending[0].name, type: r.data.pending[0].type },
    { cell: 'nick', name: 'lip', type: 'edge' }
  );
  const source = r.data.pending[0].source;
  assert.equal(source, 'round', 'you pick on the shape the cell is about to modify');

  // Find a linear edge on the source shape the way the viewport would.
  const topo = await api(`/topology?cell=${source}`);
  const index = topo.data.edges.findIndex((e) => e.kind === 'LINE');
  assert.ok(index >= 0);

  r = await api('/nick/selections/lip', { method: 'POST', body: { type: 'edge', index } });
  assert.equal(r.status, 200);
  assert.equal(r.data.status, 'ok');
  const stored = r.data.selections.lip;
  assert.equal(stored.anchor.kind, 'LINE');
  assert.equal(stored.anchor.unit.length, 3);
  assert.ok(stored.query.includes('nearestTo'));
  assert.ok(stored.pickedAt);
  // Never an index: that is the whole point.
  assert.equal(stored.anchor.index, undefined);

  assert.equal((await api('/pending')).data.pending.length, 0);
  assert.equal((await api('/evaluate')).data.cells.at(-1).status, 'ok');

  await api('/nick', { method: 'DELETE' });
});

test('an edge is picked by the point that was clicked', async () => {
  await api('/', {
    method: 'POST',
    body: {
      id: 'clicky', selections: { lip: 'edge' },
      code: 'export default ({ brep, sel, input }) => brep.chamfer(input, sel.lip, 1);',
    },
  });
  const source = (await api('/pending')).data.pending[0].source;
  const edges = (await api(`/topology?cell=${source}`)).data.edges;
  const wanted = edges.find((e) => e.kind === 'LINE');

  // The viewport sends where the click landed, not an index — OCCT tessellates
  // edges in a different order than it enumerates them.
  const r = await api('/clicky/selections/lip', {
    method: 'POST',
    body: { type: 'edge', point: wanted.center },
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.selections.lip.anchor.kind, 'LINE');
  assert.deepEqual(r.data.selections.lip.anchor.center, wanted.center);
  assert.equal((await api('/evaluate')).data.cells.at(-1).status, 'ok');

  await api('/clicky', { method: 'DELETE' });
});

test('a long poll returns as soon as the human picks', async () => {
  await api('/', {
    method: 'POST',
    body: {
      id: 'waity', selections: { lip: 'edge' },
      code: 'export default ({ brep, sel, input }) => brep.chamfer(input, sel.lip, 1);',
    },
  });
  const source = (await api('/pending')).data.pending[0].source;
  const point = (await api(`/topology?cell=${source}`)).data.edges.find((e) => e.kind === 'LINE').center;

  const waiting = api('/pending?wait=10');
  const answered = await api('/waity/selections/lip', { method: 'POST', body: { type: 'edge', point } });
  assert.equal(answered.status, 200);

  const r = await waiting;
  assert.equal(r.data.pending.length, 0);
  assert.notEqual(r.data.timedOut, true, 'it woke on the pick, not on the clock');

  await api('/waity', { method: 'DELETE' });
});

test('an out-of-range or wrongly-typed pick is refused', async () => {
  await api('/', {
    method: 'POST',
    body: {
      id: 'nick2', selections: { lip: 'edge' },
      code: 'export default ({ brep, sel, input }) => brep.chamfer(input, sel.lip, 1);',
    },
  });
  let r = await api('/nick2/selections/lip', { method: 'POST', body: { type: 'edge', index: 9999 } });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /no edge 9999/);

  r = await api('/nick2/selections/lip', { method: 'POST', body: { type: 'face', index: 0 } });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /wants a edge, but the pick was a face/);

  r = await api('/nick2/selections/nope', { method: 'POST', body: { type: 'edge', index: 0 } });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /does not declare a selection named 'nope'/);

  await api('/nick2', { method: 'DELETE' });
});

test('undo works through the API', async () => {
  const before = (await api('/document')).data.cells.length;
  await api('/', { method: 'POST', body: { id: 'scratch', code: BOX_CODE } });
  assert.equal((await api('/document')).data.cells.length, before + 1);
  await api('/undo', { method: 'POST' });
  assert.equal((await api('/document')).data.cells.length, before);
});
