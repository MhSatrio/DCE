import { useEffect, useRef, useState, type MouseEvent as RMouseEvent, type ReactNode } from 'react';
import { EXPORT_FORMATS, exportTemplate, type ExportFormat } from '../db/templateImage';
import type { NjsDoc } from '../engine/types';
import { download } from './kit';
import { notify } from './store';

/**
 * A template’s download button: a menu of its design file and the drawing as PNG, JPEG, PDF, SVG or HTML. The menu is
 * fixed to the viewport, so a card that hides its overflow does not clip it.
 */
export function ExportMenu({ doc, recordId, label, className = 'ibtn', children }: {
  doc: NjsDoc; recordId?: string; label: string; className?: string; children: ReactNode;
}) {
  const wrap = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!pos) return;
    const outside = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setPos(null); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setPos(null); };
    document.addEventListener('mousedown', outside);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', outside); document.removeEventListener('keydown', esc); };
  }, [pos]);

  const toggle = (e: RMouseEvent<HTMLButtonElement>) => {
    if (pos) return setPos(null);
    const r = e.currentTarget.getBoundingClientRect();
    const height = EXPORT_FORMATS.length * 34 + 12;
    const below = r.bottom + 6 + height <= window.innerHeight;
    setPos({ x: Math.max(8, Math.min(r.right - 200, window.innerWidth - 216)), y: below ? r.bottom + 6 : Math.max(8, r.top - height - 6) });
  };

  const run = async (format: ExportFormat) => {
    setPos(null);
    setBusy(true);
    try {
      const { blob, name } = await exportTemplate(doc, format, recordId);
      download(blob, name);
      notify('success', `Exported ${name}.`);
    } catch (e) {
      notify('error', `The export failed: ${e instanceof Error ? e.message : String(e)}`, 8000);
    } finally {
      setBusy(false);
    }
  };

  return (
    <span ref={wrap} style={{ display: 'inline-flex' }}>
      <button type="button" className={className} aria-label={label} data-tip={label} aria-haspopup="menu" aria-expanded={pos !== null} disabled={busy} onClick={toggle}>
        {children}
      </button>
      {pos && (
        <div className="ctx" role="menu" aria-label={label} style={{ left: pos.x, top: pos.y, minWidth: 200 }}>
          {EXPORT_FORMATS.map((f) => (
            <button key={f.id} role="menuitem" onClick={() => void run(f.id)}>{f.label}</button>
          ))}
        </div>
      )}
    </span>
  );
}
