import { slugify } from '../engine/binding';
import { parseAmount } from './formula';
import type { ContentRecord, FieldDef, FieldType } from './schema';

export const STATUSES = ['Idea', 'Draft', 'In review', 'Approved', 'Ready to post', 'Posted', 'Published'];

export const FIELD_TYPE_LABEL: Record<FieldType, string> = {
  text: 'Text', longtext: 'Long text', number: 'Number', boolean: 'Boolean', date: 'Date',
  select: 'Single select', multiselect: 'Multi-select', url: 'URL', image: 'Image', relation: 'Template link',
  markdown: 'Markdown', json: 'JSON', email: 'Email', phone: 'Phone number', currency: 'Currency', percent: 'Percent',
  rating: 'Rating', datetime: 'Date & time', link: 'Link to another table', createdTime: 'Created time',
  modifiedTime: 'Last modified time', autonumber: 'Auto number', formula: 'Formula',
};

/** Types whose value the app fills in itself. */
export const AUTO_TYPES: FieldType[] = ['createdTime', 'modifiedTime', 'autonumber'];

export const BUILTIN_FIELDS: FieldDef[] = [
  { id: 'b_title', key: 'title', label: 'Title', type: 'text', builtin: true, order: 0 },
  { id: 'b_status', key: 'status', label: 'Status', type: 'select', builtin: true, options: STATUSES, defaultValue: 'Draft', order: 1 },
  { id: 'b_publish', key: 'publish_date', label: 'Publish Date', type: 'date', builtin: true, order: 2 },
  { id: 'b_image', key: 'image_asset', label: 'Image Asset', type: 'image', builtin: true, relationTo: 'assets', order: 3 },
  { id: 'b_template', key: 'template_ref', label: 'Template', type: 'relation', builtin: true, relationTo: 'templates', order: 4 },
  { id: 'b_tags', key: 'tags', label: 'Tags', type: 'multiselect', builtin: true, order: 5 },
  { id: 'b_slug', key: 'slug', label: 'Slug', type: 'text', builtin: true, order: 6 },
  { id: 'b_content', key: 'content', label: 'Content', type: 'markdown', builtin: true, hiddenByDefault: true, order: 7 },
  { id: 'b_id', key: 'id', label: 'Record ID', type: 'text', builtin: true, readonly: true, hiddenByDefault: true, order: 100 },
  { id: 'b_created', key: 'created_at', label: 'Created At', type: 'date', builtin: true, readonly: true, hiddenByDefault: true, order: 101 },
  { id: 'b_updated', key: 'updated_at', label: 'Updated At', type: 'date', builtin: true, readonly: true, hiddenByDefault: true, order: 102 },
];

const BUILTIN_KEYS = new Set(BUILTIN_FIELDS.map((f) => f.key));
export const isBuiltinKey = (k: string) => BUILTIN_KEYS.has(k);

/**
 * The fields of the Content Plan: the built-in fields, then the custom ones, then the built-in fields that come last.
 * A stored row with `builtin: true` overrides a built-in field: its name, its choices and whether it starts hidden can
 * change. Its key and type cannot (templates and storage depend on them).
 */
export function allFields(custom: FieldDef[]): FieldDef[] {
  const overrides = new Map(custom.filter((f) => f.builtin).map((f) => [f.key, f] as const));
  const builtins = BUILTIN_FIELDS.map((b) => {
    const o = overrides.get(b.key);
    return o ? { ...b, label: o.label || b.label, options: o.options ?? b.options, hiddenByDefault: o.hiddenByDefault ?? b.hiddenByDefault, defaultValue: o.defaultValue ?? b.defaultValue, order: o.order ?? b.order } : b;
  });
  const cs = custom.filter((f) => !f.builtin);
  // one order for every field: a built-in field can sit between custom ones once it has been moved
  return [...builtins, ...cs].sort((a, b) => a.order - b.order);
}

/** The default value of a field of the Content Plan (or '' when it has none). */
export function defaultValueOf(custom: FieldDef[], key: string): string {
  return allFields(custom).find((f) => f.key === key)?.defaultValue ?? '';
}

export function getValue(rec: ContentRecord, key: string): unknown {
  if (rec.table && rec.table !== 'content') {
    if (key === 'id') return rec.id;
    if (key === 'created_at' || key === 'updated_at') return new Date(rec[key] as number).toISOString();
    return rec.data?.[key];
  }
  if (key === 'created_at' || key === 'updated_at') return new Date(rec[key] as number).toISOString();
  if (BUILTIN_KEYS.has(key)) return rec[key];
  return rec.data?.[key];
}

export function setValue(rec: ContentRecord, key: string, value: unknown): ContentRecord {
  if (!rec.table || rec.table === 'content') if (BUILTIN_KEYS.has(key)) {
    const next = { ...rec, [key]: value } as ContentRecord;
    return next;
  }
  return { ...rec, data: { ...rec.data, [key]: value } };
}

