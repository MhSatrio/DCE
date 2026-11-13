import { useMemo, useSyncExternalStore } from 'react';
import { slugify } from '../engine/binding';
import { uid } from '../engine/njs';
import { guard } from '../ui/store';
import { allFields, AUTO_TYPES, getValue } from './fields';
import { dependentsOf, hasRelations, propagate, recomputeTable, type Snapshot } from './links';
import { db, type ContentRecord, type FieldDef, type TableDef } from './schema';
import { CONTENT_NAME, CONTENT_TABLE, recordsStore, tablesStore } from './stores';

export { CONTENT_NAME, CONTENT_TABLE };
export const isContent = (t: string) => t === CONTENT_TABLE;

// ------------------------------------------------------------------ reading

export function fieldsOf(table: string): FieldDef[] {
  if (isContent(table)) return allFields(recordsStore.get().fields);
  return [...(tablesStore.get().fields[table] ?? [])].sort((a, b) => a.order - b.order);
}
export function recordsOf(table: string): ContentRecord[] {
  return isContent(table) ? recordsStore.get().records : tablesStore.get().rows[table] ?? [];
}
export function tableName(table: string): string {
  return isContent(table) ? CONTENT_NAME : tablesStore.get().tables.find((t) => t.id === table)?.name ?? 'Unknown table';
}
export function allTables(): { id: string; name: string }[] {
  return [{ id: CONTENT_TABLE, name: CONTENT_NAME }, ...tablesStore.get().tables.map((t) => ({ id: t.id, name: t.name }))];
}
export function primaryKey(table: string): string {
  return isContent(table) ? 'title' : fieldsOf(table)[0]?.key ?? 'name';
}
/** Human label of a record (for link chips and pickers). */
export function rowName(rec: ContentRecord, table = rec.table ?? CONTENT_TABLE): string {
  const v = getValue(rec, primaryKey(table));
  return v === undefined || v === null || v === '' ? '(untitled)' : String(v);
}
export function snapshot(): Snapshot {
  const s: Snapshot = { [CONTENT_TABLE]: { fields: fieldsOf(CONTENT_TABLE), records: recordsStore.get().records } };
  for (const t of tablesStore.get().tables) s[t.id] = { fields: fieldsOf(t.id), records: tablesStore.get().rows[t.id] ?? [] };
  return s;
}

/** React hook: records + fields of any table, re-rendering on change. */
export function useTableData(table: string): { records: ContentRecord[]; fields: FieldDef[]; loaded: boolean } {
  const a = useSyncExternalStore(recordsStore.subscribe, () => recordsStore.get());
  const b = useSyncExternalStore(tablesStore.subscribe, () => tablesStore.get());
  if (isContent(table)) return { records: a.records, fields: allFields(a.fields), loaded: a.loaded };
  return { records: b.rows[table] ?? [], fields: [...(b.fields[table] ?? [])].sort((x, y) => x.order - y.order), loaded: b.loaded };
}
export function useTableList(): TableDef[] {
  return useSyncExternalStore(tablesStore.subscribe, () => tablesStore.get()).tables;
}

