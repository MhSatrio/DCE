/**
 * A template image taken from a web address in a record field, end to end in the real app (headless Chromium):
 *  - the editor's image picker offers "From a record field"; the chosen field is saved with the template;
 *  - the batch downloads each address (through the local relay, because the image server sends no CORS headers),
 *    draws it, and reports the records whose image cannot be downloaded, with the reason.
 * The image server is a local mock on 127.0.0.1; the relay runs in the test with the mock allowed (as in the other suites).
 */
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { crc32, deflateSync } from 'node:zlib';
import { strFromU8, unzipSync } from 'fflate';
import { check, dump, eq, makePng, ok, report, waitIdle } from './helpers.mjs';
import { launch } from './lib.mjs';

const require_ = createRequire(import.meta.url);
const { createRelay } = require_('../../server/relay-core.cjs');

// ------------------------------------------------------------------------------------------------ the image server (no CORS headers, on purpose)
const RED = makePng(64, 64, [220, 30, 30]);
/** A product photo: a dark grey background with a red square in the middle (what the cut-out must remove). */
function pngPattern(w, h, px) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) { const [r, g, b] = px(x, y); const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const PRODUCT = pngPattern(128, 128, (x, y) => (x >= 40 && x < 88 && y >= 40 && y < 88 ? [220, 30, 30] : [60, 60, 60]));
const hits = [];
const mock = createServer((req, res) => {
  hits.push({ path: req.url ?? '', ua: String(req.headers['user-agent'] ?? '') });
  switch (req.url) {
    case '/img/red.png': res.writeHead(200, { 'content-type': 'image/png' }); return res.end(RED);
    case '/img/product.png': res.writeHead(200, { 'content-type': 'image/png' }); return res.end(PRODUCT);
    case '/img/moved': res.writeHead(301, { location: '/img/red.png' }); return res.end();
    case '/img/page': res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<!doctype html><p>not an image</p>');
    default: res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not here');
  }
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const mockBase = `http://127.0.0.1:${mock.address().port}`;

const relay = createRelay({ origins: [], allowPrivateFetch: true });
await new Promise((r) => relay.listen(0, '127.0.0.1', r));
const relayBase = `http://127.0.0.1:${relay.address().port}`;

// ------------------------------------------------------------------------------------------------ the app
const t = await launch({ viewport: { width: 1600, height: 950 } });
const { page, errors } = t;

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

const contentRecord = (n, title, url) => ({
  id: `rimg${n}`, title, slug: title.toLowerCase().replace(/\s+/g, '-'), status: 'Approved', publish_date: '2026-11-15',
  content: '', image_asset: '', template_ref: '', tags: [], created_at: 9000 + n, updated_at: 9000 + n,
  data: url === undefined ? {} : { image_url: url },
});

// first visit: the sample data is created; then the test adds its setting, its field and its records
await page.goto(t.url + '/#/workspace');
await page.waitForSelector('text=Workspace');
await seed({
  settings: [{ key: 'relay.url', value: relayBase }],
  fields: [{ id: 'fRemoteImageUrl', key: 'image_url', label: 'Image URL', type: 'url', order: 50 }],
  records: [
    contentRecord(1, 'Remote PNG', `${mockBase}/img/red.png`),
    contentRecord(2, 'Remote moved', `${mockBase}/img/moved`),
    contentRecord(3, 'Remote missing', `${mockBase}/img/missing`),
    contentRecord(4, 'Remote page', `${mockBase}/img/page`),
    contentRecord(5, 'Remote blank'),
    contentRecord(6, 'Remote product', `${mockBase}/img/product.png`),
  ],
});
await page.reload();
await page.waitForSelector('text=Workspace');

const templateId = async () => (await dump(page, 'templates')).find((x) => x.name === 'Product Announcement')?.id;

await check('the editor’s image picker offers “From a record field”, and the chosen field is saved with the template', async () => {
  const id = await templateId();
  ok(id, 'the sample template exists');
  await page.goto(`${t.url}/#/editor/${id}`);
  await page.waitForSelector('.ed .canvas-container');
  await page.getByRole('treeitem', { name: 'Layer Product image' }).click();
  await page.getByRole('button', { name: 'Choose…' }).click();
  const d = page.getByRole('dialog');
  await d.getByRole('tab', { name: 'From a record field' }).click();
  await d.getByRole('button', { name: 'Use the field Image URL' }).click();
  await waitIdle(page, 300);
  const bound = await page.evaluate(() => {
    const node = window.__dceEditor.doc().nodes.find((n) => n.name === 'Product image');
    return node?.binding?.image?.key;
  });
  eq(bound, 'content.image_url', 'the image is now bound to the Image URL field');
  await page.getByRole('button', { name: /^Save/ }).click();
  await page.waitForSelector('text=/Saved “Product Announcement”/');
  const row = (await dump(page, 'templates')).find((x) => x.name === 'Product Announcement');
  const stored = JSON.stringify(row.doc.nodes.find((n) => n.name === 'Product image').binding);
  ok(stored.includes('content.image_url'), `the saved template keeps the binding (${stored.slice(0, 120)})`);
});

await check('the batch downloads each web address through the local helper, draws it, and reports the records it cannot download', async () => {
  const id = await templateId();
  await page.goto(t.url + '/#/batch');
  await page.reload();
  await page.waitForSelector('text=Source & template');
  await page.locator('select[aria-label="Template"]').selectOption(id);
  await waitIdle(page, 400);
  const before = new Set((await dump(page, 'jobs')).map((j) => j.id));
  await page.getByRole('button', { name: /Start rendering/ }).click();
  let job;
  for (let i = 0; i < 240; i++) {
    const fresh = (await dump(page, 'jobs')).filter((j) => !before.has(j.id)).sort((a, b) => b.started_at - a.started_at)[0];
    if (fresh && fresh.status !== 'running' && fresh.status !== 'preparing') { job = fresh; break; }
    await page.waitForTimeout(500);
  }
  ok(job, 'the batch job finished');
  console.log('      JOB', JSON.stringify({ status: job.status, success: job.success, failure: job.failure, warnings: job.warnings }));
  await page.getByRole('button', { name: /Download/ }).first().waitFor({ timeout: 60000 });
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }), page.getByRole('button', { name: /Download/ }).first().click()]);
  const zip = unzipSync(new Uint8Array(readFileSync(await dl.path())));
  const manifest = JSON.parse(strFromU8(zip['manifest.json']));
  const imageWarnings = manifest.entries.flatMap((e) => (e.warnings ?? []).filter((w) => /image/i.test(w)).map((w) => [e.record_id, w]));
  console.log('      IMAGE WARNINGS', JSON.stringify(imageWarnings));
  ok(job.templateId === id || job.config?.templateId === id, 'the job rendered the sample template');
  const failed = Object.fromEntries((job.failures ?? []).map((f) => [f.title, f.error]));
  eq(Object.keys(failed).sort(), ['Remote missing', 'Remote page'], 'exactly the two records without a downloadable image fail');
  ok(/not found \(HTTP 404\)/.test(failed['Remote missing'] ?? ''), `the missing image says why (${failed['Remote missing']})`);
  ok(/web page, not to an image/.test(failed['Remote page'] ?? ''), `the web page says why (${failed['Remote page']})`);
  ok(!imageWarnings.some(([id]) => id === 'rimg1' || id === 'rimg2'), 'the two downloaded images were drawn: no image warning on those records');
  ok(job.success >= 3, `the downloaded records and the records without an address rendered (${job.success} ok)`);
  const viaHelper = hits.filter((h) => h.path === '/img/red.png' && h.ua.startsWith('DCE-ImageFetch'));
  ok(viaHelper.length >= 1, 'the image was fetched by the local helper, not by the page (the server sends no CORS headers)');
  ok(hits.some((h) => h.path === '/img/moved' && h.ua.startsWith('DCE-ImageFetch')), 'a redirect was followed by the helper');
});

