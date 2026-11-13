import { ActiveSelection, Canvas, FabricObject, util, type TPointerEventInfo } from 'fabric';
import { mainProvider } from '../db/provider';
import { recordsStore, renderDataFor } from '../db/repo';
import { makeNode, syncPlaceholders, uid } from '../engine/njs';
import { buildScene, type ImageLike, type SceneEnv } from '../engine/scene';
import type { DceNode, Issue, NjsDoc, RenderData } from '../engine/types';
import { createStore } from '../ui/store';
import { DceObject, type DceHost } from './DceObject';
import * as M from './model';
import * as PH from './path';

export type ToolId = 'select' | 'rect' | 'ellipse' | 'line' | 'text' | 'image' | 'polygon' | 'star' | 'frame' | 'pen';

export interface EdState {
  doc: NjsDoc;
  selection: string[];            // leaf ids
  tool: ToolId;
  zoom: number;
  panX: number;
  panY: number;
  canUndo: boolean;
  canRedo: boolean;
  dirty: boolean;
  previewOn: boolean;
  previewRecordId: string;
  grid: boolean;
  snap: boolean;
  editingText: string | null;
  imageTarget: string | null;     // node id waiting for an asset (null = none)
  pickNewImage: boolean;
  issues: Issue[];
  pointer: { x: number; y: number } | null;
  penPoints: number;
  editingPath: string | null;     // node id while editing a path's anchors / handles
  pathSel: number | null;         // selected anchor index in path-edit mode
  rev: number;                    // bumps on every document change (for memo keys)
}

const clipboard: { nodes: DceNode[] } = { nodes: [] };
const HISTORY_MAX = 120;

export class EditorController implements DceHost {
  readonly store;
  canvas!: Canvas;
  private host!: HTMLElement;
  private objects = new Map<string, DceObject>();
  readonly env: SceneEnv = { images: new Map<string, ImageLike | null>() };
  private loading = new Set<string>();
  private past: NjsDoc[] = [];
  private future: NjsDoc[] = [];
  private lastKey = ''; private lastTime = 0;
  private guides: { x: number[]; y: number[] } = { x: [], y: [] };
  private applying = false;
  private expanding = false;
  private noExpand = false;
  private spaceDown = false;
  private panning: { x: number; y: number } | null = null;
  private drawing: { x: number; y: number; obj: DceObject; type: DceNode['type'] } | null = null;
  private penPts: { x: number; y: number; hin?: [number, number]; hout?: [number, number] }[] = [];
  private penMouse: [number, number] | null = null;
  private penDrag: number | null = null;
  private pathDrag: { kind: 'a' | 'in' | 'out'; idx: number } | null = null;
  private resizeObs?: ResizeObserver;
  private issueTimer = 0;
  private disposed = false;
  private fitted = false;
  private pasteCount = 0;

  constructor(doc: NjsDoc) {
    const recs = recordsStore.get().records;
    const rec = recs.find((r) => r.template_ref === doc.meta.id) ?? recs.find((r) => r.status === 'Approved') ?? recs[0];
    this.store = createStore<EdState>({
      doc, selection: [], tool: 'select', zoom: 1, panX: 0, panY: 0, canUndo: false, canRedo: false, dirty: false,
      previewOn: !!rec, previewRecordId: rec?.id ?? '', grid: false, snap: true, editingText: null, imageTarget: null,
      pickNewImage: false, issues: [], pointer: null, penPoints: 0, editingPath: null, pathSel: null, rev: 0,
    });
  }

  // ---------------------------------------------------------------- DceHost
  doc(): NjsDoc { return this.store.get().doc; }
  data(): RenderData | null {
    const s = this.store.get();
    if (!s.previewOn) return null;
    const rec = recordsStore.get().records.find((r) => r.id === s.previewRecordId);
    return rec ? renderDataFor(rec, s.doc, 1, 1) : null;
  }
  requestImage(ref: string): void {
    if (this.env.images.has(ref) || this.loading.has(ref)) return;
    this.loading.add(ref);
    void mainProvider.load([ref]).then((m) => {
      this.env.images.set(ref, m.get(ref) ?? null);
      this.loading.delete(ref);
      if (!this.disposed) { this.canvas.requestRenderAll(); this.scheduleIssues(); }
    });
  }
  /** Forget a cached image (asset replaced / removed). */
  invalidateImage(ref: string): void { this.env.images.delete(ref); }

  // ---------------------------------------------------------------- lifecycle
  attach(el: HTMLCanvasElement, host: HTMLElement): void {
    this.disposed = false;
    this.fitted = false;
    this.host = host;
    const c = new Canvas(el, {
      selection: true, preserveObjectStacking: true, stopContextMenu: true, fireRightClick: false, uniformScaling: false,
      renderOnAddRemove: false, backgroundColor: '', width: host.clientWidth || 800, height: host.clientHeight || 600,
      selectionColor: 'rgba(69,112,182,0.12)', selectionBorderColor: '#4570B6', selectionLineWidth: 1,
    });
    this.canvas = c;
    c.on('selection:created', () => this.onSelection());
    c.on('selection:updated', () => this.onSelection());
    c.on('selection:cleared', () => { if (!this.expanding) this.store.set({ selection: [] }); });
    c.on('object:modified', (e) => this.onModified(e.target as FabricObject));
    c.on('object:moving', (e) => this.onMoving(e.target as FabricObject));
    c.on('mouse:down', (e) => this.onDown(e));
    c.on('mouse:move', (e) => this.onMove(e));
    c.on('mouse:up', () => this.onUp());
    c.on('mouse:dblclick', (e) => this.onDblClick(e));
    c.on('mouse:wheel', (e) => this.onWheel(e));
    c.on('before:render', (e) => this.drawArtboard(e.ctx));
    c.on('after:render', (e) => this.drawOverlay(e.ctx));
    host.addEventListener('mousedown', this.blurInputs, true); // clicking the canvas must release focus from inspector fields
    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(host);
    window.addEventListener('keydown', this.keyDown);
    window.addEventListener('keyup', this.keyUp);
    this.rebuild();
    this.resize();
    this.scheduleIssues();
  }

  private blurInputs = () => { const a = document.activeElement as HTMLElement | null; if (a && a !== document.body && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && !a.classList.contains('text-edit')) a.blur(); };

