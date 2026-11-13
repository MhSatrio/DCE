/**
 * Content pipeline end to end: a mock website (sitemap, robots.txt, pages), a mock Gemini API and a mock Buffer API, with the
 * REAL local relay and the REAL app in Chromium. Nothing here touches the internet, a real key or a real social account.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { check, dump, eq, ok, report, waitIdle } from './helpers.mjs';
import { launch } from './lib.mjs';

const GEMINI_KEY = 'AIzaSyMOCK-gemini-key-for-tests-0000';
const BUFFER_KEY = 'MOCK-BUFFER-KEY-pipeline-1111';
const CHANNEL = 'chan_facebook_test_001';

// ------------------------------------------------------------------------------------------------ mock website
const hits = [];
const site = { down: false };
const para = (t) => `<p>${t}</p>`;
const body = (title, extra = '') => `<!doctype html><html><head><title>${title} | Mock Lab</title>
  <meta property="og:title" content="${title}"><meta property="og:description" content="A short description of ${title}.">
  <meta property="og:image" content="/img/${title.replace(/\W+/g, '-')}.jpg"></head><body><nav><p>NAVJUNK</p></nav><main><h1>${title}</h1>
  ${para(`${title} explains how a laboratory team can keep its equipment records tidy and traceable from day one of a project.`)}
  ${para('Good records list who used each instrument, when it was last serviced and which procedure applies. Teams that write this down find problems early.')}
  ${para('A typical checklist has 12 items and takes about 15 minutes to review each month. It is meant for teaching and planning, not for clinical decisions.')}
  ${extra}</main><footer><p>FOOTERJUNK</p></footer></body></html>`;
const PAGES = {
  '/articles/members/vault': { lm: '2026-11-12', html: body('Members only') },
  '/articles/thin': { lm: '2026-11-11', html: '<html><head><title>Thin</title></head><body><p>Too short.</p></body></html>' },
  '/articles/delta': { lm: '2026-11-10', html: body('Delta note', para('VERIFYFAIL marker sentence that the reviewer will dislike.')) },
  '/articles/p1': { lm: '2026-11-09', html: body('First guide') },
  '/articles/gamma': { lm: '2026-11-08', html: body('Gamma note', para('CLAIMY marker: this page makes the writer overreach.')) },
  '/articles/p2': { lm: '2026-11-07', html: body('Second guide') },
  '/articles/p3': { lm: '2026-11-06', html: body('Third guide') },
  '/articles/p4': { lm: '2026-11-05', html: body('Fourth guide') },
  '/articles/p5': { lm: '2026-11-04', html: body('Fifth guide') },
  '/articles/p6': { lm: '2026-11-03', html: body('Sixth guide') },
  '/about': { lm: '2026-01-01', html: body('About us') },
};
const siteSrv = createServer((req, res) => {
  const path = (req.url ?? '').split('?')[0];
  hits.push({ path, at: Date.now() });
  const send = (c, t, b) => { res.writeHead(c, { 'content-type': t }); res.end(b); };
  if (path === '/robots.txt') return send(200, 'text/plain', 'User-agent: *\nDisallow: /articles/members/\nSitemap: /sitemap.xml\n');
  if (path === '/sitemap.xml') {
    if (site.down) return send(503, 'text/plain', 'maintenance');
    const base = `http://127.0.0.1:${siteSrv.address().port}`;
    return send(200, 'application/xml', `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${base}/</loc></url>${Object.entries(PAGES).map(([p, v]) => `<url><loc>${base}${p}</loc><lastmod>${v.lm}</lastmod></url>`).join('')}</urlset>`);
  }
  if (PAGES[path]) return send(200, 'text/html; charset=utf-8', PAGES[path].html);
  send(404, 'text/plain', 'nope');
});
await new Promise((r) => siteSrv.listen(0, '127.0.0.1', r));
const SITE = `http://127.0.0.1:${siteSrv.address().port}`;

// ------------------------------------------------------------------------------------------------ mock Gemini
const gem = { calls: [], quotaOnce: false, urls: [], hang: false };
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type,x-goog-api-key', 'access-control-allow-methods': 'POST,GET,OPTIONS' };
const gemSrv = createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  const send = (c, o) => { res.writeHead(c, { 'content-type': 'application/json', ...cors }); res.end(JSON.stringify(o)); };
  gem.urls.push(req.url);
  if (req.headers['x-goog-api-key'] !== GEMINI_KEY) return send(400, { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'API key not valid. Please pass a valid API key.' } });
  if (req.method === 'GET' && (req.url ?? '').startsWith('/v1beta/models')) return send(200, { models: [
    { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-2.5-flash-lite', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-2.5-pro', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-3-flash-preview', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/embedding-001', supportedGenerationMethods: ['embedContent'] },
  ] });
  // Google no longer serves gemini-2.5-flash to new keys — this is the message the real API returned
  if ((req.url ?? '').includes('models/gemini-2.5-flash:')) return send(404, { error: { code: 404, status: 'NOT_FOUND', message: 'This model models/gemini-2.5-flash is no longer available to new users. Please update your code to use models/gemini-3.8-flash.' } });
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => {
    const j = JSON.parse(b || '{}');
    const system = j.systemInstruction?.parts?.[0]?.text ?? '';
    const user = j.contents?.[0]?.parts?.[0]?.text ?? '';
    gem.calls.push({ system, user, url: req.url });
    if (gem.hang) return; // a request that never gets an answer (used to test Stop)
    if (gem.quotaOnce) { gem.quotaOnce = false; return send(429, { error: { code: 429, message: 'Resource has been exhausted (e.g. check quota).' } }); }
    const reply = (text) => send(200, { candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] });
    if (system.includes('fact-checker')) {
      return reply(JSON.stringify(user.includes('VERIFYFAIL') ? { ok: false, issues: ['“VERIFYFAIL marker” is not a fact the page supports.'] } : { ok: true, issues: [] }));
    }
    const title = /Title: (.*)/.exec(user)?.[1] ?? 'This page';
    const claimy = user.includes('CLAIMY');
    const marker = user.includes('VERIFYFAIL') ? ' VERIFYFAIL' : '';
    reply(JSON.stringify({
      hook: `Tidy records start with ${title}`,
      lines: [claimy ? 'Guaranteed results every single time.' : 'A checklist has 12 items and takes about 15 minutes each month.', `Write down who used each instrument and when.${marker}`],
      cta: 'Read the full page to learn how.', hashtags: ['LabLife', 'Records', 'Science'],
    }));
  });
});
await new Promise((r) => gemSrv.listen(0, '127.0.0.1', r));
const GEMINI = `http://127.0.0.1:${gemSrv.address().port}`;

// ------------------------------------------------------------------------------------------------ mock Buffer + real relay
const buf = { calls: [], status: 200 };
const bufSrv = createServer((req, res) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => {
    const q = JSON.parse(b || '{}').query ?? '';
    buf.calls.push({ auth: req.headers.authorization, q });
    const send = (c, o) => { res.writeHead(c, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (buf.status !== 200) return send(buf.status, { error: 'token expired' });
    if (q.includes('organizations')) return send(200, { data: { account: { organizations: [{ id: 'org1', name: 'Test Org' }] } } });
    if (q.includes('channels(')) return send(200, { data: { channels: [
      { id: CHANNEL, name: 'Facebook Test', service: 'facebook' },
      { id: 'chan_linkedin_new', name: 'Vier Apparatus', service: 'linkedin' },
    ] } });
    if (q.includes('createPost')) { const n = buf.calls.filter((c) => c.q.includes('createPost')).length; return send(200, { data: { createPost: { post: { id: `buf_post_${n}`, dueAt: /dueAt: "([^"]+)"/.exec(q)?.[1] ?? null, text: 'x' } } } }); }
    send(200, { data: {} });
  });
});
await new Promise((r) => bufSrv.listen(0, '127.0.0.1', r));
const relayPort = 19000 + Math.floor(Math.random() * 900);
const relay = spawn(process.execPath, [fileURLToPath(new URL('../../server/relay.mjs', import.meta.url))], {
  env: { ...process.env, RELAY_PORT: String(relayPort), BUFFER_UPSTREAM: `http://127.0.0.1:${bufSrv.address().port}`, DCE_TEST_ALLOW_PRIVATE: '1' }, stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 800));
const RELAY = `http://127.0.0.1:${relayPort}`;
const created = () => buf.calls.filter((c) => c.q.includes('createPost'));

// ------------------------------------------------------------------------------------------------ app helpers
const t = await launch({ viewport: { width: 1500, height: 1000 } });
const { page, errors } = t;
const text = () => page.evaluate(() => document.body.innerText);
const goPipeline = async (tab) => {
  if (!page.url().includes('#/pipeline')) { await page.goto(t.url + '/#/pipeline'); }
  await page.waitForSelector('h1:has-text("Content pipeline")');
  if (tab) await page.getByRole('tab', { name: new RegExp(`^${tab}`) }).click();
};
const posts = async () => (await dump(page, 'posts')).sort((a, b) => a.created_at - b.created_at);
const runs = async () => (await dump(page, 'pipeRuns')).sort((a, b) => a.at - b.at);
const confirmDialog = async (label) => { await page.getByRole('dialog').getByRole('button', { name: label, exact: true }).click(); };
/** Starts a run and waits until it has written its log row and its live panel has gone (it has finished). */
const runNow = async () => {
  await goPipeline('Overview');
  const before = (await runs()).length;
  await page.getByRole('button', { name: 'Run now' }).click();
  // wait for the run's own final status (the log row is written first as "running", and its last write is the final one)
  for (let i = 0; i < 300; i++) {
    const rs = await runs();
    if (rs.length > before && rs.at(-1).status !== 'running') break;
    await page.waitForTimeout(100);
  }
  await waitIdle(page, 300);
};
const setMode = async (title) => { await goPipeline('Overview'); await page.getByRole('radio', { name: title }).click(); };
const cfgOf = async () => (await dump(page, 'settings')).find((s) => s.key === 'pipeline.config')?.value ?? {};
const stateOf = async () => (await dump(page, 'settings')).find((s) => s.key === 'pipeline.state')?.value ?? {};

