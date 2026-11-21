import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Cloud, Plus, Trash2 } from 'lucide-react';
import { deleteConnection, makeProp } from '../../db/connections';
import { db, type ConnectionRow } from '../../db/schema';
import { uid } from '../../engine/njs';
import { cloudConnections, finishDriveSignIn, isWebAddress, listDriveFolders, startDriveSignIn } from '../../cloud/client';
import { confirmAction, notify } from '../../ui/store';
import { Dialog, Spinner } from '../../ui/kit';

/**
 * Where the Batch Runner can send files: a Cloudflare R2 bucket (with its public address), or a Google Drive account
 * (connected through a Google sign-in that returns to this computer). Every secret is stored encrypted, like the others.
 */
export function CloudConnections() {
  const conns = useLiveQuery(() => cloudConnections(), [], [] as ConnectionRow[]);
  const [adding, setAdding] = useState<'r2' | 'gdrive' | null>(null);
  return (
    <section className="panel" aria-label="Cloud destinations">
      <div className="panel-head"><Cloud size={16} /><h2>Cloud destinations</h2><span className="muted small">Cloudflare R2 and Google Drive, for the Batch Runner</span></div>
      <div className="panel-body col">
        <div className="callout">
          The Batch Runner can upload every rendered file to <b>Cloudflare R2</b> (a bucket you own, with a public address) or to a folder in <b>Google Drive</b> of an account you sign in with. The link of each file is written into the record, in the Uploaded link field. Your keys are encrypted on this computer.
        </div>
        <div className="row wrap">
          <button className="btn" onClick={() => setAdding('r2')}><Plus size={14} /> Add Cloudflare R2</button>
          <button className="btn" onClick={() => setAdding('gdrive')}><Plus size={14} /> Connect Google Drive</button>
        </div>
        {conns.length === 0 && <div className="muted small">No cloud destination yet.</div>}
        {conns.map((c) => <CloudRow key={c.id} conn={c} />)}
      </div>
      {adding === 'r2' && <R2Form onClose={() => setAdding(null)} />}
      {adding === 'gdrive' && <DriveForm onClose={() => setAdding(null)} />}
    </section>
  );
}

