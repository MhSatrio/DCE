import { slugify } from '../engine/binding';
import { cloneDoc, newDoc, parseNjs, renumberLayers, serializeNjs, touch, uid, walkNodes } from '../engine/njs';
import type { AssetRef, NjsDoc, RenderData } from '../engine/types';
import { guard, notify } from '../ui/store';
import { dropThumb } from '../ui/Thumb';
import { allFields, defaultValueOf, getValue } from './fields';
import { db, type AssetRow, type ContentRecord, type FieldDef, type TemplateRow } from './schema';
import { recordsStore } from './stores';
import { assignPositions, byPosition } from './order';
import { rasterizeSvg } from './svgraster';
import { viewBoxOf } from '../assets/svgdoc';
import { imageNameFor, remoteImage } from './remote';
import { clearImageCaches } from './provider';
import { CONTENT_TABLE, createRows, deleteFieldIn, deleteRows, fieldsOf, loadTables, masterKeyOf, recordsOf, saveFieldIn, updateRow, updateRowsWith, writeRows } from './tables';

// ======================= records (the Content Plan; every write goes through db/tables.ts so links / synced fields stay consistent)

export { recordsStore };

export async function loadRecords(): Promise<void> {
  const [records, fields] = await Promise.all([db.records.toArray(), db.fields.toArray()]);
  const fixed = assignPositions(records);
  if (fixed.length) await db.records.bulkPut(fixed);
  records.sort(byPosition);
  recordsStore.set({ records, fields: fields.filter((f) => !f.tableId || f.tableId === CONTENT_TABLE).sort((a, b) => a.order - b.order), loaded: true });
  await loadTables();
}

export function newRecord(partial: Partial<ContentRecord> = {}): ContentRecord {
  const now = Date.now();
  const title = partial.title ?? 'Untitled record';
  return {
    id: uid(), title, slug: slugify(title), status: defaultValueOf(recordsStore.get().fields, 'status'), publish_date: '', content: '', image_asset: '', template_ref: '',
    tags: [], created_at: now, updated_at: now, data: {}, ...partial,
  };
}

export const addRecords = (recs: ContentRecord[], opts: { upsert?: boolean } = {}) => createRows(CONTENT_TABLE, recs, !!opts.upsert);
export const updateRecord = (id: string, patch: Partial<ContentRecord>) => updateRow(CONTENT_TABLE, id, patch);
export const bulkUpdateRecords = (ids: string[], mutate: (r: ContentRecord) => ContentRecord) => updateRowsWith(CONTENT_TABLE, ids, mutate);
/** Applies a batch of edited / new records in one write (paste, duplicate…). */
export const commitRecords = (updated: ContentRecord[], created: ContentRecord[]) => {
  const prev = new Map(recordsStore.get().records.map((r) => [r.id, r]));
  return writeRows(CONTENT_TABLE, updated, created, { prev });
};
export const deleteRecords = (ids: string[]) => deleteRows(CONTENT_TABLE, ids);
export const saveField = (f: FieldDef) => saveFieldIn(CONTENT_TABLE, f);
export const deleteField = (f: FieldDef) => deleteFieldIn(CONTENT_TABLE, f);

export function fieldsList(): FieldDef[] {
  return allFields(recordsStore.get().fields);
}

/**
 * The `content.*` scope a template sees for a record: one value per field of the record's table, built-in and custom,
 * by field key. `title` is the record's name (its Master Field) unless the table has its own field called title, and
 * `slug` is made from the name when it is empty.
 */
export function recordContent(rec: ContentRecord, table: string = rec.table ?? CONTENT_TABLE, fields: FieldDef[] = fieldsOf(table)): Record<string, unknown> {
  const scope: Record<string, unknown> = { id: rec.id };
  for (const f of fields) scope[f.key] = getValue(rec, f.key);
  if (!('title' in scope)) scope.title = getValue(rec, masterKeyOf(table)) ?? '';
  scope.slug = scope.slug || slugify(String(scope.title ?? ''));
  return scope;
}

export function renderDataFor(rec: ContentRecord, doc: NjsDoc, index = 1, total = 1, overrides: Record<string, unknown> = {}): RenderData {
  const template: Record<string, unknown> = {};
  for (const p of doc.placeholders) {
    if (p.key.startsWith('template.') && p.default_value !== undefined) template[p.key.slice(9)] = p.default_value;
  }
  Object.assign(template, overrides);
  return { content: recordContent(rec), template, batch: { index, total } };
}

