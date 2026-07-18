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

import { evalExpr } from './expr.js';
import { buildMeshDistance, buildFaceExtrusion } from './mesh.js';

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

// ------------------------------------------------- imported mesh assets

/** Fetch an asset from the compile context, with helpful errors. */
function getAsset(ctx, assetId) {
  if (!assetId) throw new GraphError('No asset selected — import a STEP file first');
  const asset = ctx?.doc?.assets?.[assetId];
  if (!asset) throw new GraphError(`Asset '${assetId}' does not exist in this document`);
  return asset;
}

// Compiled BVH/distance closures are expensive; assets are immutable once
// imported, so cache per asset object (dropped automatically when the asset
// is deleted or the document reloads).
const assetCache = new WeakMap();

function assetEntry(asset) {
  let entry = assetCache.get(asset);
  if (!entry) {
    entry = {
      positions: Float32Array.from(asset.positions),
      indices: Uint32Array.from(asset.indices),
      whole: null,
      faces: new Map(),
    };
    assetCache.set(asset, entry);
  }
  return entry;
}

/** Signed distance to the whole imported solid. */
function compiledAssetMesh(asset) {
  const entry = assetEntry(asset);
  if (!entry.whole) entry.whole = buildMeshDistance(entry.positions, entry.indices);
  return entry.whole;
}

/** Extrusion builder for one B-rep face patch of the asset. */
function compiledAssetFace(asset, faceIndex) {
  const faces = asset.faces || [];
  const face = faces[faceIndex];
  if (!face) {
    throw new GraphError(
      `Asset '${asset.id}' has no face ${faceIndex} (has ${faces.length} faces)`
    );
  }
  const entry = assetEntry(asset);
  let compiled = entry.faces.get(faceIndex);
  if (!compiled) {
    compiled = buildFaceExtrusion(entry.positions, entry.indices, face.first, face.count);
    entry.faces.set(faceIndex, compiled);
  }
  return compiled;
}

// ------------------------------------------------- drape heightfield

const DRAPE_GRID = 160;

/**
 * Drape a virtual sheet downward (-Z) over child shapes, vacuum-form style.
 * Compile-time: raycast a top-surface heightfield over the children's XY
 * bounds, then smooth it with a parabolic (rolling-ball) dilation of radius
 * `blend` — max-preserving, so the smoothed sheet never cuts into the shapes.
 * Query-time: slope-corrected distance to z = H(x,y), shelled to `thickness`,
 * clipped at `floor` and to the sheet's XY rectangle.
 */
