import { describe, expect, it } from 'vitest';
import { allFields, BUILTIN_FIELDS, defaultValueOf } from '../../src/db/fields';
import { describeField, describeTable } from '../../src/db/describe';
import type { FieldDef } from '../../src/db/schema';

const byKey = (fs: FieldDef[], key: string) => fs.find((f) => f.key === key)!;

describe('built-in fields can be renamed and their choices changed, but not their key or type', () => {
  it('the stored override changes the name and the choices of a built-in field', () => {
    const fs = allFields([{ id: 'b_status', key: 'status', label: 'Stage', type: 'select', builtin: true, options: ['New', 'Done'], order: 1 }]);
    const status = byKey(fs, 'status');
    expect(status.label).toBe('Stage');
    expect(status.options).toEqual(['New', 'Done']);
    expect(status.type).toBe('select');
    expect(status.builtin).toBe(true);
  });

  it('an override cannot change the key or the type, and does not duplicate the field', () => {
    const fs = allFields([{ id: 'b_title', key: 'title', label: 'Name', type: 'number', builtin: true, order: 0 }]);
    const title = byKey(fs, 'title');
    expect(title.type).toBe('text');
    expect(fs.filter((f) => f.key === 'title')).toHaveLength(1);
    expect(title.label).toBe('Name');
  });

  it('an empty name in an override falls back to the built-in name; an empty choice list is kept as chosen', () => {
    const fs = allFields([
      { id: 'b_title', key: 'title', label: '', type: 'text', builtin: true, order: 0 },
      { id: 'b_status', key: 'status', label: 'Status', type: 'select', builtin: true, options: [], order: 1 },
    ]);
    expect(byKey(fs, 'title').label).toBe('Title');
    expect(byKey(fs, 'status').options).toEqual([]);
  });

  it('a built-in field can start hidden, and an override can show it again', () => {
    expect(byKey(allFields([]), 'content').hiddenByDefault).toBe(true);
    expect(byKey(allFields([]), 'title').hiddenByDefault).toBeFalsy();
    const shown = allFields([{ id: 'b_content', key: 'content', label: 'Content', type: 'markdown', builtin: true, hiddenByDefault: false, order: 7 }]);
    expect(byKey(shown, 'content').hiddenByDefault).toBe(false);
  });

  it('custom fields keep their order and stay between the leading and trailing built-in fields', () => {
    // one order for all fields: custom fields placed after the leading built-in fields (orders 0-7) and before the hidden ones (100+)
    const fs = allFields([{ id: 'c2', key: 'two', label: 'Two', type: 'text', order: 11 }, { id: 'c1', key: 'one', label: 'One', type: 'text', order: 10 }]);
    const keys = fs.map((f) => f.key);
    expect(keys.indexOf('one')).toBeLessThan(keys.indexOf('two'));
    expect(keys.indexOf('two')).toBeGreaterThan(keys.indexOf('slug'));
    expect(keys.indexOf('two')).toBeLessThan(keys.indexOf('id'));
    expect(BUILTIN_FIELDS.every((b) => fs.some((f) => f.key === b.key))).toBe(true);
  });
});

describe('the default value of a field', () => {
  it('the built-in Status field starts new records as Draft, and an override can change it or clear it', () => {
    expect(defaultValueOf([], 'status')).toBe('Draft');
    expect(defaultValueOf([{ id: 'b_status', key: 'status', label: 'Status', type: 'select', builtin: true, options: ['New', 'Done'], defaultValue: 'New', order: 1 }], 'status')).toBe('New');
    expect(defaultValueOf([{ id: 'b_status', key: 'status', label: 'Status', type: 'select', builtin: true, defaultValue: '', order: 1 }], 'status')).toBe('');
  });

  it('a field without a default gives an empty value', () => {
    expect(defaultValueOf([], 'no_such_field')).toBe('');
    expect(defaultValueOf([{ id: 'c', key: 'stage', label: 'Stage', type: 'select', options: ['A'], defaultValue: 'A', order: 0 }], 'stage')).toBe('A');
  });
});

describe('plain-text descriptions for an AI prompt', () => {
  it('a field description names the label, the key, the type and the choices', () => {
    const text = describeField({ id: 's', key: 'stage', label: 'Stage', type: 'select', options: ['New', 'Done'], order: 0 });
    expect(text).toBe('Stage (key: stage) — Single select · choices: New, Done');
  });

  it('currency, rating, link and synced fields say what they need', () => {
    expect(describeField({ id: 'p', key: 'price', label: 'Price', type: 'currency', currency: 'Rp', order: 0 })).toContain('symbol: Rp');
    expect(describeField({ id: 'q', key: 'q', label: 'Quality', type: 'rating', ratingMax: 3, order: 0 })).toContain('maximum: 3');
    const link = describeField({ id: 'l', key: 'supplier', label: 'Supplier', type: 'link', linkTable: 't1', order: 0 }, (t) => (t === 't1' ? 'Suppliers' : t));
    expect(link).toContain('links to: Suppliers');
    expect(describeField({ id: 'y', key: 'sp', label: 'Supplier price', type: 'currency', sync: { via: 'supplier', source: 'price' }, order: 0 })).toContain('synced from: price through supplier');
  });

  it('a table description has the name, the record count, the master field and every field', () => {
    const fields: FieldDef[] = [
      { id: 'a', key: 'name', label: 'Name', type: 'text', order: 0 },
      { id: 'b', key: 'price', label: 'Price', type: 'currency', order: 1 },
    ];
    const text = describeTable('Products', 12, fields[0], fields);
    expect(text).toContain('Table: Products');
    expect(text).toContain('Records: 12');
    expect(text).toContain('Master field (names each record): Name (key: name)');
    expect(text.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(2);
    expect(text).toContain('{{content.<key>}}');
  });
});
