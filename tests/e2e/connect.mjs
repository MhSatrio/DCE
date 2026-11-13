/** Tables, links / synced fields, encrypted connections and Buffer automations — against a mock Buffer API and the real relay. */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { check, dump, eq, ok, report, waitIdle } from './helpers.mjs';
import { launch } from './lib.mjs';

// ---------------------------------------------------------------- mock Buffer (GraphQL) + the real relay in front of it
const KEY1 = 'TbDy6ILkhgiaMOjfAF-KB-Jbmk2OmuaUapSSmock1';
const KEY2 = 'SECOND-ACCOUNT-KEY-mock2';
const CH_IG = '6ae1e52c2f1f5ed648fb1519';
const calls = [];
const mock = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const auth = req.headers.authorization ?? '';
    const q = JSON.parse(body || '{}').query ?? '';
    calls.push({ auth, q });
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (![`Bearer ${KEY1}`, `Bearer ${KEY2}`].includes(auth)) return send(401, { error: 'bad key' });
    if (q.includes('organizations')) return send(200, { data: { account: { organizations: [{ id: 'org1', name: 'Vier' }] } } });
    if (q.includes('channels(')) return send(200, { data: { channels: [{ id: CH_IG, name: 'vierapparatus', service: 'instagram' }, { id: '6ae1e57a2f1f5ed648fb1a6c', name: 'Vier Apparatus', service: 'linkedin' }] } });
    if (q.includes('createPost')) {
      if (q.includes('FAIL')) return send(200, { data: { createPost: { message: 'Channel is disconnected' } } });
      const n = calls.filter((c) => c.q.includes('createPost')).length;
      return send(200, { data: { createPost: { post: { id: `post_${n}`, dueAt: /dueAt: "([^"]+)"/.exec(q)?.[1] ?? null, text: 'x' } } } });
    }
    send(200, { data: {} });
  });
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const mockPort = mock.address().port;
const relayPort = 18000 + Math.floor(Math.random() * 1000);
const relay = spawn(process.execPath, [fileURLToPath(new URL('../../server/relay.mjs', import.meta.url))], { env: { ...process.env, RELAY_PORT: String(relayPort), BUFFER_UPSTREAM: `http://127.0.0.1:${mockPort}` }, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));
const RELAY = `http://127.0.0.1:${relayPort}`;

const t = await launch({ viewport: { width: 1600, height: 950 } });
const { page, errors } = t;
const text = () => page.evaluate(() => document.body.innerText);
const posts = () => calls.filter((c) => c.q.includes('createPost'));

// ---------------------------------------------------------------- relay safety
await check('relay: health, CORS only for local origins, upstream fixed, key required', async () => {
  const h = await fetch(`${RELAY}/health`).then((r) => r.json());
  eq(h.ok, true);
  const bad = await fetch(`${RELAY}/buffer`, { method: 'POST', headers: { origin: 'https://evil.example', authorization: 'Bearer x', 'content-type': 'application/json' }, body: '{}' });
  eq(bad.status, 403);
  const noKey = await fetch(`${RELAY}/buffer`, { method: 'POST', headers: { origin: 'http://localhost:5173', 'content-type': 'application/json' }, body: '{}' });
  eq(noKey.status, 401);
  const pre = await fetch(`${RELAY}/buffer`, { method: 'OPTIONS', headers: { origin: 'http://127.0.0.1:4173', 'access-control-request-method': 'POST' } });
  eq(pre.headers.get('access-control-allow-origin'), 'http://127.0.0.1:4173');
  const other = await fetch(`${RELAY}/anything-else`, { method: 'POST', headers: { authorization: 'Bearer x' } });
  eq(other.status, 404);
});

// ---------------------------------------------------------------- connections
await check('connections: add an account — the API key is encrypted at rest and never printed on screen', async () => {
  await page.goto(t.url + '/#/settings');
  await page.waitForSelector('text=Connections');
  await page.getByRole('button', { name: /Add account/ }).click();
  await page.getByRole('dialog').getByLabel('Account name').fill('satrio666sto@gmail.com');
  await page.getByRole('dialog').getByLabel('API key').fill(KEY1);
  await page.getByRole('dialog').getByRole('button', { name: 'Add account' }).click();
  await page.waitForSelector('text=/API key encrypted/');
  const rows = await dump(page, 'connections');
  eq(rows.length, 1);
  const raw = JSON.stringify(rows);
  ok(!raw.includes(KEY1) && !raw.includes('TbDy6IL'), 'plain key must not be in IndexedDB');
  ok(rows[0].props[0].enc.startsWith('v1.'), 'AES-GCM token stored');
  ok(!(await text()).includes('TbDy6IL'), 'plain key must not be on screen');
  ok((await page.getByTestId('secret-BUFFER_API_KEY').innerText()).includes('••••'), 'masked');
});

await check('connections: double-click reveals for a moment; blur hides; right-click offers copy / replace / delete', async () => {
  const cell = page.getByTestId('secret-BUFFER_API_KEY');
  await cell.dblclick();
  await page.waitForFunction((k) => document.body.innerText.includes(k), KEY1);
  await page.keyboard.press('Escape');
  await page.waitForFunction((k) => !document.body.innerText.includes(k), KEY1);
  await cell.click({ button: 'right' });
  const items = await page.getByRole('menu', { name: /BUFFER_API_KEY options/ }).getByRole('menuitem').allInnerTexts();
  ok(['Reveal', 'Copy', 'Replace', 'Delete'].every((w) => items.some((i) => i.startsWith(w))), items.join('|'));
  await page.keyboard.press('Escape');
  await page.mouse.click(5, 300);
});

await check('connections: channel ids are encrypted + hidden too; two accounts and a picker to switch', async () => {
  await page.getByLabel('Property name').fill('BUFFER_CHANNEL_ID_INSTAGRAM');
  await page.getByLabel('Property value').fill(CH_IG);
  await page.getByRole('button', { name: /^Add$/ }).click();
  await page.waitForSelector('[data-testid="secret-BUFFER_CHANNEL_ID_INSTAGRAM"]');
  ok(!JSON.stringify(await dump(page, 'connections')).includes(CH_IG), 'channel id not in plain text');
  ok(!(await text()).includes(CH_IG), 'channel id not on screen');
  await page.getByRole('button', { name: /Add account/ }).click();
  await page.getByRole('dialog').getByLabel('Account name').fill('second@example.com');
  await page.getByRole('dialog').getByLabel('API key').fill(KEY2);
  await page.getByRole('dialog').getByRole('button', { name: 'Add account' }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('select[aria-label="Active Buffer account"] option')].some((o) => o.textContent === 'second@example.com'));
  const picker = page.getByLabel('Active Buffer account');
  await picker.selectOption({ label: 'second@example.com' });
  await waitIdle(page, 300);
  const second = (await dump(page, 'connections')).find((c) => c.name === 'second@example.com');
  eq((await dump(page, 'settings')).find((s) => s.key === 'connections.active.buffer').value, second.id);
  ok(await page.getByTestId('secret-BUFFER_CHANNEL_ID_INSTAGRAM').count() === 0, 'the other account has its own properties');
  await picker.selectOption({ label: 'satrio666sto@gmail.com' });
  await page.waitForSelector('[data-testid="secret-BUFFER_CHANNEL_ID_INSTAGRAM"]');
});

