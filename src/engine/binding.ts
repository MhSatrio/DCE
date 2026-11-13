import { isEmpty, lookup } from './expr';
import type { RenderData } from './types';

export function slugify(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

export function titleCase(s: string): string {
  return s.replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatValue(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (Array.isArray(v)) return v.map(formatValue).join(', ');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function applyFilter(value: string, raw: unknown, name: string, arg: string | undefined): string {
  switch (name) {
    case 'upper': return value.toUpperCase();
    case 'lower': return value.toLowerCase();
    case 'title': return titleCase(value);
    case 'trim': return value.trim();
    case 'slug': return slugify(value);
    case 'truncate': {
      const n = Number(arg);
      return Number.isFinite(n) && n > 0 && value.length > n ? value.slice(0, Math.max(0, n - 1)).trimEnd() + '…' : value;
    }
    case 'default': return value === '' ? (arg ?? '') : value;
    case 'number': {
      const n = Number(raw);
      if (!Number.isFinite(n)) return value;
      const d = arg !== undefined && Number.isFinite(Number(arg)) ? Number(arg) : 0;
      return n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
    }
    case 'date': {
      const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
      if (!m) return value;
      return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] ?? ''} ${m[1]}`;
    }
    default: return value;
  }
}

export interface TemplateResult { text: string; missing: string[]; tokens: number }

const TOKEN = /\{\{\s*([^{}]+?)\s*\}\}/g;

/** Resolves `{{content.title|upper}}` style tokens. Missing values resolve to '' and are reported. */
export function renderTemplateString(
  tpl: string,
  scope: Record<string, unknown>,
  defaults?: Map<string, string>,
): TemplateResult {
  const missing: string[] = [];
  let tokens = 0;
  const text = tpl.replace(TOKEN, (_m, inner: string) => {
    tokens++;
    const [path, ...filters] = inner.split('|').map((s) => s.trim());
    let raw = lookup(scope, path);
    if (isEmpty(raw) && defaults?.has(path)) raw = defaults.get(path);
    if (isEmpty(raw)) missing.push(path);
    let out = formatValue(raw);
    for (const f of filters) {
      const idx = f.indexOf(':');
      const name = idx < 0 ? f : f.slice(0, idx);
      const arg = idx < 0 ? undefined : f.slice(idx + 1);
      out = applyFilter(out, raw, name.trim(), arg);
    }
    return out;
  });
  return { text, missing, tokens };
}

/** Extracts every `content.x` / `template.x` key referenced by a template string. */
export function extractKeys(tpl: string): string[] {
  const keys: string[] = [];
  for (const m of tpl.matchAll(TOKEN)) keys.push(m[1].split('|')[0].trim());
  return keys;
}

export function scopeOf(data: RenderData): Record<string, unknown> {
  return data as unknown as Record<string, unknown>;
}

/** File-name pattern: tokens plus {{index}} / {{index:4}} zero padding. Always sanitised. */
export function renderFilename(pattern: string, data: RenderData, ext: string): string {
  const scope = scopeOf(data);
  let name = pattern.replace(TOKEN, (_m, inner: string) => {
    const [path, ...rest] = inner.split('|').map((s) => s.trim());
    const im = /^(?:batch\.)?index(?::(\d+))?$/.exec(path);
    if (im) return String(data.batch.index).padStart(Number(im[1]) || 3, '0');
    let v = formatValue(lookup(scope, path));
    for (const f of rest) v = applyFilter(v, v, f.split(':')[0], f.split(':')[1]);
    return v;
  });
  name = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/\s+/g, ' ').trim().replace(/^\.+/, '');
  if (!name) name = `record-${String(data.batch.index).padStart(3, '0')}`;
  const dot = `.${ext}`;
  if (!name.toLowerCase().endsWith(dot)) {
    // strip a different known extension typed by the user, then add the real one
    name = name.replace(/\.(png|jpe?g|svg|pdf|html)$/i, '') + dot;
  }
  return name;
}

/** Makes names unique inside one archive: a.png, a-2.png, a-3.png … */
export class UniqueNames {
  private seen = new Set<string>();
  take(name: string): string {
    const lower = name.toLowerCase();
    if (!this.seen.has(lower)) { this.seen.add(lower); return name; }
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    for (let i = 2; ; i++) {
      const cand = `${stem}-${i}${ext}`;
      if (!this.seen.has(cand.toLowerCase())) { this.seen.add(cand.toLowerCase()); return cand; }
    }
  }
}
