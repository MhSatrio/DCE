import { useEffect, useState, type ReactNode } from 'react';

export function Num(props: {
  label: string; value: number | undefined; onChange: (v: number) => void; min?: number; max?: number; step?: number; suffix?: string; width?: number | string; disabled?: boolean;
}) {
  const fmt = (v: number | undefined) => (v === undefined || Number.isNaN(v) ? '' : String(Math.round(v * 100) / 100));
  const [t, setT] = useState(fmt(props.value));
  const [focus, setFocus] = useState(false);
  useEffect(() => { if (!focus) setT(fmt(props.value)); }, [props.value, focus]);
  const push = (s: string) => {
    setT(s);
    if (s.trim() === '' || s === '-') return;
    let n = Number(s);
    if (!Number.isFinite(n)) return;
    if (props.min !== undefined) n = Math.max(props.min, n);
    if (props.max !== undefined) n = Math.min(props.max, n);
    props.onChange(n);
  };
  return (
    <label className="fld" style={{ width: props.width }}>
      <span>{props.label}</span>
      <div className="row" style={{ gap: 4 }}>
        <input type="number" value={t} step={props.step ?? 1} min={props.min} max={props.max} disabled={props.disabled} aria-label={props.label} style={{ width: '100%' }}
          onChange={(e) => push(e.target.value)} onFocus={() => setFocus(true)} onBlur={() => { setFocus(false); setT(fmt(props.value)); }} />
        {props.suffix && <span className="muted small">{props.suffix}</span>}
      </div>
    </label>
  );
}

const HEX = /^#[0-9a-f]{6}$/i;

export function ColorField(props: { label: string; value: string | undefined; onChange: (v: string) => void; allowNone?: boolean; palette?: string[] }) {
  const v = props.value ?? '';
  const none = v === '' || v === 'none' || v === 'transparent';
  return (
    <div className="fld">
      <span>{props.label}</span>
      <div className="row" style={{ gap: 4 }}>
        <input type="color" aria-label={`${props.label} picker`} value={HEX.test(v) ? v : '#000000'} onChange={(e) => props.onChange(e.target.value.toUpperCase())} />
        <input type="text" aria-label={props.label} value={none ? '' : v} placeholder={none ? 'none' : ''} onChange={(e) => props.onChange(e.target.value)} style={{ width: 0, flex: 1 }} />
        {props.allowNone && <button className={`btn sm ${none ? 'primary' : ''}`} onClick={() => props.onChange('none')} aria-label={`${props.label}: none`}>None</button>}
      </div>
      {props.palette && props.palette.length > 0 && (
        <div className="swatches">{props.palette.map((c) => <button key={c} style={{ background: c }} aria-label={`Use ${c}`} title={c} onClick={() => props.onChange(c)} />)}</div>
      )}
    </div>
  );
}

export function Seg<T extends string | number>(props: { label?: string; value: T; options: { value: T; label: ReactNode; title?: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="fld">
      {props.label && <span>{props.label}</span>}
      <div className="seg" role="group" aria-label={props.label}>
        {props.options.map((o) => <button key={String(o.value)} className={props.value === o.value ? 'on' : ''} title={o.title} aria-label={o.title} aria-pressed={props.value === o.value} onClick={() => props.onChange(o.value)}>{o.label}</button>)}
      </div>
    </div>
  );
}

export function Section(props: { title: string; children: ReactNode }) {
  return <div className="sect"><h3>{props.title}</h3>{props.children}</div>;
}
