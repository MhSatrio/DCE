import type {
  AutoFormat, AutoMethod, AutoStep, AutoTrigger, AutomationRow, AutoRunRow, ConnectionRow, LegacyAutomationRow,
  TimingConfig, WorkflowRow, WorkflowRunRow, WorkflowStep, WorkflowTrigger,
} from '../db/schema';
import { EVENT_TYPE_TEXT } from '../connector/events';
import { parsePlaceholders } from '../connector/fill';
import { asText } from '../connector/paths';
import { dateKey, isWebsite, triggerChoices, triggerSummary, websiteScopes, type TriggerChoice } from './triggers';
export { isWebsite, triggerChoices, triggerSummary, websiteScopes, type TriggerChoice } from './triggers';

/**
 * The pure model of automations: what a trigger and a step are, which steps a connection allows, the presets, the
 * text rules and the conversion of the earlier shapes. Nothing here touches the database, the network or the screen.
 */

export const CONTENT = 'content';
export const EVENTS: WorkflowTrigger[] = ['article.published', 'product.published', 'product.reviewed'];
export const FORMATS: AutoFormat[] = ['png', 'jpeg', 'svg', 'pdf', 'html'];
export const METHODS: AutoMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

export const STEP_LABEL: Record<AutoStep['kind'], string> = {
  buffer_post: 'Create a post',
  pipeline_post: 'Write and check a post',
  gemini_fill: 'Ask Gemini and fill columns',
  http: 'Send a request',
  add_row: 'Add or update a row',
  set_field: 'Set a field',
  sync_posts: 'Sync posts to a table',
  render: 'Render with the batch runner',
  random_time: 'Set a random date and time',
};

export const DEFAULT_TIMING: TimingConfig = { mode: 'queue', delayAmount: 30, delayUnit: 'minutes', pastPolicy: 'skip' };

/** A new step with sensible defaults for its kind. */
export function newStep(kind: AutoStep['kind'], o: { connectionId?: string; table?: string; channel?: string; templateId?: string } = {}): AutoStep {
  switch (kind) {
    case 'buffer_post': return { kind, connectionId: o.connectionId ?? '', channel: o.channel ?? '', text: '{{title}}\n\n{{description}}', timing: { ...DEFAULT_TIMING } };
    case 'pipeline_post': return { kind };
    case 'gemini_fill': return { kind, connectionId: o.connectionId ?? '', table: o.table ?? '', prompt: 'Write {{summary|two short sentences in plain English}}.' };
    case 'http': return { kind, connectionId: o.connectionId ?? '', method: 'POST', path: '/', body: '' };
    case 'add_row': return { kind, table: o.table ?? '', mapping: { name: '{{title}}' } };
    case 'set_field': return { kind, table: o.table ?? '', field: '', value: '' };
    case 'sync_posts': return { kind, table: o.table ?? '' };
    case 'render': return { kind, table: o.table ?? '', templateId: o.templateId ?? '', format: 'png' };
    case 'random_time': {
      const today = new Date();
      const later = new Date(today.getTime() + 14 * 86_400_000);
      return { kind, table: o.table ?? '', field: '', from: dateKey(today), to: dateKey(later), fromTime: '09:00', toTime: '18:00', weekdays: false, onlyIfEmpty: true };
    }
  }
}

// ------------------------------------------------------------------------------------------------ text rules

/** Template values: text for every key; a dot path ("author.name") is a key too. Lists are joined, objects are JSON. */
export function flattenPayload(obj: Record<string, unknown>, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix + k;
    if (v && typeof v === 'object' && !Array.isArray(v)) Object.assign(out, flattenPayload(v as Record<string, unknown>, `${key}.`));
    else out[key] = asText(v);
  }
  return out;
}

/**
 * Replaces {{key}} with the value of the key ('' when unknown). The value is escaped for where it lands:
 * "url" for a path (so a space or a slash cannot change the address), "json" for a string inside a JSON body,
 * "text" as it is.
 */
export function fillTemplate(tpl: string, values: Record<string, unknown>, mode: 'text' | 'url' | 'json' = 'text'): string {
  return tpl.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}\}/g, (_m, key: string) => {
    const v = asText(values[key]);
    if (mode === 'url') return encodeURIComponent(v);
    if (mode === 'json') return JSON.stringify(v).slice(1, -1);
    return v;
  });
}

