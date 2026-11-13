import { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Copy, Download, Eye, FileUp, Layers3, Pencil, Plus, Trash2 } from 'lucide-react';
import { ensureThumb } from '../db/thumb';
import { createTemplate, deleteTemplate, duplicateTemplate, exportNjs, importNjs, recordsStore } from '../db/repo';
import { db, type TemplateRow } from '../db/schema';
import { NjsError } from '../engine/njs';
import { Dialog, download, Empty, go, IconBtn, fmtDate } from '../ui/kit';
import { useBlobUrl } from '../ui/hooks';
import { Preview } from '../ui/Preview';
import { confirmAction, notify, useStore } from '../ui/store';

const PRESETS = [
  { label: 'Square post', w: 1080, h: 1080 }, { label: 'Portrait post', w: 1080, h: 1350 }, { label: 'Story / Reel', w: 1080, h: 1920 },
  { label: 'Landscape', w: 1920, h: 1080 }, { label: 'A4 @ 150 dpi', w: 1240, h: 1754 }, { label: 'Banner', w: 1500, h: 500 },
];

function Card({ t, onPreview, onDetails }: { t: TemplateRow; onPreview: () => void; onDetails: () => void }) {
  const url = useBlobUrl(t.thumb);
  useEffect(() => { if (!t.thumb) void ensureThumb(t.id); }, [t.id, t.thumb]);
  return (
    <div className="card" style={{ cursor: 'default' }}>
      <button className="pic" style={{ border: 0, cursor: 'pointer', padding: 0, aspectRatio: `${t.width} / ${t.height}`, maxHeight: 340, background: '#EEF2F6' }} onClick={() => go(`#/editor/${t.id}`)} aria-label={`Open ${t.name} in the editor`}>
        {url ? <img src={url} alt={`${t.name} thumbnail`} /> : <Layers3 size={28} color="#94a3b8" />}
      </button>
      <div className="meta">
        <div className="name" title={t.name}>{t.name}</div>
        <div className="muted small">{t.width} × {t.height} · v{t.version} · {t.sample ? 'sample' : fmtDate(t.updated_at)}</div>
        {t.tags.length > 0 && <div className="row wrap" style={{ gap: 3 }}>{t.tags.map((x) => <span className="chip blue" key={x}>{x}</span>)}</div>}
      </div>
      <div className="card-actions">
        <button className="btn sm primary" onClick={() => go(`#/editor/${t.id}`)}>Edit</button>
        <IconBtn icon={<Eye size={15} />} label="Preview" onClick={onPreview} />
        <IconBtn icon={<Pencil size={15} />} label="Rename / details" onClick={onDetails} />
        <IconBtn icon={<Copy size={15} />} label="Duplicate" onClick={async () => { const r = await duplicateTemplate(t.id); if (r) notify('success', `Duplicated as “${r.name}”.`); }} />
        <IconBtn icon={<Download size={15} />} label="Export .njs" onClick={async () => { const { text, name } = await exportNjs(t.id); download(new Blob([text], { type: 'application/json' }), name); notify('success', `Exported ${name}.`); }} />
        <IconBtn icon={<Trash2 size={15} />} label="Delete" onClick={async () => { if (await confirmAction(`Delete “${t.name}”?`, 'Records that use it lose their template link. Export it first if you may need it again.')) { await deleteTemplate(t.id); notify('success', 'Template deleted.'); } }} />
      </div>
    </div>
  );
}

function NewDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('Untitled template');
  const [w, setW] = useState(1080); const [h, setH] = useState(1080);
  const ok = name.trim() && w >= 16 && h >= 16 && w <= 8192 && h <= 8192;
  return (
    <Dialog title="New template" onClose={onClose} foot={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!ok} onClick={async () => { const r = await createTemplate(name.trim(), w, h); if (r) { onClose(); go(`#/editor/${r.id}`); } }}>Create and open</button></>}>
      <label className="fld"><span>Name</span><input value={name} onChange={(e) => setName(e.target.value)} /></label>
      <div className="row wrap">{PRESETS.map((p) => <button key={p.label} className={`btn sm ${w === p.w && h === p.h ? 'primary' : ''}`} onClick={() => { setW(p.w); setH(p.h); }}>{p.label} <span className="small" style={{ opacity: .75 }}>{p.w}×{p.h}</span></button>)}</div>
      <div className="grid2"><label className="fld"><span>Width (px)</span><input type="number" min={16} max={8192} value={w} onChange={(e) => setW(Number(e.target.value))} /></label><label className="fld"><span>Height (px)</span><input type="number" min={16} max={8192} value={h} onChange={(e) => setH(Number(e.target.value))} /></label></div>
    </Dialog>
  );
}

