import type { AutoTrigger, ConnectionRow, ContentRecord, RecordEvent, WeeklyWhen, WorkflowTrigger } from '../db/schema';
import { EVENT_TYPE_TEXT } from '../connector/events';
import { asText } from '../connector/paths';
import { getValue } from '../db/fields';
import type { Names } from './model';

/**
 * Triggers, the way Airtable offers them: a record is created, a field changes, a record matches conditions, a date and
 * time comes (once), a weekly time comes, or the website reports an event. Pure: no database, no screen. The engine and
 * the screen both read these functions.
 */

export const websiteScopes = (c: ConnectionRow): string[] | undefined => c.caps?.scopes;
/** A website (the VierApparatus connector) or an API. Connections made before `kind` existed count as API. */
export const isWebsite = (c: ConnectionRow) => c.provider === 'http' && c.kind === 'website';

/** What the "When" menu can start: a record event, a schedule, or a website event. */
export type TriggerValue =
  | { kind: 'record'; on: RecordEvent['kind'] }
  | { kind: 'schedule'; when: WeeklyWhen['mode'] }
  | { kind: 'event'; connectionId: string; event: WorkflowTrigger };

export interface TriggerChoice { value: TriggerValue; label: string; group: string; enabled: boolean; reason?: string }

export const choiceKey = (v: TriggerValue): string =>
  v.kind === 'record' ? `record:${v.on}` : v.kind === 'schedule' ? `schedule:${v.when}` : `event:${v.connectionId}:${v.event}`;

const TABLE_GROUP = 'This app · tables';
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const dayNames = (days: number[]): string => {
  const names = days.map((d) => WEEKDAYS[d]);
  if (days.length === 7) return 'every day';
  if (days.length === 5 && [1, 2, 3, 4, 5].every((d) => days.includes(d))) return 'on weekdays';
  return names.length ? `on ${names.join(', ')}` : 'on no day';
};

/** The "When" menu: the table and schedule triggers, and the events of each connected website. */
export function triggerChoices(conns: ConnectionRow[], names: (c: ConnectionRow) => string = (c) => c.name): TriggerChoice[] {
  const out: TriggerChoice[] = [
    { value: { kind: 'record', on: 'created' }, label: 'A record is created', group: TABLE_GROUP, enabled: true },
    { value: { kind: 'record', on: 'changed' }, label: 'A field of a record changes', group: TABLE_GROUP, enabled: true },
    { value: { kind: 'record', on: 'matches' }, label: 'A record matches conditions', group: TABLE_GROUP, enabled: true },
    { value: { kind: 'schedule', when: 'once' }, label: 'At a date and time (once)', group: TABLE_GROUP, enabled: true },
    { value: { kind: 'schedule', when: 'weekly' }, label: 'Every week, on chosen days, at a time', group: TABLE_GROUP, enabled: true },
  ];
  for (const c of conns.filter(isWebsite)) {
    const scopes = websiteScopes(c);
    const ok = !!scopes && scopes.includes('events:read');
    const reason = !scopes ? 'Press Test connection on this website first, so DCE knows its permissions.' : ok ? undefined : 'This token cannot read events: create one with the events:read permission.';
    for (const ev of ['article.published', 'product.published', 'product.reviewed'] as WorkflowTrigger[]) {
      out.push({ value: { kind: 'event', connectionId: c.id, event: ev }, label: EVENT_TYPE_TEXT[ev] ?? ev, group: `Website · ${names(c)}`, enabled: ok, reason });
    }
  }
  return out;
}

/** A trigger from a menu choice. Keeps the conditions when the table stays the same. */
export function triggerFromValue(v: TriggerValue, o: { table: string; field?: string; now: number; prev?: AutoTrigger }): AutoTrigger {
  const keep = o.prev && (o.prev.kind === 'record' || o.prev.kind === 'schedule') && o.prev.table === o.table ? o.prev.filter : { join: 'and' as const, conditions: [] };
  if (v.kind === 'event') return { kind: 'event', connectionId: v.connectionId, event: v.event };
  if (v.kind === 'record') {
    const on: RecordEvent = v.on === 'changed' ? { kind: 'changed', field: o.field ?? '' } : v.on === 'created' ? { kind: 'created' } : { kind: 'matches' };
    return { kind: 'record', table: o.table, filter: keep, on };
  }
  if (v.when === 'once') {
    const d = new Date(o.now + 60 * 60_000);
    return { kind: 'schedule', table: o.table, filter: keep, when: { mode: 'once', at: `${dateKey(d)}T${hhmm(d)}` } };
  }
  return { kind: 'schedule', table: o.table, filter: keep, when: { mode: 'weekly', time: '09:00', days: [1, 2, 3, 4, 5] } };
}

