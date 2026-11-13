import { slugify } from '../engine/binding';
import { uid } from '../engine/njs';
import { coerce, BUILTIN_FIELDS, STATUSES } from './fields';
import type { ContentRecord, FieldDef, FieldType } from './schema';

export interface ColumnMapping {
  column: number;
  header: string;
  /** field key, '' = skip, '__new__' = create a custom field from the header */
  target: string;
  newType?: FieldType;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

const SYNONYMS: Record<string, string> = {
  name: 'title', producttitle: 'title', productname: 'title', heading: 'title',
  image: 'image_asset', imageref: 'image_asset', imageasset: 'image_asset', imageassetref: 'image_asset', photo: 'image_asset', productimage: 'image_asset',
  date: 'publish_date', publishdate: 'publish_date', publishedat: 'publish_date', publishon: 'publish_date',
  template: 'template_ref', templateref: 'template_ref', templateid: 'template_ref',
  body: 'content', text: 'content', markdown: 'content', recordid: 'id',
};

export function autoMap(headers: string[], fields: FieldDef[]): ColumnMapping[] {
  const byNorm = new Map<string, string>();
  for (const f of [...fields, ...BUILTIN_FIELDS]) { byNorm.set(norm(f.key), f.key); byNorm.set(norm(f.label), f.key); }
  const used = new Set<string>();
  return headers.map((h, column) => {
    const n = norm(h);
    let target = byNorm.get(n) ?? SYNONYMS[n] ?? '';
    if (target && used.has(target)) target = '';
    if (target) used.add(target);
    return { column, header: h, target: target || (h.trim() ? '__new__' : ''), newType: 'text' as FieldType };
  });
}

export interface ImportOptions {
  fields: FieldDef[];                    // existing custom fields
  assetByName?: Map<string, string>;     // lower-case name → id
  templateByName?: Map<string, string>;
  existingSlugs?: Set<string>;
  existingIds?: Set<string>;
}

export interface ImportPlan {
  records: ContentRecord[];
  newFields: FieldDef[];
  extendedFields: FieldDef[];
  errors: { row: number; message: string }[];
  empty: number;
  updates: number;
}

export function buildRecords(rows: string[][], mapping: ColumnMapping[], opts: ImportOptions): ImportPlan {
  const now = Date.now();
  const customByKey = new Map(opts.fields.map((f) => [f.key, f]));
  const newFields: FieldDef[] = [];
  const keys = new Set([...customByKey.keys()]);
  let order = Math.max(10, ...opts.fields.map((f) => f.order + 1));

  // resolve targets (creating custom fields where asked)
  const targets: { col: number; field: FieldDef }[] = [];
  for (const m of mapping) {
    if (!m.target) continue;
    if (m.target === '__new__') {
      let key = slugify(m.header).replace(/-/g, '_') || `field_${m.column + 1}`;
      if (/^\d/.test(key)) key = 'f_' + key;
      let k = key, i = 2;
      while (keys.has(k) || BUILTIN_FIELDS.some((b) => b.key === k)) k = `${key}_${i++}`;
      keys.add(k);
      const f: FieldDef = { id: uid(), key: k, label: m.header.trim(), type: m.newType ?? 'text', order: order++ };
      newFields.push(f);
      targets.push({ col: m.column, field: f });
    } else {
      const f = customByKey.get(m.target) ?? BUILTIN_FIELDS.find((b) => b.key === m.target);
      if (f) targets.push({ col: m.column, field: f });
    }
  }

  const slugs = new Set(opts.existingSlugs ?? []);
  const errors: ImportPlan['errors'] = [];
  const records: ContentRecord[] = [];
  const extended = new Map<string, FieldDef>();
  let empty = 0, updates = 0;

  rows.forEach((cells, idx) => {
    const rowNo = idx + 2; // 1-based, header is row 1
    const rec: ContentRecord = {
      id: uid(), title: '', slug: '', status: 'Draft', publish_date: '', content: '', image_asset: '', template_ref: '',
      tags: [], created_at: now, updated_at: now, data: {},
    };
    let any = false;
    let bad = false;
    for (const { col, field } of targets) {
      const raw = (cells[col] ?? '').trim();
      if (raw !== '') any = true;
      if (field.key === 'id') { if (raw) rec.id = raw; continue; }
      if (field.readonly) continue;
      let value: unknown;
      if ((field.type === 'image' || field.type === 'relation') && raw) {
        const lower = raw.toLowerCase();
        value = field.relationTo === 'templates' ? (opts.templateByName?.get(lower) ?? raw) : (opts.assetByName?.get(lower) ?? raw);
      } else {
        const c = coerce(raw, field);
        if (c.error && field.type === 'select' && field.options && !field.builtin) {
          // grow the option list instead of rejecting the row
          const ext = extended.get(field.key) ?? { ...field, options: [...(field.options ?? [])] };
          ext.options!.push(raw); extended.set(field.key, ext);
          value = raw;
        } else if (c.error) {
          errors.push({ row: rowNo, message: `${field.label}: ${c.error}` });
          bad = true; value = c.value;
        } else value = c.value;
      }
      if (field.builtin) (rec as Record<string, unknown>)[field.key] = value;
      else rec.data[field.key] = value;
    }
    if (!any) { empty++; return; }
    if (!rec.title.trim()) { errors.push({ row: rowNo, message: 'Title is empty' }); bad = true; }
    if (!rec.status) rec.status = 'Draft';
    else { const known = STATUSES.find((s) => s.toLowerCase() === rec.status.toLowerCase()); if (known) rec.status = known; }
    if (bad) return;
    if (!rec.slug) rec.slug = slugify(rec.title);
    let s = rec.slug, n = 2;
    while (slugs.has(s)) s = `${rec.slug}-${n++}`;
    rec.slug = s; slugs.add(s);
    if (opts.existingIds?.has(rec.id)) updates++;
    records.push(rec);
  });

  return { records, newFields, extendedFields: [...extended.values()], errors, empty, updates };
}

/** JSON array (or {records:[…]}) of objects → header row + string rows, so CSV and JSON share one pipeline. */
export function jsonToTable(text: string): { headers: string[]; rows: string[][] } {
  let data: unknown;
  try { data = JSON.parse(text); } catch (e) { throw new Error('Not valid JSON: ' + (e instanceof Error ? e.message : String(e))); }
  const arr = Array.isArray(data) ? data : (data && typeof data === 'object' && Array.isArray((data as { records?: unknown }).records)) ? (data as { records: unknown[] }).records : null;
  if (!arr) throw new Error('Expected a JSON array of records (or an object with a "records" array).');
  const headers: string[] = [];
  const flat = arr.map((o) => {
    if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('Every record must be a JSON object.');
    const r: Record<string, string> = {};
    const put = (k: string, v: unknown) => {
      if (!headers.includes(k)) headers.push(k);
      r[k] = v === null || v === undefined ? '' : Array.isArray(v) ? v.join('; ') : typeof v === 'object' ? JSON.stringify(v) : String(v);
    };
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      if (k === 'data' && v && typeof v === 'object' && !Array.isArray(v)) { for (const [dk, dv] of Object.entries(v)) put(dk, dv); } else put(k, v);
    }
    return r;
  });
  return { headers, rows: flat.map((r) => headers.map((h) => r[h] ?? '')) };
}
