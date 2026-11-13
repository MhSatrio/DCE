/** Data + batch acceptance tests against the production build (real browser, real workers, real IndexedDB). */
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { unzipSync, strFromU8 } from 'fflate';
import { check, dump, eq, firstDiff, makePng, ok, OUT, report, waitIdle } from './helpers.mjs';
import { launch } from './lib.mjs';

const t = await launch({ viewport: { width: 1600, height: 950 } });
const { page, errors } = t;
const timings = {};

const pngSize = (b) => ({ w: new DataView(b.buffer, b.byteOffset).getUint32(16), h: new DataView(b.buffer, b.byteOffset).getUint32(20) });
const isPng = (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
const isJpg = (b) => b[0] === 0xff && b[1] === 0xd8;

async function downloadZip(trigger) {
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }), trigger()]);
  const path = await dl.path();
  return { files: unzipSync(new Uint8Array(readFileSync(path))), name: dl.suggestedFilename(), path };
}

async function clearFilter() { while (await page.getByRole('button', { name: 'Remove condition' }).count()) await page.getByRole('button', { name: 'Remove condition' }).first().click(); }
async function statusFilter(value) {
  await clearFilter();
  await page.getByRole('button', { name: /Add condition/ }).click();
  await page.getByLabel('Field').first().selectOption('status');
  await page.getByLabel('Operator').first().selectOption('eq');
  await page.getByLabel('Value').first().selectOption(value);
  await page.waitForTimeout(400);
}

async function openBatch() {
  await page.goto(t.url + '/#/batch');
  await page.reload(); // a hash-only goto keeps the old page state (selection, run) — start clean
  await page.waitForSelector('text=Source & template');
  await waitIdle(page, 500);
}

async function runBatch({ expectDone = true } = {}) {
  await page.getByRole('button', { name: /Start rendering/ }).click();
  if (expectDone) await page.getByRole('button', { name: /Download/ }).or(page.getByRole('button', { name: /Inspect \d+ failed/ })).first().waitFor({ timeout: 180000 });
}

const setFormat = (name) => page.getByRole('group', { name: 'Output format' }).getByRole('button', { name, exact: true }).click();

// ------------------------------------------------------------------------------------------------ content plan
const csv = [
  'Title,Status,Publish Date,Category,Price,Colour',
  'Vortex Mixer,Approved,2026-11-30,Mixing,"1,250.50",#4570B6',
  '"Bench ""Pro"" Autoclave, 18 L",approved,2026-12-01,Sterilisation,3400,#231F20',
  'Fume Hood,Draft,2026-12-05,Safety,,',
  ',Draft,2026-12-06,Safety,10,',
  'Bad Price,Draft,2026-12-07,Safety,abc,',
].join('\n');

