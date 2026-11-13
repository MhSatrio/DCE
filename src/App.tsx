import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  Boxes, CircleHelp, FileImage, FileText, Layers3, LayoutDashboard, Newspaper, PanelLeftClose, PanelLeftOpen, Play, Plus, Search, Settings as Gear, Table2, Zap,
} from 'lucide-react';
import { boot } from './boot';
import { db } from './db/schema';
import { recordsStore } from './db/repo';
import { ConfirmHost, Dialog, go, IconBtn, Spinner, ToastHost, useHash } from './ui/kit';
import { createTable, useTableList } from './db/tables';
import { startAutomationLoop } from './automation/engine';
import { getState } from './pipeline/run';
import { startPipelineLoop } from './pipeline/run';
import { PipelineRunBanner } from './pipeline/RunBanner';
import { startConnectorLoop } from './connector/loop';
import { notify } from './ui/store';
import { useStore } from './ui/store';

const WorkspacePage = lazy(() => import('./pages/Workspace'));
const ContentPage = lazy(() => import('./pages/Content'));
const TemplatesPage = lazy(() => import('./pages/Templates'));
const AssetsPage = lazy(() => import('./pages/Assets'));
const BatchPage = lazy(() => import('./pages/Batch'));
const AutomationsPage = lazy(() => import('./pages/Automations'));
const PipelinePage = lazy(() => import('./pages/Pipeline'));
const SettingsPage = lazy(() => import('./pages/Settings'));
const EditorPage = lazy(() => import('./editor/EditorPage'));

const NAV = [
  { id: 'workspace', path: '#/', label: 'Workspace', icon: LayoutDashboard },
  { id: 'content', path: '#/content', label: 'Content Plan', icon: Table2 },
  { id: 'templates', path: '#/templates', label: 'Templates', icon: Layers3 },
  { id: 'assets', path: '#/assets', label: 'Assets', icon: FileImage },
  { id: 'batch', path: '#/batch', label: 'Batch Runner', icon: Play },
  { id: 'automations', path: '#/automations', label: 'Automations', icon: Zap },
  { id: 'pipeline', path: '#/pipeline', label: 'Content pipeline', icon: Newspaper },
] as const;

export function parseRoute(hash: string): { page: string; arg?: string } {
  const m = /^#\/([^/?]*)(?:\/([^?]*))?/.exec(hash);
  return { page: m?.[1] || 'workspace', arg: m?.[2] ? decodeURIComponent(m[2]) : undefined };
}