  dispose(): void {
    this.disposed = true;
    this.host?.removeEventListener('mousedown', this.blurInputs, true);
    this.resizeObs?.disconnect();
    window.removeEventListener('keydown', this.keyDown);
    window.removeEventListener('keyup', this.keyUp);
    clearTimeout(this.issueTimer);
    void this.canvas?.dispose();
  }

  private resize(): void {
    if (!this.canvas || this.disposed) return;
    const w = this.host.clientWidth, h = this.host.clientHeight;
    if (w < 10 || h < 10) return;
    this.canvas.setDimensions({ width: w, height: h });
    if (!this.fitted) { this.fitted = true; this.fit(); } else this.applyViewport();
  }

  // ---------------------------------------------------------------- viewport
  private applyViewport(): void {
    const s = this.store.get();
    this.canvas.setViewportTransform([s.zoom, 0, 0, s.zoom, s.panX, s.panY]);
    this.canvas.requestRenderAll();
  }
  setViewport(zoom: number, panX: number, panY: number): void {
    this.store.set({ zoom: Math.min(8, Math.max(0.05, zoom)), panX, panY });
    this.applyViewport();
  }
  zoomAt(factor: number, sx?: number, sy?: number): void {
    const s = this.store.get();
    const cx = sx ?? this.host.clientWidth / 2, cy = sy ?? this.host.clientHeight / 2;
    const z = Math.min(8, Math.max(0.05, s.zoom * factor));
    const k = z / s.zoom;
    this.setViewport(z, cx - (cx - s.panX) * k, cy - (cy - s.panY) * k);
  }
  zoomTo(z: number): void { this.zoomAt(z / this.store.get().zoom); }
  fit(): void {
    const { doc } = this.store.get();
    const w = this.host.clientWidth, h = this.host.clientHeight;
    const z = Math.min((w - 80) / doc.canvas.width, (h - 80) / doc.canvas.height, 2);
    this.setViewport(z, (w - doc.canvas.width * z) / 2, (h - doc.canvas.height * z) / 2);
  }
  sceneToScreen(x: number, y: number): { x: number; y: number } {
    const s = this.store.get();
    return { x: x * s.zoom + s.panX, y: y * s.zoom + s.panY };
  }

  // ---------------------------------------------------------------- document & history
  commit(fn: (d: NjsDoc) => void, opts: { rebuild?: boolean; coalesce?: string; keepSelection?: boolean } = {}): void {
    const prev = this.store.get().doc;
    const next = structuredClone(prev);
    fn(next);
    M.refreshGroups(next.nodes);
    M.renumber(next.nodes);
    const now = performance.now();
    if (opts.coalesce && opts.coalesce === this.lastKey && now - this.lastTime < 900 && this.past.length) {
      /* keep the original snapshot: the whole typing burst becomes one undo step */
    } else {
      this.past.push(prev);
      if (this.past.length > HISTORY_MAX) this.past.shift();
    }
    this.lastKey = opts.coalesce ?? ''; this.lastTime = now;
    this.future = [];
    this.setDoc(next, !!opts.rebuild, true);
  }

  private setDoc(doc: NjsDoc, rebuild: boolean, dirty: boolean): void {
    const sel = this.store.get().selection;
    this.store.set((s) => ({ doc, dirty: dirty || s.dirty, canUndo: this.past.length > 0, canRedo: this.future.length > 0, rev: s.rev + 1 }));
    if (rebuild || this.structureChanged()) { this.rebuild(); this.selectIds(sel.filter((id) => this.objects.has(id)), { noExpand: true }); } else this.syncObjects();
    this.scheduleIssues();
  }

  private structureChanged(): boolean {
    const ids = M.leaves(this.store.get().doc.nodes).map((n) => n.id);
    if (ids.length !== this.objects.size) return true;
    return ids.some((id) => !this.objects.has(id));
  }

  undo(): void {
    const prev = this.past.pop();
    if (!prev) return;
    this.future.push(this.store.get().doc);
    this.lastKey = '';
    this.setDoc(prev, true, true);
  }
  redo(): void {
    const next = this.future.pop();
    if (!next) return;
    this.past.push(this.store.get().doc);
    this.lastKey = '';
    this.setDoc(next, true, true);
  }
  /** Replaces the whole document (e.g. revert to the saved version) as one undoable step. */
  replaceDoc(doc: NjsDoc): void {
    this.past.push(this.store.get().doc);
    this.future = [];
    this.lastKey = '';
    this.setDoc(doc, true, true);
  }
  markSaved(doc?: NjsDoc): void { this.store.set(doc ? { dirty: false, doc } : { dirty: false }); }
  /** Replaces the document without history (after save-time placeholder sync). */
  replaceSilently(doc: NjsDoc): void { this.setDoc(doc, false, false); }

  getNode(id: string): DceNode | null { return M.locate(this.store.get().doc.nodes, id)?.node ?? null; }

  // ---------------------------------------------------------------- canvas <-> model
  private rebuild(): void {
    const c = this.canvas;
    c.discardActiveObject();
    for (const o of this.objects.values()) c.remove(o);
    this.objects.clear();
    const doc = this.store.get().doc;
    const hiddenAnc = (id: string) => M.ancestors(doc, id).some((g) => !g.visible);
    const lockedAnc = (id: string) => M.ancestors(doc, id).some((g) => g.locked);
    for (const n of M.leaves(doc.nodes)) {
      const o = new DceObject(n, this);
      this.objects.set(n.id, o);
      this.applyNode(o, n, hiddenAnc(n.id), lockedAnc(n.id));
      c.add(o);
    }
    c.requestRenderAll();
  }

  private applyNode(o: DceObject, n: DceNode, hiddenByGroup: boolean, lockedByGroup: boolean): void {
    const locked = n.locked || lockedByGroup;
    o.node = n;
    o.set({
      width: Math.max(1, n.width), height: Math.max(1, n.height), scaleX: 1, scaleY: 1, angle: n.rotation || 0,
      left: n.x + n.width / 2, top: n.y + n.height / 2, opacity: (n.opacity ?? 1) * this.ancestorOpacity(n.id), visible: n.visible && !hiddenByGroup,
      lockMovementX: locked, lockMovementY: locked, lockRotation: locked, lockScalingX: locked, lockScalingY: locked,
      hasControls: !locked,
    });
    o.setCoords();
    o.dirty = true;
  }

