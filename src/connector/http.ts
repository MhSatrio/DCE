import { DEFAULT_RELAY } from '../automation/buffer';
import { makeProp, readProp } from '../db/connections';
import { db, getSetting, type ConnectionRow } from '../db/schema';
import { uid } from '../engine/njs';

/**
 * The generic HTTP connector. A connection stores its address, the name of the header that carries its credential, and the
 * credential itself (all encrypted, like every other value). Calls go through the local helper (POST /http), which only
 * reaches the address of the connection, over https, and never follows redirects.
 *
 * Kinds: "website" (a VierApparatus site with the website connector: DCE polls its events and takes its jobs) and
 * "api" (any other service; you call it from workflows only).
 */
export type HttpKind = 'website' | 'api';
export type HttpResult = { ok: boolean; status: number; json: unknown; text: string; error: string };

const fail = (error: string): HttpResult => ({ ok: false, status: 0, json: null, text: '', error });

async function valueOf(conn: ConnectionRow, key: string): Promise<string> {
  const p = conn.props.find((x) => x.key === key);
  return p ? (await readProp(p)).trim() : '';
}

export const httpKind = async (conn: ConnectionRow): Promise<HttpKind> => ((await valueOf(conn, 'KIND')) === 'website' ? 'website' : 'api');
export const httpBase = async (conn: ConnectionRow): Promise<string> => (await valueOf(conn, 'BASE_URL')).replace(/\/+$/, '');

/**
 * One call to the connection's address. `body` is sent as JSON; `raw` (when given) is sent exactly as written, for a
 * body that is already text. Never throws: problems come back in `error`.
 */
export async function httpRequest(conn: ConnectionRow, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown, raw?: string): Promise<HttpResult> {
  const base = await httpBase(conn);
  if (!base) return fail('This connection has no address.');
  let host: string;
  try { host = new URL(base).hostname; } catch { return fail('The address of this connection is not valid.'); }
  const header = (await valueOf(conn, 'AUTH_HEADER')) || 'Authorization';
  let value = await valueOf(conn, 'AUTH_VALUE');
  if (header.toLowerCase() === 'authorization' && value && !/^(Bearer|Basic)\s/i.test(value)) value = `Bearer ${value}`;
  const headers: Record<string, string> = { accept: 'application/json' };
  if (value) headers[header.toLowerCase()] = value;
  const payload = raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body);
  if (payload !== undefined) headers['content-type'] = raw !== undefined && !/^\s*[[{]/.test(raw) ? 'text/plain; charset=utf-8' : 'application/json';
  const relay = (await getSetting<string>('relay.url', DEFAULT_RELAY)).replace(/\/+$/, '');
  let res: Response;
  try {
    res = await fetch(`${relay}/http`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: base + path, method, headers, body: payload, hosts: [host], timeoutMs: 20000 }),
      signal: AbortSignal.timeout(40000),
    });
  } catch {
    return fail(`Cannot reach the local helper at ${relay}. It starts with the app; in a browser, run "npm run relay".`);
  }
  let r: { ok?: boolean; status?: number; body?: string; error?: string };
  try { r = (await res.json()) as typeof r; } catch { return fail('The local helper answered with no usable result.'); }
  const text = r.body ?? '';
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON: the text is kept */ }
  return { ok: !!r.ok, status: r.status ?? 0, json, text, error: r.error ?? (r.ok ? '' : `HTTP ${r.status ?? 0}`) };
}

/** Checks an address before it is saved: https only (http is allowed only for a local test address). */
export function addressProblem(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return 'Enter a full address, for example https://vierapparatus.com'; }
  // http is accepted only for this computer (a local test server); the helper refuses plain http for every other address
  const local = u.hostname === '127.0.0.1' || u.hostname === 'localhost';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return 'The address must start with https://';
  return null;
}

export async function createHttpConnection(input: { name: string; baseUrl: string; header: string; value: string; kind: HttpKind }): Promise<ConnectionRow> {
  const row: ConnectionRow = { id: uid(), provider: 'http', name: input.name.trim() || 'HTTP connection', created_at: Date.now(), props: [], kind: input.kind };
  row.props.push(await makeProp('KIND', input.kind));
  row.props.push(await makeProp('BASE_URL', input.baseUrl.trim().replace(/\/+$/, '')));
  row.props.push(await makeProp('AUTH_HEADER', input.header.trim() || 'Authorization'));
  if (input.value.trim()) row.props.push(await makeProp('AUTH_VALUE', input.value.trim()));
  await db.connections.put(row);
  return row;
}
