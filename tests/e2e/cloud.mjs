/**
 * Batch Runner destinations, end to end in the real app: Cloudflare R2 and Google Drive, with the Google sign-in that
 * comes back through the local relay. Google and R2 are local mocks (no internet, no real account). The test checks what
 * the mocks received and what the app wrote into each record (the Uploaded link).
 */
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { check, dump, eq, ok, report, waitIdle } from './helpers.mjs';
import { launch } from './lib.mjs';

const require_ = createRequire(import.meta.url);
const { createRelay } = require_('../../server/relay-core.cjs');

// ------------------------------------------------------------------------------------------------ mocks
const s3Puts = [];
const s3Deletes = [];
const drive = { uploads: 0, patches: 0, shares: 0, files: new Map(), next: 1 };
let mockBase = '';

/** The files the mock bucket has received, by key: its public address serves them back. */
const r2Objects = new Map();
const mock = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const u = new URL(req.url ?? '/', 'http://x');
    const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    // R2: a signed DELETE of one object (an object that is not there is answered 404)
    if (req.method === 'DELETE' && u.pathname.startsWith('/bucket/')) {
      s3Deletes.push({ path: u.pathname, signed: /^AWS4-HMAC-SHA256 Credential=/.test(req.headers.authorization ?? '') });
      res.writeHead(204); return res.end();
    }
    // R2: an S3 PUT of one object, which must be signed
    if (req.method === 'PUT' && u.pathname.startsWith('/bucket/')) {
      s3Puts.push({ path: u.pathname, signed: /^AWS4-HMAC-SHA256 Credential=/.test(req.headers.authorization ?? ''), size: body.length });
      r2Objects.set(u.pathname.slice('/bucket/'.length), { body, type: req.headers['content-type'] ?? 'application/octet-stream' });
      res.writeHead(200, { etag: '"etag"' }); return res.end();
    }
    // the public address of the bucket serves its files (an unknown file is answered 404)
    if (req.method === 'GET' && u.pathname.startsWith('/pub/')) {
      const o = r2Objects.get(u.pathname.slice('/pub/'.length));
      if (!o) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('no such object'); }
      res.writeHead(200, { 'content-type': o.type, 'access-control-allow-origin': '*' }); return res.end(o.body);
    }
    // Google sign-in: the browser is sent straight back to the relay's callback with a code
    if (u.pathname === '/o/oauth2/v2/auth') {
      const back = new URL(u.searchParams.get('redirect_uri'));
      back.searchParams.set('code', 'CODE-FROM-GOOGLE');
      back.searchParams.set('state', u.searchParams.get('state'));
      res.writeHead(302, { location: back.toString() }); return res.end();
    }
    if (u.pathname === '/token') {
      const form = new URLSearchParams(body.toString('utf8'));
      if (form.get('grant_type') === 'authorization_code' && form.get('code') === 'CODE-FROM-GOOGLE' && form.get('code_verifier')) return json(200, { access_token: 'ACCESS-1', refresh_token: 'REFRESH-1', expires_in: 3600 });
      if (form.get('grant_type') === 'refresh_token' && form.get('refresh_token') === 'REFRESH-1') return json(200, { access_token: 'ACCESS-2', expires_in: 3600 });
      return json(400, { error: 'invalid_grant' });
    }
    if (req.method === 'GET' && u.pathname === '/drive/v3/files/FOLDER0001ABCDE') return json(200, { id: 'FOLDER0001ABCDE', name: 'Campaign', mimeType: 'application/vnd.google-apps.folder', capabilities: { canAddChildren: true } });
    if (req.method === 'GET' && u.pathname === '/drive/v3/files') {
      const q = u.searchParams.get('q') ?? '';
      const m = /name='([^']*)'/.exec(q);
      if (m) { const id = drive.files.get(m[1]); return json(200, { files: id ? [{ id }] : [] }); }
      return json(200, { files: [{ id: 'SUBFOLDER00001', name: 'Sub-folder' }] });
    }
    if (req.method === 'POST' && u.pathname === '/upload/drive/v3/files') {
      const name = /"name":"([^"]+)"/.exec(body.toString('utf8'))?.[1] ?? 'unnamed';
      const id = `FILE${String(drive.next++).padStart(6, '0')}XY`;
      drive.files.set(name, id); drive.uploads++;
      return json(200, { id });
    }
    if (req.method === 'PATCH' && u.pathname.startsWith('/upload/drive/v3/files/')) { drive.patches++; return json(200, { id: u.pathname.split('/').pop() }); }
    if (req.method === 'POST' && u.pathname.endsWith('/permissions')) {
      if (/"anyone"/.test(body.toString('utf8'))) drive.shares++;
      return json(200, { id: 'perm' });
    }
    json(404, { error: { message: `mock: no route ${req.method} ${u.pathname}` } });
  });
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
mockBase = `http://127.0.0.1:${mock.address().port}`;