await check('connections: relay check and “test connection” list the real channels through the relay', async () => {
  await page.getByLabel('Relay URL').fill(RELAY);
  await page.getByRole('button', { name: 'Check relay' }).click();
  await page.waitForSelector('text=/Relay is running/');
  await page.getByRole('button', { name: /Test connection/ }).click();
  await page.waitForSelector('text=/Channels of satrio666sto@gmail.com/');
  ok((await text()).includes('instagram') && (await text()).includes('linkedin'), 'channels listed');
  ok(!(await text()).includes(CH_IG), 'their ids are not displayed');
  ok(calls.some((c) => c.auth === `Bearer ${KEY1}`), 'the account key reached Buffer (via the relay)');
  await page.getByRole('button', { name: 'Add all as properties' }).click();
  // the Instagram channel was saved by hand before (same id): it is recognised and NOT added a second time
  await page.waitForSelector('text=/1 channel added/');
  await page.waitForSelector('[data-testid="secret-BUFFER_CHANNEL_ID_LINKEDIN_VIER_APPARATUS"]');
  const acct = (await dump(page, 'connections')).find((c) => c.name === 'satrio666sto@gmail.com');
  eq(acct.props.filter((p) => /INSTAGRAM/.test(p.key)).length, 1, 'no duplicate Instagram channel');
});

