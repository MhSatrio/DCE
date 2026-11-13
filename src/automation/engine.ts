import { applyFilter, type FilterGroup } from '../db/filter';
import { recordContent } from '../db/repo';
import { db, getSetting, setSetting, type AutoFilter, type AutomationRow, type RecordEvent, type AutoRunRow, type AutoStep, type ContentRecord, type FieldDef, type LegacyAutomationRow, type TimingConfig } from '../db/schema';
import { getValue } from '../db/fields';
import { isContent, recordsOf, rowName } from '../db/tables';
import { recordsStore, tablesStore } from '../db/stores';
import { uid } from '../engine/njs';
import { pageOf, rowIdOf, type ConnectorEvent } from '../connector/events';
import { flattenPayload, STEP_LABEL, ruleToAutomation, workflowRunToLog, workflowToAutomation } from './model';
import { scheduleFor, StopItem, runStep, type Cur, type Timing } from './steps';
import { dueNow, signatureOf } from './triggers';

export { resolveBufferCredentials, activeConnectionId, UNIT_MS } from './steps';

/**
 * Automations: "When" a trigger happens, "Then" run the steps in order for the item. Two triggers exist: a table record
 * matches its conditions (it fires once when it starts matching), or a connected website reports an event (each event is
 * one item). Every run is written to one history list, step by step. The steps themselves live in ./steps.ts.
 */

export const RETRY_AFTER_MS = 2 * 60_000;
export const MAX_ATTEMPTS = 3;

export type Fired = AutomationRow['fired'];
type FiredState = Fired[string];

// ------------------------------------------------------------------------------------------------ pure planning

/** Values a template can use: `{{title}}` and `{{content.title}}` both work, in every table. */
export function valuesOf(rec: ContentRecord, table: string): Record<string, unknown> {
  return isContent(table) ? recordContent(rec) : { ...rec.data, id: rec.id, title: rowName(rec, table) };
}

/** When should Buffer publish, for a record? (kept for the rule tests: the field's value is read from the record.) */
export function computeTiming(cfg: TimingConfig, rec: ContentRecord, fields: FieldDef[], now: number): Timing {
  if (cfg.mode !== 'field') return scheduleFor(cfg, undefined, undefined, now);
  const f = fields.find((x) => x.key === cfg.timeField);
  if (!f) return { skip: 'The time field of this automation no longer exists.' };
  return scheduleFor(cfg, String(getValue(rec, f.key) ?? ''), f.label, now);
}

export interface RunPlan { fire: ContentRecord[]; clear: string[] }

/**
 * "When a record matches": a record fires once when it starts matching. It fires again only if it stops matching and
 * later matches again, or if an attempt failed (retried after 2 minutes, at most 3 attempts; the retry starts at the
 * step that failed).
 */
export function planRun(filter: AutoFilter, fired: Fired, records: ContentRecord[], now: number, on: RecordEvent = { kind: 'matches' }): RunPlan {
  const matching = applyFilter(records, filter as FilterGroup);
  const ids = new Set(matching.map((r) => r.id));
  const fire = matching.filter((r) => {
    const st = fired[r.id];
    if (!st) return true;                                              // new (created, or started matching)
    if (on.kind === 'changed' && (st.sig ?? '') !== signatureOf(r, on.field)) return true;   // the watched value changed
    return !st.done && st.n < MAX_ATTEMPTS && now - st.last >= RETRY_AFTER_MS;               // a failed attempt, retried
  });
  // a record created stays remembered; a record that stops matching is forgotten (it can fire again)
  const clear = on.kind === 'created' ? [] : Object.keys(fired).filter((id) => !ids.has(id));
  return { fire, clear };
}

/** The value a "changed" trigger remembers for a record (empty for the other triggers). */
const sigFor = (rec: ContentRecord, on: RecordEvent): string => (on.kind === 'changed' ? signatureOf(rec, on.field) : '');

// ------------------------------------------------------------------------------------------------ items

/** A record as the item of a run. */
export function recordItem(rec: ContentRecord, table: string): Cur {
  return { key: rec.id, title: rowName(rec, table), values: valuesOf(rec, table), base: rec.id, home: table };
}

/** A website event as the item of a run. Its row gets the id of the event's page, so an event repeated is one row. */
export function eventItem(ev: ConnectorEvent): Cur {
  const p = pageOf(ev);
  return { key: ev.entityId, title: p.title, values: { ...flattenPayload(ev.payload), id: ev.entityId }, base: rowIdOf(ev), event: ev };
}

// ------------------------------------------------------------------------------------------------ running

