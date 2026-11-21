import { FIELD_TYPE_LABEL } from './fields';
import type { FieldDef } from './schema';

/**
 * Plain text of one field's settings: the name, the key used in templates, the type and the choices. Pasted into an AI
 * prompt it is enough to recreate the field. Pure: no store, so it is unit-tested.
 */
export function describeField(f: FieldDef, linkName: (tableId: string) => string = (t) => t): string {
  const parts = [`${f.label} (key: ${f.key}) — ${FIELD_TYPE_LABEL[f.type]}`];
  if (f.options?.length) parts.push(`choices: ${f.options.join(', ')}`);
  if (f.type === 'currency') parts.push(`symbol: ${f.currency ?? '$'}`);
  if (f.type === 'rating') parts.push(`maximum: ${f.ratingMax ?? 5}`);
  if (f.type === 'link' && f.linkTable) parts.push(`links to: ${linkName(f.linkTable)}`);
  if (f.sync) parts.push(`synced from: ${f.sync.source} through ${f.sync.via}`);
  if (f.readonly) parts.push('read-only');
  if (f.builtin) parts.push('built-in');
  return parts.join(' · ');
}

/**
 * Plain text of a whole table: its name, how many records it has, its Master Field and every field. Paste it into an
 * AI prompt to ask for the same table elsewhere.
 */
export function describeTable(name: string, records: number, master: FieldDef | undefined, fields: FieldDef[], linkName?: (tableId: string) => string): string {
  const lines = [
    `Table: ${name}`,
    `Records: ${records}`,
    `Master field (names each record): ${master ? `${master.label} (key: ${master.key})` : '—'}`,
    'Fields:',
    ...fields.map((f) => `- ${describeField(f, linkName)}`),
    '',
    'Template bindings read a field of the record as {{content.<key>}}.',
  ];
  return lines.join('\n');
}
