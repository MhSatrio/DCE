import { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Copy, Eye, EyeOff, KeyRound, Pencil, Plug, Plus, RefreshCw, Trash2, UserRound } from 'lucide-react';
import { DEFAULT_RELAY, listChannels, relayHealth, type BufferChannel } from '../../automation/buffer';
import { ACTIVE_KEY, addProp, createConnection, deleteConnection, readProp, removeProp, renameConnection, replaceProp } from '../../db/connections';
import { channelTitle, saveChannels } from '../../pipeline/channels';
import { db, getSetting, setSetting, type ConnectionProp, type ConnectionRow } from '../../db/schema';
import { Dialog, IconBtn } from '../../ui/kit';
import { confirmAction, notify } from '../../ui/store';

const REVEAL_MS = 15000;
const MASK = '••••••••••••••••';

/** A value that is never shown until the user asks: double-click (or Enter) to reveal, right-click for more. */
export function SecretValue({ conn, prop }: { conn: ConnectionRow; prop: ConnectionProp }) {
  const [plain, setPlain] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [replacing, setReplacing] = useState(false);
  const [next, setNext] = useState('');
  const timer = useRef<number | undefined>(undefined);
  const hide = () => { clearTimeout(timer.current); setPlain(null); };
  const reveal = async () => {
    try { const v = await readProp(prop); setPlain(v); clearTimeout(timer.current); timer.current = window.setTimeout(hide, REVEAL_MS); }
    catch (e) { notify('error', e instanceof Error ? e.message : String(e)); }
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => { if (!menu) return; const c = () => setMenu(null); window.addEventListener('mousedown', c); return () => window.removeEventListener('mousedown', c); }, [menu]);
  return (
    <>
      <div
        className={`secret ${plain !== null ? 'open' : ''}`} tabIndex={0} role="textbox" aria-readonly="true"
        aria-label={`Value of ${prop.key} — hidden. Double-click or press Enter to reveal; right-click for options.`}
        title="Double-click to reveal · right-click for options" data-testid={`secret-${prop.key}`}
        onDoubleClick={() => (plain === null ? void reveal() : hide())}
        onContextMenu={(e) => { e.preventDefault(); setMenu({ x: Math.min(e.clientX, window.innerWidth - 220), y: Math.min(e.clientY, window.innerHeight - 200) }); }}
        onKeyDown={(e) => { if (e.key === 'Enter') { if (plain === null) void reveal(); else hide(); } else if (e.key === 'Escape') hide(); }}
        onBlur={hide}
      >
        <span className="secret-text">{plain !== null ? plain : MASK}</span>
        <span className="secret-hint">{plain !== null ? <EyeOff size={14} /> : <Eye size={14} />}</span>
      </div>
      {menu && (
        <div className="ctx" style={{ left: menu.x, top: menu.y }} role="menu" aria-label={`${prop.key} options`} onMouseDown={(e) => e.stopPropagation()}>
          <button role="menuitem" onClick={() => { setMenu(null); void reveal(); }}><Eye size={14} /> Reveal for 15 seconds</button>
          <button role="menuitem" onClick={async () => { setMenu(null); try { await navigator.clipboard.writeText(await readProp(prop)); notify('success', `${prop.key} copied to the clipboard.`); } catch { notify('warn', 'The browser blocked clipboard access.'); } }}><Copy size={14} /> Copy value</button>
          <button role="menuitem" onClick={() => { setMenu(null); setReplacing(true); }}><Pencil size={14} /> Replace value…</button>
          <hr />
          <button role="menuitem" className="danger-t" onClick={async () => { setMenu(null); if (await confirmAction(`Delete ${prop.key}?`, `It is removed from “${conn.name}”. Automations that use it will stop working until you add it again.`)) { await removeProp(conn.id, prop.id); notify('success', `${prop.key} deleted.`); } }}><Trash2 size={14} /> Delete</button>
        </div>
      )}
      {replacing && (
        <Dialog title={`Replace ${prop.key}`} onClose={() => { setReplacing(false); setNext(''); }} foot={<>
          <button className="btn" onClick={() => { setReplacing(false); setNext(''); }}>Cancel</button>
          <button className="btn primary" disabled={!next} onClick={async () => { try { await replaceProp(conn.id, prop.id, next); notify('success', `${prop.key} updated (encrypted).`); setReplacing(false); setNext(''); } catch (e) { notify('error', String(e)); } }}>Save</button>
        </>}>
          <label className="fld"><span>New value (stored encrypted, never shown again)</span><input type="password" autoComplete="off" autoFocus value={next} onChange={(e) => setNext(e.target.value)} aria-label="New value" /></label>
        </Dialog>
      )}
    </>
  );
}