  private ancestorOpacity(id: string): number {
    return M.ancestors(this.store.get().doc, id).reduce((a, g) => a * (g.opacity ?? 1), 1);
  }

  private syncObjects(): void {
    const doc = this.store.get().doc;
    // multi-selection members have group-relative coordinates: drop the selection first, restore afterwards
    const sel = this.store.get().selection;
    const active = this.canvas.getActiveObject();
    const multi = active?.type === 'activeselection';
    if (multi) this.canvas.discardActiveObject();
    for (const n of M.leaves(doc.nodes)) {
      const o = this.objects.get(n.id);
      if (o) this.applyNode(o, n, M.ancestors(doc, n.id).some((g) => !g.visible), M.ancestors(doc, n.id).some((g) => g.locked));
    }
    if (multi) this.selectIds(sel, { noExpand: true });
    this.canvas.requestRenderAll();
  }

  // ---------------------------------------------------------------- selection
  selectIds(ids: string[], opts: { noExpand?: boolean } = {}): void {
    const c = this.canvas;
    if (this.store.get().editingPath && !(ids.length === 1 && ids[0] === this.store.get().editingPath)) this.endPathEditQuiet();
    const objs = ids.map((id) => this.objects.get(id)).filter((o): o is DceObject => !!o && o.visible);
    this.noExpand = !!opts.noExpand;
    this.expanding = true;
    c.discardActiveObject();
    if (objs.length === 1) c.setActiveObject(objs[0]);
    else if (objs.length > 1) c.setActiveObject(new ActiveSelection(objs, { canvas: c }));
    this.expanding = false;
    this.noExpand = false;
    this.store.set({ selection: objs.map((o) => o.node.id) });
    c.requestRenderAll();
  }
  selectAll(): void { this.selectIds(M.leaves(this.doc().nodes).filter((n) => n.visible && !n.locked).map((n) => n.id)); }

  private onSelection(): void {
    if (this.expanding) return;
    const ids = this.canvas.getActiveObjects().map((o) => (o as DceObject).node?.id).filter(Boolean) as string[];
    if (!this.noExpand) {
      const doc = this.doc();
      const all = new Set(ids);
      for (const id of ids) { const g = M.topGroupOf(doc, id); if (g) M.leafIdsOf(g).forEach((x) => all.add(x)); }
      if (all.size !== ids.length) { this.selectIds([...all], { noExpand: true }); return; }
    }
    this.store.set({ selection: ids });
  }

  // ---------------------------------------------------------------- transforms from the canvas
  private onModified(target: FabricObject): void {
    if (this.applying) return;
    const objs = target.type === 'activeselection' ? (target as ActiveSelection).getObjects() : [target];
    const patches = new Map<string, { x: number; y: number; width: number; height: number; rotation: number }>();
    for (const o of objs as DceObject[]) {
      const d = util.qrDecompose(o.calcTransformMatrix());
      const w = Math.max(2, Math.round(o.width * Math.abs(d.scaleX) * 100) / 100);
      const h = Math.max(2, Math.round(o.height * Math.abs(d.scaleY) * 100) / 100);
      let rot = d.angle % 360; if (rot > 180) rot -= 360; if (rot <= -180) rot += 360;
      patches.set(o.node.id, { x: Math.round((d.translateX - w / 2) * 100) / 100, y: Math.round((d.translateY - h / 2) * 100) / 100, width: w, height: h, rotation: Math.round(rot * 100) / 100 });
    }
    const sel = [...patches.keys()];
    const multi = target.type === 'activeselection';
    this.guides = { x: [], y: [] };
    // Fabric fires object:modified while it is still finishing the transform; touching the canvas selection from
    // inside the handler re-enters it. Apply the result on the next tick, after Fabric has finished.
    setTimeout(() => {
      if (this.disposed) return;
      this.applying = true;
      try {
        if (multi) this.canvas.discardActiveObject();
        this.commit((d) => { for (const [id, p] of patches) { const n = M.locate(d.nodes, id)?.node; if (n) Object.assign(n, p); } }, {});
        this.selectIds(sel, { noExpand: true });
      } finally { this.applying = false; }
    }, 0);
  }

  private onMoving(t: FabricObject): void {
    const s = this.store.get();
    this.guides = { x: [], y: [] };
    if (!s.snap) return;
    const doc = s.doc;
    const thr = 6 / s.zoom;
    t.setCoords(); // aCoords are stale while a drag is in progress
    const box = bboxOf(t);
    const selected = new Set(t.type === 'activeselection' ? (t as ActiveSelection).getObjects() : [t]);
    const xs: number[] = [0, doc.canvas.width / 2, doc.canvas.width];
    const ys: number[] = [0, doc.canvas.height / 2, doc.canvas.height];
    for (const o of this.canvas.getObjects()) {
      if (selected.has(o) || !o.visible) continue;
      const b = bboxOf(o);
      xs.push(b.l, b.cx, b.r); ys.push(b.t, b.cy, b.b);
    }
    const best = (mine: number[], cands: number[]) => {
      let dBest = Infinity, line = 0;
      for (const m of mine) for (const cnd of cands) { const d = cnd - m; if (Math.abs(d) < Math.abs(dBest)) { dBest = d; line = cnd; } }
      return Math.abs(dBest) <= thr ? { d: dBest, line } : null;
    };
    let dx = 0, dy = 0;
    const bx = best([box.l, box.cx, box.r], xs), by = best([box.t, box.cy, box.b], ys);
    if (bx) { dx = bx.d; this.guides.x.push(bx.line); }
    if (by) { dy = by.d; this.guides.y.push(by.line); }
    const g = doc.constraints.snapGrid ?? 10;
    if (!bx && g > 0) { dx = Math.round(box.l / g) * g - box.l; if (Math.abs(dx) > thr) dx = 0; }
    if (!by && g > 0) { dy = Math.round(box.t / g) * g - box.t; if (Math.abs(dy) > thr) dy = 0; }
    if (dx || dy) { t.set({ left: (t.left ?? 0) + dx, top: (t.top ?? 0) + dy }); t.setCoords(); }
  }

