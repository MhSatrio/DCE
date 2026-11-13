/**
 * Stop button and time limits for the content pipeline. A run owns one AbortController; every network wait (page reads,
 * Gemini calls, retry pauses) listens to it, so "Stop run" takes effect at once instead of after a hung request.
 */
export class StoppedError extends Error {
  constructor() { super('Stopped by you.'); this.name = 'StoppedError'; }
}

export interface Linked { signal: AbortSignal; timedOut: () => boolean; done: () => void }

/** A signal that fires when `parent` aborts or after `ms`. Call done() when the request is over. */
export function linked(parent: AbortSignal | undefined, ms: number): Linked {
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, ms);
  const onParent = () => ctl.abort();
  if (parent?.aborted) ctl.abort();
  else parent?.addEventListener('abort', onParent, { once: true });
  return {
    signal: ctl.signal,
    timedOut: () => timedOut,
    done: () => { clearTimeout(timer); parent?.removeEventListener('abort', onParent); },
  };
}

/** Waits `ms`, but rejects with StoppedError as soon as the signal aborts. */
export function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new StoppedError()); return; }
    const onAbort = () => { clearTimeout(timer); reject(new StoppedError()); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
