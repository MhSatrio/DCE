import { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  ArrowLeft, Circle, Download, Eye, Frame, Grid3x3, Image as ImageIcon, Magnet, Maximize, Minus, MousePointer2, PenLine, Pentagon, Plus, Puzzle, Redo2, RotateCcw, Save, ScanEye, Square, Star, Type, Undo2,
} from 'lucide-react';
import { docToNjs, importAssetFiles, recordsStore } from '../db/repo';
import { makeTemplateThumb } from '../db/thumb';
import { db, type TemplateRow } from '../db/schema';
import { saveTemplate } from '../db/repo';
import { makeNode, syncPlaceholders } from '../engine/njs';
import { listPlugins } from '../engine/plugins';
import { AssetPicker } from '../ui/AssetPicker';
import { Dialog, download, go, IconBtn, Spinner } from '../ui/kit';
import { Preview } from '../ui/Preview';
import { confirmAction, notify, useStore } from '../ui/store';
import { slugify } from '../engine/binding';
import { EditorController, type ToolId } from './controller';
import { Inspector } from './Inspector';
import { Layers } from './Layers';
import { TextOverlay } from './TextOverlay';

const TOOLS: { id: ToolId; label: string; key: string; icon: typeof Square }[] = [
  { id: 'select', label: 'Select', key: 'V', icon: MousePointer2 },
  { id: 'rect', label: 'Rectangle', key: 'R', icon: Square },
  { id: 'ellipse', label: 'Ellipse', key: 'O', icon: Circle },
  { id: 'line', label: 'Line', key: 'L', icon: Minus },
  { id: 'polygon', label: 'Polygon', key: 'Y', icon: Pentagon },
  { id: 'star', label: 'Star', key: 'S', icon: Star },
  { id: 'text', label: 'Text', key: 'T', icon: Type },
  { id: 'image', label: 'Image', key: 'I', icon: ImageIcon },
  { id: 'frame', label: 'Image frame', key: 'F', icon: Frame },
  { id: 'pen', label: 'Pen / Bézier (click = corner, click-drag = curve)', key: 'P', icon: PenLine },
];

export default function EditorPage({ templateId }: { templateId: string }) {
  const row = useLiveQuery(async () => (await db.templates.get(templateId)) ?? null, [templateId], undefined);
  const [fixed, setFixed] = useState<TemplateRow | null | undefined>(undefined);
  useEffect(() => { if (row !== undefined && fixed === undefined) setFixed(row); }, [row, fixed]);
  useEffect(() => { setFixed(undefined); }, [templateId]);
  if (fixed === undefined) return <div className="empty" style={{ height: '100%' }}><Spinner /></div>;
  if (fixed === null) return <div className="empty" style={{ height: '100%' }}><h3>Template not found</h3><a href="#/templates">Back to templates</a></div>;
  return <Editor row={fixed} />;
}

