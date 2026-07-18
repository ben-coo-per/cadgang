import { test } from 'node:test';
import assert from 'node:assert';
import { compileNode, meshingBounds } from '../src/core/sdf.js';
import { ModelDocument } from '../src/core/document.js';
import { meshSDF } from '../src/core/mesher.js';

function docWith(nodes, output) {
  const doc = new ModelDocument(null);
  for (const n of nodes) doc.createNode(n);
  doc.setOutput(output);
  return doc;
}

function compilePoly(params) {
  const doc = docWith([{ type: 'polyhedron', id: 'p', params }], 'p');
  return compileNode(doc, 'p');
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

function fibDirs(n) {
  const dirs = [];
  for (let i = 0; i < n; i++) {
    const z = 1 - (2 * i + 1) / n;
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    const phi = i * GOLDEN_ANGLE;
    dirs.push([r * Math.cos(phi), r * Math.sin(phi), z]);
  }
  return dirs;
}

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

test('polyhedron: 6 faces is an exact cube', () => {
  const { fn, bbox } = compilePoly({ faces: 6, radius: 10 });
  assert.ok(Math.abs(fn(0, 0, 0) + 10) < 1e-9, 'center depth = inradius');
  assert.ok(Math.abs(fn(10, 0, 0)) < 1e-9, 'face tangent to inscribed sphere');
  assert.ok(fn(9.9, 9.9, 9.9) < 0, 'corner region is solid');
  assert.ok(fn(10.1, 0, 0) > 0, 'outside a face is positive');
  const mesh = meshSDF(fn, meshingBounds(bbox), 110);
  assert.ok(Math.abs(mesh.stats.volume - 8000) / 8000 < 0.02, `cube volume ~8000, got ${mesh.stats.volume}`);
});

test('polyhedron: 12 faces matches dodecahedron volume', () => {
  const rIn = 10;
  const { fn, bbox } = compilePoly({ faces: 12, radius: rIn });
  // inradius = (a/2)·sqrt((25+11·sqrt5)/10)  ->  edge a;  V = a^3·(15+7·sqrt5)/4
  const a = (2 * rIn) / Math.sqrt((25 + 11 * Math.sqrt(5)) / 10);
  const vol = (a ** 3 * (15 + 7 * Math.sqrt(5))) / 4;
  const mesh = meshSDF(fn, meshingBounds(bbox), 110);
  assert.ok(Math.abs(mesh.stats.volume - vol) / vol < 0.02, `dodecahedron volume ~${vol}, got ${mesh.stats.volume}`);
});

test('polyhedron: contains its inscribed sphere for any face count', () => {
  const rand = rng(7);
  for (const faces of [4, 5, 9, 20, 47]) {
    const { fn } = compilePoly({ faces, radius: 12 });
    assert.ok(Math.abs(fn(0, 0, 0) + 12) < 1e-9, `center depth (faces=${faces})`);
    let minAbs = Infinity;
    for (let s = 0; s < 500; s++) {
      const u = rand() * 2 - 1, phi = rand() * 2 * Math.PI;
      const rxy = Math.sqrt(1 - u * u);
      const d = fn(12 * rxy * Math.cos(phi), 12 * rxy * Math.sin(phi), 12 * u);
      assert.ok(d <= 1e-9, `inscribed sphere stays inside (faces=${faces})`);
      minAbs = Math.min(minAbs, Math.abs(d));
    }
    assert.ok(minAbs < 0.5, `surface touches the inscribed sphere somewhere (faces=${faces})`);
  }
});

test('polyhedron: candidate table matches brute-force max over all planes', () => {
  const faces = 200, radius = 12;
  const { fn } = compilePoly({ faces, radius });
  const dirs = fibDirs(faces);
  const brute = (x, y, z) => {
    let best = -Infinity;
    for (const [nx, ny, nz] of dirs) best = Math.max(best, x * nx + y * ny + z * nz);
    return best - radius;
  };
  const rand = rng(20260718);
  let worst = 0;
  for (let s = 0; s < 4000; s++) {
    const x = (rand() * 2 - 1) * 18, y = (rand() * 2 - 1) * 18, z = (rand() * 2 - 1) * 18;
    worst = Math.max(worst, Math.abs(fn(x, y, z) - brute(x, y, z)));
  }
  assert.ok(worst < 1e-9, `table SDF must equal brute force (worst diff ${worst})`);
});

test('polyhedron: bbox contains the mesh, mesh fills most of the bbox reach', () => {
  for (const faces of [4, 6, 33]) {
    const { fn, bbox } = compilePoly({ faces, radius: 10 });
    const mesh = meshSDF(fn, meshingBounds(bbox), 90);
    const pos = mesh.positions;
    let maxR = 0;
    for (let v = 0; v < pos.length; v += 3) {
      for (let c = 0; c < 3; c++) {
        assert.ok(pos[v + c] >= bbox.min[c] - 1e-6 && pos[v + c] <= bbox.max[c] + 1e-6, `vertex inside bbox (faces=${faces})`);
      }
      maxR = Math.max(maxR, Math.hypot(pos[v], pos[v + 1], pos[v + 2]));
    }
    assert.ok(maxR > 10, `vertices reach beyond the inradius (faces=${faces})`);
    assert.ok(mesh.stats.triangleCount > 500, `solid mesh (faces=${faces})`);
  }
});

test('polyhedron: rounding shrinks volume and keeps faces at radius', () => {
  const sharp = compilePoly({ faces: 6, radius: 10 });
  const round = compilePoly({ faces: 6, radius: 10, round: 2 });
  assert.ok(Math.abs(round.fn(10, 0, 0)) < 1e-9, 'face still tangent at radius');
  const vSharp = meshSDF(sharp.fn, meshingBounds(sharp.bbox), 100).stats.volume;
  const vRound = meshSDF(round.fn, meshingBounds(round.bbox), 100).stats.volume;
  assert.ok(vRound < vSharp, 'rounded cube loses corner volume');
  assert.ok(vRound > vSharp * 0.8, 'rounding only trims edges');
});

test('polyhedron: degenerate over-rounding stays finite', () => {
  const { fn } = compilePoly({ faces: 8, radius: 5, round: 50 });
  assert.ok(isFinite(fn(0, 0, 0)) && isFinite(fn(10, 3, -2)), 'no NaN when round exceeds radius');
  assert.ok(fn(0, 0, 0) < 0, 'still solid at center');
});

test('polyhedron p/q/r: pure dual (p=0, q=1) of a cube is an exact octahedron', () => {
  const { fn, bbox } = compilePoly({ faces: 6, radius: 10, p: 0, q: 1 });
  assert.ok(Math.abs(fn(0, 0, 0) + 10) < 1e-9, 'center depth = inradius');
  const vtx = 10 * Math.sqrt(3); // octahedron circumradius for inradius 10
  assert.ok(Math.abs(fn(vtx, 0, 0)) < 1e-6, 'octahedron vertex on the axis');
  const a = 10 * Math.sqrt(6); // edge length for inradius 10
  const vol = (Math.SQRT2 * a ** 3) / 3;
  const mesh = meshSDF(fn, meshingBounds(bbox), 110);
  assert.ok(Math.abs(mesh.stats.volume - vol) / vol < 0.02, `octahedron volume ~${vol}, got ${mesh.stats.volume}`);
});

test('polyhedron p/q/r: q=1 truncates cube corners at the dual plane', () => {
  const cube = compilePoly({ faces: 6, radius: 10 });
  const trunc = compilePoly({ faces: 6, radius: 10, q: 1 });
  assert.ok(Math.abs(trunc.fn(10, 0, 0)) < 1e-9, 'cube face still tangent at radius');
  const s = 10 / Math.sqrt(3);
  assert.ok(Math.abs(trunc.fn(s, s, s)) < 1e-9, 'corner shaved back to the octa plane');
  const vc = meshSDF(cube.fn, meshingBounds(cube.bbox), 100).stats.volume;
  const vt = meshSDF(trunc.fn, meshingBounds(trunc.bbox), 100).stats.volume;
  assert.ok(vt < vc * 0.95 && vt > vc * 0.4, `truncation trims corners (${vt} vs ${vc})`);
});

test('polyhedron p/q/r: r=1 bevels cube edges with rhombic planes', () => {
  const bev = compilePoly({ faces: 6, radius: 10, r: 1 });
  const s = 10 / Math.SQRT2;
  assert.ok(Math.abs(bev.fn(s, s, 0)) < 1e-9, 'edge shaved back to the bevel plane');
  assert.ok(Math.abs(bev.fn(10, 0, 0)) < 1e-9, 'faces still tangent at radius');
  const cube = compilePoly({ faces: 6, radius: 10 });
  const vc = meshSDF(cube.fn, meshingBounds(cube.bbox), 100).stats.volume;
  const vb = meshSDF(bev.fn, meshingBounds(bev.bbox), 100).stats.volume;
  assert.ok(vb < vc && vb > vc * 0.5, `bevel trims edge volume (${vb} vs ${vc})`);
});

test('polyhedron p/q/r: icosahedral family dual matches icosahedron volume', () => {
  const { fn, bbox } = compilePoly({ faces: 12, radius: 10, p: 0, q: 1 });
  // icosahedron: inradius = phi^2·a / (2·sqrt3)  ->  edge a;  V = (5/12)(3+sqrt5)·a^3
  const phi = (1 + Math.sqrt(5)) / 2;
  const a = (2 * Math.sqrt(3) * 10) / (phi * phi);
  const vol = (5 / 12) * (3 + Math.sqrt(5)) * a ** 3;
  const mesh = meshSDF(fn, meshingBounds(bbox), 110);
  assert.ok(Math.abs(mesh.stats.volume - vol) / vol < 0.02, `icosahedron volume ~${vol}, got ${mesh.stats.volume}`);
});

test('polyhedron p/q/r: triacontahedral edge family is tangent and bounded', () => {
  const { fn, bbox } = compilePoly({ faces: 12, radius: 10, p: 0, q: 0, r: 1 });
  assert.ok(Math.abs(fn(0, 0, 0) + 10) < 1e-9, 'center depth = inradius');
  assert.ok(Math.abs(fn(10, 0, 0)) < 1e-9, 'axis normal tangent at radius');
  const mesh = meshSDF(fn, meshingBounds(bbox), 90);
  assert.ok(mesh.stats.triangleCount > 500 && isFinite(mesh.stats.volume), 'meshes to a solid');
});

test('polyhedron p/q/r: all-zero sliders are rejected', () => {
  assert.throws(() => compilePoly({ faces: 6, radius: 10, p: 0, q: 0, r: 0 }), /no face planes/);
});

test('polyhedron p/q/r: ignored for non-Platonic face counts', () => {
  const plain = compilePoly({ faces: 9, radius: 10 });
  const wild = compilePoly({ faces: 9, radius: 10, p: 0.2, q: 1, r: 0.7 });
  const rand = rng(99);
  for (let s = 0; s < 200; s++) {
    const x = (rand() * 2 - 1) * 15, y = (rand() * 2 - 1) * 15, z = (rand() * 2 - 1) * 15;
    assert.ok(Math.abs(plain.fn(x, y, z) - wild.fn(x, y, z)) < 1e-12, 'field unchanged');
  }
});
