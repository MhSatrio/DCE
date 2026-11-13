import { describe, expect, it } from 'vitest';
import {
  automationProblems, channelLabelOf, fillTemplate, flattenPayload, presetAutomation, ruleToAutomation, sourceOfValues, stepChoices, stepProblems,
  triggerChoices, workflowRunToLog, workflowToAutomation, ARTICLE_MAP,
} from '../../src/automation/model';
import { scheduleFor } from '../../src/automation/steps';
import { operationsOf } from '../../src/connector/discover';
import type { ConnectionRow, LegacyAutomationRow, WorkflowRow, WorkflowRunRow } from '../../src/db/schema';

const conn = (over: Partial<ConnectionRow> & { id: string; provider: ConnectionRow['provider'] }, channels: string[] = []): ConnectionRow => ({
  name: over.id, created_at: 1, props: channels.map((k, i) => ({ id: `p${i}`, key: k, secret: true, enc: 'x' })), ...over,
});

describe('templates', () => {
  it('fills fields as text, as a URL part (encoded) and as a JSON string (escaped)', () => {
    const v = { title: 'A "quoted" / slash', n: 3 };
    expect(fillTemplate('Hi {{title}} n={{n}} {{missing}}!', v)).toBe('Hi A "quoted" / slash n=3 !');
    expect(fillTemplate('/items/{{title}}', v, 'url')).toBe('/items/A%20%22quoted%22%20%2F%20slash');
    expect(fillTemplate('{"t": "{{title}}"}', v, 'json')).toBe('{"t": "A \\"quoted\\" / slash"}');
  });

  it('flattens an event payload: nested keys are dot paths, lists are joined', () => {
    const flat = flattenPayload({ title: 'T', author: { name: 'Ana' }, tags: ['a', 'b'], image: null });
    expect(flat).toEqual({ title: 'T', 'author.name': 'Ana', tags: 'a, b', image: '' });
  });

  it('gives Gemini the item text without ids and links', () => {
    const src = sourceOfValues({ id: 'x', name: 'Centrifuge', url: 'https://x', image: 'https://i', shortDescription: 'Benchtop.', limitations: 'small' });
    expect(src.title).toBe('Centrifuge');
    expect(src.url).toBe('https://x');
    expect(src.text).toBe('shortDescription: Benchtop.\nlimitations: small');
  });

  it('names a channel without its prefix', () => {
    expect(channelLabelOf('BUFFER_CHANNEL_ID_INSTAGRAM')).toBe('INSTAGRAM');
    expect(channelLabelOf('BUFFER_CHANNEL_ID')).toBe('default');
  });
});

describe('what a connection allows (the "Then" menu)', () => {
  const buffer = conn({ id: 'b1', provider: 'buffer' }, ['BUFFER_CHANNEL_ID_INSTAGRAM']);
  const bufferNoChannel = conn({ id: 'b2', provider: 'buffer' });
  const gemini = conn({ id: 'g1', provider: 'gemini' });
  const api = conn({ id: 'h1', provider: 'http', kind: 'api' });
  const site = conn({ id: 'w1', provider: 'http', kind: 'website', caps: { checkedAt: 1, scopes: ['events:read', 'jobs:run'], note: 'ok' } });

  it('a connection contributes only its own actions; a website is not an action', () => {
    const choices = stepChoices([buffer, gemini, api, site]);
    const pick = (connectionId: string) => choices.filter((c) => c.value.connectionId === connectionId).map((c) => c.value.kind);
    expect(pick('b1')).toEqual(['buffer_post']);
    expect(pick('g1')).toEqual(['gemini_fill']);
    expect(pick('h1')).toEqual(['http']);
    expect(pick('w1')).toEqual([]);
    expect(pick('')).toEqual(['pipeline_post', 'add_row', 'set_field', 'random_time', 'sync_posts', 'render']);
  });

  it('a Buffer account without a channel is shown but cannot be chosen, with the reason', () => {
    const c = stepChoices([bufferNoChannel]).find((x) => x.value.kind === 'buffer_post')!;
    expect(c.enabled).toBe(false);
    expect(c.reason).toMatch(/channel/i);
  });

  it('the Content pipeline needs Buffer and Gemini', () => {
    expect(stepChoices([buffer]).find((x) => x.value.kind === 'pipeline_post')!.enabled).toBe(false);
    expect(stepChoices([buffer, gemini]).find((x) => x.value.kind === 'pipeline_post')!.enabled).toBe(true);
  });

  it('website events need the events:read permission, and a website that was never tested says so', () => {
    const untested = conn({ id: 'w2', provider: 'http', kind: 'website' });
    const ev = (list: ReturnType<typeof triggerChoices>, connectionId: string) => list.filter((x) => x.value.kind === 'event' && x.value.connectionId === connectionId);
    expect(ev(triggerChoices([untested]), 'w2').every((x) => !x.enabled)).toBe(true);
    expect(ev(triggerChoices([untested]), 'w2')[0].reason).toMatch(/Test connection/);
    expect(ev(triggerChoices([site]), 'w1').every((x) => x.enabled)).toBe(true);
    const noRead = conn({ id: 'w3', provider: 'http', kind: 'website', caps: { checkedAt: 1, scopes: ['jobs:run'], note: '' } });
    expect(ev(triggerChoices([noRead]), 'w3')[0].reason).toMatch(/events:read/);
  });
});

