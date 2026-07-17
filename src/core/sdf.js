/**
 * cadgang implicit geometry kernel.
 *
 * A model is a graph of nodes (blocks). Each node has a type, params, and
 * named inputs referencing other nodes. Types are either primitives (emit a
 * signed-distance function directly) or operations (combine child SDFs).
 *
 * compileNode() turns a node graph into a plain JS closure d(x,y,z) -> number
 * (negative inside, positive outside), which everything else (meshing,
 * raymarching, evaluation) consumes.
 */

const TAU = Math.PI * 2;

// ---------------------------------------------------------------- helpers

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

function smin(a, b, k) {
  // polynomial smooth min (quadratic), k >= 0
  if (k <= 0) return Math.min(a, b);
  const h = clamp(0.5 + (0.5 * (b - a)) / k, 0, 1);
  return b * (1 - h) + a * h - k * h * (1 - h);
}
const smax = (a, b, k) => -smin(-a, -b, k);

function unionBox(boxes) {
  const real = boxes.filter(Boolean);
  if (real.length !== boxes.length || real.length === 0) return null; // any infinite -> infinite
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const b of real) {
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i], b.min[i]);
      max[i] = Math.max(max[i], b.max[i]);
    }
  }
  return { min, max };
}

function intersectBox(boxes) {
  const real = boxes.filter(Boolean);
  if (real.length === 0) return null;
  const min = [-Infinity, -Infinity, -Infinity];
  const max = [Infinity, Infinity, Infinity];
  for (const b of real) {
    for (let i = 0; i < 3; i++) {
      min[i] = Math.max(min[i], b.min[i]);
      max[i] = Math.min(max[i], b.max[i]);
    }
  }
  for (let i = 0; i < 3; i++) if (min[i] > max[i]) return { min: [0, 0, 0], max: [0, 0, 0] };
  if (min.some((v) => !isFinite(v)) || max.some((v) => !isFinite(v))) return null;
  return { min, max };
}

function expandBox(box, amount) {
  if (!box) return null;
  return {
    min: box.min.map((v) => v - amount),
    max: box.max.map((v) => v + amount),
  };
}

// Euler XYZ (degrees) -> 3x3 rotation matrix (row-major)
function rotationMatrix([rx, ry, rz]) {
  const d = Math.PI / 180;
  const [cx, sx] = [Math.cos(rx * d), Math.sin(rx * d)];
  const [cy, sy] = [Math.cos(ry * d), Math.sin(ry * d)];
  const [cz, sz] = [Math.cos(rz * d), Math.sin(rz * d)];
  // R = Rz * Ry * Rx
  return [
    cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx,
    sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx,
    -sy, cy * sx, cy * cx,
  ];
}

// ---------------------------------------------------------------- registry

/**
 * Each type:
 *   params:  { name: {type:'number'|'vec3', default, min?, max?, description} }
 *   inputs:  { name: {many?:true, optional?:true, description} }
 *   compile: (p, kids) => (x,y,z)=>d      kids mirrors `inputs` (fn or [fn])
 *   bbox:    (p, kidBoxes) => {min,max}|null   null = unbounded
 */
