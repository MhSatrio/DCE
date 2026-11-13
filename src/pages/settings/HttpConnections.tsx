import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Globe, Plus, Trash2 } from 'lucide-react';
import { deleteConnection } from '../../db/connections';
import { db, type ConnectionRow } from '../../db/schema';
import { addressProblem, createHttpConnection, httpBase, httpKind, type HttpKind } from '../../connector/http';
import { pollWebsite, readStatus, testWebsite } from '../../connector/website';
import { testApi } from '../../connector/discover';
import { confirmAction, notify } from '../../ui/store';
import { Dialog, fmtDate, Spinner } from '../../ui/kit';

/** Websites (the VierApparatus connector) and other HTTP services. Tokens are encrypted and never shown again. */
export function HttpConnections() {
  const conns = useLiveQuery(() => db.connections.where('provider').equals('http').toArray(), [], [] as ConnectionRow[]);
  const [adding, setAdding] = useState(false);
  return (
    <section className="panel" aria-label="Websites and HTTP connections">
      <div className="panel-head"><Globe size={16} /><h2>Websites and HTTP connections</h2><span className="muted small">the VierApparatus website, or any other API</span></div>
      <div className="panel-body col">
        <div className="callout">
          A <b>website</b> connection lets DCE receive the events of your site (articles published, products published or reviewed) and take the jobs you send from the site's Website connector page. Any other service can be connected as an <b>API</b> connection: its requests are then available as actions in Automations. Addresses must start with https://. Tokens are encrypted, like the other keys.
        </div>
        <div className="row">
          <button className="btn" onClick={() => setAdding(true)}><Plus size={14} /> Add a website or API connection</button>
        </div>
        {conns.length === 0 && <div className="muted small">No connection yet.</div>}
        {conns.map((c) => <ConnectionRowView key={c.id} conn={c} />)}
      </div>
      {adding && <AddDialog onClose={() => setAdding(false)} />}
    </section>
  );
}

function ConnectionRowView({ conn }: { conn: ConnectionRow }) {
  const [base, setBase] = useState('');
  const [kind, setKind] = useState<HttpKind>('api');
  const [busy, setBusy] = useState('');
  const status = useLiveQuery(() => readStatus(conn.id), [conn.id], null);
  useEffect(() => {
    void httpBase(conn).then(setBase);
    void httpKind(conn).then(setKind);
  }, [conn]);

  const test = async () => {
    setBusy('test');
    const r = kind === 'website' ? await testWebsite(conn) : await testApi(conn);
    setBusy('');
    notify(r.ok ? 'success' : 'error', r.message, 9000);
  };
  const check = async () => {
    setBusy('check');
    const st = await pollWebsite(conn);
    setBusy('');
    notify(st.ok ? 'success' : 'error', st.ok ? `Checked: ${st.message}` : st.message, 9000);
  };
  const remove = async () => {
    if (!(await confirmAction(`Delete “${conn.name}”?`, 'Its token is removed from this computer. Automations that use it stop until you choose another connection.'))) return;
    await deleteConnection(conn.id);
    notify('success', 'Connection deleted.');
  };

  return (
    <div className="panel" aria-label={`Connection ${conn.name}`}>
      <div className="panel-body col" style={{ gap: 8 }}>
        <div className="row wrap">
          <b>{conn.name}</b>
          <span className="chip blue">{kind === 'website' ? 'website' : 'API'}</span>
          <span className="muted small">{base || 'no address'}</span>
        </div>
        {conn.caps ? (
          <div className="small muted" aria-label={`What ${conn.name} allows`}>{conn.caps.note} <span>(checked {fmtDate(conn.caps.checkedAt)})</span></div>
        ) : (
          <div className="small muted">Not tested yet. Press “Test connection”: DCE then finds out what this connection allows, and Automations offers exactly that.</div>
        )}
        {status && (
          <div className={`callout ${status.ok ? '' : 'warn'}`} role="status">
            Last check {fmtDate(status.at)}: {status.message}
          </div>
        )}
        <div className="row wrap">
          <button className="btn" onClick={() => void test()} disabled={!!busy}>{busy === 'test' ? <Spinner /> : null} Test connection</button>
          {kind === 'website' && <button className="btn" onClick={() => void check()} disabled={!!busy}>{busy === 'check' ? <Spinner /> : null} Check now</button>}
          <button className="btn danger" onClick={() => void remove()}><Trash2 size={14} /> Delete</button>
        </div>
      </div>
    </div>
  );
}

function AddDialog({ onClose }: { onClose: () => void }) {
  const [kind, setKind] = useState<HttpKind>('website');
  const [name, setName] = useState('VierApparatus website');
  const [base, setBase] = useState('https://vierapparatus.com');
  const [header, setHeader] = useState('Authorization');
  const [value, setValue] = useState('');
  const [err, setErr] = useState('');

  const chooseKind = (k: HttpKind) => {
    setKind(k);
    if (k === 'website') { setName('VierApparatus website'); setBase('https://vierapparatus.com'); setHeader('Authorization'); }
    else { setName(''); setBase(''); }
  };

  const save = async () => {
    const problem = addressProblem(base);
    if (problem) return setErr(problem);
    if (!value.trim()) return setErr('Paste the token. You create it on the website connector page of your site.');
    await createHttpConnection({ name, baseUrl: base, header, value, kind });
    notify('success', 'Connection saved (encrypted). Press “Test connection” to check it.');
    onClose();
  };

  return (
    <Dialog
      title="Add a website or API connection"
      onClose={onClose}
      size="mid"
      foot={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={() => void save()} disabled={!base.trim() || !value.trim()}>Save connection</button>
      </>}
    >
      <div className="col">
        <label className="fld"><span>Kind</span>
          <select aria-label="Connection kind" value={kind} onChange={(e) => chooseKind(e.target.value as HttpKind)}>
            <option value="website">Website (VierApparatus connector: events and jobs)</option>
            <option value="api">API (any other HTTP service, for workflows)</option>
          </select>
        </label>
        <label className="fld"><span>Name</span><input aria-label="Connection name" value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="fld"><span>Address (https://)</span><input aria-label="Connection address" value={base} onChange={(e) => { setErr(''); setBase(e.target.value); }} /></label>
        <div className="grid2">
          <label className="fld"><span>Header that carries the token</span><input aria-label="Token header" value={header} onChange={(e) => setHeader(e.target.value)} /></label>
          <label className="fld"><span>Token</span><input aria-label="Token value" type="password" autoComplete="new-password" value={value} onChange={(e) => { setErr(''); setValue(e.target.value); }} /></label>
        </div>
        <div className="muted small">For “Authorization” the word Bearer is added for you. Create the token on your site (Master Admin → Website connector) with the permissions you need.</div>
        {err && <div className="callout err" role="alert">{err}</div>}
      </div>
    </Dialog>
  );
}
