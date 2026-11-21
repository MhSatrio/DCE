import { describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import { takeForOccurrence } from '../../src/automation/triggers';
import { assignPositions, byPosition, POSITION_STEP, positionAfter } from '../../src/db/order';
import type { ContentRecord } from '../../src/db/schema';
import { colName, excelSerial, toXlsx } from '../../src/db/xlsx';

const rec = (id: string, created: number, position?: number) => ({ id, created_at: created, position }) as ContentRecord;

describe('the order of rows', () => {
  it('rows are shown by their position; creation time and id only break ties of rows without one', () => {
    const list = [rec('b', 5, 2000), rec('a', 9, 1000), rec('c', 1)];
    expect(list.sort(byPosition).map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('a row without a position gets one after the others, in creation order (id for equal times), and only once', () => {
    const list = [rec('x', 2), rec('y', 1), rec('z', 1), rec('w', 3, 500)];
    const fixed = assignPositions(list);
    expect(fixed.map((r) => [r.id, r.position])).toEqual([['y', 1500], ['z', 2500], ['x', 3500]]);
    expect(assignPositions(list)).toEqual([]);
    expect(list.find((r) => r.id === 'w')?.position).toBe(500);
  });

  it('a new row goes after the last positioned row', () => {
    expect(positionAfter([])).toBe(POSITION_STEP);
    expect(positionAfter([rec('a', 1, 1000), rec('b', 2, 4000)])).toBe(5000);
  });
});

describe('a schedule that runs a set number of rows each time', () => {
  it('runs all rows, or the first ones in table order', () => {
    const rows = [1, 2, 3, 4];
    expect(takeForOccurrence(rows, undefined)).toEqual([1, 2, 3, 4]);
    expect(takeForOccurrence(rows, 0)).toEqual([1, 2, 3, 4]);
    expect(takeForOccurrence(rows, 1)).toEqual([1]);
    expect(takeForOccurrence(rows, 2)).toEqual([1, 2]);
  });
});

describe('the Excel file', () => {
  it('column letters and date serials are the ones Excel uses', () => {
    expect([colName(1), colName(26), colName(27), colName(702), colName(703)]).toEqual(['A', 'Z', 'AA', 'ZZ', 'AAA']);
    expect(excelSerial('1899-12-30', 'date')).toBe(0);
    expect(excelSerial('2000-01-01', 'date')).toBe(36526);
    expect(excelSerial('2000-01-01T12:00', 'datetime')).toBe(36526.5);
    expect(excelSerial('not a date', 'date')).toBeNull();
  });

  it('a workbook is a zip of the parts Excel needs, with the header, the numbers, the dates and the text in their cells', () => {
    const bytes = toXlsx(
      [['Title', 'Price', 'Date', 'Note'], ['Lamp', '12', '2000-01-01', 'a & b <c>'], ['Set', '', '2000-01-01T12:00', 'x']],
      { sheet: 'Products: 2026/11', kinds: ['text', 'number', 'datetime', 'text'] },
    );
    const parts = unzipSync(bytes);
    for (const name of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml']) {
      expect(parts[name], name).toBeDefined();
    }
    const sheet = strFromU8(parts['xl/worksheets/sheet1.xml']);
    expect(sheet).toContain('<c r="A1" s="1" t="inlineStr"><is><t xml:space="preserve">Title</t></is></c>');
    expect(sheet).toContain('<c r="B2"><v>12</v></c>');
    expect(sheet).toContain('<c r="C2" s="3"><v>36526</v></c>');
    expect(sheet).toContain('<c r="C3" s="3"><v>36526.5</v></c>');
    expect(toXlsx([['D'], ['2000-01-01T12:00']], { sheet: 'S', kinds: ['date'] })).toBeDefined();
    expect(sheet).toContain('a &amp; b &lt;c&gt;');
    expect(sheet).not.toContain('<c r="B3"'); // an empty price is an empty cell
    expect(sheet).toContain('<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>');
    expect(strFromU8(parts['xl/workbook.xml'])).toContain('name="Products  2026 11"');
  });
});
