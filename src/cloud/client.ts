import { DEFAULT_RELAY } from '../automation/buffer';
import { readProp } from '../db/connections';
import { db, getSetting, type ConnectionRow } from '../db/schema';
import type { Destination } from '../batch/runner';

/**
 * The screen's side of the cloud destinations. Every request goes to the local relay (127.0.0.1), which talks to R2 or
 * Google. The secrets are read from the encrypted vault only at the moment of a request.
 */

export interface CloudResult { ok: boolean; error?: string; [key: string]: unknown }

export async function relayBase(): Promise<string> {
  return (await getSetting<string>('relay.url', DEFAULT_RELAY)).replace(/\/+$/, '');
}

/** One request to the relay's cloud routes. A network problem comes back as a plain message, never as a throw. */
export async function cloudCall<T extends CloudResult = CloudResult>(route: string, body: Record<string, unknown>): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${await relayBase()}/cloud${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    return { ok: false, error: 'Cannot reach the local helper. It starts with the app; in a browser, run “npm run relay”.' } as T;
  }
  try { return (await res.json()) as T; }
  catch { return { ok: false, error: 'The local helper answered with no usable result.' } as T; }
}

/** The decrypted values of a connection, by name. Used only to build a request. */
export async function secretsOf(conn: ConnectionRow): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const p of conn.props) {
    try { out[p.key] = (await readProp(p)).trim(); } catch { out[p.key] = ''; }
  }
  return out;
}

/** Bytes as base64, in pieces (a large file must not overflow the call stack). */
export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** https, or plain http for this computer only (a local test server). */
export function isWebAddress(address: string): boolean {
  try {
    const u = new URL(address.trim());
    return u.protocol === 'https:' || (u.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(u.hostname));
  } catch { return false; }
}

/** The address of a key in the bucket's public domain, each part encoded. */
export function publicUrl(base: string, key: string): string {
  return `${base.replace(/\/+$/, '')}/${key.split('/').map(encodeURIComponent).join('/')}`;
}

// ------------------------------------------------------------------------------------------------ Cloudflare R2

export async function r2Destination(conn: ConnectionRow, record: (recordId: string, url: string) => Promise<void>): Promise<Destination> {
  const s = await secretsOf(conn);
  const publicBase = s.PUBLIC_BASE ?? '';
  if (!s.ENDPOINT || !s.BUCKET || !s.ACCESS_KEY_ID || !s.SECRET_ACCESS_KEY) throw new Error(`The R2 connection “${conn.name}” is incomplete. Edit it in Settings → Cloud destinations.`);
  if (!isWebAddress(publicBase)) throw new Error(`Set the public address of the bucket (for example https://pub-….r2.dev or your own domain) on “${conn.name}”, so the links work for others.`);
  const prefix = (s.PREFIX ?? '').replace(/^\/+|\/+$/g, '');
  const label = `Cloudflare R2 · ${s.BUCKET}`;
  return {
    label,
    async put(name, bytes, mime) {
      const key = prefix ? `${prefix}/${name}` : name;
      const r = await cloudCall('/r2/put', {
        endpoint: s.ENDPOINT, bucket: s.BUCKET, accessKeyId: s.ACCESS_KEY_ID, secretAccessKey: s.SECRET_ACCESS_KEY,
        key, contentType: mime, body: toBase64(bytes),
      });
      if (!r.ok) throw new Error(String(r.error ?? 'R2 did not accept the file.'));
      return publicUrl(publicBase, key);
    },
    record,
  };
}

/** The public addresses of the connected R2 buckets (only the ones that are set). */
export async function r2PublicBases(): Promise<string[]> {
  const out: string[] = [];
  for (const conn of await cloudConnections()) {
    if (conn.provider !== 'r2') continue;
    const t = await r2Target(conn);
    if (t.publicBase) out.push(t.publicBase);
  }
  return out;
}

/** The public address and the key prefix of an R2 connection (empty when they are not set). */
export async function r2Target(conn: ConnectionRow): Promise<{ publicBase: string; prefix: string }> {
  const s = await secretsOf(conn);
  return { publicBase: (s.PUBLIC_BASE ?? '').replace(/\/+$/, ''), prefix: (s.PREFIX ?? '').replace(/^\/+|\/+$/g, '') };
}

/**
 * The bucket key of a public address of an R2 connection, or null when the address is not one of its files (another site,
 * another folder). A file is only ever deleted through this check, so nothing outside the connection's folder is touched.
 */
export function keyFromPublicUrl(publicBase: string, prefix: string, url: string): string | null {
  const base = publicBase.replace(/\/+$/, '');
  if (!base || !url.startsWith(`${base}/`)) return null;
  const key = url.slice(base.length + 1).split('/').map((part) => { try { return decodeURIComponent(part); } catch { return part; } }).join('/');
  if (!key || (prefix && !key.startsWith(`${prefix}/`))) return null;
  return key;
}