/** The text Gemini may read from a record: every filled-in value except links, images and ids. */
export function sourceOfValues(values: Record<string, unknown>): { title: string; url: string; text: string } {
  const skip = new Set(['id', 'url', 'image', 'imageUrl', 'slug', 'title', 'name']);
  const title = asText(values.title ?? values.name);
  const url = asText(values.url);
  const lines: string[] = [];
  for (const [k, v] of Object.entries(values)) {
    if (skip.has(k)) continue;
    const s = asText(v).trim();
    if (s) lines.push(`${k}: ${s}`);
  }
  return { title, url, text: lines.join('\n') };
}

// ------------------------------------------------------------------------------------------------ connections

export const channelCount = (c: ConnectionRow) => c.props.filter((p) => /^BUFFER_CHANNEL_ID/i.test(p.key)).length;

export interface Names {
  connection(id: string): string;
  table(id: string): string;
  template(id: string): string;
  channel(key: string): string;
}

/** Labels for the screen and the history: "Buffer · Vier", "Website articles", "LinkedIn · Vier Apparatus". */
export const channelLabelOf = (key: string) => key.replace(/^BUFFER_CHANNEL_ID_?/i, '').replace(/_/g, ' ').trim() || 'default';

// ------------------------------------------------------------------------------------------------ what a connection allows

export interface Choice<T> { value: T; label: string; group: string; enabled: boolean; reason?: string }

/**
 * The actions the "Then" menu offers. A connection contributes only its own actions; the built-in actions (this app's
 * tables and the Content pipeline) are always there. Disabled entries say why (for example: no channel yet).
 */
export function stepChoices(conns: ConnectionRow[], names: (c: ConnectionRow) => string = (c) => c.name): Choice<{ kind: AutoStep['kind']; connectionId: string }>[] {
  const out: Choice<{ kind: AutoStep['kind']; connectionId: string }>[] = [];
  const buffers = conns.filter((c) => c.provider === 'buffer');
  const geminis = conns.filter((c) => c.provider === 'gemini');
  for (const c of buffers) {
    const n = channelCount(c);
    out.push({ value: { kind: 'buffer_post', connectionId: c.id }, label: 'Create a post', group: `Buffer · ${names(c)}`, enabled: n > 0, reason: n > 0 ? undefined : 'No channel yet: press Test connection on this account.' });
  }
  for (const c of geminis) out.push({ value: { kind: 'gemini_fill', connectionId: c.id }, label: 'Ask Gemini and fill columns', group: `Gemini · ${names(c)}`, enabled: true });
  for (const c of conns.filter((x) => x.provider === 'http' && !isWebsite(x))) out.push({ value: { kind: 'http', connectionId: c.id }, label: 'Send a request', group: `API · ${names(c)}`, enabled: true });
  const pipeline = buffers.length > 0 && geminis.length > 0;
  out.push({ value: { kind: 'pipeline_post', connectionId: '' }, label: 'Write and check a post', group: 'Content pipeline', enabled: pipeline, reason: pipeline ? undefined : 'Needs a Buffer account and a Gemini key (Settings → Connections).' });
  for (const kind of ['add_row', 'set_field', 'random_time', 'sync_posts', 'render'] as const) out.push({ value: { kind, connectionId: '' }, label: STEP_LABEL[kind], group: 'This app · tables', enabled: true });
  return out;
}

function timingText(t: TimingConfig): string {
  if (t.mode === 'queue') return 'in the next free slot';
  if (t.mode === 'delay') return `after ${t.delayAmount} ${t.delayUnit}`;
  return 'at the time in a field';
}

