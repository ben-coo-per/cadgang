/**
 * The cadgang model document: a persistent graph of implicit-modeling nodes.
 * Autosaved to disk as JSON so the web UI and MCP server share one model.
 */

import fs from 'node:fs';
import path from 'node:path';
import { NODE_TYPES, GraphError, resolveParams } from './sdf.js';
import { evalExpr, RESERVED } from './expr.js';

const VAR_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const UNDO_LIMIT = 100;
const UNDO_COALESCE_MS = 800;

/** Every authored scalar string reachable in a params object (vec3 flattened). */
function paramStrings(params) {
  const out = [];
  for (const v of Object.values(params || {})) {
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) for (const c of v) if (typeof c === 'string') out.push(c);
  }
  return out;
}

/** Validate a node-editor position: an array of exactly two finite numbers. */
function validatePos(pos) {
  if (!Array.isArray(pos) || pos.length !== 2 || !pos.every((n) => Number.isFinite(n))) {
    throw new GraphError('pos must be an array of 2 finite numbers');
  }
  return [pos[0], pos[1]];
}

/** Sanitize a save name: keep letters, digits, space, dash, underscore; reject empty. */
function sanitizeSaveName(name) {
  const clean = String(name ?? '').replace(/[^A-Za-z0-9 _-]/g, '').trim();
  if (!clean) throw new GraphError('Save name is empty after sanitizing');
  return clean;
}

/** Resolve <dir>/<name>.json, guaranteeing the result stays inside dir. */
function saveFilePath(dir, name) {
  const clean = sanitizeSaveName(name);
  const resolvedDir = path.resolve(dir);
  const file = path.resolve(resolvedDir, `${clean}.json`);
  if (file !== path.join(resolvedDir, `${clean}.json`) || path.dirname(file) !== resolvedDir) {
    throw new GraphError(`Invalid save name '${name}'`);
  }
  return { name: clean, file };
}

