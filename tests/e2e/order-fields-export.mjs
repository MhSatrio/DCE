/**
 * The order of a table is kept (rows and columns), the whole table can be copied, it can be saved as an Excel file, and
 * an automation writes values typed as their field (a choice list for a select), in the real app (headless Chromium).
 * The table is written straight into the database before the app starts; everything after that is done through the screens.
 */
import { unzipSync, strFromU8 } from 'fflate';
import { check, dump, eq, ok, OUT, report, waitIdle } from './helpers.mjs';
import { launch } from './lib.mjs';

const t = await launch({ viewport: { width: 1500, height: 900 } });
const { page, errors } = t;
const TABLE = 'tShelf';
const NAMES = ['Alpha', 'Bravo', 'Charlie', 'Delta'];

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

/** The names of the rows, in the order they are shown. */
const rowOrder = async () => (await page.locator('.vgrid-row').allInnerTexts()).map((x) => NAMES.find((n) => x.includes(n))).filter(Boolean);
/** The column titles, in the order they are shown. */
const columnOrder = async () => (await page.locator('.vhead').allInnerTexts()).map((x) => x.trim());
const shelfRows = async () => (await dump(page, 'rows')).filter((r) => r.table === TABLE).sort((a, b) => a.position - b.position);
async function openShelf() {
  await page.goto(t.url + `/#/table/${TABLE}`);
  await page.reload();
  await page.waitForSelector('.vgrid-head');
  await waitIdle(page, 300);
}
const clipboard = () => page.evaluate(() => navigator.clipboard.readText());

// first visit: the app creates its sample data; then the test's table is added and the app is reloaded to read it
await page.goto(t.url + '/#/workspace');
await page.waitForSelector('text=Workspace');
await seed({
  userTables: [{ id: TABLE, name: 'Shelf', created_at: 3 }],
  fields: [
    { id: 'fShelfName', key: 'name', label: 'Name', type: 'text', order: 0, tableId: TABLE },
    { id: 'fShelfQty', key: 'qty', label: 'Qty', type: 'number', order: 1, tableId: TABLE },
    { id: 'fShelfStage', key: 'stage', label: 'Stage', type: 'select', options: ['New', 'Done'], order: 2, tableId: TABLE },
  ],
  // four rows made in the same moment and without a saved place: before this version their order changed on every restart
  rows: NAMES.map((name, i) => ({
    id: `r${i + 1}`, table: TABLE, created_at: 5, updated_at: 5, title: name, slug: '', status: '', publish_date: '', content: '',
    image_asset: '', template_ref: '', tags: [], data: { name, qty: i + 1, stage: 'New' },
  })),
});
await page.reload();
await page.waitForSelector('text=Shelf');

await check('the rows keep their order: the rows made together are placed once, and the same order is shown after a restart', async () => {
  await openShelf();
  eq(await rowOrder(), NAMES, 'the order the rows are shown in');
  await page.reload();
  await page.waitForSelector('.vgrid-head');
  eq(await rowOrder(), NAMES, 'after a restart');
  eq((await shelfRows()).map((r) => r.data.name), NAMES, 'the saved place of each row');
});

