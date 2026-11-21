import { useMemo, useSyncExternalStore } from 'react';
import { slugify } from '../engine/binding';
import { uid } from '../engine/njs';
import { createStore, guard } from '../ui/store';
import { allFields, AUTO_TYPES, getValue } from './fields';
import { assignPositions, byPosition, POSITION_STEP, positionAfter } from './order';
import { dependentsOf, hasRelations, propagate, recomputeTable, type Snapshot } from './links';
import { db, getSetting, setSetting, type ContentRecord, type FieldDef, type TableDef } from './schema';
import { CONTENT_NAME_KEY, DEFAULT_CONTENT_NAME } from './constants';
import { CONTENT_TABLE, recordsStore, tablesStore } from './stores';

export { CONTENT_TABLE };
export const isContent = (t: string) => t === CONTENT_TABLE;

// ------------------------------------------------------------------ reading

export function fieldsOf(table: string): FieldDef[] {
  if (isContent(table)) return allFields(recordsStore.get().fields);
  return [...(tablesStore.get().fields[table] ?? [])].sort((a, b) => a.order - b.order);
}
/** The fields as they are stored: a built-in field only where it was changed. Undo and moves work on this list. */
export function storedFieldsOf(table: string): FieldDef[] {
  return isContent(table) ? recordsStore.get().fields : [...(tablesStore.get().fields[table] ?? [])];
}

export function recordsOf(table: string): ContentRecord[] {
  return isContent(table) ? recordsStore.get().records : tablesStore.get().rows[table] ?? [];
}
export function tableName(table: string): string {
  return isContent(table) ? tablesStore.get().contentName : tablesStore.get().tables.find((t) => t.id === table)?.name ?? 'Unknown table';
}
export function allTables(): { id: string; name: string }[] {
  return [{ id: CONTENT_TABLE, name: tablesStore.get().contentName }, ...tablesStore.get().tables.map((t) => ({ id: t.id, name: t.name }))];
}
/**
 * The Master Field of a table: the field that names its records (shown first, frozen while scrolling, and used when
 * another table links to them). Default: the leftmost field. "Set as Master Field" stores a choice per table.
 */
export const MASTERS_KEY = 'tables.masters';
let masters: Record<string, string> = {};

export function masterKeyOf(table: string): string {
  const fields = fieldsOf(table);
  const chosen = masters[table];
  if (chosen && fields.some((f) => f.key === chosen)) return chosen;
  if (isContent(table)) return fields.some((f) => f.key === 'title') ? 'title' : fields[0]?.key ?? 'title';
  return fields[0]?.key ?? 'name';
}

export function primaryKey(table: string): string {
  return masterKeyOf(table);
}

/** Makes a field the Master Field. A synced field cannot be the master: its value comes from another table. */
export async function setMaster(table: string, key: string): Promise<void> {
  const f = fieldsOf(table).find((x) => x.key === key);
  if (!f) throw new Error('That field does not exist.');
  if (f.sync) throw new Error(`“${f.label}” is a synced field, so it cannot be the Master Field. Choose a field of its own.`);
  masters = { ...masters, [table]: key };
  await setSetting(MASTERS_KEY, masters);
  tablesStore.set((s) => ({ fields: s.fields }));
  recordsStore.set((s) => ({ fields: s.fields }));
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
  for (const k of Object.keys(byTable)) {
    const fixed = assignPositions(byTable[k]);       // rows from before positions were kept get one, once
    if (fixed.length) await db.rows.bulkPut(fixed);
    byTable[k].sort(byPosition);
  }
  const fby: Record<string, FieldDef[]> = {};
  for (const f of fields) if (f.tableId && f.tableId !== CONTENT_TABLE) (fby[f.tableId] ??= []).push(f);
  masters = await getSetting<Record<string, string>>(MASTERS_KEY, {});
  const contentName = await getSetting<string>(CONTENT_NAME_KEY, DEFAULT_CONTENT_NAME);
  tablesStore.set({ tables, rows: byTable, fields: fby, contentName: contentName || DEFAULT_CONTENT_NAME, loaded: true });
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
  return inChange(opts.label ?? 'Saving records', () => writeRowsNow(table, updated, created, opts));
}

