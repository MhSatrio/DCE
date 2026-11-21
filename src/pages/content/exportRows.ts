import { displayValue, getValue } from '../../db/fields';
import type { CellKind } from '../../db/xlsx';
import type { ContentRecord, FieldDef } from '../../db/schema';

/** The fields that become the columns of an export (a body text is a column only when it is the Content field). */
export function exportColumns(fields: FieldDef[]): FieldDef[] {
  return fields.filter((f) => f.type !== 'markdown' || f.key === 'content');
}

/** What each column holds, so a spreadsheet keeps numbers, dates and times as they are. */
export function exportKinds(fields: FieldDef[]): CellKind[] {
  return exportColumns(fields).map((f) => {
    if (['number', 'currency', 'percent', 'rating', 'autonumber'].includes(f.type)) return 'number';
    if (f.type === 'date') return 'date';
    if (['datetime', 'createdTime', 'modifiedTime'].includes(f.type)) return 'datetime';
    return 'text';
  });
}

/** Export rows: header labels, then one line per record, in the order given; linked records appear by name. */
export function buildExportRows(rows: ContentRecord[], fields: FieldDef[], names: Map<string, Map<string, string>>): string[][] {
  const cols = exportColumns(fields);
  const cell = (r: ContentRecord, f: FieldDef): string => {
    const v = getValue(r, f.key);
    if (f.type === 'link') return (Array.isArray(v) ? v : []).map((id) => names.get(f.linkTable ?? '')?.get(String(id)) ?? String(id)).join('; ');
    return displayValue(v);
  };
  return [cols.map((f) => f.label), ...rows.map((r) => cols.map((f) => cell(r, f)))];
}
