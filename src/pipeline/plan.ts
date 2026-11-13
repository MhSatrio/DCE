/** Configuration, scheduling and selection rules of the content pipeline (pure: `now` and all data are passed in). */
import { DEFAULT_BANNED, DEFAULT_MAX_CHARS, DEFAULT_VOICE } from './guard';
import { AUTO_MODEL, DEFAULT_MODEL } from './gemini';
import type { Candidate } from './extract';
import type { PostRow, SourceRow } from '../db/schema';

/** simulation: nothing is sent · approval: held on the Posts tab until you click Approve · auto: sent to Buffer by itself ·
 *  table: written as a row of the synced table (Approval = Draft); the “Post approved rows” automation sends it once approved. */
export type PipelineMode = 'simulation' | 'approval' | 'auto' | 'table';

export interface PipelineConfig {
  enabled: boolean;               // daily schedule on / off (Run now always works)
  dailyTime: string;              // "09:00" local time
  mode: PipelineMode;
  connectionId: string;           // '' = the active Buffer account
  channels: string[];             // Buffer channel property keys; every approved post goes to all of them
  publish: 'queue' | 'time';      // next queue slot, or a fixed time of day
  publishTime: string;            // "12:30" local time (publish = 'time')
  model: string;
  geminiBase: string;             // '' = Google's endpoint
  voice: string;
  banned: string;                 // one phrase per line
  maxChars: number;               // limit before the link
  maxCandidates: number;          // pages tried per run before giving up
  syncTable: string;              // '' = off; otherwise the id of a table that mirrors every post (one-way)
  schedule: 'daily' | 'dates';    // every day at dailyTime, or only on the chosen dates
  dates: string[];                // "YYYY-MM-DD" days of the run when schedule = 'dates'
  order: 'newest' | 'oldest';     // which unused page is drafted first
  prompt: string;                 // the writing instructions (placeholders {{title}} {{url}} {{summary}} {{text}} {{voice}} {{max_chars}}); '' = the default
}

export const DEFAULT_CONFIG: PipelineConfig = {
  enabled: false, dailyTime: '09:00', mode: 'simulation', connectionId: '', channels: [], publish: 'queue', publishTime: '12:00',
  model: DEFAULT_MODEL, geminiBase: '', voice: DEFAULT_VOICE, banned: DEFAULT_BANNED.join('\n'), maxChars: DEFAULT_MAX_CHARS, maxCandidates: 4, syncTable: '', schedule: 'daily', dates: [], order: 'newest', prompt: '',
};