const relay = createRelay({ origins: [], allowPrivateFetch: true, cloud: { driveBase: mockBase, oauthBase: mockBase, authBase: mockBase } });
await new Promise((r) => relay.listen(0, '127.0.0.1', r));
const relayBase = `http://127.0.0.1:${relay.address().port}`;

// ------------------------------------------------------------------------------------------------ the app
const t = await launch();
const { page, errors } = t;
const text = () => page.evaluate(() => document.body.innerText);
/** The dialog closes when its save has finished: the stored result is what counts, not a short message. */
const dialogClosed = (timeout = 60000) => page.waitForFunction(() => !document.querySelector('[role=dialog]'), null, { timeout });
/** Waits for the newest batch job to end, and returns it. */
async function batchJob(before, timeout = 240000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const jobs = (await dump(page, 'jobs')).sort((a, b) => b.started_at - a.started_at);
    const fresh = jobs.find((j) => !before.has(j.id));
    if (fresh && fresh.status !== 'running' && fresh.status !== 'preparing') return fresh;
    await page.waitForTimeout(500);
  }
  throw new Error('the batch did not finish in time');
}
const jobIds = async () => new Set((await dump(page, 'jobs')).map((j) => j.id));

await check('the connections are added on the Settings page: Cloudflare R2 with its keys, and Google Drive through the sign-in', async () => {
  await page.goto(t.url + '/#/settings');
  await page.waitForSelector('text=Cloud destinations');
  await page.getByLabel('Relay URL').fill(relayBase);
  await page.getByLabel('Relay URL').blur();
  await waitIdle(page, 300);
  await page.getByRole('button', { name: 'Add Cloudflare R2' }).click();
  const r2 = page.getByRole('dialog');
  await r2.getByLabel('R2 name').fill('R2 test');
  await r2.getByLabel('R2 endpoint').fill(mockBase);
  await r2.getByLabel('R2 bucket').fill('bucket');
  await r2.getByLabel('R2 public address').fill(`${mockBase}/pub`);
  await r2.getByLabel('R2 folder').fill('batch');
  await r2.getByLabel('R2 access key id').fill('AKTEST');
  await r2.getByLabel('R2 secret access key').fill('SKTEST');
  await r2.getByRole('button', { name: 'Save', exact: true }).click();
  await dialogClosed();
  await page.getByRole('button', { name: 'Connect Google Drive' }).click();
  const gd = page.getByRole('dialog');
  await gd.getByLabel('Drive name').fill('Drive test');
  await gd.getByLabel('Drive client id').fill('CLIENT-ID.apps.googleusercontent.com');
  await gd.getByLabel('Drive client secret').fill('CLIENT-SECRET');
  await gd.getByRole('button', { name: 'Connect', exact: true }).click();
  await dialogClosed();
  const conns = (await dump(page, 'connections')).filter((c) => c.provider === 'r2' || c.provider === 'gdrive');
  eq(conns.map((c) => c.provider).sort(), ['gdrive', 'r2']);
  ok(!JSON.stringify(conns).includes('SKTEST') && !JSON.stringify(conns).includes('REFRESH-1'), 'the keys and the refresh token are stored encrypted, never in plain text');
});

