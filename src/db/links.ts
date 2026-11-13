import { getValue } from './fields';
import type { ContentRecord, FieldDef } from './schema';

/**
 * Cross-table consistency, as in Airtable:
 *  • link fields are two-sided — linking A→B also links B→A (the inverse field);
 *  • synced fields mirror a field of the linked record: change it in either table and the other follows.
 * Everything here is pure: it takes a snapshot of all tables and returns the extra records that must change.
 */
export type Snapshot = Record<string, { fields: FieldDef[]; records: ContentRecord[] }>;

const same = (a: unknown, b: unknown) => {
  const n = (v: unknown) => (v === undefined || v === null ? '' : v);
  return JSON.stringify(n(a)) === JSON.stringify(n(b));
};
const ids = (rec: ContentRecord, f: FieldDef): string[] => {
  const v = rec.data?.[f.key];
  return Array.isArray(v) ? (v as string[]) : [];
};

export function withValue(rec: ContentRecord, f: FieldDef, value: unknown): ContentRecord {
  if (f.builtin) return { ...rec, [f.key]: value } as ContentRecord;
  return { ...rec, data: { ...rec.data, [f.key]: value } };
}

const emptyFor = (f: FieldDef): unknown => (f.type === 'multiselect' || f.type === 'link' ? [] : f.type === 'boolean' ? false : f.type === 'number' || f.type === 'currency' || f.type === 'percent' || f.type === 'rating' ? '' : '');

/** True when any table has a link or synced field — otherwise writes skip this machinery entirely. */
export function hasRelations(snap: Snapshot): boolean {
  return Object.values(snap).some((t) => t.fields.some((f) => f.type === 'link' || f.sync));
}

export interface PropagateOptions {
  /** Previous versions of the changed records (enables write-through of edited synced fields). */
  prev?: Map<string, ContentRecord>;
  /** Ids of records just deleted from `table`. */
  removed?: string[];
}

/**
 * @param changed records of `table` that were just written (the snapshot already contains their new versions)
 * @returns table id → records that must additionally be written (other tables, and synced copies in this one)
 */