export function fieldKeyFromLabel(label: string, taken: Set<string>): string {
  let base = slugify(label).replace(/-/g, '_') || 'field';
  if (/^\d/.test(base)) base = 'f_' + base;
  let key = base, i = 2;
  while (taken.has(key) || BUILTIN_KEYS.has(key)) key = `${base}_${i++}`;
  return key;
}

/** Text shown for a value in the grid / exports. */
export function displayValue(v: unknown): string {
  if (typeof v === 'number' && Number.isNaN(v)) return '';
  if (v === undefined || v === null) return '';
  if (Array.isArray(v)) return v.join(', ');
  if (typeof v === 'object') return JSON.stringify(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v);
}

export interface Coerced { value: unknown; error?: string }

/** Converts imported / typed text into the field's native value. Never throws. */
export function coerce(raw: unknown, f: FieldDef): Coerced {
  if (raw === undefined || raw === null) return { value: f.type === 'multiselect' ? [] : f.type === 'boolean' ? false : '' };
  const s = typeof raw === 'string' ? raw.trim() : raw;
  // a formula ("=…") is kept as typed: it is calculated when the table is shown
  if (typeof s === 'string' && s.startsWith('=') && ['number', 'currency', 'percent', 'formula'].includes(f.type)) return { value: s };
  switch (f.type) {
    case 'formula': return { value: s === undefined || s === null ? '' : String(s) };
    case 'number': case 'currency': case 'percent': {
      if (s === '') return { value: '' };
      if (f.type === 'currency') {
        const amount = parseAmount(String(s));
        return amount === null ? { value: '', error: `"${String(raw)}" is not an amount` } : { value: amount };
      }
      let t = typeof s === 'string' ? s.replace(/[,\s]/g, '') : String(s);
      if (f.type === 'percent') t = t.replace(/%$/, '');
      const n = t === '' ? NaN : Number(t);
      return Number.isFinite(n) ? { value: n } : { value: '', error: `"${String(raw)}" is not a number` };
    }
    case 'rating': {
      if (s === '') return { value: 0 };
      const n = Math.round(Number(s));
      const max = f.ratingMax ?? 5;
      return Number.isFinite(n) && n >= 0 && n <= max ? { value: n } : { value: 0, error: `rating must be 0–${max}` };
    }
    case 'email':
      if (s !== '' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s))) return { value: String(s), error: `"${String(s)}" is not an email address` };
      return { value: String(s) };
    case 'phone':
      if (s !== '' && !/^[+()\d\s.-]{5,}$/.test(String(s))) return { value: String(s), error: `"${String(s)}" is not a phone number` };
      return { value: String(s) };
    case 'datetime': {
      if (s === '') return { value: '' };
      const str = String(s).trim().replace(' ', 'T');
      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(str) && !Number.isNaN(Date.parse(str))) return { value: str };
      const d = new Date(String(s));
      if (!Number.isNaN(d.getTime())) { const p = (n: number) => String(n).padStart(2, '0'); return { value: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}` }; }
      return { value: '', error: `"${String(s)}" is not a date and time` };
    }
    case 'link':
      return { value: Array.isArray(s) ? s.map(String) : String(s).split(/[;|]/).map((x) => x.trim()).filter(Boolean) };
    case 'boolean': {
      if (typeof s === 'boolean') return { value: s };
      const t = String(s).toLowerCase();
      if (['true', 'yes', 'y', '1', 'x', '✓'].includes(t)) return { value: true };
      if (['false', 'no', 'n', '0', '', '-'].includes(t)) return { value: false };
      return { value: false, error: `"${String(raw)}" is not a boolean` };
    }
    case 'date': {
      if (s === '') return { value: '' };
      const str = String(s);
      if (/^\d{4}-\d{2}-\d{2}$/.test(str) && !Number.isNaN(Date.parse(str))) return { value: str };
      const d = new Date(str);
      if (!Number.isNaN(d.getTime())) return { value: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` };
      return { value: '', error: `"${str}" is not a date` };
    }
    case 'multiselect': {
      if (Array.isArray(s)) return { value: s.map(String) };
      return { value: String(s).split(/[;,|]/).map((x) => x.trim()).filter(Boolean) };
    }
    case 'select': {
      const str = String(s);
      if (str && f.options && f.options.length && !f.options.includes(str)) {
        const m = f.options.find((o) => o.toLowerCase() === str.toLowerCase());
        if (m) return { value: m };
        return { value: str, error: `"${str}" is not one of: ${f.options.join(', ')}` };
      }
      return { value: str };
    }
    case 'url': {
      const str = String(s);
      if (str && !/^https?:\/\//i.test(str)) return { value: str, error: `"${str}" is not an http(s) URL` };
      return { value: str };
    }
    case 'json': {
      if (typeof s !== 'string') return { value: s };
      if (s === '') return { value: '' };
      try { JSON.parse(s); return { value: s }; } catch { return { value: s, error: 'not valid JSON' }; }
    }
    default:
      return { value: typeof s === 'string' ? s : String(s) };
  }
}
