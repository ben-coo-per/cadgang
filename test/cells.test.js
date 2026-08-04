/**
 * The cell model under test.
 *
 * Three properties matter more than the rest, and each has a test that fails
 * loudly if it stops holding:
 *
 *  - the prompt is source and the code is a lockfile — editing a prompt must
 *    not change geometry;
 *  - a parameter change re-runs the committed program and nothing else;
 *  - a cell program cannot reach the filesystem, the network, or the clock.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { initBrep, beginBrepScope } from '../src/core/brep.js';
import {
  CellDocument, CELL_STATUS, evaluateCells, evaluationOrder, dependenciesOf,
} from '../src/core/cells.js';
import { compileCell, transformCellSource } from '../src/core/sandbox.js';
import { checkCellResult, brep as apiBrep } from '../src/core/cellapi.js';
import { q } from '../src/core/query.js';
import * as ops from '../src/core/ops.js';
import { GraphError } from '../src/core/errors.js';

await initBrep();

function inScope(fn) {
  const scope = beginBrepScope();
  try {
    return fn();
  } finally {
    scope.dispose();
  }
}

const BOX_CODE = `
export const params = { w: 60, d: 40, h: 24 };
export default ({ p, brep }) => brep.box(p.w, p.d, p.h);
`;

const FILLET_CODE = `
export const params = { r: 3 };
export default ({ p, brep, q, input }) =>
  brep.fillet(input, q.edges(input).linear().along('z').expect(4), p.r);
`;

/** A document with the design doc's own example: box, then fillet its verticals. */
function enclosure() {
  const doc = new CellDocument();
  doc.addCell({ id: 'body', prompt: '60×40×24 enclosure', code: BOX_CODE });
  doc.addCell({ id: 'round', prompt: '3mm fillet on the vertical edges', code: FILLET_CODE });
  return doc;
}

// ------------------------------------------------------------------- sandbox

test('the module form the document stores is the form the author writes', () => {
  const out = transformCellSource(BOX_CODE);
  assert.ok(!/^\s*export/m.test(out), 'no export statement survives the rewrite');
  const compiled = compileCell(BOX_CODE, { id: 'body' });
  assert.deepEqual(compiled.params, { w: 60, d: 40, h: 24 });
});

test('a cell may still read its own params binding after the rewrite', () => {
  const compiled = compileCell(`
    export const params = { n: 7 };
    export default () => params.n;
  `, { id: 'x' });
  assert.equal(compiled.run({}), 7);
});

test('exports other than params and default are refused, not mangled', () => {
  assert.throws(
    () => transformCellSource('export function helper() {}\nexport default () => 1;'),
    GraphError
  );
  assert.throws(() => transformCellSource('export const params = {};'), /export default/);
});

test('a cell program cannot reach the host', () => {
  for (const global of ['process', 'require', 'fetch', 'setTimeout', 'Buffer']) {
    const compiled = compileCell(
      `export default () => typeof ${global};`,
      { id: 'probe' }
    );
    assert.equal(compiled.run({}), 'undefined', `${global} must not exist in a cell`);
  }
});

test('a runaway cell is stopped rather than hanging the server', () => {
  const compiled = compileCell('export default () => { while (true) {} };', {
    id: 'spin',
    timeoutMs: 200,
  });
  assert.throws(() => compiled.run({}), /ran longer than 200ms/);
});

test('console output is captured per run, not accumulated across runs', () => {
  const compiled = compileCell(`
    export default ({ p }) => { console.log('w is', p.w); return 1; };
  `, { id: 'chatty' });
  compiled.run({ p: { w: 60 } });
  assert.deepEqual(compiled.logs, [{ level: 'log', text: 'w is 60' }]);
  compiled.run({ p: { w: 80 } });
  assert.deepEqual(compiled.logs, [{ level: 'log', text: 'w is 80' }]);
});

test('params are restricted to values a slider can round-trip', () => {
  assert.throws(
    () => compileCell('export const params = { f: () => 1 };\nexport default () => 1;', { id: 'x' }),
    /must be a number, string, or boolean/
  );
});

// -------------------------------------------------------------- cell document

test('a cell with no refs eats the previous cell', () => {
  const doc = enclosure();
  assert.deepEqual(dependenciesOf(doc, 1), ['body']);
  assert.deepEqual(evaluationOrder(doc, 'round').map((c) => c.id), ['body', 'round']);
});

