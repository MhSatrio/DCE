import { describe, expect, it } from 'vitest';
import { planRun } from '../../src/automation/engine';
import { armedLastDue, choiceKey, dueNow, latestDue, randomSlot, signatureOf, triggerChoices, triggerFromValue, triggerSummary } from '../../src/automation/triggers';
import { newStep, presetAutomation, stepProblems, stepChoices } from '../../src/automation/model';
import type { ConnectionRow, ContentRecord } from '../../src/db/schema';

const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
const rec = (id: string, data: Record<string, unknown>): ContentRecord => ({
  id, title: String(data.name ?? id), slug: '', status: 'Draft', publish_date: '', content: '', image_asset: '', template_ref: '', tags: [], created_at: 1, updated_at: 1, data, table: 't1',
});

describe('random date and time', () => {
  const win = { from: '2026-11-20', to: '2026-11-22', fromTime: '09:00', toTime: '18:00', weekdays: false };
  it('picks a time inside the window, in 5-minute steps, as a date & time value', () => {
    const v = randomSlot(win, () => 0.5, new Set())!;
    expect(v).toMatch(/^2026-11-2[0-2]T(09|1[0-7]):[0-5]\d$/);
    expect(Number(v.slice(-2)) % 5).toBe(0);
  });
  it('never gives the same time twice: taken values are skipped', () => {
    const first = randomSlot(win, () => 0, new Set())!;
    const second = randomSlot(win, () => 0, new Set([first]))!;
    expect(second).not.toBe(first);
  });
  it('weekdays only skips Saturday and Sunday (2026-11-21 is a Saturday)', () => {
    const w = { from: '2026-11-21', to: '2026-11-23', fromTime: '09:00', toTime: '18:00', weekdays: true };
    for (let i = 0; i < 20; i++) expect(randomSlot(w, Math.random, new Set())!.startsWith('2026-11-23')).toBe(true);
  });
  it('returns nothing for an empty or reversed window, or when every slot is taken', () => {
    expect(randomSlot({ ...win, from: '2026-11-25', to: '2026-11-20' }, Math.random, new Set())).toBeUndefined();
    expect(randomSlot({ ...win, fromTime: '18:00', toTime: '09:00' }, Math.random, new Set())).toBeUndefined();
    expect(randomSlot({ from: '2026-11-20', to: '2026-11-20', fromTime: '09:00', toTime: '09:10', weekdays: false }, Math.random, new Set(['2026-11-20T09:00', '2026-11-20T09:05']))).toBeUndefined();
  });
});

describe('schedules', () => {
  it('a weekly schedule is due at its latest occurrence before now', () => {
    // 2026-11-13 is a Friday; Monday and Wednesday at 09:00
    const when = { mode: 'weekly' as const, time: '09:00', days: [1, 3] };
    expect(latestDue(when, at(2026, 11, 13, 10))).toBe(at(2026, 11, 11, 9));   // Wednesday 09:00
    expect(latestDue(when, at(2026, 11, 11, 8))).toBe(at(2026, 11, 9, 9));     // before Wednesday's time: Monday
    expect(latestDue({ ...when, days: [] }, at(2026, 11, 13))).toBeUndefined();
  });
  it('a dated schedule is due once its time has come', () => {
    const when = { mode: 'once' as const, at: '2026-11-20T10:30' };
    expect(latestDue(when, at(2026, 11, 19))).toBeUndefined();
    expect(latestDue(when, at(2026, 11, 20, 11))).toBe(new Date('2026-11-20T10:30').getTime());
  });
  it('an occurrence runs once: after it is handled (lastDue), it is not due again', () => {
    const t = { kind: 'schedule' as const, table: 't1', filter: { join: 'and' as const, conditions: [] }, when: { mode: 'once' as const, at: '2026-11-20T10:30' } };
    const now = at(2026, 11, 20, 11);
    const due = dueNow(t, now);
    expect(due).toBe(new Date('2026-11-20T10:30').getTime());
    expect(dueNow({ ...t, lastDue: due }, now)).toBeUndefined();
  });
  it('switching a schedule on does not run the occurrences that already passed', () => {
    const when = { mode: 'weekly' as const, time: '09:00', days: [1] };
    const now = at(2026, 11, 13, 10);   // Friday: Monday 09:00 already passed
    expect(dueNow({ kind: 'schedule', table: 't1', filter: { join: 'and', conditions: [] }, when, lastDue: armedLastDue(when, now) }, now)).toBeUndefined();
    expect(dueNow({ kind: 'schedule', table: 't1', filter: { join: 'and', conditions: [] }, when, lastDue: armedLastDue(when, now) }, at(2026, 11, 16, 9))).toBe(at(2026, 11, 16, 9));
  });
});

