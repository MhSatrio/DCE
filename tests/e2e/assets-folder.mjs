/**
 * Assets → Browse folder: every drawing and picture of a folder you choose goes into the library, in a folder named after it;
 * files that are not images are skipped, and a second import adds nothing. The vector pack line has no description text.
 * In the real app (headless Chromium, its own IndexedDB).
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, dump, eq, makePng, ok, OUT, report } from './helpers.mjs';
import { launch } from './lib.mjs';

// a folder with two drawings, a picture and a file that is not an image
const dir = join(OUT, 'vier-test-pack');
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const svg = (n) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 60"><circle cx="${n * 20}" cy="30" r="20" fill="#2a6"/></svg>`;
writeFileSync(join(dir, 'beaker.svg'), svg(1), 'utf-8');
writeFileSync(join(dir, 'flask.svg'), svg(2), 'utf-8');
writeFileSync(join(dir, 'photo.png'), makePng(20, 20, [200, 30, 30]));
writeFileSync(join(dir, 'notes.txt'), 'not a drawing', 'utf-8');

const t = await launch();
const { page, errors } = t;
const text = () => page.evaluate(() => document.body.innerText);
const picker = () => page.locator('input[aria-label="Choose a folder of drawings"]');
const packRows = async () => (await dump(page, 'assets')).filter((a) => a.category === 'vier-test-pack');

await page.goto(t.url + '/#/assets');
await page.getByRole('button', { name: /Browse folder/ }).waitFor();

await check('the vector pack line has no description text; Browse folder is offered', async () => {
  const body = await text();
  ok(!body.includes('Installing again adds only what is missing'), 'the description under the pack button is gone');
  ok(!body.includes('VierApparatus vector drawings with no background'), 'the count sentence is gone');
  ok(await page.getByRole('button', { name: /Browse folder/ }).count() === 1, 'Browse folder is there');
});

await check('Browse folder: the drawings and pictures go into a folder named after the chosen folder; other files are skipped', async () => {
  await picker().setInputFiles(dir);
  await page.waitForSelector('text=/3 drawings added to “vier-test-pack”/');
  eq((await packRows()).map((a) => a.name).sort(), ['beaker.svg', 'flask.svg', 'photo.png'], 'the library rows');
  ok(await page.getByRole('button', { name: 'Folder vier-test-pack' }).count() === 1, 'the new folder is in the folder list');
});

await check('a second import of the same folder adds nothing', async () => {
  await picker().setInputFiles(dir);
  await page.waitForSelector('text=/Nothing new in “vier-test-pack”/');
  eq((await packRows()).length, 3, 'no duplicate rows');
});

await check('no console errors during the whole session', async () => {
  const real = errors.filter((e) => !/Failed to load resource/.test(e));
  ok(real.length === 0, real.slice(0, 3).join(' | '));
});

const failed = report();
await t.close();
process.exit(failed ? 1 : 0);
