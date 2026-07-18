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

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/** Fibonacci-sphere unit directions, same distribution the kernel uses. */
function spikeDirs(count) {
  const dirs = [];
  for (let i = 0; i < count; i++) {
    const z = 1 - (2 * i + 1) / count;
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    const phi = i * GOLDEN_ANGLE;
    dirs.push([r * Math.cos(phi), r * Math.sin(phi), z]);
  }
  return dirs;
}

/** Reference SDF: brute-force min over the core sphere and ALL spike cones. */
function bruteForceSpiky({ radius: R, count, length: L, base: r1, tip }) {
  const r2 = Math.min(tip, r1);
  const dirs = spikeDirs(count);
  const l2 = L * L, rr = r1 - r2, a2 = l2 - rr * rr, il2 = 1 / l2;
  return (x, y, z) => {
    let d = Math.sqrt(x * x + y * y + z * z) - R;
    for (const [dx, dy, dz] of dirs) {
      const pax = x - R * dx, pay = y - R * dy, paz = z - R * dz;
      const bax = L * dx, bay = L * dy, baz = L * dz;
      const yv = pax * bax + pay * bay + paz * baz;
      const zv = yv - l2;
      const ex = pax * l2 - bax * yv, ey = pay * l2 - bay * yv, ez = paz * l2 - baz * yv;
      const x2 = ex * ex + ey * ey + ez * ez;
      const y2 = yv * yv * l2;
      const z2 = zv * zv * l2;
      const k = Math.sign(rr) * rr * rr * x2;
      let sd;
      if (Math.sign(zv) * a2 * z2 > k) sd = Math.sqrt(x2 + z2) * il2 - r2;
      else if (Math.sign(yv) * a2 * y2 < k) sd = Math.sqrt(x2 + y2) * il2 - r1;
      else sd = (Math.sqrt(x2 * a2 * il2) + yv * rr) * il2 - r1;
      if (sd < d) d = sd;
    }
    return d;
  };
}

/** Deterministic LCG so failures reproduce. */
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

const PARAMS = { radius: 20, count: 300, length: 8, base: 1.8, tip: 0.4 };

test('spiky_sphere: center and far field behave like an SDF', () => {
  const doc = docWith([{ type: 'spiky_sphere', id: 'sp', params: PARAMS }], 'sp');
  const { fn, bbox } = compileNode(doc, 'sp');
  assert.ok(Math.abs(fn(0, 0, 0) + 20) < 1e-9, 'center is -radius deep');
  assert.ok(fn(100, 0, 0) > 70, 'far outside is far positive');
  const e = 20 + 8 + 0.4;
  assert.ok(Math.abs(bbox.max[0] - e) < 1e-9, 'bbox reaches the spike tips');
});

test('spiky_sphere: a spike tip lies on the surface', () => {
  const doc = docWith([{ type: 'spiky_sphere', id: 'sp', params: PARAMS }], 'sp');
  const { fn } = compileNode(doc, 'sp');
  const [dx, dy, dz] = spikeDirs(PARAMS.count)[0];
  const t = PARAMS.radius + PARAMS.length + PARAMS.tip; // tip sphere apex
  assert.ok(Math.abs(fn(t * dx, t * dy, t * dz)) < 1e-6, 'apex of spike 0 is on the surface');
  const mid = PARAMS.radius + PARAMS.length / 2; // inside the cone shaft
  assert.ok(fn(mid * dx, mid * dy, mid * dz) < 0, 'spike shaft is solid');
});

test('spiky_sphere: candidate table matches brute force over all spikes', () => {
  const doc = docWith([{ type: 'spiky_sphere', id: 'sp', params: PARAMS }], 'sp');
  const { fn } = compileNode(doc, 'sp');
  const ref = bruteForceSpiky(PARAMS);
  const rand = rng(20260718);
  const extent = PARAMS.radius + PARAMS.length + 4;
  let worst = 0;
  for (let n = 0; n < 4000; n++) {
    const x = (rand() * 2 - 1) * extent;
    const y = (rand() * 2 - 1) * extent;
    const z = (rand() * 2 - 1) * extent;
    worst = Math.max(worst, Math.abs(fn(x, y, z) - ref(x, y, z)));
  }
  assert.ok(worst < 1e-9, `fast SDF must equal brute force (worst diff ${worst})`);
});

test('spiky_sphere: high spike count still matches brute force', () => {
  const params = { radius: 15, count: 1200, length: 5, base: 0.9, tip: 0.2 };
  const doc = docWith([{ type: 'spiky_sphere', id: 'sp', params }], 'sp');
  const { fn } = compileNode(doc, 'sp');
  const ref = bruteForceSpiky(params);
  const rand = rng(424242);
  const extent = params.radius + params.length + 3;
  let worst = 0;
  for (let n = 0; n < 2000; n++) {
    const x = (rand() * 2 - 1) * extent;
    const y = (rand() * 2 - 1) * extent;
    const z = (rand() * 2 - 1) * extent;
    worst = Math.max(worst, Math.abs(fn(x, y, z) - ref(x, y, z)));
  }
  assert.ok(worst < 1e-9, `fast SDF must equal brute force (worst diff ${worst})`);
});

test('spiky_sphere: meshes to a closed solid bigger than its core sphere', () => {
  const doc = docWith([{ type: 'spiky_sphere', id: 'sp', params: PARAMS }], 'sp');
  const { fn, bbox } = compileNode(doc, 'sp');
  const mesh = meshSDF(fn, meshingBounds(bbox), 100);
  const sphereVol = (4 / 3) * Math.PI * PARAMS.radius ** 3;
  assert.ok(mesh.stats.triangleCount > 10000, 'plenty of triangles');
  assert.ok(mesh.stats.volume > sphereVol, 'spikes add volume beyond the core sphere');
  assert.ok(mesh.stats.volume < sphereVol * 1.5, 'volume stays in a sane range');
});

test('spiky_sphere: degenerate zero length falls back to ball bumps', () => {
  const params = { radius: 10, count: 50, length: 0, base: 1.5, tip: 0.3 };
  const doc = docWith([{ type: 'spiky_sphere', id: 'sp', params }], 'sp');
  const { fn } = compileNode(doc, 'sp');
  const [dx, dy, dz] = spikeDirs(50)[0];
  const t = 10 + 1.5; // base-ball apex
  assert.ok(Math.abs(fn(t * dx, t * dy, t * dz)) < 1e-6, 'bump apex on the surface');
  assert.ok(isFinite(fn(5, 5, 5)) && isFinite(fn(15, 0, 0)), 'no NaN from zero length');
});