/** The table a template draws its records from (set in the editor's Data tab). Templates made before that choice use the Content Plan. */
export function dataTableOf(doc: NjsDoc | undefined): string {
  return (doc?.meta as { dataTable?: string } | undefined)?.dataTable || CONTENT_TABLE;
}

/** The record a preview shows first: one that the template is linked to (a relation field that points at templates), else the first record. */
export function sampleRecordFor(doc: NjsDoc, table: string, records: ContentRecord[]): ContentRecord | undefined {
  const link = fieldsOf(table).find((f) => f.type === 'relation' && f.relationTo === 'templates');
  return (link && records.find((r) => getValue(r, link.key) === doc.meta.id)) || records[0];
}

// ======================= templates =======================

export async function saveTemplate(doc: NjsDoc, extra: { thumb?: Blob; description?: string; tags?: string[] } = {}): Promise<TemplateRow | undefined> {
  const d = touch(cloneDoc(doc));
  renumberLayers(d.nodes);
  const prev = await db.templates.get(d.meta.id);
  const row: TemplateRow = {
    id: d.meta.id, name: d.meta.name, description: extra.description ?? d.meta.description ?? prev?.description ?? '',
    doc: d, thumb: extra.thumb ?? prev?.thumb, width: d.canvas.width, height: d.canvas.height,
    version: (prev?.version ?? 0) + 1, tags: extra.tags ?? prev?.tags ?? [],
    created_at: prev?.created_at ?? Date.now(), updated_at: Date.now(), sample: prev?.sample,
  };
  const ok = await guard('Saving template', async () => { await db.templates.put(row); return true; });
  return ok ? row : undefined;
}

export async function createTemplate(name: string, width: number, height: number): Promise<TemplateRow | undefined> {
  return saveTemplate(newDoc(name, width, height));
}

export async function duplicateTemplate(id: string): Promise<TemplateRow | undefined> {
  const src = await db.templates.get(id);
  if (!src) return undefined;
  const doc = cloneDoc(src.doc);
  doc.meta.id = uid(); doc.meta.name = `${src.name} (copy)`;
  doc.meta.created_at = new Date().toISOString();
  for (const n of walkNodes(doc.nodes)) n.id = uid();
  const row = await saveTemplate(doc, { thumb: src.thumb, tags: src.tags, description: src.description });
  if (row) await db.templates.update(row.id, { sample: false, version: 1 });
  return row;
}

export async function deleteTemplate(id: string): Promise<void> {
  await guard('Deleting template', async () => {
    await db.templates.delete(id);
    const refs = await db.records.where('template_ref').equals(id).toArray();
    if (refs.length) await db.records.bulkPut(refs.map((r) => ({ ...r, template_ref: '' })));
  });
  await loadRecords();
}

/** Assets referenced by static image nodes (for self-contained exports). */
export function templateAssetIds(doc: NjsDoc): string[] {
  const ids = new Set<string>();
  for (const n of walkNodes(doc.nodes)) {
    if (n.src?.assetId) ids.add(n.src.assetId);
    if (n.constraints?.fallbackAssetId) ids.add(n.constraints.fallbackAssetId);
  }
  return [...ids];
}

export async function blobToDataUri(b: Blob): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = () => rej(r.error);
    r.readAsDataURL(b);
  });
}

/** Serialises a design to .njs text. With `embed`, referenced assets travel inside the file as data URIs. */
export async function docToNjs(source: NjsDoc, embed = true): Promise<string> {
  const doc = cloneDoc(source);
  doc.meta.updated_at = new Date().toISOString();
  const refs: AssetRef[] = [];
  let budget = 12 * 1024 * 1024;
  for (const aid of templateAssetIds(doc)) {
    const a = await db.assets.get(aid);
    if (!a) continue;
    const ref: AssetRef = { id: a.id, name: a.name, mime: a.mime, width: a.width, height: a.height };
    if (embed && a.size <= budget) { ref.data = await blobToDataUri(a.blob); budget -= a.size; }
    refs.push(ref);
  }
  doc.assets = refs;
  return serializeNjs(doc);
}

export async function exportNjs(id: string, embed = true): Promise<{ text: string; name: string }> {
  const row = await db.templates.get(id);
  if (!row) throw new Error('Template not found');
  return { text: await docToNjs(row.doc, embed), name: `${slugify(row.name) || 'template'}.njs` };
}

