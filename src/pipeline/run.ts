/**
 * The content pipeline: pick a public page → read it politely → write a post with Gemini → check it twice → simulate,
 * hold for approval, or schedule it in Buffer. Runs from the daily schedule, from "Run now", and as retries.
 *
 * Visibility: every run publishes its current stage and a timestamped log to `runStore` (shown on every page while it runs)
 * and writes the same log to the run log as it goes. "Stop run" aborts the run at once, including requests in flight.
 */
import { createPost, DEFAULT_RELAY } from '../automation/buffer';
import { resolveBufferCredentials } from '../automation/engine';
import { channelLabel, readGeminiKey } from '../db/connections';
import { allTables, deleteRows } from '../db/tables';
import { db, getSetting, setSetting, type PipeRunRow, type PostChannel, type PostRow, type SourceRow } from '../db/schema';
import { uid } from '../engine/njs';
import { createStore, notify } from '../ui/store';
import { StoppedError } from './abort';
import { composePost, type ComposeDeps } from './compose';
import { hostOf, normUrl, parseFeed, parsePage, parseSitemap, sniffFeed, toCandidates, type Candidate, type SitemapEntry } from './extract';
import { fetchWithRetry, FetchError, type PageResult } from './fetcher';
import { AUTO_MODEL, GeminiError, generate, listModels, pickModel, withBackoff } from './gemini';
import { checkEdited, failedRules } from './guard';
import {
  DEFAULT_CONFIG, EMPTY_STATE, localDay, normaliseModel, PIPE_MAX_ATTEMPTS, RETIRED_MODEL, dueDecision, pickCandidates, publishDueAt, sourceOrder, usedUrls,
  type PipelineAlert, type PipelineConfig, type PipelineMode, type PipelineState,
} from './plan';
import { syncPostsToTable } from './sync';

// ------------------------------------------------------------------------------------------------ settings

/** Read-only (it is used inside live queries, where Dexie forbids writes). */
export async function getConfig(): Promise<PipelineConfig> {
  const stored = await getSetting<Partial<PipelineConfig>>('pipeline.config', {});
  const migrated = await getSetting<boolean>('pipeline.modelMigrated', false);
  // until the one-time migration has run, the 1.1.0 default model is read as Auto
  const model = !migrated && stored.model === RETIRED_MODEL ? AUTO_MODEL : stored.model;
  return { ...DEFAULT_CONFIG, ...stored, model: normaliseModel(model) };
}

/**
 * One-time: version 1.1.0 stored the old default model, which new keys can no longer use, so it becomes Auto.
 * Whatever is chosen afterwards is kept. Called from places that are not live queries.
 */
export async function migrateModelOnce(): Promise<void> {
  if (await getSetting<boolean>('pipeline.modelMigrated', false)) return;
  const stored = await getSetting<Partial<PipelineConfig>>('pipeline.config', {});
  if (!stored.model || stored.model === RETIRED_MODEL) await setSetting('pipeline.config', { ...DEFAULT_CONFIG, ...stored, model: AUTO_MODEL });
  await setSetting('pipeline.modelMigrated', true);
}
export async function setConfig(patch: Partial<PipelineConfig>): Promise<PipelineConfig> {
  const next = { ...(await getConfig()), ...patch };
  await setSetting('pipeline.config', next);
  return next;
}
export async function getState(): Promise<PipelineState> {
  return { ...EMPTY_STATE, ...(await getSetting<Partial<PipelineState>>('pipeline.state', {})) };
}
async function setState(patch: Partial<PipelineState>): Promise<void> {
  await setSetting('pipeline.state', { ...(await getState()), ...patch });
}
export async function clearAlert(): Promise<void> { await setState({ alert: undefined }); }

export const SOURCE_PRESETS: Record<'vier' | 'placidway', Omit<SourceRow, 'id' | 'created_at'>> = {
  vier: { name: 'VierApparatus', baseUrl: 'https://vierapparatus.com', feedUrl: 'https://vierapparatus.com/sitemap.xml', include: '/articles/', exclude: '', enabled: true, simulationOnly: false },
  placidway: { name: 'PlacidWay (assessment — simulation only)', baseUrl: 'https://www.placidway.com', feedUrl: 'https://www.placidway.com/1/sitemap_articles.xml', include: '', exclude: '', enabled: true, simulationOnly: true },
};

export async function addSource(s: Omit<SourceRow, 'id' | 'created_at'>): Promise<SourceRow> {
  const row: SourceRow = { ...s, id: uid(), created_at: Date.now(), baseUrl: s.baseUrl.trim().replace(/\/+$/, ''), feedUrl: s.feedUrl.trim(), name: s.name.trim() || hostOf(s.baseUrl) };
  await db.sources.put(row);
  return row;
}

