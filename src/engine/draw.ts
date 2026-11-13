import { fontString } from './textfit';
import type { ImageFit } from './types';
import type { Item, ImageLike, Scene } from './scene';

type Ctx = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

const ink = '#231F20';

export function polygonPoints(w: number, h: number, sides: number): [number, number][] {
  const pts: [number, number][] = [];
  for (let i = 0; i < sides; i++) {
    const a = -Math.PI / 2 + (2 * Math.PI * i) / sides;
    pts.push([w / 2 + (w / 2) * Math.cos(a), h / 2 + (h / 2) * Math.sin(a)]);
  }
  return pts;
}

export function starPoints(w: number, h: number, points: number, inner: number): [number, number][] {
  const pts: [number, number][] = [];
  for (let i = 0; i < points * 2; i++) {
    const a = -Math.PI / 2 + (Math.PI * i) / points;
    const r = i % 2 === 0 ? 1 : inner;
    pts.push([w / 2 + (w / 2) * r * Math.cos(a), h / 2 + (h / 2) * r * Math.sin(a)]);
  }
  return pts;
}

/** SVG path data for a Bézier path node, in the node's local box. Shared by canvas (Path2D) and SVG export. */
export function pathD(it: Pick<Item, 'path' | 'w' | 'h'>): string {
  const pts = it.path?.points ?? [];
  if (pts.length < 2) return '';
  const hs = it.path?.handles ?? [];
  const r = (v: number) => Math.round(v * 1000) / 1000;
  const A = (i: number) => `${r(pts[i][0] * it.w)} ${r(pts[i][1] * it.h)}`;
  const OUT = (i: number) => (hs[i] ? `${r(hs[i]![2] * it.w)} ${r(hs[i]![3] * it.h)}` : A(i));
  const IN = (i: number) => (hs[i] ? `${r(hs[i]![0] * it.w)} ${r(hs[i]![1] * it.h)}` : A(i));
  const closed = !!it.path?.closed;
  let d = `M${A(0)}`;
  const segs = closed ? pts.length : pts.length - 1;
  for (let i = 0; i < segs; i++) {
    const j = (i + 1) % pts.length;
    d += hs[i] || hs[j] ? `C${OUT(i)} ${IN(j)} ${A(j)}` : `L${A(j)}`;
  }
  return closed ? d + 'Z' : d;
}

export function pathPoints(it: Pick<Item, 'path' | 'w' | 'h'>): [number, number][] {
  return (it.path?.points ?? []).map(([x, y]) => [x * it.w, y * it.h] as [number, number]);
}

/** Geometry of a fitted image inside its frame (shared by canvas and SVG output). */
export function imageRect(
  iw: number, ih: number, w: number, h: number, fit: ImageFit, fx: number, fy: number,
): { dx: number; dy: number; dw: number; dh: number } {
  switch (fit) {
    case 'fill': return { dx: 0, dy: 0, dw: w, dh: h };
    case 'contain': {
      const s = Math.min(w / iw, h / ih);
      return { dx: (w - iw * s) / 2, dy: (h - ih * s) / 2, dw: iw * s, dh: ih * s };
    }
    case 'crop': return { dx: (w - iw) * fx, dy: (h - ih) * fy, dw: iw, dh: ih };
    case 'cover':
    default: {
      const s = Math.max(w / iw, h / ih);
      const dw = iw * s, dh = ih * s;
      return { dx: (w - dw) * fx, dy: (h - dh) * fy, dw, dh };
    }
  }
}

function setFill(ctx: Ctx, color: string): void {
  ctx.fillStyle = '#000';
  ctx.fillStyle = color;
}
function setStroke(ctx: Ctx, color: string): void {
  ctx.strokeStyle = '#000';
  ctx.strokeStyle = color;
}

function buildShape(ctx: Ctx, it: Item): void {
  const { w, h } = it;
  ctx.beginPath();
  switch (it.kind) {
    case 'rect':
    case 'image': {
      const r = Math.min(it.radius, w / 2, h / 2);
      if (r > 0) ctx.roundRect(0, 0, w, h, r); else ctx.rect(0, 0, w, h);
      break;
    }
    case 'ellipse':
      ctx.ellipse(w / 2, h / 2, Math.max(w / 2, 0), Math.max(h / 2, 0), 0, 0, Math.PI * 2);
      break;
    case 'polygon':
    case 'star':
    case 'path': {
      const pts = it.kind === 'polygon' ? polygonPoints(w, h, it.sides)
        : it.kind === 'star' ? starPoints(w, h, it.points, it.innerRatio) : pathPoints(it);
      pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
      if (it.kind !== 'path' || it.path?.closed) ctx.closePath();
      break;
    }
  }
}