function compileDrape(p, fns, boxes) {
  const ub = unionBox(boxes) ?? { min: [-30, -30, -30], max: [30, 30, 30] };
  const margin = Math.max(p.margin, 0);
  const floor = p.floor;
  const x0 = ub.min[0] - margin, x1 = ub.max[0] + margin;
  const y0 = ub.min[1] - margin, y1 = ub.max[1] + margin;
  const zTop = ub.max[2] + Math.max(1, p.thickness);
  const n = DRAPE_GRID;
  const dx = (x1 - x0) / (n - 1), dy = (y1 - y0) / (n - 1);
  const cell = Math.max(dx, dy);
  const minStep = Math.max(cell * 0.25, 1e-3);

  const f = fns.length === 1
    ? fns[0]
    : (x, y, z) => {
        let d = Infinity;
        for (const fn of fns) { const v = fn(x, y, z); if (v < d) d = v; }
        return d;
      };

  // Heightfield: highest surface z per grid cell (floor when nothing is hit).
  const H = new Float64Array(n * n);
  for (let j = 0; j < n; j++) {
    const y = y0 + j * dy;
    for (let i = 0; i < n; i++) {
      const x = x0 + i * dx;
      let z = zTop, h = floor;
      for (let iter = 0; iter < 256 && z > floor; iter++) {
        const d = f(x, y, z);
        if (d < minStep * 0.5) { h = Math.max(z, floor); break; }
        z -= Math.max(d, minStep);
      }
      H[j * n + i] = h;
    }
  }

  // Parabolic dilation (separable): H'(i) = max_k H(k) - (di*(i-k))^2 / (2*blend).
  if (p.blend > 0) {
    const dilate1D = (get, set, len, step) => {
      const w = Math.min(len - 1, Math.ceil(Math.sqrt(2 * p.blend * (zTop - floor)) / step));
      const src = new Float64Array(len);
      for (let i = 0; i < len; i++) src[i] = get(i);
      for (let i = 0; i < len; i++) {
        let best = src[i];
        for (let k = Math.max(0, i - w); k <= Math.min(len - 1, i + w); k++) {
          const off = (i - k) * step;
          const v = src[k] - (off * off) / (2 * p.blend);
          if (v > best) best = v;
        }
        set(i, best);
      }
    };
    for (let j = 0; j < n; j++) dilate1D((i) => H[j * n + i], (i, v) => { H[j * n + i] = v; }, n, dx);
    for (let i = 0; i < n; i++) dilate1D((j) => H[j * n + i], (j, v) => { H[j * n + i] = v; }, n, dy);
  }

  const sample = (i, j) => H[Math.max(0, Math.min(n - 1, j)) * n + Math.max(0, Math.min(n - 1, i))];
  const half = p.thickness / 2;
  const hx = (x1 - x0) / 2, hy = (y1 - y0) / 2, cxm = (x0 + x1) / 2, cym = (y0 + y1) / 2;

  const fn = (x, y, z) => {
    const gx = (x - x0) / dx, gy = (y - y0) / dy;
    const i = Math.floor(gx), j = Math.floor(gy);
    const fx = Math.min(Math.max(gx - i, 0), 1), fy = Math.min(Math.max(gy - j, 0), 1);
    const h00 = sample(i, j), h10 = sample(i + 1, j), h01 = sample(i, j + 1), h11 = sample(i + 1, j + 1);
    const h = h00 * (1 - fx) * (1 - fy) + h10 * fx * (1 - fy) + h01 * (1 - fx) * fy + h11 * fx * fy;
    // Slope correction so the sheet has uniform thickness on inclines. The
    // sheet rests ON the surface: it spans normal distance [0, thickness]
    // above z = H(x,y).
    const sx = ((h10 - h00) * (1 - fy) + (h11 - h01) * fy) / dx;
    const sy = ((h01 - h00) * (1 - fx) + (h11 - h10) * fx) / dy;
    const dn = (z - h) / Math.sqrt(1 + sx * sx + sy * sy) - half;
    const sheet = Math.abs(dn) - half;
    const clipZ = floor - z;
    const clipXY = Math.max(Math.abs(x - cxm) - hx, Math.abs(y - cym) - hy);
    return Math.max(sheet, clipZ, clipXY);
  };

  const bbox = {
    min: [x0, y0, floor],
    max: [x1, y1, ub.max[2] + p.thickness],
  };
  return { fn, bbox };
}

// Spiky sphere: N round-cone spikes on Fibonacci-sphere directions, unioned
// with the core sphere. Evaluating every cone per sample would make meshing
// O(N * res^3), so compile precomputes a lat/long table of the nearest spike
// indices per direction bin and each eval only tests those candidates. Bins
// (64x128) are much finer than the spike spacing even at max count, so the
// true nearest spikes are always among the candidates.
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const DIR_ZBINS = 64, DIR_PBINS = 128, DIR_CANDS = 8;

/** N unit directions evenly spread over the sphere (Fibonacci spiral). */
function fibonacciSphere(n) {
  const dir = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    const z = 1 - (2 * i + 1) / n;
    const rxy = Math.sqrt(Math.max(0, 1 - z * z));
    const phi = i * GOLDEN_ANGLE;
    dir[i * 3] = rxy * Math.cos(phi);
    dir[i * 3 + 1] = rxy * Math.sin(phi);
    dir[i * 3 + 2] = z;
  }
  return dir;
}

/**
 * Lat/long candidate table over a set of unit directions: for each of
 * DIR_ZBINS x DIR_PBINS direction bins, the M directions with the highest dot
 * product against the bin center. Bins are much finer than the direction
 * spacing (up to a few thousand dirs), so the true nearest directions to any
 * query are always among a bin's candidates.
 */
