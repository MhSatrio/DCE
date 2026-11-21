/**
 * Carousel tables, the Master Field and synced-field marks, in the real app (headless Chromium, its own IndexedDB).
 * The source table and its people are written straight into the database before the app starts, so the test starts from
 * known data; everything after that is done through the screens.
 */
import { check, dump, eq, ok, report, waitIdle } from './helpers.mjs';
import { launch } from './lib.mjs';

const t = await launch();
const { page, errors } = t;
const text = () => page.evaluate(() => document.body.innerText);
/** Opens a table from a fresh load, so no state from an earlier check (an open dialog, a stale menu) is carried over. */
const openTable = async (id) => { await page.goto(t.url + '/#/table/' + id); await page.reload(); await page.waitForSelector('.vgrid-head'); };

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

// first visit: the app creates its sample data; then the test's own tables are added, and the app is reloaded to read them
await page.goto(t.url + '/#/workspace');
await page.waitForSelector('text=Workspace');
await seed({
  userTables: [{ id: 'tImg', name: 'Images', created_at: 1 }, { id: 'tPeople', name: 'People', created_at: 2 }],
  fields: [
    { id: 'fImgName', key: 'name', label: 'Name', type: 'text', order: 0, tableId: 'tImg' },
    { id: 'fImgUrl', key: 'image_url', label: 'Image URL', type: 'url', order: 1, tableId: 'tImg' },
    { id: 'fOwner', key: 'owner', label: 'Owner', type: 'link', order: 2, tableId: 'tImg', linkTable: 'tPeople', inverseKey: 'images' },
    { id: 'fOwnerEmail', key: 'owner_email', label: 'Owner email', type: 'text', order: 3, tableId: 'tImg', sync: { via: 'owner', source: 'email' } },
    { id: 'fPplName', key: 'name', label: 'Name', type: 'text', order: 0, tableId: 'tPeople' },
    { id: 'fPplEmail', key: 'email', label: 'Email', type: 'text', order: 1, tableId: 'tPeople' },
    { id: 'fPplImages', key: 'images', label: 'Images', type: 'link', order: 2, tableId: 'tPeople', linkTable: 'tImg', inverseKey: 'owner' },
  ],
  rows: [
    rowBase('tPeople', 'p1', 1, { name: 'Ana', email: 'ana@example.org', images: [] }),
    ...[1, 2, 3, 4].map((n) => rowBase('tImg', `img${n}`, 10 + n, { name: `Photo ${n}`, image_url: `https://cdn.example/${n}.png`, owner: ['p1'], owner_email: 'ana@example.org' })),
  ],
});
await page.reload();
await page.waitForSelector('text=Images');

await check('a carousel table is created from the images: one record per carousel of 3 images, with the URLs ready for Buffer', async () => {
  await page.goto(t.url + '/#/workspace');
  await page.getByLabel('New table').click();
  const d = page.getByRole('dialog');
  await d.getByLabel('Table name').fill('Carousels');
  await d.getByRole('radio', { name: /Carousel table/ }).check();
  await d.getByLabel('Source table').selectOption({ label: 'Images' });
  await d.getByLabel('Image link field').selectOption({ label: 'Image URL' });
  await d.getByLabel('Up to 3 images').check();
  await d.getByRole('button', { name: 'Create carousel table' }).click();
  await page.waitForSelector('text=/Carousel table “Carousels” created/');
  const tables = await dump(page, 'userTables');
  const car = tables.find((x) => x.name === 'Carousels');
  ok(car && car.carousel, 'the carousel table stores its setting');
  eq(car.carousel, { source: 'tImg', linkField: 'image_url', groupSize: 3 });
  const carRows = (await dump(page, 'rows')).filter((r) => r.table === car.id).sort((a, b) => a.id.localeCompare(b.id));
  eq(carRows.map((r) => r.data.name), ['Carousel 1', 'Carousel 2'], 'one record per carousel, named by its Master Field');
  eq(carRows[0].data.images, 3);
  eq(carRows[1].data.images, 1, 'the last carousel holds what is left');
  eq(carRows[0].data.carousel, 'https://cdn.example/1.png, https://cdn.example/2.png, https://cdn.example/3.png', 'the URLs, comma separated');
  const imgs = (await dump(page, 'rows')).filter((r) => r.table === 'tImg').sort((a, b) => a.created_at - b.created_at);
  eq(imgs.map((r) => r.data.carousel_page_no), [1, 2, 3, 1], 'each image has its page number');
  eq(imgs[3].data.carousel_page, [carRows[1].id], 'the fourth image links to the second carousel');
  ok((await dump(page, 'fields')).some((f) => f.tableId === 'tImg' && f.key === 'carousel_page' && f.type === 'link' && f.carouselPage), 'the source table has the Carousel Page field');
  globalThis.__car = car.id;
});