export function stepSummary(s: AutoStep, n: Names): string {
  switch (s.kind) {
    case 'buffer_post': return `Post to ${n.channel(s.channel) || 'no channel yet'} ${timingText(s.timing)}`;
    case 'pipeline_post': return 'Write a social post with the Content pipeline settings, check it, and send it';
    case 'gemini_fill': {
      const keys = parsePlaceholders(s.prompt).map((p) => p.key);
      return `Ask Gemini for ${keys.length ? keys.join(', ') : 'nothing yet'} → ${n.table(s.table)}`;
    }
    case 'http': return `${s.method} ${s.path || '/'}`;
    case 'add_row': return `Add or update a row in ${n.table(s.table)}`;
    case 'set_field': return `Set ${s.field || 'a field'} = ${s.value || '(empty)'} in ${n.table(s.table)}`;
    case 'sync_posts': return `Sync posts to ${n.table(s.table)}`;
    case 'render': return `Render ${n.template(s.templateId)} as ${s.format} from ${n.table(s.table)}`;
    case 'random_time': return `Set ${s.field || 'a field'} to a random time from ${s.from} to ${s.to}, ${s.fromTime}–${s.toTime}${s.weekdays ? ', weekdays only' : ''}${s.onlyIfEmpty ? ', only if empty' : ''}`;
  }
}

/** What is still missing in a step (empty list = ready). Shown on the step and checked before it runs. */
export function stepProblems(s: AutoStep): string[] {
  const p: string[] = [];
  switch (s.kind) {
    case 'buffer_post': if (!s.connectionId) p.push('Choose the Buffer account.'); if (!s.channel) p.push('Choose a channel.'); if (!s.text.trim()) p.push('Write the post text.'); break;
    case 'gemini_fill': if (!s.connectionId) p.push('Choose the Gemini key.'); if (!s.table) p.push('Choose the table to fill.'); if (!parsePlaceholders(s.prompt).length) p.push('The prompt needs at least one {{column|what to write}}.'); break;
    case 'http': if (!s.connectionId) p.push('Choose the connection.'); if (!s.path.trim()) p.push('Write the path, for example /api/items.'); break;
    case 'add_row': if (!s.table) p.push('Choose the table.'); break;
    case 'set_field': if (!s.table) p.push('Choose the table.'); if (!s.field) p.push('Choose the field to set.'); break;
    case 'sync_posts': if (!s.table) p.push('Choose the table.'); break;
    case 'render': if (!s.table) p.push('Choose the table.'); if (!s.templateId) p.push('Choose a template.'); break;
    case 'random_time': {
      if (!s.table) p.push('Choose the table.');
      if (!s.field) p.push('Choose the date & time field to fill.');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s.from) || !/^\d{4}-\d{2}-\d{2}$/.test(s.to) || s.from > s.to) p.push('The window needs a first and a last date, the first not after the last.');
      if (!(s.fromTime < s.toTime)) p.push('The earliest time must be before the latest time.');
      break;
    }
    case 'pipeline_post': break;
  }
  return p;
}

export function automationProblems(a: Pick<AutomationRow, 'trigger' | 'steps'>): string[] {
  const out: string[] = [];
  if (a.trigger.kind === 'event' && !a.trigger.connectionId) out.push('Choose the website.');
  if (a.steps.length === 0) out.push('Add at least one action.');
  a.steps.forEach((s, i) => { for (const p of stepProblems(s)) out.push(`Action ${i + 1}: ${p}`); });
  return out;
}

// ------------------------------------------------------------------------------------------------ presets

export const ARTICLE_MAP: Record<string, string> = { name: '{{title}}', url: '{{url}}', excerpt: '{{excerpt}}', body: '{{body}}', category: '{{category}}', image: '{{image}}', published: '{{publishedAt}}' };
export const PRODUCT_MAP: Record<string, string> = { name: '{{name}}', url: '{{url}}', manufacturer: '{{manufacturer}}', category: '{{category}}', image: '{{imageUrl}}', description: '{{shortDescription}}', advantages: '{{advantages}}', limitations: '{{limitations}}' };
export const ARTICLE_PROMPT = 'Write a summary of this article for a social post: {{summary|two short sentences in plain English}}\nWrite a hook: {{hook|one short line, no emojis}}';
export const PRODUCT_REVIEW_PROMPT = 'Write a short verdict for this product: {{verdict|two sentences: who it is for, and its main limitation, from the editorial review}}';
export const PRODUCT_HOOK_PROMPT = 'Write a short hook for a social post about this product: {{hook|one line, no emojis}}';

