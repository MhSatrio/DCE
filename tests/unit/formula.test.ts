import { describe, expect, it } from 'vitest';
import { colIndex, colLetters, evaluateText, numberText, parseAmount, parseFormula, syntaxProblem, TableEvaluator, tokenize, FormulaErr } from '../../src/db/formula';
import type { ContentRecord, FieldDef } from '../../src/db/schema';

const val = (text: string) => evaluateText(text, { field: () => new FormulaErr('#NAME?'), cell: () => null });

describe('reading a formula', () => {
  it('reads cell addresses, ranges, [field names], functions and texts', () => {
    expect(tokenize('A1+$B$2:C3').map((t) => t.t)).toEqual(['cell', 'op', 'cell']);
    expect(tokenize('SUM(A1:A3)')[0]).toEqual({ t: 'fn', name: 'SUM' });
    expect(tokenize('[Unit price]*2')[0]).toEqual({ t: 'field', name: 'Unit price' });
    expect(tokenize('"say ""hi"""')[0]).toEqual({ t: 'str', v: 'say "hi"' });
  });

  it('a function name ending in digits is a function, not a cell (LOG10( is not L10)', () => {
    expect(tokenize('LOG10(2)')[0]).toEqual({ t: 'fn', name: 'LOG10' });
  });

  it('column letters convert both ways: A = 0, Z = 25, AA = 26', () => {
    expect(colIndex('A')).toBe(0);
    expect(colIndex('AA')).toBe(26);
    expect(colLetters(26)).toBe('AA');
    expect(colLetters(51)).toBe('AZ');
  });

  it('reports a formula a spreadsheet would refuse, with a reason', () => {
    expect(syntaxProblem('=SUM(1,2')).toMatch(/closed|“\)”|\)/);
    expect(syntaxProblem('="unclosed')).toMatch(/quote/);
    expect(syntaxProblem('=1+')).toMatch(/ends too early/);
    expect(syntaxProblem('=1+2')).toBeNull();
    expect(syntaxProblem('plain text')).toBeNull();
  });
});

describe('calculating', () => {
  it('follows the precedence of a spreadsheet: * before +, ^ before *, and =-2^2 is 4', () => {
    expect(val('=1+2*3')).toBe(7);
    expect(val('=(1+2)*3')).toBe(9);
    expect(val('=-2^2')).toBe(4);
    expect(val('=2^3^2')).toBe(64);
    expect(val('=50%*200')).toBe(100);
  });

  it('joins texts with & and compares with =, <>, <, >, <=, >=', () => {
    expect(val('="Rp "&12')).toBe('Rp 12');
    expect(val('=1<2')).toBe(true);
    expect(val('="a"="A"')).toBe(true);
    expect(val('=3<>3')).toBe(false);
  });

  it('gives Excel’s errors: #DIV/0!, #NAME? for an unknown function, #VALUE! for text in arithmetic', () => {
    expect(String(val('=10/0'))).toBe('#DIV/0!');
    expect(String(val('=NOSUCH(1)'))).toBe('#NAME?');
    expect(String(val('="abc"*2'))).toBe('#VALUE!');
    expect(String(val('=SQRT(-1)'))).toBe('#NUM!');
  });

  it('IF and IFERROR decide without evaluating the branch they do not need', () => {
    expect(val('=IF(1>2,"yes","no")')).toBe('no');
    expect(val('=IF("",1,2)')).toBe(2);
    expect(String(val('=IF(1,10/0,3)'))).toBe('#DIV/0!');   // the taken branch is the error
    expect(val('=IF(0,10/0,3)')).toBe(3);                   // the other branch is never evaluated
    expect(val('=IFERROR(10/0,"n/a")')).toBe('n/a');
  });

  it('rounds like a spreadsheet: ROUND(2.5,0)=3, ROUND(-2.5,0)=-3, ROUNDDOWN and ROUNDUP keep the sign', () => {
    expect(val('=ROUND(2.5,0)')).toBe(3);
    expect(val('=ROUND(-2.5,0)')).toBe(-3);
    expect(val('=ROUND(1.005,2)')).toBeCloseTo(1.01, 9);
    expect(val('=ROUNDDOWN(-1.9,0)')).toBe(-1);
    expect(val('=ROUNDUP(-1.1,0)')).toBe(-2);
  });

  it('text functions', () => {
    expect(val('=UPPER("ab")&LOWER("C")')).toBe('ABc');
    expect(val('=LEN("hello")')).toBe(5);
    expect(val('=MID("abcdef",2,3)')).toBe('bcd');
    expect(val('=LEFT("abcdef",2)&RIGHT("abcdef",2)')).toBe('abef');
    expect(val('=TRIM("  a   b ")')).toBe('a b');
  });

  it('numbers print without noise (0.1+0.2 shows 0.3)', () => {
    expect(numberText(0.1 + 0.2)).toBe('0.3');
    expect(numberText(12)).toBe('12');
  });
});

