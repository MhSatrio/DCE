/**
 * Minimal PDF writer: one JPEG per page (DCTDecode), page size = image size in CSS pixels × 0.75 (pt).
 * Streams chunks to a sink so multi-page batches do not need a second copy in memory.
 * Limitation: pages are raster (text is not selectable). Documented in README.
 */
const enc = new TextEncoder();

export interface PdfSink { write(chunk: Uint8Array): void }

export class PdfWriter {
  private offsets: number[] = [0];
  private pos = 0;
  private pages: number[] = [];
  private nextId = 3; // 1 = catalog, 2 = pages
  private started = false;

  constructor(private sink: PdfSink) {}

  private put(data: Uint8Array | string): void {
    const b = typeof data === 'string' ? enc.encode(data) : data;
    this.sink.write(b);
    this.pos += b.length;
  }

  private begin(): void {
    if (this.started) return;
    this.started = true;
    this.put('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  }

  private obj(id: number, body: string): void {
    this.offsets[id] = this.pos;
    this.put(`${id} 0 obj\n${body}\nendobj\n`);
  }

  addJpegPage(jpeg: Uint8Array, pxW: number, pxH: number): void {
    this.begin();
    const wPt = Math.round(pxW * 0.75 * 100) / 100, hPt = Math.round(pxH * 0.75 * 100) / 100;
    const imgId = this.nextId++, contId = this.nextId++, pageId = this.nextId++;
    this.offsets[imgId] = this.pos;
    this.put(`${imgId} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${pxW} /Height ${pxH} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`);
    this.put(jpeg);
    this.put('\nendstream\nendobj\n');
    const content = `q ${wPt} 0 0 ${hPt} 0 0 cm /Im0 Do Q`;
    this.obj(contId, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    this.obj(pageId, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${wPt} ${hPt}] /Resources << /XObject << /Im0 ${imgId} 0 R >> >> /Contents ${contId} 0 R >>`);
    this.pages.push(pageId);
  }

  finish(title = 'DCE export'): void {
    this.begin();
    this.obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
    this.obj(2, `<< /Type /Pages /Count ${this.pages.length} /Kids [${this.pages.map((p) => `${p} 0 R`).join(' ')}] >>`);
    const infoId = this.nextId++;
    this.obj(infoId, `<< /Title (${title.replace(/[()\\]/g, '')}) /Producer (VierApparatus DCE) >>`);
    const xref = this.pos;
    const n = this.nextId;
    let t = `xref\n0 ${n}\n0000000000 65535 f \n`;
    for (let i = 1; i < n; i++) t += `${String(this.offsets[i] ?? 0).padStart(10, '0')} 00000 n \n`;
    t += `trailer\n<< /Size ${n} /Root 1 0 R /Info ${infoId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    this.put(t);
  }
}

/** Convenience: single-page PDF as bytes. */
export function jpegToPdf(jpeg: Uint8Array, pxW: number, pxH: number, title?: string): Uint8Array {
  const chunks: Uint8Array[] = [];
  const w = new PdfWriter({ write: (c) => chunks.push(c) });
  w.addJpegPage(jpeg, pxW, pxH);
  w.finish(title);
  const total = chunks.reduce((a, c) => a + c.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}
