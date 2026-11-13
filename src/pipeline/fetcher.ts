/**
 * Reads public web pages through the local relay (POST /fetch). The relay — not this file — enforces robots.txt, the
 * 1-request-per-second limit per host, the host allow-list (only your configured sources) and the private-address block.
 */
import { DEFAULT_RELAY } from '../automation/buffer';
import { linked, sleepAbortable, StoppedError } from './abort';

export interface PageResult { ok: boolean; status: number; url?: string; contentType?: string; body?: string; error?: string; blocked?: 'robots' | 'host' | 'private' | 'scheme'; truncated?: boolean }

export class FetchError extends Error {
  constructor(public kind: 'blocked' | 'down' | 'relay' | 'missing', message: string) { super(message); }
  get retryable() { return this.kind === 'down' || this.kind === 'relay'; }
}

/** The relay may need up to ~15 s per page (its own limit); anything longer is treated as a broken helper. */
const RELAY_TIMEOUT_MS = 40_000;

export async function fetchPage(relay: string, url: string, hosts: string[], signal?: AbortSignal): Promise<PageResult> {
  const base = (relay || DEFAULT_RELAY).replace(/\/+$/, '');
  const req = linked(signal, RELAY_TIMEOUT_MS);
  try {
    let res: Response;
    try {
      res = await fetch(`${base}/fetch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url, hosts }), signal: req.signal });
    } catch {
      if (signal?.aborted) throw new StoppedError();
      if (req.timedOut()) throw new FetchError('relay', `The local helper did not answer within 40 seconds (${base}). Restart the app.`);
      throw new FetchError('relay', `Cannot reach the local helper at ${base}. In the desktop app it starts automatically; in a browser run "npm run relay".`);
    }
    if (res.status === 404) throw new FetchError('relay', 'The local helper is an older version without page reading. Update or restart it (npm run relay).');
    let j: PageResult;
    try { j = (await res.json()) as PageResult; } catch { throw new FetchError('relay', `The local helper answered HTTP ${res.status} with no usable body.`); }
    return j;
  } finally { req.done(); }
}

/** Fetches with up to two retries (3 s, 8 s) when the site seems to be down; robots / host blocks and 4xx are final. */
export async function fetchWithRetry(
  relay: string, url: string, hosts: string[],
  opts: { sleep?: (ms: number) => Promise<void>; delays?: number[]; onRetry?: (why: string, n: number) => void; signal?: AbortSignal } = {},
): Promise<PageResult> {
  const delays = opts.delays ?? [3000, 8000];
  const sleep = opts.sleep ?? ((ms: number) => sleepAbortable(ms, opts.signal));
  for (let i = 0; ; i++) {
    let r: PageResult | null = null;
    let err: FetchError | null = null;
    try { r = await fetchPage(relay, url, hosts, opts.signal); }
    catch (e) {
      if (e instanceof StoppedError) throw e;
      err = e instanceof FetchError ? e : new FetchError('relay', String(e));
    }
    if (r?.ok) return r;
    const transient = err ? err.retryable : !r!.blocked && (r!.status === 0 || r!.status === 429 || r!.status >= 500);
    if (!transient || i >= delays.length) {
      if (err) throw err;
      return r!;
    }
    opts.onRetry?.(err?.message ?? r!.error ?? 'error', i + 1);
    await sleep(delays[i]);
  }
}
