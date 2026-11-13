import { getSetting, setSetting, type ConnectionRow } from '../db/schema';
import { runPipeline } from '../pipeline/run';
import { httpRequest } from './http';
import { saveCaps } from './discover';
import { isConnectorEvent, pageOf, type ConnectorEvent } from './events';
import { runEventAutomations } from '../automation/engine';

/**
 * The website connector (DCE's side). DCE asks the website for the events after the last one it has done, runs the
 * workflows for each event, then takes the jobs the owner sent from the website's connector page and reports the results.
 * Only outgoing requests are made: nothing on this computer is opened to the internet.
 */
export const cursorKey = (connId: string) => `connector.cursor.${connId}`;
export const statusKey = (connId: string) => `connector.status.${connId}`;
export type ConnectorStatus = { at: number; ok: boolean; message: string; events: number; jobs: number; cursor: number };

const appVersion = () => (typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev');

export async function readStatus(connId: string): Promise<ConnectorStatus | null> {
  return getSetting<ConnectorStatus | null>(statusKey(connId), null);
}

/** "Test connection": is the token accepted, and which permissions does it have? */
export async function testWebsite(conn: ConnectionRow): Promise<{ ok: boolean; message: string }> {
  const r = await httpRequest(conn, 'GET', '/api/connector/v1/ping');
  if (!r.ok) {
    if (r.status === 401) return { ok: false, message: 'The token was refused. Check it, or create a new one on the website connector page.' };
    return { ok: false, message: `Not connected: ${r.error || 'the website did not answer'}` };
  }
  const j = r.json as { site?: string; scopes?: unknown } | null;
  const scopes = Array.isArray(j?.scopes) ? (j!.scopes as string[]) : [];
  const missing = ['events:read', 'jobs:run'].filter((s) => !scopes.includes(s));
  const note = missing.length ? ` Missing permission: ${missing.join(', ')}. Create a token with it on the website connector page.` : '';
  // what the token may do is stored (not the token): the automation editor offers only what it allows
  await saveCaps(conn.id, { checkedAt: Date.now(), scopes, note: `Website: ${scopes.join(', ') || 'no permissions'}${missing.length ? ` (missing ${missing.join(', ')})` : ''}` });
  return { ok: true, message: `Connected to ${j?.site ?? 'the website'}. Permissions: ${scopes.join(', ') || 'none'}.${note}` };
}

/** Runs every ON automation whose trigger is this website's event. */
async function dispatch(conn: ConnectionRow, ev: ConnectorEvent): Promise<void> {
  await runEventAutomations(conn.id, ev);
}

/** Takes up to five jobs, does each one, and reports it. Returns how many were reported. */
async function runJobs(conn: ConnectionRow): Promise<number> {
  const r = await httpRequest(conn, 'POST', '/api/connector/v1/jobs/claim', { limit: 5 });
  if (!r.ok) return 0;
  const list = ((r.json as { jobs?: { id: string; type: string; payload: Record<string, unknown> }[] } | null)?.jobs) ?? [];
  let reported = 0;
  for (const job of list) {
    let status: 'done' | 'failed' = 'done';
    let result = '';
    let error = '';
    try {
      const raw = (job.payload as { event?: unknown }).event;
      if (!isConnectorEvent(raw)) throw new Error('The job has no event.');
      if (job.type === 'run_text_post') {
        const p = pageOf(raw);
        const out = await runPipeline({ trigger: 'manual', candidate: { url: p.url, title: p.title, summary: p.excerpt, image: p.image || undefined, sourceName: `Website: ${conn.name}` } });
        if (!out.ok && out.kind !== 'skipped') throw new Error(out.message);
        result = out.message;
      } else if (job.type === 'replay_event') {
        const runs = await runEventAutomations(conn.id, raw);
        result = runs.length ? runs.map((r) => `${r.automationName}: ${r.status === 'sent' ? 'finished' : `stopped (${r.detail})`}.`).join(' ') : 'No automation is on for this type of item.';
      } else {
        throw new Error(`This version of DCE does not know the job “${job.type}”.`);
      }
    } catch (e) {
      status = 'failed';
      error = e instanceof Error ? e.message : String(e);
    }
    await httpRequest(conn, 'POST', `/api/connector/v1/jobs/${encodeURIComponent(job.id)}/report`, { status, result: result.trim().slice(0, 4000), error: error.slice(0, 2000) });
    reported++;
  }
  return reported;
}

/** Only one check per connection at a time: a check that is already running is joined, never started twice. */
const inflight = new Map<string, Promise<ConnectorStatus>>();
export function pollWebsite(conn: ConnectionRow): Promise<ConnectorStatus> {
  const running = inflight.get(conn.id);
  if (running) return running;
  const p = pollOnce(conn).finally(() => inflight.delete(conn.id));
  inflight.set(conn.id, p);
  return p;
}

/** One check: new events, their workflows, the jobs, and a status report to the website. Errors are saved, not thrown. */
async function pollOnce(conn: ConnectionRow): Promise<ConnectorStatus> {
  let cursor = await getSetting<number>(cursorKey(conn.id), 0);
  let events = 0;
  let jobs = 0;
  const save = async (st: ConnectorStatus) => { await setSetting(statusKey(conn.id), st); return st; };
  try {
    const r = await httpRequest(conn, 'GET', `/api/connector/v1/events?after=${cursor}&limit=50`);
    if (!r.ok) throw new Error(r.status === 401 ? 'The token was refused. Check it on the website connector page.' : r.error || 'The website did not answer.');
    const list = (r.json as { events?: unknown[] } | null)?.events ?? [];
    for (const raw of list) {
      if (!isConnectorEvent(raw)) continue;
      await dispatch(conn, raw);
      cursor = raw.id;
      events++;
      await setSetting(cursorKey(conn.id), cursor);
    }
    jobs = await runJobs(conn);
    await httpRequest(conn, 'POST', '/api/connector/v1/status', { version: appVersion(), cursor, message: `${events} new event(s), ${jobs} job(s) done` });
    return save({ at: Date.now(), ok: true, message: `${events} new event(s), ${jobs} job(s) done.`, events, jobs, cursor });
  } catch (e) {
    return save({ at: Date.now(), ok: false, message: e instanceof Error ? e.message : String(e), events, jobs, cursor });
  }
}
