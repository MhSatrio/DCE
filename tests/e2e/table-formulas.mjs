/**
 * Formula fields, formulas in currency and number cells, the large formula editor, and Ctrl+Z / Ctrl+Y over table changes,
 * in the real app (headless Chromium, its own IndexedDB). The table is written straight into the database before the app
 * starts; everything after that is done through the screens.
 */
import { check, dump, eq, ok, report, waitIdle } from './helpers.mjs';
import { launch } from './lib.mjs';

const t = await launch();
const { page, errors } = t;
const text = () => page.evaluate(() => document.body.innerText);
const openTable = async (id) => { await page.goto(t.url + '/#/table/' + id); await page.reload(); await page.waitForSelector('.vgrid-head'); };
const rowsOf = async (table) => (await dump(page, 'rows')).filter((r) => r.table === table);
const byId = async (id) => (await rowsOf('tOrd')).find((r) => r.id === id);
const fieldsOf = async (table) => (await dump(page, 'fields')).filter((f) => f.tableId === table);
const undo = async () => { await page.keyboard.press('Control+z'); await waitIdle(page, 350); };
const redo = async () => { await page.keyboard.press('Control+Shift+z'); await waitIdle(page, 350); };
const shown = async (rowText, label) => (await (await cell(rowText, label)).innerText()).trim();

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
const rowBase = (table, id, created, data) => ({ id, table, created_at: created, updated_at: created, title: String(data.name ?? id), slug: '', status: 'Draft', publish_date: '', content: '', image_asset: '', template_ref: '', tags: [], data });

/** The grid cell of the row whose text contains `rowText`, in the column whose header contains `label`. */
async function cell(rowText, label) {
  const heads = await page.getByRole('columnheader').allTextContents();
  const i = heads.findIndex((h) => h.includes(label));
  ok(i >= 0, `no column “${label}” (columns: ${heads.join(' | ')})`);
  return page.locator('.vgrid-row', { hasText: rowText }).getByRole('gridcell').nth(i);
}

/** Double-clicks a cell, types `value` and presses Enter. */
async function typeIn(rowText, label, value) {
  const c = await cell(rowText, label);
  await c.dblclick();
  const input = c.getByLabel(label, { exact: true });
  await input.fill(value);
  await input.press('Enter');
  await waitIdle(page, 350);
}

// first visit: the app creates its sample data; then the test's table is added, and the app is reloaded to read it
await page.goto(t.url + '/#/workspace');
await page.waitForSelector('text=Workspace');
await seed({
  userTables: [{ id: 'tOrd', name: 'Orders', created_at: 1 }],
  fields: [
    { id: 'fOrdItem', key: 'item', label: 'Item', type: 'text', order: 0, tableId: 'tOrd' },
    { id: 'fOrdPrice', key: 'price', label: 'Price', type: 'currency', currency: '$', order: 1, tableId: 'tOrd' },
    { id: 'fOrdQty', key: 'qty', label: 'Qty', type: 'number', order: 2, tableId: 'tOrd' },
  ],
  rows: [
    rowBase('tOrd', 'o1', 1, { item: 'Pen', price: 2, qty: 3 }),
    rowBase('tOrd', 'o2', 2, { item: 'Book', price: 10, qty: 2 }),
  ],
});
await page.reload();
await page.waitForSelector('text=Orders');

await check('the table opens with its rows; the currency column shows money', async () => {
  await openTable('tOrd');
  await page.waitForSelector('text=Pen');
  const body = await text();
  ok(body.includes('$2.00') && body.includes('$10.00'), 'the amounts are formatted as money');
});

await check('Fields → Add custom field: a Formula field is created under “Calculated”', async () => {
  await page.getByRole('button', { name: 'Fields', exact: true }).click();
  await page.getByRole('button', { name: 'Add custom field' }).click();
  const d = page.getByRole('dialog', { name: 'Add a field' });
  await d.getByLabel('Name', { exact: true }).fill('Line total');
  await d.getByRole('radio', { name: 'Formula', exact: true }).click();
  await d.getByRole('button', { name: 'Create field' }).click();
  await page.getByRole('columnheader', { name: /Line total/ }).waitFor();
  const f = (await fieldsOf('tOrd')).find((x) => x.label === 'Line total');
  ok(f && f.type === 'formula' && f.key === 'line_total', 'the formula field is stored under its own key');
});