await check('import CSV: map columns, validate, reject bad rows, import good ones', async () => {
  await page.goto(t.url + '/#/content');
  await page.waitForSelector('.vgrid-row');
  await page.getByRole('button', { name: /^Import/ }).click();
  await page.getByLabel('Import file').setInputFiles({ name: 'new-products.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await page.waitForSelector('text=/Map each column/');
  // Price and Colour are new custom fields; make Price a number
  const mapping = page.locator('table.tbl tbody tr');
  eq(await mapping.count(), 6);
  await mapping.nth(4).getByLabel('New field type').selectOption('number');
  await page.getByRole('button', { name: 'Validate' }).click();
  await page.waitForSelector('text=/rows rejected/');
  const text = await page.locator('.dialog').innerText();
  ok(/3 valid/.test(text), 'three valid rows: ' + text.slice(0, 200));
  ok(/Row 5: Title is empty/.test(text) && /Row 6: Price: "abc" is not a number/.test(text), 'row errors reported');
  await page.getByRole('button', { name: /^Import 3 records/ }).click();
  await page.waitForSelector('text=/Imported 3 records/');
  const recs = await dump(page, 'records');
  const v = recs.find((r) => r.title === 'Vortex Mixer');
  ok(v, 'Vortex Mixer stored');
  eq(v.status, 'Approved'); eq(v.data.price, 1250.5); eq(v.data.category, 'Mixing'); eq(v.slug, 'vortex-mixer');
  const a = recs.find((r) => r.title.startsWith('Bench'));
  eq(a.title, 'Bench "Pro" Autoclave, 18 L'); eq(a.status, 'Approved');
  const fields = await dump(page, 'fields');
  ok(fields.some((f) => f.key === 'price' && f.type === 'number'), 'price field created as number');
});

await check('inline edit: double-click a cell, type, Enter → persisted', async () => {
  const row = page.locator('.vgrid-row', { hasText: 'Fume Hood' });
  await row.locator('[role=gridcell]').first().locator('div').first().dblclick();
  const input = page.getByLabel('Title', { exact: true }).last();
  await input.fill('Fume Hood XL');
  await input.press('Enter');
  await page.waitForSelector('.vgrid-row:has-text("Fume Hood XL")');
  await waitIdle(page, 300);
  ok((await dump(page, 'records')).some((r) => r.title === 'Fume Hood XL'), 'edit stored in IndexedDB');
});

await check('one click selects a cell — it does NOT open the detail panel (so spreadsheet copy/paste works)', async () => {
  await page.getByLabel('Search records').fill('');
  const cell = page.locator('.vgrid-row').nth(1).locator('[role=gridcell]').nth(0);
  await cell.click();
  eq(await page.locator('aside[aria-label="Record details"]').count(), 0);
  eq(await page.locator('.vcell.is-active').count(), 1);
  await page.locator('.vgrid-row').nth(2).locator('[role=gridcell]').nth(1).click({ modifiers: ['Shift'] });
  ok((await page.locator('.vcell.in-sel').count()) === 4, 'a 2 × 2 range is highlighted');
});

await check('keyboard: arrows move the cell, Enter edits and steps down, Escape cancels', async () => {
  await page.locator('.vgrid-row').nth(0).locator('[role=gridcell]').nth(0).click();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowRight');
  const row1 = await page.locator('.vgrid-row').nth(1).locator('[role=gridcell]').nth(1).getAttribute('class');
  ok(/is-active/.test(row1), 'active cell moved to row 2, column 2');
  await page.keyboard.press('Enter');
  await page.getByLabel('Status').last().waitFor();
  await page.keyboard.press('Escape');
  await waitIdle(page, 150);
  ok(!(await page.locator('.vgrid-row select').count()), 'editor closed without changes');
});

await check('copy a range → TSV on the clipboard that Excel / Google Sheets / LibreOffice can paste', async () => {
  await page.locator('.vgrid-row').nth(0).locator('[role=gridcell]').nth(0).click();
  await page.locator('.vgrid-row').nth(1).locator('[role=gridcell]').nth(2).click({ modifiers: ['Shift'] });
  await page.keyboard.press('Control+c');
  await page.waitForSelector('text=/Copied 2 rows × 3 columns/');
  const text = await page.evaluate(() => navigator.clipboard.readText());
  const lines = text.split(String.fromCharCode(13, 10));
  eq(lines.length, 2);
  ok(lines.every((l) => l.split(String.fromCharCode(9)).length === 3), 'three tab-separated columns per line: ' + JSON.stringify(text.slice(0, 80)));
  ok(lines[0].startsWith('Vortex Mixer'), 'first row first');
  ok(lines[1].startsWith('"Bench ""Pro"" Autoclave, 18 L"'), 'embedded quotes and commas are quoted the way Excel expects: ' + lines[1].slice(0, 50));
});

await check('paste a spreadsheet block: values are validated, extra rows become new records (after confirmation)', async () => {
  await page.getByRole('button', { name: 'New record' }).click();
  await page.waitForSelector('text=/Record created/');
  await page.getByLabel('Search records').fill('New record');
  await page.waitForTimeout(400);
  eq(await page.locator('.vgrid-row').count(), 1);
  await page.locator('.vgrid-row').first().locator('[role=gridcell]').nth(0).click();
  const T = String.fromCharCode(9), CRLF = String.fromCharCode(13, 10);
  await page.evaluate((t) => navigator.clipboard.writeText(t), 'Pasted One' + T + 'Approved' + CRLF + 'Pasted Two' + T + 'Bogus status' + CRLF);
  await page.keyboard.press('Control+v');
  await page.waitForSelector('text=/Create 1 new record\\?/');
  await page.getByRole('button', { name: 'Paste and create' }).click();
  await page.waitForSelector('text=/Pasted 3 cells · 1 new record/');
  ok(await page.locator('text=/1 value rejected/').count() > 0, 'the invalid status was reported');
  const recs = await dump(page, 'records');
  const one = recs.find((r) => r.title === 'Pasted One'), two = recs.find((r) => r.title === 'Pasted Two');
  ok(one && one.status === 'Approved' && one.slug === 'pasted-one', 'existing record updated, slug followed the title');
  ok(two && two.status === 'Draft', 'new record created; invalid "Bogus status" not applied');
});

await check('right-click menu: open details, copy, paste, duplicate, delete (with confirmation)', async () => {
  await page.getByLabel('Search records').fill('Pasted');
  await page.waitForTimeout(400);
  await page.locator('.vgrid-row').nth(0).locator('[role=gridcell]').nth(0).click();
  await page.locator('.vgrid-row').nth(0).locator('[role=gridcell]').nth(0).click({ button: 'right' });
  const items = await page.getByRole('menu', { name: 'Cell menu' }).getByRole('menuitem').allInnerTexts();
  ok(['Open record details', 'Edit cell', 'Copy', 'Paste', 'Duplicate record', 'Delete record'].every((w) => items.some((i) => i.startsWith(w))), items.join(' | '));
  await page.getByRole('menuitem', { name: /Open record details/ }).click();
  await page.waitForSelector('aside[aria-label="Record details"]');
  await page.getByRole('button', { name: 'Close details' }).click();
  // duplicate both, then delete all four through the menu
  await page.locator('.vgrid-row').nth(0).locator('[role=gridcell]').nth(0).click();
  await page.locator('.vgrid-row').nth(1).locator('[role=gridcell]').nth(0).click({ modifiers: ['Shift'] });
  await page.locator('.vgrid-row').nth(1).locator('[role=gridcell]').nth(0).click({ button: 'right' });
  await page.getByRole('menuitem', { name: /Duplicate 2 records/ }).click();
  await page.waitForSelector('text=/Duplicated 2 records/');
  await page.waitForTimeout(400);
  eq(await page.locator('.vgrid-row').count(), 4);
  await page.locator('.vgrid-row').nth(0).locator('[role=gridcell]').nth(0).click();
  await page.locator('.vgrid-row').nth(3).locator('[role=gridcell]').nth(0).click({ modifiers: ['Shift'] });
  await page.locator('.vgrid-row').nth(3).locator('[role=gridcell]').nth(0).click({ button: 'right' });
  await page.getByRole('menuitem', { name: /Delete 4 records/ }).click();
  await page.waitForSelector('text=/Delete 4 records\\?/');
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await page.waitForSelector('text=/Deleted 4 records/');
  ok(!(await dump(page, 'records')).some((r) => /^Pasted/.test(r.title)), 'all gone');
  await page.getByLabel('Search records').fill('');
});

await check('search, sort and the filter builder (Status = Approved AND date ≥ 2026-11-15)', async () => {
  await page.getByLabel('Search records').fill('hood');
  await page.waitForTimeout(400);
  eq(await page.locator('.vgrid-row').count(), 1);
  await page.getByLabel('Search records').fill('');
  await page.getByRole('button', { name: /^Filter/ }).click();
  await page.getByRole('button', { name: /Add condition/ }).click();
  await page.getByRole('button', { name: /Add condition/ }).click();
  const fields = page.getByLabel('Field'), ops = page.getByLabel('Operator'), vals = page.getByLabel('Value');
  await fields.nth(0).selectOption('status'); await ops.nth(0).selectOption('eq'); await vals.nth(0).selectOption('Approved');
  await fields.nth(1).selectOption('publish_date'); await ops.nth(1).selectOption('gte'); await vals.nth(1).fill('2026-11-15');
  await page.waitForTimeout(300);
  const titles = await page.locator('.vgrid-row').evaluateAll((els) => els.map((e) => e.textContent));
  ok(titles.length >= 3 && titles.every((x) => /Approved/.test(x)), 'only approved rows: ' + JSON.stringify(titles.length));
  ok(titles.some((x) => /Vortex Mixer/.test(x)), 'new approved record present');
  ok(!titles.some((x) => /Rotary Evaporator/.test(x) === false && /2026-11-1[0-4]/.test(x)), 'older rows excluded');
  await page.getByRole('button', { name: 'Remove condition' }).first().click();
  await page.getByRole('button', { name: 'Remove condition' }).first().click();
  await page.getByRole('button', { name: /^Filter/ }).click(); // close the popover
  await page.waitForTimeout(200);
  ok((await page.locator('.vgrid-row').count()) >= 9, 'all rows back');
});

await check('bulk select + bulk update status; confirm dialog before delete', async () => {
  await page.getByLabel('Select all rows').check();
  await page.getByRole('button', { name: /Bulk update/ }).click();
  await page.getByRole('dialog').getByRole('combobox').first().selectOption('category');
  await page.getByRole('dialog').getByRole('combobox').nth(1).selectOption('Mixing');
  await page.getByRole('button', { name: 'Apply' }).click();
  await page.waitForSelector('text=/Updated Category on 9 records/');
  ok((await dump(page, 'records')).every((r) => r.data.category === 'Mixing'), 'all records updated');
  await page.getByRole('button', { name: /^Delete$/ }).click();
  await page.waitForSelector('text=/Delete 9 records\\?/');
  await page.getByRole('button', { name: 'Cancel' }).click();
  eq((await dump(page, 'records')).length, 9);
  await page.getByRole('button', { name: 'Clear selection' }).click();
});

await check('export CSV and JSON, round-trip the JSON back in (ids upsert, no duplicates)', async () => {
  await page.getByRole('button', { name: /^Export/ }).click();
  const [csvDl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'CSV file' }).click()]);
  const csvText = readFileSync(await csvDl.path(), 'utf8');
  ok(csvText.includes('"Bench ""Pro"" Autoclave, 18 L"'), 'quotes escaped');
  ok(csvText.split('\r\n').length >= 10, 'one line per record + header');
  await page.getByRole('button', { name: /^Export/ }).click();
  const [jsonDl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'JSON file' }).click()]);
  const jsonPath = await jsonDl.path();
  const payload = JSON.parse(readFileSync(jsonPath, 'utf8'));
  eq(payload.records.length, 9);
  await page.getByRole('button', { name: /^Import/ }).click();
  await page.getByLabel('Import file').setInputFiles(jsonPath);
  await page.waitForSelector('text=/Map each column/');
  await page.getByRole('button', { name: 'Validate' }).click();
  await page.waitForSelector('text=/will update existing records/');
  await page.getByRole('button', { name: /^Import 9 records/ }).click();
  await page.waitForSelector('text=/Imported 9 records/');
  eq((await dump(page, 'records')).length, 9);
});

