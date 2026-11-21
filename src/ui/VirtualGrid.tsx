import { memo, useCallback, useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent as RKeyboardEvent, type MouseEvent as RMouseEvent, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, Maximize2, Plus } from 'lucide-react';

/**
 * One column. `frozen`: the column stays in view while the grid scrolls sideways (the Master Field).
 * `badge` and `tip` decorate the header (the lightning mark of a synced field, and its "Linked to" text).
 */
export interface GridCol { key: string; title: string; width: number; align?: 'right'; sortable?: boolean; frozen?: boolean; badge?: ReactNode; tip?: string }

/** Sticky placement of a frozen column: it stays `left` px from the grid's left edge (the checkbox column comes first). */
const frozenStyle = (c: GridCol, left: number) => (c.frozen ? { position: 'sticky' as const, left, zIndex: 2, background: 'inherit' } : {});

export interface CellRange { r1: number; r2: number; c1: number; c2: number }

/** Spreadsheet-style cell interaction (optional: the Batch record picker only needs checkboxes). */
export interface CellApi {
  range: CellRange | null;
  active: { row: number; col: number } | null;
  /** The rows a fill drag would add (the selection extended down), shown while the fill handle is dragged. */
  fillPreview: CellRange | null;
  onDown: (row: number, col: number, e: RMouseEvent) => void;
  onEnter: (row: number, col: number) => void;
  onContext: (row: number, col: number, e: RMouseEvent) => void;
  onExpand: (id: string) => void;
  onKeyDown: (e: RKeyboardEvent) => void;
  onCopy: (e: ClipboardEvent) => void;
  onPaste: (e: ClipboardEvent) => void;
  /** The fill handle was pressed: the selection is the source of the fill. */
  onFillStart: () => void;
  /** The handle is dragged to `row` (the mouse's row; past the last row it is a new row). `series`: Shift or Ctrl held. */
  onFillDrag: (row: number, series: boolean) => void;
  onFillEnd: (row: number, series: boolean) => void;
}

interface Props<R> {
  rows: R[];
  rowId: (r: R) => string;
  cols: GridCol[];
  onResize: (key: string, width: number) => void;
  sort: { key: string; dir: 'asc' | 'desc' } | null;
  onSort: (key: string) => void;
  selected: Set<string>;
  onToggleSelect: (id: string, index: number, shift: boolean) => void;
  onToggleAll: (all: boolean) => void;
  /** Row whose detail panel is open. */
  activeId?: string | null;
  renderCell: (row: R, col: GridCol) => ReactNode;
  rowHeight?: number;
  empty?: ReactNode;
  stats?: { rendered: number };
  cell?: CellApi;
  onAddField?: () => void;
  onHeaderContext?: (key: string, e: RMouseEvent) => void;
}

const CHK_BASE = 38;

interface RowProps<R> {
  row: R; id: string; index: number; top: number; h: number; cols: GridCol[]; sel: boolean; open: boolean;
  c1: number; c2: number; activeCol: number; chk: number;
  /** The column of the fill handle (-1 when this row has none), and the columns this row is in the fill preview. */
  handleCol: number; f1: number; f2: number; onFill: () => void;
  renderCell: (row: R, col: GridCol) => ReactNode;
  onToggleSelect: Props<R>['onToggleSelect'];
  cell?: CellApi;
}

