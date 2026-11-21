/**
 * Saved views of a table: save the search / filter / sort / hidden fields under a name, clear them, open the view again,
 * keep it after a reload, replace it by saving under the same name, and delete it. In the real app (headless Chromium).
 */
import { check, eq, ok, report } from './helpers.mjs';
import { launch } from './lib.mjs';

const t = await launch();
const { page, errors } = t;
const search = () => page.getByLabel('Search records');
const viewsButton = () => page.getByTestId('views-button');
const openPop = async () => { if (!(await page.getByTestId('views-pop').count())) await viewsButton().click(); await page.getByTestId('views-pop').waitFor(); };

await page.goto(t.url + '/#/content');
await page.waitForSelector('[role="grid"], .vgrid, table', { timeout: 30000 });
await search().waitFor();

await check('a new table starts with no saved views, and the button says so', async () => {
  ok(/Views/.test(await viewsButton().innerText()), 'the button is called Views');
  await openPop();
  ok(await page.getByText('No saved views yet').count() === 1, 'the empty hint is shown');
  await viewsButton().click();
});

await check('a search is saved under a name, and the button then shows that name', async () => {
  await search().fill('lab');
  await page.waitForTimeout(400);
  await openPop();
  await page.getByLabel('Name for the current view').fill('Lab topics');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForSelector('text=/View “Lab topics” saved/');
  await page.waitForFunction(() => /Lab topics/.test(document.querySelector('[data-testid="views-button"]')?.textContent ?? ''));
});

await check('"Show everything" clears the search; opening the view brings it back', async () => {
  await openPop();
  await page.getByRole('button', { name: /Show everything/ }).click();
  eq(await search().inputValue(), '', 'search cleared');
  await openPop();
  await page.getByRole('button', { name: 'Lab topics', exact: true }).click();
  eq(await search().inputValue(), 'lab', 'search restored by the view');
});

await check('the view is still there after a reload', async () => {
  await page.reload();
  await search().waitFor();
  await openPop();
  ok(await page.getByRole('button', { name: 'Lab topics', exact: true }).count() === 1, 'the saved view survives a reload');
  await viewsButton().click();
});

await check('saving under the same name replaces it (one view, new search); an empty name cannot be saved', async () => {
  await search().fill('plate');
  await page.waitForTimeout(400);
  await openPop();
  ok(await page.getByRole('button', { name: 'Save', exact: true }).isDisabled(), 'Save is off while the name is empty');
  await page.getByLabel('Name for the current view').fill('lab TOPICS');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForSelector('text=/saved/');
  await openPop();
  eq(await page.getByTestId('views-pop').getByRole('button', { name: /^lab topics$/i }).count(), 1, 'still one view with that name');
  await page.getByRole('button', { name: /Show everything/ }).click();
  await openPop();
  await page.getByTestId('views-pop').getByRole('button', { name: /^lab topics$/i }).click();
  eq(await search().inputValue(), 'plate', 'the replaced view holds the new search');
});

await check('a view can be deleted', async () => {
  await openPop();
  await page.getByRole('button', { name: 'Delete view lab TOPICS' }).click();
  await page.waitForSelector('text=No saved views yet');
});

await check('no console errors during the whole session', async () => {
  const real = errors.filter((e) => !/Failed to load resource/.test(e));
  ok(real.length === 0, real.slice(0, 3).join(' | '));
});

const failed = report();
await t.close();
process.exit(failed ? 1 : 0);
