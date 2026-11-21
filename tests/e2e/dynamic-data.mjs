/**
 * Templates draw their data from any table, built-in fields can be renamed, fields and tables can be copied, and the
 * Content Plan can be renamed (in the real app, headless Chromium, its own IndexedDB).
 * The custom table and its records are written into the database before the app starts; everything else is done
 * through the screens.
 */
import { check, dump, eq, ok, report, waitIdle } from './helpers.mjs';
import { launch } from './lib.mjs';

const t = await launch();
const { page, errors } = t;
const text = () => page.evaluate(() => document.body.innerText);
const TABLE = 'tProd';

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
const templateNamed = async (part) => (await dump(page, 'templates')).find((x) => x.name.includes(part));
const contentSetting = async () => (await dump(page, 'settings')).find((s) => s.key === 'table.content.name');

// first visit: the app creates its sample data (Content Plan records and the sample template)
await page.goto(t.url + '/#/workspace');
await page.waitForSelector('text=Workspace');
await seed({
  userTables: [{ id: TABLE, name: 'Products', created_at: 3 }],
  fields: [
    { id: 'fProdName', key: 'name', label: 'Name', type: 'text', order: 0, tableId: TABLE },
    { id: 'fProdPrice', key: 'price', label: 'Price', type: 'currency', currency: '$', order: 1, tableId: TABLE },
  ],
  rows: [rowBase(TABLE, 'p1', 1, { name: 'Desk lamp', price: 12 }), rowBase(TABLE, 'p2', 2, { name: 'Beaker set', price: 4 })],
});
await page.reload();
await page.waitForSelector('text=Products');

const tpl = await templateNamed('Product');
ok(tpl, 'the sample template exists');

await check('the Data tab chooses the table first, then lists that table’s fields; a binding to a missing field is flagged', async () => {
  await page.goto(t.url + '/#/editor/' + tpl.id);
  await page.waitForFunction(() => !!window.__dceEditor);
  const nodeId = await page.evaluate(() => window.__dceEditor.doc().nodes.find((n) => n.binding?.text?.template === '{{content.title}}').id);
  await page.evaluate((id) => window.__dceEditor.selectIds([id]), nodeId);
  await page.getByRole('tab', { name: 'Data', exact: true }).click();
  const tables = await page.getByLabel('Data table').locator('option').allTextContents();
  ok(tables.includes('Products') && tables.includes('Content Plan'), 'the table list has the custom table and the Content Plan: ' + tables.join(' | '));
  await page.getByLabel('Data table').selectOption(TABLE);
  await page.waitForSelector('text=are not in “Products”');
  const bound = await page.getByLabel('Bound field').locator('option').allTextContents();
  ok(bound.some((x) => x.includes('Price') && x.includes('content.price')), 'the Price field of Products is offered: ' + bound.join(' | '));
  ok(!bound.some((x) => x.startsWith('Title')), 'the Content Plan fields are not offered for Products');
  await page.getByLabel('Bound field').selectOption('content.price');
  await waitIdle(page, 200);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await waitIdle(page, 500);
  const saved = await templateNamed('Product');
  eq(saved.doc.meta.dataTable, TABLE, 'the template remembers its data table');
  const node = saved.doc.nodes.find((n) => n.id === nodeId);
  eq(node.binding.text.template, '{{content.price}}', 'the element is bound to the field of the chosen table');
});

await check('the editor preview shows a record of the chosen table', async () => {
  await page.goto(t.url + '/#/editor/' + tpl.id);
  await page.waitForFunction(() => !!window.__dceEditor);
  await page.evaluate(() => window.__dceEditor.setPreview(true));
  await waitIdle(page, 300);
  const body = await text();
  ok(body.includes('Data preview: Desk lamp'), 'the preview names the first record of Products');
  const picker = await page.getByLabel('Preview record').locator('option').allTextContents();
  ok(picker.includes('Desk lamp') && picker.includes('Beaker set'), 'the record picker lists the records of Products: ' + picker.join(' | '));
});

await check('the Batch Runner renders the template for the records of its table and writes a job for that table', async () => {
  await page.goto(t.url + '/#/batch');
  await page.waitForSelector('text=Batch Runner');
  await page.getByRole('combobox', { name: /^Template/ }).selectOption(tpl.id);
  await page.waitForSelector('text=/Records from/');
  ok((await text()).includes('Products'), 'the batch names the table it renders from');
  await page.waitForSelector('text=/2 match/');
  await page.getByRole('button', { name: /Start rendering/ }).click();
  let job;
  for (let i = 0; i < 60 && !job?.status?.startsWith('completed'); i++) {
    await waitIdle(page, 250);
    job = (await dump(page, 'jobs')).find((j) => j.templateId === tpl.id && j.table === TABLE);
  }
  ok(job, 'a job for the Products table was written');
  eq([job.total, job.success], [2, 2], 'both Products records were rendered');
});

