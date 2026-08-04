/**
 * Query-driven B-rep operations — the `brep` half of the cell API.
 *
 * These are the operations a cell program calls. They differ from the ones in
 * brep.js in exactly one way, and it is the whole point of v2: where the old
 * block-graph fillet took a direction keyword ('x' | 'y' | 'z' | 'all'), these
 * take a Query. That turns "fillet the vertical edges" from a fixed enum into
 * an expression the model can compose — and, because a query re-resolves
 * against the shape it is about to modify, into one that survives a parameter
 * change.
 *
 * Every operation resolves its query against its OWN working copy of the
 * shape, never against the caller's. OCCT sub-shape identity is per-shape, so
 * resolving anywhere else would hand a fillet builder edges belonging to a
 * different solid and it would silently select nothing.
 */

import { GraphError } from './errors.js';
import {
  borrowBrepShape as borrow,
  brepAttempt as attempt,
  trackBrepShape as track,
  brepKernel as kernelOf,
  requireSolid,
} from './brep.js';
import { Query } from './query.js';

/**
 * Turn a query into a replicad finder bound to `shape`.
 *
 * Refusing an empty match is deliberate. OCCT is perfectly happy to fillet zero
 * edges and hand back the original solid, which looks like success and ships a
 * part with no fillets on it. A query that matches nothing is a broken
 * reference, and it should read as one.
 */
function finderFor(query, shape, opName) {
  if (!(query instanceof Query)) {
    throw new GraphError(
      `${opName} needs a query — for example q.edges(shape).linear().along('z')`
    );
  }
  const matched = query.resolveOn(shape);
  if (!matched.length) {
    throw new GraphError(
      `${opName}: ${query.expression} matched no ${query.type}s on this shape. ` +
      'Inspect the shape\'s topology and loosen the query.'
    );
  }
  const elements = matched.map((e) => e.element);
  return { finder: (f) => f.inList(elements), count: elements.length };
}

// ------------------------------------------------------------------ primitives

/** Box centred in X/Y, sitting on z = 0. `center: 'xyz'` centres it fully. */
export function box(sx, sy, sz, { center = 'xy' } = {}) {
  return attempt('box', () => {
    const rc = kernelOf();
    let s = track(rc.makeBaseBox(sx, sy, sz));
    if (String(center).includes('z')) s = track(s.translateZ(-sz / 2));
    if (!String(center).includes('x')) s = track(s.translateX(sx / 2));
    if (!String(center).includes('y')) s = track(s.translateY(sy / 2));
    return s;
  });
}

export function cylinder(radius, height, { center = '' } = {}) {
  return attempt('cylinder', () => {
    const rc = kernelOf();
    let s = track(rc.makeCylinder(radius, height));
    if (String(center).includes('z')) s = track(s.translateZ(-height / 2));
    return s;
  });
}

export function sphere(radius) {
  return attempt('sphere', () => track(kernelOf().makeSphere(radius)));
}

// ------------------------------------------------------------------ booleans

const BOOLEAN_METHOD = { union: 'fuse', subtract: 'cut', intersect: 'intersect' };

function boolean(op, base, tools) {
  const method = BOOLEAN_METHOD[op];
  const list = (Array.isArray(tools) ? tools : [tools]).filter(Boolean);
  if (!list.length) throw new GraphError(`${op}() needs at least one shape to combine`);
  return attempt(op, () => {
    let acc = borrow(base, 'base');
    for (const tool of list) acc = track(acc[method](borrow(tool, 'tool')));
    return acc;
  });
}

export const union = (base, ...tools) => boolean('union', base, tools.flat());
export const subtract = (base, ...tools) => boolean('subtract', base, tools.flat());
export const intersect = (base, ...tools) => boolean('intersect', base, tools.flat());

// ---------------------------------------------------------------- modifiers

/**
 * Roll a ball of `radius` along every edge the query selects.
 *
 * `radius` may be a number or a function of the edge descriptor, so a variable
 * fillet ("bigger on the long edges") is one expression rather than four
 * separate operations.
 */
export function fillet(shape, query, radius) {
  if (typeof radius === 'number' && radius <= 0) {
    throw new GraphError('Fillet radius must be greater than zero');
  }
  return attempt('fillet', () => {
    const s = borrow(shape, 'shape');
    const { finder } = finderFor(query, s, 'fillet');
    return track(s.fillet(radius, finder));
  });
}

export function chamfer(shape, query, distance) {
  if (typeof distance === 'number' && distance <= 0) {
    throw new GraphError('Chamfer distance must be greater than zero');
  }
  return attempt('chamfer', () => {
    const s = borrow(shape, 'shape');
    const { finder } = finderFor(query, s, 'chamfer');
    return track(s.chamfer(distance, finder));
  });
}

/**
 * Hollow the solid to a wall of `thickness`, removing the faces the query
 * selects. A null query shells it closed (a sealed void).
 */
export function shell(shape, query, thickness) {
  if (!thickness) throw new GraphError('Shell thickness cannot be zero');
  return attempt('shell', () => {
    const s = borrow(shape, 'shape');
    if (query == null) return track(s.shell(thickness));
    const { finder } = finderFor(query, s, 'shell');
    return track(s.shell(thickness, finder));
  });
}

export function translate(shape, [x, y, z]) {
  return attempt('translate', () => track(borrow(shape, 'shape').translate(x, y, z)));
}

export function rotate(shape, angle, axis = [0, 0, 1], origin = [0, 0, 0]) {
  return attempt('rotate', () => track(borrow(shape, 'shape').rotate(angle, origin, axis)));
}

export function scale(shape, factor, origin = [0, 0, 0]) {
  if (factor <= 0) throw new GraphError('Scale must be greater than zero');
  return attempt('scale', () => track(borrow(shape, 'shape').scale(factor, origin)));
}

export function mirror(shape, plane = 'XY', origin = [0, 0, 0]) {
  return attempt('mirror', () => track(borrow(shape, 'shape').mirror(plane, origin)));
}

// ----------------------------------------------------------------- measures

export function volume(shape) {
  return attempt('volume', () => kernelOf().measureVolume(requireSolid(shape, 'shape')));
}

export function area(shape) {
  return attempt('area', () => kernelOf().measureArea(requireSolid(shape, 'shape')));
}

export function bbox(shape) {
  return attempt('bbox', () => {
    const b = requireSolid(shape, 'shape').boundingBox;
    const [min, max] = b.bounds;
    b.delete?.();
    return { min: [...min], max: [...max], size: [0, 1, 2].map((k) => max[k] - min[k]) };
  });
}
