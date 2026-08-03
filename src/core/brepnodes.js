/**
 * B-rep block definitions — the precision-CAD lineage of the node graph.
 *
 * These blocks look like every other block in cadgang (type, params, named
 * inputs) but they carry a second value alongside the distance field: an exact
 * OpenCascade solid. That is what makes STEP export, filleting, and lossless
 * round-tripping real rather than approximated.
 *
 * THE ONE-WAY BRIDGE
 * ------------------
 * A B-rep block's result is both an exact solid AND a distance field, so it can
 * feed an implicit block (smooth_union, gyroid infill, shell, drape) directly —
 * compileNode derives the field from the solid on demand.
 *
 * The reverse does not exist. An implicit block's output is a field; recovering
 * exact trimmed surfaces from it is a fitting problem, not a conversion, and it
 * fails outright on the blends and lattices fields are good at. So the moment a
 * field block touches a shape, that subtree loses its `brep` and becomes
 * STL-only. Blocks here reject field input with an error saying exactly that,
 * and export_step refuses rather than writing a faceted lie into a .step file.
 *
 * Practically: keep the B-rep chain intact for anything you need STEP out of,
 * and branch into fields at the end.
 */

import { GraphError } from './errors.js';
import * as B from './brep.js';

/** Blocks that produce a sketch rather than a solid, keyed for the catalog. */
const SKETCH_PLANE = {
  type: 'select',
  options: B.SKETCH_PLANES,
  default: 'XY',
  description: 'Plane the profile is drawn on',
};

const SKETCH_OFFSET = {
  type: 'number',
  default: 0,
  description: 'Distance of the sketch plane from the origin along its normal (mm)',
};

const CENTER = { type: 'vec2', default: [0, 0], description: 'Profile centre within the plane (mm)' };

const EDGE_SELECT = {
  type: 'select',
  options: ['all', 'x', 'y', 'z'],
  default: 'all',
  description: 'Which edges to act on: all, or only those running along X, Y or Z',
};

/** Input slot that must receive a sketch. */
const PROFILE_IN = { kind: 'sketch', description: 'Sketch to build from' };
/** Input slot that must receive an exact solid. */
const SOLID_IN = { kind: 'brep', description: 'Exact B-rep solid' };