test('refs may only point backwards', () => {
  const doc = enclosure();
  assert.throws(() => doc.updateCell('body', { refs: ['round'] }), /comes later in the stack/);
  assert.throws(() => doc.updateCell('body', { refs: ['body'] }), /cannot reference itself/);
  assert.throws(() => doc.addCell({ id: 'x', code: BOX_CODE, refs: ['nope'] }), /unknown cell/);
});

test('a program that does not compile never enters the document', () => {
  const doc = new CellDocument();
  assert.throws(() => doc.addCell({ id: 'bad', code: 'export default (' }), /failed to compile/);
  assert.equal(doc.cells.length, 0);
});

test('declared params seed the cell and unknown params are refused', () => {
  const doc = enclosure();
  assert.deepEqual(doc.get('body').params, { w: 60, d: 40, h: 24 });
  doc.updateCell('body', { params: { w: 80 } });
  assert.equal(doc.get('body').params.w, 80);
  assert.throws(() => doc.updateCell('body', { params: { nope: 1 } }), /has no parameter 'nope'/);
});

test('editing a prompt makes the cell stale and leaves the code alone', () => {
  const doc = enclosure();
  const before = doc.get('body').code;
  doc.updateCell('body', { prompt: 'make it 80 wide' });
  const cell = doc.get('body');
  assert.equal(cell.status, CELL_STATUS.stale);
  assert.equal(cell.code, before, 'the lockfile does not move on a prompt edit');
  assert.equal(inScope(() => Math.round(ops.bbox(evaluateCells(doc, 'body').value).size[0])), 60);
});

test('a hand edit diverges; only a commit returns to ok', () => {
  const doc = enclosure();
  doc.updateCell('body', { code: BOX_CODE.replace('60', '61') });
  assert.equal(doc.get('body').status, CELL_STATUS.diverged);
  doc.commitCompile('body', {
    prompt: '61×40×24 enclosure',
    code: BOX_CODE.replace('60', '61'),
    compiledBy: 'claude-opus-5',
  });
  const cell = doc.get('body');
  assert.equal(cell.status, CELL_STATUS.ok);
  assert.equal(cell.compiledBy, 'claude-opus-5');
  assert.ok(cell.compiledAt);
});

test('a commit keeps dialled-in values but drops params the program removed', () => {
  const doc = enclosure();
  doc.updateCell('body', { params: { w: 80 } });
  doc.commitCompile('body', {
    code: 'export const params = { w: 60, d: 40 };\nexport default ({ p, brep }) => brep.box(p.w, p.d, 10);',
    params: { w: 80 },
  });
  assert.deepEqual(doc.get('body').params, { w: 80, d: 40 });
});

test('a declared selection parks the cell until the user picks', () => {
  const doc = enclosure();
  doc.updateCell('round', { selections: { lip: 'edge' } });
  assert.equal(doc.get('round').status, CELL_STATUS.awaitingPick);
  assert.throws(() => evaluateCells(doc, 'round'), /waiting for a pick: lip \(edge\)/);
  doc.resolveSelection('round', 'lip', {
    query: "edges.linear().along('z')",
    anchor: { center: [30, 20, 12], length: 24 },
  });
  assert.equal(doc.get('round').status, CELL_STATUS.ok);
});

test('deleting or reordering may not break a reference', () => {
  const doc = enclosure();
  doc.updateCell('round', { refs: ['body'] });
  assert.throws(() => doc.deleteCell('body'), /cell\(s\) round reference it/);
  assert.throws(() => doc.moveCell('body', 1), /before the cell it references/);
  doc.deleteCell('round');
  doc.deleteCell('body');
  assert.equal(doc.cells.length, 0);
});

test('undo restores the whole stack', () => {
  const doc = enclosure();
  doc.updateCell('body', { params: { w: 80 } });
  doc.deleteCell('round');
  assert.equal(doc.cells.length, 1);
  doc.undo();
  assert.equal(doc.cells.length, 2);
  doc.undo();
  assert.equal(doc.get('body').params.w, 60);
  doc.redo();
  assert.equal(doc.get('body').params.w, 80);
});

// ---------------------------------------------------------------- evaluation