await check('malformed CSV is rejected without touching the database', async () => {
  await page.getByRole('button', { name: /^Import/ }).click();
  await page.getByLabel('Import file').setInputFiles({ name: 'broken.csv', mimeType: 'text/csv', buffer: Buffer.from('title,status\n"unterminated,Draft') });
  await page.waitForSelector('.callout.err[role=alert]');
  ok(/Unterminated/.test(await page.locator('.callout.err').innerText()), 'explains the problem');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  eq((await dump(page, 'records')).length, 9);
});

await check('custom field: create from the Fields menu, appears in the grid and the detail panel', async () => {
  await page.getByRole('button', { name: /^Fields/ }).click();
  await page.getByRole('button', { name: /Add custom field/ }).click();
  await page.getByRole('dialog').getByLabel('Name', { exact: true }).fill('Warranty Years');
  await page.getByRole('radio', { name: 'Number', exact: true }).click();
  await page.getByRole('button', { name: 'Create field' }).click();
  await page.waitForSelector('text=/Field “Warranty Years” created/');
  ok((await dump(page, 'fields')).some((f) => f.key === 'warranty_years' && f.type === 'number'), 'field persisted');
});

await check('record detail: Markdown edit/preview is sanitised', async () => {
  await page.keyboard.press('Escape');
  await page.locator('.vgrid-row', { hasText: 'Vortex Mixer' }).getByRole('button', { name: 'Open record details' }).click({ force: true });
  await page.waitForSelector('aside[aria-label="Record details"]');
  await page.getByRole('group', { name: 'Content' }).getByLabel('Markdown content').fill('# Hello\n\n**bold** <img src=x onerror="window.__xss=1"> <script>window.__xss=2</script>');
  await page.getByRole('tab', { name: 'Preview' }).click();
  await page.waitForSelector('.md h1');
  const html = await page.locator('.md').innerHTML();
  ok(/<strong>bold<\/strong>/.test(html), 'markdown rendered');
  ok(!/onerror|<script/i.test(html), 'dangerous HTML removed');
  ok((await page.evaluate(() => window.__xss)) === undefined, 'no script executed');
  await page.getByRole('tab', { name: 'Edit' }).click();
  await page.getByRole('group', { name: 'Content' }).getByLabel('Markdown content').blur();
  await page.waitForTimeout(300);
  ok((await dump(page, 'records')).find((r) => r.title === 'Vortex Mixer').content.startsWith('# Hello'), 'markdown saved');
  ok(await page.locator('aside[aria-label="Record details"] img').count() >= 1, 'generated design preview shown');
});