function buildNearestTable(dir, M) {
  const n = dir.length / 3;
  const ZB = DIR_ZBINS, PB = DIR_PBINS;
  const table = new Uint16Array(ZB * PB * M);
  const bestIdx = new Int32Array(M), bestDot = new Float64Array(M);
  for (let zi = 0; zi < ZB; zi++) {
    const cz = -1 + (2 * zi + 1) / ZB;
    const crxy = Math.sqrt(Math.max(0, 1 - cz * cz));
    for (let pi = 0; pi < PB; pi++) {
      const cphi = ((2 * pi + 1) / PB) * Math.PI;
      const cx = crxy * Math.cos(cphi), cy = crxy * Math.sin(cphi);
      bestDot.fill(-2);
      for (let i = 0; i < n; i++) {
        const d = cx * dir[i * 3] + cy * dir[i * 3 + 1] + cz * dir[i * 3 + 2];
        if (d <= bestDot[M - 1]) continue;
        let m = M - 1;
        while (m > 0 && bestDot[m - 1] < d) {
          bestDot[m] = bestDot[m - 1];
          bestIdx[m] = bestIdx[m - 1];
          m--;
        }
        bestDot[m] = d;
        bestIdx[m] = i;
      }
      const off = (zi * PB + pi) * M;
      for (let m = 0; m < M; m++) table[off + m] = bestIdx[m];
    }
  }
  return table;
}

/** Bin offset into a buildNearestTable() table for the direction of (x,y,z). */
function dirBinOffset(x, y, z, len, M) {
  let zi = Math.floor((z / len + 1) * 0.5 * DIR_ZBINS);
  if (zi < 0) zi = 0; else if (zi >= DIR_ZBINS) zi = DIR_ZBINS - 1;
  let phi = Math.atan2(y, x);
  if (phi < 0) phi += TAU;
  let pb = Math.floor((phi / TAU) * DIR_PBINS);
  if (pb < 0) pb = 0; else if (pb >= DIR_PBINS) pb = DIR_PBINS - 1;
  return (zi * DIR_PBINS + pb) * M;
}

function compileSpikySphere(p) {
  const R = p.radius;
  const N = Math.max(1, Math.round(p.count));
  const L = p.length;
  const r1 = p.base;
  const r2 = Math.min(p.tip, p.base);

  const dir = fibonacciSphere(N);
  const M = Math.min(DIR_CANDS, N);
  const table = buildNearestTable(dir, M);

  // A spike is the round cone (iq) from a = R*dir (radius r1) to b = (R+L)*dir
  // (radius r2). When the base sphere swallows the whole cone it degenerates to
  // a ball bump of radius r1.
  const l2 = L * L, rr = r1 - r2, a2 = l2 - rr * rr, il2 = 1 / l2;
  const ballOnly = L <= 1e-9 || rr >= L;

  return (x, y, z) => {
    const len = Math.sqrt(x * x + y * y + z * z);
    let d = len - R;
    if (len < 1e-12) return d; // center: core sphere term always wins
    const off = dirBinOffset(x, y, z, len, M);
    for (let m = 0; m < M; m++) {
      const i = table[off + m] * 3;
      const dx = dir[i], dy = dir[i + 1], dz = dir[i + 2];
      const pax = x - R * dx, pay = y - R * dy, paz = z - R * dz;
      let sd;
      if (ballOnly) {
        sd = Math.sqrt(pax * pax + pay * pay + paz * paz) - r1;
      } else {
        const bax = L * dx, bay = L * dy, baz = L * dz;
        const yv = pax * bax + pay * bay + paz * baz;
        const zv = yv - l2;
        const ex = pax * l2 - bax * yv, ey = pay * l2 - bay * yv, ez = paz * l2 - baz * yv;
        const x2 = ex * ex + ey * ey + ez * ez;
        const y2 = yv * yv * l2;
        const z2 = zv * zv * l2;
        const k = Math.sign(rr) * rr * rr * x2;
        if (Math.sign(zv) * a2 * z2 > k) sd = Math.sqrt(x2 + z2) * il2 - r2;
        else if (Math.sign(yv) * a2 * y2 < k) sd = Math.sqrt(x2 + y2) * il2 - r1;
        else sd = (Math.sqrt(x2 * a2 * il2) + yv * rr) * il2 - r1;
      }
      if (sd < d) d = sd;
    }
    return d;
  };
}

// Polyhedron: intersection of N half-spaces whose planes are tangent to an
// inscribed sphere of the given radius. N = 4/6/8/12/20 uses the exact Platonic
// normal sets (tetra/cube/octa/dodeca/icosahedron); any other N spreads face
// normals on a Fibonacci sphere. The max-plane SDF only needs the normal
// nearest the query direction, so large N reuses the candidate-table lookup.
const PHI = (1 + Math.sqrt(5)) / 2;

