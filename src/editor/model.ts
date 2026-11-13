import { uid } from '../engine/njs';
import type { DceNode, NjsDoc } from '../engine/types';

/** Pure document operations. The editor never mutates a document it did not clone first. */

export interface Located { node: DceNode; list: DceNode[]; index: number; parent: DceNode | null }

export function locate(nodes: DceNode[], id: string, parent: DceNode | null = null): Located | null {
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.id === id) return { node: n, list: nodes, index: i, parent };
    if (n.children) { const r = locate(n.children, id, n); if (r) return r; }
  }
  return null;
}

export function leaves(nodes: DceNode[]): DceNode[] {
  const out: DceNode[] = [];
  const walk = (list: DceNode[]) => list.forEach((n) => (n.type === 'group' ? walk(n.children ?? []) : out.push(n)));
  walk(nodes);
  return out;
}

export function leafIdsOf(node: DceNode): string[] {
  return node.type === 'group' ? (node.children ?? []).flatMap(leafIdsOf) : [node.id];
}

/** The outermost group a node belongs to (or null). */
export function topGroupOf(doc: NjsDoc, id: string): DceNode | null {
  for (const n of doc.nodes) if (n.type === 'group' && leafIdsOf(n).includes(id)) return n;
  return null;
}

export function ancestors(doc: NjsDoc, id: string): DceNode[] {
  const out: DceNode[] = [];
  const walk = (list: DceNode[], path: DceNode[]): boolean => {
    for (const n of list) {
      if (n.id === id) { out.push(...path); return true; }
      if (n.children && walk(n.children, [...path, n])) return true;
    }
    return false;
  };
  walk(doc.nodes, []);
  return out;
}

export interface Box { x: number; y: number; w: number; h: number }