// ------------------------------------------------------------------------------------------------ setup
await check('settings: Buffer account with a channel, relay URL, and the Gemini key is encrypted at rest', async () => {
  await page.goto(t.url + '/#/settings');
  await page.waitForSelector('text=Connections');
  await page.getByRole('button', { name: /Add account/ }).click();
  await page.getByRole('dialog').getByLabel('Account name').fill('test-account@example.com');
  await page.getByRole('dialog').getByLabel('API key').fill(BUFFER_KEY);
  await page.getByRole('dialog').getByRole('button', { name: 'Add account' }).click();
  await page.waitForSelector('text=/API key encrypted/');
  await page.getByLabel('Property name').fill('BUFFER_CHANNEL_ID_FACEBOOK_TEST');
  await page.getByLabel('Property value').fill(CHANNEL);
  await page.getByRole('button', { name: /^Add$/ }).click();
  await page.waitForSelector('[data-testid="secret-BUFFER_CHANNEL_ID_FACEBOOK_TEST"]');
  // a channel that Buffer no longer has (must be flagged, not silently used)
  await page.getByLabel('Property name').fill('BUFFER_CHANNEL_ID_OLD');
  await page.getByLabel('Property value').fill('chan_removed_old');
  await page.getByRole('button', { name: /^Add$/ }).click();
  await page.waitForSelector('[data-testid="secret-BUFFER_CHANNEL_ID_OLD"]');
  await page.getByLabel('Relay URL').fill(RELAY);
  await page.getByLabel('Relay URL').blur();
  await page.getByRole('button', { name: 'Check relay' }).click();
  await page.waitForSelector('text=/Relay is running/');
  // Gemini: a WRONG key first
  await page.getByLabel('Gemini API key').fill('WRONG-KEY-123');
  await page.getByRole('button', { name: 'Save key' }).click();
  await page.waitForSelector('text=/Gemini key saved/');
  const rows = await dump(page, 'connections');
  const g = rows.find((r) => r.provider === 'gemini');
  ok(g && g.props[0].key === 'GEMINI_API_KEY' && g.props[0].enc.startsWith('v1.'), 'Gemini key stored encrypted (AES-GCM)');
  ok(!JSON.stringify(rows).includes('WRONG-KEY'), 'no plain key in IndexedDB');
  ok(!(await text()).includes('WRONG-KEY'), 'no plain key on screen');
  ok((await page.getByTestId('secret-GEMINI_API_KEY').innerText()).includes('••••'), 'masked');
  eq((await page.getByLabel('Active Buffer account').locator('option').allInnerTexts()), ['test-account@example.com']); // the Gemini entry is not listed as a Buffer account
});

