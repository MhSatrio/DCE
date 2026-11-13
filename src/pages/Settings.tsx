import { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Download, Trash2, Type, Upload } from 'lucide-react';
import { db, type FontRow } from '../db/schema';
import { loadRecords, removeSampleData } from '../db/repo';
import { seedSampleData } from '../db/seed';
import { registerFontData } from '../engine/fonts';
import { uid } from '../engine/njs';
import { Dialog, fmtBytes } from '../ui/kit';
import { confirmAction, notify } from '../ui/store';
import { Connections } from './settings/Connections';
import { GeminiConnection } from './settings/GeminiConnection';
import { HttpConnections } from './settings/HttpConnections';

async function addFontFile(file: File, family: string, weight: string, style: 'normal' | 'italic'): Promise<void> {
  if (file.size > 8 * 1024 * 1024) throw new Error('Font files larger than 8 MB are not accepted.');
  const data = await file.arrayBuffer();
  await registerFontData({ family, weight, style, data }); // validates that the browser can parse it
  const row: FontRow = { id: uid(), family, weight, style, blob: new Blob([data], { type: file.type || 'font/woff2' }), source: 'upload', created_at: Date.now() };
  await db.fonts.put(row);
}

async function addGoogleFont(name: string): Promise<number> {
  const family = name.trim();
  if (!/^[A-Za-z0-9 ]{2,60}$/.test(family)) throw new Error('Enter a Google Fonts family name such as “Montserrat”.');
  const url = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, '+')}:wght@300;400;500;600;700&display=swap`;
  let css: string;
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Google Fonts answered ${r.status} — check the family name.`);
    css = await r.text();
  } catch (e) {
    if (e instanceof Error && /Google Fonts answered/.test(e.message)) throw e;
    throw new Error('Could not reach Google Fonts (offline or blocked). Download the font and import the file instead.');
  }
  const blocks = [...css.matchAll(/\/\*\s*([\w-]+)\s*\*\/\s*@font-face\s*\{([^}]*)\}/g)].filter((m) => m[1] === 'latin');
  if (!blocks.length) throw new Error('No latin font files were returned for that family.');
  let n = 0;
  for (const b of blocks) {
    const weight = /font-weight:\s*(\d+)/.exec(b[2])?.[1] ?? '400';
    const style = (/font-style:\s*(\w+)/.exec(b[2])?.[1] ?? 'normal') as 'normal' | 'italic';
    const src = /url\((https:[^)]+\.woff2)\)/.exec(b[2])?.[1];
    if (!src) continue;
    const blob = await (await fetch(src)).blob();
    await registerFontData({ family, weight, style, data: await blob.arrayBuffer() });
    await db.fonts.put({ id: uid(), family, weight, style, blob, source: 'google', created_at: Date.now() });
    n++;
  }
  return n;
}

function About() {
  const [doc, setDoc] = useState<null | 'terms' | 'license'>(null);
  const [text, setText] = useState('');
  const desktop = /Electron/i.test(navigator.userAgent);
  useEffect(() => {
    if (!doc) return;
    setText('Loading…');
    fetch(doc === 'terms' ? '/TERMS.txt' : '/LICENSE.txt').then((r) => r.text()).then(setText).catch(() => setText('The text could not be loaded.'));
  }, [doc]);
  return (
    <section className="panel" aria-label="About">
      <div className="panel-head"><h2>About</h2></div>
      <div className="panel-body col">
        <div><b>Dynamic Canvas Engine</b> · version {__APP_VERSION__}{desktop ? ' · desktop app' : ' · browser'}</div>
        <div>Concept and product requirements (PRD): <b>Muhammad Satrio</b></div>
        <div className="muted">Free and open-source software under the MIT licence. It is provided as is, without warranty, and nobody is responsible for anything that happens when you install or use it — see the terms.</div>
        <div className="row wrap">
          <button className="btn" onClick={() => setDoc('terms')}>Terms and conditions</button>
          <button className="btn" onClick={() => setDoc('license')}>MIT licence</button>
          {desktop && <span className="muted small">Your data lives in this computer's application-data folder (Help → Open the data folder).</span>}
        </div>
      </div>
      {doc && (
        <Dialog title={doc === 'terms' ? 'Terms and conditions' : 'MIT licence'} onClose={() => setDoc(null)} size="mid" foot={<button className="btn primary" onClick={() => setDoc(null)}>Close</button>}>
          <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 13, margin: 0, maxHeight: '60vh', overflow: 'auto' }}>{text}</pre>
        </Dialog>
      )}
    </section>
  );
}

