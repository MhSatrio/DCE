/**
 * Buffer channels as the pipeline sees them. The checklist is read from the Buffer account itself: every channel Buffer
 * returns is saved (its id encrypted, like every other value), and each one is shown by service and name. A saved channel
 * that Buffer no longer returns is flagged. Channel ids are never displayed.
 */
import { DEFAULT_RELAY, listChannels, type BufferChannel } from '../automation/buffer';
import { ACTIVE_KEY, channelProps, makeProp, readProp } from '../db/connections';
import { db, getSetting, setSetting, type ChannelMeta, type ConnectionRow } from '../db/schema';

const SERVICE_NAMES: Record<string, string> = {
  instagram: 'Instagram', linkedin: 'LinkedIn', facebook: 'Facebook', twitter: 'X', x: 'X', threads: 'Threads', tiktok: 'TikTok',
  pinterest: 'Pinterest', youtube: 'YouTube', googlebusiness: 'Google Business', mastodon: 'Mastodon', bluesky: 'Bluesky',
};
/** "linkedin" → "LinkedIn"; unknown services are capitalised. */
export const serviceLabel = (s: string): string => SERVICE_NAMES[s.toLowerCase()] ?? (s ? s.charAt(0).toUpperCase() + s.slice(1) : 'Channel');

/** Property key for a channel: BUFFER_CHANNEL_ID_<SERVICE>_<NAME>, numbered when two channels would clash. */
export function channelPropKey(c: { service: string; name: string }, taken: Set<string>): string {
  const base = `BUFFER_CHANNEL_ID_${c.service}_${c.name}`.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  let k = base;
  let i = 2;
  while (taken.has(k)) k = `${base}_${i++}`;
  return k;
}

export const metaOf = (c: BufferChannel): ChannelMeta => ({ service: c.service, name: c.name, org: c.org });

/** How a channel should be labelled in the checklist. */
export function channelTitle(p: { key: string; meta?: ChannelMeta }): string {
  if (!p.meta) return p.key.replace(/^BUFFER_CHANNEL_ID_?/i, '').replace(/_/g, ' ').trim() || 'Channel';
  return `${serviceLabel(p.meta.service)} · ${p.meta.name}`;
}

export interface Reconciled { linked: { key: string; channel: BufferChannel }[]; stale: string[]; fresh: BufferChannel[] }

/** Pure: matches saved channel ids (already decrypted) with the live list from Buffer. */
export function reconcileChannels(saved: { key: string; id: string }[], live: BufferChannel[]): Reconciled {
  const byId = new Map(live.map((c) => [c.id, c]));
  const seen = new Set<string>();
  const linked: Reconciled['linked'] = [];
  const stale: string[] = [];
  for (const s of saved) {
    const c = byId.get(s.id.trim());
    if (c && !seen.has(c.id)) { seen.add(c.id); linked.push({ key: s.key, channel: c }); }
    else stale.push(s.key);
  }
  return { linked, stale, fresh: live.filter((c) => !seen.has(c.id)) };
}

export interface ChannelReport { at: number; connId: string; stale: string[]; added: string[]; total: number }
export const channelReportKey = (connId: string) => `pipeline.channels.${connId}`;
export async function getChannelReport(connId: string): Promise<ChannelReport | null> {
  return getSetting<ChannelReport | null>(channelReportKey(connId), null);
}

/** Saves the live channels: links saved ids (adds their names), auto-adds new channels, flags the ones Buffer no longer has. */
export async function saveChannels(connId: string, live: BufferChannel[]): Promise<ChannelReport> {
  const conn = await db.connections.get(connId);
  if (!conn) throw new Error('The Buffer account no longer exists.');
  const saved = await Promise.all(channelProps(conn).map(async (p) => ({ key: p.key, id: await readProp(p).catch(() => '') })));
  const r = reconcileChannels(saved, live);
  const row = (await db.connections.get(connId)) ?? conn;
  for (const l of r.linked) {
    const p = row.props.find((x) => x.key === l.key);
    if (p) p.meta = metaOf(l.channel);
  }
  const taken = new Set(row.props.map((p) => p.key));
  const added: string[] = [];
  for (const c of r.fresh) {
    const key = channelPropKey(c, taken);
    taken.add(key);
    const p = await makeProp(key, c.id, metaOf(c));
    row.props.push(p);
    added.push(key);
  }
  if (added.length || r.linked.length) await db.connections.put(row);
  const report: ChannelReport = { at: Date.now(), connId, stale: r.stale, added, total: live.length };
  await setSetting(channelReportKey(connId), report);
  return report;
}

/** The account the pipeline posts through: the chosen one, else the active Buffer account. */
export async function resolveBufferConnection(connectionId: string): Promise<ConnectionRow | undefined> {
  if (connectionId) {
    const c = await db.connections.get(connectionId);
    if (c && c.provider === 'buffer') return c;
  }
  const active = await getSetting<string>(ACTIVE_KEY('buffer'), '');
  return (active ? await db.connections.get(active) : undefined) ?? (await db.connections.where('provider').equals('buffer').first());
}

/** Asks Buffer which channels the account has right now and saves them. Throws a readable Error when Buffer cannot be reached. */
export async function refreshBufferChannels(connectionId: string): Promise<ChannelReport & { accountName: string }> {
  const conn = await resolveBufferConnection(connectionId);
  if (!conn) throw new Error('Add a Buffer account in Settings → Connections first.');
  const keyProp = conn.props.find((p) => /^BUFFER_API_KEY$/i.test(p.key)) ?? conn.props.find((p) => /api[_-]?key|token/i.test(p.key));
  if (!keyProp) throw new Error(`Account “${conn.name}” has no API key yet.`);
  const apiKey = await readProp(keyProp);
  const relay = await getSetting<string>('relay.url', DEFAULT_RELAY);
  const live = await listChannels(relay, apiKey);
  const report = await saveChannels(conn.id, live);
  return { ...report, accountName: conn.name };
}
