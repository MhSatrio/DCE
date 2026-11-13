import Dexie, { type Table } from 'dexie';
import type { NjsDoc } from '../engine/types';

export type FieldType =
  | 'text' | 'longtext' | 'number' | 'boolean' | 'date' | 'select' | 'multiselect'
  | 'url' | 'image' | 'relation' | 'markdown' | 'json'
  | 'email' | 'phone' | 'currency' | 'percent' | 'rating' | 'datetime'
  | 'link' | 'createdTime' | 'modifiedTime' | 'autonumber';

export interface FieldDef {
  id: string;
  key: string;          // used in bindings: content.<key>
  label: string;
  type: FieldType;
  builtin?: boolean;
  readonly?: boolean;
  options?: string[];   // select / multiselect
  relationTo?: 'templates' | 'assets' | 'records';
  order: number;
  /** Which table the field belongs to; undefined = the Content Plan. */
  tableId?: string;
  /** type 'link': the table whose records this field points to, and the matching field on that side. */
  linkTable?: string;
  inverseKey?: string;
  /**
   * Synced field: a live mirror of `source` (a field of the linked table) reached through the link field `via`.
   * `type` is the source's type, so the grid, filters, exports and template bindings treat it like any other field.
   */
  sync?: { via: string; source: string };
  currency?: string;    // symbol for 'currency', e.g. "$", "Rp"
  ratingMax?: number;   // 'rating'
}

export interface TableDef { id: string; name: string; created_at: number }

/** Non-secret description of a Buffer channel, so the screens can show "LinkedIn · Vier Apparatus" instead of an id. */
export interface ChannelMeta { service: string; name: string; org: string }
export interface ConnectionProp { id: string; key: string; secret: boolean; value?: string; enc?: string; meta?: ChannelMeta }
export interface ConnectionRow {
  id: string;
  provider: 'buffer' | 'gemini' | 'http' | 'custom';
  name: string;
  created_at: number;
  props: ConnectionProp[];
  caps?: ConnCaps;             // what the service allows, read by "Test connection"
  kind?: 'website' | 'api';    // HTTP connections only (plain, not secret)
}

/** What a connection can do, read when it is tested. Secrets are never here. The automation editor offers only these. */
export interface ConnCaps {
  checkedAt: number;
  scopes?: string[];                                                   // a website token's permissions (events:read, jobs:run)
  operations?: { method: string; path: string; summary: string }[];    // an API's published operations (OpenAPI), if any
  note: string;                                                        // one line for the screen
}

export type AutoMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type AutoFormat = 'png' | 'jpeg' | 'svg' | 'pdf' | 'html';

/** When should Buffer publish? queue = next free slot · delay = after N units · field = at a date/time field (table items only). */
export interface TimingConfig {
  mode: 'queue' | 'delay' | 'field';
  delayAmount: number;
  delayUnit: 'minutes' | 'hours' | 'days';
  timeField?: string;
  pastPolicy: 'skip' | 'queue';  // what to do when the chosen time has already passed
}

export interface AutoFilter { join: 'and' | 'or'; conditions: { id: string; field: string; op: string; value: string }[] }

/** When does an automation start? A table record matches its conditions, or the website reports an event. */
/**
 * What a record trigger reacts to: a record starts matching its conditions (default), a record is created, or the value of
 * a field changes (and the record matches the conditions after the change).
 */
export type RecordEvent = { kind: 'matches' } | { kind: 'created' } | { kind: 'changed'; field: string };

/** When a schedule fires: once at a date and time, or every week on the chosen days (0 = Sunday) at a time. */
export type WeeklyWhen = { mode: 'once'; at: string } | { mode: 'weekly'; time: string; days: number[] };

export type AutoTrigger =
  | { kind: 'record'; table: string; filter: AutoFilter; on?: RecordEvent }
  | { kind: 'schedule'; table: string; filter: AutoFilter; when: WeeklyWhen; lastDue?: number }
  | { kind: 'event'; connectionId: string; event: WorkflowTrigger };

/**
 * One "Then" step. A step belongs to a connection (Buffer, Gemini, an API) or to this app's tables; the editor offers only
 * the actions of that connection. Templates use {{field}} for the current item (a record, or a website item).
 */