/** First start: the two sources of the assessment. Both can be edited or deleted at any time. */
export async function seedSources(): Promise<void> {
  await migrateModelOnce();
  if (await getSetting<boolean>('pipeline.seeded', false)) return;
  await setSetting('pipeline.seeded', true);
  if ((await db.sources.count()) > 0) return;
  await addSource(SOURCE_PRESETS.vier);
  await addSource(SOURCE_PRESETS.placidway);
}

// ------------------------------------------------------------------------------------------------ live run status

export interface RunLine { at: number; text: string; stage: boolean }
export interface ActiveRun {
  id: string;
  trigger: RunOptions['trigger'];
  mode: PipelineMode;
  startedAt: number;
  stage: string;          // what it is doing right now
  stageAt: number;
  lastAt: number;         // last sign of progress (any line)
  lines: RunLine[];       // the log, newest last (capped)
  stopping: boolean;      // "Stop run" was pressed and the run is winding down
  source: string;
  page: string;
}
/** The run in progress, shown on every page (see RunBanner) and on the Content pipeline page. null = nothing running. */
export const runStore = createStore<{ active: ActiveRun | null }>({ active: null });

// ------------------------------------------------------------------------------------------------ helpers

export type RunKind = 'ok' | 'auth' | 'quota' | 'site' | 'relay' | 'buffer' | 'content' | 'config' | 'busy' | 'cancelled' | 'skipped';
export interface RunSummary { ok: boolean; kind: RunKind; message: string; retryable: boolean; post?: PostRow }

class RunFail extends Error {
  constructor(public kind: RunKind, message: string, public retryable: boolean) { super(message); }
}

export interface Deps {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  models: (key: string, base: string, signal?: AbortSignal) => Promise<string[]>;
  fetchPage: (relay: string, url: string, hosts: string[], onRetry: (why: string, n: number) => void, signal?: AbortSignal) => Promise<PageResult>;
  llm: (key: string, prompt: { system: string; user: string }, o: { model: string; base: string; json: boolean; temperature: number; signal?: AbortSignal }, onRetry: (e: GeminiError, n: number) => void) => Promise<string>;
}
export const realDeps: Deps = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  models: (key, base, signal) => listModels(key, base || undefined, signal),
  fetchPage: (relay, url, hosts, onRetry, signal) => fetchWithRetry(relay, url, hosts, { onRetry, signal }),
  llm: (key, p, o, onRetry) => withBackoff(() => generate(key, p.user, { system: p.system, model: o.model, base: o.base || undefined, json: o.json, temperature: o.temperature, signal: o.signal }), { onRetry, signal: o.signal }),
};

/** Auto: the newest Flash model the key lists. A chosen model is used as it is (a retired one fails with a clear message). */
async function resolveModel(key: string, cfg: PipelineConfig, deps: Deps, step: (t: string) => void, signal?: AbortSignal): Promise<string> {
  if (cfg.model !== AUTO_MODEL) return cfg.model;
  let names: string[];
  try { names = await deps.models(key, cfg.geminiBase, signal); }
  catch (e) {
    if (e instanceof GeminiError) throw new RunFail(e.kind === 'auth' ? 'auth' : e.kind === 'quota' ? 'quota' : 'site', e.message, e.retryable);
    throw e;
  }
  await setSetting('gemini.models', { at: deps.now(), names });
  const m = pickModel(names);
  if (!m) throw new RunFail('config', 'Your key lists no Gemini text model. Check the key in Settings → Gemini.', false);
  step(`Model: “${m}” — the newest Flash model your key can use (Auto)`);
  return m;
}

/** Asks Google which models the saved key may use and remembers the answer for the model dropdown. */
export async function refreshModels(): Promise<{ at: number; names: string[] }> {
  const key = await readGeminiKey();
  if (!key) throw new GeminiError('auth', 'No Gemini API key is stored yet. Add it in Settings → Gemini.');
  const cfg = await getConfig();
  const cache = { at: Date.now(), names: await realDeps.models(key, cfg.geminiBase) };
  await setSetting('gemini.models', cache);
  return cache;
}
export async function getModelCache(): Promise<{ at: number; names: string[] }> {
  return getSetting('gemini.models', { at: 0, names: [] as string[] });
}