function RowInner<R>(p: RowProps<R>) {
  const cell = p.cell;
  return (
    <div className={`vgrid-row ${p.sel ? 'sel' : ''} ${p.open ? 'active' : ''}`} style={{ top: p.top, height: p.h }} role="row" aria-selected={p.sel}>
      <div className="vcell chk" style={{ width: p.chk, gap: 2, position: 'sticky', left: 0, zIndex: 3, background: 'inherit' }}>
        <input type="checkbox" aria-label="Select row" checked={p.sel} onChange={() => undefined} onClick={(e) => p.onToggleSelect(p.id, p.index, (e as unknown as MouseEvent).shiftKey)} />
        {cell && (
          <button className="rowopen" aria-label="Open record details" data-tip="Open details" data-tip-pos="right" onClick={() => cell.onExpand(p.id)}><Maximize2 size={12} /></button>
        )}
      </div>
      {p.cols.map((c, ci) => {
        const inSel = ci >= p.c1 && ci <= p.c2 && p.c1 >= 0;
        const inFill = ci >= p.f1 && ci <= p.f2 && p.f1 >= 0;
        return (
          <div
            key={c.key} role="gridcell" aria-selected={inSel}
            className={`vcell ${c.align === 'right' ? 'num' : ''} ${inSel ? 'in-sel' : ''} ${inFill ? 'in-fill' : ''} ${ci === p.activeCol ? 'is-active' : ''}`} style={{ width: c.width, ...frozenStyle(c, p.chk) }}
            onMouseDown={cell ? (e) => { if (e.button === 0 && !(e.target as HTMLElement).closest('input,select,button')) cell.onDown(p.index, ci, e); } : undefined}
            onMouseEnter={cell ? () => cell.onEnter(p.index, ci) : undefined}
            onContextMenu={cell ? (e) => { e.preventDefault(); cell.onContext(p.index, ci, e); } : undefined}
          >
            {p.renderCell(p.row, c)}
            {cell && ci === p.handleCol && (
              <span className="fill-handle" aria-label="Fill handle" title="Drag down to fill. Hold Shift or Ctrl to count numbers up."
                onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); p.onFill(); }} />
            )}
          </div>
        );
      })}
    </div>
  );
}
const Row = memo(RowInner) as typeof RowInner;

