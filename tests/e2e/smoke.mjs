import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { launch } from './lib.mjs';

mkdirSync(fileURLToPath(new URL('./out/', import.meta.url)), { recursive: true });
const out = (n) => fileURLToPath(new URL(`./out/${n}.png`, import.meta.url));
const t = await launch();
const { page, errors } = t;
const pages = process.argv.slice(2).length ? process.argv.slice(2) : ['workspace', 'content', 'templates', 'assets', 'batch', 'settings'];
for (const name of pages) {
  await page.goto(t.url + '/#/' + (name === 'workspace' ? '' : name));
  await page.waitForTimeout(1800);
  await page.screenshot({ path: out(name) });
  console.log(name, 'ok');
}
console.log('errors:', errors);
await t.close();
