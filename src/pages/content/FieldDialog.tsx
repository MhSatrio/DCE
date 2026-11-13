import { useMemo, useState } from 'react';
import { AUTO_TYPES, FIELD_TYPE_LABEL, fieldKeyFromLabel } from '../../db/fields';
import type { FieldDef, FieldType } from '../../db/schema';
import { allTables, createLinkPair, fieldsOf, isContent, saveFieldIn, tableName } from '../../db/tables';
import { uid } from '../../engine/njs';
import { Dialog } from '../../ui/kit';
import { notify } from '../../ui/store';

type Kind = FieldType | 'sync';

const GROUPS: { title: string; kinds: Kind[] }[] = [
  { title: 'Text', kinds: ['text', 'longtext', 'markdown', 'email', 'phone', 'url'] },
  { title: 'Numbers', kinds: ['number', 'currency', 'percent', 'rating'] },
  { title: 'Choices', kinds: ['select', 'multiselect', 'boolean'] },
  { title: 'Dates', kinds: ['date', 'datetime', 'createdTime', 'modifiedTime'] },
  { title: 'Relations between tables', kinds: ['link', 'sync'] },
  { title: 'Other', kinds: ['image', 'relation', 'json', 'autonumber'] },
];

const KIND_HELP: Partial<Record<Kind, string>> = {
  link: 'Links each record to records of another table (two-sided: the other table gets a matching field automatically).',
  sync: 'A live copy of a field from a linked record. Change it here or in the other table — both stay identical.',
  autonumber: 'Counts 1, 2, 3… for every new record. Filled in automatically.',
  createdTime: 'The moment the record was created. Filled in automatically.',
  modifiedTime: 'The moment the record last changed. Filled in automatically.',
  relation: 'Points to one of your design templates.',
  image: 'An image from the Assets library (or an https image URL).',
  rating: 'Stars, 0 – 5 by default.',
};