export function triggerSummary(t: AutoTrigger, n: Names): string {
  if (t.kind === 'event') return `When ${(EVENT_TYPE_TEXT[t.event] ?? t.event).toLowerCase()} on ${n.connection(t.connectionId)}`;
  const k = t.filter.conditions.length;
  const cond = k ? ` that match ${k} condition${k === 1 ? '' : 's'}` : '';
  if (t.kind === 'record') {
    const on = t.on ?? { kind: 'matches' as const };
    if (on.kind === 'created') return `When a record is created in ${n.table(t.table)}${cond}`;
    if (on.kind === 'changed') return `When “${on.field || '(choose a field)'}” changes in ${n.table(t.table)}${cond}`;
    return `When a record in ${n.table(t.table)} ${k ? `matches ${k} condition${k === 1 ? '' : 's'}` : 'is added or changed'}`;
  }
  if (t.when.mode === 'once') return `At ${t.when.at.replace('T', ' ')} (once), for records in ${n.table(t.table)}${cond}`;
  return `Every week, ${dayNames(t.when.days)} at ${t.when.time}, for records in ${n.table(t.table)}${cond}`;
}

// ------------------------------------------------------------------------------------------------ time

const pad = (n: number) => String(n).padStart(2, '0');
/** Local calendar day, "YYYY-MM-DD". */
export const dateKey = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hhmm = (d: Date): string => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const parseDay = (s: string): Date | undefined => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : undefined;
};

/** The most recent moment at or before `now` when the schedule fires (undefined when there is none). */
export function latestDue(when: WeeklyWhen, now: number): number | undefined {
  if (when.mode === 'once') {
    const t = new Date(when.at).getTime();
    return Number.isNaN(t) ? undefined : t <= now ? t : undefined;
  }
  const [h, m] = when.time.split(':').map(Number);
  if (!when.days.length || Number.isNaN(h) || Number.isNaN(m)) return undefined;
  for (let back = 0; back <= 7; back++) {
    const day = new Date(now);
    day.setDate(day.getDate() - back);
    if (!when.days.includes(day.getDay())) continue;
    const t = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m, 0, 0).getTime();
    if (t <= now) return t;
  }
  return undefined;
}

/** The occurrence that is due and has not run yet (undefined = nothing to run). */
export function dueNow(t: Extract<AutoTrigger, { kind: 'schedule' }>, now: number): number | undefined {
  const d = latestDue(t.when, now);
  return d !== undefined && d > (t.lastDue ?? 0) ? d : undefined;
}

/** When a schedule is switched on: occurrences already past are not run (only the future ones are). */
export function armedLastDue(when: WeeklyWhen, now: number): number {
  return latestDue(when, now) ?? now;
}

/** The value a "field changes" trigger compares: the field as text, so an unchanged value never starts it again. */
export function signatureOf(rec: ContentRecord, field: string): string {
  return asText(getValue(rec, field));
}

// ------------------------------------------------------------------------------------------------ random time

export interface RandomWindow { from: string; to: string; fromTime: string; toTime: string; weekdays: boolean }

/**
 * A random date and time inside the window, in 5-minute steps, as "YYYY-MM-DDTHH:mm" (the format of date & time fields).
 * `taken` holds values already in use: the same time is not chosen twice. Pure: the random source is injected.
 * Returns undefined when the window is empty or every slot is taken.
 */
export function randomSlot(w: RandomWindow, rng: () => number, taken: Set<string>): string | undefined {
  const start = parseDay(w.from), end = parseDay(w.to);
  if (!start || !end || start > end) return undefined;
  const days: string[] = [];
  for (const cur = new Date(start); cur <= end; cur.setDate(cur.getDate() + 1)) {
    if (w.weekdays && (cur.getDay() === 0 || cur.getDay() === 6)) continue;
    days.push(dateKey(cur));
  }
  const [fh, fm] = w.fromTime.split(':').map(Number);
  const [th, tm] = w.toTime.split(':').map(Number);
  const fromMin = fh * 60 + fm, toMin = th * 60 + tm;
  if (!days.length || Number.isNaN(fromMin) || Number.isNaN(toMin) || toMin <= fromMin) return undefined;
  const slots = Math.floor((toMin - fromMin) / 5);
  if (slots <= 0) return undefined;
  const at = (day: string, slot: number) => { const m = fromMin + 5 * slot; return `${day}T${pad(Math.floor(m / 60))}:${pad(m % 60)}`; };
  for (let i = 0; i < 50; i++) {
    const v = at(days[Math.floor(rng() * days.length)], Math.floor(rng() * slots));
    if (!taken.has(v)) return v;
  }
  for (const day of days) for (let s = 0; s < slots; s++) { const v = at(day, s); if (!taken.has(v)) return v; }
  return undefined;
}