await check('a batch is sent to Cloudflare R2: every file is uploaded with a signed request, and its link is written into its record', async () => {
  await page.goto(t.url + '/#/batch');
  await page.reload();
  await page.waitForSelector('text=Where the files go');
  await page.getByRole('radio', { name: 'Upload to Cloudflare R2' }).check();
  await page.getByLabel('Cloudflare connection').selectOption({ label: 'R2 test' });
  const before1 = await jobIds();
  await page.getByRole('button', { name: /Start rendering/ }).click();
  const job1 = await batchJob(before1);
  eq(job1.status, 'completed', `the batch ends completed (${job1.errorSummary ?? ''})`);
  const records = (await dump(page, 'records')).filter((r) => r.data?.uploaded_link);
  ok(records.length > 0, 'the records have an Uploaded link');
  eq(s3Puts.length, records.length, 'one upload per record');
  ok(s3Puts.every((p) => p.signed && p.path.startsWith('/bucket/batch/')), 'every upload is signed and goes into the bucket folder');
  ok(records.every((r) => r.data.uploaded_link.startsWith(`${mockBase}/pub/batch/`)), 'each link is the public address of its file');
  ok((await dump(page, 'fields')).some((f) => f.key === 'uploaded_link' && f.type === 'url' && f.tableId === undefined), 'the “Uploaded link” field was created on the Content Plan');
});

await check('a batch is sent to a Google Drive folder given by its link: the files are uploaded there and made readable by link', async () => {
  await page.goto(t.url + '/#/batch');
  await page.reload();
  await page.waitForSelector('text=Where the files go');
  await page.getByRole('radio', { name: 'Upload to a Google Drive folder' }).check();
  await page.getByLabel('Drive connection').selectOption({ label: 'Drive test' });
  await page.getByLabel('Drive folder link or id').fill('https://drive.google.com/drive/folders/FOLDER0001ABCDE');
  await page.getByRole('button', { name: 'Check folder' }).click();
  await page.waitForSelector('text=/Uploads go to/');
  const before2 = await jobIds();
  await page.getByRole('button', { name: /Start rendering/ }).click();
  const job2 = await batchJob(before2);
  eq(job2.status, 'completed', `the Drive batch ends completed (${job2.errorSummary ?? ''})`);
  const records = (await dump(page, 'records')).filter((r) => r.data?.uploaded_link);
  ok(records.every((r) => /^https:\/\/drive\.google\.com\/uc\?export=view&id=FILE/.test(r.data.uploaded_link)), 'each link is the Drive address of its file');
  ok(drive.uploads >= records.length && drive.shares >= records.length, 'every file was uploaded and shared by link');
  globalThis.__firstUploads = drive.uploads;
});

await check('running the same batch again replaces the Drive files (no duplicates in the folder)', async () => {
  const before = drive.uploads;
  await page.goto(t.url + '/#/batch');
  await page.reload();
  await page.waitForSelector('text=Where the files go');
  await page.getByRole('radio', { name: 'Upload to a Google Drive folder' }).check();
  await page.getByLabel('Drive connection').selectOption({ label: 'Drive test' });
  await page.getByLabel('Drive folder link or id').fill('https://drive.google.com/drive/folders/FOLDER0001ABCDE');
  await page.getByRole('button', { name: 'Check folder' }).click();
  await page.waitForSelector('text=/Uploads go to/');
  const before3 = await jobIds();
  await page.getByRole('button', { name: /Start rendering/ }).click();
  const job3 = await batchJob(before3);
  eq(job3.status, 'completed', 'the second run ends completed');
  ok(drive.patches > 0, 'the existing files were updated in place');
  eq(drive.uploads, before, 'no new file was created for names that already exist');
  eq(new Set(drive.files.keys()).size, drive.files.size, 'one file per name');
});

await check('a link that is not a Drive folder is reported at once, before anything is rendered', async () => {
  await page.goto(t.url + '/#/batch');
  await page.reload();
  await page.waitForSelector('text=Where the files go');
  await page.getByRole('radio', { name: 'Upload to a Google Drive folder' }).check();
  await page.getByLabel('Drive connection').selectOption({ label: 'Drive test' });
  await page.getByLabel('Drive folder link or id').fill('https://example.com/not-drive');
  const before = drive.uploads;
  await page.getByRole('button', { name: 'Check folder' }).click();
  await waitIdle(page, 1200);
  ok(!(await text()).includes('Uploads go to'), 'the folder is not accepted');
  eq(drive.uploads, before, 'no file was uploaded for it');
});

