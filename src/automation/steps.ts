import { readGeminiKeyOf } from '../db/connections';
import { coerce, getValue } from '../db/fields';
import { randomSlot } from './triggers';
import { decryptSecret } from '../db/vault';
import { db, getSetting, type AutoStep, type BatchConfig, type ContentRecord, type FieldType, type TimingConfig } from '../db/schema';
import { allTables, createRows, fieldsOf, newRow, recordsOf, saveFieldIn, tableName, updateRow } from '../db/tables';
import { uid } from '../engine/njs';
import { renderTemplateString } from '../engine/binding';
import { buildFillPrompt, parseFillOutput, parsePlaceholders, sourceTextOf } from '../connector/fill';
import { asText, COLUMN_KEY, columnLabel, guessType } from '../connector/paths';
import type { ConnectorEvent } from '../connector/events';
import { httpRequest } from '../connector/http';
import { generate, withBackoff } from '../pipeline/gemini';
import { createPost, DEFAULT_RELAY } from './buffer';
import { channelLabelOf, fillTemplate, sourceOfValues, stepProblems } from './model';

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

async function bufferPost(s: Extract<AutoStep, { kind: 'buffer_post' }>, cur: Cur, o: RunCtx): Promise<StepOut> {
  if (cur.alreadyPosted) return { status: 'skipped', detail: 'A post for this item was already made, so it is not made again.' };
  const text = render(s.text, cur).trim();
  if (!text) throw new Error('The post text is empty for this item.');
  const notes: string[] = [];
  let imageUrl: string | undefined;
  if (s.imageField) {
    const v = asText(cur.values[s.imageField]).trim();
    if (/^https:\/\//i.test(v)) imageUrl = v;
    else if (v) notes.push('The image is not a public https:// address, so the post goes without it.');
  }
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
  if (o.dry) return { status: 'dry', detail: `Would post to ${channel} ${when}: “${preview(text)}”${imageUrl ? ' + image' : ''}` };
  const relay = await getSetting<string>('relay.url', DEFAULT_RELAY);
  const res = await createPost(relay, creds.apiKey, { text, channelId: creds.channelId, imageUrl, mode: timing.mode === 'scheduled' ? 'scheduled' : 'queue', dueAt: timing.mode === 'scheduled' ? timing.dueAt : undefined });
  if (!res.ok) throw new Error(res.error ?? 'Buffer did not accept the post.');
  cur.posted = true;
  // the post exists now: a problem storing its id must not fail the step, or a retry would post it again
  if (s.resultField && cur.home && res.postId) {
    try { await setCell(cur.home, cur.base, s.resultField, res.postId); } catch (e) { notes.push(`The post id could not be stored: ${e instanceof Error ? e.message : String(e)}`); }
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
  const existing = recordsOf(s.table).find((r) => r.id === id);
  const title = values.name || values.title || cur.title;
  const data = { ...(existing?.data ?? {}), ...values };
  const rec = existing ? { ...existing, title, data } : newRow(s.table, { id, title, data });
  if (!(await createRows(s.table, [rec], true))) throw new Error('The row could not be saved (browser storage).');
  cur.table = s.table;
  cur.values = { ...cur.values, ...values };
  return { status: 'ok', detail: `Row saved in “${tableName(s.table)}” (${Object.keys(values).length} column(s))` };
}

async function setField(s: Extract<AutoStep, { kind: 'set_field' }>, cur: Cur, o: RunCtx): Promise<StepOut> {
  needTable(s.table);
  const row = targetRow(cur, s.table);
  if (!row) throw new Error('This item is not in the table yet. Put an “Add or update a row” action before this one.');
  const value = render(s.value, cur);
  if (o.dry) return { status: 'dry', detail: `Would set ${s.field} = ${value || '(empty)'} in ${tableName(s.table)}.` };
  await setCell(s.table, row.id, s.field, value);
  return { status: 'ok', detail: `${s.field} = ${value || '(empty)'}` };
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
  if (o.dry) return { status: 'dry', detail: `Would render “${tpl.name}” as ${s.format}.` };
  const { BatchRun, defaultConcurrency } = await import('../batch/runner');
  const { download } = await import('../ui/kit');
  const config: BatchConfig = {
    templateId: tpl.id, database: 'content_plan', selection: 'individual', filter: { join: 'and', conditions: [] }, format: s.format,
    pdfMode: 'separate', outW: tpl.width, outH: tpl.height, quality: 0.92, transparent: false, filenamePattern: '{{content.slug}}',
    includeManifest: true, concurrency: defaultConcurrency(),
  };
  const run = new BatchRun({ config, doc: tpl.doc, templateName: tpl.name, records: [row], selectionLabel: `Automation item ${cur.key}` });
  void run.start();
  await run.done;
  const st = run.store.get();
  if (st.status !== 'completed' && st.status !== 'completed_with_errors') throw new Error(st.error ?? `The render ended as “${st.status}”.`);
  if (st.ok === 0) throw new Error(st.failures[0]?.error ?? 'The item could not be rendered.');
  if (st.output) download(st.output.blob, st.output.name);
  return { status: 'ok', detail: `${st.ok} file(s) rendered${st.output ? ' and downloaded' : ''}` };
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
    case 'sync_posts': return syncPostsStep(s, o);
    case 'render': return renderFile(s, cur, o);
    case 'random_time': return randomTime(s, cur, o);
  }
}
