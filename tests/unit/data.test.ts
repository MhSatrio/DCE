import { describe, expect, it } from 'vitest';
import { parseCsv, toCsv } from '../../src/db/csv';
import { coerce, getValue } from '../../src/db/fields';
import { applyFilter, matchGroup, searchRecords, sortRecords, type FilterGroup } from '../../src/db/filter';
import { autoMap, buildRecords, jsonToTable } from '../../src/db/importer';
import type { ContentRecord, FieldDef } from '../../src/db/schema';
import { BUILTIN_FIELDS } from '../../src/db/fields';
import { copyRows, parseTsv, planPaste, toTsv, type Lookups } from '../../src/pages/content/gridClipboard';

const rec = (over: Partial<ContentRecord> = {}): ContentRecord => ({
  id: crypto.randomUUID(), title: 'T', slug: 't', status: 'Draft', publish_date: '', content: '', image_asset: '', template_ref: '', tags: [],
  created_at: 1, updated_at: 1, data: {}, ...over,
});

describe('csv', () => {
  it('parses quotes, embedded newlines, BOM, CRLF and detects delimiters', () => {
    const rows = parseCsv('﻿title,desc\r\n"A, B","line1\nline2"\r\n"He said ""hi""",x\r\n');
    expect(rows).toEqual([['title', 'desc'], ['A, B', 'line1\nline2'], ['He said "hi"', 'x']]);
    expect(parseCsv('a;b\n1;2')).toEqual([['a', 'b'], ['1', '2']]);
    expect(parseCsv('a\tb\n1\t2')).toEqual([['a', 'b'], ['1', '2']]);
  });
  it('rejects truncated quoted fields instead of corrupting data', () => {
    expect(() => parseCsv('a,b\n"unterminated,1')).toThrow(/Unterminated/);
  });
  it('round-trips awkward values; neutralises formulas but keeps "-80 °C"', () => {
    const rows = [['t', 'v'], ['a,b', 'c"d'], ['=SUM(A1)', '-80 °C']];
    const back = parseCsv(toCsv(rows));
    expect(back[1]).toEqual(['a,b', 'c"d']);
    expect(back[2][0]).toBe("'=SUM(A1)");
    expect(back[2][1]).toBe('-80 °C');
  });
});

describe('filtering', () => {
  const rs = [
    rec({ title: 'Centrifuge', status: 'Approved', publish_date: '2026-11-10', tags: ['lab'], data: { price: 300 } }),
    rec({ title: 'Balance', status: 'Draft', publish_date: '2026-10-01', data: { price: 50 } }),
    rec({ title: 'Incubator', status: 'Approved', publish_date: '', data: {} }),
  ];
  const g = (join: 'and' | 'or', ...c: [string, string, string][]): FilterGroup => ({ join, conditions: c.map(([field, op, value], i) => ({ id: String(i), field, op: op as never, value })) });
  it('supports every operator', () => {
    const t = (c: [string, string, string]) => applyFilter(rs, g('and', c)).map((r) => r.title);
    expect(t(['status', 'eq', 'Approved'])).toEqual(['Centrifuge', 'Incubator']);
    expect(t(['status', 'neq', 'Approved'])).toEqual(['Balance']);
    expect(t(['title', 'contains', 'ance'])).toEqual(['Balance']);
    expect(t(['title', 'not_contains', 'e'])).toEqual(['Incubator']);
    expect(t(['publish_date', 'empty', ''])).toEqual(['Incubator']);
    expect(t(['publish_date', 'not_empty', ''])).toEqual(['Centrifuge', 'Balance']);
    expect(t(['publish_date', 'after', '2026-10-15'])).toEqual(['Centrifuge']);
    expect(t(['publish_date', 'before', '2026-10-15'])).toEqual(['Balance']);
    expect(t(['publish_date', 'gte', '2026-11-10'])).toEqual(['Centrifuge']);
    expect(t(['price', 'gt', '100'])).toEqual(['Centrifuge']);
    expect(t(['price', 'lt', '100'])).toEqual(['Balance']);
    expect(t(['tags', 'contains', 'lab'])).toEqual(['Centrifuge']);
  });
  it('combines with AND / OR (the spec example: Approved AND date >= 2026-11-01)', () => {
    expect(applyFilter(rs, g('and', ['status', 'eq', 'Approved'], ['publish_date', 'gte', '2026-11-01'])).map((r) => r.title)).toEqual(['Centrifuge']);
    expect(applyFilter(rs, g('or', ['title', 'eq', 'Balance'], ['title', 'eq', 'Incubator'])).map((r) => r.title)).toEqual(['Balance', 'Incubator']);
    expect(matchGroup(rs[0], { join: 'and', conditions: [] })).toBe(true);
  });
  it('searches and sorts (empties last)', () => {
    expect(searchRecords(rs, 'lab').map((r) => r.title)).toEqual(['Centrifuge']);
    expect(sortRecords(rs, 'publish_date', 'asc').map((r) => r.title)).toEqual(['Balance', 'Centrifuge', 'Incubator']);
    expect(sortRecords(rs, 'publish_date', 'desc').map((r) => r.title)).toEqual(['Centrifuge', 'Balance', 'Incubator']);
    expect(getValue(rs[0], 'price')).toBe(300);
  });
});