export async function importNjs(text: string): Promise<{ row: TemplateRow; warnings: string[] }> {
  const { doc, warnings } = parseNjs(text);
  const existing = await db.templates.get(doc.meta.id);
  if (existing) { doc.meta.id = uid(); doc.meta.name = `${doc.meta.name} (imported)`; warnings.push('A template with this id already exists; imported as a copy.'); }
  // restore embedded assets that are not in this database yet
  let restored = 0, missing = 0;
  for (const a of doc.assets) {
    if (await db.assets.get(a.id)) { delete a.data; continue; }
    if (a.data) {
      try {
        const blob = await (await fetch(a.data)).blob();
        await storeAssetBlob(blob, a.name || 'asset', { id: a.id });
        restored++;
      } catch { missing++; }
      delete a.data;
    } else missing++;
  }
  if (restored) warnings.push(`Restored ${restored} embedded asset${restored > 1 ? 's' : ''}.`);
  if (missing) warnings.push(`${missing} referenced asset${missing > 1 ? 's are' : ' is'} not in this workspace — images will use their fallback.`);
  const row = await saveTemplate(doc);
  if (!row) throw new Error('Could not save the imported template.');
  return { row, warnings };
}

// ======================= assets =======================

async function decodeImage(blob: Blob): Promise<ImageBitmap> {
  return createImageBitmap(blob);
}


export async function makeThumb(bm: ImageBitmap, max = 256): Promise<Blob> {
  const s = Math.min(1, max / Math.max(bm.width, bm.height));
  const w = Math.max(1, Math.round(bm.width * s)), h = Math.max(1, Math.round(bm.height * s));
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bm, 0, 0, w, h);
  return c.convertToBlob({ type: 'image/webp', quality: 0.8 }).catch(() => c.convertToBlob({ type: 'image/png' }));
}

const MAX_ASSET_BYTES = 40 * 1024 * 1024;

export async function storeAssetBlob(
  input: Blob, name: string, opts: { id?: string; tags?: string[]; category?: string; sourceUrl?: string; sample?: boolean } = {},
): Promise<AssetRow> {
  if (input.size > MAX_ASSET_BYTES) throw new Error(`${name} is larger than ${MAX_ASSET_BYTES / 1024 / 1024} MB.`);
  let blob = input;
  if (input.type === 'image/svg+xml' || /\.svg$/i.test(name)) blob = await rasterizeSvg(input);
  if (!blob.type.startsWith('image/')) throw new Error(`${name} is not an image.`);
  let bm: ImageBitmap;
  try { bm = await decodeImage(blob); } catch { throw new Error(`${name} could not be decoded as an image.`); }
  const thumb = await makeThumb(bm);
  const row: AssetRow = {
    id: opts.id ?? uid(), name: name.replace(/\.svg$/i, '.png'), mime: blob.type, size: blob.size,
    width: bm.width, height: bm.height, aspect: Math.round((bm.width / bm.height) * 1000) / 1000,
    blob, thumb, tags: opts.tags ?? [], category: opts.category ?? 'Uncategorised',
    sourceUrl: opts.sourceUrl, created_at: Date.now(), sample: opts.sample,
  };
  bm.close();
  await db.assets.put(row);
  return row;
}

/**
 * Adds uploaded files to the library, into `category` (the folder being shown, when there is one). An SVG is kept as a
 * vector drawing (its text is the asset, so it can be edited); a PNG of it is made for the templates.
 */
export async function importAssetFiles(files: File[], opts: { category?: string } = {}): Promise<{ added: AssetRow[]; failed: string[] }> {
  const added: AssetRow[] = []; const failed: string[] = [];
  for (const f of files) {
    try {
      if (f.type === 'image/svg+xml' || /\.svg$/i.test(f.name)) added.push(await storeSvgFile(f, opts.category));
      else added.push(await storeAssetBlob(f, f.name, { category: opts.category }));
    } catch (e) { failed.push(`${f.name}: ${e instanceof Error ? e.message : String(e)}`); }
  }
  return { added, failed };
}

async function storeSvgFile(f: File, category?: string): Promise<AssetRow> {
  if (f.size > MAX_ASSET_BYTES) throw new Error(`${f.name} is larger than ${MAX_ASSET_BYTES / 1024 / 1024} MB.`);
  const text = await f.text();
  if (!/<svg[\s>]/i.test(text)) throw new Error(`${f.name} is not an SVG drawing.`);
  const box = viewBoxOf(text);
  return storeSvgAsset(text, f.name, Math.max(1, Math.round(box?.w ?? 512)), Math.max(1, Math.round(box?.h ?? 512)), { category: category ?? 'Uncategorised', tags: [] });
}