export type AutoStep =
  | { kind: 'buffer_post'; connectionId: string; channel: string; text: string; imageField?: string; timing: TimingConfig; resultField?: string }
  | { kind: 'pipeline_post' }
  | { kind: 'gemini_fill'; connectionId: string; table: string; prompt: string }
  | { kind: 'http'; connectionId: string; method: AutoMethod; path: string; body: string; table?: string; resultField?: string }
  | { kind: 'add_row'; table: string; mapping: Record<string, string> }
  | { kind: 'set_field'; table: string; field: string; value: string }
  | { kind: 'sync_posts'; table: string }
  | { kind: 'render'; table: string; templateId: string; format: AutoFormat }
  /** Sets `field` of the item to a random date and time inside the window (only if it is empty, when onlyIfEmpty). */
  | { kind: 'random_time'; table: string; field: string; from: string; to: string; fromTime: string; toTime: string; weekdays: boolean; onlyIfEmpty: boolean };

export interface AutomationRow {
  id: string;
  name: string;
  enabled: boolean;
  created_at: number;
  updated_at: number;
  trigger: AutoTrigger;
  steps: AutoStep[];
  /** item key → progress: the next step to run, attempts, done, and whether a Buffer post was made */
  /** sig: the value a "field changes" trigger last saw for this item (a change to another value starts it again) */
  fired: Record<string, { at: number; n: number; last: number; done: boolean; step?: number; posted?: boolean; sig?: string }>;
}

/** The shape before version 5 (a table rule that posts to Buffer). Read only by the one-time migration. */
export interface LegacyAutomationRow {
  id: string;
  name: string;
  table: string;
  enabled: boolean;
  created_at: number;
  filter: AutoFilter;
  connectionId: string;
  action: {
    channel: string; text: string; imageField?: string; mode: 'queue' | 'delay' | 'field'; delayAmount: number;
    delayUnit: 'minutes' | 'hours' | 'days'; timeField?: string; pastPolicy: 'skip' | 'queue';
    setField?: string; setValue?: string; resultField?: string;
  };
  fired: Record<string, { at: number; n: number; last: number; done: boolean }>;
}

export interface AutoRunRow {
  id: string;
  automationId: string;
  automationName: string;
  recordId: string;             // the item: a record id, or the website entity id
  recordTitle: string;
  at: number;
  status: 'running' | 'sent' | 'failed' | 'dry' | 'skipped' | 'interrupted';
  detail: string;
  postId?: string;
  dueAt?: string;
  steps?: { name: string; status: 'pending' | 'running' | 'ok' | 'failed' | 'skipped' | 'dry'; detail: string }[];
}

export interface ContentRecord {
  id: string;
  title: string;
  slug: string;
  status: string;
  publish_date: string;           // YYYY-MM-DD or ''
  content: string;                // Markdown (or JSON text)
  image_asset: string;            // FK → assets.id (or an image URL)
  template_ref: string;           // FK → templates.id
  tags: string[];
  created_at: number;
  updated_at: number;
  data: Record<string, unknown>;  // custom fields, keyed by FieldDef.key
  /** Rows of custom tables carry their table id; Content Plan records leave it undefined. */
  table?: string;
  sample?: boolean;
  [k: string]: unknown;
}

export interface TemplateRow {
  id: string;
  name: string;
  description: string;
  doc: NjsDoc;
  thumb?: Blob;
  width: number;
  height: number;
  version: number;        // incremented on every save
  tags: string[];
  created_at: number;
  updated_at: number;
  sample?: boolean;
}

export interface AssetRow {
  id: string;
  name: string;
  mime: string;
  size: number;
  width: number;
  height: number;
  aspect: number;
  blob: Blob;
  thumb: Blob;
  tags: string[];
  category: string;
  sourceUrl?: string;
  created_at: number;
  sample?: boolean;
}

export interface FontRow {
  id: string;
  family: string;
  weight: string;
  style: 'normal' | 'italic';
  blob: Blob;
  source: 'upload' | 'google';
  created_at: number;
}

export type JobStatus = 'running' | 'paused' | 'completed' | 'completed_with_errors' | 'failed' | 'cancelled' | 'interrupted';

export interface JobFailure { recordId: string; title: string; error: string }