export default function Settings() {
  const fonts = useLiveQuery(() => db.fonts.toArray(), [], []);
  const [est, setEst] = useState<{ usage: number; quota: number } | null>(null);
  const [counts, setCounts] = useState({ records: 0, templates: 0, assets: 0, jobs: 0, sample: 0 });
  const [gfont, setGfont] = useState('');
  const [busy, setBusy] = useState(false);
  const [fontDlg, setFontDlg] = useState<File | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = async () => {
    const e = await navigator.storage?.estimate?.();
    if (e) setEst({ usage: e.usage ?? 0, quota: e.quota ?? 0 });
    setCounts({
      records: await db.records.count(), templates: await db.templates.count(), assets: await db.assets.count(), jobs: await db.jobs.count(),
      sample: (await db.records.filter((r) => !!r.sample).count()) + (await db.templates.filter((t) => !!t.sample).count()) + (await db.assets.filter((a) => !!a.sample).count()),
    });
  };
  useEffect(() => { void refresh(); }, [fonts]);

  return (
    <div className="page" style={{ overflow: 'auto' }}>
      <div className="page-head"><h1>Settings</h1></div>
      <Connections />
      <GeminiConnection />
      <HttpConnections />
      <section className="panel">
        <div className="panel-head"><h2>Storage</h2></div>
        <div className="panel-body col">
          <div className="row wrap">
            <div className="stat"><b>{counts.records.toLocaleString()}</b><span>records</span></div><div className="stat"><b>{counts.templates}</b><span>templates</span></div>
            <div className="stat"><b>{counts.assets}</b><span>assets</span></div><div className="stat"><b>{counts.jobs}</b><span>jobs</span></div>
            {est && <div className="stat"><b>{fmtBytes(est.usage)}</b><span>of {fmtBytes(est.quota)} browser quota</span></div>}
          </div>
          <div className="muted small">All data lives in this browser's IndexedDB. No telemetry, no uploads. Clearing site data deletes it — export templates (.njs) and records (CSV/JSON) to back them up.</div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head"><h2>Sample data</h2></div>
        <div className="panel-body col">
          <div className="muted">A fictional scientific-equipment catalogue (6 records, 8 images, 1 template) demonstrates the whole workflow. Flagged items: <b>{counts.sample}</b>.</div>
          <div className="row">
            <button className="btn danger" disabled={counts.sample === 0} onClick={async () => { if (await confirmAction('Remove sample data?', 'Flagged sample records, assets and templates are deleted. Your own data stays.', 'Remove')) { await removeSampleData(); await refresh(); } }}><Trash2 size={14} /> Remove sample data</button>
            <button className="btn" onClick={async () => { setBusy(true); try { await seedSampleData(); notify('success', 'Sample workspace restored.'); } catch (e) { notify('error', String(e)); } setBusy(false); await refresh(); }} disabled={busy}>Restore sample data</button>
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head"><Type size={16} /><h2>Fonts</h2></div>
        <div className="panel-body col">
          <div className="muted">Jost is built in and used for the interface and as the default design font. Imported fonts are stored locally and are available to the editor, previews and batch workers.</div>
          <div className="row wrap">
            <button className="btn" onClick={() => fileRef.current?.click()}><Upload size={14} /> Import WOFF2 / TTF / OTF</button>
            <input ref={fileRef} type="file" accept=".woff2,.woff,.ttf,.otf" hidden aria-label="Import font file" onChange={(e) => { const f = e.target.files?.[0]; if (f) setFontDlg(f); e.target.value = ''; }} />
            <span className="grow" />
            <input value={gfont} onChange={(e) => setGfont(e.target.value)} placeholder="Google Fonts family, e.g. Montserrat" aria-label="Google Fonts family" style={{ width: 280 }} />
            <button className="btn" disabled={!gfont.trim() || busy} onClick={async () => {
              setBusy(true);
              try { const n = await addGoogleFont(gfont); notify('success', `Added ${gfont.trim()} (${n} weight${n === 1 ? '' : 's'}) — now stored offline.`); setGfont(''); } catch (e) { notify('error', e instanceof Error ? e.message : String(e), 9000); }
              setBusy(false);
            }}><Download size={14} /> Add from Google Fonts</button>
          </div>
          <table className="tbl"><thead><tr><th>Family</th><th>Weight</th><th>Style</th><th>Source</th><th>Size</th><th /></tr></thead>
            <tbody>
              <tr><td>Jost</td><td>100–900</td><td>normal, italic</td><td>built-in</td><td>—</td><td /></tr>
              {(fonts ?? []).map((f) => (
                <tr key={f.id}><td>{f.family}</td><td>{f.weight}</td><td>{f.style}</td><td>{f.source}</td><td>{fmtBytes(f.blob.size)}</td>
                  <td><button className="btn sm danger" onClick={async () => { if (await confirmAction(`Remove ${f.family} ${f.weight}?`, 'Templates that use it fall back to Jost until the page is reloaded.', 'Remove')) await db.fonts.delete(f.id); }}>Remove</button></td></tr>
              ))}
            </tbody></table>
        </div>
      </section>

      <About />
      <section className="panel">
        <div className="panel-head"><h2>Danger zone</h2></div>
        <div className="panel-body row">
          <button className="btn danger" onClick={async () => {
            if (!(await confirmAction('Erase ALL local data?', 'Records, tables, templates, assets, fonts, saved accounts / API keys, automations and batch history are permanently deleted from this browser.', 'Erase everything'))) return;
            await Promise.all([db.records.clear(), db.templates.clear(), db.assets.clear(), db.fonts.clear(), db.jobs.clear(), db.fields.clear(), db.settings.clear(), db.userTables.clear(), db.rows.clear(), db.connections.clear(), db.automations.clear(), db.autoRuns.clear(), db.sources.clear(), db.posts.clear(), db.pipeRuns.clear()]);
            await db.settings.put({ key: 'seeded', value: true });
            await loadRecords(); await refresh(); notify('success', 'All local data erased.');
          }}><Trash2 size={14} /> Erase all data</button>
        </div>
      </section>
      <div className="muted small">Dynamic Canvas Engine {__APP_VERSION__} · VierApparatus · local-first</div>
      {fontDlg && <FontDialog file={fontDlg} onClose={() => setFontDlg(null)} />}
    </div>
  );
}