/** Exact face-normal sets for the five Platonic solids, or null. */
function platonicNormals(n) {
  const raw = [];
  if (n === 4) {
    raw.push([1, 1, 1], [1, -1, -1], [-1, 1, -1], [-1, -1, 1]);
  } else if (n === 6) {
    raw.push([1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]);
  } else if (n === 8) {
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) raw.push([sx, sy, sz]);
  } else if (n === 12) {
    for (const s1 of [-1, 1]) for (const s2 of [-1, 1])
      raw.push([0, s1, s2 * PHI], [s1, s2 * PHI, 0], [s2 * PHI, 0, s1]);
  } else if (n === 20) {
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) raw.push([sx, sy, sz]);
    const a = 1 / PHI;
    for (const s1 of [-1, 1]) for (const s2 of [-1, 1])
      raw.push([0, s1 * a, s2 * PHI], [s1 * a, s2 * PHI, 0], [s2 * PHI, 0, s1 * a]);
  } else {
    return null;
  }
  return toUnitDirs(raw);
}

/** Normalize an array of [x,y,z] into a flat Float64Array of unit vectors. */
function toUnitDirs(raw) {
  const dir = new Float64Array(raw.length * 3);
  raw.forEach(([x, y, z], i) => {
    const l = Math.hypot(x, y, z);
    dir[i * 3] = x / l;
    dir[i * 3 + 1] = y / l;
    dir[i * 3 + 2] = z / l;
  });
  return dir;
}

/**
 * Companion plane families for a Platonic face count: the dual solid's face
 * normals (cutting vertices) and the edge-midpoint normals (beveling edges).
 * Together with the base faces these span the classic truncation morphs:
 * cube -> truncated cube -> cuboctahedron -> octahedron, and the rhombic
 * dodeca/triacontahedron bevels.
 */
function platonicFamilyDirs(n) {
  const axes = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  if (n === 4) {
    return {
      dual: toUnitDirs([[-1, -1, -1], [-1, 1, 1], [1, -1, 1], [1, 1, -1]]),
      edge: toUnitDirs(axes),
    };
  }
  if (n === 6 || n === 8) {
    const rhombic = []; // rhombic dodecahedron normals: permutations of (±1, ±1, 0)
    for (const s1 of [-1, 1]) for (const s2 of [-1, 1])
      rhombic.push([s1, s2, 0], [0, s1, s2], [s2, 0, s1]);
    return { dual: platonicNormals(n === 6 ? 8 : 6), edge: toUnitDirs(rhombic) };
  }
  if (n === 12 || n === 20) {
    // rhombic triacontahedron normals = icosidodecahedron vertices:
    // the 6 axes plus all sign/cyclic variants of (1, phi, phi^2)
    const tria = axes.map((a) => a.slice());
    const p2 = PHI * PHI;
    for (const s1 of [-1, 1]) for (const s2 of [-1, 1]) for (const s3 of [-1, 1])
      tria.push([s1, s2 * PHI, s3 * p2], [s2 * PHI, s3 * p2, s1], [s3 * p2, s1, s2 * PHI]);
    return { dual: platonicNormals(n === 12 ? 20 : 12), edge: toUnitDirs(tria) };
  }
  return null;
}

/**
 * Shared polyhedron geometry: weighted plane normals, radii, circumradius.
 *
 * For Platonic face counts the p/q/r sliders weight three plane families
 * (base faces / dual faces / edge bevels). A family with weight w has its
 * planes at distance radius/w, so premultiplying its unit normals by w folds
 * the weight into one max-dot loop: w -> 0 pushes the planes to infinity
 * (family off), w = 1 makes them tangent to the inscribed sphere.
 */