  // ---------------------------------------------------------------- tools & drawing
  setTool(tool: ToolId): void {
    if (this.store.get().editingPath) this.endPathEdit();
    if (this.store.get().tool === 'pen' && tool !== 'pen') this.penPts = [];
    this.store.set({ tool, penPoints: 0 });
    const select = tool === 'select';
    this.canvas.selection = select;
    this.canvas.skipTargetFind = !select;
    this.canvas.defaultCursor = select ? 'default' : 'crosshair';
    if (!select) this.canvas.discardActiveObject();
    if (tool === 'image') { this.store.set({ pickNewImage: true }); }
    this.canvas.requestRenderAll();
  }

  private snapPt(x: number, y: number): [number, number] {
    const s = this.store.get();
    const g = s.doc.constraints.snapGrid ?? 10;
    return s.snap && g > 0 ? [Math.round(x / g) * g, Math.round(y / g) * g] : [x, y];
  }

  private onDown(e: TPointerEventInfo): void {
    const ne = e.e as MouseEvent;
    if (this.spaceDown || ne.button === 1) { this.panning = { x: ne.clientX, y: ne.clientY }; this.canvas.selection = false; return; }
    const s = this.store.get();
    if (s.editingPath) { this.pathDown(e.scenePoint.x, e.scenePoint.y, ne); return; }
    if (s.tool === 'select' || s.tool === 'image') return;
    const p = e.scenePoint;
    if (s.tool === 'pen') { this.penClick(p.x, p.y); return; }
    const [x, y] = this.snapPt(p.x, p.y);
    const type = s.tool as DceNode['type'];
    const tmp = makeNode(type, { x, y, width: 1, height: 1 });
    if (type === 'text') tmp.text = '';
    const obj = new DceObject(tmp, this);
    obj.set({ left: x, top: y, width: 1, height: 1, selectable: false, evented: false });
    this.canvas.add(obj);
    this.drawing = { x, y, obj, type };
  }

  private onMove(e: TPointerEventInfo): void {
    const ne = e.e as MouseEvent;
    this.store.set({ pointer: { x: Math.round(e.scenePoint.x), y: Math.round(e.scenePoint.y) } });
    if (this.panning) {
      const s = this.store.get();
      this.setViewport(s.zoom, s.panX + (ne.clientX - this.panning.x), s.panY + (ne.clientY - this.panning.y));
      this.panning = { x: ne.clientX, y: ne.clientY };
      return;
    }
    if (this.pathDrag) { this.pathMove(e.scenePoint.x, e.scenePoint.y, ne.altKey); return; }
    if (this.store.get().tool === 'pen' && this.penPts.length) {
      const px = e.scenePoint.x, py = e.scenePoint.y;
      if (this.penDrag !== null && (ne.buttons & 1)) {
        const a = this.penPts[this.penDrag];
        if (Math.hypot(px - a.x, py - a.y) > 3 / this.store.get().zoom) { a.hout = [px, py]; a.hin = [2 * a.x - px, 2 * a.y - py]; }
      }
      this.penMouse = [px, py]; this.canvas.requestRenderAll(); return;
    }
    const d = this.drawing;
    if (!d) return;
    let [x, y] = this.snapPt(e.scenePoint.x, e.scenePoint.y);
    if (d.type === 'line') {
      const dx = x - d.x, dy = y - d.y;
      const len = Math.max(2, Math.hypot(dx, dy));
      d.obj.set({ left: (d.x + x) / 2, top: (d.y + y) / 2, width: len, height: 12, angle: (Math.atan2(dy, dx) * 180) / Math.PI });
    } else {
      if (ne.shiftKey) { const m = Math.max(Math.abs(x - d.x), Math.abs(y - d.y)); x = d.x + Math.sign(x - d.x || 1) * m; y = d.y + Math.sign(y - d.y || 1) * m; }
      d.obj.set({ left: (d.x + x) / 2, top: (d.y + y) / 2, width: Math.max(1, Math.abs(x - d.x)), height: Math.max(1, Math.abs(y - d.y)) });
    }
    d.obj.setCoords();
    this.canvas.requestRenderAll();
  }

  private onUp(): void {
    this.guides = { x: [], y: [] };
    this.penDrag = null;
    if (this.pathDrag) { this.pathDrag = null; this.lastKey = ''; return; }
    if (this.panning) { this.panning = null; this.canvas.selection = this.store.get().tool === 'select'; this.canvas.requestRenderAll(); return; }
    const d = this.drawing;
    if (!d) { this.canvas.requestRenderAll(); return; }
    this.drawing = null;
    const o = d.obj;
    const tiny = o.width < 6 && o.height < 6 && d.type !== 'line';
    const tinyLine = d.type === 'line' && o.width < 6;
    this.canvas.remove(o);
    const base = makeNode(d.type);
    const node: DceNode = { ...base, name: M.uniqueName(this.doc(), base.name) };
    if (tiny || tinyLine) { node.x = d.x - base.width / 2; node.y = d.y - base.height / 2; }
    else if (d.type === 'line') { node.width = o.width; node.height = 12; node.x = (o.left ?? 0) - o.width / 2; node.y = (o.top ?? 0) - 6; node.rotation = Math.round(o.angle * 100) / 100; }
    else { node.x = (o.left ?? 0) - o.width / 2; node.y = (o.top ?? 0) - o.height / 2; node.width = Math.round(o.width); node.height = Math.round(o.height); }
    node.x = Math.round(node.x); node.y = Math.round(node.y);
    this.addNode(node);
    this.setTool('select');
    if (d.type === 'text') this.startTextEdit(node.id);
  }

  private onDblClick(e: TPointerEventInfo): void {
    const s = this.store.get();
    if (s.editingPath) { this.pathDouble(e.scenePoint.x, e.scenePoint.y); return; }
    if (s.tool === 'pen') { this.penPts.pop(); this.finishPen(false); return; }
    const t = e.target as DceObject | undefined;
    if (!t?.node) return;
    if (t.node.type === 'path' && !t.node.locked) this.startPathEdit(t.node.id);
    else if (t.node.type === 'text' && !t.node.locked) this.startTextEdit(t.node.id);
    else if ((t.node.type === 'image' || t.node.type === 'frame') && !t.node.locked) this.store.set({ imageTarget: t.node.id });
  }

  private onWheel(e: { e: WheelEvent }): void {
    const we = e.e;
    we.preventDefault(); we.stopPropagation();
    const rect = this.host.getBoundingClientRect();
    if (we.ctrlKey || we.metaKey) {
      this.zoomAt(Math.exp(-we.deltaY * 0.0015), we.clientX - rect.left, we.clientY - rect.top);
    } else {
      const s = this.store.get();
      this.setViewport(s.zoom, s.panX - (we.shiftKey ? we.deltaY : we.deltaX), s.panY - (we.shiftKey ? 0 : we.deltaY));
    }
  }