export function FieldDialog({ onClose, existing, table }: { onClose: () => void; existing?: FieldDef; table: string }) {
  const [label, setLabel] = useState(existing?.label ?? '');
  const [kind, setKind] = useState<Kind>(existing?.sync ? 'sync' : existing?.type ?? 'text');
  const [options, setOptions] = useState((existing?.options ?? []).join(', '));
  const [relTo, setRelTo] = useState<'templates' | 'assets' | 'records'>(existing?.relationTo ?? 'templates');
  const [currency, setCurrency] = useState(existing?.currency ?? '$');
  const [ratingMax, setRatingMax] = useState(existing?.ratingMax ?? 5);
  const others = allTables();
  const [linkTable, setLinkTable] = useState(existing?.linkTable ?? others.find((t) => t.id !== table)?.id ?? table);
  const links = fieldsOf(table).filter((f) => f.type === 'link' && f.linkTable);
  const [via, setVia] = useState(existing?.sync?.via ?? links[0]?.key ?? '');
  const viaField = links.find((f) => f.key === via);
  const sourceFields = useMemo(() => (viaField?.linkTable ? fieldsOf(viaField.linkTable).filter((f) => f.type !== 'link' && f.key !== 'id') : []), [viaField]);
  const [source, setSource] = useState(existing?.sync?.source ?? '');
  const srcField = sourceFields.find((f) => f.key === source) ?? sourceFields[0];

  const locked = !!existing;
  const valid = label.trim().length > 0 && (kind !== 'sync' || (!!viaField && !!srcField)) && (kind !== 'link' || !!linkTable);

  const save = async () => {
    const taken = new Set(fieldsOf(table).map((f) => f.key));
    const order = existing?.order ?? Math.max(10, ...fieldsOf(table).filter((f) => !f.builtin || f.order < 50).map((f) => f.order + 1));
    if (!existing && kind === 'link') {
      await createLinkPair(table, label.trim(), linkTable, order);
      notify('success', `Linked to “${tableName(linkTable)}” — a matching field was added there.`);
      onClose(); return;
    }
    const key = existing?.key ?? fieldKeyFromLabel(label || 'field', taken);
    let f: FieldDef;
    if (kind === 'sync') {
      f = { id: existing?.id ?? uid(), key, label: label.trim(), type: srcField!.type, options: srcField!.options, currency: srcField!.currency, ratingMax: srcField!.ratingMax, linkTable: srcField!.linkTable, sync: { via, source: srcField!.key }, order };
    } else {
      f = {
        id: existing?.id ?? uid(), key, label: label.trim(), type: kind, order,
        options: kind === 'select' || kind === 'multiselect' ? options.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
        relationTo: kind === 'relation' ? relTo : kind === 'image' ? 'assets' : undefined,
        currency: kind === 'currency' ? currency : undefined, ratingMax: kind === 'rating' ? Math.max(1, Math.min(10, ratingMax)) : undefined,
        readonly: AUTO_TYPES.includes(kind as FieldType) || undefined,
        linkTable: existing?.linkTable, inverseKey: existing?.inverseKey,
      };
    }
    await saveFieldIn(table, f);
    notify('success', existing ? `Field “${f.label}” updated.` : kind === 'sync' ? `Synced field “${f.label}” created — it now mirrors ${tableName(viaField!.linkTable!)} → ${srcField!.label}.` : `Field “${f.label}” created${isContent(table) ? ` — bind it as {{content.${f.key}}}` : ''}.`);
    onClose();
  };

  return (
    <Dialog title={existing ? 'Edit field' : 'Add a field'} onClose={onClose} size="mid" foot={<>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn primary" disabled={!valid} onClick={save}>{existing ? 'Save' : 'Create field'}</button>
    </>}>
      <label className="fld"><span>Name</span><input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Warranty (years)" autoFocus /></label>
      <div className="fld"><span>Field type</span>
        <div className="col" style={{ gap: 6 }} role="radiogroup" aria-label="Field type">
          {GROUPS.map((g) => (
            <div key={g.title} className="row wrap" style={{ gap: 4 }}>
              <span className="muted small" style={{ width: 130 }}>{g.title}</span>
              {g.kinds.map((k) => (
                <button key={k} role="radio" aria-checked={kind === k} disabled={locked && k !== kind} className={`btn sm ${kind === k ? 'primary' : ''}`}
                  onClick={() => setKind(k)}>{k === 'sync' ? 'Synced field' : FIELD_TYPE_LABEL[k as FieldType]}</button>
              ))}
            </div>
          ))}
        </div>
        {KIND_HELP[kind] && <div className="muted small" style={{ marginTop: 4 }}>{KIND_HELP[kind]}</div>}
      </div>

      {(kind === 'select' || kind === 'multiselect') && <label className="fld"><span>Options (comma separated)</span><input value={options} onChange={(e) => setOptions(e.target.value)} placeholder="Red, Green, Blue" /></label>}
      {kind === 'currency' && <label className="fld"><span>Currency symbol</span><input value={currency} onChange={(e) => setCurrency(e.target.value)} style={{ width: 90 }} aria-label="Currency symbol" /></label>}
      {kind === 'rating' && <label className="fld"><span>Maximum stars</span><input type="number" min={1} max={10} value={ratingMax} onChange={(e) => setRatingMax(Number(e.target.value))} style={{ width: 90 }} aria-label="Maximum stars" /></label>}
      {kind === 'relation' && <label className="fld"><span>Links to</span><select value={relTo} onChange={(e) => setRelTo(e.target.value as typeof relTo)}><option value="templates">Templates</option></select></label>}
      {kind === 'link' && (
        <label className="fld"><span>Link to which table?</span>
          <select aria-label="Linked table" value={linkTable} onChange={(e) => setLinkTable(e.target.value)} disabled={locked}>
            {others.map((t) => <option key={t.id} value={t.id}>{t.name}{t.id === table ? ' (this table)' : ''}</option>)}
          </select>
        </label>
      )}
      {kind === 'sync' && (links.length === 0 ? (
        <div className="callout warn">Synced fields need a <b>link to another table</b> first (it says <i>which</i> record to mirror). Add a “Link to another table” field, then come back.</div>
      ) : (
        <>
          <label className="fld"><span>Through which link field?</span>
            <select aria-label="Link field" value={via} onChange={(e) => { setVia(e.target.value); setSource(''); }} disabled={locked}>
              {links.map((l) => <option key={l.key} value={l.key}>{l.label} → {tableName(l.linkTable!)}</option>)}
            </select>
          </label>
          <label className="fld"><span>Which field of “{viaField?.linkTable ? tableName(viaField.linkTable) : '…'}” to mirror?</span>
            <select aria-label="Source field" value={srcField?.key ?? ''} onChange={(e) => setSource(e.target.value)} disabled={locked}>
              {sourceFields.map((f) => <option key={f.key} value={f.key}>{f.label} ({FIELD_TYPE_LABEL[f.type]})</option>)}
            </select>
          </label>
          <div className="muted small">If several records are linked, the first one is mirrored. Editing this field here changes the source field in the other table.</div>
        </>
      ))}
      {!locked && <div className="muted small">{isContent(table) ? <>Template binding key: <code>{`{{content.${fieldKeyFromLabel(label || 'field', new Set(fieldsOf(table).map((f) => f.key)))}}}`}</code></> : null}</div>}
    </Dialog>
  );
}
