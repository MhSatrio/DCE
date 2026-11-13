import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { ClipboardPaste, Columns3, Copy, Download, FilePlus2, FileUp, Filter, FlaskConical, Maximize2, Pencil, Plus, Search, Trash2, X } from 'lucide-react';
import { toCsv } from '../db/csv';
import { coerce, displayValue, FIELD_TYPE_LABEL, getValue, STATUSES } from '../db/fields';
import { applyFilter, emptyFilter, searchRecords, sortRecords, type FilterGroup } from '../db/filter';
import { newRecord } from '../db/repo';
import { CONTENT_TABLE, createRows, deleteFieldIn, deleteRows, isContent, newRow, rowName, tableName, updateRow, updateRowsWith, useNameMaps, useTableData, writeRows } from '../db/tables';
import { LinkPicker } from '../ui/LinkPicker';
import { deleteTable, renameTable } from '../db/tables';
import { generateDemoRecords } from '../db/seed';
import { buildExportRows } from './content/exportRows';
import { db, type ContentRecord, type FieldDef } from '../db/schema';
import { dependentsFor } from '../db/tables';
import { download, Dialog, Empty, IconBtn, go } from '../ui/kit';
import { FilterBuilder } from '../ui/FilterBuilder';
import { useDebounced, useLocalState } from '../ui/hooks';
import { confirmAction, notify, useStore } from '../ui/store';
import { AssetThumb } from '../ui/Thumb';
import { VirtualGrid, type CellRange, type GridCol } from '../ui/VirtualGrid';
import { AssetPicker } from '../ui/AssetPicker';
import { FieldDialog } from './content/FieldDialog';
import { ImportWizard } from './content/ImportWizard';
import { RecordDrawer } from './content/RecordDrawer';
import { copyRows, parseTsv, planPaste, toTsv, type Lookups } from './content/gridClipboard';

const DEFAULT_HIDDEN = ['content', 'id', 'created_at', 'updated_at'];
const DEFAULT_W: Record<string, number> = { title: 260, status: 110, publish_date: 120, image_asset: 170, template_ref: 170, tags: 170, slug: 190, description: 280, specs: 260, id: 280, created_at: 160, updated_at: 160, content: 240 };

function statusChip(s: string) {
  const cls = s === 'Approved' || s === 'Published' ? 'ok' : s === 'In review' ? 'warn' : '';
  return <span className={`chip ${cls}`}>{s}</span>;
}

