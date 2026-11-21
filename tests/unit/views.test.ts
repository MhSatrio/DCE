import { describe, it, expect } from 'vitest';
import { MAX_VIEWS, cleanViewName, removeView, sameState, upsertView, type SavedView } from '../../src/db/views';
import { emptyFilter } from '../../src/db/filter';

const base = (name: string, extra: Partial<Omit<SavedView, 'id' | 'savedAt'>> = {}) => ({ name, q: '', filter: emptyFilter(), sort: null, hidden: [], ...extra });
let n = 0; const id = () => `v${++n}`;

describe('saved views', () => {
  it('adds a view, then replaces the one with the same name (any capitals) in place', () => {
    let list = upsertView([], base('Ready to post', { q: 'a' }), 1, id);
    list = upsertView(list, base('Drafts'), 2, id);
    expect(list.map((v) => v.name)).toEqual(['Ready to post', 'Drafts']);
    const firstId = list[0].id;
    list = upsertView(list, base('ready TO post', { q: 'changed', sort: { key: 'title', dir: 'asc' } }), 3, id);
    expect(list).toHaveLength(2);
    expect(list[0].id).toBe(firstId); expect(list[0].q).toBe('changed'); expect(list[0].sort).toEqual({ key: 'title', dir: 'asc' }); expect(list[0].savedAt).toBe(3);
  });

  it('cleans names, refuses an empty name and the 31st view, and does not share objects with the caller', () => {
    expect(cleanViewName('  A   long \n name  ')).toBe('A long name');
    expect(() => upsertView([], base('   '))).toThrow(/name/);
    let list: SavedView[] = [];
    for (let i = 0; i < MAX_VIEWS; i++) list = upsertView(list, base(`v${i}`), 1, id);
    expect(() => upsertView(list, base('one too many'))).toThrow(/at most/);
    expect(upsertView(list, base('v0', { q: 'x' })).length).toBe(MAX_VIEWS);          // replacing is still allowed at the limit
    const hidden = ['content'];
    const one = upsertView([], base('H', { hidden }), 1, id);
    hidden.push('id'); expect(one[0].hidden).toEqual(['content']);
  });

  it('removes by id and tells whether the screen is showing a view', () => {
    const list = upsertView(upsertView([], base('A'), 1, id), base('B', { hidden: ['x', 'y'] }), 2, id);
    expect(removeView(list, list[0].id).map((v) => v.name)).toEqual(['B']);
    const b = list[1];
    expect(sameState(b, { q: '', filter: emptyFilter(), sort: null, hidden: ['y', 'x'] })).toBe(true);     // order of hidden fields does not matter
    expect(sameState(b, { q: 'z', filter: emptyFilter(), sort: null, hidden: ['x', 'y'] })).toBe(false);
    expect(sameState(b, { q: '', filter: emptyFilter(), sort: { key: 'a', dir: 'asc' }, hidden: ['x', 'y'] })).toBe(false);
  });
});
