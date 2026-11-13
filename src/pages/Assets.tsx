import { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { ImagePlus, Link2, Search, Trash2, Upload, X } from 'lucide-react';
import { deleteAsset, importAssetFiles, importAssetUrl, recordsUsingAsset, templatesUsingAsset } from '../db/repo';
import { clearImageCaches } from '../db/provider';
import { db, type AssetRow } from '../db/schema';
import { Dialog, download, Empty, fmtBytes, fmtDate, go, IconBtn, Spinner } from '../ui/kit';
import { useBlobUrl } from '../ui/hooks';
import { confirmAction, notify } from '../ui/store';

function Tile({ a, sel, onPick }: { a: AssetRow; sel: boolean; onPick: () => void }) {
  const url = useBlobUrl(a.thumb);
  return (
    <button className={`card ${sel ? 'sel' : ''}`} onClick={onPick} aria-label={`Asset ${a.name}`}>
      <div className="pic">{url && <img src={url} alt="" loading="lazy" decoding="async" />}</div>
      <div className="meta"><div className="name" title={a.name}>{a.name}</div><div className="muted small">{a.width}×{a.height} · {fmtBytes(a.size)}</div></div>
    </button>
  );
}

function Detail({ id, onClose }: { id: string; onClose: () => void }) {
  const a = useLiveQuery(() => db.assets.get(id), [id]);
  const recs = useLiveQuery(() => recordsUsingAsset(id), [id], []);
  const tpls = useLiveQuery(() => templatesUsingAsset(id), [id], []);
  const url = useBlobUrl(a?.blob);
  const [tag, setTag] = useState('');
  if (!a) return <aside className="drawer"><div className="empty">Asset not found</div></aside>;
  const patch = (p: Partial<AssetRow>) => db.assets.update(id, p);
  const addTag = async () => { const t = tag.trim(); if (t && !a.tags.includes(t)) await patch({ tags: [...a.tags, t] }); setTag(''); };
  return (
    <aside className="drawer" aria-label="Asset details">
      <div className="panel-head"><h2 className="grow" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</h2><IconBtn icon={<X size={16} />} label="Close details" onClick={onClose} /></div>
      <div className="drawer-body">
        <div className="card" style={{ cursor: 'default' }}><div className="pic" style={{ maxHeight: 260 }}>{url && <img src={url} alt={a.name} />}</div></div>
        <label className="fld"><span>Name</span><input value={a.name} onChange={(e) => void patch({ name: e.target.value })} /></label>
        <label className="fld"><span>Category</span><input list="asset-cats" value={a.category} onChange={(e) => void patch({ category: e.target.value })} /></label>
        <div className="fld"><span>Tags</span>
          <div className="row wrap" style={{ gap: 4 }}>
            {a.tags.map((t) => <span className="chip blue" key={t}>{t}<button aria-label={`Remove tag ${t}`} style={{ border: 0, background: 'none', cursor: 'pointer', padding: 0, display: 'inline-flex' }} onClick={() => void patch({ tags: a.tags.filter((x) => x !== t) })}><X size={12} /></button></span>)}
            <input value={tag} onChange={(e) => setTag(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void addTag(); } }} onBlur={() => void addTag()} placeholder="add tag" aria-label="Add tag" style={{ width: 90, height: 24 }} />
          </div>
        </div>
        <table className="tbl small"><tbody>
          <tr><td className="muted">Dimensions</td><td>{a.width} × {a.height} px</td></tr>
          <tr><td className="muted">Aspect ratio</td><td>{a.aspect}</td></tr>
          <tr><td className="muted">File size</td><td>{fmtBytes(a.size)} ({a.mime})</td></tr>
          <tr><td className="muted">Added</td><td>{fmtDate(a.created_at)}</td></tr>
          {a.sourceUrl && <tr><td className="muted">Source</td><td style={{ wordBreak: 'break-all' }}>{a.sourceUrl}</td></tr>}
          <tr><td className="muted">Asset id</td><td className="mono" style={{ wordBreak: 'break-all' }}>{a.id}</td></tr>
        </tbody></table>
        <div className="fld"><span>Linked records ({recs?.length ?? 0})</span>
          {(recs ?? []).slice(0, 8).map((r) => <a key={r.id} href={`#/content/${r.id}`}>{r.title}</a>)}
          {(recs?.length ?? 0) > 8 && <span className="muted small">and {(recs?.length ?? 0) - 8} more</span>}
          {(recs?.length ?? 0) === 0 && <span className="muted">Not linked to any record.</span>}
        </div>
        <div className="fld"><span>Used in templates ({tpls?.length ?? 0})</span>{(tpls ?? []).map((t) => <a key={t.id} href={`#/editor/${t.id}`}>{t.name}</a>)}{(tpls?.length ?? 0) === 0 && <span className="muted">No template references it directly.</span>}</div>
        <div className="row">
          <button className="btn" onClick={() => download(a.blob, a.name)}>Download</button>
          <button className="btn danger" onClick={async () => {
            const n = (recs?.length ?? 0) + (tpls?.length ?? 0);
            if (!(await confirmAction(`Delete “${a.name}”?`, n ? `It is used by ${recs?.length ?? 0} record(s) and ${tpls?.length ?? 0} template(s). Records lose the link; templates fall back to their fallback image.` : 'This cannot be undone.'))) return;
            await deleteAsset(id); clearImageCaches(); notify('success', 'Asset deleted.'); onClose();
          }}><Trash2 size={14} /> Delete</button>
        </div>
      </div>
    </aside>
  );
}

