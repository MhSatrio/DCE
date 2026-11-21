import { getValue } from '../db/fields';
import { db, type ContentRecord, type UploadRow } from '../db/schema';
import { allTables, fieldsOf, recordsOf, updateRow } from '../db/tables';
import { uid } from '../engine/njs';
import { r2Delete } from './client';

/**
 * Uploaded R2 files that are to be deleted. The files are deleted while DCE is open (like the automations), and each
 * deletion also removes the link from the record that held it, so no record points at a file that is gone.
 */

/** The moment an uploaded file is deleted, from the keep choice of its destination (undefined = kept). */
export function deleteAtOf(keep: { keepHours?: number; keepUntil?: string }, now: number): number | undefined {
  if (keep.keepHours && keep.keepHours > 0) return now + keep.keepHours * 3_600_000;
  if (keep.keepUntil) {
    const t = new Date(keep.keepUntil).getTime();
    return Number.isFinite(t) ? t : undefined;
  }
  return undefined;
}

/** Remembers an uploaded file that is to be deleted. */
export async function rememberUpload(u: Omit<UploadRow, 'id' | 'attempts' | 'created_at'>): Promise<void> {
  await db.uploads.put({ ...u, id: uid(), attempts: 0, created_at: Date.now() });
}

/** Removes one link from a record. The other links of the field stay. */
async function unlink(table: string, field: string, recordId: string, url: string): Promise<void> {
  const rec = recordsOf(table).find((r) => r.id === recordId);
  if (!rec) return;
  const links = String(getValue(rec, field) ?? '').split(/[\s,;]+/).filter(Boolean);
  if (!links.includes(url)) return;
  const next = links.filter((x) => x !== url).join(', ');
  const builtin = fieldsOf(table).find((f) => f.key === field)?.builtin;
  await updateRow(table, recordId, builtin ? ({ [field]: next } as Partial<ContentRecord>) : { data: { ...rec.data, [field]: next } });
}

/**
 * Removes the address of a deleted file from every record of every table that holds it, so no record points at a file that is
 * gone. Returns how many fields held it.
 */
export async function unlinkEverywhere(url: string): Promise<number> {
  let n = 0;
  for (const t of allTables()) {
    const fields = fieldsOf(t.id);
    for (const rec of recordsOf(t.id)) {
      for (const f of fields) {
        const v = getValue(rec, f.key);
        if (typeof v !== 'string' || !v.includes(url)) continue;
        await unlink(t.id, f.key, rec.id, url);
        n++;
      }
    }
  }
  return n;
}

/** Give up on a file after this many failed deletions (it stays listed, with the last error). */
const MAX_ATTEMPTS = 20;

/** Deletes the uploaded files that are due, and removes their links. Returns how many were deleted and how many failed. */
export async function sweepUploads(now = Date.now()): Promise<{ deleted: number; failed: number }> {
  const due = (await db.uploads.where('deleteAt').belowOrEqual(now).toArray()).filter((u) => u.attempts < MAX_ATTEMPTS);
  let deleted = 0;
  let failed = 0;
  for (const u of due) {
    const conn = await db.connections.get(u.connId);
    if (!conn) { await db.uploads.delete(u.id); continue; }  // the account was removed: nothing is left to delete the file with
    const r = await r2Delete(conn, u.key);
    if (!r.ok) {
      await db.uploads.update(u.id, { attempts: u.attempts + 1, lastError: String(r.error ?? 'R2 did not delete the file.') });
      failed++;
      continue;
    }
    if (u.table && u.recordId && u.field) await unlink(u.table, u.field, u.recordId, u.url).catch(() => undefined);
    await db.uploads.delete(u.id);
    deleted++;
  }
  return { deleted, failed };
}
