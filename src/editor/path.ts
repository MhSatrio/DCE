import type { DceNode } from '../engine/types';

/**
 * Bézier path geometry. A path node stores anchors and optional handles NORMALISED to its box (0..1):
 *   path.points  = [[x,y], …]                       anchors
 *   path.handles = [[inX,inY,outX,outY] | null, …]  per anchor; null = corner (straight)
 * The editor works in scene ("world") coordinates and converts back with `fromWorld`, which also refits the box.
 */
export type P = [number, number];
export interface WHandle { inn: P; out: P }
export interface WorldPath { a: P[]; h: (WHandle | null)[]; closed: boolean }

export function toWorld(n: DceNode): WorldPath {
  const pts = n.path?.points ?? [];
  const hs = n.path?.handles ?? [];
  const cx = n.x + n.width / 2, cy = n.y + n.height / 2;
  const rad = ((n.rotation || 0) * Math.PI) / 180, c = Math.cos(rad), s = Math.sin(rad);
  // normalised → local box → rotate about the centre → world
  const w = (p: P): P => {
    const lx = p[0] * n.width - n.width / 2, ly = p[1] * n.height - n.height / 2;
    return [cx + lx * c - ly * s, cy + lx * s + ly * c];
  };
  return {
    a: pts.map(w),
    h: pts.map((_, i) => { const x = hs[i]; return x ? { inn: w([x[0], x[1]]), out: w([x[2], x[3]]) } : null; }),
    closed: !!n.path?.closed,
  };
}

/** Writes world geometry back into the node: rotation is baked in (set to 0) and the box is refitted to anchors + handles. */
export function fromWorld(n: DceNode, wp: WorldPath): void {
  const xs: number[] = [], ys: number[] = [];
  wp.a.forEach((p, i) => {
    xs.push(p[0]); ys.push(p[1]);
    const h = wp.h[i];
    if (h) { xs.push(h.inn[0], h.out[0]); ys.push(h.inn[1], h.out[1]); }
  });
  const x = Math.min(...xs), y = Math.min(...ys);
  const w = Math.max(1, Math.max(...xs) - x), h = Math.max(1, Math.max(...ys) - y);
  const nz = (p: P): P => [(p[0] - x) / w, (p[1] - y) / h];
  n.x = round(x); n.y = round(y); n.width = round(w); n.height = round(h); n.rotation = 0;
  const handles = wp.h.map((hh) => (hh ? ([...nz(hh.inn), ...nz(hh.out)] as [number, number, number, number]) : null));
  n.path = { points: wp.a.map(nz), closed: wp.closed, ...(handles.some(Boolean) ? { handles } : {}) };
}
const round = (v: number) => Math.round(v * 100) / 100;

const sub = (a: P, b: P): P => [a[0] - b[0], a[1] - b[1]];
const add = (a: P, b: P): P => [a[0] + b[0], a[1] + b[1]];
const mul = (a: P, k: number): P => [a[0] * k, a[1] * k];
const mid = (a: P, b: P): P => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
const dist = (a: P, b: P) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Smooth handles for anchor i (Catmull-Rom style tangent through the neighbours). */
export function autoHandle(wp: WorldPath, i: number): WHandle {
  const n = wp.a.length;
  const prev = wp.a[i - 1] ?? (wp.closed ? wp.a[n - 1] : undefined);
  const next = wp.a[i + 1] ?? (wp.closed ? wp.a[0] : undefined);
  const p = wp.a[i];
  let t: P;
  if (prev && next) t = mul(sub(next, prev), 1 / 6);
  else if (next) t = mul(sub(next, p), 1 / 3);
  else if (prev) t = mul(sub(p, prev), 1 / 3);
  else t = [0, 0];
  return { inn: sub(p, t), out: add(p, t) };
}

export function smoothAll(wp: WorldPath): WorldPath {
  return { ...wp, h: wp.a.map((_, i) => autoHandle(wp, i)) };
}
export function cornerAll(wp: WorldPath): WorldPath {
  return { ...wp, h: wp.a.map(() => null) };
}

export function segmentCount(wp: WorldPath): number { return wp.closed ? wp.a.length : wp.a.length - 1; }

function ctrl(wp: WorldPath, i: number): [P, P, P, P] {
  const j = (i + 1) % wp.a.length;
  return [wp.a[i], wp.h[i]?.out ?? wp.a[i], wp.h[j]?.inn ?? wp.a[j], wp.a[j]];
}

export function bezierAt(p0: P, p1: P, p2: P, p3: P, t: number): P {
  const u = 1 - t;
  return [
    u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
    u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
  ];
}

/** Closest point of the path to `pt` (sampled): which segment, parameter t, distance. */
export function nearestOnPath(wp: WorldPath, pt: P): { seg: number; t: number; dist: number; point: P } | null {
  let best: { seg: number; t: number; dist: number; point: P } | null = null;
  for (let s = 0; s < segmentCount(wp); s++) {
    const [p0, p1, p2, p3] = ctrl(wp, s);
    for (let k = 0; k <= 32; k++) {
      const t = k / 32, q = bezierAt(p0, p1, p2, p3, t), d = dist(q, pt);
      if (!best || d < best.dist) best = { seg: s, t, dist: d, point: q };
    }
  }
  return best;
}

/** Inserts an anchor at parameter t of segment `seg` without changing the curve (de Casteljau split). */
export function splitSegment(wp: WorldPath, seg: number, t: number): { wp: WorldPath; index: number } {
  const [p0, p1, p2, p3] = ctrl(wp, seg);
  const lerp = (a: P, b: P): P => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  const a01 = lerp(p0, p1), a12 = lerp(p1, p2), a23 = lerp(p2, p3);
  const b = lerp(a01, a12), c = lerp(a12, a23), m = lerp(b, c);
  const a = wp.a.slice(), h = wp.h.slice();
  const j = (seg + 1) % wp.a.length;
  const curved = !!(wp.h[seg] || wp.h[j]);
  const idx = seg + 1;
  a.splice(idx, 0, m);
  h.splice(idx, 0, curved ? { inn: b, out: c } : null);
  if (curved) {
    // the neighbours' facing handles shrink to the left / right sub-curves
    if (h[seg]) h[seg] = { inn: h[seg]!.inn, out: a01 };
    else h[seg] = { inn: a[seg], out: a01 };
    const nj = idx + 1 >= a.length ? 0 : idx + 1;
    if (h[nj]) h[nj] = { inn: a23, out: h[nj]!.out }; else h[nj] = { inn: a23, out: a[nj] };
  }
  return { wp: { ...wp, a, h }, index: idx };
}

export function removeAnchor(wp: WorldPath, i: number): WorldPath {
  const a = wp.a.slice(), h = wp.h.slice();
  a.splice(i, 1); h.splice(i, 1);
  return { ...wp, a, h };
}

export { mid as midpoint, dist as distance };
