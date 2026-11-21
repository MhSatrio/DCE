/**
 * Ruler guides and the magnet, in the real app (headless Chromium): a guide pulled from a ruler pulls a moved element to
 * its edge, as in a drawing program; the magnet is off when snapping is off. Guides are a view aid and are not saved.
 */
import { check, dump, drag, editorDoc, eq, near, ok, report, toPage, waitIdle } from './helpers.mjs';
import { launch } from './lib.mjs';

const t = await launch({ viewport: { width: 1600, height: 950 } });
const { page, errors } = t;

const guides = () => page.evaluate(() => window.__dceEditor.store.get().rulerGuides);
const setGuide = (id, pos) => page.evaluate(([i, p]) => window.__dceEditor.moveRulerGuide(i, p), [id, pos]);
/** The bounding box of an element in the document’s pixels: the same measure the snapping uses. */
const boxOf = (id) => page.evaluate((nid) => {
  const o = window.__dceEditor.canvas.getObjects().find((x) => x.node?.id === nid);
  const pts = o.getCoords();
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  return { l: Math.min(...xs), r: Math.max(...xs), t: Math.min(...ys), b: Math.max(...ys) };
}, id);

/** Moves an element by (dx, dy) document pixels with the mouse, grabbing it at its centre. */
async function moveBy(id, dx, dy) {
  const b = await boxOf(id);
  const cx = (b.l + b.r) / 2, cy = (b.t + b.b) / 2;
  await drag(page, [cx, cy], [cx + dx, cy + dy], 10);
  await waitIdle(page, 150);
}

await page.goto(t.url + '/#/templates');
await page.getByRole('button', { name: /New template/ }).click();
await page.getByRole('dialog').getByLabel('Name').fill('Guide test');
await page.getByRole('button', { name: /Create and open/ }).click();
await page.waitForSelector('.ed .canvas-container');
await waitIdle(page, 500);

await check('a rectangle to move against the guides', async () => {
  await page.getByRole('button', { name: /^Rectangle/ }).click();
  await drag(page, [101, 103], [401, 303]);
  const doc = await editorDoc(page);
  eq([doc.nodes[0].x, doc.nodes[0].y, doc.nodes[0].width, doc.nodes[0].height], [100, 100, 300, 200], 'the rectangle');
});

await check('a horizontal guide is pulled from the top ruler, and an element moved onto it stops at its edge (not on the grid)', async () => {
  const r = await page.getByRole('img', { name: 'Horizontal ruler' }).boundingBox();
  const to = await toPage(page, 300, 400);
  await page.mouse.move(r.x + 300, r.y + 10);
  await page.mouse.down();
  await page.mouse.move(r.x + 300, to.y, { steps: 6 });
  await page.mouse.up();
  await waitIdle(page, 200);
  const g = (await guides()).find((x) => x.axis === 'y');
  ok(g, 'the guide exists in the editor');
  await setGuide(g.id, 413); // not a multiple of the 10 px grid, so only the guide can explain the stop
  const id = (await editorDoc(page)).nodes[0].id;
  await moveBy(id, 0, 317); // the top edge goes from 100 to about 417, four pixels below the guide
  const b = await boxOf(id);
  near(b.t, 413, 0.5, 'the top edge of the rectangle');
});

await check('a vertical guide from the left ruler pulls the left edge of an element to it', async () => {
  const r = await page.getByRole('img', { name: 'Vertical ruler' }).boundingBox();
  const to = await toPage(page, 700, 200);
  await page.mouse.move(r.x + 10, r.y + 200);
  await page.mouse.down();
  await page.mouse.move(to.x, r.y + 200, { steps: 6 });
  await page.mouse.up();
  await waitIdle(page, 200);
  const g = (await guides()).find((x) => x.axis === 'x');
  ok(g, 'the vertical guide exists');
  await setGuide(g.id, 713);
  const id = (await editorDoc(page)).nodes[0].id;
  const before = await boxOf(id);
  await moveBy(id, 616, 0); // the left edge goes from 100 to about 716
  const after = await boxOf(id);
  near(after.l, 713, 0.5, 'the left edge of the rectangle');
  ok(Math.abs(after.t - before.t) < 0.5, 'a sideways move leaves the height alone');
});

await check('with snapping off (the magnet button), the element is free and stops where the mouse puts it', async () => {
  await page.getByRole('button', { name: 'Snap to grid and guides' }).click();
  await waitIdle(page, 150);
  const id = (await editorDoc(page)).nodes[0].id;
  const before = await boxOf(id);
  await moveBy(id, 0, 503 - before.t); // to about 503: with snapping on it would stop at the grid line 500
  const b = await boxOf(id);
  near(b.t, 503, 1.5, 'the top edge stays where the mouse left it');
  await page.getByRole('button', { name: 'Snap to grid and guides' }).click();
  await waitIdle(page, 150);
});

await check('a guide dragged back onto its ruler is removed; the template file has no guides in it', async () => {
  const g = (await guides()).find((x) => x.axis === 'y');
  const seg = await page.getByRole('separator', { name: 'Horizontal guide' }).boundingBox();
  await page.mouse.move(seg.x + seg.width / 2, seg.y + seg.height / 2);
  await page.mouse.down();
  const r = await page.getByRole('img', { name: 'Horizontal ruler' }).boundingBox();
  await page.mouse.move(r.x + 200, r.y + 6, { steps: 6 });
  await page.mouse.up();
  await waitIdle(page, 200);
  eq((await guides()).some((x) => x.id === g.id), false, 'the guide is gone');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await waitIdle(page, 500);
  const saved = (await dump(page, 'templates')).find((x) => x.name === 'Guide test');
  ok(!JSON.stringify(saved.doc).includes('rulerGuides'), 'guides are not saved in the template');
});

await check('no console errors during the whole session', async () => {
  const real = errors.filter((e) => !/Failed to load resource/.test(e));
  ok(real.length === 0, real.slice(0, 3).join(' | '));
});

const failed = report();
await t.close();
process.exit(failed ? 1 : 0);
