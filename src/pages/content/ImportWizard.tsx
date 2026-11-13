import { useMemo, useRef, useState } from 'react';
import { FileUp } from 'lucide-react';
import { parseCsv } from '../../db/csv';
import { FIELD_TYPE_LABEL } from '../../db/fields';
import { autoMap, buildRecords, jsonToTable, type ColumnMapping } from '../../db/importer';
import { addRecords, fieldsList, recordsStore, saveField } from '../../db/repo';
import { db, type FieldType } from '../../db/schema';
import { Dialog } from '../../ui/kit';
import { notify, useStore } from '../../ui/store';

const MAX_BYTES = 30 * 1024 * 1024;

export function ImportWizard({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [fileName, setFileName] = useState('');
  const [table, setTable] = useState<{ headers: string[]; rows: string[][] } | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [paste, setPaste] = useState('');
  const custom = useStore(recordsStore, (s) => s.fields);
  const records = useStore(recordsStore, (s) => s.records);
  const fileRef = useRef<HTMLInputElement>(null);
  const fields = useMemo(() => fieldsList(), [custom]);

  const load = (text: string, name: string) => {
    setError('');
    try {
      let t: { headers: string[]; rows: string[][] };
      if (/\.json$/i.test(name) || /^\s*[[{]/.test(text)) t = jsonToTable(text);
      else {
        const rows = parseCsv(text);
        if (rows.length < 2) throw new Error('The file needs a header row and at least one data row.');
        t = { headers: rows[0].map((h) => h.trim()), rows: rows.slice(1) };
      }
      if (t.headers.length === 0) throw new Error('No columns found.');
      if (t.rows.length === 0) throw new Error('No data rows found.');
      setTable(t); setFileName(name); setMapping(autoMap(t.headers, custom)); setStep(2);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > MAX_BYTES) { setError(`File is larger than ${MAX_BYTES / 1024 / 1024} MB.`); return; }
    load(await f.text(), f.name);
  };

  const [preview, setPreview] = useState<ReturnType<typeof buildRecords> | null>(null);
  const validate = async () => {
    if (!table) return;
    setBusy(true);
    const assets = await db.assets.toCollection().toArray();
    const templates = await db.templates.toArray();
    const p = buildRecords(table.rows, mapping, {
      fields: custom,
      assetByName: new Map(assets.map((a) => [a.name.toLowerCase(), a.id])),
      templateByName: new Map(templates.map((t) => [t.name.toLowerCase(), t.id])),
      existingSlugs: new Set(records.map((r) => r.slug)),
      existingIds: new Set(records.map((r) => r.id)),
    });
    setPreview(p); setStep(3); setBusy(false);
  };

  const confirm = async () => {
    if (!preview) return;
    setBusy(true);
    for (const f of [...preview.newFields, ...preview.extendedFields]) await saveField(f);
    const ok = await addRecords(preview.records, { upsert: true });
    setBusy(false);
    if (ok) { notify('success', `Imported ${preview.records.length} record${preview.records.length === 1 ? '' : 's'}${preview.newFields.length ? ` and created ${preview.newFields.length} field${preview.newFields.length === 1 ? '' : 's'}` : ''}.`); onClose(); }
  };

  const targetOptions = [...fields.filter((f) => !f.readonly || f.key === 'id')];
  const set = (i: number, patch: Partial<ColumnMapping>) => setMapping((m) => m.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  return (
    <Dialog
      title={`Import records${fileName ? ` — ${fileName}` : ''}`} onClose={onClose} size="wide"
      foot={<>
        <span className="muted small grow">Step {step} of 3</span>
        {step > 1 && <button className="btn" onClick={() => setStep((s) => (s - 1) as 1 | 2)} disabled={busy}>Back</button>}
        {step === 2 && <button className="btn primary" onClick={validate} disabled={busy || mapping.every((m) => !m.target)}>Validate</button>}
        {step === 3 && <button className="btn primary" onClick={confirm} disabled={busy || !preview || preview.records.length === 0}>{busy ? 'Importing…' : `Import ${preview?.records.length ?? 0} record${preview?.records.length === 1 ? '' : 's'}`}</button>}
      </>}
    >
      {step === 1 && (
        <div className="col">
          <div className="drop" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); void onFile(e.dataTransfer.files[0]); }}>
            <FileUp size={22} /><div>Drop a <b>CSV</b> or <b>JSON</b> file here</div>
            <button className="btn" style={{ marginTop: 8 }} onClick={() => fileRef.current?.click()}>Choose file…</button>
            <input ref={fileRef} type="file" accept=".csv,.tsv,.txt,.json,text/csv,application/json" hidden onChange={(e) => void onFile(e.target.files?.[0])} aria-label="Import file" />
          </div>
          <label className="fld"><span>…or paste CSV / JSON</span>
            <textarea rows={6} value={paste} onChange={(e) => setPaste(e.target.value)} placeholder={'title,status,category\nCentrifuge,Approved,Separation'} />
          </label>
          <div><button className="btn" disabled={!paste.trim()} onClick={() => load(paste, 'pasted')}>Use pasted data</button></div>
          <div className="muted small">Nothing is uploaded — the file is read in your browser. CSV delimiters (comma, semicolon, tab) are detected automatically.</div>
        </div>
      )}
      {step === 2 && table && (
        <div className="col">
          <div className="callout">{table.rows.length.toLocaleString()} rows, {table.headers.length} columns. Map each column to a field, create a new field, or skip it.</div>
          <div style={{ overflow: 'auto', maxHeight: '48vh' }}>
            <table className="tbl">
              <thead><tr><th>Column</th><th>Sample values</th><th>Maps to</th></tr></thead>
              <tbody>
                {mapping.map((m, i) => (
                  <tr key={i}>
                    <td><b>{m.header || <i className="muted">(blank)</i>}</b></td>
                    <td className="muted small" style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{table.rows.slice(0, 3).map((r) => r[i]).filter(Boolean).join(' · ')}</td>
                    <td>
                      <div className="row">
                        <select aria-label={`Map ${m.header}`} value={m.target} onChange={(e) => set(i, { target: e.target.value })} style={{ width: 180 }}>
                          <option value="">— skip —</option>
                          <option value="__new__">＋ New custom field</option>
                          {targetOptions.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                        </select>
                        {m.target === '__new__' && (
                          <select aria-label="New field type" value={m.newType} onChange={(e) => set(i, { newType: e.target.value as FieldType })} style={{ width: 120 }}>
                            {(Object.keys(FIELD_TYPE_LABEL) as FieldType[]).filter((t) => t !== 'relation').map((t) => <option key={t} value={t}>{FIELD_TYPE_LABEL[t]}</option>)}
                          </select>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {step === 3 && preview && (
        <div className="col">
          <div className="row wrap">
            <span className="chip ok">{preview.records.length} valid</span>
            {preview.updates > 0 && <span className="chip blue">{preview.updates} will update existing records</span>}
            {preview.errors.length > 0 && <span className="chip err">{new Set(preview.errors.map((e) => e.row)).size} rows rejected</span>}
            {preview.empty > 0 && <span className="chip">{preview.empty} blank rows ignored</span>}
            {preview.newFields.length > 0 && <span className="chip blue">{preview.newFields.length} new fields: {preview.newFields.map((f) => f.label).join(', ')}</span>}
          </div>
          {preview.errors.length > 0 && (
            <div className="callout warn" style={{ maxHeight: 160, overflow: 'auto' }}>
              Rejected rows are skipped; fix them in the file and import again.
              <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{preview.errors.slice(0, 30).map((e, i) => <li key={i}>Row {e.row}: {e.message}</li>)}{preview.errors.length > 30 && <li>… and {preview.errors.length - 30} more</li>}</ul>
            </div>
          )}
          <div style={{ overflow: 'auto', maxHeight: '40vh' }}>
            <table className="tbl">
              <thead><tr><th>Title</th><th>Status</th><th>Publish date</th><th>Slug</th></tr></thead>
              <tbody>{preview.records.slice(0, 8).map((r) => <tr key={r.id}><td>{r.title}</td><td>{r.status}</td><td>{r.publish_date}</td><td className="mono">{r.slug}</td></tr>)}</tbody>
            </table>
          </div>
        </div>
      )}
      {error && <div className="callout err" role="alert">{error}</div>}
    </Dialog>
  );
}
