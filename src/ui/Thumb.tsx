import { useSyncExternalStore } from 'react';
import { ImageOff } from 'lucide-react';
import { db } from '../db/schema';

/**
 * Asset thumbnails are loaded once per asset id and shared: a virtualised grid that mounts 30 fresh rows per frame must
 * not run 30 IndexedDB queries (and create 30 object URLs) per frame.
 */
interface Entry { url?: string; name?: string; missing?: boolean }
const cache = new Map<string, Entry>();
const inflight = new Set<string>();
const subs = new Set<() => void>();
let version = 0;
const bump = () => { version++; subs.forEach((f) => f()); };

function load(id: string): void {
  if (inflight.has(id) || cache.has(id)) return;
  inflight.add(id);
  void (async () => {
    try {
      const row = (await db.assets.get(id)) ?? (await db.assets.where('name').equalsIgnoreCase(id).first());
      cache.set(id, row ? { url: URL.createObjectURL(row.thumb), name: row.name } : { missing: true });
    } catch { cache.set(id, { missing: true }); }
    inflight.delete(id);
    bump();
  })();
}

/** Call after an asset is deleted or replaced so a stale thumbnail is never shown. */
export function dropThumb(id: string): void {
  const e = cache.get(id);
  if (e?.url) URL.revokeObjectURL(e.url);
  cache.delete(id);
  bump();
}

export function AssetThumb({ id, size = 28, className = '' }: { id: string; size?: number; className?: string }) {
  useSyncExternalStore((fn) => { subs.add(fn); return () => subs.delete(fn); }, () => version);
  const isUrl = /^https?:/i.test(id);
  const dim = { width: size, height: size };
  if (!id) return null;
  if (isUrl) return <img className={`thumb ${className}`} style={dim} src={id} alt="" loading="lazy" referrerPolicy="no-referrer" />;
  const e = cache.get(id);
  if (!e) load(id);
  if (!e?.url) return <span className={`thumb ${className}`} style={{ ...dim, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>{e?.missing ? <ImageOff size={Math.max(12, size / 2)} color="#94a3b8" /> : null}</span>;
  return <img className={`thumb ${className}`} style={dim} src={e.url} alt={e.name ?? ''} />;
}