export interface BatchConfig {
  templateId: string;
  database: 'content_plan';
  selection: 'filtered' | 'selected' | 'range' | 'individual';
  filter: { join: 'and' | 'or'; conditions: { id: string; field: string; op: string; value: string }[] };
  rangeFrom?: number;
  rangeTo?: number;
  format: 'png' | 'jpeg' | 'svg' | 'pdf' | 'html';
  pdfMode: 'separate' | 'combined';
  outW: number;
  outH: number;
  quality: number;
  transparent: boolean;
  filenamePattern: string;
  includeManifest: boolean;
  concurrency: number;
}

export interface JobRow {
  id: string;
  parentId?: string;           // set when this run retried a previous job
  templateId: string;
  templateName: string;
  database: string;
  selectionLabel: string;
  config: BatchConfig;
  recordIds: string[];
  format: string;
  status: JobStatus;
  started_at: number;
  completed_at?: number;
  total: number;
  success: number;
  failure: number;
  warnings: number;
  failures: JobFailure[];
  errorSummary: string;
  elapsedMs: number;
  throughput: number;          // records / s
  outputName?: string;
}


// ------------------------------------------------------------------------------------------------ content pipeline

export interface SourceRow {
  id: string;
  name: string;
  baseUrl: string;            // https://vierapparatus.com
  feedUrl: string;            // sitemap.xml or RSS/Atom feed; '' = <baseUrl>/sitemap.xml
  include: string;            // only URLs containing one of these (comma / newline separated; "re:" prefix = regular expression)
  exclude: string;            // never URLs containing one of these
  enabled: boolean;
  simulationOnly: boolean;    // posts from this source are never sent anywhere, whatever the mode
  created_at: number;
  lastCheck?: { at: number; ok: boolean; found: number; message: string };
}

export type PostStatus = 'simulated' | 'pending' | 'sent' | 'rejected' | 'failed';
export interface GuardReport { rules: { rule: string; ok: boolean; message: string }[]; verifier?: { ok: boolean; issues: string[]; skipped?: string }; attempts: number }
export interface PostChannel { key: string; label: string; postId?: string; dueAt?: string; error?: string; skipped?: string }
export interface PostRow {
  id: string;
  runId: string;
  sourceId: string;
  sourceName: string;
  url: string;                // normalised source URL: the "never twice" key
  title: string;
  summary: string;
  imageUrl?: string;
  sourceExcerpt: string;      // what the model was shown (kept so edits can be re-checked and the review is auditable)
  text: string;               // final post, link included
  status: PostStatus;
  detail: string;
  guard?: GuardReport;
  channels: PostChannel[];
  created_at: number;
  updated_at: number;
  model?: string;
}

export interface PipeRunRow {
  id: string;
  at: number;
  trigger: 'schedule' | 'retry' | 'manual';
  mode: 'simulation' | 'approval' | 'auto' | 'table';
  status: 'running' | 'ok' | 'failed' | 'cancelled' | 'interrupted' | 'skipped';
  sourceName: string;
  url: string;
  title: string;
  text: string;
  postStatus?: PostStatus;
  postId?: string;            // Buffer post id (first channel)
  detail: string;
  steps: string[];
}

export interface SettingRow { key: string; value: unknown }

/** Events that a website can report to DCE (see the website connector). */
export type WorkflowTrigger = 'article.published' | 'product.published' | 'product.reviewed';

/**
 * One step of a workflow. The steps run in order for one event; a failed step stops the workflow and is logged.
 *  text_post   — write the social post for the event's page with the Content pipeline settings (Buffer, approval, …)
 *  add_row     — create (or update) the row for the item in a table; `mapping` maps a table column to a value of the event:
 *                { "name": "title", "url": "url", "excerpt": "excerpt" } (a dot path reads nested values, e.g. "image")
 *  ai_fill     — ask Gemini for the columns named in the prompt's placeholders {{column|what to write}} and store them
 *  sync_posts  — mirror the pipeline's posts into the table
 *  batch_render — render the row with a template (the batch runner) and download the files
 */
export type WorkflowStep =
  | { kind: 'text_post' }
  | { kind: 'add_row'; tableId: string; mapping: Record<string, string> }
  | { kind: 'ai_fill'; tableId: string; prompt: string }
  | { kind: 'sync_posts'; tableId: string }
  | { kind: 'batch_render'; tableId: string; templateId: string; format: 'png' | 'jpeg' | 'svg' | 'pdf' | 'html' };

