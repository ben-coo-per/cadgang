import { test } from 'node:test';
import assert from 'node:assert';
import { weldVertices, buildMeshDistance, positionsBBox } from '../src/core/mesh.js';

// Unit-test cube: 20mm cube centered at origin, 8 verts, 12 tris, outward winding.
const H = 10;
const cubePositions = Float32Array.from([
  -H, -H, -H,  H, -H, -H,  -H, H, -H,  H, H, -H,
  -H, -H, H,   H, -H, H,   -H, H, H,   H, H, H,
]);
// Faces listed +z first so tests can address the top patch as tris [0, 2).
const cubeIndices = Uint32Array.from([
  4, 5, 7,  4, 7, 6,   // +z
  0, 2, 3,  0, 3, 1,   // -z
  1, 3, 7,  1, 7, 5,   // +x
  0, 4, 6,  0, 6, 2,   // -x
  2, 6, 7,  2, 7, 3,   // +y
  0, 1, 5,  0, 5, 4,   // -y
]);

test('signed distance to a closed cube mesh', () => {
  const { distance } = buildMeshDistance(cubePositions, cubeIndices);
  assert.ok(Math.abs(distance(0, 0, 0) - -H) < 1e-5, 'center is -10');
  assert.ok(Math.abs(distance(0, 0, 15) - 5) < 1e-5, 'above top face');
  assert.ok(Math.abs(distance(15, 15, 15) - Math.sqrt(75)) < 1e-5, 'outside corner');
  assert.ok(Math.abs(distance(9, 9, 9) - -1) < 1e-5, 'inside near corner');
  assert.ok(Math.abs(distance(0, -25, 0) - 15) < 1e-5, 'outside -y face');
});

test('face patch distance is signed by patch orientation', () => {
  const patch = buildMeshDistance(cubePositions, cubeIndices, 0, 2); // +z face
  assert.ok(Math.abs(patch.normal[2] - 1) < 1e-6, 'patch normal is +z');
  assert.ok(Math.abs(patch.distance(0, 0, 15) - 5) < 1e-5, 'positive above');
  assert.ok(Math.abs(patch.distance(0, 0, 5) - -5) < 1e-5, 'negative below');
  assert.deepEqual(patch.bbox, { min: [-H, -H, H], max: [H, H, H] });
});

test('weldVertices merges per-face duplicated vertices', () => {
  // Explode the cube: 3 unique verts per triangle (36 verts), then weld.
  const pos = new Float32Array(cubeIndices.length * 3);
  const idx = new Uint32Array(cubeIndices.length);
  for (let i = 0; i < cubeIndices.length; i++) {
    pos.set(cubePositions.subarray(cubeIndices[i] * 3, cubeIndices[i] * 3 + 3), i * 3);
    idx[i] = i;
  }
  const welded = weldVertices(pos, idx, 1e-4);
  assert.equal(welded.positions.length / 3, 8, 'welds back to 8 vertices');
  assert.equal(welded.indices.length, 36);
  const { distance } = buildMeshDistance(welded.positions, welded.indices);
  assert.ok(Math.abs(distance(0, 0, 0) - -H) < 1e-5, 'welded mesh still a valid SDF');
});

test('positionsBBox', () => {
  assert.deepEqual(positionsBBox(cubePositions), { min: [-H, -H, -H], max: [H, H, H] });
});
