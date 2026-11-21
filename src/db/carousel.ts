import { getValue } from './fields';
import { assetAddress, db, type CarouselSpec, type ContentRecord, type TableDef } from './schema';
import { allTables, createTable, deleteRows, fieldsOf, loadTables, masterKeyOf, newRow, onTableWritten, recordsOf, saveFieldIn, writeRows } from './tables';
import { tablesStore } from './stores';
import { uid } from '../engine/njs';
import { byPosition } from './order';
import { coalesce } from './coalesce';
import { notify } from '../ui/store';

/**
 * Carousel tables. A carousel table is an independent table: one record per group of consecutive images of its source
 * table, with its own Master Field ("Carousel 1", …), its own custom fields, and a "Carousel" field holding the image
 * URLs, comma separated (ready for Buffer). The source table only gets two fields: "Carousel Page" (a link to the carousel
 * record its image belongs to; shown as "Page N of <that carousel's Master Field>") and "Page number".
 *
 * Everything is derived from the source: the group of an image depends only on the order of the source records that have
 * a URL. Carousel records keep their id per group, so repeated syncs never duplicate them, and custom fields survive.
 */

export const CAROUSEL_FIELD = 'carousel_page';      // on the source table: link to the carousel record
export const CAROUSEL_NO = 'carousel_page_no';      // on the source table: page number inside that carousel
export const CAROUSEL_URLS = 'carousel';            // on the carousel table: image URLs, comma separated
export const CAROUSEL_COUNT = 'images';             // on the carousel table: how many images it holds
export const MAX_GROUP = 50;

export interface CarouselGroup { id: string; index: number; urls: string[]; members: string[] }
export interface CarouselPlan { groups: CarouselGroup[]; pages: Map<string, { groupId: string; page: number }> }

/** The id of group `index` (1-based) of a carousel table: the same group keeps the same record. */
export const carouselGroupId = (carouselId: string, index: number): string => `${carouselId}:${index}`;

/**
 * Pure. Groups the source records (in their order) into carousels of `groupSize` slides. A record without a URL is part
 * of no carousel. The last group may be shorter when the count is not a multiple of the size.
 * With a `closingUrl` (and a size of at least 2) the last slide of every carousel is that URL: each carousel then holds
 * groupSize − 1 images of the table followed by it, and the closing slide is not counted as a page of the source.
 */
export function planCarousel(records: ContentRecord[], linkField: string, groupSize: number, carouselId: string, closingUrl?: string): CarouselPlan {
  const size = Math.min(MAX_GROUP, Math.max(1, Math.floor(groupSize) || 1));
  const closing = closingUrl?.trim() && size >= 2 ? closingUrl.trim() : undefined;
  const per = closing ? size - 1 : size;
  const withUrl = records
    .map((r) => ({ r, url: String(getValue(r, linkField) ?? '').trim() }))
    .filter((x) => x.url !== '');
  const groups: CarouselGroup[] = [];
  const pages = new Map<string, { groupId: string; page: number }>();
  for (let i = 0; i < withUrl.length; i += per) {
    const chunk = withUrl.slice(i, i + per);
    const index = groups.length + 1;
    const id = carouselGroupId(carouselId, index);
    const urls = chunk.map((x) => x.url);
    if (closing) urls.push(closing);
    groups.push({ id, index, urls, members: chunk.map((x) => x.r.id) });
    chunk.forEach((x, j) => pages.set(x.r.id, { groupId: id, page: j + 1 }));
  }
  return { groups, pages };
}

/** The address of a closing image, or why there is none. */
async function closingAddress(assetId: string): Promise<{ url: string } | { problem: string }> {
  const a = await db.assets.get(assetId);
  if (!a) return { problem: 'its closing image was deleted' };
  const url = assetAddress(a);
  return url ? { url } : { problem: `“${a.name}” has no public address` };
}

/** Carousel tables whose sync is waiting for a closing image's address (one warning each, not one per change). */
const warned = new Set<string>();

/** Brings one carousel table in line with its source: groups, the URL field, the Carousel Page links and page numbers. */
/**
 * Brings a carousel table in line with its source: the groups, the URL field, the Carousel Page links and page numbers.
 * A change that comes while it runs is not lost: it runs again afterwards (see `coalesce`).
 */
export const syncCarousel = coalesce(syncOnce);

/** Every carousel table is brought up to date with its source (at start-up, so the values an older version left are fixed). */
export async function syncAllCarousels(): Promise<void> {
  for (const t of tablesStore.get().tables) if (t.carousel) await syncCarousel(t.id);
}