/** A small table: Price, Qty and a formula column, in creation order. */
function table(rows: { price: unknown; qty: unknown; total?: unknown }[], extra: FieldDef[] = []) {
  const fields: FieldDef[] = [
    { id: 'f1', key: 'price', label: 'Price', type: 'currency', order: 0 },
    { id: 'f2', key: 'qty', label: 'Qty', type: 'number', order: 1 },
    { id: 'f3', key: 'total', label: 'Total', type: 'formula', order: 2 },
    ...extra,
  ];
  const records: ContentRecord[] = rows.map((r, i) => ({
    id: `r${i + 1}`, title: '', slug: '', status: '', publish_date: '', content: '', image_asset: '', template_ref: '', tags: [],
    created_at: 1000 + i, updated_at: 1000 + i, table: 't1', data: { price: r.price, qty: r.qty, total: r.total },
  }));
  return new TableEvaluator(fields, records);
}

describe('formulas in a table', () => {
  it('[Field name] reads a column of the same row', () => {
    const t = table([{ price: 10, qty: 2, total: '=[Price]*[Qty]' }, { price: 5, qty: 3, total: '=[Price]*[Qty]' }]);
    expect(t.textOf('r1', 'total')).toBe('20');
    expect(t.textOf('r2', 'total')).toBe('15');
  });

  it('A1 addresses use the field order for columns and the creation order for rows', () => {
    const t = table([{ price: 10, qty: 2, total: '=A1+A2' }, { price: 5, qty: 3 }]);
    expect(t.textOf('r1', 'total')).toBe('15');        // A1 = 10 (Price, row 1), A2 = 5 (Price, row 2)
    expect(t.rowNumber('r2')).toBe(2);
  });

  it('a range sums a column of the table', () => {
    const t = table([{ price: 10, qty: 2, total: '=SUM(A1:A3)' }, { price: 5, qty: 3 }, { price: 7, qty: 1 }]);
    expect(t.textOf('r1', 'total')).toBe('22');
    expect(t.textOf('r1', 'qty')).toBe('2');
  });

  it('a formula that refers to itself shows #CIRC!', () => {
    const t = table([{ price: 1, qty: 1, total: '=[Total]+1' }]);
    expect(t.textOf('r1', 'total')).toBe('#CIRC!');
  });

  it('an unknown [column] shows #NAME?; a plain value is shown as it is', () => {
    const t = table([{ price: 1, qty: 1, total: '=[Nope]*2' }]);
    expect(t.textOf('r1', 'total')).toBe('#NAME?');
    expect(t.textOf('r1', 'price')).toBe('1');
  });

  it('a formula can use a money cell like any number (the currency field takes formulas too)', () => {
    const t = table([{ price: '=[Qty]*1000', qty: 3 }, { price: 1, qty: 1, total: '=[Price]+0' }]);
    expect(t.textOf('r1', 'price')).toBe('3000');
    expect(t.textOf('r2', 'total')).toBe('1');
  });
});

describe('amounts typed in a money cell', () => {
  it('reads both thousand-separator styles and the currency symbol', () => {
    expect(parseAmount('1200')).toBe(1200);
    expect(parseAmount('1,200.50')).toBe(1200.5);
    expect(parseAmount('1.200,50')).toBe(1200.5);
    expect(parseAmount('Rp 1.200')).toBe(1200);
    expect(parseAmount('$12')).toBe(12);
    expect(parseAmount('1,5')).toBe(1.5);
    expect(parseAmount('-12.5')).toBe(-12.5);
    expect(parseAmount('abc')).toBeNull();
  });
});

describe('the parser keeps the tree', () => {
  it('a formula parses to a tree that evaluates the same', () => {
    expect(parseFormula('1+2*3')).toMatchObject({ k: 'bin', op: '+' });
  });
});
