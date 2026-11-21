/**
 * Automations, in the real app (headless Chromium): a schedule that is changed or switched on starts from now (the
 * occurrences that passed are not run); “Update a record” changes the record that started the run, or the records where a
 * field has a value, and not the whole field. The table is written straight into the database before the app starts.
 */
import { check, dump, eq, ok, report, waitIdle } from './helpers.mjs';
import { launch } from './lib.mjs';

const t = await launch({ viewport: { width: 1500, height: 900 } });
const { page, errors } = t;
const TABLE = 'tQue';
const DAY = 86400000;

/** Writes rows into the app's database (the same stores the app reads). */
async function seed(data) {
  await page.evaluate((d) => new Promise((resolve, reject) => {
    const req = indexedDB.open('dce');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const names = Object.keys(d);
      const tx = db.transaction(names, 'readwrite');
      for (const n of names) for (const row of d[n]) tx.objectStore(n).put(row);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
  }), data);
}
const stages = async () => (await dump(page, 'rows')).filter((r) => r.table === TABLE).sort((a, b) => a.position - b.position).map((r) => `${r.data.name}:${r.data.stage}`);
const rowIds = async () => (await dump(page, 'rows')).filter((r) => r.table === TABLE).sort((a, b) => a.position - b.position).map((r) => r.id);
const noConditions = { join: 'and', conditions: [] };
const runNow = (id, opts) => page.evaluate(([i, o]) => window.__dceRunAutomation(i, o).then((r) => ({ sent: r.sent, failed: r.failed, lines: r.lines.length })), [id, opts]);
async function openAutomations() {
  await page.goto(t.url + '/#/automations');
  await page.reload();
  await page.waitForFunction(() => !!window.__dceRunAutomation);
}

// first visit: the app creates its sample data; then the table is added and the app is reloaded to read it
await page.goto(t.url + '/#/workspace');
await page.waitForSelector('text=Workspace');
await seed({
  userTables: [{ id: TABLE, name: 'Que', created_at: 3 }],
  fields: [
    { id: 'fQueName', key: 'name', label: 'Name', type: 'text', order: 0, tableId: TABLE },
    { id: 'fQueStage', key: 'stage', label: 'Stage', type: 'select', options: ['New', 'Ready', 'Done'], order: 1, tableId: TABLE },
    { id: 'fQuePic', key: 'pic', label: 'Picture link', type: 'text', order: 2, tableId: TABLE },
  ],
  rows: ['Alpha', 'Bravo', 'Charlie'].map((name, i) => ({
    id: `q${i + 1}`, table: TABLE, created_at: 10 + i, updated_at: 10 + i, title: name, slug: '', status: '', publish_date: '', content: '',
    image_asset: '', template_ref: '', tags: [], position: (i + 1) * 1000,
    data: { name, stage: 'New', pic: i === 0 ? 'https://drive.google.com/uc?export=view&id=PIC1' : '' },
  })),
});
await page.reload();
await page.waitForSelector('text=Que');

await check('a schedule that is switched on by changing its time does not run the occurrences that passed; the next one runs every row', async () => {
  await seed({
    automations: [{
      id: 'auto-sched', name: 'Every day', enabled: true, created_at: 4, updated_at: 4,
      trigger: { kind: 'schedule', table: TABLE, filter: noConditions, when: { mode: 'weekly', time: '00:00', days: [0, 1, 2, 3, 4, 5, 6] } },
      steps: [{ kind: 'set_field', table: TABLE, field: 'stage', value: 'Done' }], fired: {},
    }],
  });
  await openAutomations();
  await page.getByRole('listitem').filter({ hasText: 'Every day' }).click();
  await page.getByLabel('Run time').fill('23:59');
  await waitIdle(page, 500);
  eq(await stages(), ['Alpha:New', 'Bravo:New', 'Charlie:New'], 'changing the time ran nothing');
  const armed = (await dump(page, 'automations')).find((a) => a.id === 'auto-sched').trigger.lastDue;
  ok(typeof armed === 'number' && armed <= Date.now(), 'the schedule is armed at the time it was changed');
  eq(await runNow('auto-sched', { now: Date.now() + 2 * DAY }).then((r) => r.sent), 3, 'the next occurrence runs the rows');
  eq(await stages(), ['Alpha:Done', 'Bravo:Done', 'Charlie:Done'], 'every row is done');
});

