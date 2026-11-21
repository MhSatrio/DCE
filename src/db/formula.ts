import type { ContentRecord, FieldDef } from './schema';

/** The stored value of a cell (the table's own data, or the record's built-in field). */
const storedValue = (rec: ContentRecord, key: string): unknown => (rec.data && key in rec.data ? rec.data[key] : (rec as unknown as Record<string, unknown>)[key]);

/**
 * Formulas like a spreadsheet's, pure (no DOM, no database). A cell whose text starts with "=" is a formula:
 *   =[Price]*[Qty]        a column of the same row, by its name
 *   =B3*2                 a cell by address: column letter (A = the first field, in field order) and row (1 = the first row,
 *                         in creation order)
 *   =SUM(A1:A10)          a range; also AVERAGE, MIN, MAX, COUNT, COUNTA, IF, IFERROR, AND, OR, NOT, ROUND, ABS, …
 * Operators: + - * / ^ & % and the comparisons = <> < > <= >=. Text in "double quotes". Errors look like a spreadsheet's:
 * #DIV/0!, #VALUE!, #REF!, #NAME?, #NUM!, #CIRC! (a formula that refers to itself).
 */

export class FormulaErr {
  constructor(readonly code: string, readonly message = '') {}
  toString(): string { return this.code; }
}
export type Val = number | string | boolean | null | FormulaErr | Val[];

class FormulaSyntax extends Error {}

// ------------------------------------------------------------------------------------------------ reading the text

type Tok =
  | { t: 'num'; v: number } | { t: 'str'; v: string } | { t: 'bool'; v: boolean }
  | { t: 'field'; name: string }
  | { t: 'cell'; col: number; row: number; c2?: number; r2?: number }
  | { t: 'fn'; name: string } | { t: 'op'; v: string } | { t: 'lp' } | { t: 'rp' } | { t: 'comma' };

