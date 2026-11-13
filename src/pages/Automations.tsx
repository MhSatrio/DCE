import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { ArrowDown, ArrowUp, CalendarClock, FlaskConical, Pause, Play, Plus, Send, Trash2, Zap } from 'lucide-react';
import { runAutomation, type RunReport } from '../automation/engine';
import {
  automationProblems, CONTENT, channelLabelOf, FORMATS, isWebsite, METHODS, newStep, PRESET_LABEL, presetAutomation, RUN_STATUS_CHIP,
  stepChoices, stepProblems, stepSummary, STEP_LABEL, triggerChoices, triggerSummary, type Names, type PresetId,
} from '../automation/model';
import { channelProps } from '../db/connections';
import { armedLastDue, choiceKey, dateKey, signatureOf, triggerFromValue } from '../automation/triggers';
import { applyFilter, type FilterGroup } from '../db/filter';
import { db, getSetting, setSetting, type AutoMethod, type AutomationRow, type AutoRunRow, type AutoStep, type AutoTrigger, type ConnectionRow, type FieldDef, type TemplateRow, type WorkflowTrigger } from '../db/schema';
import { allTables, createTable, fieldsOf, recordsOf, tableName } from '../db/tables';
import { parsePlaceholders } from '../connector/fill';
import { EVENT_TYPE_TEXT } from '../connector/events';
import { Dialog, Empty, fmtDate, IconBtn } from '../ui/kit';
import { FilterBuilder } from '../ui/FilterBuilder';
import { confirmAction, notify } from '../ui/store';
import { uid } from '../engine/njs';

/** The fields a website event carries, for the "insert a field" menus. Any other text can still be typed. */
const EVENT_KEYS: Record<WorkflowTrigger, string[]> = {
  'article.published': ['title', 'url', 'excerpt', 'body', 'category', 'tags', 'author', 'image', 'publishedAt', 'slug'],
  'product.published': ['name', 'url', 'manufacturer', 'category', 'shortDescription', 'imageUrl', 'advantages', 'limitations'],
  'product.reviewed': ['name', 'url', 'manufacturer', 'category', 'shortDescription', 'imageUrl', 'advantages', 'limitations', 'editorialReview'],
};

const statusChip = (s: AutoRunRow['status']) => <span className={`chip ${RUN_STATUS_CHIP[s].cls}`}>{RUN_STATUS_CHIP[s].text}</span>;

/** The fields an item of this trigger has, for "insert a field". */
function itemFields(t: AutoTrigger): { key: string; label: string }[] {
  if (t.kind !== 'event') return fieldsOf(t.table).map((f: FieldDef) => ({ key: f.key, label: f.label }));
  return EVENT_KEYS[t.event].map((k) => ({ key: k, label: k }));
}


/** One card of the flow. The "then" line between cards shows the order, like Airtable's automation steps. */
function Card({ children, last }: { children: React.ReactNode; last?: boolean }) {
  return (
    <div className="col" style={{ gap: 0 }}>
      <section className="panel">{children}</section>
      {!last && <div className="muted small" aria-hidden="true" style={{ textAlign: 'center', padding: '4px 0' }}>↓ then</div>}
    </div>
  );
}

/** The "When" card: what starts the automation: a record is created, a field changes, a record matches, a time comes, or a website event. */
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const TRIGGER_TEXT: Record<string, string> = {
  matches: 'A record starts the actions once when it starts matching; if it stops matching and matches again, it starts again.',
  created: 'Each new record starts the actions once. Records that already exist when you turn this on are not run unless you choose so.',
  changed: 'The actions run each time the watched field gets a different value (for a record that matches the conditions).',
  once: 'At that time, the actions run for every matching record that has not run yet.',
  weekly: 'On those days at that time, the actions run for every matching record that has not run yet. Turning it on does not run occurrences that already passed.',
};