  // ---- pen
  private penClick(x: number, y: number): void {
    const s = this.store.get();
    const [sx, sy] = this.snapPt(x, y);
    if (this.penPts.length >= 3) {
      const f = this.penPts[0];
      if (Math.hypot(f.x - sx, f.y - sy) < 10 / s.zoom) { this.finishPen(true); return; }
    }
    this.penPts.push({ x: sx, y: sy });
    this.penDrag = this.penPts.length - 1; // dragging before releasing pulls out smooth Bézier handles
    this.store.set({ penPoints: this.penPts.length });
    this.canvas.requestRenderAll();
  }
  finishPen(closed: boolean): void {
    const pts = this.penPts;
    this.penPts = []; this.penMouse = null; this.penDrag = null;
    this.store.set({ penPoints: 0 });
    if (pts.length < 2) { this.canvas.requestRenderAll(); return; }
    const node = makeNode('path', {
      name: M.uniqueName(this.doc(), 'Path'),
      style: closed ? { fill: '#CAEBFB', stroke: '#231F20', strokeWidth: 4 } : { fill: 'none', stroke: '#231F20', strokeWidth: 4 },
    });
    PH.fromWorld(node, {
      a: pts.map((p) => [p.x, p.y] as PH.P), closed,
      h: pts.map((p) => (p.hout && p.hin ? { inn: p.hin, out: p.hout } : null)),
    });
    this.addNode(node);
    this.setTool('select');
  }
  cancelPen(): void { this.penPts = []; this.penMouse = null; this.penDrag = null; this.store.set({ penPoints: 0 }); this.canvas.requestRenderAll(); }

  // ---------------------------------------------------------------- Bézier path editing
  startPathEdit(id: string): void {
    const n = this.getNode(id);
    if (!n || n.type !== 'path') return;
    if (this.store.get().editingPath) this.endPathEdit();
    if (n.rotation) this.commit((d) => { const x = M.locate(d.nodes, id)?.node; if (x) PH.fromWorld(x, PH.toWorld(x)); }); // bake rotation into the points
    this.canvas.discardActiveObject();
    this.canvas.selection = false; this.canvas.skipTargetFind = true; this.canvas.defaultCursor = 'crosshair';
    this.store.set({ editingPath: id, pathSel: null, selection: [id], tool: 'select' });
    this.canvas.requestRenderAll();
  }
  private endPathEditQuiet(): void {
    this.pathDrag = null;
    this.store.set({ editingPath: null, pathSel: null });
    this.canvas.selection = true; this.canvas.skipTargetFind = false; this.canvas.defaultCursor = 'default';
  }
  endPathEdit(): void {
    const id = this.store.get().editingPath;
    if (!id) return;
    this.pathDrag = null;
    this.store.set({ editingPath: null, pathSel: null });
    this.canvas.selection = true; this.canvas.skipTargetFind = false; this.canvas.defaultCursor = 'default';
    this.selectIds([id], { noExpand: true });
  }

  /** Applies an edit to the node being edited (all moves of one drag collapse into one undo step). */
  private editPath(fn: (wp: PH.WorldPath) => PH.WorldPath, coalesce: string): void {
    const id = this.store.get().editingPath;
    if (!id) return;
    this.commit((d) => { const x = M.locate(d.nodes, id)?.node; if (x?.path) PH.fromWorld(x, fn(PH.toWorld(x))); }, { coalesce });
  }

  private hit(wp: PH.WorldPath, x: number, y: number): { kind: 'a' | 'in' | 'out'; idx: number } | null {
    const r = 9 / this.store.get().zoom;
    for (let i = 0; i < wp.a.length; i++) {
      const h = wp.h[i];
      if (h && Math.hypot(h.out[0] - x, h.out[1] - y) <= r && PH.distance(h.out, wp.a[i]) > 0.5) return { kind: 'out', idx: i };
      if (h && Math.hypot(h.inn[0] - x, h.inn[1] - y) <= r && PH.distance(h.inn, wp.a[i]) > 0.5) return { kind: 'in', idx: i };
    }
    for (let i = wp.a.length - 1; i >= 0; i--) if (Math.hypot(wp.a[i][0] - x, wp.a[i][1] - y) <= r) return { kind: 'a', idx: i };
    return null;
  }

  private pathDown(x: number, y: number, ne: MouseEvent): void {
    const id = this.store.get().editingPath!;
    const n = this.getNode(id);
    if (!n) return;
    const wp = PH.toWorld(n);
    const h = this.hit(wp, x, y);
    if (h) { this.pathDrag = h; this.store.set({ pathSel: h.idx }); this.canvas.requestRenderAll(); return; }
    const near = PH.nearestOnPath(wp, [x, y]);
    if (near && near.dist <= 8 / this.store.get().zoom) { this.store.set({ pathSel: null }); return; } // on the line: wait for a double-click (insert)
    void ne;
    this.endPathEdit();
  }

  private pathMove(x: number, y: number, alt: boolean): void {
    const drag = this.pathDrag;
    if (!drag) return;
    this.editPath((wp) => {
      const a = wp.a.slice(), h = wp.h.slice();
      const i = drag.idx;
      if (drag.kind === 'a') {
        const dx = x - a[i][0], dy = y - a[i][1];
        a[i] = [x, y];
        if (h[i]) h[i] = { inn: [h[i]!.inn[0] + dx, h[i]!.inn[1] + dy], out: [h[i]!.out[0] + dx, h[i]!.out[1] + dy] };
      } else {
        const cur = h[i] ?? { inn: a[i], out: a[i] };
        const moved: PH.P = [x, y];
        const mirror: PH.P = [2 * a[i][0] - x, 2 * a[i][1] - y];
        h[i] = drag.kind === 'out' ? { out: moved, inn: alt ? cur.inn : mirror } : { inn: moved, out: alt ? cur.out : mirror };
      }
      return { ...wp, a, h };
    }, 'pathdrag');
  }

