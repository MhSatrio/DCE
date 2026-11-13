import { useState } from 'react';
import {
  ArrowDownToLine, ArrowUpToLine, ChevronDown, ChevronRight, Circle, Copy, Eye, EyeOff, FolderClosed, Frame, Group, Image as ImageIcon, Lock, Minus, PenLine, Pentagon,
  Puzzle, Square, Star, Trash2, Type, Ungroup, Unlock,
} from 'lucide-react';
import type { DceNode } from '../engine/types';
import { IconBtn } from '../ui/kit';
import { useStore } from '../ui/store';
import type { EditorController } from './controller';
import { leafIdsOf } from './model';

const ICON: Record<DceNode['type'], typeof Square> = {
  rect: Square, ellipse: Circle, line: Minus, text: Type, image: ImageIcon, polygon: Pentagon, star: Star, frame: Frame, path: PenLine, group: FolderClosed, plugin: Puzzle,
};

interface RowProps { n: DceNode; depth: number; ctrl: EditorController; selected: Set<string>; drag: { id: string | null; over: string | null; where: 'above' | 'below' }; setDrag: (d: RowProps['drag']) => void; collapsed: Set<string>; toggle: (id: string) => void }

function Row(p: RowProps) {
  const { n, ctrl } = p;
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(n.name);
  const Icon = ICON[n.type];
  const ids = leafIdsOf(n);
  const isSel = ids.length > 0 && ids.every((i) => p.selected.has(i));
  const bound = !!n.binding && Object.keys(n.binding).length > 0;
  const isGroup = n.type === 'group';
  const open = !p.collapsed.has(n.id);
  const cls = ['layer', isSel ? 'sel' : '', p.drag.over === n.id ? (p.drag.where === 'above' ? 'drop-before' : 'drop-after') : ''].join(' ');
  return (
    <>
      <div
        className={cls} style={{ paddingLeft: 6 + p.depth * 14 }} draggable={!editing} role="treeitem" aria-selected={isSel} aria-label={`Layer ${n.name}`}
        onDragStart={(e) => { e.dataTransfer.setData('text/plain', n.id); e.dataTransfer.effectAllowed = 'move'; p.setDrag({ id: n.id, over: null, where: 'above' }); }}
        onDragOver={(e) => { if (!p.drag.id || p.drag.id === n.id) return; e.preventDefault(); const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); p.setDrag({ ...p.drag, over: n.id, where: e.clientY < r.top + r.height / 2 ? 'above' : 'below' }); }}
        onDragLeave={() => p.drag.over === n.id && p.setDrag({ ...p.drag, over: null })}
        onDrop={(e) => { e.preventDefault(); if (p.drag.id) ctrl.moveLayer(p.drag.id, n.id, p.drag.where); p.setDrag({ id: null, over: null, where: 'above' }); }}
        onDragEnd={() => p.setDrag({ id: null, over: null, where: 'above' })}
        onClick={(e) => {
          if (e.shiftKey || e.ctrlKey || e.metaKey) { const cur = new Set(p.selected); ids.forEach((i) => (cur.has(i) ? cur.delete(i) : cur.add(i))); ctrl.selectIds([...cur]); }
          else ctrl.selectIds(ids, { noExpand: p.depth > 0 });
        }}
      >
        {isGroup ? <button className="lb on" aria-label={open ? 'Collapse group' : 'Expand group'} onClick={(e) => { e.stopPropagation(); p.toggle(n.id); }}>{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</button> : <span style={{ width: 17 }} />}
        <Icon size={14} color={isSel ? '#365a97' : '#64748b'} />
        <span className="nm" onDoubleClick={() => { setName(n.name); setEditing(true); }} title={n.name}>
          {editing
            ? <input autoFocus value={name} aria-label="Rename layer" onChange={(e) => setName(e.target.value)} onClick={(e) => e.stopPropagation()}
                onBlur={() => { setEditing(false); if (name.trim() && name !== n.name) ctrl.renameNode(n.id, name); }}
                onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') { setName(n.name); setEditing(false); } e.stopPropagation(); }} />
            : n.name}
        </span>
        {bound && <span className="bind-dot" title="Bound to data" aria-label="Bound to data" />}
        <button className={`lb ${n.locked ? 'on' : ''}`} aria-label={n.locked ? `Unlock ${n.name}` : `Lock ${n.name}`} aria-pressed={n.locked} title={n.locked ? 'Unlock' : 'Lock'} onClick={(e) => { e.stopPropagation(); ctrl.setNodeFlag(n.id, 'locked', !n.locked); }}>{n.locked ? <Lock size={13} /> : <Unlock size={13} />}</button>
        <button className={`lb ${n.visible ? '' : 'on'}`} aria-label={n.visible ? `Hide ${n.name}` : `Show ${n.name}`} aria-pressed={!n.visible} title={n.visible ? 'Hide' : 'Show'} onClick={(e) => { e.stopPropagation(); ctrl.setNodeFlag(n.id, 'visible', !n.visible); }}>{n.visible ? <Eye size={13} /> : <EyeOff size={13} />}</button>
      </div>
      {isGroup && open && [...(n.children ?? [])].reverse().map((c) => <Row key={c.id} {...p} n={c} depth={p.depth + 1} />)}
    </>
  );
}

