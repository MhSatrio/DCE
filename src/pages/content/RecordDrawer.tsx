import { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { ExternalLink, ImagePlus, Trash2, X } from 'lucide-react';
import { coerce, displayValue, getValue, STATUSES } from '../../db/fields';
import { deleteRows, rowName, updateRow, useNameMaps, useTableData, isContent } from '../../db/tables';
import { LinkPicker } from '../../ui/LinkPicker';
import { db, type ContentRecord, type FieldDef } from '../../db/schema';
import { slugify } from '../../engine/binding';
import { AssetPicker } from '../../ui/AssetPicker';
import { IconBtn, Tabs } from '../../ui/kit';
import { Preview } from '../../ui/Preview';
import { renderMarkdown } from '../../ui/markdown';
import { confirmAction } from '../../ui/store';
import { AssetThumb } from '../../ui/Thumb';

function MarkdownEditor({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [tab, setTab] = useState<'edit' | 'preview'>('edit');
  const [text, setText] = useState(value);
  const [html, setHtml] = useState('');
  const last = useRef(value);
  useEffect(() => { if (value !== last.current) { setText(value); last.current = value; } }, [value]);
  useEffect(() => { if (tab === 'preview') void renderMarkdown(text).then(setHtml); }, [tab, text]);
  const commit = () => { if (text !== last.current) { last.current = text; onCommit(text); } };
  return (
    <div className="col" style={{ gap: 4 }}>
      <Tabs tabs={[{ id: 'edit', label: 'Edit' }, { id: 'preview', label: 'Preview' }]} value={tab} onChange={(t) => { commit(); setTab(t); }} />
      {tab === 'edit'
        ? <textarea rows={9} value={text} onChange={(e) => setText(e.target.value)} onBlur={commit} aria-label="Markdown content" className="mono" style={{ fontSize: 13 }} />
        : <div className="md" style={{ minHeight: 120, padding: '4px 2px' }} dangerouslySetInnerHTML={{ __html: html }} />}
    </div>
  );
}

function TagsEditor({ tags, onChange }: { tags: string[]; onChange: (t: string[]) => void }) {
  const [v, setV] = useState('');
  const add = () => { const t = v.trim(); if (t && !tags.includes(t)) onChange([...tags, t]); setV(''); };
  return (
    <div className="row wrap" style={{ gap: 4 }}>
      {tags.map((t) => <span key={t} className="chip blue">{t}<button aria-label={`Remove tag ${t}`} style={{ border: 0, background: 'none', cursor: 'pointer', padding: 0, display: 'inline-flex' }} onClick={() => onChange(tags.filter((x) => x !== t))}><X size={12} /></button></span>)}
      <input value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(); } }} onBlur={add} placeholder="add tag" aria-label="Add tag" style={{ width: 90, height: 24 }} />
    </div>
  );
}

