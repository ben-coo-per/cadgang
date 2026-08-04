/**
 * cadgang topological queries — naming faces and edges by what they ARE.
 *
 * A prompt-authored model is written by something that cannot see the geometry.
 * It can never say "edge 7" — and it should not, because an index breaks the
 * moment a parameter changes and OCCT renumbers the topology. So every
 * reference to a face or an edge is a QUERY: a chain of predicates over
 * intrinsic properties. "The linear edges running along Z" still selects the
 * same four edges after the box grows from 60mm to 80mm; `edges[3]` does not.
 *
 * A Query is a description, not a result. It captures the shape it was built
 * from and re-resolves on demand, so an operation can resolve it against the
 * exact shape instance it is about to consume rather than against a stale copy.
 *
 * The descriptor objects `.where()` receives are byte-for-byte the ones
 * `topology()` reports over MCP. That is deliberate: whatever the model reads
 * when it inspects a shape is exactly what its predicates will be handed, so a
 * query can be written against observed values without a translation step.
 *
 * Lifetime: enumerating `shape.faces` mints OCCT heap objects. Everything this
 * module allocates is registered with the active brep scope (see
 * beginBrepScope in brep.js), so a compile pass frees them in one go.
 */

import { GraphError } from './errors.js';
import { brepKernel, trackBrepShape } from './brep.js';

const RAD = Math.PI / 180;
const AXIS = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

// Tolerances. Angles are generous (1°) because OCCT surface normals on a
// filleted or booleaned face carry accumulated error; measures are relative
// because a 0.01mm slop means something different on a 2mm hole and a 200mm
// plate.
const ANGLE_TOL_DEG = 1;
const MEASURE_REL_TOL = 1e-3;
const POSITION_TOL = 1e-6;

// --------------------------------------------------------------- vector maths

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => Math.hypot(a[0], a[1], a[2]);

function unit(a) {
  const n = norm(a);
  if (n < 1e-12) return null;
  return [a[0] / n, a[1] / n, a[2] / n];
}

/**
 * Accept 'z', '+z', '-z', or a raw vector. The sign matters for faces (a top
 * face and a bottom face have opposite normals and are not interchangeable) and
 * does not for edges (an edge "along Z" has no preferred end), so the parsed
 * result reports whether a sign was actually written.
 */
export function parseDirection(d) {
  if (Array.isArray(d)) {
    const v = unit(d);
    if (!v) throw new GraphError(`Direction ${JSON.stringify(d)} has zero length`);
    return { vec: v, signed: true };
  }
  const m = /^([+-]?)([xyz])$/.exec(String(d).trim().toLowerCase());
  if (!m) {
    throw new GraphError(
      `Unknown direction '${d}'. Use 'x'/'y'/'z', '+z'/'-z', or a vector like [0,0,1]`
    );
  }
  const axis = AXIS[m[2]];
  return {
    vec: m[1] === '-' ? axis.map((c) => -c) : axis,
    signed: m[1] !== '',
  };
}

/** Read a replicad Vector into a plain tuple and free it. */
function readVector(v) {
  const out = [v.x, v.y, v.z];
  v.delete?.();
  return out;
}

function readBBox(shape) {
  const box = shape.boundingBox;
  const [min, max] = box.bounds;
  box.delete?.();
  return {
    min: [min[0], min[1], min[2]],
    max: [max[0], max[1], max[2]],
    center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
  };
}

/** Round for display and hashing — 1e-4 mm is far below anything we can hold. */
const r4 = (n) => Math.round(n * 1e4) / 1e4;
const r4v = (v) => v.map(r4);

// ------------------------------------------------------------- describing

/**
 * A stable-ish content hash for one entity.
 *
 * This is NOT the reference mechanism — queries are. It is the *anchor* used to
 * detect drift: when a stored user pick re-resolves, comparing anchors tells us
 * whether we found the same entity or something that merely also satisfies the
 * query. A changed anchor means "ask the human again", never "silently operate
 * on this instead".
 */