async function syncOnce(carouselId: string): Promise<void> {
  const def = tablesStore.get().tables.find((t) => t.id === carouselId);
  const cfg = def?.carousel;
  if (!cfg) return;
  const source = cfg.source;
  if (!allTables().some((t) => t.id === source)) return;                       // the source table was deleted
  if (!fieldsOf(source).some((f) => f.key === cfg.linkField)) return;          // the URL field was deleted
  if (!fieldsOf(source).some((f) => f.key === CAROUSEL_FIELD)) return;
  let closingUrl: string | undefined;
  if (cfg.closingAsset) {
    const c = await closingAddress(cfg.closingAsset);
    if ('problem' in c) {
      // keep the carousels as they were; say why once, and update them when the image has an address
      if (!warned.has(carouselId)) {
        warned.add(carouselId);
        notify('warn', `Carousel table “${def?.name ?? ''}” is not updated: ${c.problem}. Give the closing image a public address in Assets and the carousels update.`, 9000);
      }
      return;
    }
    warned.delete(carouselId);
    closingUrl = c.url;
  }
  const srcRecs = [...recordsOf(source)].sort(byPosition); // the slides follow the order of the table
  const plan = planCarousel(srcRecs, cfg.linkField, cfg.groupSize, carouselId, closingUrl);

  // carousel records: one per group (updated in place, created when missing, removed when the source shrank)
  const have = new Map(recordsOf(carouselId).map((r) => [r.id, r]));
  const master = masterKeyOf(carouselId);
  const wanted: ContentRecord[] = plan.groups.map((g) => {
    const cur = have.get(g.id);
    const data: Record<string, unknown> = { ...(cur?.data ?? {}), [CAROUSEL_URLS]: g.urls.join(', '), [CAROUSEL_COUNT]: g.urls.length };
    if (!cur) data[master] = `Carousel ${g.index}`;   // a new carousel gets a name; a renamed one keeps its name
    return cur ? { ...cur, data } : newRow(carouselId, { id: g.id, data });
  });
  const changedCar = wanted.filter((r) => !have.has(r.id) || JSON.stringify(r.data) !== JSON.stringify(have.get(r.id)!.data));
  const createdCar = changedCar.filter((r) => !have.has(r.id));
  const updatedCar = changedCar.filter((r) => have.has(r.id));
  const staleIds = [...have.keys()].filter((id) => !plan.groups.some((g) => g.id === id));
  if (staleIds.length) await deleteRows(carouselId, staleIds);
  if (updatedCar.length || createdCar.length) await writeRows(carouselId, updatedCar, createdCar, { label: 'Updating carousels' });

  // source records: the link to their carousel and their page number
  const updatedSrc: ContentRecord[] = [];
  for (const r of srcRecs) {
    const want = plan.pages.get(r.id);
    const wantLink = want ? [want.groupId] : [];
    const wantNo = want ? want.page : undefined;
    const curLink = Array.isArray(r.data[CAROUSEL_FIELD]) ? (r.data[CAROUSEL_FIELD] as string[]) : [];
    const curNo = r.data[CAROUSEL_NO];
    if (JSON.stringify(curLink) !== JSON.stringify(wantLink) || curNo !== wantNo) {
      updatedSrc.push({ ...r, data: { ...r.data, [CAROUSEL_FIELD]: wantLink, [CAROUSEL_NO]: wantNo } });
    }
  }
  if (updatedSrc.length) await writeRows(source, updatedSrc, [], { label: 'Updating carousel pages' });
}

/**
 * Creates a carousel table from the configuration: the source table, the field with the image URLs, and how many
 * consecutive images make one carousel. Adds "Carousel Page" and "Page number" to the source, then builds the groups.
 */
export async function createCarouselTable(name: string, cfg: CarouselSpec): Promise<TableDef> {
  const source = fieldsOf(cfg.source);
  if (!allTables().some((t) => t.id === cfg.source)) throw new Error('Choose the source table.');
  if (!source.some((f) => f.key === cfg.linkField)) throw new Error('Choose the field that holds the image URLs.');
  if (!Number.isInteger(cfg.groupSize) || cfg.groupSize < 1 || cfg.groupSize > MAX_GROUP) throw new Error(`The number of images per carousel must be between 1 and ${MAX_GROUP}.`);
  if (source.some((f) => f.key === CAROUSEL_FIELD)) throw new Error('This table already has a “Carousel Page” field, so it is used by another carousel table. Delete that carousel table first.');
  if (cfg.closingAsset) {
    if (cfg.groupSize < 2) throw new Error('With a closing image, each carousel needs at least 2 slides (the last one is the closing image).');
    const c = await closingAddress(cfg.closingAsset);
    if ('problem' in c) throw new Error(`The closing image cannot be used: ${c.problem}. Give it a public address in Assets first.`);
  }
  const t = await createTable(name);
  await saveFieldIn(t.id, { id: uid(), key: CAROUSEL_URLS, label: 'Carousel (image URLs)', type: 'longtext', order: 1 });
  await saveFieldIn(t.id, { id: uid(), key: CAROUSEL_COUNT, label: 'Images', type: 'number', order: 2 });
  await db.userTables.update(t.id, { carousel: cfg });
  await loadTables();
  const nextOrder = source.length;
  await saveFieldIn(cfg.source, { id: uid(), key: CAROUSEL_FIELD, label: 'Carousel Page', type: 'link', linkTable: t.id, carouselPage: true, order: nextOrder });
  await saveFieldIn(cfg.source, { id: uid(), key: CAROUSEL_NO, label: 'Page number', type: 'number', order: nextOrder + 1 });
  await syncCarousel(t.id);
  return { ...t, carousel: cfg };
}

/** When a closing image's address changes, every carousel table that ends with that image is brought up to date. */
export async function resyncClosing(assetId: string): Promise<void> {
  for (const t of tablesStore.get().tables) if (t.carousel?.closingAsset === assetId) await syncCarousel(t.id);
}

/** Whenever rows of a source table change (added, edited, deleted), its carousel tables are brought up to date. */
onTableWritten(async (table) => {
  for (const t of tablesStore.get().tables) if (t.carousel && t.carousel.source === table) await syncCarousel(t.id);
});