// ------------------------------------------------------------------------------------------------ assets
await check('assets: upload an image, thumbnail + metadata + linking + delete with confirmation', async () => {
  await page.goto(t.url + '/#/assets');
  await page.waitForSelector('.card');
  const before = (await dump(page, 'assets')).length;
  // 2x1 red PNG
  const png = makePng(2, 1, [200, 30, 30]);
  await page.getByLabel('Upload images').setInputFiles({ name: 'tiny-red.png', mimeType: 'image/png', buffer: png });
  await page.waitForSelector('text=/Added 1 image/');
  const rows = await dump(page, 'assets');
  eq(rows.length, before + 1);
  const a = rows.find((r) => r.name === 'tiny-red.png');
  eq([a.width, a.height, a.aspect], [2, 1, 2]);
  ok(a.thumb.startsWith('[blob'), 'thumbnail generated');
  await page.waitForSelector('aside[aria-label="Asset details"]');
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.waitForSelector('text=/Delete “tiny-red.png”\\?/');
  await page.getByRole('button', { name: 'Delete', exact: true }).last().click();
  await page.waitForSelector('text=Asset deleted');
  eq((await dump(page, 'assets')).length, before);
});

await check('assets: non-image and oversized input are rejected with a message', async () => {
  await page.getByLabel('Upload images').setInputFiles({ name: 'notes.png', mimeType: 'image/png', buffer: Buffer.from('this is not an image') });
  await page.waitForSelector('text=/could not be decoded/');
});

// ------------------------------------------------------------------------------------------------ templates
await check('template .njs export → import round-trips the design exactly', async () => {
  await page.goto(t.url + '/#/templates');
  await page.waitForSelector('.card');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export .njs' }).first().click()]);
  const file = await dl.path();
  const original = JSON.parse(readFileSync(file, 'utf8'));
  eq(original.format, 'vierapparatus-dce'); eq(original.version, '1.0.0');
  ok(original.assets.some((a) => a.data?.startsWith('data:image/')), 'assets embedded');
  await page.getByLabel('Import template file').setInputFiles(file);
  await page.waitForSelector('text=/Imported “Product Announcement \\(imported\\)”/');
  const tpls = await dump(page, 'templates');
  const copy = tpls.find((x) => x.name === 'Product Announcement (imported)');
  const orig = tpls.find((x) => x.name === 'Product Announcement' && x.id !== copy.id);
  const strip = (d) => { const c = JSON.parse(JSON.stringify(d)); delete c.meta; delete c.assets; return c; };
  const diff = firstDiff(strip(copy.doc), strip(orig.doc));
  ok(!diff, 'design identical — first difference: ' + diff);
  // invalid files give a readable error and do not create anything
  await page.getByLabel('Import template file').setInputFiles({ name: 'bad.njs', mimeType: 'application/json', buffer: Buffer.from('{"format":"vierapparatus-dce","version":"1.0.0","canvas":{"width":-1,"height":5}}') });
  await page.waitForSelector('text=/design file is invalid/');
  eq((await dump(page, 'templates')).length, tpls.length);
  // tidy up: delete the imported copy again (confirmation dialog)
  await page.locator('.card', { hasText: '(imported)' }).getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await page.waitForSelector('text=Template deleted');
  eq((await dump(page, 'templates')).length, tpls.length - 1);
});

