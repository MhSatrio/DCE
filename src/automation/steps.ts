import { readGeminiKeyOf } from '../db/connections';
import { coerce, displayValue, getValue } from '../db/fields';
import { randomSlot } from './triggers';
import { decryptSecret } from '../db/vault';
import { db, getSetting, type AutoFilter, type AutoStep, type BatchConfig, type ContentRecord, type FieldType, type TimingConfig } from '../db/schema';
import { matchGroup, type FilterGroup } from '../db/filter';
import { allTables, createRows, deleteRows, fieldsOf, newRow, recordsOf, saveFieldIn, tableName, updateRow } from '../db/tables';
import { r2Delete, r2FileOf, r2PublicBases } from '../cloud/client';
import { sameFileAt } from '../cloud/addresses';
import { unlinkEverywhere } from '../cloud/retention';
import { remoteImage } from '../db/remote';
import { uid } from '../engine/njs';
import { renderTemplateString } from '../engine/binding';
import { buildFillPrompt, parseFillOutput, parsePlaceholders, sourceTextOf } from '../connector/fill';
import { asText, COLUMN_KEY, columnLabel, guessType } from '../connector/paths';
import type { ConnectorEvent } from '../connector/events';
import { httpRequest } from '../connector/http';
import { generate, withBackoff } from '../pipeline/gemini';
import { createPost, DEFAULT_RELAY } from './buffer';
import { bufferAddressOf, bufferImageProblem, channelLabelOf, fillTemplate, imageLinksOf, sourceOfValues, stepProblems } from './model';

/**
 * What each "Then" action really does. A step gets the current item (a record, or a website item), changes what it
 * must, and says what happened. A step that fails stops the item; the next attempt starts at that step, so a post that
 * was already sent is never sent again. A step that must not be retried throws StopItem.
 */

export const UNIT_MS = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 } as const;

/** The item an automation works on. `base` is the id its row gets in a table; `home` is the table of a record item. */
export interface Cur {
  key: string;                       // progress key: the record id, or the website entity id
  title: string;
  values: Record<string, unknown>;   // what {{templates}} can read
  base: string;
  home?: string;
  event?: ConnectorEvent;
  table?: string;
  alreadyPosted?: boolean;           // a Buffer post was already made for this website item
  posted?: boolean;                  // a Buffer post was made during this run
}

export interface StepOut { status: 'ok' | 'skipped' | 'dry'; detail: string; postId?: string; dueAt?: string }
export interface RunCtx { automationName: string; dry: boolean; now: number }

/** The item is finished, not failed: it is not retried (for example its time has passed, or its date is empty). */
export class StopItem extends Error {}

export type Timing = { mode: 'queue' } | { mode: 'scheduled'; dueAt: string } | { skip: string };

