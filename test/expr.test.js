import { test } from 'node:test';
import assert from 'node:assert';
import { evalExpr, RESERVED } from '../src/core/expr.js';
import { GraphError } from '../src/core/sdf.js';

test('basic arithmetic and precedence', () => {
  assert.strictEqual(evalExpr('1+2*3'), 7);
  assert.strictEqual(evalExpr('(1+2)*3'), 9);
  assert.strictEqual(evalExpr('10 - 4 - 3'), 3); // left-assoc
  assert.strictEqual(evalExpr('10 % 3'), 1);
  assert.strictEqual(evalExpr('2 * 3 + 4 * 5'), 26);
});

test('unary minus binds looser than power', () => {
  assert.strictEqual(evalExpr('-2^2'), -4);
  assert.strictEqual(evalExpr('-(2^2)'), -4);
  assert.strictEqual(evalExpr('(-2)^2'), 4);
  assert.strictEqual(evalExpr('--3'), 3);
  assert.strictEqual(evalExpr('3 * -2'), -6);
});

test('power is right-associative and takes unary exponents', () => {
  assert.strictEqual(evalExpr('2^3^2'), 512); // 2^(3^2)
  assert.strictEqual(evalExpr('2^-1'), 0.5);
  assert.strictEqual(evalExpr('9^0.5'), 3);
});

test('functions and constants', () => {
  assert.strictEqual(evalExpr('sqrt(16)'), 4);
  assert.strictEqual(evalExpr('abs(-7)'), 7);
  assert.strictEqual(evalExpr('floor(2.9)'), 2);
  assert.strictEqual(evalExpr('ceil(2.1)'), 3);
  assert.strictEqual(evalExpr('round(2.5)'), 3);
  assert.strictEqual(evalExpr('min(3, 5)'), 3);
  assert.strictEqual(evalExpr('max(3, 5)'), 5);
  assert.ok(Math.abs(evalExpr('sin(0)')) < 1e-12);
  assert.ok(Math.abs(evalExpr('pi') - Math.PI) < 1e-12);
  assert.ok(Math.abs(evalExpr('2*pi') - 2 * Math.PI) < 1e-12);
});

test('variables resolve from the vars map', () => {
  assert.strictEqual(evalExpr('w + 1', { w: 5 }), 6);
  assert.strictEqual(evalExpr('w / 2', { w: 30 }), 15);
  assert.strictEqual(evalExpr('max(w, h)', { w: 3, h: 8 }), 8);
});

test('errors: unknown identifier, unknown function, bad arity', () => {
  assert.throws(() => evalExpr('foo + 1'), /Unknown identifier 'foo'/);
  assert.throws(() => evalExpr('bar(1)'), /Unknown function 'bar'/);
  assert.throws(() => evalExpr('min(1)'), /expects 2 argument/);
  assert.throws(() => evalExpr('sqrt(1, 2)'), /expects 1 argument/);
});

test('errors: syntax and non-finite results throw GraphError', () => {
  assert.throws(() => evalExpr('1 2'), GraphError);
  assert.throws(() => evalExpr('(1 + 2'), GraphError);
  assert.throws(() => evalExpr('1 +'), GraphError);
  assert.throws(() => evalExpr(''), GraphError);
  assert.throws(() => evalExpr('1/0'), /finite/);
  assert.throws(() => evalExpr('1 & 2'), /Unexpected character/);
});

test('RESERVED covers every function and constant name', () => {
  for (const n of ['sin', 'cos', 'tan', 'sqrt', 'abs', 'floor', 'ceil', 'round', 'min', 'max', 'pi']) {
    assert.ok(RESERVED.has(n), `${n} should be reserved`);
  }
});