export default function AssetsPage({ openId }: { openId?: string }) {
  const rows = useLiveQuery(() => db.assets.orderBy('created_at').reverse().toArray(), [], undefined);
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('');
  const [sel, setSel] = useState<string | null>(openId ?? null);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [urlDlg, setUrlDlg] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (openId) setSel(openId); }, [openId]);

  const cats = useMemo(() => [...new Set((rows ?? []).map((a) => a.category))].sort(), [rows]);
  const list = (rows ?? []).filter((a) => (!cat || a.category === cat) && (!q || a.name.toLowerCase().includes(q.toLowerCase()) || a.tags.some((t) => t.toLowerCase().includes(q.toLowerCase()))));

  const upload = async (files: File[]) => {
    const imgs = files.filter((f) => f.type.startsWith('image/') || /\.(png|jpe?g|webp|gif|svg|avif|bmp)$/i.test(f.name));
    if (!imgs.length) { notify('warn', 'No image files in that selection.'); return; }
    setBusy(true);
    const { added, failed } = await importAssetFiles(imgs);
    setBusy(false);
    if (added.length) notify('success', `Added ${added.length} image${added.length === 1 ? '' : 's'}.`);
    failed.forEach((m) => notify('error', m, 9000));
    if (added.length === 1) setSel(added[0].id);
  };

  return (
    <div className="page" onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={(e) => { e.preventDefault(); setOver(false); void upload([...e.dataTransfer.files]); }}>
      <div className="page-head">
        <h1>Assets</h1><span className="muted">{rows?.length ?? 0} image{rows?.length === 1 ? '' : 's'}</span>{busy && <Spinner />}<span className="grow" />
        <div className="search" style={{ margin: 0, width: 240 }}><Search size={15} /><input type="search" placeholder="Search name or tag" aria-label="Search assets" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <select aria-label="Filter by category" value={cat} onChange={(e) => setCat(e.target.value)}><option value="">All categories</option>{cats.map((c) => <option key={c}>{c}</option>)}</select>
        <button className="btn" onClick={() => setUrlDlg(true)}><Link2 size={15} /> From URL</button>
        <button className="btn primary" onClick={() => fileRef.current?.click()}><Upload size={15} /> Upload</button>
        <input ref={fileRef} type="file" accept="image/*" multiple hidden aria-label="Upload images" onChange={(e) => { void upload([...(e.target.files ?? [])]); e.target.value = ''; }} />
      </div>
      <datalist id="asset-cats">{cats.map((c) => <option key={c} value={c} />)}</datalist>
      <div className="split" style={{ gridTemplateColumns: sel ? '1fr auto' : '1fr' }}>
        <div style={{ overflow: 'auto', minHeight: 0 }}>
          {over && <div className="drop over" style={{ marginBottom: 10 }}>Drop images to add them</div>}
          {rows && rows.length === 0 ? (
            <Empty title="No assets yet" icon={<ImagePlus size={26} />}><div className="drop" style={{ minWidth: 320 }}>Drag &amp; drop images here, or use Upload.<br /><span className="small">PNG, JPEG, WebP, GIF, SVG (rasterised). Thumbnails are generated for you.</span></div></Empty>
          ) : (
            <div className="cards" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))' }}>
              {list.map((a) => <Tile key={a.id} a={a} sel={sel === a.id} onPick={() => { setSel(a.id); if (openId) go('#/assets'); }} />)}
              {list.length === 0 && <div className="muted">Nothing matches.</div>}
            </div>
          )}
        </div>
        {sel && <Detail id={sel} onClose={() => setSel(null)} />}
      </div>
      {urlDlg && <UrlDialog onClose={() => setUrlDlg(false)} onDone={(id) => setSel(id)} />}
    </div>
  );
}

function UrlDialog({ onClose, onDone }: { onClose: () => void; onDone: (id: string) => void }) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const go2 = async () => {
    setBusy(true); setErr('');
    try { const a = await importAssetUrl(url.trim()); notify('success', `Imported ${a.name}.`); onDone(a.id); onClose(); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    setBusy(false);
  };
  return (
    <Dialog title="Import image from URL" onClose={onClose} foot={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!url.trim() || busy} onClick={go2}>{busy ? 'Downloading…' : 'Import'}</button></>}>
      <label className="fld"><span>Image URL</span><input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…/image.png" onKeyDown={(e) => e.key === 'Enter' && url.trim() && go2()} /></label>
      <div className="muted small">The image is downloaded once and stored in this browser, so batches stay fast and work offline. Only servers that allow cross-origin downloads (CORS) work; otherwise download the file and upload it.</div>
      {err && <div className="callout err" role="alert">{err}</div>}
    </Dialog>
  );
}