export const NODE_TYPES = {
  // ------------------------------------------------------------ primitives
  sphere: {
    category: 'primitive',
    description: 'Solid sphere centered at origin.',
    params: { radius: { type: 'number', default: 10, min: 0, description: 'Sphere radius (mm)' } },
    inputs: {},
    compile: (p) => {
      const r = p.radius;
      return (x, y, z) => Math.sqrt(x * x + y * y + z * z) - r;
    },
    bbox: (p) => ({ min: [-p.radius, -p.radius, -p.radius], max: [p.radius, p.radius, p.radius] }),
  },

  box: {
    category: 'primitive',
    description: 'Axis-aligned solid box centered at origin, optional corner rounding.',
    params: {
      size: { type: 'vec3', default: [20, 20, 20], description: 'Full extents X/Y/Z (mm)' },
      round: { type: 'number', default: 0, min: 0, description: 'Corner rounding radius (mm)' },
    },
    inputs: {},
    compile: (p) => {
      const hx = p.size[0] / 2 - p.round, hy = p.size[1] / 2 - p.round, hz = p.size[2] / 2 - p.round;
      const r = p.round;
      return (x, y, z) => {
        const qx = Math.abs(x) - hx, qy = Math.abs(y) - hy, qz = Math.abs(z) - hz;
        const ox = Math.max(qx, 0), oy = Math.max(qy, 0), oz = Math.max(qz, 0);
        return Math.sqrt(ox * ox + oy * oy + oz * oz) + Math.min(Math.max(qx, qy, qz), 0) - r;
      };
    },
    bbox: (p) => ({
      min: [-p.size[0] / 2, -p.size[1] / 2, -p.size[2] / 2],
      max: [p.size[0] / 2, p.size[1] / 2, p.size[2] / 2],
    }),
  },

  cylinder: {
    category: 'primitive',
    description: 'Solid cylinder along the Z axis, centered at origin.',
    params: {
      radius: { type: 'number', default: 8, min: 0, description: 'Cylinder radius (mm)' },
      height: { type: 'number', default: 20, min: 0, description: 'Full height along Z (mm)' },
    },
    inputs: {},
    compile: (p) => {
      const r = p.radius, h = p.height / 2;
      return (x, y, z) => {
        const dr = Math.sqrt(x * x + y * y) - r;
        const dz = Math.abs(z) - h;
        const ox = Math.max(dr, 0), oz = Math.max(dz, 0);
        return Math.min(Math.max(dr, dz), 0) + Math.sqrt(ox * ox + oz * oz);
      };
    },
    bbox: (p) => ({
      min: [-p.radius, -p.radius, -p.height / 2],
      max: [p.radius, p.radius, p.height / 2],
    }),
  },

  torus: {
    category: 'primitive',
    description: 'Solid torus in the XY plane, centered at origin.',
    params: {
      major: { type: 'number', default: 12, min: 0, description: 'Ring radius (mm)' },
      minor: { type: 'number', default: 4, min: 0, description: 'Tube radius (mm)' },
    },
    inputs: {},
    compile: (p) => {
      const R = p.major, r = p.minor;
      return (x, y, z) => {
        const q = Math.sqrt(x * x + y * y) - R;
        return Math.sqrt(q * q + z * z) - r;
      };
    },
    bbox: (p) => {
      const e = p.major + p.minor;
      return { min: [-e, -e, -p.minor], max: [e, e, p.minor] };
    },
  },

  capsule: {
    category: 'primitive',
    description: 'Capsule (line segment swept by a sphere) between two points.',
    params: {
      p1: { type: 'vec3', default: [0, 0, -8], description: 'Segment start (mm)' },
      p2: { type: 'vec3', default: [0, 0, 8], description: 'Segment end (mm)' },
      radius: { type: 'number', default: 5, min: 0, description: 'Capsule radius (mm)' },
    },
    inputs: {},
    compile: (p) => {
      const [ax, ay, az] = p.p1, [bx, by, bz] = p.p2, r = p.radius;
      const bax = bx - ax, bay = by - ay, baz = bz - az;
      const bb = bax * bax + bay * bay + baz * baz || 1;
      return (x, y, z) => {
        const pax = x - ax, pay = y - ay, paz = z - az;
        const h = clamp((pax * bax + pay * bay + paz * baz) / bb, 0, 1);
        const dx = pax - bax * h, dy = pay - bay * h, dz = paz - baz * h;
        return Math.sqrt(dx * dx + dy * dy + dz * dz) - r;
      };
    },
    bbox: (p) => ({
      min: [Math.min(p.p1[0], p.p2[0]) - p.radius, Math.min(p.p1[1], p.p2[1]) - p.radius, Math.min(p.p1[2], p.p2[2]) - p.radius],
      max: [Math.max(p.p1[0], p.p2[0]) + p.radius, Math.max(p.p1[1], p.p2[1]) + p.radius, Math.max(p.p1[2], p.p2[2]) + p.radius],
    }),
  },

  plane: {
    category: 'primitive',
    description: 'Half-space: solid on the side opposite the normal. Unbounded — intersect it with something.',
    params: {
      normal: { type: 'vec3', default: [0, 0, 1], description: 'Plane normal' },
      offset: { type: 'number', default: 0, description: 'Signed distance of plane from origin along normal (mm)' },
    },
    inputs: {},
    compile: (p) => {
      const len = Math.hypot(...p.normal) || 1;
      const [nx, ny, nz] = p.normal.map((v) => v / len);
      const o = p.offset;
      return (x, y, z) => x * nx + y * ny + z * nz - o;
    },
    bbox: () => null,
  },

  gyroid: {
    category: 'primitive',
    description: 'Gyroid TPMS lattice sheet, thickened. Unbounded — intersect with a body to make an infill.',
    params: {
      cell: { type: 'number', default: 10, min: 0.1, description: 'Unit cell size (mm)' },
      thickness: { type: 'number', default: 1.5, min: 0, description: 'Sheet thickness (mm)' },
    },
    inputs: {},
    compile: (p) => {
      const k = TAU / p.cell, t = p.thickness / 2, s = 1 / (k * 1.5); // 1.5 = gradient bound safety
      return (x, y, z) => {
        const f =
          Math.sin(k * x) * Math.cos(k * y) +
          Math.sin(k * y) * Math.cos(k * z) +
          Math.sin(k * z) * Math.cos(k * x);
        return Math.abs(f) * s - t;
      };
    },
    bbox: () => null,
  },

  schwarz_p: {
    category: 'primitive',
    description: 'Schwarz-P TPMS lattice sheet, thickened. Unbounded — intersect with a body to make an infill.',
    params: {
      cell: { type: 'number', default: 10, min: 0.1, description: 'Unit cell size (mm)' },
      thickness: { type: 'number', default: 1.5, min: 0, description: 'Sheet thickness (mm)' },
    },
    inputs: {},
    compile: (p) => {
      const k = TAU / p.cell, t = p.thickness / 2, s = 1 / (k * 1.5);
      return (x, y, z) => {
        const f = Math.cos(k * x) + Math.cos(k * y) + Math.cos(k * z);
        return Math.abs(f) * s - t;
      };
    },
    bbox: () => null,
  },

  // ------------------------------------------------------------ operations
  union: {
    category: 'boolean',
    description: 'Boolean union of any number of shapes.',
    params: {},
    inputs: { shapes: { many: true, description: 'Shapes to merge' } },
    compile: (p, kids) => {
      const fns = kids.shapes;
      if (fns.length === 1) return fns[0];
      return (x, y, z) => {
        let d = Infinity;
        for (const f of fns) { const v = f(x, y, z); if (v < d) d = v; }
        return d;
      };
    },
    bbox: (p, kb) => unionBox(kb.shapes),
  },

  intersect: {
    category: 'boolean',
    description: 'Boolean intersection of any number of shapes. Use to trim unbounded lattices to a body.',
    params: {},
    inputs: { shapes: { many: true, description: 'Shapes to intersect' } },
    compile: (p, kids) => {
      const fns = kids.shapes;
      if (fns.length === 1) return fns[0];
      return (x, y, z) => {
        let d = -Infinity;
        for (const f of fns) { const v = f(x, y, z); if (v > d) d = v; }
        return d;
      };
    },
    bbox: (p, kb) => intersectBox(kb.shapes),
  },

  subtract: {
    category: 'boolean',
    description: 'Boolean subtraction: shape A minus shape B.',
    params: {},
    inputs: { a: { description: 'Base shape' }, b: { description: 'Shape to remove' } },
    compile: (p, kids) => {
      const fa = kids.a, fb = kids.b;
      return (x, y, z) => Math.max(fa(x, y, z), -fb(x, y, z));
    },
    bbox: (p, kb) => kb.a,
  },

  smooth_union: {
    category: 'boolean',
    description: 'Union with a smooth blended fillet between shapes A and B.',
    params: { blend: { type: 'number', default: 2, min: 0, description: 'Blend radius (mm)' } },
    inputs: { a: {}, b: {} },
    compile: (p, kids) => {
      const fa = kids.a, fb = kids.b, k = p.blend;
      return (x, y, z) => smin(fa(x, y, z), fb(x, y, z), k);
    },
    bbox: (p, kb) => expandBox(unionBox([kb.a, kb.b]), p.blend),
  },

  smooth_intersect: {
    category: 'boolean',
    description: 'Intersection with a smooth blend.',
    params: { blend: { type: 'number', default: 2, min: 0, description: 'Blend radius (mm)' } },
    inputs: { a: {}, b: {} },
    compile: (p, kids) => {
      const fa = kids.a, fb = kids.b, k = p.blend;
      return (x, y, z) => smax(fa(x, y, z), fb(x, y, z), k);
    },
    bbox: (p, kb) => intersectBox([kb.a, kb.b]),
  },

  smooth_subtract: {
    category: 'boolean',
    description: 'Subtraction (A minus B) with a smooth blended edge.',
    params: { blend: { type: 'number', default: 2, min: 0, description: 'Blend radius (mm)' } },
    inputs: { a: { description: 'Base shape' }, b: { description: 'Shape to remove' } },
    compile: (p, kids) => {
      const fa = kids.a, fb = kids.b, k = p.blend;
      return (x, y, z) => smax(fa(x, y, z), -fb(x, y, z), k);
    },
    bbox: (p, kb) => kb.a,
  },

  shell: {
    category: 'modify',
    description: 'Hollow a solid into a shell of given wall thickness (walls straddle the original surface).',
    params: { thickness: { type: 'number', default: 2, min: 0, description: 'Wall thickness (mm)' } },
    inputs: { shape: {} },
    compile: (p, kids) => {
      const f = kids.shape, t = p.thickness / 2;
      return (x, y, z) => Math.abs(f(x, y, z)) - t;
    },
    bbox: (p, kb) => expandBox(kb.shape, p.thickness / 2),
  },

  offset: {
    category: 'modify',
    description: 'Offset the surface outward (positive) or inward (negative). Positive also rounds edges.',
    params: { distance: { type: 'number', default: 1, description: 'Offset distance (mm)' } },
    inputs: { shape: {} },
    compile: (p, kids) => {
      const f = kids.shape, d0 = p.distance;
      return (x, y, z) => f(x, y, z) - d0;
    },
    bbox: (p, kb) => expandBox(kb.shape, Math.max(p.distance, 0)),
  },

  transform: {
    category: 'modify',
    description: 'Translate / rotate (Euler XYZ degrees) / uniformly scale a shape.',
    params: {
      translate: { type: 'vec3', default: [0, 0, 0], description: 'Translation (mm)' },
      rotate: { type: 'vec3', default: [0, 0, 0], description: 'Euler rotation X/Y/Z (degrees)' },
      scale: { type: 'number', default: 1, min: 1e-6, description: 'Uniform scale factor' },
    },
    inputs: { shape: {} },
    compile: (p, kids) => {
      const f = kids.shape;
      const [tx, ty, tz] = p.translate;
      const s = p.scale;
      const R = rotationMatrix(p.rotate); // world = R * (s * local) + t  =>  local = R^T * (world - t) / s
      const identity = p.rotate.every((v) => v === 0);
      if (identity && s === 1) return (x, y, z) => f(x - tx, y - ty, z - tz);
      return (x, y, z) => {
        const px = x - tx, py = y - ty, pz = z - tz;
        const lx = (R[0] * px + R[3] * py + R[6] * pz) / s;
        const ly = (R[1] * px + R[4] * py + R[7] * pz) / s;
        const lz = (R[2] * px + R[5] * py + R[8] * pz) / s;
        return f(lx, ly, lz) * s;
      };
    },
    bbox: (p, kb) => {
      const b = kb.shape;
      if (!b) return null;
      const R = rotationMatrix(p.rotate), s = p.scale, t = p.translate;
      const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < 8; i++) {
        const c = [
          (i & 1 ? b.max : b.min)[0] * s,
          (i & 2 ? b.max : b.min)[1] * s,
          (i & 4 ? b.max : b.min)[2] * s,
        ];
        const w = [
          R[0] * c[0] + R[1] * c[1] + R[2] * c[2] + t[0],
          R[3] * c[0] + R[4] * c[1] + R[5] * c[2] + t[1],
          R[6] * c[0] + R[7] * c[1] + R[8] * c[2] + t[2],
        ];
        for (let j = 0; j < 3; j++) {
          min[j] = Math.min(min[j], w[j]);
          max[j] = Math.max(max[j], w[j]);
        }
      }
      return { min, max };
    },
  },
};

