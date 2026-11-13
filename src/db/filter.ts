import { compareValues, isEmpty } from '../engine/expr';
import { getValue } from './fields';
import { db, INDEXED_RECORD_KEYS, type ContentRecord } from './schema';

export type Operator =
  | 'eq' | 'neq' | 'contains' | 'not_contains' | 'empty' | 'not_empty'
  | 'gt' | 'lt' | 'gte' | 'lte' | 'before' | 'after';

export interface Condition { id: string; field: string; op: Operator; value: string }
export interface FilterGroup { join: 'and' | 'or'; conditions: Condition[] }

export const OPERATOR_LABEL: Record<Operator, string> = {
  eq: 'equals', neq: 'does not equal', contains: 'contains', not_contains: 'does not contain',
  empty: 'is empty', not_empty: 'is not empty', gt: 'greater than', lt: 'less than',
  gte: '≥ (or on/after)', lte: '≤ (or on/before)', before: 'before', after: 'after',
};
export const NO_VALUE_OPS: Operator[] = ['empty', 'not_empty'];

export const emptyFilter = (): FilterGroup => ({ join: 'and', conditions: [] });

function asList(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [v];
}

export function matchCondition(rec: ContentRecord, c: Condition): boolean {
  const v = getValue(rec, c.field);
  switch (c.op) {
    case 'empty': return isEmpty(v);
    case 'not_empty': return !isEmpty(v);
    case 'eq': return asList(v).some((x) => (isEmpty(x) ? c.value === '' : compareValues(x, c.value) === 0));
    case 'neq': return !asList(v).some((x) => (isEmpty(x) ? c.value === '' : compareValues(x, c.value) === 0));
    case 'contains': return asList(v).some((x) => String(x ?? '').toLowerCase().includes(c.value.toLowerCase()));
    case 'not_contains': return !asList(v).some((x) => String(x ?? '').toLowerCase().includes(c.value.toLowerCase()));
    case 'gt': case 'after': return !isEmpty(v) && compareValues(v, c.value) > 0;
    case 'lt': case 'before': return !isEmpty(v) && compareValues(v, c.value) < 0;
    case 'gte': return !isEmpty(v) && compareValues(v, c.value) >= 0;
    case 'lte': return !isEmpty(v) && compareValues(v, c.value) <= 0;
  }
}

export function activeConditions(g: FilterGroup): Condition[] {
  return g.conditions.filter((c) => c.field && (NO_VALUE_OPS.includes(c.op) || c.value !== ''));
}

export function matchGroup(rec: ContentRecord, g: FilterGroup): boolean {
  const cs = activeConditions(g);
  if (!cs.length) return true;
  return g.join === 'and' ? cs.every((c) => matchCondition(rec, c)) : cs.some((c) => matchCondition(rec, c));
}

export function applyFilter(records: ContentRecord[], g: FilterGroup): ContentRecord[] {
  return activeConditions(g).length ? records.filter((r) => matchGroup(r, g)) : records;
}

const haystacks = new WeakMap<ContentRecord, string>();
function haystack(r: ContentRecord): string {
  let h = haystacks.get(r);
  if (h === undefined) {
    const parts = [r.title, r.slug, r.status, r.content, r.tags.join(' ')];
    for (const v of Object.values(r.data)) if (typeof v === 'string' || typeof v === 'number') parts.push(String(v));
    h = parts.join('').toLowerCase();
    haystacks.set(r, h);
  }
  return h;
}

/** Substring search over a lower-cased haystack that is built once per record version (edits create a new object). */
export function searchRecords(records: ContentRecord[], q: string): ContentRecord[] {
  const s = q.trim().toLowerCase();
  if (!s) return records;
  return records.filter((r) => haystack(r).includes(s));
}

interface SortKey { rec: ContentRecord; empty: boolean; num: number | null; str: string }

/** Keys are computed once per record (not once per comparison): 11k records sort in tens of ms. Empties always last. */
export function sortRecords(records: ContentRecord[], key: string | null, dir: 'asc' | 'desc'): ContentRecord[] {
  if (!key) return records;
  const m = dir === 'asc' ? 1 : -1;
  const keys: SortKey[] = records.map((rec) => {
    const raw = getValue(rec, key);
    const v = Array.isArray(raw) ? raw.join(',') : raw;
    const empty = isEmpty(v);
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null;
    return { rec, empty, num: n, str: empty ? '' : String(v).toLowerCase() };
  });
  keys.sort((a, b) => {
    if (a.empty || b.empty) return a.empty === b.empty ? 0 : a.empty ? 1 : -1;
    if (a.num !== null && b.num !== null) return (a.num - b.num) * m;
    return (a.str < b.str ? -1 : a.str > b.str ? 1 : 0) * m;
  });
  return keys.map((k) => k.rec);
}

/**
 * Database-side query. For AND groups with an `equals` on an indexed field (status, template, slug…),
 * Dexie narrows via the index first and only the remainder is evaluated in memory.
 */
export async function queryRecords(g: FilterGroup): Promise<{ records: ContentRecord[]; usedIndex: string | null }> {
  const cs = activeConditions(g);
  if (g.join === 'and') {
    const idx = cs.find((c) => c.op === 'eq' && INDEXED_RECORD_KEYS.has(c.field) && c.value !== '');
    if (idx) {
      const rows = await db.records.where(idx.field).equals(idx.value).toArray();
      const rest: FilterGroup = { join: 'and', conditions: cs.filter((c) => c !== idx) };
      return { records: applyFilter(rows, rest), usedIndex: idx.field };
    }
  }
  const all = await db.records.orderBy('created_at').toArray();
  return { records: applyFilter(all, g), usedIndex: null };
}