await check('typing “=[Price]*[Qty]” in a formula cell calculates the row and stores the formula', async () => {
  await typeIn('Pen', 'Line total', '=[Price]*[Qty]');
  eq(await shown('Pen', 'Line total'), '6', 'the result of 2 × 3');
  eq((await byId('o1')).data.line_total, '=[Price]*[Qty]', 'the formula is stored as typed');
});

await check('the large editor: the formula carries over, the result is live, a broken formula blocks Save, Insert adds a column, Ctrl+Enter saves', async () => {
  const c = await cell('Book', 'Line total');
  await c.dblclick();
  await c.getByLabel('Line total', { exact: true }).fill('=[Price]*[Qty]');
  await c.getByRole('button', { name: 'Open the large editor for Line total' }).click();
  const d = page.getByRole('dialog', { name: /Formula · Line total/ });
  await d.waitFor();
  eq(await d.getByLabel('Formula', { exact: true }).inputValue(), '=[Price]*[Qty]', 'the formula is carried over');
  await d.getByRole('button', { name: 'Copy formula', exact: true }).click();
  await waitIdle(page, 200);
  eq(await page.evaluate(() => navigator.clipboard.readText()), '=[Price]*[Qty]', 'the large editor copies the formula itself');
  eq((await d.getByLabel('Result value').innerText()).trim(), '20', 'the result for this row');
  await d.getByLabel('Formula', { exact: true }).fill('=[Price]*');
  ok(await d.getByRole('alert').count() > 0, 'a broken formula says what is wrong');
  ok(await d.getByRole('button', { name: 'Save', exact: true }).isDisabled(), 'Save waits for a valid formula');
  await d.getByLabel('Formula', { exact: true }).fill('=[Price]*');
  await d.getByRole('button', { name: 'Insert [Qty]' }).click();
  eq(await d.getByLabel('Formula', { exact: true }).inputValue(), '=[Price]*[Qty]', 'the column is inserted at the cursor');
  await d.getByLabel('Formula', { exact: true }).fill('=[Price]*[Qty]+1');
  eq((await d.getByLabel('Result value').innerText()).trim(), '21', 'the live result follows the text');
  await d.getByLabel('Formula', { exact: true }).press('Control+Enter');
  await waitIdle(page, 400);
  ok(await page.getByRole('dialog', { name: /Formula · Line total/ }).count() === 0, 'Ctrl+Enter closes the editor');
  eq(await shown('Book', 'Line total'), '21', 'the cell shows the saved result');
  eq((await byId('o2')).data.line_total, '=[Price]*[Qty]+1', 'the formula is stored');
});

await check('the record details show the formula of a calculated field, and copy it', async () => {
  await page.locator('.vgrid-row', { hasText: 'Book' }).getByRole('button', { name: 'Open record details' }).click();
  const drawer = page.getByRole('complementary', { name: 'Record details' });
  await drawer.waitFor();
  eq(await drawer.getByRole('textbox', { name: 'Line total', exact: true }).inputValue(), '=[Price]*[Qty]+1', 'the formula is shown, not the result');
  await drawer.getByRole('button', { name: 'Copy the formula of Line total' }).click();
  await waitIdle(page, 200);
  eq(await page.evaluate(() => navigator.clipboard.readText()), '=[Price]*[Qty]+1', 'the formula is copied');
  await page.getByRole('button', { name: 'Close details' }).click();
  await waitIdle(page, 200);
});

