import ImageTracer from 'imagetracerjs';

/**
 * Asset tools: background removal and image-to-SVG tracing. Both run on this computer (no upload, no model download).
 * The pixel routines are pure, so they can be tested without a browser; the wrappers only move pixels in and out.
 *
 * Background removal is a colour method: the background is taken to be the colour of the image's border (its median),
 * and the connected area of that colour from the border is made transparent, with a soft edge. It works for images with
 * a plain or evenly lit background (product shots on white, logos, icons). It does not separate a subject from a busy
 * background: such images need a dedicated segmentation model, which is not part of this release.
 */

export interface PixelImage { width: number; height: number; data: Uint8ClampedArray }

export { cutoutPixels } from './cutout';
import { cutoutPixels } from './cutout';

/** How the picture is traced: colour areas (flat illustrations, logos), or the ink of a line drawing as outline shapes. */
export type TraceMode = 'areas' | 'line';

/** Trace settings. `detail` trades file size for fidelity; `line` traces only two colours (ink and paper). */
export function traceOptions(detail: 'low' | 'medium' | 'high', mode: TraceMode = 'areas'): Record<string, unknown> {
  const colors = mode === 'line' ? 2 : detail === 'low' ? 6 : detail === 'medium' ? 12 : 24;
  return { ltres: 1, qtres: 1, pathomit: detail === 'high' ? 4 : 12, colorsampling: 0, numberofcolors: colors, mincolorratio: 0, colorquantcycles: 3, roundcoords: 1, scale: 1, blurradius: 0, strokewidth: 0, viewbox: true, desc: false };
}

/**
 * The pixels with a hard edge: transparent below half opacity, opaque above. A soft anti-aliased rim would otherwise be traced
 * as extra grey layers, which only clutter the drawing.
 */
export function hardenAlpha(img: PixelImage): PixelImage {
  const data = new Uint8ClampedArray(img.data);
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) { data[i + 3] = 0; } else { data[i + 3] = 255; }
  }
  return { width: img.width, height: img.height, data };
}

/**
 * Cleans the tracer's output so that it edits well: no invisible layers (the tracer adds one for the transparent area), no
 * outline strokes (a stroke keeps the old colour when a shape is recoloured), and for line art only the dark ink is kept.
 */
export function cleanTrace(svg: string, mode: TraceMode = 'areas'): string {
  const paths = svg.match(/<path\b[^>]*\/>/g) ?? [];
  let out = svg;
  for (const p of paths) {
    const fill = /\sfill="rgb\((\d+),\s*(\d+),\s*(\d+)\)"/.exec(p);
    const invisible = /\sopacity="0(\.0+)?"/.test(p) || /\sfill-opacity="0(\.0+)?"/.test(p);
    const light = fill ? (Number(fill[1]) + Number(fill[2]) + Number(fill[3])) / 3 > 200 : false;
    let next = p.replace(/\sstroke(?:-width)?="[^"]*"/g, '');
    if (invisible || (mode === 'line' && light)) next = '';
    out = out.replace(p, next);
  }
  return out.replace(/\n\s*\n/g, '\n');
}

/** Traces the pixels to SVG code (editable: it is plain text). */
export function traceToSvg(img: PixelImage, detail: 'low' | 'medium' | 'high' = 'medium', mode: TraceMode = 'areas'): string {
  const hard = hardenAlpha(img);
  const raw = ImageTracer.imagedataToSVG({ width: hard.width, height: hard.height, data: hard.data }, traceOptions(detail, mode));
  return cleanTrace(raw, mode);
}

// ------------------------------------------------------------------------------------------------ browser wrappers

/** The pixels of an image, scaled down so its longest side is at most `maxSide`. */
export async function pixelsOf(blob: Blob, maxSide: number): Promise<PixelImage> {
  const bm = await createImageBitmap(blob);
  const s = Math.min(1, maxSide / Math.max(bm.width, bm.height));
  const w = Math.max(1, Math.round(bm.width * s));
  const h = Math.max(1, Math.round(bm.height * s));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser cannot read the image pixels.');
  ctx.drawImage(bm, 0, 0, w, h);
  bm.close();
  const data = ctx.getImageData(0, 0, w, h);
  return { width: w, height: h, data: data.data };
}

/** A PNG with the background made transparent. `enclosed`: also the background-coloured areas inside the outline (line art). */
export async function removeBackground(blob: Blob, tolerance = 40, enclosed = false): Promise<{ blob: Blob; width: number; height: number }> {
  const img = await pixelsOf(blob, 2048);
  const out = cutoutPixels(img.data, img.width, img.height, tolerance, enclosed);
  const canvas = new OffscreenCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser cannot draw the cut-out.');
  // ImageData needs an array over a plain ArrayBuffer (not a shared one)
  const pixels = new Uint8ClampedArray(new ArrayBuffer(out.byteLength));
  pixels.set(out);
  ctx.putImageData(new ImageData(pixels, img.width, img.height), 0, 0);
  return { blob: await canvas.convertToBlob({ type: 'image/png' }), width: img.width, height: img.height };
}

/** The cut-out at a small size, for the preview of the Remove background dialog (quick enough to redo on every change). */
export async function cutoutPreview(blob: Blob, tolerance: number, enclosed: boolean): Promise<Blob> {
  const img = await pixelsOf(blob, 360);
  const out = cutoutPixels(img.data, img.width, img.height, tolerance, enclosed);
  const canvas = new OffscreenCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser cannot draw the preview.');
  const pixels = new Uint8ClampedArray(new ArrayBuffer(out.byteLength));
  pixels.set(out);
  ctx.putImageData(new ImageData(pixels, img.width, img.height), 0, 0);
  return canvas.convertToBlob({ type: 'image/png' });
}

/** The SVG of an image (traced at most 1024 px wide, so a large photo stays quick). */
export async function traceImageToSvg(blob: Blob, detail: 'low' | 'medium' | 'high', mode: TraceMode = 'areas'): Promise<{ svg: string; width: number; height: number }> {
  const img = await pixelsOf(blob, 1024);
  return { svg: traceToSvg(img, detail, mode), width: img.width, height: img.height };
}
