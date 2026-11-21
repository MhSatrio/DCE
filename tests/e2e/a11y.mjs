/**
 * Accessibility scan (axe-core, WCAG 2 A and AA rules) of DCE's main screens in the real app.
 * Every violation is listed with the elements it is on. The check fails on any "critical" or "serious" one.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { check, ok, report } from './helpers.mjs';
import { launch } from './lib.mjs';

const require = createRequire(import.meta.url);
const axeSource = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

const t = await launch();
const { page } = t;
const screens = [
  ['workspace', '#/'], ['content plan', '#/content'], ['templates', '#/templates'], ['assets', '#/assets'],
  ['batch runner', '#/batch'], ['automations', '#/automations'], ['content pipeline', '#/pipeline'], ['settings', '#/settings'],
];
const found = [];
for (const [label, hash] of screens) {
  await page.goto(t.url + '/' + hash);
  await page.waitForTimeout(1500);
  await page.evaluate((src) => { if (!window.axe) (0, eval)(src); }, axeSource);
  const res = await page.evaluate(async () => {
    const r = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] } });
    return r.violations.map((v) => ({ id: v.id, impact: v.impact, n: v.nodes.length, help: v.help, where: v.nodes.slice(0, 3).map((n) => n.target.join(' ') + (v.id === 'color-contrast' ? ' [' + (n.any[0]?.message ?? '') + ']' : '')).join(' | ') }));
  });
  for (const v of res) {
    console.log(`  [a11y] ${label}: ${v.impact} ${v.id} (${v.n}) - ${v.help} @ ${v.where}`);
    if (v.impact === 'critical' || v.impact === 'serious') found.push(`${label}: ${v.id}`);
  }
}
await check('no critical or serious accessibility violation (axe, WCAG 2 A/AA) on the eight main screens', async () => {
  ok(found.length === 0, found.join('; '));
});

const failed = report();
await t.close();
process.exit(failed ? 1 : 0);
