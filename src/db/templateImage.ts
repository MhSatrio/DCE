import { slugify } from '../engine/binding';
import { jostFontCss } from '../engine/fonts';
import { jpegToPdf } from '../engine/pdf';
import { renderDoc } from '../engine/render';
import type { NjsDoc } from '../engine/types';
import { customFontPayloads } from './customFonts';
import { mainProvider } from './provider';
import { dataTableOf, docToNjs, renderDataFor, sampleRecordFor } from './repo';
import { recordsOf } from './tables';

/** What a template can be downloaded as: its design file, or the drawing in the formats the Batch Runner writes. */
export type ExportFormat = 'njs' | 'png' | 'jpeg' | 'pdf' | 'svg' | 'html';

export const EXPORT_FORMATS: { id: ExportFormat; label: string }[] = [
  { id: 'njs', label: '.njs design file' },
  { id: 'png', label: 'PNG image' },
  { id: 'jpeg', label: 'JPEG image' },
  { id: 'pdf', label: 'PDF document' },
  { id: 'svg', label: 'SVG drawing' },
  { id: 'html', label: 'HTML page' },
];

const MIME: Record<ExportFormat, string> = { njs: 'application/json', png: 'image/png', jpeg: 'image/jpeg', pdf: 'application/pdf', svg: 'image/svg+xml', html: 'text/html' };
const EXT: Record<ExportFormat, string> = { njs: 'njs', png: 'png', jpeg: 'jpg', pdf: 'pdf', svg: 'svg', html: 'html' };

/** The record a drawing is made with: the one asked for, else the sample record (what the card and the preview show). */
function recordFor(doc: NjsDoc, recordId?: string) {
  const table = dataTableOf(doc);
  const records = recordsOf(table);
  return (recordId ? records.find((r) => r.id === recordId) : undefined) ?? sampleRecordFor(doc, table, records);
}

/**
 * The template as a file, at the template's own size. The drawing is the same render the batch uses; a PDF holds the JPEG
 * on one page, as the Batch Runner’s PDF does.
 */
export async function exportTemplate(doc: NjsDoc, format: ExportFormat, recordId?: string): Promise<{ blob: Blob; name: string }> {
  const name = `${slugify(doc.meta.name) || 'template'}.${EXT[format]}`;
  if (format === 'njs') return { blob: new Blob([await docToNjs(doc)], { type: MIME.njs }), name };
  const rec = recordFor(doc, recordId);
  const data = rec ? renderDataFor(rec, doc) : null;
  const fontCss = format === 'svg' || format === 'html' ? (await jostFontCss()) + (await customFontPayloads(doc)).css : undefined;
  const engine = format === 'pdf' ? 'jpeg' : format;
  const out = await renderDoc(doc, data, mainProvider, { format: engine, quality: 0.92, fontCss, failOnError: false });
  const bytes = format === 'pdf' ? jpegToPdf(out.bytes, out.width, out.height, doc.meta.name) : out.bytes;
  return { blob: new Blob([bytes as BlobPart], { type: MIME[format] }), name };
}