describe('coercion & import', () => {
  const f = (type: FieldDef['type'], extra: Partial<FieldDef> = {}): FieldDef => ({ id: 'x', key: 'x', label: 'X', type, order: 0, ...extra });
  it('coerces by field type and reports errors without throwing', () => {
    expect(coerce('1,250.5', f('number')).value).toBe(1250.5);
    expect(coerce('abc', f('number')).error).toBeTruthy();
    expect(coerce('yes', f('boolean')).value).toBe(true);
    expect(coerce('2026-11-05', f('date')).value).toBe('2026-11-05');
    expect(coerce('nonsense', f('date')).error).toBeTruthy();
    expect(coerce('a; b ,c', f('multiselect')).value).toEqual(['a', 'b', 'c']);
    expect(coerce('approved', f('select', { options: ['Approved'] })).value).toBe('Approved');
    expect(coerce('ftp://x', f('url')).error).toBeTruthy();
    expect(coerce('{bad', f('json')).error).toBeTruthy();
  });
  it('maps columns, creates custom fields, validates rows and de-duplicates slugs', () => {
    const headers = ['Title', 'status', 'Publish Date', 'Colour', 'Price'];
    const map = autoMap(headers, []);
    expect(map.map((m) => m.target)).toEqual(['title', 'status', 'publish_date', '__new__', '__new__']);
    map[4].newType = 'number';
    const plan = buildRecords([
      ['Centrifuge', 'approved', '2026-11-05', 'Blue', '12.5'],
      ['Centrifuge', 'Draft', '', 'Red', 'x'],
      ['', 'Draft', '', '', ''],
      ['Another', 'Draft', '11/06/2026', 'Green', '7'],
      ['', '', '', '', ''],
    ], map, { fields: [] });
    expect(plan.newFields.map((x) => x.key)).toEqual(['colour', 'price']);
    expect(plan.records.map((r) => r.title)).toEqual(['Centrifuge', 'Another']);
    expect(plan.records[0].status).toBe('Approved');
    expect(plan.records[0].data).toEqual({ colour: 'Blue', price: 12.5 });
    expect(plan.records[1].publish_date).toBe('2026-11-06');
    expect(plan.errors.map((e) => e.row).sort()).toEqual([3, 4]);
    expect(plan.empty).toBe(1);
    const dup = buildRecords([['Same'], ['Same']], autoMap(['Title'], []), { fields: [] });
    expect(dup.records.map((r) => r.slug)).toEqual(['same', 'same-2']);
  });
  it('JSON import shares the pipeline and flattens custom data', () => {
    const t = jsonToTable(JSON.stringify({ records: [{ title: 'A', tags: ['x', 'y'], data: { colour: 'red' } }, { title: 'B', extra: 1 }] }));
    expect(t.headers).toEqual(['title', 'tags', 'colour', 'extra']);
    expect(t.rows[0]).toEqual(['A', 'x; y', 'red', '']);
    expect(() => jsonToTable('{"a":1}')).toThrow(/array/);
    expect(() => jsonToTable('[1,2]')).toThrow(/object/);
  });
});

