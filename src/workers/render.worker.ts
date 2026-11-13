/// <reference lib="webworker" />
import { ensureJost, registerFontData } from '../engine/fonts';
import { renderDoc, RenderFailure, releaseCanvas, type ImageProvider } from '../engine/render';
import type { ImageLike } from '../engine/scene';
import type { NjsDoc } from '../engine/types';
import type { FromWorker, ToWorker, WorkerOpts } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

let doc: NjsDoc | null = null;
let opts: WorkerOpts | null = null;

// Small LRU of decoded bitmaps (logos / backgrounds shared by every record). Bounded → memory-safe.
const bitmaps = new Map<string, ImageBitmap>();
const MAX_BITMAPS = 24;
function remember(ref: string, bm: ImageBitmap): void {
  bitmaps.delete(ref); bitmaps.set(ref, bm);
  while (bitmaps.size > MAX_BITMAPS) {
    const k = bitmaps.keys().next().value as string;
    bitmaps.get(k)?.close();
    bitmaps.delete(k);
  }
}

const post = (m: FromWorker, transfer: Transferable[] = []) => self.postMessage(m, transfer);

self.onmessage = async (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  try {
    if (m.type === 'setup') {
      doc = m.doc; opts = m.opts;
      await ensureJost();
      for (const f of m.fonts) await registerFontData(f);
      bitmaps.forEach((b) => b.close()); bitmaps.clear();
      post({ type: 'ready' });
      return;
    }
    if (m.type === 'render' && doc && opts) {
      const t0 = performance.now();
      const provider: ImageProvider = {
        async load(refs) {
          const out = new Map<string, ImageLike | null>();
          await Promise.all(refs.map(async (ref) => {
            const cached = bitmaps.get(ref);
            if (cached) { out.set(ref, cached); return; }
            try {
              let blob: Blob | undefined = m.blobs[ref];
              if (!blob && /^(https?:|data:)/i.test(ref)) {
                const r = await fetch(ref);
                if (r.ok) blob = await r.blob();
              }
              if (!blob) { out.set(ref, null); return; }
              const bm = await createImageBitmap(blob);
              remember(ref, bm);
              out.set(ref, bm);
            } catch { out.set(ref, null); }
          }));
          return out;
        },
      };
      try {
        const out = await renderDoc(doc, m.data, provider, { ...opts, failOnError: true });
        post(
          { type: 'done', seq: m.seq, bytes: out.bytes.buffer as ArrayBuffer, ext: out.ext, width: out.width, height: out.height, issues: out.issues, ms: performance.now() - t0 },
          [out.bytes.buffer as ArrayBuffer],
        );
      } catch (err) {
        post({ type: 'fail', seq: m.seq, error: err instanceof Error ? err.message : String(err), issues: err instanceof RenderFailure ? err.issues : [] });
      }
      if (bitmaps.size === 0) releaseCanvas();
    }
  } catch (err) {
    post({ type: 'fatal', error: err instanceof Error ? err.message : String(err) });
  }
};
