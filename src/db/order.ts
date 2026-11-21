import type { ContentRecord } from './schema';

/** The gap between two positions, so a row can be moved between two others without renumbering the table. */
export const POSITION_STEP = 1000;

/**
 * Rows are shown in this order: by their position in their table. Creation time and id only break ties, for rows that
 * have no position yet (see `assignPositions`).
 */
export function byPosition(a: ContentRecord, b: ContentRecord): number {
  const pa = a.position ?? Number.POSITIVE_INFINITY;
  const pb = b.position ?? Number.POSITIVE_INFINITY;
  if (pa !== pb) return pa < pb ? -1 : 1;
  if (a.created_at !== b.created_at) return a.created_at - b.created_at;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The position after the last positioned row (where a new row goes). */
export function positionAfter(rows: ContentRecord[]): number {
  let last = 0;
  for (const r of rows) if (r.position !== undefined && r.position > last) last = r.position;
  return last + POSITION_STEP;
}

/**
 * Gives every row without a position one, after the others, in the order they were created. The order the rows are
 * shown in is kept from then on, whatever happens to the database. Returns the rows that were given a position.
 */
export function assignPositions(rows: ContentRecord[]): ContentRecord[] {
  const missing = rows.filter((r) => r.position === undefined).sort(byPosition);
  if (!missing.length) return [];
  let last = positionAfter(rows) - POSITION_STEP;
  for (const r of missing) { last += POSITION_STEP; r.position = last; }
  return missing;
}
