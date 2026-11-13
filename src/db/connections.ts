import { uid } from '../engine/njs';
import { guard } from '../ui/store';
import { db, getSetting, setSetting, type ChannelMeta, type ConnectionProp, type ConnectionRow } from './schema';
import { decryptSecret, encryptSecret } from './vault';

/**
 * Accounts for external services (Buffer today). Every property value is encrypted before it is stored, and screens
 * only ever receive the ciphertext: plaintext exists in memory just while a value is revealed or a request is sent.
 */
export const GEMINI_KEY_PROP = 'GEMINI_API_KEY';
export const ACTIVE_KEY = (provider: string) => `connections.active.${provider}`;

export async function createConnection(name: string, provider: ConnectionRow['provider'] = 'buffer', apiKey = ''): Promise<ConnectionRow> {
  const row: ConnectionRow = { id: uid(), provider, name: name.trim() || (provider === 'gemini' ? 'Gemini' : 'Buffer account'), created_at: Date.now(), props: [] };
  if (apiKey.trim()) row.props.push(await makeProp(provider === 'gemini' ? GEMINI_KEY_PROP : 'BUFFER_API_KEY', apiKey.trim()));
  await guard('Saving account', async () => { await db.connections.put(row); });
  if (!(await getSetting<string>(ACTIVE_KEY(provider), ''))) await setSetting(ACTIVE_KEY(provider), row.id);
  return row;
}

export async function makeProp(key: string, plain: string, meta?: ChannelMeta): Promise<ConnectionProp> {
  const p: ConnectionProp = { id: uid(), key: key.trim(), secret: true, enc: await encryptSecret(plain) };
  if (meta) p.meta = meta;
  return p;
}

export async function renameConnection(id: string, name: string): Promise<void> {
  await db.connections.update(id, { name: name.trim() || 'Account' });
}

export async function deleteConnection(id: string): Promise<void> {
  const row = await db.connections.get(id);
  await db.connections.delete(id);
  if (row && (await getSetting<string>(ACTIVE_KEY(row.provider), '')) === id) {
    const next = await db.connections.where('provider').equals(row.provider).first();
    await setSetting(ACTIVE_KEY(row.provider), next?.id ?? '');
  }
}

export async function addProp(connId: string, key: string, plain: string): Promise<void> {
  const row = await db.connections.get(connId);
  if (!row) return;
  const k = key.trim();
  if (!k || !plain) throw new Error('Both a name and a value are needed.');
  if (row.props.some((p) => p.key === k)) throw new Error(`“${k}” already exists on this account — replace its value instead.`);
  row.props.push(await makeProp(k, plain));
  await db.connections.put(row);
}

export async function replaceProp(connId: string, propId: string, plain: string): Promise<void> {
  const row = await db.connections.get(connId);
  const p = row?.props.find((x) => x.id === propId);
  if (!row || !p) return;
  if (!plain) throw new Error('The value cannot be empty.');
  p.enc = await encryptSecret(plain); delete p.value; p.secret = true;
  await db.connections.put(row);
}

export async function removeProp(connId: string, propId: string): Promise<void> {
  const row = await db.connections.get(connId);
  if (!row) return;
  row.props = row.props.filter((p) => p.id !== propId);
  await db.connections.put(row);
}

export async function readProp(p: ConnectionProp): Promise<string> {
  return p.enc ? decryptSecret(p.enc) : p.value ?? '';
}

/** Any value stored in plain text by an older version / import is encrypted on first open. */
export async function encryptLegacy(): Promise<void> {
  for (const c of await db.connections.toArray()) {
    let changed = false;
    for (const p of c.props) if (!p.enc && p.value) { p.enc = await encryptSecret(p.value); delete p.value; p.secret = true; changed = true; }
    if (changed) await db.connections.put(c);
  }
}

export const channelProps = (c: ConnectionRow) => c.props.filter((p) => /^BUFFER_CHANNEL_ID/i.test(p.key));
export const channelLabel = (key: string) => key.replace(/^BUFFER_CHANNEL_ID_?/i, '').replace(/_/g, ' ').trim() || 'default';

/** The decrypted Gemini API key, or '' when none is stored. Decrypted only at the moment a request is made. */
export async function readGeminiKey(): Promise<string> {
  const conn = await db.connections.where('provider').equals('gemini').first();
  return conn ? readGeminiKeyOf(conn) : '';
}

/** The decrypted key of one Gemini connection (an automation step names its connection). */
export async function readGeminiKeyOf(conn: ConnectionRow): Promise<string> {
  const p = conn.props.find((x) => x.key === GEMINI_KEY_PROP);
  if (!p) return '';
  try { return (await readProp(p)).trim(); } catch { return ''; }
}