export function propagate(snap: Snapshot, table: string, changed: ContentRecord[], opts: PropagateOptions = {}): Map<string, ContentRecord[]> {
  const out = new Map<string, ContentRecord[]>();
  if (!hasRelations(snap)) return out;

  const idx = new Map<string, Map<string, ContentRecord>>();
  const index = (t: string) => {
    let m = idx.get(t);
    if (!m) { m = new Map((snap[t]?.records ?? []).map((r) => [r.id, r])); idx.set(t, m); }
    return m;
  };
  const work = new Map<string, Map<string, ContentRecord>>();
  const cur = (t: string, id: string) => work.get(t)?.get(id) ?? index(t).get(id);
  const all = (t: string): ContentRecord[] => {
    const base = snap[t]?.records ?? [];
    const w = work.get(t);
    return w && w.size ? base.map((r) => w.get(r.id) ?? r) : base;
  };
  const queue: [string, string][] = [];
  const put = (t: string, rec: ContentRecord) => {
    let m = work.get(t);
    if (!m) { m = new Map(); work.set(t, m); }
    m.set(rec.id, rec);
    queue.push([t, rec.id]);
  };
  const fieldsOf = (t: string) => snap[t]?.fields ?? [];
  const fieldByKey = (t: string, key: string) => fieldsOf(t).find((f) => f.key === key);

  // value a synced field should hold for record `v`
  const mirrored = (v: ContentRecord, f: FieldDef): { value: unknown } | null => {
    const via = fieldByKey(v.table ?? 'content', f.sync!.via);
    if (!via?.linkTable) return null;
    const src = fieldByKey(via.linkTable, f.sync!.source);
    if (!src) return null;
    const targets = ids(v, via).map((id) => cur(via.linkTable!, id)).filter((x): x is ContentRecord => !!x);
    return { value: targets.length ? getValue(targets[0], src.key) : emptyFor(src) };
  };
  const refresh = (t: string, v: ContentRecord, f: FieldDef): ContentRecord => {
    const m = mirrored(v, f);
    if (!m || same(getValue(v, f.key), m.value)) return v;
    const next = withValue(v, f, m.value);
    put(t, next);
    return next;
  };

  // 0. deleted records: strip their ids from every link field that pointed at them
  if (opts.removed?.length) {
    const gone = new Set(opts.removed);
    for (const [t, def] of Object.entries(snap)) for (const L of def.fields) {
      if (L.type !== 'link' || L.linkTable !== table) continue;
      for (const r of all(t)) if (ids(r, L).some((x) => gone.has(x))) put(t, withValue(r, L, ids(r, L).filter((x) => !gone.has(x))));
    }
  }

  // 1. write-through: an edited synced field changes the source field of its linked record
  if (opts.prev) {
    for (const R of changed) {
      const P = opts.prev.get(R.id);
      if (!P) continue;
      for (const F of fieldsOf(table).filter((f) => f.sync)) {
        if (same(getValue(R, F.key), getValue(P, F.key))) continue;
        const via = fieldByKey(table, F.sync!.via);
        const src = via?.linkTable ? fieldByKey(via.linkTable, F.sync!.source) : undefined;
        const target = via?.linkTable ? cur(via.linkTable, ids(R, via)[0] ?? '') : undefined;
        if (via?.linkTable && src && target && !src.readonly && !same(getValue(target, src.key), getValue(R, F.key))) {
          put(via.linkTable, withValue(target, src, getValue(R, F.key)));
        }
      }
    }
  }
  for (const R of changed) queue.push([table, R.id]);

  let guard = 0;
  while (queue.length && guard++ < 200000) {
    const [t, id] = queue.shift()!;
    let R = cur(t, id);
    if (!R) continue;

    // 2. keep both sides of every link field consistent
    for (const L of fieldsOf(t)) {
      if (L.type !== 'link' || !L.linkTable || !L.inverseKey) continue;
      const U = L.linkTable;
      const inv = fieldByKey(U, L.inverseKey);
      if (!inv) continue;
      const desired = new Set(ids(R, L));
      for (const uid of desired) {
        const u = cur(U, uid);
        if (u && !ids(u, inv).includes(R.id)) put(U, withValue(u, inv, [...ids(u, inv), R.id]));
      }
      for (const u of all(U)) if (!desired.has(u.id) && ids(u, inv).includes(R.id)) put(U, withValue(u, inv, ids(u, inv).filter((x) => x !== R!.id)));
    }

    // 3. this record's own synced fields follow its links
    for (const F of fieldsOf(t)) if (F.sync) R = refresh(t, R, F);

    // 4. synced fields elsewhere that mirror THIS record
    for (const [v, def] of Object.entries(snap)) for (const F of def.fields) {
      if (!F.sync) continue;
      const via = def.fields.find((f) => f.key === F.sync!.via);
      if (via?.linkTable !== t) continue;
      for (const row of all(v)) if (ids(row, via).includes(R.id)) refresh(v, row, F);
    }
  }

  for (const [t, m] of work) out.set(t, [...m.values()]);
  return out;
}

/** Recomputes every synced field of one table from scratch (after creating or re-pointing a synced field). */
export function recomputeTable(snap: Snapshot, table: string): Map<string, ContentRecord[]> {
  const recs = snap[table]?.records ?? [];
  return propagate(snap, table, recs);
}

/** Fields that stop making sense when `f` is removed (synced copies of it, and its inverse). */
export function dependentsOf(snap: Snapshot, table: string, f: FieldDef): { table: string; field: FieldDef }[] {
  const out: { table: string; field: FieldDef }[] = [];
  for (const [t, def] of Object.entries(snap)) for (const g of def.fields) {
    if (g.sync && ((t === table && g.sync.via === f.key) || (f.type !== 'link' && g.sync.source === f.key && def.fields.find((x) => x.key === g.sync!.via)?.linkTable === table))) out.push({ table: t, field: g });
    if (f.type === 'link' && f.inverseKey && t === f.linkTable && g.key === f.inverseKey) out.push({ table: t, field: g });
  }
  return out;
}
