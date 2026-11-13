import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { AlertTriangle, Check, Download, FlaskConical, Globe, Newspaper, Pencil, Play, Plus, RefreshCw, ShieldCheck, Square, Table2, Trash2, X } from 'lucide-react';
import { DEFAULT_RELAY } from '../automation/buffer';
import { channelProps, readGeminiKey, removeProp } from '../db/connections';
import { db, getSetting, type ConnectionRow, type PipeRunRow, type PostRow, type PostStatus, type SourceRow } from '../db/schema';
import { tableName, useTableList } from '../db/tables';
import { AUTO_MODEL, pickModel } from '../pipeline/gemini';
import { DEFAULT_BANNED, DEFAULT_INSTRUCTIONS, DEFAULT_VOICE } from '../pipeline/guard';
import { randomDates, usedUrls, type PipelineConfig, type PipelineMode } from '../pipeline/plan';
import type { Candidate } from '../pipeline/extract';
import {
  addSource, approvePost, checkSource, clearAlert, deletePost, editPost, exportWorkflow, getConfig, getModelCache, getState, loadCandidates, postsMarkdown, realDeps, rejectPost, refreshModels,
  runPipeline, runStore, seedSources, setConfig, SOURCE_PRESETS, stopPipelineRun, syncIfEnabled, type ActiveRun,
} from '../pipeline/run';
import { channelTitle, getChannelReport, refreshBufferChannels } from '../pipeline/channels';
import { createSyncTable } from '../pipeline/sync';
import { elapsed, useClock } from '../pipeline/RunBanner';
import { Dialog, download, Empty, fmtDate, IconBtn, Spinner, Tabs } from '../ui/kit';
import { confirmAction, notify, useStore } from '../ui/store';

type Tab = 'overview' | 'sources' | 'posts' | 'log';

const STATUS_LABEL: Record<PostStatus, string> = { simulated: 'simulated', pending: 'needs approval', sent: 'sent to Buffer', rejected: 'rejected', failed: 'failed' };
const statusChip = (s: PostStatus) => <span className={`chip ${s === 'sent' ? 'ok' : s === 'failed' || s === 'rejected' ? 'err' : s === 'pending' ? 'warn' : 'blue'}`}>{STATUS_LABEL[s]}</span>;

const RUN_CHIP: Record<PipeRunRow['status'], { cls: string; text: string }> = {
  running: { cls: 'blue', text: 'running' },
  ok: { cls: 'ok', text: 'ok' },
  failed: { cls: 'err', text: 'failed' },
  cancelled: { cls: 'warn', text: 'stopped by you' },
  interrupted: { cls: 'warn', text: 'interrupted' },
  skipped: { cls: 'blue', text: 'skipped (already posted)' },
};

const MODES: { id: PipelineMode; title: string; text: string }[] = [
  { id: 'simulation', title: 'Simulation (safe default)', text: 'Writes and checks the post and shows exactly what would be sent. Nothing is ever sent to Buffer.' },
  { id: 'approval', title: 'Approval', text: 'Writes and checks the post and holds it on the Posts tab. It goes to Buffer only when you click Approve.' },
  { id: 'auto', title: 'Auto-publish', text: 'Posts that pass both checks are created in Buffer by themselves, on the schedule below.' },
  { id: 'table', title: 'Draft to the table (you approve there)', text: 'Writes and checks the post and writes it as a row of the synced table, with Approval = Draft. Nothing is sent. Set Approval to Approved in the table: the “Post approved rows” automation gives the row a publish time and sends it to Buffer.' },
];

function Panel({ icon, title, children, note }: { icon?: React.ReactNode; title: string; children: React.ReactNode; note?: string }) {
  return (
    <section className="panel">
      <div className="panel-head">{icon}<h2>{title}</h2>{note && <span className="muted small">{note}</span>}</div>
      <div className="panel-body col">{children}</div>
    </section>
  );
}

// ------------------------------------------------------------------------------------------------ live run

/** The run in progress: current stage, how long it has been in it, and every step so far. Stop cancels it at once. */
function RunPanel({ run }: { run: ActiveRun }) {
  const now = useClock(1000);
  const idle = now - run.lastAt;
  const logRef = useRef<HTMLOListElement>(null);
  useEffect(() => { const el = logRef.current; if (el) el.scrollTop = el.scrollHeight; }, [run.lines.length]);
  return (
    <section className="panel run-panel" aria-label="Pipeline run in progress">
      <div className="panel-head">
        <span className="run-dot" aria-hidden="true" /><h2>Running now</h2>
        <span className="muted small">{run.trigger === 'schedule' ? 'daily run' : run.trigger === 'retry' ? 'retry' : 'started by you'} · {run.mode} mode · {elapsed(now - run.startedAt)}</span>
        <span className="grow" />
        <button className="btn danger solid" onClick={() => stopPipelineRun()} disabled={run.stopping}><Square size={13} /> {run.stopping ? 'Stopping…' : 'Stop run'}</button>
      </div>
      <div className="panel-body col" style={{ gap: 8 }}>
        <div><b>Now:</b> {run.stage} <span className="muted small">— for {elapsed(now - run.stageAt)}</span></div>
        {run.source && <div className="small muted">Source: {run.source}{run.page ? ` · page: ${run.page}` : ''}</div>}
        {idle > 45_000 && !run.stopping && <div className="callout warn">No progress for {elapsed(idle)}. It may be waiting for a slow server. Press <b>Stop run</b> to cancel it; you can start a new run straight away.</div>}
        <ol className="run-log" ref={logRef} aria-label="Live log">
          {run.lines.map((l, i) => <li key={i} className={l.stage ? 'stage' : undefined}><span className="muted">{new Date(l.at).toLocaleTimeString()}</span> {l.text}</li>)}
          {run.lines.length === 0 && <li className="muted">Waiting for the first step…</li>}
        </ol>
      </div>
    </section>
  );
}