function drawImageFit(ctx: Ctx, it: Item): void {
  const im = it.image!;
  ctx.save();
  buildShape(ctx, it);
  ctx.clip();
  if (im.bitmap) {
    const bm = im.bitmap as ImageLike;
    const iw = (bm as { width: number }).width, ih = (bm as { height: number }).height;
    if (iw > 0 && ih > 0) {
      const r = imageRect(iw, ih, it.w, it.h, im.fit, im.focalX, im.focalY);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bm as CanvasImageSource, r.dx, r.dy, r.dw, r.dh);
    }
  } else {
    setFill(ctx, '#E8EDF3');
    ctx.fillRect(0, 0, it.w, it.h);
    setStroke(ctx, '#B7C4D6');
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = -it.h; x < it.w; x += 24) { ctx.moveTo(x, it.h); ctx.lineTo(x + it.h, 0); }
    ctx.stroke();
    const size = Math.max(10, Math.min(16, it.w / 8));
    ctx.font = `500 ${size}px Jost, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    setFill(ctx, '#64748B');
    ctx.fillText(im.label, it.w / 2, it.h / 2, Math.max(10, it.w - 12));
  }
  ctx.restore();
  if (it.stroke && it.strokeWidth > 0) {
    setStroke(ctx, it.stroke);
    ctx.lineWidth = it.strokeWidth;
    buildShape(ctx, it);
    ctx.stroke();
  }
}

function drawText(ctx: Ctx, it: Item): void {
  const t = it.text!;
  const L = t.layout;
  if (!L.lines.length) return;
  ctx.font = fontString(t.font, L.fontSize);
  (ctx as { letterSpacing?: string }).letterSpacing = `${t.font.letterSpacing}px`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = t.align;
  setFill(ctx, t.color);
  const innerH = it.h - t.padding * 2;
  const y0 = t.padding + (t.vAlign === 'top' ? 0 : t.vAlign === 'middle' ? (innerH - L.contentHeight) / 2 : innerH - L.contentHeight);
  const x = t.align === 'left' ? t.padding : t.align === 'center' ? it.w / 2 : it.w - t.padding;
  L.lines.forEach((line, i) => {
    const y = y0 + i * L.lineHeightPx + L.lineHeightPx / 2;
    ctx.fillText(line, x, y);
    if (t.decoration !== 'none' && line) {
      const wLine = ctx.measureText(line).width;
      const x0 = t.align === 'left' ? x : t.align === 'center' ? x - wLine / 2 : x - wLine;
      const dy = t.decoration === 'underline' ? L.fontSize * 0.42 : 0;
      ctx.fillRect(x0, y + dy - L.fontSize / 28, wLine, Math.max(1, L.fontSize / 14));
    }
  });
  (ctx as { letterSpacing?: string }).letterSpacing = '0px';
}

/** Draws an item inside its own box (origin = box top-left). No transform applied. */
export function drawItemLocal(ctx: Ctx, it: Item): void {
  switch (it.kind) {
    case 'text': drawText(ctx, it); return;
    case 'image': drawImageFit(ctx, it); return;
    case 'plugin': it.custom?.draw(ctx, it.w, it.h); return;
    case 'line': {
      if (!it.stroke) return;
      setStroke(ctx, it.stroke);
      ctx.lineWidth = it.strokeWidth;
      ctx.lineCap = 'butt';
      ctx.setLineDash(it.dash ?? []);
      ctx.beginPath(); ctx.moveTo(0, it.h / 2); ctx.lineTo(it.w, it.h / 2); ctx.stroke();
      ctx.setLineDash([]);
      return;
    }
    case 'path': {
      const d = pathD(it);
      if (!d) return;
      const path = new Path2D(d);
      if (it.fill && it.path?.closed) { setFill(ctx, it.fill); ctx.fill(path); }
      if (it.stroke && it.strokeWidth > 0) {
        setStroke(ctx, it.stroke);
        ctx.lineWidth = it.strokeWidth; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
        ctx.setLineDash(it.dash ?? []);
        ctx.stroke(path);
        ctx.setLineDash([]);
      }
      return;
    }
    default: {
      buildShape(ctx, it);
      if (it.fill) { setFill(ctx, it.fill); ctx.fill(); }
      if (it.stroke && it.strokeWidth > 0) {
        setStroke(ctx, it.stroke);
        ctx.lineWidth = it.strokeWidth;
        ctx.lineJoin = 'round';
        ctx.setLineDash(it.dash ?? []);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
  }
}

export function drawItem(ctx: Ctx, it: Item): void {
  ctx.save();
  ctx.translate(it.cx, it.cy);
  if (it.rotation) ctx.rotate((it.rotation * Math.PI) / 180);
  ctx.translate(-it.w / 2, -it.h / 2);
  ctx.globalAlpha = Math.max(0, Math.min(1, it.opacity));
  drawItemLocal(ctx, it);
  ctx.restore();
}

/** Draws the full scene at the current ctx transform (caller applies output scaling). */
export function drawScene(ctx: Ctx, scene: Scene): void {
  if (scene.background) {
    setFill(ctx, scene.background);
    ctx.fillRect(0, 0, scene.width, scene.height);
  }
  for (const it of scene.items) drawItem(ctx, it);
}

export { ink };
