import { memo, useCallback, useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent as RKeyboardEvent, type MouseEvent as RMouseEvent, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, Maximize2, Plus } from 'lucide-react';

export interface GridCol { key: string; title: string; width: number; align?: 'right'; sortable?: boolean }

export interface CellRange { r1: number; r2: number; c1: number; c2: number }

/** Spreadsheet-style cell interaction (optional: the Batch record picker only needs checkboxes). */
export interface CellApi {
  range: CellRange | null;
  active: { row: number; col: number } | null;
  onDown: (row: number, col: number, e: RMouseEvent) => void;
  onEnter: (row: number, col: number) => void;
  onContext: (row: number, col: number, e: RMouseEvent) => void;
  onExpand: (id: string) => void;
  onKeyDown: (e: RKeyboardEvent) => void;
  onCopy: (e: ClipboardEvent) => void;
  onPaste: (e: ClipboardEvent) => void;
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
  renderCell: (row: R, col: GridCol) => ReactNode;
  onToggleSelect: Props<R>['onToggleSelect'];
  cell?: CellApi;
}

function RowInner<R>(p: RowProps<R>) {
  const cell = p.cell;
  return (
    <div className={`vgrid-row ${p.sel ? 'sel' : ''} ${p.open ? 'active' : ''}`} style={{ top: p.top, height: p.h }} role="row" aria-selected={p.sel}>
      <div className="vcell chk" style={{ width: p.chk, gap: 2 }}>
        <input type="checkbox" aria-label="Select row" checked={p.sel} onChange={() => undefined} onClick={(e) => p.onToggleSelect(p.id, p.index, (e as unknown as MouseEvent).shiftKey)} />
        {cell && (
          <button className="rowopen" aria-label="Open record details" data-tip="Open details" data-tip-pos="right" onClick={() => cell.onExpand(p.id)}><Maximize2 size={12} /></button>
        )}
      </div>
      {p.cols.map((c, ci) => {
        const inSel = ci >= p.c1 && ci <= p.c2 && p.c1 >= 0;
        return (
          <div
            key={c.key} role="gridcell" aria-selected={inSel}
            className={`vcell ${c.align === 'right' ? 'num' : ''} ${inSel ? 'in-sel' : ''} ${ci === p.activeCol ? 'is-active' : ''}`} style={{ width: c.width }}
            onMouseDown={cell ? (e) => { if (e.button === 0 && !(e.target as HTMLElement).closest('input,select,button')) cell.onDown(p.index, ci, e); } : undefined}
            onMouseEnter={cell ? () => cell.onEnter(p.index, ci) : undefined}
            onContextMenu={cell ? (e) => { e.preventDefault(); cell.onContext(p.index, ci, e); } : undefined}
          >
            {p.renderCell(p.row, c)}
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

  const startResize = (e: RMouseEvent, c: GridCol) => {
    e.preventDefault(); e.stopPropagation();
    const x0 = e.clientX, w0 = c.width;
    const move = (ev: MouseEvent) => p.onResize(c.key, Math.max(60, Math.min(800, w0 + ev.clientX - x0)));
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
  };

  return (
    <div
      className="vgrid-scroll" ref={ref} onScroll={onScroll} role="grid" aria-rowcount={total} aria-label="Records" tabIndex={p.cell ? 0 : undefined}
      onKeyDown={p.cell?.onKeyDown} onCopy={p.cell?.onCopy} onPaste={p.cell?.onPaste}
    >
      <div className="vgrid-head" style={{ height: 32, width }} role="row">
        <div className="vhead chk" style={{ width: CHK }}>
          <input type="checkbox" aria-label="Select all rows" checked={allSel} onChange={(e) => p.onToggleAll(e.target.checked)} />
        </div>
        {p.cols.map((c) => (
          <div
            key={c.key} className="vhead" style={{ width: c.width, justifyContent: c.align === 'right' ? 'flex-end' : undefined }} role="columnheader"
            aria-sort={p.sort?.key === c.key ? (p.sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
            onClick={() => c.sortable !== false && p.onSort(c.key)}
            onContextMenu={p.onHeaderContext ? (e) => { e.preventDefault(); p.onHeaderContext!(c.key, e); } : undefined}
          >
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.title}</span>
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
          return (
            <Row<R>
              key={id} row={r} id={id} index={index} top={index * H} h={H} cols={p.cols} sel={p.selected.has(id)} open={p.activeId === id}
              c1={inRange ? rg!.c1 : -1} c2={inRange ? rg!.c2 : -1} activeCol={act && act.row === index ? act.col : -1} chk={CHK}
              renderCell={p.renderCell} onToggleSelect={p.onToggleSelect} cell={p.cell}
            />
          );
        })}
      </div>
    </div>
  );
}
