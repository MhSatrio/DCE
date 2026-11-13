import { Zip, ZipDeflate, ZipPassThrough } from 'fflate';
import { assetBlobFor, isRemoteRef } from '../db/provider';
import { db, type BatchConfig, type ContentRecord, type JobFailure, type JobRow, type JobStatus } from '../db/schema';
import { recordContent, renderDataFor } from '../db/repo';
import { renderFilename, slugify, UniqueNames } from '../engine/binding';
import { jostFontCss, bytesToBase64, type FontPayload } from '../engine/fonts';
import { jpegToPdf, PdfWriter } from '../engine/pdf';
import { collectImageRefs } from '../engine/scene';
import { uid, walkNodes } from '../engine/njs';
import type { NjsDoc, RenderData } from '../engine/types';
import { createStore, type Store } from '../ui/store';
import type { FromWorker, ToWorker } from '../workers/protocol';
import RenderWorker from '../workers/render.worker?worker';

export interface RunState {
  jobId: string;
  status: JobStatus | 'preparing';
  total: number;
  done: number;
  ok: number;
  failed: number;
  warnings: number;
  current: string;
  activeMs: number;
  etaMs: number | null;
  throughput: number;
  failures: JobFailure[];
  bytesOut: number;
  output: { blob: Blob; name: string } | null;
  error: string | null;
}

export interface RunInput {
  config: BatchConfig;
  doc: NjsDoc;
  templateName: string;
  records: ContentRecord[];
  selectionLabel: string;
  parentId?: string;
  /** Stream the archive straight to disk (File System Access API) instead of keeping it in memory. */
  fileHandle?: FileSystemFileHandle;
}

interface ManifestEntry {
  filename: string | null;
  record_id: string;
  template_id: string;
  output_format: string;
  status: 'ok' | 'failed' | 'cancelled';
  warnings?: string[];
  error?: string;
}

const registry = new Map<string, BatchRun>();
export const getRun = (jobId: string) => registry.get(jobId);

export function defaultConcurrency(): number {
  const hc = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4;
  return Math.max(1, Math.min(4, hc - 1));
}

async function customFontPayloads(doc: NjsDoc): Promise<{ payloads: FontPayload[]; css: string }> {
  const used = new Set<string>();
  for (const n of walkNodes(doc.nodes)) if (n.type === 'text' && n.style.fontFamily) used.add(n.style.fontFamily as string);
  const rows = (await db.fonts.toArray()).filter((f) => used.has(f.family));
  const payloads: FontPayload[] = [];
  let css = '';
  for (const r of rows) {
    const data = await r.blob.arrayBuffer();
    payloads.push({ family: r.family, weight: r.weight, style: r.style, data });
    css += `@font-face{font-family:'${r.family.replace(/'/g, '')}';font-style:${r.style};font-weight:${r.weight};src:url(data:font/woff2;base64,${bytesToBase64(new Uint8Array(data))});}`;
  }
  return { payloads, css };
}

export class BatchRun {
  readonly store: Store<RunState>;
  private cfg: BatchConfig;
  private workers: Worker[] = [];
  private paused = false;
  private cancelled = false;
  private pendingResume: (() => void) | null = null;
  private lastStamp = 0;
  private activeMs = 0;
  private queue: number[] = [];
  private inflight = 0;
  private names = new UniqueNames();
  private manifest: ManifestEntry[] = [];
  private zip!: Zip;
  private chunks: BlobPart[] = [];
  private pendingBytes = 0;
  private writable: FileSystemWritableFileStream | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  private zipDone!: Promise<void>;
  private pdf: PdfWriter | null = null;
  private pdfChunks: Uint8Array[] = [];
  private pdfOrder = new Map<number, { jpeg: Uint8Array; w: number; h: number } | null>();
  private nextPdf = 0;
  private lastSave = 0;
  private lastEmit = 0;
  private finished: Promise<void>;
  private resolveFinished!: () => void;
  readonly job: JobRow;

