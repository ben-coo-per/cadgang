/** cadgang REST API. */

import path from 'node:path';
import fs from 'node:fs';
import url from 'node:url';
import express from 'express';
import { compileNode, meshingBounds, nodeTypeCatalog, NODE_TYPES, GraphError } from '../core/sdf.js';
import { meshSDF, meshSDFAsync } from '../core/mesher.js';
import { toBinarySTL } from '../core/stl.js';
import { renderPreview } from '../core/render.js';
import { importCadFile } from '../core/step.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const PKG_VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8')).version;
  } catch {
    return null;
  }
})();

export function apiRouter(doc, rootDir, broadcast = () => {}) {
  const r = express.Router();

  const fail = (res, err, code = 400) =>
    res.status(err instanceof GraphError ? code : 500).json({ error: err.message });

  /** Build a mesh_progress reporter throttled to <=1 message / 50ms (pct=1 always sent). */
  function meshProgress(nodeId, resolution) {
    let last = 0;
    return (pct) => {
      const now = Date.now();
      if (pct >= 1 || now - last >= 50) {
        last = now;
        broadcast({ type: 'mesh_progress', node: nodeId, resolution, pct });
      }
    };
  }

  /** Compile the requested node (or the document output). */
  function compiled(req) {
    const nodeId = req.query.node || req.body?.node || doc.output;
    if (!nodeId) throw new GraphError('Document has no output node set and no node was specified');
    const { fn, bbox } = compileNode(doc, nodeId);
    return { nodeId, fn, bounds: meshingBounds(bbox) };
  }

  const savesDir = path.join(rootDir, 'saves');

  const assetMeta = (a) => ({
    id: a.id, name: a.name, bbox: a.bbox,
    vertexCount: a.positions.length / 3, triangleCount: a.indices.length / 3, faceCount: (a.faces || []).length,
  });

  /** Document JSON with asset geometry stripped to metadata (assets can be
   *  megabytes; the UI fetches /assets/:id only when it needs triangles). */
  const docJSON = () => ({
    ...doc.toJSON(),
    assets: Object.fromEntries(Object.entries(doc.assets).map(([id, a]) => [id, assetMeta(a)])),
  });

  r.get('/health', (req, res) => res.json({ ok: true, revision: doc.revision, version: PKG_VERSION }));

  r.get('/files', (req, res) => {
    try { res.json({ files: doc.listSaves(savesDir) }); } catch (e) { fail(res, e); }
  });

  r.post('/files/save', (req, res) => {
    try {
      const { name } = doc.saveAs(savesDir, req.body?.name);
      res.json({ saved: name });
    } catch (e) { fail(res, e); }
  });

  r.post('/files/load', (req, res) => {
    try { doc.loadFrom(savesDir, req.body?.name); res.json(docJSON()); } catch (e) { fail(res, e); }
  });

  r.delete('/files/:name', (req, res) => {
    try { res.json({ deleted: doc.deleteSave(savesDir, req.params.name) }); } catch (e) { fail(res, e); }
  });

  r.get('/node-types', (req, res) => res.json(nodeTypeCatalog()));

  r.get('/document', (req, res) => res.json(docJSON()));

  r.post('/document/clear', (req, res) => {
    doc.clear();
    res.json(docJSON());
  });

  r.post('/document/output', (req, res) => {
    try {
      doc.setOutput(req.body.node ?? null);
      res.json(docJSON());
    } catch (e) { fail(res, e); }
  });

  r.post('/undo', (req, res) => {
    try { doc.undo(); res.json(docJSON()); } catch (e) { fail(res, e); }
  });

  r.post('/redo', (req, res) => {
    try { doc.redo(); res.json(docJSON()); } catch (e) { fail(res, e); }
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

  /** Upload a STEP/IGES/BREP file (raw body) -> stores a mesh asset and
   *  creates an imported_mesh node referencing it.
   *  ?name=<filename> picks the reader; ?deflection= tunes tessellation. */
  r.post('/import/step', express.raw({ type: () => true, limit: '100mb' }), async (req, res) => {
    try {
      if (!req.body?.length) throw new GraphError('Empty upload — send the file as the raw request body');
      const name = String(req.query.name || 'import.step');
      const deflection = parseFloat(req.query.deflection || '0.001');
      const imported = await importCadFile(req.body, { name, linearDeflection: deflection });
      const asset = doc.addAsset(imported);
      const nodeName = name.replace(/\.[^.]+$/, '') || asset.id;
      // ?node=<id>: attach the asset to an existing block (palette-created
      // imported_mesh / extrude_face) instead of creating a new one.
      const node = req.query.node
        ? doc.updateNode(String(req.query.node), { name: nodeName, params: { asset: asset.id } })
        : doc.createNode({ type: 'imported_mesh', name: nodeName, params: { asset: asset.id } });
      res.json({
        node,
        asset: {
          id: asset.id, name: asset.name, bbox: asset.bbox,
          vertexCount: imported.vertexCount, triangleCount: imported.triangleCount, faceCount: imported.faceCount,
        },
      });
    } catch (e) { fail(res, e); }
  });

  /** Asset metadata list (no geometry payload). */
  r.get('/assets', (req, res) => {
    res.json({
      assets: Object.values(doc.assets).map((a) => ({
        id: a.id, name: a.name, bbox: a.bbox,
        vertexCount: a.positions.length / 3, triangleCount: a.indices.length / 3, faceCount: (a.faces || []).length,
      })),
    });
  });

  /** Full asset geometry (positions/indices/faces) — used for face picking in the UI. */
  r.get('/assets/:id', (req, res) => {
    const a = doc.assets[req.params.id];
    if (!a) return fail(res, new GraphError(`Asset '${req.params.id}' does not exist`), 404);
    res.json(a);
  });

  r.delete('/assets/:id', (req, res) => {
    try { doc.deleteAsset(req.params.id); res.json({ deleted: req.params.id }); } catch (e) { fail(res, e); }
  });

  /** Set a user variable {name, value}; value may be an expression -> stored as a number. */
  r.post('/vars', (req, res) => {
    try { res.json({ vars: doc.setVar(req.body?.name, req.body?.value) }); } catch (e) { fail(res, e); }
  });

  r.delete('/vars/:name', (req, res) => {
    try { res.json({ vars: doc.deleteVar(req.params.name) }); } catch (e) { fail(res, e); }
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

  /** Direct-input node ids of a node, flattened across slots in slot order.
   *  Falls back to [the node itself] when it has no connected inputs. */
  function directParts(nodeId) {
    const node = doc.nodes[nodeId];
    const spec = node && NODE_TYPES[node.type];
    const parts = [];
    if (spec) {
      for (const slot of Object.keys(spec.inputs)) {
        const ref = (node.inputs || {})[slot];
        for (const id of Array.isArray(ref) ? ref : ref != null ? [ref] : []) parts.push(id);
      }
    }
    return parts.length ? parts : [nodeId];
  }

  /** Mesh as JSON (positions/normals/indices as arrays) — consumed by the web UI.
   *  ?colors=1 also attributes each vertex to the nearest direct-input part. */
  r.get('/mesh', async (req, res) => {
    let nodeId, resolution;
    try {
      const c = compiled(req);
      nodeId = c.nodeId;
      resolution = parseInt(req.query.resolution || '90', 10);
      const mesh = await meshSDFAsync(c.fn, c.bounds, resolution, meshProgress(nodeId, resolution));
      const out = {
        node: nodeId,
        revision: doc.revision,
        positions: Array.from(mesh.positions),
        normals: Array.from(mesh.normals),
        indices: Array.from(mesh.indices),
        stats: mesh.stats,
      };
      if (req.query.colors === '1') {
        const partIds = directParts(nodeId);
        const partFns = partIds.map((id) => compileNode(doc, id).fn);
        const pos = mesh.positions;
        const owners = new Array(pos.length / 3);
        for (let v = 0; v < owners.length; v++) {
          const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
          let best = 0, bestDist = Infinity;
          for (let p = 0; p < partFns.length; p++) {
            const d = Math.abs(partFns[p](x, y, z));
            if (d < bestDist) { bestDist = d; best = p; }
          }
          owners[v] = best;
        }
        out.partIds = partIds;
        out.owners = owners;
      }
      res.json(out);
    } catch (e) {
      if (nodeId != null) broadcast({ type: 'mesh_progress', node: nodeId, resolution, pct: 1 });
      fail(res, e);
    }
  });

  /** Mesh stats only (cheap payload for agents). */
  r.get('/mesh/stats', async (req, res) => {
    let nodeId, resolution;
    try {
      const c = compiled(req);
      nodeId = c.nodeId;
      resolution = parseInt(req.query.resolution || '90', 10);
      const mesh = await meshSDFAsync(c.fn, c.bounds, resolution, meshProgress(nodeId, resolution));
      res.json({ node: nodeId, revision: doc.revision, stats: mesh.stats });
    } catch (e) {
      if (nodeId != null) broadcast({ type: 'mesh_progress', node: nodeId, resolution, pct: 1 });
      fail(res, e);
    }
  });

  /** Binary STL download; ?file=name also writes exports/name.stl on disk. */
  r.get('/export/stl', async (req, res) => {
    let nodeId, resolution;
    try {
      const c = compiled(req);
      nodeId = c.nodeId;
      resolution = parseInt(req.query.resolution || '128', 10);
      const mesh = await meshSDFAsync(c.fn, c.bounds, resolution, meshProgress(nodeId, resolution));
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
    } catch (e) {
      if (nodeId != null) broadcast({ type: 'mesh_progress', node: nodeId, resolution, pct: 1 });
      fail(res, e);
    }
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
