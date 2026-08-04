/**
 * The API a cell program sees.
 *
 * This is the whole vocabulary of v2. Where v1 had `NODE_TYPES` — a closed list
 * of blocks, where "no brep_loft entry" meant "loft is not expressible" — a cell
 * writes JavaScript against these objects, so composition, control flow, and
 * arithmetic come free and only the *primitives* are curated. Adding an
 * operation here widens what can be built without touching the document model.
 *
 * Everything handed across is frozen. Cell programs share the underlying
 * modules, and a program that could add a property to `brep` would be leaving it
 * there for every later cell in the document.
 */

import * as ops from './ops.js';
import { q as queryRoot, topology, Query } from './query.js';
import { GraphError } from './errors.js';

/** The `brep` namespace: primitives, booleans, modifiers, measures. */
const brep = Object.freeze({
  box: ops.box,
  cylinder: ops.cylinder,
  sphere: ops.sphere,
  union: ops.union,
  subtract: ops.subtract,
  intersect: ops.intersect,
  fillet: ops.fillet,
  chamfer: ops.chamfer,
  shell: ops.shell,
  translate: ops.translate,
  rotate: ops.rotate,
  scale: ops.scale,
  mirror: ops.mirror,
  volume: ops.volume,
  area: ops.area,
  bbox: ops.bbox,
});

/** The `q` namespace: face and edge queries. */
const q = Object.freeze({
  faces: (shape) => queryRoot.faces(shape),
  edges: (shape) => queryRoot.edges(shape),
});

/**
 * Assertions available to a program directly, so a cell can state its own
 * intent — "this must stay one solid", "this must be under 40cc" — without
 * waiting for the assertion-cell phase.
 */
const assert = Object.freeze({
  ok(condition, message) {
    if (!condition) throw new GraphError(message || 'Assertion failed');
  },
  volumeUnder(shape, limit) {
    const v = ops.volume(shape);
    if (!(v < limit)) throw new GraphError(`Volume ${v.toFixed(2)} is not under ${limit}`);
    return v;
  },
  volumeOver(shape, limit) {
    const v = ops.volume(shape);
    if (!(v > limit)) throw new GraphError(`Volume ${v.toFixed(2)} is not over ${limit}`);
    return v;
  },
  fitsIn(shape, [x, y, z]) {
    const { size } = ops.bbox(shape);
    const over = size.map((s, i) => s - [x, y, z][i]).findIndex((d) => d > 1e-9);
    if (over >= 0) {
      throw new GraphError(
        `Bounding box ${size.map((s) => s.toFixed(2)).join(' × ')} exceeds ${[x, y, z].join(' × ')} on ${'XYZ'[over]}`
      );
    }
    return size;
  },
});

/**
 * Build the argument object for one cell's program.
 *
 * `input` is the running current solid — the thing natural language keeps
 * pointing at ("subtract that from the body"). `inputs` is the same results
 * keyed by cell id, for the cases where the flow branches and a prompt has to
 * name what it means.
 */
export function cellApi({ params = {}, input = null, inputs = {}, selections = {} }) {
  return Object.freeze({
    p: Object.freeze({ ...params }),
    brep,
    q,
    assert,
    topology,
    input,
    inputs: Object.freeze({ ...inputs }),
    sel: selectionQueries(selections, input),
  });
}

/**
 * Turn the cell's resolved picks into ordinary queries.
 *
 * A pick becomes `sel.lip` — a Query like any other, so it goes straight into
 * brep.fillet(...) and re-resolves against the shape being modified exactly the
 * way a written query does. That is the whole reason picks are stored as a kind
 * plus an anchor rather than as an index: "that edge" and "the vertical edges"
 * end up as the same kind of thing, and both survive a parameter change.
 *
 * Selections resolve against the cell's `input`. A pick is made by clicking the
 * geometry the cell is about to modify, so there is nothing else it could mean.
 */
function selectionQueries(selections, input) {
  const out = {};
  for (const [name, spec] of Object.entries(selections || {})) {
    if (!spec?.anchor) continue; // unresolved; evaluation refuses before we get here
    const root = spec.type === 'face' ? q.faces(input) : q.edges(input);
    out[name] = root.ofKind(spec.anchor.kind).nearestTo(spec.anchor);
  }
  return Object.freeze(out);
}

/**
 * Check what a cell program returned.
 *
 * A program that forgets to return leaves the previous cell's solid as the
 * document's current geometry, which reads as "my edit did nothing" — far more
 * confusing than an error naming the cell.
 */
export function checkCellResult(value, id) {
  if (value == null) {
    throw new GraphError(`Cell '${id}' returned nothing — a cell program must return a shape`);
  }
  if (value instanceof Query) {
    throw new GraphError(
      `Cell '${id}' returned a query, not a shape. Pass it to an operation such as brep.fillet(...).`
    );
  }
  if (typeof value.clone !== 'function') {
    throw new GraphError(`Cell '${id}' returned a ${typeof value}, not a shape`);
  }
  return value;
}

export { brep, q, assert };