await check('an automation step renders each record and uploads it to Cloudflare R2: the same destination choices as the Batch Runner, the link is written, and the history says where it went', async () => {
  const conn = (await dump(page, 'connections')).find((c) => c.provider === 'r2');
  const tpl = (await dump(page, 'templates'))[0];
  // a row written straight into the automations store; it stays off, so only the “Run now” button starts it
  await page.evaluate((row) => new Promise((resolve, reject) => {
    const req = indexedDB.open('dce');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('automations', 'readwrite');
      tx.objectStore('automations').put(row);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
  }), {
    id: 'auto-upload', name: 'Upload renders', enabled: false, created_at: 1, updated_at: 1,
    trigger: { kind: 'record', table: 'content', filter: { join: 'and', conditions: [] } },
    steps: [{ kind: 'render', table: 'content', templateId: tpl.id, format: 'png', dest: { kind: 'r2', connId: conn.id, folder: '', folderId: '', folderName: '', table: '', field: 'uploaded_link', keepZip: false } }],
    fired: {},
  });
  await page.goto(t.url + '/#/automations');
  await page.reload();
  await page.getByRole('listitem').filter({ hasText: 'Upload renders' }).click();
  await page.getByText('Where the files go', { exact: true }).waitFor();
  eq(await page.getByLabel('Cloudflare connection').inputValue(), conn.id, 'the step has its connection');
  const records = (await dump(page, 'records')).length;
  const before = s3Puts.length;
  await page.getByRole('button', { name: /Run for matching records now/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Run now', exact: true }).click();
  await page.waitForSelector('text=/Done \\d+, failed 0/', { timeout: 240000 });
  const uploads = s3Puts.slice(before);
  eq(uploads.length, records, 'one upload per record');
  ok(uploads.every((p) => p.signed && p.path.startsWith('/bucket/batch/')), 'every upload is signed and goes into the bucket folder');
  const linked = (await dump(page, 'records')).filter((r) => r.data?.uploaded_link?.startsWith(`${mockBase}/pub/batch/`));
  eq(linked.length, records, 'each record has the link of its file');
  const runs = (await dump(page, 'autoRuns')).filter((r) => r.automationId === 'auto-upload');
  ok(runs.length > 0 && JSON.stringify(runs).includes('uploaded to Cloudflare R2'), 'the history says where the files went');
});

// ------------------------------------------------------------------------------------------------ keeping and deleting uploads
const runNow = (id, opts) => page.evaluate(([i, o]) => window.__dceRunAutomation(i, o).then((r) => ({ sent: r.sent, failed: r.failed })), [id, opts]);
const seedRows = (store, rows) => page.evaluate(([st, rs]) => new Promise((resolve, reject) => {
  const req = indexedDB.open('dce');
  req.onerror = () => reject(req.error);
  req.onsuccess = () => {
    const db = req.result;
    const tx = db.transaction(st, 'readwrite');
    for (const row of rs) tx.objectStore(st).put(row);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => reject(tx.error);
  };
}), [store, rows]);
const keyOfLink = (link) => decodeURIComponent(link.split('/pub/batch/')[1]);

await check('a batch that deletes its files after an hour remembers each file with the time it is due', async () => {
  await page.goto(t.url + '/#/batch');
  await page.reload();
  await page.waitForSelector('text=Where the files go');
  await page.getByRole('radio', { name: 'Upload to Cloudflare R2' }).check();
  await page.getByLabel('Cloudflare connection').selectOption({ label: 'R2 test' });
  await page.getByRole('radio', { name: /Delete them after/ }).check();
  await page.getByLabel('Hours to keep').fill('1');
  const before = Date.now();
  const jobsBefore = await jobIds();
  await page.getByRole('button', { name: /Start rendering/ }).click();
  const job = await batchJob(jobsBefore);
  eq(job.status, 'completed', `the batch ends completed (${job.errorSummary ?? ''})`);
  const ups = await dump(page, 'uploads');
  ok(ups.length > 0, 'the uploads are remembered');
  ok(ups.every((u) => u.deleteAt >= before + 3_600_000 && u.deleteAt <= Date.now() + 3_600_000 && u.key.startsWith('batch/')), 'each is due an hour later, in the bucket folder');
});

await check('a file that is due is deleted from R2, its link is removed from its record, and the record stays', async () => {
  const conn = (await dump(page, 'connections')).find((c) => c.provider === 'r2');
  const linked = (await dump(page, 'records')).filter((r) => r.data?.uploaded_link?.startsWith(`${mockBase}/pub/batch/`));
  ok(linked.length >= 3, 'records with R2 files exist');
  const due = linked.slice(0, 2);
  await page.goto(t.url + '/#/automations');
  await page.reload();
  await page.waitForFunction(() => !!window.__dceSweepUploads);
  await seedRows('uploads', due.map((r, i) => ({
    id: `due-${i}`, connId: conn.id, key: `batch/${keyOfLink(r.data.uploaded_link)}`, url: r.data.uploaded_link,
    table: 'content', recordId: r.id, field: 'uploaded_link', deleteAt: 1, attempts: 0, created_at: 1,
  })));
  const res = await page.evaluate(() => window.__dceSweepUploads());
  ok(res.deleted >= 2 && res.failed === 0, JSON.stringify(res));
  const paths = s3Deletes.map((d) => d.path);
  ok(due.every((r) => paths.includes(`/bucket/batch/${keyOfLink(r.data.uploaded_link)}`)), 'each file was deleted from the bucket with a signed request');
  ok(s3Deletes.every((d) => d.signed), 'every delete is signed');
  const after = await dump(page, 'records');
  ok(due.every((r) => after.some((x) => x.id === r.id && !x.data?.uploaded_link)), 'the links are removed, and the records stay');
  eq((await dump(page, 'uploads')).filter((u) => u.deleteAt === 1).length, 0, 'the due rows are gone');
});

await check('an automation deletes a record and its R2 file; a record whose file is not in a connected bucket is kept', async () => {
  const linked = (await dump(page, 'records')).filter((r) => r.data?.uploaded_link?.startsWith(`${mockBase}/pub/batch/`));
  ok(linked.length >= 2, 'records with R2 files remain');
  const [foreign, mine] = linked;
  await seedRows('records', [{ ...foreign, data: { ...foreign.data, uploaded_link: 'https://example.org/elsewhere.png' } }]);
  await seedRows('automations', [{
    id: 'auto-del', name: 'Delete the record and its file', enabled: false, created_at: 9, updated_at: 9,
    trigger: { kind: 'record', table: 'content', filter: { join: 'and', conditions: [] }, on: { kind: 'matches' } },
    steps: [{ kind: 'delete_record', table: 'content', fileField: 'uploaded_link' }], fired: {},
  }]);
  await page.goto(t.url + '/#/automations');
  await page.reload();
  await page.waitForFunction(() => !!window.__dceRunAutomation);
  const deletesBefore = s3Deletes.length;
  const refused = await runNow('auto-del', { force: true, only: [foreign.id] });
  eq(refused.failed, 1, 'a file outside the connected bucket stops the run');
  ok((await dump(page, 'records')).some((x) => x.id === foreign.id), 'its record is kept');
  eq(s3Deletes.length, deletesBefore, 'nothing was deleted from R2');
  const done = await runNow('auto-del', { force: true, only: [mine.id] });
  eq(done.sent, 1, 'the record with its R2 file is deleted');
  ok(!(await dump(page, 'records')).some((x) => x.id === mine.id), 'the record is gone from the table');
  eq(s3Deletes.length, deletesBefore + 1, 'its file is deleted from R2');
  ok(s3Deletes.at(-1).path === `/bucket/batch/${keyOfLink(mine.data.uploaded_link)}`, 'the deleted file is the one the record pointed at');
});

await check('a carousel record with several links in one field: each file is deleted from R2 one by one (commas, semicolons, new lines), and the link is removed from the other record', async () => {
  const conn = (await dump(page, 'connections')).find((c) => c.provider === 'r2');
  const names = ['car-a.png', 'car-b.png', 'car-c.png', 'car-d.png'];
  const links = names.map((n) => `${mockBase}/pub/batch/${n}`);
  // the carousel group: four links, separated by a comma, a semicolon and a new line; a second table holds one of them too
  const value = `${links[0]}, ${links[1]}; ${links[2]}\n${links[3]}`;
  await seedRows('userTables', [{ id: 'tCar', name: 'Carousel items', created_at: 20 }, { id: 'tSrc', name: 'Source items', created_at: 20 }]);
  await seedRows('fields', [
    { id: 'fCarUrls', key: 'urls', label: 'Image URLs', type: 'longtext', order: 0, tableId: 'tCar' },
    { id: 'fSrcPic', key: 'pic', label: 'Picture', type: 'longtext', order: 0, tableId: 'tSrc' },
  ]);
  const blankRow = (id, table, title, data) => ({ id, table, created_at: 21, updated_at: 21, title, slug: '', status: '', publish_date: '', content: '', image_asset: '', template_ref: '', tags: [], position: 1000, data });
  await seedRows('rows', [
    blankRow('carRec', 'tCar', 'Group 1', { urls: value }),
    blankRow('srcRec', 'tSrc', 'Source 3', { pic: links[2] }),
  ]);
  await seedRows('automations', [{
    id: 'auto-car', name: 'Delete the carousel group and its files', enabled: false, created_at: 30, updated_at: 30,
    trigger: { kind: 'record', table: 'tCar', filter: { join: 'and', conditions: [] }, on: { kind: 'matches' } },
    steps: [{ kind: 'delete_record', table: 'tCar', fileField: 'urls' }], fired: {},
  }]);
  await page.goto(t.url + '/#/automations');
  await page.reload();
  await page.waitForFunction(() => !!window.__dceRunAutomation);
  const deletesBefore = s3Deletes.length;
  const res = await runNow('auto-car', { force: true, only: ['carRec'] });
  eq(res.failed, 0, 'the run did not fail (every link was read as a file of the bucket)');
  eq(res.sent, 1, 'the carousel record was deleted');
  eq(s3Deletes.slice(deletesBefore).map((d) => d.path), names.map((n) => `/bucket/batch/${n}`), 'each of the four files was deleted, one request per file, in the order of the field');
  ok(s3Deletes.slice(deletesBefore).every((d) => d.signed), 'every delete is signed');
  const rows = await dump(page, 'rows');
  ok(!rows.some((r) => r.id === 'carRec'), 'the carousel record is gone from the table');
  const src = rows.find((r) => r.id === 'srcRec');
  ok(src && !String(src.data?.pic ?? '').includes(links[2]), 'the link to the deleted file is removed from the other record');
});

await check('a field with a link that is not in the bucket: nothing is deleted, the record keeps all its links, and every link outside the bucket is named', async () => {
  const good = [`${mockBase}/pub/batch/keep-a.png`, `${mockBase}/pub/batch/keep-b.png`];
  const foreign = 'https://example.org/closing.png';
  const value = `${good[0]}, ${foreign}; ${good[1]}`;
  await seedRows('rows', [{
    id: 'mixRec', table: 'tCar', created_at: 22, updated_at: 22, title: 'Group 9', slug: '', status: '', publish_date: '', content: '',
    image_asset: '', template_ref: '', tags: [], position: 9000, data: { urls: value },
  }]);
  await page.goto(t.url + '/#/automations');
  await page.reload();
  await page.waitForFunction(() => !!window.__dceRunAutomation);
  const deletesBefore = s3Deletes.length;
  const res = await runNow('auto-car', { force: true, only: ['mixRec'] });
  eq(res.failed, 1, 'the run stops, because a link is not a file of the bucket');
  eq(s3Deletes.length, deletesBefore, 'no file was deleted from R2, not even the ones that are in the bucket');
  const rows = await dump(page, 'rows');
  const rec = rows.find((r) => r.id === 'mixRec');
  ok(rec && rec.data?.urls === value, 'the record keeps all of its links, unchanged');
  const run = (await dump(page, 'autoRuns')).filter((r) => r.recordId === 'mixRec').sort((a, b) => b.at - a.at)[0];
  ok(run && run.detail.includes(foreign), 'the history names the link that is not in the bucket');
});

await check('a real carousel: deleting “Carousel 1” deletes its two files one by one, and no carousel keeps a deleted file', async () => {
  const names = ['c1.png', 'c2.png', 'c3.png', 'c4.png', 'c5.png'];
  const links = names.map((n) => `${mockBase}/pub/batch/${n}`);
  await seedRows('userTables', [
    { id: 'tGrp', name: 'Groups', created_at: 40, carousel: { source: 'tSrc3', linkField: 'uploaded', groupSize: 2 } },
    { id: 'tSrc3', name: 'Slides', created_at: 40 },
  ]);
  await seedRows('fields', [
    { id: 'fSlUp', key: 'uploaded', label: 'Uploaded link', type: 'url', order: 0, tableId: 'tSrc3' },
    { id: 'fSlPage', key: 'carousel_page', label: 'Carousel Page', type: 'link', order: 1, tableId: 'tSrc3', linkTable: 'tGrp', carouselPage: true },
    { id: 'fSlNo', key: 'carousel_page_no', label: 'Page number', type: 'number', order: 2, tableId: 'tSrc3' },
    { id: 'fGrName', key: 'name', label: 'Name', type: 'text', order: 0, tableId: 'tGrp' },
    { id: 'fGrUrls', key: 'carousel', label: 'Carousel (image URLs)', type: 'longtext', order: 1, tableId: 'tGrp' },
    { id: 'fGrCount', key: 'carousel_count', label: 'Count', type: 'number', order: 2, tableId: 'tGrp' },
  ]);
  await seedRows('rows', links.map((l, i) => ({
    id: `sl${i + 1}`, table: 'tSrc3', created_at: 41 + i, updated_at: 41 + i, title: `Slide ${i + 1}`, slug: '', status: '', publish_date: '', content: '',
    image_asset: '', template_ref: '', tags: [], position: (i + 1) * 1000, data: { uploaded: l },
  })));
  await page.reload();
  await page.waitForTimeout(3000);
  const groupsNow = async () => (await dump(page, 'rows')).filter((r) => r.table === 'tGrp').sort((a, b) => String(a.data?.name).localeCompare(String(b.data?.name)))
    .map((r) => ({ id: r.id, name: r.data?.name, urls: String(r.data?.carousel ?? '').split(/[\s,;]+/).filter(Boolean).map((u) => u.split('/').pop()) }));
  const before = await groupsNow();
  console.log('CAROUSEL BEFORE', JSON.stringify(before));
  eq(before.map((g) => g.name), ['Carousel 1', 'Carousel 2', 'Carousel 3'], 'three carousels of two slides (the last has one)');
  eq(before[0].urls, ['c1.png', 'c2.png'], 'Carousel 1 holds the first two files');
  const g1 = before[0];
  await seedRows('automations', [{
    id: 'auto-grp', name: 'Delete the carousel and its files', enabled: false, created_at: 50, updated_at: 50,
    trigger: { kind: 'record', table: 'tGrp', filter: { join: 'and', conditions: [] }, on: { kind: 'matches' } },
    steps: [{ kind: 'delete_record', table: 'tGrp', fileField: 'carousel' }], fired: {},
  }]);
  await page.goto(t.url + '/#/automations');
  await page.reload();
  await page.waitForFunction(() => !!window.__dceRunAutomation);
  const deletesBefore = s3Deletes.length;
  const res = await runNow('auto-grp', { force: true, only: [g1.id] });
  eq(res.failed, 0, 'the run did not fail');
  eq(s3Deletes.slice(deletesBefore).map((d) => d.path), ['/bucket/batch/c1.png', '/bucket/batch/c2.png'], 'the two files of Carousel 1 were deleted, one request each');
  await page.waitForTimeout(3000);
  const after = await groupsNow();
  console.log('CAROUSEL AFTER', JSON.stringify(after));
  const alive = (await dump(page, 'rows')).filter((r) => r.table === 'sl1' || r.table === 'sl2');
  const allUrls = after.flatMap((g) => g.urls);
  ok(!allUrls.includes('c1.png') && !allUrls.includes('c2.png'), 'no carousel keeps a deleted file');
  const slides = (await dump(page, 'rows')).filter((r) => r.table === 'tSrc3');
  ok(!slides.some((r) => /c1\.png|c2\.png/.test(String(r.data?.uploaded ?? ''))), 'the deleted files are not linked from the slides');
});

await check('no console errors during the whole session', async () => {
  const real = errors.filter((e) => !/Failed to load resource/.test(e));
  ok(real.length === 0, real.slice(0, 3).join(' | '));
});

const failed = report();
await t.close();
relay.close();
mock.close();
process.exit(failed ? 1 : 0);