async function writeRowsNow(table: string, updated: ContentRecord[], created: ContentRecord[], opts: WriteOpts): Promise<boolean> {
  const now = Date.now();
  const up = stamp(table, updated.map((r) => ({ ...r, updated_at: now })), false, now);
  // a new row goes to the end of its table, in the order it was given
  const base = positionAfter(recordsOf(table));
  const cr = stamp(table, created.map((r, i) => (r.position === undefined ? { ...r, position: base + i * POSITION_STEP } : r)), true, now);
  captureRows(table);
  setStoreRows(table, (rows) => (cr.length ? [...replaceById(rows, up), ...cr].sort(byPosition) : replaceById(rows, up)));
  const extra = propagate(snapshot(), table, [...up, ...cr], { prev: opts.prev, removed: opts.removed });
  const toPersist = new Map<string, Map<string, ContentRecord>>();
  const add = (t: string, rs: ContentRecord[]) => { let m = toPersist.get(t); if (!m) { m = new Map(); toPersist.set(t, m); } for (const r of rs) m.set(r.id, r); };
  add(table, [...up, ...cr]);
  for (const [t, rs] of extra) {
    const stamped = stamp(t, rs.map((r) => ({ ...r, updated_at: now })), false, now);
    captureRows(t);
    setStoreRows(t, (rows) => replaceById(rows, stamped));
    add(t, stamped);
  }
  const ok = await guard(opts.label ?? 'Saving records', async () => {
    for (const [t, m] of toPersist) await persist(t, [...m.values()]);
    return true;
  });
  if (!ok) { await reloadAll(); return false; }
  // hooks run after the rows are saved (a carousel table uses one to stay in step with its source); a hook never undoes a write
  for (const t of new Set([table, ...extra.keys()])) for (const h of writeHooks) { try { await h(t); } catch { /* ignored: the write itself succeeded */ } }
  return true;
}

const writeHooks: ((table: string) => Promise<void>)[] = [];
/** Registers a function that runs after rows of any table are written. */
export function onTableWritten(fn: (table: string) => Promise<void>): void {
  writeHooks.push(fn);
}