describe('steps and automations: problems are explicit', () => {
  it('a step lists what is missing', () => {
    expect(stepProblems({ kind: 'buffer_post', connectionId: '', channel: '', text: '', timing: { mode: 'queue', delayAmount: 0, delayUnit: 'minutes', pastPolicy: 'skip' } }))
      .toEqual(['Choose the Buffer account.', 'Choose a channel.', 'Write the post text.']);
    expect(stepProblems({ kind: 'gemini_fill', connectionId: 'g', table: 't', prompt: 'no placeholders' })).toEqual(['The prompt needs at least one {{column|what to write}}.']);
  });

  it('an automation needs a website for an event trigger and at least one action', () => {
    expect(automationProblems({ trigger: { kind: 'event', connectionId: '', event: 'article.published' }, steps: [] })).toEqual(['Choose the website.', 'Add at least one action.']);
  });
});

describe('presets', () => {
  const ids = { websiteId: 'w1', bufferId: 'b1', geminiId: 'g1', articlesTable: 'ta', productsTable: 'tp', templateId: '', channel: 'BUFFER_CHANNEL_ID_X' };

  it('the article preset runs the Content pipeline, adds the row, asks Gemini, then syncs (no render without a template)', () => {
    const a = presetAutomation('article', ids);
    expect(a.trigger).toEqual({ kind: 'event', connectionId: 'w1', event: 'article.published' });
    expect(a.steps.map((s) => s.kind)).toEqual(['pipeline_post', 'add_row', 'gemini_fill', 'sync_posts']);
    const add = a.steps[1];
    expect(add.kind === 'add_row' && add.mapping).toEqual(ARTICLE_MAP);
    expect(Object.values(ARTICLE_MAP).every((v) => v.startsWith('{{') && v.endsWith('}}'))).toBe(true);
    expect(presetAutomation('article', { ...ids, templateId: 'tpl' }).steps.at(-1)).toEqual({ kind: 'render', table: 'ta', templateId: 'tpl', format: 'png' });
  });

  it('the Buffer preset is a record rule: Ready to post → post in 30 minutes → Status = Posted', () => {
    const a = presetAutomation('ready-to-post', ids);
    expect(a.trigger.kind).toBe('record');
    expect(a.steps[0]).toMatchObject({ kind: 'buffer_post', connectionId: 'b1', channel: 'BUFFER_CHANNEL_ID_X', timing: { mode: 'delay', delayAmount: 30, delayUnit: 'minutes' } });
    expect(a.steps[1]).toEqual({ kind: 'set_field', table: 'content', field: 'status', value: 'Posted' });
  });

  it('a blank automation is off and empty', () => {
    const a = presetAutomation('blank', ids);
    expect(a.enabled).toBe(false);
    expect(a.steps).toEqual([]);
  });
});