await check('pipeline: first visit seeds PlacidWay + vierapparatus.com; both can be deleted; any website can be added', async () => {
  await goPipeline('Sources');
  await page.waitForSelector('table[aria-label="Sources"]');
  const t0 = await text();
  ok(t0.includes('vierapparatus.com') && t0.includes('PlacidWay'), 'both presets listed');
  const pw = (await dump(page, 'sources')).find((s) => /placidway/i.test(s.baseUrl));
  ok(pw.simulationOnly === true, 'PlacidWay is simulation-only by default');
  await page.getByRole('button', { name: /Delete PlacidWay/ }).click();
  await confirmDialog('Delete');
  await page.waitForFunction(() => !document.body.innerText.includes('PlacidWay (assessment'));
  await page.getByRole('button', { name: /Delete VierApparatus/ }).click();
  await confirmDialog('Delete');
  await page.waitForSelector('text=No source websites');
  eq((await dump(page, 'sources')).length, 0);
  // add the mock website
  await page.getByRole('button', { name: 'Add website' }).click();
  const d = page.getByRole('dialog');
  await d.getByLabel('Website address').fill(SITE);
  await d.getByLabel('Source name').fill('Mock Lab');
  await d.getByLabel('Sitemap or feed').fill(`${SITE}/sitemap.xml`);
  await d.getByLabel('Include patterns').fill('/articles/');
  await d.getByRole('button', { name: 'Add source' }).click();
  await page.waitForSelector('text=Mock Lab');
  const s = (await dump(page, 'sources'))[0];
  eq([s.name, s.include, s.enabled, s.simulationOnly], ['Mock Lab', '/articles/', true, false]);
  // bad address is refused with a message
  await page.getByRole('button', { name: 'Add website' }).click();
  await page.getByRole('dialog').getByLabel('Website address').fill('http://');
  await page.getByRole('dialog').getByRole('button', { name: 'Add source' }).click();
  await page.waitForSelector('text=/Enter a valid website address/');
  await page.keyboard.press('Escape');
});