/** The R2 connection and key of a public address, when it is a file of a connected bucket. */
export async function r2FileOf(url: string): Promise<{ conn: ConnectionRow; key: string } | null> {
  for (const conn of await cloudConnections()) {
    if (conn.provider !== 'r2') continue;
    const t = await r2Target(conn);
    const key = keyFromPublicUrl(t.publicBase, t.prefix, url);
    if (key) return { conn, key };
  }
  return null;
}

/** Deletes one object from an R2 connection's bucket. A file that is already gone counts as deleted. */
export async function r2Delete(conn: ConnectionRow, key: string): Promise<CloudResult> {
  const s = await secretsOf(conn);
  if (!s.ENDPOINT || !s.BUCKET || !s.ACCESS_KEY_ID || !s.SECRET_ACCESS_KEY) return { ok: false, error: `The R2 connection “${conn.name}” is incomplete.` };
  return cloudCall('/r2/delete', { endpoint: s.ENDPOINT, bucket: s.BUCKET, accessKeyId: s.ACCESS_KEY_ID, secretAccessKey: s.SECRET_ACCESS_KEY, key });
}

// ------------------------------------------------------------------------------------------------ Google Drive

const tokens = new Map<string, { token: string; until: number }>();

/** A short-lived access token for a Drive connection, refreshed from its refresh token when needed. */
export async function driveToken(conn: ConnectionRow, force = false): Promise<string> {
  const hit = tokens.get(conn.id);
  if (!force && hit && hit.until > Date.now() + 60_000) return hit.token;
  const s = await secretsOf(conn);
  if (!s.CLIENT_ID || !s.CLIENT_SECRET || !s.REFRESH_TOKEN) throw new Error(`Google Drive is not connected for “${conn.name}”. Connect it in Settings → Cloud destinations.`);
  const r = await cloudCall<CloudResult & { accessToken?: string; expiresIn?: number }>('/google/token', { clientId: s.CLIENT_ID, clientSecret: s.CLIENT_SECRET, refreshToken: s.REFRESH_TOKEN });
  if (!r.ok || !r.accessToken) throw new Error(`Google did not accept the sign-in of “${conn.name}”: ${r.error ?? 'unknown reason'}. Connect Google Drive again in Settings.`);
  tokens.set(conn.id, { token: r.accessToken, until: Date.now() + (r.expiresIn ?? 3000) * 1000 });
  return r.accessToken;
}

/** Checks a folder link (or id) with Google and returns its id and name, or the reason it cannot be used. */
export async function resolveDriveFolder(conn: ConnectionRow, input: string): Promise<{ id: string; name: string } | { error: string }> {
  const token = await driveToken(conn);
  const r = await cloudCall<CloudResult & { id?: string; name?: string }>('/drive/folder', { accessToken: token, input });
  if (!r.ok || !r.id) return { error: String(r.error ?? 'The folder could not be used.') };
  return { id: r.id, name: r.name ?? r.id };
}

export function driveDestination(conn: ConnectionRow, folderId: string, folderName: string, record: (recordId: string, url: string) => Promise<void>): Destination {
  return {
    label: `Google Drive · ${folderName}`,
    async put(name, bytes, mime) {
      const send = async (token: string) => cloudCall<CloudResult & { url?: string }>('/drive/upload', {
        accessToken: token, folderId, name, mimeType: mime, body: toBase64(bytes), makePublic: true,
      });
      let r = await send(await driveToken(conn));
      // a token that expired during a long batch is refreshed once and the file is sent again
      if (!r.ok && /refused the sign-in/.test(String(r.error ?? ''))) r = await send(await driveToken(conn, true));
      if (!r.ok || !r.url) throw new Error(String(r.error ?? 'Google Drive did not accept the file.'));
      return r.url;
    },
    record,
  };
}

/** Lists the folders inside a parent (the root by default), one page at a time. */
export async function listDriveFolders(conn: ConnectionRow, parentId: string, pageToken = ''): Promise<CloudResult & { folders?: { id: string; name: string }[]; nextPageToken?: string }> {
  const token = await driveToken(conn);
  return cloudCall('/drive/folders', { accessToken: token, parentId, pageToken });
}

/** Starts the Google sign-in and returns the address to open. The result is collected with `finishDriveSignIn`. */
export async function startDriveSignIn(clientId: string, clientSecret: string): Promise<CloudResult & { state?: string; authUrl?: string }> {
  return cloudCall('/google/oauth/start', { clientId, clientSecret });
}

/** Waits until the browser has come back with the sign-in, then returns the refresh token (once). */
export async function finishDriveSignIn(state: string, timeoutMs = 180_000): Promise<CloudResult & { refreshToken?: string; accessToken?: string }> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const r = await cloudCall<CloudResult & { pending?: boolean; refreshToken?: string; accessToken?: string }>('/google/oauth/result', { state });
    if (!r.ok) return r;
    if (!r.pending) return r;
    await new Promise((res) => setTimeout(res, 1500));
  }
  return { ok: false, error: 'The sign-in was not finished within 3 minutes. Start “Connect Google Drive” again.' };
}

/** The cloud connections of the vault. */
export const cloudConnections = (): Promise<ConnectionRow[]> => db.connections.where('provider').anyOf(['r2', 'gdrive']).toArray();