await check('“Automatically delete image background”: the flag is saved with the binding, and the batch draws the image without its background', async () => {
  const id = await templateId();
  await page.goto(`${t.url}/#/editor/${id}`);
  await page.waitForSelector('.ed .canvas-container');
  await page.getByRole('treeitem', { name: 'Layer Product image' }).click();
  await page.getByRole('tab', { name: 'Data' }).click();
  await page.getByLabel('Automatically delete image background').click();
  await waitIdle(page, 200);
  await page.getByRole('button', { name: /^Save/ }).click();
  await page.waitForSelector('text=/Saved “Product Announcement”/');
  const row = (await dump(page, 'templates')).find((x) => x.name === 'Product Announcement');
  eq(row.doc.nodes.find((n) => n.name === 'Product image').binding.image.cutout, true, 'the flag is saved with the template');

  await page.goto(t.url + '/#/batch');
  await page.reload();
  await page.waitForSelector('text=Source & template');
  await page.locator('select[aria-label="Template"]').selectOption(id);
  await waitIdle(page, 400);
  const before = new Set((await dump(page, 'jobs')).map((j) => j.id));
  await page.getByRole('button', { name: /Start rendering/ }).click();
  for (let i = 0; i < 240; i++) {
    const fresh = (await dump(page, 'jobs')).filter((j) => !before.has(j.id))[0];
    if (fresh && fresh.status !== 'running' && fresh.status !== 'preparing') break;
    await page.waitForTimeout(500);
  }
  await page.getByRole('button', { name: /Download/ }).first().waitFor({ timeout: 60000 });
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }), page.getByRole('button', { name: /Download/ }).first().click()]);
  const zip = unzipSync(new Uint8Array(readFileSync(await dl.path())));
  const name = Object.keys(zip).find((n) => n.startsWith('remote-product') && n.endsWith('.png'));
  ok(name, `the “Remote product” output is in the ZIP (${Object.keys(zip).slice(0, 8).join(', ')})`);
  const b64 = Buffer.from(zip[name]).toString('base64');
  // the output is decoded in the browser and sampled: a point of the photo’s background (dark grey before the cut-out), and one on the red square.
  // The frame behind the photo is light blue in the sample template, so a removed background shows that light colour.
  const px = await page.evaluate(async (data) => {
    const bin = atob(data);
    const bm = await createImageBitmap(new Blob([Uint8Array.from(bin, (c) => c.charCodeAt(0))], { type: 'image/png' }));
    const c = new OffscreenCanvas(bm.width, bm.height);
    const g = c.getContext('2d');
    g.drawImage(bm, 0, 0);
    const s = bm.width / 1080;   // the template is 1080 px wide
    const at = (x, y) => Array.from(g.getImageData(Math.round(x * s), Math.round(y * s), 1, 1).data.slice(0, 3));
    return { width: bm.width, background: at(560, 200), centre: at(780, 436) };
  }, b64);
  eq(px.width > 0, true, 'the output decodes');
  ok(px.background.every((v) => v >= 150), `the background of the photo was removed: the frame behind it shows (${px.background})`);
  ok(px.centre[0] > 150 && px.centre[1] < 110, `the product itself stays (${px.centre})`);
});