interface ItemResult {
  status: 'sent' | 'failed' | 'skipped' | 'dry';
  detail: string;
  steps: NonNullable<AutoRunRow['steps']>;
  failedAt: number;
  postId?: string;
  dueAt?: string;
}

/**
 * Runs the steps from `from` for one item. `onStep` is called as each step starts and ends, so the history shows the
 * progress and a crash leaves a visible trail. Never throws for a failed step: the failure is in the result.
 */
export async function runSteps(a: AutomationRow, cur: Cur, o: { dry: boolean; now: number; from?: number; onStep?: (steps: NonNullable<AutoRunRow['steps']>) => Promise<void> }): Promise<ItemResult> {
  const steps: NonNullable<AutoRunRow['steps']> = a.steps.map((s) => ({ name: STEP_LABEL[s.kind], status: 'pending', detail: '' }));
  const from = o.from ?? 0;
  for (let i = 0; i < from && i < steps.length; i++) { steps[i].status = 'ok'; steps[i].detail = 'Done on an earlier attempt.'; }
  let failedAt = -1;
  let stopped = '';
  let postId: string | undefined;
  let dueAt: string | undefined;
  for (let i = from; i < a.steps.length; i++) {
    steps[i].status = 'running';
    await o.onStep?.(steps);
    try {
      const out = await runStep(a.steps[i] as AutoStep, cur, { automationName: a.name, dry: o.dry, now: o.now });
      steps[i].status = out.status === 'dry' ? 'dry' : out.status === 'skipped' ? 'skipped' : 'ok';
      steps[i].detail = out.detail;
      if (out.postId) postId = out.postId;
      if (out.dueAt) dueAt = out.dueAt;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (e instanceof StopItem) { steps[i].status = 'skipped'; steps[i].detail = msg; stopped = msg; }
      else { steps[i].status = 'failed'; steps[i].detail = msg; failedAt = i; }
      break;
    }
    await o.onStep?.(steps);
  }
  const cut = failedAt >= 0 ? failedAt : stopped ? steps.findIndex((s) => s.status === 'skipped') : -1;
  if (cut >= 0) for (let j = cut + 1; j < steps.length; j++) if (steps[j].status === 'pending') { steps[j].status = 'skipped'; steps[j].detail = 'Not run: an earlier action stopped it.'; }
  let status: ItemResult['status'];
  let detail: string;
  if (failedAt >= 0) { status = 'failed'; detail = `Stopped at “${steps[failedAt].name}”: ${steps[failedAt].detail}`; }
  else if (stopped) { status = 'skipped'; detail = stopped; }
  else if (o.dry) { status = 'dry'; detail = `Dry run: ${a.steps.length} action(s) would run, nothing was sent or changed.`; }
  else { status = 'sent'; detail = a.steps.length ? `All ${a.steps.length} action(s) finished.` : 'No action is set up yet.'; }
  return { status, detail, steps, failedAt, postId, dueAt };
}

function newRun(a: AutomationRow, cur: Cur, status: AutoRunRow['status']): AutoRunRow {
  return {
    id: uid(), automationId: a.id, automationName: a.name, recordId: cur.key, recordTitle: cur.title, at: Date.now(), status, detail: 'Running…',
    steps: a.steps.map((s) => ({ name: STEP_LABEL[s.kind], status: 'pending', detail: '' })),
  };
}

function finish(run: AutoRunRow, res: ItemResult): void {
  run.status = res.status;
  run.detail = res.detail;
  run.steps = res.steps;
  if (res.postId) run.postId = res.postId;
  if (res.dueAt) run.dueAt = res.dueAt;
}

async function saveRun(run: AutoRunRow): Promise<void> {
  await db.autoRuns.put(run);
}

/** Saves the progress of some items of one automation (the current row is read again, so nothing else is lost). */
async function saveFired(id: string, patch: Record<string, FiredState | null>): Promise<void> {
  const cur = await db.automations.get(id);
  if (!cur) return;
  const fired: Fired = { ...cur.fired };
  for (const [k, v] of Object.entries(patch)) { if (v === null) delete fired[k]; else fired[k] = v; }
  await db.automations.update(id, { fired });
}