function FieldRow({ f, rec, table }: { f: FieldDef; rec: ContentRecord; table: string }) {
  const names = useNameMaps(f.linkTable ? [f.linkTable] : []);
  const [linkOpen, setLinkOpen] = useState(false);
  const templates = useLiveQuery(() => db.templates.toArray(), [], []);
  const [picker, setPicker] = useState(false);
  const val = getValue(rec, f.key);
  const [text, setText] = useState(displayValue(val));
  const [err, setErr] = useState('');
  useEffect(() => { setText(displayValue(val)); setErr(''); }, [val, rec.id]);
  const save = (v: unknown) => {
    if (f.builtin) void updateRow(table, rec.id, { [f.key]: v } as Partial<ContentRecord>);
    else void updateRow(table, rec.id, { data: { ...rec.data, [f.key]: v } });
  };
  const commitText = () => {
    if (text === displayValue(val)) return;
    const c = coerce(text, f);
    if (c.error) { setErr(c.error); return; }
    setErr('');
    if (f.key === 'title' && rec.slug === slugify(rec.title)) void updateRow(table, rec.id, { title: String(c.value), slug: slugify(String(c.value)) });
    else save(c.value);
  };
  if (f.readonly) return <label className="fld"><span>{f.label} <span className="muted" style={{ fontWeight: 400 }}>(automatic)</span></span><input readOnly value={['date', 'createdTime', 'modifiedTime'].includes(f.type) && val ? new Date(String(val)).toLocaleString() : displayValue(val)} /></label>;
  let control: React.ReactNode;
  switch (f.type) {
    case 'markdown': control = <MarkdownEditor value={String(val ?? '')} onCommit={save} />; break;
    case 'longtext': case 'json': control = <textarea aria-label={f.label} rows={f.type === 'json' ? 4 : 3} value={text} onChange={(e) => setText(e.target.value)} onBlur={commitText} className={f.type === 'json' ? 'mono' : ''} />; break;
    case 'boolean': control = <label className="chk"><input aria-label={f.label} type="checkbox" checked={!!val} onChange={(e) => save(e.target.checked)} /> {val ? 'Yes' : 'No'}</label>; break;
    case 'select':
      control = (
        <select aria-label={f.label} value={String(val ?? '')} onChange={(e) => save(e.target.value)}>
          <option value="">—</option>
          {(f.key === 'status' ? STATUSES : f.options ?? []).concat(val && !(f.key === 'status' ? STATUSES : f.options ?? []).includes(String(val)) ? [String(val)] : []).map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      ); break;
    case 'multiselect': control = f.key === 'tags' ? <TagsEditor tags={rec.tags} onChange={(t) => save(t)} /> : <input aria-label={f.label} value={text} onChange={(e) => setText(e.target.value)} onBlur={commitText} placeholder="a; b; c" />; break;
    case 'date': control = <input aria-label={f.label} type="date" value={String(val ?? '')} onChange={(e) => save(e.target.value)} />; break;
    case 'number': case 'currency': case 'percent': control = <input aria-label={f.label} type="number" value={text} onChange={(e) => setText(e.target.value)} onBlur={commitText} />; break;
    case 'rating': control = <div className="row" role="radiogroup" aria-label={f.label}>{Array.from({ length: f.ratingMax ?? 5 }, (_, i) => <button key={i} className="ibtn" role="radio" aria-checked={Number(val) === i + 1} aria-label={`${i + 1} star${i ? 's' : ''}`} onClick={() => save(Number(val) === i + 1 ? 0 : i + 1)} style={{ color: i < Number(val) ? '#d49a00' : '#cbd5e1', fontSize: 18 }}>★</button>)}</div>; break;
    case 'datetime': control = <input aria-label={f.label} type="datetime-local" value={String(val ?? '')} onChange={(e) => save(e.target.value)} />; break;
    case 'email': case 'phone': control = <input aria-label={f.label} type={f.type === 'email' ? 'email' : 'tel'} value={text} onChange={(e) => setText(e.target.value)} onBlur={commitText} />; break;
    case 'link':
      control = (
        <div className="row wrap" style={{ gap: 4 }}>
          {(Array.isArray(val) ? (val as string[]) : []).map((id) => <span key={id} className="chip blue">{names.get(f.linkTable ?? '')?.get(id) ?? '(deleted)'}</span>)}
          <button className="btn sm" onClick={() => setLinkOpen(true)} aria-label={`Edit links of ${f.label}`}>{Array.isArray(val) && val.length ? 'Change links' : 'Link records'}</button>
          {linkOpen && <LinkPicker fieldLabel={f.label} table={f.linkTable!} current={Array.isArray(val) ? (val as string[]) : []} onSave={(ids) => save(ids)} onClose={() => setLinkOpen(false)} />}
        </div>
      ); break;
    case 'relation':
      control = (
        <div className="row">
          <select aria-label={f.label} className="grow" value={String(val ?? '')} onChange={(e) => save(e.target.value)}>
            <option value="">— none —</option>
            {(templates ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          {!!val && <a className="ibtn" href={`#/editor/${val}`} aria-label="Open linked template" data-tip="Open template"><ExternalLink size={15} /></a>}
        </div>
      ); break;
    case 'image':
      control = (
        <div className="col" style={{ gap: 6 }}>
          <div className="row">
            {!!val && <AssetThumb id={String(val)} size={56} className="lg" />}
            <button className="btn sm" onClick={() => setPicker(true)}><ImagePlus size={14} /> {val ? 'Change' : 'Choose'} asset</button>
            {!!val && <button className="btn sm ghost" onClick={() => save('')}>Clear</button>}
            {!!val && !/^https?:/i.test(String(val)) && <a href={`#/assets/${val}`} className="small">Open in Assets</a>}
          </div>
          <input value={text} onChange={(e) => setText(e.target.value)} onBlur={commitText} placeholder="…or an asset id / https:// image URL" aria-label={`${f.label} reference`} />
          {picker && <AssetPicker current={String(val ?? '')} onPick={(id) => save(id)} onClose={() => setPicker(false)} allowClear />}
        </div>
      ); break;
    default: control = <input aria-label={f.label} value={text} onChange={(e) => setText(e.target.value)} onBlur={commitText} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />;
  }
  return (
    <div className="fld" role="group" aria-label={f.label}>
      <span>{f.label} <code className="muted" style={{ fontWeight: 400 }}>{table === 'content' ? 'content.' : ''}{f.key}</code>{f.sync ? <span className="chip blue" style={{ marginLeft: 6 }}>synced</span> : null}</span>
      {control}
      {err && <span style={{ color: 'var(--danger)' }}>{err}</span>}
    </div>
  );
}

export function RecordDrawer({ id, onClose, table = 'content' }: { id: string; onClose: () => void; table?: string }) {
  const { records, fields } = useTableData(table);
  const rec = useMemo(() => records.find((r) => r.id === id), [records, id]);
  const isC = isContent(table);
  const tpl = useLiveQuery(async () => {
    if (!rec || !isC) return undefined;
    return (rec.template_ref ? await db.templates.get(rec.template_ref) : undefined) ?? (await db.templates.orderBy('updated_at').last());
  }, [rec?.template_ref, rec?.id, isC], undefined);
  if (!rec) return <aside className="drawer"><div className="empty">Record not found</div></aside>;
  const mdFields = fields.filter((f) => f.type === 'markdown');
  const rest = fields.filter((f) => f.type !== 'markdown');
  const name = rowName(rec, table);
  return (
    <aside className="drawer" aria-label="Record details">
      <div className="panel-head">
        <h2 className="grow" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</h2>
        <IconBtn icon={<Trash2 size={15} />} label="Delete record" onClick={async () => { if (await confirmAction('Delete record?', `“${name}” will be permanently removed.`)) { await deleteRows(table, [rec.id]); onClose(); } }} />
        <IconBtn icon={<X size={16} />} label="Close details" onClick={onClose} />
      </div>
      <div className="drawer-body">
        {isC && (
          <div>
            <div className="small muted" style={{ marginBottom: 4 }}>Generated design{tpl ? ` — ${tpl.name}` : ''}</div>
            {tpl ? <Preview doc={tpl.doc} record={rec} width={420} /> : <div className="callout">No template yet. Create one on the Templates page.</div>}
          </div>
        )}
        {rest.map((f) => <FieldRow key={f.key + rec.id} f={f} rec={rec} table={table} />)}
        {mdFields.map((f) => <FieldRow key={f.key + rec.id} f={f} rec={rec} table={table} />)}
      </div>
    </aside>
  );
}