function polyhedronGeom(p) {
  const n = Math.max(4, Math.round(p.faces));
  const rnd = Math.min(p.round, p.radius);
  const r = p.radius - rnd; // inner sharp polyhedron; final surface offset by rnd
  const platonic = platonicNormals(n);

  let wdir, uniform;
  if (platonic) {
    const { dual, edge } = platonicFamilyDirs(n);
    const fams = [[platonic, p.p], [dual, p.q], [edge, p.r]].filter(([, w]) => w > 1e-4);
    if (!fams.length)
      throw new GraphError('polyhedron: p, q and r are all zero — no face planes left');
    uniform = fams.length === 1 && Math.abs(fams[0][1] - 1) < 1e-12;
    wdir = new Float64Array(fams.reduce((s, [d]) => s + d.length, 0));
    let o = 0;
    for (const [d, w] of fams) for (let i = 0; i < d.length; i++) wdir[o++] = d[i] * w;
  } else {
    wdir = fibonacciSphere(n); // p/q/r only apply to the Platonic symmetry families
    uniform = true;
  }

  // Sampled circumradius: for a convex body around the origin the radial
  // extent along d is r / max_i dot(d, wn_i); the max over dense probe
  // directions lands within a fraction of a percent of the farthest vertex.
  const PROBES = 4096;
  const probe = fibonacciSphere(PROBES);
  let circum = 0;
  for (let s = 0; s < PROBES; s++) {
    const px = probe[s * 3], py = probe[s * 3 + 1], pz = probe[s * 3 + 2];
    let best = -Infinity;
    for (let i = 0; i < wdir.length; i += 3) {
      const d = px * wdir[i] + py * wdir[i + 1] + pz * wdir[i + 2];
      if (d > best) best = d;
    }
    if (best < 1e-6) throw new GraphError(`polyhedron with ${n} faces does not bound a solid`);
    const t = r / best;
    if (t > circum) circum = t;
  }
  return { wdir, uniform, r, rnd, circum: circum * 1.05 };
}