function AddProp({ conn }: { conn: ConnectionRow }) {
  const [key, setKey] = useState('');
  const [val, setVal] = useState('');
  const submit = async () => {
    try { await addProp(conn.id, key, val); notify('success', `${key.trim()} saved (encrypted).`); setKey(''); setVal(''); }
    catch (e) { notify('error', e instanceof Error ? e.message : String(e)); }
  };
  return (
    <div className="col" style={{ gap: 6 }}>
      <div className="row wrap">
        <button className="btn sm" onClick={() => setKey('BUFFER_API_KEY')}><KeyRound size={13} /> API key</button>
        <button className="btn sm" onClick={() => setKey('BUFFER_CHANNEL_ID_INSTAGRAM')}>+ Instagram channel</button>
        <button className="btn sm" onClick={() => setKey('BUFFER_CHANNEL_ID_LINKEDIN')}>+ LinkedIn channel</button>
        <button className="btn sm" onClick={() => setKey('BUFFER_CHANNEL_ID_')}>+ Other channel</button>
      </div>
      <div className="row">
        <input aria-label="Property name" placeholder="Property, e.g. BUFFER_CHANNEL_ID_FACEBOOK" value={key} onChange={(e) => setKey(e.target.value.replace(/\s+/g, '_'))} style={{ flex: 1 }} />
        <input aria-label="Property value" type="password" autoComplete="new-password" placeholder="Value (encrypted when saved)" value={val} onChange={(e) => setVal(e.target.value)} style={{ flex: 1 }} onKeyDown={(e) => e.key === 'Enter' && key && val && submit()} />
        <button className="btn primary" disabled={!key.trim() || !val} onClick={submit}><Plus size={14} /> Add</button>
      </div>
    </div>
  );
}