describe('triggers', () => {
  const conns: ConnectionRow[] = [
    { id: 'w1', provider: 'http', kind: 'website', name: 'Site', created_at: 1, props: [], caps: { checkedAt: 1, scopes: ['events:read'], note: '' } },
    { id: 'w2', provider: 'http', kind: 'website', name: 'Untested', created_at: 1, props: [] },
  ];
  it('the When menu offers creates, field changes, matches, dates, weekly times and the website events', () => {
    const labels = triggerChoices(conns).map((c) => c.label);
    expect(labels).toEqual(expect.arrayContaining(['A record is created', 'A field of a record changes', 'A record matches conditions', 'At a date and time (once)', 'Every week, on chosen days, at a time']));
    const untested = triggerChoices(conns).filter((c) => c.value.kind === 'event' && c.value.connectionId === 'w2');
    expect(untested.every((c) => !c.enabled)).toBe(true);
    expect(triggerChoices(conns).find((c) => c.value.kind === 'event' && c.value.connectionId === 'w1')!.enabled).toBe(true);
  });
  it('a menu choice becomes a trigger; the conditions stay when the table stays the same', () => {
    const prev = { kind: 'record' as const, table: 't1', filter: { join: 'and' as const, conditions: [{ id: 'c', field: 'status', op: 'eq', value: 'Ready' }] } };
    const t = triggerFromValue({ kind: 'record', on: 'changed' }, { table: 't1', field: 'approval', now: at(2026, 11, 13), prev });
    expect(t).toEqual({ kind: 'record', table: 't1', filter: prev.filter, on: { kind: 'changed', field: 'approval' } });
    expect(triggerFromValue({ kind: 'record', on: 'created' }, { table: 't2', now: 0, prev }).kind).toBe('record');
    expect(choiceKey({ kind: 'schedule', when: 'weekly' })).toBe('schedule:weekly');
  });
  it('the summary says what happens in plain words', () => {
    const names = { connection: () => 'Site', table: () => 'Posts', template: () => 'T', channel: () => '' };
    expect(triggerSummary({ kind: 'record', table: 't', filter: { join: 'and', conditions: [] }, on: { kind: 'created' } }, names)).toBe('When a record is created in Posts');
    expect(triggerSummary({ kind: 'record', table: 't', filter: { join: 'and', conditions: [] }, on: { kind: 'changed', field: 'approval' } }, names)).toBe('When “approval” changes in Posts');
    expect(triggerSummary({ kind: 'schedule', table: 't', filter: { join: 'and', conditions: [] }, when: { mode: 'weekly', time: '09:00', days: [1, 2, 3, 4, 5] } }, names)).toContain('on weekdays at 09:00');
  });
});

describe('a field changes (the value it last saw decides)', () => {
  const filter = { join: 'and' as const, conditions: [] };
  const on = { kind: 'changed' as const, field: 'approval' };
  it('fires for a new record, and again only when the watched value changes', () => {
    const r = rec('a', { approval: 'Draft' });
    expect(planRun(filter, {}, [r], 0, on).fire.map((x) => x.id)).toEqual(['a']);
    const seen = { a: { at: 0, n: 1, last: 0, done: true, sig: signatureOf(r, 'approval') } };
    expect(planRun(filter, seen, [r], 1, on).fire).toEqual([]);                                 // same value: nothing
    expect(planRun(filter, seen, [rec('a', { approval: 'Approved' })], 1, on).fire.map((x) => x.id)).toEqual(['a']);
  });
  it('a created record is remembered: it does not fire again just because time passed', () => {
    const r = rec('a', {});
    const done = { a: { at: 0, n: 1, last: 0, done: true } };
    expect(planRun(filter, done, [r], 9e9, { kind: 'created' }).fire).toEqual([]);
    expect(planRun(filter, done, [r], 9e9, { kind: 'created' }).clear).toEqual([]);
  });
  it('a new field value of a record that stopped matching starts again only when it matches again', () => {
    const cond = { join: 'and' as const, conditions: [{ id: 'x', field: 'status', op: 'eq', value: 'Ready' }] };
    const r = rec('a', { status: 'Draft', approval: 'Approved' });
    expect(planRun(cond, { a: { at: 0, n: 1, last: 0, done: true, sig: 'Approved' } }, [r], 1, on).clear).toEqual(['a']);
  });
});

describe('automation steps and presets for the table', () => {
  it('a random time step needs a table, a field, a valid window and hours', () => {
    expect(stepProblems(newStep('random_time', {}))).toEqual(expect.arrayContaining(['Choose the table.', 'Choose the date & time field to fill.']));
    const bad = { ...newStep('random_time', { table: 't' }), field: 'when', from: '2026-11-22', to: '2026-11-20', fromTime: '09:00', toTime: '08:00' } as ReturnType<typeof newStep>;
    expect(stepProblems(bad).join(' ')).toMatch(/first not after the last[\s\S]*before the latest/);
  });
  it('the random time step is offered under this app’s tables', () => {
    expect(stepChoices([]).some((c) => c.value.kind === 'random_time' && c.enabled)).toBe(true);
  });
  it('“Post approved rows” is a change to Approval = Approved that sets a random time and then posts at it', () => {
    const p = presetAutomation('post-approved', { websiteId: '', bufferId: 'b', geminiId: '', articlesTable: '', productsTable: '', templateId: '', channel: 'BUFFER_CHANNEL_ID_IG', postsTable: 'posts', windowFrom: '2026-11-13', windowTo: '2026-11-27' });
    expect(p.trigger).toMatchObject({ kind: 'record', table: 'posts', on: { kind: 'changed', field: 'approval' }, filter: { conditions: [{ field: 'approval', value: 'Approved' }] } });
    expect(p.steps.map((s) => s.kind)).toEqual(['random_time', 'buffer_post', 'set_field']);
    expect(p.steps[0]).toMatchObject({ kind: 'random_time', field: 'publish_at', from: '2026-11-13', to: '2026-11-27', onlyIfEmpty: true });
    expect(p.steps[1]).toMatchObject({ kind: 'buffer_post', text: '{{post_text}}', timing: { mode: 'field', timeField: 'publish_at' }, resultField: 'post_id' });
  });
});
