import { drawScene } from './draw';
import { bytesToBase64 } from './fonts';
import { buildScene, collectImageRefs, type ImageLike, type Item, type Scene } from './scene';
import { sceneToSvg } from './svg';
import type { Issue, NjsDoc, RenderData } from './types';

export type RasterFormat = 'png' | 'jpeg';
export type EngineFormat = RasterFormat | 'svg' | 'html';

export interface ImageProvider {
  /** Loads decoded images for normalised references. Failures must resolve to null, never reject. */
  load(refs: string[]): Promise<Map<string, ImageLike | null>>;
}

export interface RenderOptions {
  format: EngineFormat;
  outW?: number;
  outH?: number;
  quality?: number;      // jpeg 0..1
  transparent?: boolean; // png only
  fontCss?: string;      // embedded in svg / html
  /** When true (batch), any error-level issue aborts the record instead of producing output. */
  failOnError?: boolean;
}

export interface RenderOutput {
  bytes: Uint8Array;
  mime: string;
  ext: string;
  width: number;
  height: number;
  issues: Issue[];
}

export class RenderFailure extends Error {
  constructor(public issues: Issue[]) {
    super(issues.filter((i) => i.level === 'error').map((i) => (i.nodeName ? `${i.nodeName}: ` : '') + i.message).join(' | ') || 'Render failed');
  }
}

const MIME = { png: 'image/png', jpeg: 'image/jpeg', svg: 'image/svg+xml', html: 'text/html' } as const;
const EXT = { png: 'png', jpeg: 'jpg', svg: 'svg', html: 'html' } as const;

let shared: OffscreenCanvas | null = null;
function getCanvas(w: number, h: number): OffscreenCanvas {
  if (!shared || shared.width !== w || shared.height !== h) shared = new OffscreenCanvas(w, h);
  return shared;
}
export function releaseCanvas(): void { shared = null; }

export function outputSize(doc: NjsDoc, outW?: number, outH?: number): { w: number; h: number; scale: number; ox: number; oy: number } {
  const W = doc.canvas.width, H = doc.canvas.height;
  let w = Math.round(outW && outW > 0 ? outW : W);
  let h = Math.round(outH && outH > 0 ? outH : outW && outW > 0 ? (H * outW) / W : H);
  w = Math.max(1, Math.min(w, 8192)); h = Math.max(1, Math.min(h, 8192));
  if (w * h > 64_000_000) throw new Error(`Output ${w}×${h} is too large (limit 64 megapixels).`);
  const scale = Math.min(w / W, h / H);
  return { w, h, scale, ox: (w - W * scale) / 2, oy: (h - H * scale) / 2 };
}

export async function loadScene(doc: NjsDoc, data: RenderData | null, provider: ImageProvider): Promise<Scene> {
  const refs = collectImageRefs(doc, data);
  const images = await provider.load(refs.primary);
  const needFallback = refs.pairs.some((p) => p.fallback && (!p.primary || !images.get(p.primary)));
  if (needFallback) {
    const more = refs.fallback.filter((r) => !images.has(r));
    if (more.length) for (const [k, v] of await provider.load(more)) images.set(k, v);
  }
  return buildScene(doc, data, { images });
}

export function paintScene(scene: Scene, doc: NjsDoc, opts: Pick<RenderOptions, 'outW' | 'outH' | 'transparent' | 'format'>): OffscreenCanvas {
  const sz = outputSize(doc, opts.outW, opts.outH);
  const canvas = getCanvas(sz.w, sz.h);
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, sz.w, sz.h);
  if (opts.format === 'jpeg') { // JPEG has no alpha: flatten onto white
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, sz.w, sz.h);
  }
  ctx.setTransform(sz.scale, 0, 0, sz.scale, sz.ox, sz.oy);
  drawScene(ctx, opts.format === 'png' && opts.transparent ? { ...scene, background: null } : scene);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return canvas;
}

async function canvasBytes(c: OffscreenCanvas, type: string, quality?: number): Promise<Uint8Array> {
  const blob = await c.convertToBlob({ type, quality });
  return new Uint8Array(await blob.arrayBuffer());
}

/** Re-encodes a bitmap at ≤ 2× its on-canvas size so SVG/HTML files do not embed oversized rasters. */
async function bitmapDataUri(bm: ImageLike, it: Item): Promise<string> {
  const bw = (bm as { width: number }).width, bh = (bm as { height: number }).height;
  const s = Math.min(1, (Math.max(it.w, 1) * 2) / bw, (Math.max(it.h, 1) * 2) / bh);
  const w = Math.max(1, Math.round(bw * Math.max(s, 0.01))), h = Math.max(1, Math.round(bh * Math.max(s, 0.01)));
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bm as CanvasImageSource, 0, 0, w, h);
  const bytes = await canvasBytes(c, 'image/png');
  return `data:image/png;base64,${bytesToBase64(bytes)}`;
}

export async function renderScene(doc: NjsDoc, scene: Scene, opts: RenderOptions): Promise<RenderOutput> {
  const errors = scene.issues.filter((i) => i.level === 'error');
  if (errors.length && opts.failOnError) throw new RenderFailure(scene.issues);
  const sz = outputSize(doc, opts.outW, opts.outH);

  if (opts.format === 'svg' || opts.format === 'html') {
    const uris = new Map<string, string>();
    for (const it of scene.items) {
      if (it.kind === 'image' && it.image?.bitmap) uris.set(it.id, await bitmapDataUri(it.image.bitmap, it));
    }
    const svg = sceneToSvg(
      { ...scene },
      { fontCss: opts.fontCss, imageUri: (it) => uris.get(it.id) ?? null },
    ).replace(/width="[\d.]+" height="[\d.]+" viewBox/, `width="${sz.w}" height="${sz.h}" viewBox`);
    const text = opts.format === 'html'
      ? `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>${doc.meta.name.replace(/</g, '&lt;')}</title><style>html,body{margin:0;background:#F6F8FA}body{display:grid;place-items:center;min-height:100vh}svg{max-width:100%;height:auto;box-shadow:0 1px 8px rgba(35,31,32,.15)}</style></head><body>${svg.replace(/^<\?xml[^>]*>\s*/, '')}</body></html>`
      : svg;
    return { bytes: new TextEncoder().encode(text), mime: MIME[opts.format], ext: EXT[opts.format], width: sz.w, height: sz.h, issues: scene.issues };
  }

  const canvas = paintScene(scene, doc, opts);
  const type = MIME[opts.format];
  const bytes = await canvasBytes(canvas, type, opts.format === 'jpeg' ? (opts.quality ?? 0.92) : undefined);
  return { bytes, mime: type, ext: EXT[opts.format], width: sz.w, height: sz.h, issues: scene.issues };
}

/** The one entry point used by the batch worker, previews and thumbnails. */
export async function renderDoc(doc: NjsDoc, data: RenderData | null, provider: ImageProvider, opts: RenderOptions): Promise<RenderOutput> {
  const scene = await loadScene(doc, data, provider);
  return renderScene(doc, scene, opts);
}
