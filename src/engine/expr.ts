/**
 * Safe expression language for conditional rendering. A hand-written tokenizer + recursive-descent
 * parser + tree-walking evaluator: no eval, no Function, no property access outside the data scope.
 *
 *   content.discount
 *   !content.discount
 *   content.status == "Approved" && content.price > 100
 *   exists(content.badge) || len(content.tags) > 0
 */
export class ExprError extends Error {}

type Tok = { t: 'num' | 'str' | 'id' | 'op' | 'eof'; v: string | number; pos: number };

const OPS = ['&&', '||', '==', '!=', '<=', '>=', '<', '>', '!', '(', ')', ','];

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1; let s = '';
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\' && j + 1 < src.length) { j++; }
        s += src[j]; j++;
      }
      if (j >= src.length) throw new ExprError(`Unterminated string at ${i}`);
      out.push({ t: 'str', v: s, pos: i }); i = j + 1; continue;
    }
    if (/[0-9]/.test(c) || (c === '-' && /[0-9]/.test(src[i + 1] ?? '') && (out.length === 0 || out[out.length - 1].t === 'op'))) {
      const m = /^-?\d+(\.\d+)?/.exec(src.slice(i))!;
      out.push({ t: 'num', v: Number(m[0]), pos: i }); i += m[0].length; continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*/.exec(src.slice(i))!;
      out.push({ t: 'id', v: m[0], pos: i }); i += m[0].length; continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (op) { out.push({ t: 'op', v: op, pos: i }); i += op.length; continue; }
    throw new ExprError(`Unexpected character "${c}" at ${i}`);
  }
  out.push({ t: 'eof', v: '', pos: src.length });
  return out;
}

export type Ast =
  | { k: 'lit'; v: unknown }
  | { k: 'ref'; path: string }
  | { k: 'not'; a: Ast }
  | { k: 'bin'; op: string; a: Ast; b: Ast }
  | { k: 'call'; fn: string; args: Ast[] };

const FUNCS = new Set(['exists', 'empty', 'len', 'lower', 'upper', 'number']);
const WORD_OPS: Record<string, string> = { and: '&&', or: '||', not: '!', contains: 'contains' };

export function parseExpr(src: string): Ast {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const isOp = (v: string) => peek().t === 'op' && peek().v === v;
  const isWord = (w: string) => peek().t === 'id' && peek().v === w;

  function parseOr(): Ast {
    let l = parseAnd();
    while (isOp('||') || isWord('or')) { p++; l = { k: 'bin', op: '||', a: l, b: parseAnd() }; }
    return l;
  }
  function parseAnd(): Ast {
    let l = parseNot();
    while (isOp('&&') || isWord('and')) { p++; l = { k: 'bin', op: '&&', a: l, b: parseNot() }; }
    return l;
  }
  function parseNot(): Ast {
    if (isOp('!') || isWord('not')) { p++; return { k: 'not', a: parseNot() }; }
    return parseCmp();
  }
  function parseCmp(): Ast {
    const l = parsePrimary();
    const t = peek();
    if (t.t === 'op' && ['==', '!=', '<', '<=', '>', '>='].includes(t.v as string)) {
      p++; return { k: 'bin', op: t.v as string, a: l, b: parsePrimary() };
    }
    if (isWord('contains')) { p++; return { k: 'bin', op: 'contains', a: l, b: parsePrimary() }; }
    return l;
  }
  function parsePrimary(): Ast {
    const t = peek();
    if (t.t === 'num' || t.t === 'str') { p++; return { k: 'lit', v: t.v }; }
    if (t.t === 'id') {
      p++;
      const id = t.v as string;
      if (id === 'true') return { k: 'lit', v: true };
      if (id === 'false') return { k: 'lit', v: false };
      if (id === 'null') return { k: 'lit', v: null };
      if (isOp('(')) {
        if (!FUNCS.has(id)) throw new ExprError(`Unknown function "${id}"`);
        p++;
        const args: Ast[] = [];
        if (!isOp(')')) {
          args.push(parseOr());
          while (isOp(',')) { p++; args.push(parseOr()); }
        }
        if (!isOp(')')) throw new ExprError('Expected ")"');
        p++;
        return { k: 'call', fn: id, args };
      }
      if (WORD_OPS[id]) throw new ExprError(`Unexpected "${id}" at ${t.pos}`);
      return { k: 'ref', path: id };
    }
    if (isOp('(')) {
      p++;
      const e = parseOr();
      if (!isOp(')')) throw new ExprError('Expected ")"');
      p++;
      return e;
    }
    throw new ExprError(t.t === 'eof' ? 'Unexpected end of expression' : `Unexpected "${String(t.v)}" at ${t.pos}`);
  }

  if (toks.length === 1) throw new ExprError('Empty expression');
  const ast = parseOr();
  if (peek().t !== 'eof') throw new ExprError(`Unexpected "${String(peek().v)}" at ${peek().pos}`);
  return ast;
}