  private pathDouble(x: number, y: number): void {
    const id = this.store.get().editingPath;
    const n = id ? this.getNode(id) : null;
    if (!id || !n) return;
    const wp = PH.toWorld(n);
    const hit = this.hit(wp, x, y);
    if (hit && hit.kind === 'a') {
      // corner ⇄ smooth
      this.editPath((w) => { const h = w.h.slice(); h[hit.idx] = h[hit.idx] ? null : PH.autoHandle(w, hit.idx); return { ...w, h }; }, 'pathtoggle');
      this.lastKey = '';
      return;
    }
    const near = PH.nearestOnPath(wp, [x, y]);
    if (near && near.dist <= 8 / this.store.get().zoom) {
      let idx = 0;
      this.editPath((w) => { const r = PH.splitSegment(w, near.seg, near.t); idx = r.index; return r.wp; }, 'pathadd');
      this.lastKey = '';
      this.store.set({ pathSel: idx });
    }
  }

  deletePathAnchor(): void {
    const { editingPath: id, pathSel: i } = this.store.get();
    const n = id ? this.getNode(id) : null;
    if (!id || i === null || !n?.path) return;
    if (n.path.points.length <= 2) { notify0('A path needs at least two points — delete the element instead.'); return; }
    this.editPath((w) => PH.removeAnchor(w, i), 'pathdel');
    this.lastKey = '';
    this.store.set({ pathSel: null });
  }

  /** Inspector helpers: smooth every anchor / turn all into corners / open ⇄ close. */
  pathSmoothAll(): void { this.commit((d) => { const x = this.store.get().selection[0]; const n = x ? M.locate(d.nodes, x)?.node : null; if (n?.path) PH.fromWorld(n, PH.smoothAll(PH.toWorld(n))); }); }
  pathCornerAll(): void { this.commit((d) => { const x = this.store.get().selection[0]; const n = x ? M.locate(d.nodes, x)?.node : null; if (n?.path) PH.fromWorld(n, PH.cornerAll(PH.toWorld(n))); }); }
  pathToggleClosed(): void { this.commit((d) => { const x = this.store.get().selection[0]; const n = x ? M.locate(d.nodes, x)?.node : null; if (n?.path) n.path.closed = !n.path.closed; }); }

  // ---------------------------------------------------------------- node operations
  addNode(node: DceNode, select = true): void {
    const n = { ...node, name: node.name || M.uniqueName(this.doc(), 'Layer') };
    this.commit((d) => { d.nodes.push(n); }, { rebuild: true });
    if (select) this.selectIds(M.leafIdsOf(n), { noExpand: true });
  }

  /** Adds a static image node for an asset, sized to fit within 520px, centred on the canvas (or at `at`). */
  addImageNode(assetId: string, w: number, h: number, name: string, at?: { x: number; y: number }): void {
    const doc = this.doc();
    const s = Math.min(1, 520 / Math.max(w, h));
    const nw = Math.round(w * s), nh = Math.round(h * s);
    const node = makeNode('image', {
      name: M.uniqueName(doc, name.replace(/\.[a-z0-9]+$/i, '')), width: nw, height: nh,
      x: Math.round((at?.x ?? doc.canvas.width / 2) - nw / 2), y: Math.round((at?.y ?? doc.canvas.height / 2) - nh / 2), src: { assetId },
    });
    this.addNode(node);
    this.setTool('select');
  }

  updateNode(id: string, fn: (n: DceNode) => void, opts: { coalesce?: string } = {}): void {
    this.commit((d) => { const n = M.locate(d.nodes, id)?.node; if (n) fn(n); }, { coalesce: opts.coalesce });
  }

  /** Applies `fn` to every selected node (groups propagate to children for geometry-neutral props). */
  updateSelected(fn: (n: DceNode) => void, opts: { coalesce?: string } = {}): void {
    const ids = this.store.get().selection;
    this.commit((d) => { for (const id of ids) { const n = M.locate(d.nodes, id)?.node; if (n) fn(n); } }, opts);
  }

  setNodeFlag(id: string, key: 'visible' | 'locked', value: boolean): void {
    this.commit((d) => { const n = M.locate(d.nodes, id)?.node; if (n) n[key] = value; }, { rebuild: false });
  }

  deleteSelected(): void {
    const ids = this.store.get().selection;
    if (!ids.length) return;
    this.commit((d) => { M.removeNodes(d, M.topLevelSelection(d, ids).map((n) => n.id)); }, { rebuild: true });
    this.selectIds([]);
  }
  deleteNode(id: string): void {
    this.commit((d) => { M.removeNodes(d, [id]); }, { rebuild: true });
    this.selectIds([]);
  }

  duplicate(): void {
    const ids = this.store.get().selection;
    if (!ids.length) return;
    let created: string[] = [];
    this.commit((d) => { created = M.duplicateNodes(d, ids); }, { rebuild: true });
    this.selectIds(created, { noExpand: true });
  }
  copy(): void {
    const doc = this.doc();
    clipboard.nodes = M.topLevelSelection(doc, this.store.get().selection).map((n) => structuredClone(n));
    this.pasteCount = 0;
  }
  cut(): void { this.copy(); this.deleteSelected(); }
  paste(): void {
    if (!clipboard.nodes.length) return;
    this.pasteCount++;
    const fresh = clipboard.nodes.map((n) => { const c = M.cloneWithNewIds(n); M.translate(c, 24 * this.pasteCount, 24 * this.pasteCount); return c; });
    this.commit((d) => { d.nodes.push(...fresh); }, { rebuild: true });
    this.selectIds(fresh.flatMap(M.leafIdsOf), { noExpand: true });
  }
  hasClipboard(): boolean { return clipboard.nodes.length > 0; }