await check('sources: “Check” reads the sitemap politely and lists the pages that qualify (no AI used)', async () => {
  hits.length = 0; gem.calls.length = 0;
  await page.getByRole('button', { name: 'Check Mock Lab' }).click();
  await page.waitForSelector('text=/10 pages can be used/'); // 10 /articles/ pages (home and /about excluded by the include rule)
  ok((await text()).includes('/articles/members/vault'), 'sample listed');
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).last().click();
  ok(gem.calls.length === 0, 'no Gemini call for a check');
  const src = (await dump(page, 'sources'))[0];
  eq(src.lastCheck.ok, true);
});

await check('pipeline settings: Gemini endpoint (for the mock), simulation is the default, channel chosen', async () => {
  await goPipeline('Overview');
  eq((await cfgOf()).mode ?? 'simulation', 'simulation');
  ok(await page.getByRole('radio', { name: /Simulation/ }).isChecked(), 'simulation selected by default');
  await page.getByLabel('Gemini endpoint').fill(GEMINI);
  await page.getByLabel('Gemini endpoint').blur();
  await page.getByLabel('Facebook · Facebook Test').waitFor();
  await page.getByLabel('Facebook · Facebook Test').click();
  await waitIdle(page, 300);
  eq((await cfgOf()).channels, ['BUFFER_CHANNEL_ID_FACEBOOK_TEST']);
});

// ------------------------------------------------------------------------------------------------ gemini key problems
await check('a wrong Gemini key stops the run with a clear alert, no retry storm, nothing sent', async () => {
  gem.calls.length = 0;
  await runNow();
  ok((await page.getByRole('alert', { name: 'Pipeline alert' }).innerText()).match(/rejected the API key/), 'alert banner explains the key problem');
  ok(await page.getByRole('img', { name: 'Pipeline needs attention' }).count() === 1, 'sidebar dot');
  const r = (await runs()).at(-1);
  eq([r.status, r.trigger], ['failed', 'manual']);
  ok(gem.calls.length === 0 && created().length === 0, 'nothing generated or sent');
  await page.locator('[aria-label="Pipeline alert"] button').click();
  await page.waitForFunction(() => !document.querySelector('[aria-label="Pipeline alert"]'));
});

await check('settings: replace with the right key; “Test key” lists the text models', async () => {
  await page.goto(t.url + '/#/settings');
  await page.getByRole('button', { name: 'Remove key' }).click();
  await confirmDialog('Delete');
  await page.getByLabel('Gemini API key').fill(GEMINI_KEY);
  await page.getByLabel('Gemini API key').press('Enter');
  await page.waitForSelector('[data-testid="secret-GEMINI_API_KEY"]');
  await page.getByRole('button', { name: /Test key/ }).click();
  await page.waitForSelector('text=/Key works/');
  await page.getByTestId('secret-GEMINI_API_KEY').dblclick();
  await page.waitForFunction((k) => document.body.innerText.includes(k), GEMINI_KEY);
  await page.keyboard.press('Escape');
  ok(gem.urls.every((u) => !u.includes(GEMINI_KEY)), 'the key is never put in a URL');
});