export const BREP_NODE_TYPES = {
  // ------------------------------------------------------------- sketches

  sketch_rect: {
    category: 'sketch',
    kind: 'sketch',
    description: 'Rectangular profile on a plane, with optional corner rounding. Feed it to an extrude or revolve.',
    params: {
      plane: SKETCH_PLANE,
      offset: SKETCH_OFFSET,
      width: { type: 'number', default: 40, min: 0, description: 'Width in the plane\'s first axis (mm)' },
      height: { type: 'number', default: 25, min: 0, description: 'Height in the plane\'s second axis (mm)' },
      radius: { type: 'number', default: 0, min: 0, description: 'Corner radius (mm, 0 = sharp)' },
      center: CENTER,
    },
    inputs: {},
    brep: (p) => B.sketchRect(p.plane, p.offset, p.width, p.height, p.radius, p.center),
  },

  sketch_circle: {
    category: 'sketch',
    kind: 'sketch',
    description: 'Circular profile on a plane. Extrude it for a cylinder or a hole.',
    params: {
      plane: SKETCH_PLANE,
      offset: SKETCH_OFFSET,
      radius: { type: 'number', default: 10, min: 0, description: 'Circle radius (mm)' },
      center: CENTER,
    },
    inputs: {},
    brep: (p) => B.sketchCircle(p.plane, p.offset, p.radius, p.center),
  },

  sketch_polygon: {
    category: 'sketch',
    kind: 'sketch',
    description: 'Regular N-sided profile on a plane, sized by its circumradius.',
    params: {
      plane: SKETCH_PLANE,
      offset: SKETCH_OFFSET,
      sides: { type: 'number', default: 6, min: 3, max: 200, description: 'Number of sides' },
      radius: { type: 'number', default: 10, min: 0, description: 'Circumradius (mm)' },
      center: CENTER,
    },
    inputs: {},
    brep: (p) => B.sketchPolygon(p.plane, p.offset, p.sides, p.radius, p.center),
  },

  sketch_profile: {
    category: 'sketch',
    kind: 'sketch',
    description: 'Closed profile from an authored point list. Each point is [x, y] or [x, y, cornerRadius] — the third number rounds that corner.',
    params: {
      plane: SKETCH_PLANE,
      offset: SKETCH_OFFSET,
      points: {
        type: 'points',
        default: [[0, 0], [40, 0], [40, 20, 5], [0, 20, 5]],
        description: 'Closed profile vertices, [x, y] or [x, y, cornerRadius] (mm)',
      },
    },
    inputs: {},
    brep: (p) => B.sketchProfile(p.plane, p.offset, p.points),
  },

  // ---------------------------------------------------------- primitives

  brep_box: {
    category: 'brep',
    description: 'Exact rectangular solid. Centred in X/Y, sitting on z = 0.',
    params: { size: { type: 'vec3', default: [40, 30, 20], description: 'Extents X/Y/Z (mm)' } },
    inputs: {},
    brep: (p) => B.brepBox(p.size),
  },

  brep_cylinder: {
    category: 'brep',
    description: 'Exact cylinder along Z, base on z = 0. Stays a true cylindrical surface all the way to STEP.',
    params: {
      radius: { type: 'number', default: 10, min: 0, description: 'Radius (mm)' },
      height: { type: 'number', default: 25, min: 0, description: 'Height along Z (mm)' },
    },
    inputs: {},
    brep: (p) => B.brepCylinder(p.radius, p.height),
  },

  brep_sphere: {
    category: 'brep',
    description: 'Exact sphere centred on the origin.',
    params: { radius: { type: 'number', default: 12, min: 0, description: 'Radius (mm)' } },
    inputs: {},
    brep: (p) => B.brepSphere(p.radius),
  },

  // ------------------------------------------------------- sketch -> solid

  brep_extrude: {
    category: 'brep',
    description: 'Extrude a sketch along its plane normal into an exact solid. Negative distance extrudes the other way.',
    params: {
      distance: { type: 'number', default: 20, description: 'Extrusion distance (mm)' },
      symmetric: { type: 'bool', default: false, description: 'Centre the solid on the sketch plane' },
    },
    inputs: { profile: PROFILE_IN },
    brep: (p, kids) => B.brepExtrude(kids.profile, p.distance, p.symmetric),
  },

  brep_revolve: {
    category: 'brep',
    description: 'Revolve a sketch a full turn about an axis through the origin. The profile must sit to one side of the axis.',
    params: { axis: { type: 'vec3', default: [0, 0, 1], description: 'Axis of revolution' } },
    inputs: { profile: PROFILE_IN },
    brep: (p, kids) => B.brepRevolve(kids.profile, p.axis),
  },

  // ---------------------------------------------------------- operations

  brep_boolean: {
    category: 'brep',
    description: 'Exact boolean between solids. Unlike the field booleans, this computes the real intersection curves, so the result stays STEP-exportable.',
    params: {
      op: {
        type: 'select',
        options: ['union', 'subtract', 'intersect'],
        default: 'subtract',
        description: 'union joins, subtract removes the tools from the base, intersect keeps the overlap',
      },
    },
    inputs: {
      base: { ...SOLID_IN, description: 'Solid to operate on' },
      tool: { ...SOLID_IN, many: true, description: 'Solid(s) applied to the base, in order' },
    },
    brep: (p, kids) => B.brepBoolean(p.op, kids.base, kids.tool),
  },

  brep_fillet: {
    category: 'brep',
    description: 'Round edges with a true rolling-ball fillet. This is the operation implicit modelling cannot do exactly.',
    params: {
      radius: { type: 'number', default: 3, min: 0, description: 'Fillet radius (mm)' },
      select: EDGE_SELECT,
    },
    inputs: { shape: SOLID_IN },
    brep: (p, kids) => B.brepFillet(kids.shape, p.radius, p.select),
  },

  brep_chamfer: {
    category: 'brep',
    description: 'Bevel edges by a set distance.',
    params: {
      distance: { type: 'number', default: 2, min: 0, description: 'Chamfer distance (mm)' },
      select: EDGE_SELECT,
    },
    inputs: { shape: SOLID_IN },
    brep: (p, kids) => B.brepChamfer(kids.shape, p.distance, p.select),
  },

  brep_shell: {
    category: 'brep',
    description: 'Hollow a solid to a wall thickness, optionally opening the top or bottom face.',
    params: {
      thickness: { type: 'number', default: 2, description: 'Wall thickness (mm); negative hollows outward' },
      open: {
        type: 'select',
        options: ['top', 'bottom', 'none'],
        default: 'top',
        description: 'Which face to remove, leaving the shell open',
      },
    },
    inputs: { shape: SOLID_IN },
    brep: (p, kids) => B.brepShell(kids.shape, p.thickness, p.open),
  },

  brep_transform: {
    category: 'brep',
    description: 'Move, rotate and uniformly scale an exact solid. Rotations apply X then Y then Z, about the origin.',
    params: {
      translate: { type: 'vec3', default: [0, 0, 0], description: 'Translation (mm)' },
      rotate: { type: 'vec3', default: [0, 0, 0], description: 'Rotation about X/Y/Z (degrees)' },
      scale: { type: 'number', default: 1, min: 0, description: 'Uniform scale factor' },
    },
    inputs: { shape: SOLID_IN },
    brep: (p, kids) => B.brepTransform(kids.shape, p.translate, p.rotate, p.scale),
  },

  // -------------------------------------------------------------- output

  export_step: {
    category: 'output',
    description: 'Export sink: passes its input through and writes it as a real STEP B-rep file (download button on the block, or GET /api/export/step?node=<id>). Refuses field geometry — use export_stl for that.',
    params: {
      filename: { type: 'text', default: '', description: 'Optional server-side export name (written to exports/<name>.step)' },
    },
    inputs: { shape: { ...SOLID_IN, description: 'Exact solid to export' } },
    // Refuse anything that has no exact B-rep rather than writing a faceted
    // mesh into a .step file — that produces something a CAD kernel will open
    // and then refuse to fillet, which is worse than an honest error.
    brep: (p, kids) => B.requireSolid(kids.shape, 'shape'),
  },
};