function FontDialog({ file, onClose }: { file: File; onClose: () => void }) {
  const [family, setFamily] = useState(file.name.replace(/\.(woff2?|ttf|otf)$/i, '').replace(/[-_](regular|bold|italic|medium|light|semibold)$/i, ''));
  const [weight, setWeight] = useState('400');
  const [style, setStyle] = useState<'normal' | 'italic'>('normal');
  const [err, setErr] = useState('');
  return (
    <Dialog title="Import font" onClose={onClose} foot={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!family.trim()} onClick={async () => {
      try { await addFontFile(file, family.trim(), weight, style); notify('success', `Font “${family.trim()}” imported.`); onClose(); } catch (e) { setErr(e instanceof Error ? e.message : 'The browser could not read this font file.'); }
    }}>Import</button></>}>
      <div className="muted small">{file.name} · {fmtBytes(file.size)}</div>
      <label className="fld"><span>Family name (used in the editor)</span><input value={family} onChange={(e) => setFamily(e.target.value)} /></label>
      <div className="grid2">
        <label className="fld"><span>Weight</span><select value={weight} onChange={(e) => setWeight(e.target.value)}>{['100', '200', '300', '400', '500', '600', '700', '800', '900'].map((w) => <option key={w}>{w}</option>)}</select></label>
        <label className="fld"><span>Style</span><select value={style} onChange={(e) => setStyle(e.target.value as 'normal' | 'italic')}><option>normal</option><option>italic</option></select></label>
      </div>
      {err && <div className="callout err" role="alert">{err}</div>}
    </Dialog>
  );
}