function Editor({ row }: { row: TemplateRow }) {
  const ctrl = useMemo(() => new EditorController(structuredClone(row.doc)), [row.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const hostRef = useRef<HTMLDivElement>(null);
  const [leave, setLeave] = useState(false);
  const [outPrev, setOutPrev] = useState(false);
  const [issuesOpen, setIssuesOpen] = useState(false);
  const [pluginMenu, setPluginMenu] = useState(false);
  const [saving, setSaving] = useState(false);
  const records = useStore(recordsStore, (s) => s.records);
  const s = useStore(ctrl.store, (x) => x);
  const doc = s.doc;

  useEffect(() => {
    const host = hostRef.current!;
    const el = document.createElement('canvas');
    host.appendChild(el);
    ctrl.attach(el, host);
    (window as unknown as { __dceEditor?: EditorController }).__dceEditor = ctrl; // test hook (used by the e2e suite)
    return () => { ctrl.dispose(); host.querySelectorAll('.canvas-container, canvas').forEach((n) => n.remove()); };
  }, [ctrl]);

  const save = async (): Promise<boolean> => {
    setSaving(true);
    try {
      const d = structuredClone(ctrl.doc());
      d.placeholders = syncPlaceholders(d);
      const thumb = await makeTemplateThumb(d);
      const saved = await saveTemplate(d, { thumb });
      if (!saved) return false;
      ctrl.markSaved(saved.doc);
      notify('success', `Saved “${saved.name}” (v${saved.version}).`);
      return true;
    } finally { setSaving(false); }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); void save(); } };
    const onUnload = (e: BeforeUnloadEvent) => { if (ctrl.store.get().dirty) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('keydown', onKey);
    window.addEventListener('beforeunload', onUnload);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('beforeunload', onUnload); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctrl]);

  const back = () => { if (ctrl.store.get().dirty) setLeave(true); else go('#/templates'); };

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith('image/') || /\.svg$/i.test(f.name));
    if (!files.length) return;
    const rect = hostRef.current!.getBoundingClientRect();
    const z = ctrl.store.get();
    const at = { x: (e.clientX - rect.left - z.panX) / z.zoom, y: (e.clientY - rect.top - z.panY) / z.zoom };
    const { added, failed } = await importAssetFiles(files);
    added.forEach((a, i) => ctrl.addImageNode(a.id, a.width, a.height, a.name, { x: at.x + i * 30, y: at.y + i * 30 }));
    if (added.length) notify('success', `Added ${added.length} image${added.length > 1 ? 's' : ''} to the library and the canvas.`);
    failed.forEach((m) => notify('error', m, 9000));
  };

  const pickNew = async (id: string) => {
    const a = await db.assets.get(id);
    if (a) ctrl.addImageNode(a.id, a.width, a.height, a.name);
  };

  const selNode = s.selection.length === 1 ? ctrl.getNode(s.selection[0]) : null;
  const pickTarget = s.imageTarget ? ctrl.getNode(s.imageTarget) : null;
  const warn = s.issues.filter((i) => i.level === 'warning').length, err = s.issues.filter((i) => i.level === 'error').length;

  return (
    <div className="ed">
      <div className="ed-top" role="toolbar" aria-label="Editor toolbar">
        <IconBtn icon={<ArrowLeft size={17} />} label="Back to templates" onClick={back} />
        <img src="/icon.svg" alt="" width={20} height={20} />
        <input
          aria-label="Template name" value={doc.meta.name} style={{ width: 200, fontWeight: 600 }}
          onChange={(e) => ctrl.commit((d) => { d.meta.name = e.target.value; }, { coalesce: 'name' })}
        />
        <span className="chip">{doc.canvas.width} × {doc.canvas.height}</span>
        {s.dirty && <span className="chip warn" title="Unsaved changes">unsaved</span>}
        {s.dirty && <button className="btn sm ghost" onClick={async () => {
          if (!(await confirmAction('Revert to the saved version?', 'All changes since the last save are discarded. You can still undo this with Ctrl+Z.', 'Revert'))) return;
          const saved = await db.templates.get(row.id);
          if (saved) { ctrl.replaceDoc(structuredClone(saved.doc)); notify('success', `Reverted to saved version v${saved.version}.`); }
        }}><RotateCcw size={13} /> Revert</button>}
        <span className="vsep" />
        <IconBtn icon={<Undo2 size={16} />} label="Undo (Ctrl+Z)" onClick={() => ctrl.undo()} disabled={!s.canUndo} />
        <IconBtn icon={<Redo2 size={16} />} label="Redo (Ctrl+Shift+Z)" onClick={() => ctrl.redo()} disabled={!s.canRedo} />
        <span className="vsep" />
        <IconBtn icon={<Minus size={16} />} label="Zoom out (Ctrl+−)" onClick={() => ctrl.zoomAt(0.8)} />
        <button className="btn sm ghost" style={{ minWidth: 54 }} onClick={() => ctrl.zoomTo(1)} aria-label="Zoom to 100%" data-tip="Reset to 100% (Ctrl+1)">{Math.round(s.zoom * 100)}%</button>
        <IconBtn icon={<Plus size={16} />} label="Zoom in (Ctrl++)" onClick={() => ctrl.zoomAt(1.25)} />
        <IconBtn icon={<Maximize size={16} />} label="Fit to screen (Ctrl+0)" onClick={() => ctrl.fit()} />
        <IconBtn icon={<Grid3x3 size={16} />} label="Show grid" on={s.grid} onClick={() => ctrl.setGrid(!s.grid)} />
        <IconBtn icon={<Magnet size={16} />} label="Snap to grid and guides" on={s.snap} onClick={() => ctrl.setSnap(!s.snap)} />
        <span className="vsep" />
        <IconBtn icon={<Eye size={16} />} label="Data preview — show real values from a record" on={s.previewOn} onClick={() => ctrl.setPreview(!s.previewOn)} />
        <select aria-label="Preview record" value={s.previewRecordId} onChange={(e) => ctrl.setPreviewRecord(e.target.value)} style={{ width: 170 }} disabled={records.length === 0}>
          {records.slice(0, 400).map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}
          {records.length === 0 && <option value="">No records</option>}
        </select>
        <button className="btn sm" onClick={() => setOutPrev(true)}><ScanEye size={14} /> Output preview</button>
        <span className="grow" />
        <button className="btn sm" onClick={async () => { const text = await docToNjs(ctrl.doc()); download(new Blob([text], { type: 'application/json' }), `${slugify(doc.meta.name) || 'template'}.njs`); notify('success', 'Exported .njs (assets embedded).'); }}><Download size={14} /> .njs</button>
        <button className="btn primary sm" onClick={() => void save()} disabled={saving}><Save size={14} /> {saving ? 'Saving…' : 'Save'}</button>
      </div>

      <div className="ed-body">
        <div className="ed-tools" role="toolbar" aria-label="Tools" aria-orientation="vertical">
          {TOOLS.map((t) => { const I = t.icon; return <IconBtn key={t.id} icon={<I size={17} />} label={`${t.label} (${t.key})`} tipPos="right" on={s.tool === t.id} onClick={() => ctrl.setTool(t.id)} />; })}
          <div style={{ position: 'relative' }}>
            <IconBtn icon={<Puzzle size={17} />} label="Render plugins" tipPos="right" on={pluginMenu} onClick={() => setPluginMenu(!pluginMenu)} />
            {pluginMenu && (
              <div className="pop" style={{ left: 40, top: 0, width: 220 }} role="menu" aria-label="Render plugins">
                <div className="muted small" style={{ marginBottom: 4 }}>Build-time plugins registered in this app</div>
                {listPlugins().map((p) => <button key={p.name} role="menuitem" className="btn sm" style={{ width: '100%' }} onClick={() => { ctrl.addNode({ ...makeNode('plugin', { name: p.label, plugin: { name: p.name, ...p.defaults } }), name: p.label }); setPluginMenu(false); }}>{p.label}</button>)}
              </div>
            )}
          </div>
        </div>
        <Layers ctrl={ctrl} />
        <div className="ed-stage" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
          <div className="canvas-host" ref={hostRef} data-testid="canvas-host" />
          <TextOverlay ctrl={ctrl} />
          {s.tool === 'pen' && <div className="callout" style={{ position: 'absolute', left: 12, top: 12 }}>Pen: click = corner point · click-and-drag = smooth curve{s.penPoints ? ` (${s.penPoints} points)` : ''} · double-click or Enter to finish · click the first point to close · Esc cancels</div>}
          {s.editingPath && (
            <div className="callout" style={{ position: 'absolute', left: 12, top: 12, maxWidth: 560, display: 'flex', gap: 8, alignItems: 'center' }} role="status">
              <span><b>Editing points.</b> Drag points and handles · double-click a point: corner ⇄ smooth · double-click the line: add a point · Delete: remove point · Alt+drag a handle: break symmetry</span>
              <button className="btn sm primary" onClick={() => ctrl.endPathEdit()}>Done</button>
            </div>
          )}
          {s.previewOn && <div className="chip blue" style={{ position: 'absolute', right: 12, top: 12 }}>Data preview: {records.find((r) => r.id === s.previewRecordId)?.title ?? '—'}</div>}
        </div>
        <Inspector ctrl={ctrl} />
      </div>

      <div className="ed-foot">
        <span>{s.pointer ? `x ${s.pointer.x}  y ${s.pointer.y}` : '—'}</span>
        <span>{s.selection.length ? (selNode ? `${selNode.name} · ${Math.round(selNode.width)}×${Math.round(selNode.height)}` : `${s.selection.length} selected`) : 'Nothing selected'}</span>
        <span className="grow" />
        {s.previewOn && (
          <button className="btn sm ghost" onClick={() => setIssuesOpen(true)} style={{ height: 20 }}>
            {err > 0 ? <span style={{ color: 'var(--danger)' }}>{err} error{err > 1 ? 's' : ''}</span> : null}{err > 0 && warn > 0 ? ' · ' : ''}{warn > 0 ? <span style={{ color: 'var(--warn)' }}>{warn} warning{warn > 1 ? 's' : ''}</span> : null}{err + warn === 0 ? 'No issues for this record' : ''}
          </button>
        )}
        <span>Saved v{row.version}</span>
        <span>Space+drag pan · Ctrl+wheel zoom · Shift+arrows nudge 10</span>
      </div>

      {s.pickNewImage && <AssetPicker onPick={(id) => void pickNew(id)} onClose={() => { ctrl.store.set({ pickNewImage: false }); ctrl.setTool('select'); }} />}
      {pickTarget && <AssetPicker current={pickTarget.src?.assetId} onPick={(id) => ctrl.updateNode(pickTarget.id, (n) => { n.src = { assetId: id }; })} onClose={() => ctrl.store.set({ imageTarget: null })} />}
      {outPrev && (
        <Dialog title="Output preview — exactly what the batch renderer produces" onClose={() => setOutPrev(false)} size="mid" foot={<button className="btn primary" onClick={() => setOutPrev(false)}>Close</button>}>
          <label className="fld"><span>Record</span><select value={s.previewRecordId} onChange={(e) => ctrl.setPreviewRecord(e.target.value)}>{records.slice(0, 400).map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}</select></label>
          <div style={{ display: 'flex', justifyContent: 'center' }}><Preview doc={doc} record={records.find((r) => r.id === s.previewRecordId)} width={560} /></div>
          {s.issues.length > 0 && <div className={`callout ${err ? 'err' : 'warn'}`}>{s.issues.map((i, k) => <div key={k}>{i.nodeName ? <b>{i.nodeName}: </b> : null}{i.message}</div>)}</div>}
        </Dialog>
      )}
      {issuesOpen && (
        <Dialog title="Issues for the preview record" onClose={() => setIssuesOpen(false)} foot={<button className="btn primary" onClick={() => setIssuesOpen(false)}>Close</button>}>
          {s.issues.length === 0 ? <div>No issues.</div> : s.issues.map((i, k) => <div key={k} className={`callout ${i.level === 'error' ? 'err' : 'warn'}`}>{i.nodeName ? <b>{i.nodeName}: </b> : null}{i.message}</div>)}
        </Dialog>
      )}
      {leave && (
        <Dialog title="Unsaved changes" onClose={() => setLeave(false)} foot={<>
          <button className="btn" onClick={() => setLeave(false)}>Keep editing</button>
          <button className="btn danger" onClick={() => { ctrl.markSaved(); go('#/templates'); }}>Discard changes</button>
          <button className="btn primary" onClick={async () => { if (await save()) go('#/templates'); }}>Save and leave</button>
        </>}>
          <div>“{doc.meta.name}” has changes that were not saved.</div>
        </Dialog>
      )}
    </div>
  );
}