await check('a built-in field can be renamed and its choices changed; its key and type stay', async () => {
  await page.goto(t.url + '/#/content');
  await page.waitForSelector('.vgrid-head');
  await page.locator('.vhead', { hasText: 'Title' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: /Edit name and choices/ }).click();
  const d = page.getByRole('dialog', { name: 'Edit built-in field' });
  await d.getByLabel('Name', { exact: true }).fill('Headline');
  await d.getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForSelector('.vhead:has-text("Headline")');
  const row = (await dump(page, 'fields')).find((f) => f.id === 'b_title');
  eq([row.key, row.label, row.builtin === true], ['title', 'Headline', true], 'stored as an override of the built-in field');
  ok(!(await dump(page, 'fields')).some((f) => f.key === 'title' && !f.builtin), 'no second “title” field was created');
});

await check('a default value for new records: the Status default is chosen in the field dialog and new records start with it', async () => {
  await page.goto(t.url + '/#/content');
  await page.waitForSelector('.vgrid-head');
  await page.locator('.vhead', { hasText: 'Status' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: /Edit name and choices/ }).click();
  const d = page.getByRole('dialog', { name: 'Edit built-in field' });
  await d.getByLabel('Default choice').selectOption('In review');
  await d.getByRole('button', { name: 'Save', exact: true }).click();
  await waitIdle(page, 300);
  eq((await dump(page, 'fields')).find((f) => f.id === 'b_status').defaultValue, 'In review', 'the default is stored on the built-in field');
  await page.getByRole('button', { name: 'New record', exact: true }).click();
  await waitIdle(page, 400);
  const newest = [...(await dump(page, 'records'))].sort((a, b) => b.created_at - a.created_at)[0];
  eq(newest.status, 'In review', 'a new record starts with the default choice');
});

await check('a field can be copied from the Fields panel, and the table structure can be copied for an AI prompt', async () => {
  await page.getByRole('button', { name: 'Fields', exact: true }).click();
  await page.getByRole('button', { name: 'Copy the settings of Headline' }).click();
  await waitIdle(page, 200);
  const one = await page.evaluate(() => navigator.clipboard.readText());
  ok(one.includes('Headline (key: title)') && one.includes('built-in'), 'the field settings are copied: ' + one);
  await page.getByRole('button', { name: /Copy table structure/ }).click();
  await waitIdle(page, 200);
  const structure = await page.evaluate(() => navigator.clipboard.readText());
  ok(structure.startsWith('Table: Content Plan') && structure.includes('Records:') && structure.includes('- Headline'), 'the table structure is copied');
  await page.keyboard.press('Escape');
});

await check('the Content Plan can be renamed; the sidebar and the header show the new name', async () => {
  await page.goto(t.url + '/#/content');
  await page.waitForSelector('.vgrid-head');
  await page.getByRole('button', { name: 'Rename table' }).click();
  const d = page.getByRole('dialog', { name: 'Rename table' });
  await d.getByLabel('Table name').fill('Campaign plan');
  await d.getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForSelector('h1:has-text("Campaign plan")');
  ok((await page.getByRole('link', { name: /Campaign plan/ }).count()) >= 1, 'the sidebar uses the new name');
  eq((await contentSetting())?.value, 'Campaign plan', 'the new name is kept as a setting');
});

await check('the Content Plan cannot be deleted; its built-in fields that are for storage start hidden', async () => {
  ok((await page.getByRole('button', { name: 'Delete table' }).count()) === 0, 'no Delete table button on the Content Plan');
  const heads = await page.getByRole('columnheader').allTextContents();
  ok(!heads.some((h) => h.includes('Record ID') || h.includes('Created At') || h.includes('Updated At')), 'the storage columns start hidden: ' + heads.join(' | '));
  ok(heads.some((h) => h.includes('Headline')), 'the renamed field is the first column');
});

await check('deleting a table brings the templates that drew from it back to the Content Plan', async () => {
  await page.goto(t.url + '/#/table/' + TABLE);
  await page.waitForSelector('.vgrid-head');
  await page.getByRole('button', { name: 'Delete table' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete table', exact: true }).click();
  await waitIdle(page, 600);
  const after = await templateNamed('Product');
  eq(after.doc.meta.dataTable, 'content', 'the template now draws from the Content Plan');
});

await check('no console errors during the whole session', async () => {
  const real = errors.filter((e) => !/Failed to load resource/.test(e));
  ok(real.length === 0, real.slice(0, 3).join(' | '));
});

const failed = report();
await t.close();
process.exit(failed ? 1 : 0);