/** id → display name for the records of the given tables (for link chips). Rebuilt only when data changes. */
export function useNameMaps(tableIds: string[]): Map<string, Map<string, string>> {
  const a = useSyncExternalStore(recordsStore.subscribe, () => recordsStore.get());
  const b = useSyncExternalStore(tablesStore.subscribe, () => tablesStore.get());
  const key = tableIds.join('|');
  return useMemo(() => {
    const out = new Map<string, Map<string, string>>();
    for (const t of tableIds) {
      const recs = isContent(t) ? a.records : b.rows[t] ?? [];
      out.set(t, new Map(recs.map((r) => [r.id, rowName(r, t)])));
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [a.records, b.rows, b.fields, key]);
}

// ------------------------------------------------------------------ loading

export async function loadTables(): Promise<void> {
  const [tables, rows, fields] = await Promise.all([db.userTables.orderBy('created_at').toArray(), db.rows.toArray(), db.fields.toArray()]);
  const byTable: Record<string, ContentRecord[]> = {};
  for (const r of rows) (byTable[r.table ?? ''] ??= []).push(r);
  for (const k of Object.keys(byTable)) byTable[k].sort((a, b) => a.created_at - b.created_at);
  const fby: Record<string, FieldDef[]> = {};
  for (const f of fields) if (f.tableId && f.tableId !== CONTENT_TABLE) (fby[f.tableId] ??= []).push(f);
  tablesStore.set({ tables, rows: byTable, fields: fby, loaded: true });
}

// ------------------------------------------------------------------ writing

export function newRow(table: string, partial: Partial<ContentRecord> = {}): ContentRecord {
  const now = Date.now();
  const base: ContentRecord = {
    id: uid(), title: '', slug: '', status: '', publish_date: '', content: '', image_asset: '', template_ref: '',
    tags: [], created_at: now, updated_at: now, data: {},
  };
  return { ...base, ...partial, ...(isContent(table) ? {} : { table }) };
}

async function persist(table: string, recs: ContentRecord[]): Promise<void> {
  const store = isContent(table) ? db.records : db.rows;
  for (let i = 0; i < recs.length; i += 500) await store.bulkPut(recs.slice(i, i + 500));
}

function setStoreRows(table: string, fn: (rows: ContentRecord[]) => ContentRecord[]): void {
  if (isContent(table)) recordsStore.set((s) => ({ records: fn(s.records) }));
  else tablesStore.set((s) => ({ rows: { ...s.rows, [table]: fn(s.rows[table] ?? []) } }));
}

function replaceById(rows: ContentRecord[], upd: ContentRecord[]): ContentRecord[] {
  if (!upd.length) return rows;
  const m = new Map(upd.map((r) => [r.id, r]));
  return rows.map((r) => m.get(r.id) ?? r);
}

/** Fills fields the app maintains itself (created / modified time, auto number). */
function stamp(table: string, recs: ContentRecord[], isNew: boolean, now: number): ContentRecord[] {
  const auto = fieldsOf(table).filter((f) => AUTO_TYPES.includes(f.type));
  if (!auto.length) return recs;
  const iso = new Date(now).toISOString();
  const counters = new Map<string, number>();
  for (const f of auto) if (f.type === 'autonumber') counters.set(f.key, Math.max(0, ...recordsOf(table).map((r) => Number(r.data?.[f.key]) || 0)));
  return recs.map((r) => {
    const data = { ...r.data };
    for (const f of auto) {
      if (f.type === 'modifiedTime') data[f.key] = iso;
      else if (isNew && f.type === 'createdTime') data[f.key] = iso;
      else if (isNew && f.type === 'autonumber') { const n = (counters.get(f.key) ?? 0) + 1; counters.set(f.key, n); data[f.key] = n; }
    }
    return { ...r, data };
  });
}

export interface WriteOpts { prev?: Map<string, ContentRecord>; removed?: string[]; label?: string; silent?: boolean }

/**
 * The single write path for every table: stamps, updates the in-memory store (instant UI), propagates link / sync
 * changes into other tables, then persists everything in bulk. On a storage error the stores are reloaded.
 */
export async function writeRows(table: string, updated: ContentRecord[], created: ContentRecord[] = [], opts: WriteOpts = {}): Promise<boolean> {
  const now = Date.now();
  const up = stamp(table, updated.map((r) => ({ ...r, updated_at: now })), false, now);
  const cr = stamp(table, created, true, now);
  setStoreRows(table, (rows) => [...replaceById(rows, up), ...cr]);
  const extra = propagate(snapshot(), table, [...up, ...cr], { prev: opts.prev, removed: opts.removed });
  const toPersist = new Map<string, Map<string, ContentRecord>>();
  const add = (t: string, rs: ContentRecord[]) => { let m = toPersist.get(t); if (!m) { m = new Map(); toPersist.set(t, m); } for (const r of rs) m.set(r.id, r); };
  add(table, [...up, ...cr]);
  for (const [t, rs] of extra) {
    const stamped = stamp(t, rs.map((r) => ({ ...r, updated_at: now })), false, now);
    setStoreRows(t, (rows) => replaceById(rows, stamped));
    add(t, stamped);
  }
  const ok = await guard(opts.label ?? 'Saving records', async () => {
    for (const [t, m] of toPersist) await persist(t, [...m.values()]);
    return true;
  });
  if (!ok) { await reloadAll(); return false; }
  return true;
}

export async function reloadAll(): Promise<void> {
  const [records, fields] = await Promise.all([db.records.orderBy('created_at').toArray(), db.fields.orderBy('order').toArray()]);
  recordsStore.set({ records, fields: fields.filter((f) => !f.tableId || f.tableId === CONTENT_TABLE), loaded: true });
  await loadTables();
}

export async function updateRow(table: string, id: string, patch: Partial<ContentRecord>): Promise<void> {
  const cur = recordsOf(table).find((r) => r.id === id);
  if (!cur) return;
  const next: ContentRecord = { ...cur, ...patch, data: patch.data ?? cur.data };
  await writeRows(table, [next], [], { prev: new Map([[id, cur]]), label: 'Saving record' });
}

export async function updateRowsWith(table: string, ids: string[], mutate: (r: ContentRecord) => ContentRecord): Promise<number> {
  const set = new Set(ids);
  const prev = new Map<string, ContentRecord>();
  const next: ContentRecord[] = [];
  for (const r of recordsOf(table)) if (set.has(r.id)) { prev.set(r.id, r); next.push(mutate(r)); }
  await writeRows(table, next, [], { prev, label: 'Bulk update' });
  return next.length;
}

export async function createRows(table: string, recs: ContentRecord[], upsert = false): Promise<boolean> {
  if (!upsert) return writeRows(table, [], recs, { label: 'Saving records' });
  const existing = new Map(recordsOf(table).map((r) => [r.id, r]));
  const updated = recs.filter((r) => existing.has(r.id)), created = recs.filter((r) => !existing.has(r.id));
  return writeRows(table, updated, created, { prev: existing, label: 'Saving records' });
}

export async function deleteRows(table: string, ids: string[]): Promise<void> {
  const set = new Set(ids);
  setStoreRows(table, (rows) => rows.filter((r) => !set.has(r.id)));
  const ok = await guard('Deleting records', async () => { await (isContent(table) ? db.records : db.rows).bulkDelete(ids); return true; });
  if (!ok) { await reloadAll(); return; }
  await writeRows(table, [], [], { removed: ids, label: 'Updating linked records' });
}

// ------------------------------------------------------------------ fields

export async function saveFieldIn(table: string, f: FieldDef): Promise<void> {
  const field: FieldDef = isContent(table) ? { ...f, tableId: undefined } : { ...f, tableId: table };
  await guard('Saving field', async () => { await db.fields.put(field); });
  if (isContent(table)) recordsStore.set((s) => ({ fields: [...s.fields.filter((x) => x.id !== field.id), field].sort((a, b) => a.order - b.order) }));
  else tablesStore.set((s) => ({ fields: { ...s.fields, [table]: [...(s.fields[table] ?? []).filter((x) => x.id !== field.id), field] } }));
  if (field.sync || field.type === 'link') {
    const extra = recomputeTable(snapshot(), table);
    for (const [t, rs] of extra) { setStoreRows(t, (rows) => replaceById(rows, rs)); await guard('Syncing fields', async () => { await persist(t, rs); }); }
  }
}

export async function deleteFieldIn(table: string, f: FieldDef, seen: Set<string> = new Set()): Promise<void> {
  if (seen.has(f.id)) return; // a link and its inverse depend on each other
  seen.add(f.id);
  const deps = hasRelations(snapshot()) ? dependentsOf(snapshot(), table, f) : [];
  for (const d of deps) await deleteFieldIn(d.table, d.field, seen);
  await guard('Deleting field', async () => {
    await db.fields.delete(f.id);
    const recs = recordsOf(table).filter((r) => f.key in r.data).map((r) => { const data = { ...r.data }; delete data[f.key]; return { ...r, data }; });
    await persist(table, recs);
  });
  await reloadAll();
}

export function dependentsFor(table: string, f: FieldDef) {
  return dependentsOf(snapshot(), table, f);
}

// ------------------------------------------------------------------ tables

export async function createTable(name: string): Promise<TableDef> {
  const t: TableDef = { id: uid(), name: name.trim() || 'Untitled table', created_at: Date.now() };
  await guard('Creating table', async () => {
    await db.userTables.put(t);
    await db.fields.put({ id: uid(), key: 'name', label: 'Name', type: 'text', order: 0, tableId: t.id });
  });
  await loadTables();
  return t;
}

export async function renameTable(id: string, name: string): Promise<void> {
  await db.userTables.update(id, { name: name.trim() || 'Untitled table' });
  await loadTables();
}

export async function deleteTable(id: string): Promise<void> {
  // remove link fields (and their inverse / synced copies) that point into this table
  const snap = snapshot();
  for (const [t, def] of Object.entries(snap)) for (const f of def.fields) if (f.type === 'link' && f.linkTable === id && t !== id) await deleteFieldIn(t, f);
  await guard('Deleting table', async () => {
    await db.rows.where('table').equals(id).delete();
    await db.fields.where('tableId').equals(id).delete();
    await db.userTables.delete(id);
    // automations that watch this table are removed (as before); those that only write to it are switched off
    for (const a of await db.automations.toArray()) {
      if (a.trigger.kind === 'record' && a.trigger.table === id) await db.automations.delete(a.id);
      else if (a.steps.some((s) => 'table' in s && s.table === id)) await db.automations.update(a.id, { enabled: false });
    }
  });
  await reloadAll();
}

/** Creates a link field in `table` pointing at `target`, plus the matching inverse field on the other side. */
export async function createLinkPair(table: string, label: string, target: string, orderA: number): Promise<{ a: FieldDef; b: FieldDef }> {
  const keyIn = (t: string, base: string) => {
    const taken = new Set(fieldsOf(t).map((f) => f.key));
    let k = slugify(base).replace(/-/g, '_') || 'link', i = 2;
    const root = k;
    while (taken.has(k)) k = `${root}_${i++}`;
    return k;
  };
  const aKey = keyIn(table, label);
  const bLabel = tableName(table);
  const bKey = keyIn(target, bLabel === label && table === target ? `${bLabel} (inverse)` : bLabel);
  const a: FieldDef = { id: uid(), key: aKey, label, type: 'link', linkTable: target, inverseKey: bKey, order: orderA };
  const b: FieldDef = { id: uid(), key: bKey, label: table === target ? `${label} (inverse)` : bLabel, type: 'link', linkTable: table, inverseKey: aKey, order: fieldsOf(target).length + 10 };
  await saveFieldIn(table, a);
  if (!(table === target && aKey === bKey)) await saveFieldIn(target, b);
  return { a, b };
}