await check('a record trigger changed to a weekly schedule does not run every row at once', async () => {
  await seed({
    automations: [{
      id: 'auto-switch', name: 'When created', enabled: true, created_at: 5, updated_at: 5,
      trigger: { kind: 'record', table: TABLE, filter: noConditions, on: { kind: 'created' } },
      steps: [{ kind: 'set_field', table: TABLE, field: 'stage', value: 'Ready' }], fired: {},
    }],
  });
  // reset the rows so the check starts from New
  await page.evaluate(() => new Promise((resolve, reject) => {
    const req = indexedDB.open('dce');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('rows', 'readwrite');
      const store = tx.objectStore('rows');
      store.getAll().onsuccess = (e) => { for (const r of e.target.result) if (r.table === 'tQue') store.put({ ...r, data: { ...r.data, stage: 'New' } }); };
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
  }));
  await openAutomations();
  await page.getByRole('listitem').filter({ hasText: 'When created' }).click();
  await page.getByLabel('Trigger', { exact: true }).selectOption({ label: 'Every week, on chosen days, at a time' });
  await waitIdle(page, 600);
  eq(await stages(), ['Alpha:New', 'Bravo:New', 'Charlie:New'], 'switching the trigger ran nothing');
});

await check('“Update a record” changes the record where a field has a value, and only that one', async () => {
  await seed({
    automations: [
      { id: 'auto-find', name: 'Find Bravo', enabled: false, created_at: 6, updated_at: 6, trigger: { kind: 'record', table: TABLE, filter: noConditions, on: { kind: 'matches' } },
        steps: [{ kind: 'set_field', table: TABLE, field: 'stage', value: 'Done', match: { field: 'name', value: 'Bravo' } }], fired: {} },
      { id: 'auto-this', name: 'This record', enabled: false, created_at: 7, updated_at: 7, trigger: { kind: 'record', table: TABLE, filter: noConditions, on: { kind: 'matches' } },
        steps: [{ kind: 'set_field', table: TABLE, field: 'stage', value: 'Ready', also: [{ field: 'name', value: 'Charlie (checked)' }] }], fired: {} },
    ],
  });
  await page.evaluate(() => new Promise((resolve, reject) => {
    const req = indexedDB.open('dce');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('rows', 'readwrite');
      const store = tx.objectStore('rows');
      store.getAll().onsuccess = (e) => { for (const r of e.target.result) if (r.table === 'tQue') store.put({ ...r, data: { ...r.data, stage: 'New', name: r.data.name } }); };
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
  }));
  await openAutomations();
  const [alpha, bravo, charlie] = await rowIds();
  await runNow('auto-find', { force: true, only: [alpha] });
  eq(await stages(), ['Alpha:New', 'Bravo:Done', 'Charlie:New'], 'the record where the name is Bravo is updated, not the record that started the run');
  await runNow('auto-this', { force: true, only: [charlie] });
  const after = await stages();
  eq(after[2], 'Charlie (checked):Ready', 'the record that started the run gets both of its fields');
});

await check('the editor offers “The record where…” and more fields to update', async () => {
  await page.getByRole('listitem').filter({ hasText: 'Find Bravo' }).click();
  eq(await page.getByRole('radio', { name: 'The record where a field has a value' }).isChecked(), true, 'the record is found by a value');
  eq(await page.getByLabel('Record field', { exact: true }).inputValue(), 'name', 'the field that finds it');
  eq(await page.getByRole('button', { name: 'Add another field' }).count(), 1, 'more fields can be added');
  await page.getByRole('listitem').filter({ hasText: 'This record' }).click();
  eq(await page.getByRole('radio', { name: 'The record that started this automation' }).isChecked(), true, 'the record is the one that started the automation');
  eq(await page.getByLabel('Field 2', { exact: true }).inputValue(), 'name', 'the second field is listed');
});

