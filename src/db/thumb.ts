import { renderDoc } from '../engine/render';
import type { NjsDoc } from '../engine/types';
import { mainProvider } from './provider';
import { dataTableOf, renderDataFor, sampleRecordFor } from './repo';
import { recordsOf } from './tables';
import { db } from './schema';

/** A small PNG preview of a template rendered with the first matching record (or design mode if none). */
export async function makeTemplateThumb(doc: NjsDoc, width = 360): Promise<Blob | undefined> {
  try {
    const table = dataTableOf(doc);
    const rec = sampleRecordFor(doc, table, recordsOf(table));
    const out = await renderDoc(doc, rec ? renderDataFor(rec, doc) : null, mainProvider, { format: 'png', outW: width, failOnError: false });
    return new Blob([out.bytes as BlobPart], { type: 'image/png' });
  } catch { return undefined; }
}

export async function ensureThumb(id: string): Promise<void> {
  const row = await db.templates.get(id);
  if (!row || row.thumb) return;
  const thumb = await makeTemplateThumb(row.doc);
  if (thumb) await db.templates.update(id, { thumb });
}
