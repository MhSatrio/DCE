/**
 * An SVG as editable vectors: every <path> becomes sub-paths of anchors (nodes) and cubic segments with their handles.
 * Pure: text in, text out. The editor (pages/assets/SvgEditor.tsx) changes the document through these functions, so each
 * change can be tested and undone.
 *
 * Supported path data: M L H V C S Q T Z (absolute and relative). Elliptical arcs (A) become straight lines to their end
 * point; the tracer used for this app never writes arcs. Quadratic curves are stored as cubics.
 */

export interface Pt { x: number; y: number }
export type Seg = { kind: 'L'; p: Pt } | { kind: 'C'; c1: Pt; c2: Pt; p: Pt };
export interface Sub { start: Pt; segs: Seg[]; closed: boolean }
export interface PathEl { attrs: Record<string, string>; subs: Sub[] }
/** chunks[i] is the text before path i; chunks[paths.length] is the text after the last path. */
export interface SvgDoc { chunks: string[]; paths: PathEl[] }

const num = (n: number) => { const r = Math.round(n * 1000) / 1000; return Object.is(r, -0) ? '0' : String(r); };
const fmtPt = (p: Pt) => `${num(p.x)} ${num(p.y)}`;

// ------------------------------------------------------------------------------------------------ reading

/** Path data → sub-paths with absolute coordinates. */
export function parsePathData(d: string): Sub[] {
  const tokens = d.match(/[MmLlHhVvCcSsQqTtZzAa]|[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g) ?? [];
  const subs: Sub[] = [];
  let i = 0;
  let cmd = '';
  let cur: Pt = { x: 0, y: 0 };
  let start: Pt = { x: 0, y: 0 };
  const curSub = (): Sub => subs[subs.length - 1];
  let lastCtrl: Pt | null = null;       // for S (cubic) and T (quadratic) reflections
  let lastKind: '' | 'C' | 'Q' = '';
  const num_ = () => Number(tokens[i++]);
  const isCmd = (t: string) => /^[A-Za-z]$/.test(t);
  const open = (p: Pt) => { subs.push({ start: p, segs: [], closed: false }); };
  while (i < tokens.length) {
    if (isCmd(tokens[i])) cmd = tokens[i++];
    else if (cmd === '') break;                       // numbers before any command: not path data
    const rel = cmd === cmd.toLowerCase();
    const base = rel ? cur : { x: 0, y: 0 };
    const up = cmd.toUpperCase();
    if (up === 'Z') {
      if (subs.length) curSub().closed = true;
      cur = start; lastKind = ''; lastCtrl = null;
      continue;
    }
    if (up === 'M') {
      const p = { x: num_() + base.x, y: num_() + base.y };
      cur = p; start = p; open(p); lastKind = ''; lastCtrl = null;
      cmd = rel ? 'l' : 'L';                          // further pairs after M are line-tos
      continue;
    }
    if (subs.length === 0) open(cur);                 // a path that does not start with M
    const s = curSub();
    if (up === 'L' || up === 'H' || up === 'V') {
      let p: Pt;
      if (up === 'L') p = { x: num_() + base.x, y: num_() + base.y };
      else if (up === 'H') p = { x: num_() + (rel ? cur.x : 0), y: cur.y };
      else p = { x: cur.x, y: num_() + (rel ? cur.y : 0) };
      s.segs.push({ kind: 'L', p }); cur = p; lastKind = ''; lastCtrl = null;
    } else if (up === 'C' || up === 'S') {
      let c1: Pt;
      if (up === 'C') c1 = { x: num_() + base.x, y: num_() + base.y };
      else c1 = lastKind === 'C' && lastCtrl ? { x: 2 * cur.x - lastCtrl.x, y: 2 * cur.y - lastCtrl.y } : { ...cur };
      const c2 = { x: num_() + base.x, y: num_() + base.y };
      const p = { x: num_() + base.x, y: num_() + base.y };
      s.segs.push({ kind: 'C', c1, c2, p }); cur = p; lastCtrl = c2; lastKind = 'C';
    } else if (up === 'Q' || up === 'T') {
      let q: Pt;
      if (up === 'Q') q = { x: num_() + base.x, y: num_() + base.y };
      else q = lastKind === 'Q' && lastCtrl ? { x: 2 * cur.x - lastCtrl.x, y: 2 * cur.y - lastCtrl.y } : { ...cur };
      const p = { x: num_() + base.x, y: num_() + base.y };
      // a quadratic is kept as the equivalent cubic
      const c1 = { x: cur.x + (2 / 3) * (q.x - cur.x), y: cur.y + (2 / 3) * (q.y - cur.y) };
      const c2 = { x: p.x + (2 / 3) * (q.x - p.x), y: p.y + (2 / 3) * (q.y - p.y) };
      s.segs.push({ kind: 'C', c1, c2, p }); cur = p; lastCtrl = q; lastKind = 'Q';
    } else if (up === 'A') {
      for (let k = 0; k < 5; k++) num_();              // rx ry rotation large-arc sweep
      const p = { x: num_() + base.x, y: num_() + base.y };
      s.segs.push({ kind: 'L', p }); cur = p; lastKind = ''; lastCtrl = null;
    } else {
      break;
    }
  }
  return subs.filter((x) => x.segs.length > 0 || x.closed);
}

/** SVG text → document. Every <path> element is parsed; everything else is kept as text. */
export function parseSvg(text: string): SvgDoc {
  const chunks: string[] = [];
  const paths: PathEl[] = [];
  const re = /<path\b([^>]*?)\/?>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    chunks.push(text.slice(last, m.index));
    const attrs: Record<string, string> = {};
    const a = /([\w:-]+)\s*=\s*"([^"]*)"/g;
    let x: RegExpExecArray | null;
    while ((x = a.exec(m[1]))) attrs[x[1]] = x[2];
    const d = attrs.d ?? '';
    delete attrs.d;
    paths.push({ attrs, subs: parsePathData(d) });
    last = m.index + m[0].length;
  }
  chunks.push(text.slice(last));
  return { chunks, paths };
}

