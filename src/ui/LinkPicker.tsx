import { useMemo, useState } from 'react';
import { rowName, tableName, useTableData } from '../db/tables';
import { Dialog } from './kit';

/** Choose the records of another table that a link field points to (multi-select, searchable). */
export function LinkPicker(props: { table: string; fieldLabel: string; current: string[]; onSave: (ids: string[]) => void; onClose: () => void }) {
  const { records } = useTableData(props.table);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<string[]>(props.current);
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    const rows = records.map((r) => ({ id: r.id, name: rowName(r, props.table) }));
    return (s ? rows.filter((r) => r.name.toLowerCase().includes(s)) : rows).slice(0, 300);
  }, [records, q, props.table]);
  const toggle = (id: string) => setSel((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));
  return (
    <Dialog title={`${props.fieldLabel} — choose records from “${tableName(props.table)}”`} onClose={props.onClose} foot={<>
      <span className="muted small grow">{sel.length} linked</span>
      <button className="btn" onClick={props.onClose}>Cancel</button>
      <button className="btn primary" onClick={() => { props.onSave(sel); props.onClose(); }}>Save links</button>
    </>}>
      <input type="search" placeholder="Search records" aria-label="Search linked records" value={q} onChange={(e) => setQ(e.target.value)} />
      <div style={{ maxHeight: '48vh', overflow: 'auto', border: '1px solid var(--line)', borderRadius: 4 }} role="listbox" aria-multiselectable="true" aria-label="Records">
        {list.length === 0 && <div className="muted" style={{ padding: 12 }}>No records{q ? ' match' : ' in that table yet'}.</div>}
        {list.map((r) => (
          <label key={r.id} className="layer" style={{ cursor: 'pointer', height: 32 }}>
            <input type="checkbox" checked={sel.includes(r.id)} onChange={() => toggle(r.id)} aria-label={r.name} />
            <span className="nm">{r.name}</span>
          </label>
        ))}
      </div>
    </Dialog>
  );
}
