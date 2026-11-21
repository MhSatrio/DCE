import { useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent, type ReactElement } from 'react';
import { Redo2, Trash2, Undo2, ZoomIn, ZoomOut } from 'lucide-react';
import {
  anchorsOf, boundsOf, colorInput, colorsOf, deleteAnchor, deletePath, insertAnchor, midOf, moveAnchor, moveHandle,
  parseSvg, pathData, replaceColor, serializeSvg, setFill, viewBoxOf, withViewBox, type Pt, type Sub, type SvgDoc,
} from '../../assets/svgdoc';
import { storeSvgAsset, updateSvgAsset } from '../../db/repo';
import type { AssetRow } from '../../db/schema';
import { Dialog, download, Spinner } from '../../ui/kit';
import { useBlobUrl } from '../../ui/hooks';
import { confirmAction, notify } from '../../ui/store';

const MAX_UNDO = 100;
const LIST_LIMIT = 300;
const CHECK = 'repeating-conic-gradient(#eef2f6 0 25%, #fff 0 50%) 0 0 / 16px 16px';
const BLUE = '#2b6cb0';

/** A selected shape (ni null) or a selected point of one of its sub-paths. */
interface Sel { pi: number; si: number; ni: number | null }
interface Hist { past: SvgDoc[]; doc: SvgDoc; future: SvgDoc[] }
type Drag =
  | { kind: 'anchor'; pi: number; si: number; ni: number; last: Pt; pushed: boolean }
  | { kind: 'handle'; pi: number; si: number; seg: number; which: 'c1' | 'c2'; last: Pt; pushed: boolean };

const subOf = (d: SvgDoc, s: Sel | null): Sub | undefined => (s ? d.paths[s.pi]?.subs[s.si] : undefined);
const pointOf = (d: SvgDoc, s: Sel | null): Pt | undefined => {
  const sub = subOf(d, s);
  return s && s.ni != null && sub ? anchorsOf(sub)[s.ni] : undefined;
};
/** The document of some SVG code, or the reason it cannot be read. */
function parseCode(code: string): SvgDoc | string {
  try { return withViewBox(parseSvg(code)); } catch (e) { return e instanceof Error ? e.message : String(e); }
}

/** Whether the selection still exists in the document (an undo can take it away). */
const stillThere = (d: SvgDoc, s: Sel): boolean => {
  const sub = subOf(d, s);
  return !!sub && (s.ni == null || s.ni <= sub.segs.length);
};

/**
 * Vector editor for an SVG asset: select a shape, drag its points and handles (Bézier curves keep their shape),
 * add a point on a line, delete points or shapes, recolour, undo, zoom, and edit the code.
 * "Save changes" writes the same asset, so every template that draws it shows the new version.
 */