export function rotatedBox(n: Pick<DceNode, 'x' | 'y' | 'width' | 'height' | 'rotation'>): Box {
  const cx = n.x + n.width / 2, cy = n.y + n.height / 2;
  const a = ((n.rotation || 0) * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  const xs: number[] = [], ys: number[] = [];
  for (const [dx, dy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    const px = (dx * n.width) / 2, py = (dy * n.height) / 2;
    xs.push(cx + px * c - py * s); ys.push(cy + px * s + py * c);
  }
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

export function boundsOf(nodes: DceNode[]): Box {
  const ls = nodes.flatMap((n) => (n.type === 'group' ? leaves([n]) : [n]));
  if (!ls.length) return { x: 0, y: 0, w: 0, h: 0 };
  const boxes = ls.map(rotatedBox);
  const x = Math.min(...boxes.map((b) => b.x)), y = Math.min(...boxes.map((b) => b.y));
  return { x, y, w: Math.max(...boxes.map((b) => b.x + b.w)) - x, h: Math.max(...boxes.map((b) => b.y + b.h)) - y };
}

export function translate(n: DceNode, dx: number, dy: number): void {
  n.x += dx; n.y += dy;
  n.children?.forEach((c) => translate(c, dx, dy));
}

export function renumber(nodes: DceNode[]): void {
  nodes.forEach((n, i) => { n.layer = i; if (n.children) renumber(n.children); });
}

/** Refreshes the cached bounding box stored on group nodes. */
export function refreshGroups(nodes: DceNode[]): void {
  for (const n of nodes) {
    if (n.type === 'group' && n.children) {
      refreshGroups(n.children);
      const b = boundsOf(n.children);
      n.x = b.x; n.y = b.y; n.width = b.w; n.height = b.h; n.rotation = 0;
    }
  }
}

export function removeNodes(doc: NjsDoc, ids: string[]): DceNode[] {
  const removed: DceNode[] = [];
  for (const id of ids) {
    const loc = locate(doc.nodes, id);
    if (loc) { loc.list.splice(loc.index, 1); removed.push(loc.node); }
  }
  // drop groups that became empty
  const prune = (list: DceNode[]) => {
    for (let i = list.length - 1; i >= 0; i--) {
      const n = list[i];
      if (n.type === 'group') { prune(n.children ?? []); if (!n.children?.length) list.splice(i, 1); }
    }
  };
  prune(doc.nodes);
  refreshGroups(doc.nodes); renumber(doc.nodes);
  return removed;
}

export function cloneWithNewIds(n: DceNode): DceNode {
  const c = structuredClone(n);
  const walk = (x: DceNode) => { x.id = uid(); x.children?.forEach(walk); };
  walk(c);
  return c;
}

/** Selected ids → the set of top-most selected nodes (a selected group swallows its children). */
export function topLevelSelection(doc: NjsDoc, leafIds: string[]): DceNode[] {
  const set = new Set(leafIds);
  const out: DceNode[] = [];
  const walk = (list: DceNode[]) => {
    for (const n of list) {
      const ls = leafIdsOf(n);
      if (ls.length && ls.every((id) => set.has(id))) out.push(n);
      else if (n.children) walk(n.children);
    }
  };
  walk(doc.nodes);
  return out;
}

export function duplicateNodes(doc: NjsDoc, leafIds: string[], offset = 24): string[] {
  const sel = topLevelSelection(doc, leafIds);
  const newLeafIds: string[] = [];
  for (const n of sel) {
    const loc = locate(doc.nodes, n.id)!;
    const copy = cloneWithNewIds(n);
    translate(copy, offset, offset);
    copy.name = n.name.replace(/ copy( \d+)?$/, '') + ' copy';
    loc.list.splice(loc.index + 1, 0, copy);
    newLeafIds.push(...leafIdsOf(copy));
  }
  refreshGroups(doc.nodes); renumber(doc.nodes);
  return newLeafIds;
}

export function groupSelection(doc: NjsDoc, leafIds: string[]): string | null {
  const sel = topLevelSelection(doc, leafIds);
  if (sel.length < 2) return null;
  // all must share the same parent list to keep z-order meaningful; otherwise group at top level
  const first = locate(doc.nodes, sel[0].id)!;
  const sameParent = sel.every((n) => locate(doc.nodes, n.id)!.list === first.list);
  const target = sameParent ? first.list : doc.nodes;
  const indices = sel.map((n) => target.findIndex((x) => x.id === n.id)).filter((i) => i >= 0);
  const insertAt = indices.length ? Math.max(...indices) - (indices.length - 1) : target.length;
  const ordered = [...sel].sort((a, b) => leafOrder(doc, a.id) - leafOrder(doc, b.id));
  for (const n of sel) { const l = locate(doc.nodes, n.id)!; l.list.splice(l.index, 1); }
  const b = boundsOf(ordered);
  const group: DceNode = {
    id: uid(), type: 'group', name: uniqueName(doc, 'Group'), x: b.x, y: b.y, width: b.w, height: b.h, rotation: 0, visible: true, locked: false,
    opacity: 1, layer: 0, style: {}, children: ordered,
  };
  target.splice(Math.max(0, Math.min(insertAt, target.length)), 0, group);
  refreshGroups(doc.nodes); renumber(doc.nodes);
  return group.id;
}

function leafOrder(doc: NjsDoc, id: string): number {
  const ls = leaves(doc.nodes).map((l) => l.id);
  const first = locate(doc.nodes, id);
  return first ? Math.min(...leafIdsOf(first.node).map((x) => ls.indexOf(x))) : 0;
}

export function ungroup(doc: NjsDoc, groupId: string): string[] {
  const loc = locate(doc.nodes, groupId);
  if (!loc || loc.node.type !== 'group') return [];
  const kids = loc.node.children ?? [];
  loc.list.splice(loc.index, 1, ...kids);
  renumber(doc.nodes);
  return kids.flatMap(leafIdsOf);
}

export type ReorderMode = 'front' | 'back' | 'forward' | 'backward';
export function reorder(doc: NjsDoc, leafIds: string[], mode: ReorderMode): void {
  const sel = topLevelSelection(doc, leafIds);
  const byList = new Map<DceNode[], DceNode[]>();
  for (const n of sel) { const l = locate(doc.nodes, n.id)!; byList.set(l.list, [...(byList.get(l.list) ?? []), n]); }
  for (const [list, items] of byList) {
    const ids = new Set(items.map((i) => i.id));
    const kept = list.filter((n) => !ids.has(n.id));
    const moving = list.filter((n) => ids.has(n.id));
    if (mode === 'front') list.splice(0, list.length, ...kept, ...moving);
    else if (mode === 'back') list.splice(0, list.length, ...moving, ...kept);
    else {
      const arr = [...list];
      if (mode === 'forward') { for (let i = arr.length - 2; i >= 0; i--) if (ids.has(arr[i].id) && !ids.has(arr[i + 1].id)) [arr[i], arr[i + 1]] = [arr[i + 1], arr[i]]; }
      else { for (let i = 1; i < arr.length; i++) if (ids.has(arr[i].id) && !ids.has(arr[i - 1].id)) [arr[i], arr[i - 1]] = [arr[i - 1], arr[i]]; }
      list.splice(0, list.length, ...arr);
    }
  }
  renumber(doc.nodes);
}

/** Layer-panel drag & drop. `where: 'above'` = higher z-order than target. */
export function moveRelative(doc: NjsDoc, dragId: string, targetId: string, where: 'above' | 'below'): boolean {
  if (dragId === targetId) return false;
  const drag = locate(doc.nodes, dragId);
  const target = locate(doc.nodes, targetId);
  if (!drag || !target) return false;
  if (leafIdsOf(drag.node).includes(targetId) || (drag.node.type === 'group' && locate(drag.node.children ?? [], targetId))) return false; // cannot drop into itself
  drag.list.splice(drag.index, 1);
  const t = locate(doc.nodes, targetId)!;
  t.list.splice(where === 'above' ? t.index + 1 : t.index, 0, drag.node);
  const prune = (list: DceNode[]) => { for (let i = list.length - 1; i >= 0; i--) { const n = list[i]; if (n.type === 'group') { prune(n.children ?? []); if (!n.children?.length) list.splice(i, 1); } } };
  prune(doc.nodes);
  refreshGroups(doc.nodes); renumber(doc.nodes);
  return true;
}

export type AlignMode = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom';
export function alignNodes(doc: NjsDoc, leafIds: string[], mode: AlignMode, to: 'selection' | 'canvas'): void {
  const sel = topLevelSelection(doc, leafIds);
  if (!sel.length) return;
  const ref: Box = to === 'canvas' || sel.length === 1 ? { x: 0, y: 0, w: doc.canvas.width, h: doc.canvas.height } : boundsOf(sel);
  for (const n of sel) {
    const b = boundsOf([n]);
    let dx = 0, dy = 0;
    if (mode === 'left') dx = ref.x - b.x;
    if (mode === 'center') dx = ref.x + ref.w / 2 - (b.x + b.w / 2);
    if (mode === 'right') dx = ref.x + ref.w - (b.x + b.w);
    if (mode === 'top') dy = ref.y - b.y;
    if (mode === 'middle') dy = ref.y + ref.h / 2 - (b.y + b.h / 2);
    if (mode === 'bottom') dy = ref.y + ref.h - (b.y + b.h);
    translate(n, dx, dy);
  }
  refreshGroups(doc.nodes);
}

export function distributeNodes(doc: NjsDoc, leafIds: string[], axis: 'h' | 'v'): void {
  const sel = topLevelSelection(doc, leafIds);
  if (sel.length < 3) return;
  const items = sel.map((n) => ({ n, b: boundsOf([n]) })).sort((a, b) => (axis === 'h' ? a.b.x - b.b.x : a.b.y - b.b.y));
  const first = items[0].b, last = items[items.length - 1].b;
  const total = items.reduce((s, i) => s + (axis === 'h' ? i.b.w : i.b.h), 0);
  const span = axis === 'h' ? last.x + last.w - first.x : last.y + last.h - first.y;
  const gap = (span - total) / (items.length - 1);
  let cur = axis === 'h' ? first.x : first.y;
  for (const it of items) {
    const d = cur - (axis === 'h' ? it.b.x : it.b.y);
    if (axis === 'h') translate(it.n, d, 0); else translate(it.n, 0, d);
    cur += (axis === 'h' ? it.b.w : it.b.h) + gap;
  }
  refreshGroups(doc.nodes);
}

export function uniqueName(doc: NjsDoc, base: string): string {
  const names = new Set<string>();
  const walk = (l: DceNode[]) => l.forEach((n) => { names.add(n.name); if (n.children) walk(n.children); });
  walk(doc.nodes);
  if (!names.has(base)) return base;
  for (let i = 2; ; i++) if (!names.has(`${base} ${i}`)) return `${base} ${i}`;
}
