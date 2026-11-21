import { cloudConnections, driveDestination, keyFromPublicUrl, r2Destination, r2Target, resolveDriveFolder } from '../cloud/client';
import { deleteAtOf, rememberUpload } from '../cloud/retention';
import { allTables, fieldsOf, recordsOf, saveFieldIn, tableName, updateRow } from '../db/tables';
import { remoteImage } from '../db/remote';
import type { ContentRecord, OutputDest } from '../db/schema';
import { uid } from '../engine/njs';
import type { Destination } from './runner';

/** Where the files go and which field of which record receives their links (the Batch Runner and automation renders). */
export type DestChoice = OutputDest;

export const UPLOAD_KEY = 'uploaded_link';
/** `table` empty = the table the render draws its records from (the template’s data table). */
export const DEFAULT_DEST: DestChoice = { kind: 'zip', connId: '', folder: '', folderId: '', folderName: '', table: '', field: UPLOAD_KEY, keepZip: false };

/** Writes the address of a file into the Uploaded link of the record with that id. */
export async function recordLink(table: string, fieldKey: string, recordId: string, url: string): Promise<void> {
  const rec = recordsOf(table).find((r) => r.id === recordId);
  if (!rec) throw new Error(`This record is not in the table “${tableName(table)}”. Choose the table the rendered records belong to.`);
  const f = fieldsOf(table).find((x) => x.key === fieldKey);
  if (!f) throw new Error('The Uploaded link field no longer exists in that table.');
  if (f.builtin) await updateRow(table, recordId, { [fieldKey]: url } as Partial<ContentRecord>);
  else await updateRow(table, recordId, { data: { ...rec.data, [fieldKey]: url } });
}

/** Makes sure the chosen table has the Uploaded link field (creating it once). Returns the field key. */
export async function ensureUploadField(table: string, field: string): Promise<string> {
  const exists = fieldsOf(table).some((f) => f.key === UPLOAD_KEY);
  // the default field, or "create": the Uploaded link field is made when it is missing (once)
  if (field === '__create__' || (field === UPLOAD_KEY && !exists)) {
    if (!exists) await saveFieldIn(table, { id: uid(), key: UPLOAD_KEY, label: 'Uploaded link', type: 'url', order: fieldsOf(table).length });
    return UPLOAD_KEY;
  }
  return field;
}

/** Turns the choice into a destination for one run. Problems come back as a message, nothing is sent. */
export async function prepareDestination(d: DestChoice, batchTable: string): Promise<{ destination?: Destination; error?: string }> {
  const table = d.table || batchTable;
  if (d.kind === 'zip') return {};
  if (!allTables().some((t) => t.id === table)) return { error: 'Choose the table that receives the links.' };
  const conn = (await cloudConnections()).find((c) => c.id === d.connId);
  if (!conn) return { error: 'Choose the cloud connection first (Settings → Cloud destinations to add one).' };
  let field: string;
  try { field = await ensureUploadField(table, d.field); }
  catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
  // a kept R2 file is remembered with the moment it is deleted; its link is removed then
  const target = d.kind === 'r2' ? await r2Target(conn) : { publicBase: '', prefix: '' };
  const record = async (recordId: string, url: string) => {
    await recordLink(table, field, recordId, url);
    const deleteAt = d.kind === 'r2' ? deleteAtOf(d, Date.now()) : undefined;
    const key = deleteAt !== undefined ? keyFromPublicUrl(target.publicBase, target.prefix, url) : null;
    if (deleteAt !== undefined && key) await rememberUpload({ connId: conn.id, key, url, table, recordId, field, deleteAt });
  };
  try {
    if (d.kind === 'r2') {
      const dest = await r2Destination(conn, record);
      return { destination: { ...dest, put: async (name, bytes, mime) => {
        const url = await dest.put(name, bytes, mime);
        // an uploaded image is read back from its public address: its link is written only when that address opens it
        if (!mime.startsWith('image/')) return url;
        const got = await remoteImage(url);
        if (!got.ok) throw new Error(`the file is in the bucket, but its public address does not open it (${got.reason}). Check that the public address of “${conn.name}” is the address of this bucket. The link was not written.`);
        return url;
      } } };
    }
    let folderId = d.folderId;
    let folderName = d.folderName;
    if (!folderId) {
      const f = await resolveDriveFolder(conn, d.folder);
      if ('error' in f) return { error: f.error };
      folderId = f.id; folderName = f.name;
    }
    return { destination: driveDestination(conn, folderId, folderName, record) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/** A short name for where the files go, for summaries: “Cloudflare R2”, “Google Drive”, or nothing for the ZIP download. */
export function destinationName(d: DestChoice): string {
  return d.kind === 'r2' ? 'Cloudflare R2' : d.kind === 'drive' ? 'Google Drive' : '';
}