const hostsOf = (s: SourceRow) => [...new Set([hostOf(s.baseUrl), hostOf(s.feedUrl)].filter(Boolean))];
const httpsOnly = (u?: string) => (u && /^https:\/\//i.test(u) ? u : undefined);

async function readText(url: string, s: SourceRow, relay: string, deps: Deps, step: (t: string) => void, signal?: AbortSignal): Promise<string> {
  let r: PageResult;
  try { r = await deps.fetchPage(relay, url, hostsOf(s), (why, n) => step(`Retrying ${url} (${n}): ${why}`), signal); }
  catch (e) { if (e instanceof FetchError) throw new RunFail('relay', e.message, true); throw e; }
  if (r.ok) return r.body ?? '';
  if (r.blocked === 'robots') throw new RunFail('site', `${r.error} DCE respects robots.txt, so this source cannot be used for that page.`, false);
  if (r.blocked) throw new RunFail('config', r.error ?? 'Blocked.', false);
  if (r.status === 404 || r.status === 410) throw new RunFail('site', `${url} does not exist (HTTP ${r.status}). Check the sitemap / feed address of the source.`, false);
  throw new RunFail('site', `${s.name} could not be read: ${r.error ?? 'unknown error'}`, true);
}

const preferChild = (loc: string) => (/article|blog|news|post|stor/i.test(loc) ? 0 : 1);

/** Sitemap / RSS / Atom → candidate pages (newest first). Sitemap indexes are followed (at most 3 children, article-like first). */
export async function loadCandidates(s: SourceRow, relay: string, deps: Deps, step: (t: string) => void, signal?: AbortSignal): Promise<Candidate[]> {
  const feed = s.feedUrl.trim() || new URL('/sitemap.xml', s.baseUrl).href;
  step(`Reading ${feed}`);
  const xml = await readText(feed, s, relay, deps, step, signal);
  const kind = sniffFeed(xml);
  let entries: SitemapEntry[] = [];
  if (kind === 'index') {
    const kids = parseSitemap(xml).entries.map((e) => e.loc).sort((a, b) => preferChild(a) - preferChild(b)).slice(0, 3);
    step(`Sitemap index with ${kids.length} sitemap(s) to read`);
    for (const k of kids) {
      const x = await readText(k, s, relay, deps, step, signal);
      const kk = sniffFeed(x);
      if (kk === 'urlset') entries.push(...parseSitemap(x).entries); else if (kk === 'feed') entries.push(...parseFeed(x));
    }
  } else if (kind === 'urlset') entries = parseSitemap(xml).entries;
  else if (kind === 'feed') entries = parseFeed(xml);
  else throw new RunFail('site', `${feed} is neither a sitemap nor an RSS/Atom feed. Change the “Sitemap or feed” address of this source.`, false);
  const out = toCandidates(entries, s.baseUrl, s.include, s.exclude);
  step(`${entries.length} URL(s) listed, ${out.length} match this source's rules`);
  return out;
}

/** "Check source" button: can we read it, and how many pages would qualify? Sends nothing, uses no AI quota. */
export async function checkSource(id: string, deps: Deps = realDeps): Promise<{ ok: boolean; found: number; sample: string[]; message: string }> {
  const s = await db.sources.get(id);
  if (!s) return { ok: false, found: 0, sample: [], message: 'Source not found.' };
  const relay = await getSetting<string>('relay.url', DEFAULT_RELAY);
  let res: { ok: boolean; found: number; sample: string[]; message: string };
  try {
    const c = await loadCandidates(s, relay, deps, () => undefined);
    res = { ok: c.length > 0, found: c.length, sample: c.slice(0, 5).map((x) => x.url), message: c.length ? `${c.length} page${c.length === 1 ? '' : 's'} can be used.` : 'The sitemap was read, but no page matches the include / exclude rules.' };
  } catch (e) { res = { ok: false, found: 0, sample: [], message: e instanceof Error ? e.message : String(e) }; }
  await db.sources.update(id, { lastCheck: { at: Date.now(), ok: res.ok, found: res.found, message: res.message } });
  return res;
}

// ------------------------------------------------------------------------------------------------ publishing

async function sendToBuffer(text: string, imageUrl: string | undefined, cfg: PipelineConfig, now: number, relay: string): Promise<{ channels: PostChannel[]; sent: number; authFailed: boolean }> {
  const dueAt = publishDueAt(cfg, now);
  const channels: PostChannel[] = [];
  let authFailed = false;
  for (const key of cfg.channels) {
    const ch: PostChannel = { key, label: channelLabel(key) };
    channels.push(ch);
    if (/INSTAGRAM/i.test(key) && !imageUrl) { ch.skipped = 'Instagram needs an image and the page has none.'; continue; }
    const cred = await resolveBufferCredentials(cfg.connectionId, key);
    if ('error' in cred) { ch.error = cred.error; continue; }
    const r = await createPost(relay, cred.apiKey, { text, channelId: cred.channelId, imageUrl, mode: dueAt ? 'scheduled' : 'queue', dueAt });
    if (r.ok) { ch.postId = r.postId; ch.dueAt = r.dueAt ?? dueAt; } else { ch.error = r.error ?? 'Buffer error'; if (/rejected the API key|unauthori[sz]ed|token/i.test(ch.error)) authFailed = true; }
  }
  return { channels, sent: channels.filter((c) => c.postId).length, authFailed };
}

const describeChannels = (cs: PostChannel[]) => cs.map((c) => `${c.label}: ${c.postId ? `scheduled${c.dueAt ? ' for ' + new Date(c.dueAt).toLocaleString() : ' (next queue slot)'} · id ${c.postId}` : c.skipped ?? c.error ?? 'not sent'}`).join(' | ');

/** Keeps the chosen table in step with the posts. Silent when it works; a message when it does not. */
async function syncAfterChange(): Promise<void> {
  try { await syncIfEnabled(); }
  catch (e) { notify('error', `Sync to the table failed: ${e instanceof Error ? e.message : String(e)}`, 9000); }
}

/** Writes all posts to the chosen table (if one is chosen). Returns the number of rows written, 0 when syncing is off. */
export async function syncIfEnabled(): Promise<number> {
  const cfg = await getConfig();
  if (!cfg.syncTable) return 0;
  if (!allTables().some((t) => t.id === cfg.syncTable)) {
    await setConfig({ syncTable: '' });
    notify('warn', 'The table that posts were synced to was deleted, so syncing is off. Choose a table on the Posts tab.', 9000);
    return 0;
  }
  const posts = await db.posts.orderBy('created_at').toArray();
  return (await syncPostsToTable(cfg.syncTable, posts)).rows;
}

/** Approval mode: the reviewer clicked Approve. Re-checks the (possibly edited) text first, then creates the post(s) in Buffer. */
export async function approvePost(id: string, deps: Deps = realDeps): Promise<{ ok: boolean; message: string }> {
  const p = await db.posts.get(id);
  if (!p || p.status !== 'pending') return { ok: false, message: 'Only posts waiting for approval can be approved.' };
  const cfg = await getConfig();
  const bad = failedRules(checkEdited(p.text, { url: p.url, text: p.sourceExcerpt }, { maxChars: cfg.maxChars, bannedPhrases: cfg.banned.split('\n') }));
  if (bad.length) return { ok: false, message: `Not sent — the text breaks a guardrail: ${bad.map((b) => b.message).join(' ')}` };
  if (cfg.channels.length === 0) return { ok: false, message: 'Choose at least one Buffer channel in the pipeline settings first.' };
  const relay = await getSetting<string>('relay.url', DEFAULT_RELAY);
  const r = await sendToBuffer(p.text, p.imageUrl, cfg, deps.now(), relay);
  const status = r.sent > 0 ? 'sent' : 'failed';
  await db.posts.update(id, { status, channels: r.channels, detail: `${status === 'sent' ? 'Approved and sent to Buffer. ' : 'Approved, but Buffer did not accept it. '}${describeChannels(r.channels)}`, updated_at: deps.now() });
  await syncAfterChange();
  if (status === 'failed') return { ok: false, message: describeChannels(r.channels) };
  return { ok: true, message: describeChannels(r.channels) };
}

export async function rejectPost(id: string): Promise<void> {
  await db.posts.update(id, { status: 'rejected', detail: 'Rejected by the reviewer.', updated_at: Date.now() });
  await syncAfterChange();
}

/** Reviewer edits the text: the rules run again on the new text (the model reviewer is not re-run). */
export async function editPost(id: string, text: string): Promise<{ ok: boolean; issues: string[] }> {
  const p = await db.posts.get(id);
  if (!p) return { ok: false, issues: ['Post not found.'] };
  const cfg = await getConfig();
  const rules = checkEdited(text, { url: p.url, text: p.sourceExcerpt }, { maxChars: cfg.maxChars, bannedPhrases: cfg.banned.split('\n') });
  await db.posts.update(id, { text, guard: { rules, attempts: p.guard?.attempts ?? 1, verifier: { ok: true, issues: [], skipped: 'Edited by a human reviewer — the model fact-check was not repeated.' } }, updated_at: Date.now() });
  await syncAfterChange();
  return { ok: failedRules(rules).length === 0, issues: failedRules(rules).map((r) => r.message) };
}

/** Deletes a post record and, when syncing, its row in the table. Buffer is not touched. */
export async function deletePost(id: string): Promise<void> {
  await db.posts.delete(id);
  const cfg = await getConfig();
  if (cfg.syncTable && allTables().some((t) => t.id === cfg.syncTable)) await deleteRows(cfg.syncTable, [id]);
}

// ------------------------------------------------------------------------------------------------ the run

let busy = false;
let controller: AbortController | null = null;
let activeRunId = '';
export const isRunning = () => busy;

/** "Stop run": aborts the run in progress, including Gemini / page requests that are waiting for an answer. */
export function stopPipelineRun(): boolean {
  if (!controller) return false;
  controller.abort();
  runStore.set((s) => (s.active ? { active: { ...s.active, stopping: true, stage: 'Stopping…' } } : {}));
  return true;
}

/** A single page handed in by a workflow or a website job, instead of the sitemap of a source. */
export interface CandidateOptions { url: string; title: string; summary: string; image?: string; sourceName: string }
export interface RunOptions { trigger: 'schedule' | 'retry' | 'manual'; sourceId?: string; deps?: Partial<Deps>; candidate?: CandidateOptions }

const originOf = (u: string) => { try { return new URL(u).origin; } catch { return ''; } };
function candidateSource(c: CandidateOptions): SourceRow {
  return { id: `website:${hostOf(c.url)}`, name: c.sourceName, baseUrl: originOf(c.url), feedUrl: '', include: '', exclude: '', enabled: true, simulationOnly: false, created_at: 0 };
}
function candidateOf(c: CandidateOptions): Candidate {
  return { loc: c.url, url: normUrl(c.url), title: c.title, summary: c.summary, image: c.image };
}

/** The Gemini model a single call should use: the chosen one, or the newest Flash model the key lists (Auto). */
export async function modelForGemini(): Promise<string> {
  const cfg = await getConfig();
  if (cfg.model !== AUTO_MODEL) return cfg.model;
  let names = (await getModelCache()).names;
  if (!names.length) names = (await refreshModels()).names;
  const m = pickModel(names);
  if (!m) throw new Error('Your Gemini key lists no text model. Check the key in Settings → Gemini.');
  return m;
}

export async function runPipeline(o: RunOptions): Promise<RunSummary> {
  if (busy) return { ok: false, kind: 'busy', message: 'A run is already in progress — it is shown at the top of the page, where you can stop it.', retryable: false };
  busy = true;
  const runId = uid();
  activeRunId = runId;
  const ctl = new AbortController();
  controller = ctl;
  const signal = ctl.signal;
  const deps: Deps = { ...realDeps, ...o.deps };
  const started = deps.now();
  const steps: string[] = [];
  let mode: PipelineMode = 'simulation';
  let summary: RunSummary = { ok: false, kind: 'site', message: 'The run did not start.', retryable: false };
  let logSource = '', logUrl = '', logTitle = '', logText = '';

  const persist = (patch: Partial<PipeRunRow>) => { void db.pipeRuns.update(runId, patch).catch(() => undefined); };
  const line = (text: string, stage: boolean) => {
    steps.push(text);
    const at = deps.now();
    runStore.set((s) => (s.active?.id === runId
      ? { active: { ...s.active, lastAt: at, stage: stage ? text : s.active.stage, stageAt: stage ? at : s.active.stageAt, lines: [...s.active.lines.slice(-199), { at, text, stage }] } }
      : {}));
    persist({ steps: [...steps], detail: text, mode, sourceName: logSource, url: logUrl, title: logTitle });
  };
  const step = (t: string) => line(t, false);
  const stage = (t: string) => line(t, true);
  const info = (patch: Partial<ActiveRun>) => runStore.set((s) => (s.active?.id === runId ? { active: { ...s.active, ...patch } } : {}));
  const checkStop = () => { if (signal.aborted) throw new StoppedError(); };

  try {
    await migrateModelOnce();
    const cfg = await getConfig();
    mode = cfg.mode;
    const startedAt = deps.now();
    runStore.set({ active: { id: runId, trigger: o.trigger, mode, startedAt, stage: 'Starting…', stageAt: startedAt, lastAt: startedAt, lines: [], stopping: false, source: '', page: '' } });
    await db.pipeRuns.put({ id: runId, at: started, trigger: o.trigger, mode, status: 'running', sourceName: '', url: '', title: '', text: '', detail: 'Starting…', steps: [] });
    stage('Starting — checking the Gemini key and your sources');

    summary = await (async (): Promise<RunSummary> => {
      const key = await readGeminiKey();
      if (!key) throw new RunFail('config', 'No Gemini API key. Add it in Settings → Connections → Gemini.', false);
      stage('Choosing the Gemini model');
      const model = await resolveModel(key, cfg, deps, step, signal);
      stage('Reading your sources');
      const all = await db.sources.toArray();
      const posts = await db.posts.toArray();
      let sources = o.candidate ? [candidateSource(o.candidate)] : sourceOrder(all, posts);
      if (o.sourceId) sources = sources.filter((s) => s.id === o.sourceId);
      if (sources.length === 0) throw new RunFail('config', o.sourceId ? 'That source is turned off or does not exist.' : 'No enabled source. Add one on the Sources tab.', false);
      if (cfg.mode === 'auto' && cfg.channels.length === 0 && sources.some((s) => !s.simulationOnly)) throw new RunFail('config', 'Auto-publish needs at least one Buffer channel — choose it in the pipeline settings (or switch to Approval / Simulation).', false);
      const relay = await getSetting<string>('relay.url', DEFAULT_RELAY);
      const guardOpts = { maxChars: cfg.maxChars, bannedPhrases: cfg.banned.split('\n'), voice: cfg.voice, instructions: cfg.prompt };
      const retryNote = (e: GeminiError, n: number) => step(`Gemini busy (${e.message.slice(0, 80)}) — retry ${n}`);
      const compose: ComposeDeps = {
        write: (p) => deps.llm(key, p, { model, base: cfg.geminiBase, json: true, temperature: 0.7, signal }, retryNote),
        verify: (p) => deps.llm(key, p, { model, base: cfg.geminiBase, json: true, temperature: 0, signal }, retryNote),
      };
      let rejected = 0, nothingNew = 0, lastRejection = '';

      for (const src of sources) {
        checkStop();
        logSource = src.name;
        info({ source: src.name, page: '' });
        mode = src.simulationOnly ? 'simulation' : cfg.mode;
        stage(`Reading the sitemap of “${src.name}”`);
        step(`Source “${src.name}” — mode ${mode}${src.simulationOnly ? ' (this source is simulation-only)' : ''}`);
        const cands = o.candidate ? [candidateOf(o.candidate)] : await loadCandidates(src, relay, deps, step, signal);
        checkStop();
        stage(o.candidate ? 'Checking the page' : 'Choosing an unused page');
        const used = usedUrls(await db.posts.toArray(), mode);
        if (o.candidate && used.has(cands[0].url)) throw new RunFail('skipped', 'This page already has a post, so nothing new was written.', false);
        const lastOfSource = (await db.posts.toArray()).filter((p) => p.sourceId === src.id).sort((a, b) => b.created_at - a.created_at)[0];
        const todo = pickCandidates(cands, used, lastOfSource?.url, cfg.maxCandidates, cfg.order);
        if (todo.length === 0) { nothingNew++; step(`Nothing new on “${src.name}” — every matching page has already been used.`); continue; }
        step(`${todo.length} unused page(s) to try, newest first`);

        for (const cand of todo) {
          checkStop();
          logUrl = cand.url;
          info({ page: cand.url });
          stage(`Reading ${cand.url}`);
          let html: string;
          try { html = await readText(cand.url, src, relay, deps, step, signal); }
          catch (e) {
            if (e instanceof RunFail && !e.retryable && e.kind === 'site') {
              rejected++; lastRejection = e.message;
              await db.posts.put(basePost(runId, src, cand, { status: 'rejected', detail: e.message }, deps.now()));
              step(`Skipped: ${e.message}`);
              continue;
            }
            throw e;
          }
          stage('Reading the title, description and text of the page');
          const pageInfo = parsePage(html, cand.url);
          const title = pageInfo.title || cand.title || cand.url;
          const summaryText = pageInfo.description || cand.summary || '';
          logTitle = title;
          info({ page: cand.url });
          if (pageInfo.text.length < 200 && summaryText.length < 80) {
            rejected++; lastRejection = 'The page has too little readable text to write from.';
            await db.posts.put(basePost(runId, src, cand, { title, status: 'rejected', detail: lastRejection }, deps.now()));
            step(`Skipped: ${lastRejection}`);
            continue;
          }
          const image = httpsOnly(pageInfo.image) ?? httpsOnly(cand.image);
          const excerpt = [title, summaryText, pageInfo.text].join('\n').slice(0, 7000);
          let result;
          try { result = await composePost({ title, url: cand.url, summary: summaryText, text: pageInfo.text }, guardOpts, compose, stage); }
          catch (e) {
            if (e instanceof GeminiError) {
              if (e.kind === 'auth') throw new RunFail('auth', e.message, false);
              if (e.kind === 'quota') throw new RunFail('quota', e.message, true);
              if (e.kind === 'blocked') {
                rejected++; lastRejection = e.message;
                await db.posts.put(basePost(runId, src, cand, { title, summary: summaryText, status: 'rejected', detail: e.message }, deps.now()));
                continue;
              }
              throw new RunFail(e.kind === 'bad' ? 'config' : 'site', e.message, e.retryable);
            }
            throw e;
          }
          if (!result.ok) {
            rejected++; lastRejection = result.reason;
            await db.posts.put(basePost(runId, src, cand, { title, summary: summaryText, imageUrl: image, sourceExcerpt: excerpt, status: 'rejected', detail: `Guardrails: ${result.reason}`, guard: result.guard, model }, deps.now()));
            step(`Rejected by the guardrails: ${result.reason}`);
            continue;
          }
          logText = result.text;
          const post = basePost(runId, src, cand, { title, summary: summaryText, imageUrl: image, sourceExcerpt: excerpt, text: result.text, guard: result.guard, model, status: 'pending', detail: '' }, deps.now());
          if (mode === 'simulation') {
            post.status = 'simulated';
            const due = publishDueAt(cfg, deps.now());
            post.channels = cfg.channels.map((k) => ({ key: k, label: channelLabel(k), skipped: 'simulation' }));
            post.detail = `Simulation — nothing was sent. In publishing mode this would go to ${cfg.channels.length ? cfg.channels.map(channelLabel).join(', ') : '(no channel chosen yet)'} ${due ? 'at ' + new Date(due).toLocaleString() : 'in the next queue slot'}${image ? ' with an image' : ' without an image'}.`;
          } else if (mode === 'approval' || mode === 'table') {
            post.detail = mode === 'table'
              ? 'Waiting for approval in the table (Approval = Approved) — nothing has been sent to Buffer yet.'
              : 'Waiting for your approval — nothing has been sent to Buffer yet.';
          } else {
            checkStop(); // after this point the request to Buffer is sent; Stop cannot take it back
            stage('Sending to Buffer…');
            const r = await sendToBuffer(post.text, image, cfg, deps.now(), relay);
            post.channels = r.channels;
            post.status = r.sent > 0 ? 'sent' : 'failed';
            post.detail = `${r.sent > 0 ? 'Sent to Buffer. ' : 'Buffer did not accept the post. '}${describeChannels(r.channels)}`;
            if (r.sent === 0) {
              await db.posts.put(post);
              throw new RunFail(r.authFailed ? 'auth' : 'buffer', r.authFailed ? 'Buffer rejected the API key — the token may have expired. Create a new one in Buffer and replace it in Settings → Connections.' : `Buffer did not accept the post: ${describeChannels(r.channels)}`, !r.authFailed);
            }
          }
          stage('Saving the post');
          await db.posts.put(post);
          step(`${post.status === 'simulated' ? 'Simulated' : post.status === 'pending' ? 'Queued for approval' : 'Sent'}: ${title}`);
          return { ok: true, kind: 'ok', message: post.detail, retryable: false, post };
        }
      }
      if (rejected > 0) throw new RunFail('content', `No page passed the checks this time (${rejected} rejected). Last reason: ${lastRejection}`, true);
      throw new RunFail('content', nothingNew ? 'Nothing new to post — every matching page of the enabled sources has already been used. Add pages to the site or another source.' : 'No usable page was found.', false);
    })();
  } catch (e) {
    if (e instanceof StoppedError) summary = { ok: false, kind: 'cancelled', message: 'Stopped by you.', retryable: false };
    else if (e instanceof RunFail) summary = { ok: false, kind: e.kind, message: e.message, retryable: e.retryable };
    else summary = { ok: false, kind: 'site', message: e instanceof Error ? e.message : String(e), retryable: true };
    line(summary.kind === 'cancelled' ? 'Stopped by you.' : `FAILED — ${summary.message}`, true);
  } finally {
    busy = false;
    controller = null;
    activeRunId = '';
    runStore.set({ active: null });
  }

  const status: PipeRunRow['status'] = summary.ok ? 'ok' : summary.kind === 'cancelled' ? 'cancelled' : summary.kind === 'skipped' ? 'skipped' : 'failed';
  const row: PipeRunRow = {
    id: runId, at: started, trigger: o.trigger, mode, status, sourceName: logSource, url: logUrl, title: logTitle, text: logText,
    postStatus: summary.post?.status, postId: summary.post?.channels.find((c) => c.postId)?.postId, detail: summary.message, steps,
  };
  await db.pipeRuns.put(row);
  const n = await db.pipeRuns.count();
  if (n > 300) await db.pipeRuns.bulkDelete(await db.pipeRuns.orderBy('at').limit(n - 250).primaryKeys());
  await applyOutcome(summary, o.trigger, deps.now());
  await syncAfterChange();
  return summary;
}

function basePost(runId: string, s: SourceRow, c: Candidate, p: Partial<PostRow>, now: number): PostRow {
  return {
    id: uid(), runId, sourceId: s.id, sourceName: s.name, url: c.url, title: c.title ?? c.url, summary: '', sourceExcerpt: '', text: '', status: 'pending', detail: '',
    channels: [], created_at: now, updated_at: now, ...p,
  };
}

/** Marks runs that were still "running" when the app was closed or reloaded, so they do not look alive forever. */
export async function markInterruptedRuns(): Promise<void> {
  await db.pipeRuns.filter((r) => r.status === 'running' && r.id !== activeRunId)
    .modify({ status: 'interrupted', detail: 'The app was closed or reloaded while this run was going.' });
}

// ------------------------------------------------------------------------------------------------ alerts, retries, schedule

function osNotify(title: string, body: string): void {
  try {
    if (typeof Notification === 'undefined') return;
    const show = () => new Notification(title, { body });
    if (Notification.permission === 'granted') show();
    else if (Notification.permission !== 'denied') void Notification.requestPermission().then((p) => { if (p === 'granted') show(); });
  } catch { /* notifications unavailable */ }
}

async function applyOutcome(r: RunSummary, trigger: RunOptions['trigger'], now: number): Promise<void> {
  const st = await getState();
  const today = localDay(now);
  const scheduled = trigger !== 'manual';
  if (r.kind === 'skipped') return; // a page that already has a post is not an error
  if (r.kind === 'cancelled') {
    // a run you stopped is not retried, and a stopped daily run is not started again today
    if (scheduled) await setState({ day: today, done: true, lastAttempt: now });
    return;
  }
  const prior = scheduled && st.day === today ? st.attempts : 0;
  const attempts = scheduled ? prior + 1 : st.attempts;
  if (r.ok) {
    await setState({ alert: undefined, ...(scheduled ? { day: today, done: true, attempts, lastAttempt: now } : {}) });
    return;
  }
  const finalFailure = !r.retryable || attempts >= PIPE_MAX_ATTEMPTS;
  const text = scheduled
    ? finalFailure ? `The daily post failed and will not be retried today: ${r.message}` : `The daily post failed (attempt ${attempts} of ${PIPE_MAX_ATTEMPTS}); trying again in 5 minutes: ${r.message}`
    : `Run failed: ${r.message}`;
  const alert: PipelineAlert = { at: now, kind: r.kind, message: text };
  await setState({ alert, ...(scheduled ? { day: today, done: false, attempts: finalFailure ? PIPE_MAX_ATTEMPTS : attempts, lastAttempt: now } : {}) });
  if (scheduled ? (attempts === 1 || finalFailure) : true) osNotify('DCE content pipeline', text.slice(0, 200));
}

/** Called every 20 s by the loop. Starts the daily run (or a retry) when it is due. */
export async function tickPipeline(now = Date.now()): Promise<RunSummary | null> {
  if (busy) return null;
  await migrateModelOnce();
  if (!(await getSetting<boolean>('automations.running', true))) return null;
  const cfg = await getConfig();
  const d = dueDecision(cfg, await getState(), now);
  if (!d.run) return null;
  return runPipeline({ trigger: d.trigger });
}

export function startPipelineLoop(): () => void {
  void markInterruptedRuns().catch(() => undefined);
  const iv = window.setInterval(() => void tickPipeline().catch(() => undefined), 20_000);
  const t = window.setTimeout(() => void tickPipeline().catch(() => undefined), 4000);
  return () => { clearInterval(iv); clearTimeout(t); };
}

// ------------------------------------------------------------------------------------------------ deliverables

export async function exportWorkflow(): Promise<string> {
  const cfg = await getConfig();
  const sources = (await db.sources.toArray()).map((s) => ({ name: s.name, baseUrl: s.baseUrl, feedUrl: s.feedUrl, include: s.include, exclude: s.exclude, enabled: s.enabled, simulationOnly: s.simulationOnly }));
  return JSON.stringify({ format: 'dce-content-pipeline', version: 1, note: 'No API keys or channel ids are included.', config: { ...cfg, connectionId: '', channels: [], syncTable: '' }, sources }, null, 2);
}

export async function postsMarkdown(): Promise<string> {
  const posts = (await db.posts.toArray()).filter((p) => p.text).sort((a, b) => a.created_at - b.created_at);
  const lines = ['# Sample posts', '', `Generated by DCE on ${new Date().toLocaleDateString()}. Each post was written by Gemini from the public page it links to and passed the rule check and the second-model fact check.`, ''];
  posts.forEach((p, i) => {
    lines.push(`## ${i + 1}. ${p.title}`, '', `- Source page: ${p.url}`, `- Status: ${p.status}${p.status === 'simulated' ? ' (nothing was published)' : ''}`, `- Model: ${p.model ?? ''}`, `- Guardrails: ${(p.guard?.rules ?? []).map((r) => `${r.rule} ${r.ok ? '✓' : '✗'}`).join(', ')}${p.guard?.verifier ? `, fact-check ${p.guard.verifier.ok ? '✓' : '✗'}` : ''}`, '', '```', p.text, '```', '');
  });
  return lines.join('\n');
}