/** When should Buffer publish? Pure: `now` is injected. A date without a time means 09:00 local time that day. */
export function scheduleFor(cfg: TimingConfig, raw: string | undefined, fieldLabel: string | undefined, now: number): Timing {
  if (cfg.mode === 'queue') return { mode: 'queue' };
  if (cfg.mode === 'delay') {
    const ms = Math.max(0, cfg.delayAmount || 0) * UNIT_MS[cfg.delayUnit];
    return { mode: 'scheduled', dueAt: new Date(now + ms).toISOString() };
  }
  const v = String(raw ?? '').trim();
  if (!v) return { skip: `“${fieldLabel ?? 'The time field'}” is empty.` };
  const when = /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T09:00`) : new Date(v);
  if (Number.isNaN(when.getTime())) return { skip: `“${v}” is not a valid date / time.` };
  if (when.getTime() <= now) return cfg.pastPolicy === 'queue' ? { mode: 'queue' } : { skip: `The chosen time (${v}) has already passed.` };
  return { mode: 'scheduled', dueAt: when.toISOString() };
}

/** The row an item has in a table: the item itself in its own table, otherwise a row with a derived id (never shared). */
export const rowIdFor = (cur: Cur, table: string) => (table === cur.home ? cur.base : `${cur.base}~${table}`);

const scopeOf = (v: Record<string, unknown>) => ({ ...v, content: v, record: v });
const render = (tpl: string, cur: Cur) => renderTemplateString(tpl, scopeOf(cur.values)).text;
const preview = (t: string) => `${t.slice(0, 140)}${t.length > 140 ? '…' : ''}`;

function needTable(id: string): void {
  if (!id || !allTables().some((t) => t.id === id)) throw new Error('The table of this action no longer exists. Edit the automation and choose a table.');
}

export function targetRow(cur: Cur, table: string): ContentRecord | undefined {
  const id = rowIdFor(cur, table);
  return recordsOf(table).find((r) => r.id === id);
}

/** Writes one value into a row, with the same rules the table uses (type check, read-only and sync fields refused). */
export async function setCell(table: string, id: string, key: string, raw: string): Promise<void> {
  const f = fieldsOf(table).find((x) => x.key === key);
  if (!f) throw new Error(`The field “${key}” does not exist in ${tableName(table)}.`);
  if (f.readonly || f.sync) throw new Error(`“${f.label}” cannot be changed by an automation.`);
  const rec = recordsOf(table).find((r) => r.id === id);
  if (!rec) throw new Error('The row is not in the table.');
  const c = coerce(raw, f);
  if (c.error) throw new Error(`“${raw}” is not a valid value for “${f.label}”: ${c.error}`);
  await updateRow(table, id, f.builtin ? ({ [key]: c.value } as Partial<ContentRecord>) : { data: { ...rec.data, [key]: c.value } });
}

/** Adds the columns that do not exist yet (a new column takes its type from a sample value). */
async function ensureColumns(tableId: string, cols: { key: string; sample: string; type?: FieldType }[]): Promise<void> {
  const current = fieldsOf(tableId);
  const have = new Set(current.map((f) => f.key));
  let order = current.length;
  for (const c of cols) {
    if (have.has(c.key)) continue;
    if (!COLUMN_KEY.test(c.key)) throw new Error(`“${c.key}” is not a valid column name (letters, digits and _ only).`);
    await saveFieldIn(tableId, { id: uid(), key: c.key, label: columnLabel(c.key), type: c.type ?? guessType(c.key, c.sample), order: order++ });
    have.add(c.key);
  }
}

// ------------------------------------------------------------------------------------------------ Buffer

/** The decrypted API key and one channel id of a Buffer account ('' = the active account). Shared by automations and the pipeline. */
export async function activeConnectionId(): Promise<string> {
  return getSetting<string>('connections.active.buffer', '');
}

export async function resolveBufferCredentials(connectionId: string, channelKey: string): Promise<{ apiKey: string; channelId: string; account: string } | { error: string }> {
  const id = connectionId || (await activeConnectionId());
  const conn = (id ? await db.connections.get(id) : undefined) ?? (await db.connections.where('provider').equals('buffer').first());
  if (!conn) return { error: 'No Buffer account is set up. Add one in Settings → Connections.' };
  const keyProp = conn.props.find((p) => p.secret && /api[_-]?key|token/i.test(p.key)) ?? conn.props.find((p) => /api[_-]?key|token/i.test(p.key));
  if (!keyProp) return { error: `Account “${conn.name}” has no API key property.` };
  const chan = conn.props.find((p) => p.key === channelKey);
  if (!chan?.value && !chan?.enc) return { error: `Account “${conn.name}” has no channel “${channelKey}”.` };
  try {
    const apiKey = keyProp.enc ? await decryptSecret(keyProp.enc) : keyProp.value ?? '';
    const channelId = chan.enc ? await decryptSecret(chan.enc) : chan.value ?? '';
    if (!apiKey) return { error: `The API key of “${conn.name}” is empty.` };
    return { apiKey, channelId: channelId.trim(), account: conn.name };
  } catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
}

/**
 * Reads each image address now. An address that does not open its image is a problem (Buffer would fail later, after the post
 * is made). A link on a Cloudflare development address is replaced by the bucket's current public address for the same file,
 * when that address serves it.
 */
async function readableImages(addresses: string[]): Promise<{ urls: string[]; notes: string[]; problems: string[] }> {
  const bases = await r2PublicBases();
  const urls: string[] = [];
  const notes: string[] = [];
  const problems: string[] = [];
  for (const address of addresses) {
    const candidates = [...bases.map((b) => sameFileAt(address, b)).filter((x): x is string => x !== null), address];
    const reasons: string[] = [];
    let found: string | null = null;
    for (const c of candidates) {
      const got = await remoteImage(c);
      if (got.ok) { found = c; break; }
      reasons.push(`${c} (${got.reason})`);
    }
    if (found) {
      urls.push(found);
      if (found !== address) notes.push(`The image of ${address} is sent from the bucket’s current public address, ${found}.`);
    } else problems.push(`“${address}” does not open a public image: ${reasons.join('; ')}.`);
  }
  return { urls, notes, problems };
}

async function bufferPost(s: Extract<AutoStep, { kind: 'buffer_post' }>, cur: Cur, o: RunCtx): Promise<StepOut> {
  if (cur.alreadyPosted) return { status: 'skipped', detail: 'A post for this item was already made, so it is not made again.' };
  const text = render(s.text, cur).trim();
  if (!text) throw new Error('The post text is empty for this item.');
  const notes: string[] = [];
  let imageUrls: string[] = [];
  if (s.imageField) {
    const raw = cur.values[s.imageField];
    const got = imageLinksOf(Array.isArray(raw) ? raw.join(' ') : raw);
    imageUrls = got.links;
    notes.push(...got.notes);
  }
  // Buffer reads each image itself: an address it cannot read is refused here, before anything is sent to it
  const unreadable = imageUrls.map((u) => bufferImageProblem(u)).find((p): p is string => p !== null);
  if (unreadable) throw new Error(unreadable);
  // Buffer fetches each image itself, so each address must open its image now; an address that does not is refused here,
  // before anything is sent to Buffer
  const checked = await readableImages(imageUrls.map(bufferAddressOf));
  if (checked.problems.length) throw new Error(`Buffer cannot post this: ${checked.problems.join(' ')} Upload the file again with the Batch Runner, or fix the link in the record. Nothing was sent to Buffer.`);
  imageUrls = checked.urls;
  notes.push(...checked.notes);
  let timing: Timing;
  if (s.timing.mode === 'field') {
    if (!cur.home) throw new Error('Website items have no date field: use “next free slot” or “after a delay” timing.');
    const f = fieldsOf(cur.home).find((x) => x.key === s.timing.timeField);
    timing = f ? scheduleFor(s.timing, asText(cur.values[f.key]), f.label, o.now) : { skip: 'The time field of this action no longer exists.' };
  } else timing = scheduleFor(s.timing, undefined, undefined, o.now);
  if ('skip' in timing) throw new StopItem(timing.skip);
  const creds = await resolveBufferCredentials(s.connectionId, s.channel);
  if ('error' in creds) throw new Error(creds.error);
  const when = timing.mode === 'queue' ? 'in the next free slot' : `at ${timing.dueAt}`;
  const channel = channelLabelOf(s.channel);
  if (o.dry) return { status: 'dry', detail: `Would post to ${channel} ${when}: “${preview(text)}”${imageUrls.length ? ` + ${imageUrls.length} image${imageUrls.length > 1 ? 's' : ''}` : ''}` };
  const relay = await getSetting<string>('relay.url', DEFAULT_RELAY);
  const res = await createPost(relay, creds.apiKey, { text, channelId: creds.channelId, imageUrls, mode: timing.mode === 'scheduled' ? 'scheduled' : 'queue', dueAt: timing.mode === 'scheduled' ? timing.dueAt : undefined, instagramType: /INSTAGRAM/i.test(s.channel) ? (s.instagramType ?? 'post') : undefined });
  if (!res.ok) throw new Error(res.error ?? 'Buffer did not accept the post.');
  cur.posted = true;
  // the post exists now: a problem storing its id must not fail the step, or a retry would post it again
  if (s.resultField && cur.home && res.postId) {
    try { await setCell(cur.home, cur.base, await resultFieldKey(s.resultField, cur.home), res.postId); } catch (e) { notes.push(`The post id could not be stored: ${e instanceof Error ? e.message : String(e)}`); }
  }
  return { status: 'ok', detail: `Sent via “${creds.account}” to ${channel} ${when}${notes.length ? ' — ' + notes.join(' ') : ''}`, postId: res.postId, dueAt: res.dueAt };
}

async function pipelinePost(cur: Cur, o: RunCtx): Promise<StepOut> {
  if (cur.alreadyPosted) return { status: 'skipped', detail: 'A post for this item was already made, so it is not made again.' };
  const url = asText(cur.values.url).trim();
  if (!url) throw new Error('The item has no address (url), so there is no page to write a post for.');
  if (o.dry) return { status: 'dry', detail: `Would write and check a post for ${url} with the Content pipeline settings.` };
  const { runPipeline } = await import('../pipeline/run');
  const r = await runPipeline({
    trigger: 'manual',
    candidate: {
      url, title: cur.title,
      summary: asText(cur.values.excerpt ?? cur.values.shortDescription ?? cur.values.description),
      image: asText(cur.values.image ?? cur.values.imageUrl) || undefined,
      sourceName: `Automation: ${o.automationName}`,
    },
  });
  if (r.kind === 'skipped') return { status: 'skipped', detail: r.message };
  if (!r.ok) throw new Error(r.message);
  cur.posted = true;
  return { status: 'ok', detail: r.message };
}

// ------------------------------------------------------------------------------------------------ Gemini, endpoints, tables

async function geminiFill(s: Extract<AutoStep, { kind: 'gemini_fill' }>, cur: Cur, o: RunCtx): Promise<StepOut> {
  const conn = await db.connections.get(s.connectionId);
  if (!conn || conn.provider !== 'gemini') throw new Error('The Gemini connection of this action no longer exists. Choose it again.');
  needTable(s.table);
  const fields = parsePlaceholders(s.prompt);
  const row = targetRow(cur, s.table);
  if (!row) throw new Error('This item is not in the table yet. Put an “Add or update a row” action before this one.');
  if (o.dry) return { status: 'dry', detail: `Would ask Gemini for ${fields.map((f) => f.key).join(', ')} and write them into ${tableName(s.table)}.` };
  const key = await readGeminiKeyOf(conn);
  if (!key) throw new Error(`No Gemini key in “${conn.name}”. Add it in Settings → Connections.`);
  await ensureColumns(s.table, fields.map((f) => ({ key: f.key, sample: '', type: 'longtext' as FieldType })));
  const { getConfig, modelForGemini } = await import('../pipeline/run');
  const model = await modelForGemini();
  const base = (await getConfig()).geminiBase || undefined; // the same endpoint as the Content pipeline (a test server, or Google)
  const source = cur.event ? sourceTextOf(cur.event.payload) : sourceOfValues(cur.values);
  const prompt = buildFillPrompt(s.prompt, fields, source);
  const raw = await withBackoff(() => generate(key, prompt.user, { system: prompt.system, model, base, json: true, temperature: 0.3 }));
  const { values, problems } = parseFillOutput(raw, fields);
  if (problems.length) throw new Error(problems.join(' '));
  const fresh = targetRow(cur, s.table) ?? row;
  if (!(await createRows(s.table, [{ ...fresh, data: { ...fresh.data, ...values } }], true))) throw new Error('The row could not be saved (browser storage).');
  cur.table = s.table;
  cur.values = { ...cur.values, ...values };
  return { status: 'ok', detail: `${fields.length} column(s) written by Gemini (${model})` };
}

async function httpCall(s: Extract<AutoStep, { kind: 'http' }>, cur: Cur, o: RunCtx): Promise<StepOut> {
  const conn = await db.connections.get(s.connectionId);
  if (!conn || conn.provider !== 'http') throw new Error('The connection of this action no longer exists. Choose it again.');
  const tpl = s.path.trim();
  const path = fillTemplate(tpl.startsWith('/') ? tpl : `/${tpl}`, cur.values, 'url');
  let raw: string | undefined;
  if (s.method !== 'GET' && s.body.trim()) {
    const asJson = fillTemplate(s.body, cur.values, 'json');
    try { JSON.parse(asJson); raw = asJson; } catch { raw = fillTemplate(s.body, cur.values, 'text'); }
  }
  if (o.dry) return { status: 'dry', detail: `Would send ${s.method} ${path}${raw !== undefined ? ' with a body' : ''} to “${conn.name}”.` };
  const r = await httpRequest(conn, s.method, path, undefined, raw);
  if (!r.ok) throw new Error(`${r.status ? `HTTP ${r.status}: ` : ''}${r.error || r.text.slice(0, 160) || 'no answer'}`);
  const detail = `${s.method} ${path} → HTTP ${r.status}`;
  if (s.resultField && s.table) {
    const row = targetRow(cur, s.table);
    if (!row) return { status: 'ok', detail: `${detail}. The item is not in the table, so the answer was not stored.` };
    try { await setCell(s.table, row.id, s.resultField, r.text.slice(0, 4000)); } catch (e) { return { status: 'ok', detail: `${detail}. The answer could not be stored: ${e instanceof Error ? e.message : String(e)}` }; }
  }
  return { status: 'ok', detail };
}

async function addRow(s: Extract<AutoStep, { kind: 'add_row' }>, cur: Cur, o: RunCtx): Promise<StepOut> {
  needTable(s.table);
  const values: Record<string, string> = {};
  for (const [col, tpl] of Object.entries(s.mapping)) {
    const key = col.trim();
    if (key) values[key] = render(tpl, cur);
  }
  if (o.dry) return { status: 'dry', detail: `Would add or update a row in ${tableName(s.table)} with ${Object.keys(values).length} column(s).` };
  const id = rowIdFor(cur, s.table);
  await ensureColumns(s.table, Object.entries(values).map(([key, sample]) => ({ key, sample })));
  // a value is typed as the column it goes into: a choice must be one of the choices, a number a number, and so on
  const known = fieldsOf(s.table);
  const typed: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(values)) {
    const f = known.find((x) => x.key === key);
    if (!f) { typed[key] = raw; continue; }
    const c = coerce(raw, f);
    if (c.error) throw new Error(`“${raw}” is not a valid value for “${f.label}”: ${c.error}`);
    typed[key] = c.value;
  }
  const existing = recordsOf(s.table).find((r) => r.id === id);
  const title = String(typed.name || typed.title || cur.title);
  const data = { ...(existing?.data ?? {}), ...typed };
  const rec = existing ? { ...existing, title, data } : newRow(s.table, { id, title, data });
  if (!(await createRows(s.table, [rec], true))) throw new Error('The row could not be saved (browser storage).');
  cur.table = s.table;
  cur.values = { ...cur.values, ...typed };
  return { status: 'ok', detail: `Row saved in “${tableName(s.table)}” (${Object.keys(values).length} column(s))` };
}

/** The records a step acts on: the record that started the automation, or every record where the field has the value. */
function rowsFor(match: { field: string; value: string } | undefined, table: string, cur: Cur): ContentRecord[] {
  if (!match) {
    const row = targetRow(cur, table);
    return row ? [row] : [];
  }
  const f = fieldsOf(table).find((x) => x.key === match.field);
  if (!f) throw new Error(`The field “${match.field}” does not exist in ${tableName(table)}.`);
  const want = render(match.value, cur).trim().toLowerCase();
  if (!want) throw new Error('The value that finds the record is empty. Give the value to look for.');
  return recordsOf(table).filter((r) => displayValue(getValue(r, f.key)).trim().toLowerCase() === want);
}

/** Writes several values into one row, with the rules the table uses (type check, read-only and sync fields refused). One change. */
async function setCells(table: string, id: string, changes: { key: string; raw: string }[]): Promise<void> {
  const rec = recordsOf(table).find((r) => r.id === id);
  if (!rec) throw new Error('The row is not in the table.');
  const patch: Partial<ContentRecord> = {};
  const data: Record<string, unknown> = { ...rec.data };
  for (const { key, raw } of changes) {
    const f = fieldsOf(table).find((x) => x.key === key);
    if (!f) throw new Error(`The field “${key}” does not exist in ${tableName(table)}.`);
    if (f.readonly || f.sync) throw new Error(`“${f.label}” cannot be changed by an automation.`);
    const c = coerce(raw, f);
    if (c.error) throw new Error(`“${raw}” is not a valid value for “${f.label}”: ${c.error}`);
    if (f.builtin) (patch as Record<string, unknown>)[key] = c.value;
    else data[key] = c.value;
  }
  await updateRow(table, id, { ...patch, data });
}

const POST_ID_KEY = 'buffer_post_id';
/** The field that receives a Buffer post id: the one chosen, or “Buffer post id” made the first time the choice is “create”. */
async function resultFieldKey(field: string, table: string): Promise<string> {
  if (field !== '__create__') return field;
  if (!fieldsOf(table).some((f) => f.key === POST_ID_KEY)) {
    await saveFieldIn(table, { id: uid(), key: POST_ID_KEY, label: 'Buffer post id', type: 'text', order: Math.max(0, ...fieldsOf(table).map((f) => f.order)) + 1 });
  }
  return POST_ID_KEY;
}

/** The https addresses in a field's value (one, or several separated by commas or new lines). */
const linksIn = (value: unknown): string[] => String(value ?? '').split(/[\s,;]+/).filter((x) => /^https?:\/\//i.test(x));

/** The file a link points at in a connected bucket (see r2FileOf). */
type FileHit = NonNullable<Awaited<ReturnType<typeof r2FileOf>>>;

/**
 * Delete a record. With a file field, every link in that field is read first: a comma, a semicolon, a space or a new line
 * separates them. When one link is not a file of a connected bucket, nothing is deleted, the records keep all their links, and
 * the message names every such link. Otherwise each file is deleted on its own, its link is removed from every record that
 * holds it, and then the record is deleted.
 */
async function deleteRecordStep(s: Extract<AutoStep, { kind: 'delete_record' }>, cur: Cur, o: RunCtx): Promise<StepOut> {
  needTable(s.table);
  const rows = rowsFor(s.match, s.table, cur);
  if (!rows.length) throw new Error(s.match ? 'No record matches the condition of this action.' : 'This item is not in the table, so there is no record to delete. Choose “The record where…” instead.');
  if (o.dry) return { status: 'dry', detail: `Would delete ${rows.length} record(s) in ${tableName(s.table)}${s.fileField ? ' and their files in Cloudflare R2' : ''}.` };
  const plan: { row: ContentRecord; hits: { url: string; hit: FileHit }[] }[] = [];
  const outside: string[] = [];
  for (const row of rows) {
    const hits: { url: string; hit: FileHit }[] = [];
    if (s.fileField) {
      for (const url of linksIn(getValue(row, s.fileField))) {
        const hit = await r2FileOf(url);
        if (hit) hits.push({ url, hit }); else outside.push(url);
      }
    }
    plan.push({ row, hits });
  }
  if (outside.length) {
    throw new Error(`${outside.length === 1 ? 'This link is' : `${outside.length} of these links are`} not a file of a connected Cloudflare R2 bucket, so nothing was deleted and the records are kept: ${outside.map((u) => `“${u}”`).join(', ')}.`);
  }
  let files = 0;
  let unlinked = 0;
  for (const { row, hits } of plan) {
    for (const { url, hit } of hits) {
      const r = await r2Delete(hit.conn, hit.key);
      if (!r.ok) throw new Error(`The file ${hit.key} could not be deleted from R2 (${String(r.error ?? 'unknown reason')}). The record is kept with the links that are left; the files before it were deleted.`);
      files++;
      unlinked += await unlinkEverywhere(url);
    }
    await deleteRows(s.table, [row.id]);
  }
  return { status: 'ok', detail: `${rows.length} record(s) deleted${files ? `, with ${files} file(s) from Cloudflare R2, one by one` : ''}${unlinked ? `, and ${unlinked} link(s) to them removed from other records` : ''}` };
}

async function setField(s: Extract<AutoStep, { kind: 'set_field' }>, cur: Cur, o: RunCtx): Promise<StepOut> {
  needTable(s.table);
  const changes = [{ key: s.field, raw: s.value }, ...(s.also ?? []).map((c) => ({ key: c.field, raw: c.value }))].filter((c) => c.key);
  if (!changes.length) throw new Error('Choose the field to update.');
  const rows = rowsFor(s.match, s.table, cur);
  if (!rows.length) throw new Error(s.match ? 'No record matches the condition of this action.' : 'This item is not in the table, so there is no record to update. Choose “The record where…” instead.');
  const values = changes.map((c) => ({ key: c.key, raw: render(c.raw, cur) }));
  const summary = values.map((v) => `${v.key} = ${v.raw || '(empty)'}`).join(', ');
  if (o.dry) return { status: 'dry', detail: `Would update ${rows.length} record(s) in ${tableName(s.table)}: ${summary}.` };
  for (const row of rows) await setCells(s.table, row.id, values);
  return { status: 'ok', detail: `${rows.length} record(s) updated in ${tableName(s.table)}: ${summary}` };
}

async function syncPostsStep(s: Extract<AutoStep, { kind: 'sync_posts' }>, o: RunCtx): Promise<StepOut> {
  needTable(s.table);
  const posts = await db.posts.orderBy('created_at').toArray();
  if (o.dry) return { status: 'dry', detail: `Would sync ${posts.length} post(s) to ${tableName(s.table)}.` };
  const { syncPostsToTable } = await import('../pipeline/sync');
  await syncPostsToTable(s.table, posts);
  return { status: 'ok', detail: `${posts.length} post(s) synced to “${tableName(s.table)}”` };
}

async function renderFile(s: Extract<AutoStep, { kind: 'render' }>, cur: Cur, o: RunCtx): Promise<StepOut> {
  const tpl = await db.templates.get(s.templateId);
  if (!tpl) throw new Error('The template of this action no longer exists. Choose it again.');
  needTable(s.table);
  const row = targetRow(cur, s.table);
  if (!row) throw new Error('This item is not in the table, so there is nothing to render.');
  const { DEFAULT_DEST, destinationName, prepareDestination } = await import('../batch/destination');
  const dest = s.dest ?? DEFAULT_DEST;
  const uploads = dest.kind !== 'zip';
  if (o.dry) return { status: 'dry', detail: `Would render “${tpl.name}” as ${s.format}${uploads ? ` and upload it to ${destinationName(dest)}` : ''}.` };
  // the destination is checked before anything is rendered, as in the Batch Runner: a missing account or folder stops here
  const prepared = uploads ? await prepareDestination(dest, s.table) : { destination: undefined, error: undefined };
  if (prepared.error) throw new Error(prepared.error);
  const { BatchRun, defaultConcurrency } = await import('../batch/runner');
  const { download } = await import('../ui/kit');
  const config: BatchConfig = {
    templateId: tpl.id, selection: 'individual', filter: { join: 'and', conditions: [] }, format: s.format,
    pdfMode: 'separate', outW: tpl.width, outH: tpl.height, quality: 0.92, transparent: false, filenamePattern: '{{content.slug}}',
    includeManifest: true, concurrency: defaultConcurrency(),
  };
  const run = new BatchRun({ config, doc: tpl.doc, templateName: tpl.name, records: [row], table: s.table, selectionLabel: `Automation item ${cur.key}`, destination: prepared.destination, keepZip: dest.keepZip });
  void run.start();
  await run.done;
  const st = run.store.get();
  if (st.status !== 'completed' && st.status !== 'completed_with_errors') throw new Error(st.error ?? `The render ended as “${st.status}”.`);
  if (st.ok === 0) throw new Error(st.failures[0]?.error ?? 'The item could not be rendered.');
  // without an upload the ZIP is the result, so it is downloaded; with an upload it is downloaded only when it is kept
  const keptZip = !prepared.destination || dest.keepZip;
  if (st.output && keptZip) download(st.output.blob, st.output.name);
  const sent = prepared.destination ? ` and uploaded to ${destinationName(dest)}` : '';
  return { status: 'ok', detail: `${st.ok} file(s) rendered${sent}${st.output && keptZip ? ' and downloaded' : ''}` };
}

/**
 * Sets a date & time field to a random slot in the window. A row that already has a value keeps it (when onlyIfEmpty).
 * The same time is never given to two rows of the table.
 */
async function randomTime(s: Extract<AutoStep, { kind: 'random_time' }>, cur: Cur, o: RunCtx): Promise<StepOut> {
  needTable(s.table);
  const row = targetRow(cur, s.table);
  if (!row) throw new Error('This item is not in the table yet. Put an “Add or update a row” action before this one.');
  const current = String(getValue(row, s.field) ?? '').trim();
  if (s.onlyIfEmpty && current) return { status: 'skipped', detail: `${s.field} already has a value (${current}), so it is kept.` };
  const taken = new Set(recordsOf(s.table).map((r) => String(getValue(r, s.field) ?? '').trim()).filter(Boolean));
  const value = randomSlot(s, Math.random, taken);
  if (!value) throw new Error('No free time is left in that window. Widen the dates or the hours.');
  if (o.dry) return { status: 'dry', detail: `Would set ${s.field} to ${value}.` };
  await setCell(s.table, row.id, s.field, value);
  return { status: 'ok', detail: `${s.field} set to ${value}` };
}

/**
 * The item as an action's condition sees it at this moment: the record as it is now (an earlier action may have changed it).
 * A website item has no record, so its values stand for its fields.
 */
export function itemNow(cur: Cur): ContentRecord {
  if (cur.home && !cur.event) {
    const live = recordsOf(cur.home).find((r) => r.id === cur.key);
    if (live) return live;
  }
  // the table name only tells getValue to read the values as data (a website item has no table of its own)
  return { id: cur.key, table: cur.home || 'item', data: cur.values } as unknown as ContentRecord;
}

/** Whether the action runs for this item: its own condition holds (no condition: always). The same rules as a trigger's conditions. */
export function actionRuns(filter: AutoFilter | undefined, cur: Cur): boolean {
  return !filter || matchGroup(itemNow(cur), filter as FilterGroup);
}

/** Runs one step for the current item. Throws on failure; StopItem when the item must not be retried. */
export async function runStep(s: AutoStep, cur: Cur, o: RunCtx): Promise<StepOut> {
  const problems = stepProblems(s);
  if (problems.length) throw new Error(problems[0]);
  switch (s.kind) {
    case 'buffer_post': return bufferPost(s, cur, o);
    case 'pipeline_post': return pipelinePost(cur, o);
    case 'gemini_fill': return geminiFill(s, cur, o);
    case 'http': return httpCall(s, cur, o);
    case 'add_row': return addRow(s, cur, o);
    case 'set_field': return setField(s, cur, o);
    case 'delete_record': return deleteRecordStep(s, cur, o);
    case 'sync_posts': return syncPostsStep(s, o);
    case 'render': return renderFile(s, cur, o);
    case 'random_time': return randomTime(s, cur, o);
  }
}
