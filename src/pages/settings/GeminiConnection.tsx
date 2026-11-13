import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { RefreshCw, Sparkles, Trash2 } from 'lucide-react';
import { createConnection, deleteConnection, GEMINI_KEY_PROP, readGeminiKey } from '../../db/connections';
import { db } from '../../db/schema';
import { AUTO_MODEL, GeminiError, pickModel } from '../../pipeline/gemini';
import { getConfig, refreshModels } from '../../pipeline/run';
import { confirmAction, notify } from '../../ui/store';
import { SecretValue } from './Connections';

/** The Gemini API key (free tier works) — stored in the same encrypted vault as the Buffer keys. */
export function GeminiConnection() {
  const conn = useLiveQuery(() => db.connections.where('provider').equals('gemini').first(), [], undefined);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [models, setModels] = useState<string[] | null>(null);

  const test = async () => {
    setBusy(true);
    try {
      const c = await refreshModels();
      setModels(c.names);
      const cfg = await getConfig();
      const chosen = cfg.model === AUTO_MODEL ? pickModel(c.names) : cfg.model;
      if (chosen && c.names.includes(chosen)) notify('success', `Key works — ${c.names.length} models. Writing will use “${chosen}”${cfg.model === AUTO_MODEL ? ' (Auto: newest Flash)' : ''}.`, 7000);
      else notify('warn', `Key works, but the model “${chosen ?? cfg.model}” is not in the list — choose another in Content pipeline → Overview.`, 9000);
    } catch (e) { notify('error', e instanceof GeminiError || e instanceof Error ? e.message : String(e), 9000); }
    setBusy(false);
  };

  const prop = conn?.props.find((p) => p.key === GEMINI_KEY_PROP);
  return (
    <section className="panel" aria-label="Gemini connection">
      <div className="panel-head"><Sparkles size={16} /><h2>Gemini (AI writer)</h2><span className="muted small">Used by the Content pipeline</span></div>
      <div className="panel-body col">
        <div className="callout">
          A free key from <b>Google AI Studio</b> (aistudio.google.com → “Get API key”) is enough. It is <b>encrypted</b> like the Buffer keys and sent only to Google's Gemini API, in a request header.
          The text of the web page being promoted is sent to Google to write the post — on the free tier Google may use such content to improve its products, so only use sources you are happy to share.
        </div>
        {!conn || !prop ? (
          <div className="row">
            <input aria-label="Gemini API key" type="password" autoComplete="new-password" placeholder="Paste your Gemini API key (stored encrypted)" value={key} onChange={(e) => setKey(e.target.value)} style={{ flex: 1, maxWidth: 460 }}
              onKeyDown={async (e) => { if (e.key === 'Enter' && key.trim()) { await createConnection('Gemini', 'gemini', key); setKey(''); notify('success', 'Gemini key saved (encrypted).'); } }} />
            <button className="btn primary" disabled={!key.trim()} onClick={async () => { if (conn) await deleteConnection(conn.id); await createConnection('Gemini', 'gemini', key); setKey(''); notify('success', 'Gemini key saved (encrypted).'); }}>Save key</button>
          </div>
        ) : (
          <table className="tbl" aria-label="Gemini key"><thead><tr><th style={{ width: '42%' }}>Property</th><th>Value</th></tr></thead>
            <tbody><tr><td><code>{prop.key}</code></td><td><SecretValue conn={conn} prop={prop} /></td></tr></tbody></table>
        )}
        <div className="row wrap">
          <button className="btn" onClick={test} disabled={busy || !prop}><RefreshCw size={14} /> {busy ? 'Contacting Google…' : 'Test key & list models'}</button>
          {conn && <button className="btn" onClick={async () => { if (await confirmAction('Remove the Gemini key?', 'The pipeline cannot write posts until you add a key again.')) { await deleteConnection(conn.id); notify('success', 'Gemini key removed.'); } }}><Trash2 size={14} /> Remove key</button>}
          {models && <span className="chip ok" role="status">{models.length} models available</span>}
        </div>
      </div>
    </section>
  );
}