// ---------------------------------------------------------------- tables, links, synced fields
await check('tables: create a custom table from the sidebar; add a Currency field with the + header button', async () => {
  await page.goto(t.url + '/#/content');
  await page.waitForSelector('.vgrid-row');
  await page.getByRole('button', { name: 'New table' }).click();
  await page.getByRole('dialog').getByLabel('Table name').fill('Suppliers');
  await page.getByRole('button', { name: 'Create table' }).click();
  await page.waitForSelector('h1:has-text("Suppliers")');
  eq((await dump(page, 'userTables')).map((x) => x.name), ['Suppliers']);
  await page.getByRole('button', { name: 'Add field' }).click();
  await page.getByRole('dialog').getByLabel('Name', { exact: true }).fill('Price');
  await page.getByRole('radio', { name: 'Currency' }).click();
  await page.getByLabel('Currency symbol').fill('Rp');
  await page.getByRole('button', { name: 'Create field' }).click();
  await page.waitForSelector('text=/Field “Price” created/');
  const f = (await dump(page, 'fields')).find((x) => x.label === 'Price');
  eq([f.type, f.currency, typeof f.tableId], ['currency', 'Rp', 'string']);
});

await check('tables: rows are edited like a spreadsheet; every Airtable-style field type can be created', async () => {
  await page.getByRole('button', { name: 'New row' }).click();
  await page.waitForSelector('.vgrid-row');
  await page.locator('.vgrid-row').first().locator('[role=gridcell]').nth(0).dblclick();
  await page.getByLabel('Name').last().fill('Acme Lab');
  await page.keyboard.press('Enter');
  await page.locator('.vgrid-row').first().locator('[role=gridcell]').nth(1).dblclick();
  await page.getByLabel('Price').last().fill('1200');
  await page.keyboard.press('Enter');
  await waitIdle(page, 300);
  const row = (await dump(page, 'rows'))[0];
  eq([row.data.name, row.data.price], ['Acme Lab', 1200]);
  for (const [label, type, extra] of [['Contact', 'Email'], ['Phone', 'Phone number'], ['Quality', 'Rating'], ['Active', 'Checkbox'], ['Since', 'Date & time'], ['Kind', 'Single select'], ['Created', 'Created time'], ['No.', 'Auto number']]) {
    await page.getByRole('button', { name: 'Add field' }).click();
    await page.getByRole('dialog').getByLabel('Name', { exact: true }).fill(label);
    const radio = page.getByRole('radio', { name: type === 'Checkbox' ? 'Boolean' : type, exact: true });
    await radio.click();
    if (type === 'Single select') await page.getByLabel('Options (comma separated)').fill('Reagents, Equipment');
    await page.getByRole('button', { name: 'Create field' }).click();
    await page.waitForSelector(`text=/Field “${label.replace('.', '\\.')}” created/`);
  }
  const types = (await dump(page, 'fields')).filter((x) => x.tableId).map((x) => x.type);
  for (const k of ['email', 'phone', 'rating', 'boolean', 'datetime', 'select', 'createdTime', 'autonumber']) ok(types.includes(k), `${k} created`);
  const r2 = (await dump(page, 'rows'))[0];
  eq(r2.data.no, undefined); // existing rows are not back-filled; new rows get numbers
  await page.getByRole('button', { name: 'New row' }).click();
  await waitIdle(page, 300);
  const nums = (await dump(page, 'rows')).map((r) => r.data.no).filter(Boolean);
  eq(nums, [1]);
  ok((await dump(page, 'rows')).every((r) => r.id), 'rows stored in their own store, not in Content Plan');
  eq((await dump(page, 'records')).filter((r) => r.table).length, 0);
});