// ------------------------------------------------------------------------------------------------ writing

export function pathData(subs: Sub[]): string {
  const out: string[] = [];
  for (const s of subs) {
    out.push(`M ${fmtPt(s.start)}`);
    for (const g of s.segs) out.push(g.kind === 'L' ? `L ${fmtPt(g.p)}` : `C ${fmtPt(g.c1)} ${fmtPt(g.c2)} ${fmtPt(g.p)}`);
    if (s.closed) out.push('Z');
  }
  return out.join(' ');
}

/** Document → SVG text (the same structure, with the path data written again). */
export function serializeSvg(doc: SvgDoc): string {
  let out = doc.chunks[0] ?? '';
  doc.paths.forEach((p, i) => {
    const attrs = Object.entries(p.attrs).map(([k, v]) => `${k}="${v.replace(/"/g, '&quot;')}"`).join(' ');
    out += `<path${attrs ? ' ' + attrs : ''} d="${pathData(p.subs)}" />`;
    out += doc.chunks[i + 1] ?? '';
  });
  return out;
}

// ------------------------------------------------------------------------------------------------ editing (each returns a new document)

const clone = (d: SvgDoc): SvgDoc => JSON.parse(JSON.stringify(d)) as SvgDoc;
const at = (d: SvgDoc, pi: number, si: number) => d.paths[pi]?.subs[si];
const same = (a: Pt, b: Pt) => Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6;

/** The anchors of a sub-path: index 0 is the start, index n is the end of segment n-1. */
export function anchorsOf(sub: Sub): Pt[] {
  return [sub.start, ...sub.segs.map((g) => g.p)];
}