  group(): void {
    const ids = this.store.get().selection;
    let gid: string | null = null;
    this.commit((d) => { gid = M.groupSelection(d, ids); }, { rebuild: true });
    if (gid) this.selectIds(ids, { noExpand: true });
  }
  ungroup(): void {
    const doc = this.doc();
    const ids = this.store.get().selection;
    const groups = new Set<string>();
    for (const id of ids) { const g = M.topGroupOf(doc, id); if (g) groups.add(g.id); }
    if (!groups.size) return;
    this.commit((d) => { for (const g of groups) M.ungroup(d, g); }, { rebuild: true });
    this.selectIds(ids, { noExpand: true });
  }
  selectionInGroup(): boolean {
    const doc = this.doc();
    return this.store.get().selection.some((id) => !!M.topGroupOf(doc, id));
  }
  reorder(mode: M.ReorderMode): void {
    const ids = this.store.get().selection;
    this.commit((d) => M.reorder(d, ids, mode), { rebuild: true });
  }
  moveLayer(dragId: string, targetId: string, where: 'above' | 'below'): void {
    this.commit((d) => { M.moveRelative(d, dragId, targetId, where); }, { rebuild: true });
  }
  align(mode: M.AlignMode, to: 'selection' | 'canvas' = 'selection'): void {
    const ids = this.store.get().selection;
    this.commit((d) => M.alignNodes(d, ids, mode, to));
  }
  distribute(axis: 'h' | 'v'): void {
    const ids = this.store.get().selection;
    this.commit((d) => M.distributeNodes(d, ids, axis));
  }
  nudge(dx: number, dy: number): void {
    const ids = this.store.get().selection;
    if (!ids.length) return;
    this.commit((d) => { for (const n of M.topLevelSelection(d, ids)) if (!n.locked) M.translate(n, dx, dy); }, { coalesce: 'nudge' });
  }

  renameNode(id: string, name: string): void { this.updateNode(id, (n) => { n.name = name.trim() || n.name; }); }

  setCanvas(patch: Partial<NjsDoc['canvas']>): void {
    this.commit((d) => { Object.assign(d.canvas, patch); }, { coalesce: 'canvas' });
    if (patch.width || patch.height) this.fit();
  }

  syncPlaceholdersNow(): void {
    this.commit((d) => { d.placeholders = syncPlaceholders(d); });
  }

  // ---------------------------------------------------------------- text editing
  startTextEdit(id: string): void { this.selectIds([id]); this.store.set({ editingText: id }); }
  endTextEdit(value: string | null): void {
    const id = this.store.get().editingText;
    this.store.set({ editingText: null });
    if (id && value !== null) {
      this.updateNode(id, (n) => { if (n.binding?.text) n.binding.text.template = value; else n.text = value; });
    }
  }

  // ---------------------------------------------------------------- preview / issues
  setPreview(on: boolean): void { this.store.set({ previewOn: on }); this.canvas.requestRenderAll(); this.scheduleIssues(); }
  setPreviewRecord(id: string): void { this.store.set({ previewRecordId: id }); this.canvas.requestRenderAll(); this.scheduleIssues(); }
  setGrid(on: boolean): void { this.store.set({ grid: on }); this.canvas.requestRenderAll(); }
  setSnap(on: boolean): void { this.store.set({ snap: on }); }

  private scheduleIssues(): void {
    clearTimeout(this.issueTimer);
    this.issueTimer = window.setTimeout(() => {
      if (this.disposed) return;
      const data = this.data();
      const issues = data ? buildScene(this.doc(), data, this.env).issues : [];
      this.store.set({ issues });
    }, 150);
  }

