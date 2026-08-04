/**
 * The v2 thesis, under test: a reference written as a QUERY must keep meaning
 * the same thing when the part changes, and must fail loudly rather than
 * quietly select the wrong entities.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { initBrep, beginBrepScope } from '../src/core/brep.js';
import { q, topology } from '../src/core/query.js';
import * as brep from '../src/core/ops.js';
import { GraphError } from '../src/core/errors.js';

await initBrep();

/** Run a body inside a shape scope so OCCT intermediates are freed. */
function inScope(fn) {
  const scope = beginBrepScope();
  try {
    return fn();
  } finally {
    scope.dispose();
  }
}

test('a box has the topology a box should have', () => {
  inScope(() => {
    const t = topology(brep.box(60, 40, 24));
    assert.equal(t.counts.faces, 6);
    assert.equal(t.counts.edges, 12);
    assert.ok(t.faces.every((f) => f.kind === 'PLANE'));
    assert.ok(t.edges.every((e) => e.kind === 'LINE'));
    // Every descriptor carries what a query would need to filter on.
    for (const f of t.faces) {
      assert.ok(Number.isFinite(f.area) && f.area > 0);
      assert.equal(f.normal.length, 3);
    }
  });
});

test('vertical edges are four, at any size', () => {
  inScope(() => {
    for (const [w, d, h] of [[60, 40, 24], [80, 40, 24], [12, 12, 200]]) {
      const s = brep.box(w, d, h);
      const verticals = q.edges(s).linear().along('z');
      assert.equal(verticals.count(), 4, `w=${w} d=${d} h=${h}`);
      // ...and they are the ones of the box's height, not some other four.
      assert.ok(verticals.all().every((e) => Math.abs(e.length - h) < 1e-6));
    }
  });
});

test('facing() distinguishes top from bottom', () => {
  inScope(() => {
    const s = brep.box(60, 40, 24);
    assert.equal(q.faces(s).planar().facing('+z').count(), 1);
    assert.equal(q.faces(s).planar().facing('-z').count(), 1);
    // A bare axis means "either way along it".
    assert.equal(q.faces(s).planar().facing('z').count(), 2);

    const top = q.faces(s).planar().facing('+z').one();
    const bottom = q.faces(s).planar().facing('-z').one();
    assert.ok(top.center[2] > bottom.center[2]);
  });
});

test('atExtreme picks the topmost face', () => {
  inScope(() => {
    // A stepped block: two upward faces at different heights.
    const s = brep.union(brep.box(60, 40, 20), brep.box(20, 20, 40));
    const up = q.faces(s).planar().facing('+z');
    assert.ok(up.count() >= 2, 'the step should expose more than one upward face');
    assert.equal(up.atExtreme('+z').count(), 1);
    assert.ok(Math.abs(up.atExtreme('+z').one().center[2] - 40) < 1e-6);
  });
});

test('a query drives a real fillet, and only the edges it names', () => {
  inScope(() => {
    const plain = brep.box(60, 40, 24);
    const rounded = brep.fillet(plain, q.edges(plain).linear().along('z'), 3);

    // Four square corners became four cylindrical faces.
    assert.equal(q.faces(rounded).cylindrical().count(), 4);
    // The top and bottom faces survive as planes; the four walls do too.
    assert.equal(q.faces(rounded).planar().facing('+z').count(), 1);
    // Rounding removes material.
    assert.ok(brep.volume(rounded) < brep.volume(plain));
  });
});

test('the same query fillets correctly after the part is resized', () => {
  inScope(() => {
    // The point of the whole module: one expression, two different parts.
    const build = (w, d, h) => {
      const s = brep.box(w, d, h);
      return brep.fillet(s, q.edges(s).linear().along('z'), 3);
    };
    for (const dims of [[60, 40, 24], [120, 90, 8]]) {
      const r = build(...dims);
      assert.equal(q.faces(r).cylindrical().count(), 4, `dims ${dims}`);
    }
  });
});

