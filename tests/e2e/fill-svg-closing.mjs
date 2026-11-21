/**
 * Three features in the real app (headless Chromium, its own IndexedDB):
 *  - the fill handle of the content grid (copy down, counting numbers up with Shift, new records past the last row);
 *  - carousel tables with a closing slide, and the carousel following the closing image's public address;
 *  - the SVG editor: drag a point, recolour a shape, save into the same asset.
 * The source table is written straight into the database first; everything else goes through the screens.
 */
import { check, dump, eq, makePng, ok, report, waitIdle } from './helpers.mjs';
import { launch } from './lib.mjs';

const t = await launch({ viewport: { width: 1600, height: 950 } });
const { page, errors } = t;
const text = () => page.evaluate(() => document.body.innerText);
/** Opens a table from a fresh load, so no state from an earlier check is carried over. */
const openTable = async (id) => { await page.goto(t.url + '/#/table/' + id); await page.reload(); await page.waitForSelector('.vgrid-head'); };
/** The stored text of a blob (an SVG asset's file), read straight from IndexedDB. */
const blobText = (store, key) => page.evaluate(([st, k]) => new Promise((resolve, reject) => {
  const req = indexedDB.open('dce');
  req.onerror = () => reject(req.error);
  req.onsuccess = () => {
    const db = req.result;
    const g = db.transaction(st, 'readonly').objectStore(st).get(k);
    g.onerror = () => reject(g.error);
    g.onsuccess = async () => { const row = g.result; db.close(); resolve(row?.blob ? await row.blob.text() : null); };
  };
}), [store, key]);

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
const photos = (table) => dump(page, 'rows').then((rs) => rs.filter((r) => r.table === table).sort((a, b) => a.created_at - b.created_at));

// first visit: the app creates its sample data; then the test's own table is added, and the app is reloaded to read it
await page.goto(t.url + '/#/workspace');
await page.waitForSelector('text=Workspace');
await seed({
  userTables: [{ id: 'tImg', name: 'Images', created_at: 1 }],
  fields: [
    { id: 'fName', key: 'name', label: 'Name', type: 'text', order: 0, tableId: 'tImg' },
    { id: 'fUrl', key: 'image_url', label: 'Image URL', type: 'url', order: 1, tableId: 'tImg' },
    { id: 'fNote', key: 'note', label: 'Note', type: 'text', order: 2, tableId: 'tImg' },
    { id: 'fQty', key: 'qty', label: 'Qty', type: 'number', order: 3, tableId: 'tImg' },
  ],
  rows: [
    rowBase('tImg', 'img1', 11, { name: 'Photo 1', image_url: 'https://cdn.example/1.png', note: 'Hello', qty: 5 }),
    rowBase('tImg', 'img2', 12, { name: 'Photo 2', image_url: 'https://cdn.example/2.png', note: 'x2', qty: 0 }),
    rowBase('tImg', 'img3', 13, { name: 'Photo 3', image_url: 'https://cdn.example/3.png', note: 'x3', qty: 0 }),
    rowBase('tImg', 'img4', 14, { name: 'Photo 4', image_url: 'https://cdn.example/4.png', note: 'x4', qty: 0 }),
  ],
});
await page.reload();
await page.waitForSelector('text=Images');

/** The grid cell of a row in the column whose header contains `title`. */
async function cellOf(rowName, title) {
  await openTable('tImg');
  await page.waitForSelector(`text=${rowName}`);
  const heads = await page.locator('.vgrid-head .vhead').allInnerTexts();
  const col = heads.findIndex((h) => h.includes(title));
  ok(col > 0, `there is a “${title}” column (headers: ${heads.join(' | ')})`);
  return page.locator('.vgrid-row').filter({ hasText: rowName }).locator('.vcell').nth(col);
}
/** Drags the fill handle from its place to the middle of `rowName` (or `yOffset` px below it when given). */
async function dragHandleTo(rowName, yOffset = 0, shift = false) {
  const h = await page.locator('.fill-handle').boundingBox();
  ok(h, 'the selection shows its fill handle');
  const row = await page.locator('.vgrid-row').filter({ hasText: rowName }).boundingBox();
  const tx = h.x + h.width / 2, ty = row.y + row.height / 2 + yOffset;
  if (shift) await page.keyboard.down('Shift');
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(tx, ty, { steps: 12 });
  await page.mouse.up();
  if (shift) await page.keyboard.up('Shift');
  await waitIdle(page, 400);
}