export function Connections() {
  const conns = useLiveQuery(() => db.connections.orderBy('created_at').toArray(), [], []);
  const activeId = useLiveQuery(() => getSetting<string>(ACTIVE_KEY('buffer'), ''), [], '');
  const [relay, setRelay] = useState(DEFAULT_RELAY);
  const [relayMsg, setRelayMsg] = useState<{ ok: boolean; message: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [newKey, setNewKey] = useState('');
  const [rename, setRename] = useState<string | null>(null);
  const [found, setFound] = useState<BufferChannel[] | null>(null);
  const [testing, setTesting] = useState(false);
  useEffect(() => { void getSetting<string>('relay.url', DEFAULT_RELAY).then(setRelay); }, []);

  const list = (conns ?? []).filter((c) => c.provider !== 'gemini');
  const current = list.find((c) => c.id === activeId) ?? list[0];

  const test = async () => {
    if (!current) return;
    setTesting(true);
    try {
      const keyProp = current.props.find((p) => /api[_-]?key|token/i.test(p.key));
      if (!keyProp) throw new Error('Add a BUFFER_API_KEY property first.');
      const ch = await listChannels(relay, await readProp(keyProp));
      setFound(ch);
      notify('success', `Connected — ${ch.length} channel${ch.length === 1 ? '' : 's'} found.`);
    } catch (e) { notify('error', e instanceof Error ? e.message : String(e), 9000); }
    setTesting(false);
  };

  return (
    <section className="panel" aria-label="Connections">
      <div className="panel-head"><Plug size={16} /><h2>Connections</h2><span className="muted small">External services used by automations</span></div>
      <div className="panel-body col">
        <div className="callout">
          API keys and channel ids are <b>encrypted (AES-256-GCM)</b> before they are stored and are hidden on screen. <b>Double-click</b> a value to reveal it for 15 seconds, or <b>right-click</b> it to copy, replace or delete.
          The key never leaves this browser except inside the request to Buffer (through your local relay).
        </div>

        <div className="row wrap">
          <span className="fld" style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}><UserRound size={15} /> <b>Buffer account</b></span>
          <select aria-label="Active Buffer account" value={current?.id ?? ''} onChange={async (e) => { await setSetting(ACTIVE_KEY('buffer'), e.target.value); notify('info', 'Active Buffer account switched.'); }} style={{ minWidth: 260 }} disabled={list.length === 0}>
            {list.length === 0 && <option value="">No account yet</option>}
            {list.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <button className="btn" onClick={() => setAdding(true)}><Plus size={14} /> Add account</button>
          {current && <>
            <IconBtn icon={<Pencil size={15} />} label="Rename account" onClick={() => { setRename(current.name); }} />
            <IconBtn icon={<Trash2 size={15} />} label="Delete account" onClick={async () => { if (await confirmAction(`Delete “${current.name}”?`, 'Its API key and channel ids are permanently removed from this browser.')) { await deleteConnection(current.id); notify('success', 'Account deleted.'); } }} />
          </>}
        </div>

        {!current ? <div className="empty">Add your first Buffer account to let automations publish for you.</div> : (
          <>
            <table className="tbl" aria-label={`Properties of ${current.name}`}>
              <thead><tr><th style={{ width: '42%' }}>Property</th><th>Value</th></tr></thead>
              <tbody>
                {current.props.length === 0 && <tr><td colSpan={2} className="muted">No properties yet — add the API key and the channel ids below.</td></tr>}
                {current.props.map((p) => (
                  <tr key={p.id}><td><code>{p.key}</code>{/^BUFFER_CHANNEL_ID/i.test(p.key) && <span className="chip blue" style={{ marginLeft: 8 }}>{channelTitle(p)}</span>}</td><td><SecretValue conn={current} prop={p} /></td></tr>
                ))}
              </tbody>
            </table>
            <AddProp conn={current} />
            <div className="row wrap">
              <button className="btn" onClick={test} disabled={testing}><RefreshCw size={14} /> {testing ? 'Contacting Buffer…' : 'Test connection & list channels'}</button>
              <span className="muted small">Uses the relay below.</span>
            </div>
          </>
        )}

        <hr style={{ border: 0, borderTop: '1px solid var(--line)', width: '100%' }} />
        <div className="fld"><span>Relay (needed because Buffer does not allow direct browser calls)</span>
          <div className="row wrap">
            <input aria-label="Relay URL" value={relay} onChange={(e) => setRelay(e.target.value)} onBlur={() => setSetting('relay.url', relay.trim() || DEFAULT_RELAY)} style={{ width: 280 }} />
            <button className="btn" onClick={async () => { await setSetting('relay.url', relay.trim()); setRelayMsg(await relayHealth(relay.trim())); }}>Check relay</button>
            {relayMsg && <span className={`chip ${relayMsg.ok ? 'ok' : 'err'}`} role="status">{relayMsg.message}</span>}
          </div>
          <div className="muted small">Start it in the DCE folder with <code>npm run relay</code>. It listens on 127.0.0.1 only, forwards only to api.buffer.com and stores nothing.</div>
        </div>
      </div>

      {adding && (
        <Dialog title="Add a Buffer account" onClose={() => setAdding(false)} foot={<>
          <button className="btn" onClick={() => setAdding(false)}>Cancel</button>
          <button className="btn primary" disabled={!newName.trim()} onClick={async () => { const c = await createConnection(newName, 'buffer', newKey); setAdding(false); setNewName(''); setNewKey(''); notify('success', `Account “${c.name}” added${newKey ? ' — API key encrypted' : ''}.`); }}>Add account</button>
        </>}>
          <label className="fld"><span>Account name (e.g. the Buffer login e-mail)</span><input value={newName} onChange={(e) => setNewName(e.target.value)} autoFocus placeholder="name@example.com" aria-label="Account name" /></label>
          <label className="fld"><span>Buffer API key (optional now — stored encrypted)</span><input type="password" autoComplete="new-password" value={newKey} onChange={(e) => setNewKey(e.target.value)} aria-label="API key" /></label>
        </Dialog>
      )}
      {rename !== null && current && (
        <Dialog title="Rename account" onClose={() => setRename(null)} foot={<><button className="btn" onClick={() => setRename(null)}>Cancel</button><button className="btn primary" onClick={async () => { await renameConnection(current.id, rename); setRename(null); }}>Save</button></>}>
          <label className="fld"><span>Name</span><input value={rename} onChange={(e) => setRename(e.target.value)} autoFocus aria-label="Account name" /></label>
        </Dialog>
      )}
      {found && current && (
        <Dialog title={`Channels of ${current.name}`} onClose={() => setFound(null)} size="mid" foot={<>
          <button className="btn" onClick={() => setFound(null)}>Close</button>
          <button className="btn primary" onClick={async () => {
            try {
              const r = await saveChannels(current.id, found);
              const note = r.stale.length ? ` ${r.stale.length} saved channel${r.stale.length === 1 ? ' is' : 's are'} no longer in Buffer.` : '';
              notify(r.stale.length ? 'warn' : 'success', `${r.added.length} channel${r.added.length === 1 ? '' : 's'} added as encrypted properties.${note}`, 7000);
              setFound(null);
            } catch (e) { notify('error', e instanceof Error ? e.message : String(e), 9000); }
          }}>Add all as properties</button>
        </>}>
          <table className="tbl"><thead><tr><th>Service</th><th>Name</th><th>Organization</th></tr></thead>
            <tbody>{found.map((c) => <tr key={c.id}><td>{c.service}</td><td>{c.name}</td><td>{c.org}</td></tr>)}{found.length === 0 && <tr><td colSpan={3} className="muted">No channels connected in this Buffer account.</td></tr>}</tbody></table>
          <div className="muted small">A channel already saved (matched by its id) is not added again, so a channel never appears twice. New ones are saved as <code>BUFFER_CHANNEL_ID_SERVICE_NAME</code> with their id encrypted and hidden. The Content pipeline reads the same list from Buffer and picks up new channels automatically.</div>
        </Dialog>
      )}
    </section>
  );
}
