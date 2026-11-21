import { useLiveQuery } from 'dexie-react-hooks';
import { db, type FieldDef } from '../db/schema';

/**
 * The value an automation writes into a field, typed as the field is: a choice for a select, a date for a date, a number
 * for a number, a formula for a formula, a template for a template. A value with a {{field}} placeholder is typed as text,
 * because it is only known when the step runs.
 */
export function FieldValueInput({ field, value, onChange, label = 'Set it to' }: {
  field: FieldDef; value: string; onChange: (v: string) => void; label?: string;
}) {
  const assets = useLiveQuery(() => db.assets.orderBy('name').toArray(), [], []);
  const templates = useLiveQuery(() => db.templates.orderBy('name').toArray(), [], []);
  const hint = (text: string) => <div className="small muted">{text}</div>;
  const text = (placeholder: string) => <input aria-label={label} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />;

  if (value.includes('{{')) return <div className="col" style={{ gap: 4 }}>{text('…')}{hint('The placeholder is filled from the item when the step runs.')}</div>;

  switch (field.type) {
    case 'select': {
      const options = field.options ?? [];
      const unknown = value !== '' && !options.includes(value);
      return (
        <div className="col" style={{ gap: 4 }}>
          <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
            <option value="">— none —</option>
            {options.map((o) => <option key={o} value={o}>{o}</option>)}
            {unknown && <option value={value}>{value} (not a choice)</option>}
          </select>
          {unknown && hint('This is not one of the choices of the field: the step will stop until a choice is picked.')}
        </div>
      );
    }
    case 'multiselect': {
      const chosen = value.split(/[;,|]/).map((x) => x.trim()).filter(Boolean);
      const options = field.options ?? [];
      return (
        <div className="col" style={{ gap: 4 }} role="group" aria-label={label}>
          {options.map((o) => (
            <label key={o} className="chk">
              <input type="checkbox" checked={chosen.includes(o)} onChange={(e) => {
                const next = e.target.checked ? [...chosen, o] : chosen.filter((x) => x !== o);
                onChange(next.join('; '));
              }} /> {o}
            </label>
          ))}
          {options.length === 0 && hint('The field has no choices yet.')}
        </div>
      );
    }
    case 'boolean':
      return (
        <select aria-label={label} value={value === 'true' ? 'true' : value === 'false' ? 'false' : ''} onChange={(e) => onChange(e.target.value)}>
          <option value="">— none —</option>
          <option value="true">Yes</option>
          <option value="false">No</option>
        </select>
      );
    case 'date':
      return <input type="date" aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} />;
    case 'datetime':
      return <input type="datetime-local" aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} />;
    case 'number': case 'currency': case 'percent':
      return <input type="number" aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} />;
    case 'rating': {
      const max = field.ratingMax ?? 5;
      return (
        <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">— none —</option>
          {Array.from({ length: max }, (_, i) => <option key={i + 1} value={String(i + 1)}>{i + 1}</option>)}
        </select>
      );
    }
    case 'formula':
      return (
        <div className="col" style={{ gap: 4 }}>
          <textarea aria-label={label} rows={2} value={value} placeholder="=[Price]*[Qty]" onChange={(e) => onChange(e.target.value)} style={{ fontFamily: 'monospace' }} />
          {hint('A formula, starting with =. It is calculated for each row, like the formula cells of the table.')}
        </div>
      );
    case 'relation':
      return (
        <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">— none —</option>
          {(templates ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      );
    case 'image':
      return (
        <div className="col" style={{ gap: 4 }}>
          <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
            <option value="">— none —</option>
            {(assets ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          {hint('An image from the Assets library.')}
        </div>
      );
    case 'longtext': case 'markdown': case 'json':
      return <textarea aria-label={label} rows={3} value={value} placeholder="Text, or {{field}} from the item" onChange={(e) => onChange(e.target.value)} />;
    default:
      return text('Text, or {{field}} from the item');
  }
}
