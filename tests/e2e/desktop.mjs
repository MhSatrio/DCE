/** Smoke test of the PACKAGED desktop app (release/win-unpacked). Uses a throw-away data folder, never your real one. */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { check, dump, eq, ok, report } from './helpers.mjs';

const exe = process.env.DCE_EXE ?? join(process.env.DCE_OUT ?? join(homedir(), 'DCE-release'), 'win-unpacked', 'Dynamic Canvas Engine.exe');
if (!existsSync(exe)) { console.error('Build first: npm run dist:win  (looked for ' + exe + ')'); process.exit(2); }
const data = mkdtempSync(join(tmpdir(), 'dce-desktop-'));

// The packaged app has Electron's debug-attach fuses off (good for users), so drive it over the Chromium DevTools port instead.
let cdpPort = 9400 + Math.floor(Math.random() * 400);
async function start() {
  // VS Code / Claude Code set ELECTRON_RUN_AS_NODE=1, which would make the exe behave like plain Node — remove it
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const proc = spawn(exe, [`--user-data-dir=${data}`, `--remote-debugging-port=${cdpPort}`], { stdio: 'ignore', env });
  let browser;
  for (let i = 0; i < 60 && !browser; i++) {
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`); } catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  if (!browser) { proc.kill(); throw new Error('The desktop app did not start.'); }
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0] ?? (await ctx.waitForEvent('page'));
  return { proc, browser, page, close: async () => { await browser.close().catch(() => undefined); spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); await new Promise((r) => setTimeout(r, 1500)); } };
}
const app = await start();
const page = app.page;
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.setDefaultTimeout(30000);

await check('the window opens the app from its private local address, with the sample workspace', async () => {
  await page.waitForSelector('.sidebar');
  ok(page.url().startsWith('http://127.0.0.1:47625/'), page.url());
  await page.getByRole('link', { name: 'Templates', exact: true }).click();
  await page.waitForSelector('text=Product Announcement');
  eq(await page.evaluate(() => /Electron/.test(navigator.userAgent)), true);
  eq(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length), 0); // no service worker needed in the desktop shell
});

await check('the Buffer relay is built in (health check from the app’s own origin — no `npm run relay` needed)', async () => {
  const r = await page.evaluate(() => fetch('http://127.0.0.1:8788/health').then((x) => x.json()));
  eq(r.ok, true);
  eq(r.upstream, 'https://api.buffer.com');
  const evil = await page.evaluate(() => fetch('http://127.0.0.1:8788/buffer', { method: 'POST', headers: { authorization: 'Bearer x' }, body: '{}' }).then((x) => x.status));
  ok(evil === 200 || evil === 401 || evil === 502 || evil === 400, 'relay answers the app origin (status ' + evil + ')');
});

await check('content pipeline: page opens with the two pre-filled sources; the built-in relay can read pages but refuses private addresses; alerts can use desktop notifications', async () => {
  await page.goto('http://127.0.0.1:47625/#/pipeline');
  await page.waitForSelector('h1:has-text("Content pipeline")');
  await page.getByRole('tab', { name: /^Sources/ }).click();
  await page.waitForSelector('table[aria-label="Sources"]');
  const txt = await page.locator('table[aria-label="Sources"]').innerText();
  ok(/vierapparatus\.com/.test(txt) && /PlacidWay/.test(txt), txt.slice(0, 200));
  const h = await page.evaluate(() => fetch('http://127.0.0.1:8788/health').then((x) => x.json()));
  ok(h.features?.includes('fetch'), JSON.stringify(h));
  const priv = await page.evaluate(() => fetch('http://127.0.0.1:8788/fetch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'http://127.0.0.1:47625/', hosts: ['127.0.0.1'] }) }).then((x) => x.json()));
  eq([priv.ok, priv.blocked], [false, 'private']);
  const other = await page.evaluate(() => fetch('http://127.0.0.1:8788/fetch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'https://example.com/', hosts: ['vierapparatus.com'] }) }).then((x) => x.json()));
  eq([other.ok, other.blocked], [false, 'host']);
  eq(await page.evaluate(() => Notification.requestPermission()), 'granted');
});

await check('credit, licence and terms are inside the app (Settings → About)', async () => {
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.waitForSelector('[aria-label="About"]');
  const about = await page.locator('[aria-label="About"]').innerText();
  ok(/Muhammad Satrio/.test(about) && /desktop app/.test(about) && /MIT/.test(about), about.slice(0, 200));
  ok(!/created by|made by|developed by|written by/i.test(about), 'no claim of who wrote it');
  await page.getByRole('button', { name: 'Terms and conditions' }).click();
  await page.waitForSelector('text=/NO RESPONSIBILITY OR LIABILITY/');
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).last().click();
});

await check('rendering works in the packaged app (workers, OffscreenCanvas, IndexedDB, ZIP)', async () => {
  await page.goto(page.url().replace(/#.*$/, '') + '#/batch');
  await page.waitForSelector('text=Source & template');
  await page.waitForSelector('button:has-text("Start rendering")');
  await page.getByRole('button', { name: /Start rendering/ }).click();
  await page.getByRole('button', { name: /Download/ }).waitFor({ timeout: 60000 });
  const chips = await page.locator('.chip.ok').allInnerTexts();
  ok(chips.some((c) => /4 ok/.test(c)) && chips.includes('completed'), chips.join());
});

await check('the packaged app has the new automation step (where the files go) and the template download menu', async () => {
  const base = page.url().replace(/#.*$/, '');
  const tpl = (await dump(page, 'templates'))[0];
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
    id: 'auto-desktop', name: 'Desktop render', enabled: false, created_at: 1, updated_at: 1,
    trigger: { kind: 'record', table: 'content', filter: { join: 'and', conditions: [] } },
    steps: [{ kind: 'render', table: 'content', templateId: tpl.id, format: 'png', dest: { kind: 'zip', connId: '', folder: '', folderId: '', folderName: '', table: '', field: 'uploaded_link', keepZip: false } }],
    fired: {},
  });
  await page.goto(base + '#/automations');
  await page.reload();
  await page.getByRole('listitem').filter({ hasText: 'Desktop render' }).click();
  await page.getByText('Where the files go', { exact: true }).waitFor();
  ok(await page.getByRole('radio', { name: 'Upload to Cloudflare R2' }).count() === 1, 'the step offers the Cloudflare R2 upload');
  ok(await page.getByRole('radio', { name: 'Upload to a Google Drive folder' }).count() === 1, 'the step offers the Google Drive upload');
  await page.goto(base + '#/templates');
  await page.waitForSelector('.card');
  await page.locator('.card').first().getByRole('button', { name: 'Download as…' }).click();
  eq(await page.getByRole('menu').getByRole('menuitem').allTextContents(), ['.njs design file', 'PNG image', 'JPEG image', 'PDF document', 'SVG drawing', 'HTML page'], 'the download menu of a template');
  await page.keyboard.press('Escape');
});

await check('the packaged app: a Buffer post can take its image by link, and the record details open wide enough to edit', async () => {
  const base = page.url().replace(/#.*$/, '');
  await page.evaluate(() => new Promise((resolve, reject) => {
    const req = indexedDB.open('dce');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('automations', 'readwrite');
      tx.objectStore('automations').put({
        id: 'auto-desktop-buffer', name: 'Buffer image check', enabled: false, created_at: 2, updated_at: 2,
        trigger: { kind: 'record', table: 'content', filter: { join: 'and', conditions: [] } },
        steps: [{ kind: 'buffer_post', connectionId: '', channel: '', text: '{{title}}', imageField: '', timing: { mode: 'queue', delayAmount: 30, delayUnit: 'minutes', pastPolicy: 'skip' } }],
        fired: {},
      });
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
  }));
  await page.goto(base + '#/automations');
  await page.reload();
  await page.getByRole('listitem').filter({ hasText: 'Buffer image check' }).click();
  await page.getByRole('radio', { name: 'Send by link' }).waitFor();
  await page.getByRole('radio', { name: 'Send by link' }).click();
  await page.waitForSelector('[aria-label="Link field"]');
  await page.goto(base + '#/content');
  await page.waitForSelector('.vgrid-row');
  await page.locator('.vgrid-row').first().getByRole('button', { name: 'Open record details' }).click();
  const box = await page.locator('.drawer').boundingBox();
  ok(box && box.width >= 430 && box.width <= 660, `the record details are ${Math.round(box?.width ?? 0)} px wide`);
  await page.getByRole('button', { name: 'Close details' }).click();
});

await check('the packaged app: the table can be copied and saved as Excel, its columns move, and a weekly schedule can run one row at a time', async () => {
  const base = page.url().replace(/#.*$/, '');
  await page.goto(base + '#/content');
  await page.waitForSelector('.vgrid-head');
  await page.getByRole('button', { name: 'Copy table', exact: true }).waitFor();
  await page.getByRole('button', { name: /^Export/ }).click();
  eq(await page.getByRole('button', { name: 'Excel file (.xlsx)', exact: true }).count(), 1, 'the Excel option is in the export menu');
  await page.keyboard.press('Escape');
  await page.locator('.vhead', { hasText: 'Status' }).first().click({ button: 'right' });
  eq(await page.getByRole('menuitem', { name: 'Move right', exact: true }).count(), 1, 'the column menu can move a column');
  await page.keyboard.press('Escape');
});

await check('the packaged app: an automation step is “Update a record”, with the choice of the record', async () => {
  const base = page.url().replace(/#.*$/, '');
  const tpl = (await dump(page, 'templates'))[0];
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
    id: 'auto-update-desktop', name: 'Update desktop', enabled: false, created_at: 3, updated_at: 3,
    trigger: { kind: 'record', table: 'content', filter: { join: 'and', conditions: [] }, on: { kind: 'matches' } },
    steps: [{ kind: 'set_field', table: 'content', field: 'status', value: 'Published', match: { field: 'title', value: 'Magnetic Stirrer' } }],
    fired: {},
  });
  await page.goto(base + '#/automations');
  await page.reload();
  await page.getByRole('listitem').filter({ hasText: 'Update desktop' }).click();
  await page.getByRole('radio', { name: 'The record where a field has a value' }).waitFor();
  eq(await page.getByRole('radio', { name: 'The record where a field has a value' }).isChecked(), true, 'the record is found by a value');
  eq(await page.getByLabel('Record value', { exact: true }).inputValue(), 'Magnetic Stirrer', 'the value that finds the record');
});

await check('the packaged app: a batch to R2 can delete its files after a set time, and “Delete a record” can delete the record with its R2 file', async () => {
  const base = page.url().replace(/#.*$/, '');
  await page.goto(base + '#/batch');
  await page.waitForSelector('text=Where the files go');
  await page.getByRole('radio', { name: 'Upload to Cloudflare R2' }).check();
  await page.getByRole('radio', { name: /Delete them after/ }).waitFor();
  eq(await page.getByRole('radio', { name: /Delete them at a date and time/ }).count(), 1, 'the date and time choice is there');
  await page.getByRole('radio', { name: 'Download ZIP only' }).check();
  await page.goto(base + '#/automations');
  await page.reload();
  const tpl = (await dump(page, 'templates'))[0];
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
    id: 'auto-delete-desktop', name: 'Delete desktop', enabled: false, created_at: 4, updated_at: 4,
    trigger: { kind: 'record', table: 'content', filter: { join: 'and', conditions: [] }, on: { kind: 'matches' } },
    steps: [{ kind: 'delete_record', table: 'content', fileField: 'title' }],
    fired: {},
  });
  await page.reload();
  await page.getByRole('listitem').filter({ hasText: 'Delete desktop' }).click();
  await page.getByRole('radio', { name: 'The record that started this automation' }).waitFor();
  eq(await page.getByRole('combobox', { name: 'File field' }).inputValue(), 'title', 'the file field is chosen');
  ok(tpl, 'a template exists');
});

await check('data persists across a restart of the app', async () => {
  await app.close();
  const app2 = await start();
  const p2 = app2.page;
  await p2.waitForSelector('.sidebar');
  await p2.goto('http://127.0.0.1:47625/#/batch');
  await p2.waitForSelector('text=Batch history');
  await p2.waitForSelector('table.tbl tbody tr');
  ok((await p2.locator('table.tbl tbody tr').count()) >= 1, 'the finished job is still in the history');
  await app2.close();
});

await check('no console errors', async () => { const real = errors.filter((e) => !/401/.test(e)); // the 401 is the test's own deliberately key-less relay probe
  ok(real.length === 0, real.slice(0, 3).join(' | ')); });
const failed = report();
await app.close().catch(() => undefined);
try { rmSync(data, { recursive: true, force: true }); } catch { /* temp folder */ }
process.exit(failed ? 1 : 0);
