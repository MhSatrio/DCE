import type { ImageLike } from '../engine/scene';
import type { ImageProvider } from '../engine/render';
import { db } from './schema';

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

/** Asset reference → stored Blob (by id, then by file name). */
export async function assetBlobFor(ref: string): Promise<Blob | null> {
  if (blobCache.has(ref)) { const b = blobCache.get(ref)!; lru(blobCache, ref, b, 64); return b; }
  let row = await db.assets.get(ref);
  if (!row) row = await db.assets.where('name').equalsIgnoreCase(ref).first();
  const blob = row?.blob ?? null;
  lru(blobCache, ref, blob, 64);
  return blob;
}

/** Main-thread provider: previews, thumbnails, editor. Remote URLs are fetched with CORS. */
export const mainProvider: ImageProvider = {
  async load(refs) {
    const out = new Map<string, ImageLike | null>();
    await Promise.all(refs.map(async (ref) => {
      if (bitmapCache.has(ref)) { const b = bitmapCache.get(ref)!; lru(bitmapCache, ref, b, 48); out.set(ref, b); return; }
      let bm: ImageBitmap | null = null;
      try {
        let blob: Blob | null;
        if (isUrl(ref)) { const r = await fetch(ref); blob = r.ok ? await r.blob() : null; } else blob = await assetBlobFor(ref);
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