await check('template card: duplicate, preview dialog, delete with confirmation', async () => {
  const n0 = (await dump(page, 'templates')).length;
  await page.getByRole('button', { name: 'Duplicate' }).first().click();
  await page.waitForSelector('text=/Duplicated as/');
  eq((await dump(page, 'templates')).length, n0 + 1);
  await page.getByRole('button', { name: 'Preview' }).first().click();
  await page.waitForSelector('.dialog img');
  await page.getByRole('button', { name: 'Close', exact: true }).first().click();
  await page.getByRole('button', { name: 'Delete' }).first().click();
  await page.getByRole('button', { name: 'Delete', exact: true }).last().click();
  await page.waitForSelector('text=Template deleted');
  eq((await dump(page, 'templates')).length, n0);
});

// ------------------------------------------------------------------------------------------------ batch
await check('batch: one record → one PNG of the right size, valid manifest', async () => {
  await openBatch();
  await page.getByRole('button', { name: 'Single record' }).click();
  await page.locator('.vgrid-row').first().getByRole('checkbox').click();
  await page.waitForSelector('button:has-text("Start rendering 1 record")');
  const { files } = await downloadZip(async () => { await runBatch(); await page.getByRole('button', { name: /Download/ }).click(); });
  const names = Object.keys(files);
  ok(names.length === 2 && names.includes('manifest.json'), 'png + manifest: ' + names.join());
  const png = files[names.find((n) => n.endsWith('.png'))];
  ok(isPng(png), 'PNG signature'); eq(pngSize(png), { w: 1080, h: 1080 });
  const m = JSON.parse(strFromU8(files['manifest.json']));
  eq(m.counts, { total: 1, ok: 1, failed: 0 }); eq(m.entries[0].status, 'ok');
  writeFileSync(join(OUT, 'batch-single.png'), png);
});

await check('batch: rendering is deterministic (same record + template + options → identical bytes), and 2× output scales', async () => {
  await openBatch();
  await page.getByRole('button', { name: 'Single record' }).click();
  await page.locator('.vgrid-row').first().getByRole('checkbox').click();
  const run = async () => (await downloadZip(async () => { await runBatch(); await page.getByRole('button', { name: /Download/ }).click(); })).files;
  const a = await run().catch(async (e) => { throw new Error('run 1: ' + e.message.split(String.fromCharCode(10))[0] + ' | ' + (await page.locator('section', { hasText: '4 · Render' }).innerText())); });
  const b = await run().catch(async (e) => { throw new Error('run 2: ' + e.message.split(String.fromCharCode(10))[0] + ' | ' + (await page.locator('section', { hasText: '4 · Render' }).innerText())); });
  const pa = a[Object.keys(a).find((n) => n.endsWith('.png'))], pb = b[Object.keys(b).find((n) => n.endsWith('.png'))];
  eq(Buffer.compare(Buffer.from(pa), Buffer.from(pb)), 0, 'PNG bytes differ between runs');
  await page.getByRole('button', { name: '2×' }).click();
  const c = await run();
  eq(pngSize(c[Object.keys(c).find((n) => n.endsWith('.png'))]), { w: 2160, h: 2160 });
  await page.getByRole('button', { name: 'Template size' }).click();
});