export class ModelDocument {
  constructor(filePath = null) {
    this.filePath = filePath;
    this.revision = 0;
    this.output = null;
    this.nodes = {};
    this.vars = {};
    this.assets = {};
    this._counter = 0;
    this._listeners = new Set();
    this._undo = [];
    this._redo = [];
    this._lastSig = null;
    this._lastPushT = 0;
    if (filePath && fs.existsSync(filePath)) {
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        this.revision = data.revision ?? 0;
        this.output = data.output ?? null;
        this.nodes = data.nodes ?? {};
        this.vars = data.vars ?? {};
        this.assets = data.assets ?? {};
        this._counter = data.counter ?? Object.keys(this.nodes).length;
      } catch {
        // Corrupt file: start fresh rather than crash.
      }
    }
  }

  onChange(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _touch() {
    this.revision++;
    if (this.filePath) {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.toJSON(), null, 2));
    }
    for (const fn of this._listeners) fn(this);
  }

  toJSON() {
    return { revision: this.revision, output: this.output, nodes: this.nodes, vars: this.vars, assets: this.assets, counter: this._counter };
  }

  // ------------------------------------------------------------- undo/redo

  /** Cheap state snapshot. Asset OBJECTS are shared by reference (immutable
   *  once imported); only the dict membership is copied. */
  _snapshot() {
    return {
      nodes: structuredClone(this.nodes),
      output: this.output,
      vars: { ...this.vars },
      assets: { ...this.assets },
      counter: this._counter,
    };
  }

  /**
   * Record the pre-mutation state. Mutators call this after their validation
   * and before changing anything. Consecutive edits with the same `sig`
   * (e.g. a slider dragging one param) within UNDO_COALESCE_MS collapse into
   * one undo step. Returns true if an entry was pushed (callers that then
   * throw pop it back off).
   */
  _pushUndo(sig = null) {
    const now = Date.now();
    if (sig && sig === this._lastSig && now - this._lastPushT < UNDO_COALESCE_MS) {
      this._lastPushT = now;
      return false;
    }
    this._undo.push(this._snapshot());
    if (this._undo.length > UNDO_LIMIT) this._undo.shift();
    this._redo = [];
    this._lastSig = sig;
    this._lastPushT = now;
    return true;
  }

  _restore(s) {
    this.nodes = s.nodes;
    this.output = s.output;
    this.vars = s.vars;
    this.assets = s.assets;
    this._counter = s.counter;
    this._lastSig = null;
    this._touch();
  }

  undo() {
    if (!this._undo.length) throw new GraphError('Nothing to undo');
    this._redo.push(this._snapshot());
    this._restore(this._undo.pop());
    return this.toJSON();
  }

  redo() {
    if (!this._redo.length) throw new GraphError('Nothing to redo');
    this._undo.push(this._snapshot());
    this._restore(this._redo.pop());
    return this.toJSON();
  }

  _validateInputs(type, inputs = {}, selfId = null) {
    const spec = NODE_TYPES[type];
    for (const slot of Object.keys(inputs)) {
      if (!spec.inputs[slot]) throw new GraphError(`Type '${type}' has no input slot '${slot}'. Valid slots: ${Object.keys(spec.inputs).join(', ') || '(none)'}`);
      const refs = Array.isArray(inputs[slot]) ? inputs[slot] : [inputs[slot]];
      for (const r of refs) {
        if (r === selfId) throw new GraphError(`Node cannot reference itself`);
        if (r != null && !this.nodes[r]) throw new GraphError(`Input '${slot}' references unknown node '${r}'`);
      }
    }
  }

  createNode({ type, name, params = {}, inputs = {}, id, pos }) {
    if (!NODE_TYPES[type]) {
      throw new GraphError(`Unknown node type '${type}'. Available: ${Object.keys(NODE_TYPES).join(', ')}`);
    }
    const nodeId = id || `${type}_${this._counter + 1}`;
    if (this.nodes[nodeId]) throw new GraphError(`Node id '${nodeId}' already exists`);
    this._validateInputs(type, inputs);
    resolveParams(type, params, this.vars); // validate authored params resolve now; store raw below
    this._pushUndo();
    this._counter++;
    const node = { id: nodeId, type, name: name || nodeId, params, inputs };
    if (pos !== undefined) node.pos = validatePos(pos);
    this.nodes[nodeId] = node;
    // First node in an empty document automatically becomes the output.
    if (this.output === null && Object.keys(this.nodes).length === 1) this.output = nodeId;
    this._touch();
    return this.nodes[nodeId];
  }

  updateNode(id, { name, params, inputs, pos }) {
    const node = this.nodes[id];
    if (!node) throw new GraphError(`Node '${id}' does not exist`);
    // Validate everything before mutating anything (also keeps undo clean).
    if (inputs !== undefined) this._validateInputs(node.type, inputs, id);
    const merged = params !== undefined ? { ...node.params, ...params } : null;
    if (merged) resolveParams(node.type, merged, this.vars);
    const cleanPos = pos !== undefined ? validatePos(pos) : null;
    // Coalesce bursts of same-shaped edits (sliders, drags) into one undo step.
    const only = (k) => ({ params, inputs, name, pos }[k] !== undefined) &&
      ['params', 'inputs', 'name', 'pos'].every((o) => o === k || { params, inputs, name, pos }[o] === undefined);
    const sig = only('params') ? `params:${id}:${Object.keys(params).sort().join(',')}` :
      only('pos') ? `pos:${id}` : null;
    this._pushUndo(sig);
    if (inputs !== undefined) node.inputs = { ...node.inputs, ...inputs };
    if (merged) node.params = merged;
    if (name !== undefined) node.name = name;
    if (cleanPos) node.pos = cleanPos;
    this._touch();
    return node;
  }

  deleteNode(id) {
    if (!this.nodes[id]) throw new GraphError(`Node '${id}' does not exist`);
    // Refuse to delete a node other nodes depend on.
    for (const other of Object.values(this.nodes)) {
      if (other.id === id) continue;
      for (const ref of Object.values(other.inputs || {})) {
        const refs = Array.isArray(ref) ? ref : [ref];
        if (refs.includes(id))
          throw new GraphError(`Cannot delete '${id}': node '${other.id}' uses it as an input. Delete or rewire '${other.id}' first.`);
      }
    }
    this._pushUndo();
    delete this.nodes[id];
    if (this.output === id) this.output = null;
    this._touch();
  }

  setOutput(id) {
    if (id !== null && !this.nodes[id]) throw new GraphError(`Node '${id}' does not exist`);
    this._pushUndo();
    this.output = id;
    this._touch();
  }

  clear() {
    this._pushUndo();
    this.nodes = {};
    this.output = null;
    this.vars = {};
    this.assets = {};
    this._counter = 0;
    this._touch();
  }

  /**
   * Store an imported mesh asset. positions/indices are flat arrays; faces is
   * a list of {first, count} triangle ranges (one per B-rep face).
   * Returns the stored asset (with its generated id).
   */
  addAsset({ name, positions, indices, faces = [], bbox = null }) {
    if (!Array.isArray(positions) || !Array.isArray(indices) || positions.length % 3 || indices.length % 3)
      throw new GraphError('Asset needs flat positions/indices arrays with length divisible by 3');
    if (!indices.length) throw new GraphError('Asset has no triangles');
    this._pushUndo();
    const id = `asset_${++this._counter}`;
    this.assets[id] = { id, name: name || id, positions, indices, faces, bbox };
    this._touch();
    return this.assets[id];
  }

  /** Delete an asset, refusing while any node still references it. */
  deleteAsset(id) {
    if (!this.assets[id]) throw new GraphError(`Asset '${id}' does not exist`);
    const users = Object.values(this.nodes).filter((n) => n.params?.asset === id).map((n) => n.id);
    if (users.length)
      throw new GraphError(`Cannot delete asset '${id}': used by node(s) ${users.join(', ')}`);
    this._pushUndo();
    delete this.assets[id];
    this._touch();
  }

  /** Define or update a user variable. `value` may be a number or an expression
   *  (resolved against current vars); the resolved NUMBER is stored. */
  setVar(name, value) {
    if (!VAR_NAME.test(String(name)))
      throw new GraphError(`Variable name '${name}' must match ${VAR_NAME}`);
    if (RESERVED.has(name))
      throw new GraphError(`Variable name '${name}' collides with a built-in function or constant`);
    const num = typeof value === 'string' ? evalExpr(value, this.vars) : Number(value);
    if (!isFinite(num)) throw new GraphError(`Variable '${name}' must be a finite number`);
    this._pushUndo(`var:${name}`);
    this.vars[name] = num;
    this._touch();
    return this.vars;
  }

  /** Delete a user variable, refusing if any node's params still reference it. */
  deleteVar(name) {
    if (!Object.prototype.hasOwnProperty.call(this.vars, name))
      throw new GraphError(`Variable '${name}' does not exist`);
    const re = new RegExp(`\\b${name}\\b`);
    const users = [];
    for (const node of Object.values(this.nodes)) {
      if (paramStrings(node.params).some((s) => re.test(s))) users.push(node.id);
    }
    if (users.length)
      throw new GraphError(`Cannot delete variable '${name}': referenced by node(s) ${users.join(', ')}`);
    this._pushUndo();
    delete this.vars[name];
    this._touch();
    return this.vars;
  }

  /** Write the current document to <dir>/<name>.json. Returns {name, file}. */
  saveAs(dir, name) {
    const { name: clean, file } = saveFilePath(dir, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(this.toJSON(), null, 2));
    return { name: clean, file };
  }

  /** Replace document state from <dir>/<name>.json. Keeps incrementing revision. */
  loadFrom(dir, name) {
    const { file } = saveFilePath(dir, name);
    if (!fs.existsSync(file)) throw new GraphError(`Save '${name}' not found`);
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    this._pushUndo();
    this.nodes = data.nodes ?? {};
    this.output = data.output ?? null;
    this.vars = data.vars ?? {};
    this.assets = data.assets ?? {};
    this._counter = data.counter ?? Object.keys(this.nodes).length;
    this._touch();
    return this.toJSON();
  }

  /** List saves in dir, newest first: {name, mtime, nodes}. [] if dir missing. */
  listSaves(dir) {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        const full = path.join(dir, f);
        const stat = fs.statSync(full);
        let nodes = null;
        try {
          nodes = Object.keys(JSON.parse(fs.readFileSync(full, 'utf8')).nodes ?? {}).length;
        } catch {
          // Unparseable save: report null node count rather than fail the listing.
        }
        return { name: f.replace(/\.json$/, ''), mtime: stat.mtime.toISOString(), nodes };
      })
      .sort((a, b) => b.mtime.localeCompare(a.mtime));
  }

  /** Delete a save file. Returns the sanitized name. GraphError if missing. */
  deleteSave(dir, name) {
    const { name: clean, file } = saveFilePath(dir, name);
    if (!fs.existsSync(file)) throw new GraphError(`Save '${name}' not found`);
    fs.unlinkSync(file);
    return clean;
  }
}
