import { db, type ConnCaps, type ConnectionRow } from '../db/schema';
import { httpRequest } from './http';

/**
 * "Test connection" for an API: DCE looks for a published description of the API (OpenAPI / Swagger) and stores the
 * operations it finds, so the automation editor can offer them. Nothing is guessed: without a description the user
 * types the method and path, and the connection is still usable.
 */

export const API_DESCRIPTION_PATHS = ['/openapi.json', '/swagger.json', '/api-docs', '/v3/api-docs'];
const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

/** The operations of an OpenAPI document, as "METHOD /path — summary". Pure. */
export function operationsOf(doc: unknown): { method: string; path: string; summary: string }[] {
  const paths = (doc as { paths?: Record<string, Record<string, { summary?: string; operationId?: string }>> } | null)?.paths;
  if (!paths || typeof paths !== 'object') return [];
  const out: { method: string; path: string; summary: string }[] = [];
  for (const [path, item] of Object.entries(paths)) {
    if (!item || typeof item !== 'object') continue;
    for (const m of METHODS) {
      const op = item[m];
      if (op) out.push({ method: m.toUpperCase(), path, summary: String(op.summary ?? op.operationId ?? '').slice(0, 160) });
      if (out.length >= 300) return out;
    }
  }
  return out;
}

export async function saveCaps(connId: string, caps: ConnCaps): Promise<void> {
  await db.connections.update(connId, { caps });
}

/** The result of "Test connection" for an API. */
export async function testApi(conn: ConnectionRow): Promise<{ ok: boolean; message: string }> {
  let refused = false;
  let unreachable = '';
  for (const p of API_DESCRIPTION_PATHS) {
    const r = await httpRequest(conn, 'GET', p);
    if (r.status === 401 || r.status === 403) refused = true;
    if (r.ok && r.json && typeof r.json === 'object' && 'paths' in (r.json as object)) {
      const ops = operationsOf(r.json);
      const note = `${ops.length} operation(s) found in the API description (${p}).`;
      await saveCaps(conn.id, { checkedAt: Date.now(), operations: ops, note });
      return { ok: true, message: `${note} They are offered in Automations.` };
    }
    if (!r.ok && r.status === 0) unreachable = r.error;
  }
  if (refused) {
    await saveCaps(conn.id, { checkedAt: Date.now(), note: 'The token was refused.' });
    return { ok: false, message: 'The token was refused. Check it, or create a new one.' };
  }
  if (unreachable && !refused) {
    await saveCaps(conn.id, { checkedAt: Date.now(), note: `Not reachable: ${unreachable}` });
    return { ok: false, message: `Not connected: ${unreachable}` };
  }
  const note = 'Reachable. No API description was found, so requests are written by method and path.';
  await saveCaps(conn.id, { checkedAt: Date.now(), note });
  return { ok: true, message: note };
}
