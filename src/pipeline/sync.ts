/**
 * Mirrors the pipeline's posts into a table of your choice, so they can be read, filtered and exported with the rest of
 * your data. One-way: the pipeline owns the columns listed below; any column you add yourself is kept on every sync.
 * Each post is one row whose id is the post id, so syncing again updates the same rows instead of adding copies.
 */
import { allTables, createRows, createTable, fieldsOf, newRow, recordsOf, saveFieldIn } from '../db/tables';
import type { FieldDef, PostRow, PostStatus } from '../db/schema';
import { uid } from '../engine/njs';

export const SYNC_TABLE_NAME = 'Social posts';
export const STATUS_LABEL: Record<PostStatus, string> = { simulated: 'Simulated', pending: 'Needs approval', sent: 'Sent to Buffer', rejected: 'Rejected', failed: 'Failed' };

export interface SyncColumn { key: string; label: string; type: FieldDef['type']; options?: string[] }
export const SYNC_COLUMNS: SyncColumn[] = [
  { key: 'name', label: 'Title', type: 'text' },
  { key: 'source', label: 'Source', type: 'text' },
  { key: 'url', label: 'Source URL', type: 'url' },
  { key: 'status', label: 'Status', type: 'select', options: Object.values(STATUS_LABEL) },
  { key: 'post_text', label: 'Post text', type: 'longtext' },
  { key: 'channels', label: 'Channels', type: 'text' },
  { key: 'detail', label: 'Details', type: 'longtext' },
  { key: 'model', label: 'Model', type: 'text' },
  { key: 'created', label: 'Created', type: 'text' },
  { key: 'post_id', label: 'Buffer post id', type: 'text' },
  // the columns below are yours (or set by automations): the pipeline never overwrites them after they exist
  { key: 'approval', label: 'Approval', type: 'select', options: ['Draft', 'Approved', 'Rejected'] },
  { key: 'publish_at', label: 'Publish at', type: 'datetime' },
  { key: 'schedule_state', label: 'Schedule state', type: 'text' },
];

/** Columns the pipeline owns: rewritten on every sync. Everything else in a row is kept as it is. */
export const PIPELINE_OWNED = new Set(['name', 'source', 'url', 'status', 'post_text', 'channels', 'detail', 'model', 'created', 'post_id']);

/** The values the pipeline writes for one post. */
export function postToData(p: PostRow): Record<string, unknown> {
  return {
    name: p.title,
    source: p.sourceName,
    url: p.url,
    status: STATUS_LABEL[p.status],
    post_text: p.text,
    detail: p.detail,
    model: p.model ?? '',
    channels: p.channels.map((c) => `${c.label}${c.postId ? ` (${c.postId})` : c.error ? ` — ${c.error}` : c.skipped ? ` — ${c.skipped}` : ''}`).join('; '),
    created: new Date(p.created_at).toLocaleString(),
    post_id: p.channels.find((c) => c.postId)?.postId ?? '',
  };
}

/** Pipeline columns are overwritten; every other column of the existing row is kept as it is. */
export function mergeRowData(existing: Record<string, unknown> | undefined, mapped: Record<string, unknown>): Record<string, unknown> {
  return { ...(existing ?? {}), ...mapped };
}

/** Adds the pipeline columns that the table does not have yet (existing columns keep their name and type). */
export async function ensureColumns(tableId: string): Promise<number> {
  const current = fieldsOf(tableId);
  const have = new Set(current.map((f) => f.key));
  let order = current.length;
  let added = 0;
  for (const c of SYNC_COLUMNS) {
    if (have.has(c.key)) continue;
    await saveFieldIn(tableId, { id: uid(), key: c.key, label: c.label, type: c.type, options: c.options, order: order++ });
    added++;
  }
  return added;
}

/** Writes every post into the table (create or update by post id). Returns how many rows were written. */
export async function syncPostsToTable(tableId: string, posts: PostRow[]): Promise<{ rows: number; columnsAdded: number }> {
  if (!allTables().some((t) => t.id === tableId)) throw new Error('The table chosen for the sync no longer exists.');
  const columnsAdded = await ensureColumns(tableId);
  const existing = new Map(recordsOf(tableId).map((r) => [r.id, r]));
  const recs = posts.map((p) => {
    const cur = existing.get(p.id);
    // a new row starts as a draft: nothing is posted until someone sets Approval to Approved
    const data = cur ? mergeRowData(cur.data, postToData(p)) : { ...mergeRowData(undefined, postToData(p)), approval: 'Draft' };
    return cur ? { ...cur, data } : newRow(tableId, { id: p.id, data });
  });
  if (recs.length === 0) return { rows: 0, columnsAdded };
  const ok = await createRows(tableId, recs, true);
  if (!ok) throw new Error('The rows could not be saved (browser storage problem).');
  return { rows: recs.length, columnsAdded };
}

/** Creates the default "Social posts" table and returns its id. */
export async function createSyncTable(): Promise<string> {
  const t = await createTable(SYNC_TABLE_NAME);
  return t.id;
}
