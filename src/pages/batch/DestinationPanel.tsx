import { useEffect, useId, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { FolderOpen } from 'lucide-react';
import { UPLOAD_KEY, type DestChoice } from '../../batch/destination';
import { cloudConnections, listDriveFolders, resolveDriveFolder } from '../../cloud/client';
import { allTables, fieldsOf } from '../../db/tables';
import { type ConnectionRow } from '../../db/schema';
import { notify, useStore } from '../../ui/store';
import { recordsStore, tablesStore } from '../../db/stores';

/**
 * Where the files go (the Batch Runner, and a “Render with the batch runner” step of an automation). `bare` drops the
 * panel frame, for use inside another panel.
 */
/** A local date and time as the datetime field writes it (YYYY-MM-DDTHH:MM). */
const localIn = (ms: number): string => {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

export function DestinationPanel({ value, onChange, batchTable, heading = '4 · Where the files go', bare = false }: {
  value: DestChoice; onChange: (v: DestChoice) => void; batchTable: string; heading?: string; bare?: boolean;
}) {
  const tableId = value.table || batchTable;
  // drawn again when a table or a field is added, renamed or removed
  useStore(tablesStore, (s) => s.tables);
  useStore(recordsStore, (s) => s.fields);
  useStore(tablesStore, (s) => s.fields);
  const group = useId(); // the radio buttons of this panel only: several steps can be on one page
  const conns = useLiveQuery(() => cloudConnections(), [], [] as ConnectionRow[]);
  const [folders, setFolders] = useState<{ id: string; name: string }[] | null>(null);
  const [parents, setParents] = useState<{ id: string; name: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const usable = conns.filter((c) => c.provider === (value.kind === 'r2' ? 'r2' : 'gdrive'));
  const tableFields = fieldsOf(tableId).filter((f) => ['url', 'text', 'longtext'].includes(f.type));
  useEffect(() => { setFolders(null); setParents([]); }, [value.connId, value.kind]);

  const check = async () => {
    const conn = usable.find((c) => c.id === value.connId);
    if (!conn) return notify('warn', 'Choose the Google Drive connection first.');
    setBusy(true);
    const f = await resolveDriveFolder(conn, value.folder);
    setBusy(false);
    if ('error' in f) return notify('error', f.error);
    onChange({ ...value, folderId: f.id, folderName: f.name });
    notify('success', `Folder “${f.name}” is ready: the files will be uploaded there.`);
  };
  const browse = async (parentId: string) => {
    const conn = usable.find((c) => c.id === value.connId);
    if (!conn) return notify('warn', 'Choose the Google Drive connection first.');
    setBusy(true);
    const r = await listDriveFolders(conn, parentId);
    setBusy(false);
    if (!r.ok) return notify('error', String(r.error ?? 'The folders could not be listed.'));
    setFolders(r.folders ?? []);
  };

  const body = (
    <div className={bare ? 'col' : 'panel-body col'} style={{ gap: 10 }}>
      <div className="col" role="radiogroup" aria-label="Output destination" style={{ gap: 6 }}>
        <label className="chk"><input type="radio" name={group} checked={value.kind === 'zip'} onChange={() => onChange({ ...value, kind: 'zip' })} /> Download ZIP only</label>
        <label className="chk"><input type="radio" name={group} checked={value.kind === 'r2'} onChange={() => onChange({ ...value, kind: 'r2', connId: '' })} /> Upload to Cloudflare R2</label>
        <label className="chk"><input type="radio" name={group} checked={value.kind === 'drive'} onChange={() => onChange({ ...value, kind: 'drive', connId: '' })} /> Upload to a Google Drive folder</label>
      </div>

      {value.kind !== 'zip' && (
        <>
          {usable.length === 0 && <div className="callout warn">No {value.kind === 'r2' ? 'Cloudflare R2 bucket' : 'Google Drive account'} is set up yet. Add it in <a href="#/settings">Settings → Cloud destinations</a>.</div>}
          <label className="fld" style={{ maxWidth: 420 }}><span>{value.kind === 'r2' ? 'Bucket' : 'Google Drive account'}</span>
            <select aria-label={value.kind === 'r2' ? 'Cloudflare connection' : 'Drive connection'} value={value.connId} onChange={(e) => onChange({ ...value, connId: e.target.value, folderId: '', folderName: '' })}>
              <option value="">— choose —</option>
              {usable.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          {value.kind === 'drive' && (
            <div className="col" style={{ gap: 6 }}>
              <div className="row wrap">
                <input aria-label="Drive folder link or id" value={value.folder} placeholder="https://drive.google.com/drive/folders/…" style={{ flex: 1, minWidth: 260 }}
                  onChange={(e) => onChange({ ...value, folder: e.target.value, folderId: '', folderName: '' })} />
                <button className="btn" disabled={busy || !value.connId || !value.folder.trim()} onClick={() => void check()}>Check folder</button>
                <button className="btn" disabled={busy || !value.connId} onClick={() => { setParents([]); void browse('root'); }}><FolderOpen size={14} /> Browse my folders</button>
              </div>
              {value.folderId && <div className="small">Uploads go to <b>{value.folderName}</b>.</div>}
              {folders && (
                <div className="panel" style={{ maxHeight: 220, overflow: 'auto' }} aria-label="Drive folders">
                  <div className="panel-body col" style={{ gap: 4 }}>
                    {parents.length > 0 && <button className="btn sm" onClick={() => { const up = parents.slice(0, -1); setParents(up); void browse(up.at(-1)?.id ?? 'root'); }}>← Up</button>}
                    {folders.length === 0 && <div className="muted small">No folder here.</div>}
                    {folders.map((f) => (
                      <div key={f.id} className="row wrap" style={{ alignItems: 'center' }}>
                        <span className="grow">{f.name}</span>
                        <button className="btn sm" onClick={() => { setParents([...parents, f]); void browse(f.id); }}>Open</button>
                        <button className="btn sm" onClick={() => { onChange({ ...value, folder: f.id, folderId: f.id, folderName: f.name }); setFolders(null); notify('success', `“${f.name}” chosen.`); }}>Choose</button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
          <div className="grid2">
            <label className="fld"><span>Table that receives the links</span>
              <select aria-label="Record table" value={tableId} onChange={(e) => onChange({ ...value, table: e.target.value, field: UPLOAD_KEY })}>
                {allTables().map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </label>
            <label className="fld"><span>Uploaded link field</span>
              <select aria-label="Uploaded link field" value={value.field} onChange={(e) => onChange({ ...value, field: e.target.value })}>
                {!fieldsOf(tableId).some((f) => f.key === UPLOAD_KEY) && <option value="__create__">Create “Uploaded link” (a URL field)</option>}
                {tableFields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
              </select>
            </label>
          </div>
          <label className="chk"><input type="checkbox" aria-label="Also keep a ZIP download" checked={value.keepZip} onChange={(e) => onChange({ ...value, keepZip: e.target.checked })} /> Also keep a ZIP download</label>
          {value.kind === 'r2' && (
            <div role="radiogroup" aria-label="Keep the uploaded files" style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, color: 'var(--muted)' }}>
              <span style={{ fontWeight: 500 }}>Keep the uploaded files</span>
              <label className="chk"><input type="radio" name={`${group}-keep`} checked={value.keepHours === undefined && value.keepUntil === undefined} onChange={() => onChange({ ...value, keepHours: undefined, keepUntil: undefined })} /> Keep them until I delete them</label>
              <label className="chk"><input type="radio" name={`${group}-keep`} checked={value.keepHours !== undefined} onChange={() => onChange({ ...value, keepHours: value.keepHours ?? 24, keepUntil: undefined })} /> Delete them after <input type="number" min={1} max={8760} aria-label="Hours to keep" value={value.keepHours ?? 24} style={{ width: 80 }} onChange={(e) => onChange({ ...value, keepHours: Math.max(1, Math.round(Number(e.target.value) || 1)) })} /> hours</label>
              <label className="chk"><input type="radio" name={`${group}-keep`} checked={value.keepUntil !== undefined} onChange={() => onChange({ ...value, keepUntil: value.keepUntil ?? localIn(Date.now() + 86_400_000), keepHours: undefined })} /> Delete them at a date and time <input type="datetime-local" aria-label="Delete at" value={value.keepUntil ?? ''} onChange={(e) => onChange({ ...value, keepUntil: e.target.value || undefined })} /></label>
              <div className="small muted">A deleted file is removed from the bucket, and its link is removed from its record. This happens while DCE is open, like the automations.</div>
            </div>
          )}
          {value.kind === 'drive' && <div className="small muted">A Google Drive file link is sent to Buffer in Google’s direct-download form, which works only when the file is shared as “Anyone with the link”. A Drive folder or page cannot be posted. For a reliable post, upload to Cloudflare R2.</div>}
          <div className="small muted">A file that is already in the destination (same name) is replaced, not duplicated. A record that has no matching row in the chosen table is reported as failed.</div>
        </>
      )}
    </div>
  );

  if (bare) return <section aria-label={heading} className="col" style={{ gap: 8 }}><div className="small"><b>{heading}</b></div>{body}</section>;
  return (
    <section className="panel" aria-label={heading}>
      <div className="panel-head"><h2>{heading}</h2><span className="muted small">the link of every file is written into its record</span></div>
      {body}
    </section>
  );
}
