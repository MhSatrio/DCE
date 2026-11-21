import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { useStore } from '../ui/store';
import type { EditorController } from './controller';

/**
 * Rulers along the top and the left of the design view, in the document's pixels, like a drawing program's. Dragging from a
 * ruler pulls out a guide line; a guide is moved by dragging it and removed by dragging it back onto its ruler. The guides are
 * a view aid: they are not saved in the template.
 */

const THICK = 20;                                       // the ruler's thickness on screen
const STEPS = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000];

/** The step between labelled marks: the smallest step that is at least 64 screen pixels apart. */
export function majorStep(zoom: number): number {
  return STEPS.find((s) => s * zoom >= 64) ?? STEPS[STEPS.length - 1];
}

/** The marks (scene values) between `from` and `to`, at `step`. Capped so a very far view stays cheap. */
export function marksBetween(from: number, to: number, step: number): number[] {
  const out: number[] = [];
  for (let v = Math.floor(from / step) * step; v <= to && out.length < 600; v += step) out.push(v);
  return out;
}

export function RulerOverlay({ ctrl }: { ctrl: EditorController }) {
  // one selector per value: a selector that builds a new object on every read would re-render without end
  const zoom = useStore(ctrl.store, (s) => s.zoom);
  const panX = useStore(ctrl.store, (s) => s.panX);
  const panY = useStore(ctrl.store, (s) => s.panY);
  const pointer = useStore(ctrl.store, (s) => s.pointer);
  const width = useStore(ctrl.store, (s) => s.doc.canvas.width);
  const height = useStore(ctrl.store, (s) => s.doc.canvas.height);
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const guides = useStore(ctrl.store, (s) => s.rulerGuides); // kept in the controller: moved elements snap to them
  const drag = useRef<{ id: number; axis: 'x' | 'y' } | null>(null);

  useEffect(() => {
    const el = ref.current?.parentElement;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setBox({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const step = majorStep(zoom);
  const minor = step / 5;
  // the scene range on each ruler
  const xFrom = (0 - panX) / zoom, xTo = (box.w - THICK - panX) / zoom;
  const yFrom = (0 - panY) / zoom, yTo = (box.h - THICK - panY) / zoom;
  const xMarks = marksBetween(xFrom, xTo, step);
  const yMarks = marksBetween(yFrom, yTo, step);
  const xMinor = minor * zoom >= 6 ? marksBetween(xFrom, xTo, minor) : [];
  const yMinor = minor * zoom >= 6 ? marksBetween(yFrom, yTo, minor) : [];

  /** Where a pointer is, in scene coordinates along the axis. */
  const sceneOf = (e: { clientX: number; clientY: number }, axis: 'x' | 'y'): number => {
    const r = ref.current?.parentElement?.getBoundingClientRect();
    if (!r) return 0;
    return axis === 'x' ? ((e.clientX - r.left) - panX) / zoom : ((e.clientY - r.top) - panY) / zoom;
  };
  /** Where a pointer is on screen, relative to the stage (to tell that a guide was dragged back onto its ruler). */
  const screenOf = (e: { clientX: number; clientY: number }, axis: 'x' | 'y'): number => {
    const r = ref.current?.parentElement?.getBoundingClientRect();
    if (!r) return 0;
    return axis === 'x' ? e.clientX - r.left : e.clientY - r.top;
  };

  const startGuide = (e: RPointerEvent, axis: 'x' | 'y', existing?: number) => {
    e.preventDefault();
    const id = existing ?? ctrl.addRulerGuide(axis, Math.round(sceneOf(e, axis)));
    drag.current = { id, axis };
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
  };
  const moveGuide = (e: RPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    ctrl.moveRulerGuide(d.id, Math.round(sceneOf(e, d.axis)));
  };
  const endGuide = (e: RPointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    // dragged back onto its ruler (inside the thick edge): the guide is removed
    if (screenOf(e, d.axis) < THICK) ctrl.removeRulerGuide(d.id);
  };

  const topStrip = (
    <svg aria-label="Horizontal ruler" role="img" style={{ position: 'absolute', left: THICK, top: 0, width: Math.max(0, box.w - THICK), height: THICK, pointerEvents: 'auto', cursor: 'ns-resize', background: 'var(--white)', borderBottom: '1px solid var(--line-strong)' }}
      onPointerDown={(e) => startGuide(e, 'y')} onPointerMove={moveGuide} onPointerUp={endGuide}>
      <rect x={Math.max(0, 0 * zoom + panX - THICK)} y={0} width={Math.max(0, width * zoom)} height={THICK} fill="rgba(69,112,182,0.12)" />
      {xMinor.map((v) => <line key={`xm${v}`} x1={v * zoom + panX - THICK} x2={v * zoom + panX - THICK} y1={THICK - 4} y2={THICK} stroke="var(--muted)" />)}
      {xMarks.map((v) => (
        <g key={`xj${v}`}>
          <line x1={v * zoom + panX - THICK} x2={v * zoom + panX - THICK} y1={THICK - 9} y2={THICK} stroke="#231f20" />
          <text x={v * zoom + panX - THICK + 2} y={9} fontSize={10} fill="var(--muted)">{v}</text>
        </g>
      ))}
      {pointer && <line x1={pointer.x * zoom + panX - THICK} x2={pointer.x * zoom + panX - THICK} y1={0} y2={THICK} stroke="#e0533d" strokeWidth={1.5} />}
    </svg>
  );
  const leftStrip = (
    <svg aria-label="Vertical ruler" role="img" style={{ position: 'absolute', left: 0, top: THICK, width: THICK, height: Math.max(0, box.h - THICK), pointerEvents: 'auto', cursor: 'ew-resize', background: 'var(--white)', borderRight: '1px solid var(--line-strong)' }}
      onPointerDown={(e) => startGuide(e, 'x')} onPointerMove={moveGuide} onPointerUp={endGuide}>
      <rect x={0} y={Math.max(0, panY - THICK)} width={THICK} height={Math.max(0, height * zoom)} fill="rgba(69,112,182,0.12)" />
      {yMinor.map((v) => <line key={`ym${v}`} x1={THICK - 4} x2={THICK} y1={v * zoom + panY - THICK} y2={v * zoom + panY - THICK} stroke="var(--muted)" />)}
      {yMarks.map((v) => (
        <g key={`yj${v}`}>
          <line x1={THICK - 9} x2={THICK} y1={v * zoom + panY - THICK} y2={v * zoom + panY - THICK} stroke="#231f20" />
          <text transform={`translate(9 ${v * zoom + panY - THICK + 2}) rotate(-90)`} fontSize={10} fill="var(--muted)">{v}</text>
        </g>
      ))}
      {pointer && <line x1={0} x2={THICK} y1={pointer.y * zoom + panY - THICK} y2={pointer.y * zoom + panY - THICK} stroke="#e0533d" strokeWidth={1.5} />}
    </svg>
  );

  return (
    <div ref={ref} aria-hidden={false} style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 3 }}>
      <div title="Clear all guides" aria-label="Clear all guides" onClick={() => ctrl.clearRulerGuides()}
        style={{ position: 'absolute', left: 0, top: 0, width: THICK, height: THICK, pointerEvents: 'auto', background: 'var(--white)', borderRight: '1px solid var(--line-strong)', borderBottom: '1px solid var(--line-strong)', font: '9px sans-serif', color: 'var(--muted)', display: 'grid', placeItems: 'center', cursor: 'pointer' }}>px</div>
      {topStrip}
      {leftStrip}
      {guides.map((g) => (
        g.axis === 'y'
          ? <div key={g.id} role="separator" aria-label="Horizontal guide" onPointerDown={(e) => startGuide(e, 'y', g.id)} onPointerMove={moveGuide} onPointerUp={endGuide}
              style={{ position: 'absolute', left: THICK, width: Math.max(0, box.w - THICK), top: g.pos * zoom + panY - 3, height: 7, cursor: 'ns-resize', pointerEvents: 'auto' }}>
              <div style={{ position: 'absolute', left: 0, right: 0, top: 3, height: 1, background: '#00a2e8' }} />
            </div>
          : <div key={g.id} role="separator" aria-label="Vertical guide" onPointerDown={(e) => startGuide(e, 'x', g.id)} onPointerMove={moveGuide} onPointerUp={endGuide}
              style={{ position: 'absolute', top: THICK, height: Math.max(0, box.h - THICK), left: g.pos * zoom + panX - 3, width: 7, cursor: 'ew-resize', pointerEvents: 'auto' }}>
              <div style={{ position: 'absolute', top: 0, bottom: 0, left: 3, width: 1, background: '#00a2e8' }} />
            </div>
      ))}
    </div>
  );
}
