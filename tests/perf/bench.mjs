/** Real-browser benchmarks against the production build. Prints a table and writes tests/perf/out/results.json. */
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { cpus, totalmem } from 'node:os';
import { fileURLToPath } from 'node:url';
import { launch } from '../e2e/lib.mjs';
import { dump } from '../e2e/helpers.mjs';

const OUTDIR = fileURLToPath(new URL('./out/', import.meta.url));
mkdirSync(OUTDIR, { recursive: true });
const R = { machine: { cpu: cpus()[0].model.trim(), logicalCores: cpus().length, ramGB: Math.round(totalmem() / 2 ** 30) }, when: new Date().toISOString(), results: {} };
const log = (k, v) => { R.results[k] = v; console.log(k.padEnd(46), typeof v === 'object' ? JSON.stringify(v) : v); };

const t = await launch({ viewport: { width: 1600, height: 950 } });
const { page, browser } = t;
page.setDefaultTimeout(120000);

function browserMemMB() {
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command',
      "(Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Where-Object { $_.ExecutablePath -like '*ms-playwright*' } | Measure-Object WorkingSetSize -Sum).Sum"], { encoding: 'utf8', timeout: 20000 });
    return Math.round(Number(out.trim()) / 2 ** 20);
  } catch { return null; }
}
async function jsHeapMB() { return page.evaluate(() => (performance.memory ? Math.round(performance.memory.usedJSHeapSize / 2 ** 20) : null)); }

async function addDemo(n) {
  await page.goto(t.url + '/#/content');
  await page.waitForSelector('.vgrid-row');
  const before = Number(/of ([\d,]+) records/.exec(await page.locator('.statusbar').innerText())[1].replace(/,/g, ''));
  await page.getByRole('button', { name: /Add demo records/ }).click();
  await page.getByRole('dialog').getByRole('combobox').selectOption(String(n));
  const t0 = Date.now();
  await page.getByRole('button', { name: new RegExp(`^Add ${n.toLocaleString('en-US')} records`) }).click();
  await page.waitForFunction((want) => new RegExp(`of ${want} records`).test(document.querySelector('.statusbar')?.textContent ?? ''), (before + n).toLocaleString('en-US'));
  return Date.now() - t0;
}

async function gridMetrics(label) {
  const t0 = Date.now();
  await page.goto(t.url + '/#/content');
  await page.reload();
  await page.waitForSelector('.vgrid-row');
  const loadMs = Date.now() - t0;
  const domRows = await page.locator('.vgrid-row').count();
  const total = Number(/of ([\d,]+) records/.exec(await page.locator('.statusbar').innerText())[1].replace(/,/g, ''));
  // scroll the virtualised grid in 60 steps and measure frame pacing with rAF
  const scroll = await page.evaluate(async () => {
    const el = document.querySelector('.vgrid-scroll');
    const frames = [];
    let last = performance.now(), running = true;
    const tick = (now) => { frames.push(now - last); last = now; if (running) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    const max = el.scrollHeight - el.clientHeight;
    const t0 = performance.now();
    for (let i = 0; i <= 120; i++) { el.scrollTop = (max * i) / 120; await new Promise((r) => requestAnimationFrame(r)); }
    const dt = performance.now() - t0;
    running = false;
    frames.sort((a, b) => a - b);
    return { ms: Math.round(dt), p50: +frames[Math.floor(frames.length * 0.5)].toFixed(1), p95: +frames[Math.floor(frames.length * 0.95)].toFixed(1), worst: +frames[frames.length - 1].toFixed(1), frames: frames.length };
  });
  const smooth = await page.evaluate(async () => {
    const el = document.querySelector('.vgrid-scroll');
    el.scrollTop = 0; await new Promise((r) => requestAnimationFrame(r));
    const frames = []; let last = performance.now();
    for (let i = 1; i <= 120; i++) { el.scrollTop = i * 90; await new Promise((r) => requestAnimationFrame(r)); const n = performance.now(); frames.push(n - last); last = n; }
    frames.sort((a, b) => a - b);
    return { p50: +frames[60].toFixed(1), p95: +frames[114].toFixed(1), worst: +frames[119].toFixed(1) };
  });
  // search (waits for the status bar to change, then reports the real result)
  const status = () => page.evaluate(() => document.querySelector('.statusbar').textContent);
  const before = await status();
  const q0 = await page.evaluate(() => performance.now());
  await page.getByLabel('Search records').fill('Rotary Evaporator 10');
  await page.waitForFunction((was) => (document.querySelector('.statusbar')?.textContent ?? '') !== was, before);
  const searchMs = Math.round((await page.evaluate(() => performance.now())) - q0);
  const matches = Number(/^\s*([\d,]+) of/.exec(await status())[1].replace(/,/g, ''));
  await page.getByLabel('Search records').fill('');
  await page.waitForFunction((n) => (document.querySelector('.statusbar')?.textContent ?? '').trim().startsWith(`${n} of ${n}`), total.toLocaleString('en-US'));
  // sort by title
  const s0 = await page.evaluate(() => performance.now());
  await page.locator('.vhead', { hasText: 'Title' }).click();
  await page.waitForFunction(() => document.querySelector('.vhead[aria-sort="ascending"]'));
  const sortMs = Math.round((await page.evaluate(() => performance.now())) - s0);
  log(`${label}: grid ready after reload (ms)`, loadMs);
  log(`${label}: rows in DOM / total`, `${domRows} / ${total}`);
  log(`${label}: jump-scroll top→bottom (121 frames, worst case)`, scroll);
  log(`${label}: smooth scroll 90 px/frame × 120 frames`, smooth);
  log(`${label}: search "Rotary Evaporator 10" (ms, matches)`, `${searchMs} ms, ${matches} matches`);
  log(`${label}: sort by title (ms)`, sortMs);
}

// ---------------------------------------------------------------------------- 1,000 records
log('records seeded (sample)', (await dump(page, 'records')).length);
log('add 1,000 demo records (ms)', await addDemo(1000));
await gridMetrics('1k');

// ---------------------------------------------------------------------------- template load
{
  await page.goto(t.url + '/#/templates');
  await page.waitForSelector('.card');
  const t0 = Date.now();
  await page.getByRole('button', { name: 'Edit', exact: true }).first().click();
  await page.waitForFunction(() => window.__dceEditor && window.__dceEditor.canvas && window.__dceEditor.canvas.getObjects().length > 0);
  await page.waitForTimeout(50);
  log('template open → first paint in editor (ms)', Date.now() - t0);
  await page.goto(t.url + '/#/batch');
}

// ---------------------------------------------------------------------------- single render (main thread) + batches
async function batchRun(n, label) {
  await page.goto(t.url + '/#/batch');
  await page.waitForSelector('text=Source & template');
  await page.waitForTimeout(600);
  while (await page.getByRole('button', { name: 'Remove condition' }).count()) await page.getByRole('button', { name: 'Remove condition' }).first().click();
  await page.getByRole('button', { name: 'Range' }).click();
  await page.getByLabel('Range from').fill('1'); await page.getByLabel('Range to').fill(String(n));
  await page.waitForSelector(`button:has-text("Start rendering ${n.toLocaleString('en-US')} record")`);
  const prev = await page.locator('text=/rendered in \\d+ ms/').first().innerText().catch(() => '');
  const peak = { js: 0, proc: 0 };
  let sampling = true;
  const sampler = (async () => { while (sampling) { const js = await jsHeapMB(); if (js) peak.js = Math.max(peak.js, js); const pm = browserMemMB(); if (pm) peak.proc = Math.max(peak.proc, pm); await new Promise((r) => setTimeout(r, 400)); } })();
  const t0 = Date.now();
  await page.getByRole('button', { name: /Start rendering/ }).click();
  await page.getByRole('button', { name: /Download/ }).waitFor();
  const wall = Date.now() - t0;
  sampling = false; await sampler;
  const job = (await dump(page, 'jobs')).sort((a, b) => b.started_at - a.started_at)[0];
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /Download/ }).click()]);
  const size = statSync(await dl.path()).size;
  log(`${label}: ${n} records → PNG ZIP`, { wallMs: wall, jobElapsedMs: job.elapsedMs, perSecond: job.throughput, zipMB: +(size / 2 ** 20).toFixed(1), ok: job.success, failed: job.failure, peakMainJsHeapMB: peak.js, peakBrowserProcessTreeMB: peak.proc });
  return prev;
}

