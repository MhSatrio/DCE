import { useSyncExternalStore } from 'react';

export interface Store<T> {
  get(): T;
  set(next: Partial<T> | ((s: T) => Partial<T>)): void;
  subscribe(fn: () => void): () => void;
}

export function createStore<T extends object>(initial: T): Store<T> {
  let state = initial;
  const subs = new Set<() => void>();
  return {
    get: () => state,
    set(next) {
      const patch = typeof next === 'function' ? next(state) : next;
      state = { ...state, ...patch };
      subs.forEach((f) => f());
    },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
  };
}

/** Selector must return a referentially stable value (a field of the state, not a fresh object). */
export function useStore<T extends object, S>(store: Store<T>, selector: (s: T) => S): S {
  return useSyncExternalStore(store.subscribe, () => selector(store.get()), () => selector(store.get()));
}

// ---------- notifications ----------
export interface Toast { id: number; kind: 'success' | 'error' | 'info' | 'warn'; text: string }
export const toasts = createStore<{ list: Toast[] }>({ list: [] });
let tid = 1;
export function notify(kind: Toast['kind'], text: string, ms = kind === 'error' ? 8000 : 3800): void {
  const id = tid++;
  toasts.set((s) => ({ list: [...s.list.slice(-4), { id, kind, text }] }));
  setTimeout(() => toasts.set((s) => ({ list: s.list.filter((t) => t.id !== id) })), ms);
}
export function dismissToast(id: number): void {
  toasts.set((s) => ({ list: s.list.filter((t) => t.id !== id) }));
}

/** Runs a storage operation; turns IndexedDB failures (quota, blocked) into a readable message. */
export async function guard<T>(what: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (e) {
    const err = e as { name?: string; message?: string };
    if (err?.name === 'QuotaExceededError' || /quota/i.test(err?.message ?? '')) {
      notify('error', `${what}: browser storage is full. Delete unused assets or batch history, or export and clear data.`);
    } else {
      notify('error', `${what}: ${err?.message ?? String(e)}`);
    }
    return undefined;
  }
}

// ---------- confirm dialog (promise based) ----------
export interface ConfirmReq { title: string; body: string; confirmLabel: string; danger?: boolean; resolve: (ok: boolean) => void }
export const confirmStore = createStore<{ req: ConfirmReq | null }>({ req: null });
export function confirmAction(title: string, body: string, confirmLabel = 'Delete', danger = true): Promise<boolean> {
  return new Promise((resolve) => confirmStore.set({ req: { title, body, confirmLabel, danger, resolve } }));
}