const T = String.fromCharCode(9), N = String.fromCharCode(10), CRLF = String.fromCharCode(13, 10);

describe('spreadsheet copy / paste', () => {
  const lk: Lookups = { linkName: () => '', linkByName: () => undefined, assetName: new Map([['a1', 'pic.png']]), templateName: new Map(), assetByName: new Map([['pic.png', 'a1']]), templateByName: new Map() };
  const custom: FieldDef[] = [{ id: 'c', key: 'price', label: 'Price', type: 'number', order: 10 }];
  const cols = [BUILTIN_FIELDS.find((f) => f.key === 'title')!, BUILTIN_FIELDS.find((f) => f.key === 'status')!, custom[0], BUILTIN_FIELDS.find((f) => f.key === 'image_asset')!];
  const view = [rec({ title: 'One', slug: 'one' }), rec({ title: 'Two', slug: 'two' })];

  it('TSV round-trips quotes, tabs, newlines and blank cells (Excel compatible)', () => {
    const rows = [['a'+T+'b', 'say "hi"', 'line1'+N+'line2', ''], ['', '', '', 'x']];
    expect(parseTsv(toTsv(rows))).toEqual(rows);
    expect(parseTsv('a'+T+T+'c'+CRLF+CRLF+'d'+T+'e'+T+'f'+CRLF)).toEqual([['a', '', 'c'], [''], ['d', 'e', 'f']]); // blank line kept, trailing newline ignored
  });

  it('copies readable names for images; pastes by name; coerces types; skips what does not fit', () => {
    const withImg = rec({ title: 'Pic', image_asset: 'a1', data: { price: 5 } });
    expect(copyRows([withImg], cols, lk)).toEqual([['Pic', 'Draft', '5', 'pic.png']]);
    const plan = planPaste({ grid: [['Uno', 'Approved', '1,200', 'pic.png'], ['Dos', 'Bogus', 'abc', '']], startRow: 0, startCol: 0, view, fields: cols, lookups: lk });
    expect(plan.updated.map((r) => [r.title, r.status, r.data.price, r.image_asset])).toEqual([['Uno', 'Approved', 1200, 'a1'], ['Dos', 'Draft', undefined, '']]);
    expect(plan.updated[0].slug).toBe('uno'); // slug follows the title while it was auto-generated
    expect(plan.skipped.map((s) => s.field)).toEqual(['Status', 'Price']);
    expect(view[0].title).toBe('One'); // planning never mutates the grid's data
  });

  it('a block longer than the grid creates records; columns past the end are ignored; 1×1 fills a selection', () => {
    const plan = planPaste({ grid: [['x', 'Draft'], ['y', 'Draft'], ['z', 'Draft']], startRow: 1, startCol: 2, view, fields: cols, lookups: lk });
    expect(plan.created).toHaveLength(2);
    expect(plan.created[0].title).toBe('Untitled record');
    expect(plan.skipped.map((x) => x.field)).toEqual(['Price', 'Price', 'Price']); // 'x','y','z' are not numbers
    expect(plan.cells).toBe(3); // the image-reference column accepts any text (asset id or URL)
    const num = planPaste({ grid: [['7', '8', '9']], startRow: 0, startCol: 2, view, fields: cols, lookups: lk });
    expect(num.ignoredColumns).toBe(1); // 9 lands beyond the last visible column
    expect(num.skipped.length).toBe(0);
    expect(num.updated[0].data.price).toBe(7);
    const fill = planPaste({ grid: [['Approved']], startRow: 0, startCol: 1, view, fields: cols, lookups: lk, fill: { r1: 0, r2: 1, c1: 1, c2: 1 } });
    expect(fill.updated.map((r) => r.status)).toEqual(['Approved', 'Approved']);
  });
});
