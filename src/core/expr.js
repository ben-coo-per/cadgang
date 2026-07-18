/**
 * A tiny safe arithmetic expression evaluator for user-authored param values.
 *
 * Recursive-descent parser — no eval / Function. Grammar:
 *   numbers, identifiers (variables), + - * / % , unary -/+ , parentheses,
 *   ^ (right-associative power), function calls, and the constant `pi`.
 * Functions: sin cos tan sqrt abs floor ceil round (1 arg), min max (2 args).
 *
 * evalExpr(src, vars) resolves identifiers against `vars` and returns a finite
 * number, throwing GraphError with a helpful message on any problem.
 */

import { GraphError } from './sdf.js';

const FUNCS = { sin: 1, cos: 1, tan: 1, sqrt: 1, abs: 1, floor: 1, ceil: 1, round: 1, min: 2, max: 2 };
const FN_IMPL = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan, sqrt: Math.sqrt, abs: Math.abs,
  floor: Math.floor, ceil: Math.ceil, round: Math.round, min: Math.min, max: Math.max,
};
const CONSTS = { pi: Math.PI };

/** Names a user variable may NOT take (they'd shadow a function or constant). */
export const RESERVED = new Set([...Object.keys(FUNCS), ...Object.keys(CONSTS)]);

const IDENT_CHAR = /[a-zA-Z0-9_]/;

function tokenize(src) {
  if (typeof src !== 'string') throw new GraphError('Expression must be a string');
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    if ((c >= '0' && c <= '9') || c === '.') {
      let j = i + 1;
      while (j < src.length && ((src[j] >= '0' && src[j] <= '9') || src[j] === '.')) j++;
      const text = src.slice(i, j);
      const num = Number(text);
      if (!isFinite(num)) throw new GraphError(`Invalid number '${text}' in expression '${src}'`);
      tokens.push({ type: 'num', value: num });
      i = j;
      continue;
    }
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_') {
      let j = i + 1;
      while (j < src.length && IDENT_CHAR.test(src[j])) j++;
      tokens.push({ type: 'id', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if ('+-*/%^(),'.includes(c)) { tokens.push({ type: 'op', value: c }); i++; continue; }
    throw new GraphError(`Unexpected character '${c}' in expression '${src}'`);
  }
  if (tokens.length === 0) throw new GraphError('Empty expression');
  return tokens;
}

export function evalExpr(src, vars = {}) {
  const tokens = tokenize(src);
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  const isOp = (v) => { const t = peek(); return t && t.type === 'op' && t.value === v; };

  function expect(op) {
    const t = next();
    if (!t || t.type !== 'op' || t.value !== op) throw new GraphError(`Expected '${op}' in expression '${src}'`);
  }

  function parseAdd() {
    let v = parseMul();
    while (isOp('+') || isOp('-')) {
      const op = next().value;
      const r = parseMul();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  }

  function parseMul() {
    let v = parseUnary();
    while (isOp('*') || isOp('/') || isOp('%')) {
      const op = next().value;
      const r = parseUnary();
      v = op === '*' ? v * r : op === '/' ? v / r : v % r;
    }
    return v;
  }

  function parseUnary() {
    if (isOp('-') || isOp('+')) {
      const op = next().value;
      const v = parseUnary();
      return op === '-' ? -v : v;
    }
    return parsePower();
  }

  function parsePower() {
    const base = parsePrimary();
    if (isOp('^')) {
      next();
      const exp = parseUnary(); // right-associative; exponent may itself be unary/power
      return Math.pow(base, exp);
    }
    return base;
  }

  function parsePrimary() {
    const t = peek();
    if (!t) throw new GraphError(`Unexpected end of expression '${src}'`);
    if (t.type === 'num') { next(); return t.value; }
    if (t.type === 'op' && t.value === '(') {
      next();
      const v = parseAdd();
      expect(')');
      return v;
    }
    if (t.type === 'id') {
      next();
      const name = t.value;
      if (isOp('(')) {
        next();
        const args = [];
        if (!isOp(')')) {
          args.push(parseAdd());
          while (isOp(',')) { next(); args.push(parseAdd()); }
        }
        expect(')');
        if (!(name in FUNCS)) throw new GraphError(`Unknown function '${name}' in expression '${src}'`);
        if (args.length !== FUNCS[name])
          throw new GraphError(`Function '${name}' expects ${FUNCS[name]} argument(s), got ${args.length}`);
        return FN_IMPL[name](...args);
      }
      if (name in CONSTS) return CONSTS[name];
      if (Object.prototype.hasOwnProperty.call(vars, name)) {
        const v = Number(vars[name]);
        if (!isFinite(v)) throw new GraphError(`Variable '${name}' is not a finite number`);
        return v;
      }
      throw new GraphError(`Unknown identifier '${name}' in expression '${src}'`);
    }
    throw new GraphError(`Unexpected token '${t.value}' in expression '${src}'`);
  }

  const result = parseAdd();
  if (pos !== tokens.length) throw new GraphError(`Unexpected token '${tokens[pos].value}' in expression '${src}'`);
  if (!isFinite(result)) throw new GraphError(`Expression '${src}' did not evaluate to a finite number`);
  return result;
}