await check('link fields are two-sided; a synced field mirrors in BOTH directions', async () => {
  // Suppliers: link to Content Plan
  await page.getByRole('button', { name: 'Add field' }).click();
  await page.getByRole('dialog').getByLabel('Name', { exact: true }).fill('Products');
  await page.getByRole('radio', { name: 'Link to another table' }).click();
  await page.getByLabel('Linked table').selectOption({ label: 'Content Plan' });
  await page.getByRole('button', { name: 'Create field' }).click();
  await page.waitForSelector('text=/Linked to “Content Plan”/');
  const fields = await dump(page, 'fields');
  const a = fields.find((f) => f.label === 'Products' && f.tableId), b = fields.find((f) => f.type === 'link' && !f.tableId);
  ok(b && b.label === 'Suppliers' && b.linkTable === a.tableId && b.inverseKey === a.key && a.inverseKey === b.key, 'inverse field created in the Content Plan');
  // link the first supplier row to a product through the cell editor
  const cols = await page.locator('.vhead[role=columnheader]').allInnerTexts();
  const ci = cols.findIndex((c) => c.startsWith('Products'));
  await page.locator('.vgrid-row').first().locator('[role=gridcell]').nth(ci).dblclick();
  await page.getByRole('checkbox', { name: 'Laboratory Centrifuge' }).check();
  await page.getByRole('button', { name: 'Save links' }).click();
  await waitIdle(page, 400);
  const sup = (await dump(page, 'rows')).find((r) => r.data.name === 'Acme Lab');
  const prod = (await dump(page, 'records')).find((r) => r.title === 'Laboratory Centrifuge');
  eq(sup.data[a.key], [prod.id]);
  eq(prod.data[b.key], [sup.id]); // the other side was filled in automatically
  // Content Plan: synced field mirroring Suppliers → Price
  await page.goto(t.url + '/#/content');
  await page.waitForSelector('.vgrid-row');
  await page.getByRole('button', { name: 'Add field' }).click();
  await page.getByRole('dialog').getByLabel('Name', { exact: true }).fill('Supplier price');
  await page.getByRole('radio', { name: 'Synced field' }).click();
  await page.getByLabel('Link field').selectOption({ index: 0 });
  await page.getByLabel('Source field').selectOption({ label: 'Price (Currency)' });
  await page.getByRole('button', { name: 'Create field' }).click();
  await page.waitForSelector('text=/Synced field “Supplier price” created/');
  const sp = (await dump(page, 'fields')).find((f) => f.label === 'Supplier price');
  ok(sp.sync && sp.type === 'currency', 'sync field takes the source type');
  const read = async () => (await dump(page, 'records')).find((r) => r.title === 'Laboratory Centrifuge').data[sp.key];
  eq(await read(), 1200);                                     // initial mirror
  // change in table A (Suppliers) → table B (Content Plan) follows
  await page.goto(t.url + '/#/table/' + a.tableId);
  await page.waitForSelector('.vgrid-row');
  await page.locator('.vgrid-row').first().locator('[role=gridcell]').nth(1).dblclick();
  await page.getByLabel('Price').last().fill('1500');
  await page.keyboard.press('Enter');
  await waitIdle(page, 400);
  eq(await read(), 1500);
  // change the synced copy in the Content Plan → the Suppliers row follows (write-through)
  await page.goto(t.url + '/#/content');
  await page.waitForSelector('.vgrid-row');
  await page.getByLabel('Search records').fill('Laboratory Centrifuge');
  await page.waitForTimeout(400);
  const heads = await page.locator('.vhead[role=columnheader]').allInnerTexts();
  const si = heads.findIndex((h) => h.startsWith('Supplier price'));
  await page.locator('.vgrid-row').first().locator('[role=gridcell]').nth(si).dblclick();
  await page.getByLabel('Supplier price').last().fill('1700');
  await page.keyboard.press('Enter');
  await waitIdle(page, 500);
  eq((await dump(page, 'rows')).find((r) => r.data.name === 'Acme Lab').data.price, 1700);
  eq(await read(), 1700);
  await page.getByLabel('Search records').fill('');
});