describe('earlier shapes become automations (migration)', () => {
  it('a table rule keeps its filter, its Buffer settings and its after-send field change', () => {
    const legacy = {
      id: 'r1', name: 'Post when ready', table: 'content', enabled: true, created_at: 5,
      filter: { join: 'and', conditions: [{ id: 'c', field: 'status', op: 'eq', value: 'Ready to post' }] },
      connectionId: '', fired: { x: { at: 1, n: 1, last: 1, done: true } },
      action: { channel: 'BUFFER_CHANNEL_ID_IG', text: '{{title}}', mode: 'delay', delayAmount: 30, delayUnit: 'minutes', pastPolicy: 'skip', setField: 'status', setValue: 'Posted', resultField: 'post' },
    } as unknown as LegacyAutomationRow;
    const a = ruleToAutomation(legacy, 'b-active', 99);
    expect(a.trigger).toEqual({ kind: 'record', table: 'content', filter: legacy.filter });
    expect(a.steps[0]).toMatchObject({ kind: 'buffer_post', connectionId: 'b-active', channel: 'BUFFER_CHANNEL_ID_IG', resultField: 'post', timing: { mode: 'delay', delayAmount: 30 } });
    expect(a.steps[1]).toEqual({ kind: 'set_field', table: 'content', field: 'status', value: 'Posted' });
    expect(a.fired).toEqual(legacy.fired);
    expect(a.id).toBe('r1');
  });

  it('a website workflow keeps its event, its order and its settings; its run log becomes one history row', () => {
    const wf: WorkflowRow = {
      id: 'w1', name: 'Article', enabled: true, connectionId: 'site', trigger: 'article.published', created_at: 1, updated_at: 1,
      steps: [
        { kind: 'text_post' },
        { kind: 'add_row', tableId: 'ta', mapping: { name: 'title', image: 'image' } },
        { kind: 'ai_fill', tableId: 'ta', prompt: 'Hook: {{hook|one line}}' },
        { kind: 'batch_render', tableId: 'ta', templateId: 'tpl', format: 'png' },
      ],
    };
    const a = workflowToAutomation(wf, 'gem', 9);
    expect(a.trigger).toEqual({ kind: 'event', connectionId: 'site', event: 'article.published' });
    expect(a.steps.map((s) => s.kind)).toEqual(['pipeline_post', 'add_row', 'gemini_fill', 'render']);
    expect(a.steps[1]).toMatchObject({ kind: 'add_row', mapping: { name: '{{title}}', image: '{{image}}' } });
    expect(a.steps[2]).toMatchObject({ kind: 'gemini_fill', connectionId: 'gem' });
    const run: WorkflowRunRow = { id: 'r', workflowId: 'w1', workflowName: 'Article', eventId: 1, eventType: 'article.published', entityId: 'a1', title: 'Hello', at: 3, status: 'failed', detail: 'Stopped', steps: [{ name: 'Write', status: 'failed', detail: 'x' }] };
    expect(workflowRunToLog(run)).toMatchObject({ automationId: 'w1', status: 'failed', recordTitle: 'Hello', steps: [{ name: 'Write', status: 'failed', detail: 'x' }] });
  });
});

describe('schedules', () => {
  const NOW = new Date('2026-11-06T10:00:00').getTime();
  it('a delay counts from now, a date without a time means 09:00, a passed time follows the policy', () => {
    expect(scheduleFor({ mode: 'delay', delayAmount: 1, delayUnit: 'hours', pastPolicy: 'skip' }, undefined, undefined, NOW)).toEqual({ mode: 'scheduled', dueAt: new Date(NOW + 3_600_000).toISOString() });
    expect(scheduleFor({ mode: 'field', delayAmount: 0, delayUnit: 'minutes', pastPolicy: 'skip' }, '2026-11-07', 'Day', NOW)).toEqual({ mode: 'scheduled', dueAt: new Date('2026-11-07T09:00').toISOString() });
    expect(scheduleFor({ mode: 'field', delayAmount: 0, delayUnit: 'minutes', pastPolicy: 'skip' }, '2026-11-01', 'Day', NOW)).toEqual({ skip: 'The chosen time (2026-11-01) has already passed.' });
    expect(scheduleFor({ mode: 'field', delayAmount: 0, delayUnit: 'minutes', pastPolicy: 'queue' }, '2026-11-01', 'Day', NOW)).toEqual({ mode: 'queue' });
  });
});

describe('an API description (OpenAPI) becomes the operations the editor offers', () => {
  it('lists each method and path with its summary, and nothing that is not an operation', () => {
    const ops = operationsOf({ paths: { '/items': { get: { summary: 'List items' }, post: { operationId: 'createItem' }, parameters: [] }, '/items/{id}': { delete: {} } } });
    expect(ops).toEqual([
      { method: 'GET', path: '/items', summary: 'List items' },
      { method: 'POST', path: '/items', summary: 'createItem' },
      { method: 'DELETE', path: '/items/{id}', summary: '' },
    ]);
    expect(operationsOf({ nope: true })).toEqual([]);
  });
});