export function Layers({ ctrl }: { ctrl: EditorController }) {
  const doc = useStore(ctrl.store, (s) => s.doc);
  const sel = useStore(ctrl.store, (s) => s.selection);
  const [drag, setDrag] = useState<RowProps['drag']>({ id: null, over: null, where: 'above' });
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const selected = new Set(sel);
  const none = sel.length === 0;
  const canUngroup = ctrl.selectionInGroup();
  return (
    <div className="ed-layers" aria-label="Layers">
      <div className="panel-head" style={{ padding: '6px 8px' }}>
        <h3 className="grow">Layers <span className="muted">({doc.nodes.length})</span></h3>
        <IconBtn icon={<Group size={15} />} label="Group (Ctrl+G)" onClick={() => ctrl.group()} disabled={sel.length < 2} />
        <IconBtn icon={<Ungroup size={15} />} label="Ungroup (Ctrl+Shift+G)" onClick={() => ctrl.ungroup()} disabled={!canUngroup} />
      </div>
      <div className="row" style={{ padding: '2px 8px', gap: 0, borderBottom: '1px solid var(--line)' }}>
        <IconBtn icon={<ArrowUpToLine size={15} />} label="Bring to front" onClick={() => ctrl.reorder('front')} disabled={none} />
        <IconBtn icon={<ChevronRight size={15} style={{ transform: 'rotate(-90deg)' }} />} label="Bring forward" onClick={() => ctrl.reorder('forward')} disabled={none} />
        <IconBtn icon={<ChevronRight size={15} style={{ transform: 'rotate(90deg)' }} />} label="Send backward" onClick={() => ctrl.reorder('backward')} disabled={none} />
        <IconBtn icon={<ArrowDownToLine size={15} />} label="Send to back" onClick={() => ctrl.reorder('back')} disabled={none} />
        <span className="grow" />
        <IconBtn icon={<Copy size={15} />} label="Duplicate (Ctrl+D)" onClick={() => ctrl.duplicate()} disabled={none} />
        <IconBtn icon={<Trash2 size={15} />} label="Delete (Del)" onClick={() => ctrl.deleteSelected()} disabled={none} />
      </div>
      <div style={{ overflow: 'auto', flex: 1 }} role="tree" aria-label="Layer tree">
        {doc.nodes.length === 0 && <div className="muted small" style={{ padding: 12 }}>Empty canvas. Pick a tool on the left and drag on the canvas.</div>}
        {[...doc.nodes].reverse().map((n) => (
          <Row key={n.id} n={n} depth={0} ctrl={ctrl} selected={selected} drag={drag} setDrag={setDrag} collapsed={collapsed}
            toggle={(id) => setCollapsed((c) => { const x = new Set(c); if (x.has(id)) x.delete(id); else x.add(id); return x; })} />
        ))}
      </div>
    </div>
  );
}
