/**
 * SVG to PNG, on this computer. Templates and the batch renderer draw raster pixels, so an SVG asset keeps a PNG of
 * itself next to the SVG text (regenerated whenever the SVG changes).
 */
export async function rasterizeSvg(blob: Blob): Promise<Blob> {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error('SVG could not be decoded')); img.src = url; });
    let w = img.naturalWidth || 512, h = img.naturalHeight || 512;
    const s = Math.min(4, 2048 / Math.max(w, h));
    w = Math.max(1, Math.round(w * s)); h = Math.max(1, Math.round(h * s));
    const c = new OffscreenCanvas(w, h);
    c.getContext('2d')!.drawImage(img, 0, 0, w, h);
    return await c.convertToBlob({ type: 'image/png' });
  } finally { URL.revokeObjectURL(url); }
}
