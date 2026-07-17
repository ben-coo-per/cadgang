/** cadgang REST API. */

import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import { compileNode, meshingBounds, nodeTypeCatalog, GraphError } from '../core/sdf.js';
import { meshSDF } from '../core/mesher.js';
import { toBinarySTL } from '../core/stl.js';
import { renderPreview } from '../core/render.js';

export function apiRouter(doc, rootDir) {
  const r = express.Router();

  const fail = (res, err, code = 400) =>
    res.status(err instanceof GraphError ? code : 500).json({ error: err.message });

  /** Compile the requested node (or the document output). */
  function compiled(req) {
    const nodeId = req.query.node || req.body?.node || doc.output;
    if (!nodeId) throw new GraphError('Document has no output node set and no node was specified');
    const { fn, bbox } = compileNode(doc, nodeId);
    return { nodeId, fn, bounds: meshingBounds(bbox) };
  }

  r.get('/health', (req, res) => res.json({ ok: true, revision: doc.revision }));

  r.get('/node-types', (req, res) => res.json(nodeTypeCatalog()));

  r.get('/document', (req, res) => res.json(doc.toJSON()));

  r.post('/document/clear', (req, res) => {
    doc.clear();
    res.json(doc.toJSON());
  });

  r.post('/document/output', (req, res) => {
    try {
      doc.setOutput(req.body.node ?? null);
      res.json(doc.toJSON());
    } catch (e) { fail(res, e); }
  });

  r.post('/nodes', (req, res) => {
    try { res.json(doc.createNode(req.body)); } catch (e) { fail(res, e); }
  });

  r.patch('/nodes/:id', (req, res) => {
    try { res.json(doc.updateNode(req.params.id, req.body)); } catch (e) { fail(res, e); }
  });

  r.delete('/nodes/:id', (req, res) => {
    try { doc.deleteNode(req.params.id); res.json({ deleted: req.params.id }); } catch (e) { fail(res, e); }
  });

  /** Evaluate the SDF at points: {points: [[x,y,z],...], node?} -> {distances} */
  r.post('/eval', (req, res) => {
    try {
      const { fn, nodeId } = compiled(req);
      const pts = req.body.points;
      if (!Array.isArray(pts) || pts.some((p) => !Array.isArray(p) || p.length !== 3))
        throw new GraphError('Body must include points: [[x,y,z], ...]');
      res.json({ node: nodeId, distances: pts.map(([x, y, z]) => fn(x, y, z)) });
    } catch (e) { fail(res, e); }
  });

  /** Mesh as JSON (positions/normals/indices as arrays) — consumed by the web UI. */
  r.get('/mesh', (req, res) => {
    try {
      const { fn, bounds, nodeId } = compiled(req);
      const resolution = parseInt(req.query.resolution || '90', 10);
      const mesh = meshSDF(fn, bounds, resolution);
      res.json({
        node: nodeId,
        revision: doc.revision,
        positions: Array.from(mesh.positions),
        normals: Array.from(mesh.normals),
        indices: Array.from(mesh.indices),
        stats: mesh.stats,
      });
    } catch (e) { fail(res, e); }
  });

  /** Mesh stats only (cheap payload for agents). */
  r.get('/mesh/stats', (req, res) => {
    try {
      const { fn, bounds, nodeId } = compiled(req);
      const resolution = parseInt(req.query.resolution || '90', 10);
      const mesh = meshSDF(fn, bounds, resolution);
      res.json({ node: nodeId, revision: doc.revision, stats: mesh.stats });
    } catch (e) { fail(res, e); }
  });

  /** Binary STL download; ?file=name also writes exports/name.stl on disk. */
  r.get('/export/stl', (req, res) => {
    try {
      const { fn, bounds, nodeId } = compiled(req);
      const resolution = parseInt(req.query.resolution || '128', 10);
      const mesh = meshSDF(fn, bounds, resolution);
      const stl = toBinarySTL(mesh.positions, mesh.indices, nodeId);
      let savedTo = null;
      if (req.query.file) {
        const safe = String(req.query.file).replace(/[^\w.-]/g, '_').replace(/\.stl$/i, '');
        const dir = path.join(rootDir, 'exports');
        fs.mkdirSync(dir, { recursive: true });
        savedTo = path.join(dir, `${safe}.stl`);
        fs.writeFileSync(savedTo, stl);
      }
      res.setHeader('Content-Type', 'model/stl');
      res.setHeader('Content-Disposition', `attachment; filename="${nodeId}.stl"`);
      if (savedTo) res.setHeader('X-Saved-To', savedTo);
      res.send(stl);
    } catch (e) { fail(res, e); }
  });

  /** Raymarched PNG preview. ?width&height&yaw&pitch&node */
  r.get('/preview.png', (req, res) => {
    try {
      const { fn, bounds } = compiled(req);
      const png = renderPreview(fn, bounds, {
        width: parseInt(req.query.width || '640', 10),
        height: parseInt(req.query.height || '480', 10),
        yaw: parseFloat(req.query.yaw ?? '-35'),
        pitch: parseFloat(req.query.pitch ?? '25'),
      });
      res.setHeader('Content-Type', 'image/png');
      res.send(png);
    } catch (e) { fail(res, e); }
  });

  return r;
}