await check('Assets → From URL: an image on a server without CORS is imported through the helper; a web page is refused with the reason', async () => {
  await page.goto(t.url + '/#/assets');
  await page.reload();
  await page.getByRole('button', { name: 'From URL' }).click();
  const d = page.getByRole('dialog');
  await d.getByLabel('Image URL').fill(`${mockBase}/img/red.png`);
  await d.getByRole('button', { name: 'Import', exact: true }).click();
  await page.waitForSelector('text=/Imported red.png/');
  const row = (await dump(page, 'assets')).find((a) => a.name === 'red.png');
  ok(row && row.sourceUrl === `${mockBase}/img/red.png`, 'the image is in the library, with its address as the source');
  await page.getByRole('button', { name: 'From URL' }).click();
  await page.getByRole('dialog').getByLabel('Image URL').fill(`${mockBase}/img/page`);
  await page.getByRole('dialog').getByRole('button', { name: 'Import', exact: true }).click();
  await page.getByRole('dialog').getByText(/web page, not to an image/).waitFor();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
});

await check('no console errors during the whole session', async () => {
  const real = errors.filter((e) => !/Failed to load resource|Failed to fetch|CORS|net::ERR/.test(e));
  ok(real.length === 0, real.slice(0, 3).join(' | '));
});

const failed = report();
await t.close();
mock.close();
relay.close();
process.exit(failed ? 1 : 0);