function compilePolyhedron(p) {
  const { wdir, uniform, r, rnd } = polyhedronGeom(p);
  const surface = r + rnd;
  const nd = wdir.length / 3;

  if (uniform && nd > 24) {
    const M = Math.min(DIR_CANDS, nd);
    const table = buildNearestTable(wdir, M);
    return (x, y, z) => {
      const len = Math.sqrt(x * x + y * y + z * z);
      if (len < 1e-12) return -surface;
      const off = dirBinOffset(x, y, z, len, M);
      let best = -Infinity;
      for (let m = 0; m < M; m++) {
        const i = table[off + m] * 3;
        const d = x * wdir[i] + y * wdir[i + 1] + z * wdir[i + 2];
        if (d > best) best = d;
      }
      return best - surface;
    };
  }

  return (x, y, z) => {
    let best = -Infinity;
    for (let i = 0; i < wdir.length; i += 3) {
      const d = x * wdir[i] + y * wdir[i + 1] + z * wdir[i + 2];
      if (d > best) best = d;
    }
    return best - surface;
  };
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

  spiky_sphere: {
    category: 'primitive',
    description: 'Sphere bristling with N cone spikes spread evenly on a Fibonacci sphere.',
    params: {
      radius: { type: 'number', default: 20, min: 0, description: 'Core sphere radius (mm)' },
      count: { type: 'number', default: 300, min: 1, max: 4000, description: 'Number of spikes' },
      length: { type: 'number', default: 8, min: 0, description: 'Spike length beyond the sphere surface (mm)' },
      base: { type: 'number', default: 1.8, min: 0, description: 'Spike radius at the sphere surface (mm)' },
      tip: { type: 'number', default: 0.4, min: 0, description: 'Spike radius at the tip (mm)' },
    },
    inputs: {},
    compile: (p) => compileSpikySphere(p),
    bbox: (p) => {
      const e = p.radius + Math.max(p.length + Math.min(p.tip, p.base), p.base);
      return { min: [-e, -e, -e], max: [e, e, e] };
    },
  },

  polyhedron: {
    category: 'primitive',
    description: 'Convex polyhedron with N faces tangent to an inscribed sphere. 4/6/8/12/20 faces give exact Platonic solids (with p/q/r truncation-morph sliders); other counts spread faces evenly.',
    params: {
      faces: { type: 'number', default: 12, min: 4, max: 512, description: 'Number of faces' },
      radius: { type: 'number', default: 15, min: 0, description: 'Inscribed sphere radius (mm)' },
      round: { type: 'number', default: 0, min: 0, description: 'Edge rounding radius (mm)' },
      p: { type: 'number', default: 1, min: 0, max: 1, description: 'Base face planes weight — Platonic counts morph: 1 = full faces, 0 = off' },
      q: { type: 'number', default: 0, min: 0, max: 1, description: 'Dual-solid planes weight — raise to truncate corners toward the dual' },
      r: { type: 'number', default: 0, min: 0, max: 1, description: 'Edge-bevel planes weight — raise to bevel edges (rhombic faces)' },
    },
    inputs: {},
    compile: (p) => compilePolyhedron(p),
    bbox: (p) => {
      const { rnd, circum } = polyhedronGeom(p);
      const e = circum + rnd;
      return { min: [-e, -e, -e], max: [e, e, e] };
    },
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

  export_stl: {
    category: 'output',
    description: 'Export sink: passes its input through unchanged and exports it as binary STL (download button on the block, or GET /api/export/stl?node=<id>).',
    params: {
      filename: { type: 'text', default: '', description: 'Optional server-side export name (written to exports/<name>.stl)' },
      resolution: { type: 'number', default: 128, min: 24, max: 220, description: 'Export meshing resolution' },
    },
    inputs: { shape: { description: 'Shape to export' } },
    compile: (p, kids) => kids.shape,
    bbox: (p, kb) => kb.shape,
  },

  imported_mesh: {
    category: 'primitive',
    description: 'Solid imported from a STEP/IGES file (tessellated triangle mesh, exact signed distance via BVH).',
    params: {
      asset: { type: 'asset', default: '', description: 'Imported mesh asset id' },
    },
    inputs: {},
    compile: (p, kids, ctx) => compiledAssetMesh(getAsset(ctx, p.asset)).distance,
    bbox: (p, kb, ctx) => {
      const asset = getAsset(ctx, p.asset);
      return asset.bbox ?? compiledAssetMesh(asset).bbox;
    },
  },

  extrude_face: {
    category: 'primitive',
    description: 'Solid made by extruding one selected surface of an imported STEP asset along its normal (negative distance extrudes inward).',
    params: {
      asset: { type: 'asset', default: '', description: 'Imported mesh asset id' },
      face: { type: 'number', default: 0, min: 0, description: 'B-rep face index (pick in the 3D view)' },
      distance: { type: 'number', default: 10, description: 'Extrusion distance along the face normal (mm)' },
    },
    inputs: {},
    compile: (p, kids, ctx) =>
      compiledAssetFace(getAsset(ctx, p.asset), Math.round(p.face)).compile(p.distance),
    bbox: (p, kb, ctx) =>
      compiledAssetFace(getAsset(ctx, p.asset), Math.round(p.face)).bbox(p.distance),
  },

  drape: {
    category: 'modify',
    description: 'Drape a sheet of given thickness downward (-Z) over the input shapes, like vacuum forming. Blend controls how smoothly/loosely the sheet wraps; floor is the Z where the sheet ends.',
    params: {
      thickness: { type: 'number', default: 2, min: 0.1, description: 'Sheet thickness (mm)' },
      blend: { type: 'number', default: 5, min: 0, description: 'Wrap smoothness — radius of the rounding ball (mm)' },
      floor: { type: 'number', default: 0, description: 'Z level the sheet drapes down to (mm)' },
      margin: { type: 'number', default: 10, min: 0, description: 'Sheet overhang beyond the shapes (mm)' },
    },
    inputs: { shapes: { many: true, description: 'Shapes to drape over' } },
    compile: (p, kids, ctx) => compileDrape(p, kids.shapes, ctx.kidBoxes.shapes).fn,
    bbox: (p, kb) => {
      const ub = unionBox(kb.shapes) ?? { min: [-30, -30, -30], max: [30, 30, 30] };
      return {
        min: [ub.min[0] - p.margin, ub.min[1] - p.margin, p.floor],
        max: [ub.max[0] + p.margin, ub.max[1] + p.margin, ub.max[2] + p.thickness],
      };
    },
  },

  linear_array: {
    category: 'modify',
    description: 'Repeat a shape N times along a step vector.',
    params: {
      count: { type: 'number', default: 5, min: 1, max: 500, description: 'Number of copies (including the original)' },
      step: { type: 'vec3', default: [20, 0, 0], description: 'Offset between copies (mm)' },
    },
    inputs: { shape: {} },
    compile: (p, kids) => {
      const f = kids.shape;
      const nCopies = Math.round(p.count);
      const [sx, sy, sz] = p.step;
      if (nCopies <= 1) return f;
      return (x, y, z) => {
        let d = Infinity;
        for (let i = 0; i < nCopies; i++) {
          const v = f(x - i * sx, y - i * sy, z - i * sz);
          if (v < d) d = v;
        }
        return d;
      };
    },
    bbox: (p, kb) => {
      const b = kb.shape;
      if (!b) return null;
      const nCopies = Math.round(p.count);
      const span = p.step.map((s) => s * (nCopies - 1));
      return {
        min: b.min.map((v, i) => v + Math.min(0, span[i])),
        max: b.max.map((v, i) => v + Math.max(0, span[i])),
      };
    },
  },

  polar_array: {
    category: 'modify',
    description: 'Repeat a shape N times rotated around the Z axis.',
    params: {
      count: { type: 'number', default: 6, min: 1, max: 360, description: 'Number of copies (including the original)' },
      sweep: { type: 'number', default: 360, description: 'Total sweep angle (degrees); 360 spaces copies evenly around the full circle' },
    },
    inputs: { shape: {} },
    compile: (p, kids) => {
      const f = kids.shape;
      const nCopies = Math.round(p.count);
      if (nCopies <= 1) return f;
      const full = Math.abs(p.sweep % 360) < 1e-9;
      const stepDeg = full ? p.sweep / nCopies : p.sweep / (nCopies - 1);
      const cs = [], sn = [];
      for (let i = 0; i < nCopies; i++) {
        const a = (i * stepDeg * Math.PI) / 180;
        cs.push(Math.cos(a));
        sn.push(Math.sin(a));
      }
      return (x, y, z) => {
        let d = Infinity;
        for (let i = 0; i < nCopies; i++) {
          const c = cs[i], s = sn[i];
          // rotate query by -angle to place the copy at +angle
          const v = f(c * x + s * y, -s * x + c * y, z);
          if (v < d) d = v;
        }
        return d;
      };
    },
    bbox: (p, kb) => {
      const b = kb.shape;
      if (!b) return null;
      const nCopies = Math.round(p.count);
      const full = Math.abs(p.sweep % 360) < 1e-9;
      const stepDeg = nCopies <= 1 ? 0 : full ? p.sweep / nCopies : p.sweep / (nCopies - 1);
      const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < nCopies; i++) {
        const a = (i * stepDeg * Math.PI) / 180;
        const c = Math.cos(a), s = Math.sin(a);
        for (let corner = 0; corner < 8; corner++) {
          const px = (corner & 1 ? b.max : b.min)[0];
          const py = (corner & 2 ? b.max : b.min)[1];
          const pz = (corner & 4 ? b.max : b.min)[2];
          const wx = c * px - s * py, wy = s * px + c * py;
          if (wx < min[0]) min[0] = wx; if (wx > max[0]) max[0] = wx;
          if (wy < min[1]) min[1] = wy; if (wy > max[1]) max[1] = wy;
          if (pz < min[2]) min[2] = pz; if (pz > max[2]) max[2] = pz;
        }
      }
      return { min, max };
    },
  },
};