export type PresetId = 'article' | 'product-reviewed' | 'product-published' | 'ready-to-post' | 'post-approved' | 'blank';
export const PRESET_LABEL: Record<PresetId, string> = {
  article: 'Website article published → post, table, Gemini text, render',
  'product-reviewed': 'Website product reviewed → table, Gemini verdict, render',
  'product-published': 'Website product published → post, table, Gemini hook',
  'ready-to-post': 'Record Status is “Ready to post” → Buffer post 30 min later, then Status = Posted',
  'post-approved': 'Approval changed to “Approved” in the synced posts table → random publish time if empty → Buffer post at that time',
  blank: 'Blank automation',
};

/**
 * Which connections a preset needs. A missing one leaves that step to be chosen by hand (the automation stays off).
 * `postsTable` is the synced posts table; the window is where a random publish time is picked (YYYY-MM-DD).
 */
export interface PresetIds {
  websiteId: string; bufferId: string; geminiId: string; articlesTable: string; productsTable: string; templateId: string; channel: string;
  postsTable?: string; windowFrom?: string; windowTo?: string;
}

export function presetAutomation(id: PresetId, p: PresetIds): Omit<AutomationRow, 'id' | 'created_at' | 'updated_at' | 'fired'> {
  const tableOf = (k: 'articles' | 'products') => (k === 'articles' ? p.articlesTable : p.productsTable);
  const render = (table: string): AutoStep[] => (p.templateId ? [{ kind: 'render', table, templateId: p.templateId, format: 'png' }] : []);
  switch (id) {
    case 'article': return {
      name: PRESET_LABEL.article.split(' → ')[0], enabled: false,
      trigger: { kind: 'event', connectionId: p.websiteId, event: 'article.published' },
      steps: [
        { kind: 'pipeline_post' },
        { kind: 'add_row', table: tableOf('articles'), mapping: ARTICLE_MAP },
        { kind: 'gemini_fill', connectionId: p.geminiId, table: tableOf('articles'), prompt: ARTICLE_PROMPT },
        { kind: 'sync_posts', table: tableOf('articles') },
        ...render(tableOf('articles')),
      ],
    };
    case 'product-reviewed': return {
      name: PRESET_LABEL['product-reviewed'].split(' → ')[0], enabled: false,
      trigger: { kind: 'event', connectionId: p.websiteId, event: 'product.reviewed' },
      steps: [
        { kind: 'add_row', table: tableOf('products'), mapping: PRODUCT_MAP },
        { kind: 'gemini_fill', connectionId: p.geminiId, table: tableOf('products'), prompt: PRODUCT_REVIEW_PROMPT },
        { kind: 'sync_posts', table: tableOf('products') },
        ...render(tableOf('products')),
      ],
    };
    case 'product-published': return {
      name: PRESET_LABEL['product-published'].split(' → ')[0], enabled: false,
      trigger: { kind: 'event', connectionId: p.websiteId, event: 'product.published' },
      steps: [
        { kind: 'pipeline_post' },
        { kind: 'add_row', table: tableOf('products'), mapping: PRODUCT_MAP },
        { kind: 'gemini_fill', connectionId: p.geminiId, table: tableOf('products'), prompt: PRODUCT_HOOK_PROMPT },
        { kind: 'sync_posts', table: tableOf('products') },
        ...render(tableOf('products')),
      ],
    };
    case 'ready-to-post': return {
      name: 'Post when ready', enabled: false,
      trigger: { kind: 'record', table: CONTENT, filter: { join: 'and', conditions: [{ id: 'c1', field: 'status', op: 'eq', value: 'Ready to post' }] } },
      steps: [
        { kind: 'buffer_post', connectionId: p.bufferId, channel: p.channel, text: '{{title}} — {{description}}', timing: { mode: 'delay', delayAmount: 30, delayUnit: 'minutes', pastPolicy: 'skip' } },
        { kind: 'set_field', table: CONTENT, field: 'status', value: 'Posted' },
      ],
    };
    case 'post-approved': {
      const table = p.postsTable || CONTENT;
      return {
        name: 'Post approved rows to Buffer', enabled: false,
        trigger: { kind: 'record', table, filter: { join: 'and', conditions: [{ id: 'ap1', field: 'approval', op: 'eq', value: 'Approved' }] }, on: { kind: 'changed', field: 'approval' } },
        steps: [
          { kind: 'random_time', table, field: 'publish_at', from: p.windowFrom ?? '', to: p.windowTo ?? '', fromTime: '09:00', toTime: '18:00', weekdays: false, onlyIfEmpty: true },
          { kind: 'buffer_post', connectionId: p.bufferId, channel: p.channel, text: '{{post_text}}', timing: { mode: 'field', delayAmount: 0, delayUnit: 'minutes', timeField: 'publish_at', pastPolicy: 'skip' }, resultField: 'post_id' },
          { kind: 'set_field', table, field: 'schedule_state', value: 'Scheduled in Buffer' },
        ],
      };
    }
    case 'blank': return {
      name: 'New automation', enabled: false,
      trigger: { kind: 'record', table: CONTENT, filter: { join: 'and', conditions: [] } },
      steps: [],
    };
  }
}