await check('fill handle: dragging the corner of a text cell down copies it into the rows below', async () => {
  const cell = await cellOf('Photo 1', 'Note');
  await cell.click();
  await dragHandleTo('Photo 4');
  const rows = await photos('tImg');
  eq(rows.map((r) => r.data.note), ['Hello', 'Hello', 'Hello', 'Hello'], 'the three rows below took the value of the first');
});

await check('fill handle: with Shift held, a column of numbers counts on (5 → 6, 7, 8)', async () => {
  const cell = await cellOf('Photo 1', 'Qty');
  await cell.click();
  await dragHandleTo('Photo 4', 0, true);
  const rows = await photos('tImg');
  eq(rows.map((r) => r.data.qty), [5, 6, 7, 8], 'the numbers count up by one');
});

await check('fill handle: dragged past the last row, it creates new records after confirmation', async () => {
  // the selection is the last row's Qty (8); the handle goes two rows below the last row, into the empty space under the grid
  const cell = await cellOf('Photo 4', 'Qty');
  await cell.click();
  const last = await page.locator('.vgrid-row').filter({ hasText: 'Photo 4' }).boundingBox();
  await dragHandleTo('Photo 4', last.height * 2);
  const d = page.getByRole('dialog');
  await d.getByText(/Create 2 new records\?/).waitFor();
  await d.getByRole('button', { name: 'Fill and create' }).click();
  await waitIdle(page, 600);
  const rows = await photos('tImg');
  eq(rows.length, 6, 'two records were added');
  eq(rows.slice(4).map((r) => r.data.qty), [8, 8], 'the new records copy the value of the selection (no Shift)');
});

// ---- closing slide
await check('a closing image is picked in Assets and given its public address (the address shows on the card)', async () => {
  await page.goto(t.url + '/#/assets');
  await page.getByRole('button', { name: /Upload/ }).first().waitFor();
  await page.setInputFiles('input[aria-label="Upload images"]', { name: 'cta.png', mimeType: 'image/png', buffer: makePng(40, 40, [200, 40, 40]) });
  await page.waitForSelector('text=/Added 1 image/');
  await page.getByLabel('Public address').fill('https://cdn.example/cta.png');
  await page.getByLabel('Public address').press('Enter');
  await page.waitForSelector('text=/Public address saved/');
  await page.goto(t.url + '/#/assets');
  await page.waitForSelector('text=URL: https://cdn.example/cta.png');
  const a = (await dump(page, 'assets')).find((x) => x.name === 'cta.png');
  eq(a.publicUrl, 'https://cdn.example/cta.png', 'the address is stored on the image');
});

await check('a carousel table with a closing slide: each carousel ends with the closing image', async () => {
  await page.goto(t.url + '/#/workspace');
  await page.getByLabel('New table').click();
  const d = page.getByRole('dialog');
  await d.getByLabel('Table name').fill('Closing carousels');
  await d.getByRole('radio', { name: /Carousel table/ }).check();
  await d.getByLabel('Source table').selectOption({ label: 'Images' });
  await d.getByLabel('Image link field').selectOption({ label: 'Image URL' });
  await d.getByLabel('Up to 3 images').check();
  await d.getByLabel('Closing image').selectOption({ label: 'cta.png' });
  await d.getByRole('button', { name: 'Create carousel table' }).click();
  await page.waitForSelector('text=/Carousel table “Closing carousels” created/');
  const tables = await dump(page, 'userTables');
  const car = tables.find((x) => x.name === 'Closing carousels');
  eq(car.carousel.closingAsset, (await dump(page, 'assets')).find((x) => x.name === 'cta.png').id, 'the setting names the closing image');
  const carRows = (await dump(page, 'rows')).filter((r) => r.table === car.id).sort((a, b) => a.id.localeCompare(b.id));
  eq(carRows.map((r) => r.data.carousel), [
    'https://cdn.example/1.png, https://cdn.example/2.png, https://cdn.example/cta.png',
    'https://cdn.example/3.png, https://cdn.example/4.png, https://cdn.example/cta.png',
  ], 'two images and the closing image in each carousel');
  eq(carRows.map((r) => r.data.images), [3, 3], 'each carousel has 3 slides');
  globalThis.__closing = car.id;
});

await check('changing the closing image’s public address updates every carousel that ends with it', async () => {
  await page.goto(t.url + '/#/assets');
  await page.getByRole('button', { name: 'Asset cta.png' }).click();
  await page.getByLabel('Public address').fill('https://cdn.example/cta-v2.png');
  await page.getByLabel('Public address').press('Enter');
  await page.waitForSelector('text=/Public address saved/');
  await waitIdle(page, 500);
  const carRows = (await dump(page, 'rows')).filter((r) => r.table === globalThis.__closing);
  ok(carRows.every((r) => r.data.carousel.endsWith('cta-v2.png')), `the carousels use the new address: ${carRows.map((r) => r.data.carousel).join(' | ')}`);
});