await check('the warning on an automation follows the data: when the record gets a public link, the warning goes while the page is open', async () => {
  await seed({
    automations: [
      { id: 'auto-pic', name: 'Post the picture', enabled: false, created_at: 8, updated_at: 8,
        trigger: { kind: 'record', table: TABLE, filter: noConditions, on: { kind: 'matches' } },
        steps: [{ kind: 'buffer_post', connectionId: '', channel: '', text: '{{name}}', imageField: 'pic', timing: { mode: 'queue', delayAmount: 30, delayUnit: 'minutes', pastPolicy: 'skip' } }], fired: {} },
      { id: 'auto-fix-pic', name: 'Use a public picture', enabled: false, created_at: 9, updated_at: 9,
        trigger: { kind: 'record', table: TABLE, filter: noConditions, on: { kind: 'matches' } },
        steps: [{ kind: 'set_field', table: TABLE, field: 'pic', value: 'https://img.example.test/alpha.png' }], fired: {} },
    ],
  });
  await openAutomations();
  await page.getByRole('listitem').filter({ hasText: 'Post the picture' }).click();
  const shown = async () => (await page.evaluate(() => document.body.innerText)).includes('image address Buffer cannot read');
  ok(await shown(), 'the warning shows the address Buffer cannot read');
  const [alpha] = await rowIds();
  eq(await runNow('auto-fix-pic', { force: true, only: [alpha] }).then((r) => r.sent), 1, 'the record gets a public picture');
  await waitIdle(page, 500);
  ok(!(await shown()), 'the warning is gone, with the page still open');
});

await check('an action with its own condition runs only for the items that match it; the others are skipped, and the rest still run', async () => {
  await seed({
    automations: [{
      id: 'auto-cond', name: 'Each action its own condition', enabled: false, created_at: 10, updated_at: 10,
      trigger: { kind: 'record', table: TABLE, filter: noConditions, on: { kind: 'matches' } },
      steps: [
        { kind: 'set_field', table: TABLE, field: 'stage', value: 'Ready', filter: { join: 'and', conditions: [{ id: 'c1', field: 'name', op: 'eq', value: 'Alpha' }] } },
        { kind: 'set_field', table: TABLE, field: 'stage', value: 'Done', filter: { join: 'and', conditions: [{ id: 'c2', field: 'name', op: 'eq', value: 'Bravo' }] } },
      ],
      fired: {},
    }],
  });
  // reset the stages and names (earlier checks changed them) so the check starts from New
  await page.evaluate(() => new Promise((resolve, reject) => {
    const req = indexedDB.open('dce');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('rows', 'readwrite');
      const store = tx.objectStore('rows');
      store.getAll().onsuccess = (e) => { for (const r of e.target.result) if (r.table === 'tQue') store.put({ ...r, data: { ...r.data, stage: 'New', name: r.title } }); };
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
  }));
  await openAutomations();
  const [alpha, bravo, charlie] = await rowIds();
  await runNow('auto-cond', { force: true, only: [alpha, bravo, charlie] });
  eq(await stages(), ['Alpha:Ready', 'Bravo:Done', 'Charlie:New'], 'each action changed only the items that match its condition');
  const runs = (await dump(page, 'autoRuns')).filter((r) => r.automationId === 'auto-cond');
  const runOf = (title) => runs.find((r) => r.recordTitle === title);
  eq(runOf('Alpha').steps.map((s) => s.status), ['ok', 'skipped'], 'Alpha: the first action ran, the second was skipped');
  eq(runOf('Bravo').steps.map((s) => s.status), ['skipped', 'ok'], 'Bravo: the first action was skipped, the second ran');
  eq(runOf('Charlie').status, 'skipped', 'Charlie matched no action, so its run is skipped');
  await page.getByRole('listitem').filter({ hasText: 'Each action its own condition' }).click();
  ok((await page.evaluate(() => document.body.innerText)).includes('Only when'), 'each action shows its own condition');
});

await check('no console errors during the whole session', async () => {
  const real = errors.filter((e) => !/Failed to load resource/.test(e));
  ok(real.length === 0, real.slice(0, 3).join(' | '));
});

const failed = report();
await t.close();
process.exit(failed ? 1 : 0);