await check('deleting a link field warns about what depends on it and removes the inverse + synced copies', async () => {
  const heads = await page.locator('.vhead[role=columnheader]').allInnerTexts();
  const hi = heads.findIndex((h) => h.startsWith('Suppliers'));
  await page.locator('.vhead[role=columnheader]').nth(hi).click({ button: 'right' });
  await page.getByRole('menuitem', { name: /Delete field/ }).click();
  const body = await page.getByRole('dialog').innerText();
  ok(/Supplier price/.test(body) && /Products/.test(body), 'dependents listed: ' + body.slice(0, 160));
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await page.waitForSelector('text=/Field deleted/');
  const labels = (await dump(page, 'fields')).map((f) => f.label);
  ok(!labels.includes('Supplier price') && !labels.includes('Products') && !labels.includes('Suppliers'), 'all three removed: ' + labels.join());
});

// ---------------------------------------------------------------- automations
const setStatus = async (title, status) => {
  await page.goto(t.url + '/#/content');
  await page.waitForSelector('.vgrid-row');
  await page.getByLabel('Search records').fill(title);
  await page.waitForTimeout(400);
  await page.locator('.vgrid-row').first().locator('[role=gridcell]').nth(1).dblclick();
  await page.getByLabel('Status').last().selectOption(status);
  await waitIdle(page, 300);
  await page.getByLabel('Search records').fill('');
};

// "New automation" → a preset (the first time: the empty-state button) → Create. Returns when the editor is open.
const newAutomation = async (preset) => {
  await page.goto(t.url + '/#/automations');
  await page.getByRole('button', { name: /New automation|Create the first automation/ }).first().click();
  const d = page.getByRole('dialog');
  await d.getByRole('radio', { name: new RegExp(preset) }).check();
  await d.getByRole('button', { name: 'Create', exact: true }).click();
  await page.getByLabel('Automation name').waitFor();
};

await check('automation: “when Status = Ready to post → Buffer post 30 minutes later, then Status = Posted”', async () => {
  await newAutomation('Ready to post');
  await page.getByLabel('Automation name').fill('Instagram when ready');
  const opts = await page.getByLabel('Channel', { exact: true }).locator('option').allTextContents();
  ok(opts.some((o) => /INSTAGRAM/.test(o)) && !(await text()).includes(CH_IG), 'channels come from the account, ids stay hidden');
  await page.getByLabel('Channel', { exact: true }).selectOption('BUFFER_CHANNEL_ID_INSTAGRAM');
  await page.getByLabel('Post text').fill('New: {{title}} — {{description}}');
  await page.getByLabel('Delay amount').fill('30');
  const auto = (await dump(page, 'automations'))[0];
  eq(
    [auto.trigger.kind, auto.trigger.filter.conditions[0].field, auto.trigger.filter.conditions[0].value, auto.steps.map((s) => s.kind), auto.steps[1].field, auto.steps[1].value],
    ['record', 'status', 'Ready to post', ['buffer_post', 'set_field'], 'status', 'Posted'],
  );
  // dry run: nothing matches yet → nothing sent
  await page.getByRole('button', { name: /Dry run/ }).click();
  await page.waitForSelector('text=/No record needed handling/');
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).last().click();
  await page.getByLabel('Automation enabled').click();
  await page.waitForSelector('text=/Automation is on/');
  eq(posts().length, 0);
});

await check('automation fires when a record starts matching: exact payload, scheduled 30 min ahead, status → Posted, logged, not repeated', async () => {
  const before = Date.now();
  await setStatus('Laboratory Centrifuge', 'Ready to post');
  await page.waitForFunction(() => true);
  const t0 = Date.now();
  while (posts().length === 0 && Date.now() - t0 < 15000) await new Promise((r) => setTimeout(r, 300));
  eq(posts().length, 1);
  const p = posts()[0];
  eq(p.auth, `Bearer ${KEY1}`);
  ok(p.q.includes(`channelId: "${CH_IG}"`), 'channel id decrypted at send time');
  ok(p.q.includes('Laboratory Centrifuge') && p.q.includes('Benchtop centrifuge'), 'fields merged into the text');
  ok(p.q.includes('mode: customScheduled'), 'scheduled mode');
  const due = Date.parse(/dueAt: "([^"]+)"/.exec(p.q)[1]);
  ok(Math.abs(due - (before + 30 * 60_000)) < 3 * 60_000, `dueAt ≈ now + 30 min (off by ${Math.round((due - before - 1.8e6) / 1000)} s)`);
  await waitIdle(page, 1500);
  const rec = (await dump(page, 'records')).find((r) => r.title === 'Laboratory Centrifuge');
  eq(rec.status, 'Posted');
  const run = (await dump(page, 'autoRuns')).find((r) => r.status === 'sent');
  ok(run && run.postId === 'post_1', 'logged with the Buffer post id');
  ok(run.steps.map((s) => s.status).join() === 'ok,ok', 'both steps are logged as done');
  await new Promise((r) => setTimeout(r, 4000));
  eq(posts().length, 1);                                           // never duplicated
});