// ---------------------------------------------------------------- compile

export class GraphError extends Error {}

function resolveParams(type, params = {}) {
  const spec = NODE_TYPES[type];
  const out = {};
  for (const [name, def] of Object.entries(spec.params)) {
    let v = params[name] ?? def.default;
    if (def.type === 'number') {
      v = Number(v);
      if (!isFinite(v)) throw new GraphError(`Param '${name}' of ${type} must be a finite number`);
      if (def.min !== undefined && v < def.min) v = def.min;
      if (def.max !== undefined && v > def.max) v = def.max;
    } else if (def.type === 'vec3') {
      if (!Array.isArray(v) || v.length !== 3 || v.some((c) => !isFinite(Number(c))))
        throw new GraphError(`Param '${name}' of ${type} must be an array of 3 numbers`);
      v = v.map(Number);
    }
    out[name] = v;
  }
  return out;
}

/**
 * Compile a node (by id) of a document into { fn, bbox }.
 * document: { nodes: { id: {id,type,params,inputs} }, output }
 */
export function compileNode(doc, nodeId) {
  const cache = new Map();
  const visiting = new Set();

  function build(id) {
    if (cache.has(id)) return cache.get(id);
    if (visiting.has(id)) throw new GraphError(`Cycle detected at node '${id}'`);
    const node = doc.nodes[id];
    if (!node) throw new GraphError(`Node '${id}' does not exist`);
    const spec = NODE_TYPES[node.type];
    if (!spec) throw new GraphError(`Unknown node type '${node.type}'`);
    visiting.add(id);

    const params = resolveParams(node.type, node.params);
    const kids = {}, kidBoxes = {};
    for (const [slot, sdef] of Object.entries(spec.inputs)) {
      const ref = (node.inputs || {})[slot];
      if (sdef.many) {
        const ids = Array.isArray(ref) ? ref : ref ? [ref] : [];
        if (ids.length === 0)
          throw new GraphError(`Node '${id}' (${node.type}) input '${slot}' needs at least one connected node`);
        const built = ids.map(build);
        kids[slot] = built.map((b) => b.fn);
        kidBoxes[slot] = built.map((b) => b.bbox);
      } else {
        if (!ref && !sdef.optional)
          throw new GraphError(`Node '${id}' (${node.type}) is missing required input '${slot}'`);
        const b = ref ? build(ref) : null;
        kids[slot] = b ? b.fn : null;
        kidBoxes[slot] = b ? b.bbox : null;
      }
    }

    visiting.delete(id);
    const result = { fn: spec.compile(params, kids), bbox: spec.bbox(params, kidBoxes) };
    cache.set(id, result);
    return result;
  }

  return build(nodeId);
}

/** Bounding box with fallback + padding, ready for meshing/rendering. */
export function meshingBounds(bbox, padFraction = 0.05) {
  const b = bbox ?? { min: [-30, -30, -30], max: [30, 30, 30] };
  const size = b.max.map((v, i) => Math.max(v - b.min[i], 1e-3));
  const pad = Math.max(...size) * padFraction;
  return { min: b.min.map((v) => v - pad), max: b.max.map((v, i) => v + pad), fallback: !bbox };
}

/** Serializable description of all node types (for UI + MCP discovery). */
export function nodeTypeCatalog() {
  const out = {};
  for (const [name, spec] of Object.entries(NODE_TYPES)) {
    out[name] = {
      category: spec.category,
      description: spec.description,
      params: Object.fromEntries(
        Object.entries(spec.params).map(([k, v]) => [k, { type: v.type, default: v.default, min: v.min, max: v.max, description: v.description }])
      ),
      inputs: Object.fromEntries(
        Object.entries(spec.inputs).map(([k, v]) => [k, { many: !!v.many, optional: !!v.optional, description: v.description || '' }])
      ),
    };
  }
  return out;
}