function anchorOf(kind, measure, center, extra) {
  const parts = [kind, r4(measure), ...r4v(center), ...(extra ? r4v(extra) : [])];
  let h = 2166136261;
  const s = parts.join('|');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/** Describe one edge. `i` is the enumeration index — valid only for this
 *  resolution pass and never persisted. */
export function describeEdge(edge, i) {
  const kind = edge.geomType;
  const length = edge.length;
  const bbox = readBBox(edge);
  const start = readVector(edge.startPoint);
  const end = readVector(edge.endPoint);
  const closed = edge.isClosed;
  // A line's tangent is constant, so tangentAt(0) is the direction. A circle's
  // is not, and reporting one would invite a meaningless `.along()` match.
  const direction = kind === 'LINE' ? unit(readVector(edge.tangentAt(0))) : null;
  // Full circles are the overwhelmingly common curved edge (holes, fillet
  // seams) and their radius is the thing anyone wants to filter on.
  const radius = kind === 'CIRCLE' && closed ? length / (2 * Math.PI) : null;

  return {
    i,
    type: 'edge',
    kind,
    length: r4(length),
    center: r4v(bbox.center),
    start: r4v(start),
    end: r4v(end),
    direction: direction ? r4v(direction) : null,
    radius: radius === null ? null : r4(radius),
    closed,
    bbox: { min: r4v(bbox.min), max: r4v(bbox.max) },
    anchor: anchorOf(kind, length, bbox.center, direction),
  };
}

/** Describe one face. */
export function describeFace(face, i) {
  const rc = brepKernel();
  const kind = face.geomType;
  const area = rc.measureArea(face);
  const bbox = readBBox(face);
  const center = readVector(face.center);
  // normalAt() with no argument samples at the face centre. For a plane that is
  // the normal; for a cylinder it is one sample of many, so it is reported but
  // `.facing()` only trusts it on planar faces.
  let normal = null;
  try {
    normal = unit(readVector(face.normalAt()));
  } catch {
    // Degenerate or seam faces can refuse a normal; absence is a valid answer.
  }
  // Cylindrical faces are how holes and bosses present themselves, so their
  // radius has to be filterable. Derive it from the face's own extent rather
  // than reaching into the OCCT adaptor.
  let radius = null;
  if (kind === 'CYLINDRE') {
    const span = [0, 1, 2].map((k) => bbox.max[k] - bbox.min[k]);
    // The two largest extents of a cylinder's bbox span its diameter.
    const sorted = [...span].sort((a, b) => b - a);
    radius = sorted[1] / 2;
  } else if (kind === 'SPHERE') {
    radius = Math.max(...[0, 1, 2].map((k) => bbox.max[k] - bbox.min[k])) / 2;
  }

  return {
    i,
    type: 'face',
    kind,
    area: r4(area),
    center: r4v(center),
    normal: normal ? r4v(normal) : null,
    radius: radius === null ? null : r4(radius),
    bbox: { min: r4v(bbox.min), max: r4v(bbox.max) },
    anchor: anchorOf(kind, area, center, normal),
  };
}

// --------------------------------------------------------------- enumeration

/**
 * Enumerate every face or edge of a shape with its descriptor.
 *
 * The live OCCT wrappers come back alongside the plain descriptors because an
 * operation needs the wrappers and the model needs the descriptors. Both are
 * registered with the active brep scope.
 */
export function enumerate(shape, type) {
  if (type !== 'face' && type !== 'edge') {
    throw new GraphError(`Cannot enumerate '${type}' — expected 'face' or 'edge'`);
  }
  const elements = type === 'face' ? shape.faces : shape.edges;
  const describe = type === 'face' ? describeFace : describeEdge;
  return elements.map((element, i) => {
    trackBrepShape(element);
    return { element, d: describe(element, i) };
  });
}

/**
 * The full topology of a shape, as plain JSON.
 *
 * This is what replaces vision. A model that cannot look at the part calls
 * this, reads the actual faces and edges with their kinds, sizes, and
 * positions, writes a query against what it sees, and checks the count before
 * committing to an operation.
 */
export function topology(shape) {
  const faces = enumerate(shape, 'face').map((e) => e.d);
  const edges = enumerate(shape, 'edge').map((e) => e.d);
  const bbox = readBBox(shape);
  return {
    bbox: { min: r4v(bbox.min), max: r4v(bbox.max) },
    counts: { faces: faces.length, edges: edges.length },
    faces,
    edges,
  };
}

// -------------------------------------------------------------------- Query

/** Compare two measures with a relative tolerance, floored for small values. */
function measureMatches(actual, want, tol) {
  const t = tol ?? Math.max(Math.abs(want) * MEASURE_REL_TOL, 1e-4);
  return Math.abs(actual - want) <= t;
}

const FACE_KINDS = {
  planar: 'PLANE',
  cylindrical: 'CYLINDRE',
  conical: 'CONE',
  spherical: 'SPHERE',
  toroidal: 'TORUS',
};

const EDGE_KINDS = { linear: 'LINE', circular: 'CIRCLE', elliptical: 'ELLIPSE' };

/**
 * A chain of steps over a list of entities.
 *
 * Steps run in the order they were written, and a step is either a filter
 * (drops entities) or a reducer (`atExtreme`, which keeps only the entities at
 * one end of an axis). Keeping them in one ordered list is what makes
 * `.planar().atExtreme('+z')` mean "the topmost planar face" and
 * `.atExtreme('+z').planar()` mean "the topmost face, if it happens to be
 * planar" — both readable, neither surprising.
 */
export class Query {
  constructor(shape, type, steps = []) {
    this.shape = shape;
    this.type = type;
    this.steps = steps;
  }

  _add(step) {
    return new Query(this.shape, this.type, [...this.steps, step]);
  }

  /** Filter on the descriptor directly. The escape hatch for anything the
   *  named filters below do not cover. */
  where(fn) {
    if (typeof fn !== 'function') throw new GraphError('where() needs a function');
    return this._add({ kind: 'filter', label: 'where(…)', fn: (e) => Boolean(fn(e.d)) });
  }

  /** Match one or more OCCT surface/curve kinds ('PLANE', 'LINE', 'CIRCLE'…). */
  ofKind(...kinds) {
    const want = new Set(kinds.map((k) => String(k).toUpperCase()));
    return this._add({
      kind: 'filter',
      label: `ofKind(${[...want].join(', ')})`,
      fn: (e) => want.has(e.d.kind),
    });
  }

  planar() { return this._kindShorthand('planar', FACE_KINDS, 'face'); }
  cylindrical() { return this._kindShorthand('cylindrical', FACE_KINDS, 'face'); }
  conical() { return this._kindShorthand('conical', FACE_KINDS, 'face'); }
  spherical() { return this._kindShorthand('spherical', FACE_KINDS, 'face'); }
  toroidal() { return this._kindShorthand('toroidal', FACE_KINDS, 'face'); }
  linear() { return this._kindShorthand('linear', EDGE_KINDS, 'edge'); }
  circular() { return this._kindShorthand('circular', EDGE_KINDS, 'edge'); }
  elliptical() { return this._kindShorthand('elliptical', EDGE_KINDS, 'edge'); }

  _kindShorthand(name, table, forType) {
    if (this.type !== forType) {
      throw new GraphError(`.${name}() applies to ${forType}s, but this query selects ${this.type}s`);
    }
    return this.ofKind(table[name]);
  }

  /**
   * Edges whose direction is parallel to `dir`. Sign-insensitive unless the
   * direction was written with one: an edge running along Z is the same edge
   * whichever end you start from.
   */
  along(dir, toleranceDeg = ANGLE_TOL_DEG) {
    const { vec, signed } = parseDirection(dir);
    const cos = Math.cos(toleranceDeg * RAD);
    return this._add({
      kind: 'filter',
      label: `along(${JSON.stringify(dir)})`,
      fn: (e) => {
        if (!e.d.direction) return false;
        const d = dot(e.d.direction, vec);
        return signed ? d >= cos : Math.abs(d) >= cos;
      },
    });
  }

  /**
   * Faces whose normal points along `dir`. Unlike `.along()` this defaults to
   * caring about sign — `.facing('+z')` is the top of a box, `.facing('-z')`
   * the bottom, and conflating them would be a bug in every shell operation.
   * A bare axis ('z') matches both.
   */
  facing(dir, toleranceDeg = ANGLE_TOL_DEG) {
    const { vec, signed } = parseDirection(dir);
    const cos = Math.cos(toleranceDeg * RAD);
    return this._add({
      kind: 'filter',
      label: `facing(${JSON.stringify(dir)})`,
      fn: (e) => {
        if (!e.d.normal) return false;
        const d = dot(e.d.normal, vec);
        return signed ? d >= cos : Math.abs(d) >= cos;
      },
    });
  }

  ofLength(value, tolerance) {
    return this._measure('length', 'ofLength', value, tolerance);
  }

  ofArea(value, tolerance) {
    return this._measure('area', 'ofArea', value, tolerance);
  }

  ofRadius(value, tolerance) {
    return this._measure('radius', 'ofRadius', value, tolerance);
  }

  ofDiameter(value, tolerance) {
    return this._measure('radius', 'ofDiameter', value / 2, tolerance ? tolerance / 2 : undefined);
  }

  _measure(field, label, value, tolerance) {
    if (!Number.isFinite(value)) throw new GraphError(`.${label}() needs a finite number`);
    return this._add({
      kind: 'filter',
      label: `${label}(${value})`,
      fn: (e) => e.d[field] != null && measureMatches(e.d[field], value, tolerance),
    });
  }

  /** Compare the entity's primary measure (length for edges, area for faces). */
  largerThan(value) { return this._compare(value, 1); }
  smallerThan(value) { return this._compare(value, -1); }

  _compare(value, sign) {
    const field = this.type === 'edge' ? 'length' : 'area';
    const label = sign > 0 ? 'largerThan' : 'smallerThan';
    return this._add({
      kind: 'filter',
      label: `${label}(${value})`,
      fn: (e) => (sign > 0 ? e.d[field] > value : e.d[field] < value),
    });
  }

  /** Entities whose centre lies within `distance` of a point. */
  near(point, distance) {
    if (!Array.isArray(point) || point.length !== 3) {
      throw new GraphError('.near() needs a [x, y, z] point');
    }
    return this._add({
      kind: 'filter',
      label: `near(${JSON.stringify(point)}, ${distance})`,
      fn: (e) => {
        const c = e.d.center;
        return Math.hypot(c[0] - point[0], c[1] - point[1], c[2] - point[2]) <= distance;
      },
    });
  }

  /** Entities entirely inside an axis-aligned box. */
  inBox(min, max) {
    return this._add({
      kind: 'filter',
      label: `inBox(${JSON.stringify(min)}, ${JSON.stringify(max)})`,
      fn: (e) => [0, 1, 2].every(
        (k) => e.d.bbox.min[k] >= min[k] - POSITION_TOL && e.d.bbox.max[k] <= max[k] + POSITION_TOL
      ),
    });
  }

  /**
   * Keep only the entities furthest along a direction — "the top face", "the
   * innermost hole". Everything within `tolerance` of the extreme is kept, so
   * the four coplanar top faces of a shelled box all survive rather than one
   * winning by floating-point noise.
   */
  atExtreme(dir, tolerance = 1e-3) {
    const { vec } = parseDirection(dir);
    return this._add({
      kind: 'reduce',
      label: `atExtreme(${JSON.stringify(dir)})`,
      fn: (list) => {
        if (!list.length) return list;
        const score = (e) => dot(e.d.center, vec);
        const best = Math.max(...list.map(score));
        return list.filter((e) => score(e) >= best - tolerance);
      },
    });
  }

  /** Drop everything a sub-query would have matched. */
  exclude(build) {
    const sub = build(new Query(this.shape, this.type, []));
    return this._add({
      kind: 'reduce',
      label: `exclude(${sub._chainLabel()})`,
      fn: (list) => {
        const dropped = new Set(sub._run(list).map((e) => e.d.i));
        return list.filter((e) => !dropped.has(e.d.i));
      },
    });
  }

  /** Union of several sub-queries — "the vertical edges OR the top rim". */
  either(...builds) {
    const subs = builds.map((b) => b(new Query(this.shape, this.type, [])));
    return this._add({
      kind: 'reduce',
      label: `either(${subs.map((s) => s._chainLabel()).join(' | ')})`,
      fn: (list) => {
        const keep = new Set();
        for (const sub of subs) for (const e of sub._run(list)) keep.add(e.d.i);
        return list.filter((e) => keep.has(e.d.i));
      },
    });
  }

  // ------------------------------------------------------------- resolution

  _chainLabel() {
    return this.steps.map((s) => s.label).join('.') || '(all)';
  }

  /** Human- and model-readable description of the chain itself. */
  get expression() {
    return `${this.type}s.${this._chainLabel()}`;
  }

  _run(list) {
    let out = list;
    for (const step of this.steps) {
      out = step.kind === 'filter' ? out.filter(step.fn) : step.fn(out);
    }
    return out;
  }

  /**
   * Resolve against a specific shape instance.
   *
   * Operations call this with the working copy they are about to consume, so
   * the OCCT sub-shapes handed to a fillet belong to the shape being filleted.
   */
  resolveOn(shape) {
    return this._run(enumerate(shape, this.type));
  }

  _resolve() {
    if (!this.shape) throw new GraphError('Query has no shape to resolve against');
    return this.resolveOn(this.shape);
  }

  /** The matching descriptors. */
  all() {
    return this._resolve().map((e) => e.d);
  }

  count() {
    return this._resolve().length;
  }

  /** The single match, or an error naming what was found instead. */
  one() {
    const found = this.all();
    if (found.length !== 1) {
      throw new GraphError(
        `${this.expression} matched ${found.length} ${this.type}s, expected exactly 1${summarize(found)}`
      );
    }
    return found[0];
  }

  /**
   * Assert the match count and carry on.
   *
   * This is the safety valve that makes generated geometry code trustworthy:
   * the intent "fillet the four vertical edges" is written down as a number, so
   * a query that quietly starts matching twelve edges after a parameter change
   * fails the cell instead of producing a differently-shaped part.
   */
  expect(n) {
    const found = this.all();
    if (found.length !== n) {
      throw new GraphError(
        `${this.expression} matched ${found.length} ${this.type}s, expected ${n}${summarize(found)}`
      );
    }
    return this;
  }

  /** What this query selects right now, for logging and MCP replies. */
  explain() {
    const found = this.all();
    return { expression: this.expression, count: found.length, matches: found };
  }
}

/** Compact "what did I actually find" tail for error messages. */
function summarize(found) {
  if (!found.length) return '';
  const shown = found.slice(0, 6).map((d) => {
    const measure = d.type === 'edge' ? `len ${d.length}` : `area ${d.area}`;
    return `${d.kind} (${measure}) at [${d.center.join(', ')}]`;
  });
  const tail = found.length > shown.length ? `, …${found.length - shown.length} more` : '';
  return `. Found: ${shown.join('; ')}${tail}`;
}

/** Entry point handed to cell programs as `q`. */
export const q = {
  faces: (shape) => new Query(shape, 'face'),
  edges: (shape) => new Query(shape, 'edge'),
};

/**
 * Resolve a query (or a plain list of already-resolved entries) to the live
 * OCCT elements of `shape`, for handing to a replicad finder.
 */
export function elementsFor(query, shape) {
  if (!(query instanceof Query)) {
    throw new GraphError('Expected a query built with q.faces(...) or q.edges(...)');
  }
  return query.resolveOn(shape).map((e) => e.element);
}