/**
 * Imports the image at a web address into the library. The download is the one the batch uses (a Google Drive share link is
 * turned into the file itself, and a server that does not allow the browser to read it goes through the local helper).
 */
export async function importAssetUrl(url: string): Promise<AssetRow> {
  const address = url.trim();
  if (!/^https?:\/\//i.test(address)) throw new Error('Enter an http(s) image URL.');
  const got = await remoteImage(address);
  if (!got.ok) throw new Error(got.reason);
  return storeAssetBlob(got.blob, imageNameFor(address, got.blob.type), { sourceUrl: address, category: 'Remote' });
}

export async function recordsUsingAsset(assetId: string): Promise<ContentRecord[]> {
  const direct = await db.records.where('image_asset').equals(assetId).toArray();
  const custom = (await db.records.toArray()).filter((r) => Object.values(r.data).includes(assetId) && !direct.includes(r));
  return [...direct, ...custom];
}

export async function templatesUsingAsset(assetId: string): Promise<TemplateRow[]> {
  return (await db.templates.toArray()).filter((t) => templateAssetIds(t.doc).includes(assetId));
}

export async function deleteAsset(id: string): Promise<void> {
  dropThumb(id);
  await guard('Deleting asset', async () => {
    await db.assets.delete(id);
    const used = await db.records.where('image_asset').equals(id).toArray();
    if (used.length) await db.records.bulkPut(used.map((r) => ({ ...r, image_asset: '' })));
  });
  await loadRecords();
}

// ======================= sample data =======================

export async function removeSampleData(): Promise<void> {
  await guard('Removing sample data', async () => {
    const recIds = (await db.records.toArray()).filter((r) => r.sample).map((r) => r.id);
    const assetIds = (await db.assets.toArray()).filter((a) => a.sample).map((a) => a.id);
    const tplIds = (await db.templates.toArray()).filter((t) => t.sample).map((t) => t.id);
    await db.records.bulkDelete(recIds);
    await db.assets.bulkDelete(assetIds);
    await db.templates.bulkDelete(tplIds);
    await db.fields.filter((f) => f.id.startsWith('sample_')).delete();
  });
  await loadRecords();
  notify('success', 'Sample data removed.');
}

/**
 * Stores an SVG as an asset: the SVG itself is kept (editable, exportable), and a PNG preview is made for the thumbnail.
 * Templates draw raster images, so an SVG asset is for editing and export; use the PNG cut-out or the raster for designs.
 */
export async function storeSvgAsset(svg: string, name: string, width: number, height: number, opts: { category?: string; tags?: string[] } = {}): Promise<AssetRow> {
  const blob = new Blob([svg], { type: 'image/svg+xml' });
  if (blob.size > MAX_ASSET_BYTES) throw new Error(`${name} is larger than ${MAX_ASSET_BYTES / 1024 / 1024} MB.`);
  const preview = await rasterizeSvg(blob);
  const bm = await decodeImage(preview);
  const thumb = await makeThumb(bm);
  bm.close();
  const row: AssetRow = {
    id: uid(), name: /\.svg$/i.test(name) ? name : `${name}.svg`, mime: 'image/svg+xml', size: blob.size,
    width, height, aspect: Math.round((width / height) * 1000) / 1000,
    blob, thumb, raster: preview, tags: opts.tags ?? [], category: opts.category ?? 'Uncategorised', created_at: Date.now(),
  };
  await db.assets.put(row);
  return row;
}

/**
 * Saves a changed SVG into an existing SVG asset (the same id, so every template that uses it draws the new version).
 * The PNG and the thumbnail are made again from the new SVG.
 */
export async function updateSvgAsset(id: string, svg: string): Promise<AssetRow> {
  const row = await db.assets.get(id);
  if (!row) throw new Error('That asset no longer exists.');
  const blob = new Blob([svg], { type: 'image/svg+xml' });
  if (blob.size > MAX_ASSET_BYTES) throw new Error(`The SVG is larger than ${MAX_ASSET_BYTES / 1024 / 1024} MB.`);
  const preview = await rasterizeSvg(blob);
  const bm = await decodeImage(preview);
  const thumb = await makeThumb(bm);
  const next: AssetRow = { ...row, blob, size: blob.size, thumb, raster: preview, width: bm.width, height: bm.height, aspect: Math.round((bm.width / bm.height) * 1000) / 1000 };
  bm.close();
  await db.assets.put(next);
  clearImageCaches();
  return next;
}