// ------------------------------------------------------------------------------------------------ earlier shapes → new shape

/** A table rule that posted to Buffer → an automation with a record trigger, one Buffer step and an optional field change. */
export function ruleToAutomation(l: LegacyAutomationRow, bufferId: string, now: number): AutomationRow {
  const steps: AutoStep[] = [{
    kind: 'buffer_post', connectionId: l.connectionId || bufferId, channel: l.action.channel, text: l.action.text,
    imageField: l.action.imageField, resultField: l.action.resultField,
    timing: { mode: l.action.mode, delayAmount: l.action.delayAmount, delayUnit: l.action.delayUnit, timeField: l.action.timeField, pastPolicy: l.action.pastPolicy },
  }];
  if (l.action.setField) steps.push({ kind: 'set_field', table: l.table, field: l.action.setField, value: l.action.setValue ?? '' });
  return { id: l.id, name: l.name, enabled: l.enabled, created_at: l.created_at, updated_at: now, trigger: { kind: 'record', table: l.table, filter: l.filter }, steps, fired: l.fired };
}

const WORKFLOW_STEP = (s: WorkflowStep, geminiId: string): AutoStep => {
  switch (s.kind) {
    case 'text_post': return { kind: 'pipeline_post' };
    // the old workflows named a column and the event path it took its value from: "{{path}}" is the same value
    case 'add_row': return { kind: 'add_row', table: s.tableId, mapping: Object.fromEntries(Object.entries(s.mapping).map(([col, path]) => [col, `{{${path.trim()}}}`])) };
    case 'ai_fill': return { kind: 'gemini_fill', connectionId: geminiId, table: s.tableId, prompt: s.prompt };
    case 'sync_posts': return { kind: 'sync_posts', table: s.tableId };
    case 'batch_render': return { kind: 'render', table: s.tableId, templateId: s.templateId, format: s.format };
  }
};

/** A website workflow → an automation with an event trigger. The steps keep their order and their settings. */
export function workflowToAutomation(w: WorkflowRow, geminiId: string, now: number): AutomationRow {
  return {
    id: w.id, name: w.name, enabled: w.enabled, created_at: w.created_at, updated_at: now,
    trigger: { kind: 'event', connectionId: w.connectionId, event: w.trigger },
    steps: w.steps.map((s) => WORKFLOW_STEP(s, geminiId)),
    fired: {},
  };
}

/** A workflow run → a row of the one history list. */
export function workflowRunToLog(r: WorkflowRunRow): AutoRunRow {
  const status: AutoRunRow['status'] = r.status === 'ok' ? 'sent' : r.status === 'failed' ? 'failed' : 'interrupted';
  return {
    id: r.id, automationId: r.workflowId, automationName: r.workflowName, recordId: r.entityId, recordTitle: r.title, at: r.at, status, detail: r.detail,
    steps: r.steps.map((s) => ({ name: s.name, status: s.status, detail: s.detail })),
  };
}

export const RUN_STATUS_CHIP: Record<AutoRunRow['status'], { cls: string; text: string }> = {
  running: { cls: 'warn', text: 'running' },
  sent: { cls: 'ok', text: 'done' },
  failed: { cls: 'err', text: 'failed' },
  dry: { cls: 'blue', text: 'dry run' },
  skipped: { cls: 'blue', text: 'skipped' },
  interrupted: { cls: 'warn', text: 'interrupted' },
};