await page.goto(t.url + '/#/batch');
await page.waitForSelector('text=Source & template');
await page.waitForSelector('text=/rendered in \\d+ ms/');
log('single record render, main thread, 1080×1080 → PNG', (await page.locator('text=/rendered in \\d+ ms/').first().innerText()).trim());
await batchRun(100, 'batch');
// 1 worker vs 4 workers on 100 records
{
  await page.getByLabel('Worker count').selectOption('1');
  const t0 = Date.now();
  await page.getByRole('button', { name: /Start rendering/ }).click();
  await page.getByRole('button', { name: /Download/ }).waitFor();
  const job = (await dump(page, 'jobs')).sort((a, b) => b.started_at - a.started_at)[0];
  log('batch: same 100 records with ONE worker', { wallMs: Date.now() - t0, perSecond: job.throughput });
  await page.getByLabel('Worker count').selectOption('0');
}
await batchRun(1000, 'batch');

// ---------------------------------------------------------------------------- 10,000 records
log('add 10,000 demo records (2 × 5,000) (ms)', await addDemo(5000).then(async (a) => a + (await addDemo(5000))));
log('records now', (await dump(page, 'records')).length);
await gridMetrics('10k');
// indexed query on the Batch page (status = X over 10k records)
{
  await page.goto(t.url + '/#/batch');
  await page.waitForSelector('text=Source & template');
  await page.waitForTimeout(800);
  while (await page.getByRole('button', { name: 'Remove condition' }).count()) await page.getByRole('button', { name: 'Remove condition' }).first().click();
  await page.getByRole('button', { name: /Add condition/ }).click();
  await page.getByLabel('Field').first().selectOption('status');
  await page.getByLabel('Operator').first().selectOption('eq');
  await page.getByLabel('Value').first().selectOption('Approved');
  await page.waitForFunction(() => /uses index/.test(document.body.innerText));
  const approved = await page.locator('.chip.blue', { hasText: 'match' }).first().innerText();
  const t0 = await page.evaluate(() => performance.now());
  await page.getByLabel('Value').first().selectOption('Draft');
  await page.waitForFunction((was) => { const c = [...document.querySelectorAll('.chip.blue')].find((x) => /match/.test(x.textContent ?? '')); return c && c.textContent !== was; }, approved);
  const ms = Math.round((await page.evaluate(() => performance.now())) - t0);
  log('10k: indexed filter Status=Draft → matches', `${await page.locator('.chip.blue', { hasText: 'match' }).first().innerText()} in ${ms} ms (includes the 80 ms debounce)`);
}
await batchRun(1000, 'batch@10k-records');

log('console errors', t.errors.length);
writeFileSync(OUTDIR + 'results.json', JSON.stringify(R, null, 2));
console.log('\nwritten tests/perf/out/results.json');
await t.close();
