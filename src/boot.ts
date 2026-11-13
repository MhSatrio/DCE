import { db } from './db/schema';
import { loadRecords } from './db/repo';
import { ensureSeeded } from './db/seed';
import { encryptLegacy } from './db/connections';
import { ensureJost, registerFontData } from './engine/fonts';

/** Loads fonts, seeds the first-run workspace, restores custom fonts, flags jobs left running by a reload. */
export async function boot(): Promise<void> {
  await ensureJost().catch(() => undefined);
  await db.open();
  await ensureSeeded();
  await loadRecords();
  await encryptLegacy().catch(() => undefined);
  try {
    for (const f of await db.fonts.toArray()) await registerFontData({ family: f.family, weight: f.weight, style: f.style, data: await f.blob.arrayBuffer() });
  } catch { /* a broken custom font must not block startup */ }
  await db.jobs.where('status').anyOf('running', 'paused').modify({ status: 'interrupted', completed_at: Date.now() }).catch(() => undefined);
}