// ------------------------------------------------------------------------------------------------ channels

/** One Buffer channel, labelled by service and name, with a tick box and (when Buffer no longer has it) a Remove button. */
function ChannelRow({ p, conn, cfg, stale, isNew }: { p: { id: string; key: string; meta?: { service: string; name: string; org: string } }; conn: ConnectionRow; cfg: PipelineConfig; stale: boolean; isNew: boolean }) {
  const on = cfg.channels.includes(p.key);
  const title = channelTitle(p);
  return (
    <div className={`chan-row ${stale ? 'stale' : ''}`}>
      <label className="chk">
        <input type="checkbox" aria-label={title} checked={on} disabled={stale}
          onChange={(e) => void setConfig({ channels: e.target.checked ? [...new Set([...cfg.channels, p.key])] : cfg.channels.filter((k) => k !== p.key) })} />
        <span><b>{title}</b>{p.meta?.org ? <span className="muted small"> · {p.meta.org}</span> : null}</span>
      </label>
      {stale && <span className="chip err">no longer in Buffer</span>}
      {stale && <button className="btn sm" onClick={async () => { await removeProp(conn.id, p.id); notify('success', `Removed ${title}.`); }}><Trash2 size={13} /> Remove</button>}
      {isNew && !stale && <span className="chip blue">new — saved from Buffer</span>}
      {!p.meta && !stale && <span className="chip warn">name not checked yet — press Refresh</span>}
    </div>
  );
}