function GlobalSearch() {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState(0);
  const records = useStore(recordsStore, (s) => s.records);
  const templates = useLiveQuery(() => db.templates.toArray(), [], []);
  const assets = useLiveQuery(() => db.assets.orderBy('name').keys(), [], [] as string[]);
  const assetRows = useLiveQuery(() => db.assets.toCollection().toArray(), [], []);
  void assets;
  const ref = useRef<HTMLInputElement>(null);

  const results = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return [];
    const out: { kind: string; label: string; sub?: string; path: string }[] = [];
    for (const r of records) { if (r.title.toLowerCase().includes(s) || r.slug.includes(s)) { out.push({ kind: 'Records', label: r.title, sub: r.status, path: `#/content/${r.id}` }); if (out.length > 6) break; } }
    for (const t of templates ?? []) if (t.name.toLowerCase().includes(s)) out.push({ kind: 'Templates', label: t.name, sub: `${t.width}×${t.height}`, path: `#/editor/${t.id}` });
    for (const a of assetRows ?? []) if (a.name.toLowerCase().includes(s) || a.tags.some((x) => x.toLowerCase().includes(s))) { out.push({ kind: 'Assets', label: a.name, sub: a.category, path: `#/assets/${a.id}` }); if (out.length > 16) break; }
    return out;
  }, [q, records, templates, assetRows]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); ref.current?.focus(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const choose = (i: number) => { const r = results[i]; if (r) { go(r.path); setQ(''); setOpen(false); ref.current?.blur(); } };
  let last = '';
  return (
    <div className="search" role="search">
      <Search size={15} />
      <input
        ref={ref} type="search" placeholder="Search records, templates, assets  (Ctrl+K)" aria-label="Search everything" value={q}
        onChange={(e) => { setQ(e.target.value); setOpen(true); setSel(0); }} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(results.length - 1, s + 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
          else if (e.key === 'Enter') choose(sel);
          else if (e.key === 'Escape') { setQ(''); (e.target as HTMLInputElement).blur(); }
        }}
      />
      {open && q.trim() && (
        <div className="search-pop">
          {results.length === 0 && <div className="muted" style={{ padding: 10 }}>No matches</div>}
          {results.map((r, i) => {
            const head = r.kind !== last ? <div className="grp" key={`g${r.kind}`}>{r.kind}</div> : null;
            last = r.kind;
            return (
              <div key={i}>
                {head}
                <button className={i === sel ? 'sel' : ''} onMouseDown={(e) => { e.preventDefault(); choose(i); }}>
                  <span className="grow">{r.label}</span><span className="muted small">{r.sub}</span>
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function HelpDialog({ onClose }: { onClose: () => void }) {
  const k = (s: string) => <span className="kbd">{s}</span>;
  return (
    <Dialog title="Help" onClose={onClose} size="mid" foot={<button className="btn primary" onClick={onClose}>Close</button>}>
      <div className="col">
        <h3>The workflow</h3>
        <ol style={{ margin: 0, paddingLeft: 20 }}>
          <li><b>Templates</b> — design once in the editor (shapes, text, image frames) and bind elements to fields such as <code>{'{{content.title}}'}</code>.</li>
          <li><b>Content Plan</b> — keep thousands of records, import CSV/JSON, add custom fields.</li>
          <li><b>Assets</b> — upload or link product images; records reference them by id.</li>
          <li><b>Batch Runner</b> — filter, choose records, pick a format and render. Download a ZIP.</li>
        </ol>
        <h3>Editor shortcuts</h3>
        <div className="grid2 small">
          <div>{k('V')} Select · {k('R')} Rectangle · {k('O')} Ellipse</div><div>{k('L')} Line · {k('T')} Text · {k('F')} Frame</div>
          <div>{k('Ctrl+Z')} / {k('Ctrl+Shift+Z')} Undo / redo</div><div>{k('Ctrl+C')} {k('Ctrl+V')} {k('Ctrl+D')} Copy / paste / duplicate</div>
          <div>{k('Ctrl+G')} / {k('Ctrl+Shift+G')} Group / ungroup</div><div>{k('Delete')} Remove · {k('Arrows')} Nudge (+Shift ×10)</div>
          <div>{k('Space')}+drag Pan · {k('Ctrl')}+wheel Zoom</div><div>{k('Ctrl+S')} Save · {k('Ctrl+0')} Fit to screen</div>
        </div>
        <h3>Binding syntax</h3>
        <div className="small">
          Text: <code>{'{{content.title}}'}</code>, with filters <code>{'{{content.title|upper}}'}</code>, <code>|lower</code>, <code>|title</code>, <code>|truncate:40</code>, <code>|default:N/A</code>, <code>|number:2</code>, <code>|date</code>.<br />
          Visibility: <code>exists(content.discount)</code>, <code>content.status == "Approved"</code>, <code>!empty(content.badge) &amp;&amp; content.price &gt; 100</code>.<br />
          File names: <code>{'{{content.slug}}.png'}</code>, <code>{'{{index:4}}-{{content.title|slug}}'}</code>.
        </div>
      </div>
    </Dialog>
  );
}

function Shell({ route }: { route: { page: string; arg?: string } }) {
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem('dce.sidebar') === '1'; } catch { return false; } });
  const [help, setHelp] = useState(false);
  const tables = useTableList();
  const alert = useLiveQuery(async () => !!(await getState()).alert, [], false);
  const [newTable, setNewTable] = useState(false);
  const [tname, setTname] = useState('');
  const toggle = () => setCollapsed((c) => { try { localStorage.setItem('dce.sidebar', c ? '0' : '1'); } catch { /* storage unavailable */ } return !c; });
  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href="#/" aria-label="VierApparatus DCE home">
          <img src="/icon.svg" alt="" /><span>VierApparatus</span><span className="sep" /><span className="abbr">DCE</span>
        </a>
        <GlobalSearch />
        <span className="grow" />
        <IconBtn icon={<CircleHelp size={17} />} label="Help" onClick={() => setHelp(true)} />
        <IconBtn icon={<Gear size={17} />} label="Settings" onClick={() => go('#/settings')} on={route.page === 'settings'} />
      </header>
      <PipelineRunBanner hidden={route.page === 'pipeline'} />
      <div className="body">
        <nav className={`sidebar ${collapsed ? 'collapsed' : ''}`} aria-label="Main">
          {NAV.map((n) => {
            const Icon = n.icon;
            const active = route.page === n.id || (n.id === 'workspace' && route.page === 'workspace');
            return (
              <a key={n.id} href={n.path} className={`nav ${active ? 'active' : ''}`} aria-current={active ? 'page' : undefined} title={collapsed ? n.label : undefined}>
                <Icon size={17} /><span>{n.label}</span>{n.id === 'pipeline' && alert && <span className="dot-alert" role="img" aria-label="Pipeline needs attention" />}
              </a>
            );
          })}
          <div className="nav-sep">{collapsed ? '' : 'Your tables'}</div>
          {tables.map((t) => {
            const active = route.page === 'table' && route.arg?.split('/')[0] === t.id;
            return (
              <a key={t.id} href={`#/table/${t.id}`} className={`nav ${active ? 'active' : ''}`} aria-current={active ? 'page' : undefined} title={collapsed ? t.name : undefined}>
                <Table2 size={17} /><span>{t.name}</span>
              </a>
            );
          })}
          <button className="nav" onClick={() => setNewTable(true)} aria-label="New table" title={collapsed ? 'New table' : undefined}><Plus size={17} /><span>New table</span></button>
          <div className="spacer" />
          <button className="nav" onClick={toggle} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
            {collapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}<span>Collapse</span>
          </button>
        </nav>
        <main className="main">
          <Suspense fallback={<div className="page"><Spinner /></div>}>
            {route.page === 'workspace' && <WorkspacePage />}
            {route.page === 'content' && <ContentPage openId={route.arg} />}
            {route.page === 'templates' && <TemplatesPage />}
            {route.page === 'assets' && <AssetsPage openId={route.arg} />}
            {route.page === 'batch' && <BatchPage />}
            {route.page === 'settings' && <SettingsPage />}
            {(route.page === 'automations' || route.page === 'workflows') && <AutomationsPage />}
            {route.page === 'pipeline' && <PipelinePage />}
            {route.page === 'table' && route.arg && <ContentPage key={route.arg.split('/')[0]} tableId={route.arg.split('/')[0]} openId={route.arg.split('/')[1]} />}
            {!['workspace', 'content', 'templates', 'assets', 'batch', 'settings', 'automations', 'pipeline', 'workflows', 'table'].includes(route.page) && (
              <div className="page"><div className="empty"><Boxes size={28} /><h3>Page not found</h3><a href="#/">Back to the workspace</a></div></div>
            )}
          </Suspense>
        </main>
      </div>
      {help && <HelpDialog onClose={() => setHelp(false)} />}
      {newTable && (
        <Dialog title="New table" onClose={() => setNewTable(false)} foot={<>
          <button className="btn" onClick={() => setNewTable(false)}>Cancel</button>
          <button className="btn primary" disabled={!tname.trim()} onClick={async () => { const t = await createTable(tname); setNewTable(false); setTname(''); notify('success', `Table “${t.name}” created.`); go(`#/table/${t.id}`); }}>Create table</button>
        </>}>
          <label className="fld"><span>Table name</span><input value={tname} onChange={(e) => setTname(e.target.value)} placeholder="e.g. Products, Suppliers, Campaigns" autoFocus onKeyDown={async (e) => { if (e.key === 'Enter' && tname.trim()) { const t = await createTable(tname); setNewTable(false); setTname(''); go(`#/table/${t.id}`); } }} /></label>
          <div className="muted small">A table starts with a “Name” field. Add more fields with the + at the end of the header, link it to other tables, or paste rows from a spreadsheet.</div>
        </Dialog>
      )}
    </div>
  );
}

export function App() {
  const hash = useHash();
  const route = parseRoute(hash);
  const [ready, setReady] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { boot().then(() => setReady(true)).catch((e) => setErr(e instanceof Error ? e.message : String(e))); }, []);
  useEffect(() => (ready ? startAutomationLoop() : undefined), [ready]);
  useEffect(() => (ready ? startPipelineLoop() : undefined), [ready]);
  useEffect(() => (ready ? startConnectorLoop() : undefined), [ready]);

  if (err) {
    return (
      <div className="empty" style={{ height: '100%' }}>
        <FileText size={28} /><h3>The local database could not be opened</h3>
        <div style={{ maxWidth: 520 }}>{err}<br />DCE stores everything in your browser's IndexedDB. Private windows, blocked site data or a full disk can prevent this.</div>
        <button className="btn primary" onClick={() => location.reload()}>Try again</button>
      </div>
    );
  }
  if (!ready) return <div className="empty" style={{ height: '100%' }}><Spinner /><div>Opening workspace…</div></div>;
  const isEditor = route.page === 'editor' && route.arg;
  return (
    <>
      {isEditor ? (
        <div className="app editor-mode"><Suspense fallback={<div className="empty"><Spinner /></div>}><EditorPage templateId={route.arg!} /></Suspense></div>
      ) : <Shell route={route} />}
      <ToastHost />
      <ConfirmHost />
    </>
  );
}