await check('the Carousel Page column reads “Page N of <carousel name>”', async () => {
  await openTable('tImg');
  await page.waitForSelector('text=Photo 1');
  const body = await text();
  ok(/Page 1 of Carousel 1/.test(body) && /Page 3 of Carousel 1/.test(body) && /Page 1 of Carousel 2/.test(body), 'the pages are shown with their carousel names');
});

await check('removing an image re-groups the carousels: the emptied carousel record is removed, no duplicate is made', async () => {
  await openTable('tImg');
  await page.waitForSelector('text=Photo 4');
  const row = page.locator('.vgrid-row').filter({ hasText: 'Photo 4' });
  await row.getByLabel('Select row').click();
  await page.getByRole('button', { name: /^Delete$/ }).click();
  await page.waitForSelector('text=/Delete 1 record\?/');
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await page.waitForSelector('text=/Deleted 1 record/');
  await waitIdle(page, 800);
  const carRows = (await dump(page, 'rows')).filter((r) => r.table === globalThis.__car);
  eq(carRows.map((r) => r.data.name), ['Carousel 1'], 'the carousel with no image left is gone');
  eq(carRows[0].data.images, 3, 'the remaining carousel is complete');
});

await check('“Set as Master Field”: the field moves to the first column, is marked, and names the records', async () => {
  await openTable('tImg');
  await page.waitForSelector('text=Photo 1');
  await page.locator('.vhead', { hasText: 'Image URL' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Set as Master Field' }).click();
  await waitIdle(page, 400);
  const masters = (await dump(page, 'settings')).find((s) => s.key === 'tables.masters');
  eq(masters.value, { tImg: 'image_url' }, 'the choice is stored per table');
  const firstTitle = await page.locator('.vgrid-head .vhead').nth(1).innerText();
  ok(/Image URL/.test(firstTitle), `the Master Field is the first column (first header: “${firstTitle}”)`);
  ok(await page.locator('.vhead', { hasText: 'Image URL' }).locator('text=master').count() === 1, 'the master column is marked');
});

await check('a synced field shows the lightning mark, and its tooltip says where it comes from', async () => {
  await openTable('tImg');
  await page.waitForSelector('text=Photo 1');
  const head = page.locator('.vhead', { hasText: 'Owner email' });
  eq(await head.getAttribute('title'), 'Linked to: People → Email', 'the tooltip names the linked table and field');
  ok(await head.locator('[aria-label="Synced field"]').count() === 1, 'the lightning mark is shown');
  ok(await page.locator('[aria-label="Has synced fields"]').count() >= 1, 'the sidebar marks the table with synced fields');
});

await check('a synced field cannot be made the Master Field', async () => {
  await page.locator('.vhead', { hasText: 'Owner email' }).click({ button: 'right' });
  ok((await text()).includes('A synced field cannot be the Master Field.'), 'the menu says why');
  ok(await page.getByRole('menuitem', { name: 'Set as Master Field' }).count() === 0, 'and offers no such action');
  await page.keyboard.press('Escape');
});

await check('a carousel table follows its source again after a restart: a link an older version left is replaced', async () => {
  const carouselTable = (await dump(page, 'userTables')).find((x) => x.carousel);
  ok(carouselTable, 'a carousel table exists');
  const rec = (await dump(page, 'rows')).find((r) => r.table === carouselTable.id);
  const before = rec.data.carousel;
  ok(before && !/drive\.google/.test(before), 'the URLs come from the source');
  // a stale Drive link, as the carousel table kept it after the source was changed to public addresses
  await seed({ rows: [{ ...rec, data: { ...rec.data, carousel: 'https://drive.google.com/uc?export=view&id=STALE' } }] });
  await page.reload();
  await waitIdle(page, 1500);
  const after = (await dump(page, 'rows')).find((r) => r.id === rec.id).data.carousel;
  eq(after, before, 'the URL field is the source’s again');
});

await check('no console errors during the whole session', async () => {
  const real = errors.filter((e) => !/Failed to load resource/.test(e));
  ok(real.length === 0, real.slice(0, 3).join(' | '));
});

const failed = report();
await t.close();
process.exit(failed ? 1 : 0);
