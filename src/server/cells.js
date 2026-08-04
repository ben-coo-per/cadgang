/**
 * REST surface for the v2 cell document, mounted at /api/cells.
 *
 * It sits alongside the v1 node-graph API rather than replacing it: the two
 * documents share a process and a kernel but nothing else, so the old block
 * graph keeps working while v2 is built out.
 *
 * The routes are shaped by the authoring loop the design doc describes —
 * build, introspect, write a query, check the count, apply, render, assert.
 * `/topology` and `/query` are the two that carry the most weight, because
 * Claude cannot see the model and these are what it uses instead of looking.
 */

import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import { GraphError } from '../core/errors.js';
import { evaluateCells, evaluationOrder } from '../core/cells.js';
import { compileCell } from '../core/sandbox.js';
import { cellApi } from '../core/cellapi.js';
import { topology, Query } from '../core/query.js';
import * as ops from '../core/ops.js';
import { meshingBounds } from '../core/sdf.js';
import { meshStats } from '../core/mesher.js';
import { toBinarySTL } from '../core/stl.js';
import { renderPreview } from '../core/render.js';
import {
  initBrep, beginBrepScope, tessellate, tessellateEdges, exportStep,
  brepDistance, brepBBox,
} from '../core/brep.js';

export function cellsRouter(doc, rootDir) {
  const r = express.Router();

  const fail = (res, err, code = 400) =>
    res.status(err instanceof GraphError ? code : 500).json({ error: err.message });

  const state = () => doc.toJSON();

  /**
   * Evaluate up to the requested cell and hand the result to `body`.
   *
   * Same contract as the v1 API: the shape belongs to the scope opened here and
   * is freed on the way out, so `body` must convert to plain JS — triangles, a
   * buffer, a measurement — before it returns.
   *
   * `partial` is for the two routes that feed the viewport. Mid-edit the newest
   * cell is broken most of the time, and blanking the model would hide the four
   * cells that did work — so they fall back to the deepest shape that built and
   * say which cell that was. Everything else stays strict: introspecting or
   * exporting a different cell than the one asked for is worse than an error.
   */
  async function withShape(req, body, { partial = false } = {}) {
    const target = req.query.cell || req.body?.cell || doc.terminal;
    if (!target) throw new GraphError('The cell document is empty — add a cell first');
    await initBrep();
    const scope = beginBrepScope();
    try {
      const run = evaluateCells(doc, target, { stopOnError: !partial });
      const shown = run.value ? target : partial ? run.lastGood : null;
      if (!shown) {
        const failed = run.report.find((c) => c.status !== 'ok');
        throw new GraphError(failed?.error || `Cell '${target}' produced no geometry`);
      }
      return await body({
        ...run,
        shape: run.value ?? run.results.get(run.lastGood),
        shown,
        partial: shown !== target,
      });
    } finally {
      scope.dispose();
    }
  }

  const tolerance = (req) => {
    const t = parseFloat(req.query.tolerance ?? '');
    return Number.isFinite(t) && t > 0 ? Math.min(t, 5) : 0.01;
  };

  // ------------------------------------------------------------------ document

  r.get('/document', (req, res) => res.json(state()));

  r.post('/', (req, res) => {
    try { res.json(doc.addCell(req.body || {})); } catch (e) { fail(res, e); }
  });

  r.patch('/:id', (req, res) => {
    try { res.json(doc.updateCell(req.params.id, req.body || {})); } catch (e) { fail(res, e); }
  });

  /** Commit a recompile: the only path back to status 'ok'. */
  r.post('/:id/compile', (req, res) => {
    try { res.json(doc.commitCompile(req.params.id, req.body || {})); } catch (e) { fail(res, e); }
  });

  r.post('/:id/move', (req, res) => {
    try { res.json(doc.moveCell(req.params.id, req.body?.to)); } catch (e) { fail(res, e); }
  });

  r.post('/:id/selections/:name', (req, res) => {
    try {
      res.json(doc.resolveSelection(req.params.id, req.params.name, req.body || {}));
    } catch (e) { fail(res, e); }
  });

  r.delete('/:id', (req, res) => {
    try { doc.deleteCell(req.params.id); res.json({ deleted: req.params.id }); } catch (e) { fail(res, e); }
  });

  r.post('/document/output', (req, res) => {
    try { doc.setOutput(req.body?.cell ?? null); res.json(state()); } catch (e) { fail(res, e); }
  });

  r.post('/document/clear', (req, res) => { doc.clear(); res.json(state()); });

  r.post('/undo', (req, res) => {
    try { res.json(doc.undo()); } catch (e) { fail(res, e); }
  });

  r.post('/redo', (req, res) => {
    try { res.json(doc.redo()); } catch (e) { fail(res, e); }
  });

  // ---------------------------------------------------------------- evaluation

  /**
   * Run the stack and report per-cell status, console output, and timings —
   * without shipping any geometry. This is the cheap "did my edit work" call,
   * and `stopOnError=0` makes it show every broken cell in one pass instead of
   * one round trip per failure.
   */
  r.get('/evaluate', async (req, res) => {
    try {
      const target = req.query.cell || doc.terminal;
      if (!target) throw new GraphError('The cell document is empty — add a cell first');
      await initBrep();
      const scope = beginBrepScope();
      try {
        const stopOnError = req.query.stopOnError !== '0';
        const run = evaluateCells(doc, target, { stopOnError });
        // Measures follow the same fallback as the viewport: a broken tail cell
        // should not also blank the numbers for the part that did build.
        const shape = run.value ?? run.results.get(run.lastGood) ?? null;
        res.json({
          target: run.target,
          shown: run.value ? run.target : run.lastGood,
          revision: doc.revision,
          order: evaluationOrder(doc, target).map((c) => c.id),
          cells: run.report,
          measures: shape ? measuresOf(shape) : null,
        });
      } finally {
        scope.dispose();
      }
    } catch (e) { fail(res, e); }
  });

  /**
   * Full topology of a cell's result — the call that replaces vision.
   *
   * Every face and edge with the properties a query filters on, so the model
   * can read the shape it just built and write a reference that means something
   * about the geometry rather than about an index.
   */
  r.get('/topology', async (req, res) => {
    try {
      await withShape(req, ({ shape, target }) => {
        const t = topology(shape);
        res.json({ cell: target, revision: doc.revision, ...t, measures: measuresOf(shape) });
      });
    } catch (e) { fail(res, e); }
  });

  /**
   * Resolve a query expression against a cell's result and report what it
   * catches, without committing it to a cell.
   *
   * This is the step that makes generated geometry code trustworthy: confirm
   * the expression selects four edges and not twelve *before* filleting. The
   * expression is ordinary cell-language JavaScript with `q` and `shape` in
   * scope, so what is tested here is exactly what gets pasted into the cell.
   */
  r.post('/query', async (req, res) => {
    try {
      const expression = String(req.body?.expression ?? '').trim();
      if (!expression) {
        throw new GraphError(
          "Send an expression, e.g. { expression: \"q.edges(shape).linear().along('z')\" }"
        );
      }
      await withShape(req, ({ shape, target }) => {
        const probe = compileCell(
          `export default ({ q, input }) => { const shape = input; return (${expression}); };`,
          { id: `query:${target}` }
        );
        const result = probe.run(cellApi({ input: shape }));
        if (!(result instanceof Query)) {
          throw new GraphError(
            'That expression did not produce a query. Build one with q.faces(shape) or q.edges(shape).'
          );
        }
        res.json({ cell: target, source: expression, ...result.explain() });
      });
    } catch (e) { fail(res, e); }
  });

  // ------------------------------------------------------------------ geometry

  /** Triangles for the viewport, tessellated from the real surfaces. */
  r.get('/mesh', async (req, res) => {
    try {
      await withShape(req, ({ shape, target, shown, partial }) => {
        const t = tessellate(shape, { tolerance: tolerance(req) });
        const bounds = meshingBounds(brepBBox(shape));
        res.json({
          cell: shown,
          requested: target,
          partial,
          revision: doc.revision,
          exact: true,
          positions: Array.from(t.positions),
          normals: Array.from(t.normals),
          indices: Array.from(t.indices),
          faces: t.faces,
          edges: tessellateEdges(shape, { tolerance: tolerance(req) }),
          stats: meshStats(t.positions, t.indices, bounds, null),
        });
      }, { partial: true });
    } catch (e) { fail(res, e); }
  });

  /** Write an export to exports/<name>.<ext> when ?file= was given. */
  function saveExport(fileParam, ext, data) {
    if (!fileParam) return null;
    const safe = String(fileParam).replace(/[^\w.-]/g, '_').replace(new RegExp(`\\.${ext}$`, 'i'), '');
    const dir = path.join(rootDir, 'exports');
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, `${safe}.${ext}`);
    fs.writeFileSync(target, data);
    return target;
  }

  /** STEP download. Cells are exact all the way through, so this never degrades. */
  r.get('/export/step', async (req, res) => {
    try {
      await withShape(req, async ({ shape, target }) => {
        const step = await exportStep(shape);
        const savedTo = saveExport(req.query.file, 'step', step);
        res.setHeader('Content-Type', 'model/step');
        res.setHeader('Content-Disposition', `attachment; filename="${target}.step"`);
        if (savedTo) res.setHeader('X-Saved-To', savedTo);
        res.send(step);
      });
    } catch (e) { fail(res, e); }
  });

  r.get('/export/stl', async (req, res) => {
    try {
      await withShape(req, ({ shape, target }) => {
        const t = tessellate(shape, { tolerance: tolerance(req) });
        const stl = toBinarySTL(t.positions, t.indices, target);
        const savedTo = saveExport(req.query.file, 'stl', stl);
        res.setHeader('Content-Type', 'model/stl');
        res.setHeader('Content-Disposition', `attachment; filename="${target}.stl"`);
        if (savedTo) res.setHeader('X-Saved-To', savedTo);
        res.send(stl);
      });
    } catch (e) { fail(res, e); }
  });

  /**
   * Raymarched PNG preview. The raymarcher wants a distance field, which the
   * one-way bridge derives from the exact solid — the same path a B-rep block
   * takes in v1, so cells get previews for free.
   */
  r.get('/preview.png', async (req, res) => {
    try {
      await withShape(req, ({ shape }) => {
        const png = renderPreview(brepDistance(shape), meshingBounds(brepBBox(shape)), {
          width: parseInt(req.query.width || '640', 10),
          height: parseInt(req.query.height || '480', 10),
          yaw: parseFloat(req.query.yaw ?? '-35'),
          pitch: parseFloat(req.query.pitch ?? '25'),
        });
        res.setHeader('Content-Type', 'image/png');
        res.send(png);
      });
    } catch (e) { fail(res, e); }
  });

  return r;
}

/** Cheap facts about a result that a text-only client can act on. */
function measuresOf(shape) {
  const { min, max, size } = ops.bbox(shape);
  return { volume: ops.volume(shape), area: ops.area(shape), bbox: { min, max, size } };
}