await check('failures are logged with Buffer’s message and retried later, not hammered', async () => {
  // make the text start with FAIL first (the mock rejects those), THEN let one record start matching
  await page.goto(t.url + '/#/automations');
  await page.getByLabel('Post text').fill('FAIL {{title}}');
  await page.waitForTimeout(500);
  await setStatus('Micropipette', 'Ready to post');
  const t0 = Date.now();
  while (!(await dump(page, 'autoRuns')).some((r) => r.status === 'failed') && Date.now() - t0 < 15000) await new Promise((r) => setTimeout(r, 400));
  const failed = (await dump(page, 'autoRuns')).filter((r) => r.status === 'failed');
  ok(failed.length >= 1 && /Channel is disconnected/.test(failed[0].detail) && failed[0].steps.some((s) => s.status === 'failed'), failed[0]?.detail);
  const n = posts().length;
  await new Promise((r) => setTimeout(r, 3500));
  eq(posts().length, n);                                           // 2-minute back-off: no immediate retry
  const auto = (await dump(page, 'automations'))[0];
  ok(Object.values(auto.fired).some((f) => f.n === 1 && !f.done), 'attempt counted, still pending');
});

await check('safety: enabling asks what to do with records that ALREADY match; “only new matches” sends nothing', async () => {
  const sent = posts().length;
  await newAutomation('Ready to post');
  await page.getByLabel('Automation name').fill('Scheduled from a date field');
  // trigger: Status = Approved (several records already match)
  await page.getByLabel('Value').first().selectOption('Approved');
  await page.getByLabel('Channel', { exact: true }).selectOption('BUFFER_CHANNEL_ID_INSTAGRAM');
  await page.getByRole('radio', { name: /At the date/ }).click();
  await page.getByLabel('Time field').selectOption({ label: 'Publish Date' });
  await page.getByRole('button', { name: /Dry run/ }).click();
  await page.waitForSelector('.dialog .chip.blue');
  // the sample data has fixed 2026 dates: depending on today's date the first match may already be in the past (then the dry run says so)
  ok(/Would post to INSTAGRAM at 2026-11-|already passed/.test(await page.getByRole('dialog').innerText()), 'dry run states when each post would go out');
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).last().click();
  eq(posts().length, sent);
  await page.getByLabel('Automation enabled').click();
  await page.waitForSelector('text=/already match the trigger/');
  await page.getByRole('button', { name: 'Only new matches' }).click();
  await page.waitForSelector('text=/only records that START matching/');
  await new Promise((r) => setTimeout(r, 3500));
  eq(posts().length, sent);
  await page.getByLabel('Automation enabled').click();
});

await check('“Pause all” stops evaluation', async () => {
  await page.getByRole('button', { name: /Pause all/ }).click();
  await page.waitForSelector('text=/All automations paused/');
  eq((await dump(page, 'settings')).find((s) => s.key === 'automations.running').value, false);
  await page.getByRole('button', { name: /Resume all/ }).click();
});

await check('everything persists across a reload and the vault key still decrypts', async () => {
  await page.goto(t.url + '/#/settings');
  await page.reload();
  await page.waitForSelector('[data-testid="secret-BUFFER_API_KEY"]');
  await page.getByTestId('secret-BUFFER_API_KEY').dblclick();
  await page.waitForFunction((k) => document.body.innerText.includes(k), KEY1);
  ok((await dump(page, 'userTables')).length === 1 && (await dump(page, 'automations')).length === 2, 'tables and automations stored');
});

await check('no console errors during the whole session', async () => { ok(errors.length === 0, errors.slice(0, 3).join(' | ')); });
const failed = report();
await t.close(); relay.kill(); mock.close();
process.exit(failed ? 1 : 0);
