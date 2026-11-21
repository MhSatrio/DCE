/**
 * The asset library and the template editor's rulers, in the real app (headless Chromium):
 *  - folders: a new folder, an upload into it (an SVG stays a vector), the VierApparatus vector pack into "VierAsset";
 *  - a traced image is edited as vector: its fill is changed and saved into the same asset, with no stroke left behind;
 *  - the Remove background dialog shows a preview and its options;
 *  - the template editor has rulers, and a guide can be pulled from a ruler and dragged back onto it.
 */
import { deflateSync, crc32 } from 'node:zlib';
import { check, dump, eq, ok, report, waitIdle } from './helpers.mjs';
import { launch } from './lib.mjs';

const t = await launch({ viewport: { width: 1600, height: 950 } });
const { page, errors } = t;

/** A PNG of a dark silhouette on a transparent background (what the trace is for). */
function pngSilhouette(w, h) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const body = (x - w / 2) ** 2 / (w * w * 0.12) + (y - h * 0.6) ** 2 / (h * h * 0.2) < 1;
      const head = (x - w / 2) ** 2 + (y - h * 0.28) ** 2 < (w * w) * 0.04;
      const o = y * (w * 4 + 1) + 1 + x * 4;
      const on = body || head;
      raw[o] = on ? 60 : 0; raw[o + 1] = on ? 60 : 0; raw[o + 2] = on ? 70 : 0; raw[o + 3] = on ? 255 : 0;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const SILHOUETTE = pngSilhouette(160, 160);
const SVG_TEXT = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"><path fill="#ff0000" d="M10 10 L90 10 L50 90 Z"/></svg>';

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

const assetsNamed = async (name) => (await dump(page, 'assets')).filter((a) => a.name === name);

await page.goto(t.url + '/#/assets');
await page.waitForSelector('text=Install vector pack');