export interface WorkflowRow {
  id: string;
  name: string;
  enabled: boolean;
  connectionId: string;   // the HTTP connection (the website) that reports the events
  trigger: WorkflowTrigger;
  steps: WorkflowStep[];
  created_at: number;
  updated_at: number;
}

export interface WorkflowRunRow {
  id: string;
  workflowId: string;
  workflowName: string;
  eventId: number;
  eventType: string;
  entityId: string;
  title: string;
  at: number;
  status: 'running' | 'ok' | 'failed' | 'interrupted';
  detail: string;
  steps: { name: string; status: 'pending' | 'running' | 'ok' | 'failed' | 'skipped'; detail: string }[];
}

export class DceDB extends Dexie {
  records!: Table<ContentRecord, string>;
  fields!: Table<FieldDef, string>;
  templates!: Table<TemplateRow, string>;
  assets!: Table<AssetRow, string>;
  fonts!: Table<FontRow, string>;
  jobs!: Table<JobRow, string>;
  settings!: Table<SettingRow, string>;
  userTables!: Table<TableDef, string>;
  rows!: Table<ContentRecord, string>;
  connections!: Table<ConnectionRow, string>;
  automations!: Table<AutomationRow, string>;
  autoRuns!: Table<AutoRunRow, string>;
  sources!: Table<SourceRow, string>;
  posts!: Table<PostRow, string>;
  pipeRuns!: Table<PipeRunRow, string>;
  workflows!: Table<WorkflowRow, string>;
  workflowRuns!: Table<WorkflowRunRow, string>;

  constructor(name = 'dce') {
    super(name);
    this.version(1).stores({
      records: 'id, title, slug, status, publish_date, template_ref, image_asset, created_at, updated_at, *tags',
      fields: 'id, key, order',
      templates: 'id, name, updated_at',
      assets: 'id, name, category, created_at, *tags',
      fonts: 'id, family',
      jobs: 'id, status, started_at',
      settings: 'key',
    });
    this.version(2).stores({
      records: 'id, title, slug, status, publish_date, template_ref, image_asset, created_at, updated_at, *tags',
      fields: 'id, key, order, tableId',
      templates: 'id, name, updated_at',
      assets: 'id, name, category, created_at, *tags',
      fonts: 'id, family',
      jobs: 'id, status, started_at',
      settings: 'key',
      userTables: 'id, name, created_at',
      rows: 'id, table, created_at',
      connections: 'id, provider, created_at',
      automations: 'id, table',
      autoRuns: 'id, automationId, recordId, at',
    });
    this.version(3).stores({
      records: 'id, title, slug, status, publish_date, template_ref, image_asset, created_at, updated_at, *tags',
      fields: 'id, key, order, tableId',
      templates: 'id, name, updated_at',
      assets: 'id, name, category, created_at, *tags',
      fonts: 'id, family',
      jobs: 'id, status, started_at',
      settings: 'key',
      userTables: 'id, name, created_at',
      rows: 'id, table, created_at',
      connections: 'id, provider, created_at',
      automations: 'id, table',
      autoRuns: 'id, automationId, recordId, at',
      sources: 'id, created_at',
      posts: 'id, url, status, created_at, runId',
      pipeRuns: 'id, at',
    });
    // version 4: website workflows (what happens when the website reports an event) and their run log
    this.version(4).stores({
      workflows: 'id, enabled, created_at',
      workflowRuns: 'id, workflowId, at',
    });
    // version 5: one Automations list (record and website triggers). Old rows are converted once by migrateAutomationsOnce().
    this.version(5).stores({
      automations: 'id, enabled, created_at',
    });
  }
}

export const db = new DceDB();

export const INDEXED_RECORD_KEYS = new Set(['status', 'template_ref', 'image_asset', 'slug', 'title', 'publish_date']);

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  try {
    const row = await db.settings.get(key);
    return (row ? (row.value as T) : fallback);
  } catch { return fallback; }
}
export async function setSetting(key: string, value: unknown): Promise<void> {
  await db.settings.put({ key, value });
}
