import { CUTOUT_TOLERANCE, cutoutBaseRef, isCutoutRef, type ImageLike } from '../engine/scene';
import { removeBackground } from '../assets/tools';
import type { ImageProvider } from '../engine/render';
import { db, type AssetRow } from './schema';
import { rasterizeSvg } from './svgraster';
import { remoteImage } from './remote';

const isUrl = (r: string) => /^(https?:|data:|blob:)/i.test(r);
export const isRemoteRef = isUrl;

const blobCache = new Map<string, Blob | null>();
const bitmapCache = new Map<string, ImageBitmap | null>();

function lru<V>(m: Map<string, V>, key: string, v: V, max: number): void {
  m.delete(key); m.set(key, v);
  while (m.size > max) {
    const first = m.keys().next().value as string;
    const ev = m.get(first);
    const c = (ev as unknown as { close?: () => void } | null)?.close; if (typeof c === "function") c.call(ev);
    m.delete(first);
  }
}

export function clearImageCaches(): void {
  blobCache.clear();
  for (const b of bitmapCache.values()) b?.close();
  bitmapCache.clear();
}

/**
 * What a template draws for an asset: the file itself, or for an SVG its PNG (an SVG stored before PNGs existed gets one now).
 */
async function drawableOf(row: AssetRow): Promise<Blob | null> {
  if (row.mime !== 'image/svg+xml') return row.blob ?? null;
  if (row.raster) return row.raster;
  const raster = await rasterizeSvg(row.blob);
  await db.assets.update(row.id, { raster });
  return raster;
}

/** Asset reference → the Blob to draw (by id, then by file name). */
export async function assetBlobFor(ref: string): Promise<Blob | null> {
  if (blobCache.has(ref)) { const b = blobCache.get(ref)!; lru(blobCache, ref, b, 64); return b; }
  let row = await db.assets.get(ref);
  if (!row) row = await db.assets.where('name').equalsIgnoreCase(ref).first();
  const blob = row ? await drawableOf(row) : null;
  lru(blobCache, ref, blob, 64);
  return blob;
}

/** The file behind a reference: a web address (through the remote loader), or an uploaded asset. */
export async function sourceBlob(ref: string): Promise<Blob | null> {
  if (isUrl(ref)) { const r = await remoteImage(ref); return r.ok ? r.blob : null; }
  return assetBlobFor(ref);
}

/** Main-thread provider: previews, thumbnails, editor. Remote URLs are downloaded (directly, or through the local helper). */
export const mainProvider: ImageProvider = {
  async load(refs) {
    const out = new Map<string, ImageLike | null>();
    await Promise.all(refs.map(async (ref) => {
      if (bitmapCache.has(ref)) { const b = bitmapCache.get(ref)!; lru(bitmapCache, ref, b, 48); out.set(ref, b); return; }
      let bm: ImageBitmap | null = null;
      try {
        let blob = await sourceBlob(cutoutBaseRef(ref));
        if (blob && isCutoutRef(ref)) blob = (await removeBackground(blob, CUTOUT_TOLERANCE)).blob;
        bm = blob ? await createImageBitmap(blob) : null;
      } catch { bm = null; }
      if (bm) lru(bitmapCache, ref, bm, 48);
      out.set(ref, bm);
    }));
    return out;
  },
};

export async function assetIndex(): Promise<{ byId: Map<string, string>; byName: Map<string, string> }> {
  const rows = await db.assets.toCollection().primaryKeys();
  const names = await db.assets.toCollection().toArray().then((a) => a.map((x) => [x.name.toLowerCase(), x.id] as const));
  return { byId: new Map(rows.map((k) => [k as string, k as string])), byName: new Map(names) };
}