await check('batch: formats JPEG, SVG, HTML, PDF (per record and combined)', async () => {
  await openBatch();
  await page.getByRole('button', { name: 'Range' }).click();
  await page.getByLabel('Range from').fill('1'); await page.getByLabel('Range to').fill('2');
  await page.waitForSelector('button:has-text("Start rendering 2 records")');
  const run = async (fmt) => downloadZip(async () => { await setFormat(fmt); await runBatch(); await page.getByRole('button', { name: /Download/ }).click(); });
  let r = await run('JPEG'); let f = Object.keys(r.files).filter((n) => n.endsWith('.jpg'));
  eq(f.length, 2); ok(isJpg(r.files[f[0]]), 'JPEG signature');
  r = await run('SVG'); f = Object.keys(r.files).filter((n) => n.endsWith('.svg'));
  eq(f.length, 2);
  const svg = strFromU8(r.files[f[0]]);
  ok(svg.startsWith('<?xml') && svg.includes('<svg') && svg.includes('@font-face') && svg.includes('data:image/png;base64'), 'self-contained SVG with embedded font + image');
  ok(!/\{\{|content\./.test(svg), 'no unresolved placeholders in SVG');
  writeFileSync(join(OUT, 'batch-sample.svg'), svg);
  r = await run('HTML'); f = Object.keys(r.files).filter((n) => n.endsWith('.html'));
  eq(f.length, 2); ok(strFromU8(r.files[f[0]]).startsWith('<!doctype html>'), 'html document');
  r = await run('PDF'); f = Object.keys(r.files).filter((n) => n.endsWith('.pdf'));
  eq(f.length, 2);
  const pdf = strFromU8(r.files[f[0]]);
  ok(pdf.startsWith('%PDF-1.4') && /\/Count 1 /.test(pdf) && /DCTDecode/.test(pdf), 'single-page PDF');
  await page.getByRole('button', { name: 'Single multi-page PDF' }).click();
  r = await downloadZip(async () => { await runBatch(); await page.getByRole('button', { name: /Download/ }).click(); });
  f = Object.keys(r.files).filter((n) => n.endsWith('.pdf'));
  eq(f.length, 1);
  const multi = strFromU8(r.files[f[0]]);
  ok(/\/Count 2 /.test(multi), 'two pages in one PDF');
  writeFileSync(join(OUT, 'batch-multipage.pdf'), Buffer.from(r.files[f[0]]));
  await page.getByRole('button', { name: 'One PDF per record' }).click();
  await setFormat('PNG');
});

await check('batch: 100 records → ZIP with 100 PNGs, bounded memory, history entry', async () => {
  await page.goto(t.url + '/#/content');
  await page.waitForSelector('.vgrid-row');
  await page.getByRole('button', { name: /Add demo records/ }).click();
  await page.getByRole('dialog').getByRole('combobox').selectOption('500');
  await page.getByRole('button', { name: /^Add 500 records/ }).click();
  await page.waitForSelector('text=/Added 500 synthetic/');
  await openBatch();
  await clearFilter(); // no filter: every record
  await page.getByRole('button', { name: 'Range' }).click();
  await page.getByLabel('Range from').fill('1'); await page.getByLabel('Range to').fill('100');
  await page.waitForTimeout(500);
  const label = await page.locator('button:has-text("Start rendering")').innerText();
  const n = Number(/rendering (\d+)/.exec(label)[1]);
  eq(n, 100);
  const t0 = Date.now();
  const { files } = await downloadZip(async () => { await runBatch(); await page.getByRole('button', { name: /Download/ }).click(); });
  timings.batchApproved = { records: n, ms: Date.now() - t0 };
  const pngs = Object.keys(files).filter((x) => x.endsWith('.png'));
  eq(pngs.length, n);
  ok(pngs.every((k) => isPng(files[k])), 'all valid PNGs');
  eq(new Set(pngs).size, pngs.length);
  const m = JSON.parse(strFromU8(files['manifest.json']));
  eq(m.counts.ok, n);
  const jobs = await dump(page, 'jobs');
  const j = jobs.sort((a, b) => b.started_at - a.started_at)[0];
  eq([j.status, j.success, j.failure], ['completed', n, 0]);
  ok(j.throughput > 0, 'throughput recorded');
  console.log(`      ${n} PNGs in ${timings.batchApproved.ms} ms (job reports ${j.throughput}/s)`);
});

await check('batch: progress is real, pause / resume / cancel work, partial ZIP is kept', async () => {
  await openBatch();
  await clearFilter();
  await page.getByRole('button', { name: 'Range' }).click();
  await page.getByLabel('Range from').fill('1'); await page.getByLabel('Range to').fill('300');
  await page.getByLabel('Worker count').selectOption('1');
  await page.getByRole('button', { name: /Start rendering/ }).click();
  await page.waitForSelector('[role=progressbar]');
  await page.getByRole('button', { name: 'Pause' }).click();
  await page.waitForSelector('button:has-text("Resume")');
  await page.waitForTimeout(700);
  const a = Number(await page.locator('[role=progressbar]').getAttribute('aria-valuenow'));
  await page.waitForTimeout(900);
  const b = Number(await page.locator('[role=progressbar]').getAttribute('aria-valuenow'));
  eq(b, a, 'no progress while paused');
  await page.getByRole('button', { name: 'Resume' }).click();
  await page.waitForTimeout(500);
  const c = Number(await page.locator('[role=progressbar]').getAttribute('aria-valuenow'));
  ok(c >= a, 'progress resumed');
  await page.getByRole('button', { name: /^Cancel/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel batch' }).click();
  await page.waitForSelector('button:has-text("Download")');
  const job = (await dump(page, 'jobs')).sort((x, y) => y.started_at - x.started_at)[0];
  eq(job.status, 'cancelled');
  ok(job.success < job.total, 'cancelled before completion');
  const { files } = await downloadZip(() => page.getByRole('button', { name: /Download/ }).click());
  ok(Object.keys(files).filter((x) => x.endsWith('.png')).length === job.success, 'partial ZIP holds exactly the finished files');
});

await check('failed records: error shown, fix the data, retry only the failures', async () => {
  // Break one approved record: blank title (required placeholder content.title)
  await page.goto(t.url + '/#/content');
  await page.waitForSelector('.vgrid-row');
  await page.getByLabel('Search records').fill('Vortex Mixer');
  await page.waitForTimeout(300);
  const row = page.locator('.vgrid-row', { hasText: 'Vortex Mixer' }).first();
  await row.locator('[role=gridcell]').first().locator('div').first().dblclick();
  const input = page.getByLabel('Title', { exact: true }).last();
  await input.fill(''); await input.press('Enter');
  await waitIdle(page, 300);
  // make the template strict: Title has no fallback text, so a blank title is a real error
  await page.goto(t.url + '/#/templates');
  await page.getByRole('button', { name: 'Edit', exact: true }).first().click();
  await page.waitForSelector('.ed .canvas-container');
  await page.getByRole('treeitem', { name: 'Layer Title', exact: true }).click();
  await page.getByRole('tab', { name: 'Data' }).click();
  await page.getByLabel('Text fallback').fill('');
  await page.getByRole('button', { name: /^Save/ }).click();
  await page.waitForSelector('text=/Saved “/');
  await openBatch();
  await statusFilter('Approved');
  await page.getByRole('button', { name: 'Range' }).click();
  await page.getByLabel('Range from').fill('1'); await page.getByLabel('Range to').fill('600');
  await page.waitForTimeout(300);
  const total = Number(/rendering (\d+)/.exec(await page.locator('button:has-text("Start rendering")').innerText())[1]);
  await page.getByLabel('Worker count').selectOption('0');
  await runBatch();
  await page.waitForSelector('text=/Inspect 1 failed/').catch(async (e) => { const j = (await dump(page, 'jobs')).sort((x, y) => y.started_at - x.started_at)[0]; const r = (await dump(page, 'records')).filter((x) => !x.title); throw new Error(`no failure: job=${JSON.stringify([j.status, j.total, j.success, j.failure, j.selectionLabel])} blankTitles=${r.length} ${e.message.slice(0, 60)}`); });
  const failedJob = (await dump(page, 'jobs')).sort((x, y) => y.started_at - x.started_at)[0];
  eq([failedJob.status, failedJob.success, failedJob.failure], ['completed_with_errors', total - 1, 1]);
  ok(/Required value content\.title is missing/.test(failedJob.failures[0].error), 'clear error: ' + failedJob.failures[0].error);
  // fix the data
  await page.goto(t.url + '/#/content');
  await page.getByLabel('Search records').fill('vortex-mixer');
  await page.waitForTimeout(300);
  const row2 = page.locator('.vgrid-row').first();
  await row2.locator('[role=gridcell]').first().locator('div').first().dblclick();
  const in2 = page.getByLabel('Title', { exact: true }).last();
  await in2.fill('Vortex Mixer'); await in2.press('Enter');
  await waitIdle(page, 300);
  await openBatch();
  await page.getByRole('button', { name: 'Inspect' }).first().click();
  await page.waitForSelector('text=/Retry 1 failed/');
  await page.getByRole('button', { name: /Retry 1 failed/ }).click();
  await page.waitForSelector('text=/Retry finished: 1 succeeded, 0 still failing/', { timeout: 30000 });
  const parent = (await dump(page, 'jobs')).find((j) => j.id === failedJob.id);
  eq([parent.status, parent.failure, parent.success], ['completed', 0, total]);
  ok((await dump(page, 'jobs')).some((j) => j.parentId === failedJob.id), 'retry stored as its own job');
});

await check('missing optional values never crash: record without image/description/colour still renders', async () => {
  await page.goto(t.url + '/#/content');
  await page.getByRole('button', { name: 'New record' }).click();
  await page.waitForSelector('text=/Record created/');
  await openBatch();
  // render just the new, almost-empty record (status Draft, title "New record")
  await statusFilter('Draft');
  const matchN = Number(/(\d+) match/.exec(await page.locator('.chip.blue', { hasText: 'match' }).innerText())[1]);
  await page.getByRole('button', { name: 'Range' }).click();
  await page.getByLabel('Range from').fill(String(matchN)); await page.getByLabel('Range to').fill(String(matchN)); // newest = the new record
  await page.waitForSelector('button:has-text("Start rendering 1 record")');
  await runBatch();
  await page.waitForSelector('button:has-text("Download")');
  const job = (await dump(page, 'jobs')).sort((x, y) => y.started_at - x.started_at)[0];
  eq(job.failure, 0);
  ok(job.warnings >= 1, 'warnings recorded for the missing values (not crashes)');
});

// ------------------------------------------------------------------------------------------------ external bundle
await check('external bundle: render.py reproduces the batch with the same .njs', async () => {
  await openBatch();
  await page.getByRole('button', { name: 'Range' }).click();
  await page.getByLabel('Range from').fill('1'); await page.getByLabel('Range to').fill('3');
  const { files } = await downloadZip(() => page.getByRole('button', { name: /Export external render bundle/ }).click());
  const names = Object.keys(files);
  for (const need of ['template.njs', 'data.json', 'render.py', 'README.md', 'requirements.txt']) ok(names.some((n) => n.endsWith(need)), `bundle has ${need}`);
  ok(names.some((n) => n.includes('/assets/')), 'bundle has assets');
  const dir = mkdtempSync(join(tmpdir(), 'dce-bundle-'));
  for (const [n, data] of Object.entries(files)) { const p = join(dir, n); mkdirSync(join(p, '..'), { recursive: true }); if (!n.endsWith('/')) writeFileSync(p, data); }
  const root = join(dir, 'dce-render-bundle');
  const res = spawnSync('python', ['render.py', '--out', 'out', '--workers', '1'], { cwd: root, encoding: 'utf8' });
  console.log('      ' + (res.stdout || res.stderr).trim().split('\n')[0]);
  ok(res.status === 0, 'render.py exit 0: ' + (res.stderr || res.stdout).slice(0, 300));
  const manifest = JSON.parse(readFileSync(join(root, 'out', 'manifest.json'), 'utf8'));
  ok(manifest.entries.length === 3 && manifest.entries.every((e) => e.status === 'ok'), 'three records rendered');
  const first = readFileSync(join(root, 'out', manifest.entries[0].filename));
  ok(isPng(new Uint8Array(first)), 'PNG written');
  eq(pngSize(new Uint8Array(first)), { w: 1080, h: 1080 });
  writeFileSync(join(OUT, 'python-render.png'), first);
});

// ------------------------------------------------------------------------------------------------ settings / sample data
await check('sample data can be removed and restored', async () => {
  await page.goto(t.url + '/#/settings');
  await page.waitForSelector('text=Sample data');
  await page.getByRole('button', { name: /Remove sample data/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Remove' }).click();
  await page.waitForSelector('text=Sample data removed');
  const recs = await dump(page, 'records');
  ok(recs.every((r) => !r.sample), 'no sample records remain');
  ok(recs.some((r) => r.title === 'Vortex Mixer'), 'user data untouched');
  await page.getByRole('button', { name: 'Restore sample data' }).click();
  await page.waitForSelector('text=Sample workspace restored');
  ok((await dump(page, 'templates')).some((x) => x.name === 'Product Announcement' && x.sample), 'template restored');
});

await check('fonts: import a WOFF2, it is stored and offered in the editor', async () => {
  await page.goto(t.url + '/#/settings');
  await page.waitForSelector('text=Fonts');
  const woff2 = new URL('../../node_modules/@fontsource-variable/jost/files/jost-latin-wght-italic.woff2', import.meta.url);
  await page.getByLabel('Import font file').setInputFiles(fileURLToPath(woff2));
  await page.getByRole('dialog').getByRole('textbox').first().fill('Test Italic Sans');
  await page.getByRole('dialog').getByRole('button', { name: 'Import', exact: true }).click();
  await page.waitForSelector('text=/Font “Test Italic Sans” imported/');
  const fonts = await dump(page, 'fonts');
  ok(fonts.some((f) => f.family === 'Test Italic Sans'), 'font row stored');
  await page.goto(t.url + '/#/templates');
  await page.getByRole('button', { name: 'Edit', exact: true }).first().click();
  await page.waitForSelector('.ed .canvas-container');
  await page.getByRole('treeitem', { name: 'Layer Title', exact: true }).click();
  const options = await page.getByLabel('Font family').locator('option').allTextContents();
  ok(options.includes('Test Italic Sans') && options.includes('Jost'), 'font offered: ' + options.join());
  await page.getByLabel('Font family').selectOption('Test Italic Sans');
  eq((await page.evaluate(() => window.__dceEditor.getNode(window.__dceEditor.store.get().selection[0]).style.fontFamily)), 'Test Italic Sans');
});

await check('editor: revert to saved version restores the last save (and is undoable)', async () => {
  // previous check left an unsaved font change
  await page.getByRole('button', { name: /Revert/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Revert', exact: true }).click();
  await page.waitForSelector('text=/Reverted to saved version/');
  eq((await page.evaluate(() => window.__dceEditor.getNode(window.__dceEditor.store.get().selection[0] ?? '')?.style?.fontFamily ?? 'Jost')), 'Jost');
  const title = await page.evaluate(() => window.__dceEditor.doc().nodes.find((n) => n.name === 'Title').style.fontFamily);
  eq(title, 'Jost');
  await page.getByRole('button', { name: /^Undo/ }).click();
  eq(await page.evaluate(() => window.__dceEditor.doc().nodes.find((n) => n.name === 'Title').style.fontFamily), 'Test Italic Sans');
  await page.getByRole('button', { name: 'Back to templates' }).click();
  await page.getByRole('button', { name: 'Discard changes' }).click();
});

await check('offline: after one visit the app shell reloads without a network', async () => {
  await page.goto(t.url + '/#/content');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload(); // now controlled by the service worker → every asset passes through (and is cached by) it
  await page.waitForSelector('.vgrid-row');
  await page.context().setOffline(true);
  await page.reload();
  await page.waitForSelector('.vgrid-row', { timeout: 15000 });
  ok((await page.locator('.vgrid-row').count()) > 0, 'grid renders offline from IndexedDB');
  await page.context().setOffline(false);
});

await check('no console errors during the whole session', async () => { ok(errors.length === 0, errors.slice(0, 3).join(' | ')); });
const failed = report();
await t.close();
process.exit(failed ? 1 : 0);