export function SvgEditor({ asset, onClose }: { asset: AssetRow; onClose: () => void }) {
  const [hist, setHist] = useState<Hist | null>(null);
  const [saved, setSaved] = useState('');
  const [sel, setSel] = useState<Sel | null>(null);
  const [zoom, setZoom] = useState(1);
  const [tab, setTab] = useState<'shapes' | 'code'>('shapes');
  const [code, setCode] = useState('');
  const [codeErr, setCodeErr] = useState('');
  const [busy, setBusy] = useState(false);
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<Drag | null>(null);
  const selRef = useRef<Sel | null>(sel);
  selRef.current = sel;

  // read the file once for this asset (later saves do not reload it, so undo history survives)
  useEffect(() => {
    let live = true;
    void asset.blob.text().then((t) => {
      if (!live) return;
      const d = withViewBox(parseSvg(t));
      setHist({ past: [], doc: d, future: [] });
      setSaved(serializeSvg(d));
    }).catch((e: unknown) => notify('error', e instanceof Error ? e.message : String(e)));
    return () => { live = false; };
  }, [asset.id]);

  const doc = hist?.doc ?? null;
  const text = useMemo(() => (doc ? serializeSvg(doc) : ''), [doc]);
  const previewBlob = useMemo(() => (doc ? new Blob([text], { type: 'image/svg+xml' }) : null), [doc, text]);
  const preview = useBlobUrl(previewBlob);
  const dirty = doc !== null && text !== saved;
  const box = useMemo(() => (doc ? viewBoxOf(text) ?? boundsOf(doc) : { x: 0, y: 0, w: 100, h: 100 }), [doc, text]);

  // ---- history: every change goes through apply; a drag records one step (its first move)
  const apply = (fn: (d: SvgDoc) => SvgDoc, record = true) => setHist((h) => {
    if (!h) return h;
    const next = fn(h.doc);
    if (next === h.doc) return h;
    return record ? { past: [...h.past, h.doc].slice(-MAX_UNDO), doc: next, future: [] } : { ...h, doc: next };
  });
  const undo = () => setHist((h) => (h && h.past.length ? { past: h.past.slice(0, -1), doc: h.past[h.past.length - 1], future: [h.doc, ...h.future] } : h));
  const redo = () => setHist((h) => (h && h.future.length ? { past: [...h.past, h.doc], doc: h.future[0], future: h.future.slice(1) } : h));

  useEffect(() => {
    if (doc && sel && !stillThere(doc, sel)) setSel(null);
  }, [doc, sel]);

  const removeSelected = () => {
    const s = selRef.current;
    if (!s) return;
    if (s.ni != null) {
      const ni = s.ni;
      apply((d) => deleteAnchor(d, s.pi, s.si, ni));
      setSel({ pi: s.pi, si: s.si, ni: null });
    } else {
      apply((d) => deletePath(d, s.pi));
      setSel(null);
    }
  };

  // keys: Ctrl+Z / Ctrl+Y / Delete (not while typing in a field)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (mod && k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      else if (mod && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); redo(); }
      else if ((e.key === 'Delete' || e.key === 'Backspace') && selRef.current) { e.preventDefault(); removeSelected(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ---- pointer: the drawing's own coordinates, whatever the zoom
  const toSvg = (e: { clientX: number; clientY: number }): Pt | null => {
    const ctm = svgRef.current?.getScreenCTM();
    if (!ctm) return null;
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
    return { x: p.x, y: p.y };
  };
  const onAnchorDown = (e: RPointerEvent<SVGElement>, pi: number, si: number, ni: number) => {
    e.stopPropagation();
    setSel({ pi, si, ni });
    const p = toSvg(e);
    if (!p) return;
    drag.current = { kind: 'anchor', pi, si, ni, last: p, pushed: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onHandleDown = (e: RPointerEvent<SVGElement>, pi: number, si: number, seg: number, which: 'c1' | 'c2') => {
    e.stopPropagation();
    const p = toSvg(e);
    if (!p) return;
    drag.current = { kind: 'handle', pi, si, seg, which, last: p, pushed: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onMove = (e: RPointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    if (!d) return;
    const p = toSvg(e);
    if (!p) return;
    const dx = p.x - d.last.x, dy = p.y - d.last.y;
    d.last = p;
    if (dx === 0 && dy === 0) return;
    const record = !d.pushed;
    d.pushed = true;
    if (d.kind === 'anchor') apply((cur) => moveAnchor(cur, d.pi, d.si, d.ni, dx, dy), record);
    else apply((cur) => moveHandle(cur, d.pi, d.si, d.seg, d.which, dx, dy), record);
  };
  const onUp = () => { drag.current = null; };

  const insertAt = (pi: number, si: number, k: number) => {
    apply((d) => insertAnchor(d, pi, si, k, 0.5));
    setSel({ pi, si, ni: k + 1 });
  };
  const setNodeCoord = (axis: 'x' | 'y', v: number) => {
    const s = selRef.current;
    if (!s || s.ni == null) return;
    apply((d) => {
      const p = pointOf(d, s);
      if (!p) return d;
      return moveAnchor(d, s.pi, s.si, s.ni ?? 0, axis === 'x' ? v - p.x : 0, axis === 'y' ? v - p.y : 0);
    });
  };

  // ---- code tab
  const openCode = () => { setCode(text); setCodeErr(''); setTab('code'); };
  const applyCode = () => {
    if (!/<svg[\s>]/i.test(code)) { setCodeErr('This is not an SVG: it needs an <svg> element.'); return; }
    const parsed = parseCode(code);
    if (typeof parsed === 'string') { setCodeErr(parsed); return; }
    setCodeErr('');
    apply(() => parsed);
    setSel(null);
    setTab('shapes');
  };

  // ---- saving
  const saveInPlace = async () => {
    setBusy(true);
    try {
      await updateSvgAsset(asset.id, text);
      setSaved(text);
      notify('success', 'Saved. Every template that uses this SVG draws the new version.');
    } catch (e) { notify('error', e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const saveAsNew = async () => {
    setBusy(true);
    try {
      const b = viewBoxOf(text) ?? box;
      await storeSvgAsset(text, `${asset.name.replace(/\.svg$/i, '')} (edited)`, Math.max(1, Math.round(b.w)), Math.max(1, Math.round(b.h)), { category: asset.category, tags: asset.tags });
      notify('success', 'Saved as a new SVG asset.');
    } catch (e) { notify('error', e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const tryClose = async () => {
    if (dirty && !(await confirmAction('Discard the changes?', 'The edits are not saved to the asset. Save first if you want to keep them.'))) return;
    onClose();
  };

  // ---- the drawing and its handles, in the drawing's coordinates
  const u = box.w / 100; // one unit of the handles: 1 % of the drawing's width
  const selPath = sel && doc ? doc.paths[sel.pi] : undefined;
  const selSub = doc ? subOf(doc, sel) : undefined;
  const pt = doc ? pointOf(doc, sel) : undefined;

  const overlay = () => {
    if (!doc || !sel || !selPath || !selSub) return null;
    const { pi, si, ni } = sel;
    const out: ReactElement[] = [];
    out.push(<path key="outline" d={pathData(selPath.subs)} fill="none" stroke={BLUE} strokeWidth={u * 0.25} pointerEvents="none" />);
    // + markers on the segments of the selected sub-path: a click adds a point there
    selSub.segs.forEach((_, k) => {
      const m = midOf(selSub, k);
      out.push(
        <g key={`mid${k}`} style={{ cursor: 'copy' }} onPointerDown={(e) => { e.stopPropagation(); insertAt(pi, si, k); }}>
          <circle cx={m.x} cy={m.y} r={u * 0.9} fill="#fff" stroke={BLUE} strokeWidth={u * 0.2} />
          <path d={`M ${m.x - u * 0.5} ${m.y} L ${m.x + u * 0.5} ${m.y} M ${m.x} ${m.y - u * 0.5} L ${m.x} ${m.y + u * 0.5}`} stroke={BLUE} strokeWidth={u * 0.2} pointerEvents="none" />
        </g>,
      );
    });
    // handles of the selected point: the curve arriving at it and the curve leaving it
    if (ni != null) {
      const anchor = anchorsOf(selSub)[ni];
      const arriving = ni >= 1 ? selSub.segs[ni - 1] : undefined;
      const leaving = selSub.segs[ni];
      if (arriving?.kind === 'C') {
        out.push(<line key="ha" x1={anchor.x} y1={anchor.y} x2={arriving.c2.x} y2={arriving.c2.y} stroke={BLUE} strokeWidth={u * 0.15} pointerEvents="none" />);
        out.push(<circle key="hc2" cx={arriving.c2.x} cy={arriving.c2.y} r={u * 0.6} fill="#fff" stroke={BLUE} strokeWidth={u * 0.2} style={{ cursor: 'pointer' }} onPointerDown={(e) => onHandleDown(e, pi, si, ni - 1, 'c2')} />);
      }
      if (leaving?.kind === 'C') {
        out.push(<line key="hl" x1={anchor.x} y1={anchor.y} x2={leaving.c1.x} y2={leaving.c1.y} stroke={BLUE} strokeWidth={u * 0.15} pointerEvents="none" />);
        out.push(<circle key="hc1" cx={leaving.c1.x} cy={leaving.c1.y} r={u * 0.6} fill="#fff" stroke={BLUE} strokeWidth={u * 0.2} style={{ cursor: 'pointer' }} onPointerDown={(e) => onHandleDown(e, pi, si, ni, 'c1')} />);
      }
    }
    // the points of the selected shape (every sub-path of it)
    selPath.subs.forEach((s, sIndex) => anchorsOf(s).forEach((p, nIndex) => {
      const on = sIndex === si && nIndex === ni;
      const half = u * 0.8;
      out.push(
        <rect key={`a${sIndex}-${nIndex}`} x={p.x - half} y={p.y - half} width={half * 2} height={half * 2}
          fill={on ? BLUE : '#fff'} stroke={BLUE} strokeWidth={u * 0.2} style={{ cursor: 'move' }}
          onPointerDown={(e) => onAnchorDown(e, pi, sIndex, nIndex)} />,
      );
    }));
    return out;
  };

  const shapesPanel = doc && (
    <div className="col" style={{ gap: 10 }}>
      <div className="small muted">Click a shape to select it, then drag its points and handles. Click a small + on a line to add a point. Delete removes the selected point, or the whole shape when no point is selected. Ctrl+Z undoes.</div>
      {!sel && <div className="small">No shape selected.</div>}
      {selPath && sel && (
        <label className="fld"><span>Fill colour of this shape</span>
          <input type="color" aria-label="Fill colour of the selected shape" value={colorInput(selPath.attrs.fill ?? '#000000')} onChange={(e) => apply((d) => setFill(d, sel.pi, e.target.value))} />
        </label>
      )}
      {sel && sel.ni != null && pt && (
        <div className="row" style={{ gap: 8 }}>
          <NumField label="x" value={pt.x} onCommit={(v) => setNodeCoord('x', v)} />
          <NumField label="y" value={pt.y} onCommit={(v) => setNodeCoord('y', v)} />
        </div>
      )}
      <div className="fld"><span>Colours in this drawing</span>
        {colorsOf(doc).map((c) => (
          <label key={c.color} className="row" style={{ gap: 8 }}>
            <input type="color" aria-label={`Recolour all ${c.count} shapes of colour ${c.color}`} value={colorInput(c.color)} onChange={(e) => apply((d) => replaceColor(d, c.color, e.target.value))} />
            <span className="small">{c.count} shape{c.count === 1 ? '' : 's'}</span>
          </label>
        ))}
      </div>
      <div className="fld"><span>Shapes ({doc.paths.length})</span>
        <div style={{ maxHeight: 200, overflow: 'auto', display: 'grid', gap: 4 }}>
          {doc.paths.slice(0, LIST_LIMIT).map((p, pi) => (
            <button key={pi} className={`btn ${sel?.pi === pi ? 'primary' : ''}`} style={{ justifyContent: 'flex-start' }} onClick={() => setSel({ pi, si: 0, ni: null })}>
              <span style={{ width: 12, height: 12, background: p.attrs.fill ?? '#000000', display: 'inline-block', border: '1px solid #0002' }} />
              Shape {pi + 1} · {p.subs.reduce((n, s) => n + anchorsOf(s).length, 0)} points
            </button>
          ))}
          {doc.paths.length > LIST_LIMIT && <div className="small muted">and {doc.paths.length - LIST_LIMIT} more (select them on the drawing)</div>}
        </div>
      </div>
      {doc.paths.length === 0 && <div className="callout">This drawing has no shapes to edit. Use the Code tab to change it.</div>}
    </div>
  );

  const codePanel = (
    <div className="col" style={{ gap: 8 }}>
      <textarea aria-label="SVG code" rows={16} value={code} onChange={(e) => setCode(e.target.value)} style={{ fontFamily: 'monospace', fontSize: 12 }} />
      {codeErr && <div className="callout err" role="alert">{codeErr}</div>}
      <div className="row"><button className="btn" onClick={applyCode}>Apply code</button></div>
      <div className="small muted">Applying the code replaces the drawing. Undo brings the previous drawing back.</div>
    </div>
  );

  return (
    <Dialog title={`Edit SVG · ${asset.name}`} onClose={() => void tryClose()} size="wide" foot={<>
      <button className="btn" disabled={!doc} onClick={() => download(new Blob([text], { type: 'image/svg+xml' }), asset.name)}>Export SVG</button>
      <button className="btn" disabled={!doc || busy} onClick={() => void saveAsNew()}>Save as new asset</button>
      <button className="btn" onClick={() => void tryClose()}>Close</button>
      <button className="btn primary" disabled={!dirty || busy} onClick={() => void saveInPlace()}>{busy ? <Spinner /> : null} Save changes</button>
    </>}>
      {!doc ? <Spinner /> : (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 260px', gap: 12, alignItems: 'start' }}>
          <div style={{ minWidth: 0 }}>
            <div className="row wrap" style={{ gap: 6, marginBottom: 8 }}>
              <button className="btn" disabled={!hist?.past.length} onClick={undo} aria-label="Undo"><Undo2 size={14} /> Undo</button>
              <button className="btn" disabled={!hist?.future.length} onClick={redo} aria-label="Redo"><Redo2 size={14} /> Redo</button>
              <button className="btn danger" disabled={!sel} onClick={removeSelected}><Trash2 size={14} /> {sel?.ni != null ? 'Delete point' : 'Delete shape'}</button>
              <span className="grow" />
              <button className="btn" aria-label="Zoom out" disabled={zoom <= 1} onClick={() => setZoom((z) => Math.max(1, z - 0.5))}><ZoomOut size={14} /></button>
              <span className="small muted">{Math.round(zoom * 100)} %</span>
              <button className="btn" aria-label="Zoom in" disabled={zoom >= 4} onClick={() => setZoom((z) => Math.min(4, z + 0.5))}><ZoomIn size={14} /></button>
            </div>
            <div style={{ overflow: 'auto', maxHeight: '60vh', borderRadius: 8, padding: 8, background: CHECK }}>
              <div style={{ position: 'relative', width: `${zoom * 100}%`, margin: '0 auto', aspectRatio: `${box.w} / ${box.h}` }}>
                {preview && <img src={preview} alt="" draggable={false} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain', pointerEvents: 'none' }} />}
                <svg ref={svgRef} role="img" aria-label="Vector drawing" viewBox={`${box.x} ${box.y} ${box.w} ${box.h}`} preserveAspectRatio="xMidYMid meet"
                  style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', touchAction: 'none', userSelect: 'none' }}
                  onPointerDown={() => setSel(null)} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
                  {doc.paths.map((p, pi) => (
                    <path key={pi} d={pathData(p.subs)} fill="none" pointerEvents="all" style={{ cursor: 'pointer' }}
                      onPointerDown={(e) => { e.stopPropagation(); setSel({ pi, si: 0, ni: null }); }} />
                  ))}
                  {overlay()}
                </svg>
              </div>
            </div>
          </div>
          <div style={{ minWidth: 0 }}>
            <div className="row" role="tablist" style={{ gap: 6, marginBottom: 8 }}>
              <button role="tab" aria-selected={tab === 'shapes'} className={`btn ${tab === 'shapes' ? 'primary' : ''}`} onClick={() => setTab('shapes')}>Shapes</button>
              <button role="tab" aria-selected={tab === 'code'} className={`btn ${tab === 'code' ? 'primary' : ''}`} onClick={openCode}>Code</button>
            </div>
            {tab === 'shapes' ? shapesPanel : codePanel}
          </div>
        </div>
      )}
    </Dialog>
  );
}

/** A number field that applies its value when the field is left or Enter is pressed. */
function NumField({ label, value, onCommit }: { label: string; value: number; onCommit: (v: number) => void }) {
  const shown = String(Math.round(value * 100) / 100);
  const [text, setText] = useState(shown);
  useEffect(() => { setText(shown); }, [shown]);
  const commit = () => {
    const v = Number(text);
    if (Number.isFinite(v) && String(v) !== shown) onCommit(v);
    else setText(shown);
  };
  return (
    <label className="fld" style={{ width: 110 }}><span>{label}</span>
      <input type="number" step="0.5" aria-label={`Point ${label}`} value={text} onChange={(e) => setText(e.target.value)} onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
    </label>
  );
}
