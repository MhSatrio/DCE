import type { FieldType } from '../db/schema';

/**
 * Pure helpers for reading the values of a website event and turning them into table columns.
 * A "path" is a dot path into the event payload: "title", "author.name", "image".
 */

/** The value at a dot path, or undefined when a part is missing. */
export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split('.').map((p) => p.trim()).filter(Boolean)) {
    if (cur && typeof cur === 'object' && !Array.isArray(cur) && part in (cur as Record<string, unknown>)) cur = (cur as Record<string, unknown>)[part];
    else return undefined;
  }
  return cur;
}

/** A value as text for a table cell: lists are joined, objects are shown as JSON, missing values are empty. */
export function asText(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (Array.isArray(v)) return v.map(asText).filter(Boolean).join(', ');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** The column key rules: a letter or underscore, then letters, digits or underscores (the same keys the table uses in templates). */
export const COLUMN_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,60}$/;

/** "post_text" → "Post text". */
export function columnLabel(key: string): string {
  const s = key.replace(/_/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** The column type a new column gets: links for addresses and images, long text for long values and descriptions, otherwise text. */
export function guessType(key: string, value: string): FieldType {
  if (/url|link|address|image|photo|picture/i.test(key)) return 'url';
  if (value.length > 200 || /body|text|summary|description|review|content|note|excerpt|hook|verdict/i.test(key)) return 'longtext';
  return 'text';
}