/** Column letters → index: A = 0, Z = 25, AA = 26. */
export function colIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}
/** Index → column letters: 0 = A, 26 = AA. */
export function colLetters(index: number): string {
  let s = '', n = index + 1;
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

export function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  const s = src;
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '"') {
      let j = i + 1, v = '';
      for (;;) {
        if (j >= s.length) throw new FormulaSyntax('A text is missing its closing quote (").');
        if (s[j] === '"') { if (s[j + 1] === '"') { v += '"'; j += 2; continue; } break; }
        v += s[j++];
      }
      out.push({ t: 'str', v }); i = j + 1; continue;
    }
    if (ch === '[') {
      const j = s.indexOf(']', i);
      if (j < 0) throw new FormulaSyntax('A [field name] is missing its closing ].');
      out.push({ t: 'field', name: s.slice(i + 1, j).trim() }); i = j + 1; continue;
    }
    const num = /^(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?/.exec(s.slice(i));
    if (num) { out.push({ t: 'num', v: Number(num[0]) }); i += num[0].length; continue; }
    // a cell address (A1, $B$2) before a name: a name followed by "(" is a function, never a cell
    const addr = /^\$?[A-Za-z]{1,3}\$?\d+(?![A-Za-z0-9_.(])/.exec(s.slice(i));
    const id = addr ?? /^\$?[A-Za-z_][A-Za-z0-9_.]*/.exec(s.slice(i));
    if (id) {
      const text = id[0];
      const after = s.slice(i + text.length);
      if (!addr && /^\s*\(/.test(after)) { out.push({ t: 'fn', name: text.toUpperCase() }); i += text.length; continue; }
      const cell = /^\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(text);
      if (cell) {
        const col = colIndex(cell[1]), row = Number(cell[2]);
        if (row < 1) throw new FormulaSyntax(`${text} is not a cell: rows start at 1.`);
        const rng = /^\s*:\s*\$?([A-Za-z]{1,3})\$?(\d+)/.exec(after);
        if (rng) { out.push({ t: 'cell', col, row, c2: colIndex(rng[1]), r2: Number(rng[2]) }); i += text.length + rng[0].length; continue; }
        out.push({ t: 'cell', col, row }); i += text.length; continue;
      }
      const up = text.toUpperCase();
      if (up === 'TRUE' || up === 'FALSE') { out.push({ t: 'bool', v: up === 'TRUE' }); i += text.length; continue; }
      throw new FormulaSyntax(`“${text}” is not a cell address, a [field name] or a function.`);
    }
    const two = s.slice(i, i + 2);
    if (two === '<>' || two === '<=' || two === '>=') { out.push({ t: 'op', v: two }); i += 2; continue; }
    if ('+-*/^&=<>%'.includes(ch)) { out.push({ t: 'op', v: ch }); i++; continue; }
    if (ch === '(') { out.push({ t: 'lp' }); i++; continue; }
    if (ch === ')') { out.push({ t: 'rp' }); i++; continue; }
    if (ch === ',' || ch === ';') { out.push({ t: 'comma' }); i++; continue; }
    throw new FormulaSyntax(`“${ch}” is not expected here.`);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ the tree

export type Node =
  | { k: 'lit'; v: number | string | boolean }
  | { k: 'field'; name: string }
  | { k: 'cell'; col: number; row: number }
  | { k: 'range'; c1: number; r1: number; c2: number; r2: number }
  | { k: 'neg'; a: Node } | { k: 'pct'; a: Node }
  | { k: 'bin'; op: string; a: Node; b: Node }
  | { k: 'fn'; name: string; args: Node[] };

/** Parses a formula (the text without the leading "="). Operator precedence follows a spreadsheet's. */
export function parseFormula(text: string): Node {
  const toks = tokenize(text);
  let p = 0;
  const peek = () => toks[p];
  const isOp = (...vs: string[]) => { const t = toks[p]; return !!t && t.t === 'op' && vs.includes(t.v); };

  const primary = (): Node => {
    const t = toks[p++];
    if (!t) throw new FormulaSyntax('The formula ends too early.');
    switch (t.t) {
      case 'num': return { k: 'lit', v: t.v };
      case 'str': return { k: 'lit', v: t.v };
      case 'bool': return { k: 'lit', v: t.v };
      case 'field': return { k: 'field', name: t.name };
      case 'cell': return t.c2 !== undefined && t.r2 !== undefined ? { k: 'range', c1: t.col, r1: t.row, c2: t.c2, r2: t.r2 } : { k: 'cell', col: t.col, row: t.row };
      case 'lp': { const e = expr(); if (!peek() || peek().t !== 'rp') throw new FormulaSyntax('A “(” is missing its “)”.'); p++; return e; }
      case 'fn': {
        if (!peek() || peek().t !== 'lp') throw new FormulaSyntax(`${t.name} needs “(”.`);
        p++;
        const args: Node[] = [];
        if (peek() && peek().t === 'rp') { p++; return { k: 'fn', name: t.name, args }; }
        for (;;) {
          args.push(expr());
          const n = toks[p++];
          if (n && n.t === 'rp') break;
          if (!n || n.t !== 'comma') throw new FormulaSyntax(`${t.name}: the arguments are separated by “,” and closed by “)”.`);
        }
        return { k: 'fn', name: t.name, args };
      }
      default: throw new FormulaSyntax('A value is missing here.');
    }
  };
  const postfix = (): Node => { let a = primary(); while (isOp('%')) { p++; a = { k: 'pct', a }; } return a; };
  // a sign binds tighter than ^ (as in a spreadsheet: =-2^2 is 4)
  const signed = (): Node => { if (isOp('-', '+')) { const op = toks[p++] as { v: string }; const a = signed(); return op.v === '-' ? { k: 'neg', a } : a; } return postfix(); };
  const power = (): Node => { let a = signed(); while (isOp('^')) { p++; a = { k: 'bin', op: '^', a, b: signed() }; } return a; };
  const unary = (): Node => power();
  const term = (): Node => { let a = unary(); while (isOp('*', '/')) { const op = (toks[p++] as { v: string }).v; a = { k: 'bin', op, a, b: unary() }; } return a; };
  const sum = (): Node => { let a = term(); while (isOp('+', '-')) { const op = (toks[p++] as { v: string }).v; a = { k: 'bin', op, a, b: term() }; } return a; };
  const concat = (): Node => { let a = sum(); while (isOp('&')) { p++; a = { k: 'bin', op: '&', a, b: sum() }; } return a; };
  const compare = (): Node => { let a = concat(); while (isOp('=', '<>', '<', '>', '<=', '>=')) { const op = (toks[p++] as { v: string }).v; a = { k: 'bin', op, a, b: concat() }; } return a; };
  const expr = (): Node => compare();

  const tree = expr();
  if (p < toks.length) throw new FormulaSyntax('The formula has something after its end.');
  return tree;
}

// ------------------------------------------------------------------------------------------------ evaluating

/** What a formula can read: a column of the same row, or any cell by address. */
export interface Sheet {
  field(name: string): Val;
  cell(col: number, row: number): Val;
}

const isErr = (v: Val): v is FormulaErr => v instanceof FormulaErr;
const err = (code: string, message = '') => new FormulaErr(code, message);

/** A value as a number, the way a spreadsheet counts it (blank is 0, TRUE is 1, a numeric text counts). */
export function toNum(v: Val): number | FormulaErr {
  if (isErr(v)) return v;
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v === null || v === '') return 0;
  if (typeof v === 'string') { const n = Number(v.trim().replace(/,(?=\d{3}\b)/g, '')); return v.trim() !== '' && Number.isFinite(n) ? n : err('#VALUE!', `“${v}” is text, not a number.`); }
  return err('#VALUE!', 'A range is used where one value is needed.');
}

/** A value as text. */
export function toText(v: Val): string | FormulaErr {
  if (isErr(v)) return v;
  if (typeof v === 'number') return numberText(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (v === null) return '';
  if (typeof v === 'string') return v;
  return err('#VALUE!', 'A range is used where one value is needed.');
}

/** A number as a spreadsheet shows it in a general format (no grouping, at most 12 significant digits). */
export function numberText(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return String(Number(n.toPrecision(12)));
}

/** The values of one argument, flattened: a range gives all its cells. */
function flat(v: Val): Val[] { return Array.isArray(v) ? v.flatMap(flat) : [v]; }

function compareValues(a: Val, b: Val): number | FormulaErr {
  if (isErr(a)) return a;
  if (isErr(b)) return b;
  const na = typeof a === 'number' || typeof a === 'boolean' ? toNum(a) : null;
  const nb = typeof b === 'number' || typeof b === 'boolean' ? toNum(b) : null;
  if (na !== null && nb !== null && !isErr(na) && !isErr(nb)) return na - nb;
  const sa = a === null ? '' : String(a).toLowerCase(), sb = b === null ? '' : String(b).toLowerCase();
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function binary(op: string, a: Val, b: Val): Val {
  if (isErr(a)) return a;
  if (isErr(b)) return b;
  switch (op) {
    case '+': case '-': case '*': case '/': case '^': {
      const x = toNum(a), y = toNum(b);
      if (isErr(x)) return x;
      if (isErr(y)) return y;
      if (op === '+') return x + y;
      if (op === '-') return x - y;
      if (op === '*') return x * y;
      if (op === '/') return y === 0 ? err('#DIV/0!', 'Division by zero.') : x / y;
      const r = Math.pow(x, y);
      return Number.isFinite(r) ? r : err('#NUM!', 'The result is not a number.');
    }
    case '&': { const x = toText(a), y = toText(b); if (isErr(x)) return x; if (isErr(y)) return y; return x + y; }
    case '=': { const c = compareValues(a, b); return isErr(c) ? c : c === 0; }
    case '<>': { const c = compareValues(a, b); return isErr(c) ? c : c !== 0; }
    case '<': { const c = compareValues(a, b); return isErr(c) ? c : c < 0; }
    case '>': { const c = compareValues(a, b); return isErr(c) ? c : c > 0; }
    case '<=': { const c = compareValues(a, b); return isErr(c) ? c : c <= 0; }
    case '>=': { const c = compareValues(a, b); return isErr(c) ? c : c >= 0; }
  }
  return err('#NAME?', `Unknown operator ${op}.`);
}

/** Numbers among the values of the arguments (text and blanks are left out; an error is passed on). */
function numbersOf(args: Val[]): number[] | FormulaErr {
  const out: number[] = [];
  for (const a of args) for (const v of flat(a)) {
    if (isErr(v)) return v;
    if (typeof v === 'number') out.push(v);
  }
  return out;
}

/** Rounds half away from zero, as a spreadsheet does (2.5 → 3, -2.5 → -3), and corrects binary noise (1.005 → 1.01 at 2 decimals). */
function roundHalfAway(v: number): number {
  return Math.sign(v) * Math.round(Number(Math.abs(v).toPrecision(15)));
}

const FUNCS: Record<string, (args: Node[], sheet: Sheet, ev: (n: Node) => Val) => Val> = {
  SUM: (a, s, ev) => { const n = numbersOf(a.map(ev)); return isErr(n) ? n : n.reduce((x, y) => x + y, 0); },
  AVERAGE: (a, s, ev) => { const n = numbersOf(a.map(ev)); if (isErr(n)) return n; return n.length ? n.reduce((x, y) => x + y, 0) / n.length : err('#DIV/0!', 'No numbers to average.'); },
  MIN: (a, s, ev) => { const n = numbersOf(a.map(ev)); return isErr(n) ? n : n.length ? Math.min(...n) : 0; },
  MAX: (a, s, ev) => { const n = numbersOf(a.map(ev)); return isErr(n) ? n : n.length ? Math.max(...n) : 0; },
  COUNT: (a, s, ev) => { const n = numbersOf(a.map(ev)); return isErr(n) ? 0 : n.length; },
  COUNTA: (a, s, ev) => a.flatMap((x) => flat(ev(x))).filter((v) => v !== null && v !== '').length,
  ROUND: (a, s, ev) => { const x = toNum(ev(a[0])), d = a[1] ? toNum(ev(a[1])) : 0; if (isErr(x)) return x; if (isErr(d)) return d; const f = Math.pow(10, Math.trunc(d)); return roundHalfAway(x * f) / f; },
  ROUNDUP: (a, s, ev) => { const x = toNum(ev(a[0])), d = a[1] ? toNum(ev(a[1])) : 0; if (isErr(x)) return x; if (isErr(d)) return d; const f = Math.pow(10, Math.trunc(d)); return Math.sign(x) * Math.ceil(Math.abs(x) * f) / f; },
  ROUNDDOWN: (a, s, ev) => { const x = toNum(ev(a[0])), d = a[1] ? toNum(ev(a[1])) : 0; if (isErr(x)) return x; if (isErr(d)) return d; const f = Math.pow(10, Math.trunc(d)); return Math.sign(x) * Math.floor(Math.abs(x) * f) / f; },
  ABS: (a, s, ev) => { const x = toNum(ev(a[0])); return isErr(x) ? x : Math.abs(x); },
  INT: (a, s, ev) => { const x = toNum(ev(a[0])); return isErr(x) ? x : Math.floor(x); },
  SQRT: (a, s, ev) => { const x = toNum(ev(a[0])); if (isErr(x)) return x; return x < 0 ? err('#NUM!', 'A negative number has no square root.') : Math.sqrt(x); },
  POWER: (a, s, ev) => binary('^', ev(a[0]), ev(a[1])),
  MOD: (a, s, ev) => { const x = toNum(ev(a[0])), y = toNum(ev(a[1])); if (isErr(x)) return x; if (isErr(y)) return y; return y === 0 ? err('#DIV/0!', 'Division by zero.') : x - y * Math.floor(x / y); },
  PI: () => Math.PI,
  IF: (a, s, ev) => {
    const c = ev(a[0]);
    if (isErr(c)) return c;
    const yes: boolean | FormulaErr = typeof c === 'string' ? c !== '' : (() => { const n = toNum(c); return isErr(n) ? n : n !== 0; })();
    if (isErr(yes)) return yes;
    return yes ? (a[1] ? ev(a[1]) : true) : (a[2] ? ev(a[2]) : false);
  },
  IFERROR: (a, s, ev) => { const v = ev(a[0]); return isErr(v) ? ev(a[1]) : v; },
  AND: (a, s, ev) => { let r = true; for (const x of a) for (const v of flat(ev(x))) { if (isErr(v)) return v; if (v !== null && v !== '') { const n = toNum(v); if (isErr(n)) return n; if (n === 0) r = false; } } return r; },
  OR: (a, s, ev) => { let r = false; for (const x of a) for (const v of flat(ev(x))) { if (isErr(v)) return v; if (v !== null && v !== '') { const n = toNum(v); if (isErr(n)) return n; if (n !== 0) r = true; } } return r; },
  NOT: (a, s, ev) => { const n = toNum(ev(a[0])); return isErr(n) ? n : n === 0; },
  ISBLANK: (a, s, ev) => { const v = ev(a[0]); return v === null || v === ''; },
  ISNUMBER: (a, s, ev) => typeof ev(a[0]) === 'number',
  CONCATENATE: (a, s, ev) => { let out = ''; for (const x of a) for (const v of flat(ev(x))) { const t = toText(v); if (isErr(t)) return t; out += t; } return out; },
  LEN: (a, s, ev) => { const t = toText(ev(a[0])); return isErr(t) ? t : t.length; },
  UPPER: (a, s, ev) => { const t = toText(ev(a[0])); return isErr(t) ? t : t.toUpperCase(); },
  LOWER: (a, s, ev) => { const t = toText(ev(a[0])); return isErr(t) ? t : t.toLowerCase(); },
  TRIM: (a, s, ev) => { const t = toText(ev(a[0])); return isErr(t) ? t : t.trim().replace(/\s+/g, ' '); },
  LEFT: (a, s, ev) => { const t = toText(ev(a[0])), n = a[1] ? toNum(ev(a[1])) : 1; if (isErr(t)) return t; if (isErr(n)) return n; return t.slice(0, Math.max(0, Math.trunc(n))); },
  RIGHT: (a, s, ev) => { const t = toText(ev(a[0])), n = a[1] ? toNum(ev(a[1])) : 1; if (isErr(t)) return t; if (isErr(n)) return n; const k = Math.max(0, Math.trunc(n)); return k === 0 ? '' : t.slice(-k); },
  MID: (a, s, ev) => { const t = toText(ev(a[0])), st = toNum(ev(a[1])), n = toNum(ev(a[2])); if (isErr(t)) return t; if (isErr(st)) return st; if (isErr(n)) return n; return t.substr(Math.max(0, Math.trunc(st) - 1), Math.max(0, Math.trunc(n))); },
  VALUE: (a, s, ev) => toNum(ev(a[0])),
};

export function evaluate(n: Node, sheet: Sheet): Val {
  switch (n.k) {
    case 'lit': return n.v;
    case 'field': return sheet.field(n.name);
    case 'cell': return sheet.cell(n.col, n.row);
    case 'range': {
      const out: Val[] = [];
      for (let r = n.r1; r <= n.r2; r++) for (let c = n.c1; c <= n.c2; c++) out.push(sheet.cell(c, r));
      return out;
    }
    case 'neg': { const v = toNum(evaluate(n.a, sheet)); return isErr(v) ? v : -v; }
    case 'pct': { const v = toNum(evaluate(n.a, sheet)); return isErr(v) ? v : v / 100; }
    case 'bin': return binary(n.op, evaluate(n.a, sheet), evaluate(n.b, sheet));
    case 'fn': {
      const f = FUNCS[n.name];
      if (!f) return err('#NAME?', `There is no function ${n.name}.`);
      const r = f(n.args, sheet, (x) => evaluate(x, sheet));
      if (typeof r === 'number' && !Number.isFinite(r)) return err('#NUM!', 'The result is too large or not a number.');
      return r;
    }
  }
}

/** The names of the functions the formula editor offers, with their use (for the help list). */
export const FUNCTION_HELP: { name: string; use: string }[] = [
  { name: 'SUM', use: 'SUM(A1:A10) — adds the numbers' },
  { name: 'AVERAGE', use: 'AVERAGE(A1:A10) — the mean of the numbers' },
  { name: 'MIN', use: 'MIN(A1:A10)' },
  { name: 'MAX', use: 'MAX(A1:A10)' },
  { name: 'COUNT', use: 'COUNT(A1:A10) — how many numbers' },
  { name: 'COUNTA', use: 'COUNTA(A1:A10) — how many cells are not empty' },
  { name: 'ROUND', use: 'ROUND(x, 2) — rounds to 2 decimals' },
  { name: 'ROUNDUP', use: 'ROUNDUP(x, 0)' },
  { name: 'ROUNDDOWN', use: 'ROUNDDOWN(x, 0)' },
  { name: 'ABS', use: 'ABS(x)' },
  { name: 'INT', use: 'INT(x) — rounds down to a whole number' },
  { name: 'SQRT', use: 'SQRT(x)' },
  { name: 'POWER', use: 'POWER(x, y) — x to the power y' },
  { name: 'MOD', use: 'MOD(x, y) — the remainder' },
  { name: 'IF', use: 'IF(test, when true, when false)' },
  { name: 'IFERROR', use: 'IFERROR(value, when it is an error)' },
  { name: 'AND', use: 'AND(test1, test2)' },
  { name: 'OR', use: 'OR(test1, test2)' },
  { name: 'NOT', use: 'NOT(test)' },
  { name: 'CONCATENATE', use: 'CONCATENATE(a, b) — joins texts (or use a & b)' },
  { name: 'LEN', use: 'LEN(text)' },
  { name: 'UPPER', use: 'UPPER(text)' },
  { name: 'LOWER', use: 'LOWER(text)' },
  { name: 'TRIM', use: 'TRIM(text)' },
  { name: 'LEFT', use: 'LEFT(text, 3)' },
  { name: 'RIGHT', use: 'RIGHT(text, 3)' },
  { name: 'MID', use: 'MID(text, start, count)' },
  { name: 'VALUE', use: 'VALUE(text) — the number in a text' },
  { name: 'PI', use: 'PI()' },
];

/** The formula's value on its own (no table): handy for a preview of a formula that has no cell references. */
export function evaluateText(text: string, sheet: Sheet): Val {
  const body = text.trim().startsWith('=') ? text.trim().slice(1) : text;
  try {
    return evaluate(parseFormula(body), sheet);
  } catch (e) {
    return err('#FORMULA!', e instanceof Error ? e.message : String(e));
  }
}

// ------------------------------------------------------------------------------------------------ a table

export const isFormulaText = (v: unknown): v is string => typeof v === 'string' && v.trim().startsWith('=');

/** A cell that is calculated: a Formula field, or any cell (number, currency, …) whose content is formula text. */
export const isFormulaCell = (type: string, raw: unknown): boolean => type === 'formula' || isFormulaText(raw);

/**
 * Evaluates the cells of one table. A cell's value is its formula's result, or its content when it is not a formula.
 * Values are computed once and kept (memo); a formula that refers to itself gives #CIRC!.
 */
export class TableEvaluator {
  private byId = new Map<string, ContentRecord>();
  private rowOf = new Map<string, number>();
  private byRow: ContentRecord[] = [];
  private colKeys: string[];
  private nameKey = new Map<string, string>();
  private memo = new Map<string, Val>();
  private busy = new Set<string>();

  constructor(fields: FieldDef[], records: ContentRecord[], private readonly rawOf: (rec: ContentRecord, key: string) => unknown = storedValue) {
    const ordered = [...fields];
    this.colKeys = ordered.map((f) => f.key);
    for (const f of ordered) { this.nameKey.set(f.label.trim().toLowerCase(), f.key); this.nameKey.set(f.key.toLowerCase(), f.key); }
    this.byRow = [...records].sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
    this.byRow.forEach((r, i) => { this.byId.set(r.id, r); this.rowOf.set(r.id, i + 1); });
  }

  /** The row number (1-based) of a record, as the cell addresses show it. */
  rowNumber(recordId: string): number | undefined { return this.rowOf.get(recordId); }

  /** The value of a cell, as a formula sees it. */
  valueOf(recordId: string, key: string): Val {
    const rec = this.byId.get(recordId);
    if (!rec) return null;
    const k = `${recordId}|${key}`;
    if (this.memo.has(k)) return this.memo.get(k)!;
    const raw = this.rawOf(rec, key);
    let out: Val;
    if (isFormulaText(raw)) {
      if (this.busy.has(k)) return new FormulaErr('#CIRC!', 'A formula refers to itself.');
      this.busy.add(k);
      try {
        out = evaluateText(raw, this.sheetFor(recordId));
      } finally { this.busy.delete(k); }
    } else if (raw === undefined || raw === null) out = null;
    else if (typeof raw === 'number' || typeof raw === 'boolean') out = raw;
    else out = String(raw);
    this.memo.set(k, out);
    return out;
  }

  /** The text a cell shows: formulas as their results, numbers as numbers, errors as their code. */
  textOf(recordId: string, key: string): string {
    const v = this.valueOf(recordId, key);
    if (isErr(v)) return v.code;
    if (v === null) return '';
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    if (typeof v === 'number') return numberText(v);
    if (Array.isArray(v)) return '';
    return v;
  }

  /** The value that formula text would give in a record (the text is not stored; used by the formula editor's preview). */
  evaluateFor(recordId: string, text: string): Val {
    return evaluateText(text, this.sheetFor(recordId));
  }

  /** The row number a cell address would name (for the editor's help): the record at that row, if any. */
  recordAt(row: number): ContentRecord | undefined { return this.byRow[row - 1]; }

  private sheetFor(recordId: string): Sheet {
    return {
      field: (name: string) => {
        const key = this.nameKey.get(name.trim().toLowerCase());
        if (!key) return new FormulaErr('#NAME?', `There is no column “${name}”.`);
        return this.valueOf(recordId, key);
      },
      cell: (col: number, row: number) => {
        const key = this.colKeys[col];
        if (key === undefined) return new FormulaErr('#REF!', 'The column is not in this table.');
        const rec = this.byRow[row - 1];
        if (!rec) return null;
        return this.valueOf(rec.id, key);
      },
    };
  }
}

/** Parses a formula cell without evaluating it (to check what the editor types). Returns the syntax message or null. */
export function syntaxProblem(text: string): string | null {
  if (!isFormulaText(text)) return null;
  try { parseFormula(text.trim().slice(1)); return null; } catch (e) { return e instanceof Error ? e.message : String(e); }
}

/**
 * Turns the text of a money cell into an amount: "1200", "1,200.50", "1.200,50" (either style), "Rp 1.200", "$12". Returns
 * null when there is no number in it.
 */
export function parseAmount(text: string): number | null {
  const t = text.replace(/[^\d.,-]/g, '');
  if (!/\d/.test(t)) return null;
  let s = t;
  const lastDot = s.lastIndexOf('.'), lastComma = s.lastIndexOf(',');
  if (lastDot >= 0 && lastComma >= 0) {
    // the last separator is the decimal point; the other one groups thousands
    if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.'); else s = s.replace(/,/g, '');
  } else if (lastComma >= 0) {
    const digitsAfter = s.length - lastComma - 1;
    s = digitsAfter === 3 && s.indexOf(',') === lastComma ? s.replace(/,/g, '') : s.replace(',', '.');
  } else if (lastDot >= 0) {
    const digitsAfter = s.length - lastDot - 1;
    if (digitsAfter === 3 && s.indexOf('.') === lastDot && s.length > 4) s = s.replace(/\./g, '');
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