function CloudRow({ conn }: { conn: ConnectionRow }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const test = async () => {
    setBusy(true); setMsg('');
    try {
      if (conn.provider === 'gdrive') {
        const r = await listDriveFolders(conn, 'root');
        setMsg(r.ok ? `Connected: ${(r.folders ?? []).length} folder(s) in the root of this Drive.` : String(r.error));
      } else {
        const { r2Destination } = await import('../../cloud/client');
        const d = await r2Destination(conn, async () => undefined);
        const url = await d.put('dce-connection-test.txt', new TextEncoder().encode(`DCE connection test ${new Date().toISOString()}`), 'text/plain; charset=utf-8');
        setMsg(`Uploaded a test file: ${url}`);
      }
    } catch (e) { setMsg(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    if (!(await confirmAction(`Delete “${conn.name}”?`, 'Its keys are removed from this computer. Files already uploaded stay where they are.'))) return;
    await deleteConnection(conn.id);
    notify('success', 'Destination deleted.');
  };
  return (
    <div className="panel" aria-label={`Destination ${conn.name}`}>
      <div className="panel-body col" style={{ gap: 6 }}>
        <div className="row wrap"><b>{conn.name}</b><span className="chip blue">{conn.provider === 'r2' ? 'Cloudflare R2' : 'Google Drive'}</span></div>
        <div className="row wrap">
          <button className="btn" onClick={() => void test()} disabled={busy}>{busy ? <Spinner /> : null} Test</button>
          <button className="btn danger" onClick={() => void remove()}><Trash2 size={14} /> Delete</button>
        </div>
        {msg && <div className="small" role="status">{msg}</div>}
      </div>
    </div>
  );
}

function R2Form({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('Cloudflare R2');
  const [endpoint, setEndpoint] = useState('');
  const [bucket, setBucket] = useState('');
  const [publicBase, setPublicBase] = useState('');
  const [prefix, setPrefix] = useState('batch');
  const [keyId, setKeyId] = useState('');
  const [secret, setSecret] = useState('');
  const [err, setErr] = useState('');
  const save = async () => {
    if (!isWebAddress(endpoint)) return setErr('The endpoint must start with https:// (in Cloudflare: R2 → Account → S3 API endpoint).');
    if (!bucket.trim()) return setErr('Enter the bucket name.');
    if (!isWebAddress(publicBase)) return setErr('Enter the public address of the bucket (https://pub-….r2.dev or your own domain). Without it the links would not open.');
    if (!keyId.trim() || !secret.trim()) return setErr('Enter the access key id and the secret access key (R2 → Manage API tokens, with Object Read & Write).');
    const row: ConnectionRow = { id: uid(), provider: 'r2', name: name.trim() || 'Cloudflare R2', created_at: Date.now(), props: [] };
    row.props.push(await makeProp('ENDPOINT', endpoint.trim().replace(/\/+$/, '')));
    row.props.push(await makeProp('BUCKET', bucket.trim()));
    row.props.push(await makeProp('PUBLIC_BASE', publicBase.trim().replace(/\/+$/, '')));
    row.props.push(await makeProp('PREFIX', prefix.trim().replace(/^\/+|\/+$/g, '')));
    row.props.push(await makeProp('ACCESS_KEY_ID', keyId.trim()));
    row.props.push(await makeProp('SECRET_ACCESS_KEY', secret.trim()));
    await db.connections.put(row);
    notify('success', 'Cloudflare R2 saved (keys encrypted). Press “Test” to upload a test file.');
    onClose();
  };
  return (
    <Dialog title="Add Cloudflare R2" onClose={onClose} size="mid" foot={<>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn primary" onClick={() => void save()}>Save</button>
    </>}>
      <div className="col" style={{ gap: 8 }}>
          <label className="fld"><span>Name</span><input aria-label="R2 name" value={name} onChange={(e) => setName(e.target.value)} /></label>
          <label className="fld"><span>S3 endpoint</span><input aria-label="R2 endpoint" value={endpoint} placeholder="https://<account-id>.r2.cloudflarestorage.com" onChange={(e) => setEndpoint(e.target.value)} /></label>
          <label className="fld"><span>Bucket</span><input aria-label="R2 bucket" value={bucket} onChange={(e) => setBucket(e.target.value)} /></label>
          <label className="fld"><span>Public address of the bucket</span><input aria-label="R2 public address" value={publicBase} placeholder="https://pub-xxxx.r2.dev" onChange={(e) => setPublicBase(e.target.value)} /></label>
          {publicBase.includes('.r2.dev') && <div className="callout warn">This is a Cloudflare development address (r2.dev). Cloudflare rate-limits it and does not recommend it for production. Connect a custom domain to the bucket (its Custom domains page) and enter that address here.</div>}
          <label className="fld"><span>Folder inside the bucket (optional)</span><input aria-label="R2 folder" value={prefix} onChange={(e) => setPrefix(e.target.value)} /></label>
          <label className="fld"><span>Access key id</span><input aria-label="R2 access key id" value={keyId} onChange={(e) => setKeyId(e.target.value)} /></label>
          <label className="fld"><span>Secret access key</span><input type="password" aria-label="R2 secret access key" value={secret} onChange={(e) => setSecret(e.target.value)} /></label>
        {err && <div className="callout err" role="alert">{err}</div>}
      </div>
    </Dialog>
  );
}

function DriveForm({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('Google Drive');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const connect = async () => {
    if (!clientId.trim() || !clientSecret.trim()) return setErr('Enter the client ID and the client secret of your Google OAuth client (type “Desktop app”).');
    setBusy(true); setErr('');
    const s = await startDriveSignIn(clientId.trim(), clientSecret.trim());
    if (!s.ok || !s.authUrl || !s.state) { setBusy(false); return setErr(String(s.error ?? 'The sign-in could not start.')); }
    window.open(s.authUrl, '_blank');
    const r = await finishDriveSignIn(s.state);
    setBusy(false);
    if (!r.ok || !r.refreshToken) return setErr(String(r.error ?? 'The sign-in did not finish.'));
    const row: ConnectionRow = { id: uid(), provider: 'gdrive', name: name.trim() || 'Google Drive', created_at: Date.now(), props: [] };
    row.props.push(await makeProp('CLIENT_ID', clientId.trim()));
    row.props.push(await makeProp('CLIENT_SECRET', clientSecret.trim()));
    row.props.push(await makeProp('REFRESH_TOKEN', r.refreshToken));
    await db.connections.put(row);
    notify('success', 'Google Drive connected (the sign-in is stored encrypted).');
    onClose();
  };
  return (
    <Dialog title="Connect Google Drive" onClose={onClose} size="mid" foot={<>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn primary" disabled={busy} onClick={() => void connect()}>{busy ? <Spinner /> : null} Connect</button>
    </>}>
      <div className="col" style={{ gap: 8 }}>
          <div className="callout small">
            Create an OAuth client in Google Cloud (APIs &amp; Services → Credentials → OAuth client ID → <b>Desktop app</b>), and enable the Google Drive API. Paste its client ID and secret here, then press Connect: your browser opens Google's sign-in, which returns to this computer. DCE asks for access to Drive (to upload into folders you choose).
          </div>
          <label className="fld"><span>Name</span><input aria-label="Drive name" value={name} onChange={(e) => setName(e.target.value)} /></label>
          <label className="fld"><span>Client ID</span><input aria-label="Drive client id" value={clientId} onChange={(e) => setClientId(e.target.value)} /></label>
          <label className="fld"><span>Client secret</span><input type="password" aria-label="Drive client secret" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} /></label>
        {err && <div className="callout err" role="alert">{err}</div>}
      </div>
    </Dialog>
  );
}