async function runRecordItem(a: AutomationRow, rec: ContentRecord, table: string, now: number, dry: boolean, prev: FiredState | undefined, sig: string): Promise<AutoRunRow> {
  const cur = recordItem(rec, table);
  const run = newRun(a, cur, dry ? 'dry' : 'running');
  await saveRun(run);
  const from = dry || !prev || prev.done ? 0 : prev.step ?? 0;   // a retry starts at the step that failed
  const res = await runSteps(a, cur, { dry, now, from, onStep: dry ? undefined : async (steps) => { run.steps = steps; await saveRun(run); } });
  finish(run, res);
  await saveRun(run);
  if (!dry) {
    const at = prev?.at ?? now;
    const posted = !!(prev?.posted || cur.posted);
    if (res.status === 'sent') await saveFired(a.id, { [rec.id]: { at, n: (prev?.n ?? 0) + 1, last: now, done: true, step: a.steps.length, posted, sig } });
    else if (res.status === 'failed') {
      const n = (prev?.n ?? 0) + 1;
      await saveFired(a.id, { [rec.id]: { at, n, last: now, done: n >= MAX_ATTEMPTS, step: res.failedAt, posted, sig } });
    } else if (res.status === 'skipped') await saveFired(a.id, { [rec.id]: { at, n: MAX_ATTEMPTS, last: now, done: true, step: a.steps.length, posted, sig } });
  }
  return run;
}

async function runEventItem(a: AutomationRow, ev: ConnectorEvent, now: number): Promise<AutoRunRow> {
  const cur = eventItem(ev);
  const prev = a.fired[ev.entityId];
  cur.alreadyPosted = !!prev?.posted;
  const run = newRun(a, cur, 'running');
  await saveRun(run);
  const res = await runSteps(a, cur, { dry: false, now, onStep: async (steps) => { run.steps = steps; await saveRun(run); } });
  finish(run, res);
  await saveRun(run);
  await saveFired(a.id, { [ev.entityId]: { at: prev?.at ?? now, n: (prev?.n ?? 0) + 1, last: now, done: true, posted: !!(prev?.posted || cur.posted) } });
  return run;
}

/** Called by the website connector for each new event (and for a replayed one): runs every ON automation for that event. */
export async function runEventAutomations(connectionId: string, ev: ConnectorEvent): Promise<AutoRunRow[]> {
  const list = (await db.automations.toArray()).filter((a) => a.enabled && a.trigger.kind === 'event' && a.trigger.connectionId === connectionId && a.trigger.event === ev.type);
  const out: AutoRunRow[] = [];
  for (const a of list) {
    await setSetting(`automations.sample.${a.id}`, ev);   // kept for "Dry run" on the screen
    out.push(await runEventItem(a, ev, Date.now()));
  }
  return out;
}

export interface RunReport { sent: number; failed: number; skipped: number; dry: number; lines: AutoRunRow[] }

const locked = new Set<string>();
let ticking = false;

/**
 * Runs one automation. `dry` builds what would happen and sends nothing. `only` restricts a record run to specific
 * records (the manual "send for matching records"). `force` runs a switched-off automation once, when asked.
 */
export async function runAutomation(id: string, opts: { dry?: boolean; only?: string[]; now?: number; force?: boolean } = {}): Promise<RunReport> {
  const report: RunReport = { sent: 0, failed: 0, skipped: 0, dry: 0, lines: [] };
  if (locked.has(id)) return report;
  locked.add(id);
  try {
    const a = await db.automations.get(id);
    if (!a) return report;
    const now = opts.now ?? Date.now();
    if (a.trigger.kind === 'event') {
      if (!opts.dry) return report;   // website events are run when they arrive
      const sample = await getSetting<ConnectorEvent | null>(`automations.sample.${a.id}`, null);
      if (!sample) {
        const run = newRun(a, eventItem({ id: 0, createdAt: '', type: a.trigger.event, entityId: 'sample', payload: {} }), 'skipped');
        run.recordTitle = 'No event yet';
        run.detail = 'No website event has come in yet, so there is nothing to test with. Send one from the website, or wait for the next one.';
        await saveRun(run); report.lines.push(run); report.skipped++;
        return report;
      }
      const res = await runSteps(a, eventItem(sample), { dry: true, now });
      const run = newRun(a, eventItem(sample), 'dry');
      finish(run, res); await saveRun(run); report.lines.push(run); report.dry++;
      return report;
    }
    if (!a.enabled && !opts.dry && !opts.force) return report;
    const trig = a.trigger;                       // a record trigger or a schedule (website events returned above)
    const table = trig.table;
    const records = recordsOf(table);
    const on: RecordEvent = trig.kind === 'record' ? trig.on ?? { kind: 'matches' } : { kind: 'matches' };
    // a schedule runs the matching records when an occurrence is due; in between it only retries the failed ones
    const dueAt = trig.kind === 'schedule' ? dueNow(trig, now) : undefined;
    const runAll = trig.kind !== 'schedule' || dueAt !== undefined || !!opts.dry || !!opts.force;
    let todo: ContentRecord[];
    let clear: string[] = [];
    if (opts.only) todo = records.filter((r) => opts.only!.includes(r.id));
    else {
      const plan = planRun(trig.filter, a.fired, records, now, on);
      todo = runAll ? plan.fire : plan.fire.filter((r) => a.fired[r.id]);
      clear = plan.clear;
    }
    if (opts.dry && !opts.only) todo = todo.slice(0, 5);
    if (clear.length && !opts.dry) await saveFired(a.id, Object.fromEntries(clear.map((k) => [k, null])));
    for (const rec of todo) {
      const prev = (await db.automations.get(id))?.fired[rec.id];
      const run = await runRecordItem(a, rec, table, now, !!opts.dry, prev, sigFor(rec, on));
      report.lines.push(run);
      if (run.status === 'sent') report.sent++;
      else if (run.status === 'failed') report.failed++;
      else if (run.status === 'skipped') report.skipped++;
      else if (run.status === 'dry') report.dry++;
    }
    if (dueAt !== undefined && !opts.dry && !opts.only) {
      // the occurrence has been handled: it is not run again (a failed record is retried on its own)
      const fresh = await db.automations.get(id);
      if (fresh && fresh.trigger.kind === 'schedule') await db.automations.update(id, { trigger: { ...fresh.trigger, lastDue: dueAt } });
    }
    return report;
  } finally {
    locked.delete(id);
  }
}

