import { useEffect, useRef } from 'react';
import { useStore } from '../ui/store';
import type { EditorController } from './controller';

/** In-place text editing: a textarea laid over the selected text frame (double-click or Enter). */
export function TextOverlay({ ctrl }: { ctrl: EditorController }) {
  const id = useStore(ctrl.store, (s) => s.editingText);
  const zoom = useStore(ctrl.store, (s) => s.zoom);
  const panX = useStore(ctrl.store, (s) => s.panX);
  const panY = useStore(ctrl.store, (s) => s.panY);
  const ref = useRef<HTMLTextAreaElement>(null);
  const node = id ? ctrl.getNode(id) : null;
  useEffect(() => { if (id) { ref.current?.focus(); ref.current?.select(); } }, [id]);
  if (!id || !node) return null;
  const st = node.style;
  const value = node.binding?.text?.template ?? node.text ?? '';
  const pad = (st.padding ?? 0) * zoom;
  return (
    <textarea
      ref={ref} className="text-edit" aria-label="Edit text" defaultValue={value} spellCheck={false}
      style={{
        left: node.x * zoom + panX, top: node.y * zoom + panY, width: node.width * zoom, height: node.height * zoom,
        transform: `rotate(${node.rotation || 0}deg)`, transformOrigin: 'center center',
        font: `${st.fontStyle ?? 'normal'} ${st.fontWeight ?? 400} ${(st.fontSize ?? 32) * zoom}px/${(st.fontSize ?? 32) * (st.lineHeight ?? 1.2) * zoom}px "${st.fontFamily ?? 'Jost'}", Jost, sans-serif`,
        textAlign: st.textAlign ?? 'left', color: st.fill ?? '#231F20', padding: pad, letterSpacing: (st.letterSpacing ?? 0) * zoom,
      }}
      onBlur={(e) => ctrl.endTextEdit(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') ctrl.endTextEdit(null);
        else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) (e.target as HTMLTextAreaElement).blur();
      }}
    />
  );
}