// ---------------------------------------------------------------- compile

export class GraphError extends Error {}

/** Resolve one authored scalar (number or string-expression) against `vars`. */
function resolveScalar(v, vars, where) {
  const n = typeof v === 'string' ? evalExpr(v, vars) : Number(v);
  if (!isFinite(n)) throw new GraphError(`Param '${where}' must resolve to a finite number`);
  return n;
}

/**
 * Resolve a node's authored params (numbers or string-expressions, vec3s of the
 * same) against the document's user variables into plain finite numbers. Throws
 * GraphError on anything that doesn't resolve — call it to validate at edit time.
 */
export function resolveParams(type, params = {}, vars = {}) {
  const spec = NODE_TYPES[type];
  const out = {};
  for (const [name, def] of Object.entries(spec.params)) {
    const raw = params[name] ?? def.default;
    if (def.type === 'number') {
      let v = resolveScalar(raw, vars, `${name}' of ${type}`);
      if (def.min !== undefined && v < def.min) v = def.min;
      if (def.max !== undefined && v > def.max) v = def.max;
      out[name] = v;
    } else if (def.type === 'vec3') {
      if (!Array.isArray(raw) || raw.length !== 3)
        throw new GraphError(`Param '${name}' of ${type} must be an array of 3 numbers`);
      out[name] = raw.map((c, i) => resolveScalar(c, vars, `${name}[${i}]' of ${type}`));
    } else {
      out[name] = raw;
    }
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

    const params = resolveParams(node.type, node.params, doc.vars || {});
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
    // ctx gives asset-backed and bounds-aware blocks access to the document
    // and their children's boxes without changing the (params, kids) contract.
    const ctx = { doc, node, kidBoxes };
    const result = { fn: spec.compile(params, kids, ctx), bbox: spec.bbox(params, kidBoxes, ctx) };
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