/** Google no longer offers this model to new keys; a 1.1.0 install stored it as the default, so it is replaced once. */
export const RETIRED_MODEL = 'gemini-2.5-flash';
/** A model name as typed or chosen: trimmed, a "models/" prefix removed, empty = Auto. */
export function normaliseModel(m: unknown): string {
  const s = typeof m === 'string' ? m.trim().replace(/^models\//, '') : '';
  return s || AUTO_MODEL;
}

export interface PipelineAlert { at: number; kind: string; message: string }
export interface PipelineState { day: string; done: boolean; attempts: number; lastAttempt: number; alert?: PipelineAlert }
export const EMPTY_STATE: PipelineState = { day: '', done: false, attempts: 0, lastAttempt: 0 };

export const PIPE_MAX_ATTEMPTS = 3;
export const PIPE_RETRY_MS = 5 * 60_000;

export const localDay = (now: number): string => {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export function atLocalTime(day: string, hhmm: string): number {
  const [y, m, d] = day.split('-').map(Number);
  const [h, mi] = /^\d{1,2}:\d{2}$/.test(hhmm) ? hhmm.split(':').map(Number) : [9, 0];
  return new Date(y, m - 1, d, h, mi, 0, 0).getTime();
}

export type Due = { run: false; why: string } | { run: true; trigger: 'schedule' | 'retry' };

/**
 * Should the daily run start now? It runs once per local day at/after `dailyTime`. If DCE was closed at that time it catches up
 * when opened. A failed attempt is retried after 5 minutes, at most 3 attempts a day; after that it waits for tomorrow.
 */
export function dueDecision(cfg: PipelineConfig, st: PipelineState, now: number): Due {
  if (!cfg.enabled) return { run: false, why: 'The schedule is off.' };
  const today = localDay(now);
  if (cfg.schedule === 'dates' && !(cfg.dates ?? []).includes(today)) return { run: false, why: 'Today is not one of the chosen dates.' };
  if (now < atLocalTime(today, cfg.dailyTime)) return { run: false, why: `Waiting for ${cfg.dailyTime}.` };
  if (st.day !== today) return { run: true, trigger: 'schedule' };
  if (st.done) return { run: false, why: 'Already done today.' };
  if (st.attempts >= PIPE_MAX_ATTEMPTS) return { run: false, why: 'Gave up for today after 3 attempts.' };
  if (now - st.lastAttempt < PIPE_RETRY_MS) return { run: false, why: 'Waiting before the retry.' };
  return { run: true, trigger: 'retry' };
}

/** ISO time for Buffer's `customScheduled`: today at `publishTime`, or tomorrow when that is less than 2 minutes away. */
export function publishDueAt(cfg: PipelineConfig, now: number): string | undefined {
  if (cfg.publish !== 'time') return undefined;
  let t = atLocalTime(localDay(now), cfg.publishTime);
  if (t < now + 2 * 60_000) { const d = new Date(t); d.setDate(d.getDate() + 1); t = d.getTime(); }
  return new Date(t).toISOString();
}

// ------------------------------------------------------------------------------------------------ selection

/**
 * URLs that must not be posted again. Failed sends can be retried, and simulated posts only block a URL while the
 * pipeline is still in simulation mode (so switching to real publishing does not skip pages that were only rehearsed).
 */
export function usedUrls(posts: Pick<PostRow, 'url' | 'status'>[], mode: PipelineMode): Set<string> {
  return new Set(posts.filter((p) => p.status !== 'failed' && (p.status !== 'simulated' || mode === 'simulation')).map((p) => p.url));
}

/** Sources in the order to try: enabled ones, the one posted from least recently first (so sources take turns). */
export function sourceOrder(sources: SourceRow[], posts: Pick<PostRow, 'sourceId' | 'created_at'>[]): SourceRow[] {
  const last = new Map<string, number>();
  for (const p of posts) last.set(p.sourceId, Math.max(last.get(p.sourceId) ?? 0, p.created_at));
  return sources.filter((s) => s.enabled).sort((a, b) => (last.get(a.id) ?? 0) - (last.get(b.id) ?? 0) || a.created_at - b.created_at);
}

const section = (u: string) => { try { return new URL(u).pathname.split('/')[1] ?? ''; } catch { return ''; } };

/** Unused pages, newest first; among the 30 newest, a different section (first path part) than the last post comes first. */
export function pickCandidates(cands: Candidate[], used: Set<string>, lastUrl: string | undefined, limit: number, order: 'newest' | 'oldest' = 'newest'): Candidate[] {
  const unused = cands.filter((c) => !used.has(c.url));
  const fresh = order === 'oldest' ? [...unused].reverse() : unused;
  const head = fresh.slice(0, 30);
  const last = lastUrl ? section(lastUrl) : undefined;
  const other = last === undefined ? [] : head.filter((c) => section(c.url) !== last);
  const rest = head.filter((c) => !other.includes(c));
  return [...other, ...rest, ...fresh.slice(30)].slice(0, limit);
}

/**
 * `count` different random days between `from` and `to` (both "YYYY-MM-DD", inclusive), sorted. Pure: the random source is
 * injected. Returns fewer days when the window has fewer days, and nothing when the window is empty or reversed.
 */
export function randomDates(from: string, to: string, count: number, rng: () => number): string[] {
  const start = new Date(`${from}T00:00`);
  const end = new Date(`${to}T00:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) return [];
  const pool: string[] = [];
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) pool.push(localDay(d.getTime()));
  const picked: string[] = [];
  while (pool.length > 0 && picked.length < count) {
    const i = Math.floor(rng() * pool.length);
    picked.push(pool.splice(i, 1)[0]);
  }
  return picked.sort();
}
