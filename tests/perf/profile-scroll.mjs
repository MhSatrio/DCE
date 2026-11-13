import { launch } from '../e2e/lib.mjs';
const t = await launch({ viewport: { width: 1600, height: 950 } });
const { page, context } = t;
page.setDefaultTimeout(120000);
await page.goto(t.url + '/#/content');
await page.waitForSelector('.vgrid-row');
await page.getByRole('button', { name: /Add demo records/ }).click();
await page.getByRole('dialog').getByRole('combobox').selectOption('1000');
await page.getByRole('button', { name: /^Add 1,000 records/ }).click();
await page.waitForFunction(() => /of 1,006 records/.test(document.querySelector('.statusbar')?.textContent ?? ''));
const cdp = await context.newCDPSession(page);
await cdp.send('Profiler.enable');
await cdp.send('Profiler.start');
const res = await page.evaluate(async () => {
  const el = document.querySelector('.vgrid-scroll');
  const max = el.scrollHeight - el.clientHeight;
  const frames = []; let last = performance.now();
  for (let i = 0; i <= 120; i++) { el.scrollTop = (max * i) / 120; await new Promise((r) => requestAnimationFrame(r)); const n = performance.now(); frames.push(n - last); last = n; }
  frames.sort((a, b) => a - b);
  return { p50: frames[60], p95: frames[114] };
});
const { profile } = await cdp.send('Profiler.stop');
const self = new Map();
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const dt = profile.timeDeltas; let total = 0;
profile.samples.forEach((id, i) => { const n = byId.get(id); const k = `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.split('/').pop()}:${n.callFrame.lineNumber}`; self.set(k, (self.get(k) ?? 0) + dt[i]); total += dt[i]; });
console.log(JSON.stringify(res), 'total ms', Math.round(total / 1000));
[...self].sort((a, b) => b[1] - a[1]).slice(0, 14).forEach(([k, v]) => console.log((v / 1000).toFixed(0).padStart(6), 'ms', k));
await t.close();