test('a query drives shell, opening the face it names', () => {
  inScope(() => {
    const s = brep.box(60, 40, 24);
    const hollow = brep.shell(s, q.faces(s).planar().facing('+z'), -2);
    assert.ok(brep.volume(hollow) < brep.volume(s) * 0.5, 'shelling should remove most of the volume');
    // An open box has an inner wall set as well as an outer one.
    assert.ok(q.faces(hollow).planar().count() > 6);
  });
});

test('holes are findable by radius', () => {
  inScope(() => {
    const plate = brep.box(60, 40, 5);
    const drill = (r, x) => brep.translate(brep.cylinder(r, 20), [x, 0, -5]);
    const drilled = brep.subtract(plate, drill(3, -15), drill(5, 15));

    assert.equal(q.faces(drilled).cylindrical().count(), 2);
    assert.equal(q.faces(drilled).cylindrical().ofRadius(3).count(), 1);
    assert.equal(q.faces(drilled).cylindrical().ofDiameter(10).count(), 1);
    // The 5mm hole is the one on the +X side.
    const big = q.faces(drilled).cylindrical().ofRadius(5).one();
    assert.ok(big.center[0] > 0);
  });
});

test('expect() fails the operation instead of shipping wrong geometry', () => {
  inScope(() => {
    const s = brep.box(60, 40, 24);
    // Correct expectation passes through and stays chainable.
    assert.equal(q.edges(s).linear().along('z').expect(4).count(), 4);

    assert.throws(
      () => q.edges(s).linear().along('z').expect(8),
      (e) => e instanceof GraphError && /matched 4 edges, expected 8/.test(e.message)
    );
    // The error says what it actually found, so a model can correct itself.
    try {
      q.edges(s).linear().along('z').expect(8);
    } catch (e) {
      assert.match(e.message, /LINE \(len 24\)/);
    }
  });
});

test('an empty match is refused, not silently applied', () => {
  inScope(() => {
    const s = brep.box(60, 40, 24);
    assert.throws(
      () => brep.fillet(s, q.edges(s).circular(), 3),
      (e) => e instanceof GraphError && /matched no edges/.test(e.message)
    );
  });
});

test('one() names the ambiguity it refuses to resolve', () => {
  inScope(() => {
    const s = brep.box(60, 40, 24);
    assert.throws(
      () => q.faces(s).planar().one(),
      (e) => e instanceof GraphError && /matched 6 faces, expected exactly 1/.test(e.message)
    );
  });
});

test('exclude and either compose', () => {
  inScope(() => {
    const s = brep.box(60, 40, 24);
    // Every edge except the vertical ones: the two horizontal rims, 8 edges.
    assert.equal(q.edges(s).exclude((e) => e.along('z')).count(), 8);
    // Vertical edges or the top rim: 4 + 4.
    const combined = q.edges(s).either(
      (e) => e.along('z'),
      (e) => e.along('x').atExtreme('+z')
    );
    assert.equal(combined.count(), 6);
  });
});

test('where() sees exactly what topology() reports', () => {
  inScope(() => {
    const s = brep.box(60, 40, 24);
    const reported = topology(s).faces.find((f) => f.normal[2] > 0.99);
    const matched = q.faces(s).where((f) => f.anchor === reported.anchor).all();
    assert.equal(matched.length, 1);
    assert.deepEqual(matched[0], reported);
  });
});

test('anchors are stable across rebuilds and distinct between entities', () => {
  inScope(() => {
    const a = topology(brep.box(60, 40, 24)).faces.map((f) => f.anchor);
    const b = topology(brep.box(60, 40, 24)).faces.map((f) => f.anchor);
    assert.deepEqual(a.slice().sort(), b.slice().sort());
    assert.equal(new Set(a).size, 6, 'six faces should have six distinct anchors');
  });
});