test('a cell stack builds the part its prompts describe', () => {
  const doc = enclosure();
  doc.addCell({
    id: 'hollow',
    prompt: '2mm wall, open at the top',
    code: `
      export const params = { wall: 2 };
      export default ({ p, brep, q, input }) =>
        brep.shell(input, q.faces(input).planar().facing('+z').expect(1), p.wall);
    `,
  });
  inScope(() => {
    const { value, report } = evaluateCells(doc);
    assert.equal(report.length, 3);
    assert.ok(report.every((r) => r.status === 'ok'));
    const { size } = ops.bbox(value);
    assert.deepEqual(size.map(Math.round), [60, 40, 24]);
    // Filleted and hollow: well under the solid box it started as.
    assert.ok(ops.volume(value) < 60 * 40 * 24 * 0.4);
  });
});

test('turning a knob re-runs the program without re-prompting', () => {
  const doc = enclosure();
  const widthOf = () => inScope(() => ops.bbox(evaluateCells(doc).value).size[0]);
  assert.equal(Math.round(widthOf()), 60);
  doc.updateCell('body', { params: { w: 80 } });
  assert.equal(doc.get('body').status, CELL_STATUS.ok, 'a knob is not a change of intent');
  assert.equal(Math.round(widthOf()), 80);
  // The query in the fillet cell still means the same four edges at the new size.
  assert.equal(doc.get('round').code.includes("along('z')"), true);
});

test('a query that stops matching fails the cell instead of quietly changing the part', () => {
  const doc = new CellDocument();
  doc.addCell({ id: 'body', code: BOX_CODE });
  doc.addCell({
    id: 'wrong',
    code: `export default ({ brep, q, input }) =>
      brep.fillet(input, q.edges(input).circular().expect(4), 1);`,
  });
  inScope(() => {
    assert.throws(() => evaluateCells(doc), /matched 0 edges, expected 4/);
  });
});

test('an error names the cell it came from', () => {
  const doc = new CellDocument();
  doc.addCell({ id: 'boom', code: 'export default () => { throw new Error("nope"); };' });
  assert.throws(() => evaluateCells(doc), /Cell 'boom' threw: nope/);
});

test('a cell that returns nothing is an error, not a silent no-op', () => {
  const doc = enclosure();
  doc.addCell({ id: 'forgetful', code: 'export default ({ input }) => { input; };' });
  inScope(() => {
    assert.throws(() => evaluateCells(doc), /returned nothing/);
  });
  assert.throws(() => checkCellResult(q.faces(null), 'x'), /returned a query/);
});

test('an abandoned branch is not paid for on every evaluation', () => {
  const doc = enclosure();
  doc.addCell({ id: 'experiment', code: BOX_CODE, refs: ['body'] });
  doc.addCell({ id: 'final', code: FILLET_CODE, refs: ['round'] });
  assert.deepEqual(
    evaluationOrder(doc, 'final').map((c) => c.id),
    ['body', 'round', 'final'],
    'the experiment cell is skipped'
  );
});

test('stopOnError reports every broken cell in one pass', () => {
  const doc = new CellDocument();
  doc.addCell({ id: 'body', code: BOX_CODE });
  doc.addCell({ id: 'boom', code: 'export default () => { throw new Error("nope"); };' });
  inScope(() => {
    const { report } = evaluateCells(doc, 'boom', { stopOnError: false });
    assert.deepEqual(report.map((r) => r.status), ['ok', 'error']);
    assert.match(report[1].error, /nope/);
  });
});

test('the API handed to cells is frozen against cross-cell tampering', () => {
  assert.throws(() => { apiBrep.box = null; }, TypeError);
  const doc = new CellDocument();
  doc.addCell({
    id: 'meddle',
    code: `export default ({ brep, p }) => { try { brep.box = 1; } catch {} return brep.box(1, 1, 1); };`,
  });
  inScope(() => {
    assert.ok(evaluateCells(doc).value);
    assert.equal(typeof apiBrep.box, 'function');
  });
});

test('a cell can assert its own intent', () => {
  const doc = new CellDocument();
  doc.addCell({
    id: 'checked',
    code: `
      export const params = { s: 50 };
      export default ({ p, brep, assert }) => {
        const s = brep.box(p.s, p.s, p.s);
        assert.fitsIn(s, [40, 40, 40]);
        return s;
      };
    `,
  });
  inScope(() => {
    assert.throws(() => evaluateCells(doc), /exceeds 40 × 40 × 40 on X/);
  });
});