function TriggerCard({ a, conns, names, save }: { a: AutomationRow; conns: ConnectionRow[]; names: Names; save: (p: Partial<AutomationRow>) => void }) {
  const choices = triggerChoices(conns, (c) => c.name);
  const t = a.trigger;
  const currentKey = t.kind === 'record' ? `record:${(t.on ?? { kind: 'matches' }).kind}` : t.kind === 'schedule' ? `schedule:${t.when.mode}` : `event:${t.connectionId}:${t.event}`;
  const groups = Array.from(new Set(choices.map((c) => c.group)));
  const pick = (key: string) => {
    const choice = choices.find((c) => choiceKey(c.value) === key);
    if (!choice || !choice.enabled) return;
    const table = t.kind === 'event' ? CONTENT : t.table;
    const trig = triggerFromValue(choice.value, { table, field: fieldsOf(table)[0]?.key ?? '', now: Date.now(), prev: t });
    save({ trigger: trig, fired: {} });
  };
  const matching = t.kind === 'event' ? 0 : applyFilter(recordsOf(t.table), t.filter as FilterGroup).length;
  const explain = t.kind === 'record' ? TRIGGER_TEXT[(t.on ?? { kind: 'matches' }).kind] : t.kind === 'schedule' ? TRIGGER_TEXT[t.when.mode] : '';
  // the schedule's own settings, narrowed once so the handlers below can use them
  const weekly = t.kind === 'schedule' && t.when.mode === 'weekly' ? t.when : null;
  const once = t.kind === 'schedule' && t.when.mode === 'once' ? t.when : null;
  return (
    <Card>
      <div className="panel-head"><span className="chip blue">When</span><h2>{triggerSummary(t, names)}</h2></div>
      <div className="panel-body col">
        <label className="fld" style={{ maxWidth: 460 }}><span>Trigger</span>
          <select aria-label="Trigger" value={currentKey} onChange={(e) => pick(e.target.value)}>
            {groups.map((group) => (
              <optgroup key={group} label={group}>
                {choices.filter((c) => c.group === group).map((c) => (
                  <option key={choiceKey(c.value)} value={choiceKey(c.value)} disabled={!c.enabled}>
                    {c.label}{c.enabled ? '' : ` — ${c.reason ?? 'not available'}`}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
        {t.kind !== 'event' && (
          <>
            <label className="fld" style={{ maxWidth: 320 }}><span>Table</span>
              <select aria-label="Trigger table" value={t.table} onChange={(e) => save({ trigger: { ...t, table: e.target.value, filter: { join: 'and', conditions: [] } } as AutoTrigger, fired: {} })}>
                {allTables().map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </select>
            </label>
            {t.kind === 'record' && t.on?.kind === 'changed' && (
              <label className="fld" style={{ maxWidth: 320 }}><span>When this field changes</span>
                <select aria-label="Watched field" value={t.on.field} onChange={(e) => save({ trigger: { ...t, on: { kind: 'changed', field: e.target.value } } as AutoTrigger, fired: {} })}>
                  <option value="">— choose —</option>
                  {fieldsOf(t.table).map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                </select>
              </label>
            )}
            {once && (
              <label className="fld" style={{ maxWidth: 320 }}><span>Date and time</span>
                <input type="datetime-local" aria-label="Run at" value={once.at} onChange={(e) => save({ trigger: { ...t, when: { mode: 'once', at: e.target.value } } as AutoTrigger, fired: {} })} />
              </label>
            )}
            {weekly && (
              <div className="row wrap" style={{ gap: 14, alignItems: 'flex-end' }}>
                <label className="fld"><span>Time</span>
                  <input type="time" aria-label="Run time" value={weekly.time} onChange={(e) => save({ trigger: { ...t, when: { mode: 'weekly', time: e.target.value, days: weekly.days } } as AutoTrigger, fired: {} })} />
                </label>
                <div className="fld"><span>Days</span>
                  <div className="row wrap">
                    {DAY_SHORT.map((d, i) => (
                      <label key={d} className="chk">
                        <input type="checkbox" aria-label={DAY_NAMES[i]} checked={weekly.days.includes(i)} onChange={(e) => {
                          const days = e.target.checked ? [...weekly.days, i].sort((x, y) => x - y) : weekly.days.filter((x) => x !== i);
                          save({ trigger: { ...t, when: { mode: 'weekly', time: weekly.time, days } } as AutoTrigger, fired: {} });
                        }} /> {d}
                      </label>
                    ))}
                  </div>
                </div>
              </div>
            )}
            <FilterBuilder value={t.filter as FilterGroup} onChange={(g) => save({ trigger: { ...t, filter: g } as AutoTrigger, fired: {} })} fields={fieldsOf(t.table)} />
            <div className="small muted">{matching} record{matching === 1 ? '' : 's'} match right now. {explain}</div>
          </>
        )}
        {t.kind === 'event' && (
          <div className="small muted">Runs once for each new item the website reports ({EVENT_TYPE_TEXT[t.event] ?? t.event}). Repeating the same item updates the same row and is not posted twice.</div>
        )}
      </div>
    </Card>
  );
}

/** One "Then" step: pick the connection, then the action that connection allows, then its settings. */
function StepCard({ a, index, conns, templates, names, save }: {
  a: AutomationRow; index: number; conns: ConnectionRow[]; templates: TemplateRow[]; names: Names; save: (p: Partial<AutomationRow>) => void;
}) {
  const step = a.steps[index];
  const steps = a.steps;
  const put = (s: AutoStep) => save({ steps: steps.map((x, i) => (i === index ? s : x)) });
  const remove = () => save({ steps: steps.filter((_, i) => i !== index) });
  const move = (d: number) => {
    const j = index + d;
    if (j < 0 || j >= steps.length) return;
    const next = [...steps];
    [next[index], next[j]] = [next[j], next[index]];
    save({ steps: next });
  };
  const connId = 'connectionId' in step ? step.connectionId : '';
  const connOptions = conns.filter((c) => c.provider === 'buffer' || c.provider === 'gemini' || (c.provider === 'http' && !isWebsite(c)));
  const actions = stepChoices(conns, (c) => c.name).filter((ch) => ch.value.connectionId === connId);
  const chooseConnection = (id: string) => {
    const options = stepChoices(conns, (c) => c.name).filter((ch) => ch.value.connectionId === id);
    const keep = options.find((o) => o.value.kind === step.kind);
    const pick = keep ?? options.find((o) => o.enabled) ?? options[0];
    if (!pick) return;
    put(newStep(pick.value.kind, { connectionId: id, table: defaultTable(a), channel: firstChannel(conns, id), templateId: templates[0]?.id }));
  };
  const problems = stepProblems(step);
  return (
    <Card last={index === steps.length - 1}>
      <div className="panel-head" style={{ flexWrap: 'wrap' }}>
        <span className="chip blue">{index + 1}</span>
        <label className="fld" style={{ minWidth: 200 }}><span className="sr-only">Connection for this action</span>
          <select aria-label={`Connection of action ${index + 1}`} value={connId} onChange={(e) => chooseConnection(e.target.value)}>
            <option value="">This app (tables, Content pipeline)</option>
            {connOptions.map((c) => <option key={c.id} value={c.id}>{c.provider === 'buffer' ? 'Buffer' : c.provider === 'gemini' ? 'Gemini' : 'API'} · {c.name}</option>)}
          </select>
        </label>
        <label className="fld" style={{ minWidth: 220 }}><span className="sr-only">Action</span>
          <select aria-label={`Action ${index + 1}`} value={step.kind} onChange={(e) => {
            const pick = actions.find((x) => x.value.kind === e.target.value);
            if (pick && pick.enabled) put(newStep(pick.value.kind, { connectionId: connId, table: defaultTable(a), channel: firstChannel(conns, connId), templateId: templates[0]?.id }));
          }}>
            {actions.map((x) => <option key={x.value.kind} value={x.value.kind} disabled={!x.enabled}>{x.label}{x.enabled ? '' : ` — ${x.reason ?? ''}`}</option>)}
          </select>
        </label>
        <span className="grow" />
        <IconBtn icon={<ArrowUp size={13} />} label={`Move action ${index + 1} up`} onClick={() => move(-1)} />
        <IconBtn icon={<ArrowDown size={13} />} label={`Move action ${index + 1} down`} onClick={() => move(1)} />
        <IconBtn icon={<Trash2 size={13} />} label={`Remove action ${index + 1}`} onClick={remove} />
      </div>
      <div className="panel-body col" style={{ gap: 8 }}>
        <div className="small"><b>{STEP_LABEL[step.kind]}</b> — {stepSummary(step, names)}</div>
        {problems.length > 0 && <div className="callout warn">{problems.map((p, i) => <div key={i}>⚠ {p}</div>)}</div>}
        <StepForm step={step} index={index} a={a} conns={conns} templates={templates} onChange={put} />
      </div>
    </Card>
  );
}

const defaultTable = (a: AutomationRow): string => (a.trigger.kind === 'record' ? a.trigger.table : allTables()[0]?.id ?? '');
const firstChannel = (conns: ConnectionRow[], connId: string): string => {
  const c = conns.find((x) => x.id === connId);
  return c ? channelProps(c)[0]?.key ?? '' : '';
};

function TableSelect({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="fld" style={{ maxWidth: 320 }}><span>{label}</span>
      <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">— choose a table —</option>
        {allTables().map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
      </select>
    </label>
  );
}

function InsertField({ fields, onInsert }: { fields: { key: string; label: string }[]; onInsert: (key: string) => void }) {
  return (
    <label className="fld" style={{ maxWidth: 360 }}><span>Insert a field</span>
      <select aria-label="Insert field" value="" onChange={(e) => e.target.value && onInsert(e.target.value)}>
        <option value="">Choose…</option>
        {fields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
      </select>
    </label>
  );
}

function StepForm({ step, index, a, conns, templates, onChange }: { step: AutoStep; index: number; a: AutomationRow; conns: ConnectionRow[]; templates: TemplateRow[]; onChange: (s: AutoStep) => void }) {
  const fields = itemFields(a.trigger);
  switch (step.kind) {
    case 'buffer_post': {
      const conn = conns.find((c) => c.id === step.connectionId);
      const channels = conn ? channelProps(conn) : [];
      const homeFields = a.trigger.kind === 'record' ? fieldsOf(a.trigger.table) : [];
      const urlFields = fields.filter((f) => ['url', 'image', 'imageUrl'].includes(f.key) || /url|image/i.test(f.key));
      const timing = step.timing;
      const setTiming = (p: Partial<typeof timing>) => onChange({ ...step, timing: { ...timing, ...p } });
      return (
        <>
          <div className="grid2">
            <label className="fld"><span>Channel</span>
              <select aria-label="Channel" value={step.channel} onChange={(e) => onChange({ ...step, channel: e.target.value })}>
                <option value="">— choose —</option>
                {channels.map((p) => <option key={p.id} value={p.key}>{channelLabelOf(p.key)} ({p.key})</option>)}
              </select>
            </label>
            <label className="fld"><span>Image field (a public https:// address)</span>
              <select aria-label="Image field" value={step.imageField ?? ''} onChange={(e) => onChange({ ...step, imageField: e.target.value || undefined })}>
                <option value="">No image</option>
                {urlFields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
              </select>
            </label>
          </div>
          <label className="fld"><span>Post text — use fields as {'{{title}}'}</span>
            <textarea rows={4} aria-label="Post text" value={step.text} onChange={(e) => onChange({ ...step, text: e.target.value })} />
          </label>
          <InsertField fields={fields} onInsert={(k) => onChange({ ...step, text: `${step.text}${step.text && !step.text.endsWith('\n') ? ' ' : ''}{{${k}}}` })} />
          <div className="fld"><span>When should Buffer publish?</span>
            <div className="col" style={{ gap: 6 }} role="radiogroup" aria-label="Timing">
              <label className="chk"><input type="radio" name={`timing-${a.id}-${index}`} checked={timing.mode === 'queue'} onChange={() => setTiming({ mode: 'queue' })} /> In the next free slot of the channel's Buffer queue</label>
              <label className="chk"><input type="radio" name={`timing-${a.id}-${index}`} checked={timing.mode === 'delay'} onChange={() => setTiming({ mode: 'delay' })} />
                After <input type="number" min={0} aria-label="Delay amount" style={{ width: 80 }} value={timing.delayAmount} onChange={(e) => setTiming({ delayAmount: Number(e.target.value), mode: 'delay' })} />
                <select aria-label="Delay unit" value={timing.delayUnit} onChange={(e) => setTiming({ delayUnit: e.target.value as 'minutes', mode: 'delay' })}><option value="minutes">minutes</option><option value="hours">hours</option><option value="days">days</option></select> from the moment the item starts
              </label>
              {a.trigger.kind === 'record' && (
                <label className="chk"><input type="radio" name={`timing-${a.id}-${index}`} checked={timing.mode === 'field'} onChange={() => setTiming({ mode: 'field', timeField: timing.timeField ?? homeFields.find((f) => f.type === 'date' || f.type === 'datetime')?.key })} />
                  At the date &amp; time in the field
                  <select aria-label="Time field" value={timing.timeField ?? ''} onChange={(e) => setTiming({ timeField: e.target.value, mode: 'field' })}>
                    <option value="">— choose —</option>{homeFields.filter((f) => f.type === 'date' || f.type === 'datetime').map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                  </select>
                </label>
              )}
              {timing.mode === 'field' && (
                <label className="fld" style={{ marginLeft: 22, maxWidth: 380 }}><span>If that time has already passed</span>
                  <select aria-label="Past policy" value={timing.pastPolicy} onChange={(e) => setTiming({ pastPolicy: e.target.value as 'skip' | 'queue' })}><option value="skip">Skip it and log why (safe)</option><option value="queue">Add to the queue instead</option></select>
                </label>
              )}
            </div>
            <div className="muted small" style={{ marginTop: 4 }}>The post is created in Buffer with its publish time, and Buffer publishes it even if DCE is closed afterwards.</div>
          </div>
          <label className="fld" style={{ maxWidth: 360 }}><span>Store the post id in (this item's row)</span>
            <select aria-label="Post id field" value={step.resultField ?? ''} onChange={(e) => onChange({ ...step, resultField: e.target.value || undefined })}>
              <option value="">— nowhere —</option>
              {homeFields.filter((f) => ['text', 'longtext'].includes(f.type) && !f.builtin).map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
            </select>
          </label>
        </>
      );
    }
    case 'pipeline_post':
      return <div className="small muted">Uses the Content pipeline settings (Content pipeline page: writer, checks, and whether it is simulation, approval or auto-publish). The item needs a page address (url).</div>;
    case 'gemini_fill': {
      const fieldsFound = parsePlaceholders(step.prompt);
      const existing = new Set(fieldsOf(step.table).map((f) => f.key));
      return (
        <>
          <div className="grid2">
            <label className="fld"><span>Gemini key</span>
              <select aria-label="Gemini key" value={step.connectionId} onChange={(e) => onChange({ ...step, connectionId: e.target.value })}>
                <option value="">— choose —</option>
                {conns.filter((c) => c.provider === 'gemini').map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
            <TableSelect label="Table to fill" value={step.table} onChange={(v) => onChange({ ...step, table: v })} />
          </div>
          <label className="fld"><span>Prompt — write {'{{column|what to write}}'} for each column Gemini should fill</span>
            <textarea rows={5} aria-label="Prompt" value={step.prompt} onChange={(e) => onChange({ ...step, prompt: e.target.value })} />
          </label>
          <div className="small muted">
            {fieldsFound.length === 0 ? 'No column yet.' : <>Gemini fills: {fieldsFound.map((f) => <span key={f.key} className="chip" style={{ marginRight: 4 }}>{f.key}{existing.has(f.key) ? '' : ' (new column)'}</span>)}</>}
          </div>
          <div className="small muted">Gemini reads the item's own text (for example the article's excerpt and body). The answer must be complete, or nothing is written.</div>
        </>
      );
    }
    case 'http': {
      const conn = conns.find((c) => c.id === step.connectionId);
      const ops = conn?.caps?.operations ?? [];
      return (
        <>
          {conn?.caps && <div className="small muted">{conn.caps.note}</div>}
          {ops.length > 0 && (
            <label className="fld"><span>Use a published operation</span>
              <select aria-label="Operation" value="" onChange={(e) => {
                const op = ops.find((o) => `${o.method} ${o.path}` === e.target.value);
                if (op) onChange({ ...step, method: op.method as AutoMethod, path: op.path });
              }}>
                <option value="">Choose an operation…</option>
                {ops.map((o) => <option key={`${o.method} ${o.path}`} value={`${o.method} ${o.path}`}>{o.method} {o.path}{o.summary ? ` — ${o.summary}` : ''}</option>)}
              </select>
            </label>
          )}
          <div className="grid2">
            <label className="fld" style={{ maxWidth: 160 }}><span>Method</span>
              <select aria-label="Method" value={step.method} onChange={(e) => onChange({ ...step, method: e.target.value as typeof step.method })}>
                {METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </label>
            <label className="fld"><span>Path (after the connection's address)</span>
              <input aria-label="Path" value={step.path} onChange={(e) => onChange({ ...step, path: e.target.value })} placeholder="/api/items/{{id}}" />
            </label>
          </div>
          {step.method !== 'GET' && (
            <>
              <label className="fld"><span>Body (JSON or text; use fields as {'{{title}}'})</span>
                <textarea rows={4} aria-label="Body" value={step.body} onChange={(e) => onChange({ ...step, body: e.target.value })} />
              </label>
              <InsertField fields={fields} onInsert={(k) => onChange({ ...step, body: `${step.body}{{${k}}}` })} />
            </>
          )}
          <div className="grid2">
            <TableSelect label="Store the answer in table (optional)" value={step.table ?? ''} onChange={(v) => onChange({ ...step, table: v || undefined })} />
            <label className="fld"><span>…in this field</span>
              <select aria-label="Answer field" value={step.resultField ?? ''} onChange={(e) => onChange({ ...step, resultField: e.target.value || undefined })} disabled={!step.table}>
                <option value="">— nowhere —</option>
                {(step.table ? fieldsOf(step.table) : []).filter((f) => ['text', 'longtext'].includes(f.type) && !f.builtin).map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
              </select>
            </label>
          </div>
        </>
      );
    }
    case 'add_row': {
      const entries = Object.entries(step.mapping);
      const setEntries = (next: [string, string][]) => onChange({ ...step, mapping: Object.fromEntries(next) });
      return (
        <>
          <TableSelect label="Table" value={step.table} onChange={(v) => onChange({ ...step, table: v })} />
          <div className="small muted">Each column gets a value. The row is found again by the item, so repeating it updates the same row.</div>
          {entries.map(([col, tpl], i) => (
            <div className="row wrap" key={i}>
              <input aria-label={`Column ${i + 1}`} value={col} placeholder="Column" style={{ width: 170 }} onChange={(e) => setEntries(entries.map((x, j) => (j === i ? [e.target.value, x[1]] : x)))} />
              <input aria-label={`Value ${i + 1}`} value={tpl} placeholder="{{title}}" style={{ flex: 1, minWidth: 200 }} onChange={(e) => setEntries(entries.map((x, j) => (j === i ? [x[0], e.target.value] : x)))} />
              <IconBtn icon={<Trash2 size={13} />} label={`Remove column ${i + 1}`} onClick={() => setEntries(entries.filter((_, j) => j !== i))} />
            </div>
          ))}
          <div className="row wrap">
            <button className="btn sm" onClick={() => setEntries([...entries, [`column_${entries.length + 1}`, '{{title}}']])}><Plus size={13} /> Add column</button>
            <InsertField fields={fields} onInsert={(k) => setEntries([...entries, [k, `{{${k}}}`]])} />
          </div>
        </>
      );
    }
    case 'set_field': {
      const cols = step.table ? fieldsOf(step.table).filter((f) => !f.readonly && !f.sync) : [];
      return (
        <>
          <div className="grid2">
            <TableSelect label="Table" value={step.table} onChange={(v) => onChange({ ...step, table: v, field: '' })} />
            <label className="fld"><span>Field</span>
              <select aria-label="Field" value={step.field} onChange={(e) => onChange({ ...step, field: e.target.value })}>
                <option value="">— choose —</option>{cols.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
              </select>
            </label>
          </div>
          <label className="fld" style={{ maxWidth: 420 }}><span>Set it to</span>
            <input aria-label="Value" value={step.value} onChange={(e) => onChange({ ...step, value: e.target.value })} placeholder="e.g. Posted" />
          </label>
          {step.table && a.trigger.kind === 'event' && <div className="small muted">The row is the one of this item in that table (add it with an “Add or update a row” action first).</div>}
        </>
      );
    }
    case 'random_time': {
      const dateFields = step.table ? fieldsOf(step.table).filter((f) => f.type === 'datetime' || f.type === 'date') : [];
      return (
        <>
          <div className="grid2">
            <TableSelect label="Table" value={step.table} onChange={(v) => onChange({ ...step, table: v, field: '' })} />
            <label className="fld"><span>Date & time field to fill</span>
              <select aria-label="Random time field" value={step.field} onChange={(e) => onChange({ ...step, field: e.target.value })}>
                <option value="">— choose —</option>
                {dateFields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
              </select>
            </label>
          </div>
          <div className="grid2">
            <label className="fld"><span>From date</span><input type="date" aria-label="Window from" value={step.from} onChange={(e) => onChange({ ...step, from: e.target.value })} /></label>
            <label className="fld"><span>To date</span><input type="date" aria-label="Window to" value={step.to} onChange={(e) => onChange({ ...step, to: e.target.value })} /></label>
            <label className="fld"><span>Earliest time</span><input type="time" aria-label="Window earliest time" value={step.fromTime} onChange={(e) => onChange({ ...step, fromTime: e.target.value })} /></label>
            <label className="fld"><span>Latest time</span><input type="time" aria-label="Window latest time" value={step.toTime} onChange={(e) => onChange({ ...step, toTime: e.target.value })} /></label>
          </div>
          <label className="chk"><input type="checkbox" aria-label="Weekdays only" checked={step.weekdays} onChange={(e) => onChange({ ...step, weekdays: e.target.checked })} /> Weekdays only (Monday to Friday)</label>
          <label className="chk"><input type="checkbox" aria-label="Only if empty" checked={step.onlyIfEmpty} onChange={(e) => onChange({ ...step, onlyIfEmpty: e.target.checked })} /> Only if the field is empty (keep a time that is already set)</label>
          <div className="small muted">Each row gets its own random time in 5-minute steps inside the window. A time that another row already has is not chosen again.</div>
        </>
      );
    }
    case 'sync_posts':
      return <TableSelect label="Table" value={step.table} onChange={(v) => onChange({ ...step, table: v })} />;
    case 'render':
      return (
        <div className="grid2">
          <TableSelect label="Table" value={step.table} onChange={(v) => onChange({ ...step, table: v })} />
          <label className="fld"><span>Template</span>
            <select aria-label="Template" value={step.templateId} onChange={(e) => onChange({ ...step, templateId: e.target.value })}>
              <option value="">— choose —</option>{templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </label>
          <label className="fld" style={{ maxWidth: 200 }}><span>Format</span>
            <select aria-label="Format" value={step.format} onChange={(e) => onChange({ ...step, format: e.target.value as typeof step.format })}>
              {FORMATS.map((f) => <option key={f} value={f}>{f.toUpperCase()}</option>)}
            </select>
          </label>
        </div>
      );
  }
}

function History({ a }: { a: AutomationRow }) {
  const runs = useLiveQuery(() => db.autoRuns.where('automationId').equals(a.id).reverse().sortBy('at').then((r) => r.slice(0, 40)), [a.id], [] as AutoRunRow[]);
  return (
    <section className="panel">
      <div className="panel-head"><CalendarClock size={15} /><h2>History</h2><span className="muted small">last {runs.length}</span></div>
      {runs.length === 0 ? <div className="empty">Nothing has run yet.</div> : (
        <table className="tbl"><thead><tr><th>When</th><th>Item</th><th>Result</th><th>Details</th></tr></thead>
          <tbody>{runs.map((r) => (
            <tr key={r.id}>
              <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(r.at)}</td>
              <td>{r.recordTitle}</td>
              <td>{statusChip(r.status)}</td>
              <td className="small">
                {r.steps && r.steps.length ? (
                  <details><summary>{r.detail}{r.postId ? <span className="muted"> · post {r.postId}</span> : null}</summary>
                    <ol style={{ margin: '4px 0 0', paddingLeft: 18 }}>{r.steps.map((s, i) => <li key={i}><b>{s.name}</b>: {s.status}{s.detail ? ` — ${s.detail}` : ''}</li>)}</ol>
                  </details>
                ) : <>{r.detail}{r.postId ? <span className="muted"> · post {r.postId}</span> : null}</>}
              </td>
            </tr>
          ))}</tbody></table>
      )}
    </section>
  );
}

function Editor({ a, conns, templates }: { a: AutomationRow; conns: ConnectionRow[]; templates: TemplateRow[] }) {
  const names: Names = useMemo(() => ({
    connection: (id) => (id ? conns.find((c) => c.id === id)?.name ?? '(deleted connection)' : 'this app'),
    table: (id) => (id ? allTables().find((t) => t.id === id) ? tableName(id) : '(deleted table)' : '(no table)'),
    template: (id) => templates.find((t) => t.id === id)?.name ?? '(deleted template)',
    channel: (key) => (key ? channelLabelOf(key) : ''),
  }), [conns, templates]);
  const [report, setReport] = useState<RunReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [dlg, setDlg] = useState<number | null>(null);
  const save = (patch: Partial<AutomationRow>) => db.automations.update(a.id, { ...patch, updated_at: Date.now() });
  const problems = automationProblems(a);
  const matching = a.trigger.kind !== 'event' ? applyFilter(recordsOf(a.trigger.table), a.trigger.filter as FilterGroup) : [];

  const toggle = async (on: boolean) => {
    if (!on) { await save({ enabled: false }); notify('info', 'Automation turned off.'); return; }
    if (problems.length) { notify('warn', `Not ready yet: ${problems[0]}`); return; }
    if (a.trigger.kind === 'event') { await save({ enabled: true }); notify('success', 'Automation is on. It runs when the website reports the event.'); return; }
    if (a.trigger.kind === 'schedule') {
      // occurrences that already passed are not run when it is switched on: only the future ones
      await save({ enabled: true, trigger: { ...a.trigger, lastDue: armedLastDue(a.trigger.when, Date.now()) } });
      notify('success', 'Automation is on. It runs at the chosen time.');
      return;
    }
    // records that already match and have not acted yet: they must be an explicit choice, never an accidental burst
    const fresh = await db.automations.get(a.id);
    const pending = matching.filter((r) => !fresh?.fired[r.id]);
    if (pending.length === 0) { await save({ enabled: true }); notify('success', 'Automation is on. It acts when a record starts matching.'); return; }
    setDlg(pending.length);
  };
  const arm = async (includeExisting: boolean) => {
    const fired: AutomationRow['fired'] = {};
    const watched = a.trigger.kind === 'record' && a.trigger.on?.kind === 'changed' ? a.trigger.on.field : '';
    if (!includeExisting) for (const r of matching) fired[r.id] = { at: Date.now(), n: 0, last: Date.now(), done: true, step: a.steps.length, sig: watched ? signatureOf(r, watched) : '' };
    await db.automations.update(a.id, { enabled: true, fired, updated_at: Date.now() });
    setDlg(null);
    notify('success', includeExisting ? `Automation is on — ${matching.length} matching record${matching.length === 1 ? '' : 's'} will be sent now.` : 'Automation is on — only records that START matching from now on are sent.');
  };
  const addAction = (value: string) => {
    if (!value) return;
    const [kind, connectionId] = value.split('|') as [AutoStep['kind'], string];
    const d = defaultTable(a);
    save({ steps: [...a.steps, newStep(kind, { connectionId, table: d, channel: firstChannel(conns, connectionId), templateId: templates[0]?.id })] });
  };
  const choices = stepChoices(conns, (c) => c.name);

  return (
    <div className="col" style={{ gap: 12, minWidth: 0 }}>
      <div className="row wrap">
        <input aria-label="Automation name" value={a.name} onChange={(e) => save({ name: e.target.value })} style={{ fontWeight: 600, fontSize: 15, width: 300 }} />
        <span className="grow" />
        <label className="chk" style={{ fontWeight: 600 }}>
          <input type="checkbox" role="switch" aria-label="Automation enabled" checked={a.enabled} onChange={(e) => void toggle(e.target.checked)} /> {a.enabled ? 'On' : 'Off'}
        </label>
        <IconBtn icon={<Trash2 size={15} />} label="Delete automation" onClick={async () => {
          if (await confirmAction(`Delete “${a.name}”?`, 'Its history is deleted too. Posts already sent to Buffer are not affected.')) {
            await db.automations.delete(a.id);
            await db.autoRuns.where('automationId').equals(a.id).delete();
          }
        }} />
      </div>
      {problems.length > 0 && <div className="callout warn" role="status">Not ready: {problems.join(' ')}</div>}

      <TriggerCard a={a} conns={conns} names={names} save={save} />

      {a.steps.map((s, i) => (
        <StepCard key={`${i}-${s.kind}`} a={a} index={i} conns={conns} templates={templates} names={names} save={save} />
      ))}
      {a.steps.length === 0 && <div className="callout">No action yet. Add the first one below.</div>}
      <div className="row wrap">
        <label className="fld" style={{ minWidth: 300 }}><span className="sr-only">Add action</span>
          <select aria-label="Add action" value="" onChange={(e) => addAction(e.target.value)}>
            <option value="">+ Add action…</option>
            {Array.from(new Set(choices.map((c) => c.group))).map((group) => (
              <optgroup key={group} label={group}>
                {choices.filter((c) => c.group === group).map((c) => (
                  <option key={`${group}-${c.label}-${c.value.connectionId}`} value={`${c.value.kind}|${c.value.connectionId}`} disabled={!c.enabled}>
                    {c.label}{c.enabled ? '' : ` — ${c.reason ?? ''}`}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
      </div>

      <section className="panel">
        <div className="panel-head"><FlaskConical size={15} /><h2>Test it safely</h2></div>
        <div className="panel-body col" style={{ gap: 8 }}>
          <div className="row wrap">
            <button className="btn" disabled={busy} onClick={async () => { setBusy(true); setReport(await runAutomation(a.id, { dry: true })); setBusy(false); }}><FlaskConical size={14} /> Dry run (sends nothing)</button>
            {a.trigger.kind === 'record' && (
              <button className="btn danger" disabled={busy || matching.length === 0 || problems.length > 0} onClick={async () => {
                if (!(await confirmAction(`Run this automation for ${matching.length} matching record${matching.length === 1 ? '' : 's'} now?`, 'This sends real posts and changes real rows for every record that matches right now.', 'Run now', false))) return;
                setBusy(true);
                const r = await runAutomation(a.id, { force: true, only: matching.map((m) => m.id) });
                setReport(r); setBusy(false);
                notify(r.failed ? 'warn' : 'success', `Done ${r.sent}, failed ${r.failed}, skipped ${r.skipped}.`);
              }}><Send size={14} /> Run for matching records now…</button>
            )}
          </div>
          <div className="small muted">Website automations run when the website reports their event. The dry run uses the last event DCE received for this automation.</div>
        </div>
      </section>

      <History a={a} />

      {report && (
        <Dialog title="Result" onClose={() => setReport(null)} size="mid" foot={<button className="btn primary" onClick={() => setReport(null)}>Close</button>}>
          <div className="row wrap"><span className="chip ok">{report.sent} done</span><span className="chip err">{report.failed} failed</span><span className="chip warn">{report.skipped} skipped</span><span className="chip blue">{report.dry} dry run</span></div>
          {report.lines.length === 0 && <div className="muted">No record needed handling.</div>}
          {report.lines.map((l) => (
            <div key={l.id} className="callout">{statusChip(l.status)} <b>{l.recordTitle}</b> — {l.detail}
              {l.steps && <ol style={{ margin: '6px 0 0', paddingLeft: 18 }}>{l.steps.map((s, i) => <li key={i}>{s.name}: {s.status}{s.detail ? ` — ${s.detail}` : ''}</li>)}</ol>}
            </div>
          ))}
        </Dialog>
      )}
      {dlg !== null && (
        <Dialog title="Turn on this automation?" onClose={() => setDlg(null)} foot={<>
          <button className="btn" onClick={() => setDlg(null)}>Cancel</button>
          <button className="btn" onClick={() => void arm(false)}>Only new matches</button>
          <button className="btn danger solid" onClick={() => void arm(true)}>Send the {dlg} now too</button>
        </>}>
          <div><b>{dlg} record{dlg === 1 ? '' : 's'}</b> already match the trigger. Do you want to run the actions for {dlg === 1 ? 'it' : 'them'} as well, or only for records that start matching from now on?</div>
        </Dialog>
      )}
    </div>
  );
}

/** "New automation": a preset (its connections are filled in from what is set up), or a blank one. */
function NewDialog({ conns, templates, onClose, onCreated }: { conns: ConnectionRow[]; templates: TemplateRow[]; onClose: () => void; onCreated: (id: string) => void }) {
  const [preset, setPreset] = useState<PresetId>('ready-to-post');
  const [tpl, setTpl] = useState(templates[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const usesTemplate = preset === 'article' || preset === 'product-reviewed' || preset === 'product-published';
  const website = conns.find(isWebsite);
  const buffer = conns.find((c) => c.provider === 'buffer');
  const gemini = conns.find((c) => c.provider === 'gemini');
  // the synced posts table of the Content pipeline ('' = none yet); null while it is read
  const [postsTable, setPostsTable] = useState<string | null>(null);
  useEffect(() => { void getSetting<{ syncTable?: string }>('pipeline.config', {}).then((c) => setPostsTable(c?.syncTable ?? '')); }, []);
  const needs = (p: PresetId): string | null => {
    if (p === 'post-approved') {
      if (!buffer) return 'Add a Buffer account first (Settings → Connections).';
      if (postsTable === '') return 'Turn on “Sync posts to a table” on the Content pipeline page first; this automation reads that table.';
    }
    if ((p === 'article' || p === 'product-reviewed' || p === 'product-published') && !website) return 'Add a website connection first (Settings → Websites and HTTP connections).';
    if (p === 'ready-to-post' && !buffer) return 'Add a Buffer account first (Settings → Connections).';
    if ((p === 'article' || p === 'product-reviewed' || p === 'product-published') && !gemini) return 'Add a Gemini key first (Settings → Connections); the Gemini step is left empty until then.';
    return null;
  };
  const create = async () => {
    setBusy(true);
    const ensure = async (name: string): Promise<string> => {
      const found = allTables().find((t) => t.name === name);
      if (found) return found.id;
      return (await createTable(name)).id;
    };
    const articlesTable = preset === 'article' ? await ensure('Website articles') : '';
    const productsTable = preset === 'product-reviewed' || preset === 'product-published' ? await ensure('Website products') : '';
    const built = presetAutomation(preset, {
      websiteId: website?.id ?? '', bufferId: buffer?.id ?? '', geminiId: gemini?.id ?? '',
      articlesTable, productsTable, templateId: usesTemplate ? tpl : '', channel: firstChannelOf(buffer),
      postsTable: postsTable ?? '', windowFrom: dateKey(new Date()), windowTo: dateKey(new Date(Date.now() + 14 * 86_400_000)),
    });
    const id = uid();
    await db.automations.put({ ...built, id, created_at: Date.now(), updated_at: Date.now(), fired: {} });
    setBusy(false);
    onCreated(id);
  };
  const blocked = needs(preset);
  return (
    <Dialog title="New automation" onClose={onClose} size="mid" foot={<>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn primary" disabled={busy} onClick={() => void create()}>Create</button>
    </>}>
      <div className="col" style={{ gap: 8 }} role="radiogroup" aria-label="Preset">
        {(Object.keys(PRESET_LABEL) as PresetId[]).map((p) => (
          <label key={p} className="chk" style={{ alignItems: 'flex-start' }}>
            <input type="radio" name="preset" checked={preset === p} onChange={() => setPreset(p)} />
            <span>{PRESET_LABEL[p]}{needs(p) && p !== 'blank' ? <span className="muted small"> — {needs(p)}</span> : null}</span>
          </label>
        ))}
      </div>
      {usesTemplate && (
        <label className="fld" style={{ marginTop: 10, maxWidth: 420 }}><span>Template for the render step</span>
          <select aria-label="Template for the render step" value={tpl} onChange={(e) => setTpl(e.target.value)}>
            <option value="">No render step</option>
            {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </label>
      )}
      {blocked && <div className="callout warn" style={{ marginTop: 8 }}>{blocked} You can still create it and choose the connection in the editor.</div>}
      <div className="small muted" style={{ marginTop: 8 }}>A new automation is off until you turn it on.</div>
    </Dialog>
  );
}

const firstChannelOf = (c: ConnectionRow | undefined): string => (c ? channelProps(c)[0]?.key ?? '' : '');

export default function AutomationsPage() {
  const autos = useLiveQuery(async () => (await db.automations.toArray()).sort((x, y) => x.created_at - y.created_at), [], undefined);
  // undefined until the database has answered: a preset must never be built from a list that has not loaded yet
  const conns = useLiveQuery(() => db.connections.toArray(), [], undefined as ConnectionRow[] | undefined);
  const templates = useLiveQuery(() => db.templates.toArray(), [], [] as TemplateRow[]);
  const [sel, setSel] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [running, setRunning] = useState(true);
  useEffect(() => { void getSetting<boolean>('automations.running', true).then(setRunning); }, []);
  const list = autos ?? [];
  const current = list.find((a) => a.id === sel) ?? list[0];
  const summary = (a: AutomationRow) => {
    const names: Names = { connection: (id) => (conns ?? []).find((c) => c.id === id)?.name ?? '', table: (id) => (id ? tableName(id) : ''), template: () => '', channel: (k) => channelLabelOf(k) };
    return triggerSummary(a.trigger, names);
  };
  return (
    <div className="page" style={{ overflow: 'auto' }}>
      <div className="page-head">
        <h1>Automations</h1><span className="muted">When something happens, then do these steps — like Airtable</span><span className="grow" />
        <button className={`btn ${running ? '' : 'danger'}`} aria-pressed={!running} onClick={async () => { await setSetting('automations.running', !running); setRunning(!running); notify('info', running ? 'All automations paused.' : 'Automations resumed.'); }}>
          {running ? <><Pause size={14} /> Pause all</> : <><Play size={14} /> Resume all</>}
        </button>
        <button className="btn primary" disabled={conns === undefined} onClick={() => setCreating(true)}><Plus size={15} /> New automation</button>
      </div>
      <div className="callout">Record automations are evaluated while DCE is open (when you open it, it catches up). Website automations run when the website reports their event. Posts are created in Buffer with their publish time, and Buffer publishes them on schedule even after you close DCE.</div>
      {list.length === 0 ? (
        <Empty title="No automations yet" icon={<Zap size={26} />}>Example: <i>when Status is “Ready to post”, create a Buffer post 30 minutes later, then set Status to “Posted”.</i><div style={{ marginTop: 8 }}><button className="btn primary" onClick={() => setCreating(true)}>Create the first automation</button></div></Empty>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '260px minmax(0, 1fr)', gap: 12, alignItems: 'start' }}>
          <div className="panel" role="list" aria-label="Automations">
            {list.map((a) => (
              <button key={a.id} role="listitem" className={`layer ${current?.id === a.id ? 'sel' : ''}`} style={{ minHeight: 44, width: '100%', border: 0, textAlign: 'left' }} onClick={() => setSel(a.id)}>
                <Zap size={14} color={a.enabled ? '#1f7a4d' : '#94a3b8'} /><span className="nm"><b>{a.name}</b><br /><span className="muted small">{summary(a)} · {a.enabled ? 'on' : 'off'}</span></span>
              </button>
            ))}
          </div>
          {current && conns !== undefined && <Editor key={current.id} a={current} conns={conns} templates={templates ?? []} />}
        </div>
      )}
      {creating && conns !== undefined && <NewDialog conns={conns} templates={templates ?? []} onClose={() => setCreating(false)} onCreated={(id) => { setSel(id); setCreating(false); }} />}
    </div>
  );
}