export async function reloadAll(): Promise<void> {
  const [records, fields] = await Promise.all([db.records.toArray(), db.fields.toArray()]);
  const fixed = assignPositions(records);
  if (fixed.length) await db.records.bulkPut(fixed);
  records.sort(byPosition);
  recordsStore.set({ records, fields: fields.filter((f) => !f.tableId || f.tableId === CONTENT_TABLE).sort((a, b) => a.order - b.order), loaded: true });
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

export async function createRows(table: string, recs: ContentRecord[], upsert = false, label = 'Saving records'): Promise<boolean> {
  if (!upsert) return writeRows(table, [], recs, { label });
  const existing = new Map(recordsOf(table).map((r) => [r.id, r]));
  const updated = recs.filter((r) => existing.has(r.id)), created = recs.filter((r) => !existing.has(r.id));
  return writeRows(table, updated, created, { prev: existing, label });
}

export async function deleteRows(table: string, ids: string[]): Promise<void> {
  await inChange('Delete records', async () => {
    const set = new Set(ids);
    captureRows(table);
    setStoreRows(table, (rows) => rows.filter((r) => !set.has(r.id)));
    const ok = await guard('Deleting records', async () => { await (isContent(table) ? db.records : db.rows).bulkDelete(ids); return true; });
    if (!ok) { await reloadAll(); return; }
    await writeRows(table, [], [], { removed: ids, label: 'Updating linked records' });
  });
}

// ------------------------------------------------------------------ undo and redo (Ctrl+Z, Ctrl+Shift+Z)

/** What one action changed: the rows and fields of each table as they were before it. */
interface Change { label: string; rows: Map<string, ContentRecord[]>; fields: Map<string, FieldDef[]> }
const MAX_HISTORY = 100;
const past: Change[] = [];
const future: Change[] = [];
let group: Change | null = null;
/** The label of the action that undo / redo would reverse ('' when there is none). Screens subscribe to it. */
export const historyStore = createStore({ undo: '', redo: '' });
const publishHistory = () => historyStore.set({ undo: past.at(-1)?.label ?? '', redo: future.at(-1)?.label ?? '' });

/** The rows of a table before the current action (only the first capture counts). */
function captureRows(t: string): void {
  if (group && !group.rows.has(t)) group.rows.set(t, [...recordsOf(t)]);
}
function captureFields(t: string): void {
  if (group && !group.fields.has(t)) group.fields.set(t, [...storedFieldsOf(t)]);
}

/** Runs one user action. Nested actions join the outer one, so the whole action is undone in one step. */
async function inChange<T>(label: string, fn: () => Promise<T>): Promise<T> {
  if (group) return fn();
  const g: Change = { label, rows: new Map(), fields: new Map() };
  group = g;
  try { return await fn(); }
  finally {
    group = null;
    if (g.rows.size || g.fields.size) {
      past.push(g);
      if (past.length > MAX_HISTORY) past.shift();
      future.length = 0;
      publishHistory();
    }
  }
}

/** Puts a change back into the stores and the database. Returns the change that would reverse it (for redo). */
async function applyChange(c: Change): Promise<Change> {
  const back: Change = { label: c.label, rows: new Map(), fields: new Map() };
  for (const t of c.rows.keys()) back.rows.set(t, [...recordsOf(t)]);
  for (const t of c.fields.keys()) back.fields.set(t, [...storedFieldsOf(t)]);
  for (const [t, prev] of c.rows) {
    const cur = recordsOf(t);
    const curById = new Map(cur.map((r) => [r.id, r]));
    const prevIds = new Set(prev.map((r) => r.id));
    const toPut = prev.filter((r) => curById.get(r.id) !== r);            // changed, deleted or added back
    const toDelete = cur.filter((r) => !prevIds.has(r.id)).map((r) => r.id); // added by the action
    setStoreRows(t, () => prev);
    await guard('Undo', async () => {
      const store = isContent(t) ? db.records : db.rows;
      if (toDelete.length) await store.bulkDelete(toDelete);
      await persist(t, toPut);
      return true;
    });
  }
  for (const [t, prev] of c.fields) {
    const cur = storedFieldsOf(t);
    const want = prev;
    const curById = new Map(cur.map((f) => [f.id, f]));
    const wantIds = new Set(want.map((f) => f.id));
    const toPut = want.filter((f) => curById.get(f.id) !== f);
    const toDelete = cur.filter((f) => !wantIds.has(f.id)).map((f) => f.id);
    if (isContent(t)) recordsStore.set(() => ({ fields: want.sort((a, b) => a.order - b.order) }));
    else tablesStore.set((s) => ({ fields: { ...s.fields, [t]: [...want] } }));
    await guard('Undo', async () => {
      if (toDelete.length) await db.fields.bulkDelete(toDelete);
      if (toPut.length) await db.fields.bulkPut(toPut);
      return true;
    });
  }
  for (const t of new Set([...c.rows.keys(), ...c.fields.keys()])) for (const h of writeHooks) { try { await h(t); } catch { /* the change itself is in place */ } }
  return back;
}

/** Reverses the last action. Returns its label, or null when there is nothing to undo. */
export async function undoChange(): Promise<string | null> {
  const c = past.pop();
  if (!c) return null;
  const back = await applyChange(c);
  future.push(back);
  publishHistory();
  return c.label;
}

/** Repeats the action that was undone. Returns its label, or null when there is nothing to redo. */
export async function redoChange(): Promise<string | null> {
  const c = future.pop();
  if (!c) return null;
  const back = await applyChange(c);
  past.push(back);
  publishHistory();
  return c.label;
}

// ------------------------------------------------------------------ fields

export async function saveFieldIn(table: string, f: FieldDef): Promise<void> {
  if (f.sync && masterKeyOf(table) === f.key) throw new Error(`“${f.label}” is the Master Field of this table, so it cannot become a synced field. Set another field as the Master Field first.`);
  const existed = fieldsOf(table).some((x) => x.id === f.id);
  await inChange(existed ? 'Change field' : 'Add field', async () => {
    const field: FieldDef = isContent(table) ? { ...f, tableId: undefined } : { ...f, tableId: table };
    captureFields(table);
    await guard('Saving field', async () => { await db.fields.put(field); });
    if (isContent(table)) recordsStore.set((s) => ({ fields: [...s.fields.filter((x) => x.id !== field.id), field].sort((a, b) => a.order - b.order) }));
    else tablesStore.set((s) => ({ fields: { ...s.fields, [table]: [...(s.fields[table] ?? []).filter((x) => x.id !== field.id), field] } }));
    if (field.sync || field.type === 'link') {
      const extra = recomputeTable(snapshot(), table);
      for (const [t, rs] of extra) { captureRows(t); setStoreRows(t, (rows) => replaceById(rows, rs)); await guard('Syncing fields', async () => { await persist(t, rs); }); }
    }
  });
}

/** Writes several fields in one go. The caller records the change for undo. */
async function saveFieldsNow(table: string, list: FieldDef[]): Promise<void> {
  const rows = list.map((f) => (isContent(table) ? { ...f, tableId: undefined } : { ...f, tableId: table }));
  const ids = new Set(rows.map((r) => r.id));
  await guard('Saving fields', async () => { await db.fields.bulkPut(rows); return true; });
  if (isContent(table)) recordsStore.set((s) => ({ fields: [...s.fields.filter((x) => !ids.has(x.id)), ...rows].sort((a, b) => a.order - b.order) }));
  else tablesStore.set((s) => ({ fields: { ...s.fields, [table]: [...(s.fields[table] ?? []).filter((x) => !ids.has(x.id)), ...rows] } }));
}

/**
 * Moves a field one place left (dir -1) or right (+1), past the neighbour that is shown. `shown` is the keys of the shown
 * fields in order (hidden fields do not count). A built-in field keeps its name and type; only its place is stored.
 */
export async function moveFieldIn(table: string, key: string, dir: -1 | 1, shown: string[]): Promise<void> {
  const i = shown.indexOf(key), j = i + dir;
  if (i < 0 || j < 0 || j >= shown.length) return;
  const order = [...fieldsOf(table)];                    // the display order
  const a = order.findIndex((f) => f.key === key), b = order.findIndex((f) => f.key === shown[j]);
  if (a < 0 || b < 0) return;
  const moved = new Map<string, number>();               // field id → its new order
  if (order[a].order !== order[b].order) {
    moved.set(order[a].id, order[b].order);
    moved.set(order[b].id, order[a].order);
  } else {                                               // equal orders cannot be swapped: number the whole list again
    [order[a], order[b]] = [order[b], order[a]];
    order.forEach((f, k) => moved.set(f.id, (k + 1) * 10));
  }
  const stored = storedFieldsOf(table);
  const changed: FieldDef[] = [];
  for (const [id, to] of moved) {
    const base = stored.find((x) => x.id === id);
    if (base) { changed.push({ ...base, order: to }); continue; }
    const builtin = order.find((x) => x.id === id);      // a built-in field never changed before: an override with its place only
    if (builtin?.builtin) changed.push({ id, key: builtin.key, type: builtin.type, label: '', builtin: true, order: to });
  }
  if (!changed.length) return;
  await inChange('Move field', async () => {
    captureFields(table);
    await saveFieldsNow(table, changed);
  });
}

/** Moves a row one place up (dir -1) or down (+1) in its table. The other rows keep their places. */
export async function moveRowIn(table: string, id: string, dir: -1 | 1): Promise<void> {
  const list = recordsOf(table);
  const i = list.findIndex((r) => r.id === id), j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return;
  const a = list[i], b = list[j];
  if (a.position === undefined || b.position === undefined || a.position === b.position) return;
  await inChange('Move row', async () => {
    captureRows(table);
    const na: ContentRecord = { ...a, position: b.position }, nb: ContentRecord = { ...b, position: a.position };
    setStoreRows(table, (rows) => replaceById(rows, [na, nb]).sort(byPosition));
    await guard('Moving row', async () => { await persist(table, [na, nb]); return true; });
  });
}

export async function deleteFieldIn(table: string, f: FieldDef, seen: Set<string> = new Set()): Promise<void> {
  if (f.builtin) throw new Error(`“${f.label}” is a built-in field of the Content Plan, so it cannot be deleted. You can rename it or hide it.`);
  await inChange('Delete field', () => deleteFieldRec(table, f, seen));
}

async function deleteFieldRec(table: string, f: FieldDef, seen: Set<string>): Promise<void> {
  if (seen.has(f.id)) return; // a link and its inverse depend on each other
  seen.add(f.id);
  const deps = hasRelations(snapshot()) ? dependentsOf(snapshot(), table, f) : [];
  for (const d of deps) await deleteFieldRec(d.table, d.field, seen);
  captureFields(table);
  captureRows(table);
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
  const clean = name.trim() || (isContent(id) ? DEFAULT_CONTENT_NAME : 'Untitled table');
  if (isContent(id)) {
    await setSetting(CONTENT_NAME_KEY, clean);
    tablesStore.set({ contentName: clean });
    return;
  }
  await db.userTables.update(id, { name: clean });
  await loadTables();
}

export async function deleteTable(id: string): Promise<void> {
  if (isContent(id)) throw new Error('The Content Plan cannot be deleted. Clear its records or fields instead.');
  // templates that drew their records from this table draw from the Content Plan from now on
  for (const t of await db.templates.toArray()) {
    if ((t.doc.meta as { dataTable?: string }).dataTable === id) await db.templates.update(t.id, { doc: { ...t.doc, meta: { ...t.doc.meta, dataTable: CONTENT_TABLE } } });
  }
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