/** Keeps the history to the latest 500 runs. */
async function trimRuns(): Promise<void> {
  const n = await db.autoRuns.count();
  if (n > 600) await db.autoRuns.bulkDelete(await db.autoRuns.orderBy('at').limit(n - 500).primaryKeys());
}

/** Runs every ON record automation once. Website automations are not here: they run when their event arrives. */
export async function tickAll(): Promise<RunReport[]> {
  if (ticking) return [];
  ticking = true;
  try {
    if (!(await getSetting<boolean>('automations.running', true))) return [];
    const list = (await db.automations.toArray()).filter((x) => x.enabled && x.trigger.kind !== 'event');
    const out: RunReport[] = [];
    for (const a of list) out.push(await runAutomation(a.id));
    await trimRuns();
    return out;
  } finally { ticking = false; }
}

// ------------------------------------------------------------------------------------------------ one-time migration

/**
 * Converts the earlier shapes once: table rules that posted to Buffer, and website workflows with their run log. Every
 * old row keeps its id, so its history stays attached. Runs at start-up, never inside a live query.
 */
export async function migrateAutomationsOnce(): Promise<void> {
  if (await getSetting<boolean>('automations.v5', false)) return;
  const now = Date.now();
  const bufferId = await getSetting<string>('connections.active.buffer', '');
  const geminiId = (await db.connections.where('provider').equals('gemini').first())?.id ?? '';
  for (const raw of (await db.automations.toArray()) as unknown[]) {
    const r = raw as Partial<LegacyAutomationRow> & { trigger?: unknown };
    if (!r.trigger && r.table && r.action) await db.automations.put(ruleToAutomation(r as LegacyAutomationRow, bufferId, now));
  }
  for (const w of await db.workflows.toArray()) {
    if (!(await db.automations.get(w.id))) await db.automations.put(workflowToAutomation(w, geminiId, now));
  }
  for (const r of await db.workflowRuns.toArray()) await db.autoRuns.put(workflowRunToLog(r));
  await db.workflows.clear();
  await db.workflowRuns.clear();
  await setSetting('automations.v5', true);
}

/** A run that was still going when DCE was closed is shown as interrupted (nothing is resumed automatically). */
export async function markInterruptedAutoRuns(): Promise<void> {
  const rows = (await db.autoRuns.toArray()).filter((r) => r.status === 'running');
  for (const r of rows) await db.autoRuns.put({ ...r, status: 'interrupted', detail: 'DCE was closed while this was running. Run it again if needed.' });
}

/** Evaluates record automations at start-up (catch-up), every 20 s, and 1.5 s after any data change — while the app is open. */
export function startAutomationLoop(): () => void {
  let timer: number | undefined;
  const soon = () => { clearTimeout(timer); timer = window.setTimeout(() => void tickAll().catch(() => undefined), 1500); };
  const unsubs = [recordsStore.subscribe(soon), tablesStore.subscribe(soon)];
  const iv = window.setInterval(() => void tickAll().catch(() => undefined), 20_000);
  void (async () => {
    await migrateAutomationsOnce().catch(() => undefined);
    await markInterruptedAutoRuns().catch(() => undefined);
    soon();
  })();
  return () => { clearInterval(iv); clearTimeout(timer); unsubs.forEach((u) => u()); };
}
