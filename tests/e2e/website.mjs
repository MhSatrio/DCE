/**
 * The website connector end to end: a mock website (its connector API, an article page), a mock Gemini API, the REAL local
 * relay (with test-only access to the loopback mock) and the REAL app in Chromium. Nothing here reaches the internet, a real
 * site, a real key or a real social account.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { check, dump, eq, ok, report, waitIdle } from './helpers.mjs';
import { launch } from './lib.mjs';

const GEMINI_KEY = 'AIzaSyMOCK-gemini-key-for-website-test-0000';
const TOKEN = 'vca_e2e_token_for_dce_connector_test_000001';

// ------------------------------------------------------------------------------------------------ mock website
const site = { reports: [], statuses: [], claimed: new Set(), requests: [] };
const events = [
  {
    id: 1, createdAt: '2026-11-13T08:00:00.000Z', type: 'article.published', entityId: 'a1',
    payload: {
      id: 'a1', slug: 'hello-connector', title: 'Hello from the connector', excerpt: 'A short excerpt about the connector test article.',
      url: '', category: 'Microbiology', tags: ['test'], author: 'Master Admin', publishedAt: '2026-11-13T08:00:00.000Z',
      image: '', body: 'Paragraph one of the article body. It explains the connector in plain words.',
    },
  },
  {
    id: 2, createdAt: '2026-11-13T08:05:00.000Z', type: 'product.reviewed', entityId: 'p1',
    payload: { id: 'p1', name: 'Benchtop centrifuge', url: '', manufacturer: 'Example Maker', category: 'Centrifuges', shortDescription: 'A benchtop centrifuge.', reviewStatus: 'reviewed' },
  },
];
const ARTICLE_PATH = '/articles/hello-connector';
let SITE = '';
const pageHtml = () => `<!doctype html><html lang="en"><head><title>Hello from the connector</title>
  <meta property="og:title" content="Hello from the connector"><meta property="og:description" content="A short excerpt about the connector test article.">
  </head><body><nav><p>NAVJUNK</p></nav><main><h1>Hello from the connector</h1>
  <p>Paragraph one of the article body. It explains the connector in plain words, so a reader can see how a website reports new articles to the desktop app.</p>
  <p>Paragraph two adds more detail. The workflow reads this page, writes a short social post with a link back to it, and keeps the article in a table with a summary written from the text.</p>
  <p>Paragraph three closes the article. Nothing in it is a medical claim, and every statement is taken from this page.</p>
  </main><footer><p>FOOTERJUNK</p></footer></body></html>`;

const siteSrv = createServer((req, res) => {
  const u = new URL(req.url ?? '/', 'http://x');
  const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (u.pathname === ARTICLE_PATH) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(pageHtml()); }
  if (!u.pathname.startsWith('/api/connector/v1/')) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found'); }
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { ok: false, error: 'unauthorized' });
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const b = body ? JSON.parse(body) : {};
    site.requests.push(`${req.method} ${u.pathname}${u.search}`);
    if (u.pathname === '/api/connector/v1/ping') return send(200, { ok: true, site: 'MockSite', api: 1, siteUrl: SITE, token: 'e2e', scopes: ['events:read', 'jobs:run'] });
    if (u.pathname === '/api/connector/v1/events') {
      const after = Number(u.searchParams.get('after') ?? 0);
      const list = events.filter((e) => e.id > after);
      return send(200, { ok: true, events: list, next: list.length ? list[list.length - 1].id : after });
    }
    if (u.pathname === '/api/connector/v1/status') { site.statuses.push(b); return send(200, { ok: true }); }
    if (u.pathname === '/api/connector/v1/jobs/claim') {
      const jobs = [
        { id: 'job_replay_1', type: 'replay_event', payload: { event: events[0] } },
        { id: 'job_post_1', type: 'run_text_post', payload: { event: events[0] } },
      ].filter((j) => !site.claimed.has(j.id));
      for (const j of jobs) site.claimed.add(j.id);
      return send(200, { ok: true, jobs });
    }
    const m = /^\/api\/connector\/v1\/jobs\/([^/]+)\/report$/.exec(u.pathname);
    if (m) { site.reports.push({ id: m[1], ...b }); return send(200, { ok: true }); }
    return send(404, { ok: false, error: 'not_found' });
  });
});
await new Promise((r) => siteSrv.listen(0, '127.0.0.1', r));
SITE = `http://127.0.0.1:${siteSrv.address().port}`;
events[0].payload.url = `${SITE}${ARTICLE_PATH}`;
events[0].payload.image = `${SITE}/images/hello.jpg`;
events[1].payload.url = `${SITE}/products/benchtop-centrifuge`;

// ------------------------------------------------------------------------------------------------ mock Gemini
const gem = { hang: false, calls: 0 };
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type,x-goog-api-key', 'access-control-allow-methods': 'POST,GET,OPTIONS' };
const gemSrv = createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  const send = (c, o) => { res.writeHead(c, { 'content-type': 'application/json', ...cors }); res.end(JSON.stringify(o)); };
  if (req.headers['x-goog-api-key'] !== GEMINI_KEY) return send(400, { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'API key not valid. Please pass a valid API key.' } });
  if (req.method === 'GET' && (req.url ?? '').startsWith('/v1beta/models')) return send(200, { models: [
    { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] },
  ] });
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => {
    const j = JSON.parse(b || '{}');
    const system = j.systemInstruction?.parts?.[0]?.text ?? '';
    gem.calls++;
    if (gem.hang) return; // never answers (used by nothing in this file; kept for symmetry with the pipeline test)
    const reply = (obj) => send(200, { candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] }, finishReason: 'STOP' }] });
    if (system.includes('fact-checker')) return reply({ ok: true, issues: [] });
    if (system.includes('fill the columns')) return reply({ summary: 'Mock summary of the article.', hook: 'Mock hook line for the article.' });
    return reply({ hook: 'A connector test for a website', lines: ['Line one about the topic.', 'Line two with a plain value.'], cta: 'Read more on the site.', hashtags: ['Science', 'Lab', 'Records'] });
  });
});
await new Promise((r) => gemSrv.listen(0, '127.0.0.1', r));
const GEMINI = `http://127.0.0.1:${gemSrv.address().port}`;

// ------------------------------------------------------------------------------------------------ real relay (test mode: loopback allowed)
const relayPort = 19400 + Math.floor(Math.random() * 500);
const relay = spawn(process.execPath, [fileURLToPath(new URL('../../server/relay.mjs', import.meta.url))], {
  env: { ...process.env, RELAY_PORT: String(relayPort), BUFFER_UPSTREAM: 'http://127.0.0.1:9', DCE_TEST_ALLOW_PRIVATE: '1' }, stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 800));
const RELAY = `http://127.0.0.1:${relayPort}`;

// ------------------------------------------------------------------------------------------------ app helpers
const t = await launch({ viewport: { width: 1500, height: 1000 } });
const { page, errors } = t;
const text = () => page.evaluate(() => document.body.innerText);
const conns = async () => (await dump(page, 'connections')).filter((c) => c.provider === 'http');
const automations = async () => dump(page, 'automations');
const runsOf = async () => (await dump(page, 'autoRuns')).sort((a, b) => a.at - b.at);
const tableNamed = async (name) => (await dump(page, 'userTables')).find((x) => x.name === name);
const statusOf = async (connId) => (await dump(page, 'settings')).find((s) => s.key === `connector.status.${connId}`)?.value ?? null;

// ------------------------------------------------------------------------------------------------ setup
await check('setup: the relay address, the Gemini key (encrypted) and the Gemini endpoint of the test', async () => {
  await page.goto(t.url + '/#/settings');
  await page.waitForSelector('text=Connections');
  await page.getByLabel('Relay URL').fill(RELAY);
  await page.getByLabel('Relay URL').blur();
  await page.getByLabel('Gemini API key').fill(GEMINI_KEY);
  await page.getByRole('button', { name: 'Save key' }).click();
  await page.waitForSelector('text=/Gemini key saved/');
  ok(!JSON.stringify(await dump(page, 'connections')).includes(GEMINI_KEY), 'the Gemini key is not stored in plain text');
  await page.goto(t.url + '/#/pipeline');
  await page.getByLabel('Gemini endpoint').fill(GEMINI);
  await page.getByLabel('Gemini endpoint').blur();
  await waitIdle(page, 400);
  eq((await dump(page, 'settings')).find((s) => s.key === 'pipeline.config')?.value?.geminiBase, GEMINI);
});

await check('a website connection is added (token encrypted) and the test confirms its permissions', async () => {
  await page.goto(t.url + '/#/settings');
  await page.getByRole('button', { name: 'Add a website or API connection' }).click();
  const d = page.getByRole('dialog');
  await d.getByLabel('Connection name').fill('Mock website');
  await d.getByLabel('Connection address').fill(SITE);
  await d.getByLabel('Token value').fill(TOKEN);
  await d.getByRole('button', { name: 'Save connection' }).click();
  await page.waitForSelector('text=/Connection saved/');
  const c = (await conns())[0];
  eq([c.props.find((p) => p.key === 'KIND') ? 'ok' : 'missing'], ['ok']);
  ok(c.props.find((p) => p.key === 'AUTH_VALUE').enc.startsWith('v1.'), 'the token is stored encrypted');
  ok(!JSON.stringify(await dump(page, 'connections')).includes(TOKEN), 'the token is not stored in plain text');
  ok(!(await text()).includes(TOKEN), 'the token is not shown on screen');
  await page.getByRole('button', { name: 'Test connection', exact: true }).click();
  await page.waitForSelector('text=/Connected to MockSite/');
  ok((await text()).includes('events:read'), 'the permissions are listed');
});

await check('an automation is created from the article preset (with its template), its five actions are listed, and it is switched on', async () => {
  await page.goto(t.url + '/#/automations');
  await page.getByRole('button', { name: 'New automation' }).click();
  const d = page.getByRole('dialog');
  await d.getByRole('radio', { name: /Website article published/ }).check();
  await d.getByLabel('Template for the render step').selectOption({ label: 'Product Announcement' });
  await d.getByRole('button', { name: 'Create', exact: true }).click();
  await page.getByLabel('Automation name').waitFor();
  for (let i = 1; i <= 5; i++) ok(await page.getByLabel(`Action ${i}`, { exact: true }).count() === 1, `action ${i} is listed`);
  await page.getByLabel('Automation enabled').click();
  await waitIdle(page, 400);
  const a = (await automations())[0];
  ok(a.enabled === true, `the automation is switched on (on screen: ${(await page.locator('.callout.warn').allInnerTexts()).join(' | ')}; stored: ${JSON.stringify(a).slice(0, 300)})`);
  eq([a.enabled, a.trigger.kind, a.trigger.event, a.steps.map((s) => s.kind)], [true, 'event', 'article.published', ['pipeline_post', 'add_row', 'gemini_fill', 'sync_posts', 'render']]);
});

// ------------------------------------------------------------------------------------------------ the first check
await check('check now: the article event runs the workflow (post, row, Gemini fill, sync, render); the jobs are done; the status is reported', async () => {
  await page.goto(t.url + '/#/settings');
  await page.getByRole('button', { name: 'Check now' }).click();
  const c = (await conns())[0];
  for (let i = 0; i < 400; i++) {
    const rs = await runsOf();
    const st = await statusOf(c.id);
    if (rs.length >= 2 && rs.every((r) => r.status !== 'running') && st) break;
    await page.waitForTimeout(250);
  }
  const st = await statusOf(c.id);
  ok(st && st.ok === true, `the check finished: ${JSON.stringify(st)}`);
  const runs = await runsOf();
  eq(runs.map((r) => r.status), ['sent', 'sent'], 'the event run and the replayed job both finished');
  const first = runs[0];
  eq(first.steps.map((s) => s.status), ['ok', 'ok', 'ok', 'ok', 'ok'], 'every step of the first run is ok');
  const table = await tableNamed('Website articles');
  const rows = (await dump(page, 'rows')).filter((r) => r.table === table.id);
  // a website item's row id is derived from the event (one row per item and table)
  const row = rows.find((r) => r.id.startsWith('article.published:a1'));
  ok(row, 'the article is a row of the table');
  eq([row.data.name, row.data.summary, row.data.hook], ['Hello from the connector', 'Mock summary of the article.', 'Mock hook line for the article.']);
  ok((await dump(page, 'posts')).some((p) => p.url === events[0].payload.url), 'the text post was written for the article page');
  const jobs = await dump(page, 'jobs');
  ok(jobs.some((j) => j.status === 'completed' && j.templateName === 'Product Announcement'), 'the batch render ran and completed');
  const reports = Object.fromEntries(site.reports.map((r) => [r.id, r]));
  eq(reports.job_replay_1?.status, 'done', 'the replay job was reported done');
  eq(reports.job_post_1?.status, 'done', 'the post job was reported done');
  ok(/already has a post/.test(reports.job_post_1.result), `the post job says why nothing new was written: ${reports.job_post_1.result}`);
  ok(site.statuses.some((s) => s.version && s.cursor === 2), 'the status (version, cursor) was reported to the website');
});

await check('check again: nothing is repeated (the cursor moved on, no new run, no duplicate row, no second post)', async () => {
  const c = (await conns())[0];
  const runsBefore = (await runsOf()).length;
  const rowsBefore = (await dump(page, 'rows')).length;
  const postsBefore = (await dump(page, 'posts')).length;
  await page.getByRole('button', { name: 'Check now' }).click();
  for (let i = 0; i < 120; i++) {
    const st = await statusOf(c.id);
    if (st && /0 new event/.test(st.message)) break;
    await page.waitForTimeout(250);
  }
  eq((await runsOf()).length, runsBefore, 'no workflow ran again');
  eq((await dump(page, 'rows')).length, rowsBefore, 'no duplicate row');
  eq((await dump(page, 'posts')).length, postsBefore, 'no second post');
  eq((await statusOf(c.id)).events, 0);
});

await check('the history shows each run, and each step with its detail', async () => {
  await page.goto(t.url + '/#/automations');
  await page.getByLabel('Automations').getByRole('listitem').first().click();
  await page.waitForSelector('text=History');
  await page.locator('details summary').first().click();
  const log = await text();
  ok(/Hello from the connector/.test(log), 'the item is in the history');
  ok(/Write and check a post/.test(log) && /Ask Gemini and fill columns/.test(log), 'the steps are listed with their names');
});

await check('no console errors during the whole session', async () => {
  const real = errors.filter((e) => !/Failed to load resource/.test(e));
  ok(real.length === 0, real.slice(0, 3).join(' | '));
});

const failed = report();
await t.close();
relay.kill();
siteSrv.close();
gemSrv.close();
process.exit(failed ? 1 : 0);