function BulkEdit({ ids, fields, onClose, tableId }: { ids: string[]; fields: FieldDef[]; onClose: () => void; tableId: string }) {
  const editable = fields.filter((f) => !f.readonly && f.type !== 'markdown' && f.key !== 'title' && f.key !== 'slug');
  const [key, setKey] = useState(editable[0]?.key ?? 'status');
  const [value, setValue] = useState('');
  const [picker, setPicker] = useState(false);
  const templates = useLiveQuery(() => db.templates.toArray(), [], []);
  const f = editable.find((x) => x.key === key);
  const apply = async () => {
    if (!f) return;
    const c = coerce(value, f);
    if (c.error) { notify('error', c.error); return; }
    const n = await updateRowsWith(tableId, ids, (r) => (f.builtin ? ({ ...r, [f.key]: c.value } as ContentRecord) : { ...r, data: { ...r.data, [f.key]: c.value } }));
    notify('success', `Updated ${f.label} on ${n} record${n === 1 ? '' : 's'}.`);
    onClose();
  };
  return (
    <Dialog title={`Bulk update ${ids.length} record${ids.length === 1 ? '' : 's'}`} onClose={onClose} foot={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={apply} disabled={!f}>Apply</button></>}>
      <label className="fld"><span>Field</span><select value={key} onChange={(e) => { setKey(e.target.value); setValue(''); }}>{editable.map((x) => <option key={x.key} value={x.key}>{x.label} ({FIELD_TYPE_LABEL[x.type]})</option>)}</select></label>
      <label className="fld"><span>New value</span>
        {f?.key === 'status' || f?.type === 'select' ? <select value={value} onChange={(e) => setValue(e.target.value)}><option value="">(empty)</option>{(f.key === 'status' ? STATUSES : f.options ?? []).map((o) => <option key={o}>{o}</option>)}</select>
          : f?.type === 'relation' ? <select value={value} onChange={(e) => setValue(e.target.value)}><option value="">(none)</option>{(templates ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
          : f?.type === 'image' ? <div className="row"><input value={value} onChange={(e) => setValue(e.target.value)} placeholder="asset id or URL" className="grow" /><button className="btn" onClick={() => setPicker(true)}>Choose…</button></div>
          : f?.type === 'boolean' ? <select value={value} onChange={(e) => setValue(e.target.value)}><option value="true">true</option><option value="false">false</option></select>
          : f?.type === 'date' ? <input type="date" value={value} onChange={(e) => setValue(e.target.value)} />
          : <input value={value} onChange={(e) => setValue(e.target.value)} placeholder={f?.type === 'multiselect' ? 'a; b; c' : ''} />}
      </label>
      {picker && <AssetPicker onPick={setValue} onClose={() => setPicker(false)} />}
    </Dialog>
  );
}

export default function ContentPage({ openId, tableId = CONTENT_TABLE }: { openId?: string; tableId?: string }) {
  const { records, fields, loaded } = useTableData(tableId);
  const isC = isContent(tableId);
  const tname = tableName(tableId);
  const customFields = useMemo(() => fields.filter((f) => !f.builtin), [fields]);
  const mk = (partial: Partial<ContentRecord> = {}) => (isC ? newRecord(partial) : newRow(tableId, partial));
  const linkTables = useMemo(() => [...new Set(fields.filter((f) => f.type === 'link' && f.linkTable).map((f) => f.linkTable!))], [fields]);
  const names = useNameMaps(linkTables);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [linkFor, setLinkFor] = useState<{ id: string; field: FieldDef } | null>(null);
  const [fieldMenu, setFieldMenu] = useState<{ x: number; y: number; field: FieldDef } | null>(null);
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 150);
  const [filter, setFilter] = useState<FilterGroup>(emptyFilter());
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' } | null>(isC ? { key: 'created_at', dir: 'desc' } : null);
  const [widths, setWidths] = useLocalState<Record<string, number>>(`dce.cols.${tableId}`, {});
  const [hidden, setHidden] = useLocalState<string[]>(`dce.hidden.${tableId}`, isC ? DEFAULT_HIDDEN : []);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [active, setActive] = useState<string | null>(openId ?? null);
  const [editing, setEditing] = useState<{ id: string; key: string } | null>(null);
  const [panel, setPanel] = useState<null | 'filter' | 'cols' | 'export'>(null);
  const [dlg, setDlg] = useState<null | 'import' | 'field' | 'bulk' | 'demo'>(null);
  const [editField, setEditField] = useState<FieldDef | undefined>();
  const [pickFor, setPickFor] = useState<{ id: string; key: string } | null>(null);
  const [demoN, setDemoN] = useState(1000);
  const [busy, setBusy] = useState(false);
  const lastIdx = useRef(0);
  const stats = useRef({ rendered: 0 });
  // spreadsheet-style cell selection (separate from the row checkboxes used for bulk actions)
  const [cur, setCur] = useState<{ row: number; col: number } | null>(null);
  const [anchor, setAnchor] = useState<{ row: number; col: number } | null>(null);
  const [range, setRange] = useState<CellRange | null>(null);
  const dragging = useRef(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => { if (openId) setActive(openId); }, [openId]);

  const assetNames = useLiveQuery(async () => {
    const [names, ids] = await Promise.all([db.assets.orderBy('name').keys(), db.assets.orderBy('name').primaryKeys()]);
    return new Map(ids.map((id, i) => [id as string, names[i] as string]));
  }, [], new Map<string, string>());
  const templateNames = useLiveQuery(async () => new Map((await db.templates.toArray()).map((t) => [t.id, t.name])), [], new Map<string, string>());

  const view = useMemo(() => sortRecords(applyFilter(searchRecords(records, dq), filter), sort?.key ?? null, sort?.dir ?? 'asc'), [records, dq, filter, sort]);
  const visibleFields = fields.filter((f) => !hidden.includes(f.key));
  const cols: GridCol[] = visibleFields.map((f) => ({ key: f.key, title: f.label, width: widths[f.key] ?? DEFAULT_W[f.key] ?? 150, align: f.type === 'number' ? 'right' : undefined }));
  const activeFilters = filter.conditions.length;

  useEffect(() => { setRange(null); setCur(null); setAnchor(null); }, [dq, filter, sort?.key, sort?.dir]);
  useEffect(() => {
    const up = () => { dragging.current = false; };
    const close = () => setMenu(null);
    window.addEventListener('mouseup', up);
    window.addEventListener('mousedown', close);
    window.addEventListener('blur', close);
    return () => { window.removeEventListener('mouseup', up); window.removeEventListener('mousedown', close); window.removeEventListener('blur', close); };
  }, []);

  const lookups = useMemo<Lookups>(() => ({
    linkName: (t, id) => names.get(t)?.get(id) ?? '', linkByName: (t, n) => { for (const [id, nm] of names.get(t) ?? []) if (nm.toLowerCase() === n.toLowerCase()) return id; return undefined; },
    assetName: assetNames ?? new Map(), templateName: templateNames ?? new Map(),
    assetByName: new Map([...(assetNames ?? new Map<string, string>())].map(([id, n]) => [n.toLowerCase(), id])),
    templateByName: new Map([...(templateNames ?? new Map<string, string>())].map(([id, n]) => [n.toLowerCase(), id])),
  }), [assetNames, templateNames, names]);

  const commit = useCallback(async (rec: ContentRecord, f: FieldDef, raw: string) => {
    setEditing(null);
    if (raw === displayValue(getValue(rec, f.key))) return;
    const c = coerce(raw, f);
    if (c.error) { notify('error', `${f.label}: ${c.error}`); return; }
    if (f.builtin) await updateRow(tableId, rec.id, { [f.key]: c.value } as Partial<ContentRecord>);
    else await updateRow(tableId, rec.id, { data: { ...rec.data, [f.key]: c.value } });
  }, [tableId]);

  /** After an edit ends: hand the keyboard back to the grid and (like a spreadsheet) step down / sideways. */
  const afterEdit = (dRow: number, dCol = 0) => {
    setCur((c) => {
      if (!c) return c;
      const n = { row: Math.max(0, Math.min(view.length - 1, c.row + dRow)), col: Math.max(0, Math.min(visibleFields.length - 1, c.col + dCol)) };
      setAnchor(n); setRange({ r1: n.row, r2: n.row, c1: n.col, c2: n.col });
      return n;
    });
    setTimeout(() => document.querySelector<HTMLElement>('.vgrid-scroll')?.focus(), 0);
  };

  const renderCell = useCallback((rec: ContentRecord, col: GridCol) => {
    const f = fields.find((x) => x.key === col.key)!;
    if (!f) return null;
    const v = getValue(rec, f.key);
    const isEd = editing?.id === rec.id && editing.key === f.key;
    const startEdit = () => {
      if (f.readonly || ['createdTime', 'modifiedTime', 'autonumber'].includes(f.type)) return;
      if (f.type === 'boolean') { void commit(rec, f, String(!v)); return; }
      if (f.type === 'image') setPickFor({ id: rec.id, key: f.key }); // images are chosen from the asset library, not typed
      else if (f.type === 'link') setLinkFor({ id: rec.id, field: f });
      else setEditing({ id: rec.id, key: f.key });
    };
    if (isEd) {
      if (f.type === 'select') {
        const opts = f.key === 'status' ? STATUSES : f.options ?? [];
        return <select autoFocus value={String(v ?? '')} onChange={(e) => void commit(rec, f, e.target.value)} onBlur={() => setEditing(null)} onKeyDown={(e) => { if (e.key === 'Escape') { setEditing(null); afterEdit(0); } }} aria-label={f.label}><option value="">—</option>{[...opts, ...(v && !opts.includes(String(v)) ? [String(v)] : [])].map((o) => <option key={o}>{o}</option>)}</select>;
      }
      if (f.type === 'relation') {
        return <select autoFocus value={String(v ?? '')} onChange={(e) => void commit(rec, f, e.target.value)} onBlur={() => setEditing(null)} onKeyDown={(e) => { if (e.key === 'Escape') { setEditing(null); afterEdit(0); } }} aria-label={f.label}><option value="">—</option>{[...(templateNames ?? new Map())].map(([id, n]) => <option key={id} value={id}>{n}</option>)}</select>;
      }
      return (
        <input
          autoFocus aria-label={f.label} defaultValue={displayValue(v)} type={f.type === 'date' ? 'date' : f.type === 'datetime' ? 'datetime-local' : ['number', 'currency', 'percent', 'rating'].includes(f.type) ? 'number' : 'text'}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { void commit(rec, f, (e.target as HTMLInputElement).value); afterEdit(1); }
            else if (e.key === 'Tab') { e.preventDefault(); void commit(rec, f, (e.target as HTMLInputElement).value); afterEdit(0, e.shiftKey ? -1 : 1); }
            else if (e.key === 'Escape') { setEditing(null); afterEdit(0); }
          }}
          onBlur={(e) => void commit(rec, f, e.target.value)}
        />
      );
    }
    let body: React.ReactNode;
    switch (f.type) {
      case 'boolean': body = <input type="checkbox" aria-label={f.label} checked={!!v} onChange={(e) => void commit(rec, f, String(e.target.checked))} />; break;
      case 'image': body = v ? <span className="row" style={{ gap: 6, minWidth: 0 }}><AssetThumb id={String(v)} size={24} /><span className="txt">{/^https?:/i.test(String(v)) ? 'remote image' : assetNames?.get(String(v)) ?? String(v).slice(0, 8)}</span></span> : null; break;
      case 'link': body = <span className="row" style={{ gap: 3, overflow: 'hidden' }}>{(Array.isArray(v) ? v : []).map((id) => <span className="chip blue" key={String(id)} title={names.get(f.linkTable ?? '')?.get(String(id))}>{names.get(f.linkTable ?? '')?.get(String(id)) ?? '(deleted)'}</span>)}</span>; break;
      case 'rating': { const n = Number(v) || 0; body = <span style={{ color: '#d49a00', letterSpacing: 1 }} aria-label={`${n} of ${f.ratingMax ?? 5}`}>{'★'.repeat(n)}<span style={{ color: '#cbd5e1' }}>{'★'.repeat(Math.max(0, (f.ratingMax ?? 5) - n))}</span></span>; break; }
      case 'currency': body = <span className="txt">{v === '' || v === undefined ? '' : `${f.currency ?? '$'}${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}</span>; break;
      case 'percent': body = <span className="txt">{v === '' || v === undefined ? '' : `${v}%`}</span>; break;
      case 'email': body = v ? <a className="txt" href={`mailto:${String(v)}`} onClick={(e) => e.stopPropagation()}>{String(v)}</a> : null; break;
      case 'phone': body = v ? <a className="txt" href={`tel:${String(v)}`} onClick={(e) => e.stopPropagation()}>{String(v)}</a> : null; break;
      case 'url': body = v ? <a className="txt" href={String(v)} target="_blank" rel="noreferrer noopener" onClick={(e) => e.stopPropagation()}>{String(v)}</a> : null; break;
      case 'datetime': case 'createdTime': case 'modifiedTime': body = <span className="txt">{v ? new Date(String(v)).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : ''}</span>; break;
      case 'relation': body = v ? <span className="txt">{templateNames?.get(String(v)) ?? '(missing)'}</span> : null; break;
      case 'multiselect': body = <span className="row" style={{ gap: 3, overflow: 'hidden' }}>{(Array.isArray(v) ? v : []).map((t) => <span className="chip blue" key={String(t)}>{String(t)}</span>)}</span>; break;
      case 'select': body = f.key === 'status' && v ? statusChip(String(v)) : <span className="txt">{displayValue(v)}</span>; break;
      case 'date': body = <span className="txt">{f.readonly && v ? new Date(String(v)).toLocaleDateString() : displayValue(v)}</span>; break;
      default: body = <span className="txt" title={displayValue(v)}>{displayValue(v).replace(/\s+/g, ' ')}</span>;
    }
    return <div style={{ display: 'flex', alignItems: 'center', width: '100%', height: '100%', minWidth: 0 }} onDoubleClick={startEdit}>{body}</div>;
  }, [fields, editing, assetNames, templateNames, commit, view.length, visibleFields.length, names]);

  const onToggleSelect = (id: string, index: number, shift: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (shift) {
        const [a, b] = [Math.min(lastIdx.current, index), Math.max(lastIdx.current, index)];
        for (let i = a; i <= b; i++) next.add(view[i].id);
      } else if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
    lastIdx.current = index;
  };

  // ---- cell selection, keyboard, copy / paste, context menu --------------------------------------------------
  const norm = (a: { row: number; col: number }, b: { row: number; col: number }): CellRange => ({ r1: Math.min(a.row, b.row), r2: Math.max(a.row, b.row), c1: Math.min(a.col, b.col), c2: Math.max(a.col, b.col) });
  const gridFocus = () => document.querySelector<HTMLElement>('.vgrid-scroll')?.focus();

  const targetRows = (): ContentRecord[] => {
    if (range) return view.slice(range.r1, range.r2 + 1);
    return view.filter((r) => selected.has(r.id));
  };

  const doCopy = (): boolean => {
    let rows: ContentRecord[], fs: FieldDef[];
    if (range) { rows = view.slice(range.r1, range.r2 + 1); fs = visibleFields.slice(range.c1, range.c2 + 1); }
    else if (selected.size) { rows = view.filter((r) => selected.has(r.id)); fs = visibleFields; }
    else return false;
    const text = toTsv(copyRows(rows, fs, lookups));
    lastCopy.current = text;
    notify('info', `Copied ${rows.length} row${rows.length === 1 ? '' : 's'} × ${fs.length} column${fs.length === 1 ? '' : 's'} — paste into a spreadsheet, or here.`);
    return true;
  };
  const lastCopy = useRef('');

  const doPaste = async (text: string) => {
    if (!text.trim() && text !== '') return;
    const start = range ? { row: range.r1, col: range.c1 } : cur;
    if (!start) { notify('warn', 'Click a cell first — the pasted block starts at the selected cell.'); return; }
    const plan = planPaste({ grid: parseTsv(text), startRow: start.row, startCol: start.col, view, fields: visibleFields, lookups, fill: range, make: mk });
    if (plan.created.length && !(await confirmAction(`Create ${plan.created.length} new record${plan.created.length === 1 ? '' : 's'}?`, `The pasted block is longer than the ${view.length} visible row${view.length === 1 ? '' : 's'}; ${plan.created.length} extra row${plan.created.length === 1 ? '' : 's'} will be added as new records.`, 'Paste and create', false))) return;
    if (!plan.cells) { notify('warn', plan.skipped[0] ? `Nothing pasted — ${plan.skipped[0].field}: ${plan.skipped[0].message}` : 'Nothing to paste.'); return; }
    if (!(await writeRows(tableId, plan.updated, plan.created, { prev: new Map(records.map((r) => [r.id, r])) }))) return;
    const bits = [`Pasted ${plan.cells} cell${plan.cells === 1 ? '' : 's'}`];
    if (plan.created.length) bits.push(`${plan.created.length} new record${plan.created.length === 1 ? '' : 's'}`);
    if (plan.ignoredColumns) bits.push(`${plan.ignoredColumns} cell${plan.ignoredColumns === 1 ? '' : 's'} beyond the last visible column ignored`);
    if (plan.readOnly) bits.push(`${plan.readOnly} read-only cell${plan.readOnly === 1 ? '' : 's'} skipped`);
    notify(plan.skipped.length ? 'warn' : 'success', bits.join(' · ') + (plan.skipped.length ? `. ${plan.skipped.length} value${plan.skipped.length === 1 ? '' : 's'} rejected, e.g. ${plan.skipped[0].field} (row ${plan.skipped[0].row}): ${plan.skipped[0].message}` : '.'), plan.skipped.length ? 9000 : 4500);
  };

  const startEditAt = (c: { row: number; col: number } | null) => {
    if (!c) return;
    const rec = view[c.row], f = visibleFields[c.col];
    if (!rec || !f || f.readonly) return;
    if (f.type === 'image') setPickFor({ id: rec.id, key: f.key });
    else if (f.type === 'boolean') void commit(rec, f, String(!getValue(rec, f.key)));
    else setEditing({ id: rec.id, key: f.key });
  };

  const move = (dRow: number, dCol: number, extend: boolean) => {
    if (!cur || !view.length) return;
    const base = extend && anchor ? (range ? { row: range.r1 === anchor.row ? range.r2 : range.r1, col: range.c1 === anchor.col ? range.c2 : range.c1 } : cur) : cur;
    const n = { row: Math.max(0, Math.min(view.length - 1, base.row + dRow)), col: Math.max(0, Math.min(visibleFields.length - 1, base.col + dCol)) };
    if (extend && anchor) setRange(norm(anchor, n));
    else { setCur(n); setAnchor(n); setRange(norm(n, n)); }
  };

  const cellApi = {
    range, active: cur,
    onDown: (row: number, col: number, e: React.MouseEvent) => {
      gridFocus();
      setMenu(null);
      if (e.shiftKey && anchor) setRange(norm(anchor, { row, col }));
      else { const n = { row, col }; setCur(n); setAnchor(n); setRange(norm(n, n)); dragging.current = true; }
    },
    onEnter: (row: number, col: number) => { if (dragging.current && anchor) setRange(norm(anchor, { row, col })); },
    onContext: (row: number, col: number, e: React.MouseEvent) => {
      const inside = range && row >= range.r1 && row <= range.r2 && col >= range.c1 && col <= range.c2;
      if (!inside) { const n = { row, col }; setCur(n); setAnchor(n); setRange(norm(n, n)); }
      setMenu({ x: Math.min(e.clientX, window.innerWidth - 230), y: Math.min(e.clientY, window.innerHeight - 250) });
    },
    onExpand: (id: string) => setActive(id),
    onKeyDown: (e: React.KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (/^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName)) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); if (view.length) { setCur({ row: 0, col: 0 }); setAnchor({ row: 0, col: 0 }); setRange({ r1: 0, r2: view.length - 1, c1: 0, c2: visibleFields.length - 1 }); } return; }
      if (mod) return; // Ctrl+C / Ctrl+V are handled by the copy / paste events
      switch (e.key) {
        case 'ArrowDown': move(1, 0, e.shiftKey); break;
        case 'ArrowUp': move(-1, 0, e.shiftKey); break;
        case 'ArrowLeft': move(0, -1, e.shiftKey); break;
        case 'ArrowRight': move(0, 1, e.shiftKey); break;
        case 'Tab': move(0, e.shiftKey ? -1 : 1, false); break;
        case 'Enter': case 'F2': startEditAt(cur); break;
        case 'Escape': if (cur) setRange(norm(cur, cur)); break;
        case ' ': if (e.shiftKey && cur) { setSelected((p) => { const n = new Set(p); const id = view[cur.row]?.id; if (id) { if (n.has(id)) n.delete(id); else n.add(id); } return n; }); } else return; break;
        default: return;
      }
      e.preventDefault();
    },
    onCopy: (e: React.ClipboardEvent) => {
      if (/^(INPUT|SELECT|TEXTAREA)$/.test((e.target as HTMLElement).tagName)) return;
      if (doCopy()) { e.clipboardData.setData('text/plain', lastCopy.current); e.preventDefault(); }
    },
    onPaste: (e: React.ClipboardEvent) => {
      if (/^(INPUT|SELECT|TEXTAREA)$/.test((e.target as HTMLElement).tagName)) return;
      const text = e.clipboardData.getData('text/plain');
      if (text) { e.preventDefault(); void doPaste(text); }
    },
  };

  const menuAction = async (what: 'open' | 'edit' | 'copy' | 'paste' | 'dup' | 'del') => {
    setMenu(null);
    const rows = targetRows();
    if (what === 'open') { const r = view[cur?.row ?? -1]; if (r) setActive(r.id); }
    else if (what === 'edit') startEditAt(cur);
    else if (what === 'copy') { if (doCopy()) { try { await navigator.clipboard.writeText(lastCopy.current); } catch { notify('warn', 'The browser blocked clipboard access — use Ctrl+C instead.'); } } }
    else if (what === 'paste') { try { await doPaste(await navigator.clipboard.readText()); } catch { notify('warn', 'The browser blocked clipboard access — click a cell and press Ctrl+V instead.'); } }
    else if (what === 'dup') {
      const copies = rows.map(({ id: _id, sample: _s, ...r }) => mk({ ...r, title: isC ? `${r.title} copy` : r.title, slug: isC ? `${r.slug}-copy` : r.slug, tags: [...r.tags], data: { ...r.data }, created_at: Date.now(), updated_at: Date.now() }));
      if (copies.length && (await createRows(tableId, copies))) notify('success', `Duplicated ${copies.length} record${copies.length === 1 ? '' : 's'}.`);
    } else if (what === 'del') {
      const ids = rows.map((r) => r.id);
      if (!ids.length) return;
      if (!(await confirmAction(`Delete ${ids.length} record${ids.length === 1 ? '' : 's'}?`, 'This cannot be undone. Export first if you may need them again.'))) return;
      await deleteRows(tableId, ids); setSelected(new Set()); setRange(null); setCur(null);
      if (active && ids.includes(active)) setActive(null);
      notify('success', `Deleted ${ids.length} record${ids.length === 1 ? '' : 's'}.`);
    }
  };

  const exportData = (kind: 'csv' | 'json') => {
    const rows = selected.size ? view.filter((r) => selected.has(r.id)) : view;
    const ts = new Date().toISOString().slice(0, 10);
    const base = `${tname.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${ts}`;
    if (kind === 'csv') {
      const lines = buildExportRows(rows, fields, names);
      download(new Blob(['\ufeff' + toCsv(lines)], { type: 'text/csv;charset=utf-8' }), `${base}.csv`);
    } else {
      const payload = { format: 'vierapparatus-dce-records', version: 1, table: tname, fields: customFields, records: rows.map(({ sample: _s, ...r }) => r) };
      download(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }), `${base}.json`);
    }
    notify('success', `Exported ${rows.length} record${rows.length === 1 ? '' : 's'} as ${kind.toUpperCase()}.`);
    setPanel(null);
  };

  const add = async () => {
    const r = mk(isC ? { title: 'New record' } : {});
    if (await createRows(tableId, [r])) { if (isC) setSort({ key: 'created_at', dir: 'desc' }); notify('success', isC ? 'Record created — double-click its title to rename it, or use the ⤢ button to open details.' : 'Row added — type in a cell (double-click or Enter), or paste from a spreadsheet.'); }
  };

  const removeSelected = async () => {
    const ids = [...selected];
    if (!(await confirmAction(`Delete ${ids.length} record${ids.length === 1 ? '' : 's'}?`, 'This cannot be undone. Export first if you may need them again.'))) return;
    await deleteRows(tableId, ids); setSelected(new Set()); if (active && ids.includes(active)) setActive(null);
    notify('success', `Deleted ${ids.length} record${ids.length === 1 ? '' : 's'}.`);
  };

  const demo = async () => {
    setBusy(true);
    const n = await generateDemoRecords(demoN).catch((e) => { notify('error', String(e)); return 0; });
    setBusy(false); setDlg(null);
    if (n) notify('success', `Added ${n.toLocaleString()} synthetic sample records (flagged as sample data).`);
  };

  return (
    <div className="page">
      <div className="page-head">
        <h1>{tname}</h1>
        {!isC && <>
          <IconBtn icon={<Pencil size={15} />} label="Rename table" onClick={() => setRenaming(tname)} />
          <IconBtn icon={<Trash2 size={15} />} label="Delete table" onClick={async () => { if (await confirmAction(`Delete table “${tname}”?`, `${records.length} row${records.length === 1 ? '' : 's'}, its fields and automations are permanently removed. Link fields in other tables that point here are removed too.`, 'Delete table')) { await deleteTable(tableId); notify('success', 'Table deleted.'); go('#/content'); } }} />
        </>}
        <span className="muted">{records.length.toLocaleString()} {isC ? 'record' : 'row'}{records.length === 1 ? '' : 's'}</span>
        <span className="grow" />
        <button className="btn primary" onClick={add}><Plus size={15} /> {isC ? 'New record' : 'New row'}</button>
        {isC && <button className="btn" onClick={() => setDlg('import')}><FileUp size={15} /> Import</button>}
        <div style={{ position: 'relative' }}>
          <button className="btn" onClick={() => setPanel(panel === 'export' ? null : 'export')} aria-expanded={panel === 'export'}><Download size={15} /> Export</button>
          {panel === 'export' && (
            <div className="pop" style={{ right: 0, top: 34, minWidth: 190 }}>
              <div className="small muted" style={{ marginBottom: 4 }}>{selected.size ? `${selected.size} selected` : `${view.length} in current view`}</div>
              <div className="col" style={{ gap: 4 }}><button className="btn sm" onClick={() => exportData('csv')}>CSV file</button><button className="btn sm" onClick={() => exportData('json')}>JSON file</button></div>
            </div>
          )}
        </div>
      </div>

      <div className="toolbar">
        <div className="search" style={{ margin: 0, width: 260 }}>
          <Search size={15} /><input type="search" placeholder="Search records" aria-label="Search records" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div style={{ position: 'relative' }}>
          <button className={`btn ${activeFilters ? 'primary' : ''}`} onClick={() => setPanel(panel === 'filter' ? null : 'filter')} aria-expanded={panel === 'filter'}><Filter size={15} /> Filter{activeFilters ? ` (${activeFilters})` : ''}</button>
          {panel === 'filter' && <div className="pop" style={{ left: 0, top: 34, width: 520 }}><FilterBuilder value={filter} onChange={setFilter} fields={fields} /></div>}
        </div>
        <div style={{ position: 'relative' }}>
          <button className="btn" onClick={() => setPanel(panel === 'cols' ? null : 'cols')} aria-expanded={panel === 'cols'}><Columns3 size={15} /> Fields</button>
          {panel === 'cols' && (
            <div className="pop" style={{ left: 0, top: 34, width: 300, maxHeight: 420, overflow: 'auto' }}>
              {fields.map((f) => (
                <div className="row" key={f.key} style={{ padding: '2px 0' }}>
                  <label className="chk grow"><input type="checkbox" checked={!hidden.includes(f.key)} onChange={(e) => setHidden(e.target.checked ? hidden.filter((h) => h !== f.key) : [...hidden, f.key])} /> {f.label}</label>
                  <span className="muted small">{FIELD_TYPE_LABEL[f.type]}</span>
                  {!f.builtin && <>
                    <IconBtn icon={<Pencil size={13} />} label={`Edit field ${f.label}`} onClick={() => { setEditField(f); setDlg('field'); setPanel(null); }} />
                    <IconBtn icon={<Trash2 size={13} />} label={`Delete field ${f.label}`} onClick={async () => { if (await confirmAction(`Delete field “${f.label}”?`, 'Its values are removed from every record.')) { await deleteFieldIn(tableId, f); notify('success', 'Field deleted.'); } }} />
                  </>}
                </div>
              ))}
              <hr style={{ border: 0, borderTop: '1px solid var(--line)' }} />
              <button className="btn sm" onClick={() => { setEditField(undefined); setDlg('field'); setPanel(null); }}><Plus size={14} /> Add custom field</button>
            </div>
          )}
        </div>
        <span className="grow" />
        {selected.size > 0 && <>
          <span className="chip blue">{selected.size} selected</span>
          <button className="btn" onClick={() => setDlg('bulk')}><Pencil size={14} /> Bulk update</button>
          <button className="btn danger" onClick={removeSelected}><Trash2 size={14} /> Delete</button>
          <IconBtn icon={<X size={15} />} label="Clear selection" onClick={() => setSelected(new Set())} />
        </>}
        {isC && <button className="btn ghost" onClick={() => setDlg('demo')} title="Add synthetic records for load testing"><FlaskConical size={14} /> Add demo records</button>}
      </div>

      <div className="split" style={{ gridTemplateColumns: active ? '1fr auto' : '1fr' }}>
        <div className="vgrid">
          {loaded && records.length === 0 && isC ? (
            <Empty title={isC ? 'No records yet' : 'This table is empty'} icon={<FilePlus2 size={26} />}>
              <div className="row" style={{ justifyContent: 'center' }}><button className="btn primary" onClick={add}>{isC ? 'Create a record' : 'Add a row'}</button>{isC && <button className="btn" onClick={() => setDlg('import')}>Import CSV / JSON</button>}</div>
            </Empty>
          ) : (
            <VirtualGrid
              rows={view} rowId={(r) => r.id} cols={cols} sort={sort} stats={stats.current}
              onSort={(k) => setSort((s) => (s?.key === k ? (s.dir === 'asc' ? { key: k, dir: 'desc' } : null) : { key: k, dir: 'asc' }))}
              onResize={(k, w) => setWidths({ ...widths, [k]: w })}
              selected={selected} onToggleSelect={onToggleSelect}
              onToggleAll={(all) => setSelected(all ? new Set(view.map((r) => r.id)) : new Set())}
              activeId={active} renderCell={renderCell} cell={cellApi}
              onAddField={() => { setEditField(undefined); setDlg('field'); }}
              onHeaderContext={(key, e) => { const f = fields.find((x) => x.key === key); if (f) setFieldMenu({ x: Math.min(e.clientX, window.innerWidth - 220), y: Math.min(e.clientY, window.innerHeight - 220), field: f }); }}
              empty={<div className="empty">{records.length === 0 ? 'This table has no rows yet — click “New row”, or paste from a spreadsheet after clicking a cell.' : 'No records match the current search / filter.'}</div>}
            />
          )}
          <div className="statusbar">
            <span>{view.length.toLocaleString()} of {records.length.toLocaleString()} records</span>
            {selected.size > 0 && <span>{selected.size} selected</span>}
            <span className="grow" />
            <span>Click a cell · Shift+click / drag to select a range · Ctrl+C / Ctrl+V copy to and from a spreadsheet · right-click for more</span>
          </div>
        </div>
        {active && <RecordDrawer id={active} table={tableId} onClose={() => { setActive(null); if (openId) go(isC ? '#/content' : `#/table/${tableId}`); }} />}
      </div>

      {menu && (
        <div className="ctx" style={{ left: menu.x, top: menu.y }} role="menu" aria-label="Cell menu" onMouseDown={(e) => e.stopPropagation()}>
          <button role="menuitem" onClick={() => void menuAction('open')}><Maximize2 size={14} /> Open record details</button>
          <button role="menuitem" onClick={() => void menuAction('edit')}><Pencil size={14} /> Edit cell <kbd>Enter</kbd></button>
          <hr />
          <button role="menuitem" onClick={() => void menuAction('copy')}><Copy size={14} /> Copy <kbd>Ctrl+C</kbd></button>
          <button role="menuitem" onClick={() => void menuAction('paste')}><ClipboardPaste size={14} /> Paste <kbd>Ctrl+V</kbd></button>
          <hr />
          <button role="menuitem" onClick={() => void menuAction('dup')}><Copy size={14} /> Duplicate {targetRows().length > 1 ? `${targetRows().length} records` : 'record'}</button>
          <button role="menuitem" className="danger-t" onClick={() => void menuAction('del')}><Trash2 size={14} /> Delete {targetRows().length > 1 ? `${targetRows().length} records` : 'record'}</button>
        </div>
      )}
      {renaming !== null && (
        <Dialog title="Rename table" onClose={() => setRenaming(null)} foot={<><button className="btn" onClick={() => setRenaming(null)}>Cancel</button><button className="btn primary" disabled={!renaming.trim()} onClick={async () => { await renameTable(tableId, renaming); setRenaming(null); notify('success', 'Table renamed.'); }}>Save</button></>}>
          <label className="fld"><span>Table name</span><input value={renaming} onChange={(e) => setRenaming(e.target.value)} autoFocus aria-label="Table name" /></label>
        </Dialog>
      )}
      {fieldMenu && (
        <div className="ctx" style={{ left: fieldMenu.x, top: fieldMenu.y }} role="menu" aria-label="Field menu" onMouseDown={(e) => e.stopPropagation()}>
          <div className="small muted" style={{ padding: '4px 10px' }}>{fieldMenu.field.label} · {FIELD_TYPE_LABEL[fieldMenu.field.type]}{fieldMenu.field.sync ? ' · synced' : ''}</div>
          <button role="menuitem" onClick={() => { setSort({ key: fieldMenu.field.key, dir: 'asc' }); setFieldMenu(null); }}>Sort A → Z</button>
          <button role="menuitem" onClick={() => { setSort({ key: fieldMenu.field.key, dir: 'desc' }); setFieldMenu(null); }}>Sort Z → A</button>
          <button role="menuitem" onClick={() => { setHidden([...hidden, fieldMenu.field.key]); setFieldMenu(null); }}>Hide field</button>
          {!fieldMenu.field.builtin && <>
            <hr />
            <button role="menuitem" onClick={() => { setEditField(fieldMenu.field); setDlg('field'); setFieldMenu(null); }}><Pencil size={14} /> Edit field…</button>
            <button role="menuitem" className="danger-t" onClick={async () => {
              const f = fieldMenu.field; setFieldMenu(null);
              const deps = dependentsFor(tableId, f);
              const extra = deps.length ? ` This also removes ${deps.map((d) => `“${d.field.label}” (${tableName(d.table)})`).join(', ')}.` : '';
              if (await confirmAction(`Delete field “${f.label}”?`, `Its values are removed from every ${isC ? 'record' : 'row'}.${extra}`)) { await deleteFieldIn(tableId, f); notify('success', 'Field deleted.'); }
            }}><Trash2 size={14} /> Delete field</button>
          </>}
        </div>
      )}
      {linkFor && (() => {
        const rec = records.find((r) => r.id === linkFor.id);
        return rec ? <LinkPicker fieldLabel={linkFor.field.label} table={linkFor.field.linkTable!} current={(rec.data[linkFor.field.key] as string[] | undefined) ?? []} onClose={() => setLinkFor(null)}
          onSave={(ids) => void updateRow(tableId, rec.id, { data: { ...rec.data, [linkFor.field.key]: ids } })} /> : null;
      })()}
      {dlg === 'import' && <ImportWizard onClose={() => setDlg(null)} />}
      {dlg === 'field' && <FieldDialog existing={editField} table={tableId} onClose={() => setDlg(null)} />}
      {dlg === 'bulk' && <BulkEdit ids={[...selected]} fields={fields} tableId={tableId} onClose={() => setDlg(null)} />}
      {dlg === 'demo' && (
        <Dialog title="Add demo records" onClose={() => setDlg(null)} foot={<><button className="btn" onClick={() => setDlg(null)}>Cancel</button><button className="btn primary" onClick={demo} disabled={busy}>{busy ? 'Adding…' : `Add ${demoN.toLocaleString()} records`}</button></>}>
          <div>Creates synthetic scientific-equipment records (fictional) for trying batch generation or testing performance. They are flagged as sample data and can be removed in Settings.</div>
          <label className="fld"><span>How many</span><select value={demoN} onChange={(e) => setDemoN(Number(e.target.value))}>{[100, 500, 1000, 5000, 10000].map((n) => <option key={n} value={n}>{n.toLocaleString()}</option>)}</select></label>
        </Dialog>
      )}
      {pickFor && (() => {
        const rec = records.find((r) => r.id === pickFor.id); const f = fields.find((x) => x.key === pickFor.key);
        return rec && f ? <AssetPicker current={String(getValue(rec, f.key) ?? '')} allowClear onPick={(id) => void commit(rec, f, id)} onClose={() => setPickFor(null)} /> : null;
      })()}
    </div>
  );
}
