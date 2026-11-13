import { Plus, Trash2 } from 'lucide-react';
import { uid } from '../engine/njs';
import { STATUSES } from '../db/fields';
import { NO_VALUE_OPS, OPERATOR_LABEL, type Condition, type FilterGroup, type Operator } from '../db/filter';
import type { FieldDef } from '../db/schema';
import { IconBtn } from './kit';

const TEXT_OPS: Operator[] = ['eq', 'neq', 'contains', 'not_contains', 'empty', 'not_empty'];
const NUM_OPS: Operator[] = ['eq', 'neq', 'gt', 'lt', 'gte', 'lte', 'empty', 'not_empty'];
const DATE_OPS: Operator[] = ['eq', 'neq', 'before', 'after', 'gte', 'lte', 'empty', 'not_empty'];

export function opsFor(f: FieldDef | undefined): Operator[] {
  if (!f) return TEXT_OPS;
  if (f.type === 'link') return ['empty', 'not_empty'];
  if (f.type === 'number' || f.type === 'currency' || f.type === 'percent' || f.type === 'rating' || f.type === 'autonumber') return NUM_OPS;
  if (f.type === 'date' || f.type === 'datetime' || f.type === 'createdTime' || f.type === 'modifiedTime') return DATE_OPS;
  if (f.type === 'boolean') return ['eq', 'neq'];
  if (f.type === 'select' || f.type === 'relation' || f.type === 'image') return ['eq', 'neq', 'empty', 'not_empty'];
  return TEXT_OPS;
}

export function FilterBuilder(props: { value: FilterGroup; onChange: (g: FilterGroup) => void; fields: FieldDef[] }) {
  const { value, onChange, fields } = props;
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const update = (id: string, patch: Partial<Condition>) => onChange({ ...value, conditions: value.conditions.map((c) => (c.id === id ? { ...c, ...patch } : c)) });
  const add = () => onChange({ ...value, conditions: [...value.conditions, { id: uid(), field: fields[0]?.key ?? 'title', op: 'contains', value: '' }] });
  return (
    <div className="col" style={{ gap: 6 }}>
      {value.conditions.length === 0 && <div className="muted small">No conditions — every record matches.</div>}
      {value.conditions.length > 1 && (
        <div className="row small">
          Match
          <div className="seg" role="group" aria-label="Combine conditions">
            <button className={value.join === 'and' ? 'on' : ''} onClick={() => onChange({ ...value, join: 'and' })}>ALL (AND)</button>
            <button className={value.join === 'or' ? 'on' : ''} onClick={() => onChange({ ...value, join: 'or' })}>ANY (OR)</button>
          </div>
          of the conditions
        </div>
      )}
      {value.conditions.map((c) => {
        const f = byKey.get(c.field);
        const ops = opsFor(f);
        const needsValue = !NO_VALUE_OPS.includes(c.op);
        return (
          <div className="row" key={c.id}>
            <select aria-label="Field" value={c.field} onChange={(e) => { const nf = byKey.get(e.target.value); const o = opsFor(nf); update(c.id, { field: e.target.value, op: o.includes(c.op) ? c.op : o[0], value: '' }); }} style={{ width: 130 }}>
              {fields.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
            </select>
            <select aria-label="Operator" value={c.op} onChange={(e) => update(c.id, { op: e.target.value as Operator })} style={{ width: 130 }}>
              {ops.map((o) => <option key={o} value={o}>{f?.type === 'date' && o === 'gte' ? 'on or after' : f?.type === 'date' && o === 'lte' ? 'on or before' : OPERATOR_LABEL[o]}</option>)}
            </select>
            {needsValue && (
              f?.key === 'status' || f?.type === 'select' ? (
                <select aria-label="Value" value={c.value} onChange={(e) => update(c.id, { value: e.target.value })} className="grow">
                  <option value="">—</option>
                  {(f.key === 'status' ? STATUSES : f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              ) : f?.type === 'boolean' ? (
                <select aria-label="Value" value={c.value} onChange={(e) => update(c.id, { value: e.target.value })} className="grow"><option value="true">true</option><option value="false">false</option></select>
              ) : (
                <input aria-label="Value" className="grow" type={f?.type === 'date' ? 'date' : f?.type === 'number' ? 'number' : 'text'} value={c.value} onChange={(e) => update(c.id, { value: e.target.value })} />
              )
            )}
            {!needsValue && <span className="grow" />}
            <IconBtn icon={<Trash2 size={15} />} label="Remove condition" onClick={() => onChange({ ...value, conditions: value.conditions.filter((x) => x.id !== c.id) })} />
          </div>
        );
      })}
      <div><button className="btn sm" onClick={add}><Plus size={14} /> Add condition</button></div>
    </div>
  );
}
