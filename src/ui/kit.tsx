import { useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { confirmStore, dismissToast, toasts, useStore } from './store';

// ---------- routing (hash based, no dependency) ----------
function subscribeHash(fn: () => void) { window.addEventListener('hashchange', fn); return () => window.removeEventListener('hashchange', fn); }
export function useHash(): string {
  return useSyncExternalStore(subscribeHash, () => location.hash || '#/', () => '#/');
}
export function go(path: string): void { location.hash = path; }

// ---------- small components ----------
export function IconBtn(props: {
  icon: ReactNode; label: string; onClick?: (e: React.MouseEvent) => void; on?: boolean; disabled?: boolean;
  tipPos?: 'right' | 'left' | 'top' | 'bottom'; className?: string; type?: 'button' | 'submit';
}) {
  return (
    <button
      type={props.type ?? 'button'} className={`ibtn ${props.on ? 'on' : ''} ${props.className ?? ''}`} aria-label={props.label}
      aria-pressed={props.on === undefined ? undefined : props.on} data-tip={props.label} data-tip-pos={props.tipPos === 'bottom' ? undefined : props.tipPos}
      onClick={props.onClick} disabled={props.disabled}
    >{props.icon}</button>
  );
}

const dialogStack: symbol[] = [];

export function Dialog(props: { title: string; onClose: () => void; children: ReactNode; foot?: ReactNode; size?: 'wide' | 'mid' | 'std'; }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const me = Symbol('dialog');
    dialogStack.push(me);
    // only the top-most dialog reacts to Escape (a picker opened from a dialog must not close both)
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && dialogStack[dialogStack.length - 1] === me) { e.stopPropagation(); props.onClose(); } };
    document.addEventListener('keydown', onKey, true);
    ref.current?.querySelector<HTMLElement>('input, select, textarea, button.primary')?.focus();
    return () => { document.removeEventListener('keydown', onKey, true); dialogStack.splice(dialogStack.indexOf(me), 1); prev?.focus?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
      <div className={`dialog ${props.size === 'wide' ? 'wide' : props.size === 'mid' ? 'mid' : ''}`} role="dialog" aria-modal="true" aria-label={props.title} ref={ref}>
        <div className="dialog-head">
          <h2 className="grow">{props.title}</h2>
          <IconBtn icon={<X size={16} />} label="Close" onClick={props.onClose} />
        </div>
        <div className="dialog-body">{props.children}</div>
        {props.foot && <div className="dialog-foot">{props.foot}</div>}
      </div>
    </div>
  );
}

export function ToastHost() {
  const list = useStore(toasts, (s) => s.list);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          {t.kind === 'success' ? <CheckCircle2 size={16} /> : t.kind === 'error' ? <XCircle size={16} /> : t.kind === 'warn' ? <AlertTriangle size={16} /> : <Info size={16} />}
          <span>{t.text}</span>
          <button aria-label="Dismiss" onClick={() => dismissToast(t.id)}><X size={14} /></button>
        </div>
      ))}
    </div>
  );
}

export function ConfirmHost() {
  const req = useStore(confirmStore, (s) => s.req);
  if (!req) return null;
  const done = (ok: boolean) => { confirmStore.set({ req: null }); req.resolve(ok); };
  return (
    <Dialog
      title={req.title} onClose={() => done(false)}
      foot={<>
        <button className="btn" onClick={() => done(false)}>Cancel</button>
        <button className={`btn ${req.danger ? 'danger solid' : 'primary'}`} onClick={() => done(true)} autoFocus>{req.confirmLabel}</button>
      </>}
    >
      <div>{req.body}</div>
    </Dialog>
  );
}

export function Empty(props: { title: string; children?: ReactNode; icon?: ReactNode }) {
  return <div className="empty">{props.icon}<h3>{props.title}</h3><div>{props.children}</div></div>;
}

export function Tabs<T extends string>(props: { tabs: { id: T; label: string }[]; value: T; onChange: (t: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {props.tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={props.value === t.id} className={props.value === t.id ? 'on' : ''} onClick={() => props.onChange(t.id)}>{t.label}</button>
      ))}
    </div>
  );
}

export function Spinner() { return <span className="spinner" aria-label="Working" />; }

export function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}

export function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function fmtDate(ts: number): string {
  return new Date(ts).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