export function VirtualGrid<R>(p: Props<R>) {
  const H = p.rowHeight ?? 34;
  const CHK = p.cell ? 62 : CHK_BASE;
  const ref = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(0);
  const [vh, setVh] = useState(600);
  const raf = useRef(0);

  useEffect(() => {
    const el = ref.current; if (!el) return;
    const ro = new ResizeObserver(() => setVh(el.clientHeight));
    ro.observe(el); setVh(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  const onScroll = useCallback(() => {
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => setTop(ref.current?.scrollTop ?? 0));
  }, []);

  // keep the active cell visible when navigating with the keyboard
  const activeRow = p.cell?.active?.row;
  useEffect(() => {
    const el = ref.current;
    if (activeRow === undefined || !el) return;
    const y = activeRow * H, headH = 32;
    if (y < el.scrollTop) el.scrollTop = y;
    else if (y + H > el.scrollTop + el.clientHeight - headH) el.scrollTop = y + H - el.clientHeight + headH;
  }, [activeRow, H]);

  const total = p.rows.length;
  const start = Math.max(0, Math.floor(top / H) - 6);
  const end = Math.min(total, Math.ceil((top + vh) / H) + 6);
  const ADD = p.onAddField ? 48 : 0;
  const width = CHK + ADD + p.cols.reduce((a, c) => a + c.width, 0);
  const allSel = total > 0 && p.selected.size >= total && p.rows.every((r) => p.selected.has(p.rowId(r)));
  if (p.stats) p.stats.rendered = end - start;
  const rg = p.cell?.range ?? null;
  const act = p.cell?.active ?? null;
  const fp = p.cell?.fillPreview ?? null;
  const pRef = useRef(p);       // the drag handlers read the latest props (they outlive the render they started in)
  pRef.current = p;

  const startResize = (e: RMouseEvent, c: GridCol) => {
    e.preventDefault(); e.stopPropagation();
    const x0 = e.clientX, w0 = c.width;
    const move = (ev: MouseEvent) => p.onResize(c.key, Math.max(60, Math.min(800, w0 + ev.clientX - x0)));
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
  };

  // fill handle: dragging down from the selection's corner. The row is read from the mouse, so dragging below the last
  // row goes on to new rows; near the bottom edge the grid scrolls on. Shift or Ctrl (held at any moment) counts numbers up.
  const rowAt = (y: number): number => {
    const el = ref.current;
    if (!el) return 0;
    return Math.max(0, Math.floor((y - el.getBoundingClientRect().top - 32 + el.scrollTop) / H));
  };
  const startFill = useCallback(() => {
    const cell = pRef.current.cell;
    if (!cell) return;
    cell.onFillStart();
    const move = (ev: MouseEvent) => {
      const el = ref.current;
      if (el && ev.clientY > el.getBoundingClientRect().bottom - 8) el.scrollTop += 16;
      pRef.current.cell?.onFillDrag(rowAt(ev.clientY), ev.shiftKey || ev.ctrlKey);
    };
    const up = (ev: MouseEvent) => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      pRef.current.cell?.onFillEnd(rowAt(ev.clientY), ev.shiftKey || ev.ctrlKey);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }, [H]);

  return (
    <div
      className="vgrid-scroll" ref={ref} onScroll={onScroll} role="grid" aria-rowcount={total} aria-label="Records" tabIndex={p.cell ? 0 : undefined}
      onKeyDown={p.cell?.onKeyDown} onCopy={p.cell?.onCopy} onPaste={p.cell?.onPaste}
    >
      <div className="vgrid-head" style={{ height: 32, width }} role="row">
        <div className="vhead chk" style={{ width: CHK, position: 'sticky', left: 0, zIndex: 3, background: 'inherit' }}>
          <input type="checkbox" aria-label="Select all rows" checked={allSel} onChange={(e) => p.onToggleAll(e.target.checked)} />
        </div>
        {p.cols.map((c) => (
          <div
            key={c.key} className="vhead" title={c.tip} style={{ width: c.width, justifyContent: c.align === 'right' ? 'flex-end' : undefined, ...frozenStyle(c, CHK) }} role="columnheader"
            aria-sort={p.sort?.key === c.key ? (p.sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
            onClick={() => c.sortable !== false && p.onSort(c.key)}
            onContextMenu={p.onHeaderContext ? (e) => { e.preventDefault(); p.onHeaderContext!(c.key, e); } : undefined}
          >
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.title}</span>
            {c.badge}
            {p.sort?.key === c.key && (p.sort.dir === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
            <span className="rz" onMouseDown={(e) => startResize(e, c)} onClick={(e) => e.stopPropagation()} role="separator" aria-label={`Resize ${c.title}`} />
          </div>
        ))}
        {p.onAddField && (
          <div className="vhead add" style={{ width: ADD, justifyContent: 'center', padding: 0 }}>
            <button className="addfield" aria-label="Add field" data-tip="Add a field" onClick={p.onAddField}><Plus size={15} /></button>
          </div>
        )}
      </div>
      <div style={{ position: 'relative', height: total * H, width }}>
        {total === 0 && p.empty}
        {p.rows.slice(start, end).map((r, i) => {
          const id = p.rowId(r);
          const index = start + i;
          const inRange = rg && index >= rg.r1 && index <= rg.r2;
          const inFillRows = !!rg && !!fp && index > rg.r2 && index <= fp.r2;
          return (
            <Row<R>
              key={id} row={r} id={id} index={index} top={index * H} h={H} cols={p.cols} sel={p.selected.has(id)} open={p.activeId === id}
              c1={inRange ? rg!.c1 : -1} c2={inRange ? rg!.c2 : -1} activeCol={act && act.row === index ? act.col : -1} chk={CHK}
              handleCol={rg && index === rg.r2 ? rg.c2 : -1} f1={inFillRows ? rg!.c1 : -1} f2={inFillRows ? rg!.c2 : -1} onFill={startFill}
              renderCell={p.renderCell} onToggleSelect={p.onToggleSelect} cell={p.cell}
            />
          );
        })}
      </div>
    </div>
  );
}