const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);

/** Looks a dotted path up inside the data scope. Never walks the prototype chain. */
export function lookup(scope: Record<string, unknown>, path: string): unknown {
  let cur: unknown = scope;
  for (const part of path.split('.')) {
    if (FORBIDDEN.has(part)) return undefined;
    if (cur === null || typeof cur !== 'object') return undefined;
    if (!Object.prototype.hasOwnProperty.call(cur, part)) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

export function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
}

export function isTruthy(v: unknown): boolean {
  if (isEmpty(v)) return false;
  if (v === false || v === 0 || v === '0' || v === 'false') return false;
  return true;
}

function toNum(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function toTime(v: unknown): number | null {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(v)) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

/** Three-way comparison: numbers numerically, ISO dates chronologically, otherwise as text. */
export function compareValues(a: unknown, b: unknown): number {
  const na = toNum(a), nb = toNum(b);
  if (na !== null && nb !== null) return na - nb;
  const ta = toTime(a), tb = toTime(b);
  if (ta !== null && tb !== null) return ta - tb;
  const sa = a === undefined || a === null ? '' : String(a);
  const sb = b === undefined || b === null ? '' : String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (isEmpty(a) || isEmpty(b)) return isEmpty(a) && isEmpty(b);
  return compareValues(a, b) === 0;
}

export function evalExpr(ast: Ast, scope: Record<string, unknown>): unknown {
  switch (ast.k) {
    case 'lit': return ast.v;
    case 'ref': return lookup(scope, ast.path);
    case 'not': return !isTruthy(evalExpr(ast.a, scope));
    case 'call': {
      const args = ast.args.map((a) => evalExpr(a, scope));
      const v = args[0];
      switch (ast.fn) {
        case 'exists': return !isEmpty(v);
        case 'empty': return isEmpty(v);
        case 'len': return Array.isArray(v) ? v.length : v === undefined || v === null ? 0 : String(v).length;
        case 'lower': return String(v ?? '').toLowerCase();
        case 'upper': return String(v ?? '').toUpperCase();
        case 'number': return toNum(v) ?? 0;
      }
      return undefined;
    }
    case 'bin': {
      if (ast.op === '&&') return isTruthy(evalExpr(ast.a, scope)) && isTruthy(evalExpr(ast.b, scope));
      if (ast.op === '||') return isTruthy(evalExpr(ast.a, scope)) || isTruthy(evalExpr(ast.b, scope));
      const a = evalExpr(ast.a, scope), b = evalExpr(ast.b, scope);
      switch (ast.op) {
        case '==': return valuesEqual(a, b);
        case '!=': return !valuesEqual(a, b);
        case '<': return !isEmpty(a) && compareValues(a, b) < 0;
        case '<=': return !isEmpty(a) && compareValues(a, b) <= 0;
        case '>': return !isEmpty(a) && compareValues(a, b) > 0;
        case '>=': return !isEmpty(a) && compareValues(a, b) >= 0;
        case 'contains':
          if (Array.isArray(a)) return a.some((x) => compareValues(x, b) === 0);
          return String(a ?? '').toLowerCase().includes(String(b ?? '').toLowerCase());
      }
      return undefined;
    }
  }
}

const parseCache = new Map<string, Ast | ExprError>();

/** Parses (cached) and evaluates a condition. Errors never throw: they return `error`. */
export function evalCondition(src: string, scope: Record<string, unknown>): { value: boolean; error?: string } {
  let ast = parseCache.get(src);
  if (!ast) {
    try { ast = parseExpr(src); } catch (e) { ast = e instanceof ExprError ? e : new ExprError(String(e)); }
    if (parseCache.size > 500) parseCache.clear();
    parseCache.set(src, ast);
  }
  if (ast instanceof ExprError) return { value: true, error: ast.message };
  return { value: isTruthy(evalExpr(ast, scope)) };
}

/** Returns an error message when the expression is invalid, otherwise null. */
export function validateExpr(src: string): string | null {
  try { parseExpr(src); return null; } catch (e) { return e instanceof Error ? e.message : String(e); }
}
