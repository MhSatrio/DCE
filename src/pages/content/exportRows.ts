import { displayValue, getValue } from '../../db/fields';
import type { ContentRecord, FieldDef } from '../../db/schema';

/** CSV rows: header labels, then one line per record; linked records appear by name. */
export function buildExportRows(rows: ContentRecord[], fields: FieldDef[], names: Map<string, Map<string, string>>): string[][] {
  const cols = fields.filter((f) => f.type !== 'markdown' || f.key === 'content');
  const cell = (r: ContentRecord, f: FieldDef): string => {
    const v = getValue(r, f.key);
    if (f.type === 'link') return (Array.isArray(v) ? v : []).map((id) => names.get(f.linkTable ?? '')?.get(String(id)) ?? String(id)).join('; ');
    return displayValue(v);
  };
  return [cols.map((f) => f.label), ...rows.map((r) => cols.map((f) => cell(r, f)))];
}