  constructor(private input: RunInput) {
    this.cfg = input.config;
    const jobId = uid();
    this.job = {
      id: jobId, parentId: input.parentId, templateId: input.doc.meta.id, templateName: input.templateName,
      database: 'Content Plan', selectionLabel: input.selectionLabel, config: input.config,
      recordIds: input.records.map((r) => r.id), format: input.config.format, status: 'running',
      started_at: Date.now(), total: input.records.length, success: 0, failure: 0, warnings: 0, failures: [],
      errorSummary: '', elapsedMs: 0, throughput: 0,
    };
    this.store = createStore<RunState>({
      jobId, status: 'preparing', total: input.records.length, done: 0, ok: 0, failed: 0, warnings: 0, current: '',
      activeMs: 0, etaMs: null, throughput: 0, failures: [], bytesOut: 0, output: null, error: null,
    });
    this.finished = new Promise((r) => { this.resolveFinished = r; });
    registry.set(jobId, this);
  }

  get done(): Promise<void> { return this.finished; }

  // ---- controls ----
  pause(): void {
    if (this.paused || this.store.get().status !== 'running') return;
    this.paused = true; this.tick(); this.store.set({ status: 'paused' });
  }
  resume(): void {
    if (!this.paused) return;
    this.paused = false; this.lastStamp = performance.now();
    this.store.set({ status: 'running' });
    this.pump();
  }
  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.paused = false;
    this.workers.forEach((w) => w.terminate());
    this.workers = [];
    void this.finalize();
  }

  private tick(): void {
    const now = performance.now();
    if (this.lastStamp) this.activeMs += now - this.lastStamp;
    this.lastStamp = now;
  }

  private emit(force = false): void {
    const now = performance.now();
    if (!force && now - this.lastEmit < 90) return;
    this.lastEmit = now;
    this.tick();
    const s = this.store.get();
    const rate = this.activeMs > 0 ? s.done / (this.activeMs / 1000) : 0;
    const remaining = s.total - s.done;
    this.store.set({ activeMs: this.activeMs, throughput: rate, etaMs: rate > 0 && s.done >= 3 ? (remaining / rate) * 1000 : null });
  }

  private async persist(final = false): Promise<void> {
    const s = this.store.get();
    const now = performance.now();
    if (!final && now - this.lastSave < 1500) return;
    this.lastSave = now;
    Object.assign(this.job, {
      status: (final ? this.job.status : s.status === 'paused' ? 'paused' : 'running') as JobStatus,
      success: s.ok, failure: s.failed, warnings: s.warnings, failures: s.failures, elapsedMs: Math.round(this.activeMs),
      throughput: Math.round(s.throughput * 100) / 100,
      errorSummary: summarise(s.failures),
    });
    try { await db.jobs.put({ ...this.job }); } catch { /* history is best-effort; the run itself must not die */ }
  }

  // ---- lifecycle ----
  async start(): Promise<void> {
    const { doc, records } = this.input;
    const cfg = this.cfg;
    try {
      await db.jobs.put({ ...this.job });
      const fmt = cfg.format;
      const engineFormat = fmt === 'pdf' ? 'jpeg' : fmt;
      const fontCss = fmt === 'svg' || fmt === 'html' ? (await jostFontCss()) + (await customFontPayloads(doc)).css : undefined;
      const { payloads } = await customFontPayloads(doc);

      this.zipDone = this.openArchive();
      if (fmt === 'pdf' && cfg.pdfMode === 'combined') this.pdf = new PdfWriter({ write: (c) => this.pdfChunks.push(c) });

      const n = Math.max(1, Math.min(cfg.concurrency || defaultConcurrency(), 8, records.length || 1));
      const setup: ToWorker = {
        type: 'setup', doc,
        opts: { format: engineFormat, outW: cfg.outW, outH: cfg.outH, quality: cfg.quality, transparent: cfg.transparent, fontCss },
        fonts: payloads,
      };
      this.queue = records.map((_, i) => i);
      await Promise.all(Array.from({ length: n }, () => new Promise<void>((resolve, reject) => {
        const w = new RenderWorker();
        const to = setTimeout(() => reject(new Error('A render worker did not start in time.')), 20000);
        w.onmessage = (ev: MessageEvent<FromWorker>) => {
          const m = ev.data;
          if (m.type === 'ready') {
            clearTimeout(to); this.workers.push(w); w.onmessage = (e2) => this.onMessage(w, e2.data);
            // a crash after start-up fails the record being rendered instead of hanging the batch
            w.onerror = () => { const idx = this.inflightByWorker.get(w); if (idx !== undefined) this.complete(w, idx, false, 'The render worker crashed (out of memory or an internal error).', []); };
            resolve();
          }
          else if (m.type === 'fatal') { clearTimeout(to); reject(new Error(m.error)); }
        };
        w.onerror = (e) => { clearTimeout(to); reject(new Error(e.message || 'Worker error')); };
        w.postMessage(setup);
      })));
      if (this.cancelled) { this.workers.forEach((w) => w.terminate()); return; }
      this.lastStamp = performance.now();
      this.store.set({ status: 'running' });
      this.pump();
      if (records.length === 0) void this.finalize();
    } catch (e) {
      this.store.set({ error: e instanceof Error ? e.message : String(e) });
      this.job.status = 'failed';
      this.job.errorSummary = this.store.get().error ?? 'failed';
      await this.finalize(true);
    }
  }

  private inflightByWorker = new Map<Worker, number>();
  private busy = new Map<Worker, boolean>();

  private pump(): void {
    if (this.cancelled || this.paused) return;
    for (const w of this.workers) {
      if (this.busy.get(w)) continue;
      // Bounded work-in-progress and bounded reorder buffer (PDF): never run far ahead of the writer.
      if (this.pdf && this.pdfOrder.size > 24) return;
      const idx = this.queue.shift();
      if (idx === undefined) break;
      void this.dispatch(w, idx);
    }
    if (this.queue.length === 0 && this.inflight === 0 && !this.cancelled) void this.finalize();
  }

  private async dispatch(w: Worker, idx: number): Promise<void> {
    this.busy.set(w, true); this.inflight++; this.inflightByWorker.set(w, idx);
    const rec = this.input.records[idx];
    const data: RenderData = renderDataFor(rec, this.input.doc, idx + 1, this.input.records.length);
    try {
      const refs = collectImageRefs(this.input.doc, data);
      const blobs: Record<string, Blob> = {};
      for (const ref of new Set([...refs.primary, ...refs.fallback])) {
        if (isRemoteRef(ref)) continue;
        const b = await assetBlobFor(ref);
        if (b) blobs[ref] = b;
      }
      this.store.set({ current: rec.title });
      w.postMessage({ type: 'render', seq: idx, data, blobs } satisfies ToWorker);
    } catch (e) {
      this.complete(w, idx, false, e instanceof Error ? e.message : String(e), []);
    }
  }

  private onMessage(w: Worker, m: FromWorker): void {
    if (this.cancelled) return;
    if (m.type === 'done') {
      this.handleOk(w, m);
    } else if (m.type === 'fail') {
      this.complete(w, m.seq, false, m.error, m.issues.map((i) => i.message));
    } else if (m.type === 'fatal') {
      const idx = this.inflightByWorker.get(w);
      if (idx !== undefined) this.complete(w, idx, false, `Worker crashed: ${m.error}`, []);
    }
  }

  private handleOk(w: Worker, m: Extract<FromWorker, { type: 'done' }>): void {
    const rec = this.input.records[m.seq];
    const data = renderDataFor(rec, this.input.doc, m.seq + 1, this.input.records.length);
    const bytes = new Uint8Array(m.bytes);
    const warn = m.issues.filter((i) => i.level === 'warning').map((i) => (i.nodeName ? `${i.nodeName}: ` : '') + i.message);
    const fmt = this.cfg.format;
    try {
      if (fmt === 'pdf' && this.pdf) {
        this.pdfOrder.set(m.seq, { jpeg: bytes, w: m.width, h: m.height });
        this.manifest.push({ filename: null, record_id: rec.id, template_id: this.input.doc.meta.id, output_format: 'pdf', status: 'ok', warnings: warn.length ? warn : undefined });
        this.flushPdf();
      } else {
        const outBytes = fmt === 'pdf' ? wrapPdf(bytes, m.width, m.height, rec.title) : bytes;
        const ext = fmt === 'pdf' ? 'pdf' : fmt === 'jpeg' ? 'jpg' : fmt;
        const name = this.names.take(renderFilename(this.cfg.filenamePattern || '{{content.slug}}', data, ext));
        this.addFile(name, outBytes, fmt === 'svg' || fmt === 'html');
        this.manifest.push({ filename: name, record_id: rec.id, template_id: this.input.doc.meta.id, output_format: fmt, status: 'ok', warnings: warn.length ? warn : undefined });
      }
      this.store.set((s) => ({ bytesOut: s.bytesOut + bytes.length, warnings: s.warnings + (warn.length ? 1 : 0) }));
      this.complete(w, m.seq, true, '', []);
    } catch (e) {
      this.complete(w, m.seq, false, `Packaging failed: ${e instanceof Error ? e.message : String(e)}`, []);
    }
  }

  private flushPdf(): void {
    while (this.pdfOrder.has(this.nextPdf) || this.skipped.has(this.nextPdf)) {
      const p = this.pdfOrder.get(this.nextPdf);
      if (p) this.pdf!.addJpegPage(p.jpeg, p.w, p.h);
      this.pdfOrder.delete(this.nextPdf); this.skipped.delete(this.nextPdf);
      this.nextPdf++;
    }
  }
  private skipped = new Set<number>();

  private complete(w: Worker, idx: number, ok: boolean, error: string, details: string[]): void {
    this.busy.set(w, false); this.inflight--; this.inflightByWorker.delete(w);
    const rec = this.input.records[idx];
    const s = this.store.get();
    if (!ok) {
      const failure: JobFailure = { recordId: rec.id, title: rec.title, error: details.length ? details.join(' | ') || error : error };
      this.manifest.push({ filename: null, record_id: rec.id, template_id: this.input.doc.meta.id, output_format: this.cfg.format, status: 'failed', error: failure.error });
      this.skipped.add(idx);
      if (this.pdf) this.flushPdf();
      this.store.set({ failed: s.failed + 1, done: s.done + 1, failures: [...s.failures, failure] });
    } else this.store.set({ ok: s.ok + 1, done: s.done + 1 });
    this.emit();
    void this.persist();
    this.pump();
  }

  // ---- archive ----
  private async openArchive(): Promise<void> {
    if (this.input.fileHandle) {
      try { this.writable = await this.input.fileHandle.createWritable(); } catch { this.writable = null; }
    }
    let resolve!: () => void;
    const p = new Promise<void>((r) => { resolve = r; });
    this.zip = new Zip((err, chunk, final) => {
      if (err) { this.store.set({ error: String(err) }); return; }
      if (this.writable) { const wr = this.writable; this.writeChain = this.writeChain.then(() => wr.write(chunk as unknown as BufferSource)); }
      else {
        this.chunks.push(chunk as unknown as BlobPart);
        this.pendingBytes += chunk.length;
        // Fold finished chunks into a Blob: the browser can keep Blob data outside the JS heap (and spill it to disk).
        if (this.pendingBytes > 16 * 1024 * 1024) { this.chunks = [new Blob(this.chunks)]; this.pendingBytes = 0; }
      }
      if (final) resolve();
    });
    return p;
  }

  private addFile(name: string, bytes: Uint8Array, compress: boolean): void {
    const f = compress ? new ZipDeflate(name, { level: 6 }) : new ZipPassThrough(name);
    this.zip.add(f);
    f.push(bytes, true);
  }

  private finalizing = false;
  private async finalize(failed = false): Promise<void> {
    if (this.finalizing) return;
    this.finalizing = true;
    this.workers.forEach((w) => w.terminate());
    this.workers = [];
    this.tick();
    const s = this.store.get();
    try {
      if (!failed) {
        if (this.pdf) {
          this.flushPdf();
          this.pdfOrder.clear(); // pages stranded behind a cancelled gap are dropped
          if (this.nextPdf > 0) {
            this.pdf.finish(this.input.templateName);
            const total = this.pdfChunks.reduce((a, c) => a + c.length, 0);
            const all = new Uint8Array(total); let o = 0;
            for (const c of this.pdfChunks) { all.set(c, o); o += c.length; }
            this.pdfChunks = [];
            const pdfName = `${slugify(this.input.templateName) || 'batch'}-batch.pdf`;
            for (const m of this.manifest) if (m.output_format === 'pdf' && m.status === 'ok') m.filename = pdfName;
            this.addFile(pdfName, all, false);
          }
        }
        if (this.cfg.includeManifest) {
          const doc = {
            generator: 'VierApparatus DCE', job_id: this.job.id, template: { id: this.input.doc.meta.id, name: this.input.templateName },
            format: this.cfg.format, created_at: new Date().toISOString(), cancelled: this.cancelled,
            counts: { total: s.total, ok: this.store.get().ok, failed: this.store.get().failed },
            entries: this.manifest,
          };
          this.addFile('manifest.json', new TextEncoder().encode(JSON.stringify(doc, null, 2)), true);
        }
      }
      this.zip.end();
      await this.zipDone;
      await this.writeChain;
      let blob: Blob | null = null;
      const name = `${slugify(this.input.templateName) || 'batch'}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.zip`;
      if (this.writable) { await this.writable.close(); this.writable = null; } else {
        blob = new Blob(this.chunks, { type: 'application/zip' });
        this.chunks = [];
      }
      const fs = this.store.get();
      const status: JobStatus = failed ? 'failed' : this.cancelled ? 'cancelled' : fs.failed === 0 ? 'completed' : fs.ok === 0 ? 'failed' : 'completed_with_errors';
      this.job.status = status;
      this.job.completed_at = Date.now();
      this.job.outputName = name;
      this.store.set({ status, output: blob ? { blob, name } : null });
    } catch (e) {
      this.job.status = 'failed';
      this.store.set({ status: 'failed', error: e instanceof Error ? e.message : String(e) });
    }
    this.emit(true);
    await this.persist(true);
    this.resolveFinished();
  }
}

function summarise(failures: JobFailure[]): string {
  if (!failures.length) return '';
  const counts = new Map<string, number>();
  for (const f of failures) counts.set(f.error.slice(0, 120), (counts.get(f.error.slice(0, 120)) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([e, n]) => `${n}× ${e}`).join('; ');
}

function wrapPdf(jpeg: Uint8Array, w: number, h: number, title: string): Uint8Array {
  return jpegToPdf(jpeg, w, h, title);
}

/** After a retry run: fold its results back into the parent job. */
export async function foldRetryIntoParent(parentId: string, run: BatchRun): Promise<void> {
  const parent = await db.jobs.get(parentId);
  if (!parent) return;
  const s = run.store.get();
  const retried = new Set(run.job.recordIds);
  const stillFailing = s.failures;
  const kept = parent.failures.filter((f) => !retried.has(f.recordId));
  parent.failures = [...kept, ...stillFailing];
  parent.failure = parent.failures.length;
  parent.success = Math.max(0, parent.total - parent.failure);
  parent.status = parent.failure === 0 ? 'completed' : 'completed_with_errors';
  parent.errorSummary = summarise(parent.failures);
  await db.jobs.put(parent);
}

export { recordContent };