function DetailsDialog({ t, onClose }: { t: TemplateRow; onClose: () => void }) {
  const [name, setName] = useState(t.name); const [desc, setDesc] = useState(t.description); const [tags, setTags] = useState(t.tags.join(', '));
  return (
    <Dialog title="Template details" onClose={onClose} foot={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!name.trim()} onClick={async () => {
      const doc = { ...t.doc, meta: { ...t.doc.meta, name: name.trim(), description: desc } };
      await db.templates.update(t.id, { name: name.trim(), description: desc, tags: tags.split(',').map((x) => x.trim()).filter(Boolean), doc, updated_at: Date.now() });
      notify('success', 'Template updated.'); onClose();
    }}>Save</button></>}>
      <label className="fld"><span>Name</span><input value={name} onChange={(e) => setName(e.target.value)} /></label>
      <label className="fld"><span>Description</span><textarea rows={3} value={desc} onChange={(e) => setDesc(e.target.value)} /></label>
      <label className="fld"><span>Tags (comma separated)</span><input value={tags} onChange={(e) => setTags(e.target.value)} /></label>
    </Dialog>
  );
}

function PreviewDialog({ t, onClose }: { t: TemplateRow; onClose: () => void }) {
  const records = useStore(recordsStore, (s) => s.records);
  const [rid, setRid] = useState(records.find((r) => r.template_ref === t.id)?.id ?? records[0]?.id ?? '');
  const rec = records.find((r) => r.id === rid);
  return (
    <Dialog title={`Preview — ${t.name}`} onClose={onClose} size="mid" foot={<button className="btn primary" onClick={() => { onClose(); go(`#/editor/${t.id}`); }}>Open in editor</button>}>
      <label className="fld"><span>Sample record</span>
        <select value={rid} onChange={(e) => setRid(e.target.value)}>{records.slice(0, 500).map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}{records.length === 0 && <option value="">(no records — design view)</option>}</select>
      </label>
      <div style={{ display: 'flex', justifyContent: 'center' }}><Preview doc={t.doc} record={rec} width={560} /></div>
    </Dialog>
  );
}

export default function TemplatesPage() {
  const rows = useLiveQuery(() => db.templates.orderBy('updated_at').reverse().toArray(), [], undefined);
  const [dlg, setDlg] = useState<null | 'new'>(null);
  const [prev, setPrev] = useState<TemplateRow | null>(null);
  const [det, setDet] = useState<TemplateRow | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const onImport = async (f?: File) => {
    if (!f) return;
    try {
      if (f.size > 40 * 1024 * 1024) throw new Error('File is larger than 40 MB.');
      const { row, warnings } = await importNjs(await f.text());
      notify('success', `Imported “${row.name}”.`);
      warnings.forEach((w) => notify('warn', w, 7000));
    } catch (e) {
      notify('error', e instanceof NjsError ? `${e.message}${e.issues.length ? ' ' + e.issues.join('; ') : ''}` : `Import failed: ${e instanceof Error ? e.message : String(e)}`, 10000);
    }
    if (fileRef.current) fileRef.current.value = '';
  };

  return (
    <div className="page" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); void onImport(e.dataTransfer.files[0]); }}>
      <div className="page-head">
        <h1>Templates</h1><span className="muted">{rows?.length ?? 0}</span><span className="grow" />
        <button className="btn" onClick={() => fileRef.current?.click()}><FileUp size={15} /> Import .njs</button>
        <input ref={fileRef} type="file" accept=".njs,.json,application/json" hidden aria-label="Import template file" onChange={(e) => void onImport(e.target.files?.[0])} />
        <button className="btn primary" onClick={() => setDlg('new')}><Plus size={15} /> New template</button>
      </div>
      {rows && rows.length === 0 ? (
        <Empty title="No templates yet" icon={<Layers3 size={26} />}>Create one, or drop a .njs file here.<div style={{ marginTop: 8 }}><button className="btn primary" onClick={() => setDlg('new')}>New template</button></div></Empty>
      ) : (
        <div className="cards" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))', overflow: 'auto' }}>
          {(rows ?? []).map((t) => <Card key={t.id} t={t} onPreview={() => setPrev(t)} onDetails={() => setDet(t)} />)}
        </div>
      )}
      {dlg === 'new' && <NewDialog onClose={() => setDlg(null)} />}
      {prev && <PreviewDialog t={prev} onClose={() => setPrev(null)} />}
      {det && <DetailsDialog t={det} onClose={() => setDet(null)} />}
    </div>
  );
}
