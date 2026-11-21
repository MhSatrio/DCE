/**
 * Downloading a template, in the real app (headless Chromium): the card’s and the editor’s “Download as…” menu gives the
 * design file and the drawing as PNG, JPEG, PDF, SVG and HTML, at the template’s size and named after it.
 */
import { readFileSync } from 'node:fs';
import { check, dump, eq, ok, report, waitIdle } from './helpers.mjs';
import { launch } from './lib.mjs';

const t = await launch({ viewport: { width: 1480, height: 900 } });
const { page, errors } = t;

const TEMPLATE = 'Product Announcement';
const card = () => page.locator('.card', { hasText: TEMPLATE });
const templateNamed = async (name) => (await dump(page, 'templates')).find((x) => x.name === name);

/** Clicks a menu item and returns the file the browser saved: its name and bytes. */
async function pick(item) {
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: item, exact: true }).click()]);
  return { name: dl.suggestedFilename(), bytes: readFileSync(await dl.path()) };
}

// the first visit creates the sample templates
await page.goto(t.url + '/#/workspace');
await page.waitForSelector('text=Workspace');
await page.goto(t.url + '/#/templates');
await page.waitForSelector(`text=${TEMPLATE}`);

await check('the card’s download button opens a menu of the design file and the drawing formats; Escape closes it', async () => {
  await card().getByRole('button', { name: 'Download as…' }).click();
  const menu = page.getByRole('menu', { name: 'Download as…' });
  await menu.waitFor();
  eq(await menu.getByRole('menuitem').allTextContents(), ['.njs design file', 'PNG image', 'JPEG image', 'PDF document', 'SVG drawing', 'HTML page'], 'the formats');
  await page.keyboard.press('Escape');
  eq(await page.getByRole('menu').count(), 0, 'the menu closes');
});

await check('PNG: the drawing is saved at the template’s own size, under the template’s name', async () => {
  await card().getByRole('button', { name: 'Download as…' }).click();
  const f = await pick('PNG image');
  eq(f.name, 'product-announcement.png', 'the file name');
  eq(f.bytes.subarray(1, 4).toString('latin1'), 'PNG', 'the file is a PNG');
  const tpl = await templateNamed(TEMPLATE);
  eq([f.bytes.readUInt32BE(16), f.bytes.readUInt32BE(20)], [tpl.width, tpl.height], 'the size of the template');
});

await check('JPEG, PDF, SVG and HTML are saved in their own formats, and the design file is the template’s JSON', async () => {
  const tpl = await templateNamed(TEMPLATE);
  await card().getByRole('button', { name: 'Download as…' }).click();
  const jpeg = await pick('JPEG image');
  eq(jpeg.name, 'product-announcement.jpg', 'the JPEG name');
  eq([jpeg.bytes[0], jpeg.bytes[1]], [0xff, 0xd8], 'a JPEG starts with its marker');

  await card().getByRole('button', { name: 'Download as…' }).click();
  const pdf = await pick('PDF document');
  eq(pdf.name, 'product-announcement.pdf', 'the PDF name');
  eq(pdf.bytes.subarray(0, 5).toString('latin1'), '%PDF-', 'a PDF starts with its header');

  await card().getByRole('button', { name: 'Download as…' }).click();
  const svg = await pick('SVG drawing');
  eq(svg.name, 'product-announcement.svg', 'the SVG name');
  ok(svg.bytes.toString('utf8').includes('<svg'), 'the SVG is a drawing');

  await card().getByRole('button', { name: 'Download as…' }).click();
  const html = await pick('HTML page');
  eq(html.name, 'product-announcement.html', 'the HTML name');
  ok(html.bytes.toString('utf8').toLowerCase().startsWith('<!doctype html>'), 'the HTML is a page');

  await card().getByRole('button', { name: 'Download as…' }).click();
  const njs = await pick('.njs design file');
  eq(njs.name, 'product-announcement.njs', 'the design file name');
  eq(JSON.parse(njs.bytes.toString('utf8')).canvas.width, tpl.width, 'the design file holds the template');
});

await check('the editor’s Download menu saves the template as it is on screen, unsaved changes included', async () => {
  const tpl = await templateNamed(TEMPLATE);
  await page.goto(`${t.url}/#/editor/${tpl.id}`);
  await page.waitForSelector('.ed .canvas-container');
  await waitIdle(page, 400);
  await page.getByLabel('Template name').fill('Export test');
  await waitIdle(page, 200);
  await page.getByRole('button', { name: 'Download as…' }).click();
  const f = await pick('JPEG image');
  eq(f.name, 'export-test.jpg', 'the name is the one on screen, not the saved one');
  eq([f.bytes[0], f.bytes[1]], [0xff, 0xd8], 'a JPEG');
});

await check('no console errors during the whole session', async () => {
  const real = errors.filter((e) => !/Failed to load resource/.test(e));
  ok(real.length === 0, real.slice(0, 3).join(' | '));
});

const failed = report();
await t.close();
process.exit(failed ? 1 : 0);
