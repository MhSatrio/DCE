import { describe, expect, it } from 'vitest';
import { computeTiming, planRun } from '../../src/automation/engine';
import { buildCreatePost } from '../../src/automation/buffer';
import type { ContentRecord, FieldDef, TimingConfig } from '../../src/db/schema';

const rec = (id: string, data: Record<string, unknown>, over: Partial<ContentRecord> = {}): ContentRecord => ({
  id, title: String(data.name ?? 'T'), slug: '', status: 'Draft', publish_date: '', content: '', image_asset: '', template_ref: '', tags: [], created_at: 1, updated_at: 1, data, table: 't1', ...over,
});
const fields: FieldDef[] = [{ id: 'a', key: 'when', label: 'When', type: 'datetime', order: 0 }, { id: 'b', key: 'day', label: 'Day', type: 'date', order: 1 }, { id: 'c', key: 'status', label: 'Status', type: 'select', options: ['Ready', 'Posted'], order: 2 }];
const cfg = (over: Partial<TimingConfig> = {}): TimingConfig => ({ mode: 'queue', delayAmount: 30, delayUnit: 'minutes', pastPolicy: 'skip', ...over });
const NOW = new Date('2026-11-06T10:00:00').getTime();

describe('automation timing', () => {
  it('queue / delay / field modes', () => {
    expect(computeTiming(cfg(), rec('1', {}), fields, NOW)).toEqual({ mode: 'queue' });
    const d = computeTiming(cfg({ mode: 'delay', delayAmount: 2, delayUnit: 'hours' }), rec('1', {}), fields, NOW);
    expect(d).toEqual({ mode: 'scheduled', dueAt: new Date(NOW + 2 * 3_600_000).toISOString() });
    const f = computeTiming(cfg({ mode: 'field', timeField: 'when' }), rec('1', { when: '2026-11-07T14:30' }), fields, NOW);
    expect(f).toEqual({ mode: 'scheduled', dueAt: new Date('2026-11-07T14:30').toISOString() });
    const day = computeTiming(cfg({ mode: 'field', timeField: 'day' }), rec('1', { day: '2026-11-08' }), fields, NOW);
    expect(day).toEqual({ mode: 'scheduled', dueAt: new Date('2026-11-08T09:00').toISOString() });
  });
  it('empty, invalid and past times are handled explicitly', () => {
    expect(computeTiming(cfg({ mode: 'field', timeField: 'when' }), rec('1', {}), fields, NOW)).toEqual({ skip: '“When” is empty.' });
    expect('skip' in computeTiming(cfg({ mode: 'field', timeField: 'when' }), rec('1', { when: 'soon' }), fields, NOW)).toBe(true);
    const past = rec('1', { when: '2026-11-05T09:00' });
    expect('skip' in computeTiming(cfg({ mode: 'field', timeField: 'when' }), past, fields, NOW)).toBe(true);
    expect(computeTiming(cfg({ mode: 'field', timeField: 'when', pastPolicy: 'queue' }), past, fields, NOW)).toEqual({ mode: 'queue' });
    expect('skip' in computeTiming(cfg({ mode: 'field', timeField: 'gone' }), past, fields, NOW)).toBe(true);
  });
});

describe('trigger semantics ("when a record matches")', () => {
  const filter = { join: 'and' as const, conditions: [{ id: 'x', field: 'status', op: 'eq', value: 'Ready' }] };
  const rows = [rec('a', { status: 'Ready' }), rec('b', { status: 'Draft' }), rec('c', { status: 'Ready' })];
  it('fires matching records once, clears records that stopped matching, retries failures later (max 3)', () => {
    const p1 = planRun(filter, {}, rows, NOW);
    expect(p1.fire.map((r) => r.id)).toEqual(['a', 'c']);
    const fired = { a: { at: NOW, n: 1, last: NOW, done: true }, c: { at: NOW, n: 1, last: NOW, done: false }, z: { at: NOW, n: 1, last: NOW, done: true } };
    const soon = planRun(filter, fired, rows, NOW + 60_000);
    expect(soon.fire).toEqual([]);                               // 'a' is done; 'c' failed but retries wait 2 minutes
    expect(soon.clear).toEqual(['z']);                           // 'z' no longer matches → re-arm
    expect(planRun(filter, fired, rows, NOW + 3 * 60_000).fire.map((r) => r.id)).toEqual(['c']);
    expect(planRun(filter, { c: { at: NOW, n: 3, last: NOW, done: false } }, rows, NOW + 9e6).fire.map((r) => r.id)).toEqual(['a']);
  });
});

describe('GraphQL for Buffer', () => {
  it('is built with escaped literals — user text cannot break out of the string', () => {
    const evil = 'He said "hi" }) { x } # \ and\nnewline';
    const q = buildCreatePost({ text: evil, channelId: 'abc"def', mode: 'scheduled', dueAt: '2026-11-07T10:00:00.000Z', imageUrl: 'https://x.test/a.png?a="1"' });
    expect(q).toContain('mode: customScheduled');
    expect(q).toContain('dueAt: "2026-11-07T10:00:00.000Z"');
    expect(q).toContain(JSON.stringify(evil));
    expect(q).toContain('channelId: "abc\\"def"');
    expect(q).toContain('assets: [{ image: { url: "https://x.test/a.png?a=\\"1\\"" } }]');
    expect(buildCreatePost({ text: 'x', channelId: 'c', mode: 'queue' })).toContain('mode: addToQueue');
  });
});