/** The channels of the Buffer account, read from Buffer: new ones are saved automatically, removed ones are flagged. */
function ChannelPanel({ cfg, conn }: { cfg: PipelineConfig; conn: ConnectionRow | undefined }) {
  const report = useLiveQuery(() => (conn ? getChannelReport(conn.id) : Promise.resolve(null)), [conn?.id ?? ''], null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const channels = conn ? channelProps(conn) : [];
  const refresh = async (quiet: boolean) => {
    if (!conn) return;
    setBusy(true);
    try {
      const r = await refreshBufferChannels(conn.id);
      setErr('');
      const dropped = cfg.channels.filter((k) => r.stale.includes(k));
      if (dropped.length) await setConfig({ channels: cfg.channels.filter((k) => !dropped.includes(k)) });
      if (!quiet || r.added.length || r.stale.length) {
        const parts = [`${r.total} channel${r.total === 1 ? '' : 's'} in Buffer`, r.added.length ? `${r.added.length} new saved` : '', r.stale.length ? `${r.stale.length} no longer in Buffer` : ''].filter(Boolean);
        notify(r.stale.length ? 'warn' : 'success', `${r.accountName}: ${parts.join(' · ')}.`, 7000);
      }
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      setErr(m);
      if (!quiet) notify('error', m, 9000);
    }
    setBusy(false);
  };
  useEffect(() => { void refresh(true); /* on open, and when the account changes */ // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn?.id]);
  const titles = cfg.channels.map((k) => channels.find((p) => p.key === k)).filter((p): p is NonNullable<typeof p> => !!p).map((p) => channelTitle(p));
  return (
    <Panel icon={<Globe size={15} />} title="Buffer channels" note="read from your Buffer account">
      <div className="row wrap">
        <button className="btn sm" disabled={busy || !conn} onClick={() => void refresh(false)} aria-label="Refresh channels from Buffer">{busy ? <Spinner /> : <RefreshCw size={13} />} Refresh from Buffer</button>
        {report && <span className="muted small">Checked {fmtDate(report.at)} · {report.total} in Buffer</span>}
      </div>
      {err && <div className="callout warn" role="alert">Could not read the channels from Buffer: {err}</div>}
      {!conn ? <div className="callout warn">Add a Buffer account first — <a href="#/settings">Settings → Connections</a>.</div>
        : channels.length === 0 ? <div className="callout">No channels saved yet. Press <b>Refresh from Buffer</b>: every channel in the account is picked up and saved, and a channel you add in Buffer later appears the next time you refresh (or when this page opens).</div>
        : <div className="col" style={{ gap: 6 }}>{channels.map((p) => (
          <ChannelRow key={p.id} p={p} conn={conn} cfg={cfg} stale={!!report?.stale.includes(p.key)} isNew={!!report?.added.includes(p.key)} />
        ))}</div>}
      <div className="small"><b>Posts go to:</b> {titles.length ? titles.join(', ') : 'no channel ticked yet — tick at least one for Approval or Auto-publish.'}</div>
    </Panel>
  );
}

// ------------------------------------------------------------------------------------------------ overview

function Overview({ cfg, posts }: { cfg: PipelineConfig; posts: PostRow[] }) {
  const conns = useLiveQuery(() => db.connections.where('provider').notEqual('gemini').toArray(), [], []);
  const hasKey = useLiveQuery(async () => !!(await readGeminiKey()), [], undefined);
  const sources = useLiveQuery(() => db.sources.toArray(), [], []);
  const activeId = useLiveQuery(() => getSetting<string>('connections.active.buffer', ''), [], '');
  const lastRun = useLiveQuery(() => db.pipeRuns.orderBy('at').reverse().limit(1).toArray(), [], [] as PipeRunRow[]);
  const active = useStore(runStore, (s) => s.active);
  const [vars, setVars] = useState({ voice: cfg.voice, banned: cfg.banned, prompt: cfg.prompt });
  const [which, setWhich] = useState('');
  const cache = useLiveQuery(() => getModelCache(), [], { at: 0, names: [] as string[] });
  const [refreshing, setRefreshing] = useState(false);
  const auto = pickModel(cache.names);
  const refreshList = async () => {
    setRefreshing(true);
    try { const c = await refreshModels(); notify('success', `${c.names.length} models loaded from Google.`); }
    catch (e) { notify('error', e instanceof Error ? e.message : String(e), 9000); }
    setRefreshing(false);
  };
  const conn = (conns ?? []).find((c) => c.id === cfg.connectionId) ?? (conns ?? []).find((c) => c.id === activeId) ?? (conns ?? [])[0];
  const count = (s: PostStatus) => posts.filter((p) => p.status === s).length;
  const save = (p: Partial<PipelineConfig>) => setConfig(p);
  const last = lastRun?.[0];

  const setMode = async (m: PipelineMode) => {
    if (m === 'auto' && !(await confirmAction('Switch to auto-publish?', 'Posts that pass the checks will be created in your Buffer channel(s) without asking you first. Sources marked “simulation only” stay simulated.', 'Use auto-publish', false))) return;
    await save({ mode: m });
  };

  const run = async () => {
    const r = await runPipeline({ trigger: 'manual', sourceId: which || undefined });
    if (r.kind === 'cancelled') notify('info', 'Run stopped.');
    else if (r.ok) notify('success', `Done — ${r.post?.status === 'simulated' ? 'simulated post created.' : r.post?.status === 'pending' ? 'post is waiting for your approval.' : 'post sent to Buffer.'}`, 5000);
    else notify('error', r.message, 12000);
  };

  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="row wrap">
        <div className="stat"><b>{count('pending')}</b><span>waiting for approval</span></div>
        <div className="stat"><b>{count('sent')}</b><span>sent to Buffer</span></div>
        <div className="stat"><b>{count('simulated')}</b><span>simulated</span></div>
        <div className="stat"><b>{count('rejected')}</b><span>rejected by checks</span></div>
        <div className="stat"><b>{count('failed')}</b><span>failed to send</span></div>
      </div>

      {active ? <RunPanel run={active} /> : (
        <Panel icon={<Play size={15} />} title="Run" note="One post per run">
          <div className="row wrap">
            <label className="fld" style={{ minWidth: 220 }}><span>Source</span>
              <select aria-label="Source to run" value={which} onChange={(e) => setWhich(e.target.value)}>
                <option value="">Next source in turn</option>
                {(sources ?? []).filter((s) => s.enabled).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </label>
            <button className="btn primary" onClick={run} aria-label="Run now"><Play size={14} /> Run now</button>
            <span className="muted small">Reads one public page (≤ 1 request/second, robots.txt obeyed), writes the post with Gemini, checks it twice, then follows the mode below. You can leave this page; the run keeps going and shows at the top.</span>
          </div>
          {last && <div className="muted small">Last run: {fmtDate(last.at)} — <b>{RUN_CHIP[last.status].text}</b>{last.detail ? `: ${last.detail}` : ''}</div>}
          {hasKey === false && <div className="callout warn">No Gemini key yet — add it in <a href="#/settings">Settings → Gemini</a>.</div>}
        </Panel>
      )}

      <Panel icon={<ShieldCheck size={15} />} title="What happens to a finished post">
        <div className="col" style={{ gap: 6 }} role="radiogroup" aria-label="Publishing mode">
          {MODES.map((m) => (
            <label key={m.id} className="chk" style={{ alignItems: 'flex-start' }}>
              <input type="radio" name="pipemode" checked={cfg.mode === m.id} onChange={() => void setMode(m.id)} aria-label={m.title} />
              <span><b>{m.title}</b><br /><span className="muted small">{m.text}</span></span>
            </label>
          ))}
        </div>
        <div className="grid2">
          <label className="fld"><span>Buffer account</span>
            <select aria-label="Pipeline Buffer account" value={cfg.connectionId} onChange={(e) => save({ connectionId: e.target.value, channels: [] })}>
              <option value="">Active account{conn ? ` (${conn.name})` : ''}</option>
              {(conns ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <div className="fld"><span>Publish when</span>
            <div className="row wrap">
              <select aria-label="Publish timing" value={cfg.publish} onChange={(e) => save({ publish: e.target.value as 'queue' | 'time' })}>
                <option value="queue">In the next free queue slot</option><option value="time">At a fixed time of day</option>
              </select>
              {cfg.publish === 'time' && <input type="time" aria-label="Publish time" value={cfg.publishTime} onChange={(e) => save({ publishTime: e.target.value })} />}
            </div>
          </div>
        </div>
      </Panel>

      <ChannelPanel cfg={cfg} conn={conn} />

      <Panel icon={<RefreshCw size={15} />} title="Daily schedule">
        <div className="row wrap">
          <label className="chk" style={{ fontWeight: 600 }}>
            <input type="checkbox" role="switch" aria-label="Daily schedule enabled" checked={cfg.enabled} onChange={async (e) => {
              if (e.target.checked && cfg.mode === 'auto' && !(await confirmAction('Turn on daily auto-publishing?', 'Every day at the chosen time a post will be created in your Buffer channel(s) automatically.', 'Turn on', false))) return;
              await save({ enabled: e.target.checked });
              notify('info', e.target.checked ? `Daily run on — ${cfg.dailyTime} every day while DCE is open.` : 'Daily run off.');
            }} /> {cfg.enabled ? 'On' : 'Off'}
          </label>
          <label className="fld" style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}><span>at</span><input type="time" aria-label="Daily run time" value={cfg.dailyTime} onChange={(e) => save({ dailyTime: e.target.value })} /></label>
        </div>
        <div className="col" style={{ gap: 6 }} role="radiogroup" aria-label="Run days">
          <label className="chk"><input type="radio" name="runDays" aria-label="Every day" checked={cfg.schedule !== 'dates'} onChange={() => save({ schedule: 'daily' })} /> Every day</label>
          <label className="chk"><input type="radio" name="runDays" aria-label="On chosen dates" checked={cfg.schedule === 'dates'} onChange={() => save({ schedule: 'dates' })} /> Only on the dates I choose (one article a day, at the time above)</label>
        </div>
        {cfg.schedule === 'dates' && <DatesPicker dates={cfg.dates ?? []} onChange={(dates) => save({ dates })} />}
        <div className="muted small">The schedule runs while DCE is open (the desktop app can stay minimised). If DCE was closed at that time, the run happens when you next open it. A failed run is retried after 5 minutes, up to 3 attempts a day; you are alerted on the first failure and when it gives up. A run you stop is not retried that day. “Posts” already created in Buffer are published by Buffer even if DCE is closed.</div>
      </Panel>

      <Panel icon={<FlaskConical size={15} />} title="Writer and guardrails">
        <div className="grid2">
          <div className="fld"><span>Gemini model</span>
            <div className="row">
              <select aria-label="Gemini model" value={cfg.model} onChange={(e) => save({ model: e.target.value })} style={{ flex: 1, minWidth: 0 }}>
                <option value={AUTO_MODEL}>Auto — newest Flash model your key can use</option>
                {cache.names.map((n) => <option key={n} value={n}>{n}</option>)}
                {cfg.model !== AUTO_MODEL && !cache.names.includes(cfg.model) && <option value={cfg.model}>{cfg.model} (not in the list)</option>}
              </select>
              <button className="btn sm" disabled={refreshing} onClick={refreshList} aria-label="Refresh model list">{refreshing ? <Spinner /> : <RefreshCw size={13} />} Refresh list</button>
            </div>
            <span className="muted small">{cache.names.length ? `${cache.names.length} models from your key (fetched ${fmtDate(cache.at)}). Auto would use “${auto ?? 'none'}”.` : 'Press “Refresh list” to load the models your key can use. Auto picks the newest Flash model.'}</span>
          </div>
          <label className="fld"><span>Longest post before the link (characters)</span><input type="number" min={100} max={2000} aria-label="Max characters" value={cfg.maxChars} onChange={(e) => save({ maxChars: Math.max(100, Number(e.target.value) || 500) })} /></label>
        </div>
        <label className="fld" style={{ maxWidth: 360 }}><span>Which unused page is drafted first</span>
          <select aria-label="Article order" value={cfg.order ?? 'newest'} onChange={(e) => save({ order: e.target.value as 'newest' | 'oldest' })}>
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
          </select>
        </label>
        <div className="small muted">A page that already has a post is never drafted again. To pick one page yourself, open <b>Pages</b> on the Sources tab.</div>
        <label className="fld"><span>Brand voice — a style note (added to the instructions below, unless they place it with {'{{voice}}'})</span>
          <textarea rows={2} aria-label="Brand voice" value={vars.voice} onChange={(e) => setVars({ ...vars, voice: e.target.value })} onBlur={() => save({ voice: vars.voice.trim() || DEFAULT_VOICE })} />
        </label>
        <label className="fld"><span>Writing instructions — what Gemini should write. Placeholders: {'{{title}} {{url}} {{summary}} {{text}} {{voice}} {{max_chars}}'}</span>
          <textarea rows={7} aria-label="Writing instructions" value={vars.prompt} placeholder={DEFAULT_INSTRUCTIONS} onChange={(e) => setVars({ ...vars, prompt: e.target.value })} onBlur={() => save({ prompt: vars.prompt.trim() })} />
        </label>
        <div className="row wrap">
          <button className="btn sm" onClick={async () => { setVars({ ...vars, prompt: '' }); await save({ prompt: '' }); notify('info', 'The default writing instructions are back.'); }}>Use the default instructions</button>
        </div>
        <div className="callout">Always added by DCE, whatever you write above: the answer format (hook, lines, call to action, hashtags), facts only from the page, no medical claims or promised outcomes, no link (the link is added by code), the banned phrases below, and the length limit.</div>
        <label className="fld"><span>Words and phrases a post may never contain — medical claims, outcome promises (one per line)</span>
          <textarea rows={5} aria-label="Banned phrases" value={vars.banned} onChange={(e) => setVars({ ...vars, banned: e.target.value })} onBlur={() => save({ banned: vars.banned })} />
        </label>
        <div className="row wrap">
          <button className="btn sm" onClick={() => { setVars({ ...vars, banned: DEFAULT_BANNED.join('\n') }); void save({ banned: DEFAULT_BANNED.join('\n') }); }}>Restore the default list</button>
          <label className="fld" style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}><span className="small muted">Gemini endpoint (advanced)</span>
            <input aria-label="Gemini endpoint" placeholder="default: Google" value={cfg.geminiBase} onChange={(e) => save({ geminiBase: e.target.value.trim() })} style={{ width: 240 }} /></label>
        </div>
        <div className="muted small">Every post must pass the <b>rule check</b> (structure, length, one correct link, banned wording, no numbers or prices that are not in the page) <b>and</b> a second Gemini call that fact-checks it against the page. If the second check cannot run, nothing is published.</div>
      </Panel>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ sources

function SourceDialog({ initial, onClose }: { initial: SourceRow | null; onClose: () => void }) {
  const [f, setF] = useState({
    name: initial?.name ?? '', baseUrl: initial?.baseUrl ?? '', feedUrl: initial?.feedUrl ?? '', include: initial?.include ?? '', exclude: initial?.exclude ?? '',
    enabled: initial?.enabled ?? true, simulationOnly: initial?.simulationOnly ?? false,
  });
  const [err, setErr] = useState('');
  const submit = async () => {
    let base = f.baseUrl.trim();
    if (base && !/^https?:\/\//i.test(base)) base = `https://${base}`;
    let feed = f.feedUrl.trim();
    if (feed && !/^https?:\/\//i.test(feed)) feed = new URL(feed.startsWith('/') ? feed : `/${feed}`, base || 'https://invalid').href;
    try { new URL(base); if (feed) new URL(feed); } catch { setErr('Enter a valid website address, e.g. https://vierapparatus.com'); return; }
    const data = { ...f, baseUrl: base, feedUrl: feed };
    if (initial) await db.sources.update(initial.id, { ...data, baseUrl: base.replace(/\/+$/, ''), name: data.name.trim() || new URL(base).hostname });
    else await addSource(data);
    notify('success', initial ? 'Source updated.' : 'Source added.');
    onClose();
  };
  return (
    <Dialog title={initial ? 'Edit source' : 'Add a source website'} onClose={onClose} size="mid" foot={<>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn primary" disabled={!f.baseUrl.trim()} onClick={submit}>{initial ? 'Save' : 'Add source'}</button>
    </>}>
      <div className="col">
        <div className="grid2">
          <label className="fld"><span>Website address</span><input aria-label="Website address" value={f.baseUrl} placeholder="https://vierapparatus.com" autoFocus onChange={(e) => { setErr(''); setF({ ...f, baseUrl: e.target.value }); }} /></label>
          <label className="fld"><span>Name (optional)</span><input aria-label="Source name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
        </div>
        <label className="fld"><span>Sitemap or RSS / Atom feed (optional — default: /sitemap.xml)</span><input aria-label="Sitemap or feed" value={f.feedUrl} placeholder="https://vierapparatus.com/sitemap.xml" onChange={(e) => setF({ ...f, feedUrl: e.target.value })} /></label>
        <div className="grid2">
          <label className="fld"><span>Only pages whose address contains (one per line; “re:” = regular expression)</span><textarea rows={3} aria-label="Include patterns" value={f.include} placeholder="/articles/" onChange={(e) => setF({ ...f, include: e.target.value })} /></label>
          <label className="fld"><span>Never pages whose address contains</span><textarea rows={3} aria-label="Exclude patterns" value={f.exclude} placeholder="/tag/&#10;/author/" onChange={(e) => setF({ ...f, exclude: e.target.value })} /></label>
        </div>
        <label className="chk"><input type="checkbox" checked={f.simulationOnly} onChange={(e) => setF({ ...f, simulationOnly: e.target.checked })} /> Simulation only — never send posts from this source anywhere</label>
        <label className="chk"><input type="checkbox" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} /> Use this source</label>
        {err && <div className="callout err" role="alert">{err}</div>}
        <div className="muted small">Only public pages are read, politely: robots.txt is obeyed and at most one request per second goes to the site. Use websites you own or have the right to promote.</div>
      </div>
    </Dialog>
  );
}

/** The days the schedule runs on: add a day, or let DCE pick random days inside a range. */
function DatesPicker({ dates, onChange }: { dates: string[]; onChange: (d: string[]) => void }) {
  const [day, setDay] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [count, setCount] = useState(4);
  const sorted = [...dates].sort();
  return (
    <div className="col" style={{ gap: 8 }}>
      <div className="row wrap">
        <input type="date" aria-label="Add a run date" value={day} onChange={(e) => setDay(e.target.value)} />
        <button className="btn sm" disabled={!day} onClick={() => { onChange([...new Set([...dates, day])].sort()); setDay(''); }}><Plus size={13} /> Add the date</button>
      </div>
      <div className="row wrap">
        <span className="small">or pick</span>
        <input type="number" min={1} max={60} aria-label="How many random dates" value={count} onChange={(e) => setCount(Math.max(1, Number(e.target.value) || 1))} style={{ width: 70 }} />
        <span className="small">random dates from</span>
        <input type="date" aria-label="Random dates from" value={from} onChange={(e) => setFrom(e.target.value)} />
        <span className="small">to</span>
        <input type="date" aria-label="Random dates to" value={to} onChange={(e) => setTo(e.target.value)} />
        <button className="btn sm" disabled={!from || !to} onClick={() => {
          const picked = randomDates(from, to, count, Math.random);
          if (picked.length === 0) { notify('warn', 'Choose a first and a last date (the first not after the last).'); return; }
          onChange([...new Set([...dates, ...picked])].sort());
          notify('success', `${picked.length} random date(s) added.`);
        }}>Pick random dates</button>
      </div>
      <ul aria-label="Run dates" style={{ margin: 0, paddingLeft: 18 }}>
        {sorted.length === 0 && <li className="muted small">No date chosen yet: the schedule does nothing until you add one.</li>}
        {sorted.map((d) => <li key={d}>{d} <IconBtn icon={<X size={12} />} label={`Remove ${d}`} onClick={() => onChange(dates.filter((x) => x !== d))} /></li>)}
      </ul>
      <div className="small muted">{sorted.length} date{sorted.length === 1 ? '' : 's'} chosen. On each of these days, at the time above, one article is drafted with the same rules as “Run now”.</div>
    </div>
  );
}

/** The pages of one source, with whether each has been used. "Draft this page" drafts exactly that page; a used page is never drafted again. */
function PagesDialog({ source, onClose }: { source: SourceRow; onClose: () => void }) {
  const posts = useLiveQuery(() => db.posts.toArray(), [], [] as PostRow[]);
  const [cands, setCands] = useState<Candidate[] | null>(null);
  const [err, setErr] = useState('');
  const [mode, setMode] = useState<PipelineMode>('simulation');
  useEffect(() => { void getConfig().then((c) => setMode(c.mode)); }, []);
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const relay = await getSetting<string>('relay.url', DEFAULT_RELAY);
        const list = await loadCandidates(source, relay, realDeps, () => undefined);
        if (alive) setCands(list);
      } catch (e) { if (alive) setErr(e instanceof Error ? e.message : String(e)); }
    })();
    return () => { alive = false; };
  }, [source]);
  const used = usedUrls(posts ?? [], mode);
  const draft = async (c: Candidate) => {
    onClose();
    const r = await runPipeline({ trigger: 'manual', candidate: { url: c.url, title: c.title || c.url, summary: c.summary || '', image: c.image, sourceName: source.name } });
    notify(r.ok ? 'success' : 'error', r.message, 9000);
  };
  return (
    <Dialog title={`Pages of ${source.name}`} onClose={onClose} size="mid" foot={<button className="btn" onClick={onClose}>Close</button>}>
      {err && <div className="callout err">{err}</div>}
      {!cands && !err && <Spinner />}
      {cands && (
        <div className="col" style={{ gap: 6, maxHeight: 420, overflow: 'auto' }}>
          {cands.length === 0 && <div className="muted">No page matches this source's rules.</div>}
          {cands.slice(0, 300).map((c) => {
            const isUsed = used.has(c.url);
            return (
              <div key={c.url} className="row wrap" style={{ alignItems: 'center' }}>
                <span className={`chip ${isUsed ? '' : 'ok'}`}>{isUsed ? 'used' : 'not yet'}</span>
                <span className="grow small"><b>{c.title || c.url}</b><br /><span className="muted">{c.url}</span></span>
                <button className="btn sm" disabled={isUsed} onClick={() => void draft(c)} aria-label={`Draft ${c.title || c.url}`}>Draft this page</button>
              </div>
            );
          })}
        </div>
      )}
    </Dialog>
  );
}

function Sources() {
  const sources = useLiveQuery(() => db.sources.orderBy('created_at').toArray(), [], undefined);
  const [dlg, setDlg] = useState<SourceRow | 'new' | null>(null);
  const [pagesFor, setPagesFor] = useState<SourceRow | null>(null);
  const [checking, setChecking] = useState<string | null>(null);
  const [sample, setSample] = useState<{ name: string; urls: string[]; message: string } | null>(null);
  const list = sources ?? [];
  const has = (host: string) => list.some((s) => s.baseUrl.toLowerCase().includes(host));
  const check = async (s: SourceRow) => {
    setChecking(s.id);
    const r = await checkSource(s.id);
    setChecking(null);
    setSample({ name: s.name, urls: r.sample, message: r.message });
  };
  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="row wrap">
        <button className="btn primary" onClick={() => setDlg('new')}><Plus size={14} /> Add website</button>
        {!has('vierapparatus.com') && <button className="btn" onClick={async () => { await addSource(SOURCE_PRESETS.vier); notify('success', 'vierapparatus.com added.'); }}><Globe size={14} /> Add vierapparatus.com</button>}
        {!has('placidway.com') && <button className="btn" onClick={async () => { await addSource(SOURCE_PRESETS.placidway); notify('success', 'PlacidWay added (simulation only).'); }}><Globe size={14} /> Add PlacidWay (simulation)</button>}
      </div>
      {sources === undefined ? <Spinner /> : list.length === 0 ? <Empty title="No source websites" icon={<Globe size={26} />}>Add the website whose pages should be promoted.</Empty> : (
        <table className="tbl" aria-label="Sources">
          <thead><tr><th>Source</th><th>Rules</th><th>Last check</th><th>Use</th><th>Simulation only</th><th style={{ width: 160 }} /></tr></thead>
          <tbody>
            {list.map((s) => (
              <tr key={s.id}>
                <td><b>{s.name}</b><br /><span className="muted small">{s.baseUrl}</span></td>
                <td className="small">{s.include ? <>only <code>{s.include.split(/[\n,]/).filter(Boolean).join(', ')}</code></> : 'all pages'}{s.exclude ? <><br />not <code>{s.exclude.split(/[\n,]/).filter(Boolean).join(', ')}</code></> : null}<br /><span className="muted">{s.feedUrl ? s.feedUrl.replace(/^https?:\/\//, '') : '/sitemap.xml'}</span></td>
                <td className="small">{s.lastCheck ? <><span className={`chip ${s.lastCheck.ok ? 'ok' : 'err'}`}>{s.lastCheck.ok ? `${s.lastCheck.found} pages` : 'problem'}</span><br /><span className="muted">{fmtDate(s.lastCheck.at)}</span></> : <span className="muted">not checked</span>}</td>
                <td><input type="checkbox" role="switch" aria-label={`Use ${s.name}`} checked={s.enabled} onChange={(e) => db.sources.update(s.id, { enabled: e.target.checked })} /></td>
                <td><input type="checkbox" role="switch" aria-label={`Simulation only ${s.name}`} checked={s.simulationOnly} onChange={(e) => db.sources.update(s.id, { simulationOnly: e.target.checked })} /></td>
                <td><div className="row">
                  <button className="btn sm" disabled={checking === s.id} onClick={() => void check(s)} aria-label={`Check ${s.name}`}>{checking === s.id ? <Spinner /> : <Check size={13} />} Check</button>
                  <button className="btn sm" onClick={() => setPagesFor(s)} aria-label={`Pages of ${s.name}`}>Pages</button>
                  <IconBtn icon={<Pencil size={14} />} label={`Edit ${s.name}`} onClick={() => setDlg(s)} />
                  <IconBtn icon={<Trash2 size={14} />} label={`Delete ${s.name}`} onClick={async () => {
                    if (await confirmAction(`Delete “${s.name}”?`, 'The source is removed. Posts already made from it stay in the Posts list, so those pages are still never posted twice.')) { await db.sources.delete(s.id); notify('success', 'Source deleted.'); }
                  }} />
                </div></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="callout"><b>How pages are found:</b> from the site's own sitemap (or RSS / Atom feed) — one polite request lists every page and when it changed. Only the single page chosen for a post is opened. “Check” reads the sitemap and shows how many pages qualify; it sends nothing and uses no Gemini quota.</div>
      {dlg && <SourceDialog initial={dlg === 'new' ? null : dlg} onClose={() => setDlg(null)} />}
      {pagesFor && <PagesDialog source={pagesFor} onClose={() => setPagesFor(null)} />}
      {sample && (
        <Dialog title={`Check: ${sample.name}`} onClose={() => setSample(null)} foot={<button className="btn primary" onClick={() => setSample(null)}>Close</button>}>
          <div role="status">{sample.message}</div>
          {sample.urls.length > 0 && <ul className="small" style={{ margin: '8px 0 0', paddingLeft: 18 }}>{sample.urls.map((u) => <li key={u}><code>{u}</code></li>)}</ul>}
        </Dialog>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ posts

function PostCard({ p, syncTable }: { p: PostRow; syncTable: string }) {
  const [edit, setEdit] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const rulesOk = (p.guard?.rules ?? []).every((r) => r.ok);
  return (
    <div className="panel" aria-label={`Post: ${p.title}`}>
      <div className="panel-head">
        {statusChip(p.status)}<b style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.title}</b><span className="grow" />
        <span className="muted small">{p.sourceName} · {fmtDate(p.created_at)}</span>
        <IconBtn icon={<Trash2 size={14} />} label={`Delete post ${p.title}`} onClick={async () => {
          const extra = syncTable ? ' Its row in the sync table is removed too.' : '';
          if (await confirmAction('Delete this post record?', (p.status === 'sent' ? 'The post stays in Buffer — only the record here is removed, and the page could be posted again.' : 'The page can be picked again by a later run.') + extra)) await deletePost(p.id);
        }} />
      </div>
      <div className="panel-body col" style={{ gap: 8 }}>
        <div className="small"><a href={p.url} target="_blank" rel="noreferrer">{p.url}</a>{p.imageUrl ? <span className="muted"> · image found</span> : <span className="muted"> · no image</span>}</div>
        {p.text && (edit === null
          ? <pre className="post-text" aria-label="Post text">{p.text}</pre>
          : <textarea rows={9} aria-label="Edit post text" value={edit} onChange={(e) => setEdit(e.target.value)} style={{ fontFamily: 'inherit' }} />)}
        <div className="small">{p.detail}</div>
        {p.guard && (
          <div className="row wrap">
            {p.guard.rules.map((r) => <span key={r.rule} className={`chip ${r.ok ? 'ok' : 'err'}`} title={r.message}>{r.ok ? '✓' : '✗'} {r.rule}</span>)}
            {p.guard.verifier && <span className={`chip ${p.guard.verifier.ok ? 'ok' : 'err'}`} title={p.guard.verifier.issues.join(' ') || p.guard.verifier.skipped || 'The second model found every statement supported by the page.'}>{p.guard.verifier.ok ? '✓' : '✗'} fact-check</span>}
            <span className="muted small">{p.guard.attempts} draft{p.guard.attempts === 1 ? '' : 's'}{rulesOk ? '' : ' — failed'}</span>
          </div>
        )}
        {p.status === 'pending' && (
          <div className="row wrap">
            {edit === null ? <>
              <button className="btn primary" disabled={busy} aria-label="Approve and send" onClick={async () => {
                if (!(await confirmAction('Send this post to Buffer?', 'It is created in the Buffer channel(s) ticked on the Overview tab.', 'Approve and send', false))) return;
                setBusy(true); const r = await approvePost(p.id); setBusy(false); notify(r.ok ? 'success' : 'error', r.message, r.ok ? 5000 : 12000);
              }}><Check size={14} /> Approve &amp; send</button>
              <button className="btn" onClick={() => setEdit(p.text)}><Pencil size={14} /> Edit text</button>
              <button className="btn" aria-label="Reject post" onClick={async () => { await rejectPost(p.id); notify('info', 'Post rejected — that page will not be picked again.'); }}><X size={14} /> Reject</button>
            </> : <>
              <button className="btn primary" onClick={async () => { const r = await editPost(p.id, edit); setEdit(null); notify(r.ok ? 'success' : 'warn', r.ok ? 'Text saved — it passes the rule check.' : `Saved, but it breaks a rule: ${r.issues.join(' ')}`, 8000); }}>Save text</button>
              <button className="btn" onClick={() => setEdit(null)}>Cancel</button>
            </>}
          </div>
        )}
      </div>
    </div>
  );
}

/** Sync to a table: pick (or create) the table; every post then becomes one row there. */
function SyncPanel({ cfg }: { cfg: PipelineConfig }) {
  const tables = useTableList();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const runSync = async () => {
    setBusy(true);
    try {
      const n = await syncIfEnabled();
      setNote(`Last sync ${new Date().toLocaleTimeString()}: ${n} post${n === 1 ? '' : 's'} written to “${tableName(cfg.syncTable)}”.`);
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      setNote(`Sync failed: ${m}`);
      notify('error', `Sync failed: ${m}`, 9000);
    }
    setBusy(false);
  };
  const chooseTable = async (id: string) => {
    await setConfig({ syncTable: id });
    if (id) await runSync(); else setNote('');
  };
  const createNow = async () => {
    setBusy(true);
    const id = await createSyncTable();
    await setConfig({ syncTable: id });
    setBusy(false);
    await runSync();
    notify('success', 'Table “Social posts” created and synced.');
  };
  return (
    <Panel icon={<Table2 size={15} />} title="Sync posts to a table" note="one-way: every post is one row">
      <div className="row wrap">
        <label className="fld" style={{ minWidth: 240 }}><span>Table</span>
          <select aria-label="Sync posts to table" value={cfg.syncTable} onChange={(e) => void chooseTable(e.target.value)}>
            <option value="">— off —</option>
            {tables.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </label>
        {!cfg.syncTable && <button className="btn" onClick={() => void createNow()} disabled={busy}><Plus size={14} /> Create “Social posts” table</button>}
        {cfg.syncTable && <button className="btn" onClick={() => void runSync()} disabled={busy} aria-label="Sync now">{busy ? <Spinner /> : <RefreshCw size={14} />} Sync now</button>}
        {cfg.syncTable && <a className="btn sm" href={`#/table/${cfg.syncTable}`}>Open the table</a>}
      </div>
      <div className="muted small">{note || (cfg.syncTable
        ? `Each post is one row in “${tableName(cfg.syncTable)}”, updated whenever a post is created or changes status. The pipeline's columns (Title, Status, Post text, Channels, …) are rewritten each time; columns you add to that table are kept.`
        : 'Choose a table to keep every post in your own data, where you can filter, sort and export it with the rest of your tables. Nothing is written until you choose one.')}</div>
    </Panel>
  );
}

function Posts({ posts, cfg }: { posts: PostRow[]; cfg: PipelineConfig }) {
  const [f, setF] = useState<'all' | PostStatus>('all');
  const shown = useMemo(() => posts.filter((p) => f === 'all' || p.status === f), [posts, f]);
  const n = (s: PostStatus) => posts.filter((p) => p.status === s).length;
  return (
    <div className="col" style={{ gap: 10 }}>
      <SyncPanel cfg={cfg} />
      <div className="row wrap">
        <Tabs<'all' | PostStatus> tabs={[{ id: 'all', label: `All ${posts.length}` }, { id: 'pending', label: `Needs approval ${n('pending')}` }, { id: 'sent', label: `Sent ${n('sent')}` }, { id: 'simulated', label: `Simulated ${n('simulated')}` }, { id: 'rejected', label: `Rejected ${n('rejected')}` }, { id: 'failed', label: `Failed ${n('failed')}` }]} value={f} onChange={setF} />
        <span className="grow" />
        <button className="btn sm" onClick={async () => { download(new Blob([await postsMarkdown()], { type: 'text/markdown' }), 'sample-posts.md'); }} aria-label="Export posts"><Download size={13} /> Export posts (.md)</button>
        <button className="btn sm" onClick={async () => { download(new Blob([await exportWorkflow()], { type: 'application/json' }), 'dce-content-pipeline.json'); }} aria-label="Export workflow"><Download size={13} /> Export workflow (.json)</button>
        {posts.some((p) => p.status === 'simulated') && <button className="btn sm" onClick={async () => {
          if (await confirmAction('Clear simulated posts?', 'Only the simulation records are removed; those pages can be rehearsed or posted again.')) { await db.posts.where('status').equals('simulated').delete(); notify('success', 'Simulated posts cleared.'); }
        }}>Clear simulated</button>}
      </div>
      {shown.length === 0 ? <Empty title="No posts here yet" icon={<Newspaper size={26} />}>Press “Run now” on the Overview tab.</Empty> : shown.map((p) => <PostCard key={p.id} p={p} syncTable={cfg.syncTable} />)}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ log

function Log() {
  const runs = useLiveQuery(() => db.pipeRuns.orderBy('at').reverse().limit(60).toArray(), [], undefined);
  const active = useStore(runStore, (s) => s.active);
  const [open, setOpen] = useState<string | null>(null);
  if (runs === undefined) return <Spinner />;
  if (runs.length === 0) return <Empty title="Nothing has run yet" icon={<Newspaper size={26} />}>Every run — scheduled, manual or retry — is listed here with what it did, step by step. A run in progress updates here as it goes.</Empty>;
  return (
    <table className="tbl" aria-label="Run log">
      <thead><tr><th>When</th><th>Run</th><th>Source / page</th><th>Result</th><th>Details</th></tr></thead>
      <tbody>
        {runs.map((r) => {
          const chip = r.status === 'ok' ? { cls: 'ok', text: r.postStatus ?? 'ok' } : RUN_CHIP[r.status];
          return (
            <Fragment key={r.id}>
              <tr onClick={() => setOpen(open === r.id ? null : r.id)} style={{ cursor: 'pointer' }}>
                <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(r.at)}</td>
                <td className="small">{r.trigger}<br /><span className="muted">{r.mode}</span></td>
                <td className="small">{r.sourceName}<br /><span className="muted">{r.title || r.url}</span></td>
                <td>
                  <span className={`chip ${chip.cls}`}>{chip.text}</span>
                  {active?.id === r.id && <button className="btn sm danger" style={{ marginLeft: 6 }} onClick={(e) => { e.stopPropagation(); stopPipelineRun(); }}><Square size={11} /> Stop</button>}
                </td>
                <td className="small">{r.detail}{r.postId ? <span className="muted"> · Buffer id {r.postId}</span> : null}</td>
              </tr>
              {open === r.id && <tr><td colSpan={5}><ol className="small" style={{ margin: 0, paddingLeft: 20 }}>{r.steps.map((s, i) => <li key={i}>{s}</li>)}</ol></td></tr>}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}

// ------------------------------------------------------------------------------------------------ page

export default function PipelinePage() {
  const [tab, setTab] = useState<Tab>('overview');
  const cfg = useLiveQuery(() => getConfig(), [], undefined);
  const state = useLiveQuery(() => getState(), [], undefined);
  const posts = useLiveQuery(() => db.posts.orderBy('created_at').reverse().toArray(), [], undefined);
  useEffect(() => { void seedSources(); }, []);
  const pending = (posts ?? []).filter((p) => p.status === 'pending').length;

  return (
    <div className="page" style={{ overflow: 'auto' }}>
      <div className="page-head">
        <h1>Content pipeline</h1><span className="muted">website page → Gemini post → checks → Buffer</span>
      </div>
      {state?.alert && (
        <div className="callout err row" role="alert" aria-label="Pipeline alert">
          <AlertTriangle size={16} /><span className="grow"><b>Needs attention ({state.alert.kind}):</b> {state.alert.message} <span className="muted">{fmtDate(state.alert.at)}</span></span>
          <button className="btn sm" onClick={() => void clearAlert()}>Dismiss</button>
        </div>
      )}
      <Tabs<Tab> tabs={[{ id: 'overview', label: 'Overview' }, { id: 'sources', label: 'Sources' }, { id: 'posts', label: `Posts${pending ? ` (${pending} to approve)` : ''}` }, { id: 'log', label: 'Run log' }]} value={tab} onChange={setTab} />
      {!cfg || !posts ? <Spinner /> : tab === 'overview' ? <Overview cfg={cfg} posts={posts} /> : tab === 'sources' ? <Sources /> : tab === 'posts' ? <Posts posts={posts} cfg={cfg} /> : <Log />}
    </div>
  );
}
