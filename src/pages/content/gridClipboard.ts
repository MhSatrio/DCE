import { parseCsv } from '../../db/csv';
import { coerce, displayValue, getValue } from '../../db/fields';
import { newRecord } from '../../db/repo';
import type { ContentRecord, FieldDef } from '../../db/schema';
import { slugify } from '../../engine/binding';
import type { CellRange } from '../../ui/VirtualGrid';

/** Tab-separated text exactly as Excel / Google Sheets / LibreOffice put it on (and read it from) the clipboard. */
export function toTsv(rows: string[][]): string {
  return rows.map((r) => r.map((v) => (/[\t\r\n"]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join('\t')).join('\r\n');
}

export function parseTsv(text: string): string[][] {
  // keepEmpty: a blank line in the middle of a pasted column is a blank cell, not nothing — alignment must be preserved
  return parseCsv(text, '\t', true);
}

export interface Lookups {
  linkName: (table: string, id: string) => string;          // record id → display name
  linkByName: (table: string, name: string) => string | undefined;
  assetName: Map<string, string>;        // id → file name
  templateName: Map<string, string>;     // id → name
  assetByName: Map<string, string>;      // lower-case name → id
  templateByName: Map<string, string>;
}

/** What a cell looks like in a spreadsheet: images and templates by readable name, everything else as in the grid. */
export function cellText(rec: ContentRecord, f: FieldDef, lk: Lookups): string {
  const v = getValue(rec, f.key);
  if (f.type === 'image') return !v ? '' : /^https?:/i.test(String(v)) ? String(v) : lk.assetName.get(String(v)) ?? String(v);
  if (f.type === 'link') return (Array.isArray(v) ? v : []).map((id) => lk.linkName(f.linkTable ?? '', String(id)) || String(id)).join('; ');
  if (f.type === 'relation') return !v ? '' : lk.templateName.get(String(v)) ?? String(v);
  return displayValue(v);
}

export function copyRows(rows: ContentRecord[], fields: FieldDef[], lk: Lookups): string[][] {
  return rows.map((r) => fields.map((f) => cellText(r, f, lk)));
}

export interface PastePlan {
  updated: ContentRecord[];
  created: ContentRecord[];
  cells: number;
  skipped: { row: number; field: string; message: string }[];
  ignoredColumns: number;
  readOnly: number;
}

/**
 * Plans a paste of `grid` at (startRow, startCol) of the visible grid. Rows beyond the end create new records.
 * A 1×1 clipboard pasted over a multi-cell selection fills the whole selection (spreadsheet behaviour).
 * Pure: nothing is written here, so the caller can ask for confirmation first.
 */
export function planPaste(opts: { grid: string[][]; startRow: number; startCol: number; view: ContentRecord[]; fields: FieldDef[]; lookups: Lookups; fill?: CellRange | null; make?: (p?: Partial<ContentRecord>) => ContentRecord }): PastePlan {
  const { grid, view, fields, lookups: lk } = opts;
  const work = new Map<string, ContentRecord>();
  const created: ContentRecord[] = [];
  const plan: PastePlan = { updated: [], created, cells: 0, skipped: [], ignoredColumns: 0, readOnly: 0 };

  const recordAt = (row: number): ContentRecord => {
    if (row < view.length) {
      const base = view[row];
      let w = work.get(base.id);
      if (!w) { w = { ...base, data: { ...base.data }, tags: [...base.tags] }; work.set(base.id, w); }
      return w;
    }
    const k = row - view.length;
    while (created.length <= k) created.push(opts.make ? opts.make() : newRecord({ title: '' }));
    return created[k];
  };

  const put = (row: number, col: number, raw: string) => {
    const f = fields[col];
    if (!f) { plan.ignoredColumns++; return; }
    if (f.readonly) { plan.readOnly++; return; }
    const rec = recordAt(row);
    let value: unknown;
    const t = raw.trim();
    if (f.type === 'link' && f.linkTable) {
      const names = t.split(';').map((x) => x.trim()).filter(Boolean);
      const found = names.map((n) => ({ n, id: lk.linkByName(f.linkTable!, n) }));
      const bad = found.find((x) => !x.id);
      if (bad) { plan.skipped.push({ row: row + 1, field: f.label, message: `no record named “${bad.n}” in the linked table` }); return; }
      value = found.map((x) => x.id);
    } else if ((f.type === 'image' || f.type === 'relation') && t) {
      const lower = t.toLowerCase();
      value = f.relationTo === 'templates' ? (lk.templateByName.get(lower) ?? t) : (lk.assetByName.get(lower) ?? t);
    } else {
      const c = coerce(raw, f);
      if (c.error) { plan.skipped.push({ row: row + 1, field: f.label, message: c.error }); return; }
      value = c.value;
    }
    if (f.builtin) {
      if (f.key === 'title' && (!rec.slug || rec.slug === slugify(rec.title))) rec.slug = slugify(String(value));
      (rec as Record<string, unknown>)[f.key] = value;
    } else rec.data[f.key] = value;
    plan.cells++;
  };

  const single = grid.length === 1 && grid[0].length === 1;
  if (single && opts.fill && (opts.fill.r2 > opts.fill.r1 || opts.fill.c2 > opts.fill.c1)) {
    for (let r = opts.fill.r1; r <= opts.fill.r2; r++) for (let c = opts.fill.c1; c <= opts.fill.c2; c++) put(r, c, grid[0][0]);
  } else {
    grid.forEach((cells, r) => cells.forEach((raw, c) => put(opts.startRow + r, opts.startCol + c, raw)));
  }
  plan.updated = [...work.values()];
  for (const r of created) if (!r.table) { if (!r.title.trim()) r.title = 'Untitled record'; if (!r.slug) r.slug = slugify(r.title); }
  return plan;
}