/** Moves an anchor (its handles move with it). */
export function moveAnchor(d: SvgDoc, pi: number, si: number, ni: number, dx: number, dy: number): SvgDoc {
  const n = clone(d);
  const s = at(n, pi, si);
  if (!s) return d;
  const move = (p: Pt) => { p.x += dx; p.y += dy; };
  if (ni === 0) {
    const wasEnd = s.segs.length > 0 && s.closed && same(s.segs[s.segs.length - 1].p, s.start);
    move(s.start);
    if (wasEnd) move(s.segs[s.segs.length - 1].p);
    const first = s.segs[0];
    if (first && first.kind === 'C') move(first.c1);
  } else {
    const seg = s.segs[ni - 1];
    if (!seg) return d;
    // a closed path whose last anchor sits on its start: the start moves with it
    const closingAnchor = s.closed && ni === s.segs.length && same(seg.p, s.start);
    move(seg.p);
    if (seg.kind === 'C') move(seg.c2);
    const next = s.segs[ni];
    if (next && next.kind === 'C') move(next.c1);
    if (closingAnchor) move(s.start);
  }
  return n;
}

/** Moves one handle of a cubic segment: 'c1' leaves the anchor before it, 'c2' arrives at the anchor after it. */
export function moveHandle(d: SvgDoc, pi: number, si: number, segIndex: number, which: 'c1' | 'c2', dx: number, dy: number): SvgDoc {
  const n = clone(d);
  const seg = at(n, pi, si)?.segs[segIndex];
  if (!seg || seg.kind !== 'C') return d;
  const h = which === 'c1' ? seg.c1 : seg.c2;
  h.x += dx; h.y += dy;
  return n;
}

/** Inserts an anchor in the middle of segment `segIndex` (de Casteljau split for curves: the shape does not change). */
export function insertAnchor(d: SvgDoc, pi: number, si: number, segIndex: number, t = 0.5): SvgDoc {
  const n = clone(d);
  const s = at(n, pi, si);
  if (!s) return d;
  const seg = s.segs[segIndex];
  if (!seg) return d;
  const p0 = segIndex === 0 ? s.start : s.segs[segIndex - 1].p;
  const lerp = (a: Pt, b: Pt): Pt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  if (seg.kind === 'L') {
    const m = lerp(p0, seg.p);
    s.segs.splice(segIndex, 1, { kind: 'L', p: m }, { kind: 'L', p: seg.p });
    return n;
  }
  const a = lerp(p0, seg.c1), b = lerp(seg.c1, seg.c2), c = lerp(seg.c2, seg.p);
  const e = lerp(a, b), f = lerp(b, c), m = lerp(e, f);
  s.segs.splice(segIndex, 1,
    { kind: 'C', c1: a, c2: e, p: m },
    { kind: 'C', c1: f, c2: c, p: seg.p });
  return n;
}

/** Removes an anchor. The segment that arrives at it is removed; the start anchor of an open path takes the next one. */
export function deleteAnchor(d: SvgDoc, pi: number, si: number, ni: number): SvgDoc {
  const n = clone(d);
  const s = at(n, pi, si);
  if (!s) return d;
  if (ni === 0) {
    if (s.segs.length === 0) return d;
    s.start = { ...s.segs[0].p };
    s.segs.splice(0, 1);
    return n;
  }
  if (!s.segs[ni - 1]) return d;
  s.segs.splice(ni - 1, 1);
  return n;
}

/** Deletes a whole path element. */
export function deletePath(d: SvgDoc, pi: number): SvgDoc {
  const n = clone(d);
  if (!n.paths[pi]) return d;
  n.paths.splice(pi, 1);
  n.chunks.splice(pi, 1, (n.chunks[pi] ?? '') + (n.chunks[pi + 1] ?? ''));
  n.chunks.splice(pi + 1, 1);
  return n;
}

const hexOf = (c: string): string => {
  const v = c.trim();
  const rgb = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/i.exec(v);
  if (rgb) return '#' + [rgb[1], rgb[2], rgb[3]].map((x) => Number(x).toString(16).padStart(2, '0')).join('');
  return v.toLowerCase();
};