// ---- SVG editor
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"><path fill="#ff0000" d="M10 10 L90 10 L50 90 Z"/></svg>';

// An uploaded SVG is rasterised on import (Assets says so); a vector asset comes from Trace to SVG or Save as new. The test
// writes a vector asset straight into the database, the same record a traced image makes.
await page.evaluate(async (svg) => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('dce'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const blob = new Blob([svg], { type: 'image/svg+xml' });
  const tx = db.transaction('assets', 'readwrite');
  tx.objectStore('assets').put({ id: 'svgShape1', name: 'shape.svg', mime: 'image/svg+xml', size: blob.size, width: 100, height: 100, aspect: 1, blob, thumb: blob, tags: [], category: 'Uncategorised', created_at: 500 });
  await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  db.close();
}, SVG);

await check('SVG editor: drag a point, recolour the shape, save into the same asset', async () => {
  await page.goto(t.url + '/#/assets');
  await page.reload();
  await page.getByRole('button', { name: 'Asset shape.svg' }).click();
  await page.getByRole('button', { name: 'Edit SVG' }).click();
  const d = page.getByRole('dialog');
  await d.locator('svg[aria-label="Vector drawing"]').waitFor();
  await d.getByRole('button', { name: /Shape 1 · 3 points/ }).click();
  const anchor = await d.locator('svg[aria-label="Vector drawing"] rect').first().boundingBox();
  await page.mouse.move(anchor.x + anchor.width / 2, anchor.y + anchor.height / 2);
  await page.mouse.down();
  await page.mouse.move(anchor.x + anchor.width / 2 + 40, anchor.y + anchor.height / 2 + 10, { steps: 8 });
  await page.mouse.up();
  await d.getByLabel('Recolour all 1 shapes of colour #ff0000').fill('#00ff00');
  await d.getByRole('button', { name: 'Save changes' }).click();
  await page.waitForSelector('text=/Saved. Every template/');
  const a = (await dump(page, 'assets')).find((x) => x.name === 'shape.svg');
  const svgText = await blobText('assets', a.id);
  ok(svgText.includes('#00ff00') && !svgText.includes('#ff0000'), 'the shape has the new colour');
  ok(!svgText.includes('M10 10 L90 10 L50 90 Z'), `the point moved (path now: ${svgText.match(/d="([^"]+)"/)?.[1]})`);
  ok(/viewBox="0 0 100 100"/.test(svgText), 'the drawing keeps its size');
  await d.getByText('Close', { exact: true }).click();
  await d.waitFor({ state: 'hidden' });
});

await check('SVG editor: undo brings the point back, and the stored file is only changed by Save', async () => {
  await page.goto(t.url + '/#/assets');
  await page.reload();
  await page.getByRole('button', { name: 'Asset shape.svg' }).click();
  const before = await blobText('assets', (await dump(page, 'assets')).find((x) => x.name === 'shape.svg').id);
  await page.getByRole('button', { name: 'Edit SVG' }).click();
  const d = page.getByRole('dialog');
  await d.locator('svg[aria-label="Vector drawing"]').waitFor();
  await d.getByRole('button', { name: /Shape 1 · 3 points/ }).click();
  const anchor = await d.locator('svg[aria-label="Vector drawing"] rect').first().boundingBox();
  await page.mouse.move(anchor.x + anchor.width / 2, anchor.y + anchor.height / 2);
  await page.mouse.down();
  await page.mouse.move(anchor.x + anchor.width / 2 - 30, anchor.y + anchor.height / 2, { steps: 6 });
  await page.mouse.up();
  const after = await blobText('assets', (await dump(page, 'assets')).find((x) => x.name === 'shape.svg').id);
  eq(after, before, 'nothing is saved while editing');
  await d.getByRole('button', { name: 'Undo' }).click();
  await d.getByText('Close', { exact: true }).click();
  await d.waitFor({ state: 'hidden' });
  const still = await blobText('assets', (await dump(page, 'assets')).find((x) => x.name === 'shape.svg').id);
  eq(still, before, 'closing after an undo saves nothing');
});

await check('no console errors during the whole session', async () => {
  const real = errors.filter((e) => !/Failed to load resource/.test(e));
  ok(real.length === 0, real.slice(0, 3).join(' | '));
});

const failed = report();
await t.close();
process.exit(failed ? 1 : 0);
