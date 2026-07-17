/**
 * The cadgang model document: a persistent graph of implicit-modeling nodes.
 * Autosaved to disk as JSON so the web UI and MCP server share one model.
 */

import fs from 'node:fs';
import path from 'node:path';
import { NODE_TYPES, GraphError } from './sdf.js';

export class ModelDocument {
  constructor(filePath = null) {
    this.filePath = filePath;
    this.revision = 0;
    this.output = null;
    this.nodes = {};
    this._counter = 0;
    this._listeners = new Set();
    if (filePath && fs.existsSync(filePath)) {
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        this.revision = data.revision ?? 0;
        this.output = data.output ?? null;
        this.nodes = data.nodes ?? {};
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
    return { revision: this.revision, output: this.output, nodes: this.nodes, counter: this._counter };
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

  createNode({ type, name, params = {}, inputs = {}, id }) {
    if (!NODE_TYPES[type]) {
      throw new GraphError(`Unknown node type '${type}'. Available: ${Object.keys(NODE_TYPES).join(', ')}`);
    }
    const nodeId = id || `${type}_${++this._counter}`;
    if (this.nodes[nodeId]) throw new GraphError(`Node id '${nodeId}' already exists`);
    this._validateInputs(type, inputs);
    this.nodes[nodeId] = { id: nodeId, type, name: name || nodeId, params, inputs };
    // First node in an empty document automatically becomes the output.
    if (this.output === null && Object.keys(this.nodes).length === 1) this.output = nodeId;
    this._touch();
    return this.nodes[nodeId];
  }

  updateNode(id, { name, params, inputs }) {
    const node = this.nodes[id];
    if (!node) throw new GraphError(`Node '${id}' does not exist`);
    if (inputs !== undefined) {
      this._validateInputs(node.type, inputs, id);
      node.inputs = { ...node.inputs, ...inputs };
    }
    if (params !== undefined) node.params = { ...node.params, ...params };
    if (name !== undefined) node.name = name;
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
    delete this.nodes[id];
    if (this.output === id) this.output = null;
    this._touch();
  }

  setOutput(id) {
    if (id !== null && !this.nodes[id]) throw new GraphError(`Node '${id}' does not exist`);
    this.output = id;
    this._touch();
  }

  clear() {
    this.nodes = {};
    this.output = null;
    this._counter = 0;
    this._touch();
  }
}