await check('a currency cell takes a formula: “=[Qty]*1.5” shows $4.50, and the formula column follows it', async () => {
  const c = await cell('Pen', 'Price');
  await c.dblclick();
  ok(await c.getByRole('button', { name: 'Open the large editor for Price' }).count() === 1, 'a currency cell has the large editor');
  await c.getByLabel('Price', { exact: true }).fill('=[Qty]*1.5');
  await c.getByLabel('Price', { exact: true }).press('Enter');
  await waitIdle(page, 350);
  eq(await shown('Pen', 'Price'), '$4.50', 'the currency shows the result');
  eq(await shown('Pen', 'Line total'), '13.5', 'the formula column uses the currency result (4.5 × 3)');
});

await check('copying a formula cell copies its result, not the formula', async () => {
  const c = await cell('Pen', 'Line total');
  await c.click();
  await c.click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^Copy/ }).click();
  await waitIdle(page, 300);
  eq(await page.evaluate(() => navigator.clipboard.readText()), '13.5', 'the clipboard gets the number a spreadsheet would show');
});

await check('a number cell accepts a formula too: “=2*3”', async () => {
  await typeIn('Book', 'Qty', '=2*3');
  eq(await shown('Book', 'Qty'), '6', 'the number shows the result');
  eq(await shown('Book', 'Line total'), '61', 'the row formula uses it (10 × 6 + 1)');
  eq((await byId('o2')).data.qty, '=2*3', 'the formula is stored as typed');
});

await check('Ctrl+Z undoes the last change; Ctrl+Shift+Z puts it back', async () => {
  await undo();
  eq((await byId('o2')).data.qty, 2, 'the quantity is back');
  ok((await text()).includes('Undone: saving record'), 'the message names the change');
  eq(await shown('Book', 'Line total'), '21', 'the formula column follows');
  await redo();
  eq((await byId('o2')).data.qty, '=2*3', 'the change is back');
  eq(await shown('Book', 'Line total'), '61');
});

await check('undoing everything: the formulas, the amounts and the field itself go back', async () => {
  for (let i = 0; i < 5; i++) await undo();
  ok(!(await fieldsOf('tOrd')).some((f) => f.label === 'Line total'), 'the field is removed');
  eq((await byId('o1')).data.price, 2, 'the price is back');
  eq((await byId('o2')).data.qty, 2, 'the quantity is back');
  ok((await byId('o1')).data.line_total === undefined, 'the formula is gone from the row');
  ok(await page.getByLabel('Undo', { exact: true }).isDisabled(), 'nothing is left to undo');
});

await check('Ctrl+Y brings the changes back one at a time, the field first', async () => {
  await page.keyboard.press('Control+y');
  await waitIdle(page, 350);
  ok((await fieldsOf('tOrd')).some((f) => f.label === 'Line total'), 'the field comes back first');
  for (let i = 0; i < 4; i++) { await page.keyboard.press('Control+y'); await waitIdle(page, 300); }
  eq((await byId('o2')).data.qty, '=2*3', 'the quantity formula');
  eq((await byId('o1')).data.price, '=[Qty]*1.5', 'the currency formula');
  eq((await byId('o1')).data.line_total, '=[Price]*[Qty]', 'the first row formula');
  eq((await byId('o2')).data.line_total, '=[Price]*[Qty]+1', 'the second row formula');
});

await check('adding a row is one change: Ctrl+Z removes it, Ctrl+Shift+Z adds it back', async () => {
  const n = (await rowsOf('tOrd')).length;
  await page.getByRole('button', { name: 'New row', exact: true }).click();
  await waitIdle(page, 400);
  eq((await rowsOf('tOrd')).length, n + 1, 'the row is added');
  await undo();
  eq((await rowsOf('tOrd')).length, n, 'Ctrl+Z removes it');
  ok((await text()).includes('Undone: add row'), 'the message names the change');
  await redo();
  eq((await rowsOf('tOrd')).length, n + 1, 'redo adds it back');
});

await check('no console errors during the whole session', async () => {
  const real = errors.filter((e) => !/Failed to load resource/.test(e));
  ok(real.length === 0, real.slice(0, 3).join(' | '));
});

const failed = report();
await t.close();
process.exit(failed ? 1 : 0);
