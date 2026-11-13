/**
 * Minimal client for Buffer's GraphQL API (https://developers.buffer.com).
 *
 * api.buffer.com does not answer browser (CORS) requests, so calls go through the small local relay
 * (`npm run relay`, server/relay.mjs) which forwards them and adds the CORS headers. The API key is sent to the relay
 * on every call (over 127.0.0.1) and never stored there.
 */
export const DEFAULT_RELAY = 'http://127.0.0.1:8788';

export interface BufferChannel { id: string; name: string; service: string; org: string }
export interface SendOptions { text: string; channelId: string; mode: 'queue' | 'scheduled'; dueAt?: string; imageUrl?: string }
export interface SendResult { ok: boolean; postId?: string; dueAt?: string; error?: string }

/** GraphQL string literal for arbitrary text (JSON string syntax is a valid GraphQL string). */
const lit = (s: string) => JSON.stringify(s);

/** Inline-literal mutation exactly as in Buffer's documentation (no dependency on input type names). */
export function buildCreatePost(o: SendOptions): string {
  const parts = [`text: ${lit(o.text)}`, `channelId: ${lit(o.channelId)}`, 'schedulingType: automatic'];
  if (o.mode === 'scheduled' && o.dueAt) parts.push('mode: customScheduled', `dueAt: ${lit(o.dueAt)}`);
  else parts.push('mode: addToQueue');
  if (o.imageUrl) parts.push(`assets: [{ image: { url: ${lit(o.imageUrl)} } }]`);
  return `mutation { createPost(input: { ${parts.join(', ')} }) { ... on PostActionSuccess { post { id dueAt text } } ... on MutationError { message } } }`;
}

export class RelayError extends Error {}

async function call(relay: string, apiKey: string, query: string): Promise<{ data?: Record<string, unknown>; errors?: { message: string }[] }> {
  let res: Response;
  try {
    res = await fetch(`${relay.replace(/\/+$/, '')}/buffer`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` }, body: JSON.stringify({ query }),
    });
  } catch {
    throw new RelayError(`Cannot reach the local relay at ${relay}. Start it with "npm run relay" (Buffer does not allow direct browser calls).`);
  }
  const text = await res.text();
  let json: { data?: Record<string, unknown>; errors?: { message: string }[]; error?: string } = {};
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) throw new Error('Buffer rejected the API key (unauthorised).');
    throw new Error(json.error ?? `Buffer answered HTTP ${res.status}${text ? `: ${text.slice(0, 160)}` : ''}`);
  }
  return json;
}

export async function relayHealth(relay: string): Promise<{ ok: boolean; message: string }> {
  try {
    const r = await fetch(`${relay.replace(/\/+$/, '')}/health`);
    const j = await r.json() as { ok?: boolean; upstream?: string };
    return j.ok ? { ok: true, message: `Relay is running (forwarding to ${j.upstream}).` } : { ok: false, message: 'The relay answered, but not as expected.' };
  } catch {
    return { ok: false, message: `No relay at ${relay}. Run "npm run relay" in the DCE folder.` };
  }
}

export async function createPost(relay: string, apiKey: string, o: SendOptions): Promise<SendResult> {
  try {
    const j = await call(relay, apiKey, buildCreatePost(o));
    if (j.errors?.length) return { ok: false, error: j.errors.map((e) => e.message).join('; ') };
    const r = (j.data?.createPost ?? {}) as { post?: { id: string; dueAt?: string }; message?: string };
    if (r.post) return { ok: true, postId: r.post.id, dueAt: r.post.dueAt };
    return { ok: false, error: r.message ?? 'Buffer returned neither a post nor an error message.' };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Lists the account's channels (also proves the key works). */
export async function listChannels(relay: string, apiKey: string): Promise<BufferChannel[]> {
  const org = await call(relay, apiKey, 'query { account { organizations { id name } } }');
  if (org.errors?.length) throw new Error(org.errors.map((e) => e.message).join('; '));
  const orgs = ((org.data?.account as { organizations?: { id: string; name: string }[] } | undefined)?.organizations) ?? [];
  const out: BufferChannel[] = [];
  for (const o of orgs) {
    const r = await call(relay, apiKey, `query { channels(input: { organizationId: ${lit(o.id)} }) { id name service } }`);
    if (r.errors?.length) throw new Error(r.errors.map((e) => e.message).join('; '));
    for (const c of ((r.data?.channels as { id: string; name: string; service: string }[] | undefined) ?? [])) out.push({ ...c, org: o.name });
  }
  return out;
}