  // ---------------------------------------------------------------- keyboard
  private keyUp = (e: KeyboardEvent) => { if (e.code === 'Space') { this.spaceDown = false; if (this.canvas) this.canvas.defaultCursor = this.store.get().tool === 'select' ? 'default' : 'crosshair'; } };
  private keyDown = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
    if (e.code === 'Space' && !typing) { this.spaceDown = true; this.canvas.defaultCursor = 'grab'; e.preventDefault(); return; }
    if (typing || this.store.get().editingText) return;
    if (document.querySelector('.scrim')) return; // a dialog is open
    if (this.store.get().editingPath) {
      const k = e.key.toLowerCase();
      if (k === 'escape' || k === 'enter') { this.endPathEdit(); e.preventDefault(); }
      else if (k === 'delete' || k === 'backspace') { this.deletePathAnchor(); e.preventDefault(); }
      else if ((e.ctrlKey || e.metaKey) && k === 'z') { if (e.shiftKey) this.redo(); else this.undo(); e.preventDefault(); }
      return;
    }
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    const s = this.store.get();
    if (mod) {
      let handled = true;
      if (key === 'z' && !e.shiftKey) this.undo();
      else if (key === 'y' || (key === 'z' && e.shiftKey)) this.redo();
      else if (key === 'c') this.copy();
      else if (key === 'x') this.cut();
      else if (key === 'v') this.paste();
      else if (key === 'd') this.duplicate();
      else if (key === 'a') this.selectAll();
      else if (key === 'g' && e.shiftKey) this.ungroup();
      else if (key === 'g') this.group();
      else if (key === '0') this.fit();
      else if (key === '1') this.zoomTo(1);
      else if (key === '=' || key === '+') this.zoomAt(1.25);
      else if (key === '-') this.zoomAt(0.8);
      else if (key === ']') this.reorder(e.shiftKey ? 'front' : 'forward');
      else if (key === '[') this.reorder(e.shiftKey ? 'back' : 'backward');
      else handled = false; // Ctrl+S is handled by the page
      if (handled) e.preventDefault();
      return;
    }
    const tools: Record<string, ToolId> = { v: 'select', r: 'rect', o: 'ellipse', l: 'line', t: 'text', f: 'frame', i: 'image', p: 'pen', y: 'polygon', s: 'star' };
    if (tools[key] && !e.altKey) { this.setTool(tools[key]); e.preventDefault(); return; }
    if (key === 'escape') { if (s.tool === 'pen') this.cancelPen(); this.setTool('select'); this.selectIds([]); return; }
    if (key === 'enter' && s.tool === 'pen') { this.finishPen(false); return; }
    if (key === 'enter' && s.selection.length === 1) { const n = this.getNode(s.selection[0]); if (n?.type === 'text') { this.startTextEdit(n.id); e.preventDefault(); } else if (n?.type === 'path') { this.startPathEdit(n.id); e.preventDefault(); } return; }
    if (key === 'delete' || key === 'backspace') { this.deleteSelected(); e.preventDefault(); return; }
    const step = e.shiftKey ? 10 : 1;
    if (key === 'arrowleft') { this.nudge(-step, 0); e.preventDefault(); }
    else if (key === 'arrowright') { this.nudge(step, 0); e.preventDefault(); }
    else if (key === 'arrowup') { this.nudge(0, -step); e.preventDefault(); }
    else if (key === 'arrowdown') { this.nudge(0, step); e.preventDefault(); }
  };

  // ---------------------------------------------------------------- drawing helpers (artboard / guides / indicators)
  private drawArtboard(ctx: CanvasRenderingContext2D): void {
    const s = this.store.get();
    const { width: W, height: H, background } = s.doc.canvas;
    ctx.save();
    ctx.transform(s.zoom, 0, 0, s.zoom, s.panX, s.panY);
    ctx.shadowColor = 'rgba(35,31,32,0.28)'; ctx.shadowBlur = 18; ctx.shadowOffsetY = 3;
    ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, W, H);
    ctx.shadowColor = 'transparent';
    const bg = !background || background === 'transparent' || background === 'none' ? null : background;
    if (bg) { ctx.fillStyle = '#000'; ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H); }
    else {
      ctx.fillStyle = '#EEF2F6';
      const t = 16;
      for (let y = 0; y < H; y += t) for (let x = (y / t) % 2 ? t : 0; x < W; x += t * 2) ctx.fillRect(x, y, Math.min(t, W - x), Math.min(t, H - y));
    }
    if (s.grid) {
      const g = s.doc.constraints.snapGrid ?? 10;
      if (g * s.zoom >= 6) {
        ctx.strokeStyle = 'rgba(69,112,182,0.16)'; ctx.lineWidth = 1 / s.zoom; ctx.beginPath();
        for (let x = g; x < W; x += g) { ctx.moveTo(x, 0); ctx.lineTo(x, H); }
        for (let y = g; y < H; y += g) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  private drawOverlay(ctx: CanvasRenderingContext2D): void {
    const s = this.store.get();
    ctx.save();
    ctx.transform(s.zoom, 0, 0, s.zoom, s.panX, s.panY);
    const px = 1 / s.zoom;
    // artboard border
    ctx.strokeStyle = 'rgba(35,31,32,0.25)'; ctx.lineWidth = px; ctx.strokeRect(0, 0, s.doc.canvas.width, s.doc.canvas.height);
    // binding indicators: a small dot on every bound element, plus a dashed outline in design view (never part of exports)
    for (const o of this.objects.values()) {
      const b = o.node.binding;
      if (!o.visible || !b || !(b.text || b.image || b.fill || b.visible)) continue;
      const bb = bboxOf(o);
      if (!s.previewOn) {
        ctx.strokeStyle = 'rgba(69,112,182,0.55)'; ctx.setLineDash([4 * px, 3 * px]); ctx.lineWidth = px;
        ctx.strokeRect(bb.l, bb.t, bb.r - bb.l, bb.b - bb.t);
        ctx.setLineDash([]);
      }
      ctx.fillStyle = '#4570B6'; ctx.strokeStyle = '#CAEBFB'; ctx.lineWidth = 2 * px;
      ctx.beginPath(); ctx.arc(bb.l, bb.t, 4.5 * px, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
    // alignment guides
    ctx.strokeStyle = '#D6336C'; ctx.lineWidth = px;
    for (const x of this.guides.x) { ctx.beginPath(); ctx.moveTo(x, -4000); ctx.lineTo(x, 8000); ctx.stroke(); }
    for (const y of this.guides.y) { ctx.beginPath(); ctx.moveTo(-4000, y); ctx.lineTo(8000, y); ctx.stroke(); }
    // pen preview (curves, with handles for the point being dragged)
    if (this.penPts.length) {
      ctx.strokeStyle = '#4570B6'; ctx.lineWidth = 2 * px; ctx.beginPath();
      this.penPts.forEach((p, i) => {
        if (!i) { ctx.moveTo(p.x, p.y); return; }
        const q = this.penPts[i - 1];
        if (q.hout || p.hin) ctx.bezierCurveTo((q.hout ?? [q.x, q.y])[0], (q.hout ?? [q.x, q.y])[1], (p.hin ?? [p.x, p.y])[0], (p.hin ?? [p.x, p.y])[1], p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      });
      if (this.penMouse && this.penDrag === null) ctx.lineTo(this.penMouse[0], this.penMouse[1]);
      ctx.stroke();
      ctx.lineWidth = px;
      for (const p of this.penPts) if (p.hin && p.hout) {
        ctx.beginPath(); ctx.moveTo(p.hin[0], p.hin[1]); ctx.lineTo(p.hout[0], p.hout[1]); ctx.stroke();
        for (const h of [p.hin, p.hout]) { ctx.beginPath(); ctx.arc(h[0], h[1], 3.5 * px, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill(); ctx.stroke(); }
      }
      this.penPts.forEach((p, i) => { ctx.beginPath(); ctx.rect(p.x - 4 * px, p.y - 4 * px, 8 * px, 8 * px); ctx.fillStyle = i === 0 ? '#CAEBFB' : '#fff'; ctx.fill(); ctx.stroke(); });
    }
    // Bézier edit mode: anchors (squares) and handles (circles)
    if (s.editingPath) {
      const n = this.getNode(s.editingPath);
      if (n?.path) {
        const wp = PH.toWorld(n);
        ctx.lineWidth = px; ctx.strokeStyle = '#4570B6';
        wp.a.forEach((p, i) => {
          const h = wp.h[i];
          if (h) {
            ctx.beginPath(); ctx.moveTo(h.inn[0], h.inn[1]); ctx.lineTo(p[0], p[1]); ctx.lineTo(h.out[0], h.out[1]); ctx.stroke();
            for (const q of [h.inn, h.out]) { ctx.beginPath(); ctx.arc(q[0], q[1], 4 * px, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill(); ctx.stroke(); }
          }
        });
        wp.a.forEach((p, i) => {
          ctx.beginPath(); ctx.rect(p[0] - 5 * px, p[1] - 5 * px, 10 * px, 10 * px);
          ctx.fillStyle = s.pathSel === i ? '#4570B6' : '#fff'; ctx.fill(); ctx.lineWidth = 1.5 * px; ctx.stroke();
        });
      }
    }
    ctx.restore();
  }
}

function bboxOf(o: FabricObject): { l: number; t: number; r: number; b: number; cx: number; cy: number } {
  const c = o.getCoords();
  const xs = c.map((p) => p.x), ys = c.map((p) => p.y);
  const l = Math.min(...xs), r = Math.max(...xs), t = Math.min(...ys), b = Math.max(...ys);
  return { l, r, t, b, cx: (l + r) / 2, cy: (t + b) / 2 };
}

export { uid };

function notify0(text: string): void { void import('../ui/store').then((m) => m.notify('warn', text)); }