// ------------------------------------------------------------------------------------------------ simulation runs
await check('run 1 (simulation): robots-blocked, too-thin and fact-check-failing pages are skipped; one page becomes a simulated post', async () => {
  hits.length = 0; gem.calls.length = 0; gem.quotaOnce = true; buf.calls.length = 0;
  const t0 = Date.now();
  await runNow();
  const ps = await posts();
  const by = (u) => ps.filter((p) => p.url === `${SITE}${u}`);
  eq(by('/articles/members/vault').map((p) => p.status), ['rejected'], 'robots');
  ok(/robots\.txt/.test(by('/articles/members/vault')[0].detail), 'reason mentions robots.txt');
  ok(!hits.some((h) => h.path === '/articles/members/vault'), 'a robots-disallowed page is NEVER requested');
  eq(by('/articles/thin').map((p) => p.status), ['rejected']);
  ok(/too little/.test(by('/articles/thin')[0].detail), 'thin page reason');
  eq(by('/articles/delta').map((p) => p.status), ['rejected']);
  ok(by('/articles/delta')[0].guard.verifier.ok === false, 'rejected by the second model');
  const sim = by('/articles/p1');
  eq(sim.map((p) => p.status), ['simulated']);
  const post = sim[0];
  ok(post.text.includes(`${SITE}/articles/p1`) && /#LabLife #Records #Science$/.test(post.text), 'link and 3–5 hashtags');
  const before = post.text.slice(0, post.text.indexOf(`${SITE}/articles/p1`));
  ok(before.length <= 500, `${before.length} chars before the link`);
  ok(post.guard.rules.every((r) => r.ok) && post.guard.verifier.ok, 'passed both checks');
  ok(post.imageUrl === undefined || post.imageUrl.startsWith('https://'), 'image only when public https (the mock is http → none)');
  ok(created().length === 0, 'SIMULATION never calls Buffer');
  ok(Date.now() - t0 > 2000 && gem.calls.length >= 4, 'the 429 was retried with a pause (and the writer + reviewer both ran)');
  // politeness: never two requests to the site less than 1 s apart
  for (let i = 1; i < hits.length; i++) ok(hits[i].at - hits[i - 1].at >= 950, `${hits[i - 1].path} → ${hits[i].path}: ${hits[i].at - hits[i - 1].at} ms`);
  ok(!/NAVJUNK|FOOTERJUNK/.test(post.sourceExcerpt), 'page furniture is not shown to the model');
  ok(gem.calls.every((c) => !c.user.includes('NAVJUNK')), 'nothing but the article text reaches Gemini');
});

await check('posts tab: the simulated post shows its text, the checks that passed and what would have been sent', async () => {
  await goPipeline('Posts');
  const card = page.getByLabel('Post: First guide');
  ok(await card.count() === 1, 'card');
  const txt = await card.innerText();
  ok(/simulated/.test(txt) && /✓ structure/.test(txt) && /✓ claims/.test(txt) && /✓ fact-check/.test(txt) && /nothing was sent/i.test(txt), txt.slice(0, 200));
});

await check('run 2 (simulation): the guardrail rejects an overreaching draft three times, then the next page is used — never the same URL twice', async () => {
  gem.calls.length = 0;
  await runNow();
  const ps = await posts();
  const gamma = ps.filter((p) => p.url.endsWith('/articles/gamma'));
  eq(gamma.map((p) => p.status), ['rejected']);
  eq(gamma[0].guard.attempts, 3);
  ok(gamma[0].guard.rules.some((r) => r.rule === 'claims' && !r.ok), 'claims rule fired');
  ok(gem.calls.some((c) => /rejected for these reasons/.test(c.user) && /guaranteed/i.test(c.user)), 'the writer got the reasons and tried again');
  const sims = ps.filter((p) => p.status === 'simulated').map((p) => p.url.replace(SITE, ''));
  eq(sims, ['/articles/p1', '/articles/p2']);
  eq(new Set(ps.filter((p) => p.status !== 'failed').map((p) => p.url)).size, ps.filter((p) => p.status !== 'failed').length, 'no URL twice');
  ok(created().length === 0, 'still nothing sent');
});

// ------------------------------------------------------------------------------------------------ approval mode
await check('model: “Refresh model list” shows what the key can use; a retired model gives a clear alert; Auto fixes it', async () => {
  await goPipeline('Overview');
  await page.getByRole('button', { name: /Refresh model list/ }).click();
  await page.waitForSelector('text=/models loaded from Google/');
  const opts = await page.getByLabel('Gemini model').locator('option').allInnerTexts();
  ok(opts.includes('gemini-3.8-flash') && opts.includes('gemini-2.5-pro') && !opts.some((o) => /embedding/.test(o)), opts.join(', '));
  eq(await page.getByLabel('Gemini model').inputValue(), 'auto', 'Auto is the default');
  await page.getByLabel('Gemini model').selectOption('gemini-2.5-flash');
  await waitIdle(page, 300);
  eq((await cfgOf()).model, 'gemini-2.5-flash');
  const n = (await posts()).length;
  await runNow();
  const banner = await page.getByRole('alert', { name: 'Pipeline alert' }).innerText();
  ok(/no longer available to new users/.test(banner) && /pick Auto or another model/.test(banner), banner);
  eq((await posts()).length, n, 'nothing written with the retired model');
  await page.locator('[aria-label="Pipeline alert"] button').click();
  await page.getByLabel('Gemini model').selectOption('auto');
  await waitIdle(page, 300);
  await runNow();
  const last = (await posts()).at(-1);
  eq([last.status, last.model], ['simulated', 'gemini-3.8-flash']);
  ok(await page.getByRole('alert', { name: 'Pipeline alert' }).count() === 0, 'alert cleared by the successful run');
  ok(gem.urls.some((u) => u.includes('models/gemini-2.5-flash:generateContent')) && gem.urls.some((u) => u.includes('models/gemini-3.8-flash:generateContent')), 'both models were called');
});

await check('channels: the list comes from Buffer — named; a new channel is saved by itself; a removed one is flagged and can be removed; ids stay hidden', async () => {
  await goPipeline('Overview');
  await page.waitForSelector('text=/no longer in Buffer/');
  ok(await page.getByLabel('Facebook · Facebook Test').count() === 1, 'the saved channel is shown by service and name');
  ok(await page.getByLabel('LinkedIn · Vier Apparatus').count() === 1, 'the new LinkedIn channel appears without any click');
  const conn = (await dump(page, 'connections')).find((c) => c.provider === 'buffer');
  ok(conn.props.some((p) => p.key === 'BUFFER_CHANNEL_ID_LINKEDIN_VIER_APPARATUS' && p.meta?.service === 'linkedin'), 'the new channel is saved with its name');
  const raw = JSON.stringify(await dump(page, 'connections'));
  ok(!raw.includes(CHANNEL) && !raw.includes('chan_linkedin_new'), 'channel ids are stored encrypted, not in plain text');
  ok(!(await text()).includes(CHANNEL), 'channel ids are not shown on screen');
  await page.locator('.chan-row.stale').getByRole('button', { name: 'Remove' }).click();
  for (let i = 0; i < 30; i++) {
    const keys = (await dump(page, 'connections')).find((c) => c.provider === 'buffer').props.map((p) => p.key);
    if (!keys.includes('BUFFER_CHANNEL_ID_OLD')) break;
    await page.waitForTimeout(150);
  }
  ok(!(await dump(page, 'connections')).find((c) => c.provider === 'buffer').props.some((p) => p.key === 'BUFFER_CHANNEL_ID_OLD'), 'the flagged channel was removed');
});

await check('a run can be watched and stopped: live stages, the log survives leaving the page, Stop cancels at once, and the next run starts at once', async () => {
  gem.hang = true;
  await goPipeline('Overview');
  await page.getByRole('button', { name: 'Run now' }).click();
  const panel = page.getByLabel('Pipeline run in progress');
  await panel.waitFor();
  await panel.getByText(/Draft 1: asking the writer model/).first().waitFor({ timeout: 15000 });
  ok(await page.getByRole('button', { name: 'Run now' }).count() === 0, 'no second run can be started while one is going');
  await page.evaluate(() => { location.hash = '#/settings'; });
  await page.waitForSelector('[aria-label="Content pipeline running"]');
  ok((await text()).includes('Content pipeline running'), 'the banner shows on another page');
  await page.evaluate(() => { location.hash = '#/pipeline'; });
  await panel.waitFor();
  ok((await page.locator('.run-log li').count()) >= 3, 'the log is still there after leaving the page');
  await panel.getByRole('button', { name: 'Stop run' }).click();
  await page.waitForSelector('text=/Run stopped/', { timeout: 5000 });
  await page.waitForSelector('[aria-label="Pipeline run in progress"]', { state: 'detached', timeout: 5000 });
  gem.hang = false;
  let last = null;
  for (let i = 0; i < 40; i++) { last = (await runs()).at(-1); if (last?.status === 'cancelled') break; await page.waitForTimeout(100); }
  eq([last.status, last.detail], ['cancelled', 'Stopped by you.']);
  const before = (await runs()).length;
  await runNow();
  const after = await runs();
  ok(after.length === before + 1 && after.at(-1).status !== 'cancelled', 'a new run started and was not blocked');
  ok(!(await text()).includes('already in progress'), 'no "already in progress" message');
});

await check('approval mode: the post waits; nothing reaches Buffer until Approve; then it is created in the chosen channel', async () => {
  await setMode(/Approval/);
  await runNow();
  eq(created().length, 0);
  await goPipeline('Posts');
  const pend = (await posts()).filter((p) => p.status === 'pending');
  eq(pend.length, 1);
  eq(pend[0].url, `${SITE}/articles/p1`); // simulated pages are not "used" once real publishing is on
  await page.getByRole('button', { name: 'Approve and send' }).click();
  await confirmDialog('Approve and send');
  for (let i = 0; i < 40 && created().length < 1; i++) await page.waitForTimeout(200);
  eq(created().length, 1);
  const q = created()[0];
  ok(q.auth === `Bearer ${BUFFER_KEY}` && q.q.includes(`channelId: "${CHANNEL}"`) && q.q.includes('mode: addToQueue'), 'right key, channel and queue mode');
  const stored = (await posts()).find((p) => p.status === 'sent');
  ok(q.q.includes(JSON.stringify(stored.text).slice(1, 40)), 'the stored text is what was sent');
  ok(stored.channels[0].postId === 'buf_post_1', 'Buffer post id recorded');
});

await check('approval mode: an edit that breaks a guardrail cannot be sent; a clean edit can', async () => {
  await runNow();
  await goPipeline('Posts');
  await page.getByRole('tab', { name: /^Needs approval/ }).click();
  const card = page.getByLabel('Post: Second guide');
  await card.getByRole('button', { name: /Edit text/ }).click();
  const ta = card.getByLabel('Edit post text');
  const orig = await ta.inputValue();
  await ta.fill(orig.replace('Tidy records', 'Guaranteed tidy records'));
  await card.getByRole('button', { name: 'Save text' }).click();
  await page.waitForSelector('text=/breaks a rule/');
  const n = created().length;
  await card.getByRole('button', { name: 'Approve and send' }).click();
  await confirmDialog('Approve and send');
  await page.waitForSelector('text=/Not sent — the text breaks a guardrail/');
  eq(created().length, n, 'Buffer untouched');
  await card.getByRole('button', { name: /Edit text/ }).click();
  await card.getByLabel('Edit post text').fill(orig.replace('Tidy records', 'Neat records'));
  await card.getByRole('button', { name: 'Save text' }).click();
  await page.waitForSelector('text=/passes the rule check/');
  await card.getByRole('button', { name: 'Approve and send' }).click();
  await confirmDialog('Approve and send');
  for (let i = 0; i < 40 && created().length < n + 1; i++) await page.waitForTimeout(200);
  eq(created().length, n + 1);
  ok(created().at(-1).q.includes('Neat records'), 'the edited text was sent');
});

await check('approval mode: Reject removes the page from the rotation for good', async () => {
  await runNow();
  await goPipeline('Posts');
  await page.getByRole('tab', { name: /^Needs approval/ }).click();
  const url = (await posts()).find((p) => p.status === 'pending').url;
  await page.getByRole('button', { name: 'Reject post' }).click();
  await page.waitForSelector('text=/Post rejected/');
  eq((await posts()).find((p) => p.url === url && p.status === 'rejected').detail, 'Rejected by the reviewer.');
});

// ------------------------------------------------------------------------------------------------ auto mode + failures
await check('auto-publish with a fixed publish time: the post is created in Buffer with that time', async () => {
  await setMode(/Auto-publish/);
  await confirmDialog('Use auto-publish');
  await page.getByLabel('Publish timing').selectOption('time');
  await page.getByLabel('Publish time').fill('23:30');
  await waitIdle(page, 300);
  const n = created().length;
  await runNow();
  eq(created().length, n + 1);
  const q = created().at(-1).q;
  ok(/mode: customScheduled, dueAt: "\d{4}-\d\d-\d\dT[\d:.]+Z"/.test(q), q.slice(0, 200));
  const sent = (await posts()).filter((p) => p.status === 'sent').at(-1);
  ok(sent.channels[0].dueAt, 'due time stored');
  const r = (await runs()).at(-1);
  eq([r.status, r.postStatus, r.postId], ['ok', 'sent', `buf_post_${created().length}`]);
});

await check('Buffer token expired: the run fails fast with an alert that says what to do, and the page is not lost', async () => {
  buf.status = 401;
  const before = (await posts()).length;
  await runNow();
  const banner = await page.getByRole('alert', { name: 'Pipeline alert' }).innerText();
  ok(/Buffer rejected the API key/.test(banner), banner);
  const failed = (await posts()).filter((p) => p.status === 'failed');
  eq(failed.length, 1);
  ok((await posts()).length === before + 1, 'one failed record');
  buf.status = 200;
  await page.locator('[aria-label="Pipeline alert"] button').click();
  await runNow(); // the failed page is tried again (failed ≠ used) and now goes through
  const ps = await posts();
  ok(ps.some((p) => p.url === failed[0].url && p.status === 'sent'), 'the same page was sent on the next run');
  ok(!(await text()).includes('Needs attention'), 'alert cleared by the successful run');
});

await check('source marked “simulation only” is never sent, even in auto-publish mode', async () => {
  await goPipeline('Sources');
  await page.getByLabel('Simulation only Mock Lab').click();
  await waitIdle(page, 300);
  const n = created().length;
  await runNow();
  eq(created().length, n);
  const last = (await posts()).at(-1);
  eq(last.status, 'simulated');
  await goPipeline('Sources');
  await page.getByLabel('Simulation only Mock Lab').click();
  await waitIdle(page, 200);
});

await check('site down: a clear alert, retries are bounded, and nothing is generated', async () => {
  site.down = true; gem.calls.length = 0;
  await runNow(); // 503 → two retries (3 s + 8 s) then fail
  const banner = await page.getByRole('alert', { name: 'Pipeline alert' }).innerText();
  ok(/could not be read/.test(banner) && /503/.test(banner), banner);
  const r = (await runs()).at(-1);
  ok(r.steps.some((s) => /Retrying/.test(s)), 'retried');
  ok(gem.calls.length === 0, 'no AI call when the site is down');
  site.down = false;
  await page.locator('[aria-label="Pipeline alert"] button').click();
});

await check('when every page was used: “Nothing new to post” is reported, not a duplicate post', async () => {
  await setMode(/Simulation/);
  for (let i = 0; i < 8; i++) {
    const before = (await posts()).length;
    await runNow();
    if ((await posts()).length === before) break;
  }
  const banner = await page.getByRole('alert', { name: 'Pipeline alert' }).innerText();
  ok(/Nothing new to post/.test(banner), banner);
  const live = (await posts()).filter((p) => ['sent', 'pending', 'simulated'].includes(p.status));
  const urls = live.filter((p) => p.status !== 'simulated').map((p) => p.url);
  eq(new Set(urls).size, urls.length, 'no real post twice');
  await page.locator('[aria-label="Pipeline alert"] button').click();
});

// ------------------------------------------------------------------------------------------------ schedule, deliverables, safety
await check('daily schedule: runs by itself once, after the chosen time, and records it as a scheduled run', async () => {
  await page.getByRole('button', { name: 'Clear simulated' }).click().catch(async () => { await goPipeline('Posts'); await page.getByRole('button', { name: 'Clear simulated' }).click(); });
  await confirmDialog('Delete');
  await waitIdle(page, 400);
  await goPipeline('Overview');
  await page.getByLabel('Daily run time').fill('00:00');
  await page.getByLabel('Daily schedule enabled').click();
  for (let i = 0; i < 90 && !(await runs()).some((r) => r.trigger === 'schedule'); i++) await page.waitForTimeout(500);
  await waitIdle(page, 1500);
  const st = await stateOf();
  ok(st.done === true, JSON.stringify(st) + ' | ' + JSON.stringify((await runs()).slice(-3).map((r) => [r.trigger, r.status, new Date(r.at).toISOString(), r.detail.slice(0, 50)])) + ' | ' + JSON.stringify((await dump(page, 'settings')).filter((x) => x.key.startsWith('pipeline')).map((x) => x.key)) + ' ' + new Date().toISOString());
  await page.waitForTimeout(22000); // a full extra loop interval: it must not run twice in a day
  eq((await runs()).filter((r) => r.trigger === 'schedule').length, 1);
  await page.getByLabel('Daily schedule enabled').click();
});

await check('deliverables: sample posts (.md with real source URLs) and the workflow export without any secret', async () => {
  await goPipeline('Posts');
  const [md] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export posts' }).click()]);
  const mdText = (await import('node:fs')).readFileSync(await md.path(), 'utf8');
  ok(mdText.includes(`${SITE}/articles/`) && /Guardrails: .*structure ✓/.test(mdText), mdText.slice(0, 200));
  const [wf] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export workflow' }).click()]);
  const wfText = (await import('node:fs')).readFileSync(await wf.path(), 'utf8');
  const j = JSON.parse(wfText);
  eq(j.format, 'dce-content-pipeline');
  ok(!wfText.includes(GEMINI_KEY) && !wfText.includes(BUFFER_KEY) && !wfText.includes(CHANNEL), 'no secrets in the export');
  eq(j.sources.map((s) => s.name), ['Mock Lab']);
});

await check('relay /fetch refuses hosts that are not configured sources, and non-http schemes', async () => {
  const f = (u, hosts) => fetch(`${RELAY}/fetch`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:4173' }, body: JSON.stringify({ url: u, hosts }) }).then((r) => r.json());
  eq((await f(`${SITE}/about`, ['example.com'])).blocked, 'host');
  eq((await f('file:///C:/Windows/win.ini', ['127.0.0.1'])).blocked, 'scheme');
  const bad = await fetch(`${RELAY}/fetch`, { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' });
  eq(bad.status, 403);
});

await check('sync: posts are mirrored into a table — one row per post with the pipeline columns; syncing again updates, never duplicates', async () => {
  await goPipeline('Posts');
  await page.getByRole('button', { name: /Create “Social posts” table/ }).click();
  await page.waitForSelector('text=/Table “Social posts” created/');
  const tableId = (await cfgOf()).syncTable;
  ok(!!tableId, 'the sync table is chosen');
  const ps = await posts();
  const rowsOf = async () => (await dump(page, 'rows')).filter((r) => r.table === tableId);
  eq((await rowsOf()).length, ps.length, 'one row per post');
  const labels = { simulated: 'Simulated', pending: 'Needs approval', sent: 'Sent to Buffer', rejected: 'Rejected', failed: 'Failed' };
  const sample = ps.find((p) => p.status === 'simulated') ?? ps[0];
  const row = (await rowsOf()).find((r) => r.id === sample.id);
  eq([row.data.name, row.data.status, row.data.source], [sample.title, labels[sample.status], sample.sourceName]);
  const keys = (await dump(page, 'fields')).filter((f) => f.tableId === tableId).map((f) => f.key);
  ok(['name', 'status', 'post_text', 'url', 'post_id'].every((k) => keys.includes(k)), keys.join(', '));
  await page.getByRole('button', { name: 'Sync now' }).click();
  await waitIdle(page, 600);
  eq((await rowsOf()).length, ps.length, 'syncing again keeps one row per post');
  ok(await page.getByRole('link', { name: 'Open the table' }).count() === 1, 'a link opens the table');
});

await check('everything persists across a reload (sources, posts, runs, config)', async () => {
  const n = (await posts()).length;
  await page.reload();
  await page.waitForSelector('.sidebar');
  eq((await posts()).length, n);
  ok((await dump(page, 'sources')).length === 1 && (await dump(page, 'pipeRuns')).length > 8, 'stored');
  eq((await cfgOf()).maxChars, 500);
});

await check('no console errors (other than the expected HTTP error statuses of the failure tests)', async () => {
  const real = errors.filter((e) => !/Failed to load resource/.test(e));
  ok(real.length === 0, real.slice(0, 3).join(' | '));
});

const failed = report();
await t.close(); relay.kill(); siteSrv.close(); gemSrv.close(); bufSrv.close();
process.exit(failed ? 1 : 0);