await check('folders: a new folder is made, and an uploaded SVG goes into it as a vector (its text is kept)', async () => {
  await page.getByRole('button', { name: 'New folder' }).click();
  await page.getByLabel('New folder name').fill('Lab notes');
  await page.getByRole('button', { name: 'Create' }).click();
  await page.getByRole('button', { name: 'Folder Lab notes' }).waitFor();
  await page.getByRole('button', { name: 'Folder Lab notes' }).click();
  await page.setInputFiles('input[aria-label="Upload images"]', { name: 'shape.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(SVG_TEXT) });
  await page.waitForSelector('text=/Added 1 image/');
  const row = (await assetsNamed('shape.svg'))[0];
  ok(row, 'the SVG was added');
  eq(row.category, 'Lab notes', 'it went into the open folder');
  eq(row.mime, 'image/svg+xml', 'it is a vector asset');
  ok((await blobText('assets', row.id)).includes('<path'), 'its drawing text is kept, so it can be edited');
});

await check('the vector pack installs 50 drawings into “VierAsset”, and installing again adds nothing', async () => {
  await page.getByRole('button', { name: /Install vector pack/ }).click();
  await page.waitForSelector('text=/vector drawings? added to “VierAsset”/', { timeout: 180000 });
  const first = (await dump(page, 'assets')).filter((a) => a.category === 'VierAsset');
  eq(first.length, 50, 'fifty drawings in the folder');
  ok(first.every((a) => a.mime === 'image/svg+xml' && a.raster), 'each is a vector with a picture for the templates');
  await page.getByRole('button', { name: /Install vector pack/ }).click();
  await page.waitForSelector('text=/already there/', { timeout: 180000 });
  eq((await dump(page, 'assets')).filter((a) => a.category === 'VierAsset').length, 50, 'no duplicates');
});

await check('a traced image is edited as vector: its fill is changed, the new colour is saved into the same asset, no stroke is left', async () => {
  await page.getByRole('button', { name: 'Folder Lab notes' }).click();
  await page.setInputFiles('input[aria-label="Upload images"]', { name: 'silhouette.png', mimeType: 'image/png', buffer: SILHOUETTE });
  await page.waitForSelector('text=/Added 1 image/');
  await page.getByRole('button', { name: 'Asset silhouette.png' }).click();
  await page.getByRole('button', { name: 'Trace to SVG' }).click();
  const tr = page.getByRole('dialog');
  eq(await tr.getByLabel('Trace mode').inputValue(), 'areas', 'the colour-areas trace is the default');
  await tr.getByRole('button', { name: 'Trace', exact: true }).click();
  await page.waitForSelector('text=/Traced: a new editable SVG/');
  await page.getByRole('button', { name: 'Asset silhouette (traced).svg' }).click();
  await page.getByRole('button', { name: 'Edit SVG' }).click();
  const d = page.getByRole('dialog');
  await d.locator('svg[aria-label="Vector drawing"]').waitFor();
  await d.getByRole('button', { name: /Shape 1 ·/ }).click();
  await d.getByLabel('Fill colour of the selected shape').fill('#00ff00');
  await d.getByRole('button', { name: 'Save changes' }).click();
  await page.waitForSelector('text=/Saved. Every template/');
  const row = (await assetsNamed('silhouette (traced).svg'))[0];
  const svg = await blobText('assets', row.id);
  ok(svg.includes('#00ff00'), 'the shape has the new colour');
  ok(!/stroke/.test(svg), 'no outline stroke keeps the old colour');
  ok(!/opacity="0"/.test(svg), 'no invisible layer is left');
  await d.getByText('Close', { exact: true }).click();
  await d.waitFor({ state: 'hidden' });
});

await check('Remove background shows a before and after preview, and the enclosed-areas option is there', async () => {
  await page.getByRole('button', { name: 'Asset silhouette.png' }).click();
  await page.getByRole('button', { name: 'Remove background' }).click();
  const d = page.getByRole('dialog');
  await d.getByRole('img', { name: 'Background removed (preview)' }).waitFor({ timeout: 20000 });
  ok(await d.getByLabel('Also remove background-coloured areas inside the outline').count() === 1 || await d.getByLabel('Also remove white areas inside the outline').count() === 1, 'the option is shown');
  await d.getByLabel('Background tolerance').fill('90');
  await waitIdle(page, 500);
  await d.getByRole('img', { name: 'Background removed (preview)' }).waitFor();
  await d.getByRole('button', { name: 'Cancel' }).click();
});

await check('the template editor has rulers; a guide is pulled from the top ruler and dragged back onto it to remove it', async () => {
  const tpl = (await dump(page, 'templates')).find((x) => x.name === 'Product Announcement');
  await page.goto(`${t.url}/#/editor/${tpl.id}`);
  await page.waitForSelector('.ed .canvas-container');
  const top = page.getByRole('img', { name: 'Horizontal ruler' });
  const left = page.getByRole('img', { name: 'Vertical ruler' });
  await top.waitFor();
  await left.waitFor();
  ok(await top.count() === 1 && await left.count() === 1, 'both rulers are shown');
  const r = await top.boundingBox();
  await page.mouse.move(r.x + 200, r.y + 10);
  await page.mouse.down();
  await page.mouse.move(r.x + 200, r.y + 90, { steps: 6 });
  await page.mouse.up();
  await waitIdle(page, 200);
  eq(await page.getByRole('separator', { name: 'Horizontal guide' }).count(), 1, 'a guide was pulled out');
  const g = await page.getByRole('separator', { name: 'Horizontal guide' }).boundingBox();
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
  await page.mouse.down();
  await page.mouse.move(r.x + 200, r.y + 6, { steps: 6 });
  await page.mouse.up();
  await waitIdle(page, 200);
  eq(await page.getByRole('separator', { name: 'Horizontal guide' }).count(), 0, 'dragged back onto the ruler, it is removed');
});

await check('no console errors during the whole session', async () => {
  const real = errors.filter((e) => !/Failed to load resource|Failed to fetch|net::ERR/.test(e));
  ok(real.length === 0, real.slice(0, 3).join(' | '));
});

const failed = report();
await t.close();
process.exit(failed ? 1 : 0);