await check('a row can be moved up from its menu, and the new order is kept after a restart', async () => {
  await page.locator('.vgrid-row', { hasText: 'Charlie' }).getByText('Charlie', { exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Move row up' }).click();
  await waitIdle(page, 400);
  eq(await rowOrder(), ['Alpha', 'Charlie', 'Bravo', 'Delta'], 'Charlie is one row up');
  await page.reload();
  await page.waitForSelector('.vgrid-head');
  eq(await rowOrder(), ['Alpha', 'Charlie', 'Bravo', 'Delta'], 'after a restart');
});

await check('changing a value does not move the row, and a new row goes to the end and stays there', async () => {
  await openShelf();
  const heads = await page.getByRole('columnheader').allTextContents(); // the same columns as the grid cells (the first one is the row checkbox)
  const qty = heads.findIndex((h) => h.includes('Qty'));
  const cell = page.locator('.vgrid-row', { hasText: 'Delta' }).getByRole('gridcell').nth(qty);
  await cell.dblclick();
  await cell.getByLabel('Qty', { exact: true }).fill('9');
  await cell.getByLabel('Qty', { exact: true }).press('Enter');
  await waitIdle(page, 400);
  eq(await rowOrder(), ['Alpha', 'Charlie', 'Bravo', 'Delta'], 'the order after the edit');
  await page.getByRole('button', { name: 'New row', exact: true }).click();
  await waitIdle(page, 500);
  await page.reload();
  await page.waitForSelector('.vgrid-head');
  const saved = await shelfRows();
  eq(saved.slice(0, 4).map((r) => r.data.name), ['Alpha', 'Charlie', 'Bravo', 'Delta'], 'the rows keep their places');
  ok(saved.length === 5 && saved[4].position > saved[3].position, 'the new row is the last one');
});

await check('a column can be moved left from its menu, and the new order is kept after a restart', async () => {
  await openShelf();
  eq((await columnOrder()).indexOf('Qty') > (await columnOrder()).indexOf('Name'), true, 'Qty starts after Name');
  await page.locator('.vhead', { hasText: 'Qty' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Move left', exact: true }).click();
  await waitIdle(page, 400);
  let heads = await columnOrder();
  ok(heads.indexOf('Qty') < heads.indexOf('Name'), `Qty is now before Name: ${heads.join(' | ')}`);
  await page.reload();
  await page.waitForSelector('.vgrid-head');
  heads = await columnOrder();
  ok(heads.indexOf('Qty') < heads.indexOf('Name'), `after a restart: ${heads.join(' | ')}`);
});

await check('Copy table copies every row; Ctrl+C with the select-all box ticked copies them too', async () => {
  await page.evaluate(() => navigator.clipboard.writeText('SENTINEL'));
  await page.getByRole('button', { name: 'Copy table', exact: true }).click();
  await waitIdle(page, 300);
  const copied = await clipboard();
  eq(copied.split('\r\n').length, 5, 'one line per row');
  ok(copied.includes('Alpha') && copied.includes('Delta'), 'the names are in the copy');
  await page.evaluate(() => navigator.clipboard.writeText('SENTINEL'));
  await page.getByRole('checkbox', { name: 'Select all rows' }).click();
  await waitIdle(page, 200);
  await page.keyboard.press('Control+c');
  await waitIdle(page, 300);
  const fromKey = await clipboard();
  ok(fromKey !== 'SENTINEL' && fromKey.split('\r\n').length === 5, 'Ctrl+C copied the selected rows');
  await page.getByRole('checkbox', { name: 'Select all rows' }).click();
});

await check('Excel: the table is saved as an .xlsx file with its header, its rows in order, and its numbers as numbers', async () => {
  await page.getByRole('button', { name: /^Export/ }).click();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Excel file (.xlsx)', exact: true }).click()]);
  eq(dl.suggestedFilename().endsWith('.xlsx'), true, 'the file name ends with .xlsx');
  const file = `${OUT}shelf-export.xlsx`;
  await dl.saveAs(file);
  const parts = unzipSync(new Uint8Array(await (await import('node:fs/promises')).readFile(file)));
  const sheet = strFromU8(parts['xl/worksheets/sheet1.xml']);
  ok(sheet.includes('<t xml:space="preserve">Name</t>') && sheet.includes('<t xml:space="preserve">Stage</t>'), 'the header row');
  ok(sheet.indexOf('>Alpha<') < sheet.indexOf('>Delta<') && sheet.indexOf('>Alpha<') < sheet.indexOf('>Charlie<'), 'the rows are in the table’s order');
  ok(/<c r="[A-Z]+\d+"><v>9<\/v><\/c>/.test(sheet), 'the quantity is a number (9 after the edit)');
});

await check('an automation writes a value typed as its field: a choice list for a select; the weekly schedule can run one row at a time', async () => {
  const noConditions = { join: 'and', conditions: [] };
  await seed({
    automations: [
      { id: 'auto-set', name: 'Set stage', enabled: false, created_at: 1, updated_at: 1, trigger: { kind: 'record', table: TABLE, filter: noConditions },
        steps: [{ kind: 'set_field', table: TABLE, field: 'stage', value: 'Done' }], fired: {} },
      { id: 'auto-week', name: 'One a day', enabled: false, created_at: 2, updated_at: 2, trigger: { kind: 'schedule', table: TABLE, filter: noConditions, when: { mode: 'weekly', time: '09:00', days: [1, 2, 3, 4, 5], perTime: 1 } },
        steps: [{ kind: 'set_field', table: TABLE, field: 'stage', value: '' }], fired: {} },
    ],
  });
  await page.goto(t.url + '/#/automations');
  await page.reload();
  await page.getByRole('listitem').filter({ hasText: 'Set stage' }).click();
  const value = page.getByLabel('Value', { exact: true });
  eq(await value.evaluate((el) => el.tagName), 'SELECT', 'the value of a select field is a choice list');
  eq(await value.locator('option').allTextContents(), ['— none —', 'New', 'Done'], 'its choices');
  eq(await value.inputValue(), 'Done', 'the value picked');
  await page.getByRole('listitem').filter({ hasText: 'One a day' }).click();
  eq(await page.getByLabel('Rows each time', { exact: true }).inputValue(), 'one', 'one row each time');
});

await check('a weekly schedule that runs one row each time: each occurrence runs the next row in table order', async () => {
  const seededAt = Date.now();
  await seed({
    automations: [{
      id: 'auto-each', name: 'One each time', enabled: true, created_at: 3, updated_at: 3,
      trigger: { kind: 'schedule', table: TABLE, filter: { join: 'and', conditions: [] }, when: { mode: 'weekly', time: '00:00', days: [0, 1, 2, 3, 4, 5, 6], perTime: 1 }, lastDue: seededAt },
      steps: [{ kind: 'set_field', table: TABLE, field: 'stage', value: 'Done' }], fired: {},
    }],
  });
  await page.goto(t.url + '/#/automations');
  await page.reload();
  await page.waitForFunction(() => !!window.__dceRunAutomation);
  const DAY = 86400000;
  const occurrence = (now) => page.evaluate(([id, at]) => window.__dceRunAutomation(id, { now: at }).then((r) => r.sent), ['auto-each', now]);
  const stages = async () => (await shelfRows()).map((r) => `${r.data.name ?? ''}:${r.data.stage}`).filter((x) => !x.startsWith(':'));
  eq(await occurrence(seededAt + 3 * DAY), 1, 'the first occurrence runs one row');
  eq(await stages(), ['Alpha:Done', 'Charlie:New', 'Bravo:New', 'Delta:New'], 'only the first row in table order');
  eq(await occurrence(seededAt + 6 * DAY), 1, 'the next occurrence runs one row');
  eq(await stages(), ['Alpha:Done', 'Charlie:Done', 'Bravo:New', 'Delta:New'], 'the next row in table order');
});

await check('a built-in column of the Content Plan can be moved, and its place is kept after a restart', async () => {
  await page.goto(t.url + '/#/content');
  await page.reload();
  await page.waitForSelector('.vgrid-head');
  const before = await columnOrder();
  ok(before.findIndex((h) => h.includes('Publish Date')) > before.findIndex((h) => h.includes('Status')), 'Status starts before Publish Date');
  await page.locator('.vhead', { hasText: 'Status' }).first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Move right', exact: true }).click();
  await waitIdle(page, 400);
  let heads = await columnOrder();
  ok(heads.findIndex((h) => h.includes('Publish Date')) < heads.findIndex((h) => h.includes('Status')), 'Status moved after Publish Date');
  await page.reload();
  await page.waitForSelector('.vgrid-head');
  heads = await columnOrder();
  ok(heads.findIndex((h) => h.includes('Publish Date')) < heads.findIndex((h) => h.includes('Status')), 'after a restart');
});

await check('no console errors during the whole session', async () => {
  const real = errors.filter((e) => !/Failed to load resource/.test(e));
  ok(real.length === 0, real.slice(0, 3).join(' | '));
});

const failed = report();
await t.close();
process.exit(failed ? 1 : 0);