/** The distinct fill colours with how many paths use each (as #rrggbb), most used first. */
export function colorsOf(d: SvgDoc): { color: string; count: number }[] {
  const m = new Map<string, number>();
  for (const p of d.paths) {
    const c = hexOf(p.attrs.fill ?? '#000000');
    m.set(c, (m.get(c) ?? 0) + 1);
  }
  return [...m.entries()].map(([color, count]) => ({ color, count })).sort((a, b) => b.count - a.count);
}

/** Sets the fill of one path. */
export function setFill(d: SvgDoc, pi: number, color: string): SvgDoc {
  const n = clone(d);
  if (!n.paths[pi]) return d;
  n.paths[pi].attrs.fill = color;
  return n;
}

/** Changes every path of one colour to another (the recolour of a whole drawing). */
export function replaceColor(d: SvgDoc, from: string, to: string): SvgDoc {
  const n = clone(d);
  const f = hexOf(from);
  for (const p of n.paths) if (hexOf(p.attrs.fill ?? '#000000') === f) p.attrs.fill = to;
  return n;
}

// ------------------------------------------------------------------------------------------------ helpers for the editor

export interface Box { x: number; y: number; w: number; h: number }

/** The viewBox of an SVG text; without one, its width and height; null when the root gives neither. */
export function viewBoxOf(text: string): Box | null {
  const root = /<svg\b[^>]*>/i.exec(text)?.[0] ?? '';
  const vb = /\sviewBox="([^"]+)"/i.exec(root);
  if (vb) {
    const n = vb[1].trim().split(/[\s,]+/).map(Number);
    if (n.length === 4 && n.every(Number.isFinite) && n[2] > 0 && n[3] > 0) return { x: n[0], y: n[1], w: n[2], h: n[3] };
  }
  const w = /\swidth="([\d.]+)/i.exec(root), h = /\sheight="([\d.]+)/i.exec(root);
  if (w && h && Number(w[1]) > 0 && Number(h[1]) > 0) return { x: 0, y: 0, w: Number(w[1]), h: Number(h[1]) };
  return null;
}

/** The box around every anchor and handle (used when the SVG gives no size). */
export function boundsOf(d: SvgDoc): Box {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (p: Pt) => { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); };
  for (const p of d.paths) for (const s of p.subs) {
    add(s.start);
    for (const g of s.segs) { add(g.p); if (g.kind === 'C') { add(g.c1); add(g.c2); } }
  }
  if (!Number.isFinite(x0)) return { x: 0, y: 0, w: 100, h: 100 };
  return { x: x0, y: y0, w: Math.max(x1 - x0, 1), h: Math.max(y1 - y0, 1) };
}

/** A document whose root has a viewBox: an SVG without one is given the box around its drawing, so the preview and the editor agree. */
export function withViewBox(d: SvgDoc): SvgDoc {
  if (viewBoxOf(serializeSvg(d))) return d;
  const b = boundsOf(d);
  const n = clone(d);
  n.chunks[0] = (n.chunks[0] ?? '').replace(/<svg\b/i, `<svg viewBox="${b.x} ${b.y} ${b.w} ${b.h}"`);
  return n;
}

/** The middle of segment `segIndex` (where the editor offers a new anchor): the midpoint of a line, or the curve at t = ½. */
export function midOf(sub: Sub, segIndex: number): Pt {
  const p0 = segIndex === 0 ? sub.start : sub.segs[segIndex - 1].p;
  const g = sub.segs[segIndex];
  if (!g) return p0;
  if (g.kind === 'L') return { x: (p0.x + g.p.x) / 2, y: (p0.y + g.p.y) / 2 };
  return {
    x: (p0.x + 3 * g.c1.x + 3 * g.c2.x + g.p.x) / 8,
    y: (p0.y + 3 * g.c1.y + 3 * g.c2.y + g.p.y) / 8,
  };
}

/** A colour as the #rrggbb an colour input takes; a colour it cannot read becomes black. */
export function colorInput(c: string): string {
  const v = hexOf(c);
  if (/^#[0-9a-f]{6}$/.test(v)) return v;
  if (/^#[0-9a-f]{3}$/.test(v)) return '#' + [...v.slice(1)].map((x) => x + x).join('');
  return '#000000';
}
